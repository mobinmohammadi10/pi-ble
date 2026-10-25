/**
 * Bale inbound routing composition
 * Zones: bale inbound, orchestration, queue/menu/command composition
 * Wires authorized updates into menus, commands, media grouping, and prompt queueing, and owns exact assistant-output target/route authority capture
 */
import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { isDeepStrictEqual } from "node:util";
import * as Bus from "./bus.js";
import * as Commands from "./commands.js";
import * as Media from "./media.js";
import * as Menu from "./menu.js";
import * as OutboundHandlers from "./outbound.js";
import * as PromptTemplates from "./prompt-templates.js";
import * as Queue from "./queue.js";
import { escapeHtml } from "./rendering.js";
import * as Replies from "./replies.js";
import * as BaleApi from "./bale-api.js";
import * as TextGroups from "./text-groups.js";
import * as ThreadNaming from "./thread-naming.js";
import * as ThreadReconciler from "./thread-reconciler.js";
import * as Turns from "./turns.js";
import * as WorkspaceIdentity from "./workspace-identity.js";
function formatBalePromptPeer(peer) {
    if (!peer)
        return undefined;
    if (typeof peer.username === "string" && peer.username.length > 0) {
        return peer.username;
    }
    const displayName = [peer.first_name, peer.last_name]
        .filter((part) => typeof part === "string" && part.length > 0)
        .join(" ");
    if (displayName)
        return displayName;
    if (typeof peer.title === "string" && peer.title.length > 0) {
        return peer.title;
    }
    return typeof peer.id === "number" ? String(peer.id) : undefined;
}
function isBalePromptOwnerPeer(peer, ownerUserId) {
    return ownerUserId !== undefined && peer?.id === ownerUserId;
}
function isBalePromptBotPeer(peer) {
    return peer?.is_bot === true;
}
export function resolveBaleGuestPromptPeer(input) {
    if (input.chatType !== "private") {
        return formatBalePromptPeer(input.chat);
    }
    if (!isBalePromptOwnerPeer(input.from, input.ownerUserId) &&
        !isBalePromptBotPeer(input.from)) {
        return formatBalePromptPeer(input.from);
    }
    for (const candidate of [
        input.chat,
        input.guestBotCallerUser,
        input.guestBotCallerChat,
        input.replyFrom,
    ]) {
        if (isBalePromptOwnerPeer(candidate, input.ownerUserId) ||
            isBalePromptBotPeer(candidate)) {
            continue;
        }
        const peer = formatBalePromptPeer(candidate);
        if (peer)
            return peer;
    }
    return undefined;
}
/** Stable file scope of the remote Guest Mode peer: username, else numeric id; never the bot's own scope. */
export function resolveBaleGuestFileScope(input) {
    const candidates = input.chatType !== "private"
        ? [input.chat]
        : [
            input.from,
            input.chat,
            input.guestBotCallerUser,
            input.guestBotCallerChat,
            input.replyFrom,
        ];
    for (const candidate of candidates) {
        if (!candidate ||
            (input.chatType === "private" &&
                (isBalePromptOwnerPeer(candidate, input.ownerUserId) ||
                    isBalePromptBotPeer(candidate))))
            continue;
        if (typeof candidate.username === "string" && candidate.username.length > 0)
            return candidate.username;
        if (typeof candidate.id === "number" && Number.isSafeInteger(candidate.id))
            return String(Math.abs(candidate.id));
    }
    return "guest";
}
function appendBaleSourceAttachmentSection(text, from, files, outputs = []) {
    if (files.length === 0 && outputs.length === 0)
        return text;
    const dirs = [...new Set(files.map((file) => dirname(file.path)))];
    const sameDir = dirs.length === 1;
    const source = from ? `|from:${from}` : "";
    const header = sameDir
        ? `[attachments${source}] ${dirs[0]}`
        : `[attachments${source}]`;
    const items = sameDir
        ? files.map((file) => `/${basename(file.path)}`)
        : files.map((file) => file.path);
    const sections = text ? [text] : [];
    if (items.length > 0) {
        sections.push(`${header}\n${items.map((item) => `- ${item}`).join("\n")}`);
    }
    if (outputs.length > 0) {
        const outputHeader = `[outputs${source}]`;
        sections.push(`${outputHeader}\n${outputs.map((output) => `- ${output}`).join("\n")}`);
    }
    return sections.join("\n\n");
}
function getContextCwd(ctx) {
    if (!ctx || typeof ctx !== "object")
        return undefined;
    const cwd = ctx.cwd;
    return typeof cwd === "string" && cwd.length > 0 ? cwd : undefined;
}
function getLeaderTopicProfileKey(ctx, instanceId) {
    const cwd = getContextCwd(ctx);
    if (cwd)
        return `cwd:${cwd}`;
    return instanceId ? `leader:${instanceId}` : undefined;
}
function isCurrentLeaderTopicRecord(record, profileKey, instanceId) {
    if (instanceId && record.instanceId === instanceId)
        return true;
    return !!profileKey && record.profileKey === profileKey;
}
function hasActiveLeaderTopic(records, profileKey, instanceId) {
    return records.some((record) => {
        if (record.status !== "active")
            return false;
        return isCurrentLeaderTopicRecord(record, profileKey, instanceId);
    });
}
const BALE_UNBOUND_REROUTE_CALLBACK_PREFIX = "reroute:";
const BALE_UNBOUND_REROUTE_RESTORE_MENU_CALLBACK_PREFIX = "rerouterestore:";
const BALE_UNBOUND_REROUTE_MENU_CALLBACK_PREFIX = "reroutemenu:";
const BALE_UNBOUND_REROUTE_ROOT_CALLBACK_PREFIX = "rerouteroot:";
const BALE_UNBOUND_REROUTE_NEW_SLOT_CALLBACK_PREFIX = "reroutenew:";
const BALE_UNBOUND_REROUTE_CANCEL_CALLBACK_PREFIX = "reroutecancel:";
const BALE_PENDING_CANCELLATION_REVIEW_PREFIX = "reroutecancel:review:";
const BALE_RETIRED_HISTORICAL_REVIEW_PREFIX = "reroutecancel:history:";
const BALE_SLOT_CAPACITY_MESSAGE = "No Bale instance slot is available. Automatic reclamation is disabled for safety.";
function formatBaleUnboundRerouteCallbackData(rerouteId, threadId) {
    return `${BALE_UNBOUND_REROUTE_CALLBACK_PREFIX}${rerouteId}:${threadId}`;
}
function formatBaleUnboundRerouteRestoreMenuCallbackData(rerouteId) {
    return `${BALE_UNBOUND_REROUTE_RESTORE_MENU_CALLBACK_PREFIX}${rerouteId}`;
}
function formatBaleUnboundRerouteNewSlotCallbackData(rerouteId, threadId) {
    return `${BALE_UNBOUND_REROUTE_NEW_SLOT_CALLBACK_PREFIX}${rerouteId}:${threadId}`;
}
function parseBaleUnboundRerouteRestoreMenuCallbackData(data) {
    const match = data?.match(/^(rerouterestore|reroutemenu|rerouteroot):([a-z0-9]+)$/);
    const rerouteId = match?.[2];
    return rerouteId
        ? {
            rerouteId,
            restore: match?.[1] === "rerouterestore",
            root: match?.[1] === "rerouteroot",
        }
        : undefined;
}
function parseBaleUnboundRerouteCallbackData(data) {
    const match = data?.match(/^(reroute|reroutenew):([a-z0-9]+):(\d+)$/);
    const prefix = match?.[1];
    const rerouteId = match?.[2];
    const threadId = Number(match?.[3]);
    if (!prefix || !rerouteId || !Number.isSafeInteger(threadId))
        return undefined;
    return { rerouteId, threadId, useNewSlot: prefix === "reroutenew" };
}
function getBaleThreadRecordLabel(record, getDisplayTitle) {
    return (getDisplayTitle?.(record.target) ??
        getRestoredThreadName(record, record.slot ?? ""));
}
function getRestoredThreadName(record, slot) {
    return record.threadName &&
        ThreadNaming.isBaleTopicThreadNameValidForSlot(record.threadName, slot)
        ? record.threadName
        : (ThreadNaming.chooseBaleThreadName({ slot }) ?? "Pi");
}
function isBaleLiveThreadTarget(record, liveTargets) {
    if (!liveTargets)
        return record.status === "active";
    return liveTargets.some((target) => target.chatId === record.target.chatId &&
        target.threadId === record.target.threadId);
}
function getBaleRoutableThreadRecords(records, liveTargets) {
    return records.filter((record) => record.status === "active" &&
        isBaleLiveThreadTarget(record, liveTargets));
}
/**
 * Owner inputs that stayed in All while their chooser moved to a routing tab: a menu-picked command arrives
 * threadless, whereas a typed All input already opens its own tab and leaves with it.
 */
function getBaleAllTabSourceMessageIds(messages, chatId) {
    return messages.flatMap((message) => message.chat?.type === "private" &&
        message.chat.id === chatId &&
        message.message_thread_id === undefined &&
        message.from?.is_bot === false &&
        Number.isSafeInteger(message.message_id) &&
        message.message_id > 0
        ? [message.message_id]
        : []);
}
/** Failure retains the source for recovery; Threaded Mode never emits a fallback answer into All. */
const BALE_THREADED_ROUTING_UNAVAILABLE_ERROR = "All is input-only in Threaded Mode; a routing Thread could not be prepared.";
/** What a route chooser moves: `<code>/name</code>` for a command, otherwise "this message". */
function formatBaleRouteSubject(command) {
    return command ? `<code>/${escapeHtml(command)}</code>` : "this message";
}
/** Root chooser heading; the buttons themselves name each available action. */
function formatBaleTemporaryThreadChooserText(command) {
    return [
        `<b>🚦 Route ${formatBaleRouteSubject(command)}:</b>`,
        "",
        "<i>The choice expires in 60 minutes.</i>",
    ].join("\n");
}
/** The message field holding a Bale file (`file_id`, directly or in a size array), named by Bale itself. */
function findBaleMessageFileField(fields) {
    const hasFileId = (value) => !!value &&
        typeof value === "object" &&
        typeof value.file_id === "string";
    return Object.keys(fields).find((key) => {
        const value = fields[key];
        return Array.isArray(value) ? value.some(hasFileId) : hasFileId(value);
    });
}
/** One-line review label for any message: its text, or `📎` plus the caption, file name or file field. */
function formatBaleRoutingInputPreview(message) {
    const fields = message;
    const clean = (value) => typeof value === "string" ? value.replace(/\s+/gu, " ").trim() : "";
    let label = clean(fields.text);
    if (!label) {
        const field = findBaleMessageFileField(fields);
        const file = field ? fields[field] : undefined;
        const fileName = clean(!Array.isArray(file) && file
            ? file.file_name
            : undefined);
        const kind = field?.replace(/_/gu, " ") ?? "message";
        const caption = clean(fields.caption);
        label = caption ? `📎 ${kind}: ${caption}` : `📎 ${fileName || kind}`;
    }
    const chars = Array.from(label);
    return (escapeHtml(chars.slice(0, 80).join("")) + (chars.length > 80 ? "…" : ""));
}
function buildBaleUnboundRerouteChooserMarkup(rerouteId, records, options) {
    const activeRecords = records.filter((record) => record.status === "active");
    const canRestoreAnyLiveThread = options.canRestore && activeRecords.length > 0;
    const rows = activeRecords.length
        ? [
            [
                {
                    text: "🔀 Reroute: send it to a Pi thread",
                    callback_data: `${BALE_UNBOUND_REROUTE_MENU_CALLBACK_PREFIX}${rerouteId}`,
                },
            ],
        ]
        : [];
    if (canRestoreAnyLiveThread)
        rows.push([
            {
                text: "🔁 Restore: move a Pi into this tab",
                callback_data: formatBaleUnboundRerouteRestoreMenuCallbackData(rerouteId),
            },
        ]);
    if (options.canCancel)
        rows.push([
            {
                text: "⛔️ Cancel routing",
                callback_data: `${BALE_UNBOUND_REROUTE_CANCEL_CALLBACK_PREFIX}${rerouteId}`,
            },
        ]);
    return { inline_keyboard: rows };
}
function buildBaleUnboundRerouteRestoreChooserMarkup(rerouteId, records, getDisplayTitle) {
    return {
        inline_keyboard: records
            .filter((record) => record.status === "active")
            .map((record) => [
            {
                text: `🧵 ${getBaleThreadRecordLabel(record, getDisplayTitle)}`,
                callback_data: formatBaleUnboundRerouteNewSlotCallbackData(rerouteId, record.target.threadId),
            },
        ]),
    };
}
function formatBaleUnboundRerouteChooserText(command) {
    return `<b>🔀 Reroute ${formatBaleRouteSubject(command)} to:</b>`;
}
function formatBaleUnboundRerouteRestoreChooserText(command) {
    const subject = command ? ` for ${formatBaleRouteSubject(command)}` : "";
    return `<b>🔁 Restore a Pi into this tab${subject}:</b>`;
}
function formatBaleUnboundTopicGuidance() {
    return [
        "<b>⚠️ New thread is not a Pi instance.</b>",
        "",
        "To create a bound Bale tab:",
        "<code>1.</code> Start another Pi instance in your terminal.",
        "<code>2.</code> Run <code>/bale-connect</code> in that instance.",
        "<code>3.</code> The bridge will create and bind a fresh Bale tab for it.",
    ].join("\n");
}
function formatBaleTargetKey(target) {
    return `${target.chatId}:${target.threadId ?? "all"}`;
}
import * as Threads from "./threads.js";
import * as Updates from "./updates.js";
import { getBaleVoiceReplyMode } from "./voice.js";
/** Prepare the selected leader's exact retained originals; no copy, adoption, acceptance proof or dispatch. */
export function prepareBaleLiveLeaderOriginal(input) {
    const source = structuredClone(input.request.source), messages = [...input.messages];
    if (!input.isCurrent() ||
        input.request.owner.owner?.kind !== "leader" ||
        !isDeepStrictEqual(Updates.collectBaleAdmissionSourceUpdateIds(messages), [...source.updateIds].sort((a, b) => a - b)))
        return undefined;
    const originals = messages.map(Updates.inspectBaleDeferredSource);
    if (originals.some((original) => !original ||
        original.journalBindingKey !== source.journalBindingKey ||
        original.completionSha256))
        return undefined;
    return Updates.prepareBaleLiveDeferredInput(messages, input.isCurrent.bind(input));
}
/**
 * Pure canonical read: exactly one live binding row for the request, relocated to its target, and exactly one active
 * owner claiming that slot or target. Callers add their own recipient/owner-kind/local checks; this grants nothing.
 */
function findRelocatedBindingOwner(view, request) {
    const rows = (view.workspaceBindings ?? []).filter((value) => value.bindingKey === request.binding.bindingKey);
    const owners = view.threads.filter((value) => value.status === "active" &&
        (value.slot === request.binding.slot ||
            isDeepStrictEqual(value.target, request.target)));
    const row = rows[0], owner = owners[0];
    return rows.length === 1 &&
        owners.length === 1 &&
        !!row &&
        !!owner &&
        row.sessionId === request.binding.sessionId &&
        row.cwd === request.binding.cwd &&
        row.slot === request.binding.slot &&
        row.inactiveSinceMs === undefined &&
        isDeepStrictEqual(row.target, request.target) &&
        owner.slot === request.binding.slot &&
        owner.profileKey === request.owner.profileKey &&
        isDeepStrictEqual(owner.target, request.target)
        ? { row, owner }
        : undefined;
}
/** Confirmed absence is an exact HTTP 400 deleted/missing Thread; other method rejections are definite failures. */
function classifyLiveRebindCleanupFailure(error) {
    if (error instanceof Error &&
        "status" in error &&
        error.status === 400 &&
        ThreadReconciler.isBaleTopicDeletedErrorMessage(error.message))
        return "absent";
    return BaleApi.isBaleApiRequestRejected(error, "deleteForumTopic")
        ? "rejected"
        : "unknown";
}
/**
 * Default live-rebind cleanup pacing: quick early attempts, then minutely, within a 15-minute window. The first
 * delay is not cosmetic: a leader's detached command reply still needs the released, cleanup-free row.
 */
export const BALE_LIVE_REBIND_CLEANUP_SCHEDULE = Object.freeze({
    delaysMs: Object.freeze([1_000, 2_000, 5_000, 10_000, 30_000]),
    intervalMs: 60_000,
    windowMs: 15 * 60_000,
});
/** One warm live attempt with independent leader input/cleanup grants and exact peer donor settlement; no startup recovery or legacy Restore ACK. */
export function createBaleLiveRebindCoordinator(input) {
    const request = structuredClone(input.request), messages = [...input.messages];
    const executor = structuredClone(input.authority.executor), operatorUserId = input.authority.operatorUserId;
    const leader = input.leader && { ...input.leader }, follower = input.follower, followerRun = follower?.run;
    const beforeCleanup = input.cleanupBeforeRelease;
    const selectedCommand = follower?.selectedCommand && structuredClone(follower.selectedCommand), held = selectedCommand;
    const observedRecipient = input.getRecipient(), recipient = observedRecipient && structuredClone(observedRecipient);
    const sources = messages.map(Updates.inspectBaleDeferredSource);
    const originals = recipient?.kind === "follower"
        ? messages.map(Updates.inspectBaleDeferredSourceSnapshot)
        : undefined;
    const fences = messages.map(Updates.getBaleUpdateExecutionFence);
    const commandValid = follower?.selectedCommand === undefined ||
        (!!held &&
            recipient?.kind === "follower" &&
            isDeepStrictEqual(held.target, request.target) &&
            originals?.length === 1 &&
            Commands.isBaleSelectedHeldOriginal(originals[0]?.update, held.target, operatorUserId, held.name));
    const valid = commandValid &&
        Threads.isBaleWorkspaceRestoreRequest(request) &&
        !!recipient?.bindingKey &&
        Threads.isBaleWorkspaceRestoreRecipient(recipient && {
            kind: recipient.kind,
            instanceId: recipient.instanceId,
            sessionId: recipient.sessionId,
            generation: recipient.generation,
        }) &&
        recipient?.sessionId === request.binding.sessionId &&
        recipient?.instanceId === request.owner.instanceId &&
        recipient?.kind ===
            (request.owner.owner?.kind === "leader" ? "leader" : "follower") &&
        isDeepStrictEqual(Updates.collectBaleAdmissionSourceUpdateIds(messages), request.source.updateIds) &&
        sources.length === request.source.updateIds.length &&
        sources.every((source) => source &&
            !source.completionSha256 &&
            source.journalBindingKey === request.source.journalBindingKey) &&
        (!originals ||
            originals.every((original, index) => original &&
                isDeepStrictEqual(original.source, sources[index]) &&
                original.update.update_id === original.source.updateId)) &&
        fences.every((fence) => fence && fence.signal === fences[0]?.signal);
    const current = () => valid &&
        (!held ||
            (input.follower === follower &&
                follower?.run === followerRun &&
                isDeepStrictEqual(follower?.selectedCommand, selectedCommand))) &&
        input.authority.isCurrent() &&
        input.authority.operatorUserId === operatorUserId &&
        isDeepStrictEqual(input.authority.executor, executor) &&
        isDeepStrictEqual(input.getRecipient(), recipient) &&
        messages.every((message, index) => Updates.getBaleUpdateExecutionFence(message) === fences[index] &&
            fences[index]?.isCurrent() === true);
    const sourceSaved = () => current() &&
        messages.every((message, index) => isDeepStrictEqual(Updates.inspectBaleDeferredSource(message), sources[index]));
    const authority = { executor, operatorUserId, isCurrent: current };
    const retained = () => {
        if (!current())
            return undefined;
        const intent = input.restoreStore
            .listLiveRebindings()
            .find((value) => value.request.operationId === request.operationId);
        return current() &&
            intent &&
            isDeepStrictEqual(intent.request, request) &&
            intent.operatorUserId === operatorUserId &&
            isDeepStrictEqual(intent.executor, executor) &&
            isDeepStrictEqual(intent.recipient, {
                kind: recipient.kind,
                instanceId: recipient.instanceId,
                sessionId: recipient.sessionId,
                generation: recipient.generation,
            })
            ? intent
            : undefined;
    };
    const canonical = (expected) => {
        if (!current() || !isDeepStrictEqual(retained(), expected))
            return false;
        let confirmed = false;
        input.threadStore.withWorkspaceRestoreSnapshot(expected, (snapshot) => {
            const owner = findRelocatedBindingOwner(snapshot, request)?.owner;
            confirmed =
                current() &&
                    owner?.instanceId === recipient.instanceId &&
                    isDeepStrictEqual(owner.owner, request.owner.owner);
        });
        return confirmed && current();
    };
    let preparation;
    let saved = false, commitIssued = false, applyIssued = false, retitleIssued = false, peerReleaseIssued = false, donorSettlementAttempted = false, continuationIssued = false, cleanupBeforeReleaseIssued = false, cleanupBeforeReleaseDecided = false, released = false, advancing = false;
    let preparedSource;
    const runFollower = async (mode) => {
        if (!input.follower || !recipient || !current())
            return undefined;
        const run = held ? followerRun : input.follower.run;
        return run.call(input.follower, {
            operationId: request.operationId,
            instanceId: recipient.instanceId,
            sessionId: recipient.sessionId,
            recipientBindingKey: recipient.bindingKey,
            isCurrent: current,
            ...(held
                ? {
                    selectedCommand: structuredClone(selectedCommand),
                    ...(preparedSource
                        ? { preparedSource: { ...preparedSource } }
                        : {}),
                }
                : {}),
            ...(mode
                ? {
                    mode,
                    sourceUpdateIds: request.source.updateIds,
                    slot: request.binding.slot,
                    target: request.target,
                    oldTarget: request.binding.target,
                }
                : {
                    updates: originals.map((original) => structuredClone(original.update)),
                }),
        });
    };
    const matches = (observation) => !!observation &&
        current() &&
        observation.operationId === request.operationId &&
        isDeepStrictEqual(observation.sourceUpdateIds, request.source.updateIds) &&
        isDeepStrictEqual(observation.selectedCommand, selectedCommand) &&
        (held
            ? !preparedSource ||
                isDeepStrictEqual(observation.preparedSource, preparedSource)
            : observation.preparedSource === undefined) &&
        isDeepStrictEqual(observation.recipient, {
            instanceId: recipient.instanceId,
            sessionId: recipient.sessionId,
            generation: recipient.generation,
            bindingKey: recipient.bindingKey,
        });
    const acceptInput = (expected) => {
        if (!expected.inputRelease || expected.inputRelease === "accepted")
            return expected;
        let accepted;
        try {
            accepted = input.restoreStore.advanceLiveRebind(expected, "accept-input", authority);
        }
        catch {
            accepted = retained();
        }
        return accepted?.inputRelease === "accepted" && canonical(accepted) ? accepted : undefined;
    };
    const releaseFollower = async (intent) => {
        if (!held || !peerReleaseIssued) {
            peerReleaseIssued = true;
            const observation = await runFollower("release");
            if (!matches(observation) ||
                observation?.status !== "released" ||
                !("action" in observation) ||
                observation.action !== "release" ||
                !canonical(intent))
                return "unknown";
        }
        if (held) {
            const observation = await runFollower("observe-command");
            if (!matches(observation) ||
                observation?.status !== "command-observed" ||
                !("command" in observation) ||
                observation.command !== "completed" ||
                !preparedSource ||
                !isDeepStrictEqual(observation.sourceAck, preparedSource) ||
                !canonical(intent))
                return "unknown";
        }
        const accepted = acceptInput(intent);
        if (!accepted)
            return "unknown";
        intent = accepted;
        donorSettlementAttempted = true;
        if (preparation?.settleTransferred(() => canonical(intent)) !== "settled")
            return "unknown";
        released = true;
        return "released";
    };
    const observeCommandCompletion = () => {
        const intent = retained();
        if (!intent ||
            !Threads.isBaleLiveRebindInputAuthorized(intent) ||
            !canonical(intent) ||
            !leader?.isApplied(intent))
            return "unknown";
        const completions = messages.map(Updates.inspectBaleDeferredSourceCompletion);
        const completed = completions.every((completion, index) => completion && isDeepStrictEqual(completion, sources[index])) &&
            current() &&
            canonical(intent) &&
            leader.isApplied(intent) && current();
        return completed && acceptInput(intent) ? "released" : "unknown";
    };
    return {
        /** Correlation only; a later cleanup attempt rereads and revalidates the canonical row itself. */
        operationId: request.operationId,
        /** Body-free copy of the authenticated saved command reference: correlation only, never authority, an ACK or a cleanup permit. */
        selectedCommandReference() {
            return held && preparedSource
                ? {
                    operationId: request.operationId,
                    selectedCommand: structuredClone(selectedCommand),
                    preparedSource: { ...preparedSource },
                }
                : undefined;
        },
        /** Observe only an already-issued leader command; never prepares, relocates or executes input. */
        observeCommandCompletion() {
            if (!continuationIssued || !leader?.complete)
                return undefined;
            if (!current())
                return "unknown";
            try {
                return observeCommandCompletion();
            }
            catch (error) {
                input.recordRuntimeEvent?.("bale", error, { phase: "live-rebind-command-observation" });
                return "unknown";
            }
        },
        async advance() {
            if (advancing || !current())
                return "protected";
            if (released)
                return "released";
            if ((continuationIssued &&
                !leader?.complete &&
                !leader?.observeAdmission) ||
                donorSettlementAttempted)
                return "unknown";
            advancing = true;
            try {
                // Completion consumes source inspection; only the issued worker ACK can resolve it, without replay.
                if (continuationIssued) {
                    if (leader?.complete)
                        return observeCommandCompletion();
                    const intent = retained();
                    if (!intent ||
                        !Threads.isBaleLiveRebindInputAuthorized(intent) ||
                        !canonical(intent) ||
                        !leader?.isApplied(intent) ||
                        !leader.observeAdmission?.() ||
                        !current() ||
                        !canonical(intent) ||
                        !leader.isApplied(intent))
                        return "unknown";
                    if (!acceptInput(intent))
                        return "unknown";
                    released = true;
                    return "released";
                }
                if (!sourceSaved())
                    return "protected";
                if (!saved) {
                    if (recipient.kind === "leader") {
                        if (!leader || !!leader.continue === !!leader.complete)
                            return "protected";
                        preparation ??= prepareBaleLiveLeaderOriginal({
                            request,
                            messages,
                            isCurrent: current,
                        });
                        if (!preparation?.confirmSaved())
                            return "protected";
                    }
                    else {
                        if (!input.follower)
                            return "protected";
                        preparation ??= Updates.prepareBaleLiveDeferredInput(messages, current);
                        if (!preparation?.confirmSaved())
                            return "protected";
                        const observation = await runFollower();
                        if (!matches(observation) ||
                            observation?.status !== "saved" ||
                            !sourceSaved())
                            return "unknown";
                        if (held) {
                            const proof = observation.preparedSource;
                            if (!proof ||
                                Object.keys(proof).some((key) => !["journalBindingKey", "updateId", "sourceSha256"].includes(key)) ||
                                proof.journalBindingKey !== recipient.bindingKey ||
                                proof.updateId !== request.source.updateIds[0] ||
                                typeof proof.sourceSha256 !== "string" ||
                                !/^[a-f0-9]{64}$/.test(proof.sourceSha256))
                                return "unknown";
                            preparedSource = { ...proof };
                        }
                    }
                    saved = true;
                }
                if (!sourceSaved() || (preparation && !preparation.confirmSaved()))
                    return "protected";
                // A lost commit reply permits exact readback, never another relocation in this warm attempt.
                let intent = retained();
                if (!intent) {
                    if (commitIssued)
                        return "unknown";
                    commitIssued = true;
                    intent = await input.restoreStore.commitLiveRebind(request, {
                        kind: recipient.kind,
                        instanceId: recipient.instanceId,
                        sessionId: recipient.sessionId,
                        generation: recipient.generation,
                    }, authority, beforeCleanup ? { holdInput: true } : undefined);
                }
                else if (!commitIssued)
                    return "protected";
                if (!intent ||
                    !sourceSaved() ||
                    !canonical(intent) ||
                    (intent.phase === "finished" && !cleanupBeforeReleaseIssued) ||
                    (intent.cleanup && intent.inputRelease === undefined))
                    return "protected";
                // A released peer may already have completed its sources; only its retained settlement can reobserve that outcome.
                if (recipient.kind === "follower" && peerReleaseIssued)
                    return Threads.isBaleLiveRebindInputAuthorized(intent)
                        ? await releaseFollower(intent)
                        : "protected";
                const mode = applyIssued || intent.phase === "released" || intent.phase === "finished" ? "inspect" : "apply";
                applyIssued = true;
                if (recipient.kind === "leader") {
                    await leader.apply(structuredClone(intent), mode, current);
                    if (!current() || !canonical(intent) || !leader.isApplied(intent))
                        return "unknown";
                }
                else {
                    const observation = await runFollower(mode);
                    if (!matches(observation) ||
                        observation?.status !== "applied" ||
                        !("target" in observation) ||
                        !isDeepStrictEqual(observation.target, request.target) ||
                        observation.slot !== request.binding.slot ||
                        !canonical(intent))
                        return "unknown";
                }
                if (!sourceSaved() || (preparation && !preparation.confirmSaved()))
                    return "protected";
                if (input.retitle && !retitleIssued) {
                    retitleIssued = true;
                    try {
                        await input.retitle(current);
                    }
                    catch (error) {
                        input.recordRuntimeEvent?.("bale", error, {
                            phase: "live-rebind-title",
                        });
                    }
                    if (!current() || !canonical(intent))
                        return "unknown";
                }
                if (intent.phase === "rebound") {
                    const expected = intent;
                    input.restoreStore.advanceLiveRebind(expected, "release", recipient.kind === "leader"
                        ? {
                            ...authority,
                            isCurrent: () => current() && leader.isApplied(expected),
                        }
                        : authority);
                    intent = retained();
                }
                if (!intent ||
                    (intent.phase !== "released" && !(intent.phase === "finished" && intent.inputRelease === "held")) ||
                    (intent.cleanup && intent.inputRelease === undefined) ||
                    !canonical(intent))
                    return "protected";
                if (beforeCleanup) {
                    if (!cleanupBeforeReleaseIssued) {
                        cleanupBeforeReleaseIssued = true;
                        cleanupBeforeReleaseDecided = await beforeCleanup(intent, current);
                    }
                    intent = retained();
                    if (!cleanupBeforeReleaseDecided && intent?.phase !== "finished")
                        return "unknown";
                    if (!intent || !canonical(intent) ||
                        (recipient.kind === "leader" && !leader.isApplied(intent)) ||
                        intent.inputRelease !== "held" || intent.cleanup === "issued")
                        return "unknown";
                    let issued;
                    try {
                        issued = input.restoreStore.advanceLiveRebind(intent, "issue-input", authority);
                    }
                    catch {
                        issued = retained();
                    }
                    if (!issued || issued.inputRelease !== "issued" || !canonical(issued))
                        return "unknown";
                    intent = issued;
                }
                if (recipient.kind === "leader") {
                    const expected = intent;
                    if (!preparation?.beginRelease(() => canonical(expected) && leader.isApplied(expected)))
                        return "protected";
                    continuationIssued = true;
                    const canContinue = () => {
                        const observed = expected.inputRelease ? retained() : expected;
                        return current() && !!observed &&
                            (!expected.inputRelease || (observed.inputRelease === "issued" || observed.inputRelease === "accepted")) &&
                            canonical(observed) && leader.isApplied(observed);
                    };
                    if (leader.complete) {
                        leader.complete([...messages], canContinue);
                        // The detached native producer has taken this one input grant; its source ACK remains a separate observation.
                        if (!acceptInput(intent))
                            return "unknown";
                        return observeCommandCompletion();
                    }
                    if (!(await leader.continue(messages, canContinue)))
                        return "unknown";
                    if (!acceptInput(intent))
                        return "unknown";
                }
                else
                    return await releaseFollower(intent);
                if (!current())
                    return "unknown";
                released = true;
                return "released";
            }
            catch (error) {
                input.recordRuntimeEvent?.("bale", error, {
                    phase: "live-rebind-routing",
                });
                return "unknown";
            }
            finally {
                advancing = false;
            }
        },
    };
}
/** One admitted Restore attempt through recipient readiness, never source dispatch or cleanup. */
export async function advanceBaleWorkspaceRestore(input) {
    const isCurrent = input.authority.isCurrent.bind(input.authority);
    if (!isCurrent())
        return undefined;
    const request = structuredClone(input.request);
    if (!Threads.isBaleWorkspaceRestoreRequest(request))
        return undefined;
    const getRecipient = input.getRecipient;
    const runRecipient = input.runRecipient;
    const observedRecipient = getRecipient();
    if (!Threads.isBaleWorkspaceRestoreRecipient(observedRecipient) ||
        observedRecipient.sessionId !== request.binding.sessionId)
        return undefined;
    const recipient = structuredClone(observedRecipient);
    const executor = structuredClone(input.authority.executor);
    const operatorUserId = input.authority.operatorUserId;
    const current = () => isCurrent() &&
        input.authority.operatorUserId === operatorUserId &&
        isDeepStrictEqual(input.authority.executor, executor) &&
        isDeepStrictEqual(getRecipient(), recipient);
    const authority = { executor, operatorUserId, isCurrent: current };
    const { restoreStore } = input;
    const retained = () => {
        if (!current())
            return undefined;
        const found = restoreStore
            .list()
            .find((value) => value.request.operationId === request.operationId);
        return current() &&
            found &&
            isDeepStrictEqual(found.request, request) &&
            found.operatorUserId === operatorUserId &&
            isDeepStrictEqual(found.executor, executor)
            ? found
            : undefined;
    };
    let intent = retained();
    const predecessor = intent
        ? undefined
        : restoreStore
            .list()
            .find((value) => value.request.operationId === request.operationId);
    if (predecessor &&
        current() &&
        isDeepStrictEqual(predecessor.request, request) &&
        predecessor.operatorUserId === operatorUserId &&
        !isDeepStrictEqual(predecessor.executor, executor)) {
        // Adoption transfers executor authority only. Issued grants stay issued, so a successor can merely inspect them.
        try {
            intent = restoreStore.adopt(predecessor, authority);
        }
        catch (error) {
            intent = retained();
            if (!intent)
                throw error;
        }
        if (!current() || !intent)
            return undefined;
        intent = retained();
        if (!intent)
            return undefined;
    }
    if (input.inspectOnly && !intent)
        return undefined;
    if (!intent || intent.phase === "relocated") {
        if ((!input.inspectOnly &&
            recipient.instanceId !== request.owner.instanceId) ||
            recipient.kind !==
                (request.owner.owner?.kind === "leader" ? "leader" : "follower"))
            return undefined;
        intent = await restoreStore.commit(request, authority);
        if (!current() || !intent)
            return undefined;
    }
    let mode = "inspect";
    if (intent.phase === "relocated") {
        try {
            const issuance = restoreStore.issueRecipient(intent, recipient, authority);
            if (issuance) {
                intent = issuance.intent;
                mode = input.inspectOnly ? "inspect" : "apply";
            }
            else
                intent = retained();
        }
        catch (error) {
            intent = retained();
            if (intent?.phase !== "recipient-issued")
                throw error;
            // A retained issued phase is not a fresh grant, even when publication's reply was lost.
        }
    }
    if (!current() ||
        !intent ||
        !["recipient-issued", "ready"].includes(intent.phase) ||
        (mode === "apply" && !isDeepStrictEqual(intent.recipient, recipient)))
        return undefined;
    const expected = structuredClone(intent);
    if (!isDeepStrictEqual(retained(), expected))
        return undefined;
    const observation = await runRecipient({
        intent: structuredClone(expected),
        mode,
        isCurrent: current,
    });
    if (!current() ||
        !isDeepStrictEqual(retained(), expected) ||
        !observation ||
        observation.ready !== true ||
        observation.operationId !== request.operationId ||
        !isDeepStrictEqual(observation.recipient, recipient) ||
        !isDeepStrictEqual(observation.target, request.target) ||
        observation.slot !== request.binding.slot)
        return undefined;
    if (expected.phase === "ready" &&
        isDeepStrictEqual(expected.readyRecipient ?? expected.recipient, recipient))
        return retained();
    try {
        intent =
            mode === "inspect"
                ? restoreStore.confirmInspectedReady(expected, recipient, authority)
                : restoreStore.confirmReady(expected, recipient, authority);
    }
    catch (error) {
        intent = retained();
        if (intent?.phase !== "ready" ||
            !isDeepStrictEqual(intent.readyRecipient ?? intent.recipient, recipient))
            throw error;
    }
    const confirmed = retained();
    return current() &&
        confirmed?.phase === "ready" &&
        isDeepStrictEqual(confirmed.readyRecipient ?? confirmed.recipient, recipient)
        ? confirmed
        : undefined;
}
async function deleteReservedBaleTopicThroughReconciler(deps, target, messageId) {
    if (!deps.threadStore)
        return false;
    const nowMs = Date.now();
    const currentLeaderEpoch = deps.getCurrentLeaderEpoch?.();
    const plan = ThreadReconciler.planThreadReconciliation({
        nowMs,
        currentLeaderEpoch,
        previousState: deps.getThreadReconciliationMachineState?.(),
        records: deps.threadStore.list(),
        reservations: deps.threadStore.listReservations(),
        observations: deps.threadStore.listSyncObservations(),
        reservedMessages: [
            {
                target,
                observedAtMs: nowMs,
                messageId,
                ...(currentLeaderEpoch !== undefined
                    ? { leaderEpoch: currentLeaderEpoch }
                    : {}),
            },
        ],
    });
    deps.recordThreadReconciliationPlan?.(plan);
    await ThreadReconciler.applyThreadReconciliationPlan(plan, {
        isCleanupTargetProtected: Threads.createBaleCleanupTargetProtection(deps.threadStore),
        callApi: deps.callApi,
        markStaleByTarget: (staleTarget, syncStatus, lastSyncError) => deps.threadStore?.markStaleByTarget(staleTarget, syncStatus, lastSyncError) ?? false,
        persist: () => deps.threadStore?.persist() ?? Promise.resolve(),
        getCurrentLeaderEpoch: deps.getCurrentLeaderEpoch,
        recordRuntimeEvent: deps.recordRuntimeEvent,
    });
    return plan.actions.some((action) => action.kind === "close-delete-reserved-topic");
}
export const BALE_ALL_TAB_COMMAND_MAX_AGE_MS = 60 * 60_000;
/** The toast for expired or previous-process routing controls; the chooser notice is written separately. */
export const BALE_ROUTING_CHOICE_EXPIRED = "Routing choice expired";
/** Every temporary routing tab carries this name, whether the bot created it or adopted Bale's native tab. */
const BALE_TEMPORARY_THREAD_NAME = "🚦 Routing";
/** A mobile client's native tab creation precedes the All input it is named after by about a second. */
const BALE_IMPLICIT_ALL_INPUT_WINDOW_SEC = 10;
export function isBaleAllTabCommandExpired(message, nowMs = Date.now()) {
    return (message.message_thread_id === undefined &&
        typeof message.date === "number" &&
        Number.isFinite(message.date) &&
        message.date > 0 &&
        Number.isFinite(nowMs) &&
        nowMs - message.date * 1000 >= BALE_ALL_TAB_COMMAND_MAX_AGE_MS);
}
export function createBaleInboundBusProjectionRuntime(deps) {
    return {
        getTargetOwnership(target) {
            return Bus.getBaleFollowerTargetOwnership({
                target,
                followers: deps.listFollowers(),
                activeThreadRecords: deps.listThreadRecords(),
                currentInstanceId: deps.instanceId,
            });
        },
        getLiveThreadTargets() {
            return Bus.listBaleBusLiveThreadTargets({
                leaderTarget: deps.getLeaderTarget(),
                followers: deps.listFollowers(),
            });
        },
        getLocalThreadLabelForTarget(target) {
            const followerTarget = deps.getFollowerTarget();
            const leaderTarget = deps.getLeaderTarget();
            const isLocalFollowerTarget = deps.isFollowerRegistered() &&
                followerTarget?.chatId === target.chatId &&
                followerTarget.threadId === target.threadId;
            const isLocalLeaderTarget = leaderTarget?.chatId === target.chatId &&
                leaderTarget.threadId === target.threadId;
            if (!isLocalFollowerTarget && !isLocalLeaderTarget)
                return undefined;
            return deps.getCurrentIdentity(target).threadName;
        },
    };
}
const BALE_OWNED_CALLBACK_PREFIXES = [
    "allmenu:",
    BALE_UNBOUND_REROUTE_CALLBACK_PREFIX,
    BALE_UNBOUND_REROUTE_CANCEL_CALLBACK_PREFIX,
    "compact:",
    "menu:",
    "model:",
    "new:",
    "queue:",
    "section:",
    "settings:",
    "status:",
    "tgbtn:",
    "thinking:",
];
function isBaleOwnedCallbackData(data) {
    return BALE_OWNED_CALLBACK_PREFIXES.some((prefix) => data.startsWith(prefix));
}
export function createBaleInboundRouteRuntime(deps) {
    /** The command a chooser routes, read from its own source exactly as the root heading named it. */
    const getPendingRerouteCommandName = (pending) => pending.dispatchKind === "command"
        ? Commands.parseBaleCommand(Media.extractFirstBaleMessageText(pending.messages).trim())?.name
        : undefined;
    /** Untouched by selection or dispatch, so the owner may still cancel and Restore may retain it. */
    const isPendingRerouteUntouched = (pending) => pending.phase.kind === "waiting" && !pending.dispatching;
    /** A frozen destination pauses All-command expiry until routing finishes or releases it. */
    const isPendingRerouteDestinationHeld = (pending) => pending.phase.kind !== "waiting" && pending.phase.kind !== "released";
    const pendingUnboundReroutes = new Map();
    // Body-free, bounded warm deduplication: album members can expire through the same chooser.
    const expiredRoutingViews = new Set();
    const implicitThreadCreations = new Map();
    const guidedUnboundTopicKeys = new Set();
    let nextUnboundRerouteId = 0;
    let cancellationReview;
    const requestDispatchNextQueuedBaleTurn = (ctx) => {
        deps.dispatchNextQueuedBaleTurn(ctx);
        if (deps.requestDeferredDispatchNextQueuedBaleTurn &&
            deps.hasDeferredDispatchContext?.() !== false) {
            deps.requestDeferredDispatchNextQueuedBaleTurn(deps.dispatchNextQueuedBaleTurn);
        }
    };
    const resolveBaleThreadLabel = (message) => {
        const chatId = message.chat.id;
        const threadId = message.message_thread_id;
        if (!threadId)
            return undefined;
        const localLabel = deps.getDisplayTitle?.({ chatId, threadId }) ??
            deps.getLocalThreadLabelForTarget?.({ chatId, threadId });
        if (localLabel)
            return localLabel;
        if (!deps.threadStore)
            return undefined;
        const records = deps.threadStore.list();
        const currentInstanceId = deps.getCurrentInstanceId?.();
        for (const record of records) {
            if (record.target.chatId !== chatId ||
                record.target.threadId !== threadId) {
                continue;
            }
            if (currentInstanceId &&
                record.instanceId &&
                record.instanceId !== currentInstanceId) {
                continue;
            }
            return record.threadName &&
                ThreadNaming.isBaleTopicThreadNameValidForSlot(record.threadName, record.slot)
                ? record.threadName
                : getRestoredThreadName(record, record.slot ?? "");
        }
        return undefined;
    };
    const createAdmissionReceipts = (queueKind, sources) => {
        const sourceUpdateIds = Updates.collectBaleAdmissionSourceUpdateIds(sources);
        if (sourceUpdateIds.length === 0)
            return [];
        const receipt = Queue.createBaleQueueAdmissionReceipt({
            queueKind,
            scope: deps.getAdmissionScope?.() ?? "",
            sourceUpdateIds,
        });
        const journalBindingKey = deps.getAdmissionJournalBinding?.();
        return receipt
            ? [
                {
                    ...receipt,
                    ...(journalBindingKey ? { journalBindingKey } : {}),
                },
            ]
            : [];
    };
    const reportQueueAdmission = (sources, receipts) => {
        Updates.reportBaleQueueAdmission(sources, receipts);
    };
    const removePendingReroute = (id) => {
        pendingUnboundReroutes.get(id)?.stopExpiry?.();
        pendingUnboundReroutes.delete(id);
    };
    const expirePendingCommand = (id, pending) => {
        if (isPendingRerouteDestinationHeld(pending) ||
            pending.expiresAtMs === undefined ||
            Date.now() < pending.expiresAtMs)
            return false;
        if (pendingUnboundReroutes.get(id) !== pending)
            return true;
        for (const message of pending.messages)
            Updates.reportBaleUpdateCompleted(message);
        removePendingReroute(id);
        return true;
    };
    const armPendingCommandExpiry = (id, pending) => {
        if (pending.dispatchKind !== "command" ||
            pending.sourceTarget.threadId !== undefined)
            return;
        pending.stopExpiry?.();
        const execution = Updates.getBaleUpdateExecutionFence(pending.messages[0]);
        const onAbort = () => removePendingReroute(id);
        let timer;
        let stopped = false;
        pending.pauseExpiry = () => {
            if (timer !== undefined)
                clearTimeout(timer);
            timer = undefined;
        };
        pending.stopExpiry = () => {
            stopped = true;
            pending.pauseExpiry?.();
            execution?.signal.removeEventListener("abort", onAbort);
        };
        execution?.signal.addEventListener("abort", onAbort, { once: true });
        if (execution?.signal.aborted) {
            onAbort();
            return;
        }
        if (pending.expiresAtMs === undefined) {
            const date = pending.messages[0]?.date;
            if (typeof date !== "number" ||
                !Number.isFinite(date) ||
                date <= 0 ||
                date * 1000 > Date.now())
                return;
            pending.expiresAtMs = date * 1000 + BALE_ALL_TAB_COMMAND_MAX_AGE_MS;
        }
        const schedule = () => {
            if (stopped ||
                isPendingRerouteDestinationHeld(pending) ||
                pendingUnboundReroutes.get(id) !== pending)
                return;
            if (expirePendingCommand(id, pending))
                return;
            const delay = Math.min(BALE_ALL_TAB_COMMAND_MAX_AGE_MS, pending.expiresAtMs - Date.now());
            timer = setTimeout(schedule, Math.max(1, delay));
            timer.unref?.();
        };
        schedule();
    };
    const prunePendingCommandReroutes = () => {
        // Deferred prompts and selected routes with cleanup work must retain their control.
        // Age is not settlement; the chooser capacity limit still bounds retained entries.
        for (const [id, entry] of pendingUnboundReroutes) {
            if (entry.dispatchKind === "command" &&
                entry.sourceTarget.threadId === undefined) {
                expirePendingCommand(id, entry);
            }
        }
    };
    const storePendingUnboundReroute = (messages, dispatchKind = "prompt", presentationTarget) => {
        prunePendingCommandReroutes();
        if (pendingUnboundReroutes.size >= 100) {
            throw new Error("Bale route chooser capacity reached; source remains retryable.");
        }
        nextUnboundRerouteId += 1;
        const id = nextUnboundRerouteId.toString(36);
        pendingUnboundReroutes.set(id, {
            sourceTarget: presentationTarget
                ? { ...presentationTarget }
                : {
                    chatId: messages[0].chat.id,
                    ...(typeof messages[0].message_thread_id === "number"
                        ? { threadId: messages[0].message_thread_id }
                        : {}),
                },
            messages,
            dispatchKind,
            phase: { kind: "waiting" },
        });
        const pending = pendingUnboundReroutes.get(id);
        armPendingCommandExpiry(id, pending);
        return id;
    };
    const rememberRerouteChooser = (id, messageId) => {
        const pending = pendingUnboundReroutes.get(id);
        if (!pending)
            return;
        pending.chooserMessageId = messageId;
        if (Number.isSafeInteger(messageId) && messageId > 0) {
            const owner = deps.configStore.getAllowedUserId();
            if (owner !== undefined &&
                pending.messages.every((source) => source.from?.id === owner &&
                    !source.from.is_bot &&
                    source.chat.type === "private")) {
                try {
                    const lifetime = Updates.armBaleRoutingInputs(pending.messages, owner, {
                        chatId: pending.sourceTarget.chatId,
                        ...(pending.sourceTarget.threadId !== undefined
                            ? { threadId: pending.sourceTarget.threadId }
                            : {}),
                        messageId: messageId,
                    });
                    if (lifetime)
                        pending.routingOperatorUserId = lifetime.operatorUserId;
                }
                catch (error) {
                    deps.recordRuntimeEvent?.("routing", error, {
                        phase: "routing-input-clock",
                    });
                }
            }
        }
        if (messageId === undefined ||
            pending.dispatchKind !== "command" ||
            pending.sourceTarget.threadId !== undefined ||
            pending.phase.kind !== "waiting")
            return;
        const source = pending.messages[0];
        const text = source?.text?.trim();
        const execution = Updates.getBaleUpdateExecutionFence(source);
        const sourceIds = Updates.collectBaleAdmissionSourceUpdateIds(pending.messages);
        if (!text ||
            Commands.parseBaleCommand(text)?.name !== "start" ||
            source?.from?.id === undefined ||
            !execution?.isCurrent() ||
            sourceIds.length !== 1 ||
            expirePendingCommand(id, pending))
            return;
        for (const [oldId, old] of pendingUnboundReroutes) {
            if (oldId === id ||
                old.dispatchKind !== "command" ||
                !isPendingRerouteUntouched(old) ||
                old.sourceTarget.threadId !== undefined ||
                old.sourceTarget.chatId !== pending.sourceTarget.chatId)
                continue;
            const oldSource = old.messages[0];
            const oldIds = Updates.collectBaleAdmissionSourceUpdateIds(old.messages);
            if (oldSource?.from?.id !== source.from.id ||
                oldSource?.text?.trim() !== text ||
                oldIds.length !== 1 ||
                oldIds[0] >= sourceIds[0] ||
                Updates.getBaleUpdateExecutionFence(oldSource)?.signal !==
                    execution.signal)
                continue;
            if (Updates.reportBaleUpdateCompleted(oldSource))
                removePendingReroute(oldId);
        }
    };
    const matchesRerouteChooser = (pending, query) => {
        const message = query.message;
        return (!!message &&
            pending.chooserMessageId !== undefined &&
            message.message_id === pending.chooserMessageId &&
            message.chat.id === pending.sourceTarget.chatId &&
            (message.message_thread_id === undefined ||
                message.message_thread_id === pending.sourceTarget.threadId));
    };
    const pendingUnboundRerouteMediaGroups = new Map();
    const threadNameDialog = ThreadNaming.createBaleThreadNameDialogRuntime();
    const getThreadNameDialogScope = () => deps.getCurrentInstanceId?.() ?? "local";
    const menuCallbackHandler = Menu.createBaleMenuCallbackHandlerForContext({
        getStoredModelMenuState: deps.modelMenuRuntime.getState,
        getActiveModel: deps.currentModelRuntime.get,
        getThinkingLevel: deps.getThinkingLevel,
        setThinkingLevel: deps.setThinkingLevel,
        updateStatus: deps.updateStatus,
        updateModelMenuMessage: deps.menuActions.updateModelMenuMessage,
        updateThinkingMenuMessage: deps.menuActions.updateThinkingMenuMessage,
        updateStatusMessage: deps.menuActions.updateStatusMessage,
        updateSettingsMenuMessage: deps.updateSettingsMenuMessage,
        answerCallbackQuery: deps.answerCallbackQuery,
        isIdle: deps.isIdle,
        hasAbortHandler: deps.bridgeRuntime.abort.hasHandler,
        getActiveToolExecutions: deps.bridgeRuntime.lifecycle.getActiveToolExecutions,
        persistScopedModelPatterns: deps.persistScopedModelPatterns,
        setModel: deps.setModel,
        setCurrentModel: deps.currentModelRuntime.setCurrentModel,
        stagePendingModelSwitch: deps.modelSwitchController.stagePendingSwitch,
        restartInterruptedBaleTurn: deps.modelSwitchController.restartInterruptedTurn,
        sectionRegistry: deps.sectionRegistry,
        editInteractiveMessage: deps.editInteractiveMessage,
        sendInteractiveMessage: deps.sendInteractiveMessage,
        sendSectionRichMessage: deps.sendSectionRichMessage,
        deleteMessage: deps.deleteMessage,
        isVoiceReplyActive: deps.isVoiceReplyActive,
        enqueueSectionPrompt: async (prompt, ctx, target, source) => {
            const chatId = target?.chatId ?? deps.configStore.getAllowedUserId();
            if (typeof chatId !== "number")
                return;
            const order = deps.bridgeRuntime.queue.allocateItemOrder();
            const admissionReceipts = createAdmissionReceipts("prompt", source === undefined ? [] : [source]);
            const turn = {
                kind: "prompt",
                chatId,
                ...(target ? { target } : {}),
                replyToMessageId: 0,
                sourceMessageIds: [],
                queueOrder: order,
                queueLane: "default",
                laneOrder: order,
                queuedAttachments: [],
                content: [
                    {
                        type: "text",
                        text: `[bale] ${prompt}`,
                    },
                ],
                historyText: Turns.truncateBaleQueueSummary(prompt),
                statusSummary: Turns.truncateBaleQueueSummary(prompt),
                ...(admissionReceipts.length > 0 ? { admissionReceipts } : {}),
            };
            deps.queueMutationRuntime.append(turn, ctx);
            reportQueueAdmission(source === undefined ? [] : [source], admissionReceipts);
            deps.updateStatus(ctx);
            requestDispatchNextQueuedBaleTurn(ctx);
        },
    });
    const cloneBaleMessagesForThread = (messages, threadId, copies) => {
        return messages.map((message) => {
            const ids = Updates.collectBaleAdmissionSourceUpdateIds([message]);
            const copyId = copies && ids.length === 1 ? copies.get(ids[0]) : undefined;
            if (copies && (!Number.isSafeInteger(copyId) || copyId <= 0))
                throw new Error("Reroute destination copy identity is unavailable.");
            const routed = {
                ...message,
                message_id: copyId ?? 0,
                message_thread_id: threadId,
                reply_to_message: undefined,
            };
            return Updates.carryBaleUpdateExecutionFence(message, copies ? Turns.withBaleTurnReplyAnchor(routed) : routed);
        });
    };
    /** Whether a chooser is still pending in this Thread, ignoring the ones the caller itself owns. */
    const hasPendingRerouteForTarget = (target, own) => [...pendingUnboundReroutes.values()].some((pending) => pending.sourceTarget.chatId === target.chatId &&
        pending.sourceTarget.threadId === target.threadId &&
        !own?.(pending));
    const isOwnTemporaryChooser = (entry) => (pending) => pending.temporaryThread?.token === entry.token &&
        isDeepStrictEqual(pending.temporaryThread.source, entry.source);
    const hasOtherTemporaryThreadReroute = (target, own) => hasPendingRerouteForTarget(target, isOwnTemporaryChooser(own));
    const applyThreadCleanupPlan = async (plan, assertExecutionCurrent, restoreCleanup, temporaryCleanup) => {
        assertExecutionCurrent?.();
        if ((restoreCleanup && restoreCleanup.routing?.cleanup !== "issued") ||
            (temporaryCleanup && !temporaryCleanup.cleanupIssued))
            return false;
        let protectedTarget = false, temporaryDeleteConfirmed = false, temporaryTransportUncertain = false;
        deps.recordThreadReconciliationPlan?.(plan);
        const result = await ThreadReconciler.applyThreadReconciliationPlan(plan, {
            skipCloseBeforeDelete: (temporaryCleanup?.target?.chatId ?? 0) > 0,
            isCleanupTargetProtected(target) {
                assertExecutionCurrent?.();
                // A tab's first source is not authority over sibling choosers, including unsettled cleanup-only work.
                const siblingProtected = !!temporaryCleanup &&
                    hasOtherTemporaryThreadReroute(target, temporaryCleanup);
                const lostTemporaryGrant = !!temporaryCleanup &&
                    !deps
                        .getWorkspaceRestoreStore?.()
                        ?.listTemporaryThreads()
                        .some((entry) => isDeepStrictEqual(entry, temporaryCleanup));
                const protectedNow = temporaryTransportUncertain ||
                    lostTemporaryGrant ||
                    siblingProtected ||
                    isRerouteTargetProtected(target, restoreCleanup, temporaryCleanup);
                protectedTarget ||= protectedNow;
                return protectedNow;
            },
            callApi: temporaryCleanup && deps.callApi
                ? async (method, body) => {
                    try {
                        assertExecutionCurrent?.();
                        const result = await deps.callApi(method, body, {
                            maxAttempts: 1,
                            retrySafety: "non-idempotent",
                        });
                        assertExecutionCurrent?.();
                        if (result !== true)
                            throw new Error("Temporary Thread cleanup lacks a positive API acknowledgement.");
                        if (method === "deleteForumTopic")
                            temporaryDeleteConfirmed = true;
                        return result;
                    }
                    catch (error) {
                        const missingTarget = BaleApi.getBaleApiErrorRequestTarget(error);
                        if (method === "deleteForumTopic" && missingTarget && error instanceof Error &&
                            BaleApi.isBaleApiRequestRejected(error, method) &&
                            BaleApi.isBaleStaleTargetHttpError(error) &&
                            ThreadReconciler.isBaleTopicDeletedErrorMessage(error.message) &&
                            missingTarget?.chatId === temporaryCleanup.target?.chatId &&
                            missingTarget?.threadId === temporaryCleanup.target?.threadId &&
                            missingTarget?.chatId === body.chat_id && missingTarget?.threadId === body.message_thread_id) {
                            // Only the client's parsed exact-target HTTP 400 absence closes the one-shot grant.
                            // Closed/denied/foreign/forged responses remain uncertain and never license another request.
                            assertExecutionCurrent?.();
                            temporaryDeleteConfirmed = true;
                            return true;
                        }
                        temporaryTransportUncertain = true;
                        throw error;
                    }
                }
                : deps.callApi,
            markStaleByTarget: (staleTarget, syncStatus, lastSyncError) => deps.threadStore?.markStaleByTarget(staleTarget, syncStatus, lastSyncError) ?? false,
            persist: () => deps.threadStore?.persist() ?? Promise.resolve(),
            removePendingProvisionById: (id) => deps.threadStore?.removePendingProvision(id) ?? false,
            getCurrentLeaderEpoch: deps.getCurrentLeaderEpoch,
            recordRuntimeEvent: deps.recordRuntimeEvent,
        });
        assertExecutionCurrent?.();
        return (!protectedTarget &&
            (!temporaryCleanup || temporaryDeleteConfirmed) &&
            (result.incompleteActions?.length ?? 0) === 0);
    };
    const findCreatedTemporaryThread = (target) => {
        try {
            return deps
                .getWorkspaceRestoreStore?.()
                ?.listTemporaryThreads()
                .find((value) => value.phase === "created" &&
                isDeepStrictEqual(value.target, target));
        }
        catch {
            return undefined;
        }
    };
    /**
     * One fenced capture of leader epoch, operator, journal binding and context for a temporary-Thread effect. `isCurrent`
     * re-reads every captured fact (plus an optional extra fence) at each boundary, so a delayed effect keeps the identity it
     * was scheduled under; `adopt` re-keys an entry to this executor before a write.
     */
    const captureTemporaryThreadAuthority = (ctx, extra) => {
        const store = deps.getWorkspaceRestoreStore?.();
        const instanceId = deps.getCurrentInstanceId?.(), epoch = deps.getCurrentLeaderEpoch?.();
        const operatorUserId = deps.configStore.getAllowedUserId(), journalBindingKey = deps.getAdmissionJournalBinding?.();
        const generation = deps.getSessionGeneration?.(), scope = deps.getAdmissionScope?.();
        if (!store ||
            !instanceId ||
            epoch === undefined ||
            operatorUserId === undefined ||
            !journalBindingKey)
            return undefined;
        const isCurrent = () => deps.isContextActive?.(ctx) === true &&
            deps.getCurrentInstanceId?.() === instanceId &&
            deps.getSessionGeneration?.() === generation &&
            deps.getAdmissionScope?.() === scope &&
            deps.getCurrentLeaderEpoch?.() === epoch &&
            deps.configStore.getAllowedUserId() === operatorUserId &&
            deps.getAdmissionJournalBinding?.() === journalBindingKey &&
            (extra?.() ?? true);
        const authority = {
            executor: { instanceId, leaderEpoch: String(epoch) },
            operatorUserId,
            isCurrent,
        };
        return {
            store,
            operatorUserId,
            journalBindingKey,
            epoch,
            authority,
            isCurrent,
            adopt: (entry) => isDeepStrictEqual(entry.executor, authority.executor)
                ? entry
                : store.adoptTemporaryThread(entry, authority),
        };
    };
    const isTemporaryTabTarget = (target) => !!target && findCreatedTemporaryThread(target) !== undefined;
    /** Restore may choose one input only when every other known group is cancelled or a live unassigned chooser that can be retained. */
    const areTemporaryThreadSiblingsAccountedForRestore = (entry, from) => {
        const target = entry.target;
        if (!target)
            return false;
        const group = {
            journalBindingKey: entry.source.journalBindingKey,
            updateIds: Updates.collectBaleAdmissionSourceUpdateIds(from.messages),
        };
        const inputs = Threads.getBaleTemporaryThreadInputs(entry), resolved = [
            ...(entry.cancelledInputs ?? []),
            ...(entry.completedInputs ?? []),
        ];
        if (!inputs.some((input) => isDeepStrictEqual(input, group)) ||
            resolved.some((input) => isDeepStrictEqual(input, group)))
            return false;
        const others = [...pendingUnboundReroutes.values()].filter((pending) => pending !== from &&
            pending.sourceTarget.chatId === target.chatId &&
            pending.sourceTarget.threadId === target.threadId);
        const groupOf = (pending) => ({
            journalBindingKey: entry.source.journalBindingKey,
            updateIds: Updates.collectBaleAdmissionSourceUpdateIds(pending.messages),
        });
        if (!others.every((pending) => !!pending.abandonment &&
            !isPendingRerouteCancelled(pending) &&
            isPendingRerouteUntouched(pending) &&
            !pending.workspaceRestore &&
            !entry.forwardedInputs?.some((input) => isDeepStrictEqual(input, groupOf(pending))) &&
            inputs.some((input) => isDeepStrictEqual(input, groupOf(pending)))))
            return false;
        return inputs.every((input) => isDeepStrictEqual(input, group) ||
            resolved.some((other) => isDeepStrictEqual(other, input)) ||
            others.some((pending) => isDeepStrictEqual(groupOf(pending), input)));
    };
    const isRerouteTargetProtected = (target, ownRestore, ownTemporary, restoreFrom) => {
        const matches = (candidate) => candidate.chatId === target.chatId &&
            candidate.threadId === target.threadId;
        const activeTarget = deps.activeTurnRuntime.getTarget();
        if ((activeTarget && matches(activeTarget)) ||
            deps.baleQueueStore
                .getQueuedItems()
                .some((item) => item.target && matches(item.target)) ||
            (deps.getLiveThreadTargets?.() ?? []).some(matches) ||
            (deps.threadStore?.list() ?? []).some((record) => matches(record.target)) ||
            (deps.threadStore?.listReservations() ?? []).some((record) => matches(record.target)) ||
            (deps.threadStore?.listPendingProvisions() ?? []).some((record) => record.target && matches(record.target)))
            return true;
        const store = deps.getWorkspaceRestoreStore?.();
        if (deps.getWorkspaceRestoreStore && !store)
            return true;
        let temporary;
        try {
            temporary = store?.listTemporaryThreads() ?? [];
        }
        catch {
            return true;
        }
        // Only the source's own Forward/Cancel may remove its retained tab; adoption may have changed its executor.
        const ownTab = (entry) => !!ownTemporary &&
            entry.token === ownTemporary.token &&
            isDeepStrictEqual(entry.source, ownTemporary.source) &&
            isDeepStrictEqual(entry.target, ownTemporary.target);
        if (temporary.some((entry) => !!entry.target &&
            matches(entry.target) &&
            (!ownTab(entry) ||
                (Threads.getBaleTemporaryThreadInputs(entry).length > 1 &&
                    !Threads.isBaleTemporaryThreadFullyResolved(entry) &&
                    !(restoreFrom &&
                        areTemporaryThreadSiblingsAccountedForRestore(entry, restoreFrom))))))
            return true;
        // Whole-tab cleanup after cancellation also needs a fresh census of retained arrivals no membership has seen.
        if (!restoreFrom &&
            temporary.some((entry) => ownTab(entry) &&
                !!(entry.cancelledInputs?.length || entry.completedInputs?.length))) {
            try {
                const required = [
                    ...new Set([
                        deps.getAdmissionJournalBinding?.(),
                        ownTemporary.source.journalBindingKey,
                        ...Threads.getBaleTemporaryThreadInputs(ownTemporary).map((input) => input.journalBindingKey),
                    ].filter((key) => !!key)),
                ];
                if (deps.inspectTemporaryThreadSources?.({ chatId: target.chatId, threadId: target.threadId }, required, Threads.getBaleTemporaryThreadInputs(ownTemporary))?.length !== 0)
                    return true;
            }
            catch {
                return true;
            }
        }
        const retained = store?.list() ?? [];
        // Exempt only the exact operation's old target. Cleanup itself also requires its issued grant.
        if (ownRestore &&
            (!matches(ownRestore.request.binding.target) ||
                !retained.some((intent) => isDeepStrictEqual(intent, ownRestore))))
            return true;
        if (retained.some((intent) => (matches(intent.request.binding.target) ||
            matches(intent.request.target)) &&
            !(ownRestore &&
                isDeepStrictEqual(intent, ownRestore) &&
                matches(intent.request.binding.target))))
            return true;
        if (!ownRestore)
            return false;
        let acceptedWorkClear = false;
        try {
            deps.threadStore?.withWorkspaceRestoreSnapshot(ownRestore, (snapshot) => {
                const bindings = snapshot.workspaceBindings?.filter((binding) => binding.bindingKey === ownRestore.request.binding.bindingKey) ?? [];
                if (bindings.length !== 1 || !deps.captureWorkspaceExternalProtection)
                    return undefined;
                const binding = bindings[0];
                // Relocation does not erase predecessor references or prove where their work executes.
                const journalBindingKeys = [
                    ...new Set([
                        ...(ownRestore.request.binding.journalBindingKeys ?? []),
                        ...(binding.journalBindingKeys ?? []),
                    ]),
                ];
                const journalSources = [
                    ...new Map([
                        ...(ownRestore.request.binding.journalSources ?? []),
                        ...(binding.journalSources ?? []),
                    ].map((source) => [
                        JSON.stringify([source.sessionId, source.recipientBindingKey]),
                        source,
                    ])).values(),
                ];
                acceptedWorkClear =
                    deps.captureWorkspaceExternalProtection({
                        ...binding,
                        target: ownRestore.request.binding.target,
                        journalBindingKeys,
                        journalSources,
                    }, { requireBindingProvenance: true }).acceptedWork === "clear";
                return undefined;
            });
        }
        catch (error) {
            acceptedWorkClear = false;
            deps.recordRuntimeEvent?.("bale", error, {
                phase: "workspace-restore-protection",
            });
        }
        return !acceptedWorkClear;
    };
    /** Best-effort, once consumed: All keeps no copy of an input whose routing tab carried it; failure is only recorded. */
    const deleteAllTabMessages = async (chatId, messageIds, isCurrent) => {
        if (!deps.deleteMessage)
            return;
        for (const messageId of messageIds) {
            if (isCurrent?.() === false)
                return;
            try {
                await deps.deleteMessage(chatId, messageId);
            }
            catch (error) {
                deps.recordRuntimeEvent?.("routing", error, {
                    phase: "all-tab-source-delete",
                    chatId,
                    messageId,
                });
            }
        }
    };
    /** One-shot per chooser: the copies are taken before deletion, so a later consuming path finds none. */
    const deleteAllTabCopies = (pending, isCurrent) => deleteAllTabMessages(pending.sourceTarget.chatId, pending.allTabCopies?.splice(0) ?? [], isCurrent);
    /**
     * Restore keeps the tab as the Thread, so the input must stay visible there: the All original goes only when the tab
     * holds its forwarded copy. Without one it stays where the operator can still read it.
     */
    const releaseAllTabCopiesIntoSurvivingTab = (pending) => {
        if (pending.allTabCopiesForwarded &&
            isDeepStrictEqual(pending.allTabCopiesForwarded.target, pending.sourceTarget))
            return deleteAllTabCopies(pending);
        pending.allTabCopies?.splice(0);
        return Promise.resolve();
    };
    /**
     * The Bot API files a threadless All input in All even when a mobile client first draws it in its new tab. One silent
     * best-effort forward moves it into the routing tab it opened, and only a confirmed copy lets the original leave All;
     * any failure keeps the original where the operator can still read it.
     */
    const moveAllTabSourceIntoTab = async (pending, target, isCurrent) => {
        const messageIds = [...(pending.allTabCopies ?? [])].sort((a, b) => a - b);
        if (messageIds.length === 0 || !deps.callApi || !isCurrent())
            return;
        const copyTarget = { ...target };
        const route = {
            chat_id: copyTarget.chatId,
            message_thread_id: copyTarget.threadId,
            from_chat_id: pending.sourceTarget.chatId,
            disable_notification: true,
        };
        const options = {
            maxAttempts: 1,
            retrySafety: "non-idempotent",
            assertAuthority() {
                if (!isCurrent())
                    throw new Error("Temporary Thread source forwarding authority changed.");
            },
        };
        try {
            // An album moves as one album; forwardMessages skips what it cannot forward, so a short reply is not a move.
            const copies = messageIds.length === 1
                ? [
                    await deps.callApi("forwardMessage", { ...route, message_id: messageIds[0] }, options),
                ]
                : await deps.callApi("forwardMessages", { ...route, message_ids: messageIds }, options);
            if (!isCurrent())
                return;
            const copyIds = Array.isArray(copies)
                ? copies.map((copy) => copy?.message_id)
                : [];
            if (copyIds.length !== messageIds.length ||
                !copyIds.every((id) => typeof id === "number" && Number.isSafeInteger(id) && id > 0) ||
                new Set(copyIds).size !== copyIds.length)
                return;
            pending.allTabCopiesForwarded = {
                target: copyTarget,
                sourceMessageIds: messageIds,
                messageIds: copyIds,
            };
            await deleteAllTabCopies(pending, isCurrent);
            if (!isCurrent())
                return;
            return pending.allTabCopiesForwarded.messageIds[0];
        }
        catch (error) {
            if (isCurrent())
                deps.recordRuntimeEvent?.("routing", error, {
                    phase: "temporary-thread-source-forward",
                });
            return;
        }
    };
    /** Read original source addresses, not warm target rewrites; unknown copy provenance never grants a Reroute. */
    const resolvePendingRerouteForwardSource = (pending) => {
        try {
            const originals = pending.messages.map((message) => {
                const snapshot = Updates.inspectBaleDeferredSourceSnapshot(message);
                const ids = Updates.collectBaleAdmissionSourceUpdateIds([message]);
                const original = snapshot?.update.message;
                if (!snapshot ||
                    ids.length !== 1 ||
                    snapshot.source.updateId !== ids[0] ||
                    snapshot.update.update_id !== ids[0] ||
                    Object.keys(snapshot.update).some((key) => key !== "update_id" && key !== "message") ||
                    snapshot.source.journalBindingKey !== deps.getAdmissionJournalBinding?.() ||
                    !original ||
                    original.chat?.type !== "private" ||
                    original.chat.id !== pending.sourceTarget.chatId ||
                    original.from?.id !== deps.configStore.getAllowedUserId() ||
                    original.from?.is_bot !== false ||
                    !Number.isSafeInteger(original.message_id) ||
                    original.message_id <= 0)
                    return undefined;
                return { message: original, updateId: ids[0] };
            });
            if (originals.length === 0 || originals.some((source) => !source))
                return;
            originals.sort((a, b) => a.message.message_id - b.message.message_id);
            const sourceMessageIds = originals.map((source) => source.message.message_id);
            const sourceUpdateIds = originals.map((source) => source.updateId);
            if (new Set(sourceMessageIds).size !== sourceMessageIds.length ||
                new Set(sourceUpdateIds).size !== sourceUpdateIds.length)
                return;
            const copied = pending.allTabCopiesForwarded;
            if (copied) {
                if (!isDeepStrictEqual(copied.target, pending.sourceTarget) ||
                    !isDeepStrictEqual(copied.sourceMessageIds, sourceMessageIds) ||
                    copied.messageIds.length !== sourceMessageIds.length ||
                    !copied.messageIds.every((id) => Number.isSafeInteger(id) && id > 0) ||
                    new Set(copied.messageIds).size !== copied.messageIds.length)
                    return;
                return { chatId: copied.target.chatId, sourceUpdateIds, sourceMessageIds, messageIds: [...copied.messageIds] };
            }
            const nativeOriginals = originals.every((source) => typeof pending.sourceTarget.threadId === "number" &&
                source.message.message_thread_id === pending.sourceTarget.threadId);
            const retainedAllOriginals = pending.allTabSourceRetained === true &&
                originals.every((source) => source.message.message_thread_id === undefined) &&
                isDeepStrictEqual([...(pending.allTabCopies ?? [])].sort((a, b) => a - b), sourceMessageIds);
            if (nativeOriginals || retainedAllOriginals)
                return { chatId: pending.sourceTarget.chatId, sourceUpdateIds, sourceMessageIds, messageIds: [...sourceMessageIds] };
        }
        catch (error) {
            deps.recordRuntimeEvent?.("routing", error, { phase: "reroute-source-proof" });
        }
        return undefined;
    };
    const dismissRerouteChooserMessage = async (query, assertExecutionCurrent) => {
        const chatId = query.message?.chat?.id;
        const messageId = query.message?.message_id;
        if (typeof chatId !== "number" ||
            typeof messageId !== "number" ||
            !deps.deleteMessage) {
            return false;
        }
        try {
            assertExecutionCurrent?.();
            await deps.deleteMessage(chatId, messageId);
            assertExecutionCurrent?.();
            return true;
        }
        catch (error) {
            assertExecutionCurrent?.();
            deps.recordRuntimeEvent?.("bale", error, {
                phase: "reroute-chooser-delete",
                chatId,
                messageId,
                threadId: query.message?.message_thread_id,
            });
            return false;
        }
    };
    /** Choosers are one-shot: a final outcome deletes the menu; only a failed delete leaves an inert, button-free notice. */
    const retireRerouteChooserMessage = async (chatId, messageId, fallbackText, assertCurrent) => {
        if (deps.deleteMessage) {
            try {
                await deps.deleteMessage(chatId, messageId);
                return;
            }
            catch (error) {
                deps.recordRuntimeEvent?.("bale", error, {
                    phase: "reroute-chooser-delete",
                    chatId,
                    messageId,
                });
            }
            assertCurrent?.();
        }
        await deps.editInteractiveMessage?.(chatId, messageId, fallbackText, "html", {
            inline_keyboard: [],
        });
    };
    const closeReroutedUnboundTopic = async (target, messageId, assertExecutionCurrent, ownTemporary) => {
        if (!target || !deps.threadStore)
            return true;
        const nowMs = Date.now();
        const currentLeaderEpoch = deps.getCurrentLeaderEpoch?.();
        const plan = ThreadReconciler.planThreadReconciliation({
            nowMs,
            currentLeaderEpoch,
            previousState: deps.getThreadReconciliationMachineState?.(),
            records: deps.threadStore.list(),
            reservations: deps.threadStore.listReservations(),
            pendingProvisions: deps.threadStore.listPendingProvisions(),
            unboundMessages: [
                {
                    target,
                    observedAtMs: nowMs,
                    ...(typeof messageId === "number" ? { messageId } : {}),
                    ...(currentLeaderEpoch !== undefined
                        ? { leaderEpoch: currentLeaderEpoch }
                        : {}),
                },
            ],
        });
        // A temporary grant licenses this tab only, not unrelated cleanup emitted by the general planner.
        const scoped = ownTemporary
            ? {
                ...plan,
                actions: plan.actions.filter((action) => action.kind === "close-delete-unbound-topic" &&
                    isDeepStrictEqual(action.target, target)),
            }
            : plan;
        return applyThreadCleanupPlan(scoped, assertExecutionCurrent, undefined, ownTemporary);
    };
    const closePreviousLeaderThread = async (target, assertExecutionCurrent, restoreCleanup) => {
        if (!target || !deps.threadStore)
            return true;
        const currentLeaderEpoch = deps.getCurrentLeaderEpoch?.();
        return applyThreadCleanupPlan({
            actions: [
                {
                    kind: "close-delete-previous-leader-topic",
                    target,
                    reason: "previous-leader",
                    instanceId: deps.getCurrentInstanceId?.(),
                    ...(currentLeaderEpoch !== undefined
                        ? { leaderEpoch: currentLeaderEpoch }
                        : {}),
                },
            ],
        }, assertExecutionCurrent, restoreCleanup);
    };
    const closeReplacedFollowerThread = async (target, instanceId, assertExecutionCurrent, restoreCleanup) => {
        if (!target || !deps.threadStore)
            return true;
        const currentLeaderEpoch = deps.getCurrentLeaderEpoch?.();
        return applyThreadCleanupPlan({
            actions: [
                {
                    kind: "close-delete-replaced-follower-topic",
                    target,
                    reason: "replaced-follower",
                    instanceId,
                    ...(currentLeaderEpoch !== undefined
                        ? { leaderEpoch: currentLeaderEpoch }
                        : {}),
                },
            ],
        }, assertExecutionCurrent, restoreCleanup);
    };
    // Worker ACK observers outlive callback admission. Re-enter the existing Workspace gate;
    // never await this continuation while holding the dispatch invocation's gate.
    const restoreSettlementTasks = new Set();
    /**
     * After a Restore into a temporary tab reached positive terminal settlement, every still-unassigned sibling there is retained
     * privately and cancelled without Pi delivery. Missing proof, authority or abandonment leaves that sibling pending and the
     * tab's temporary entry protected; selected, queued, running or unknown work is never touched.
     */
    const disposeTemporaryThreadSiblingsAfterRestore = async (intent, ctx, restoreCurrent) => {
        const target = intent.request.target, cap = captureTemporaryThreadAuthority(ctx, restoreCurrent);
        const entry = findCreatedTemporaryThread(target);
        if (!cap || !entry || !entry.target || !cap.isCurrent())
            return;
        const operatorUserId = intent.operatorUserId, journalBindingKey = intent.request.source.journalBindingKey;
        if (cap.operatorUserId !== operatorUserId ||
            cap.journalBindingKey !== journalBindingKey ||
            entry.operatorUserId !== operatorUserId ||
            entry.source.journalBindingKey !== journalBindingKey)
            return;
        const group = {
            journalBindingKey,
            updateIds: [...intent.request.source.updateIds],
        };
        if (!Threads.getBaleTemporaryThreadInputs(entry).some((input) => isDeepStrictEqual(input, group)))
            return;
        for (const [id, pending] of [...pendingUnboundReroutes]) {
            const cancellation = pending.abandonment;
            if (pending.sourceTarget.chatId !== target.chatId ||
                pending.sourceTarget.threadId !== target.threadId ||
                pending.workspaceRestore?.operationId === intent.request.operationId ||
                !cancellation ||
                pending.messages.length === 0 ||
                isPendingRerouteCancelled(pending) ||
                cancellation.running)
                continue;
            const current = () => cap.isCurrent() &&
                pendingUnboundReroutes.get(id) === pending &&
                pending.abandonment === cancellation &&
                isPendingRerouteUntouched(pending) &&
                !pending.workspaceRestore &&
                pending.messages.every((source) => Updates.getBaleUpdateExecutionFence(source)?.signal.aborted ===
                    false) &&
                cancellation.ownerUserId === operatorUserId &&
                cancellation.journalBindingKey === journalBindingKey;
            if (!current())
                continue;
            cancellation.running = true;
            try {
                cancellation.attempted = true;
                if (!abandonPendingRerouteSources(pending, operatorUserId, current))
                    continue;
                if (!recordCancelledTemporaryThreadInput(pending, ctx, current))
                    continue;
                // A sibling cancelled by Restore stays visible in the restored tab, like a desktop input typed there.
                if (await retireCancellationChooser(id, pending, current))
                    await releaseAllTabCopiesIntoSurvivingTab(pending);
            }
            catch (error) {
                deps.recordRuntimeEvent?.("routing", error, {
                    phase: "temporary-thread-restore-sibling",
                    rerouteId: id,
                });
            }
            finally {
                cancellation.running = false;
            }
        }
        // The entry is released only after every sibling is gone and the Restore group's completion is the single uncancelled input.
        if (hasPendingRerouteForTarget(target, (pending) => pending.workspaceRestore?.operationId === intent.request.operationId) ||
            !cap.isCurrent())
            return;
        const fresh = findCreatedTemporaryThread(target), owned = fresh && cap.adopt(fresh);
        if (owned && cap.isCurrent())
            cap.store.retireTemporaryThread(owned, cap.authority, group);
    };
    const observeRestoreSettlement = (signal, ctx) => {
        if (!deps.hasWorkspaceRestoreAuthority?.() ||
            !deps.runWorkspaceOperation ||
            !deps.getWorkspaceRestoreStore ||
            !deps.getSessionGeneration ||
            deps.isContextActive?.(ctx) === false)
            return;
        const evidence = signal.kind === "source" ? structuredClone(signal.evidence) : undefined;
        const follower = signal.kind === "recipient"
            ? structuredClone(signal.follower)
            : undefined;
        const recipientCurrent = () => {
            if (signal.kind !== "recipient" || !follower)
                return true;
            const live = deps.workspaceRestoreRecipient?.followerRegistry.get(follower.instanceId);
            return (signal.isCurrent() &&
                !!live &&
                Bus.hasBaleBusCapability(live.protocol, Bus.BALE_BUS_CAPABILITY_WORKSPACE_RESTORE) &&
                isDeepStrictEqual({
                    ...live,
                    lastHeartbeatMs: undefined,
                    connectedAtMs: undefined,
                    threadName: undefined,
                }, {
                    ...follower,
                    lastHeartbeatMs: undefined,
                    connectedAtMs: undefined,
                    threadName: undefined,
                }));
        };
        const recipientMatches = (intent) => {
            if (!follower)
                return true;
            const ready = intent.readyRecipient ?? intent.recipient;
            return (ready?.kind === "follower" &&
                ready.instanceId === follower.instanceId &&
                ready.sessionId === follower.sessionId &&
                ready.generation === follower.registrationGeneration &&
                !!follower.cwd &&
                intent.request.binding.cwd ===
                    WorkspaceIdentity.normalizeBaleWorkspacePath(follower.cwd) &&
                intent.request.binding.slot === follower.slot &&
                isDeepStrictEqual(intent.request.target, follower.target));
        };
        // A same-session successor already registered on the relocated target may prove an issued grant by inspection only.
        const inspectableSuccessor = (intent) => !!follower?.registrationGeneration &&
            !!follower.cwd &&
            (intent.phase === "relocated" || intent.phase === "recipient-issued") &&
            intent.request.owner.owner?.kind === "manual-follower" &&
            follower.sessionId === intent.request.binding.sessionId &&
            intent.request.binding.cwd ===
                WorkspaceIdentity.normalizeBaleWorkspacePath(follower.cwd) &&
            intent.request.binding.slot === follower.slot &&
            isDeepStrictEqual(intent.request.target, follower.target);
        const instanceId = deps.getCurrentInstanceId?.(), epoch = deps.getCurrentLeaderEpoch?.();
        const operatorUserId = deps.configStore.getAllowedUserId();
        const generation = deps.getSessionGeneration(), scope = deps.getAdmissionScope?.();
        const sourceBinding = deps.getAdmissionJournalBinding?.();
        if (!instanceId ||
            epoch === undefined ||
            operatorUserId === undefined ||
            !scope ||
            !sourceBinding ||
            (evidence && evidence.journalBindingKey !== sourceBinding) ||
            !recipientCurrent())
            return;
        // This same-session leader already runs on the relocated target; it may only inspect an issued leader grant.
        const leaderSessionId = deps.workspaceRestoreRecipient?.getSessionId(ctx);
        const leaderCwd = deps.workspaceRestoreRecipient?.getCwd(ctx);
        const leaderAt = (request) => {
            const ports = deps.workspaceRestoreRecipient;
            const cwd = ports?.getCwd(ctx), local = ports?.getLeaderIdentity();
            return (!!cwd &&
                cwd === leaderCwd &&
                ports?.getSessionId(ctx) === leaderSessionId &&
                leaderSessionId === request.binding.sessionId &&
                WorkspaceIdentity.normalizeBaleWorkspacePath(cwd) ===
                    request.binding.cwd &&
                !!local &&
                local.slot === request.binding.slot &&
                isDeepStrictEqual(local.target, request.target));
        };
        const observeLeaderRestore = (intent, recipient, isCurrent) => {
            const threads = deps.threadStore;
            if (!threads || !isCurrent() || !leaderAt(intent.request))
                return undefined;
            const { request } = intent;
            let observation;
            threads.withWorkspaceRestoreSnapshot(intent, (snapshot) => {
                if (!isCurrent() || !leaderAt(request))
                    return;
                const owner = findRelocatedBindingOwner(snapshot, request)?.owner;
                if (owner?.owner?.kind !== "leader" ||
                    owner.instanceId !== recipient.instanceId ||
                    owner.owner.instanceId !== recipient.instanceId ||
                    !owner.owner.cwd ||
                    WorkspaceIdentity.normalizeBaleWorkspacePath(owner.owner.cwd) !==
                        request.binding.cwd)
                    return;
                observation = {
                    operationId: request.operationId,
                    recipient,
                    target: request.target,
                    slot: request.binding.slot,
                    ready: true,
                };
            });
            return isCurrent() && leaderAt(request) ? observation : undefined;
        };
        // Same-process lost replies stay with their chooser; this path only serves a restarted leader process.
        const inspectableLeader = (intent) => !!evidence &&
            intent.request.owner.owner?.kind === "leader" &&
            leaderAt(intent.request) &&
            (intent.phase === "relocated"
                ? intent.request.owner.instanceId !== instanceId
                : intent.phase === "recipient-issued" &&
                    intent.recipient?.kind === "leader" &&
                    intent.recipient.instanceId !== instanceId);
        const current = () => deps.hasWorkspaceRestoreAuthority?.() === true &&
            deps.isContextActive?.(ctx) !== false &&
            deps.getSessionGeneration?.() === generation &&
            deps.getAdmissionScope?.() === scope &&
            deps.getAdmissionJournalBinding?.() === sourceBinding &&
            deps.getCurrentInstanceId?.() === instanceId &&
            deps.getCurrentLeaderEpoch?.() === epoch &&
            deps.configStore.getAllowedUserId() === operatorUserId &&
            recipientCurrent();
        const recoveryRecipient = (intent) => {
            const ready = intent.readyRecipient ?? intent.recipient;
            if (!deps.inspectRestoreSourceCompletion ||
                !deps.workspaceRestoreRecipient ||
                intent.phase !== "ready" ||
                !intent.routing ||
                intent.routing.cleanup !== undefined ||
                intent.operatorUserId !== operatorUserId ||
                !intent.routing.acceptances?.some((value) => value.kind === "forwarded"))
                return undefined;
            const live = deps.workspaceRestoreRecipient.followerRegistry.get(follower?.instanceId ?? ready?.instanceId ?? "");
            return ready?.kind === "follower" &&
                live?.registrationGeneration &&
                live.cwd &&
                Bus.hasBaleBusCapability(live.protocol, Bus.BALE_BUS_CAPABILITY_WORKSPACE_RESTORE) &&
                Bus.hasBaleBusCapability(live.protocol, Bus.BALE_BUS_CAPABILITY_DURABLE_FOLLOWER_ADMISSION) &&
                live.sessionId === intent.request.binding.sessionId &&
                WorkspaceIdentity.normalizeBaleWorkspacePath(live.cwd) ===
                    intent.request.binding.cwd &&
                live.slot === intent.request.binding.slot &&
                isDeepStrictEqual(live.target, intent.request.target)
                ? live
                : undefined;
        };
        const recoveryLeader = (intent) => {
            const ready = intent.readyRecipient ?? intent.recipient;
            if (evidence?.kind !== "completed" ||
                !deps.inspectRestoreSourceCompletion ||
                !deps.threadStore ||
                intent.phase !== "ready" ||
                !intent.routing ||
                intent.routing.cleanup !== undefined ||
                intent.operatorUserId !== operatorUserId ||
                intent.request.owner.owner?.kind !== "leader" ||
                ready?.kind !== "leader" ||
                ready.sessionId !== intent.request.binding.sessionId ||
                !leaderAt(intent.request) ||
                !intent.routing.acceptances?.some((value) => value.kind === "completed" || value.kind === "queued"))
                return undefined;
            return {
                kind: "leader",
                instanceId,
                sessionId: intent.request.binding.sessionId,
                generation: String(generation),
            };
        };
        let selected;
        try {
            selected =
                deps
                    .getWorkspaceRestoreStore()
                    ?.list()
                    .filter((intent) => {
                    if (intent.request.source.journalBindingKey !== sourceBinding)
                        return false;
                    if (evidence &&
                        intent.request.source.updateIds.some((id) => evidence.updateIds.includes(id)))
                        return true;
                    if (((evidence?.kind === "completed" || follower) &&
                        recoveryRecipient(intent)) ||
                        recoveryLeader(intent))
                        return true;
                    if (follower &&
                        deps.workspaceRestoreRecipient &&
                        inspectableSuccessor(intent))
                        return true;
                    if (deps.threadStore && inspectableLeader(intent))
                        return true;
                    // Completion rechecks an unsent Restore whose originals may all have been abandoned before its retirement published.
                    if (evidence?.kind === "completed" &&
                        deps.inspectRestoreSourceAbandonment &&
                        intent.phase === "ready" &&
                        intent.routing === undefined)
                        return true;
                    // Hints only wake fully settled, unissued cleanup. They never settle another source.
                    return ((evidence?.kind === "completed" || !!follower) &&
                        intent.phase === "ready" &&
                        intent.routing?.cleanup === undefined &&
                        recipientMatches(intent) &&
                        intent.request.source.updateIds.every((id) => intent.routing?.settlements.some((value) => value.kind !== "queued" && value.updateIds.includes(id))));
                })
                    .map((intent) => intent.request.operationId) ?? [];
        }
        catch (error) {
            deps.recordRuntimeEvent?.("bale", error, {
                phase: "workspace-restore-settlement",
            });
            return;
        }
        if (!selected.length || !current())
            return;
        const task = Promise.resolve()
            .then(() => deps.runWorkspaceOperation({
            operationId: `restore-settlement-${randomBytes(16).toString("hex")}`,
            operationKind: "workspace.restore-settlement",
            scopes: [{ kind: "profile" }],
        }, async () => {
            if (!current())
                return;
            const store = deps.getWorkspaceRestoreStore();
            if (!store)
                return;
            const authority = {
                executor: { instanceId, leaderEpoch: String(epoch) },
                operatorUserId,
                isCurrent: current,
            };
            const assertCurrent = () => {
                if (!current())
                    throw new Error("Workspace Restore settlement authority ended.");
            };
            // Exact owner abandonment of every original is terminal for an unsent Restore; no cleanup or delivery follows.
            const abandoned = (value) => {
                if (evidence?.kind !== "completed" ||
                    !value.request.source.updateIds.length)
                    return false;
                return value.request.source.updateIds.every((updateId) => {
                    const proof = deps.inspectRestoreSourceAbandonment?.(updateId, sourceBinding);
                    assertCurrent();
                    return (proof?.journalBindingKey === sourceBinding &&
                        proof.updateId === updateId &&
                        proof.operatorAuthorityId ===
                            `bale-owner:${operatorUserId}`);
                });
            };
            for (const operationId of selected) {
                assertCurrent();
                let intent = store
                    .list()
                    .find((value) => value.request.operationId === operationId);
                let settlementCurrent = current;
                let settlementCanonicalCurrent;
                let retired = false;
                if (follower &&
                    intent &&
                    inspectableSuccessor(intent) &&
                    intent.operatorUserId === operatorUserId) {
                    const ports = deps.workspaceRestoreRecipient;
                    const successor = {
                        kind: "follower",
                        instanceId: follower.instanceId,
                        sessionId: follower.sessionId,
                        generation: follower.registrationGeneration,
                    };
                    const { request } = intent;
                    // Adoption plus inspect never consumes the original apply grant, delivers input or issues cleanup.
                    await advanceBaleWorkspaceRestore({
                        request,
                        authority,
                        restoreStore: store,
                        inspectOnly: true,
                        getRecipient: () => (current() ? successor : undefined),
                        async runRecipient(action) {
                            if (action.mode !== "inspect" || !action.isCurrent())
                                return undefined;
                            return ports.runFollower({
                                operationId: request.operationId,
                                instanceId: successor.instanceId,
                                sessionId: successor.sessionId,
                                slot: request.binding.slot,
                                target: request.target,
                                oldTarget: request.binding.target,
                                mode: "inspect",
                                isCurrent: action.isCurrent,
                            });
                        },
                    });
                    continue;
                }
                if (intent &&
                    inspectableLeader(intent) &&
                    intent.operatorUserId === operatorUserId) {
                    const threads = deps.threadStore;
                    const leader = {
                        kind: "leader",
                        instanceId,
                        sessionId: intent.request.binding.sessionId,
                        generation: String(generation),
                    };
                    const { request } = intent;
                    await threads.load();
                    assertCurrent();
                    await advanceBaleWorkspaceRestore({
                        request,
                        authority,
                        restoreStore: store,
                        inspectOnly: true,
                        getRecipient: () => current() && leaderAt(request) ? leader : undefined,
                        async runRecipient(action) {
                            if (action.mode !== "inspect")
                                return undefined;
                            return observeLeaderRestore(action.intent, leader, action.isCurrent);
                        },
                    });
                    continue;
                }
                if (intent?.phase === "ready" &&
                    intent.routing === undefined &&
                    intent.operatorUserId === operatorUserId &&
                    intent.request.source.journalBindingKey === sourceBinding &&
                    abandoned(intent)) {
                    const owned = isDeepStrictEqual(intent.executor, authority.executor)
                        ? intent
                        : store.adopt(intent, authority);
                    assertCurrent();
                    if (owned)
                        store.retireAbandoned(owned, owned.request.source.updateIds, authority);
                    continue;
                }
                const liveRecipient = intent && recoveryRecipient(intent), localRecipient = intent && recoveryLeader(intent);
                if (intent &&
                    (liveRecipient || localRecipient) &&
                    intent.request.source.journalBindingKey === sourceBinding) {
                    const expected = intent, ports = deps.workspaceRestoreRecipient;
                    const recoveryCurrent = () => current() &&
                        (localRecipient
                            ? leaderAt(expected.request) &&
                                isDeepStrictEqual(recoveryLeader(expected), localRecipient)
                            : isDeepStrictEqual({
                                ...recoveryRecipient(expected),
                                lastHeartbeatMs: undefined,
                                connectedAtMs: undefined,
                                threadName: undefined,
                            }, {
                                ...liveRecipient,
                                lastHeartbeatMs: undefined,
                                connectedAtMs: undefined,
                                threadName: undefined,
                            }));
                    // Storage authority callbacks check live fences only; canonical reads cannot re-enter their transaction lock.
                    const recoveryAuthority = {
                        ...authority,
                        isCurrent: recoveryCurrent,
                    };
                    settlementCurrent = recoveryCurrent;
                    if (localRecipient) {
                        settlementCanonicalCurrent = () => !!intent &&
                            !!observeLeaderRestore(intent, localRecipient, recoveryCurrent);
                        if (!settlementCanonicalCurrent())
                            continue; // A local target alone cannot authorize executor adoption.
                    }
                    const inspect = (acceptance, operation) => {
                        const completion = {
                            journalBindingKey: sourceBinding,
                            updateId: acceptance.updateId,
                            sourceSha256: acceptance.sourceSha256,
                            completionSha256: Threads.getBaleWorkspaceRestoreSourceCompletionSha256(operation, acceptance),
                        };
                        const observed = deps.inspectRestoreSourceCompletion({
                            ...completion,
                        });
                        if (!recoveryCurrent())
                            throw new Error("Workspace Restore completion observation authority ended.");
                        return isDeepStrictEqual(observed, completion);
                    };
                    // Inspect proof before adopting: missing/foreign ACKs cannot even re-key the retained operation.
                    const accepted = expected.routing.acceptances.filter((value) => (localRecipient
                        ? value.kind === "completed" || value.kind === "queued"
                        : value.kind === "forwarded") && inspect(value, expected));
                    if (accepted.length) {
                        const successor = localRecipient ?? {
                            kind: "follower",
                            instanceId: liveRecipient.instanceId,
                            sessionId: liveRecipient.sessionId,
                            generation: liveRecipient.registrationGeneration,
                        };
                        const { request } = expected;
                        const inspected = await advanceBaleWorkspaceRestore({
                            request,
                            authority: recoveryAuthority,
                            restoreStore: store,
                            inspectOnly: true,
                            getRecipient: () => recoveryCurrent() ? successor : undefined,
                            async runRecipient(action) {
                                if (action.mode !== "inspect" || !action.isCurrent())
                                    return undefined;
                                if (localRecipient)
                                    return observeLeaderRestore(action.intent, successor, action.isCurrent);
                                return ports.runFollower({
                                    operationId: request.operationId,
                                    instanceId: successor.instanceId,
                                    sessionId: successor.sessionId,
                                    slot: request.binding.slot,
                                    target: request.target,
                                    oldTarget: request.binding.target,
                                    mode: "inspect",
                                    isCurrent: action.isCurrent,
                                });
                            },
                        });
                        if (!inspected || !recoveryCurrent())
                            continue;
                        intent = inspected;
                        if (settlementCanonicalCurrent &&
                            !settlementCanonicalCurrent())
                            continue;
                        // The await cannot lend earlier readback; confirm each immutable proof again before publication.
                        const settledIds = new Set(intent
                            .routing.settlements.filter((value) => value.kind !== "queued")
                            .flatMap((value) => value.updateIds));
                        const recovered = new Map();
                        for (const acceptance of accepted.filter((value) => !settledIds.has(value.updateId) &&
                            inspect(value, intent))) {
                            const key = acceptance.kind === "queued"
                                ? JSON.stringify([
                                    acceptance.receiptId,
                                    acceptance.queueKind,
                                ])
                                : "completed";
                            const settlement = recovered.get(key) ?? {
                                journalBindingKey: sourceBinding,
                                updateIds: [],
                                ...(acceptance.kind === "queued"
                                    ? {
                                        kind: "queue-completed",
                                        receiptId: acceptance.receiptId,
                                        queueKind: acceptance.queueKind,
                                    }
                                    : { kind: "completed" }),
                            };
                            settlement.updateIds.push(acceptance.updateId);
                            recovered.set(key, settlement);
                        }
                        for (const settlement of recovered.values()) {
                            intent = store.recordSourceSettlement(intent, settlement, recoveryAuthority);
                            if (!intent)
                                break;
                        }
                        if (!intent)
                            continue;
                    }
                }
                // Source hints carry no registry fence; cleanup must keep the acknowledged recipient exact across awaits.
                const readyRecipientCurrent = () => {
                    const ready = intent?.readyRecipient ?? intent?.recipient;
                    if (intent?.phase !== "ready" || ready?.kind !== "follower")
                        return true;
                    const live = deps.workspaceRestoreRecipient?.followerRegistry.get(ready.instanceId);
                    return (!!live?.cwd &&
                        live.registrationGeneration === ready.generation &&
                        live.sessionId === ready.sessionId &&
                        WorkspaceIdentity.normalizeBaleWorkspacePath(live.cwd) ===
                            intent.request.binding.cwd &&
                        live.slot === intent.request.binding.slot &&
                        isDeepStrictEqual(live.target, intent.request.target) &&
                        Bus.hasBaleBusCapability(live.protocol, Bus.BALE_BUS_CAPABILITY_WORKSPACE_RESTORE) &&
                        Bus.hasBaleBusCapability(live.protocol, Bus.BALE_BUS_CAPABILITY_DURABLE_FOLLOWER_ADMISSION));
                };
                const settlementAuthority = {
                    ...authority,
                    isCurrent: function () {
                        return settlementCurrent() && readyRecipientCurrent();
                    },
                };
                const assertSettlementCurrent = () => {
                    if (!settlementAuthority.isCurrent() ||
                        (!retired &&
                            settlementCanonicalCurrent &&
                            !settlementCanonicalCurrent())) {
                        throw new Error("Workspace Restore settlement authority ended.");
                    }
                };
                assertSettlementCurrent();
                if (!intent ||
                    intent.phase !== "ready" ||
                    !intent.routing ||
                    !isDeepStrictEqual(intent.executor, authority.executor) ||
                    intent.operatorUserId !== operatorUserId ||
                    intent.request.source.journalBindingKey !== sourceBinding)
                    continue;
                const settled = new Set(intent.routing.settlements.flatMap((value) => value.updateIds));
                if (follower &&
                    (intent.routing.cleanup !== undefined ||
                        !recipientMatches(intent) ||
                        !intent.request.source.updateIds.every((id) => settled.has(id))))
                    continue;
                const updateIds = evidence?.updateIds.filter((id) => intent.request.source.updateIds.includes(id) &&
                    !settled.has(id)) ?? [];
                if (evidence && updateIds.length) {
                    intent = store.recordSourceSettlement(intent, { ...evidence, updateIds }, settlementAuthority);
                    if (!intent)
                        continue;
                }
                // The chooser follows the success proof, never old-thread cleanup, which may stay protected indefinitely.
                const retireRestoreChoosers = async () => {
                    for (const [id, pending] of pendingUnboundReroutes) {
                        if (pending.workspaceRestore?.operationId !== operationId)
                            continue;
                        pending.phase = { kind: "finalizing", message: "Restored" };
                        if (pending.chooserMessageId === undefined)
                            continue;
                        assertSettlementCurrent();
                        await retireRerouteChooserMessage(pending.sourceTarget.chatId, pending.chooserMessageId, "<b>✅ Message routed.</b>", assertSettlementCurrent);
                        assertSettlementCurrent();
                        if (pendingUnboundReroutes.get(id) === pending)
                            removePendingReroute(id);
                    }
                };
                if (intent.routing?.cleanup === undefined) {
                    if (!intent.request.source.updateIds.every((id) => intent.routing.settlements.some((value) => value.kind !== "queued" && value.updateIds.includes(id))))
                        continue;
                    // Positive settlement of every selected source is the success proof.
                    await disposeTemporaryThreadSiblingsAfterRestore(intent, ctx, settlementAuthority.isCurrent);
                    assertSettlementCurrent();
                    await retireRestoreChoosers();
                    if (isRerouteTargetProtected(intent.request.binding.target, intent))
                        continue;
                    const grant = store.issueCleanup(intent, settlementAuthority);
                    if (!grant)
                        continue;
                    intent = grant.intent;
                    const oldTarget = intent.request.binding.target;
                    const completed = intent.request.owner.owner?.kind === "leader"
                        ? await closePreviousLeaderThread(oldTarget, assertSettlementCurrent, intent)
                        : await closeReplacedFollowerThread(oldTarget, intent.request.owner.instanceId, assertSettlementCurrent, intent);
                    assertSettlementCurrent();
                    if (!completed)
                        continue; // Issued uncertainty stays protected, never downgraded or retried.
                    intent = store.recordCleanup(intent, { kind: "completed", target: oldTarget }, settlementAuthority);
                    if (!intent)
                        continue;
                }
                if (!store.retire(intent, settlementAuthority))
                    continue;
                retired = true;
                await retireRestoreChoosers();
            }
        }))
            .catch((error) => {
            deps.recordRuntimeEvent?.("bale", error, {
                phase: "workspace-restore-settlement",
            });
        });
        restoreSettlementTasks.add(task);
        void task.finally(() => restoreSettlementTasks.delete(task));
        return task;
    };
    const beforeQueueReceiptPublished = async (receipt, queueOwner, ctx, isWorkerCurrent) => {
        const heldScopes = commandHandler.prepareHeldQueueReceipt(receipt, queueOwner, ctx, isWorkerCurrent);
        if (heldScopes !== undefined)
            return heldScopes;
        const store = deps.getWorkspaceRestoreStore?.();
        if (!store)
            return;
        const selected = store
            .list()
            .filter((intent) => intent.request.source.journalBindingKey ===
            receipt.journalBindingKey &&
            intent.request.source.updateIds.some((id) => receipt.sourceUpdateIds.includes(id)))
            .map((intent) => intent.request.operationId);
        if (!selected.length)
            return;
        const instanceId = deps.getCurrentInstanceId?.(), epoch = deps.getCurrentLeaderEpoch?.();
        const generation = deps.getSessionGeneration?.(), scope = deps.getAdmissionScope?.(), operatorUserId = deps.configStore.getAllowedUserId();
        const binding = receipt.journalBindingKey, ports = deps.workspaceRestoreRecipient, threads = deps.threadStore;
        if (!instanceId ||
            epoch === undefined ||
            generation === undefined ||
            !scope ||
            !binding ||
            operatorUserId === undefined ||
            !ports ||
            !threads ||
            !deps.runWorkspaceOperation ||
            !deps.inspectRestoreQueuedReceipt) {
            throw new Error("Workspace Restore queued acceptance authority is unavailable.");
        }
        const expectedReceipt = {
            queueKind: receipt.queueKind,
            receiptId: receipt.receiptId,
            sourceUpdateIds: [...receipt.sourceUpdateIds],
            queueOwner: { ...queueOwner },
        };
        const current = () => isWorkerCurrent() &&
            deps.hasWorkspaceRestoreAuthority?.() === true &&
            deps.isContextActive?.(ctx) !== false &&
            deps.getSessionGeneration?.() === generation &&
            deps.getAdmissionScope?.() === scope &&
            deps.getAdmissionJournalBinding?.() === binding &&
            deps.getCurrentInstanceId?.() === instanceId &&
            deps.getCurrentLeaderEpoch?.() === epoch &&
            deps.configStore.getAllowedUserId() === operatorUserId &&
            queueOwner.instanceId === instanceId &&
            queueOwner.sessionGeneration === generation;
        const assertCurrent = () => {
            if (!current())
                throw new Error("Workspace Restore queued acceptance authority changed.");
        };
        assertCurrent();
        const recipientGuards = [];
        const sourceCompletions = [];
        await deps.runWorkspaceOperation({
            operationId: `restore-queue-acceptance-${randomBytes(16).toString("hex")}`,
            operationKind: "workspace.restore-queue-acceptance",
            scopes: [{ kind: "profile" }],
        }, async () => {
            assertCurrent();
            const active = deps.getWorkspaceRestoreStore?.();
            if (!active)
                throw new Error("Workspace Restore queued acceptance storage disappeared.");
            const proof = deps.inspectRestoreQueuedReceipt({
                ...structuredClone(expectedReceipt),
                journalBindingKey: binding,
            });
            assertCurrent();
            if (!proof ||
                !isDeepStrictEqual(proof.receipt, expectedReceipt) ||
                !/^[a-f0-9]{64}$/u.test(proof.queueOwnerSha256) ||
                proof.sources.length !== receipt.sourceUpdateIds.length ||
                proof.sources.some((source, index) => source.updateId !== receipt.sourceUpdateIds[index] ||
                    !/^[a-f0-9]{64}$/u.test(source.sourceSha256))) {
                throw new Error("Workspace Restore queued receipt proof is unavailable.");
            }
            for (const operationId of selected) {
                let intent = active
                    .list()
                    .find((value) => value.request.operationId === operationId);
                const recipient = intent?.readyRecipient ?? intent?.recipient;
                if (!intent ||
                    intent.phase !== "ready" ||
                    !intent.routing ||
                    intent.operatorUserId !== operatorUserId ||
                    !isDeepStrictEqual(intent.executor, {
                        instanceId,
                        leaderEpoch: String(epoch),
                    }) ||
                    intent.request.source.journalBindingKey !== binding ||
                    recipient?.kind !== "leader" ||
                    recipient.instanceId !== instanceId ||
                    recipient.generation !== String(generation) ||
                    recipient.sessionId !== intent.request.binding.sessionId) {
                    throw new Error("Workspace Restore queued recipient proof changed.");
                }
                const request = intent.request;
                const localRecipientMatches = () => {
                    const local = ports.getLeaderIdentity(), cwd = ports.getCwd(ctx);
                    return (!!local &&
                        local.slot === request.binding.slot &&
                        isDeepStrictEqual(local.target, request.target) &&
                        ports.getSessionId(ctx) === recipient.sessionId &&
                        !!cwd &&
                        WorkspaceIdentity.normalizeBaleWorkspacePath(cwd) ===
                            request.binding.cwd);
                };
                const liveRecipientCurrent = () => current() && localRecipientMatches();
                const recipientCurrent = () => {
                    if (!liveRecipientCurrent())
                        return false;
                    let committed = false;
                    threads.withWorkspaceRestoreSnapshot(intent, (snapshot) => {
                        const live = snapshot.workspaceBindings?.filter((value) => value.bindingKey === request.binding.bindingKey) ?? [];
                        const owners = snapshot.threads.filter((value) => value.status === "active" &&
                            (value.slot === request.binding.slot ||
                                isDeepStrictEqual(value.target, request.target)));
                        committed =
                            live.length === 1 &&
                                live[0]?.sessionId === recipient.sessionId &&
                                live[0].cwd === request.binding.cwd &&
                                live[0].slot === request.binding.slot &&
                                live[0].inactiveSinceMs === undefined &&
                                isDeepStrictEqual(live[0].target, request.target) &&
                                owners.length === 1 &&
                                owners[0]?.owner?.kind === "leader" &&
                                owners[0].instanceId === instanceId &&
                                owners[0].owner.instanceId === instanceId &&
                                !!owners[0].owner.cwd &&
                                WorkspaceIdentity.normalizeBaleWorkspacePath(owners[0].owner.cwd) === request.binding.cwd &&
                                owners[0].profileKey === request.owner.profileKey &&
                                owners[0].slot === request.binding.slot &&
                                isDeepStrictEqual(owners[0].target, request.target) &&
                                localRecipientMatches();
                    });
                    return committed && liveRecipientCurrent();
                };
                recipientGuards.push(recipientCurrent);
                // Storage owns the canonical CAS; its in-transaction authority callback cannot reacquire the snapshot lock.
                const authority = {
                    executor: { instanceId, leaderEpoch: String(epoch) },
                    operatorUserId,
                    isCurrent: liveRecipientCurrent,
                };
                for (const source of proof.sources.filter((value) => request.source.updateIds.includes(value.updateId))) {
                    if (!recipientCurrent())
                        throw new Error("Workspace Restore queued recipient authority changed.");
                    const evidence = {
                        ...source,
                        journalBindingKey: binding,
                        recipient,
                        kind: "queued",
                        receiptId: receipt.receiptId,
                        queueKind: receipt.queueKind,
                        queueOwnerSha256: proof.queueOwnerSha256,
                    };
                    let accepted, failure;
                    try {
                        accepted = active.recordSourceAcceptance(intent, evidence, authority);
                    }
                    catch (error) {
                        failure = error;
                    }
                    if (!accepted)
                        accepted = active
                            .list()
                            .find((value) => value.request.operationId === operationId &&
                            isDeepStrictEqual(value.request, request) &&
                            isDeepStrictEqual(value.executor, authority.executor) &&
                            value.operatorUserId === operatorUserId &&
                            value.routing?.acceptances?.some((retained) => isDeepStrictEqual(retained, evidence)));
                    if (!accepted ||
                        !isDeepStrictEqual(accepted.request, request) ||
                        !isDeepStrictEqual(accepted.executor, authority.executor) ||
                        accepted.operatorUserId !== operatorUserId ||
                        !accepted.routing?.acceptances?.some((value) => isDeepStrictEqual(value, evidence))) {
                        throw (failure ??
                            new Error("Workspace Restore queued acceptance was not published."));
                    }
                    intent = accepted;
                    sourceCompletions.push({
                        ...source,
                        journalBindingKey: binding,
                        completionSha256: Threads.getBaleWorkspaceRestoreSourceCompletionSha256(accepted, evidence),
                    });
                    if (!recipientCurrent())
                        throw new Error("Workspace Restore queued recipient authority changed.");
                }
            }
            const observed = deps.inspectRestoreQueuedReceipt({
                ...structuredClone(expectedReceipt),
                journalBindingKey: binding,
            });
            assertCurrent();
            if (!isDeepStrictEqual(observed, proof))
                throw new Error("Workspace Restore queued receipt changed after publication.");
        });
        assertCurrent();
        if (recipientGuards.some((guard) => !guard()))
            throw new Error("Workspace Restore queued recipient changed after admission.");
        return sourceCompletions.sort((a, b) => a.updateId - b.updateId);
    };
    const onQueueReceiptCompleted = (receipt, ctx) => {
        // A hint re-enters admission and rereads scoped proof; it never supplies completed command evidence for a queued source.
        if (!receipt.journalBindingKey)
            return;
        observeRestoreSettlement({
            kind: "source",
            evidence: {
                journalBindingKey: receipt.journalBindingKey,
                updateIds: [...receipt.sourceUpdateIds],
                kind: "completed",
            },
        }, ctx);
        for (const updateId of receipt.sourceUpdateIds)
            retireCompletedTemporaryThread(updateId, ctx, receipt.journalBindingKey);
    };
    const onQueueReceiptCommitted = (receipt, ctx) => {
        if (receipt.journalBindingKey)
            observeRestoreSettlement({
                kind: "source",
                evidence: {
                    journalBindingKey: receipt.journalBindingKey,
                    updateIds: [...receipt.sourceUpdateIds],
                    kind: "queued",
                    receiptId: receipt.receiptId,
                    queueKind: receipt.queueKind,
                },
            }, ctx);
    };
    // Worker-confirmed source completion is the only evidence for a Forwarded input. It records a durable group fact and
    // starts the same delayed, fully rechecked cleanup as the last Cancel; deletion itself never happens here.
    const completedTemporaryInputIds = new Map();
    const retireCompletedTemporaryThread = (updateId, ctx, journalBindingKey) => {
        const cap = captureTemporaryThreadAuthority(ctx);
        if (!cap ||
            !deps.runWorkspaceOperation ||
            cap.journalBindingKey !== journalBindingKey)
            return;
        const store = cap.store;
        const matches = (entry) => entry.source.journalBindingKey === journalBindingKey &&
            entry.source.updateId === updateId;
        const inGroup = (entry) => Threads.getBaleTemporaryThreadInputs(entry).some((input) => input.journalBindingKey === journalBindingKey &&
            input.updateIds.includes(updateId));
        let restoreOwned = false;
        try {
            if (!store
                .listTemporaryThreads()
                .some((entry) => matches(entry) || inGroup(entry)))
                return;
            restoreOwned = store
                .list()
                .some((intent) => intent.request.source.journalBindingKey === journalBindingKey &&
                intent.request.source.updateIds.includes(updateId));
        }
        catch (error) {
            deps.recordRuntimeEvent?.("routing", error, {
                phase: "temporary-thread-retire",
            });
            return;
        }
        const task = Promise.resolve()
            .then(() => deps.runWorkspaceOperation({
            operationId: `temporary-thread-retire-${randomBytes(16).toString("hex")}`,
            operationKind: "workspace.temporary-thread",
            scopes: [{ kind: "profile" }],
        }, async () => {
            if (!cap.isCurrent())
                return;
            let entry = store
                .listTemporaryThreads()
                .find(restoreOwned ? matches : inGroup);
            if (!entry)
                return;
            if (restoreOwned) {
                // A Restore keeps its own lifecycle: only its source entry may be released, never by Forward bookkeeping.
                if (entry.target &&
                    hasOtherTemporaryThreadReroute(entry.target, entry))
                    return;
                entry = cap.adopt(entry);
                if (entry && cap.isCurrent())
                    store.retireTemporaryThread(entry, cap.authority);
                return;
            }
            const group = Threads.getBaleTemporaryThreadInputs(entry).find((input) => input.journalBindingKey === journalBindingKey &&
                input.updateIds.includes(updateId));
            const target = entry.target;
            if (!group || entry.phase !== "created" || !target)
                return;
            if (entry.cancelledInputs?.some((input) => isDeepStrictEqual(input, group)) ||
                entry.completedInputs?.some((input) => isDeepStrictEqual(input, group)))
                return;
            // Process-local accumulation only: a restart forgets partial groups and the tab stays protected.
            const seen = completedTemporaryInputIds.get(entry.token) ?? new Set();
            seen.add(updateId);
            completedTemporaryInputIds.set(entry.token, seen);
            if (!group.updateIds.every((id) => seen.has(id)))
                return;
            entry = cap.adopt(entry);
            if (!entry ||
                !cap.isCurrent() ||
                !store.recordTemporaryThreadInputCompletion(entry, group, cap.authority) ||
                !cap.isCurrent())
                return;
            scheduleTemporaryThreadCleanup(target, ctx);
            return true;
        }))
            .then((published) => {
            // A sibling may complete after Restore already settled. Reinspect only after its terminal fact publishes and admission releases.
            if (published && cap.isCurrent())
                observeRestoreSettlement({
                    kind: "source",
                    evidence: {
                        journalBindingKey,
                        updateIds: [updateId],
                        kind: "completed",
                    },
                }, ctx);
        })
            .catch((error) => {
            deps.recordRuntimeEvent?.("routing", error, {
                phase: "temporary-thread-retire",
            });
        });
        restoreSettlementTasks.add(task);
        void task.finally(() => restoreSettlementTasks.delete(task));
    };
    const onUpdateCompleted = (updateId, ctx, journalBindingKey) => {
        if (!journalBindingKey)
            return;
        observeRestoreSettlement({
            kind: "source",
            evidence: {
                journalBindingKey,
                updateIds: [updateId],
                kind: "completed",
            },
        }, ctx);
        retireCompletedTemporaryThread(updateId, ctx, journalBindingKey);
    };
    const getLiveRebindMenu = (messages) => {
        const command = messages.length === 1
            ? Commands.parseBaleCommand(Media.extractFirstBaleMessageText([...messages]))
            : undefined;
        const action = command && Commands.buildBaleCommandAction(command.name);
        if (!command ||
            !action ||
            !["status", "model", "thinking", "queue", "settings"].includes(action.kind) ||
            (action.kind === "settings" && !deps.openSettingsMenu))
            return undefined;
        return command;
    };
    const getLiveRebindAbort = (messages) => {
        if (messages.length !== 1)
            return undefined;
        const command = Commands.parseBaleCommand(Media.extractFirstBaleMessageText([...messages]));
        return command?.name === "abort" ? command : undefined;
    };
    const getLiveRebindNext = (messages) => {
        if (messages.length !== 1)
            return undefined;
        const command = Commands.parseBaleCommand(Media.extractFirstBaleMessageText([...messages]));
        return command?.name === "next" ? command : undefined;
    };
    const getLiveRebindStop = (messages) => {
        if (messages.length !== 1 || !deps.cancelNextDispatchAnnouncement)
            return undefined;
        const command = Commands.parseBaleCommand(Media.extractFirstBaleMessageText([...messages]));
        return command?.name === "stop" ? command : undefined;
    };
    const getLiveRebindHelp = (messages) => {
        if (messages.length !== 1)
            return undefined;
        const command = Commands.parseBaleCommand(Media.extractFirstBaleMessageText([...messages]));
        return command?.name === "start" || command?.name === "help"
            ? command
            : undefined;
    };
    const getLiveRebindName = (messages) => {
        if (messages.length !== 1)
            return undefined;
        const command = Commands.parseBaleCommand(Media.extractFirstBaleMessageText([...messages]));
        if (command?.name !== "name" ||
            (command.args.trim()
                ? /^[A-Z]$/.test(command.args.trim())
                    ? !deps.resetCurrentThreadName
                    : !deps.renameCurrentThread
                : !deps.sendInteractiveMessage ||
                    !deps.captureThreadNameRecipientAuthority))
            return undefined;
        return command;
    };
    const getLiveRebindConfirmation = (messages) => {
        if (messages.length !== 1 ||
            !deps.sendInteractiveMessage ||
            !deps.captureThreadNameRecipientAuthority)
            return undefined;
        const command = Commands.parseBaleCommand(Media.extractFirstBaleMessageText([...messages]));
        return command?.name === "compact" || command?.name === "new"
            ? command
            : undefined;
    };
    const getLiveRebindContinue = (messages) => {
        if (messages.length !== 1)
            return undefined;
        const command = Commands.parseBaleCommand(Media.extractFirstBaleMessageText([...messages]));
        return command?.name === "continue" ? command : undefined;
    };
    const getLiveRebindTemplate = (messages) => {
        if (messages.length !== 1)
            return undefined;
        const command = Commands.parseBaleCommand(Media.extractFirstBaleMessageText([...messages]));
        if (!command ||
            reservedCommandNames().has(command.name) ||
            Commands.findBaleExtensionCommand(command.name))
            return undefined;
        try {
            const expanded = expandPromptTemplateCommand(command.name, command.args);
            return expanded === undefined
                ? undefined
                : {
                    command,
                    expandedSha256: createHash("sha256").update(expanded).digest("hex"),
                };
        }
        catch {
            return undefined;
        }
    };
    const getLiveRebindExtension = (messages) => {
        if (messages.length !== 1)
            return undefined;
        const command = Commands.parseBaleCommand(Media.extractFirstBaleMessageText([...messages]));
        return command &&
            Commands.findBaleExtensionCommand(command.name)?.selected
            ? command
            : undefined;
    };
    const prepareLiveSelection = async (selection, selectedTarget, ctx) => {
        const target = { ...selectedTarget };
        const ports = deps.workspaceRestoreRecipient, threads = deps.threadStore, store = deps.getWorkspaceRestoreStore?.();
        const instanceId = deps.getCurrentInstanceId?.(), epoch = deps.getCurrentLeaderEpoch?.();
        const operatorUserId = deps.configStore.getAllowedUserId(), journalBindingKey = deps.getAdmissionJournalBinding?.();
        const generation = deps.getSessionGeneration?.(), scope = deps.getAdmissionScope?.();
        const callerSessionId = ports?.getSessionId(ctx), callerCwd = ports?.getCwd(ctx);
        if (!ports ||
            !threads ||
            !store ||
            !instanceId ||
            epoch === undefined ||
            !callerSessionId ||
            !callerCwd ||
            operatorUserId === undefined ||
            !journalBindingKey ||
            generation === undefined ||
            !scope ||
            !selection.isCurrent?.())
            return undefined;
        const bindings = threads
            .listWorkspaceBindings()
            .filter((value) => isDeepStrictEqual(value.target, selection.record.target));
        const binding = bindings.length === 1 ? bindings[0] : undefined;
        if (!binding?.sessionId || !binding.slot)
            return undefined;
        const isLeader = selection.record.owner?.kind === "leader" &&
            selection.record.instanceId === instanceId;
        const selectedFollower = selection.record.owner?.kind === "manual-follower" &&
            selection.record.instanceId
            ? ports.followerRegistry.get(selection.record.instanceId)
            : undefined;
        const follower = selectedFollower && structuredClone(selectedFollower);
        const liveFollower = ports.liveFollower, followerRun = liveFollower?.run, followerJournal = liveFollower?.getJournalBindingKey;
        const commandName = !isLeader && selection.messages.length === 1
            ? Commands.parseBaleCommand(Media.extractFirstBaleMessageText([...selection.messages]))?.name
            : undefined;
        const selectedCommand = commandName
            ? { name: commandName, target: { ...target } }
            : undefined;
        const heldSelected = selectedCommand, commandAvailability = liveFollower?.isSelectedCommandAvailable;
        const recipientJournalKey = isLeader
            ? journalBindingKey
            : follower && liveFollower?.getJournalBindingKey(follower);
        if (isLeader
            ? !deps.setCurrentLeaderIdentity ||
                callerSessionId !== binding.sessionId ||
                WorkspaceIdentity.normalizeBaleWorkspacePath(callerCwd) !==
                    binding.cwd
            : !follower?.registrationGeneration ||
                !follower.profileKey ||
                follower.profileKey !== selection.record.profileKey ||
                follower.instanceId !== selection.record.instanceId ||
                follower.sessionId !== binding.sessionId ||
                !follower.cwd ||
                WorkspaceIdentity.normalizeBaleWorkspacePath(follower.cwd) !==
                    binding.cwd ||
                follower.slot !== binding.slot ||
                !follower.busSocketPath ||
                !recipientJournalKey ||
                recipientJournalKey === follower.profileKey ||
                !liveFollower)
            return undefined;
        const request = {
            operationId: `live-${randomBytes(16).toString("hex")}`,
            binding: structuredClone(binding),
            owner: structuredClone(selection.record),
            target: { ...target },
            source: {
                journalBindingKey,
                updateIds: Updates.collectBaleAdmissionSourceUpdateIds(selection.messages),
            },
        };
        // Detached command replies retain recipient lifetime, never the chooser lease or completed source.
        const recipientLifetime = () => deps.hasWorkspaceLiveRebindAuthority?.() === true &&
            deps.isContextActive?.(ctx) === true &&
            deps.getSessionGeneration?.() === generation &&
            deps.getCurrentInstanceId?.() === instanceId &&
            deps.getCurrentLeaderEpoch?.() === epoch &&
            deps.getAdmissionScope?.() === scope &&
            deps.getAdmissionJournalBinding?.() === journalBindingKey &&
            deps.configStore.getAllowedUserId() === operatorUserId &&
            deps.getWorkspaceRestoreStore?.() === store &&
            ports.getSessionId(ctx) === callerSessionId &&
            ports.getCwd(ctx) === callerCwd;
        let extensionRegistrationCurrent;
        const registrationCurrent = () => {
            try {
                extensionRegistrationCurrent?.();
                return true;
            }
            catch {
                return false;
            }
        };
        const current = () => selection.isCurrent?.() === true &&
            recipientLifetime() &&
            registrationCurrent() &&
            (!selection.extensionCommand ||
                isDeepStrictEqual(getLiveRebindExtension(selection.messages), selection.extensionCommand)) &&
            (!selection.menuCommand ||
                isDeepStrictEqual(getLiveRebindMenu(selection.messages), selection.menuCommand)) &&
            (!selection.abortCommand ||
                isDeepStrictEqual(getLiveRebindAbort(selection.messages), selection.abortCommand)) &&
            (!selection.nextCommand ||
                isDeepStrictEqual(getLiveRebindNext(selection.messages), selection.nextCommand)) &&
            (!selection.stopCommand ||
                isDeepStrictEqual(getLiveRebindStop(selection.messages), selection.stopCommand)) &&
            (!selection.helpCommand ||
                isDeepStrictEqual(getLiveRebindHelp(selection.messages), selection.helpCommand)) &&
            (!selection.nameCommand ||
                isDeepStrictEqual(getLiveRebindName(selection.messages), selection.nameCommand)) &&
            (!selection.confirmationCommand ||
                isDeepStrictEqual(getLiveRebindConfirmation(selection.messages), selection.confirmationCommand)) &&
            (!selection.template ||
                isDeepStrictEqual(getLiveRebindTemplate(selection.messages), selection.template)) &&
            (!selection.continueCommand ||
                isDeepStrictEqual(getLiveRebindContinue(selection.messages), selection.continueCommand));
        const recipient = {
            kind: isLeader ? "leader" : "follower",
            instanceId: isLeader ? instanceId : follower.instanceId,
            sessionId: binding.sessionId,
            generation: isLeader
                ? String(generation)
                : follower.registrationGeneration,
            bindingKey: recipientJournalKey,
        };
        const followerCurrent = () => {
            if (isLeader)
                return true;
            const live = ports.followerRegistry.get(follower.instanceId);
            if (heldSelected) {
                if (!commandAvailability ||
                    ports.liveFollower !== liveFollower ||
                    liveFollower?.run !== followerRun ||
                    liveFollower?.getJournalBindingKey !== followerJournal ||
                    liveFollower?.isSelectedCommandAvailable !== commandAvailability ||
                    !live)
                    return false;
                try {
                    if (commandAvailability.call(liveFollower, structuredClone(live), selectedCommand.name) !== true)
                        return false;
                }
                catch {
                    return false;
                }
                if (ports.liveFollower !== liveFollower ||
                    liveFollower?.run !== followerRun ||
                    liveFollower?.getJournalBindingKey !== followerJournal ||
                    liveFollower?.isSelectedCommandAvailable !== commandAvailability)
                    return false;
            }
            return (!!live &&
                Bus.isSameBaleBusFollowerRegistration(live, follower) &&
                [
                    ...Bus.BALE_BUS_LIVE_REBIND_CAPABILITIES,
                    ...(heldSelected ? Bus.getBaleBusHeldCommandCapabilities(heldSelected.name) : []),
                ].every((cap) => Bus.hasBaleBusCapability(live.protocol, cap)) &&
                !!live.target &&
                live.target.chatId === binding.target.chatId &&
                (live.target.threadId === binding.target.threadId ||
                    live.target.threadId === target.threadId) &&
                liveFollower.getJournalBindingKey(live) === recipientJournalKey);
        };
        const getRecipient = (snapshot) => {
            if (!recipientLifetime() || !followerCurrent())
                return undefined;
            const live = (snapshot?.workspaceBindings ?? threads.listWorkspaceBindings()).filter((value) => value.bindingKey === binding.bindingKey);
            const row = live[0];
            const owners = (snapshot?.threads ?? threads.list()).filter((value) => value.status === "active" &&
                (value.slot === binding.slot ||
                    (row && isDeepStrictEqual(value.target, row.target))));
            const owner = owners[0];
            return live.length === 1 &&
                row?.sessionId === binding.sessionId &&
                row.cwd === binding.cwd &&
                row.slot === binding.slot &&
                row.workspaceKey === binding.workspaceKey &&
                row.inactiveSinceMs === undefined &&
                (isDeepStrictEqual(row.target, binding.target) ||
                    isDeepStrictEqual(row.target, target)) &&
                owners.length === 1 &&
                owner?.instanceId === recipient.instanceId &&
                owner.slot === binding.slot &&
                owner.profileKey === request.owner.profileKey &&
                isDeepStrictEqual(owner.owner, request.owner.owner) &&
                isDeepStrictEqual(owner.target, row.target)
                ? recipient
                : undefined;
        };
        const isApplied = () => {
            const local = ports.getLeaderIdentity();
            return (current() &&
                !!local &&
                local.slot === binding.slot &&
                isDeepStrictEqual(local.target, target));
        };
        if (!current() || !getRecipient())
            return undefined;
        let commandCurrent;
        const useLiveRecipientSnapshot = !!selection.nameCommand ||
            !!selection.confirmationCommand ||
            !!selection.extensionCommand;
        const assertRecipientCurrent = () => {
            let confirmed = false;
            if (isLeader && recipientLifetime()) {
                const intent = store
                    .listLiveRebindings()
                    .find((value) => value.request.operationId === request.operationId);
                if (intent && Threads.isBaleLiveRebindInputAuthorized(intent) &&
                    isDeepStrictEqual(intent.request, request) &&
                    intent.operatorUserId === operatorUserId &&
                    isDeepStrictEqual(intent.executor, {
                        instanceId,
                        leaderEpoch: String(epoch),
                    }) &&
                    isDeepStrictEqual(intent.recipient, {
                        kind: recipient.kind,
                        instanceId: recipient.instanceId,
                        sessionId: recipient.sessionId,
                        generation: recipient.generation,
                    }))
                    (useLiveRecipientSnapshot
                        ? threads.withWorkspaceLiveRebindSnapshot
                        : threads.withWorkspaceRestoreSnapshot)(intent, (snapshot) => {
                        const local = ports.getLeaderIdentity();
                        confirmed =
                            recipientLifetime() &&
                                !!getRecipient(snapshot) &&
                                !!local &&
                                local.slot === binding.slot &&
                                isDeepStrictEqual(local.target, target) &&
                                snapshot.workspaceBindings?.some((value) => value.bindingKey === binding.bindingKey &&
                                    isDeepStrictEqual(value.target, target)) === true;
                    });
            }
            if (!confirmed || !recipientLifetime())
                throw new Error("Live-rebind detached menu recipient authority changed.");
        };
        const original = selection.messages[0], originalSnapshots = selection.messages.map(Updates.inspectBaleDeferredSourceSnapshot);
        if (originalSnapshots.some((snapshot) => !snapshot) ||
            (heldSelected &&
                (originalSnapshots.length !== 1 ||
                    !Commands.isBaleSelectedHeldOriginal(originalSnapshots[0]?.update, target, operatorUserId, heldSelected.name))))
            return undefined;
        let source = originalSnapshots[0]?.source;
        // Each selected owner gets a fresh fenced copy of the original, retargeted to the new Thread. These stay
        // closures because `source` is reassigned after a held selection is frozen.
        const retargetedOriginal = () => [
            Updates.carryBaleUpdateExecutionFence(original, {
                ...original,
                message_thread_id: target.threadId,
                ...(original.message_thread_id === target.threadId
                    ? {}
                    : { message_id: 0, reply_to_message: undefined }),
            }),
        ];
        const selectedPorts = (label) => ({
            assertSourceCurrent() {
                if (!commandCurrent?.())
                    throw new Error(`Live-rebind selected ${label} source authority changed.`);
            },
            assertRecipientCurrent,
            reportCompleted: () => Updates.reportBaleUpdateCompleted(original, source),
        });
        const menu = isLeader &&
            selection.menuCommand &&
            source &&
            commandHandler.prepareSelectedMenuCommand(selection.menuCommand, retargetedOriginal(), ctx, selectedPorts("menu"));
        const abort = isLeader &&
            selection.abortCommand &&
            source &&
            commandHandler.prepareSelectedCommand(selection.abortCommand, retargetedOriginal(), ctx, selectedPorts("abort"));
        const next = isLeader &&
            selection.nextCommand &&
            source &&
            commandHandler.prepareSelectedCommand(selection.nextCommand, retargetedOriginal(), ctx, selectedPorts("next"));
        const stop = isLeader &&
            selection.stopCommand &&
            source &&
            commandHandler.prepareSelectedCommand(selection.stopCommand, retargetedOriginal(), ctx, selectedPorts("stop"));
        const help = isLeader &&
            selection.helpCommand &&
            source &&
            (selection.helpCommand.name === "start"
                ? commandHandler.prepareSelectedStartCommand
                : commandHandler.prepareSelectedHelpCommand)(selection.helpCommand, retargetedOriginal(), ctx, selectedPorts("help/start"));
        const sourceFence = original && Updates.getBaleUpdateExecutionFence(original);
        let releaseSelectedSource;
        const finishSelectedSource = () => {
            const release = releaseSelectedSource;
            releaseSelectedSource = undefined;
            release?.();
        };
        const originalUnchanged = () => Updates.getBaleUpdateExecutionFence(original) === sourceFence &&
            sourceFence?.isCurrent() === true &&
            isDeepStrictEqual(Updates.inspectBaleDeferredSource(original), source);
        const reportSelectedCompleted = () => {
            try {
                return Updates.reportBaleUpdateCompleted(original, source);
            }
            finally {
                finishSelectedSource();
            }
        };
        const name = isLeader &&
            selection.nameCommand &&
            source &&
            (selection.nameCommand.args.trim()
                ? commandHandler.prepareSelectedNameCommand
                : commandHandler.prepareSelectedNameDialogCommand)(selection.nameCommand, retargetedOriginal(), ctx, {
                assertSourceCurrent() {
                    // Owner awaits may outlive chooser admission, but never the exact held original or its worker fence.
                    if (!releaseSelectedSource ||
                        !recipientLifetime() ||
                        !isDeepStrictEqual(getLiveRebindName(selection.messages), selection.nameCommand))
                        throw new Error("Live-rebind selected name source authority changed (lifetime or syntax).");
                    if (Updates.getBaleUpdateExecutionFence(original) !==
                        sourceFence ||
                        sourceFence?.isCurrent() !== true)
                        throw new Error("Live-rebind selected name source authority changed (execution).");
                    if (!isDeepStrictEqual(Updates.inspectBaleDeferredSource(original), source))
                        throw new Error("Live-rebind selected name source authority changed (original).");
                },
                assertRecipientCurrent,
                reportCompleted: reportSelectedCompleted,
            });
        const captureConfirmationRecipient = deps.captureThreadNameRecipientAuthority;
        let confirmationRecipient;
        const confirmation = isLeader &&
            selection.confirmationCommand &&
            source &&
            (selection.confirmationCommand.name === "new"
                ? commandHandler.prepareSelectedNewCommand
                : commandHandler.prepareSelectedCompactCommand)(selection.confirmationCommand, retargetedOriginal(), ctx, {
                assertSourceCurrent() {
                    if (!releaseSelectedSource ||
                        !recipientLifetime() ||
                        !isDeepStrictEqual(getLiveRebindConfirmation(selection.messages), selection.confirmationCommand) ||
                        !originalUnchanged())
                        throw new Error("Live-rebind selected confirmation source authority changed.");
                },
                assertRecipientCurrent() {
                    assertRecipientCurrent();
                    if (!confirmationRecipient)
                        throw new Error("Live-rebind confirmation recipient capture is unavailable.");
                    confirmationRecipient();
                    assertRecipientCurrent();
                },
                reportCompleted: reportSelectedCompleted,
            });
        let extensionIssued = false, extensionRecipient;
        let extension;
        let generated;
        if (selection.extensionCommand) {
            // Establish authenticated preparation and execution owners before any source freeze or binding effect.
            if (!isLeader || !source || !deps.captureThreadNameRecipientAuthority)
                return undefined;
            const preparationRecipient = deps.captureThreadNameRecipientAuthority({ ...binding.target }, ctx);
            if (!preparationRecipient)
                return undefined;
            const assertExtensionSource = () => {
                if (!(extensionIssued
                    ? !!releaseSelectedSource && recipientLifetime()
                    : current()) ||
                    !isDeepStrictEqual(getLiveRebindExtension(selection.messages), selection.extensionCommand) ||
                    !originalUnchanged())
                    throw new Error("Live-rebind selected extension source authority changed.");
            };
            const assertExtensionRecipient = () => {
                if (!extensionIssued) {
                    if (!current() || !getRecipient())
                        throw new Error("Live-rebind extension preparation recipient changed.");
                    preparationRecipient();
                    if (!current() || !getRecipient())
                        throw new Error("Live-rebind extension preparation recipient changed.");
                    return;
                }
                assertRecipientCurrent();
                if (!extensionRecipient)
                    throw new Error("Live-rebind extension recipient capture is unavailable.");
                extensionRecipient();
                assertRecipientCurrent();
            };
            const prepared = await Commands.prepareBaleSelectedExtensionCommand(selection.extensionCommand, {
                assertSourceCurrent: assertExtensionSource,
                assertRecipientCurrent: assertExtensionRecipient,
            });
            if (!prepared)
                return undefined;
            extensionRegistrationCurrent = prepared.assertRegistrationCurrent;
            selection.extensionKind = prepared.plan.kind;
            if (prepared.plan.kind === "command-only") {
                extension = commandHandler.prepareSelectedExtensionCommand(prepared, retargetedOriginal(), ctx, {
                    assertSourceCurrent: assertExtensionSource,
                    assertRecipientCurrent: assertExtensionRecipient,
                    reportCompleted: reportSelectedCompleted,
                });
            }
            else {
                const receiptOwner = Updates.prepareBaleDeferredQueueAdmission(original), preparedSource = { ...source };
                if (!receiptOwner?.isCurrent())
                    return undefined;
                const plan = prepared.plan;
                let admittedTurn;
                generated = {
                    async continue(messages, isCurrent) {
                        await continueLiveRebindInput(messages, ctx, target, isCurrent, {
                            prompt: plan.prompt,
                            assertRegistrationCurrent: prepared.assertRegistrationCurrent,
                            onQueued(turn) {
                                admittedTurn = structuredClone(turn);
                            },
                        });
                        return generated.observe();
                    },
                    observe() {
                        try {
                            if (!admittedTurn || !current() || !receiptOwner.isCurrent())
                                return false;
                            prepared.assertRegistrationCurrent();
                            assertRecipientCurrent();
                            const receipt = admittedTurn.admissionReceipts?.[0];
                            const matches = deps.baleQueueStore
                                .getQueuedItems()
                                .filter((item) => item.kind === "prompt" &&
                                item.admissionReceipts?.some((value) => isDeepStrictEqual(value, receipt)));
                            const turn = matches[0];
                            if (!receipt ||
                                matches.length !== 1 ||
                                !turn ||
                                turn.kind !== "prompt" ||
                                turn.chatId !== admittedTurn.chatId ||
                                turn.replyToMessageId !== admittedTurn.replyToMessageId ||
                                turn.historyText !== admittedTurn.historyText ||
                                !isDeepStrictEqual(turn.target, admittedTurn.target) ||
                                !isDeepStrictEqual(turn.content, admittedTurn.content) ||
                                !isDeepStrictEqual(turn.sourceMessageIds, admittedTurn.sourceMessageIds) ||
                                !isDeepStrictEqual(turn.admissionReceipts, admittedTurn.admissionReceipts))
                                return false;
                            const proof = receiptOwner.inspectReceipt(receipt);
                            if (!proof ||
                                !isDeepStrictEqual(proof.source, preparedSource) ||
                                proof.receipt.queueKind !== "prompt" ||
                                proof.receipt.receiptId !== receipt.receiptId ||
                                !isDeepStrictEqual(proof.receipt.sourceUpdateIds, request.source.updateIds) ||
                                proof.receipt.queueOwner.instanceId !== recipient.instanceId ||
                                proof.receipt.queueOwner.sessionGeneration !== generation)
                                return false;
                            assertRecipientCurrent();
                            return current() && receiptOwner.isCurrent();
                        }
                        catch {
                            return false;
                        }
                    },
                };
            }
            if ((!extension && !generated) || !current() || !getRecipient())
                return undefined;
        }
        if (!selectedCommand &&
            ((selection.menuCommand && !menu) ||
                (selection.abortCommand && !abort) ||
                (selection.nextCommand && !next) ||
                (selection.stopCommand && !stop) ||
                (selection.helpCommand && !help) ||
                (selection.nameCommand && !name) ||
                (selection.confirmationCommand && !confirmation)))
            return undefined;
        const completeCommand = menu ||
            abort ||
            next ||
            stop ||
            help ||
            name ||
            confirmation ||
            extension;
        const preDispatchCleanup = deps.runWorkspaceOperation !== undefined && deps.canUsePreDispatchRebind?.(recipient) === true;
        const createCoordinator = () => createBaleLiveRebindCoordinator({
            request,
            messages: selection.messages,
            restoreStore: store,
            threadStore: threads,
            // Same title as Workspace Restore: the display-mode title of the restored binding on its new tab.
            retitle: deps.callApi
                ? async (isCurrent) => {
                    if (!isCurrent())
                        return;
                    const expected = threads.getWorkspaceBindingByTarget(target, binding.sessionId);
                    if (!expected || expected.bindingKey !== binding.bindingKey || expected.slot !== binding.slot)
                        throw new Error("Live-rebind title binding is unavailable.");
                    const callApi = deps.callApi;
                    const slot = binding.slot ?? "";
                    const resolveTitle = () => deps.getDisplayTitle?.(expected.target) ??
                        ThreadNaming.getBaleTopicTitleForThreadName(getRestoredThreadName(request.owner, slot), slot);
                    const title = resolveTitle();
                    const bindingCurrent = (frame) => isCurrent() && deps.callApi === callApi &&
                        isDeepStrictEqual(threads.getWorkspaceBindingByTarget(frame.target, frame.sessionId), frame);
                    const assertTitle = () => {
                        if (!bindingCurrent(expected) || resolveTitle() !== title)
                            throw new Error("Live-rebind title authority changed.");
                    };
                    assertTitle();
                    const renamed = await callApi.call(deps, "editForumTopic", {
                        chat_id: expected.target.chatId,
                        message_thread_id: expected.target.threadId,
                        name: title,
                    }, { maxAttempts: 1, assertAuthority: assertTitle });
                    assertTitle();
                    if (renamed !== true || !threads.setWorkspaceDisplayTitle(expected, title))
                        throw new Error("Live-rebind title acknowledgement is unconfirmed.");
                    const acknowledged = { ...expected, displayTitle: title };
                    await threads.persist(() => bindingCurrent(acknowledged));
                    if (!bindingCurrent(acknowledged))
                        throw new Error("Live-rebind title publication authority changed.");
                }
                : undefined,
            authority: {
                executor: { instanceId, leaderEpoch: String(epoch) },
                operatorUserId,
                isCurrent: () => current() && (!preDispatchCleanup || deps.canUsePreDispatchRebind?.(recipient) === true),
            },
            getRecipient,
            ...(preDispatchCleanup ? {
                async cleanupBeforeRelease(intent, isCurrent) {
                    const delay = deps.liveRebindCleanupSchedule?.delaysMs[0] ?? 1_000;
                    await new Promise(resolve => { const timer = setTimeout(resolve, delay); timer.unref?.(); });
                    if (!isCurrent())
                        return false;
                    const result = await inspectLiveRebindRecipient(intent, ctx, isLeader ? "issue" : "follower-issue", isCurrent);
                    if (!isCurrent())
                        return false;
                    // A session-replacing producer cannot retain an old-session cleanup grant across its gateway.
                    if (result?.status === "not-ready" && selection.confirmationCommand?.name === "new")
                        return !!store.advanceLiveRebind(intent, "protect-old-target", { executor: intent.executor, operatorUserId, isCurrent });
                    return result?.status === "not-ready" || result?.status === "finished" && result.recorded;
                },
            } : {}),
            follower: isLeader
                ? undefined
                : {
                    ...(selectedCommand ? { selectedCommand } : {}),
                    async run(action) {
                        const observation = await (heldSelected ? followerRun : liveFollower.run).call(liveFollower, action);
                        if (observation?.status === "applied" &&
                            current() &&
                            getRecipient() &&
                            "target" in observation &&
                            observation.operationId === request.operationId &&
                            observation.slot === binding.slot &&
                            isDeepStrictEqual(observation.target, target) &&
                            isDeepStrictEqual(observation.sourceUpdateIds, request.source.updateIds) &&
                            isDeepStrictEqual(observation.recipient, {
                                instanceId: recipient.instanceId,
                                sessionId: recipient.sessionId,
                                generation: recipient.generation,
                                bindingKey: recipient.bindingKey,
                            })) {
                            const intent = store
                                .listLiveRebindings()
                                .find((value) => value.request.operationId === request.operationId);
                            if (intent &&
                                isDeepStrictEqual(intent.request, request) &&
                                intent.operatorUserId === operatorUserId &&
                                isDeepStrictEqual(intent.executor, {
                                    instanceId,
                                    leaderEpoch: String(epoch),
                                }) &&
                                (!intent.cleanup || intent.inputRelease !== undefined && intent.cleanup !== "issued") &&
                                (intent.phase === "rebound" || intent.phase === "released" ||
                                    intent.phase === "finished" && intent.inputRelease !== undefined) &&
                                isDeepStrictEqual(intent.recipient, {
                                    kind: recipient.kind,
                                    instanceId: recipient.instanceId,
                                    sessionId: recipient.sessionId,
                                    generation: recipient.generation,
                                }))
                                threads.withWorkspaceRestoreSnapshot(intent, (snapshot) => {
                                    if (!action.isCurrent() || !getRecipient(snapshot))
                                        return;
                                    const row = snapshot.workspaceBindings?.find((value) => value.bindingKey === binding.bindingKey);
                                    const live = ports.followerRegistry.get(recipient.instanceId);
                                    if (live && row && isDeepStrictEqual(row.target, target))
                                        ports.followerRegistry.register({
                                            ...live,
                                            target: { ...target },
                                            connectedAtMs: live.connectedAtMs,
                                        });
                                });
                        }
                        return observation;
                    },
                },
            leader: isLeader
                ? {
                    async apply(intent, mode, isCurrent) {
                        threads.withWorkspaceRestoreSnapshot(intent, (snapshot) => {
                            if (!isCurrent() || !getRecipient(snapshot))
                                return;
                            const row = snapshot.workspaceBindings?.find((value) => value.bindingKey === binding.bindingKey), local = ports.getLeaderIdentity();
                            if (!row ||
                                !isDeepStrictEqual(row.target, target) ||
                                !local ||
                                local.slot !== binding.slot ||
                                (!isDeepStrictEqual(local.target, binding.target) &&
                                    !isDeepStrictEqual(local.target, target)))
                                return;
                            if (mode === "apply" &&
                                !isDeepStrictEqual(local.target, target) &&
                                intent.phase === "rebound" &&
                                isCurrent())
                                deps.setCurrentLeaderIdentity({
                                    target: { ...target },
                                    slot: binding.slot,
                                    threadName: request.owner.threadName,
                                });
                        });
                    },
                    isApplied,
                    ...(completeCommand
                        ? {
                            complete(_messages, isCurrent) {
                                commandCurrent = isCurrent;
                                if (name || confirmation || extension) {
                                    if (!isCurrent())
                                        throw new Error("Live-rebind selected command issuance authority changed.");
                                    if (extension) {
                                        extensionRecipient =
                                            deps.captureThreadNameRecipientAuthority?.({ ...target }, ctx);
                                        if (!extensionRecipient)
                                            throw new Error("Live-rebind extension recipient capture is unavailable.");
                                        extensionRecipient();
                                        if (!isCurrent())
                                            throw new Error("Live-rebind selected extension issuance authority changed.");
                                        extensionIssued = true;
                                    }
                                    if (confirmation) {
                                        // Reuse only root recipient identity capture, never naming input/publication semantics.
                                        confirmationRecipient =
                                            captureConfirmationRecipient?.({ ...target }, ctx);
                                        if (!confirmationRecipient)
                                            throw new Error("Live-rebind confirmation recipient capture is unavailable.");
                                        confirmationRecipient();
                                        if (!isCurrent())
                                            throw new Error("Live-rebind selected confirmation issuance authority changed.");
                                    }
                                    releaseSelectedSource =
                                        Updates.acquireBaleUpdateRouting(original);
                                }
                                void completeCommand()
                                    .catch((error) => {
                                    try {
                                        deps.recordRuntimeEvent?.("routing", error, {
                                            phase: extension
                                                ? "live-rebind-selected-extension"
                                                : confirmation
                                                    ? `live-rebind-selected-${selection.confirmationCommand.name}`
                                                    : name
                                                        ? "live-rebind-selected-name"
                                                        : help
                                                            ? `live-rebind-selected-${selection.helpCommand.name}`
                                                            : stop
                                                                ? "live-rebind-selected-stop"
                                                                : next
                                                                    ? "live-rebind-selected-next"
                                                                    : abort
                                                                        ? "live-rebind-selected-abort"
                                                                        : "live-rebind-selected-menu",
                                        });
                                    }
                                    catch {
                                        /* Diagnostics cannot replay the issued command or reject detached work. */
                                    }
                                })
                                    .finally(() => {
                                    if (name || confirmation || extension)
                                        finishSelectedSource();
                                });
                            },
                        }
                        : generated
                            ? {
                                continue: (messages, isCurrent) => generated.continue(messages, isCurrent),
                                observeAdmission: generated.observe,
                            }
                            : selection.template || selection.continueCommand
                                ? {
                                    continue(messages, isCurrent) {
                                        queueCurrent = isCurrent;
                                        if (!selectedQueue ||
                                            messages.length !== selection.messages.length ||
                                            messages.some((message, index) => message !== selection.messages[index]))
                                            return Promise.resolve(false);
                                        return selectedQueue.execute();
                                    },
                                }
                                : {
                                    continue: (messages, isCurrent) => continueLiveRebindInput(messages, ctx, target, isCurrent),
                                }),
                }
                : undefined,
            recordRuntimeEvent: deps.recordRuntimeEvent,
        });
        let coordinator;
        let selectedQueue, queueCurrent;
        return {
            operationId: request.operationId,
            selectedCommandReference: () => coordinator?.selectedCommandReference(),
            observeCommandCompletion: () => coordinator?.observeCommandCompletion(),
            async advance() {
                if (!coordinator) {
                    if (!current() || !getRecipient())
                        return "protected";
                    // Selection may change only worker-owned clock metadata, never the prepared original payload.
                    const selected = selection.messages.map(Updates.inspectBaleDeferredSourceSnapshot);
                    if (!current() ||
                        selected.length !== originalSnapshots.length ||
                        selected.some((snapshot, index) => !snapshot ||
                            snapshot.source.updateId !==
                                originalSnapshots[index].source.updateId ||
                            snapshot.source.journalBindingKey !==
                                originalSnapshots[index].source.journalBindingKey ||
                            JSON.stringify(snapshot.update) !==
                                JSON.stringify(originalSnapshots[index].update)))
                        return "protected";
                    source = selected[0].source;
                    const queuedCommand = selection.continueCommand ?? selection.template?.command;
                    if (isLeader && queuedCommand) {
                        selectedQueue = commandHandler.prepareSelectedQueueCommand(queuedCommand, selection.messages, ctx, {
                            target,
                            assertSourceCurrent() {
                                if (!queueCurrent?.() || !current())
                                    throw new Error("Live-rebind selected queue source authority changed.");
                            },
                            assertRecipientCurrent,
                        });
                        if (!selectedQueue)
                            return "protected";
                    }
                    coordinator = createCoordinator();
                }
                return coordinator.advance();
            },
        };
    };
    async function inspectLiveRebindRecipient(intent, ctx, mode, admittedOrigin) {
        const ports = deps.workspaceRestoreRecipient, threads = deps.threadStore, store = deps.getWorkspaceRestoreStore?.();
        const followerMode = mode === "follower-cleanup" || mode === "follower-issue", cleanupMode = mode !== "work";
        const issueMode = mode === "issue" || mode === "follower-issue", callApi = deps.callApi;
        const collector = ports?.observeLeaderWork, peer = ports?.liveFollower, peerRun = peer?.run, peerJournal = peer?.getJournalBindingKey;
        const run = deps.runWorkspaceOperation;
        if (!ports ||
            !threads ||
            !store ||
            (followerMode ? !peer || !peerRun || !peerJournal : !collector) ||
            !run ||
            (issueMode && !callApi) ||
            deps.isContextActive?.(ctx) !== true) {
            return undefined;
        }
        try {
            const expected = structuredClone(intent), { request, recipient, executor } = expected;
            const instanceId = deps.getCurrentInstanceId?.(), epoch = deps.getCurrentLeaderEpoch?.(), generation = deps.getSessionGeneration?.();
            const operatorUserId = deps.configStore.getAllowedUserId(), scope = deps.getAdmissionScope?.(), journalBindingKey = deps.getAdmissionJournalBinding?.();
            const sessionId = ports.getSessionId(ctx), cwd = ports.getCwd(ctx), snapshot = threads.withWorkspaceLiveRebindSnapshot;
            const protection = threads.isWorkspaceLiveRebindCleanupTargetProtected;
            if (cleanupMode && typeof protection !== "function")
                return undefined;
            const registered = followerMode
                ? ports.followerRegistry.get(recipient.instanceId)
                : undefined;
            const follower = registered && structuredClone(registered), registry = ports.followerRegistry;
            const recipientJournalKey = follower && peerJournal?.call(peer, follower);
            // The selected-status reference lives only while its chooser record does; absence keeps the generic request.
            const findReference = () => {
                if (!followerMode)
                    return undefined;
                const found = [...pendingUnboundReroutes.values()]
                    .map((pending) => pending.liveRebind?.coordinator?.selectedCommandReference())
                    .filter((value) => value?.operationId === request.operationId);
                return found.length === 1 ? found[0] : undefined;
            };
            const reference = findReference();
            const referenceMarker = reference?.selectedCommand;
            if (reference &&
                (request.source.updateIds.length !== 1 ||
                    !referenceMarker ||
                    !isDeepStrictEqual(referenceMarker.target, request.target) ||
                    reference.preparedSource.updateId !== request.source.updateIds[0] ||
                    reference.preparedSource.journalBindingKey !== recipientJournalKey))
                return undefined;
            if (expected.kind !== "live-rebind" ||
                expected.phase !== "released" ||
                expected.cleanup ||
                recipient.kind !== (followerMode ? "follower" : "leader") ||
                !instanceId ||
                epoch === undefined ||
                generation === undefined ||
                !Number.isSafeInteger(generation) ||
                generation < 0 ||
                !scope ||
                !journalBindingKey ||
                !sessionId ||
                !cwd ||
                operatorUserId !== expected.operatorUserId ||
                executor.instanceId !== instanceId ||
                executor.leaderEpoch !== String(epoch) ||
                request.source.journalBindingKey !== journalBindingKey ||
                request.binding.sessionId !== recipient.sessionId ||
                !request.binding.slot ||
                request.owner.instanceId !== recipient.instanceId ||
                (followerMode
                    ? request.owner.owner?.kind !== "manual-follower" ||
                        !follower?.registrationGeneration ||
                        !follower.profileKey ||
                        follower.profileKey !== request.owner.profileKey ||
                        follower.sessionId !== recipient.sessionId ||
                        follower.registrationGeneration !== recipient.generation ||
                        !follower.cwd ||
                        WorkspaceIdentity.normalizeBaleWorkspacePath(follower.cwd) !==
                            request.binding.cwd ||
                        follower.slot !== request.binding.slot ||
                        !follower.busSocketPath ||
                        !recipientJournalKey ||
                        recipientJournalKey === follower.profileKey
                    : recipient.instanceId !== instanceId ||
                        recipient.sessionId !== sessionId ||
                        recipient.generation !== String(generation) ||
                        request.owner.owner?.kind !== "leader" ||
                        WorkspaceIdentity.normalizeBaleWorkspacePath(cwd) !==
                            request.binding.cwd))
                return undefined;
            const followerCurrent = () => {
                if (!followerMode)
                    return true;
                const live = registry.get(recipient.instanceId);
                return (ports.followerRegistry === registry &&
                    ports.liveFollower === peer &&
                    peer?.run === peerRun &&
                    peer?.getJournalBindingKey === peerJournal &&
                    !!live &&
                    Bus.isSameBaleBusFollowerRegistration(live, follower) &&
                    Bus.BALE_BUS_LIVE_REBIND_CAPABILITIES.every((cap) => Bus.hasBaleBusCapability(live.protocol, cap)) &&
                    !!live.target &&
                    live.target.chatId === request.target.chatId &&
                    live.target.threadId === request.target.threadId &&
                    peerJournal.call(peer, live) === recipientJournalKey &&
                    isDeepStrictEqual(findReference(), reference));
            };
            const current = () => (!admittedOrigin || admittedOrigin()) &&
                deps.hasWorkspaceLiveRebindAuthority?.() === true &&
                deps.isContextActive?.(ctx) === true &&
                deps.workspaceRestoreRecipient === ports &&
                (followerMode || ports.observeLeaderWork === collector) &&
                deps.threadStore === threads &&
                threads.withWorkspaceLiveRebindSnapshot === snapshot &&
                (!cleanupMode ||
                    threads.isWorkspaceLiveRebindCleanupTargetProtected === protection) &&
                deps.getWorkspaceRestoreStore?.() === store &&
                deps.runWorkspaceOperation === run &&
                deps.getCurrentInstanceId?.() === instanceId &&
                deps.getCurrentLeaderEpoch?.() === epoch &&
                deps.getSessionGeneration?.() === generation &&
                deps.getAdmissionScope?.() === scope &&
                deps.getAdmissionJournalBinding?.() === journalBindingKey &&
                (!issueMode || deps.callApi === callApi) &&
                deps.configStore.getAllowedUserId() === operatorUserId &&
                ports.getSessionId(ctx) === sessionId &&
                ports.getCwd(ctx) === cwd &&
                followerCurrent();
            // After the issue marker, the exact issued row (not the released original) is the canonical evidence.
            const assertCanonical = (row = expected) => {
                if (!current())
                    throw new Error("Live-rebind work recipient authority changed.");
                let confirmed = false;
                snapshot.call(threads, row, (view) => {
                    const found = findRelocatedBindingOwner(view, request), local = followerMode
                        ? registry.get(recipient.instanceId)
                        : ports.getLeaderIdentity();
                    confirmed =
                        current() &&
                            !!found &&
                            found.row.workspaceKey === request.binding.workspaceKey &&
                            found.owner.instanceId === recipient.instanceId &&
                            isDeepStrictEqual(found.owner.owner, request.owner.owner) &&
                            !!local &&
                            local.slot === request.binding.slot &&
                            local.target?.chatId === request.target.chatId &&
                            local.target.threadId === request.target.threadId;
                });
                if (!confirmed || !current())
                    throw new Error("Live-rebind work canonical/local recipient changed.");
            };
            const sample = async () => {
                assertCanonical();
                if (cleanupMode) {
                    const protectedTarget = protection.call(threads, expected);
                    if (protectedTarget !== false)
                        return undefined;
                }
                const target = { ...request.binding.target };
                let value;
                if (followerMode) {
                    const observation = await peerRun.call(peer, {
                        operationId: request.operationId,
                        instanceId: recipient.instanceId,
                        sessionId: recipient.sessionId,
                        recipientBindingKey: recipientJournalKey,
                        mode: expected.inputRelease === "held" ? "observe-held" : "observe",
                        sourceUpdateIds: [...request.source.updateIds],
                        slot: request.binding.slot,
                        target: { ...request.target },
                        oldTarget: target,
                        isCurrent: current,
                        ...(reference
                            ? {
                                selectedCommand: structuredClone(reference.selectedCommand),
                                preparedSource: { ...reference.preparedSource },
                            }
                            : {}),
                    });
                    assertCanonical();
                    if (observation?.status !== "observed" ||
                        observation.operationId !== request.operationId ||
                        !isDeepStrictEqual(observation.selectedCommand, reference?.selectedCommand) ||
                        !isDeepStrictEqual(observation.preparedSource, reference?.preparedSource) ||
                        !isDeepStrictEqual(observation.oldTarget, request.binding.target) ||
                        !isDeepStrictEqual(observation.sourceUpdateIds, request.source.updateIds) ||
                        !isDeepStrictEqual(observation.recipient, {
                            instanceId: recipient.instanceId,
                            sessionId: recipient.sessionId,
                            generation: recipient.generation,
                            bindingKey: recipientJournalKey,
                        }))
                        return undefined;
                    value = observation.work;
                }
                else
                    value = collector(target, ctx);
                const work = {
                    sessionBusy: value?.sessionBusy,
                    targetWork: value?.targetWork,
                    deliveryPending: value?.deliveryPending,
                    unknown: value?.unknown,
                };
                if (!isDeepStrictEqual(target, request.binding.target) ||
                    Object.values(work).some((flag) => typeof flag !== "boolean"))
                    throw new Error("Live-rebind work sample is unavailable or changed target.");
                assertCanonical();
                if (cleanupMode) {
                    const targetProtected = protection.call(threads, expected);
                    const prepared = ThreadReconciler.prepareLiveRebindThreadCleanup({
                        operationId: request.operationId,
                        oldTarget: request.binding.target,
                        recipientTarget: request.target,
                        leaderEpoch: executor.leaderEpoch,
                        targetProtected,
                        work,
                    });
                    assertCanonical();
                    return prepared;
                }
                return {
                    status: "observed",
                    operationId: request.operationId,
                    recipient: {
                        instanceId,
                        sessionId,
                        generation: String(generation),
                        bindingKey: journalBindingKey,
                    },
                    sourceUpdateIds: [...request.source.updateIds],
                    oldTarget: { ...request.binding.target },
                    work,
                };
            };
            if (!current())
                return undefined;
            if (issueMode) {
                // One admission spans the fresh sample, durable issue marker, single deletion and terminal record.
                const execute = async () => {
                    const prepared = await sample();
                    if (!prepared ||
                        prepared.status !== "prepared" ||
                        !current() ||
                        protection.call(threads, expected) !== false) {
                        return { status: "not-ready" };
                    }
                    const authority = {
                        executor: structuredClone(executor),
                        operatorUserId: expected.operatorUserId,
                        isCurrent: current,
                    };
                    const grant = store.advanceLiveRebind(expected, "issue-cleanup", authority);
                    if (!grant) {
                        return undefined;
                    }
                    const assertGranted = () => assertCanonical(grant);
                    const cleanup = await ThreadReconciler.issueLiveRebindThreadCleanup(prepared, {
                        assertCurrent: assertGranted,
                        deleteTopic: (target) => callApi("deleteForumTopic", { chat_id: target.chatId, message_thread_id: target.threadId }, { maxAttempts: 1, assertAuthority: assertGranted }),
                        classifyFailure: classifyLiveRebindCleanupFailure,
                    });
                    let recorded = false;
                    try {
                        recorded = !!store.advanceLiveRebind(grant, cleanup, authority);
                    }
                    catch (error) {
                        deps.recordRuntimeEvent?.("routing", error, {
                            phase: "live-rebind-cleanup-terminal",
                        });
                    }
                    return {
                        status: "finished",
                        operationId: request.operationId,
                        cleanup,
                        recorded,
                    };
                };
                // Pre-dispatch calls are private to the chooser callback already holding the same profile admission/gate.
                return admittedOrigin ? await execute() : await run({
                    operationId: `live-${mode}-${randomBytes(16).toString("hex")}`,
                    operationKind: "workspace.live-rebind-cleanup", scopes: [{ kind: "profile" }],
                }, execute);
            }
            const observation = await run({
                operationId: `live-${mode}-${randomBytes(16).toString("hex")}`,
                operationKind: "workspace.live-rebind-observe",
                scopes: [{ kind: "profile" }],
            }, async () => sample());
            assertCanonical();
            // Admission release is an await too. Recollect for refusal only; the returned candidate retains no lease or issuance authority.
            return cleanupMode && observation ? sample() : observation;
        }
        catch (error) {
            try {
                deps.recordRuntimeEvent?.("routing", error, {
                    phase: issueMode
                        ? "live-rebind-cleanup-issuance"
                        : cleanupMode
                            ? "live-rebind-cleanup-preparation"
                            : "live-rebind-work-observation",
                });
            }
            catch {
                /* Diagnostics cannot turn missing work evidence into idle or an effect grant. */
            }
            return undefined;
        }
    }
    const observeLiveRebindLeaderWork = (intent, ctx) => inspectLiveRebindRecipient(intent, ctx, "work");
    const prepareLiveRebindLeaderCleanup = (intent, ctx) => inspectLiveRebindRecipient(intent, ctx, "cleanup");
    const prepareLiveRebindFollowerCleanup = (intent, ctx) => inspectLiveRebindRecipient(intent, ctx, "follower-cleanup");
    const issueLiveRebindLeaderCleanup = (intent, ctx) => inspectLiveRebindRecipient(intent, ctx, "issue");
    const issueLiveRebindFollowerCleanup = (intent, ctx) => inspectLiveRebindRecipient(intent, ctx, "follower-issue");
    // One pacing chain per operation: a waiting timer or a running attempt; repeated choices never start another.
    const liveRebindCleanupChains = new Map();
    // One hint slot per existing leader chain; a running attempt retains at most one coalesced recheck.
    const liveRebindCleanupWakers = new Map();
    const captureLiveRebindCleanupScope = (ctx) => {
        try {
            const generation = deps.getSessionGeneration?.(), instanceId = deps.getCurrentInstanceId?.(), epoch = deps.getCurrentLeaderEpoch?.(), store = deps.getWorkspaceRestoreStore?.(), operator = deps.configStore.getAllowedUserId();
            return () => {
                try {
                    return deps.isContextActive?.(ctx) === true && deps.getSessionGeneration?.() === generation &&
                        deps.getCurrentInstanceId?.() === instanceId && deps.getCurrentLeaderEpoch?.() === epoch &&
                        deps.getWorkspaceRestoreStore?.() === store && deps.configStore.getAllowedUserId() === operator;
                }
                catch {
                    return false;
                }
            };
        }
        catch {
            return () => false;
        }
    };
    /** End an unissued attempt honestly under fresh admission and current operator authority; no executor grant is borrowed. */
    const terminalizeUnissuedLiveRebindCleanup = async (operationId, ctx) => {
        const run = deps.runWorkspaceOperation, store = deps.getWorkspaceRestoreStore?.();
        const instanceId = deps.getCurrentInstanceId?.(), epoch = deps.getCurrentLeaderEpoch?.(), operatorUserId = deps.configStore.getAllowedUserId();
        if (!run ||
            !store ||
            !instanceId ||
            epoch === undefined ||
            operatorUserId === undefined)
            return;
        const current = () => deps.isContextActive?.(ctx) === true &&
            deps.getWorkspaceRestoreStore?.() === store &&
            deps.getCurrentInstanceId?.() === instanceId &&
            deps.getCurrentLeaderEpoch?.() === epoch &&
            deps.configStore.getAllowedUserId() === operatorUserId;
        await run({
            operationId: `live-cleanup-expiry-${randomBytes(16).toString("hex")}`,
            operationKind: "workspace.live-rebind-cleanup",
            scopes: [{ kind: "profile" }],
        }, async () => {
            const intent = store
                .listLiveRebindings()
                .find((value) => value.request.operationId === operationId);
            if (!current() ||
                intent?.phase !== "released" ||
                intent.cleanup !== undefined ||
                intent.operatorUserId !== operatorUserId)
                return;
            store.advanceLiveRebind(intent, "not-issued", {
                executor: { instanceId, leaderEpoch: String(epoch) },
                operatorUserId,
                isCurrent: current,
            });
        });
    };
    /**
     * Bounded best-effort pacing after a confirmed release. Each attempt is a fresh `issue*` call; `not-ready` waits,
     * a finished outcome or an inactive session stops, and the window ends in `not-issued` so no released row becomes a
     * permanent rebinding blocker. Waiting timers never join settlement; only a running attempt does.
     */
    const scheduleLiveRebindCleanup = (operationId, role, ctx, startedAtMs = Date.now(), attempt = 0, current = captureLiveRebindCleanupScope(ctx)) => {
        const pacing = deps.liveRebindCleanupSchedule;
        const chain = liveRebindCleanupChains.get(operationId);
        if (!pacing ||
            (attempt === 0 ? chain !== undefined : chain !== "running") ||
            !current()) {
            if (attempt > 0 && chain === "running") {
                liveRebindCleanupChains.delete(operationId);
                liveRebindCleanupWakers.delete(operationId);
            }
            return;
        }
        let pendingWake;
        const wake = (reason) => {
            if (!current())
                return;
            if (liveRebindCleanupChains.get(operationId) === "running") {
                pendingWake = reason;
                return;
            }
            if (liveRebindCleanupChains.get(operationId) !== timer)
                return;
            if (reason === "delivery-drained") {
                let idle;
                try {
                    idle = deps.isIdle?.(ctx);
                }
                catch { /* A missing idle observation is not a reason to hurry cleanup. */ }
                if (idle !== true) {
                    // A streamed technical task can drain between deltas while Pi still runs. Keep one hint, not a polling loop.
                    pendingWake = reason;
                    return;
                }
            }
            clearTimeout(timer);
            attemptNow();
        };
        const attemptNow = () => {
            if (liveRebindCleanupChains.get(operationId) !== timer)
                return;
            pendingWake = undefined; // This fresh timer/settlement attempt consumes any previously deferred hint.
            liveRebindCleanupChains.set(operationId, "running");
            if (role === "leader")
                liveRebindCleanupWakers.set(operationId, wake);
            let continued = false;
            const task = (async () => {
                if (!current())
                    return;
                const intent = deps
                    .getWorkspaceRestoreStore?.()
                    ?.listLiveRebindings()
                    .find((value) => value.request.operationId === operationId);
                if (intent?.phase !== "released" || intent.cleanup !== undefined)
                    return;
                const result = role === "leader"
                    ? await issueLiveRebindLeaderCleanup(intent, ctx)
                    : await issueLiveRebindFollowerCleanup(intent, ctx);
                if (result?.status === "finished" ||
                    !current())
                    return;
                if (Date.now() - startedAtMs >= pacing.windowMs) {
                    return terminalizeUnissuedLiveRebindCleanup(operationId, ctx);
                }
                continued = true;
                scheduleLiveRebindCleanup(operationId, role, ctx, startedAtMs, attempt + 1, current);
                if (pendingWake)
                    liveRebindCleanupWakers.get(operationId)?.(pendingWake);
            })()
                .catch((error) => deps.recordRuntimeEvent?.("routing", error, {
                phase: "live-rebind-cleanup-schedule",
            }))
                .finally(() => {
                if (!continued &&
                    liveRebindCleanupChains.get(operationId) === "running") {
                    liveRebindCleanupChains.delete(operationId);
                    liveRebindCleanupWakers.delete(operationId);
                }
            });
            restoreSettlementTasks.add(task);
            void task.finally(() => restoreSettlementTasks.delete(task));
        };
        const timer = setTimeout(attemptNow, pacing.delaysMs[attempt] ?? pacing.intervalMs);
        timer.unref?.();
        liveRebindCleanupChains.set(operationId, timer);
        // The first delay stays whole: a detached command reply still needs the released, cleanup-free row.
        if (role === "leader" && attempt > 0)
            liveRebindCleanupWakers.set(operationId, wake);
    };
    const wakeLiveRebindCleanup = (ctx, reason) => {
        if (deps.isContextActive?.(ctx) !== true)
            return;
        for (const wake of [...liveRebindCleanupWakers.values()])
            wake(reason);
    };
    const onSessionSettled = (ctx) => wakeLiveRebindCleanup(ctx, "session-settled");
    const onDeliverySettled = (ctx) => {
        wakeLiveRebindCleanup(ctx, "delivery-drained");
        const cap = captureTemporaryThreadAuthority(ctx);
        if (!cap?.isCurrent())
            return;
        try {
            for (const entry of cap.store.listTemporaryThreads()) {
                if (!cap.isCurrent())
                    return;
                if (entry.phase === "created" && entry.target && !entry.cleanupIssued &&
                    Threads.isBaleTemporaryThreadFullyResolved(entry))
                    scheduleTemporaryThreadCleanup(entry.target, ctx);
            }
        }
        catch (error) {
            deps.recordRuntimeEvent?.("routing", error, { phase: "temporary-thread-cleanup-drain" });
        }
    };
    const restoreWorkspace = deps.workspaceRestoreRecipient
        ? async (input) => {
            const ports = deps.workspaceRestoreRecipient;
            const threads = deps.threadStore;
            if (!threads ||
                !deps.getWorkspaceRestoreStore ||
                !deps.getSessionGeneration ||
                !deps.hasWorkspaceRestoreAuthority?.() ||
                !input.isCurrent() ||
                input.target.threadId === undefined)
                return "protected";
            const instanceId = deps.getCurrentInstanceId?.(), epoch = deps.getCurrentLeaderEpoch?.();
            const operatorUserId = deps.configStore.getAllowedUserId(), scope = deps.getAdmissionScope?.();
            const journalBindingKey = deps.getAdmissionJournalBinding?.(), generation = deps.getSessionGeneration();
            const sourceIds = Updates.collectBaleAdmissionSourceUpdateIds(input.messages);
            if (!instanceId ||
                epoch === undefined ||
                operatorUserId === undefined ||
                !scope ||
                !journalBindingKey ||
                !sourceIds.length)
                return "protected";
            const current = () => input.isCurrent() &&
                deps.hasWorkspaceRestoreAuthority?.() === true &&
                deps.isContextActive?.(input.ctx) !== false &&
                deps.getSessionGeneration?.() === generation &&
                deps.getCurrentInstanceId?.() === instanceId &&
                deps.getCurrentLeaderEpoch?.() === epoch &&
                deps.getAdmissionScope?.() === scope &&
                deps.getAdmissionJournalBinding?.() === journalBindingKey &&
                deps.configStore.getAllowedUserId() === operatorUserId;
            await threads.load();
            if (!current())
                return "protected";
            const store = deps.getWorkspaceRestoreStore();
            if (!store)
                return "protected";
            const retained = store
                .list()
                .find((value) => value.request.operationId === input.operationId);
            const bindings = threads
                .listWorkspaceBindings()
                .filter((value) => isDeepStrictEqual(value.target, input.record.target));
            const binding = retained?.request.binding ??
                (bindings.length === 1 ? bindings[0] : undefined);
            if (!binding || !binding.sessionId || !binding.slot)
                return "protected";
            const { sessionId, slot } = binding;
            const request = {
                operationId: input.operationId,
                binding,
                owner: structuredClone(input.record),
                target: {
                    chatId: input.target.chatId,
                    threadId: input.target.threadId,
                },
                source: { journalBindingKey, updateIds: sourceIds },
            };
            if (retained && !isDeepStrictEqual(retained.request, request))
                return "protected";
            const getRecipient = (snapshot) => {
                if (!current())
                    return undefined;
                const liveBindings = (snapshot
                    ? (snapshot.workspaceBindings ?? [])
                    : threads.listWorkspaceBindings()).filter((value) => value.bindingKey === binding.bindingKey);
                const live = liveBindings[0];
                if (liveBindings.length !== 1 ||
                    live?.sessionId !== binding.sessionId ||
                    live.cwd !== binding.cwd ||
                    live.slot !== binding.slot ||
                    live.inactiveSinceMs !== undefined ||
                    (!isDeepStrictEqual(live.target, binding.target) &&
                        !isDeepStrictEqual(live.target, request.target)))
                    return undefined;
                const records = (snapshot ? snapshot.threads : threads.list()).filter((value) => value.status === "active" &&
                    (value.slot === binding.slot ||
                        isDeepStrictEqual(value.target, live.target)));
                const record = records[0];
                if (records.length !== 1 ||
                    record?.slot !== binding.slot ||
                    !isDeepStrictEqual(record.target, live.target))
                    return undefined;
                if (record.owner?.kind === "leader" &&
                    record.instanceId === instanceId) {
                    const cwd = ports.getCwd(input.ctx);
                    if (ports.getSessionId(input.ctx) !== sessionId ||
                        !cwd ||
                        WorkspaceIdentity.normalizeBaleWorkspacePath(cwd) !==
                            binding.cwd ||
                        !deps.setCurrentLeaderIdentity)
                        return undefined;
                    return {
                        kind: "leader",
                        instanceId,
                        sessionId,
                        generation: String(generation),
                    };
                }
                if (record.owner?.kind !== "manual-follower" || !record.instanceId)
                    return undefined;
                const follower = ports.followerRegistry.get(record.instanceId);
                if (!follower?.registrationGeneration ||
                    !follower.cwd ||
                    follower.sessionId !== sessionId ||
                    WorkspaceIdentity.normalizeBaleWorkspacePath(follower.cwd) !==
                        binding.cwd ||
                    follower.slot !== slot ||
                    !Bus.hasBaleBusCapability(follower.protocol, Bus.BALE_BUS_CAPABILITY_WORKSPACE_RESTORE))
                    return undefined;
                return {
                    kind: "follower",
                    instanceId: follower.instanceId,
                    sessionId,
                    generation: follower.registrationGeneration,
                };
            };
            const hasCommittedTarget = () => threads
                .listWorkspaceBindings()
                .some((value) => value.bindingKey === binding.bindingKey &&
                isDeepStrictEqual(value.target, request.target));
            const authority = {
                executor: { instanceId, leaderEpoch: String(epoch) },
                operatorUserId,
                isCurrent: current,
            };
            const ready = await advanceBaleWorkspaceRestore({
                request,
                authority,
                restoreStore: store,
                getRecipient,
                async runRecipient(action) {
                    const recipient = getRecipient();
                    if (!recipient || !action.isCurrent() || !hasCommittedTarget())
                        return undefined;
                    if (recipient.kind === "follower") {
                        const follower = ports.followerRegistry.get(recipient.instanceId);
                        const observation = await ports.runFollower({
                            operationId: request.operationId,
                            instanceId: recipient.instanceId,
                            sessionId: recipient.sessionId,
                            slot: binding.slot,
                            target: request.target,
                            oldTarget: binding.target,
                            mode: action.mode,
                            isCurrent: action.isCurrent,
                        });
                        if (!action.isCurrent() || !hasCommittedTarget())
                            return undefined;
                        if (!follower || !observation?.ready)
                            return observation;
                        if (observation.operationId !== request.operationId ||
                            !isDeepStrictEqual(observation.recipient, recipient) ||
                            !isDeepStrictEqual(observation.target, request.target) ||
                            observation.slot !== binding.slot)
                            return undefined;
                        const actual = ports.followerRegistry.get(recipient.instanceId);
                        if (!actual ||
                            actual.registrationGeneration !==
                                follower.registrationGeneration ||
                            actual.sessionId !== follower.sessionId ||
                            actual.cwd !== follower.cwd ||
                            actual.slot !== follower.slot ||
                            actual.profileKey !== follower.profileKey ||
                            actual.busSocketPath !== follower.busSocketPath ||
                            !isDeepStrictEqual(actual.target, follower.target) ||
                            !isDeepStrictEqual(actual.protocol, follower.protocol))
                            return undefined;
                        threads.commitWorkspaceRestoreRegistration({
                            target: request.target,
                            bindingKey: binding.bindingKey,
                            slot: binding.slot,
                        }, () => {
                            if (!action.isCurrent())
                                throw new Error("Workspace Restore recipient authority changed.");
                            ports.followerRegistry.register({
                                ...actual,
                                target: request.target,
                                connectedAtMs: actual.connectedAtMs,
                            });
                        });
                        return observation;
                    }
                    let observation;
                    threads.withWorkspaceRestoreSnapshot(action.intent, (snapshot) => {
                        if (!action.isCurrent() ||
                            !isDeepStrictEqual(getRecipient(snapshot), recipient))
                            return;
                        const live = snapshot.workspaceBindings?.find((value) => value.bindingKey === binding.bindingKey);
                        if (!live || !isDeepStrictEqual(live.target, request.target))
                            return;
                        const local = ports.getLeaderIdentity();
                        if (!local ||
                            local.slot !== binding.slot ||
                            (!isDeepStrictEqual(local.target, binding.target) &&
                                !isDeepStrictEqual(local.target, request.target)))
                            return;
                        if (action.mode === "apply" &&
                            !isDeepStrictEqual(local.target, request.target)) {
                            if (action.intent.phase !== "recipient-issued" ||
                                !action.isCurrent())
                                return;
                            deps.setCurrentLeaderIdentity({
                                target: request.target,
                                slot: binding.slot,
                                threadName: request.owner.threadName,
                            });
                        }
                        if (!action.isCurrent() ||
                            !isDeepStrictEqual(getRecipient(snapshot), recipient))
                            return;
                        const observed = ports.getLeaderIdentity();
                        if (!observed || observed.slot !== binding.slot)
                            return;
                        observation = {
                            operationId: request.operationId,
                            recipient,
                            target: observed.target,
                            slot: binding.slot,
                            ready: isDeepStrictEqual(observed.target, request.target),
                        };
                    });
                    return observation;
                },
            }).catch((error) => {
                deps.recordRuntimeEvent?.("bale", error, {
                    phase: "workspace-restore-recipient",
                });
                return undefined;
            });
            if (!ready || !current() || ready.routing)
                return "protected";
            const recipient = ready.readyRecipient ?? ready.recipient;
            const recipientCurrent = () => {
                if (!current() ||
                    !recipient ||
                    !hasCommittedTarget() ||
                    !isDeepStrictEqual(getRecipient(), recipient))
                    return false;
                const observed = recipient.kind === "leader"
                    ? ports.getLeaderIdentity()
                    : ports.followerRegistry.get(recipient.instanceId);
                return (observed?.slot === slot &&
                    isDeepStrictEqual(observed.target, request.target));
            };
            if (!recipient || !recipientCurrent())
                return "protected";
            if (deps.callApi) {
                try {
                    await deps.callApi("editForumTopic", {
                        chat_id: request.target.chatId,
                        message_thread_id: request.target.threadId,
                        name: deps.getDisplayTitle?.(request.target) ??
                            ThreadNaming.getBaleTopicTitleForThreadName(getRestoredThreadName(request.owner, slot), slot),
                    });
                }
                catch (error) {
                    deps.recordRuntimeEvent?.("bale", error, {
                        phase: "workspace-restore-title",
                    });
                }
            }
            if (!recipientCurrent() ||
                !store.issueRouting(ready, {
                    ...authority,
                    isCurrent: recipientCurrent,
                }))
                return "protected";
            const recordAcceptance = (message, delivery) => {
                if (!recipientCurrent() ||
                    recipient.kind !== (delivery ? "follower" : "leader"))
                    throw new Error("Workspace Restore acceptance authority changed.");
                const source = Updates.inspectBaleDeferredSource(message);
                const follower = ports.followerRegistry.get(recipient.instanceId);
                const ownership = deps.getTargetOwnership?.(request.target);
                if (!source ||
                    source.journalBindingKey !== journalBindingKey ||
                    !request.source.updateIds.includes(source.updateId) ||
                    (delivery &&
                        (!follower ||
                            ownership?.instanceId !== recipient.instanceId ||
                            ownership.ownerGeneration !== recipient.generation ||
                            !ownership.recipientBindingKey ||
                            delivery.sourceUpdateId !== source.updateId ||
                            delivery.recipientBindingKey !==
                                ownership.recipientBindingKey ||
                            delivery.deliveryId !==
                                Bus.createBaleBusFollowerDeliveryIdentity({
                                    kind: "leader.forwardMessage",
                                    recipientBindingKey: ownership.recipientBindingKey,
                                    sourceUpdateId: source.updateId,
                                }).deliveryId)) ||
                    !recipientCurrent())
                    throw new Error("Workspace Restore acceptance source or delivery changed.");
                const evidence = {
                    ...source,
                    recipient,
                    ...(delivery
                        ? {
                            kind: "forwarded",
                            deliveryId: delivery.deliveryId,
                            recipientBindingKey: delivery.recipientBindingKey,
                        }
                        : { kind: "completed" }),
                };
                const expected = store
                    .list()
                    .find((value) => value.request.operationId === request.operationId);
                if (!expected ||
                    !isDeepStrictEqual(expected.request, request) ||
                    !expected.routing ||
                    !recipientCurrent())
                    throw new Error("Workspace Restore dispatch proof is unavailable.");
                let accepted;
                let failure;
                const acceptanceAuthority = {
                    ...authority,
                    isCurrent: recipientCurrent,
                };
                try {
                    accepted = store.recordSourceAcceptance(expected, evidence, acceptanceAuthority);
                }
                catch (error) {
                    failure = { error };
                }
                if (!recipientCurrent())
                    throw new Error("Workspace Restore acceptance authority changed.");
                // A lost rename reply observes only the exact full retained proof; it never resends the accepted message.
                if (!accepted) {
                    const observed = store
                        .list()
                        .find((value) => value.request.operationId === request.operationId);
                    if (observed &&
                        isDeepStrictEqual(observed.request, request) &&
                        isDeepStrictEqual(observed.executor, authority.executor) &&
                        observed.operatorUserId === operatorUserId &&
                        observed.routing?.acceptances?.some((value) => isDeepStrictEqual(value, evidence)))
                        accepted = observed;
                }
                if (!accepted ||
                    !isDeepStrictEqual(accepted.request, request) ||
                    !isDeepStrictEqual(accepted.executor, authority.executor) ||
                    accepted.operatorUserId !== operatorUserId ||
                    !accepted.routing?.acceptances?.some((value) => isDeepStrictEqual(value, evidence)) ||
                    !recipientCurrent())
                    throw (failure?.error ??
                        new Error("Workspace Restore acceptance was not published."));
                return {
                    ...source,
                    completionSha256: Threads.getBaleWorkspaceRestoreSourceCompletionSha256(accepted, evidence),
                };
            };
            try {
                await input.dispatch(recipient, recipientCurrent, recordAcceptance, (message) => recordAcceptance(message));
            }
            catch (error) {
                deps.recordRuntimeEvent?.("bale", error, {
                    phase: "workspace-restore-dispatch",
                });
            }
            // Positive worker ACKs own settlement and cleanup under a subsequent admission.
            return "protected";
        }
        : undefined;
    const retryPendingRerouteCleanup = async (cleanup, assertExecutionCurrent) => {
        if (cleanup.kind === "unbound") {
            return closeReroutedUnboundTopic(cleanup.target, cleanup.messageId, assertExecutionCurrent, cleanup.temporaryThread);
        }
        if (cleanup.kind === "previous-leader") {
            return closePreviousLeaderThread(cleanup.target, assertExecutionCurrent);
        }
        return closeReplacedFollowerThread(cleanup.target, cleanup.instanceId, assertExecutionCurrent);
    };
    let dispatchReroutedCommandMessages;
    const dispatchPendingRerouteMessages = async (pending, messages, ctx) => {
        if (pending.dispatchKind === "command" && dispatchReroutedCommandMessages) {
            await dispatchReroutedCommandMessages(messages, ctx);
            // Every command chooser deferred its exact original, whether the tab came from Bale or the bridge.
            // A queued command retains its separately reported receipt; this cannot settle accepted queue custody.
            for (const message of messages)
                Updates.reportBaleUpdateCompleted(message);
            return;
        }
        await promptEnqueue(messages, ctx);
    };
    /** Local menu acceptance owns a one-shot effect; source removal and cleanup precede its release, never its replay. */
    const stageTemporaryRerouteMenu = async (pending, command, messages, ctx, assertRecipientCurrent, completion) => {
        const original = pending.messages[0];
        const cap = captureTemporaryThreadAuthority(ctx);
        const temporary = pending.temporaryThread ?? findCreatedTemporaryThread(pending.sourceTarget);
        if (!cap?.isCurrent() || !temporary)
            return undefined;
        let accept, resume;
        const accepted = new Promise(resolve => { accept = resolve; });
        const released = new Promise(resolve => { resume = resolve; });
        const admission = {
            assertSourceCurrent() {
                if (!completion.isCurrent())
                    throw new Error("Rerouted menu source authority changed.");
            },
            assertRecipientCurrent,
            reportCompleted() {
                const result = completion.reportCompleted();
                accept(result);
                return result;
            },
            async beforeEffects() {
                if (!(await released))
                    throw new Error("Rerouted menu execution was not released.");
            },
        };
        const prepare = command.name === "start" ? commandHandler.prepareSelectedStartCommand
            : command.name === "help" ? commandHandler.prepareSelectedHelpCommand : commandHandler.prepareSelectedMenuCommand;
        const dispatch = prepare(command, messages, ctx, admission);
        if (!dispatch)
            return undefined;
        const execution = dispatch().catch(error => {
            deps.recordRuntimeEvent?.("routing", error, { phase: "reroute-menu-execution" });
            return false;
        });
        if (!(await Promise.race([accepted, execution.then(() => false)]))) {
            resume(false);
            await execution;
            return undefined;
        }
        return async () => {
            let allowEffects = false;
            try {
                const confirmed = await new Promise(resolve => {
                    let done = false, unsubscribe;
                    const signal = Updates.getBaleUpdateExecutionFence(original)?.signal;
                    const finish = (result) => {
                        if (done)
                            return;
                        done = true;
                        clearTimeout(timer);
                        unsubscribe?.();
                        signal?.removeEventListener("abort", abort);
                        resolve(result);
                    };
                    const abort = () => finish(false);
                    const observe = () => {
                        if (!cap.isCurrent() || !completion.isCurrent())
                            finish(false);
                        else if (completion.inspectCompletion())
                            finish(true);
                    };
                    const timer = setTimeout(abort, deps.liveRebindCommandCompletionTimeoutMs ?? 8_000);
                    timer.unref?.();
                    unsubscribe = Updates.subscribeBaleDeferredSourceCompletion(original, observe);
                    signal?.addEventListener("abort", abort, { once: true });
                    if (signal?.aborted)
                        abort();
                    else
                        observe();
                });
                if (!confirmed)
                    throw new Error("Rerouted menu source removal is unconfirmed; execution remains suppressed.");
                assertRecipientCurrent();
                cancelTemporaryThreadCleanup(temporary.token);
                try {
                    await runTemporaryThreadCleanup(temporary.token, cap, false);
                }
                catch (error) {
                    // Cleanup uncertainty retains its canonical grant, not command execution authority or a retry license.
                    deps.recordRuntimeEvent?.("routing", error, { phase: "reroute-menu-cleanup" });
                }
                assertRecipientCurrent();
                allowEffects = true;
            }
            catch (error) {
                deps.recordRuntimeEvent?.("routing", error, { phase: "reroute-menu-release" });
            }
            finally {
                resume(allowEffects);
                await execution;
            }
        };
    };
    const finalizePendingReroute = async (rerouteId, pending, query, successMessage, assertExecutionCurrent = Updates.createBaleUpdateExecutionFenceGuard(query), retainRecord = false) => {
        assertExecutionCurrent();
        const dismissed = await dismissRerouteChooserMessage(query, assertExecutionCurrent);
        assertExecutionCurrent();
        if (dismissed) {
            // A retained record no longer matches any chooser, so a late duplicate tap reads as expired.
            if (retainRecord)
                pending.chooserMessageId = undefined;
            else
                removePendingReroute(rerouteId);
            await deps.answerCallbackQuery(query.id, successMessage);
            await deleteAllTabCopies(pending);
            return;
        }
        pending.phase = {
            kind: "finalizing",
            message: successMessage,
            ...(retainRecord ? { retainRecord: true } : {}),
        };
        await deps.answerCallbackQuery(query.id, `${successMessage}; tap again to clear the menu`);
    };
    const isTemporaryReroute = (pending) => !!pending.temporaryThread ||
        pending.temporaryMembership === true ||
        isTemporaryTabTarget(pending.sourceTarget);
    const isTemporaryThreadForwardIssued = (pending) => {
        try {
            const entry = pending.temporaryThread ??
                findCreatedTemporaryThread(pending.sourceTarget);
            const store = deps.getWorkspaceRestoreStore?.();
            if ((entry || pending.temporaryMembership) && !store)
                return true;
            const stored = entry &&
                store
                    ?.listTemporaryThreads()
                    .find((value) => value.token === entry.token);
            const updateIds = Updates.collectBaleAdmissionSourceUpdateIds(pending.messages);
            return !!stored?.forwardedInputs?.some((input) => input.updateIds.some((id) => updateIds.includes(id)));
        }
        catch {
            return true;
        }
    };
    /** Publishes the durable one-time Forward fact for this chooser's exact group; false means nothing may be sent. */
    const issueTemporaryThreadForward = (pending, ctx) => {
        const entry = pending.temporaryThread ??
            findCreatedTemporaryThread(pending.sourceTarget);
        const cap = captureTemporaryThreadAuthority(ctx);
        if (!entry || !cap)
            return false;
        const group = {
            journalBindingKey: entry.source.journalBindingKey,
            updateIds: Updates.collectBaleAdmissionSourceUpdateIds(pending.messages),
        };
        try {
            const current = cap.store
                .listTemporaryThreads()
                .find((value) => value.token === entry.token);
            const adopted = current && cap.isCurrent() ? cap.adopt(current) : undefined;
            return (!!adopted &&
                cap.isCurrent() &&
                !!cap.store.recordTemporaryThreadForwardIssued(adopted, group, cap.authority) &&
                cap.isCurrent());
        }
        catch (error) {
            deps.recordRuntimeEvent?.("routing", error, {
                phase: "temporary-thread-forward-issue",
            });
            return false;
        }
    };
    /** Publish display copies under the native one-shot grant; positive output is not input/source settlement. */
    const publishPendingRerouteCopies = async (pending, record, ctx, assertExecutionCurrent, foreign) => {
        const source = resolvePendingRerouteForwardSource(pending);
        const target = { ...record.target };
        const recordIdentity = (value) => value && ({
            target: value.target, profileKey: value.profileKey, owner: value.owner,
            instanceId: value.instanceId, slot: value.slot, createdAtMs: value.createdAtMs,
        });
        const bindingIdentity = () => deps.threadStore.listWorkspaceBindings()
            .filter((value) => isDeepStrictEqual(value.target, target))
            .map((value) => ({ bindingKey: value.bindingKey, sessionId: value.sessionId, sessionKey: value.sessionKey,
            cwd: value.cwd, workspaceKey: value.workspaceKey, instanceSlot: value.instanceSlot, slot: value.slot,
            target: value.target }));
        const expectedRecord = structuredClone(recordIdentity(record));
        const expectedBindings = structuredClone(bindingIdentity());
        const ownership = deps.getTargetOwnership?.(target);
        if (!source || !deps.callApi || expectedBindings.length > 1 ||
            (foreign && (!ownership || ownership.instanceId !== record.instanceId ||
                !ownership.ownerGeneration || !ownership.recipientBindingKey)))
            return;
        const expectedOwnership = ownership && structuredClone(ownership);
        const cap = captureTemporaryThreadAuthority(ctx, () => {
            try {
                assertExecutionCurrent();
                const current = getBaleRoutableThreadRecords(deps.threadStore.list(), deps.getLiveThreadTargets?.())
                    .find((value) => isDeepStrictEqual(value.target, target));
                return isDeepStrictEqual(recordIdentity(current), expectedRecord) &&
                    isDeepStrictEqual(bindingIdentity(), expectedBindings) &&
                    (!foreign || Bus.isBaleBusForwardOwnershipCurrent(expectedOwnership, deps.getTargetOwnership?.(target)));
            }
            catch {
                return false;
            }
        });
        if (!cap?.isCurrent())
            return;
        const temporary = pending.temporaryThread ?? findCreatedTemporaryThread(pending.sourceTarget);
        if (!temporary || !issueTemporaryThreadForward(pending, ctx))
            return;
        pending.phase = { kind: "forward-unknown" };
        const assertRecipientCurrent = () => {
            assertExecutionCurrent();
            if (!cap.isCurrent())
                throw new Error("Reroute publication recipient authority changed.");
        };
        const assertPublicationCurrent = () => {
            assertRecipientCurrent();
            const entry = cap.store.listTemporaryThreads().find((value) => value.token === temporary.token);
            const ids = [...source.sourceUpdateIds].sort((a, b) => a - b);
            if (!entry || entry.phase !== "created" || entry.cleanupIssued ||
                entry.operatorUserId !== cap.operatorUserId ||
                !isDeepStrictEqual(entry.executor, cap.authority.executor) ||
                !isDeepStrictEqual(entry.target, pending.sourceTarget) ||
                !entry.forwardedInputs?.some((input) => input.journalBindingKey === cap.journalBindingKey &&
                    isDeepStrictEqual(input.updateIds, ids)) ||
                !isDeepStrictEqual(resolvePendingRerouteForwardSource(pending), source))
                throw new Error("Reroute publication source authority changed.");
        };
        try {
            assertPublicationCurrent();
            // Bot API requires ascending source IDs. Preserve the source-UID association even if copy IDs reorder them.
            const order = source.messageIds.map((_, index) => index)
                .sort((a, b) => source.messageIds[a] - source.messageIds[b]);
            const messageIds = order.map((index) => source.messageIds[index]);
            const body = { chat_id: target.chatId, message_thread_id: target.threadId,
                from_chat_id: source.chatId, disable_notification: true };
            const options = { maxAttempts: 1, retrySafety: "non-idempotent", assertAuthority: assertPublicationCurrent };
            const copies = messageIds.length === 1
                ? [await deps.callApi("forwardMessage", { ...body, message_id: messageIds[0] }, options)]
                : await deps.callApi("forwardMessages", { ...body, message_ids: messageIds }, options);
            assertPublicationCurrent();
            const copyIds = Array.isArray(copies) ? copies.map((copy) => copy?.message_id) : [];
            if (copyIds.length !== messageIds.length ||
                !copyIds.every((id) => typeof id === "number" && Number.isSafeInteger(id) && id > 0) ||
                new Set(copyIds).size !== copyIds.length)
                return;
            pending.rerouteCopies = { target, bySourceUpdateId: new Map(order.map((index, position) => [source.sourceUpdateIds[index], copyIds[position]])) };
            pending.phase = { kind: "selected" };
            return assertRecipientCurrent;
        }
        catch (error) {
            if (cap.isCurrent())
                deps.recordRuntimeEvent?.("routing", error, { phase: "reroute-destination-forward" });
            return;
        }
    };
    const forwardPendingRerouteMessages = async (pending, instanceId, threadId, ctx, assertExecutionCurrent, recordForwardAcceptance) => {
        assertExecutionCurrent?.();
        const forwardMessage = deps.foreignOwnedUpdateForwarder?.forwardMessage;
        if (!forwardMessage || pending.phase.kind === "forward-unknown")
            return false;
        const target = { ...pending.sourceTarget, threadId };
        const liveOwnership = deps.getTargetOwnership?.(target);
        if (!liveOwnership ||
            liveOwnership.instanceId !== instanceId ||
            !liveOwnership.ownerGeneration ||
            !liveOwnership.recipientBindingKey)
            return false;
        const ownership = structuredClone(liveOwnership);
        const copies = pending.rerouteCopies;
        const published = !!copies && isDeepStrictEqual(copies.target, target);
        const messages = cloneBaleMessagesForThread(pending.messages, threadId, published ? copies.bySourceUpdateId : undefined);
        // Issuance is durable before the RPC: an unacknowledged temporary-tab Forward never becomes another dispatch grant,
        // even after restart. Any refusal or publication failure sends nothing and keeps the input held.
        if (!recordForwardAcceptance &&
            isTemporaryReroute(pending) &&
            !published &&
            !issueTemporaryThreadForward(pending, ctx)) {
            if (isTemporaryThreadForwardIssued(pending))
                pending.phase = { kind: "forward-unknown" };
            return false;
        }
        if (!recordForwardAcceptance && isTemporaryReroute(pending))
            pending.phase = { kind: "forward-unknown" };
        const outcomes = await Promise.allSettled(messages.map((message) => forwardMessage({
            message,
            ownership,
            ctx,
            assertAuthority() {
                assertExecutionCurrent?.();
                Updates.assertBaleUpdateExecutionCurrent(message);
            },
        })));
        assertExecutionCurrent?.();
        if (!isDeepStrictEqual(deps.getTargetOwnership?.(target), ownership))
            return false;
        pending.messages = pending.messages.filter((_, index) => {
            const outcome = outcomes[index];
            if (outcome?.status === "fulfilled" &&
                outcome.value.status === "accepted") {
                // Restore publishes acceptance before reporting completion; cleanup still waits for journal disposition.
                const expectedSource = recordForwardAcceptance?.(pending.messages[index], outcome.value.delivery);
                assertExecutionCurrent?.();
                Updates.reportBaleUpdateCompleted(pending.messages[index], expectedSource);
                return false;
            }
            if (outcome?.status === "rejected") {
                deps.recordRuntimeEvent?.("bus", outcome.reason, {
                    phase: "reroute-foreign-forward",
                    instanceId,
                    threadId,
                    messageIndex: index,
                });
            }
            return true;
        });
        if (pending.messages.length === 0 &&
            pending.phase.kind === "forward-unknown")
            pending.phase = { kind: "selected" };
        return pending.messages.length === 0;
    };
    const temporaryCleanupTimers = new Map();
    const cancelTemporaryThreadCleanup = (token) => {
        const scheduled = temporaryCleanupTimers.get(token);
        if (!scheduled)
            return;
        clearTimeout(scheduled.timer);
        temporaryCleanupTimers.delete(token);
        scheduled.settle();
    };
    /**
     * One cleanup attempt after the quiet period. Cancellation facts are only a precondition: fresh authority, proof,
     * absence of chooser and journal custody, and the ordinary protection checks must all hold again. The attempt is
     * durably issued once; a skipped or unknown removal keeps the entry protecting the tab across restart.
     */
    const runTemporaryThreadCleanup = async (token, cap, reconcileExpiry) => {
        const store = cap.store;
        if ((!deps.inspectRestoreSourceAbandonment &&
            !deps.inspectRoutingInputGroupExpiry) ||
            !deps.runWorkspaceOperation ||
            !deps.callApi ||
            !cap.isCurrent())
            return;
        await deps.runWorkspaceOperation({
            operationId: `temporary-thread-cleanup-${randomBytes(16).toString("hex")}`,
            operationKind: "workspace.temporary-thread",
            scopes: [{ kind: "profile" }],
        }, async () => {
            if (!cap.isCurrent())
                return;
            let entry = store
                .listTemporaryThreads()
                .find((value) => value.token === token &&
                value.phase === "created" &&
                !!value.target);
            const target = entry?.target;
            if (!entry ||
                !target ||
                entry.cleanupIssued ||
                entry.operatorUserId !== cap.operatorUserId ||
                entry.source.journalBindingKey !== cap.journalBindingKey)
                return;
            const owner = `bale-owner:${cap.operatorUserId}`;
            if (reconcileExpiry && deps.inspectRoutingInputGroupExpiry) {
                for (const group of Threads.getBaleTemporaryThreadInputs(entry)) {
                    if ([
                        ...(entry.cancelledInputs ?? []),
                        ...(entry.completedInputs ?? []),
                    ].some((value) => isDeepStrictEqual(value, group)))
                        continue;
                    const inspect = (id) => deps.inspectRoutingInputGroupExpiry(group)?.find((value) => value.updateId === id);
                    if (!group.updateIds.every((id) => inspect(id)?.operatorAuthorityId === owner))
                        continue;
                    entry = cap.adopt(entry);
                    if (!entry || !cap.isCurrent())
                        return;
                    let recorded, failure;
                    try {
                        recorded = store.recordTemporaryThreadInputExpiry(entry, group, cap.authority, inspect);
                    }
                    catch (error) {
                        failure = error;
                    }
                    if (!cap.isCurrent())
                        return;
                    const retained = store
                        .listTemporaryThreads()
                        .find((value) => value.token === token);
                    // A lost publication ACK may already have recorded the group or retired a bound tab's temporary frame.
                    if (!retained)
                        return;
                    if (!recorded &&
                        !retained.cancelledInputs?.some((value) => isDeepStrictEqual(value, group)))
                        throw (failure ??
                            new Error("Chooser expiry metadata was not confirmed."));
                    entry = retained;
                }
            }
            if (!Threads.isBaleTemporaryThreadFullyResolved(entry) ||
                hasPendingRerouteForTarget(target))
                return;
            const cancelled = entry.cancelledInputs ?? [];
            const cancelledCurrent = () => cancelled.every((input) => {
                const expiry = deps.inspectRoutingInputGroupExpiry?.(input);
                return input.updateIds.every((updateId) => {
                    const evidence = deps.inspectRestoreSourceAbandonment?.(updateId, input.journalBindingKey) ?? expiry?.find((value) => value.updateId === updateId);
                    return (evidence?.journalBindingKey === input.journalBindingKey &&
                        evidence.updateId === updateId &&
                        evidence.operatorAuthorityId === owner);
                });
            });
            if (!cancelledCurrent())
                return;
            entry = cap.adopt(entry);
            if (!entry || !cap.isCurrent())
                return;
            if (isRerouteTargetProtected(target, undefined, entry) && deps.recoverTemporaryThreadDeadQueueOwners &&
                store.inspectTemporaryThreadTarget(entry, cap.authority)?.kind === "temporary") {
                const inputs = Threads.getBaleTemporaryThreadInputs(entry);
                const removed = deps.recoverTemporaryThreadDeadQueueOwners(target, [cap.journalBindingKey, ...inputs.map(input => input.journalBindingKey)], inputs, cap.isCurrent);
                if (removed > 0)
                    deps.recordRuntimeEvent?.("routing", "Discarded historical queue receipts from confirmed-dead owners before temporary Thread cleanup.", { phase: "temporary-thread-dead-owner-recovery", removedUpdateCount: removed });
            }
            // Recovery is not deletion authority: recapture every ordinary protection after the journal CAS.
            if (!cap.isCurrent() || isRerouteTargetProtected(target, undefined, entry))
                return;
            const issued = store.issueTemporaryThreadCleanup(entry, cap.authority);
            if (!issued || !cap.isCurrent())
                return;
            entry = issued.entry;
            const issuedEntry = entry;
            const assertCurrent = () => {
                if (!cap.isCurrent() ||
                    !cancelledCurrent() ||
                    !store.isTemporaryThreadCleanupCurrent(issuedEntry, cap.authority))
                    throw new Error("Temporary Thread cleanup authority or exact grant evidence changed.");
            };
            if (!(await closeReroutedUnboundTopic(target, undefined, assertCurrent, entry)) ||
                !cap.isCurrent())
                return;
            store.retireTemporaryThread(entry, cap.authority);
        });
    };
    // Reuse the one timer per tab for body-free metadata retries. Future retry timers do not join settlement waits;
    // only their running attempt does. No retry is licensed once a destructive grant may have been issued.
    const queueTemporaryThreadCleanup = (token, cap, delay, reconcileExpiry, retry = false) => {
        cancelTemporaryThreadCleanup(token);
        let settle = () => undefined;
        const task = new Promise((resolve) => {
            settle = resolve;
        });
        const timer = setTimeout(() => {
            if (temporaryCleanupTimers.get(token)?.timer !== timer)
                return;
            temporaryCleanupTimers.delete(token);
            if (retry)
                restoreSettlementTasks.add(task);
            runTemporaryThreadCleanup(token, cap, reconcileExpiry)
                .then(() => {
                if (!cap.isCurrent())
                    return;
                const retained = cap.store.listTemporaryThreads().find(value => value.token === token);
                // A follower ACK can precede recipient receipt disposal. Reobserve a protected, unissued tab;
                // elapsed time never grants deletion, and an issued/unknown delete can never enter this path.
                if (retained?.phase === "created" && !retained.cleanupIssued &&
                    Threads.isBaleTemporaryThreadFullyResolved(retained) &&
                    cap.store.inspectTemporaryThreadTarget(retained, cap.authority)?.kind === "temporary" && cap.isCurrent())
                    queueTemporaryThreadCleanup(token, cap, 1000, reconcileExpiry, true);
            })
                .catch((error) => {
                deps.recordRuntimeEvent?.("routing", error, {
                    phase: "temporary-thread-cleanup",
                });
                if (!reconcileExpiry || !cap.isCurrent())
                    return;
                try {
                    const retained = cap.store
                        .listTemporaryThreads()
                        .find((value) => value.token === token);
                    if (retained && !retained.cleanupIssued && cap.isCurrent())
                        queueTemporaryThreadCleanup(token, cap, 60_000, true, true);
                }
                catch {
                    /* Unknown grant state never licenses a retry. */
                }
            })
                .finally(settle);
        }, delay);
        timer.unref?.();
        temporaryCleanupTimers.set(token, { timer, settle });
        if (!retry)
            restoreSettlementTasks.add(task);
        void task.finally(() => restoreSettlementTasks.delete(task));
    };
    /** Starts the quiet period for resolved groups or body-free expiry reconciliation; fresh input/authority revokes it. */
    const scheduleTemporaryThreadCleanup = (target, ctx, reconcileExpiry = false) => {
        const cap = captureTemporaryThreadAuthority(ctx);
        if (!cap ||
            !deps.runWorkspaceOperation ||
            target.threadId === undefined ||
            hasPendingRerouteForTarget(target))
            return;
        let entry;
        try {
            entry = cap.store
                .listTemporaryThreads()
                .find((value) => value.phase === "created" &&
                isDeepStrictEqual(value.target, target));
        }
        catch (error) {
            deps.recordRuntimeEvent?.("routing", error, {
                phase: "temporary-thread-cleanup-schedule",
            });
            return;
        }
        if (!entry ||
            entry.cleanupIssued ||
            entry.operatorUserId !== cap.operatorUserId ||
            entry.source.journalBindingKey !== cap.journalBindingKey)
            return;
        if (!reconcileExpiry &&
            !Threads.isBaleTemporaryThreadFullyResolved(entry)) {
            try {
                reconcileExpiry = Threads.getBaleTemporaryThreadInputs(entry).some((group) => !!deps.inspectRoutingInputGroupExpiry?.(group));
            }
            catch (error) {
                deps.recordRuntimeEvent?.("routing", error, {
                    phase: "temporary-thread-cleanup-schedule",
                });
                return;
            }
        }
        if (!reconcileExpiry &&
            !Threads.isBaleTemporaryThreadFullyResolved(entry))
            return;
        // No grace by default: the attempt still queues behind the Cancel's own Workspace operation, so the notice lands first.
        const requested = deps.temporaryThreadCleanupDelayMs;
        const delay = typeof requested === "number" && Number.isFinite(requested)
            ? Math.max(0, requested)
            : 0;
        queueTemporaryThreadCleanup(entry.token, cap, delay, reconcileExpiry);
    };
    const recordCancelledTemporaryThreadInput = (pending, ctx, isCurrent) => {
        const store = deps.getWorkspaceRestoreStore?.(), target = pending.sourceTarget;
        if (!store || target.threadId === undefined)
            return !pending.temporaryThread;
        let entry = store
            .listTemporaryThreads()
            .find((value) => value.phase === "created" && isDeepStrictEqual(value.target, target));
        if (!entry)
            return !pending.temporaryThread;
        const cap = captureTemporaryThreadAuthority(ctx, isCurrent), inspect = deps.inspectRestoreSourceAbandonment;
        if (!cap ||
            !inspect ||
            cap.operatorUserId !== entry.operatorUserId ||
            cap.journalBindingKey !== entry.source.journalBindingKey)
            return false;
        const { operatorUserId, journalBindingKey } = cap, current = cap.isCurrent;
        const input = {
            journalBindingKey,
            updateIds: Updates.collectBaleAdmissionSourceUpdateIds(pending.messages),
        };
        if (!current())
            return false;
        entry = cap.adopt(entry);
        if (!entry || !current())
            return false;
        const recorded = store.recordTemporaryThreadInputCancellation(entry, input, cap.authority, (updateId) => inspect(updateId, journalBindingKey));
        if (!recorded ||
            !current() ||
            !recorded.cancelledInputs?.some((value) => isDeepStrictEqual(value, input)))
            return false;
        const observed = store
            .listTemporaryThreads()
            .find((value) => isDeepStrictEqual(value, recorded));
        return (!!observed &&
            input.updateIds.every((updateId) => {
                const evidence = inspect(updateId, journalBindingKey);
                return (evidence?.journalBindingKey === journalBindingKey &&
                    evidence.updateId === updateId &&
                    evidence.operatorAuthorityId === `bale-owner:${operatorUserId}`);
            }) &&
            current());
    };
    /** Every source of the chooser has a private retention receipt. */
    const isPendingRerouteCancelled = (pending) => {
        const results = pending.abandonment?.sourceResults;
        return (!!results &&
            pending.messages.length > 0 &&
            pending.messages.every((source) => {
                const [updateId] = Updates.collectBaleAdmissionSourceUpdateIds([
                    source,
                ]);
                return updateId !== undefined && results.has(updateId);
            }));
    };
    /**
     * Retains every source of one chooser privately, exactly once each. False means a source cannot be abandoned
     * now; sources already retained keep their receipts, so a retry finishes only the remainder.
     */
    const abandonPendingRerouteSources = (pending, operatorUserId, isCurrent) => {
        const results = (pending.abandonment.sourceResults ??= new Map());
        for (const source of pending.messages) {
            const [updateId] = Updates.collectBaleAdmissionSourceUpdateIds([
                source,
            ]);
            if (updateId === undefined)
                return false;
            if (results.has(updateId))
                continue;
            const result = Updates.abandonBaleDeferredUpdate(source, {
                operatorAuthorityId: `bale-owner:${operatorUserId}`,
                isCurrent,
            });
            if (!result)
                return false;
            results.set(updateId, result);
        }
        return isPendingRerouteCancelled(pending);
    };
    /** Review recovery retains one source; its chooser completes only after every source is retained. */
    const recordRecoveredRerouteSource = (pending, updateId, result) => {
        const cancellation = pending.abandonment;
        (cancellation.sourceResults ??= new Map()).set(updateId, result);
        cancellation.attempted = true;
        return isPendingRerouteCancelled(pending);
    };
    const retireCancellationChooser = async (id, pending, isCurrent) => {
        if (!isPendingRerouteCancelled(pending) ||
            !isCurrent() ||
            (!deps.deleteMessage && !deps.editInteractiveMessage) ||
            pending.chooserMessageId === undefined)
            return false;
        await retireRerouteChooserMessage(pending.sourceTarget.chatId, pending.chooserMessageId, "<b>⛔️ Routing cancelled.</b>");
        if (!isCurrent() || pendingUnboundReroutes.get(id) !== pending)
            return false;
        removePendingReroute(id);
        return true;
    };
    /** Historical holds stay text-only; cancellation review accepts any owner input outside the business namespace. */
    const isReviewText = (message, anyKind = false) => {
        if (!message ||
            message.chat?.type !== "private" ||
            !Number.isSafeInteger(message.chat.id) ||
            !Number.isSafeInteger(message.from?.id) ||
            message.from?.is_bot !== false ||
            !Number.isSafeInteger(message.message_id) ||
            message.message_id <= 0 ||
            !Number.isSafeInteger(message.message_thread_id) ||
            message.message_thread_id <= 0)
            return false;
        if (anyKind)
            return (message.business_connection_id ===
                undefined);
        if (typeof message.text !== "string" ||
            !message.text.trim() ||
            message.text.trim().startsWith("/"))
            return false;
        const fields = message;
        return [
            "media_group_id",
            "business_connection_id",
            "photo",
            "video",
            "audio",
            "voice",
            "document",
            "animation",
            "sticker",
            "contact",
            "location",
            "venue",
            "poll",
            "dice",
            "story",
        ].every((key) => fields[key] === undefined);
    };
    const reviewMessage = (entry, anyKind = false) => {
        const message = entry.update.message;
        if (entry.state !== "pending" ||
            entry.preApprovalExcluded ||
            entry.inputClaim ||
            entry.inputProvenance ||
            entry.queueOwner ||
            entry.queueReceiptId ||
            entry.queueHandoff ||
            entry.failure ||
            Object.keys(entry.update).some((key) => key !== "update_id" && key !== "message") ||
            !isReviewText(message, anyKind) ||
            Reflect.has(message, "pi_bale_source_update_id"))
            return undefined;
        return message;
    };
    const needsHistoricalReview = (message) => {
        if (!deps.threadStore)
            throw new Error("Historical routing requires a current Thread snapshot.");
        if (deps.threadStore.getBotState().threadMode === "disabled")
            return true;
        return !getBaleRoutableThreadRecords(deps.threadStore.list(), deps.getLiveThreadTargets?.()).some((record) => record.target.chatId === message.chat.id &&
            record.target.threadId === message.message_thread_id);
    };
    /** New-world restart: forget previous-instance Restore/temporary state, then one silent delete per positively disposable tab. */
    const forgetPreviousWorld = async (input, captureTransport) => {
        const result = { forgotten: 0, deleted: 0 };
        const { ctx, signal, journalBindingKey, isCurrent: preparedCurrent, } = input;
        const transport = captureTransport ? captureTransport(ctx) : () => true;
        const cap = transport &&
            captureTemporaryThreadAuthority(ctx, () => !signal.aborted &&
                preparedCurrent() &&
                transport() &&
                deps.hasWorkspaceRestoreAuthority?.() === true);
        const threads = deps.threadStore;
        if (!cap?.isCurrent() ||
            cap.journalBindingKey !== journalBindingKey ||
            !threads ||
            !deps.runWorkspaceOperation)
            return result;
        try {
            await deps.runWorkspaceOperation({
                operationId: `new-world-${randomBytes(16).toString("hex")}`,
                operationKind: "workspace.forget-previous-world",
                scopes: [{ kind: "profile" }],
            }, async () => {
                if (!cap.isCurrent())
                    return;
                await threads.load();
                if (!cap.isCurrent())
                    return;
                const self = cap.authority.executor.instanceId;
                const entries = cap.store.listTemporaryThreads();
                const preserved = entries
                    .filter((entry) => entry.operatorUserId === cap.operatorUserId &&
                    entry.phase === "created" &&
                    cap.store.inspectTemporaryThreadTarget(entry, cap.authority)
                        ?.kind === "temporary" &&
                    Threads.getBaleTemporaryThreadInputs(entry).some((source) => source.journalBindingKey === journalBindingKey &&
                        source.updateIds.some((id) => input.routingSourceIds?.includes(id))))
                    .map((entry) => entry.token);
                const disposable = entries.flatMap((entry) => entry.operatorUserId === cap.operatorUserId &&
                    !preserved.includes(entry.token) &&
                    entry.executor.instanceId !== self &&
                    entry.phase === "created" &&
                    entry.target &&
                    cap.store.inspectTemporaryThreadTarget(entry, cap.authority)
                        ?.kind === "temporary"
                    ? [entry]
                    : []);
                const forgotten = cap.store.forgetPreviousWorld(cap.authority, preserved);
                if (!forgotten)
                    return;
                result.forgotten =
                    forgotten.operations.length + forgotten.temporaryThreads.length;
                for (const entry of disposable) {
                    const target = entry.target;
                    if (!cap.isCurrent() || !deps.callApi)
                        break;
                    await threads.load();
                    const same = (value) => value?.chatId === target.chatId &&
                        value.threadId === target.threadId;
                    if (!cap.isCurrent() ||
                        threads
                            .listWorkspaceBindings()
                            .some((value) => same(value.target)) ||
                        threads
                            .list()
                            .some((record) => record.status === "active" && same(record.target)) ||
                        cap.store
                            .listTemporaryThreads()
                            .some((entry) => same(entry.target)) ||
                        cap.store
                            .list()
                            .some(({ request }) => same(request.target) || same(request.binding.target)))
                        continue;
                    try {
                        const required = [
                            ...new Set([
                                cap.journalBindingKey,
                                entry.source.journalBindingKey,
                                ...Threads.getBaleTemporaryThreadInputs(entry).map((input) => input.journalBindingKey),
                            ]),
                        ];
                        if (deps.inspectTemporaryThreadSources?.(target, required, Threads.getBaleTemporaryThreadInputs(entry))?.length !== 0 ||
                            !cap.isCurrent())
                            continue;
                        // Exactly one attempt; the entry is already forgotten, so failure or silence leaves the tab without retry.
                        if ((await deps.callApi("deleteForumTopic", {
                            chat_id: target.chatId,
                            message_thread_id: target.threadId,
                        }, { maxAttempts: 1, retrySafety: "non-idempotent" })) === true)
                            result.deleted++;
                    }
                    catch (error) {
                        deps.recordRuntimeEvent?.("routing", error, {
                            phase: "new-world-tab-delete",
                        });
                    }
                }
                // Same-instance session replacement may have lost a metadata-only timer after the source was already spent.
                // Reconstruct from retained tab/source proof under fresh authority, never from a prompt body or an issued delete.
                for (const entry of cap.store.listTemporaryThreads()) {
                    if (!cap.isCurrent())
                        break;
                    if (entry.phase !== "created" ||
                        !entry.target ||
                        entry.cleanupIssued ||
                        entry.operatorUserId !== cap.operatorUserId ||
                        entry.source.journalBindingKey !== journalBindingKey)
                        continue;
                    if (Threads.getBaleTemporaryThreadInputs(entry).some((group) => !!deps.inspectRoutingInputGroupExpiry?.(group)))
                        scheduleTemporaryThreadCleanup(entry.target, ctx, true);
                }
            });
        }
        catch (error) {
            deps.recordRuntimeEvent?.("routing", error, {
                phase: "new-world-forget",
            });
        }
        return result;
    };
    /** Historical temporary sources await the cold policy; warm bound/unknown sources never fall into ordinary dispatch. */
    const isRecordedTemporaryThreadInputHeld = (entry, ctx, signal, historical = false) => {
        const store = deps.getWorkspaceRestoreStore?.(), binding = deps.getAdmissionJournalBinding?.();
        if (!store || !binding)
            return false;
        const members = store
            .listTemporaryThreads()
            .filter((temporary) => Threads.getBaleTemporaryThreadInputs(temporary).some((input) => input.journalBindingKey === binding &&
            input.updateIds.includes(entry.updateId)));
        const cap = captureTemporaryThreadAuthority(ctx, () => !signal.aborted);
        return members.some((temporary) => {
            if (!cap?.isCurrent())
                return true;
            const observation = store.inspectTemporaryThreadTarget(temporary, cap.authority);
            return historical || !observation || observation.kind !== "temporary";
        });
    };
    const shouldHoldPendingInput = async (entry, ctx, signal) => {
        const binding = deps.getAdmissionJournalBinding?.();
        const current = () => !signal.aborted &&
            deps.isContextActive?.(ctx) === true &&
            deps.getAdmissionJournalBinding?.() === binding;
        if (!current())
            throw new Error("Temporary Thread source generation ended.");
        const held = isRecordedTemporaryThreadInputHeld(entry, ctx, signal);
        if (!current())
            throw new Error("Temporary Thread source authority changed.");
        return held;
    };
    /**
     * A restarted owner revives a chooser only when its saved clock proves nothing was selected, its tab is still
     * unbound and live threads exist to choose from; anything else keeps the protective startup hold.
     */
    const canReviveRoutingChooser = async (entry, message, ctx, signal) => {
        const lifetime = entry.routingInput, chooser = lifetime?.chooser, operator = deps.configStore.getAllowedUserId();
        if (!Updates.isRevivableBaleRoutingInput(entry, Date.now()) ||
            !chooser ||
            !deps.threadStore ||
            operator === undefined ||
            lifetime.operatorUserId !== operator ||
            message?.chat?.type !== "private" ||
            message.chat.id !== chooser.chatId ||
            message.from?.id !== operator ||
            message.from.is_bot !== false ||
            Object.keys(entry.update).some((key) => key !== "update_id" && key !== "message"))
            return false;
        const epoch = deps.getCurrentLeaderEpoch?.(), binding = deps.getAdmissionJournalBinding?.();
        const current = () => !signal.aborted &&
            deps.isContextActive?.(ctx) === true &&
            epoch !== undefined &&
            deps.getCurrentLeaderEpoch?.() === epoch &&
            !!binding &&
            deps.getAdmissionJournalBinding?.() === binding;
        if (!current())
            return false;
        await deps.threadStore.load();
        if (!current())
            return false;
        const routable = getBaleRoutableThreadRecords(deps.threadStore.list(), deps.getLiveThreadTargets?.());
        const at = (target) => target?.chatId === chooser.chatId && target.threadId === chooser.threadId;
        return (routable.length > 0 &&
            (chooser.threadId === undefined ||
                (!routable.some((record) => at(record.target)) &&
                    !deps.threadStore
                        .listWorkspaceBindings()
                        .some((binding) => at(binding.target)))));
    };
    const shouldReviewHistoricalInput = async (entry, ctx, signal) => {
        if (signal.aborted)
            throw new Error("Historical routing generation ended.");
        const message = entry.update.message;
        if (await canReviveRoutingChooser(entry, message, ctx, signal))
            return "revive";
        const unsupported = !reviewMessage(entry);
        const retainable = unsupported &&
            entry.state === "pending" &&
            !entry.preApprovalExcluded &&
            !entry.inputClaim &&
            !entry.inputProvenance &&
            !entry.queueOwner &&
            !entry.queueReceiptId &&
            !entry.queueHandoff &&
            !entry.failure &&
            Object.keys(entry.update).every((key) => key === "update_id" || key === "message") &&
            message?.chat?.type === "private" &&
            Number.isSafeInteger(message.chat.id) &&
            Number.isSafeInteger(message.from?.id) &&
            message.from?.is_bot === false &&
            Number.isSafeInteger(message.message_id) &&
            message.message_id > 0 &&
            Number.isSafeInteger(message.message_thread_id) &&
            message.message_thread_id > 0 &&
            !Reflect.has(message, "pi_bale_source_update_id") &&
            !Reflect.has(message, "business_connection_id");
        const temporary = isRecordedTemporaryThreadInputHeld(entry, ctx, signal, true);
        if (!retainable && temporary)
            return true;
        if (!retainable && unsupported)
            return false;
        if (signal.aborted)
            throw new Error("Historical routing generation ended.");
        const epoch = deps.getCurrentLeaderEpoch?.();
        const binding = deps.getAdmissionJournalBinding?.();
        const current = () => !signal.aborted &&
            deps.isContextActive?.(ctx) === true &&
            epoch !== undefined &&
            deps.getCurrentLeaderEpoch?.() === epoch &&
            !!binding &&
            deps.getAdmissionJournalBinding?.() === binding;
        if (!current() || !deps.threadStore)
            throw new Error("Historical routing authority is unavailable.");
        await deps.threadStore.load();
        if (!current())
            throw new Error("Historical routing authority changed.");
        // Raw unsupported startup originals stay protected even when a bound target outlives forgotten Restore membership.
        // Holding protects evidence, not sender authorization; owner-bearing sources keep their existing paths.
        return retainable ? "retain" : needsHistoricalReview(message);
    };
    const recoveryPreview = (source, owner, chatId, binding) => {
        const entry = source.original;
        const message = reviewMessage(entry, true);
        if (!message || message.chat.id !== chatId || message.from.id !== owner)
            return undefined;
        for (const pending of pendingUnboundReroutes.values()) {
            if (pending.abandonment?.journalBindingKey === binding &&
                Updates.collectBaleAdmissionSourceUpdateIds(pending.messages).includes(entry.updateId) &&
                // Revoked carriers describe a past attempt, not a live selection veto.
                // Current claim/entry authority still comes from the worker and journal CAS.
                pending.messages.some((value) => Updates.getBaleUpdateExecutionFence(value)?.signal.aborted !==
                    true) &&
                (!isPendingRerouteUntouched(pending) || pending.abandonment.running))
                return undefined;
        }
        return formatBaleRoutingInputPreview(message);
    };
    const expireRoutingInput = async (source, ctx, signal) => {
        const operator = deps.configStore.getAllowedUserId(), epoch = deps.getCurrentLeaderEpoch?.(), generation = deps.getSessionGeneration?.(), instanceId = deps.getCurrentInstanceId?.(), scope = deps.getAdmissionScope?.();
        const sendTextReply = deps.sendTextReply, editInteractiveMessage = deps.editInteractiveMessage;
        const message = source.original.update.message;
        const runtimeCurrent = () => !signal.aborted &&
            operator !== undefined &&
            epoch !== undefined &&
            deps.isContextActive?.(ctx) === true &&
            deps.configStore.getAllowedUserId() === operator &&
            deps.getCurrentLeaderEpoch?.() === epoch &&
            deps.getSessionGeneration?.() === generation &&
            deps.getCurrentInstanceId?.() === instanceId &&
            deps.getAdmissionScope?.() === scope &&
            deps.getAdmissionJournalBinding?.() === source.journalBindingKey &&
            source.original.routingInput?.operatorUserId === operator &&
            message?.from?.id === operator &&
            message.from.is_bot !== true &&
            message.chat?.type === "private";
        const current = () => runtimeCurrent() && source.isCurrent();
        if (!current() || !deps.runWorkspaceOperation)
            return;
        await deps.runWorkspaceOperation({
            operationId: `routing-expiry-${randomBytes(16).toString("hex")}`,
            operationKind: "workspace.expire-unbound-routing",
            scopes: [{ kind: "profile" }],
        }, async () => {
            if (!current())
                return;
            const restores = deps.getWorkspaceRestoreStore?.();
            if (deps.getWorkspaceRestoreStore && !restores)
                return;
            const temporary = restores
                ?.listTemporaryThreads()
                .find((entry) => Threads.getBaleTemporaryThreadInputs(entry).some((input) => input.journalBindingKey === source.journalBindingKey &&
                input.updateIds.includes(source.original.updateId)));
            const result = source.expire();
            if (!result)
                return;
            // Expiry revokes the donor carrier; old controls and late ACKs cannot issue another delivery. No body is archived.
            let movedIntoTab = false;
            let unissued = source.original.routingInput?.phase === "waiting" &&
                (!temporary || temporary.forwardProtocol === "one-shot-v1") &&
                ![...(temporary?.forwardedInputs ?? []), ...(temporary?.completedInputs ?? [])].some(input => input.journalBindingKey === source.journalBindingKey && input.updateIds.includes(source.original.updateId));
            const views = new Map();
            const chooser = source.original.routingInput?.chooser;
            if (chooser)
                views.set(`${chooser.chatId}:${chooser.messageId}`, { ...chooser });
            for (const [id, pending] of pendingUnboundReroutes) {
                if (!Updates.collectBaleAdmissionSourceUpdateIds(pending.messages).includes(source.original.updateId))
                    continue;
                movedIntoTab ||= pending.allTabCopiesForwarded !== undefined;
                unissued &&= isPendingRerouteUntouched(pending) || pending.phase.kind === "released";
                if (pending.chooserMessageId !== undefined)
                    views.set(`${pending.sourceTarget.chatId}:${pending.chooserMessageId}`, {
                        ...pending.sourceTarget, messageId: pending.chooserMessageId,
                    });
                removePendingReroute(id);
            }
            const notice = unissued
                ? "<b>⌛ Routing expired; input was not delivered.</b>"
                : "<b>⌛ Routing expired; delivery is unconfirmed.</b>\nPreviously accepted work may continue.";
            const noticeKey = `${source.journalBindingKey}:${source.original.routingInput?.expiresAtMs}:${chooser ? `${chooser.chatId}:${chooser.messageId}` : source.original.updateId}`;
            if (runtimeCurrent() && !expiredRoutingViews.has(noticeKey)) {
                if (expiredRoutingViews.size >= 100)
                    expiredRoutingViews.delete(expiredRoutingViews.values().next().value);
                expiredRoutingViews.add(noticeKey);
                let visible = false;
                const assertNoticeAuthority = () => {
                    if (!runtimeCurrent())
                        throw new Error("Routing expiry notice authority changed.");
                };
                for (const view of views.values()) {
                    if (!runtimeCurrent() || !editInteractiveMessage || deps.editInteractiveMessage !== editInteractiveMessage)
                        break;
                    if (view.chatId !== message.chat.id || !Number.isSafeInteger(view.threadId) || view.threadId <= 0)
                        continue;
                    try {
                        await editInteractiveMessage(view.chatId, view.messageId, notice, "html", { inline_keyboard: [] }, {
                            target: { chatId: view.chatId, threadId: view.threadId }, assertAuthority: assertNoticeAuthority,
                        });
                        visible = true;
                    }
                    catch (error) {
                        deps.recordRuntimeEvent?.("routing", error, { phase: "routing-input-expiry-view" });
                    }
                }
                // A temporary tab is about to disappear; a cold/missing chooser also needs an independent owned destination.
                const leader = instanceId ? deps.threadStore?.getActiveByInstanceId(instanceId) : undefined;
                if ((!visible || temporary?.target) && runtimeCurrent() && leader &&
                    leader.target.chatId === message.chat.id && Number.isSafeInteger(leader.target.threadId) && leader.target.threadId > 0) {
                    const target = { chatId: leader.target.chatId, threadId: leader.target.threadId };
                    try {
                        const assertFallback = () => {
                            assertNoticeAuthority();
                            const active = deps.threadStore?.getActiveByInstanceId(instanceId);
                            if (deps.sendTextReply !== sendTextReply || active?.target.chatId !== target.chatId || active.target.threadId !== target.threadId)
                                throw new Error("Routing expiry notice destination changed.");
                        };
                        assertFallback();
                        await sendTextReply(target.chatId, 0, notice, { parseMode: "HTML", target, assertAuthority: assertFallback });
                    }
                    catch (error) {
                        deps.recordRuntimeEvent?.("routing", error, { phase: "routing-input-expiry-notice" });
                    }
                }
                else if (!visible && runtimeCurrent()) {
                    deps.recordRuntimeEvent?.("routing", "Routing expiry notice has no current owned Thread.", { phase: "routing-input-expiry-notice-unavailable" });
                }
            }
            // The scheduled stage captures only context/epoch and a tab token. It reconstructs disposition from body-free proof,
            // never closes over this source or asks the worker to retain a terminal prompt while metadata publication fails.
            if (temporary?.target && runtimeCurrent()) {
                scheduleTemporaryThreadCleanup(temporary.target, ctx, true);
                // A moved original already left All with its forward; only an unmoved one is deleted here.
                if (!movedIntoTab)
                    await deleteAllTabMessages(temporary.target.chatId, getBaleAllTabSourceMessageIds([message], temporary.target.chatId));
            }
        });
    };
    const renderCancellationReview = async (view, isCurrent) => {
        if (!isCurrent())
            return;
        const data = (action) => `${BALE_PENDING_CANCELLATION_REVIEW_PREFIX}${view.id}:${action}`;
        const rows = [
            [{ text: "⬆️ Main menu", callback_data: "menu:back" }],
        ];
        const lines = [
            "<b>☑️ Review pending cancellations:</b>",
            "",
            "Finish stopping routing retries to retain the original privately. No new delivery is started; previously accepted work may continue. No Bale message or Thread is deleted.",
        ];
        if (!view.sources.length)
            lines.push("", "No supported pending cancellations on this page.");
        for (const [index, source] of view.sources.entries()) {
            lines.push("", `<b>${index + 1}. ${source.result ? "⛔️ Routing cancelled." : "Protected input"}</b>`, source.preview);
            if (!source.result)
                rows.push([
                    {
                        text: `❌ Finish cancellation ${index + 1}`,
                        callback_data: data(`retry:${index}`),
                    },
                ]);
        }
        if (view.unsupported)
            lines.push("", "Other protected inputs are not available in this view and remain untouched.");
        if (view.nextAfterUpdateId !== undefined)
            rows.push([{ text: "🟣 More", callback_data: data("more") }]);
        rows.push([{ text: "🔄 Refresh", callback_data: data("refresh") }]);
        await deps.editInteractiveMessage(view.target.chatId, view.messageId, lines.join("\n"), "html", { inline_keyboard: rows });
    };
    const handleCancellationReview = async (query, ctx) => {
        const matches = (view) => query.message?.message_id === view.messageId &&
            query.message.chat.id === view.target.chatId &&
            (query.message.message_thread_id === undefined ||
                query.message.message_thread_id === view.target.threadId);
        if (query.data?.startsWith(BALE_RETIRED_HISTORICAL_REVIEW_PREFIX)) {
            await deps.answerCallbackQuery(query.id, "This control is no longer available");
            return true;
        }
        const ownsReview = query.data?.startsWith(BALE_PENDING_CANCELLATION_REVIEW_PREFIX) ===
            true;
        const prefix = BALE_PENDING_CANCELLATION_REVIEW_PREFIX;
        if (!ownsReview && cancellationReview && matches(cancellationReview)) {
            if (cancellationReview.running && cancellationReview.isCurrent()) {
                await deps.answerCallbackQuery(query.id, "Cancellation is in progress");
                return true;
            }
            cancellationReview = undefined;
            return false;
        }
        if (!ownsReview)
            return false;
        const unavailable = async () => {
            await deps.answerCallbackQuery(query.id, "Cancellation review expired or unavailable. Open Status again");
            return true;
        };
        const execution = Updates.getBaleUpdateExecutionFence(query);
        const chatId = query.message?.chat.id;
        const messageId = query.message?.message_id;
        if (execution?.isCurrent() !== true ||
            deps.isContextActive?.(ctx) !== true ||
            !deps.editInteractiveMessage ||
            !deps.runWorkspaceOperation ||
            query.message?.chat.type !== "private" ||
            typeof chatId !== "number" ||
            !Number.isSafeInteger(chatId) ||
            typeof messageId !== "number" ||
            !Number.isSafeInteger(messageId) ||
            messageId <= 0)
            return unavailable();
        const owner = deps.configStore.getAllowedUserId();
        const journalBindingKey = deps.getAdmissionJournalBinding?.();
        const epoch = deps.getCurrentLeaderEpoch?.();
        if (owner === undefined ||
            query.from.id !== owner ||
            query.from.is_bot ||
            !journalBindingKey ||
            epoch === undefined)
            return unavailable();
        const current = () => execution.isCurrent() &&
            deps.isContextActive?.(ctx) === true &&
            deps.configStore.getAllowedUserId() === owner &&
            deps.getAdmissionJournalBinding?.() === journalBindingKey &&
            deps.getCurrentLeaderEpoch?.() === epoch;
        const parsed = query
            .data.slice(prefix.length)
            .match(/^([a-z0-9]+):(retry:(\d+)|refresh|more)$/);
        const prior = cancellationReview;
        const open = query.data === `${prefix}open`;
        if (!open &&
            (!parsed ||
                !prior ||
                parsed[1] !== prior.id ||
                !matches(prior) ||
                !prior.isCurrent()))
            return unavailable();
        if (prior?.running && prior.isCurrent()) {
            await deps.answerCallbackQuery(query.id, "Cancellation is in progress");
            return true;
        }
        let view = prior;
        let selected;
        try {
            if (open || parsed?.[2] === "refresh" || parsed?.[2] === "more") {
                if (parsed?.[2] === "more" && prior?.nextAfterUpdateId === undefined)
                    return unavailable();
                const next = {
                    id: randomBytes(16).toString("hex"),
                    target: {
                        chatId,
                        ...(query.message.message_thread_id !== undefined
                            ? { threadId: query.message.message_thread_id }
                            : {}),
                    },
                    messageId,
                    ownerUserId: owner,
                    journalBindingKey,
                    sources: [],
                    unsupported: false,
                    isCurrent: () => cancellationReview === next && current(),
                };
                cancellationReview = view = next;
                const page = Updates.inspectBaleAbandoningUpdates(query, {
                    journalBindingKey,
                    isCurrent: next.isCurrent,
                    ...(parsed?.[2] === "more"
                        ? { afterUpdateId: prior.nextAfterUpdateId }
                        : {}),
                });
                if (!page) {
                    if (cancellationReview === next)
                        cancellationReview = undefined;
                    return unavailable();
                }
                for (const source of page.sources) {
                    const preview = recoveryPreview(source, owner, next.target.chatId, journalBindingKey);
                    if (preview === undefined) {
                        next.unsupported = true;
                        continue;
                    }
                    if (next.sources.length === 5) {
                        next.nextAfterUpdateId = next.sources.at(-1).original.updateId;
                        break;
                    }
                    next.sources.push({ ...source, preview });
                }
                next.nextAfterUpdateId ??= page.nextAfterUpdateId;
                next.running = true;
                await renderCancellationReview(next, next.isCurrent);
                if (next.isCurrent())
                    await deps.answerCallbackQuery(query.id);
            }
            else {
                if (!view || !parsed?.[3] || !parsed[2].startsWith("retry:"))
                    return unavailable();
                selected = view.sources[Number(parsed[3])];
                if (!selected)
                    return unavailable();
                const activeView = view;
                const source = selected;
                const isCurrent = () => current() &&
                    activeView.isCurrent() &&
                    recoveryPreview(source, owner, activeView.target.chatId, journalBindingKey) !== undefined;
                view.running = true;
                await deps.runWorkspaceOperation({
                    operationId: `workspace-cancellation-recovery:${query.id}`,
                    operationKind: "workspace.recover-unbound-cancellation",
                    scopes: [{ kind: "profile" }],
                }, async () => {
                    if (!isCurrent())
                        return;
                    source.result ??= source.retry({
                        operatorAuthorityId: `bale-owner:${owner}`,
                        isCurrent,
                    });
                    if (!source.result) {
                        await unavailable();
                        return;
                    }
                    for (const [id, pending] of pendingUnboundReroutes) {
                        if (pending.abandonment?.ownerUserId !== owner ||
                            pending.abandonment.journalBindingKey !== journalBindingKey ||
                            !Updates.collectBaleAdmissionSourceUpdateIds(pending.messages).includes(source.original.updateId))
                            continue;
                        if (!recordRecoveredRerouteSource(pending, source.original.updateId, source.result))
                            continue;
                        try {
                            if (await retireCancellationChooser(id, pending, isCurrent))
                                await deleteCancelledOrphanTab(pending, pending.abandonment, isCurrent);
                        }
                        catch (error) {
                            deps.recordRuntimeEvent?.("routing", error, {
                                phase: "recovered-chooser-cleanup",
                            });
                        }
                    }
                    await renderCancellationReview(activeView, isCurrent);
                    if (isCurrent())
                        await deps.answerCallbackQuery(query.id, "Routing cancelled");
                });
            }
        }
        catch (error) {
            deps.recordRuntimeEvent?.("routing", error, {
                phase: "unbound-cancellation-recovery",
            });
            if (current())
                await deps.answerCallbackQuery(query.id, selected?.result
                    ? "Routing cancelled; view update failed. Retry the same button"
                    : "Recovery incomplete; inputs stay protected. Check /bale-status --debug");
        }
        finally {
            if (view)
                view.running = false;
        }
        return true;
    };
    /**
     * A cancelled input in an unbound (non-temporary) tab leaves nothing to route: once no chooser, queue, live owner,
     * Workspace/Restore record or retained journal arrival still names the tab, it is deleted like a routing tab. Any
     * missing proof or failure keeps the tab; this never retries and never blocks the Cancel outcome.
     */
    const deleteCancelledOrphanTab = async (pending, cancellation, isAuthorityCurrent) => {
        const { chatId, threadId } = pending.sourceTarget;
        if (threadId === undefined ||
            pending.temporaryThread ||
            isTemporaryTabTarget({ chatId, threadId }) ||
            hasPendingRerouteForTarget({ chatId, threadId }) ||
            !deps.inspectTemporaryThreadSources)
            return;
        const target = { chatId, threadId };
        try {
            const own = {
                journalBindingKey: cancellation.journalBindingKey,
                updateIds: Updates.collectBaleAdmissionSourceUpdateIds(pending.messages),
            };
            const assertCurrent = () => {
                if (!isAuthorityCurrent())
                    throw new Error("Unbound tab cleanup authority changed.");
            };
            assertCurrent();
            if (deps.inspectTemporaryThreadSources(target, [cancellation.journalBindingKey], [own])?.length !== 0)
                return;
            assertCurrent();
            await closeReroutedUnboundTopic(target, pending.chooserMessageId, assertCurrent);
        }
        catch (error) {
            deps.recordRuntimeEvent?.("routing", error, {
                phase: "unbound-cancel-tab-cleanup",
                chatId: target.chatId,
                threadId: target.threadId,
            });
        }
    };
    const handleUnboundRerouteCancelCallback = async (query, ctx) => {
        if (!query.data?.startsWith(BALE_UNBOUND_REROUTE_CANCEL_CALLBACK_PREFIX))
            return false;
        const rerouteId = query.data.match(/^reroutecancel:([a-z0-9]+)$/)?.[1];
        const pending = rerouteId
            ? pendingUnboundReroutes.get(rerouteId)
            : undefined;
        const cancellation = pending?.abandonment;
        const sources = pending?.messages ?? [];
        const execution = Updates.getBaleUpdateExecutionFence(query);
        const isAuthorityCurrent = () => !!cancellation &&
            execution?.isCurrent() === true &&
            sources.length > 0 &&
            sources.every((source) => Updates.getBaleUpdateExecutionFence(source)?.signal.aborted ===
                false) &&
            deps.isContextActive?.(ctx) === true &&
            query.from.id === cancellation.ownerUserId &&
            !query.from.is_bot &&
            deps.configStore.getAllowedUserId() === cancellation.ownerUserId &&
            deps.getAdmissionJournalBinding?.() === cancellation.journalBindingKey &&
            deps.getCurrentLeaderEpoch?.() === cancellation.leaderEpoch;
        const isCurrent = () => isAuthorityCurrent() &&
            !!pending &&
            !!cancellation &&
            pendingUnboundReroutes.get(rerouteId) === pending &&
            pending.abandonment === cancellation &&
            matchesRerouteChooser(pending, query) &&
            query.message?.chat.type === "private" &&
            pending.messages.every((source) => source.from?.id === cancellation.ownerUserId) &&
            isPendingRerouteUntouched(pending);
        if (!isCurrent() ||
            !deps.runWorkspaceOperation ||
            !deps.editInteractiveMessage) {
            // A chooser from a previous process (new world) or an expired one simply reads as expired.
            await deps.answerCallbackQuery(query.id, pending
                ? "This message can no longer be cancelled"
                : BALE_ROUTING_CHOICE_EXPIRED);
            return true;
        }
        if (cancellation.running) {
            await deps.answerCallbackQuery(query.id, "Already cancelling");
            return true;
        }
        cancellation.running = true;
        let closed = false;
        try {
            await deps.runWorkspaceOperation({
                operationId: `workspace-reroute-cancel:${query.id}`,
                operationKind: "workspace.cancel-unbound-routing",
                scopes: [{ kind: "profile" }],
            }, async () => {
                if (!isCurrent())
                    return;
                if (!isPendingRerouteCancelled(pending)) {
                    const wasAttempted = cancellation.attempted;
                    cancellation.attempted = true;
                    if (!abandonPendingRerouteSources(pending, cancellation.ownerUserId, isCurrent)) {
                        if (!cancellation.sourceResults?.size)
                            cancellation.attempted = wasAttempted;
                        await deps.answerCallbackQuery(query.id, "Cannot cancel right now");
                        return;
                    }
                }
                if (!isCurrent())
                    return;
                if (!recordCancelledTemporaryThreadInput(pending, ctx, isCurrent)) {
                    if (isAuthorityCurrent())
                        await deps.answerCallbackQuery(query.id, "Cancelled; tap Cancel again to close the tab");
                    return;
                }
                if ((await retireCancellationChooser(rerouteId, pending, isCurrent)) &&
                    isAuthorityCurrent()) {
                    scheduleTemporaryThreadCleanup(pending.sourceTarget, ctx);
                    closed = true;
                }
            });
            // Released admission lets the tab cleanup start right after the notice; the toast and All copy go alongside it.
            if (closed)
                await Promise.all([
                    deps.answerCallbackQuery(query.id, "Routing cancelled"),
                    deleteAllTabCopies(pending),
                    deleteCancelledOrphanTab(pending, cancellation, isAuthorityCurrent),
                ]);
        }
        catch (error) {
            deps.recordRuntimeEvent?.("routing", error, {
                phase: "unbound-cancellation",
                rerouteId,
            });
            if (isCurrent())
                await deps.answerCallbackQuery(query.id, isPendingRerouteCancelled(pending)
                    ? "Cancelled; tap Cancel again to update the menu"
                    : "Not fully cancelled; tap Cancel again");
        }
        finally {
            cancellation.running = false;
        }
        return true;
    };
    const withPendingRerouteSelection = async (rerouteId, query, operation) => {
        Updates.assertBaleUpdateExecutionCurrent(query);
        const pending = pendingUnboundReroutes.get(rerouteId);
        if (pending?.phase.kind === "forward-unknown" &&
            matchesRerouteChooser(pending, query)) {
            await deps.answerCallbackQuery(query.id, "Delivery unconfirmed; not resending");
            return true;
        }
        if (pending &&
            matchesRerouteChooser(pending, query) &&
            (pending.abandonment?.attempted ||
                pending.abandonment?.running ||
                pending.messages.some((message) => Updates.getBaleUpdateExecutionFence(message)?.isCurrent() ===
                    false))) {
            await deps.answerCallbackQuery(query.id, BALE_ROUTING_CHOICE_EXPIRED);
            return true;
        }
        const releases = [];
        try {
            if (pending && matchesRerouteChooser(pending, query)) {
                try {
                    for (const message of pending.messages)
                        releases.push(Updates.acquireBaleUpdateRouting(message));
                }
                catch (error) {
                    deps.recordRuntimeEvent?.("routing", error, {
                        phase: "routing-input-selection",
                    });
                    await deps.answerCallbackQuery(query.id, "This choice is no longer available");
                    return true;
                }
            }
            return await operation();
        }
        finally {
            for (const release of releases)
                release();
        }
    };
    const executeUnboundRerouteRestoreMenuCallback = async (query, _ctx) => {
        const parsed = parseBaleUnboundRerouteRestoreMenuCallbackData(query.data);
        if (!parsed)
            return false;
        const assertExecutionCurrent = Updates.createBaleUpdateExecutionFenceGuard(query);
        assertExecutionCurrent();
        const chatId = query.message?.chat?.id;
        const messageId = query.message?.message_id;
        const pending = pendingUnboundReroutes.get(parsed.rerouteId);
        if (typeof chatId !== "number" ||
            typeof messageId !== "number" ||
            !deps.threadStore ||
            !pending ||
            !matchesRerouteChooser(pending, query) ||
            (parsed.root && pending.rootChooserText === undefined) ||
            expirePendingCommand(parsed.rerouteId, pending)) {
            await deps.answerCallbackQuery(query.id, BALE_ROUTING_CHOICE_EXPIRED);
            return true;
        }
        if (parsed.restore && pending.sourceTarget.threadId === undefined) {
            await deps.answerCallbackQuery(query.id, "Restore needs a new tab; send a message there first");
            return true;
        }
        await deps.threadStore.load();
        assertExecutionCurrent();
        const activeRecords = getBaleRoutableThreadRecords(deps.threadStore.list(), deps.getLiveThreadTargets?.());
        const replyMarkup = parsed.root
            ? buildBaleUnboundRerouteChooserMarkup(parsed.rerouteId, activeRecords, {
                canRestore: pending.sourceTarget.threadId !== undefined,
                canCancel: !!pending.abandonment,
                getDisplayTitle: deps.getDisplayTitle,
            })
            : parsed.restore
                ? buildBaleUnboundRerouteRestoreChooserMarkup(parsed.rerouteId, activeRecords, deps.getDisplayTitle)
                : {
                    inline_keyboard: activeRecords.map((record) => [
                        {
                            text: `🧵 ${getBaleThreadRecordLabel(record, deps.getDisplayTitle)}`,
                            callback_data: formatBaleUnboundRerouteCallbackData(parsed.rerouteId, record.target.threadId),
                        },
                    ]),
                };
        const chooserText = parsed.root
            ? pending.rootChooserText
            : parsed.restore
                ? formatBaleUnboundRerouteRestoreChooserText(getPendingRerouteCommandName(pending))
                : formatBaleUnboundRerouteChooserText(getPendingRerouteCommandName(pending));
        if (!parsed.root)
            replyMarkup.inline_keyboard.unshift([
                {
                    text: "⬆️ Back",
                    callback_data: `${BALE_UNBOUND_REROUTE_ROOT_CALLBACK_PREFIX}${parsed.rerouteId}`,
                },
            ]);
        if (deps.editInteractiveMessage) {
            await deps.editInteractiveMessage(chatId, messageId, chooserText, "html", replyMarkup);
        }
        else if (deps.sendInteractiveMessage) {
            const chooserId = await deps.sendInteractiveMessage(chatId, chooserText, "html", replyMarkup, { target: pending.sourceTarget, replyToMessageId: messageId });
            assertExecutionCurrent();
            rememberRerouteChooser(parsed.rerouteId, chooserId);
        }
        assertExecutionCurrent();
        // Navigation answers silently, like the main menu: the edited chooser is the feedback.
        await deps.answerCallbackQuery(query.id);
        return true;
    };
    const executeUnboundRerouteCallbackOperation = async (query, ctx, afterAdmission) => {
        const parsed = parseBaleUnboundRerouteCallbackData(query.data);
        if (!parsed)
            return false;
        const assertExecutionCurrent = Updates.createBaleUpdateExecutionFenceGuard(query);
        assertExecutionCurrent();
        const chatId = query.message?.chat?.id;
        const pending = pendingUnboundReroutes.get(parsed.rerouteId);
        if (typeof chatId !== "number" ||
            !deps.threadStore ||
            !pending ||
            !matchesRerouteChooser(pending, query) ||
            expirePendingCommand(parsed.rerouteId, pending)) {
            await deps.answerCallbackQuery(query.id, BALE_ROUTING_CHOICE_EXPIRED);
            return true;
        }
        await deps.threadStore.load();
        assertExecutionCurrent();
        if (pendingUnboundReroutes.get(parsed.rerouteId) !== pending ||
            expirePendingCommand(parsed.rerouteId, pending)) {
            await deps.answerCallbackQuery(query.id, BALE_ROUTING_CHOICE_EXPIRED);
            return true;
        }
        if (pending.phase.kind === "finalizing") {
            await finalizePendingReroute(parsed.rerouteId, pending, query, pending.phase.message, assertExecutionCurrent, pending.phase.retainRecord === true);
            return true;
        }
        if (pending.liveRebind &&
            (!parsed.useNewSlot ||
                pending.liveRebind.record.target.threadId !== parsed.threadId)) {
            await deps.answerCallbackQuery(query.id, "Live rebind is already selected. Use the original choice");
            return true;
        }
        if (pending.workspaceRestore &&
            (!restoreWorkspace ||
                !parsed.useNewSlot ||
                pending.workspaceRestore.record.target.threadId !== parsed.threadId)) {
            await deps.answerCallbackQuery(query.id, "Restore is already chosen");
            return true;
        }
        if (pending.phase.kind === "cleanup") {
            const cleanupComplete = await retryPendingRerouteCleanup(pending.phase.cleanup, assertExecutionCurrent);
            if (!cleanupComplete) {
                await deps.answerCallbackQuery(query.id, "Sent; tap again to close the tab");
                return true;
            }
            pending.phase = { kind: "selected" };
            await finalizePendingReroute(parsed.rerouteId, pending, query, "Tab closed", assertExecutionCurrent);
            return true;
        }
        if (!pending.workspaceRestore &&
            isTemporaryReroute(pending) &&
            isTemporaryThreadForwardIssued(pending)) {
            await deps.answerCallbackQuery(query.id, "Delivery unconfirmed; not resending");
            return true;
        }
        const record = pending.liveRebind?.record ??
            pending.workspaceRestore?.record ??
            getBaleRoutableThreadRecords(deps.threadStore.list(), deps.getLiveThreadTargets?.()).find((candidate) => candidate.target.chatId === chatId &&
                candidate.target.threadId === parsed.threadId);
        if (!record) {
            await deps.answerCallbackQuery(query.id, "Thread is not active yet");
            return true;
        }
        const reroutedMessages = cloneBaleMessagesForThread(pending.messages, parsed.threadId);
        const sourceTarget = typeof pending.sourceTarget.threadId === "number"
            ? { chatId, threadId: pending.sourceTarget.threadId }
            : undefined;
        const sourceMessageId = pending.chooserMessageId;
        const completeRoutedReroute = async () => {
            // A temporary tab is removed only after every input in it resolves, never by one Forward.
            const cleanupComplete = isTemporaryTabTarget(sourceTarget) ||
                (await closeReroutedUnboundTopic(sourceTarget, sourceMessageId, assertExecutionCurrent, pending.temporaryThread));
            if (!cleanupComplete && sourceTarget) {
                pending.phase = {
                    kind: "cleanup",
                    cleanup: {
                        kind: "unbound",
                        target: sourceTarget,
                        ...(typeof sourceMessageId === "number"
                            ? { messageId: sourceMessageId }
                            : {}),
                        ...(pending.temporaryThread
                            ? { temporaryThread: pending.temporaryThread }
                            : {}),
                    },
                };
                await deps.answerCallbackQuery(query.id, "Sent; tap again to close the tab");
                return true;
            }
            await finalizePendingReroute(parsed.rerouteId, pending, query, "Sent");
            if (sourceTarget && isTemporaryTabTarget(sourceTarget))
                scheduleTemporaryThreadCleanup(sourceTarget, ctx);
            return true;
        };
        if (parsed.useNewSlot && !sourceTarget) {
            await deps.answerCallbackQuery(query.id, "Restore needs a new tab; send a message there first");
            return true;
        }
        if (parsed.useNewSlot &&
            sourceTarget &&
            record.target.chatId === sourceTarget.chatId &&
            record.target.threadId === sourceTarget.threadId) {
            await deps.answerCallbackQuery(query.id, "Already in this thread");
            return true;
        }
        // A source's own temporary tab is its Restore destination; only other protection refuses it.
        if (parsed.useNewSlot &&
            sourceTarget &&
            !pending.workspaceRestore &&
            !pending.liveRebind &&
            isRerouteTargetProtected(sourceTarget, undefined, pending.temporaryThread ?? findCreatedTemporaryThread(sourceTarget), pending)) {
            await deps.answerCallbackQuery(query.id, "This tab already has a Pi");
            return true;
        }
        // Restore has one controller. Without it or its negotiated authority, refuse before selection so the chooser keeps
        // its other routes and Cancel.
        const useLiveRebind = !!pending.liveRebind || deps.hasWorkspaceLiveRebindAuthority?.() === true;
        if (parsed.useNewSlot &&
            sourceTarget &&
            !pending.workspaceRestore &&
            !useLiveRebind &&
            (!restoreWorkspace || deps.hasWorkspaceRestoreAuthority?.() !== true)) {
            await deps.answerCallbackQuery(query.id, "Restore unavailable; the message is kept");
            return true;
        }
        const currentInstanceId = deps.getCurrentInstanceId?.();
        const leaderProfileKey = getLeaderTopicProfileKey(ctx, currentInstanceId);
        const isCurrentLeaderRecord = isCurrentLeaderTopicRecord(record, leaderProfileKey, currentInstanceId);
        if (!parsed.useNewSlot &&
            record.instanceId &&
            record.instanceId !== currentInstanceId &&
            !isCurrentLeaderRecord &&
            !deps.foreignOwnedUpdateForwarder?.forwardMessage) {
            if (pending.routingOperatorUserId === undefined) {
                pending.phase = { kind: "selected" };
                pending.pauseExpiry?.();
            }
            await deps.answerCallbackQuery(query.id, "Open that thread and send it there");
            return true;
        }
        if (pending.routingOperatorUserId !== undefined &&
            (pending.routingOperatorUserId !== query.from.id ||
                pending.routingOperatorUserId !== deps.configStore.getAllowedUserId())) {
            await deps.answerCallbackQuery(query.id, "Routing changed; reopen the menu");
            return true;
        }
        // Unsupported live selections never freeze input or borrow legacy Restore/Forward dispatch.
        const liveTemplate = pending.liveRebind?.template ??
            (parsed.useNewSlot && useLiveRebind && pending.dispatchKind === "command"
                ? getLiveRebindTemplate(pending.messages)
                : undefined);
        const liveContinue = pending.liveRebind?.continueCommand ??
            (parsed.useNewSlot && useLiveRebind && pending.dispatchKind === "command"
                ? getLiveRebindContinue(pending.messages)
                : undefined);
        const liveMenu = pending.liveRebind?.menuCommand ??
            (parsed.useNewSlot && useLiveRebind && pending.dispatchKind === "command"
                ? getLiveRebindMenu(pending.messages)
                : undefined);
        const liveAbort = pending.liveRebind?.abortCommand ??
            (parsed.useNewSlot && useLiveRebind && pending.dispatchKind === "command"
                ? getLiveRebindAbort(pending.messages)
                : undefined);
        const liveNext = pending.liveRebind?.nextCommand ??
            (parsed.useNewSlot && useLiveRebind && pending.dispatchKind === "command"
                ? getLiveRebindNext(pending.messages)
                : undefined);
        const liveStop = pending.liveRebind?.stopCommand ??
            (parsed.useNewSlot && useLiveRebind && pending.dispatchKind === "command"
                ? getLiveRebindStop(pending.messages)
                : undefined);
        const liveHelp = pending.liveRebind?.helpCommand ??
            (parsed.useNewSlot && useLiveRebind && pending.dispatchKind === "command"
                ? getLiveRebindHelp(pending.messages)
                : undefined);
        const liveName = pending.liveRebind?.nameCommand ??
            (parsed.useNewSlot && useLiveRebind && pending.dispatchKind === "command"
                ? getLiveRebindName(pending.messages)
                : undefined);
        const liveConfirmation = pending.liveRebind?.confirmationCommand ??
            (parsed.useNewSlot && useLiveRebind && pending.dispatchKind === "command"
                ? getLiveRebindConfirmation(pending.messages)
                : undefined);
        const liveExtension = pending.liveRebind?.extensionCommand ??
            (parsed.useNewSlot && useLiveRebind && pending.dispatchKind === "command"
                ? getLiveRebindExtension(pending.messages)
                : undefined);
        // Albums enter through prompt coalescing, but a producer command cannot borrow that admission mode.
        const groupedExtension = pending.messages.length > 1 &&
            Commands.findBaleExtensionCommand(Commands.parseBaleCommand(Media.extractFirstBaleMessageText(pending.messages))?.name);
        const groupedFollowerCommand = record.owner?.kind === "manual-follower" &&
            pending.messages.length > 1 &&
            Commands.parseBaleCommand(Media.extractFirstBaleMessageText(pending.messages));
        // Follower syntax is shared; prepareLiveSelection asks the recipient's registry before freezing or saving.
        const selectedFollowerCommand = record.owner?.kind === "manual-follower" &&
            pending.messages.length === 1 &&
            Commands.parseBaleCommand(Media.extractFirstBaleMessageText(pending.messages));
        if (parsed.useNewSlot &&
            useLiveRebind &&
            (deps.hasWorkspaceLiveRebindAuthority?.() !== true ||
                groupedExtension ||
                groupedFollowerCommand ||
                (pending.dispatchKind === "command" &&
                    (record.owner?.kind === "leader"
                        ? !liveTemplate &&
                            !liveContinue &&
                            !liveMenu &&
                            !liveAbort &&
                            !liveNext &&
                            !liveStop &&
                            !liveHelp &&
                            !liveName &&
                            !liveConfirmation &&
                            !liveExtension
                        : !selectedFollowerCommand)) ||
                !deps.runWorkspaceOperation ||
                !deps.workspaceRestoreRecipient ||
                (record.owner?.kind === "leader"
                    ? record.instanceId !== currentInstanceId ||
                        !deps.setCurrentLeaderIdentity
                    : record.owner?.kind !== "manual-follower" ||
                        !deps.workspaceRestoreRecipient.liveFollower))) {
            await deps.answerCallbackQuery(query.id, "Live rebind is unavailable for this input or recipient. The message stays pending");
            return true;
        }
        // Freeze only a validated actual destination, inside the same admission as its effect. Menu browsing,
        // unavailable recipients and refused Restore capability never turn a waiting source into a selected grant.
        const selectPendingDestination = async () => {
            try {
                const release = Updates.acquireBaleUpdateRouting(pending.messages[0], true, Updates.collectBaleAdmissionSourceUpdateIds(pending.messages));
                release();
            }
            catch (error) {
                deps.recordRuntimeEvent?.("routing", error, {
                    phase: "routing-input-selection",
                });
                await deps.answerCallbackQuery(query.id, "This choice is no longer available");
                return false;
            }
            pending.phase = { kind: "selected" };
            pending.pauseExpiry?.();
            return true;
        };
        if (parsed.useNewSlot && sourceTarget && useLiveRebind) {
            const selection = pending.liveRebind ?? {
                record: structuredClone(record),
                messages: [...pending.messages],
                template: liveTemplate,
                continueCommand: liveContinue,
                menuCommand: liveMenu,
                abortCommand: liveAbort,
                nextCommand: liveNext,
                stopCommand: liveStop,
                helpCommand: liveHelp,
                nameCommand: liveName,
                confirmationCommand: liveConfirmation,
                extensionCommand: liveExtension,
            };
            const current = () => {
                try {
                    assertExecutionCurrent();
                }
                catch {
                    return false;
                }
                return (deps.runWorkspaceOperation !== undefined &&
                    deps.isContextActive?.(ctx) === true &&
                    query.from.id === deps.configStore.getAllowedUserId() &&
                    pendingUnboundReroutes.get(parsed.rerouteId) === pending &&
                    (pending.liveRebind === undefined || pending.liveRebind === selection));
            };
            let outcome = "protected";
            // The enclosing selection owner holds these exact source references across admission and every await.
            selection.isCurrent = current;
            try {
                selection.coordinator ??= await prepareLiveSelection(selection, sourceTarget, ctx);
                if (!selection.coordinator) {
                    await deps.answerCallbackQuery(query.id, "Live rebind recipient authority is unavailable. The message stays pending");
                    return true;
                }
                // Keep the captured plan even if the source owner's issued selection result is lost.
                pending.liveRebind ??= selection;
                if (!(await selectPendingDestination()))
                    return true;
                const operationId = selection.coordinator.operationId;
                if (current())
                    outcome = await selection.coordinator.advance();
                const completionTimeoutMs = deps.liveRebindCommandCompletionTimeoutMs ?? 0;
                if (outcome === "unknown" && !selection.commandCompletionWaited && selection.record.owner?.kind === "leader" &&
                    (selection.helpCommand || selection.menuCommand || selection.abortCommand || selection.nextCommand || selection.stopCommand) &&
                    Number.isFinite(completionTimeoutMs) && completionTimeoutMs > 0 &&
                    selection.coordinator.observeCommandCompletion() !== undefined) {
                    selection.commandCompletionWaited = true;
                    const coordinator = selection.coordinator;
                    const signal = Updates.getBaleUpdateExecutionFence(query)?.signal;
                    outcome = await new Promise((resolve) => {
                        let settled = false;
                        const subscriptions = [];
                        const finish = (result) => {
                            if (settled)
                                return;
                            settled = true;
                            clearTimeout(timer);
                            for (const unsubscribe of subscriptions)
                                unsubscribe();
                            signal?.removeEventListener("abort", abort);
                            resolve(result);
                        };
                        const abort = () => finish("unknown");
                        const observe = () => {
                            if (settled)
                                return;
                            if (!current()) {
                                finish("unknown");
                                return;
                            }
                            if (coordinator.observeCommandCompletion() === "released")
                                finish("released");
                        };
                        const timer = setTimeout(abort, completionTimeoutMs);
                        timer.unref?.();
                        for (const message of selection.messages) {
                            const unsubscribe = Updates.subscribeBaleDeferredSourceCompletion(message, observe);
                            if (unsubscribe)
                                subscriptions.push(unsubscribe);
                        }
                        signal?.addEventListener("abort", abort, { once: true });
                        if (signal?.aborted || !current())
                            abort();
                        else if (coordinator.observeCommandCompletion() === "released")
                            finish("released");
                    });
                }
                // Cleanup readiness follows the canonical released row, not source disposal: a detached command ACK may
                // still be pending while every attempt samples current work afresh.
                const row = outcome === "protected"
                    ? undefined
                    : deps
                        .getWorkspaceRestoreStore?.()
                        ?.listLiveRebindings()
                        .find((value) => value.request.operationId === operationId);
                if (row?.phase === "released" && row.cleanup === undefined &&
                    (row.inputRelease === undefined || row.inputRelease === "accepted")) {
                    scheduleLiveRebindCleanup(operationId, selection.record.owner?.kind === "leader" ? "leader" : "follower", ctx);
                }
                if (outcome === "released")
                    await releaseAllTabCopiesIntoSurvivingTab(pending);
            }
            catch (error) {
                deps.recordRuntimeEvent?.("routing", error, {
                    phase: "live-rebind-chooser",
                });
            }
            finally {
                selection.isCurrent = undefined;
            }
            assertExecutionCurrent();
            if (outcome !== "released") {
                await deps.answerCallbackQuery(query.id, "Live rebind is unconfirmed; this choice never replays issued input");
                return true;
            }
            const cleanupRow = deps.getWorkspaceRestoreStore?.()?.listLiveRebindings().find(value => value.request.operationId === selection.coordinator?.operationId);
            const cleanupResult = cleanupRow?.inputRelease && cleanupRow.cleanup !== undefined
                ? cleanupRow.cleanup === "confirmed" ? "old-Thread removal confirmed"
                    : cleanupRow.cleanup === "unknown" || cleanupRow.cleanup === "issued" ? "old-Thread removal unconfirmed; deletion will not repeat"
                        : cleanupRow.cleanup === "failed" ? "old-Thread removal failed" : "old-Thread removal was not issued"
                : undefined;
            const commandDisposed = !!(selection.extensionCommand && selection.extensionKind !== "generated-prompt" || selection.nameCommand ||
                selection.confirmationCommand || selection.helpCommand || selection.stopCommand || selection.nextCommand ||
                selection.menuCommand || selection.abortCommand || selection.coordinator?.selectedCommandReference());
            // The tab now belongs to the rebound thread; only the one-shot chooser message goes.
            await finalizePendingReroute(parsed.rerouteId, pending, query, cleanupResult
                ? commandDisposed ? `Command source disposal confirmed; ${cleanupResult}; delivery and follow-on effects remain independent`
                    : `Input queued in the rebound Thread; ${cleanupResult}`
                : selection.extensionKind === "generated-prompt"
                    ? "Input queued in the rebound Thread; old-Thread cleanup is scheduled, not confirmed"
                    : selection.extensionCommand
                        ? "Command source disposal confirmed; reply delivery and old-Thread cleanup are not confirmed"
                        : selection.nameCommand
                            ? selection.nameCommand.args.trim()
                                ? "Command source disposal confirmed; title/reply delivery and old-Thread cleanup are not confirmed"
                                : "Command source disposal confirmed; name-dialog publication was handled, not title change or old-Thread cleanup"
                            : selection.confirmationCommand
                                ? `Command source disposal confirmed; confirmation delivery and actual ${selection.confirmationCommand.name === "new" ? "session replacement" : "compaction"} or old-Thread cleanup are not confirmed`
                                : selection.helpCommand
                                    ? "Command source disposal confirmed; menu/sync delivery and old-Thread cleanup are not confirmed"
                                    : selection.stopCommand
                                        ? "Command source disposal confirmed; abort settlement, reply delivery and old-Thread cleanup are not confirmed"
                                        : selection.nextCommand
                                            ? "Command source disposal confirmed; queue dispatch, transition notices and old-Thread cleanup are not confirmed"
                                            : selection.menuCommand || selection.abortCommand
                                                ? `Command source disposal confirmed; ${selection.menuCommand ? "menu" : "reply"} delivery and old-Thread cleanup are not confirmed`
                                                : selection.coordinator?.selectedCommandReference()
                                                    ? "Command source disposal confirmed; recipient command effects and old-Thread cleanup are not confirmed"
                                                    : "Input queued in the rebound Thread; old-Thread cleanup is scheduled, not confirmed", assertExecutionCurrent, true);
            return true;
        }
        if (!parsed.useNewSlot &&
            isTemporaryReroute(pending) &&
            !resolvePendingRerouteForwardSource(pending)) {
            await deps.answerCallbackQuery(query.id, "Source copy unavailable; not routing");
            return true;
        }
        if (!(await selectPendingDestination()))
            return true;
        if (parsed.useNewSlot && sourceTarget && restoreWorkspace) {
            const selection = (pending.workspaceRestore ??= {
                operationId: `restore-${randomBytes(16).toString("hex")}`,
                record: structuredClone(record),
                messages: [...pending.messages],
            });
            let active = true;
            // Delivery proof for the toast only; chooser retirement still waits for the positive settlement that follows.
            let delivered = false;
            const ownerUserId = deps.configStore.getAllowedUserId();
            const leaderEpoch = deps.getCurrentLeaderEpoch?.();
            const admissionScope = deps.getAdmissionScope?.();
            const journalBinding = deps.getAdmissionJournalBinding?.();
            const selectionCurrent = () => {
                try {
                    assertExecutionCurrent();
                }
                catch {
                    return false;
                }
                return (ownerUserId === query.from.id &&
                    deps.configStore.getAllowedUserId() === ownerUserId &&
                    deps.getCurrentLeaderEpoch?.() === leaderEpoch &&
                    deps.getAdmissionScope?.() === admissionScope &&
                    deps.getAdmissionJournalBinding?.() === journalBinding &&
                    deps.isContextActive?.(ctx) !== false &&
                    pendingUnboundReroutes.get(parsed.rerouteId) === pending &&
                    pending.workspaceRestore === selection);
            };
            const current = () => active && selectionCurrent();
            const assertRestoreCurrent = () => {
                assertExecutionCurrent();
                if (!current())
                    throw new Error("Stale Workspace Restore callback.");
            };
            try {
                await restoreWorkspace({
                    operationId: selection.operationId,
                    record: structuredClone(selection.record),
                    target: { ...sourceTarget },
                    messages: [...selection.messages],
                    ctx,
                    isCurrent: current,
                    async dispatch(recipient, isRecipientCurrent, recordForwardAcceptance, recordLocalAcceptance) {
                        const assertRecipientCurrent = () => {
                            assertRestoreCurrent();
                            if (!isRecipientCurrent())
                                throw new Error("Workspace Restore recipient authority changed.");
                        };
                        assertRecipientCurrent();
                        if (recipient.kind === "leader") {
                            if (recipient.instanceId !== currentInstanceId)
                                return false;
                            const routed = cloneBaleMessagesForThread(pending.messages, sourceTarget.threadId);
                            const messages = pending.dispatchKind === "command"
                                ? routed.map((message, index) => Updates.bindBaleUpdateCompletionAcceptance(message, () => recordLocalAcceptance(pending.messages[index])))
                                : routed;
                            await dispatchPendingRerouteMessages(pending, messages, ctx);
                            assertRecipientCurrent();
                            delivered = true;
                            await releaseAllTabCopiesIntoSurvivingTab(pending);
                            return true;
                        }
                        const forwarded = await forwardPendingRerouteMessages(pending, recipient.instanceId, sourceTarget.threadId, ctx, assertRecipientCurrent, recordForwardAcceptance);
                        if (forwarded) {
                            delivered = true;
                            await releaseAllTabCopiesIntoSurvivingTab(pending);
                        }
                        return forwarded;
                    },
                });
            }
            finally {
                active = false;
            }
            assertExecutionCurrent();
            if (!selectionCurrent())
                return true;
            await deps.answerCallbackQuery(query.id, delivered ? "Restored" : "Restore unconfirmed; not resending");
            return true;
        }
        let assertRerouteCurrent = assertExecutionCurrent;
        if (isTemporaryReroute(pending)) {
            const confirmed = await publishPendingRerouteCopies(pending, record, ctx, assertExecutionCurrent, !!record.instanceId && record.instanceId !== currentInstanceId && !isCurrentLeaderRecord);
            if (!confirmed) {
                await deps.answerCallbackQuery(query.id, pending.phase.kind === "forward-unknown"
                    ? "Publication unconfirmed; not resending"
                    : "Publication unavailable; input kept");
                return true;
            }
            assertRerouteCurrent = confirmed;
        }
        assertRerouteCurrent();
        if (record.instanceId &&
            record.instanceId !== currentInstanceId &&
            !isCurrentLeaderRecord) {
            const allForwarded = await forwardPendingRerouteMessages(pending, record.instanceId, parsed.threadId, ctx, assertRerouteCurrent);
            if (!allForwarded) {
                await deps.answerCallbackQuery(query.id, pending.phase.kind === "forward-unknown"
                    ? "Delivery unconfirmed; not resending"
                    : "Thread unavailable; a retry sends only the rest");
                return true;
            }
            return completeRoutedReroute();
        }
        // Local handlers and queue admission consume the same one-time group grant as follower forwarding.
        if (isTemporaryReroute(pending) &&
            !pending.rerouteCopies &&
            !issueTemporaryThreadForward(pending, ctx)) {
            await deps.answerCallbackQuery(query.id, "Delivery unconfirmed; not resending");
            return true;
        }
        const localMessages = pending.rerouteCopies
            ? cloneBaleMessagesForThread(pending.messages, parsed.threadId, pending.rerouteCopies.bySourceUpdateId)
            : reroutedMessages;
        const command = pending.dispatchKind === "command"
            ? getLiveRebindMenu(localMessages) ?? getLiveRebindHelp(localMessages) : undefined;
        const completion = pending.rerouteCopies && command
            ? Updates.prepareBaleDeferredSourceCompletion(pending.messages[0]) : undefined;
        if (command && completion) {
            const release = await stageTemporaryRerouteMenu(pending, command, localMessages, ctx, assertRerouteCurrent, completion);
            if (!release) {
                await deps.answerCallbackQuery(query.id, "Command acceptance unconfirmed; not resending");
                return true;
            }
            afterAdmission(release);
        }
        else {
            await dispatchPendingRerouteMessages(pending, localMessages, ctx);
        }
        assertRerouteCurrent();
        pending.messages = [];
        return completeRoutedReroute();
    };
    const executeUnboundRerouteCallback = async (query, ctx) => {
        const parsed = parseBaleUnboundRerouteCallbackData(query.data);
        if (!parsed)
            return false;
        return withPendingRerouteSelection(parsed.rerouteId, query, async () => {
            let release;
            const operation = () => executeUnboundRerouteCallbackOperation(query, ctx, value => { release = value; });
            try {
                if (!deps.runWorkspaceOperation)
                    return await operation();
                return await deps.runWorkspaceOperation({
                    operationId: `workspace-reroute:${query.id}`,
                    operationKind: "workspace.route-unbound-thread",
                    scopes: [{ kind: "profile" }],
                }, operation);
            }
            finally {
                // Keep the exact source references, but release the non-reentrant Workspace gate before cleanup.
                await release?.();
            }
        });
    };
    const handleUnboundRerouteCallback = async (query, ctx) => {
        const parsed = parseBaleUnboundRerouteCallbackData(query.data);
        const pending = parsed && pendingUnboundReroutes.get(parsed.rerouteId);
        if (!parsed ||
            !pending ||
            pending.dispatchKind !== "command" ||
            (pending.sourceTarget.threadId !== undefined &&
                !pending.temporaryThread) ||
            !matchesRerouteChooser(pending, query)) {
            return executeUnboundRerouteCallback(query, ctx);
        }
        if (pending.dispatching) {
            await deps.answerCallbackQuery(query.id, "Already routing this command");
            return true;
        }
        pending.dispatching = true;
        try {
            return await executeUnboundRerouteCallback(query, ctx);
        }
        finally {
            pending.dispatching = false;
            if (pendingUnboundReroutes.get(parsed.rerouteId) === pending &&
                pending.phase.kind === "selected" &&
                pending.messages.length > 0) {
                pending.phase = { kind: "released" };
                armPendingCommandExpiry(parsed.rerouteId, pending);
            }
        }
    };
    const callbackHandler = async (query, ctx) => {
        const assertExecutionCurrent = Updates.createBaleUpdateExecutionFenceGuard(query);
        assertExecutionCurrent();
        if (await handleCancellationReview(query, ctx))
            return;
        if (await handleUnboundRerouteCancelCallback(query, ctx))
            return;
        const restore = parseBaleUnboundRerouteRestoreMenuCallbackData(query.data);
        if (restore &&
            (await withPendingRerouteSelection(restore.rerouteId, query, () => executeUnboundRerouteRestoreMenuCallback(query, ctx))))
            return;
        if (await handleUnboundRerouteCallback(query, ctx))
            return;
        if (deps.buttonActionStore) {
            const handled = await OutboundHandlers.handleBaleButtonCallbackQuery(query, ctx, {
                resolveAction: deps.buttonActionStore.resolve,
                answerCallbackQuery: deps.answerCallbackQuery,
                ...(deps.invokeBoundButtonAction
                    ? {
                        invokeBoundAction: (buttonQuery, action, context) => deps.invokeBoundButtonAction(action, buttonQuery, context),
                    }
                    : {}),
                editMessageReplyMarkup: deps.editMessageReplyMarkup
                    ? async (chatId, messageId, replyMarkup) => {
                        try {
                            await deps.editMessageReplyMarkup?.(chatId, messageId, replyMarkup);
                        }
                        catch (error) {
                            deps.recordRuntimeEvent?.("bale", error, {
                                phase: "button-selection-mark",
                                chatId,
                                messageId,
                            });
                        }
                    }
                    : undefined,
                enqueueButtonPrompt: (buttonQuery, action, context) => {
                    const chatId = buttonQuery.message?.chat?.id;
                    const messageId = buttonQuery.message?.message_id;
                    if (typeof chatId !== "number" || typeof messageId !== "number")
                        return false;
                    const queueOrder = deps.bridgeRuntime.queue.allocateItemOrder();
                    const admissionReceipts = createAdmissionReceipts("prompt", [
                        buttonQuery,
                    ]);
                    const turn = {
                        ...OutboundHandlers.createBaleButtonPromptTurn({
                            chatId,
                            target: typeof buttonQuery.message?.message_thread_id === "number"
                                ? {
                                    chatId,
                                    threadId: buttonQuery.message.message_thread_id,
                                }
                                : { chatId },
                            replyToMessageId: messageId,
                            queueOrder,
                            action,
                            balePrefix: Turns.createBaleTurnPrefix({
                                thread: resolveBaleThreadLabel({
                                    chat: { id: chatId },
                                    message_thread_id: buttonQuery.message?.message_thread_id,
                                }),
                            }),
                        }),
                        ...(admissionReceipts.length > 0 ? { admissionReceipts } : {}),
                    };
                    const result = Queue.appendBalePromptTurnOnce(deps.baleQueueStore.getQueuedItems(), turn);
                    if (!result.appended) {
                        reportQueueAdmission([buttonQuery], admissionReceipts);
                        return false;
                    }
                    Updates.assertBaleUpdateExecutionCurrent(buttonQuery);
                    deps.baleQueueStore.setQueuedItems(result.items);
                    reportQueueAdmission([buttonQuery], admissionReceipts);
                    deps.updateStatus(context);
                    requestDispatchNextQueuedBaleTurn(context);
                    return true;
                },
            });
            assertExecutionCurrent();
            if (handled)
                return;
        }
        if (query.data?.startsWith("thread-name:")) {
            const chatId = query.message?.chat?.id;
            const dialogMessageId = query.message?.message_id;
            if (typeof chatId !== "number" || typeof dialogMessageId !== "number") {
                await deps.answerCallbackQuery(query.id, "Rename dialog expired");
                return;
            }
            const target = typeof query.message?.message_thread_id === "number"
                ? { chatId, threadId: query.message.message_thread_id }
                : { chatId };
            const action = query.data.slice("thread-name:".length);
            if (action !== "reset" && action !== "cancel") {
                await deps.answerCallbackQuery(query.id, "Rename dialog expired");
                return;
            }
            const queryId = query.id;
            const { resetCurrentThreadName, editInteractiveMessage, answerCallbackQuery, } = deps;
            const lifetime = threadNameDialog.capture({
                scope: getThreadNameDialogScope(),
                target,
                dialogMessageId,
            });
            if (!lifetime) {
                await answerCallbackQuery(queryId, "Rename dialog expired");
                return;
            }
            const portsCurrent = () => deps.resetCurrentThreadName === resetCurrentThreadName &&
                deps.editInteractiveMessage === editInteractiveMessage &&
                deps.answerCallbackQuery === answerCallbackQuery;
            const isCurrent = () => portsCurrent() && lifetime.isCurrent() && portsCurrent();
            const assertRecipient = lifetime.assertAuthority;
            const assertInputAuthority = assertRecipient
                ? () => {
                    if (!isCurrent())
                        throw new Error("Bale Thread name callback lost owner authority.");
                }
                : undefined;
            const ownerOptions = assertInputAuthority ? [{ assertAuthority: assertInputAuthority }] : [];
            // Detached effects retain recipient/port authority, never the ended or expiring input handle.
            const assertEffectAuthority = assertRecipient
                ? () => {
                    assertRecipient();
                    const current = portsCurrent();
                    assertRecipient();
                    if (!current || !portsCurrent())
                        throw new Error("Bale Thread name callback lost port authority.");
                }
                : undefined;
            const editOptions = assertEffectAuthority
                ? [{ target: { ...target }, assertAuthority: assertEffectAuthority }]
                : [];
            const answerOptions = assertEffectAuthority
                ? [{ assertAuthority: assertEffectAuthority }]
                : [];
            if (!isCurrent()) {
                lifetime.finish();
                return;
            }
            const selected = lifetime.select(action);
            if (selected.kind === "expired") {
                lifetime.finish();
                return;
            }
            if (selected.kind === "cancel") {
                // Cancellation terminalizes exact input before independent recipient/API delivery.
                if (!portsCurrent())
                    return;
                assertEffectAuthority?.();
                await editInteractiveMessage?.(chatId, dialogMessageId, "<b>✖ Rename cancelled.</b>", "html", { inline_keyboard: [] }, ...editOptions);
                if (portsCurrent()) {
                    assertEffectAuthority?.();
                    if (assertEffectAuthority)
                        await answerCallbackQuery(queryId, undefined, {
                            assertAuthority: assertEffectAuthority,
                        });
                    else
                        await answerCallbackQuery(queryId);
                    assertEffectAuthority?.();
                }
                return;
            }
            let reopen = false;
            try {
                if (!isCurrent())
                    return;
                const result = await resetCurrentThreadName?.({ ...target }, ...ownerOptions);
                if (!isCurrent())
                    return;
                if (!result?.ok) {
                    throw new Error(result?.message ?? "Thread display name reset is unavailable.");
                }
                const replyText = result.message
                    ? Commands.formatBaleInformationHeading("✅", result.message)
                    : Commands.formatBaleAutomaticThreadDisplayNameRestoredHeading(result.threadName ?? "automatic");
                if (!isCurrent())
                    return;
                assertEffectAuthority?.();
                await editInteractiveMessage?.(chatId, dialogMessageId, replyText, "html", { inline_keyboard: [] }, ...editOptions);
                if (!isCurrent())
                    return;
                assertEffectAuthority?.();
                if (assertEffectAuthority)
                    await answerCallbackQuery(queryId, undefined, {
                        assertAuthority: assertEffectAuthority,
                    });
                else
                    await answerCallbackQuery(queryId);
                assertEffectAuthority?.();
            }
            catch (error) {
                if (!isCurrent())
                    return;
                reopen = true;
                deps.recordRuntimeEvent?.("bale-command", error, {
                    command: "name",
                    phase: "reset",
                });
                if (isCurrent()) {
                    assertEffectAuthority?.();
                    await answerCallbackQuery(queryId, "Thread name reset failed", ...answerOptions);
                    assertEffectAuthority?.();
                }
            }
            finally {
                if (reopen && isCurrent())
                    lifetime.reopen();
                lifetime.finish();
            }
            return;
        }
        const handledByNew = await Commands.handleBaleNewConfirmationCallback(query, {
            ctx,
            answerCallbackQuery: deps.answerCallbackQuery,
            editInteractiveMessage: deps.editInteractiveMessage ?? (async () => { }),
            deleteMessage: deps.deleteMessage ?? (async () => { }),
            runNew: async (newCtx) => {
                await Commands.handleBaleNewCommand({
                    isIdle: () => deps.isIdle(newCtx),
                    hasPendingMessages: () => deps.hasPendingMessages(newCtx),
                    hasActiveBaleTurn: deps.activeTurnRuntime.has,
                    hasDispatchPending: deps.bridgeRuntime.lifecycle.hasDispatchPending,
                    hasQueuedBaleItems: deps.baleQueueStore.hasQueuedItems,
                    isCompactionInProgress: deps.bridgeRuntime.lifecycle.isCompactionInProgress,
                    requestNewSession: deps.requestNewSession
                        ? () => deps.requestNewSession(query)
                        : undefined,
                    sendTextReply: async (text) => {
                        const chatId = query.message?.chat?.id;
                        const messageId = query.message?.message_id;
                        if (typeof chatId !== "number" || typeof messageId !== "number")
                            return;
                        await deps.editInteractiveMessage?.(chatId, messageId, text, "html", { inline_keyboard: [] });
                    },
                    recordRuntimeEvent: deps.recordRuntimeEvent,
                });
            },
        });
        assertExecutionCurrent();
        if (handledByNew)
            return;
        const handledByCompact = await Commands.handleBaleCompactConfirmationCallback(query, {
            ctx,
            answerCallbackQuery: deps.answerCallbackQuery,
            editInteractiveMessage: deps.editInteractiveMessage ?? (async () => { }),
            runCompact: async (compactCtx, chatId, replyToMessageId, target) => {
                await Commands.handleBaleCompactCommand({
                    isIdle: () => deps.isIdle(compactCtx),
                    hasPendingMessages: () => deps.hasPendingMessages(compactCtx),
                    hasActiveBaleTurn: deps.activeTurnRuntime.has,
                    hasDispatchPending: deps.bridgeRuntime.lifecycle.hasDispatchPending,
                    hasQueuedBaleItems: deps.baleQueueStore.hasQueuedItems,
                    isCompactionInProgress: deps.bridgeRuntime.lifecycle.isCompactionInProgress,
                    setCompactionInProgress: deps.bridgeRuntime.lifecycle.setCompactionInProgress,
                    updateStatus: () => deps.updateStatus(compactCtx),
                    dispatchNextQueuedBaleTurn: () => deps.dispatchNextQueuedBaleTurn(compactCtx),
                    requestDeferredDispatchNextQueuedBaleTurn: deps.requestDeferredDispatchNextQueuedBaleTurn
                        ? (dispatch) => deps.requestDeferredDispatchNextQueuedBaleTurn?.(() => dispatch())
                        : undefined,
                    compact: (callbacks) => deps.compact(compactCtx, callbacks),
                    startTypingLoop: deps.startTypingLoop
                        ? () => deps.startTypingLoop?.(compactCtx, chatId, {
                            target,
                        })
                        : undefined,
                    stopTypingLoop: deps.stopTypingLoop,
                    sendTextReply: (text, options) => deps
                        .sendTextReply(chatId, replyToMessageId, text, {
                        target,
                        parseMode: options?.parseMode,
                    })
                        .then(() => { }),
                    suppressStartNotice: true,
                    recordRuntimeEvent: deps.recordRuntimeEvent,
                });
            },
        });
        assertExecutionCurrent();
        if (handledByCompact)
            return;
        const handledByQueue = await deps.queueMenuCallbackHandler(query, ctx);
        assertExecutionCurrent();
        if (handledByQueue)
            return;
        const handledBySettings = await deps.settingsMenuCallbackHandler?.(query, ctx);
        assertExecutionCurrent();
        if (handledBySettings)
            return;
        const callbackData = query.data;
        if (callbackData && !isBaleOwnedCallbackData(callbackData)) {
            const chatId = query.message?.chat?.id;
            const messageId = query.message?.message_id;
            if (typeof chatId === "number" && typeof messageId === "number") {
                const queueOrder = deps.bridgeRuntime.queue.allocateItemOrder();
                const target = typeof query.message?.message_thread_id === "number"
                    ? { chatId, threadId: query.message.message_thread_id }
                    : { chatId };
                const admissionReceipts = createAdmissionReceipts("prompt", [query]);
                const turn = {
                    kind: "prompt",
                    chatId,
                    target,
                    replyToMessageId: messageId,
                    sourceMessageIds: [messageId],
                    queueOrder,
                    queueLane: "priority",
                    laneOrder: queueOrder,
                    queuedAttachments: [],
                    content: [{ type: "text", text: `[callback] ${callbackData}` }],
                    historyText: callbackData,
                    statusSummary: callbackData,
                    ...(admissionReceipts.length > 0 ? { admissionReceipts } : {}),
                };
                const result = Queue.appendBalePromptTurnOnce(deps.baleQueueStore.getQueuedItems(), turn);
                if (result.appended) {
                    Updates.assertBaleUpdateExecutionCurrent(query);
                    deps.baleQueueStore.setQueuedItems(result.items);
                    reportQueueAdmission([query], admissionReceipts);
                    deps.updateStatus(ctx);
                    requestDispatchNextQueuedBaleTurn(ctx);
                }
                else {
                    reportQueueAdmission([query], admissionReceipts);
                }
            }
            await deps.answerCallbackQuery(query.id);
            return;
        }
        await menuCallbackHandler(query, ctx);
    };
    const preparePromptTurn = Turns.createBalePromptTurnRuntimePreparer({
        allocateQueueOrder: deps.bridgeRuntime.queue.allocateItemOrder,
        downloadFile: deps.downloadFile,
        processAttachments: deps.inboundHandlerRuntime.process,
        resolveTimeLine: deps.resolveTimeLine,
        getAllowedUserId: deps.configStore.getAllowedUserId,
        getAdmissionScope: deps.getAdmissionScope,
        getAdmissionJournalBinding: deps.getAdmissionJournalBinding,
        assertExecutionCurrent(message) {
            Updates.assertBaleUpdateExecutionCurrent(message);
        },
        // Voice policy resolves missing, invalid, and legacy manual config to hidden.
        getVoiceReplyMode: () => getBaleVoiceReplyMode(deps.configStore.get()),
        getBaleThreadLabel: resolveBaleThreadLabel,
    });
    const enqueueContinueTurn = async (message, ctx, admission) => {
        admission?.assertCurrent();
        Updates.assertBaleUpdateExecutionCurrent(message);
        if (!admission)
            deps.bridgeRuntime.lifecycle.setFoldQueuedPromptsIntoHistory(false);
        const continueMessage = Updates.carryBaleUpdateExecutionFence(message, {
            ...message,
            text: "continue",
            caption: undefined,
        });
        const buildTurn = await preparePromptTurn([continueMessage], ctx);
        admission?.assertCurrent();
        const turn = buildTurn([]);
        const continueTurn = {
            ...turn,
            queueLane: "control",
            laneOrder: deps.bridgeRuntime.queue.allocateControlOrder(),
            statusSummary: "continue",
        };
        admission?.assertCurrent();
        Updates.assertBaleUpdateExecutionCurrent(message);
        deps.queueMutationRuntime.append(continueTurn, ctx);
        if (admission)
            admission.report(continueTurn);
        else
            reportQueueAdmission([continueMessage], continueTurn.admissionReceipts ?? []);
        requestDispatchNextQueuedBaleTurn(ctx);
    };
    const reservedCommandNames = () => new Set(Commands.getBaleReservedCommandNames());
    const getPromptTemplateCommands = () => PromptTemplates.getBalePromptTemplateCommands(deps.getCommands(), reservedCommandNames());
    const expandPromptTemplateCommand = (name, args) => PromptTemplates.expandBalePromptTemplateCommand(name, args, getPromptTemplateCommands());
    const commandHandler = Commands.createBaleCommandHandlerTargetRuntime({
        assertExecutionCurrent(message) {
            Updates.assertBaleUpdateExecutionCurrent(message);
        },
        hasAbortHandler: deps.bridgeRuntime.abort.hasHandler,
        clearPendingModelSwitch: deps.modelSwitchController.clearPendingSwitch,
        hasQueuedBaleItems: deps.baleQueueStore.hasQueuedItems,
        clearQueuedBaleItems: deps.queueMutationRuntime.clear,
        setFoldQueuedPromptsIntoHistory: deps.bridgeRuntime.lifecycle.setFoldQueuedPromptsIntoHistory,
        abortCurrentTurn: deps.bridgeRuntime.abort.abortTurn,
        isIdle: deps.isIdle,
        hasPendingMessages: deps.hasPendingMessages,
        hasActiveBaleTurn: deps.activeTurnRuntime.has,
        hasDispatchPending: deps.bridgeRuntime.lifecycle.hasDispatchPending,
        isCompactionInProgress: deps.bridgeRuntime.lifecycle.isCompactionInProgress,
        setCompactionInProgress: deps.bridgeRuntime.lifecycle.setCompactionInProgress,
        updateStatus: deps.updateStatus,
        isContextActive: deps.isContextActive,
        beginCommandEffectWork: deps.beginCommandEffectWork,
        dispatchNextQueuedBaleTurn: deps.dispatchNextQueuedBaleTurn,
        requestNextDispatchAnnouncement: deps.requestNextDispatchAnnouncement,
        cancelNextTransitionAnnouncements: () => {
            deps.activeTurnRuntime.clearNextAbortAnnouncement();
            deps.cancelNextDispatchAnnouncement?.();
        },
        requestDeferredDispatchNextQueuedBaleTurn: deps.requestDeferredDispatchNextQueuedBaleTurn,
        startTypingLoop: deps.startTypingLoop,
        stopTypingLoop: deps.stopTypingLoop,
        enqueueContinueTurn,
        heldTurn: {
            templates: {
                getCommands: getPromptTemplateCommands,
                expand: expandPromptTemplateCommand,
            },
            async enqueue(message, ctx, kind, admission) {
                admission.assertCurrent();
                if (kind === "continue")
                    await enqueueContinueTurn(message, ctx, {
                        assertCurrent: admission.assertCurrent,
                        report: (turn) => admission.report(turn.admissionReceipts ?? []),
                    });
                else
                    await promptEnqueueController.enqueue([message], ctx, (turn) => admission.report(turn.admissionReceipts ?? []), { preserveQueued: true, assertCurrent: admission.assertCurrent });
            },
        },
        compact: deps.compact,
        requestNewSession: deps.requestNewSession,
        allocateItemOrder: deps.bridgeRuntime.queue.allocateItemOrder,
        allocateControlOrder: deps.bridgeRuntime.queue.allocateControlOrder,
        appendControlItem: deps.queueMutationRuntime.append,
        getAdmissionScope: deps.getAdmissionScope,
        getAdmissionJournalBinding: deps.getAdmissionJournalBinding,
        getReplyTarget: deps.getCommandReplyTarget,
        onControlQueued: (message, receipt) => reportQueueAdmission([message], [receipt]),
        showStatus: deps.menuActions.sendStatusMessage,
        openModelMenu: deps.menuActions.openModelMenu,
        openThinkingMenu: (message, ctx, options) => {
            const target = Commands.getBaleCommandMessageTarget(message);
            return deps.menuActions.openThinkingMenu(target.chatId, target.replyToMessageId, ctx, target.threadId, options);
        },
        openQueueMenu: (message, ctx, options) => {
            const target = Commands.getBaleCommandMessageTarget(message);
            return deps.openQueueMenu(target.chatId, target.replyToMessageId, ctx, target.threadId, options);
        },
        openSettingsMenu: deps.openSettingsMenu,
        getAllowedUserId: deps.configStore.getAllowedUserId,
        persistAllowedUserId: deps.configStore.persistAllowedUserId,
        setMyCommands: deps.setMyCommands,
        validateThreadName: deps.validateThreadName,
        renameCurrentThread: deps.renameCurrentThread,
        resetCurrentThreadName: deps.resetCurrentThreadName,
        openThreadNameDialog: async (message, ctx, admission) => {
            const assertSemanticCurrent = admission?.assertSemanticCurrent;
            const assertSelectedRecipient = admission?.assertRecipientCurrent;
            assertSemanticCurrent?.();
            const address = Updates.getBaleMessageTarget(message);
            const target = address && { ...address };
            const { sendInteractiveMessage, getCurrentInstanceId, getSessionGeneration, isContextActive, getCurrentLeaderEpoch, getAdmissionScope, getAdmissionJournalBinding, captureThreadNameRecipientAuthority, } = deps;
            const configStore = deps.configStore, threadStore = deps.threadStore;
            const getAllowedUserId = configStore.getAllowedUserId;
            if (!sendInteractiveMessage || !target) {
                if (admission)
                    return;
                await deps.sendTextReply(message.chat.id, message.message_id, Commands.formatBaleInformationHeading("🏷️", "Usage: /name Navigator"), { parseMode: "HTML", target });
                return;
            }
            const assertRecipient = captureThreadNameRecipientAuthority?.({ ...target }, ctx);
            if (admission && !assertRecipient)
                return;
            const scope = getCurrentInstanceId?.() ?? "local", generation = getSessionGeneration?.();
            const operator = getAllowedUserId(), epoch = getCurrentLeaderEpoch?.();
            const admissionScope = getAdmissionScope?.(), journalBinding = getAdmissionJournalBinding?.();
            const portsCurrent = () => deps.sendInteractiveMessage === sendInteractiveMessage &&
                deps.configStore === configStore &&
                configStore.getAllowedUserId === getAllowedUserId &&
                deps.threadStore === threadStore &&
                deps.getCurrentInstanceId === getCurrentInstanceId &&
                deps.getSessionGeneration === getSessionGeneration &&
                deps.isContextActive === isContextActive &&
                deps.getCurrentLeaderEpoch === getCurrentLeaderEpoch &&
                deps.getAdmissionScope === getAdmissionScope &&
                deps.getAdmissionJournalBinding === getAdmissionJournalBinding &&
                deps.captureThreadNameRecipientAuthority ===
                    captureThreadNameRecipientAuthority;
            const isCurrent = () => {
                assertSelectedRecipient?.();
                assertRecipient?.();
                const current = portsCurrent() &&
                    (!isContextActive || isContextActive(ctx) === true) &&
                    getAllowedUserId() === operator &&
                    getCurrentLeaderEpoch?.() === epoch &&
                    getAdmissionScope?.() === admissionScope &&
                    getAdmissionJournalBinding?.() === journalBinding &&
                    (getCurrentInstanceId?.() ?? "local") === scope &&
                    getSessionGeneration?.() === generation;
                assertRecipient?.();
                assertSelectedRecipient?.();
                return current && portsCurrent();
            };
            // This delivery guard outlives input settlement; it never borrows the expiring dialog handle.
            const assertAuthority = assertRecipient
                ? () => {
                    if (!isCurrent())
                        throw new Error("Bale Thread name dialog lost recipient authority.");
                }
                : undefined;
            // Reserve the exact existing owner entry before delivery; late results cannot replace a successor.
            const lifetime = threadNameDialog.prepare({
                scope,
                target,
                isCurrent,
                assertAuthority,
            });
            if (!lifetime)
                return;
            let published = false;
            try {
                const hasManualName = threadStore
                    ?.listWorkspaceBindings()
                    .some((binding) => binding.target.chatId === target.chatId &&
                    binding.target.threadId === target.threadId &&
                    typeof binding.manualThreadName === "string") ?? false;
                const instructions = hasManualName
                    ? "<b>🏷️ Send a new Thread name using printable ASCII, reset to automatic, or cancel.</b>"
                    : "<b>🏷️ Send a Thread name using printable ASCII, or cancel.</b>";
                const buttons = hasManualName
                    ? [
                        {
                            text: "↩️ Reset to automatic",
                            callback_data: "thread-name:reset",
                        },
                        { text: "✖ Cancel rename", callback_data: "thread-name:cancel" },
                    ]
                    : [{ text: "✖ Cancel rename", callback_data: "thread-name:cancel" }];
                assertSemanticCurrent?.();
                if (!lifetime.isCurrent())
                    return;
                const dialogMessageId = await sendInteractiveMessage(target.chatId, instructions, "html", { inline_keyboard: buttons.map((button) => [button]) }, {
                    target: { ...target },
                    ...(assertAuthority ? { assertAuthority } : {}),
                });
                assertAuthority?.();
                assertSemanticCurrent?.();
                if (typeof dialogMessageId === "number")
                    published = !!lifetime.publish(dialogMessageId, assertSemanticCurrent);
                if (published)
                    return {
                        assertPublished() {
                            if (!lifetime.isCurrent())
                                throw new Error("Bale Thread name dialog publication is no longer current.");
                        },
                    };
            }
            finally {
                if (!published)
                    lifetime.finish();
            }
        },
        getPromptTemplateCommands,
        sendTextReply: deps.sendTextReply,
        markActiveTurnNextAbortAnnouncement: deps.activeTurnRuntime.markNextAbortAnnouncement,
        getActiveTurnReply: () => {
            const activeTurn = deps.activeTurnRuntime.get();
            if (!activeTurn)
                return undefined;
            return async (text, options) => {
                await deps.sendTextReply(activeTurn.chatId, activeTurn.replyToMessageId, text, { target: activeTurn.target, parseMode: options?.parseMode });
            };
        },
        sendInteractiveMessage: deps.sendInteractiveMessage,
        recordRuntimeEvent: deps.recordRuntimeEvent,
    });
    const promptEnqueueController = Queue.createBalePromptEnqueueController({
        ...deps.baleQueueStore,
        hasPendingDispatch: deps.bridgeRuntime.lifecycle.hasDispatchPending,
        getFoldQueuedPromptsIntoHistory: deps.bridgeRuntime.lifecycle.shouldFoldQueuedPromptsIntoHistory,
        setFoldQueuedPromptsIntoHistory: deps.bridgeRuntime.lifecycle.setFoldQueuedPromptsIntoHistory,
        prepareTurn: async (messages, turnCtx) => {
            const buildTurn = await preparePromptTurn(messages, turnCtx);
            return (historyTurns) => {
                const turn = buildTurn(historyTurns);
                return turn.replyToMessageId > 0
                    ? turn
                    : { ...turn, replyToMessageId: 0 };
            };
        },
        updateStatus: deps.updateStatus,
        dispatchNextQueuedBaleTurn: requestDispatchNextQueuedBaleTurn,
        assertExecutionCurrent: (messages) => Updates.assertBaleUpdateExecutionCurrent(messages[0]),
    });
    const promptEnqueue = async (messages, ctx) => {
        return promptEnqueueController.enqueue(messages, ctx, (turn) => {
            reportQueueAdmission(messages, turn.admissionReceipts ?? []);
        });
    };
    const continueLiveRebindPrompt = (originals, ctx, selectedTarget, isCurrent) => continueLiveRebindInput(originals, ctx, selectedTarget, isCurrent);
    const continueLiveRebindInput = async (originals, ctx, selectedTarget, isCurrent, generated) => {
        const messages = [...originals], target = { ...selectedTarget };
        const operatorUserId = deps.configStore.getAllowedUserId(), journalBindingKey = deps.getAdmissionJournalBinding?.();
        const scope = deps.getAdmissionScope?.(), generation = deps.getSessionGeneration?.();
        const sources = messages.map(Updates.inspectBaleDeferredSource);
        const fences = messages.map(Updates.getBaleUpdateExecutionFence);
        const ids = Updates.collectBaleAdmissionSourceUpdateIds(messages);
        const current = () => isCurrent() &&
            !!operatorUserId &&
            !!journalBindingKey &&
            !!scope &&
            generation !== undefined &&
            deps.isContextActive?.(ctx) === true &&
            deps.getSessionGeneration?.() === generation &&
            deps.configStore.getAllowedUserId() === operatorUserId &&
            deps.getAdmissionScope?.() === scope &&
            deps.getAdmissionJournalBinding?.() === journalBindingKey &&
            messages.length > 0 &&
            ids.length === messages.length &&
            Number.isSafeInteger(target.threadId) &&
            target.threadId > 0 &&
            messages.every((message, index) => message.chat.type === "private" &&
                message.chat.id === target.chatId &&
                message.from?.id === operatorUserId &&
                !message.from?.is_bot &&
                fences[index]?.isCurrent() === true &&
                Updates.getBaleUpdateExecutionFence(message) === fences[index] &&
                sources[index]?.journalBindingKey === journalBindingKey &&
                !sources[index]?.completionSha256);
        const assertCurrent = () => {
            generated?.assertRegistrationCurrent();
            if (!current() ||
                !messages.every((message, index) => isDeepStrictEqual(Updates.inspectBaleDeferredSource(message), sources[index])))
                throw new Error("Live-rebind input admission authority changed.");
        };
        const references = [];
        let admitted = false;
        try {
            assertCurrent();
            for (const message of messages)
                references.push(Updates.acquireBaleUpdateRouting(message));
            assertCurrent();
            const routed = messages.map((message) => {
                const sameTarget = message.message_thread_id === target.threadId;
                return Updates.carryBaleUpdateExecutionFence(message, {
                    ...message,
                    message_thread_id: target.threadId,
                    ...(sameTarget ? {} : { message_id: 0, reply_to_message: undefined }),
                });
            });
            const enqueue = async (values, turnCtx) => {
                assertCurrent();
                await promptEnqueueController.enqueue(values, turnCtx, (turn) => {
                    assertCurrent();
                    admitted = Updates.reportBaleQueueAdmission(messages, turn.admissionReceipts ?? []);
                    if (!admitted)
                        throw new Error("Live-rebind original receipt admission was not confirmed.");
                }, { preserveQueued: true, assertCurrent });
            };
            if (generated) {
                if (routed.length !== 1)
                    return false;
                await Queue.enqueueBalePromptTurnRuntime(routed, {
                    ...deps.baleQueueStore,
                    hasPendingDispatch: deps.bridgeRuntime.lifecycle.hasDispatchPending,
                    getFoldQueuedPromptsIntoHistory: deps.bridgeRuntime.lifecycle.shouldFoldQueuedPromptsIntoHistory,
                    setFoldQueuedPromptsIntoHistory: deps.bridgeRuntime.lifecycle.setFoldQueuedPromptsIntoHistory,
                    preserveQueued: true,
                    assertExecutionCurrent: assertCurrent,
                    async prepareTurn(values) {
                        // Only the captured producer text enters the normal turn builder; raw command media/handlers never run.
                        const turn = await Turns.buildBalePromptTurnRuntime({
                            messages: values,
                            balePrefix: Turns.createBaleTurnPrefix({
                                thread: resolveBaleThreadLabel(values[0]),
                            }),
                            rawText: generated.prompt,
                            files: [],
                            queueOrder: deps.bridgeRuntime.queue.allocateItemOrder(),
                            inferImageMimeType: Media.guessMediaType,
                            timeLine: deps.resolveTimeLine?.(target.chatId),
                            voiceReplyMode: getBaleVoiceReplyMode(deps.configStore.get()),
                            admissionScope: scope,
                            admissionJournalBinding: journalBindingKey,
                        });
                        assertCurrent();
                        if (turn.kind !== "prompt" ||
                            turn.queueLane !== "default" ||
                            turn.historyText !== generated.prompt ||
                            !isDeepStrictEqual(turn.target, target) ||
                            turn.admissionReceipts?.length !== 1 ||
                            turn.admissionReceipts[0]?.queueKind !== "prompt" ||
                            turn.admissionReceipts[0]?.journalBindingKey !==
                                journalBindingKey ||
                            !isDeepStrictEqual(turn.admissionReceipts[0]?.sourceUpdateIds, ids))
                            throw new Error("Live-rebind generated payload/receipt changed.");
                        return (history) => {
                            if (history.length)
                                throw new Error("Live-rebind generated admission cannot fold queued history.");
                            return turn;
                        };
                    },
                    onQueued(turn) {
                        assertCurrent();
                        generated.onQueued(turn);
                        admitted = Updates.reportBaleQueueAdmission(messages, turn.admissionReceipts ?? []);
                        if (!admitted)
                            throw new Error("Live-rebind generated receipt report was not confirmed.");
                    },
                    updateStatus: () => deps.updateStatus(ctx),
                    dispatchNextQueuedBaleTurn: () => requestDispatchNextQueuedBaleTurn(ctx),
                });
            }
            else
                await enqueue(routed, ctx);
            return admitted && current();
        }
        catch (error) {
            deps.recordRuntimeEvent?.("routing", error, {
                phase: "live-rebind-input-admission",
            });
            return false;
        }
        finally {
            for (const release of references)
                release();
        }
    };
    const recordUnboundTemporaryThreadInput = async (messages, ctx) => {
        const message = messages[0], target = message && Updates.getBaleMessageTarget(message);
        const store = deps.getWorkspaceRestoreStore?.();
        if (!target?.threadId || !store)
            return false;
        let found = store
            .listTemporaryThreads()
            .find((entry) => entry.phase === "created" &&
            entry.target &&
            entry.target.chatId === target.chatId &&
            entry.target.threadId === target.threadId);
        const key = formatBaleTargetKey(target), implicit = implicitThreadCreations.get(key);
        if (!found && !implicit)
            return false;
        const updateIds = Updates.collectBaleAdmissionSourceUpdateIds(messages);
        const operatorUserId = deps.configStore.getAllowedUserId();
        const cap = captureTemporaryThreadAuthority(ctx, () => messages.every((source) => Updates.getBaleUpdateExecutionFence(source)?.isCurrent() ===
            true &&
            source.chat.type === "private" &&
            source.chat.id === target.chatId &&
            source.message_thread_id === target.threadId &&
            source.from?.id === operatorUserId &&
            source.from?.is_bot === false));
        if (!found && implicit) {
            // The first live input group (one message or an album) adopts the native tab, whatever its kind.
            if (!deps.runWorkspaceOperation ||
                !cap ||
                implicit.ctx !== ctx ||
                implicit.operatorUserId !== cap.operatorUserId ||
                implicit.journalBindingKey !== cap.journalBindingKey ||
                !isDeepStrictEqual(implicit.executor, cap.authority.executor) ||
                implicit.generation !== deps.getSessionGeneration?.() ||
                implicit.scope !== deps.getAdmissionScope?.() ||
                !updateIds.length ||
                updateIds.some((id) => id <= implicit.updateId) ||
                !cap.isCurrent()) {
                implicitThreadCreations.delete(key);
                return false;
            }
            found = store.registerImplicitTemporaryThread({ journalBindingKey: cap.journalBindingKey, updateIds }, { chatId: target.chatId, threadId: target.threadId }, randomBytes(16).toString("hex"), {
                ...cap.authority,
                isCurrent: () => cap.isCurrent() && implicitThreadCreations.get(key) === implicit,
            });
            if (!found || !cap.isCurrent())
                throw new Error("Implicit Bale Thread registration was not acknowledged; source remains protected.");
            implicitThreadCreations.delete(key);
            // Adopted native tabs share the routing name; a failed rename never blocks routing.
            try {
                await deps.callApi?.("editForumTopic", {
                    chat_id: target.chatId,
                    message_thread_id: target.threadId,
                    name: BALE_TEMPORARY_THREAD_NAME,
                });
            }
            catch (error) {
                deps.recordRuntimeEvent?.("routing", error, {
                    phase: "temporary-thread-name",
                });
            }
        }
        if (!found)
            return false;
        cancelTemporaryThreadCleanup(found.token);
        if (!deps.runWorkspaceOperation ||
            !cap ||
            cap.operatorUserId !== found.operatorUserId ||
            cap.journalBindingKey !== found.source.journalBindingKey ||
            !updateIds.length ||
            !cap.isCurrent()) {
            throw new Error("Temporary Thread input membership requires exact current source authority.");
        }
        // The caller already holds the profile Workspace admission (the non-reentrant gate): no nested operation here.
        let entry = store
            .listTemporaryThreads()
            .find((value) => value.token === found.token &&
            isDeepStrictEqual(value.source, found.source) &&
            isDeepStrictEqual(value.target, target));
        if (!entry)
            throw new Error("Temporary Thread input target changed before membership publication.");
        entry = cap.adopt(entry);
        if (!entry ||
            !cap.isCurrent() ||
            !store.recordTemporaryThreadInput(entry, { journalBindingKey: cap.journalBindingKey, updateIds }, cap.authority) ||
            !cap.isCurrent()) {
            throw new Error("Temporary Thread input membership was not acknowledged; the source remains protected.");
        }
        return true;
    };
    /** Publishes a root chooser; a revived source edits its recorded chooser back to life instead of posting another. */
    const publishRerouteChooser = async (pending, text, replyMarkup, sendOptions) => {
        const target = pending.sourceTarget;
        const recorded = Updates.getBaleUpdateRoutingInput(pending.messages[0])?.chooser;
        if (recorded &&
            deps.editInteractiveMessage &&
            recorded.chatId === target.chatId &&
            recorded.threadId === target.threadId) {
            try {
                await deps.editInteractiveMessage(recorded.chatId, recorded.messageId, text, "html", replyMarkup);
                return recorded.messageId;
            }
            catch (error) {
                // The old chooser may be gone; a fresh one keeps the same saved deadline.
                deps.recordRuntimeEvent?.("routing", error, {
                    phase: "chooser-revival",
                });
            }
        }
        return deps.sendInteractiveMessage(target.chatId, text, "html", replyMarkup, sendOptions);
    };
    const sendUnboundRerouteChooserNow = async (messages, ctx, reportDeferred = true) => {
        const message = messages[0];
        if (!message || !deps.threadStore)
            return;
        const records = deps.threadStore.list();
        const activeRecords = getBaleRoutableThreadRecords(records, deps.getLiveThreadTargets?.());
        const sourceTarget = typeof message.message_thread_id === "number"
            ? { chatId: message.chat.id, threadId: message.message_thread_id }
            : undefined;
        const sourceKey = sourceTarget
            ? formatBaleTargetKey(sourceTarget)
            : undefined;
        const includeGuidance = sourceKey
            ? !guidedUnboundTopicKeys.has(sourceKey)
            : true;
        if (sourceKey)
            guidedUnboundTopicKeys.add(sourceKey);
        if (activeRecords.length === 0) {
            await deps.sendTextReply(message.chat.id, message.message_id, [
                includeGuidance ? formatBaleUnboundTopicGuidance() : undefined,
                `This thread is not bound to a Pi instance. Open an active Pi thread or run ${Commands.formatBalePiCommandHtml("/bale-connect")} from a Pi session to bind one.`,
            ]
                .filter((line) => typeof line === "string")
                .join("\n\n"), { parseMode: "HTML", target: sourceTarget });
            return;
        }
        const command = messages.length === 1
            ? getKnownBaleAllTabCommand(Media.extractFirstBaleMessageText(messages).trim())
            : undefined;
        const rerouteId = storePendingUnboundReroute(messages, command ? "command" : "prompt");
        if (reportDeferred) {
            for (const source of messages) {
                Updates.reportBaleUpdateDeferred(source);
            }
        }
        const inTemporaryThread = await recordUnboundTemporaryThreadInput(messages, ctx);
        const pending = pendingUnboundReroutes.get(rerouteId);
        if (inTemporaryThread)
            pending.temporaryMembership = true;
        // Any input kind, single or grouped, is cancellable once every source can be retained privately.
        if (sourceTarget &&
            deps.runWorkspaceOperation &&
            deps.editInteractiveMessage &&
            deps.getAdmissionJournalBinding &&
            deps.getCurrentLeaderEpoch &&
            deps.isContextActive?.(ctx) === true) {
            const ownerUserId = deps.configStore.getAllowedUserId();
            const journalBindingKey = deps.getAdmissionJournalBinding();
            if (ownerUserId !== undefined &&
                journalBindingKey &&
                messages.every((source) => source.chat.type === "private" &&
                    source.from?.id === ownerUserId &&
                    Updates.getBaleUpdateExecutionFence(source)?.isCurrent() ===
                        true &&
                    Updates.supportsBaleDeferredAbandonment(source, journalBindingKey))) {
                const leaderEpoch = deps.getCurrentLeaderEpoch();
                if (leaderEpoch !== undefined)
                    pending.abandonment = { ownerUserId, journalBindingKey, leaderEpoch };
            }
        }
        const text = formatBaleTemporaryThreadChooserText(command?.name);
        pending.rootChooserText = text;
        const replyMarkup = buildBaleUnboundRerouteChooserMarkup(rerouteId, activeRecords, {
            canRestore: sourceTarget !== undefined,
            canCancel: !!pending.abandonment,
            getDisplayTitle: deps.getDisplayTitle,
        });
        if (deps.sendInteractiveMessage) {
            const chooserId = await publishRerouteChooser(pending, text, replyMarkup, sourceTarget
                ? { target: sourceTarget, replyToMessageId: message.message_id }
                : { replyToMessageId: message.message_id });
            rememberRerouteChooser(rerouteId, chooserId);
            return;
        }
        const chooserId = await deps.sendTextReply(message.chat.id, message.message_id, text, {
            parseMode: "HTML",
            target: sourceTarget,
        });
        rememberRerouteChooser(rerouteId, chooserId);
    };
    const sendUnboundRerouteChooser = async (message, ctx) => {
        const groupKey = Media.getBaleMediaGroupKey(message);
        if (!groupKey) {
            await sendUnboundRerouteChooserNow([message], ctx);
            return;
        }
        const existing = pendingUnboundRerouteMediaGroups.get(groupKey);
        if (existing)
            clearTimeout(existing.timer);
        const messages = [...(existing?.messages ?? []), message];
        const timer = setTimeout(() => {
            pendingUnboundRerouteMediaGroups.delete(groupKey);
            // A media group's timer runs outside any request, so it takes the same profile admission as a single message.
            const send = () => sendUnboundRerouteChooserNow(messages, ctx, false);
            const task = deps.runWorkspaceOperation
                ? deps.runWorkspaceOperation({
                    operationId: `workspace-unbound-group:${groupKey}:${randomBytes(8).toString("hex")}`,
                    operationKind: "workspace.route-unbound-thread",
                    scopes: [{ kind: "profile" }],
                }, send)
                : send();
            void task.catch((error) => {
                deps.recordRuntimeEvent?.("routing", error, {
                    phase: "unbound-media-group-chooser",
                });
            });
        }, 1200);
        timer.unref?.();
        pendingUnboundRerouteMediaGroups.set(groupKey, { messages, timer });
        Updates.reportBaleUpdateDeferred(message);
    };
    const getKnownBaleAllTabCommand = (text) => {
        const command = Commands.parseBaleCommand(text);
        if (!command)
            return undefined;
        if (reservedCommandNames().has(command.name))
            return command;
        if (Commands.findBaleExtensionCommand(command.name))
            return command;
        if (getPromptTemplateCommands().some((template) => template.command === command.name)) {
            return command;
        }
        return undefined;
    };
    /**
     * A fresh implicit native tab observed just before the All input in the same exact scope: mobile names it after
     * the input, while other clients may use a generic name, so the immediately preceding creation also qualifies.
     */
    const findImplicitCreationForAllInput = (message, updateId, cap, ctx) => {
        const text = (message.text ?? message.caption ?? "").trim();
        let match;
        for (const [key, implicit] of implicitThreadCreations) {
            if (((implicit.name && text.startsWith(implicit.name)) ||
                implicit.updateId === updateId - 1) &&
                implicit.updateId < updateId &&
                implicit.createdAtSec > 0 &&
                message.date !== undefined &&
                message.date >= implicit.createdAtSec &&
                message.date - implicit.createdAtSec <=
                    BALE_IMPLICIT_ALL_INPUT_WINDOW_SEC &&
                implicit.ctx === ctx &&
                implicit.operatorUserId === cap.operatorUserId &&
                implicit.journalBindingKey === cap.journalBindingKey &&
                isDeepStrictEqual(implicit.executor, cap.authority.executor) &&
                implicit.generation === deps.getSessionGeneration?.() &&
                implicit.scope === deps.getAdmissionScope?.() &&
                (!match || implicit.updateId > match.implicit.updateId))
                match = { key, implicit };
        }
        return match;
    };
    /**
     * An All input gets one source-bound tab. The original stays deferred in All until explicit routing,
     * and an existing entry is reused on replay, so restart never creates a second tab or retries an unknown one.
     */
    /**
     * Opens (or adopts) the routing tab for input sent from All. One text message may carry a command; anything else,
     * a voice note, a file or a coalesced album, is held untouched as one prompt.
     */
    const sendAllTabTemporaryInputChooser = async (command, commandText, messages, ctx) => {
        const message = messages[0];
        if (!message)
            return false;
        const updateIds = Updates.collectBaleAdmissionSourceUpdateIds([
            ...messages,
        ]).sort((a, b) => a - b);
        const updateId = updateIds[0];
        const group = { journalBindingKey: "", updateIds };
        const execution = Updates.getBaleUpdateExecutionFence(message);
        const cap = captureTemporaryThreadAuthority(ctx, () => execution?.isCurrent() === true);
        if (!cap ||
            !deps.runWorkspaceOperation ||
            !deps.callApi ||
            updateId === undefined ||
            updateIds.length !== messages.length ||
            messages.some((held) => held.chat.type !== "private" ||
                held.chat.id !== cap.operatorUserId ||
                held.from?.id !== cap.operatorUserId) ||
            !cap.isCurrent())
            return false;
        const { store, operatorUserId, journalBindingKey, epoch, authority } = cap, current = cap.isCurrent;
        const source = { journalBindingKey, updateId };
        group.journalBindingKey = journalBindingKey;
        const find = () => store
            .listTemporaryThreads()
            .find((entry) => entry.source.journalBindingKey === journalBindingKey &&
            entry.source.updateId === updateId);
        let entry;
        // A tab opened by this call, by the bot or adopted from the client, gets the input's one forwarded copy; re-entry
        // after a restart finds its tab already prepared and never forwards again.
        let openedNow = false;
        await deps.runWorkspaceOperation({
            operationId: `temporary-thread-${randomBytes(16).toString("hex")}`,
            operationKind: "workspace.temporary-thread",
            scopes: [{ kind: "profile" }],
        }, async () => {
            if (!current())
                return;
            let found = find();
            found = found && cap.adopt(found);
            if (found) {
                entry = found;
                return;
            }
            // Mobile clients sending from All first create a native tab named after the input, then deliver
            // the input itself to All: adopt that tab rather than leaving it behind next to a second one.
            const native = findImplicitCreationForAllInput(message, updateId, cap, ctx);
            if (native) {
                const adopted = store.registerImplicitTemporaryThread(group, native.implicit.target, randomBytes(16).toString("hex"), {
                    ...authority,
                    isCurrent: () => current() &&
                        implicitThreadCreations.get(native.key) === native.implicit,
                });
                if (adopted && current()) {
                    implicitThreadCreations.delete(native.key);
                    entry = adopted;
                    openedNow = true;
                    // Adopted native tabs share the routing name; a failed rename never blocks routing.
                    try {
                        await deps.callApi("editForumTopic", {
                            chat_id: native.implicit.target.chatId,
                            message_thread_id: native.implicit.target.threadId,
                            name: BALE_TEMPORARY_THREAD_NAME,
                        });
                    }
                    catch (error) {
                        deps.recordRuntimeEvent?.("routing", error, {
                            phase: "temporary-thread-name",
                        });
                    }
                    return;
                }
            }
            const reservation = store.reserveTemporaryThread(source, randomBytes(16).toString("hex"), authority, group);
            entry = reservation?.entry;
            if (!reservation?.reserved || !current())
                return;
            let created;
            try {
                // The single creation attempt; any failure leaves `creating` as an unknown outcome, never a retry.
                created = await deps.callApi("createForumTopic", {
                    chat_id: operatorUserId,
                    name: BALE_TEMPORARY_THREAD_NAME,
                });
            }
            catch (error) {
                deps.recordRuntimeEvent?.("routing", error, {
                    phase: "temporary-thread-create",
                });
                return;
            }
            const threadId = created?.message_thread_id;
            if (!current() ||
                typeof threadId !== "number" ||
                !Number.isSafeInteger(threadId) ||
                threadId <= 0)
                return;
            const acknowledged = store.acknowledgeTemporaryThread(reservation.entry, { chatId: operatorUserId, threadId }, authority);
            openedNow = !!acknowledged;
            entry = acknowledged ?? entry;
        });
        if (!current() || !entry)
            throw new Error("Temporary Thread authority changed; the input remains retryable.");
        // Only a lone text message is rewritten for command detection; media keeps its caption and payload.
        const held = messages.length === 1 && typeof message.text === "string"
            ? [
                Updates.carryBaleUpdateExecutionFence(message, {
                    ...message,
                    text: commandText,
                    caption: undefined,
                }),
            ]
            : [...messages];
        if (entry.phase !== "created" || !entry.target) {
            for (const input of held)
                Updates.reportBaleUpdateDeferred(input);
            deps.recordRuntimeEvent?.("routing", new Error(BALE_THREADED_ROUTING_UNAVAILABLE_ERROR), { phase: "temporary-thread-unconfirmed" });
            return true;
        }
        const target = entry.target;
        const records = getBaleRoutableThreadRecords(deps.threadStore?.list() ?? [], deps.getLiveThreadTargets?.());
        const rerouteId = storePendingUnboundReroute(held, command ? "command" : "prompt", target);
        const pending = pendingUnboundReroutes.get(rerouteId);
        pending.temporaryThread = entry;
        pending.allTabCopies = getBaleAllTabSourceMessageIds(messages, target.chatId);
        for (const input of held)
            Updates.reportBaleUpdateDeferred(input);
        // Cancel is offered only when the exact source can still be abandoned; the tab removal needs that retention first.
        if (deps.editInteractiveMessage &&
            held.every((input) => Updates.supportsBaleDeferredAbandonment(input, journalBindingKey))) {
            pending.abandonment = {
                ownerUserId: operatorUserId,
                journalBindingKey,
                leaderEpoch: epoch,
            };
        }
        pending.rootChooserText = formatBaleTemporaryThreadChooserText(command?.name);
        const tabCopyId = openedNow
            ? await moveAllTabSourceIntoTab(pending, target, current)
            : undefined;
        if (!current()) {
            removePendingReroute(rerouteId);
            throw new Error("Temporary Thread source presentation authority changed.");
        }
        if (openedNow &&
            !pending.allTabCopiesForwarded &&
            pending.allTabCopies.length === held.length)
            pending.allTabSourceRetained = true;
        try {
            if (!deps.sendInteractiveMessage)
                throw new Error("Temporary Thread chooser publication is unavailable.");
            const chooserId = await publishRerouteChooser(pending, pending.rootChooserText, buildBaleUnboundRerouteChooserMarkup(rerouteId, records, {
                canRestore: true,
                canCancel: !!pending.abandonment,
                getDisplayTitle: deps.getDisplayTitle,
            }), tabCopyId === undefined
                ? { target }
                : { target, replyToMessageId: tabCopyId });
            rememberRerouteChooser(rerouteId, chooserId);
        }
        catch (error) {
            removePendingReroute(rerouteId);
            throw error;
        }
        return true;
    };
    /** A coalesced album from All requires one routing tab; failure cannot answer in All or discard its source. */
    const routeAllTabAlbum = async (messages, ctx) => {
        if (await sendAllTabTemporaryInputChooser(undefined, "", messages, ctx))
            return;
        throw new Error(BALE_THREADED_ROUTING_UNAVAILABLE_ERROR);
    };
    const dispatchCommandOrPrompt = Commands.createBaleCommandOrPromptDispatcher({
        extractRawText: Media.extractFirstBaleMessageText,
        assertExecutionCurrent(message) {
            Updates.assertBaleUpdateExecutionCurrent(message);
        },
        shouldIgnoreMessages: (messages) => !Media.hasBaleMessagesPromptContent(messages),
        consumeThreadNameInput: async (messages) => {
            const message = messages[0];
            if (!message || messages.length !== 1)
                return false;
            const address = Updates.getBaleMessageTarget(message);
            if (!address)
                return false;
            const target = { ...address }, replyToMessageId = message.message_id;
            const candidate = threadNameDialog.inspect(target);
            if (!candidate || candidate.scope !== getThreadNameDialogScope())
                return false;
            const { validateThreadName, renameCurrentThread, resetCurrentThreadName, sendTextReply, } = deps;
            const lifetime = threadNameDialog.capture(candidate);
            if (!lifetime)
                return false;
            const portsCurrent = () => deps.validateThreadName === validateThreadName &&
                deps.renameCurrentThread === renameCurrentThread &&
                deps.resetCurrentThreadName === resetCurrentThreadName &&
                deps.sendTextReply === sendTextReply;
            const isCurrent = () => portsCurrent() && lifetime.isCurrent() && portsCurrent();
            const assertRecipient = lifetime.assertAuthority;
            const assertInputAuthority = assertRecipient
                ? () => {
                    if (!isCurrent())
                        throw new Error("Bale Thread name input lost owner authority.");
                }
                : undefined;
            const ownerOptions = assertInputAuthority
                ? [{ assertAuthority: assertInputAuthority }]
                : [];
            // Result effects may outlive input settlement, but never recipient or captured-port loss.
            const assertResultAuthority = assertRecipient
                ? () => {
                    assertRecipient();
                    if (!portsCurrent())
                        throw new Error("Bale Thread name result lost port authority.");
                    assertRecipient();
                }
                : undefined;
            const replyOptions = () => ({
                parseMode: "HTML",
                target: { ...target },
                ...(assertResultAuthority
                    ? { assertAuthority: assertResultAuthority }
                    : {}),
            });
            if (!isCurrent()) {
                lifetime.finish();
                return true;
            }
            const name = Media.extractFirstBaleMessageText(messages).trim();
            const reset = /^[A-Z]$/.test(name) && !!resetCurrentThreadName;
            if (!reset) {
                const validationError = validateThreadName?.(name);
                if (!isCurrent()) {
                    lifetime.finish();
                    return true;
                }
                if (!name || validationError) {
                    await sendTextReply(target.chatId, replyToMessageId, validationError
                        ? Commands.formatBaleInvalidInstanceName(validationError)
                        : Commands.formatBaleInformationHeading("⚠️", "Send 1–96 printable ASCII characters."), replyOptions());
                    return true;
                }
            }
            let reopen = false;
            try {
                if (!isCurrent())
                    return true;
                const consumed = lifetime.consumeName(name);
                if (consumed.kind !== "name" || !isCurrent())
                    return true;
                const result = reset
                    ? await resetCurrentThreadName({ ...target }, ...ownerOptions)
                    : await renameCurrentThread?.({ ...target }, consumed.name, ...ownerOptions);
                if (!isCurrent())
                    return true;
                reopen = !result?.ok;
                const replyText = result?.ok && !result.message
                    ? reset
                        ? Commands.formatBaleAutomaticThreadDisplayNameRestoredHeading(result.threadName ?? name)
                        : Commands.formatBaleThreadDisplayNameSavedHeading(result.threadName ?? consumed.name)
                    : Commands.formatBaleInformationHeading(result?.ok ? "✅" : "⚠️", result?.message ??
                        (reset
                            ? "Thread display name reset failed."
                            : "Thread display name update failed."));
                if (result?.ok) {
                    Updates.assertBaleUpdateExecutionCurrent(message);
                    if (!isCurrent())
                        return true;
                    Updates.reportBaleUpdateCompleted(message);
                    if (!isCurrent())
                        return true;
                    // Input completion cannot lend its ended handle to detached recipient/API effects.
                    void sendTextReply(target.chatId, replyToMessageId, replyText, replyOptions()).catch((error) => deps.recordRuntimeEvent?.("bale-command", error, {
                        command: "name",
                        phase: reset ? "reset-result" : "rename-result",
                    }));
                    return true;
                }
                if (!isCurrent())
                    return true;
                await sendTextReply(target.chatId, replyToMessageId, replyText, replyOptions());
                return true;
            }
            finally {
                if (reopen && isCurrent())
                    lifetime.reopen();
                lifetime.finish();
            }
        },
        handleCommand: commandHandler,
        executeExtensionCommand: async (command, message, ctx) => {
            const extensionCommand = Commands.findBaleExtensionCommand(command.name);
            if (!extensionCommand)
                return false;
            const sourceTarget = Updates.getBaleMessageTarget(message);
            const assertExecutionCurrent = Updates.createBaleUpdateExecutionFenceGuard(message);
            try {
                assertExecutionCurrent();
                await extensionCommand.handler({
                    name: command.name,
                    args: command.args,
                    reply: async (text) => {
                        assertExecutionCurrent();
                        await deps.sendTextReply(message.chat.id, message.message_id, text, { target: sourceTarget });
                        assertExecutionCurrent();
                    },
                    enqueuePrompt: async (prompt) => {
                        assertExecutionCurrent();
                        await promptEnqueue([
                            {
                                ...message,
                                text: prompt,
                                caption: undefined,
                            },
                        ], ctx);
                    },
                });
                assertExecutionCurrent();
            }
            catch (error) {
                deps.recordRuntimeEvent?.("bale-command", error, {
                    command: command.name,
                });
                assertExecutionCurrent();
                await deps.sendTextReply(message.chat.id, message.message_id, "Command failed.", { target: sourceTarget });
            }
            return true;
        },
        expandPromptTemplateCommand,
        replaceMessageText: (message, text) => Updates.carryBaleUpdateExecutionFence(message, {
            ...message,
            text,
            caption: undefined,
        }),
        enqueueTurn: async (messages, ctx) => {
            await promptEnqueue(messages, ctx);
        },
    });
    dispatchReroutedCommandMessages = dispatchCommandOrPrompt;
    const mediaDispatch = Media.createBaleMediaGroupDispatchRuntime({
        mediaGroups: deps.mediaGroupRuntime,
        dispatchMessages: dispatchCommandOrPrompt,
        onDeferredMessage: Updates.reportBaleUpdateDeferred,
    });
    const textDispatch = TextGroups.createBaleTextGroupDispatchRuntime({
        textGroups: deps.textGroupRuntime,
        dispatchMessages: dispatchCommandOrPrompt,
        dispatchSingleMessage: mediaDispatch.handleMessage,
        onDeferredMessage: Updates.reportBaleUpdateDeferred,
    });
    const editRuntime = Turns.createBaleQueuedPromptEditRuntime({
        ...deps.baleQueueStore,
        updateStatus: deps.updateStatus,
    });
    const handleBaleTopicLifecycleUpdate = async (lifecycle, ctx) => {
        const assertExecutionCurrent = Updates.createBaleUpdateExecutionFenceGuard(lifecycle.message);
        assertExecutionCurrent();
        await deps.handleBaleTopicLifecycleUpdate?.(lifecycle, ctx);
        assertExecutionCurrent();
        const key = formatBaleTargetKey(lifecycle.target);
        if (lifecycle.kind !== "created" || !deps.threadStore) {
            implicitThreadCreations.delete(key);
            return;
        }
        await deps.threadStore.load();
        assertExecutionCurrent();
        const message = lifecycle.message, created = message.forum_topic_created;
        const [updateId] = Updates.collectBaleAdmissionSourceUpdateIds([
            message,
        ]);
        const cap = captureTemporaryThreadAuthority(ctx, () => Updates.getBaleUpdateExecutionFence(message)?.isCurrent() === true);
        if (created &&
            typeof created === "object" &&
            "is_name_implicit" in created &&
            created.is_name_implicit === true &&
            cap &&
            deps.runWorkspaceOperation &&
            updateId !== undefined &&
            !Updates.isBaleHistoricalInput(message) &&
            message.chat.type === "private" &&
            message.chat.id === cap.operatorUserId &&
            message.from?.id === cap.operatorUserId &&
            message.from.is_bot === false &&
            cap.isCurrent() &&
            implicitThreadCreations.size < 100) {
            implicitThreadCreations.set(key, {
                ctx,
                updateId,
                operatorUserId: cap.operatorUserId,
                journalBindingKey: cap.journalBindingKey,
                executor: structuredClone(cap.authority.executor),
                generation: deps.getSessionGeneration?.(),
                scope: deps.getAdmissionScope?.(),
                target: {
                    chatId: lifecycle.target.chatId,
                    threadId: lifecycle.target.threadId,
                },
                name: "name" in created && typeof created.name === "string"
                    ? created.name
                    : "",
                createdAtSec: message.date ?? 0,
            });
        }
        else
            implicitThreadCreations.delete(key);
    };
    // Answer the guest query immediately so the agent-end edit can replace the
    // early ACK once the turn settles. The ACK is the first placeholder frame and
    // the loop rotates through the remaining frames until the replacement.
    const BALE_GUEST_ACK_HTML = Replies.buildBaleGuestPlaceholderFrame(0);
    const handleAuthorizedBaleGuestMessage = async (guestMessage, ctx) => {
        const assertExecutionCurrent = Updates.createBaleUpdateExecutionFenceGuard(guestMessage);
        assertExecutionCurrent();
        let guestInlineMessageId;
        if (deps.answerGuestQueryForInlineMessage) {
            try {
                guestInlineMessageId = await deps.answerGuestQueryForInlineMessage(guestMessage.guest_query_id, BALE_GUEST_ACK_HTML, { parseMode: "HTML" });
                if (guestInlineMessageId) {
                    deps.startGuestPlaceholder?.(guestInlineMessageId);
                }
                deps.recordRuntimeEvent?.("guest", new Error("Guest ACK answered the guest query"), {
                    phase: "guest-ack-sent",
                    guestQueryId: guestMessage.guest_query_id,
                    hasInlineMessageId: !!guestInlineMessageId,
                });
            }
            catch (error) {
                deps.recordRuntimeEvent?.("guest", error, {
                    phase: "guest-ack-failed",
                    guestQueryId: guestMessage.guest_query_id,
                });
            }
            assertExecutionCurrent();
        }
        // Media messages carry the user's text as a caption.
        const text = guestMessage.text ?? guestMessage.caption ?? "";
        const gm = guestMessage;
        // Build bale prefix with guest context
        const chatRaw = gm.chat;
        const chatType = chatRaw?.type;
        const fromRaw = gm.from;
        const replyMsg = gm.reply_to_message;
        const replyFromRaw = replyMsg?.from;
        const guestBotCallerUser = gm.guest_bot_caller_user;
        const guestBotCallerChat = gm.guest_bot_caller_chat;
        const ownerUserId = deps.configStore.getAllowedUserId();
        const replyPeer = formatBalePromptPeer(replyFromRaw);
        const guestPeer = resolveBaleGuestPromptPeer({
            chatType,
            chat: chatRaw,
            from: fromRaw,
            replyFrom: replyFromRaw,
            guestBotCallerUser,
            guestBotCallerChat,
            ownerUserId,
        });
        const prefixParts = ["bale"];
        if (guestPeer) {
            prefixParts.push(`guest:${guestPeer}`);
        }
        else if (chatType === "private") {
            deps.recordRuntimeEvent?.("guest", new Error("Private Guest Mode remote peer could not be resolved"), {
                phase: "peer-attribution",
                chatId: typeof chatRaw?.id === "number" ? chatRaw.id : undefined,
                fromId: typeof fromRaw?.id === "number" ? fromRaw.id : undefined,
                hasReplyFrom: !!replyFromRaw,
                hasCallerUser: !!guestBotCallerUser,
                hasCallerChat: !!guestBotCallerChat,
            });
        }
        const balePrefix = `[${prefixParts.join("|")}]`;
        // Extract reply context
        const replyText = replyMsg
            ? (replyMsg.text || replyMsg.caption || "").trim()
            : "";
        // Download files, run inbound handlers
        const guestMsg = guestMessage;
        // Guest message IDs belong to the peer's chat; scope files to that peer so they cannot collide with bot-chat files.
        const guestScope = resolveBaleGuestFileScope({
            chatType,
            chat: chatRaw,
            from: fromRaw,
            replyFrom: replyFromRaw,
            guestBotCallerUser,
            guestBotCallerChat,
            ownerUserId,
        });
        const downloadGuestFile = (fileId, fileName, source) => deps.downloadFile(fileId, fileName, source ? { ...source, scope: guestScope } : source);
        const replyFiles = guestMsg.reply_to_message
            ? await Media.downloadBaleMessageFiles([guestMsg.reply_to_message], { downloadFile: downloadGuestFile })
            : [];
        assertExecutionCurrent();
        const processedReply = replyFiles.length > 0
            ? await deps.inboundHandlerRuntime.process(replyFiles, "", ctx)
            : undefined;
        assertExecutionCurrent();
        const files = await Media.downloadBaleMessageFiles([guestMsg], {
            downloadFile: downloadGuestFile,
        });
        assertExecutionCurrent();
        const processed = await deps.inboundHandlerRuntime.process(files, text, ctx);
        assertExecutionCurrent();
        const rawText = processed.rawText || text;
        let sourceContext = "";
        if (replyMsg) {
            const replyHeader = replyPeer ? `[reply|from:${replyPeer}]` : "[reply]";
            const replyBlock = replyText
                ? `${replyHeader} ${replyText}`
                : replyHeader;
            sourceContext = appendBaleSourceAttachmentSection(replyBlock, replyPeer, processedReply?.promptFiles ?? replyFiles, processedReply?.handlerOutputs);
        }
        const promptText = Turns.buildBaleTurnPrompt({
            balePrefix,
            rawText,
            files,
            promptFiles: processed.promptFiles,
            handlerOutputs: processed.handlerOutputs,
            sourceContext,
            // Guest Mode allows exactly one reply within Bale's limited response
            // window; the note travels with the turn text so the agent sees it at
            // execution time without a guest-specific system prompt variant.
            guestTurn: true,
        });
        const order = deps.bridgeRuntime.queue.allocateItemOrder();
        const content = [
            { type: "text", text: promptText },
        ];
        for (const file of processed.promptFiles) {
            if (file.isImage && file.mimeType) {
                try {
                    const buffer = await readFile(file.path);
                    assertExecutionCurrent();
                    content.push({
                        type: "image",
                        data: Buffer.from(buffer).toString("base64"),
                        mimeType: file.mimeType,
                    });
                }
                catch {
                    // skip unreadable files
                }
            }
        }
        const admissionReceipts = createAdmissionReceipts("prompt", [guestMessage]);
        const guestTurn = {
            kind: "prompt",
            chatId: 0,
            replyToMessageId: 0,
            guestQueryId: guestMessage.guest_query_id,
            ...(guestInlineMessageId ? { guestInlineMessageId } : {}),
            sourceMessageIds: [],
            queueOrder: order,
            queueLane: "default",
            laneOrder: order,
            queuedAttachments: [],
            content,
            historyText: Turns.formatBaleTurnStatusSummary(processed.rawText || text, processed.promptFiles, processed.handlerOutputs),
            statusSummary: Turns.truncateBaleQueueSummary(processed.rawText || text),
            ...(admissionReceipts.length > 0 ? { admissionReceipts } : {}),
        };
        const items = deps.baleQueueStore.getQueuedItems();
        Updates.assertBaleUpdateExecutionCurrent(guestMessage);
        deps.baleQueueStore.setQueuedItems(Queue.appendBaleQueueItem(items, guestTurn));
        reportQueueAdmission([guestMessage], admissionReceipts);
        deps.updateStatus(ctx);
        requestDispatchNextQueuedBaleTurn(ctx);
    };
    const runtime = Updates.createBalePairedUpdateRuntime({
        getAllowedUserId: deps.configStore.getAllowedUserId,
        getCurrentInstanceId: deps.getCurrentInstanceId,
        getMessageOwnership: deps.getMessageOwnership,
        getTargetOwnership: deps.getTargetOwnership,
        recordMessageOwnership: deps.recordMessageOwnership,
        handleBaleTopicLifecycleUpdate,
        foreignOwnedUpdateForwarder: deps.foreignOwnedUpdateForwarder,
        persistAllowedUserId: deps.configStore.persistAllowedUserId,
        updateStatus: deps.updateStatus,
        removePendingMediaGroupMessages: deps.mediaGroupRuntime.removeMessages,
        flushPendingMediaGroupMessage: deps.mediaGroupRuntime.flushMessage,
        flushPendingTextGroupMessage: deps.textGroupRuntime.flushMessage,
        removeQueuedBaleTurnsByMessageIds: deps.queueMutationRuntime.removeByMessageIds,
        applyQueuedBaleTurnReactionByMessageId: deps.queueMutationRuntime.applyReactionByMessageId,
        answerCallbackQuery: deps.answerCallbackQuery,
        answerGuestQuery: deps.answerGuestQuery,
        handleAuthorizedBaleCallbackQuery: callbackHandler,
        sendTextReply: deps.sendTextReply,
        handleAuthorizedBaleMessage: async (message, ctx) => {
            const assertExecutionCurrent = Updates.createBaleUpdateExecutionFenceGuard(message);
            assertExecutionCurrent();
            if (typeof message.message_thread_id === "number") {
                await deps.handleBaleThreadTargetObserved?.({
                    chatId: message.chat.id,
                    threadId: message.message_thread_id,
                }, ctx);
                assertExecutionCurrent();
            }
            const text = Media.extractFirstBaleMessageText([
                message,
            ]).trim();
            if (deps.threadStore && typeof message.message_thread_id !== "number") {
                await deps.threadStore.load();
                assertExecutionCurrent();
                if (deps.threadStore.getBotState().threadMode === "disabled") {
                    await textDispatch.handleMessage(message, ctx);
                    return;
                }
                const records = deps.threadStore.list();
                const bindings = getBaleRoutableThreadRecords(records, deps.getLiveThreadTargets?.());
                const command = getKnownBaleAllTabCommand(text);
                const [sourceUpdateId] = Updates.collectBaleAdmissionSourceUpdateIds([message]);
                const presented = sourceUpdateId !== undefined &&
                    deps
                        .getWorkspaceRestoreStore?.()
                        ?.listTemporaryThreads()
                        .some((entry) => entry.source.updateId === sourceUpdateId &&
                        entry.source.journalBindingKey ===
                            deps.getAdmissionJournalBinding?.()) === true;
                const needsThread = deps.threadStore.getBotState().threadMode === "enabled" || bindings.length > 0 || presented;
                // Returning before deferral lets the admission worker terminally settle expired replay; a presented tab is not expiry.
                if (command &&
                    command.name !== "thread" &&
                    !presented &&
                    isBaleAllTabCommandExpired(message))
                    return;
                if (needsThread &&
                    typeof message.text === "string" &&
                    message.text.trim() &&
                    (await sendAllTabTemporaryInputChooser(command, text, [message], ctx)))
                    return;
                // Voice notes, files, stickers and albums from All get the same routing tab as text, whether or not the
                // client opened a tab for them; an album first gathers into one input so it opens one tab.
                if (!command &&
                    needsThread &&
                    typeof message.text !== "string" &&
                    Media.hasBaleMessagesPromptContent([message])) {
                    if (message.media_group_id) {
                        deps.mediaGroupRuntime.queueMessage({
                            message: message,
                            context: ctx,
                            dispatchMessages: (messages, queuedCtx) => routeAllTabAlbum(messages, queuedCtx ?? ctx),
                        });
                        Updates.reportBaleUpdateDeferred(message);
                        return;
                    }
                    if (await sendAllTabTemporaryInputChooser(undefined, text, [message], ctx))
                        return;
                }
                if (needsThread) {
                    const probeTarget = bindings[0]?.target;
                    if (!command && !text.startsWith("/") && probeTarget?.threadId && deps.callApi) {
                        try {
                            await deps.callApi("sendChatAction", {
                                chat_id: probeTarget.chatId,
                                message_thread_id: probeTarget.threadId,
                                action: "typing",
                            });
                        }
                        catch (error) {
                            if (Threads.isBaleTopicModeUnavailableError(error)) {
                                deps.threadStore.setBotState({
                                    threadMode: "disabled",
                                    updatedAtMs: Date.now(),
                                    lastReconcileAction: "thread-mode-unavailable-threadless-prompt",
                                });
                                await deps.threadStore.persist();
                                assertExecutionCurrent();
                                await textDispatch.handleMessage(message, ctx);
                                return;
                            }
                            deps.recordRuntimeEvent?.("bale", error, {
                                phase: "threadless-topic-capability-check",
                                chatId: probeTarget.chatId,
                                threadId: probeTarget.threadId,
                            });
                        }
                    }
                    throw new Error(BALE_THREADED_ROUTING_UNAVAILABLE_ERROR);
                }
            }
            await textDispatch.handleMessage(message, ctx);
        },
        handleAuthorizedBaleEditedMessage: editRuntime.updateFromEditedMessage,
        handleAuthorizedBaleGuestMessage,
        handleUnboundBaleTopicMessage: (message, ctx) => {
            const operation = async () => {
                const assertExecutionCurrent = Updates.createBaleUpdateExecutionFenceGuard(message);
                assertExecutionCurrent();
                if (!deps.threadStore) {
                    await textDispatch.handleMessage(message, ctx);
                    return;
                }
                await deps.threadStore.load();
                assertExecutionCurrent();
                if (Updates.isBaleHistoricalInput(message, (entry) => reviewMessage(entry) !== undefined) &&
                    isReviewText(message) &&
                    deps.getCurrentLeaderEpoch?.() !== undefined &&
                    needsHistoricalReview(message)) {
                    if (!Updates.reportBaleHistoricalRoutingReview(message))
                        throw new Error("Historical routing hold is unavailable.");
                    return;
                }
                if (deps.threadStore.getBotState().threadMode === "disabled") {
                    await textDispatch.handleMessage(message, ctx);
                    return;
                }
                const target = Updates.getBaleMessageTarget(message);
                if (!target?.threadId) {
                    await textDispatch.handleMessage(message, ctx);
                    return;
                }
                const text = Media.extractFirstBaleMessageText([
                    message,
                ]).trim();
                const instanceId = deps.getCurrentInstanceId?.();
                const leaderProfileKey = getLeaderTopicProfileKey(ctx, instanceId);
                const unboundTarget = {
                    chatId: target.chatId,
                    threadId: target.threadId,
                };
                /** Rebinds the leader record to this unbound tab, publishes its identity and handles the message there. */
                // The leader's own Workspace binding follows a reclaimed tab, keeping its slot and name; without it, the tab
                // would gain a second slot while Restore, labels and titles still pointed at the deleted target.
                const leaderWorkspaceCwd = typeof ctx.cwd === "string"
                    ? ctx.cwd
                    : undefined;
                const claimLeaderWorkspaceBinding = () => {
                    const sessionId = deps.workspaceRestoreRecipient?.getSessionId(ctx);
                    if (!leaderWorkspaceCwd || !sessionId || !instanceId)
                        return undefined;
                    const identity = deps.threadStore.claimWorkspaceIdentity(leaderWorkspaceCwd, instanceId, undefined, { existingBindingOnly: true, sessionId });
                    const binding = identity
                        ? deps.threadStore.getWorkspaceBinding(identity.cwd, identity.instanceSlot, identity.sessionId)
                        : undefined;
                    if (!binding)
                        deps.threadStore.releaseWorkspaceClaim(instanceId);
                    return binding;
                };
                const reclaimUnboundTargetForLeader = async (base, profileKey, slot, threadName, event, details, leaderBinding) => {
                    if (leaderBinding) {
                        const { inactiveSinceMs: _inactiveSinceMs, displayTitle: _displayTitle, ...moved } = leaderBinding;
                        const committed = deps.threadStore.upsertWorkspaceBinding({
                            ...moved,
                            target: { ...unboundTarget },
                            updatedAtMs: Date.now(),
                        }, instanceId);
                        deps.threadStore.releaseWorkspaceClaim(instanceId);
                        if (committed)
                            threadName = committed.threadName ?? threadName;
                    }
                    deps.threadStore.upsert({
                        ...base,
                        profileKey,
                        owner: {
                            kind: "leader",
                            cwd: typeof ctx.cwd === "string"
                                ? ctx.cwd
                                : undefined,
                            instanceId,
                        },
                        target: { ...unboundTarget },
                        status: "active",
                        updatedAtMs: Date.now(),
                        threadName,
                        instanceId,
                        slot,
                    });
                    await deps.threadStore.persist();
                    assertExecutionCurrent();
                    deps.setCurrentLeaderIdentity?.({
                        target: { ...unboundTarget },
                        slot,
                        threadName,
                    });
                    deps.recordRuntimeEvent?.("bus", event, {
                        ...details,
                        ...unboundTarget,
                        slot,
                        profileKey,
                    });
                    if (leaderBinding && deps.callApi) {
                        const title = deps.getDisplayTitle?.(unboundTarget);
                        if (title)
                            try {
                                await deps.callApi("editForumTopic", {
                                    chat_id: unboundTarget.chatId,
                                    message_thread_id: unboundTarget.threadId,
                                    name: title,
                                });
                                const current = deps
                                    .threadStore.listWorkspaceBindings()
                                    .find((value) => value.bindingKey === leaderBinding.bindingKey &&
                                    isDeepStrictEqual(value.target, unboundTarget));
                                if (current) {
                                    deps.threadStore.upsertWorkspaceBinding({
                                        ...current,
                                        displayTitle: title,
                                    });
                                    await deps.threadStore.persist();
                                }
                            }
                            catch (error) {
                                deps.recordRuntimeEvent?.("bus", error, {
                                    phase: "leader-topic-reclaim-title",
                                });
                            }
                    }
                    await textDispatch.handleMessage(message, ctx);
                };
                const records = deps.threadStore.list();
                const routableRecords = getBaleRoutableThreadRecords(records, deps.getLiveThreadTargets?.());
                const hasAnyRoutableThread = routableRecords.length > 0;
                const existing = records.find((r) => {
                    return (r.target.chatId === target.chatId &&
                        r.target.threadId === target.threadId);
                });
                if (existing) {
                    const isLeaderTopic = (instanceId && existing.instanceId === instanceId) ||
                        (!!leaderProfileKey && existing.profileKey === leaderProfileKey);
                    if (existing.status === "active" && isLeaderTopic) {
                        if (typeof existing.rerouteConfirmedAtMs !== "number") {
                            const nowMs = Date.now();
                            deps.threadStore.upsert({
                                ...existing,
                                updatedAtMs: nowMs,
                                rerouteConfirmedAtMs: nowMs,
                            });
                            await deps.threadStore.persist();
                            assertExecutionCurrent();
                        }
                        await textDispatch.handleMessage(message, ctx);
                        return;
                    }
                    if (existing.status === "starting") {
                        await deps.sendTextReply(target.chatId, message.message_id, "Instance " +
                            getBaleThreadRecordLabel(existing, deps.getDisplayTitle) +
                            " is starting. Please wait…", { target });
                        return;
                    }
                    if (existing.status === "active") {
                        await deps.sendTextReply(target.chatId, message.message_id, "Instance " +
                            escapeHtml(getBaleThreadRecordLabel(existing, deps.getDisplayTitle)) +
                            ` is not currently registered with the Bale bus. This thread is preserved; retry shortly. If it does not recover, run ${Commands.formatBalePiCommandHtml("/bale-connect")} in that Pi instance.`, { parseMode: "HTML", target });
                        return;
                    }
                    await deps.sendTextReply(target.chatId, message.message_id, "Topic " +
                        (existing.slot ?? "?") +
                        " is " +
                        existing.status +
                        ". Start a Pi instance to claim it.", { target });
                    return;
                }
                const deletedObservation = deps.threadStore
                    .listSyncObservations()
                    .find((observation) => observation.syncStatus === "deleted" &&
                    observation.target.chatId === target.chatId &&
                    observation.target.threadId === target.threadId);
                if (deletedObservation) {
                    deps.recordRuntimeEvent?.("inbound-worker", "Discarded update from a confirmed deleted Bale thread", {
                        phase: "discard-deleted-thread",
                        chatId: target.chatId,
                        threadId: target.threadId,
                        messageId: message.message_id,
                    });
                    return;
                }
                const reservations = deps.threadStore.listReservations();
                const reservation = reservations.find((reservation) => reservation.target.chatId === target.chatId &&
                    reservation.target.threadId === target.threadId);
                if (reservation) {
                    await deps.sendTextReply(target.chatId, message.message_id, "Previous leader thread (" +
                        (reservation.slot ?? "?") +
                        "). Closing and deleting this old topic. Use the current thread tab instead.", { target });
                    await deleteReservedBaleTopicThroughReconciler(deps, { chatId: target.chatId, threadId: target.threadId }, message.message_id);
                    return;
                }
                const command = getKnownBaleAllTabCommand(text);
                if (command && hasAnyRoutableThread) {
                    await sendUnboundRerouteChooser(message, ctx);
                    return;
                }
                if (leaderProfileKey && deps.callApi) {
                    const currentLeaderRecord = records.find((record) => {
                        if (record.status !== "active")
                            return false;
                        if (instanceId && record.instanceId === instanceId)
                            return true;
                        return record.profileKey === leaderProfileKey;
                    });
                    if (currentLeaderRecord &&
                        (currentLeaderRecord.target.chatId !== target.chatId ||
                            currentLeaderRecord.target.threadId !== target.threadId)) {
                        let currentLeaderIsStale = false;
                        try {
                            await deps.callApi("sendChatAction", {
                                chat_id: currentLeaderRecord.target.chatId,
                                message_thread_id: currentLeaderRecord.target.threadId,
                                action: "typing",
                            });
                        }
                        catch (error) {
                            currentLeaderIsStale =
                                Threads.isBaleTopicTargetStaleError(error);
                            if (!currentLeaderIsStale)
                                throw error;
                        }
                        if (currentLeaderIsStale) {
                            const leaderBinding = claimLeaderWorkspaceBinding();
                            const slot = deps.threadStore.allocateSlot(leaderProfileKey, leaderBinding?.slot, leaderBinding?.bindingKey);
                            if (leaderBinding && leaderBinding.slot !== slot)
                                deps.threadStore.releaseWorkspaceClaim(instanceId);
                            if (!slot) {
                                deps.threadStore.markStaleByTarget(currentLeaderRecord.target, "deleted", "Current leader thread is stale during unbound prompt routing.");
                                await deps.threadStore.persist();
                                assertExecutionCurrent();
                                await deps.sendTextReply(target.chatId, message.message_id, BALE_SLOT_CAPACITY_MESSAGE, { target });
                                return;
                            }
                            deps.threadStore.markStaleByTarget(currentLeaderRecord.target, "deleted", "Current leader thread is stale during unbound prompt routing.");
                            const threadName = getRestoredThreadName(currentLeaderRecord, slot);
                            await reclaimUnboundTargetForLeader(currentLeaderRecord, leaderProfileKey, slot, threadName, "Bus leader reclaimed stale-current unbound thread", {
                                phase: "leader-topic-unbound-stale-reclaim",
                                staleThreadId: currentLeaderRecord.target.threadId,
                            }, leaderBinding?.slot === slot ? leaderBinding : undefined);
                            return;
                        }
                    }
                }
                if (leaderProfileKey &&
                    !hasActiveLeaderTopic(records, leaderProfileKey, instanceId) &&
                    !hasAnyRoutableThread) {
                    const priorLeaderRecord = deps.threadStore.getByProfileKey(leaderProfileKey);
                    const priorLeaderIdentity = deps.threadStore.getIdentityByProfileKey(leaderProfileKey);
                    const leaderBinding = claimLeaderWorkspaceBinding();
                    const slot = deps.threadStore.allocateSlot(leaderProfileKey, leaderBinding?.slot ??
                        priorLeaderRecord?.slot ??
                        priorLeaderIdentity?.slot, leaderBinding?.bindingKey);
                    if (leaderBinding && leaderBinding.slot !== slot)
                        deps.threadStore.releaseWorkspaceClaim(instanceId);
                    if (!slot) {
                        await deps.sendTextReply(target.chatId, message.message_id, BALE_SLOT_CAPACITY_MESSAGE, { target });
                        return;
                    }
                    const identityThreadName = priorLeaderIdentity?.threadName &&
                        ThreadNaming.isBaleTopicThreadNameValidForSlot(priorLeaderIdentity.threadName, slot)
                        ? priorLeaderIdentity.threadName
                        : undefined;
                    const threadName = priorLeaderRecord?.threadName ??
                        identityThreadName ??
                        ThreadNaming.chooseBaleThreadName({ slot }) ??
                        "Pi";
                    await reclaimUnboundTargetForLeader({ createdAtMs: priorLeaderRecord?.createdAtMs ?? Date.now() }, leaderProfileKey, slot, threadName, "Bus leader reclaimed unbound thread", { phase: "leader-topic-reclaim" }, leaderBinding?.slot === slot ? leaderBinding : undefined);
                    return;
                }
                await sendUnboundRerouteChooser(message, ctx);
                return;
            };
            if (!deps.runWorkspaceOperation)
                return operation();
            return deps.runWorkspaceOperation({
                operationId: `workspace-unbound:${message.chat.id}:${message.message_id}`,
                operationKind: "workspace.route-unbound-thread",
                scopes: [{ kind: "profile" }],
            }, operation);
        },
    });
    return {
        ...runtime,
        expireRoutingInput,
        shouldReviewHistoricalInput,
        shouldHoldPendingInput,
        forgetPreviousWorld,
        beforeQueueReceiptPublished,
        onQueueReceiptCommitted,
        onQueueReceiptCompleted,
        onUpdateCompleted,
        prepareHeldCommand: commandHandler.prepareHeldCommand,
        canPrepareHeldCommand: commandHandler.canPrepareHeldCommand,
        onSessionSettled,
        onDeliverySettled,
        observeLiveRebindLeaderWork,
        prepareLiveRebindLeaderCleanup,
        prepareLiveRebindFollowerCleanup,
        issueLiveRebindLeaderCleanup,
        issueLiveRebindFollowerCleanup,
        onWorkspaceRestoreRecipientObserved(follower, isCurrent, ctx) {
            if (ctx !== undefined)
                return observeRestoreSettlement({ kind: "recipient", follower, isCurrent }, ctx);
            return undefined;
        },
        continueLiveRebindPrompt,
        async waitForRestoreSettlement() {
            await Promise.all([...restoreSettlementTasks]);
        },
    };
}
export function createBaleAssistantOutputAuthorityRuntime(deps) {
    const getCurrentTarget = () => {
        const preferred = deps.getPreferredTarget();
        if (preferred)
            return { ...preferred };
        const chatId = deps.getFallbackChatId();
        return chatId === undefined ? undefined : { chatId };
    };
    return {
        captureAuthority() {
            const target = getCurrentTarget();
            const directEpoch = deps.ownsDirect() ? deps.getDirectEpoch() : undefined;
            const followerGeneration = deps.isFollowerRegistered()
                ? deps.getFollowerGeneration()
                : undefined;
            return {
                transportStamp: deps.getTransportStamp(),
                route: directEpoch !== undefined
                    ? "direct"
                    : followerGeneration !== undefined
                        ? "follower"
                        : "none",
                directEpoch,
                followerGeneration,
                target,
            };
        },
        isAuthorityActive(authority) {
            if (!deps.isTransportStampActive(authority.transportStamp))
                return false;
            const target = getCurrentTarget();
            if (authority.target === undefined ||
                target?.chatId !== authority.target.chatId ||
                target?.threadId !== authority.target.threadId) {
                return false;
            }
            if (authority.route === "direct") {
                return (deps.ownsDirect() && deps.getDirectEpoch() === authority.directEpoch);
            }
            if (authority.route === "follower") {
                return (!deps.ownsDirect() &&
                    deps.isFollowerRegistered() &&
                    deps.getFollowerGeneration() === authority.followerGeneration);
            }
            return false;
        },
        canDeliver() {
            return deps.ownsDirect() || deps.isFollowerRegistered();
        },
    };
}

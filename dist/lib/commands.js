/**
 * Bale command routing helpers
 * Zones: bale controls, pi agent commands, queue controls
 * Owns Bale slash-command normalization, bot command metadata, pi-side command registration, and command-initiated session replacement orchestration behind runtime ports
 */
import { createHash, randomUUID } from "node:crypto";
import { addAbortListener } from "node:events";
import { isDeepStrictEqual } from "node:util";
import { pairBaleUserIfNeeded, BALE_DEFAULT_PROFILE_NAME, } from "./config.js";
import { isPiStaleContextError } from "./pi.js";
import { createBaleControlItemBuilder, createBaleControlQueueController, createBaleQueueAdmissionReceipt, } from "./queue.js";
import { escapeHtml } from "./rendering.js";
import { formatBaleConnectionFailure, } from "./status.js";
import { BaleApiAuthorityError, } from "./bale-api.js";
import { acquireBaleUpdateRouting, carryBaleUpdateExecutionFence, getBaleUpdateExecutionFence, inspectBaleDeferredSource, prepareBaleDeferredQueueAdmission, reportBaleQueueAdmission, } from "./updates.js";
/** Exact singleton operator-private text command original eligible for a held follower plan. */
export function isBaleSelectedHeldOriginal(update, target, operator, name) {
    if (!update ||
        typeof update !== "object" ||
        Array.isArray(update) ||
        Object.keys(update).some((key) => !["update_id", "message"].includes(key)))
        return false;
    const value = Reflect.get(update, "message");
    if (!value || typeof value !== "object" || Array.isArray(value))
        return false;
    const text = Reflect.get(value, "text"), chat = Reflect.get(value, "chat"), from = Reflect.get(value, "from");
    return (typeof text === "string" &&
        parseBaleCommand(text)?.name === name &&
        value.caption === undefined &&
        value.media_group_id === undefined &&
        chat?.type === "private" &&
        from?.is_bot === false &&
        from.id === operator &&
        chat.id === operator &&
        Number.isSafeInteger(value.message_id) &&
        value.message_id > 0 &&
        typeof operator === "number" &&
        Number.isSafeInteger(operator) &&
        operator > 0 &&
        target.chatId === operator &&
        Number.isSafeInteger(target.threadId) &&
        target.threadId > 0);
}
const BALE_EXTENSION_COMMAND_REGISTRY_KEY = "__piBaleCommandRegistry__";
const BALE_BOT_COMMAND_NAME_PATTERN = /^[a-z0-9_]{1,32}$/;
function getOrCreateBaleCommandRegistry() {
    const existing = globalThis[BALE_EXTENSION_COMMAND_REGISTRY_KEY];
    if (existing &&
        typeof existing === "object" &&
        existing !== null &&
        "commands" in existing &&
        existing.commands instanceof Map) {
        return existing;
    }
    const registry = { commands: new Map() };
    globalThis[BALE_EXTENSION_COMMAND_REGISTRY_KEY] = registry;
    return registry;
}
function normalizeBaleExtensionCommandName(name) {
    return name.trim().replace(/^\/+/, "").toLowerCase();
}
function isBaleExtensionCommandName(name) {
    return BALE_BOT_COMMAND_NAME_PATTERN.test(name);
}
function normalizeBaleExtensionCommandEmoji(emoji) {
    const normalized = emoji?.trim();
    return normalized ? normalized : undefined;
}
export function registerBaleCommand(registration) {
    const name = normalizeBaleExtensionCommandName(registration.name);
    const showInMenu = registration.showInMenu ?? false;
    const emoji = normalizeBaleExtensionCommandEmoji(registration.emoji);
    if (!isBaleExtensionCommandName(name)) {
        throw new Error(`Invalid Bale command name: ${registration.name}`);
    }
    if (showInMenu && !emoji) {
        throw new Error(`Visible Bale command requires emoji: ${name}`);
    }
    if (emoji && emoji.length > 8) {
        throw new Error(`Bale command emoji is too long: ${name}`);
    }
    if (isBaleReservedCommandName(name)) {
        throw new Error(`Bale command conflicts with built-in command: ${name}`);
    }
    const registry = getOrCreateBaleCommandRegistry();
    if (registry.commands.has(name)) {
        throw new Error(`Bale command is already registered: ${name}`);
    }
    const command = {
        name,
        description: registration.description,
        order: registration.order ?? 0,
        showInMenu,
        emoji,
        handler: registration.handler,
        selected: registration.selected
            ? Object.freeze({ prepare: registration.selected.prepare })
            : undefined,
    };
    registry.commands.set(name, command);
    return () => {
        if (registry.commands.get(name) === command)
            registry.commands.delete(name);
    };
}
function getBaleExtensionCommands() {
    return Array.from(getOrCreateBaleCommandRegistry().commands.values()).sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
}
export function findBaleExtensionCommand(name) {
    if (!name)
        return undefined;
    return getOrCreateBaleCommandRegistry().commands.get(normalizeBaleExtensionCommandName(name));
}
/** Preparation only: no execution, admission, source freeze or binding effects. Routing owns those later. */
export async function prepareBaleSelectedExtensionCommand(command, authority) {
    const registration = findBaleExtensionCommand(command.name), selected = registration?.selected;
    const prepare = selected?.prepare;
    if (!registration || !selected || typeof prepare !== "function")
        return undefined;
    const input = Object.freeze({ name: registration.name, args: command.args });
    const { assertSourceCurrent, assertRecipientCurrent } = authority;
    const assertRegistrationCurrent = () => {
        if (findBaleExtensionCommand(input.name) !== registration ||
            registration.selected !== selected ||
            selected.prepare !== prepare)
            throw new Error("Selected extension command registration changed.");
    };
    const assertCurrent = () => {
        assertSourceCurrent();
        assertRecipientCurrent();
        assertRegistrationCurrent();
    };
    try {
        assertCurrent();
        const prepared = await prepare(input);
        assertCurrent();
        if (!prepared || typeof prepared !== "object" || Array.isArray(prepared))
            return undefined;
        const keys = Reflect.ownKeys(prepared), kind = prepared.kind;
        let plan;
        if (kind === "command-only" &&
            keys.length === 2 &&
            keys.includes("kind") &&
            keys.includes("execute")) {
            const execute = prepared.execute;
            if (typeof execute !== "function")
                return undefined;
            plan = { kind, execute };
        }
        else if (kind === "generated-prompt" &&
            keys.length === 2 &&
            keys.includes("kind") &&
            keys.includes("prompt")) {
            const prompt = prepared.prompt;
            if (typeof prompt !== "string" || !prompt.trim())
                return undefined;
            plan = { kind, prompt };
        }
        else
            return undefined;
        // Producer accessors can invalidate authority while the plan is being copied.
        assertCurrent();
        return Object.freeze({
            plan: Object.freeze(plan),
            assertRegistrationCurrent,
        });
    }
    catch {
        return undefined;
    }
}
export function clearBaleExtensionCommands() {
    getOrCreateBaleCommandRegistry().commands.clear();
}
export const BALE_COMMAND_EMOJI = {
    start: "🟢",
    status: "📊",
    model: "🤖",
    thinking: "🧠",
    compact: "🗜",
    queue: "🔢",
    thread: "🧵",
    next: "⏩",
    continue: "▶️",
    abort: "⏹️",
    stop: "🟥",
    name: "🏷️",
    new: "🆕",
};
function getBaleCommandEmoji(command) {
    return BALE_COMMAND_EMOJI[command];
}
export function formatBaleCommandEmojiPrefix(command) {
    return `${getBaleCommandEmoji(command)} `;
}
export function formatBalePiCommandHtml(command) {
    return `<code>${escapeHtml(command)}</code>`;
}
export function formatBaleInformationHeading(emoji, text) {
    return `<b>${escapeHtml(emoji)} ${escapeHtml(text)}</b>`;
}
export function formatBaleInvalidInstanceName(validationError) {
    const details = validationError.replace(/^Invalid Bale (?:instance name|Thread display name):\s*/, "");
    const items = details
        .split(/;\s+|(?<=\.)\s+(?=[A-Z])/)
        .map((item) => item.trim())
        .filter(Boolean)
        .map((item) => (/[.!?]$/.test(item) ? item : `${item}.`))
        .map((item) => item[0].toUpperCase() + item.slice(1));
    return [
        "<b>⚠️ Invalid Thread Display Name:</b>\n",
        ...items.map((item) => `<code>-</code> ${escapeHtml(item)}`),
    ].join("\n");
}
export function formatBaleThreadDisplayNameSavedHeading(name) {
    return `<b>✅ Thread display name saved as <i>${escapeHtml(name)}</i>.</b>`;
}
export function formatBaleAutomaticThreadDisplayNameRestoredHeading(name) {
    return `<b>✅ Automatic Thread display name restored as <i>${escapeHtml(name)}</i>.</b>`;
}
const BALE_COMPACTION_STARTED_TEXT = formatBaleInformationHeading(getBaleCommandEmoji("compact"), "Compaction started.");
const BALE_COMPACTION_COMPLETED_TEXT = formatBaleInformationHeading("✅", "Compaction completed.");
export const BALE_COMPACTION_STARTED_MARKDOWN = `**${formatBaleCommandEmojiPrefix("compact")}Compaction started.**`;
export const BALE_COMPACTION_COMPLETED_MARKDOWN = "**✅ Compaction completed.**";
function formatBaleBotCommandDescription(command, description) {
    return `${formatBaleCommandEmojiPrefix(command)}${description}`;
}
const BALE_BUILTIN_BOT_COMMANDS = [
    {
        command: "start",
        description: formatBaleBotCommandDescription("start", "Open menu / Pair bridge"),
    },
    {
        command: "compact",
        description: formatBaleBotCommandDescription("compact", "Compact current session"),
    },
    {
        command: "new",
        description: formatBaleBotCommandDescription("new", "Start a new session"),
    },
    {
        command: "continue",
        description: formatBaleBotCommandDescription("continue", "Queue continue prompt"),
    },
    {
        command: "next",
        description: formatBaleBotCommandDescription("next", "Force next turn"),
    },
    {
        command: "abort",
        description: formatBaleBotCommandDescription("abort", "Abort Pi"),
    },
    {
        command: "stop",
        description: formatBaleBotCommandDescription("stop", "Abort Pi & Clear queue"),
    },
];
export const BALE_BOT_COMMANDS = BALE_BUILTIN_BOT_COMMANDS;
function getVisibleBaleExtensionBotCommands() {
    return getBaleExtensionCommands()
        .filter((command) => command.showInMenu && command.description)
        .map((command) => ({
        command: command.name,
        description: `${command.emoji} ${command.description ?? command.name}`,
    }));
}
export function getBaleReservedCommandNames() {
    return [
        ...BALE_RESERVED_COMMAND_NAMES,
        ...getBaleExtensionCommands().map((command) => command.name),
    ];
}
export async function registerBaleBotCommands(deps, options) {
    const assertAuthority = options?.assertAuthority, send = deps.setMyCommands;
    const capturedOptions = assertAuthority ? { assertAuthority } : undefined;
    const setMyCommands = async (commands) => {
        assertAuthority?.();
        await send(commands, capturedOptions);
        assertAuthority?.();
    };
    assertAuthority?.();
    const extensionCommands = getVisibleBaleExtensionBotCommands();
    if (extensionCommands.length === 0) {
        await setMyCommands(BALE_BOT_COMMANDS);
        return;
    }
    const nextCommandIndex = BALE_BOT_COMMANDS.findIndex((command) => command.command === "next");
    if (nextCommandIndex === -1) {
        await setMyCommands([...BALE_BOT_COMMANDS, ...extensionCommands]);
        return;
    }
    await setMyCommands([
        ...BALE_BOT_COMMANDS.slice(0, nextCommandIndex + 1),
        ...extensionCommands,
        ...BALE_BOT_COMMANDS.slice(nextCommandIndex + 1),
    ]);
}
export function createBaleBotCommandRegistrar(deps) {
    // Only an identical local lifetime may share an in-flight sync; unguarded calls remain separate.
    const pending = new Map();
    return (options) => {
        const assertAuthority = options?.assertAuthority;
        try {
            assertAuthority?.();
        }
        catch (error) {
            return Promise.reject(error);
        }
        const joined = pending.get(assertAuthority);
        if (joined)
            return joined;
        let request;
        request = registerBaleBotCommands(deps, assertAuthority ? { assertAuthority } : undefined).finally(() => {
            if (pending.get(assertAuthority) === request)
                pending.delete(assertAuthority);
        });
        pending.set(assertAuthority, request);
        return request;
    };
}
export function createBaleThreadDisplayNameResetBinding() {
    let current, generation = 0;
    return {
        bind(reset) {
            current = reset;
            generation++;
        },
        async reset(target, options) {
            const reset = current, assertAuthority = options?.assertAuthority, capturedGeneration = generation;
            const capturedTarget = {
                chatId: target.chatId,
                ...(target.threadId === undefined ? {} : { threadId: target.threadId }),
            };
            if (!reset)
                return {
                    ok: false,
                    message: "Thread display name reset is unavailable.",
                };
            const assertCurrent = () => {
                assertAuthority?.();
                if (assertAuthority && generation !== capturedGeneration)
                    throw new Error("Thread display name reset binding changed.");
            };
            assertCurrent();
            const result = assertAuthority
                ? await reset(capturedTarget, { assertAuthority: assertCurrent })
                : await reset(capturedTarget);
            assertCurrent();
            return result;
        },
    };
}
export function createBaleThreadDisplayNameRenameBinding() {
    let current, generation = 0;
    return {
        bind(rename) {
            current = rename;
            generation++;
        },
        async rename(target, threadName, options) {
            const rename = current, assertAuthority = options?.assertAuthority, capturedGeneration = generation;
            const capturedTarget = {
                chatId: target.chatId,
                ...(target.threadId === undefined ? {} : { threadId: target.threadId }),
            };
            if (!rename) {
                return {
                    ok: false,
                    message: "Thread display naming is unavailable.",
                };
            }
            const assertCurrent = () => {
                assertAuthority?.();
                if (assertAuthority && generation !== capturedGeneration)
                    throw new Error("Thread display naming binding changed.");
            };
            assertCurrent();
            const result = assertAuthority
                ? await rename(capturedTarget, threadName, {
                    assertAuthority: assertCurrent,
                })
                : await rename(capturedTarget, threadName);
            assertCurrent();
            return result;
        },
    };
}
function parseBaleProfileArg(args) {
    const word = args.trim().split(/\s+/)[0];
    if (!word || word.length === 0)
        return undefined;
    if (word.startsWith("-") || /^as=/i.test(word))
        return undefined;
    return word === BALE_DEFAULT_PROFILE_NAME ? undefined : word;
}
function formatBaleTakeoverTitle(ctx) {
    return ctx.ui.theme.fg("accent", "pi-bale");
}
function formatBaleTakeoverPrompt(ctx, owner) {
    const theme = ctx.ui.theme;
    const action = theme.fg("warning", "move singleton lock here?");
    const from = theme.fg("muted", "from:");
    const to = theme.fg("muted", "to:");
    const source = owner ?? "another Pi instance";
    return `${action}\n\n${from} ${source}\n${to} ${ctx.cwd}`;
}
export function registerBaleBridgeCommands(pi, deps) {
    const handleInternalAction = deps.handleInternalAction;
    pi.registerCommand("bale-setup", {
        description: "<profile> — Configure Bale bot token",
        handler: async (args, ctx) => {
            await deps.promptForConfig(ctx, parseBaleProfileArg(args));
        },
    });
    pi.registerCommand("bale-status", {
        description: "Show Bale bridge status",
        handler: async (args, ctx) => {
            const verbose = /(^|\s)(--debug|debug|--verbose|verbose)(\s|$)/i.test(args);
            ctx.ui.notify(deps.getStatusLines({ verbose }).join("\n"), "info");
        },
    });
    pi.registerCommand(BALE_CONNECT_COMMAND_NAME, {
        description: "<profile> — Start Bale bridge",
        handler: async (args, ctx) => {
            const words = args.trim().split(/\s+/);
            // Service dispatch never inherits profile activation or explicit-connect recovery authority.
            if (words.some(word => word.toLowerCase().startsWith(BALE_INTERNAL_COMMAND_FLAG))) {
                if (words[0] !== BALE_INTERNAL_COMMAND_FLAG || !handleInternalAction) {
                    ctx.ui.notify(BALE_INTERNAL_MANUAL_USE_MESSAGE, "warning");
                    return;
                }
                await handleInternalAction(words.slice(1).join(" "), ctx);
                return;
            }
            const sessionGeneration = deps.getSessionGeneration?.();
            let intentId;
            // Pi context getters throw after replacement; check plain intent/generation first.
            const isCurrent = () => (!intentId || deps.connectionIntent?.isActive(intentId) !== false) &&
                (sessionGeneration === undefined ||
                    deps.getSessionGeneration?.() === sessionGeneration) &&
                deps.isContextCurrent?.(ctx) !== false;
            if (!isCurrent())
                return;
            if (args
                .trim()
                .split(/\s+/)
                .some((word) => /^as=/i.test(word))) {
                ctx.ui.notify("Thread names are configured from Bale, not from Pi commands.", "warning");
                deps.updateStatus(ctx);
                return;
            }
            const profileName = parseBaleProfileArg(args);
            intentId = deps.connectionIntent?.begin(ctx.cwd, profileName);
            try {
                if (profileName && deps.activateProfileConfig) {
                    const ok = await deps.activateProfileConfig(ctx, profileName, isCurrent);
                    if (!isCurrent())
                        return;
                    if (!ok) {
                        ctx.ui.notify(`Profile "${profileName}" not found.`, "error");
                        deps.updateStatus(ctx);
                        return;
                    }
                    ctx.ui.notify(`Activated profile "${profileName}".`, "info");
                }
                else {
                    await (deps.activateDefaultProfileConfig?.(ctx, isCurrent) ??
                        deps.reloadConfig());
                    if (!isCurrent())
                        return;
                }
                if (!deps.hasBotToken()) {
                    const botTokenDiagnostic = deps.getBotTokenDiagnostic?.();
                    if (botTokenDiagnostic)
                        ctx.ui.notify(botTokenDiagnostic, "error");
                    const profileNames = deps.getProfileNames?.() ?? [];
                    if (!profileName && profileNames.length > 0) {
                        ctx.ui.notify(`No default Bale profile configured. Available profiles: ${profileNames.join(", ")}. Use /bale-connect <profileName> or /bale-setup to create a default profile.`, "info");
                        deps.updateStatus(ctx);
                        return;
                    }
                    await deps.promptForConfig(ctx, profileName);
                    return;
                }
                const startPolling = async (options) => {
                    try {
                        return await deps.startPolling(ctx, options);
                    }
                    catch (error) {
                        if (!isCurrent())
                            return;
                        throw error;
                    }
                };
                let result = await startPolling({ forceFreshLeaderThread: true });
                if (!isCurrent())
                    return;
                if (result && !result.ok && result.canTakeover) {
                    const confirmed = await ctx.ui.confirm(formatBaleTakeoverTitle(ctx), formatBaleTakeoverPrompt(ctx, result.owner));
                    if (!isCurrent())
                        return;
                    if (!confirmed) {
                        ctx.ui.notify("Bale bridge takeover cancelled.", "info");
                        deps.updateStatus(ctx);
                        return;
                    }
                    result = await startPolling({
                        force: true,
                        forceFreshLeaderThread: true,
                    });
                    if (!isCurrent())
                        return;
                }
                if (result && !result.ok) {
                    if (result.message)
                        deps.recordConnectionEvent?.(result.message, "connect-refused");
                    ctx.ui.notify(formatBaleConnectionFailure(result.message), "warning");
                }
                else if (result?.message) {
                    ctx.ui.notify(result.message, "info");
                }
                if (!result || result.ok)
                    deps.queueAgentConnectionContext?.(true);
                deps.updateStatus(ctx);
            }
            catch (error) {
                if (!isCurrent())
                    return;
                deps.recordConnectionEvent?.(error, "connect");
                ctx.ui.notify(formatBaleConnectionFailure(error), "warning");
                deps.updateStatus(ctx);
            }
            finally {
                if (intentId)
                    deps.connectionIntent?.finish(intentId);
            }
        },
    });
    pi.registerCommand("bale-disconnect", {
        description: "Stop Bale and delete current thread in Threaded Mode",
        handler: async (_args, ctx) => {
            const generation = deps.getSessionGeneration?.();
            const isCurrent = () => (generation === undefined ||
                deps.getSessionGeneration?.() === generation) &&
                deps.isContextCurrent?.(ctx) !== false;
            if (!isCurrent())
                return;
            deps.connectionIntent?.cancel();
            try {
                const threadName = deps.getDisconnectThreadName?.();
                if (threadName) {
                    const confirmed = await ctx.ui.confirm(ctx.ui.theme.fg("accent", "pi-bale"), `Delete Bale thread ${ctx.ui.theme.fg("warning", threadName)} and disconnect this Pi session?`);
                    if (!isCurrent())
                        return;
                    if (!confirmed) {
                        ctx.ui.notify("Bale disconnect cancelled.", "info");
                        return;
                    }
                }
                const message = await deps.stopPolling();
                if (!isCurrent())
                    return;
                if (message)
                    ctx.ui.notify(message, "info");
                deps.queueAgentConnectionContext?.(false);
            }
            catch (error) {
                deps.recordConnectionEvent?.(error, "disconnect");
                if (!isCurrent())
                    return;
                ctx.ui.notify("Bale disconnect incomplete; keep Pi open. Check /bale-status --debug.", "warning");
            }
            finally {
                if (isCurrent())
                    deps.updateStatus(ctx);
            }
        },
    });
}
export const BALE_RESERVED_COMMAND_NAMES = [
    "stop",
    "name",
    "new",
    "abort",
    "next",
    "continue",
    "status",
    "queue",
    "compact",
    "model",
    "thinking",
    "settings",
    "help",
    "start",
];
const BALE_RESERVED_COMMAND_NAME_SET = new Set(BALE_RESERVED_COMMAND_NAMES);
export function isBaleReservedCommandName(commandName) {
    return (commandName !== undefined &&
        BALE_RESERVED_COMMAND_NAME_SET.has(commandName));
}
function isBaleSessionBusy(ports) {
    return (!ports.isIdle() ||
        ports.hasPendingMessages() ||
        ports.hasActiveBaleTurn() ||
        ports.hasDispatchPending() ||
        ports.hasQueuedBaleItems() ||
        ports.isCompactionInProgress());
}
function canPairBaleUserFromCommandMessage(message) {
    return message.chat.type === undefined || message.chat.type === "private";
}
export function getBaleCommandMessageTarget(message) {
    return {
        chatId: message.chat.id,
        threadId: typeof message.message_thread_id === "number"
            ? message.message_thread_id
            : undefined,
        replyToMessageId: message.message_id,
    };
}
export function createBaleCommandControlEnqueueAdapter(deps) {
    return (target, ctx, controlType, statusSummary, execute, admissionReceipts, onQueued) => {
        deps.enqueueControlItem(deps.createControlItem({
            ...target,
            controlType,
            statusSummary,
            ...(admissionReceipts?.length ? { admissionReceipts } : {}),
            execute,
        }), ctx, onQueued);
    };
}
export function createBaleCommandTargetQueueRuntime(deps) {
    const { createControlItem, appendControlItem, dispatchNextQueuedBaleTurn, } = deps;
    const controlQueueController = createBaleControlQueueController({
        appendControlItem,
        dispatchNextQueuedBaleTurn,
    });
    return createBaleCommandTargetRuntime({
        enqueueControlItem: createBaleCommandControlEnqueueAdapter({
            createControlItem,
            enqueueControlItem: controlQueueController.enqueue,
        }),
        getReplyTarget: deps.getReplyTarget,
        getAdmissionScope: deps.getAdmissionScope,
        getAdmissionJournalBinding: deps.getAdmissionJournalBinding,
        onControlQueued: deps.onControlQueued,
        showStatus: deps.showStatus,
        openModelMenu: deps.openModelMenu,
        openSettingsMenu: deps.openSettingsMenu,
        sendTextReply: deps.sendTextReply,
    });
}
export function createBaleCommandTargetRuntime(deps) {
    const getReplyTarget = (message, options) => {
        const source = getBaleCommandMessageTarget(message);
        const recipient = options?.assertAuthority
            ? undefined
            : deps.getReplyTarget?.(message);
        if (!recipient)
            return source;
        if (recipient.chatId !== source.chatId)
            throw new Error("Bale command reply cannot change its recipient chat.");
        if (source.threadId !== undefined && recipient.threadId === undefined)
            throw new Error("Bale command cannot move a Thread reply to All.");
        return {
            ...recipient,
            replyToMessageId: recipient.threadId === source.threadId ? source.replyToMessageId : undefined,
        };
    };
    return {
        enqueueControlItem: (message, ctx, controlType, statusSummary, execute) => {
            const sourceUpdateId = message.pi_bale_source_update_id;
            const baseReceipt = typeof sourceUpdateId === "number"
                ? createBaleQueueAdmissionReceipt({
                    queueKind: "control",
                    scope: deps.getAdmissionScope?.() ?? "",
                    sourceUpdateIds: [sourceUpdateId],
                })
                : undefined;
            const journalBindingKey = deps.getAdmissionJournalBinding?.();
            const receipt = baseReceipt
                ? {
                    ...baseReceipt,
                    ...(journalBindingKey ? { journalBindingKey } : {}),
                }
                : undefined;
            deps.enqueueControlItem(getBaleCommandMessageTarget(message), ctx, controlType, statusSummary, execute, receipt ? [receipt] : undefined, receipt ? () => deps.onControlQueued?.(message, receipt) : undefined);
        },
        showStatus: (message, ctx, options) => {
            const target = getReplyTarget(message, options);
            return deps.showStatus(target.chatId, target.replyToMessageId, ctx, target.threadId, options);
        },
        openModelMenu: (message, ctx, options) => {
            const target = getReplyTarget(message, options);
            return deps.openModelMenu(target.chatId, target.replyToMessageId, ctx, target.threadId, options);
        },
        openSettingsMenu: async (message, ctx, options) => {
            const target = getReplyTarget(message, options);
            if (!deps.openSettingsMenu) {
                await deps.sendTextReply(target.chatId, target.replyToMessageId, formatBaleInformationHeading("🚫", "Settings menu is unavailable."), { target, parseMode: "HTML" });
                return;
            }
            await deps.openSettingsMenu(target.chatId, target.replyToMessageId, ctx, target.threadId, options);
        },
        sendTextReply: async (message, text, options) => {
            const target = getReplyTarget(message, options);
            const assertAuthority = options?.assertAuthority, send = deps.sendTextReply;
            const capturedOptions = { ...options, target };
            assertAuthority?.();
            await send(target.chatId, target.replyToMessageId, text, capturedOptions);
            assertAuthority?.();
        },
    };
}
/** Pure intro: built-in controls with registered extension lines before the abort controls. */
function formatBaleAppMenuIntroHtml(extensionLines) {
    const line = (name, label) => `${formatBaleCommandEmojiPrefix(name)}/${name} — ${label}`;
    return [
        "<b>Pi Bale</b>",
        "",
        line("start", "Open menu / Pair bridge"),
        line("compact", "Compact current session"),
        line("new", "Start a new session"),
        line("continue", "Queue continue prompt"),
        line("next", "Force next turn"),
        ...extensionLines,
        line("abort", "Abort Pi"),
        line("stop", "Abort Pi & Clear queue"),
    ].join("\n");
}
export const BALE_APP_MENU_INTRO_HTML = formatBaleAppMenuIntroHtml([]);
function buildBalePromptTemplateMenuHtml(promptTemplates = []) {
    if (promptTemplates.length === 0)
        return "";
    return promptTemplates
        .map((template) => `🧩 /${escapeHtml(template.command)}`)
        .join("\n");
}
function buildBaleExtensionCommandMenuLines() {
    return getBaleExtensionCommands()
        .filter((command) => command.showInMenu)
        .map((command) => {
        const prefix = `${escapeHtml(command.emoji ?? "")} /${escapeHtml(command.name)}`;
        if (!command.description)
            return prefix;
        return `${prefix} — ${escapeHtml(command.description)}`;
    });
}
function buildBaleAppMenuIntroHtml() {
    return formatBaleAppMenuIntroHtml(buildBaleExtensionCommandMenuLines());
}
export function buildBaleAppMenuHtml(statusHtml, promptTemplates = []) {
    const introHtml = buildBaleAppMenuIntroHtml();
    const promptTemplateHtml = buildBalePromptTemplateMenuHtml(promptTemplates);
    if (!promptTemplateHtml)
        return `${introHtml}\n\n${statusHtml}`;
    return `${introHtml}\n\n${promptTemplateHtml}\n\n${statusHtml}`;
}
export function createBaleAppMenuHtmlBuilder(deps) {
    return (ctx) => {
        return buildBaleAppMenuHtml(deps.buildStatusHtml(ctx), deps.getPromptTemplateCommands?.());
    };
}
function getBaleCommandErrorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
function formatBaleCompactionFailure(error) {
    let message = getBaleCommandErrorMessage(error).trim();
    const redundantPrefixes = [
        "Compaction failed: ",
        "Turn prefix summarization failed: ",
    ];
    let stripped = true;
    while (stripped) {
        stripped = false;
        for (const prefix of redundantPrefixes) {
            if (!message.startsWith(prefix))
                continue;
            message = message.slice(prefix.length).trim();
            stripped = true;
        }
    }
    const sentence = /[.!?]$/u.test(message) ? message : `${message}.`;
    return `Compaction failed! ${sentence}`;
}
export function parseBaleCommand(text) {
    const trimmed = text.trim();
    if (!trimmed.startsWith("/"))
        return undefined;
    const [head, ...tail] = trimmed.split(/\s+/);
    const name = head.slice(1).split("@")[0]?.toLowerCase();
    if (!name)
        return undefined;
    return { name, args: tail.join(" ").trim() };
}
export const BALE_COMMAND_ACTIONS = {
    stop: { kind: "stop", executionMode: "immediate" },
    name: { kind: "name", executionMode: "immediate" },
    new: { kind: "new", executionMode: "immediate" },
    abort: { kind: "abort", executionMode: "immediate" },
    next: { kind: "next", executionMode: "immediate" },
    continue: { kind: "continue", executionMode: "immediate" },
    status: { kind: "status", executionMode: "immediate" },
    queue: { kind: "queue", executionMode: "immediate" },
    compact: { kind: "compact", executionMode: "immediate" },
    model: { kind: "model", executionMode: "immediate" },
    thinking: { kind: "thinking", executionMode: "immediate" },
    settings: { kind: "settings", executionMode: "immediate" },
    help: { kind: "help", commandName: "help", executionMode: "immediate" },
    start: { kind: "help", commandName: "start", executionMode: "immediate" },
};
export function buildBaleCommandAction(commandName) {
    if (!isBaleReservedCommandName(commandName)) {
        return { kind: "ignore", executionMode: "ignored" };
    }
    return BALE_COMMAND_ACTIONS[commandName];
}
function formatBaleQueuedTurnCount(count) {
    return count === 1 ? "1 queued turn" : `${count} queued turns`;
}
export async function handleBaleStopCommand(deps) {
    deps.clearPendingModelSwitch();
    deps.cancelNextTransitionAnnouncements?.();
    const clearedCount = deps.clearQueuedBaleItems();
    deps.setFoldQueuedPromptsIntoHistory(false);
    if (!deps.hasAbortHandler()) {
        const clearedSuffix = clearedCount > 0
            ? ` Cleared ${formatBaleQueuedTurnCount(clearedCount)}.`
            : "";
        if (clearedCount > 0)
            deps.updateStatus();
        await deps.sendTextReply(formatBaleInformationHeading("💤", `No active turn.${clearedSuffix}`), { parseMode: "HTML" });
        return;
    }
    deps.abortCurrentTurn();
    deps.updateStatus();
    const clearedSuffix = clearedCount > 0
        ? ` Cleared ${formatBaleQueuedTurnCount(clearedCount)}.`
        : "";
    await deps.sendTextReply(formatBaleInformationHeading("⏹️", `Aborted current turn.${clearedSuffix}`), { parseMode: "HTML" });
}
export async function handleBaleAbortCommand(deps) {
    deps.clearPendingModelSwitch();
    deps.cancelNextTransitionAnnouncements?.();
    if (!deps.hasAbortHandler()) {
        await deps.sendTextReply(formatBaleInformationHeading("💤", "No active turn."), { parseMode: "HTML" });
        return;
    }
    deps.setFoldQueuedPromptsIntoHistory(deps.hasActiveBaleTurn());
    deps.abortCurrentTurn();
    deps.updateStatus();
    await deps.sendTextReply(formatBaleInformationHeading("⏹️", "Aborted current turn."), { parseMode: "HTML" });
}
export async function handleBaleNextCommand(deps) {
    deps.clearPendingModelSwitch();
    if (!deps.hasQueuedItems()) {
        await deps.sendTextReply(formatBaleInformationHeading("⌛", "Queue is empty"), { parseMode: "HTML" });
        return;
    }
    if (!deps.isIdle() && deps.hasAbortHandler()) {
        deps.clearFoldForDispatch();
        deps.requestNextDispatchAnnouncement?.();
        deps.markActiveTurnNextAbortAnnouncement?.();
        deps.abortCurrentTurn();
        deps.updateStatus();
        return;
    }
    if (!deps.isIdle()) {
        await deps.sendTextReply(formatBaleInformationHeading("⏳", "Pi is busy. Send /abort or /stop first."), { parseMode: "HTML" });
        return;
    }
    deps.requestNextDispatchAnnouncement?.();
    deps.dispatchNextQueuedTurn();
    deps.updateStatus();
}
async function handleBaleContinueCommand(message, ctx, deps) {
    await deps.enqueueContinueTurn(message, ctx);
}
function dispatchNextQueuedBaleTurnAfterCompact(deps) {
    if (deps.requestDeferredDispatchNextQueuedBaleTurn) {
        deps.requestDeferredDispatchNextQueuedBaleTurn(deps.dispatchNextQueuedBaleTurn);
        return;
    }
    deps.dispatchNextQueuedBaleTurn();
}
function buildBaleNewConfirmationReplyMarkup() {
    return {
        inline_keyboard: [
            [
                { text: "🆕 Yes, start new", callback_data: "new:confirm" },
                { text: "❌ No", callback_data: "new:cancel" },
            ],
        ],
    };
}
/** Send one confirmation to an exact copied recipient, with authority checks around the issued request. */
async function sendBaleConfirmation(target, deps, html, markup, assertAuthority) {
    const recipientTarget = {
        chatId: target.chatId,
        ...(target.threadId !== undefined ? { threadId: target.threadId } : {}),
    };
    const options = assertAuthority
        ? { target: recipientTarget, assertAuthority }
        : target.threadId !== undefined
            ? { target: recipientTarget }
            : undefined;
    assertAuthority?.();
    await deps.sendInteractiveMessage(recipientTarget.chatId, html, "html", markup, options);
    assertAuthority?.();
}
function getBaleNewConfirmationHtml() {
    return "<b>Start a new session?</b>";
}
export async function openBaleNewConfirmation(target, deps, assertAuthority) {
    await sendBaleConfirmation(target, deps, getBaleNewConfirmationHtml(), buildBaleNewConfirmationReplyMarkup(), assertAuthority);
}
export async function handleBaleNewConfirmationCallback(query, deps) {
    if (query.data !== "new:confirm" && query.data !== "new:cancel")
        return false;
    const chatId = query.message?.chat?.id;
    const messageId = query.message?.message_id;
    if (typeof chatId !== "number" || typeof messageId !== "number") {
        await deps.answerCallbackQuery(query.id, "Interactive message expired");
        return true;
    }
    if (query.data === "new:cancel") {
        await deps.editInteractiveMessage(chatId, messageId, "<b>🚫 New session cancelled.</b>", "html", { inline_keyboard: [] });
        await deps.answerCallbackQuery(query.id);
        return true;
    }
    await deps.answerCallbackQuery(query.id);
    await deps.deleteMessage(chatId, messageId);
    await deps.runNew(deps.ctx);
    return true;
}
function buildBaleCompactConfirmationReplyMarkup() {
    return {
        inline_keyboard: [
            [
                { text: "🗜 Yes, compact", callback_data: "compact:confirm" },
                { text: "❌ No", callback_data: "compact:cancel" },
            ],
        ],
    };
}
function getBaleCompactConfirmationHtml() {
    return "<b>Compact session?</b>";
}
async function openBaleCompactConfirmation(target, deps, assertAuthority) {
    await sendBaleConfirmation(target, deps, getBaleCompactConfirmationHtml(), buildBaleCompactConfirmationReplyMarkup(), assertAuthority);
}
export async function handleBaleCompactConfirmationCallback(query, deps) {
    if (query.data !== "compact:confirm" && query.data !== "compact:cancel") {
        return false;
    }
    const callbackMessage = query.message;
    const chatId = callbackMessage?.chat?.id;
    const messageId = callbackMessage?.message_id;
    if (typeof chatId !== "number" || typeof messageId !== "number") {
        await deps.answerCallbackQuery(query.id, "Interactive message expired");
        return true;
    }
    if (query.data === "compact:cancel") {
        await deps.editInteractiveMessage(chatId, messageId, "<b>🚫 Compaction cancelled.</b>", "html", { inline_keyboard: [] });
        await deps.answerCallbackQuery(query.id);
        return true;
    }
    await deps.editInteractiveMessage(chatId, messageId, BALE_COMPACTION_STARTED_TEXT, "html", { inline_keyboard: [] });
    await deps.answerCallbackQuery(query.id);
    const threadId = callbackMessage?.message_thread_id;
    await deps.runCompact(deps.ctx, chatId, messageId, typeof threadId === "number" ? { chatId, threadId } : { chatId });
    return true;
}
export async function handleBaleNewCommand(deps) {
    if (isBaleSessionBusy(deps)) {
        await deps.sendTextReply(formatBaleInformationHeading("⏳", "Cannot start a new session while Pi or the Bale queue is busy. Wait for queued turns to finish or send /abort first."), { parseMode: "HTML" });
        return;
    }
    if (!deps.requestNewSession) {
        await deps.sendTextReply(formatBaleInformationHeading("🚫", "Session replacement is unavailable in this Pi runtime."), { parseMode: "HTML" });
        return;
    }
    deps.requestNewSession();
}
export async function handleBaleCompactCommand(deps) {
    if (isBaleSessionBusy(deps)) {
        await deps.sendTextReply(formatBaleInformationHeading("⏳", "Cannot compact while Pi or the Bale queue is busy. Wait for queued turns to finish or send /abort first."), { parseMode: "HTML" });
        return;
    }
    deps.setCompactionInProgress(true);
    deps.updateStatus();
    deps.startTypingLoop?.();
    try {
        deps.compact({
            onComplete: () => {
                deps.stopTypingLoop?.();
                deps.setCompactionInProgress(false);
                deps.updateStatus();
                dispatchNextQueuedBaleTurnAfterCompact(deps);
                void deps.sendTextReply(BALE_COMPACTION_COMPLETED_TEXT, {
                    parseMode: "HTML",
                });
            },
            onError: (error) => {
                deps.stopTypingLoop?.();
                deps.setCompactionInProgress(false);
                deps.updateStatus();
                dispatchNextQueuedBaleTurnAfterCompact(deps);
                deps.recordRuntimeEvent?.("compact", error);
                void deps.sendTextReply(formatBaleInformationHeading("⚠️", formatBaleCompactionFailure(error)), { parseMode: "HTML" });
            },
        });
    }
    catch (error) {
        deps.stopTypingLoop?.();
        deps.setCompactionInProgress(false);
        deps.updateStatus();
        deps.recordRuntimeEvent?.("compact", error);
        await deps.sendTextReply(formatBaleInformationHeading("⚠️", formatBaleCompactionFailure(error)), { parseMode: "HTML" });
        return;
    }
    if (!deps.suppressStartNotice) {
        await deps.sendTextReply(BALE_COMPACTION_STARTED_TEXT, {
            parseMode: "HTML",
        });
    }
}
export async function handleBaleModelCommand(deps) {
    try {
        await deps.openModelMenu(deps.ctx);
    }
    catch (error) {
        if (!isPiStaleContextError(error))
            throw error;
    }
}
export async function executeBaleCommandAction(action, message, ctx, deps, commandArgs = "") {
    switch (action.kind) {
        case "ignore":
            return false;
        case "stop":
            await deps.handleStop(message, ctx);
            return true;
        case "name":
            await deps.handleName(message, ctx, commandArgs);
            return true;
        case "new":
            await deps.handleNew(message, ctx);
            return true;
        case "abort":
            await deps.handleAbort(message, ctx);
            return true;
        case "next":
            await deps.handleNext(message, ctx);
            return true;
        case "continue":
            await deps.handleContinue(message, ctx);
            return true;
        case "queue":
            await deps.handleQueue(message, ctx);
            return true;
        case "compact":
            await deps.handleCompact(message, ctx);
            return true;
        case "status":
            await deps.handleStatus(message, ctx);
            return true;
        case "model":
            await deps.handleModel(message, ctx);
            return true;
        case "thinking":
            await deps.handleThinking(message, ctx);
            return true;
        case "settings":
            if (!deps.handleSettings)
                return false;
            await deps.handleSettings(message, ctx);
            return true;
        case "help":
            await deps.handleHelp(message, action.commandName, ctx);
            return true;
    }
}
export function createBaleCommandHandlerTargetRuntime(deps) {
    const commandTargetRuntime = createBaleCommandTargetQueueRuntime({
        createControlItem: createBaleControlItemBuilder({
            allocateItemOrder: deps.allocateItemOrder,
            allocateControlOrder: deps.allocateControlOrder,
        }),
        appendControlItem: deps.appendControlItem,
        dispatchNextQueuedBaleTurn: deps.dispatchNextQueuedBaleTurn,
        getReplyTarget: deps.getReplyTarget,
        getAdmissionScope: deps.getAdmissionScope,
        getAdmissionJournalBinding: deps.getAdmissionJournalBinding,
        onControlQueued: deps.onControlQueued,
        showStatus: deps.showStatus,
        openModelMenu: deps.openModelMenu,
        openSettingsMenu: deps.openSettingsMenu,
        sendTextReply: deps.sendTextReply,
    });
    return createBaleCommandHandler({
        assertExecutionCurrent: deps.assertExecutionCurrent,
        hasAbortHandler: deps.hasAbortHandler,
        clearPendingModelSwitch: deps.clearPendingModelSwitch,
        hasQueuedBaleItems: deps.hasQueuedBaleItems,
        clearQueuedBaleItems: deps.clearQueuedBaleItems,
        setFoldQueuedPromptsIntoHistory: deps.setFoldQueuedPromptsIntoHistory,
        abortCurrentTurn: deps.abortCurrentTurn,
        isIdle: deps.isIdle,
        hasPendingMessages: deps.hasPendingMessages,
        hasActiveBaleTurn: deps.hasActiveBaleTurn,
        hasDispatchPending: deps.hasDispatchPending,
        isCompactionInProgress: deps.isCompactionInProgress,
        setCompactionInProgress: deps.setCompactionInProgress,
        updateStatus: deps.updateStatus,
        isContextActive: deps.isContextActive,
        beginCommandEffectWork: deps.beginCommandEffectWork,
        dispatchNextQueuedBaleTurn: deps.dispatchNextQueuedBaleTurn,
        requestNextDispatchAnnouncement: deps.requestNextDispatchAnnouncement,
        markActiveTurnNextAbortAnnouncement: deps.markActiveTurnNextAbortAnnouncement,
        cancelNextTransitionAnnouncements: deps.cancelNextTransitionAnnouncements,
        startTypingLoop: deps.startTypingLoop,
        stopTypingLoop: deps.stopTypingLoop,
        enqueueContinueTurn: deps.enqueueContinueTurn,
        heldTurn: deps.heldTurn,
        compact: deps.compact,
        requestNewSession: deps.requestNewSession,
        sendInteractiveMessage: deps.sendInteractiveMessage,
        enqueueControlItem: commandTargetRuntime.enqueueControlItem,
        showStatus: commandTargetRuntime.showStatus,
        openModelMenu: commandTargetRuntime.openModelMenu,
        openThinkingMenu: deps.openThinkingMenu,
        openQueueMenu: deps.openQueueMenu,
        openSettingsMenu: commandTargetRuntime.openSettingsMenu,
        handleForumBootstrap: deps.handleForumBootstrap,
        getAllowedUserId: deps.getAllowedUserId,
        persistAllowedUserId: deps.persistAllowedUserId,
        registerBotCommands: createBaleBotCommandRegistrar({
            setMyCommands: deps.setMyCommands,
        }),
        validateThreadName: deps.validateThreadName,
        renameCurrentThread: deps.renameCurrentThread,
        resetCurrentThreadName: deps.resetCurrentThreadName,
        openThreadNameDialog: deps.openThreadNameDialog,
        sendTextReply: commandTargetRuntime.sendTextReply,
        recordRuntimeEvent: deps.recordRuntimeEvent,
    });
}
/**
 * Captures admission ports now and checks source → execution → recipient; `strict` rechecks the source after the
 * recipient, for owners whose effects outlive one synchronous step.
 */
function createSelectedSemanticGuard(admission, assertExecution, strict) {
    const assertSourceCurrent = admission.assertSourceCurrent, assertRecipientCurrent = admission.assertRecipientCurrent;
    return () => {
        assertSourceCurrent();
        assertExecution();
        assertRecipientCurrent();
        if (!strict)
            return;
        assertSourceCurrent();
        assertExecution();
    };
}
/** Wrap one synchronous command effect between semantic checks. */
function guardSelectedEffect(assertCurrent) {
    return (effect) => (...args) => {
        assertCurrent();
        const result = effect(...args);
        assertCurrent();
        return result;
    };
}
/** One issuance only: later calls return false without assertions or effects, never replay. */
function issueSelectedOnce(assertCurrent, run) {
    let issued = false;
    return async () => {
        if (issued)
            return false;
        assertCurrent();
        issued = true;
        return run();
    };
}
/** Body-free reply anchor: chat, message and Thread only, never the original's admission symbols. */
function copySelectedReplyAnchor(original) {
    return {
        chat: { ...original.chat },
        message_id: original.message_id,
        message_thread_id: original.message_thread_id,
    };
}
function copySelectedMenuCarrier(original) {
    const message = Object.fromEntries(Object.entries(original).filter(([key]) => key !== "pi_bale_source_update_id"));
    message.chat = { ...original.chat };
    return message;
}
export function createBaleCommandHandler(deps) {
    const handle = async (commandName, message, ctx, commandArgs) => {
        return handleBaleCommandRuntime(commandName, message, ctx, deps, commandArgs);
    };
    const heldQueueReceipts = new Map();
    const heldQueueOwners = new WeakSet();
    const watchHeldQueueOwner = (signal) => {
        if (heldQueueOwners.has(signal))
            return;
        addAbortListener(signal, () => {
            // Native owner end is irreversible; keep refusal identity, not its context/carrier closures or a fallback grant.
            for (const [id, record] of heldQueueReceipts)
                if (record?.signal === signal)
                    heldQueueReceipts.set(id, null);
        });
        heldQueueOwners.add(signal);
    };
    const prepareHeldSelectedCommand = (name, readiness, admission, captured, portsCurrent, completion, run, inspectQueuedCompletion) => {
        const snapshot = readiness.snapshot, raw = snapshot.update.message, target = { ...admission.target };
        const bind = readiness.bindCarrier, isCurrent = readiness.isCurrent, assertSource = admission.assertSourceCurrent, assertRecipient = admission.assertRecipientCurrent;
        if (typeof bind !== "function" ||
            typeof isCurrent !== "function" ||
            typeof assertSource !== "function" ||
            typeof assertRecipient !== "function" ||
            !isCurrent.call(readiness) ||
            !raw ||
            typeof raw !== "object" ||
            Array.isArray(raw) ||
            Object.keys(snapshot.update).some((key) => !["update_id", "message"].includes(key)))
            return undefined;
        const value = raw, chat = value.chat, from = value.from;
        if (typeof captured.getAllowedUserId !== "function")
            return undefined;
        const command = typeof value.text === "string"
            ? parseBaleCommand(value.text)
            : undefined, operator = captured.getAllowedUserId();
        if (!command ||
            !chat ||
            !from ||
            !isBaleSelectedHeldOriginal(snapshot.update, target, operator, name))
            return undefined;
        const source = { ...snapshot.source }, preparedCommand = { ...command };
        const message = {
            ...structuredClone(value),
            chat: { ...chat },
            message_thread_id: target.threadId,
        };
        delete message.pi_bale_source_update_id;
        let bound, issued = false;
        const ownerCurrent = () => portsCurrent() &&
            readiness.bindCarrier === bind &&
            readiness.isCurrent === isCurrent &&
            isCurrent.call(readiness) &&
            captured.getAllowedUserId() === operator;
        const completionCurrent = () => !!bound &&
            Object.entries(bound.ports).every(([key, port]) => Reflect.get(bound.completion, key) === port) &&
            bound.ports.isCurrent.call(bound.completion);
        const assertSourceCurrent = () => {
            assertSource.call(admission);
            if (!ownerCurrent() || !completionCurrent() || !bound)
                throw new Error(`Held ${name} source owner is unavailable.`);
            captured.assertExecutionCurrent?.(bound.carrier);
            const current = inspectBaleDeferredSource(bound.carrier);
            if (!current ||
                current.updateId !== source.updateId ||
                current.journalBindingKey !== source.journalBindingKey ||
                current.sourceSha256 !== source.sourceSha256 ||
                !ownerCurrent() ||
                !completionCurrent())
                throw new Error(`Held ${name} original changed.`);
        };
        return {
            get source() {
                return { ...source };
            },
            get command() {
                return { ...preparedCommand };
            },
            bindCarrier(value) {
                if (!ownerCurrent())
                    return false;
                if (bound)
                    return value === bound.carrier && completionCurrent();
                const completion = bind.call(readiness, value);
                if (!completion ||
                    completion.source.updateId !== source.updateId ||
                    completion.source.journalBindingKey !== source.journalBindingKey ||
                    completion.source.sourceSha256 !== source.sourceSha256 ||
                    !ownerCurrent())
                    return false;
                const ports = {
                    isCurrent: completion.isCurrent,
                    reportCompleted: completion.reportCompleted,
                    inspectCompletion: completion.inspectCompletion,
                };
                if (Object.values(ports).some((port) => typeof port !== "function"))
                    return false;
                bound = { carrier: value, completion, ports };
                return completionCurrent();
            },
            async execute() {
                if (issued)
                    return false;
                assertSourceCurrent();
                assertRecipient.call(admission);
                assertSourceCurrent();
                issued = true;
                if (completion === "before-effect" &&
                    !bound.ports.reportCompleted.call(bound.completion))
                    return false;
                return run({
                    message,
                    carrier: bound.carrier,
                    source: { ...source },
                    command: { ...preparedCommand },
                    assertRecipient,
                    reportCompleted: () => bound.ports.reportCompleted.call(bound.completion),
                    assertSemantic() {
                        assertSourceCurrent();
                        assertRecipient.call(admission);
                    },
                });
            },
            inspectCompletion() {
                return ownerCurrent() && completionCurrent()
                    ? completion === "queue-receipt"
                        ? inspectQueuedCompletion?.()
                        : bound.ports.inspectCompletion.call(bound.completion)
                    : undefined;
            },
        };
    };
    const prepareHeldReplyPlan = (ctx, effects, run, replyDelivery = "detached") => {
        const send = effects.sendTextReply, captured = { ...deps };
        return {
            captured,
            portsCurrent: () => effects.sendTextReply === send,
            async run(input) {
                const semantic = guardSelectedEffect(input.assertSemantic);
                const complete = () => {
                    input.assertSemantic();
                    if (!input.reportCompleted())
                        throw new Error(`Held ${input.command.name} source completion refused.`);
                    input.assertRecipient();
                };
                await run(captured, semantic, complete, async (text, options) => {
                    complete();
                    const deliver = async () => {
                        input.assertRecipient();
                        await send.call(effects, input.message.chat.id, input.message.message_id, text, {
                            ...options,
                            target: {
                                chatId: input.message.chat.id,
                                threadId: input.message.message_thread_id,
                            },
                            assertAuthority: input.assertRecipient,
                        });
                        input.assertRecipient();
                    };
                    // Transport waiting never changes the already reported semantic completion or licenses another effect.
                    if (replyDelivery === "inline")
                        await deliver();
                    else
                        scheduleBaleCommandEffect(ctx, input.command.name, "selected-reply", captured, deliver, input.assertRecipient);
                });
                return true;
            },
        };
    };
    const prepareHeldQueuePlan = (ctx, template) => {
        const captured = { ...deps }, owner = captured.heldTurn, enqueue = owner.enqueue;
        let retained;
        const portsCurrent = () => deps.heldTurn === owner &&
            owner.enqueue === enqueue &&
            (!template || template.isCurrent()) &&
            deps.heldTurn === owner &&
            owner.enqueue === enqueue;
        return {
            captured,
            portsCurrent,
            async run(input) {
                input.assertSemantic();
                if (template && !isDeepStrictEqual(input.command, template.command))
                    return false;
                const { carrier, source } = input;
                if (!carrier || !source)
                    return false;
                const signal = getBaleUpdateExecutionFence(carrier)?.signal;
                if (!signal || signal.aborted)
                    return false;
                const queue = input.queue ?? prepareBaleDeferredQueueAdmission(carrier);
                if (!queue || !queue.isCurrent())
                    return false;
                const ports = {
                    isCurrent: queue.isCurrent,
                    prepareCompletionScope: queue.prepareCompletionScope,
                    inspectCompletion: queue.inspectCompletion,
                };
                if (Object.values(ports).some((port) => typeof port !== "function"))
                    return false;
                const current = () => {
                    if (!portsCurrent() ||
                        !Object.entries(ports).every(([key, value]) => Reflect.get(queue, key) === value) ||
                        !ports.isCurrent.call(queue))
                        return false;
                    try {
                        input.assertRecipient();
                        return portsCurrent() && ports.isCurrent.call(queue);
                    }
                    catch {
                        return false;
                    }
                };
                const sameTarget = carrier.message_thread_id === input.message.message_thread_id;
                const message = carryBaleUpdateExecutionFence(carrier, {
                    ...carrier,
                    ...input.message,
                    pi_bale_source_update_id: source.updateId,
                    ...(template ? { text: template.expanded, caption: undefined } : {}),
                    ...(sameTarget ? {} : { message_id: 0, reply_to_message: undefined }),
                });
                const completionSha256 = createHash("sha256")
                    .update(JSON.stringify([
                    "held-command-v1",
                    randomUUID(),
                    source,
                    input.command,
                    getBaleCommandMessageTarget(message),
                ]))
                    .digest("hex");
                const admission = {
                    assertCurrent: input.assertSemantic,
                    report(receipts) {
                        input.assertSemantic();
                        const receipt = receipts[0];
                        if (retained ||
                            receipts.length !== 1 ||
                            !receipt ||
                            receipt.queueKind !== "prompt" ||
                            receipt.journalBindingKey !== source.journalBindingKey ||
                            receipt.sourceUpdateIds.length !== 1 ||
                            receipt.sourceUpdateIds[0] !== source.updateId ||
                            heldQueueReceipts.has(receipt.receiptId) ||
                            !current())
                            throw new Error("Held command needs one exact original queue receipt.");
                        const expected = structuredClone(receipt);
                        retained = {
                            ctx,
                            signal,
                            receipt,
                            queue,
                            completionSha256,
                            current: () => current() && isDeepStrictEqual(receipt, expected),
                        };
                        watchHeldQueueOwner(signal);
                        heldQueueReceipts.set(receipt.receiptId, signal.aborted ? null : retained);
                        if (!reportBaleQueueAdmission([carrier], [receipt]))
                            throw new Error("Held command queue admission refused.");
                    },
                };
                if (template)
                    await enqueue.call(owner, message, ctx, "prompt", admission);
                else
                    await handleBaleContinueCommand(message, ctx, {
                        enqueueContinueTurn: (value, context) => enqueue.call(owner, value, context, "continue", admission),
                    });
                return !!retained && current();
            },
            inspectQueuedCompletion() {
                if (!retained || !retained.current())
                    return undefined;
                const proof = retained.queue.inspectCompletion(retained.receipt);
                if (proof && retained.current()) {
                    heldQueueReceipts.delete(retained.receipt.receiptId);
                    return { ...proof };
                }
                return undefined;
            },
        };
    };
    // Held followers are already paired and bound. Start/help open the same restricted menu as status;
    // they cannot pair an operator, bootstrap another Thread or invoke unrestricted Bot API effects.
    const heldMenuPlan = {
        completion: "before-effect",
        effect: "showStatus",
        prepare(ctx, effects) {
            const scopedStatus = effects?.showStatus;
            const captured = {
                ...deps,
                showStatus: scopedStatus
                    ? (message, context, options) => {
                        const address = getBaleCommandMessageTarget(message);
                        return scopedStatus.call(effects, address.chatId, address.replyToMessageId, context, address.threadId, options);
                    }
                    : deps.showStatus,
            };
            return {
                captured,
                portsCurrent: () => !effects || effects.showStatus === scopedStatus,
                async run({ message, command, assertRecipient }) {
                    const recipientOptions = { assertAuthority: assertRecipient };
                    return handleBaleCommandRuntime("status", message, ctx, {
                        ...captured,
                        assertExecutionCurrent: assertRecipient,
                        showStatus: (value, context) => captured.showStatus(value, context, recipientOptions),
                    }, command.args);
                },
            };
        },
    };
    const heldPlans = {
        status: heldMenuPlan,
        start: heldMenuPlan,
        help: heldMenuPlan,
        abort: {
            completion: "after-semantics",
            effect: "sendTextReply",
            prepare(ctx, effects, _command, delivery) {
                return prepareHeldReplyPlan(ctx, effects, async (captured, semantic, _complete, reply) => {
                    await handleBaleAbortCommand({
                        hasAbortHandler: semantic(captured.hasAbortHandler),
                        hasActiveBaleTurn: semantic(captured.hasActiveBaleTurn),
                        clearPendingModelSwitch: semantic(captured.clearPendingModelSwitch),
                        cancelNextTransitionAnnouncements: captured.cancelNextTransitionAnnouncements &&
                            semantic(captured.cancelNextTransitionAnnouncements),
                        abortCurrentTurn: semantic(captured.abortCurrentTurn),
                        setFoldQueuedPromptsIntoHistory: semantic(captured.setFoldQueuedPromptsIntoHistory),
                        updateStatus: semantic(() => captured.updateStatus(ctx)),
                        sendTextReply: reply,
                    });
                }, delivery);
            },
        },
        stop: {
            completion: "after-semantics",
            effect: "sendTextReply",
            available: () => typeof deps.cancelNextTransitionAnnouncements === "function" &&
                typeof deps.clearQueuedBaleItems === "function",
            prepare(ctx, effects, _command, delivery) {
                return prepareHeldReplyPlan(ctx, effects, async (captured, semantic, _complete, reply) => {
                    await handleBaleStopCommand({
                        hasAbortHandler: semantic(captured.hasAbortHandler),
                        clearPendingModelSwitch: semantic(captured.clearPendingModelSwitch),
                        cancelNextTransitionAnnouncements: semantic(captured.cancelNextTransitionAnnouncements),
                        clearQueuedBaleItems: semantic(() => captured.clearQueuedBaleItems(ctx)),
                        setFoldQueuedPromptsIntoHistory: semantic(captured.setFoldQueuedPromptsIntoHistory),
                        abortCurrentTurn: semantic(captured.abortCurrentTurn),
                        updateStatus: semantic(() => captured.updateStatus(ctx)),
                        sendTextReply: reply,
                    });
                }, delivery);
            },
        },
        next: {
            completion: "after-semantics",
            effect: "sendTextReply",
            available: () => typeof deps.requestNextDispatchAnnouncement === "function" &&
                typeof deps.markActiveTurnNextAbortAnnouncement === "function",
            prepare(ctx, effects, _command, delivery) {
                return prepareHeldReplyPlan(ctx, effects, async (captured, semantic, complete, reply) => {
                    await handleBaleNextCommand({
                        hasAbortHandler: semantic(captured.hasAbortHandler),
                        isIdle: semantic(() => captured.isIdle(ctx)),
                        hasQueuedItems: semantic(captured.hasQueuedBaleItems),
                        clearPendingModelSwitch: semantic(captured.clearPendingModelSwitch),
                        abortCurrentTurn: semantic(captured.abortCurrentTurn),
                        dispatchNextQueuedTurn: semantic(() => captured.dispatchNextQueuedBaleTurn(ctx)),
                        requestNextDispatchAnnouncement: semantic(captured.requestNextDispatchAnnouncement),
                        markActiveTurnNextAbortAnnouncement: semantic(captured.markActiveTurnNextAbortAnnouncement),
                        clearFoldForDispatch: semantic(() => captured.setFoldQueuedPromptsIntoHistory(false)),
                        updateStatus() {
                            semantic(() => captured.updateStatus(ctx))();
                            complete();
                        },
                        sendTextReply: reply,
                    });
                }, delivery);
            },
        },
        continue: {
            completion: "queue-receipt",
            available: () => typeof deps.heldTurn?.enqueue === "function",
            prepare(ctx) {
                return prepareHeldQueuePlan(ctx);
            },
        },
    };
    const getHeldTemplatePlan = (name) => {
        const owner = deps.heldTurn, templates = owner?.templates, get = templates?.getCommands, expand = templates?.expand;
        if (!owner ||
            !templates ||
            typeof owner.enqueue !== "function" ||
            typeof get !== "function" ||
            typeof expand !== "function" ||
            getBaleReservedCommandNames().includes(name) ||
            findBaleExtensionCommand(name))
            return undefined;
        const getIdentity = () => {
            const matching = get
                .call(templates)
                .filter((value) => value.command === name);
            const selected = matching[0];
            return matching.length === 1 &&
                selected &&
                typeof selected.path === "string" &&
                selected.path.trim()
                ? { command: selected.command, path: selected.path }
                : undefined;
        };
        let identity;
        try {
            identity = getIdentity();
        }
        catch {
            return undefined;
        }
        if (!identity)
            return undefined;
        const current = () => {
            if (deps.heldTurn !== owner ||
                owner.templates !== templates ||
                templates.getCommands !== get ||
                templates.expand !== expand ||
                findBaleExtensionCommand(name))
                return false;
            try {
                return (isDeepStrictEqual(getIdentity(), identity) &&
                    deps.heldTurn === owner &&
                    owner.templates === templates &&
                    templates.getCommands === get &&
                    templates.expand === expand &&
                    !findBaleExtensionCommand(name));
            }
            catch {
                return false;
            }
        };
        if (!current())
            return undefined;
        return {
            completion: "queue-receipt",
            template: true,
            prepare(ctx, _effects, command) {
                if (!command || command.name !== name || !current())
                    return undefined;
                const captured = { ...command };
                let expanded;
                try {
                    expanded = expand.call(templates, captured.name, captured.args);
                }
                catch {
                    return undefined;
                }
                if (typeof expanded !== "string" || !current())
                    return undefined;
                return prepareHeldQueuePlan(ctx, {
                    command: captured,
                    expanded,
                    isCurrent() {
                        if (!current())
                            return false;
                        try {
                            return (expand.call(templates, captured.name, captured.args) ===
                                expanded && current());
                        }
                        catch {
                            return false;
                        }
                    },
                });
            },
        };
    };
    const getHeldPlan = (name, effects) => {
        if (!Object.hasOwn(heldPlans, name))
            return getHeldTemplatePlan(name);
        const plan = heldPlans[name];
        if (plan.available?.() === false)
            return undefined;
        if ((plan.effect &&
            effects !== undefined &&
            (!effects || typeof effects[plan.effect] !== "function")) ||
            (plan.effect === "sendTextReply" && !effects) ||
            (plan.effect === "showStatus" &&
                effects === undefined &&
                typeof deps.showStatus !== "function"))
            return undefined;
        return plan;
    };
    const prepareSelectedPlan = (command, messages, ctx, admission) => {
        const original = messages[0];
        if (!["status", "abort", "stop", "next"].includes(command.name) ||
            messages.length !== 1 ||
            !original ||
            typeof admission.assertSourceCurrent !== "function" ||
            typeof admission.assertRecipientCurrent !== "function" ||
            typeof admission.reportCompleted !== "function")
            return undefined;
        const captured = { ...deps }, parsed = { ...command }, message = parsed.name === "status"
            ? copySelectedMenuCarrier(original)
            : copySelectedReplyAnchor(original);
        const assertRecipientCurrent = admission.assertRecipientCurrent, report = admission.reportCompleted, beforeEffects = admission.beforeEffects;
        const effects = parsed.name === "status"
            ? undefined
            : {
                async sendTextReply(_chat, _anchor, text, options) {
                    await captured.sendTextReply(message, text, {
                        parseMode: options.parseMode,
                        assertAuthority: options.assertAuthority,
                    });
                },
            };
        const plan = getHeldPlan(parsed.name, effects);
        if (!plan ||
            plan.completion === "queue-receipt" ||
            (parsed.name !== "status" && typeof captured.sendTextReply !== "function"))
            return undefined;
        const prepared = plan.prepare(ctx, effects, parsed, "inline");
        if (!prepared)
            return undefined;
        const semantic = createSelectedSemanticGuard(admission, () => captured.assertExecutionCurrent?.(original), plan.completion === "before-effect");
        const assertCurrent = () => {
            semantic();
            if (!prepared.portsCurrent())
                throw new Error(`Selected ${parsed.name} plan owner is unavailable.`);
        };
        return issueSelectedOnce(assertCurrent, async () => {
            if (plan.completion === "before-effect") {
                if (!report.call(admission))
                    return false;
                if (beforeEffects)
                    await beforeEffects();
                assertRecipientCurrent();
            }
            return prepared.run({
                message,
                command: parsed,
                assertSemantic: assertCurrent,
                assertRecipient: assertRecipientCurrent,
                reportCompleted: () => report.call(admission),
            });
        });
    };
    const prepareSelectedHelp = (name) => (command, messages, ctx, admission) => {
        const original = messages[0];
        if (command.name !== name ||
            messages.length !== 1 ||
            !original ||
            !canPairBaleUserFromCommandMessage(original) ||
            original.from?.id === undefined ||
            original.from.is_bot)
            return undefined;
        const captured = { ...deps }, userId = original.from.id;
        if (captured.getAllowedUserId() !== userId)
            return undefined;
        const message = {
            ...copySelectedReplyAnchor(original),
            from: { ...original.from },
        };
        const assertRecipientCurrent = admission.assertRecipientCurrent, reportCompleted = admission.reportCompleted, beforeEffects = admission.beforeEffects;
        const assertAdmissionCurrent = createSelectedSemanticGuard(admission, () => captured.assertExecutionCurrent?.(original), false);
        const assertSemanticCurrent = () => {
            assertAdmissionCurrent();
            if (captured.getAllowedUserId() !== userId)
                throw new Error(`Selected ${name} operator authority is unavailable.`);
        };
        return issueSelectedOnce(assertSemanticCurrent, () => handleBaleHelpCommand(name, message, ctx, {
            ...captured,
            persistAllowedUserId: async () => {
                throw new Error(`Selected ${name} cannot acquire pairing authority.`);
            },
        }, { assertSemanticCurrent, assertRecipientCurrent, reportCompleted, beforeEffects }));
    };
    const prepareSelectedConfirmation = (name) => (command, messages, ctx, admission) => {
        const original = messages[0], captured = { ...deps };
        if (command.name !== name ||
            messages.length !== 1 ||
            !original ||
            !captured.sendInteractiveMessage)
            return undefined;
        const target = getBaleCommandMessageTarget(original);
        const assertRecipientCurrent = admission.assertRecipientCurrent, reportCompleted = admission.reportCompleted;
        const openConfirmation = name === "new"
            ? openBaleNewConfirmation
            : openBaleCompactConfirmation;
        const assertSemanticCurrent = createSelectedSemanticGuard(admission, () => captured.assertExecutionCurrent?.(original), true);
        return issueSelectedOnce(assertSemanticCurrent, async () => {
            if (!reportCompleted())
                return false;
            assertRecipientCurrent();
            scheduleBaleCommandEffect(ctx, name, "confirmation-render", captured, () => openConfirmation(target, { sendInteractiveMessage: captured.sendInteractiveMessage }, assertRecipientCurrent), assertRecipientCurrent);
            return true;
        });
    };
    return Object.assign(handle, {
        /** Command-only producer execution; Routing must supply the captured plan and released exact-source authority. */
        prepareSelectedExtensionCommand(prepared, messages, ctx, admission) {
            const original = messages[0], captured = { ...deps }, plan = prepared.plan;
            if (messages.length !== 1 ||
                !original ||
                plan.kind !== "command-only" ||
                typeof captured.sendTextReply !== "function" ||
                typeof admission.reportCompleted !== "function")
                return undefined;
            const execute = plan.execute, assertRegistrationCurrent = prepared.assertRegistrationCurrent;
            const assertSourceCurrent = admission.assertSourceCurrent, recipientCurrent = admission.assertRecipientCurrent;
            const reportCompleted = admission.reportCompleted;
            // Only a body-free fixed recipient/anchor enters detached delivery, never the original's admission symbols.
            const message = copySelectedReplyAnchor(original);
            const assertRecipientCurrent = () => {
                if (captured.isContextActive?.(ctx) === false)
                    throw new Error("Selected extension context changed.");
                assertRegistrationCurrent();
                recipientCurrent();
                assertRegistrationCurrent();
                if (captured.isContextActive?.(ctx) === false)
                    throw new Error("Selected extension context changed.");
            };
            const assertCurrent = () => {
                assertSourceCurrent();
                captured.assertExecutionCurrent?.(original);
                assertRecipientCurrent();
                assertSourceCurrent();
                captured.assertExecutionCurrent?.(original);
            };
            try {
                assertCurrent();
            }
            catch {
                return undefined;
            }
            let issued = false, reportAttempted = false;
            const execution = Object.freeze({
                assertCurrent,
                reportCompleted() {
                    if (!issued || reportAttempted)
                        return false;
                    // Lost/refused reports never authorize another completion attempt or producer execution.
                    reportAttempted = true;
                    assertCurrent();
                    return reportCompleted();
                },
                reply(text) {
                    assertRecipientCurrent();
                    if (typeof text !== "string")
                        throw new Error("Selected extension reply requires text.");
                    scheduleBaleCommandEffect(ctx, "extension", "selected-reply", captured, () => captured.sendTextReply(message, text, {
                        assertAuthority: assertRecipientCurrent,
                    }), assertRecipientCurrent);
                },
            });
            return async () => {
                if (issued)
                    return;
                issued = true;
                assertCurrent();
                await execute(execution);
                // Return, rejection and reply delivery are deliberately not semantic completion reports.
            };
        },
        /** Selected help/start require the existing authenticated owner; cold pairing remains ordinary first contact. */
        prepareSelectedStartCommand: prepareSelectedHelp("start"),
        prepareSelectedHelpCommand: prepareSelectedHelp("help"),
        /** Selected new handles only confirmation; the later authenticated callback owns replacement admission. */
        prepareSelectedNewCommand: prepareSelectedConfirmation("new"),
        /** Selected compaction handles only confirmation; the later authenticated callback owns actual compaction. */
        prepareSelectedCompactCommand: prepareSelectedConfirmation("compact"),
        /** Bare naming completes only after the exact dialog owner confirms current publication, not delivery alone. */
        prepareSelectedNameDialogCommand(command, messages, ctx, admission) {
            const original = messages[0], captured = { ...deps };
            if (command.name !== "name" ||
                command.args.trim() ||
                messages.length !== 1 ||
                !original ||
                !captured.openThreadNameDialog)
                return undefined;
            const message = copySelectedReplyAnchor(original);
            const assertSourceCurrent = admission.assertSourceCurrent, assertRecipientCurrent = admission.assertRecipientCurrent;
            const reportCompleted = admission.reportCompleted;
            const assertSemanticCurrent = createSelectedSemanticGuard(admission, () => captured.assertExecutionCurrent?.(original), true);
            return issueSelectedOnce(assertSemanticCurrent, async () => {
                const publication = await captured.openThreadNameDialog(message, ctx, {
                    assertSemanticCurrent,
                    assertRecipientCurrent,
                });
                assertSemanticCurrent();
                const assertPublished = publication?.assertPublished;
                if (typeof assertPublished !== "function")
                    throw new Error("Selected name dialog publication is unconfirmed.");
                assertPublished();
                assertSemanticCurrent();
                assertPublished();
                assertSourceCurrent();
                captured.assertExecutionCurrent?.(original);
                if (!reportCompleted())
                    throw new Error("Selected name source completion refused.");
                return true;
            });
        },
        /** Explicit naming retains source authority until its owner result; bare dialogs use their own publication leaf. */
        prepareSelectedNameCommand(command, messages, ctx, admission) {
            const original = messages[0], threadName = command.args.trim(), captured = { ...deps };
            if (command.name !== "name" ||
                messages.length !== 1 ||
                !original ||
                !threadName ||
                (/^[A-Z]$/.test(threadName)
                    ? !captured.resetCurrentThreadName
                    : !captured.renameCurrentThread))
                return undefined;
            const message = copySelectedReplyAnchor(original);
            const assertRecipientCurrent = admission.assertRecipientCurrent, reportCompleted = admission.reportCompleted;
            const assertSemanticCurrent = createSelectedSemanticGuard(admission, () => captured.assertExecutionCurrent?.(original), true);
            return issueSelectedOnce(assertSemanticCurrent, async () => {
                await handleBaleNameCommand(message, ctx, threadName, captured, {
                    assertSemanticCurrent,
                    assertRecipientCurrent,
                    reportCompleted,
                });
                return true;
            });
        },
        /** Genuine leader originals capture their warm queue owner before release; no hold copy or semantic-completion report. */
        prepareSelectedQueueCommand(command, messages, ctx, admission) {
            const original = messages[0], parsed = { ...command };
            if (messages.length !== 1 ||
                !original ||
                typeof admission.assertSourceCurrent !== "function" ||
                typeof admission.assertRecipientCurrent !== "function")
                return undefined;
            const raw = Reflect.get(original, "text") ?? Reflect.get(original, "caption"), operator = deps.getAllowedUserId();
            const actual = typeof raw === "string" ? parseBaleCommand(raw) : undefined;
            if (!isDeepStrictEqual(actual, parsed) ||
                typeof operator !== "number" ||
                original.chat.type !== "private" ||
                original.chat.id !== operator ||
                original.from?.id !== operator ||
                original.from.is_bot ||
                admission.target.chatId !== operator ||
                !Number.isSafeInteger(admission.target.threadId) ||
                admission.target.threadId < 1)
                return undefined;
            const plan = getHeldPlan(parsed.name);
            if (!plan || plan.completion !== "queue-receipt")
                return undefined;
            const source = inspectBaleDeferredSource(original), queue = prepareBaleDeferredQueueAdmission(original);
            if (!source || source.completionSha256 || !queue?.isCurrent())
                return undefined;
            const prepared = plan.prepare(ctx, undefined, parsed);
            if (!prepared)
                return undefined;
            const target = { ...admission.target }, originalProjection = structuredClone(copySelectedMenuCarrier(original));
            const message = structuredClone(originalProjection);
            message.message_thread_id = target.threadId;
            const assertSource = admission.assertSourceCurrent, assertRecipient = admission.assertRecipientCurrent;
            const assertCurrent = () => {
                assertSource.call(admission);
                prepared.captured.assertExecutionCurrent?.(original);
                assertRecipient.call(admission);
                if (deps.getAllowedUserId() !== operator ||
                    !queue.isCurrent() ||
                    !prepared.portsCurrent() ||
                    !isDeepStrictEqual(copySelectedMenuCarrier(original), originalProjection) ||
                    !isDeepStrictEqual(inspectBaleDeferredSource(original), source))
                    throw new Error("Selected queue command source/owner changed.");
                assertSource.call(admission);
                prepared.captured.assertExecutionCurrent?.(original);
            };
            const execute = issueSelectedOnce(assertCurrent, async () => {
                const release = acquireBaleUpdateRouting(original);
                try {
                    assertCurrent();
                    return await prepared.run({
                        message,
                        carrier: original,
                        source: { ...source },
                        queue,
                        command: { ...parsed },
                        assertSemantic: assertCurrent,
                        assertRecipient,
                        reportCompleted() {
                            throw new Error("Queue admission cannot report semantic source removal.");
                        },
                    });
                }
                finally {
                    release();
                }
            });
            return {
                get source() {
                    return { ...source };
                },
                get command() {
                    return { ...parsed };
                },
                execute,
                inspectCompletion() {
                    try {
                        assertRecipient.call(admission);
                        if (deps.getAllowedUserId() !== operator ||
                            !queue.isCurrent() ||
                            !prepared.portsCurrent())
                            return undefined;
                        const proof = prepared.inspectQueuedCompletion?.();
                        assertRecipient.call(admission);
                        return deps.getAllowedUserId() === operator &&
                            queue.isCurrent() &&
                            prepared.portsCurrent()
                            ? proof
                            : undefined;
                    }
                    catch {
                        return undefined;
                    }
                },
            };
        },
        /** Selected leaders reuse registry semantics; native source/recipient admission and inline transport remain role-owned. */
        prepareSelectedCommand: prepareSelectedPlan,
        /** Existing native publication boundary; unrelated/legacy receipts keep their ordinary owner. */
        prepareHeldQueueReceipt: ((receipt, queueOwner, context, isWorkerCurrent) => {
            const record = heldQueueReceipts.get(receipt.receiptId);
            if (record === null)
                throw new Error("Held queue receipt publication authority changed.");
            if (!record)
                return undefined;
            if (context !== record.ctx ||
                !isWorkerCurrent() ||
                !record.current() ||
                !isDeepStrictEqual(record.receipt, receipt))
                throw new Error("Held queue receipt publication authority changed.");
            const scope = record.queue.prepareCompletionScope(record.receipt, queueOwner, record.completionSha256);
            if (!scope || !isWorkerCurrent() || !record.current())
                throw new Error("Held queue receipt original scope is unavailable.");
            return [scope];
        }),
        /** Pure registry/effect availability; never reads a source or activates future recipient authority. */
        canPrepareHeldCommand(name, effects) {
            return getHeldPlan(name, effects) !== undefined;
        },
        /** Compile one registry plan from a saved original; no admission, recipient activation or update-handler replay. */
        prepareHeldCommand(name, readiness, ctx, admission, effects) {
            const plan = getHeldPlan(name, effects);
            if (!plan)
                return undefined;
            const value = plan.template
                ? readiness.snapshot.update.message
                : undefined;
            const command = value &&
                typeof value === "object" &&
                typeof Reflect.get(value, "text") === "string"
                ? parseBaleCommand(Reflect.get(value, "text"))
                : undefined;
            const prepared = plan.prepare(ctx, effects, command);
            if (!prepared)
                return undefined;
            return prepareHeldSelectedCommand(name, readiness, admission, prepared.captured, prepared.portsCurrent, plan.completion, prepared.run, prepared.inspectQueuedCompletion);
        },
        /** Warm menu-only issuance; completion reporting is not a receipt or a durable removal ACK. */
        prepareSelectedMenuCommand(command, messages, ctx, admission) {
            const action = buildBaleCommandAction(command.name);
            if (messages.length !== 1 ||
                !messages[0] ||
                !["status", "model", "thinking", "queue", "settings"].includes(action.kind) ||
                (action.kind === "settings" && !deps.openSettingsMenu))
                return undefined;
            if (action.kind === "status")
                return prepareSelectedPlan(command, messages, ctx, admission);
            const original = messages[0], name = command.name, args = command.args;
            if (typeof admission.assertSourceCurrent !== "function" ||
                typeof admission.assertRecipientCurrent !== "function" ||
                typeof admission.reportCompleted !== "function")
                return undefined;
            const assertSourceCurrent = admission.assertSourceCurrent, assertRecipientCurrent = admission.assertRecipientCurrent;
            const reportCompleted = admission.reportCompleted, beforeEffects = admission.beforeEffects, assertExecutionCurrent = deps.assertExecutionCurrent;
            const assertIssuanceCurrent = () => {
                assertSourceCurrent.call(admission);
                assertExecutionCurrent?.call(deps, original);
                assertRecipientCurrent();
                // Recipient observations can revoke the source too; never complete from an earlier source sample.
                assertSourceCurrent.call(admission);
                assertExecutionCurrent?.call(deps, original);
            };
            // Preparation proves branch availability, not the future released recipient's active authority.
            // Detached rendering must not inherit the original admission/fence or a mutable target carrier.
            const message = copySelectedMenuCarrier(original);
            const menuDeps = { ...deps };
            const recipientOptions = { assertAuthority: assertRecipientCurrent };
            const recipientDeps = {
                ...deps,
                assertExecutionCurrent: assertRecipientCurrent,
                showStatus: (value, context) => menuDeps.showStatus(value, context, recipientOptions),
                openModelMenu: (value, context) => menuDeps.openModelMenu(value, context, recipientOptions),
                openThinkingMenu: (value, context) => menuDeps.openThinkingMenu(value, context, recipientOptions),
                openQueueMenu: (value, context) => menuDeps.openQueueMenu(value, context, recipientOptions),
                openSettingsMenu: menuDeps.openSettingsMenu &&
                    ((value, context) => menuDeps.openSettingsMenu(value, context, recipientOptions)),
            };
            return issueSelectedOnce(assertIssuanceCurrent, async () => {
                if (!reportCompleted.call(admission))
                    return false;
                if (beforeEffects)
                    await beforeEffects();
                assertRecipientCurrent();
                return handleBaleCommandRuntime(name, message, ctx, recipientDeps, args);
            });
        },
    });
}
export function createBaleCommandOrPromptDispatcher(deps) {
    const dispatchPromptTemplate = async (command, messages, ctx) => {
        const first = messages[0];
        if (!first)
            return false;
        deps.assertExecutionCurrent?.(first);
        const expanded = command && deps.expandPromptTemplateCommand?.(command.name, command.args);
        if (expanded === undefined)
            return false;
        deps.assertExecutionCurrent?.(first);
        const replaced = deps.replaceMessageText(first, expanded);
        deps.assertExecutionCurrent?.(first);
        await deps.enqueueTurn([replaced, ...messages.slice(1)], ctx);
        return true;
    };
    return async (messages, ctx) => {
        const firstMessage = messages[0];
        if (!firstMessage)
            return;
        if (deps.shouldIgnoreMessages?.(messages))
            return;
        deps.assertExecutionCurrent?.(firstMessage);
        if (await deps.consumeThreadNameInput?.(messages, ctx)) {
            deps.assertExecutionCurrent?.(firstMessage);
            return;
        }
        const command = parseBaleCommand(deps.extractRawText(messages));
        const handled = await deps.handleCommand(command?.name, firstMessage, ctx, command?.args);
        deps.assertExecutionCurrent?.(firstMessage);
        if (handled)
            return;
        if (command && deps.executeExtensionCommand) {
            const handledByExtension = await deps.executeExtensionCommand(command, messages[0], ctx);
            deps.assertExecutionCurrent?.(firstMessage);
            if (handledByExtension)
                return;
        }
        if (await dispatchPromptTemplate(command, messages, ctx))
            return;
        deps.assertExecutionCurrent?.(firstMessage);
        await deps.enqueueTurn(messages, ctx);
    };
}
function scheduleBaleCommandEffect(ctx, command, phase, deps, effect, assertExecutionCurrent) {
    const work = deps.beginCommandEffectWork?.();
    let started = false, outcome = "settled";
    void Promise.resolve()
        .then(async () => {
        if (deps.isContextActive?.(ctx) === false)
            return;
        assertExecutionCurrent?.();
        started = true;
        await effect();
        assertExecutionCurrent?.();
    })
        .catch((error) => {
        // A failed started effect cannot prove non-issuance; never turn its uncertainty into known idle.
        if (started &&
            !(error instanceof BaleApiAuthorityError && !error.requestIssued))
            outcome = "unconfirmed";
        try {
            deps.recordRuntimeEvent?.("bale-command", error, {
                command,
                phase,
            });
        }
        catch {
            // Effect diagnostics cannot create an unhandled detached Promise.
        }
    })
        .finally(() => work?.settle(outcome));
}
async function handleBaleHelpCommand(commandName, message, ctx, deps, admission) {
    const assertSemanticCurrent = admission?.assertSemanticCurrent ??
        (() => deps.assertExecutionCurrent?.(message));
    admission?.assertSemanticCurrent();
    if (message.from?.id !== undefined &&
        canPairBaleUserFromCommandMessage(message)) {
        const allowed = await pairBaleUserIfNeeded(message.from.id, {
            allowedUserId: deps.getAllowedUserId(),
            ctx: undefined,
            persistAllowedUserId: deps.persistAllowedUserId,
            updateStatus: () => deps.updateStatus(ctx),
            assertExecutionCurrent: assertSemanticCurrent,
        });
        if (!allowed)
            return false;
    }
    if (admission) {
        assertSemanticCurrent();
        if (!admission.reportCompleted())
            return false;
        if (admission.beforeEffects)
            await admission.beforeEffects();
        admission.assertRecipientCurrent();
    }
    const assertEffectCurrent = admission?.assertRecipientCurrent ??
        (() => deps.assertExecutionCurrent?.(message));
    const options = admission && {
        assertAuthority: admission.assertRecipientCurrent,
    };
    const isContextActive = () => deps.isContextActive?.(ctx) !== false;
    scheduleBaleCommandEffect(ctx, commandName, "menu-render", deps, async () => {
        let forumBootstrapMessage;
        if (commandName === "start" && deps.handleForumBootstrap) {
            forumBootstrapMessage = await deps.handleForumBootstrap(message, ctx, options);
        }
        if (!isContextActive())
            return;
        assertEffectCurrent();
        if (forumBootstrapMessage) {
            await deps.sendTextReply(message, forumBootstrapMessage, options);
            assertEffectCurrent();
        }
        if (!isContextActive())
            return;
        assertEffectCurrent();
        await deps.showStatus(message, ctx, options);
    }, assertEffectCurrent);
    scheduleBaleCommandEffect(ctx, commandName, "bot-command-sync", deps, () => deps.registerBotCommands(options), assertEffectCurrent);
    return true;
}
async function handleBaleNameCommand(message, ctx, requestedName, deps, admission) {
    const threadName = requestedName.trim();
    const reply = async (text) => {
        if (admission) {
            admission.assertSemanticCurrent();
            if (!admission.reportCompleted())
                throw new Error("Selected name source completion refused.");
            admission.assertRecipientCurrent();
            await deps.sendTextReply(message, text, {
                parseMode: "HTML",
                assertAuthority: admission.assertRecipientCurrent,
            });
            admission.assertRecipientCurrent();
        }
        else {
            deps.assertExecutionCurrent?.(message);
            await deps.sendTextReply(message, text, { parseMode: "HTML" });
            deps.assertExecutionCurrent?.(message);
        }
    };
    if (!threadName) {
        if (deps.openThreadNameDialog)
            await deps.openThreadNameDialog(message, ctx);
        else
            await reply(formatBaleInformationHeading("🏷️", "Usage: /name Navigator"));
        return;
    }
    if (/^[A-Z]$/.test(threadName) && deps.resetCurrentThreadName) {
        admission?.assertSemanticCurrent();
        const target = getBaleCommandMessageTarget(message);
        const result = admission
            ? await deps.resetCurrentThreadName(target, {
                assertAuthority: admission.assertSemanticCurrent,
            })
            : await deps.resetCurrentThreadName(target);
        admission?.assertSemanticCurrent();
        await reply(result.ok && !result.message
            ? formatBaleAutomaticThreadDisplayNameRestoredHeading(result.threadName ?? threadName)
            : formatBaleInformationHeading(result.ok ? "✅" : "⚠️", result.message ?? "Thread display name reset failed."));
        return;
    }
    admission?.assertSemanticCurrent();
    const validationError = deps.validateThreadName?.(threadName);
    admission?.assertSemanticCurrent();
    if (validationError) {
        await reply(formatBaleInvalidInstanceName(validationError));
        return;
    }
    if (!deps.renameCurrentThread) {
        await reply(formatBaleInformationHeading("🚫", "Thread display naming is unavailable."));
        return;
    }
    if (admission)
        admission.assertSemanticCurrent();
    else
        deps.assertExecutionCurrent?.(message);
    const target = getBaleCommandMessageTarget(message);
    const result = admission
        ? await deps.renameCurrentThread(target, threadName, {
            assertAuthority: admission.assertSemanticCurrent,
        })
        : await deps.renameCurrentThread(target, threadName);
    if (admission)
        admission.assertSemanticCurrent();
    else
        deps.assertExecutionCurrent?.(message);
    await reply(result.ok && !result.message
        ? formatBaleThreadDisplayNameSavedHeading(result.threadName ?? threadName)
        : formatBaleInformationHeading(result.ok ? "✅" : "⚠️", result.message ?? "Thread display name update failed."));
}
async function handleBaleCommandRuntime(commandName, message, ctx, deps, commandArgs = "") {
    deps.assertExecutionCurrent?.(message);
    const assertExecutionCurrentFor = (nextMessage) => () => deps.assertExecutionCurrent?.(nextMessage);
    const sendReplyFor = (nextMessage) => async (text, options) => {
        deps.assertExecutionCurrent?.(nextMessage);
        await deps.sendTextReply(nextMessage, text, options);
        deps.assertExecutionCurrent?.(nextMessage);
    };
    const updateStatusFor = (commandCtx) => () => deps.updateStatus(commandCtx);
    return executeBaleCommandAction(buildBaleCommandAction(commandName), message, ctx, {
        handleStop: async (nextMessage, commandCtx) => {
            await handleBaleStopCommand({
                hasAbortHandler: deps.hasAbortHandler,
                clearPendingModelSwitch: deps.clearPendingModelSwitch,
                cancelNextTransitionAnnouncements: deps.cancelNextTransitionAnnouncements,
                clearQueuedBaleItems: () => deps.clearQueuedBaleItems(commandCtx),
                setFoldQueuedPromptsIntoHistory: deps.setFoldQueuedPromptsIntoHistory,
                abortCurrentTurn: deps.abortCurrentTurn,
                updateStatus: updateStatusFor(commandCtx),
                sendTextReply: sendReplyFor(nextMessage),
            });
        },
        handleName: (nextMessage, commandCtx, requestedName) => handleBaleNameCommand(nextMessage, commandCtx, requestedName, deps),
        handleAbort: async (nextMessage, commandCtx) => {
            await handleBaleAbortCommand({
                hasAbortHandler: deps.hasAbortHandler,
                hasActiveBaleTurn: deps.hasActiveBaleTurn,
                clearPendingModelSwitch: deps.clearPendingModelSwitch,
                cancelNextTransitionAnnouncements: deps.cancelNextTransitionAnnouncements,
                abortCurrentTurn: deps.abortCurrentTurn,
                setFoldQueuedPromptsIntoHistory: deps.setFoldQueuedPromptsIntoHistory,
                updateStatus: updateStatusFor(commandCtx),
                sendTextReply: sendReplyFor(nextMessage),
            });
        },
        handleNext: async (nextMessage, commandCtx) => {
            await handleBaleNextCommand({
                hasAbortHandler: deps.hasAbortHandler,
                isIdle: () => deps.isIdle(commandCtx),
                hasQueuedItems: deps.hasQueuedBaleItems,
                clearPendingModelSwitch: deps.clearPendingModelSwitch,
                abortCurrentTurn: deps.abortCurrentTurn,
                dispatchNextQueuedTurn: () => deps.dispatchNextQueuedBaleTurn(commandCtx),
                requestNextDispatchAnnouncement: deps.requestNextDispatchAnnouncement,
                markActiveTurnNextAbortAnnouncement: deps.markActiveTurnNextAbortAnnouncement,
                clearFoldForDispatch: () => deps.setFoldQueuedPromptsIntoHistory(false),
                updateStatus: updateStatusFor(commandCtx),
                sendTextReply: sendReplyFor(nextMessage),
                getActiveTurnReply: deps.getActiveTurnReply,
            });
        },
        handleContinue: async (nextMessage, commandCtx) => {
            await handleBaleContinueCommand(nextMessage, commandCtx, {
                enqueueContinueTurn: deps.enqueueContinueTurn,
            });
        },
        handleQueue: async (nextMessage, commandCtx) => {
            scheduleBaleCommandEffect(commandCtx, "queue", "menu-render", deps, () => deps.openQueueMenu(nextMessage, commandCtx), assertExecutionCurrentFor(nextMessage));
        },
        handleNew: async (nextMessage, commandCtx) => {
            if (deps.sendInteractiveMessage) {
                await openBaleNewConfirmation(getBaleCommandMessageTarget(nextMessage), { sendInteractiveMessage: deps.sendInteractiveMessage });
                return;
            }
            await handleBaleNewCommand({
                isIdle: () => deps.isIdle(commandCtx),
                hasPendingMessages: () => deps.hasPendingMessages(commandCtx),
                hasActiveBaleTurn: deps.hasActiveBaleTurn,
                hasDispatchPending: deps.hasDispatchPending,
                hasQueuedBaleItems: deps.hasQueuedBaleItems,
                isCompactionInProgress: deps.isCompactionInProgress,
                requestNewSession: deps.requestNewSession
                    ? () => deps.requestNewSession(nextMessage)
                    : undefined,
                sendTextReply: sendReplyFor(nextMessage),
                recordRuntimeEvent: deps.recordRuntimeEvent,
            });
        },
        handleCompact: async (nextMessage, commandCtx) => {
            if (deps.sendInteractiveMessage) {
                await openBaleCompactConfirmation(getBaleCommandMessageTarget(nextMessage), { sendInteractiveMessage: deps.sendInteractiveMessage });
                return;
            }
            await handleBaleCompactCommand({
                isIdle: () => deps.isIdle(commandCtx),
                hasPendingMessages: () => deps.hasPendingMessages(commandCtx),
                hasActiveBaleTurn: deps.hasActiveBaleTurn,
                hasDispatchPending: deps.hasDispatchPending,
                hasQueuedBaleItems: deps.hasQueuedBaleItems,
                isCompactionInProgress: deps.isCompactionInProgress,
                setCompactionInProgress: deps.setCompactionInProgress,
                updateStatus: updateStatusFor(commandCtx),
                dispatchNextQueuedBaleTurn: () => deps.dispatchNextQueuedBaleTurn(commandCtx),
                requestDeferredDispatchNextQueuedBaleTurn: deps.requestDeferredDispatchNextQueuedBaleTurn
                    ? (dispatch) => deps.requestDeferredDispatchNextQueuedBaleTurn?.(() => dispatch())
                    : undefined,
                compact: (callbacks) => deps.compact(commandCtx, callbacks),
                startTypingLoop: deps.startTypingLoop
                    ? () => deps.startTypingLoop?.(commandCtx, nextMessage.chat.id, {
                        target: getBaleCommandMessageTarget(nextMessage),
                    })
                    : undefined,
                stopTypingLoop: deps.stopTypingLoop,
                sendTextReply: sendReplyFor(nextMessage),
                recordRuntimeEvent: deps.recordRuntimeEvent,
            });
        },
        handleStatus: async (nextMessage, commandCtx) => {
            scheduleBaleCommandEffect(commandCtx, "status", "menu-render", deps, () => deps.showStatus(nextMessage, commandCtx), assertExecutionCurrentFor(nextMessage));
        },
        handleModel: async (nextMessage, commandCtx) => {
            scheduleBaleCommandEffect(commandCtx, "model", "menu-render", deps, () => handleBaleModelCommand({
                ctx: commandCtx,
                openModelMenu: (controlCtx) => deps.openModelMenu(nextMessage, controlCtx),
            }), assertExecutionCurrentFor(nextMessage));
        },
        handleThinking: async (nextMessage, commandCtx) => {
            scheduleBaleCommandEffect(commandCtx, "thinking", "menu-render", deps, () => deps.openThinkingMenu(nextMessage, commandCtx), assertExecutionCurrentFor(nextMessage));
        },
        handleSettings: deps.openSettingsMenu
            ? async (nextMessage, commandCtx) => {
                scheduleBaleCommandEffect(commandCtx, "settings", "menu-render", deps, () => deps.openSettingsMenu(nextMessage, commandCtx), assertExecutionCurrentFor(nextMessage));
            }
            : undefined,
        handleHelp: async (nextMessage, nextCommandName, commandCtx) => {
            await handleBaleHelpCommand(nextCommandName, nextMessage, commandCtx, deps);
        },
    }, commandArgs);
}
export const BALE_CONNECT_COMMAND_NAME = "bale-connect";
export const BALE_INTERNAL_COMMAND_FLAG = "--internal";
export const BALE_INTERNAL_MANUAL_USE_MESSAGE = "This internal Bale action cannot be run manually.";
function delayBaleSessionAction(delayMs) {
    return new Promise((resolve) => setTimeout(resolve, delayMs));
}
export async function settleBaleSessionReplacement(deps) {
    const now = deps.now ?? Date.now;
    const sleep = deps.sleep ??
        ((delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)));
    while (deps.isCurrent?.() !== false) {
        const intent = await deps.getIntent();
        if (!intent || intent.sourceSessionId === deps.sessionId)
            return "none";
        if (intent.profileName !== deps.profileName || intent.cwd !== deps.cwd)
            return "stale";
        if (now() >= intent.expiresAtMs)
            return "expired";
        if (!deps.hasSuccessorContinuity(intent)) {
            await sleep(100);
            continue;
        }
        if (!(await deps.clearIntent(intent)))
            return "failed";
        do {
            const delivered = await deps.editSuccess(intent);
            if (delivered.ok)
                return "settled";
            if (!delivered.retryable)
                return "failed";
            await sleep(100);
        } while (deps.isCurrent?.() !== false && now() < intent.expiresAtMs);
        return "failed";
    }
    return "stale";
}
function createBaleSessionReplacementSettlementRuntime(deps) {
    let generation = 0;
    return {
        onSessionStart(ctx) {
            const currentGeneration = ++generation;
            const resolved = deps.resolve(ctx);
            if (!resolved)
                return;
            void settleBaleSessionReplacement({
                ...resolved,
                isCurrent: () => currentGeneration === generation && resolved.isCurrent?.() !== false,
            }).then(deps.onResult, deps.onError);
        },
    };
}
export function createBaleSessionActionAssembly(deps) {
    const now = deps.now ?? Date.now;
    const report = (error) => deps.recordRuntimeEvent?.("new-session", error);
    const sendTerminalResult = async (target, result) => {
        const text = result === "success"
            ? "<b>🆕 New session started.</b>"
            : result === "cancelled"
                ? "<b>🚫 New session cancelled.</b>"
                : "<b>⚠️ New session failed.</b>";
        const deadline = now() + 10_000;
        do {
            const delivery = await deps.sendResult(target, text);
            if (delivery.ok)
                return;
            if (!delivery.retryable)
                break;
            await delayBaleSessionAction(100);
        } while (now() < deadline);
        report(new Error("Bale new-session result delivery failed."));
    };
    const action = createBaleSessionActionRuntime({
        sendUserMessage: deps.sendUserMessage,
        notifyResult(target, result) {
            return sendTerminalResult(target, result);
        },
        async prepareReplacement(ctx, updateId, target) {
            const follower = !deps.ownsPersistence() &&
                typeof target.threadId === "number" &&
                deps.follower?.isRegisteredFor(target)
                ? deps.follower
                : undefined;
            // Follower memory is not authority; reread the leader-published snapshot.
            if (follower && deps.store.refresh)
                await deps.store.refresh();
            else
                await deps.store.load();
            const sessionId = ctx.sessionManager.getSessionId();
            const binding = typeof target.threadId === "number"
                ? deps.store.getWorkspaceBindingByTarget(target)
                : undefined;
            if (typeof target.threadId === "number" &&
                (!binding || binding.cwd !== ctx.cwd || binding.sessionId !== sessionId)) {
                throw new Error("Bale session replacement binding is unavailable.");
            }
            const createdAtMs = now();
            const intent = {
                continuity: binding ? "workspace-thread" : "classic-chat",
                cwd: binding?.cwd ?? ctx.cwd,
                profileName: deps.getProfileName() ?? "default",
                sourceSessionId: sessionId,
                sourceUpdateId: updateId,
                target: binding ? { ...binding.target } : { chatId: target.chatId },
                messageId: target.messageId,
                ...(binding?.slot ? { slot: binding.slot } : {}),
                ...((binding?.manualThreadName ?? binding?.threadName)
                    ? { threadName: binding.manualThreadName ?? binding.threadName }
                    : {}),
                createdAtMs,
                expiresAtMs: createdAtMs + deps.handoffTtlMs,
                ...(follower ? { sourceInstanceId: follower.instanceId } : {}),
            };
            if (!(await (follower
                ? follower.requestSessionReplacement("publish", intent)
                : deps.store.commitSessionReplacementIntent(intent, deps.ownsPersistence)))) {
                throw new Error("Bale session replacement intent was not persisted.");
            }
        },
        recordRuntimeEvent: deps.recordRuntimeEvent,
    });
    const settlement = createBaleSessionReplacementSettlementRuntime({
        resolve(ctx) {
            const sessionId = ctx.sessionManager?.getSessionId?.();
            if (!sessionId)
                return undefined;
            return {
                async getIntent() {
                    await deps.store.refresh?.();
                    return deps.store.getSessionReplacementIntent();
                },
                hasSuccessorContinuity(intent) {
                    if (intent.continuity === "classic-chat")
                        return true;
                    if (deps.store.getWorkspaceBindingByTarget(intent.target, sessionId)
                        ?.cwd !== intent.cwd)
                        return false;
                    // A follower successor claims only after its own re-registration is live.
                    return (intent.sourceInstanceId === undefined ||
                        deps.ownsPersistence() ||
                        deps.follower?.isRegisteredFor(intent.target) === true);
                },
                editSuccess(intent) {
                    return deps.sendResult(intent.target, "<b>🆕 New session started.</b>");
                },
                async clearIntent(intent) {
                    if (intent.sourceInstanceId === undefined ||
                        deps.ownsPersistence()) {
                        return deps.store.removeSessionReplacementIntent(intent, deps.ownsPersistence);
                    }
                    return ((await deps.follower?.requestSessionReplacement("settle", intent)) ?? false);
                },
                profileName: deps.getProfileName() ?? "default",
                cwd: ctx.cwd,
                sessionId,
            };
        },
        onResult(result) {
            if (result === "expired" || result === "failed") {
                report(new Error(`Bale session replacement successor settlement ${result}.`));
            }
        },
        onError: report,
    });
    return { action, settlement };
}
export function createBaleSessionActionRuntime(deps) {
    let pendingUpdateId;
    let pendingTarget;
    let pendingAction;
    const reportFailure = (error) => {
        try {
            deps.recordRuntimeEvent?.("new-session", error);
        }
        catch {
            // Diagnostics cannot make a completed durable update retryable.
        }
    };
    return {
        async handleInternalAction(args, ctx) {
            const action = pendingAction;
            const [operation, token, ...extra] = args.trim().split(/\s+/);
            if (!action || operation !== "new" ||
                token !== action.token || extra.length !== 0) {
                ctx.ui.notify(BALE_INTERNAL_MANUAL_USE_MESSAGE, "warning");
                return;
            }
            pendingAction = undefined;
            switch (action.kind) {
                case "replace-session":
                    try {
                        await deps.prepareReplacement?.(ctx, action.updateId, action.target);
                        const result = await ctx.newSession();
                        if (result.cancelled)
                            await deps.notifyResult(action.target, "cancelled");
                    }
                    catch (error) {
                        reportFailure(error);
                        await deps.notifyResult(action.target, "failure");
                    }
                    return;
            }
        },
        scheduleAfterUpdate(updateId, target) {
            if (pendingUpdateId !== undefined || pendingAction !== undefined)
                return false;
            pendingUpdateId = updateId;
            pendingTarget = { ...target };
            return true;
        },
        onUpdateCompleted(updateId) {
            if (pendingUpdateId !== updateId)
                return;
            pendingUpdateId = undefined;
            const target = pendingTarget;
            pendingTarget = undefined;
            if (!target)
                return;
            const token = randomUUID();
            pendingAction = { kind: "replace-session", token, updateId, target };
            void Promise.resolve()
                .then(() => deps.sendUserMessage(`/${BALE_CONNECT_COMMAND_NAME} ${BALE_INTERNAL_COMMAND_FLAG} new ${token}`, { expandPromptTemplates: true }))
                .catch((error) => {
                pendingAction = undefined;
                reportFailure(error);
            });
        },
        hasPending() {
            return pendingUpdateId !== undefined || pendingAction !== undefined;
        },
    };
}

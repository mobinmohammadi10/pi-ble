/**
 * Bale activity lifecycle normalization and extension dispatch
 * Zones: pi agent lifecycle, extension API, operational delivery
 * Owns stable handler registration, evidence-based activity/source identity, assistant segment and reasoning normalization, ordered public-output projection, executed-tool and compaction events, isolated non-blocking queues, shutdown fencing, diagnostics, and fresh delivery contexts; excludes Pi hook wiring, Bale rendering implementation, raw transport clients, and consumer-extension behavior
 */
import { deleteBaleView, editBaleView, sendBaleChatAction, sendBaleView, } from "./delivery.js";
const BALE_ACTIVITY_REGISTRY_KEY = "__piBaleActivityRegistry__";
function getOrCreateBaleActivityRegistry() {
    const globals = globalThis;
    const existing = globals[BALE_ACTIVITY_REGISTRY_KEY];
    if (existing &&
        typeof existing === "object" &&
        "handlers" in existing &&
        existing.handlers instanceof Map) {
        return existing;
    }
    const registry = { handlers: new Map() };
    globals[BALE_ACTIVITY_REGISTRY_KEY] = registry;
    return registry;
}
export function registerBaleActivityHandler(registration) {
    const id = registration.id.trim();
    if (!id)
        throw new Error("Bale activity handler id is required.");
    const registry = getOrCreateBaleActivityRegistry();
    if (registry.handlers.has(id)) {
        throw new Error(`Bale activity handler is already registered: ${id}`);
    }
    const handler = {
        ...registration,
        id,
        order: registration.order ?? 0,
    };
    registry.handlers.set(id, handler);
    return () => {
        if (registry.handlers.get(id) === handler)
            registry.handlers.delete(id);
    };
}
/** @internal */
export function clearBaleActivityHandlers() {
    getOrCreateBaleActivityRegistry().handlers.clear();
}
function getBaleActivityHandlers() {
    return Array.from(getOrCreateBaleActivityRegistry().handlers.values()).sort(function (left, right) {
        return left.order - right.order || left.id.localeCompare(right.id);
    });
}
function cloneActivityTarget(target) {
    return Object.freeze(target.threadId === undefined
        ? { chatId: target.chatId }
        : { chatId: target.chatId, threadId: target.threadId });
}
function createBaleActivityContext(event, isActive) {
    const defaultScope = event.target
        ? { kind: "target", target: cloneActivityTarget(event.target) }
        : event.source === "bale"
            ? { kind: "active-turn" }
            : { kind: "instance" };
    const inactive = () => Promise.resolve({
        ok: false,
        reason: "runtime-unavailable",
        message: "Bale activity context belongs to an inactive session.",
    });
    return {
        activityId: event.activityId,
        sequence: event.sequence,
        source: event.source,
        defaultScope,
        send(view, options) {
            if (!isActive())
                return inactive();
            return sendBaleView(view, {
                scope: options?.scope ?? defaultScope,
                replyToMessageId: options?.replyToMessageId,
            });
        },
        edit(handle, view) {
            return isActive() ? editBaleView(handle, view) : inactive();
        },
        delete(handle) {
            return isActive() ? deleteBaleView(handle) : inactive();
        },
        chatAction(action, options) {
            if (!isActive())
                return inactive();
            return sendBaleChatAction(action, {
                scope: options?.scope ?? defaultScope,
            });
        },
    };
}
function canCoalesceActivityEvents(previous, next) {
    if (previous.activityId !== next.activityId || previous.type !== next.type) {
        return false;
    }
    if (previous.type === "assistant-text-delta" &&
        next.type === "assistant-text-delta") {
        return previous.contentIndex === next.contentIndex;
    }
    if (previous.type === "reasoning-delta" && next.type === "reasoning-delta") {
        return previous.contentIndex === next.contentIndex;
    }
    if (previous.type === "tool-update" && next.type === "tool-update") {
        return previous.toolCallId === next.toolCallId;
    }
    return false;
}
function coalesceActivityEvents(previous, next) {
    if (previous.type === "assistant-text-delta" &&
        next.type === "assistant-text-delta") {
        return { ...next, delta: previous.delta + next.delta };
    }
    if (previous.type === "reasoning-delta" && next.type === "reasoning-delta") {
        return { ...next, delta: previous.delta + next.delta };
    }
    return next;
}
/** Optional observation must not change queue/transport settlement. */
function captureActivityDrainObserver(capture) {
    try {
        const notify = capture?.();
        return () => {
            try {
                const emitted = notify?.();
                if (emitted)
                    void Promise.resolve(emitted).catch(() => undefined);
            }
            catch { /* Observer failure is inert. */ }
        };
    }
    catch {
        return () => { };
    }
}
/** @internal */
export function createBaleActivityDispatcher(deps = {}) {
    const queues = new Map();
    let stopped = false;
    const hasPending = () => Array.from(queues.values()).some(queue => queue.active && (queue.running || queue.events.length > 0));
    const drain = async (queue) => {
        if (queue.running || !queue.active)
            return;
        queue.running = true;
        try {
            while (queue.active) {
                const event = queue.events.shift();
                if (!event)
                    break;
                if (getOrCreateBaleActivityRegistry().handlers.get(queue.registration.id) !== queue.registration) {
                    queue.active = false;
                    queue.events = [];
                    break;
                }
                try {
                    await queue.registration.handle(event, createBaleActivityContext(event, () => queue.active &&
                        !stopped &&
                        getOrCreateBaleActivityRegistry().handlers.get(queue.registration.id) === queue.registration));
                }
                catch (error) {
                    deps.recordFailure?.(queue.registration.id, event, error);
                }
            }
        }
        finally {
            queue.running = false;
            if (!stopped && !hasPending())
                queue.notifyDrained?.();
        }
    };
    return {
        hasPending,
        dispatch(event) {
            if (stopped)
                return;
            for (const registration of getBaleActivityHandlers()) {
                let queue = queues.get(registration.id);
                if (!queue || queue.registration !== registration) {
                    queue = {
                        registration,
                        events: [],
                        running: false,
                        active: true,
                    };
                    queues.set(registration.id, queue);
                }
                if (!queue.running && queue.events.length === 0)
                    queue.notifyDrained = captureActivityDrainObserver(deps.captureDrain);
                const previous = queue.events.at(-1);
                if (previous && canCoalesceActivityEvents(previous, event)) {
                    queue.events[queue.events.length - 1] = coalesceActivityEvents(previous, event);
                }
                else {
                    queue.events.push(event);
                }
                queueMicrotask(function () {
                    void drain(queue);
                });
            }
        },
        stop() {
            stopped = true;
            for (const queue of queues.values()) {
                queue.active = false;
                queue.events = [];
            }
            queues.clear();
        },
    };
}
/** @internal */
export function createBaleActivityBridgeRuntime(deps) {
    let generationSequence = 0;
    let runtime;
    const getRuntime = () => runtime;
    return {
        hasPending: () => getRuntime()?.hasPending?.(),
        onSessionStart() {
            runtime?.onSessionShutdown();
            runtime = createBaleActivityRuntime({
                generation: `${deps.generation}:${++generationSequence}`,
                dispatcher: createBaleActivityDispatcher({
                    captureDrain: deps.captureDrain,
                    recordFailure: deps.recordFailure,
                }),
                observeEvent: deps.observeEvent,
                recordObserverFailure: deps.recordFailure
                    ? (event, error) => deps.recordFailure("@llblab/pi-bale/proactive", event, error)
                    : undefined,
                now: deps.now,
            });
        },
        recordInputSource(source) {
            getRuntime()?.recordInputSource(source);
        },
        onAgentStart(target, replyToMessageId) {
            getRuntime()?.onAgentStart(target, replyToMessageId);
        },
        onAssistantEvent(event) {
            getRuntime()?.onAssistantEvent(event);
        },
        onAssistantMessageEnd(stopReason) {
            getRuntime()?.onAssistantMessageEnd(stopReason);
        },
        onToolStart(event) {
            getRuntime()?.onToolStart(event);
        },
        onToolUpdate(event) {
            getRuntime()?.onToolUpdate(event);
        },
        onToolEnd(event) {
            getRuntime()?.onToolEnd(event);
        },
        onCompactionStart(reason) {
            getRuntime()?.onCompactionStart(reason);
        },
        onCompactionEnd(reason) {
            getRuntime()?.onCompactionEnd(reason);
        },
        onCompactionAbandoned() {
            getRuntime()?.onCompactionAbandoned();
        },
        onUiPromptStart(kind, title) {
            getRuntime()?.onUiPromptStart(kind, title);
        },
        onUiPromptEnd() {
            getRuntime()?.onUiPromptEnd();
        },
        onAgentEnd() {
            getRuntime()?.onAgentEnd();
        },
        onAgentSettled() {
            getRuntime()?.onAgentSettled();
        },
        onSessionShutdown() {
            runtime?.onSessionShutdown();
            runtime = undefined;
        },
    };
}
/** @internal */
export function createBaleActivityRuntime(deps) {
    const now = deps.now ?? Date.now;
    let nextActivityNumber = 0;
    let activityId;
    let activitySource = "unknown";
    let activityTarget;
    let activityReplyToMessageId;
    let sequence = 0;
    let pendingInputSource = "unknown";
    let pendingAssistantSegment;
    let compactionInProgress = false;
    let compactionOwnedActivity = false;
    let uiPromptInProgress = false;
    const ensureActivity = (activeBaleTarget) => {
        if (activityId)
            return activityId;
        nextActivityNumber += 1;
        activityId = `${deps.generation}:${nextActivityNumber}`;
        activitySource = activeBaleTarget
            ? "bale"
            : pendingInputSource === "interactive" || pendingInputSource === "rpc"
                ? "local"
                : pendingInputSource === "extension"
                    ? "autonomous"
                    : "unknown";
        activityTarget = activeBaleTarget
            ? cloneActivityTarget(activeBaleTarget)
            : undefined;
        sequence = 0;
        pendingInputSource = "unknown";
        return activityId;
    };
    const emit = (event) => {
        const currentActivityId = ensureActivity();
        sequence += 1;
        const normalizedEvent = {
            ...event,
            activityId: currentActivityId,
            sequence,
            source: activitySource,
            ...(activityTarget ? { target: activityTarget } : {}),
            ...(activityReplyToMessageId !== undefined
                ? { replyToMessageId: activityReplyToMessageId }
                : {}),
            timestamp: now(),
        };
        try {
            deps.observeEvent?.(normalizedEvent);
        }
        catch (error) {
            deps.recordObserverFailure?.(normalizedEvent, error);
        }
        deps.dispatcher.dispatch(normalizedEvent);
    };
    const flushPendingSegment = (placement) => {
        const segment = pendingAssistantSegment;
        pendingAssistantSegment = undefined;
        if (!segment?.text.trim())
            return;
        emit({
            type: "assistant-segment",
            contentIndex: segment.contentIndex,
            text: segment.text,
            placement,
        });
    };
    const clearActivity = () => {
        activityId = undefined;
        activitySource = "unknown";
        activityTarget = undefined;
        activityReplyToMessageId = undefined;
        sequence = 0;
        pendingAssistantSegment = undefined;
        compactionInProgress = false;
        compactionOwnedActivity = false;
        uiPromptInProgress = false;
    };
    const abandonCompaction = () => {
        if (!compactionInProgress)
            return;
        const shouldClearActivity = compactionOwnedActivity;
        compactionInProgress = false;
        compactionOwnedActivity = false;
        if (shouldClearActivity)
            clearActivity();
    };
    return {
        hasPending: () => deps.dispatcher.hasPending?.(),
        recordInputSource(source) {
            pendingInputSource = source;
        },
        onAgentStart(activeBaleTarget, replyToMessageId) {
            abandonCompaction();
            ensureActivity(activeBaleTarget);
            activityReplyToMessageId =
                activitySource === "bale" ? replyToMessageId : undefined;
            emit({ type: "agent-start" });
        },
        onAssistantEvent(event) {
            if (event.type === "text_start") {
                flushPendingSegment("intermediate");
                return;
            }
            if (event.type === "text_delta") {
                if (!event.delta)
                    return;
                emit({
                    type: "assistant-text-delta",
                    contentIndex: event.contentIndex,
                    delta: event.delta,
                });
                return;
            }
            if (event.type === "text_end") {
                pendingAssistantSegment = {
                    contentIndex: event.contentIndex,
                    text: event.content,
                };
                return;
            }
            if (event.type === "thinking_delta") {
                if (!event.delta)
                    return;
                emit({
                    type: "reasoning-delta",
                    contentIndex: event.contentIndex,
                    delta: event.delta,
                });
                return;
            }
            if (event.type === "thinking_end") {
                if (!event.content.trim())
                    return;
                emit({
                    type: "reasoning-end",
                    contentIndex: event.contentIndex,
                    text: event.content,
                });
                return;
            }
            if (event.type === "toolcall_start") {
                flushPendingSegment("intermediate");
                return;
            }
            if (event.type === "done") {
                flushPendingSegment("final");
                return;
            }
            if (event.type === "error")
                flushPendingSegment("terminal-partial");
        },
        onAssistantMessageEnd(stopReason) {
            if (stopReason === "aborted")
                pendingAssistantSegment = undefined;
        },
        onToolStart(event) {
            emit({ type: "tool-start", ...event });
        },
        onToolUpdate(event) {
            emit({ type: "tool-update", ...event });
        },
        onToolEnd(event) {
            emit({ type: "tool-end", ...event });
        },
        onCompactionStart(reason) {
            abandonCompaction();
            compactionOwnedActivity = !activityId;
            compactionInProgress = true;
            ensureActivity();
            emit({ type: "compaction-start", reason });
        },
        onCompactionEnd(reason) {
            if (!compactionInProgress || !activityId)
                return;
            const shouldClearActivity = compactionOwnedActivity;
            compactionInProgress = false;
            compactionOwnedActivity = false;
            emit({ type: "compaction-end", reason });
            if (shouldClearActivity)
                clearActivity();
        },
        onCompactionAbandoned() {
            abandonCompaction();
        },
        onUiPromptStart(kind, title) {
            if (!activityId || uiPromptInProgress)
                return;
            uiPromptInProgress = true;
            emit({ type: "ui-prompt-start", kind, title });
        },
        onUiPromptEnd() {
            if (!activityId || !uiPromptInProgress)
                return;
            uiPromptInProgress = false;
            emit({ type: "ui-prompt-end" });
        },
        onAgentEnd() {
            if (activityId)
                emit({ type: "agent-end" });
        },
        onAgentSettled() {
            if (!activityId)
                return;
            flushPendingSegment("terminal-partial");
            emit({ type: "agent-settled" });
            clearActivity();
        },
        onSessionShutdown() {
            pendingInputSource = "unknown";
            clearActivity();
            deps.dispatcher.stop();
        },
    };
}
export function createBaleActivityPublicationRuntime(deps = {}) {
    let generation = 0;
    let tail = Promise.resolve();
    let outstanding = 0, unconfirmed = false;
    const pending = new Set();
    const reserve = () => {
        const admittedGeneration = generation;
        const notifyDrained = captureActivityDrainObserver(deps.captureDrain);
        let state = "pending";
        let resolve;
        const ready = new Promise((accept) => {
            resolve = accept;
        });
        const cancel = () => {
            if (state !== "pending")
                return;
            state = "cancelled";
            pending.delete(cancel);
            resolve(undefined);
        };
        pending.add(cancel);
        outstanding += 1;
        const result = tail
            .then(async () => {
            const task = await ready;
            if (admittedGeneration === generation && task)
                await task();
        })
            .finally(() => {
            outstanding -= 1;
            if (admittedGeneration === generation && outstanding === 0 && !unconfirmed)
                notifyDrained();
        });
        tail = result.catch(() => { });
        return {
            publish(task) {
                if (state === "cancelled")
                    return result;
                if (state === "published")
                    return Promise.reject(new Error("Publication reservation already published."));
                state = "published";
                pending.delete(cancel);
                resolve(task);
                return result;
            },
            cancel,
        };
    };
    return {
        reserve,
        enqueue: (task) => reserve().publish(task),
        hasPending: () => outstanding > 0,
        hasUnconfirmed: () => unconfirmed,
        beginWork() {
            const admittedGeneration = generation;
            const notifyDrained = captureActivityDrainObserver(deps.captureDrain);
            let settled = false;
            outstanding += 1;
            return {
                settle(outcome) {
                    if (settled)
                        return;
                    settled = true;
                    outstanding -= 1;
                    if (outcome === "unconfirmed" && admittedGeneration === generation)
                        unconfirmed = true;
                    if (admittedGeneration === generation && outstanding === 0 && !unconfirmed)
                        notifyDrained();
                },
            };
        },
        reset() {
            generation += 1;
            unconfirmed = false;
            for (const cancel of pending)
                cancel();
            tail = Promise.resolve();
        },
    };
}
export function createBaleAssistantOutputRuntime(deps) {
    let generation = 0;
    let running = false;
    let tail = Promise.resolve();
    const admitted = new Set();
    const admittedBaleIntermediateText = new Set();
    const isEligibleEvent = (event) => (event.source === "bale" && event.placement === "intermediate") ||
        event.source === "local" ||
        event.source === "autonomous" ||
        event.source === "unknown";
    return {
        start() {
            generation += 1;
            running = true;
            admitted.clear();
            admittedBaleIntermediateText.clear();
            tail = Promise.resolve();
        },
        beginTurn() {
            admittedBaleIntermediateText.clear();
        },
        accept(event) {
            if (!running || !isEligibleEvent(event) || !event.text.trim())
                return;
            const key = `${event.activityId}:${event.sequence}`;
            if (admitted.has(key))
                return;
            admitted.add(key);
            if (event.source === "bale" && event.placement === "intermediate") {
                admittedBaleIntermediateText.add(event.text.trim());
            }
            const admittedGeneration = generation;
            const admittedAuthority = deps.captureAuthority?.();
            const preparation = deps.prepareSend?.(event);
            const enqueue = deps.enqueue ?? ((task) => tail.then(task));
            tail = enqueue(async () => {
                const isAdmittedAuthorityActive = () => running &&
                    generation === admittedGeneration &&
                    isEligibleEvent(event) &&
                    (deps.isAuthorityActive === undefined ||
                        deps.isAuthorityActive(admittedAuthority));
                if (!isAdmittedAuthorityActive() || !deps.canDeliver(event))
                    return;
                try {
                    if (preparation)
                        await preparation.wait();
                    if (!isAdmittedAuthorityActive() || !deps.canDeliver(event))
                        return;
                    await deps.send(event, admittedAuthority, isAdmittedAuthorityActive);
                }
                catch (error) {
                    deps.recordFailure?.(event, error);
                }
            }).finally(() => preparation?.settle());
        },
        hasAdmittedBaleIntermediate(text) {
            return admittedBaleIntermediateText.has(text.trim());
        },
        waitForIdle() {
            return tail;
        },
        stop() {
            generation += 1;
            running = false;
            admitted.clear();
            admittedBaleIntermediateText.clear();
        },
    };
}

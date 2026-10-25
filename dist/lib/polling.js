/**
 * Bale polling runtime domain helpers
 * Zones: bale transport, polling runtime
 * Owns polling request builders, stop conditions, and the long-poll loop runtime for Bale updates
 */
const BALE_INITIAL_SYNC_OFFSET = -1;
const BALE_INITIAL_SYNC_LIMIT = 1;
const BALE_INITIAL_SYNC_TIMEOUT_SECONDS = 0;
const BALE_LONG_POLL_LIMIT = 10;
const BALE_LONG_POLL_TIMEOUT_SECONDS = 30;
const BALE_THREAD_CAPABILITY_MONITOR_INTERVAL_MS = 2_500;
const BALE_THREAD_CAPABILITY_DISABLED_CONFIRMATION_PROBES = 2;
export const BALE_GET_UPDATES_CONFLICT_STOP_LIMIT = 10;
const BALE_GET_UPDATES_CONFLICT_FAST_RETRY_LIMIT = 3;
const BALE_GET_UPDATES_CONFLICT_FAST_RETRY_MS = 1_000;
const BALE_GET_UPDATES_CONFLICT_SLOW_RETRY_MS = 3_000;
const BALE_POLLING_RETRY_BASE_MS = 1_000;
const BALE_POLLING_RETRY_MAX_MS = 30_000;
const BALE_GET_UPDATES_GRACE_MS = 10_000;
// Standard Bale DM polling does not expose ordinary message-deletion events.
// Business deletions belong to a separate namespace and default routing ignores them.
export const BALE_ALLOWED_UPDATES = [
    "message",
    "edited_message",
    "callback_query",
    "message_reaction",
    "guest_message",
];
export function buildBaleInitialSyncRequest() {
    return {
        offset: BALE_INITIAL_SYNC_OFFSET,
        limit: BALE_INITIAL_SYNC_LIMIT,
        timeout: BALE_INITIAL_SYNC_TIMEOUT_SECONDS,
    };
}
export function buildBaleLongPollRequest(lastUpdateId) {
    return {
        offset: lastUpdateId !== undefined ? lastUpdateId + 1 : undefined,
        limit: BALE_LONG_POLL_LIMIT,
        timeout: BALE_LONG_POLL_TIMEOUT_SECONDS,
        allowed_updates: BALE_ALLOWED_UPDATES,
    };
}
export function getLatestBaleUpdateId(updates) {
    return updates.at(-1)?.update_id;
}
export class BalePersistentGetUpdatesConflictError extends Error {
    count;
    constructor(count) {
        super(`Bale polling stopped after ${count} consecutive getUpdates conflicts.`);
        this.name = "BalePersistentGetUpdatesConflictError";
        this.count = count;
    }
}
/** Exponential backoff for non-conflict polling/admission failures. */
export function getBalePollingRetryDelayMs(consecutiveFailures) {
    const exponent = Math.max(0, Math.min(consecutiveFailures - 1, 16));
    return Math.min(BALE_POLLING_RETRY_BASE_MS * 2 ** exponent, BALE_POLLING_RETRY_MAX_MS);
}
export class BaleGetUpdatesTimeoutError extends Error {
    timeoutMs;
    constructor(timeoutMs) {
        super(`Bale getUpdates timed out after ${timeoutMs} ms.`);
        this.name = "BaleGetUpdatesTimeoutError";
        this.timeoutMs = timeoutMs;
    }
}
export function getBaleGetUpdatesRequestBudgetMs(body, graceMs = BALE_GET_UPDATES_GRACE_MS) {
    const timeoutSeconds = typeof body.timeout === "number" &&
        Number.isFinite(body.timeout) &&
        body.timeout >= 0
        ? body.timeout
        : 0;
    const normalizedGraceMs = Number.isFinite(graceMs) && graceMs > 0
        ? Math.floor(graceMs)
        : BALE_GET_UPDATES_GRACE_MS;
    return Math.floor(timeoutSeconds * 1_000) + normalizedGraceMs;
}
export function shouldStopBalePolling(signalAborted, error) {
    return (signalAborted ||
        (error instanceof DOMException && error.name === "AbortError"));
}
export function createBalePollingControllerState() {
    return {
        phase: "stopped",
        stopReason: "not-started",
    };
}
function getBalePollingStateSnapshot(state) {
    return {
        phase: state.phase,
        phaseStartedAtMs: state.phaseStartedAtMs,
        currentUpdateId: state.currentUpdateId,
        startedAtMs: state.startedAtMs,
        stoppedAtMs: state.stoppedAtMs,
        lastSuccessfulResponseAtMs: state.lastSuccessfulResponseAtMs,
        lastSuccessfulResponseUpdateCount: state.lastSuccessfulResponseUpdateCount,
        stopReason: state.stopReason,
    };
}
export function createBalePollingStateReader(state) {
    return () => getBalePollingStateSnapshot(state);
}
export function isBalePollingControllerActive(state) {
    return !!state.pollingPromise;
}
export function createBalePollingActivityReader(state) {
    return () => isBalePollingControllerActive(state);
}
export function createBalePollingAdmissionRuntime(deps) {
    let generation = 0;
    return {
        isActive: deps.polling.isActive,
        async start(ctx) {
            if (!(deps.canStart?.(ctx) ?? true))
                return;
            const expectedGeneration = ++generation;
            const isCurrent = () => expectedGeneration === generation && (deps.canStart?.(ctx) ?? true);
            if (!isCurrent())
                return;
            await deps.prepareStart?.();
            if (!isCurrent())
                return;
            deps.validateStart?.();
            await deps.worker.onSessionStart(ctx);
            if (!isCurrent())
                return;
            deps.polling.start(ctx);
        },
        async stop() {
            generation += 1;
            await deps.polling.stop();
        },
    };
}
/** Own journal-first polling assembly and cursor bootstrap validation. */
export function createBaleDurablePollingRuntimeAssembly(deps) {
    const controller = createBalePollingControllerRuntime({
        ...deps,
        appendUpdateBatch(updates, cursor) {
            const result = deps.journal.appendBatch(updates, cursor);
            if (!deps.prepareUpdateBatch)
                return result;
            // No await: an already-draining worker must not observe the new batch before preparation.
            try {
                const included = new Set(result.nonExcludedUpdateIds);
                let batch = [];
                for (const update of updates) {
                    if (included.has(update.update_id))
                        batch.push(update);
                    else if (batch.length > 0) {
                        deps.prepareUpdateBatch(batch);
                        batch = [];
                    }
                }
                if (batch.length > 0)
                    deps.prepareUpdateBatch(batch);
            }
            catch (error) {
                try {
                    deps.recordRuntimeEvent?.("polling", error, {
                        phase: "batch-preparation",
                        updateCount: updates.length,
                    });
                }
                catch {
                    // Already-published input must still reach the worker if diagnostics fail.
                }
            }
            return result;
        },
        getAcceptedThroughUpdateId: deps.journal.getAcceptedThroughUpdateId,
        getJournalEntryCount: deps.journal.getEntryCount,
        signalUpdateWorker: deps.journal.signalWorker,
    });
    const admission = createBalePollingAdmissionRuntime({
        polling: controller,
        prepareStart: deps.journal.prepareCursorCutover,
        canStart: deps.canStart,
        validateStart() {
            if (deps.journal.getAcceptedThroughUpdateId() !== undefined)
                return;
            if (deps.journal.getBootstrapEntryCount() === 0)
                return;
            throw new BalePollingCursorBootstrapError("Bale polling cursor is missing while the durable update journal is non-empty.");
        },
        worker: deps.journal,
    });
    return { controller, admission };
}
function notifyBalePollingStateChange(deps) {
    try {
        deps.onPollingStateChange?.();
    }
    catch (error) {
        deps.recordRuntimeEvent?.("polling", error, {
            phase: "state-observer",
        });
    }
}
function transitionBalePollingState(state, phase, nowMs, currentUpdateId) {
    state.phase = phase;
    state.phaseStartedAtMs = nowMs;
    state.currentUpdateId = currentUpdateId;
}
export function createBalePollingControllerRuntime(deps) {
    const state = deps.state ?? createBalePollingControllerState();
    const getNowMs = deps.getNowMs ?? Date.now;
    const notifyStateChange = () => notifyBalePollingStateChange({
        onPollingStateChange: deps.onPollingStateChange,
        recordRuntimeEvent: deps.recordRuntimeEvent,
    });
    return createBalePollingController({
        state,
        hasBotToken: deps.hasBotToken,
        stopTypingLoop: deps.stopTypingLoop,
        runPollLoop: createBalePollLoopRunner({
            getConfig: deps.getConfig,
            deleteWebhook: deps.deleteWebhook,
            getUpdates: deps.getUpdates,
            getUpdatesRequestBudgetMs: deps.getUpdatesRequestBudgetMs,
            persistConfig: deps.persistConfig,
            appendUpdateBatch: deps.appendUpdateBatch,
            getAcceptedThroughUpdateId: deps.getAcceptedThroughUpdateId,
            getJournalEntryCount: deps.getJournalEntryCount,
            signalUpdateWorker: deps.signalUpdateWorker,
            updateStatus: deps.updateStatus,
            sleep: deps.sleep,
            onPhaseChange(phase, currentUpdateId) {
                transitionBalePollingState(state, phase, getNowMs(), currentUpdateId);
                notifyStateChange();
            },
            onSuccessfulResponse(updateCount) {
                state.lastSuccessfulResponseAtMs = getNowMs();
                state.lastSuccessfulResponseUpdateCount = updateCount;
                notifyStateChange();
            },
            recordRuntimeEvent: deps.recordRuntimeEvent,
        }),
        updateStatus: deps.updateStatus,
        createAbortController: deps.createAbortController,
        getNowMs,
        onPollingStateChange: deps.onPollingStateChange,
        onPersistentConflict: deps.onPersistentConflict,
        recordRuntimeEvent: deps.recordRuntimeEvent,
    });
}
export function createBalePollingController(deps) {
    const state = deps.state ?? createBalePollingControllerState();
    const getNowMs = deps.getNowMs ?? Date.now;
    const notifyStateChange = () => notifyBalePollingStateChange({
        onPollingStateChange: deps.onPollingStateChange,
        recordRuntimeEvent: deps.recordRuntimeEvent,
    });
    const runtimeDeps = {
        ...deps,
        getPollingPromise: () => state.pollingPromise,
        setPollingPromise: (promise) => {
            state.pollingPromise = promise;
        },
        getPollingController: () => state.pollingController,
        setPollingController: (controller) => {
            state.pollingController = controller;
        },
        onPollingStarted: () => {
            const nowMs = getNowMs();
            transitionBalePollingState(state, "starting", nowMs);
            state.startedAtMs = nowMs;
            state.stoppedAtMs = undefined;
            state.lastSuccessfulResponseAtMs = undefined;
            state.lastSuccessfulResponseUpdateCount = undefined;
            state.stopReason = undefined;
            notifyStateChange();
            deps.onPollingStarted?.();
        },
        onPollingStopped: (reason) => {
            const nowMs = getNowMs();
            transitionBalePollingState(state, "stopped", nowMs);
            state.stoppedAtMs = nowMs;
            state.stopReason = reason;
            notifyStateChange();
            deps.onPollingStopped?.(reason);
        },
    };
    return {
        isActive: () => isBalePollingControllerActive(state),
        start: (ctx) => startBalePollingRuntime(ctx, runtimeDeps),
        stop: () => stopBalePollingRuntime(runtimeDeps),
    };
}
export function shouldStartBalePolling(state) {
    return state.hasBotToken && !state.hasPollingPromise;
}
export async function stopBalePollingRuntime(deps) {
    const pollingPromise = deps.getPollingPromise();
    const pollingController = deps.getPollingController();
    try {
        deps.stopTypingLoop();
    }
    catch (error) {
        deps.recordRuntimeEvent?.("polling", error, { phase: "typing-stop" });
    }
    pollingController?.abort();
    await pollingPromise?.catch(() => undefined);
    let cleared = false;
    if (deps.getPollingPromise() === pollingPromise) {
        deps.setPollingPromise(undefined);
        cleared = pollingPromise !== undefined;
    }
    if (deps.getPollingController() === pollingController) {
        deps.setPollingController(undefined);
        cleared = cleared || pollingController !== undefined;
    }
    if (cleared)
        deps.onPollingStopped?.("requested");
}
function updateBalePollingStatusSafely(updateStatus, ctx, options = {}) {
    try {
        updateStatus(ctx, options.message);
    }
    catch (error) {
        // The polling loop can outlive the session context it captured.
        options.recordRuntimeEvent?.("polling", error, { phase: "status-update" });
    }
}
export function startBalePollingRuntime(ctx, deps) {
    if (!shouldStartBalePolling({
        hasBotToken: deps.hasBotToken(),
        hasPollingPromise: !!deps.getPollingPromise(),
    })) {
        return;
    }
    const controller = deps.createAbortController?.() ?? new AbortController();
    deps.setPollingController(controller);
    deps.onPollingStarted?.();
    let failed = false;
    let persistentConflict;
    let runPromise;
    try {
        runPromise = deps.runPollLoop(ctx, controller.signal);
    }
    catch (error) {
        runPromise = Promise.reject(error);
    }
    let promise;
    promise = runPromise
        .catch((error) => {
        if (shouldStopBalePolling(controller.signal.aborted, error))
            return;
        if (error instanceof BalePersistentGetUpdatesConflictError) {
            persistentConflict = error;
            return;
        }
        failed = true;
        deps.recordRuntimeEvent?.("polling", error, {
            phase: "controller",
        });
    })
        .finally(async () => {
        const ownsPromise = deps.getPollingPromise() === promise;
        const ownsController = deps.getPollingController() === controller;
        if (ownsPromise)
            deps.setPollingPromise(undefined);
        if (ownsController)
            deps.setPollingController(undefined);
        if (!ownsPromise && !ownsController)
            return;
        deps.onPollingStopped?.(controller.signal.aborted
            ? "requested"
            : persistentConflict
                ? "persistent-conflict"
                : failed
                    ? "failed"
                    : "completed");
        // Detach the inner promise before outer teardown calls polling.stop().
        if (persistentConflict && !controller.signal.aborted) {
            try {
                if (deps.onPersistentConflict) {
                    await deps.onPersistentConflict(ctx, persistentConflict.count);
                }
                else {
                    deps.stopTypingLoop();
                    deps.recordRuntimeEvent?.("polling", persistentConflict, {
                        phase: "persistent-conflict",
                        count: persistentConflict.count,
                    });
                }
            }
            catch (error) {
                deps.recordRuntimeEvent?.("polling", error, {
                    phase: "conflict-stand-down",
                });
            }
            if (deps.getPollingController() || deps.getPollingPromise())
                return;
        }
        updateBalePollingStatusSafely(deps.updateStatus, ctx, {
            recordRuntimeEvent: deps.recordRuntimeEvent,
        });
    });
    deps.setPollingPromise(promise);
    updateBalePollingStatusSafely(deps.updateStatus, ctx, {
        recordRuntimeEvent: deps.recordRuntimeEvent,
    });
}
export function createBaleThreadTargetObservationBinding() {
    let handler;
    return {
        async handle(ctx) {
            await handler?.(ctx);
        },
        set(nextHandler) {
            handler = nextHandler;
        },
    };
}
export function createBaleThreadCapabilityStateRuntime() {
    let busPollingStarted = false;
    let topicModeUnavailable = false;
    let forceFreshLeaderThread = false;
    let requestedThreadName;
    return {
        isBusPollingStarted: () => busPollingStarted,
        setBusPollingStarted(started) {
            busPollingStarted = started;
        },
        isTopicModeUnavailable: () => topicModeUnavailable,
        setTopicModeUnavailable(unavailable) {
            topicModeUnavailable = unavailable;
        },
        isBusRuntimeEnabled: () => !topicModeUnavailable,
        shouldForceFreshLeaderThread: () => forceFreshLeaderThread,
        setForceFreshLeaderThread(forceFresh) {
            forceFreshLeaderThread = forceFresh;
        },
        getRequestedThreadName: () => requestedThreadName,
        setRequestedThreadName(threadName) {
            requestedThreadName = threadName;
        },
    };
}
export function createBaleThreadCapabilityOrchestration(deps) {
    let generation = 0;
    const lifecycle = {
        capture() {
            const expected = generation;
            return () => expected === generation;
        },
        invalidate() {
            generation++;
        },
    };
    const capabilityDeps = {
        lifecycle,
        getAllowedUserId: deps.getAllowedUserId,
        callApi: deps.callApi,
        topicTargetStore: deps.topicTargetStore,
        ownsLock: deps.ownsLock,
        isFollowerRegistered: deps.isFollowerRegistered,
        getPollingStartedWithBaleBus: deps.state.isBusPollingStarted,
        setPollingStartedWithBaleBus: deps.state.setBusPollingStarted,
        setTopicModeUnavailable: deps.state.setTopicModeUnavailable,
        suspendLiveThreadTarget: deps.suspendLiveThreadTarget,
        stopFollowerRegistration: deps.stopFollowerRegistration,
        startClassicPolling: deps.startClassicPolling,
        stopClassicPolling: deps.stopClassicPolling,
        startBusPolling: deps.startBusLeaderPolling,
        stopBusPolling: deps.stopBusLeaderPolling,
        startLeaderHealth: deps.startLeaderHealth,
        stopLeaderHealth: deps.stopLeaderHealth,
        isTopicModeUnavailableError: deps.isTopicModeUnavailableError,
        updateStatus: deps.updateStatus,
        recordEvent: deps.recordEvent,
        failureLog: deps.failureLog,
    };
    return {
        monitor: createBaleThreadCapabilityMonitor(capabilityDeps),
        observeTarget: createBaleThreadTargetObservationHandler(capabilityDeps),
        pollingPorts: createBaleThreadAwarePollingPorts({
            lifecycle,
            getAllowedUserId: deps.getAllowedUserId,
            callApi: deps.callApi,
            topicTargetStore: deps.topicTargetStore,
            isBusRuntimeEnabled: deps.isBusRuntimeEnabled,
            isTopicModeUnavailableError: deps.isTopicModeUnavailableError,
            getPollingStartedWithBaleBus: deps.state.isBusPollingStarted,
            setPollingStartedWithBaleBus: deps.state.setBusPollingStarted,
            setForceFreshLeaderThreadOnNextStart: deps.state.setForceFreshLeaderThread,
            startClassicPolling: deps.startClassicPolling,
            stopClassicPolling: deps.stopClassicPolling,
            startBusLeaderPolling: deps.startBusLeaderPolling,
            stopBusLeaderPolling: deps.stopBusLeaderPolling,
            startLeaderHealth: deps.startLeaderHealth,
            stopLeaderHealth: deps.stopLeaderHealth,
            registerFollowerWithLeader: deps.registerFollowerWithLeader,
            restoreFollowerWithLeader: deps.restoreFollowerWithLeader,
            hasRememberedWorkspaceBinding: deps.hasRememberedWorkspaceBinding,
            stopFollowerRegistration: deps.stopFollowerRegistration,
            recordEvent: deps.recordEvent,
            setTopicModeUnavailable: deps.state.setTopicModeUnavailable,
        }),
    };
}
async function readBaleThreadCapability(deps) {
    await deps.callApi("getMe", {});
    return false; // Bale's documented API has no private-chat topic lifecycle.
}
async function probeBaleStartupThreadCapability(deps, isCurrent = () => true) {
    if (!isCurrent())
        return;
    const threadModeEnabled = await readBaleThreadCapability(deps);
    if (!isCurrent())
        return;
    const nowMs = (deps.getNowMs ?? Date.now)();
    if (threadModeEnabled === false) {
        deps.topicTargetStore.setBotState({
            threadMode: "disabled",
            updatedAtMs: nowMs,
            lastReconcileAction: "startup-bot-topics-disabled",
        });
        await deps.topicTargetStore.persist();
        if (!isCurrent())
            return;
        deps.recordEvent("bus", "Bale Threaded Mode unavailable on startup", {
            phase: "startup-bot-topics-disabled",
        });
        deps.setTopicModeUnavailable(true);
        return threadModeEnabled;
    }
    if (threadModeEnabled === true) {
        deps.topicTargetStore.setBotState({
            ...deps.topicTargetStore.getBotState(),
            threadMode: "enabled",
            updatedAtMs: nowMs,
            lastReconcileAction: "startup-bot-topics-enabled",
        });
        await deps.topicTargetStore.persist();
        if (!isCurrent())
            return;
        deps.setTopicModeUnavailable(false);
    }
    return threadModeEnabled;
}
function hasBaleClassicRestoreFailure(state) {
    return (state.lastReconcileAction?.endsWith("-classic-restore-failed") ?? false);
}
function hasBaleThreadCapabilityBindings(store) {
    return (store.list?.().some((record) => {
        return (typeof record.target?.chatId === "number" &&
            typeof record.target.threadId === "number" &&
            record.status !== "deleted" &&
            record.status !== "offline" &&
            record.status !== "stale");
    }) ?? false);
}
/** Falls back to classic polling, recording a failed restore durably; false once the attempt is stale. */
async function restoreBaleClassicPolling(ctx, phase, deps, isCurrent) {
    try {
        await deps.startClassicPolling(ctx);
        return isCurrent();
    }
    catch (classicError) {
        if (!isCurrent())
            return false;
        deps.topicTargetStore.setBotState({
            threadMode: "disabled",
            updatedAtMs: (deps.getNowMs ?? Date.now)(),
            lastReconcileAction: `${phase}-classic-restore-failed`,
        });
        await deps.topicTargetStore.persist();
        if (!isCurrent())
            return false;
        deps.recordEvent("bus", classicError, {
            phase: `${phase}-classic-restore`,
        });
        return true;
    }
}
export async function applyBaleThreadCapability(ctx, threadModeEnabled, phase, deps, isCurrent = deps.lifecycle?.capture() ?? (() => true)) {
    if (!isCurrent())
        return;
    await deps.topicTargetStore.load();
    if (!isCurrent())
        return;
    const nowMs = (deps.getNowMs ?? Date.now)();
    const previousBotState = deps.topicTargetStore.getBotState();
    if (!threadModeEnabled) {
        if (hasBaleThreadCapabilityBindings(deps.topicTargetStore) &&
            !phase.endsWith("-confirmed")) {
            deps.recordEvent("bus", "Bale Threaded Mode probe deferred", {
                phase,
                reason: "active-thread-bindings-present",
            });
            return;
        }
        deps.topicTargetStore.setBotState({
            threadMode: "disabled",
            updatedAtMs: nowMs,
            lastReconcileAction: phase,
        });
        await deps.topicTargetStore.persist();
        if (!isCurrent())
            return;
        deps.setTopicModeUnavailable(true);
        deps.stopFollowerRegistration();
        const hadLiveThreadTransport = deps.getPollingStartedWithBaleBus();
        if (hadLiveThreadTransport ||
            hasBaleClassicRestoreFailure(previousBotState)) {
            deps.stopLeaderHealth();
            await deps.stopBusPolling();
            if (!isCurrent())
                return;
            deps.setPollingStartedWithBaleBus(false);
            if (hadLiveThreadTransport)
                deps.suspendLiveThreadTarget?.();
            if (!(await restoreBaleClassicPolling(ctx, phase, deps, isCurrent)))
                return;
        }
        deps.updateStatus(ctx);
        return;
    }
    deps.topicTargetStore.setBotState({
        ...deps.topicTargetStore.getBotState(),
        threadMode: "enabled",
        updatedAtMs: nowMs,
        lastReconcileAction: phase,
    });
    await deps.topicTargetStore.persist();
    if (!isCurrent())
        return;
    deps.setTopicModeUnavailable(false);
    if (!deps.getPollingStartedWithBaleBus() && deps.ownsLock(ctx)) {
        await deps.stopClassicPolling();
        if (!isCurrent())
            return;
        deps.setPollingStartedWithBaleBus(true);
        try {
            await deps.startBusPolling(ctx);
            if (!isCurrent())
                return;
            deps.startLeaderHealth();
        }
        catch (error) {
            if (!isCurrent())
                return;
            deps.setPollingStartedWithBaleBus(false);
            const threadModeUnavailable = deps.isTopicModeUnavailableError?.(error) === true;
            if (threadModeUnavailable) {
                deps.topicTargetStore.setBotState({
                    threadMode: "disabled",
                    updatedAtMs: nowMs,
                    lastReconcileAction: `${phase}-unavailable`,
                });
                await deps.topicTargetStore.persist();
                if (!isCurrent())
                    return;
                deps.setTopicModeUnavailable(true);
            }
            if (!(await restoreBaleClassicPolling(ctx, phase, deps, isCurrent)))
                return;
            deps.updateStatus(ctx);
            if (threadModeUnavailable)
                return;
            throw error;
        }
    }
    deps.updateStatus(ctx);
}
export function createBaleThreadAwarePollingPorts(deps) {
    let generation = 0;
    const startPolling = async (ctx, options) => {
        const expectedGeneration = ++generation;
        deps.lifecycle?.invalidate();
        const isLifecycleCurrent = deps.lifecycle?.capture() ?? (() => true);
        const isCurrent = () => expectedGeneration === generation && isLifecycleCurrent();
        await deps.topicTargetStore.load();
        if (!isCurrent())
            return;
        let startupThreadCapability;
        try {
            startupThreadCapability = await probeBaleStartupThreadCapability(deps, isCurrent);
        }
        catch (error) {
            if (!isCurrent())
                return;
            deps.recordEvent("bus", error, { phase: "startup-thread-mode-probe" });
        }
        if (!isCurrent())
            return;
        deps.setTopicModeUnavailable(startupThreadCapability !== true);
        if (deps.isBusRuntimeEnabled()) {
            deps.setTopicModeUnavailable(false);
            try {
                deps.setPollingStartedWithBaleBus(true);
                deps.setForceFreshLeaderThreadOnNextStart(!!options?.forceFreshLeaderThread);
                await deps.startBusLeaderPolling(ctx);
                if (!isCurrent())
                    return;
                deps.startLeaderHealth();
                return;
            }
            catch (error) {
                if (!isCurrent())
                    return;
                deps.setPollingStartedWithBaleBus(false);
                if (!deps.isTopicModeUnavailableError(error))
                    throw error;
                deps.setTopicModeUnavailable(true);
                await deps.topicTargetStore.load();
                if (!isCurrent())
                    return;
                deps.topicTargetStore.setBotState({
                    threadMode: "disabled",
                    updatedAtMs: Date.now(),
                    lastReconcileAction: "thread-mode-unavailable",
                });
                await deps.topicTargetStore.persist();
                if (!isCurrent())
                    return;
                deps.recordEvent("bus", error, { phase: "thread-mode-unavailable" });
            }
            finally {
                if (isCurrent())
                    deps.setForceFreshLeaderThreadOnNextStart(false);
            }
        }
        deps.setPollingStartedWithBaleBus(false);
        await deps.startClassicPolling(ctx);
    };
    const stopPolling = async () => {
        const expectedGeneration = ++generation;
        deps.lifecycle?.invalidate();
        deps.setForceFreshLeaderThreadOnNextStart(false);
        deps.stopLeaderHealth();
        if (deps.getPollingStartedWithBaleBus()) {
            await deps.stopBusLeaderPolling();
            if (expectedGeneration === generation)
                deps.setPollingStartedWithBaleBus(false);
            return;
        }
        await deps.stopClassicPolling();
    };
    const refreshFollowerState = async () => {
        if (deps.topicTargetStore.refresh) {
            await deps.topicTargetStore.refresh();
        }
        else {
            await deps.topicTargetStore.load();
        }
        return deps.topicTargetStore.getBotState().threadMode === "enabled";
    };
    const registerFollowerWithOwner = async (ctx, owner, options) => {
        if (!(await refreshFollowerState()))
            return undefined;
        return deps.registerFollowerWithLeader(ctx, owner, options);
    };
    const restoreFollowerWithOwner = async (ctx, owner) => {
        if (!(await refreshFollowerState())) {
            deps.recordEvent("bus", "Bale follower auto-connect skipped: Threaded Mode is not enabled.", {
                phase: "follower-auto-connect-skip",
                reason: "thread-mode-unavailable",
            });
            return undefined;
        }
        if (!deps.hasRememberedWorkspaceBinding?.(ctx)) {
            deps.recordEvent("bus", "Bale follower auto-connect skipped: no binding for this session.", {
                phase: "follower-auto-connect-skip",
                reason: "session-binding-unavailable",
            });
            return undefined;
        }
        return deps.restoreFollowerWithLeader?.(ctx, owner);
    };
    return {
        startPolling,
        stopPolling,
        registerFollowerWithOwner,
        restoreFollowerWithOwner,
        stopFollowerRegistration: deps.stopFollowerRegistration,
    };
}
function createBaleThreadTargetObservationHandler(deps) {
    let transitionPending = false;
    return async (ctx) => {
        if (transitionPending)
            return;
        if (deps.topicTargetStore.getBotState().threadMode === "enabled")
            return;
        transitionPending = true;
        const isCurrent = deps.lifecycle?.capture() ?? (() => true);
        try {
            await applyBaleThreadCapability(ctx, true, "thread-target-observed", deps, isCurrent);
        }
        catch (error) {
            if (!isCurrent())
                return;
            deps.recordEvent("bus", error, { phase: "thread-target-observed" });
        }
        finally {
            transitionPending = false;
        }
    };
}
export function canProbeBaleThreadCapability(ctx, deps) {
    return deps.ownsLock(ctx) || deps.isFollowerRegistered?.() === true;
}
export function createBaleThreadCapabilityMonitor(deps) {
    const intervalMs = deps.intervalMs ?? BALE_THREAD_CAPABILITY_MONITOR_INTERVAL_MS;
    let interval;
    let generation = 0;
    let transitionPromise;
    let consecutiveDisabledProbes = 0;
    // An absent leader endpoint repeats one identical probe failure every interval; the port collapses the run.
    // Running it through one guard keeps a faulty diagnostics port from breaking probes or the interval callback.
    const capabilityFailureLog = {
        record(error, details) {
            try {
                deps.failureLog.record(error, details);
            }
            catch {
                // Monitor diagnostics cannot create an uncaught interval exception.
            }
        },
        settled() {
            try {
                deps.failureLog.settled();
            }
            catch {
                // Monitor diagnostics cannot fail a completed probe.
            }
        },
        reset() {
            try {
                deps.failureLog.reset();
            }
            catch {
                // Monitor diagnostics cannot fail a monitor stop.
            }
        },
    };
    const stop = () => {
        generation += 1;
        capabilityFailureLog.reset();
        if (interval)
            clearInterval(interval);
        interval = undefined;
        deps.lifecycle?.invalidate();
    };
    const check = (ctx) => {
        if (transitionPromise || !canProbeBaleThreadCapability(ctx, deps)) {
            return;
        }
        const expectedGeneration = generation;
        const isLifecycleCurrent = deps.lifecycle?.capture() ?? (() => true);
        const isCurrent = () => generation === expectedGeneration && isLifecycleCurrent();
        let tracked;
        tracked = readBaleThreadCapability(deps)
            .then(async (threadModeEnabled) => {
            if (!isCurrent())
                return;
            capabilityFailureLog.settled();
            if (threadModeEnabled === undefined) {
                if (deps.topicTargetStore.getBotState().threadMode !== "enabled" &&
                    !deps.getPollingStartedWithBaleBus() &&
                    deps.ownsLock(ctx)) {
                    await applyBaleThreadCapability(ctx, true, "capability-monitor-retry", deps, isCurrent);
                }
                return;
            }
            if (threadModeEnabled)
                consecutiveDisabledProbes = 0;
            const botState = deps.topicTargetStore.getBotState();
            const current = botState.threadMode;
            // Persisted capability is not proof that this owner started its local bus.
            if (threadModeEnabled && current === "enabled" &&
                (deps.getPollingStartedWithBaleBus() || !deps.ownsLock(ctx)))
                return;
            if (!threadModeEnabled && current === "disabled") {
                if (!deps.ownsLock(ctx) ||
                    !hasBaleClassicRestoreFailure(botState)) {
                    return;
                }
                await applyBaleThreadCapability(ctx, false, "capability-monitor-disabled-confirmed", deps, isCurrent);
                return;
            }
            if (!threadModeEnabled &&
                hasBaleThreadCapabilityBindings(deps.topicTargetStore)) {
                consecutiveDisabledProbes += 1;
                if (consecutiveDisabledProbes <
                    BALE_THREAD_CAPABILITY_DISABLED_CONFIRMATION_PROBES) {
                    deps.recordEvent("bus", "Bale Threaded Mode probe deferred", {
                        phase: "capability-monitor-disabled",
                        reason: "active-thread-bindings-present",
                        consecutiveDisabledProbes,
                    });
                    return;
                }
            }
            await applyBaleThreadCapability(ctx, threadModeEnabled, threadModeEnabled
                ? "capability-monitor-enabled"
                : consecutiveDisabledProbes >=
                    BALE_THREAD_CAPABILITY_DISABLED_CONFIRMATION_PROBES
                    ? "capability-monitor-disabled-confirmed"
                    : "capability-monitor-disabled", deps, isCurrent);
        })
            .catch((error) => {
            if (!isCurrent())
                return;
            capabilityFailureLog.record(error);
        })
            .finally(() => {
            if (transitionPromise === tracked)
                transitionPromise = undefined;
        });
        transitionPromise = tracked;
    };
    return {
        start(ctx) {
            stop();
            // Disabled-mode confirmation counts consecutive probes of one run, never observations from before a restart.
            consecutiveDisabledProbes = 0;
            const expectedGeneration = generation;
            interval = setInterval(() => {
                if (generation !== expectedGeneration)
                    return;
                try {
                    check(ctx);
                }
                catch (error) {
                    try {
                        stop();
                    }
                    catch {
                        /* Timer shutdown must not escape the callback. */
                    }
                    capabilityFailureLog.record(error);
                }
            }, intervalMs);
            interval.unref?.();
        },
        stop,
    };
}
export class BalePollingBatchValidationError extends Error {
    constructor(message) {
        super(message);
        this.name = "BalePollingBatchValidationError";
    }
}
export class BalePollingCursorBootstrapError extends Error {
    constructor(message) {
        super(message);
        this.name = "BalePollingCursorBootstrapError";
    }
}
/** Transfer one legacy config cursor into journal authority before deleting it. */
export async function cutOverBalePollingCursor(deps) {
    const legacyCursor = deps.getLegacyCursor();
    if (legacyCursor === undefined)
        return;
    const snapshot = deps.readJournal();
    if (snapshot.acceptedThroughUpdateId === undefined) {
        const provenEntryCursor = snapshot.entries.at(-1)?.updateId;
        await deps.publishJournalCursor(Math.max(legacyCursor, provenEntryCursor ?? legacyCursor));
    }
    await deps.removeLegacyCursor();
}
function validateBalePollingBatch(updates, lastUpdateId) {
    let previousUpdateId = lastUpdateId;
    for (const update of updates) {
        if (!Number.isSafeInteger(update.update_id) ||
            update.update_id < 0 ||
            (previousUpdateId !== undefined && update.update_id <= previousUpdateId)) {
            throw new BalePollingBatchValidationError(`Bale getUpdates returned non-monotonic update id ${String(update.update_id)} after ${String(previousUpdateId)}`);
        }
        previousUpdateId = update.update_id;
    }
}
export async function admitBalePollingUpdateBatch(deps) {
    if (deps.updates.length === 0)
        return { updateCount: 0 };
    const acceptedThroughUpdateId = deps.getAcceptedThroughUpdateId?.();
    validateBalePollingBatch(deps.updates, acceptedThroughUpdateId);
    const latestUpdateId = getLatestBaleUpdateId(deps.updates);
    if (latestUpdateId === undefined)
        return { updateCount: 0 };
    reportBalePollingPhase(deps, "persisting-journal", deps.updates[0]?.update_id);
    await deps.appendBatch(deps.updates, latestUpdateId);
    try {
        deps.signalWorker();
    }
    catch (error) {
        deps.recordRuntimeEvent?.("polling", error, {
            phase: "worker-signal",
            updateCount: deps.updates.length,
            latestUpdateId,
        });
    }
    return { updateCount: deps.updates.length, latestUpdateId };
}
export function sleepBalePollingRetry(ms, signal) {
    if (ms <= 0 || signal?.aborted)
        return Promise.resolve();
    return new Promise((resolve) => {
        let settled = false;
        let timer;
        const finish = () => {
            if (settled)
                return;
            settled = true;
            signal?.removeEventListener("abort", onAbort);
            resolve();
        };
        const onAbort = () => {
            clearTimeout(timer);
            finish();
        };
        timer = setTimeout(finish, ms);
        timer.unref?.();
        signal?.addEventListener("abort", onAbort, { once: true });
        if (signal?.aborted)
            onAbort();
    });
}
export function createBalePollLoopRunner(deps) {
    const sleep = deps.sleep ?? sleepBalePollingRetry;
    return (ctx, signal) => runBalePollLoop({
        ctx,
        signal,
        config: deps.getConfig(),
        deleteWebhook: deps.deleteWebhook,
        getUpdates: deps.getUpdates,
        getUpdatesRequestBudgetMs: deps.getUpdatesRequestBudgetMs,
        persistConfig: deps.persistConfig,
        appendUpdateBatch: deps.appendUpdateBatch,
        getAcceptedThroughUpdateId: deps.getAcceptedThroughUpdateId,
        getJournalEntryCount: deps.getJournalEntryCount,
        signalUpdateWorker: deps.signalUpdateWorker,
        onErrorStatus: (message) => {
            updateBalePollingStatusSafely(deps.updateStatus, ctx, {
                message,
                recordRuntimeEvent: deps.recordRuntimeEvent,
            });
        },
        onStatusReset: () => {
            updateBalePollingStatusSafely(deps.updateStatus, ctx, {
                recordRuntimeEvent: deps.recordRuntimeEvent,
            });
        },
        sleep,
        onPhaseChange: deps.onPhaseChange,
        onSuccessfulResponse: deps.onSuccessfulResponse,
        recordRuntimeEvent: deps.recordRuntimeEvent,
    });
}
function getBalePollingErrorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
export function isBaleGetUpdatesConflictError(error) {
    return getBalePollingErrorMessage(error).includes("Conflict: terminated by other getUpdates request");
}
function reportBalePollingPhase(deps, phase, currentUpdateId) {
    try {
        deps.onPhaseChange?.(phase, currentUpdateId);
    }
    catch (error) {
        deps.recordRuntimeEvent?.("polling", error, {
            phase: "phase-observer",
        });
    }
}
function reportBalePollingResponse(deps, updateCount) {
    try {
        deps.onSuccessfulResponse?.(updateCount);
    }
    catch (error) {
        deps.recordRuntimeEvent?.("polling", error, {
            phase: "response-observer",
        });
    }
}
function getBalePollingAbortReason(signal) {
    return signal.reason ?? new DOMException("Aborted", "AbortError");
}
async function requestBaleUpdatesWithinBudget(deps, body) {
    if (deps.signal.aborted)
        throw getBalePollingAbortReason(deps.signal);
    const configuredBudgetMs = deps.getUpdatesRequestBudgetMs?.(body);
    const timeoutMs = typeof configuredBudgetMs === "number" &&
        Number.isFinite(configuredBudgetMs) &&
        configuredBudgetMs > 0
        ? Math.floor(configuredBudgetMs)
        : getBaleGetUpdatesRequestBudgetMs(body);
    const controller = new AbortController();
    const abortFromOwner = () => {
        controller.abort(getBalePollingAbortReason(deps.signal));
    };
    deps.signal.addEventListener("abort", abortFromOwner, { once: true });
    if (deps.signal.aborted)
        abortFromOwner();
    const timeout = setTimeout(() => {
        controller.abort(new BaleGetUpdatesTimeoutError(timeoutMs));
    }, timeoutMs);
    let onRequestAbort;
    const aborted = new Promise((_resolve, reject) => {
        onRequestAbort = () => reject(getBalePollingAbortReason(controller.signal));
        controller.signal.addEventListener("abort", onRequestAbort, {
            once: true,
        });
        if (controller.signal.aborted)
            onRequestAbort();
    });
    const operation = Promise.resolve()
        .then(() => {
        if (controller.signal.aborted) {
            throw getBalePollingAbortReason(controller.signal);
        }
        return deps.getUpdates(body, controller.signal);
    })
        .catch((error) => {
        if (controller.signal.aborted) {
            throw getBalePollingAbortReason(controller.signal);
        }
        throw error;
    });
    try {
        return await Promise.race([operation, aborted]);
    }
    finally {
        clearTimeout(timeout);
        deps.signal.removeEventListener("abort", abortFromOwner);
        if (onRequestAbort) {
            controller.signal.removeEventListener("abort", onRequestAbort);
        }
    }
}
export async function runBalePollLoop(deps) {
    if (!deps.config.botToken)
        return;
    let consecutiveGetUpdatesConflicts = 0;
    let consecutiveFailures = 0;
    const retryConflict = async () => {
        consecutiveGetUpdatesConflicts += 1;
        if (consecutiveGetUpdatesConflicts >= BALE_GET_UPDATES_CONFLICT_STOP_LIMIT) {
            throw new BalePersistentGetUpdatesConflictError(consecutiveGetUpdatesConflicts);
        }
        await deps.sleep(consecutiveGetUpdatesConflicts <
            BALE_GET_UPDATES_CONFLICT_FAST_RETRY_LIMIT
            ? BALE_GET_UPDATES_CONFLICT_FAST_RETRY_MS
            : BALE_GET_UPDATES_CONFLICT_SLOW_RETRY_MS, deps.signal);
    };
    try {
        await deps.deleteWebhook(deps.signal);
    }
    catch {
        // ignore
    }
    if (deps.getAcceptedThroughUpdateId?.() === undefined &&
        deps.getJournalEntryCount() > 0) {
        throw new BalePollingCursorBootstrapError("Bale polling cursor is missing while the durable update journal is non-empty.");
    }
    if (deps.getAcceptedThroughUpdateId?.() === undefined) {
        try {
            const request = buildBaleInitialSyncRequest();
            reportBalePollingPhase(deps, "long-poll");
            const updates = await requestBaleUpdatesWithinBudget(deps, request);
            reportBalePollingResponse(deps, updates.length);
            const lastUpdateId = getLatestBaleUpdateId(updates);
            if (lastUpdateId !== undefined) {
                reportBalePollingPhase(deps, "persisting-offset", lastUpdateId);
                await deps.appendUpdateBatch([], lastUpdateId);
                deps.recordRuntimeEvent?.("polling", new Error("Initialized Bale cursor without executing history."), { phase: "cursor-bootstrap", lastUpdateId });
            }
        }
        catch (error) {
            if (shouldStopBalePolling(deps.signal.aborted, error))
                return;
            reportBalePollingPhase(deps, "retrying");
            if (isBaleGetUpdatesConflictError(error)) {
                await retryConflict();
            }
            else
                deps.recordRuntimeEvent?.("polling", error, {
                    phase: "initial-sync",
                    ...(error instanceof BaleGetUpdatesTimeoutError
                        ? { timeoutMs: error.timeoutMs }
                        : {}),
                });
        }
    }
    let currentUpdateId;
    while (!deps.signal.aborted) {
        try {
            currentUpdateId = undefined;
            const request = buildBaleLongPollRequest(deps.getAcceptedThroughUpdateId?.());
            reportBalePollingPhase(deps, "long-poll");
            const updates = await requestBaleUpdatesWithinBudget(deps, request);
            reportBalePollingResponse(deps, updates.length);
            consecutiveGetUpdatesConflicts = 0;
            currentUpdateId = updates[0]?.update_id;
            await admitBalePollingUpdateBatch({
                updates,
                config: deps.config,
                appendBatch: deps.appendUpdateBatch,
                getAcceptedThroughUpdateId: deps.getAcceptedThroughUpdateId,
                persistConfig: deps.persistConfig,
                signalWorker: deps.signalUpdateWorker,
                onPhaseChange: deps.onPhaseChange,
                recordRuntimeEvent: deps.recordRuntimeEvent,
            });
            consecutiveFailures = 0;
            currentUpdateId = undefined;
        }
        catch (error) {
            if (shouldStopBalePolling(deps.signal.aborted, error))
                return;
            reportBalePollingPhase(deps, "retrying", currentUpdateId);
            if (isBaleGetUpdatesConflictError(error)) {
                await retryConflict();
                continue;
            }
            deps.recordRuntimeEvent?.("polling", error, {
                phase: error instanceof BaleGetUpdatesTimeoutError
                    ? "long-poll"
                    : "loop",
                ...(error instanceof BaleGetUpdatesTimeoutError
                    ? { timeoutMs: error.timeoutMs }
                    : {}),
            });
            consecutiveGetUpdatesConflicts = 0;
            consecutiveFailures += 1;
            deps.onErrorStatus(getBalePollingErrorMessage(error));
            // Cap the pause, not retry count: outages must recover without manual reconnect.
            await deps.sleep(getBalePollingRetryDelayMs(consecutiveFailures), deps.signal);
            if (deps.signal.aborted)
                return;
            deps.onStatusReset();
        }
    }
}

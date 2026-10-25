/**
 * Bale polling runtime domain helpers
 * Zones: bale transport, polling runtime
 * Owns polling request builders, stop conditions, and the long-poll loop runtime for Bale updates
 */

type MaybePromise<T> = T | Promise<T>;

/**
 * Structural port for run-collapsing diagnostics: a repeated identical failure extends its run instead of logging
 * again, and the closing success records one outcome. The composition root owns the collapsed implementation.
 */
export interface BaleRepeatedFailureLogPort {
  record: (error: unknown, details?: Record<string, unknown>) => void;
  settled: () => void;
  reset: () => void;
}

export interface BalePollingConfig {
  botToken?: string;
}

export interface BaleUpdate {
  update_id: number;
}

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
] as const;

export function buildBaleInitialSyncRequest(): {
  offset: number;
  limit: number;
  timeout: number;
} {
  return {
    offset: BALE_INITIAL_SYNC_OFFSET,
    limit: BALE_INITIAL_SYNC_LIMIT,
    timeout: BALE_INITIAL_SYNC_TIMEOUT_SECONDS,
  };
}

export function buildBaleLongPollRequest(lastUpdateId?: number): {
  offset?: number;
  limit: number;
  timeout: number;
  allowed_updates: readonly string[];
} {
  return {
    offset: lastUpdateId !== undefined ? lastUpdateId + 1 : undefined,
    limit: BALE_LONG_POLL_LIMIT,
    timeout: BALE_LONG_POLL_TIMEOUT_SECONDS,
    allowed_updates: BALE_ALLOWED_UPDATES,
  };
}

export function getLatestBaleUpdateId(
  updates: readonly BaleUpdate[],
): number | undefined {
  return updates.at(-1)?.update_id;
}

export class BalePersistentGetUpdatesConflictError extends Error {
  readonly count: number;
  constructor(count: number) {
    super(
      `Bale polling stopped after ${count} consecutive getUpdates conflicts.`,
    );
    this.name = "BalePersistentGetUpdatesConflictError";
    this.count = count;
  }
}

/** Exponential backoff for non-conflict polling/admission failures. */
export function getBalePollingRetryDelayMs(
  consecutiveFailures: number,
): number {
  const exponent = Math.max(0, Math.min(consecutiveFailures - 1, 16));
  return Math.min(
    BALE_POLLING_RETRY_BASE_MS * 2 ** exponent,
    BALE_POLLING_RETRY_MAX_MS,
  );
}

export class BaleGetUpdatesTimeoutError extends Error {
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`Bale getUpdates timed out after ${timeoutMs} ms.`);
    this.name = "BaleGetUpdatesTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

export function getBaleGetUpdatesRequestBudgetMs(
  body: Record<string, unknown>,
  graceMs = BALE_GET_UPDATES_GRACE_MS,
): number {
  const timeoutSeconds =
    typeof body.timeout === "number" &&
    Number.isFinite(body.timeout) &&
    body.timeout >= 0
      ? body.timeout
      : 0;
  const normalizedGraceMs =
    Number.isFinite(graceMs) && graceMs > 0
      ? Math.floor(graceMs)
      : BALE_GET_UPDATES_GRACE_MS;
  return Math.floor(timeoutSeconds * 1_000) + normalizedGraceMs;
}

export function shouldStopBalePolling(
  signalAborted: boolean,
  error: unknown,
): boolean {
  return (
    signalAborted ||
    (error instanceof DOMException && error.name === "AbortError")
  );
}

export interface BalePollingStartState {
  hasBotToken: boolean;
  hasPollingPromise: boolean;
}

export type BalePollingWorkPhase =
  "long-poll" | "persisting-journal" | "persisting-offset" | "retrying";

export type BalePollingPhase =
  "stopped" | "starting" | BalePollingWorkPhase;

export type BalePollingStopReason =
  "not-started" | "requested" | "completed" | "failed" | "persistent-conflict";

export interface BalePollingStateSnapshot {
  phase: BalePollingPhase;
  phaseStartedAtMs?: number;
  currentUpdateId?: number;
  startedAtMs?: number;
  stoppedAtMs?: number;
  lastSuccessfulResponseAtMs?: number;
  lastSuccessfulResponseUpdateCount?: number;
  stopReason?: BalePollingStopReason;
}

export interface BalePollingControllerState extends BalePollingStateSnapshot {
  pollingPromise?: Promise<void>;
  pollingController?: AbortController;
}

export function createBalePollingControllerState(): BalePollingControllerState {
  return {
    phase: "stopped",
    stopReason: "not-started",
  };
}

function getBalePollingStateSnapshot(
  state: BalePollingControllerState,
): BalePollingStateSnapshot {
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

export function createBalePollingStateReader(
  state: BalePollingControllerState,
): () => BalePollingStateSnapshot {
  return () => getBalePollingStateSnapshot(state);
}

export function isBalePollingControllerActive(
  state: BalePollingControllerState,
): boolean {
  return !!state.pollingPromise;
}

export function createBalePollingActivityReader(
  state: BalePollingControllerState,
): () => boolean {
  return () => isBalePollingControllerActive(state);
}

export interface BalePollingRuntimeDeps<
  TContext,
> extends BaleRuntimeEventRecorderPort {
  hasBotToken: () => boolean;
  getPollingPromise: () => Promise<void> | undefined;
  setPollingPromise: (promise: Promise<void> | undefined) => void;
  getPollingController: () => AbortController | undefined;
  setPollingController: (controller: AbortController | undefined) => void;
  stopTypingLoop: () => unknown;
  runPollLoop: (ctx: TContext, signal: AbortSignal) => Promise<void>;
  updateStatus: (ctx: TContext, message?: string) => void;
  createAbortController?: () => AbortController;
  getNowMs?: () => number;
  onPollingStateChange?: () => void;
  onPersistentConflict?: (ctx: TContext, count: number) => MaybePromise<void>;
  onPollingStarted?: () => void;
  onPollingStopped?: (reason: BalePollingStopReason) => void;
}

export type BalePollingControllerDeps<TContext> = Omit<
  BalePollingRuntimeDeps<TContext>,
  | "getPollingPromise"
  | "setPollingPromise"
  | "getPollingController"
  | "setPollingController"
> & { state?: BalePollingControllerState };

export interface BalePollingController<TContext> {
  isActive: () => boolean;
  start: (ctx: TContext) => void;
  stop: () => Promise<void>;
}

export interface BalePollingAdmissionRuntime<TContext> {
  isActive: () => boolean;
  start: (ctx: TContext) => Promise<void>;
  stop: () => Promise<void>;
}

export function createBalePollingAdmissionRuntime<TContext>(deps: {
  polling: BalePollingController<TContext>;
  prepareStart?: () => MaybePromise<void>;
  canStart?: (ctx: TContext) => boolean;
  validateStart?: () => void;
  worker: {
    onSessionStart: (ctx: TContext) => Promise<void>;
  };
}): BalePollingAdmissionRuntime<TContext> {
  let generation = 0;
  return {
    isActive: deps.polling.isActive,
    async start(ctx) {
      if (!(deps.canStart?.(ctx) ?? true)) return;
      const expectedGeneration = ++generation;
      const isCurrent = () =>
        expectedGeneration === generation && (deps.canStart?.(ctx) ?? true);
      if (!isCurrent()) return;
      await deps.prepareStart?.();
      if (!isCurrent()) return;
      deps.validateStart?.();
      await deps.worker.onSessionStart(ctx);
      if (!isCurrent()) return;
      deps.polling.start(ctx);
    },
    async stop() {
      generation += 1;
      await deps.polling.stop();
    },
  };
}

export interface BaleDurablePollingRuntimeAssembly<TContext> {
  controller: BalePollingController<TContext>;
  admission: BalePollingAdmissionRuntime<TContext>;
}

export type BaleDurablePollingRuntimeAssemblyDeps<
  TUpdate extends BaleUpdate,
  TContext,
> = Omit<
  BalePollingControllerRuntimeDeps<TUpdate, TContext>,
  "appendUpdateBatch" | "getJournalEntryCount" | "signalUpdateWorker"
> & {
  canStart?: (ctx: TContext) => boolean;
  prepareUpdateBatch?: (updates: readonly TUpdate[]) => void;
  journal: {
    appendBatch: (
      updates: readonly TUpdate[],
      acceptedThroughUpdateId?: number,
    ) => { nonExcludedUpdateIds: readonly number[] };
    getAcceptedThroughUpdateId: () => number | undefined;
    prepareCursorCutover?: () => MaybePromise<void>;
    getEntryCount: () => number;
    signalWorker: () => void;
    getBootstrapEntryCount: () => number;
    onSessionStart: (ctx: TContext) => Promise<void>;
  };
};

/** Own journal-first polling assembly and cursor bootstrap validation. */
export function createBaleDurablePollingRuntimeAssembly<
  TUpdate extends BaleUpdate,
  TContext,
>(
  deps: BaleDurablePollingRuntimeAssemblyDeps<TUpdate, TContext>,
): BaleDurablePollingRuntimeAssembly<TContext> {
  const controller = createBalePollingControllerRuntime({
    ...deps,
    appendUpdateBatch(updates, cursor) {
      const result = deps.journal.appendBatch(updates, cursor);
      if (!deps.prepareUpdateBatch) return result;
      // No await: an already-draining worker must not observe the new batch before preparation.
      try {
        const included = new Set(result.nonExcludedUpdateIds);
        let batch: TUpdate[] = [];
        for (const update of updates) {
          if (included.has(update.update_id)) batch.push(update);
          else if (batch.length > 0) {
            deps.prepareUpdateBatch(batch);
            batch = [];
          }
        }
        if (batch.length > 0) deps.prepareUpdateBatch(batch);
      } catch (error) {
        try {
          deps.recordRuntimeEvent?.("polling", error, {
            phase: "batch-preparation",
            updateCount: updates.length,
          });
        } catch {
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
      if (deps.journal.getAcceptedThroughUpdateId() !== undefined) return;
      if (deps.journal.getBootstrapEntryCount() === 0) return;
      throw new BalePollingCursorBootstrapError(
        "Bale polling cursor is missing while the durable update journal is non-empty.",
      );
    },
    worker: deps.journal,
  });
  return { controller, admission };
}

export type BalePollingControllerRuntimeDeps<
  TUpdate extends BaleUpdate,
  TContext = unknown,
> = Omit<
  BalePollLoopRunnerDeps<TUpdate, TContext>,
  "onPhaseChange" | "onSuccessfulResponse"
> & {
  state?: BalePollingControllerState;
  hasBotToken: () => boolean;
  stopTypingLoop: () => unknown;
  createAbortController?: () => AbortController;
  getNowMs?: () => number;
  onPollingStateChange?: () => void;
  onPersistentConflict?: (ctx: TContext, count: number) => MaybePromise<void>;
};

function notifyBalePollingStateChange(
  deps: Pick<
    BalePollingRuntimeDeps<unknown>,
    "onPollingStateChange" | "recordRuntimeEvent"
  >,
): void {
  try {
    deps.onPollingStateChange?.();
  } catch (error) {
    deps.recordRuntimeEvent?.("polling", error, {
      phase: "state-observer",
    });
  }
}

function transitionBalePollingState(
  state: BalePollingControllerState,
  phase: BalePollingPhase,
  nowMs: number,
  currentUpdateId?: number,
): void {
  state.phase = phase;
  state.phaseStartedAtMs = nowMs;
  state.currentUpdateId = currentUpdateId;
}

export function createBalePollingControllerRuntime<
  TUpdate extends BaleUpdate,
  TContext = unknown,
>(
  deps: BalePollingControllerRuntimeDeps<TUpdate, TContext>,
): BalePollingController<TContext> {
  const state = deps.state ?? createBalePollingControllerState();
  const getNowMs = deps.getNowMs ?? Date.now;
  const notifyStateChange = () =>
    notifyBalePollingStateChange({
      onPollingStateChange: deps.onPollingStateChange,
      recordRuntimeEvent: deps.recordRuntimeEvent,
    });
  return createBalePollingController({
    state,
    hasBotToken: deps.hasBotToken,
    stopTypingLoop: deps.stopTypingLoop,
    runPollLoop: createBalePollLoopRunner<TUpdate, TContext>({
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
        transitionBalePollingState(
          state,
          phase,
          getNowMs(),
          currentUpdateId,
        );
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

export function createBalePollingController<TContext>(
  deps: BalePollingControllerDeps<TContext>,
): BalePollingController<TContext> {
  const state = deps.state ?? createBalePollingControllerState();
  const getNowMs = deps.getNowMs ?? Date.now;
  const notifyStateChange = () =>
    notifyBalePollingStateChange({
      onPollingStateChange: deps.onPollingStateChange,
      recordRuntimeEvent: deps.recordRuntimeEvent,
    });
  const runtimeDeps: BalePollingRuntimeDeps<TContext> = {
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

export function shouldStartBalePolling(
  state: BalePollingStartState,
): boolean {
  return state.hasBotToken && !state.hasPollingPromise;
}

export async function stopBalePollingRuntime<TContext>(
  deps: BalePollingRuntimeDeps<TContext>,
): Promise<void> {
  const pollingPromise = deps.getPollingPromise();
  const pollingController = deps.getPollingController();
  try {
    deps.stopTypingLoop();
  } catch (error) {
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
  if (cleared) deps.onPollingStopped?.("requested");
}

function updateBalePollingStatusSafely<TContext>(
  updateStatus: (ctx: TContext, message?: string) => void,
  ctx: TContext,
  options: {
    message?: string;
    recordRuntimeEvent?: BaleRuntimeEventRecorderPort["recordRuntimeEvent"];
  } = {},
): void {
  try {
    updateStatus(ctx, options.message);
  } catch (error) {
    // The polling loop can outlive the session context it captured.
    options.recordRuntimeEvent?.("polling", error, { phase: "status-update" });
  }
}

export function startBalePollingRuntime<TContext>(
  ctx: TContext,
  deps: BalePollingRuntimeDeps<TContext>,
): void {
  if (
    !shouldStartBalePolling({
      hasBotToken: deps.hasBotToken(),
      hasPollingPromise: !!deps.getPollingPromise(),
    })
  ) {
    return;
  }
  const controller = deps.createAbortController?.() ?? new AbortController();
  deps.setPollingController(controller);
  deps.onPollingStarted?.();
  let failed = false;
  let persistentConflict: BalePersistentGetUpdatesConflictError | undefined;
  let runPromise: Promise<void>;
  try {
    runPromise = deps.runPollLoop(ctx, controller.signal);
  } catch (error) {
    runPromise = Promise.reject(error);
  }
  let promise: Promise<void>;
  promise = runPromise
    .catch((error) => {
      if (shouldStopBalePolling(controller.signal.aborted, error)) return;
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
      if (ownsPromise) deps.setPollingPromise(undefined);
      if (ownsController) deps.setPollingController(undefined);
      if (!ownsPromise && !ownsController) return;
      deps.onPollingStopped?.(
        controller.signal.aborted
          ? "requested"
          : persistentConflict
            ? "persistent-conflict"
            : failed
              ? "failed"
              : "completed",
      );
      // Detach the inner promise before outer teardown calls polling.stop().
      if (persistentConflict && !controller.signal.aborted) {
        try {
          if (deps.onPersistentConflict) {
            await deps.onPersistentConflict(ctx, persistentConflict.count);
          } else {
            deps.stopTypingLoop();
            deps.recordRuntimeEvent?.("polling", persistentConflict, {
              phase: "persistent-conflict",
              count: persistentConflict.count,
            });
          }
        } catch (error) {
          deps.recordRuntimeEvent?.("polling", error, {
            phase: "conflict-stand-down",
          });
        }
        if (deps.getPollingController() || deps.getPollingPromise()) return;
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

export interface BaleRuntimeEventRecorderPort {
  recordRuntimeEvent?: (
    category: string,
    error: unknown,
    details?: Record<string, unknown>,
  ) => void;
}

export type BaleThreadCapabilityMode = "enabled" | "disabled" | "unknown";

export interface BaleThreadCapabilityState {
  threadMode?: BaleThreadCapabilityMode;
  updatedAtMs?: number;
  lastSlot?: string;
  lastReconcileAction?: string;
}

export interface BaleThreadCapabilityRecordView {
  status?: string;
  target?: { chatId?: number; threadId?: number };
}

export interface BaleThreadCapabilityStore {
  load: () => Promise<void>;
  refresh?: () => Promise<void>;
  persist: () => Promise<void>;
  getBotState: () => BaleThreadCapabilityState;
  setBotState: (state: BaleThreadCapabilityState) => void;
  list?: () => BaleThreadCapabilityRecordView[];
}

export interface BaleThreadCapabilityReaderDeps {
  getAllowedUserId: () => number | undefined;
  callApi: <TResponse>(
    method: string,
    body: Record<string, unknown>,
  ) => Promise<TResponse>;
}

interface BaleThreadCapabilityLifecycle {
  capture: () => () => boolean;
  invalidate: () => void;
}

export interface BaleStartupThreadCapabilityProbeDeps extends BaleThreadCapabilityReaderDeps {
  topicTargetStore: BaleThreadCapabilityStore;
  recordEvent: (
    category: string,
    message: unknown,
    details?: Record<string, unknown>,
  ) => void;
  setTopicModeUnavailable: (unavailable: boolean) => void;
  getNowMs?: () => number;
}

export interface BaleThreadCapabilityRuntimeDeps<
  TContext,
> extends BaleThreadCapabilityReaderDeps {
  /** Collapses one sustained probe failure run; the caller supplies its owner. */
  failureLog: BaleRepeatedFailureLogPort;
  lifecycle?: BaleThreadCapabilityLifecycle;
  topicTargetStore: BaleThreadCapabilityStore;
  ownsLock: (ctx: TContext) => boolean;
  isFollowerRegistered?: () => boolean;
  getPollingStartedWithBaleBus: () => boolean;
  setPollingStartedWithBaleBus: (started: boolean) => void;
  setTopicModeUnavailable: (unavailable: boolean) => void;
  suspendLiveThreadTarget?: () => void;
  stopFollowerRegistration: () => void;
  startClassicPolling: (ctx: TContext) => MaybePromise<void>;
  stopClassicPolling: () => MaybePromise<void>;
  startBusPolling: (ctx: TContext) => MaybePromise<void>;
  stopBusPolling: () => MaybePromise<void>;
  startLeaderHealth: () => void;
  stopLeaderHealth: () => void;
  isTopicModeUnavailableError?: (error: unknown) => boolean;
  updateStatus: (ctx: TContext) => void;
  recordEvent: (
    category: string,
    message: unknown,
    details?: Record<string, unknown>,
  ) => void;
  getNowMs?: () => number;
  intervalMs?: number;
}

export interface BaleThreadCapabilityMonitor<TContext> {
  start: (ctx: TContext) => void;
  stop: () => void;
}

export interface BaleThreadCapabilityStateRuntime {
  isBusPollingStarted(): boolean;
  setBusPollingStarted(started: boolean): void;
  isTopicModeUnavailable(): boolean;
  setTopicModeUnavailable(unavailable: boolean): void;
  isBusRuntimeEnabled(): boolean;
  shouldForceFreshLeaderThread(): boolean;
  setForceFreshLeaderThread(forceFresh: boolean): void;
  getRequestedThreadName(): string | undefined;
  setRequestedThreadName(threadName: string | undefined): void;
}

export type BaleThreadTargetObservationHandler<TContext> = (
  ctx: TContext,
) => Promise<void>;

export interface BaleThreadTargetObservationBinding<TContext> {
  handle: BaleThreadTargetObservationHandler<TContext>;
  set(handler: BaleThreadTargetObservationHandler<TContext>): void;
}

export function createBaleThreadTargetObservationBinding<
  TContext,
>(): BaleThreadTargetObservationBinding<TContext> {
  let handler: BaleThreadTargetObservationHandler<TContext> | undefined;
  return {
    async handle(ctx) {
      await handler?.(ctx);
    },
    set(nextHandler) {
      handler = nextHandler;
    },
  };
}

export interface BaleThreadAwarePollingPorts<TContext, TOwner> {
  startPolling: (
    ctx: TContext,
    options?: { forceFreshLeaderThread?: boolean },
  ) => Promise<void>;
  stopPolling: () => Promise<void>;
  registerFollowerWithOwner: (
    ctx: TContext,
    owner: TOwner,
    options?: { recoverConnection?: boolean },
  ) => Promise<boolean | undefined>;
  restoreFollowerWithOwner: (
    ctx: TContext,
    owner: TOwner,
  ) => Promise<boolean | undefined>;
  stopFollowerRegistration: () => void;
}

/** Classic/leader polling and follower registration controls that thread-aware polling switches between. */
export interface BaleThreadAwarePollingControls<TContext, TOwner> {
  startClassicPolling: (ctx: TContext) => MaybePromise<void>;
  stopClassicPolling: () => Promise<void>;
  startBusLeaderPolling: (ctx: TContext) => Promise<void>;
  stopBusLeaderPolling: () => Promise<void>;
  startLeaderHealth: () => void;
  stopLeaderHealth: () => void;
  registerFollowerWithLeader: (
    ctx: TContext,
    owner: TOwner,
    options?: { recoverConnection?: boolean },
  ) => Promise<boolean | undefined>;
  restoreFollowerWithLeader?: (
    ctx: TContext,
    owner: TOwner,
  ) => Promise<boolean | undefined>;
  hasRememberedWorkspaceBinding?: (ctx: TContext) => boolean;
  stopFollowerRegistration: () => void;
  isBusRuntimeEnabled: () => boolean;
  isTopicModeUnavailableError: (error: unknown) => boolean;
}

export interface BaleThreadAwarePollingDeps<TContext, TOwner>
  extends
    BaleStartupThreadCapabilityProbeDeps,
    BaleThreadAwarePollingControls<TContext, TOwner> {
  lifecycle?: BaleThreadCapabilityLifecycle;
  getPollingStartedWithBaleBus: () => boolean;
  setPollingStartedWithBaleBus: (started: boolean) => void;
  setForceFreshLeaderThreadOnNextStart: (forceFresh: boolean) => void;
}

export interface BaleThreadCapabilityOrchestrationDeps<TContext, TOwner>
  extends
    BaleThreadCapabilityReaderDeps,
    BaleThreadAwarePollingControls<TContext, TOwner> {
  /** Collapses one sustained probe failure run; the composition root supplies its owner. */
  failureLog: BaleRepeatedFailureLogPort;
  state: BaleThreadCapabilityStateRuntime;
  topicTargetStore: BaleThreadCapabilityStore;
  ownsLock: (ctx: TContext) => boolean;
  isFollowerRegistered?: () => boolean;
  suspendLiveThreadTarget?: () => void;
  updateStatus: (ctx: TContext) => void;
  recordEvent: (
    category: string,
    message: unknown,
    details?: Record<string, unknown>,
  ) => void;
}

export interface BaleThreadCapabilityOrchestration<TContext, TOwner> {
  monitor: BaleThreadCapabilityMonitor<TContext>;
  observeTarget: BaleThreadTargetObservationHandler<TContext>;
  pollingPorts: BaleThreadAwarePollingPorts<TContext, TOwner>;
}

export function createBaleThreadCapabilityStateRuntime(): BaleThreadCapabilityStateRuntime {
  let busPollingStarted = false;
  let topicModeUnavailable = false;
  let forceFreshLeaderThread = false;
  let requestedThreadName: string | undefined;
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

export function createBaleThreadCapabilityOrchestration<TContext, TOwner>(
  deps: BaleThreadCapabilityOrchestrationDeps<TContext, TOwner>,
): BaleThreadCapabilityOrchestration<TContext, TOwner> {
  let generation = 0;
  const lifecycle: BaleThreadCapabilityLifecycle = {
    capture() {
      const expected = generation;
      return () => expected === generation;
    },
    invalidate() {
      generation++;
    },
  };
  const capabilityDeps: BaleThreadCapabilityRuntimeDeps<TContext> = {
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
      setForceFreshLeaderThreadOnNextStart:
        deps.state.setForceFreshLeaderThread,
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

async function readBaleThreadCapability(
  deps: BaleThreadCapabilityReaderDeps,
): Promise<boolean | undefined> {
  await deps.callApi("getMe", {});
  return false; // Bale's documented API has no private-chat topic lifecycle.
}

async function probeBaleStartupThreadCapability(
  deps: BaleStartupThreadCapabilityProbeDeps,
  isCurrent: () => boolean = () => true,
): Promise<boolean | undefined> {
  if (!isCurrent()) return;
  const threadModeEnabled = await readBaleThreadCapability(deps);
  if (!isCurrent()) return;
  const nowMs = (deps.getNowMs ?? Date.now)();
  if (threadModeEnabled === false) {
    deps.topicTargetStore.setBotState({
      threadMode: "disabled",
      updatedAtMs: nowMs,
      lastReconcileAction: "startup-bot-topics-disabled",
    });
    await deps.topicTargetStore.persist();
    if (!isCurrent()) return;
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
    if (!isCurrent()) return;
    deps.setTopicModeUnavailable(false);
  }
  return threadModeEnabled;
}

function hasBaleClassicRestoreFailure(
  state: BaleThreadCapabilityState,
): boolean {
  return (
    state.lastReconcileAction?.endsWith("-classic-restore-failed") ?? false
  );
}

function hasBaleThreadCapabilityBindings(
  store: BaleThreadCapabilityStore,
): boolean {
  return (
    store.list?.().some((record) => {
      return (
        typeof record.target?.chatId === "number" &&
        typeof record.target.threadId === "number" &&
        record.status !== "deleted" &&
        record.status !== "offline" &&
        record.status !== "stale"
      );
    }) ?? false
  );
}

/** Falls back to classic polling, recording a failed restore durably; false once the attempt is stale. */
async function restoreBaleClassicPolling<TContext>(
  ctx: TContext,
  phase: string,
  deps: BaleThreadCapabilityRuntimeDeps<TContext>,
  isCurrent: () => boolean,
): Promise<boolean> {
  try {
    await deps.startClassicPolling(ctx);
    return isCurrent();
  } catch (classicError) {
    if (!isCurrent()) return false;
    deps.topicTargetStore.setBotState({
      threadMode: "disabled",
      updatedAtMs: (deps.getNowMs ?? Date.now)(),
      lastReconcileAction: `${phase}-classic-restore-failed`,
    });
    await deps.topicTargetStore.persist();
    if (!isCurrent()) return false;
    deps.recordEvent("bus", classicError, {
      phase: `${phase}-classic-restore`,
    });
    return true;
  }
}

export async function applyBaleThreadCapability<TContext>(
  ctx: TContext,
  threadModeEnabled: boolean,
  phase: string,
  deps: BaleThreadCapabilityRuntimeDeps<TContext>,
  isCurrent: () => boolean = deps.lifecycle?.capture() ?? (() => true),
): Promise<void> {
  if (!isCurrent()) return;
  await deps.topicTargetStore.load();
  if (!isCurrent()) return;
  const nowMs = (deps.getNowMs ?? Date.now)();
  const previousBotState = deps.topicTargetStore.getBotState();
  if (!threadModeEnabled) {
    if (
      hasBaleThreadCapabilityBindings(deps.topicTargetStore) &&
      !phase.endsWith("-confirmed")
    ) {
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
    if (!isCurrent()) return;
    deps.setTopicModeUnavailable(true);
    deps.stopFollowerRegistration();
    const hadLiveThreadTransport = deps.getPollingStartedWithBaleBus();
    if (
      hadLiveThreadTransport ||
      hasBaleClassicRestoreFailure(previousBotState)
    ) {
      deps.stopLeaderHealth();
      await deps.stopBusPolling();
      if (!isCurrent()) return;
      deps.setPollingStartedWithBaleBus(false);
      if (hadLiveThreadTransport) deps.suspendLiveThreadTarget?.();
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
  if (!isCurrent()) return;
  deps.setTopicModeUnavailable(false);
  if (!deps.getPollingStartedWithBaleBus() && deps.ownsLock(ctx)) {
    await deps.stopClassicPolling();
    if (!isCurrent()) return;
    deps.setPollingStartedWithBaleBus(true);
    try {
      await deps.startBusPolling(ctx);
      if (!isCurrent()) return;
      deps.startLeaderHealth();
    } catch (error) {
      if (!isCurrent()) return;
      deps.setPollingStartedWithBaleBus(false);
      const threadModeUnavailable =
        deps.isTopicModeUnavailableError?.(error) === true;
      if (threadModeUnavailable) {
        deps.topicTargetStore.setBotState({
          threadMode: "disabled",
          updatedAtMs: nowMs,
          lastReconcileAction: `${phase}-unavailable`,
        });
        await deps.topicTargetStore.persist();
        if (!isCurrent()) return;
        deps.setTopicModeUnavailable(true);
      }
      if (!(await restoreBaleClassicPolling(ctx, phase, deps, isCurrent)))
        return;
      deps.updateStatus(ctx);
      if (threadModeUnavailable) return;
      throw error;
    }
  }
  deps.updateStatus(ctx);
}

export function createBaleThreadAwarePollingPorts<TContext, TOwner>(
  deps: BaleThreadAwarePollingDeps<TContext, TOwner>,
): BaleThreadAwarePollingPorts<TContext, TOwner> {
  let generation = 0;
  const startPolling = async (
    ctx: TContext,
    options?: { forceFreshLeaderThread?: boolean },
  ): Promise<void> => {
    const expectedGeneration = ++generation;
    deps.lifecycle?.invalidate();
    const isLifecycleCurrent = deps.lifecycle?.capture() ?? (() => true);
    const isCurrent = () =>
      expectedGeneration === generation && isLifecycleCurrent();
    await deps.topicTargetStore.load();
    if (!isCurrent()) return;
    let startupThreadCapability: boolean | undefined;
    try {
      startupThreadCapability = await probeBaleStartupThreadCapability(
        deps,
        isCurrent,
      );
    } catch (error) {
      if (!isCurrent()) return;
      deps.recordEvent("bus", error, { phase: "startup-thread-mode-probe" });
    }
    if (!isCurrent()) return;
    deps.setTopicModeUnavailable(startupThreadCapability !== true);
    if (deps.isBusRuntimeEnabled()) {
      deps.setTopicModeUnavailable(false);
      try {
        deps.setPollingStartedWithBaleBus(true);
        deps.setForceFreshLeaderThreadOnNextStart(
          !!options?.forceFreshLeaderThread,
        );
        await deps.startBusLeaderPolling(ctx);
        if (!isCurrent()) return;
        deps.startLeaderHealth();
        return;
      } catch (error) {
        if (!isCurrent()) return;
        deps.setPollingStartedWithBaleBus(false);
        if (!deps.isTopicModeUnavailableError(error)) throw error;
        deps.setTopicModeUnavailable(true);
        await deps.topicTargetStore.load();
        if (!isCurrent()) return;
        deps.topicTargetStore.setBotState({
          threadMode: "disabled",
          updatedAtMs: Date.now(),
          lastReconcileAction: "thread-mode-unavailable",
        });
        await deps.topicTargetStore.persist();
        if (!isCurrent()) return;
        deps.recordEvent("bus", error, { phase: "thread-mode-unavailable" });
      } finally {
        if (isCurrent()) deps.setForceFreshLeaderThreadOnNextStart(false);
      }
    }
    deps.setPollingStartedWithBaleBus(false);
    await deps.startClassicPolling(ctx);
  };
  const stopPolling = async (): Promise<void> => {
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
  const refreshFollowerState = async (): Promise<boolean> => {
    if (deps.topicTargetStore.refresh) {
      await deps.topicTargetStore.refresh();
    } else {
      await deps.topicTargetStore.load();
    }
    return deps.topicTargetStore.getBotState().threadMode === "enabled";
  };
  const registerFollowerWithOwner = async (
    ctx: TContext,
    owner: TOwner,
    options?: { recoverConnection?: boolean },
  ): Promise<boolean | undefined> => {
    if (!(await refreshFollowerState())) return undefined;
    return deps.registerFollowerWithLeader(ctx, owner, options);
  };
  const restoreFollowerWithOwner = async (
    ctx: TContext,
    owner: TOwner,
  ): Promise<boolean | undefined> => {
    if (!(await refreshFollowerState())) {
      deps.recordEvent(
        "bus",
        "Bale follower auto-connect skipped: Threaded Mode is not enabled.",
        {
          phase: "follower-auto-connect-skip",
          reason: "thread-mode-unavailable",
        },
      );
      return undefined;
    }
    if (!deps.hasRememberedWorkspaceBinding?.(ctx)) {
      deps.recordEvent(
        "bus",
        "Bale follower auto-connect skipped: no binding for this session.",
        {
          phase: "follower-auto-connect-skip",
          reason: "session-binding-unavailable",
        },
      );
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

function createBaleThreadTargetObservationHandler<TContext>(
  deps: BaleThreadCapabilityRuntimeDeps<TContext>,
): BaleThreadTargetObservationHandler<TContext> {
  let transitionPending = false;
  return async (ctx) => {
    if (transitionPending) return;
    if (deps.topicTargetStore.getBotState().threadMode === "enabled") return;
    transitionPending = true;
    const isCurrent = deps.lifecycle?.capture() ?? (() => true);
    try {
      await applyBaleThreadCapability(
        ctx,
        true,
        "thread-target-observed",
        deps,
        isCurrent,
      );
    } catch (error) {
      if (!isCurrent()) return;
      deps.recordEvent("bus", error, { phase: "thread-target-observed" });
    } finally {
      transitionPending = false;
    }
  };
}

export function canProbeBaleThreadCapability<TContext>(
  ctx: TContext,
  deps: Pick<
    BaleThreadCapabilityRuntimeDeps<TContext>,
    "ownsLock" | "isFollowerRegistered"
  >,
): boolean {
  return deps.ownsLock(ctx) || deps.isFollowerRegistered?.() === true;
}

export function createBaleThreadCapabilityMonitor<TContext>(
  deps: BaleThreadCapabilityRuntimeDeps<TContext>,
): BaleThreadCapabilityMonitor<TContext> {
  const intervalMs =
    deps.intervalMs ?? BALE_THREAD_CAPABILITY_MONITOR_INTERVAL_MS;
  let interval: ReturnType<typeof setInterval> | undefined;
  let generation = 0;
  let transitionPromise: Promise<void> | undefined;
  let consecutiveDisabledProbes = 0;
  // An absent leader endpoint repeats one identical probe failure every interval; the port collapses the run.
  // Running it through one guard keeps a faulty diagnostics port from breaking probes or the interval callback.
  const capabilityFailureLog: BaleRepeatedFailureLogPort = {
    record(error, details) {
      try {
        deps.failureLog.record(error, details);
      } catch {
        // Monitor diagnostics cannot create an uncaught interval exception.
      }
    },
    settled() {
      try {
        deps.failureLog.settled();
      } catch {
        // Monitor diagnostics cannot fail a completed probe.
      }
    },
    reset() {
      try {
        deps.failureLog.reset();
      } catch {
        // Monitor diagnostics cannot fail a monitor stop.
      }
    },
  };
  const stop = (): void => {
    generation += 1;
    capabilityFailureLog.reset();
    if (interval) clearInterval(interval);
    interval = undefined;
    deps.lifecycle?.invalidate();
  };
  const check = (ctx: TContext): void => {
    if (transitionPromise || !canProbeBaleThreadCapability(ctx, deps)) {
      return;
    }
    const expectedGeneration = generation;
    const isLifecycleCurrent = deps.lifecycle?.capture() ?? (() => true);
    const isCurrent = (): boolean =>
      generation === expectedGeneration && isLifecycleCurrent();
    let tracked: Promise<void>;
    tracked = readBaleThreadCapability(deps)
      .then(async (threadModeEnabled) => {
        if (!isCurrent()) return;
        capabilityFailureLog.settled();
        if (threadModeEnabled === undefined) {
          if (
            deps.topicTargetStore.getBotState().threadMode !== "enabled" &&
            !deps.getPollingStartedWithBaleBus() &&
            deps.ownsLock(ctx)
          ) {
            await applyBaleThreadCapability(
              ctx,
              true,
              "capability-monitor-retry",
              deps,
              isCurrent,
            );
          }
          return;
        }
        if (threadModeEnabled) consecutiveDisabledProbes = 0;
        const botState = deps.topicTargetStore.getBotState();
        const current = botState.threadMode;
        // Persisted capability is not proof that this owner started its local bus.
        if (threadModeEnabled && current === "enabled" &&
            (deps.getPollingStartedWithBaleBus() || !deps.ownsLock(ctx))) return;
        if (!threadModeEnabled && current === "disabled") {
          if (
            !deps.ownsLock(ctx) ||
            !hasBaleClassicRestoreFailure(botState)
          ) {
            return;
          }
          await applyBaleThreadCapability(
            ctx,
            false,
            "capability-monitor-disabled-confirmed",
            deps,
            isCurrent,
          );
          return;
        }
        if (
          !threadModeEnabled &&
          hasBaleThreadCapabilityBindings(deps.topicTargetStore)
        ) {
          consecutiveDisabledProbes += 1;
          if (
            consecutiveDisabledProbes <
            BALE_THREAD_CAPABILITY_DISABLED_CONFIRMATION_PROBES
          ) {
            deps.recordEvent("bus", "Bale Threaded Mode probe deferred", {
              phase: "capability-monitor-disabled",
              reason: "active-thread-bindings-present",
              consecutiveDisabledProbes,
            });
            return;
          }
        }
        await applyBaleThreadCapability(
          ctx,
          threadModeEnabled,
          threadModeEnabled
            ? "capability-monitor-enabled"
            : consecutiveDisabledProbes >=
                BALE_THREAD_CAPABILITY_DISABLED_CONFIRMATION_PROBES
              ? "capability-monitor-disabled-confirmed"
              : "capability-monitor-disabled",
          deps,
          isCurrent,
        );
      })
      .catch((error) => {
        if (!isCurrent()) return;
        capabilityFailureLog.record(error);
      })
      .finally(() => {
        if (transitionPromise === tracked) transitionPromise = undefined;
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
        if (generation !== expectedGeneration) return;
        try {
          check(ctx);
        } catch (error) {
          try {
            stop();
          } catch {
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
  constructor(message: string) {
    super(message);
    this.name = "BalePollingBatchValidationError";
  }
}

export class BalePollingCursorBootstrapError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BalePollingCursorBootstrapError";
  }
}

export interface BalePollingCursorCutoverDeps {
  getLegacyCursor: () => number | undefined;
  readJournal: () => {
    acceptedThroughUpdateId?: number;
    entries: readonly { updateId: number }[];
  };
  publishJournalCursor: (acceptedThroughUpdateId: number) => MaybePromise<void>;
  removeLegacyCursor: () => MaybePromise<void>;
}

/** Transfer one legacy config cursor into journal authority before deleting it. */
export async function cutOverBalePollingCursor(
  deps: BalePollingCursorCutoverDeps,
): Promise<void> {
  const legacyCursor = deps.getLegacyCursor();
  if (legacyCursor === undefined) return;
  const snapshot = deps.readJournal();
  if (snapshot.acceptedThroughUpdateId === undefined) {
    const provenEntryCursor = snapshot.entries.at(-1)?.updateId;
    await deps.publishJournalCursor(
      Math.max(legacyCursor, provenEntryCursor ?? legacyCursor),
    );
  }
  await deps.removeLegacyCursor();
}

export interface BalePollingBatchAdmissionResult {
  updateCount: number;
  latestUpdateId?: number;
}

export interface BalePollingBatchAdmissionDeps<
  TUpdate extends BaleUpdate,
> extends BaleRuntimeEventRecorderPort {
  updates: readonly TUpdate[];
  config: BalePollingConfig;
  appendBatch: (
    updates: readonly TUpdate[],
    acceptedThroughUpdateId?: number,
  ) => MaybePromise<unknown>;
  getAcceptedThroughUpdateId?: () => number | undefined;
  persistConfig: (config: BalePollingConfig) => Promise<void>;
  signalWorker: () => void;
  onPhaseChange?: (
    phase: BalePollingWorkPhase,
    currentUpdateId?: number,
  ) => void;
}

function validateBalePollingBatch(
  updates: readonly BaleUpdate[],
  lastUpdateId?: number,
): void {
  let previousUpdateId = lastUpdateId;
  for (const update of updates) {
    if (
      !Number.isSafeInteger(update.update_id) ||
      update.update_id < 0 ||
      (previousUpdateId !== undefined && update.update_id <= previousUpdateId)
    ) {
      throw new BalePollingBatchValidationError(
        `Bale getUpdates returned non-monotonic update id ${String(update.update_id)} after ${String(previousUpdateId)}`,
      );
    }
    previousUpdateId = update.update_id;
  }
}

export async function admitBalePollingUpdateBatch<
  TUpdate extends BaleUpdate,
>(
  deps: BalePollingBatchAdmissionDeps<TUpdate>,
): Promise<BalePollingBatchAdmissionResult> {
  if (deps.updates.length === 0) return { updateCount: 0 };
  const acceptedThroughUpdateId = deps.getAcceptedThroughUpdateId?.();
  validateBalePollingBatch(deps.updates, acceptedThroughUpdateId);
  const latestUpdateId = getLatestBaleUpdateId(deps.updates);
  if (latestUpdateId === undefined) return { updateCount: 0 };
  reportBalePollingPhase(
    deps,
    "persisting-journal",
    deps.updates[0]?.update_id,
  );
  await deps.appendBatch(deps.updates, latestUpdateId);
  try {
    deps.signalWorker();
  } catch (error) {
    deps.recordRuntimeEvent?.("polling", error, {
      phase: "worker-signal",
      updateCount: deps.updates.length,
      latestUpdateId,
    });
  }
  return { updateCount: deps.updates.length, latestUpdateId };
}

/** Bot API, journal and progress ports shared by one poll loop and its restartable runner. */
export interface BalePollLoopTransportPorts<
  TUpdate extends BaleUpdate,
> extends BaleRuntimeEventRecorderPort {
  deleteWebhook: (signal: AbortSignal) => Promise<unknown>;
  getUpdates: (
    body: Record<string, unknown>,
    signal: AbortSignal,
  ) => Promise<TUpdate[]>;
  getUpdatesRequestBudgetMs?: (body: Record<string, unknown>) => number;
  persistConfig: (config: BalePollingConfig) => Promise<void>;
  appendUpdateBatch: (
    updates: readonly TUpdate[],
    acceptedThroughUpdateId?: number,
  ) => MaybePromise<unknown>;
  getAcceptedThroughUpdateId?: () => number | undefined;
  getJournalEntryCount: () => number;
  signalUpdateWorker: () => void;
  onPhaseChange?: (
    phase: BalePollingWorkPhase,
    currentUpdateId?: number,
  ) => void;
  onSuccessfulResponse?: (updateCount: number) => void;
}

export interface BalePollLoopDeps<
  TUpdate extends BaleUpdate,
  TContext = unknown,
> extends BalePollLoopTransportPorts<TUpdate> {
  ctx: TContext;
  signal: AbortSignal;
  config: BalePollingConfig;
  onErrorStatus: (message: string) => void;
  onStatusReset: () => void;
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export interface BalePollLoopRunnerDeps<
  TUpdate extends BaleUpdate,
  TContext = unknown,
> extends BalePollLoopTransportPorts<TUpdate> {
  getConfig: () => BalePollingConfig;
  updateStatus: (ctx: TContext, message?: string) => void;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export function sleepBalePollingRetry(
  ms: number,
  signal?: AbortSignal,
): Promise<void> {
  if (ms <= 0 || signal?.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout>;
    const finish = () => {
      if (settled) return;
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
    if (signal?.aborted) onAbort();
  });
}

export function createBalePollLoopRunner<
  TUpdate extends BaleUpdate,
  TContext = unknown,
>(
  deps: BalePollLoopRunnerDeps<TUpdate, TContext>,
): (ctx: TContext, signal: AbortSignal) => Promise<void> {
  const sleep = deps.sleep ?? sleepBalePollingRetry;
  return (ctx, signal) =>
    runBalePollLoop({
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

function getBalePollingErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isBaleGetUpdatesConflictError(error: unknown): boolean {
  return getBalePollingErrorMessage(error).includes(
    "Conflict: terminated by other getUpdates request",
  );
}

function reportBalePollingPhase(
  deps: BaleRuntimeEventRecorderPort & {
    onPhaseChange?: (
      phase: BalePollingWorkPhase,
      currentUpdateId?: number,
    ) => void;
  },
  phase: BalePollingWorkPhase,
  currentUpdateId?: number,
): void {
  try {
    deps.onPhaseChange?.(phase, currentUpdateId);
  } catch (error) {
    deps.recordRuntimeEvent?.("polling", error, {
      phase: "phase-observer",
    });
  }
}

function reportBalePollingResponse<
  TUpdate extends BaleUpdate,
  TContext,
>(deps: BalePollLoopDeps<TUpdate, TContext>, updateCount: number): void {
  try {
    deps.onSuccessfulResponse?.(updateCount);
  } catch (error) {
    deps.recordRuntimeEvent?.("polling", error, {
      phase: "response-observer",
    });
  }
}

function getBalePollingAbortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("Aborted", "AbortError");
}

async function requestBaleUpdatesWithinBudget<
  TUpdate extends BaleUpdate,
  TContext,
>(
  deps: BalePollLoopDeps<TUpdate, TContext>,
  body: Record<string, unknown>,
): Promise<TUpdate[]> {
  if (deps.signal.aborted) throw getBalePollingAbortReason(deps.signal);
  const configuredBudgetMs = deps.getUpdatesRequestBudgetMs?.(body);
  const timeoutMs =
    typeof configuredBudgetMs === "number" &&
    Number.isFinite(configuredBudgetMs) &&
    configuredBudgetMs > 0
      ? Math.floor(configuredBudgetMs)
      : getBaleGetUpdatesRequestBudgetMs(body);
  const controller = new AbortController();
  const abortFromOwner = () => {
    controller.abort(getBalePollingAbortReason(deps.signal));
  };
  deps.signal.addEventListener("abort", abortFromOwner, { once: true });
  if (deps.signal.aborted) abortFromOwner();
  const timeout = setTimeout(() => {
    controller.abort(new BaleGetUpdatesTimeoutError(timeoutMs));
  }, timeoutMs);
  let onRequestAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onRequestAbort = () =>
      reject(getBalePollingAbortReason(controller.signal));
    controller.signal.addEventListener("abort", onRequestAbort, {
      once: true,
    });
    if (controller.signal.aborted) onRequestAbort();
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
  } finally {
    clearTimeout(timeout);
    deps.signal.removeEventListener("abort", abortFromOwner);
    if (onRequestAbort) {
      controller.signal.removeEventListener("abort", onRequestAbort);
    }
  }
}

export async function runBalePollLoop<
  TUpdate extends BaleUpdate,
  TContext = unknown,
>(deps: BalePollLoopDeps<TUpdate, TContext>): Promise<void> {
  if (!deps.config.botToken) return;
  let consecutiveGetUpdatesConflicts = 0;
  let consecutiveFailures = 0;
  const retryConflict = async () => {
    consecutiveGetUpdatesConflicts += 1;
    if (
      consecutiveGetUpdatesConflicts >= BALE_GET_UPDATES_CONFLICT_STOP_LIMIT
    ) {
      throw new BalePersistentGetUpdatesConflictError(
        consecutiveGetUpdatesConflicts,
      );
    }
    await deps.sleep(
      consecutiveGetUpdatesConflicts <
        BALE_GET_UPDATES_CONFLICT_FAST_RETRY_LIMIT
        ? BALE_GET_UPDATES_CONFLICT_FAST_RETRY_MS
        : BALE_GET_UPDATES_CONFLICT_SLOW_RETRY_MS,
      deps.signal,
    );
  };
  try {
    await deps.deleteWebhook(deps.signal);
  } catch {
    // ignore
  }
  if (
    deps.getAcceptedThroughUpdateId?.() === undefined &&
    deps.getJournalEntryCount() > 0
  ) {
    throw new BalePollingCursorBootstrapError(
      "Bale polling cursor is missing while the durable update journal is non-empty.",
    );
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
        deps.recordRuntimeEvent?.(
          "polling",
          new Error("Initialized Bale cursor without executing history."),
          { phase: "cursor-bootstrap", lastUpdateId },
        );
      }
    } catch (error) {
      if (shouldStopBalePolling(deps.signal.aborted, error)) return;
      reportBalePollingPhase(deps, "retrying");
      if (isBaleGetUpdatesConflictError(error)) {
        await retryConflict();
      } else
        deps.recordRuntimeEvent?.("polling", error, {
          phase: "initial-sync",
          ...(error instanceof BaleGetUpdatesTimeoutError
            ? { timeoutMs: error.timeoutMs }
            : {}),
        });
    }
  }
  let currentUpdateId: number | undefined;
  while (!deps.signal.aborted) {
    try {
      currentUpdateId = undefined;
      const request = buildBaleLongPollRequest(
        deps.getAcceptedThroughUpdateId?.(),
      );
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
    } catch (error) {
      if (shouldStopBalePolling(deps.signal.aborted, error)) return;
      reportBalePollingPhase(deps, "retrying", currentUpdateId);
      if (isBaleGetUpdatesConflictError(error)) {
        await retryConflict();
        continue;
      }
      deps.recordRuntimeEvent?.("polling", error, {
        phase:
          error instanceof BaleGetUpdatesTimeoutError
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
      await deps.sleep(
        getBalePollingRetryDelayMs(consecutiveFailures),
        deps.signal,
      );
      if (deps.signal.aborted) return;
      deps.onStatusReset();
    }
  }
}

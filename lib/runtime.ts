/**
 * Bale bridge runtime-state helpers
 * Zones: pi agent runtime state, bale session, shared coordination
 * Owns small session-local runtime primitives that are shared by orchestration but are not specific to queueing, rendering, polling, or Bale transport
 */

import * as Machine from "./machine.ts";

/**
 * Structural port for run-collapsing diagnostics: a repeated identical failure extends its run instead of logging
 * again, and the closing success records one outcome. The composition root owns the collapsed implementation.
 */
export interface BaleRepeatedFailureLogPort {
  record: (error: unknown, details?: Record<string, unknown>) => void;
  settled: () => void;
  reset: () => void;
}

const BALE_TYPING_ACTION_INTERVAL_MS = 3_000;
const BALE_TYPING_IDLE_DRAIN_MAX_MS = 250;

export interface BaleRuntimeQueueCounters {
  nextQueuedBaleItemOrder: number;
  nextQueuedBaleControlOrder: number;
}

export interface BaleRuntimeLifecycleFlags {
  activeBaleToolExecutions: number;
  baleTurnDispatchPending: boolean;
  compactionInProgress: boolean;
  foldQueuedPromptsIntoHistory: boolean;
  setupInProgress: boolean;
}

export interface BaleBridgeRuntimeState
  extends BaleRuntimeQueueCounters, BaleRuntimeLifecycleFlags {
  abortHandler?: () => void;
}

export interface BaleRuntimeQueuePort {
  syncCounters: (counters: Partial<BaleRuntimeQueueCounters>) => void;
  allocateItemOrder: () => number;
  allocateControlOrder: () => number;
}

export interface BaleRuntimeLifecyclePort {
  syncFlags: (flags: Partial<BaleRuntimeLifecycleFlags>) => void;
  getActiveToolExecutions: () => number;
  setActiveToolExecutions: (count: number) => void;
  resetActiveToolExecutions: () => void;
  hasDispatchPending: () => boolean;
  setDispatchPending: (pending: boolean) => void;
  clearDispatchPending: () => void;
  isCompactionInProgress: () => boolean;
  setCompactionInProgress: (inProgress: boolean) => void;
  shouldFoldQueuedPromptsIntoHistory: () => boolean;
  setFoldQueuedPromptsIntoHistory: (fold: boolean) => void;
}

export interface BaleRuntimeSetupPort {
  isInProgress: () => boolean;
  start: () => boolean;
  finish: () => void;
}

export interface BaleRuntimeAbortPort {
  hasHandler: () => boolean;
  setHandler: (abortHandler: () => void) => void;
  clearHandler: () => void;
  getHandler: () => (() => void) | undefined;
  abortTurn: () => boolean;
}

export interface BaleRuntimeTypingPort {
  start: (deps: BaleTypingLoopDeps) => boolean;
  stop: () => boolean;
  /** Waits for the in-flight action, bounded so a never-settling request cannot hold shutdown. */
  waitForIdle: (timeoutMs?: number) => Promise<void>;
}

export interface BaleBridgeRuntime {
  state: BaleBridgeRuntimeState;
  queue: BaleRuntimeQueuePort;
  lifecycle: BaleRuntimeLifecyclePort;
  setup: BaleRuntimeSetupPort;
  abort: BaleRuntimeAbortPort;
  typing: BaleRuntimeTypingPort;
}

export function createBaleBridgeRuntimeState(): BaleBridgeRuntimeState {
  return {
    nextQueuedBaleItemOrder: 0,
    nextQueuedBaleControlOrder: 0,
    activeBaleToolExecutions: 0,
    baleTurnDispatchPending: false,
    compactionInProgress: false,
    foldQueuedPromptsIntoHistory: false,
    setupInProgress: false,
  };
}

export function createBaleBridgeRuntime(
  state = createBaleBridgeRuntimeState(),
  typing = createBaleTypingLoop(),
): BaleBridgeRuntime {
  return {
    state,
    queue: {
      syncCounters: (counters) =>
        syncBaleQueueRuntimeCounters(state, counters),
      allocateItemOrder: () => allocateBaleQueueItemOrder(state),
      allocateControlOrder: () => allocateBaleQueueControlOrder(state),
    },
    lifecycle: {
      syncFlags: (flags) => syncBaleLifecycleRuntimeFlags(state, flags),
      getActiveToolExecutions: () => getActiveBaleToolExecutions(state),
      setActiveToolExecutions: (count) =>
        setActiveBaleToolExecutions(state, count),
      resetActiveToolExecutions: () => resetActiveBaleToolExecutions(state),
      hasDispatchPending: () => hasBaleDispatchPending(state),
      setDispatchPending: (pending) =>
        setBaleDispatchPending(state, pending),
      clearDispatchPending: () => clearBaleDispatchPending(state),
      isCompactionInProgress: () => isBaleCompactionInProgress(state),
      setCompactionInProgress: (inProgress) =>
        setBaleCompactionInProgress(state, inProgress),
      shouldFoldQueuedPromptsIntoHistory: () =>
        shouldFoldQueuedPromptsIntoHistory(state),
      setFoldQueuedPromptsIntoHistory: (fold) =>
        setFoldQueuedPromptsIntoHistory(state, fold),
    },
    setup: {
      isInProgress: () => isBaleSetupInProgress(state),
      start: () => startBaleSetup(state),
      finish: () => finishBaleSetup(state),
    },
    abort: {
      hasHandler: () => hasBaleAbortHandler(state),
      setHandler: (abortHandler) =>
        setBaleAbortHandler(state, abortHandler),
      clearHandler: () => clearBaleAbortHandler(state),
      getHandler: () => getBaleAbortHandler(state),
      abortTurn: () => abortBaleTurn(state),
    },
    typing,
  };
}

export function syncBaleQueueRuntimeCounters(
  state: BaleBridgeRuntimeState,
  counters: Partial<BaleRuntimeQueueCounters>,
): void {
  if (counters.nextQueuedBaleItemOrder !== undefined) {
    state.nextQueuedBaleItemOrder = counters.nextQueuedBaleItemOrder;
  }
  if (counters.nextQueuedBaleControlOrder !== undefined) {
    state.nextQueuedBaleControlOrder =
      counters.nextQueuedBaleControlOrder;
  }
}

export function allocateBaleQueueItemOrder(
  state: BaleBridgeRuntimeState,
): number {
  return state.nextQueuedBaleItemOrder++;
}

export function allocateBaleQueueControlOrder(
  state: BaleBridgeRuntimeState,
): number {
  return state.nextQueuedBaleControlOrder++;
}

export function syncBaleLifecycleRuntimeFlags(
  state: BaleBridgeRuntimeState,
  flags: Partial<BaleRuntimeLifecycleFlags>,
): void {
  if (flags.activeBaleToolExecutions !== undefined) {
    state.activeBaleToolExecutions = flags.activeBaleToolExecutions;
  }
  if (flags.baleTurnDispatchPending !== undefined) {
    state.baleTurnDispatchPending = flags.baleTurnDispatchPending;
  }
  if (flags.compactionInProgress !== undefined) {
    state.compactionInProgress = flags.compactionInProgress;
  }
  if (flags.foldQueuedPromptsIntoHistory !== undefined) {
    state.foldQueuedPromptsIntoHistory = flags.foldQueuedPromptsIntoHistory;
  }
  if (flags.setupInProgress !== undefined) {
    state.setupInProgress = flags.setupInProgress;
  }
}

export function getActiveBaleToolExecutions(
  state: BaleBridgeRuntimeState,
): number {
  return state.activeBaleToolExecutions;
}

export function setActiveBaleToolExecutions(
  state: BaleBridgeRuntimeState,
  count: number,
): void {
  state.activeBaleToolExecutions = count;
}

export function resetActiveBaleToolExecutions(
  state: BaleBridgeRuntimeState,
): void {
  state.activeBaleToolExecutions = 0;
}

export function hasBaleDispatchPending(
  state: BaleBridgeRuntimeState,
): boolean {
  return state.baleTurnDispatchPending;
}

function setBaleDispatchPending(
  state: BaleBridgeRuntimeState,
  pending: boolean,
): void {
  state.baleTurnDispatchPending = pending;
}

export function clearBaleDispatchPending(
  state: BaleBridgeRuntimeState,
): void {
  state.baleTurnDispatchPending = false;
}

export function isBaleCompactionInProgress(
  state: BaleBridgeRuntimeState,
): boolean {
  return state.compactionInProgress;
}

export function setBaleCompactionInProgress(
  state: BaleBridgeRuntimeState,
  inProgress: boolean,
): void {
  state.compactionInProgress = inProgress;
}

export function shouldFoldQueuedPromptsIntoHistory(
  state: BaleBridgeRuntimeState,
): boolean {
  return state.foldQueuedPromptsIntoHistory;
}

export function setFoldQueuedPromptsIntoHistory(
  state: BaleBridgeRuntimeState,
  fold: boolean,
): void {
  state.foldQueuedPromptsIntoHistory = fold;
}

export function isBaleSetupInProgress(
  state: BaleBridgeRuntimeState,
): boolean {
  return state.setupInProgress;
}

export function startBaleSetup(state: BaleBridgeRuntimeState): boolean {
  if (state.setupInProgress) return false;
  state.setupInProgress = true;
  return true;
}

export function finishBaleSetup(state: BaleBridgeRuntimeState): void {
  state.setupInProgress = false;
}

export function hasBaleAbortHandler(
  state: BaleBridgeRuntimeState,
): boolean {
  return !!state.abortHandler;
}

export function setBaleAbortHandler(
  state: BaleBridgeRuntimeState,
  abortHandler: () => void,
): void {
  state.abortHandler = abortHandler;
}

export function clearBaleAbortHandler(
  state: BaleBridgeRuntimeState,
): void {
  state.abortHandler = undefined;
}

export function getBaleAbortHandler(
  state: BaleBridgeRuntimeState,
): (() => void) | undefined {
  return state.abortHandler;
}

export function abortBaleTurn(state: BaleBridgeRuntimeState): boolean {
  if (!state.abortHandler) return false;
  state.abortHandler();
  return true;
}

export interface BaleTypingLoopTarget {
  chatId: number;
  threadId?: number;
}

export interface BaleTypingLoopDeps {
  chatId: number | undefined;
  target?: BaleTypingLoopTarget;
  intervalMs: number;
  sendTypingAction: (
    chatId: number,
    options?: { message_thread_id?: number },
  ) => Promise<unknown>;
  shouldContinue?: () => boolean;
  onStopped?: () => void;
}

export interface BaleRuntimeEventRecorderPort {
  recordRuntimeEvent?: (
    category: string,
    error: unknown,
    details?: Record<string, unknown>,
  ) => void;
}

function updateBaleRuntimeStatusSafely<TContext>(
  updateStatus: (ctx: TContext, error?: string) => void,
  ctx: TContext,
  options: {
    error?: string;
    category: string;
    phase: string;
    recordRuntimeEvent?: BaleRuntimeEventRecorderPort["recordRuntimeEvent"];
  },
): void {
  try {
    updateStatus(ctx, options.error);
  } catch (statusError) {
    try {
      options.recordRuntimeEvent?.(options.category, statusError, {
        phase: options.phase,
      });
    } catch {
      // Status diagnostics cannot escape an asynchronous runtime owner.
    }
  }
}

export interface BaleTypingLoopStarterDeps<
  TContext,
> extends BaleRuntimeEventRecorderPort {
  /** Collapses one sustained presence failure run; the caller supplies its owner. */
  failureLog: BaleRepeatedFailureLogPort;
  typing: BaleRuntimeTypingPort;
  getDefaultChatId: () => number | undefined;
  sendTypingAction: (
    chatId: number,
    options?: { message_thread_id?: number; assertAuthority?: () => void },
  ) => Promise<unknown>;
  updateStatus: (ctx: TContext, error?: string) => void;
  isContextActive?: (ctx: TContext) => boolean;
  getSessionGeneration?: () => number;
  isTransportAvailable?: () => boolean;
  isThreadedMode?: () => boolean;
  getTransportAuthority?: () => string | number | undefined;
  intervalMs?: number;
}

export function createBaleTypingLoopStarter<TContext>(
  deps: BaleTypingLoopStarterDeps<TContext>,
): (
  ctx: TContext,
  chatId?: number,
  options?: { target?: BaleTypingLoopTarget; ensure?: boolean },
) => boolean {
  let currentOwner: {
    ctx: TContext;
    sessionGeneration: number | undefined;
    transportAuthority: string | number | undefined;
    chatId: number;
    threadId: number | undefined;
    canContinue: () => boolean;
  } | undefined;
  // An unreachable transport repeats one identical presence failure every tick; the port collapses the run.
  // Running it through one guard keeps a faulty diagnostics port from escaping the in-flight action owner.
  const typingFailureLog: BaleRepeatedFailureLogPort = {
    record(error, details) {
      try {
        deps.failureLog.record(error, details);
      } catch {
        // Typing diagnostics cannot escape the in-flight action owner.
      }
    },
    settled() {
      try {
        deps.failureLog.settled();
      } catch {
        // A successful presence outranks its own diagnostic.
      }
    },
    reset() {
      try {
        deps.failureLog.reset();
      } catch {
        // Typing diagnostics cannot fail a loop stop.
      }
    },
  };
  return (ctx, chatId, options) => {
    const sessionGeneration = deps.getSessionGeneration?.();
    const transportAuthority = deps.getTransportAuthority?.();
    const isContextCurrent = (): boolean => deps.isContextActive?.(ctx) !== false &&
      (!deps.getSessionGeneration || Object.is(deps.getSessionGeneration(), sessionGeneration));
    const hasTransport = (): boolean =>
      deps.getTransportAuthority
        ? transportAuthority !== undefined &&
          Object.is(deps.getTransportAuthority(), transportAuthority)
        : deps.isTransportAvailable?.() !== false;
    const target = options?.target ? { ...options.target } : undefined;
    const canContinue = (): boolean => isContextCurrent() && hasTransport() &&
      (deps.isThreadedMode?.() !== true ||
        (target?.threadId !== undefined && Number.isSafeInteger(target.threadId) && target.threadId > 0));
    // Queue dispatch precedes agent_start: only an explicit destination permits Threaded presence, never chat fallback.
    if (!canContinue()) return false;
    const resolvedChatId = chatId ?? deps.getDefaultChatId();
    if (resolvedChatId === undefined || resolvedChatId === 0) return false;
    // Streaming updates ensure presence without revoking the same owner's pending HTTP/IPC action.
    // Explicit starts still replace the loop, including a new turn on the same session and Thread.
    if (options?.ensure && currentOwner?.canContinue() &&
      (deps.getSessionGeneration
        ? Object.is(currentOwner.sessionGeneration, sessionGeneration)
        : Object.is(currentOwner.ctx, ctx)) &&
      Object.is(currentOwner.transportAuthority, transportAuthority) &&
      currentOwner.chatId === resolvedChatId && currentOwner.threadId === target?.threadId) return false;
    const owner = { ctx, sessionGeneration, transportAuthority, chatId: resolvedChatId,
      threadId: target?.threadId, canContinue };
    currentOwner = owner;
    let active = true;
    return deps.typing.start({
      chatId: resolvedChatId,
      target,
      intervalMs: deps.intervalMs ?? BALE_TYPING_ACTION_INTERVAL_MS,
      sendTypingAction: async (targetChatId, actionOptions) => {
        if (!active) return;
        if (!canContinue()) {
          deps.typing.stop();
          return;
        }
        try {
          await deps.sendTypingAction(targetChatId, {
            ...actionOptions,
            // This stays process-local; adapters recheck it before HTTP/IPC issuance, not just loop ticks.
            assertAuthority() {
              if (!active || !canContinue()) throw new Error("Typing context authority changed.");
            },
          });
          typingFailureLog.settled();
        } catch (error) {
          if (!active) return;
          if (!canContinue()) {
            deps.typing.stop();
            return;
          }
          typingFailureLog.record(error, { chatId: targetChatId });
        }
      },
      shouldContinue: canContinue,
      onStopped: () => {
        active = false;
        typingFailureLog.reset();
        if (currentOwner === owner) currentOwner = undefined;
      },
    });
  };
}

function getBaleTypingLoopKey(deps: BaleTypingLoopDeps): string {
  const threadId = deps.target?.threadId;
  return `${deps.chatId ?? 0}:${Number.isInteger(threadId) ? threadId : "all"}`;
}

/** The whole typing-loop state; only `transitionBaleTypingLoop` produces a new one. */
export interface BaleTypingMachineState {
  /** The loop the interval serves; its callbacks live in the shell under `id`. A loop exists exactly while ticking. */
  readonly loop: {
    readonly id: number;
    readonly key: string;
    readonly chatId: number;
    readonly threadParams?: { readonly message_thread_id: number };
  } | null;
  /** The action in flight; a tick waits for it, and replacing or stopping the loop forgets it. */
  readonly inFlight: number | null;
  readonly nextSendId: number;
}

export type BaleTypingEvent =
  | {
      type: "started";
      /** Shell-assigned, so the shell can hold the caller's callbacks before effects run. */
      loopId: number;
      chatId: number | undefined;
      key: string;
      threadParams?: { message_thread_id: number };
      intervalMs: number;
      /** The caller's `shouldContinue`, sampled at dispatch. */
      continues: boolean;
    }
  | { type: "ticked"; continues: boolean }
  | { type: "sendSettled"; sendId: number }
  | { type: "stopRequested" };

export type BaleTypingEffect =
  | {
      type: "send";
      loopId: number;
      sendId: number;
      chatId: number;
      threadParams?: { message_thread_id: number };
    }
  | { type: "armInterval"; intervalMs: number }
  | { type: "cancelInterval" }
  | { type: "loopEnded"; loopId: number };

export interface BaleTypingStep extends Machine.BaleMachineStep<
  BaleTypingMachineState,
  BaleTypingEffect
> {
  /** `start`: a loop began or moved to a new target. `stop`: a running loop ended. */
  result: boolean;
}

export function createBaleTypingMachineState(): BaleTypingMachineState {
  return { loop: null, inFlight: null, nextSendId: 0 };
}

const typingStep = (
  state: BaleTypingMachineState,
  result: boolean,
  ...effects: BaleTypingEffect[]
): BaleTypingStep => ({ state, effects, result });

function stopTypingLoop(state: BaleTypingMachineState): BaleTypingStep {
  if (!state.loop) return typingStep(state, false);
  return typingStep(
    { ...state, loop: null, inFlight: null },
    true,
    { type: "cancelInterval" },
    { type: "loopEnded", loopId: state.loop.id },
  );
}

/** One action per tick, never two at once; a caller that stops continuing ends the loop instead. */
function sendTypingAction(
  state: BaleTypingMachineState,
  continues: boolean,
): BaleTypingStep {
  const loop = state.loop;
  if (!loop) return typingStep(state, false);
  if (!continues) return stopTypingLoop(state);
  if (state.inFlight !== null) return typingStep(state, false);
  const sendId = state.nextSendId + 1;
  return typingStep({ ...state, inFlight: sendId, nextSendId: sendId }, false, {
    type: "send",
    loopId: loop.id,
    sendId,
    chatId: loop.chatId,
    ...(loop.threadParams ? { threadParams: loop.threadParams } : {}),
  });
}

/**
 * Pure typing-loop transition. Every start replaces the caller's callbacks, even on the same target, and forgets the
 * old in-flight action; only a new target sends at once on a running loop, whose interval keeps its phase.
 */
export function transitionBaleTypingLoop(
  state: BaleTypingMachineState,
  event: BaleTypingEvent,
): BaleTypingStep {
  switch (event.type) {
    case "started": {
      if (event.chatId === undefined || event.chatId === 0)
        return typingStep(state, false);
      const previous = state.loop;
      const replaced: BaleTypingEffect[] = previous
        ? [{ type: "loopEnded", loopId: previous.id }]
        : [];
      const next: BaleTypingMachineState = {
        ...state,
        inFlight: previous ? null : state.inFlight,
        loop: {
          id: event.loopId,
          key: event.key,
          chatId: event.chatId,
          ...(event.threadParams ? { threadParams: event.threadParams } : {}),
        },
      };
      if (previous?.key === event.key)
        return typingStep(next, false, ...replaced);
      if (previous) {
        const sent = sendTypingAction(next, event.continues);
        return typingStep(sent.state, true, ...replaced, ...sent.effects);
      }
      // A fresh loop always arms its interval; a caller that already stopped continuing ends it on the first tick.
      const sent = event.continues
        ? sendTypingAction(next, true)
        : typingStep(next, false);
      return typingStep(sent.state, true, ...sent.effects, {
        type: "armInterval",
        intervalMs: event.intervalMs,
      });
    }
    case "ticked":
      return sendTypingAction(state, event.continues);
    case "sendSettled":
      return typingStep(
        state.inFlight === event.sendId ? { ...state, inFlight: null } : state,
        false,
      );
    case "stopRequested":
      return stopTypingLoop(state);
  }
}

/**
 * The shell around `transitionBaleTypingLoop`: it holds each loop's callbacks, samples `shouldContinue` into
 * events, owns the interval and turns every action outcome into `sendSettled`.
 */
export function createBaleTypingLoop(): BaleRuntimeTypingPort {
  const callbacks = new Map<number, BaleTypingLoopDeps>();
  let interval: ReturnType<typeof setInterval> | undefined;
  let loopIds = 0;
  const continues = (loopId: number | undefined): boolean =>
    loopId === undefined
      ? false
      : callbacks.get(loopId)?.shouldContinue?.() !== false;
  const machine = Machine.createBaleMachineRunner<
    BaleTypingMachineState,
    BaleTypingEvent,
    BaleTypingEffect,
    BaleTypingStep
  >({
    initial: createBaleTypingMachineState(),
    transition: transitionBaleTypingLoop,
    run(effect) {
      switch (effect.type) {
        case "send": {
          const send = callbacks.get(effect.loopId)?.sendTypingAction;
          // Failures belong to the caller's action; the loop only needs to know the action is over.
          void Promise.resolve()
            .then(() => send?.(effect.chatId, effect.threadParams))
            .then(
              () => undefined,
              () => undefined,
            )
            .then(() =>
              machine.dispatch({ type: "sendSettled", sendId: effect.sendId }),
            );
          return;
        }
        case "armInterval":
          interval = setInterval(
            () =>
              machine.dispatch({
                type: "ticked",
                continues: continues(machine.state.loop?.id),
              }),
            effect.intervalMs,
          );
          interval.unref?.();
          return;
        case "cancelInterval":
          clearInterval(interval);
          interval = undefined;
          return;
        case "loopEnded": {
          const ended = callbacks.get(effect.loopId);
          callbacks.delete(effect.loopId);
          ended?.onStopped?.();
          return;
        }
      }
    },
  });
  return {
    start(deps) {
      const loopId = ++loopIds;
      callbacks.set(loopId, deps);
      const threadId = deps.target?.threadId;
      const started = machine.dispatch({
        type: "started",
        loopId,
        chatId: deps.chatId,
        key: getBaleTypingLoopKey(deps),
        ...(Number.isInteger(threadId)
          ? { threadParams: { message_thread_id: threadId! } }
          : {}),
        intervalMs: deps.intervalMs,
        continues: continues(loopId),
      });
      if (machine.state.loop?.id !== loopId) callbacks.delete(loopId);
      return started.result;
    },
    stop: () => machine.dispatch({ type: "stopRequested" }).result,
    async waitForIdle(timeoutMs = BALE_TYPING_IDLE_DRAIN_MAX_MS) {
      if (machine.state.inFlight === null) return;
      const idle = machine.waitFor((state) => state.inFlight === null);
      await Promise.race([
        idle,
        timeoutMs <= 0
          ? Promise.resolve()
          : new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
      ]);
    },
  };
}

export function createBaleContextAbortHandlerSetter<
  TContext extends { abort: () => void },
>(
  abort: Pick<BaleRuntimeAbortPort, "setHandler">,
): (ctx: TContext) => void {
  return (ctx) => {
    abort.setHandler(() => ctx.abort());
  };
}

export interface BaleAgentEndResetDeps {
  abort: Pick<BaleRuntimeAbortPort, "clearHandler">;
  typing: Pick<BaleRuntimeTypingPort, "stop">;
  clearActiveTurn: () => void;
  resetToolExecutions: () => void;
  clearPendingModelSwitch: () => void;
  clearDispatchPending: () => void;
}

export function createBaleAgentEndResetter(
  deps: BaleAgentEndResetDeps,
): () => void {
  return () => {
    deps.abort.clearHandler();
    deps.typing.stop();
    deps.clearActiveTurn();
    deps.resetToolExecutions();
    deps.clearPendingModelSwitch();
    deps.clearDispatchPending();
  };
}

export interface BalePromptDispatchLifecycleDeps<
  TContext,
> extends BaleRuntimeEventRecorderPort {
  lifecycle: Pick<
    BaleRuntimeLifecyclePort,
    "setDispatchPending" | "clearDispatchPending"
  >;
  typing: Pick<BaleRuntimeTypingPort, "stop">;
  startTypingLoop: (
    ctx: TContext,
    chatId?: number,
    options?: { target?: BaleTypingLoopTarget },
  ) => boolean | void;
  updateStatus: (ctx: TContext, error?: string) => void;
}

export interface BalePromptDispatchRuntimeDeps<
  TContext,
> extends BaleTypingLoopStarterDeps<TContext> {
  lifecycle: BalePromptDispatchLifecycleDeps<TContext>["lifecycle"];
}

export interface BalePromptDispatchRuntime<TContext> {
  startTypingLoop: (
    ctx: TContext,
    chatId?: number,
    options?: { target?: BaleTypingLoopTarget; ensure?: boolean },
  ) => boolean | void;
  onPromptDispatchStart: (ctx: TContext, chatId?: number, target?: BaleTypingLoopTarget) => void;
  onPromptDispatchFailure: (ctx: TContext, message: string) => void;
}

export function createBalePromptDispatchRuntime<TContext>(
  deps: BalePromptDispatchRuntimeDeps<TContext>,
): BalePromptDispatchRuntime<TContext> {
  const startTypingLoop = createBaleTypingLoopStarter(deps);
  return {
    startTypingLoop,
    ...createBalePromptDispatchLifecycle({
      lifecycle: deps.lifecycle,
      typing: deps.typing,
      startTypingLoop,
      updateStatus: deps.updateStatus,
      recordRuntimeEvent: deps.recordRuntimeEvent,
    }),
  };
}

export function createBalePromptDispatchLifecycle<TContext>(
  deps: BalePromptDispatchLifecycleDeps<TContext>,
) {
  return {
    onPromptDispatchStart: (ctx: TContext, chatId?: number, target?: BaleTypingLoopTarget): void => {
      deps.lifecycle.setDispatchPending(true);
      deps.startTypingLoop(ctx, chatId, { target });
      updateBaleRuntimeStatusSafely(deps.updateStatus, ctx, {
        category: "dispatch",
        phase: "status-update",
        recordRuntimeEvent: deps.recordRuntimeEvent,
      });
    },
    onPromptDispatchFailure: (ctx: TContext, message: string): void => {
      deps.lifecycle.clearDispatchPending();
      deps.typing.stop();
      deps.recordRuntimeEvent?.("dispatch", new Error(message));
      updateBaleRuntimeStatusSafely(deps.updateStatus, ctx, {
        error: `dispatch failed: ${message}`,
        category: "dispatch",
        phase: "status-update",
        recordRuntimeEvent: deps.recordRuntimeEvent,
      });
    },
  };
}

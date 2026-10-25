/**
 * Bale activity lifecycle normalization and extension dispatch
 * Zones: pi agent lifecycle, extension API, operational delivery
 * Owns stable handler registration, evidence-based activity/source identity, assistant segment and reasoning normalization, ordered public-output projection, executed-tool and compaction events, isolated non-blocking queues, shutdown fencing, diagnostics, and fresh delivery contexts; excludes Pi hook wiring, Bale rendering implementation, raw transport clients, and consumer-extension behavior
 */

import {
  deleteBaleView,
  editBaleView,
  sendBaleChatAction,
  sendBaleView,
  type BaleDeliveryChatAction,
  type BaleDeliveryHandle,
  type BaleDeliveryResult,
  type BaleDeliveryScope,
  type BaleDeliveryTarget,
  type BaleDeliveryView,
} from "./delivery.ts";

const BALE_ACTIVITY_REGISTRY_KEY = "__piBaleActivityRegistry__";

export type BaleActivitySource =
  "bale" | "local" | "autonomous" | "unknown";

export type BaleActivityTarget = Readonly<BaleDeliveryTarget>;

export interface BaleActivityEnvelope {
  activityId: string;
  sequence: number;
  source: BaleActivitySource;
  target?: BaleActivityTarget;
  replyToMessageId?: number;
  timestamp: number;
}

export type BaleActivityPayload =
  | { type: "agent-start" }
  | {
      type: "assistant-text-delta";
      contentIndex: number;
      delta: string;
    }
  | {
      type: "assistant-segment";
      contentIndex: number;
      text: string;
      placement: "intermediate" | "final" | "terminal-partial";
    }
  | {
      type: "reasoning-delta";
      contentIndex: number;
      delta: string;
    }
  | {
      type: "reasoning-end";
      contentIndex: number;
      text: string;
    }
  | {
      type: "tool-start";
      toolCallId: string;
      toolName: string;
      args: unknown;
    }
  | {
      type: "tool-update";
      toolCallId: string;
      toolName: string;
      update: unknown;
    }
  | {
      type: "tool-end";
      toolCallId: string;
      toolName: string;
      result: unknown;
      isError: boolean;
    }
  | {
      type: "compaction-start";
      reason: "manual" | "threshold" | "overflow" | "unknown";
    }
  | {
      type: "compaction-end";
      reason: "manual" | "threshold" | "overflow" | "unknown";
    }
  | {
      type: "ui-prompt-start";
      kind: "select" | "confirm" | "input" | "editor" | "custom";
      title?: string;
    }
  | { type: "ui-prompt-end" }
  | { type: "agent-end" }
  | { type: "agent-settled" };

export type BaleActivityEvent = BaleActivityEnvelope &
  BaleActivityPayload;

export type BaleAssistantSegmentEvent = BaleActivityEnvelope &
  Extract<BaleActivityPayload, { type: "assistant-segment" }>;

export interface BaleActivityContext {
  activityId: string;
  sequence: number;
  source: BaleActivitySource;
  defaultScope: BaleDeliveryScope;
  send: (
    view: BaleDeliveryView,
    options?: {
      scope?: BaleDeliveryScope;
      replyToMessageId?: number;
    },
  ) => Promise<BaleDeliveryResult<BaleDeliveryHandle>>;
  edit: (
    handle: BaleDeliveryHandle,
    view: BaleDeliveryView,
  ) => Promise<BaleDeliveryResult<BaleDeliveryHandle>>;
  delete: (
    handle: BaleDeliveryHandle,
  ) => Promise<BaleDeliveryResult<void>>;
  chatAction: (
    action: BaleDeliveryChatAction,
    options?: { scope?: BaleDeliveryScope },
  ) => Promise<BaleDeliveryResult<void>>;
}

export interface BaleActivityHandlerRegistration {
  id: string;
  order?: number;
  handle: (
    event: BaleActivityEvent,
    ctx: BaleActivityContext,
  ) => void | Promise<void>;
}

interface RegisteredBaleActivityHandler extends BaleActivityHandlerRegistration {
  id: string;
  order: number;
}

interface BaleActivityRegistry {
  handlers: Map<string, RegisteredBaleActivityHandler>;
}

function getOrCreateBaleActivityRegistry(): BaleActivityRegistry {
  const globals = globalThis as Record<string, unknown>;
  const existing = globals[BALE_ACTIVITY_REGISTRY_KEY];
  if (
    existing &&
    typeof existing === "object" &&
    "handlers" in existing &&
    existing.handlers instanceof Map
  ) {
    return existing as BaleActivityRegistry;
  }
  const registry: BaleActivityRegistry = { handlers: new Map() };
  globals[BALE_ACTIVITY_REGISTRY_KEY] = registry;
  return registry;
}

export function registerBaleActivityHandler(
  registration: BaleActivityHandlerRegistration,
): () => void {
  const id = registration.id.trim();
  if (!id) throw new Error("Bale activity handler id is required.");
  const registry = getOrCreateBaleActivityRegistry();
  if (registry.handlers.has(id)) {
    throw new Error(`Bale activity handler is already registered: ${id}`);
  }
  const handler: RegisteredBaleActivityHandler = {
    ...registration,
    id,
    order: registration.order ?? 0,
  };
  registry.handlers.set(id, handler);
  return () => {
    if (registry.handlers.get(id) === handler) registry.handlers.delete(id);
  };
}

/** @internal */
export function clearBaleActivityHandlers(): void {
  getOrCreateBaleActivityRegistry().handlers.clear();
}

function getBaleActivityHandlers(): RegisteredBaleActivityHandler[] {
  return Array.from(
    getOrCreateBaleActivityRegistry().handlers.values(),
  ).sort(function (left, right) {
    return left.order - right.order || left.id.localeCompare(right.id);
  });
}

function cloneActivityTarget(
  target: BaleActivityTarget,
): BaleActivityTarget {
  return Object.freeze(
    target.threadId === undefined
      ? { chatId: target.chatId }
      : { chatId: target.chatId, threadId: target.threadId },
  );
}

function createBaleActivityContext(
  event: BaleActivityEvent,
  isActive: () => boolean,
): BaleActivityContext {
  const defaultScope: BaleDeliveryScope = event.target
    ? { kind: "target", target: cloneActivityTarget(event.target) }
    : event.source === "bale"
      ? { kind: "active-turn" }
      : { kind: "instance" };
  const inactive = <T>(): Promise<BaleDeliveryResult<T>> =>
    Promise.resolve({
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
      if (!isActive()) return inactive();
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
      if (!isActive()) return inactive();
      return sendBaleChatAction(action, {
        scope: options?.scope ?? defaultScope,
      });
    },
  };
}

interface BaleActivityHandlerQueue {
  notifyDrained?: () => void;
  registration: RegisteredBaleActivityHandler;
  events: BaleActivityEvent[];
  running: boolean;
  active: boolean;
}

function canCoalesceActivityEvents(
  previous: BaleActivityEvent,
  next: BaleActivityEvent,
): boolean {
  if (previous.activityId !== next.activityId || previous.type !== next.type) {
    return false;
  }
  if (
    previous.type === "assistant-text-delta" &&
    next.type === "assistant-text-delta"
  ) {
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

function coalesceActivityEvents(
  previous: BaleActivityEvent,
  next: BaleActivityEvent,
): BaleActivityEvent {
  if (
    previous.type === "assistant-text-delta" &&
    next.type === "assistant-text-delta"
  ) {
    return { ...next, delta: previous.delta + next.delta };
  }
  if (previous.type === "reasoning-delta" && next.type === "reasoning-delta") {
    return { ...next, delta: previous.delta + next.delta };
  }
  return next;
}

/** Optional observation must not change queue/transport settlement. */
function captureActivityDrainObserver(capture?: () => (() => void) | undefined): () => void {
  try {
    const notify = capture?.();
    return () => {
      try {
        const emitted: unknown = notify?.();
        if (emitted) void Promise.resolve(emitted).catch(() => undefined);
      } catch { /* Observer failure is inert. */ }
    };
  } catch { return () => {}; }
}

/** @internal */
export interface BaleActivityDispatcher {
  hasPending?: () => boolean;
  dispatch: (event: BaleActivityEvent) => void;
  stop: () => void;
}

/** @internal */
export function createBaleActivityDispatcher(
  deps: {
    captureDrain?: () => (() => void) | undefined;
    recordFailure?: (
      handlerId: string,
      event: BaleActivityEvent,
      error: unknown,
    ) => void;
  } = {},
): BaleActivityDispatcher {
  const queues = new Map<string, BaleActivityHandlerQueue>();
  let stopped = false;
  const hasPending = () => Array.from(queues.values()).some(queue => queue.active && (queue.running || queue.events.length > 0));
  const drain = async (queue: BaleActivityHandlerQueue): Promise<void> => {
    if (queue.running || !queue.active) return;
    queue.running = true;
    try {
      while (queue.active) {
        const event = queue.events.shift();
        if (!event) break;
        if (
          getOrCreateBaleActivityRegistry().handlers.get(
            queue.registration.id,
          ) !== queue.registration
        ) {
          queue.active = false;
          queue.events = [];
          break;
        }
        try {
          await queue.registration.handle(
            event,
            createBaleActivityContext(
              event,
              () =>
                queue.active &&
                !stopped &&
                getOrCreateBaleActivityRegistry().handlers.get(
                  queue.registration.id,
                ) === queue.registration,
            ),
          );
        } catch (error) {
          deps.recordFailure?.(queue.registration.id, event, error);
        }
      }
    } finally {
      queue.running = false;
      if (!stopped && !hasPending()) queue.notifyDrained?.();
    }
  };
  return {
    hasPending,
    dispatch(event) {
      if (stopped) return;
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
          queue.events[queue.events.length - 1] = coalesceActivityEvents(
            previous,
            event,
          );
        } else {
          queue.events.push(event);
        }
        queueMicrotask(function () {
          void drain(queue!);
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
export function createBaleActivityBridgeRuntime(deps: {
  generation: string;
  captureDrain?: () => (() => void) | undefined;
  observeEvent?: (event: BaleActivityEvent) => void;
  recordFailure?: (
    handlerId: string,
    event: BaleActivityEvent,
    error: unknown,
  ) => void;
  now?: () => number;
}): BaleActivityRuntime {
  let generationSequence = 0;
  let runtime: BaleActivityRuntime | undefined;
  const getRuntime = (): BaleActivityRuntime | undefined => runtime;
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
          ? (event, error) =>
              deps.recordFailure!("@llblab/pi-bale/proactive", event, error)
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

export type BaleActivityInputSource =
  "interactive" | "rpc" | "extension" | "unknown";

export type BaleAssistantStreamEvent =
  | { type: "start" }
  | { type: "text_start"; contentIndex: number }
  | { type: "text_delta"; contentIndex: number; delta: string }
  | { type: "text_end"; contentIndex: number; content: string }
  | { type: "thinking_delta"; contentIndex: number; delta: string }
  | { type: "thinking_end"; contentIndex: number; content: string }
  | { type: "thinking_start"; contentIndex: number }
  | { type: "toolcall_start"; contentIndex: number }
  | { type: "toolcall_delta"; contentIndex: number; delta: string }
  | { type: "toolcall_end"; contentIndex: number }
  | { type: "done" }
  | { type: "error" };

/** @internal */
export interface BaleActivityRuntime {
  hasPending?: () => boolean | undefined;
  onSessionStart?: () => void;
  recordInputSource: (source: BaleActivityInputSource) => void;
  onAgentStart: (
    activeBaleTarget?: BaleActivityTarget,
    replyToMessageId?: number,
  ) => void;
  onAssistantEvent: (event: BaleAssistantStreamEvent) => void;
  onAssistantMessageEnd: (stopReason?: string) => void;
  onToolStart: (event: {
    toolCallId: string;
    toolName: string;
    args: unknown;
  }) => void;
  onToolUpdate: (event: {
    toolCallId: string;
    toolName: string;
    update: unknown;
  }) => void;
  onToolEnd: (event: {
    toolCallId: string;
    toolName: string;
    result: unknown;
    isError: boolean;
  }) => void;
  onCompactionStart: (
    reason: "manual" | "threshold" | "overflow" | "unknown",
  ) => void;
  onCompactionEnd: (
    reason: "manual" | "threshold" | "overflow" | "unknown",
  ) => void;
  onCompactionAbandoned: () => void;
  onUiPromptStart: (
    kind: "select" | "confirm" | "input" | "editor" | "custom",
    title?: string,
  ) => void;
  onUiPromptEnd: () => void;
  onAgentEnd: () => void;
  onAgentSettled: () => void;
  onSessionShutdown: () => void;
}

interface PendingAssistantSegment {
  contentIndex: number;
  text: string;
}

/** @internal */
export function createBaleActivityRuntime(deps: {
  generation: string;
  dispatcher: BaleActivityDispatcher;
  observeEvent?: (event: BaleActivityEvent) => void;
  recordObserverFailure?: (
    event: BaleActivityEvent,
    error: unknown,
  ) => void;
  now?: () => number;
}): BaleActivityRuntime {
  const now = deps.now ?? Date.now;
  let nextActivityNumber = 0;
  let activityId: string | undefined;
  let activitySource: BaleActivitySource = "unknown";
  let activityTarget: BaleActivityTarget | undefined;
  let activityReplyToMessageId: number | undefined;
  let sequence = 0;
  let pendingInputSource: BaleActivityInputSource = "unknown";
  let pendingAssistantSegment: PendingAssistantSegment | undefined;
  let compactionInProgress = false;
  let compactionOwnedActivity = false;
  let uiPromptInProgress = false;
  const ensureActivity = (
    activeBaleTarget?: BaleActivityTarget,
  ): string => {
    if (activityId) return activityId;
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
  const emit = (event: BaleActivityPayload): void => {
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
    } as BaleActivityEvent;
    try {
      deps.observeEvent?.(normalizedEvent);
    } catch (error) {
      deps.recordObserverFailure?.(normalizedEvent, error);
    }
    deps.dispatcher.dispatch(normalizedEvent);
  };
  const flushPendingSegment = (
    placement: "intermediate" | "final" | "terminal-partial",
  ): void => {
    const segment = pendingAssistantSegment;
    pendingAssistantSegment = undefined;
    if (!segment?.text.trim()) return;
    emit({
      type: "assistant-segment",
      contentIndex: segment.contentIndex,
      text: segment.text,
      placement,
    });
  };
  const clearActivity = (): void => {
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
  const abandonCompaction = (): void => {
    if (!compactionInProgress) return;
    const shouldClearActivity = compactionOwnedActivity;
    compactionInProgress = false;
    compactionOwnedActivity = false;
    if (shouldClearActivity) clearActivity();
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
        if (!event.delta) return;
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
        if (!event.delta) return;
        emit({
          type: "reasoning-delta",
          contentIndex: event.contentIndex,
          delta: event.delta,
        });
        return;
      }
      if (event.type === "thinking_end") {
        if (!event.content.trim()) return;
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
      if (event.type === "error") flushPendingSegment("terminal-partial");
    },
    onAssistantMessageEnd(stopReason) {
      if (stopReason === "aborted") pendingAssistantSegment = undefined;
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
      if (!compactionInProgress || !activityId) return;
      const shouldClearActivity = compactionOwnedActivity;
      compactionInProgress = false;
      compactionOwnedActivity = false;
      emit({ type: "compaction-end", reason });
      if (shouldClearActivity) clearActivity();
    },
    onCompactionAbandoned() {
      abandonCompaction();
    },
    onUiPromptStart(kind, title) {
      if (!activityId || uiPromptInProgress) return;
      uiPromptInProgress = true;
      emit({ type: "ui-prompt-start", kind, title });
    },
    onUiPromptEnd() {
      if (!activityId || !uiPromptInProgress) return;
      uiPromptInProgress = false;
      emit({ type: "ui-prompt-end" });
    },
    onAgentEnd() {
      if (activityId) emit({ type: "agent-end" });
    },
    onAgentSettled() {
      if (!activityId) return;
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

// --- Ordered Bridge-Owned Publication ---

export interface BaleActivityPublicationReservation {
  publish: (task: () => Promise<void>) => Promise<void>;
  cancel: () => void;
}

export interface BaleActivityPublicationWork {
  settle(outcome: "settled" | "unconfirmed"): void;
}

export interface BaleActivityPublicationRuntime {
  enqueue: (task: () => Promise<void>) => Promise<void>;
  reserve: () => BaleActivityPublicationReservation;
  hasPending: () => boolean;
  /** Observation only; detached work never occupies the ordered publication tail. */
  beginWork: () => BaleActivityPublicationWork;
  hasUnconfirmed: () => boolean;
  reset: () => void;
}

export function createBaleActivityPublicationRuntime(deps: {
  captureDrain?: () => (() => void) | undefined;
} = {}): BaleActivityPublicationRuntime {
  let generation = 0;
  let tail = Promise.resolve();
  let outstanding = 0,
    unconfirmed = false;
  const pending = new Set<() => void>();
  const reserve = (): BaleActivityPublicationReservation => {
    const admittedGeneration = generation;
    const notifyDrained = captureActivityDrainObserver(deps.captureDrain);
    let state: "pending" | "published" | "cancelled" = "pending";
    let resolve!: (task: (() => Promise<void>) | undefined) => void;
    const ready = new Promise<(() => Promise<void>) | undefined>((accept) => {
      resolve = accept;
    });
    const cancel = () => {
      if (state !== "pending") return;
      state = "cancelled";
      pending.delete(cancel);
      resolve(undefined);
    };
    pending.add(cancel);
    outstanding += 1;
    const result = tail
      .then(async () => {
        const task = await ready;
        if (admittedGeneration === generation && task) await task();
      })
      .finally(() => {
        outstanding -= 1;
        if (admittedGeneration === generation && outstanding === 0 && !unconfirmed) notifyDrained();
      });
    tail = result.catch(() => {});
    return {
      publish(task) {
        if (state === "cancelled") return result;
        if (state === "published")
          return Promise.reject(
            new Error("Publication reservation already published."),
          );
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
          if (settled) return;
          settled = true;
          outstanding -= 1;
          if (outcome === "unconfirmed" && admittedGeneration === generation)
            unconfirmed = true;
          if (admittedGeneration === generation && outstanding === 0 && !unconfirmed) notifyDrained();
        },
      };
    },
    reset() {
      generation += 1;
      unconfirmed = false;
      for (const cancel of pending) cancel();
      tail = Promise.resolve();
    },
  };
}

// --- Public Assistant Output Projection ---

export interface BaleAssistantOutputRuntime {
  start: () => void;
  beginTurn: () => void;
  accept: (event: BaleAssistantSegmentEvent) => void;
  hasAdmittedBaleIntermediate: (text: string) => boolean;
  waitForIdle: () => Promise<void>;
  stop: () => void;
}

export interface BaleAssistantOutputPreparation {
  wait: () => Promise<void>;
  settle: () => void;
}

export function createBaleAssistantOutputRuntime<
  TAuthority = undefined,
>(deps: {
  prepareSend?: (
    event: BaleAssistantSegmentEvent,
  ) => BaleAssistantOutputPreparation | undefined;
  enqueue?: BaleActivityPublicationRuntime["enqueue"];
  captureAuthority?: () => TAuthority;
  isAuthorityActive?: (authority: TAuthority) => boolean;
  canDeliver: (event: BaleAssistantSegmentEvent) => boolean;
  send: (
    event: BaleAssistantSegmentEvent,
    authority: TAuthority,
    isAuthorityActive: () => boolean,
  ) => Promise<void>;
  recordFailure?: (
    event: BaleAssistantSegmentEvent,
    error: unknown,
  ) => void;
}): BaleAssistantOutputRuntime {
  let generation = 0;
  let running = false;
  let tail: Promise<void> = Promise.resolve();
  const admitted = new Set<string>();
  const admittedBaleIntermediateText = new Set<string>();
  const isEligibleEvent = (event: BaleAssistantSegmentEvent): boolean =>
    (event.source === "bale" && event.placement === "intermediate") ||
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
      if (!running || !isEligibleEvent(event) || !event.text.trim()) return;
      const key = `${event.activityId}:${event.sequence}`;
      if (admitted.has(key)) return;
      admitted.add(key);
      if (event.source === "bale" && event.placement === "intermediate") {
        admittedBaleIntermediateText.add(event.text.trim());
      }
      const admittedGeneration = generation;
      const admittedAuthority = deps.captureAuthority?.();
      const preparation = deps.prepareSend?.(event);
      const enqueue =
        deps.enqueue ?? ((task: () => Promise<void>) => tail.then(task));
      tail = enqueue(async () => {
        const isAdmittedAuthorityActive = () =>
          running &&
          generation === admittedGeneration &&
          isEligibleEvent(event) &&
          (deps.isAuthorityActive === undefined ||
            deps.isAuthorityActive(admittedAuthority as TAuthority));
        if (!isAdmittedAuthorityActive() || !deps.canDeliver(event)) return;
        try {
          if (preparation) await preparation.wait();
          if (!isAdmittedAuthorityActive() || !deps.canDeliver(event)) return;
          await deps.send(
            event,
            admittedAuthority as TAuthority,
            isAdmittedAuthorityActive,
          );
        } catch (error) {
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

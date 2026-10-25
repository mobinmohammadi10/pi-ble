/**
 * Bale preview streaming helpers
 * Zones: bale outbound, native rich markdown drafts
 * Owns safe draft preview selection, runtime updates, and preview finalization
 * The streaming state machine is a pure transition function driven by one imperative shell per runtime.
 */

import type { BaleAssistantOutputPreparation } from "./activity.ts";
import * as Machine from "./machine.ts";
import { stripBaleCommentMarkupForPreview } from "./outbound-markup.ts";
import {
  isBaleMarkdownFenceClosing,
  normalizeBaleNativeMarkdown,
  parseBaleMarkdownFenceOpening,
  type BaleMarkdownFence,
} from "./replies.ts";
import {
  getBaleTargetThreadParams,
  type BaleTarget,
} from "./target.ts";
import { shouldSuppressPreviewForVoice } from "./voice.ts";

const BALE_DRAFT_ID_MAX = 2_147_483_647;
const BALE_DRAFT_PREVIEW_MAX_CHARS = 4096;
// Native draft cadence: at most one frame per interval, and a fresh preview
// segment holds its first frame for one full interval so the opening frame is
// an accumulated passage rather than a single streamed word.
const BALE_DRAFT_INTERVAL_MS = 2_000;

export interface BalePreviewState {
  mode: "draft";
  draftId?: number;
  pendingText: string;
  lastSentText: string;
}

/** One immutable preview segment; a replacement segment gets a new id, so late results for an old one are dropped. */
export interface BalePreviewSegment extends Readonly<BalePreviewState> {
  readonly id: number;
  readonly sealed: boolean;
}

export type BalePreviewReplyMarkup = unknown;

type BaleDraftSender = (
  chatId: number,
  draftId: number,
  text?: string,
  options?: {
    parse_mode?: string;
    entities?: unknown[];
    message_thread_id?: number;
  },
) => Promise<unknown>;

type BalePreviewEventRecorder = (
  category: string,
  error: unknown,
  details?: Record<string, unknown>,
) => void;

export interface BalePreviewActiveTurn {
  chatId: number;
  replyToMessageId?: number;
  target?: BaleTarget;
  voiceReplyPreferred?: boolean;
  voiceReplyRequired?: boolean;
  guestQueryId?: string;
}

export interface BaleAssistantMessagePreviewHookEvent<TMessage> {
  message: TMessage;
}

export interface BaleAssistantMessagePreviewHooks<TMessage> {
  onMessageStart: (
    event: BaleAssistantMessagePreviewHookEvent<TMessage>,
  ) => Promise<void>;
  onMessageUpdate: (
    event: BaleAssistantMessagePreviewHookEvent<TMessage>,
  ) => Promise<void>;
}

export interface BalePreviewControllerDeps {
  getDefaultReplyToMessageId?: () => number | undefined;
  maxMessageLength?: number;
  sendDraft: BaleDraftSender;
  canSend?: () => boolean;
  maxDraftId?: number;
  /** Throttle between draft frames; defaults to the native draft cadence. */
  minDraftIntervalMs?: number;
  recordRuntimeEvent?: BalePreviewEventRecorder;
}

type BalePreviewTargetOptions = { target?: BaleTarget };

export interface BalePreviewController {
  /** Read-only view of the current segment; it never grants mutation. */
  getState: () => BalePreviewSegment | undefined;
  /** True while a draft request is in flight or a pending request waits behind a publication. */
  isFlushing: () => boolean;
  seal: () => void;
  preparePublication: () => BaleAssistantOutputPreparation | undefined;
  prepareClear: (
    chatId: number,
    options?: BalePreviewTargetOptions & {
      isDeliveryActive?: () => boolean;
    },
  ) => () => Promise<void>;
  setPendingText: (text: string) => void;
  resetState: () => void;
  invalidate: () => void;
  clear: (
    chatId: number,
    options?: BalePreviewTargetOptions & { awaitFlush?: boolean },
  ) => Promise<void>;
  flush: (
    chatId: number,
    options?: BalePreviewTargetOptions,
  ) => Promise<void>;
  scheduleFlush: (
    chatId: number,
    options?: BalePreviewTargetOptions,
  ) => void;
  finalize: (
    chatId: number,
    replyToMessageId?: number,
    options?: BalePreviewTargetOptions,
  ) => Promise<boolean>;
}

export interface BaleAssistantPreviewRuntimeDeps<
  TMessage,
  TReplyMarkup = BalePreviewReplyMarkup,
> extends BalePreviewControllerDeps {
  getActiveTurn: () => BalePreviewActiveTurn | undefined;
  isAssistantMessage: (message: TMessage) => boolean;
  getMessageText: (message: TMessage) => string;
  sendMarkdownReply: (
    chatId: number,
    replyToMessageId: number | undefined,
    markdown: string,
    options?: { replyMarkup?: TReplyMarkup; target?: BaleTarget },
  ) => Promise<number | undefined>;
}

type BaleMarkdownFinalizer<TReplyMarkup> = (
  chatId: number,
  markdown: string,
  replyToMessageId?: number,
  options?: { replyMarkup?: TReplyMarkup; target?: BaleTarget },
) => Promise<boolean>;

export interface BalePreparedPreviewDelivery<TReplyMarkup = unknown> {
  clearPreview: BalePreviewController["clear"];
  setPreviewPendingText: BalePreviewController["setPendingText"];
  finalizeMarkdownPreview: BaleMarkdownFinalizer<TReplyMarkup>;
}

export type BaleAssistantPreviewRuntime<
  TMessage,
  TReplyMarkup = BalePreviewReplyMarkup,
> = BalePreviewController &
  BaleAssistantMessagePreviewHooks<TMessage> & {
    prepareDelivery: (
      isDeliveryActive: () => boolean,
    ) => BalePreparedPreviewDelivery<TReplyMarkup>;
    finalizeMarkdown: BaleMarkdownFinalizer<TReplyMarkup>;
  };

interface BalePreviewFlushRequest {
  chatId: number;
  target?: BaleTarget;
}

interface BalePreviewMachineConfig {
  maxDraftId: number;
  maxMessageLength: number;
  minDraftIntervalMs: number;
}

/** The whole preview state; only `transitionBalePreview` produces a new one. */
export interface BalePreviewMachineState {
  readonly segment: BalePreviewSegment | null;
  /** Bumped by reset and invalidation; a result issued under an older generation is inert. */
  readonly generation: number;
  readonly nextSegmentId: number;
  readonly nextDraftId: number;
  readonly nextDraftAt: number;
  /** Segment that owns the current generation's issued draft; old-generation requests do not block it. */
  readonly inFlight: number | null;
  /** The one coalesced flush request waiting behind an in-flight draft or an open publication. */
  readonly pending: BalePreviewFlushRequest | null;
  readonly publications: readonly number[];
  /** The segment the throttle timer is armed for; the timer belongs to that segment alone. */
  readonly timerSegmentId: number | null;
}

/** Impure inputs the runner samples at dispatch time, so transitions stay pure. */
interface BalePreviewClock {
  now: number;
  canSend: boolean;
}

export type BalePreviewEvent =
  | { type: "reset" }
  | { type: "invalidated" }
  | { type: "segmentStarted" }
  | { type: "segmentEnsured" }
  | { type: "sealed" }
  | { type: "discarded" }
  | { type: "textSet"; text: string }
  | { type: "draftWindowOpened"; at: number }
  | ({
      type: "flushRequested";
      request: BalePreviewFlushRequest;
    } & BalePreviewClock)
  | ({
      type: "timerFired";
      request: BalePreviewFlushRequest;
      segmentId: number;
    } & BalePreviewClock)
  | ({
      type: "draftSettled";
      segmentId: number;
      generation: number;
      /** Present only when Bale accepted the draft. */
      text?: string;
    } & BalePreviewClock)
  | { type: "publicationOpened"; id: number }
  | ({ type: "publicationSettled"; id: number } & BalePreviewClock);

export type BalePreviewEffect =
  | {
      type: "sendDraft";
      request: BalePreviewFlushRequest;
      draftId: number;
      text: string;
      segmentId: number;
      generation: number;
    }
  | {
      type: "armTimer";
      delay: number;
      request: BalePreviewFlushRequest;
      segmentId: number;
    }
  | { type: "cancelTimer" }
  | { type: "clearClosedGate"; request: BalePreviewFlushRequest };

export interface BalePreviewStep {
  state: BalePreviewMachineState;
  effects: readonly BalePreviewEffect[];
}

export function createBalePreviewMachineState(): BalePreviewMachineState {
  return {
    segment: null,
    generation: 0,
    nextSegmentId: 0,
    nextDraftId: 0,
    nextDraftAt: 0,
    inFlight: null,
    pending: null,
    publications: [],
    timerSegmentId: null,
  };
}

const step = (
  state: BalePreviewMachineState,
  ...effects: BalePreviewEffect[]
): BalePreviewStep => ({ state, effects });

/** Drops the armed throttle timer, if any; every caller replaces or seals its segment. */
const withoutTimer = (
  state: BalePreviewMachineState,
): BalePreviewStep =>
  state.timerSegmentId === null
    ? step(state)
    : step({ ...state, timerSegmentId: null }, { type: "cancelTimer" });

/** A replaced segment takes its pending request and its throttle timer with it. */
function replaceSegment(
  state: BalePreviewMachineState,
  segment: BalePreviewSegment | null,
): BalePreviewStep {
  return withoutTimer({ ...state, segment, pending: null });
}

function startSegment(
  state: BalePreviewMachineState,
  carry: Partial<BalePreviewState> = {},
): BalePreviewStep {
  const id = state.nextSegmentId + 1;
  return replaceSegment(
    { ...state, nextSegmentId: id },
    {
      id,
      mode: "draft",
      pendingText: "",
      lastSentText: "",
      sealed: false,
      ...carry,
    },
  );
}

/** One flush attempt for the current segment: gate, throttle, safe snapshot and draft id. */
function attemptFlush(
  state: BalePreviewMachineState,
  request: BalePreviewFlushRequest,
  clock: BalePreviewClock,
  config: BalePreviewMachineConfig,
): BalePreviewStep {
  const segment = state.segment;
  if (!segment || segment.sealed) return step(state);
  if (!clock.canSend) return step(state, { type: "clearClosedGate", request });
  const delay = state.nextDraftAt - clock.now;
  if (delay > 0) {
    if (state.timerSegmentId !== null) return step(state);
    return step(
      { ...state, timerSegmentId: segment.id },
      { type: "armTimer", delay, request, segmentId: segment.id },
    );
  }
  const idle = withoutTimer(state);
  const snapshot = buildBaleNativeMarkdownPreviewSnapshot(
    segment,
    config.maxMessageLength,
  );
  if (!snapshot) return idle;
  const draftId =
    segment.draftId ??
    allocateBaleDraftId(state.nextDraftId, config.maxDraftId);
  return {
    state: {
      ...idle.state,
      segment: { ...segment, draftId },
      nextDraftId: segment.draftId === undefined ? draftId : state.nextDraftId,
      nextDraftAt: clock.now + config.minDraftIntervalMs,
      inFlight: segment.id,
    },
    effects: [
      ...idle.effects,
      {
        type: "sendDraft",
        request,
        draftId,
        text: snapshot.text,
        segmentId: segment.id,
        generation: state.generation,
      },
    ],
  };
}

/** Single flight: a request during an in-flight draft or behind a publication waits as the one pending request. */
function requestFlush(
  state: BalePreviewMachineState,
  request: BalePreviewFlushRequest,
  clock: BalePreviewClock,
  config: BalePreviewMachineConfig,
): BalePreviewStep {
  // Only a live, unsealed segment accepts flush requests, whatever the caller checked.
  if (!state.segment || state.segment.sealed) return step(state);
  if (state.inFlight !== null || state.publications.length > 0)
    return step({ ...state, pending: request });
  return attemptFlush(state, request, clock, config);
}

/** A coalesced request runs once the in-flight draft and every open publication have settled. */
function drainPending(
  state: BalePreviewMachineState,
  clock: BalePreviewClock,
  config: BalePreviewMachineConfig,
): BalePreviewStep {
  const request = state.pending;
  if (!request || state.inFlight !== null || state.publications.length > 0)
    return step(state);
  return attemptFlush({ ...state, pending: null }, request, clock, config);
}

export function transitionBalePreview(
  state: BalePreviewMachineState,
  event: BalePreviewEvent,
  config: BalePreviewMachineConfig,
): BalePreviewStep {
  switch (event.type) {
    case "reset":
    case "invalidated": {
      const replacement = {
        ...state,
        generation: state.generation + 1,
        inFlight: null,
        publications: [],
        nextDraftAt: 0,
      };
      return event.type === "reset"
        ? startSegment(replacement)
        : replaceSegment(replacement, null);
    }
    case "segmentStarted": {
      // Carry the previous delivery boundary; permanent text remains with its publication owner.
      const draftId = state.segment?.draftId;
      return startSegment(state, draftId === undefined ? {} : { draftId });
    }
    case "segmentEnsured":
      return state.segment ? step(state) : startSegment(state);
    case "sealed": {
      const segment = state.segment;
      return withoutTimer({
        ...state,
        segment:
          segment && !segment.sealed ? { ...segment, sealed: true } : segment,
        pending: null,
      });
    }
    case "discarded":
      return replaceSegment(state, null);
    case "textSet":
      return state.segment
        ? step({
            ...state,
            segment: { ...state.segment, pendingText: event.text },
          })
        : step(state);
    case "draftWindowOpened":
      return step({
        ...state,
        nextDraftAt: Math.max(state.nextDraftAt, event.at),
      });
    case "flushRequested":
      return requestFlush(state, event.request, event, config);
    case "timerFired": {
      if (
        state.timerSegmentId !== event.segmentId ||
        state.segment?.id !== event.segmentId
      )
        return step(state);
      return requestFlush(
        { ...state, timerSegmentId: null },
        event.request,
        event,
        config,
      );
    }
    case "draftSettled": {
      if (
        state.generation !== event.generation ||
        state.inFlight !== event.segmentId
      )
        return step(state);
      const segment = state.segment;
      // A delivered draft updates only the segment and generation that issued it.
      const applies =
        event.text !== undefined &&
        segment?.id === event.segmentId &&
        event.canSend;
      return drainPending(
        {
          ...state,
          inFlight: null,
          segment:
            applies && segment
              ? { ...segment, lastSentText: event.text! }
              : segment,
        },
        event,
        config,
      );
    }
    case "publicationOpened":
      return step({
        ...state,
        publications: [...state.publications, event.id],
      });
    case "publicationSettled":
      if (!state.publications.includes(event.id)) return step(state);
      return drainPending(
        {
          ...state,
          publications: state.publications.filter((id) => id !== event.id),
        },
        event,
        config,
      );
  }
}

/** True while a draft request is in flight, or, when publications block, a pending request waits behind one. */
export function isBalePreviewBusy(
  state: BalePreviewMachineState,
  blockedByPublication = true,
): boolean {
  return (
    state.inFlight !== null ||
    (blockedByPublication &&
      state.pending !== null &&
      state.publications.length > 0)
  );
}

/**
 * The imperative shell around `transitionBalePreview`: it samples the clock and send gate into events, runs
 * effects, records every transport failure in one place and resolves promise-shaped ports through `waitFor`.
 */
function createBalePreviewModel(deps: BalePreviewControllerDeps) {
  const config: BalePreviewMachineConfig = {
    maxDraftId: deps.maxDraftId ?? BALE_DRAFT_ID_MAX,
    maxMessageLength: deps.maxMessageLength ?? BALE_DRAFT_PREVIEW_MAX_CHARS,
    minDraftIntervalMs: deps.minDraftIntervalMs ?? BALE_DRAFT_INTERVAL_MS,
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  let publicationIds = 0;
  const clock = (): BalePreviewClock => ({
    now: Date.now(),
    canSend: deps.canSend?.() !== false,
  });
  const machine = Machine.createBaleMachineRunner<
    BalePreviewMachineState,
    BalePreviewEvent,
    BalePreviewEffect
  >({
    initial: createBalePreviewMachineState(),
    transition: (state, event) =>
      transitionBalePreview(state, event, config),
    run: (effect) => run(effect),
  });
  const { dispatch, waitFor } = machine;
  const whenIdle = (): Promise<void> => {
    const generation = machine.state.generation;
    return waitFor(
      (current) =>
        current.generation !== generation || !isBalePreviewBusy(current),
    );
  };
  /** Captures predecessors only: a later draft/publication must never extend the boundary that blocks it. */
  const whenBoundarySettles = (includePublications = true): Promise<void> => {
    const { generation, inFlight, publications } = machine.state;
    return waitFor(
      (current) =>
        current.generation !== generation ||
        ((inFlight === null || current.inFlight !== inFlight) &&
          (!includePublications ||
            publications.every((id) => !current.publications.includes(id)))),
    );
  };
  const canSendFor = (generation: number): boolean =>
    machine.state.generation === generation && deps.canSend?.() !== false;

  /** The one place preview transport failures become diagnostics; a failed call reports `false`. */
  const callTransport = async (
    phase: "draft" | "clear-draft",
    request: BalePreviewFlushRequest,
    draftId: number,
    text: string | undefined,
  ): Promise<unknown> => {
    try {
      return await deps.sendDraft(request.chatId, draftId, text, {
        ...getBaleTargetThreadParams(
          request.target ?? { chatId: request.chatId },
        ),
      });
    } catch (error) {
      deps.recordRuntimeEvent?.("preview", error, {
        phase,
        chatId: request.chatId,
        draftId,
      });
      return false;
    }
  };
  const sendDraft = async (
    effect: Extract<BalePreviewEffect, { type: "sendDraft" }>,
  ): Promise<void> => {
    const delivered = await callTransport(
      "draft",
      effect.request,
      effect.draftId,
      normalizeBaleNativeMarkdown(effect.text),
    );
    dispatch({
      type: "draftSettled",
      segmentId: effect.segmentId,
      generation: effect.generation,
      ...(delivered === false ? {} : { text: effect.text }),
      ...clock(),
    });
  };
  const run = (effect: BalePreviewEffect): void => {
    switch (effect.type) {
      case "sendDraft":
        void sendDraft(effect);
        return;
      case "armTimer":
        timer = setTimeout(() => {
          timer = undefined;
          dispatch({
            type: "timerFired",
            request: effect.request,
            segmentId: effect.segmentId,
            ...clock(),
          });
        }, effect.delay);
        timer.unref?.();
        return;
      case "cancelTimer":
        if (timer) clearTimeout(timer);
        timer = undefined;
        return;
      case "clearClosedGate":
        void clear(effect.request.chatId, {
          awaitFlush: false,
          target: effect.request.target,
        });
        return;
    }
  };

  const seal = (): void => {
    dispatch({ type: "sealed" });
  };

  const clear = async (
    chatId: number,
    options: BalePreviewTargetOptions & {
      awaitFlush?: boolean;
      isDeliveryActive?: () => boolean;
    } = {},
    generation = machine.state.generation,
  ): Promise<void> => {
    const segment = machine.state.segment;
    if (!segment || options.isDeliveryActive?.() === false) return;
    seal();
    if (machine.state.inFlight !== null && options.awaitFlush !== false) {
      await whenBoundarySettles(false);
      if (machine.state.segment?.id !== segment.id) return;
    }
    if (options.isDeliveryActive?.() === false) return;
    const issued = machine.state.segment ?? segment;
    dispatch({ type: "discarded" });
    if (issued.draftId !== undefined && canSendFor(generation))
      await callTransport(
        "clear-draft",
        { chatId, target: options.target },
        issued.draftId,
        undefined,
      );
  };

  const flush = async (
    chatId: number,
    options: BalePreviewTargetOptions = {},
  ): Promise<void> => {
    if (!machine.state.segment || machine.state.segment.sealed) return;
    dispatch({
      type: "flushRequested",
      request: { chatId, target: options.target },
      ...clock(),
    });
    await whenIdle();
  };

  const prepareFinalizer = <TReplyMarkup>(input: {
    sendMarkdownReply: BaleAssistantPreviewRuntimeDeps<
      unknown,
      TReplyMarkup
    >["sendMarkdownReply"];
    isDeliveryActive?: () => boolean;
  }): BaleMarkdownFinalizer<TReplyMarkup> => {
    const segmentId = machine.state.segment?.id;
    const generation = machine.state.generation;
    seal();
    const predecessors = whenBoundarySettles();
    return async (chatId, markdown, replyToMessageId, options) => {
      if (input.isDeliveryActive?.() === false) return false;
      await predecessors;
      if (
        machine.state.generation !== generation ||
        machine.state.segment?.id !== segmentId ||
        input.isDeliveryActive?.() === false
      )
        return false;
      await input.sendMarkdownReply(
        chatId,
        replyToMessageId,
        markdown,
        options,
      );
      if (
        machine.state.segment?.id === segmentId &&
        input.isDeliveryActive?.() !== false
      )
        dispatch({ type: "discarded" });
      return true;
    };
  };

  const controller: BalePreviewController = {
    getState: () => machine.state.segment ?? undefined,
    isFlushing: () => isBalePreviewBusy(machine.state),
    seal,
    setPendingText: (text) => dispatch({ type: "textSet", text }),
    resetState: () => dispatch({ type: "reset" }),
    invalidate: () => dispatch({ type: "invalidated" }),
    preparePublication: () => {
      if (!machine.state.segment) return undefined;
      seal();
      const id = (publicationIds += 1);
      const prior = whenBoundarySettles();
      dispatch({ type: "publicationOpened", id });
      let settled = false;
      return {
        wait: () => prior,
        settle: () => {
          if (settled) return;
          settled = true;
          dispatch({ type: "publicationSettled", id, ...clock() });
        },
      };
    },
    prepareClear: (chatId, options) => {
      const admitted = machine.state.segment?.id;
      const generation = machine.state.generation;
      return async () => {
        if (machine.state.segment?.id !== admitted) return;
        await clear(
          chatId,
          {
            ...options,
            isDeliveryActive: () =>
              canSendFor(generation) && options?.isDeliveryActive?.() !== false,
          },
          generation,
        );
      };
    },
    clear: (chatId, options) => clear(chatId, options),
    flush,
    scheduleFlush: (chatId, options) => {
      if (!machine.state.segment) return;
      void flush(chatId, options);
    },
    finalize: async (chatId, _replyToMessageId, options) => {
      const segment = machine.state.segment;
      if (!segment) return false;
      if (!canSendFor(machine.state.generation)) {
        await clear(chatId, options);
        return false;
      }
      await flush(chatId, options);
      const current = machine.state.segment;
      if (current?.id !== segment.id) return false;
      const finalText = buildBalePreviewFinalText(current);
      if (!finalText) {
        await clear(chatId, options);
        return false;
      }
      dispatch({ type: "discarded" });
      return false;
    },
  };
  return {
    controller,
    prepareFinalizer,
    startSegment: (): void => {
      dispatch({ type: "segmentStarted" });
    },
    ensureSegment: (): BalePreviewSegment => {
      dispatch({ type: "segmentEnsured" });
      return machine.state.segment!;
    },
    openDraftWindow: (at: number): void => {
      dispatch({ type: "draftWindowOpened", at });
    },
    discard: (): void => {
      dispatch({ type: "discarded" });
    },
  };
}

export function createBalePreviewController(
  deps: BalePreviewControllerDeps,
): BalePreviewController {
  return createBalePreviewModel(deps).controller;
}

/**
 * Returns true when the active turn is a Bale Guest Mode query. A guest
 * query allows exactly one answer within a limited Bale response window,
 * so it must never emit streaming draft previews.
 */
export function shouldSuppressPreviewForGuestTurn(
  turn: { guestQueryId?: string } | null | undefined,
): boolean {
  return !!turn?.guestQueryId;
}

export function createBaleAssistantPreviewRuntime<
  TMessage,
  TReplyMarkup = BalePreviewReplyMarkup,
>(
  deps: BaleAssistantPreviewRuntimeDeps<TMessage, TReplyMarkup>,
): BaleAssistantPreviewRuntime<TMessage, TReplyMarkup> {
  const model = createBalePreviewModel(deps);
  const { controller } = model;
  const suppressed = (turn: BalePreviewActiveTurn): boolean =>
    shouldSuppressPreviewForVoice(turn) ||
    shouldSuppressPreviewForGuestTurn(turn);
  return {
    ...controller,
    finalizeMarkdown: (...args) =>
      model.prepareFinalizer<TReplyMarkup>({
        sendMarkdownReply: deps.sendMarkdownReply,
      })(...args),
    prepareDelivery(isDeliveryActive) {
      const admitted = controller.getState()?.id;
      return {
        setPreviewPendingText(text) {
          if (controller.getState()?.id === admitted && isDeliveryActive())
            controller.setPendingText(text);
        },
        clearPreview: async (chatId, options) => {
          if (controller.getState()?.id !== admitted || !isDeliveryActive())
            return;
          await controller.prepareClear(chatId, {
            ...options,
            isDeliveryActive,
          })();
        },
        finalizeMarkdownPreview: model.prepareFinalizer<TReplyMarkup>({
          sendMarkdownReply: deps.sendMarkdownReply,
          isDeliveryActive,
        }),
      };
    },
    onMessageStart: async ({ message }) => {
      const turn = deps.getActiveTurn();
      if (!turn || !deps.isAssistantMessage(message)) return;
      if ((deps.canSend && !deps.canSend()) || suppressed(turn)) {
        model.discard();
        return;
      }
      model.startSegment();
    },
    onMessageUpdate: async ({ message }) => {
      const turn = deps.getActiveTurn();
      if (!turn || !deps.isAssistantMessage(message)) return;
      if (deps.canSend && !deps.canSend()) {
        model.discard();
        return;
      }
      if (suppressed(turn)) return;
      const segment = model.ensureSegment();
      if (segment.sealed) return;
      const hadVisibleText = segment.pendingText.length > 0;
      const pendingText = stripBaleCommentMarkupForPreview(
        deps.getMessageText(message),
      );
      controller.setPendingText(pendingText);
      // The first visible text of a preview segment opens an initial accumulation
      // window, so the segment's first frame cannot ship as a single word even
      // when the previous cadence boundary has already passed (fresh turn, slow
      // first token, or message rollover after tool work). Later deltas keep the
      // trailing deadline instead of sliding it on every update.
      const interval = deps.minDraftIntervalMs ?? BALE_DRAFT_INTERVAL_MS;
      if (
        interval > 0 &&
        !hadVisibleText &&
        !segment.lastSentText &&
        pendingText.length > 0
      )
        model.openDraftWindow(Date.now() + interval);
      controller.scheduleFlush(turn.chatId, { target: turn.target });
    },
  };
}

export function buildBalePreviewFinalText(
  state: BalePreviewState,
): string | undefined {
  const finalText = state.pendingText.trim();
  if (finalText) return finalText;
  return state.lastSentText.trim() || undefined;
}

export function allocateBaleDraftId(
  currentDraftId: number,
  maxDraftId: number,
): number {
  return currentDraftId >= maxDraftId ? 1 : currentDraftId + 1;
}

interface BaleDraftInlineState {
  codeTicks: number;
  htmlComment: boolean;
  displayMath: boolean;
  fence?: BaleMarkdownFence;
  strongAsterisk: boolean;
  emphasisAsterisk: boolean;
  strongUnderscore: boolean;
  emphasisUnderscore: boolean;
  strike: boolean;
  linkText: boolean;
  linkDestination: boolean;
}

function createBaleDraftInlineState(): BaleDraftInlineState {
  return {
    codeTicks: 0,
    htmlComment: false,
    displayMath: false,
    strongAsterisk: false,
    emphasisAsterisk: false,
    strongUnderscore: false,
    emphasisUnderscore: false,
    strike: false,
    linkText: false,
    linkDestination: false,
  };
}

function isBaleDraftInlineStateClosed(
  state: BaleDraftInlineState,
): boolean {
  return (
    state.codeTicks === 0 &&
    !state.htmlComment &&
    !state.displayMath &&
    !state.fence &&
    !state.strongAsterisk &&
    !state.emphasisAsterisk &&
    !state.strongUnderscore &&
    !state.emphasisUnderscore &&
    !state.strike &&
    !state.linkText &&
    !state.linkDestination
  );
}

function countRepeatedChars(text: string, index: number, char: string): number {
  let count = 0;
  while (text[index + count] === char) count += 1;
  return count;
}

function isEscapedMarkdownChar(text: string, index: number): boolean {
  let slashCount = 0;
  for (
    let cursor = index - 1;
    cursor >= 0 && text[cursor] === "\\";
    cursor -= 1
  ) {
    slashCount += 1;
  }
  return slashCount % 2 === 1;
}

function isInlineDelimiterCandidate(
  text: string,
  index: number,
  length: number,
): boolean {
  const previous = text[index - 1] ?? "";
  const next = text[index + length] ?? "";
  if (!next || /\s/.test(next))
    return previous.length > 0 && !/\s/.test(previous);
  if (!previous || /\s/.test(previous)) return true;
  return /[\p{P}\p{S}]/u.test(previous) || /[\p{P}\p{S}]/u.test(next);
}

function updateBaleDraftInlineStateForLine(
  line: string,
  state: BaleDraftInlineState,
): void {
  if (state.fence || state.displayMath) return;
  for (let index = 0; index < line.length; index += 1) {
    if (state.htmlComment) {
      const closeIndex = line.indexOf("-->", index);
      if (closeIndex === -1) return;
      state.htmlComment = false;
      index = closeIndex + 2;
      continue;
    }
    if (state.codeTicks > 0) {
      const ticks = countRepeatedChars(line, index, "`");
      if (ticks >= state.codeTicks) {
        state.codeTicks = 0;
        index += ticks - 1;
      }
      continue;
    }
    if (isEscapedMarkdownChar(line, index)) continue;
    if (line.startsWith("<!--", index)) {
      const closeIndex = line.indexOf("-->", index + 4);
      if (closeIndex === -1) {
        state.htmlComment = true;
        return;
      }
      index = closeIndex + 2;
      continue;
    }
    const ticks = countRepeatedChars(line, index, "`");
    if (ticks > 0) {
      state.codeTicks = ticks;
      index += ticks - 1;
      continue;
    }
    if (line.startsWith("][", index) || line.startsWith("](", index)) {
      state.linkText = false;
      state.linkDestination = true;
      index += 1;
      continue;
    }
    if (line[index] === "[" && !state.linkDestination) {
      state.linkText = true;
      continue;
    }
    if (line[index] === ")" && state.linkDestination) {
      state.linkDestination = false;
      continue;
    }
    if (
      line.startsWith("~~", index) &&
      isInlineDelimiterCandidate(line, index, 2)
    ) {
      state.strike = !state.strike;
      index += 1;
      continue;
    }
    if (
      line.startsWith("**", index) &&
      isInlineDelimiterCandidate(line, index, 2)
    ) {
      state.strongAsterisk = !state.strongAsterisk;
      index += 1;
      continue;
    }
    if (line[index] === "*" && isInlineDelimiterCandidate(line, index, 1)) {
      state.emphasisAsterisk = !state.emphasisAsterisk;
      continue;
    }
    if (
      line.startsWith("__", index) &&
      isInlineDelimiterCandidate(line, index, 2)
    ) {
      state.strongUnderscore = !state.strongUnderscore;
      index += 1;
      continue;
    }
    if (line[index] === "_" && isInlineDelimiterCandidate(line, index, 1)) {
      state.emphasisUnderscore = !state.emphasisUnderscore;
    }
  }
}

function updateBaleDraftBlockStateForLine(
  line: string,
  state: BaleDraftInlineState,
): boolean {
  if (state.fence) {
    if (isBaleMarkdownFenceClosing(line, state.fence)) {
      state.fence = undefined;
    }
    return true;
  }
  if (state.displayMath) {
    if (line.trim() === "$$") state.displayMath = false;
    return true;
  }
  const openingFence = parseBaleMarkdownFenceOpening(line);
  if (openingFence) {
    state.fence = openingFence;
    return true;
  }
  if (line.trim() === "$$") {
    state.displayMath = true;
    return true;
  }
  return false;
}

function findSafeBaleRichMarkdownDraftEnd(markdown: string): number {
  const state = createBaleDraftInlineState();
  let offset = 0;
  let safeEnd = 0;
  for (const line of markdown.split("\n")) {
    const lineEnd = offset + line.length;
    const consumedAsBlock = updateBaleDraftBlockStateForLine(line, state);
    if (!consumedAsBlock) updateBaleDraftInlineStateForLine(line, state);
    const nextOffset = lineEnd + 1;
    if (isBaleDraftInlineStateClosed(state)) safeEnd = lineEnd;
    offset = nextOffset;
  }
  if (isBaleDraftInlineStateClosed(state)) return markdown.length;
  return safeEnd;
}

function hasBalePreviewVisibleContent(markdown: string): boolean {
  return /[\p{L}\p{N}]/u.test(markdown);
}

export function getSafeBaleRichMarkdownDraftPrefix(
  markdown: string,
  maxMessageLength: number,
): string | undefined {
  const source = markdown.trim();
  if (!source) return undefined;
  const limited =
    source.length > maxMessageLength
      ? source.slice(0, maxMessageLength)
      : source;
  const safeEnd = findSafeBaleRichMarkdownDraftEnd(limited);
  if (safeEnd > 0) {
    const safePrefix = limited.slice(0, safeEnd).trimEnd();
    return hasBalePreviewVisibleContent(safePrefix)
      ? safePrefix
      : undefined;
  }
  let candidateEnd = limited.length;
  while (candidateEnd > 0) {
    candidateEnd = limited.lastIndexOf(" ", candidateEnd - 1);
    if (candidateEnd <= 0) return undefined;
    const candidate = limited.slice(0, candidateEnd).trimEnd();
    if (
      hasBalePreviewVisibleContent(candidate) &&
      findSafeBaleRichMarkdownDraftEnd(candidate) === candidate.length
    ) {
      return candidate || undefined;
    }
  }
  return undefined;
}

function buildBaleNativeMarkdownPreviewSnapshot(
  state: BalePreviewState,
  maxMessageLength: number,
): { text: string } | undefined {
  const safeText = getSafeBaleRichMarkdownDraftPrefix(
    state.pendingText,
    maxMessageLength,
  );
  if (!safeText || safeText === state.lastSentText) return undefined;
  return { text: safeText };
}

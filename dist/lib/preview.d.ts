/**
 * Bale preview streaming helpers
 * Zones: bale outbound, native rich markdown drafts
 * Owns safe draft preview selection, runtime updates, and preview finalization
 * The streaming state machine is a pure transition function driven by one imperative shell per runtime.
 */
import type { BaleAssistantOutputPreparation } from "./activity.ts";
import { type BaleTarget } from "./target.ts";
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
type BaleDraftSender = (chatId: number, draftId: number, text?: string, options?: {
    parse_mode?: string;
    entities?: unknown[];
    message_thread_id?: number;
}) => Promise<unknown>;
type BalePreviewEventRecorder = (category: string, error: unknown, details?: Record<string, unknown>) => void;
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
    onMessageStart: (event: BaleAssistantMessagePreviewHookEvent<TMessage>) => Promise<void>;
    onMessageUpdate: (event: BaleAssistantMessagePreviewHookEvent<TMessage>) => Promise<void>;
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
type BalePreviewTargetOptions = {
    target?: BaleTarget;
};
export interface BalePreviewController {
    /** Read-only view of the current segment; it never grants mutation. */
    getState: () => BalePreviewSegment | undefined;
    /** True while a draft request is in flight or a pending request waits behind a publication. */
    isFlushing: () => boolean;
    seal: () => void;
    preparePublication: () => BaleAssistantOutputPreparation | undefined;
    prepareClear: (chatId: number, options?: BalePreviewTargetOptions & {
        isDeliveryActive?: () => boolean;
    }) => () => Promise<void>;
    setPendingText: (text: string) => void;
    resetState: () => void;
    invalidate: () => void;
    clear: (chatId: number, options?: BalePreviewTargetOptions & {
        awaitFlush?: boolean;
    }) => Promise<void>;
    flush: (chatId: number, options?: BalePreviewTargetOptions) => Promise<void>;
    scheduleFlush: (chatId: number, options?: BalePreviewTargetOptions) => void;
    finalize: (chatId: number, replyToMessageId?: number, options?: BalePreviewTargetOptions) => Promise<boolean>;
}
export interface BaleAssistantPreviewRuntimeDeps<TMessage, TReplyMarkup = BalePreviewReplyMarkup> extends BalePreviewControllerDeps {
    getActiveTurn: () => BalePreviewActiveTurn | undefined;
    isAssistantMessage: (message: TMessage) => boolean;
    getMessageText: (message: TMessage) => string;
    sendMarkdownReply: (chatId: number, replyToMessageId: number | undefined, markdown: string, options?: {
        replyMarkup?: TReplyMarkup;
        target?: BaleTarget;
    }) => Promise<number | undefined>;
}
type BaleMarkdownFinalizer<TReplyMarkup> = (chatId: number, markdown: string, replyToMessageId?: number, options?: {
    replyMarkup?: TReplyMarkup;
    target?: BaleTarget;
}) => Promise<boolean>;
export interface BalePreparedPreviewDelivery<TReplyMarkup = unknown> {
    clearPreview: BalePreviewController["clear"];
    setPreviewPendingText: BalePreviewController["setPendingText"];
    finalizeMarkdownPreview: BaleMarkdownFinalizer<TReplyMarkup>;
}
export type BaleAssistantPreviewRuntime<TMessage, TReplyMarkup = BalePreviewReplyMarkup> = BalePreviewController & BaleAssistantMessagePreviewHooks<TMessage> & {
    prepareDelivery: (isDeliveryActive: () => boolean) => BalePreparedPreviewDelivery<TReplyMarkup>;
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
export type BalePreviewEvent = {
    type: "reset";
} | {
    type: "invalidated";
} | {
    type: "segmentStarted";
} | {
    type: "segmentEnsured";
} | {
    type: "sealed";
} | {
    type: "discarded";
} | {
    type: "textSet";
    text: string;
} | {
    type: "draftWindowOpened";
    at: number;
} | ({
    type: "flushRequested";
    request: BalePreviewFlushRequest;
} & BalePreviewClock) | ({
    type: "timerFired";
    request: BalePreviewFlushRequest;
    segmentId: number;
} & BalePreviewClock) | ({
    type: "draftSettled";
    segmentId: number;
    generation: number;
    /** Present only when Bale accepted the draft. */
    text?: string;
} & BalePreviewClock) | {
    type: "publicationOpened";
    id: number;
} | ({
    type: "publicationSettled";
    id: number;
} & BalePreviewClock);
export type BalePreviewEffect = {
    type: "sendDraft";
    request: BalePreviewFlushRequest;
    draftId: number;
    text: string;
    segmentId: number;
    generation: number;
} | {
    type: "armTimer";
    delay: number;
    request: BalePreviewFlushRequest;
    segmentId: number;
} | {
    type: "cancelTimer";
} | {
    type: "clearClosedGate";
    request: BalePreviewFlushRequest;
};
export interface BalePreviewStep {
    state: BalePreviewMachineState;
    effects: readonly BalePreviewEffect[];
}
export declare function createBalePreviewMachineState(): BalePreviewMachineState;
export declare function transitionBalePreview(state: BalePreviewMachineState, event: BalePreviewEvent, config: BalePreviewMachineConfig): BalePreviewStep;
/** True while a draft request is in flight, or, when publications block, a pending request waits behind one. */
export declare function isBalePreviewBusy(state: BalePreviewMachineState, blockedByPublication?: boolean): boolean;
export declare function createBalePreviewController(deps: BalePreviewControllerDeps): BalePreviewController;
/**
 * Returns true when the active turn is a Bale Guest Mode query. A guest
 * query allows exactly one answer within a limited Bale response window,
 * so it must never emit streaming draft previews.
 */
export declare function shouldSuppressPreviewForGuestTurn(turn: {
    guestQueryId?: string;
} | null | undefined): boolean;
export declare function createBaleAssistantPreviewRuntime<TMessage, TReplyMarkup = BalePreviewReplyMarkup>(deps: BaleAssistantPreviewRuntimeDeps<TMessage, TReplyMarkup>): BaleAssistantPreviewRuntime<TMessage, TReplyMarkup>;
export declare function buildBalePreviewFinalText(state: BalePreviewState): string | undefined;
export declare function allocateBaleDraftId(currentDraftId: number, maxDraftId: number): number;
export declare function getSafeBaleRichMarkdownDraftPrefix(markdown: string, maxMessageLength: number): string | undefined;
export {};

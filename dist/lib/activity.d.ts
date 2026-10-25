/**
 * Bale activity lifecycle normalization and extension dispatch
 * Zones: pi agent lifecycle, extension API, operational delivery
 * Owns stable handler registration, evidence-based activity/source identity, assistant segment and reasoning normalization, ordered public-output projection, executed-tool and compaction events, isolated non-blocking queues, shutdown fencing, diagnostics, and fresh delivery contexts; excludes Pi hook wiring, Bale rendering implementation, raw transport clients, and consumer-extension behavior
 */
import { type BaleDeliveryChatAction, type BaleDeliveryHandle, type BaleDeliveryResult, type BaleDeliveryScope, type BaleDeliveryTarget, type BaleDeliveryView } from "./delivery.ts";
export type BaleActivitySource = "bale" | "local" | "autonomous" | "unknown";
export type BaleActivityTarget = Readonly<BaleDeliveryTarget>;
export interface BaleActivityEnvelope {
    activityId: string;
    sequence: number;
    source: BaleActivitySource;
    target?: BaleActivityTarget;
    replyToMessageId?: number;
    timestamp: number;
}
export type BaleActivityPayload = {
    type: "agent-start";
} | {
    type: "assistant-text-delta";
    contentIndex: number;
    delta: string;
} | {
    type: "assistant-segment";
    contentIndex: number;
    text: string;
    placement: "intermediate" | "final" | "terminal-partial";
} | {
    type: "reasoning-delta";
    contentIndex: number;
    delta: string;
} | {
    type: "reasoning-end";
    contentIndex: number;
    text: string;
} | {
    type: "tool-start";
    toolCallId: string;
    toolName: string;
    args: unknown;
} | {
    type: "tool-update";
    toolCallId: string;
    toolName: string;
    update: unknown;
} | {
    type: "tool-end";
    toolCallId: string;
    toolName: string;
    result: unknown;
    isError: boolean;
} | {
    type: "compaction-start";
    reason: "manual" | "threshold" | "overflow" | "unknown";
} | {
    type: "compaction-end";
    reason: "manual" | "threshold" | "overflow" | "unknown";
} | {
    type: "ui-prompt-start";
    kind: "select" | "confirm" | "input" | "editor" | "custom";
    title?: string;
} | {
    type: "ui-prompt-end";
} | {
    type: "agent-end";
} | {
    type: "agent-settled";
};
export type BaleActivityEvent = BaleActivityEnvelope & BaleActivityPayload;
export type BaleAssistantSegmentEvent = BaleActivityEnvelope & Extract<BaleActivityPayload, {
    type: "assistant-segment";
}>;
export interface BaleActivityContext {
    activityId: string;
    sequence: number;
    source: BaleActivitySource;
    defaultScope: BaleDeliveryScope;
    send: (view: BaleDeliveryView, options?: {
        scope?: BaleDeliveryScope;
        replyToMessageId?: number;
    }) => Promise<BaleDeliveryResult<BaleDeliveryHandle>>;
    edit: (handle: BaleDeliveryHandle, view: BaleDeliveryView) => Promise<BaleDeliveryResult<BaleDeliveryHandle>>;
    delete: (handle: BaleDeliveryHandle) => Promise<BaleDeliveryResult<void>>;
    chatAction: (action: BaleDeliveryChatAction, options?: {
        scope?: BaleDeliveryScope;
    }) => Promise<BaleDeliveryResult<void>>;
}
export interface BaleActivityHandlerRegistration {
    id: string;
    order?: number;
    handle: (event: BaleActivityEvent, ctx: BaleActivityContext) => void | Promise<void>;
}
export declare function registerBaleActivityHandler(registration: BaleActivityHandlerRegistration): () => void;
/** @internal */
export declare function clearBaleActivityHandlers(): void;
/** @internal */
export interface BaleActivityDispatcher {
    hasPending?: () => boolean;
    dispatch: (event: BaleActivityEvent) => void;
    stop: () => void;
}
/** @internal */
export declare function createBaleActivityDispatcher(deps?: {
    captureDrain?: () => (() => void) | undefined;
    recordFailure?: (handlerId: string, event: BaleActivityEvent, error: unknown) => void;
}): BaleActivityDispatcher;
/** @internal */
export declare function createBaleActivityBridgeRuntime(deps: {
    generation: string;
    captureDrain?: () => (() => void) | undefined;
    observeEvent?: (event: BaleActivityEvent) => void;
    recordFailure?: (handlerId: string, event: BaleActivityEvent, error: unknown) => void;
    now?: () => number;
}): BaleActivityRuntime;
export type BaleActivityInputSource = "interactive" | "rpc" | "extension" | "unknown";
export type BaleAssistantStreamEvent = {
    type: "start";
} | {
    type: "text_start";
    contentIndex: number;
} | {
    type: "text_delta";
    contentIndex: number;
    delta: string;
} | {
    type: "text_end";
    contentIndex: number;
    content: string;
} | {
    type: "thinking_delta";
    contentIndex: number;
    delta: string;
} | {
    type: "thinking_end";
    contentIndex: number;
    content: string;
} | {
    type: "thinking_start";
    contentIndex: number;
} | {
    type: "toolcall_start";
    contentIndex: number;
} | {
    type: "toolcall_delta";
    contentIndex: number;
    delta: string;
} | {
    type: "toolcall_end";
    contentIndex: number;
} | {
    type: "done";
} | {
    type: "error";
};
/** @internal */
export interface BaleActivityRuntime {
    hasPending?: () => boolean | undefined;
    onSessionStart?: () => void;
    recordInputSource: (source: BaleActivityInputSource) => void;
    onAgentStart: (activeBaleTarget?: BaleActivityTarget, replyToMessageId?: number) => void;
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
    onCompactionStart: (reason: "manual" | "threshold" | "overflow" | "unknown") => void;
    onCompactionEnd: (reason: "manual" | "threshold" | "overflow" | "unknown") => void;
    onCompactionAbandoned: () => void;
    onUiPromptStart: (kind: "select" | "confirm" | "input" | "editor" | "custom", title?: string) => void;
    onUiPromptEnd: () => void;
    onAgentEnd: () => void;
    onAgentSettled: () => void;
    onSessionShutdown: () => void;
}
/** @internal */
export declare function createBaleActivityRuntime(deps: {
    generation: string;
    dispatcher: BaleActivityDispatcher;
    observeEvent?: (event: BaleActivityEvent) => void;
    recordObserverFailure?: (event: BaleActivityEvent, error: unknown) => void;
    now?: () => number;
}): BaleActivityRuntime;
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
export declare function createBaleActivityPublicationRuntime(deps?: {
    captureDrain?: () => (() => void) | undefined;
}): BaleActivityPublicationRuntime;
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
export declare function createBaleAssistantOutputRuntime<TAuthority = undefined>(deps: {
    prepareSend?: (event: BaleAssistantSegmentEvent) => BaleAssistantOutputPreparation | undefined;
    enqueue?: BaleActivityPublicationRuntime["enqueue"];
    captureAuthority?: () => TAuthority;
    isAuthorityActive?: (authority: TAuthority) => boolean;
    canDeliver: (event: BaleAssistantSegmentEvent) => boolean;
    send: (event: BaleAssistantSegmentEvent, authority: TAuthority, isAuthorityActive: () => boolean) => Promise<void>;
    recordFailure?: (event: BaleAssistantSegmentEvent, error: unknown) => void;
}): BaleAssistantOutputRuntime;

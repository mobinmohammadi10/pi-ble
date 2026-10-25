/**
 * Bale target-aware operational delivery and logical message lifecycle
 * Zones: bale delivery, extension API, runtime binding
 * Owns the public extension delivery contract, authorized scope resolution, operational rendering adapter, per-target serialization, chunk reconciliation, generation-fenced logical handles, and process-local runtime membrane; composes the established reply renderer with bus-aware Bale API ports and excludes bot clients, Pi contexts, and consumer-extension policy
 */
import { type BaleInlineKeyboardMarkup } from "./keyboard.ts";
import { type BaleTarget } from "./target.ts";
import { type BaleBridgeApiRuntime } from "./bale-api.ts";
export type BaleDeliveryParseMode = "plain" | "html" | "markdown";
export interface BaleDeliveryView {
    text: string;
    parseMode?: BaleDeliveryParseMode;
    replyMarkup?: BaleInlineKeyboardMarkup;
}
export type BaleDeliveryTarget = BaleTarget;
export type BaleDeliveryScope = {
    kind: "active-turn";
} | {
    kind: "instance";
} | {
    kind: "aggregate";
} | {
    kind: "target";
    target: BaleDeliveryTarget;
};
export interface BaleDeliveryHandle {
    readonly target: BaleDeliveryTarget;
    readonly messageIds: readonly number[];
    readonly generation: string;
}
export type BaleDeliveryFailureReason = "runtime-unavailable" | "target-unavailable" | "target-unauthorized" | "stale-handle" | "invalid-view" | "commit-unknown" | "message-unavailable" | "rate-limited" | "transport-retryable" | "transport-failed";
export type BaleDeliveryResult<T> = {
    ok: true;
    value: T;
} | {
    ok: false;
    reason: BaleDeliveryFailureReason;
    message: string;
    /** Exact Bale flood-control delay when supplied by the API. */
    retryAfterMs?: number;
    /** Successfully materialized state that callers may edit or delete to recover. */
    partial?: T;
};
export interface SendBaleViewOptions {
    scope: BaleDeliveryScope;
    replyToMessageId?: number;
}
export type BaleDeliveryChatAction = "typing" | "upload_document" | "upload_photo" | "record_voice";
/** @internal */
export interface BaleDeliveryRuntime {
    readonly generation: string;
    hasPendingTarget?: (target: BaleDeliveryTarget) => boolean;
    shutdown: () => void;
    sendView: (view: BaleDeliveryView, options: SendBaleViewOptions) => Promise<BaleDeliveryResult<BaleDeliveryHandle>>;
    editView: (handle: BaleDeliveryHandle, view: BaleDeliveryView) => Promise<BaleDeliveryResult<BaleDeliveryHandle>>;
    deleteView: (handle: BaleDeliveryHandle) => Promise<BaleDeliveryResult<void>>;
    sendChatAction: (action: BaleDeliveryChatAction, scope: BaleDeliveryScope) => Promise<BaleDeliveryResult<void>>;
}
/** @internal */
export interface BaleDeliveryTargetResolverDeps {
    getActiveTurnTarget: () => BaleDeliveryTarget | undefined;
    getInstanceTarget: () => BaleDeliveryTarget | undefined;
    getAggregateTarget: () => BaleDeliveryTarget | undefined;
    isExplicitTargetAuthorized: (target: BaleDeliveryTarget) => boolean;
}
/** @internal */
export interface BaleDeliveryRenderedChunk {
    text: string;
    parseMode: BaleDeliveryParseMode;
}
/** @internal */
export interface BaleDeliveryTransportOptions {
    replyToMessageId?: number;
    replyMarkup?: BaleInlineKeyboardMarkup | null;
}
/** @internal */
export interface BaleDeliveryRuntimeDeps extends BaleDeliveryTargetResolverDeps {
    generation: string;
    captureDrain?: () => (() => void) | undefined;
    renderView: (view: BaleDeliveryView) => readonly BaleDeliveryRenderedChunk[];
    sendChunk: (target: BaleDeliveryTarget, chunk: BaleDeliveryRenderedChunk, options: BaleDeliveryTransportOptions) => Promise<number>;
    editChunk: (target: BaleDeliveryTarget, messageId: number, chunk: BaleDeliveryRenderedChunk, options: BaleDeliveryTransportOptions) => Promise<void>;
    deleteMessage: (target: BaleDeliveryTarget, messageId: number) => Promise<void>;
    sendChatAction: (target: BaleDeliveryTarget, action: BaleDeliveryChatAction) => Promise<void>;
    recordFailure?: (operation: "send" | "edit" | "delete" | "chat-action", error: unknown, target?: BaleDeliveryTarget) => void;
}
/** @internal */
export interface BaleBridgeDeliveryRuntimeDeps {
    generation: string;
    captureDrain?: () => (() => void) | undefined;
    getTargetPolicyView: () => BaleDeliveryTargetPolicyView;
    getActiveTurnTarget: () => BaleDeliveryTarget | undefined;
    isTransportActive?: () => boolean;
    api: Pick<BaleBridgeApiRuntime, "sendMessage" | "editMessageText" | "deleteMessage" | "sendChatAction">;
    recordOwnership: (input: {
        chatId: number;
        messageId: number;
        target: BaleDeliveryTarget;
    }) => void;
    recordFailure?: BaleDeliveryRuntimeDeps["recordFailure"];
}
/** @internal */
export declare function createBaleDeliveryLifecycleHooks(createRuntime: () => BaleDeliveryRuntime): {
    onSessionStart: () => Promise<void>;
    onSessionShutdown: () => Promise<void>;
    hasPendingTarget: (target: BaleDeliveryTarget) => boolean | undefined;
};
export declare function createBaleDeliveryGenerationSeed(instanceId: string): string;
/** @internal */
export declare function createBaleBridgeDeliveryLifecycleHooks<TTransportStamp>(deps: Omit<BaleBridgeDeliveryRuntimeDeps, "generation" | "isTransportActive"> & {
    generationSeed: string;
    getTransportStamp?: () => TTransportStamp;
    isTransportStampActive?: (stamp: TTransportStamp) => boolean;
}): ReturnType<typeof createBaleDeliveryLifecycleHooks>;
/** @internal */
export interface BaleDeliveryTargetPolicyView {
    canDeliver: boolean;
    ownsDirect: boolean;
    threaded?: boolean;
    allowedChatId?: number;
    followerTarget?: BaleDeliveryTarget;
    leaderTarget?: BaleDeliveryTarget;
    liveTargets?: readonly BaleDeliveryTarget[];
}
/** @internal */
export interface BaleDeliveryTargetPolicyRuntime {
    getTargetPolicyView(): BaleDeliveryTargetPolicyView;
    getActiveTurnTarget(): BaleDeliveryTarget | undefined;
}
/** @internal */
export declare function createBaleDeliveryTargetPolicyRuntime(deps: {
    ownsDirect(): boolean;
    isThreadedMode?(): boolean;
    isFollowerRegistered(): boolean;
    getAllowedChatId(): number | undefined;
    getFollowerTarget(): BaleDeliveryTarget | undefined;
    getLeaderTarget(): BaleDeliveryTarget | undefined;
    listThreadRecords(): readonly {
        target: BaleDeliveryTarget;
    }[];
    getActiveTurnTarget(): BaleDeliveryTarget | undefined;
    getActiveGuestQueryId(): string | undefined;
}): BaleDeliveryTargetPolicyRuntime;
/** @internal */
export declare function resolveBaleDeliveryInstanceTarget(view: BaleDeliveryTargetPolicyView): BaleDeliveryTarget | undefined;
/** @internal */
export declare function resolveBaleDeliveryAggregateTarget(view: BaleDeliveryTargetPolicyView): BaleDeliveryTarget | undefined;
/** @internal */
export declare function isBaleDeliveryExplicitTargetAuthorized(candidate: BaleDeliveryTarget, view: BaleDeliveryTargetPolicyView): boolean;
/** @internal */
export declare function createBaleDeliveryRuntime(deps: BaleDeliveryRuntimeDeps): BaleDeliveryRuntime;
/** @internal */
export declare function createBaleBridgeDeliveryRuntime(deps: BaleBridgeDeliveryRuntimeDeps): BaleDeliveryRuntime;
/** @internal */
export declare function bindBaleDeliveryRuntime(runtime: BaleDeliveryRuntime): () => void;
/** @internal */
export declare function clearBaleDeliveryRuntime(): void;
/** @internal */
export declare function isBaleDeliveryHandleCurrent(handle: BaleDeliveryHandle): boolean;
export declare function sendBaleView(view: BaleDeliveryView, options: SendBaleViewOptions): Promise<BaleDeliveryResult<BaleDeliveryHandle>>;
export declare function editBaleView(handle: BaleDeliveryHandle, view: BaleDeliveryView): Promise<BaleDeliveryResult<BaleDeliveryHandle>>;
export declare function deleteBaleView(handle: BaleDeliveryHandle): Promise<BaleDeliveryResult<void>>;
export declare function sendBaleChatAction(action: BaleDeliveryChatAction, options: {
    scope: BaleDeliveryScope;
}): Promise<BaleDeliveryResult<void>>;

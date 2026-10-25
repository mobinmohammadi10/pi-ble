/**
 * Bale updates domain helpers
 * Zones: bale inbound, authorization, routing plans
 * Owns update extraction, authorization, execution planning, generation-fenced journal draining, and the public update-handler registry
 */
import type { BaleBusEnvelope, BaleBusFollowerView, BaleBusForeignUpdateSettlement, BaleBusFollowerQueueHandoffOffer, BaleBusForwardOwnership, BaleBusLeaderQueueHandoffOffer } from "./bus.ts";
import { type BaleAuthorizationState, type BaleUserPairingRuntimeDeps } from "./config.ts";
import { BALE_UPDATE_JOURNAL_CUSTODY_VERSION, BALE_UPDATE_JOURNAL_EXCLUSION_VERSION, BALE_UPDATE_JOURNAL_VERSION, type BaleInputJournalReceipt, type BaleInputJournalSourceReference, type BaleInputJournalStore, type BaleJournaledUpdate, type BaleRoutingInputExpiryResult, type BaleRoutingInputJournal, type BaleUpdateJournalAppendResult, type BaleUpdateJournalDeadQueueOwnerRecoveryResult, type BaleUpdateJournalEntry, type BaleUpdateJournalEntryDigest, type BaleUpdateJournalInputClaim, type BaleUpdateJournalOperatorDispositionInput, type BaleUpdateJournalOperatorDispositionResult, type BaleUpdateJournalPendingAbandonmentInput, type BaleUpdateJournalPendingAbandonmentResult, type BaleUpdateJournalPendingRetentionEvidence, type BaleUpdateJournalQueueDiscardResult, type BaleUpdateJournalQueueHandoffAcceptResult, type BaleUpdateJournalQueueHandoffCancelResult, type BaleUpdateJournalQueueHandoffInput, type BaleUpdateJournalQueueHandoffOfferResult, type BaleUpdateJournalQueueOwner, type BaleUpdateJournalQueueOwnerIdentity, type BaleUpdateJournalQueuedCompletion, type BaleUpdateJournalQueuedReceiptEvidence, type BaleUpdateJournalRoutingChooser, type BaleUpdateJournalRoutingInput, type BaleUpdateJournalSourceCompletion } from "./journal.ts";
import type { BaleMessageOwnershipStore } from "./ownership.ts";
import type { BaleProcessLiveness } from "./process-identity.ts";
import { type PendingBaleControlItem, type BaleControlQueueHandoffPayload, type BaleQueueAdmissionReceipt, type BaleQueueHandoffPayload, type BaleQueueHandoffStageResult, type BaleQueueHandoffStagingRuntime, type BaleQueueItem, type BaleQueueReactionDisposition } from "./queue.ts";
import { type BaleTarget } from "./target.ts";
export interface BaleReactionTypeEmoji {
    type: "emoji";
    emoji: string;
}
export interface BaleReactionTypeNonEmoji {
    type: string;
}
export type BaleReactionType = BaleReactionTypeEmoji | BaleReactionTypeNonEmoji;
export declare const BALE_PRIORITY_REACTIONS: readonly [{
    readonly id: 10;
    readonly name: "like";
    readonly emoji: "👍";
}];
export declare const BALE_STEER_REACTIONS: readonly [{
    readonly id: 14;
    readonly name: "fire";
    readonly emoji: "🔥";
}];
export declare const BALE_REMOVAL_REACTIONS: readonly [{
    readonly id: 20;
    readonly name: "dislike";
    readonly emoji: "👎";
}];
export declare const BALE_PRIORITY_REACTION_EMOJIS: "👍"[];
export declare const BALE_REMOVAL_REACTION_EMOJIS: "👎"[];
export interface BaleUpdateDeletion {
    deleted_business_messages?: {
        message_ids?: unknown;
    };
}
export declare function normalizeBaleReactionEmoji(emoji: string): string;
export declare function collectBaleReactionEmojis(reactions: BaleReactionType[]): Set<string>;
export interface BaleUser {
    id: number;
    is_bot: boolean;
}
export interface BaleChat {
    id?: number;
    type: string;
}
export interface BaleUpdateMessage {
    chat: BaleChat;
    from?: BaleUser;
    message_id?: number;
    message_thread_id?: number;
    pi_bale_agent_source_thread?: string;
    forum_topic_created?: unknown;
    forum_topic_closed?: unknown;
    forum_topic_reopened?: unknown;
}
export type BaleTopicLifecycleKind = "created" | "closed" | "reopened";
export interface BaleTopicLifecycleUpdate<TMessage = BaleUpdateMessage> {
    kind: BaleTopicLifecycleKind;
    message: TMessage;
    target: BaleTarget & {
        threadId: number;
    };
}
export declare function getBaleTopicLifecycleUpdate<TMessage extends BaleUpdateMessage>(message: TMessage | undefined): BaleTopicLifecycleUpdate<TMessage> | undefined;
export interface BaleCallbackQuery {
    id?: string;
    from: BaleUser;
    message?: BaleUpdateMessage;
}
export interface BaleGuestMessage {
    guest_query_id: string;
    chat: BaleChat;
    from?: BaleUser;
    message_id?: number;
    text?: string;
    /** Text sent together with a photo, document or other media. */
    caption?: string;
    reply_to_message?: BaleUpdateMessage;
}
export declare function getBaleMessageTarget(message: BaleUpdateMessage): BaleTarget | undefined;
export interface BaleUpdateRouting {
    message?: BaleUpdateMessage;
    edited_message?: BaleUpdateMessage;
    callback_query?: BaleCallbackQuery;
    guest_message?: BaleGuestMessage;
}
export declare function getAuthorizedBaleCallbackQuery(update: BaleUpdateRouting, allowedUserId?: number): BaleCallbackQuery | undefined;
export declare function getAuthorizedBaleMessage(update: BaleUpdateRouting, allowedUserId?: number): BaleUpdateMessage | undefined;
export declare function getAuthorizedBaleEditedMessage(update: BaleUpdateRouting, allowedUserId?: number): BaleUpdateMessage | undefined;
export declare function getAuthorizedBaleGuestMessage(update: BaleUpdateRouting): BaleGuestMessage | undefined;
export type BaleMessageOwnershipView = BaleBusForwardOwnership;
export type BaleMessageOwnershipLookup = (chatId: number, messageId: number) => BaleMessageOwnershipView | undefined;
export type BaleTargetOwnershipView = BaleBusForwardOwnership;
export type BaleTargetOwnershipLookup = (target: BaleTarget) => BaleTargetOwnershipView | undefined;
export interface BaleForeignOwnedUpdateForwarder<TContext, TReactionUpdate extends BaleMessageReactionUpdated = BaleMessageReactionUpdated, TCallbackQuery extends BaleCallbackQuery = BaleCallbackQuery, TMessage extends BaleUpdateMessage = BaleUpdateMessage> {
    forwardCallback?: (input: {
        query: TCallbackQuery;
        ownership: BaleMessageOwnershipView;
        ctx: TContext;
    }) => Promise<BaleBusForeignUpdateSettlement> | BaleBusForeignUpdateSettlement;
    forwardReaction?: (input: {
        reactionUpdate: TReactionUpdate;
        ownership: BaleMessageOwnershipView;
        ctx: TContext;
    }) => Promise<BaleBusForeignUpdateSettlement> | BaleBusForeignUpdateSettlement;
    forwardMessage?: (input: {
        message: TMessage;
        ownership: BaleTargetOwnershipView;
        ctx: TContext;
        /** Local issuance/ACK fence; implementations must not serialize it into payloads. */
        assertAuthority?: () => void;
    }) => Promise<BaleBusForeignUpdateSettlement> | BaleBusForeignUpdateSettlement;
    forwardEditedMessage?: (input: {
        message: TMessage;
        ownership: BaleTargetOwnershipView;
        ctx: TContext;
    }) => Promise<BaleBusForeignUpdateSettlement> | BaleBusForeignUpdateSettlement;
}
export interface BaleMessageReactionUpdated {
    chat: {
        id?: number;
        type: string;
    };
    user?: BaleUser;
    actor_chat?: unknown;
    message_id: number;
    old_reaction: BaleReactionType[];
    new_reaction: BaleReactionType[];
}
export declare const BALE_INTERNAL_AGENT_MESSAGE: unique symbol;
export interface BaleUpdateFlow extends BaleUpdateRouting, BaleUpdateDeletion {
    message_reaction?: BaleMessageReactionUpdated;
    [BALE_INTERNAL_AGENT_MESSAGE]?: true;
}
export type BaleUpdateAdmissionOutcome = {
    kind: "complete";
    expectedSource?: BaleDeferredSourceEvidence;
} | {
    kind: "deferred";
    routingReview?: true;
} | {
    kind: "queued";
    queueKind: "prompt" | "control";
    receiptId: string;
    sourceUpdateIds: readonly number[];
};
export type BaleDeferredUpdateAbandonmentAuthority = Pick<BaleUpdateJournalPendingAbandonmentInput, "operatorAuthorityId" | "isCurrent">;
export interface BaleDeferredAbandonmentRecoveryRequest {
    journalBindingKey: string;
    afterUpdateId?: number;
    isCurrent: () => boolean;
}
/** A generation-owned post-drain hint for the new-world restart; never execution, completion or deletion authority by itself. */
export interface BaleHeldSourcePreparation<TContext> {
    ctx: TContext;
    journalBindingKey: string;
    /** Exact prepared worker owner, context, key and authority; the consumer adds its own domain fences. */
    isCurrent: () => boolean;
    signal: AbortSignal;
    /** Chooser-clock sources that must survive cold spending until their fixed expiry. */
    routingSourceIds?: readonly number[];
}
export interface BaleDeferredAbandonmentRecoveryPage {
    sources: {
        /** Detached original evidence, not proof of current eligibility or archive integrity. */
        original: BaleUpdateJournalEntry;
        retry: (authority: BaleDeferredUpdateAbandonmentAuthority) => BaleUpdateJournalPendingAbandonmentResult | undefined;
    }[];
    nextAfterUpdateId?: number;
}
type BaleHistoricalInputPredicate = (original: BaleUpdateJournalEntry) => boolean;
/** Read-only exact-source observation by its live worker; not an acceptance or removal grant. */
export interface BaleDeferredSourceEvidence extends BaleUpdateJournalEntryDigest {
    journalBindingKey: string;
    /** Supplied only after caller-owned acceptance publication; requires a durable removal ACK. */
    completionSha256?: string;
}
/** Fresh source-owner projection; the payload is copied from the retained journal, never a routed carrier. */
export interface BaleDeferredSourceSnapshot {
    source: BaleDeferredSourceEvidence;
    update: BaleJournaledUpdate;
}
/** Warm exact-removal ACK plus its issuing worker lifetime; never persisted or sent over IPC. */
interface BaleDeferredSourceCompletion {
    source: BaleDeferredSourceEvidence;
    isCurrent(): boolean;
}
interface BaleUpdateAdmissionBinding {
    sourceUpdateId: number;
    report: (outcome: BaleUpdateAdmissionOutcome) => void;
    abandon?: (authority: BaleDeferredUpdateAbandonmentAuthority) => BaleUpdateJournalPendingAbandonmentResult | undefined;
    armRoutingInput?: (operatorUserId: number, sourceUpdateIds: readonly number[], chooser?: BaleUpdateJournalRoutingChooser) => BaleUpdateJournalRoutingInput | undefined;
    /** The source's saved routing clock, including where its chooser was published. */
    getRoutingInput?: () => BaleUpdateJournalRoutingInput | undefined;
    acquireRouting?: (select?: boolean, sourceUpdateIds?: readonly number[]) => () => void;
    inspectSource?: () => BaleDeferredSourceEvidence | undefined;
    inspectSourceSnapshot?: () => BaleDeferredSourceSnapshot | undefined;
    inspectCompletion?: () => BaleDeferredSourceEvidence | undefined;
    subscribeCompletion?: (notify: () => void) => () => void;
    isSourceUnsettled?: () => boolean;
    prepareLiveInput?: (sourceUpdateIds: readonly number[], isCurrent: () => boolean, onTransferred?: () => void) => BaleLiveDeferredInputPreparation | undefined;
    /** Internal notification after the worker's exact donor-removal ACK; never issues completion itself. */
    acknowledgeTransferred?: () => void;
    prepareQueueAdmission?: () => BaleDeferredQueueAdmissionPreparation | undefined;
    prepareSourceCompletion?: () => Pick<BaleDeferredSourceCompletionPreparation, "source" | "isCurrent"> | undefined;
    supportsAbandonment?: (journalBindingKey: string) => boolean;
    inspectAbandoning?: (request: BaleDeferredAbandonmentRecoveryRequest) => BaleDeferredAbandonmentRecoveryPage | undefined;
    inspectHistorical?: (request: BaleDeferredAbandonmentRecoveryRequest) => BaleDeferredAbandonmentRecoveryPage | undefined;
    isHistorical?: (matchesOriginal?: BaleHistoricalInputPredicate) => boolean;
    isHistoricalReviewHeld?: () => boolean;
}
export type BaleQueueAdmissionReceiptLike = BaleQueueAdmissionReceipt;
export declare function bindBaleUpdateAdmissionSource<TUpdate extends BaleUpdateFlow & {
    update_id: number;
}>(update: TUpdate, report: BaleUpdateAdmissionBinding["report"], controls?: Pick<BaleUpdateAdmissionBinding, "abandon" | "armRoutingInput" | "getRoutingInput" | "acquireRouting" | "inspectSource" | "inspectSourceSnapshot" | "inspectCompletion" | "subscribeCompletion" | "isSourceUnsettled" | "acknowledgeTransferred" | "prepareLiveInput" | "prepareQueueAdmission" | "prepareSourceCompletion" | "supportsAbandonment" | "inspectAbandoning" | "inspectHistorical" | "isHistorical" | "isHistoricalReviewHeld">): TUpdate;
/**
 * Conservative read-only census: any retained entry naming this Thread, in any nested Bale object or state,
 * is unresolved custody, except a lone button tap, which carries no input (the in-flight Cancel itself).
 * It cannot see updates still in transit before journal append.
 */
export declare function collectBaleJournalThreadUpdateIds(entries: readonly {
    updateId: number;
    update: unknown;
}[], target: {
    chatId: number;
    threadId: number;
}): number[];
export declare function collectBaleAdmissionSourceUpdateIds(values: readonly unknown[]): number[];
/** Observe the original journal entry, never the mutable routed carrier, through current worker authority. */
export declare function inspectBaleDeferredSource(value: unknown): BaleDeferredSourceEvidence | undefined;
/** Read an exact current original for peer preparation without another payload authority. */
export declare function inspectBaleDeferredSourceSnapshot(value: unknown): BaleDeferredSourceSnapshot | undefined;
/** Exact warm removal ACK only; reporting, source absence and a replaced worker cannot supply it. */
export declare function inspectBaleDeferredSourceCompletion(value: unknown): BaleDeferredSourceEvidence | undefined;
/** Warm ACK notification only; subscribers must independently recheck exact completion and recipient authority. */
export declare function subscribeBaleDeferredSourceCompletion(value: unknown, notify: () => void): (() => void) | undefined;
/** Reuse only live bound deferred originals; raw IDs or cold/adopted input cannot mint this carrier. */
export declare function prepareBaleLiveDeferredInput(values: readonly unknown[], isCurrent: () => boolean): BaleLiveDeferredInputPreparation | undefined;
/** A route-owned pre-disposition acceptance publisher; wraps only this carrier, never the shared worker binding. */
export declare function bindBaleUpdateCompletionAcceptance<TValue>(value: TValue, publish: () => BaleDeferredSourceEvidence): TValue;
/** Report source completion; true means reported, not a durable settlement acknowledgement. */
export declare function reportBaleUpdateCompleted(value: unknown, expectedSource?: BaleDeferredSourceEvidence): boolean;
export declare function reportBaleUpdateDeferred(value: unknown): boolean;
/** Exact source-bound cancellation; undefined means no eligible attempt was made. */
export declare function abandonBaleDeferredUpdate(value: unknown, authority: BaleDeferredUpdateAbandonmentAuthority): BaleUpdateJournalPendingAbandonmentResult | undefined;
/** Capability for chooser publication; the eventual action still requires exact deferred authority. */
export declare function supportsBaleDeferredAbandonment(value: unknown, journalBindingKey: string): boolean;
/** Observe protected attempts through a current carrier; the UI still owns human authorization. */
export declare function inspectBaleAbandoningUpdates(value: unknown, request: BaleDeferredAbandonmentRecoveryRequest): BaleDeferredAbandonmentRecoveryPage | undefined;
/** Historical inspection is not human confirmation or permission to stop delivery. */
export declare function inspectBaleHistoricalInputs(value: unknown, request: BaleDeferredAbandonmentRecoveryRequest): BaleDeferredAbandonmentRecoveryPage | undefined;
export declare function isBaleHistoricalInput(value: unknown, matchesOriginal?: BaleHistoricalInputPredicate): boolean;
/** Routing's last-boundary hold when ownership changed after early classification. */
export declare function reportBaleHistoricalRoutingReview(value: unknown): boolean;
/** Arm only a positively published chooser; the journal owns the immutable hour deadline. */
export declare function armBaleRoutingInputs(values: readonly unknown[], operatorUserId: number, chooser?: BaleUpdateJournalRoutingChooser): BaleUpdateJournalRoutingInput | undefined;
/** A routed carrier's saved routing clock; a revived chooser reuses its recorded message. */
export declare function getBaleUpdateRoutingInput(value: unknown): BaleUpdateJournalRoutingInput | undefined;
/** Reserve source execution; an actual choice must also freeze its durable TTL before any effect. */
export declare function acquireBaleUpdateRouting(value: unknown, select?: boolean, sourceUpdateIds?: readonly number[]): () => void;
/** Capture existing warm completion authority; only explicit reporting may dispose this exact original. */
export declare function prepareBaleDeferredSourceCompletion(value: unknown): BaleDeferredSourceCompletionPreparation | undefined;
/** Read-only warm owner availability; no source freeze, admission, report or receipt reconstruction. */
export declare function prepareBaleDeferredQueueAdmission(value: unknown): BaleDeferredQueueAdmissionPreparation | undefined;
export declare function reportBaleQueueAdmission(values: readonly unknown[], receipts: readonly BaleQueueAdmissionReceiptLike[]): boolean;
export type BaleUpdateFlowAction<TReactionUpdate extends BaleMessageReactionUpdated = BaleMessageReactionUpdated, TCallbackQuery extends BaleCallbackQuery = BaleCallbackQuery, TMessage extends BaleUpdateMessage = BaleUpdateMessage, TGuestMessage extends BaleGuestMessage = BaleGuestMessage> = {
    kind: "ignore";
} | {
    kind: "deleted";
    messageIds: number[];
} | {
    kind: "reaction";
    reactionUpdate: TReactionUpdate;
} | {
    kind: "topic-lifecycle";
    lifecycle: BaleTopicLifecycleUpdate<TMessage>;
} | {
    kind: "callback";
    query: TCallbackQuery;
    authorization: BaleAuthorizationState;
} | {
    kind: "message";
    message: TMessage & {
        from: BaleUser;
    };
    authorization: BaleAuthorizationState;
} | {
    kind: "edited-message";
    message: TMessage & {
        from: BaleUser;
    };
    authorization: BaleAuthorizationState;
} | {
    kind: "guest";
    guestMessage: TGuestMessage & {
        from: BaleUser;
    };
    authorization: BaleAuthorizationState;
};
export declare function buildBaleUpdateFlowAction<TUpdate extends BaleUpdateFlow>(update: TUpdate, allowedUserId?: number): BaleUpdateFlowAction<NonNullable<TUpdate["message_reaction"]>, NonNullable<TUpdate["callback_query"]>, NonNullable<TUpdate["message"] | TUpdate["edited_message"]>, NonNullable<TUpdate["guest_message"]>>;
export type BaleUpdateExecutionPlan<TReactionUpdate extends BaleMessageReactionUpdated = BaleMessageReactionUpdated, TCallbackQuery extends BaleCallbackQuery = BaleCallbackQuery, TMessage extends BaleUpdateMessage = BaleUpdateMessage, TGuestMessage extends BaleGuestMessage = BaleGuestMessage> = {
    kind: "ignore";
} | {
    kind: "deleted";
    messageIds: number[];
} | {
    kind: "reaction";
    reactionUpdate: TReactionUpdate;
} | {
    kind: "topic-lifecycle";
    lifecycle: BaleTopicLifecycleUpdate<TMessage>;
} | {
    kind: "callback";
    query: TCallbackQuery;
    shouldPair: boolean;
    shouldDeny: boolean;
} | {
    kind: "message";
    message: TMessage & {
        from: BaleUser;
    };
    shouldPair: boolean;
    shouldNotifyPaired: boolean;
    shouldDeny: boolean;
} | {
    kind: "edited-message";
    message: TMessage & {
        from: BaleUser;
    };
    shouldPair: boolean;
    shouldDeny: boolean;
} | {
    kind: "guest";
    guestMessage: TGuestMessage & {
        from: BaleUser;
    };
    shouldDeny: boolean;
};
export declare function buildBaleUpdateExecutionPlan<TReactionUpdate extends BaleMessageReactionUpdated, TCallbackQuery extends BaleCallbackQuery, TMessage extends BaleUpdateMessage, TGuestMessage extends BaleGuestMessage>(action: BaleUpdateFlowAction<TReactionUpdate, TCallbackQuery, TMessage, TGuestMessage>): BaleUpdateExecutionPlan<TReactionUpdate, TCallbackQuery, TMessage, TGuestMessage>;
export declare function buildBaleUpdateExecutionPlanFromUpdate<TUpdate extends BaleUpdateFlow>(update: TUpdate, allowedUserId?: number): BaleUpdateExecutionPlan<NonNullable<TUpdate["message_reaction"]>, NonNullable<TUpdate["callback_query"]>, NonNullable<TUpdate["message"] | TUpdate["edited_message"]>>;
export type BaleMessageOwnershipRecorderInput = Parameters<BaleMessageOwnershipStore["record"]>[0];
export type BaleMessageOwnershipRecorder = (input: BaleMessageOwnershipRecorderInput) => void;
interface BaleUnauthorizedReplyOptions {
    parseMode?: "HTML";
    target?: {
        chatId: number;
        threadId?: number;
    };
}
/** Ownership lookups and authorized-update handlers shared by the per-update runtime and its controller. */
export interface BaleUpdateHandlerPorts<TContext, TCallbackQuery extends BaleCallbackQuery, TMessage extends BaleUpdateMessage> {
    getCurrentInstanceId?: () => string | undefined;
    getMessageOwnership?: BaleMessageOwnershipLookup;
    getTargetOwnership?: BaleTargetOwnershipLookup;
    recordMessageOwnership?: BaleMessageOwnershipRecorder;
    removePendingMediaGroupMessages: (messageIds: number[]) => void;
    pairBaleUserIfNeeded: (userId: number, ctx: TContext, assertExecutionCurrent?: () => void) => Promise<boolean>;
    answerCallbackQuery: (callbackQueryId: string, text?: string) => Promise<void>;
    answerGuestQuery: (guestQueryId: string, text?: string, options?: Pick<BaleUnauthorizedReplyOptions, "parseMode">) => Promise<void>;
    handleAuthorizedBaleCallbackQuery: (query: TCallbackQuery, ctx: TContext) => Promise<void>;
    sendTextReply: (chatId: number, replyToMessageId: number, text: string, options?: BaleUnauthorizedReplyOptions) => Promise<number | undefined>;
    handleAuthorizedBaleMessage: (message: TMessage, ctx: TContext) => Promise<void>;
    handleAuthorizedBaleEditedMessage: (message: TMessage, ctx: TContext) => unknown;
    handleAuthorizedBaleGuestMessage?: (guestMessage: BaleGuestMessage & {
        from: BaleUser;
    }, ctx: TContext) => Promise<void>;
    handleBaleTopicLifecycleUpdate?: (lifecycle: BaleTopicLifecycleUpdate<TMessage>, ctx: TContext) => Promise<void> | void;
    /** Called when the owner writes in an unbound thread no live instance owns. */
    handleUnboundBaleTopicMessage?: (message: TMessage & {
        from: BaleUser;
    }, ctx: TContext) => Promise<void>;
}
export interface BaleUpdateRuntimeDeps<TContext = unknown, TReactionUpdate extends BaleMessageReactionUpdated = BaleMessageReactionUpdated, TCallbackQuery extends BaleCallbackQuery = BaleCallbackQuery, TMessage extends BaleUpdateMessage = BaleUpdateMessage> extends BaleUpdateHandlerPorts<TContext, TCallbackQuery, TMessage> {
    ctx: TContext;
    execution?: BaleUpdateExecutionFence;
    foreignOwnedUpdateForwarder?: BaleForeignOwnedUpdateForwarder<TContext, TReactionUpdate, TCallbackQuery, TMessage>;
    removeQueuedBaleTurnsByMessageIds: (messageIds: number[], ctx: TContext) => number;
    handleAuthorizedBaleReactionUpdate: (reactionUpdate: TReactionUpdate, ctx: TContext) => Promise<void>;
}
export interface BaleUpdateRuntimeControllerDeps<TContext = unknown, TCallbackQuery extends BaleCallbackQuery = BaleCallbackQuery, TMessage extends BaleUpdateMessage = BaleUpdateMessage> extends BaleUpdateHandlerPorts<TContext, TCallbackQuery, TMessage> {
    getAllowedUserId: () => number | undefined;
    foreignOwnedUpdateForwarder?: BaleForeignOwnedUpdateForwarder<TContext, BaleMessageReactionUpdated, TCallbackQuery, TMessage>;
    flushPendingMediaGroupMessage?: (messageId: number) => Promise<boolean>;
    flushPendingTextGroupMessage?: (messageId: number) => Promise<boolean>;
    removeQueuedBaleTurnsByMessageIds: (messageIds: number[], ctx: TContext, scope?: {
        chatId?: number;
        threadId?: number;
    }) => number;
    applyQueuedBaleTurnReactionByMessageId: (messageId: number, disposition: BaleQueueReactionDisposition, ctx: TContext, scope?: {
        chatId?: number;
        threadId?: number;
    }) => boolean;
}
export interface BaleUpdateRuntimeController<TContext = unknown, TUpdate extends BaleUpdateFlow = BaleUpdateFlow> {
    handleAuthorizedReactionUpdate: (reactionUpdate: NonNullable<TUpdate["message_reaction"]>, ctx: TContext) => Promise<void>;
    handleUpdate: (update: TUpdate, ctx: TContext, execution?: BaleUpdateExecutionFence) => Promise<void>;
}
export declare function executeBaleUpdate<TUpdate extends BaleUpdateFlow, TContext = unknown>(update: TUpdate, allowedUserId: number | undefined, deps: BaleUpdateRuntimeDeps<TContext, NonNullable<TUpdate["message_reaction"]>, NonNullable<TUpdate["callback_query"]>, NonNullable<TUpdate["message"] | TUpdate["edited_message"]>>): Promise<void>;
export type BalePairedUpdateRuntimeControllerDeps<TContext = unknown, TUpdate extends BaleUpdateFlow = BaleUpdateFlow> = Omit<BaleUpdateRuntimeControllerDeps<TContext, NonNullable<TUpdate["callback_query"]>, NonNullable<TUpdate["message"] | TUpdate["edited_message"]>>, "pairBaleUserIfNeeded"> & BaleUserPairingRuntimeDeps<TContext>;
export declare function createBalePairedUpdateRuntime<TContext = unknown, TUpdate extends BaleUpdateFlow = BaleUpdateFlow>(deps: BalePairedUpdateRuntimeControllerDeps<TContext, TUpdate>): BaleUpdateRuntimeController<TContext, TUpdate>;
export declare function createBaleUpdateRuntime<TContext = unknown, TUpdate extends BaleUpdateFlow = BaleUpdateFlow>(deps: BaleUpdateRuntimeControllerDeps<TContext, NonNullable<TUpdate["callback_query"]>, NonNullable<TUpdate["message"] | TUpdate["edited_message"]>>): BaleUpdateRuntimeController<TContext, TUpdate>;
export interface AuthorizedBaleReactionUpdateDeps<TContext> {
    allowedUserId?: number;
    ctx: TContext;
    getCurrentInstanceId?: () => string | undefined;
    getMessageOwnership?: BaleMessageOwnershipLookup;
    foreignOwnedUpdateForwarder?: BaleForeignOwnedUpdateForwarder<TContext>;
    assertExecutionCurrent?: () => void;
    flushPendingMediaGroupMessage?: (messageId: number) => Promise<boolean>;
    flushPendingTextGroupMessage?: (messageId: number) => Promise<boolean>;
    applyQueuedBaleTurnReactionByMessageId: (messageId: number, disposition: BaleQueueReactionDisposition, ctx: TContext, scope?: {
        chatId?: number;
        threadId?: number;
    }) => boolean;
}
export declare function handleAuthorizedBaleReactionUpdate<TContext>(reactionUpdate: BaleMessageReactionUpdated, deps: AuthorizedBaleReactionUpdateDeps<TContext>): Promise<void>;
export declare function executeBaleUpdatePlan<TContext = unknown, TReactionUpdate extends BaleMessageReactionUpdated = BaleMessageReactionUpdated, TCallbackQuery extends BaleCallbackQuery = BaleCallbackQuery, TMessage extends BaleUpdateMessage = BaleUpdateMessage>(plan: BaleUpdateExecutionPlan<TReactionUpdate, TCallbackQuery, TMessage>, deps: BaleUpdateRuntimeDeps<TContext, TReactionUpdate, TCallbackQuery, TMessage>): Promise<void>;
export type BaleUpdateWorkerPhase = "stopped" | "idle" | "executing" | "retry-wait" | "failed" | "deferred" | "queued" | "blocked";
export type BaleUpdateWorkerBlockedReason = "authority-lost" | "authority-check" | "journal-read" | "journal-write" | "execution" | "input-custody" | "prior-generation-executing" | "invalid-outcome";
export interface BaleUpdateWorkerStateSnapshot {
    phase: BaleUpdateWorkerPhase;
    generation: number;
    phaseStartedAtMs?: number;
    currentUpdateId?: number;
    blockedReason?: BaleUpdateWorkerBlockedReason;
    blockedInputCustody?: {
        updateId: number;
        kind: "running-outcome-unknown" | "foreign-ready" | "handoff-frozen" | "legacy-retry-state";
    };
    journalEntryCount: number;
    journalSerializedBytes: number;
    oldestAdmittedAtMs?: number;
    deferredClaimCount: number;
    /** Protected cancellation attempts, not proof of a committed discard. */
    abandoningClaimCount?: number;
    /** Historical sources held before routing, not evidence of prior non-delivery. */
    historicalClaimCount?: number;
    /** Fresh recipient inputs reserved before append; not executable prompt-queue work. */
    preparedInputCount?: number;
    queuedClaimCount: number;
    foreignQueuedCount: number;
    foreignQueuedOwner?: BaleUpdateJournalQueueOwner;
    foreignQueuedOwnerLiveness?: BaleProcessLiveness;
    retryWaitCount: number;
    failedCount: number;
    nextRetryUpdateId?: number;
    nextRetryAtMs?: number;
    nextRetryAttemptCount?: number;
    nextRetryFailureClass?: string;
    failedUpdateId?: number;
    failedFailureId?: string;
    failedAttemptCount?: number;
    failedClass?: string;
    failedSummary?: string;
    terminalFailureAtMs?: number;
    unsettledExecutionCount: number;
    lastCompletedUpdateId?: number;
    lastCompletedAtMs?: number;
    lastFailureAtMs?: number;
    lastFailurePhase?: string;
}
export interface BaleUpdateWorkerJournalSnapshot {
    version: typeof BALE_UPDATE_JOURNAL_VERSION | typeof BALE_UPDATE_JOURNAL_EXCLUSION_VERSION | typeof BALE_UPDATE_JOURNAL_CUSTODY_VERSION;
    acceptedThroughUpdateId?: number;
    entries: readonly {
        updateId: number;
        update: BaleJournaledUpdate;
        readonly preApprovalExcluded?: boolean;
        admittedAtMs: number;
        routingInput?: BaleUpdateJournalRoutingInput;
        state: "pending" | "retry-wait" | "queued" | "failed";
        inputClaim?: BaleUpdateJournalInputClaim;
        queueKind?: "prompt" | "control";
        queueReceiptId?: string;
        queueOwner?: BaleUpdateJournalQueueOwner;
        queueHandoff?: {
            handoffId: string;
            offeredAtMs: number;
            recipientOwner: BaleUpdateJournalQueueOwnerIdentity;
        };
        failure?: {
            attemptCount: number;
            failedAtMs: number;
            failureClass: string;
            summary: string;
        };
        nextRetryAtMs?: number;
        terminalAtMs?: number;
        terminalReason?: string;
        terminalFailureId?: string;
    }[];
    serializedBytes: number;
}
export interface BaleRoutingInputExpirySource {
    original: BaleUpdateJournalEntry;
    journalBindingKey: string;
    isCurrent(): boolean;
    expire(): BaleRoutingInputExpiryResult | undefined;
}
export interface BaleUpdateWorkerJournalPort {
    routingInputs?: BaleRoutingInputJournal;
    read: () => BaleUpdateWorkerJournalSnapshot;
    inspectPendingRetention?: (entry: BaleUpdateJournalEntry) => BaleUpdateJournalPendingRetentionEvidence | undefined;
    abandonPending?: (input: BaleUpdateJournalPendingAbandonmentInput) => BaleUpdateJournalPendingAbandonmentResult;
    /** Optional strict observation; it must not recover, repair or grant new receipt authority. */
    isQueueReceiptCurrent?: (receipt: BaleQueueAdmissionReceiptLike, owner: BaleUpdateJournalQueueOwner) => boolean;
    /** Strict full-group origin observation for prepared partial scopes; no writer or readiness acquisition. */
    inspectQueuedReceipt?: (expected: BaleUpdateJournalQueuedCompletion) => BaleUpdateJournalQueuedReceiptEvidence | undefined;
    markQueued: (receipt: {
        queueKind: "prompt" | "control";
        receiptId: string;
        sourceUpdateIds: readonly number[];
        owner: BaleUpdateJournalQueueOwnerIdentity;
    }) => {
        queuedUpdateIds: readonly number[];
        duplicateUpdateIds: readonly number[];
        queueOwner?: BaleUpdateJournalQueueOwner;
    };
    completeQueued: (receipts: readonly {
        queueKind: "prompt" | "control";
        receiptId: string;
        sourceUpdateIds: readonly number[];
        queueOwner: BaleUpdateJournalQueueOwner;
    }[]) => {
        removedUpdateIds: readonly number[];
    };
    completeQueuedExact?: (receipts: readonly {
        queueKind: "prompt" | "control";
        receiptId: string;
        sourceUpdateIds: readonly number[];
        queueOwner: BaleUpdateJournalQueueOwner;
    }[], completions: readonly BaleUpdateJournalSourceCompletion[]) => {
        removedUpdateIds: readonly number[];
        sourceCompletions?: readonly BaleUpdateJournalSourceCompletion[];
    };
    markExecutionFailure: (input: {
        updateId: number;
        expectedAttemptCount: number;
        failedAtMs: number;
        failureClass: string;
        summary: string;
        disposition: "retry-wait" | "failed";
        nextRetryAtMs?: number;
        terminalReason?: string;
    }) => {
        entry: BaleUpdateWorkerJournalSnapshot["entries"][number];
    };
    removeCompleted: (updateIds: readonly number[]) => {
        removedUpdateIds: readonly number[];
    };
    /** No ID-only fallback is allowed for a guarded completion report. */
    removeCompletedExact?: (updateIds: readonly number[], expectedSources: readonly BaleUpdateJournalEntryDigest[], completions?: readonly BaleUpdateJournalSourceCompletion[], isCurrent?: () => boolean) => {
        removedUpdateIds: readonly number[];
        sourceCompletions?: readonly BaleUpdateJournalSourceCompletion[];
    };
    inspectSourceCompletion?: (expected: BaleUpdateJournalSourceCompletion) => BaleUpdateJournalSourceCompletion | undefined;
}
export type BaleQueueSourceCompletion = BaleDeferredSourceEvidence & {
    completionSha256: string;
};
export interface BaleUpdateRetryPolicy {
    baseDelayMs: number;
    maxDelayMs: number;
}
export interface BaleUpdateExecutionFailureClassification {
    disposition: "retryable" | "terminal";
    failureClass: string;
    summary: string;
}
export interface BaleUpdateWorkerRuntimeDeps<TContext> {
    journal: BaleUpdateWorkerJournalPort;
    executeUpdate: (update: BaleJournaledUpdate, ctx: TContext, signal: AbortSignal, target?: BaleTarget & {
        threadId: number;
    }) => Promise<BaleUpdateAdmissionOutcome> | BaleUpdateAdmissionOutcome;
    /** Native source-only binding, installed by the admission-worker assembly rather than ordinary dispatch. */
    admitPreparedLiveInput?: (update: BaleJournaledUpdate, ctx: TContext, signal: AbortSignal) => Promise<{
        outcome: BaleUpdateAdmissionOutcome;
        carrier: unknown;
    }>;
    executeCustodiedUpdate?: (update: BaleJournaledUpdate, ctx: TContext, signal: AbortSignal) => Promise<BaleCustodiedExecutionResult>;
    hasAuthority: (ctx: TContext) => boolean;
    getJournalBindingKey?: () => string | undefined;
    getRecipientBindingKey?: () => string | undefined;
    /**
     * True selects legacy historical review/spending; retain protects unsupported originals without disposition
     * authority; revive re-admits a still-waiting chooser source as this generation's live input.
     */
    shouldReviewHistoricalInput?: (entry: BaleUpdateJournalEntry, ctx: TContext, signal: AbortSignal) => BaleHistoricalReviewVerdict | Promise<BaleHistoricalReviewVerdict>;
    /** New-world restart: spend unclocked classified routing input without delivery, copy or completion. Chooser clocks wait for expiry; interrupted private abandonment keeps exact recovery. */
    spendHistoricalInput?: boolean;
    /** Holds protected live or retry sources before execution; never cancels or disposes them. */
    shouldHoldPendingInput?: (entry: BaleUpdateJournalEntry, ctx: TContext, signal: AbortSignal) => boolean | Promise<boolean>;
    getQueueOwnerIdentity?: (ctx: TContext) => BaleUpdateJournalQueueOwnerIdentity;
    isContextCurrent?: (ctx: TContext) => boolean;
    createAbortController?: () => AbortController;
    getNowMs?: () => number;
    expireRoutingInput?: (source: BaleRoutingInputExpirySource, ctx: TContext, signal: AbortSignal) => Promise<void> | void;
    retryPolicy?: Partial<BaleUpdateRetryPolicy>;
    classifyExecutionFailure?: (error: unknown) => BaleUpdateExecutionFailureClassification;
    settleTerminalExecutionFailure?: (error: unknown) => Promise<boolean>;
    scheduleRetry?: (callback: () => void, delayMs: number) => unknown;
    cancelRetry?: (handle: unknown) => void;
    batchSize?: number;
    yieldToEventLoop?: () => Promise<void>;
    onStateChange?: (state: BaleUpdateWorkerStateSnapshot) => void;
    /** One nonblocking hint after a quiescent validated startup projection, never execution or deletion authority. */
    onHeldSourcesPrepared?: (input: BaleHeldSourcePreparation<TContext>) => Promise<void> | void;
    /** Prepared readiness barrier after durable queue admission; never authorizes replay or source removal. */
    beforeQueueReceiptPublished?: (receipt: BaleQueueAdmissionReceiptLike, queueOwner: BaleUpdateJournalQueueOwner, ctx: TContext, isCurrent: () => boolean) => Promise<void | readonly BaleQueueSourceCompletion[]> | void | readonly BaleQueueSourceCompletion[];
    /** Post-ACK hint only; it must not request Pi dispatch or inherit a Workspace admission lease. */
    onQueueReceiptCompleted?: (receipt: BaleQueueAdmissionReceiptLike, ctx: TContext) => void;
    onQueueReceiptCommitted?: (receipt: BaleQueueAdmissionReceiptLike, ctx: TContext) => void;
    onUpdateCompleted?: (updateId: number, ctx: TContext, journalBindingKey?: string) => void;
    recordRuntimeEvent?: (category: string, error: unknown, details?: Record<string, unknown>) => void;
}
export type BaleQueueReceiptCompletionReason = "prompt-handoff" | "control-settlement" | "discard";
/** Read-only singleton hold projection; only the exact warm post-release admission carrier may supply completion. */
export interface BaleLiveSourceCompletionReadiness {
    readonly snapshot: BaleDeferredSourceSnapshot;
    /** Captured issuing owner/ports only; not a source disposition or canonical-release grant. */
    isCurrent(): boolean;
    bindCarrier(value: unknown): BaleDeferredSourceCompletionPreparation | undefined;
}
/** Process-local gate for fresh recipient input; never durable replay/custody or a binding grant. */
export interface BaleLiveInputPreparation {
    readonly sourceUpdateIds: readonly number[];
    /** Authority-only observation: no nested journal transaction under a Workspace snapshot. */
    isCurrent(): boolean;
    /** Same captured worker/source lifetime, including a finished warm preparation. */
    isOwnerCurrent(): boolean;
    confirmSaved(): boolean;
    /** Read/copy completion-owner availability after save, without claiming/admitting/dispatching the held input. */
    prepareSourceCompletion?(): BaleLiveSourceCompletionReadiness | undefined;
    /** Captures one same-source status continuation without activating future recipient authority. */
    prepareStatusConsumption?(input: BaleLiveStatusConsumption): boolean;
    /** Native owner availability before recipient append; not admission or future target activation. */
    canPrepareStatusConsumption?(): boolean;
    release(canRelease: () => boolean, target?: BaleTarget & {
        threadId: number;
    }): boolean;
    /** Ends a failed pre-append attempt only when no selected input was saved. */
    cancelEmpty(): boolean;
    /** One fenced removal of this never-dispatched recipient copy; unknown issuance cannot be retried. */
    discardSaved(canDiscard: () => boolean): "discarded" | "protected" | "unknown";
}
/** Routing owns continuation or positively released peer transfer; preparation never appends or reexecutes originals. */
export interface BaleLiveDeferredInputPreparation extends Pick<BaleLiveInputPreparation, "sourceUpdateIds" | "isCurrent" | "isOwnerCurrent" | "confirmSaved"> {
    beginRelease(canRelease: () => boolean): boolean;
    /** One exact donor-group removal after routing confirms peer release; unknown issuance never retries. */
    settleTransferred(canSettle: () => boolean): "settled" | "protected" | "unknown";
    cancel(): boolean;
}
export interface BaleDeferredSourceCompletionPreparation {
    readonly source: BaleDeferredSourceEvidence;
    /** Issuer lifetime remains observable after reporting/removal; never a settled/source-absence inference. */
    isCurrent(): boolean;
    /** One exact report after required command semantics; true is report acceptance, not a removal ACK. */
    reportCompleted(): boolean;
    /** Existing warm worker ACK only, read-only and without journal I/O or another report/removal. */
    inspectCompletion(): BaleDeferredSourceEvidence | undefined;
}
export interface BaleDeferredQueueAdmissionPreparation {
    /** Worker/session/journal/acquiring-owner lifetime, independent of the source's later queued report. */
    isCurrent(): boolean;
    /** Only the existing warm committed receipt owner can certify the same original; absence never permits replay. */
    inspectReceipt(receipt: BaleQueueAdmissionReceiptLike): {
        source: BaleDeferredSourceEvidence;
        receipt: BaleUpdateJournalQueuedCompletion;
    } | undefined;
    /** Read-only original/queued-owner CAS scope for the existing pre-publication boundary; never readiness or disposal. */
    prepareCompletionScope(receipt: BaleQueueAdmissionReceiptLike, queueOwner: BaleUpdateJournalQueueOwner, completionSha256: string): BaleQueueSourceCompletion | undefined;
    /** Exact previously observed receipt object's native whole-removal ACK; never admission, absence or another disposal. */
    inspectCompletion(receipt: BaleQueueAdmissionReceiptLike): BaleDeferredSourceEvidence | undefined;
}
export interface BaleUpdateWorkerRuntime<TContext> {
    start: (ctx: TContext) => void;
    /** Reserve absent IDs before recipient append; existing leader deferred sources use their original carrier. */
    prepareLiveInput?: (ctx: TContext, sourceUpdateIds: readonly number[], isCurrent?: () => boolean) => BaleLiveInputPreparation | undefined;
    prepareDeferredLiveInput?: (input: {
        updateId: number;
        sourceUpdateIds: readonly number[];
        signal: AbortSignal;
        isCurrent(): boolean;
        onTransferred?(): void;
    }) => BaleLiveDeferredInputPreparation | undefined;
    prepareDeferredQueueAdmission?: (input: {
        updateId: number;
        signal: AbortSignal;
    }) => BaleDeferredQueueAdmissionPreparation | undefined;
    prepareDeferredSourceCompletion?: (input: {
        updateId: number;
        signal: AbortSignal;
    }) => Pick<BaleDeferredSourceCompletionPreparation, "source" | "isCurrent"> | undefined;
    signal: () => void;
    settleDeferred: (input: {
        updateId: number;
        outcome: BaleUpdateAdmissionOutcome;
        signal: AbortSignal;
    }) => void | BaleDeferredSourceCompletion | Promise<void | BaleDeferredSourceCompletion>;
    armRoutingInput?: (input: {
        updateId: number;
        signal: AbortSignal;
        operatorUserId: number;
        sourceUpdateIds: readonly number[];
        chooser?: BaleUpdateJournalRoutingChooser;
    }) => BaleUpdateJournalRoutingInput | undefined;
    selectRoutingInput?: (input: {
        updateId: number;
        signal: AbortSignal;
        operatorUserId: number;
        sourceUpdateIds: readonly number[];
    }) => boolean;
    isRoutingInputCurrent?: (input: {
        updateId: number;
        signal: AbortSignal;
    }) => boolean;
    getRoutingInput?: (input: {
        updateId: number;
        signal: AbortSignal;
    }) => BaleUpdateJournalRoutingInput | undefined;
    supportsDeferredAbandonment?: (input: {
        updateId: number;
        signal: AbortSignal;
        journalBindingKey: string;
    }) => boolean;
    inspectAbandoning?: (input: BaleDeferredAbandonmentRecoveryRequest & {
        signal: AbortSignal;
    }) => BaleDeferredAbandonmentRecoveryPage | undefined;
    inspectHistorical?: (input: BaleDeferredAbandonmentRecoveryRequest & {
        signal: AbortSignal;
    }) => BaleDeferredAbandonmentRecoveryPage | undefined;
    inspectDeferredSource?: (input: {
        updateId: number;
        signal: AbortSignal;
    }) => BaleDeferredSourceEvidence | undefined;
    inspectDeferredSourceSnapshot?: (input: {
        updateId: number;
        signal: AbortSignal;
    }) => BaleDeferredSourceSnapshot | undefined;
    isHistoricalSource?: (input: {
        updateId: number;
        signal: AbortSignal;
        matchesOriginal?: BaleHistoricalInputPredicate;
    }) => boolean;
    abandonDeferred?: (input: BaleDeferredUpdateAbandonmentAuthority & {
        updateId: number;
        signal: AbortSignal;
    }) => BaleUpdateJournalPendingAbandonmentResult | undefined;
    settleCustodied: (input: {
        updateId: number;
        result: BaleCustodiedExecutionResult;
        signal: AbortSignal;
    }) => void;
    isQueueReceiptCommitted: (receipt: BaleQueueAdmissionReceiptLike) => boolean;
    getQueueReceiptOwner: (receipt: BaleQueueAdmissionReceiptLike) => BaleUpdateJournalQueueOwner | undefined;
    /** Completion-only owner observation; issued attempts are never dispatch readiness. */
    getQueueReceiptSettlementOwner?: (receipt: BaleQueueAdmissionReceiptLike, ctx: TContext, reason: BaleQueueReceiptCompletionReason) => BaleUpdateJournalQueueOwner | undefined;
    completeQueueReceipts: (input: {
        receipts: readonly BaleQueueAdmissionReceiptLike[];
        ctx: TContext;
        reason: BaleQueueReceiptCompletionReason;
        /** Prepared immutable scopes for every source; the exact receipt owner still authorizes disposal. */
        sourceCompletions?: readonly BaleQueueSourceCompletion[];
    }) => boolean;
    stop: () => Promise<void>;
    waitForDrain: () => Promise<void>;
    getState: () => BaleUpdateWorkerStateSnapshot;
}
export interface BaleLiveStatusConsumption {
    readonly source: BaleDeferredSourceEvidence;
    assertCurrent(): void;
    bindCarrier(value: unknown): boolean;
    execute(): Promise<boolean>;
}
export type BaleHistoricalReviewVerdict = boolean | "retain" | "revive";
/** A saved chooser clock that proves an untouched, unexpired choice whose chooser message can be revived. */
export declare function isRevivableBaleRoutingInput(entry: Pick<BaleUpdateJournalEntry, "state" | "routingInput">, nowMs: number): boolean;
export declare function createBaleUpdateWorkerRuntime<TContext>(deps: BaleUpdateWorkerRuntimeDeps<TContext>): BaleUpdateWorkerRuntime<TContext>;
/**
 * Verdict returned by a public Bale update handler.
 *
 * - `"consume"` — the handler processed this update; pi-bale skips default routing.
 * - `"pass"` (or `void`/`undefined`) — pi-bale routes the update normally.
 */
export type BaleUpdateHandlerVerdict = "consume" | "pass";
export interface BaleUpdateExecutionFence {
    readonly generation: number;
    readonly updateId: number;
    readonly signal: AbortSignal;
    isCurrent: () => boolean;
    assertCurrent: () => void;
}
export declare function getBaleUpdateExecutionFence(update: unknown): BaleUpdateExecutionFence | undefined;
export declare function assertBaleUpdateExecutionCurrent(update: unknown): void;
export declare function createBaleUpdateExecutionFenceGuard(update: unknown): () => void;
export declare function carryBaleUpdateExecutionFence<TTarget extends object>(source: unknown, target: TTarget): TTarget;
export type BaleUpdateHandler = (update: unknown, execution?: BaleUpdateExecutionFence) => BaleUpdateHandlerVerdict | void | Promise<BaleUpdateHandlerVerdict | void>;
export interface BaleUpdateHandlerRegistry {
    /** Schema version of this registry shape. */
    readonly version: 1;
    /**
     * Register an update handler. Returns a disposer that removes it.
     *
     * Handlers are invoked in registration order on every Bale update,
     * before pi-bale's own routing. The first handler that returns
     * `"consume"` wins and stops the chain for that update.
     */
    add: (handler: BaleUpdateHandler) => () => void;
    /**
     * Run all registered handlers against an update.
     *
     * Used by pi-bale's polling runtime; extension consumers should call
     * {@link registerBaleUpdateHandler} or `add` instead of dispatching directly.
     */
    dispatch: (update: unknown, execution?: BaleUpdateExecutionFence) => Promise<BaleUpdateHandlerVerdict>;
}
/**
 * Called by pi-bale's own runtime to obtain the registry it dispatches
 * through. Extension consumers should not call this; use
 * {@link registerBaleUpdateHandler} instead.
 */
export declare function getBaleUpdateHandlerRegistry(): BaleUpdateHandlerRegistry;
export interface BaleUpdateAdmissionHandleDeps<TUpdate extends BaleUpdateFlow & {
    update_id: number;
}, TContext> {
    defaultHandle: (update: TUpdate, ctx: TContext, execution?: BaleUpdateExecutionFence) => Promise<void>;
    registry?: BaleUpdateHandlerRegistry;
    onLateOutcome?: (outcome: BaleUpdateAdmissionOutcome, details: {
        updateId: number;
        ctx: TContext;
        signal: AbortSignal;
    }) => void | BaleDeferredSourceCompletion | Promise<void | BaleDeferredSourceCompletion>;
    onLateOutcomeError?: (error: unknown, updateId: number) => void;
    abandonDeferred?: BaleUpdateWorkerRuntime<TContext>["abandonDeferred"];
    armRoutingInput?: BaleUpdateWorkerRuntime<TContext>["armRoutingInput"];
    selectRoutingInput?: BaleUpdateWorkerRuntime<TContext>["selectRoutingInput"];
    isRoutingInputCurrent?: BaleUpdateWorkerRuntime<TContext>["isRoutingInputCurrent"];
    getRoutingInput?: BaleUpdateWorkerRuntime<TContext>["getRoutingInput"];
    supportsDeferredAbandonment?: BaleUpdateWorkerRuntime<TContext>["supportsDeferredAbandonment"];
    inspectAbandoning?: BaleUpdateWorkerRuntime<TContext>["inspectAbandoning"];
    inspectHistorical?: BaleUpdateWorkerRuntime<TContext>["inspectHistorical"];
    inspectDeferredSource?: BaleUpdateWorkerRuntime<TContext>["inspectDeferredSource"];
    inspectDeferredSourceSnapshot?: BaleUpdateWorkerRuntime<TContext>["inspectDeferredSourceSnapshot"];
    prepareDeferredLiveInput?: BaleUpdateWorkerRuntime<TContext>["prepareDeferredLiveInput"];
    prepareDeferredQueueAdmission?: BaleUpdateWorkerRuntime<TContext>["prepareDeferredQueueAdmission"];
    prepareDeferredSourceCompletion?: BaleUpdateWorkerRuntime<TContext>["prepareDeferredSourceCompletion"];
    isHistoricalSource?: BaleUpdateWorkerRuntime<TContext>["isHistoricalSource"];
}
export type BaleCustodiedExecutionResult = {
    status: "completed";
} | {
    status: "deferred";
    receipt: BaleInputJournalReceipt;
} | {
    status: "queued";
    queueReceipt: ReturnType<BaleInputJournalStore["queueInputs"]>["queueReceipt"];
} | {
    status: "outcome-unknown";
    receipt: BaleInputJournalReceipt;
};
type BaleCustodyExecutionJournal = Pick<BaleInputJournalStore, "acquireInput" | "startInput" | "completeInput" | "queueInputs">;
export declare function createBaleInputCustodyWorkerJournalPort(store: BaleInputJournalStore): BaleUpdateWorkerJournalPort & {
    inputCustody: BaleCustodyExecutionJournal;
};
export declare function createBaleInputCustodyLegacyDispositionRuntime(deps: {
    withBindingReference<T>(recoveryKey: string, operation: (binding: {
        recoveryKey: string;
        journal: Pick<BaleInputJournalStore, "listLegacyCustodyCandidates" | "applyLegacyCustodyDisposition">;
    }) => T): T;
}): {
    list(recoveryKey: string): import("./journal.ts").BaleUpdateJournalLegacyCustodyCandidate[];
    apply(recoveryKey: string, authority: Parameters<BaleInputJournalStore["applyLegacyCustodyDisposition"]>[0]): import("./journal.ts").BaleUpdateJournalLegacyCustodyDispositionResult;
};
export declare function createBaleInputCustodyHandoffClient(deps: {
    journal: Pick<BaleInputJournalStore, "offerInputHandoff">;
    resolveAcceptedReference?: (input: {
        sourceUpdateId: number;
        recipientBindingKey: string;
    }) => {
        sourceRecoveryKey: string;
        source: {
            updateId: number;
            owner: {
                acquisitionId: string;
                handoffId: string;
            };
        };
    } | undefined;
    sendEnvelope(envelope: Extract<BaleBusEnvelope, {
        kind: "leader.offerInputCustodyHandoff";
    }>): Promise<BaleBusEnvelope | undefined>;
}): {
    transfer(input: {
        requestId: string;
        receipt: BaleInputJournalReceipt;
        recipientInstanceId: string;
        recipientRegistrationGeneration: string;
        recipientBindingKey: string;
        recipientOwner: BaleUpdateJournalQueueOwnerIdentity;
        handoffToken: string;
        sentAtMs: number;
        auth?: string;
    }): Promise<{
        sourceRecoveryKey: string;
        source: {
            updateId: number;
            owner: {
                acquisitionId: string;
                handoffId: string;
            };
        };
        duplicate: boolean;
    }>;
};
export interface BaleInputCustodyHandoffAcceptanceInput {
    sourceRecoveryKey: string;
    recipientBindingKey: string;
    source: BaleInputJournalSourceReference;
    handoffId: string;
}
export declare function createBaleInputCustodyHandoffAcceptanceRuntime<TContext>(deps: {
    resolveBinding(recoveryKey: string): {
        recoveryKey: string;
        recipientBindingKey: string;
        recipientOwner: BaleUpdateJournalQueueOwnerIdentity;
        journal: Pick<BaleInputJournalStore, "acceptInputHandoff">;
        signalWorker(ctx: TContext): void;
    } | undefined;
}): {
    accept(input: BaleInputCustodyHandoffAcceptanceInput, ctx: TContext): {
        sourceRecoveryKey: string;
        source: {
            updateId: number;
            owner: {
                acquisitionId: string;
                handoffId: string;
            };
        };
        duplicate: boolean;
    };
};
export declare function createBaleInputCustodyForwardReferenceResolver(deps: {
    recoveryKey: string;
    recipientBindingKey: string;
    recipientOwner: BaleUpdateJournalQueueOwnerIdentity;
    journal: Pick<BaleInputJournalStore, "read">;
}): (input: {
    sourceUpdateId: number;
    recipientBindingKey: string;
}) => {
    sourceRecoveryKey: string;
    source: {
        updateId: number;
        owner: {
            acquisitionId: string;
            handoffId: string;
        };
    };
} | undefined;
export interface BaleCustodiedSourceReferenceWakeInput {
    deliveryId: string;
    sourceUpdateId: number;
    recipientBindingKey: string;
    sourceRecoveryKey: string;
    sourceClaim: {
        acquisitionId: string;
        handoffId: string;
    };
}
export declare function createBaleInputCustodySourceReferenceWakeRuntime<TContext>(deps: {
    resolveBinding(recoveryKey: string): {
        recoveryKey: string;
        recipientBindingKey: string;
        recipientOwner: BaleUpdateJournalQueueOwnerIdentity;
        journal: Pick<BaleInputJournalStore, "read">;
        signalWorker(ctx: TContext): void;
    } | undefined;
}): {
    wakeSource(input: BaleCustodiedSourceReferenceWakeInput, ctx: TContext): void;
};
export interface BaleInputCustodyBusBindingRuntime<TContext> {
    acceptHandoff(input: BaleInputCustodyHandoffAcceptanceInput, ctx: TContext): {
        sourceRecoveryKey: string;
        source: {
            updateId: number;
            owner: {
                acquisitionId: string;
                handoffId: string;
            };
        };
        duplicate: boolean;
    };
    wakeSource(input: BaleCustodiedSourceReferenceWakeInput, ctx: TContext): void;
    resolveForwardReference(input: {
        sourceUpdateId: number;
        recipientBindingKey: string;
    }): {
        sourceRecoveryKey: string;
        source: {
            updateId: number;
            owner: {
                acquisitionId: string;
                handoffId: string;
            };
        };
    } | undefined;
}
export declare function createBaleInputCustodyBusBindingRuntime<TContext>(deps: {
    getForwardRecoveryKey(): string | undefined;
    resolveBinding(recoveryKey: string): {
        recoveryKey: string;
        recipientBindingKey: string;
        recipientOwner: BaleUpdateJournalQueueOwnerIdentity;
        journal: Pick<BaleInputJournalStore, "read" | "acceptInputHandoff">;
        signalWorker(ctx: TContext): void;
    } | undefined;
}): BaleInputCustodyBusBindingRuntime<TContext>;
export type BaleInputCustodyActivationBlocker = "disabled" | "source-unready" | "legacy-writers-present" | "migration-incomplete" | "peer-capability-mismatch";
export declare function evaluateBaleInputCustodyActivationReadiness(input: {
    requested: boolean;
    sourceStatus: "absent" | "v3" | "legacy" | "unsupported" | "ambiguous";
    legacyWritersExcluded: boolean;
    historicalMigrationComplete: boolean;
    peerReadiness: readonly ("ready" | "legacy" | "unknown")[];
}): {
    enabled: true;
} | {
    enabled: false;
    blocker: BaleInputCustodyActivationBlocker;
};
export interface BaleInputCustodyReadinessEvidenceSnapshot {
    version: 1;
    revision: number;
    writerExclusion?: BaleInputCustodyWriterExclusionEvidence;
    migration?: BaleInputCustodyMigrationEvidence;
    startupExclusion?: BaleInputCustodyStartupExclusionAuthority;
    migrationCompletion?: BaleInputCustodyMigrationCompletionAuthority;
}
export declare function createBaleInputCustodyReadinessEvidenceStore(deps: {
    readRetained(): string | undefined;
    publishRetained(serialized: string): void;
    withSerialization<T>(operation: () => T): T;
    authorizePublication(kind: "writer-exclusion" | "migration" | "startup-exclusion" | "migration-completion", evidence: BaleInputCustodyWriterExclusionEvidence | BaleInputCustodyMigrationEvidence | BaleInputCustodyStartupExclusionAuthority | BaleInputCustodyMigrationCompletionAuthority): boolean;
}): {
    read: () => BaleInputCustodyReadinessEvidenceSnapshot;
    publish: (input: {
        expectedRevision: number;
    } & ({
        kind: "writer-exclusion";
        evidence: BaleInputCustodyWriterExclusionEvidence;
    } | {
        kind: "migration";
        evidence: BaleInputCustodyMigrationEvidence;
    } | {
        kind: "startup-exclusion";
        evidence: BaleInputCustodyStartupExclusionAuthority;
    } | {
        kind: "migration-completion";
        evidence: BaleInputCustodyMigrationCompletionAuthority;
    })) => BaleInputCustodyReadinessEvidenceSnapshot;
};
export interface BaleInputCustodyActivationEvidenceIdentity {
    profileKey: string;
    recoveryKey: string;
}
export interface BaleInputCustodyStartupExclusionAuthority extends BaleInputCustodyActivationEvidenceIdentity {
    version: 1;
    status: "enforced" | "revoked";
    authorityId: string;
    closureOperationId: string;
    writerInventorySha256: string;
    allowedWriterProtocol: "custody-v3";
    authorizedAtMs: number;
}
export declare function normalizeBaleInputCustodyStartupExclusionAuthority(value: unknown, expected: BaleInputCustodyActivationEvidenceIdentity): BaleInputCustodyStartupExclusionAuthority | undefined;
export interface BaleInputCustodyWriterExclusionEvidence extends BaleInputCustodyActivationEvidenceIdentity {
    version: 1;
    status: "excluded" | "present" | "unknown";
    startupAuthorityId?: string;
    closureOperationId?: string;
    writerInventorySha256?: string;
}
export interface BaleInputCustodyWriterInventory extends BaleInputCustodyActivationEvidenceIdentity {
    complete: boolean;
    writerInventorySha256: string;
    writers: readonly {
        processId: number;
        processBirthId: string;
    }[];
}
export declare function evaluateBaleInputCustodyWriterExclusionEvidence(input: {
    expected: BaleInputCustodyActivationEvidenceIdentity;
    inventory: BaleInputCustodyWriterInventory;
    startupAuthority: BaleInputCustodyStartupExclusionAuthority | undefined;
    getProcessLiveness(writer: {
        processId: number;
        processBirthId: string;
    }): BaleProcessLiveness;
}): BaleInputCustodyWriterExclusionEvidence;
export interface BaleInputCustodyMigrationCompletionAuthority extends BaleInputCustodyActivationEvidenceIdentity {
    version: 1;
    status: "authorized" | "revoked";
    authorityId: string;
    startupAuthorityId: string;
    closureOperationId: string;
    migrationInventorySha256: string;
    resultingSourceFamily: "absent" | "v3";
    authorizedAtMs: number;
}
export declare function normalizeBaleInputCustodyMigrationCompletionAuthority(value: unknown, expected: BaleInputCustodyActivationEvidenceIdentity): BaleInputCustodyMigrationCompletionAuthority | undefined;
export interface BaleInputCustodyMigrationEvidence extends BaleInputCustodyActivationEvidenceIdentity {
    version: 1;
    status: "complete" | "incomplete" | "unknown";
    migrationAuthorityId?: string;
    startupAuthorityId?: string;
    closureOperationId?: string;
    migrationInventorySha256?: string;
    resultingSourceFamily?: "absent" | "v3";
}
export type BaleInputCustodyWriterCutoverResult<TMode> = {
    kind: "blocked";
    blocker: "startup-authority" | "writer-inventory";
    evidence?: BaleInputCustodyWriterExclusionEvidence;
} | {
    kind: "completed";
    mode: TMode;
    evidence: BaleInputCustodyWriterExclusionEvidence;
    resumed: boolean;
};
export declare function executeBaleInputCustodyWriterCutover<TClosure extends {
    operationId: string;
    profileKey: string;
    recoveryKey: string;
}, TMode extends BaleInputCustodyWriterProtocolModeEvidence>(input: {
    expected: BaleInputCustodyActivationEvidenceIdentity;
    closure: TClosure;
    startupAuthority: BaleInputCustodyStartupExclusionAuthority;
    inventory: BaleInputCustodyWriterInventory;
    getProcessLiveness(writer: {
        processId: number;
        processBirthId: string;
    }): BaleProcessLiveness;
    installProtocolMode(closure: TClosure, authority: {
        startupAuthorityId: string;
        writerInventorySha256: string;
    }): {
        mode: TMode;
        resumed: boolean;
    };
    evidenceStore: {
        read(): BaleInputCustodyReadinessEvidenceSnapshot;
        publish(input: {
            expectedRevision: number;
            kind: "writer-exclusion";
            evidence: BaleInputCustodyWriterExclusionEvidence;
        }): BaleInputCustodyReadinessEvidenceSnapshot;
    };
}): BaleInputCustodyWriterCutoverResult<TMode>;
export type BaleInputCustodyMigrationCompletionResult = {
    kind: "blocked";
    blocker: "migration-authority" | "source-drift" | "inventory-drift";
} | {
    kind: "completed";
    evidence: BaleInputCustodyMigrationEvidence;
    resumed: boolean;
};
export declare function executeBaleInputCustodyMigrationCompletion(input: {
    expected: BaleInputCustodyActivationEvidenceIdentity;
    authority: BaleInputCustodyMigrationCompletionAuthority;
    migrationInventorySha256: string;
    inspectSource(): "absent" | "v3" | "legacy" | "unsupported" | "ambiguous";
    evidenceStore: {
        read(): BaleInputCustodyReadinessEvidenceSnapshot;
        publish(input: {
            expectedRevision: number;
            kind: "migration";
            evidence: BaleInputCustodyMigrationEvidence;
        }): BaleInputCustodyReadinessEvidenceSnapshot;
    };
}): BaleInputCustodyMigrationCompletionResult;
export interface BaleInputCustodyWriterProtocolModeEvidence extends BaleInputCustodyActivationEvidenceIdentity {
    protocol: "custody-v3";
    startupAuthorityId: string;
    closureOperationId: string;
    writerInventorySha256: string;
}
export declare function createBaleInputCustodyProvenReadinessResolver(deps: {
    isRequested(): boolean;
    expectedIdentity(): BaleInputCustodyActivationEvidenceIdentity;
    inspectSource(): "absent" | "v3" | "legacy" | "unsupported" | "ambiguous";
    readWriterExclusionEvidence(): BaleInputCustodyWriterExclusionEvidence | undefined;
    readStartupExclusionAuthority(): BaleInputCustodyStartupExclusionAuthority | undefined;
    readWriterProtocolMode(): BaleInputCustodyWriterProtocolModeEvidence | undefined;
    readMigrationCompletionAuthority(): BaleInputCustodyMigrationCompletionAuthority | undefined;
    readMigrationEvidence(): BaleInputCustodyMigrationEvidence | undefined;
    listPeerReadiness(): readonly ("ready" | "legacy" | "unknown")[];
}): () => ReturnType<typeof evaluateBaleInputCustodyActivationReadiness>;
export declare function createBaleInputCustodyActivationReadinessResolver(deps: {
    isRequested(): boolean;
    inspectSource(): "absent" | "v3" | "legacy" | "unsupported" | "ambiguous";
    areLegacyWritersExcluded(): boolean;
    isHistoricalMigrationComplete(): boolean;
    listPeerReadiness(): readonly ("ready" | "legacy" | "unknown")[];
}): () => ReturnType<typeof evaluateBaleInputCustodyActivationReadiness>;
export declare function createBaleInputCustodyLifecycleBindingResolver(deps: {
    isEnabled(): boolean;
    resolveInputJournal(): {
        runtimeKey: string;
        recoveryKey: string;
        journal: BaleInputJournalStore;
    } | undefined;
    getRecipientBindingKey(): string | undefined;
}): () => BaleUpdateAdmissionLifecycleJournalBinding | undefined;
export declare function createBaleCustodiedExecutionSession(input: {
    journal: BaleCustodyExecutionJournal;
    recipientBindingKey: string;
}): {
    execute(update: BaleJournaledUpdate, handler: (update: BaleJournaledUpdate) => Promise<BaleUpdateAdmissionOutcome>): Promise<BaleCustodiedExecutionResult>;
    settle(updateId: number, outcome: BaleUpdateAdmissionOutcome): Promise<BaleCustodiedExecutionResult>;
};
export declare function executeBaleCustodiedInput(input: {
    journal: BaleCustodyExecutionJournal;
    update: BaleJournaledUpdate;
    recipientBindingKey: string;
    execute(update: BaleJournaledUpdate): Promise<BaleUpdateAdmissionOutcome>;
}): Promise<BaleCustodiedExecutionResult>;
/**
 * Compose the stable public handler registry with source-bound semantic
 * admission. Production polling switches to this only with the journal worker.
 */
export declare function createBaleUpdateAdmissionHandle<TUpdate extends BaleUpdateFlow & {
    update_id: number;
}, TContext>(deps: BaleUpdateAdmissionHandleDeps<TUpdate, TContext>): (update: TUpdate, ctx: TContext, signal: AbortSignal) => Promise<BaleUpdateAdmissionOutcome>;
export declare function createBaleCustodiedUpdateAdmissionHandle<TUpdate extends BaleJournaledUpdate & BaleUpdateFlow, TContext>(deps: Omit<BaleUpdateAdmissionHandleDeps<TUpdate, TContext>, "onLateOutcome" | "onLateOutcomeError" | "abandonDeferred" | "armRoutingInput" | "getRoutingInput" | "selectRoutingInput" | "isRoutingInputCurrent" | "supportsDeferredAbandonment" | "inspectAbandoning" | "inspectHistorical" | "inspectDeferredSource" | "inspectDeferredSourceSnapshot" | "prepareDeferredLiveInput" | "prepareDeferredQueueAdmission" | "prepareDeferredSourceCompletion" | "isHistoricalSource"> & {
    journal: BaleCustodyExecutionJournal;
    recipientBindingKey: string;
    onLateOutcomeError(error: unknown, updateId: number): void;
    onCustodiedLateSettlement?: (result: BaleCustodiedExecutionResult, details: {
        updateId: number;
        signal: AbortSignal;
    }) => void;
}): (update: TUpdate, ctx: TContext, signal: AbortSignal) => Promise<BaleCustodiedExecutionResult>;
export interface BaleQueueAdmissionItemLike {
    admissionReceipts?: readonly BaleQueueAdmissionReceiptLike[];
}
export interface BaleQueueAdmissionSettlementRuntime<TContext> {
    isItemReady: (item: BaleQueueAdmissionItemLike) => boolean;
    getQueueReceiptSettlementOwner?: (receipt: BaleQueueAdmissionReceiptLike, ctx: TContext, reason: BaleQueueReceiptCompletionReason) => BaleUpdateJournalQueueOwner | undefined;
    getQueueReceiptOwner: (receipt: BaleQueueAdmissionReceiptLike) => BaleUpdateJournalQueueOwner | undefined;
    onPromptHandedOff: (item: BaleQueueAdmissionItemLike, ctx: TContext) => boolean;
    onControlSettled: (item: BaleQueueAdmissionItemLike, ctx: TContext) => boolean;
    onItemsDiscarded: (items: readonly BaleQueueAdmissionItemLike[], ctx: TContext) => boolean;
}
export declare function createBaleQueueAdmissionSettlementMuxRuntime<TContext>(runtimes: readonly BaleQueueAdmissionSettlementRuntime<TContext>[]): BaleQueueAdmissionSettlementRuntime<TContext>;
export declare function createBaleQueueAdmissionSettlementRuntime<TContext>(worker: BaleUpdateWorkerRuntime<TContext>): BaleQueueAdmissionSettlementRuntime<TContext>;
export interface BaleUpdateAdmissionLifecycleJournalBinding {
    runtimeKey: string;
    recoveryKey: string;
    recipientBindingKey?: string;
    journal: BaleUpdateWorkerJournalPort & {
        inputCustody?: BaleCustodyExecutionJournal;
        appendBatch: (updates: readonly BaleJournaledUpdate[], acceptedThroughUpdateId?: number) => Pick<BaleUpdateJournalAppendResult, "nonExcludedUpdateIds">;
        applyOperatorDisposition?: (input: BaleUpdateJournalOperatorDispositionInput) => BaleUpdateJournalOperatorDispositionResult;
        discardQueued?: (input: {
            queueKind: "prompt" | "control";
            receiptId: string;
            sourceUpdateIds: readonly number[];
            expectedOwner: BaleUpdateJournalQueueOwner;
        }) => BaleUpdateJournalQueueDiscardResult;
        offerQueuedHandoff?: (input: BaleUpdateJournalQueueHandoffInput) => BaleUpdateJournalQueueHandoffOfferResult;
        acceptQueuedHandoff?: (input: BaleUpdateJournalQueueHandoffInput) => BaleUpdateJournalQueueHandoffAcceptResult;
        cancelQueuedHandoff?: (input: BaleUpdateJournalQueueHandoffInput) => BaleUpdateJournalQueueHandoffCancelResult;
        recoverDeadQueueOwner?: (input: {
            queueKind: "prompt" | "control";
            receiptId: string;
            sourceUpdateIds: readonly number[];
            deadOwner: BaleUpdateJournalQueueOwner;
            recoveryOwner: BaleUpdateJournalQueueOwnerIdentity;
        }) => BaleUpdateJournalDeadQueueOwnerRecoveryResult;
    };
    hasAuthority?: () => boolean;
}
export interface BaleQueueHandoffControlExecutionDeps<TContext> {
    isContextCurrent: (ctx: TContext) => boolean;
    showStatus: (chatId: number, replyToMessageId: number, ctx: TContext, threadId?: number) => Promise<void>;
    openModelMenu: (chatId: number, replyToMessageId: number, ctx: TContext, threadId?: number) => Promise<void>;
}
export declare function createBaleQueueHandoffControlExecutionFactory<TContext>(deps: BaleQueueHandoffControlExecutionDeps<TContext>): (payload: BaleControlQueueHandoffPayload) => PendingBaleControlItem<TContext>["execute"];
export interface BaleQueueHandoffCoordinatorInput<TContext> {
    item: BaleQueueItem<TContext>;
    steerSupported?: boolean;
    expectedOwner: BaleUpdateJournalQueueOwner;
    recipientOwner: BaleUpdateJournalQueueOwnerIdentity;
    handoffToken: string;
    stageRemote: (input: {
        handoffToken: string;
        expectedOwner: BaleUpdateJournalQueueOwner;
        recipientOwner: BaleUpdateJournalQueueOwnerIdentity;
        payload: BaleQueueHandoffPayload;
    }) => Promise<BaleQueueHandoffStageResult>;
    lifecycle: Pick<BaleUpdateAdmissionLifecycleRuntime<TContext>, "offerQueueReceiptHandoff" | "acceptQueueReceiptHandoff" | "cancelQueueReceiptHandoff">;
    removeDonorItem: (receipt: BaleQueueAdmissionReceipt) => boolean;
}
export type BaleQueueHandoffCoordinatorResult = {
    status: "transferred";
    receipt: BaleQueueAdmissionReceipt;
    queueOwner: BaleUpdateJournalQueueOwner;
} | {
    status: "retained";
    receipt: BaleQueueAdmissionReceipt;
    error: unknown;
    cancelled: boolean;
};
export declare function coordinateBaleQueueHandoff<TContext>(input: BaleQueueHandoffCoordinatorInput<TContext>): Promise<BaleQueueHandoffCoordinatorResult>;
export interface BaleQueueHandoffReconciliationBinding<TContext> {
    request: (ctx: TContext) => void;
    set: (reconcile: (ctx: TContext) => Promise<void>) => void;
}
export declare function createBaleQueueHandoffReconciliationBinding<TContext>(recordFailure?: (error: unknown) => void): BaleQueueHandoffReconciliationBinding<TContext>;
export interface BaleQueueHandoffRecipientRuntimeDeps<TContext> {
    staging: BaleQueueHandoffStagingRuntime;
    getRecipientOwner: () => BaleUpdateJournalQueueOwnerIdentity;
    getLifecycleForBinding: (journalBindingKey: string) => BaleUpdateAdmissionLifecycleRuntime<TContext> | undefined;
    isTransportStampActive?: (stamp: BaleQueueHandoffPayload["transportStamp"]) => boolean;
    dispatchNext: (ctx: TContext) => void;
}
export declare function createBaleQueueHandoffRecipientRuntime<TContext>(deps: BaleQueueHandoffRecipientRuntimeDeps<TContext>): (envelope: Extract<BaleBusEnvelope, {
    kind: "leader.offerQueueHandoff";
}>, ctx: TContext) => Promise<BaleQueueHandoffStageResult>;
export interface BaleQueueHandoffReconcilerDeps<TContext> {
    canHandoffSteerWithRecipient?: (recipient: BaleBusFollowerView) => boolean;
    hasPendingDispatch?: () => boolean;
    ownsDirect: () => boolean;
    isFollowerRegistered: () => boolean;
    isBusEnabled: () => boolean;
    canHandoffWithLeader?: () => boolean;
    listFollowers: () => readonly BaleBusFollowerView[];
    createRecipientJournalBindingKey: (recipient: BaleBusFollowerView) => string | undefined;
    getQueuedItems: () => readonly BaleQueueItem<TContext>[];
    getReceiptOwner: (receipt: BaleQueueAdmissionReceipt) => BaleUpdateJournalQueueOwner | undefined;
    getLifecycleForReceipt: (receipt: BaleQueueAdmissionReceipt) => BaleUpdateAdmissionLifecycleRuntime<TContext> | undefined;
    createHandoffToken: () => string;
    createRequestId: () => string;
    donorInstanceId: string;
    authSecret?: string;
    stageThroughFollower: (input: {
        recipient: BaleBusFollowerView;
        expectedOwner: BaleUpdateJournalQueueOwner;
        handoffToken: string;
        payload: BaleQueueHandoffPayload;
    }) => Promise<BaleQueueHandoffStageResult>;
    routeThroughLeader: (input: BaleBusLeaderQueueHandoffOffer) => Promise<BaleBusEnvelope>;
    removeDonorItem: (receipt: BaleQueueAdmissionReceipt, ctx: TContext) => boolean;
    recordFailure?: (error: unknown, details: Record<string, unknown>) => void;
}
export interface BaleQueueHandoffReconciliationRuntimeAssemblyDeps<TContext> {
    canHandoffSteerWithRecipient?: (recipient: BaleBusFollowerView) => boolean;
    hasPendingDispatch?: () => boolean;
    ownsDirect: () => boolean;
    isFollowerRegistered: () => boolean;
    isBusEnabled: () => boolean;
    canHandoffWithLeader?: () => boolean;
    listFollowers: () => readonly BaleBusFollowerView[];
    createRecipientJournalResolver: (profileKey: string, sessionId: string) => () => {
        recoveryKey: string;
    } | undefined;
    queueStore: {
        getQueuedItems: () => BaleQueueItem<TContext>[];
        setQueuedItems: (items: BaleQueueItem<TContext>[]) => void;
    };
    admission: Pick<BaleUpdateAdmissionRuntimeBinding<TContext>, "getSettlement" | "getLifecycleForJournalBinding">;
    createHandoffToken: () => string;
    createRequestId: () => string;
    donorInstanceId: string;
    authSecret?: string;
    stageThroughFollower: (input: BaleBusFollowerQueueHandoffOffer) => Promise<BaleQueueHandoffStageResult>;
    routeThroughLeader: BaleQueueHandoffReconcilerDeps<TContext>["routeThroughLeader"];
    recordRuntimeEvent?: (category: string, error: unknown, details?: Record<string, unknown>) => void;
}
/** Own queue-handoff projections over journals, admission, IPC, and live queue state. */
export declare function createBaleQueueHandoffReconciliationRuntimeAssembly<TContext>(deps: BaleQueueHandoffReconciliationRuntimeAssemblyDeps<TContext>): (ctx: TContext) => Promise<void>;
export declare function createBaleQueueHandoffReconciler<TContext>(deps: BaleQueueHandoffReconcilerDeps<TContext>): (ctx: TContext) => Promise<void>;
export interface BaleQueueMutationDependencyItem {
    chatId: number;
    target?: {
        chatId: number;
    };
    replyToMessageId: number;
    sourceMessageIds?: readonly number[];
}
export interface BaleUpdateAdmissionLifecycleRuntimeDeps<TContext> {
    resolveBinding: () => BaleUpdateAdmissionLifecycleJournalBinding | undefined;
    getQueueOwnerIdentity?: (ctx: TContext) => BaleUpdateJournalQueueOwnerIdentity;
    createWorker: (journal: BaleUpdateWorkerJournalPort, binding: BaleUpdateAdmissionLifecycleJournalBinding) => BaleUpdateWorkerRuntime<TContext>;
    acquireSourceReference?: (binding: BaleUpdateAdmissionLifecycleJournalBinding) => () => void;
    /** Runs after the previous worker stopped and before the replacement worker exists; throwing refuses binding. */
    prepareBinding?: (binding: BaleUpdateAdmissionLifecycleJournalBinding) => void;
    recordRuntimeEvent?: BaleUpdateWorkerRuntimeDeps<TContext>["recordRuntimeEvent"];
}
export interface BaleUpdateAdmissionLifecycleRuntime<TContext> extends BaleQueueAdmissionSettlementRuntime<TContext> {
    onSessionStart: (ctx: TContext) => Promise<void>;
    onSessionShutdown: () => Promise<void>;
    onTransportChanged: (ctx?: TContext) => Promise<void>;
    appendBatch: (updates: readonly BaleJournaledUpdate[], acceptedThroughUpdateId?: number) => Pick<BaleUpdateJournalAppendResult, "nonExcludedUpdateIds">;
    discardQueueReceipt: (input: {
        queueKind: "prompt" | "control";
        receiptId: string;
        sourceUpdateIds: readonly number[];
        expectedOwner: BaleUpdateJournalQueueOwner;
    }) => BaleUpdateJournalQueueDiscardResult;
    recoverDeadQueueReceipt: (input: {
        queueKind: "prompt" | "control";
        receiptId: string;
        sourceUpdateIds: readonly number[];
        deadOwner: BaleUpdateJournalQueueOwner;
        recoveryOwner: BaleUpdateJournalQueueOwnerIdentity;
    }) => BaleUpdateJournalDeadQueueOwnerRecoveryResult;
    offerQueueReceiptHandoff: (input: BaleUpdateJournalQueueHandoffInput) => BaleUpdateJournalQueueHandoffOfferResult;
    acceptQueueReceiptHandoff: (input: BaleUpdateJournalQueueHandoffInput) => BaleUpdateJournalQueueHandoffAcceptResult;
    cancelQueueReceiptHandoff: (input: BaleUpdateJournalQueueHandoffInput) => BaleUpdateJournalQueueHandoffCancelResult;
    publishAcceptedQueueReceipt: (input: {
        receipt: BaleQueueAdmissionReceiptLike;
        queueOwner: BaleUpdateJournalQueueOwner;
        ctx: TContext;
    }) => Promise<void>;
    getQueueReceiptOwner: (receipt: BaleQueueAdmissionReceiptLike) => BaleUpdateJournalQueueOwner | undefined;
    getJournalBindingKey: () => string | undefined;
    getJournalPath: () => string | undefined;
    ownsJournalBinding: (journalBindingKey: string) => boolean;
    getJournalEntryCount: () => number;
    getForeignQueueOwnerLiveness: () => BaleProcessLiveness | undefined;
    hasPendingQueueMutationForItem: (item: BaleQueueMutationDependencyItem) => boolean;
    signal: () => void;
    /** Fresh recipient input only; the leader's existing deferred original keeps its original carrier. */
    prepareLiveInput?: BaleUpdateWorkerRuntime<TContext>["prepareLiveInput"];
    getState: () => BaleUpdateWorkerStateSnapshot | undefined;
}
export interface BaleUpdateWorkerOwnerRuntime<TContext> {
    getQueueOwnerIdentity: () => BaleUpdateJournalQueueOwnerIdentity;
    onQueueReceiptCommitted: (receipt: BaleQueueAdmissionReceiptLike, ctx: TContext) => void;
    onUpdateCompleted: (updateId: number, ctx: TContext, journalBindingKey?: string) => void;
}
export interface BaleUpdateWorkerOwnerRuntimeDeps<TContext> {
    instanceId: string;
    processId: number;
    processBirthId: string;
    getSessionGeneration: () => number;
    isContextCurrent: (ctx: TContext) => boolean;
    dispatchNext: (ctx: TContext) => void;
    requestQueueHandoffReconciliation: (ctx: TContext) => void;
    afterQueueReceiptCommitted?: (receipt: BaleQueueAdmissionReceiptLike, ctx: TContext) => void;
    afterUpdateCompleted?: (updateId: number, ctx: TContext, journalBindingKey?: string) => void;
}
export declare function createBaleUpdateWorkerOwnerRuntime<TContext>(deps: BaleUpdateWorkerOwnerRuntimeDeps<TContext>): BaleUpdateWorkerOwnerRuntime<TContext>;
export interface BaleUpdateAdmissionRuntimeBinding<TContext> {
    bind: (input: {
        leader: BaleUpdateAdmissionLifecycleRuntime<TContext>;
        follower: BaleUpdateAdmissionLifecycleRuntime<TContext>;
        inputCustodyBus?: BaleInputCustodyBusBindingRuntime<TContext>;
    }) => void;
    getLeader: () => BaleUpdateAdmissionLifecycleRuntime<TContext> | undefined;
    getFollower: () => BaleUpdateAdmissionLifecycleRuntime<TContext> | undefined;
    getActive: () => BaleUpdateAdmissionLifecycleRuntime<TContext> | undefined;
    getSettlement: () => BaleQueueAdmissionSettlementRuntime<TContext> | undefined;
    getInputCustodyBus: () => BaleInputCustodyBusBindingRuntime<TContext> | undefined;
    getLifecycleForJournalBinding: (journalBindingKey: string) => BaleUpdateAdmissionLifecycleRuntime<TContext> | undefined;
    hasPendingQueueMutationForItem: (item: BaleQueueMutationDependencyItem) => boolean;
    onSessionShutdown: () => Promise<void>;
}
export declare function createBaleUpdateAdmissionRuntimeBinding<TContext>(deps: {
    isFollowerRegistered: () => boolean;
}): BaleUpdateAdmissionRuntimeBinding<TContext>;
/** Own one worker per active transport identity without assuming queued-owner death. */
export declare function createBaleUpdateAdmissionLifecycleRuntime<TContext>(deps: BaleUpdateAdmissionLifecycleRuntimeDeps<TContext>): BaleUpdateAdmissionLifecycleRuntime<TContext>;
export interface BaleUpdateAdmissionLifecycleAssembly<TContext> {
    leader: BaleUpdateAdmissionLifecycleRuntime<TContext>;
    follower: BaleUpdateAdmissionLifecycleRuntime<TContext>;
}
export interface BaleUpdateAdmissionLifecycleAssemblyDeps<TUpdate extends BaleJournaledUpdate & BaleUpdateFlow, TContext> {
    runtimeBinding: BaleUpdateAdmissionRuntimeBinding<TContext>;
    inputCustodyBus?: BaleInputCustodyBusBindingRuntime<TContext>;
    acquireSourceReference?: (role: "leader" | "follower", binding: BaleUpdateAdmissionLifecycleJournalBinding) => () => void;
    worker: Omit<BaleUpdateAdmissionWorkerRuntimeDeps<TUpdate, TContext>, "journal" | "getJournalBindingKey" | "getRecipientBindingKey" | "hasAuthority" | "prepareUpdateForExecution">;
    leader: {
        resolveBinding: () => BaleUpdateAdmissionLifecycleJournalBinding | undefined;
        hasAuthority: (ctx: TContext) => boolean;
    };
    follower: {
        resolveBinding: () => BaleUpdateAdmissionLifecycleJournalBinding | undefined;
        isRegistered: () => boolean;
        getGeneration: () => string | undefined;
        prepareUpdateForExecution: (update: TUpdate) => TUpdate;
        /** Session succession before worker creation, under the exact generation-fenced binding. */
        prepareBinding?: (binding: BaleUpdateAdmissionLifecycleJournalBinding & {
            hasAuthority?: () => boolean;
        }) => void;
    };
    recordRuntimeEvent?: BaleUpdateWorkerRuntimeDeps<TContext>["recordRuntimeEvent"];
}
export type BaleUpdateAdmissionWorkerRuntimeDeps<TUpdate extends BaleJournaledUpdate & BaleUpdateFlow, TContext> = Omit<BaleUpdateWorkerRuntimeDeps<TContext>, "executeUpdate" | "executeCustodiedUpdate"> & {
    inputCustody?: BaleCustodyExecutionJournal;
    defaultHandle: (update: TUpdate, ctx: TContext, execution?: BaleUpdateExecutionFence) => Promise<void>;
    prepareUpdateForExecution?: (update: TUpdate) => TUpdate;
    registry?: BaleUpdateHandlerRegistry;
};
/** Compose source-bound routing and late grouped settlement under one worker. */
export declare function createBaleUpdateAdmissionWorkerRuntime<TUpdate extends BaleJournaledUpdate & BaleUpdateFlow, TContext>(deps: BaleUpdateAdmissionWorkerRuntimeDeps<TUpdate, TContext>): BaleUpdateWorkerRuntime<TContext>;
/** Own leader/follower journal lifecycle construction and generation fencing. */
export declare function createBaleUpdateAdmissionLifecycleAssembly<TUpdate extends BaleJournaledUpdate & BaleUpdateFlow, TContext>(deps: BaleUpdateAdmissionLifecycleAssemblyDeps<TUpdate, TContext>): BaleUpdateAdmissionLifecycleAssembly<TContext>;
export interface BaleUpdateAdmissionRuntimeAssembly<TContext> extends BaleUpdateAdmissionLifecycleAssembly<TContext> {
    owner: BaleUpdateWorkerOwnerRuntime<TContext>;
}
export type BaleUpdateAdmissionRuntimeAssemblyDeps<TUpdate extends BaleJournaledUpdate & BaleUpdateFlow, TContext> = Omit<BaleUpdateAdmissionLifecycleAssemblyDeps<TUpdate, TContext>, "worker" | "recordRuntimeEvent"> & {
    owner: BaleUpdateWorkerOwnerRuntimeDeps<TContext>;
    worker: Omit<BaleUpdateAdmissionLifecycleAssemblyDeps<TUpdate, TContext>["worker"], keyof BaleUpdateWorkerOwnerRuntime<TContext> | "isContextCurrent" | "recordRuntimeEvent">;
    recordRuntimeEvent?: BaleUpdateWorkerRuntimeDeps<TContext>["recordRuntimeEvent"];
};
/** Own queue-owner projection and shared leader/follower worker composition. */
export declare function createBaleUpdateAdmissionRuntimeAssembly<TUpdate extends BaleJournaledUpdate & BaleUpdateFlow, TContext>(deps: BaleUpdateAdmissionRuntimeAssemblyDeps<TUpdate, TContext>): BaleUpdateAdmissionRuntimeAssembly<TContext>;
/**
 * Register a handler that runs before pi-bale routes a Bale update
 * through its built-in handlers.
 *
 * This is the low-level public surface for extensions that share the same bot
 * and Pi process with pi-bale.
 */
export declare function registerBaleUpdateHandler(handler: BaleUpdateHandler): () => void;
export {};

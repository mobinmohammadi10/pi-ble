/**
 * Bale queue core contracts and pure planning helpers
 * Zones: bale queue, pi agent lifecycle, scheduling
 * Owns queue item contracts, lane admission, mutations, dispatch planning, and protected Steer publication attempts
 */
import { type TurnEndEvent, type TurnEndEventResult } from "./pi.ts";
export interface QueuedAttachment {
    path: string;
    fileName: string;
}
export interface BalePromptTextContent {
    type: "text";
    text: string;
}
export interface BalePromptImageContent {
    type: "image";
    data: string;
    mimeType: string;
}
export type BalePromptContent = BalePromptTextContent | BalePromptImageContent;
export type BaleQueueItemKind = "prompt" | "control";
export type BaleQueueLane = "control" | "steer" | "priority" | "default";
export type BaleQueueReactionDisposition = {
    kind: "default";
} | {
    kind: "priority";
    emoji: string;
} | {
    kind: "suppressed";
    emoji: string;
} | {
    kind: "priority-suppressed";
    priorityEmoji: string;
    suppressionEmoji: string;
} | {
    kind: "reaction-transition";
    promptLane?: Exclude<BaleQueueLane, "control">;
    priorityEmoji?: string | null;
    suppressionEmoji?: string | null;
};
export interface BaleQueueAdmissionReceipt {
    queueKind: BaleQueueItemKind;
    receiptId: string;
    sourceUpdateIds: readonly number[];
    journalBindingKey?: string;
}
export type BaleQueueAdmissionMode = "control-queue" | "steer-queue" | "priority-queue" | "default-queue";
export interface BaleQueueLaneContract {
    lane: BaleQueueLane;
    admissionMode: BaleQueueAdmissionMode;
    dispatchRank: number;
    allowedKinds: readonly BaleQueueItemKind[];
}
export declare const BALE_QUEUE_LANE_CONTRACTS: readonly BaleQueueLaneContract[];
export interface BaleQueueTarget {
    chatId: number;
    threadId?: number;
}
export interface BaleTransportStamp {
    profile: string;
    generation: string;
}
export interface BaleTransportStampRuntime {
    getStamp(): BaleTransportStamp;
    isActive(stamp: BaleTransportStamp | undefined): boolean;
}
export interface BaleQueueItemBase {
    kind: BaleQueueItemKind;
    chatId: number;
    target?: BaleQueueTarget;
    transportStamp?: BaleTransportStamp;
    replyToMessageId: number;
    guestQueryId?: string;
    guestInlineMessageId?: string;
    queueOrder: number;
    queueLane: BaleQueueLane;
    laneOrder: number;
    statusSummary: string;
    admissionReceipts?: BaleQueueAdmissionReceipt[];
}
export interface PendingBaleTurn extends BaleQueueItemBase {
    kind: "prompt";
    sourceMessageIds: number[];
    queuedAttachments: QueuedAttachment[];
    content: BalePromptContent[];
    historyText: string;
    priorityEmoji?: string;
    reactionSuppressionEmoji?: string;
    /** Frozen before receipt mutation; failed/partial attempts must never become executable again. */
    steerAttempted?: true;
    /** Original tail objects of an issued idle packet; metadata only, not another waiting queue. */
    steerPacketTail?: readonly PendingBaleTurn[];
    steerPacketSourceOrders?: readonly number[];
    /** Emit the explicit aborted-turn notice when /next settles this active turn. */
    announceNextAbortOnEnd?: boolean;
    /** Turn should preferably be delivered as voice (mirror mode + user sent voice) */
    voiceReplyPreferred?: boolean;
    /** Turn must be delivered as voice (voice mode) */
    voiceReplyRequired?: boolean;
}
export interface PendingBaleControlItem<TContext = unknown> extends BaleQueueItemBase {
    kind: "control";
    controlType: "status" | "model";
    execute: (ctx: TContext) => Promise<void>;
}
export type BaleQueueItem<TContext = unknown> = PendingBaleTurn | PendingBaleControlItem<TContext>;
export declare const BALE_QUEUE_HANDOFF_PAYLOAD_MAX_BYTES: number;
export interface BaleQueueHandoffBase {
    chatId: number;
    target?: BaleQueueTarget;
    transportStamp?: BaleTransportStamp;
    replyToMessageId: number;
    guestQueryId?: string;
    guestInlineMessageId?: string;
    queueOrder: number;
    queueLane: BaleQueueLane;
    laneOrder: number;
    statusSummary: string;
    admissionReceipts: BaleQueueAdmissionReceipt[];
}
export interface BalePromptQueueHandoffPayload extends BaleQueueHandoffBase {
    kind: "prompt";
    sourceMessageIds: number[];
    queuedAttachments: QueuedAttachment[];
    content: BalePromptContent[];
    historyText: string;
    priorityEmoji?: string;
    reactionSuppressionEmoji?: string;
    voiceReplyPreferred?: boolean;
    voiceReplyRequired?: boolean;
}
export interface BaleControlQueueHandoffPayload extends BaleQueueHandoffBase {
    kind: "control";
    controlType: PendingBaleControlItem<unknown>["controlType"];
}
export type BaleQueueHandoffPayload = BalePromptQueueHandoffPayload | BaleControlQueueHandoffPayload;
export interface BaleQueueHandoff {
    handoffToken: string;
    payload: BaleQueueHandoffPayload;
}
/** Data decoder shared by authenticated IPC and cold storage; decoding grants no admission. */
export declare function parseBaleQueueHandoffPayload(value: unknown): BaleQueueHandoffPayload | undefined;
export interface BaleQueueHandoffStageReceipt {
    status: "staged";
    receiptId: string;
    sourceUpdateIds: readonly number[];
}
export interface BaleQueueHandoffAcceptedOwner {
    instanceId: string;
    processId: number;
    processBirthId: string;
    sessionGeneration: number;
    acquisitionId: string;
    acquiredAtMs: number;
    handoffId?: string;
}
export interface BaleQueueHandoffStageResult extends BaleQueueHandoffStageReceipt {
    queueOwner: BaleQueueHandoffAcceptedOwner;
}
export interface BaleQueueHandoffStagingRuntime {
    stage: (payload: BaleQueueHandoffPayload) => BaleQueueHandoffStageReceipt;
    accept: (receipt: BaleQueueAdmissionReceipt) => boolean;
    cancel: (receipt: BaleQueueAdmissionReceipt) => boolean;
    hasStaged: (receipt: BaleQueueAdmissionReceipt) => boolean;
}
export interface BaleQueueStore<TContext = unknown> {
    getQueuedItems: () => BaleQueueItem<TContext>[];
    setQueuedItems: (items: BaleQueueItem<TContext>[]) => void;
}
export interface BaleQueueStateStore<TContext = unknown> extends BaleQueueStore<TContext> {
    hasQueuedItems: () => boolean;
}
export interface BaleActiveTurnStore<TTurn extends PendingBaleTurn = PendingBaleTurn> {
    get: () => TTurn | undefined;
    has: () => boolean;
    set: (turn: TTurn) => void;
    clear: () => void;
    markNextAbortAnnouncement: () => boolean;
    clearNextAbortAnnouncement: () => boolean;
    getChatId: () => number | undefined;
    getTarget: () => BaleQueueTarget | undefined;
    getReplyToMessageId: () => number | undefined;
    getGuestQueryId: () => string | undefined;
    getSourceMessageIds: () => number[] | undefined;
}
export interface BaleDispatchGuardState {
    compactionInProgress: boolean;
    hasActiveBaleTurn: boolean;
    hasPendingBaleDispatch: boolean;
    isIdle: boolean;
    hasPendingMessages: boolean;
}
export declare function createBaleQueueAdmissionReceipt(options: {
    queueKind: BaleQueueItemKind;
    scope: string;
    sourceUpdateIds: readonly number[];
}): BaleQueueAdmissionReceipt | undefined;
export declare function getBaleQueueLaneContract(lane: BaleQueueLane): BaleQueueLaneContract;
export declare function isBaleQueueItemAdmissionValid(item: Pick<BaleQueueItem, "kind" | "queueLane">): boolean;
export declare function assertBaleQueueItemAdmissionValid(item: Pick<BaleQueueItem, "kind" | "queueLane" | "admissionReceipts">): void;
export declare function createBaleQueueStore<TContext = unknown>(initialItems?: BaleQueueItem<TContext>[]): BaleQueueStateStore<TContext>;
export declare function createBaleTransportStampRuntime(deps: {
    getProfileName(): string | undefined;
    getBotToken(): string | undefined;
}): BaleTransportStampRuntime;
export declare function createBaleTransportStampedQueueStore<TContext>(store: BaleQueueStateStore<TContext>, getTransportStamp: () => BaleTransportStamp): BaleQueueStateStore<TContext>;
export declare function countExecutableBaleQueueItems<TContext = unknown>(items: readonly BaleQueueItem<TContext>[]): number;
export declare function createBaleQueueItemCountGetter<TContext = unknown>(store: Pick<BaleQueueStore<TContext>, "getQueuedItems">): () => number;
export declare function createBaleActiveTurnStore<TTurn extends PendingBaleTurn = PendingBaleTurn>(): BaleActiveTurnStore<TTurn>;
/** Current captured targets only; skipped/receipt-held items remain work, never historical census. */
export declare function observeBaleTargetQueueWork(target: BaleQueueTarget & {
    threadId: number;
}, activeTurn: Pick<BaleQueueItemBase, "chatId" | "target"> | undefined, items: readonly Pick<BaleQueueItemBase, "chatId" | "target">[]): {
    protected: boolean;
    unknown: boolean;
};
export declare function partitionBaleQueueItemsForHistory<TContext = unknown>(items: BaleQueueItem<TContext>[]): {
    historyTurns: PendingBaleTurn[];
    remainingItems: BaleQueueItem<TContext>[];
};
export declare function planBalePromptEnqueue<TContext = unknown>(items: BaleQueueItem<TContext>[], foldQueuedPromptsIntoHistory: boolean): {
    historyTurns: PendingBaleTurn[];
    remainingItems: BaleQueueItem<TContext>[];
};
export declare function areBaleQueueAdmissionReceiptsEqual(left: BaleQueueAdmissionReceipt, right: BaleQueueAdmissionReceipt): boolean;
export declare function appendBaleQueueItem<TContext = unknown, TItem extends BaleQueueItem<TContext> = BaleQueueItem<TContext>>(items: BaleQueueItem<TContext>[], item: TItem): BaleQueueItem<TContext>[];
export declare function createBaleQueueHandoff<TContext>(input: {
    handoffToken: string;
    item: BaleQueueItem<TContext>;
    steerSupported?: boolean;
}): BaleQueueHandoff;
export declare function createBaleQueueHandoffPayload<TContext>(item: BaleQueueItem<TContext>, options?: {
    steerSupported?: boolean;
}): BaleQueueHandoffPayload;
export declare function restoreBaleQueueHandoffPayload<TContext>(payload: BaleQueueHandoffPayload, createControlExecution: (payload: BaleControlQueueHandoffPayload) => PendingBaleControlItem<TContext>["execute"]): BaleQueueItem<TContext>;
export declare function removeBaleQueueItemByReceipt<TContext>(input: {
    receipt: BaleQueueAdmissionReceipt;
    store: BaleQueueStore<TContext>;
}): boolean;
export declare function stageBaleQueueHandoffPayload<TContext>(input: {
    payload: BaleQueueHandoffPayload;
    store: BaleQueueStore<TContext>;
    createControlExecution: (payload: BaleControlQueueHandoffPayload) => PendingBaleControlItem<TContext>["execute"];
}): BaleQueueHandoffStageReceipt;
export declare function createBaleQueueHandoffStagingRuntime<TContext>(input: {
    liveStore: BaleQueueStore<TContext>;
    createControlExecution: (payload: BaleControlQueueHandoffPayload) => PendingBaleControlItem<TContext>["execute"];
}): BaleQueueHandoffStagingRuntime;
export declare function appendBalePromptTurnOnce<TContext = unknown>(items: BaleQueueItem<TContext>[], turn: PendingBaleTurn): {
    items: BaleQueueItem<TContext>[];
    appended: boolean;
};
export declare function compareBaleQueueItems<TContext = unknown>(left: BaleQueueItem<TContext>, right: BaleQueueItem<TContext>): number;
export interface BaleQueueMessageScope {
    chatId?: number;
    threadId?: number;
}
export declare function removeBaleQueueItemsByMessageIds<TContext = unknown>(items: BaleQueueItem<TContext>[], messageIds: number[], scope?: BaleQueueMessageScope): {
    items: BaleQueueItem<TContext>[];
    removedItems: BaleQueueItem<TContext>[];
    removedCount: number;
};
export declare function applyBaleQueuePromptReactionDisposition<TContext = unknown>(items: BaleQueueItem<TContext>[], messageId: number, disposition: BaleQueueReactionDisposition, destinationLaneOrder?: number, scope?: BaleQueueMessageScope): {
    items: BaleQueueItem<TContext>[];
    changed: boolean;
};
export declare function consumeDispatchedBalePrompt<TContext = unknown>(items: BaleQueueItem<TContext>[], hasPendingDispatch: boolean): {
    activeTurn?: PendingBaleTurn;
    remainingItems: BaleQueueItem<TContext>[];
};
export declare function truncateBaleQueueSummary(text: string, maxWords?: number, maxLength?: number): string;
export declare function canDispatchBaleTurnState(state: BaleDispatchGuardState): boolean;
export interface BaleDispatchReadinessDeps<TContext> {
    isCompactionInProgress: () => boolean;
    hasActiveTurn: () => boolean;
    hasDispatchPending: () => boolean;
    isIdle: (ctx: TContext) => boolean;
    hasPendingMessages: (ctx: TContext) => boolean;
}
export declare function createBaleDispatchReadinessChecker<TContext>(deps: BaleDispatchReadinessDeps<TContext>): (ctx: TContext) => boolean;
export declare function buildPendingBaleControlItem<TContext = unknown>(options: {
    chatId: number;
    target?: BaleQueueTarget;
    replyToMessageId: number;
    controlType: PendingBaleControlItem<TContext>["controlType"];
    queueOrder: number;
    laneOrder: number;
    statusSummary: string;
    admissionReceipts?: BaleQueueAdmissionReceipt[];
    execute: PendingBaleControlItem<TContext>["execute"];
}): PendingBaleControlItem<TContext>;
export interface BaleControlItemBuilderDeps {
    allocateItemOrder: () => number;
    allocateControlOrder: () => number;
}
export declare function createBaleControlItemBuilder<TContext = unknown>(deps: BaleControlItemBuilderDeps): (options: {
    chatId: number;
    target?: BaleQueueTarget;
    replyToMessageId: number;
    controlType: PendingBaleControlItem<TContext>["controlType"];
    statusSummary: string;
    admissionReceipts?: BaleQueueAdmissionReceipt[];
    execute: PendingBaleControlItem<TContext>["execute"];
}) => PendingBaleControlItem<TContext>;
export type BaleQueueDispatchAction<TContext = unknown> = {
    kind: "none";
    remainingItems: BaleQueueItem<TContext>[];
} | {
    kind: "steer";
    item: PendingBaleTurn;
    packet: readonly PendingBaleTurn[];
    remainingItems: BaleQueueItem<TContext>[];
} | {
    kind: "control";
    item: PendingBaleControlItem<TContext>;
    remainingItems: BaleQueueItem<TContext>[];
} | {
    kind: "prompt";
    item: PendingBaleTurn;
    remainingItems: BaleQueueItem<TContext>[];
};
export type BaleSteerPacketPlan = {
    kind: "none";
} | {
    kind: "skip";
    item: PendingBaleTurn;
} | {
    kind: "packet";
    items: readonly PendingBaleTurn[];
};
/** Plan a fixed ready prefix; publication/settlement remain with the Queue effect shell. */
export declare function planBaleSteerPacket<TContext>(items: readonly BaleQueueItem<TContext>[], options: {
    blocked: boolean;
    isItemReady: (item: BaleQueueItem<TContext>) => boolean;
    canAppend?: (packet: readonly PendingBaleTurn[], item: PendingBaleTurn) => boolean;
}): BaleSteerPacketPlan;
export declare function isBaleSteerItemWithinIdleCapacity(item: PendingBaleTurn): boolean;
export interface BaleSteerBoundaryRuntimeDeps<TContext> extends BaleQueueStore<TContext> {
    isContextCurrent: (ctx: TContext) => boolean;
    isBlocked: (ctx: TContext) => boolean;
    getGeneration: () => number;
    isItemReady: (item: BaleQueueItem<TContext>, ctx: TContext) => boolean;
    isItemCurrent: (item: PendingBaleTurn, ctx: TContext) => boolean;
    getActiveTurn: () => PendingBaleTurn | undefined;
    commitPacket: (items: readonly PendingBaleTurn[], ctx: TContext) => boolean;
    discardItem: (item: PendingBaleTurn, ctx: TContext) => boolean;
    updateStatus: (ctx: TContext) => void;
    recordRuntimeEvent?: BaleRuntimeEventRecorderPort["recordRuntimeEvent"];
}
/** One publication attempt; journal ACK is source disposition, never SDK/model-use confirmation. */
export declare function createBaleSteerBoundaryRuntime<TContext>(deps: BaleSteerBoundaryRuntimeDeps<TContext>): {
    onTurnEnd(event: Pick<TurnEndEvent, "turnIndex" | "outcome">, ctx: TContext): TurnEndEventResult | undefined;
};
export declare function planNextBaleQueueAction<TContext = unknown>(items: BaleQueueItem<TContext>[], canDispatch: boolean): BaleQueueDispatchAction<TContext>;
export declare function shouldDispatchAfterBaleAgentEnd(options: {
    hasTurn: boolean;
    stopReason?: string;
    foldQueuedPromptsIntoHistory: boolean;
}): boolean;
export interface BaleAgentStartPlan<TContext = unknown> {
    activeTurn?: PendingBaleTurn;
    remainingItems: BaleQueueItem<TContext>[];
    shouldResetPendingModelSwitch: boolean;
    shouldResetToolExecutions: boolean;
    shouldClearDispatchPending: boolean;
    shouldClearAbortHistory: boolean;
}
export interface BaleAgentStartRuntimeDeps<TTurn extends PendingBaleTurn, TContext = unknown> extends BaleRuntimeEventRecorderPort {
    queuedItems: BaleQueueItem<TContext>[];
    hasPendingDispatch: boolean;
    hasActiveTurn: boolean;
    resetToolExecutions: () => void;
    resetPendingModelSwitch: () => void;
    setQueuedItems: (items: BaleQueueItem<TContext>[]) => void;
    clearDispatchPending: () => void;
    setFoldQueuedPromptsIntoHistory: (fold: boolean) => void;
    setActiveTurn: (turn: TTurn) => void;
    onPromptHandedOff?: (turn: TTurn) => void;
    createPreviewState: () => void;
    startTypingLoop: () => void;
    updateStatus: () => void;
}
export interface BaleAgentStartHookRuntimeDeps<TTurn extends PendingBaleTurn, TContext = unknown> extends BaleRuntimeEventRecorderPort {
    setAbortHandler: (ctx: TContext) => void;
    getQueuedItems: () => BaleQueueItem<TContext>[];
    hasPendingDispatch: () => boolean;
    hasActiveTurn: () => boolean;
    resetToolExecutions: () => void;
    resetPendingModelSwitch: () => void;
    setQueuedItems: (items: BaleQueueItem<TContext>[]) => void;
    clearDispatchPending: () => void;
    setFoldQueuedPromptsIntoHistory: (fold: boolean) => void;
    setActiveTurn: (turn: TTurn) => void;
    onPromptHandedOff?: (turn: TTurn, ctx: TContext) => void;
    createPreviewState: () => void;
    startTypingLoop: (ctx: TContext) => void;
    updateStatus: (ctx: TContext) => void;
}
export type BaleAgentStartHookEvent = unknown;
export interface BaleToolExecutionRuntimeDeps {
    getActiveToolExecutions: () => number;
    setActiveToolExecutions: (count: number) => void;
}
export interface BaleToolExecutionEndRuntimeDeps extends BaleToolExecutionRuntimeDeps {
    triggerPendingModelSwitchAbort: () => void;
}
export interface BaleToolExecutionHookRuntimeDeps<TContext> extends BaleToolExecutionRuntimeDeps {
    triggerPendingModelSwitchAbort: (ctx: TContext) => unknown;
}
export type BaleToolExecutionHookEvent = unknown;
export declare function buildBaleAgentStartPlan<TContext = unknown>(options: {
    queuedItems: BaleQueueItem<TContext>[];
    hasPendingDispatch: boolean;
    hasActiveTurn: boolean;
}): BaleAgentStartPlan<TContext>;
export declare function handleBaleAgentStartRuntime<TTurn extends PendingBaleTurn, TContext = unknown>(deps: BaleAgentStartRuntimeDeps<TTurn, TContext>): void;
export declare function createBaleAgentStartHook<TTurn extends PendingBaleTurn, TContext = unknown>(deps: BaleAgentStartHookRuntimeDeps<TTurn, TContext>): (_event: BaleAgentStartHookEvent, ctx: TContext) => Promise<void>;
export declare function getNextBaleToolExecutionCount(options: {
    currentCount: number;
    event: "start" | "end";
}): number;
export declare function handleBaleToolExecutionStartRuntime(deps: BaleToolExecutionRuntimeDeps): void;
export declare function handleBaleToolExecutionEndRuntime(deps: BaleToolExecutionEndRuntimeDeps): void;
export type BaleAgentLifecycleHooksRuntimeDeps<TTurn extends PendingBaleTurn, TContext, TMessage, TReplyMarkup = unknown> = BaleAgentStartHookRuntimeDeps<TTurn, TContext> & BaleAgentEndHookRuntimeDeps<TTurn, TContext, TMessage, TReplyMarkup> & BaleToolExecutionHookRuntimeDeps<TContext>;
export declare function createBaleAgentLifecycleHooks<TTurn extends PendingBaleTurn, TContext, TMessage, TReplyMarkup = unknown>(deps: BaleAgentLifecycleHooksRuntimeDeps<TTurn, TContext, TMessage, TReplyMarkup>): {
    onToolExecutionStart: () => void;
    onToolExecutionEnd: (_event: BaleToolExecutionHookEvent, ctx: TContext) => void;
    onAgentStart: (_event: BaleAgentStartHookEvent, ctx: TContext) => Promise<void>;
    onAgentEnd(event: BaleAgentEndHookEvent<TMessage>, ctx: TContext): Promise<void>;
    onAgentSettled(_event: unknown, ctx: TContext): Promise<void>;
    clearRetainedAgentEnd(): void;
};
export declare function createBaleToolExecutionHooks<TContext>(deps: BaleToolExecutionHookRuntimeDeps<TContext>): {
    onToolExecutionStart: () => void;
    onToolExecutionEnd: (_event: BaleToolExecutionHookEvent, ctx: TContext) => void;
};
export interface BaleAgentEndPlan {
    kind: "no-turn" | "aborted" | "error" | "text" | "attachments-only" | "empty";
    shouldClearPreview: boolean;
    shouldDispatchNext: boolean;
    shouldSendAbortMessage: boolean;
    shouldSendErrorMessage: boolean;
    shouldSendAttachmentNotice: boolean;
}
export interface BaleAgentEndAssistantResult {
    text?: string;
    stopReason?: string;
    errorMessage?: string;
    recoveredFromEarlier?: boolean;
}
export interface BaleAgentEndOutboundVoiceReply {
    text: string;
    lang?: string;
    rate?: string;
}
export interface BaleAgentEndOutboundReplyPlan<TReplyMarkup = unknown> {
    markdown: string;
    replyMarkup?: TReplyMarkup;
    voiceText?: string;
    voiceReplies?: BaleAgentEndOutboundVoiceReply[];
    lang?: string;
    rate?: string;
}
export interface BaleAgentEndRuntimeDeps<TTurn extends PendingBaleTurn, TReplyMarkup = unknown> {
    turn: TTurn | undefined;
    assistant: BaleAgentEndAssistantResult;
    foldQueuedPromptsIntoHistory: boolean;
    resetRuntimeState: () => void;
    isSessionActive?: () => boolean;
    isTurnTransportActive?: (turn: TTurn) => boolean;
    waitForTypingIdle?: () => Promise<void>;
    waitForActivityIdle?: () => Promise<void>;
    updateStatus: () => void;
    dispatchNextQueuedBaleTurn: () => void;
    scheduleActiveTurnDelivery?: (task: () => Promise<void>) => void;
    preparePreviewDelivery?: (isDeliveryActive: () => boolean) => Pick<BaleAgentEndRuntimeDeps<TTurn, TReplyMarkup>, "clearPreview" | "setPreviewPendingText" | "finalizeMarkdownPreview"> | undefined;
    preparePreviewClear?: (chatId: number, options?: {
        target?: BaleQueueTarget;
        isDeliveryActive?: () => boolean;
    }) => () => Promise<void>;
    clearPreview: (chatId: number, options?: {
        target?: BaleQueueTarget;
    }) => Promise<void>;
    setPreviewPendingText: (text: string) => void;
    finalizeMarkdownPreview: (chatId: number, markdown: string, replyToMessageId: number, options?: {
        replyMarkup?: TReplyMarkup;
        target?: BaleQueueTarget;
    }) => Promise<boolean>;
    sendMarkdownReply: (chatId: number, replyToMessageId: number | undefined, markdown: string, options?: {
        replyMarkup?: TReplyMarkup;
        target?: BaleQueueTarget;
    }) => Promise<unknown>;
    sendTextReply: (chatId: number, replyToMessageId: number, text: string, options?: {
        target?: BaleQueueTarget;
        parseMode?: "HTML";
    }) => Promise<unknown>;
    sendQueuedAttachments: (turn: TTurn, options?: {
        isDeliveryActive?: () => boolean;
    }) => Promise<void>;
    sendRichAttachmentReply?: (turn: TTurn, markdown: string, options?: {
        replyMarkup?: TReplyMarkup;
        isDeliveryActive?: () => boolean;
    }) => Promise<boolean>;
    answerGuestQuery?: (guestQueryId: string, text?: string, options?: {
        parseMode?: string;
    }) => Promise<void>;
    sendGuestReply?: (guestQueryId: string, markdown: string) => Promise<void>;
    /** Replaces the early guest ACK with the final text. */
    editGuestReply?: (inlineMessageId: string, markdown: string, options?: {
        assertAuthority?: () => void;
    }) => Promise<void>;
    /** Cancels the animated guest placeholder before the final edit. */
    stopGuestPlaceholder?: (inlineMessageId: string) => Promise<void>;
    sendGuestAttachment?: (turn: TTurn, attachment: QueuedAttachment, caption?: string, options?: {
        isDeliveryActive?: () => boolean;
    }) => Promise<void>;
    sendGuestVoiceReply?: (turn: TTurn, plan: BaleAgentEndOutboundReplyPlan<TReplyMarkup>, caption?: string) => Promise<void>;
    planOutboundReply?: (markdown: string) => BaleAgentEndOutboundReplyPlan<TReplyMarkup>;
    sendOutboundReplyArtifacts?: (turn: TTurn, plan: BaleAgentEndOutboundReplyPlan, options?: {
        replyToPrompt?: boolean;
        isDeliveryActive?: () => boolean;
    }) => Promise<void>;
    recordRuntimeEvent?: (category: string, error: unknown, details?: Record<string, unknown>) => void;
}
export interface BaleAgentEndHookRuntimeDeps<TTurn extends PendingBaleTurn, TContext, TMessage, TReplyMarkup = unknown> {
    getActiveTurn: () => TTurn | undefined;
    loadConfig?: () => Promise<void>;
    extractAssistant: (messages: readonly TMessage[]) => BaleAgentEndAssistantResult;
    isAssistantAlreadyPublished?: (assistant: BaleAgentEndAssistantResult) => boolean;
    getFoldQueuedPromptsIntoHistory: () => boolean;
    resetRuntimeState: () => void;
    isSessionActive?: (ctx: TContext) => boolean;
    isTurnTransportActive?: (turn: TTurn) => boolean;
    waitForTypingIdle?: () => Promise<void>;
    waitForActivityIdle?: () => Promise<void>;
    updateStatus: (ctx: TContext) => void;
    dispatchNextQueuedBaleTurn: (ctx: TContext) => void;
    requestDeferredDispatchNextQueuedBaleTurn: (dispatch: (ctx: TContext) => void) => void;
    scheduleActiveTurnDelivery?: BaleAgentEndRuntimeDeps<TTurn, TReplyMarkup>["scheduleActiveTurnDelivery"];
    reserveActiveTurnDelivery?: () => {
        schedule: (task: () => Promise<void>) => void;
        cancel: () => void;
    };
    preparePreviewDelivery?: BaleAgentEndRuntimeDeps<TTurn, TReplyMarkup>["preparePreviewDelivery"];
    preparePreviewClear?: BaleAgentEndRuntimeDeps<TTurn, TReplyMarkup>["preparePreviewClear"];
    clearPreview: BaleAgentEndRuntimeDeps<TTurn, TReplyMarkup>["clearPreview"];
    setPreviewPendingText: (text: string) => void;
    finalizeMarkdownPreview: BaleAgentEndRuntimeDeps<TTurn, TReplyMarkup>["finalizeMarkdownPreview"];
    sendMarkdownReply: BaleAgentEndRuntimeDeps<TTurn, TReplyMarkup>["sendMarkdownReply"];
    sendTextReply: BaleAgentEndRuntimeDeps<TTurn>["sendTextReply"];
    sendQueuedAttachments: BaleAgentEndRuntimeDeps<TTurn>["sendQueuedAttachments"];
    sendRichAttachmentReply?: BaleAgentEndRuntimeDeps<TTurn, TReplyMarkup>["sendRichAttachmentReply"];
    answerGuestQuery?: BaleAgentEndRuntimeDeps<TTurn>["answerGuestQuery"];
    sendGuestReply?: BaleAgentEndRuntimeDeps<TTurn>["sendGuestReply"];
    editGuestReply?: BaleAgentEndRuntimeDeps<TTurn>["editGuestReply"];
    stopGuestPlaceholder?: BaleAgentEndRuntimeDeps<TTurn>["stopGuestPlaceholder"];
    sendGuestAttachment?: BaleAgentEndRuntimeDeps<TTurn>["sendGuestAttachment"];
    sendGuestVoiceReply?: BaleAgentEndRuntimeDeps<TTurn>["sendGuestVoiceReply"];
    planOutboundReply?: BaleAgentEndRuntimeDeps<TTurn, TReplyMarkup>["planOutboundReply"];
    sendOutboundReplyArtifacts?: BaleAgentEndRuntimeDeps<TTurn>["sendOutboundReplyArtifacts"];
    recordRuntimeEvent?: BaleAgentEndRuntimeDeps<TTurn>["recordRuntimeEvent"];
}
export interface BaleAgentEndHookEvent<TMessage> {
    messages: readonly TMessage[];
}
export declare function buildBaleAgentEndPlan(options: {
    hasTurn: boolean;
    stopReason?: string;
    hasFinalText: boolean;
    hasQueuedAttachments: boolean;
    foldQueuedPromptsIntoHistory: boolean;
    announceNextAbortOnEnd?: boolean;
}): BaleAgentEndPlan;
export declare function createBaleAgentEndHook<TTurn extends PendingBaleTurn, TContext, TMessage, TReplyMarkup = unknown>(deps: BaleAgentEndHookRuntimeDeps<TTurn, TContext, TMessage, TReplyMarkup>): (event: BaleAgentEndHookEvent<TMessage>, ctx: TContext, assistantOverride?: BaleAgentEndAssistantResult) => Promise<void>;
export declare function handleBaleAgentEndRuntime<TTurn extends PendingBaleTurn, TReplyMarkup = unknown>(deps: BaleAgentEndRuntimeDeps<TTurn, TReplyMarkup>): Promise<void>;
export interface BaleSessionStartState<TModel = unknown> {
    currentBaleModel: TModel | undefined;
    activeBaleToolExecutions: number;
    pendingBaleModelSwitch: undefined;
    nextQueuedBaleItemOrder: number;
    nextQueuedBaleControlOrder: number;
    baleTurnDispatchPending: boolean;
    compactionInProgress: boolean;
}
export interface BaleSessionShutdownState<TQueueItem> {
    queuedBaleItems: TQueueItem[];
    nextQueuedBaleItemOrder: number;
    nextQueuedBaleControlOrder: number;
    currentBaleModel: undefined;
    activeBaleToolExecutions: number;
    pendingBaleModelSwitch: undefined;
    baleTurnDispatchPending: boolean;
    compactionInProgress: boolean;
    foldQueuedPromptsIntoHistory: boolean;
}
export interface BaleSessionRuntimeCounterState {
    nextQueuedBaleItemOrder?: number;
    nextQueuedBaleControlOrder?: number;
}
export interface BaleSessionRuntimeFlagState {
    activeBaleToolExecutions?: number;
    baleTurnDispatchPending?: boolean;
    compactionInProgress?: boolean;
    foldQueuedPromptsIntoHistory?: boolean;
}
export interface BaleSessionStateApplierDeps<TQueueItem, TModel> {
    setQueuedItems: (items: TQueueItem[]) => void;
    setCurrentModel: (model: TModel | undefined) => void;
    setPendingModelSwitch: (selection: undefined) => void;
    syncCounters: (state: BaleSessionRuntimeCounterState) => void;
    syncFlags: (state: BaleSessionRuntimeFlagState) => void;
}
export interface BaleSessionStateApplier<TQueueItem, TModel> {
    applyStartState: (state: BaleSessionStartState<TModel>) => void;
    applyShutdownState: (state: BaleSessionShutdownState<TQueueItem>) => void;
}
export interface BaleSessionStartRuntimeDeps<TContext, TModel = unknown> {
    ctx: TContext;
    currentModel: TModel | undefined;
    loadConfig: () => Promise<void>;
    isSessionActive?: () => boolean;
    applyState: (state: BaleSessionStartState<TModel>) => void;
    bindDeferredDispatchContext?: (ctx: TContext) => void;
    prepareTempDir: () => Promise<unknown>;
    updateStatus: () => void;
}
export interface BaleSessionShutdownRuntimeDeps<TQueueItem> {
    isSessionActive?: () => boolean;
    unbindDeferredDispatchContext?: () => void;
    discardQueuedItems?: () => void;
    applyState: (state: BaleSessionShutdownState<TQueueItem>) => void;
    clearPendingMediaGroups: () => void;
    clearModelMenuState: () => void;
    getActiveTurnChatId: () => number | undefined;
    getActiveTurnTarget?: () => BaleQueueTarget | undefined;
    clearPreview: (chatId: number, options?: {
        target?: BaleQueueTarget;
    }) => Promise<void>;
    previewShutdownTimeoutMs?: number;
    clearActiveTurn: () => void;
    clearAbort: () => void;
    stopPolling: () => Promise<void>;
}
export interface BaleSessionLifecycleHookRuntimeDeps<TContext, TQueueItem, TModel = unknown> extends BaleRuntimeEventRecorderPort, Omit<BaleSessionShutdownRuntimeDeps<TQueueItem>, "isSessionActive" | "discardQueuedItems" | "applyState"> {
    getCurrentModel: (ctx: TContext) => TModel | undefined;
    loadConfig: () => Promise<void>;
    applySessionStartState: (state: BaleSessionStartState<TModel>) => void;
    bindDeferredDispatchContext?: (ctx: TContext) => void;
    prepareTempDir: () => Promise<unknown>;
    updateStatus: (ctx: TContext) => void;
    isSessionActive?: (ctx: TContext) => boolean;
    discardQueuedItems?: (ctx: TContext) => void;
    applySessionShutdownState: (state: BaleSessionShutdownState<TQueueItem>) => void;
}
export type BaleSessionLifecycleHookEvent = unknown;
export declare function createBaleSessionStateApplier<TQueueItem, TModel>(deps: BaleSessionStateApplierDeps<TQueueItem, TModel>): BaleSessionStateApplier<TQueueItem, TModel>;
export interface BaleQueueMutationRuntimeDeps<TContext> extends BaleQueueStore<TContext>, BaleRuntimeEventRecorderPort {
    ctx: TContext;
    hasPendingDispatch?: () => boolean;
    allocateLaneOrder?: () => number;
    onItemsDiscarded?: (items: readonly BaleQueueItem<TContext>[], ctx: TContext) => void;
    updateStatus: (ctx: TContext) => void;
}
export interface BaleQueueMutationControllerDeps<TContext> extends BaleQueueStore<TContext>, BaleRuntimeEventRecorderPort {
    hasPendingDispatch?: () => boolean;
    allocateLaneOrder?: () => number;
    onItemsDiscarded?: (items: readonly BaleQueueItem<TContext>[], ctx: TContext) => void;
    updateStatus: (ctx: TContext) => void;
}
export interface BaleQueueMutationController<TContext> {
    append: (item: BaleQueueItem<TContext>, ctx: TContext) => void;
    reorder: (ctx: TContext) => void;
    clear: (ctx: TContext) => number;
    removeByMessageIds: (messageIds: number[], ctx: TContext, scope?: BaleQueueMessageScope) => number;
    removeGuestPromptByQueueOrder?: (queueOrder: number, ctx: TContext) => boolean;
    applyReactionByMessageId: (messageId: number, disposition: BaleQueueReactionDisposition, ctx: TContext, scope?: BaleQueueMessageScope) => boolean;
}
export interface BaleControlQueueControllerDeps<TContext> {
    appendControlItem: (item: PendingBaleControlItem<TContext>, ctx: TContext) => void;
    dispatchNextQueuedBaleTurn: (ctx: TContext) => void;
}
export interface BaleControlQueueController<TContext> {
    enqueue: (item: PendingBaleControlItem<TContext>, ctx: TContext, onQueued?: (item: PendingBaleControlItem<TContext>) => void) => void;
}
export type BalePreparedPromptTurn = (historyTurns: PendingBaleTurn[]) => PendingBaleTurn;
export interface BalePromptEnqueueRuntimeDeps<TMessage, TContext = unknown> extends BaleQueueStore<TContext> {
    hasPendingDispatch: () => boolean;
    getFoldQueuedPromptsIntoHistory: () => boolean;
    setFoldQueuedPromptsIntoHistory: (fold: boolean) => void;
    prepareTurn: (messages: TMessage[]) => Promise<BalePreparedPromptTurn>;
    updateStatus: () => void;
    dispatchNextQueuedBaleTurn: () => void;
    assertExecutionCurrent?: () => void;
    /** Input-specific relocation must not fold or replace unrelated queued work. */
    preserveQueued?: boolean;
    onQueued?: (turn: PendingBaleTurn) => void;
}
export interface BalePromptEnqueueControllerDeps<TMessage, TContext = unknown> extends BaleQueueStore<TContext> {
    hasPendingDispatch: () => boolean;
    getFoldQueuedPromptsIntoHistory: () => boolean;
    setFoldQueuedPromptsIntoHistory: (fold: boolean) => void;
    prepareTurn: (messages: TMessage[], ctx: TContext) => Promise<BalePreparedPromptTurn>;
    updateStatus: (ctx: TContext) => void;
    dispatchNextQueuedBaleTurn: (ctx: TContext) => void;
    assertExecutionCurrent?: (messages: TMessage[]) => void;
}
export interface BalePromptEnqueueController<TMessage, TContext = unknown> {
    enqueue: (messages: TMessage[], ctx: TContext, onQueued?: (turn: PendingBaleTurn) => void, options?: {
        assertCurrent?: () => void;
        preserveQueued?: boolean;
    }) => Promise<PendingBaleTurn>;
}
export declare function buildBaleSessionStartState<TModel = unknown>(currentModel: TModel | undefined): BaleSessionStartState<TModel>;
export declare function buildBaleSessionShutdownState<TQueueItem>(): BaleSessionShutdownState<TQueueItem>;
export declare function startBaleSessionRuntime<TContext, TModel = unknown>(deps: BaleSessionStartRuntimeDeps<TContext, TModel>): Promise<void>;
export declare function shutdownBaleSessionRuntime<TQueueItem>(deps: BaleSessionShutdownRuntimeDeps<TQueueItem>): Promise<void>;
export type BaleSessionLifecycleRuntimeDeps<TContext, TQueueItem, TModel = unknown> = Omit<BaleSessionLifecycleHookRuntimeDeps<TContext, TQueueItem, TModel>, "applySessionStartState" | "applySessionShutdownState"> & BaleSessionStateApplierDeps<TQueueItem, TModel>;
export declare function createBaleSessionLifecycleRuntime<TContext, TQueueItem, TModel = unknown>(deps: BaleSessionLifecycleRuntimeDeps<TContext, TQueueItem, TModel>): {
    onSessionStart: (_event: BaleSessionLifecycleHookEvent, ctx: TContext) => Promise<void>;
    onSessionShutdown: (_event?: BaleSessionLifecycleHookEvent, ctx?: TContext | undefined) => Promise<void>;
};
export declare function createBaleSessionLifecycleHooks<TContext, TQueueItem, TModel = unknown>(deps: BaleSessionLifecycleHookRuntimeDeps<TContext, TQueueItem, TModel>): {
    onSessionStart: (_event: BaleSessionLifecycleHookEvent, ctx: TContext) => Promise<void>;
    onSessionShutdown: (_event?: BaleSessionLifecycleHookEvent, ctx?: TContext) => Promise<void>;
};
export declare function createBaleQueueMutationController<TContext>(deps: BaleQueueMutationControllerDeps<TContext>): BaleQueueMutationController<TContext>;
export declare function clearBaleQueueItemsRuntime<TContext>(deps: BaleQueueMutationRuntimeDeps<TContext>): number;
export declare function removeBaleQueueItemsByMessageIdsRuntime<TContext>(messageIds: number[], deps: BaleQueueMutationRuntimeDeps<TContext>, scope?: BaleQueueMessageScope): number;
export declare function applyBaleQueuePromptReactionDispositionRuntime<TContext>(messageId: number, disposition: BaleQueueReactionDisposition, deps: BaleQueueMutationRuntimeDeps<TContext>, scope?: BaleQueueMessageScope): boolean;
export declare function enqueueBalePromptTurnRuntime<TMessage, TContext = unknown>(messages: TMessage[], deps: BalePromptEnqueueRuntimeDeps<TMessage, TContext>): Promise<PendingBaleTurn>;
export declare function createBalePromptEnqueueController<TMessage, TContext = unknown>(deps: BalePromptEnqueueControllerDeps<TMessage, TContext>): BalePromptEnqueueController<TMessage, TContext>;
export declare function createBaleControlQueueController<TContext>(deps: BaleControlQueueControllerDeps<TContext>): BaleControlQueueController<TContext>;
export interface BaleRuntimeEventRecorderPort {
    recordRuntimeEvent?: (category: string, error: unknown, details?: Record<string, unknown>) => void;
}
export interface BaleControlRuntimeDeps<TContext> extends BaleRuntimeEventRecorderPort {
    ctx: TContext;
    sendTextReply: (chatId: number, replyToMessageId: number, text: string, options?: {
        target?: BaleQueueTarget;
        parseMode?: "HTML";
    }) => Promise<number | undefined>;
    onSettled: (item: PendingBaleControlItem<TContext>) => void;
}
export declare function executeBaleControlItemRuntime<TContext>(item: PendingBaleControlItem<TContext>, deps: BaleControlRuntimeDeps<TContext>): Promise<void>;
export interface BaleDeferredQueueDispatchRuntimeDeps extends BaleRuntimeEventRecorderPort {
    delayMs?: number;
    setTimer?: (callback: () => void, ms: number) => ReturnType<typeof setTimeout>;
    clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
}
export interface BaleDeferredQueueDispatchRuntime<TContext = unknown> {
    bind: (ctx: TContext) => void;
    unbind: () => void;
    isBound: () => boolean;
    getGeneration: () => number;
    isGenerationActive: (generation: number) => boolean;
    request: (dispatchNextQueuedBaleTurn: (ctx: TContext) => void) => void;
}
export declare function createBaleDeferredQueueDispatchRuntime<TContext = unknown>(deps?: BaleDeferredQueueDispatchRuntimeDeps): BaleDeferredQueueDispatchRuntime<TContext>;
export interface BaleQueueDispatchWatchdogRuntime<TContext = unknown> {
    start: (ctx: TContext) => void;
    stop: () => void;
    poke: () => void;
}
export interface BaleQueueDispatchWatchdogRuntimeDeps<TContext = unknown> extends BaleRuntimeEventRecorderPort {
    hasQueuedItems: () => boolean;
    dispatchNextQueuedBaleTurn: (ctx: TContext) => void;
    intervalMs?: number;
    setInterval?: (callback: () => void, ms: number) => ReturnType<typeof setInterval>;
    clearInterval?: (timer: ReturnType<typeof setInterval>) => void;
}
export declare function createBaleQueueDispatchWatchdogRuntime<TContext = unknown>(deps: BaleQueueDispatchWatchdogRuntimeDeps<TContext>): BaleQueueDispatchWatchdogRuntime<TContext>;
export interface BalePromptDeliveryOptions {
    deliverAs: "followUp";
}
export interface BaleDispatchRuntimeDeps<TContext = unknown> {
    executeControlItem: (item: Extract<BaleQueueDispatchAction<TContext>, {
        kind: "control";
    }>["item"]) => void;
    onPromptDispatchStart: (chatId: number, target?: BaleQueueTarget) => void;
    commitPromptDispatch?: (item: Extract<BaleQueueDispatchAction<TContext>, {
        kind: "prompt";
    }>["item"]) => boolean;
    sendUserMessage: (content: Extract<BaleQueueDispatchAction, {
        kind: "prompt";
    }>["item"]["content"], options?: BalePromptDeliveryOptions) => void;
    onPromptDispatchFailure: (message: string) => void;
    onIdle: () => void;
}
export interface BaleQueueDispatchControllerDeps<TContext = unknown> extends BaleRuntimeEventRecorderPort {
    getQueuedItems: () => BaleQueueItem<TContext>[];
    setQueuedItems: (items: BaleQueueItem<TContext>[]) => void;
    canDispatch: (ctx: TContext) => boolean;
    hasDispatchContext?: () => boolean;
    getDispatchGeneration?: () => number;
    isDispatchGenerationActive?: (generation: number) => boolean;
    updateStatus: (ctx: TContext, error?: string) => void;
    sendTextReply: BaleControlRuntimeDeps<TContext>["sendTextReply"];
    onPromptDispatchStart: (ctx: TContext, chatId: number, target?: BaleQueueTarget) => void;
    commitPromptDispatch?: (item: Extract<BaleQueueDispatchAction<TContext>, {
        kind: "prompt";
    }>["item"], ctx: TContext) => boolean;
    sendUserMessage: BaleDispatchRuntimeDeps<TContext>["sendUserMessage"];
    onPromptDispatchFailure: (ctx: TContext, message: string) => void;
    reconcileNextDispatchAnnouncementReplyOwnership?: (item: PendingBaleTurn) => void;
    steerDispatch?: {
        commitPacket: (items: readonly PendingBaleTurn[], ctx: TContext) => boolean;
        isContextCurrent?: (ctx: TContext) => boolean;
        /** Rechecks idle/native/abort guards without rejecting this packet's own pending flag. */
        canSubmit?: (ctx: TContext) => boolean;
    };
    isQueueItemTransportActive?: (item: BaleQueueItem<TContext>) => boolean;
    hasPendingInboundQueueMutationForItem?: (item: BaleQueueItem<TContext>) => boolean;
    isQueueItemAdmissionReady?: (item: BaleQueueItem<TContext>) => boolean;
    onControlSettled?: (item: PendingBaleControlItem<TContext>, ctx: TContext) => void;
    onPromptSkipped?: (item: PendingBaleTurn, ctx: TContext) => boolean;
}
export interface BaleQueueDispatchController<TContext = unknown> {
    dispatchNext: (ctx: TContext) => void;
    requestNextDispatchAnnouncement: () => void;
    cancelNextDispatchAnnouncement: () => void;
}
export declare function executeBaleQueueDispatchPlan<TContext = unknown>(plan: BaleQueueDispatchAction<TContext>, deps: BaleDispatchRuntimeDeps<TContext>): void;
export type BaleQueueDispatchRuntimeDeps<TContext = unknown> = Omit<BaleQueueDispatchControllerDeps<TContext>, "canDispatch"> & BaleDispatchReadinessDeps<TContext>;
export declare function createBaleQueueDispatchRuntime<TContext = unknown>(deps: BaleQueueDispatchRuntimeDeps<TContext>): BaleQueueDispatchController<TContext>;
export declare function createBaleQueueDispatchController<TContext = unknown>(deps: BaleQueueDispatchControllerDeps<TContext>): BaleQueueDispatchController<TContext>;

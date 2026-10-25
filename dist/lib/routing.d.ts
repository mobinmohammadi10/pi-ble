/**
 * Bale inbound routing composition
 * Zones: bale inbound, orchestration, queue/menu/command composition
 * Wires authorized updates into menus, commands, media grouping, and prompt queueing, and owns exact assistant-output target/route authority capture
 */
import * as Bus from "./bus.ts";
import * as Commands from "./commands.ts";
import type { BaleConfigStore } from "./config.ts";
import type { BaleInboundHandlerRuntime } from "./inbound.ts";
import type { BaleUpdateJournalQueuedCompletion, BaleUpdateJournalQueuedReceiptEvidence } from "./journal.ts";
import * as Media from "./media.ts";
import * as Menu from "./menu.ts";
import * as Model from "./model.ts";
import * as OutboundHandlers from "./outbound.ts";
import * as PromptTemplates from "./prompt-templates.ts";
import * as Queue from "./queue.ts";
import type { BaleBridgeRuntime } from "./runtime.ts";
import type { BaleSectionRegistry } from "./sections.ts";
import type { BaleApiCallOptions, BaleInputRichMessage } from "./bale-api.ts";
import * as TextGroups from "./text-groups.ts";
import * as ThreadReconciler from "./thread-reconciler.ts";
import type { BaleInstanceThreadIdentityCandidate, BaleTopicTargetRecord } from "./threads.ts";
import * as Turns from "./turns.ts";
import type { createBaleWorkspaceExternalProtectionCapture } from "./workspace-retirement.ts";
interface BalePromptPeerView {
    id?: unknown;
    is_bot?: unknown;
    username?: unknown;
    first_name?: unknown;
    last_name?: unknown;
    title?: unknown;
}
export declare function resolveBaleGuestPromptPeer(input: {
    chatType?: string;
    chat?: BalePromptPeerView;
    from?: BalePromptPeerView;
    replyFrom?: BalePromptPeerView;
    guestBotCallerUser?: BalePromptPeerView;
    guestBotCallerChat?: BalePromptPeerView;
    ownerUserId?: number;
}): string | undefined;
/** Stable file scope of the remote Guest Mode peer: username, else numeric id; never the bot's own scope. */
export declare function resolveBaleGuestFileScope(input: Parameters<typeof resolveBaleGuestPromptPeer>[0]): string;
import * as Threads from "./threads.ts";
import * as Updates from "./updates.ts";
/** Prepare the selected leader's exact retained originals; no copy, adoption, acceptance proof or dispatch. */
export declare function prepareBaleLiveLeaderOriginal(input: {
    request: Threads.BaleWorkspaceRestoreRequest;
    messages: readonly unknown[];
    isCurrent(): boolean;
}): Updates.BaleLiveDeferredInputPreparation | undefined;
export type BaleLiveRebindCleanupIssue = {
    status: "not-ready";
} | {
    status: "finished";
    operationId: string;
    cleanup: ThreadReconciler.BaleLiveRebindCleanupOutcome;
    recorded: boolean;
};
/**
 * Default live-rebind cleanup pacing: quick early attempts, then minutely, within a 15-minute window. The first
 * delay is not cosmetic: a leader's detached command reply still needs the released, cleanup-free row.
 */
export declare const BALE_LIVE_REBIND_CLEANUP_SCHEDULE: Readonly<{
    delaysMs: readonly number[];
    intervalMs: 60000;
    windowMs: number;
}>;
/** Chooser-scoped saved command reference; it is never retained after the chooser record. */
type BaleLiveRebindSelectedCommandReference = {
    operationId: string;
    preparedSource: Bus.BaleBusPreparedCommandSource;
    selectedCommand: Bus.BaleBusSelectedCommandInput;
};
/** One warm live attempt with independent leader input/cleanup grants and exact peer donor settlement; no startup recovery or legacy Restore ACK. */
export declare function createBaleLiveRebindCoordinator(input: {
    request: Threads.BaleWorkspaceRestoreRequest;
    /** Captures caller source/reference, admission, profile, transport and Pi lifetime. */
    authority: Threads.BaleWorkspaceRestoreAuthority;
    messages: readonly unknown[];
    restoreStore: Threads.BaleWorkspaceRestore;
    threadStore: Pick<Threads.BaleTopicTargetStore, "withWorkspaceRestoreSnapshot">;
    getRecipient(): (Threads.BaleWorkspaceRestoreRecipient & {
        bindingKey: string;
    }) | undefined;
    leader?: {
        apply(intent: Threads.BaleWorkspaceLiveRebindIntent, mode: "apply" | "inspect", isCurrent: () => boolean): Promise<void>;
        /** Synchronous local identity only; safe inside a Workspace publication fence. */
        isApplied(intent: Threads.BaleWorkspaceLiveRebindIntent): boolean;
    } & ({
        /** Confirm ordinary queue admission of these same bound messages, never handler replay. */
        continue(messages: readonly unknown[], isCurrent: () => boolean): Promise<boolean>;
        /** Observe only the same issued admission through its existing receipt owner; never re-enqueue. */
        observeAdmission?(): boolean;
        complete?: never;
    } | {
        /** Issue one semantic completion; the adapter owns detached delivery and errors, not a removal ACK. */
        complete(messages: readonly unknown[], isCurrent: () => boolean): void;
        continue?: never;
    });
    follower?: {
        run: ReturnType<typeof Bus.createBaleBusLiveRebindController>;
        /** Explicit staged singleton command branch; absence preserves ordinary live input behavior. */
        selectedCommand?: Bus.BaleBusSelectedCommandInput;
    };
    /** Existing profile admission spans the applied recipient, fresh cleanup decision and one native input grant. */
    cleanupBeforeRelease?(intent: Threads.BaleWorkspaceLiveRebindIntent, isCurrent: () => boolean): Promise<boolean>;
    /** Restore moves the tab to its new owner: once applied, show that owner's title (best-effort, never blocking). */
    retitle?: (isCurrent: () => boolean) => Promise<void>;
    recordRuntimeEvent?: (category: string, error: unknown, details: Record<string, unknown>) => void;
}): {
    /** Correlation only; a later cleanup attempt rereads and revalidates the canonical row itself. */
    operationId: string;
    /** Body-free copy of the authenticated saved command reference: correlation only, never authority, an ACK or a cleanup permit. */
    selectedCommandReference(): BaleLiveRebindSelectedCommandReference | undefined;
    /** Observe only an already-issued leader command; never prepares, relocates or executes input. */
    observeCommandCompletion(): "unknown" | "released" | undefined;
    advance(): Promise<"protected" | "unknown" | "released">;
};
/** One admitted Restore attempt through recipient readiness, never source dispatch or cleanup. */
export declare function advanceBaleWorkspaceRestore(input: {
    request: Threads.BaleWorkspaceRestoreRequest;
    authority: Threads.BaleWorkspaceRestoreAuthority;
    restoreStore: Threads.BaleWorkspaceRestore;
    getRecipient: () => Threads.BaleWorkspaceRestoreRecipient | undefined;
    /** Adapter proves current canonical ownership and authenticates observations; apply needs a fresh issuance. */
    runRecipient: (input: {
        intent: Threads.BaleWorkspaceRestoreIntent;
        mode: "apply" | "inspect";
        isCurrent: () => boolean;
    }) => Promise<{
        operationId: string;
        recipient: Threads.BaleWorkspaceRestoreRecipient;
        target: Threads.BaleWorkspaceRestoreRequest["target"];
        slot: string;
        ready: boolean;
    } | undefined>;
    /**
     * Recovery for a same-session successor already on the relocated target: it may receive the first grant, but only
     * read-only inspection runs. It never commits a new relocation or applies a target.
     */
    inspectOnly?: true;
}): Promise<Threads.BaleWorkspaceRestoreIntent | undefined>;
export declare const BALE_ALL_TAB_COMMAND_MAX_AGE_MS: number;
/** The toast for expired or previous-process routing controls; the chooser notice is written separately. */
export declare const BALE_ROUTING_CHOICE_EXPIRED = "Routing choice expired";
export declare function isBaleAllTabCommandExpired(message: {
    date?: number;
    message_thread_id?: number;
}, nowMs?: number): boolean;
export type BaleRoutedMessage = {
    date?: number;
} & Updates.BaleUpdateMessage & Media.BaleMediaMessage & Media.BaleMediaGroupMessage & Commands.BaleCommandRuntimeMessage & Turns.BaleTurnMessage;
export type BaleRoutedCallbackQuery = Updates.BaleCallbackQuery & Menu.MenuCallbackQuery;
export interface BaleInboundBusProjectionRuntime {
    getTargetOwnership: Updates.BaleTargetOwnershipLookup;
    getLiveThreadTargets(): Queue.BaleQueueTarget[];
    getLocalThreadLabelForTarget(target: Queue.BaleQueueTarget): string | undefined;
}
export declare function createBaleInboundBusProjectionRuntime(deps: {
    instanceId: string;
    listFollowers(): readonly Bus.BaleBusFollowerView[];
    listThreadRecords(): readonly BaleTopicTargetRecord[];
    getLeaderTarget(): Queue.BaleQueueTarget | undefined;
    isFollowerRegistered(): boolean;
    getFollowerTarget(): Queue.BaleQueueTarget | undefined;
    getCurrentIdentity(target?: Queue.BaleQueueTarget): BaleInstanceThreadIdentityCandidate;
}): BaleInboundBusProjectionRuntime;
export interface BaleInboundRouteRuntimeDeps<TMessage extends BaleRoutedMessage, TCallbackQuery extends BaleRoutedCallbackQuery, TContext, TModel extends Model.MenuModel> {
    configStore: Pick<BaleConfigStore, "get" | "getAllowedUserId" | "persistAllowedUserId" | "persist"> & {
        set?: BaleConfigStore["set"];
    };
    callApi?: <TResponse>(method: string, body: Record<string, unknown>, options?: BaleApiCallOptions) => Promise<TResponse>;
    getCurrentInstanceId?: () => string | undefined;
    getAdmissionScope?: () => string | undefined;
    getAdmissionJournalBinding?: () => string | undefined;
    getCommandReplyTarget?: Commands.BaleCommandTargetRuntimeDeps<TContext>["getReplyTarget"];
    getMessageOwnership?: Updates.BaleMessageOwnershipLookup;
    getTargetOwnership?: Updates.BaleTargetOwnershipLookup;
    recordMessageOwnership?: Updates.BaleMessageOwnershipRecorder;
    getLiveThreadTargets?: () => Queue.BaleQueueTarget[];
    getDisplayTitle?: Threads.BaleCurrentThreadAssembly["getDisplayTitle"];
    getLocalThreadLabelForTarget?: (target: Queue.BaleQueueTarget) => string | undefined;
    getCurrentLeaderEpoch?: () => number | string | undefined;
    setCurrentLeaderIdentity?: (identity: {
        target: Queue.BaleQueueTarget;
        slot?: string;
        threadName?: string;
    }) => void;
    getThreadReconciliationMachineState?: () => ThreadReconciler.ThreadReconciliationMachineState | undefined;
    recordThreadReconciliationPlan?: (plan: ThreadReconciler.ThreadReconciliationPlan) => void;
    handleBaleTopicLifecycleUpdate?: (lifecycle: Updates.BaleTopicLifecycleUpdate<TMessage>, ctx: TContext) => Promise<void> | void;
    handleBaleThreadTargetObserved?: (target: Threads.BaleTopicTargetRecord["target"], ctx: TContext) => Promise<void> | void;
    foreignOwnedUpdateForwarder?: Updates.BaleForeignOwnedUpdateForwarder<TContext, Updates.BaleMessageReactionUpdated, TCallbackQuery, TMessage>;
    getWorkspaceRestoreStore?: () => Threads.BaleWorkspaceRestore | undefined;
    captureWorkspaceExternalProtection?: ReturnType<typeof createBaleWorkspaceExternalProtectionCapture>;
    /** Strict committed abandonment plus retained original; shared by Restore and temporary-input cancellation. */
    inspectRestoreSourceAbandonment?: (updateId: number, journalBindingKey: string) => Threads.BaleTemporaryThreadCancellationEvidence | undefined;
    inspectRoutingInputGroupExpiry?: (input: Threads.BaleTemporaryThreadInput) => readonly Threads.BaleTemporaryThreadCancellationEvidence[] | undefined;
    /** Strict active-journal observation only; a hint or missing source never substitutes for this ACK. */
    inspectRestoreSourceCompletion?: (expected: Updates.BaleDeferredSourceEvidence & {
        completionSha256: string;
    }) => (Updates.BaleDeferredSourceEvidence & {
        completionSha256: string;
    }) | undefined;
    inspectRestoreQueuedReceipt?: (expected: BaleUpdateJournalQueuedCompletion & {
        journalBindingKey: string;
    }) => BaleUpdateJournalQueuedReceiptEvidence | undefined;
    hasWorkspaceRestoreAuthority?: () => boolean;
    /** Exact live root authority; capability advertisement alone cannot replace owned profile/session/recipient fences. */
    hasWorkspaceLiveRebindAuthority?: () => boolean;
    canUsePreDispatchRebind?: (recipient?: Threads.BaleWorkspaceRestoreRecipient) => boolean;
    /** Strict complete namespace plus exact current/historical references; only an empty result clears journal protection. */
    inspectTemporaryThreadSources?: (target: Queue.BaleQueueTarget, requiredJournalBindingKeys: readonly string[], ownInputs?: readonly Threads.BaleTemporaryThreadInput[]) => readonly number[] | undefined;
    /** Explicit cleanup-only recovery; never called by a read-only protection observer. */
    recoverTemporaryThreadDeadQueueOwners?: (target: Queue.BaleQueueTarget, requiredJournalBindingKeys: readonly string[], ownInputs: readonly Threads.BaleTemporaryThreadInput[], isCurrent: () => boolean) => number;
    /** Quiet period after the last cancelled input before one cleanup attempt; defaults to 0 ms. */
    temporaryThreadCleanupDelayMs?: number;
    /** Live-rebind cleanup attempt pacing; the bounded window ends in `not-issued`, never a time-based deletion. */
    /** Bounded ACK observation inside the original chooser admission, independent from menu/reply delivery. */
    liveRebindCommandCompletionTimeoutMs?: number;
    liveRebindCleanupSchedule?: {
        delaysMs: readonly number[];
        intervalMs: number;
        windowMs: number;
    };
    getSessionGeneration?: () => number;
    workspaceRestoreRecipient?: {
        getSessionId: (ctx: TContext) => string | undefined;
        getCwd: (ctx: TContext) => string | undefined;
        getLeaderIdentity: Threads.BaleLeaderThreadStateRuntime["getIdentity"];
        /** Read-only current leader work; source/chooser lifetime is not recipient authority. */
        observeLeaderWork?: (oldTarget: Queue.BaleQueueTarget & {
            threadId: number;
        }, ctx: TContext) => Bus.BaleBusLiveRebindWorkState;
        followerRegistry: Pick<Bus.BaleBusFollowerRegistry, "get" | "register">;
        runFollower: ReturnType<typeof Bus.createBaleBusWorkspaceRestoreController>;
        liveFollower?: {
            /** Pure trusted assembly availability (Commands/native/menu and local protocol), never future target activation. */
            isSelectedCommandAvailable?(follower: Readonly<Bus.BaleBusFollowerView>, name: string): boolean;
            /** Exact session journal identity from the existing registration/journal owners, never the profile routing key. */
            getJournalBindingKey(follower: Bus.BaleBusFollowerView): string | undefined;
            run: ReturnType<typeof Bus.createBaleBusLiveRebindController>;
        };
    };
    bridgeRuntime: BaleBridgeRuntime;
    activeTurnRuntime: Queue.BaleActiveTurnStore;
    mediaGroupRuntime: Media.BaleMediaGroupController<TMessage, TContext>;
    textGroupRuntime: TextGroups.BaleTextGroupController<TMessage, TContext>;
    baleQueueStore: Queue.BaleQueueStateStore<TContext>;
    queueMutationRuntime: Queue.BaleQueueMutationController<TContext>;
    modelMenuRuntime: Menu.BaleModelMenuRuntime<TModel>;
    currentModelRuntime: Model.CurrentModelRuntime<TContext, TModel>;
    modelSwitchController: Model.BaleModelSwitchController<TContext, Model.ScopedBaleModel<TModel>>;
    menuActions: Menu.BaleMenuActionRuntime<TContext, TModel>;
    /** Thinking controls refuse while the active Bale turn expects a voice reply. */
    isVoiceReplyActive?: () => boolean;
    updateSettingsMenuMessage?: (state: Menu.BaleModelMenuState<TModel>, ctx: TContext) => Promise<void>;
    openQueueMenu: (chatId: number, replyToMessageId: number, ctx: TContext, threadId?: number, options?: Pick<BaleApiCallOptions, "assertAuthority">) => Promise<void>;
    openSettingsMenu?: (chatId: number, replyToMessageId: number | undefined, ctx: TContext, threadId?: number, options?: Pick<BaleApiCallOptions, "assertAuthority">) => Promise<void>;
    settingsMenuCallbackHandler?: (query: TCallbackQuery, ctx: TContext) => Promise<boolean>;
    queueMenuCallbackHandler: (query: TCallbackQuery, ctx: TContext) => Promise<boolean>;
    buttonActionStore?: OutboundHandlers.BaleButtonActionStore;
    invokeBoundButtonAction?: (action: OutboundHandlers.BaleOutboundButtonAction, query: TCallbackQuery, ctx: TContext) => Promise<false | "new" | "edit">;
    inboundHandlerRuntime: BaleInboundHandlerRuntime<TContext>;
    threadStore?: Threads.BaleTopicTargetStore;
    runWorkspaceOperation?: <T>(input: {
        operationId: string;
        operationKind: string;
        scopes: readonly [{
            kind: "profile";
        }];
    }, operation: () => Promise<T>) => Promise<T>;
    updateStatus: (ctx: TContext, error?: string) => void;
    isContextActive?: (ctx: TContext) => boolean;
    dispatchNextQueuedBaleTurn: (ctx: TContext) => void;
    requestNextDispatchAnnouncement?: () => void;
    cancelNextDispatchAnnouncement?: () => void;
    requestDeferredDispatchNextQueuedBaleTurn?: (dispatch: (ctx: TContext) => void) => void;
    hasDeferredDispatchContext?: () => boolean;
    startTypingLoop?: (ctx: TContext, chatId?: number, options?: {
        target?: {
            chatId: number;
            threadId?: number;
        };
    }) => void;
    stopTypingLoop?: () => void;
    answerCallbackQuery: (callbackQueryId: string, text?: string, options?: Pick<BaleApiCallOptions, "assertAuthority">) => Promise<void>;
    editInteractiveMessage?: (chatId: number, messageId: number, text: string, mode: "markdown" | "html" | "plain", replyMarkup: Menu.BaleReplyMarkup, options?: {
        target?: Queue.BaleQueueTarget;
        assertAuthority?: BaleApiCallOptions["assertAuthority"];
    }) => Promise<void>;
    editMessageReplyMarkup?: (chatId: number, messageId: number, replyMarkup: OutboundHandlers.BaleOutboundButtonMarkup) => Promise<void>;
    sendInteractiveMessage?: (chatId: number, text: string, mode: "markdown" | "html" | "plain", replyMarkup: Menu.BaleReplyMarkup, options?: {
        target?: Queue.BaleQueueTarget;
        replyToMessageId?: number;
        assertAuthority?: BaleApiCallOptions["assertAuthority"];
    }) => Promise<number | undefined>;
    deleteMessage?: (chatId: number, messageId: number) => Promise<void>;
    answerGuestQuery: (guestQueryId: string, text?: string) => Promise<void>;
    /** Answers the guest query immediately and returns its inline message id. */
    answerGuestQueryForInlineMessage?: (guestQueryId: string, text: string, options?: {
        parseMode?: "HTML";
    }) => Promise<string | undefined>;
    /** Starts the animated placeholder on an answered guest inline message. */
    startGuestPlaceholder?: (inlineMessageId: string) => void;
    sendTextReply: (chatId: number, replyToMessageId: number | undefined, text: string, options?: {
        parseMode?: "HTML";
        target?: Queue.BaleQueueTarget;
        assertAuthority?: BaleApiCallOptions["assertAuthority"];
    }) => Promise<number | undefined>;
    setMyCommands: Commands.BaleBotCommandRegistrationDeps["setMyCommands"];
    /** Captures independent recipient authority, never the source execution or dialog handle. */
    captureThreadNameRecipientAuthority?: (target: Queue.BaleQueueTarget, ctx: TContext) => (() => void) | undefined;
    validateThreadName?: (threadName: string) => string | undefined;
    renameCurrentThread?: Commands.BaleThreadDisplayNameRenamePort;
    resetCurrentThreadName?: Commands.BaleThreadDisplayNameResetPort;
    getCommands: () => Parameters<typeof PromptTemplates.getBalePromptTemplateCommands>[0];
    downloadFile: Media.DownloadBaleMessageFilesDeps["downloadFile"];
    resolveTimeLine?: (chatId: number) => string | null;
    getThinkingLevel: () => Model.ThinkingLevel;
    setThinkingLevel: (level: Model.ThinkingLevel) => void;
    persistScopedModelPatterns?: (patterns: string[], ctx: TContext) => Promise<void>;
    setModel: (model: TModel) => Promise<boolean>;
    sendUserMessage?: (message: string, options?: Queue.BalePromptDeliveryOptions) => void;
    isIdle: (ctx: TContext) => boolean;
    hasPendingMessages: (ctx: TContext) => boolean;
    requestNewSession?: (source: unknown) => void;
    compact: (ctx: TContext, callbacks: {
        onComplete: () => void;
        onError: (error: unknown) => void;
    }) => void;
    recordRuntimeEvent?: (category: string, error: unknown, details?: Record<string, unknown>) => void;
    beginCommandEffectWork?: Commands.BaleCommandRuntimeDeps<TMessage, TContext>["beginCommandEffectWork"];
    sectionRegistry?: BaleSectionRegistry;
    sendSectionRichMessage?: (chatId: number, message: BaleInputRichMessage, options?: {
        target?: {
            chatId: number;
            threadId?: number;
        };
    }) => Promise<number | undefined>;
}
export declare function createBaleInboundRouteRuntime<TUpdate extends Updates.BaleUpdateFlow & {
    message?: TMessage;
    edited_message?: TMessage;
    callback_query?: TCallbackQuery;
}, TMessage extends BaleRoutedMessage, TCallbackQuery extends BaleRoutedCallbackQuery, TContext, TModel extends Model.MenuModel>(deps: BaleInboundRouteRuntimeDeps<TMessage, TCallbackQuery, TContext, TModel>): Updates.BaleUpdateRuntimeController<TContext, TUpdate> & {
    expireRoutingInput: NonNullable<Updates.BaleUpdateWorkerRuntimeDeps<TContext>["expireRoutingInput"]>;
    shouldReviewHistoricalInput: NonNullable<Updates.BaleUpdateWorkerRuntimeDeps<TContext>["shouldReviewHistoricalInput"]>;
    shouldHoldPendingInput: NonNullable<Updates.BaleUpdateWorkerRuntimeDeps<TContext>["shouldHoldPendingInput"]>;
    forgetPreviousWorld(input: Updates.BaleHeldSourcePreparation<TContext>, captureTransport?: (ctx: TContext) => (() => boolean) | undefined): Promise<{
        forgotten: number;
        deleted: number;
    }>;
    beforeQueueReceiptPublished: NonNullable<Updates.BaleUpdateWorkerRuntimeDeps<TContext>["beforeQueueReceiptPublished"]>;
    onQueueReceiptCommitted: NonNullable<Updates.BaleUpdateWorkerRuntimeDeps<TContext>["onQueueReceiptCommitted"]>;
    onQueueReceiptCompleted: NonNullable<Updates.BaleUpdateWorkerRuntimeDeps<TContext>["onQueueReceiptCompleted"]>;
    onUpdateCompleted: NonNullable<Updates.BaleUpdateWorkerRuntimeDeps<TContext>["onUpdateCompleted"]>;
    onWorkspaceRestoreRecipientObserved(follower: Bus.BaleBusFollowerView, isCurrent: () => boolean, ctx: TContext | undefined): Promise<void> | undefined;
    waitForRestoreSettlement(): Promise<void>;
    /** Commands-owned registry port for dormant scoped recipient assembly, not ordinary update replay. */
    prepareHeldCommand: ReturnType<typeof Commands.createBaleCommandHandlerTargetRuntime<TMessage, TContext>>["prepareHeldCommand"];
    canPrepareHeldCommand: ReturnType<typeof Commands.createBaleCommandHandlerTargetRuntime<TMessage, TContext>>["canPrepareHeldCommand"];
    /** Agent-settled hint: wakes waiting leader cleanup retries early; every readiness gate is still sampled fresh. */
    onSessionSettled(ctx: TContext): void;
    /** Lifetime-fenced hint from drained publication/activity/delivery/API owners; never a cleanup grant. */
    onDeliverySettled(ctx: TContext): void;
    /** Fresh body-free recipient observation only; never reconstructs an attempt or grants cleanup. */
    observeLiveRebindLeaderWork(intent: Threads.BaleWorkspaceLiveRebindIntent, ctx: TContext): Promise<Bus.BaleBusLiveRebindWorkObservation | undefined>;
    /** Fresh non-destructive candidate only; no retained idle, cleanup action or deletion grant. */
    prepareLiveRebindLeaderCleanup(intent: Threads.BaleWorkspaceLiveRebindIntent, ctx: TContext): Promise<ThreadReconciler.BaleLiveRebindCleanupPreparation | undefined>;
    /** Requires the authenticated peer's exact retained released carrier; never recreates save/apply/release. */
    prepareLiveRebindFollowerCleanup(intent: Threads.BaleWorkspaceLiveRebindIntent, ctx: TContext): Promise<ThreadReconciler.BaleLiveRebindCleanupPreparation | undefined>;
    /**
     * One cleanup attempt under fresh admission: a fresh clear sample, then the durable issue marker, one unretried
     * deletion and the terminal record. `not-ready` leaves the released row unissued; `undefined` is lost authority.
     */
    issueLiveRebindLeaderCleanup(intent: Threads.BaleWorkspaceLiveRebindIntent, ctx: TContext): Promise<BaleLiveRebindCleanupIssue | undefined>;
    issueLiveRebindFollowerCleanup(intent: Threads.BaleWorkspaceLiveRebindIntent, ctx: TContext): Promise<BaleLiveRebindCleanupIssue | undefined>;
    /** Coordinator-only prompt admission; caller retains Workspace/canonical and exact recipient authority. */
    continueLiveRebindPrompt(messages: readonly TMessage[], ctx: TContext, target: Queue.BaleQueueTarget & {
        threadId: number;
    }, isCurrent: () => boolean): Promise<boolean>;
};
export interface BaleAssistantOutputAuthority<TTransportStamp> {
    transportStamp: TTransportStamp;
    route: "direct" | "follower" | "none";
    directEpoch?: number | string;
    followerGeneration?: string;
    target?: Queue.BaleQueueTarget;
}
export interface BaleAssistantOutputAuthorityRuntime<TTransportStamp> {
    captureAuthority: () => BaleAssistantOutputAuthority<TTransportStamp>;
    isAuthorityActive: (authority: BaleAssistantOutputAuthority<TTransportStamp>) => boolean;
    canDeliver: () => boolean;
}
export declare function createBaleAssistantOutputAuthorityRuntime<TTransportStamp>(deps: {
    getPreferredTarget: () => Queue.BaleQueueTarget | undefined;
    getFallbackChatId: () => number | undefined;
    getTransportStamp: () => TTransportStamp;
    isTransportStampActive: (stamp: TTransportStamp) => boolean;
    ownsDirect: () => boolean;
    getDirectEpoch: () => number | string | undefined;
    isFollowerRegistered: () => boolean;
    getFollowerGeneration: () => string | undefined;
}): BaleAssistantOutputAuthorityRuntime<TTransportStamp>;
export {};

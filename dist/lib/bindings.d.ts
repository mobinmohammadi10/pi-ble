/**
 * Bale bridge binding composition
 * Zones: bale, pi agent, orchestration
 * Owns pi-facing tool, command, and lifecycle hook registration for the entrypoint
 */
import * as ActivityVerbosity from "./activity-verbosity.ts";
import * as Activity from "./activity.ts";
import * as BusApi from "./bus-api.ts";
import type { BaleBusFollowerCommandOwner } from "./bus-follower.ts";
import type { BaleBusLiveRebindWorkState } from "./bus.ts";
import * as ChannelPosts from "./channel-posts.ts";
import * as Commands from "./commands.ts";
import * as Config from "./config.ts";
import * as Delivery from "./delivery.ts";
import * as GenerativeApps from "./generative-apps.ts";
import * as Keyboard from "./keyboard.ts";
import * as Lifecycle from "./lifecycle.ts";
import * as Locks from "./locks.ts";
import * as Menu from "./menu.ts";
import * as Model from "./model.ts";
import * as OutboundAttachments from "./outbound-attachments.ts";
import * as OutboundHandlers from "./outbound.ts";
import * as Pi from "./pi.ts";
import * as Preview from "./preview.ts";
import * as Prompts from "./prompts.ts";
import * as Queue from "./queue.ts";
import * as Replies from "./replies.ts";
import * as Routing from "./routing.ts";
import * as Runtime from "./runtime.ts";
import * as Setup from "./setup.ts";
import * as Status from "./status.ts";
import type { BaleTarget } from "./target.ts";
import * as BaleApi from "./bale-api.ts";
/** Compose any registered held command over captured recipient effects; no ordinary follower API fallback. */
export declare function createBaleFollowerSelectedCommandBinding<TContext, TModel extends Model.MenuModel = Model.MenuModel>(deps: {
    ctx: TContext;
    operationId: string;
    registrationGeneration: string;
    name: string;
    target: BaleTarget & {
        threadId: number;
    };
    recipient: Pick<BaleBusFollowerCommandOwner<TContext>, "isCurrent" | "assertRecipientCurrent">;
    command: Pick<ReturnType<typeof Commands.createBaleCommandHandlerTargetRuntime<Commands.BaleCommandRuntimeMessage, TContext>>, "prepareHeldCommand" | "canPrepareHeldCommand">;
    menu?: Omit<Menu.BaleMenuActionRuntimeDeps<TContext, TModel>, "sendTextReply" | "sendInteractiveMessage" | "editInteractiveMessage">;
    deliver: Parameters<typeof BusApi.createBaleSelectedMenuTextApi>[0]["deliver"];
    recordOwnership: NonNullable<Replies.BaleRenderedMessageDeliveryRuntimeDeps<Menu.BaleReplyMarkup>["recordOwnership"]>;
}): BaleBusFollowerCommandOwner<TContext> | undefined;
type ActivePiModel = NonNullable<Pi.ExtensionContext["model"]>;
type BaleRuntimeEventRecorder = (category: string, error: unknown, details?: Record<string, unknown>) => void;
type BaleBridgeStatusUpdater = Status.BaleStatusRuntime<Pi.ExtensionContext>["updateStatus"];
type BaleAgentTargetResolver = NonNullable<OutboundAttachments.BaleOutboundMessageToolRegistrationDeps["resolveAgentTarget"]>;
type BaleAgentMessageRouter = NonNullable<OutboundAttachments.BaleOutboundMessageToolRegistrationDeps["routeAgentMessage"]>;
export interface BaleQueueBindingRuntime<TContext> {
    mutation: Queue.BaleQueueMutationController<TContext>;
    dispatchNext: (ctx: TContext) => void;
    requestNextDispatchAnnouncement: () => void;
    cancelNextDispatchAnnouncement: () => void;
    watchdog: Queue.BaleQueueDispatchWatchdogRuntime<TContext>;
    onTurnEnd: (event: Pick<Pi.TurnEndEvent, "turnIndex" | "outcome">, ctx: TContext) => Pi.TurnEndEventResult | undefined;
}
export declare function createBaleQueueBindingRuntime<TContext>(deps: {
    store: Queue.BaleQueueStateStore<TContext>;
    queue: Pick<Runtime.BaleBridgeRuntime["queue"], "allocateItemOrder">;
    lifecycle: Pick<Runtime.BaleBridgeRuntime["lifecycle"], "isCompactionInProgress" | "hasDispatchPending"> & Partial<Pick<Runtime.BaleBridgeRuntime["lifecycle"], "getActiveToolExecutions">>;
    activeTurn: Pick<Queue.BaleActiveTurnStore, "has"> & Partial<Pick<Queue.BaleActiveTurnStore, "get">>;
    admission: {
        getSettlement: () => {
            onItemsDiscarded: (items: readonly Queue.BaleQueueItem<TContext>[], ctx: TContext) => boolean;
            isItemReady: (item: Queue.BaleQueueItem<TContext>) => boolean;
            onPromptHandedOff?: (item: Pick<Queue.PendingBaleTurn, "admissionReceipts">, ctx: TContext) => boolean;
            onControlSettled: (item: Queue.PendingBaleControlItem<TContext>, ctx: TContext) => void;
        } | undefined;
        hasPendingQueueMutationForItem: (item: Queue.BaleQueueItem<TContext>) => boolean;
    };
    transportStamp: Pick<Queue.BaleTransportStampRuntime, "isActive">;
    deferredDispatch: Pick<Queue.BaleDeferredQueueDispatchRuntime<TContext>, "isBound" | "getGeneration" | "isGenerationActive">;
    promptDispatch: Runtime.BalePromptDispatchRuntime<TContext>;
    isIdle: (ctx: TContext) => boolean;
    hasPendingMessages: (ctx: TContext) => boolean;
    isContextCurrent?: (ctx: TContext) => boolean;
    isContextAborted?: (ctx: TContext) => boolean;
    updateStatus: (ctx: TContext, error?: string) => void;
    sendTextReply: Queue.BaleQueueDispatchRuntimeDeps<TContext>["sendTextReply"];
    sendUserMessage: Queue.BaleQueueDispatchRuntimeDeps<TContext>["sendUserMessage"];
    reconcileNextDispatchAnnouncementReplyOwnership?: (item: Queue.PendingBaleTurn) => void;
    recordRuntimeEvent?: BaleRuntimeEventRecorder;
}): BaleQueueBindingRuntime<TContext>;
export interface BaleGenerativeAppLiveSurfaceBinding {
    get: () => GenerativeApps.GenerativeAppLiveSurfaceRuntime<GenerativeApps.BaleBindLiveHandle> | undefined;
    set: (runtime: GenerativeApps.GenerativeAppLiveSurfaceRuntime<GenerativeApps.BaleBindLiveHandle> | undefined) => void;
    shutdown: () => void;
}
export declare function createBaleGenerativeAppLiveSurfaceBinding(): BaleGenerativeAppLiveSurfaceBinding;
export declare function createBaleGenerativeAppBoundButtonActionInvoker<TQuery extends {
    message?: {
        chat?: {
            id?: number;
        };
        message_id?: number;
        message_thread_id?: number;
    };
}>(deps: {
    agentDir: string;
    assertExecutionCurrent: (query: TQuery) => void;
    getExecutionFence: (query: TQuery) => GenerativeApps.GenerativeAppExecutionFence | undefined;
    getActiveProfileName?: () => string | undefined;
    getLiveSurfaceRuntime?: () => GenerativeApps.GenerativeAppLiveSurfaceRuntime<GenerativeApps.BaleBindLiveHandle> | undefined;
    planOutput: ReturnType<typeof OutboundHandlers.createBaleOutboundReplyPlanner>;
    sendMarkdownReply: (chatId: number, replyToMessageId: number, markdown: string, options?: {
        replyMarkup?: OutboundHandlers.BaleOutboundButtonMarkup;
    }) => Promise<unknown>;
    editInteractiveMessage?: (chatId: number, messageId: number, markdown: string, mode: "markdown", replyMarkup: OutboundHandlers.BaleOutboundButtonMarkup) => Promise<void>;
    recordRuntimeEvent: BaleRuntimeEventRecorder;
}): (action: OutboundHandlers.BaleOutboundButtonAction, query: TQuery) => Promise<false | "new" | "edit">;
export interface BaleAgentMessageToolRoutingRuntime {
    resolveAgentTarget: BaleAgentTargetResolver;
    routeAgentMessage: BaleAgentMessageRouter;
    canSendDirect: () => boolean;
}
export declare function createBaleAgentMessageToolRoutingRuntime(deps: {
    ownsLeader: () => boolean;
    ownsDirectDelivery: () => boolean;
    isFollowerRegistered: () => boolean;
    getSourceTarget: () => BaleTarget | undefined;
    getSourceThreadName: () => string | undefined;
    local: {
        resolveTarget: (selector: Parameters<BaleAgentTargetResolver>[0], sourceTarget?: BaleTarget) => Awaited<ReturnType<BaleAgentTargetResolver>> | undefined;
        route: (input: {
            sourceTarget?: BaleTarget;
            sourceThreadName?: string;
            message: Parameters<BaleAgentMessageRouter>[0];
        }) => Promise<void>;
    };
    follower: {
        resolveTarget: BaleAgentTargetResolver;
        routeMessage: BaleAgentMessageRouter;
    };
}): BaleAgentMessageToolRoutingRuntime;
export interface BaleAssistantOutputBindingRuntime<TTransportStamp> {
    runtime: Activity.BaleAssistantOutputRuntime;
    observeEvent: (event: Activity.BaleActivityEvent) => void;
    authority: Routing.BaleAssistantOutputAuthorityRuntime<TTransportStamp>;
}
export declare function createBaleAssistantOutputBindingRuntime<TTransportStamp>(deps: {
    authority: {
        getPreferredTarget: () => OutboundAttachments.BaleQueuedOutboundAttachmentTurnView["target"] | undefined;
        getFallbackChatId: () => number | undefined;
        getTransportStamp: () => TTransportStamp;
        isTransportStampActive: (stamp: TTransportStamp) => boolean;
        ownsDirect: () => boolean;
        getDirectEpoch: () => number | string | undefined;
        isFollowerRegistered: () => boolean;
        getFollowerGeneration: () => string | undefined;
    };
    sender: Parameters<typeof OutboundHandlers.createBaleAssistantOutputSender<TTransportStamp>>[0];
    waitForActivityIdle?: () => Promise<void>;
    prepareBalePreview?: () => Activity.BaleAssistantOutputPreparation | undefined;
    enqueue?: Activity.BaleActivityPublicationRuntime["enqueue"];
    recordRuntimeEvent: BaleRuntimeEventRecorder;
}): BaleAssistantOutputBindingRuntime<TTransportStamp>;
type BaleAssistantOutputAuthority<TTransportStamp> = ReturnType<Routing.BaleAssistantOutputAuthorityRuntime<TTransportStamp>["captureAuthority"]>;
export interface BaleBridgePublicationRuntime {
    enqueue: Activity.BaleActivityPublicationRuntime["enqueue"];
    reserve: Activity.BaleActivityPublicationRuntime["reserve"];
    hasPending: Activity.BaleActivityPublicationRuntime["hasPending"];
    beginWork: Activity.BaleActivityPublicationRuntime["beginWork"];
    hasUnconfirmed: Activity.BaleActivityPublicationRuntime["hasUnconfirmed"];
    capture: () => {
        target?: Queue.BaleQueueTarget;
        isCurrent: () => boolean;
    };
}
export interface BaleActivityBindingRuntime {
    publicationRuntime: BaleBridgePublicationRuntime;
    activityRuntime: Activity.BaleActivityRuntime;
    activityVerbosityRuntime: ActivityVerbosity.BaleActivityVerbosityRuntime;
    assistantOutputRuntime: Activity.BaleAssistantOutputRuntime;
}
/** Compose public activity fanout, verbosity, and assistant output ordering. */
export declare function createBaleActivityBindingRuntime<TTransportStamp>(deps: {
    generation: string;
    captureDrain?: () => (() => void) | undefined;
    assistantOutput: Omit<Parameters<typeof createBaleAssistantOutputBindingRuntime<TTransportStamp>>[0], "waitForActivityIdle" | "enqueue">;
    activityVerbosity: Omit<Parameters<typeof ActivityVerbosity.createBaleActivityVerbosityRuntime<BaleAssistantOutputAuthority<TTransportStamp>>>[0], "captureAuthority" | "isAuthorityActive" | "recordFailure" | "enqueue">;
}): BaleActivityBindingRuntime;
/** Fresh current work projection; a snapshot is not a cleanup grant or target-application ACK. */
export declare function createBaleLiveTargetWorkObserver<TContext>(deps: {
    queue: Pick<Queue.BaleQueueStateStore<TContext>, "getQueuedItems">;
    activeTurn: Pick<Queue.BaleActiveTurnStore, "get">;
    lifecycle: Pick<Runtime.BaleBridgeRuntime["lifecycle"], "hasDispatchPending" | "isCompactionInProgress" | "getActiveToolExecutions">;
    isIdle(ctx: TContext): boolean;
    hasPendingMessages(ctx: TContext): boolean;
    hasPendingControl(): boolean;
    publication: Pick<BaleBridgePublicationRuntime, "hasPending" | "hasUnconfirmed">;
    activity: Pick<Activity.BaleActivityRuntime, "hasPending">;
    delivery: Pick<ReturnType<typeof Delivery.createBaleDeliveryLifecycleHooks>, "hasPendingTarget">;
    api: Pick<BaleApi.BaleApiTargetActivityRuntime, "hasPendingTarget">;
}): (target: BaleTarget & {
    threadId: number;
}, ctx: TContext) => BaleBusLiveRebindWorkState;
interface BaleCommandsAndToolsBindingDeps {
    pi: Pi.ExtensionAPI;
    handleInternalAction: Commands.BaleSessionActionRuntime["handleInternalAction"];
    agentDir: string;
    configStore: Config.BaleConfigStore;
    persistConfig: (config?: Config.BaleConfig) => Promise<void>;
    setup: Setup.BaleSetupGuard;
    activeTurnRuntime: Queue.BaleActiveTurnStore<Queue.PendingBaleTurn>;
    lockedPollingRuntime: Locks.BaleLockedPollingRuntime<Pi.ExtensionContext>;
    stopPolling?: () => Promise<void | string>;
    getDisconnectThreadName?: () => string | undefined;
    onTransportChanged?: () => Promise<void> | void;
    getStatusLines: (options?: Status.BaleBridgeStatusLineOptions) => string[];
    buttonActionStore: OutboundHandlers.BaleButtonActionStore;
    sendMarkdownReply: (chatId: number, replyToMessageId: number | undefined, markdown: string, options?: {
        replyMarkup?: unknown;
        target?: {
            chatId: number;
            threadId?: number;
        };
    }) => Promise<number | undefined>;
    sendChannelMarkdownMessage: NonNullable<OutboundAttachments.BaleOutboundMessageToolRegistrationDeps["sendChannelMarkdownMessage"]>;
    sendChannelMediaMessage: NonNullable<OutboundAttachments.BaleOutboundMessageToolRegistrationDeps["sendChannelMediaMessage"]>;
    listChannelPosts: ChannelPosts.BaleChannelPostJournalStore["list"];
    mutateChannelPost(input: {
        action: "edit" | "delete";
        operationId: string;
        mutationId: string;
        markdown?: string;
    }): Promise<ChannelPosts.BaleChannelPostRecord>;
    callMultipart: OutboundHandlers.BaleVoiceReplySenderDeps["sendMultipart"];
    getDefaultChatId: () => number | undefined;
    getDefaultTarget?: () => OutboundAttachments.BaleQueuedOutboundAttachmentTurnView["target"];
    resolveAgentTarget?: OutboundAttachments.BaleOutboundMessageToolRegistrationDeps["resolveAgentTarget"];
    routeAgentMessage?: OutboundAttachments.BaleOutboundMessageToolRegistrationDeps["routeAgentMessage"];
    canSendDirect: () => boolean;
    setGenerativeAppLiveSurfaceRuntime?: (runtime: GenerativeApps.GenerativeAppLiveSurfaceRuntime<GenerativeApps.BaleBindLiveHandle> | undefined) => void;
    updateStatus: BaleBridgeStatusUpdater;
    isContextCurrent: (ctx: Pi.ExtensionContext) => boolean;
    getSessionGeneration: () => number;
    connectionIntent: NonNullable<Commands.BaleBridgeCommandRegistrationDeps["connectionIntent"]>;
    recordRuntimeEvent: BaleRuntimeEventRecorder;
}
export declare function registerBaleCommandsAndTools({ pi, handleInternalAction, agentDir, configStore, persistConfig, setup, activeTurnRuntime, lockedPollingRuntime, stopPolling, getDisconnectThreadName, onTransportChanged, getStatusLines, buttonActionStore, sendMarkdownReply, sendChannelMarkdownMessage, sendChannelMediaMessage, listChannelPosts, mutateChannelPost, callMultipart, getDefaultChatId, getDefaultTarget, resolveAgentTarget, routeAgentMessage, canSendDirect, setGenerativeAppLiveSurfaceRuntime, recordRuntimeEvent, updateStatus, isContextCurrent, getSessionGeneration, connectionIntent, }: BaleCommandsAndToolsBindingDeps): void;
interface BaleLifecycleBindingDeps {
    pi: Pi.ExtensionAPI;
    publicationRuntime: BaleBridgePublicationRuntime;
    activityRuntime: Activity.BaleActivityRuntime;
    activityVerbosityRuntime?: ActivityVerbosity.BaleActivityVerbosityRuntime;
    diagnostics?: {
        onSessionStart(): void;
        onSessionShutdown(): Promise<void>;
    };
    assistantOutputRuntime: Pick<Activity.BaleAssistantOutputRuntime, "start" | "beginTurn" | "hasAdmittedBaleIntermediate" | "waitForIdle" | "stop">;
    sessionLifecycleRuntime: Pick<Lifecycle.BaleLifecycleRegistrationDeps, "onSessionStart" | "onSessionShutdown" | "onModelSelect">;
    configStore: Pick<Config.BaleConfigStore, "get" | "getOutboundHandlers" | "hasBotToken" | "load">;
    abort: Runtime.BaleRuntimeAbortPort;
    typing: Runtime.BaleRuntimeTypingPort;
    lifecycle: Runtime.BaleRuntimeLifecyclePort;
    activeTurnRuntime: Queue.BaleActiveTurnStore<Queue.PendingBaleTurn>;
    baleQueueStore: Queue.BaleQueueStore<Pi.ExtensionContext>;
    modelSwitchController: Model.BaleModelSwitchController<Pi.ExtensionContext, Model.ScopedBaleModel<ActivePiModel>>;
    previewRuntime: Preview.BaleAssistantPreviewRuntime<Pi.AgentEndEvent["messages"][number], Keyboard.BaleInlineKeyboardMarkup>;
    promptDispatchRuntime: Runtime.BalePromptDispatchRuntime<Pi.ExtensionContext>;
    deferredQueueDispatchRuntime: Queue.BaleDeferredQueueDispatchRuntime<Pi.ExtensionContext>;
    modelContextAvailabilityRuntime: Prompts.BaleModelContextAvailabilityRuntime;
    disconnectOnQuit?: () => Promise<unknown>;
    onSessionStarted?: (event: Pi.SessionStartEvent, ctx: Pi.ExtensionContext) => void;
    shutdownGenerativeAppLiveSurfaces?: () => void;
    resolveAutomaticThreadCleanupEnabled?: () => boolean | Promise<boolean>;
    buttonActionStore: OutboundHandlers.BaleButtonActionStore;
    callMultipart: (...args: Parameters<BaleApi.BaleBridgeApiRuntime["callMultipart"]>) => Promise<unknown>;
    sendChatAction: NonNullable<OutboundHandlers.BaleVoiceReplySenderDeps["sendChatAction"]>;
    sendRecordVoiceAction: NonNullable<OutboundHandlers.BaleVoiceReplySenderDeps["sendRecordVoiceAction"]>;
    sendMarkdownReply: Queue.BaleAgentEndHookRuntimeDeps<Queue.PendingBaleTurn, Pi.ExtensionContext, Pi.AgentEndEvent["messages"][number], Keyboard.BaleInlineKeyboardMarkup>["sendMarkdownReply"];
    sendTextReply: Queue.BaleAgentEndHookRuntimeDeps<Queue.PendingBaleTurn, Pi.ExtensionContext, Pi.AgentEndEvent["messages"][number], Keyboard.BaleInlineKeyboardMarkup>["sendTextReply"] & NonNullable<OutboundHandlers.BaleVoiceReplySenderDeps["sendTextReply"]>;
    dispatchNextQueuedBaleTurn: (ctx: Pi.ExtensionContext) => void;
    onSteerTurnEnd?: BaleQueueBindingRuntime<Pi.ExtensionContext>["onTurnEnd"];
    onPromptHandedOff?: (turn: Queue.PendingBaleTurn, ctx: Pi.ExtensionContext) => void;
    answerGuestQuery: BaleApi.BaleBridgeApiRuntime["answerGuestQuery"];
    editGuestInlineMessage?: BaleApi.BaleBridgeApiRuntime["editGuestInlineMessage"];
    deleteMessage: BaleApi.BaleBridgeApiRuntime["deleteMessage"];
    sendGuestReply: NonNullable<Queue.BaleAgentEndHookRuntimeDeps<Queue.PendingBaleTurn, Pi.ExtensionContext, Pi.AgentEndEvent["messages"][number], Keyboard.BaleInlineKeyboardMarkup>["sendGuestReply"]>;
    editGuestReply?: Queue.BaleAgentEndHookRuntimeDeps<Queue.PendingBaleTurn, Pi.ExtensionContext, Pi.AgentEndEvent["messages"][number], Keyboard.BaleInlineKeyboardMarkup>["editGuestReply"];
    stopGuestPlaceholder?: Queue.BaleAgentEndHookRuntimeDeps<Queue.PendingBaleTurn, Pi.ExtensionContext, Pi.AgentEndEvent["messages"][number], Keyboard.BaleInlineKeyboardMarkup>["stopGuestPlaceholder"];
    preparePreviewDelivery?: Queue.BaleAgentEndRuntimeDeps<Queue.PendingBaleTurn>["preparePreviewDelivery"];
    finalizeMarkdownPreview: Queue.BaleAgentEndHookRuntimeDeps<Queue.PendingBaleTurn, Pi.ExtensionContext, Pi.AgentEndEvent["messages"][number], Keyboard.BaleInlineKeyboardMarkup>["finalizeMarkdownPreview"];
    proactivePushTargetGetter: () => Queue.BaleQueueTarget | undefined;
    getAssistantRenderingMode: () => "rich" | "html";
    recordMessageOwnership?: (input: {
        chatId: number;
        messageId: number;
        target?: Queue.BaleQueueTarget;
    }) => void;
    canSendAgentActivity: (ctx: Pi.ExtensionContext) => boolean;
    isSessionContextActive: (ctx: Pi.ExtensionContext) => boolean;
    getSessionGeneration?: () => number;
    isTurnTransportActive?: (turn: Queue.PendingBaleTurn) => boolean;
    updateStatus: BaleBridgeStatusUpdater;
    recordRuntimeEvent: BaleRuntimeEventRecorder;
    /** Settled-session hint for owners that wait on agent idleness, such as old-tab cleanup after a live rebind. */
    onSessionSettled?: (ctx: Pi.ExtensionContext) => void;
}
export declare function registerBaleLifecycleRuntimeHooks({ pi, publicationRuntime, activityRuntime, activityVerbosityRuntime, diagnostics, assistantOutputRuntime, sessionLifecycleRuntime, configStore, abort, typing, lifecycle, activeTurnRuntime, baleQueueStore, modelSwitchController, previewRuntime, promptDispatchRuntime, deferredQueueDispatchRuntime, modelContextAvailabilityRuntime, disconnectOnQuit, onSessionStarted, shutdownGenerativeAppLiveSurfaces, resolveAutomaticThreadCleanupEnabled, buttonActionStore, callMultipart, sendChatAction, sendRecordVoiceAction, sendMarkdownReply, sendTextReply, dispatchNextQueuedBaleTurn, onSteerTurnEnd, onPromptHandedOff, answerGuestQuery, editGuestInlineMessage, deleteMessage, sendGuestReply, editGuestReply, stopGuestPlaceholder, preparePreviewDelivery, finalizeMarkdownPreview, proactivePushTargetGetter, getAssistantRenderingMode, recordMessageOwnership, canSendAgentActivity, isSessionContextActive, getSessionGeneration, isTurnTransportActive, updateStatus, recordRuntimeEvent, onSessionSettled, }: BaleLifecycleBindingDeps): void;
export {};

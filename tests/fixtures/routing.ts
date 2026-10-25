/** Native routing composition shared by route regressions and cross-domain custody acceptance. Zones: bale, pi agent, shared utils. */
import * as Bindings from "../../lib/bindings.ts";
import * as Commands from "../../lib/commands.ts";
import * as Media from "../../lib/media.ts";
import * as Menu from "../../lib/menu.ts";
import * as Model from "../../lib/model.ts";
import * as Outbound from "../../lib/outbound.ts";
import * as Queue from "../../lib/queue.ts";
import * as Routing from "../../lib/routing.ts";
import * as Runtime from "../../lib/runtime.ts";
import * as TextGroups from "../../lib/text-groups.ts";
import * as Threads from "../../lib/threads.ts";
import * as Updates from "../../lib/updates.ts";

export interface TestContext { cwd: string; }
export interface TestModel extends Model.MenuModel { provider: "test"; id: "model"; }
export interface TestUser extends Updates.BaleUser {}
export interface TestMessage extends Routing.BaleRoutedMessage {
  date?: number;
  chat: { id: number; type: "private" };
  from?: TestUser;
  message_id: number;
  message_thread_id?: number;
  media_group_id?: string;
  photo?: Array<{ file_id: string; file_unique_id: string; width: number; height: number }>;
  caption?: string;
  text?: string;
  reply_markup?: Outbound.BaleOutboundButtonMarkup;
}
export interface TestCallbackQuery extends Routing.BaleRoutedCallbackQuery {
  id: string;
  from: TestUser;
  message?: TestMessage;
  data?: string;
}
export interface TestUpdate extends Updates.BaleUpdateFlow {
  update_id?: number;
  message?: TestMessage;
  edited_message?: TestMessage;
  callback_query?: TestCallbackQuery;
}

export interface RouteHarnessOptions {
  config?: unknown;
  configStore?: Routing.BaleInboundRouteRuntimeDeps<
    TestMessage, TestCallbackQuery, TestContext, TestModel
  >["configStore"];
  sendStatusMessage?: Menu.BaleMenuActionRuntime<TestContext, TestModel>["sendStatusMessage"];
  beginCommandEffectWork?: Routing.BaleInboundRouteRuntimeDeps<TestMessage, TestCallbackQuery, TestContext, TestModel>["beginCommandEffectWork"];
  recordRuntimeEvent?: Routing.BaleInboundRouteRuntimeDeps<TestMessage, TestCallbackQuery, TestContext, TestModel>["recordRuntimeEvent"];
  isIdle?: Routing.BaleInboundRouteRuntimeDeps<TestMessage, TestCallbackQuery, TestContext, TestModel>["isIdle"];
  dispatchNextQueuedBaleTurn?: Routing.BaleInboundRouteRuntimeDeps<TestMessage, TestCallbackQuery, TestContext, TestModel>["dispatchNextQueuedBaleTurn"];
  requestNextDispatchAnnouncement?: Routing.BaleInboundRouteRuntimeDeps<TestMessage, TestCallbackQuery, TestContext, TestModel>["requestNextDispatchAnnouncement"];
  cancelNextDispatchAnnouncement?: Routing.BaleInboundRouteRuntimeDeps<TestMessage, TestCallbackQuery, TestContext, TestModel>["cancelNextDispatchAnnouncement"];
  menuActions?: Menu.BaleMenuActionRuntime<TestContext, TestModel>;
  openQueueMenu?: Routing.BaleInboundRouteRuntimeDeps<TestMessage, TestCallbackQuery, TestContext, TestModel>["openQueueMenu"];
  openSettingsMenu?: Routing.BaleInboundRouteRuntimeDeps<TestMessage, TestCallbackQuery, TestContext, TestModel>["openSettingsMenu"];
  sendInteractiveMessage?: Routing.BaleInboundRouteRuntimeDeps<
    TestMessage, TestCallbackQuery, TestContext, TestModel
  >["sendInteractiveMessage"];
  editInteractiveMessage?: Routing.BaleInboundRouteRuntimeDeps<
    TestMessage, TestCallbackQuery, TestContext, TestModel
  >["editInteractiveMessage"];
  threadStore?: Threads.BaleTopicTargetStore;
  runWorkspaceOperation?: Routing.BaleInboundRouteRuntimeDeps<
    TestMessage,
    TestCallbackQuery,
    TestContext,
    TestModel
  >["runWorkspaceOperation"];
  callApi?: Routing.BaleInboundRouteRuntimeDeps<
    TestMessage,
    TestCallbackQuery,
    TestContext,
    TestModel
  >["callApi"];
  answerGuestQueryForInlineMessage?: Routing.BaleInboundRouteRuntimeDeps<
    TestMessage,
    TestCallbackQuery,
    TestContext,
    TestModel
  >["answerGuestQueryForInlineMessage"];
  startGuestPlaceholder?: Routing.BaleInboundRouteRuntimeDeps<
    TestMessage,
    TestCallbackQuery,
    TestContext,
    TestModel
  >["startGuestPlaceholder"];
  deleteMessage?: Routing.BaleInboundRouteRuntimeDeps<
    TestMessage,
    TestCallbackQuery,
    TestContext,
    TestModel
  >["deleteMessage"];
  editMessageReplyMarkup?: Routing.BaleInboundRouteRuntimeDeps<
    TestMessage,
    TestCallbackQuery,
    TestContext,
    TestModel
  >["editMessageReplyMarkup"];
  workspaceRestoreRecipient?: Routing.BaleInboundRouteRuntimeDeps<TestMessage, TestCallbackQuery, TestContext, TestModel>["workspaceRestoreRecipient"];
  getWorkspaceRestoreStore?: Routing.BaleInboundRouteRuntimeDeps<TestMessage, TestCallbackQuery, TestContext, TestModel>["getWorkspaceRestoreStore"];
  captureWorkspaceExternalProtection?: Routing.BaleInboundRouteRuntimeDeps<TestMessage, TestCallbackQuery, TestContext, TestModel>["captureWorkspaceExternalProtection"];
  inspectRestoreSourceAbandonment?: Routing.BaleInboundRouteRuntimeDeps<TestMessage, TestCallbackQuery, TestContext, TestModel>["inspectRestoreSourceAbandonment"];
  inspectRoutingInputGroupExpiry?: Routing.BaleInboundRouteRuntimeDeps<TestMessage, TestCallbackQuery, TestContext, TestModel>["inspectRoutingInputGroupExpiry"];
  inspectRestoreSourceCompletion?: Routing.BaleInboundRouteRuntimeDeps<TestMessage, TestCallbackQuery, TestContext, TestModel>["inspectRestoreSourceCompletion"];
  inspectRestoreQueuedReceipt?: Routing.BaleInboundRouteRuntimeDeps<TestMessage, TestCallbackQuery, TestContext, TestModel>["inspectRestoreQueuedReceipt"];
  hasWorkspaceRestoreAuthority?: () => boolean;
  hasWorkspaceLiveRebindAuthority?: () => boolean;
  canUsePreDispatchRebind?: Routing.BaleInboundRouteRuntimeDeps<TestMessage, TestCallbackQuery, TestContext, TestModel>["canUsePreDispatchRebind"];
  inspectTemporaryThreadSources?: Routing.BaleInboundRouteRuntimeDeps<TestMessage, TestCallbackQuery, TestContext, TestModel>["inspectTemporaryThreadSources"];
  recoverTemporaryThreadDeadQueueOwners?: Routing.BaleInboundRouteRuntimeDeps<TestMessage, TestCallbackQuery, TestContext, TestModel>["recoverTemporaryThreadDeadQueueOwners"];
  onItemsDiscarded?: Queue.BaleQueueMutationControllerDeps<TestContext>["onItemsDiscarded"];
  queueAdmission?: Parameters<typeof Bindings.createBaleQueueBindingRuntime<TestContext>>[0]["admission"];
  hasPendingMessages?: (ctx: TestContext) => boolean;
  liveRebindCommandCompletionTimeoutMs?: number;
  liveRebindCleanupSchedule?: Routing.BaleInboundRouteRuntimeDeps<TestMessage, TestCallbackQuery, TestContext, TestModel>["liveRebindCleanupSchedule"];
  temporaryThreadCleanupDelayMs?: number;
  getSessionGeneration?: () => number;
  foreignOwnedUpdateForwarder?: Routing.BaleInboundRouteRuntimeDeps<
    TestMessage,
    TestCallbackQuery,
    TestContext,
    TestModel
  >["foreignOwnedUpdateForwarder"];
  getTargetOwnership?: Routing.BaleInboundRouteRuntimeDeps<TestMessage, TestCallbackQuery, TestContext, TestModel>["getTargetOwnership"];
  getMessageOwnership?: Routing.BaleInboundRouteRuntimeDeps<TestMessage, TestCallbackQuery, TestContext, TestModel>["getMessageOwnership"];
  getCurrentLeaderEpoch?: () => number | string | undefined;
  getAdmissionJournalBinding?: () => string | undefined;
  isContextActive?: (ctx: TestContext) => boolean;
  setCurrentLeaderIdentity?: Routing.BaleInboundRouteRuntimeDeps<
    TestMessage,
    TestCallbackQuery,
    TestContext,
    TestModel
  >["setCurrentLeaderIdentity"];
  getLiveThreadTargets?: () => Queue.BaleQueueTarget[];
  getDisplayTitle?: (target: Queue.BaleQueueTarget) => string | undefined;
  getLocalThreadLabelForTarget?: (
    target: Queue.BaleQueueTarget,
  ) => string | undefined;
  instanceId?: string;
  isVoiceReplyActive?: () => boolean;
  getCommands?: () => any[];
  mediaGroupRuntime?: Media.BaleMediaGroupController<
    TestMessage,
    TestContext
  >;
  downloadFile?: Routing.BaleInboundRouteRuntimeDeps<
    TestMessage,
    TestCallbackQuery,
    TestContext,
    TestModel
  >["downloadFile"];
  processInbound?: Routing.BaleInboundRouteRuntimeDeps<
    TestMessage,
    TestCallbackQuery,
    TestContext,
    TestModel
  >["inboundHandlerRuntime"]["process"];
  invokeBoundButtonAction?: Routing.BaleInboundRouteRuntimeDeps<
    TestMessage,
    TestCallbackQuery,
    TestContext,
    TestModel
  >["invokeBoundButtonAction"];
  validateThreadName?: (name: string) => string | undefined;
  renameCurrentThread?: Commands.BaleThreadDisplayNameRenamePort;
  resetCurrentThreadName?: Commands.BaleThreadDisplayNameResetPort;
  setMyCommands?: Routing.BaleInboundRouteRuntimeDeps<TestMessage, TestCallbackQuery, TestContext, TestModel>["setMyCommands"];
  sendTextReply?: Routing.BaleInboundRouteRuntimeDeps<TestMessage, TestCallbackQuery, TestContext, TestModel>["sendTextReply"];
  observeTextReply?: (
    text: string,
    options: Parameters<
      Routing.BaleInboundRouteRuntimeDeps<
        TestMessage,
        TestCallbackQuery,
        TestContext,
        TestModel
      >["sendTextReply"]
    >[3],
  ) => void;
}

export function createRouteHarness(options: RouteHarnessOptions = {}) {
  const events: string[] = [];
  const model: TestModel = { provider: "test", id: "model" };
  const bridgeRuntime = Runtime.createBaleBridgeRuntime();
  const activeTurnRuntime = Queue.createBaleActiveTurnStore();
  const baleQueueStore = Queue.createBaleQueueStore<TestContext>();
  const buttonActionStore = Outbound.createBaleButtonActionStore();
  const deferredDispatch = Queue.createBaleDeferredQueueDispatchRuntime<TestContext>();
  deferredDispatch.bind({ cwd: "/repo" });
  const queueBinding = options.queueAdmission && Bindings.createBaleQueueBindingRuntime<TestContext>({
    store: baleQueueStore, queue: bridgeRuntime.queue, lifecycle: bridgeRuntime.lifecycle, activeTurn: activeTurnRuntime,
    admission: options.queueAdmission, deferredDispatch, transportStamp: { isActive: () => true },
    promptDispatch: { startTypingLoop() {}, onPromptDispatchStart() {}, onPromptDispatchFailure() {} },
    isIdle: options.isIdle ?? (() => true), hasPendingMessages: options.hasPendingMessages ?? (() => false), updateStatus: () => events.push("status"),
    sendTextReply: async () => { events.push("queue-notice"); }, sendUserMessage: () => events.push("queue-model-send"),
  });
  const queueMutationRuntime = queueBinding?.mutation ?? Queue.createBaleQueueMutationController({
    ...baleQueueStore,
    hasPendingDispatch: bridgeRuntime.lifecycle.hasDispatchPending,
    allocateLaneOrder: bridgeRuntime.queue.allocateItemOrder,
    onItemsDiscarded: options.onItemsDiscarded,
    updateStatus: () => events.push("status"),
  });
  const currentModelRuntime = Model.createCurrentModelRuntime<
    TestContext,
    TestModel
  >({
    getContextModel: () => model,
    updateStatus: () => events.push("status"),
  });
  const modelSwitchController =
    Model.createBaleModelSwitchControllerRuntime<
      TestContext,
      Model.ScopedBaleModel<TestModel>
    >({
      isIdle: () => true,
      getActiveTurn: activeTurnRuntime.get,
      getAbortHandler: bridgeRuntime.abort.getHandler,
      hasAbortHandler: bridgeRuntime.abort.hasHandler,
      getActiveToolExecutions: bridgeRuntime.lifecycle.getActiveToolExecutions,
      allocateItemOrder: bridgeRuntime.queue.allocateItemOrder,
      allocateControlOrder: bridgeRuntime.queue.allocateControlOrder,
      appendQueuedItem: queueMutationRuntime.append,
      updateStatus: () => events.push("status"),
    });
  const menuActions: Menu.BaleMenuActionRuntime<TestContext, TestModel> = {
    updateModelMenuMessage: async () => undefined,
    updateThinkingMenuMessage: async () => undefined,
    updateStatusMessage: async () => undefined,
    sendStatusMessage: async (...args) => {
      events.push("status-menu");
      await options.sendStatusMessage?.(...args);
    },
    openModelMenu: async () => undefined,
    openThinkingMenu: async () => undefined,
  };
  const routingDeps: Routing.BaleInboundRouteRuntimeDeps<TestMessage, TestCallbackQuery, TestContext, TestModel> = {
    configStore: options.configStore ?? {
      get: () => (options.config ?? {}) as never,
      getAllowedUserId: () => 7,
      persistAllowedUserId: async () => true,
      persist: async () => undefined,
    },
    callApi: options.callApi,
    workspaceRestoreRecipient: options.workspaceRestoreRecipient,
    getWorkspaceRestoreStore: options.getWorkspaceRestoreStore,
    captureWorkspaceExternalProtection: options.captureWorkspaceExternalProtection,
    inspectRestoreSourceAbandonment: options.inspectRestoreSourceAbandonment,
    inspectRoutingInputGroupExpiry: options.inspectRoutingInputGroupExpiry,
    inspectRestoreSourceCompletion: options.inspectRestoreSourceCompletion,
    inspectRestoreQueuedReceipt: options.inspectRestoreQueuedReceipt,
    hasWorkspaceRestoreAuthority: options.hasWorkspaceRestoreAuthority,
    hasWorkspaceLiveRebindAuthority: options.hasWorkspaceLiveRebindAuthority,
    canUsePreDispatchRebind: options.canUsePreDispatchRebind,
    inspectTemporaryThreadSources: options.inspectTemporaryThreadSources,
    recoverTemporaryThreadDeadQueueOwners: options.recoverTemporaryThreadDeadQueueOwners,
    temporaryThreadCleanupDelayMs: options.temporaryThreadCleanupDelayMs,
    liveRebindCleanupSchedule: options.liveRebindCleanupSchedule,
    liveRebindCommandCompletionTimeoutMs: options.liveRebindCommandCompletionTimeoutMs,
    getSessionGeneration: options.getSessionGeneration,
    foreignOwnedUpdateForwarder: options.foreignOwnedUpdateForwarder,
    getTargetOwnership: options.getTargetOwnership,
    getMessageOwnership: options.getMessageOwnership,
    getCurrentInstanceId: () => options.instanceId ?? "leader-a",
    getAdmissionScope: () => "profile-a:bot-a",
    getAdmissionJournalBinding: options.getAdmissionJournalBinding,
    isContextActive: options.isContextActive,
    getLiveThreadTargets: options.getLiveThreadTargets,
    getDisplayTitle: options.getDisplayTitle,
    getLocalThreadLabelForTarget: options.getLocalThreadLabelForTarget,
    getCurrentLeaderEpoch: options.getCurrentLeaderEpoch,
    setCurrentLeaderIdentity: options.setCurrentLeaderIdentity,
    bridgeRuntime,
    activeTurnRuntime,
    mediaGroupRuntime:
      options.mediaGroupRuntime ??
      Media.createBaleMediaGroupController<TestMessage, TestContext>(),
    textGroupRuntime: TextGroups.createBaleTextGroupController<
      TestMessage,
      TestContext
    >({ forwardCommentWaitMs: false }),
    baleQueueStore,
    queueMutationRuntime,
    modelMenuRuntime: Menu.createBaleModelMenuRuntime<TestModel>(),
    currentModelRuntime,
    modelSwitchController,
    menuActions: options.menuActions ?? menuActions,
    openQueueMenu: options.openQueueMenu ?? (async () => undefined),
    openSettingsMenu: options.openSettingsMenu,
    queueMenuCallbackHandler: async () => false,
    inboundHandlerRuntime: {
      process:
        options.processInbound ??
        (async (files, rawText) => ({
          rawText,
          promptFiles: files,
          handlerOutputs: [],
          handledFiles: [],
        })),
    },
    threadStore: options.threadStore,
    runWorkspaceOperation: options.runWorkspaceOperation,
    buttonActionStore,
    invokeBoundButtonAction: options.invokeBoundButtonAction,
    updateStatus: () => events.push("status"),
    dispatchNextQueuedBaleTurn: options.dispatchNextQueuedBaleTurn ?? queueBinding?.dispatchNext ?? (() => events.push("dispatch")),
    requestNextDispatchAnnouncement: options.requestNextDispatchAnnouncement ?? queueBinding?.requestNextDispatchAnnouncement,
    cancelNextDispatchAnnouncement: options.cancelNextDispatchAnnouncement ?? queueBinding?.cancelNextDispatchAnnouncement,
    answerCallbackQuery: async (_id, text) => {
      if (text) events.push(`answer:${text}`);
    },
    answerGuestQuery: async () => undefined,
    answerGuestQueryForInlineMessage: options.answerGuestQueryForInlineMessage,
    startGuestPlaceholder: options.startGuestPlaceholder,
    editMessageReplyMarkup: options.editMessageReplyMarkup,
    editInteractiveMessage: options.editInteractiveMessage,
    sendInteractiveMessage: options.sendInteractiveMessage ??  (async (_chatId, text, mode, replyMarkup, sendOptions) => {
      events.push(`interactive:${mode}:${text}`);
      events.push(`markup:${JSON.stringify(replyMarkup)}`);
      events.push(`interactive-options:${JSON.stringify(sendOptions ?? {})}`);
      return 99;
    }),
    sendTextReply: options.sendTextReply ?? (async (_chatId, _replyToMessageId, text, replyOptions) => {
      options.observeTextReply?.(text, replyOptions);
      events.push(`reply:${text}`);
      if (typeof replyOptions?.target?.threadId === "number") {
        events.push(
          `reply-target:${replyOptions.target.chatId}:${replyOptions.target.threadId}`,
        );
      }
      return undefined;
    }),
    deleteMessage:
      options.deleteMessage ??
      (async (chatId, messageId) => {
        events.push(`delete-message:${chatId}:${messageId}`);
      }),
    setMyCommands: options.setMyCommands ?? (async () => undefined),
    validateThreadName: options.validateThreadName,
    renameCurrentThread: options.renameCurrentThread,
    resetCurrentThreadName: options.resetCurrentThreadName,
    getCommands: options.getCommands ?? (() => []),
    downloadFile:
      options.downloadFile ??
      (async (_fileId, fileName) => `/tmp/${fileName}`),
    getThinkingLevel: () => "high",
    setThinkingLevel: () => undefined,
    isVoiceReplyActive: options.isVoiceReplyActive,
    setModel: async () => true,
    sendUserMessage: (message, opts) => {
      events.push(`user:${message}:${opts?.deliverAs ?? "default"}`);
    },
    isIdle: options.isIdle ?? (() => true),
    hasPendingMessages: () => false,
    compact: () => undefined,
    beginCommandEffectWork: options.beginCommandEffectWork,
    recordRuntimeEvent: options.recordRuntimeEvent ?? ((category, error) => {
      events.push(`event:${category}:${String(error)}`);
    }),
  };
  const routeRuntime = Routing.createBaleInboundRouteRuntime<TestUpdate, TestMessage, TestCallbackQuery, TestContext, TestModel>(routingDeps);
  return { buttonActionStore, bridgeRuntime, events, routeRuntime, routingDeps, baleQueueStore, activeTurnRuntime, queueBinding };
}

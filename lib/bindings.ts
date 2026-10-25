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
import * as CommandTemplates from "./command-templates.ts";
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
export function createBaleFollowerSelectedCommandBinding<
  TContext,
  TModel extends Model.MenuModel = Model.MenuModel,
>(deps: {
  ctx: TContext;
  operationId: string;
  registrationGeneration: string;
  name: string;
  target: BaleTarget & { threadId: number };
  recipient: Pick<
    BaleBusFollowerCommandOwner<TContext>,
    "isCurrent" | "assertRecipientCurrent"
  >;
  command: Pick<
    ReturnType<
      typeof Commands.createBaleCommandHandlerTargetRuntime<
        Commands.BaleCommandRuntimeMessage,
        TContext
      >
    >,
    "prepareHeldCommand" | "canPrepareHeldCommand"
  >;
  menu?: Omit<
    Menu.BaleMenuActionRuntimeDeps<TContext, TModel>,
    "sendTextReply" | "sendInteractiveMessage" | "editInteractiveMessage"
  >;
  deliver: Parameters<
    typeof BusApi.createBaleSelectedMenuTextApi
  >[0]["deliver"];
  recordOwnership: NonNullable<
    Replies.BaleRenderedMessageDeliveryRuntimeDeps<Menu.BaleReplyMarkup>["recordOwnership"]
  >;
}): BaleBusFollowerCommandOwner<TContext> | undefined {
  const {
      ctx,
      operationId,
      registrationGeneration,
      name,
      recipient,
      command,
      deliver,
      recordOwnership,
    } = deps,
    target = { ...deps.target };
  const prepare = command.prepareHeldCommand,
    canPrepare = command.canPrepareHeldCommand;
  const isCurrent = recipient.isCurrent,
    assertRecipientCurrent = recipient.assertRecipientCurrent,
    menu = deps.menu,
    menuPorts = menu && { ...menu };
  if (
    [
      prepare,
      canPrepare,
      isCurrent,
      assertRecipientCurrent,
      deliver,
      recordOwnership,
    ].some((port) => typeof port !== "function") ||
    (menuPorts &&
      [
        menuPorts.getModelMenuState,
        menuPorts.storeModelMenuState,
        menuPorts.getActiveModel,
        menuPorts.getThinkingLevel,
        menuPorts.buildStatusHtml,
        menuPorts.isIdle,
        menuPorts.canOfferInFlightModelSwitch,
      ].some((port) => typeof port !== "function"))
  )
    return undefined;
  const portsCurrent = () =>
    deps.ctx === ctx &&
    deps.operationId === operationId &&
    deps.registrationGeneration === registrationGeneration &&
    deps.name === name &&
    deps.recipient === recipient &&
    recipient.isCurrent === isCurrent &&
    recipient.assertRecipientCurrent === assertRecipientCurrent &&
    deps.command === command &&
    command.prepareHeldCommand === prepare &&
    command.canPrepareHeldCommand === canPrepare &&
    deps.deliver === deliver &&
    deps.recordOwnership === recordOwnership &&
    deps.menu === menu &&
    (!menuPorts ||
      Object.entries(menuPorts).every(
        ([key, value]) => Reflect.get(menu!, key) === value,
      ));
  const current = () =>
    portsCurrent() && isCurrent.call(recipient) && portsCurrent();
  if (!current()) return undefined;
  const api = BusApi.createBaleSelectedMenuTextApi({
    operationId,
    registrationGeneration,
    target,
    assertAuthority: assertRecipientCurrent,
    deliver,
  });
  const rendered =
    Replies.createBaleRenderedMessageDeliveryRuntime<Menu.BaleReplyMarkup>(
      {
        sendMessage: api.sendMessage,
        editMessage: api.editMessageText,
        recordOwnership,
        async sendRichMessage() {
          throw new Error(
            "Selected command has no rich or ordinary API fallback.",
          );
        },
      },
    );
  const menus =
    menuPorts &&
    Menu.createBaleMenuActionRuntime({
      ...menuPorts,
      sendTextReply: rendered.sendTextReply,
      sendInteractiveMessage: rendered.sendInteractiveMessage,
      editInteractiveMessage: rendered.editInteractiveMessage,
    });
  const effects = {
    sendTextReply: rendered.sendTextReply,
    ...(menus ? { showStatus: menus.sendStatusMessage } : {}),
  };
  if (!canPrepare.call(command, name, effects) || !current()) return undefined;
  return {
    isCurrent: current,
    assertRecipientCurrent,
    prepare(readiness, context, input) {
      if (
        !current() ||
        context !== ctx ||
        input.target.chatId !== target.chatId ||
        input.target.threadId !== target.threadId ||
        input.assertRecipientCurrent !== assertRecipientCurrent
      )
        return undefined;
      const plan = prepare.call(
        command,
        name,
        readiness,
        context,
        input,
        effects,
      );
      return current() ? plan : undefined;
    },
  };
}

type ActivePiModel = NonNullable<Pi.ExtensionContext["model"]>;

type BaleRuntimeEventRecorder = (
  category: string,
  error: unknown,
  details?: Record<string, unknown>,
) => void;

type BaleBridgeStatusUpdater =
  Status.BaleStatusRuntime<Pi.ExtensionContext>["updateStatus"];

type BaleAgentTargetResolver = NonNullable<
  OutboundAttachments.BaleOutboundMessageToolRegistrationDeps["resolveAgentTarget"]
>;
type BaleAgentMessageRouter = NonNullable<
  OutboundAttachments.BaleOutboundMessageToolRegistrationDeps["routeAgentMessage"]
>;

export interface BaleQueueBindingRuntime<TContext> {
  mutation: Queue.BaleQueueMutationController<TContext>;
  dispatchNext: (ctx: TContext) => void;
  requestNextDispatchAnnouncement: () => void;
  cancelNextDispatchAnnouncement: () => void;
  watchdog: Queue.BaleQueueDispatchWatchdogRuntime<TContext>;
  onTurnEnd: (
    event: Pick<Pi.TurnEndEvent, "turnIndex" | "outcome">,
    ctx: TContext,
  ) => Pi.TurnEndEventResult | undefined;
}

export function createBaleQueueBindingRuntime<TContext>(deps: {
  store: Queue.BaleQueueStateStore<TContext>;
  queue: Pick<Runtime.BaleBridgeRuntime["queue"], "allocateItemOrder">;
  lifecycle: Pick<
    Runtime.BaleBridgeRuntime["lifecycle"],
    "isCompactionInProgress" | "hasDispatchPending"
  > & Partial<Pick<Runtime.BaleBridgeRuntime["lifecycle"], "getActiveToolExecutions">>;
  activeTurn: Pick<Queue.BaleActiveTurnStore, "has"> & Partial<Pick<Queue.BaleActiveTurnStore, "get">>;
  admission: {
    getSettlement: () =>
      | {
          onItemsDiscarded: (
            items: readonly Queue.BaleQueueItem<TContext>[],
            ctx: TContext,
          ) => boolean;
          isItemReady: (item: Queue.BaleQueueItem<TContext>) => boolean;
          onPromptHandedOff?: (
            item: Pick<Queue.PendingBaleTurn, "admissionReceipts">,
            ctx: TContext,
          ) => boolean;
          onControlSettled: (
            item: Queue.PendingBaleControlItem<TContext>,
            ctx: TContext,
          ) => void;
        }
      | undefined;
    hasPendingQueueMutationForItem: (
      item: Queue.BaleQueueItem<TContext>,
    ) => boolean;
  };
  transportStamp: Pick<Queue.BaleTransportStampRuntime, "isActive">;
  deferredDispatch: Pick<
    Queue.BaleDeferredQueueDispatchRuntime<TContext>,
    "isBound" | "getGeneration" | "isGenerationActive"
  >;
  promptDispatch: Runtime.BalePromptDispatchRuntime<TContext>;
  isIdle: (ctx: TContext) => boolean;
  hasPendingMessages: (ctx: TContext) => boolean;
  isContextCurrent?: (ctx: TContext) => boolean;
  isContextAborted?: (ctx: TContext) => boolean;
  updateStatus: (ctx: TContext, error?: string) => void;
  sendTextReply: Queue.BaleQueueDispatchRuntimeDeps<TContext>["sendTextReply"];
  sendUserMessage: Queue.BaleQueueDispatchRuntimeDeps<TContext>["sendUserMessage"];
  reconcileNextDispatchAnnouncementReplyOwnership?: (
    item: Queue.PendingBaleTurn,
  ) => void;
  recordRuntimeEvent?: BaleRuntimeEventRecorder;
}): BaleQueueBindingRuntime<TContext> {
  const settleDiscardedItems = (
    items: readonly Queue.BaleQueueItem<TContext>[],
    ctx: TContext,
  ): boolean => {
    const durableItems = items.filter(
      (item) => (item.admissionReceipts?.length ?? 0) > 0,
    );
    if (durableItems.length === 0) return true;
    const settlement = deps.admission.getSettlement();
    if (!settlement) return false;
    return settlement.onItemsDiscarded(durableItems, ctx) === true;
  };
  const settlePromptPacket = (items: readonly Queue.PendingBaleTurn[], ctx: TContext): boolean => {
    const receipts = items.flatMap(item => item.admissionReceipts ?? []);
    return receipts.length === 0 || deps.admission.getSettlement()?.onPromptHandedOff?.({ admissionReceipts: receipts }, ctx) === true;
  };
  const mutation = Queue.createBaleQueueMutationController({
    ...deps.store,
    hasPendingDispatch: deps.lifecycle.hasDispatchPending,
    allocateLaneOrder: deps.queue.allocateItemOrder,
    onItemsDiscarded(items, ctx) {
      if (!settleDiscardedItems(items, ctx)) {
        throw new Error("Bale queue items could not be discarded durably.");
      }
    },
    updateStatus: deps.updateStatus,
    recordRuntimeEvent: deps.recordRuntimeEvent,
  });
  const dispatch = Queue.createBaleQueueDispatchRuntime({
    ...deps.store,
    isCompactionInProgress: deps.lifecycle.isCompactionInProgress,
    hasActiveTurn: deps.activeTurn.has,
    hasDispatchPending: deps.lifecycle.hasDispatchPending,
    isIdle: deps.isIdle,
    hasPendingMessages: deps.hasPendingMessages,
    hasDispatchContext: deps.deferredDispatch.isBound,
    getDispatchGeneration: deps.deferredDispatch.getGeneration,
    isDispatchGenerationActive: deps.deferredDispatch.isGenerationActive,
    isQueueItemTransportActive(item) {
      return deps.transportStamp.isActive(item.transportStamp);
    },
    hasPendingInboundQueueMutationForItem(item) {
      return deps.admission.hasPendingQueueMutationForItem(item);
    },
    isQueueItemAdmissionReady(item) {
      return (
        deps.admission.getSettlement()?.isItemReady(item) ??
        (item.admissionReceipts?.length ?? 0) === 0
      );
    },
    commitPromptDispatch(item, ctx) {
      if ((item.admissionReceipts?.length ?? 0) === 0) return true;
      const settlement = deps.admission.getSettlement();
      if (!settlement?.onPromptHandedOff) return false;
      return settlement.onPromptHandedOff(item, ctx) === true;
    },
    steerDispatch: {
      commitPacket: settlePromptPacket,
      isContextCurrent: (ctx: TContext) => deps.isContextCurrent?.(ctx) === true,
      canSubmit: (ctx: TContext) => deps.isContextAborted?.(ctx) === false &&
        deps.isIdle(ctx) && !deps.hasPendingMessages(ctx) && !deps.lifecycle.isCompactionInProgress() &&
        !deps.activeTurn.has() && (deps.lifecycle.getActiveToolExecutions?.() ?? 0) === 0,
    },
    onControlSettled(item, ctx) {
      deps.admission.getSettlement()?.onControlSettled(item, ctx);
    },
    onPromptSkipped(item, ctx) {
      return settleDiscardedItems([item], ctx);
    },
    updateStatus: deps.updateStatus,
    sendTextReply: deps.sendTextReply,
    reconcileNextDispatchAnnouncementReplyOwnership:
      deps.reconcileNextDispatchAnnouncementReplyOwnership,
    recordRuntimeEvent: deps.recordRuntimeEvent,
    ...deps.promptDispatch,
    sendUserMessage: deps.sendUserMessage,
  });
  const steer = Queue.createBaleSteerBoundaryRuntime({
    ...deps.store,
    getGeneration: deps.deferredDispatch.getGeneration,
    isContextCurrent: (ctx: TContext) => deps.isContextCurrent?.(ctx) === true,
    isBlocked: (ctx: TContext) =>
      deps.isContextAborted?.(ctx) !== false || !deps.deferredDispatch.isBound() ||
      deps.isIdle(ctx) || deps.hasPendingMessages(ctx) ||
      deps.lifecycle.isCompactionInProgress() || deps.lifecycle.hasDispatchPending() ||
      (deps.lifecycle.getActiveToolExecutions?.() ?? 0) > 0 ||
      (deps.activeTurn.has() && !deps.activeTurn.get?.()),
    isItemReady(item: Queue.BaleQueueItem<TContext>) {
      return deps.transportStamp.isActive(item.transportStamp) &&
        !deps.admission.hasPendingQueueMutationForItem(item) &&
        (deps.admission.getSettlement()?.isItemReady(item) ?? (item.admissionReceipts?.length ?? 0) === 0);
    },
    isItemCurrent: (item) => deps.transportStamp.isActive(item.transportStamp) &&
      !deps.admission.hasPendingQueueMutationForItem(item),
    getActiveTurn: () => deps.activeTurn.get?.(),
    commitPacket: settlePromptPacket,
    discardItem: (item, ctx) => settleDiscardedItems([item], ctx),
    updateStatus: deps.updateStatus,
    recordRuntimeEvent: deps.recordRuntimeEvent,
  });
  return {
    mutation,
    onTurnEnd: steer.onTurnEnd,
    dispatchNext: dispatch.dispatchNext,
    requestNextDispatchAnnouncement: dispatch.requestNextDispatchAnnouncement,
    cancelNextDispatchAnnouncement: dispatch.cancelNextDispatchAnnouncement,
    watchdog: Queue.createBaleQueueDispatchWatchdogRuntime({
      hasQueuedItems: deps.store.hasQueuedItems,
      dispatchNextQueuedBaleTurn: dispatch.dispatchNext,
      recordRuntimeEvent: deps.recordRuntimeEvent,
    }),
  };
}

export interface BaleGenerativeAppLiveSurfaceBinding {
  get: () =>
    | GenerativeApps.GenerativeAppLiveSurfaceRuntime<GenerativeApps.BaleBindLiveHandle>
    | undefined;
  set: (
    runtime:
      | GenerativeApps.GenerativeAppLiveSurfaceRuntime<GenerativeApps.BaleBindLiveHandle>
      | undefined,
  ) => void;
  shutdown: () => void;
}

export function createBaleGenerativeAppLiveSurfaceBinding(): BaleGenerativeAppLiveSurfaceBinding {
  let current:
    | GenerativeApps.GenerativeAppLiveSurfaceRuntime<GenerativeApps.BaleBindLiveHandle>
    | undefined;
  return {
    get() {
      return current;
    },
    set(runtime) {
      current?.shutdown();
      current = runtime;
    },
    shutdown() {
      current?.shutdown();
      current = undefined;
    },
  };
}

export function createBaleGenerativeAppBoundButtonActionInvoker<
  TQuery extends {
    message?: {
      chat?: { id?: number };
      message_id?: number;
      message_thread_id?: number;
    };
  },
>(deps: {
  agentDir: string;
  assertExecutionCurrent: (query: TQuery) => void;
  getExecutionFence: (
    query: TQuery,
  ) => GenerativeApps.GenerativeAppExecutionFence | undefined;
  getActiveProfileName?: () => string | undefined;
  getLiveSurfaceRuntime?: () =>
    | GenerativeApps.GenerativeAppLiveSurfaceRuntime<GenerativeApps.BaleBindLiveHandle>
    | undefined;
  planOutput: ReturnType<
    typeof OutboundHandlers.createBaleOutboundReplyPlanner
  >;
  sendMarkdownReply: (
    chatId: number,
    replyToMessageId: number,
    markdown: string,
    options?: { replyMarkup?: OutboundHandlers.BaleOutboundButtonMarkup },
  ) => Promise<unknown>;
  editInteractiveMessage?: (
    chatId: number,
    messageId: number,
    markdown: string,
    mode: "markdown",
    replyMarkup: OutboundHandlers.BaleOutboundButtonMarkup,
  ) => Promise<void>;
  recordRuntimeEvent: BaleRuntimeEventRecorder;
}): (
  action: OutboundHandlers.BaleOutboundButtonAction,
  query: TQuery,
) => Promise<false | "new" | "edit"> {
  return async (action, query) => {
    let boundAction: GenerativeApps.GenerativeAppBoundAction | undefined;
    let handedOff:
      | GenerativeApps.GenerativeAppLiveSurface<GenerativeApps.BaleBindLiveHandle>
      | undefined;
    try {
      // Only buttons emitted by a Generative App carry a binding. An unbound button is ordinary model text
      // (`std::map`, `a::b(c)`): malformed or uninstalled-app prompts fall through to the normal prompt plane.
      if (!action.binding) {
        try {
          boundAction = GenerativeApps.parseGenerativeAppBoundAction(
            action.prompt,
          );
        } catch {
          return false;
        }
        if (
          boundAction &&
          !(await GenerativeApps.isGenerativeAppInstalled(
            deps.agentDir,
            boundAction.app,
          ))
        ) {
          boundAction = undefined;
        }
      } else {
        boundAction = GenerativeApps.parseGenerativeAppBoundAction(
          action.prompt,
        );
      }
      if (!boundAction) return false;
      deps.assertExecutionCurrent(query);
      const chatId = query.message?.chat?.id;
      const messageId = query.message?.message_id;
      if (typeof chatId !== "number" || typeof messageId !== "number") {
        throw new Error("Generative App callback target is unavailable.");
      }
      const liveSurfaces = deps.getLiveSurfaceRuntime?.();
      handedOff = liveSurfaces?.take(
        GenerativeApps.getBaleBindLiveSurfaceKey(
          boundAction.app,
          deps.getActiveProfileName?.() ?? "default",
          {
            chatId,
            ...(query.message?.message_thread_id !== undefined
              ? { threadId: query.message.message_thread_id }
              : {}),
          },
        ),
      );
      const result = await GenerativeApps.invokeGenerativeApp({
        agentDir: deps.agentDir,
        ...(deps.getExecutionFence(query)
          ? { execution: deps.getExecutionFence(query) }
          : {}),
        ...(boundAction.argument !== undefined
          ? { argument: boundAction.argument }
          : {}),
        ...(action.binding?.app === boundAction.app
          ? {
              expectedGeneration: action.binding.generation,
              expectedRevision: action.binding.revision,
            }
          : {}),
        method: boundAction.method,
        app: boundAction.app,
      });
      deps.assertExecutionCurrent(query);
      const reply = deps.planOutput(result.output, {
        binding: {
          generation: result.generation,
          app: result.app,
          revision: result.revision,
        },
      });
      if (handedOff && liveSurfaces) {
        try {
          await liveSurfaces.resume(handedOff, result);
          deps.assertExecutionCurrent(query);
          return "edit";
        } catch (error) {
          deps.recordRuntimeEvent("generative-app", error, {
            phase: "bound-action-live-edit-fallback",
            app: boundAction.app,
            method: boundAction.method,
          });
        }
      }
      if (result.viewMode === "edit" && deps.editInteractiveMessage) {
        let editFailed = false;
        try {
          await deps.editInteractiveMessage(
            chatId,
            messageId,
            reply.markdown,
            "markdown",
            reply.replyMarkup ?? { inline_keyboard: [] },
          );
        } catch (error) {
          editFailed = true;
          deps.recordRuntimeEvent("generative-app", error, {
            phase: "bound-action-edit-fallback",
            app: boundAction.app,
            method: boundAction.method,
          });
        }
        deps.assertExecutionCurrent(query);
        if (!editFailed) return "edit";
      }
      deps.assertExecutionCurrent(query);
      await deps.sendMarkdownReply(chatId, messageId, reply.markdown, {
        replyMarkup: reply.replyMarkup,
      });
      deps.assertExecutionCurrent(query);
      return "new";
    } catch (error) {
      if (handedOff) deps.getLiveSurfaceRuntime?.()?.open(handedOff);
      deps.recordRuntimeEvent("generative-app", error, {
        phase: "bound-action",
        ...(boundAction
          ? { app: boundAction.app, method: boundAction.method }
          : {}),
      });
      throw error;
    }
  };
}

export interface BaleAgentMessageToolRoutingRuntime {
  resolveAgentTarget: BaleAgentTargetResolver;
  routeAgentMessage: BaleAgentMessageRouter;
  canSendDirect: () => boolean;
}

export function createBaleAgentMessageToolRoutingRuntime(deps: {
  ownsLeader: () => boolean;
  ownsDirectDelivery: () => boolean;
  isFollowerRegistered: () => boolean;
  getSourceTarget: () => BaleTarget | undefined;
  getSourceThreadName: () => string | undefined;
  local: {
    resolveTarget: (
      selector: Parameters<BaleAgentTargetResolver>[0],
      sourceTarget?: BaleTarget,
    ) => Awaited<ReturnType<BaleAgentTargetResolver>> | undefined;
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
}): BaleAgentMessageToolRoutingRuntime {
  return {
    async resolveAgentTarget(selector) {
      if (!deps.ownsLeader()) return deps.follower.resolveTarget(selector);
      const target = deps.local.resolveTarget(selector, deps.getSourceTarget());
      if (!target) {
        throw new Error(
          "Bale agent target is unavailable, ambiguous, or not live.",
        );
      }
      return target;
    },
    async routeAgentMessage(message) {
      if (!deps.ownsLeader()) return deps.follower.routeMessage(message);
      await deps.local.route({
        sourceTarget: deps.getSourceTarget(),
        sourceThreadName: deps.getSourceThreadName(),
        message,
      });
    },
    canSendDirect() {
      return deps.ownsDirectDelivery() || deps.isFollowerRegistered();
    },
  };
}

export interface BaleAssistantOutputBindingRuntime<TTransportStamp> {
  runtime: Activity.BaleAssistantOutputRuntime;
  observeEvent: (event: Activity.BaleActivityEvent) => void;
  authority: Routing.BaleAssistantOutputAuthorityRuntime<TTransportStamp>;
}

export function createBaleAssistantOutputBindingRuntime<
  TTransportStamp,
>(deps: {
  authority: {
    getPreferredTarget: () =>
      | OutboundAttachments.BaleQueuedOutboundAttachmentTurnView["target"]
      | undefined;
    getFallbackChatId: () => number | undefined;
    getTransportStamp: () => TTransportStamp;
    isTransportStampActive: (stamp: TTransportStamp) => boolean;
    ownsDirect: () => boolean;
    getDirectEpoch: () => number | string | undefined;
    isFollowerRegistered: () => boolean;
    getFollowerGeneration: () => string | undefined;
  };
  sender: Parameters<
    typeof OutboundHandlers.createBaleAssistantOutputSender<TTransportStamp>
  >[0];
  waitForActivityIdle?: () => Promise<void>;
  prepareBalePreview?: () =>
    Activity.BaleAssistantOutputPreparation | undefined;
  enqueue?: Activity.BaleActivityPublicationRuntime["enqueue"];
  recordRuntimeEvent: BaleRuntimeEventRecorder;
}): BaleAssistantOutputBindingRuntime<TTransportStamp> {
  const authority = Routing.createBaleAssistantOutputAuthorityRuntime(
    deps.authority,
  );
  const sendOutput =
    OutboundHandlers.createBaleAssistantOutputSender<TTransportStamp>(
      deps.sender,
    );
  const runtime = Activity.createBaleAssistantOutputRuntime({
    ...authority,
    enqueue: deps.enqueue,
    prepareSend: (event) =>
      event.source === "bale" ? deps.prepareBalePreview?.() : undefined,
    async send(event, authority, isAuthorityActive) {
      await deps.waitForActivityIdle?.();
      if (!isAuthorityActive()) return;
      await sendOutput(event, authority, isAuthorityActive);
    },
    recordFailure(event, error) {
      deps.recordRuntimeEvent("proactive-push", error, {
        activityId: event.activityId,
        sequence: event.sequence,
        placement: event.placement,
      });
    },
  });
  return {
    runtime,
    authority,
    observeEvent(event) {
      if (event.type === "assistant-segment") runtime.accept(event);
    },
  };
}

type BaleAssistantOutputAuthority<TTransportStamp> = ReturnType<
  Routing.BaleAssistantOutputAuthorityRuntime<TTransportStamp>["captureAuthority"]
>;

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
export function createBaleActivityBindingRuntime<TTransportStamp>(deps: {
  generation: string;
  captureDrain?: () => (() => void) | undefined;
  assistantOutput: Omit<
    Parameters<
      typeof createBaleAssistantOutputBindingRuntime<TTransportStamp>
    >[0],
    "waitForActivityIdle" | "enqueue"
  >;
  activityVerbosity: Omit<
    Parameters<
      typeof ActivityVerbosity.createBaleActivityVerbosityRuntime<
        BaleAssistantOutputAuthority<TTransportStamp>
      >
    >[0],
    "captureAuthority" | "isAuthorityActive" | "recordFailure" | "enqueue"
  >;
}): BaleActivityBindingRuntime {
  const publication = Activity.createBaleActivityPublicationRuntime({ captureDrain: deps.captureDrain });
  const assistantOutputBinding = createBaleAssistantOutputBindingRuntime({
    ...deps.assistantOutput,
    enqueue: publication.enqueue,
  });
  const activityVerbosityRuntime =
    ActivityVerbosity.createBaleActivityVerbosityRuntime({
      ...deps.activityVerbosity,
      enqueue: publication.enqueue,
      captureAuthority: assistantOutputBinding.authority.captureAuthority,
      isAuthorityActive: assistantOutputBinding.authority.isAuthorityActive,
      recordFailure(operation, event, error) {
        deps.assistantOutput.recordRuntimeEvent("activity", error, {
          operation,
          eventType: event.type,
          activityId: event.activityId,
        });
      },
    });
  const activityRuntime = Activity.createBaleActivityBridgeRuntime({
    generation: deps.generation,
    captureDrain: deps.captureDrain,
    observeEvent(event) {
      assistantOutputBinding.observeEvent(event);
      activityVerbosityRuntime.accept(event);
    },
    recordFailure(handlerId, event, error) {
      deps.assistantOutput.recordRuntimeEvent("activity", error, {
        handlerId,
        eventType: event.type,
        activityId: event.activityId,
      });
    },
  });
  return {
    activityRuntime: {
      ...activityRuntime,
      onSessionStart() {
        publication.reset();
        activityRuntime.onSessionStart?.();
      },
      onSessionShutdown() {
        publication.reset();
        activityRuntime.onSessionShutdown();
      },
    },
    activityVerbosityRuntime,
    assistantOutputRuntime: assistantOutputBinding.runtime,
    publicationRuntime: {
      enqueue: publication.enqueue,
      reserve: publication.reserve,
      hasPending: publication.hasPending,
      beginWork: publication.beginWork,
      hasUnconfirmed: publication.hasUnconfirmed,
      capture() {
        const authority = assistantOutputBinding.authority.captureAuthority();
        return {
          target: authority.target ? { ...authority.target } : undefined,
          isCurrent: () =>
            assistantOutputBinding.authority.isAuthorityActive(authority),
        };
      },
    },
  };
}

/** Fresh current work projection; a snapshot is not a cleanup grant or target-application ACK. */
export function createBaleLiveTargetWorkObserver<TContext>(deps: {
  queue: Pick<Queue.BaleQueueStateStore<TContext>, "getQueuedItems">;
  activeTurn: Pick<Queue.BaleActiveTurnStore, "get">;
  lifecycle: Pick<
    Runtime.BaleBridgeRuntime["lifecycle"],
    "hasDispatchPending" | "isCompactionInProgress" | "getActiveToolExecutions"
  >;
  isIdle(ctx: TContext): boolean;
  hasPendingMessages(ctx: TContext): boolean;
  hasPendingControl(): boolean;
  publication: Pick<
    BaleBridgePublicationRuntime,
    "hasPending" | "hasUnconfirmed"
  >;
  activity: Pick<Activity.BaleActivityRuntime, "hasPending">;
  delivery: Pick<
    ReturnType<typeof Delivery.createBaleDeliveryLifecycleHooks>,
    "hasPendingTarget"
  >;
  api: Pick<BaleApi.BaleApiTargetActivityRuntime, "hasPendingTarget">;
}): (
  target: BaleTarget & { threadId: number },
  ctx: TContext,
) => BaleBusLiveRebindWorkState {
  return (target, ctx) => {
    const work = Queue.observeBaleTargetQueueWork(
      target,
      deps.activeTurn.get(),
      deps.queue.getQueuedItems(),
    );
    const flags = [
      deps.isIdle(ctx),
      deps.hasPendingMessages(ctx),
      deps.lifecycle.hasDispatchPending(),
      deps.lifecycle.isCompactionInProgress(),
      deps.hasPendingControl(),
    ];
    const tools = deps.lifecycle.getActiveToolExecutions();
    const publication = deps.publication.hasPending(),
      unconfirmed = deps.publication.hasUnconfirmed?.(),
      activity = deps.activity.hasPending?.(),
      delivery = deps.delivery.hasPendingTarget(target),
      api = deps.api.hasPendingTarget(target);
    const unknown =
      work.unknown ||
      flags.some((flag) => typeof flag !== "boolean") ||
      !Number.isSafeInteger(tools) ||
      tools < 0 ||
      unconfirmed !== false ||
      [publication, activity, delivery, api].some(
        (flag) => typeof flag !== "boolean",
      );
    return {
      sessionBusy:
        flags[0] !== true || flags.slice(1).some(Boolean) || tools > 0,
      targetWork: work.protected,
      deliveryPending:
        publication === true ||
        activity === true ||
        delivery === true ||
        api === true,
      unknown,
    };
  };
}

interface BaleCommandsAndToolsBindingDeps {
  pi: Pi.ExtensionAPI;
  handleInternalAction:
    Commands.BaleSessionActionRuntime["handleInternalAction"];
  agentDir: string;
  configStore: Config.BaleConfigStore;
  persistConfig: (config?: Config.BaleConfig) => Promise<void>;
  setup: Setup.BaleSetupGuard;
  activeTurnRuntime: Queue.BaleActiveTurnStore<Queue.PendingBaleTurn>;
  lockedPollingRuntime: Locks.BaleLockedPollingRuntime<Pi.ExtensionContext>;
  stopPolling?: () => Promise<void | string>;
  getDisconnectThreadName?: () => string | undefined;
  onTransportChanged?: () => Promise<void> | void;
  getStatusLines: (
    options?: Status.BaleBridgeStatusLineOptions,
  ) => string[];
  buttonActionStore: OutboundHandlers.BaleButtonActionStore;
  sendMarkdownReply: (
    chatId: number,
    replyToMessageId: number | undefined,
    markdown: string,
    options?: {
      replyMarkup?: unknown;
      target?: { chatId: number; threadId?: number };
    },
  ) => Promise<number | undefined>;
  sendChannelMarkdownMessage: NonNullable<
    OutboundAttachments.BaleOutboundMessageToolRegistrationDeps["sendChannelMarkdownMessage"]
  >;
  sendChannelMediaMessage: NonNullable<
    OutboundAttachments.BaleOutboundMessageToolRegistrationDeps["sendChannelMediaMessage"]
  >;
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
  setGenerativeAppLiveSurfaceRuntime?: (
    runtime:
      | GenerativeApps.GenerativeAppLiveSurfaceRuntime<GenerativeApps.BaleBindLiveHandle>
      | undefined,
  ) => void;
  updateStatus: BaleBridgeStatusUpdater;
  isContextCurrent: (ctx: Pi.ExtensionContext) => boolean;
  getSessionGeneration: () => number;
  connectionIntent: NonNullable<
    Commands.BaleBridgeCommandRegistrationDeps["connectionIntent"]
  >;
  recordRuntimeEvent: BaleRuntimeEventRecorder;
}

export function registerBaleCommandsAndTools({
  pi,
  handleInternalAction,
  agentDir,
  configStore,
  persistConfig,
  setup,
  activeTurnRuntime,
  lockedPollingRuntime,
  stopPolling,
  getDisconnectThreadName,
  onTransportChanged,
  getStatusLines,
  buttonActionStore,
  sendMarkdownReply,
  sendChannelMarkdownMessage,
  sendChannelMediaMessage,
  listChannelPosts,
  mutateChannelPost,
  callMultipart,
  getDefaultChatId,
  getDefaultTarget,
  resolveAgentTarget,
  routeAgentMessage,
  canSendDirect,
  setGenerativeAppLiveSurfaceRuntime,
  recordRuntimeEvent,
  updateStatus,
  isContextCurrent,
  getSessionGeneration,
  connectionIntent,
}: BaleCommandsAndToolsBindingDeps): void {
  GenerativeApps.registerBaleBindTool(pi, {
    agentDir,
    getActiveProfileName: configStore.getActiveProfileName,
    getActiveTurn: activeTurnRuntime.get,
    ...(setGenerativeAppLiveSurfaceRuntime
      ? { setLiveSurfaceRuntime: setGenerativeAppLiveSurfaceRuntime }
      : {}),
    isDeliveryHandleCurrent: Delivery.isBaleDeliveryHandleCurrent,
    editView: (handle, view) =>
      Delivery.editBaleView(
        handle as Delivery.BaleDeliveryHandle,
        view as Delivery.BaleDeliveryView,
      ),
    planOutput: OutboundHandlers.createBaleOutboundReplyPlanner(
      buttonActionStore,
      Config.createBaleConfigControls(configStore)
        .getAssistantRenderingMode,
    ),
    sendMarkdownReply,
    sendView: (view, options) =>
      Delivery.sendBaleView(view as Delivery.BaleDeliveryView, options),
    recordRuntimeEvent,
  });
  ChannelPosts.registerBaleChannelPostMutationTool(pi, {
    mutate: mutateChannelPost,
  });
  ChannelPosts.registerBaleChannelPostListTool(pi, {
    list: listChannelPosts,
  });
  OutboundAttachments.registerBaleOutboundAttachmentTool(pi, {
    getActiveTurn: activeTurnRuntime.get,
    getDefaultChatId,
    getDefaultTarget,
    canSendDirect,
    sendMultipart: callMultipart,
    recordRuntimeEvent,
  });
  OutboundAttachments.registerBaleOutboundMessageTool(pi, {
    getDefaultChatId,
    getDefaultTarget,
    getActiveTurn: activeTurnRuntime.get,
    resolveAgentTarget,
    routeAgentMessage,
    canSendDirect,
    planMessage: OutboundHandlers.createBaleOutboundReplyPlanner(
      buttonActionStore,
      Config.createBaleConfigControls(configStore)
        .getAssistantRenderingMode,
    ),
    sendMarkdownMessage: (chatId, markdown, options) =>
      sendMarkdownReply(chatId, undefined, markdown, options),
    sendChannelMarkdownMessage,
    sendChannelMediaMessage,
    recordRuntimeEvent,
  });
  const queueAgentConnectionContext = (connected: boolean): void => {
    pi.sendMessage(
      {
        customType: "bale-connection-state",
        content: connected
          ? Prompts.BALE_CONNECTED_CONTEXT_MESSAGE
          : Prompts.BALE_DISCONNECTED_CONTEXT_MESSAGE,
        display: false,
      },
      { deliverAs: "nextTurn" },
    );
  };
  Commands.registerBaleBridgeCommands(pi, {
    handleInternalAction,
    promptForConfig: async (ctx, profileName) => {
      const nextProfileName = profileName ?? undefined;
      if (profileName && !Config.isValidBaleProfileName(profileName)) {
        ctx.ui.notify(`Invalid Bale profile name: ${profileName}`, "error");
        return;
      }
      const previousProfileName = configStore.getActiveProfileName();
      let setupConfigStore = configStore;
      let persistSetupConfig = persistConfig;
      if (!profileName) {
        if (previousProfileName !== nextProfileName) {
          await (stopPolling ?? lockedPollingRuntime.stop)();
        }
        configStore.activateProfile(undefined);
        await onTransportChanged?.();
      } else {
        const storedConfig = configStore.getStoredConfig();
        setupConfigStore = Config.createBaleConfigStore({
          initialConfig: {
            ...storedConfig,
            profiles: {
              ...(storedConfig.profiles ?? {}),
              [profileName]: storedConfig.profiles?.[profileName] ?? {
                botToken: "",
              },
            },
          },
        });
        setupConfigStore.activateProfile(profileName);
        persistSetupConfig = async () => {
          try {
            if (previousProfileName !== profileName) {
              await (stopPolling ?? lockedPollingRuntime.stop)();
            }
            const profile = Config.getBaleProfileFields(
              setupConfigStore.get(),
            );
            if (!profile) {
              throw new Error(
                `Bale profile "${profileName}" has no token.`,
              );
            }
            await configStore.load();
            configStore.setProfile(profileName, profile);
            configStore.activateProfile(profileName);
            await onTransportChanged?.();
            await persistConfig(configStore.get());
          } catch (error) {
            await configStore.load().catch(() => undefined);
            configStore.activateProfile(previousProfileName);
            await onTransportChanged?.();
            throw error;
          }
        };
      }
      const runSetup = Setup.createBaleSetupPromptRuntime({
        getConfig: setupConfigStore.get,
        setConfig: setupConfigStore.set,
        setupGuard: setup,
        getMe: BaleApi.fetchBaleBotIdentity,
        resolveBotToken: (value) =>
          Config.resolveBaleBotToken(value, process.env),
        describeBotToken: (value) =>
          Config.getBaleBotTokenDiagnostic(value, process.env),
        persistConfig: persistSetupConfig,
        startPolling: lockedPollingRuntime.start,
        updateStatus,
        recordRuntimeEvent,
      });
      const completion = await runSetup(ctx);
      if (completion.status === "success") {
        queueAgentConnectionContext(true);
        if (profileName) {
          ctx.ui.notify(
            `Profile "${profileName}" saved and connected.`,
            "info",
          );
        }
      }
    },
    getStatusLines,
    reloadConfig: configStore.load,
    hasBotToken: configStore.hasBotToken,
    getBotTokenDiagnostic: configStore.getBotTokenDiagnostic,
    startPolling: lockedPollingRuntime.start,
    recordConnectionEvent: (error, phase) =>
      recordRuntimeEvent("connection", error, { phase }),
    stopPolling: stopPolling ?? lockedPollingRuntime.stop,
    getDisconnectThreadName,
    queueAgentConnectionContext,
    updateStatus,
    isContextCurrent,
    getSessionGeneration,
    connectionIntent,
    getProfileNames: () =>
      Config.getBaleProfileNames(configStore.getStoredConfig()),
    activateDefaultProfileConfig: async (_ctx, isCurrent) => {
      const previousProfileName = configStore.getActiveProfileName();
      await configStore.load();
      if (!isCurrent()) return;
      if (previousProfileName) {
        await (stopPolling ?? lockedPollingRuntime.stop)();
        if (!isCurrent()) return;
      }
      configStore.activateProfile(undefined);
      await onTransportChanged?.();
    },
    activateProfileConfig: async (_ctx, profileName, isCurrent) => {
      const previousProfileName = configStore.getActiveProfileName();
      await configStore.load();
      if (!isCurrent()) return false;
      if (!Config.isValidBaleProfileName(profileName)) return false;
      const storedConfig = configStore.getStoredConfig();
      if (!storedConfig.profiles?.[profileName]) return false;
      if (previousProfileName !== profileName) {
        await (stopPolling ?? lockedPollingRuntime.stop)();
        if (!isCurrent()) return false;
      }
      if (!configStore.activateProfile(profileName)) return false;
      await onTransportChanged?.();
      return true;
    },
  });
}

interface BaleLifecycleBindingDeps {
  pi: Pi.ExtensionAPI;
  publicationRuntime: BaleBridgePublicationRuntime;
  activityRuntime: Activity.BaleActivityRuntime;
  activityVerbosityRuntime?: ActivityVerbosity.BaleActivityVerbosityRuntime;
  diagnostics?: { onSessionStart(): void; onSessionShutdown(): Promise<void> };
  assistantOutputRuntime: Pick<
    Activity.BaleAssistantOutputRuntime,
    | "start"
    | "beginTurn"
    | "hasAdmittedBaleIntermediate"
    | "waitForIdle"
    | "stop"
  >;
  sessionLifecycleRuntime: Pick<
    Lifecycle.BaleLifecycleRegistrationDeps,
    "onSessionStart" | "onSessionShutdown" | "onModelSelect"
  >;
  configStore: Pick<
    Config.BaleConfigStore,
    "get" | "getOutboundHandlers" | "hasBotToken" | "load"
  >;
  abort: Runtime.BaleRuntimeAbortPort;
  typing: Runtime.BaleRuntimeTypingPort;
  lifecycle: Runtime.BaleRuntimeLifecyclePort;
  activeTurnRuntime: Queue.BaleActiveTurnStore<Queue.PendingBaleTurn>;
  baleQueueStore: Queue.BaleQueueStore<Pi.ExtensionContext>;
  modelSwitchController: Model.BaleModelSwitchController<
    Pi.ExtensionContext,
    Model.ScopedBaleModel<ActivePiModel>
  >;
  previewRuntime: Preview.BaleAssistantPreviewRuntime<
    Pi.AgentEndEvent["messages"][number],
    Keyboard.BaleInlineKeyboardMarkup
  >;
  promptDispatchRuntime: Runtime.BalePromptDispatchRuntime<Pi.ExtensionContext>;
  deferredQueueDispatchRuntime: Queue.BaleDeferredQueueDispatchRuntime<Pi.ExtensionContext>;
  modelContextAvailabilityRuntime: Prompts.BaleModelContextAvailabilityRuntime;
  disconnectOnQuit?: () => Promise<unknown>;
  onSessionStarted?: (
    event: Pi.SessionStartEvent,
    ctx: Pi.ExtensionContext,
  ) => void;
  shutdownGenerativeAppLiveSurfaces?: () => void;
  resolveAutomaticThreadCleanupEnabled?: () => boolean | Promise<boolean>;
  buttonActionStore: OutboundHandlers.BaleButtonActionStore;
  callMultipart: (...args: Parameters<BaleApi.BaleBridgeApiRuntime["callMultipart"]>) => Promise<unknown>;
  sendChatAction: NonNullable<
    OutboundHandlers.BaleVoiceReplySenderDeps["sendChatAction"]
  >;
  sendRecordVoiceAction: NonNullable<
    OutboundHandlers.BaleVoiceReplySenderDeps["sendRecordVoiceAction"]
  >;
  sendMarkdownReply: Queue.BaleAgentEndHookRuntimeDeps<
    Queue.PendingBaleTurn,
    Pi.ExtensionContext,
    Pi.AgentEndEvent["messages"][number],
    Keyboard.BaleInlineKeyboardMarkup
  >["sendMarkdownReply"];
  sendTextReply: Queue.BaleAgentEndHookRuntimeDeps<
    Queue.PendingBaleTurn,
    Pi.ExtensionContext,
    Pi.AgentEndEvent["messages"][number],
    Keyboard.BaleInlineKeyboardMarkup
  >["sendTextReply"] &
    NonNullable<OutboundHandlers.BaleVoiceReplySenderDeps["sendTextReply"]>;
  dispatchNextQueuedBaleTurn: (ctx: Pi.ExtensionContext) => void;
  onSteerTurnEnd?: BaleQueueBindingRuntime<Pi.ExtensionContext>["onTurnEnd"];
  onPromptHandedOff?: (
    turn: Queue.PendingBaleTurn,
    ctx: Pi.ExtensionContext,
  ) => void;
  answerGuestQuery: BaleApi.BaleBridgeApiRuntime["answerGuestQuery"];
  editGuestInlineMessage?: BaleApi.BaleBridgeApiRuntime["editGuestInlineMessage"];
  deleteMessage: BaleApi.BaleBridgeApiRuntime["deleteMessage"];
  sendGuestReply: NonNullable<
    Queue.BaleAgentEndHookRuntimeDeps<
      Queue.PendingBaleTurn,
      Pi.ExtensionContext,
      Pi.AgentEndEvent["messages"][number],
      Keyboard.BaleInlineKeyboardMarkup
    >["sendGuestReply"]
  >;
  editGuestReply?: Queue.BaleAgentEndHookRuntimeDeps<
    Queue.PendingBaleTurn,
    Pi.ExtensionContext,
    Pi.AgentEndEvent["messages"][number],
    Keyboard.BaleInlineKeyboardMarkup
  >["editGuestReply"];
  stopGuestPlaceholder?: Queue.BaleAgentEndHookRuntimeDeps<
    Queue.PendingBaleTurn,
    Pi.ExtensionContext,
    Pi.AgentEndEvent["messages"][number],
    Keyboard.BaleInlineKeyboardMarkup
  >["stopGuestPlaceholder"];
  preparePreviewDelivery?: Queue.BaleAgentEndRuntimeDeps<Queue.PendingBaleTurn>["preparePreviewDelivery"];
  finalizeMarkdownPreview: Queue.BaleAgentEndHookRuntimeDeps<
    Queue.PendingBaleTurn,
    Pi.ExtensionContext,
    Pi.AgentEndEvent["messages"][number],
    Keyboard.BaleInlineKeyboardMarkup
  >["finalizeMarkdownPreview"];
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

export function registerBaleLifecycleRuntimeHooks({
  pi,
  publicationRuntime,
  activityRuntime,
  activityVerbosityRuntime,
  diagnostics,
  assistantOutputRuntime,
  sessionLifecycleRuntime,
  configStore,
  abort,
  typing,
  lifecycle,
  activeTurnRuntime,
  baleQueueStore,
  modelSwitchController,
  previewRuntime,
  promptDispatchRuntime,
  deferredQueueDispatchRuntime,
  modelContextAvailabilityRuntime,
  disconnectOnQuit,
  onSessionStarted,
  shutdownGenerativeAppLiveSurfaces,
  resolveAutomaticThreadCleanupEnabled,
  buttonActionStore,
  callMultipart,
  sendChatAction,
  sendRecordVoiceAction,
  sendMarkdownReply,
  sendTextReply,
  dispatchNextQueuedBaleTurn,
  onSteerTurnEnd,
  onPromptHandedOff,
  answerGuestQuery,
  editGuestInlineMessage,
  deleteMessage,
  sendGuestReply,
  editGuestReply,
  stopGuestPlaceholder,
  preparePreviewDelivery,
  finalizeMarkdownPreview,
  proactivePushTargetGetter,
  getAssistantRenderingMode,
  recordMessageOwnership,
  canSendAgentActivity,
  isSessionContextActive = () => true,
  getSessionGeneration,
  isTurnTransportActive,
  updateStatus,
  recordRuntimeEvent,
  onSessionSettled,
}: BaleLifecycleBindingDeps): void {
  const agentEndResetter = Runtime.createBaleAgentEndResetter({
    abort,
    typing,
    clearActiveTurn: activeTurnRuntime.clear,
    resetToolExecutions: lifecycle.resetActiveToolExecutions,
    clearPendingModelSwitch: modelSwitchController.clearPendingSwitch,
    clearDispatchPending: lifecycle.clearDispatchPending,
  });
  const queuedAttachmentSender =
    OutboundAttachments.createBaleQueuedOutboundAttachmentSender({
      sendMultipart: callMultipart,
      sendTextReply,
      recordRuntimeEvent,
    });
  const richAttachmentSender =
    OutboundAttachments.createBaleRichOutboundAttachmentSender({
      sendMultipart: callMultipart,
      getRenderingMode: getAssistantRenderingMode,
      recordOwnership: recordMessageOwnership,
      recordRuntimeEvent,
    });
  const sendGuestAttachment = async (
    turn: Queue.PendingBaleTurn,
    attachment: Queue.QueuedAttachment,
    caption?: string,
    options?: { isDeliveryActive?: () => boolean },
  ): Promise<void> => {
    const stagingTarget = proactivePushTargetGetter();
    const stagingChatId = stagingTarget?.chatId;
    if (stagingChatId === undefined) {
      throw new Error(
        "Guest attachment staging requires a paired Bale chat",
      );
    }
    await OutboundAttachments.deliverBaleGuestCachedAttachment({
      guestQueryId: turn.guestQueryId!,
      guestInlineMessageId: turn.guestInlineMessageId,
      editGuestInlineMessage,
      isDeliveryActive: options?.isDeliveryActive,
      stagingChatId,
      stagingTarget,
      attachment,
      caption,
      sendMultipart: (method, fields, fileField, path, name) =>
        callMultipart(method, fields, fileField, path, name, {
          assertAuthority() {
            if (options?.isDeliveryActive?.() === false) throw new Error("Guest attachment upload lost authority.");
          },
        }),
      answerGuestQuery: (guestQueryId, result) =>
        answerGuestQuery(guestQueryId, undefined, { result }),
      answerGuestText: (guestQueryId, text) =>
        answerGuestQuery(guestQueryId, text),
      fallbackText:
        caption ||
        "Bale bridge could not deliver the requested attachment.",
      deleteMessage,
      recordRuntimeEvent,
    });
  };
  const outboundReplyPlanner =
    OutboundHandlers.createBaleOutboundReplyPlanner(
      buttonActionStore,
      getAssistantRenderingMode,
    );
  const voiceReplySenderDeps = {
    execCommand: CommandTemplates.execCommandTemplate,
    sendMultipart: callMultipart,
    sendTextReply,
    sendChatAction,
    sendRecordVoiceAction,
    getHandlers: configStore.getOutboundHandlers,
    recordRuntimeEvent,
  };
  const outboundReplyArtifactSender =
    OutboundHandlers.createBaleOutboundReplyArtifactSender(
      voiceReplySenderDeps,
    );
  const sendGuestVoiceReply = async (
    turn: Queue.PendingBaleTurn,
    plan: OutboundHandlers.BaleOutboundReplyPlan,
    caption?: string,
  ): Promise<void> => {
    const stagingTarget = proactivePushTargetGetter();
    const stagingChatId = stagingTarget?.chatId;
    if (stagingChatId === undefined) {
      throw new Error("Guest voice staging requires a paired Bale chat");
    }
    const guestVoiceSender =
      OutboundHandlers.createBaleOutboundReplyArtifactSender({
        ...voiceReplySenderDeps,
        sendChatAction: undefined,
        sendRecordVoiceAction: undefined,
        sendMultipart: async (
          _method,
          _fields,
          _fileField,
          filePath,
          fileName,
        ) => {
          try {
            await OutboundAttachments.deliverBaleGuestCachedAttachment({
              guestQueryId: turn.guestQueryId!,
              stagingChatId,
              stagingTarget,
              attachment: { path: filePath, fileName },
              caption,
              sendMultipart: callMultipart,
              answerGuestQuery: (guestQueryId, result) =>
                answerGuestQuery(guestQueryId, undefined, { result }),
              answerGuestText: (guestQueryId, text) =>
                answerGuestQuery(guestQueryId, text),
              fallbackText:
                caption || "Bale bridge could not deliver the voice reply.",
              deleteMessage,
              recordRuntimeEvent,
            });
          } catch (error) {
            recordRuntimeEvent("delivery", error, {
              phase: "guest-voice-answer",
              guestQueryId: turn.guestQueryId,
            });
          }
          return {};
        },
      });
    await guestVoiceSender(
      turn,
      {
        ...plan,
        ...(plan.voiceReplies?.length
          ? { voiceReplies: [plan.voiceReplies[0]!] }
          : {}),
      },
      { replyToPrompt: false },
    );
  };
  let pendingFinalPublication:
    | {
        turn: Queue.PendingBaleTurn;
        reservation: Activity.BaleActivityPublicationReservation;
      }
    | undefined;
  const cancelPendingFinalPublication = (): void => {
    pendingFinalPublication?.reservation.cancel();
    pendingFinalPublication = undefined;
  };
  const recordPublicationFailure = (error: unknown): void => {
    recordRuntimeEvent("delivery", error, {
      phase: "agent-end-background-delivery",
    });
  };
  const scheduleActiveTurnDelivery = (task: () => Promise<void>): void => {
    void publicationRuntime.enqueue(task).catch(recordPublicationFailure);
  };
  const agentLifecycleHooks = Queue.createBaleAgentLifecycleHooks<
    Queue.PendingBaleTurn,
    Pi.ExtensionContext,
    unknown,
    Keyboard.BaleInlineKeyboardMarkup
  >({
    setAbortHandler: Runtime.createBaleContextAbortHandlerSetter(abort),
    getQueuedItems: baleQueueStore.getQueuedItems,
    hasPendingDispatch: lifecycle.hasDispatchPending,
    hasActiveTurn: activeTurnRuntime.has,
    resetToolExecutions: lifecycle.resetActiveToolExecutions,
    resetPendingModelSwitch: modelSwitchController.clearPendingSwitch,
    setQueuedItems: baleQueueStore.setQueuedItems,
    clearDispatchPending: lifecycle.clearDispatchPending,
    setFoldQueuedPromptsIntoHistory: lifecycle.setFoldQueuedPromptsIntoHistory,
    setActiveTurn: activeTurnRuntime.set,
    onPromptHandedOff: (turn, ctx) => {
      assistantOutputRuntime.beginTurn();
      onPromptHandedOff?.(turn, ctx);
    },
    createPreviewState: previewRuntime.resetState,
    startTypingLoop: (ctx) => {
      const turn = activeTurnRuntime.get();
      promptDispatchRuntime.startTypingLoop(ctx, turn?.chatId, {
        target: turn?.target,
      });
    },
    updateStatus,
    getActiveTurn: activeTurnRuntime.get,
    loadConfig: configStore.load,
    extractAssistant: Replies.extractRunAssistantMessage,
    isAssistantAlreadyPublished: (assistant) =>
      !!assistant.text &&
      assistantOutputRuntime.hasAdmittedBaleIntermediate(assistant.text),
    getFoldQueuedPromptsIntoHistory:
      lifecycle.shouldFoldQueuedPromptsIntoHistory,
    resetRuntimeState: agentEndResetter,
    isSessionActive: isSessionContextActive,
    isTurnTransportActive,
    waitForTypingIdle: typing.waitForIdle,
    dispatchNextQueuedBaleTurn,
    requestDeferredDispatchNextQueuedBaleTurn:
      deferredQueueDispatchRuntime.request,
    scheduleActiveTurnDelivery,
    reserveActiveTurnDelivery() {
      const pending = pendingFinalPublication;
      pendingFinalPublication = undefined;
      const matches = pending?.turn === activeTurnRuntime.get();
      if (!matches) pending?.reservation.cancel();
      const reservation =
        matches && pending ? pending.reservation : publicationRuntime.reserve();
      return {
        schedule: (task) => {
          void reservation.publish(task).catch(recordPublicationFailure);
        },
        cancel: reservation.cancel,
      };
    },
    preparePreviewDelivery,
    preparePreviewClear: previewRuntime.prepareClear,
    clearPreview: previewRuntime.clear,
    setPreviewPendingText: previewRuntime.setPendingText,
    finalizeMarkdownPreview,
    sendMarkdownReply,
    sendTextReply,
    sendQueuedAttachments: queuedAttachmentSender,
    sendRichAttachmentReply: richAttachmentSender,
    answerGuestQuery,
    sendGuestReply,
    editGuestReply,
    stopGuestPlaceholder,
    sendGuestAttachment,
    sendGuestVoiceReply,
    planOutboundReply: outboundReplyPlanner,
    sendOutboundReplyArtifacts: outboundReplyArtifactSender,
    recordRuntimeEvent,
    getActiveToolExecutions: lifecycle.getActiveToolExecutions,
    setActiveToolExecutions: lifecycle.setActiveToolExecutions,
    triggerPendingModelSwitchAbort: modelSwitchController.triggerPendingAbort,
  });
  const agentStartWithDedupReset = Lifecycle.createAgentStartDedupHook(
    agentLifecycleHooks.onAgentStart,
    Replies.resetTransportReplyDedup,
    scheduleActiveTurnDelivery,
  );
  let uiPromptActive = false;
  const startAgentActivityTypingLoop = (ctx: Pi.ExtensionContext): boolean => {
    if (uiPromptActive || !canSendAgentActivity(ctx)) return false;
    const turn = activeTurnRuntime.get();
    const target = turn?.target ?? proactivePushTargetGetter();
    return (
      promptDispatchRuntime.startTypingLoop(
        ctx,
        turn?.chatId ?? target?.chatId,
        { target, ensure: true },
      ) !== false
    );
  };
  const startActiveTurnTypingLoop = (ctx: Pi.ExtensionContext): void => {
    if (uiPromptActive) return;
    const turn = activeTurnRuntime.get();
    promptDispatchRuntime.startTypingLoop(ctx, turn?.chatId, {
      target: turn?.target,
      ensure: true,
    });
  };
  let observedAutomaticCompaction = false;
  let agentWorkActive = false;
  const prepareCompactionNotice = (
    text: string,
    ctx: Pi.ExtensionContext,
  ): (() => Promise<void>) => {
    const authority = publicationRuntime.capture();
    const turn = activeTurnRuntime.get();
    const selectedTarget = turn?.target ?? authority.target;
    const target = selectedTarget ? { ...selectedTarget } : undefined;
    const replyToMessageId = turn?.replyToMessageId;
    return async () => {
      if (!target || !isSessionContextActive(ctx) || !authority.isCurrent())
        return;
      if (turn && isTurnTransportActive?.(turn) === false) return;
      try {
        await sendMarkdownReply(target.chatId, replyToMessageId, text, {
          target,
        });
      } catch (error) {
        recordRuntimeEvent("delivery", error, { phase: "compaction-notice" });
      }
    };
  };
  const sendCompactionNotice = (
    text: string,
    ctx: Pi.ExtensionContext,
  ): void => {
    scheduleActiveTurnDelivery(prepareCompactionNotice(text, ctx));
  };
  const compactionObserver = Lifecycle.createBaleCompactionObserverRuntime({
    isContextActive: isSessionContextActive,
    setCompactionInProgress: lifecycle.setCompactionInProgress,
    updateStatus,
    startTypingLoop: startAgentActivityTypingLoop,
    stopTypingLoop: typing.stop,
    requestDeferredDispatchNextQueuedBaleTurn:
      deferredQueueDispatchRuntime.request,
    dispatchNextQueuedBaleTurn,
    recordRuntimeEvent,
    onCompactionAbandoned: () => {
      observedAutomaticCompaction = false;
      activityRuntime.onCompactionAbandoned();
    },
  });
  const messageActivityTypingHooks =
    Lifecycle.createBaleMessageActivityTypingHooks({
      hasActiveTurn: activeTurnRuntime.has,
      isContextActive: isSessionContextActive,
      getSessionGeneration,
      startTypingLoop: startActiveTurnTypingLoop,
      onMessageStart: previewRuntime.onMessageStart,
      onMessageUpdate: previewRuntime.onMessageUpdate,
      recordRuntimeEvent,
    });
  const messageActivityHooks = messageActivityTypingHooks;
  Lifecycle.registerBaleLifecycleHooks(pi, {
    isSessionActive: isSessionContextActive,
    ...sessionLifecycleRuntime,
    ...agentLifecycleHooks,
    ...(onSteerTurnEnd ? {
      onTurnEnd(event: Pi.TurnEndEvent, ctx: Pi.ExtensionContext) {
        const result = onSteerTurnEnd(event, ctx);
        return result ? { ...result, entries: [...event.entries, ...(result.entries ?? [])] } : undefined;
      },
    } : {}),
    onInput(event) {
      activityRuntime.recordInputSource(event.source ?? "unknown");
    },
    async onSessionStart(event, ctx) {
      diagnostics?.onSessionStart();
      cancelPendingFinalPublication();
      previewRuntime.invalidate();
      assistantOutputRuntime.start();
      activityRuntime.onSessionStart?.();
      activityVerbosityRuntime?.reset();
      modelContextAvailabilityRuntime.reconcile();
      await sessionLifecycleRuntime.onSessionStart(event, ctx);
      onSessionStarted?.(event, ctx);
    },
    async onSessionShutdown(event, ctx) {
      if (!isSessionContextActive(ctx)) return;
      const diagnosticsStopped = diagnostics?.onSessionShutdown();
      shutdownGenerativeAppLiveSurfaces?.();
      agentLifecycleHooks.clearRetainedAgentEnd();
      activityRuntime.onSessionShutdown();
      activityVerbosityRuntime?.reset();
      assistantOutputRuntime.stop();
      observedAutomaticCompaction = false;
      agentWorkActive = false;
      cancelPendingFinalPublication();
      uiPromptActive = false;
      compactionObserver.onSessionShutdown();
      await diagnosticsStopped;
      if (!isSessionContextActive(ctx)) return;
      if (event.reason === "quit" && disconnectOnQuit) {
        try {
          const automaticCleanupEnabled =
            (await resolveAutomaticThreadCleanupEnabled?.()) ?? true;
          if (automaticCleanupEnabled) await disconnectOnQuit();
        } catch (error) {
          recordRuntimeEvent("session", error, {
            phase: "automatic-disconnect-on-quit",
          });
        }
      }
      await sessionLifecycleRuntime.onSessionShutdown(event, ctx);
    },
    async onSessionBeforeCompact(event, ctx) {
      if (!isSessionContextActive(ctx)) return;
      const shouldNotify = !(lifecycle.isCompactionInProgress?.() ?? false);
      if (shouldNotify) observedAutomaticCompaction = true;
      activityRuntime.onCompactionStart(Pi.getSessionCompactionReason(event));
      compactionObserver.onSessionBeforeCompact(event, ctx);
      if (shouldNotify)
        sendCompactionNotice(
          Commands.BALE_COMPACTION_STARTED_MARKDOWN,
          ctx,
        );
    },
    async onSessionCompact(event, ctx) {
      if (!isSessionContextActive(ctx)) return;
      activityRuntime.onCompactionEnd(Pi.getSessionCompactionReason(event));
      compactionObserver.onSessionCompact(event, ctx);
      if (observedAutomaticCompaction) {
        observedAutomaticCompaction = false;
        sendCompactionNotice(
          Commands.BALE_COMPACTION_COMPLETED_MARKDOWN,
          ctx,
        );
      }
    },
    async onSessionCompactFailed(event, ctx) {
      if (!isSessionContextActive(ctx)) return;
      const shouldNotify = observedAutomaticCompaction;
      compactionObserver.onSessionCompactFailed(event, ctx);
      if (!shouldNotify) return;
      const notice = event.aborted
        ? "**⚠️ Compaction cancelled.**"
        : "**⚠️ Compaction failed.**";
      sendCompactionNotice(notice, ctx);
    },
    async onAgentStart(event, ctx) {
      if (!isSessionContextActive(ctx)) return;
      const generation = getSessionGeneration?.();
      agentWorkActive = true;
      cancelPendingFinalPublication();
      await agentStartWithDedupReset(event, ctx);
      if (!isSessionContextActive(ctx) || (getSessionGeneration && !Object.is(getSessionGeneration(), generation))) return;
      const turn = activeTurnRuntime.get();
      activityRuntime.onAgentStart(turn?.target, turn?.replyToMessageId);
      startAgentActivityTypingLoop(ctx);
    },
    async onToolExecutionStart(event, ctx) {
      if (!isSessionContextActive(ctx)) return;
      agentLifecycleHooks.onToolExecutionStart();
      activityRuntime.onToolStart({
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        args: event.args,
      });
    },
    onToolExecutionUpdate(event, ctx) {
      if (!isSessionContextActive(ctx)) return;
      activityRuntime.onToolUpdate({
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        update: event.partialResult,
      });
    },
    async onToolExecutionEnd(event, ctx) {
      if (!isSessionContextActive(ctx)) return;
      activityRuntime.onToolEnd({
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        result: event.result,
        isError: event.isError,
      });
      agentLifecycleHooks.onToolExecutionEnd(event, ctx);
    },
    async onMessageStart(event, ctx) {
      if (!isSessionContextActive(ctx)) return;
      await messageActivityHooks.onMessageStart(event, ctx);
    },
    async onMessageUpdate(event, ctx) {
      if (!isSessionContextActive(ctx)) return;
      if (event.assistantMessageEvent) {
        activityRuntime.onAssistantEvent(
          event.assistantMessageEvent as Activity.BaleAssistantStreamEvent,
        );
      }
      await messageActivityHooks.onMessageUpdate(event, ctx);
    },
    onMessageEnd(event, ctx) {
      if (!isSessionContextActive(ctx)) return;
      if (event.message.role === "assistant") {
        previewRuntime.seal();
        activityRuntime.onAssistantMessageEnd(event.message.stopReason);
      }
      if (
        event.message.role !== "assistant" ||
        event.message.stopReason === "toolUse" ||
        event.message.stopReason === "aborted"
      )
        return;
      const turn = activeTurnRuntime.get();
      if (!turn || turn.guestQueryId || pendingFinalPublication?.turn === turn)
        return;
      cancelPendingFinalPublication();
      const assistant = Replies.extractLatestAssistantMessageText([
        event.message,
      ]);
      if (
        !assistant.text &&
        assistant.stopReason !== "error" &&
        turn.queuedAttachments.length === 0
      )
        return;
      pendingFinalPublication = {
        turn,
        reservation: publicationRuntime.reserve(),
      };
    },
    onUiPromptStart(event, ctx) {
      if (!isSessionContextActive(ctx)) return;
      uiPromptActive = true;
      typing.stop();
      activityRuntime.onUiPromptStart(event.kind, event.title);
      updateStatus(ctx);
    },
    onUiPromptEnd(_event, ctx) {
      if (!isSessionContextActive(ctx)) return;
      uiPromptActive = false;
      activityRuntime.onUiPromptEnd();
      if (agentWorkActive || lifecycle.isCompactionInProgress()) {
        startAgentActivityTypingLoop(ctx);
      }
      updateStatus(ctx);
    },
    async onAgentEnd(event, ctx) {
      if (!isSessionContextActive(ctx)) return;
      if (
        pendingFinalPublication &&
        pendingFinalPublication.turn !== activeTurnRuntime.get()
      ) {
        cancelPendingFinalPublication();
        return;
      }
      activityRuntime.onAgentEnd();
      await agentLifecycleHooks.onAgentEnd(event, ctx);
    },
    async onAgentSettled(event, ctx) {
      if (!isSessionContextActive(ctx)) return;
      const pending = pendingFinalPublication;
      try {
        await agentLifecycleHooks.onAgentSettled(event, ctx);
      } finally {
        if (pendingFinalPublication === pending)
          cancelPendingFinalPublication();
      }
      if (!isSessionContextActive(ctx)) return;
      agentWorkActive = false;
      activityRuntime.onAgentSettled();
      modelContextAvailabilityRuntime.reconcile();
      onSessionSettled?.(ctx);
    },
    onBeforeAgentStart: Prompts.createBaleProactiveBeforeAgentStartHook({
      reconcileAvailability: modelContextAvailabilityRuntime.reconcile,
      isAvailable: canSendAgentActivity,
    }),
  });
}

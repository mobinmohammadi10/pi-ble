/**
 * Bale menu and inline-keyboard rendering helpers
 * Zones: bale ui, controls, status menu
 * Owns app-menu/status state, inline UI text, and callback composition while model/thinking/queue menu details live in dedicated domains
 */

import {
  createBaleMenuDelivery,
  handleBaleModelMenuCallbackAction,
  openBaleModelMenu,
  sendBaleModelMenuMessage,
  updateBaleModelMenuMessage,
  type BaleMenuMessageRuntimeDeps,
  type BaleModelMenuState,
  type BaleReplyMarkup,
} from "./menu-model.ts";
import {
  handleBaleStatusMenuCallbackAction,
  openBaleStatusMenu,
  sendBaleStatusMessage,
  updateBaleStatusMessage,
} from "./menu-status.ts";
import {
  handleBaleThinkingMenuCallbackAction,
  openBaleThinkingMenu,
  updateBaleThinkingMenuMessage,
} from "./menu-thinking.ts";
import {
  type MenuModel,
  type ScopedBaleModel,
  type BaleModelSwitchContinuationSource,
  type ThinkingLevel,
} from "./model.ts";
import {
  handleBaleSectionCallback,
  handleBaleSectionOpen,
  handleBaleSectionSettingsOpen,
  parseBaleSectionCallback,
  type BaleSectionRuntimeDeps,
  type BaleSectionRegistry,
} from "./sections.ts";
import type {
  BaleApiCallOptions,
  BaleInputRichMessage,
} from "./bale-api.ts";

export {
  applyBaleModelPageSelection,
  applyBaleModelScopeSelection,
  buildModelMenuReplyMarkup,
  buildModelPageMenuReplyMarkup,
  buildBaleModelCallbackPlan,
  buildBaleModelMenuRenderPayload,
  buildBaleModelMenuState,
  buildBaleModelMenuStateRuntime,
  buildBaleModelPageMenuRenderPayload,
  createBaleModelMenuRuntime,
  createBaleModelMenuStateBuilder,
  formatScopedModelButtonText,
  getModelMenuItems,
  getStoredBaleModelMenuState,
  getBaleModelMenuPage,
  getBaleModelSelection,
  handleBaleModelMenuCallbackAction,
  MODEL_MENU_TITLE,
  MODEL_PAGE_MENU_TITLE,
  openBaleModelMenu,
  pruneStoredBaleModelMenus,
  resolveCachedBaleModelMenuInputs,
  sendBaleModelMenuMessage,
  storeBaleModelMenuState,
  BALE_MODEL_PAGE_SIZE,
  updateBaleModelMenuMessage,
} from "./menu-model.ts";
export type {
  BuildBaleModelCallbackPlanParams,
  BuildBaleModelMenuStateParams,
  CachedBaleModelMenuInputs,
  MenuSettingsManager,
  StoredBaleModelMenuState,
  BaleMenuMessageRuntimeDeps,
  BaleMenuMutationResult,
  BaleMenuRenderPayload,
  BaleMenuSelectionResult,
  BaleModelCallbackPlan,
  BaleModelMenuCallbackDeps,
  BaleModelMenuInputCacheDeps,
  BaleModelMenuOpenDeps,
  BaleModelMenuPage,
  BaleModelMenuRuntime,
  BaleModelMenuRuntimeContext,
  BaleModelMenuRuntimeOptions,
  BaleModelMenuState,
  BaleModelMenuStateBuilderContext,
  BaleModelMenuStateBuilderDeps,
  BaleModelMenuStoreOptions,
  BaleModelScope,
  BaleReplyMarkup,
} from "./menu-model.ts";
export {
  buildStatusReplyMarkup,
  buildBaleStatusMenuRenderPayload,
  handleBaleStatusMenuCallbackAction,
  openBaleStatusMenu,
  sendBaleStatusMessage,
  updateBaleStatusMessage,
} from "./menu-status.ts";
export type {
  BaleStatusMenuCallbackDeps,
  BaleStatusMenuOpenDeps,
} from "./menu-status.ts";
export {
  buildBaleThinkingMenuRenderPayload,
  buildThinkingMenuReplyMarkup,
  buildThinkingMenuText,
  handleBaleThinkingMenuCallbackAction,
  openBaleThinkingMenu,
  updateBaleThinkingMenuMessage,
} from "./menu-thinking.ts";
export type {
  BaleThinkingMenuCallbackDeps,
  BaleThinkingMenuOpenDeps,
} from "./menu-thinking.ts";

export interface BaleMenuCallbackEntryDeps {
  handleStatusAction: () => Promise<boolean>;
  handleThinkingAction: () => Promise<boolean>;
  handleModelAction: () => Promise<boolean>;
  answerCallbackQuery: (
    callbackQueryId: string,
    text?: string,
  ) => Promise<void>;
}

export interface MenuCallbackQuery {
  id: string;
  data?: string;
  message?: {
    message_id?: number;
    message_thread_id?: number;
    chat?: { id?: number };
  };
}

export interface StoredBaleMenuCallbackDeps<
  TModel extends MenuModel = MenuModel,
> {
  getStoredModelMenuState: (
    messageId: number | undefined,
    chatId?: number,
  ) => BaleModelMenuState<TModel> | undefined;
  handleStatusAction: (
    state: BaleModelMenuState<TModel>,
  ) => Promise<boolean>;
  handleThinkingAction: (
    state: BaleModelMenuState<TModel>,
  ) => Promise<boolean>;
  handleModelAction: (
    state: BaleModelMenuState<TModel>,
  ) => Promise<boolean>;
  answerCallbackQuery: (
    callbackQueryId: string,
    text?: string,
  ) => Promise<void>;
}

export interface BaleMenuCallbackRuntimeDeps<
  TContext,
  TModel extends MenuModel = MenuModel,
> {
  getStoredModelMenuState: (
    messageId: number | undefined,
    chatId?: number,
  ) => BaleModelMenuState<TModel> | undefined;
  getActiveModel: (ctx: TContext) => TModel | undefined;
  getThinkingLevel: () => ThinkingLevel;
  setThinkingLevel: (level: ThinkingLevel) => void;
  updateStatus: (ctx: TContext) => void;
  updateModelMenuMessage: (
    state: BaleModelMenuState<TModel>,
    ctx: TContext,
  ) => Promise<void>;
  updateThinkingMenuMessage: (
    state: BaleModelMenuState<TModel>,
    ctx: TContext,
  ) => Promise<void>;
  updateStatusMessage: (
    state: BaleModelMenuState<TModel>,
    ctx: TContext,
  ) => Promise<void>;
  updateSettingsMenuMessage?: (
    state: BaleModelMenuState<TModel>,
    ctx: TContext,
  ) => Promise<void>;
  answerCallbackQuery: (
    callbackQueryId: string,
    text?: string,
  ) => Promise<void>;
  isIdle: (ctx: TContext) => boolean;
  hasAbortHandler: () => boolean;
  hasActiveToolExecutions: () => boolean;
  persistScopedModelPatterns?: (
    patterns: string[],
    ctx: TContext,
  ) => Promise<void>;
  setModel: (model: TModel) => Promise<boolean>;
  setCurrentModel: (model: TModel, ctx: TContext) => void;
  stagePendingModelSwitch: (
    selection: ScopedBaleModel<TModel>,
    ctx: TContext,
    continuationTurn: BaleModelSwitchContinuationSource,
  ) => void;
  restartInterruptedBaleTurn: (
    selection: ScopedBaleModel<TModel>,
    ctx: TContext,
    continuationTurn: BaleModelSwitchContinuationSource,
  ) => Promise<boolean> | boolean;
  sectionRegistry?: BaleSectionRegistry;
  editInteractiveMessage?: (
    chatId: number,
    messageId: number,
    text: string,
    mode: "markdown" | "html" | "plain",
    replyMarkup: BaleReplyMarkup,
  ) => Promise<void>;
  sendInteractiveMessage?: (
    chatId: number,
    text: string,
    mode: "markdown" | "html" | "plain",
    replyMarkup: BaleReplyMarkup,
    options?: { target?: { chatId: number; threadId?: number } },
  ) => Promise<number | undefined>;
  sendSectionRichMessage?: (
    chatId: number,
    message: BaleInputRichMessage,
    options?: { target?: { chatId: number; threadId?: number } },
  ) => Promise<number | undefined>;
  enqueueSectionPrompt?: (
    prompt: string,
    ctx: TContext,
    target?: { chatId: number; threadId?: number },
    source?: unknown,
  ) => Promise<void>;
  deleteMessage?: (chatId: number, messageId: number) => Promise<void>;
  isVoiceReplyActive?: () => boolean;
}

export interface BaleMenuActionRuntimeDeps<
  TContext,
  TModel extends MenuModel = MenuModel,
> extends BaleMenuMessageRuntimeDeps {
  getModelMenuState: (
    chatId: number,
    ctx: TContext,
    threadId?: number,
  ) => Promise<BaleModelMenuState<TModel>>;
  getActiveModel: (ctx: TContext) => TModel | undefined;
  getThinkingLevel: () => ThinkingLevel;
  getQueueItemCount?: () => number;
  getPendingCancellationCount?: () => number;
  buildStatusHtml: (ctx: TContext) => string;
  storeModelMenuState: (state: BaleModelMenuState<TModel>) => void;
  isIdle: (ctx: TContext) => boolean;
  canOfferInFlightModelSwitch: (ctx: TContext) => boolean;
  sendTextReply: (
    chatId: number,
    replyToMessageId: number | undefined,
    text: string,
    options?: {
      target?: { chatId: number; threadId?: number };
      parseMode?: "HTML";
      assertAuthority?: BaleApiCallOptions["assertAuthority"];
    },
  ) => Promise<unknown>;
  sectionRegistry?: BaleSectionRegistry;
  isVoiceReplyActive?: () => boolean;
}

export interface BaleMenuActionRuntime<
  TContext,
  TModel extends MenuModel = MenuModel,
> {
  updateModelMenuMessage: (
    state: BaleModelMenuState<TModel>,
    ctx: TContext,
  ) => Promise<void>;
  updateThinkingMenuMessage: (
    state: BaleModelMenuState<TModel>,
    ctx: TContext,
  ) => Promise<void>;
  updateStatusMessage: (
    state: BaleModelMenuState<TModel>,
    ctx: TContext,
  ) => Promise<void>;
  sendStatusMessage: (
    chatId: number,
    replyToMessageId: number | undefined,
    ctx: TContext,
    threadId?: number,
    options?: Pick<BaleApiCallOptions, "assertAuthority">,
  ) => Promise<void>;
  openModelMenu: (
    chatId: number,
    replyToMessageId: number | undefined,
    ctx: TContext,
    threadId?: number,
    options?: Pick<BaleApiCallOptions, "assertAuthority">,
  ) => Promise<void>;
  openThinkingMenu: (
    chatId: number,
    replyToMessageId: number | undefined,
    ctx: TContext,
    threadId?: number,
    options?: Pick<BaleApiCallOptions, "assertAuthority">,
  ) => Promise<void>;
}

export async function handleBaleMenuCallbackEntry(
  callbackQueryId: string,
  data: string | undefined,
  state: BaleModelMenuState | undefined,
  deps: BaleMenuCallbackEntryDeps,
): Promise<void> {
  if (!data) {
    await deps.answerCallbackQuery(callbackQueryId);
    return;
  }
  if (!state) {
    await deps.answerCallbackQuery(
      callbackQueryId,
      "Interactive message expired",
    );
    return;
  }
  const handled =
    (await deps.handleStatusAction()) ||
    (await deps.handleThinkingAction()) ||
    (await deps.handleModelAction());
  if (!handled) {
    await deps.answerCallbackQuery(callbackQueryId);
  }
}

export async function handleStoredBaleMenuCallback<
  TModel extends MenuModel = MenuModel,
>(
  query: MenuCallbackQuery,
  deps: StoredBaleMenuCallbackDeps<TModel>,
): Promise<void> {
  const state = deps.getStoredModelMenuState(
    query.message?.message_id,
    query.message?.chat?.id,
  );
  await handleBaleMenuCallbackEntry(query.id, query.data, state, {
    handleStatusAction: async () => {
      if (!state) return false;
      return deps.handleStatusAction(state);
    },
    handleThinkingAction: async () => {
      if (!state) return false;
      return deps.handleThinkingAction(state);
    },
    handleModelAction: async () => {
      if (!state) return false;
      return deps.handleModelAction(state);
    },
    answerCallbackQuery: deps.answerCallbackQuery,
  });
}

export type BaleMenuCallbackRuntimeAdapterDeps<
  TContext,
  TModel extends MenuModel = MenuModel,
> = Omit<
  BaleMenuCallbackRuntimeDeps<TContext, TModel>,
  "hasActiveToolExecutions"
> & {
  getActiveToolExecutions: () => number;
};

export function createBaleMenuCallbackHandler<
  TQuery extends MenuCallbackQuery,
  TContext,
  TModel extends MenuModel = MenuModel,
>(
  deps: BaleMenuCallbackRuntimeDeps<TContext, TModel>,
): (query: TQuery, ctx: TContext) => Promise<void> {
  return (query, ctx) => handleBaleMenuCallbackRuntime(query, ctx, deps);
}

export function createBaleMenuCallbackHandlerForContext<
  TQuery extends MenuCallbackQuery,
  TContext,
  TModel extends MenuModel = MenuModel,
>(
  deps: BaleMenuCallbackRuntimeAdapterDeps<TContext, TModel>,
): (query: TQuery, ctx: TContext) => Promise<void> {
  const { getActiveToolExecutions, ...ports } = deps;
  return createBaleMenuCallbackHandler<TQuery, TContext, TModel>({
    ...ports,
    hasActiveToolExecutions: () => getActiveToolExecutions() > 0,
  });
}

export async function handleBaleMenuCallbackRuntime<
  TQuery extends MenuCallbackQuery,
  TContext,
  TModel extends MenuModel = MenuModel,
>(
  query: TQuery,
  ctx: TContext,
  deps: BaleMenuCallbackRuntimeDeps<TContext, TModel>,
): Promise<void> {
  if (query.data === "menu:back") {
    const state = deps.getStoredModelMenuState(
      query.message?.message_id,
      query.message?.chat?.id,
    );
    if (!state) {
      await deps.answerCallbackQuery(query.id, "Interactive message expired");
      return;
    }
    await deps.updateStatusMessage(state, ctx);
    await deps.answerCallbackQuery(query.id);
    return;
  }
  // Section callbacks: dispatch before built-in menu handling
  if (deps.sectionRegistry && query.data?.startsWith("section:")) {
    const parsed = parseBaleSectionCallback(query.data);
    if (parsed) {
      const message = query.message;
      const chatId = message?.chat?.id;
      const messageId = message?.message_id;
      const target =
        typeof chatId === "number"
          ? typeof message?.message_thread_id === "number"
            ? { chatId, threadId: message.message_thread_id }
            : { chatId }
          : undefined;
      if (typeof chatId === "number" && typeof messageId === "number") {
        const { token, action, payload } = parsed;
        const sectionDeps: BaleSectionRuntimeDeps = {
          answerCallbackQuery: deps.answerCallbackQuery,
          target,
          editInteractiveMessage:
            deps.editInteractiveMessage ?? (async () => {}),
          sendInteractiveMessage:
            deps.sendInteractiveMessage ?? (async () => undefined),
          sendRichMessage:
            deps.sendSectionRichMessage ??
            (async () => {
              throw new Error("Rich Message delivery is unavailable");
            }),
          enqueuePrompt: deps.enqueueSectionPrompt
            ? (prompt: string) =>
                deps.enqueueSectionPrompt!(prompt, ctx, target, query)
            : async () => {},
          deleteMessage: deps.deleteMessage ?? (async () => {}),
        };
        if (action === "open") {
          const state = deps.getStoredModelMenuState(messageId, chatId);
          if (!state) {
            await deps.answerCallbackQuery(
              query.id,
              "Interactive message expired",
            );
            return;
          }
          const handled = await handleBaleSectionOpen(
            deps.sectionRegistry,
            token,
            chatId,
            messageId,
            query.id,
            sectionDeps,
          );
          if (handled) return;
        } else if (action === "settings") {
          const handled = await handleBaleSectionSettingsOpen(
            deps.sectionRegistry,
            token,
            chatId,
            messageId,
            query.id,
            sectionDeps,
          );
          if (handled) return;
        } else {
          const handled = await handleBaleSectionCallback(
            deps.sectionRegistry,
            token,
            action,
            payload,
            chatId,
            messageId,
            query.id,
            sectionDeps,
          );
          if (handled) return;
        }
      }
    }
  }
  await handleStoredBaleMenuCallback(query, {
    getStoredModelMenuState: deps.getStoredModelMenuState,
    handleStatusAction: async (state) =>
      handleBaleStatusMenuCallbackAction(
        query.id,
        query.data,
        deps.getActiveModel(ctx),
        {
          updateModelMenuMessage: () => deps.updateModelMenuMessage(state, ctx),
          updateThinkingMenuMessage: () =>
            deps.updateThinkingMenuMessage(state, ctx),
          updateSettingsMenuMessage: () =>
            deps.updateSettingsMenuMessage?.(state, ctx) ?? Promise.resolve(),
          answerCallbackQuery: deps.answerCallbackQuery,
          isVoiceReplyActive: deps.isVoiceReplyActive,
        },
      ),
    handleThinkingAction: async (state) =>
      handleBaleThinkingMenuCallbackAction(
        query.id,
        query.data,
        deps.getActiveModel(ctx),
        {
          setThinkingLevel: (level) => {
            deps.setThinkingLevel(level);
            deps.updateStatus(ctx);
          },
          getCurrentThinkingLevel: deps.getThinkingLevel,
          updateThinkingMenuMessage: () =>
            deps.updateThinkingMenuMessage(state, ctx),
          answerCallbackQuery: deps.answerCallbackQuery,
          isVoiceReplyActive: deps.isVoiceReplyActive,
        },
      ),
    handleModelAction: async (state) => {
      try {
        return await handleBaleModelMenuCallbackAction(
          query.id,
          {
            data: query.data,
            state,
            activeModel: deps.getActiveModel(ctx),
            currentThinkingLevel: deps.getThinkingLevel(),
            isIdle: deps.isIdle(ctx),
            canRestartBusyRun: deps.hasAbortHandler(),
            hasActiveToolExecutions: deps.hasActiveToolExecutions(),
          },
          {
            updateModelMenuMessage: () =>
              deps.updateModelMenuMessage(state, ctx),
            updateStatusMessage: () => deps.updateStatusMessage(state, ctx),
            answerCallbackQuery: deps.answerCallbackQuery,
            persistScopedModelPatterns: deps.persistScopedModelPatterns
              ? (patterns) => deps.persistScopedModelPatterns!(patterns, ctx)
              : undefined,
            setModel: deps.setModel,
            setCurrentModel: (model) => deps.setCurrentModel(model, ctx),
            setThinkingLevel: (level) => {
              deps.setThinkingLevel(level);
              deps.updateStatus(ctx);
            },
            stagePendingModelSwitch: (selection, continuationTurn) => {
              deps.stagePendingModelSwitch(selection, ctx, continuationTurn);
            },
            restartInterruptedBaleTurn: (selection, continuationTurn) =>
              deps.restartInterruptedBaleTurn(
                selection,
                ctx,
                continuationTurn,
              ),
          },
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await deps.answerCallbackQuery(query.id, message);
        return true;
      }
    },
    answerCallbackQuery: deps.answerCallbackQuery,
  });
}

export function createBaleMenuActionRuntime<
  TContext,
  TModel extends MenuModel = MenuModel,
>(
  deps: BaleMenuActionRuntimeDeps<TContext, TModel>,
): BaleMenuActionRuntime<TContext, TModel> {
  return {
    updateModelMenuMessage: (state, ctx) =>
      updateBaleModelMenuMessage(state, deps.getActiveModel(ctx), deps),
    updateThinkingMenuMessage: (state, ctx) =>
      updateBaleThinkingMenuMessage(
        state,
        deps.getActiveModel(ctx),
        deps.getThinkingLevel(),
        deps,
      ),
    updateStatusMessage: (state, ctx) =>
      updateBaleStatusMessage(
        state,
        deps.buildStatusHtml(ctx),
        deps.getActiveModel(ctx),
        deps.getThinkingLevel(),
        deps,
        deps.getQueueItemCount?.() ?? 0,
        deps.sectionRegistry,
        deps.isVoiceReplyActive?.(),
        deps.getPendingCancellationCount?.() ?? 0,
      ),
    sendStatusMessage: (chatId, replyToMessageId, ctx, threadId, options) => {
      const delivery = createBaleMenuDelivery(
        { chatId, threadId },
        options,
        deps,
      );
      return openBaleStatusMenu({
        isIdle: () => deps.isIdle(ctx),
        sendBusyMessage: async () => {
          await deps.sendTextReply(
            chatId,
            replyToMessageId,
            "<b>⏳ Cannot open status while Pi is busy. Send /abort, /next, or /stop.</b>",
            {
              target: { chatId, threadId },
              parseMode: "HTML",
              ...(delivery.assertAuthority
                ? { assertAuthority: delivery.assertAuthority }
                : {}),
            },
          );
        },
        getModelMenuState: () => deps.getModelMenuState(chatId, ctx, threadId),
        buildStatusHtml: () => deps.buildStatusHtml(ctx),
        getActiveModel: () => deps.getActiveModel(ctx),
        getThinkingLevel: deps.getThinkingLevel,
        getQueueItemCount: deps.getQueueItemCount,
        sendStatusMenu: (
          state,
          statusHtml,
          activeModel,
          thinkingLevel,
          queueItemCount,
        ) =>
          sendBaleStatusMessage(
            state,
            statusHtml,
            activeModel,
            thinkingLevel,
            {
              ...deps,
              sendInteractiveMessage: delivery.sendInteractiveMessage,
            },
            queueItemCount,
            deps.sectionRegistry,
            deps.isVoiceReplyActive?.(),
            deps.getPendingCancellationCount?.() ?? 0,
          ),
        storeModelMenuState: delivery.storeModelMenuState,
      });
    },
    openModelMenu: (chatId, replyToMessageId, ctx, threadId, options) => {
      const delivery = createBaleMenuDelivery(
        { chatId, threadId },
        options,
        deps,
      );
      const assertAuthority = delivery.assertAuthority;
      return openBaleModelMenu({
        isIdle: () => deps.isIdle(ctx),
        canOfferInFlightModelSwitch: () =>
          deps.canOfferInFlightModelSwitch(ctx),
        sendBusyMessage: async () => {
          await deps.sendTextReply(
            chatId,
            replyToMessageId,
            "<b>⏳ Cannot switch model while Pi is busy. Send /abort, /next, or /stop.</b>",
            {
              target: { chatId, threadId },
              parseMode: "HTML",
              ...(assertAuthority ? { assertAuthority } : {}),
            },
          );
        },
        sendNoModelsMessage: async () => {
          await deps.sendTextReply(
            chatId,
            replyToMessageId,
            "<b>🚫 No available models with configured auth.</b>",
            {
              target: { chatId, threadId },
              parseMode: "HTML",
              ...(assertAuthority ? { assertAuthority } : {}),
            },
          );
        },
        getModelMenuState: () => deps.getModelMenuState(chatId, ctx, threadId),
        getActiveModel: () => deps.getActiveModel(ctx),
        sendModelMenu: (state, activeModel) =>
          sendBaleModelMenuMessage(state, activeModel, {
            ...deps,
            sendInteractiveMessage: delivery.sendInteractiveMessage,
          }),
        storeModelMenuState: delivery.storeModelMenuState,
      });
    },
    openThinkingMenu: (chatId, _replyToMessageId, ctx, threadId, options) => {
      const delivery = createBaleMenuDelivery(
        { chatId, threadId },
        options,
        deps,
      );
      return openBaleThinkingMenu({
        getModelMenuState: () => deps.getModelMenuState(chatId, ctx, threadId),
        getActiveModel: () => deps.getActiveModel(ctx),
        getThinkingLevel: deps.getThinkingLevel,
        storeModelMenuState: delivery.storeModelMenuState,
        editInteractiveMessage: deps.editInteractiveMessage,
        sendInteractiveMessage: delivery.sendInteractiveMessage,
        isVoiceReplyActive: deps.isVoiceReplyActive,
      });
    },
  };
}

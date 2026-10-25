/**
 * Bale status menu UI helpers
 * Zones: bale ui, status controls, menu composition
 * Owns status-menu payloads, status callback handling, and status-menu message rendering
 */

import { formatBaleCommandEmojiPrefix } from "./commands.ts";
import { refuseUnavailableBaleThinkingControls } from "./menu-thinking.ts";
import {
  editBaleMenuMessage,
  formatStatusButtonLabel,
  sendBaleMenuMessage,
  type BaleMenuMessageRuntimeDeps,
  type BaleMenuRenderPayload,
  type BaleModelMenuState,
  type BaleReplyMarkup,
} from "./menu-model.ts";
import {
  getCanonicalModelId,
  type MenuModel,
  type ThinkingLevel,
} from "./model.ts";
import {
  getBaleSectionMainMenuRows,
  type BaleSectionRegistry,
} from "./sections.ts";

export interface BaleStatusMenuCallbackDeps {
  updateModelMenuMessage: () => Promise<void>;
  updateThinkingMenuMessage: () => Promise<void>;
  updateSettingsMenuMessage?: () => Promise<void>;
  answerCallbackQuery: (
    callbackQueryId: string,
    text?: string,
  ) => Promise<void>;
  isVoiceReplyActive?: () => boolean;
}

export interface BaleStatusMenuOpenDeps<
  TModel extends MenuModel = MenuModel,
> {
  isIdle: () => boolean;
  sendBusyMessage: () => Promise<void>;
  getModelMenuState: () => Promise<BaleModelMenuState<TModel>>;
  buildStatusHtml: () => string;
  getActiveModel: () => TModel | undefined;
  getThinkingLevel: () => ThinkingLevel;
  getQueueItemCount?: () => number;
  sendStatusMenu: (
    state: BaleModelMenuState<TModel>,
    statusHtml: string,
    activeModel: TModel | undefined,
    thinkingLevel: ThinkingLevel,
    queueItemCount: number,
  ) => Promise<number | undefined>;
  storeModelMenuState: (state: BaleModelMenuState<TModel>) => void;
}

function isBaleStatusMenuCallbackAction(
  data: string | undefined,
  action: "model" | "thinking" | "settings",
): boolean {
  return data === `menu:${action}` || data === `status:${action}`;
}

export async function openBaleStatusMenu<
  TModel extends MenuModel = MenuModel,
>(deps: BaleStatusMenuOpenDeps<TModel>): Promise<void> {
  const state = await deps.getModelMenuState();
  const messageId = await deps.sendStatusMenu(
    state,
    deps.buildStatusHtml(),
    deps.getActiveModel(),
    deps.getThinkingLevel(),
    deps.getQueueItemCount?.() ?? 0,
  );
  if (messageId === undefined) return;
  state.messageId = messageId;
  state.mode = "status";
  deps.storeModelMenuState(state);
}

export async function handleBaleStatusMenuCallbackAction(
  callbackQueryId: string,
  data: string | undefined,
  activeModel: MenuModel | undefined,
  deps: BaleStatusMenuCallbackDeps,
): Promise<boolean> {
  if (isBaleStatusMenuCallbackAction(data, "model")) {
    await deps.updateModelMenuMessage();
    await deps.answerCallbackQuery(callbackQueryId);
    return true;
  }
  if (isBaleStatusMenuCallbackAction(data, "settings")) {
    if (!deps.updateSettingsMenuMessage) return false;
    await deps.updateSettingsMenuMessage();
    await deps.answerCallbackQuery(callbackQueryId);
    return true;
  }
  if (!isBaleStatusMenuCallbackAction(data, "thinking")) return false;
  if (
    await refuseUnavailableBaleThinkingControls(
      callbackQueryId,
      activeModel,
      deps,
    )
  )
    return true;
  await deps.updateThinkingMenuMessage();
  await deps.answerCallbackQuery(callbackQueryId);
  return true;
}

export function buildStatusReplyMarkup(
  activeModel: MenuModel | undefined,
  currentThinkingLevel: ThinkingLevel,
  queueItemCount = 0,
  sectionRegistry?: BaleSectionRegistry,
  isVoiceReplyActive?: boolean,
  pendingCancellationCount = 0,
): BaleReplyMarkup {
  const rows: Array<Array<{ text: string; callback_data: string }>> = [];
  rows.push([
    {
      text: formatStatusButtonLabel(
        `${formatBaleCommandEmojiPrefix("model")}Model`,
        activeModel ? getCanonicalModelId(activeModel) : "unknown",
      ),
      callback_data: "menu:model",
    },
  ]);
  if (activeModel?.reasoning && !isVoiceReplyActive) {
    rows.push([
      {
        text: formatStatusButtonLabel(
          `${formatBaleCommandEmojiPrefix("thinking")}Thinking`,
          currentThinkingLevel,
        ),
        callback_data: "menu:thinking",
      },
    ]);
  }
  rows.push([
    {
      text: `${queueItemCount === 0 ? "⌛" : "⏳"} Queue: ${queueItemCount}`,
      callback_data: "menu:queue",
    },
  ]);
  if (pendingCancellationCount > 0)
    rows.push([
      {
        text: `❌ Pending cancellations: ${pendingCancellationCount}`,
        callback_data: "reroutecancel:review:open",
      },
    ]);
  if (sectionRegistry) {
    const sectionRows = getBaleSectionMainMenuRows(sectionRegistry);
    for (const row of sectionRows) {
      rows.push([row]);
    }
  }
  rows.push([
    {
      text: "⚙️ Settings",
      callback_data: "menu:settings",
    },
  ]);
  return { inline_keyboard: rows };
}

export function buildBaleStatusMenuRenderPayload(
  statusText: string,
  activeModel: MenuModel | undefined,
  currentThinkingLevel: ThinkingLevel,
  queueItemCount = 0,
  sectionRegistry?: BaleSectionRegistry,
  isVoiceReplyActive?: boolean,
  pendingCancellationCount = 0,
): BaleMenuRenderPayload {
  return {
    nextMode: "status",
    text: statusText,
    mode: "html",
    replyMarkup: buildStatusReplyMarkup(
      activeModel,
      currentThinkingLevel,
      queueItemCount,
      sectionRegistry,
      isVoiceReplyActive,
      pendingCancellationCount,
    ),
  };
}

export async function updateBaleStatusMessage(
  state: BaleModelMenuState,
  statusText: string,
  activeModel: MenuModel | undefined,
  currentThinkingLevel: ThinkingLevel,
  deps: BaleMenuMessageRuntimeDeps,
  queueItemCount = 0,
  sectionRegistry?: BaleSectionRegistry,
  isVoiceReplyActive?: boolean,
  pendingCancellationCount = 0,
): Promise<void> {
  await editBaleMenuMessage(
    state,
    buildBaleStatusMenuRenderPayload(
      statusText,
      activeModel,
      currentThinkingLevel,
      queueItemCount,
      sectionRegistry,
      isVoiceReplyActive,
      pendingCancellationCount,
    ),
    deps,
  );
}

export function sendBaleStatusMessage(
  state: BaleModelMenuState,
  statusText: string,
  activeModel: MenuModel | undefined,
  currentThinkingLevel: ThinkingLevel,
  deps: BaleMenuMessageRuntimeDeps,
  queueItemCount = 0,
  sectionRegistry?: BaleSectionRegistry,
  isVoiceReplyActive?: boolean,
  pendingCancellationCount = 0,
): Promise<number | undefined> {
  return sendBaleMenuMessage(
    state,
    buildBaleStatusMenuRenderPayload(
      statusText,
      activeModel,
      currentThinkingLevel,
      queueItemCount,
      sectionRegistry,
      isVoiceReplyActive,
      pendingCancellationCount,
    ),
    deps,
  );
}

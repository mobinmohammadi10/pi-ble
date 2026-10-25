/**
 * Bale thinking menu UI helpers
 * Zones: bale ui, thinking controls, menu composition
 * Owns thinking-menu text, reply markup, callback handling, and thinking-menu message rendering
 */

import {
  editBaleMenuMessage,
  sendBaleMenuMessage,
  type BaleMenuMessageRuntimeDeps,
  type BaleMenuRenderPayload,
  type BaleModelMenuState,
  type BaleReplyMarkup,
} from "./menu-model.ts";
import {
  isThinkingLevel,
  type MenuModel,
  THINKING_LEVELS,
  type ThinkingLevel,
} from "./model.ts";

export interface BaleThinkingMenuCallbackDeps {
  setThinkingLevel: (level: ThinkingLevel) => void;
  getCurrentThinkingLevel: () => ThinkingLevel;
  updateThinkingMenuMessage: () => Promise<void>;
  answerCallbackQuery: (
    callbackQueryId: string,
    text?: string,
  ) => Promise<void>;
  isVoiceReplyActive?: () => boolean;
}

export interface BaleThinkingMenuOpenDeps<
  TModel extends MenuModel = MenuModel,
> extends BaleMenuMessageRuntimeDeps {
  getModelMenuState: () => Promise<BaleModelMenuState<TModel>>;
  getActiveModel: () => TModel | undefined;
  getThinkingLevel: () => ThinkingLevel;
  storeModelMenuState: (state: BaleModelMenuState<TModel>) => void;
  isVoiceReplyActive?: () => boolean;
}

function parseBaleThinkingMenuCallbackAction(
  data: string | undefined,
): { kind: "thinking:set"; level: string } | undefined {
  if (!data?.startsWith("thinking:set:")) return undefined;
  return { kind: "thinking:set", level: data.slice("thinking:set:".length) };
}

/** Answers and returns true when voice replies or a non-reasoning model disable thinking controls. */
export async function refuseUnavailableBaleThinkingControls(
  callbackQueryId: string,
  activeModel: MenuModel | undefined,
  deps: {
    answerCallbackQuery: (
      callbackQueryId: string,
      text?: string,
    ) => Promise<void>;
    isVoiceReplyActive?: () => boolean;
  },
): Promise<boolean> {
  if (deps.isVoiceReplyActive?.()) {
    await deps.answerCallbackQuery(
      callbackQueryId,
      "Thinking controls are disabled during voice replies",
    );
    return true;
  }
  if (!activeModel?.reasoning) {
    await deps.answerCallbackQuery(
      callbackQueryId,
      "This model has no reasoning controls",
    );
    return true;
  }
  return false;
}

export async function handleBaleThinkingMenuCallbackAction(
  callbackQueryId: string,
  data: string | undefined,
  activeModel: MenuModel | undefined,
  deps: BaleThinkingMenuCallbackDeps,
): Promise<boolean> {
  const action = parseBaleThinkingMenuCallbackAction(data);
  if (!action) return false;
  if (!isThinkingLevel(action.level)) {
    await deps.answerCallbackQuery(callbackQueryId, "Invalid thinking level");
    return true;
  }
  if (
    await refuseUnavailableBaleThinkingControls(
      callbackQueryId,
      activeModel,
      deps,
    )
  )
    return true;
  deps.setThinkingLevel(action.level);
  await deps.updateThinkingMenuMessage();
  await deps.answerCallbackQuery(
    callbackQueryId,
    `Thinking: ${deps.getCurrentThinkingLevel()}`,
  );
  return true;
}

export function buildThinkingMenuText(): string {
  return "<b>🧠 Choose a thinking level:</b>";
}

export function buildThinkingMenuReplyMarkup(
  currentThinkingLevel: ThinkingLevel,
): BaleReplyMarkup {
  const rows = [[{ text: "⬆️ Main menu", callback_data: "menu:back" }]];
  const levelButtons = THINKING_LEVELS.map((level) => ({
    text: level === currentThinkingLevel ? `🟢 ${level}` : level,
    callback_data: `thinking:set:${level}`,
  }));
  rows.push(
    levelButtons.slice(0, 1),
    levelButtons.slice(1, 4),
    levelButtons.slice(4, 7),
  );
  return { inline_keyboard: rows };
}

export function buildBaleThinkingMenuRenderPayload(
  _activeModel: MenuModel | undefined,
  currentThinkingLevel: ThinkingLevel,
): BaleMenuRenderPayload {
  return {
    nextMode: "thinking",
    text: buildThinkingMenuText(),
    mode: "html",
    replyMarkup: buildThinkingMenuReplyMarkup(currentThinkingLevel),
  };
}

export async function openBaleThinkingMenu<
  TModel extends MenuModel = MenuModel,
>(deps: BaleThinkingMenuOpenDeps<TModel>): Promise<void> {
  if (deps.isVoiceReplyActive?.()) return;
  const state = await deps.getModelMenuState();
  const messageId = await sendBaleMenuMessage(
    state,
    buildBaleThinkingMenuRenderPayload(
      deps.getActiveModel(),
      deps.getThinkingLevel(),
    ),
    deps,
  );
  if (messageId === undefined) return;
  state.messageId = messageId;
  state.mode = "thinking";
  deps.storeModelMenuState(state);
}

export async function updateBaleThinkingMenuMessage(
  state: BaleModelMenuState,
  activeModel: MenuModel | undefined,
  currentThinkingLevel: ThinkingLevel,
  deps: BaleMenuMessageRuntimeDeps & { isVoiceReplyActive?: () => boolean },
): Promise<void> {
  if (deps.isVoiceReplyActive?.()) return;
  await editBaleMenuMessage(
    state,
    buildBaleThinkingMenuRenderPayload(activeModel, currentThinkingLevel),
    deps,
  );
}

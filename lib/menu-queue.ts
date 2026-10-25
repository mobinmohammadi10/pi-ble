/**
 * Bale queue menu UI helpers
 * Zones: bale ui, queue controls, menu composition
 * Owns queue-menu rendering, queue item callbacks, and queue-menu runtime adapters while core queue mechanics stay in queue
 */

import type { BaleInlineKeyboardMarkup } from "./keyboard.ts";
import {
  createBaleMenuDelivery,
  type BaleMenuMessageRuntimeDeps,
  type BaleModelMenuState,
} from "./menu-model.ts";
import type { MenuModel } from "./model.ts";
import * as Queue from "./queue.ts";
import type { BaleApiCallOptions } from "./bale-api.ts";

const QUEUE_ITEM_PROMPT_HTML_LIMIT = 3600;
const QUEUE_ITEM_PROMPT_TRUNCATION_SUFFIX = "\n… [truncated]";
const EMPTY_QUEUE_REFRESH_TITLES = [
  "<b>⌛ Queue is still empty</b>",
  "<b>🫙 Still nothing in queue</b>",
  "<b>🍃 Queue remains empty</b>",
  "<b>🕳 Nothing queued yet</b>",
  "<b>🦗 Queue crickets continue</b>",
  "<b>🌙 Queue is peacefully idle</b>",
  "<b>🧘 Nothing waiting. Very zen</b>",
  "<b>🪐 Queue orbit is clear</b>",
  "<b>🧺 Basket is empty</b>",
  "<b>🔭 No prompts on the horizon</b>",
  "<b>🫧 Queue bubbles: none</b>",
  "<b>🛸 No queued signals detected</b>",
] as const;
type BaleQueueMenuReplyMarkup = BaleInlineKeyboardMarkup;
interface BaleQueueMenuItem {
  chatId: number;
  replyToMessageId: number;
  queueOrder: number;
  isGuest: boolean;
  queuePosition: number;
  queueLane: Queue.BaleQueueLane;
  canSelectLane: boolean;
  canSelectDisposition: boolean;
  dispatchProtected: boolean;
  attemptFrozen: boolean;
  exceedsIdleCapacity: boolean;
  priorityEmoji?: string;
  reactionSuppressionEmoji?: string;
  hasAttachments: boolean;
  statusSummary: string;
  promptText: string;
}

function getBaleQueueItemPromptText<Context>(
  item: Queue.BaleQueueItem<Context>,
): string {
  if (item.kind !== "prompt") return item.statusSummary;
  return (
    item.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n")
      .trim() || item.statusSummary
  );
}

function toBaleQueueMenuItems<Context>(
  items: readonly Queue.BaleQueueItem<Context>[],
  pendingDispatch = false,
): BaleQueueMenuItem[] {
  const head = items[0];
  return items.map((item, index) => {
    const dispatchProtected = pendingDispatch && (item === head ||
      (head?.kind === "prompt" && head.steerPacketTail?.includes(item as Queue.PendingBaleTurn) === true));
    const attemptFrozen = item.kind === "prompt" && item.steerAttempted === true && !dispatchProtected;
    const editable = item.kind === "prompt" && item.guestQueryId === undefined && item.guestInlineMessageId === undefined && !dispatchProtected && !attemptFrozen;
    return {
      chatId: item.chatId,
      replyToMessageId: item.replyToMessageId,
      queueOrder: item.queueOrder,
      isGuest: item.kind === "prompt" && item.guestQueryId !== undefined,
      queuePosition: index + 1,
      queueLane: item.queueLane,
      canSelectLane: editable && item.queueLane !== "control",
      canSelectDisposition: editable && (item.queueLane !== "control" || item.sourceMessageIds.includes(item.replyToMessageId)),
      dispatchProtected, attemptFrozen,
      exceedsIdleCapacity: item.kind === "prompt" && item.queueLane === "steer" && !item.steerAttempted &&
        !Queue.isBaleSteerItemWithinIdleCapacity(item),
      priorityEmoji: item.kind === "prompt" ? item.priorityEmoji : undefined,
      reactionSuppressionEmoji:
        item.kind === "prompt" ? item.reactionSuppressionEmoji : undefined,
      hasAttachments:
        item.kind === "prompt" && item.queuedAttachments.length > 0,
      statusSummary: item.statusSummary,
      promptText: getBaleQueueItemPromptText(item),
    };
  });
}

function formatSkippedBaleQueuePosition(position: number): string {
  return Array.from(String(position), (char) => `${char}\u0335`).join("");
}

function buildBaleQueueMenuReplyMarkup(
  items: readonly BaleQueueMenuItem[],
  emptyRefreshIndex = 0,
): BaleQueueMenuReplyMarkup {
  const backRow = [{ text: "⬆️ Main menu", callback_data: "menu:back" }];
  const nextEmptyRefreshIndex =
    (emptyRefreshIndex + 1) % EMPTY_QUEUE_REFRESH_TITLES.length;
  const refreshData =
    items.length === 0
      ? `queue:refresh:${nextEmptyRefreshIndex}`
      : "queue:refresh";
  const refreshRow = [{ text: "🔄 Refresh", callback_data: refreshData }];
  if (items.length === 0) return { inline_keyboard: [backRow, refreshRow] };
  const rows = items.map((item) => {
    const badge = getBaleQueueMenuLaneBadge(item);
    const prefix = item.reactionSuppressionEmoji ? "👎 " :
      badge ? `${badge} ` : item.hasAttachments ? "📎 " : "";
    const position = item.reactionSuppressionEmoji
      ? formatSkippedBaleQueuePosition(item.queuePosition)
      : String(item.queuePosition);
    const ordinalSeparator = item.reactionSuppressionEmoji ? "\u200A" : "";
    const state = item.attemptFrozen ? " · frozen" : item.dispatchProtected ? " · dispatch protected" :
      item.exceedsIdleCapacity ? " · idle capacity" : "";
    const label = `${position}${ordinalSeparator}. ${prefix}${item.statusSummary}${state}`;
    return [
      {
        text: label,
        callback_data: item.isGuest
          ? `queue:guest-pick:${item.queueOrder}`
          : `queue:pick:${item.chatId}:${item.replyToMessageId}`,
      },
    ];
  });
  return { inline_keyboard: [backRow, refreshRow, ...rows] };
}

function findBaleQueueItem<
  TItem extends { chatId: number; replyToMessageId: number },
>(
  items: readonly TItem[],
  chatId: number,
  replyToMessageId: number,
): TItem | undefined {
  return items.find((item) => {
    return item.chatId === chatId && item.replyToMessageId === replyToMessageId;
  });
}

function escapeBaleQueueMenuHtmlChar(char: string): string {
  if (char === "&") return "&amp;";
  if (char === "<") return "&lt;";
  if (char === ">") return "&gt;";
  return char;
}

function escapeBaleQueueMenuHtml(text: string): string {
  return Array.from(text).map(escapeBaleQueueMenuHtmlChar).join("");
}

function escapeBaleQueueMenuHtmlPreview(text: string): string {
  const suffix = escapeBaleQueueMenuHtml(
    QUEUE_ITEM_PROMPT_TRUNCATION_SUFFIX,
  );
  let escaped = "";
  let truncated = false;
  for (const char of text) {
    const next = escapeBaleQueueMenuHtmlChar(char);
    if (
      escaped.length + next.length + suffix.length >
      QUEUE_ITEM_PROMPT_HTML_LIMIT
    ) {
      truncated = true;
      break;
    }
    escaped += next;
  }
  return truncated ? escaped + suffix : escaped;
}

function getBaleQueueMenuLaneBadge(item: Pick<BaleQueueMenuItem, "queueLane">): string {
  if (item.queueLane === "control") return "⚡";
  if (item.queueLane === "steer") return "🔥";
  if (item.queueLane !== "priority") return "";
  return "👍";
}

function getBaleQueueMenuItemText(item: BaleQueueMenuItem): string {
  const marker = item.reactionSuppressionEmoji ? "👎" : getBaleQueueMenuLaneBadge(item);
  const badge = marker ? ` ${marker}` : "";
  const position = item.reactionSuppressionEmoji
    ? `<s>${item.queuePosition}</s>.`
    : `<b>${item.queuePosition}.</b>`;
  const heading = `${position}${badge}`;
  const preview = `<pre>${escapeBaleQueueMenuHtmlPreview(item.promptText)}</pre>`;
  const note = item.attemptFrozen ? "\n<b>⚠️ Attempt frozen.</b>\nSDK/model use is unconfirmed; not editable or automatically retried." :
    item.dispatchProtected ? "\n<b>⏳ Dispatch protected.</b>\nWaiting for agent_start; SDK/model use is unconfirmed." :
    item.exceedsIdleCapacity ? "\n<b>⚠️ Idle Steer capacity exceeded.</b>\nEdit the source or choose Priority/Normal; source groups are never split." :
    item.queueLane === "control" ? "\nControl lane is producer-owned." : "";
  return `${heading}\n${preview}${note}`;
}

function buildBaleGuestQueueItemSubmenuReplyMarkup(
  queueOrder: number,
): BaleQueueMenuReplyMarkup {
  return {
    inline_keyboard: [
      [{ text: "⬆️ Back", callback_data: "queue:list" }],
      [
        {
          text: "🔴 Skip",
          callback_data: `queue:guest-skip:${queueOrder}`,
        },
      ],
    ],
  };
}

function buildBaleQueueItemSubmenuReplyMarkup(item: BaleQueueMenuItem): BaleQueueMenuReplyMarkup {
  const rows: BaleQueueMenuReplyMarkup["inline_keyboard"] = [[{ text: "⬆️ Back", callback_data: "queue:list" }]];
  if (item.canSelectLane) rows.push([
    { text: item.queueLane === "default" ? "🔵 Normal" : "⚫️ Normal", callback_data: `queue:lane-set:${item.chatId}:${item.replyToMessageId}:normal` },
    { text: item.queueLane === "priority" ? "🟣 Priority" : "⚫️ Priority", callback_data: `queue:lane-set:${item.chatId}:${item.replyToMessageId}:priority` },
    { text: item.queueLane === "steer" ? "🟡 Steer" : "⚫️ Steer", callback_data: `queue:lane-set:${item.chatId}:${item.replyToMessageId}:steer` },
  ]);
  if (item.canSelectDisposition) rows.push([
    { text: item.reactionSuppressionEmoji ? "⚫️ Keep" : "🟢 Keep", callback_data: `queue:skip-set:${item.chatId}:${item.replyToMessageId}:keep` },
    { text: item.reactionSuppressionEmoji ? "🔴 Skip" : "⚫️ Skip", callback_data: `queue:skip-set:${item.chatId}:${item.replyToMessageId}:skip` },
  ]);
  return { inline_keyboard: rows };
}

interface BaleQueueMenuCallbackDeps<Context = unknown> {
  getQueuedItems: () => BaleQueueMenuItem[];
  findItem: (
    chatId: number,
    replyToMessageId: number,
  ) => BaleQueueMenuItem | undefined;
  findGuestItem: (queueOrder: number) => BaleQueueMenuItem | undefined;
  skipGuest: (queueOrder: number, ctx: Context) => Promise<boolean>;
  setLane: (chatId: number, replyToMessageId: number, lane: Exclude<Queue.BaleQueueLane, "control">) => boolean;
  setSkipped: (
    chatId: number,
    replyToMessageId: number,
    skipped: boolean,
  ) => boolean;
  updateQueueMessage: (
    chatId: number,
    messageId: number,
    text: string,
    replyMarkup: BaleQueueMenuReplyMarkup,
  ) => Promise<number | undefined>;
  answerCallbackQuery: (
    callbackQueryId: string,
    text?: string,
  ) => Promise<void>;
  updateStatus: (ctx: Context) => void;
}

async function handleBaleQueueMenuCallback<Context>(
  callbackQueryId: string,
  data: string,
  replyChatId: number,
  replyMessageId: number,
  ctx: Context,
  deps: BaleQueueMenuCallbackDeps<Context>,
): Promise<boolean> {
  if (!data.startsWith("queue:")) return false;
  if (data === "queue:noop") {
    await deps.answerCallbackQuery(callbackQueryId);
    return true;
  }
  if (data === "queue:list") {
    await updateBaleQueueMenuList(
      callbackQueryId,
      replyChatId,
      replyMessageId,
      deps,
    );
    return true;
  }
  const refreshMatch = data.match(/^queue:refresh(?::(\d+))?$/);
  if (refreshMatch) {
    await updateBaleQueueMenuList(
      callbackQueryId,
      replyChatId,
      replyMessageId,
      deps,
      undefined,
      refreshMatch[1] === undefined ? 0 : Number(refreshMatch[1]),
    );
    return true;
  }
  const guestPickMatch = data.match(/^queue:guest-pick:(\d+)$/);
  if (guestPickMatch) {
    await handleBaleGuestQueueMenuPick(
      callbackQueryId,
      replyChatId,
      replyMessageId,
      Number(guestPickMatch[1]),
      deps,
    );
    return true;
  }
  const guestSkipMatch = data.match(/^queue:guest-skip:(\d+)$/);
  if (guestSkipMatch) {
    const queueOrder = Number(guestSkipMatch[1]);
    const item = deps.findGuestItem(queueOrder);
    if (item?.dispatchProtected || item?.attemptFrozen) {
      await deps.answerCallbackQuery(callbackQueryId, "Queue item is protected");
      return true;
    }
    const skipped = await deps.skipGuest(queueOrder, ctx);
    if (!skipped) {
      await refreshStaleBaleQueueMenuItem(
        callbackQueryId,
        replyChatId,
        replyMessageId,
        deps,
      );
      return true;
    }
    await updateBaleQueueMenuList(
      callbackQueryId,
      replyChatId,
      replyMessageId,
      deps,
      "Guest prompt skipped",
    );
    return true;
  }
  const pickMatch = data.match(/^queue:pick:(\d+):(\d+)$/);
  if (pickMatch) {
    await handleBaleQueueMenuPick(
      callbackQueryId,
      replyChatId,
      replyMessageId,
      Number(pickMatch[1]),
      Number(pickMatch[2]),
      deps,
    );
    return true;
  }
  const prioSetMatch = data.match(
    /^queue:(?:lane-set|prio-set):(\d+):(\d+):(steer|priority|normal)$/,
  );
  if (prioSetMatch) {
    await handleBaleQueueMenuLaneSet(
      callbackQueryId,
      replyChatId,
      replyMessageId,
      Number(prioSetMatch[1]),
      Number(prioSetMatch[2]),
      prioSetMatch[3] === "normal" ? "default" : prioSetMatch[3] as "steer" | "priority",
      ctx,
      deps,
    );
    return true;
  }
  const prioMatch = data.match(/^queue:prio:(\d+):(\d+)$/);
  if (prioMatch) {
    await handleBaleQueueMenuPriority(
      callbackQueryId,
      replyChatId,
      replyMessageId,
      Number(prioMatch[1]),
      Number(prioMatch[2]),
      ctx,
      deps,
    );
    return true;
  }
  const skipSetMatch = data.match(/^queue:skip-set:(\d+):(\d+):(skip|keep)$/);
  if (skipSetMatch) {
    await handleBaleQueueMenuSkipSet(
      callbackQueryId,
      replyChatId,
      replyMessageId,
      Number(skipSetMatch[1]),
      Number(skipSetMatch[2]),
      skipSetMatch[3] === "skip",
      ctx,
      deps,
    );
    return true;
  }
  return false;
}

function getBaleQueueMenuListText(
  items: readonly BaleQueueMenuItem[],
  emptyRefreshIndex?: number,
): string {
  if (items.length > 0) return "<b>⏳ Queue:</b>";
  if (emptyRefreshIndex === undefined) return "<b>⌛ Queue is empty</b>";
  return EMPTY_QUEUE_REFRESH_TITLES[
    emptyRefreshIndex % EMPTY_QUEUE_REFRESH_TITLES.length
  ];
}

async function updateBaleQueueMenuList<Context>(
  callbackQueryId: string,
  replyChatId: number,
  replyMessageId: number,
  deps: BaleQueueMenuCallbackDeps<Context>,
  notice?: string,
  emptyRefreshIndex?: number,
): Promise<void> {
  const items = deps.getQueuedItems();
  await deps.updateQueueMessage(
    replyChatId,
    replyMessageId,
    getBaleQueueMenuListText(items, emptyRefreshIndex),
    buildBaleQueueMenuReplyMarkup(items, emptyRefreshIndex),
  );
  await deps.answerCallbackQuery(callbackQueryId, notice);
}

async function refreshStaleBaleQueueMenuItem<Context>(
  callbackQueryId: string,
  replyChatId: number,
  replyMessageId: number,
  deps: BaleQueueMenuCallbackDeps<Context>,
): Promise<void> {
  await updateBaleQueueMenuList(
    callbackQueryId,
    replyChatId,
    replyMessageId,
    deps,
    "Item no longer in queue",
  );
}

async function handleBaleGuestQueueMenuPick<Context>(
  callbackQueryId: string,
  replyChatId: number,
  replyMessageId: number,
  queueOrder: number,
  deps: BaleQueueMenuCallbackDeps<Context>,
): Promise<void> {
  const item = deps.findGuestItem(queueOrder);
  if (!item) {
    return refreshStaleBaleQueueMenuItem(
      callbackQueryId,
      replyChatId,
      replyMessageId,
      deps,
    );
  }
  await deps.updateQueueMessage(
    replyChatId,
    replyMessageId,
    getBaleQueueMenuItemText(item),
    item.dispatchProtected || item.attemptFrozen
      ? buildBaleQueueItemSubmenuReplyMarkup(item)
      : buildBaleGuestQueueItemSubmenuReplyMarkup(queueOrder),
  );
  await deps.answerCallbackQuery(callbackQueryId);
}

async function handleBaleQueueMenuPick<Context>(
  callbackQueryId: string,
  replyChatId: number,
  replyMessageId: number,
  chatId: number,
  msgId: number,
  deps: BaleQueueMenuCallbackDeps<Context>,
): Promise<void> {
  const item = deps.findItem(chatId, msgId);
  if (!item) {
    return refreshStaleBaleQueueMenuItem(
      callbackQueryId,
      replyChatId,
      replyMessageId,
      deps,
    );
  }
  await deps.updateQueueMessage(
    replyChatId,
    replyMessageId,
    getBaleQueueMenuItemText(item),
    buildBaleQueueItemSubmenuReplyMarkup(item),
  );
  await deps.answerCallbackQuery(callbackQueryId);
}

async function handleBaleQueueMenuPriority<Context>(
  callbackQueryId: string,
  replyChatId: number,
  replyMessageId: number,
  chatId: number,
  msgId: number,
  ctx: Context,
  deps: BaleQueueMenuCallbackDeps<Context>,
): Promise<void> {
  const item = deps.findItem(chatId, msgId);
  if (!item) {
    return refreshStaleBaleQueueMenuItem(
      callbackQueryId,
      replyChatId,
      replyMessageId,
      deps,
    );
  }
  await updateBaleQueueMenuLane(
    callbackQueryId,
    replyChatId,
    replyMessageId,
    chatId,
    msgId,
    item.queueLane === "priority" ? "default" : "priority",
    ctx,
    deps,
  );
}

async function handleBaleQueueMenuLaneSet<Context>(
  callbackQueryId: string,
  replyChatId: number,
  replyMessageId: number,
  chatId: number,
  msgId: number,
  lane: Exclude<Queue.BaleQueueLane, "control">,
  ctx: Context,
  deps: BaleQueueMenuCallbackDeps<Context>,
): Promise<void> {
  const item = deps.findItem(chatId, msgId);
  if (!item) {
    return refreshStaleBaleQueueMenuItem(
      callbackQueryId,
      replyChatId,
      replyMessageId,
      deps,
    );
  }
  await updateBaleQueueMenuLane(
    callbackQueryId,
    replyChatId,
    replyMessageId,
    chatId,
    msgId,
    lane,
    ctx,
    deps,
  );
}

async function updateBaleQueueMenuLane<Context>(
  callbackQueryId: string,
  replyChatId: number,
  replyMessageId: number,
  chatId: number,
  msgId: number,
  lane: Exclude<Queue.BaleQueueLane, "control">,
  ctx: Context,
  deps: BaleQueueMenuCallbackDeps<Context>,
): Promise<void> {
  if (!deps.setLane(chatId, msgId, lane)) {
    await deps.answerCallbackQuery(callbackQueryId, "Queue item is protected");
    return;
  }
  deps.updateStatus(ctx);
  const updated = deps.findItem(chatId, msgId);
  if (!updated) {
    return refreshStaleBaleQueueMenuItem(
      callbackQueryId,
      replyChatId,
      replyMessageId,
      deps,
    );
  }
  await deps.updateQueueMessage(
    replyChatId,
    replyMessageId,
    getBaleQueueMenuItemText(updated),
    buildBaleQueueItemSubmenuReplyMarkup(updated),
  );
  await deps.answerCallbackQuery(
    callbackQueryId,
    updated.queueLane === "steer" ? "Steer selected" : updated.queueLane === "priority" ? "Prioritized" : "Normal priority",
  );
}

async function handleBaleQueueMenuSkipSet<Context>(
  callbackQueryId: string,
  replyChatId: number,
  replyMessageId: number,
  chatId: number,
  msgId: number,
  skipped: boolean,
  ctx: Context,
  deps: BaleQueueMenuCallbackDeps<Context>,
): Promise<void> {
  const item = deps.findItem(chatId, msgId);
  if (!item) {
    return refreshStaleBaleQueueMenuItem(
      callbackQueryId,
      replyChatId,
      replyMessageId,
      deps,
    );
  }
  if (!deps.setSkipped(chatId, msgId, skipped)) {
    await deps.answerCallbackQuery(callbackQueryId, "Queue item is protected");
    return;
  }
  deps.updateStatus(ctx);
  const updated = deps.findItem(chatId, msgId);
  if (!updated) {
    return refreshStaleBaleQueueMenuItem(
      callbackQueryId,
      replyChatId,
      replyMessageId,
      deps,
    );
  }
  await deps.updateQueueMessage(
    replyChatId,
    replyMessageId,
    getBaleQueueMenuItemText(updated),
    buildBaleQueueItemSubmenuReplyMarkup(updated),
  );
  await deps.answerCallbackQuery(callbackQueryId);
}

interface BaleQueueMenuCallbackQuery {
  id: string;
  data?: string;
  message?: { chat?: { id?: number }; message_id?: number };
}
interface BaleQueueMenuRuntime<Context> {
  openQueueMenu: (
    chatId: number,
    replyToMessageId: number,
    ctx: Context,
    threadId?: number,
    options?: Pick<BaleApiCallOptions, "assertAuthority">,
  ) => Promise<void>;
  handleCallbackQuery: (
    query: BaleQueueMenuCallbackQuery,
    ctx: Context,
  ) => Promise<boolean>;
}
export function createBaleQueueMenuRuntime<
  Context,
  TModel extends MenuModel = MenuModel,
>(deps: {
  hasPendingDispatch?: () => boolean;
  baleQueueStore: Queue.BaleQueueStateStore<Context>;
  queueMutationRuntime: Queue.BaleQueueMutationController<Context>;
  sendInteractiveMessage: BaleMenuMessageRuntimeDeps["sendInteractiveMessage"];
  editInteractiveMessage: (
    chatId: number,
    messageId: number,
    text: string,
    mode: "html",
    replyMarkup: BaleQueueMenuReplyMarkup,
  ) => Promise<void>;
  answerCallbackQuery: (
    callbackQueryId: string,
    text?: string,
  ) => Promise<void>;
  getModelMenuState: (
    chatId: number,
    ctx: Context,
    threadId?: number,
  ) => Promise<BaleModelMenuState<TModel>>;
  getStoredModelMenuState: (
    messageId: number | undefined,
    chatId?: number,
  ) => BaleModelMenuState<TModel> | undefined;
  storeModelMenuState: (state: BaleModelMenuState<TModel>) => void;
  updateStatusMessage: (
    state: BaleModelMenuState<TModel>,
    ctx: Context,
  ) => Promise<void>;
  updateStatus: (ctx: Context) => void;
  dismissGuestPlaceholder?: (inlineMessageId: string) => Promise<void>;
}): BaleQueueMenuRuntime<Context> {
  const sendQueueMenuMessage = createQueueMenuSendMessageAdapter(
    deps.sendInteractiveMessage,
  );
  const editQueueMenuMessage = createQueueMenuEditMessageAdapter(
    deps.editInteractiveMessage,
  );
  return {
    openQueueMenu: (chatId, replyToMessageId, ctx, threadId, options) => {
      const delivery = createBaleMenuDelivery(
        { chatId, threadId },
        options,
        deps,
      );
      return createOpenQueueMenu<Context, TModel>({
        getQueuedItems: deps.baleQueueStore.getQueuedItems,
        hasPendingDispatch: deps.hasPendingDispatch,
        getModelMenuState: (chat, context) =>
          deps.getModelMenuState(chat, context, threadId),
        storeModelMenuState: delivery.storeModelMenuState,
        sendInteractiveMessage: delivery.assertAuthority
          ? createQueueMenuSendMessageAdapter(delivery.sendInteractiveMessage)
          : sendQueueMenuMessage,
      })(chatId, replyToMessageId, ctx);
    },
    handleCallbackQuery: createQueueMenuCallbackHandler<Context, TModel>({
      hasPendingDispatch: deps.hasPendingDispatch,
      baleQueueStore: deps.baleQueueStore,
      queueMutationRuntime: deps.queueMutationRuntime,
      editInteractiveMessage: editQueueMenuMessage,
      getStoredModelMenuState: deps.getStoredModelMenuState,
      updateStatusMessage: deps.updateStatusMessage,
      answerCallbackQuery: deps.answerCallbackQuery,
      updateStatus: deps.updateStatus,
      dismissGuestPlaceholder: deps.dismissGuestPlaceholder,
    }),
  };
}

function createOpenQueueMenu<
  Context,
  TModel extends MenuModel = MenuModel,
>(deps: {
  getQueuedItems: () => Queue.BaleQueueItem<Context>[];
  hasPendingDispatch?: () => boolean;
  getModelMenuState: (
    chatId: number,
    ctx: Context,
  ) => Promise<BaleModelMenuState<TModel>>;
  storeModelMenuState: (state: BaleModelMenuState<TModel>) => void;
  sendInteractiveMessage: (
    chatId: number,
    replyToMessageId: number,
    text: string,
    replyMarkup: BaleQueueMenuReplyMarkup,
  ) => Promise<number | undefined>;
}) {
  return async (
    chatId: number,
    replyToMessageId: number,
    ctx: Context,
  ): Promise<void> => {
    const state = await deps.getModelMenuState(chatId, ctx);
    const menuItems = toBaleQueueMenuItems(deps.getQueuedItems(), deps.hasPendingDispatch?.());
    const text = getBaleQueueMenuListText(menuItems);
    const messageId = await deps.sendInteractiveMessage(
      chatId,
      replyToMessageId,
      text,
      buildBaleQueueMenuReplyMarkup(menuItems),
    );
    if (messageId === undefined) return;
    state.messageId = messageId;
    state.mode = "queue";
    deps.storeModelMenuState(state);
  };
}

function createQueueMenuCallbackHandler<
  Context,
  TModel extends MenuModel = MenuModel,
>(deps: {
  hasPendingDispatch?: () => boolean;
  baleQueueStore: Queue.BaleQueueStateStore<Context>;
  queueMutationRuntime: Queue.BaleQueueMutationController<Context>;
  editInteractiveMessage: (
    chatId: number,
    messageId: number,
    text: string,
    replyMarkup: BaleQueueMenuReplyMarkup,
  ) => Promise<number | undefined>;
  getStoredModelMenuState: (
    messageId: number | undefined,
    chatId?: number,
  ) => BaleModelMenuState<TModel> | undefined;
  updateStatusMessage: (
    state: BaleModelMenuState<TModel>,
    ctx: Context,
  ) => Promise<void>;
  answerCallbackQuery: (
    callbackQueryId: string,
    text?: string,
  ) => Promise<void>;
  updateStatus: (ctx: Context) => void;
  dismissGuestPlaceholder?: (inlineMessageId: string) => Promise<void>;
}) {
  return async (
    query: BaleQueueMenuCallbackQuery,
    ctx: Context,
  ): Promise<boolean> => {
    const data = query.data;
    const chatId = query.message?.chat?.id;
    const messageId = query.message?.message_id;
    if (!data || typeof chatId !== "number" || typeof messageId !== "number")
      return false;
    if (data === "menu:queue" || data === "status:queue") {
      const state = deps.getStoredModelMenuState(messageId, chatId);
      if (!state) {
        await deps.answerCallbackQuery(query.id, "Interactive message expired");
        return true;
      }
      const menuItems = toBaleQueueMenuItems(
        deps.baleQueueStore.getQueuedItems(), deps.hasPendingDispatch?.(),
      );
      await deps.editInteractiveMessage(
        chatId,
        messageId,
        getBaleQueueMenuListText(menuItems),
        buildBaleQueueMenuReplyMarkup(menuItems),
      );
      state.mode = "queue";
      await deps.answerCallbackQuery(query.id);
      return true;
    }
    if (!data.startsWith("queue:")) return false;
    const getQueueSnapshot = () => {
      return deps.baleQueueStore.getQueuedItems();
    };
    const toMenuItems = () => {
      return toBaleQueueMenuItems(getQueueSnapshot(), deps.hasPendingDispatch?.());
    };
    const findItem = (cId: number, rId: number) => {
      return findBaleQueueItem(toMenuItems(), cId, rId);
    };
    const findGuestItem = (queueOrder: number) => {
      return toMenuItems().find((item) => {
        return item.isGuest && item.queueOrder === queueOrder;
      });
    };
    const flagDeps = {
      getQueueSnapshot,
      queueMutationRuntime: deps.queueMutationRuntime,
      hasPendingDispatch: deps.hasPendingDispatch,
    };
    return handleBaleQueueMenuCallback(
      query.id,
      data,
      chatId,
      messageId,
      ctx,
      {
        getQueuedItems: toMenuItems,
        findItem,
        findGuestItem,
        skipGuest: (queueOrder, callbackContext) => {
          return skipQueuedBaleGuestPrompt(queueOrder, callbackContext, {
            getQueueSnapshot,
            queueMutationRuntime: deps.queueMutationRuntime,
            dismissGuestPlaceholder: deps.dismissGuestPlaceholder,
          });
        },
        setLane: (cId, rId, lane) =>
          applyQueuedBalePromptMenuFlags(cId, rId, ctx, flagDeps, () => ({ lane })),
        setSkipped: (cId, rId, skipped) =>
          applyQueuedBalePromptMenuFlags(cId, rId, ctx, flagDeps, () => ({ skipped })),
        updateQueueMessage: deps.editInteractiveMessage,
        answerCallbackQuery: deps.answerCallbackQuery,
        updateStatus: deps.updateStatus,
      },
    );
  };
}

async function skipQueuedBaleGuestPrompt<Context>(
  queueOrder: number,
  ctx: Context,
  deps: {
    getQueueSnapshot: () => Queue.BaleQueueItem<Context>[];
    queueMutationRuntime: Queue.BaleQueueMutationController<Context>;
    dismissGuestPlaceholder?: (inlineMessageId: string) => Promise<void>;
  },
): Promise<boolean> {
  const item = deps.getQueueSnapshot().find((candidate) => {
    return (
      candidate.kind === "prompt" &&
      candidate.guestQueryId !== undefined &&
      candidate.queueOrder === queueOrder
    );
  });
  if (!item || !deps.queueMutationRuntime.removeGuestPromptByQueueOrder) {
    return false;
  }
  const removed = deps.queueMutationRuntime.removeGuestPromptByQueueOrder(
    queueOrder,
    ctx,
  );
  if (!removed) return false;
  if (item.guestInlineMessageId && deps.dismissGuestPlaceholder) {
    await deps.dismissGuestPlaceholder(item.guestInlineMessageId);
  }
  return true;
}

interface BaleQueueMenuFlags {
  lane?: Exclude<Queue.BaleQueueLane, "control">;
  skipped?: boolean;
}

/** Each menu selection changes one dimension through the existing Queue owner. */
function applyQueuedBalePromptMenuFlags<Context>(
  chatId: number,
  replyToMessageId: number,
  ctx: Context,
  deps: {
    getQueueSnapshot: () => Queue.BaleQueueItem<Context>[];
    queueMutationRuntime: Queue.BaleQueueMutationController<Context>;
    hasPendingDispatch?: () => boolean;
  },
  chooseFlags: (item: Queue.BaleQueueItem<Context>) => BaleQueueMenuFlags | undefined,
): boolean {
  const item = findBaleQueueItem(
    deps.getQueueSnapshot(),
    chatId,
    replyToMessageId,
  );
  const flags = item ? chooseFlags(item) : undefined;
  if (!item || item.kind !== "prompt" || !flags) return false;
  const view = findBaleQueueItem(toBaleQueueMenuItems(deps.getQueueSnapshot(), deps.hasPendingDispatch?.()), chatId, replyToMessageId);
  if (!view || (flags.lane !== undefined && !view.canSelectLane) || (flags.skipped !== undefined && !view.canSelectDisposition)) return false;
  const disposition: Extract<Queue.BaleQueueReactionDisposition, { kind: "reaction-transition" }> = { kind: "reaction-transition" };
  if (flags.lane !== undefined) {
    disposition.promptLane = flags.lane;
    disposition.priorityEmoji = flags.lane === "steer" ? "🔥" : flags.lane === "priority" ? "👍" : null;
  }
  if (flags.skipped !== undefined) disposition.suppressionEmoji = flags.skipped ? "👎" : null;
  return deps.queueMutationRuntime.applyReactionByMessageId(replyToMessageId, disposition, ctx) ||
    ((flags.lane === undefined || flags.lane === item.queueLane) &&
      (flags.skipped === undefined || flags.skipped === (item.reactionSuppressionEmoji !== undefined)));
}

function createQueueMenuSendMessageAdapter(
  sendInteractiveMessage: (
    chatId: number,
    text: string,
    mode: "html",
    replyMarkup: BaleQueueMenuReplyMarkup,
  ) => Promise<number | undefined>,
) {
  return (
    chatId: number,
    _replyToMessageId: number,
    text: string,
    replyMarkup: BaleQueueMenuReplyMarkup,
  ): Promise<number | undefined> => {
    return sendInteractiveMessage(chatId, text, "html", replyMarkup);
  };
}

function createQueueMenuEditMessageAdapter(
  editInteractiveMessage: (
    chatId: number,
    messageId: number,
    text: string,
    mode: "html",
    replyMarkup: BaleQueueMenuReplyMarkup,
  ) => Promise<void>,
) {
  return (
    chatId: number,
    messageId: number,
    text: string,
    replyMarkup: BaleQueueMenuReplyMarkup,
  ): Promise<number | undefined> => {
    return editInteractiveMessage(
      chatId,
      messageId,
      text,
      "html",
      replyMarkup,
    ).then(() => {
      return undefined as number | undefined;
    });
  };
}

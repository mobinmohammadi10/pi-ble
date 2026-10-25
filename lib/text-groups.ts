/**
 * Bale text-group coalescing helpers
 * Zones: bale inbound, queue admission, split-message recovery
 * Owns conservative delayed grouping for Bale text messages that look like automatic long-message splits
 */

import { setTimeout as waitForTimeout } from "node:timers/promises";

import {
  createBalePendingGroups,
  extractBaleMessageText,
  type BalePendingGroup,
  type BaleMessageForwardOrigin,
  type BaleMessageUser,
  type BaleRichMessage,
} from "./media.ts";

const BALE_TEXT_GROUP_DEBOUNCE_MS = 1000;
const BALE_TEXT_GROUP_MIN_SPLIT_LENGTH = 3600;
const BALE_TEXT_GROUP_MAX_MESSAGE_ID_GAP = 12;

export interface BaleTextGroupMessage {
  message_id: number;
  media_group_id?: string;
  chat: { id: number };
  message_thread_id?: number;
  from?: { id?: number; is_bot?: boolean };
  text?: string;
  caption?: string;
  rich_message?: BaleRichMessage;
  forward_origin?: BaleMessageForwardOrigin;
  forward_from?: BaleMessageUser;
  forward_sender_name?: string;
}

export type BaleForwardCommentBatchPosition = "comment" | "forward";

export interface BaleTextGroupController<TMessage, TContext = unknown> {
  prepareUpdateBatch: (updates: readonly { message?: TMessage }[]) => void;
  getPreparedForwardingPosition: (
    message: BaleTextGroupMessage,
  ) => BaleForwardCommentBatchPosition | undefined;
  prepareForwardedMessage: (
    message: BaleTextGroupMessage,
    position: BaleForwardCommentBatchPosition,
  ) => void;
  queueMessage: (options: {
    message: TMessage;
    context: TContext;
    dispatchMessages: (
      messages: TMessage[],
      ctx: TContext,
    ) => unknown | Promise<unknown>;
  }) => boolean;
  flushMessage: (messageId: number) => Promise<boolean>;
  suspend: () => void;
  resume: (context: TContext) => void;
  clear: () => void;
}

export interface BaleTextGroupControllerOptions {
  debounceMs?: number;
  forwardCommentWaitMs?: number | false;
  minSplitLength?: number;
  setTimer?: (
    callback: () => void,
    ms: number,
  ) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
}

export interface BaleTextGroupDispatchRuntime<
  TMessage extends BaleTextGroupMessage,
  TContext,
> {
  handleMessage: (message: TMessage, ctx: TContext) => Promise<void>;
}

export interface BaleGroupedInputClearerDeps {
  clearMediaGroups: () => void;
  clearTextGroups: () => void;
}

function extractBaleTextGroupText(
  message: BaleTextGroupMessage,
): string {
  return extractBaleMessageText(message);
}

function isBaleForwardedMessage(
  message: BaleTextGroupMessage,
): boolean {
  return (
    message.forward_origin !== undefined ||
    message.forward_from !== undefined ||
    typeof message.forward_sender_name === "string"
  );
}

function isBaleTextGroupCommand(text: string): boolean {
  return text.trimStart().startsWith("/");
}

function isBaleTextGroupClearingCommand(text: string): boolean {
  const command = text.trimStart().split(/\s+/, 1)[0]?.split("@", 1)[0];
  return command === "/stop";
}

function getBaleTextGroupMessageIdentity(
  message: BaleTextGroupMessage,
): string {
  const threadKey =
    typeof message.message_thread_id === "number"
      ? `thread:${message.message_thread_id}`
      : "private";
  return `${message.chat.id}:${threadKey}:${message.message_id}`;
}

function getBaleTextGroupKey(
  message: BaleTextGroupMessage,
): string | undefined {
  if (message.media_group_id) return undefined;
  if (!message.from || message.from.is_bot) return undefined;
  if (
    !extractBaleTextGroupText(message) &&
    !isBaleForwardedMessage(message)
  ) {
    return undefined;
  }
  const threadKey =
    typeof message.message_thread_id === "number"
      ? `thread:${message.message_thread_id}`
      : "private";
  return `${message.chat.id}:${threadKey}:${message.from.id}`;
}

function canStartBaleTextGroup(
  message: BaleTextGroupMessage,
  minSplitLength: number,
): boolean {
  const text = extractBaleTextGroupText(message);
  return text.length >= minSplitLength && !isBaleTextGroupCommand(text);
}

function canAppendBaleTextGroupMessage<
  TMessage extends BaleTextGroupMessage,
>(
  group: BalePendingGroup<TMessage, unknown, unknown>,
  message: TMessage,
): boolean {
  const text = extractBaleTextGroupText(message);
  const previous = group.messages.at(-1);
  return (
    !!previous &&
    message.message_id > previous.message_id &&
    message.message_id <=
      previous.message_id + BALE_TEXT_GROUP_MAX_MESSAGE_ID_GAP &&
    (text.length > 0 || isBaleForwardedMessage(message)) &&
    !isBaleTextGroupCommand(text)
  );
}

export function createBaleTextGroupController<
  TMessage extends BaleTextGroupMessage,
  TContext = unknown,
>(
  options: BaleTextGroupControllerOptions = {},
): BaleTextGroupController<TMessage, TContext> {
  const plannedForwardCommentStarts = new Set<string>();
  const plannedForwardCommentEnds = new Set<string>();
  const debounceMs = options.debounceMs ?? BALE_TEXT_GROUP_DEBOUNCE_MS;
  const minSplitLength =
    options.minSplitLength ?? BALE_TEXT_GROUP_MIN_SPLIT_LENGTH;
  const forwardCommentWaitMs =
    options.forwardCommentWaitMs === undefined
      ? debounceMs
      : options.forwardCommentWaitMs;
  const setTimer =
    options.setTimer ??
    ((callback: () => void, ms: number): ReturnType<typeof setTimeout> => {
      const controller = new AbortController();
      void waitForTimeout(ms, undefined, {
        signal: controller.signal,
      }).then(callback, () => undefined);
      return controller as unknown as ReturnType<typeof setTimeout>;
    });
  const clearTimer =
    options.clearTimer ??
    (options.setTimer
      ? clearTimeout
      : (timer: ReturnType<typeof setTimeout>): void => {
          (timer as unknown as AbortController).abort();
        });
  const groups = createBalePendingGroups<
    TMessage,
    TContext,
    BaleForwardCommentBatchPosition
  >({ debounceMs, requireContext: true, setTimer, clearTimer });
  /** Admission policy for one message; the shared group machine owns timers, batches and dispatch. */
  const queueTextGroupMessage = (options: {
    key: string;
    message: TMessage;
    context: TContext;
    dispatchMessages: (
      messages: TMessage[],
      ctx: TContext,
    ) => unknown | Promise<unknown>;
    forceStart: boolean;
    dispatchImmediately: boolean;
    forwardPairCandidate?: BaleForwardCommentBatchPosition;
    delayMs?: number;
  }): boolean => {
    const existing = groups.get(options.key);
    const dispatchMessages = (messages: TMessage[], ctx?: TContext) =>
      options.dispatchMessages(messages, ctx as TContext);
    const queued = {
      key: options.key,
      message: options.message,
      context: options.context,
      ...(options.forwardPairCandidate === undefined
        ? {}
        : { meta: options.forwardPairCandidate }),
      dispatchMessages,
    };
    if (
      existing?.messages.some(
        (message) => message.message_id === options.message.message_id,
      )
    ) {
      groups.queue({ ...queued, delayMs: debounceMs, rearm: "ifIdle" });
      return true;
    }
    if (
      !existing &&
      !options.forceStart &&
      !canStartBaleTextGroup(options.message, minSplitLength)
    )
      return false;
    if (
      existing &&
      !canAppendBaleTextGroupMessage(existing, options.message)
    )
      return false;
    groups.queue({
      ...queued,
      delayMs: options.dispatchImmediately
        ? 0
        : (options.delayMs ?? debounceMs),
      rearm: "always",
    });
    return true;
  };
  return {
    prepareUpdateBatch(updates) {
      for (let index = 0; index + 1 < updates.length; index += 1) {
        const comment = updates[index]?.message;
        const forwarded = updates[index + 1]?.message;
        if (!comment || !forwarded) continue;
        const commentText = extractBaleTextGroupText(comment);
        const commentKey = getBaleTextGroupKey(comment);
        const forwardedKey = getBaleTextGroupKey(forwarded);
        if (
          !commentKey ||
          commentKey !== forwardedKey ||
          !commentText ||
          isBaleTextGroupCommand(commentText) ||
          isBaleForwardedMessage(comment) ||
          !isBaleForwardedMessage(forwarded) ||
          forwarded.message_id <= comment.message_id ||
          forwarded.message_id >
            comment.message_id + BALE_TEXT_GROUP_MAX_MESSAGE_ID_GAP
        ) {
          continue;
        }
        plannedForwardCommentStarts.add(
          getBaleTextGroupMessageIdentity(comment),
        );
        plannedForwardCommentEnds.add(
          getBaleTextGroupMessageIdentity(forwarded),
        );
      }
    },
    getPreparedForwardingPosition(message) {
      const identity = getBaleTextGroupMessageIdentity(message);
      if (plannedForwardCommentStarts.has(identity)) return "comment";
      if (plannedForwardCommentEnds.has(identity)) return "forward";
      return undefined;
    },
    prepareForwardedMessage(message, position) {
      const identity = getBaleTextGroupMessageIdentity(message);
      if (position === "comment") plannedForwardCommentStarts.add(identity);
      else plannedForwardCommentEnds.add(identity);
    },
    queueMessage: ({ message, context, dispatchMessages }) => {
      const identity = getBaleTextGroupMessageIdentity(message);
      const key = getBaleTextGroupKey(message);
      const plannedStart = plannedForwardCommentStarts.delete(identity);
      const forwarded = isBaleForwardedMessage(message);
      const existing = key ? groups.get(key) : undefined;
      const text = extractBaleTextGroupText(message);
      if (existing && isBaleTextGroupClearingCommand(text))
        groups.clearKey(key!);
      const candidatePosition: BaleForwardCommentBatchPosition = forwarded
        ? "forward"
        : "comment";
      const existingCandidate = existing?.meta;
      const pairCompleted =
        existingCandidate !== undefined &&
        existingCandidate !== candidatePosition;
      const separateFromCandidate =
        existingCandidate === candidatePosition &&
        !isBaleTextGroupCommand(text);
      if (separateFromCandidate && existing) groups.closeBatch(key!);
      const forceStart =
        plannedStart ||
        (forwardCommentWaitMs !== false &&
          !!key &&
          (forwarded ||
            (typeof message.text === "string" &&
              !isBaleTextGroupCommand(
                extractBaleTextGroupText(message),
              ))));
      const dispatchImmediately =
        pairCompleted ||
        separateFromCandidate ||
        plannedForwardCommentEnds.delete(identity) ||
        (forwarded && !!key && groups.get(key) !== undefined);
      if (!key) return false;
      return queueTextGroupMessage({
        key,
        message,
        context,
        dispatchMessages,
        forceStart,
        dispatchImmediately,
        forwardPairCandidate:
          forceStart && !canStartBaleTextGroup(message, minSplitLength)
            ? candidatePosition
            : undefined,
        delayMs:
          forceStart && !canStartBaleTextGroup(message, minSplitLength)
            ? forwardCommentWaitMs === false
              ? undefined
              : forwardCommentWaitMs
            : undefined,
      });
    },
    flushMessage: groups.flushMessage,
    suspend: groups.suspend,
    resume: groups.resume,
    clear: () => {
      groups.clear();
      plannedForwardCommentStarts.clear();
      plannedForwardCommentEnds.clear();
    },
  };
}

export function createBaleTextGroupDispatchRuntime<
  TMessage extends BaleTextGroupMessage,
  TContext,
>(deps: {
  textGroups: BaleTextGroupController<TMessage, TContext>;
  dispatchMessages: (messages: TMessage[], ctx: TContext) => Promise<void>;
  dispatchSingleMessage: (message: TMessage, ctx: TContext) => Promise<void>;
  onDeferredMessage?: (message: TMessage) => void;
}): BaleTextGroupDispatchRuntime<TMessage, TContext> {
  return {
    handleMessage: async (message, ctx) => {
      const queuedTextGroup = deps.textGroups.queueMessage({
        message,
        context: ctx,
        dispatchMessages: (messages, queuedCtx) =>
          deps.dispatchMessages(messages, queuedCtx),
      });
      if (queuedTextGroup) {
        deps.onDeferredMessage?.(message);
        return;
      }
      await deps.dispatchSingleMessage(message, ctx);
    },
  };
}

export function createBaleGroupedInputClearer(
  deps: BaleGroupedInputClearerDeps,
): () => void {
  return () => {
    deps.clearMediaGroups();
    deps.clearTextGroups();
  };
}

/**
 * Bale media and text extraction helpers
 * Zones: bale inbound, media groups, filesystem paths
 * Normalizes inbound Bale messages into reusable file, text, id, history, and media-group metadata
 */

import { basename, dirname } from "node:path";

import * as Machine from "./machine.ts";

const BALE_MEDIA_GROUP_DEBOUNCE_MS = 1200;
const BALE_REPLY_CONTEXT_MAX_LENGTH = 1000;

export interface BalePhotoSize {
  file_id: string;
  file_size?: number;
}

export interface BaleDocument {
  file_id: string;
  file_name?: string;
  mime_type?: string;
}

export type BaleVideo = BaleDocument;
export type BaleAudio = BaleDocument;
export type BaleAnimation = BaleDocument;

export interface BaleVoice {
  file_id: string;
  mime_type?: string;
}

export interface BaleRichMessage {
  blocks?: unknown[];
}

export interface BaleMessageUser {
  id?: number;
  is_bot?: boolean;
  first_name?: string;
  last_name?: string;
  username?: string;
}

export interface BaleMessageForwardOrigin {
  type?: string;
  sender_user?: BaleMessageUser;
  sender_user_name?: string;
  sender_chat?: { title?: string; username?: string; id?: number };
  chat?: { title?: string; username?: string; id?: number };
  author_signature?: string;
}

export interface BaleReplyToMessage {
  message_id?: number;
  from?: BaleMessageUser;
  text?: string;
  caption?: string;
  rich_message?: BaleRichMessage;
  photo?: BalePhotoSize[];
  document?: BaleDocument;
  video?: BaleVideo;
  audio?: BaleAudio;
  voice?: BaleVoice;
  animation?: BaleAnimation;
  sticker?: BaleSticker;
}

export interface BaleSticker {
  file_id: string;
  is_video?: boolean;
  is_animated?: boolean;
}

export interface BaleMediaMessage {
  message_id: number;
  chat?: { id: number; type?: string; username?: string };
  from?: BaleMessageUser;
  forward_origin?: BaleMessageForwardOrigin;
  forward_from?: BaleMessageUser;
  forward_sender_name?: string;
  text?: string;
  caption?: string;
  rich_message?: BaleRichMessage;
  reply_to_message?: BaleReplyToMessage;
  media_group_id?: string;
  photo?: BalePhotoSize[];
  document?: BaleDocument;
  video?: BaleVideo;
  audio?: BaleAudio;
  voice?: BaleVoice;
  animation?: BaleAnimation;
  sticker?: BaleSticker;
}

export interface BaleMediaGroupMessage {
  message_id: number;
  chat: { id: number };
  message_thread_id?: number;
  media_group_id?: string;
}

export interface BaleMediaGroupController<
  TMessage extends BaleMediaGroupMessage,
  TContext = unknown,
> {
  queueMessage: (options: {
    message: TMessage;
    context?: TContext;
    dispatchMessages: (
      messages: TMessage[],
      ctx?: TContext,
    ) => unknown | Promise<unknown>;
  }) => boolean;
  removeMessages: (messageIds: number[]) => number;
  flushMessage: (messageId: number) => Promise<boolean>;
  suspend: () => void;
  resume: (context: TContext) => void;
  clear: () => void;
}

export interface BaleMediaGroupDispatchRuntimeDeps<
  TMessage extends BaleMediaGroupMessage,
  TContext,
> {
  mediaGroups: BaleMediaGroupController<TMessage, TContext>;
  dispatchMessages: (messages: TMessage[], ctx: TContext) => Promise<void>;
  onDeferredMessage?: (message: TMessage) => void;
}

export interface BaleMediaGroupDispatchRuntime<
  TMessage extends BaleMediaGroupMessage,
  TContext,
> {
  handleMessage: (message: TMessage, ctx: TContext) => Promise<void>;
}

export interface BaleMediaGroupControllerOptions {
  debounceMs?: number;
  setTimer?: (
    callback: () => void,
    ms: number,
  ) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
}

export type BaleAttachmentKind =
  "photo" | "document" | "video" | "audio" | "voice" | "animation" | "sticker";

/** Where an inbound attachment came from; the download layer turns it into a scoped file name. */
export interface BaleAttachmentSource {
  kind: string;
  messageId: number;
  index?: number;
  /** Sender-chosen file name, kept as a trailing readable segment. */
  userFileName?: string;
  chat?: { id: number; type?: string; username?: string };
  /** Explicit source scope, e.g. a Guest Mode peer whose message IDs are not the bot chat's. */
  scope?: string;
}

export interface BaleFileInfo {
  file_id: string;
  fileName: string;
  /** Present only when the sender chose the name. */
  userFileName?: string;
  /** Position inside a rich message. */
  index?: number;
  source?: BaleAttachmentSource;
  mimeType?: string;
  kind: BaleAttachmentKind;
  isImage: boolean;
}

export interface DownloadedBaleFile {
  path: string;
  fileName?: string;
  isImage?: boolean;
  mimeType?: string;
  kind?: BaleAttachmentKind;
}

export interface DownloadedBaleMessageFile {
  path: string;
  fileName: string;
  isImage: boolean;
  mimeType?: string;
  kind?: BaleAttachmentKind;
}

export interface DownloadBaleMessageFilesDeps {
  downloadFile: (
    fileId: string,
    fileName: string,
    source?: BaleAttachmentSource,
  ) => Promise<string>;
}

function guessExtensionFromMime(
  mimeType: string | undefined,
  fallback: string,
): string {
  if (!mimeType) return fallback;
  const normalized = mimeType.toLowerCase();
  if (normalized === "image/jpeg") return ".jpg";
  if (normalized === "image/png") return ".png";
  if (normalized === "image/webp") return ".webp";
  if (normalized === "image/gif") return ".gif";
  if (normalized === "audio/ogg") return ".ogg";
  if (normalized === "audio/mpeg") return ".mp3";
  if (normalized === "audio/wav") return ".wav";
  if (normalized === "video/mp4") return ".mp4";
  if (normalized === "application/pdf") return ".pdf";
  return fallback;
}

export function guessMediaType(path: string): string | undefined {
  const normalized = path.toLowerCase();
  if (normalized.endsWith(".jpg") || normalized.endsWith(".jpeg")) {
    return "image/jpeg";
  }
  if (normalized.endsWith(".png")) return "image/png";
  if (normalized.endsWith(".webp")) return "image/webp";
  if (normalized.endsWith(".gif")) return "image/gif";
  return undefined;
}

function isImageMimeType(mimeType: string | undefined): boolean {
  return mimeType?.toLowerCase().startsWith("image/") ?? false;
}

function getObjectField(value: unknown, field: string): unknown {
  if (typeof value !== "object" || value === null || !(field in value)) {
    return undefined;
  }
  return Reflect.get(value, field);
}

function joinRichTextParts(parts: string[], separator = ""): string {
  return parts.filter(Boolean).join(separator).trim();
}

function extractBaleRichText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return joinRichTextParts(value.map(extractBaleRichText));
  }
  if (typeof value !== "object" || value === null) return "";
  const text = getObjectField(value, "text");
  if (text !== undefined) return extractBaleRichText(text);
  const expression = getObjectField(value, "expression");
  if (typeof expression === "string") return expression;
  const alternativeText = getObjectField(value, "alternative_text");
  if (typeof alternativeText === "string") return alternativeText;
  return "";
}

function extractBaleRichBlockText(block: unknown): string {
  if (typeof block !== "object" || block === null) return "";
  const directText = extractBaleRichText(getObjectField(block, "text"));
  if (directText) return directText;
  const summary = extractBaleRichText(getObjectField(block, "summary"));
  const nestedBlocks = extractBaleRichMessageBlocksText(
    getObjectField(block, "blocks"),
  );
  const items = getObjectField(block, "items");
  const itemText = Array.isArray(items)
    ? items
        .map((item) => {
          const label = getObjectField(item, "label");
          const body = extractBaleRichMessageBlocksText(
            getObjectField(item, "blocks"),
          );
          return typeof label === "string" && body ? `${label} ${body}` : body;
        })
        .filter(Boolean)
        .join("\n")
    : "";
  const cells = getObjectField(block, "cells");
  const cellText = Array.isArray(cells)
    ? cells
        .map((row) =>
          Array.isArray(row)
            ? row
                .map((cell) =>
                  extractBaleRichText(getObjectField(cell, "text")),
                )
                .filter(Boolean)
                .join(" | ")
            : "",
        )
        .filter(Boolean)
        .join("\n")
    : "";
  const caption = extractBaleRichText(getObjectField(block, "caption"));
  return joinRichTextParts(
    [summary, nestedBlocks, itemText, cellText, caption],
    "\n",
  );
}

function extractBaleRichMessageBlocksText(blocks: unknown): string {
  if (!Array.isArray(blocks)) return "";
  return joinRichTextParts(blocks.map(extractBaleRichBlockText), "\n\n");
}

function extractBaleRichMessageText(
  richMessage: BaleRichMessage | undefined,
): string {
  return extractBaleRichMessageBlocksText(richMessage?.blocks);
}

export function extractBaleMessageText(
  message: BaleMediaMessage,
): string {
  return (
    extractBaleRichMessageText(message.rich_message) ||
    message.text ||
    message.caption ||
    ""
  ).trim();
}

function truncateBaleReplyContextText(text: string): string {
  if (text.length <= BALE_REPLY_CONTEXT_MAX_LENGTH) return text;
  return `${text.slice(0, BALE_REPLY_CONTEXT_MAX_LENGTH).trimEnd()}…`;
}

function formatBaleUser(
  user: BaleMessageUser | undefined,
): string | undefined {
  if (!user) return undefined;
  if (user.username) return user.username;
  if (typeof user.id === "number") return String(user.id);
  const name = [user.first_name, user.last_name]
    .filter(Boolean)
    .join(" ")
    .trim();
  return name || undefined;
}

function formatBaleForwardOriginIdentifier(
  message: BaleMediaMessage,
): string | undefined {
  const origin = message.forward_origin;
  const user = origin?.sender_user ?? message.forward_from;
  if (user?.username) return user.username;
  if (typeof user?.id === "number") return String(user.id);
  const chat = origin?.sender_chat ?? origin?.chat;
  if (chat?.username) return chat.username;
  if (typeof chat?.id === "number") return String(chat.id);
  return origin?.sender_user_name ?? message.forward_sender_name;
}

export function extractBaleForwardContextText(
  message: BaleMediaMessage,
  allowedUserId?: number,
): string {
  const originUser =
    message.forward_origin?.sender_user ?? message.forward_from;
  const isOwnerOrigin =
    typeof allowedUserId === "number" && originUser?.id === allowedUserId;
  const origin = formatBaleForwardOriginIdentifier(message);
  if (!origin || isOwnerOrigin) return "";
  return `from: ${origin}`;
}

function extractBaleReplyContextText(
  message: BaleMediaMessage,
): string {
  const quoted = (
    extractBaleRichMessageText(message.reply_to_message?.rich_message) ||
    message.reply_to_message?.text ||
    message.reply_to_message?.caption ||
    ""
  ).trim();
  return quoted ? truncateBaleReplyContextText(quoted) : "";
}

export function buildBaleReplyContextBlock(
  message: BaleMediaMessage,
  replyFiles: Pick<DownloadedBaleFile, "path">[] = [],
  replyOutputs: readonly string[] = [],
): string {
  const from = formatBaleUser(message.reply_to_message?.from);
  const header = from ? `[reply|from:${from}]` : "[reply]";
  const text = extractBaleReplyContextText(message);
  const dirs = [...new Set(replyFiles.map((file) => dirname(file.path)))];
  const sameDir = dirs.length === 1;
  const attachmentHeader = sameDir
    ? `[attachments${from ? `|from:${from}` : ""}] ${dirs[0]}`
    : `[attachments${from ? `|from:${from}` : ""}]`;
  const fileLines = sameDir
    ? replyFiles.map((file) => `- /${basename(file.path)}`)
    : replyFiles.map((file) => `- ${file.path}`);
  const replyBlock = text ? `${header} ${text}` : header;
  const sections = [replyBlock];
  if (fileLines.length > 0) {
    sections.push(`${attachmentHeader}\n${fileLines.join("\n")}`);
  }
  if (replyOutputs.length > 0) {
    const outputHeader = `[outputs${from ? `|from:${from}` : ""}]`;
    sections.push(
      `${outputHeader}\n${replyOutputs.map((output) => `- ${output}`).join("\n")}`,
    );
  }
  if (text || fileLines.length > 0 || replyOutputs.length > 0) {
    return sections.join("\n\n");
  }
  return "";
}

function appendBaleReplyContext(
  text: string,
  replyContext: string,
): string {
  if (!replyContext) return text;
  return text ? `${text}\n\n${replyContext}` : `_\n\n${replyContext}`;
}

export function extractBaleMessagesText(
  messages: BaleMediaMessage[],
): string {
  return messages.map(extractBaleMessageText).filter(Boolean).join("\n\n");
}

export function extractBaleMessagesPromptText(
  messages: BaleMediaMessage[],
): string {
  const text = extractBaleMessagesText(messages);
  const firstMessage = messages[0];
  if (!firstMessage) return text;
  return appendBaleReplyContext(
    text,
    buildBaleReplyContextBlock(firstMessage),
  );
}

export function extractFirstBaleMessageText(
  messages: BaleMediaMessage[],
): string {
  return messages.map(extractBaleMessageText).find(Boolean) ?? "";
}

function hasBaleMessagePromptContent(
  message: BaleMediaMessage,
): boolean {
  return (
    !!extractBaleMessageText(message) ||
    (Array.isArray(message.photo) && message.photo.length > 0) ||
    !!message.document ||
    !!message.video ||
    !!message.audio ||
    !!message.voice ||
    !!message.animation ||
    !!message.sticker
  );
}

export function hasBaleMessagesPromptContent(
  messages: BaleMediaMessage[],
): boolean {
  return messages.some(hasBaleMessagePromptContent);
}

export function collectBaleMessageIds(
  messages: BaleMediaMessage[],
): number[] {
  return [...new Set(messages.map((message) => message.message_id))];
}

export function getBaleMediaGroupKey(
  message: BaleMediaGroupMessage,
): string | undefined {
  if (!message.media_group_id) return undefined;
  const threadKey =
    typeof message.message_thread_id === "number"
      ? `thread:${message.message_thread_id}`
      : "private";
  return `${message.chat.id}:${threadKey}:${message.media_group_id}`;
}

/** One pending input group; only `transitionBalePendingGroups` produces a new one. */
export interface BalePendingGroup<TMessage, TContext, TMeta = undefined> {
  readonly messages: readonly TMessage[];
  readonly context?: TContext;
  /** Domain data carried with the group, such as a text group's forward-comment pairing side. */
  readonly meta?: TMeta;
  readonly timerId: number | null;
  /** The batch in flight; its messages leave the group only once that exact dispatch succeeds. */
  readonly dispatch: {
    readonly id: number;
    readonly messageIds: readonly number[];
  } | null;
  readonly suspended: boolean;
  /** The next batch ends at this message, so later messages wait for the batch after it, whatever is in flight. */
  readonly boundaryId?: number;
}

export interface BalePendingGroupsState<TMessage, TContext, TMeta> {
  readonly groups: ReadonlyMap<
    string,
    BalePendingGroup<TMessage, TContext, TMeta>
  >;
  readonly nextTimerId: number;
  readonly nextDispatchId: number;
}

export interface BalePendingGroupsConfig {
  debounceMs: number;
  /** A group without a context waits (text) instead of dispatching without one (media). */
  requireContext: boolean;
}

export type BalePendingGroupsEvent<TMessage, TContext, TMeta> =
  | {
      type: "queued";
      key: string;
      message: TMessage;
      context?: TContext;
      meta?: TMeta;
      delayMs: number;
      /** `always` restarts the debounce; `ifIdle` arms it only when no timer, dispatch or suspension holds it. */
      rearm: "always" | "ifIdle";
    }
  /** Ends the next batch at the group's current last message; later messages wait for the batch after it. */
  | { type: "batchClosed"; key: string }
  | { type: "timerFired"; key: string; timerId: number }
  | { type: "dispatchSettled"; key: string; dispatchId: number; ok: boolean }
  | { type: "flushRequested"; key: string }
  | { type: "suspended" }
  | { type: "resumed"; context: TContext }
  | { type: "removed"; messageIds: readonly number[] }
  | { type: "keyCleared"; key: string }
  | { type: "cleared" };

export type BalePendingGroupsEffect<TMessage, TContext> =
  | { type: "armTimer"; key: string; timerId: number; delayMs: number }
  | { type: "cancelTimer"; timerId: number }
  | {
      type: "dispatch";
      key: string;
      dispatchId: number;
      messages: TMessage[];
      context?: TContext;
    };

export interface BalePendingGroupsStep<
  TMessage,
  TContext,
  TMeta,
> extends Machine.BaleMachineStep<
  BalePendingGroupsState<TMessage, TContext, TMeta>,
  BalePendingGroupsEffect<TMessage, TContext>
> {
  /** `removed`: how many groups were dropped. */
  result: number;
}

export function createBalePendingGroupsState<
  TMessage,
  TContext,
  TMeta = undefined,
>(): BalePendingGroupsState<TMessage, TContext, TMeta> {
  return { groups: new Map(), nextTimerId: 0, nextDispatchId: 0 };
}

/**
 * Pure transition for delayed input groups shared by media albums and split text. A group dispatches one batch at a
 * time; messages that arrive meanwhile wait for the next batch, a failure keeps the batch for a retry, and suspension
 * keeps every admitted message for the replacement context.
 */
export function transitionBalePendingGroups<
  TMessage extends { message_id: number },
  TContext,
  TMeta,
>(
  state: BalePendingGroupsState<TMessage, TContext, TMeta>,
  event: BalePendingGroupsEvent<TMessage, TContext, TMeta>,
  config: BalePendingGroupsConfig,
): BalePendingGroupsStep<TMessage, TContext, TMeta> {
  type Group = BalePendingGroup<TMessage, TContext, TMeta>;
  type Effect = BalePendingGroupsEffect<TMessage, TContext>;
  const groups = new Map(state.groups);
  const effects: Effect[] = [];
  let { nextTimerId, nextDispatchId } = state;
  let result = 0;
  const cancelTimer = (group: Group): Group => {
    if (group.timerId === null) return group;
    effects.push({ type: "cancelTimer", timerId: group.timerId });
    return { ...group, timerId: null };
  };
  const armTimer = (key: string, group: Group, delayMs: number): Group => {
    if (group.suspended) return group;
    nextTimerId += 1;
    effects.push({ type: "armTimer", key, timerId: nextTimerId, delayMs });
    return { ...group, timerId: nextTimerId };
  };
  const startDispatch = (key: string, group: Group): Group => {
    if (group.dispatch) return group;
    if (config.requireContext && group.context === undefined) return group;
    const boundary =
      group.boundaryId === undefined
        ? -1
        : group.messages.findIndex(
            (message) => message.message_id === group.boundaryId,
          );
    const batch =
      boundary < 0
        ? [...group.messages]
        : group.messages.slice(0, boundary + 1);
    nextDispatchId += 1;
    effects.push({
      type: "dispatch",
      key,
      dispatchId: nextDispatchId,
      messages: batch,
      ...(group.context === undefined ? {} : { context: group.context }),
    });
    const { boundaryId: _consumed, ...rest } = group;
    return {
      ...rest,
      dispatch: {
        id: nextDispatchId,
        messageIds: batch.map((message) => message.message_id),
      },
    };
  };
  const drop = (key: string, group: Group): void => {
    cancelTimer(group);
    groups.delete(key);
  };
  switch (event.type) {
    case "queued": {
      let group: Group = groups.get(event.key) ?? {
        messages: [],
        timerId: null,
        dispatch: null,
        suspended: false,
      };
      const duplicate = group.messages.findIndex(
        (message) => message.message_id === event.message.message_id,
      );
      group = {
        ...group,
        messages:
          duplicate < 0
            ? [...group.messages, event.message]
            : group.messages.map((message, index) =>
                index === duplicate ? event.message : message,
              ),
        context: event.context,
        meta: event.meta,
      };
      const held =
        group.suspended || group.dispatch !== null || group.timerId !== null;
      if (event.rearm === "always" || !held)
        group = armTimer(event.key, cancelTimer(group), event.delayMs);
      groups.set(event.key, group);
      break;
    }
    case "batchClosed": {
      const group = groups.get(event.key);
      const last = group?.messages.at(-1);
      if (group && last)
        groups.set(event.key, { ...group, boundaryId: last.message_id });
      break;
    }
    case "timerFired": {
      const group = groups.get(event.key);
      if (!group || group.timerId !== event.timerId) break;
      groups.set(
        event.key,
        startDispatch(event.key, { ...group, timerId: null }),
      );
      break;
    }
    case "dispatchSettled": {
      const group = groups.get(event.key);
      if (!group || group.dispatch?.id !== event.dispatchId) break;
      const sent = new Set(group.dispatch.messageIds);
      const remaining = event.ok
        ? group.messages.filter((message) => !sent.has(message.message_id))
        : group.messages;
      if (remaining.length === 0) {
        drop(event.key, group);
        break;
      }
      const settled: Group = { ...group, messages: remaining, dispatch: null };
      groups.set(
        event.key,
        settled.timerId === null
          ? armTimer(event.key, settled, config.debounceMs)
          : settled,
      );
      break;
    }
    case "flushRequested": {
      const group = groups.get(event.key);
      if (!group) break;
      groups.set(event.key, startDispatch(event.key, cancelTimer(group)));
      break;
    }
    case "suspended":
      for (const [key, group] of groups)
        groups.set(key, { ...cancelTimer(group), suspended: true });
      break;
    case "resumed":
      for (const [key, group] of groups) {
        const resumed: Group = {
          ...group,
          context: event.context,
          suspended: false,
        };
        groups.set(
          key,
          resumed.dispatch === null && resumed.timerId === null
            ? armTimer(key, resumed, config.debounceMs)
            : resumed,
        );
      }
      break;
    case "removed": {
      const removed = new Set(event.messageIds);
      for (const [key, group] of groups) {
        if (!group.messages.some((message) => removed.has(message.message_id)))
          continue;
        drop(key, group);
        result += 1;
      }
      break;
    }
    case "keyCleared": {
      const group = groups.get(event.key);
      if (group) drop(event.key, group);
      break;
    }
    case "cleared":
      for (const [key, group] of groups) drop(key, group);
      break;
  }
  return { state: { groups, nextTimerId, nextDispatchId }, effects, result };
}

export interface BalePendingGroups<TMessage, TContext, TMeta> {
  /** Read-only view of one group; it never grants mutation. */
  get: (
    key: string,
  ) => BalePendingGroup<TMessage, TContext, TMeta> | undefined;
  queue: (
    event: Omit<
      Extract<
        BalePendingGroupsEvent<TMessage, TContext, TMeta>,
        { type: "queued" }
      >,
      "type"
    > & {
      dispatchMessages: (
        messages: TMessage[],
        ctx?: TContext,
      ) => unknown | Promise<unknown>;
    },
  ) => void;
  clearKey: (key: string) => void;
  closeBatch: (key: string) => void;
  removeMessages: (messageIds: number[]) => number;
  /** Dispatches the group holding this message now; resolves once its batch settles, rejecting if it failed. */
  flushMessage: (messageId: number) => Promise<boolean>;
  suspend: () => void;
  resume: (context: TContext) => void;
  clear: () => void;
}

/**
 * The shell around `transitionBalePendingGroups`: it owns timer handles and each key's latest dispatcher, turns
 * every dispatch outcome, including a synchronous throw, into `dispatchSettled`, and keeps each batch's promise for
 * flush callers.
 */
export function createBalePendingGroups<
  TMessage extends { message_id: number },
  TContext,
  TMeta = undefined,
>(options: {
  debounceMs: number;
  requireContext: boolean;
  setTimer: (callback: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer: (timer: ReturnType<typeof setTimeout>) => void;
}): BalePendingGroups<TMessage, TContext, TMeta> {
  const config: BalePendingGroupsConfig = {
    debounceMs: options.debounceMs,
    requireContext: options.requireContext,
  };
  const timers = new Map<number, ReturnType<typeof setTimeout>>();
  const dispatchers = new Map<
    string,
    (messages: TMessage[], ctx?: TContext) => unknown | Promise<unknown>
  >();
  const batches = new Map<number, Promise<void>>();
  const machine = Machine.createBaleMachineRunner<
    BalePendingGroupsState<TMessage, TContext, TMeta>,
    BalePendingGroupsEvent<TMessage, TContext, TMeta>,
    BalePendingGroupsEffect<TMessage, TContext>,
    BalePendingGroupsStep<TMessage, TContext, TMeta>
  >({
    initial: createBalePendingGroupsState<TMessage, TContext, TMeta>(),
    transition: (state, event) =>
      transitionBalePendingGroups(state, event, config),
    run(effect) {
      switch (effect.type) {
        case "armTimer": {
          const timer = options.setTimer(() => {
            timers.delete(effect.timerId);
            machine.dispatch({
              type: "timerFired",
              key: effect.key,
              timerId: effect.timerId,
            });
          }, effect.delayMs);
          timer.unref?.();
          timers.set(effect.timerId, timer);
          return;
        }
        case "cancelTimer": {
          const timer = timers.get(effect.timerId);
          timers.delete(effect.timerId);
          if (timer !== undefined) options.clearTimer(timer);
          return;
        }
        case "dispatch": {
          const settle = (ok: boolean): void => {
            batches.delete(effect.dispatchId);
            machine.dispatch({
              type: "dispatchSettled",
              key: effect.key,
              dispatchId: effect.dispatchId,
              ok,
            });
          };
          let outcome: unknown;
          try {
            // Synchronous on purpose: a fired timer hands its batch to admission in the same turn.
            outcome = dispatchers.get(effect.key)?.(
              effect.messages,
              effect.context,
            );
          } catch (error) {
            outcome = Promise.reject(error);
          }
          const batch = Promise.resolve(outcome).then(
            () => settle(true),
            (error: unknown) => {
              settle(false);
              throw error;
            },
          );
          batch.catch(() => undefined);
          batches.set(effect.dispatchId, batch);
          return;
        }
      }
    },
  });
  const dispatch = (
    event: BalePendingGroupsEvent<TMessage, TContext, TMeta>,
  ): number => {
    const step = machine.dispatch(event);
    for (const key of dispatchers.keys())
      if (!machine.state.groups.has(key)) dispatchers.delete(key);
    return step.result;
  };
  const keyOf = (messageId: number): string | undefined => {
    for (const [key, group] of machine.state.groups)
      if (group.messages.some((message) => message.message_id === messageId))
        return key;
    return undefined;
  };
  const awaitBatch = async (key: string): Promise<void> => {
    const id = machine.state.groups.get(key)?.dispatch?.id;
    if (id !== undefined) await batches.get(id);
  };
  return {
    get: (key) => machine.state.groups.get(key),
    queue({ dispatchMessages, ...event }) {
      dispatchers.set(event.key, dispatchMessages);
      dispatch({ type: "queued", ...event });
    },
    clearKey: (key) => {
      dispatch({ type: "keyCleared", key });
    },
    closeBatch: (key) => {
      dispatch({ type: "batchClosed", key });
    },
    removeMessages: (messageIds) => dispatch({ type: "removed", messageIds }),
    async flushMessage(messageId) {
      const key = keyOf(messageId);
      if (key === undefined) return false;
      dispatch({ type: "flushRequested", key });
      await awaitBatch(key);
      // The batch in flight may have predated this message; send what is left once it settles.
      if (
        keyOf(messageId) === key &&
        !machine.state.groups.get(key)?.dispatch
      ) {
        dispatch({ type: "flushRequested", key });
        await awaitBatch(key);
      }
      return true;
    },
    suspend: () => {
      dispatch({ type: "suspended" });
    },
    resume: (context) => {
      dispatch({ type: "resumed", context });
    },
    clear: () => {
      dispatch({ type: "cleared" });
    },
  };
}

export function createBaleMediaGroupController<
  TMessage extends BaleMediaGroupMessage,
  TContext = unknown,
>(
  options: BaleMediaGroupControllerOptions = {},
): BaleMediaGroupController<TMessage, TContext> {
  const debounceMs = options.debounceMs ?? BALE_MEDIA_GROUP_DEBOUNCE_MS;
  const groups = createBalePendingGroups<TMessage, TContext>({
    debounceMs,
    requireContext: false,
    setTimer:
      options.setTimer ??
      ((callback: () => void, ms: number): ReturnType<typeof setTimeout> =>
        setTimeout(callback, ms)),
    clearTimer: options.clearTimer ?? clearTimeout,
  });
  return {
    queueMessage: ({ message, context, dispatchMessages }) => {
      const key = getBaleMediaGroupKey(message);
      if (!key) return false;
      groups.queue({
        key,
        message,
        ...(context === undefined ? {} : { context }),
        delayMs: debounceMs,
        rearm: "always",
        dispatchMessages,
      });
      return true;
    },
    removeMessages: groups.removeMessages,
    flushMessage: groups.flushMessage,
    suspend: groups.suspend,
    resume: groups.resume,
    clear: groups.clear,
  };
}

export function createBaleMediaGroupDispatchRuntime<
  TMessage extends BaleMediaGroupMessage,
  TContext,
>(
  deps: BaleMediaGroupDispatchRuntimeDeps<TMessage, TContext>,
): BaleMediaGroupDispatchRuntime<TMessage, TContext> {
  return {
    handleMessage: async (message, ctx) => {
      const queuedMediaGroup = deps.mediaGroups.queueMessage({
        message,
        context: ctx,
        dispatchMessages: (messages, queuedCtx) =>
          queuedCtx === undefined
            ? Promise.resolve()
            : deps.dispatchMessages(messages, queuedCtx),
      });
      if (queuedMediaGroup) {
        deps.onDeferredMessage?.(message);
        return;
      }
      await deps.dispatchMessages([message], ctx);
    },
  };
}

/** Pure `[title]` bullet section appended after a blank line; empty items leave text unchanged. */
export function appendBaleListSection(
  text: string,
  title: string,
  items: string[],
): string {
  if (items.length === 0) return text;
  const prefix = text.length > 0 ? `${text}\n\n` : "";
  return `${prefix}[${title}]\n${items.map((item) => `- ${item}`).join("\n")}`;
}

export function appendBaleAttachmentSection(
  text: string,
  files: Pick<DownloadedBaleFile, "path">[],
): string {
  if (files.length === 0) return text;
  const dirs = [...new Set(files.map((file) => dirname(file.path)))];
  const sameDir = dirs.length === 1;
  const header = sameDir ? `[attachments] ${dirs[0]}` : "[attachments]";
  const items = sameDir
    ? files.map((file) => `/${basename(file.path)}`)
    : files.map((file) => file.path);
  const prefix = text.length > 0 ? `${text}\n\n` : "";
  return `${prefix}${header}\n${items.map((item) => `- ${item}`).join("\n")}`;
}

export function formatBaleHistoryText(
  rawText: string,
  files: DownloadedBaleFile[],
  handlerOutputs: string[] = [],
): string {
  let summary = rawText.length > 0 ? rawText : "(no text)";
  summary = appendBaleAttachmentSection(summary, files);
  summary = appendBaleListSection(summary, "outputs", handlerOutputs);
  return summary;
}

export async function downloadBaleMessageFiles(
  messages: BaleMediaMessage[],
  deps: DownloadBaleMessageFilesDeps,
): Promise<DownloadedBaleMessageFile[]> {
  const downloaded: DownloadedBaleMessageFile[] = [];
  for (const file of collectBaleFileInfos(messages)) {
    downloaded.push({
      path: await deps.downloadFile(file.file_id, file.fileName, file.source),
      fileName: file.fileName,
      isImage: file.isImage,
      mimeType: file.mimeType,
      kind: file.kind,
    });
  }
  return downloaded;
}

function collectBaleRichBlockFileInfos(
  blocks: unknown,
  messageId: number,
): BaleFileInfo[] {
  if (!Array.isArray(blocks)) return [];
  const files: BaleFileInfo[] = [];
  let mediaIndex = 0;
  const visit = (entries: unknown): void => {
    if (!Array.isArray(entries)) return;
    for (const entry of entries) {
      if (typeof entry !== "object" || entry === null) continue;
      const type = getObjectField(entry, "type");
      if (
        type === "photo" ||
        type === "animation" ||
        type === "audio" ||
        type === "video" ||
        type === "voice_note"
      ) {
        mediaIndex += 1;
      }
      if (type === "photo") {
        const photos = getObjectField(entry, "photo");
        if (Array.isArray(photos)) {
          const photo = photos
            .filter(
              (value): value is BalePhotoSize =>
                typeof value === "object" &&
                value !== null &&
                typeof getObjectField(value, "file_id") === "string",
            )
            .sort((a, b) => (a.file_size ?? 0) - (b.file_size ?? 0))
            .at(-1);
          if (photo) {
            files.push({
              file_id: photo.file_id,
              fileName: `photo-${messageId}-${mediaIndex}.jpg`,
              index: mediaIndex,
              mimeType: "image/jpeg",
              kind: "photo",
              isImage: true,
            });
          }
        }
      }
      const fileField =
        type === "animation"
          ? "animation"
          : type === "audio"
            ? "audio"
            : type === "video"
              ? "video"
              : type === "voice_note"
                ? "voice_note"
                : undefined;
      if (fileField) {
        const media = getObjectField(entry, fileField);
        const fileId = getObjectField(media, "file_id");
        const mimeType = getObjectField(media, "mime_type");
        const fileName = getObjectField(media, "file_name");
        if (typeof fileId === "string") {
          const kind =
            type === "voice_note" ? "voice" : (type as BaleAttachmentKind);
          const fallbackExtension =
            kind === "voice" ? ".ogg" : kind === "audio" ? ".mp3" : ".mp4";
          files.push({
            file_id: fileId,
            index: mediaIndex,
            ...(typeof fileName === "string" ? { userFileName: fileName } : {}),
            fileName:
              typeof fileName === "string"
                ? fileName
                : `${kind}-${messageId}-${mediaIndex}${guessExtensionFromMime(
                    typeof mimeType === "string" ? mimeType : undefined,
                    fallbackExtension,
                  )}`,
            mimeType: typeof mimeType === "string" ? mimeType : undefined,
            kind,
            isImage: false,
          });
        }
      }
      visit(getObjectField(entry, "blocks"));
      const items = getObjectField(entry, "items");
      if (Array.isArray(items)) {
        for (const item of items) visit(getObjectField(item, "blocks"));
      }
    }
  };
  visit(blocks);
  return files;
}

export function collectBaleFileInfos(
  messages: BaleMediaMessage[],
): BaleFileInfo[] {
  const files: BaleFileInfo[] = [];
  for (const message of messages) {
    const firstOfMessage = files.length;
    files.push(
      ...collectBaleRichBlockFileInfos(
        message.rich_message?.blocks,
        message.message_id,
      ),
    );
    if (Array.isArray(message.photo) && message.photo.length > 0) {
      const photo = [...message.photo]
        .sort((a, b) => (a.file_size ?? 0) - (b.file_size ?? 0))
        .pop();
      if (photo) {
        files.push({
          file_id: photo.file_id,
          fileName: `photo-${message.message_id}.jpg`,
          mimeType: "image/jpeg",
          kind: "photo",
          isImage: true,
        });
      }
    }
    if (message.document) {
      const fileName =
        message.document.file_name ||
        `document-${message.message_id}${guessExtensionFromMime(
          message.document.mime_type,
          "",
        )}`;
      files.push({
        file_id: message.document.file_id,
        fileName,
        ...(message.document.file_name
          ? { userFileName: message.document.file_name }
          : {}),
        mimeType: message.document.mime_type,
        kind: "document",
        isImage: isImageMimeType(message.document.mime_type),
      });
    }
    if (message.video) {
      const fileName =
        message.video.file_name ||
        `video-${message.message_id}${guessExtensionFromMime(
          message.video.mime_type,
          ".mp4",
        )}`;
      files.push({
        file_id: message.video.file_id,
        fileName,
        ...(message.video.file_name
          ? { userFileName: message.video.file_name }
          : {}),
        mimeType: message.video.mime_type,
        kind: "video",
        isImage: false,
      });
    }
    // Generic audio files (e.g. MP3 uploads) — can also trigger voice replies in "mirror" mode
    if (message.audio) {
      const fileName =
        message.audio.file_name ||
        `audio-${message.message_id}${guessExtensionFromMime(
          message.audio.mime_type,
          ".mp3",
        )}`;
      files.push({
        file_id: message.audio.file_id,
        fileName,
        ...(message.audio.file_name
          ? { userFileName: message.audio.file_name }
          : {}),
        mimeType: message.audio.mime_type,
        kind: "audio",
        isImage: false,
      });
    }

    // Voice messages (recorded via microphone) — primary trigger for "mirror" voice reply mode
    if (message.voice) {
      files.push({
        file_id: message.voice.file_id,
        fileName: `voice-${message.message_id}${guessExtensionFromMime(
          message.voice.mime_type,
          ".ogg",
        )}`,
        mimeType: message.voice.mime_type,
        kind: "voice",
        isImage: false,
      });
    }
    if (message.animation) {
      const fileName =
        message.animation.file_name ||
        `animation-${message.message_id}${guessExtensionFromMime(
          message.animation.mime_type,
          ".mp4",
        )}`;
      files.push({
        file_id: message.animation.file_id,
        fileName,
        ...(message.animation.file_name
          ? { userFileName: message.animation.file_name }
          : {}),
        mimeType: message.animation.mime_type,
        kind: "animation",
        isImage: false,
      });
    }
    if (message.sticker) {
      // Sticker format is defined by Bot API flags, not a documented MIME field.
      const video = message.sticker.is_video === true;
      const animated = message.sticker.is_animated === true;
      const extension = video ? ".webm" : animated ? ".tgs" : ".webp";
      files.push({
        file_id: message.sticker.file_id,
        fileName: `sticker-${message.message_id}${extension}`,
        mimeType: video
          ? "video/webm"
          : animated
            ? "application/x-tgsticker"
            : "image/webp",
        kind: "sticker",
        isImage: !video && !animated,
      });
    }
    for (const file of files.slice(firstOfMessage)) {
      file.source = {
        kind: file.kind,
        messageId: message.message_id,
        ...(file.index !== undefined ? { index: file.index } : {}),
        ...(file.userFileName ? { userFileName: file.userFileName } : {}),
        ...(message.chat ? { chat: message.chat } : {}),
      };
    }
  }
  const seenFileIds = new Set<string>();
  return files.filter((file) => {
    if (seenFileIds.has(file.file_id)) return false;
    seenFileIds.add(file.file_id);
    return true;
  });
}

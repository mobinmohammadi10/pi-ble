/**
 * Bale API transport helpers
 * Zones: bale transport, filesystem, runtime diagnostics
 *
 * Wraps bot API calls, file uploads/downloads (including voice messages),
 * multipart sending, runtime transport binding, and Bale temp-file lifecycle.
 */

import { randomUUID } from "node:crypto";
import { createWriteStream, openAsBlob } from "node:fs";
import {
  mkdir,
  readdir,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { request as requestHttps } from "node:https";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

import type { BaleAttachmentSource } from "./media.ts";
import { resolveBaleAttachmentsDir } from "./paths.ts";

const BALE_API_BASE = "https://tapi.bale.ai";

export const BALE_FILE_MAX_BYTES = 50 * 1024 * 1024;

/** Bale documents classic chats and Markdown, not private topics or Rich Messages. */
export function prepareBaleRequest(method: string, input: Record<string, unknown>): {
  method: string;
  body: Record<string, unknown>;
} {
  const supported = new Set([
    "getMe", "getUpdates", "deleteWebhook", "getWebhookInfo", "getFile",
    "sendMessage", "sendRichMessage", "sendPhoto", "sendAudio", "sendDocument",
    "sendVideo", "sendAnimation", "sendVoice", "sendMediaGroup", "sendChatAction",
    "answerCallbackQuery", "editMessageText", "editMessageCaption",
    "editMessageReplyMarkup", "deleteMessage", "getChat", "forwardMessage", "copyMessage",
  ]);
  if (!supported.has(method) || input.message_thread_id !== undefined) {
    throw new Error(`Bale does not support ${method}${input.message_thread_id !== undefined ? " with a Thread target" : ""}`);
  }
  const body = { ...input };
  if (body.rich_message !== undefined) {
    const rich = body.rich_message as BaleInputRichMessage;
    if (!rich || typeof rich !== "object" || rich.media?.length || (!rich.markdown && !rich.html)) {
      throw new Error("Bale does not support Rich blocks or embedded media; send text and attachments separately");
    }
    body.text = rich.markdown ?? baleHtmlToMarkdown(rich.html!);
    delete body.rich_message;
    if (method === "sendRichMessage") method = "sendMessage";
  } else {
    for (const key of ["text", "caption"]) {
      if (body.parse_mode === "HTML" && typeof body[key] === "string") {
        body[key] = baleHtmlToMarkdown(body[key]);
      }
    }
  }
  if (body.reply_parameters !== undefined) {
    const reply = typeof body.reply_parameters === "string"
      ? JSON.parse(body.reply_parameters) : body.reply_parameters;
    if (!reply || typeof reply !== "object" || !Number.isSafeInteger(reply.message_id)) {
      throw new Error("Invalid Bale reply target");
    }
    body.reply_to_message_id = reply.message_id;
    delete body.reply_parameters;
  }
  // ponytail: Bale's documented Markdown subset; richer formatting waits for a documented API.
  for (const key of ["parse_mode", "entities", "caption_entities", "link_preview_options", "disable_web_page_preview", "allowed_updates"]) delete body[key];
  return { method, body };
}

function baleHtmlToMarkdown(html: string): string {
  return html
    .replace(/<a\s+href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, "[$2]($1)")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/?(?:b|strong)>/gi, "**")
    .replace(/<\/?(?:i|em)>/gi, "__")
    .replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, (_, text: string) => "\n```\n" + text.replace(/<[^>]*>/g, "") + "\n```\n")
    .replace(/<\/?code[^>]*>/gi, "`")
    .replace(/<[^>]*>/g, "")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, "&");
}

/** First positive safe-integer byte limit among ordered env names, else the caller's default. */
export function getBaleByteLimitFromEnv(
  env: NodeJS.ProcessEnv,
  names: readonly string[],
  defaultValue: number,
): number {
  for (const name of names) {
    const rawValue = env[name]?.trim();
    if (!rawValue) continue;
    const parsed = Number(rawValue);
    if (Number.isSafeInteger(parsed) && parsed > 0) return parsed;
  }
  return defaultValue;
}

function getBaleApiTempDir(): string {
  return resolveBaleAttachmentsDir();
}
const BALE_TEMP_FILE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const BALE_DOWNLOAD_RENAME_MAX_ATTEMPTS = 6;
const activeBaleApiWorkspaceAdmissionOperationIds = new Set<string>();
const BALE_INBOUND_FILE_MAX_BYTES = getBaleByteLimitFromEnv(
  process.env,
  ["PI_BALE_INBOUND_FILE_MAX_BYTES", "BALE_MAX_FILE_SIZE_BYTES"],
  BALE_FILE_MAX_BYTES,
);

export type BaleNetworkFamilyPolicy =
  "auto" | "ipv4" | "ipv6" | "ipv4-fallback";

const BALE_NETWORK_FAMILY_ENV = "PI_BALE_NETWORK_FAMILY";
const BALE_NETWORK_FAMILY_VALUES = new Set<BaleNetworkFamilyPolicy>([
  "auto",
  "ipv4",
  "ipv6",
  "ipv4-fallback",
]);
type BaleNetworkFamily = 4 | 6;

export interface BaleUser {
  id: number;
  is_bot: boolean;
  first_name: string;
  username?: string;
}

export interface BaleChat {
  id: number;
  type: string;
}

export interface BalePhotoSize {
  file_id: string;
  file_size?: number;
}

export interface BaleDocument {
  file_id: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

export interface BaleVideo {
  file_id: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

export interface BaleAudio {
  file_id: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

export interface BaleVoice {
  file_id: string;
  mime_type?: string;
  file_size?: number;
}

export interface BaleAnimation {
  file_id: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

export interface BaleSticker {
  file_id: string;
  emoji?: string;
}

export interface BaleRichMessage {
  blocks?: unknown[];
  is_rtl?: boolean;
}

export interface BaleMessage {
  message_id: number;
  chat: BaleChat;
  from?: BaleUser;
  text?: string;
  caption?: string;
  rich_message?: BaleRichMessage;
  media_group_id?: string;
  photo?: BalePhotoSize[];
  document?: BaleDocument;
  video?: BaleVideo;
  audio?: BaleAudio;
  voice?: BaleVoice;
  animation?: BaleAnimation;
  sticker?: BaleSticker;
}

export interface BaleCallbackQuery {
  id: string;
  from: BaleUser;
  message?: BaleMessage;
  data?: string;
}

export interface BaleReactionTypeEmoji {
  type: "emoji";
  emoji: string;
}

export interface BaleReactionTypeCustomEmoji {
  type: "custom_emoji";
  custom_emoji_id: string;
}

export interface BaleReactionTypePaid {
  type: "paid";
}

export type BaleReactionType =
  | BaleReactionTypeEmoji
  | BaleReactionTypeCustomEmoji
  | BaleReactionTypePaid;

export interface BaleMessageReactionUpdated {
  chat: BaleChat;
  message_id: number;
  user?: BaleUser;
  actor_chat?: BaleChat;
  old_reaction: BaleReactionType[];
  new_reaction: BaleReactionType[];
  date: number;
}

export interface BaleGuestMessage {
  message_id: number;
  from?: BaleUser;
  chat: BaleChat;
  date: number;
  text?: string;
  caption?: string;
  rich_message?: BaleRichMessage;
  guest_query_id: string;
  guest_bot_caller_user?: BaleUser;
  guest_bot_caller_chat?: BaleChat;
  reply_to_message?: BaleMessage;
}

export interface BaleUpdate {
  update_id: number;
  message?: BaleMessage;
  edited_message?: BaleMessage;
  callback_query?: BaleCallbackQuery;
  message_reaction?: BaleMessageReactionUpdated;
  guest_message?: BaleGuestMessage;
  deleted_business_messages?: { message_ids?: unknown };
}

export interface BaleSentMessage {
  message_id: number;
}

export interface BaleSentGuestMessage {
  inline_message_id?: string;
}

export interface BaleReplyParameters {
  message_id: number;
  allow_sending_without_reply?: boolean;
  chat_id?: number;
  message_thread_id?: number;
}

export interface BaleLinkPreviewOptions {
  is_disabled?: boolean;
}

export type BaleSendMessageBody = Record<string, unknown> & {
  chat_id: number;
  text: string;
  parse_mode?: "HTML";
  link_preview_options?: BaleLinkPreviewOptions;
  reply_markup?: unknown;
  reply_parameters?: BaleReplyParameters;
};

export interface BaleInputMediaPhoto extends Record<string, unknown> {
  type: "photo";
  media: string;
  has_spoiler?: boolean;
}

export interface BaleInputMediaVideo extends Record<string, unknown> {
  type: "video";
  media: string;
  thumbnail?: string;
  width?: number;
  height?: number;
  duration?: number;
  supports_streaming?: boolean;
  has_spoiler?: boolean;
}

export interface BaleInputMediaAnimation extends Record<string, unknown> {
  type: "animation";
  media: string;
  thumbnail?: string;
  width?: number;
  height?: number;
  duration?: number;
  has_spoiler?: boolean;
}

export interface BaleInputMediaAudio extends Record<string, unknown> {
  type: "audio";
  media: string;
  thumbnail?: string;
  duration?: number;
  performer?: string;
  title?: string;
}

export interface BaleInputMediaVoiceNote extends Record<string, unknown> {
  type: "voice_note";
  media: string;
  caption?: string;
  parse_mode?: string;
  caption_entities?: unknown[];
  duration?: number;
}

export type BaleInputRichMessageMediaValue =
  | BaleInputMediaAnimation
  | BaleInputMediaAudio
  | BaleInputMediaPhoto
  | BaleInputMediaVideo
  | BaleInputMediaVoiceNote;

export interface BaleInputRichMessageMedia {
  id: string;
  media: BaleInputRichMessageMediaValue;
}

type BaleInputRichMessageCommon = {
  is_rtl?: boolean;
  skip_entity_detection?: boolean;
};

export type BaleRichText =
  | string
  | BaleRichText[]
  | { type: "bold" | "code"; text: BaleRichText };

export type BaleInputRichBlock =
  | { type: "heading"; text: BaleRichText; size?: 1 | 2 | 3 }
  | { type: "pre"; text: BaleRichText; language?: string }
  | {
      type: "details";
      summary: BaleRichText;
      blocks: BaleInputRichBlock[];
      is_open?: true;
    };

export type BaleInputRichDraftBlock =
  BaleInputRichBlock | { type: "thinking"; text: BaleRichText };

export type BaleInputRichMessage = BaleInputRichMessageCommon &
  (
    | {
        markdown: string;
        html?: never;
        blocks?: never;
        media?: BaleInputRichMessageMedia[];
      }
    | {
        html: string;
        markdown?: never;
        blocks?: never;
        media?: BaleInputRichMessageMedia[];
      }
    | {
        blocks: BaleInputRichBlock[];
        markdown?: never;
        html?: never;
        media?: never;
      }
  );

export type BaleSendRichMessageBody = Record<string, unknown> & {
  chat_id: number;
  rich_message: BaleInputRichMessage;
  reply_markup?: unknown;
  reply_parameters?: BaleReplyParameters;
};

export type BaleEditMessageTextBody = Record<string, unknown> & {
  chat_id: number;
  message_id: number;
  text?: string;
  rich_message?: BaleInputRichMessage;
  parse_mode?: "HTML";
  link_preview_options?: BaleLinkPreviewOptions;
  reply_markup?: unknown;
};

export type BaleSendMessageDraftBody = Record<string, unknown> & {
  chat_id: number;
  draft_id: number;
  text?: string;
  parse_mode?: string;
  entities?: unknown[];
  message_thread_id?: number;
};

export type BaleSendRichMessageDraftBody = Record<string, unknown> & {
  chat_id: number;
  draft_id: number;
  rich_message:
    | BaleInputRichMessage
    | (BaleInputRichMessageCommon & {
        blocks: BaleInputRichDraftBlock[];
        markdown?: never;
        html?: never;
        media?: never;
      });
  message_thread_id?: number;
};

interface BaleApiResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
  parameters?: { retry_after?: number };
}

export interface BaleApiRetryWait {
  method: string;
  delayMs: number;
  attempt: number;
  retryAfterSeconds?: number;
}

export interface BaleApiCallOptions {
  /** Local per-call effect authority; independent of source completion and transport ownership. */
  assertAuthority?: () => void;
  signal?: AbortSignal;
  maxAttempts?: number;
  retryRateLimit?: boolean;
  retrySafety?: "safe" | "non-idempotent";
  retryBaseDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Observability hook fired before a 429 retry wait, never for 5xx waits. */
  onRetryWait?: (wait: BaleApiRetryWait) => void;
  /** Caller-owned expected failure: still thrown, but the caller records the outcome instead of the API log. */
  isExpectedError?: (error: unknown) => boolean;
}

export class BaleApiAuthorityError extends Error {
  readonly requestIssued: boolean;
  constructor(requestIssued: boolean) {
    super("Bale API call authority is unavailable.");
    this.name = "BaleApiAuthorityError";
    this.requestIssued = requestIssued;
  }
}

/** Recheck caller authority, classifying refusal by whether a Bot API request was already issued. */
export function assertBaleApiCallAuthority(
  assertAuthority: (() => void) | undefined,
  requestIssued: boolean,
): void {
  try {
    assertAuthority?.();
  } catch {
    throw new BaleApiAuthorityError(requestIssued);
  }
}

interface BaleGetFileResult {
  file_path: string;
  file_size?: number;
}

export interface BaleFileDownloadOptions {
  signal?: AbortSignal;
  maxFileSizeBytes?: number;
}

export type BaleGuestCachedMediaResult =
  | {
      type: "document";
      id: string;
      title: string;
      document_file_id: string;
      caption?: string;
      parse_mode?: string;
    }
  | {
      type: "photo";
      id: string;
      photo_file_id: string;
      caption?: string;
      parse_mode?: string;
    }
  | {
      type: "audio";
      id: string;
      audio_file_id: string;
      caption?: string;
      parse_mode?: string;
    }
  | {
      type: "voice";
      id: string;
      voice_file_id: string;
      title: string;
      caption?: string;
      parse_mode?: string;
    };

export interface BaleAnswerGuestQueryOptions {
  parseMode?: string;
  richMessage?: BaleInputRichMessage;
  result?: BaleGuestCachedMediaResult;
}

export interface BaleEditGuestInlineMessageContent {
  /** Cached media only: inline edits cannot upload a new local file. */
  media?: { type: "photo" | "document" | "audio"; media: string; caption?: string };
  text?: string;
  richMessage?: BaleInputRichMessage;
  parseMode?: "HTML";
}

export interface BaleAnswerCallbackQueryOptions extends Pick<
  BaleApiCallOptions,
  "assertAuthority"
> {
  recordRuntimeEvent?: (
    kind: "api",
    error: unknown,
    details?: Record<string, unknown>,
  ) => void;
}

export interface BaleApiClient {
  call: <TResponse>(
    method: string,
    body: Record<string, unknown>,
    options?: BaleApiCallOptions,
  ) => Promise<TResponse>;
  callMultipart: <TResponse>(
    method: string,
    fields: Record<string, string>,
    fileField: string,
    filePath: string,
    fileName: string,
    options?: BaleApiCallOptions,
  ) => Promise<TResponse>;
  downloadFile: (
    fileId: string,
    suggestedName: string,
    tempDir: string,
    options?: BaleFileDownloadOptions,
  ) => Promise<string>;
  answerCallbackQuery: (
    callbackQueryId: string,
    text?: string,
    options?: Pick<BaleApiCallOptions, "assertAuthority">,
  ) => Promise<void>;
  answerGuestQuery?: (
    guestQueryId: string,
    text?: string,
    options?: BaleAnswerGuestQueryOptions,
  ) => Promise<void>;
}

export interface BaleApiTargetActivityRuntime {
  begin: (method: string, body: Record<string, unknown>) => () => void;
  hasPendingTarget: (target: { chatId: number; threadId?: number }) => boolean;
  listPendingTargets: () => { chatId: number; threadId: number }[];
  listPendingChats: () => number[];
}

function parseBaleApiTargetInteger(value: unknown): number | undefined {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^-?\d+$/u.test(value)
        ? Number(value)
        : undefined;
  return parsed !== undefined && Number.isSafeInteger(parsed)
    ? parsed
    : undefined;
}

/** Optional drain hints are not transport outcomes or request authority. */
function captureApiDrainObserver(capture?: () => (() => void) | undefined): () => void {
  try {
    const notify = capture?.();
    return () => {
      try {
        const emitted: unknown = notify?.();
        if (emitted) void Promise.resolve(emitted).catch(() => undefined);
      } catch { /* Observer failure is inert. */ }
    };
  } catch { return () => {}; }
}

export function createBaleApiTargetActivityRuntime(deps: {
  captureDrain?: () => (() => void) | undefined;
} = {}): BaleApiTargetActivityRuntime {
  const pending = new Map<
    string,
    {
      target: { chatId: number; threadId: number };
      count: number;
    }
  >();
  const pendingChats = new Map<number, number>();
  const messageScopedMethods = new Set([
    "deleteMessage",
    "editMessageCaption",
    "editMessageReplyMarkup",
    "editMessageText",
  ]);
  return {
    begin(method, body) {
      const chatId = parseBaleApiTargetInteger(body.chat_id);
      const threadId = parseBaleApiTargetInteger(body.message_thread_id);
      const messageId = parseBaleApiTargetInteger(body.message_id);
      const chatScoped =
        chatId !== undefined &&
        threadId === undefined &&
        messageId !== undefined &&
        messageScopedMethods.has(method);
      if (chatId === undefined || (threadId === undefined && !chatScoped)) {
        return () => undefined;
      }
      const key = threadId === undefined ? undefined : `${chatId}:${threadId}`;
      if (key) {
        const existing = pending.get(key);
        if (existing) existing.count += 1;
        else
          pending.set(key, {
            target: { chatId, threadId: threadId! },
            count: 1,
          });
      } else {
        pendingChats.set(chatId, (pendingChats.get(chatId) ?? 0) + 1);
      }
      const notifyDrained = captureApiDrainObserver(deps.captureDrain);
      let completed = false;
      return () => {
        if (completed) return;
        completed = true;
        if (!key) {
          const count = pendingChats.get(chatId);
          if (!count || count <= 1) { pendingChats.delete(chatId); notifyDrained(); }
          else pendingChats.set(chatId, count - 1);
          return;
        }
        const current = pending.get(key);
        if (!current || current.count <= 1) { pending.delete(key); notifyDrained(); }
        else current.count -= 1;
      };
    },
    hasPendingTarget(target) {
      return (
        pendingChats.has(target.chatId) ||
        (target.threadId !== undefined &&
          pending.has(`${target.chatId}:${target.threadId}`))
      );
    },
    listPendingTargets() {
      return Array.from(pending.values(), ({ target }) => ({ ...target }));
    },
    listPendingChats() {
      return Array.from(pendingChats.keys());
    },
  };
}

export function createBaleApiTargetTrackingClient(
  client: BaleApiClient,
  activity: BaleApiTargetActivityRuntime,
): BaleApiClient {
  const track = async <T>(
    method: string,
    body: Record<string, unknown>,
    operation: () => Promise<T>,
  ): Promise<T> => {
    const end = activity.begin(method, body);
    try {
      return await operation();
    } finally {
      end();
    }
  };
  return {
    call: (method, body, options) =>
      track(method, body, () => client.call(method, body, options)),
    callMultipart: (method, fields, fileField, filePath, fileName, options) =>
      track(method, fields, () =>
        client.callMultipart(
          method,
          fields,
          fileField,
          filePath,
          fileName,
          options,
        ),
      ),
    downloadFile: client.downloadFile,
    answerCallbackQuery: client.answerCallbackQuery,
    ...(client.answerGuestQuery
      ? { answerGuestQuery: client.answerGuestQuery }
      : {}),
  };
}

export type BaleApiWorkspaceAdmissionScopeLike =
  | { kind: "target"; target: { chatId: number; threadId: number } }
  | { kind: "chat"; chatId: number }
  | { kind: "profile" };

export interface BaleApiWorkspaceAdmissionLeaseLike {
  operationId: string;
  operationKind: string;
  profileKey: string;
  scope: BaleApiWorkspaceAdmissionScopeLike;
  owner: { processId: number; processBirthId: string };
  acquiredAtMs: number;
}

export interface BaleApiWorkspaceAdmissionPort {
  acquireAdmission: (input: {
    operationId: string;
    operationKind: string;
    scope: BaleApiWorkspaceAdmissionScopeLike;
  }) =>
    | {
        kind: "acquired";
        lease: BaleApiWorkspaceAdmissionLeaseLike;
        resumed: boolean;
      }
    | { kind: "blocked"; reason: "retirement-fenced" };
  releaseAdmission: (
    expected: BaleApiWorkspaceAdmissionLeaseLike,
  ) => boolean;
}

export class BaleApiWorkspaceAdmissionError extends Error {
  readonly code:
    "blocked" | "unavailable" | "release-lost" | "duplicate-operation";

  constructor(
    code: BaleApiWorkspaceAdmissionError["code"],
    message: string,
  ) {
    super(message);
    this.name = "BaleApiWorkspaceAdmissionError";
    this.code = code;
  }
}

export function getBaleApiWorkspaceAdmissionScope(
  body: Record<string, unknown>,
): BaleApiWorkspaceAdmissionScopeLike | undefined {
  if (!("chat_id" in body)) return undefined;
  const chatId = parseBaleApiTargetInteger(body.chat_id);
  if (chatId === undefined || chatId === 0) return { kind: "profile" };
  if (!("message_thread_id" in body) || body.message_thread_id === undefined) {
    return { kind: "chat", chatId };
  }
  const threadId = parseBaleApiTargetInteger(body.message_thread_id);
  if (threadId === undefined || threadId <= 0) return { kind: "profile" };
  return { kind: "target", target: { chatId, threadId } };
}

export function createBaleApiWorkspaceAdmissionClient(
  client: BaleApiClient,
  admission:
    | BaleApiWorkspaceAdmissionPort
    | (() => BaleApiWorkspaceAdmissionPort | undefined),
  options: {
    onReleaseError?: (error: unknown, method: string) => void;
    createOperationId?: () => string;
  } = {},
): BaleApiClient {
  const admit = async <T>(
    method: string,
    body: Record<string, unknown>,
    operation: () => Promise<T>,
  ): Promise<T> => {
    const scope = getBaleApiWorkspaceAdmissionScope(body);
    if (!scope) return operation();
    const currentAdmission =
      typeof admission === "function" ? admission() : admission;
    if (!currentAdmission) {
      throw new BaleApiWorkspaceAdmissionError(
        "unavailable",
        "Bale API Workspace admission authority is unavailable.",
      );
    }
    const operationId = `api:${(options.createOperationId ?? randomUUID)()}`;
    if (activeBaleApiWorkspaceAdmissionOperationIds.has(operationId)) {
      throw new BaleApiWorkspaceAdmissionError(
        "duplicate-operation",
        "Bale API Workspace admission operation is already active.",
      );
    }
    activeBaleApiWorkspaceAdmissionOperationIds.add(operationId);
    try {
      const acquired = currentAdmission.acquireAdmission({
        operationId,
        operationKind: `api.${method}`,
        scope,
      });
      if (acquired.kind === "blocked") {
        throw new BaleApiWorkspaceAdmissionError(
          "blocked",
          "Bale API target is temporarily unavailable during Workspace retirement.",
        );
      }
      try {
        return await operation();
      } finally {
        try {
          if (!currentAdmission.releaseAdmission(acquired.lease)) {
            throw new BaleApiWorkspaceAdmissionError(
              "release-lost",
              "Bale API Workspace admission lease disappeared before release.",
            );
          }
        } catch (error) {
          try {
            options.onReleaseError?.(error, method);
          } catch {
            // Diagnostics cannot convert an already-settled API request into replay.
          }
        }
      }
    } finally {
      activeBaleApiWorkspaceAdmissionOperationIds.delete(operationId);
    }
  };
  return {
    call: (method, body, callOptions) =>
      admit(method, body, () => client.call(method, body, callOptions)),
    callMultipart: (
      method,
      fields,
      fileField,
      filePath,
      fileName,
      callOptions,
    ) =>
      admit(method, fields, () =>
        client.callMultipart(
          method,
          fields,
          fileField,
          filePath,
          fileName,
          callOptions,
        ),
      ),
    downloadFile: client.downloadFile,
    answerCallbackQuery: client.answerCallbackQuery,
    ...(client.answerGuestQuery
      ? { answerGuestQuery: client.answerGuestQuery }
      : {}),
  };
}

export interface BaleBridgeApiRuntimeDeps {
  captureRequestErrorHandler?: (
    body: Record<string, unknown>,
  ) => ((error: unknown) => Promise<void>) | undefined;
  client: BaleApiClient;
  tempDir: string;
  maxFileSizeBytes: number;
  tempFileMaxAgeMs: number;
  /** Bot `@username` (or numeric id) naming private-chat attachments. */
  getBotScope?: () => string | undefined;
  recordRuntimeEvent: (
    kind: "api" | "multipart" | "download",
    error: unknown,
    details?: Record<string, unknown>,
  ) => void;
  now?: () => number;
  chatActionMinIntervalMs?: number;
  chatActionMaxGates?: number;
}

/** Typing issuance guard is local authority, never Bot API body or IPC data. */
export interface BaleTypingActionOptions extends Pick<BaleApiCallOptions, "assertAuthority"> {
  message_thread_id?: number;
}

export interface BaleBridgeApiRuntime extends Pick<
  BaleApiClient,
  "call" | "callMultipart"
> {
  downloadFile: (
    fileId: string,
    suggestedName: string,
    source?: BaleAttachmentSource,
  ) => Promise<string>;
  deleteWebhook: (signal?: AbortSignal) => Promise<boolean>;
  getUpdates: (
    body: Record<string, unknown>,
    signal?: AbortSignal,
  ) => Promise<BaleUpdate[]>;
  setMyCommands: (
    commands: readonly { command: string; description: string }[],
    options?: Pick<BaleApiCallOptions, "assertAuthority">,
  ) => Promise<boolean>;
  sendChatAction: (
    chatId: number,
    action: string,
    options?: { message_thread_id?: number },
  ) => Promise<boolean>;
  sendTypingAction: (
    chatId: number,
    options?: BaleTypingActionOptions,
  ) => Promise<unknown>;
  sendRecordVoiceAction: (
    chatId: number,
    options?: { message_thread_id?: number },
  ) => Promise<unknown>;
  sendMessageDraft: (
    chatId: number,
    draftId: number,
    text?: string,
    options?: {
      parse_mode?: string;
      entities?: unknown[];
      message_thread_id?: number;
    },
  ) => Promise<boolean>;
  sendMessage: (
    body: BaleSendMessageBody,
    options?: Pick<BaleApiCallOptions, "assertAuthority">,
  ) => Promise<BaleSentMessage>;
  sendRichMessage: (
    body: BaleSendRichMessageBody,
    options?: Pick<BaleApiCallOptions, "assertAuthority">,
  ) => Promise<BaleSentMessage>;
  sendRichMessageDraft: (
    body: BaleSendRichMessageDraftBody,
  ) => Promise<boolean>;
  editMessageText: (
    body: BaleEditMessageTextBody,
    options?: Pick<BaleApiCallOptions, "assertAuthority">,
  ) => Promise<"edited" | "unchanged">;
  editMessageReplyMarkup: (
    chatId: number,
    messageId: number,
    replyMarkup: unknown,
  ) => Promise<void>;
  answerCallbackQuery: (
    callbackQueryId: string,
    text?: string,
    options?: Pick<BaleApiCallOptions, "assertAuthority">,
  ) => Promise<void>;
  answerGuestQuery: (
    guestQueryId: string,
    text?: string,
    options?: BaleAnswerGuestQueryOptions,
  ) => Promise<void>;
  /**
   * Answers the guest query and retains the sent inline message id for final
   * text or cached-media replacement. Requires direct transport ownership;
   * actual guest-media rendering remains live-client gated.
   */
  answerGuestQueryForInlineMessage: (
    guestQueryId: string,
    text?: string,
    options?: BaleAnswerGuestQueryOptions,
  ) => Promise<string | undefined>;
  editGuestInlineMessage: (
    inlineMessageId: string,
    content: BaleEditGuestInlineMessageContent,
    options?: Pick<BaleApiCallOptions, "assertAuthority">,
  ) => Promise<void>;
  deleteMessage: (chatId: number, messageId: number) => Promise<void>;
  prepareTempDir: () => Promise<number>;
}

function sanitizeFileName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]+/g, "_");
}

/** Names follow `<kind>-<scope>-<messageId>[-<index>][-<name>|.<ext>]`. */
/**
 * `scope` is the bot `@username` (id fallback) in a private chat and the public chat `@username` (id fallback) elsewhere.
 * A negative chat id loses its sign, so the name never contains two adjacent dashes.
 */
export function createBaleAttachmentFileName(
  source: BaleAttachmentSource,
  generatedName: string,
  botScope?: string,
): string {
  const chat = source.chat;
  const clean = (value: string): string =>
    sanitizeFileName(value.replace(/^@/u, "")).replace(/^[-.]+/u, "");
  const scope = source.scope
    ? clean(source.scope)
    : chat?.type === "private" || !chat
      ? botScope
        ? clean(botScope)
        : chat
          ? String(Math.abs(chat.id))
          : ""
      : chat.username
        ? clean(chat.username)
        : String(Math.abs(chat.id));
  const dot = generatedName.lastIndexOf(".");
  const extension = dot > 0 ? sanitizeFileName(generatedName.slice(dot)) : "";
  const tail = source.userFileName
    ? `-${clean(source.userFileName)}`
    : extension;
  return (
    [sanitizeFileName(source.kind), scope, String(source.messageId)]
      .filter(Boolean)
      .join("-") +
    (source.index !== undefined ? `-${source.index}` : "") +
    tail
  );
}

class BaleApiMalformedSuccessError extends Error {
  constructor(method: string, detail: string) {
    super(`Bale API ${method} ${detail}`);
    this.name = "BaleApiMalformedSuccessError";
  }
}

export class BaleApiCommitUnknownError extends Error {
  readonly kind = "commit-unknown" as const;
  readonly method: string;
  override readonly cause: unknown;

  constructor(method: string, cause: unknown) {
    super(`Bale API ${method} may have committed before transport failed.`);
    this.name = "BaleApiCommitUnknownError";
    this.method = method;
    this.cause = cause;
  }
}

export function isBaleApiCommitUnknownError(
  error: unknown,
): error is BaleApiCommitUnknownError {
  return error instanceof BaleApiCommitUnknownError;
}

class BaleApiHttpError extends Error {
  readonly status: number | undefined;
  readonly retryAfterSeconds: number | undefined;
  readonly rejectedRequestMethod: string | undefined;
  requestTarget?: { chatId: number; threadId: number };
  constructor(
    message: string,
    status: number | undefined,
    retryAfterSeconds: number | undefined,
    rejectedRequestMethod?: string,
  ) {
    super(message);
    this.status = status;
    this.retryAfterSeconds = retryAfterSeconds;
    this.rejectedRequestMethod = rejectedRequestMethod;
  }
}

function attachBaleApiRequestTarget(
  error: unknown,
  body: Record<string, unknown> | Record<string, string>,
): void {
  if (!(error instanceof BaleApiHttpError)) return;
  const chatId = Number(body.chat_id);
  const threadId = Number(body.message_thread_id);
  if (!Number.isSafeInteger(chatId) || !Number.isSafeInteger(threadId)) return;
  error.requestTarget = { chatId, threadId };
}

export class BaleApiStaleTargetError extends Error {
  readonly requestTarget: { chatId: number; threadId: number };

  constructor(
    message: string,
    requestTarget: { chatId: number; threadId: number },
  ) {
    super(message);
    this.name = "BaleApiStaleTargetError";
    this.requestTarget = { ...requestTarget };
  }
}

/** A follower API refusal; legacy text alone does not prove the request was rejected before execution. */
export class BaleApiFollowerNotAllowedError extends Error {
  readonly requestTarget: { chatId: number; threadId: number } | undefined;
  /** Present only after a structured pre-execution refusal matches the requested API method. */
  readonly rejectedRequestMethod: string | undefined;

  constructor(
    message: string,
    requestTarget?: { chatId: number; threadId: number },
    rejectedRequestMethod?: string,
  ) {
    super(message);
    this.name = "BaleApiFollowerNotAllowedError";
    this.requestTarget = requestTarget ? { ...requestTarget } : undefined;
    this.rejectedRequestMethod = rejectedRequestMethod;
  }
}

export function getBaleApiErrorRequestTarget(
  error: unknown,
): { chatId: number; threadId: number } | undefined {
  const target =
    error instanceof BaleApiHttpError ||
    error instanceof BaleApiStaleTargetError
      ? error.requestTarget
      : undefined;
  return target ? { ...target } : undefined;
}

export function isBaleStaleTargetHttpError(error: unknown): boolean {
  if (!(error instanceof BaleApiHttpError) || error.status !== 400)
    return false;
  return /^Bale API \w+ failed: HTTP 400: Bad Request: (message thread not found|thread not found|topic not found|topic deleted|topic closed|thread closed|forum topic closed|message thread closed|topic_id_invalid|topic_closed)$/i.test(
    error.message,
  );
}

/** Only a parsed Bale rejection of this method proves a request had no effect. */
export function isBaleApiRequestRejected(
  error: unknown,
  method: string,
): boolean {
  return (
    error instanceof BaleApiHttpError &&
    error.rejectedRequestMethod !== undefined &&
    error.rejectedRequestMethod === method
  );
}

export function isBaleMessageNotModifiedError(error: unknown): boolean {
  return (
    error instanceof Error && error.message.includes("message is not modified")
  );
}

const BALE_RETRY_SAFE_METHODS = new Set([
  "answerCallbackQuery",
  "closeForumTopic",
  "deleteForumTopic",
  "deleteMessage",
  "deleteWebhook",
  "editForumTopic",
  "editMessageCaption",
  "editMessageReplyMarkup",
  "editMessageText",
  "getChat",
  "getFile",
  "getMe",
  "getUpdates",
  "sendChatAction",
  "sendMessageDraft",
  "sendRichMessageDraft",
  "setMyCommands",
]);

export function isBaleApiMethodRetrySafe(method: string): boolean {
  return BALE_RETRY_SAFE_METHODS.has(method);
}

export function isRetryableBaleApiError(error: unknown): boolean {
  return (
    error instanceof BaleApiHttpError &&
    (error.status === 429 ||
      (error.status !== undefined && error.status >= 500))
  );
}

export function getBaleApiRetryAfterMs(error: unknown): number | undefined {
  return error instanceof BaleApiHttpError &&
    error.retryAfterSeconds !== undefined
    ? Math.max(0, error.retryAfterSeconds * 1000)
    : undefined;
}

export function isBaleMessageUnavailableError(error: unknown): boolean {
  return (
    error instanceof BaleApiHttpError &&
    error.status === 400 &&
    /Bad Request: (message to edit not found|message not found|message_id_invalid)/iu.test(
      error.message,
    )
  );
}

function getBaleRetryDelayMs(
  error: unknown,
  attempt: number,
  baseDelayMs: number,
): number {
  if (
    error instanceof BaleApiHttpError &&
    error.retryAfterSeconds !== undefined
  ) {
    return Math.max(0, error.retryAfterSeconds * 1000);
  }
  return Math.max(0, baseDelayMs * 2 ** attempt);
}

function getBaleApiAbortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("Aborted", "AbortError");
}

function throwIfBaleApiCallAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw getBaleApiAbortReason(signal);
}

function sleepBaleRetry(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(getBaleApiAbortReason(signal));
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timeout);
      reject(getBaleApiAbortReason(signal!));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

function assertBaleFileSizeWithinLimit(
  size: number | undefined,
  maxFileSizeBytes: number | undefined,
): void {
  if (size === undefined || maxFileSizeBytes === undefined) return;
  if (size <= maxFileSizeBytes) return;
  throw new Error(
    `Bale file exceeds size limit (${size} bytes > ${maxFileSizeBytes} bytes)`,
  );
}

function createBaleDownloadLimitTransform(
  maxFileSizeBytes: number | undefined,
): Transform {
  let downloadedBytes = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      downloadedBytes += chunk.byteLength;
      try {
        assertBaleFileSizeWithinLimit(downloadedBytes, maxFileSizeBytes);
        callback(undefined, chunk);
      } catch (error) {
        callback(error instanceof Error ? error : new Error(String(error)));
      }
    },
  });
}

async function writeBaleDownloadResponse(
  response: Response,
  targetPath: string,
  maxFileSizeBytes: number | undefined,
): Promise<void> {
  if (!response.body) {
    const buffer = Buffer.from(await response.arrayBuffer());
    assertBaleFileSizeWithinLimit(buffer.byteLength, maxFileSizeBytes);
    await writeFile(targetPath, buffer, { mode: 0o600 });
    return;
  }
  await pipeline(
    Readable.from(response.body, { objectMode: false }),
    createBaleDownloadLimitTransform(maxFileSizeBytes),
    createWriteStream(targetPath, { mode: 0o600 }),
  );
}

async function publishBaleDownload(
  partPath: string,
  targetPath: string,
  signal?: AbortSignal,
): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    throwIfBaleApiCallAborted(signal);
    try {
      await rename(partPath, targetPath);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      // Windows may briefly deny replacement while another publisher/scanner holds the file.
      if (
        process.platform !== "win32" ||
        (code !== "EPERM" && code !== "EACCES") ||
        attempt + 1 >= BALE_DOWNLOAD_RENAME_MAX_ATTEMPTS
      )
        throw error;
      await sleepBaleRetry(50 * 2 ** attempt, signal);
    }
  }
}

async function removeBalePartialDownload(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch {
    // ignore
  }
}

async function parseBaleApiResponse<TResponse>(
  response: Response,
  method: string,
): Promise<BaleApiResponse<TResponse>> {
  let data: BaleApiResponse<TResponse> | undefined;
  try {
    if (typeof response.text === "function") {
      const text = await response.text();
      data = text
        ? (JSON.parse(text) as BaleApiResponse<TResponse>)
        : undefined;
    } else {
      data = (await response.json()) as BaleApiResponse<TResponse>;
    }
  } catch {
    data = undefined;
  }
  if (response.ok === false) {
    const status = `HTTP ${response.status}`;
    const description = data?.description ? `: ${data.description}` : "";
    const retryAfterHeader = response.headers?.get("retry-after");
    const retryAfterSeconds =
      data?.parameters?.retry_after ??
      (retryAfterHeader ? Number.parseInt(retryAfterHeader, 10) : undefined);
    throw new BaleApiHttpError(
      `Bale API ${method} failed: ${status}${description}`,
      response.status,
      Number.isFinite(retryAfterSeconds) ? retryAfterSeconds : undefined,
      data?.ok === false &&
        data.error_code === response.status &&
        [400, 401, 403, 404, 429].includes(response.status)
        ? method
        : undefined,
    );
  }
  if (!data) {
    throw new BaleApiMalformedSuccessError(method, "returned invalid JSON");
  }
  return data;
}

function unwrapBaleApiResult<TResponse>(
  method: string,
  data: BaleApiResponse<TResponse>,
): TResponse {
  if (data.ok && data.result === undefined) {
    throw new BaleApiMalformedSuccessError(method, "returned no result");
  }
  if (!data.ok) {
    throw new Error(data.description || `Bale API ${method} failed`);
  }
  return data.result as TResponse;
}

function getBaleNetworkFamilyPolicy(
  env: NodeJS.ProcessEnv = process.env,
): BaleNetworkFamilyPolicy {
  const value = env[BALE_NETWORK_FAMILY_ENV]?.trim().toLowerCase();
  if (
    BALE_NETWORK_FAMILY_VALUES.has(value as BaleNetworkFamilyPolicy)
  ) {
    return value as BaleNetworkFamilyPolicy;
  }
  return "ipv4-fallback";
}

function getBaleNetworkFamily(
  policy: BaleNetworkFamilyPolicy,
): BaleNetworkFamily | undefined {
  if (policy === "ipv4") return 4;
  if (policy === "ipv6") return 6;
  return undefined;
}

function isBaleTransportFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === "AbortError") return false;
  if (error instanceof TypeError && /fetch failed/i.test(error.message)) {
    return true;
  }
  if (error instanceof AggregateError) return true;
  const code = getErrorCode(error);
  if (
    code === "ECONNREFUSED" ||
    code === "ETIMEDOUT" ||
    code === "ENETUNREACH" ||
    code === "EHOSTUNREACH" ||
    code === "ECONNRESET" ||
    code === "EAI_AGAIN"
  ) {
    return true;
  }
  return isBaleTransportFailure(error.cause);
}

function getBaleRequestBodyBuffer(
  body: BodyInit | null | undefined,
): Buffer | undefined {
  if (body === undefined || body === null) return undefined;
  if (typeof body === "string") return Buffer.from(body);
  if (body instanceof Uint8Array) return Buffer.from(body);
  throw new Error("Unsupported Bale HTTPS request body");
}

async function buildBaleMultipartBody(
  fields: Record<string, string>,
  fileField: string,
  fileBlob: Blob,
  fileName: string,
): Promise<{ body: Buffer; contentType: string }> {
  const boundary = `pi-bale-${randomUUID()}`;
  const chunks: Buffer[] = [];
  for (const [key, value] of Object.entries(fields)) {
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`,
      ),
    );
  }
  chunks.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${fileField}"; filename="${fileName}"\r\nContent-Type: ${fileBlob.type || "application/octet-stream"}\r\n\r\n`,
    ),
    Buffer.from(await fileBlob.arrayBuffer()),
    Buffer.from(`\r\n--${boundary}--\r\n`),
  );
  return {
    body: Buffer.concat(chunks),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

async function baleHttpsFetch(
  input: string | URL | Request,
  init: RequestInit,
  family: BaleNetworkFamily,
): Promise<Response> {
  const url = new URL(
    typeof input === "string" || input instanceof URL ? input : input.url,
  );
  const body = getBaleRequestBodyBuffer(init.body);
  const headers = new Headers(init.headers);
  if (body && !headers.has("content-length")) {
    headers.set("content-length", String(body.byteLength));
  }
  return new Promise<Response>((resolve, reject) => {
    const req = requestHttps(
      url,
      {
        method: init.method ?? "GET",
        family,
        headers: Object.fromEntries(headers.entries()),
      },
      (res) => {
        const responseHeaders = new Headers();
        for (const [key, value] of Object.entries(res.headers)) {
          if (Array.isArray(value)) responseHeaders.set(key, value.join(", "));
          else if (value !== undefined) responseHeaders.set(key, String(value));
        }
        resolve(
          new Response(Readable.toWeb(res) as ReadableStream<Uint8Array>, {
            status: res.statusCode ?? 200,
            statusText: res.statusMessage,
            headers: responseHeaders,
          }),
        );
      },
    );
    req.on("error", reject);
    if (init.signal) {
      if (init.signal.aborted)
        req.destroy(new DOMException("Aborted", "AbortError"));
      else {
        init.signal.addEventListener(
          "abort",
          () => req.destroy(new DOMException("Aborted", "AbortError")),
          { once: true },
        );
      }
    }
    req.end(body);
  });
}

let baleHttpsFetchForTesting: typeof baleHttpsFetch | undefined;

export function setBaleApiHttpsFetchForTesting(
  fetchImpl: typeof baleHttpsFetch | undefined,
): () => void {
  const previous = baleHttpsFetchForTesting;
  baleHttpsFetchForTesting = fetchImpl;
  return () => {
    baleHttpsFetchForTesting = previous;
  };
}

async function baleFetch(
  input: string | URL | Request,
  init: RequestInit = {},
  family?: BaleNetworkFamily,
): Promise<Response> {
  if (!family) return fetch(input, init);
  return (baleHttpsFetchForTesting ?? baleHttpsFetch)(
    input,
    init,
    family,
  );
}

async function callBaleTransportRequest(
  request: (family?: BaleNetworkFamily) => Promise<Response>,
  allowFallback = true,
): Promise<Response> {
  const policy = getBaleNetworkFamilyPolicy();
  if (policy === "auto") return request();
  const family = getBaleNetworkFamily(policy);
  if (family) return request(family);
  if (!allowFallback) return request();
  try {
    return await request();
  } catch (error) {
    if (!isBaleTransportFailure(error)) throw error;
    return request(4);
  }
}

function getErrorCode(error: Error): string | undefined {
  const maybeCode = (error as { code?: unknown }).code;
  return typeof maybeCode === "string" ? maybeCode : undefined;
}

function getErrorAddress(error: Error): string | undefined {
  const maybeAddress = (error as { address?: unknown }).address;
  return typeof maybeAddress === "string" ? maybeAddress : undefined;
}

function getErrorPort(error: Error): number | undefined {
  const maybePort = (error as { port?: unknown }).port;
  return typeof maybePort === "number" ? maybePort : undefined;
}

function getErrorFamily(error: Error): number | string | undefined {
  const maybeFamily = (error as { family?: unknown }).family;
  if (typeof maybeFamily === "number" || typeof maybeFamily === "string") {
    return maybeFamily;
  }
  return undefined;
}

function describeBaleErrorSummary(error: Error): {
  name: string;
  message: string;
  code?: string;
} {
  return {
    name: error.name,
    message: error.message,
    ...(getErrorCode(error) ? { code: getErrorCode(error) } : {}),
  };
}

function describeBaleTransportAttempt(error: Error): {
  name: string;
  code?: string;
  address?: string;
  port?: number;
  family?: number | string;
} {
  return {
    name: error.name,
    ...(getErrorCode(error) ? { code: getErrorCode(error) } : {}),
    ...(getErrorAddress(error) ? { address: getErrorAddress(error) } : {}),
    ...(getErrorPort(error) ? { port: getErrorPort(error) } : {}),
    ...(getErrorFamily(error) ? { family: getErrorFamily(error) } : {}),
  };
}

function describeBaleTransportError(error: unknown):
  | {
      error: { name: string; message: string; code?: string };
      cause?: { name: string; message: string; code?: string };
      attempts?: Array<{
        name: string;
        code?: string;
        address?: string;
        port?: number;
        family?: number | string;
      }>;
    }
  | undefined {
  if (!isBaleTransportFailure(error) || !(error instanceof Error)) {
    return undefined;
  }
  const cause = error.cause instanceof Error ? error.cause : undefined;
  const aggregate =
    error instanceof AggregateError
      ? error
      : cause instanceof AggregateError
        ? cause
        : undefined;
  const attempts = aggregate?.errors
    .filter((attempt): attempt is Error => attempt instanceof Error)
    .map(describeBaleTransportAttempt);
  return {
    error: describeBaleErrorSummary(error),
    ...(cause ? { cause: describeBaleErrorSummary(cause) } : {}),
    ...(attempts && attempts.length > 0 ? { attempts } : {}),
  };
}

function withBaleTransportDiagnostics(
  error: unknown,
  details: Record<string, unknown>,
): Record<string, unknown> {
  const transport = describeBaleTransportError(error);
  return transport ? { ...details, transport } : details;
}

async function callBaleWithRetry<TResponse>(
  method: string,
  request: (
    family: BaleNetworkFamily | undefined,
    beforeRequest: () => void,
  ) => Promise<Response>,
  options: BaleApiCallOptions | undefined,
): Promise<TResponse> {
  const assertAuthority = options?.assertAuthority;
  let requestIssued = false;
  const beforeRequest = () => {
    assertBaleApiCallAuthority(assertAuthority, requestIssued);
    requestIssued = true;
  };
  const retrySafe =
    options?.retrySafety === "safe" ||
    (options?.retrySafety !== "non-idempotent" &&
      isBaleApiMethodRetrySafe(method));
  const maxAttempts = Math.max(1, options?.maxAttempts ?? 3);
  const retryBaseDelayMs = options?.retryBaseDelayMs ?? 500;
  const waitBeforeRetry = async (
    error: unknown,
    attempt: number,
  ): Promise<void> => {
    const ms = getBaleRetryDelayMs(error, attempt, retryBaseDelayMs);
    if (
      !options?.signal?.aborted &&
      error instanceof BaleApiHttpError &&
      error.status === 429
    ) {
      options?.onRetryWait?.({
        method,
        delayMs: ms,
        attempt,
        ...(error.retryAfterSeconds !== undefined
          ? { retryAfterSeconds: error.retryAfterSeconds }
          : {}),
      });
    }
    if (options?.sleep) await options.sleep(ms);
    else await sleepBaleRetry(ms, options?.signal);
    throwIfBaleApiCallAborted(options?.signal);
  };
  for (let attempt = 0; ; attempt += 1) {
    throwIfBaleApiCallAborted(options?.signal);
    assertBaleApiCallAuthority(assertAuthority, requestIssued);
    try {
      const result = unwrapBaleApiResult(
        method,
        await parseBaleApiResponse<TResponse>(
          await callBaleTransportRequest(
            (family) => request(family, beforeRequest),
            retrySafe,
          ),
          method,
        ),
      );
      assertBaleApiCallAuthority(assertAuthority, requestIssued);
      return result;
    } catch (error) {
      // Authority refusal is never a transport failure, retry grant or acknowledged success.
      if (error instanceof BaleApiAuthorityError) throw error;
      assertBaleApiCallAuthority(assertAuthority, requestIssued);
      const retryable =
        isRetryableBaleApiError(error) &&
        !(
          options?.retryRateLimit === false &&
          error instanceof BaleApiHttpError &&
          error.status === 429
        );
      if (!retrySafe) {
        if (error instanceof BaleApiHttpError && error.status === 429) {
          if (attempt >= maxAttempts - 1) throw error;
          await waitBeforeRetry(error, attempt);
          continue;
        }
        if (
          error instanceof BaleApiMalformedSuccessError ||
          isBaleTransportFailure(error) ||
          (error instanceof BaleApiHttpError &&
            error.status !== undefined &&
            error.status >= 500)
        ) {
          throw new BaleApiCommitUnknownError(method, error);
        }
        throw error;
      }
      if (attempt >= maxAttempts - 1 || !retryable) throw error;
      await waitBeforeRetry(error, attempt);
    }
  }
}

export async function cleanupBaleTempFiles(
  tempDir: string,
  maxAgeMs: number,
  now = Date.now(),
): Promise<number> {
  let removedCount = 0;
  let entries: Array<{ isFile(): boolean; name: string }>;
  try {
    entries = await readdir(tempDir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    // The directory holds only attachment scratch files, so age alone decides.
    if (!entry.isFile()) continue;
    const path = join(tempDir, entry.name);
    try {
      const stats = await stat(path);
      if (now - stats.mtimeMs <= maxAgeMs) continue;
      await unlink(path);
      removedCount += 1;
    } catch {
      // ignore
    }
  }
  return removedCount;
}

export async function prepareBaleTempDir(
  tempDir: string,
  maxAgeMs: number,
): Promise<number> {
  await mkdir(tempDir, { recursive: true, mode: 0o700 });
  return cleanupBaleTempFiles(tempDir, maxAgeMs);
}

function assertBaleBotTokenConfigured(
  botToken: string | undefined,
): string {
  if (!botToken) throw new Error("Bale bot token is not configured");
  return botToken;
}

export async function callBale<TResponse>(
  botToken: string | undefined,
  method: string,
  body: Record<string, unknown>,
  options?: BaleApiCallOptions,
): Promise<TResponse> {
  const configuredBotToken = assertBaleBotTokenConfigured(botToken);
  ({ method, body } = prepareBaleRequest(method, body));
  try {
    return await callBaleWithRetry(
      method,
      async (family, beforeRequest) => {
        const encodedBody = JSON.stringify(body);
        beforeRequest();
        return baleFetch(
          `${BALE_API_BASE}/bot${configuredBotToken}/${method}`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: encodedBody,
            signal: options?.signal,
          },
          family,
        );
      },
      options,
    );
  } catch (error) {
    attachBaleApiRequestTarget(error, body);
    throw error;
  }
}

export type BaleBotIdentityResponse = Pick<
  BaleApiResponse<BaleUser>,
  "ok" | "result" | "description"
>;

export async function fetchBaleBotIdentity(
  botToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<BaleBotIdentityResponse> {
  const url = `${BALE_API_BASE}/bot${botToken}/getMe`;
  const response = await callBaleTransportRequest((family) =>
    fetchImpl === fetch ? baleFetch(url, {}, family) : fetchImpl(url),
  );
  return response.json() as Promise<BaleBotIdentityResponse>;
}

/**
 * Low-level helper to send a multipart/form-data request to the Bale Bot API.
 * This is the core implementation used for uploading voice messages, photos,
 * documents, animations, etc. It handles FormData construction, retry logic
 * (via callBaleWithRetry), and error recording under the "multipart" category.
 */
export async function callBaleMultipart<TResponse>(
  botToken: string | undefined,
  method: string,
  fields: Record<string, string>,
  fileField: string,
  filePath: string,
  fileName: string,
  options?: BaleApiCallOptions,
): Promise<TResponse> {
  const configuredBotToken = assertBaleBotTokenConfigured(botToken);
  const prepared = prepareBaleRequest(method, fields);
  method = prepared.method;
  fields = Object.fromEntries(Object.entries(prepared.body).map(([key, value]) => [key, typeof value === "string" ? value : JSON.stringify(value)]));
  options = options && { ...options };
  assertBaleApiCallAuthority(options?.assertAuthority, false);
  const fileBlob = await openAsBlob(filePath);
  try {
    return await callBaleWithRetry(
      method,
      async (family, beforeRequest) => {
        if (family) {
          const multipart = await buildBaleMultipartBody(
            fields,
            fileField,
            fileBlob,
            fileName,
          );
          beforeRequest();
          return baleFetch(
            `${BALE_API_BASE}/bot${configuredBotToken}/${method}`,
            {
              method: "POST",
              headers: { "content-type": multipart.contentType },
              body: multipart.body as unknown as BodyInit,
              signal: options?.signal,
            },
            family,
          );
        }
        const form = new FormData();
        for (const [key, value] of Object.entries(fields)) {
          form.set(key, value);
        }
        form.set(fileField, fileBlob, fileName);
        beforeRequest();
        return baleFetch(
          `${BALE_API_BASE}/bot${configuredBotToken}/${method}`,
          {
            method: "POST",
            body: form,
            signal: options?.signal,
          },
        );
      },
      options,
    );
  } catch (error) {
    attachBaleApiRequestTarget(error, fields);
    throw error;
  }
}

export async function downloadBaleFile(
  botToken: string | undefined,
  fileId: string,
  suggestedName: string,
  tempDir: string,
  options?: BaleFileDownloadOptions,
): Promise<string> {
  const configuredBotToken = assertBaleBotTokenConfigured(botToken);
  const file = await callBale<BaleGetFileResult>(
    configuredBotToken,
    "getFile",
    { file_id: fileId },
    { signal: options?.signal },
  );
  assertBaleFileSizeWithinLimit(file.file_size, options?.maxFileSizeBytes);
  await mkdir(tempDir, { recursive: true, mode: 0o700 });
  // Names carry scope and message id, so the same message maps to the same path; publish by rename.
  const targetPath = join(tempDir, sanitizeFileName(suggestedName));
  const partPath = `${targetPath}.${randomUUID()}.part`;
  const response = await callBaleTransportRequest((family) =>
    baleFetch(
      `${BALE_API_BASE}/file/bot${configuredBotToken}/${file.file_path}`,
      { signal: options?.signal },
      family,
    ),
  );
  if (!response.ok) {
    throw new Error(`Failed to download Bale file: ${response.status}`);
  }
  const contentLength = response.headers?.get("content-length");
  assertBaleFileSizeWithinLimit(
    contentLength ? Number.parseInt(contentLength, 10) : undefined,
    options?.maxFileSizeBytes,
  );
  try {
    await writeBaleDownloadResponse(
      response,
      partPath,
      options?.maxFileSizeBytes,
    );
    await publishBaleDownload(partPath, targetPath, options?.signal);
  } catch (error) {
    await removeBalePartialDownload(partPath);
    throw error;
  }
  return targetPath;
}

export async function answerBaleCallbackQuery(
  botToken: string | undefined,
  callbackQueryId: string,
  text?: string,
  options: BaleAnswerCallbackQueryOptions = {},
): Promise<void> {
  try {
    await callBale<boolean>(
      botToken,
      "answerCallbackQuery",
      text
        ? { callback_query_id: callbackQueryId, text }
        : { callback_query_id: callbackQueryId },
      options.assertAuthority
        ? { assertAuthority: options.assertAuthority }
        : undefined,
    );
  } catch (error) {
    options.recordRuntimeEvent?.(
      "api",
      error,
      withBaleTransportDiagnostics(error, {
        method: "answerCallbackQuery",
      }),
    );
    if (error instanceof BaleApiAuthorityError) throw error;
  }
}

export function createBaleChatActionSender<TAction extends string>(
  sendChatAction: (
    chatId: number,
    action: TAction,
    options?: BaleTypingActionOptions,
  ) => Promise<unknown>,
  action: TAction,
): (
  chatId: number,
  options?: BaleTypingActionOptions,
) => Promise<unknown> {
  return (chatId, options) => sendChatAction(chatId, action, options);
}

export function createBaleNativeMarkdownDraftSender(deps: {
  sendMessageDraft: BaleBridgeApiRuntime["sendMessageDraft"];
  sendRichMessageDraft: BaleBridgeApiRuntime["sendRichMessageDraft"];
}): BaleBridgeApiRuntime["sendMessageDraft"] {
  return (chatId, draftId, text, options) => {
    if (text === undefined) {
      return deps.sendMessageDraft(chatId, draftId, text, options);
    }
    return deps.sendRichMessageDraft({
      chat_id: chatId,
      draft_id: draftId,
      rich_message: { markdown: text },
      ...(options?.message_thread_id !== undefined
        ? { message_thread_id: options.message_thread_id }
        : {}),
    });
  };
}

export function createBaleAssistantDraftSender(deps: {
  getAssistantRenderingMode: () => "rich" | "html";
  renderMarkdownToHtmlDraft: (markdown: string) => string;
  sendMessageDraft: BaleBridgeApiRuntime["sendMessageDraft"];
  sendRichMessageDraft: BaleBridgeApiRuntime["sendRichMessageDraft"];
}): BaleBridgeApiRuntime["sendMessageDraft"] {
  const sendNativeDraft = createBaleNativeMarkdownDraftSender(deps);
  return (chatId, draftId, text, options) => {
    if (text === undefined || deps.getAssistantRenderingMode() === "rich") {
      return sendNativeDraft(chatId, draftId, text, options);
    }
    return deps.sendMessageDraft(
      chatId,
      draftId,
      deps.renderMarkdownToHtmlDraft(text),
      {
        ...options,
        parse_mode: "HTML",
      },
    );
  };
}

export function buildBaleAnswerGuestQueryBody(
  guestQueryId: string,
  text?: string,
  options?: BaleAnswerGuestQueryOptions,
): Record<string, unknown> {
  const body: Record<string, unknown> = { guest_query_id: guestQueryId };
  if (options?.result) {
    body.result = options.result;
  } else if (text !== undefined || options?.richMessage) {
    const inputContent: Record<string, unknown> = options?.richMessage
      ? { rich_message: options.richMessage }
      : { message_text: text };
    if (!options?.richMessage && options?.parseMode) {
      inputContent.parse_mode = options.parseMode;
    }
    body.result = {
      type: "article",
      id: "1",
      title: "Response",
      input_message_content: inputContent,
    };
  }
  return body;
}

export type BaleWorkspaceThreadDeletionTransport = (
  authorize: () => { chatId: number; threadId: number },
) => Promise<void>;

export function createDefaultBaleBridgeApiRuntime(deps: {
  getBotToken: () => string | undefined;
  getBotScope?: () => string | undefined;
  isThreadedMode?: () => boolean;
  recordRuntimeEvent: BaleBridgeApiRuntimeDeps["recordRuntimeEvent"];
  captureRequestErrorHandler?: BaleBridgeApiRuntimeDeps["captureRequestErrorHandler"];
  targetActivity?: BaleApiTargetActivityRuntime;
  workspaceAdmission?:
    | BaleApiWorkspaceAdmissionPort
    | (() => BaleApiWorkspaceAdmissionPort | undefined);
}): BaleBridgeApiRuntime & {
  deleteWorkspaceThread: BaleWorkspaceThreadDeletionTransport;
} {
  const client = createBaleApiClient(deps.getBotToken, {
    recordRuntimeEvent: deps.recordRuntimeEvent,
    isThreadedMode: deps.isThreadedMode,
  });
  const admittedClient = deps.workspaceAdmission
    ? createBaleApiWorkspaceAdmissionClient(
        client,
        deps.workspaceAdmission,
        {
          onReleaseError(error, method) {
            deps.recordRuntimeEvent("api", error, {
              phase: "workspace-admission-release",
              method,
            });
          },
        },
      )
    : client;
  const runtime = createBaleBridgeApiRuntime({
    client: deps.targetActivity
      ? createBaleApiTargetTrackingClient(
          admittedClient,
          deps.targetActivity,
        )
      : admittedClient,
    tempDir: getBaleApiTempDir(),
    maxFileSizeBytes: BALE_INBOUND_FILE_MAX_BYTES,
    tempFileMaxAgeMs: BALE_TEMP_FILE_MAX_AGE_MS,
    ...(deps.getBotScope ? { getBotScope: deps.getBotScope } : {}),
    recordRuntimeEvent: deps.recordRuntimeEvent,
    captureRequestErrorHandler: deps.captureRequestErrorHandler,
  });
  return {
    ...runtime,
    async deleteWorkspaceThread(authorize) {
      // The exclusive deletion permit replaces ordinary target admission.
      const target = authorize();
      const deleted = await client.call<boolean>(
        "deleteForumTopic",
        {
          chat_id: target.chatId,
          message_thread_id: target.threadId,
        },
        { maxAttempts: 1, retrySafety: "non-idempotent" },
      );
      if (deleted !== true)
        throw new Error(
          "Bale Workspace Thread deletion was not confirmed.",
        );
    },
  };
}

export function createBaleBridgeApiRuntime(
  deps: BaleBridgeApiRuntimeDeps,
): BaleBridgeApiRuntime {
  const recoverRequestError = async (
    handler: ((error: unknown) => Promise<void>) | undefined,
    error: unknown,
  ): Promise<void> => {
    try {
      await handler?.(error);
    } catch (recoveryError) {
      deps.recordRuntimeEvent("api", recoveryError, {
        phase: "stale-target-recovery",
      });
    }
  };
  const now = deps.now ?? Date.now;
  const chatActionMinIntervalMs = Math.max(
    0,
    deps.chatActionMinIntervalMs ?? 2_000,
  );
  const chatActionMaxGates = Math.max(1, deps.chatActionMaxGates ?? 256);
  type ChatActionGate = {
    inFlight?: Promise<unknown>;
    notBeforeMs: number;
  };
  const chatActionGates = new Map<string, ChatActionGate>();
  // Pin shared cooldowns until every concurrent Thread settles; this state never owns their sends.
  const chatActionChatGates = new Map<string, { pendingRequests: number; notBeforeMs: number }>();
  const getChatActionKeys = (
    method: string,
    body: Record<string, unknown>,
  ): { action: string; chat: string } | undefined => {
    if (method !== "sendChatAction") return undefined;
    const chatId = body.chat_id;
    const action = body.action;
    if (
      (typeof chatId !== "number" && typeof chatId !== "string") ||
      typeof action !== "string"
    ) {
      return undefined;
    }
    const chat = String(chatId);
    const threadId = body.message_thread_id;
    return {
      action: `${chat}:${
        typeof threadId === "number" || typeof threadId === "string"
          ? String(threadId)
          : "all"
      }:${action}`,
      chat,
    };
  };
  const callRecorded = async <TResponse>(
    method: string,
    body: Record<string, unknown>,
    options?: BaleApiCallOptions,
  ): Promise<TResponse> => {
    const recoverError = deps.captureRequestErrorHandler?.(body);
    const chatActionKeys = getChatActionKeys(method, body);
    if (chatActionKeys) {
      const nowMs = now();
      for (const [key, candidate] of chatActionGates) {
        if (!candidate.inFlight && nowMs >= candidate.notBeforeMs) {
          chatActionGates.delete(key);
        }
      }
      for (const [key, candidate] of chatActionChatGates) {
        if (candidate.pendingRequests === 0 && nowMs >= candidate.notBeforeMs) {
          chatActionChatGates.delete(key);
        }
      }
      let gate = chatActionGates.get(chatActionKeys.action);
      if (!gate) {
        if (chatActionGates.size >= chatActionMaxGates)
          return true as TResponse;
        gate = { notBeforeMs: 0 };
        chatActionGates.set(chatActionKeys.action, gate);
      }
      let chatGate = chatActionChatGates.get(chatActionKeys.chat);
      if (!chatGate) {
        if (chatActionChatGates.size >= chatActionMaxGates) {
          return true as TResponse;
        }
        chatGate = { pendingRequests: 0, notBeforeMs: 0 };
        chatActionChatGates.set(chatActionKeys.chat, chatGate);
      }
      if (gate.inFlight) return (await gate.inFlight) as TResponse;
      if (nowMs < gate.notBeforeMs || nowMs < chatGate.notBeforeMs) {
        return true as TResponse;
      }
      let request: Promise<TResponse>;
      request = Promise.resolve()
        .then(() =>
          deps.client.call<TResponse>(method, body, {
            ...options,
            // Presence is replaceable, not a queued body to replay after its session/loop owner ends.
            ...(body.action === "typing" ? { maxAttempts: 1, retrySafety: "non-idempotent" as const } : {}),
            retryRateLimit: false,
          }),
        )
        .then((result) => {
          gate.notBeforeMs = now() + chatActionMinIntervalMs;
          return result;
        })
        .catch(async (error: unknown) => {
          await recoverRequestError(recoverError, error);
          if (error instanceof BaleApiHttpError && error.status === 429) {
            const retryAfterMs = Math.max(
              chatActionMinIntervalMs,
              (error.retryAfterSeconds ?? 0) * 1_000,
            );
            const notBeforeMs = now() + retryAfterMs;
            gate.notBeforeMs = notBeforeMs;
            chatGate.notBeforeMs = Math.max(chatGate.notBeforeMs, notBeforeMs);
            deps.recordRuntimeEvent(
              "api",
              error,
              withBaleTransportDiagnostics(error, {
                method,
                rateLimited: true,
                retryAfterMs,
              }),
            );
            return true as TResponse;
          }
          deps.recordRuntimeEvent(
            "api",
            error,
            withBaleTransportDiagnostics(error, { method }),
          );
          throw error;
        })
        .finally(() => {
          if (gate.inFlight === request) gate.inFlight = undefined;
          chatGate.pendingRequests--;
        });
      gate.inFlight = request;
      chatGate.pendingRequests++;
      return request;
    }
    try {
      return await deps.client.call<TResponse>(method, body, options);
    } catch (error) {
      await recoverRequestError(recoverError, error);
      if (
        method === "deleteMessage" &&
        error instanceof BaleApiHttpError &&
        error.status === 400 &&
        error.message ===
          "Bale API deleteMessage failed: HTTP 400: Bad Request: message to delete not found"
      ) {
        return true as TResponse;
      }
      if (!options?.isExpectedError?.(error))
        deps.recordRuntimeEvent(
          "api",
          error,
          withBaleTransportDiagnostics(error, { method }),
        );
      throw error;
    }
  };
  return {
    call: callRecorded,

    /**
     * Sends a multipart/form-data request (used for sending voice messages,
     * photos, documents, animations, etc.).
     * Errors are recorded under the "multipart" category for diagnostics.
     */
    callMultipart: async (
      method,
      fields,
      fileField,
      filePath,
      fileName,
      options,
    ) => {
      const recoverError = deps.captureRequestErrorHandler?.(fields);
      try {
        return await deps.client.callMultipart(
          method,
          fields,
          fileField,
          filePath,
          fileName,
          options,
        );
      } catch (error) {
        await recoverRequestError(recoverError, error);
        deps.recordRuntimeEvent(
          "multipart",
          error,
          withBaleTransportDiagnostics(error, { method, fileName }),
        );
        throw error;
      }
    },

    /**
     * Downloads a file from the Bale servers into the local temp directory.
     * Used for inbound voice messages, photos, documents, etc.
     */
    downloadFile: async (fileId, suggestedName, source) => {
      try {
        return await deps.client.downloadFile(
          fileId,
          source
            ? createBaleAttachmentFileName(
                source,
                suggestedName,
                deps.getBotScope?.(),
              )
            : suggestedName,
          deps.tempDir,
          {
            maxFileSizeBytes: deps.maxFileSizeBytes,
          },
        );
      } catch (error) {
        deps.recordRuntimeEvent(
          "download",
          error,
          withBaleTransportDiagnostics(error, { suggestedName }),
        );
        throw error;
      }
    },
    deleteWebhook: (signal) =>
      callRecorded<boolean>(
        "deleteWebhook",
        { drop_pending_updates: false },
        { signal },
      ),
    getUpdates: (body, signal) =>
      callRecorded<BaleUpdate[]>("getUpdates", body, { signal }),
    setMyCommands: (commands, options) =>
      callRecorded<boolean>("setMyCommands", { commands }, options),
    sendChatAction: (chatId, action, options) =>
      callRecorded<boolean>("sendChatAction", {
        chat_id: chatId,
        action,
        ...(options?.message_thread_id !== undefined
          ? { message_thread_id: options.message_thread_id }
          : {}),
      }),
    sendTypingAction: createBaleChatActionSender(
      (chatId, action, options) =>
        callRecorded<boolean>("sendChatAction", {
          chat_id: chatId,
          action,
          ...(options?.message_thread_id !== undefined
            ? { message_thread_id: options.message_thread_id }
            : {}),
        }, { assertAuthority: options?.assertAuthority }),
      "typing",
    ),
    sendRecordVoiceAction: createBaleChatActionSender(
      (chatId, action, options) =>
        callRecorded<boolean>("sendChatAction", {
          chat_id: chatId,
          action,
          ...(options?.message_thread_id !== undefined
            ? { message_thread_id: options.message_thread_id }
            : {}),
        }),
      "record_voice",
    ),
    sendMessageDraft: (chatId, draftId, text, options) => {
      const body: Record<string, unknown> = {
        chat_id: chatId,
        draft_id: draftId,
      };
      if (text !== undefined) body.text = text;
      if (options?.parse_mode !== undefined)
        body.parse_mode = options.parse_mode;
      if (options?.entities !== undefined) body.entities = options.entities;
      if (options?.message_thread_id !== undefined)
        body.message_thread_id = options.message_thread_id;
      return callRecorded<boolean>("sendMessageDraft", body);
    },
    sendMessage: (body, options) =>
      callRecorded<BaleSentMessage>("sendMessage", body, options),
    sendRichMessage: (body, options) =>
      callRecorded<BaleSentMessage>("sendRichMessage", body, options),
    sendRichMessageDraft: (body) =>
      callRecorded<boolean>("sendRichMessageDraft", body),
    editMessageText: async (body, options) => {
      const recoverError = deps.captureRequestErrorHandler?.(body);
      try {
        await deps.client.call("editMessageText", body, options);
        return "edited";
      } catch (error) {
        if (isBaleMessageNotModifiedError(error)) return "unchanged";
        await recoverRequestError(recoverError, error);
        deps.recordRuntimeEvent(
          "api",
          error,
          withBaleTransportDiagnostics(error, {
            method: "editMessageText",
          }),
        );
        throw error;
      }
    },
    editMessageReplyMarkup: async (chatId, messageId, replyMarkup) => {
      await callRecorded("editMessageReplyMarkup", {
        chat_id: chatId,
        message_id: messageId,
        reply_markup: replyMarkup,
      });
    },
    answerCallbackQuery: async (callbackQueryId, text, options) => {
      if (options?.assertAuthority) {
        try {
          await callRecorded<boolean>(
            "answerCallbackQuery",
            text
              ? { callback_query_id: callbackQueryId, text }
              : { callback_query_id: callbackQueryId },
            { assertAuthority: options.assertAuthority },
          );
        } catch (error) {
          if (error instanceof BaleApiAuthorityError) throw error;
        }
        return;
      }
      try {
        await deps.client.answerCallbackQuery(callbackQueryId, text);
      } catch (error) {
        deps.recordRuntimeEvent(
          "api",
          error,
          withBaleTransportDiagnostics(error, {
            method: "answerCallbackQuery",
          }),
        );
        if (error instanceof BaleApiAuthorityError) throw error;
      }
    },
    answerGuestQuery: (
      guestQueryId: string,
      text: string | undefined,
      options: BaleAnswerGuestQueryOptions | undefined,
    ) =>
      callRecorded<void>(
        "answerGuestQuery",
        buildBaleAnswerGuestQueryBody(guestQueryId, text, options),
      ),
    answerGuestQueryForInlineMessage: async (
      guestQueryId: string,
      text: string | undefined,
      options: BaleAnswerGuestQueryOptions | undefined,
    ) => {
      const sent = await callRecorded<BaleSentGuestMessage | undefined>(
        "answerGuestQuery",
        buildBaleAnswerGuestQueryBody(guestQueryId, text, options),
      );
      return sent?.inline_message_id;
    },
    editGuestInlineMessage: async (
      inlineMessageId: string,
      content: BaleEditGuestInlineMessageContent,
      options?: Pick<BaleApiCallOptions, "assertAuthority">,
    ) => {
      if (content.media) {
        try {
          const result = await callRecorded("editMessageMedia", {
            inline_message_id: inlineMessageId,
            media: content.media,
          }, { ...options, maxAttempts: 1, retryRateLimit: false });
          if (result !== true) throw new Error("Missing inline edit acknowledgement.");
        } catch (error) {
          // Only a parsed rejection permits replacing this attempt with a failure notice.
          if (isBaleApiRequestRejected(error, "editMessageMedia")) throw error;
          throw new BaleApiCommitUnknownError("editMessageMedia", error);
        }
        return;
      }
      await callRecorded("editMessageText", {
        inline_message_id: inlineMessageId,
        ...(content.richMessage
          ? { rich_message: content.richMessage }
          : { text: content.text }),
        ...(content.parseMode ? { parse_mode: content.parseMode } : {}),
      }, options);
    },
    prepareTempDir: () =>
      prepareBaleTempDir(deps.tempDir, deps.tempFileMaxAgeMs),
    deleteMessage: (chatId, messageId) =>
      callRecorded<boolean>("deleteMessage", {
        chat_id: chatId,
        message_id: messageId,
      }).then(() => {}),
  };
}

/**
 * Creates a low-level Bale Bot API client.
 * This is the main entry point for all direct Bot API communication
 * (both JSON calls and multipart uploads for files/voice).
 */
export function createBaleApiClient(
  getBotToken: () => string | undefined,
  options: BaleAnswerCallbackQueryOptions & { now?: () => number; isThreadedMode?: () => boolean } = {},
): BaleApiClient {
  const now = options.now ?? Date.now;
  const recordRuntimeEvent = options.recordRuntimeEvent;
  const isThreadedMode = options.isThreadedMode;
  const fenceOutput = (
    method: string,
    body: Record<string, unknown>,
    callOptions?: BaleApiCallOptions,
  ): BaleApiCallOptions | undefined => {
    if (!isThreadedMode || !/^(send[A-Z]|copyMessages?$|forwardMessages?$)/.test(method)) return callOptions;
    const assertAuthority = () => {
      const chatId = typeof body.chat_id === "number" || typeof body.chat_id === "string"
        ? Number(body.chat_id) : undefined;
      const thread = body.message_thread_id;
      const threadId = typeof thread === "number" || (typeof thread === "string" && /^[1-9][0-9]*$/.test(thread))
        ? Number(thread) : undefined;
      // Business connections and channels are distinct from the bot's private-chat All namespace.
      if (
        isThreadedMode() && chatId !== undefined && Number.isSafeInteger(chatId) && chatId > 0 &&
        !(typeof body.business_connection_id === "string" && body.business_connection_id.length > 0) &&
        (threadId === undefined || !Number.isSafeInteger(threadId) || threadId <= 0)
      ) throw new Error("Bale All is input-only in Threaded Mode; an explicit Thread target is required.");
      callOptions?.assertAuthority?.();
    };
    assertAuthority();
    return { ...callOptions, assertAuthority };
  };
  const draftRetryNotBeforeByTarget = new Map<string, number>();
  return {
    call: async <TResponse>(
      method: string,
      body: Record<string, unknown>,
      options?: BaleApiCallOptions,
    ): Promise<TResponse> => {
      body = { ...body };
      options = fenceOutput(method, body, options);
      const token = getBotToken();
      // Cooldown keys retain only the public bot-id prefix, not the credential.
      const botId = token?.match(/^(\d+):/)?.[1];
      const isDraft =
        method === "sendMessageDraft" || method === "sendRichMessageDraft";
      const draftKey =
        isDraft && botId
          ? `${botId}:${String(body.chat_id)}:${String(body.message_thread_id ?? "all")}`
          : undefined;
      if (draftKey) {
        const nowMs = now();
        for (const [key, deadline] of draftRetryNotBeforeByTarget) {
          if (nowMs >= deadline) draftRetryNotBeforeByTarget.delete(key);
        }
        if (draftRetryNotBeforeByTarget.has(draftKey))
          return false as TResponse;
      }
      try {
        // A draft is a replaceable snapshot, not a body to replay after backoff.
        const retryWaitOptions: BaleApiCallOptions = recordRuntimeEvent
          ? {
              onRetryWait: (wait) => {
                recordRuntimeEvent(
                  "api",
                  new Error(
                    `Bale API rate limit: waiting ${wait.delayMs} ms before retrying ${wait.method}`,
                  ),
                  {
                    phase: "retry-wait",
                    method: wait.method,
                    waitMs: wait.delayMs,
                    attempt: wait.attempt,
                    ...(wait.retryAfterSeconds !== undefined
                      ? { retryAfterSeconds: wait.retryAfterSeconds }
                      : {}),
                  },
                );
              },
            }
          : {};
        return await callBale<TResponse>(token, method, body, {
          ...(isDraft ? { ...options, maxAttempts: 1 } : options),
          ...retryWaitOptions,
        });
      } catch (error) {
        if (draftKey && isRetryableBaleApiError(error)) {
          draftRetryNotBeforeByTarget.set(
            draftKey,
            Math.max(
              draftRetryNotBeforeByTarget.get(draftKey) ?? 0,
              now() +
                getBaleRetryDelayMs(
                  error,
                  0,
                  options?.retryBaseDelayMs ?? 500,
                ),
            ),
          );
        }
        throw error;
      }
    },
    callMultipart: async (
      method,
      fields,
      fileField,
      filePath,
      fileName,
      options,
    ) => {
      fields = { ...fields };
      options = fenceOutput(method, fields, options);
      return callBaleMultipart(
        getBotToken(),
        method,
        fields,
        fileField,
        filePath,
        fileName,
        options,
      );
    },
    downloadFile: async (fileId, suggestedName, tempDir, options) => {
      return downloadBaleFile(
        getBotToken(),
        fileId,
        suggestedName,
        tempDir,
        options,
      );
    },
    answerCallbackQuery: async (callbackQueryId, text, authorityOptions) => {
      const assertAuthority = authorityOptions?.assertAuthority;
      const callbackOptions = assertAuthority
        ? { ...options, assertAuthority }
        : options;
      await answerBaleCallbackQuery(
        getBotToken(),
        callbackQueryId,
        text,
        callbackOptions,
      );
    },
  };
}

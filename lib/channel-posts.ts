/**
 * Durable journal for Bale channel posts authored by this agent path
 * Zones: bale outbound, filesystem authority
 * Owns publication intent, outcome-unknown fencing, confirmed post identity, and bounded local listing
 */

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat } from "node:fs/promises";
import { basename } from "node:path";

import { Type } from "@sinclair/typebox";

import { createBaleUpdateJournalBotIdentity } from "./journal.ts";
import {
  getBaleJournalPublicationPaths,
  resolveBaleServiceJournalStorage,
} from "./paths.ts";

import {
  publishBalePrivateFile,
  readBalePrivateFile,
  BalePrivateFileError,
  withBaleFileTransaction,
} from "./locks.ts";
import type { ExtensionAPI } from "./pi.ts";
import {
  hasOnlyWireKeys as hasOnlyKeys,
  isWireRecord as isRecord,
  isNonNegativeWireInteger as isSafeTime,
} from "./wire.ts";

const CHANNEL_POST_JOURNAL_VERSION = 1;
const DEFAULT_MAX_RECORDS = 256;
const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;
const MAX_ID_LENGTH = 256;
const MAX_MARKDOWN_LENGTH = 100_000;
const MAX_CHANNEL_TITLE_LENGTH = 255;

export type BaleChannelPostMediaKind = "photo" | "video";

export interface BaleChannelPostMediaIntent {
  kind: BaleChannelPostMediaKind;
  fileName: string;
  sizeBytes: number;
  sha256: string;
}

const BALE_CHANNEL_POST_MEDIA_MAX_BYTES: Record<
  BaleChannelPostMediaKind,
  number
> = {
  photo: 10 * 1024 * 1024,
  video: 50 * 1024 * 1024,
};
const BALE_CHANNEL_POST_CAPTION_MAX_LENGTH = 1024;
const BALE_CHANNEL_POST_MEDIA_FILE_NAME_MAX_LENGTH = 255;

/** Safe, content-free local validation failure for channel media publication intent. */
export class BaleChannelPostValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BaleChannelPostValidationError";
  }
}

export function isBaleChannelPostValidationError(
  error: unknown,
): error is BaleChannelPostValidationError {
  return error instanceof BaleChannelPostValidationError;
}

const BALE_CHANNEL_POST_PHOTO_EXTENSIONS = new Set([
  ".jpg",
  ".jpeg",
  ".png",
  ".webp",
]);
const BALE_CHANNEL_POST_VIDEO_EXTENSIONS = new Set([".mp4"]);

export function resolveBaleChannelPostMediaKind(
  path: string,
): BaleChannelPostMediaKind | undefined {
  if (typeof path !== "string" || path.length === 0) return undefined;
  const name = basename(path).toLowerCase();
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return undefined;
  const extension = name.slice(dot);
  if (BALE_CHANNEL_POST_PHOTO_EXTENSIONS.has(extension)) return "photo";
  if (BALE_CHANNEL_POST_VIDEO_EXTENSIONS.has(extension)) return "video";
  return undefined;
}

export function assertBaleChannelPostMediaSize(
  kind: BaleChannelPostMediaKind,
  sizeBytes: number,
): void {
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes <= 0) {
    throw new BaleChannelPostValidationError(
      "Channel media file is empty or unreadable.",
    );
  }
  const limit = BALE_CHANNEL_POST_MEDIA_MAX_BYTES[kind];
  if (sizeBytes > limit) {
    throw new BaleChannelPostValidationError(
      `Channel ${kind} exceeds the Bale ${kind} upload limit of ${limit} bytes.`,
    );
  }
}

async function hashBaleChannelPostMedia(path: string): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("data", (chunk: Buffer) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

export async function inspectBaleChannelPostMedia(
  path: string,
): Promise<BaleChannelPostMediaIntent> {
  const kind = resolveBaleChannelPostMediaKind(path);
  if (!kind) {
    throw new BaleChannelPostValidationError(
      "Unsupported channel media type. Supported single files: .jpg, .jpeg, .png, .webp photos and .mp4 videos; albums are not supported.",
    );
  }
  let stats;
  try {
    stats = await lstat(path);
  } catch {
    throw new BaleChannelPostValidationError(
      "Channel media upload requires one readable regular local file.",
    );
  }
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new BaleChannelPostValidationError(
      "Channel media upload requires one regular local file without symbolic links.",
    );
  }
  assertBaleChannelPostMediaSize(kind, stats.size);
  return {
    kind,
    fileName: basename(path),
    sizeBytes: stats.size,
    sha256: await hashBaleChannelPostMedia(path),
  };
}

export function getBaleChannelPostCaptionLength(caption: string): number {
  const visible = caption
    .replace(/<br\s*\/?>/giu, "\n")
    .replace(/<[^>]*>/gu, "")
    .replace(/&lt;/gu, "<")
    .replace(/&gt;/gu, ">")
    .replace(/&quot;/gu, '"')
    .replace(/&#39;/gu, "'")
    .replace(/&amp;/gu, "&");
  return visible.length;
}

export function assertBaleChannelPostCaptionWithinLimit(
  caption: string,
): void {
  if (
    getBaleChannelPostCaptionLength(caption) >
    BALE_CHANNEL_POST_CAPTION_MAX_LENGTH
  ) {
    throw new BaleChannelPostValidationError(
      `Channel media caption exceeds the Bale limit of ${BALE_CHANNEL_POST_CAPTION_MAX_LENGTH} characters.`,
    );
  }
}

type ChannelPostJournalCode = "invalid" | "conflict" | "capacity" | "io";

export class BaleChannelPostJournalError extends Error {
  readonly code: ChannelPostJournalCode;

  constructor(code: ChannelPostJournalCode, message: string, cause?: unknown) {
    super(message, { cause });
    this.name = "BaleChannelPostJournalError";
    this.code = code;
  }
}

export type BaleChannelPostAddress = number | `@${string}`;

interface BaleChannelPostRecordBase {
  operationId: string;
  requestedChannel: BaleChannelPostAddress;
  markdown: string;
  media?: BaleChannelPostMediaIntent;
  createdAtMs: number;
  updatedAtMs: number;
}

interface BalePublishedChannelPostIdentity {
  issuedAtMs: number;
  publishedAtMs: number;
  channelId: number;
  messageId: number;
  channelUsername?: `@${string}`;
  channelTitle?: string;
  lastMutationId?: string;
}

export type BaleChannelPostRecord = BaleChannelPostRecordBase &
  (
    | { state: "prepared" }
    | { state: "outcome-unknown"; issuedAtMs: number }
    | ({ state: "published" } & BalePublishedChannelPostIdentity)
    | ({
        state: "edit-outcome-unknown";
        mutationId: string;
        attemptedMarkdown: string;
        mutationIssuedAtMs: number;
      } & BalePublishedChannelPostIdentity)
    | ({
        state: "delete-outcome-unknown";
        mutationId: string;
        mutationIssuedAtMs: number;
      } & BalePublishedChannelPostIdentity)
    | ({
        state: "deleted";
        mutationId: string;
        deletedAtMs: number;
      } & BalePublishedChannelPostIdentity)
  );

interface BaleChannelPostJournalFile {
  version: typeof CHANNEL_POST_JOURNAL_VERSION;
  profile: string;
  tokenSha256: string;
  records: BaleChannelPostRecord[];
}

export interface BaleChannelPostJournalStoreOptions {
  path: string;
  runtimeDir?: string;
  profileName: string;
  tokenSha256: string;
  maxRecords?: number;
  maxBytes?: number;
  getNowMs?: () => number;
}

export interface BaleChannelPostJournalStore {
  prepare(input: {
    operationId: string;
    channel: BaleChannelPostAddress;
    markdown: string;
    media?: BaleChannelPostMediaIntent;
  }): { prepared: boolean; record: BaleChannelPostRecord };
  get(operationId: string): BaleChannelPostRecord | undefined;
  beginPublication(operationId: string): {
    began: boolean;
    record: BaleChannelPostRecord;
  };
  confirmPublished(input: {
    operationId: string;
    channelId: number;
    messageId: number;
    channelUsername?: `@${string}`;
    channelTitle?: string;
  }): { confirmed: boolean; record: BaleChannelPostRecord };
  beginEdit(input: {
    operationId: string;
    mutationId: string;
    markdown: string;
  }): { began: boolean; record: BaleChannelPostRecord };
  confirmEdited(input: { operationId: string; mutationId: string }): {
    confirmed: boolean;
    record: BaleChannelPostRecord;
  };
  beginDelete(input: { operationId: string; mutationId: string }): {
    began: boolean;
    record: BaleChannelPostRecord;
  };
  confirmDeleted(input: { operationId: string; mutationId: string }): {
    confirmed: boolean;
    record: BaleChannelPostRecord;
  };
  list(input?: {
    channel?: BaleChannelPostAddress;
    limit?: number;
  }): BaleChannelPostRecord[];
}

export async function publishBaleChannelPost(input: {
  store: BaleChannelPostJournalStore;
  operationId: string;
  channel: BaleChannelPostAddress;
  markdown: string;
  media?: BaleChannelPostMediaIntent;
  observeChannel(channel: BaleChannelPostAddress): Promise<{
    id: number;
    type: string;
    username?: string;
    title?: string;
  }>;
  send(
    channel: BaleChannelPostAddress,
    markdown: string,
  ): Promise<{
    messageId: number;
    chat: { id: number; type: string };
  }>;
}): Promise<BaleChannelPostRecord> {
  const observed = await input.observeChannel(input.channel);
  if (
    observed.type !== "channel" ||
    !Number.isSafeInteger(observed.id) ||
    observed.id >= 0 ||
    (typeof input.channel === "number" && observed.id !== input.channel) ||
    (observed.username !== undefined &&
      !/^[A-Za-z0-9_]{5,32}$/u.test(observed.username)) ||
    (observed.title !== undefined &&
      (observed.title.length === 0 ||
        observed.title.length > MAX_CHANNEL_TITLE_LENGTH))
  ) {
    throw new Error(
      "Bale channel delivery requires bounded exact getChat channel identity.",
    );
  }
  input.store.prepare({
    operationId: input.operationId,
    channel: input.channel,
    markdown: input.markdown,
    ...(input.media === undefined ? {} : { media: input.media }),
  });
  const issuance = input.store.beginPublication(input.operationId);
  if (!issuance.began) {
    if (issuance.record.state === "published") return issuance.record;
    throw new Error(
      "Bale channel post outcome is unknown; refusing automatic replay.",
    );
  }
  const sent = await input.send(input.channel, input.markdown);
  if (sent.chat.type !== "channel" || sent.chat.id !== observed.id) {
    throw new Error(
      "Bale channel post response identity did not match the verified channel.",
    );
  }
  return input.store.confirmPublished({
    operationId: input.operationId,
    channelId: sent.chat.id,
    messageId: sent.messageId,
    ...(observed.username
      ? { channelUsername: `@${observed.username}` as `@${string}` }
      : {}),
    ...(observed.title ? { channelTitle: observed.title } : {}),
  }).record;
}

function formatBaleChannelPostToolOutput(value: unknown): string {
  // Pi's compact tool rows need one leading newline to separate call and result.
  return `\n${JSON.stringify(value, null, 2)}`;
}

function formatBaleChannelPostToolError(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  return new Error(
    `\n${message.replace(/^\n+/u, "") || "Bale channel post operation failed."}`,
  );
}

export function registerBaleChannelPostMutationTool(
  pi: ExtensionAPI,
  deps: {
    mutate(input: {
      action: "edit" | "delete";
      operationId: string;
      mutationId: string;
      markdown?: string;
    }): Promise<BaleChannelPostRecord>;
  },
): void {
  pi.registerTool({
    name: "bale_channel_post",
    label: "Edit or Delete Bale Channel Post",
    description:
      "Edit or delete one exact published post retained by bale_channel_posts; a media post edit replaces its caption. Unknown outcomes are never replayed.",
    parameters: Type.Object({
      action: Type.Union([Type.Literal("edit"), Type.Literal("delete")]),
      operation_id: Type.String({ minLength: 1, maxLength: MAX_ID_LENGTH }),
      markdown: Type.Optional(
        Type.String({ minLength: 1, maxLength: MAX_MARKDOWN_LENGTH }),
      ),
    }),
    async execute(toolCallId, params) {
      try {
        const record = await deps.mutate({
          action: params.action,
          operationId: params.operation_id,
          mutationId: toolCallId,
          ...(params.markdown === undefined
            ? {}
            : { markdown: params.markdown }),
        });
        return {
          content: [
            {
              type: "text" as const,
              text: formatBaleChannelPostToolOutput(record),
            },
          ],
          details: { record },
        };
      } catch (error) {
        if (isBaleChannelPostValidationError(error)) {
          throw formatBaleChannelPostToolError(error);
        }
        throw new Error(
          "\nBale channel post mutation failed; inspect the retained local record before retrying.",
        );
      }
    },
  });
}

export function registerBaleChannelPostListTool(
  pi: ExtensionAPI,
  deps: { list: BaleChannelPostJournalStore["list"] },
): void {
  pi.registerTool({
    name: "bale_channel_posts",
    label: "Bale Channel Posts",
    description:
      "List bounded local records for channel posts authored by this agent path. This does not read Bale channel history.",
    parameters: Type.Object({
      chat_id: Type.Optional(
        Type.Union([
          Type.Number(),
          Type.String({ pattern: "^@[A-Za-z0-9_]{5,32}$" }),
        ]),
      ),
      limit: Type.Optional(
        Type.Integer({ minimum: 1, maximum: DEFAULT_MAX_RECORDS }),
      ),
    }),
    async execute(_toolCallId, params) {
      try {
        const records = deps.list({
          channel: params.chat_id as BaleChannelPostAddress | undefined,
          limit: params.limit,
        });
        return {
          content: [
            {
              type: "text" as const,
              text: formatBaleChannelPostToolOutput(records),
            },
          ],
          details: { records },
        };
      } catch {
        throw new Error(
          "\nBale channel post listing failed without exposing retained content or storage details.",
        );
      }
    },
  });
}

function normalizeChannel(value: unknown): BaleChannelPostAddress {
  if (Number.isSafeInteger(value) && (value as number) < 0)
    return value as number;
  if (typeof value === "string" && /^@[A-Za-z0-9_]{5,32}$/u.test(value)) {
    return value as `@${string}`;
  }
  throw new BaleChannelPostJournalError(
    "invalid",
    "Bale channel post requires an exact negative channel ID or public @username.",
  );
}

function validateBaleChannelPostMedia(
  value: unknown,
): BaleChannelPostMediaIntent {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["kind", "fileName", "sizeBytes", "sha256"]) ||
    (value.kind !== "photo" && value.kind !== "video") ||
    typeof value.fileName !== "string" ||
    value.fileName.length === 0 ||
    value.fileName.length > BALE_CHANNEL_POST_MEDIA_FILE_NAME_MAX_LENGTH ||
    !Number.isSafeInteger(value.sizeBytes) ||
    (value.sizeBytes as number) <= 0 ||
    (value.sizeBytes as number) >
      BALE_CHANNEL_POST_MEDIA_MAX_BYTES[value.kind] ||
    typeof value.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(value.sha256)
  ) {
    throw new BaleChannelPostJournalError(
      "invalid",
      "Bale channel post journal contains an invalid media intent.",
    );
  }
  return {
    kind: value.kind,
    fileName: value.fileName,
    sizeBytes: value.sizeBytes as number,
    sha256: value.sha256,
  };
}

function sameBaleChannelPostMedia(
  left: BaleChannelPostMediaIntent | undefined,
  right: BaleChannelPostMediaIntent | undefined,
): boolean {
  if (left === undefined || right === undefined) return left === right;
  return (
    left.kind === right.kind &&
    left.fileName === right.fileName &&
    left.sizeBytes === right.sizeBytes &&
    left.sha256 === right.sha256
  );
}

/** Evidence that only exists once Bale has confirmed a publication. */
const BALE_CHANNEL_POST_PUBLICATION_FIELDS = [
  "publishedAtMs",
  "channelId",
  "messageId",
  "channelUsername",
  "mutationId",
  "attemptedMarkdown",
  "mutationIssuedAtMs",
  "deletedAtMs",
  "lastMutationId",
  "channelTitle",
] as const;

function lacksBaleChannelPostFields(
  value: Record<string, unknown>,
  fields: readonly string[],
): boolean {
  return fields.every((field) => value[field] === undefined);
}

function validateRecord(value: unknown): BaleChannelPostRecord {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "operationId",
      "requestedChannel",
      "markdown",
      "media",
      "createdAtMs",
      "updatedAtMs",
      "state",
      "issuedAtMs",
      "publishedAtMs",
      "channelId",
      "messageId",
      "channelUsername",
      "mutationId",
      "attemptedMarkdown",
      "mutationIssuedAtMs",
      "deletedAtMs",
      "lastMutationId",
      "channelTitle",
    ]) ||
    typeof value.operationId !== "string" ||
    value.operationId.length === 0 ||
    value.operationId.length > MAX_ID_LENGTH ||
    typeof value.markdown !== "string" ||
    value.markdown.length === 0 ||
    value.markdown.length > MAX_MARKDOWN_LENGTH ||
    !isSafeTime(value.createdAtMs) ||
    !isSafeTime(value.updatedAtMs) ||
    value.updatedAtMs < value.createdAtMs
  ) {
    throw new BaleChannelPostJournalError(
      "invalid",
      "Bale channel post journal contains an invalid record.",
    );
  }
  const base: BaleChannelPostRecordBase = {
    operationId: value.operationId,
    requestedChannel: normalizeChannel(value.requestedChannel),
    markdown: value.markdown,
    createdAtMs: value.createdAtMs,
    updatedAtMs: value.updatedAtMs,
    ...(value.media === undefined
      ? {}
      : { media: validateBaleChannelPostMedia(value.media) }),
  };
  if (
    value.state === "prepared" &&
    value.issuedAtMs === undefined &&
    lacksBaleChannelPostFields(
      value,
      BALE_CHANNEL_POST_PUBLICATION_FIELDS,
    )
  ) {
    return { ...base, state: "prepared" };
  }
  if (!isSafeTime(value.issuedAtMs) || value.issuedAtMs < value.createdAtMs) {
    throw new BaleChannelPostJournalError(
      "invalid",
      "Bale channel post journal contains invalid issuance evidence.",
    );
  }
  if (
    value.state === "outcome-unknown" &&
    lacksBaleChannelPostFields(
      value,
      BALE_CHANNEL_POST_PUBLICATION_FIELDS,
    )
  ) {
    return { ...base, state: "outcome-unknown", issuedAtMs: value.issuedAtMs };
  }
  if (
    !isSafeTime(value.publishedAtMs) ||
    value.publishedAtMs < value.issuedAtMs ||
    !Number.isSafeInteger(value.channelId) ||
    (value.channelId as number) >= 0 ||
    !Number.isSafeInteger(value.messageId) ||
    (value.messageId as number) <= 0 ||
    (value.channelUsername !== undefined &&
      (typeof value.channelUsername !== "string" ||
        !/^@[A-Za-z0-9_]{5,32}$/u.test(value.channelUsername))) ||
    (value.channelTitle !== undefined &&
      (typeof value.channelTitle !== "string" ||
        value.channelTitle.length === 0 ||
        value.channelTitle.length > MAX_CHANNEL_TITLE_LENGTH))
  ) {
    throw new BaleChannelPostJournalError(
      "invalid",
      "Bale channel post journal contains invalid published identity.",
    );
  }
  const identity: BalePublishedChannelPostIdentity = {
    issuedAtMs: value.issuedAtMs,
    publishedAtMs: value.publishedAtMs,
    channelId: value.channelId as number,
    messageId: value.messageId as number,
    ...(value.channelUsername
      ? { channelUsername: value.channelUsername as `@${string}` }
      : {}),
    ...(typeof value.channelTitle === "string"
      ? { channelTitle: value.channelTitle }
      : {}),
    ...(typeof value.lastMutationId === "string" &&
    value.lastMutationId.length > 0 &&
    value.lastMutationId.length <= MAX_ID_LENGTH
      ? { lastMutationId: value.lastMutationId }
      : {}),
  };
  if (
    value.lastMutationId !== undefined &&
    identity.lastMutationId === undefined
  ) {
    throw new BaleChannelPostJournalError(
      "invalid",
      "Bale channel post journal contains invalid mutation identity.",
    );
  }
  if (
    value.state === "published" &&
    value.mutationId === undefined &&
    value.attemptedMarkdown === undefined &&
    value.mutationIssuedAtMs === undefined &&
    value.deletedAtMs === undefined
  )
    return { ...base, ...identity, state: "published" };
  const validMutation =
    typeof value.mutationId === "string" &&
    value.mutationId.length > 0 &&
    value.mutationId.length <= MAX_ID_LENGTH &&
    isSafeTime(value.mutationIssuedAtMs) &&
    value.mutationIssuedAtMs >= value.publishedAtMs &&
    value.mutationIssuedAtMs === value.updatedAtMs;
  if (
    value.state === "edit-outcome-unknown" &&
    validMutation &&
    typeof value.attemptedMarkdown === "string" &&
    value.attemptedMarkdown.length > 0 &&
    value.attemptedMarkdown.length <= MAX_MARKDOWN_LENGTH &&
    value.deletedAtMs === undefined
  ) {
    return {
      ...base,
      ...identity,
      state: "edit-outcome-unknown",
      mutationId: value.mutationId as string,
      attemptedMarkdown: value.attemptedMarkdown,
      mutationIssuedAtMs: value.mutationIssuedAtMs as number,
    };
  }
  if (
    value.state === "delete-outcome-unknown" &&
    validMutation &&
    value.attemptedMarkdown === undefined &&
    value.deletedAtMs === undefined
  ) {
    return {
      ...base,
      ...identity,
      state: "delete-outcome-unknown",
      mutationId: value.mutationId as string,
      mutationIssuedAtMs: value.mutationIssuedAtMs as number,
    };
  }
  if (
    value.state === "deleted" &&
    typeof value.mutationId === "string" &&
    value.mutationId.length > 0 &&
    value.mutationId.length <= MAX_ID_LENGTH &&
    isSafeTime(value.deletedAtMs) &&
    value.deletedAtMs >= value.publishedAtMs &&
    value.deletedAtMs === value.updatedAtMs &&
    value.mutationIssuedAtMs === undefined &&
    value.attemptedMarkdown === undefined
  ) {
    return {
      ...base,
      ...identity,
      state: "deleted",
      mutationId: value.mutationId,
      deletedAtMs: value.deletedAtMs,
    };
  }
  throw new BaleChannelPostJournalError(
    "invalid",
    "Bale channel post journal contains an invalid state.",
  );
}

function parseBaleChannelPostJournalFile(
  value: unknown,
  profileName: string,
  tokenSha256: string,
): BaleChannelPostJournalFile {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["version", "profile", "tokenSha256", "records"]) ||
    value.version !== CHANNEL_POST_JOURNAL_VERSION ||
    value.profile !== profileName ||
    value.tokenSha256 !== tokenSha256 ||
    !Array.isArray(value.records)
  ) {
    throw new BaleChannelPostJournalError(
      "conflict",
      "Bale channel post journal identity or schema does not match.",
    );
  }
  const records = value.records.map(validateRecord);
  if (
    new Set(records.map((record) => record.operationId)).size !== records.length
  ) {
    throw new BaleChannelPostJournalError(
      "invalid",
      "Bale channel post journal contains duplicate operation IDs.",
    );
  }
  return {
    version: CHANNEL_POST_JOURNAL_VERSION,
    profile: profileName,
    tokenSha256,
    records,
  };
}

/** Exact operation lookup; a missing record is a durable conflict, never an implicit create. */
function findBaleChannelPostRecord(
  file: BaleChannelPostJournalFile,
  operationId: string,
  missing: string,
): [number, BaleChannelPostJournalFile["records"][number]] {
  const index = file.records.findIndex(
    (record) => record.operationId === operationId,
  );
  if (index < 0) throw new BaleChannelPostJournalError("conflict", missing);
  return [index, file.records[index]!];
}

/** The profile's channel-post journal in the shared runtime directory, bound to the active bot token. */
export function openBaleChannelPostJournalStore(input: {
  profileName: string;
  botToken: string;
}): BaleChannelPostJournalStore {
  return createBaleChannelPostJournalStore({
    ...resolveBaleServiceJournalStorage(
      "channel-posts",
      undefined,
      input.profileName,
    ),
    profileName: input.profileName,
    tokenSha256: createBaleUpdateJournalBotIdentity({
      botToken: input.botToken,
    }).tokenSha256,
  });
}

export function createBaleChannelPostJournalStore(
  options: BaleChannelPostJournalStoreOptions,
): BaleChannelPostJournalStore {
  options = { ...options };
  const publicationPaths = getBaleJournalPublicationPaths(
    options.path,
    options.runtimeDir,
  );
  const maxRecords = options.maxRecords ?? DEFAULT_MAX_RECORDS;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const now = options.getNowMs ?? Date.now;
  if (
    !options.path ||
    !options.profileName ||
    !/^[a-f0-9]{64}$/u.test(options.tokenSha256) ||
    !Number.isSafeInteger(maxRecords) ||
    maxRecords <= 0 ||
    !Number.isSafeInteger(maxBytes) ||
    maxBytes <= 0
  ) {
    throw new Error("Bale channel post journal options are invalid.");
  }
  const empty = (): BaleChannelPostJournalFile => ({
    version: CHANNEL_POST_JOURNAL_VERSION,
    profile: options.profileName,
    tokenSha256: options.tokenSha256,
    records: [],
  });
  const read = (): BaleChannelPostJournalFile => {
    try {
      const text = readBalePrivateFile(options.path, maxBytes);
      return text === undefined
        ? empty()
        : parseBaleChannelPostJournalFile(
            JSON.parse(text) as unknown,
            options.profileName,
            options.tokenSha256,
          );
    } catch (error) {
      if (error instanceof BaleChannelPostJournalError) throw error;
      if (error instanceof BalePrivateFileError)
        throw new BaleChannelPostJournalError(
          error.failure === "capacity"
            ? "capacity"
            : error.failure === "changed"
              ? "conflict"
              : "invalid",
          "Bale channel post journal is not a bounded no-follow regular file.",
          error,
        );
      throw new BaleChannelPostJournalError(
        "io",
        "Could not read Bale channel post journal.",
        error,
      );
    }
  };
  const publish = (file: BaleChannelPostJournalFile): void => {
    if (file.records.length > maxRecords) {
      throw new BaleChannelPostJournalError(
        "capacity",
        "Bale channel post journal record limit reached.",
      );
    }
    const serialized = `${JSON.stringify(file, null, 2)}\n`;
    if (Buffer.byteLength(serialized) > maxBytes) {
      throw new BaleChannelPostJournalError(
        "capacity",
        "Bale channel post journal byte limit reached.",
      );
    }
    publishBalePrivateFile(
      options.path,
      publicationPaths.temporaryBasePath,
      serialized,
      "Bale channel post journal",
    );
  };
  // Each transition stamps one clock reading that may not run behind the record's prior transition.
  const readClock = (floorMs = -Infinity): number => {
    const atMs = now();
    if (!isSafeTime(atMs) || atMs < floorMs)
      throw new BaleChannelPostJournalError(
        "invalid",
        "Bale channel post clock is invalid.",
      );
    return atMs;
  };
  const replaceRecord = (
    file: BaleChannelPostJournalFile,
    index: number,
    record: BaleChannelPostRecord,
  ): void => {
    const records = [...file.records];
    records[index] = record;
    publish({ ...file, records });
  };
  const mutate = <T>(
    operation: (file: BaleChannelPostJournalFile) => T,
  ): T => {
    try {
      return withBaleFileTransaction(publicationPaths.transactionPath, () =>
        operation(read()),
      );
    } catch (error) {
      if (error instanceof BaleChannelPostJournalError) throw error;
      throw new BaleChannelPostJournalError(
        "io",
        "Bale channel post journal mutation failed.",
        error,
      );
    }
  };
  return {
    prepare(input) {
      const operationId = input.operationId;
      const channel = normalizeChannel(input.channel);
      const media =
        input.media === undefined
          ? undefined
          : validateBaleChannelPostMedia(input.media);
      if (
        typeof operationId !== "string" ||
        operationId.length === 0 ||
        operationId.length > MAX_ID_LENGTH ||
        typeof input.markdown !== "string" ||
        input.markdown.length === 0 ||
        input.markdown.length > MAX_MARKDOWN_LENGTH
      ) {
        throw new BaleChannelPostJournalError(
          "invalid",
          "Bale channel post intent is invalid.",
        );
      }
      return mutate((file) => {
        const existing = file.records.find(
          (record) => record.operationId === operationId,
        );
        if (existing) {
          if (
            existing.requestedChannel !== channel ||
            existing.markdown !== input.markdown ||
            !sameBaleChannelPostMedia(existing.media, media)
          ) {
            throw new BaleChannelPostJournalError(
              "conflict",
              "Bale channel post operation conflicts with retained intent.",
            );
          }
          return { prepared: false, record: structuredClone(existing) };
        }
        const atMs = readClock();
        const record: BaleChannelPostRecord = {
          operationId,
          requestedChannel: channel,
          markdown: input.markdown,
          createdAtMs: atMs,
          updatedAtMs: atMs,
          state: "prepared",
          ...(media === undefined ? {} : { media }),
        };
        publish({ ...file, records: [...file.records, record] });
        return { prepared: true, record: structuredClone(record) };
      });
    },
    beginPublication(operationId) {
      return mutate((file) => {
        const [index, current] = findBaleChannelPostRecord(
          file,
          operationId,
          "Bale channel post intent is missing.",
        );
        if (current.state !== "prepared")
          return { began: false, record: structuredClone(current) };
        const atMs = readClock(current.createdAtMs);
        const record: BaleChannelPostRecord = {
          ...current,
          state: "outcome-unknown",
          issuedAtMs: atMs,
          updatedAtMs: atMs,
        };
        replaceRecord(file, index, record);
        return { began: true, record: structuredClone(record) };
      });
    },
    confirmPublished(input) {
      return mutate((file) => {
        const [index, current] = findBaleChannelPostRecord(
          file,
          input.operationId,
          "Bale channel post intent is missing.",
        );
        if (current.state === "published") {
          if (
            current.channelId !== input.channelId ||
            current.messageId !== input.messageId ||
            current.channelUsername !== input.channelUsername ||
            current.channelTitle !== input.channelTitle
          ) {
            throw new BaleChannelPostJournalError(
              "conflict",
              "Bale channel post confirmation conflicts with retained identity.",
            );
          }
          return { confirmed: false, record: structuredClone(current) };
        }
        if (
          current.state !== "outcome-unknown" ||
          !Number.isSafeInteger(input.channelId) ||
          input.channelId >= 0 ||
          !Number.isSafeInteger(input.messageId) ||
          input.messageId <= 0 ||
          (input.channelUsername !== undefined &&
            !/^@[A-Za-z0-9_]{5,32}$/u.test(input.channelUsername)) ||
          (input.channelTitle !== undefined &&
            (input.channelTitle.length === 0 ||
              input.channelTitle.length > MAX_CHANNEL_TITLE_LENGTH))
        ) {
          throw new BaleChannelPostJournalError(
            "conflict",
            "Bale channel post confirmation is invalid or premature.",
          );
        }
        const atMs = readClock(current.issuedAtMs);
        const record: BaleChannelPostRecord = {
          ...current,
          state: "published",
          publishedAtMs: atMs,
          updatedAtMs: atMs,
          channelId: input.channelId,
          messageId: input.messageId,
          ...(input.channelUsername
            ? { channelUsername: input.channelUsername }
            : {}),
          ...(input.channelTitle ? { channelTitle: input.channelTitle } : {}),
        };
        replaceRecord(file, index, record);
        return { confirmed: true, record: structuredClone(record) };
      });
    },
    beginEdit(input) {
      return mutate((file) => {
        const [index, current] = findBaleChannelPostRecord(
          file,
          input.operationId,
          "Bale channel post is missing.",
        );
        if (current.state === "edit-outcome-unknown") {
          if (
            current.mutationId === input.mutationId &&
            current.attemptedMarkdown === input.markdown
          )
            return { began: false, record: structuredClone(current) };
          throw new BaleChannelPostJournalError(
            "conflict",
            "Bale channel post already has an unresolved mutation.",
          );
        }
        if (
          current.state === "published" &&
          current.lastMutationId === input.mutationId
        ) {
          if (current.markdown === input.markdown)
            return { began: false, record: structuredClone(current) };
          throw new BaleChannelPostJournalError(
            "conflict",
            "Bale channel post mutation identity conflicts with retained edit.",
          );
        }
        if (
          current.state !== "published" ||
          !input.mutationId ||
          input.mutationId.length > MAX_ID_LENGTH ||
          !input.markdown ||
          input.markdown.length > MAX_MARKDOWN_LENGTH
        ) {
          throw new BaleChannelPostJournalError(
            "conflict",
            "Bale channel post edit is invalid or unavailable.",
          );
        }
        const atMs = readClock(current.updatedAtMs);
        const record: BaleChannelPostRecord = {
          ...current,
          state: "edit-outcome-unknown",
          mutationId: input.mutationId,
          attemptedMarkdown: input.markdown,
          mutationIssuedAtMs: atMs,
          updatedAtMs: atMs,
        };
        replaceRecord(file, index, record);
        return { began: true, record: structuredClone(record) };
      });
    },
    confirmEdited(input) {
      return mutate((file) => {
        const [index, current] = findBaleChannelPostRecord(
          file,
          input.operationId,
          "Bale channel post is missing.",
        );
        if (
          current.state === "published" &&
          current.lastMutationId === input.mutationId
        )
          return { confirmed: false, record: structuredClone(current) };
        if (
          current.state !== "edit-outcome-unknown" ||
          current.mutationId !== input.mutationId
        )
          throw new BaleChannelPostJournalError(
            "conflict",
            "Bale channel post edit confirmation is stale.",
          );
        const atMs = readClock(current.mutationIssuedAtMs);
        const { mutationId, attemptedMarkdown, mutationIssuedAtMs, ...prior } =
          current;
        const record: BaleChannelPostRecord = {
          ...prior,
          state: "published",
          markdown: attemptedMarkdown,
          lastMutationId: mutationId,
          updatedAtMs: atMs,
        };
        replaceRecord(file, index, record);
        return { confirmed: true, record: structuredClone(record) };
      });
    },
    beginDelete(input) {
      return mutate((file) => {
        const [index, current] = findBaleChannelPostRecord(
          file,
          input.operationId,
          "Bale channel post is missing.",
        );
        if (current.state === "delete-outcome-unknown") {
          if (current.mutationId === input.mutationId)
            return { began: false, record: structuredClone(current) };
          throw new BaleChannelPostJournalError(
            "conflict",
            "Bale channel post already has an unresolved deletion.",
          );
        }
        if (
          current.state === "deleted" &&
          current.mutationId === input.mutationId
        )
          return { began: false, record: structuredClone(current) };
        if (
          current.state !== "published" ||
          !input.mutationId ||
          input.mutationId.length > MAX_ID_LENGTH
        )
          throw new BaleChannelPostJournalError(
            "conflict",
            "Bale channel post deletion is invalid or unavailable.",
          );
        const atMs = readClock(current.updatedAtMs);
        const record: BaleChannelPostRecord = {
          ...current,
          state: "delete-outcome-unknown",
          mutationId: input.mutationId,
          mutationIssuedAtMs: atMs,
          updatedAtMs: atMs,
        };
        replaceRecord(file, index, record);
        return { began: true, record: structuredClone(record) };
      });
    },
    confirmDeleted(input) {
      return mutate((file) => {
        const [index, current] = findBaleChannelPostRecord(
          file,
          input.operationId,
          "Bale channel post is missing.",
        );
        if (
          current.state === "deleted" &&
          current.mutationId === input.mutationId
        )
          return { confirmed: false, record: structuredClone(current) };
        if (
          current.state !== "delete-outcome-unknown" ||
          current.mutationId !== input.mutationId
        )
          throw new BaleChannelPostJournalError(
            "conflict",
            "Bale channel post deletion confirmation is stale.",
          );
        const atMs = readClock(current.mutationIssuedAtMs);
        const { mutationIssuedAtMs, ...prior } = current;
        const record: BaleChannelPostRecord = {
          ...prior,
          state: "deleted",
          deletedAtMs: atMs,
          updatedAtMs: atMs,
        };
        replaceRecord(file, index, record);
        return { confirmed: true, record: structuredClone(record) };
      });
    },
    get(operationId) {
      if (
        typeof operationId !== "string" ||
        operationId.length === 0 ||
        operationId.length > MAX_ID_LENGTH
      ) {
        throw new BaleChannelPostJournalError(
          "invalid",
          "Bale channel post operation ID is invalid.",
        );
      }
      const record = read().records.find(
        (candidate) => candidate.operationId === operationId,
      );
      return record === undefined ? undefined : structuredClone(record);
    },
    list(input = {}) {
      const limit = input.limit ?? 20;
      if (!Number.isSafeInteger(limit) || limit <= 0 || limit > maxRecords) {
        throw new BaleChannelPostJournalError(
          "invalid",
          "Bale channel post list limit is invalid.",
        );
      }
      const channel =
        input.channel === undefined
          ? undefined
          : normalizeChannel(input.channel);
      return read()
        .records.filter(
          (record) =>
            channel === undefined || record.requestedChannel === channel,
        )
        .slice(-limit)
        .reverse()
        .map((record) => structuredClone(record));
    },
  };
}

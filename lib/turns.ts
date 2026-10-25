/**
 * Bale turn-building helpers
 * Zones: bale inbound, pi agent prompt content, queue
 * Owns prompt-turn summary and content construction so queued Bale turns are assembled consistently
 */

import { readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import {
  appendBaleAttachmentSection,
  appendBaleListSection,
  buildBaleReplyContextBlock,
  collectBaleFileInfos,
  collectBaleMessageIds,
  downloadBaleMessageFiles,
  extractBaleForwardContextText,
  extractBaleMessagesPromptText,
  extractBaleMessagesText,
  extractBaleMessageText,
  formatBaleHistoryText,
  guessMediaType,
  type DownloadedBaleMessageFile,
  type DownloadBaleMessageFilesDeps,
  type BaleMediaMessage,
} from "./media.ts";
import {
  createBaleQueueAdmissionReceipt,
  truncateBaleQueueSummary,
  type PendingBaleTurn,
  type BalePreparedPromptTurn,
  type BalePromptContent,
  type BaleQueueAdmissionReceipt,
  type BaleQueueItem,
  type BaleQueueStore,
} from "./queue.ts";

import {
  computeVoicePromptContribution,
  computeVoiceTurnFlags,
  getBaleVoiceReplyMode,
  type BaleVoiceReplyMode,
} from "./voice.ts";

export const BALE_PREFIX = "[bale]";

const REPLY_ANCHOR_SUPPRESSED = Symbol.for("@llblab/pi-bale:reply-anchor-suppressed");

/** A routed source keeps its unique message/file/group identity, but cannot quote an anchor in its former tab. */
export function withoutBaleTurnReplyAnchor<TMessage extends object>(message: TMessage): TMessage {
  return { ...message, [REPLY_ANCHOR_SUPPRESSED]: true };
}

/** A confirmed same-target copy may replace the former-tab suppression on a warm input projection. */
export function withBaleTurnReplyAnchor<TMessage extends { message_id: number }>(message: TMessage): TMessage {
  if (!Number.isSafeInteger(message.message_id) || message.message_id <= 0)
    throw new Error("Bale reply anchor requires a positive message ID.");
  return { ...message, [REPLY_ANCHOR_SUPPRESSED]: false };
}

export const BALE_GUEST_TURN_NOTE =
  "[guest] delivery: answer quickly with one concise, self-contained reply";

export interface BaleTurnTarget {
  chatId: number;
  threadId?: number;
}

export interface BaleTurnMessage {
  message_id: number;
  message_thread_id?: number;
  pi_bale_agent_source_thread?: string;
  pi_bale_source_update_id?: number;
  chat: { id: number; type?: string };
}

export type DownloadedBaleTurnFile = DownloadedBaleMessageFile;

function getBaleTurnTarget(
  message: BaleTurnMessage,
): BaleTurnTarget {
  return Number.isInteger(message.message_thread_id)
    ? { chatId: message.chat.id, threadId: message.message_thread_id }
    : { chatId: message.chat.id };
}

function formatBalePrefixAttributeValue(value: string): string {
  return value
    .replace(/[\]\n\r|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function createBaleTurnPrefix(
  attributes: Record<string, string | undefined> = {},
): string {
  const parts = [BALE_PREFIX.slice(1, -1)];
  for (const [key, value] of Object.entries(attributes)) {
    const normalized = value ? formatBalePrefixAttributeValue(value) : "";
    if (normalized) parts.push(`${key}:${normalized}`);
  }
  return `[${parts.join("|")}]`;
}

function formatBaleTurnPrefix(
  _message: BaleTurnMessage,
  basePrefix = BALE_PREFIX,
): string {
  return basePrefix;
}

export { truncateBaleQueueSummary };

export function formatBaleTurnStatusSummary(
  rawText: string,
  files: DownloadedBaleTurnFile[],
  handlerOutputs: string[] = [],
): string {
  const textSummary = truncateBaleQueueSummary(rawText);
  if (textSummary) return textSummary;
  const handlerSummary = truncateBaleQueueSummary(handlerOutputs.join(" "));
  if (handlerSummary) return handlerSummary;
  if (files.length === 1) {
    const fileName = basename(
      files[0]?.fileName || files[0]?.path || "attachment",
    );
    return `📎 ${truncateBaleQueueSummary(fileName, 4, 32) || "attachment"}`;
  }
  if (files.length > 1) return `📎 ${files.length} attachments`;
  return "(empty message)";
}

function appendBaleSourceContext(
  text: string,
  sourceContext: string | undefined,
): string {
  if (!sourceContext) return text;
  return text ? `${text}\n\n${sourceContext}` : sourceContext;
}

function buildBaleForwardContextBlock(options: {
  context: string;
  text: string;
  files: DownloadedBaleTurnFile[];
}): string {
  const metadata = options.context.replace(/:\s+/g, ":");
  const from = metadata.match(/^from:(.+)$/)?.[1];
  let block = `[forward|${metadata}]${options.text ? ` ${options.text}` : ""}`;
  if (options.files.length === 0) return block;
  const dirs = [...new Set(options.files.map((file) => dirname(file.path)))];
  const sameDir = dirs.length === 1;
  const header = `[attachments${from ? `|from:${from}` : ""}]${
    sameDir ? ` ${dirs[0]}` : ""
  }`;
  const items = sameDir
    ? options.files.map((file) => `/${basename(file.path)}`)
    : options.files.map((file) => file.path);
  block += `\n\n${header}\n${items.map((item) => `- ${item}`).join("\n")}`;
  return block;
}

function appendBalePromptText(prompt: string, rawText: string): string {
  if (!rawText) return prompt;
  if (rawText.startsWith("\n")) return `${prompt}${rawText}`;
  return `${prompt} ${rawText}`;
}

function appendBaleVoiceContext(
  prompt: string,
  entries: Record<string, string>,
): string {
  const prefix = prompt.length > 0 ? `${prompt}\n\n` : "";
  const pairs = Object.entries(entries);
  if (pairs.length === 1) {
    const [key, value] = pairs[0];
    return `${prefix}[voice] ${key}: ${value}`;
  }
  return `${prefix}[voice]\n${pairs
    .map(([key, value]) => `- ${key}: ${value}`)
    .join("\n")}`;
}

// --- Voice Policy And Tagging ---

export function buildBaleTurnPrompt(options: {
  balePrefix: string;
  rawText: string;
  files: DownloadedBaleTurnFile[];
  promptFiles?: DownloadedBaleTurnFile[];
  displayFiles?: DownloadedBaleTurnFile[];
  handlerOutputs?: string[];
  sourceContext?: string;
  historyTurns?: Pick<PendingBaleTurn, "historyText">[];
  timeLine?: string | null;
  voiceContext?: Record<string, string>;
  guestTurn?: boolean;
}): string {
  let prompt = options.balePrefix;
  if ((options.historyTurns?.length ?? 0) > 0) {
    prompt +=
      "\n\nEarlier Bale messages arrived after an aborted turn. Treat them as prior user messages, in order:";
    for (const [index, turn] of (options.historyTurns ?? []).entries()) {
      prompt += `\n\n${index + 1}. ${turn.historyText}`;
    }
    prompt += "\n\nCurrent Bale message:";
  }
  if (options.rawText.length > 0) {
    prompt =
      (options.historyTurns?.length ?? 0) > 0
        ? `${prompt}\n${options.rawText}`
        : appendBalePromptText(prompt, options.rawText);
  }
  const displayFiles =
    options.displayFiles ?? options.promptFiles ?? options.files;
  prompt = appendBaleAttachmentSection(prompt, displayFiles);
  prompt = appendBaleListSection(
    prompt,
    "outputs",
    options.handlerOutputs ?? [],
  );
  prompt = appendBaleSourceContext(prompt, options.sourceContext);
  if (options.voiceContext) {
    prompt = appendBaleVoiceContext(prompt, options.voiceContext);
  }
  if (options.timeLine) {
    prompt = `${prompt}\n\n[time] ${options.timeLine}`;
  }
  if (options.guestTurn) {
    prompt = `${prompt}\n\n${BALE_GUEST_TURN_NOTE}`;
  }
  return prompt;
}

function splitBalePromptAttachmentSuffix(prompt: string): {
  promptWithoutAttachments: string;
  attachmentSuffix: string;
  attachmentFiles: DownloadedBaleTurnFile[];
} {
  const marker = "\n\n[attachments]";
  const markerIndex = prompt.indexOf(marker);
  if (markerIndex === -1) {
    return {
      promptWithoutAttachments: prompt,
      attachmentSuffix: "",
      attachmentFiles: [],
    };
  }
  const promptWithoutAttachments = prompt.slice(0, markerIndex);
  const attachmentSuffix = prompt.slice(markerIndex);
  const attachmentLines: string[] = [];
  let readingAttachments = false;
  let attachmentDir: string | undefined;
  for (const line of attachmentSuffix.split("\n")) {
    const trimmed = line.trim();
    const attachmentMatch = trimmed.match(/^\[attachments\](?:\s+(.+))?$/);
    if (attachmentMatch) {
      readingAttachments = true;
      attachmentDir = attachmentMatch[1]?.trim();
      continue;
    }
    if (readingAttachments && /^\[[^\]]+\](?:\s+.*)?$/.test(trimmed)) break;
    if (readingAttachments) attachmentLines.push(line);
  }
  const attachmentFiles = attachmentLines
    .map((line) => line.match(/^- (.+)$/)?.[1]?.trim())
    .filter((path): path is string => !!path)
    .map((path) =>
      attachmentDir ? join(attachmentDir, path.replace(/^\/+/, "")) : path,
    )
    .map((path) => ({
      path,
      fileName: basename(path),
      isImage: false,
      kind: "document" as const,
    }));
  return { promptWithoutAttachments, attachmentSuffix, attachmentFiles };
}

function buildEditedBalePromptText(options: {
  existingPrompt: string;
  balePrefix: string;
  rawText: string;
}): { text: string; attachmentFiles: DownloadedBaleTurnFile[] } {
  const { promptWithoutAttachments, attachmentSuffix, attachmentFiles } =
    splitBalePromptAttachmentSuffix(options.existingPrompt);
  const currentMessageMarker = "Current Bale message:";
  const currentMessageIndex =
    promptWithoutAttachments.lastIndexOf(currentMessageMarker);
  if (currentMessageIndex !== -1) {
    const prefix = promptWithoutAttachments.slice(
      0,
      currentMessageIndex + currentMessageMarker.length,
    );
    const separator = options.rawText.length > 0 ? "\n" : "";
    return {
      text: `${prefix}${separator}${options.rawText}${attachmentSuffix}`,
      attachmentFiles,
    };
  }
  return {
    text: `${appendBalePromptText(
      options.balePrefix,
      options.rawText,
    )}${attachmentSuffix}`,
    attachmentFiles,
  };
}

export function updateBalePromptTurnText(options: {
  turn: PendingBaleTurn;
  balePrefix: string;
  rawText: string;
  statusText?: string;
}): PendingBaleTurn {
  let attachmentFiles: DownloadedBaleTurnFile[] = [];
  const nextContent = options.turn.content.map((block, index) => {
    if (index !== 0 || block.type !== "text") return block;
    const updated = buildEditedBalePromptText({
      existingPrompt: block.text,
      balePrefix: options.balePrefix,
      rawText: options.rawText,
    });
    attachmentFiles = updated.attachmentFiles;
    return {
      ...block,
      text: updated.text,
    };
  });
  return {
    ...options.turn,
    content: nextContent,
    historyText: formatBaleHistoryText(options.rawText, attachmentFiles),
    statusSummary: formatBaleTurnStatusSummary(
      options.statusText ?? options.rawText,
      attachmentFiles,
    ),
  };
}

export function updateQueuedBalePromptTurnText<
  TContext = unknown,
>(options: {
  items: BaleQueueItem<TContext>[];
  sourceMessageId: number | undefined;
  balePrefix: string;
  rawText: string;
  statusText?: string;
}): { items: BaleQueueItem<TContext>[]; changed: boolean } {
  if (options.sourceMessageId === undefined) {
    return { items: options.items, changed: false };
  }
  let changed = false;
  const items = options.items.map((item) => {
    if (
      item.kind !== "prompt" ||
      !item.sourceMessageIds.includes(options.sourceMessageId as number)
    ) {
      return item;
    }
    changed = true;
    return updateBalePromptTurnText({
      turn: item,
      balePrefix: options.balePrefix,
      rawText: options.rawText,
      statusText: options.statusText,
    });
  });
  return { items, changed };
}

export interface BaleQueuedPromptEditRuntimeDeps<
  TContext = unknown,
> extends BaleQueueStore<TContext> {
  updateStatus: (ctx: TContext) => void;
}

export function createBaleQueuedPromptEditRuntime<
  TMessage extends BaleMediaMessage,
  TContext = unknown,
>(deps: BaleQueuedPromptEditRuntimeDeps<TContext>) {
  return {
    updateFromEditedMessage: (message: TMessage, ctx: TContext): boolean => {
      const { changed, items } = updateQueuedBalePromptTurnText({
        items: deps.getQueuedItems(),
        sourceMessageId: message.message_id,
        balePrefix: BALE_PREFIX,
        rawText: extractBaleMessagesPromptText([message]),
        statusText: extractBaleMessagesText([message]),
      });
      deps.setQueuedItems(items);
      if (changed) deps.updateStatus(ctx);
      return changed;
    },
  };
}

export interface BuildBalePromptTurnOptions {
  balePrefix: string;
  messages: BaleTurnMessage[];
  historyTurns?: PendingBaleTurn[];
  queueOrder: number;
  rawText: string;
  statusText?: string;
  files: DownloadedBaleTurnFile[];
  promptFiles?: DownloadedBaleTurnFile[];
  displayFiles?: DownloadedBaleTurnFile[];
  handlerOutputs?: string[];
  sourceContext?: string;
  timeLine?: string | null;
  readBinaryFile: (path: string) => Promise<Uint8Array>;
  inferImageMimeType: (path: string) => string | undefined;
  voiceReplyMode?: BaleVoiceReplyMode;
  voicePromptContribution?: string;
  admissionScope?: string;
  admissionJournalBinding?: string;
}

export type BuildBalePromptTurnRuntimeOptions = Omit<
  BuildBalePromptTurnOptions,
  "readBinaryFile"
>;

export interface BalePromptTurnRuntimeBuilderDeps<
  TContext = unknown,
> extends DownloadBaleMessageFilesDeps {
  allocateQueueOrder: () => number;
  processAttachments?: (
    files: DownloadedBaleTurnFile[],
    rawText: string,
    ctx: TContext,
  ) => Promise<{
    rawText: string;
    promptFiles?: DownloadedBaleTurnFile[];
    handlerOutputs?: string[];
  }>;
  resolveTimeLine?: (chatId: number) => string | null;
  getVoiceReplyMode?: () => BaleVoiceReplyMode;
  /** Returns the visible thread label for a message target, used to add thread context to the prompt prefix. */
  getBaleThreadLabel?: (message: {
    chat: { id: number };
    message_thread_id?: number;
  }) => string | undefined;
  getAllowedUserId?: () => number | undefined;
  getAdmissionScope?: () => string | undefined;
  getAdmissionJournalBinding?: () => string | undefined;
  assertExecutionCurrent?: (message: BaleTurnMessage) => void;
}

export function createBalePromptTurnRuntimePreparer<
  TMessage extends BaleTurnMessage & BaleMediaMessage,
  TContext = unknown,
>(
  deps: BalePromptTurnRuntimeBuilderDeps<TContext>,
): (
  messages: TMessage[],
  ctx?: TContext,
) => Promise<BalePreparedPromptTurn> {
  return async (messages, ctx) => {
    const rawText = extractBaleMessagesText(messages);
    const firstMessage = messages[0];
    if (firstMessage) deps.assertExecutionCurrent?.(firstMessage);
    const replyFiles = firstMessage?.reply_to_message
      ? await downloadBaleMessageFiles(
          [firstMessage.reply_to_message as typeof firstMessage],
          { downloadFile: deps.downloadFile },
        )
      : [];
    if (firstMessage) deps.assertExecutionCurrent?.(firstMessage);
    const processedReply =
      deps.processAttachments && replyFiles.length > 0
        ? await deps.processAttachments(replyFiles, "", ctx as TContext)
        : undefined;
    if (firstMessage) deps.assertExecutionCurrent?.(firstMessage);
    const replyContext = firstMessage
      ? buildBaleReplyContextBlock(
          firstMessage,
          processedReply?.promptFiles ?? replyFiles,
          processedReply?.handlerOutputs,
        )
      : "";
    const forwardEntries = messages.flatMap((message) => {
      const context = extractBaleForwardContextText(
        message,
        deps.getAllowedUserId?.(),
      );
      return context
        ? [
            {
              context,
              text: extractBaleMessageText(message),
              message,
              fileNames: new Set(
                collectBaleFileInfos([message]).map(
                  (file) => file.fileName,
                ),
              ),
            },
          ]
        : [];
    });
    const files = await downloadBaleMessageFiles(messages, {
      downloadFile: deps.downloadFile,
    });
    if (firstMessage) deps.assertExecutionCurrent?.(firstMessage);
    const processed = deps.processAttachments
      ? await deps.processAttachments(files, rawText, ctx as TContext)
      : { rawText, promptFiles: files };
    if (firstMessage) deps.assertExecutionCurrent?.(firstMessage);
    const sourceBlocks: string[] = [];
    let promptRawText = processed.rawText;
    const forwardedFilePaths = new Set<string>();
    const getForwardFiles = (entry: (typeof forwardEntries)[number]) =>
      (processed.promptFiles ?? files).filter((file) => {
        if (!entry.fileNames.has(file.fileName)) return false;
        forwardedFilePaths.add(file.path);
        return true;
      });
    if (forwardEntries.length === 1 && messages.length === 1) {
      const [forward] = forwardEntries;
      sourceBlocks.push(
        buildBaleForwardContextBlock({
          context: forward!.context,
          text: processed.rawText,
          files: getForwardFiles(forward!),
        }),
      );
      promptRawText = "";
    } else if (forwardEntries.length > 0 && processed.rawText === rawText) {
      const forwardedMessages = new Set(
        forwardEntries.map((entry) => entry.message),
      );
      promptRawText = messages
        .filter((message) => !forwardedMessages.has(message))
        .map(extractBaleMessageText)
        .filter(Boolean)
        .join("\n\n");
      sourceBlocks.push(
        ...forwardEntries.map((entry) =>
          buildBaleForwardContextBlock({
            context: entry.context,
            text: entry.text,
            files: getForwardFiles(entry),
          }),
        ),
      );
    } else if (forwardEntries.length > 0) {
      sourceBlocks.push(
        ...forwardEntries.map((entry) =>
          buildBaleForwardContextBlock({
            context: entry.context,
            text: "",
            files: getForwardFiles(entry),
          }),
        ),
      );
    }
    if (replyContext) sourceBlocks.push(replyContext);
    const sourceContext = sourceBlocks.join("\n\n");
    // Compute voice mode once and pass it to both the turn builder and the prompt contribution helper
    const voiceReplyMode = deps.getVoiceReplyMode?.();
    const chatId = messages[0]?.chat.id;
    const timeLine =
      deps.resolveTimeLine && chatId !== undefined
        ? deps.resolveTimeLine(chatId)
        : null;
    const threadLabel = firstMessage
      ? deps.getBaleThreadLabel?.(firstMessage)
      : undefined;
    const balePrefix = createBaleTurnPrefix({
      thread: threadLabel,
      "from-thread": firstMessage?.pi_bale_agent_source_thread,
    });
    const buildTurn = await prepareBalePromptTurn({
      balePrefix,
      messages,
      readBinaryFile: readFile,
      rawText: promptRawText,
      sourceContext,
      statusText: processed.rawText,
      files,
      promptFiles: processed.promptFiles,
      displayFiles: (processed.promptFiles ?? files).filter(
        (file) => !forwardedFilePaths.has(file.path),
      ),
      handlerOutputs: processed.handlerOutputs,
      timeLine,
      inferImageMimeType: guessMediaType,
      voiceReplyMode,
      voicePromptContribution: computeVoicePromptContribution(
        voiceReplyMode,
        files,
        rawText,
      ),
      admissionScope: deps.getAdmissionScope?.(),
      admissionJournalBinding: deps.getAdmissionJournalBinding?.(),
    });
    return (historyTurns) => {
      if (firstMessage) deps.assertExecutionCurrent?.(firstMessage);
      return buildTurn(deps.allocateQueueOrder(), historyTurns);
    };
  };
}

function getBaleVoicePromptContext(
  voiceReplyMode: BaleVoiceReplyMode,
  hasVoiceFile: boolean,
): Record<string, string> | undefined {
  if (
    voiceReplyMode !== "always" &&
    !(voiceReplyMode === "mirror" && hasVoiceFile)
  ) {
    return undefined;
  }
  return { delivery: "automatic voice" };
}

function collectBaleTurnAdmissionReceipts(
  messages: BaleTurnMessage[],
  historyTurns: PendingBaleTurn[],
  admissionScope: string | undefined,
  admissionJournalBinding: string | undefined,
): BaleQueueAdmissionReceipt[] {
  const receipts = new Map<string, BaleQueueAdmissionReceipt>();
  const addReceipt = (receipt: BaleQueueAdmissionReceipt): void => {
    const existing = receipts.get(receipt.receiptId);
    if (existing) {
      if (
        existing.queueKind !== receipt.queueKind ||
        existing.journalBindingKey !== receipt.journalBindingKey ||
        existing.sourceUpdateIds.length !== receipt.sourceUpdateIds.length ||
        existing.sourceUpdateIds.some(
          (updateId, index) => updateId !== receipt.sourceUpdateIds[index],
        )
      ) {
        throw new Error(
          `Conflicting Bale turn receipt: ${receipt.receiptId}`,
        );
      }
      return;
    }
    receipts.set(receipt.receiptId, structuredClone(receipt));
  };
  for (const turn of historyTurns) {
    for (const receipt of turn.admissionReceipts ?? []) addReceipt(receipt);
  }
  const sourceUpdateIds = messages.flatMap((message) =>
    typeof message.pi_bale_source_update_id === "number"
      ? [message.pi_bale_source_update_id]
      : [],
  );
  if (sourceUpdateIds.length > 0) {
    const currentReceipt = createBaleQueueAdmissionReceipt({
      queueKind: "prompt",
      scope: admissionScope ?? "",
      sourceUpdateIds,
    });
    if (currentReceipt) {
      addReceipt({
        ...currentReceipt,
        ...(admissionJournalBinding
          ? { journalBindingKey: admissionJournalBinding }
          : {}),
      });
    }
  }
  return [...receipts.values()];
}

async function prepareBalePromptTurn(
  options: Omit<BuildBalePromptTurnOptions, "queueOrder" | "historyTurns">,
): Promise<
  (
    queueOrder: number,
    historyTurns: PendingBaleTurn[],
  ) => PendingBaleTurn
> {
  const images: BalePromptContent[] = [];
  for (const file of options.files) {
    if (!file.isImage) continue;
    const mediaType = file.mimeType || options.inferImageMimeType(file.path);
    if (!mediaType) continue;
    const buffer = await options.readBinaryFile(file.path);
    images.push({
      type: "image",
      data: Buffer.from(buffer).toString("base64"),
      mimeType: mediaType,
    });
  }
  return (queueOrder, historyTurns) =>
    buildPreparedBalePromptTurn(
      { ...options, queueOrder, historyTurns },
      images,
    );
}

function buildPreparedBalePromptTurn(
  options: BuildBalePromptTurnOptions,
  images: BalePromptContent[],
): PendingBaleTurn {
  const firstMessage = options.messages[0];
  if (!firstMessage) {
    throw new Error("Missing Bale message for turn creation");
  }
  const hasVoiceFile = options.files.some(
    (f) => f.kind === "voice" || f.kind === "audio",
  );
  const voiceReplyMode = options.voiceReplyMode ?? getBaleVoiceReplyMode();
  const content: BalePromptContent[] = [
    {
      type: "text",
      text: buildBaleTurnPrompt({
        balePrefix: formatBaleTurnPrefix(
          firstMessage,
          options.balePrefix,
        ),
        rawText: options.rawText,
        files: options.files,
        promptFiles: options.promptFiles,
        displayFiles: options.displayFiles,
        handlerOutputs: options.handlerOutputs,
        sourceContext: options.sourceContext,
        historyTurns: options.historyTurns,
        timeLine: options.timeLine,
        voiceContext: getBaleVoicePromptContext(
          voiceReplyMode,
          hasVoiceFile,
        ),
      }),
    },
    ...images,
  ];
  if (options.voicePromptContribution?.trim()) {
    const textItem = content.find((c) => c.type === "text") as
      { type: "text"; text: string } | undefined;
    if (textItem) {
      textItem.text = `${textItem.text}\n\n${options.voicePromptContribution.trim()}`;
    }
  }
  const admissionReceipts = collectBaleTurnAdmissionReceipts(
    options.messages,
    options.historyTurns ?? [],
    options.admissionScope,
    options.admissionJournalBinding,
  );

  return {
    kind: "prompt",
    chatId: firstMessage.chat.id,
    target: getBaleTurnTarget(firstMessage),
    replyToMessageId: Reflect.get(firstMessage, REPLY_ANCHOR_SUPPRESSED) === true ? 0 : firstMessage.message_id,
    sourceMessageIds: collectBaleMessageIds(options.messages),
    queueOrder: options.queueOrder,
    queueLane: "default",
    laneOrder: options.queueOrder,
    queuedAttachments: [],
    content,
    historyText: appendBaleSourceContext(
      formatBaleHistoryText(
        options.rawText,
        options.displayFiles ?? options.promptFiles ?? options.files,
        options.handlerOutputs,
      ),
      options.sourceContext,
    ),
    statusSummary: formatBaleTurnStatusSummary(
      options.statusText ?? options.rawText,
      options.displayFiles ?? options.promptFiles ?? options.files,
      options.handlerOutputs,
    ),
    ...(admissionReceipts.length > 0 ? { admissionReceipts } : {}),
    // Voice tagging (used for preview suppression and prompt guidance)
    ...computeVoiceTurnFlags(voiceReplyMode, hasVoiceFile),
  };
}

export async function buildBalePromptTurn(
  options: BuildBalePromptTurnOptions,
): Promise<PendingBaleTurn> {
  const buildTurn = await prepareBalePromptTurn(options);
  return buildTurn(options.queueOrder, options.historyTurns ?? []);
}

export async function buildBalePromptTurnRuntime(
  options: BuildBalePromptTurnRuntimeOptions,
): Promise<PendingBaleTurn> {
  return buildBalePromptTurn({
    ...options,
    readBinaryFile: readFile,
  });
}

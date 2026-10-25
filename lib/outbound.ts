/**
 * Bale outbound surface helpers
 * Zones: bale outbound, command templates, voice delivery
 * Owns configured outbound handler execution, text transforms, public assistant-output reply composition and mutation fencing, voice-file generation/delivery, runtime-event bridge, and compatibility re-exports; assistant markup parsing lives in outbound-markup and button callback actions live in outbound-buttons
 */

import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import type { BaleAssistantSegmentEvent } from "./activity.ts";
import {
  planBaleButtonReply,
  type BaleButtonActionStore,
  type BaleOutboundButtonBinding,
  type BaleOutboundButtonMarkup,
} from "./outbound-buttons.ts";
import {
  planBaleVoiceReply,
  stripBaleCommentMarkupForDelivery,
  type BaleVoiceReplyItem,
} from "./outbound-markup.ts";
import { createBaleVoiceReplySender as createBaleVoiceReplySenderWithPorts } from "./outbound-voice.ts";
import { resolveBaleAttachmentsDir } from "./paths.ts";
import type { BalePreparedPreviewDelivery } from "./preview.ts";
import * as Replies from "./replies.ts";
import type { BaleTarget } from "./target.ts";
import type {
  BaleEditMessageTextBody,
  BaleSendMessageBody,
  BaleSendRichMessageBody,
  BaleSentMessage,
} from "./bale-api.ts";
import {
  assertBaleApiCallAuthority,
  isBaleApiCommitUnknownError,
} from "./bale-api.ts";

const OUTBOUND_HANDLER_REGISTRY_KEY = "__piBaleOutboundHandlers__";
const VOICE_EVENT_RECORDER_KEY = "__piBaleVoiceEventRecorder__";

import {
  buildCommandTemplateInvocation,
  createCommandTemplateRecovery,
  getCommandTemplateCompositionSteps,
  shouldRunCommandTemplateConfig,
  getCommandTemplateConfiguredTimeout,
  getCommandTemplateStepTimeout,
  resolveCommandTemplateNumericField,
  type CommandTemplateObjectConfig,
} from "./command-templates.ts";
const DEFAULT_VOICE_TIMEOUT_MS = 120_000;

// --- Types ---

/**
 * Record a runtime event that appears in `/bale-status`.
 * Voice synthesis provider extensions can call this to surface diagnostics
 * alongside pi-bale's own events. Events are silently dropped
 * when pi-bale is not loaded.
 */
export type BaleRuntimeEventRecorder = (
  category: string,
  error: unknown,
  details?: Record<string, unknown>,
) => void;

export function bindBaleRuntimeEventRecorder(
  recorder: BaleRuntimeEventRecorder,
): void {
  (globalThis as Record<string, unknown>)[VOICE_EVENT_RECORDER_KEY] = recorder;
}

export function recordBaleRuntimeEvent(
  category: string,
  error: unknown,
  details?: Record<string, unknown>,
): void {
  const recorder = (globalThis as Record<string, unknown>)[
    VOICE_EVENT_RECORDER_KEY
  ];
  if (typeof recorder === "function") {
    (recorder as BaleRuntimeEventRecorder)(category, error, details);
  }
}

export type BaleOutboundCommandTemplateConfig =
  string | CommandTemplateObjectConfig;
export interface BaleOutboundHandlerConfig extends CommandTemplateObjectConfig {
  type?: string;
  match?: string | string[];
  output?: string;
  timeout?: number | string;
}

export interface BaleVoiceExecOptions {
  cwd?: string;
  timeout?: number;
  signal?: AbortSignal;
  stdin?: string;
  retry?: number;
  recover?: () => Promise<void>;
}

export interface BaleVoiceExecResult {
  stdout: string;
  stderr: string;
  code: number;
  killed: boolean;
}

export interface BaleVoiceReplyTurnView {
  chatId: number;
  replyToMessageId: number;
  target?: BaleTarget;
}

export interface BaleVoiceReplySenderDeps {
  execCommand: (
    command: string,
    args: string[],
    options?: BaleVoiceExecOptions,
  ) => Promise<BaleVoiceExecResult>;
  sendMultipart: (
    method: string,
    fields: Record<string, string>,
    fileField: string,
    filePath: string,
    fileName: string,
  ) => Promise<unknown>;
  sendTextReply?: (
    chatId: number,
    replyToMessageId: number | undefined,
    text: string,
    options?: { parseMode?: "HTML" },
  ) => Promise<unknown>;
  sendChatAction?: (chatId: number, action: string) => Promise<unknown>;
  sendRecordVoiceAction?: (chatId: number) => Promise<unknown>;
  isDeliveryActive?: () => boolean;
  getHandlers?: () => BaleOutboundHandlerConfig[] | undefined;
  cwd?: string;
  tempDir?: string;
  recordRuntimeEvent?: (
    category: string,
    error: unknown,
    details?: Record<string, unknown>,
  ) => void;
}

// --- Programmatic Outbound Handler Registry ---

export type BaleOutboundProgrammaticHandler = (
  text: string,
  options?: { lang?: string; rate?: string },
) => Promise<string>;

export interface BaleOutboundHandlerRegistry {
  handlers: Map<string, BaleOutboundProgrammaticHandler[]>;
}

// --- Programmatic Outbound Handler Registry Runtime ---

function getOrCreateOutboundHandlerRegistry(): BaleOutboundHandlerRegistry {
  const existing = (globalThis as Record<string, unknown>)[
    OUTBOUND_HANDLER_REGISTRY_KEY
  ];
  if (
    existing &&
    typeof existing === "object" &&
    existing !== null &&
    "handlers" in existing &&
    existing.handlers instanceof Map
  ) {
    return existing as BaleOutboundHandlerRegistry;
  }
  const registry: BaleOutboundHandlerRegistry = {
    handlers: new Map(),
  };
  (globalThis as Record<string, unknown>)[OUTBOUND_HANDLER_REGISTRY_KEY] =
    registry;
  return registry;
}

export function registerBaleOutboundHandler(
  kind: string,
  handler: BaleOutboundProgrammaticHandler,
): () => void {
  const registry = getOrCreateOutboundHandlerRegistry();
  const list = registry.handlers.get(kind) ?? [];
  list.push(handler);
  registry.handlers.set(kind, list);
  return () => {
    const updated = registry.handlers.get(kind) ?? [];
    const index = updated.indexOf(handler);
    if (index !== -1) {
      updated.splice(index, 1);
      registry.handlers.set(kind, updated);
    }
  };
}

function getBaleOutboundProgrammaticHandlers(
  kind: string,
): BaleOutboundProgrammaticHandler[] {
  const registry = getOrCreateOutboundHandlerRegistry();
  return [...(registry.handlers.get(kind) ?? [])];
}

export interface BaleOutboundTextReplyRuntimeDeps<TReplyMarkup = unknown> {
  execCommand: BaleVoiceReplySenderDeps["execCommand"];
  getHandlers?: () => BaleOutboundHandlerConfig[] | undefined;
  sendTextReply: (
    chatId: number,
    replyToMessageId: number | undefined,
    text: string,
    options?: { parseMode?: "HTML"; target?: BaleTarget } & Pick<
      Replies.BaleReplyTargetOptions,
      "assertAuthority"
    >,
  ) => Promise<number | undefined>;
  sendMarkdownReply: (
    chatId: number,
    replyToMessageId: number | undefined,
    markdown: string,
    options?: { replyMarkup?: TReplyMarkup; target?: BaleTarget } & Pick<
      Replies.BaleReplyTargetOptions,
      "assertAuthority"
    >,
  ) => Promise<number | undefined>;
  cwd?: string;
  recordRuntimeEvent?: BaleVoiceReplySenderDeps["recordRuntimeEvent"];
}

export interface BaleInlineKeyboardLike {
  inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
}

export interface BaleOutboundTextTransformOptions<TReplyMarkup = unknown> {
  handlers?: BaleOutboundHandlerConfig[];
  cwd?: string;
  execCommand: BaleVoiceReplySenderDeps["execCommand"];
  recordRuntimeEvent?: BaleVoiceReplySenderDeps["recordRuntimeEvent"];
  replyMarkup?: TReplyMarkup;
}

export interface BaleOutboundTextTransformResult<TReplyMarkup = unknown> {
  text: string;
  replyMarkup?: TReplyMarkup;
}

export interface BaleOutboundTextPreviewRuntimeDeps<
  TReplyMarkup = unknown,
> {
  execCommand: BaleVoiceReplySenderDeps["execCommand"];
  getHandlers?: () => BaleOutboundHandlerConfig[] | undefined;
  finalizeMarkdownPreview: BalePreparedPreviewDelivery<TReplyMarkup>["finalizeMarkdownPreview"];
  preparePreviewDelivery?: (
    isDeliveryActive: () => boolean,
  ) => BalePreparedPreviewDelivery<TReplyMarkup>;
  cwd?: string;
  recordRuntimeEvent?: BaleVoiceReplySenderDeps["recordRuntimeEvent"];
}

// --- Voice Reply Timeout Helpers ---

function getVoiceReplyTimeout(
  config: BaleOutboundCommandTemplateConfig | undefined,
): number {
  return (
    getCommandTemplateConfiguredTimeout(config) ?? DEFAULT_VOICE_TIMEOUT_MS
  );
}

function formatVoiceReplyExecutionFailure(
  label: string,
  result: BaleVoiceExecResult,
): string {
  const parts = [
    `${label} exited with code ${result.code}${result.killed ? " (killed)" : ""}`,
  ];
  if (result.stderr.trim()) parts.push(`stderr:\n${result.stderr.trimEnd()}`);
  if (result.stdout.trim()) parts.push(`stdout:\n${result.stdout.trimEnd()}`);
  return parts.join("\n\n");
}

function withCommandTemplateRecovery(
  recover: (() => Promise<void>) | undefined,
): Pick<BaleVoiceExecOptions, "recover"> {
  return recover ? { recover } : {};
}

async function runVoiceReplyCommand(
  label: string,
  config: BaleOutboundCommandTemplateConfig,
  values: Record<string, string>,
  options: {
    cwd: string;
    timeout: number;
    execCommand: BaleVoiceReplySenderDeps["execCommand"];
    stdin?: string;
  },
): Promise<BaleVoiceExecResult> {
  if (!options.execCommand) {
    throw new Error("execCommand is required for command template execution");
  }
  const invocation = buildCommandTemplateInvocation(
    config,
    values,
    options.cwd,
    {
      emptyMessage: "Outbound voice template is empty",
      missingLabel: "outbound voice template",
    },
  );
  const result = await options.execCommand(
    invocation.command,
    invocation.args,
    {
      cwd: options.cwd,
      timeout: options.timeout,
      ...(typeof config === "object" && config.retry !== undefined
        ? {
            retry: resolveCommandTemplateNumericField(
              config.retry,
              {},
              "retry",
            ),
            ...withCommandTemplateRecovery(
              createCommandTemplateRecovery(config, values, {
                cwd: options.cwd,
                timeout: options.timeout,
                execCommand: options.execCommand,
              }),
            ),
          }
        : {}),
      ...(options.stdin !== undefined ? { stdin: options.stdin } : {}),
    },
  );
  if (result.code !== 0)
    throw new Error(formatVoiceReplyExecutionFailure(label, result));
  return result;
}

function normalizeOutboundHandlerStringList(
  value: string | string[] | undefined,
): string[] {
  if (Array.isArray(value))
    return value
      .map(String)
      .map((item) => item.trim())
      .filter(Boolean);
  if (typeof value === "string" && value.trim()) return [value.trim()];
  return [];
}

function outboundHandlerMatchesType(
  handler: BaleOutboundHandlerConfig,
  type: string,
): boolean {
  const selectors = [
    ...normalizeOutboundHandlerStringList(handler.type),
    ...normalizeOutboundHandlerStringList(handler.match),
  ];
  if (selectors.length === 0) return false;
  return selectors.includes(type);
}

export function findBaleOutboundHandlers(
  handlers: BaleOutboundHandlerConfig[] | undefined,
  type: string,
): BaleOutboundHandlerConfig[] {
  if (!Array.isArray(handlers)) return [];
  return handlers.filter(
    (handler) =>
      !!handler &&
      typeof handler === "object" &&
      outboundHandlerMatchesType(handler, type),
  );
}

function extractVoiceReplyPath(stdout: string): string {
  const path = stdout.trim().split(/\r?\n/).filter(Boolean).at(-1);
  if (!path) throw new Error("Voice generator did not print an output path");
  return path;
}

function getVoiceReplyOutputPath(
  config: BaleOutboundHandlerConfig,
  values: Record<string, string>,
  stdout: string,
): string {
  const output = config.output ?? "stdout";
  if (output === "stdout") return extractVoiceReplyPath(stdout);
  const keyMatch = output.match(/^\{?([A-Za-z_][A-Za-z0-9_-]*)\}?$/);
  if (keyMatch && Object.hasOwn(values, keyMatch[1])) {
    return values[keyMatch[1]] ?? "";
  }
  return output.replace(
    /\{([A-Za-z_][A-Za-z0-9_-]*)\}/g,
    (_match, key: string) => values[key] ?? "",
  );
}

function getVoiceReplyTemplateValues(
  text: string,
  options: { lang?: string; rate?: string; mp3Path: string; oggPath: string },
): Record<string, string> {
  return {
    text,
    type: "voice",
    mp3: options.mp3Path,
    ogg: options.oggPath,
    ...(options.lang ? { lang: options.lang } : {}),
    ...(options.rate ? { rate: options.rate } : {}),
  };
}

function getDefaultBaleVoiceTempDir(): string {
  return resolveBaleAttachmentsDir();
}

async function generateBaleVoiceReplyFileWithHandler(
  text: string,
  options: {
    lang?: string;
    rate?: string;
    handler: BaleOutboundHandlerConfig;
    tempDir: string;
    cwd: string;
    timeout: number;
    execCommand: BaleVoiceReplySenderDeps["execCommand"];
  },
): Promise<string | undefined> {
  await mkdir(options.tempDir, { recursive: true });
  const artifactId = randomUUID();
  const values = getVoiceReplyTemplateValues(text, {
    lang: options.lang,
    rate: options.rate,
    mp3Path: join(options.tempDir, `${artifactId}-voice.mp3`),
    oggPath: join(options.tempDir, `${artifactId}-voice.ogg`),
  });
  if (!shouldRunCommandTemplateConfig(options.handler, values))
    return undefined;
  const steps = getCommandTemplateCompositionSteps(options.handler);
  if (steps.length > 0) {
    const startedAt = Date.now();
    let stdout = text;
    for (const [index, step] of steps.entries()) {
      if (!shouldRunCommandTemplateConfig(step, values)) continue;
      try {
        const result = await runVoiceReplyCommand(
          `Outbound voice template step ${index + 1}`,
          step,
          values,
          {
            cwd: options.cwd,
            timeout: getCommandTemplateStepTimeout(
              options.timeout,
              step,
              Date.now() - startedAt,
            ),
            execCommand: options.execCommand,
            stdin: stdout,
          },
        );
        stdout = result.stdout;
      } catch (error) {
        if (typeof step === "object" && step.failure === "root") throw error;
        stdout = "";
      }
    }
    return getVoiceReplyOutputPath(options.handler, values, stdout);
  }
  const result = await runVoiceReplyCommand(
    "Outbound voice template",
    options.handler,
    values,
    {
      cwd: options.cwd,
      timeout: options.timeout,
      execCommand: options.execCommand,
      stdin: text,
    },
  );
  return getVoiceReplyOutputPath(options.handler, values, result.stdout);
}

export async function generateBaleVoiceReplyFile(
  text: string,
  options: {
    lang?: string;
    rate?: string;
    handler?: BaleOutboundHandlerConfig;
    tempDir?: string;
    cwd?: string;
    execCommand: BaleVoiceReplySenderDeps["execCommand"];
  },
): Promise<string | undefined> {
  const handler = options.handler;
  if (!handler?.template) return undefined;
  return generateBaleVoiceReplyFileWithHandler(text, {
    lang: options.lang,
    rate: options.rate,
    handler,
    tempDir: options.tempDir ?? getDefaultBaleVoiceTempDir(),
    cwd: options.cwd ?? process.cwd(),
    timeout: getVoiceReplyTimeout(handler),
    execCommand: options.execCommand,
  });
}

function getOutboundTextTemplateValues(text: string): Record<string, string> {
  return { text, type: "text" };
}

async function transformBaleOutboundTextWithHandler(
  text: string,
  options: {
    handler: BaleOutboundHandlerConfig;
    cwd: string;
    execCommand: BaleVoiceReplySenderDeps["execCommand"];
  },
): Promise<string> {
  const values = getOutboundTextTemplateValues(text);
  if (!shouldRunCommandTemplateConfig(options.handler, values)) return text;
  const steps = getCommandTemplateCompositionSteps(options.handler);
  if (steps.length > 0) {
    const startedAt = Date.now();
    let stdout = text;
    for (const [index, step] of steps.entries()) {
      if (!shouldRunCommandTemplateConfig(step, values)) continue;
      try {
        const result = await runVoiceReplyCommand(
          `Outbound text template step ${index + 1}`,
          step,
          values,
          {
            cwd: options.cwd,
            timeout: getCommandTemplateStepTimeout(
              getVoiceReplyTimeout(options.handler),
              step,
              Date.now() - startedAt,
            ),
            execCommand: options.execCommand,
            stdin: stdout,
          },
        );
        stdout = result.stdout;
      } catch (error) {
        if (typeof step === "object" && step.failure === "root") throw error;
        stdout = "";
      }
      if (!stdout) stdout = text;
    }
    return stdout.trim() || text;
  }
  const result = await runVoiceReplyCommand(
    "Outbound text template",
    options.handler,
    values,
    {
      cwd: options.cwd,
      timeout: getVoiceReplyTimeout(options.handler),
      execCommand: options.execCommand,
      stdin: text,
    },
  );
  return result.stdout.trim() || text;
}

async function transformBaleOutboundText(
  text: string,
  options: {
    handlers?: BaleOutboundHandlerConfig[];
    cwd?: string;
    execCommand: BaleVoiceReplySenderDeps["execCommand"];
    recordRuntimeEvent?: BaleVoiceReplySenderDeps["recordRuntimeEvent"];
  },
): Promise<string> {
  let transformed = text;
  for (const handler of findBaleOutboundHandlers(
    options.handlers,
    "text",
  )) {
    try {
      transformed = await transformBaleOutboundTextWithHandler(
        transformed,
        {
          handler,
          cwd: options.cwd ?? process.cwd(),
          execCommand: options.execCommand,
        },
      );
    } catch (error) {
      options.recordRuntimeEvent?.("outbound-text-handler", error, {
        handler: outboundHandlerMatchesType(handler, "text")
          ? "text"
          : "unknown",
      });
    }
  }
  return transformed;
}

function isBaleInlineKeyboardLike(
  replyMarkup: unknown,
): replyMarkup is BaleInlineKeyboardLike {
  if (!replyMarkup || typeof replyMarkup !== "object") return false;
  const keyboard = (replyMarkup as { inline_keyboard?: unknown })
    .inline_keyboard;
  return Array.isArray(keyboard);
}

async function transformBaleOutboundReplyMarkup<TReplyMarkup>(
  replyMarkup: TReplyMarkup | undefined,
  options: Omit<BaleOutboundTextTransformOptions, "replyMarkup">,
): Promise<TReplyMarkup | undefined> {
  if (!isBaleInlineKeyboardLike(replyMarkup)) return replyMarkup;
  const translatedRows = [];
  for (const row of replyMarkup.inline_keyboard) {
    const translatedRow = [];
    for (const button of row) {
      const text = await transformBaleOutboundText(button.text, options);
      translatedRow.push({ ...button, text });
    }
    translatedRows.push(translatedRow);
  }
  return { ...replyMarkup, inline_keyboard: translatedRows } as TReplyMarkup;
}

async function transformBaleOutboundTextReply<TReplyMarkup = unknown>(
  text: string,
  options: BaleOutboundTextTransformOptions<TReplyMarkup>,
): Promise<BaleOutboundTextTransformResult<TReplyMarkup>> {
  const transformOptions = {
    handlers: options.handlers,
    cwd: options.cwd,
    execCommand: options.execCommand,
    recordRuntimeEvent: options.recordRuntimeEvent,
  };
  const transformedText = await transformBaleOutboundText(
    text,
    transformOptions,
  );
  const replyMarkup = await transformBaleOutboundReplyMarkup(
    options.replyMarkup,
    transformOptions,
  );
  return { text: transformedText, ...(replyMarkup ? { replyMarkup } : {}) };
}

export function createBaleOutboundTextReplyRuntime<TReplyMarkup = unknown>(
  deps: BaleOutboundTextReplyRuntimeDeps<TReplyMarkup>,
): Pick<
  BaleOutboundTextReplyRuntimeDeps<TReplyMarkup>,
  "sendTextReply" | "sendMarkdownReply"
> {
  const sendTextReply = deps.sendTextReply,
    sendMarkdownReply = deps.sendMarkdownReply;
  return {
    sendTextReply: async (chatId, replyToMessageId, text, options) => {
      const capturedOptions = options && {
        ...options,
        ...(options.target ? { target: { ...options.target } } : {}),
      };
      const assertAuthority = capturedOptions?.assertAuthority;
      assertBaleApiCallAuthority(assertAuthority, false);
      const transformed = await transformBaleOutboundText(text, {
        handlers: deps.getHandlers?.(),
        cwd: deps.cwd,
        execCommand: deps.execCommand,
        recordRuntimeEvent: deps.recordRuntimeEvent,
      });
      assertBaleApiCallAuthority(assertAuthority, false);
      const messageId = await sendTextReply(
        chatId,
        replyToMessageId,
        transformed,
        capturedOptions,
      );
      assertBaleApiCallAuthority(assertAuthority, true);
      return messageId;
    },
    sendMarkdownReply: async (chatId, replyToMessageId, markdown, options) => {
      const capturedOptions = options && {
        ...options,
        ...(options.target ? { target: { ...options.target } } : {}),
      };
      const assertAuthority = capturedOptions?.assertAuthority;
      assertBaleApiCallAuthority(assertAuthority, false);
      const deliveryMarkdown = stripBaleCommentMarkupForDelivery(markdown);
      if (!deliveryMarkdown) return undefined;
      const transformed = await transformBaleOutboundTextReply(
        deliveryMarkdown,
        {
          handlers: deps.getHandlers?.(),
          cwd: deps.cwd,
          execCommand: deps.execCommand,
          recordRuntimeEvent: deps.recordRuntimeEvent,
          replyMarkup: capturedOptions?.replyMarkup,
        },
      );
      assertBaleApiCallAuthority(assertAuthority, false);
      const messageId = await sendMarkdownReply(
        chatId,
        replyToMessageId,
        transformed.text,
        {
          ...capturedOptions,
          ...(transformed.replyMarkup
            ? { replyMarkup: transformed.replyMarkup }
            : {}),
        },
      );
      assertBaleApiCallAuthority(assertAuthority, true);
      return messageId;
    },
  };
}

export function createBaleOutboundTextPreviewRuntime<
  TReplyMarkup = unknown,
>(
  deps: BaleOutboundTextPreviewRuntimeDeps<TReplyMarkup>,
): {
  finalizeMarkdownPreview: BalePreparedPreviewDelivery<TReplyMarkup>["finalizeMarkdownPreview"];
  preparePreviewDelivery: (
    isDeliveryActive: () => boolean,
  ) => BalePreparedPreviewDelivery<TReplyMarkup> | undefined;
} {
  const wrap =
    (
      finalize: BalePreparedPreviewDelivery<TReplyMarkup>["finalizeMarkdownPreview"],
    ): BalePreparedPreviewDelivery<TReplyMarkup>["finalizeMarkdownPreview"] =>
    async (chatId, markdown, replyToMessageId, options) => {
      const transformed = await transformBaleOutboundTextReply(markdown, {
        handlers: deps.getHandlers?.(),
        cwd: deps.cwd,
        execCommand: deps.execCommand,
        recordRuntimeEvent: deps.recordRuntimeEvent,
        replyMarkup: options?.replyMarkup,
      });
      return finalize(chatId, transformed.text, replyToMessageId, {
        ...options,
        ...(transformed.replyMarkup
          ? { replyMarkup: transformed.replyMarkup }
          : {}),
      });
    };
  return {
    finalizeMarkdownPreview: wrap(deps.finalizeMarkdownPreview),
    preparePreviewDelivery(isDeliveryActive) {
      const prepared = deps.preparePreviewDelivery?.(isDeliveryActive);
      return prepared
        ? {
            ...prepared,
            finalizeMarkdownPreview: wrap(prepared.finalizeMarkdownPreview),
          }
        : undefined;
    },
  };
}

export interface BaleOutboundReplyPlan<TReplyMarkup = unknown> {
  markdown: string;
  replyMarkup?: TReplyMarkup;
  voiceText?: string;
  voiceReplies?: BaleVoiceReplyItem[];
  lang?: string;
  rate?: string;
}

// --- Voice Policy Re-Exports ---
export {
  clearBaleVoiceSynthesisProviders,
  clearBaleVoiceTranscriptionProviders,
  computeVoicePromptContribution,
  computeVoiceTurnFlags,
  getBaleVoiceReplyMode,
  getBaleVoiceSynthesisProviders,
  getBaleVoiceTranscriptionProviders,
  hasBaleVoiceSynthesisProvider,
  hasBaleVoiceTranscriptionProvider,
  isVoiceTurn,
  registerBaleVoiceSynthesisProvider,
  registerBaleVoiceTranscriptionProvider,
  shouldSuppressPreviewForVoice,
  type BaleVoiceReplyMode,
  type BaleVoiceSynthesisProvider,
  type BaleVoiceSynthesisProviderResult,
  type BaleVoiceTranscriptionFile,
  type BaleVoiceTranscriptionProvider,
  type BaleVoiceTranscriptionProviderResult,
  type BaleVoiceTurnView,
} from "./voice.ts";

export function createBaleVoiceReplySender(
  deps: BaleVoiceReplySenderDeps,
) {
  return createBaleVoiceReplySenderWithPorts(deps, {
    findVoiceHandlers: (handlers) =>
      findBaleOutboundHandlers(
        handlers as BaleOutboundHandlerConfig[] | undefined,
        "voice",
      ),
    generateVoiceFile: (text, options) =>
      generateBaleVoiceReplyFile(text, {
        lang: options.lang,
        rate: options.rate,
        handler: options.handler,
        tempDir: options.tempDir,
        cwd: options.cwd,
        execCommand: options.execCommand,
      }),
    getProgrammaticVoiceHandlers: () =>
      getBaleOutboundProgrammaticHandlers("voice"),
  });
}

export {
  createBaleButtonActionStore,
  createBaleButtonPromptTurn,
  createBaleButtonReplyPlanner,
  handleBaleButtonCallbackQuery,
  markBaleButtonSelected,
  planBaleButtonReply,
  type BaleButtonActionStore,
  type BaleButtonCallbackHandlerDeps,
  type BaleButtonCallbackQuery,
  type BaleButtonReplyPlan,
  type BaleOutboundButtonAction,
  type BaleOutboundButtonBinding,
  type BaleOutboundButtonMarkup,
  type BaleOutboundButtonStoredAction,
} from "./outbound-buttons.ts";

export function createBaleOutboundReplyPlanner(
  store: Pick<BaleButtonActionStore, "register">,
  getRenderingMode: () => "rich" | "html" = () => "rich",
): (
  markdown: string,
  options?: { binding?: BaleOutboundButtonBinding },
) => BaleOutboundReplyPlan<BaleOutboundButtonMarkup> {
  return (markdown, options) => {
    const buttonReply = planBaleButtonReply(markdown, {
      registerAction: store.register,
      rendering: getRenderingMode(),
      ...(options?.binding ? { binding: options.binding } : {}),
    });

    // Button replies can also contain <!-- bale_voice --> markup
    const voiceReply = planBaleVoiceReply(buttonReply.markdown);

    return {
      markdown: voiceReply.markdown,
      ...(buttonReply.replyMarkup
        ? { replyMarkup: buttonReply.replyMarkup }
        : {}),
      ...(voiceReply.voiceText ? { voiceText: voiceReply.voiceText } : {}),
      ...(voiceReply.voiceReplies
        ? { voiceReplies: voiceReply.voiceReplies }
        : {}),
      ...(voiceReply.lang ? { lang: voiceReply.lang } : {}),
      ...(voiceReply.rate ? { rate: voiceReply.rate } : {}),
    };
  };
}

/**
 * Create an artifact sender that delivers planned voice replies for a turn.
 * Iterates over `voiceReplies` (or a single `voiceText`) and sends each as
 * a Bale voice message via the voice reply sender. Throws if no voice
 * reply could be delivered.
 */

// --- Outbound Reply Artifacts ---

export function createBaleOutboundReplyArtifactSender(
  deps: BaleVoiceReplySenderDeps,
) {
  return async (
    turn: BaleVoiceReplyTurnView,
    plan: Pick<
      BaleOutboundReplyPlan,
      "voiceText" | "voiceReplies" | "lang" | "rate" | "replyMarkup"
    >,
    options?: { replyToPrompt?: boolean; isDeliveryActive?: () => boolean },
  ): Promise<void> => {
    const isDeliveryActive = () =>
      deps.isDeliveryActive?.() !== false &&
      options?.isDeliveryActive?.() !== false;
    const sendVoiceReply = createBaleVoiceReplySender({
      ...deps,
      isDeliveryActive,
    });
    // Normalize voice replies: either use explicit voiceReplies array or fall back to voiceText
    const voiceReplies = plan.voiceReplies?.length
      ? plan.voiceReplies
      : plan.voiceText
        ? [{ text: plan.voiceText, lang: plan.lang, rate: plan.rate }]
        : [];
    // A plan without voice content has nothing to deliver; absence of
    // content is not a synthesis failure.
    if (voiceReplies.length === 0) return;

    let anyDelivered = false;

    for (const reply of voiceReplies) {
      if (!isDeliveryActive()) return;
      try {
        await sendVoiceReply(turn, reply.text, {
          lang: reply.lang ?? plan.lang,
          rate: reply.rate ?? plan.rate,
          // Only attach reply parameters to the first voice message
          replyToPrompt: options?.replyToPrompt === true && !anyDelivered,
          replyMarkup: !anyDelivered ? plan.replyMarkup : undefined,
        });
        anyDelivered = true;
      } catch (error) {
        if (isBaleApiCommitUnknownError(error)) throw error;
        // sendVoiceReply already recorded the error; continue to next reply
      }
    }

    if (!isDeliveryActive()) return;
    if (!anyDelivered) {
      throw new Error(
        "Failed to send voice reply: every voice synthesis provider failed.",
      );
    }
  };
}

// --- Public Assistant Output Delivery ---

export interface BaleAssistantOutputMutationFence {
  run: <TArgs extends unknown[], TResult>(
    mutation: (...args: TArgs) => Promise<TResult>,
    ...args: TArgs
  ) => Promise<TResult>;
}

export interface BaleAssistantOutputDeliveryAuthority<TTransportStamp> {
  transportStamp: TTransportStamp;
  route: "direct" | "follower" | "none";
  directEpoch?: number | string;
  followerGeneration?: string;
  target?: BaleTarget;
}

export function createBaleAssistantOutputMutationFence(
  isAuthorityActive: () => boolean,
): BaleAssistantOutputMutationFence {
  return {
    run(mutation, ...args) {
      if (!isAuthorityActive()) {
        return Promise.reject(
          new Error(
            "Assistant output lost admission authority before transport mutation.",
          ),
        );
      }
      return mutation(...args);
    },
  };
}

export function createBaleAssistantOutputSender<
  TTransportStamp,
  TReplyMarkup = unknown,
>(deps: {
  recordOwnership?: Replies.BaleReplyOwnershipRecorder["record"];
  sendMessage: (body: BaleSendMessageBody) => Promise<BaleSentMessage>;
  sendRichMessage: (
    body: BaleSendRichMessageBody,
  ) => Promise<BaleSentMessage>;
  editMessage: (body: BaleEditMessageTextBody) => Promise<unknown>;
  getAssistantRenderingMode: () => "rich" | "html";
  planButtonReply?: (markdown: string) => {
    markdown: string;
    replyMarkup?: TReplyMarkup;
  };
  execCommand: BaleOutboundTextReplyRuntimeDeps<TReplyMarkup>["execCommand"];
  getHandlers?: BaleOutboundTextReplyRuntimeDeps<TReplyMarkup>["getHandlers"];
  recordRuntimeEvent?: BaleOutboundTextReplyRuntimeDeps<TReplyMarkup>["recordRuntimeEvent"];
}): (
  event: BaleAssistantSegmentEvent,
  authority: BaleAssistantOutputDeliveryAuthority<TTransportStamp>,
  isAuthorityActive: () => boolean,
) => Promise<void> {
  return async function sendAssistantOutput(
    event,
    authority,
    isAuthorityActive,
  ) {
    const target = authority.target;
    if (!target) {
      throw new Error("Assistant output has no authorized Bale target.");
    }
    const mutationFence =
      createBaleAssistantOutputMutationFence(isAuthorityActive);
    const replyRuntime = Replies.createBaleRenderedMessageDeliveryRuntime({
      recordOwnership: deps.recordOwnership,
      sendMessage(body) {
        return mutationFence.run(deps.sendMessage, body);
      },
      sendRichMessage(body) {
        return mutationFence.run(deps.sendRichMessage, body);
      },
      getAssistantRenderingMode: deps.getAssistantRenderingMode,
      editMessage(body) {
        return mutationFence.run(deps.editMessage, body);
      },
    });
    const outboundRuntime = createBaleOutboundTextReplyRuntime({
      sendTextReply: replyRuntime.sendTextReply,
      sendMarkdownReply: replyRuntime.sendMarkdownReply,
      execCommand: deps.execCommand,
      getHandlers: deps.getHandlers,
      recordRuntimeEvent: deps.recordRuntimeEvent,
    });
    const buttonReply = deps.planButtonReply?.(event.text) ?? {
      markdown: event.text,
    };
    await outboundRuntime.sendMarkdownReply(
      target.chatId,
      event.source === "bale" ? event.replyToMessageId : undefined,
      buttonReply.markdown,
      {
        target,
        ...(buttonReply.replyMarkup
          ? { replyMarkup: buttonReply.replyMarkup }
          : {}),
      },
    );
  };
}

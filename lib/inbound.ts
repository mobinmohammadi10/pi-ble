/**
 * Bale inbound handler pipeline
 * Zones: bale inbound, command templates, prompt preparation
 * Owns MIME/type matching, command-template execution, fallback handling, and prompt injection before prompt enqueueing
 */

import { readFile } from "node:fs/promises";
import { basename } from "node:path";

import {
  buildCommandTemplateInvocation,
  createCommandTemplateRecovery,
  getCommandTemplateCompositionSteps,
  getCommandTemplateConfiguredTimeout,
  getCommandTemplateStepTimeout,
  normalizeCommandTemplateConfig,
  resolveCommandTemplateNumericField,
  shouldRunCommandTemplateConfig,
  type CommandTemplateConfig,
  type CommandTemplateObjectConfig,
} from "./command-templates.ts";
import { getBaleVoiceTranscriptionProviders } from "./voice.ts";

const DEFAULT_INBOUND_HANDLER_TIMEOUT_MS = 120_000;
const INBOUND_HANDLER_REGISTRY_KEY = "__piBaleInboundHandlers__";
const MAX_INBOUND_HANDLER_OUTPUT_LENGTH = 24_000;
const MAX_INBOUND_HANDLER_FAILURE_STREAM_LENGTH = 4_000;

type BaleInboundCommandTemplateConfig =
  string | CommandTemplateObjectConfig;

export interface BaleInboundHandlerConfig {
  match?: string | string[];
  mime?: string | string[];
  type?: string | string[];
  template?: string | BaleInboundCommandTemplateConfig[];
  /** Falsy skips this handler so selection continues with the next match. */
  when?: CommandTemplateObjectConfig["when"];
  args?: string[];
  defaults?: Record<string, unknown>;
  timeout?: number | string;
  retry?: CommandTemplateObjectConfig["retry"];
  recover?: CommandTemplateObjectConfig["recover"];
}

export interface BaleInboundHandlerFile {
  path: string;
  fileName?: string;
  mimeType?: string;
  kind?: string;
  isImage?: boolean;
}

export interface BaleInboundHandlerOutput {
  file: BaleInboundHandlerFile;
  output: string;
  handler: BaleInboundHandlerConfig;
}

export interface BaleInboundHandlerProcessResult<
  TFile extends BaleInboundHandlerFile = BaleInboundHandlerFile,
> {
  rawText: string;
  promptFiles: TFile[];
  handlerOutputs: string[];
  handledFiles: BaleInboundHandlerOutput[];
}

export interface BaleInboundHandlerExecOptions {
  cwd?: string;
  timeout?: number;
  signal?: AbortSignal;
  stdin?: string;
  retry?: number;
  recover?: () => Promise<void>;
}

export interface BaleInboundHandlerExecResult {
  stdout: string;
  stderr: string;
  code: number;
  killed: boolean;
}

export interface BaleInboundHandlerRuntimeDeps<TContext> {
  getHandlers: () => BaleInboundHandlerConfig[] | undefined;
  execCommand: (
    command: string,
    args: string[],
    options?: BaleInboundHandlerExecOptions,
  ) => Promise<BaleInboundHandlerExecResult>;
  getCwd: (ctx: TContext) => string;
  recordRuntimeEvent?: (
    category: string,
    error: unknown,
    details?: Record<string, unknown>,
  ) => void;
}

export interface BaleInboundHandlerRuntime<TContext> {
  process: <TFile extends BaleInboundHandlerFile>(
    files: TFile[],
    rawText: string,
    ctx: TContext,
  ) => Promise<BaleInboundHandlerProcessResult<TFile>>;
}

export type BaleInboundProgrammaticHandlerResult =
  string | { text: string } | undefined;

export interface BaleInboundProgrammaticHandlerInput {
  kind: string;
  text?: string;
  file?: BaleInboundHandlerFile;
  mimeType?: string;
}

export type BaleInboundProgrammaticHandler = (
  input: BaleInboundProgrammaticHandlerInput,
  options?: { cwd?: string },
) => Promise<BaleInboundProgrammaticHandlerResult>;

export interface BaleInboundHandlerRegistry {
  handlers: Map<string, BaleInboundProgrammaticHandler[]>;
}

interface InboundHandlerInvocation {
  command: string;
  args: string[];
}

const BUILT_IN_TEXT_ATTACHMENT_MAX_BYTES = 1_000_000;

function getOrCreateInboundHandlerRegistry(): BaleInboundHandlerRegistry {
  const existing = (globalThis as Record<string, unknown>)[
    INBOUND_HANDLER_REGISTRY_KEY
  ];
  if (
    existing &&
    typeof existing === "object" &&
    existing !== null &&
    "handlers" in existing &&
    existing.handlers instanceof Map
  ) {
    return existing as BaleInboundHandlerRegistry;
  }
  const registry: BaleInboundHandlerRegistry = {
    handlers: new Map(),
  };
  (globalThis as Record<string, unknown>)[INBOUND_HANDLER_REGISTRY_KEY] =
    registry;
  return registry;
}

export function registerBaleInboundHandler(
  kind: string,
  handler: BaleInboundProgrammaticHandler,
): () => void {
  const normalizedKind = kind.trim() || "*";
  const registry = getOrCreateInboundHandlerRegistry();
  const list = registry.handlers.get(normalizedKind) ?? [];
  list.push(handler);
  registry.handlers.set(normalizedKind, list);
  return () => {
    const updated = registry.handlers.get(normalizedKind) ?? [];
    const index = updated.indexOf(handler);
    if (index !== -1) {
      updated.splice(index, 1);
      registry.handlers.set(normalizedKind, updated);
    }
  };
}

function getBaleInboundProgrammaticHandlers(
  kind: string,
): BaleInboundProgrammaticHandler[] {
  const registry = getOrCreateInboundHandlerRegistry();
  return [
    ...(registry.handlers.get(kind) ?? []),
    ...(kind === "*" ? [] : (registry.handlers.get("*") ?? [])),
  ];
}

export function clearBaleInboundHandlers(): void {
  getOrCreateInboundHandlerRegistry().handlers.clear();
}

function truncateBaleInboundText(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength).trimEnd()}… [truncated ${text.length - maxLength} chars]`;
}

function truncateBaleInboundOutput(text: string): string {
  return truncateBaleInboundText(text, MAX_INBOUND_HANDLER_OUTPUT_LENGTH);
}

function truncateBaleInboundFailureStream(text: string): string {
  return truncateBaleInboundText(
    text.trimEnd(),
    MAX_INBOUND_HANDLER_FAILURE_STREAM_LENGTH,
  );
}

function normalizeInboundProgrammaticHandlerText(
  result: BaleInboundProgrammaticHandlerResult,
): string | undefined {
  const text = typeof result === "string" ? result : result?.text;
  const normalized = text?.trim();
  return normalized ? truncateBaleInboundOutput(normalized) : undefined;
}

function normalizeStringList(value: string | string[] | undefined): string[] {
  if (Array.isArray(value)) {
    return value
      .map(String)
      .map((item) => item.trim())
      .filter(Boolean);
  }
  if (typeof value === "string" && value.trim()) return [value.trim()];
  return [];
}

function matchesWildcard(pattern: string, value: string | undefined): boolean {
  if (!value) return false;
  const normalizedPattern = pattern.toLowerCase();
  const normalizedValue = value.toLowerCase();
  if (normalizedPattern === "*") return true;
  const escaped = normalizedPattern
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\\\*/g, ".*");
  return new RegExp(`^${escaped}$`).test(normalizedValue);
}

function handlerHasSelectors(handler: BaleInboundHandlerConfig): boolean {
  return (
    normalizeStringList(handler.match).length > 0 ||
    normalizeStringList(handler.mime).length > 0 ||
    normalizeStringList(handler.type).length > 0
  );
}

function matchesAnyPattern(
  patterns: string[],
  value: string | undefined,
): boolean {
  return patterns.some((pattern) => matchesWildcard(pattern, value));
}

function isBaleTextMimeType(mimeType: string | undefined): boolean {
  return matchesWildcard("text/*", mimeType);
}

export function baleInboundHandlerMatchesFile(
  handler: BaleInboundHandlerConfig,
  file: BaleInboundHandlerFile,
): boolean {
  if (!handlerHasSelectors(handler)) return true;
  const matchPatterns = normalizeStringList(handler.match);
  const mimePatterns = normalizeStringList(handler.mime);
  const typePatterns = normalizeStringList(handler.type);
  if (matchesAnyPattern(mimePatterns, file.mimeType)) return true;
  if (matchesAnyPattern(typePatterns, file.kind)) return true;
  if (matchesAnyPattern(matchPatterns, file.mimeType)) return true;
  return matchesAnyPattern(matchPatterns, file.kind);
}

function findBaleInboundHandlers(
  handlers: BaleInboundHandlerConfig[] | undefined,
  file: BaleInboundHandlerFile,
): BaleInboundHandlerConfig[] {
  if (!Array.isArray(handlers)) return [];
  return handlers.filter(
    (handler) =>
      !!handler &&
      typeof handler === "object" &&
      baleInboundHandlerMatchesFile(handler, file),
  );
}

function hasInboundFilePlaceholder(value: string): boolean {
  return /\{file\}/.test(value);
}

function getBaleInboundHandlerTemplateValues(
  file: BaleInboundHandlerFile,
  text = "",
): Record<string, string> {
  return {
    file: file.path,
    mime: file.mimeType ?? "",
    text,
    type: file.kind ?? "",
  };
}

function buildBaleInboundTemplateInvocation(
  handler: CommandTemplateConfig,
  file: BaleInboundHandlerFile,
  cwd: string,
  appendFileIfMissing = true,
): InboundHandlerInvocation {
  const values = getBaleInboundHandlerTemplateValues(file);
  const templateConfig = normalizeCommandTemplateConfig(handler);
  const hadFilePlaceholder =
    typeof templateConfig.template === "string"
      ? hasInboundFilePlaceholder(templateConfig.template)
      : false;
  const invocation = buildCommandTemplateInvocation(handler, values, cwd, {
    emptyMessage: "Inbound handler template is empty",
    missingLabel: "inbound handler template",
  });
  if (appendFileIfMissing && !hadFilePlaceholder)
    invocation.args.push(file.path);
  return invocation;
}

export function buildBaleInboundHandlerInvocation(
  handler: CommandTemplateConfig,
  file: BaleInboundHandlerFile,
  cwd: string,
  appendFileIfMissing = true,
): InboundHandlerInvocation {
  const { template } = normalizeCommandTemplateConfig(handler);
  if (!template) throw new Error("Inbound handler template is required");
  return buildBaleInboundTemplateInvocation(
    handler,
    file,
    cwd,
    appendFileIfMissing,
  );
}

function getBaleInboundHandlerTimeout(
  handler: BaleInboundCommandTemplateConfig,
): number {
  return (
    getCommandTemplateConfiguredTimeout(handler) ??
    DEFAULT_INBOUND_HANDLER_TIMEOUT_MS
  );
}

function getBaleInboundHandlerKind(
  handler: BaleInboundHandlerConfig,
): string {
  if (Array.isArray(handler.template)) return "composition";
  if (handler.template) return "template";
  return "unknown";
}

function formatBaleInboundHandlerFailure(
  result: BaleInboundHandlerExecResult,
): string {
  const parts = [
    `Inbound handler exited with code ${result.code}${result.killed ? " (killed)" : ""}`,
  ];
  if (result.stderr.trim())
    parts.push(
      `stderr:\n${truncateBaleInboundFailureStream(result.stderr)}`,
    );
  if (result.stdout.trim())
    parts.push(
      `stdout:\n${truncateBaleInboundFailureStream(result.stdout)}`,
    );
  return parts.join("\n\n");
}

function getBaleInboundHandlerRetryOptions(
  handler: BaleInboundCommandTemplateConfig,
  values: Record<string, string>,
  cwd: string,
  timeout: number,
  deps: Pick<BaleInboundHandlerRuntimeDeps<unknown>, "execCommand">,
): Pick<BaleInboundHandlerExecOptions, "retry" | "recover"> {
  if (typeof handler !== "object" || handler.retry === undefined) return {};
  const recover = createCommandTemplateRecovery(handler, values, {
    cwd,
    timeout,
    execCommand: deps.execCommand,
  });
  return {
    retry: resolveCommandTemplateNumericField(handler.retry, {}, "retry"),
    ...(recover ? { recover } : {}),
  };
}

async function executeBaleInboundHandlerInvocation(
  handler: BaleInboundCommandTemplateConfig,
  file: BaleInboundHandlerFile,
  cwd: string,
  deps: Pick<BaleInboundHandlerRuntimeDeps<unknown>, "execCommand">,
  appendFileIfMissing = true,
  timeout = getBaleInboundHandlerTimeout(handler),
  stdin?: string,
): Promise<string> {
  const invocation = buildBaleInboundHandlerInvocation(
    handler,
    file,
    cwd,
    appendFileIfMissing,
  );
  const result = await deps.execCommand(invocation.command, invocation.args, {
    cwd,
    timeout,
    ...getBaleInboundHandlerRetryOptions(
      handler,
      getBaleInboundHandlerTemplateValues(file),
      cwd,
      timeout,
      deps,
    ),
    ...(stdin !== undefined ? { stdin } : {}),
  });
  if (result.code !== 0)
    throw new Error(formatBaleInboundHandlerFailure(result));
  return truncateBaleInboundOutput(result.stdout);
}

function getBaleTextHandlerFile(): BaleInboundHandlerFile {
  return {
    path: "",
    fileName: "message.txt",
    mimeType: "text/plain",
    kind: "text",
    isImage: false,
  };
}

function findBaleTextHandlers(
  handlers: BaleInboundHandlerConfig[] | undefined,
): BaleInboundHandlerConfig[] {
  if (!Array.isArray(handlers)) return [];
  const textFile = getBaleTextHandlerFile();
  return handlers.filter(
    (handler) =>
      !!handler &&
      typeof handler === "object" &&
      handlerHasSelectors(handler) &&
      baleInboundHandlerMatchesFile(handler, textFile),
  );
}

function buildBaleTextHandlerInvocation(
  handler: CommandTemplateConfig,
  text: string,
  cwd: string,
): InboundHandlerInvocation {
  const values = getBaleInboundHandlerTemplateValues(
    getBaleTextHandlerFile(),
    text,
  );
  const { template } = normalizeCommandTemplateConfig(handler);
  if (!template) throw new Error("Text handler template is required");
  return buildCommandTemplateInvocation(handler, values, cwd, {
    emptyMessage: "Text handler template is empty",
    missingLabel: "text handler template",
  });
}

async function executeBaleTextHandlerInvocation(
  handler: BaleInboundCommandTemplateConfig,
  text: string,
  cwd: string,
  deps: Pick<BaleInboundHandlerRuntimeDeps<unknown>, "execCommand">,
  timeout = getBaleInboundHandlerTimeout(handler),
): Promise<string> {
  const invocation = buildBaleTextHandlerInvocation(handler, text, cwd);
  const result = await deps.execCommand(invocation.command, invocation.args, {
    cwd,
    timeout,
    stdin: text,
    ...getBaleInboundHandlerRetryOptions(
      handler,
      getBaleInboundHandlerTemplateValues(
        getBaleTextHandlerFile(),
        text,
      ),
      cwd,
      timeout,
      deps,
    ),
  });
  if (result.code !== 0)
    throw new Error(formatBaleInboundHandlerFailure(result));
  return truncateBaleInboundOutput(result.stdout);
}

async function executeBaleTextHandler(
  handler: BaleInboundHandlerConfig,
  text: string,
  cwd: string,
  deps: Pick<BaleInboundHandlerRuntimeDeps<unknown>, "execCommand">,
): Promise<string> {
  const steps = getCommandTemplateCompositionSteps(handler);
  if (steps.length === 0) {
    return (
      await executeBaleTextHandlerInvocation(handler, text, cwd, deps)
    ).trim();
  }
  const startedAt = Date.now();
  let output = text;
  for (const [index, step] of steps.entries()) {
    if (
      !shouldRunCommandTemplateConfig(
        step,
        getBaleInboundHandlerTemplateValues(
          getBaleTextHandlerFile(),
          output,
        ),
      )
    )
      continue;
    try {
      output = await executeBaleTextHandlerInvocation(
        step,
        output,
        cwd,
        deps,
        getCommandTemplateStepTimeout(
          getBaleInboundHandlerTimeout(handler),
          step,
          index === 0 ? undefined : Date.now() - startedAt,
        ),
      );
    } catch (error) {
      if (typeof step === "object" && step.failure === "root") throw error;
      output = "";
    }
    if (index > 0 && !output) output = text;
  }
  return output.trim();
}

async function processBaleTextHandlers(options: {
  rawText: string;
  handlers?: BaleInboundHandlerConfig[];
  cwd: string;
  execCommand: BaleInboundHandlerRuntimeDeps<unknown>["execCommand"];
  recordRuntimeEvent?: BaleInboundHandlerRuntimeDeps<unknown>["recordRuntimeEvent"];
}): Promise<string> {
  if (!options.rawText) return options.rawText;
  let text = options.rawText;
  for (const handler of findBaleTextHandlers(options.handlers)) {
    try {
      // An unresolvable guard fails only this handler, like its command would.
      if (
        !shouldRunCommandTemplateConfig(
          handler,
          getBaleInboundHandlerTemplateValues(
            getBaleTextHandlerFile(),
            text,
          ),
        )
      )
        continue;
      const output = await executeBaleTextHandler(
        handler,
        text,
        options.cwd,
        options,
      );
      if (output) text = output;
    } catch (error) {
      options.recordRuntimeEvent?.("inbound-text-handler", error, {
        handler: getBaleInboundHandlerKind(handler),
      });
    }
  }
  for (const handler of getBaleInboundProgrammaticHandlers("text")) {
    try {
      const output = normalizeInboundProgrammaticHandlerText(
        await handler(
          { kind: "text", text, mimeType: "text/plain" },
          { cwd: options.cwd },
        ),
      );
      if (output) text = output;
    } catch (error) {
      options.recordRuntimeEvent?.("inbound-programmatic-handler", error, {
        kind: "text",
      });
    }
  }
  return text;
}

function isBaleVoiceLikeFile(file: BaleInboundHandlerFile): boolean {
  return (
    file.kind === "voice" ||
    file.kind === "audio" ||
    matchesWildcard("audio/*", file.mimeType)
  );
}

async function processBaleFileWithProgrammaticHandlers(
  file: BaleInboundHandlerFile,
  options: {
    cwd: string;
    recordRuntimeEvent?: BaleInboundHandlerRuntimeDeps<unknown>["recordRuntimeEvent"];
  },
): Promise<string | undefined> {
  const kind = file.kind || "*";
  for (const handler of getBaleInboundProgrammaticHandlers(kind)) {
    try {
      const output = normalizeInboundProgrammaticHandlerText(
        await handler(
          {
            kind,
            file,
            mimeType: file.mimeType,
          },
          { cwd: options.cwd },
        ),
      );
      if (output) return output;
    } catch (error) {
      options.recordRuntimeEvent?.("inbound-programmatic-handler", error, {
        fileName: file.fileName || basename(file.path),
        kind,
      });
    }
  }
  return undefined;
}

async function transcribeBaleVoiceFileWithProviders(
  file: BaleInboundHandlerFile,
  options: {
    recordRuntimeEvent?: BaleInboundHandlerRuntimeDeps<unknown>["recordRuntimeEvent"];
  },
): Promise<string | undefined> {
  if (!isBaleVoiceLikeFile(file)) return undefined;
  for (const provider of getBaleVoiceTranscriptionProviders()) {
    try {
      const result = await provider(file, {});
      const text = typeof result === "string" ? result : result?.text;
      if (text?.trim()) return truncateBaleInboundOutput(text.trim());
    } catch (error) {
      options.recordRuntimeEvent?.("voice-transcription-provider", error, {
        fileName: file.fileName || basename(file.path),
      });
    }
  }
  return undefined;
}

async function readBuiltInBaleTextAttachment(
  file: BaleInboundHandlerFile,
): Promise<string | undefined> {
  if (!isBaleTextMimeType(file.mimeType)) return undefined;
  const content = await readFile(file.path, "utf8");
  const normalized = content.trim();
  if (
    !normalized ||
    Buffer.byteLength(normalized, "utf8") > BUILT_IN_TEXT_ATTACHMENT_MAX_BYTES
  ) {
    return undefined;
  }
  const name = file.fileName || basename(file.path);
  return truncateBaleInboundOutput(`[${name}]\n${normalized}`);
}

async function executeBaleInboundHandler(
  handler: BaleInboundHandlerConfig,
  file: BaleInboundHandlerFile,
  cwd: string,
  deps: Pick<BaleInboundHandlerRuntimeDeps<unknown>, "execCommand">,
): Promise<string> {
  const steps = getCommandTemplateCompositionSteps(handler);
  if (steps.length === 0) {
    const output = await executeBaleInboundHandlerInvocation(
      handler,
      file,
      cwd,
      deps,
    );
    return output.trim();
  }
  const startedAt = Date.now();
  const values = getBaleInboundHandlerTemplateValues(file);
  let output = "";
  let started = false;
  for (const step of steps) {
    if (!shouldRunCommandTemplateConfig(step, values)) continue;
    const first = !started;
    started = true;
    try {
      output = await executeBaleInboundHandlerInvocation(
        step,
        file,
        cwd,
        deps,
        false,
        getCommandTemplateStepTimeout(
          getBaleInboundHandlerTimeout(handler),
          step,
          first ? undefined : Date.now() - startedAt,
        ),
        first ? undefined : output,
      );
    } catch (error) {
      if (typeof step === "object" && step.failure === "root") throw error;
      output = "";
    }
  }
  return output.trim();
}

export async function processBaleInboundHandlers<
  TFile extends BaleInboundHandlerFile,
>(options: {
  files: TFile[];
  rawText: string;
  handlers?: BaleInboundHandlerConfig[];
  cwd: string;
  execCommand: BaleInboundHandlerRuntimeDeps<unknown>["execCommand"];
  recordRuntimeEvent?: BaleInboundHandlerRuntimeDeps<unknown>["recordRuntimeEvent"];
}): Promise<BaleInboundHandlerProcessResult<TFile>> {
  const rawText = await processBaleTextHandlers({
    rawText: options.rawText,
    handlers: options.handlers,
    cwd: options.cwd,
    execCommand: options.execCommand,
    recordRuntimeEvent: options.recordRuntimeEvent,
  });
  const promptFiles: TFile[] = [...options.files];
  const outputs: BaleInboundHandlerOutput[] = [];
  for (const file of options.files) {
    let hasOutput = false;
    const handlers = findBaleInboundHandlers(options.handlers, file);
    for (const handler of handlers) {
      try {
        if (
          !shouldRunCommandTemplateConfig(
            handler,
            getBaleInboundHandlerTemplateValues(file),
          )
        )
          continue;
        const output = await executeBaleInboundHandler(
          handler,
          file,
          options.cwd,
          options,
        );
        if (output) {
          outputs.push({ file, output, handler });
          hasOutput = true;
        }
        break;
      } catch (error) {
        options.recordRuntimeEvent?.("inbound-handler", error, {
          fileName: file.fileName || basename(file.path),
          handler: getBaleInboundHandlerKind(handler),
        });
      }
    }
    if (!hasOutput) {
      try {
        const output = await processBaleFileWithProgrammaticHandlers(file, {
          cwd: options.cwd,
          recordRuntimeEvent: options.recordRuntimeEvent,
        });
        if (output) {
          outputs.push({ file, output, handler: { type: "programmatic" } });
          hasOutput = true;
        }
      } catch (error) {
        options.recordRuntimeEvent?.("inbound-programmatic-handler", error, {
          fileName: file.fileName || basename(file.path),
        });
      }
    }
    if (!hasOutput) {
      try {
        const output = await transcribeBaleVoiceFileWithProviders(file, {
          recordRuntimeEvent: options.recordRuntimeEvent,
        });
        if (output) {
          outputs.push({ file, output, handler: { type: "voice-provider" } });
          hasOutput = true;
        }
      } catch (error) {
        options.recordRuntimeEvent?.("voice-transcription-provider", error, {
          fileName: file.fileName || basename(file.path),
        });
      }
    }
    if (!hasOutput) {
      try {
        const output = await readBuiltInBaleTextAttachment(file);
        if (output) outputs.push({ file, output, handler: { type: "text" } });
      } catch (error) {
        options.recordRuntimeEvent?.("inbound-handler", error, {
          fileName: file.fileName || basename(file.path),
          handler: "built-in-text",
        });
      }
    }
  }
  return {
    rawText,
    promptFiles,
    handlerOutputs: outputs.map((output) => output.output),
    handledFiles: outputs,
  };
}

export function createBaleInboundHandlerRuntime<TContext>(
  deps: BaleInboundHandlerRuntimeDeps<TContext>,
): BaleInboundHandlerRuntime<TContext> {
  return {
    process: (files, rawText, ctx) =>
      processBaleInboundHandlers({
        files,
        rawText,
        handlers: deps.getHandlers(),
        cwd: deps.getCwd(ctx),
        execCommand: deps.execCommand,
        recordRuntimeEvent: deps.recordRuntimeEvent,
      }),
  };
}

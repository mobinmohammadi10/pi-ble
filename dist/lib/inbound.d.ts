/**
 * Bale inbound handler pipeline
 * Zones: bale inbound, command templates, prompt preparation
 * Owns MIME/type matching, command-template execution, fallback handling, and prompt injection before prompt enqueueing
 */
import { type CommandTemplateConfig, type CommandTemplateObjectConfig } from "./command-templates.ts";
type BaleInboundCommandTemplateConfig = string | CommandTemplateObjectConfig;
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
export interface BaleInboundHandlerProcessResult<TFile extends BaleInboundHandlerFile = BaleInboundHandlerFile> {
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
    execCommand: (command: string, args: string[], options?: BaleInboundHandlerExecOptions) => Promise<BaleInboundHandlerExecResult>;
    getCwd: (ctx: TContext) => string;
    recordRuntimeEvent?: (category: string, error: unknown, details?: Record<string, unknown>) => void;
}
export interface BaleInboundHandlerRuntime<TContext> {
    process: <TFile extends BaleInboundHandlerFile>(files: TFile[], rawText: string, ctx: TContext) => Promise<BaleInboundHandlerProcessResult<TFile>>;
}
export type BaleInboundProgrammaticHandlerResult = string | {
    text: string;
} | undefined;
export interface BaleInboundProgrammaticHandlerInput {
    kind: string;
    text?: string;
    file?: BaleInboundHandlerFile;
    mimeType?: string;
}
export type BaleInboundProgrammaticHandler = (input: BaleInboundProgrammaticHandlerInput, options?: {
    cwd?: string;
}) => Promise<BaleInboundProgrammaticHandlerResult>;
export interface BaleInboundHandlerRegistry {
    handlers: Map<string, BaleInboundProgrammaticHandler[]>;
}
interface InboundHandlerInvocation {
    command: string;
    args: string[];
}
export declare function registerBaleInboundHandler(kind: string, handler: BaleInboundProgrammaticHandler): () => void;
export declare function clearBaleInboundHandlers(): void;
export declare function baleInboundHandlerMatchesFile(handler: BaleInboundHandlerConfig, file: BaleInboundHandlerFile): boolean;
export declare function buildBaleInboundHandlerInvocation(handler: CommandTemplateConfig, file: BaleInboundHandlerFile, cwd: string, appendFileIfMissing?: boolean): InboundHandlerInvocation;
export declare function processBaleInboundHandlers<TFile extends BaleInboundHandlerFile>(options: {
    files: TFile[];
    rawText: string;
    handlers?: BaleInboundHandlerConfig[];
    cwd: string;
    execCommand: BaleInboundHandlerRuntimeDeps<unknown>["execCommand"];
    recordRuntimeEvent?: BaleInboundHandlerRuntimeDeps<unknown>["recordRuntimeEvent"];
}): Promise<BaleInboundHandlerProcessResult<TFile>>;
export declare function createBaleInboundHandlerRuntime<TContext>(deps: BaleInboundHandlerRuntimeDeps<TContext>): BaleInboundHandlerRuntime<TContext>;
export {};

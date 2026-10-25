/**
 * Pi prompt-template bridge helpers
 * Zones: pi agent prompts, bale controls, filesystem
 * Discovers Pi prompt-template slash commands and expands them before Bale queue dispatch
 */
import type { PiSlashCommandInfo } from "./pi.ts";
export interface BalePromptTemplateCommand {
    command: string;
    description?: string;
    path: string;
}
export type BalePromptTemplateReader = (path: string) => string;
export declare function parsePromptTemplateArgs(argsString: string): string[];
export declare function substitutePromptTemplateArgs(content: string, args: readonly string[]): string;
export declare function mapPiPromptTemplateNameToBaleCommandName(name: string): string | undefined;
export interface BalePromptTemplateCommandGetterDeps {
    getCommands: () => readonly PiSlashCommandInfo[];
    reservedCommandNames?: readonly string[];
    getReservedCommandNames?: () => readonly string[];
}
export declare function getBalePromptTemplateCommands(commands: readonly PiSlashCommandInfo[], reservedNames?: ReadonlySet<string>): BalePromptTemplateCommand[];
export declare function createBalePromptTemplateCommandGetter(deps: BalePromptTemplateCommandGetterDeps): () => BalePromptTemplateCommand[];
export declare function expandBalePromptTemplateCommand(commandName: string, args: string, commands: readonly BalePromptTemplateCommand[], readTemplate?: BalePromptTemplateReader): string | undefined;

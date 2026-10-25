/**
 * Pi prompt-template bridge helpers
 * Zones: pi agent prompts, bale controls, filesystem
 * Discovers Pi prompt-template slash commands and expands them before Bale queue dispatch
 */

import { readFileSync } from "node:fs";
import type { PiSlashCommandInfo } from "./pi.ts";

export interface BalePromptTemplateCommand {
  command: string;
  description?: string;
  path: string;
}

export type BalePromptTemplateReader = (path: string) => string;

const BALE_BOT_COMMAND_NAME_PATTERN = /^[a-z0-9_]{1,32}$/;

function stripPromptTemplateFrontmatter(content: string): string {
  if (!content.startsWith("---")) return content;
  const lines = content.split("\n");
  if (lines[0]?.trim() !== "---") return content;
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index]?.trim() === "---")
      return lines.slice(index + 1).join("\n");
  }
  return content;
}

export function parsePromptTemplateArgs(argsString: string): string[] {
  const args: string[] = [];
  let current = "";
  let quote: string | undefined;
  for (const char of argsString) {
    if (quote) {
      if (char === quote) {
        quote = undefined;
      } else {
        current += char;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === " " || char === "\t") {
      if (current) args.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  if (current) args.push(current);
  return args;
}

export function substitutePromptTemplateArgs(
  content: string,
  args: readonly string[],
): string {
  let result = content.replace(/\$(\d+)/g, (_, num: string) => {
    const index = Number.parseInt(num, 10) - 1;
    return args[index] ?? "";
  });
  result = result.replace(
    /\$\{@:(\d+)(?::(\d+))?\}/g,
    (_, startValue: string, lengthValue: string | undefined) => {
      const start = Math.max(Number.parseInt(startValue, 10) - 1, 0);
      if (lengthValue) {
        const length = Number.parseInt(lengthValue, 10);
        return args.slice(start, start + length).join(" ");
      }
      return args.slice(start).join(" ");
    },
  );
  const allArgs = args.join(" ");
  return result.replace(/\$ARGUMENTS/g, allArgs).replace(/\$@/g, allArgs);
}

function isBalePromptTemplateCommandName(name: string): boolean {
  return BALE_BOT_COMMAND_NAME_PATTERN.test(name);
}

export function mapPiPromptTemplateNameToBaleCommandName(
  name: string,
): string | undefined {
  const command = name
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 32)
    .replace(/_+$/g, "");
  return isBalePromptTemplateCommandName(command) ? command : undefined;
}

export interface BalePromptTemplateCommandGetterDeps {
  getCommands: () => readonly PiSlashCommandInfo[];
  reservedCommandNames?: readonly string[];
  getReservedCommandNames?: () => readonly string[];
}

export function getBalePromptTemplateCommands(
  commands: readonly PiSlashCommandInfo[],
  reservedNames: ReadonlySet<string> = new Set(),
): BalePromptTemplateCommand[] {
  const seen = new Set<string>();
  const promptCommands: BalePromptTemplateCommand[] = [];
  for (const command of commands) {
    if (command.source !== "prompt") continue;
    const baleCommand = mapPiPromptTemplateNameToBaleCommandName(
      command.name,
    );
    if (!baleCommand) continue;
    if (reservedNames.has(baleCommand)) continue;
    if (seen.has(baleCommand)) continue;
    const sourcePath = command.sourceInfo?.path;
    if (!sourcePath) continue;
    seen.add(baleCommand);
    promptCommands.push({
      command: baleCommand,
      description: command.description,
      path: sourcePath,
    });
  }
  return promptCommands.sort((a, b) => a.command.localeCompare(b.command));
}

export function createBalePromptTemplateCommandGetter(
  deps: BalePromptTemplateCommandGetterDeps,
): () => BalePromptTemplateCommand[] {
  return () => {
    return getBalePromptTemplateCommands(
      deps.getCommands(),
      new Set([
        ...(deps.reservedCommandNames ?? []),
        ...(deps.getReservedCommandNames?.() ?? []),
      ]),
    );
  };
}

export function expandBalePromptTemplateCommand(
  commandName: string,
  args: string,
  commands: readonly BalePromptTemplateCommand[],
  readTemplate: BalePromptTemplateReader = (path) =>
    readFileSync(path, "utf-8"),
): string | undefined {
  const command = commands.find(
    (candidate) => candidate.command === commandName,
  );
  if (!command) return undefined;
  const content = stripPromptTemplateFrontmatter(readTemplate(command.path));
  return substitutePromptTemplateArgs(content, parsePromptTemplateArgs(args));
}

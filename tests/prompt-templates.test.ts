/**
 * Regression tests for Bale prompt-template bridge helpers
 * Covers Pi prompt-template discovery filtering and command expansion
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  createBalePromptTemplateCommandGetter,
  expandBalePromptTemplateCommand,
  getBalePromptTemplateCommands,
  mapPiPromptTemplateNameToBaleCommandName,
  parsePromptTemplateArgs,
  substitutePromptTemplateArgs,
} from "../lib/prompt-templates.ts";
import { BALE_RESERVED_COMMAND_NAMES } from "../lib/commands.ts";
import type { PiSlashCommandInfo } from "../lib/pi.ts";

function createCommand(
  name: string,
  source: PiSlashCommandInfo["source"],
  description?: string,
): PiSlashCommandInfo {
  return {
    name,
    description,
    source,
    sourceInfo: {
      path: `/prompts/${name}.md`,
      source: "local",
      scope: "project",
      origin: "top-level",
    },
  };
}

test("Prompt-template helpers expose valid Bale command templates", () => {
  const commands = getBalePromptTemplateCommands(
    [
      createCommand("review", "prompt", "Review changes"),
      createCommand("fix-tests", "prompt", "Fix failing tests"),
      createCommand("status", "prompt", "Reserved hidden command"),
      createCommand("start", "prompt", "Reserved visible command"),
      createCommand("skill", "skill", "Not a prompt"),
      createCommand("review", "prompt", "Duplicate"),
    ],
    new Set(BALE_RESERVED_COMMAND_NAMES),
  );
  assert.deepEqual(commands, [
    {
      command: "fix_tests",
      description: "Fix failing tests",
      path: "/prompts/fix-tests.md",
    },
    {
      command: "review",
      description: "Review changes",
      path: "/prompts/review.md",
    },
  ]);
});

test("Prompt-template helpers skip commands without source paths", () => {
  const commandWithoutSourcePath = {
    name: "review",
    description: "Review changes",
    source: "prompt",
  } as PiSlashCommandInfo;
  const commands = getBalePromptTemplateCommands(
    [commandWithoutSourcePath],
    new Set(BALE_RESERVED_COMMAND_NAMES),
  );
  assert.deepEqual(commands, []);
});

test("Prompt-template helpers map pi template names to Bale commands", () => {
  assert.equal(
    mapPiPromptTemplateNameToBaleCommandName("fix-tests"),
    "fix_tests",
  );
  assert.equal(
    mapPiPromptTemplateNameToBaleCommandName("Review PR"),
    "review_pr",
  );
  assert.equal(mapPiPromptTemplateNameToBaleCommandName("---"), undefined);
});

test("Prompt-template command getter hides extension command conflicts", () => {
  const getCommands = () => [
    createCommand("review", "prompt", "Review changes"),
    createCommand("start", "prompt", "Conflicts with built-in"),
    createCommand("status", "prompt", "Conflicts with hidden shortcut"),
  ];
  const getPromptTemplateCommands = createBalePromptTemplateCommandGetter({
    getCommands,
    reservedCommandNames: BALE_RESERVED_COMMAND_NAMES,
  });
  assert.deepEqual(
    getPromptTemplateCommands().map((command) => command.command),
    ["review"],
  );
});

test("Prompt-template helpers parse and substitute arguments like pi templates", () => {
  const args = parsePromptTemplateArgs("one 'two words' \"three words\"");
  assert.deepEqual(args, ["one", "two words", "three words"]);
  assert.equal(
    substitutePromptTemplateArgs(
      "$1 | $2 | $@ | $ARGUMENTS | ${@:2} | ${@:2:1}",
      args,
    ),
    "one | two words | one two words three words | one two words three words | two words three words | two words",
  );
});

test("Prompt-template helpers expand command content from template files", () => {
  const expanded = expandBalePromptTemplateCommand(
    "review",
    "staged changes",
    [{ command: "review", description: "Review", path: "/prompts/review.md" }],
    () => "---\ndescription: Review\n---\nReview $@",
  );
  assert.equal(expanded, "Review staged changes");
  assert.equal(
    expandBalePromptTemplateCommand("missing", "", [], () => "unused"),
    undefined,
  );
});

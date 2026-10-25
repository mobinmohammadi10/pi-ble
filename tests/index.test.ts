/**
 * Regression tests for the Bale extension entrypoint wiring
 * Covers composition-root binding of tools, commands, lifecycle hooks, and prompt injection
 * Zones: bale, pi agent, orchestration
 */

import assert from "node:assert/strict";
import test from "node:test";

import baleExtension from "../index.ts";
import * as baleEntrypoint from "../index.ts";
import type { ExtensionAPI, ExtensionContext } from "../lib/pi.ts";

type RegisteredIndexTool = {
  name?: string;
};

type RegisteredIndexCommand = {
  handler: (...args: never[]) => unknown;
};

type RegisteredIndexHandler = (
  event: unknown,
  ctx: ExtensionContext,
) => Promise<unknown> | unknown;

function createIndexApiHarness() {
  const tools = new Map<string, RegisteredIndexTool>();
  const commands = new Map<string, RegisteredIndexCommand>();
  const handlers = new Map<string, RegisteredIndexHandler>();
  let activeTools: string[] = [];
  const api = {
    on: (event: string, handler: RegisteredIndexHandler) => {
      handlers.set(event, handler);
    },
    registerTool: (definition: RegisteredIndexTool) => {
      if (!definition.name) return;
      tools.set(definition.name, definition);
      activeTools.push(definition.name);
    },
    getActiveTools: () => [...activeTools],
    setActiveTools: (names: string[]) => {
      activeTools = [...names];
    },
    registerCommand: (name: string, definition: RegisteredIndexCommand) => {
      commands.set(name, definition);
    },
  } as unknown as ExtensionAPI;
  return { tools, commands, handlers, api };
}

function getRequiredIndexHandler(
  handlers: Map<string, RegisteredIndexHandler>,
  name: string,
): RegisteredIndexHandler {
  const handler = handlers.get(name);
  assert.ok(handler, `Expected entrypoint handler ${name}`);
  return handler;
}

function createIndexExtensionContext(): ExtensionContext {
  return {} as ExtensionContext;
}

test("Extension entrypoint exposes only the default composition root", () => {
  assert.deepEqual(Object.keys(baleEntrypoint), ["default"]);
});

test("Extension entrypoint wires domain bindings into the pi API", () => {
  const harness = createIndexApiHarness();
  baleExtension(harness.api);
  assert.deepEqual(
    [...harness.tools.keys()],
    ["bale_bind", "bale_channel_post", "bale_channel_posts", "bale_attach", "bale_message"],
  );
  assert.deepEqual(
    [...harness.commands.keys()],
    [
      "bale-setup",
      "bale-status",
      "bale-connect",
      "bale-disconnect",
    ],
  );
  assert.deepEqual(
    [...harness.handlers.keys()].filter((name) => name !== "resources_discover"),
    [
      "input",
      "session_start",
      "session_shutdown",
      "session_before_compact",
      "session_compact",
      "session_compact_failed",
      "before_agent_start",
      "model_select",
      "agent_start",
      "turn_end",
      "tool_execution_start",
      "tool_execution_update",
      "tool_execution_end",
      "message_start",
      "message_update",
      "message_end",
      "ui_prompt_start",
      "ui_prompt_end",
      "agent_end",
      "agent_settled",
    ],
  );
});

test("Extension model-step hook declines unbound contexts without SDK or queue effects", async () => {
  const harness = createIndexApiHarness();
  baleExtension(harness.api);
  const result = await getRequiredIndexHandler(harness.handlers, "turn_end")(
    { entries: [], outcome: "completed", turnIndex: 1 }, createIndexExtensionContext(),
  );
  assert.equal(result, undefined);
});

test("Extension before-agent-start hook skips Bale guidance when unconfigured", async () => {
  const harness = createIndexApiHarness();
  baleExtension(harness.api);
  const handler = getRequiredIndexHandler(
    harness.handlers,
    "before_agent_start",
  );
  const basePrompt = "System base";
  const baleResult = await handler(
    { systemPrompt: basePrompt, prompt: "[bale] hello" },
    createIndexExtensionContext(),
  );
  const localResult = await handler(
    { systemPrompt: basePrompt, prompt: "hello" },
    createIndexExtensionContext(),
  );
  assert.equal(baleResult, undefined);
  assert.equal(localResult, undefined);
});

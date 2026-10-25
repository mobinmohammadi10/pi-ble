/**
 * Bale Extension Sections tests
 * Zones: bale ui, extension platform, callback routing
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createBaleExtensionSectionRegistry,
  getBaleExtensionSettingsRows,
  getBaleSectionMainMenuRows,
  handleBaleSectionCallback,
  handleBaleSectionOpen,
  handleBaleSectionSettingsOpen,
  parseBaleSectionCallback,
  type BaleSectionRuntimeDeps,
  type BaleSectionRegistration,
} from "../lib/sections.ts";

function stubSection(
  id: string,
  label: string,
  overrides: Partial<BaleSectionRegistration> = {},
): BaleSectionRegistration {
  return {
    id,
    label,
    render: async () => ({ text: `<b>${label}</b>`, parseMode: "html" }),
    ...overrides,
  };
}

function stubDeps(
  overrides: Partial<BaleSectionRuntimeDeps> = {},
): BaleSectionRuntimeDeps {
  return {
    answerCallbackQuery: async () => {},
    editInteractiveMessage: async () => {},
    sendInteractiveMessage: async () => undefined,
    sendRichMessage: async () => undefined,
    enqueuePrompt: async () => {},
    deleteMessage: async () => {},
    ...overrides,
  };
}

// --- Registry ---

test("Registry registers a section and returns a disposer", () => {
  const registry = createBaleExtensionSectionRegistry();
  const unregister = registry.register(stubSection("@test/section-a", "A"));
  const sections = registry.getSections();
  assert.equal(sections.length, 1);
  assert.equal(sections[0].id, "@test/section-a");
  assert.equal(sections[0].label, "A");
  assert.equal(typeof sections[0].token, "string");
  unregister();
  assert.equal(registry.getSections().length, 0);
});

test("Registry assigns unique tokens to each section", () => {
  const registry = createBaleExtensionSectionRegistry();
  const u1 = registry.register(stubSection("@test/a", "A"));
  const u2 = registry.register(stubSection("@test/b", "B"));
  const sections = registry.getSections();
  assert.equal(sections.length, 2);
  assert.notEqual(sections[0].token, sections[1].token);
  u1();
  u2();
});

test("Registry rejects duplicate section ids", () => {
  const registry = createBaleExtensionSectionRegistry();
  registry.register(stubSection("@test/a", "A"));
  assert.throws(
    () => registry.register(stubSection("@test/a", "A2")),
    /already registered/,
  );
});

test("Registry sorts sections by order then id", () => {
  const registry = createBaleExtensionSectionRegistry();
  registry.register(stubSection("@test/c", "C", { order: 2 }));
  registry.register(stubSection("@test/a", "A", { order: 0 }));
  registry.register(stubSection("@test/b", "B", { order: 1 }));
  const sections = registry.getSections();
  assert.equal(sections[0].id, "@test/a");
  assert.equal(sections[1].id, "@test/b");
  assert.equal(sections[2].id, "@test/c");
});

test("Registry getByToken resolves token to section", () => {
  const registry = createBaleExtensionSectionRegistry();
  registry.register(stubSection("@test/a", "A"));
  const sections = registry.getSections();
  const found = registry.getByToken(sections[0].token);
  assert.ok(found);
  assert.equal(found.id, "@test/a");
});

test("Registry getByToken returns undefined for unknown token", () => {
  const registry = createBaleExtensionSectionRegistry();
  assert.equal(registry.getByToken("99"), undefined);
});

test("Registry clear removes all sections and resets tokens", () => {
  const registry = createBaleExtensionSectionRegistry();
  const u1 = registry.register(stubSection("@test/a", "A"));
  registry.clear();
  assert.equal(registry.getSections().length, 0);
  // New registration gets fresh tokens
  const u2 = registry.register(stubSection("@test/b", "B"));
  const sections = registry.getSections();
  assert.equal(sections[0].token, "0");
  u1();
  u2();
});

test("Registry diagnostics reports active and error states", () => {
  const registry = createBaleExtensionSectionRegistry();
  registry.register(stubSection("@test/a", "A"));
  let diags = registry.getDiagnostics();
  assert.equal(diags.length, 1);
  assert.equal(diags[0].status, "active");
  assert.equal(diags[0].id, "@test/a");
  registry.recordError("0", "boom");
  diags = registry.getDiagnostics();
  assert.equal(diags[0].status, "error");
  assert.equal(diags[0].lastError, "boom");
  registry.clearError("0");
  assert.equal(registry.getDiagnostics()[0].status, "active");
});

// --- Settings Rows ---

test("getBaleExtensionSettingsRows returns rows only for sections with settings", () => {
  const registry = createBaleExtensionSectionRegistry();
  registry.register(stubSection("@test/a", "A"));
  registry.register(
    stubSection("@test/b", "B", {
      settings: {
        label: "🔧 B Settings",
        open: async () => ({ text: "B settings" }),
      },
    }),
  );
  const rows = getBaleExtensionSettingsRows(registry);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].label, "🔧 B Settings");
  assert.ok(rows[0].callback_data.startsWith("section:"));
  assert.ok(rows[0].callback_data.endsWith(":settings:open"));
});

test("getBaleExtensionSettingsRows sorts by settings order", () => {
  const registry = createBaleExtensionSectionRegistry();
  registry.register(
    stubSection("@test/c", "C", {
      settings: { label: "C", open: async () => ({ text: "C" }), order: 2 },
    }),
  );
  registry.register(
    stubSection("@test/a", "A", {
      settings: { label: "A", open: async () => ({ text: "A" }), order: 0 },
    }),
  );
  const rows = getBaleExtensionSettingsRows(registry);
  assert.equal(rows[0].label, "A");
  assert.equal(rows[1].label, "C");
});

// --- Menu Rows ---

test("getBaleSectionMainMenuRows omits sections with failing labels", () => {
  const registry = createBaleExtensionSectionRegistry();
  registry.register(stubSection("@test/a", "A"));
  registry.register(
    stubSection("@test/b", "B", {
      getLabel: () => {
        throw new Error("label failed");
      },
    }),
  );
  const rows = getBaleSectionMainMenuRows(registry);
  assert.deepEqual(
    rows.map((row) => row.text),
    ["A"],
  );
  const diagnostics = registry.getDiagnostics();
  assert.equal(diagnostics[1].status, "error");
  assert.equal(diagnostics[1].lastError, "label failed");
});

test("getBaleExtensionSettingsRows omits settings with failing labels", () => {
  const registry = createBaleExtensionSectionRegistry();
  registry.register(
    stubSection("@test/a", "A", {
      settings: { label: "A", open: async () => ({ text: "A" }) },
    }),
  );
  registry.register(
    stubSection("@test/b", "B", {
      settings: {
        label: "B",
        getLabel: () => {
          throw new Error("settings label failed");
        },
        open: async () => ({ text: "B" }),
      },
    }),
  );
  const rows = getBaleExtensionSettingsRows(registry);
  assert.deepEqual(
    rows.map((row) => row.label),
    ["A"],
  );
  const diagnostics = registry.getDiagnostics();
  assert.equal(diagnostics[1].status, "error");
  assert.equal(diagnostics[1].lastError, "settings label failed");
});

test("successful labels do not clear unrelated runtime diagnostics", () => {
  const registry = createBaleExtensionSectionRegistry();
  registry.register(stubSection("@test/a", "A"));
  registry.recordError("0", "callback failed", "callback");
  assert.equal(getBaleSectionMainMenuRows(registry)[0].text, "A");
  assert.equal(registry.getDiagnostics()[0].status, "error");
  assert.equal(registry.getDiagnostics()[0].lastError, "callback failed");
  registry.clearError("0", "callback");
  assert.equal(registry.getDiagnostics()[0].status, "active");
});

// --- Callback Parsing ---

test("parseBaleSectionCallback parses section:token:action", () => {
  const result = parseBaleSectionCallback("section:00:open");
  assert.ok(result);
  assert.equal(result.token, "00");
  assert.equal(result.action, "open");
  assert.equal(result.payload, "");
});

test("parseBaleSectionCallback parses section:token:action:payload", () => {
  const result = parseBaleSectionCallback("section:01:toggle:on");
  assert.ok(result);
  assert.equal(result.token, "01");
  assert.equal(result.action, "toggle");
  assert.equal(result.payload, "on");
});

test("parseBaleSectionCallback parses payload with colons", () => {
  const result = parseBaleSectionCallback("section:05:nav:path:to:item");
  assert.ok(result);
  assert.equal(result.token, "05");
  assert.equal(result.action, "nav");
  assert.equal(result.payload, "path:to:item");
});

test("parseBaleSectionCallback returns undefined for non-section data", () => {
  assert.equal(parseBaleSectionCallback("menu:model"), undefined);
  assert.equal(parseBaleSectionCallback("settings:list"), undefined);
  assert.equal(parseBaleSectionCallback(""), undefined);
});

// --- Section Open ---

test("handleBaleSectionOpen renders section view with back row", async () => {
  const registry = createBaleExtensionSectionRegistry();
  registry.register(
    stubSection("@test/a", "🗂 A", {
      render: async () => ({
        text: "<b>Hello</b>",
        parseMode: "html",
        replyMarkup: {
          inline_keyboard: [
            [{ text: "Do", callback_data: "section:0:act:do" }],
          ],
        },
      }),
    }),
  );
  let editedText = "";
  let editedMarkup: unknown = undefined;
  const deps = stubDeps({
    editInteractiveMessage: async (
      _chatId,
      _msgId,
      text,
      _mode,
      replyMarkup,
    ) => {
      editedText = text;
      editedMarkup = replyMarkup;
    },
  });
  const handled = await handleBaleSectionOpen(
    registry,
    "0",
    123,
    456,
    "cb-id",
    deps,
  );
  assert.equal(handled, true);
  assert.equal(editedText, "<b>Hello</b>");
  const markup = editedMarkup as {
    inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
  };
  assert.ok(markup);
  // First row is the Back button
  assert.equal(markup.inline_keyboard[0][0].text, "⬆️ Main menu");
  assert.equal(markup.inline_keyboard[0][0].callback_data, "menu:back");
  // Second row is the section's own button
  assert.equal(markup.inline_keyboard[1][0].text, "Do");
});

test("section callbackData rejects payloads above Bale's byte limit", async () => {
  const registry = createBaleExtensionSectionRegistry();
  registry.register(
    stubSection("@test/a", "A", {
      render: async (ctx) => {
        assert.throws(
          () => ctx.callbackData("act", "x".repeat(80)),
          /64 bytes/,
        );
        return { text: "ok" };
      },
    }),
  );
  const handled = await handleBaleSectionOpen(
    registry,
    "0",
    123,
    456,
    "cb-id",
    stubDeps(),
  );
  assert.equal(handled, true);
});

test("handleBaleSectionOpen preserves existing back button", async () => {
  const registry = createBaleExtensionSectionRegistry();
  registry.register(
    stubSection("@test/a", "A", {
      render: async () => ({
        text: "Test",
        replyMarkup: {
          inline_keyboard: [
            [{ text: "⬆️ Main menu", callback_data: "menu:back" }],
            [{ text: "Custom", callback_data: "section:0:custom" }],
          ],
        },
      }),
    }),
  );
  let editedMarkup: unknown = undefined;
  const deps = stubDeps({
    editInteractiveMessage: async (_a, _b, _c, _d, replyMarkup) => {
      editedMarkup = replyMarkup;
    },
  });
  await handleBaleSectionOpen(registry, "0", 123, 456, "cb-id", deps);
  const markup = editedMarkup as {
    inline_keyboard: Array<Array<{ text: string }>>;
  };
  assert.equal(markup.inline_keyboard.length, 2);
  // No duplicate back row
  assert.equal(markup.inline_keyboard[0][0].text, "⬆️ Main menu");
});

test("handleBaleSectionOpen handles stale token gracefully", async () => {
  const registry = createBaleExtensionSectionRegistry();
  let answeredText = "";
  const deps = stubDeps({
    answerCallbackQuery: async (_id, text) => {
      answeredText = text ?? "";
    },
  });
  const handled = await handleBaleSectionOpen(
    registry,
    "99",
    123,
    456,
    "cb-id",
    deps,
  );
  assert.equal(handled, true);
  assert.ok(answeredText.includes("no longer available"));
});

test("handleBaleSectionOpen records and clears render errors", async () => {
  const registry = createBaleExtensionSectionRegistry();
  let fail = true;
  registry.register(
    stubSection("@test/a", "A", {
      render: async () => {
        if (fail) throw new Error("render failed");
        return { text: "ok" };
      },
    }),
  );
  await handleBaleSectionOpen(registry, "0", 123, 456, "cb-id", stubDeps());
  assert.equal(registry.getDiagnostics()[0].status, "error");
  assert.equal(registry.getDiagnostics()[0].lastError, "render failed");
  fail = false;
  await handleBaleSectionOpen(registry, "0", 123, 456, "cb-id", stubDeps());
  assert.equal(registry.getDiagnostics()[0].status, "active");
});

// --- Section Callback ---

test("handleBaleSectionCallback dispatches to section handler", async () => {
  const registry = createBaleExtensionSectionRegistry();
  let receivedAction = "";
  let receivedPayload = "";
  registry.register(
    stubSection("@test/a", "A", {
      handleCallback: async (ctx) => {
        receivedAction = ctx.action;
        receivedPayload = ctx.payload;
        return "handled" as const;
      },
    }),
  );
  const deps = stubDeps();
  const handled = await handleBaleSectionCallback(
    registry,
    "0",
    "toggle",
    "on",
    123,
    456,
    "cb-id",
    deps,
  );
  assert.equal(handled, true);
  assert.equal(receivedAction, "toggle");
  assert.equal(receivedPayload, "on");
});

test("handleBaleSectionCallback falls back to settings handler", async () => {
  const registry = createBaleExtensionSectionRegistry();
  let settingsAction = "";
  registry.register(
    stubSection("@test/a", "A", {
      handleCallback: async () => "pass" as const,
      settings: {
        label: "Settings",
        open: async () => ({ text: "settings" }),
        handleCallback: async (ctx) => {
          settingsAction = ctx.action;
          return "handled" as const;
        },
      },
    }),
  );
  const deps = stubDeps();
  await handleBaleSectionCallback(
    registry,
    "0",
    "toggle",
    "off",
    123,
    456,
    "cb-id",
    deps,
  );
  assert.equal(settingsAction, "toggle");
});

test("handleBaleSectionCallback gives settings-only handlers settings navigation", async () => {
  const registry = createBaleExtensionSectionRegistry();
  registry.register(
    stubSection("@test/a", "A", {
      settings: {
        label: "Settings",
        open: async () => ({ text: "settings" }),
        handleCallback: async (ctx) => {
          await ctx.edit({ text: "settings detail" });
          return "handled" as const;
        },
      },
    }),
  );
  let editedMarkup: unknown;
  const deps = stubDeps({
    editInteractiveMessage: async (_chat, _message, _text, _mode, markup) => {
      editedMarkup = markup;
    },
  });
  await handleBaleSectionCallback(
    registry,
    "0",
    "toggle",
    "off",
    123,
    456,
    "cb-id",
    deps,
  );
  const markup = editedMarkup as {
    inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
  };
  assert.equal(markup.inline_keyboard[0][0].text, "⬆️ Back");
  assert.equal(markup.inline_keyboard[0][0].callback_data, "settings:list");
});

test("handleBaleSectionCallback answers when no handler exists", async () => {
  const registry = createBaleExtensionSectionRegistry();
  registry.register(stubSection("@test/a", "A"));
  let answered = false;
  const deps = stubDeps({
    answerCallbackQuery: async () => {
      answered = true;
    },
  });
  const handled = await handleBaleSectionCallback(
    registry,
    "0",
    "act",
    "",
    123,
    456,
    "cb-id",
    deps,
  );
  assert.equal(handled, true);
  assert.equal(answered, true);
});

test("handleBaleSectionCallback handles stale token", async () => {
  const registry = createBaleExtensionSectionRegistry();
  let answeredText = "";
  const deps = stubDeps({
    answerCallbackQuery: async (_id, text) => {
      answeredText = text ?? "";
    },
  });
  const handled = await handleBaleSectionCallback(
    registry,
    "99",
    "act",
    "",
    123,
    456,
    "cb-id",
    deps,
  );
  assert.equal(handled, true);
  assert.ok(answeredText.includes("no longer available"));
});

// --- Section Settings Open ---

test("handleBaleSectionSettingsOpen renders settings view", async () => {
  const registry = createBaleExtensionSectionRegistry();
  registry.register(
    stubSection("@test/a", "A", {
      settings: {
        label: "⚙️ A Settings",
        open: async () => ({
          text: "<b>Settings for A</b>",
          parseMode: "html",
        }),
      },
    }),
  );
  let editedText = "";
  const deps = stubDeps({
    editInteractiveMessage: async (_a, _b, text) => {
      editedText = text;
    },
  });
  const handled = await handleBaleSectionSettingsOpen(
    registry,
    "0",
    123,
    456,
    "cb-id",
    deps,
  );
  assert.equal(handled, true);
  assert.equal(editedText, "<b>Settings for A</b>");
});

test("handleBaleSectionSettingsOpen handles section without settings gracefully", async () => {
  const registry = createBaleExtensionSectionRegistry();
  registry.register(stubSection("@test/a", "A"));
  let answeredText = "";
  const deps = stubDeps({
    answerCallbackQuery: async (_id, text) => {
      answeredText = text ?? "";
    },
  });
  const handled = await handleBaleSectionSettingsOpen(
    registry,
    "0",
    123,
    456,
    "cb-id",
    deps,
  );
  assert.equal(handled, true);
  assert.ok(answeredText.includes("no longer available"));
});

test("Section callback openRich sends one native message to the exact target", async () => {
  const registry = createBaleExtensionSectionRegistry();
  const richMessage = {
    blocks: [{ type: "details" as const, summary: "Effective", blocks: [{ type: "pre" as const, text: "{}", language: "json" }] }],
    skip_entity_detection: true,
  };
  registry.register(stubSection("@test/state", "State", {
    handleCallback: async (ctx) => {
      await ctx.openRich(richMessage);
      return "handled" as const;
    },
  }));
  const sent: unknown[] = [];
  await handleBaleSectionCallback(
    registry,
    "0",
    "inspect",
    "effective",
    42,
    9,
    "query",
    stubDeps({
      target: { chatId: 42, threadId: 7 },
      sendRichMessage: async (...args) => {
        sent.push(args);
        return 10;
      },
    }),
  );
  assert.deepEqual(sent, [[42, richMessage, { target: { chatId: 42, threadId: 7 } }]]);
});

// --- Integration: menu-status rows ---

test("buildStatusReplyMarkup includes extension section rows before Settings", async () => {
  // Import dynamically to avoid circular deps in test
  const { buildStatusReplyMarkup } = await import("../lib/menu-status.ts");
  const registry = createBaleExtensionSectionRegistry();
  registry.register(stubSection("@test/a", "Explorer"));
  registry.register(
    stubSection("@test/b", "Status", {
      getLabel: () => "🟢 Status",
    }),
  );

  const markup = buildStatusReplyMarkup(undefined, "off" as never, 0, registry);
  const rows = markup.inline_keyboard;

  // Find the Settings row index
  const settingsIdx = rows.findIndex(
    (r) => r[0].callback_data === "menu:settings",
  );
  assert.ok(settingsIdx > 0);
  // Queue should be before section rows
  assert.equal(rows[settingsIdx - 3][0].text, "⌛ Queue: 0");
  // Section rows injected between Queue and Settings
  assert.equal(rows[settingsIdx - 2][0].text, "Explorer");
  assert.equal(rows[settingsIdx - 2][0].callback_data, "section:0:open");
  assert.equal(rows[settingsIdx - 1][0].text, "🟢 Status");
  assert.equal(rows[settingsIdx - 1][0].callback_data, "section:1:open");
});

// --- Integration: menu-settings rows ---

test("buildBaleSettingsMenuReplyMarkup injects extension settings rows", async () => {
  const { buildBaleSettingsMenuReplyMarkup } =
    await import("../lib/menu-settings.ts");
  const registry = createBaleExtensionSectionRegistry();
  registry.register(
    stubSection("@test/a", "A", {
      settings: {
        label: "🔧 Core (Beta)",
        order: 2,
        open: async () => ({ text: "A settings" }),
      },
    }),
  );
  registry.register(
    stubSection("@test/b", "B", {
      settings: {
        label: "🧪 Core (Alpha)",
        order: 1,
        open: async () => ({ text: "B settings" }),
      },
    }),
  );

  const markup = buildBaleSettingsMenuReplyMarkup(
    false,
    "manual",
    "hidden",
    registry,
  );
  const rows = markup.inline_keyboard;

  // First row: Main menu back
  assert.equal(rows[0][0].callback_data, "menu:back");
  assert.deepEqual(
    rows.slice(1).map((row) => row[0].text),
    [
      "📝 Draft previews: off",
      "🧾 Rendering: rich",
      "👄 Voice reply: manual",
      "🔬 Activity: quiet",
      "🕒 Time injection: hidden",
      "🧪 Core (Alpha)",
      "🔧 Core (Beta)",
    ],
  );
  assert.ok(rows[6][0].callback_data?.startsWith("section:"));
  assert.ok(rows[7][0].callback_data?.startsWith("section:"));
});

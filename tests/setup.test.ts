/**
 * Regression tests for Bale setup prompt helpers
 * Exercises bot-token prompt defaults, setup success/failure, and prompt-runtime guard cleanup
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createBaleConfigStore } from "../lib/config.ts";
import {
  getBaleBotTokenDiagnostic,
  resolveBaleBotToken,
} from "../lib/config.ts";
import {
  BALE_BOT_TOKEN_INPUT_PLACEHOLDER,
  createBaleSetupPromptRuntime,
  getBaleBotTokenInputDefault,
  getBaleBotTokenPromptSpec,
  runBaleSetup,
  type BaleSetupConfig,
} from "../lib/setup.ts";

test("Setup token defaults prefer config, then env alias references, then placeholder", () => {
  assert.equal(
    getBaleBotTokenInputDefault(
      { BALE_BOT_TOKEN: " env-token " },
      " config-token ",
    ),
    "config-token",
  );
  assert.equal(
    getBaleBotTokenInputDefault({ BALE_KEY: " env-key " }),
    "$BALE_KEY",
  );
  assert.equal(
    getBaleBotTokenInputDefault({}),
    BALE_BOT_TOKEN_INPUT_PLACEHOLDER,
  );
});

test("Setup prefill persists the env alias and validates its resolved value", async () => {
  const calls: string[] = [];
  let persisted: BaleSetupConfig | undefined;
  const result = await runBaleSetup({
    hasUI: true,
    env: { BALE_BOT_TOKEN: "resolved-secret" },
    config: {},
    promptInput: async () => undefined,
    promptEditor: async (_label, value) => {
      calls.push(`editor:${value}`);
      return value;
    },
    getMe: async (botToken) => {
      calls.push(`getMe:${botToken}`);
      return { ok: true, result: { id: 9, username: "env_bot" } };
    },
    resolveBotToken: (value) =>
      resolveBaleBotToken(value, { BALE_BOT_TOKEN: "resolved-secret" }),
    describeBotToken: (value) =>
      getBaleBotTokenDiagnostic(value, {
        BALE_BOT_TOKEN: "resolved-secret",
      }),
    persistConfig: async (config) => {
      persisted = config;
    },
    notify: (message, level) => calls.push(`${level}:${message}`),
    startPolling: () => ({ ok: true }),
    updateStatus: () => calls.push("status"),
  });

  assert.equal(calls[0], "editor:$BALE_BOT_TOKEN");
  assert.equal(calls[1], "getMe:resolved-secret");
  assert.equal(persisted?.botToken, "$BALE_BOT_TOKEN");
  assert.equal(result.status, "success");
  assert.equal(
    result.status === "success" && result.config.botToken,
    "$BALE_BOT_TOKEN",
  );
  assert.ok(
    !calls.some(
      (call) =>
        (call.startsWith("info:") || call.startsWith("error:")) &&
        call.includes("resolved-secret"),
    ),
    "setup notifications must not expose the resolved secret",
  );
});

test("Setup rejects an unresolved token reference with a redacted diagnostic", async () => {
  const calls: string[] = [];
  const result = await runBaleSetup({
    hasUI: true,
    env: {},
    config: {},
    promptInput: async () => "$MISSING_BALE_TOKEN",
    promptEditor: async () => undefined,
    getMe: async () => {
      calls.push("getMe");
      return { ok: false };
    },
    resolveBotToken: (value) => resolveBaleBotToken(value, {}),
    describeBotToken: (value) => getBaleBotTokenDiagnostic(value, {}),
    persistConfig: async () => {
      calls.push("persist");
    },
    notify: (message, level) => calls.push(`${level}:${message}`),
    startPolling: () => calls.push("poll"),
    updateStatus: () => calls.push("status"),
  });

  assert.deepEqual(result, { status: "validation-failed" });
  assert.deepEqual(calls, [
    "error:Bale bot token environment variable MISSING_BALE_TOKEN is not set.",
  ]);
});

test("Setup rejects a malformed token reference without echoing it", async () => {
  const calls: string[] = [];
  const result = await runBaleSetup({
    hasUI: true,
    env: {},
    config: { botToken: "$not-a-valid-name" },
    promptInput: async () => undefined,
    promptEditor: async (_label, value) => value,
    getMe: async () => {
      calls.push("getMe");
      return { ok: false };
    },
    resolveBotToken: (value) => resolveBaleBotToken(value, {}),
    describeBotToken: (value) => getBaleBotTokenDiagnostic(value, {}),
    persistConfig: async () => {
      calls.push("persist");
    },
    notify: (message, level) => calls.push(`${level}:${message}`),
    startPolling: () => calls.push("poll"),
    updateStatus: () => calls.push("status"),
  });

  assert.deepEqual(result, { status: "validation-failed" });
  assert.deepEqual(calls, [
    "error:Bale bot token environment reference is malformed; use $NAME or ${NAME}.",
  ]);
});

test("Setup prompt spec uses editor for real tokens and input for placeholder", () => {
  assert.deepEqual(getBaleBotTokenPromptSpec({}, "123:abc"), {
    method: "editor",
    value: "123:abc",
  });
  assert.deepEqual(getBaleBotTokenPromptSpec({}), {
    method: "input",
    value: BALE_BOT_TOKEN_INPUT_PLACEHOLDER,
  });
});

test("Setup runner validates token, persists config, starts polling, and updates status", async () => {
  const calls: string[] = [];
  let persisted: unknown;
  const nextConfig = await runBaleSetup({
    hasUI: true,
    env: {},
    config: { allowedUserId: 42 },
    promptInput: async (_label, value) => {
      calls.push(`input:${value}`);
      return "token";
    },
    promptEditor: async () => {
      throw new Error("must not use editor for placeholder");
    },
    getMe: async (botToken) => {
      calls.push(`getMe:${botToken}`);
      return { ok: true, result: { id: 7, username: "demo_bot" } };
    },
    persistConfig: async (config) => {
      persisted = config;
      calls.push("persist");
    },
    notify: (message, level) => calls.push(`${level}:${message}`),
    startPolling: () => ({ ok: true, message: "Polling started" }),
    updateStatus: () => calls.push("status"),
  });

  assert.deepEqual(nextConfig, {
    status: "success",
    config: {
      allowedUserId: 42,
      botToken: "token",
      botId: 7,
      botUsername: "demo_bot",
    },
  });
  assert.deepEqual(persisted, nextConfig.config);
  assert.deepEqual(calls, [
    `input:${BALE_BOT_TOKEN_INPUT_PLACEHOLDER}`,
    "getMe:token",
    "persist",
    "info:Bale bot connected: @demo_bot",
    "info:Send /start to your bot in Bale to pair this extension with your account.",
    "info:Polling started",
    "status",
  ]);
});

test("Setup runner reports invalid tokens without persisting or starting polling", async () => {
  const calls: string[] = [];
  const nextConfig = await runBaleSetup({
    hasUI: true,
    env: {},
    config: {},
    promptInput: async () => "bad-token",
    promptEditor: async () => "bad-token",
    getMe: async () => ({ ok: false, description: "Unauthorized" }),
    persistConfig: async () => {
      calls.push("persist");
    },
    notify: (message, level) => calls.push(`${level}:${message}`),
    startPolling: () => calls.push("start"),
    updateStatus: () => calls.push("status"),
  });

  assert.deepEqual(nextConfig, { status: "validation-failed" });
  assert.deepEqual(calls, ["error:Unauthorized"]);
});

test("Setup runner distinguishes cancellation and polling startup failure", async () => {
  const baseDeps = {
    hasUI: true,
    env: {},
    config: {},
    promptEditor: async () => undefined,
    getMe: async () => ({
      ok: true,
      result: { id: 7, username: "demo_bot" },
    }),
    persistConfig: async () => undefined,
    notify: () => undefined,
    updateStatus: () => undefined,
  };
  assert.deepEqual(
    await runBaleSetup({
      ...baseDeps,
      hasUI: false,
      promptInput: async () => "token",
      startPolling: () => ({ ok: true }),
    }),
    { status: "unavailable" },
  );
  assert.deepEqual(
    await runBaleSetup({
      ...baseDeps,
      promptInput: async () => undefined,
      startPolling: () => ({ ok: true }),
    }),
    { status: "cancelled" },
  );
  const failed = await runBaleSetup({
    ...baseDeps,
    promptInput: async () => "token",
    startPolling: () => ({ ok: false, message: "Polling unavailable" }),
  });
  assert.equal(failed.status, "polling-failed");
  assert.equal(
    failed.status === "polling-failed" && failed.config.botToken,
    "token",
  );
});

test("Setup prompt runtime stores config before starting polling", async () => {
  const calls: string[] = [];
  let currentToken: string | undefined;
  const runtime = createBaleSetupPromptRuntime({
    env: {},
    getConfig: () => ({}),
    setConfig: (config) => {
      currentToken = config.botToken;
      calls.push(`set:${config.botToken}`);
    },
    setupGuard: {
      start: () => true,
      finish: () => calls.push("finish"),
    },
    getMe: async () => ({ ok: true, result: { id: 7, username: "demo_bot" } }),
    persistConfig: async (config) => {
      calls.push(`persist:${config.botToken}`);
    },
    startPolling: () => calls.push(`start:${currentToken ?? "missing"}`),
    updateStatus: () => calls.push("status"),
  });

  await runtime({
    hasUI: true,
    ui: {
      input: async () => "token",
      editor: async () => "token",
      notify: (message) => calls.push(`notify:${message}`),
    },
  });

  assert.deepEqual(calls, [
    "set:token",
    "persist:token",
    "notify:Bale bot connected: @demo_bot",
    "notify:Send /start to your bot in Bale to pair this extension with your account.",
    "start:token",
    "status",
    "finish",
  ]);
});

test("Setup prompt runtime rolls memory back when persistence fails", async () => {
  const calls: string[] = [];
  let config: BaleSetupConfig = { botToken: "previous" };
  const runtime = createBaleSetupPromptRuntime({
    env: {},
    getConfig: () => config,
    setConfig: (next) => {
      config = { ...next };
      calls.push(`set:${next.botToken}`);
    },
    setupGuard: {
      start: () => true,
      finish: () => calls.push("finish"),
    },
    getMe: async () => ({ ok: true, result: { id: 7, username: "demo_bot" } }),
    persistConfig: async () => {
      calls.push("persist");
      throw new Error("disk full");
    },
    startPolling: () => calls.push("unexpected:start"),
    updateStatus: () => calls.push("unexpected:status"),
    recordRuntimeEvent: () => calls.push("record"),
  });

  await assert.rejects(
    runtime({
      hasUI: true,
      ui: {
        input: async () => "token",
        editor: async () => "token",
        notify: () => calls.push("unexpected:notify"),
      },
    }),
    /disk full/,
  );
  assert.deepEqual(config, { botToken: "previous" });
  assert.deepEqual(calls, [
    "set:token",
    "persist",
    "set:previous",
    "record",
    "finish",
  ]);
});

test("Setup prompt runtime persists the first validated config to missing or empty files", async () => {
  for (const initialFile of [undefined, "{}\n"]) {
    const dir = await mkdtemp(join(tmpdir(), "pi-bale-setup-first-run-"));
    const configPath = join(dir, "bale.json");
    try {
      if (initialFile !== undefined) await writeFile(configPath, initialFile);
      const store = createBaleConfigStore({ agentDir: dir, configPath });
      await store.load();
      const runtime = createBaleSetupPromptRuntime({
        env: { BALE_BOT_TOKEN: "env-token" },
        getConfig: store.get,
        setConfig: store.set,
        setupGuard: { start: () => true, finish: () => {} },
        getMe: async () => ({
          ok: true,
          result: { id: 77, username: "first_run_bot" },
        }),
        persistConfig: async () => store.persist(),
        startPolling: () => ({ ok: true }),
        updateStatus: () => {},
      });

      const result = await runtime({
        hasUI: true,
        ui: {
          input: async () => "env-token",
          editor: async () => "env-token",
          notify: () => {},
        },
      });

      assert.equal(result.status, "success");
      assert.deepEqual(JSON.parse(await readFile(configPath, "utf8")), {
        profiles: {
          default: {
            botToken: "env-token",
            botUsername: "first_run_bot",
            botId: 77,
          },
        },
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

test("Setup prompt runtime persists a first named profile without changing siblings", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-bale-setup-profile-"));
  const configPath = join(dir, "bale.json");
  try {
    const store = createBaleConfigStore({
      agentDir: dir,
      configPath,
      initialConfig: {
        botToken: "default-token",
        botId: 1,
        profiles: {
          existing: { botToken: "existing-token", botId: 2 },
          fresh: { botToken: "" },
        },
      },
    });
    assert.equal(store.activateProfile("fresh"), true);
    const runtime = createBaleSetupPromptRuntime({
      env: { BALE_BOT_TOKEN: "fresh-token" },
      getConfig: store.get,
      setConfig: store.set,
      setupGuard: { start: () => true, finish: () => {} },
      getMe: async () => ({
        ok: true,
        result: { id: 3, username: "fresh_bot" },
      }),
      persistConfig: async () => store.persist(),
      startPolling: () => ({ ok: true }),
      updateStatus: () => {},
    });

    const result = await runtime({
      hasUI: true,
      ui: {
        input: async () => "fresh-token",
        editor: async () => "fresh-token",
        notify: () => {},
      },
    });

    assert.equal(result.status, "success");
    assert.deepEqual(JSON.parse(await readFile(configPath, "utf8")), {
      profiles: {
        default: { botToken: "default-token", botId: 1 },
        existing: { botToken: "existing-token", botId: 2 },
        fresh: {
          botToken: "fresh-token",
          botUsername: "fresh_bot",
          botId: 3,
        },
      },
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Setup prompt runtime reports token check errors and always finishes", async () => {
  const calls: string[] = [];
  let locked = false;
  const runtime = createBaleSetupPromptRuntime({
    env: {},
    getConfig: () => ({}),
    setConfig: () => calls.push("set-config"),
    setupGuard: {
      start: () => {
        if (locked) return false;
        locked = true;
        calls.push("guard-start");
        return true;
      },
      finish: () => {
        locked = false;
        calls.push("guard-finish");
      },
    },
    getMe: async () => {
      throw new Error("network down");
    },
    persistConfig: async () => {
      calls.push("persist");
    },
    startPolling: () => calls.push("start"),
    updateStatus: () => calls.push("status"),
    recordRuntimeEvent: (category, error) =>
      calls.push(`${category}:${(error as Error).message}`),
  });

  await runtime({
    hasUI: true,
    ui: {
      input: async () => "token",
      editor: async () => "token",
      notify: (message) => calls.push(`notify:${message}`),
    },
  });

  assert.deepEqual(calls, [
    "guard-start",
    "notify:Bale API check failed: network down",
    "guard-finish",
  ]);
  assert.equal(locked, false);
});

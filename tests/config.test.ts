/**
 * Regression tests for Bale config and setup prompt defaults
 * Covers persisted config state plus token-prefill priority across stored config, environment variables, and placeholder fallback
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

import type { BaleConfig } from "../lib/config.ts";
import {
  getBaleBotTokenDiagnostic,
  resolveBaleBotToken,
  createBaleActiveProfileKeyGetter,
  createBaleConfigBotIdGetter,
  createBaleConfigControls,
  createBaleConfigStore,
  createBaleProactivePushTargetGetter,
  createBaleTimeInjectionModeGetter,
  createBaleTimeInjectionModeSetter,
  createBaleUserPairingRuntime,
  createBaleVoiceReplyModeConfiguredChecker,
  createBaleVoiceReplyModeGetter,
  createBaleVoiceReplyModeSetter,
  getBaleAuthorizationState,
  isValidBaleProfileName,
  normalizeBaleDefaultProfileConfig,
  pairBaleUserIfNeeded,
  readBaleConfig,
  resolveBaleThreadDisplayMode,
  setBaleThreadDisplayMode,
} from "../lib/config.ts";
import { createBaleJournalSourceSerialization } from "../lib/journal.ts";
import { createBaleSettingsMenuRuntime } from "../lib/menu-settings.ts";
import { createBaleLockRuntime } from "../lib/locks.ts";

const execFileAsync = promisify(execFile);

function legacyConfig(value: Record<string, unknown>): BaleConfig {
  return value as BaleConfig;
}

/** Seed a config file the way an operator-edited, atomically replaced file appears on disk. */
async function writeBaleConfig(
  agentDir: string,
  configPath: string,
  config: BaleConfig,
): Promise<void> {
  await mkdir(agentDir, { recursive: true });
  const tempConfigPath = `${configPath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tempConfigPath, JSON.stringify(config, null, "\t") + "\n", {
    encoding: "utf8",
    mode: 0o600,
  });
  await chmod(tempConfigPath, 0o600);
  await rename(tempConfigPath, configPath);
  await chmod(configPath, 0o600);
}
import {
  createBaleSetupPromptRuntime,
  getBaleBotTokenInputDefault,
  getBaleBotTokenPromptSpec,
  runBaleSetup,
} from "../lib/setup.ts";

test("Thread display mode keeps every supported mode and maps invalid values to letters", () => {
  for (const mode of [undefined, "invalid", null]) {
    assert.equal(resolveBaleThreadDisplayMode(legacyConfig({
      threads: { displayMode: mode },
    })), "letters");
  }
  assert.equal(resolveBaleThreadDisplayMode({}), "letters");
  assert.equal(resolveBaleThreadDisplayMode({ threads: { displayMode: "names" } }), "names");
  assert.equal(resolveBaleThreadDisplayMode({ threads: { displayMode: "letters" } }), "letters");
  assert.equal(resolveBaleThreadDisplayMode(legacyConfig({ threads: { displayMode: "directories" } })), "letters");
  assert.equal(resolveBaleThreadDisplayMode({ threads: { displayMode: "directory-snake" } }), "directory-snake");
  assert.equal(resolveBaleThreadDisplayMode({ threads: { displayMode: "directory-title" } }), "directory-title");
  // The retired profile-scoped key is not read as an effective value.
  assert.equal(resolveBaleThreadDisplayMode(legacyConfig({ threadDisplayMode: "names" })), "letters");
});

test("Thread display mode is shared top-level config, never profile state", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "pi-bale-display-mode-"));
  const configPath = join(agentDir, "bale.json");
  const store = createBaleConfigStore({ agentDir, configPath, initialConfig: {
    profiles: {
      default: { botToken: "token-default" },
      work: { botToken: "token-work" },
    },
    threads: { automaticCleanup: false, displayMode: "directory-title" },
  } });
  try {
    await store.persist();
    assert.equal(resolveBaleThreadDisplayMode(store.get()), "directory-title");
    store.activateProfile("work");
    assert.equal(resolveBaleThreadDisplayMode(store.get()), "directory-title");
    await setBaleThreadDisplayMode(store, "names", () => true);
    const saved = await readBaleConfig(configPath);
    assert.deepEqual(saved.threads, { automaticCleanup: false, displayMode: "names" });
    assert.deepEqual(saved.profiles, {
      default: { botToken: "token-default" },
      work: { botToken: "token-work" },
    });
    const restored = createBaleConfigStore({ agentDir, configPath });
    await restored.load();
    assert.equal(resolveBaleThreadDisplayMode(restored.get()), "names");
    restored.activateProfile("work");
    assert.equal(resolveBaleThreadDisplayMode(restored.get()), "names");
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
});

test("Retired profile-scoped Thread display mode is ignored without migration", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "pi-bale-display-retired-"));
  const configPath = join(agentDir, "bale.json");
  const legacy = legacyConfig({
    profiles: {
      default: { botToken: "token-default", allowedUserId: 7, threadDisplayMode: "directory-title" },
    },
    threads: { automaticCleanup: false },
  });
  try {
    await writeBaleConfig(agentDir, configPath, legacy);
    const store = createBaleConfigStore({ agentDir, configPath });
    await store.load();
    assert.equal(resolveBaleThreadDisplayMode(store.get()), "letters");
    assert.deepEqual(await readBaleConfig(configPath), legacy, "Loading must not migrate config");
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
});

test("Thread display preference writes fence authority inside the config transaction", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "pi-bale-display-fence-"));
  const configPath = join(agentDir, "bale.json");
  const store = createBaleConfigStore({ agentDir, configPath,
    initialConfig: { profiles: { default: { botToken: "token" } } } });
  try {
    await store.persist();
    await setBaleThreadDisplayMode(store, "directory-snake", () => true);
    assert.equal(resolveBaleThreadDisplayMode(store.get()), "directory-snake");
    let current = true;
    const pending = store.persist({ ...store.get(), threads: { displayMode: "letters" } }, {
      isCurrent: () => current,
    });
    current = false;
    await assert.rejects(pending, /originating authority/);
    assert.equal((await readBaleConfig(configPath)).threads?.displayMode, "directory-snake");
    assert.equal(resolveBaleThreadDisplayMode(store.get()), "directory-snake");
    await assert.rejects(
      setBaleThreadDisplayMode(store, "names", () => false),
      /lost authority/,
    );
    await assert.rejects(
      setBaleThreadDisplayMode(store, "bogus" as never, () => true),
      /Invalid Bale Thread display mode/,
    );
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
});

test("Config projections own bot and effective profile lookup", () => {
  const store = createBaleConfigStore({
    initialConfig: {
      profiles: {
        default: { botToken: "token-a", botId: 7 },
        work: { botToken: "token-b", botId: 8 },
      },
    },
  });
  const getBotId = createBaleConfigBotIdGetter(store);
  const getProfileKey = createBaleActiveProfileKeyGetter(store);
  assert.equal(getBotId(), 7);
  assert.equal(getProfileKey(), "default");
  store.activateProfile("work");
  assert.equal(getBotId(), 8);
  assert.equal(getProfileKey(), "work");
});

test("Bale profile names allow only lowercase letters and digits", () => {
  assert.equal(isValidBaleProfileName("work2"), true);
  assert.equal(isValidBaleProfileName("previous"), true);
  assert.equal(isValidBaleProfileName("prev"), true);
  assert.equal(isValidBaleProfileName("default"), true);
  for (const name of [
    "main",
    "active",
    "Work",
    "work-one",
    "work_one",
    "work.one",
    "work one",
    "",
  ]) {
    assert.equal(isValidBaleProfileName(name), false, name);
  }
});

test("Bale config helper returns empty config when file is absent", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "pi-bale-missing-config-"));
  assert.deepEqual(
    await readBaleConfig(join(agentDir, "bale.json")),
    {},
  );
});

test("activity defaults absent config to verbose, fails invalid values closed, and migrates legacy verbosity on write", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "pi-bale-verbosity-"));
  const configPath = join(agentDir, "bale.json");
  const store = createBaleConfigStore({
    agentDir,
    configPath,
    initialConfig: {
      assistant: {
        activityVerbosity: "verbose",
      },
    },
  });
  const controls = createBaleConfigControls(store);
  store.set({});
  assert.equal(controls.getActivityVerbosity(), "verbose");
  store.set({ assistant: { activityVerbosity: "quiet" } });
  assert.equal(controls.getActivityVerbosity(), "quiet");
  store.set({ assistant: { activityVerbosity: "verbose" } });
  assert.equal(controls.getActivityVerbosity(), "verbose");
  store.set({
    assistant: {
      activity: "unexpected" as "quiet",
      activityVerbosity: "verbose",
    },
  });
  assert.equal(controls.getActivityVerbosity(), "quiet");
  await controls.setActivityVerbosity("thinking");
  assert.equal(controls.getActivityVerbosity(), "thinking");
  await controls.setActivityVerbosity("tools");
  assert.equal(controls.getActivityVerbosity(), "tools");
  await controls.setActivityVerbosity("verbose");
  assert.equal(controls.getActivityVerbosity(), "verbose");
  const persisted = JSON.parse(await readFile(configPath, "utf8"));
  assert.equal(persisted.assistant.activity, "verbose");
  assert.equal(persisted.assistant.activityVerbosity, undefined);
});

test("Concurrent config processes preserve independent settings mutations", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "pi-bale-config-processes-"));
  const configPath = join(agentDir, "bale.json");
  await writeFile(
    configPath,
    `${JSON.stringify({ assistant: { activity: "verbose", timeInjection: "interval" } })}\n`,
    "utf8",
  );
  const moduleUrl = pathToFileURL(
    join(process.cwd(), "lib", "config.ts"),
  ).href;
  const script = `
    import { createBaleConfigControls, createBaleConfigStore } from ${JSON.stringify(moduleUrl)};
    const store = createBaleConfigStore({
      agentDir: process.env.TEST_AGENT_DIR,
      configPath: process.env.TEST_CONFIG_PATH,
    });
    await store.load();
    const controls = createBaleConfigControls(store);
    if (process.env.TEST_MUTATION === "activity") {
      await controls.setActivityVerbosity("quiet");
    } else {
      await controls.setTimeInjectionMode("always");
    }
  `;
  const runMutation = (mutation: "activity" | "time") =>
    execFileAsync(
      process.execPath,
      ["--experimental-strip-types", "--input-type=module", "--eval", script],
      {
        env: {
          ...process.env,
          TEST_AGENT_DIR: agentDir,
          TEST_CONFIG_PATH: configPath,
          TEST_MUTATION: mutation,
        },
        timeout: 10_000,
      },
    );
  try {
    await Promise.all([runMutation("activity"), runMutation("time")]);
    const persisted = JSON.parse(await readFile(configPath, "utf8"));
    assert.equal(persisted.assistant.activity, "quiet");
    assert.equal(persisted.assistant.timeInjection, "always");
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
});

test("Cross-process pairing observation serializes before an owner-fenced grant", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "bale-pair-process-order-"));
  const configPath = join(agentDir, "bale.json");
  const locksPath = join(agentDir, "owners.json");
  const startPath = join(agentDir, "start");
  const ownerHeldPath = join(agentDir, "owner-held");
  const configModule = new URL("../lib/config.ts", import.meta.url).href;
  const locksModule = new URL("../lib/locks.ts", import.meta.url).href;
  await writeFile(configPath, JSON.stringify({ profiles: { default: { botToken: "fixture-token" } } }));
  const script = `
    import { existsSync, writeFileSync } from "node:fs";
    import { createBaleConfigStore } from ${JSON.stringify(configModule)};
    import { createBaleLockRuntime } from ${JSON.stringify(locksModule)};
    const store = createBaleConfigStore({ agentDir: process.env.TEST_AGENT_DIR, configPath: process.env.TEST_CONFIG_PATH });
    await store.load();
    const deadline = Date.now() + 8000;
    while (!existsSync(process.env.TEST_START_PATH)) {
      if (Date.now() >= deadline) throw new Error("start barrier timed out");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2);
    }
    const owner = createBaleLockRuntime({ locksPath: process.env.TEST_LOCKS_PATH, instanceId: "pair-grant-child" });
    if (!owner.acquire({ cwd: "/fixture" }).ok) throw new Error("fixture ownership unavailable");
    try {
      const allowed = await store.persistAllowedUserId(42, undefined, (publish) => owner.commitIfOwned(() => {
        writeFileSync(process.env.TEST_OWNER_HELD_PATH, "held");
        publish();
      }));
      process.stdout.write(JSON.stringify({ allowed, userId: store.getAllowedUserId() }));
    } finally { owner.release(); }
  `;
  const grant = execFileAsync(process.execPath,
    ["--experimental-strip-types", "--input-type=module", "--eval", script], {
      env: { ...process.env, TEST_AGENT_DIR: agentDir, TEST_CONFIG_PATH: configPath,
        TEST_LOCKS_PATH: locksPath, TEST_START_PATH: startPath, TEST_OWNER_HELD_PATH: ownerHeldPath },
      timeout: 15_000,
    });
  try {
    const store = createBaleConfigStore({ agentDir, configPath });
    await store.load();
    const tokenSha256 = createHash("sha256").update("fixture-token").digest("hex");
    const before = store.withPairingAdmission("default", tokenSha256, (excluded) => {
      fs.writeFileSync(startPath, "start");
      const deadline = Date.now() + 8000;
      while (!fs.existsSync(ownerHeldPath)) {
        if (Date.now() >= deadline) throw new Error("owner barrier timed out");
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2);
      }
      assert.equal(fs.existsSync(`${configPath}.transaction`), true);
      assert.equal(fs.existsSync(`${locksPath}.transaction`), true);
      assert.equal(JSON.parse(fs.readFileSync(configPath, "utf8")).profiles.default.allowedUserId, undefined);
      return excluded;
    });
    assert.equal(before, true);
    assert.deepEqual(JSON.parse((await grant).stdout), { allowed: true, userId: 42 });
    assert.equal(store.getAllowedUserId(), undefined, "The observing process still has its original cache");
    assert.equal(store.withPairingAdmission("default", tokenSha256, (excluded) => excluded), false);
    assert.equal(fs.existsSync(`${configPath}.transaction`), false);
    assert.equal(fs.existsSync(`${locksPath}.transaction`), false);
  } finally {
    await grant.catch(() => undefined);
    await rm(agentDir, { recursive: true, force: true });
  }
});

test("Bale config reads valid atomic snapshots without acquiring the transaction guard", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "pi-bale-config-read-"));
  const configPath = join(agentDir, "bale.json");
  const transactionPath = `${configPath}.transaction`;
  const generation = "10000000-0000-4000-8000-000000000001";
  await writeFile(configPath, '{"botToken":"123:abc"}\n', "utf8");
  await mkdir(transactionPath);
  await writeFile(
    join(transactionPath, `owner.${generation}.json`),
    `${JSON.stringify({ pid: process.pid, acquiredAtMs: Date.now(), generation })}\n`,
    "utf8",
  );
  try {
    assert.deepEqual(await readBaleConfig(configPath), {
      botToken: "123:abc",
    });
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
});

test("Bale proactive target getter prefers active then assigned targets", () => {
  const target = createBaleProactivePushTargetGetter({
    getActiveTurnTarget: () => undefined,
    getAssignedTarget: () => ({ chatId: -1007, threadId: 42 }),
    getAllowedUserId: () => 7,
  });
  assert.deepEqual(target(), { chatId: -1007, threadId: 42 });

  const activeTarget = createBaleProactivePushTargetGetter({
    getActiveTurnTarget: () => ({ chatId: -1008, threadId: 99 }),
    getAssignedTarget: () => ({ chatId: -1007, threadId: 42 }),
    getAllowedUserId: () => 7,
  });
  assert.deepEqual(activeTarget(), { chatId: -1008, threadId: 99 });

  const privateTarget = createBaleProactivePushTargetGetter({
    getActiveTurnTarget: () => undefined,
    getAssignedTarget: () => undefined,
    getAllowedUserId: () => 7,
  });
  assert.deepEqual(privateTarget(), { chatId: 7 });
});

test("Bale config helpers persist and reload config", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "pi-bale-config-"));
  const configPath = join(agentDir, "bale.json");
  const config = {
    botToken: "123:abc",
    botUsername: "demo_bot",
    allowedUserId: 42,
  };
  await writeBaleConfig(agentDir, configPath, config);
  const reloaded = await readBaleConfig(configPath);
  assert.deepEqual(reloaded, config);
  const raw = await readFile(configPath, "utf8");
  assert.match(raw, /demo_bot/);
  if (process.platform !== "win32") {
    assert.equal((await stat(configPath)).mode & 0o777, 0o600);
  }
  assert.deepEqual(
    (await readdir(agentDir)).filter((entry) => entry.includes(".tmp-")),
    [],
  );
});

test("Bale default profile normalization moves legacy root identity", () => {
  const normalized = normalizeBaleDefaultProfileConfig(legacyConfig({
    botToken: "123:abc",
    botUsername: "demo_bot",
    botId: 123,
    allowedUserId: 7,
    lastUpdateId: 9,
    voice: { replyMode: "mirror" },
    profiles: { work: { botToken: "456:def" } },
  }));

  assert.equal(normalized.changed, true);
  assert.deepEqual(normalized.config, {
    voice: { replyMode: "mirror" },
    profiles: {
      default: {
        botToken: "123:abc",
        botUsername: "demo_bot",
        botId: 123,
        allowedUserId: 7,
        lastUpdateId: 9,
      },
      work: { botToken: "456:def" },
    },
  });
});

test("Bale default profile normalization rejects conflicting identity", () => {
  assert.throws(
    () =>
      normalizeBaleDefaultProfileConfig({
        botToken: "123:abc",
        profiles: { default: { botToken: "456:def" } },
      }),
    /Conflicting Bale default profile identity/,
  );
});

test("Bale default profile normalization collapses identical duplicates", () => {
  const normalized = normalizeBaleDefaultProfileConfig({
    botToken: "123:abc",
    allowedUserId: 7,
    profiles: {
      default: { botToken: "123:abc", allowedUserId: 7 },
      work: { botToken: "456:def" },
    },
  });

  assert.equal(normalized.changed, true);
  assert.deepEqual(normalized.config, {
    profiles: {
      default: { botToken: "123:abc", allowedUserId: 7 },
      work: { botToken: "456:def" },
    },
  });
});

test("Bale default profile normalization merges non-conflicting fields", () => {
  const normalized = normalizeBaleDefaultProfileConfig({
    botToken: "123:abc",
    allowedUserId: 7,
    profiles: {
      default: { botToken: "123:abc", botUsername: "demo_bot" },
    },
  });

  assert.equal(normalized.changed, true);
  assert.deepEqual(normalized.config, {
    profiles: {
      default: {
        botToken: "123:abc",
        botUsername: "demo_bot",
        allowedUserId: 7,
      },
    },
  });
});

test("Bale config load rejects conflicting default identity without mutation", async () => {
  const agentDir = await mkdtemp(
    join(tmpdir(), "pi-bale-default-conflict-"),
  );
  const configPath = join(agentDir, "bale.json");
  const original = `${JSON.stringify(
    {
      botToken: "123:abc",
      profiles: { default: { botToken: "456:def" } },
    },
    null,
    2,
  )}\n`;
  await writeFile(configPath, original, "utf8");
  try {
    const store = createBaleConfigStore({ agentDir, configPath });
    await assert.rejects(
      store.load(),
      /Conflicting Bale default profile identity/,
    );
    assert.equal(await readFile(configPath, "utf8"), original);
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
});

test("Bale config load atomically normalizes the default profile", async () => {
  const agentDir = await mkdtemp(
    join(tmpdir(), "pi-bale-default-profile-"),
  );
  const configPath = join(agentDir, "bale.json");
  await writeBaleConfig(
    agentDir,
    configPath,
    legacyConfig({
      botToken: "123:abc",
      allowedUserId: 7,
      assistant: { proactivePush: false },
    }),
  );
  const store = createBaleConfigStore({ agentDir, configPath });

  await store.load();

  assert.equal(store.getBotToken(), "123:abc");
  assert.equal(store.getAllowedUserId(), 7);
  assert.deepEqual(await readBaleConfig(configPath), {
    profiles: {
      default: { botToken: "123:abc", allowedUserId: 7 },
    },
  });
});

test("Bale config store persists active named profile configuration without overwriting default", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "pi-bale-profile-config-"));
  const configPath = join(agentDir, "bale.json");
  const store = createBaleConfigStore({
    agentDir,
    configPath,
    initialConfig: legacyConfig({
      botToken: "default-token",
      botUsername: "default_bot",
      allowedUserId: 1,
      voice: { replyMode: "mirror" },
      profiles: {
        omp: {
          botToken: "omp-token",
          botUsername: "omp_bot",
          allowedUserId: 2,
        },
      },
    }),
  });

  assert.equal(store.activateProfile("omp"), true);
  assert.equal(store.getBotToken(), "omp-token");
  assert.equal(store.getAllowedUserId(), 2);
  store.setAllowedUserId(3);
  await store.persist();

  assert.deepEqual(await readBaleConfig(configPath), {
    voice: { replyMode: "mirror" },
    profiles: {
      default: {
        botToken: "default-token",
        botUsername: "default_bot",
        allowedUserId: 1,
      },
      omp: {
        botToken: "omp-token",
        botUsername: "omp_bot",
        allowedUserId: 3,
      },
    },
  });
});

test("Stale config persistence preserves unrelated global and profile disk deltas", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-bale-config-delta-"));
  const configPath = join(dir, "bale.json");
  try {
    await writeBaleConfig(dir, configPath, legacyConfig({
      profiles: {
        default: { botToken: "default-token" },
        work: { botToken: "work-token", lastUpdateId: 10 },
      },
      assistant: { rendering: "rich" },
    }));
    const stale = createBaleConfigStore({ agentDir: dir, configPath });
    await stale.load();

    await writeBaleConfig(dir, configPath, legacyConfig({
      profiles: {
        default: { botToken: "default-token" },
        work: {
          botToken: "work-token",
          lastUpdateId: 10,
          allowedUserId: 42,
        },
      },
      assistant: { rendering: "rich", timeInjection: "interval" },
      time: { interval: 5000 },
    }));
    stale.update((config) => {
      config.voice = { replyMode: "mirror" };
    });
    await stale.persist();

    assert.deepEqual(await readBaleConfig(configPath), {
      profiles: {
        default: { botToken: "default-token" },
        work: {
          botToken: "work-token",
          lastUpdateId: 10,
          allowedUserId: 42,
        },
      },
      assistant: { rendering: "rich", timeInjection: "interval" },
      time: { interval: 5000 },
      voice: { replyMode: "mirror" },
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("No-op config persistence adopts newer disk state without rewriting it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-bale-config-noop-"));
  const configPath = join(dir, "bale.json");
  try {
    await writeBaleConfig(dir, configPath, {
      profiles: { default: { botToken: "default-token" } },
    });
    const store = createBaleConfigStore({ agentDir: dir, configPath });
    await store.load();
    await writeBaleConfig(dir, configPath, {
      profiles: { default: { botToken: "default-token" } },
      assistant: { timeInjection: "interval" },
      time: { interval: 5000 },
    });
    const stableTime = new Date("2001-01-01T00:00:00.000Z");
    await utimes(configPath, stableTime, stableTime);

    await store.persist();

    assert.deepEqual(store.get().time, { interval: 5000 });
    assert.deepEqual(await readBaleConfig(configPath), {
      profiles: { default: { botToken: "default-token" } },
      assistant: { timeInjection: "interval" },
      time: { interval: 5000 },
    });
    assert.ok(
      Math.abs((await stat(configPath)).mtimeMs - stableTime.getTime()) < 5,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Bale config store rejects missing named profile activation", () => {
  const store = createBaleConfigStore({
    initialConfig: { profiles: { work: { botToken: "work-token" } } },
  });

  assert.equal(store.activateProfile("missing"), false);
  assert.equal(store.getActiveProfileName(), undefined);
  assert.equal(store.getBotToken(), undefined);
});

test("Bale config load recovers invalid JSON and records a diagnostic", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "pi-bale-invalid-config-"));
  const configPath = join(agentDir, "bale.json");
  await writeFile(configPath, "{not valid json", "utf8");
  const events: string[] = [];
  const store = createBaleConfigStore({
    agentDir,
    configPath,
    initialConfig: { botToken: "previous" },
    recordRuntimeEvent: (category, error, details) => {
      events.push(
        `${category}:${error instanceof Error ? error.name : String(error)}:${details?.phase}:${String(details?.recoveryPath ?? "")}`,
      );
    },
  });

  await store.load();

  assert.deepEqual(store.get(), {});
  const entries = await readdir(agentDir);
  const recovery = entries.find((entry) =>
    entry.startsWith("bale.json.invalid-"),
  );
  assert.ok(recovery);
  assert.equal(
    await readFile(join(agentDir, recovery), "utf8"),
    "{not valid json",
  );
  assert.equal(entries.includes("bale.json"), false);
  assert.equal(events.length, 1);
  assert.match(events[0] ?? "", /^config:SyntaxError:load:/);
});

test("Bale voice reply mode helpers normalize legacy hidden to manual", () => {
  let config: BaleConfig = {};
  const store = { get: () => config };
  const getMode = createBaleVoiceReplyModeGetter(store);
  const isConfigured = createBaleVoiceReplyModeConfiguredChecker(store);

  assert.equal(getMode(), "manual");
  assert.equal(isConfigured(), false);

  config = { voice: { replyMode: "hidden" } };
  assert.equal(getMode(), "manual");
  assert.equal(isConfigured(), false);

  config = { voice: { replyMode: "manual" } };
  assert.equal(getMode(), "manual");
  assert.equal(isConfigured(), false);

  config = { voice: { replyMode: "invalid" } } as unknown as BaleConfig;
  assert.equal(getMode(), "manual");
  assert.equal(isConfigured(), false);
});

test("Bale voice reply mode setter persists bale.json", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "pi-bale-voice-mode-"));
  const configPath = join(agentDir, "bale.json");
  const store = createBaleConfigStore({
    initialConfig: { botToken: "123:abc" },
    agentDir,
    configPath,
  });
  const setMode = createBaleVoiceReplyModeSetter(store);

  await setMode("mirror");

  assert.deepEqual(store.get().voice, { replyMode: "mirror" });
  assert.deepEqual(await readBaleConfig(configPath), {
    profiles: { default: { botToken: "123:abc" } },
    voice: { replyMode: "mirror" },
  });

  await setMode("manual");

  assert.equal(store.get().voice, undefined);
  assert.deepEqual(await readBaleConfig(configPath), {
    profiles: { default: { botToken: "123:abc" } },
  });
});

test("Bale config normalization removes the retired proactive push option", () => {
  const normalized = normalizeBaleDefaultProfileConfig(
    legacyConfig({
      assistant: { proactivePush: false, rendering: "html" },
    }),
  );

  assert.equal(normalized.changed, true);
  assert.deepEqual(normalized.config, {
    assistant: { rendering: "html" },
  });
});

test("Bale settings setters reload before scoped writes to preserve shared config changes", async () => {
  const agentDir = await mkdtemp(
    join(tmpdir(), "pi-bale-shared-settings-"),
  );
  const configPath = join(agentDir, "bale.json");
  await writeBaleConfig(agentDir, configPath, { botToken: "123:abc" });
  const firstStore = createBaleConfigStore({ agentDir, configPath });
  const secondStore = createBaleConfigStore({ agentDir, configPath });
  await firstStore.load();
  await secondStore.load();

  const setVoiceMode = createBaleVoiceReplyModeSetter(firstStore);
  const staleReaderControls = createBaleConfigControls(firstStore);
  const controls = createBaleConfigControls(secondStore);
  assert.equal(controls.isAutomaticThreadCleanupEnabled(), true);

  await setVoiceMode("mirror");
  await controls.setDraftPreviewsEnabled(true);
  await controls.setAssistantRenderingMode("html");
  await controls.setActivityVerbosity("verbose");
  await controls.setAutomaticThreadCleanupEnabled(false);
  assert.equal(staleReaderControls.isAutomaticThreadCleanupEnabled(), true);
  assert.equal(
    await staleReaderControls.resolveAutomaticThreadCleanupEnabled(),
    false,
  );

  assert.deepEqual(await readBaleConfig(configPath), {
    profiles: { default: { botToken: "123:abc" } },
    assistant: {
      draftPreviews: true,
      rendering: "html",
      activity: "verbose",
    },
    voice: { replyMode: "mirror" },
    threads: { automaticCleanup: false },
  });
  assert.equal(controls.getAssistantRenderingMode(), "html");
  assert.equal(controls.getActivityVerbosity(), "verbose");
  assert.equal(controls.isAutomaticThreadCleanupEnabled(), false);
  assert.deepEqual(secondStore.get().voice, { replyMode: "mirror" });
});

test("Thread cleanup fails closed after invalid shared config recovery", async () => {
  const agentDir = await mkdtemp(
    join(tmpdir(), "pi-bale-invalid-cleanup-setting-"),
  );
  const configPath = join(agentDir, "bale.json");
  await writeBaleConfig(agentDir, configPath, {
    profiles: { default: { botToken: "123:abc" } },
    threads: { automaticCleanup: false },
  });
  const store = createBaleConfigStore({ agentDir, configPath });
  await store.load();
  const controls = createBaleConfigControls(store);
  await writeFile(configPath, "{invalid", "utf8");

  await assert.rejects(
    controls.resolveAutomaticThreadCleanupEnabled(),
    /unavailable after invalid Bale config recovery/,
  );
  assert.equal(store.didLastLoadRecoverInvalidConfig(), true);
  assert.equal(controls.isAutomaticThreadCleanupEnabled(), false);
});

test("Bale draft previews default on while explicit current and legacy choices remain authoritative", async () => {
  for (const [config, expected] of [
    [{ profiles: { default: { botToken: "123:abc" } } }, true],
    [{ profiles: { default: { botToken: "123:abc" } }, assistant: { draftPreviews: false } }, false],
    [{ profiles: { default: { botToken: "123:abc" } }, draftPreviews: false }, false],
    [{ profiles: { default: { botToken: "123:abc" } }, richDraftPreviews: false }, false],
  ] as const) {
    const agentDir = await mkdtemp(join(tmpdir(), "pi-bale-draft-default-"));
    const configPath = join(agentDir, "bale.json");
    await writeBaleConfig(agentDir, configPath, config);
    const store = createBaleConfigStore({ agentDir, configPath });
    await store.load();
    assert.equal(createBaleConfigControls(store).areDraftPreviewsEnabled(), expected);
    assert.deepEqual(await readBaleConfig(configPath), config, "Reading a default must not persist or migrate config");
  }
});

test("Bale draft preview config reads and migrates legacy rich flag", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "pi-bale-draft-legacy-"));
  const configPath = join(agentDir, "bale.json");
  await writeBaleConfig(agentDir, configPath, {
    botToken: "123:abc",
    richDraftPreviews: true,
  });
  const store = createBaleConfigStore({ agentDir, configPath });
  await store.load();
  const controls = createBaleConfigControls(store);

  assert.equal(controls.areDraftPreviewsEnabled(), true);
  await controls.setDraftPreviewsEnabled(false);
  assert.deepEqual(await readBaleConfig(configPath), {
    profiles: { default: { botToken: "123:abc" } },
    assistant: { draftPreviews: false },
  });
});

test("Bale settings menu callbacks persist voice and time settings to bale.json", async () => {
  const agentDir = await mkdtemp(
    join(tmpdir(), "pi-bale-settings-callbacks-"),
  );
  const configPath = join(agentDir, "bale.json");
  const store = createBaleConfigStore({
    initialConfig: { botToken: "123:abc" },
    agentDir,
    configPath,
  });
  const controls = createBaleConfigControls(store);
  const state = {
    chatId: 1,
    messageId: 2,
    mode: "settings" as const,
    page: 0,
    scope: "all" as const,
    scopedModels: [],
    allModels: [],
  };
  const runtime = createBaleSettingsMenuRuntime({
    ...controls,
    getModelMenuState: async () => state,
    getStoredModelMenuState: () => state,
    storeModelMenuState: () => {},
    editInteractiveMessage: async () => {},
    sendInteractiveMessage: async () => state.messageId,
    answerCallbackQuery: async () => {},
  });

  assert.equal(
    await runtime.handleCallbackQuery(
      {
        id: "voice",
        data: "settings:set:voice-reply:mirror",
        message: { message_id: state.messageId },
      },
      {},
    ),
    true,
  );
  assert.equal(
    await runtime.handleCallbackQuery(
      {
        id: "time",
        data: "settings:set:time-injection:always",
        message: { message_id: state.messageId },
      },
      {},
    ),
    true,
  );
  assert.equal(
    await runtime.handleCallbackQuery(
      {
        id: "drafts",
        data: "settings:set:draft-previews:on",
        message: { message_id: state.messageId },
      },
      {},
    ),
    true,
  );
  assert.deepEqual(await readBaleConfig(configPath), {
    profiles: { default: { botToken: "123:abc" } },
    assistant: { draftPreviews: true, timeInjection: "always" },
    voice: { replyMode: "mirror" },
  });
});

test("Bale time injection mode setter persists bale.json", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "pi-bale-time-mode-"));
  const configPath = join(agentDir, "bale.json");
  const store = createBaleConfigStore({
    initialConfig: {
      botToken: "123:abc",
      time: { interval: 5000, injectionMode: "always" },
    } as BaleConfig,
    agentDir,
    configPath,
  });
  const getMode = createBaleTimeInjectionModeGetter(store);
  const setMode = createBaleTimeInjectionModeSetter(store);

  assert.equal(getMode(), "interval");

  await setMode("interval");

  assert.equal(getMode(), "interval");
  assert.deepEqual(await readBaleConfig(configPath), {
    profiles: { default: { botToken: "123:abc" } },
    assistant: { timeInjection: "interval" },
    time: { interval: 5000, injectionMode: "always" },
  });

  await setMode("hidden");

  assert.equal(getMode(), "hidden");
  assert.deepEqual(await readBaleConfig(configPath), {
    profiles: { default: { botToken: "123:abc" } },
    assistant: { timeInjection: "hidden" },
    time: { interval: 5000, injectionMode: "always" },
  });
});

test("Bale config store owns load, mutation, and persistence", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "pi-bale-store-"));
  const configPath = join(agentDir, "bale.json");
  const store = createBaleConfigStore({
    initialConfig: {
      botToken: "initial",
      inboundHandlers: [{ type: "text", template: "translate" }],
      attachmentHandlers: [{ mime: "audio/*", template: "transcribe {file}" }],
    },
    agentDir,
    configPath,
  });
  assert.deepEqual(store.get(), {
    profiles: { default: { botToken: "initial" } },
    botToken: "initial",
    inboundHandlers: [{ type: "text", template: "translate" }],
    attachmentHandlers: [{ mime: "audio/*", template: "transcribe {file}" }],
  });
  store.update((config) => {
    config.allowedUserId = 42;
  });
  assert.equal(store.getBotToken(), "initial");
  assert.equal(store.hasBotToken(), true);
  assert.equal(store.getAllowedUserId(), 42);
  assert.deepEqual(store.getInboundHandlers(), [
    { type: "text", template: "translate" },
    { mime: "audio/*", template: "transcribe {file}" },
  ]);
  assert.deepEqual(store.getAttachmentHandlers(), [
    { mime: "audio/*", template: "transcribe {file}" },
  ]);
  store.setAllowedUserId(43);
  assert.equal(store.getAllowedUserId(), 43);
  await store.persist();
  assert.deepEqual(await readBaleConfig(configPath), {
    inboundHandlers: [{ type: "text", template: "translate" }],
    attachmentHandlers: [{ mime: "audio/*", template: "transcribe {file}" }],
    profiles: {
      default: { botToken: "initial", allowedUserId: 43 },
    },
  });
  store.set({ botToken: "next" });
  assert.deepEqual(store.get(), {
    profiles: { default: { botToken: "next" } },
    botToken: "next",
  });
  await store.load();
  assert.deepEqual(store.get(), {
    inboundHandlers: [{ type: "text", template: "translate" }],
    attachmentHandlers: [{ mime: "audio/*", template: "transcribe {file}" }],
    profiles: {
      default: { botToken: "initial", allowedUserId: 43 },
    },
    botToken: "initial",
    allowedUserId: 43,
  });
});

test("Paired-only admission adopts a peer grant without writing config or losing local settings", async (t) => {
  for (const profileName of ["default", "work"]) {
    const dir = await mkdtemp(join(tmpdir(), "bale-paired-only-"));
    const configPath = join(dir, "bale.json");
    const hash = createHash("sha256").update("fixture-token").digest("hex");
    let pendingSettings: Promise<void> | undefined;
    try {
      await writeFile(configPath, JSON.stringify({ profiles: { [profileName]: { botToken: "fixture-token" } }, assistant: { activity: "verbose" } }));
      const store = createBaleConfigStore({ agentDir: dir, configPath });
      await store.load();
      assert.equal(store.activateProfile(profileName), true);
      const unpaired = await readFile(configPath, "utf8");
      assert.deepEqual(store.withPairedUserAdmission(profileName, hash, 42, () => assert.fail("unpaired publication")), { admitted: false });
      assert.equal(store.getAllowedUserId(), undefined);
      assert.equal(await readFile(configPath, "utf8"), unpaired);
      const peer = createBaleConfigStore({ agentDir: dir, configPath });
      await peer.load();
      peer.activateProfile(profileName);
      assert.equal(await peer.persistAllowedUserId(42), true);
      const granted = await readFile(configPath, "utf8");
      store.update((value) => { value.assistant = { ...value.assistant, activity: "quiet" }; });
      pendingSettings = store.persist();
      const originalRename = fs.renameSync;
      const rename = t.mock.method(fs, "renameSync", (from: fs.PathLike, to: fs.PathLike) => {
        if (to === configPath) assert.fail("paired-only admission wrote config");
        return originalRename(from, to);
      });
      syncBuiltinESMExports();
      try {
        assert.deepEqual(store.withPairedUserAdmission(profileName, hash, 42, () => {
          assert.equal(fs.existsSync(`${configPath}.transaction`), true);
          assert.equal(store.getAllowedUserId(), 42, "Refresh must precede the publication callback");
          assert.equal(store.get().assistant?.activity, "quiet");
          return "published";
        }), { admitted: true, value: "published" });
        assert.deepEqual(store.withPairedUserAdmission(profileName, hash, 43, () => assert.fail("wrong-owner publication")), { admitted: false });
        assert.throws(() => store.withPairedUserAdmission(profileName, hash, 42, () => { throw new Error("append failed"); }), /append failed/);
        assert.equal(store.getAllowedUserId(), 42, "A failed append does not revoke an existing durable grant");
        assert.equal(fs.existsSync(`${configPath}.transaction`), false);
        assert.equal(fs.readFileSync(configPath, "utf8"), granted);
      } finally {
        rename.mock.restore();
        syncBuiltinESMExports();
      }
      store.update((value) => { value.assistant = { ...value.assistant, timeInjection: "always" }; });
      await pendingSettings;
      assert.equal(store.getAllowedUserId(), 42);
      assert.equal(store.get().assistant?.timeInjection, "always");
      await store.persist();
      const persisted = JSON.parse(await readFile(configPath, "utf8"));
      assert.equal(persisted.profiles[profileName].allowedUserId, 42);
      assert.equal(persisted.assistant.activity, "quiet");
      assert.equal(persisted.assistant.timeInjection, "always");
    } finally {
      await pendingSettings?.catch(() => undefined);
      await rm(dir, { recursive: true, force: true });
    }
  }
});

for (const profileName of ["default", "work"]) {
  for (const change of ["local-unpair", "disk-revocation"] as const) {
    test(`Queued config adoption preserves ${change} after paired observation (${profileName})`, async () => {
      const dir = await mkdtemp(join(tmpdir(), "bale-observation-rebase-"));
      const configPath = join(dir, "bale.json");
      const hash = createHash("sha256").update("fixture-token").digest("hex");
      let pendingSettings: Promise<void> | undefined;
      try {
        await writeFile(configPath, JSON.stringify({ profiles: { [profileName]: { botToken: "fixture-token" } } }));
        const store = createBaleConfigStore({ agentDir: dir, configPath });
        await store.load();
        store.activateProfile(profileName);
        const peer = createBaleConfigStore({ agentDir: dir, configPath });
        await peer.load();
        peer.activateProfile(profileName);
        await peer.persistAllowedUserId(42);
        store.update((value) => { value.assistant = { ...value.assistant, activity: "quiet" }; });
        pendingSettings = store.persist();
        assert.deepEqual(store.withPairedUserAdmission(profileName, hash, 42, () => "observed"),
          { admitted: true, value: "observed" });
        if (change === "local-unpair") {
          store.update((value) => { delete value.allowedUserId; });
        } else {
          store.update((value) => { value.assistant = { ...value.assistant, timeInjection: "always" }; });
          const revoked = JSON.parse(fs.readFileSync(configPath, "utf8"));
          delete revoked.profiles[profileName].allowedUserId;
          fs.writeFileSync(configPath, JSON.stringify(revoked));
        }
        await pendingSettings;
        const diskOwner = JSON.parse(await readFile(configPath, "utf8")).profiles[profileName].allowedUserId;
        assert.equal(diskOwner, change === "local-unpair" ? 42 : undefined);
        assert.equal(store.getAllowedUserId(), undefined, "Queued completion must not restore observed authority into the cache");
        assert.equal(store.get().assistant?.activity, "quiet");
        const admit = () => store.withPairedUserAdmission(profileName, hash, 42, () => assert.fail("unpaired publication"));
        if (change === "local-unpair") assert.throws(admit, /local profile authority/);
        else {
          assert.deepEqual(admit(), { admitted: false });
          assert.equal(store.get().assistant?.timeInjection, "always");
        }
        await store.persist();
        assert.equal(JSON.parse(await readFile(configPath, "utf8")).profiles[profileName].allowedUserId, undefined,
          "A later settings save must not recreate a grant");
        assert.equal(store.getAllowedUserId(), undefined);
      } finally {
        await pendingSettings?.catch(() => undefined);
        await rm(dir, { recursive: true, force: true });
      }
    });
  }
}

test("Paired-only admission rejects stale or conflicting authority without cache adoption or publication", async () => {
  for (const scenario of ["entry-fence", "commit-fence", "local-profile", "local-token", "local-owner", "local-unpair", "disk-token", "disk-owner", "malformed-owner", "invalid-user"] as const) {
    const dir = await mkdtemp(join(tmpdir(), "bale-paired-only-denial-"));
    const configPath = join(dir, "bale.json");
    const hash = createHash("sha256").update("fixture-token").digest("hex");
    try {
      await writeFile(configPath, JSON.stringify({ profiles: { default: { botToken: "fixture-token" } } }));
      const store = createBaleConfigStore({ agentDir: dir, configPath });
      await store.load();
      await writeFile(configPath, JSON.stringify({ profiles: { default: {
        botToken: scenario === "disk-token" ? "rebound" : "fixture-token",
        allowedUserId: scenario === "disk-owner" ? 43 : scenario === "malformed-owner" ? "42" : 42,
      } } }));
      if (scenario === "local-profile") { store.setProfile("other", { botToken: "other" }); store.activateProfile("other"); }
      if (scenario === "local-token") store.update((value) => { value.botToken = "unsaved-token"; });
      if (scenario === "local-owner") store.setAllowedUserId(9);
      if (scenario === "local-unpair") { await store.load(); store.update((value) => { delete value.allowedUserId; }); }
      const before = structuredClone(store.getStoredConfig());
      const bytes = await readFile(configPath, "utf8");
      let checks = 0;
      const attempt = () => store.withPairedUserAdmission("default", hash, scenario === "invalid-user" ? 0 : 42,
        () => assert.fail(`rejected source reached publication: ${scenario}`), () => {
          checks++;
          if (scenario === "entry-fence" || (scenario === "commit-fence" && checks === 2)) throw new Error("fixture stale authority");
        });
      if (scenario === "disk-owner" || scenario === "invalid-user") assert.deepEqual(attempt(), { admitted: false }, scenario);
      else assert.throws(attempt, /authority|local profile/, scenario);
      assert.deepEqual(store.getStoredConfig(), before, scenario);
      assert.equal(await readFile(configPath, "utf8"), bytes, scenario);
      assert.equal(fs.existsSync(`${configPath}.transaction`), false, scenario);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

test("Journal source serialization never blocks pairing observation, sender admission or owner-fenced grant", async (t) => {
  for (const mode of ["observation", "paired", "grant"] as const) {
    await t.test(mode, async () => {
      const dir = await mkdtemp(join(tmpdir(), "bale-source-contention-"));
      const configPath = join(dir, "bale.json");
      const startPath = join(dir, "start");
      const blockedPath = join(dir, "blocked");
      const enteredPath = join(dir, "entered");
      const configModule = new URL("../lib/config.ts", import.meta.url).href;
      const locksModule = new URL("../lib/locks.ts", import.meta.url).href;
      const original = JSON.stringify({ profiles: { default: {
        botToken: "fixture-token", ...(mode === "paired" ? { allowedUserId: 42 } : {}),
      } } });
      await writeFile(configPath, original);
      const script = `
        import fs from "node:fs";
        import { syncBuiltinESMExports } from "node:module";
        import { createHash } from "node:crypto";
        import { createBaleConfigStore } from ${JSON.stringify(configModule)};
        import { createBaleLockRuntime } from ${JSON.stringify(locksModule)};
        const dir = ${JSON.stringify(dir)};
        const configPath = ${JSON.stringify(configPath)};
        const mode = ${JSON.stringify(mode)};
        const store = createBaleConfigStore({ agentDir: dir, configPath });
        await store.load();
        const deadline = Date.now() + 8000;
        while (!fs.existsSync(${JSON.stringify(startPath)})) {
          if (Date.now() >= deadline) throw new Error("start barrier timed out");
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2);
        }
        const exists = fs.existsSync;
        fs.existsSync = (path) => {
          const present = exists(path);
          // The real guard refuses publication when this acquisition check returns true.
          if (path === configPath + ".transaction" && present) {
            fs.writeFileSync(${JSON.stringify(blockedPath)}, "contended acquisition");
          }
          return present;
        };
        syncBuiltinESMExports();
        const hash = createHash("sha256").update("fixture-token").digest("hex");
        const entered = () => { fs.writeFileSync(${JSON.stringify(enteredPath)}, "entered"); return "entered"; };
        let result;
        if (mode === "observation") result = store.withPairingAdmission("default", hash, entered);
        else if (mode === "paired") result = store.withPairedUserAdmission("default", hash, 42, entered);
        else {
          const owner = createBaleLockRuntime({ locksPath: dir + "/owners.json", instanceId: "source-grant-child" });
          if (!owner.acquire({ cwd: "/fixture" }).ok) throw new Error("fixture owner unavailable");
          try { result = await store.persistAllowedUserId(42, undefined, owner.commitIfOwned); entered(); }
          finally { owner.release(); }
        }
        process.stdout.write(JSON.stringify(result));
      `;
      const child = execFileAsync(process.execPath,
        ["--experimental-strip-types", "--input-type=module", "--eval", script], { timeout: 15_000 });
      try {
        // Config authority is a separate outer lock: holding journal serialization never delays it.
        createBaleJournalSourceSerialization(() => join(dir, "journals.transaction"))(() => {
          fs.writeFileSync(startPath, "start");
          const deadline = Date.now() + 8000;
          while (!fs.existsSync(enteredPath)) {
            if (Date.now() >= deadline) throw new Error("admission did not complete while journal serialization was held");
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2);
          }
          assert.equal(fs.existsSync(blockedPath), false);
        });
        const result = JSON.parse((await child).stdout);
        assert.deepEqual(result, mode === "paired" ? { admitted: true, value: "entered" } : mode === "grant" ? true : "entered");
        assert.equal(fs.existsSync(enteredPath), true);
        assert.equal(fs.existsSync(`${configPath}.transaction`), false);
        assert.equal(fs.existsSync(join(dir, "owners.json.transaction")), false);
        if (mode === "grant") assert.equal(JSON.parse(await readFile(configPath, "utf8")).profiles.default.allowedUserId, 42);
        else assert.equal(await readFile(configPath, "utf8"), original);
      } finally {
        await child.catch(() => undefined);
        await rm(dir, { recursive: true, force: true });
      }
    });
  }
});

test("Pairing admission observes exact persisted identity under the config transaction", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bale-pair-observation-"));
  const configPath = join(dir, "bale.json");
  const tokenSha256 = createHash("sha256").update("fixture-token").digest("hex");
  try {
    await writeFile(configPath, JSON.stringify({ profiles: { default: { botToken: "fixture-token" } } }));
    const store = createBaleConfigStore({ agentDir: dir, configPath });
    await store.load();
    const classifications: boolean[] = [];
    const observe = () => store.withPairingAdmission("default", tokenSha256, (excluded) => {
      assert.equal(fs.existsSync(`${configPath}.transaction`), true);
      classifications.push(excluded);
      return "synchronous-result";
    });
    const grant = store.persistAllowedUserId(42);
    assert.equal(observe(), "synchronous-result");
    assert.equal(store.getAllowedUserId(), undefined);
    await grant;
    observe();
    assert.deepEqual(classifications, [true, false]);
    assert.equal(fs.existsSync(`${configPath}.transaction`), false);
    const original = await readFile(configPath, "utf8");
    for (const [profile, hash] of [["missing", tokenSha256], ["default", "b".repeat(64)], ["../work", tokenSha256]]) {
      assert.throws(() => store.withPairingAdmission(profile!, hash!, () => assert.fail("invalid identity reached publication")), /pairing admission/);
    }
    assert.throws(() => store.withPairingAdmission("default", tokenSha256, () => { throw new Error("append failed"); }), /append failed/);
    assert.equal(fs.existsSync(`${configPath}.transaction`), false);
    assert.equal(await readFile(configPath, "utf8"), original);
    await writeFile(configPath, JSON.stringify({ profiles: { default: { botToken: "fixture-token" } } }));
    observe();
    assert.deepEqual(classifications, [true, false, true], "Admission must not trust the cached paired owner");
    await writeFile(configPath, JSON.stringify({ profiles: { default: { botToken: "fixture-token", allowedUserId: "unknown" } } }));
    assert.throws(observe, /authority is unavailable or changed/);
    assert.equal(classifications.length, 3);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Pairing owner guard encloses the queued synchronous config commit and rejects a replaced owner", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "bale-pair-owner-commit-"));
  const configPath = join(dir, "bale.json");
  const locksPath = join(dir, "owners.json");
  const originalRename = fs.renameSync;
  let configRenames = 0;
  const rename = t.mock.method(fs, "renameSync", (from: fs.PathLike, to: fs.PathLike) => {
    if (to === configPath) {
      configRenames++;
      assert.equal(fs.existsSync(`${locksPath}.transaction`), true, "Owner transaction must enclose rename");
      assert.equal(fs.existsSync(`${configPath}.transaction`), true, "Config transaction must enclose rename");
    }
    return originalRename(from, to);
  });
  syncBuiltinESMExports();
  try {
    await writeFile(configPath, JSON.stringify({ profiles: { default: { botToken: "fixture-token" } } }));
    const store = createBaleConfigStore({ agentDir: dir, configPath });
    await store.load();
    const first = createBaleLockRuntime({ locksPath, instanceId: "first" });
    const acquired = first.acquire({ cwd: "/fixture" });
    assert.equal(acquired.ok, true);
    let callReturned = false;
    const pending = store.persistAllowedUserId(42, undefined, (commit) => {
      assert.equal(callReturned, true, "Do not acquire owner authority while waiting for the persistence queue");
      return first.commitIfOwned(commit);
    });
    callReturned = true;
    const replacement = createBaleLockRuntime({ locksPath, instanceId: "replacement" });
    assert.equal(replacement.acquire({ cwd: "/fixture" }, {
      force: true, expectedOwner: acquired.ok ? acquired.lock : undefined,
    }).ok, true);
    await assert.rejects(pending, /lost transport ownership/);
    assert.equal(store.getAllowedUserId(), undefined);
    assert.equal(configRenames, 0);
    assert.equal(await store.persistAllowedUserId(42, undefined, replacement.commitIfOwned), true);
    assert.equal(configRenames, 1);
    assert.equal(store.getAllowedUserId(), 42);
    assert.equal(fs.existsSync(`${locksPath}.transaction`), false);
    assert.equal(fs.existsSync(`${configPath}.transaction`), false);
  } finally {
    rename.mock.restore();
    syncBuiltinESMExports();
    await rm(dir, { recursive: true, force: true });
  }
});

test("Pairing publication failure never grants in-memory authority and retry publishes first", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "bale-pair-publication-"));
  const configPath = join(dir, "bale.json");
  const renameSync = fs.renameSync;
  let fail = true;
  const rename = t.mock.method(fs, "renameSync", (from: fs.PathLike, to: fs.PathLike) => {
    if (to === configPath && fail) throw new Error("injected pairing publication failure");
    return renameSync(from, to);
  });
  syncBuiltinESMExports();
  try {
    await writeFile(configPath, JSON.stringify({ profiles: { default: { botToken: "fixture-token" } } }));
    const store = createBaleConfigStore({ agentDir: dir, configPath });
    await store.load();
    const original = await readFile(configPath, "utf8");
    let statuses = 0;
    const runtime = createBaleUserPairingRuntime({ getAllowedUserId: store.getAllowedUserId,
      persistAllowedUserId: store.persistAllowedUserId, updateStatus() { statuses++; } });
    const rejected = runtime.pairIfNeeded(42, {});
    assert.equal(store.getAllowedUserId(), undefined);
    await assert.rejects(rejected, /pairing publication failure/);
    assert.equal(store.getAllowedUserId(), undefined);
    assert.equal(await readFile(configPath, "utf8"), original);
    assert.equal(statuses, 0);
    fail = false;
    assert.equal(await runtime.pairIfNeeded(42, {}), true);
    assert.equal(store.getAllowedUserId(), 42);
    assert.equal(JSON.parse(await readFile(configPath, "utf8")).profiles.default.allowedUserId, 42);
    assert.equal(statuses, 1);
  } finally {
    rename.mock.restore();
    syncBuiltinESMExports();
    await rm(dir, { recursive: true, force: true });
  }
});

test("Pairing compares the disk owner atomically and preserves unrelated local edits and profiles", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bale-pair-owner-"));
  const configPath = join(dir, "bale.json");
  try {
    await writeFile(configPath, JSON.stringify({ profiles: {
      default: { botToken: "fixture-default" }, work: { botToken: "fixture-work" },
    } }));
    const first = createBaleConfigStore({ agentDir: dir, configPath });
    const second = createBaleConfigStore({ agentDir: dir, configPath });
    await first.load();
    await second.load();
    second.update((config) => { config.assistant = { activity: "quiet" }; });
    assert.deepEqual(await Promise.all([first.persistAllowedUserId(42), second.persistAllowedUserId(43)]), [true, false]);
    assert.equal(second.getAllowedUserId(), 42);
    assert.equal(second.get().assistant?.activity, "quiet");
    await second.persist();
    assert.equal(JSON.parse(await readFile(configPath, "utf8")).profiles.default.allowedUserId, 42);
    second.activateProfile("work");
    assert.equal(second.getAllowedUserId(), undefined);
    assert.equal(await second.persistAllowedUserId(43), true);
    const saved = JSON.parse(await readFile(configPath, "utf8"));
    assert.equal(saved.profiles.default.allowedUserId, 42);
    assert.equal(saved.profiles.work.allowedUserId, 43);
    assert.equal(saved.assistant.activity, "quiet");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Pairing rejects stale execution, switched profiles, and changed disk bot identity before publication", async () => {
  for (const scenario of ["stale-entry", "stale-commit", "profile-switch", "token-rebind"] as const) {
    const dir = await mkdtemp(join(tmpdir(), "bale-pair-fence-"));
    const configPath = join(dir, "bale.json");
    try {
      const initial = { profiles: { default: { botToken: "fixture-default" }, work: { botToken: "fixture-work" } } };
      await writeFile(configPath, JSON.stringify(initial));
      const store = createBaleConfigStore({ agentDir: dir, configPath });
      await store.load();
      let guards = 0;
      const pending = store.persistAllowedUserId(42, () => {
        guards++;
        if ((scenario === "stale-entry" && guards === 1) || (scenario === "stale-commit" && guards === 2)) {
          throw new Error("stale execution");
        }
      });
      if (scenario === "profile-switch") store.activateProfile("work");
      if (scenario === "token-rebind") {
        initial.profiles.default.botToken = "fixture-replacement";
        fs.writeFileSync(configPath, JSON.stringify(initial));
      }
      await assert.rejects(pending, /stale execution|profile authority|profile is unavailable or changed/);
      assert.equal(store.getAllowedUserId(), undefined);
      assert.deepEqual(JSON.parse(await readFile(configPath, "utf8")), initial);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

test("Bale config helpers classify authorization state for pair, allow, and deny", () => {
  assert.deepEqual(getBaleAuthorizationState(10), {
    kind: "pair",
    userId: 10,
  });
  assert.deepEqual(getBaleAuthorizationState(10, 10), { kind: "allow" });
  assert.deepEqual(getBaleAuthorizationState(10, 11), { kind: "deny" });
});

test("Bale config helpers pair only when no user is configured", async () => {
  const events: string[] = [];
  let allowedUserId: number | undefined;
  assert.equal(
    await pairBaleUserIfNeeded(10, {
      allowedUserId,
      ctx: "ctx",
      persistAllowedUserId: async (userId) => {
        events.push(`persist:${userId}`);
        allowedUserId = userId;
        return true;
      },
      updateStatus: (ctx) => {
        events.push(`status:${ctx}`);
      },
    }),
    true,
  );
  assert.equal(
    await pairBaleUserIfNeeded(11, {
      allowedUserId,
      ctx: "ctx",
      persistAllowedUserId: async () => {
        events.push("unexpected:persist");
        return false;
      },
      updateStatus: () => {
        events.push("unexpected:status");
      },
    }),
    false,
  );
  assert.equal(allowedUserId, 10);
  assert.deepEqual(events, ["persist:10", "status:ctx"]);
});

test("Bale config pairing rechecks execution authority around persistence", async () => {
  let current = false;
  let persisted = 0;
  await assert.rejects(
    pairBaleUserIfNeeded(10, {
      ctx: "ctx",
      persistAllowedUserId: async () => {
        persisted += 1;
        return true;
      },
      updateStatus: () => {},
      assertExecutionCurrent() {
        if (!current) throw new DOMException("Aborted", "AbortError");
      },
    }),
    /Abort/u,
  );
  assert.equal(persisted, 0);
});

test("Bale config pairing swallows only stale context status errors", async () => {
  await assert.doesNotReject(() =>
    pairBaleUserIfNeeded(10, {
      ctx: "ctx",
      persistAllowedUserId: async () => true,
      updateStatus: () => {
        throw new Error("ctx is stale after session replacement");
      },
    }),
  );
  await assert.rejects(
    () =>
      pairBaleUserIfNeeded(10, {
        ctx: "ctx",
        persistAllowedUserId: async () => true,
        updateStatus: () => {
          throw new Error("status broke");
        },
      }),
    /status broke/,
  );
});

test("Bale config pairing runtime binds config and status ports", async () => {
  const events: string[] = [];
  let allowedUserId: number | undefined;
  const runtime = createBaleUserPairingRuntime({
    getAllowedUserId: () => allowedUserId,
    persistAllowedUserId: async (userId) => {
      events.push(`persist:${userId}`);
      allowedUserId = userId;
      return true;
    },
    updateStatus: (ctx: string) => {
      events.push(`status:${ctx}`);
    },
  });
  assert.equal(await runtime.pairIfNeeded(7, "ctx"), true);
  assert.equal(await runtime.pairIfNeeded(7, "ctx"), true);
  assert.equal(await runtime.pairIfNeeded(8, "ctx"), false);
  assert.deepEqual(events, ["persist:7", "status:ctx"]);
});

test("Bot token input prefers stored config over env vars", () => {
  const value = getBaleBotTokenInputDefault(
    {
      BALE_KEY: "key-last",
      BALE_TOKEN: "token-third",
      BALE_BOT_KEY: "key-second",
      BALE_BOT_TOKEN: "token-first",
    },
    "stored-token",
  );
  assert.equal(value, "stored-token");
});

test("Bot token input prefers the first configured Bale env var when no config exists", () => {
  const value = getBaleBotTokenInputDefault({
    BALE_KEY: "key-last",
    BALE_TOKEN: "token-third",
    BALE_BOT_KEY: "key-second",
    BALE_BOT_TOKEN: "token-first",
  });
  assert.equal(value, "$BALE_BOT_TOKEN");
});

test("Bot token prompt uses the editor when a real prefill exists", () => {
  const prompt = getBaleBotTokenPromptSpec({
    BALE_BOT_TOKEN: "token-first",
  });
  assert.deepEqual(prompt, {
    method: "editor",
    value: "$BALE_BOT_TOKEN",
  });
});

test("Bot token prompt shows stored config before env values", () => {
  const prompt = getBaleBotTokenPromptSpec(
    {
      BALE_BOT_TOKEN: "token-first",
    },
    "stored-token",
  );
  assert.deepEqual(prompt, {
    method: "editor",
    value: "stored-token",
  });
});

test("Bot token input skips blank env vars and falls back to config", () => {
  const value = getBaleBotTokenInputDefault(
    {
      BALE_BOT_TOKEN: "   ",
      BALE_BOT_KEY: "",
      BALE_TOKEN: "  ",
    },
    "stored-token",
  );
  assert.equal(value, "stored-token");
});

test("Bot token input falls back to placeholder when no value exists", () => {
  const value = getBaleBotTokenInputDefault({});
  assert.equal(value, "123456:ABCDEF...");
});

test("Bot token prompt uses placeholder input when no prefill exists", () => {
  const prompt = getBaleBotTokenPromptSpec({});
  assert.deepEqual(prompt, {
    method: "input",
    value: "123456:ABCDEF...",
  });
});

test("Setup runtime prompts, validates token, persists config, and starts polling", async () => {
  const events: string[] = [];
  const nextConfig = await runBaleSetup({
    hasUI: true,
    env: { BALE_BOT_TOKEN: "env-token" },
    config: { allowedUserId: 7 },
    promptInput: async () => {
      events.push("input");
      return undefined;
    },
    promptEditor: async (label, value) => {
      events.push(`editor:${label}:${value}`);
      return "new-token";
    },
    getMe: async (botToken) => {
      events.push(`getMe:${botToken}`);
      return { ok: true, result: { id: 42, username: "demo_bot" } };
    },
    persistConfig: async (config) => {
      events.push(`persist:${config.botToken}:${config.botUsername}`);
    },
    notify: (message, level) => {
      events.push(`notify:${level}:${message}`);
    },
    startPolling: async () => {
      events.push("poll");
    },
    updateStatus: () => {
      events.push("status");
    },
  });
  assert.deepEqual(nextConfig, {
    status: "success",
    config: {
      allowedUserId: 7,
      botToken: "new-token",
      botId: 42,
      botUsername: "demo_bot",
    },
  });
  assert.deepEqual(events, [
    "editor:Bale bot token:$BALE_BOT_TOKEN",
    "getMe:new-token",
    "persist:new-token:demo_bot",
    "notify:info:Bale bot connected: @demo_bot",
    "notify:info:Send /start to your bot in Bale to pair this extension with your account.",
    "poll",
    "status",
  ]);
});

test("Setup runtime reports invalid tokens without persisting", async () => {
  const events: string[] = [];
  const nextConfig = await runBaleSetup({
    hasUI: true,
    env: {},
    config: {},
    promptInput: async () => "bad-token",
    promptEditor: async () => undefined,
    getMe: async () => ({ ok: false, description: "nope" }),
    persistConfig: async () => {
      events.push("persist");
    },
    notify: (message, level) => {
      events.push(`notify:${level}:${message}`);
    },
    startPolling: async () => {
      events.push("poll");
    },
    updateStatus: () => {
      events.push("status");
    },
  });
  assert.deepEqual(nextConfig, { status: "validation-failed" });
  assert.deepEqual(events, ["notify:error:nope"]);
});

test("Setup prompt runtime guards concurrent setup and stores successful config", async () => {
  const events: string[] = [];
  let config: BaleConfig = { allowedUserId: 7 };
  let inProgress = false;
  const promptForConfig = createBaleSetupPromptRuntime({
    env: { BALE_BOT_TOKEN: "env-token" },
    getConfig: () => config,
    setConfig: (nextConfig) => {
      config = nextConfig;
      events.push(`set:${nextConfig.botUsername}`);
    },
    setupGuard: {
      start: () => {
        events.push("start");
        if (inProgress) return false;
        inProgress = true;
        return true;
      },
      finish: () => {
        events.push("finish");
        inProgress = false;
      },
    },
    getMe: async (botToken) => {
      events.push(`getMe:${botToken}`);
      return { ok: true, result: { id: 42, username: "demo_bot" } };
    },
    persistConfig: async (nextConfig) => {
      events.push(`persist:${nextConfig.botToken}`);
    },
    startPolling: async () => {
      events.push("poll");
    },
    updateStatus: () => {
      events.push("status");
    },
  });
  await promptForConfig({
    hasUI: true,
    ui: {
      input: async () => undefined,
      editor: async (_label, value) => {
        events.push(`editor:${value}`);
        return "new-token";
      },
      notify: (message, level) => {
        events.push(`notify:${level}:${message}`);
      },
    },
  });
  inProgress = true;
  await promptForConfig({
    hasUI: true,
    ui: {
      input: async () => {
        events.push("blocked-input");
        return undefined;
      },
      editor: async () => {
        events.push("blocked-editor");
        return undefined;
      },
      notify: () => {
        events.push("blocked-notify");
      },
    },
  });
  assert.deepEqual(config, {
    allowedUserId: 7,
    botToken: "new-token",
    botId: 42,
    botUsername: "demo_bot",
  });
  assert.deepEqual(events, [
    "start",
    "editor:$BALE_BOT_TOKEN",
    "getMe:new-token",
    "set:demo_bot",
    "persist:new-token",
    "notify:info:Bale bot connected: @demo_bot",
    "notify:info:Send /start to your bot in Bale to pair this extension with your account.",
    "poll",
    "status",
    "finish",
    "start",
  ]);
});

test("Stored token references resolve from the configured environment", () => {
  assert.equal(resolveBaleBotToken(undefined), undefined);
  assert.equal(resolveBaleBotToken("  "), undefined);
  assert.equal(resolveBaleBotToken("123:abc", {}), "123:abc");
  assert.equal(
    resolveBaleBotToken("$WORK_BOT_TOKEN", { WORK_BOT_TOKEN: " 456:def " }),
    "456:def",
  );
  assert.equal(
    resolveBaleBotToken("${WORK_BOT_TOKEN}", { WORK_BOT_TOKEN: "456:def" }),
    "456:def",
  );
  assert.equal(resolveBaleBotToken("$MISSING_BOT_TOKEN", {}), undefined);
  assert.equal(resolveBaleBotToken("$not-a-valid-name", {}), undefined);

  const store = createBaleConfigStore({
    initialConfig: legacyConfig({ botToken: "$WORK_BOT_TOKEN" }),
    env: { WORK_BOT_TOKEN: "456:def" },
  });
  assert.equal(store.getBotToken(), "456:def");
  assert.equal(store.hasBotToken(), true);
  assert.equal(store.getBotTokenDiagnostic(), undefined);
  assert.equal(
    store.get().botToken,
    "$WORK_BOT_TOKEN",
    "The effective config retains the reference",
  );
});

test("Unresolved and malformed token references fail closed with a redacted diagnostic", () => {
  const missing = createBaleConfigStore({
    initialConfig: legacyConfig({ botToken: "$MISSING_BOT_TOKEN" }),
    env: {},
  });
  assert.equal(missing.hasBotToken(), false);
  assert.equal(missing.getBotToken(), undefined);
  assert.equal(
    missing.getBotTokenDiagnostic(),
    "Bale bot token environment variable MISSING_BOT_TOKEN is not set.",
  );
  assert.equal(
    getBaleBotTokenDiagnostic("$MISSING_BOT_TOKEN", {}),
    "Bale bot token environment variable MISSING_BOT_TOKEN is not set.",
  );

  const malformed = createBaleConfigStore({
    initialConfig: legacyConfig({ botToken: "$not-a-valid-name" }),
    env: { "not-a-valid-name": "secret-value" },
  });
  assert.equal(malformed.hasBotToken(), false);
  assert.match(malformed.getBotTokenDiagnostic() ?? "", /malformed/);
  assert.doesNotMatch(
    malformed.getBotTokenDiagnostic() ?? "",
    /secret-value/,
  );
});

test("Token references persist and reload per named profile without copying secrets", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "pi-bale-token-ref-"));
  const configPath = join(agentDir, "bale.json");
  const env = {
    DEFAULT_BOT_TOKEN: "123:abc",
    WORK_BOT_TOKEN: "456:def",
  };
  try {
    const store = createBaleConfigStore({
      agentDir,
      configPath,
      env,
      initialConfig: legacyConfig({
        botToken: "$DEFAULT_BOT_TOKEN",
        profiles: { work: { botToken: "${WORK_BOT_TOKEN}" } },
      }),
    });
    await store.persist();
    const raw = await readFile(configPath, "utf8");
    assert.doesNotMatch(raw, /123:abc/);
    assert.doesNotMatch(raw, /456:def/);
    assert.match(raw, /\$DEFAULT_BOT_TOKEN/);
    assert.match(raw, /\$\{WORK_BOT_TOKEN\}/);

    const reloaded = createBaleConfigStore({ agentDir, configPath, env });
    await reloaded.load();
    assert.equal(reloaded.getBotToken(), "123:abc");
    assert.equal(reloaded.activateProfile("work"), true);
    assert.equal(reloaded.getBotToken(), "456:def");
    assert.equal(reloaded.getBotTokenDiagnostic(), undefined);
    assert.deepEqual(await readBaleConfig(configPath), {
      profiles: {
        default: { botToken: "$DEFAULT_BOT_TOKEN" },
        work: { botToken: "${WORK_BOT_TOKEN}" },
      },
    });
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
});

test("Pairing admission hashes the resolved token reference", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "pi-bale-token-ref-pairing-"));
  const configPath = join(agentDir, "bale.json");
  try {
    const store = createBaleConfigStore({
      agentDir,
      configPath,
      env: { PAIR_BOT_TOKEN: "123:pairing" },
      initialConfig: legacyConfig({ botToken: "$PAIR_BOT_TOKEN" }),
    });
    await store.persist();
    const resolvedSha256 = createHash("sha256")
      .update("123:pairing")
      .digest("hex");
    const rawSha256 = createHash("sha256")
      .update("$PAIR_BOT_TOKEN")
      .digest("hex");
    assert.equal(
      store.withPairingAdmission("default", resolvedSha256, (excluded) => excluded),
      true,
    );
    assert.throws(
      () =>
        store.withPairingAdmission("default", rawSha256, (excluded) => excluded),
      /pairing admission authority is unavailable or changed/,
    );
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
});

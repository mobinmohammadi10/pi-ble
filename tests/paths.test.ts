/**
 * Regression tests for Bale bridge path resolution
 * Guards agent-dir detection for Pi-compatible runtimes and path derivation helpers.
 */

import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import test from "node:test";

import {
  requireBaleStoragePathReference,
  getBaleDiagnosticsDisplayPaths,
  getBaleProfilePathSuffix,
  resolveAgentDir,
  resolveBaleConfigPath,
  resolveBaleFollowerJournalPath,
  decodeBaleSessionDirectoryName,
  encodeBaleSessionDirectoryName,
  getBaleRecipientJournalHash,
  resolveLegacyBaleOwnersPath,
  resolveBaleSessionDir,
  resolveBaleSessionJournalPath,
  resolveBaleOwnersPath,
  resolveBaleProfileTempFilePath,
  resolveBaleRuntimeLogPath,
  resolveBaleStatePath,
  resolveBaleServiceJournalStorage,
  getBaleJournalPublicationPaths,
  resolveBaleTempDir,
  resolveBaleChannelPostJournalPath,
  resolveBaleThreadCleanupWorkPath,
  resolveBaleUpdateJournalPath,
  resolveBaleUpdateJournalPathForProfile,
  resolveBaleWorkspaceAdmissionPath,
  resolveBaleWorkspaceAdmissionPathForProfile,
} from "../lib/paths.ts";

test("Consolidated service journal paths isolate raw profile identities and bind guards/staging to the same root", () => {
  const agentDir = resolve("fixture-agent");
  const files = new Set<string>();
  for (const kind of ["channel-posts", "thread-cleanup"] as const) {
    for (const profile of ["default", "work", "WORK", "work/name", "work_name"]) {
      const storage = resolveBaleServiceJournalStorage(kind, agentDir, profile);
      files.add(storage.path);
      assert.equal(dirname(storage.path), join(resolveBaleTempDir(agentDir), "journals"));
      assert.equal(storage.runtimeDir, join(resolveBaleTempDir(agentDir), "runtime"));
      const publication = getBaleJournalPublicationPaths(storage.path, storage.runtimeDir);
      assert.equal(dirname(publication.transactionPath), storage.runtimeDir);
      assert.equal(dirname(publication.temporaryBasePath), storage.runtimeDir);
      assert.throws(() => getBaleJournalPublicationPaths(storage.path, join(agentDir, "foreign", "runtime")), /approved absolute path/u);
    }
  }
  assert.equal(files.size, 10);
  const oldPath = resolveBaleThreadCleanupWorkPath(agentDir, "work");
  assert.deepEqual(getBaleJournalPublicationPaths(oldPath), { transactionPath: `${oldPath}.transaction`, temporaryBasePath: oldPath });
  assert.throws(() => getBaleJournalPublicationPaths(oldPath, join(resolveBaleTempDir(agentDir), "runtime")), /approved absolute path|journals namespace/u);
});

test("Consolidated state has one root path independent of logical profile names", () => {
  const agentDir = resolve("fixture-agent");
  assert.equal(resolveBaleStatePath(agentDir), join(resolveBaleTempDir(agentDir), "state.json"));
  assert.equal(resolveBaleStatePath(), join(resolveBaleTempDir(), "state.json"));
});

test("Storage path reference admission requires exact absolute spelling without repairing aliases", () => {
  const agentDir = resolve("fixture-agent");
  const expected = resolveBaleUpdateJournalPath(agentDir, "work");
  assert.equal(requireBaleStoragePathReference(expected, expected), expected);
  const relative = join("work", "tmp", "pi-bale", "inbox.json");
  const alias = `${agentDir}${sep}unused${sep}..${sep}tmp${sep}pi-bale${sep}inbox.work.json`;
  for (const [actual, approved] of [
    [relative, expected], [relative, relative], [expected, relative],
    [alias, expected], [expected, alias], [alias, alias],
    [resolveBaleUpdateJournalPath(agentDir), expected],
    [resolveBaleUpdateJournalPath(agentDir, "other"), expected],
    [join(agentDir, "tmp", "pi-bale", "workspace-admission.work.json"), expected],
    [expected, ""], [undefined, expected], [expected, null],
  ]) {
    assert.throws(() => requireBaleStoragePathReference(actual as string, approved as string),
      { message: "Bale storage reference does not match its approved absolute path." });
  }
});

await test("resolveAgentDir", async (t) => {
  await t.test("returns PI_CODING_AGENT_DIR when env is set", () => {
    assert.equal(
      resolveAgentDir({
        env: { PI_CODING_AGENT_DIR: "/custom/agent/dir" },
        execPath: "/usr/bin/omp",
        argv: ["omp"],
      }),
      resolve("/custom/agent/dir"),
    );
  });

  await t.test("returns ~/.omp/agent for OMP-compatible runtimes", () => {
    assert.equal(
      resolveAgentDir({ env: {}, execPath: "/home/user/.local/bin/omp" }),
      join(homedir(), ".omp", "agent"),
    );
    assert.equal(
      resolveAgentDir({
        env: {},
        execPath: "/usr/bin/node",
        argv: ["node", "omp"],
      }),
      join(homedir(), ".omp", "agent"),
    );
  });

  await t.test(
    "returns ~/.pi/agent as fallback when no env and no OMP runtime",
    () => {
      assert.equal(
        resolveAgentDir({ env: {}, execPath: "/usr/bin/node", argv: ["node"] }),
        join(homedir(), ".pi", "agent"),
      );
    },
  );
});

await test("resolveBaleConfigPath", () => {
  assert.ok(
    resolveBaleConfigPath().endsWith("bale.json"),
    "config path ends with bale.json",
  );
});

await test("resolveBaleOwnersPath", () => {
  assert.ok(
    resolveBaleOwnersPath().endsWith(join("tmp", "pi-bale", "owners.json")),
    "owners path ends with the platform-native tmp/pi-bale/owners.json suffix",
  );
});

await test("resolveBaleTempDir", () => {
  assert.ok(
    resolveBaleTempDir().endsWith(join("tmp", "pi-bale")),
    "temp dir ends with the platform-native tmp/pi-bale suffix",
  );
});

await test("resolveBaleTempDir canonicalizes a symlinked agent directory for strict journal anchors", { skip: process.platform === "win32" }, () => {
  const real = realpathSync(mkdtempSync(join(tmpdir(), "pi-bale-paths-real-")));
  const link = `${real}-link`;
  try {
    symlinkSync(real, link, "dir");
    assert.equal(resolveBaleTempDir(link), join(real, "tmp", "pi-bale"));
    assert.equal(resolveBaleTempDir(join(link, "missing", "agent")), join(real, "missing", "agent", "tmp", "pi-bale"),
      "Only the existing prefix is resolved; missing components are kept verbatim");
  } finally { rmSync(link, { force: true }); rmSync(real, { recursive: true, force: true }); }
});

await test("resolveBaleRuntimeLogPath", () => {
  assert.ok(
    resolveBaleRuntimeLogPath().endsWith(
      join("tmp", "pi-bale", "logs.jsonl"),
    ),
    "runtime log path ends with the platform-native logs.jsonl suffix",
  );
});

await test("thread cleanup work paths are profile-scoped", () => {
  assert.equal(resolveBaleThreadCleanupWorkPath("/agent", "default"),
    join("/agent", "tmp", "pi-bale", "thread-cleanup.json"));
  assert.equal(resolveBaleThreadCleanupWorkPath("/agent", "work"),
    join("/agent", "tmp", "pi-bale", "thread-cleanup.work.json"));
});

test("channel post journal paths are profile-scoped", () => {
  assert.equal(resolveBaleChannelPostJournalPath("/agent", "default"),
    join("/agent", "tmp", "pi-bale", "channel-posts.json"));
  assert.equal(resolveBaleChannelPostJournalPath("/agent", "work"),
    join("/agent", "tmp", "pi-bale", "channel-posts.work.json"));
});

test("update journal paths are profile-scoped", () => {
  assert.equal(
    resolveBaleUpdateJournalPath("/agent", "default"),
    join("/agent", "tmp", "pi-bale", "inbox.json"),
  );
  assert.equal(
    resolveBaleUpdateJournalPath("/agent", "work"),
    join("/agent", "tmp", "pi-bale", "inbox.work.json"),
  );
});

test("profile-only storage callbacks bind the configured agent directory", () => {
  const agentDir = resolveAgentDir();
  assert.equal(
    resolveBaleUpdateJournalPathForProfile("work"),
    resolveBaleUpdateJournalPath(agentDir, "work"),
  );
  assert.equal(
    resolveBaleWorkspaceAdmissionPathForProfile("work"),
    resolveBaleWorkspaceAdmissionPath(agentDir, "work"),
  );
  assert.notEqual(
    resolveBaleUpdateJournalPathForProfile("work"),
    resolveBaleUpdateJournalPath("work"),
  );
  assert.notEqual(
    resolveBaleWorkspaceAdmissionPathForProfile("work"),
    resolveBaleWorkspaceAdmissionPath("work"),
  );
});

await test("follower journal paths are stable binding and profile scoped", () => {
  const first = resolveBaleFollowerJournalPath(
    "manual-follower:owner-a",
    "/agent",
    "work",
  );
  assert.equal(
    first,
    resolveBaleFollowerJournalPath(
      "manual-follower:owner-a",
      "/agent",
      "work",
    ),
  );
  assert.notEqual(
    first,
    resolveBaleFollowerJournalPath(
      "manual-follower:owner-b",
      "/agent",
      "work",
    ),
  );
  assert.match(
    first,
    /follower-inbox-[a-f0-9]{16}\.work\.json$/u,
  );
});

await test("explicit default profile keeps canonical unsuffixed paths", () => {
  assert.equal(getBaleProfilePathSuffix("default"), "");
  assert.equal(
    resolveBaleProfileTempFilePath("state", "json", "/agent", "default"),
    resolveBaleProfileTempFilePath("state", "json", "/agent"),
  );
  assert.deepEqual(
    getBaleDiagnosticsDisplayPaths("default"),
    getBaleDiagnosticsDisplayPaths(),
  );
});

await test("Diagnostic display paths are shared across default and named profiles", () => {
  const agentDir = join(homedir(), ".pi", "agent");
  const expected = {
    state: "~/.pi/agent/tmp/pi-bale/state.json",
    logs: "~/.pi/agent/tmp/pi-bale/logs.jsonl",
  };
  for (const profile of [undefined, "default", "work"]) {
    assert.deepEqual(getBaleDiagnosticsDisplayPaths(profile, agentDir), expected);
  }
});

await test("Diagnostic display paths follow a non-default agent dir", () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "pi-bale-display-paths-")));
  try {
    const display = getBaleDiagnosticsDisplayPaths("work", dir);
    for (const path of [display.state, display.logs]) {
      assert.ok(path.startsWith("~/") || path.startsWith(join(dir, "tmp", "pi-bale")), path);
      assert.ok(!path.startsWith("~/.pi/agent/"), "never another profile's default files");
    }
    // Windows may resolve the temp directory outside the resolved home directory, so a display path is
    // compared separator-neutral: only the exact agent directory and file names are asserted.
    const normalizedDisplay = (value: string): string => value.split("\\").join("/");
    assert.ok(normalizedDisplay(display.state).endsWith("tmp/pi-bale/state.json"), display.state);
    assert.ok(normalizedDisplay(display.logs).endsWith("tmp/pi-bale/logs.jsonl"), display.logs);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

await test("The pre-0.52.0 directory is read-only legacy and never the runtime directory", () => {
  const agentDir = resolve("fixture-agent");
  assert.equal(resolveBaleTempDir(agentDir), join(agentDir, "tmp", "pi-bale"));
  assert.equal(resolveLegacyBaleOwnersPath(agentDir), join(agentDir, "tmp", "bale", "owners.json"));
  assert.notEqual(dirname(resolveLegacyBaleOwnersPath(agentDir)), resolveBaleTempDir(agentDir));
});

await test("Session directory names keep real ids verbatim and encode everything unsafe reversibly", () => {
  const uuid = "01a0da2f-942f-71a0-af1a-a63ec1c8ec18";
  assert.equal(encodeBaleSessionDirectoryName(uuid), uuid);
  const cases: Array<[string, string]> = [
    ["a/b", "a%2Fb"], ["..", "%2E%2E"], [".hidden", "%2Ehidden"], ["trail.", "trail%2E"], ["in.ner", "in.ner"],
    ["ABC", "%41%42%43"], ["a b", "a%20b"], ["100%", "100%25"], ["é", "%C3%A9"], ["con", "%63on"], ["lpt1.txt", "%6Cpt1.txt"], ["a\\b:c*", "a%5Cb%3Ac%2A"],
  ];
  for (const [id, name] of cases) {
    assert.equal(encodeBaleSessionDirectoryName(id), name, id);
    assert.equal(decodeBaleSessionDirectoryName(name), id, `round trip ${id}`);
    assert.doesNotMatch(name, /[\\/:*?"<>|\s]|^\.|\.$/u);
  }
  assert.equal(encodeBaleSessionDirectoryName(""), undefined);
  assert.equal(encodeBaleSessionDirectoryName("\uD800"), undefined, "Invalid UTF-16 must not alias a replacement character session");
  assert.equal(encodeBaleSessionDirectoryName("a".repeat(201)), undefined);
  assert.notEqual(encodeBaleSessionDirectoryName("a".repeat(200)), undefined);
  for (const forged of ["ABC", "a%2fb", "a%2", "a%ZZ", "%61", "..", ".x", "a/b", "a b"]) {
    assert.equal(decodeBaleSessionDirectoryName(forged), undefined, `non-canonical ${forged}`);
  }
  assert.notEqual(encodeBaleSessionDirectoryName("Abc"), encodeBaleSessionDirectoryName("abc"), "case-insensitive filesystems cannot merge sessions");
});

await test("Session journals sit in their session folder named by the recipient hash without revealing a role", () => {
  const agentDir = resolve("fixture-agent");
  const id = "01a0da2f-942f-71a0-af1a-a63ec1c8ec18";
  assert.equal(resolveBaleSessionDir(id, agentDir), join(agentDir, "tmp", "pi-bale", "sessions", id));
  const hash = getBaleRecipientJournalHash("manual:old");
  assert.match(hash, /^[0-9a-f]{16}$/u);
  assert.equal(hash, resolveBaleFollowerJournalPath("manual:old", agentDir).match(/follower-inbox-([0-9a-f]{16})\.json$/u)?.[1],
    "the recipient identity and its hash are unchanged");
  assert.equal(resolveBaleSessionJournalPath(id, "manual:old", agentDir), join(agentDir, "tmp", "pi-bale", "sessions", id, `journal.${hash}.json`));
  assert.equal(resolveBaleSessionJournalPath(id, "manual:old", agentDir, "work"), join(agentDir, "tmp", "pi-bale", "sessions", id, `journal.${hash}.work.json`));
  assert.notEqual(resolveBaleSessionJournalPath(id, "manual:other", agentDir), resolveBaleSessionJournalPath(id, "manual:old", agentDir));
  assert.throws(() => resolveBaleSessionDir("", agentDir), /usable session id/u);
  assert.throws(() => resolveBaleSessionJournalPath(id, "", agentDir), /binding key/u);
});

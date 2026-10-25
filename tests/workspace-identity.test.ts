/**
 * Durable Workspace identity value regressions
 * Zones: workspace identity, session identity, key encoding
 * Covers the value owner and compatibility reexports; store/Restore tests stay in Threads.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import * as Identity from "../lib/workspace-identity.ts";
import * as Threads from "../lib/threads.ts";
import {
  createBaleWorkspaceBindingIdentity,
  createBaleWorkspaceDirectoryKey,
  normalizeBaleWorkspacePath,
} from "../lib/workspace-identity.ts";

test("Workspace identities use readable cwd keys and deterministic concurrent suffixes", () => {
  const cwd = "/home/llb/.pi/agent/extensions/";
  const normalized = normalizeBaleWorkspacePath(cwd);
  assert.equal(normalized, "/home/llb/.pi/agent/extensions");
  assert.equal(
    createBaleWorkspaceDirectoryKey(cwd),
    "--home-llb-.pi-agent-extensions--",
  );
  assert.deepEqual(createBaleWorkspaceBindingIdentity(cwd), {
    cwd: "/home/llb/.pi/agent/extensions",
    workspaceKey: "--home-llb-.pi-agent-extensions--",
    instanceSlot: "a",
    bindingKey: "--home-llb-.pi-agent-extensions--",
  });
  assert.equal(
    createBaleWorkspaceBindingIdentity(cwd, 1)?.bindingKey,
    "--home-llb-.pi-agent-extensions--b",
  );
  assert.equal(
    createBaleWorkspaceBindingIdentity(cwd, 26)?.instanceSlot,
    "aa",
  );
  assert.equal(createBaleWorkspaceBindingIdentity("", 0), undefined);
  assert.equal(createBaleWorkspaceBindingIdentity(cwd, -1), undefined);
  const sessionA = createBaleWorkspaceBindingIdentity(cwd, 0, "session-a");
  const sessionARepeat = createBaleWorkspaceBindingIdentity(
    cwd,
    0,
    " session-a ",
  );
  const sessionB = createBaleWorkspaceBindingIdentity(cwd, 0, "session-b");
  assert.ok(sessionA);
  assert.deepEqual(sessionARepeat, sessionA);
  assert.equal(sessionA.sessionId, "session-a");
  assert.match(sessionA.sessionKey!, /^[a-f0-9]{64}$/u);
  assert.equal(sessionA.bindingKey,
    `${sessionA.workspaceKey}-s-${sessionA.sessionKey}`);
  assert.notEqual(sessionB?.bindingKey, sessionA.bindingKey);
  assert.equal(createBaleWorkspaceBindingIdentity(cwd, 0, ""), undefined);
  assert.equal(
    createBaleWorkspaceBindingIdentity(cwd, 0, "x".repeat(257)),
    undefined,
  );
});

test("Workspace directory keys stay bounded and collision-verifiable by exact cwd", () => {
  const cwd = `/workspace/${"segment/".repeat(80)}project`;
  const first = createBaleWorkspaceBindingIdentity(cwd);
  const second = createBaleWorkspaceBindingIdentity(cwd);
  assert.ok(first);
  assert.deepEqual(first, second);
  assert.ok(first.workspaceKey.length <= 180);
  assert.equal(first.cwd, normalizeBaleWorkspacePath(cwd));
  assert.match(first.workspaceKey, /-[a-f0-9]{12}--$/u);
});

test("Threads retains the exact identity functions and type contract as compatibility reexports", () => {
  assert.equal(Threads.normalizeBaleSessionId, Identity.normalizeBaleSessionId);
  assert.equal(Threads.normalizeBaleWorkspacePath, Identity.normalizeBaleWorkspacePath);
  assert.equal(Threads.createBaleWorkspaceDirectoryKey, Identity.createBaleWorkspaceDirectoryKey);
  assert.equal(Threads.createBaleWorkspaceBindingIdentity, Identity.createBaleWorkspaceBindingIdentity);
  const facade: Threads.BaleWorkspaceBindingIdentity = Identity.createBaleWorkspaceBindingIdentity("/repo", 0, "session")!;
  const identity: Identity.BaleWorkspaceBindingIdentity = facade;
  assert.equal(identity, facade);
});

test("Workspace session normalization keeps exact UTF-8 capacity and hash framing", () => {
  const session = "я".repeat(128);
  assert.equal(Buffer.byteLength(session, "utf8"), 256);
  assert.equal(Identity.normalizeBaleSessionId(" " + session + " "), session);
  assert.equal(Identity.normalizeBaleSessionId(session + "x"), undefined);
  assert.equal(Identity.normalizeBaleSessionId(" \t\n "), undefined);
  assert.equal(Identity.createBaleSessionKey(" session-a "), createHash("sha256").update("session-a").digest("hex"));
  assert.equal(Identity.createBaleSessionKey(""), undefined);
});

test("Workspace instance ordinals keep their legacy letter encoding and reject unsafe values", () => {
  for (const [ordinal, slot] of [[0, "a"], [25, "z"], [26, "aa"], [51, "az"], [701, "zz"], [702, "aaa"]] as const) {
    assert.equal(Identity.createBaleWorkspaceBindingIdentity("/repo", ordinal)?.instanceSlot, slot);
  }
  for (const ordinal of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(Identity.createBaleWorkspaceBindingIdentity("/repo", ordinal), undefined);
  }
});

test("Workspace precomputed-key construction preserves stored key spelling without reinterpretation", () => {
  const key = "--retained-exact-key--";
  assert.deepEqual(Identity.createBaleWorkspaceBindingIdentityWithKey("/repo", key, 1), {
    cwd: "/repo", workspaceKey: key, instanceSlot: "b", bindingKey: key + "b",
  });
  const session = Identity.createBaleWorkspaceBindingIdentityWithKey("/repo", key, 0, " session ")!;
  assert.equal(session.cwd, "/repo");
  assert.equal(session.workspaceKey, key);
  assert.equal(session.bindingKey, key + "-s-" + createHash("sha256").update("session").digest("hex"));
  assert.equal(Identity.createBaleWorkspaceBindingIdentityWithKey("/repo", key, 0, ""), undefined);
});


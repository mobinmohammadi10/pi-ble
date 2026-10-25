/**
 * Inactive Bale Thread cleanup admission regressions
 * Zones: bale threads, workspace lifecycle
 */

import { mkdtemp, mkdir, readdir, rm, symlink, readFile } from "node:fs/promises";
import { readdirSync } from "node:fs";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import nodeTest from "node:test";

import {
  captureBaleInactiveThreadCleanupEvidence,
  cleanReviewedInactiveThreads,
  commitBaleInactiveThreadCleanup,
  createBaleInactiveThreadCleanupReviewRuntime,
  createBaleInactiveThreadCleanupRuntime,
  createBaleInactiveThreadCleanupSettingsPort,
  createBaleThreadCleanupPermitRuntime,
  createBaleThreadCleanupWorkStore,
  executeBaleInactiveThreadCleanup,
  planBaleInactiveThreadCleanup,
} from "../lib/thread-cleanup-manager.ts";
import { createBaleWorkspaceAdmissionLedger, createBaleWorkspaceAdmissionProfileKey } from "../lib/workspace-admission.ts";
import { createBaleTopicTargetStore, createBaleWorkspaceBindingIdentity } from "../lib/threads.ts";
import { resolveBaleServiceJournalStorage, resolveBaleTempDir } from "../lib/paths.ts";

const binding = {
  cwd: "/repo/a", workspaceKey: "workspace:a", instanceSlot: "a", slot: "A", bindingKey: "binding:a",
  target: { chatId: -1001, threadId: 7 }, inactiveSinceMs: 10, updatedAtMs: 20,
};
const sessionId = "session-a";
const sessionKey = createHash("sha256").update(sessionId).digest("hex");
const sessionBinding = {
  ...binding,
  sessionId,
  sessionKey,
  bindingKey: `binding:a-s-${sessionKey}`,
};
const execFileAsync = promisify(execFile);
const test = nodeTest;
const cleanupOwner = { processId: 1, processBirthId: "1:test" };
const clear = {
  bindingKey: "binding:a", target: { chatId: -1001, threadId: 7 },
  liveOwner: "clear" as const, acceptedWork: "clear" as const,
  deliveryAuthority: "clear" as const,
};

test("Consolidated cleanup storage retains issued one-shot work and puts guards/staging only under runtime", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-cleanup-layout-"));
  try {
    const storage = resolveBaleServiceJournalStorage("thread-cleanup", dir, "work");
    let now = 100, staged = false;
    const options = { ...storage, profileName: "work", tokenSha256: "a".repeat(64), getNowMs: () => now,
      onPublicationBoundary(boundary: "after-write-before-rename" | "after-rename") {
        if (boundary === "after-write-before-rename") {
          staged = true;
          assert.equal(readdirSync(storage.runtimeDir).filter(name => name.endsWith(".tmp")).length, 1);
          assert.equal(readdirSync(join(resolveBaleTempDir(dir), "journals")).some(name => name.endsWith(".tmp") || name.includes("transaction")), false);
        }
      } };
    const store = createBaleThreadCleanupWorkStore(options);
    const candidate = planBaleInactiveThreadCleanup({ profileName: "work", bindings: [binding], protection: [clear] })[0]!;
    store.prepare("cleanup-1", [candidate]);
    now = 110;
    const permit = { destructiveKind: "manual-thread-cleanup" as const, operationId: "permit-op", retirementIntentId: "cleanup-1",
      profileKey: "work", bindingKey: "binding:a", slot: "A", target: { chatId: -1001, threadId: 7 }, leaderEpoch: 3, issuedAtMs: 105 };
    store.recordDeletionIssued({ operationId: "cleanup-1", bindingKey: "binding:a", bindingUpdatedAtMs: 20, permit });
    const reopened = createBaleThreadCleanupWorkStore({ ...storage, profileName: "work", tokenSha256: "a".repeat(64) });
    assert.equal(reopened.list()[0]?.entries[0]?.state, "outcome-unknown");
    assert.equal(reopened.recordDeletionIssued({ operationId: "cleanup-1", bindingKey: "binding:a", bindingUpdatedAtMs: 20, permit }).recorded, false);
    assert.equal(staged, true);
    assert.equal((await readdir(storage.runtimeDir)).some(name => name.endsWith(".tmp")), false);
    assert.deepEqual((await readdir(resolveBaleTempDir(dir))).sort(), ["journals", "runtime"]);
    assert.equal((await readdir(join(resolveBaleTempDir(dir), "journals"))).length, 1);
    assert.throws(() => createBaleThreadCleanupWorkStore({ ...storage, profileName: "work", tokenSha256: "a".repeat(64),
      runtimeDir: join(dir, "foreign-runtime") }), /approved absolute path/u);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

for (const boundary of ["after-write-before-rename", "after-rename"] as const) {
  test(`Consolidated cleanup staging fault preserves canonical issued facts at ${boundary}`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-cleanup-layout-fault-"));
    try {
      const storage = resolveBaleServiceJournalStorage("thread-cleanup", dir, "work");
      let inject = false;
      const store = createBaleThreadCleanupWorkStore({ ...storage, profileName: "work", tokenSha256: "a".repeat(64), getNowMs: () => 110,
        onPublicationBoundary(at) { if (inject && at === boundary) throw new Error("lost fixture reply"); } });
      const candidate = planBaleInactiveThreadCleanup({ profileName: "work", bindings: [binding], protection: [clear] })[0]!;
      store.prepare("cleanup-1", [candidate]);
      const before = await readFile(storage.path, "utf8");
      inject = true;
      const permit = { destructiveKind: "manual-thread-cleanup" as const, operationId: "permit-op", retirementIntentId: "cleanup-1",
        profileKey: "work", bindingKey: "binding:a", slot: "A", target: { chatId: -1001, threadId: 7 }, leaderEpoch: 3, issuedAtMs: 105 };
      assert.throws(() => store.recordDeletionIssued({ operationId: "cleanup-1", bindingKey: "binding:a", bindingUpdatedAtMs: 20, permit }), /lost fixture reply/u);
      const reopened = createBaleThreadCleanupWorkStore({ ...storage, profileName: "work", tokenSha256: "a".repeat(64) });
      if (boundary === "after-write-before-rename") assert.equal(await readFile(storage.path, "utf8"), before);
      else {
        assert.equal(reopened.list()[0]?.entries[0]?.state, "outcome-unknown");
        assert.equal(reopened.recordDeletionIssued({ operationId: "cleanup-1", bindingKey: "binding:a", bindingUpdatedAtMs: 20, permit }).recorded, false);
      }
      assert.equal((await readdir(storage.runtimeDir)).some(name => name.endsWith(".tmp")), false);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
}

test("Cleanup planner admits only exact fully-clear inactive bindings", () => {
  assert.deepEqual(planBaleInactiveThreadCleanup({
    profileName: "work", bindings: [binding], protection: [clear],
  }), [{ profileName: "work", bindingKey: "binding:a", cwd: "/repo/a",
    workspaceKey: "workspace:a", instanceSlot: "a", slot: "A", target: { chatId: -1001, threadId: 7 },
    inactiveSinceMs: 10, bindingUpdatedAtMs: 20 }]);
  assert.deepEqual(planBaleInactiveThreadCleanup({
    profileName: "work", bindings: [{ ...binding, inactiveSinceMs: undefined }], protection: [clear],
  }), []);
  assert.equal(planBaleInactiveThreadCleanup({
    profileName: "work", bindings: [{ ...binding, slot: undefined }], protection: [clear],
  })[0]?.slot, null, "a missing letter is explicit metadata, not missing cleanup identity");
  assert.deepEqual(planBaleInactiveThreadCleanup({
    profileName: "work", bindings: [binding],
    protection: [{ ...clear, liveOwner: "unknown" }],
  }), []);
});

test("Slotless cleanup preserves inactivity and every independent protection boundary", () => {
  const slotless = { ...binding, slot: undefined };
  for (const field of ["liveOwner", "acceptedWork", "deliveryAuthority"] as const) {
    for (const state of ["protected", "unknown"] as const) {
      assert.deepEqual(planBaleInactiveThreadCleanup({
        profileName: "work", bindings: [slotless], protection: [{ ...clear, [field]: state }],
      }), []);
    }
  }
  assert.deepEqual(planBaleInactiveThreadCleanup({
    profileName: "work", bindings: [{ ...slotless, inactiveSinceMs: undefined }], protection: [clear],
  }), []);
  for (const key of ["reservedTargets", "provisioningTargets", "cleanupTargets"] as const) {
    assert.deepEqual(planBaleInactiveThreadCleanup({
      profileName: "work", bindings: [slotless], protection: [clear], [key]: [slotless.target],
    }), []);
  }
  for (const slot of ["", "aa", "a", "?", null]) {
    assert.deepEqual(planBaleInactiveThreadCleanup({
      profileName: "work", bindings: [{ ...binding, slot } as never], protection: [clear],
    }), [], `malformed stored slot ${slot} is not absence`);
  }
});

for (const outcome of ["confirmed", "unknown"] as const) {
  test(`Slotless cleanup retains exact target and one-shot evidence across cold recovery (${outcome})`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-cleanup-slotless-"));
    try {
      const options = { path: join(dir, "state.json"), getNowMs: () => 100 };
      const threads = createBaleTopicTargetStore(options);
      const retained = { ...createBaleWorkspaceBindingIdentity("/retained")!,
        target: { chatId: 7, threadId: 42 }, threadName: "Anchor", inactiveSinceMs: 10, updatedAtMs: 20 };
      const replacement = { ...createBaleWorkspaceBindingIdentity("/replacement")!,
        target: { chatId: 7, threadId: 43 }, threadName: "Briar", slot: "A", updatedAtMs: 20 };
      threads.upsertWorkspaceBinding(retained);
      threads.upsertWorkspaceBinding(replacement);
      await threads.persist();
      const candidate = planBaleInactiveThreadCleanup({
        profileName: "work", bindings: [retained], protection: [{ ...clear, bindingKey: retained.bindingKey, target: retained.target }],
      })[0]!;
      assert.equal(candidate.slot, null);
      const workOptions = { path: join(dir, "work.json"), profileName: "work", tokenSha256: "a".repeat(64), getNowMs: () => 100 };
      const work = createBaleThreadCleanupWorkStore(workOptions);
      const operationId = `thread-cleanup:${"d".repeat(32)}`;
      work.prepare(operationId, [candidate]);
      assert.throws(() => work.prepare("missing-slot", [{ ...candidate, slot: undefined } as never]), /schema/,
        "reviewed absence must be explicit, not an omitted field");
      assert.throws(() => work.recordDeletionIssued({ operationId, bindingKey: candidate.bindingKey,
        bindingUpdatedAtMs: candidate.bindingUpdatedAtMs,
        permit: { destructiveKind: "manual-thread-cleanup", operationId: "wrong-letter", retirementIntentId: operationId,
          profileKey: "work", bindingKey: candidate.bindingKey, slot: "A", target: candidate.target, leaderEpoch: 1, issuedAtMs: 100 } }),
        /stale or mismatched/, "the recycled letter cannot substitute for the slotless review");
      const ledgerOptions = { path: join(dir, "ledger.json"), profileKey: "work", owner: cleanupOwner, getNowMs: () => 100 };
      const ledger = createBaleWorkspaceAdmissionLedger(ledgerOptions);
      const permitRuntime = createBaleThreadCleanupPermitRuntime({ ledger,
        getLeaderEpoch: () => 1, getProfileName: () => "work", getOwner: () => cleanupOwner, canAdoptFence: () => false,
        getNowMs: () => 100, async revalidateUnderFence() { return true; } });
      let deletes = 0;
      const deps = { store: work, operationId, permitRuntime,
        async resolveFullBinding() { return threads.getWorkspaceBinding("/retained"); },
        async deleteWithPermit(permit: { slot: string | null; target: { chatId: number; threadId: number } }) {
          assert.equal(permit.slot, null);
          assert.deepEqual(permit.target, retained.target);
          deletes++;
          if (outcome === "unknown") throw new Error("lost deletion acknowledgement");
        },
        commitBinding: () => threads.commitInactiveWorkspaceCleanup(candidate, () => true),
      };
      const first = await cleanReviewedInactiveThreads(deps);
      assert.equal(deletes, 1);
      const coldWork = createBaleThreadCleanupWorkStore(workOptions);
      const coldLedger = createBaleWorkspaceAdmissionLedger(ledgerOptions);
      assert.equal(coldWork.list()[0]?.entries[0]?.slot, null);
      if (outcome === "confirmed") {
        assert.equal(first.deleted, 1);
        assert.equal(ledger.read().fence, undefined);
        const cold = createBaleTopicTargetStore(options);
        await cold.load();
        assert.equal(cold.getWorkspaceBinding("/retained"), undefined);
        assert.deepEqual(cold.getWorkspaceBinding("/replacement"), replacement);
      } else {
        assert.equal(first.outcomeUnknown, 1);
        assert.equal(coldLedger.read().fence?.phase, "deletion-issued");
        assert.deepEqual(coldLedger.listReservedSlots(), [], "no fabricated letter reservation");
        const result = await cleanReviewedInactiveThreads({ ...deps, store: coldWork });
        assert.equal(result.outcomeUnknown, 1);
        assert.ok(threads.getWorkspaceBinding("/retained"));
      }
      await cleanReviewedInactiveThreads({ ...deps, store: coldWork });
      assert.equal(deletes, 1, "cold work cannot authorize a second deletion");
      assert.equal(threads.getWorkspaceBinding("/replacement")?.slot, "A");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
}

async function withManualCleanupRuntime(run: (fixture: {
  runtime: ReturnType<typeof createBaleInactiveThreadCleanupRuntime>;
  threads: ReturnType<typeof createBaleTopicTargetStore>;
  ledger: ReturnType<typeof createBaleWorkspaceAdmissionLedger>;
  state: { epoch: number; protection: "clear" | "protected"; duringFence: boolean; unknownDelete: boolean; lateEpoch: boolean; lateCommit: boolean; noLeader: boolean; loadDrift: boolean; failCommit: boolean; deletes: number; loads: number };
  rebuild(): ReturnType<typeof createBaleInactiveThreadCleanupRuntime>;
}) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "pi-manual-cleanup-runtime-"));
  try {
    const state = { epoch: 1, protection: "clear" as "clear" | "protected", duringFence: false,
      unknownDelete: false, lateEpoch: false, lateCommit: false, noLeader: false, loadDrift: false, failCommit: false, deletes: 0, loads: 0 };
    const threads = createBaleTopicTargetStore({ path: join(dir, "state.json"), getNowMs: () => 100 });
    threads.upsertWorkspaceBinding({ ...createBaleWorkspaceBindingIdentity("/retained")!,
      target: { chatId: 7, threadId: 42 }, threadName: "Anchor", inactiveSinceMs: 10, updatedAtMs: 20 });
    threads.upsertWorkspaceBinding({ ...createBaleWorkspaceBindingIdentity("/replacement")!,
      target: { chatId: 7, threadId: 43 }, slot: "A", threadName: "Briar", updatedAtMs: 20 });
    threads.upsert({ profileKey: "cwd:/unrelated", owner: { kind: "leader", cwd: "/unrelated", instanceId: "unrelated" },
      instanceId: "unrelated", target: { chatId: 7, threadId: 44 }, status: "active", createdAtMs: 20, updatedAtMs: 20 });
    await threads.persist();
    const ledgerOptions = { path: join(dir, "ledger.json"), stateProfile: "work",
      profileKey: createBaleWorkspaceAdmissionProfileKey({ profileName: "work", botToken: "fixture" }),
      owner: cleanupOwner, getNowMs: () => 100 };
    const ledger = createBaleWorkspaceAdmissionLedger(ledgerOptions);
    const rebuild = () => createBaleInactiveThreadCleanupRuntime({
      store: { ...threads, async load() { state.loads++; await threads.load(); if (state.loadDrift) state.epoch++; },
        async commitInactiveWorkspaceCleanup(candidate, current) {
          if (state.failCommit) throw new Error("commit interrupted");
          const committed = await threads.commitInactiveWorkspaceCleanup(candidate, current);
          if (state.lateCommit) state.epoch++;
          return committed;
        } },
      captureAuthority() {
        if (state.noLeader) return undefined;
        const epoch = state.epoch;
        return { profileName: "work", leaderEpoch: epoch, ledger,
          isCurrent: () => state.epoch === epoch };
      },
      getWorkStore(authority) { return createBaleThreadCleanupWorkStore({ path: join(dir, "work.json"),
        profileName: "work", tokenSha256: createHash("sha256").update("fixture").digest("hex"),
        admissionProfileKey: authority.ledger.getProfileKey(), getNowMs: () => 100 }); },
      getProtection() { return { liveOwner: "clear", acceptedWork: state.duringFence && ledger.read().fence ? "protected" : state.protection, deliveryAuthority: "clear" }; },
      getProcessLiveness: () => "alive",
      async runExclusive(operation) { return operation(); },
      async runWorkspaceOperation(input, operation) {
        assert.deepEqual(input.scopes, [{ kind: "profile" }]);
        const acquired = ledger.acquireAdmission({ ...input, scope: { kind: "profile" } });
        if (acquired.kind !== "acquired") throw new Error("review admission blocked");
        try { return await operation(); } finally { ledger.releaseAdmission(acquired.lease); }
      },
      async deleteThread(authorize) {
        assert.deepEqual(authorize(), { chatId: 7, threadId: 42 });
        assert.equal(ledger.read().fence?.phase, "deletion-issued");
        assert.deepEqual(ledger.read().leases, [], "ordinary review admission ends before the manual fence");
        state.deletes++;
        if (state.lateEpoch) state.epoch++;
        if (state.unknownDelete) throw new Error("delete acknowledgement lost");
      },
    });
    await run({ runtime: rebuild(), threads, ledger, state, rebuild });
  } finally { await rm(dir, { recursive: true, force: true }); }
}

test("Manual Settings cleanup reviews without deleting and confirms only the exact slotless target", async () => {
  await withManualCleanupRuntime(async ({ runtime, threads, state, ledger }) => {
    const review = await runtime.review();
    assert.equal(review.count, 1);
    assert.equal(state.deletes, 0);
    assert.deepEqual(ledger.read().leases, []);
    const result = await runtime.clean(review.operationId!);
    assert.equal(result.deleted, 1);
    assert.equal(state.deletes, 1);
    assert.equal(threads.getWorkspaceBinding("/retained"), undefined);
    assert.equal(threads.getWorkspaceBinding("/replacement")?.slot, "A");
    assert.equal(threads.list().length, 1, "unrelated slotless live owner is untouched");
    await runtime.clean(review.operationId!);
    assert.equal(state.deletes, 1);
    assert.ok(state.loads >= 3, "review, candidate and fenced revalidation reload the canonical store");
  });
});

test("Manual cleanup refuses absent leadership and authority loss during fresh loading", async () => {
  for (const fault of ["noLeader", "loadDrift"] as const) {
    await withManualCleanupRuntime(async ({ runtime, state, ledger }) => {
      const review = await runtime.review();
      state[fault] = true;
      await assert.rejects(runtime.clean(review.operationId!), /authority/);
      assert.equal(state.deletes, 0);
      assert.equal(ledger.read().fence, undefined);
    });
  }
});

for (const fault of ["protected", "under-fence", "changed-binding", "unknown-delete", "late-epoch", "late-commit", "commit-interrupted"] as const) {
  test(`Manual Settings cleanup preserves proof and refuses unsafe replay (${fault})`, async () => {
    await withManualCleanupRuntime(async ({ runtime, threads, ledger, state, rebuild }) => {
      const review = await runtime.review();
      if (fault === "protected") state.protection = "protected";
      if (fault === "under-fence") state.duringFence = true;
      if (fault === "changed-binding") {
        threads.upsertWorkspaceBinding({ ...threads.getWorkspaceBinding("/retained")!, slot: "B" });
        await threads.persist();
      }
      if (fault === "unknown-delete") state.unknownDelete = true;
      if (fault === "late-epoch") state.lateEpoch = true;
      if (fault === "late-commit") state.lateCommit = true;
      if (fault === "commit-interrupted") state.failCommit = true;
      const first = await runtime.clean(review.operationId!);
      if (["protected", "under-fence", "changed-binding"].includes(fault)) {
        assert.equal(first.blocked, 1);
        assert.equal(state.deletes, 0);
        assert.equal(ledger.read().fence, undefined);
      } else {
        assert.equal(first.outcomeUnknown, 1);
        assert.equal(state.deletes, 1);
        assert.equal(!!threads.getWorkspaceBinding("/retained"), fault !== "late-commit");
        state.failCommit = false;
        const retried = await rebuild().clean(review.operationId!);
        assert.equal(state.deletes, 1);
        assert.equal(retried.deleted, fault === "commit-interrupted" ? 1 : 0);
      }
      assert.equal(threads.getWorkspaceBinding("/replacement")?.slot, "A");
    });
  });
}

test("Cleanup planner preserves exact session identity and rejects partial or mismatched identity", () => {
  const protection = [{ ...clear, bindingKey: sessionBinding.bindingKey }];
  const planned = planBaleInactiveThreadCleanup({
    profileName: "work", bindings: [sessionBinding], protection,
  });
  assert.equal(planned[0]?.sessionId, sessionId);
  assert.equal(planned[0]?.sessionKey, sessionKey);
  assert.deepEqual(planBaleInactiveThreadCleanup({
    profileName: "work", bindings: [{ ...sessionBinding, sessionKey: "f".repeat(64) }],
    protection,
  }), []);
  assert.deepEqual(planBaleInactiveThreadCleanup({
    profileName: "work", bindings: [{ ...sessionBinding, sessionKey: undefined }],
    protection,
  }), []);
});

test("Cleanup evidence adapter preserves full records for protection and carries competing work", () => {
  let observedJournalKeys: readonly string[] | undefined;
  const evidence = captureBaleInactiveThreadCleanupEvidence({
    profileName: "work",
    listBindings: () => [{ ...binding, journalBindingKeys: ["journal:a"] }],
    getProtection: (source) => {
      observedJournalKeys = source.journalBindingKeys;
      throw new Error("registry unavailable");
    },
    listReservations: () => [{ target: { chatId: -1001, threadId: 8 } }],
    listPendingProvisions: () => [{}, { target: { chatId: -1001, threadId: 9 } }],
    listPendingCleanups: () => [{ target: { chatId: -1001, threadId: 10 } }],
  });
  assert.deepEqual(observedJournalKeys, ["journal:a"]);
  assert.deepEqual(evidence.protection, [{ bindingKey: "binding:a", target: binding.target,
    liveOwner: "unknown", acceptedWork: "unknown", deliveryAuthority: "unknown" }]);
  assert.deepEqual(evidence.reservedTargets, [{ chatId: -1001, threadId: 8 }]);
  assert.deepEqual(evidence.provisioningTargets, [{ chatId: -1001, threadId: 9 }]);
  assert.deepEqual(evidence.cleanupTargets, [{ chatId: -1001, threadId: 10 }]);
  assert.deepEqual(planBaleInactiveThreadCleanup(evidence), []);
});

test("Cleanup review durably prepares one canonical work-set under admission", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-bale-thread-cleanup-review-"));
  try {
    const store = createBaleThreadCleanupWorkStore({ path: join(dir, "cleanup.json"),
      profileName: "work", tokenSha256: "a".repeat(64) });
    let admissions = 0;
    const runtime = createBaleInactiveThreadCleanupReviewRuntime({
      getProfileName: () => "work", listBindings: () => [sessionBinding],
      getProtection: () => ({ ...clear, bindingKey: sessionBinding.bindingKey }),
      listReservations: () => [], listPendingProvisions: () => [], listPendingCleanups: () => [],
      getWorkStore: () => store,
      async runWorkspaceOperation(_input, operation) { admissions += 1; return operation(); },
    });
    const first = await runtime.review();
    const second = await runtime.review();
    assert.deepEqual(second, first);
    assert.equal(first.count, 1);
    assert.equal(admissions, 2);
    assert.equal(store.list().length, 1);
    assert.equal(store.list()[0]?.entries[0]?.sessionId, sessionId);
    assert.equal(store.list()[0]?.entries[0]?.sessionKey, sessionKey);
    assert.match(first.operationId!, /^thread-cleanup:[a-f0-9]{32}$/u);
    assert.equal(store.list()[0]!.operationId, first.operationId);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("Cleanup permit runtime revalidates after fence and retains commit-ready state", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-bale-thread-cleanup-permit-"));
  try {
    let now = 100;
    const ledger = createBaleWorkspaceAdmissionLedger({ path: join(dir, "admission.json"),
      profileKey: "work", owner: { processId: 1, processBirthId: "1:test" }, getNowMs: () => now });
    const candidate = planBaleInactiveThreadCleanup({
      profileName: "work", bindings: [binding], protection: [clear],
    })[0]!;
    let revalidations = 0;
    const runtime = createBaleThreadCleanupPermitRuntime({ ledger,
      getLeaderEpoch: () => 3, getProfileName: () => "work", getOwner: () => cleanupOwner, canAdoptFence: () => false, getNowMs: () => now,
      async revalidateUnderFence() { revalidations += 1; return true; } });
    const workStore = createBaleThreadCleanupWorkStore({ path: join(dir, "work.json"),
      profileName: "work", tokenSha256: "a".repeat(64), getNowMs: () => now });
    workStore.prepare("thread-cleanup:test", [candidate]);
    const acquired = await runtime.acquire(candidate, "thread-cleanup:test");
    assert.equal(acquired.kind, "issued");
    if (acquired.kind !== "issued") throw new Error("Expected cleanup permit");
    assert.equal(acquired.permit.destructiveKind, "manual-thread-cleanup");
    workStore.recordDeletionIssued({ operationId: "thread-cleanup:test",
      bindingKey: candidate.bindingKey, bindingUpdatedAtMs: candidate.bindingUpdatedAtMs,
      permit: acquired.permit });
    assert.equal((await runtime.acquire(candidate, "thread-cleanup:test")).kind, "already-issued");
    assert.equal(revalidations, 1);
    now = 110;
    assert.equal(await runtime.settleDeleted(acquired.fence, async () => false), "commit-pending");
    const ready = ledger.read().fence!;
    assert.equal(ready.phase, "commit-ready");
    let bindingCommits = 0;
    assert.equal(await runtime.settleDeleted(ready, () => commitBaleInactiveThreadCleanup({
      store: workStore, operationId: "thread-cleanup:test", bindingKey: candidate.bindingKey,
      async commitBinding() { bindingCommits += 1; return true; },
    })), "completed");
    assert.equal(bindingCommits, 1);
    assert.equal(workStore.list()[0]?.entries[0]?.state, "deleted");
    assert.equal(ledger.read().fence, undefined);
    const drifted = createBaleThreadCleanupPermitRuntime({ ledger,
      getLeaderEpoch: () => 3, getProfileName: () => "work", getOwner: () => cleanupOwner, canAdoptFence: () => false, getNowMs: () => now,
      async revalidateUnderFence() { return false; } });
    assert.equal((await drifted.acquire(candidate, "thread-cleanup:drift")).kind, "blocked");
    assert.equal(ledger.read().fence, undefined);
    const wrongProfile = createBaleThreadCleanupPermitRuntime({ ledger,
      getLeaderEpoch: () => 3, getProfileName: () => "other", getOwner: () => cleanupOwner,
      canAdoptFence: () => false, getNowMs: () => now,
      async revalidateUnderFence() { throw new Error("must not revalidate cross-profile work"); } });
    assert.equal((await wrongProfile.acquire(candidate, "thread-cleanup:profile")).kind, "blocked");
    assert.equal(ledger.read().fence, undefined);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("Hidden cleanup coordinator calls fake deletion once and never replays ambiguity", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-bale-thread-cleanup-hidden-"));
  try {
    const operationId = `thread-cleanup:${"b".repeat(32)}`;
    const store = createBaleThreadCleanupWorkStore({ path: join(dir, "work.json"),
      profileName: "work", tokenSha256: "a".repeat(64), getNowMs: () => 100 });
    const candidate = planBaleInactiveThreadCleanup({
      profileName: "work", bindings: [binding], protection: [clear],
    })[0]!;
    store.prepare(operationId, [candidate]);
    const ledger = createBaleWorkspaceAdmissionLedger({ path: join(dir, "ledger.json"),
      profileKey: "work", owner: { processId: 1, processBirthId: "1:test" }, getNowMs: () => 100 });
    const permitRuntime = createBaleThreadCleanupPermitRuntime({ ledger,
      getLeaderEpoch: () => 4, getProfileName: () => "work", getOwner: () => cleanupOwner, canAdoptFence: () => false, getNowMs: () => 100,
      async revalidateUnderFence() { return true; } });
    let deletes = 0;
    const run = () => cleanReviewedInactiveThreads({ store, operationId, permitRuntime,
      async resolveFullBinding() { return binding; },
      async deleteWithPermit() { deletes += 1; throw new Error("lost delete ack"); },
      async commitBinding() { throw new Error("must not commit ambiguous deletion"); },
    });
    assert.deepEqual(await run(), { deleted: 0, outcomeUnknown: 1, blocked: 0,
      recovery: "deletion-outcome-unknown" });
    assert.deepEqual(await run(), { deleted: 0, outcomeUnknown: 1, blocked: 0,
      recovery: "deletion-outcome-unknown" });
    assert.equal(deletes, 1);
    assert.equal(store.list()[0]?.entries[0]?.state, "outcome-unknown");
    assert.equal(ledger.read().fence?.phase, "deletion-issued");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("Hidden cleanup coordinator completes fake deletion, binding commit, and work-set", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-bale-thread-cleanup-complete-"));
  try {
    const operationId = `thread-cleanup:${"c".repeat(32)}`;
    let failWorkSetPublish = false;
    let cleanupPublicationCount = 0;
    const store = createBaleThreadCleanupWorkStore({ path: join(dir, "work.json"),
      profileName: "work", tokenSha256: "a".repeat(64), getNowMs: () => 100,
      onPublicationBoundary(boundary) {
        if (failWorkSetPublish && boundary === "after-write-before-rename" &&
            ++cleanupPublicationCount === 2) {
          failWorkSetPublish = false;
          throw new Error("simulated work-set publication crash");
        }
      } });
    const candidate = planBaleInactiveThreadCleanup({
      profileName: "work", bindings: [binding], protection: [clear],
    })[0]!;
    store.prepare(operationId, [candidate]);
    const ledger = createBaleWorkspaceAdmissionLedger({ path: join(dir, "ledger.json"),
      profileKey: "work", owner: { processId: 1, processBirthId: "1:test" }, getNowMs: () => 100 });
    const permitRuntime = createBaleThreadCleanupPermitRuntime({ ledger,
      getLeaderEpoch: () => 5, getProfileName: () => "work", getOwner: () => cleanupOwner, canAdoptFence: () => false, getNowMs: () => 100,
      async revalidateUnderFence() { return true; } });
    let deletes = 0;
    let commits = 0;
    const cleanInactiveThreads = createBaleInactiveThreadCleanupSettingsPort({
      store, permitRuntime, async resolveFullBinding() { return binding; },
      async deleteWithPermit() { deletes += 1; },
      async commitBinding() { commits += 1; return true; },
    });
    failWorkSetPublish = true;
    assert.deepEqual(await cleanInactiveThreads(operationId),
      { deleted: 0, outcomeUnknown: 1, blocked: 0, recovery: "commit-ready" });
    assert.equal(ledger.read().fence?.phase, "commit-ready");
    const liveSuccessorOwner = { processId: 2, processBirthId: "2:live" };
    const liveSuccessorLedger = createBaleWorkspaceAdmissionLedger({ path: join(dir, "ledger.json"),
      profileKey: "work", owner: liveSuccessorOwner, getNowMs: () => 105,
      getProcessLiveness: () => "alive" });
    const liveSuccessorRuntime = createBaleThreadCleanupPermitRuntime({ ledger: liveSuccessorLedger,
      getLeaderEpoch: () => 6, getProfileName: () => "work", getOwner: () => liveSuccessorOwner, canAdoptFence: () => false, getNowMs: () => 105,
      async revalidateUnderFence() { return true; } });
    const liveBlockedPort = createBaleInactiveThreadCleanupSettingsPort({
      store, permitRuntime: liveSuccessorRuntime, async resolveFullBinding() { return binding; },
      async deleteWithPermit() { deletes += 1; }, async commitBinding() { commits += 1; return true; },
    });
    assert.deepEqual(await liveBlockedPort(operationId),
      { deleted: 0, outcomeUnknown: 1, blocked: 0, recovery: "authority-blocked" });
    assert.equal(commits, 1);
    const successorOwner = { processId: 2, processBirthId: "2:test" };
    const successorLedger = createBaleWorkspaceAdmissionLedger({ path: join(dir, "ledger.json"),
      profileKey: "work", owner: successorOwner, getNowMs: () => 110,
      getProcessLiveness: owner => owner.processId === 1 ? "dead" : "alive" });
    const successorRuntime = createBaleThreadCleanupPermitRuntime({ ledger: successorLedger,
      getLeaderEpoch: () => 6, getProfileName: () => "work", getOwner: () => successorOwner, canAdoptFence: () => true, getNowMs: () => 110,
      async revalidateUnderFence() { return true; } });
    const successorPort = createBaleInactiveThreadCleanupSettingsPort({
      store, permitRuntime: successorRuntime,
      async resolveFullBinding() { throw new Error("binding is already absent"); },
      async deleteWithPermit() { deletes += 1; },
      async commitBinding() { commits += 1; return true; },
    });
    assert.deepEqual(await successorPort(operationId),
      { deleted: 1, outcomeUnknown: 0, blocked: 0 });
    assert.equal(deletes, 1);
    assert.equal(commits, 2);
    assert.equal(store.list()[0]?.entries[0]?.state, "deleted");
    assert.equal(ledger.read().fence, undefined);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("Lost work-set commit acknowledgement completes retained fence without re-delete", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-bale-thread-cleanup-lost-commit-"));
  try {
    const operationId = `thread-cleanup:${"e".repeat(32)}`;
    let failAfterRename = false;
    let cleanupPublicationCount = 0;
    const store = createBaleThreadCleanupWorkStore({ path: join(dir, "work.json"),
      profileName: "work", tokenSha256: "a".repeat(64), getNowMs: () => 100,
      onPublicationBoundary(boundary) {
        if (failAfterRename && boundary === "after-rename" &&
            ++cleanupPublicationCount === 2) {
          failAfterRename = false;
          throw new Error("lost work-set commit acknowledgement");
        }
      } });
    const candidate = planBaleInactiveThreadCleanup({
      profileName: "work", bindings: [binding], protection: [clear],
    })[0]!;
    store.prepare(operationId, [candidate]);
    const ledger = createBaleWorkspaceAdmissionLedger({ path: join(dir, "ledger.json"),
      profileKey: "work", owner: cleanupOwner, getNowMs: () => 100 });
    const permitRuntime = createBaleThreadCleanupPermitRuntime({ ledger,
      getLeaderEpoch: () => 7, getProfileName: () => "work", getOwner: () => cleanupOwner,
      canAdoptFence: () => false, getNowMs: () => 100,
      async revalidateUnderFence() { return true; } });
    let deletes = 0;
    const port = createBaleInactiveThreadCleanupSettingsPort({ store, permitRuntime,
      async resolveFullBinding() { return binding; }, async deleteWithPermit() { deletes += 1; },
      async commitBinding() { return true; } });
    failAfterRename = true;
    assert.deepEqual(await port(operationId),
      { deleted: 0, outcomeUnknown: 1, blocked: 0, recovery: "commit-ready" });
    assert.equal(store.list()[0]?.entries[0]?.state, "deleted");
    assert.equal(ledger.read().fence?.phase, "commit-ready");
    assert.deepEqual(await port(operationId), { deleted: 1, outcomeUnknown: 0, blocked: 0 });
    assert.equal(deletes, 1);
    assert.equal(ledger.read().fence, undefined);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("Cross-process cleanup contenders issue one fake transport deletion", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-bale-thread-cleanup-race-"));
  try {
    const operationId = `thread-cleanup:${"d".repeat(32)}`;
    const workPath = join(dir, "work.json");
    const ledgerPath = join(dir, "ledger.json");
    const markerPath = join(dir, "deleted");
    const attemptDir = join(dir, "attempts");
    await mkdir(attemptDir);
    const candidate = planBaleInactiveThreadCleanup({
      profileName: "work", bindings: [binding], protection: [clear],
    })[0]!;
    createBaleThreadCleanupWorkStore({ path: workPath, profileName: "work",
      tokenSha256: "a".repeat(64) }).prepare(operationId, [candidate]);
    const worker = join(import.meta.dirname, "fixtures", "thread-cleanup-worker.ts");
    const args = ["--experimental-strip-types", worker, workPath, ledgerPath, markerPath,
      attemptDir, operationId, JSON.stringify(candidate)];
    const results = await Promise.all([
      execFileAsync(process.execPath, args), execFileAsync(process.execPath, args),
    ]);
    assert.equal(results.length, 2);
    assert.equal((await readdir(attemptDir)).length, 1);
    const restored = createBaleThreadCleanupWorkStore({ path: workPath,
      profileName: "work", tokenSha256: "a".repeat(64) });
    assert.equal(restored.list()[0]?.entries[0]?.state, "deleted");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("Cleanup work-set records one exact deletion permit across restart", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-bale-thread-cleanup-"));
  const path = join(dir, "cleanup.json");
  let now = 100;
  try {
    const candidate = planBaleInactiveThreadCleanup({
      profileName: "work", bindings: [binding], protection: [clear],
    })[0]!;
    const store = createBaleThreadCleanupWorkStore({ path, profileName: "work",
      tokenSha256: "a".repeat(64), getNowMs: () => now });
    assert.equal(store.prepare("cleanup-1", [candidate]).prepared, true);
    assert.equal(store.prepare("cleanup-1", [candidate]).prepared, false);
    now = 110;
    const permit = { destructiveKind: "manual-thread-cleanup" as const,
      operationId: "permit-op", retirementIntentId: "cleanup-1",
      profileKey: "work", bindingKey: "binding:a", slot: "A",
      target: { chatId: -1001, threadId: 7 }, leaderEpoch: 3, issuedAtMs: 105 };
    assert.equal(store.recordDeletionIssued({ operationId: "cleanup-1", bindingKey: "binding:a",
      bindingUpdatedAtMs: 20, permit }).recorded, true);
    const restarted = createBaleThreadCleanupWorkStore({ path, profileName: "work",
      tokenSha256: "a".repeat(64), getNowMs: () => now });
    assert.equal(restarted.recordDeletionIssued({ operationId: "cleanup-1", bindingKey: "binding:a",
      bindingUpdatedAtMs: 20, permit }).recorded, false);
    assert.throws(() => restarted.recordDeletionIssued({ operationId: "cleanup-1",
      bindingKey: "binding:a", bindingUpdatedAtMs: 20,
      permit: { ...permit, operationId: "foreign-permit" } }), /conflicts/u);
    now = 120;
    assert.equal(restarted.confirmDeleted({ operationId: "cleanup-1", bindingKey: "binding:a" }).confirmed, true);
    assert.equal(restarted.confirmDeleted({ operationId: "cleanup-1", bindingKey: "binding:a" }).confirmed, false);
    // Creating symbolic links needs elevated rights on Windows.
    if (process.platform !== "win32") {
      await rm(path);
      await symlink("/etc/passwd", path);
      assert.throws(() => restarted.list(), /bounded private regular file/u);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("Cleanup execution revalidates and consumes one permit inside admission", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-bale-thread-cleanup-execute-"));
  const path = join(dir, "cleanup.json");
  try {
    const candidate = planBaleInactiveThreadCleanup({
      profileName: "work", bindings: [binding], protection: [clear],
    })[0]!;
    const store = createBaleThreadCleanupWorkStore({ path, profileName: "work",
      tokenSha256: "a".repeat(64) });
    store.prepare("execute", [candidate]);
    const events: string[] = [];
    const result = await executeBaleInactiveThreadCleanup({
      store, operationId: "execute", bindingKey: "binding:a",
      async withWorkspaceDeletionBoundary(operation) {
        events.push("boundary:start");
        try { return await operation(); } finally { events.push("boundary:end"); }
      },
      async loadFreshEvidence() {
        events.push("evidence");
        return { profileName: "work", bindings: [binding], protection: [clear] };
      },
      async acquireDeletionPermit() {
        events.push("permit");
        return { kind: "issued", permit: { destructiveKind: "manual-thread-cleanup" as const,
          operationId: "permit", retirementIntentId: "execute",
          profileKey: "work", bindingKey: "binding:a", slot: "A", target: binding.target,
          leaderEpoch: 1, issuedAtMs: Date.now() } };
      },
      async deleteWithPermit() { events.push("delete"); },
    });
    assert.equal(result.status, "deleted");
    assert.deepEqual(events, ["boundary:start", "evidence", "permit", "delete", "boundary:end"]);
    const replay = await executeBaleInactiveThreadCleanup({
      store, operationId: "execute", bindingKey: "binding:a",
      async withWorkspaceDeletionBoundary(operation) { return operation(); },
      async loadFreshEvidence() { throw new Error("must not revalidate deleted work"); },
      async acquireDeletionPermit() { throw new Error("must not reacquire permit"); },
      async deleteWithPermit() { throw new Error("must not replay delete"); },
    });
    assert.equal(replay.status, "deleted");

    store.prepare("ambiguous", [candidate]);
    let deletes = 0;
    const ambiguousInput = {
      store, operationId: "ambiguous", bindingKey: "binding:a",
      async withWorkspaceDeletionBoundary<T>(operation: () => Promise<T>) { return operation(); },
      async loadFreshEvidence() {
        return { profileName: "work", bindings: [binding], protection: [clear] };
      },
      async acquireDeletionPermit() {
        return { kind: "issued" as const, permit: { destructiveKind: "manual-thread-cleanup" as const,
          operationId: "permit-2", retirementIntentId: "ambiguous", profileKey: "work", bindingKey: "binding:a",
          slot: "A", target: binding.target, leaderEpoch: 1, issuedAtMs: Date.now() } };
      },
      async deleteWithPermit() { deletes += 1; throw new Error("lost delete response"); },
    };
    await assert.rejects(executeBaleInactiveThreadCleanup(ambiguousInput));
    assert.equal((await executeBaleInactiveThreadCleanup(ambiguousInput)).status, "outcome-unknown");
    assert.equal(deletes, 1);

    store.prepare("drift", [candidate]);
    let permitCalls = 0;
    const drift = await executeBaleInactiveThreadCleanup({
      store, operationId: "drift", bindingKey: "binding:a",
      async withWorkspaceDeletionBoundary(operation) { return operation(); },
      async loadFreshEvidence() {
        return { profileName: "work", bindings: [{ ...binding, updatedAtMs: 21 }], protection: [clear] };
      },
      async acquireDeletionPermit() { permitCalls += 1; return { kind: "blocked" as const }; },
      async deleteWithPermit() { throw new Error("must not delete drifted binding"); },
    });
    assert.equal(drift.status, "blocked");
    assert.equal(permitCalls, 0);

    store.prepare("already-issued", [candidate]);
    const issued = await executeBaleInactiveThreadCleanup({
      store, operationId: "already-issued", bindingKey: "binding:a",
      async withWorkspaceDeletionBoundary(operation) { return operation(); },
      async loadFreshEvidence() {
        return { profileName: "work", bindings: [binding], protection: [clear] };
      },
      async acquireDeletionPermit() { return { kind: "already-issued" as const }; },
      async deleteWithPermit() { throw new Error("must not replay an issued permit"); },
    });
    assert.equal(issued.status, "blocked");
    assert.equal(store.list().find(workSet => workSet.operationId === "already-issued")
      ?.entries[0]?.state, "prepared");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("Cleanup planner refuses competing work and identity ambiguity", () => {
  for (const field of ["reservedTargets", "provisioningTargets", "cleanupTargets"] as const) {
    assert.deepEqual(planBaleInactiveThreadCleanup({
      profileName: "work", bindings: [binding], protection: [clear], [field]: [binding.target],
    }), []);
  }
  assert.deepEqual(planBaleInactiveThreadCleanup({
    profileName: "work", bindings: [binding, { ...binding, bindingKey: "binding:b" }],
    protection: [clear],
  }), []);
  assert.deepEqual(planBaleInactiveThreadCleanup({
    profileName: "work", bindings: [binding], protection: [clear, clear],
  }), []);
});

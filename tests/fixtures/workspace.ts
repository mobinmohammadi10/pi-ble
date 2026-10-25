/**
 * Native Workspace fixtures shared by binding, Restore transition, routing and IPC tests.
 * Zones: bale
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBaleTopicTargetStore, createBaleWorkspaceBindingIdentity,
  type BaleWorkspaceRestore, type BaleWorkspaceRestoreOptions, type BaleWorkspaceRestoreAuthority,
  type BaleWorkspaceRestoreRequest, type BaleTopicTargetStore } from "../../lib/threads.ts";

export async function withWorkspaceRelocationFixture(
  role: "leader" | "follower",
  run: (store: ReturnType<typeof createBaleTopicTargetStore>, path: string) => Promise<void>,
  options: Omit<Parameters<typeof createBaleTopicTargetStore>[0], "path"> = {},
) {
  const root = await mkdtemp(join(tmpdir(), "bale-workspace-relocation-"));
  const path = join(root, "state.json");
  const store = createBaleTopicTargetStore({ path, getNowMs: () => 1000, ...options });
  try {
    const target = { chatId: 7, threadId: 10 };
    const owner = role === "leader"
      ? { kind: "leader" as const, cwd: "/repo", instanceId: "old" }
      : { kind: "manual-follower" as const, instanceId: "owner" };
    store.upsert({ profileKey: role === "leader" ? "cwd:/repo" : "manual:owner",
      owner, instanceId: "old", target, status: "active", slot: "A", threadName: "Atlas",
      syncStatus: "open", lastSyncObservedAtMs: 1, lastSyncProbeAtMs: 1,
      lastSyncError: "old target error", createdAtMs: 1, updatedAtMs: 1 });
    store.upsertWorkspaceBinding({ ...createBaleWorkspaceBindingIdentity("/repo", 0, "session")!,
      target, slot: "A", threadName: "Atlas", manualThreadName: "My workspace", displayTitle: "Old title",
      journalBindingKeys: ["manual:old"], journalBindingsComplete: true, updatedAtMs: 1 });
    await store.persist();
    await store.load();
    await run(store, path);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

export { fixture as withWorkspaceRestoreFixture, recipient as restoreFixtureRecipient };


const authority = (): BaleWorkspaceRestoreAuthority => ({ executor: { instanceId: "leader", leaderEpoch: "epoch" },
  operatorUserId: 7, isCurrent: () => true });
const recipient = (kind: "leader" | "follower") => ({ kind, instanceId: "old", sessionId: "session", generation: "registration" });

type FixtureRestoreOptions = Partial<BaleWorkspaceRestoreOptions> & { threadStore?: BaleTopicTargetStore };
async function fixture(run: (f: {
  store: BaleWorkspaceRestore;
  open: (overrides?: FixtureRestoreOptions) => BaleWorkspaceRestore;
  threads: Parameters<Parameters<typeof withWorkspaceRelocationFixture>[1]>[0];
  request: BaleWorkspaceRestoreRequest; path: string; auth: BaleWorkspaceRestoreAuthority;
}) => Promise<void>, role: "leader" | "follower" = "leader",
  overrides: FixtureRestoreOptions = {},
  threadOptions: Parameters<typeof withWorkspaceRelocationFixture>[2] = {}) {
  await withWorkspaceRelocationFixture(role, async (threads, path) => {
    const open = (extra: typeof overrides = {}) => {
      const { threadStore = threads, ...scope } = { ...overrides, ...extra };
      return threadStore.workspaceRestore({ profileName: "default", tokenSha256: "a".repeat(64), getNowMs: () => 1000, ...scope });
    };
    const request: BaleWorkspaceRestoreRequest = { operationId: "restore", binding: threads.listWorkspaceBindings()[0]!,
      owner: threads.list()[0]!, target: { chatId: 7, threadId: 42 },
      source: { journalBindingKey: "source-journal", updateIds: [100, 101] } };
    await run({ store: open(), open, threads, request, path, auth: authority() });
  }, threadOptions);
}

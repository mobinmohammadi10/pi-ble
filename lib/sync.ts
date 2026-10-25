/**
 * Bale synchronization helpers
 * Zones: Bale bot reality mirror, demand-driven reconciliation, status diagnostics
 * Owns pure contracts for deciding when local Bale mirror state should be refreshed without querying Bale on every action
 */

import { getBaleTargetKey, type BaleTarget } from "./target.ts";
import {
  getBaleApiErrorRequestTarget,
  isBaleStaleTargetHttpError,
} from "./bale-api.ts";
import * as ThreadReconciler from "./thread-reconciler.ts";
import {
  commitBaleWorkspaceProvisionBinding,
  createBaleCleanupTargetProtection,
  getBaleTargetFromApiBody,
  getBaleThreadOwnerKey,
  isSameBaleProcessInstance,
  isBaleTopicTargetStaleError,
  provisionOwnBusTopic,
  resetBaleConnectionProvisioning,
  type BaleOwnTopicProvisionResult,
  type BaleTopicTargetStore,
  type BaleWorkspaceDisplayBinding,
  type BaleWorkspaceThreadBinding,
} from "./threads.ts";
import {
  createBaleWorkspaceAdmissionOperationId,
  runWithBaleWorkspaceAdmissionsAsync,
  type BaleWorkspaceAdmissionLedger,
} from "./workspace-admission.ts";
import { normalizeBaleWorkspacePath } from "./workspace-identity.ts";
import { BaleWorkspaceSlotUnavailableError } from "./workspace-slots.ts";

export interface BaleTopicLifecycleSyncUpdate<TMessage = unknown> {
  kind: "created" | "closed" | "reopened";
  target: BaleTarget & { threadId: number };
  message: TMessage;
}

export type BaleSyncWorkspaceOperationRunner = <T>(
  input: {
    operationId: string;
    operationKind: string;
    scopes: readonly [{ kind: "profile" }];
  },
  operation: () => Promise<T>,
) => Promise<T>;

export interface BaleLeaderThreadSyncDeps {
  getAllowedUserId: () => number | undefined;
  instanceId: string;
  cwd?: string;
  sessionId?: string;
  baleProfile?: string;
  forceFreshUnnamed?: boolean;
  requestedThreadName?: string;
  resolveInitialWorkspaceDisplayTitle?: (
    binding: BaleWorkspaceDisplayBinding,
  ) => string | undefined;
  getNowMs?: () => number;
  getRandom?: () => number;
  getCurrentLeaderEpoch?: () => number | string | undefined;
  getThreadReconciliationMachineState?: () =>
    ThreadReconciler.ThreadReconciliationMachineState | undefined;
  recordThreadReconciliationPlan?: (
    plan: ThreadReconciler.ThreadReconciliationPlan,
  ) => void;
  topicTargetStore: BaleTopicTargetStore;
  callApi: <TResponse>(
    method: string,
    body: Record<string, unknown>,
  ) => Promise<TResponse>;
  probeWorkspaceBinding?: (
    binding: BaleWorkspaceThreadBinding,
  ) => Promise<void>;
  recordEvent: (
    category: string,
    message: unknown,
    details?: Record<string, unknown>,
  ) => void;
}

export interface BaleTopicLifecycleSyncDeps {
  topicTargetStore: Pick<
    BaleTopicTargetStore,
    | "load"
    | "list"
    | "listReservations"
    | "listPendingProvisions"
    | "markStaleByTarget"
    | "markActiveByTarget"
    | "removePendingProvision"
    | "persist"
  >;
  isBusEnabled: () => boolean;
  callApi: <TResponse>(
    method: string,
    body: Record<string, unknown>,
  ) => Promise<TResponse>;
  isTopicProvisioningActive?: () => boolean;
  getCurrentLeaderEpoch?: () => number | string | undefined;
  getThreadReconciliationMachineState?: () =>
    ThreadReconciler.ThreadReconciliationMachineState | undefined;
  recordThreadReconciliationPlan?: (
    plan: ThreadReconciler.ThreadReconciliationPlan,
  ) => void;
  assertExecutionCurrent?: (message: unknown) => void;
  recordEvent?: (
    category: string,
    message: unknown,
    details?: Record<string, unknown>,
  ) => void;
}

export type BaleTopicLifecycleSyncHandler<TMessage = unknown> = (
  lifecycle: BaleTopicLifecycleSyncUpdate<TMessage>,
) => Promise<void>;

export interface BaleObservedTopicLifecycleSyncDeps<
  TSyncState,
> extends BaleTopicLifecycleSyncDeps {
  runWorkspaceOperation: BaleSyncWorkspaceOperationRunner;
  getSyncState: () => TSyncState;
  setSyncState: (state: TSyncState) => void;
  getNowMs?: () => number;
}

export interface BaleLeaderHealthRuntimeDeps<TSyncState> {
  getNowMs?: () => number;
  intervalMs?: number;
  callGetMe: () => Promise<unknown>;
  getSyncState: () => TSyncState;
  setSyncState: (state: TSyncState) => void;
  recordEvent: (
    category: string,
    message: unknown,
    details?: Record<string, unknown>,
  ) => void;
}

export interface BaleLeaderHealthRuntime {
  start: () => void;
  stop: () => void;
}

export interface BaleManualThreadDisconnectDeps<TSyncState> {
  instanceId: string;
  getCurrentThreadRecord: () =>
    | {
        target: BaleTarget;
        instanceId?: string;
        profileKey?: string;
        owner?: { kind?: string };
      }
    | undefined;
  topicTargetStore: Pick<
    BaleTopicTargetStore,
    | "list"
    | "markStaleByTarget"
    | "persist"
    | "upsertPendingCleanup"
    | "removePendingCleanup"
  >;
  callApi: <TResponse>(
    method: string,
    body: Record<string, unknown>,
  ) => Promise<TResponse>;
  getLeaderTarget: () => BaleTarget | undefined;
  getCurrentLeaderEpoch?: () => number | string | undefined;
  clearLeaderTarget: () => void;
  disconnectFollowerThread?: () => Promise<boolean>;
  getSyncState: () => TSyncState;
  setSyncState: (state: TSyncState) => void;
  stopPolling: () => Promise<string>;
  recordRuntimeEvent: (
    category: string,
    error: unknown,
    details?: Record<string, unknown>,
  ) => void;
  runWorkspaceOperation: BaleSyncWorkspaceOperationRunner;
  workspaceOperationKind?: string;
  isDisconnectCurrent?: () => boolean;
  getNowMs?: () => number;
}

function markBaleConfigSyncChange<TSyncState extends BaleSyncState>(
  state: TSyncState,
  action: string,
  options?: { nowMs?: number },
): TSyncState {
  const nowMs = options?.nowMs ?? Date.now();
  let nextState = markBaleSyncSliceFresh(state, "pairing", {
    nowMs,
    action,
  }) as TSyncState;
  nextState = markBaleSyncSliceFresh(nextState, "allowed-user", {
    nowMs,
    action,
  }) as TSyncState;
  nextState = markBaleSyncSliceFresh(nextState, "bot-identity", {
    nowMs,
    action,
  }) as TSyncState;
  return nextState;
}

export function createBalePreservedLeaderQuitHandler(deps: {
  instanceId: string;
  topicTargetStore: Pick<
    BaleTopicTargetStore,
    "load" | "list" | "listPendingCleanups" | "detachTargetOwner"
  >;
  getCurrentLeaderEpoch: () => number | string | undefined;
  getProfileName: () => string | undefined;
  isPollingSuspended: () => boolean;
  resolveAutomaticThreadCleanupEnabled: () => boolean | Promise<boolean>;
  runWorkspaceOperation: BaleSyncWorkspaceOperationRunner;
}): (isSessionCurrent: () => boolean) => (() => Promise<void>) | undefined {
  return (isSessionCurrent) => {
    const epoch = deps.getCurrentLeaderEpoch();
    const profile = deps.getProfileName();
    if (epoch === undefined || !isSessionCurrent()) return undefined;
    const isCurrent = () =>
      isSessionCurrent() &&
      deps.getCurrentLeaderEpoch() === epoch &&
      deps.getProfileName() === profile &&
      deps.isPollingSuspended();
    return async () => {
      if (
        !isCurrent() ||
        (await deps.resolveAutomaticThreadCleanupEnabled()) !== false
      )
        return;
      if (!isCurrent()) return;
      await deps.runWorkspaceOperation(
        {
          operationId: createBaleWorkspaceAdmissionOperationId(),
          operationKind: "workspace.preserve-leader-quit",
          scopes: [{ kind: "profile" }],
        },
        async () => {
          if (!isCurrent()) return;
          await deps.topicTargetStore.load();
          if (!isCurrent()) return;
          const records = deps.topicTargetStore
            .list()
            .filter(
              (record) =>
                record.instanceId === deps.instanceId &&
                (record.status === "active" || record.status === "starting"),
            );
          if (records.length !== 1) return;
          const record = records[0]!;
          if (
            deps.topicTargetStore
              .listPendingCleanups()
              .some(
                (intent) =>
                  intent.target.chatId === record.target.chatId &&
                  intent.target.threadId === record.target.threadId,
              )
          )
            return;
          if (
            !(await deps.topicTargetStore.detachTargetOwner(
              record,
              isCurrent,
            )) &&
            isCurrent()
          ) {
            throw new Error(
              "Bale preserved leader detachment was not committed.",
            );
          }
        },
      );
    };
  };
}

export interface BaleSessionRestartThreadCleanupDeps<
  TSyncState extends BaleSyncState,
> extends Omit<BaleManualThreadDisconnectDeps<TSyncState>, "stopPolling"> {
  suspendPolling: () => Promise<void>;
}

function createBaleSessionRestartThreadCleanupHandler<
  TSyncState extends BaleSyncState,
>(
  deps: BaleSessionRestartThreadCleanupDeps<TSyncState>,
): () => Promise<string> {
  return createBaleManualThreadDisconnectHandler({
    ...deps,
    workspaceOperationKind: "workspace.cleanup-session-restart",
    async stopPolling() {
      await deps.suspendPolling();
      return "Bale bridge suspended for session restart.";
    },
  });
}

export interface BaleThreadDisconnectAssembly {
  disconnect: () => Promise<string>;
  cleanupForSessionRestart: () => Promise<string>;
}

export function createBaleThreadDisconnectAssembly<
  TSyncState extends BaleSyncState,
>(
  deps: Omit<BaleManualThreadDisconnectDeps<TSyncState>, "stopPolling"> & {
    stopPolling: () => Promise<string>;
    captureStopPolling?: () => {
      isCurrent: () => boolean;
      stop: () => Promise<string>;
    };
    suspendPolling: () => Promise<void>;
  },
): BaleThreadDisconnectAssembly {
  return {
    async disconnect() {
      const captured = deps.captureStopPolling?.();
      const stop = captured?.stop ?? deps.stopPolling;
      let stopAttempted = false;
      const disconnect = createBaleManualThreadDisconnectHandler({
        ...deps,
        workspaceOperationKind: "workspace.disconnect-thread",
        isDisconnectCurrent: captured?.isCurrent ?? deps.isDisconnectCurrent,
        stopPolling() {
          stopAttempted = true;
          return stop();
        },
      });
      try {
        return await disconnect();
      } catch (error) {
        // Never retry a stop whose teardown/release outcome may already have committed.
        if (stopAttempted) {
          deps.recordRuntimeEvent("connection", error, {
            phase: "disconnect-stop",
          });
          throw error;
        }
        deps.recordRuntimeEvent("connection", error, {
          phase: "disconnect-cleanup",
        });
        let stopped: string;
        try {
          stopped = await stop();
        } catch (stopError) {
          deps.recordRuntimeEvent("connection", stopError, {
            phase: "disconnect-stop",
          });
          throw stopError;
        }
        const separator = /[.!?]$/u.test(stopped) ? " " : ". ";
        return `${stopped}${separator}Thread cleanup was not confirmed. Check /bale-status --debug.`;
      }
    },
    cleanupForSessionRestart: createBaleSessionRestartThreadCleanupHandler({
      ...deps,
      suspendPolling: deps.suspendPolling,
    }),
  };
}

export function createBaleManualThreadDisconnectHandler<
  TSyncState extends BaleSyncState,
>(deps: BaleManualThreadDisconnectDeps<TSyncState>): () => Promise<string> {
  const assertCurrent = () => {
    if (deps.isDisconnectCurrent?.() === false)
      throw new Error(
        "Bale disconnect was superseded by a new connection.",
      );
  };
  const operation = async (): Promise<string> => {
    assertCurrent();
    const currentRecord = deps.getCurrentThreadRecord();
    let cleanupPending = false;
    let followerThreadKept = false;
    if (currentRecord?.target.threadId) {
      const isManualFollower = currentRecord.owner?.kind === "manual-follower";
      const leaderEpoch = deps.getCurrentLeaderEpoch?.();
      const ownsLeader = deps.getCurrentLeaderEpoch
        ? leaderEpoch !== undefined
        : !isManualFollower;
      if (isManualFollower && !ownsLeader) {
        if (deps.disconnectFollowerThread) {
          const disconnected = await deps.disconnectFollowerThread();
          assertCurrent();
          // Without a live leader the Thread cannot be deleted; still stop locally and never claim deletion.
          followerThreadKept = !disconnected;
        }
      } else {
        const target = currentRecord.target as BaleTarget & {
          threadId: number;
        };
        const runtimeGeneration = currentRecord.instanceId ?? deps.instanceId;
        const intent: ThreadReconciler.BaleThreadCleanupIntent = {
          id: `cleanup:${deps.instanceId}:${runtimeGeneration}:${target.chatId}:${target.threadId}`,
          owner: isManualFollower ? "manual-follower" : "leader",
          instanceId: deps.instanceId,
          runtimeGeneration,
          ...(currentRecord.profileKey
            ? { profileKey: currentRecord.profileKey }
            : {}),
          target,
          requestedAtMs: (deps.getNowMs ?? Date.now)(),
        };
        const departingRecord = deps.topicTargetStore
          .list()
          .find(
            (record) =>
              record.instanceId === currentRecord.instanceId &&
              record.target.chatId === target.chatId &&
              record.target.threadId === target.threadId,
          );
        const isCleanupTargetProtected = createBaleCleanupTargetProtection(
          deps.topicTargetStore,
          departingRecord,
        );
        deps.topicTargetStore.upsertPendingCleanup(intent);
        await deps.topicTargetStore.persist();
        assertCurrent();
        const cleanupPlan = ThreadReconciler.planThreadReconciliation({
          nowMs: (deps.getNowMs ?? Date.now)(),
          currentLeaderEpoch: leaderEpoch,
          records: [],
          pendingCleanups: [intent],
        });
        const cleanup = await ThreadReconciler.applyThreadReconciliationPlan(
          cleanupPlan,
          {
            isCleanupTargetProtected,
            callApi(method, body) {
              assertCurrent();
              return deps.callApi(method, body);
            },
            markStaleByTarget(targetToMark, syncStatus, lastSyncError) {
              assertCurrent();
              return deps.topicTargetStore.markStaleByTarget(
                targetToMark,
                syncStatus,
                lastSyncError,
              );
            },
            removeCleanupIntentById(id) {
              assertCurrent();
              return deps.topicTargetStore.removePendingCleanup(id);
            },
            persist() {
              assertCurrent();
              return deps.topicTargetStore.persist();
            },
            getCurrentLeaderEpoch: deps.getCurrentLeaderEpoch,
            recordRuntimeEvent: deps.recordRuntimeEvent,
          },
        );
        assertCurrent();
        if (
          cleanupPlan.actions.some((action) =>
            isCleanupTargetProtected(action.target, action),
          )
        ) {
          return "Thread disconnect superseded by a new binding.";
        }
        cleanupPending = Boolean(cleanup.incompleteActions?.length);
      }
      const leaderTarget = deps.getLeaderTarget();
      if (
        leaderTarget?.chatId === currentRecord.target.chatId &&
        leaderTarget.threadId === currentRecord.target.threadId
      ) {
        deps.clearLeaderTarget();
      }
      deps.setSyncState(
        markBaleSyncSliceFresh(deps.getSyncState(), "target-bindings", {
          nowMs: (deps.getNowMs ?? Date.now)(),
          action: "manual-disconnect",
        }) as TSyncState,
      );
    }
    assertCurrent();
    const stopped = await deps.stopPolling();
    if (followerThreadKept)
      return "Bale bridge disconnected. Thread kept: no live leader could delete it.";
    return cleanupPending
      ? `${stopped} Bale thread cleanup remains pending for the next leader.`
      : stopped;
  };
  return () =>
    deps.runWorkspaceOperation(
      {
        operationId: createBaleWorkspaceAdmissionOperationId(),
        operationKind:
          deps.workspaceOperationKind ?? "workspace.disconnect-thread",
        scopes: [{ kind: "profile" }],
      },
      operation,
    );
}

export function createBaleLeaderHealthRuntime<
  TSyncState extends BaleSyncState,
>(
  deps: BaleLeaderHealthRuntimeDeps<TSyncState>,
): BaleLeaderHealthRuntime {
  const intervalMs = deps.intervalMs ?? 60_000;
  const getNowMs = deps.getNowMs ?? Date.now;
  let interval: ReturnType<typeof setInterval> | undefined;
  let generation = 0;
  let tickPromise: Promise<void> | undefined;

  const markFresh = (): void => {
    let state = markBaleSyncSliceFresh(
      deps.getSyncState(),
      "transport-health",
      { nowMs: getNowMs(), action: "leader-health-tick" },
    ) as TSyncState;
    state = markBaleSyncSliceFresh(state, "bot-identity", {
      nowMs: getNowMs(),
      action: "leader-health-tick",
    }) as TSyncState;
    deps.setSyncState(state);
  };

  const markSuspect = (error: unknown): void => {
    deps.setSyncState(
      markBaleSyncSliceSuspect(deps.getSyncState(), "transport-health", {
        nowMs: getNowMs(),
        reason: String(error),
        action: "leader-health-tick",
      }) as TSyncState,
    );
    try {
      deps.recordEvent("bale", error, { phase: "leader-health-tick" });
    } catch {
      // Health diagnostics cannot create an unhandled timer rejection.
    }
  };

  const stop = (): void => {
    generation += 1;
    if (interval) clearInterval(interval);
    interval = undefined;
    tickPromise = undefined;
  };
  const requestTick = (): Promise<void> => {
    if (tickPromise) return tickPromise;
    const expectedGeneration = generation;
    let tracked: Promise<void>;
    tracked = Promise.resolve()
      .then(deps.callGetMe)
      .then(
        () => {
          if (generation !== expectedGeneration) return;
          try {
            markFresh();
          } catch (stateError) {
            try {
              deps.recordEvent("bale", stateError, {
                phase: "leader-health-state",
              });
            } catch {
              // State and diagnostic failure remain contained by this owner.
            }
          }
        },
        (error) => {
          if (generation !== expectedGeneration) return;
          try {
            markSuspect(error);
          } catch (stateError) {
            try {
              deps.recordEvent("bale", stateError, {
                phase: "leader-health-state",
              });
            } catch {
              // State and diagnostic failure remain contained by this owner.
            }
          }
        },
      )
      .finally(() => {
        if (tickPromise === tracked) tickPromise = undefined;
      });
    tickPromise = tracked;
    return tracked;
  };

  return {
    start() {
      stop();
      interval = setInterval(() => {
        void requestTick();
      }, intervalMs);
      interval.unref?.();
    },
    stop,
  };
}

export interface BaleStaleTopicApiErrorRecoveryDeps<TSyncState> {
  topicTargetStore: Pick<
    BaleTopicTargetStore,
    "load" | "markStaleByTarget" | "persist"
  > &
    Partial<Pick<BaleTopicTargetStore, "invalidateTarget">>;
  getSyncState: () => TSyncState;
  setSyncState: (state: TSyncState) => void;
  recordEvent: (
    category: string,
    message: unknown,
    details?: Record<string, unknown>,
  ) => void;
  getNowMs?: () => number;
  isCurrent?: () => boolean;
  isAuthorityCurrent?: () => boolean;
  getWorkspaceAdmission?: () =>
    | Pick<
        BaleWorkspaceAdmissionLedger,
        "acquireAdmission" | "releaseAdmission"
      >
    | undefined;
}

export function captureBaleStaleTargetRequestRecovery<
  TSyncState extends BaleSyncState,
>(
  body: Record<string, unknown>,
  deps: BaleStaleTopicApiErrorRecoveryDeps<TSyncState> & {
    topicTargetStore: Pick<
      BaleTopicTargetStore,
      "load" | "list" | "markStaleByTarget" | "persist" | "invalidateTarget"
    >;
    getCurrentLeaderEpoch: () => number | string | undefined;
    getSessionGeneration: () => number;
    getProfileName: () => string | undefined;
    onRecovered: () => void;
  },
): ((error: unknown) => Promise<void>) | undefined {
  const target = getBaleTargetFromApiBody(body);
  const epoch = deps.getCurrentLeaderEpoch();
  if (!target || epoch === undefined) return undefined;
  const key = getBaleTargetKey(target);
  const record = deps.topicTargetStore
    .list()
    .find((candidate) => getBaleTargetKey(candidate.target) === key);
  if (!record) return undefined;
  const generation = deps.getSessionGeneration();
  const profile = deps.getProfileName();
  const isAuthorityCurrent = (): boolean =>
    deps.getCurrentLeaderEpoch() === epoch &&
    deps.getSessionGeneration() === generation &&
    deps.getProfileName() === profile;
  const isCurrent = (): boolean => {
    const current = deps.topicTargetStore
      .list()
      .find((candidate) => getBaleTargetKey(candidate.target) === key);
    return (
      isAuthorityCurrent() &&
      current?.instanceId === record.instanceId &&
      current?.profileKey === record.profileKey &&
      current?.updatedAtMs === record.updatedAtMs &&
      current?.createdAtMs === record.createdAtMs
    );
  };
  return async (error) => {
    const requestTarget = getBaleApiErrorRequestTarget(error);
    if (
      !isBaleStaleTargetHttpError(error) ||
      !requestTarget ||
      getBaleTargetKey(requestTarget) !== key ||
      !isCurrent()
    )
      return;
    if (
      await recoverStaleBaleTopicApiError(
        { chat_id: target.chatId, message_thread_id: target.threadId },
        error,
        { ...deps, isCurrent, isAuthorityCurrent },
      )
    ) {
      deps.onRecovered();
    }
  };
}

export function createBaleStaleTopicApiErrorRecoveryRuntime<
  TSyncState extends BaleSyncState,
>(
  deps: BaleStaleTopicApiErrorRecoveryDeps<TSyncState>,
): (apiBody: unknown, error: unknown) => Promise<boolean> {
  return (apiBody, error) =>
    recoverStaleBaleTopicApiError(apiBody, error, deps);
}

export async function settleStaleBaleTopicExecutionFailure<
  TSyncState extends BaleSyncState,
>(
  error: unknown,
  deps: BaleStaleTopicApiErrorRecoveryDeps<TSyncState>,
): Promise<boolean> {
  const target = getBaleApiErrorRequestTarget(error);
  if (!target || !isBaleTopicTargetStaleError(error)) return false;
  await recoverStaleBaleTopicApiError(
    { chat_id: target.chatId, message_thread_id: target.threadId },
    error,
    deps,
  );
  return true;
}

export async function recoverStaleBaleTopicApiError<
  TSyncState extends BaleSyncState,
>(
  apiBody: unknown,
  error: unknown,
  deps: BaleStaleTopicApiErrorRecoveryDeps<TSyncState>,
): Promise<boolean> {
  const target = getBaleTargetFromApiBody(apiBody);
  if (
    !target ||
    !isBaleTopicTargetStaleError(error) ||
    deps.isCurrent?.() === false
  )
    return false;
  const recover = async (): Promise<boolean> => {
    if (deps.isCurrent) {
      if (
        !deps.topicTargetStore.invalidateTarget ||
        !(await deps.topicTargetStore.invalidateTarget(
          target,
          deps.isCurrent,
          String(error),
        ))
      )
        return false;
      if (deps.isAuthorityCurrent?.() === false) return false;
    } else {
      await deps.topicTargetStore.load();
      if (
        !deps.topicTargetStore.markStaleByTarget(
          target,
          "deleted",
          String(error),
        )
      )
        return false;
      await deps.topicTargetStore.persist();
    }
    const nowMs = (deps.getNowMs ?? Date.now)();
    let state = markBaleSyncSliceSuspect(
      deps.getSyncState(),
      "topic-state",
      {
        nowMs,
        reason: "stale-api-error",
        action: "topic-target-stale",
      },
    ) as TSyncState;
    state = markBaleSyncSliceSuspect(state, "transport-health", {
      nowMs,
      reason: "stale-api-error",
      action: "topic-target-stale",
    }) as TSyncState;
    state = markBaleSyncSliceSuspect(state, "target-bindings", {
      nowMs,
      reason: "stale-api-error",
      action: "topic-target-stale",
    }) as TSyncState;
    deps.setSyncState(state);
    deps.recordEvent("bus", error, {
      phase: "topic-target-stale",
      chatId: target.chatId,
      threadId: target.threadId,
    });
    return true;
  };
  if (!deps.getWorkspaceAdmission) return recover();
  const admission = deps.getWorkspaceAdmission();
  if (!admission) {
    throw new Error("Bale Workspace admission authority is unavailable.");
  }
  return runWithBaleWorkspaceAdmissionsAsync({
    ledger: admission,
    operationId: createBaleWorkspaceAdmissionOperationId(),
    operationKind: "workspace.recover-stale-target",
    scopes: [{ kind: "target", target }],
    operation: recover,
    onReleaseError(releaseError) {
      deps.recordEvent("bus", releaseError, {
        phase: "workspace-admission-release",
        operationKind: "workspace.recover-stale-target",
        chatId: target.chatId,
        threadId: target.threadId,
      });
    },
  });
}

export async function ensureBaleLeaderThreadBinding(
  deps: BaleLeaderThreadSyncDeps,
): Promise<BaleOwnTopicProvisionResult | undefined> {
  const leaderEpoch = deps.getCurrentLeaderEpoch?.();
  const assertLeaderEpoch = (phase: string): void => {
    if (
      deps.getCurrentLeaderEpoch &&
      (leaderEpoch === undefined ||
        deps.getCurrentLeaderEpoch() !== leaderEpoch)
    ) {
      throw new Error(
        `Bale leader thread binding lost ownership (${phase}).`,
      );
    }
  };
  assertLeaderEpoch("start");
  await deps.topicTargetStore.load();
  assertLeaderEpoch("after-load");
  const normalizedLeaderCwd = deps.cwd
    ? normalizeBaleWorkspacePath(deps.cwd)
    : undefined;
  const leaderOwner = {
    kind: "leader" as const,
    cwd: normalizedLeaderCwd,
    instanceId: deps.instanceId,
    ...(deps.baleProfile ? { baleProfile: deps.baleProfile } : {}),
  };
  const leaderProfileKey = getBaleThreadOwnerKey(leaderOwner);
  if (deps.forceFreshUnnamed) {
    await resetBaleConnectionProvisioning({
      store: deps.topicTargetStore, owner: "leader", instanceId: deps.instanceId,
      profileKey: leaderProfileKey, isCurrent: () => {
        assertLeaderEpoch("connect-recovery");
        return true;
      }, recordEvent: deps.recordEvent,
    });
  }
  const legacyLeaderRecord =
    deps.topicTargetStore.getByProfileKey(leaderProfileKey);
  let capacityUnavailable = false;
  const workspaceIdentity = normalizedLeaderCwd
    ? deps.topicTargetStore.claimWorkspaceIdentity(
        normalizedLeaderCwd,
        deps.instanceId,
        legacyLeaderRecord?.instanceId,
        {
          sessionId: deps.sessionId,
          provisionProfileKey: leaderProfileKey,
          onCapacityUnavailable() {
            capacityUnavailable = true;
          },
        },
      )
    : undefined;
  if (deps.cwd && !workspaceIdentity) {
    if (capacityUnavailable) throw new BaleWorkspaceSlotUnavailableError();
    throw new Error("Bale Workspace identity is already claimed.");
  }
  const commitWorkspaceBinding = async (
    result: BaleOwnTopicProvisionResult,
  ): Promise<BaleOwnTopicProvisionResult> => {
    if (!workspaceIdentity) return result;
    const committed = commitBaleWorkspaceProvisionBinding({
      store: deps.topicTargetStore,
      instanceId: deps.instanceId,
      profileKey: leaderProfileKey,
      displayTitle: result.displayTitle,
      binding: {
        ...workspaceIdentity,
        target: { ...result.target },
        ...(result.threadName ? { threadName: result.threadName } : {}),
        ...(result.slot ? { slot: result.slot } : {}),
        journalBindingKeys: [],
        journalBindingsComplete: true,
        updatedAtMs: deps.getNowMs?.() ?? Date.now(),
      },
    });
    deps.topicTargetStore.markWorkspaceBindingActiveByTarget(result.target);
    assertLeaderEpoch("before-workspace-persist");
    await deps.topicTargetStore.persist();
    assertLeaderEpoch("after-workspace-persist");
    const {
      target: _target,
      slot: _slot,
      threadName: _threadName,
      displayTitle: _displayTitle,
      ...rest
    } = result;
    return {
      ...rest,
      target: { ...committed.target },
      slot: committed.slot ?? result.slot,
      ...(committed.threadName ? { threadName: committed.threadName } : {}),
      ...(committed.displayTitle
        ? { displayTitle: committed.displayTitle }
        : {}),
    };
  };
  try {
    const unavailableTargetKeys = new Set([
      ...deps.topicTargetStore
        .listSyncObservations()
        .filter((observation) => observation.syncStatus === "deleted")
        .map((observation) => getBaleTargetKey(observation.target)),
      ...deps.topicTargetStore
        .listPendingCleanups()
        .map((intent) => getBaleTargetKey(intent.target)),
    ]);
    let invalidatedUnavailableTarget = false;
    for (const record of deps.topicTargetStore.list()) {
      if (
        record.instanceId !== deps.instanceId ||
        !unavailableTargetKeys.has(getBaleTargetKey(record.target))
      ) {
        continue;
      }
      invalidatedUnavailableTarget =
        deps.topicTargetStore.markStaleByTarget(record.target) ||
        invalidatedUnavailableTarget;
    }
    if (invalidatedUnavailableTarget) {
      assertLeaderEpoch("before-unavailable-persist");
      await deps.topicTargetStore.persist();
      assertLeaderEpoch("after-unavailable-persist");
    }
    const persistedWorkspaceBinding = workspaceIdentity
      ? deps.topicTargetStore.getWorkspaceBinding(
          workspaceIdentity.cwd,
          workspaceIdentity.instanceSlot,
          workspaceIdentity.sessionId,
        )
      : undefined;
    const legacyWorkspaceBinding =
      workspaceIdentity?.instanceSlot === "a" &&
      deps.sessionId === undefined &&
      !persistedWorkspaceBinding &&
      typeof legacyLeaderRecord?.target.threadId === "number"
        ? {
            ...workspaceIdentity,
            target: { ...legacyLeaderRecord.target },
            ...(legacyLeaderRecord.threadName
              ? { threadName: legacyLeaderRecord.threadName }
              : {}),
            ...(legacyLeaderRecord.slot
              ? { slot: legacyLeaderRecord.slot }
              : {}),
            updatedAtMs: legacyLeaderRecord.updatedAtMs,
          }
        : undefined;
    const recoverableWorkspaceBinding =
      persistedWorkspaceBinding ?? legacyWorkspaceBinding;
    const recoverableTargetKey = recoverableWorkspaceBinding
      ? getBaleTargetKey(recoverableWorkspaceBinding.target)
      : undefined;
    const recoverableRecord = recoverableWorkspaceBinding
      ? deps.topicTargetStore
          .list()
          .find(
            (record) =>
              getBaleTargetKey(record.target) === recoverableTargetKey,
          )
      : undefined;
    const sameProcessWorkspaceBinding =
      !!recoverableRecord &&
      (recoverableRecord.instanceId === deps.instanceId ||
        isSameBaleProcessInstance(
          recoverableRecord.instanceId,
          deps.instanceId,
        ));
    if (
      recoverableWorkspaceBinding &&
      !unavailableTargetKeys.has(recoverableTargetKey ?? "") &&
      (!deps.forceFreshUnnamed || recoverableWorkspaceBinding.threadName) &&
      (sameProcessWorkspaceBinding || deps.probeWorkspaceBinding)
    ) {
      let workspaceTargetVisible = sameProcessWorkspaceBinding;
      if (!workspaceTargetVisible && deps.probeWorkspaceBinding) {
        assertLeaderEpoch("before-workspace-probe");
        try {
          await deps.probeWorkspaceBinding(recoverableWorkspaceBinding);
          assertLeaderEpoch("after-workspace-probe");
          workspaceTargetVisible = true;
        } catch (error) {
          if (!isBaleTopicTargetStaleError(error)) throw error;
          deps.topicTargetStore.markStaleByTarget(
            recoverableWorkspaceBinding.target,
            "deleted",
            error instanceof Error ? error.message : String(error),
          );
          await deps.topicTargetStore.persist();
          deps.recordEvent("bus", error, {
            phase: "leader-workspace-target-stale",
            chatId: recoverableWorkspaceBinding.target.chatId,
            threadId: recoverableWorkspaceBinding.target.threadId,
            instanceId: deps.instanceId,
          });
        }
      }
      if (workspaceTargetVisible) {
        const nowMs = deps.getNowMs?.() ?? Date.now();
        const slot = workspaceIdentity?.slot;
        if (!slot) {
          throw new Error("Bale Thread slot authority is unavailable.");
        }
        const recovered = await commitWorkspaceBinding({
          target: { ...recoverableWorkspaceBinding.target },
          slot,
          ...(recoverableWorkspaceBinding.threadName
            ? { threadName: recoverableWorkspaceBinding.threadName }
            : {}),
          reused: true,
        });
        deps.topicTargetStore.upsert({
          profileKey: leaderProfileKey,
          owner: leaderOwner,
          target: { ...recovered.target },
          status: "active",
          createdAtMs: recoverableRecord?.createdAtMs ?? nowMs,
          updatedAtMs: nowMs,
          ...(recovered.threadName ? { threadName: recovered.threadName } : {}),
          instanceId: deps.instanceId,
          slot: recovered.slot,
          syncStatus: "open",
          lastSyncObservedAtMs: nowMs,
          lastReconcileAction: "leader-workspace-binding-recovered",
        });
        assertLeaderEpoch("before-recovered-record-persist");
        await deps.topicTargetStore.persist();
        assertLeaderEpoch("after-recovered-record-persist");
        deps.recordEvent(
          "bale",
          "Leader thread preserved after Workspace recovery",
          {
            phase: "leader-thread-reused",
            instanceId: deps.instanceId,
            chatId: recovered.target.chatId,
            threadId: recovered.target.threadId,
            slot: recovered.slot,
          },
        );
        return recovered;
      }
    }
    const priorTargets = deps.topicTargetStore.list().filter((record) => {
      return (
        record.instanceId === deps.instanceId &&
        (record.status === "active" || record.status === "starting")
      );
    });
    // Legacy callers without session identity may reuse the active instance target.
    // Session-aware callers must resolve their exact Workspace binding instead.
    if (
      deps.sessionId === undefined &&
      !deps.forceFreshUnnamed &&
      priorTargets.length > 0
    ) {
      const record = priorTargets[0];
      deps.recordEvent(
        "bale",
        "Leader thread preserved after session lifecycle change",
        {
          phase: "leader-thread-reused",
          instanceId: deps.instanceId,
          chatId: record.target.chatId,
          threadId: record.target.threadId,
          slot: record.slot,
        },
      );
      assertLeaderEpoch("before-reuse");
      if (!record.slot) {
        throw new Error("Bale Thread slot authority is unavailable.");
      }
      return await commitWorkspaceBinding({
        target: record.target,
        slot: record.slot,
        ...(record.threadName ? { threadName: record.threadName } : {}),
        reused: true,
      });
    }
    let forcedUnnamedStale = false;
    if (deps.forceFreshUnnamed) {
      for (const record of priorTargets) {
        const isLeaderOwned =
          record.owner?.kind === "leader" ||
          (!record.owner &&
            (record.profileKey.startsWith("cwd:") ||
              record.profileKey.startsWith("leader:")));
        if (!isLeaderOwned) continue;
        if (record.threadName) continue;
        forcedUnnamedStale =
          deps.topicTargetStore.markStaleByTarget(record.target) ||
          forcedUnnamedStale;
        deps.recordEvent(
          "bale",
          "Unnamed leader thread binding refreshed",
          {
            phase: "leader-thread-force-fresh-unnamed",
            instanceId: deps.instanceId,
            chatId: record.target.chatId,
            threadId: record.target.threadId,
            slot: record.slot,
          },
        );
      }
      if (forcedUnnamedStale) await deps.topicTargetStore.persist();
    }
    assertLeaderEpoch("before-provision");
    const ownTarget = await provisionOwnBusTopic({
      getAllowedUserId: deps.getAllowedUserId,
      instanceId: deps.instanceId,
      cwd: normalizedLeaderCwd,
      baleProfile: deps.baleProfile,
      getCurrentLeaderEpoch: deps.getCurrentLeaderEpoch,
      getThreadReconciliationMachineState:
        deps.getThreadReconciliationMachineState,
      recordThreadReconciliationPlan: deps.recordThreadReconciliationPlan,
      store: deps.topicTargetStore,
      callApi: deps.callApi,
      getNowMs: deps.getNowMs,
      getRandom: deps.getRandom,
      requestedThreadName:
        recoverableWorkspaceBinding?.threadName ?? deps.requestedThreadName,
      workspaceBindingKey: workspaceIdentity?.bindingKey,
      preferredSlot: workspaceIdentity?.slot,
      resolveInitialWorkspaceDisplayTitle:
        deps.resolveInitialWorkspaceDisplayTitle,
      recordEvent: deps.recordEvent,
    });
    assertLeaderEpoch("after-provision");
    if (!ownTarget) return undefined;
    const replacementPlan = ThreadReconciler.planThreadReconciliation({
      nowMs: Date.now(),
      currentLeaderEpoch: deps.getCurrentLeaderEpoch?.(),
      previousState: deps.getThreadReconciliationMachineState?.(),
      records: priorTargets,
      pendingProvisions: deps.topicTargetStore.listPendingProvisions(),
      replacedBindings: [
        {
          instanceId: deps.instanceId,
          replacementTarget: ownTarget.target,
        },
      ],
    });
    deps.recordThreadReconciliationPlan?.(replacementPlan);
    await ThreadReconciler.applyThreadReconciliationPlan(replacementPlan, {
      isCleanupTargetProtected: createBaleCleanupTargetProtection(
        deps.topicTargetStore,
      ),
      callApi: deps.callApi,
      markStaleByTarget: (target, syncStatus, lastSyncError) =>
        deps.topicTargetStore.markStaleByTarget(
          target,
          syncStatus,
          lastSyncError,
        ),
      persist: () => deps.topicTargetStore.persist(),
      removePendingProvisionById: (id) =>
        deps.topicTargetStore.removePendingProvision(id),
      getCurrentLeaderEpoch: deps.getCurrentLeaderEpoch,
      recordRuntimeEvent: deps.recordEvent,
    });
    assertLeaderEpoch("before-final-persist");
    await deps.topicTargetStore.persist();
    assertLeaderEpoch("after-final-persist");
    return await commitWorkspaceBinding(ownTarget);
  } finally {
    deps.topicTargetStore.releaseWorkspaceClaim(deps.instanceId);
  }
}

const BALE_SYNC_SLICE_TARGET_BINDINGS = "target-bindings";

export const BALE_SYNC_SLICES = [
  "bot-identity",
  "bot-capabilities",
  "pairing",
  "allowed-user",
  "topic-capability",
  "topic-state",
  BALE_SYNC_SLICE_TARGET_BINDINGS,
  "reservations",
  "transport-health",
] as const;

export type BaleSyncSlice = (typeof BALE_SYNC_SLICES)[number];

export interface BaleSyncSliceState {
  status: "fresh" | "suspect" | "unknown";
  updatedAtMs?: number;
  suspectAtMs?: number;
  reason?: string;
  lastReconcileAction?: string;
}

export type BaleSyncState = Partial<
  Record<BaleSyncSlice, BaleSyncSliceState>
>;

export function createUnknownBaleSyncState(): BaleSyncState {
  return Object.fromEntries(
    BALE_SYNC_SLICES.map((slice) => [slice, { status: "unknown" }]),
  ) as BaleSyncState;
}

export interface BaleSyncStateRuntime {
  getState(): BaleSyncState;
  setState(state: BaleSyncState): void;
  markConfigChange(action: string): void;
  markSliceFresh(
    slice: BaleSyncSlice,
    options: { nowMs: number; action: string },
  ): void;
}

export function createBaleConfigSyncPersister<TConfig>(deps: {
  persist: (config?: TConfig) => Promise<void>;
  markConfigChange: (action: string) => void;
}): (config?: TConfig) => Promise<void> {
  return async (config) => {
    await deps.persist(config);
    deps.markConfigChange("config-persist");
  };
}

export function createBaleSyncStateRuntime(
  initialState = createUnknownBaleSyncState(),
): BaleSyncStateRuntime {
  let state = initialState;
  return {
    getState: () => state,
    setState(nextState) {
      state = nextState;
    },
    markConfigChange(action) {
      state = markBaleConfigSyncChange(state, action);
    },
    markSliceFresh(slice, options) {
      state = markBaleSyncSliceFresh(state, slice, options);
    },
  };
}

export interface BaleProvisioningActivityRuntime {
  isActive(): boolean;
  start(): void;
  end(): void;
}

export function createBaleProvisioningActivityRuntime(): BaleProvisioningActivityRuntime {
  let activeCount = 0;
  return {
    isActive: () => activeCount > 0,
    start() {
      activeCount += 1;
    },
    end() {
      activeCount = Math.max(0, activeCount - 1);
    },
  };
}

export function markBaleSyncSliceSuspect(
  state: BaleSyncState,
  slice: BaleSyncSlice,
  input: {
    reason: string;
    nowMs: number;
    action?: string;
  },
): BaleSyncState {
  return {
    ...state,
    [slice]: {
      ...(state[slice] ?? { status: "unknown" }),
      status: "suspect",
      suspectAtMs: input.nowMs,
      reason: input.reason,
      lastReconcileAction: input.action,
    },
  };
}

export function markBaleSyncSliceFresh(
  state: BaleSyncState,
  slice: BaleSyncSlice,
  input: {
    nowMs: number;
    action: string;
  },
): BaleSyncState {
  return {
    ...state,
    [slice]: {
      status: "fresh",
      updatedAtMs: input.nowMs,
      lastReconcileAction: input.action,
    },
  };
}

export function createBaleObservedTopicLifecycleSyncHandler<
  TMessage = unknown,
  TSyncState extends BaleSyncState = BaleSyncState,
>(
  deps: BaleObservedTopicLifecycleSyncDeps<TSyncState>,
): BaleTopicLifecycleSyncHandler<TMessage> {
  const syncTopicLifecycle =
    createBaleTopicLifecycleSyncHandler<TMessage>(deps);
  const operation = async (
    lifecycle: BaleTopicLifecycleSyncUpdate<TMessage>,
  ): Promise<void> => {
    const nowMs = deps.getNowMs ?? Date.now;
    deps.assertExecutionCurrent?.(lifecycle.message);
    deps.setSyncState(
      markBaleSyncSliceSuspect(deps.getSyncState(), "topic-state", {
        nowMs: nowMs(),
        reason: `topic-${lifecycle.kind}`,
        action: "topic-lifecycle",
      }) as TSyncState,
    );
    await syncTopicLifecycle(lifecycle);
    deps.assertExecutionCurrent?.(lifecycle.message);
    deps.setSyncState(
      markBaleSyncSliceFresh(deps.getSyncState(), "topic-state", {
        nowMs: nowMs(),
        action: "topic-lifecycle",
      }) as TSyncState,
    );
  };
  return (lifecycle) =>
    deps.runWorkspaceOperation(
      {
        operationId: createBaleWorkspaceAdmissionOperationId(),
        operationKind: "workspace.sync-topic-lifecycle",
        scopes: [{ kind: "profile" }],
      },
      () => operation(lifecycle),
    );
}

export function createBaleTopicLifecycleSyncHandler<TMessage = unknown>(
  deps: BaleTopicLifecycleSyncDeps,
): BaleTopicLifecycleSyncHandler<TMessage> {
  return async (lifecycle) => {
    deps.assertExecutionCurrent?.(lifecycle.message);
    await deps.topicTargetStore.load();
    deps.assertExecutionCurrent?.(lifecycle.message);
    const nowMs = Date.now();
    const plan = ThreadReconciler.planThreadReconciliation({
      nowMs,
      currentLeaderEpoch: deps.getCurrentLeaderEpoch?.(),
      previousState: deps.getThreadReconciliationMachineState?.(),
      records: deps.topicTargetStore.list(),
      reservations: deps.topicTargetStore.listReservations(),
      pendingProvisions: deps.topicTargetStore.listPendingProvisions(),
      observations: [
        {
          target: lifecycle.target,
          syncStatus: lifecycle.kind === "closed" ? "closed" : "open",
          observedAtMs: nowMs,
        },
      ],
    });
    deps.recordThreadReconciliationPlan?.(plan);
    const result = await ThreadReconciler.applyThreadReconciliationPlan(plan, {
      markActiveByTarget: (target) =>
        deps.topicTargetStore.markActiveByTarget(target),
      markStaleByTarget: (target, syncStatus, lastSyncError) =>
        deps.topicTargetStore.markStaleByTarget(
          target,
          syncStatus,
          lastSyncError,
        ),
      persist: () => deps.topicTargetStore.persist(),
      removePendingProvisionById: (id) =>
        deps.topicTargetStore.removePendingProvision(id),
      getCurrentLeaderEpoch: deps.getCurrentLeaderEpoch,
      recordRuntimeEvent: deps.recordEvent,
    });
    const changed = result.changed;
    if (lifecycle.kind === "created" && deps.isBusEnabled()) {
      const target = lifecycle.target;
      const isKnownInRecords = deps.topicTargetStore.list().some((record) => {
        return (
          record.target.chatId === target.chatId &&
          record.target.threadId === target.threadId
        );
      });
      const isKnownInReservations = deps.topicTargetStore
        .listReservations()
        .some((reservation) => {
          return (
            reservation.target.chatId === target.chatId &&
            reservation.target.threadId === target.threadId
          );
        });
      if (!isKnownInRecords && !isKnownInReservations) {
        deps.recordEvent?.(
          "bale",
          deps.isTopicProvisioningActive?.()
            ? "Bale unknown topic creation observed during provisioning"
            : "Bale unknown topic creation observed",
          {
            phase: deps.isTopicProvisioningActive?.()
              ? "topic-lifecycle-provisioning-skip"
              : "topic-lifecycle-unknown-created-observed",
            chatId: target.chatId,
            threadId: target.threadId,
          },
        );
      }
    }
    deps.recordEvent?.("bale", "Bale topic lifecycle update", {
      phase: "topic-lifecycle",
      lifecycle: lifecycle.kind,
      chatId: lifecycle.target.chatId,
      threadId: lifecycle.target.threadId,
      changed,
    });
  };
}

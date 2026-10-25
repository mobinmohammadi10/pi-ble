/**
 * Bale thread binding helpers
 * Zones: multi-instance bus, Bale UI threads, durable Workspace state
 * Owns live mappings, Workspace bindings and guarded Restore transitions; routing and transport effects stay outside.
 */

import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { chmod, mkdir, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";

import {
  parseBaleIntegerId as asInteger,
  getBaleTargetKey as getTargetRecoveryHintKey,
  areBaleTargetsEqual as targetMatches,
  type BaleTarget,
} from "./target.ts";
import {
  isBaleApiCommitUnknownError,
  BaleApiCommitUnknownError,
  type BaleApiCallOptions,
} from "./bale-api.ts";
import {
  getBaleTopicName as buildBaleTopicName,
  chooseBaleThreadName,
  getBaleManualThreadDisplayNameValidationError,
  getBaleThreadNameLeadingSlot,
  getBaleTopicIdentityName,
  getBaleTopicTitleForThreadName,
  isBaleTopicThreadNameValidForSlot,
  normalizeBaleTopicTargetThreadName,
} from "./thread-naming.ts";
import {
  isWireRecord as restoreObject,
  isNonEmptyWireString as restoreText,
} from "./wire.ts";

import {
  renameBalePathWithRetry,
  isBaleOwnerPrivate,
  BALE_STRICT_READ_FLAGS,
  readBaleRuntimeState,
  withBaleFileTransaction,
  type BaleLockContext,
  type BaleLockRuntime,
  type BaleOwnedStatePublicationOptions,
  type BaleOwnedStatePublicationResult,
  type BaleRuntimeStateMutation,
} from "./locks.ts";
import { resolveBaleProfileTempFilePath } from "./paths.ts";
import { createBaleRuntimeProjectionStore } from "./status.ts";
import * as ThreadReconciler from "./thread-reconciler.ts";
import {
  createBaleSessionKey,
  createBaleWorkspaceBindingIdentityWithKey,
  createBaleWorkspaceDirectoryKey,
  normalizeBaleSessionId,
  normalizeBaleWorkspacePath,
  BALE_WORKSPACE_KEY_MAX_LENGTH,
  type BaleWorkspaceBindingIdentity,
} from "./workspace-identity.ts";
import {
  planBaleWorkspaceSlotAllocation,
  selectBaleWorkspaceReusableSlot,
  BALE_WORKSPACE_SLOTS,
  BaleWorkspaceSlotUnavailableError,
  type BaleWorkspaceSlotOccupancy,
} from "./workspace-slots.ts";
export {
  createBaleWorkspaceBindingIdentity,
  createBaleWorkspaceDirectoryKey,
  normalizeBaleSessionId,
  normalizeBaleWorkspacePath,
  type BaleWorkspaceBindingIdentity,
} from "./workspace-identity.ts";

export type BaleTopicTargetStatus =
  | "active"
  | "offline"
  | "stale"
  | "pending"
  | "starting"
  | "probe-required"
  | "failed";

export type BaleTopicSyncStatus = "open" | "closed" | "deleted" | "unknown";

export type BaleThreadOwner =
  | {
      kind: "leader";
      cwd?: string;
      instanceId?: string;
      baleProfile?: string;
    }
  | { kind: "manual-follower"; instanceId: string; baleProfile?: string }
  | { kind: "pending-topic"; chatId: number; threadId: number }
  | { kind: "legacy"; key: string };

const BALE_THREAD_RESERVATION_TTL_MS = 15 * 60 * 1000;

export interface BaleThreadReservation {
  target: BaleTarget & { threadId: number };
  slot: string;
  reason: string;
  createdAtMs: number;
  updatedAtMs: number;
  expiresAtMs?: number;
  instanceId?: string;
  lastReconcileAction?: string;
}

export interface BaleThreadPendingProvision {
  id: string;
  owner: "leader" | "manual-follower";
  instanceId: string;
  profileKey?: string;
  workspaceBindingKey?: string;
  status?: "in-flight" | "ambiguous";
  threadName?: string;
  displayTitle?: string;
  slot?: string;
  target?: BaleTarget & { threadId: number };
  startedAtMs: number;
  expiresAtMs?: number;
  leaderEpoch?: number | string;
}

export type BaleThreadCleanupIntent =
  ThreadReconciler.BaleThreadCleanupIntent;

export type BaleProvisionRecoveryFile = Record<
  string,
  {
    instanceId: string;
    profileKey?: string;
    leaderEpoch?: number | string;
    target: BaleTarget & { threadId: number };
  }
>;

export interface BaleTopicSyncObservation {
  target: BaleTarget & { threadId: number };
  syncStatus: BaleTopicSyncStatus;
  observedAtMs: number;
  instanceId?: string;
  slot?: string;
  lastSyncError?: string;
  lastReconcileAction?: string;
}

export interface BaleTopicTargetRecord {
  /** Legacy string key derived from `owner`; always present in memory, never persisted. */
  profileKey: string;
  owner?: BaleThreadOwner;
  target: BaleTarget & { threadId: number };
  status: BaleTopicTargetStatus;
  createdAtMs: number;
  updatedAtMs: number;
  threadName?: string;
  /** Explicit per-Workspace display override set by the operator. */
  manualThreadName?: string;
  instanceId?: string;
  slot?: string;
  lastError?: string;
  syncStatus?: BaleTopicSyncStatus;
  lastSyncObservedAtMs?: number;
  lastSyncProbeAtMs?: number;
  lastSyncError?: string;
  lastReconcileAction?: string;
  rerouteConfirmedAtMs?: number;
}

export interface BaleThreadIdentityRecord {
  profileKey: string;
  threadName?: string;
  slot?: string;
  updatedAtMs: number;
}

export interface BaleWorkspaceJournalSource {
  sessionId: string;
  recipientBindingKey: string;
}

export interface BaleWorkspaceThreadBinding {
  cwd: string;
  workspaceKey: string;
  /** Exact durable Pi session identity; absent only on legacy cwd-only bindings. */
  sessionId?: string;
  /** Full SHA-256 index component for session-qualified bindings. */
  sessionKey?: string;
  instanceSlot: string;
  bindingKey: string;
  target: BaleTarget & { threadId: number };
  /** Stable generated identity retained for compatibility and recovery. */
  threadName?: string;
  /** Explicit display override; absence selects the profile's automatic mode. */
  manualThreadName?: string;
  slot?: string;
  /** Last title acknowledged by Bale; never replaces the stable name. */
  displayTitle?: string;
  /** Historical follower-journal routing keys that may retain accepted work. */
  journalBindingKeys?: string[];
  /** Exact session-qualified journal addresses; retained across session re-key. */
  journalSources?: BaleWorkspaceJournalSource[];
  /** True only when the historical journal-key set is proven complete. */
  journalBindingsComplete?: true;
  /** Sticky once this directory has multiple retained bindings. */
  showSlotSuffix?: boolean;
  /** First continuously proven no-owner transition; absent means active or unproven. */
  inactiveSinceMs?: number;
  updatedAtMs: number;
}

export type BaleWorkspaceDisplayBinding = Pick<
  BaleWorkspaceThreadBinding,
  | "bindingKey"
  | "cwd"
  | "slot"
  | "threadName"
  | "manualThreadName"
  | "showSlotSuffix"
>;

export interface BaleWorkspaceRetirementIntent {
  id: string;
  reason: "pressure";
  profileKey: string;
  binding: BaleWorkspaceThreadBinding;
  leaderEpoch: number | string;
  requestedAtMs: number;
}

export type BaleWorkspaceProtectionState =
  "clear" | "protected" | "unknown";

export interface BaleWorkspaceExternalProtectionEvidence {
  liveOwner: BaleWorkspaceProtectionState;
  acceptedWork: BaleWorkspaceProtectionState;
  deliveryAuthority: BaleWorkspaceProtectionState;
}

/** Per-binding probe; `withSnapshot` lets one occupancy capture share binding-independent evidence reads. */
export type BaleWorkspaceExternalProtectionCapture = ((
  binding: BaleWorkspaceThreadBinding,
) => BaleWorkspaceExternalProtectionEvidence) & {
  withSnapshot?: <T>(capture: () => T) => T;
};

export interface BaleWorkspaceSlotOccupancySnapshot {
  bindings: BaleWorkspaceSlotOccupancy[];
  reservedSlots: string[];
}

export type BaleBotThreadMode = "unknown" | "enabled" | "disabled";

export interface BaleBotStateSnapshot {
  threadMode: BaleBotThreadMode;
  updatedAtMs?: number;
  lastSlot?: string;
  lastReconcileAction?: string;
}

export interface BaleWorkspaceRelocationRequest {
  operationId: string;
  binding: BaleWorkspaceThreadBinding;
  owner: BaleTopicTargetRecord;
  target: BaleTarget & { threadId: number };
}

export interface BaleWorkspaceRestoreRequest extends BaleWorkspaceRelocationRequest {
  source: { journalBindingKey: string; updateIds: number[] };
}
export interface BaleWorkspaceRestoreExecutor {
  instanceId: string;
  leaderEpoch: string;
}
export interface BaleWorkspaceRestoreAuthority {
  executor: BaleWorkspaceRestoreExecutor;
  operatorUserId: number;
  /** Exact profile, transport, session, source and Workspace-admission authority. */
  isCurrent: () => boolean;
}
export type BaleWorkspaceRestoreRecipient = {
  kind: "leader" | "follower";
  instanceId: string;
  sessionId: string;
  generation: string;
};
/** Retained queue admission is nonterminal; queue-completed requires positive journal-owner disposition. */
export type BaleWorkspaceRestoreSourceSettlement = {
  journalBindingKey: string;
  updateIds: number[];
} & (
  | { kind: "completed" }
  | {
      kind: "queued" | "queue-completed";
      receiptId: string;
      queueKind: "prompt" | "control";
    }
);
/** Positive execution/recipient acceptance, retained before source disposition; never a source-removal ACK. */
export type BaleWorkspaceRestoreSourceAcceptance = {
  journalBindingKey: string;
  updateId: number;
  /** SHA-256 of the exact journal entry captured by its worker owner, not a routed message projection. */
  sourceSha256: string;
  recipient: BaleWorkspaceRestoreRecipient;
} & (
  | { kind: "completed" }
  | { kind: "forwarded"; deliveryId: string; recipientBindingKey: string }
  | {
      kind: "queued";
      receiptId: string;
      queueKind: "prompt" | "control";
      queueOwnerSha256: string;
    }
);
export interface BaleWorkspaceRestoreIntent {
  request: BaleWorkspaceRestoreRequest;
  operatorUserId: number;
  executor: BaleWorkspaceRestoreExecutor;
  revision: number;
  createdAtMs: number;
  updatedAtMs: number;
  phase: "relocated" | "recipient-issued" | "ready";
  committedAtMs: number;
  recipient?: BaleWorkspaceRestoreRecipient;
  readyRecipient?: BaleWorkspaceRestoreRecipient;
  routing?: {
    acceptances?: BaleWorkspaceRestoreSourceAcceptance[];
    settlements: BaleWorkspaceRestoreSourceSettlement[];
    cleanup?: "issued" | "completed" | "not-issued";
  };
}
/** Live same-session metadata, never a legacy scoped ACK or permission to dispatch/delete. */
export type BaleWorkspaceLiveRebindIntent = Pick<
  BaleWorkspaceRestoreIntent,
  | "request"
  | "operatorUserId"
  | "executor"
  | "revision"
  | "createdAtMs"
  | "updatedAtMs"
> & {
  kind: "live-rebind";
  /** Versioned native input gate: terminal cleanup does not itself authorize or settle input. */
  inputRelease?: "held" | "issued" | "accepted";
  /** A session-replacing producer must not drop earlier old-target protection or carry its delete grant forward. */
  oldTargetProtected?: true;
  recipient: BaleWorkspaceRestoreRecipient;
} & (
    | { phase: "rebound"; cleanup?: never }
    | { phase: "released"; cleanup?: "issued" }
    | {
        phase: "finished";
        cleanup: "confirmed" | "failed" | "unknown" | "not-issued";
      }
  );
/** Immutable source membership, not readiness, cancellation, or proof of complete Thread coverage. */
export interface BaleTemporaryThreadInput {
  journalBindingKey: string;
  updateIds: number[];
}
/** Journal-owned donor discard evidence: retained manual cancellation or body-free chooser expiry, never recipient cancellation. */
export interface BaleTemporaryThreadCancellationEvidence {
  journalBindingKey: string;
  updateId: number;
  operatorAuthorityId: string;
}
/** A bot-created routing tab with an exact creation source; it owns no Pi binding or slot. */
export interface BaleTemporaryThreadEntry {
  source: { journalBindingKey: string; updateId: number };
  /** Append-only known source groups. Missing legacy metadata never proves that the creation source was alone. */
  inputs?: BaleTemporaryThreadInput[];
  /** Whole known groups with positively observed donor cancellation or expiry; never recipient cancellation or deletion authority. */
  cancelledInputs?: BaleTemporaryThreadInput[];
  /** Whole known groups whose Forward was positively completed by the journal owner; never deletion authority alone. */
  completedInputs?: BaleTemporaryThreadInput[];
  /** Whole known groups whose Forward was durably issued before local handling/queueing or follower RPC; never delivery proof or a retry grant. */
  forwardedInputs?: BaleTemporaryThreadInput[];
  /** Published at creation only: every subsequent Forward path must record issuance; missing legacy coverage stays unknown. */
  forwardProtocol?: "one-shot-v1";
  /** Published before the sole cleanup attempt; uncertainty survives executor adoption and restart. */
  cleanupIssued?: true;
  operatorUserId: number;
  executor: BaleWorkspaceRestoreExecutor;
  /** Unique title token; the only identity an unacknowledged creation may later be matched by. */
  token: string;
  /** `creating` is published before the one creation request, so after a crash its outcome is unknown. */
  phase: "creating" | "created";
  target?: BaleTarget & { threadId: number };
  revision: number;
  createdAtMs: number;
  updatedAtMs: number;
}
/** Canonical target classification only; a bound target still needs live same-session readiness proof. */
export type BaleTemporaryThreadTargetObservation =
  | { kind: "bound"; binding: BaleWorkspaceThreadBinding }
  | { kind: "temporary" }
  | { kind: "unknown" };
interface BaleWorkspaceRestoreSnapshot {
  version: 1;
  profileName: string;
  tokenSha256: string;
  revision: number;
  operations: BaleWorkspaceRestoreIntent[];
  liveRebindings?: BaleWorkspaceLiveRebindIntent[];
  temporaryThreads?: BaleTemporaryThreadEntry[];
}
/** Scope-bound Workspace operations; raw snapshot mutation is private to the store. */
export interface BaleWorkspaceRestore {
  list(): BaleWorkspaceRestoreIntent[];
  listLiveRebindings(): BaleWorkspaceLiveRebindIntent[];
  /** Caller has saved and held the selected input; this publishes the binding, not dispatch readiness. */
  commitLiveRebind(
    request: BaleWorkspaceRestoreRequest,
    recipient: BaleWorkspaceRestoreRecipient,
    authority: BaleWorkspaceRestoreAuthority,
    options?: { holdInput: true },
  ): Promise<BaleWorkspaceLiveRebindIntent | undefined>;
  /** Caller proves local apply for release or current live clearance for cleanup; unknown issuance never repeats. */
  advanceLiveRebind(
    expected: BaleWorkspaceLiveRebindIntent,
    step:
      | "release"
      | "issue-cleanup"
      | "issue-input"
      | "accept-input"
      | "protect-old-target"
      | Extract<
          BaleWorkspaceLiveRebindIntent,
          { phase: "finished" }
        >["cleanup"],
    authority: BaleWorkspaceRestoreAuthority,
  ): BaleWorkspaceLiveRebindIntent | undefined;
  commit(
    request: BaleWorkspaceRestoreRequest,
    authority: BaleWorkspaceRestoreAuthority,
  ): Promise<BaleWorkspaceRestoreIntent | undefined>;
  adopt(
    expected: BaleWorkspaceRestoreIntent,
    authority: BaleWorkspaceRestoreAuthority,
  ): BaleWorkspaceRestoreIntent | undefined;
  issueRecipient(
    expected: BaleWorkspaceRestoreIntent,
    recipient: BaleWorkspaceRestoreRecipient,
    authority: BaleWorkspaceRestoreAuthority,
  ): { issued: true; intent: BaleWorkspaceRestoreIntent } | undefined;
  confirmReady(
    expected: BaleWorkspaceRestoreIntent,
    acknowledged: BaleWorkspaceRestoreRecipient,
    authority: BaleWorkspaceRestoreAuthority,
  ): BaleWorkspaceRestoreIntent | undefined;
  confirmInspectedReady(
    expected: BaleWorkspaceRestoreIntent,
    observed: BaleWorkspaceRestoreRecipient,
    authority: BaleWorkspaceRestoreAuthority,
  ): BaleWorkspaceRestoreIntent | undefined;
  issueRouting(
    expected: BaleWorkspaceRestoreIntent,
    authority: BaleWorkspaceRestoreAuthority,
  ): { issued: true; intent: BaleWorkspaceRestoreIntent } | undefined;
  recordSourceAcceptance(
    expected: BaleWorkspaceRestoreIntent,
    evidence: BaleWorkspaceRestoreSourceAcceptance,
    authority: BaleWorkspaceRestoreAuthority,
  ): BaleWorkspaceRestoreIntent | undefined;
  recordSourceSettlement(
    expected: BaleWorkspaceRestoreIntent,
    evidence: BaleWorkspaceRestoreSourceSettlement,
    authority: BaleWorkspaceRestoreAuthority,
  ): BaleWorkspaceRestoreIntent | undefined;
  issueCleanup(
    expected: BaleWorkspaceRestoreIntent,
    authority: BaleWorkspaceRestoreAuthority,
  ): { issued: true; intent: BaleWorkspaceRestoreIntent } | undefined;
  recordCleanup(
    expected: BaleWorkspaceRestoreIntent,
    result: {
      target: BaleWorkspaceRestoreRequest["target"];
      kind: "completed" | "not-issued";
    },
    authority: BaleWorkspaceRestoreAuthority,
  ): BaleWorkspaceRestoreIntent | undefined;
  retire(
    expected: BaleWorkspaceRestoreIntent,
    authority: BaleWorkspaceRestoreAuthority,
  ): BaleWorkspaceRestoreIntent | undefined;
  /** Caller proves exact operator abandonment of every original; no dispatch grant may exist. */
  retireAbandoned(
    expected: BaleWorkspaceRestoreIntent,
    abandonedUpdateIds: readonly number[],
    authority: BaleWorkspaceRestoreAuthority,
  ): BaleWorkspaceRestoreIntent | undefined;
  listTemporaryThreads(): BaleTemporaryThreadEntry[];
  /** Caller holds admission for effectful use. Fresh exact read grants no adoption, routing, disposition or deletion. */
  inspectTemporaryThreadTarget(
    expected: BaleTemporaryThreadEntry,
    authority: BaleWorkspaceRestoreAuthority,
  ): BaleTemporaryThreadTargetObservation | undefined;
  /** Read-only veto for an already-granted in-flight attempt; never another grant, disposable classification or deletion ACK. */
  isTemporaryThreadCleanupCurrent(
    expected: BaleTemporaryThreadEntry,
    authority: BaleWorkspaceRestoreAuthority,
  ): boolean;
  /**
   * Publishes `creating` before the caller's single creation request; an existing source entry is returned, never
   * recreated. `group` records an album as the tab's one creating input; it must start at the source update.
   */
  reserveTemporaryThread(
    source: BaleTemporaryThreadEntry["source"],
    token: string,
    authority: BaleWorkspaceRestoreAuthority,
    group?: BaleTemporaryThreadInput,
  ): { reserved: boolean; entry: BaleTemporaryThreadEntry } | undefined;
  /** Caller proves a fresh owner-authenticated implicit Bale creation and exact live source under profile admission.
   * Registers that observed unbound target without issuing or fabricating a Bot API creation. */
  registerImplicitTemporaryThread(
    input: BaleTemporaryThreadInput,
    target: BaleTarget & { threadId: number },
    token: string,
    authority: BaleWorkspaceRestoreAuthority,
  ): BaleTemporaryThreadEntry | undefined;
  /** Records the exact acknowledged creation target; it never reopens a created entry. */
  acknowledgeTemporaryThread(
    expected: BaleTemporaryThreadEntry,
    target: BaleTarget & { threadId: number },
    authority: BaleWorkspaceRestoreAuthority,
  ): BaleTemporaryThreadEntry | undefined;
  adoptTemporaryThread(
    expected: BaleTemporaryThreadEntry,
    authority: BaleWorkspaceRestoreAuthority,
  ): BaleTemporaryThreadEntry | undefined;
  /** Caller supplies exact live source/group authority; duplicate membership is read-only, never a new dispatch grant. */
  recordTemporaryThreadInput(
    expected: BaleTemporaryThreadEntry,
    input: BaleTemporaryThreadInput,
    authority: BaleWorkspaceRestoreAuthority,
  ): BaleTemporaryThreadEntry | undefined;
  /** Records a positively completed Forward group; the caller proves every source of the group completed. */
  /** Publishes the one-time Forward issuance fact before any RPC; a duplicate, cancelled, completed or Restore-owned group is refused. */
  recordTemporaryThreadForwardIssued(
    expected: BaleTemporaryThreadEntry,
    input: BaleTemporaryThreadInput,
    authority: BaleWorkspaceRestoreAuthority,
  ): BaleTemporaryThreadEntry | undefined;
  recordTemporaryThreadInputCompletion(
    expected: BaleTemporaryThreadEntry,
    input: BaleTemporaryThreadInput,
    authority: BaleWorkspaceRestoreAuthority,
  ): BaleTemporaryThreadEntry | undefined;
  recordTemporaryThreadInputCancellation(
    expected: BaleTemporaryThreadEntry,
    input: BaleTemporaryThreadInput,
    authority: BaleWorkspaceRestoreAuthority,
    inspect: (
      updateId: number,
    ) => BaleTemporaryThreadCancellationEvidence | undefined,
  ): BaleTemporaryThreadEntry | undefined;
  /** Body-free chooser expiry may terminate an uncertain donor Forward/Restore, never accepted recipient work or a bound target. */
  recordTemporaryThreadInputExpiry(
    expected: BaleTemporaryThreadEntry,
    input: BaleTemporaryThreadInput,
    authority: BaleWorkspaceRestoreAuthority,
    inspect: (
      updateId: number,
    ) => BaleTemporaryThreadCancellationEvidence | undefined,
  ): BaleTemporaryThreadEntry | undefined;
  /** Caller holds profile admission and proves fresh source/protection clearance; publication grants one attempt, never retry. */
  issueTemporaryThreadCleanup(
    expected: BaleTemporaryThreadEntry,
    authority: BaleWorkspaceRestoreAuthority,
  ): { issued: true; entry: BaleTemporaryThreadEntry } | undefined;
  /** Caller proves source settlement or cancellation and target disposition; this releases protection only. */
  /** `completed` names one newly completed group; every other known group must already be cancelled or completed. */
  retireTemporaryThread(
    expected: BaleTemporaryThreadEntry,
    authority: BaleWorkspaceRestoreAuthority,
    completed?: BaleTemporaryThreadInput,
  ): BaleTemporaryThreadEntry | undefined;
  /** New-world restart: atomically forgets this operator's Restore intents and temporary entries from previous runtime instances.
   * Caller may preserve exact unbound temporary tokens for clock-bearing sources. Committed bindings stay; nothing is rolled back, replayed or deleted here. */
  forgetPreviousWorld(
    authority: BaleWorkspaceRestoreAuthority,
    preserveTemporaryTokens?: readonly string[],
  ):
    | {
        operations: BaleWorkspaceRestoreIntent[];
        temporaryThreads: BaleTemporaryThreadEntry[];
        liveRebindings?: BaleWorkspaceLiveRebindIntent[];
      }
    | undefined;
}
export interface BaleWorkspaceRestoreOptions {
  profileName: string;
  tokenSha256: string;
  isCurrentScope?: () => boolean;
  maxBytes?: number;
  getNowMs?: () => number;
  legacyPath?: string;
  onPublicationBoundary?: (
    boundary: "after-write-before-rename" | "after-rename",
  ) => void;
}

export interface BaleSessionReplacementIntent {
  continuity: "workspace-thread" | "classic-chat";
  cwd: string;
  profileName: string;
  sourceSessionId: string;
  sourceUpdateId: number;
  target: BaleTarget;
  messageId: number;
  slot?: string;
  threadName?: string;
  createdAtMs: number;
  expiresAtMs: number;
  /**
   * Present only when the leader published the intent for a registered
   * follower. Successor re-key and settlement must come from this exact
   * follower runtime or its authenticated same-process session handoff.
   */
  sourceInstanceId?: string;
}

export interface BaleTopicTargetFile {
  version: 1;
  source: "snapshot";
  writtenAtMs: number;
  bot: BaleBotStateSnapshot;
  threads: BaleTopicTargetRecord[];
  identities?: BaleThreadIdentityRecord[];
  workspaceBindings?: BaleWorkspaceThreadBinding[];
  workspaceRetirements?: BaleWorkspaceRetirementIntent[];
  workspaceRestore?: BaleWorkspaceRestoreSnapshot;
  sessionReplacement?: BaleSessionReplacementIntent;
  reservations?: BaleThreadReservation[];
  pendingProvisions?: BaleThreadPendingProvision[];
  pendingCleanups?: BaleThreadCleanupIntent[];
  syncObservations?: BaleTopicSyncObservation[];
}

function getNextMonotonicSlot(
  records: Map<string, BaleTopicTargetRecord>,
  reservations: readonly BaleThreadReservation[],
  pendingProvisions: readonly BaleThreadPendingProvision[],
  nowMs: number,
  lastSlot?: string,
): string | undefined {
  let cursorCode: number | undefined;
  if (lastSlot && /^[A-Z]$/.test(lastSlot)) {
    cursorCode = lastSlot.charCodeAt(0);
  } else {
    cursorCode = "A".charCodeAt(0) - 1;
    for (const record of records.values()) {
      if (!record.slot || !ThreadReconciler.isCurrentThreadRecord(record))
        continue;
      cursorCode = Math.max(cursorCode, record.slot.charCodeAt(0));
    }
    for (const reservation of reservations) {
      if (
        reservation.expiresAtMs !== undefined &&
        reservation.expiresAtMs <= nowMs
      )
        continue;
      if (!reservation.slot) continue;
      cursorCode = Math.max(cursorCode, reservation.slot.charCodeAt(0));
    }
    for (const provision of pendingProvisions) {
      if (
        provision.status !== "ambiguous" &&
        provision.expiresAtMs !== undefined &&
        provision.expiresAtMs <= nowMs
      )
        continue;
      if (!provision.slot) continue;
      cursorCode = Math.max(cursorCode, provision.slot.charCodeAt(0));
    }
  }
  let code = cursorCode + 1;
  if (code > "Z".charCodeAt(0)) code = "A".charCodeAt(0);
  for (let attempt = 0; attempt < 26; attempt++) {
    const candidate = String.fromCharCode(code);
    if (
      !isBaleTopicTargetSlotOccupied(
        candidate,
        records,
        reservations,
        pendingProvisions,
        nowMs,
      )
    ) {
      return candidate;
    }
    code += 1;
    if (code > "Z".charCodeAt(0)) code = "A".charCodeAt(0);
  }
  return undefined;
}

export interface BaleTopicTargetStore {
  load: () => Promise<void>;
  /** Discard process-local projections and reload owner-published state. */
  refresh?: () => Promise<void>;
  /** Optional caller fence supplements, never replaces, captured publication authority. */
  persist: (isCurrent?: () => boolean) => Promise<void>;
  invalidateTarget: (
    target: BaleTarget,
    isCurrent: () => boolean,
    lastSyncError: string,
  ) => Promise<boolean>;
  /** Caller proves owner detachment; this does not assert Bale Thread absence. */
  detachTargetOwner: (
    expected: BaleTopicTargetRecord,
    isCurrent: () => boolean,
  ) => Promise<boolean>;
  /** Caller holds Workspace admission; publication uses this store's exact transport-owner fence. */
  workspaceRestore: (
    options: BaleWorkspaceRestoreOptions,
  ) => BaleWorkspaceRestore;
  /** Read-only precondition under caller-owned admission; not registration or transport authority. */
  assertWorkspaceRestoreRegistration: (candidate: {
    target: BaleTarget;
    bindingKey?: string;
    slot?: string;
  }) => void;
  /** Runs synchronous live publication under the same evidence transaction; caller retains authentication/admission. */
  commitWorkspaceRestoreRegistration: (
    candidate: Parameters<
      BaleTopicTargetStore["assertWorkspaceRestoreRegistration"]
    >[0],
    publish: () => void,
  ) => void;
  /** Read-only canonical observation; the callback must finish synchronously under the snapshot transaction. */
  withWorkspaceRestoreSnapshot: (
    expected:
      BaleWorkspaceRestoreIntent | BaleWorkspaceLiveRebindIntent,
    observe: (
      snapshot: Readonly<
        Pick<BaleTopicTargetFile, "threads" | "workspaceBindings">
      >,
    ) => undefined,
  ) => void;
  /** Exact synchronous live-operation snapshot, including a current publication frame; no mutation, lock or authority grant. */
  withWorkspaceLiveRebindSnapshot: (
    expected: BaleWorkspaceLiveRebindIntent,
    observe: (
      snapshot: Readonly<
        Pick<BaleTopicTargetFile, "threads" | "workspaceBindings">
      >,
    ) => undefined,
  ) => void;
  /** Current live-origin ownership veto; effect callers still require Workspace admission. False is not work/recipient/deletion authority. */
  hasPreDispatchRebindEvidence: () => boolean;
  listProtectedLiveRebindTargets: () => BaleTarget[];
  isWorkspaceLiveRebindCleanupTargetProtected: (
    expected: BaleWorkspaceLiveRebindIntent,
  ) => boolean;
  /** Read-only captured identity with an optional exact manual-name result fence; no transport/session/admission grant or lock. */
  captureWorkspaceThreadRenameObservation: (
    binding: BaleWorkspaceThreadBinding,
    owner: BaleTopicTargetRecord,
  ) => (expectedManualThreadName?: string) => boolean;
  /** Captured read-only identity and exact absent-manual-name/automatic-title result fences; no authority grant or lock. */
  captureWorkspaceThreadResetObservation: (
    binding: BaleWorkspaceThreadBinding,
    owner: BaleTopicTargetRecord,
  ) => {
    isCurrent: () => boolean;
    isResultCurrent: (automaticTitle: string) => boolean;
  };
  /** Fresh strict disk read of acknowledged temporary-tab targets; throws rather than guessing absence. */
  listTemporaryThreadTargets: () => BaleTarget[];
  list: () => BaleTopicTargetRecord[];
  getFollowerRecoveryHintByTarget?: (
    target: BaleTarget,
  ) => { slot?: string; threadName?: string } | undefined;
  listReservations: () => BaleThreadReservation[];
  listPendingProvisions: () => BaleThreadPendingProvision[];
  resetPendingProvisionForConnect: (expected: BaleThreadPendingProvision, isCurrent: () => boolean) => Promise<boolean>;
  listPendingCleanups: () => BaleThreadCleanupIntent[];
  listSyncObservations: () => BaleTopicSyncObservation[];
  reserveThread: (reservation: BaleThreadReservation) => void;
  upsertPendingProvision: (provision: BaleThreadPendingProvision) => void;
  recordPendingProvisionTargetRecovery: (
    provision: BaleThreadPendingProvision,
    target: BaleTarget & { threadId: number },
  ) => Promise<boolean>;
  removePendingProvision: (id: string) => boolean;
  upsertPendingCleanup: (intent: BaleThreadCleanupIntent) => void;
  removePendingCleanup: (id: string) => boolean;
  getBotState: () => BaleBotStateSnapshot;
  setBotState: (state: Partial<BaleBotStateSnapshot>) => void;
  setStatusSnapshot: (snapshot: {
    runtime?: Record<string, unknown>;
    liveRoster?: Record<string, unknown>;
    diagnostics?: Record<string, unknown>;
  }) => void;
  /** Writes the non-canonical status projection to its own file; it never touches canonical state or grants authority. */
  persistStatus: () => Promise<void>;
  getByProfileKey: (
    profileKey: string,
  ) => BaleTopicTargetRecord | undefined;
  getActiveByInstanceId: (
    instanceId: string,
  ) => BaleTopicTargetRecord | undefined;
  getIdentityByProfileKey: (
    profileKey: string,
  ) => BaleThreadIdentityRecord | undefined;
  forgetIdentityByProfileKey: (profileKey: string) => boolean;
  listWorkspaceBindings: () => BaleWorkspaceThreadBinding[];
  getWorkspaceBindingByTarget: (
    target: BaleTarget,
    sessionId?: string,
  ) => BaleWorkspaceThreadBinding | undefined;
  getSessionReplacementIntent: () =>
    BaleSessionReplacementIntent | undefined;
  commitSessionReplacementIntent: (
    intent: BaleSessionReplacementIntent,
    isCurrent: () => boolean,
  ) => Promise<boolean>;
  removeSessionReplacementIntent: (
    expected: BaleSessionReplacementIntent,
    isCurrent: () => boolean,
  ) => Promise<boolean>;
  listWorkspaceRetirementIntents: () => BaleWorkspaceRetirementIntent[];
  /** Metadata subset CAS only: callers prove exact-source/writer evidence; independent snapshot roots are untouched. */
  commitWorkspaceJournalEvidence: (
    expected: BaleWorkspaceThreadBinding,
    journalBindingKeys: readonly string[],
    complete: boolean,
    journalSources?: readonly BaleWorkspaceJournalSource[],
  ) => BaleWorkspaceThreadBinding | undefined;
  /** Acknowledge publication of the exact current metadata frame; never roll it back after an uncertain write. */
  persistWorkspaceJournalEvidence: (
    expected: BaleWorkspaceThreadBinding,
    isCurrent: () => boolean,
  ) => Promise<boolean>;
  upsertWorkspaceRetirementIntent: (
    intent: BaleWorkspaceRetirementIntent,
  ) => boolean;
  removeWorkspaceRetirementIntent: (
    expected: BaleWorkspaceRetirementIntent,
  ) => boolean;
  replaceWorkspaceRetirementIntent: (
    expected: BaleWorkspaceRetirementIntent,
    replacement: BaleWorkspaceRetirementIntent,
    isCurrent: () => boolean,
  ) => Promise<boolean>;
  commitWorkspaceRetirement: (
    expected: BaleWorkspaceRetirementIntent,
    isCurrent: () => boolean,
  ) => Promise<boolean>;
  commitInactiveWorkspaceCleanup: (
    expected:
      | BaleWorkspaceThreadBinding
      | {
          cwd: string;
          workspaceKey: string;
          sessionId?: string;
          sessionKey?: string;
          instanceSlot: string;
          slot: string | null;
          bindingKey: string;
          target: { chatId: number; threadId: number };
          inactiveSinceMs: number;
          bindingUpdatedAtMs: number;
        },
    isCurrent: () => boolean,
  ) => Promise<boolean>;
  /** Caller must separately prove no external live owner, accepted work, or delivery authority. */
  captureWorkspaceSlotOccupancy: (
    getExternalProtection: BaleWorkspaceExternalProtectionCapture,
    options?: { expectedRetirement?: BaleWorkspaceRetirementIntent },
  ) => BaleWorkspaceSlotOccupancySnapshot;
  /**
   * Fallback for a full A-Z pool: strips the display letter from the least recently used
   * binding (and its current Thread record) and persists, so a fresh allocation can take it.
   * Metadata only: the Thread, journals and accepted work stay untouched, and a binding or
   * letter held by a claim, reservation, provision, cleanup or retirement is never chosen.
   */
  reuseLeastRecentlyUsedWorkspaceSlot: (
    isCurrent: () => boolean,
  ) => Promise<
    | { kind: "free" }
    | { kind: "reused"; bindingKey: string; slot: string }
    | undefined
  >;
  hasWorkspaceBinding: (cwd: string, sessionId?: string) => boolean;
  setWorkspaceDisplayTitle: (
    expected: BaleWorkspaceThreadBinding,
    title: string,
  ) => boolean;
  markWorkspaceBindingInactiveByTarget: (
    target: BaleTarget,
    inactiveSinceMs?: number,
  ) => boolean;
  markWorkspaceBindingActiveByTarget: (target: BaleTarget) => boolean;
  getWorkspaceBinding: (
    cwd: string,
    instanceSlot?: string,
    sessionId?: string,
  ) => BaleWorkspaceThreadBinding | undefined;
  claimWorkspaceIdentity: (
    cwd: string,
    instanceId: string,
    previousInstanceId?: string,
    options?: {
      existingBindingOnly?: boolean;
      sessionId?: string;
      provisionProfileKey?: string;
      /** Explicit same-process session handoff from `previousInstanceId`; never inferred. */
      sessionHandoff?: boolean;
      onCapacityUnavailable?: () => void;
    },
  ) => BaleWorkspaceBindingIdentity | undefined;
  /**
   * Re-keys one retained Thread binding from a retired session to its successor at the same slot and target,
   * so the tab keeps a single owner. Fails without mutation when the source binding or slot identity is absent.
   */
  adoptWorkspaceThreadBindingForSession: (
    cwd: string,
    sourceSessionId: string,
    sessionId: string,
    target: BaleTarget,
  ) => boolean;
  releaseWorkspaceClaim: (instanceId: string) => boolean;
  upsertWorkspaceBinding: (
    binding: BaleWorkspaceThreadBinding,
    claimInstanceId?: string,
  ) => BaleWorkspaceThreadBinding | undefined;
  upsert: (record: BaleTopicTargetRecord) => BaleTopicTargetRecord;
  markOfflineByInstanceId: (instanceId: string) => number;
  markStaleByTarget: (
    target: BaleTarget,
    syncStatus?: BaleTopicSyncStatus,
    lastSyncError?: string,
  ) => boolean;
  markActiveByTarget: (target: BaleTarget) => boolean;
  renameByTarget: (
    target: BaleTarget,
    threadName: string,
    options?: { updateDisplayTitle: boolean },
  ) => BaleTopicTargetRecord | undefined;
  /** Publish a manual-name candidate without first retaining it in the dirty local projection. */
  renameByTargetAndPersist: (
    target: BaleTarget,
    threadName: string,
    options: { updateDisplayTitle: boolean },
    isCurrent: () => boolean,
  ) => Promise<BaleTopicTargetRecord | undefined>;
  clearManualNameByTarget: (
    target: BaleTarget,
    automaticTitle: string,
  ) => BaleTopicTargetRecord | undefined;
  /** Stage exact manual-name removal and automatic display metadata in the existing publication candidate. */
  clearManualNameByTargetAndPersist: (
    target: BaleTarget,
    automaticTitle: string,
    isCurrent: () => boolean,
  ) => Promise<BaleTopicTargetRecord | undefined>;
  allocateSlot: (
    profileKey: string,
    preferredSlot?: string,
    workspaceBindingKey?: string,
    options?: { excludeCurrentRecord?: boolean },
  ) => string | undefined;
  /** Claim the first reusable inactive thread for an instance, linking it to instanceId. */
  claimReusableTarget: (
    instanceId: string,
    threadName?: string,
  ) => BaleTopicTargetRecord | undefined;
}

export function createBaleCleanupTargetProtection(
  store: Pick<BaleTopicTargetStore, "list"> &
    Partial<
      Pick<
        BaleTopicTargetStore,
        | "listReservations"
        | "listPendingProvisions"
        | "listPendingCleanups"
        | "listTemporaryThreadTargets"
        | "listProtectedLiveRebindTargets"
      >
    >,
  departingRecord?: BaleTopicTargetRecord,
): NonNullable<
  ThreadReconciler.ThreadReconciliationApplyPorts["isCleanupTargetProtected"]
> {
  const records = store.list();
  const reservations = store.listReservations?.() ?? [];
  const provisions = store.listPendingProvisions?.() ?? [];
  const intents = store.listPendingCleanups?.() ?? [];
  // Persistence may reconstruct keys in another order and omit undefined
  // optional fields; neither changes the authority represented by a snapshot.
  const sameSnapshot = (left: unknown, right: unknown): boolean =>
    isDeepStrictEqual(
      JSON.parse(JSON.stringify(left)),
      JSON.parse(JSON.stringify(right)),
    );
  return (target, action) => {
    try {
      if (store.listProtectedLiveRebindTargets?.().some(candidate => targetMatches(candidate, target))) return true;
    } catch { return true; }
    // A source-bound temporary tab is removed only by its own Forward/Cancel, never by generic reconciliation.
    if (store.listTemporaryThreadTargets) {
      try {
        if (
          store
            .listTemporaryThreadTargets()
            .some((candidate) => targetMatches(candidate, target))
        )
          return true;
      } catch {
        return true;
      }
    }
    for (const record of store.list()) {
      if (!targetMatches(record.target, target)) continue;
      // A persisted shutdown intent may retire only its original pre-intent
      // binding. Registration/rebinding after that intent supersedes it.
      const intent =
        action.kind === "close-delete-graceful-shutdown-topic"
          ? intents.find(
              (candidate) =>
                candidate.id === action.cleanupIntentId &&
                candidate.runtimeGeneration === action.runtimeGeneration,
            )
          : undefined;
      const expectedDeparting =
        departingRecord ??
        (intent &&
          records.find(
            (candidate) =>
              candidate.instanceId === intent.instanceId &&
              targetMatches(candidate.target, intent.target) &&
              candidate.updatedAtMs <= intent.requestedAtMs,
          ));
      if (
        expectedDeparting &&
        "instanceId" in action &&
        (action.kind === "close-delete-previous-leader-topic" ||
          action.instanceId === expectedDeparting.instanceId) &&
        sameSnapshot(record, expectedDeparting)
      ) {
        if (
          action.kind === "close-delete-previous-leader-topic" ||
          action.kind === "close-stale-replaced-topic"
        )
          continue;
        if (
          action.kind === "close-delete-graceful-shutdown-topic" &&
          store
            .listPendingCleanups?.()
            .some(
              (intent) =>
                intent.id === action.cleanupIntentId &&
                intent.instanceId === action.instanceId &&
                intent.runtimeGeneration === action.runtimeGeneration &&
                targetMatches(intent.target, target),
            )
        )
          continue;
      }
      if (
        record.status === "active" ||
        record.status === "starting" ||
        record.status === "pending" ||
        record.status === "probe-required"
      )
        return true;
    }
    for (const reservation of store.listReservations?.() ?? []) {
      if (!targetMatches(reservation.target, target)) continue;
      if (
        action.kind !== "close-delete-reserved-topic" ||
        !reservations.some((initial) => sameSnapshot(initial, reservation))
      )
        return true;
    }
    for (const provision of store.listPendingProvisions?.() ?? []) {
      if (!provision.target || !targetMatches(provision.target, target))
        continue;
      if (
        action.kind !== "close-delete-expired-pending-provision-topic" ||
        provision.id !== action.pendingProvisionId ||
        !provisions.some((initial) => sameSnapshot(initial, provision))
      )
        return true;
    }
    return false;
  };
}

export interface BaleTopicTargetStoreOptions {
  path: string | (() => string);
  baleProfile?: string | (() => string | undefined);
  getNowMs?: () => number;
  canPersist?: () => boolean;
  commitPersist?: (commit: () => void) => boolean;
  consolidated?: Pick<
    BaleConsolidatedWorkspaceStorageOptions,
    "captureAuthority" | "publishIfOwned"
  >;
  getExternalReservedSlots?: () => readonly string[];
}

export interface BaleTopicTargetProvisionerDeps {
  topicChatId: number;
  store: Pick<
    BaleTopicTargetStore,
    | "list"
    | "getByProfileKey"
    | "getActiveByInstanceId"
    | "getIdentityByProfileKey"
    | "forgetIdentityByProfileKey"
    | "upsert"
    | "markStaleByTarget"
    | "allocateSlot"
    | "claimReusableTarget"
    | "listWorkspaceBindings"
    | "listPendingProvisions"
    | "upsertPendingProvision"
    | "recordPendingProvisionTargetRecovery"
    | "removePendingProvision"
    | "listSyncObservations"
    | "listPendingCleanups"
    | "persist"
  >;
  callApi: <TResponse>(
    method: string,
    body: Record<string, unknown>,
    options?: BaleApiCallOptions,
  ) => Promise<TResponse>;
  topicNameTemplate?: string;
  resolveInitialWorkspaceDisplayTitle?: (
    binding: BaleWorkspaceDisplayBinding,
  ) => string | undefined;
  getNowMs?: () => number;
  getRandom?: () => number;
  getCurrentLeaderEpoch?: () => number | string | undefined;
  claimPendingTargets?: boolean;
}

export interface BaleTopicTargetRenamerDeps {
  store: Pick<
    BaleTopicTargetStore,
    "list" | "listWorkspaceBindings" | "listPendingProvisions"
  > & {
    renameByTarget: (
      ...args: Parameters<BaleTopicTargetStore["renameByTarget"]>
    ) =>
      | ReturnType<BaleTopicTargetStore["renameByTarget"]>
      | Promise<ReturnType<BaleTopicTargetStore["renameByTarget"]>>;
  };
  callApi: <TResponse>(
    method: string,
    body: Record<string, unknown>,
    options?: BaleApiCallOptions,
  ) => Promise<TResponse>;
  assertAuthority?: () => void;
  shouldRenameDisplayedTitle?: () => boolean;
  topicNameTemplate?: string;
}

export interface BaleTopicTargetProvisionRequest {
  instanceId: string;
  owner?: BaleThreadOwner;
  /** Legacy string key derived from `owner`; always present in memory. */
  profileKey: string;
  threadName?: string;
  preferredSlot?: string;
  workspaceBindingKey?: string;
  workspaceCwd?: string;
}

/** Pending creation evidence cannot bypass an exact target's unresolved cleanup or closure. */
export function assertBalePendingTopicRecoveryAllowed(
  store: Pick<
    BaleTopicTargetStore,
    "listPendingProvisions" | "listPendingCleanups" | "listSyncObservations"
  >,
  target: BaleTarget,
): void {
  if (
    !store
      .listPendingProvisions()
      .some((entry) => entry.target && targetMatches(entry.target, target))
  )
    return;
  if (
    store
      .listPendingCleanups()
      .some((entry) => targetMatches(entry.target, target)) ||
    store
      .listSyncObservations()
      .some(
        (entry) =>
          targetMatches(entry.target, target) && entry.syncStatus === "closed",
      )
  ) {
    throw new Error(
      "Bale pending topic requires reconciliation before recovery.",
    );
  }
}

/** Settle creation-title evidence with the exact Workspace claim; caller fences and persists. */
export function commitBaleWorkspaceProvisionBinding(input: {
  store: Pick<
    BaleTopicTargetStore,
    | "upsertWorkspaceBinding"
    | "setWorkspaceDisplayTitle"
    | "listPendingProvisions"
    | "removePendingProvision"
    | "listPendingCleanups"
    | "listSyncObservations"
  >;
  binding: BaleWorkspaceThreadBinding;
  instanceId: string;
  profileKey: string;
  displayTitle?: string;
}): BaleWorkspaceThreadBinding {
  assertBalePendingTopicRecoveryAllowed(input.store, input.binding.target);
  const pending = input.store
    .listPendingProvisions()
    .filter(
      (provision) =>
        provision.target &&
        targetMatches(provision.target, input.binding.target) &&
        provision.slot === input.binding.slot &&
        (provision.instanceId === input.instanceId ||
          provision.profileKey === input.profileKey),
    );
  const titles = new Set(
    pending
      .map((provision) => provision.displayTitle)
      .filter((title) => title !== undefined),
  );
  if (input.displayTitle !== undefined) titles.add(input.displayTitle);
  if (titles.size > 1)
    throw new Error("Bale Workspace creation title evidence conflicts.");
  const displayTitle = titles.values().next().value;
  const committed = input.store.upsertWorkspaceBinding(
    input.binding,
    input.instanceId,
  );
  if (!committed) throw new Error("Bale Workspace binding claim changed.");
  if (
    displayTitle !== undefined &&
    !input.store.setWorkspaceDisplayTitle(committed, displayTitle)
  ) {
    throw new Error("Bale Workspace display title commit changed binding.");
  }
  for (const provision of pending)
    input.store.removePendingProvision(provision.id);
  return displayTitle === undefined
    ? committed
    : { ...committed, displayTitle };
}

export interface BaleTopicTargetRenameRequest {
  target: BaleTarget & { threadId: number };
  threadName: string;
  slot?: string;
}

export interface BaleTopicTargetProvisionResult {
  target: BaleTarget & { threadId: number };
  reused: boolean;
  record: BaleTopicTargetRecord;
  displayTitle?: string;
}

interface BaleTopicResult {
  message_thread_id?: number;
}

const BALE_LEADER_SESSION_HANDOFF_KEY = "__piBaleLeaderSessionHandoff";
export const BALE_LEADER_SESSION_HANDOFF_TTL_MS = 30_000;

export interface BaleLeaderSessionHandoff {
  pid: number;
  instanceId: string;
  createdAtMs: number;
  profileKey: string;
  target: BaleTarget & { threadId: number };
  slot?: string;
  threadName?: string;
}

export function getBaleLeaderSessionHandoff():
  BaleLeaderSessionHandoff | undefined {
  const value = (globalThis as Record<string, unknown>)[
    BALE_LEADER_SESSION_HANDOFF_KEY
  ];
  if (!value || typeof value !== "object") return undefined;
  const handoff = value as Partial<BaleLeaderSessionHandoff>;
  if (
    typeof handoff.pid !== "number" ||
    typeof handoff.instanceId !== "string" ||
    typeof handoff.createdAtMs !== "number" ||
    typeof handoff.profileKey !== "string" ||
    typeof handoff.target?.chatId !== "number" ||
    typeof handoff.target.threadId !== "number"
  ) {
    return undefined;
  }
  return handoff as BaleLeaderSessionHandoff;
}

export function setBaleLeaderSessionHandoff(
  handoff: BaleLeaderSessionHandoff | undefined,
): void {
  const store = globalThis as Record<string, unknown>;
  if (!handoff) delete store[BALE_LEADER_SESSION_HANDOFF_KEY];
  else store[BALE_LEADER_SESSION_HANDOFF_KEY] = handoff;
}

function isBaleLeaderSessionHandoffFresh(
  handoff: BaleLeaderSessionHandoff | undefined,
  options: { pid?: number; nowMs?: number; ttlMs?: number } = {},
): handoff is BaleLeaderSessionHandoff {
  if (!handoff) return false;
  const pid = options.pid ?? process.pid;
  const nowMs = options.nowMs ?? Date.now();
  const ttlMs = options.ttlMs ?? BALE_LEADER_SESSION_HANDOFF_TTL_MS;
  return handoff.pid === pid && nowMs - handoff.createdAtMs <= ttlMs;
}

export function getBaleThreadOwnerKey(owner: BaleThreadOwner): string {
  switch (owner.kind) {
    case "leader": {
      const base = owner.cwd
        ? `cwd:${owner.cwd}`
        : `leader:${owner.instanceId ?? "default"}`;
      return owner.baleProfile
        ? `profile:${owner.baleProfile}:${base}`
        : base;
    }
    case "manual-follower":
      return owner.baleProfile
        ? `profile:${owner.baleProfile}:manual:${owner.instanceId}`
        : `manual:${owner.instanceId}`;
    case "pending-topic":
      return `topic:${owner.chatId}:${owner.threadId}`;
    case "legacy":
      return `legacy:${owner.key}`;
  }
}

export function getBaleThreadOwnerFromProfileKey(
  profileKey: string,
): BaleThreadOwner {
  if (profileKey.startsWith("profile:")) {
    const [, baleProfile, ownerKind, ...rest] = profileKey.split(":");
    const value = rest.join(":");
    if (ownerKind === "cwd")
      return { kind: "leader", cwd: value, baleProfile };
    if (ownerKind === "leader")
      return { kind: "leader", instanceId: value, baleProfile };
    if (ownerKind === "manual")
      return { kind: "manual-follower", instanceId: value, baleProfile };
  }
  if (profileKey.startsWith("cwd:"))
    return { kind: "leader", cwd: profileKey.slice(4) };
  if (profileKey.startsWith("manual:")) {
    return { kind: "manual-follower", instanceId: profileKey.slice(7) };
  }
  if (profileKey.startsWith("topic:")) {
    const [, chatIdText, threadIdText] = profileKey.split(":");
    const chatId = Number(chatIdText);
    const threadId = Number(threadIdText);
    if (Number.isInteger(chatId) && Number.isInteger(threadId)) {
      return { kind: "pending-topic", chatId, threadId };
    }
  }
  if (profileKey.startsWith("leader:")) {
    return { kind: "leader", instanceId: profileKey.slice(7) };
  }
  return { kind: "legacy", key: profileKey };
}

function parseThreadOwner(value: unknown): BaleThreadOwner | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  const record = value as Record<string, unknown>;
  if (record.kind === "leader") {
    return {
      kind: "leader",
      cwd: typeof record.cwd === "string" ? record.cwd : undefined,
      instanceId:
        typeof record.instanceId === "string" ? record.instanceId : undefined,
      ...(typeof record.baleProfile === "string"
        ? { baleProfile: record.baleProfile }
        : {}),
    };
  }
  if (
    record.kind === "manual-follower" &&
    typeof record.instanceId === "string"
  ) {
    return {
      kind: "manual-follower",
      instanceId: record.instanceId,
      ...(typeof record.baleProfile === "string"
        ? { baleProfile: record.baleProfile }
        : {}),
    };
  }
  if (
    record.kind === "pending-topic" &&
    typeof record.chatId === "number" &&
    typeof record.threadId === "number" &&
    Number.isInteger(record.threadId)
  ) {
    return {
      kind: "pending-topic",
      chatId: record.chatId,
      threadId: record.threadId,
    };
  }
  if (record.kind === "legacy" && typeof record.key === "string") {
    return { kind: "legacy", key: record.key };
  }
  return undefined;
}

function getRecordOwner(
  record: BaleTopicTargetRecord,
): BaleThreadOwner {
  return (
    record.owner ?? getBaleThreadOwnerFromProfileKey(record.profileKey)
  );
}

function getRecordOwnerKey(record: BaleTopicTargetRecord): string {
  return getBaleThreadOwnerKey(getRecordOwner(record));
}

function cloneRecord(
  record: BaleTopicTargetRecord,
): BaleTopicTargetRecord {
  const owner = getRecordOwner(record);
  return {
    ...record,
    owner: { ...owner },
    profileKey: getBaleThreadOwnerKey(owner),
    target: { ...record.target },
  };
}

function getPersistedThreadName(
  record: Record<string, unknown>,
): string | undefined {
  const value =
    typeof record.threadName === "string"
      ? record.threadName
      : typeof record.displayName === "string"
        ? record.displayName
        : undefined;
  return value ? normalizeBaleTopicTargetThreadName(value) : undefined;
}

function normalizeRecord(
  value: unknown,
): BaleTopicTargetRecord | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  const record = value as Record<string, unknown>;
  const target = record.target;
  const owner =
    parseThreadOwner(record.owner) ??
    (typeof record.profileKey === "string" && record.profileKey.length > 0
      ? getBaleThreadOwnerFromProfileKey(record.profileKey)
      : undefined);
  if (!owner) return undefined;
  const parsedTarget = parseStoredThreadTarget(target);
  if (!parsedTarget) return undefined;
  const status = record.status;
  if (
    status !== "active" &&
    status !== "offline" &&
    status !== "stale" &&
    status !== "pending" &&
    status !== "starting" &&
    status !== "probe-required" &&
    status !== "failed"
  )
    return undefined;
  if (
    typeof record.createdAtMs !== "number" ||
    typeof record.updatedAtMs !== "number"
  )
    return undefined;
  const threadName = getPersistedThreadName(record);
  const normalized: BaleTopicTargetRecord = {
    profileKey: getBaleThreadOwnerKey(owner),
    owner,
    target: parsedTarget,
    status,
    createdAtMs: record.createdAtMs,
    updatedAtMs: record.updatedAtMs,
    ...(threadName !== undefined ? { threadName } : {}),
    ...(typeof record.manualThreadName === "string" &&
    normalizeBaleTopicTargetThreadName(record.manualThreadName)
      ? {
          manualThreadName: normalizeBaleTopicTargetThreadName(
            record.manualThreadName,
          ),
        }
      : {}),
    instanceId:
      typeof record.instanceId === "string" ? record.instanceId : undefined,
    slot: typeof record.slot === "string" ? record.slot : undefined,
  };
  const syncStatus = record.syncStatus ?? record.twinStatus;
  if (
    syncStatus === "open" ||
    syncStatus === "closed" ||
    syncStatus === "deleted" ||
    syncStatus === "unknown"
  ) {
    normalized.syncStatus = syncStatus;
  }
  if (typeof record.lastError === "string")
    normalized.lastError = record.lastError;
  const lastSyncObservedAtMs =
    record.lastSyncObservedAtMs ?? record.lastTwinObservedAtMs;
  if (typeof lastSyncObservedAtMs === "number") {
    normalized.lastSyncObservedAtMs = lastSyncObservedAtMs;
  }
  const lastSyncProbeAtMs =
    record.lastSyncProbeAtMs ?? record.lastTwinProbeAtMs;
  if (typeof lastSyncProbeAtMs === "number") {
    normalized.lastSyncProbeAtMs = lastSyncProbeAtMs;
  }
  const lastSyncError = record.lastSyncError ?? record.lastTwinError;
  if (typeof lastSyncError === "string") {
    normalized.lastSyncError = lastSyncError;
  }
  if (typeof record.lastReconcileAction === "string") {
    normalized.lastReconcileAction = record.lastReconcileAction;
  }
  if (typeof record.rerouteConfirmedAtMs === "number") {
    normalized.rerouteConfirmedAtMs = record.rerouteConfirmedAtMs;
  }
  return normalized;
}

function isPersistedThreadRecord(record: BaleTopicTargetRecord): boolean {
  return (
    ThreadReconciler.isCurrentThreadRecord(record) ||
    record.status === "probe-required"
  );
}

function normalizeIdentityRecord(
  value: unknown,
): BaleThreadIdentityRecord | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.profileKey !== "string" || record.profileKey.length === 0)
    return undefined;
  if (typeof record.updatedAtMs !== "number") return undefined;
  const identity: BaleThreadIdentityRecord = {
    profileKey: record.profileKey,
    updatedAtMs: record.updatedAtMs,
  };
  const persistedThreadName = getPersistedThreadName(record);
  if (persistedThreadName) {
    const threadName =
      normalizeBaleTopicTargetThreadName(persistedThreadName);
    if (threadName) identity.threadName = threadName;
  }
  if (typeof record.slot === "string" && /^[A-Z]$/.test(record.slot)) {
    identity.slot = record.slot;
  }
  return identity.threadName || identity.slot ? identity : undefined;
}

function cloneIdentityRecord(
  identity: BaleThreadIdentityRecord,
): BaleThreadIdentityRecord {
  return { ...identity };
}

function indexWorkspaceBindings(
  bindings: readonly BaleWorkspaceThreadBinding[],
): Map<string, BaleWorkspaceThreadBinding> {
  return new Map(
    bindings.map((binding) => [
      getWorkspaceBindingMapKey(binding),
      cloneWorkspaceBinding(binding),
    ]),
  );
}

function getWorkspaceBindingMapKey(
  binding: Pick<
    BaleWorkspaceThreadBinding,
    "cwd" | "instanceSlot" | "sessionId"
  >,
): string {
  return `${binding.cwd}\u0000${binding.sessionId ?? ""}\u0000${binding.instanceSlot}`;
}

function normalizeWorkspaceJournalSources(
  value: unknown,
): BaleWorkspaceJournalSource[] | undefined {
  if (!Array.isArray(value) || value.length > 256) return undefined;
  const sources = new Map<string, BaleWorkspaceJournalSource>();
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry))
      return undefined;
    const source = entry as Record<string, unknown>;
    if (
      Object.keys(source).some(
        (key) => key !== "sessionId" && key !== "recipientBindingKey",
      ) ||
      typeof source.sessionId !== "string" ||
      normalizeBaleSessionId(source.sessionId) !== source.sessionId ||
      typeof source.recipientBindingKey !== "string" ||
      !source.recipientBindingKey ||
      source.recipientBindingKey.length > 512
    )
      return undefined;
    const normalized = {
      sessionId: source.sessionId,
      recipientBindingKey: source.recipientBindingKey,
    };
    sources.set(JSON.stringify(normalized), normalized);
  }
  return Array.from(sources.values());
}

function normalizeWorkspaceBindingRecord(
  value: unknown,
): BaleWorkspaceThreadBinding | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  const record = value as Record<string, unknown>;
  if (
    typeof record.cwd !== "string" ||
    typeof record.workspaceKey !== "string" ||
    typeof record.instanceSlot !== "string" ||
    typeof record.bindingKey !== "string" ||
    typeof record.updatedAtMs !== "number"
  ) {
    return undefined;
  }
  const cwd = normalizeBaleWorkspacePath(record.cwd);
  const sessionId =
    typeof record.sessionId === "string"
      ? normalizeBaleSessionId(record.sessionId)
      : undefined;
  const sessionKey =
    typeof record.sessionKey === "string" ? record.sessionKey : undefined;
  const hasSessionFields =
    record.sessionId !== undefined || record.sessionKey !== undefined;
  const expectedSessionKey = sessionId
    ? createBaleSessionKey(sessionId)
    : undefined;
  const legacyBindingKey =
    record.instanceSlot === "a"
      ? record.workspaceKey
      : `${record.workspaceKey}${record.instanceSlot}`;
  const expectedBindingKey = expectedSessionKey
    ? `${legacyBindingKey}-s-${expectedSessionKey}`
    : legacyBindingKey;
  if (
    !cwd ||
    cwd !== record.cwd ||
    !record.workspaceKey ||
    !/^[a-z]+$/u.test(record.instanceSlot) ||
    (hasSessionFields && (!sessionId || sessionKey !== expectedSessionKey)) ||
    record.bindingKey !== expectedBindingKey
  ) {
    return undefined;
  }
  const targetValue = record.target;
  if (
    !targetValue ||
    typeof targetValue !== "object" ||
    Array.isArray(targetValue)
  ) {
    return undefined;
  }
  const target = targetValue as Record<string, unknown>;
  if (
    typeof target.chatId !== "number" ||
    typeof target.threadId !== "number" ||
    !Number.isInteger(target.threadId)
  ) {
    return undefined;
  }
  const threadName = getPersistedThreadName(record);
  const manualThreadName =
    typeof record.manualThreadName === "string"
      ? normalizeBaleTopicTargetThreadName(record.manualThreadName)
      : undefined;
  const slot =
    typeof record.slot === "string" && /^[A-Z]$/u.test(record.slot)
      ? record.slot
      : undefined;
  const journalBindingKeys =
    Array.isArray(record.journalBindingKeys) &&
    record.journalBindingKeys.every(
      (key) => typeof key === "string" && key.length > 0 && key.length <= 512,
    )
      ? Array.from(new Set(record.journalBindingKeys as string[]))
      : undefined;
  const journalSources =
    record.journalSources === undefined
      ? undefined
      : normalizeWorkspaceJournalSources(record.journalSources);
  if (record.journalSources !== undefined && !journalSources) return undefined;
  return {
    cwd,
    workspaceKey: record.workspaceKey,
    ...(sessionId && sessionKey ? { sessionId, sessionKey } : {}),
    instanceSlot: record.instanceSlot,
    bindingKey: record.bindingKey,
    ...(record.showSlotSuffix === true ? { showSlotSuffix: true } : {}),
    ...(typeof record.displayTitle === "string" && record.displayTitle.trim()
      ? { displayTitle: record.displayTitle }
      : {}),
    ...(typeof record.inactiveSinceMs === "number" &&
    Number.isFinite(record.inactiveSinceMs) &&
    record.inactiveSinceMs >= 0
      ? { inactiveSinceMs: record.inactiveSinceMs }
      : {}),
    ...(journalBindingKeys ? { journalBindingKeys } : {}),
    ...(journalSources ? { journalSources } : {}),
    ...(record.journalBindingsComplete === true &&
    (journalBindingKeys || journalSources)
      ? { journalBindingsComplete: true as const }
      : {}),
    target: { chatId: target.chatId, threadId: target.threadId },
    ...(threadName ? { threadName } : {}),
    ...(manualThreadName ? { manualThreadName } : {}),
    ...(slot ? { slot } : {}),
    updatedAtMs: record.updatedAtMs,
  };
}

function cloneWorkspaceBinding(
  binding: BaleWorkspaceThreadBinding,
): BaleWorkspaceThreadBinding {
  return {
    ...binding,
    target: { ...binding.target },
    ...(binding.journalBindingKeys
      ? { journalBindingKeys: [...binding.journalBindingKeys] }
      : {}),
    ...(binding.journalSources
      ? {
          journalSources: binding.journalSources.map((source) => ({
            ...source,
          })),
        }
      : {}),
  };
}

function cloneSessionReplacementIntent(
  intent: BaleSessionReplacementIntent,
): BaleSessionReplacementIntent {
  return { ...intent, target: { ...intent.target } };
}

export function normalizeBaleSessionReplacementIntent(
  value: unknown,
): BaleSessionReplacementIntent | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  const record = value as Record<string, unknown>;
  const target = record.target as Record<string, unknown> | undefined;
  if (
    typeof record.cwd !== "string" ||
    !normalizeBaleWorkspacePath(record.cwd) ||
    typeof record.profileName !== "string" ||
    !record.profileName ||
    typeof record.sourceSessionId !== "string" ||
    !normalizeBaleSessionId(record.sourceSessionId) ||
    typeof record.sourceUpdateId !== "number" ||
    !Number.isSafeInteger(record.sourceUpdateId) ||
    !target ||
    typeof target.chatId !== "number" ||
    (target.threadId !== undefined &&
      (typeof target.threadId !== "number" ||
        !Number.isSafeInteger(target.threadId))) ||
    typeof record.messageId !== "number" ||
    !Number.isSafeInteger(record.messageId) ||
    typeof record.createdAtMs !== "number" ||
    !Number.isSafeInteger(record.createdAtMs) ||
    typeof record.expiresAtMs !== "number" ||
    !Number.isSafeInteger(record.expiresAtMs) ||
    record.expiresAtMs <= record.createdAtMs ||
    (record.sourceInstanceId !== undefined &&
      (typeof record.sourceInstanceId !== "string" ||
        !record.sourceInstanceId ||
        record.sourceInstanceId.length > 256))
  )
    return undefined;
  const continuity =
    record.continuity === "workspace-thread" ||
    record.continuity === "classic-chat"
      ? record.continuity
      : target.threadId !== undefined
        ? "workspace-thread"
        : "classic-chat";
  if ((continuity === "workspace-thread") !== (target.threadId !== undefined)) {
    return undefined;
  }
  return {
    continuity,
    cwd: normalizeBaleWorkspacePath(record.cwd)!,
    profileName: record.profileName,
    sourceSessionId: normalizeBaleSessionId(record.sourceSessionId)!,
    sourceUpdateId: record.sourceUpdateId,
    target: {
      chatId: target.chatId,
      ...(typeof target.threadId === "number"
        ? { threadId: target.threadId }
        : {}),
    },
    messageId: record.messageId,
    ...(typeof record.slot === "string" ? { slot: record.slot } : {}),
    ...(typeof record.threadName === "string"
      ? { threadName: record.threadName }
      : {}),
    createdAtMs: record.createdAtMs,
    expiresAtMs: record.expiresAtMs,
    ...(typeof record.sourceInstanceId === "string"
      ? { sourceInstanceId: record.sourceInstanceId }
      : {}),
  };
}

function normalizeWorkspaceRetirementIntent(
  value: unknown,
): BaleWorkspaceRetirementIntent | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  const record = value as Record<string, unknown>;
  const binding = normalizeWorkspaceBindingRecord(record.binding);
  if (
    typeof record.id !== "string" ||
    !record.id ||
    record.reason !== "pressure" ||
    typeof record.profileKey !== "string" ||
    !record.profileKey ||
    !binding?.slot ||
    binding.inactiveSinceMs === undefined ||
    !(
      (typeof record.leaderEpoch === "number" &&
        Number.isFinite(record.leaderEpoch)) ||
      (typeof record.leaderEpoch === "string" && record.leaderEpoch.length > 0)
    ) ||
    typeof record.requestedAtMs !== "number" ||
    !Number.isFinite(record.requestedAtMs) ||
    record.requestedAtMs < 0
  )
    return undefined;
  return {
    id: record.id,
    reason: record.reason,
    profileKey: record.profileKey,
    binding,
    leaderEpoch: record.leaderEpoch,
    requestedAtMs: record.requestedAtMs,
  };
}

function cloneWorkspaceRetirementIntent(
  intent: BaleWorkspaceRetirementIntent,
): BaleWorkspaceRetirementIntent {
  return { ...intent, binding: cloneWorkspaceBinding(intent.binding) };
}

function normalizeBotStateSnapshot(value: unknown): BaleBotStateSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { threadMode: "unknown" };
  }
  const record = value as Record<string, unknown>;
  const threadMode =
    record.threadMode === "enabled" || record.threadMode === "disabled"
      ? record.threadMode
      : "unknown";
  return {
    threadMode,
    updatedAtMs:
      typeof record.updatedAtMs === "number" ? record.updatedAtMs : undefined,
    lastSlot:
      typeof record.lastSlot === "string" && /^[A-Z]$/.test(record.lastSlot)
        ? record.lastSlot
        : undefined,
    lastReconcileAction:
      typeof record.lastReconcileAction === "string"
        ? record.lastReconcileAction
        : undefined,
  };
}

function normalizeSyncObservation(
  value: unknown,
): BaleTopicSyncObservation | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  const record = value as Record<string, unknown>;
  const target = parseStoredThreadTarget(record.target);
  const syncStatus = record.syncStatus;
  if (
    !target ||
    (syncStatus !== "open" &&
      syncStatus !== "closed" &&
      syncStatus !== "deleted" &&
      syncStatus !== "unknown")
  ) {
    return undefined;
  }
  return {
    target,
    syncStatus,
    observedAtMs:
      typeof record.observedAtMs === "number" ? record.observedAtMs : 0,
    instanceId:
      typeof record.instanceId === "string" ? record.instanceId : undefined,
    slot: typeof record.slot === "string" ? record.slot : undefined,
    lastSyncError:
      typeof record.lastSyncError === "string"
        ? record.lastSyncError
        : undefined,
    lastReconcileAction:
      typeof record.lastReconcileAction === "string"
        ? record.lastReconcileAction
        : undefined,
  };
}

function normalizePendingProvision(
  value: unknown,
): BaleThreadPendingProvision | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  const record = value as Record<string, unknown>;
  const owner = record.owner;
  if (owner !== "leader" && owner !== "manual-follower") return undefined;
  if (typeof record.id !== "string" || record.id.length === 0) return undefined;
  if (typeof record.instanceId !== "string" || record.instanceId.length === 0)
    return undefined;
  if (typeof record.startedAtMs !== "number") return undefined;
  const target = parseStoredThreadTarget(record.target);
  return {
    id: record.id,
    owner,
    instanceId: record.instanceId,
    ...(typeof record.profileKey === "string"
      ? { profileKey: record.profileKey }
      : {}),
    ...(record.status === "in-flight" || record.status === "ambiguous"
      ? { status: record.status }
      : {}),
    ...(typeof record.workspaceBindingKey === "string"
      ? { workspaceBindingKey: record.workspaceBindingKey }
      : {}),
    ...(typeof record.threadName === "string"
      ? { threadName: record.threadName }
      : {}),
    ...(typeof record.displayTitle === "string" && record.displayTitle.trim()
      ? { displayTitle: record.displayTitle }
      : {}),
    ...(typeof record.slot === "string" ? { slot: record.slot } : {}),
    ...(target ? { target } : {}),
    startedAtMs: record.startedAtMs,
    ...(typeof record.expiresAtMs === "number"
      ? { expiresAtMs: record.expiresAtMs }
      : {}),
    ...(typeof record.leaderEpoch === "number" ||
    typeof record.leaderEpoch === "string"
      ? { leaderEpoch: record.leaderEpoch }
      : {}),
  };
}

function normalizePendingCleanup(
  value: unknown,
): BaleThreadCleanupIntent | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  const record = value as Record<string, unknown>;
  const target = parseStoredThreadTarget(record.target);
  if (!target) return undefined;
  const owner = record.owner;
  if (owner !== "leader" && owner !== "manual-follower") return undefined;
  if (typeof record.id !== "string" || record.id.length === 0) return undefined;
  if (typeof record.instanceId !== "string" || record.instanceId.length === 0)
    return undefined;
  if (
    typeof record.runtimeGeneration !== "string" ||
    record.runtimeGeneration.length === 0
  ) {
    return undefined;
  }
  if (typeof record.requestedAtMs !== "number") return undefined;
  return {
    id: record.id,
    owner,
    instanceId: record.instanceId,
    runtimeGeneration: record.runtimeGeneration,
    ...(typeof record.profileKey === "string"
      ? { profileKey: record.profileKey }
      : {}),
    target,
    requestedAtMs: record.requestedAtMs,
  };
}

function normalizeReservation(
  value: unknown,
): BaleThreadReservation | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  const record = value as Record<string, unknown>;
  const target = parseStoredThreadTarget(record.target);
  const slot = typeof record.slot === "string" ? record.slot : undefined;
  const reason = typeof record.reason === "string" ? record.reason : undefined;
  if (!target || !slot || !reason) return undefined;
  return {
    target,
    slot,
    reason,
    createdAtMs:
      typeof record.createdAtMs === "number" ? record.createdAtMs : 0,
    updatedAtMs:
      typeof record.updatedAtMs === "number" ? record.updatedAtMs : 0,
    expiresAtMs:
      typeof record.expiresAtMs === "number" ? record.expiresAtMs : undefined,
    instanceId:
      typeof record.instanceId === "string" ? record.instanceId : undefined,
    lastReconcileAction:
      typeof record.lastReconcileAction === "string"
        ? record.lastReconcileAction
        : undefined,
  };
}

function normalizeBaleWorkspaceRelocationRequest(
  value: unknown,
): BaleWorkspaceRelocationRequest | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  const request = value as BaleWorkspaceRelocationRequest;
  const binding = normalizeWorkspaceBindingRecord(request.binding);
  const owner = normalizeRecord(request.owner);
  const target = request.target;
  if (
    typeof request.operationId !== "string" ||
    !request.operationId ||
    !binding?.sessionId ||
    !binding.slot ||
    !/^[A-Z]$/.test(binding.slot) ||
    binding.inactiveSinceMs !== undefined ||
    !owner ||
    owner.status !== "active" ||
    !owner.instanceId ||
    owner.slot !== binding.slot ||
    !["leader", "manual-follower"].includes(owner.owner?.kind ?? "") ||
    (owner.owner?.kind === "leader" &&
      (owner.owner.cwd !== binding.cwd ||
        owner.owner.instanceId !== owner.instanceId)) ||
    !targetMatches(binding.target, owner.target) ||
    !Number.isSafeInteger(binding.target.chatId) ||
    binding.target.chatId === 0 ||
    !Number.isSafeInteger(binding.target.threadId) ||
    binding.target.threadId <= 0 ||
    !target ||
    target.chatId !== binding.target.chatId ||
    !Number.isSafeInteger(target.threadId) ||
    target.threadId <= 0 ||
    targetMatches(target, binding.target)
  )
    return undefined;
  const normalized = {
    operationId: request.operationId,
    binding,
    owner,
    target: { chatId: target.chatId, threadId: target.threadId },
  };
  return isDeepStrictEqual(value, normalized) ? normalized : undefined;
}

const restoreInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const restoreKeys = (
  value: Record<string, unknown>,
  allowed: string[],
): boolean => Object.keys(value).every((key) => allowed.includes(key));
const isBaleWorkspaceRestoreExecutor = (
  value: unknown,
): value is BaleWorkspaceRestoreExecutor =>
  restoreObject(value) &&
  restoreKeys(value, ["instanceId", "leaderEpoch"]) &&
  restoreText(value.instanceId) &&
  restoreText(value.leaderEpoch);
export const isBaleWorkspaceRestoreRecipient = (
  value: unknown,
): value is BaleWorkspaceRestoreRecipient =>
  restoreObject(value) &&
  restoreKeys(value, ["kind", "instanceId", "sessionId", "generation"]) &&
  (value.kind === "leader" || value.kind === "follower") &&
  restoreText(value.instanceId) &&
  restoreText(value.sessionId) &&
  restoreText(value.generation);
export function isBaleWorkspaceRestoreRequest(
  value: unknown,
): value is BaleWorkspaceRestoreRequest {
  if (!restoreObject(value)) return false;
  const { source, ...relocation } = value;
  return (
    !!normalizeBaleWorkspaceRelocationRequest(relocation) &&
    restoreObject(source) &&
    restoreKeys(source, ["journalBindingKey", "updateIds"]) &&
    restoreText(source.journalBindingKey) &&
    Array.isArray(source.updateIds) &&
    source.updateIds.length > 0 &&
    source.updateIds.every(
      (id, index, ids) =>
        restoreInteger(id) && (index === 0 || id > ids[index - 1]),
    )
  );
}
function isBaleWorkspaceRestoreSettlement(
  value: unknown,
  source: BaleWorkspaceRestoreRequest["source"],
): value is BaleWorkspaceRestoreSourceSettlement {
  if (
    !restoreObject(value) ||
    value.journalBindingKey !== source.journalBindingKey ||
    !Array.isArray(value.updateIds) ||
    value.updateIds.length === 0 ||
    !value.updateIds.every(
      (id, index, ids) =>
        restoreInteger(id) &&
        source.updateIds.includes(id) &&
        (index === 0 || id > ids[index - 1]),
    )
  )
    return false;
  return value.kind === "completed"
    ? restoreKeys(value, ["journalBindingKey", "updateIds", "kind"])
    : (value.kind === "queued" || value.kind === "queue-completed") &&
        restoreKeys(value, [
          "journalBindingKey",
          "updateIds",
          "kind",
          "receiptId",
          "queueKind",
        ]) &&
        restoreText(value.receiptId) &&
        (value.queueKind === "prompt" || value.queueKind === "control");
}
function isWorkspaceRestoreSourceAcceptance(
  value: unknown,
  operation: BaleWorkspaceRestoreIntent,
): value is BaleWorkspaceRestoreSourceAcceptance {
  if (
    !restoreObject(value) ||
    value.journalBindingKey !== operation.request.source.journalBindingKey ||
    !restoreInteger(value.updateId) ||
    !operation.request.source.updateIds.includes(value.updateId) ||
    typeof value.sourceSha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(value.sourceSha256) ||
    !isBaleWorkspaceRestoreRecipient(value.recipient) ||
    value.recipient.sessionId !== operation.request.binding.sessionId ||
    value.recipient.kind !== operation.recipient?.kind
  )
    return false;
  const keys = [
    "journalBindingKey",
    "updateId",
    "sourceSha256",
    "recipient",
    "kind",
  ];
  if (value.kind === "completed")
    return value.recipient.kind === "leader" && restoreKeys(value, keys);
  if (value.kind === "forwarded")
    return (
      value.recipient.kind === "follower" &&
      restoreKeys(value, [...keys, "deliveryId", "recipientBindingKey"]) &&
      typeof value.deliveryId === "string" &&
      /^bale-follower-v1-[a-f0-9]{64}$/u.test(value.deliveryId) &&
      restoreText(value.recipientBindingKey)
    );
  return (
    value.kind === "queued" &&
    value.recipient.kind === "leader" &&
    restoreKeys(value, [
      ...keys,
      "receiptId",
      "queueKind",
      "queueOwnerSha256",
    ]) &&
    restoreText(value.receiptId) &&
    (value.queueKind === "prompt" || value.queueKind === "control") &&
    typeof value.queueOwnerSha256 === "string" &&
    /^[a-f0-9]{64}$/u.test(value.queueOwnerSha256)
  );
}
/** Stable acceptance scope, not a removal ACK; adoption and mutable progress cannot change it. */
export function getBaleWorkspaceRestoreSourceCompletionSha256(
  operation: BaleWorkspaceRestoreIntent,
  acceptance: BaleWorkspaceRestoreSourceAcceptance,
): string {
  if (
    !isBaleWorkspaceRestoreRequest(operation.request) ||
    operation.operatorUserId !== operation.request.target.chatId ||
    !isWorkspaceRestoreSourceAcceptance(acceptance, operation) ||
    !operation.routing?.acceptances?.some((value) =>
      isDeepStrictEqual(value, acceptance),
    )
  ) {
    throw new Error(
      "Workspace Restore retained acceptance scope is unavailable.",
    );
  }
  const frame = {
    kind: "workspace-restore-source-completion-v1",
    request: operation.request,
    operatorUserId: operation.operatorUserId,
    acceptance,
  };
  return createHash("sha256")
    .update(
      JSON.stringify(frame, function (_key, value: unknown) {
        return restoreObject(value)
          ? Object.fromEntries(
              Object.keys(value)
                .sort()
                .map((key) => [key, value[key]]),
            )
          : value;
      }),
    )
    .digest("hex");
}

function workspaceRestoreAcceptancesConsistent(
  acceptances: readonly BaleWorkspaceRestoreSourceAcceptance[],
): boolean {
  return acceptances.every(
    (value, index) =>
      (index === 0 || value.updateId > acceptances[index - 1]!.updateId) &&
      acceptances.slice(0, index).every((previous) => {
        if (value.kind === "forwarded" && previous.kind === "forwarded")
          return value.deliveryId !== previous.deliveryId;
        if (
          value.kind !== "queued" ||
          previous.kind !== "queued" ||
          value.receiptId !== previous.receiptId
        )
          return true;
        return (
          value.queueKind === previous.queueKind &&
          value.queueOwnerSha256 === previous.queueOwnerSha256 &&
          isDeepStrictEqual(value.recipient, previous.recipient)
        );
      }),
  );
}
function workspaceRestoreSettlementMatchesAcceptance(
  evidence: BaleWorkspaceRestoreSourceSettlement,
  acceptances: readonly BaleWorkspaceRestoreSourceAcceptance[],
): boolean {
  return evidence.updateIds.every((id) => {
    const accepted = acceptances.find((value) => value.updateId === id);
    if (!accepted) return evidence.kind !== "queue-completed"; // Legacy admission is retained, never terminal receipt proof.
    return evidence.kind === "completed"
      ? accepted.kind !== "queued"
      : accepted.kind === "queued" &&
          evidence.receiptId === accepted.receiptId &&
          evidence.queueKind === accepted.queueKind;
  });
}
function workspaceRestoreSourcesSettled(
  operation: BaleWorkspaceRestoreIntent,
): boolean {
  const settled = new Set(
    operation.routing?.settlements
      .filter((value) => value.kind !== "queued")
      .flatMap((value) => value.updateIds),
  );
  return operation.request.source.updateIds.every((id) => settled.has(id));
}
function isWorkspaceRestoreIntent(
  value: unknown,
): value is BaleWorkspaceRestoreIntent {
  if (
    !restoreObject(value) ||
    !restoreKeys(value, [
      "request",
      "operatorUserId",
      "executor",
      "revision",
      "createdAtMs",
      "updatedAtMs",
      "phase",
      "committedAtMs",
      "recipient",
      "readyRecipient",
      "routing",
    ]) ||
    !isBaleWorkspaceRestoreRequest(value.request) ||
    !restoreInteger(value.operatorUserId) ||
    value.operatorUserId !== value.request.target.chatId ||
    !isBaleWorkspaceRestoreExecutor(value.executor) ||
    !restoreInteger(value.revision) ||
    !restoreInteger(value.createdAtMs) ||
    !restoreInteger(value.updatedAtMs) ||
    value.updatedAtMs < value.createdAtMs ||
    !restoreInteger(value.committedAtMs)
  )
    return false;
  const source = value.request.source;
  if (value.routing !== undefined) {
    if (
      value.phase !== "ready" ||
      !restoreObject(value.routing) ||
      !restoreKeys(value.routing, ["acceptances", "settlements", "cleanup"]) ||
      !Array.isArray(value.routing.settlements) ||
      !value.routing.settlements.every((item) =>
        isBaleWorkspaceRestoreSettlement(item, source),
      )
    )
      return false;
    if (value.routing.acceptances !== undefined) {
      const acceptances = value.routing.acceptances;
      if (
        !Array.isArray(acceptances) ||
        !acceptances.length ||
        !acceptances.every((item) =>
          isWorkspaceRestoreSourceAcceptance(
            item,
            value as unknown as BaleWorkspaceRestoreIntent,
          ),
        ) ||
        !workspaceRestoreAcceptancesConsistent(acceptances)
      )
        return false;
    }
    const acceptances = (value.routing.acceptances ??
      []) as BaleWorkspaceRestoreSourceAcceptance[];
    if (
      !value.routing.settlements.every((item) =>
        workspaceRestoreSettlementMatchesAcceptance(item, acceptances),
      )
    )
      return false;
    const ids = value.routing.settlements.flatMap((item) => item.updateIds);
    if (
      new Set(ids).size !== ids.length ||
      (value.routing.cleanup !== undefined &&
        (!["issued", "completed", "not-issued"].includes(
          value.routing.cleanup as string,
        ) ||
          !workspaceRestoreSourcesSettled(
            value as unknown as BaleWorkspaceRestoreIntent,
          )))
    )
      return false;
  }
  if (
    value.readyRecipient !== undefined &&
    (value.phase !== "ready" ||
      !isBaleWorkspaceRestoreRecipient(value.readyRecipient) ||
      value.readyRecipient.sessionId !== value.request.binding.sessionId)
  )
    return false;
  if (value.phase === "relocated") return value.recipient === undefined;
  return (
    (value.phase === "recipient-issued" || value.phase === "ready") &&
    isBaleWorkspaceRestoreRecipient(value.recipient) &&
    value.recipient.sessionId === value.request.binding.sessionId
  );
}
function isWorkspaceLiveRebindIntent(
  value: unknown,
): value is BaleWorkspaceLiveRebindIntent {
  if (
    !restoreObject(value) ||
    !restoreKeys(value, [
      "kind",
      "request",
      "operatorUserId",
      "executor",
      "revision",
      "createdAtMs",
      "updatedAtMs",
      "recipient",
      "phase",
      "cleanup",
      "inputRelease",
      "oldTargetProtected",
    ]) ||
    value.kind !== "live-rebind" ||
    !isBaleWorkspaceRestoreRequest(value.request) ||
    !restoreInteger(value.operatorUserId) ||
    value.operatorUserId !== value.request.target.chatId ||
    !isBaleWorkspaceRestoreExecutor(value.executor) ||
    !restoreInteger(value.revision) ||
    !restoreInteger(value.createdAtMs) ||
    !restoreInteger(value.updatedAtMs) ||
    value.updatedAtMs < value.createdAtMs ||
    !isBaleWorkspaceRestoreRecipient(value.recipient) ||
    value.recipient.sessionId !== value.request.binding.sessionId ||
    value.recipient.instanceId !== value.request.owner.instanceId ||
    value.recipient.kind !==
      (value.request.owner.owner?.kind === "leader" ? "leader" : "follower")
  )
    return false;
  if (value.inputRelease !== undefined &&
    (!["held", "issued", "accepted"].includes(value.inputRelease as string) ||
      (value.inputRelease !== "held" && !["released", "finished"].includes(value.phase as string)))) return false;
  if (value.oldTargetProtected !== undefined &&
    (value.oldTargetProtected !== true || value.inputRelease === undefined || value.phase !== "finished" || value.cleanup !== "not-issued")) return false;
  if (value.phase === "rebound") return value.cleanup === undefined;
  if (value.phase === "released")
    return value.cleanup === undefined || value.cleanup === "issued";
  return (
    value.phase === "finished" &&
    ["confirmed", "failed", "unknown", "not-issued"].includes(
      value.cleanup as string,
    )
  );
}
function isTemporaryThreadInput(
  value: unknown,
): value is BaleTemporaryThreadInput {
  return (
    restoreObject(value) &&
    restoreKeys(value, ["journalBindingKey", "updateIds"]) &&
    restoreText(value.journalBindingKey) &&
    Array.isArray(value.updateIds) &&
    value.updateIds.length > 0 &&
    value.updateIds.length <= TEMPORARY_THREAD_INPUT_CAPACITY &&
    value.updateIds.every(
      (id, index, ids) =>
        restoreInteger(id) && (index === 0 || id > ids[index - 1]),
    )
  );
}
export function getBaleTemporaryThreadInputs(
  entry: BaleTemporaryThreadEntry,
): BaleTemporaryThreadInput[] {
  return structuredClone(
    entry.inputs ?? [
      {
        journalBindingKey: entry.source.journalBindingKey,
        updateIds: [entry.source.updateId],
      },
    ],
  );
}
/** Every known group is durably cancelled or Forward-completed; still not deletion authority by itself. */
export function isBaleTemporaryThreadFullyResolved(
  entry: BaleTemporaryThreadEntry,
): boolean {
  const inputs = getBaleTemporaryThreadInputs(entry),
    resolved = [
      ...(entry.cancelledInputs ?? []),
      ...(entry.completedInputs ?? []),
    ];
  return (
    resolved.length > 0 &&
    inputs.every((input) =>
      resolved.some((other) => isDeepStrictEqual(other, input)),
    )
  );
}
/** One unresolved group may release protection after completion when every other group has a durable terminal fact. */
function isTemporaryThreadReleasedByCompletion(
  entry: BaleTemporaryThreadEntry,
  completed: BaleTemporaryThreadInput | undefined,
): boolean {
  if (!completed || !isTemporaryThreadInput(completed)) return false;
  const inputs = getBaleTemporaryThreadInputs(entry),
    cancelled = [
      ...(entry.cancelledInputs ?? []),
      ...(entry.completedInputs ?? []),
    ];
  const same = (
    left: BaleTemporaryThreadInput,
    right: BaleTemporaryThreadInput,
  ): boolean => isDeepStrictEqual(left, right);
  return (
    inputs.some((input) => same(input, completed)) &&
    !cancelled.some((input) => same(input, completed)) &&
    inputs.every(
      (input) =>
        same(input, completed) || cancelled.some((other) => same(other, input)),
    )
  );
}
/** A created temporary tab may advance one recorded input only while no Restore operation claims its updates. */
function isTemporaryThreadInputAdvanceable(
  entry: BaleTemporaryThreadEntry,
  file: Pick<BaleWorkspaceRestoreSnapshot, "operations">,
  input: BaleTemporaryThreadInput,
): boolean {
  return (
    entry.phase === "created" &&
    getBaleTemporaryThreadInputs(entry).some((candidate) =>
      isDeepStrictEqual(candidate, input),
    ) &&
    !file.operations.some(
      ({ request }) =>
        request.source.journalBindingKey === input.journalBindingKey &&
        request.source.updateIds.some((id) => input.updateIds.includes(id)),
    )
  );
}

/** A bounded, duplicate-free subset of recorded `inputs` that shares no input with `excluded`. */
function isTemporaryThreadInputSubset(
  value: unknown,
  inputs: readonly unknown[],
  excluded: readonly unknown[] = [],
): boolean {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= TEMPORARY_THREAD_INPUT_CAPACITY &&
    value.every(isTemporaryThreadInput) &&
    !value.some(
      (input, index) =>
        !inputs.some((candidate) => isDeepStrictEqual(candidate, input)) ||
        excluded.some((other) => isDeepStrictEqual(other, input)) ||
        value.slice(index + 1).some((other) => isDeepStrictEqual(other, input)),
    )
  );
}

function isTemporaryThreadEntry(
  value: unknown,
): value is BaleTemporaryThreadEntry {
  if (
    !restoreObject(value) ||
    !restoreKeys(value, [
      "source",
      "inputs",
      "cancelledInputs",
      "completedInputs",
      "forwardedInputs",
      "forwardProtocol",
      "cleanupIssued",
      "operatorUserId",
      "executor",
      "token",
      "phase",
      "target",
      "revision",
      "createdAtMs",
      "updatedAtMs",
    ]) ||
    !restoreObject(value.source) ||
    !restoreKeys(value.source, ["journalBindingKey", "updateId"]) ||
    !restoreText(value.source.journalBindingKey) ||
    !restoreInteger(value.source.updateId) ||
    !restoreInteger(value.operatorUserId) ||
    value.operatorUserId === 0 ||
    !isBaleWorkspaceRestoreExecutor(value.executor) ||
    typeof value.token !== "string" ||
    !/^[a-f0-9]{32}$/u.test(value.token) ||
    !restoreInteger(value.revision) ||
    !restoreInteger(value.createdAtMs) ||
    !restoreInteger(value.updatedAtMs) ||
    value.updatedAtMs < value.createdAtMs
  )
    return false;
  const source = value.source;
  if (
    value.forwardProtocol !== undefined &&
    (value.forwardProtocol !== "one-shot-v1" || value.inputs === undefined)
  )
    return false;
  if (value.inputs !== undefined) {
    const inputs = value.inputs;
    if (
      !Array.isArray(inputs) ||
      inputs.length === 0 ||
      inputs.length > TEMPORARY_THREAD_INPUT_CAPACITY ||
      !inputs.every(isTemporaryThreadInput) ||
      // The first group is the source: one message, or an album that opened a native tab.
      inputs[0].journalBindingKey !== source.journalBindingKey ||
      inputs[0].updateIds[0] !== source.updateId ||
      inputs.some(
        (input, index) =>
          input.journalBindingKey !== source.journalBindingKey ||
          inputs
            .slice(index + 1)
            .some((other) =>
              other.updateIds.some((id) => input.updateIds.includes(id)),
            ),
      )
    )
      return false;
  }
  // Invalid `inputs`/`cancelledInputs` already failed above, so these defaults only cover absent fields.
  const inputs: unknown[] = Array.isArray(value.inputs)
    ? value.inputs
    : [
        {
          journalBindingKey: source.journalBindingKey,
          updateIds: [source.updateId],
        },
      ];
  const cancelled: unknown[] = Array.isArray(value.cancelledInputs)
    ? value.cancelledInputs
    : [];
  if (
    value.cancelledInputs !== undefined &&
    !isTemporaryThreadInputSubset(value.cancelledInputs, inputs)
  )
    return false;
  if (
    value.completedInputs !== undefined &&
    !isTemporaryThreadInputSubset(value.completedInputs, inputs, cancelled)
  )
    return false;
  if (
    value.forwardedInputs !== undefined &&
    !isTemporaryThreadInputSubset(value.forwardedInputs, inputs, cancelled)
  )
    return false;
  if (
    value.cleanupIssued !== undefined &&
    (value.cleanupIssued !== true ||
      !isBaleTemporaryThreadFullyResolved(
        value as unknown as BaleTemporaryThreadEntry,
      ))
  )
    return false;
  if (value.phase === "creating")
    return (
      value.target === undefined &&
      value.cancelledInputs === undefined &&
      value.completedInputs === undefined &&
      value.forwardedInputs === undefined &&
      value.cleanupIssued === undefined &&
      (!Array.isArray(value.inputs) || value.inputs.length === 1)
    );
  const target = value.target;
  return (
    value.phase === "created" &&
    restoreObject(target) &&
    restoreKeys(target, ["chatId", "threadId"]) &&
    target.chatId === value.operatorUserId &&
    Number.isSafeInteger(target.threadId) &&
    (target.threadId as number) > 0
  );
}
/** Only an exact recorded source group may Restore into its temporary tab. */
function isTemporaryThreadRestore(
  entry: BaleTemporaryThreadEntry,
  operations: readonly Pick<BaleWorkspaceRestoreIntent, "request">[],
): boolean {
  return operations.some(
    ({ request }) =>
      !!entry.target &&
      targetMatches(request.target, entry.target) &&
      ![
        ...(entry.cancelledInputs ?? []),
        ...(entry.completedInputs ?? []),
        ...(entry.forwardedInputs ?? []),
      ].some(
        (input) =>
          input.journalBindingKey === request.source.journalBindingKey &&
          input.updateIds.some((id) => request.source.updateIds.includes(id)),
      ) &&
      (entry.inputs
        ? entry.inputs.some((input) => isDeepStrictEqual(input, request.source))
        : request.source.journalBindingKey === entry.source.journalBindingKey &&
          request.source.updateIds.includes(entry.source.updateId)),
  );
}
function conflictsWithTemporaryThread(
  snapshot: BaleWorkspaceRestoreSnapshot | undefined,
  target: BaleTarget | undefined,
): boolean {
  return (
    !!target &&
    !!snapshot?.temporaryThreads?.some(
      (entry) => !!entry.target && targetMatches(entry.target, target),
    )
  );
}
function conflictsWithWorkspaceRestoreProvision(
  request: BaleWorkspaceRestoreRequest,
  provision: BaleThreadPendingProvision | BaleThreadReservation,
): boolean {
  if (
    "owner" in provision &&
    !provision.workspaceBindingKey &&
    (provision.profileKey === request.owner.profileKey ||
      provision.instanceId === request.owner.instanceId)
  )
    return true;
  return (
    ("workspaceBindingKey" in provision &&
      provision.workspaceBindingKey === request.binding.bindingKey) ||
    provision.slot === request.binding.slot ||
    (!!provision.target &&
      (targetMatches(provision.target, request.binding.target) ||
        targetMatches(provision.target, request.target)))
  );
}

/** Canonical issuance is distinct from cleanup completion, source disposition and peer dispatch readiness. */
export function isBaleLiveRebindInputAuthorized(value: BaleWorkspaceLiveRebindIntent): boolean {
  return value.inputRelease === undefined
    ? value.phase === "released" && value.cleanup === undefined
    : ["issued", "accepted"].includes(value.inputRelease) &&
      ["released", "finished"].includes(value.phase) && value.cleanup !== "issued";
}
function liveRebindInputPending(value: BaleWorkspaceLiveRebindIntent): boolean {
  return value.inputRelease !== undefined && value.inputRelease !== "accepted";
}
function liveRebindActive(value: BaleWorkspaceLiveRebindIntent): boolean {
  return value.phase !== "finished" || liveRebindInputPending(value);
}
function liveRebindOldTargetUnknown(value: BaleWorkspaceLiveRebindIntent): boolean {
  return value.phase === "finished" && value.cleanup === "unknown" && value.inputRelease !== undefined;
}
function retainLiveRebind(value: BaleWorkspaceLiveRebindIntent): boolean {
  return liveRebindActive(value) || liveRebindOldTargetUnknown(value) || value.oldTargetProtected === true;
}
function provisioningProtectionIntents(snapshot: BaleWorkspaceRestoreSnapshot): readonly Pick<BaleWorkspaceRestoreIntent, "request">[] {
  return [...snapshot.operations, ...(snapshot.liveRebindings ?? []).filter(retainLiveRebind)];
}
function protectedLiveRebindOldTargetIntents(snapshot: BaleWorkspaceRestoreSnapshot | undefined): BaleWorkspaceLiveRebindIntent[] {
  return (snapshot?.liveRebindings ?? []).filter(value =>
    value.oldTargetProtected === true || liveRebindOldTargetUnknown(value) || value.inputRelease !== undefined && value.cleanup === "issued",
  );
}
function protectedLiveRebindOldTargets(snapshot: BaleWorkspaceRestoreSnapshot | undefined): BaleTarget[] {
  return protectedLiveRebindOldTargetIntents(snapshot).map(value => ({ ...value.request.binding.target }));
}
function pendingWorkspaceRelocationRequests(
  snapshot: BaleWorkspaceRestoreSnapshot | undefined,
): BaleWorkspaceRestoreRequest[] {
  return [
    ...(snapshot?.operations ?? []).map((value) => value.request),
    ...(snapshot?.liveRebindings ?? [])
      .filter(liveRebindActive)
      .map((value) => value.request),
  ];
}
function assertWorkspaceRestoreBindingProtection(
  file: Pick<
    BaleTopicTargetFile,
    | "workspaceBindings"
    | "workspaceRestore"
    | "pendingProvisions"
    | "reservations"
  > & {
    threads?: readonly Pick<
      BaleTopicTargetRecord,
      "target" | "slot" | "instanceId" | "status" | "owner"
    >[];
  },
): void {
  for (const request of pendingWorkspaceRelocationRequests(
    file.workspaceRestore,
  )) {
    if (
      file.pendingProvisions?.some((value) =>
        conflictsWithWorkspaceRestoreProvision(request, value),
      ) ||
      file.reservations?.some((value) =>
        conflictsWithWorkspaceRestoreProvision(request, value),
      )
    ) {
      throw new Error("Protected Workspace Restore provisioning conflict.");
    }
    const bindings = file.workspaceBindings ?? [];
    const retained = bindings.filter(
      (value) => value.bindingKey === request.binding.bindingKey,
    );
    const current = retained[0];
    const identity = [
      "bindingKey",
      "cwd",
      "workspaceKey",
      "instanceSlot",
      "sessionId",
      "sessionKey",
      "slot",
    ] as const;
    if (
      retained.length !== 1 ||
      !current ||
      identity.some((key) => current[key] !== request.binding[key]) ||
      !targetMatches(current.target, request.target) ||
      bindings.some(
        (value) =>
          value !== current &&
          (value.slot === current.slot ||
            targetMatches(value.target, request.binding.target) ||
            targetMatches(value.target, request.target)),
      )
    ) {
      throw new Error("Protected Workspace Restore binding changed.");
    }
    const owners = (file.threads ?? []).filter(
      (value) =>
        value.slot === current.slot ||
        targetMatches(value.target, request.binding.target) ||
        targetMatches(value.target, request.target),
    );
    const live = file.workspaceRestore?.liveRebindings?.some(
      (value) =>
        liveRebindActive(value) &&
        value.request.operationId === request.operationId,
    );
    if (
      owners.length > 1 ||
      owners.some(
        (value) =>
          value.slot !== current.slot ||
          !targetMatches(value.target, request.target),
      ) ||
      (live &&
        (owners.length !== 1 ||
          owners[0]?.instanceId !== request.owner.instanceId ||
          owners[0]?.status !== "active" ||
          !isDeepStrictEqual(owners[0]?.owner, request.owner.owner)))
    ) {
      throw new Error("Protected Workspace Restore owner target changed.");
    }
  }
  for (const { request } of protectedLiveRebindOldTargetIntents(file.workspaceRestore)) {
    const old = request.binding.target;
    if (file.workspaceBindings?.some(value => targetMatches(value.target, old)) ||
      file.threads?.some(value => targetMatches(value.target, old) && ["active", "starting", "pending", "probe-required"].includes(value.status)) ||
      file.pendingProvisions?.some(value => conflictsWithWorkspaceRestoreProvision(request, value)) ||
      file.reservations?.some(value => targetMatches(value.target, old)))
      throw new Error("Unknown live cleanup target remains protected.");
  }
  const operations = [
    ...(file.workspaceRestore?.operations ?? []),
    ...(file.workspaceRestore?.liveRebindings ?? []),
  ];
  for (const entry of file.workspaceRestore?.temporaryThreads ?? []) {
    const target = entry.target;
    if (!target) continue;
    const claimed = [
      ...(file.workspaceBindings ?? []),
      ...(file.threads ?? []),
    ].some((value) => targetMatches(value.target, target));
    if (
      file.pendingProvisions?.some(
        (value) => !!value.target && targetMatches(value.target, target),
      ) ||
      file.reservations?.some((value) => targetMatches(value.target, target)) ||
      (claimed && !isTemporaryThreadRestore(entry, operations))
    ) {
      throw new Error("Protected temporary Thread target conflict.");
    }
  }
}

function workspaceRestoresConflict(
  left: BaleWorkspaceRestoreRequest,
  right: BaleWorkspaceRestoreRequest,
): boolean {
  const targets = [left.binding.target, left.target];
  return (
    left.operationId === right.operationId ||
    left.binding.bindingKey === right.binding.bindingKey ||
    left.binding.slot === right.binding.slot ||
    targets.some(
      (target) =>
        targetMatches(target, right.binding.target) ||
        targetMatches(target, right.target),
    ) ||
    (left.source.journalBindingKey === right.source.journalBindingKey &&
      right.source.updateIds.some((id) => left.source.updateIds.includes(id)))
  );
}
const WORKSPACE_RESTORE_MAX_BYTES = 1024 * 1024;
const TEMPORARY_THREAD_CAPACITY = 26;
const TEMPORARY_THREAD_INPUT_CAPACITY = 100;
const WORKSPACE_SNAPSHOT_MAX_BYTES = 8 * WORKSPACE_RESTORE_MAX_BYTES;
function parseWorkspaceRestore(
  value: unknown,
): BaleWorkspaceRestoreSnapshot | undefined {
  if (value === undefined) return undefined;
  const temporary = restoreObject(value) ? value.temporaryThreads : undefined;
  const live = restoreObject(value) ? value.liveRebindings : undefined;
  if (
    !restoreObject(value) ||
    !restoreKeys(value, [
      "version",
      "profileName",
      "tokenSha256",
      "revision",
      "operations",
      "liveRebindings",
      "temporaryThreads",
    ]) ||
    value.version !== 1 ||
    !restoreText(value.profileName) ||
    typeof value.tokenSha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(value.tokenSha256) ||
    !restoreInteger(value.revision) ||
    !Array.isArray(value.operations) ||
    value.operations.length > 26 ||
    (temporary !== undefined &&
      (!Array.isArray(temporary) ||
        temporary.length === 0 ||
        temporary.length > TEMPORARY_THREAD_CAPACITY ||
        !temporary.every(isTemporaryThreadEntry))) ||
    (live !== undefined &&
      (!Array.isArray(live) ||
        live.length === 0 ||
        live.length > 26 ||
        !live.every(isWorkspaceLiveRebindIntent))) ||
    ((value.operations.length > 0 ||
      live !== undefined ||
      temporary !== undefined) &&
      value.revision === 0) ||
    !value.operations.every(isWorkspaceRestoreIntent) ||
    Buffer.byteLength(JSON.stringify(value)) > WORKSPACE_RESTORE_MAX_BYTES
  )
    throw new Error("Invalid Workspace Restore evidence.");
  const snapshot = value as unknown as BaleWorkspaceRestoreSnapshot;
  if (
    snapshot.operations.some((operation, index) =>
      snapshot.operations
        .slice(index + 1)
        .some((other) =>
          workspaceRestoresConflict(operation.request, other.request),
        ),
    )
  )
    throw new Error("Conflicting Workspace Restore evidence.");
  const liveOperations = snapshot.liveRebindings ?? [];
  if (
    liveOperations.some(
      (operation, index) =>
        liveOperations
          .slice(index + 1)
          .some(
            (other) =>
              operation.request.operationId === other.request.operationId ||
              (liveRebindActive(operation) &&
                liveRebindActive(other) &&
                workspaceRestoresConflict(operation.request, other.request)),
          ) ||
        snapshot.operations.some(
          (other) =>
            operation.request.operationId === other.request.operationId ||
            (liveRebindActive(operation) &&
              workspaceRestoresConflict(operation.request, other.request)),
        ),
    )
  )
    throw new Error("Conflicting Workspace live rebinding evidence.");
  const entries = snapshot.temporaryThreads ?? [];
  if (
    entries.some((entry, index) =>
      entries
        .slice(index + 1)
        .some(
          (other) =>
            other.token === entry.token ||
            getBaleTemporaryThreadInputs(entry).some((input) =>
              getBaleTemporaryThreadInputs(other).some(
                (candidate) =>
                  input.journalBindingKey === candidate.journalBindingKey &&
                  input.updateIds.some((id) =>
                    candidate.updateIds.includes(id),
                  ),
              ),
            ) ||
            (!!entry.target &&
              !!other.target &&
              targetMatches(entry.target, other.target)),
        ),
    ) ||
    entries.some(
      (entry) =>
        !!entry.target &&
        [
          ...snapshot.operations,
          ...liveOperations.filter(liveRebindActive),
        ].some(
          ({ request }) =>
            targetMatches(request.binding.target, entry.target!) ||
            (targetMatches(request.target, entry.target!) &&
              !isTemporaryThreadRestore(entry, [{ request }])),
        ),
    )
  )
    throw new Error("Conflicting Workspace Restore evidence.");
  return snapshot;
}
/**
 * Atomic Workspace replacement with the shared bounded Windows sharing retries: a reader, scanner or antivirus
 * briefly holding the target makes rename fail with EPERM there. A vanished staging file is still an error.
 */
function replaceBaleWorkspaceFile(temporary: string, path: string): void {
  // A real-time scan of the just-published snapshot can outlast the default budget; ~1.35 s is paid only on refusal.
  if (
    !renameBalePathWithRetry(temporary, path, {
      attempts: 10,
      retryDelayMs: 30,
    })
  )
    throw new Error(
      "Bale Workspace staging file disappeared before publication.",
    );
}

/** All Restore reads and publishers share these physical-file checks; there is no repairing read. */
function readWorkspaceSnapshot(
  path: string,
  requirePrivate = true,
  asynchronous = false,
): unknown {
  // Asynchronous callers observe the file one turn later, as an I/O read would, but the whole inspection runs in
  // one synchronous step: a descriptor held across turns blocks Windows renames of the same file, and a publisher's
  // synchronous retry would starve that read.
  if (asynchronous)
    return new Promise<void>((resolve) => setImmediate(resolve)).then(() =>
      readWorkspaceSnapshot(path, requirePrivate),
    );
  let before;
  try {
    before = lstatSync(path, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  const privateFile = isBaleOwnerPrivate(before);
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.nlink !== 1n ||
    before.size > BigInt(WORKSPACE_SNAPSHOT_MAX_BYTES) ||
    (requirePrivate && !privateFile)
  )
    throw new Error(
      "Workspace snapshot must be a bounded private regular file.",
    );
  const fd = openSync(path, BALE_STRICT_READ_FLAGS);
  try {
    const opened = fstatSync(fd, { bigint: true });
    if (
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.size !== before.size ||
      opened.mtimeNs !== before.mtimeNs
    )
      throw new Error("Workspace snapshot changed during inspection.");
    const decode = (content: string): unknown => {
      const value: unknown = JSON.parse(content);
      // Legacy metadata may predate private storage; a Restore-bearing snapshot never may.
      if (
        !privateFile &&
        restoreObject(value) &&
        value.workspaceRestore !== undefined
      )
        throw new Error(
          "Workspace snapshot must be a bounded private regular file.",
        );
      return value;
    };
    return decode(readFileSync(fd, "utf8"));
  } finally {
    closeSync(fd);
  }
}

function parseTopicTargetFile(value: unknown): BaleTopicTargetFile {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {
      version: 1,
      source: "snapshot",
      writtenAtMs: 0,
      bot: { threadMode: "unknown" },
      threads: [],
    };
  }
  const file = value as Record<string, unknown>;
  // The unpublished two-file draft is not migration or source-reconstruction authority.
  if (
    (file.workspaceRelocations !== undefined &&
      (!Array.isArray(file.workspaceRelocations) ||
        file.workspaceRelocations.length !== 0)) ||
    (file.workspaceRelocationRevision !== undefined &&
      file.workspaceRelocationRevision !== 0)
  )
    throw new Error("Unmigrated Workspace relocation evidence.");
  const workspaceRestore = parseWorkspaceRestore(file.workspaceRestore);
  if (file.version !== 1 && workspaceRestore)
    throw new Error("Unsupported Workspace Restore snapshot.");
  if (file.version !== 1) {
    return {
      version: 1,
      source: "snapshot",
      writtenAtMs: 0,
      bot: { threadMode: "unknown" },
      threads: [],
    };
  }
  const rawThreads = Array.isArray(file.threads) ? file.threads : [];
  const threads = rawThreads
    .map((record) => normalizeRecord(record))
    .filter(
      (record): record is BaleTopicTargetRecord =>
        !!record && isPersistedThreadRecord(record),
    );
  return {
    version: 1,
    source: "snapshot",
    writtenAtMs: typeof file.writtenAtMs === "number" ? file.writtenAtMs : 0,
    bot: normalizeBotStateSnapshot(file.bot),
    threads,
    identities: Array.isArray(file.identities)
      ? file.identities.flatMap((identity) => {
          const normalized = normalizeIdentityRecord(identity);
          return normalized ? [normalized] : [];
        })
      : [],
    workspaceBindings: Array.isArray(file.workspaceBindings)
      ? file.workspaceBindings.flatMap((binding) => {
          const normalized = normalizeWorkspaceBindingRecord(binding);
          if (
            !normalized &&
            binding &&
            typeof binding === "object" &&
            "journalSources" in binding
          )
            throw new Error("Invalid Workspace session journal evidence.");
          return normalized ? [normalized] : [];
        })
      : [],
    workspaceRetirements: Array.isArray(file.workspaceRetirements)
      ? file.workspaceRetirements.flatMap((intent) => {
          const normalized = normalizeWorkspaceRetirementIntent(intent);
          return normalized ? [normalized] : [];
        })
      : [],
    ...(workspaceRestore ? { workspaceRestore } : {}),
    sessionReplacement: normalizeBaleSessionReplacementIntent(
      file.sessionReplacement,
    ),
    reservations: Array.isArray(file.reservations)
      ? file.reservations.flatMap((reservation) => {
          const normalized = normalizeReservation(reservation);
          return normalized ? [normalized] : [];
        })
      : [],
    pendingProvisions: Array.isArray(file.pendingProvisions)
      ? file.pendingProvisions.flatMap((provision) => {
          const normalized = normalizePendingProvision(provision);
          return normalized ? [normalized] : [];
        })
      : [],
    pendingCleanups: Array.isArray(file.pendingCleanups)
      ? file.pendingCleanups.flatMap((intent) => {
          const normalized = normalizePendingCleanup(intent);
          return normalized ? [normalized] : [];
        })
      : [],
    syncObservations: Array.isArray(file.syncObservations)
      ? file.syncObservations.flatMap((observation) => {
          const normalized = normalizeSyncObservation(observation);
          return normalized ? [normalized] : [];
        })
      : [],
  };
}

/** The unified section accepts only lossless current-format Workspace evidence, never tolerant legacy repair. */
export function parseBaleWorkspaceStateSection(
  value: unknown,
  profile: string,
): BaleTopicTargetFile | undefined {
  if (value === undefined) return undefined;
  if (
    !restoreObject(value) ||
    value.version !== 1 ||
    value.source !== "snapshot" ||
    !Number.isSafeInteger(value.writtenAtMs) ||
    (value.writtenAtMs as number) < 0 ||
    !restoreObject(value.bot) ||
    !Array.isArray(value.threads)
  )
    throw new Error("Invalid consolidated Workspace section.");
  if (Buffer.byteLength(JSON.stringify(value)) > WORKSPACE_SNAPSHOT_MAX_BYTES)
    throw new Error("Workspace snapshot byte capacity reached.");
  const parsed = parseTopicTargetFile(value),
    rawThreads = value.threads;
  const wire = JSON.parse(JSON.stringify(parsed)) as Record<string, unknown>;
  wire.threads = (wire.threads as Record<string, unknown>[]).map(
    (record, index) => {
      const copied = { ...record };
      const original = rawThreads[index];
      if (!restoreObject(original))
        throw new Error("Invalid consolidated Workspace thread evidence.");
      if (!Object.hasOwn(original, "profileKey")) delete copied.profileKey;
      return copied;
    },
  );
  for (const key of Object.keys(value)) {
    if (!Object.hasOwn(wire, key) || !isDeepStrictEqual(value[key], wire[key]))
      throw new Error(
        "Consolidated Workspace evidence cannot drop or normalize unknown facts.",
      );
  }
  if (
    (parsed.workspaceRestore &&
      parsed.workspaceRestore.profileName !== profile) ||
    (parsed.sessionReplacement &&
      parsed.sessionReplacement.profileName !== profile) ||
    parsed.threads.some(
      (record) =>
        record.owner &&
        "baleProfile" in record.owner &&
        record.owner.baleProfile !== undefined &&
        record.owner.baleProfile !== profile,
    )
  )
    throw new Error("Foreign consolidated Workspace profile evidence.");
  assertWorkspaceRestoreBindingProtection(parsed);
  return parsed;
}

export function resolveBaleWorkspaceProvisionRecoveryPath(
  statePath: string,
  profileName = "default",
  layout?: "consolidated",
): string {
  if (layout !== undefined && layout !== "consolidated")
    throw new Error("Invalid Workspace provisioning recovery layout.");
  return layout === "consolidated"
    ? join(
        dirname(statePath),
        "runtime",
        `${basename(statePath)}.provision-recovery.${createHash("sha256").update(profileName).digest("hex").slice(0, 16)}.json`,
      )
    : `${statePath}.provision-recovery.json`;
}

export interface BaleConsolidatedWorkspaceStorageOptions {
  getPath: () => string;
  getProfile: () => string | undefined;
  /** Exact owner/context/session grant captured before the caller's first await. */
  captureAuthority: () => (() => boolean) | undefined;
  publishIfOwned: NonNullable<
    BaleLockRuntime<BaleLockContext>["publishStateSectionIfOwned"]
  >;
}
export type BaleWorkspaceStatePublication = <T>(
  mutate: (current: unknown) => BaleRuntimeStateMutation<T>,
  publication?: Partial<
    Pick<
      BaleOwnedStatePublicationOptions,
      "onPublicationBoundary" | "publishRename" | "isCurrent"
    >
  >,
) => BaleOwnedStatePublicationResult<T>;

/** Prepared Workspace IO adapter; transition/CAS policy remains with the existing Threads owner. */
export function createBaleConsolidatedWorkspaceStorage(
  options: BaleConsolidatedWorkspaceStorageOptions,
) {
  const { getPath, getProfile, captureAuthority, publishIfOwned } = options;
  const profileName = (): string => getProfile() ?? "default";
  const readRaw = (): unknown => {
    const path = getPath(),
      profile = profileName(),
      root = readBaleRuntimeState(path);
    const raw = Object.hasOwn(root.profiles, profile)
      ? root.profiles[profile]?.workspace
      : undefined;
    parseBaleWorkspaceStateSection(raw, profile);
    if (path !== getPath() || profile !== profileName())
      throw new Error("Workspace storage scope changed during observation.");
    return raw;
  };
  return {
    readRaw,
    read: () => parseBaleWorkspaceStateSection(readRaw(), profileName()),
    capturePublication(): BaleWorkspaceStatePublication | undefined {
      const path = getPath(),
        profile = profileName(),
        authority = captureAuthority();
      if (!authority) return undefined;
      const isCurrent = (): boolean =>
        path === getPath() && profile === profileName() && authority() === true;
      if (!isCurrent()) return undefined;
      return <T>(
        mutate: (current: unknown) => BaleRuntimeStateMutation<T>,
        publication?: Partial<
          Pick<
            BaleOwnedStatePublicationOptions,
            "onPublicationBoundary" | "publishRename" | "isCurrent"
          >
        >,
      ) => {
        const sourceCurrent = publication?.isCurrent;
        const currentGrant = () => isCurrent() && (sourceCurrent?.() ?? true);
        if (!currentGrant()) return { committed: false };
        return publishIfOwned<T>(
          "workspace",
          (current) => {
            parseBaleWorkspaceStateSection(current, profile);
            const next = mutate(current);
            if (next.value === undefined && current !== undefined)
              throw new Error(
                "Consolidated Workspace section removal is not authorized.",
              );
            parseBaleWorkspaceStateSection(next.value, profile);
            return next;
          },
          {
            ...publication,
            isCurrent: currentGrant,
            expectedScope: { path, profile },
          },
        );
      };
    },
  };
}

function getBaleStateSemanticSnapshot(
  value: unknown,
): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  const { writtenAtMs: _writtenAtMs, ...semantic } = value as Record<
    string,
    unknown
  >;
  return semantic;
}

function parseFollowerRecoveryHints(
  value: unknown,
): Map<string, { slot?: string; threadName?: string }> {
  const hints = new Map<string, { slot?: string; threadName?: string }>();
  if (!value || typeof value !== "object" || Array.isArray(value)) return hints;
  const liveRoster = (value as Record<string, unknown>).liveRoster;
  if (
    !liveRoster ||
    typeof liveRoster !== "object" ||
    Array.isArray(liveRoster)
  )
    return hints;
  const followers = (liveRoster as Record<string, unknown>).busFollowers;
  if (!Array.isArray(followers)) return hints;
  for (const follower of followers) {
    if (!follower || typeof follower !== "object" || Array.isArray(follower))
      continue;
    const record = follower as Record<string, unknown>;
    const target = record.target;
    if (!target || typeof target !== "object" || Array.isArray(target))
      continue;
    const targetRecord = target as Record<string, unknown>;
    if (typeof targetRecord.chatId !== "number") continue;
    const normalizedTarget: BaleTarget = {
      chatId: targetRecord.chatId,
      ...(typeof targetRecord.threadId === "number"
        ? { threadId: targetRecord.threadId }
        : {}),
    };
    const slot =
      typeof targetRecord.slot === "string" && /^[A-Z]$/.test(targetRecord.slot)
        ? targetRecord.slot
        : typeof record.slot === "string" && /^[A-Z]$/.test(record.slot)
          ? record.slot
          : undefined;
    const threadName =
      typeof targetRecord.threadName === "string"
        ? targetRecord.threadName
        : typeof record.threadName === "string"
          ? record.threadName
          : undefined;
    hints.set(getTargetRecoveryHintKey(normalizedTarget), {
      ...(slot ? { slot } : {}),
      ...(threadName ? { threadName } : {}),
    });
  }
  return hints;
}

function getInstanceProcessKey(
  instanceId: string | undefined,
): string | undefined {
  if (!instanceId) return undefined;
  const [pid] = instanceId.split(":", 1);
  return pid && /^\d+$/.test(pid) ? pid : undefined;
}

export function isSameBaleProcessInstance(
  left: string | undefined,
  right: string | undefined,
): boolean {
  const leftProcess = getInstanceProcessKey(left);
  return !!leftProcess && leftProcess === getInstanceProcessKey(right);
}

function isPendingProvisionLiveOrTargeted(
  provision: BaleThreadPendingProvision,
  nowMs: number,
): boolean {
  if (provision.status === "ambiguous") return true;
  if (provision.expiresAtMs === undefined || provision.expiresAtMs > nowMs) {
    return true;
  }
  return !!provision.target;
}

/** Resolving selects a scope-bound view of the existing Workspace owner; it creates no files. */
export function createBaleWorkspaceRestoreResolver(deps: {
  getProfileName: () => string | undefined;
  getBotToken: () => string | undefined;
  threadStore: Pick<BaleTopicTargetStore, "workspaceRestore">;
  agentDir?: string;
}) {
  const { getProfileName, getBotToken, threadStore, agentDir } = deps;
  let active:
    | {
        profileName: string;
        tokenSha256: string;
        store: BaleWorkspaceRestore;
      }
    | undefined;
  return () => {
    const profile = getProfileName();
    const profileName = profile ?? "default";
    const token = getBotToken();
    if (!token) return undefined;
    const tokenSha256 = createHash("sha256").update(token).digest("hex");
    if (
      active?.profileName === profileName &&
      active.tokenSha256 === tokenSha256
    )
      return active.store;
    const store = threadStore.workspaceRestore({
      profileName,
      tokenSha256,
      legacyPath: resolveBaleProfileTempFilePath(
        "workspace-restore",
        "json",
        agentDir,
        profile,
      ),
      isCurrentScope: () =>
        (getProfileName() ?? "default") === profileName &&
        createHash("sha256")
          .update(getBotToken() ?? "")
          .digest("hex") === tokenSha256,
    });
    active = { profileName, tokenSha256, store };
    return store;
  };
}

export function createBaleTopicTargetStore(
  options: BaleTopicTargetStoreOptions,
): BaleTopicTargetStore {
  if (options.consolidated && options.commitPersist)
    throw new Error("Workspace must select one publication backend.");
  const consolidated = options.consolidated
    ? { ...options.consolidated }
    : undefined;
  const commitPersist = options.commitPersist?.bind(options);
  const getNowMs = options.getNowMs ?? Date.now;
  const captureExternalReservedSlots = (): string[] | undefined => {
    try {
      const slots = options.getExternalReservedSlots?.() ?? [];
      if (
        !Array.isArray(slots) ||
        slots.some((slot) => typeof slot !== "string" || !/^[A-Z]$/u.test(slot))
      ) {
        return undefined;
      }
      return Array.from(new Set(slots));
    } catch {
      return undefined;
    }
  };
  let botState: BaleBotStateSnapshot = { threadMode: "unknown" };
  let records = new Map<string, BaleTopicTargetRecord>();
  let identities = new Map<string, BaleThreadIdentityRecord>();
  let workspaceBindings = new Map<string, BaleWorkspaceThreadBinding>();
  let workspaceRetirements: BaleWorkspaceRetirementIntent[] = [];
  let workspaceRestore: BaleWorkspaceRestoreSnapshot | undefined;
  let sessionReplacement: BaleSessionReplacementIntent | undefined;
  let workspaceRetirementCommitInFlight = false;
  const hasWorkspaceRetirementConflict = (input: {
    bindingKey?: string;
    cwd?: string;
    target?: BaleTarget;
    slot?: string;
  }): boolean =>
    workspaceRetirements.some(
      (intent) =>
        (input.bindingKey !== undefined &&
          intent.binding.bindingKey === input.bindingKey) ||
        (input.cwd !== undefined && intent.binding.cwd === input.cwd) ||
        (input.target !== undefined &&
          targetMatches(intent.binding.target, input.target)) ||
        (input.slot !== undefined && intent.binding.slot === input.slot),
    );
  let workspaceClaims = new Map<
    string,
    {
      identity: BaleWorkspaceBindingIdentity;
      instanceId: string;
    }
  >();
  let reservations: BaleThreadReservation[] = [];
  let pendingProvisions: BaleThreadPendingProvision[] = [];
  let pendingCleanups: BaleThreadCleanupIntent[] = [];
  /** External reservations, an in-flight retirement or a competing claim block moving a binding onto its slot. */
  const isWorkspaceTransitionSlotBlocked = (
    binding: Pick<BaleWorkspaceThreadBinding, "bindingKey" | "slot">,
  ): boolean => {
    const slots = captureExternalReservedSlots();
    return (
      !slots ||
      slots.includes(binding.slot!) ||
      workspaceRetirementCommitInFlight ||
      Array.from(workspaceClaims.values()).some(
        (value) =>
          value.identity.bindingKey === binding.bindingKey ||
          value.identity.slot === binding.slot,
      )
    );
  };
  /** Current records, claims, reservations, provisions, cleanups or other retirements still holding a binding's Thread or slot. */
  const isWorkspaceBindingLocallyProtected = (
    binding: Pick<
      BaleWorkspaceThreadBinding,
      "bindingKey" | "target" | "slot"
    >,
    nowMs: number,
    options: {
      isRetirementExcluded?: (
        intent: BaleWorkspaceRetirementIntent,
        index: number,
      ) => boolean;
    } = {},
  ): boolean => {
    const slotMatches = (slot: string | undefined): boolean =>
      !!binding.slot && slot === binding.slot;
    const targetOrSlotMatches = (candidate: {
      target?: BaleTarget;
      slot?: string;
    }): boolean =>
      (!!candidate.target && targetMatches(candidate.target, binding.target)) ||
      slotMatches(candidate.slot);
    return (
      Array.from(records.values()).some(
        (record) =>
          ThreadReconciler.isCurrentThreadRecord(record) &&
          targetOrSlotMatches(record),
      ) ||
      Array.from(workspaceClaims.values()).some(
        (claim) =>
          claim.identity.bindingKey === binding.bindingKey ||
          slotMatches(claim.identity.slot),
      ) ||
      reservations.some(
        (reservation) =>
          (reservation.expiresAtMs === undefined ||
            reservation.expiresAtMs > nowMs) &&
          targetOrSlotMatches(reservation),
      ) ||
      pendingProvisions.some(
        (provision) =>
          isPendingProvisionLiveOrTargeted(provision, nowMs) &&
          targetOrSlotMatches(provision),
      ) ||
      pendingCleanups.some(targetOrSlotMatches) ||
      workspaceRetirements.some(
        (intent, index) =>
          !options.isRetirementExcluded?.(intent, index) &&
          (intent.binding.bindingKey === binding.bindingKey ||
            targetOrSlotMatches(intent.binding)),
      )
    );
  };
  let syncObservations: BaleTopicSyncObservation[] = [];
  let followerRecoveryHints = new Map<
    string,
    { slot?: string; threadName?: string }
  >();
  let loaded = false;
  let loadedPath: string | undefined;
  let loadedProfile: string | undefined;
  let observedWorkspaceSemantic: Record<string, unknown> | undefined;
  let dirty = false;
  let mutationRevision = 0;
  let persistQueue: Promise<void> = Promise.resolve();
  let statusQueue: Promise<void> = Promise.resolve();
  let lastStatusSemantic: Record<string, unknown> | undefined;
  let lastStatusPath: string | undefined;
  let statusSnapshot: {
    runtime?: Record<string, unknown>;
    liveRoster?: Record<string, unknown>;
    diagnostics?: Record<string, unknown>;
  } = {};

  const reconcileWorkspaceSuffixExposure = (): void => {
    const directoryCounts = new Map<string, number>();
    const exposed = new Set<string>();
    for (const binding of workspaceBindings.values()) {
      directoryCounts.set(
        binding.cwd,
        (directoryCounts.get(binding.cwd) ?? 0) + 1,
      );
      if (binding.showSlotSuffix) exposed.add(binding.cwd);
    }
    for (const binding of workspaceBindings.values()) {
      if (
        (directoryCounts.get(binding.cwd) ?? 0) > 1 ||
        exposed.has(binding.cwd)
      ) {
        binding.showSlotSuffix = true;
      }
    }
  };
  const rememberSlot = (slot: string | undefined, nowMs = getNowMs()) => {
    if (!slot || !/^[A-Z]$/.test(slot)) return;
    botState = { ...botState, lastSlot: slot, updatedAtMs: nowMs };
  };
  const rememberIdentity = (record: BaleTopicTargetRecord) => {
    const profileKey = getRecordOwnerKey(record);
    if (!record.threadName && !record.slot) return;
    identities.set(profileKey, {
      profileKey,
      ...(record.threadName ? { threadName: record.threadName } : {}),
      ...(record.slot ? { slot: record.slot } : {}),
      updatedAtMs: record.updatedAtMs,
    });
  };
  const resolveWorkspaceKey = (cwd: string): string | undefined => {
    const known = [
      ...Array.from(workspaceBindings.values()),
      ...Array.from(workspaceClaims.values()).map((claim) => claim.identity),
    ];
    const existing = known.find((binding) => binding.cwd === cwd);
    if (existing) return existing.workspaceKey;
    const readable = createBaleWorkspaceDirectoryKey(cwd);
    if (!readable) return undefined;
    const collision = known.some(
      (binding) => binding.workspaceKey === readable && binding.cwd !== cwd,
    );
    if (!collision) return readable;
    const digest = createHash("sha256").update(cwd).digest("hex").slice(0, 12);
    const prefix = readable.endsWith("--") ? readable.slice(0, -2) : readable;
    return `${prefix.slice(0, BALE_WORKSPACE_KEY_MAX_LENGTH - digest.length - 3)}-${digest}--`;
  };
  const isWorkspaceTargetLive = (
    binding: BaleWorkspaceThreadBinding,
  ): BaleTopicTargetRecord | undefined =>
    Array.from(records.values()).find(
      (record) =>
        ThreadReconciler.isCurrentThreadRecord(record) &&
        targetMatches(record.target, binding.target),
    );
  const findLegacyWorkspaceMigrationRecord = (
    cwd: string,
    instanceId: string,
    previousInstanceId?: string,
  ): BaleTopicTargetRecord | undefined => {
    const processIds = new Set(
      [instanceId, previousInstanceId].filter(
        (value): value is string => !!value,
      ),
    );
    return Array.from(records.values())
      .filter((record) => {
        const owner = getRecordOwner(record);
        const belongsToWorkspace =
          owner.kind === "leader"
            ? owner.cwd
              ? normalizeBaleWorkspacePath(owner.cwd) === cwd
              : !!record.instanceId &&
                Array.from(processIds).some((processId) =>
                  isSameBaleProcessInstance(record.instanceId, processId),
                )
            : owner.kind === "manual-follower" &&
              (processIds.has(owner.instanceId) ||
                (!!record.instanceId && processIds.has(record.instanceId)));
        if (!belongsToWorkspace) return false;
        const targetBinding = Array.from(workspaceBindings.values()).find(
          (binding) => targetMatches(binding.target, record.target),
        );
        return !targetBinding || targetBinding.cwd === cwd;
      })
      .sort((left, right) => right.updatedAtMs - left.updatedAtMs)[0];
  };

  const getPath = () =>
    typeof options.path === "function" ? options.path() : options.path;
  /** The non-canonical projection sits beside canonical state (`state*.json` → `status*.json`). */
  const getStatusPath = (): string => {
    const statePath = getPath(),
      name = basename(statePath);
    return join(
      dirname(statePath),
      /^state/u.test(name)
        ? name.replace(/^state/u, "status")
        : `${name}.status`,
    );
  };
  const getBaleProfile = () =>
    typeof options.baleProfile === "function"
      ? options.baleProfile()
      : options.baleProfile;
  const scopeOwnerToActiveProfile = (
    owner: BaleThreadOwner,
  ): BaleThreadOwner => {
    const baleProfile = getBaleProfile();
    if (
      !baleProfile ||
      owner.kind === "pending-topic" ||
      owner.kind === "legacy" ||
      owner.baleProfile
    ) {
      return owner;
    }
    return { ...owner, baleProfile };
  };
  const activeProfile = () => getBaleProfile() ?? "default";
  const scopeMatches = (path: string, profile: string) =>
    getPath() === path && activeProfile() === profile;
  const loadedScopeMatches = (path: string) =>
    loadedPath === path && (!consolidated || loadedProfile === activeProfile());
  const workspaceIO = consolidated
    ? createBaleConsolidatedWorkspaceStorage({
        getPath,
        getProfile: getBaleProfile,
        ...consolidated,
      })
    : undefined;
  const runtimeProjection = consolidated
    ? createBaleRuntimeProjectionStore({
        getPath,
        getProfile: getBaleProfile,
        captureAuthority: consolidated.captureAuthority,
        getNowMs,
        storage: {
          read({ path, profile }) {
            const root = readBaleRuntimeState(path);
            return Object.hasOwn(root.profiles, profile)
              ? root.profiles[profile]?.runtime
              : undefined;
          },
          publish(expectedScope, mutate, isCurrent) {
            const outcome = consolidated.publishIfOwned(
              "runtime",
              (current) => {
                const next = mutate(current);
                return { value: next.value, result: next.changed };
              },
              { isCurrent, expectedScope },
            );
            return outcome.committed && outcome.result;
          },
        },
      })
    : undefined;
  let workspaceFrame:
    { path: string; profile: string; value: unknown } | undefined;
  const readStoreSnapshot = (
    path: string,
    requirePrivate = true,
    asynchronous = false,
  ): unknown => {
    if (!workspaceIO)
      return readWorkspaceSnapshot(path, requirePrivate, asynchronous);
    if (path !== getPath())
      throw new Error("Workspace storage scope changed during observation.");
    if (workspaceFrame) {
      if (!scopeMatches(workspaceFrame.path, workspaceFrame.profile))
        throw new Error("Workspace transaction scope changed.");
      return workspaceFrame.value;
    }
    const value = workspaceIO.readRaw();
    return asynchronous ? Promise.resolve(value) : value;
  };
  const withStoreTransaction = <T>(
    path: string,
    operation: () => T,
    publication?: Parameters<BaleWorkspaceStatePublication>[1],
  ): T => {
    if (!workspaceIO)
      return withBaleFileTransaction(`${path}.transaction`, operation);
    if (workspaceFrame)
      throw new Error("Nested Workspace transaction is not allowed.");
    const profile = activeProfile(),
      publish = workspaceIO.capturePublication();
    if (!publish || path !== getPath())
      throw new Error("Workspace publication authority changed.");
    const outcome = publish((value) => {
      workspaceFrame = { path, profile, value };
      try {
        const result = operation();
        return { value: workspaceFrame.value, result };
      } finally {
        workspaceFrame = undefined;
      }
    }, publication);
    if (!outcome.committed)
      throw new Error("Workspace publication authority changed.");
    return outcome.result;
  };
  const getRecoveryPath = (path: string) =>
    consolidated
      ? resolveBaleWorkspaceProvisionRecoveryPath(
          path,
          activeProfile(),
          "consolidated",
        )
      : resolveBaleWorkspaceProvisionRecoveryPath(path);
  const readProvisionRecoveries = (
    path: string,
    strict = false,
  ): BaleProvisionRecoveryFile => {
    const recoveryPath = getRecoveryPath(path);
    if (strict) {
      const value = readWorkspaceSnapshot(recoveryPath);
      if (value === undefined) return {};
      if (!restoreObject(value))
        throw new Error("Invalid Workspace provisioning recovery evidence.");
      return value as BaleProvisionRecoveryFile;
    }
    if (!existsSync(recoveryPath)) return {};
    try {
      const value = JSON.parse(readFileSync(recoveryPath, "utf8")) as unknown;
      return value && typeof value === "object" && !Array.isArray(value)
        ? (value as BaleProvisionRecoveryFile)
        : {};
    } catch {
      return {};
    }
  };
  const assertRestoreRecoveryProtection = (
    path: string,
    operations: readonly Pick<BaleWorkspaceRestoreIntent, "request">[],
    provisions: readonly BaleThreadPendingProvision[],
    requireKnownTargets = false,
    recoveryEvidence?: BaleProvisionRecoveryFile,
  ): void => {
    if (!operations.length) return;
    const recoveries = recoveryEvidence ?? readProvisionRecoveries(path, true);
    for (const provision of provisions) {
      let target = provision.target;
      if (Object.hasOwn(recoveries, provision.id)) {
        const recovery = recoveries[provision.id];
        if (!restoreObject(recovery))
          throw new Error("Invalid Workspace provisioning recovery evidence.");
        if (
          recovery.instanceId === provision.instanceId &&
          recovery.profileKey === provision.profileKey &&
          recovery.leaderEpoch === provision.leaderEpoch
        ) {
          const observed = recovery.target;
          if (
            !restoreObject(observed) ||
            typeof observed.chatId !== "number" ||
            !Number.isSafeInteger(observed.chatId) ||
            !restoreInteger(observed.threadId) ||
            observed.threadId === 0
          )
            throw new Error(
              "Invalid Workspace provisioning recovery evidence.",
            );
          const recovered = {
            chatId: observed.chatId,
            threadId: observed.threadId,
          };
          if (target && !targetMatches(target, recovered))
            throw new Error(
              "Conflicting Workspace provisioning target evidence.",
            );
          target = recovered;
        }
      }
      if (requireKnownTargets && !target)
        throw new Error(
          "Workspace Restore target availability is unknown during unfinished creation.",
        );
      if (
        operations.some(({ request }) =>
          conflictsWithWorkspaceRestoreProvision(request, {
            ...provision,
            target,
          }),
        )
      )
        throw new Error(
          "Protected Workspace Restore provisioning recovery conflict.",
        );
    }
  };
  const resetForPath = (path: string) => {
    if (loadedScopeMatches(path)) return;
    botState = { threadMode: "unknown" };
    records = new Map();
    identities = new Map();
    workspaceBindings = new Map();
    workspaceRetirements = [];
    workspaceRestore = undefined;
    sessionReplacement = undefined;
    workspaceRetirementCommitInFlight = false;
    workspaceClaims = new Map();
    reservations = [];
    pendingProvisions = [];
    pendingCleanups = [];
    syncObservations = [];
    followerRecoveryHints = new Map();
    statusSnapshot = {};
    loaded = false;
    dirty = false;
    loadedPath = path;
    loadedProfile = activeProfile();
    observedWorkspaceSemantic = undefined;
  };

  const observeWorkspaceRestore = (
    incoming: BaleWorkspaceRestoreSnapshot | undefined,
  ): void => {
    if (
      workspaceRestore &&
      (!incoming ||
        incoming.profileName !== workspaceRestore.profileName ||
        incoming.tokenSha256 !== workspaceRestore.tokenSha256 ||
        incoming.revision < workspaceRestore.revision ||
        (incoming.revision === workspaceRestore.revision &&
          !isDeepStrictEqual(incoming, workspaceRestore)))
    )
      throw new Error(
        "Workspace Restore evidence moved backwards or changed without revision.",
      );
  };
  const withRestoreRegistration = (
    candidate: Parameters<
      BaleTopicTargetStore["assertWorkspaceRestoreRegistration"]
    >[0],
    publish?: () => void,
  ): void => {
    const path = getPath();
    withStoreTransaction(path, () => {
      const file = parseTopicTargetFile(readStoreSnapshot(path, false));
      observeWorkspaceRestore(file.workspaceRestore);
      const operations = file.workspaceRestore?.operations ?? [];
      if (operations.length) {
        if ((options.canPersist && !options.canPersist()) || getPath() !== path)
          throw new Error("Workspace Restore registration authority changed.");
        assertWorkspaceRestoreBindingProtection(file);
        assertRestoreRecoveryProtection(
          path,
          operations,
          file.pendingProvisions ?? [],
        );
        for (const { request } of operations) {
          if (
            targetMatches(candidate.target, request.binding.target) ||
            ((candidate.bindingKey === request.binding.bindingKey ||
              candidate.slot === request.binding.slot ||
              targetMatches(candidate.target, request.target)) &&
              (candidate.bindingKey !== request.binding.bindingKey ||
                candidate.slot !== request.binding.slot ||
                !targetMatches(candidate.target, request.target)))
          )
            throw new Error(
              "Protected Workspace Restore registration conflicts with its binding or target.",
            );
        }
      }
      if (publish && candidate.bindingKey !== undefined) {
        const bindings = (file.workspaceBindings ?? []).filter(
          (binding) => binding.bindingKey === candidate.bindingKey,
        );
        if (
          bindings.length !== 1 ||
          bindings[0]?.slot !== candidate.slot ||
          !targetMatches(bindings[0].target, candidate.target)
        )
          throw new Error(
            "Workspace registration binding changed before publication.",
          );
      }
      publish?.();
    });
  };
  const loadFromDisk = async () => {
    const path = getPath(),
      profile = activeProfile();
    resetForPath(path);
    const revision = mutationRevision;
    const rawFile = await readStoreSnapshot(path, !!workspaceRestore, true);
    // A read begun before a local mutation cannot replace the newly admitted projection.
    if (
      mutationRevision !== revision ||
      getPath() !== path ||
      (consolidated && !scopeMatches(path, profile))
    )
      return;
    if (consolidated)
      observedWorkspaceSemantic = getBaleStateSemanticSnapshot(rawFile);
    if (rawFile === undefined) {
      if (workspaceRestore?.revision)
        throw new Error("Workspace Restore evidence disappeared.");
      botState = { threadMode: "unknown" };
      records = new Map();
      identities = new Map();
      workspaceBindings = new Map();
      workspaceRetirements = [];
      workspaceRestore = undefined;
      sessionReplacement = undefined;
      workspaceRetirementCommitInFlight = false;
      reservations = [];
      pendingProvisions = [];
      pendingCleanups = [];
      syncObservations = [];
      followerRecoveryHints = new Map();
      loaded = true;
      return;
    }
    const file = parseTopicTargetFile(rawFile);
    observeWorkspaceRestore(file.workspaceRestore);
    const recoveries = readProvisionRecoveries(
      path,
      !!file.workspaceRestore?.operations.length,
    );
    assertRestoreRecoveryProtection(
      path,
      file.workspaceRestore?.operations ?? [],
      file.pendingProvisions ?? [],
      false,
      recoveries,
    );
    try {
      followerRecoveryHints = parseFollowerRecoveryHints(
        consolidated
          ? runtimeProjection?.read()
          : JSON.parse(readFileSync(getStatusPath(), "utf8")),
      );
    } catch {
      followerRecoveryHints = new Map();
    }
    botState = file.bot;
    const scopedRecords = file.threads.map((record) =>
      cloneRecord({
        ...record,
        owner: scopeOwnerToActiveProfile(getRecordOwner(record)),
      }),
    );
    records = new Map(
      scopedRecords.map((record) => [getRecordOwnerKey(record), record]),
    );
    identities = new Map(
      (file.identities ?? []).map((identity) => {
        const owner = scopeOwnerToActiveProfile(
          getBaleThreadOwnerFromProfileKey(identity.profileKey),
        );
        const profileKey = getBaleThreadOwnerKey(owner);
        return [profileKey, cloneIdentityRecord({ ...identity, profileKey })];
      }),
    );
    workspaceBindings = indexWorkspaceBindings(file.workspaceBindings ?? []);
    workspaceRetirements = (file.workspaceRetirements ?? []).map(
      cloneWorkspaceRetirementIntent,
    );
    workspaceRestore = structuredClone(file.workspaceRestore);
    sessionReplacement = file.sessionReplacement
      ? cloneSessionReplacementIntent(file.sessionReplacement)
      : undefined;
    reconcileWorkspaceSuffixExposure();
    for (const record of records.values()) rememberIdentity(record);
    const nowMs = getNowMs();
    reservations = (file.reservations ?? [])
      .filter(
        (reservation) =>
          reservation.expiresAtMs === undefined ||
          reservation.expiresAtMs > nowMs,
      )
      .map((reservation) => ({ ...reservation }));
    pendingProvisions = (file.pendingProvisions ?? [])
      .map((provision) => {
        const recovery = recoveries[provision.id];
        const recoveryMatches =
          recovery?.instanceId === provision.instanceId &&
          recovery.profileKey === provision.profileKey &&
          recovery.leaderEpoch === provision.leaderEpoch &&
          Number.isInteger(recovery.target?.threadId);
        return {
          ...provision,
          ...(recoveryMatches
            ? { target: { ...recovery.target }, status: "ambiguous" as const }
            : provision.target
              ? { target: { ...provision.target } }
              : {}),
        };
      })
      .filter((provision) =>
        isPendingProvisionLiveOrTargeted(provision, nowMs),
      );
    pendingCleanups = (file.pendingCleanups ?? []).map((intent) => ({
      ...intent,
      target: { ...intent.target },
    }));
    syncObservations = (file.syncObservations ?? []).map((observation) => ({
      ...observation,
      target: { ...observation.target },
    }));
    loaded = true;
    dirty = false;
  };

  const markDirty = (): void => {
    if (consolidated && !loadedScopeMatches(getPath())) {
      if (loadedPath !== undefined)
        throw new Error(
          "Workspace projection must refresh after scope change.",
        );
      loadedPath = getPath();
      loadedProfile = activeProfile();
    }
    loaded = true;
    dirty = true;
    mutationRevision += 1;
  };

  const markWorkspaceBindingInactiveByTarget = (
    target: BaleTarget,
    inactiveSinceMs = getNowMs(),
  ): boolean => {
    if (!Number.isFinite(inactiveSinceMs) || inactiveSinceMs < 0) return false;
    for (const [key, binding] of workspaceBindings) {
      if (
        !targetMatches(binding.target, target) ||
        binding.inactiveSinceMs !== undefined
      )
        continue;
      workspaceBindings.set(key, { ...binding, inactiveSinceMs });
      markDirty();
      return true;
    }
    return false;
  };

  const persistSnapshot = (
    transition?: {
      target: BaleTarget;
      isCurrent: () => boolean;
    } & (
      | { kind: "invalidate"; lastSyncError: string }
      | { kind: "detach"; owner: BaleTopicTargetRecord }
      | ({
          kind: "manual-name";
          owner: BaleTopicTargetRecord;
          bindings: BaleWorkspaceThreadBinding[];
        } & (
          | { threadName: string; updateDisplayTitle: boolean }
          | { automaticTitle: string }
        ))
      | {
          kind: "relocate" | "live-rebind";
          operationId: string;
          owner: BaleTopicTargetRecord;
          binding: BaleWorkspaceThreadBinding;
          nextTarget: BaleTarget & { threadId: number };
          restore: BaleWorkspaceRestoreSnapshot;
          maxBytes: number;
          onPublicationBoundary?: BaleWorkspaceRestoreOptions["onPublicationBoundary"];
        }
    ),
    isCurrentPublication?: () => boolean,
    resetProvisions?: readonly BaleThreadPendingProvision[],
  ): Promise<boolean> => {
    const submittedPath = getPath(),
      submittedProfile = activeProfile();
    const publishWorkspace = workspaceIO?.capturePublication();
    const persist = persistQueue.then(async () => {
      const path = getPath();
      if (
        workspaceIO &&
        (!publishWorkspace ||
          !scopeMatches(submittedPath, submittedProfile) ||
          (dirty && !loadedScopeMatches(path)))
      )
        return false;
      if (!loadedScopeMatches(path) && !dirty) resetForPath(path);
      if (options.canPersist && !options.canPersist()) {
        if (!transition) await loadFromDisk();
        return false;
      }
      if (isCurrentPublication?.() === false) return false;
      // A staged name transition validates its captured projection at commit; do not refresh it away.
      if (!loaded || (!dirty && transition?.kind !== "manual-name"))
        await loadFromDisk();
      if (
        workspaceIO &&
        (!scopeMatches(submittedPath, submittedProfile) ||
          !loadedScopeMatches(path))
      )
        return false;
      if (transition && !transition.isCurrent()) return false;
      const nowMs = getNowMs();
      reservations = reservations.filter(
        (reservation) =>
          reservation.expiresAtMs === undefined ||
          reservation.expiresAtMs > nowMs,
      );
      pendingProvisions = pendingProvisions.filter((provision) =>
        isPendingProvisionLiveOrTargeted(provision, nowMs),
      );
      const currentRecords = Array.from(records.values())
        .filter(isPersistedThreadRecord)
        .map(cloneRecord);
      const manualNameMatches = (
        snapshot: Pick<
          BaleTopicTargetFile,
          "threads" | "workspaceBindings"
        >,
      ) => {
        if (transition?.kind !== "manual-name") return true;
        const owners = snapshot.threads.filter((record) =>
          targetMatches(record.target, transition.target),
        );
        const bindings = (snapshot.workspaceBindings ?? []).filter((binding) =>
          targetMatches(binding.target, transition.target),
        );
        return (
          owners.length === 1 &&
          isDeepStrictEqual(normalizeRecord(owners[0]), transition.owner) &&
          isDeepStrictEqual(bindings, transition.bindings)
        );
      };
      if (transition?.kind === "detach") {
        const owners = currentRecords.filter((record) =>
          targetMatches(record.target, transition.target),
        );
        if (
          owners.length !== 1 ||
          !isDeepStrictEqual(normalizeRecord(owners[0]), transition.owner)
        )
          return false;
      }
      if (
        !manualNameMatches({
          threads: currentRecords,
          workspaceBindings: Array.from(workspaceBindings.values()),
        }) ||
        (transition?.kind === "manual-name" &&
          hasWorkspaceRetirementConflict({ target: transition.target }))
      )
        return false;
      if (
        transition?.kind === "relocate" ||
        transition?.kind === "live-rebind"
      ) {
        const { binding, owner, nextTarget } = transition;
        const request =
          transition.kind === "live-rebind"
            ? transition.restore.liveRebindings?.at(-1)?.request
            : transition.restore.operations.at(-1)?.request;
        const slots = captureExternalReservedSlots();
        const sourceBindings = Array.from(workspaceBindings.values()).filter(
          (value) => targetMatches(value.target, binding.target),
        );
        const sourceOwners = currentRecords.filter((value) =>
          targetMatches(value.target, binding.target),
        );
        if (
          !request ||
          pendingWorkspaceRelocationRequests(workspaceRestore).some((value) =>
            workspaceRestoresConflict(value, request),
          ) ||
          !binding.sessionId ||
          !binding.slot ||
          !/^[A-Z]$/.test(binding.slot) ||
          binding.inactiveSinceMs !== undefined ||
          owner.status !== "active" ||
          !owner.instanceId ||
          owner.slot !== binding.slot ||
          !["leader", "manual-follower"].includes(owner.owner?.kind ?? "") ||
          (owner.owner?.kind === "leader" &&
            (owner.owner.cwd !== binding.cwd ||
              owner.owner.instanceId !== owner.instanceId)) ||
          !targetMatches(owner.target, binding.target) ||
          sourceBindings.length !== 1 ||
          !isDeepStrictEqual(sourceBindings[0], binding) ||
          sourceOwners.length !== 1 ||
          !isDeepStrictEqual(sourceOwners[0], owner) ||
          !slots ||
          slots.includes(binding.slot) ||
          workspaceRetirementCommitInFlight ||
          hasWorkspaceRetirementConflict(binding) ||
          hasWorkspaceRetirementConflict({ target: nextTarget }) ||
          Array.from(workspaceBindings.values()).some(
            (value) =>
              value.bindingKey !== binding.bindingKey &&
              (value.slot === binding.slot ||
                targetMatches(value.target, nextTarget)),
          ) ||
          currentRecords.some(
            (value) =>
              targetMatches(value.target, nextTarget) ||
              (!targetMatches(value.target, binding.target) &&
                value.slot === binding.slot),
          ) ||
          Array.from(workspaceClaims.values()).some(
            (value) =>
              value.identity.bindingKey === binding.bindingKey ||
              value.identity.slot === binding.slot,
          ) ||
          reservations.some(
            (value) =>
              value.slot === binding.slot ||
              targetMatches(value.target, binding.target) ||
              targetMatches(value.target, nextTarget),
          ) ||
          pendingProvisions.some(
            (value) =>
              value.workspaceBindingKey === binding.bindingKey ||
              value.instanceId === owner.instanceId ||
              value.profileKey === owner.profileKey ||
              value.slot === binding.slot ||
              (value.target &&
                (targetMatches(value.target, binding.target) ||
                  targetMatches(value.target, nextTarget))),
          ) ||
          pendingCleanups.some(
            (value) =>
              targetMatches(value.target, binding.target) ||
              targetMatches(value.target, nextTarget),
          ) ||
          syncObservations.some(
            (value) =>
              targetMatches(value.target, nextTarget) &&
              (value.syncStatus === "deleted" || value.syncStatus === "closed"),
          ) ||
          (sessionReplacement &&
            ((sessionReplacement.cwd === binding.cwd &&
              sessionReplacement.sourceSessionId === binding.sessionId) ||
              targetMatches(sessionReplacement.target, binding.target) ||
              targetMatches(sessionReplacement.target, nextTarget)))
        )
          return false;
      }
      if (transition?.kind !== "manual-name")
        records = new Map(
          currentRecords.map((record) => [
            getRecordOwnerKey(record),
            cloneRecord(record),
          ]),
        );
      const persistedRevision = mutationRevision;
      const expectedRestore = structuredClone(workspaceRestore);
      const assertRestoreEvidenceCurrent = (
        raw?: unknown,
        fromTransaction = false,
      ): void => {
        if (isCurrentPublication?.() === false)
          throw new Error(
            "Bale Workspace publication lost its exact frame or authority.",
          );
        const disk = parseTopicTargetFile(
          fromTransaction
            ? raw
            : readStoreSnapshot(
                path,
                transition?.kind === "relocate" ||
                  transition?.kind === "live-rebind" ||
                  !!expectedRestore,
              ),
        );
        if (resetProvisions) {
          const recoveries = readProvisionRecoveries(path, true);
          if (mutationRevision !== persistedRevision || resetProvisions.some(expected =>
            expected.target || Object.hasOwn(recoveries, expected.id) ||
            !isDeepStrictEqual(disk.pendingProvisions?.find(value => value.id === expected.id), expected)))
            throw new Error("Bale connection recovery provisioning evidence changed.");
        }
        if (!isDeepStrictEqual(disk.workspaceRestore, expectedRestore))
          throw new Error(
            "Workspace Restore evidence changed before publication.",
          );
        if (
          !manualNameMatches(disk) ||
          (transition?.kind === "manual-name" &&
            disk.workspaceRetirements?.some((intent) =>
              targetMatches(intent.binding.target, transition.target),
            ))
        )
          throw new Error(
            "Workspace manual-name candidate changed before publication.",
          );
        assertWorkspaceRestoreBindingProtection(disk);
        assertRestoreRecoveryProtection(
          path,
          [
            ...(disk.workspaceRestore?.operations ?? []),
            ...(file.workspaceRestore?.operations ?? []),
          ],
          [
            ...(disk.pendingProvisions ?? []),
            ...(file.pendingProvisions ?? []),
          ],
        );
        const additions = (file.workspaceRestore?.operations ?? []).filter(
          (operation) =>
            !disk.workspaceRestore?.operations.some(
              (retained) =>
                retained.request.operationId === operation.request.operationId,
            ),
        );
        assertRestoreRecoveryProtection(
          path,
          additions,
          disk.pendingProvisions ?? [],
          true,
        );
      };
      const file = {
        version: 1,
        source: "snapshot",
        writtenAtMs: nowMs,
        bot: botState,
        identities: Array.from(identities.values()).map(cloneIdentityRecord),
        workspaceBindings: Array.from(workspaceBindings.values()).map(
          cloneWorkspaceBinding,
        ),
        workspaceRetirements: workspaceRetirements.map(
          cloneWorkspaceRetirementIntent,
        ),
        ...(workspaceRestore
          ? { workspaceRestore: structuredClone(workspaceRestore) }
          : {}),
        ...(sessionReplacement
          ? {
              sessionReplacement:
                cloneSessionReplacementIntent(sessionReplacement),
            }
          : {}),
        reservations: reservations.map((reservation) => ({ ...reservation })),
        pendingProvisions: pendingProvisions.filter(provision => !resetProvisions?.some(expected => expected.id === provision.id)).map((provision) => ({
          ...provision,
          ...(provision.target ? { target: { ...provision.target } } : {}),
        })),
        pendingCleanups: pendingCleanups.map((intent) => ({
          ...intent,
          target: { ...intent.target },
        })),
        syncObservations: syncObservations.map((observation) => ({
          ...observation,
          target: { ...observation.target },
        })),
        threads: currentRecords.map((record) => {
          const { profileKey: _profileKey, ...serialized } = record;
          return serialized;
        }),
      };
      if (transition) {
        const record = file.threads.find((record) =>
          targetMatches(record.target, transition.target),
        );
        if (!record) return false;
        if (transition.kind === "detach") {
          const bindings = file.workspaceBindings.filter((binding) =>
            targetMatches(binding.target, record.target),
          );
          if (
            bindings.length !== 1 ||
            !/^[A-Z]$/.test(record.slot ?? "") ||
            bindings[0]!.slot !== record.slot
          )
            return false;
        }
        if (
          transition.kind === "relocate" ||
          transition.kind === "live-rebind"
        ) {
          if (
            transition.restore.revision !==
              (workspaceRestore?.revision ?? 0) + 1 ||
            (transition.kind === "relocate"
              ? !isDeepStrictEqual(
                  transition.restore.operations.slice(0, -1),
                  workspaceRestore?.operations ?? [],
                )
              : !isDeepStrictEqual(
                  transition.restore.operations,
                  workspaceRestore?.operations ?? [],
                ) ||
                !isDeepStrictEqual(
                  transition.restore.liveRebindings?.slice(0, -1),
                  (workspaceRestore?.liveRebindings ?? []).filter(retainLiveRebind),
                ))
          )
            return false;
          file.workspaceRestore = structuredClone(transition.restore);
          parseWorkspaceRestore(file.workspaceRestore);
          if (
            Buffer.byteLength(JSON.stringify(file.workspaceRestore)) >
            transition.maxBytes
          )
            throw new Error("Workspace Restore byte capacity reached.");
          const binding = file.workspaceBindings.find(
            (value) => value.bindingKey === transition.binding.bindingKey,
          )!;
          binding.target = { ...transition.nextTarget };
          binding.updatedAtMs = nowMs;
          delete binding.displayTitle;
          record.target = { ...transition.nextTarget };
          record.updatedAtMs = nowMs;
          record.rerouteConfirmedAtMs = nowMs;
          record.syncStatus = "unknown";
          record.lastReconcileAction =
            transition.kind === "live-rebind"
              ? "workspace-live-rebind"
              : "workspace-restore";
          delete record.lastError;
          delete record.lastSyncError;
          delete record.lastSyncObservedAtMs;
          delete record.lastSyncProbeAtMs;
        } else if (transition.kind === "manual-name") {
          if ("automaticTitle" in transition) delete record.manualThreadName;
          else record.manualThreadName = transition.threadName;
          record.updatedAtMs = nowMs;
          for (const binding of file.workspaceBindings) {
            if (!targetMatches(binding.target, transition.target)) continue;
            if ("automaticTitle" in transition) {
              delete binding.manualThreadName;
              binding.displayTitle = transition.automaticTitle;
            } else {
              const previousTitle =
                binding.displayTitle ??
                binding.manualThreadName ??
                binding.threadName;
              binding.manualThreadName = transition.threadName;
              binding.displayTitle = transition.updateDisplayTitle
                ? transition.threadName
                : previousTitle;
            }
            binding.updatedAtMs = nowMs;
          }
        } else {
          file.threads = file.threads.filter(
            (candidate) => candidate !== record,
          );
          for (const binding of file.workspaceBindings) {
            if (
              targetMatches(binding.target, transition.target) &&
              binding.inactiveSinceMs === undefined
            ) {
              binding.inactiveSinceMs = nowMs;
            }
          }
          if (transition.kind === "invalidate") {
            file.syncObservations = file.syncObservations.filter(
              (observation) =>
                !targetMatches(observation.target, record.target),
            );
            file.syncObservations.push({
              target: { ...record.target },
              syncStatus: "deleted",
              observedAtMs: nowMs,
              ...(record.instanceId ? { instanceId: record.instanceId } : {}),
              ...(record.slot ? { slot: record.slot } : {}),
              lastSyncError: transition.lastSyncError,
              lastReconcileAction: "mark-stale",
            });
          }
        }
      }
      assertWorkspaceRestoreBindingProtection(file);
      assertRestoreRecoveryProtection(
        path,
        file.workspaceRestore?.operations ?? [],
        file.pendingProvisions ?? [],
      );
      if (publishWorkspace) {
        const wire = JSON.parse(JSON.stringify(file));
        const outcome = publishWorkspace(
          (current) => {
            if (
              !scopeMatches(submittedPath, submittedProfile) ||
              mutationRevision !== persistedRevision ||
              transition?.isCurrent() === false ||
              isCurrentPublication?.() === false
            )
              return { value: current, result: false };
            const semanticCurrent = getBaleStateSemanticSnapshot(current);
            if (!isDeepStrictEqual(semanticCurrent, observedWorkspaceSemantic))
              throw new Error(
                "Workspace canonical snapshot changed before publication.",
              );
            // A late whole-Workspace replacement cannot erase a concurrent canonical mutation.
            if (
              workspaceRestore &&
              !isDeepStrictEqual(
                parseTopicTargetFile(current).workspaceRestore,
                expectedRestore,
              )
            )
              throw new Error(
                "Workspace Restore evidence changed before publication.",
              );
            assertRestoreEvidenceCurrent(current, true);
            if (
              transition?.kind === "relocate" ||
              transition?.kind === "live-rebind"
            ) {
              if (isWorkspaceTransitionSlotBlocked(transition.binding))
                return { value: current, result: false };
            }
            const unchanged =
              !transition &&
              isDeepStrictEqual(
                semanticCurrent,
                getBaleStateSemanticSnapshot(wire),
              );
            return { value: unchanged ? current : wire, result: true };
          },
          {
            isCurrent: () =>
              scopeMatches(submittedPath, submittedProfile) &&
              mutationRevision === persistedRevision &&
              (transition?.isCurrent() ?? true) &&
              (isCurrentPublication?.() ?? true),
            onPublicationBoundary:
              transition?.kind === "relocate" ||
              transition?.kind === "live-rebind"
                ? (boundary) => {
                    if (boundary !== "before-write")
                      transition.onPublicationBoundary?.(boundary);
                  }
                : undefined,
          },
        );
        if (
          !outcome.committed ||
          !outcome.result ||
          isCurrentPublication?.() === false ||
          (transition?.kind === "manual-name" &&
            mutationRevision !== persistedRevision)
        )
          return false;
        loadedPath = path;
        loadedProfile = submittedProfile;
        loaded = true;
        observedWorkspaceSemantic = getBaleStateSemanticSnapshot(wire);
        if (resetProvisions) { pendingProvisions = file.pendingProvisions; mutationRevision += 1; }
        if (transition) {
          records = new Map(
            file.threads.map((record) => {
              const normalized = normalizeRecord(record)!;
              return [getRecordOwnerKey(normalized), cloneRecord(normalized)];
            }),
          );
          workspaceRestore = structuredClone(file.workspaceRestore);
          syncObservations = file.syncObservations;
          workspaceBindings = indexWorkspaceBindings(file.workspaceBindings);
          mutationRevision += 1;
        }
        dirty = false;
        return transition?.kind !== "manual-name" || transition.isCurrent();
      }
      let persistedSemanticSnapshot: Record<string, unknown> | undefined;
      try {
        persistedSemanticSnapshot = getBaleStateSemanticSnapshot(
          await readStoreSnapshot(path, !!workspaceRestore, true),
        );
      } catch {
        /* Final Restore validation fences missing or unverifiable snapshots before publication. */
      }
      // Normalize optional fields to wire JSON; object key order is not a state change.
      if (
        !transition &&
        isDeepStrictEqual(
          persistedSemanticSnapshot,
          getBaleStateSemanticSnapshot(JSON.parse(JSON.stringify(file))),
        ) &&
        mutationRevision === persistedRevision
      ) {
        if (isCurrentPublication?.() === false) return false;
        loadedPath = path;
        loaded = true;
        dirty = false;
        return true;
      }
      const serialized = `${JSON.stringify(file, null, 2)}\n`;
      if (
        file.workspaceRestore &&
        Buffer.byteLength(serialized) > WORKSPACE_SNAPSHOT_MAX_BYTES
      )
        throw new Error("Workspace snapshot byte capacity reached.");
      await mkdir(dirname(path), { recursive: true });
      const tempPath = `${path}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
      await writeFile(tempPath, serialized, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      await chmod(tempPath, 0o600);
      try {
        if (isCurrentPublication?.() === false) {
          await unlink(tempPath).catch(() => undefined);
          return false;
        }
        if (transition) {
          if (
            transition.kind === "relocate" ||
            transition.kind === "live-rebind"
          )
            transition.onPublicationBoundary?.("after-write-before-rename");
          let applied = false;
          const commit = () => {
            if (!transition.isCurrent() || isCurrentPublication?.() === false)
              return;
            if (
              transition.kind === "relocate" ||
              transition.kind === "live-rebind"
            ) {
              // Transient claims and external fences do not advance snapshot revisions.
              if (isWorkspaceTransitionSlotBlocked(transition.binding)) return;
            }
            if (getPath() !== path || mutationRevision !== persistedRevision)
              return;
            // All publishers fence the same retained operation, including after its terminal removal.
            assertRestoreEvidenceCurrent();
            if (
              !transition.isCurrent() ||
              getPath() !== path ||
              mutationRevision !== persistedRevision
            )
              return;
            replaceBaleWorkspaceFile(tempPath, path);
            loadedPath = path;
            if (
              transition.kind === "relocate" ||
              transition.kind === "live-rebind"
            ) {
              const relocated = file.threads.find((record) =>
                targetMatches(record.target, transition.nextTarget),
              )!;
              records.set(getRecordOwnerKey(transition.owner), {
                ...relocated,
                profileKey: transition.owner.profileKey,
              });
            } else if (transition.kind === "manual-name") {
              const renamed = normalizeRecord(
                file.threads.find((record) =>
                  targetMatches(record.target, transition.target),
                ),
              )!;
              records.set(getRecordOwnerKey(renamed), cloneRecord(renamed));
            } else {
              records = new Map(
                Array.from(records).filter(
                  ([, record]) =>
                    !targetMatches(record.target, transition.target),
                ),
              );
            }
            workspaceRestore = structuredClone(file.workspaceRestore);
            syncObservations = file.syncObservations;
            workspaceBindings = indexWorkspaceBindings(file.workspaceBindings);
            mutationRevision += 1;
            dirty = false;
            applied = true;
            if (
              transition.kind === "relocate" ||
              transition.kind === "live-rebind"
            )
              transition.onPublicationBoundary?.("after-rename");
          };
          withBaleFileTransaction(`${path}.transaction`, () => {
            if (commitPersist) commitPersist(commit);
            else if (!options.canPersist || options.canPersist()) commit();
          });
          if (!applied) await unlink(tempPath).catch(() => undefined);
          return (
            applied &&
            (transition.kind !== "manual-name" || transition.isCurrent())
          );
        }
        if (commitPersist) {
          const committed = withBaleFileTransaction(
            `${path}.transaction`,
            () =>
              commitPersist(() => {
                assertRestoreEvidenceCurrent();
                if (isCurrentPublication?.() === false)
                  throw new Error(
                    "Bale Workspace publication lost caller authority.",
                  );
                replaceBaleWorkspaceFile(tempPath, path);
                chmodSync(path, 0o600);
              }),
          );
          if (!committed) {
            await loadFromDisk();
            throw new Error(
              "Bale thread snapshot lost exact transport ownership before commit.",
            );
          }
        } else {
          withBaleFileTransaction(`${path}.transaction`, () => {
            assertRestoreEvidenceCurrent();
            if (isCurrentPublication?.() === false)
              throw new Error(
                "Bale Workspace publication lost caller authority.",
              );
            replaceBaleWorkspaceFile(tempPath, path);
            chmodSync(path, 0o600);
          });
        }
      } catch (error) {
        await unlink(tempPath).catch(() => undefined);
        throw error;
      }
      if (isCurrentPublication?.() === false) return false;
      loadedPath = path;
      loaded = true;
      if (resetProvisions) {
        if (mutationRevision !== persistedRevision) return false;
        pendingProvisions = file.pendingProvisions;
      }
      if (mutationRevision === persistedRevision) dirty = false;
      return true;
    });
    persistQueue = persist.then(
      () => undefined,
      () => undefined,
    );
    return persist;
  };

  const captureWorkspaceThreadNameObservation = (
    binding: BaleWorkspaceThreadBinding,
    owner: BaleTopicTargetRecord,
  ) => {
    const path = getPath(),
      profile = activeProfile();
    const expectedBinding = structuredClone(binding),
      expectedOwner = structuredClone(owner);
    const bindingIdentity = (value: BaleWorkspaceThreadBinding) => ({
      cwd: value.cwd,
      workspaceKey: value.workspaceKey,
      sessionId: value.sessionId,
      sessionKey: value.sessionKey,
      instanceSlot: value.instanceSlot,
      bindingKey: value.bindingKey,
      target: value.target,
      slot: value.slot,
      inactiveSinceMs: value.inactiveSinceMs,
    });
    const ownerIdentity = (value: BaleTopicTargetRecord) => ({
      owner: value.owner,
      profileKey: value.profileKey,
      instanceId: value.instanceId,
      target: value.target,
      slot: value.slot,
      status: value.status,
      createdAtMs: value.createdAtMs,
    });
    const valid =
      !!expectedBinding.sessionId &&
      !!expectedBinding.slot &&
      /^[A-Z]$/u.test(expectedBinding.slot) &&
      expectedBinding.inactiveSinceMs === undefined &&
      expectedOwner.status === "active" &&
      !!expectedOwner.instanceId &&
      expectedOwner.owner?.kind === "leader" &&
      expectedOwner.owner.instanceId === expectedOwner.instanceId &&
      expectedOwner.owner.cwd === expectedBinding.cwd &&
      expectedOwner.slot === expectedBinding.slot &&
      targetMatches(expectedOwner.target, expectedBinding.target);
    const matches = (
      snapshot: Pick<
        BaleTopicTargetFile,
        "threads" | "workspaceBindings" | "workspaceRetirements"
      >,
      result?:
        { kind: "manual"; name: string } | { kind: "automatic"; title: string },
    ) => {
      const bindings = (snapshot.workspaceBindings ?? []).filter(
        (value) =>
          value.bindingKey === expectedBinding.bindingKey ||
          value.slot === expectedBinding.slot ||
          targetMatches(value.target, expectedBinding.target),
      );
      const owners = snapshot.threads.filter(
        (value) =>
          value.instanceId === expectedOwner.instanceId ||
          value.slot === expectedBinding.slot ||
          targetMatches(value.target, expectedBinding.target),
      );
      return (
        bindings.length === 1 &&
        owners.length === 1 &&
        isDeepStrictEqual(
          bindingIdentity(bindings[0]!),
          bindingIdentity(expectedBinding),
        ) &&
        isDeepStrictEqual(
          ownerIdentity(owners[0]!),
          ownerIdentity(expectedOwner),
        ) &&
        (!result ||
          (result.kind === "manual"
            ? bindings[0]!.manualThreadName === result.name &&
              owners[0]!.manualThreadName === result.name
            : bindings[0]!.manualThreadName === undefined &&
              owners[0]!.manualThreadName === undefined &&
              bindings[0]!.displayTitle === result.title)) &&
        owners[0]!.syncStatus !== "closed" &&
        owners[0]!.syncStatus !== "deleted" &&
        !(snapshot.workspaceRetirements ?? []).some(
          (value) =>
            value.binding.bindingKey === expectedBinding.bindingKey ||
            value.binding.slot === expectedBinding.slot ||
            targetMatches(value.binding.target, expectedBinding.target),
        )
      );
    };
    return (
      result?:
        { kind: "manual"; name: string } | { kind: "automatic"; title: string },
    ) => {
      try {
        if (
          (result?.kind === "automatic" &&
            (!result.title ||
              normalizeBaleTopicTargetThreadName(result.title) !==
                result.title)) ||
          !valid ||
          !scopeMatches(path, profile) ||
          !loadedScopeMatches(path) ||
          !loaded ||
          !matches(
            {
              threads: Array.from(records.values()),
              workspaceBindings: Array.from(workspaceBindings.values()),
              workspaceRetirements,
            },
            result,
          )
        )
          return false;
        // This is also called inside publication guards: read the existing frame without acquiring a nested transaction.
        const file = parseBaleWorkspaceStateSection(
          readStoreSnapshot(path),
          profile,
        );
        return !!file && scopeMatches(path, profile) && matches(file, result);
      } catch {
        return false;
      }
    };
  };

  /**
   * Re-keys one retained Thread binding from a retired session to its successor at the same slot and target,
   * so the tab keeps a single owner. Fails without mutation when the source binding or slot identity is absent.
   */
  const rekeyWorkspaceBindingForSession = (
    cwd: string,
    sourceSessionId: string,
    sessionId: string,
    target: BaleTarget,
  ): boolean => {
    const sourceEntry = Array.from(workspaceBindings.entries()).find(
      ([, binding]) =>
        binding.cwd === cwd &&
        binding.sessionId === sourceSessionId &&
        targetMatches(binding.target, target),
    );
    if (!sourceEntry) return false;
    const [sourceKey, sourceBinding] = sourceEntry;
    const replacementIdentity = Array.from({
      length: BALE_WORKSPACE_SLOTS.length,
    })
      .map((_, ordinal) =>
        createBaleWorkspaceBindingIdentityWithKey(
          sourceBinding.cwd,
          sourceBinding.workspaceKey,
          ordinal,
          sessionId,
        ),
      )
      .find((identity) => identity?.instanceSlot === sourceBinding.instanceSlot);
    if (
      !replacementIdentity ||
      replacementIdentity.instanceSlot !== sourceBinding.instanceSlot
    )
      return false;
    workspaceBindings.delete(sourceKey);
    workspaceBindings.set(getWorkspaceBindingMapKey(replacementIdentity), {
      ...sourceBinding,
      ...replacementIdentity,
      updatedAtMs: getNowMs(),
    });
    markDirty();
    return true;
  };
  return {
    async load() {
      if (workspaceIO && dirty && !loadedScopeMatches(getPath()))
        throw new Error(
          "Workspace projection must refresh after scope change.",
        );
      if (dirty) return;
      await loadFromDisk();
    },
    refresh() {
      const refresh = persistQueue.then(loadFromDisk);
      persistQueue = refresh.catch(() => undefined);
      return refresh;
    },
    async persist(isCurrent) {
      const committed = await persistSnapshot(undefined, isCurrent);
      if ((workspaceIO || isCurrent) && (!committed || isCurrent?.() === false))
        throw new Error(
          "Workspace snapshot lost captured publication authority.",
        );
    },
    invalidateTarget(target, isCurrent, lastSyncError) {
      return persistSnapshot({
        kind: "invalidate",
        target,
        isCurrent,
        lastSyncError,
      });
    },
    detachTargetOwner(expected, isCurrent) {
      const owner = normalizeRecord(expected);
      if (!owner) return Promise.resolve(false);
      return persistSnapshot({
        kind: "detach",
        owner,
        target: owner.target,
        isCurrent,
      });
    },
    assertWorkspaceRestoreRegistration(candidate) {
      withRestoreRegistration(candidate);
    },
    commitWorkspaceRestoreRegistration: withRestoreRegistration,
    listTemporaryThreadTargets() {
      const file = parseTopicTargetFile(
        readStoreSnapshot(getPath(), false) ?? { version: 1, records: [] },
      );
      return (file.workspaceRestore?.temporaryThreads ?? []).flatMap((entry) =>
        entry.target ? [{ ...entry.target }] : [],
      );
    },
    withWorkspaceRestoreSnapshot(expected, observe) {
      const path = getPath();
      withStoreTransaction(path, () => {
        const file = parseTopicTargetFile(readStoreSnapshot(path, false));
        observeWorkspaceRestore(file.workspaceRestore);
        const retained =
          "kind" in expected
            ? file.workspaceRestore?.liveRebindings
            : file.workspaceRestore?.operations;
        if (
          getPath() !== path ||
          !isDeepStrictEqual(
            retained?.find(
              (intent) =>
                intent.request.operationId === expected.request.operationId,
            ),
            expected,
          )
        )
          throw new Error("Workspace Restore observation changed.");
        assertWorkspaceRestoreBindingProtection(file);
        assertRestoreRecoveryProtection(
          path,
          file.workspaceRestore!.operations,
          file.pendingProvisions ?? [],
        );
        observe({
          threads: file.threads,
          workspaceBindings: file.workspaceBindings,
        });
      });
    },
    withWorkspaceLiveRebindSnapshot(expected, observe) {
      const path = getPath(),
        profile = activeProfile();
      // A synchronous read-only grant is safe both before and inside an owned publication frame; no nested transaction.
      const file = parseTopicTargetFile(readStoreSnapshot(path, false));
      if (
        !scopeMatches(path, profile) ||
        !isDeepStrictEqual(
          file.workspaceRestore?.liveRebindings?.find(
            (intent) =>
              intent.request.operationId === expected.request.operationId,
          ),
          expected,
        )
      )
        throw new Error("Workspace live-rebind observation changed.");
      assertWorkspaceRestoreBindingProtection(file);
      assertRestoreRecoveryProtection(
        path,
        provisioningProtectionIntents(file.workspaceRestore!),
        file.pendingProvisions ?? [],
      );
      observe({
        threads: file.threads,
        workspaceBindings: file.workspaceBindings,
      });
      if (
        !scopeMatches(path, profile) ||
        !isDeepStrictEqual(
          parseTopicTargetFile(readStoreSnapshot(path, false)),
          file,
        )
      )
        throw new Error("Workspace live-rebind observation changed.");
    },
    hasPreDispatchRebindEvidence() {
      const file = parseTopicTargetFile(readStoreSnapshot(getPath(), false) ?? { version: 1, records: [] });
      return file.workspaceRestore?.liveRebindings?.some(value => value.inputRelease !== undefined) === true;
    },
    listProtectedLiveRebindTargets() {
      const file = parseTopicTargetFile(readStoreSnapshot(getPath(), false) ?? { version: 1, records: [] });
      return protectedLiveRebindOldTargets(file.workspaceRestore);
    },
    isWorkspaceLiveRebindCleanupTargetProtected(input) {
      try {
        const expected = structuredClone(input),
          path = getPath(),
          profile = activeProfile(),
          revision = mutationRevision;
        const claims = structuredClone(Array.from(workspaceClaims.entries()));
        const { request, recipient } = expected,
          old = request.binding.target;
        if (
          !loaded ||
          !loadedScopeMatches(path) ||
          expected.kind !== "live-rebind" ||
          expected.phase !== "released" ||
          expected.cleanup ||
          targetMatches(old, request.target)
        )
          return true;
        const file = parseTopicTargetFile(readStoreSnapshot(path, false));
        if (
          !scopeMatches(path, profile) ||
          !isDeepStrictEqual(
            file.workspaceRestore?.liveRebindings?.find(
              (intent) => intent.request.operationId === request.operationId,
            ),
            expected,
          )
        )
          return true;
        assertWorkspaceRestoreBindingProtection(file);
        assertRestoreRecoveryProtection(
          path,
          provisioningProtectionIntents(file.workspaceRestore!),
          file.pendingProvisions ?? [],
        );
        const canonical = file.workspaceBindings ?? [],
          warm = Array.from(workspaceBindings.values());
        const matchesRecipient = (
          bindings: readonly BaleWorkspaceThreadBinding[],
          rows: readonly BaleTopicTargetRecord[],
        ) => {
          const bindingsForKey = bindings.filter(
            (binding) => binding.bindingKey === request.binding.bindingKey,
          );
          const owners = rows.filter(
            (row) =>
              row.status === "active" &&
              (row.slot === request.binding.slot ||
                targetMatches(row.target, request.target)),
          );
          const binding = bindingsForKey[0],
            owner = owners[0];
          return (
            bindingsForKey.length === 1 &&
            binding?.sessionId === recipient.sessionId &&
            binding.cwd === request.binding.cwd &&
            binding.workspaceKey === request.binding.workspaceKey &&
            binding.slot === request.binding.slot &&
            binding.inactiveSinceMs === undefined &&
            targetMatches(binding.target, request.target) &&
            owners.length === 1 &&
            owner?.instanceId === recipient.instanceId &&
            owner.slot === request.binding.slot &&
            owner.profileKey === request.owner.profileKey &&
            isDeepStrictEqual(owner.owner, request.owner.owner) &&
            targetMatches(owner.target, request.target)
          );
        };
        if (
          !matchesRecipient(canonical, file.threads) ||
          !matchesRecipient(warm, Array.from(records.values()))
        )
          return true;
        const currentRow = (row: BaleTopicTargetRecord) =>
          row.status === "active" ||
          row.status === "starting" ||
          row.status === "pending" ||
          row.status === "probe-required";
        const protectedTarget = (
          bindings: readonly BaleWorkspaceThreadBinding[],
          rows: readonly BaleTopicTargetRecord[],
          reserved: readonly BaleThreadReservation[],
          provisions: readonly BaleThreadPendingProvision[],
          cleanups: readonly BaleThreadCleanupIntent[],
        ) =>
          bindings.some((binding) => targetMatches(binding.target, old)) ||
          rows.some(
            (row) => currentRow(row) && targetMatches(row.target, old),
          ) ||
          reserved.some((value) => targetMatches(value.target, old)) ||
          // Use the same binding/slot/owner/target conflicts as rebind admission. An unrelated unlocated
          // create must not globally veto cleanup of this exact former binding (nor its issued marker).
          provisions.some((value) => conflictsWithWorkspaceRestoreProvision(request, value)) ||
          cleanups.some((value) => targetMatches(value.target, old));
        if (
          protectedTarget(
            canonical,
            file.threads,
            file.reservations ?? [],
            file.pendingProvisions ?? [],
            file.pendingCleanups ?? [],
          ) ||
          protectedTarget(
            warm,
            Array.from(records.values()),
            reservations,
            pendingProvisions,
            pendingCleanups,
          ) ||
          [...(file.workspaceRetirements ?? []), ...workspaceRetirements]
            .length > 0
        )
          return true;
        const touchesOld = (
          other:
            BaleWorkspaceRestoreIntent | BaleWorkspaceLiveRebindIntent,
        ) =>
          targetMatches(other.request.binding.target, old) ||
          targetMatches(other.request.target, old);
        if (
          file.workspaceRestore!.operations.some(touchesOld) ||
          file.workspaceRestore!.liveRebindings?.some(
            (other) =>
              other.request.operationId !== request.operationId &&
              (liveRebindActive(other) && touchesOld(other) ||
                (liveRebindOldTargetUnknown(other) || other.oldTargetProtected) && targetMatches(other.request.binding.target, old)),
          )
        )
          return true;
        for (const claim of workspaceClaims.values()) {
          const bindings = canonical.filter(
            (binding) => binding.bindingKey === claim.identity.bindingKey,
          );
          const binding = bindings[0];
          if (
            bindings.length !== 1 ||
            binding?.slot !== claim.identity.slot ||
            binding.cwd !== claim.identity.cwd ||
            binding.sessionId !== claim.identity.sessionId ||
            targetMatches(binding.target, old)
          )
            return true;
          if (
            (claim.identity.bindingKey === request.binding.bindingKey ||
              claim.identity.slot === request.binding.slot) &&
            (claim.instanceId !== recipient.instanceId ||
              claim.identity.bindingKey !== request.binding.bindingKey ||
              !targetMatches(binding.target, request.target))
          )
            return true;
        }
        const unchanged = isDeepStrictEqual(
          parseTopicTargetFile(readStoreSnapshot(path, false)),
          file,
        );
        return (
          !unchanged ||
          !scopeMatches(path, profile) ||
          mutationRevision !== revision ||
          !isDeepStrictEqual(Array.from(workspaceClaims.entries()), claims)
        );
      } catch {
        return true;
      }
    },
    captureWorkspaceThreadRenameObservation(binding, owner) {
      const observe = captureWorkspaceThreadNameObservation(binding, owner);
      return (name) =>
        observe(name === undefined ? undefined : { kind: "manual", name });
    },
    captureWorkspaceThreadResetObservation(binding, owner) {
      const observe = captureWorkspaceThreadNameObservation(binding, owner);
      return {
        isCurrent: () => observe(),
        isResultCurrent: (title) => observe({ kind: "automatic", title }),
      };
    },
    workspaceRestore(storageOptions) {
      const path = getPath(),
        profile = activeProfile();
      const now = storageOptions.getNowMs ?? Date.now;
      const {
        profileName,
        tokenSha256,
        isCurrentScope,
        legacyPath,
        onPublicationBoundary,
      } = storageOptions;
      if (consolidated && profileName !== profile)
        throw new Error("Foreign Workspace Restore storage scope.");
      const maxBytes = Math.min(
        storageOptions.maxBytes ?? WORKSPACE_RESTORE_MAX_BYTES,
        WORKSPACE_RESTORE_MAX_BYTES,
      );
      if (
        !restoreText(profileName) ||
        !/^[a-f0-9]{64}$/u.test(tokenSha256) ||
        !Number.isSafeInteger(maxBytes) ||
        maxBytes <= 0
      )
        throw new Error("Invalid Workspace Restore storage scope.");
      const empty: BaleWorkspaceRestoreSnapshot = {
        version: 1,
        profileName,
        tokenSha256,
        revision: 0,
        operations: [],
      };
      let observed: BaleWorkspaceRestoreSnapshot | undefined;
      const currentScope = () =>
        getPath() === path &&
        (!consolidated || scopeMatches(path, profile)) &&
        (isCurrentScope?.() ?? true) &&
        (options.canPersist?.() ?? true);
      const read = (): {
        file: Record<string, unknown>;
        state: BaleWorkspaceRestoreSnapshot;
      } => {
        if (legacyPath) {
          try {
            lstatSync(legacyPath);
            throw new Error("Unmigrated Workspace Restore file.");
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
        }
        const raw = readStoreSnapshot(path);
        if (raw !== undefined && (!restoreObject(raw) || raw.version !== 1))
          throw new Error("Invalid Workspace snapshot.");
        const file = (raw ??
          (consolidated
            ? {
                version: 1,
                source: "snapshot",
                writtenAtMs: 0,
                bot: { threadMode: "unknown" },
                threads: [],
              }
            : { version: 1, records: [] })) as Record<string, unknown>;
        const state = parseTopicTargetFile(file).workspaceRestore;
        if (
          state &&
          (state.profileName !== profileName ||
            state.tokenSha256 !== tokenSha256)
        )
          throw new Error("Invalid or foreign Workspace Restore evidence.");
        if (
          observed &&
          (!state ||
            state.revision < observed.revision ||
            (state.revision === observed.revision &&
              !isDeepStrictEqual(state, observed)))
        )
          throw new Error(
            "Workspace Restore evidence moved backwards or changed without revision.",
          );
        if (state && Buffer.byteLength(JSON.stringify(state)) > maxBytes)
          throw new Error("Workspace Restore byte capacity reached.");
        observed = structuredClone(state);
        if (loadedScopeMatches(path)) observeWorkspaceRestore(state);
        return { file, state: structuredClone(state ?? empty) };
      };
      const inspectTemporaryOwnership = (
        before: ReturnType<typeof read>,
        entry: BaleTemporaryThreadEntry,
      ): BaleTemporaryThreadTargetObservation => {
        if (entry.phase !== "created" || !entry.target)
          return { kind: "unknown" };
        const file = parseTopicTargetFile(before.file);
        // Normalization omissions never prove an unbound target.
        for (const key of [
          "threads",
          "workspaceBindings",
          "reservations",
          "pendingProvisions",
          "pendingCleanups",
          "workspaceRetirements",
        ] as const) {
          const raw = before.file[key];
          if (
            (key === "threads" && raw === undefined) ||
            (raw !== undefined &&
              (!Array.isArray(raw) || raw.length !== (file[key]?.length ?? 0)))
          )
            throw new Error("Invalid temporary Thread target evidence.");
        }
        assertWorkspaceRestoreBindingProtection(file);
        assertRestoreRecoveryProtection(
          path,
          before.state.operations,
          file.pendingProvisions ?? [],
          true,
        );
        const target = entry.target;
        const bindings = (file.workspaceBindings ?? []).filter((value) =>
          targetMatches(value.target, target),
        );
        if (bindings.length === 1)
          return { kind: "bound", binding: structuredClone(bindings[0]!) };
        if (
          bindings.length > 1 ||
          file.threads.some((value) => targetMatches(value.target, target)) ||
          file.reservations?.some((value) =>
            targetMatches(value.target, target),
          ) ||
          // This exact created frame already proves a separately created routing tab (API ACK or authenticated
          // implicit creation). An unlocated Workspace create is not its owner; keep that intent unresolved,
          // but veto a concrete target collision. Generic unknown-target/Restore cleanup keeps its own guards.
          file.pendingProvisions?.some(
            (value) => !!value.target && targetMatches(value.target, target),
          ) ||
          file.pendingCleanups?.some((value) =>
            targetMatches(value.target, target),
          ) ||
          file.workspaceRetirements?.some((value) =>
            targetMatches(value.binding.target, target),
          ) ||
          before.state.operations.some((value) =>
            targetMatches(value.request.target, target),
          )
        )
          return { kind: "unknown" };
        return { kind: "temporary" };
      };
      const classifyTemporaryTarget = (
        before: ReturnType<typeof read>,
        entry: BaleTemporaryThreadEntry,
      ): BaleTemporaryThreadTargetObservation =>
        entry.cleanupIssued
          ? { kind: "unknown" }
          : inspectTemporaryOwnership(before, entry);
      const storage = {
        read: () => read().state,
        async relocate(
          input:
            BaleWorkspaceRestoreIntent | BaleWorkspaceLiveRebindIntent,
          isCurrent: () => boolean,
        ) {
          if (!currentScope() || !isCurrent()) return false;
          const intent = structuredClone(input);
          const live = isWorkspaceLiveRebindIntent(intent);
          if (
            !currentScope() ||
            !isCurrent() ||
            intent.revision !== 0 ||
            (live
              ? intent.phase !== "rebound"
              : !isWorkspaceRestoreIntent(intent) ||
                intent.phase !== "relocated" ||
                intent.recipient !== undefined ||
                intent.routing !== undefined)
          )
            return false;
          const state = read().state;
          if (protectedLiveRebindOldTargets(state).some(old => targetMatches(old, intent.request.binding.target) || targetMatches(old, intent.request.target)))
            return false;
          if (
            pendingWorkspaceRelocationRequests(state).some((request) =>
              workspaceRestoresConflict(request, intent.request),
            ) ||
            state.liveRebindings?.some(
              (value) =>
                value.request.operationId === intent.request.operationId,
            )
          )
            return false;
          if (state.revision === Number.MAX_SAFE_INTEGER)
            throw new Error("Workspace Restore revision exhausted.");
          const pendingLive = (state.liveRebindings ?? []).filter(retainLiveRebind);
          if ((live ? pendingLive.length : state.operations.length) >= 26)
            throw new Error("Workspace Restore operation capacity reached.");
          const restore: BaleWorkspaceRestoreSnapshot = {
            ...state,
            revision: state.revision + 1,
            ...(live
              ? {
                  liveRebindings: [
                    ...pendingLive,
                    intent as BaleWorkspaceLiveRebindIntent,
                  ],
                }
              : {
                  operations: [
                    ...state.operations,
                    intent as BaleWorkspaceRestoreIntent,
                  ],
                }),
          };
          if (live) {
            const target = intent.request.target;
            const temporary = state.temporaryThreads?.find(
              (entry) => !!entry.target && targetMatches(entry.target, target),
            );
            if (
              temporary &&
              (temporary.cleanupIssued ||
                !isTemporaryThreadRestore(temporary, [intent]))
            )
              return false;
            // Binding consumes the chooser frame, not its journal inputs or another recipient's custody.
            const remaining = state.temporaryThreads?.filter(
              (entry) => !entry.target || !targetMatches(entry.target, target),
            );
            if (remaining?.length) restore.temporaryThreads = remaining;
            else delete restore.temporaryThreads;
          }
          const request = intent.request;
          return persistSnapshot({
            kind: live ? "live-rebind" : "relocate",
            operationId: request.operationId,
            binding: request.binding,
            owner: request.owner,
            target: { ...request.binding.target },
            nextTarget: { ...request.target },
            restore,
            maxBytes,
            onPublicationBoundary,
            isCurrent: () => currentScope() && isCurrent(),
          });
        },
        update(
          expectedInput: BaleWorkspaceRestoreSnapshot,
          nextInput: BaleWorkspaceRestoreSnapshot,
          isCurrent: () => boolean,
        ) {
          const expected = structuredClone(expectedInput),
            next = structuredClone(nextInput);
          if (!currentScope() || !isCurrent()) return false;
          if (expected.revision === Number.MAX_SAFE_INTEGER)
            throw new Error("Workspace Restore revision exhausted.");
          if (
            next.profileName !== profileName ||
            next.tokenSha256 !== tokenSha256 ||
            next.revision !== expected.revision + 1 ||
            !parseWorkspaceRestore(next)
          )
            throw new Error("Invalid Workspace Restore publication.");
          if (Buffer.byteLength(JSON.stringify(next)) > maxBytes)
            throw new Error("Workspace Restore byte capacity reached.");
          if (!workspaceIO) mkdirSync(dirname(path), { recursive: true });
          let committedBefore: ReturnType<typeof read> | undefined;
          let committedAfter: Record<string, unknown> | undefined;
          const committed = withStoreTransaction(
            path,
            () => {
              const before = read();
              if (
                !isDeepStrictEqual(before.state, expected) ||
                !currentScope() ||
                !isCurrent()
              )
                return false;
              for (const entry of next.temporaryThreads ?? []) {
                const prior = expected.temporaryThreads?.find(
                  (value) => value.token === entry.token,
                );
                if (
                  !prior &&
                  entry.phase === "created" &&
                  classifyTemporaryTarget(before, entry).kind !== "temporary"
                )
                  return false;
                if (!entry.cleanupIssued) continue;
                if (
                  !prior?.cleanupIssued &&
                  (!prior ||
                    classifyTemporaryTarget(before, prior).kind !== "temporary")
                )
                  return false;
              }
              assertWorkspaceRestoreBindingProtection(before.file);
              const provisions =
                parseTopicTargetFile(before.file).pendingProvisions ?? [];
              assertRestoreRecoveryProtection(
                path,
                provisioningProtectionIntents(before.state),
                provisions,
              );
              const after = { ...before.file, workspaceRestore: next };
              // New temporary targets must be checked against the file they will be published into.
              assertWorkspaceRestoreBindingProtection(
                parseTopicTargetFile(after),
              );
              const content = JSON.stringify(after);
              if (Buffer.byteLength(content) > WORKSPACE_SNAPSHOT_MAX_BYTES)
                throw new Error("Workspace snapshot byte capacity reached.");
              if (workspaceIO) {
                if (!workspaceFrame || !currentScope() || !isCurrent())
                  return false;
                assertRestoreRecoveryProtection(
                  path,
                  [...provisioningProtectionIntents(before.state), ...provisioningProtectionIntents(next)],
                  provisions,
                );
                committedBefore = before;
                committedAfter = JSON.parse(content);
                workspaceFrame.value = committedAfter;
                return true;
              }
              const temporary = `${path}.${randomUUID()}.tmp`;
              try {
                writeFileSync(temporary, content, {
                  encoding: "utf8",
                  flag: "wx",
                  mode: 0o600,
                });
                onPublicationBoundary?.("after-write-before-rename");
                let published = false;
                const publish = (): void => {
                  if (!currentScope() || !isCurrent()) return;
                  if (!isDeepStrictEqual(read().file, before.file))
                    throw new Error(
                      "Workspace Restore evidence changed before publication.",
                    );
                  assertRestoreRecoveryProtection(
                    path,
                    [...provisioningProtectionIntents(before.state), ...provisioningProtectionIntents(next)],
                    provisions,
                  );
                  if (!currentScope() || !isCurrent()) return;
                  replaceBaleWorkspaceFile(temporary, path);
                  observed = structuredClone(next);
                  // A read-only Restore view must never bless a stale binding/owner projection.
                  if (
                    loadedPath === path &&
                    isDeepStrictEqual(
                      workspaceRestore,
                      before.file.workspaceRestore,
                    )
                  )
                    workspaceRestore = structuredClone(next);
                  mutationRevision += 1;
                  published = true;
                  onPublicationBoundary?.("after-rename");
                };
                const owned = commitPersist
                  ? commitPersist(publish)
                  : (publish(), true);
                return owned && published;
              } finally {
                try {
                  unlinkSync(temporary);
                } catch (error) {
                  if ((error as NodeJS.ErrnoException).code !== "ENOENT")
                    throw error;
                }
              }
            },
            {
              isCurrent: () => currentScope() && isCurrent(),
              onPublicationBoundary: (boundary) => {
                if (boundary !== "before-write")
                  onPublicationBoundary?.(boundary);
              },
            },
          );
          if (workspaceIO && committed && committedBefore && committedAfter) {
            observed = structuredClone(next);
            if (
              loadedScopeMatches(path) &&
              isDeepStrictEqual(
                workspaceRestore,
                committedBefore.file.workspaceRestore,
              )
            )
              workspaceRestore = structuredClone(next);
            if (
              isDeepStrictEqual(
                observedWorkspaceSemantic,
                getBaleStateSemanticSnapshot(committedBefore.file),
              )
            )
              observedWorkspaceSemantic =
                getBaleStateSemanticSnapshot(committedAfter);
            mutationRevision += 1;
          }
          return committed;
        },
      };
      const mutate = <
        T extends
          | BaleWorkspaceRestoreIntent
          | BaleWorkspaceLiveRebindIntent
          | BaleTemporaryThreadEntry,
      >(
        authority: BaleWorkspaceRestoreAuthority,
        change: (
          file: BaleWorkspaceRestoreSnapshot,
          executor: BaleWorkspaceRestoreExecutor,
          operatorUserId: number,
        ) => T | undefined,
      ): T | undefined => {
        if (!authority.isCurrent()) return undefined;
        const executor = structuredClone(authority.executor);
        const operator = authority.operatorUserId;
        if (
          !isBaleWorkspaceRestoreExecutor(executor) ||
          !restoreInteger(operator)
        )
          return undefined;
        const current = (): boolean =>
          authority.isCurrent() &&
          authority.operatorUserId === operator &&
          isDeepStrictEqual(authority.executor, executor);
        const before = storage.read();
        const file = structuredClone(before);
        const operation = change(file, executor, operator);
        if (!operation || !current()) return undefined;
        if (isDeepStrictEqual(file, before)) return structuredClone(operation);
        if (file.revision === Number.MAX_SAFE_INTEGER)
          throw new Error("Workspace Restore revision exhausted.");
        file.revision += 1;
        return storage.update(before, file, current)
          ? structuredClone(operation)
          : undefined;
      };
      const advance = (
        expected: BaleWorkspaceRestoreIntent,
        authority: BaleWorkspaceRestoreAuthority,
        change: (
          operation: BaleWorkspaceRestoreIntent,
        ) => boolean | "unchanged",
        adopt = false,
      ): BaleWorkspaceRestoreIntent | undefined =>
        mutate(authority, (file, executor, operator) => {
          const operation = file.operations.find(
            (candidate) =>
              candidate.request.operationId === expected.request.operationId,
          );
          if (
            !operation ||
            !isDeepStrictEqual(operation, expected) ||
            operation.operatorUserId !== operator ||
            (!adopt && !isDeepStrictEqual(operation.executor, executor))
          )
            return undefined;
          const changed = change(operation);
          if (!changed) return undefined;
          if (changed === "unchanged") return operation;
          if (operation.revision === Number.MAX_SAFE_INTEGER)
            throw new Error("Workspace Restore operation revision exhausted.");
          const at = now();
          if (!restoreInteger(at))
            throw new Error("Invalid Workspace Restore clock.");
          operation.executor = executor;
          operation.revision += 1;
          operation.updatedAtMs = Math.max(at, operation.updatedAtMs);
          return operation;
        });
      const advanceTemporary = (
        expected: BaleTemporaryThreadEntry,
        authority: BaleWorkspaceRestoreAuthority,
        change: (
          entry: BaleTemporaryThreadEntry,
          file: BaleWorkspaceRestoreSnapshot,
          executor: BaleWorkspaceRestoreExecutor,
        ) => boolean | "unchanged",
        adopt = false,
      ): BaleTemporaryThreadEntry | undefined =>
        mutate<BaleTemporaryThreadEntry>(
          authority,
          (file, executor, operator) => {
            const entry = file.temporaryThreads?.find((value) =>
              isDeepStrictEqual(value, expected),
            );
            if (
              !entry ||
              entry.operatorUserId !== operator ||
              (!adopt && !isDeepStrictEqual(entry.executor, executor))
            )
              return undefined;
            const changed = change(entry, file, executor);
            if (!changed) return undefined;
            if (changed === "unchanged") return entry;
            if (entry.revision === Number.MAX_SAFE_INTEGER)
              throw new Error(
                "Workspace Restore operation revision exhausted.",
              );
            const at = now();
            if (!restoreInteger(at))
              throw new Error("Invalid Workspace Restore clock.");
            entry.executor = executor;
            entry.revision += 1;
            entry.updatedAtMs = Math.max(at, entry.updatedAtMs);
            return entry;
          },
        );
      return {
        list: () => structuredClone(storage.read().operations),
        listLiveRebindings: () =>
          structuredClone(storage.read().liveRebindings ?? []),
        async commitLiveRebind(requestInput, recipientInput, authority, options) {
          const request = structuredClone(requestInput),
            recipient = structuredClone(recipientInput);
          const executor = structuredClone(authority.executor),
            operatorUserId = authority.operatorUserId;
          const current = () =>
            currentScope() &&
            authority.isCurrent() &&
            authority.operatorUserId === operatorUserId &&
            isDeepStrictEqual(authority.executor, executor);
          const at = now();
          const intent: BaleWorkspaceLiveRebindIntent = {
            kind: "live-rebind",
            request,
            recipient,
            executor,
            operatorUserId,
            revision: 0,
            createdAtMs: at,
            updatedAtMs: at,
            phase: "rebound",
            ...(options?.holdInput ? { inputRelease: "held" as const } : {}),
          };
          if (!current() || !isWorkspaceLiveRebindIntent(intent))
            return undefined;
          const retained = () => {
            if (!current()) return undefined;
            const value = storage
              .read()
              .liveRebindings?.find(
                (value) => value.request.operationId === request.operationId,
              );
            return value &&
              isDeepStrictEqual(value.request, request) &&
              isDeepStrictEqual(value.recipient, recipient) &&
              isDeepStrictEqual(value.executor, executor) &&
              value.operatorUserId === operatorUserId &&
              (value.inputRelease !== undefined) === (options?.holdInput === true)
              ? structuredClone(value)
              : undefined;
          };
          const existing = retained();
          if (existing) return existing;
          let failure: { error: unknown } | undefined;
          try {
            await storage.relocate(intent, current);
          } catch (error) {
            failure = { error };
          }
          if (!current()) return undefined;
          const committed = retained();
          if (!committed && failure) throw failure.error;
          return committed;
        },
        advanceLiveRebind(expected, step, authority) {
          return mutate<BaleWorkspaceLiveRebindIntent>(
            authority,
            (file, executor, operator) => {
              const index =
                file.liveRebindings?.findIndex(
                  (value) =>
                    value.request.operationId === expected.request.operationId,
                ) ?? -1;
              const entry = file.liveRebindings?.[index];
              if (
                !entry ||
                !isDeepStrictEqual(entry, expected) ||
                entry.operatorUserId !== operator ||
                (entry.phase === "finished" && step !== "issue-input" && step !== "accept-input")
              )
                return undefined;
              const issuing = step === "release" || step === "issue-cleanup" || step === "issue-input" || step === "accept-input" || step === "protect-old-target";
              if (
                (issuing || step === "confirmed") &&
                !isDeepStrictEqual(entry.executor, executor)
              )
                return undefined;
              let next: BaleWorkspaceLiveRebindIntent;
              if (step === "issue-input" || step === "accept-input") {
                if (!["released", "finished"].includes(entry.phase) || entry.cleanup === "issued" || entry.inputRelease !== (step === "issue-input" ? "held" : "issued")) return undefined;
                next = { ...entry, inputRelease: step === "issue-input" ? "issued" : "accepted" };
              } else if (step === "protect-old-target") {
                if (entry.phase !== "released" || entry.cleanup !== undefined || entry.inputRelease !== "held") return undefined;
                next = { ...entry, phase: "finished", cleanup: "not-issued", oldTargetProtected: true };
              } else if (step === "release") {
                if (entry.phase !== "rebound") return undefined;
                next = { ...entry, phase: "released" };
              } else if (step === "issue-cleanup") {
                if (entry.phase !== "released" || entry.cleanup !== undefined)
                  return undefined;
                next = { ...entry, cleanup: "issued" };
              } else {
                if (
                  (step === "confirmed" || step === "unknown") &&
                  (entry.phase !== "released" || entry.cleanup !== "issued")
                )
                  return undefined;
                if (step === "not-issued" && entry.cleanup !== undefined)
                  return undefined;
                next = { ...entry, phase: "finished", cleanup: step };
              }
              if (entry.revision === Number.MAX_SAFE_INTEGER)
                throw new Error("Workspace live rebinding revision exhausted.");
              const at = now();
              if (!restoreInteger(at))
                throw new Error("Invalid Workspace live rebinding clock.");
              next.revision += 1;
              next.updatedAtMs = Math.max(at, next.updatedAtMs);
              if (!isWorkspaceLiveRebindIntent(next)) return undefined;
              file.liveRebindings![index] = next;
              return next;
            },
          );
        },
        inspectTemporaryThreadTarget(expected, authority) {
          const executor = structuredClone(authority.executor),
            operator = authority.operatorUserId;
          const current = () =>
            currentScope() &&
            authority.isCurrent() &&
            authority.operatorUserId === operator &&
            isDeepStrictEqual(authority.executor, executor);
          if (
            !isBaleWorkspaceRestoreExecutor(executor) ||
            !restoreInteger(operator) ||
            !current()
          )
            return undefined;
          return withStoreTransaction(path, () => {
            if (!current()) return undefined;
            const before = read(),
              entry = before.state.temporaryThreads?.find((value) =>
                isDeepStrictEqual(value, expected),
              );
            if (!entry || entry.operatorUserId !== operator || !current())
              return undefined;
            const result = classifyTemporaryTarget(before, entry);
            return current() ? result : undefined;
          });
        },
        isTemporaryThreadCleanupCurrent(expected, authority) {
          const executor = structuredClone(authority.executor),
            operator = authority.operatorUserId;
          const current = () =>
            currentScope() &&
            authority.isCurrent() &&
            authority.operatorUserId === operator &&
            isDeepStrictEqual(authority.executor, executor);
          if (
            !expected.cleanupIssued ||
            expected.operatorUserId !== operator ||
            !isDeepStrictEqual(expected.executor, executor) ||
            !isBaleWorkspaceRestoreExecutor(executor) ||
            !restoreInteger(operator) ||
            !current()
          )
            return false;
          return withStoreTransaction(path, () => {
            if (!current()) return false;
            const before = read(),
              entry = before.state.temporaryThreads?.find((value) =>
                isDeepStrictEqual(value, expected),
              );
            return (
              !!entry &&
              inspectTemporaryOwnership(before, entry).kind === "temporary" &&
              current()
            );
          });
        },
        /** The first durable state already includes both relocation and exact original references. */
        async commit(requestInput, authority) {
          if (!authority.isCurrent()) return undefined;
          const request = structuredClone(requestInput),
            executor = structuredClone(authority.executor),
            operatorUserId = authority.operatorUserId;
          const current = () =>
            authority.isCurrent() &&
            authority.operatorUserId === operatorUserId &&
            isDeepStrictEqual(authority.executor, executor);
          if (
            !current() ||
            !isBaleWorkspaceRestoreRequest(request) ||
            !isBaleWorkspaceRestoreExecutor(executor) ||
            !restoreInteger(operatorUserId) ||
            request.target.chatId !== operatorUserId
          )
            return undefined;
          const retained = (): BaleWorkspaceRestoreIntent | undefined => {
            if (!current()) return undefined;
            const operation = storage
              .read()
              .operations.find(
                (value) => value.request.operationId === request.operationId,
              );
            return current() &&
              operation?.phase === "relocated" &&
              isDeepStrictEqual(operation.request, request) &&
              operation.operatorUserId === operatorUserId &&
              isDeepStrictEqual(operation.executor, executor)
              ? operation
              : undefined;
          };
          const existing = retained();
          if (existing) return existing;
          await (dirty ? undefined : loadFromDisk());
          if (!current()) return undefined;
          const at = now();
          if (!restoreInteger(at))
            throw new Error("Invalid Workspace Restore clock.");
          const intent: BaleWorkspaceRestoreIntent = {
            request,
            executor,
            operatorUserId,
            revision: 0,
            createdAtMs: at,
            updatedAtMs: at,
            committedAtMs: at,
            phase: "relocated",
          };
          let failure: { error: unknown } | undefined;
          try {
            await storage.relocate(intent, current);
          } catch (error) {
            failure = { error };
          }
          if (!current()) return undefined;
          // A lost rename reply is reconciled from the complete operation, never target equality.
          const committed = retained();
          if (!committed && failure) throw failure.error;
          return committed;
        },
        adopt(expected, authority) {
          return advance(
            expected,
            authority,
            () => !isDeepStrictEqual(expected.executor, authority.executor),
            true,
          );
        },
        /** Caller validates the live recipient under admission. Only this fresh result grants one RPC issuance. */
        issueRecipient(expected, recipient, authority) {
          const intent = advance(expected, authority, (operation) => {
            if (
              operation.phase !== "relocated" ||
              !isBaleWorkspaceRestoreRecipient(recipient) ||
              recipient.sessionId !== operation.request.binding.sessionId
            )
              return false;
            operation.phase = "recipient-issued";
            operation.recipient = structuredClone(recipient);
            return true;
          });
          return intent ? { issued: true, intent } : undefined;
        },
        /** One source-dispatch grant; uncertainty never resets it. Caller retains the original carriers. */
        issueRouting(expected, authority) {
          const intent = advance(expected, authority, (operation) => {
            if (operation.phase !== "ready" || operation.routing) return false;
            operation.routing = { settlements: [] };
            return true;
          });
          return intent ? { issued: true, intent } : undefined;
        },
        /** Caller owns the positive result and exact source hash; this grants neither source removal nor cleanup. */
        recordSourceAcceptance(expected, evidenceInput, authority) {
          if (!authority.isCurrent()) return undefined;
          const evidence = structuredClone(evidenceInput);
          return advance(expected, authority, (operation) => {
            if (
              !operation.routing ||
              !isWorkspaceRestoreSourceAcceptance(evidence, operation)
            )
              return false;
            const existing = operation.routing.acceptances?.find(
              (value) => value.updateId === evidence.updateId,
            );
            if (existing)
              return isDeepStrictEqual(existing, evidence)
                ? "unchanged"
                : false;
            if (
              operation.routing.cleanup !== undefined ||
              operation.routing.settlements.some((value) =>
                value.updateIds.includes(evidence.updateId),
              ) ||
              !isDeepStrictEqual(
                evidence.recipient,
                operation.readyRecipient ?? operation.recipient,
              )
            )
              return false;
            const acceptances = [
              ...(operation.routing.acceptances ?? []),
              evidence,
            ].sort((a, b) => a.updateId - b.updateId);
            if (!workspaceRestoreAcceptancesConsistent(acceptances))
              return false;
            operation.routing.acceptances = acceptances;
            return true;
          });
        },
        /** Queue admission is nonterminal; only its exact journal-owner completion ACK may upgrade it. */
        recordSourceSettlement(expected, evidenceInput, authority) {
          const evidence = structuredClone(evidenceInput);
          return advance(expected, authority, (operation) => {
            if (
              !operation.routing ||
              !isBaleWorkspaceRestoreSettlement(
                evidence,
                operation.request.source,
              ) ||
              !workspaceRestoreSettlementMatchesAcceptance(
                evidence,
                operation.routing.acceptances ?? [],
              )
            )
              return false;
            const overlaps = operation.routing.settlements.filter((value) =>
              value.updateIds.some((id) => evidence.updateIds.includes(id)),
            );
            if (
              overlaps.some(
                (value) =>
                  evidence.kind !== "queue-completed" ||
                  value.kind !== "queued" ||
                  value.receiptId !== evidence.receiptId ||
                  value.queueKind !== evidence.queueKind,
              )
            )
              return false;
            operation.routing.settlements =
              operation.routing.settlements.flatMap((value) => {
                const updateIds = value.updateIds.filter(
                  (id) => !evidence.updateIds.includes(id),
                );
                return updateIds.length ? [{ ...value, updateIds }] : [];
              });
            operation.routing.settlements.push(evidence);
            return true;
          });
        },
        /** Existing cleanup owner retains deletion authority; this merely fences one invocation. */
        issueCleanup(expected, authority) {
          const intent = advance(expected, authority, (operation) => {
            if (
              !operation.routing ||
              !workspaceRestoreSourcesSettled(operation) ||
              operation.routing.cleanup !== undefined
            )
              return false;
            operation.routing.cleanup = "issued";
            return true;
          });
          return intent ? { issued: true, intent } : undefined;
        },
        recordCleanup(expected, result, authority) {
          return advance(expected, authority, (operation) => {
            if (
              !operation.routing ||
              !workspaceRestoreSourcesSettled(operation) ||
              !isDeepStrictEqual(
                result.target,
                operation.request.binding.target,
              ) ||
              (result.kind === "completed"
                ? operation.routing.cleanup !== "issued"
                : result.kind !== "not-issued" ||
                  operation.routing.cleanup !== undefined)
            )
              return false;
            operation.routing.cleanup = result.kind;
            return true;
          });
        },
        /** Exact terminal CAS releases Restore protection only; it cannot settle or cancel recipient queue work. */
        retire(expected, authority) {
          return mutate(authority, (file, executor, operator) => {
            const index = file.operations.findIndex(
              (value) =>
                value.request.operationId === expected.request.operationId,
            );
            const operation = file.operations[index];
            if (
              !operation ||
              !isDeepStrictEqual(operation, expected) ||
              operation.operatorUserId !== operator ||
              !isDeepStrictEqual(operation.executor, executor) ||
              !workspaceRestoreSourcesSettled(operation) ||
              !["completed", "not-issued"].includes(
                operation.routing?.cleanup ?? "",
              )
            )
              return undefined;
            file.operations.splice(index, 1);
            return operation;
          });
        },
        listTemporaryThreads: () =>
          structuredClone(storage.read().temporaryThreads ?? []),
        reserveTemporaryThread(sourceInput, token, authority, groupInput) {
          const source = structuredClone(sourceInput);
          const group: BaleTemporaryThreadInput = groupInput
            ? structuredClone(groupInput)
            : {
                journalBindingKey: source.journalBindingKey,
                updateIds: [source.updateId],
              };
          if (
            !isTemporaryThreadInput(group) ||
            group.journalBindingKey !== source.journalBindingKey ||
            Math.min(...group.updateIds) !== source.updateId
          )
            return undefined;
          let reserved = false;
          const entry = mutate<BaleTemporaryThreadEntry>(
            authority,
            (file, executor, operator) => {
              const entries = file.temporaryThreads ?? [];
              const existing = entries.find(
                (value) =>
                  value.source.journalBindingKey === source.journalBindingKey &&
                  value.source.updateId === source.updateId,
              );
              // A retained entry proves an earlier attempt; it is never a license for another creation.
              if (existing)
                return existing.operatorUserId === operator
                  ? existing
                  : undefined;
              const at = now();
              if (!restoreInteger(at))
                throw new Error("Invalid Workspace Restore clock.");
              const next: BaleTemporaryThreadEntry = {
                source,
                inputs: [group],
                operatorUserId: operator,
                executor,
                token,
                phase: "creating",
                forwardProtocol: "one-shot-v1",
                revision: 0,
                createdAtMs: at,
                updatedAtMs: at,
              };
              if (
                !isTemporaryThreadEntry(next) ||
                entries.some(
                  (value) =>
                    value.token === token ||
                    getBaleTemporaryThreadInputs(value).some(
                      (input) =>
                        input.journalBindingKey === source.journalBindingKey &&
                        input.updateIds.some((id) =>
                          group.updateIds.includes(id),
                        ),
                    ),
                )
              )
                return undefined;
              if (entries.length >= TEMPORARY_THREAD_CAPACITY)
                throw new Error("Temporary Thread capacity reached.");
              file.temporaryThreads = [...entries, next];
              reserved = true;
              return next;
            },
          );
          return entry ? { reserved, entry } : undefined;
        },
        registerImplicitTemporaryThread(
          inputValue,
          targetInput,
          token,
          authority,
        ) {
          const input = structuredClone(inputValue),
            target = {
              chatId: targetInput.chatId,
              threadId: targetInput.threadId,
            };
          if (
            !isTemporaryThreadInput(input) ||
            !Number.isSafeInteger(target.threadId) ||
            target.threadId <= 0
          )
            return undefined;
          return mutate<BaleTemporaryThreadEntry>(
            authority,
            (file, executor, operator) => {
              const entries = file.temporaryThreads ?? [];
              if (
                target.chatId !== operator ||
                entries.some(
                  (value) =>
                    value.token === token ||
                    (value.target && targetMatches(value.target, target)) ||
                    getBaleTemporaryThreadInputs(value).some(
                      (other) =>
                        other.journalBindingKey === input.journalBindingKey &&
                        other.updateIds.some((id) =>
                          input.updateIds.includes(id),
                        ),
                    ),
                )
              )
                return undefined;
              const at = now();
              if (!restoreInteger(at))
                throw new Error("Invalid Workspace Restore clock.");
              const entry: BaleTemporaryThreadEntry = {
                source: {
                  journalBindingKey: input.journalBindingKey,
                  updateId: input.updateIds[0]!,
                },
                inputs: [input],
                target,
                operatorUserId: operator,
                executor,
                token,
                phase: "created",
                forwardProtocol: "one-shot-v1",
                revision: 0,
                createdAtMs: at,
                updatedAtMs: at,
              };
              if (!isTemporaryThreadEntry(entry)) return undefined;
              if (entries.length >= TEMPORARY_THREAD_CAPACITY)
                throw new Error("Temporary Thread capacity reached.");
              file.temporaryThreads = [...entries, entry];
              return entry;
            },
          );
        },
        acknowledgeTemporaryThread(expected, targetInput, authority) {
          const target = {
            chatId: targetInput.chatId,
            threadId: targetInput.threadId,
          };
          return advanceTemporary(expected, authority, (entry, file) => {
            if (
              entry.phase !== "creating" ||
              target.chatId !== entry.operatorUserId ||
              !Number.isSafeInteger(target.threadId) ||
              target.threadId <= 0 ||
              file.temporaryThreads!.some(
                (value) =>
                  !!value.target && targetMatches(value.target, target),
              ) ||
              file.operations.some(
                ({ request }) =>
                  targetMatches(request.target, target) ||
                  targetMatches(request.binding.target, target),
              )
            )
              return false;
            entry.phase = "created";
            entry.target = target;
            return true;
          });
        },
        adoptTemporaryThread(expected, authority) {
          return advanceTemporary(
            expected,
            authority,
            (entry, _file, executor) =>
              !isDeepStrictEqual(entry.executor, executor),
            true,
          );
        },
        recordTemporaryThreadInput(expected, inputValue, authority) {
          const input = structuredClone(inputValue);
          if (!isTemporaryThreadInput(input)) return undefined;
          return advanceTemporary(expected, authority, (entry, file) => {
            if (
              entry.phase !== "created" ||
              input.journalBindingKey !== entry.source.journalBindingKey ||
              file.operations.some(({ request }) =>
                targetMatches(request.target, entry.target!),
              )
            )
              return false;
            const inputs = getBaleTemporaryThreadInputs(entry);
            if (inputs.some((value) => isDeepStrictEqual(value, input)))
              return "unchanged";
            if (
              entry.cleanupIssued ||
              inputs.some((value) =>
                value.updateIds.some((id) => input.updateIds.includes(id)),
              ) ||
              file.temporaryThreads!.some(
                (value) =>
                  value !== entry &&
                  getBaleTemporaryThreadInputs(value).some(
                    (other) =>
                      other.journalBindingKey === input.journalBindingKey &&
                      other.updateIds.some((id) =>
                        input.updateIds.includes(id),
                      ),
                  ),
              )
            )
              return false;
            if (inputs.length >= TEMPORARY_THREAD_INPUT_CAPACITY)
              throw new Error("Temporary Thread input capacity reached.");
            entry.inputs = [...inputs, input];
            return true;
          });
        },
        recordTemporaryThreadInputCancellation(
          expected,
          inputValue,
          authority,
          inspect,
        ) {
          const input = structuredClone(inputValue);
          if (!isTemporaryThreadInput(input) || typeof inspect !== "function")
            return undefined;
          const operatorUserId = authority.operatorUserId,
            executor = structuredClone(authority.executor);
          const owned = (): boolean =>
            authority.isCurrent() &&
            authority.operatorUserId === operatorUserId &&
            isDeepStrictEqual(authority.executor, executor);
          // Every publication fence observes retained proof again; neither cached cancellation nor absence suffices.
          const current = (): boolean =>
            owned() &&
            input.updateIds.every((updateId) => {
              const evidence = inspect(updateId);
              return (
                evidence?.journalBindingKey === input.journalBindingKey &&
                evidence.updateId === updateId &&
                evidence.operatorAuthorityId ===
                  `bale-owner:${operatorUserId}`
              );
            }) &&
            owned();
          const recorded = advanceTemporary(
            expected,
            { ...authority, isCurrent: current },
            (entry, file) => {
              if (!isTemporaryThreadInputAdvanceable(entry, file, input))
                return false;
              const cancelled = entry.cancelledInputs ?? [];
              if (
                cancelled.some((candidate) =>
                  isDeepStrictEqual(candidate, input),
                )
              )
                return "unchanged";
              if (
                entry.completedInputs?.some((candidate) =>
                  isDeepStrictEqual(candidate, input),
                ) ||
                entry.forwardedInputs?.some((candidate) =>
                  isDeepStrictEqual(candidate, input),
                )
              )
                return false;
              entry.cancelledInputs = [...cancelled, input];
              return true;
            },
          );
          return recorded && current() ? recorded : undefined;
        },
        recordTemporaryThreadInputExpiry(
          expected,
          inputValue,
          authority,
          inspect,
        ) {
          const input = structuredClone(inputValue);
          if (!isTemporaryThreadInput(input) || typeof inspect !== "function")
            return undefined;
          const operator = authority.operatorUserId,
            executor = structuredClone(authority.executor);
          const bound =
            classifyTemporaryTarget(read(), expected).kind === "bound";
          const current = () =>
            authority.isCurrent() &&
            authority.operatorUserId === operator &&
            isDeepStrictEqual(authority.executor, executor) &&
            input.updateIds.every((updateId) => {
              const evidence = inspect(updateId);
              return (
                evidence?.journalBindingKey === input.journalBindingKey &&
                evidence.updateId === updateId &&
                evidence.operatorAuthorityId === `bale-owner:${operator}`
              );
            }) &&
            authority.isCurrent();
          return advanceTemporary(
            expected,
            { ...authority, isCurrent: current },
            (entry, file) => {
              if (
                entry.phase !== "created" ||
                !getBaleTemporaryThreadInputs(entry).some((value) =>
                  isDeepStrictEqual(value, input),
                ) ||
                entry.completedInputs?.some((value) =>
                  isDeepStrictEqual(value, input),
                )
              )
                return false;
              const cancelled = entry.cancelledInputs ?? [];
              if (cancelled.some((value) => isDeepStrictEqual(value, input)))
                return "unchanged";
              const operations = file.operations.filter(
                ({ request }) =>
                  request.source.journalBindingKey ===
                    input.journalBindingKey &&
                  request.source.updateIds.some((id) =>
                    input.updateIds.includes(id),
                  ),
              );
              if (
                operations.some(
                  ({ request }) =>
                    !request.source.updateIds.every((id) =>
                      input.updateIds.includes(id),
                    ),
                )
              )
                return false;
              // Forget only expired donor intent; canonical binding, recipient queue and immutable settlement proofs are untouched.
              file.operations = file.operations.filter(
                (value) => !operations.includes(value),
              );
              // Once bound, this is no longer a disposable tab. Forget its temporary frame, not the binding or other journal sources.
              if (bound) {
                file.temporaryThreads = file.temporaryThreads?.filter(
                  (value) => value !== entry,
                );
                if (!file.temporaryThreads?.length)
                  delete file.temporaryThreads;
                return true;
              }
              const forwarded = entry.forwardedInputs?.filter(
                (value) => !isDeepStrictEqual(value, input),
              );
              if (forwarded?.length) entry.forwardedInputs = forwarded;
              else delete entry.forwardedInputs;
              entry.cancelledInputs = [...cancelled, input];
              return true;
            },
          );
        },
        recordTemporaryThreadForwardIssued(expected, inputValue, authority) {
          const input = structuredClone(inputValue);
          if (!isTemporaryThreadInput(input)) return undefined;
          return advanceTemporary(expected, authority, (entry, file) => {
            if (
              !isTemporaryThreadInputAdvanceable(entry, file, input) ||
              [
                ...(entry.cancelledInputs ?? []),
                ...(entry.completedInputs ?? []),
                ...(entry.forwardedInputs ?? []),
              ].some((candidate) => isDeepStrictEqual(candidate, input))
            )
              return false;
            entry.forwardedInputs = [...(entry.forwardedInputs ?? []), input];
            return true;
          });
        },
        recordTemporaryThreadInputCompletion(expected, inputValue, authority) {
          const input = structuredClone(inputValue);
          if (!isTemporaryThreadInput(input)) return undefined;
          return advanceTemporary(expected, authority, (entry, file) => {
            if (
              !isTemporaryThreadInputAdvanceable(entry, file, input) ||
              entry.cancelledInputs?.some((candidate) =>
                isDeepStrictEqual(candidate, input),
              )
            )
              return false;
            const completed = entry.completedInputs ?? [];
            if (
              completed.some((candidate) => isDeepStrictEqual(candidate, input))
            )
              return "unchanged";
            entry.completedInputs = [...completed, input];
            return true;
          });
        },
        issueTemporaryThreadCleanup(expected, authority) {
          const entry = advanceTemporary(expected, authority, (value) => {
            if (
              value.phase !== "created" ||
              value.cleanupIssued ||
              !isBaleTemporaryThreadFullyResolved(value)
            )
              return false;
            value.cleanupIssued = true;
            return true;
          });
          return entry ? { issued: true, entry } : undefined;
        },
        retireTemporaryThread(expected, authority, completed) {
          return mutate<BaleTemporaryThreadEntry>(
            authority,
            (file, executor, operator) => {
              const entries = file.temporaryThreads ?? [];
              const index = entries.findIndex((value) =>
                isDeepStrictEqual(value, expected),
              );
              const entry = entries[index];
              if (
                !entry ||
                entry.operatorUserId !== operator ||
                !isDeepStrictEqual(entry.executor, executor) ||
                (getBaleTemporaryThreadInputs(entry).length > 1 &&
                  !isBaleTemporaryThreadFullyResolved(entry) &&
                  !isTemporaryThreadReleasedByCompletion(entry, completed))
              )
                return undefined;
              const remaining = entries.filter(
                (_value, position) => position !== index,
              );
              if (remaining.length) file.temporaryThreads = remaining;
              else delete file.temporaryThreads;
              return entry;
            },
          );
        },
        forgetPreviousWorld(authority, preserveTemporaryTokens = []) {
          if (!authority.isCurrent()) return undefined;
          const executor = structuredClone(authority.executor),
            operator = authority.operatorUserId;
          if (
            !isBaleWorkspaceRestoreExecutor(executor) ||
            !restoreInteger(operator)
          )
            return undefined;
          const current = (): boolean =>
            authority.isCurrent() &&
            authority.operatorUserId === operator &&
            isDeepStrictEqual(authority.executor, executor);
          const previous = (value: {
            operatorUserId: number;
            executor: BaleWorkspaceRestoreExecutor;
          }) =>
            value.operatorUserId === operator &&
            value.executor.instanceId !== executor.instanceId;
          const before = storage.read(),
            file = structuredClone(before);
          const forgetTemporary = (value: BaleTemporaryThreadEntry) =>
            previous(value) && !preserveTemporaryTokens.includes(value.token);
          const forgetLive = (value: BaleWorkspaceLiveRebindIntent) =>
            previous(value);
          const liveRebindings = (file.liveRebindings ?? []).filter(forgetLive);
          const operations = file.operations.filter(previous),
            temporaryThreads = (file.temporaryThreads ?? []).filter(
              forgetTemporary,
            );
          const forgotten = {
            operations,
            temporaryThreads,
            ...(liveRebindings.length ? { liveRebindings } : {}),
          };
          if (!current()) return undefined;
          if (
            !operations.length &&
            !temporaryThreads.length &&
            !liveRebindings.length
          )
            return forgotten;
          file.operations = file.operations.filter((value) => !previous(value));
          const remainingLive = (file.liveRebindings ?? []).filter(
            (value) => !forgetLive(value),
          );
          if (remainingLive.length) file.liveRebindings = remainingLive;
          else delete file.liveRebindings;
          const remaining = (file.temporaryThreads ?? []).filter(
            (value) => !forgetTemporary(value),
          );
          if (remaining.length) file.temporaryThreads = remaining;
          else delete file.temporaryThreads;
          if (file.revision === Number.MAX_SAFE_INTEGER)
            throw new Error("Workspace Restore revision exhausted.");
          file.revision += 1;
          return storage.update(before, file, current)
            ? structuredClone(forgotten)
            : undefined;
        },
        /** Ends protection without cleanup: the old Thread is kept, and no source was ever dispatched. */
        retireAbandoned(expected, abandonedUpdateIds, authority) {
          const abandoned = [...new Set(abandonedUpdateIds)].sort(
            (left, right) => left - right,
          );
          return mutate(authority, (file, executor, operator) => {
            const index = file.operations.findIndex(
              (value) =>
                value.request.operationId === expected.request.operationId,
            );
            const operation = file.operations[index];
            if (
              !operation ||
              !isDeepStrictEqual(operation, expected) ||
              operation.operatorUserId !== operator ||
              !isDeepStrictEqual(operation.executor, executor) ||
              operation.phase !== "ready" ||
              operation.routing !== undefined ||
              !isDeepStrictEqual(abandoned, operation.request.source.updateIds)
            )
              return undefined;
            file.operations.splice(index, 1);
            return operation;
          });
        },
        /** Caller proves current canonical ownership and authenticates a read-only observation, including successors. */
        confirmInspectedReady(expected, observed, authority) {
          return advance(expected, authority, (operation) => {
            if (
              (operation.phase !== "recipient-issued" &&
                operation.phase !== "ready") ||
              !isBaleWorkspaceRestoreRecipient(observed) ||
              observed.sessionId !== operation.request.binding.sessionId
            )
              return false;
            operation.phase = "ready";
            operation.readyRecipient = structuredClone(observed);
            return true;
          });
        },
        /** Caller authenticates the exact-generation ACK; stored metadata alone is never readiness proof. */
        confirmReady(expected, acknowledged, authority) {
          return advance(expected, authority, (operation) => {
            if (
              operation.phase !== "recipient-issued" ||
              !isDeepStrictEqual(operation.recipient, acknowledged)
            )
              return false;
            operation.phase = "ready";
            return true;
          });
        },
      };
    },
    list() {
      return Array.from(records.values()).map(cloneRecord);
    },
    getFollowerRecoveryHintByTarget(target) {
      const hint = followerRecoveryHints.get(getTargetRecoveryHintKey(target));
      return hint ? { ...hint } : undefined;
    },
    listReservations() {
      const nowMs = getNowMs();
      return reservations
        .filter(
          (reservation) =>
            reservation.expiresAtMs === undefined ||
            reservation.expiresAtMs > nowMs,
        )
        .map((reservation) => ({ ...reservation }));
    },
    listPendingProvisions() {
      const nowMs = getNowMs();
      return pendingProvisions
        .filter((provision) =>
          isPendingProvisionLiveOrTargeted(provision, nowMs),
        )
        .map((provision) => ({
          ...provision,
          ...(provision.target ? { target: { ...provision.target } } : {}),
        }));
    },
    listPendingCleanups() {
      return pendingCleanups.map((intent) => ({
        ...intent,
        target: { ...intent.target },
      }));
    },
    listSyncObservations() {
      return syncObservations.map((observation) => ({
        ...observation,
        target: { ...observation.target },
      }));
    },
    reserveThread(reservation) {
      if (
        pendingWorkspaceRelocationRequests(workspaceRestore).some((request) =>
          conflictsWithWorkspaceRestoreProvision(request, reservation),
        ) ||
        conflictsWithTemporaryThread(workspaceRestore, reservation.target) ||
        protectedLiveRebindOldTargets(workspaceRestore).some(old => targetMatches(old, reservation.target))
      ) {
        throw new Error("Protected Workspace Restore provisioning conflict.");
      }
      const next = { ...reservation };
      reservations = reservations.filter(
        (existing) =>
          existing.slot !== next.slot &&
          !targetMatches(existing.target, next.target),
      );
      reservations.push(next);
      markDirty();
    },
    upsertPendingProvision(provision) {
      if (
        pendingWorkspaceRelocationRequests(workspaceRestore).some((request) =>
          conflictsWithWorkspaceRestoreProvision(request, provision),
        ) ||
        conflictsWithTemporaryThread(workspaceRestore, provision.target) ||
        protectedLiveRebindOldTargetIntents(workspaceRestore).some(({ request }) => conflictsWithWorkspaceRestoreProvision(request, provision))
      ) {
        throw new Error("Protected Workspace Restore provisioning conflict.");
      }
      const next = {
        ...provision,
        ...(provision.target ? { target: { ...provision.target } } : {}),
      };
      pendingProvisions = pendingProvisions.filter(
        (existing) => existing.id !== next.id,
      );
      pendingProvisions.push(next);
      markDirty();
    },
    async recordPendingProvisionTargetRecovery(provision, target) {
      const path = getPath();
      const recoveryPath = getRecoveryPath(path);
      await mkdir(dirname(recoveryPath), { recursive: true });
      withStoreTransaction(path, () => {
        const recoveries = readProvisionRecoveries(path, true);
        const recovery = {
          instanceId: provision.instanceId,
          ...(provision.profileKey ? { profileKey: provision.profileKey } : {}),
          ...(provision.leaderEpoch !== undefined
            ? { leaderEpoch: provision.leaderEpoch }
            : {}),
          target: { ...target },
        };
        if (Object.hasOwn(recoveries, provision.id)) {
          if (!isDeepStrictEqual(recoveries[provision.id], recovery))
            throw new Error(
              "Conflicting Workspace provisioning recovery evidence.",
            );
          return;
        }
        recoveries[provision.id] = recovery;
        const tempPath = `${recoveryPath}.${process.pid}.${randomUUID()}.tmp`;
        writeFileSync(tempPath, `${JSON.stringify(recoveries, null, 2)}\n`, {
          encoding: "utf8",
          mode: 0o600,
        });
        renameSync(tempPath, recoveryPath);
        chmodSync(recoveryPath, 0o600);
      });
      const current = pendingProvisions.find(
        (entry) =>
          entry.id === provision.id &&
          entry.instanceId === provision.instanceId &&
          entry.profileKey === provision.profileKey &&
          entry.leaderEpoch === provision.leaderEpoch,
      );
      if (!current) return false;
      current.target = { ...target };
      current.status = "ambiguous";
      return true;
    },
    resetPendingProvisionForConnect(expected, isCurrent) {
      // Stage no in-memory deletion: refusal or a stale publication must keep its protective hold.
      if (expected.target || !isCurrent()) return Promise.resolve(false);
      return persistSnapshot(undefined, isCurrent, [structuredClone(expected)]);
    },
    removePendingProvision(id) {
      const before = pendingProvisions.length;
      pendingProvisions = pendingProvisions.filter(
        (provision) => provision.id !== id,
      );
      const changed = pendingProvisions.length !== before;
      if (changed) markDirty();
      return changed;
    },
    upsertPendingCleanup(intent) {
      const next = { ...intent, target: { ...intent.target } };
      pendingCleanups = pendingCleanups.filter(
        (existing) => existing.id !== next.id,
      );
      pendingCleanups.push(next);
      markDirty();
    },
    removePendingCleanup(id) {
      const before = pendingCleanups.length;
      pendingCleanups = pendingCleanups.filter((intent) => intent.id !== id);
      const changed = pendingCleanups.length !== before;
      if (changed) markDirty();
      return changed;
    },
    getBotState() {
      return Object.fromEntries(
        Object.entries(botState).filter(([, value]) => value !== undefined),
      ) as BaleBotStateSnapshot;
    },
    setBotState(state) {
      botState = { ...botState, ...state };
      markDirty();
    },
    setStatusSnapshot(snapshot) {
      if (!loadedPath) {
        loadedPath = getPath();
        loadedProfile = activeProfile();
      }
      statusSnapshot = { ...snapshot };
    },
    persistStatus() {
      if (runtimeProjection)
        return runtimeProjection
          .persist({
            runtime: statusSnapshot.runtime ?? {},
            liveRoster: statusSnapshot.liveRoster ?? {},
            diagnostics: statusSnapshot.diagnostics ?? {},
          })
          .then(() => undefined);
      const write = statusQueue.then(async () => {
        if (options.canPersist && !options.canPersist()) return;
        const body = { version: 1, source: "snapshot", ...statusSnapshot };
        // Normalize to wire JSON; object key order and omitted undefined are not changes.
        const semantic = JSON.parse(JSON.stringify(body)) as Record<
          string,
          unknown
        >;
        const statusPath = getStatusPath();
        if (
          isDeepStrictEqual(semantic, lastStatusSemantic) &&
          statusPath === lastStatusPath
        )
          return;
        await mkdir(dirname(statusPath), { recursive: true });
        const tempPath = `${statusPath}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
        await writeFile(
          tempPath,
          `${JSON.stringify({ ...body, writtenAtMs: (options.getNowMs ?? Date.now)() }, null, 2)}\n`,
          { encoding: "utf8", flag: "wx", mode: 0o600 },
        );
        try {
          replaceBaleWorkspaceFile(tempPath, statusPath);
          chmodSync(statusPath, 0o600);
        } catch (error) {
          await unlink(tempPath).catch(() => undefined);
          throw error;
        }
        lastStatusSemantic = semantic;
        lastStatusPath = statusPath;
      });
      statusQueue = write.then(
        () => undefined,
        () => undefined,
      );
      return write;
    },
    getByProfileKey(profileKey) {
      const ownerKey = getBaleThreadOwnerKey(
        getBaleThreadOwnerFromProfileKey(profileKey),
      );
      const record = records.get(ownerKey) ?? records.get(profileKey);
      return record ? cloneRecord(record) : undefined;
    },
    getActiveByInstanceId(instanceId) {
      for (const record of records.values()) {
        if (record.instanceId !== instanceId) continue;
        if (record.status !== "active" && record.status !== "starting")
          continue;
        return cloneRecord(record);
      }
      return undefined;
    },
    getIdentityByProfileKey(profileKey) {
      const ownerKey = getBaleThreadOwnerKey(
        getBaleThreadOwnerFromProfileKey(profileKey),
      );
      const identity = identities.get(ownerKey) ?? identities.get(profileKey);
      return identity ? cloneIdentityRecord(identity) : undefined;
    },
    forgetIdentityByProfileKey(profileKey) {
      const ownerKey = getBaleThreadOwnerKey(
        getBaleThreadOwnerFromProfileKey(profileKey),
      );
      const removedOwner = identities.delete(ownerKey);
      const removedProfile = identities.delete(profileKey);
      if (!removedOwner && !removedProfile) return false;
      markDirty();
      return true;
    },
    listWorkspaceBindings() {
      return Array.from(workspaceBindings.values()).map(cloneWorkspaceBinding);
    },
    getWorkspaceBindingByTarget(target, sessionId) {
      const binding = Array.from(workspaceBindings.values()).find(
        (candidate) =>
          targetMatches(candidate.target, target) &&
          (sessionId === undefined || candidate.sessionId === sessionId),
      );
      return binding ? cloneWorkspaceBinding(binding) : undefined;
    },
    getSessionReplacementIntent() {
      return sessionReplacement
        ? cloneSessionReplacementIntent(sessionReplacement)
        : undefined;
    },
    async commitSessionReplacementIntent(intent, isCurrent) {
      const next = normalizeBaleSessionReplacementIntent(intent);
      if (!next || !isCurrent()) return false;
      await loadFromDisk();
      if (!isCurrent()) return false;
      const existing = sessionReplacement;
      if (
        existing &&
        existing.expiresAtMs > getNowMs() &&
        !isDeepStrictEqual(existing, next)
      )
        return false;
      sessionReplacement = cloneSessionReplacementIntent(next);
      markDirty();
      return (await persistSnapshot()) && isCurrent();
    },
    async removeSessionReplacementIntent(expected, isCurrent) {
      await loadFromDisk();
      if (
        !isCurrent() ||
        !sessionReplacement ||
        !isDeepStrictEqual(sessionReplacement, expected)
      )
        return false;
      sessionReplacement = undefined;
      markDirty();
      return (await persistSnapshot()) && isCurrent();
    },
    listWorkspaceRetirementIntents() {
      return workspaceRetirements.map(cloneWorkspaceRetirementIntent);
    },
    commitWorkspaceJournalEvidence(
      expected,
      journalBindingKeys,
      complete,
      journalSources,
    ) {
      if (
        workspaceRetirementCommitInFlight ||
        hasWorkspaceRetirementConflict(expected)
      ) {
        return undefined;
      }
      const key = getWorkspaceBindingMapKey(expected);
      const current = workspaceBindings.get(key);
      if (
        !current ||
        !isDeepStrictEqual(current, expected) ||
        !journalBindingKeys.every(
          (bindingKey) =>
            typeof bindingKey === "string" &&
            bindingKey.length > 0 &&
            bindingKey.length <= 512,
        )
      )
        return undefined;
      const keys = Array.from(new Set(journalBindingKeys));
      const sources =
        journalSources === undefined
          ? (current.journalSources ?? [])
          : normalizeWorkspaceJournalSources(journalSources);
      if (
        !sources ||
        sources.some(
          (source) =>
            !(current.journalSources ?? []).some((retained) =>
              isDeepStrictEqual(retained, source),
            ),
        )
      )
        return undefined;
      if (
        (current.journalBindingsComplete === true) === complete &&
        isDeepStrictEqual(current.journalBindingKeys ?? [], keys) &&
        isDeepStrictEqual(current.journalSources ?? [], sources)
      ) {
        return cloneWorkspaceBinding(current);
      }
      const next = { ...current, updatedAtMs: getNowMs() };
      // A complete empty set stays explicit so persisted completeness survives a lossless reload.
      if (keys.length || complete) next.journalBindingKeys = keys;
      else delete next.journalBindingKeys;
      if (sources.length)
        next.journalSources = sources.map((source) => ({ ...source }));
      else delete next.journalSources;
      if (complete) next.journalBindingsComplete = true;
      else delete next.journalBindingsComplete;
      workspaceBindings.set(key, next);
      markDirty();
      return cloneWorkspaceBinding(next);
    },
    async persistWorkspaceJournalEvidence(expected, isCurrent) {
      const path = getPath();
      const frameCurrent = () =>
        getPath() === path &&
        isCurrent() &&
        isDeepStrictEqual(
          workspaceBindings.get(getWorkspaceBindingMapKey(expected)),
          expected,
        );
      if (!frameCurrent()) return false;
      const current = () => frameCurrent() && options.canPersist?.() !== false;
      const published = await persistSnapshot(undefined, current);
      return published && current();
    },
    upsertWorkspaceRetirementIntent(intent) {
      const next = normalizeWorkspaceRetirementIntent(intent);
      if (!next) return false;
      const current = workspaceBindings.get(
        getWorkspaceBindingMapKey(next.binding),
      );
      if (!current || !isDeepStrictEqual(current, next.binding)) return false;
      const sameId = workspaceRetirements.find(
        (candidate) => candidate.id === next.id,
      );
      if (sameId) return isDeepStrictEqual(sameId, next);
      if (
        workspaceRetirements.some(
          (candidate) =>
            candidate.binding.bindingKey === next.binding.bindingKey ||
            candidate.binding.slot === next.binding.slot ||
            targetMatches(candidate.binding.target, next.binding.target),
        )
      )
        return false;
      workspaceRetirements.push(cloneWorkspaceRetirementIntent(next));
      markDirty();
      return true;
    },
    removeWorkspaceRetirementIntent(expected) {
      const index = workspaceRetirements.findIndex((candidate) =>
        isDeepStrictEqual(candidate, expected),
      );
      if (index < 0) return false;
      workspaceRetirements.splice(index, 1);
      markDirty();
      return true;
    },
    async replaceWorkspaceRetirementIntent(expected, replacement, isCurrent) {
      if (workspaceRetirementCommitInFlight || !isCurrent()) return false;
      const previous = normalizeWorkspaceRetirementIntent(expected);
      const next = normalizeWorkspaceRetirementIntent(replacement);
      if (
        !previous ||
        !next ||
        previous.id !== next.id ||
        previous.reason !== next.reason ||
        previous.profileKey !== next.profileKey ||
        previous.requestedAtMs !== next.requestedAtMs ||
        !isDeepStrictEqual(previous.binding, next.binding)
      )
        return false;
      const binding = workspaceBindings.get(
        getWorkspaceBindingMapKey(previous.binding),
      );
      const intentIndex = workspaceRetirements.findIndex((candidate) =>
        isDeepStrictEqual(candidate, previous),
      );
      if (
        !binding ||
        !isDeepStrictEqual(binding, previous.binding) ||
        intentIndex < 0
      ) {
        return false;
      }
      if (isDeepStrictEqual(previous, next)) return true;
      workspaceRetirementCommitInFlight = true;
      workspaceRetirements[intentIndex] = cloneWorkspaceRetirementIntent(next);
      markDirty();
      const restoreInMemory = () => {
        workspaceRetirements = workspaceRetirements.filter(
          (candidate) => candidate.id !== previous.id,
        );
        workspaceRetirements.push(cloneWorkspaceRetirementIntent(previous));
        markDirty();
      };
      try {
        if (!isCurrent()) {
          restoreInMemory();
          return false;
        }
        const persisted = await persistSnapshot();
        if (!persisted) {
          restoreInMemory();
          return false;
        }
        return true;
      } catch (error) {
        try {
          await loadFromDisk();
        } catch {
          restoreInMemory();
          throw error;
        }
        if (
          workspaceRetirements.some((candidate) =>
            isDeepStrictEqual(candidate, next),
          )
        ) {
          return true;
        }
        if (
          !workspaceRetirements.some((candidate) =>
            isDeepStrictEqual(candidate, previous),
          )
        ) {
          restoreInMemory();
        }
        throw error;
      } finally {
        workspaceRetirementCommitInFlight = false;
      }
    },
    async commitInactiveWorkspaceCleanup(expected, isCurrent) {
      if (workspaceRetirementCommitInFlight || !isCurrent()) return false;
      const cleanupSnapshot =
        "bindingUpdatedAtMs" in expected ? expected : undefined;
      const normalized = cleanupSnapshot
        ? undefined
        : normalizeWorkspaceBindingRecord(expected);
      const cleanupSessionId =
        cleanupSnapshot?.sessionId === undefined
          ? undefined
          : normalizeBaleSessionId(cleanupSnapshot.sessionId);
      const cleanupSessionKey = cleanupSessionId
        ? createBaleSessionKey(cleanupSessionId)
        : undefined;
      if (
        cleanupSnapshot &&
        (!cleanupSnapshot.cwd ||
          !cleanupSnapshot.workspaceKey ||
          !cleanupSnapshot.instanceSlot ||
          !(cleanupSnapshot.slot === null || (typeof cleanupSnapshot.slot === "string" && /^[A-Z]$/u.test(cleanupSnapshot.slot))) ||
          !cleanupSnapshot.bindingKey ||
          ((cleanupSnapshot.sessionId !== undefined ||
            cleanupSnapshot.sessionKey !== undefined) &&
            (!cleanupSessionId ||
              cleanupSnapshot.sessionKey !== cleanupSessionKey)) ||
          !Number.isSafeInteger(cleanupSnapshot.inactiveSinceMs) ||
          !Number.isSafeInteger(cleanupSnapshot.bindingUpdatedAtMs) ||
          !Number.isSafeInteger(cleanupSnapshot.target.chatId) ||
          !Number.isSafeInteger(cleanupSnapshot.target.threadId) ||
          cleanupSnapshot.target.threadId <= 0)
      )
        return false;
      if (
        !cleanupSnapshot &&
        (!normalized || normalized.inactiveSinceMs === undefined)
      )
        return false;
      const mapKey = getWorkspaceBindingMapKey(
        (cleanupSnapshot ?? normalized)!,
      );
      const binding = workspaceBindings.get(mapKey);
      if (!binding) return isCurrent();
      const exact = cleanupSnapshot
        ? binding.cwd === cleanupSnapshot.cwd &&
          binding.workspaceKey === cleanupSnapshot.workspaceKey &&
          binding.sessionId === cleanupSessionId &&
          binding.sessionKey === cleanupSessionKey &&
          binding.instanceSlot === cleanupSnapshot.instanceSlot &&
          (binding.slot ?? null) === cleanupSnapshot.slot &&
          binding.bindingKey === cleanupSnapshot.bindingKey &&
          targetMatches(binding.target, cleanupSnapshot.target) &&
          binding.inactiveSinceMs === cleanupSnapshot.inactiveSinceMs &&
          binding.updatedAtMs === cleanupSnapshot.bindingUpdatedAtMs
        : isDeepStrictEqual(binding, normalized);
      if (!exact) return false;
      const nowMs = getNowMs();
      if (isWorkspaceBindingLocallyProtected(binding, nowMs)) return false;
      workspaceRetirementCommitInFlight = true;
      workspaceBindings.delete(mapKey);
      markDirty();
      const restore = () => {
        workspaceBindings.set(mapKey, cloneWorkspaceBinding(binding));
        markDirty();
      };
      try {
        if (!isCurrent()) {
          restore();
          return false;
        }
        if (!(await persistSnapshot())) {
          restore();
          return false;
        }
        return true;
      } catch (error) {
        try {
          await loadFromDisk();
        } catch {
          restore();
          throw error;
        }
        if (!workspaceBindings.has(mapKey)) return true;
        if (!isDeepStrictEqual(workspaceBindings.get(mapKey), binding))
          restore();
        throw error;
      } finally {
        workspaceRetirementCommitInFlight = false;
      }
    },
    async commitWorkspaceRetirement(expected, isCurrent) {
      if (workspaceRetirementCommitInFlight || !isCurrent()) return false;
      const normalized = normalizeWorkspaceRetirementIntent(expected);
      if (!normalized) return false;
      const mapKey = getWorkspaceBindingMapKey(normalized.binding);
      const binding = workspaceBindings.get(mapKey);
      const intentIndex = workspaceRetirements.findIndex((candidate) =>
        isDeepStrictEqual(candidate, normalized),
      );
      if (
        !binding ||
        !isDeepStrictEqual(binding, normalized.binding) ||
        intentIndex < 0
      ) {
        return false;
      }
      const nowMs = getNowMs();
      if (
        isWorkspaceBindingLocallyProtected(binding, nowMs, {
          isRetirementExcluded: (_intent, index) => index === intentIndex,
        })
      )
        return false;
      const previousRetirements = workspaceRetirements.map(
        cloneWorkspaceRetirementIntent,
      );
      workspaceRetirementCommitInFlight = true;
      workspaceBindings.delete(mapKey);
      workspaceRetirements.splice(intentIndex, 1);
      markDirty();
      const restoreInMemory = () => {
        workspaceBindings.set(mapKey, cloneWorkspaceBinding(binding));
        workspaceRetirements = previousRetirements.map(
          cloneWorkspaceRetirementIntent,
        );
        markDirty();
      };
      try {
        if (!isCurrent()) {
          restoreInMemory();
          return false;
        }
        const persisted = await persistSnapshot();
        if (!persisted) {
          restoreInMemory();
          return false;
        }
        return true;
      } catch (error) {
        try {
          await loadFromDisk();
        } catch {
          restoreInMemory();
          throw error;
        }
        const committed =
          !workspaceBindings.has(mapKey) &&
          !workspaceRetirements.some(
            (candidate) => candidate.id === normalized.id,
          );
        if (committed) return true;
        if (
          !workspaceBindings.has(mapKey) ||
          !workspaceRetirements.some(
            (candidate) => candidate.id === normalized.id,
          )
        ) {
          restoreInMemory();
        }
        throw error;
      } finally {
        workspaceRetirementCommitInFlight = false;
      }
    },
    captureWorkspaceSlotOccupancy(getExternalProtection, options) {
      const nowMs = getNowMs();
      const inSnapshot =
        getExternalProtection.withSnapshot ?? ((capture) => capture());
      // A slotless binding (legacy or reassigned) holds no letter, so it can neither block planning nor be retired for capacity.
      const bindings = inSnapshot(() => Array.from(workspaceBindings.values()).filter((binding) => binding.slot).map((binding) => {
        const slot = binding.slot!.toLowerCase();
        const locallyProtected = isWorkspaceBindingLocallyProtected(
          binding,
          nowMs,
          {
            isRetirementExcluded: (intent) =>
              isDeepStrictEqual(intent, options?.expectedRetirement),
          },
        );
        const externalProtection = getExternalProtection(
          cloneWorkspaceBinding(binding),
        );
        const externalStates = [
          externalProtection.liveOwner,
          externalProtection.acceptedWork,
          externalProtection.deliveryAuthority,
        ];
        const hasValidInactivity =
          binding.inactiveSinceMs !== undefined &&
          Number.isFinite(binding.inactiveSinceMs) &&
          binding.inactiveSinceMs >= 0 &&
          binding.inactiveSinceMs <= nowMs;
        const protection: BaleWorkspaceSlotOccupancy["protection"] =
          locallyProtected || externalStates.includes("protected")
            ? "protected"
            : externalStates.every((state) => state === "clear") &&
                hasValidInactivity
              ? "eligible"
              : "unknown";
        return {
          bindingKey: binding.bindingKey,
          slot,
          ...(binding.inactiveSinceMs !== undefined
            ? { inactiveSinceMs: binding.inactiveSinceMs }
            : {}),
          protection,
        };
      }));
      const localReservedSlots = [
        ...Array.from(workspaceClaims.values()).map(
          (claim) => claim.identity.slot,
        ),
        ...Array.from(records.values())
          .filter(ThreadReconciler.isCurrentThreadRecord)
          .map((record) => record.slot),
        ...reservations
          .filter(
            (reservation) =>
              reservation.expiresAtMs === undefined ||
              reservation.expiresAtMs > nowMs,
          )
          .map((reservation) => reservation.slot),
        ...pendingProvisions
          .filter((provision) =>
            isPendingProvisionLiveOrTargeted(provision, nowMs),
          )
          .map((provision) => provision.slot),
      ]
        .filter((slot): slot is string => !!slot && /^[A-Z]$/u.test(slot))
        .map((slot) => slot.toLowerCase());
      const externalReservedSlots = captureExternalReservedSlots();
      const reservedSlots = externalReservedSlots
        ? [
            ...localReservedSlots,
            ...externalReservedSlots.map((slot) => slot.toLowerCase()),
          ]
        : [...localReservedSlots, "invalid"];
      return { bindings, reservedSlots };
    },
    async reuseLeastRecentlyUsedWorkspaceSlot(isCurrent) {
      if (workspaceRetirementCommitInFlight || !isCurrent()) return undefined;
      const external = captureExternalReservedSlots();
      if (!external) return undefined;
      const nowMs = getNowMs();
      const currentRecords = Array.from(records.values()).filter(
        ThreadReconciler.isCurrentThreadRecord,
      );
      const held = new Set<string>(
        [
          ...external,
          ...Array.from(workspaceClaims.values()).map(
            (claim) => claim.identity.slot,
          ),
          ...reservations
            .filter(
              (reservation) =>
                reservation.expiresAtMs === undefined ||
                reservation.expiresAtMs > nowMs,
            )
            .map((reservation) => reservation.slot),
          ...pendingProvisions
            .filter((provision) =>
              isPendingProvisionLiveOrTargeted(provision, nowMs),
            )
            .map((provision) => provision.slot),
        ].filter((slot): slot is string => !!slot),
      );
      const occupied = new Set<string>([
        ...held,
        ...Array.from(workspaceBindings.values()).flatMap((binding) =>
          binding.slot ? [binding.slot] : [],
        ),
        ...currentRecords.flatMap((record) => (record.slot ? [record.slot] : [])),
      ]);
      if (
        Array.from(BALE_WORKSPACE_SLOTS, (slot) => slot.toUpperCase()).some(
          (slot) => !occupied.has(slot),
        )
      )
        return { kind: "free" };
      const claimedKeys = new Set(
        Array.from(workspaceClaims.values()).map(
          (claim) => claim.identity.bindingKey,
        ),
      );
      const candidates = Array.from(workspaceBindings.values()).flatMap(
        (binding) => {
          const slot = binding.slot;
          if (
            !slot ||
            !/^[A-Z]$/u.test(slot) ||
            held.has(slot) ||
            claimedKeys.has(binding.bindingKey) ||
            hasWorkspaceRetirementConflict({
              bindingKey: binding.bindingKey,
              target: binding.target,
              slot,
            }) ||
            pendingCleanups.some((intent) =>
              targetMatches(intent.target, binding.target),
            ) ||
            // Another Thread already holding the letter is unresolved duplication, not reusable metadata.
            currentRecords.some(
              (record) =>
                record.slot === slot && !targetMatches(record.target, binding.target),
            )
          )
            return [];
          const live = currentRecords.some((record) =>
            targetMatches(record.target, binding.target),
          );
          return [
            {
              bindingKey: binding.bindingKey,
              slot,
              live,
              lastUsedMs:
                !live && binding.inactiveSinceMs !== undefined
                  ? binding.inactiveSinceMs
                  : binding.updatedAtMs,
            },
          ];
        },
      );
      const selected = selectBaleWorkspaceReusableSlot(candidates);
      if (!selected) return undefined;
      const mapKey = Array.from(workspaceBindings.entries()).find(
        ([, binding]) => binding.bindingKey === selected.bindingKey,
      )?.[0];
      const binding = mapKey ? workspaceBindings.get(mapKey) : undefined;
      if (!mapKey || !binding) return undefined;
      const affected = currentRecords.filter(
        (record) =>
          record.slot === selected.slot && targetMatches(record.target, binding.target),
      );
      const previousBinding = cloneWorkspaceBinding(binding);
      const previousRecords = affected.map((record) => ({
        key: getRecordOwnerKey(record),
        record: cloneRecord(record),
        identity: identities.get(getRecordOwnerKey(record)),
      }));
      const { slot: _slot, ...slotless } = previousBinding;
      workspaceRetirementCommitInFlight = true;
      workspaceBindings.set(mapKey, slotless);
      for (const record of affected) {
        delete record.slot;
        const key = getRecordOwnerKey(record);
        const identity = identities.get(key);
        if (identity?.slot === selected.slot) {
          const { slot: _identitySlot, ...rest } = identity;
          identities.set(key, rest);
        }
      }
      markDirty();
      const restoreInMemory = () => {
        workspaceBindings.set(mapKey, cloneWorkspaceBinding(previousBinding));
        for (const previous of previousRecords) {
          records.set(previous.key, cloneRecord(previous.record));
          if (previous.identity) identities.set(previous.key, previous.identity);
        }
        markDirty();
      };
      try {
        if (!isCurrent() || !(await persistSnapshot())) {
          restoreInMemory();
          return undefined;
        }
        return {
          kind: "reused" as const,
          bindingKey: selected.bindingKey,
          slot: selected.slot,
        };
      } catch (error) {
        try {
          await loadFromDisk();
        } catch {
          restoreInMemory();
        }
        throw error;
      } finally {
        workspaceRetirementCommitInFlight = false;
      }
    },
    hasWorkspaceBinding(cwd, sessionId) {
      const normalizedCwd = normalizeBaleWorkspacePath(cwd);
      const normalizedSessionId =
        sessionId === undefined
          ? undefined
          : normalizeBaleSessionId(sessionId);
      if (!normalizedCwd || (sessionId !== undefined && !normalizedSessionId)) {
        return false;
      }
      return Array.from(workspaceBindings.values()).some(
        (binding) =>
          binding.cwd === normalizedCwd &&
          binding.sessionId === normalizedSessionId,
      );
    },
    setWorkspaceDisplayTitle(expected, title) {
      if (hasWorkspaceRetirementConflict(expected)) return false;
      const key = getWorkspaceBindingMapKey(expected);
      const current = workspaceBindings.get(key);
      if (
        !current ||
        !isDeepStrictEqual(current, expected) ||
        !title.trim() ||
        title.length > 128
      )
        return false;
      if (current.displayTitle === title) return true;
      workspaceBindings.set(key, { ...current, displayTitle: title });
      markDirty();
      return true;
    },
    markWorkspaceBindingInactiveByTarget,
    markWorkspaceBindingActiveByTarget(target) {
      if (hasWorkspaceRetirementConflict({ target })) return false;
      for (const [key, binding] of workspaceBindings) {
        if (
          !targetMatches(binding.target, target) ||
          binding.inactiveSinceMs === undefined
        )
          continue;
        const next = { ...binding };
        delete next.inactiveSinceMs;
        workspaceBindings.set(key, next);
        markDirty();
        return true;
      }
      return false;
    },
    getWorkspaceBinding(cwd, instanceSlot = "a", sessionId) {
      const normalizedCwd = normalizeBaleWorkspacePath(cwd);
      const normalizedSessionId =
        sessionId === undefined
          ? undefined
          : normalizeBaleSessionId(sessionId);
      if (
        !normalizedCwd ||
        !/^[a-z]+$/u.test(instanceSlot) ||
        (sessionId !== undefined && !normalizedSessionId)
      )
        return undefined;
      const mapKey = getWorkspaceBindingMapKey({
        cwd: normalizedCwd,
        instanceSlot,
        ...(normalizedSessionId ? { sessionId: normalizedSessionId } : {}),
      });
      const binding = workspaceBindings.get(mapKey);
      return binding ? cloneWorkspaceBinding(binding) : undefined;
    },
    adoptWorkspaceThreadBindingForSession(
      cwd,
      sourceSessionId,
      sessionId,
      target,
    ) {
      if (workspaceRetirementCommitInFlight) return false;
      const normalizedCwd = normalizeBaleWorkspacePath(cwd);
      const normalizedSource = normalizeBaleSessionId(sourceSessionId);
      const normalizedSession = normalizeBaleSessionId(sessionId);
      if (
        !normalizedCwd ||
        !normalizedSource ||
        !normalizedSession ||
        normalizedSource === normalizedSession ||
        hasWorkspaceRetirementConflict({ cwd: normalizedCwd })
      )
        return false;
      return rekeyWorkspaceBindingForSession(
        normalizedCwd,
        normalizedSource,
        normalizedSession,
        target,
      );
    },
    claimWorkspaceIdentity(cwd, instanceId, previousInstanceId, options) {
      if (workspaceRetirementCommitInFlight) return undefined;
      const normalizedCwd = normalizeBaleWorkspacePath(cwd);
      const normalizedSessionId =
        options?.sessionId === undefined
          ? undefined
          : normalizeBaleSessionId(options.sessionId);
      if (
        !normalizedCwd ||
        !instanceId ||
        (options?.sessionId !== undefined && !normalizedSessionId) ||
        hasWorkspaceRetirementConflict({ cwd: normalizedCwd })
      )
        return undefined;
      let replacementPreviousInstanceId: string | undefined;
      const replacement = sessionReplacement;
      if (
        replacement?.continuity === "workspace-thread" &&
        normalizedSessionId &&
        replacement.expiresAtMs > getNowMs() &&
        replacement.profileName === (getBaleProfile() ?? "default") &&
        replacement.cwd === normalizedCwd &&
        replacement.sourceSessionId !== normalizedSessionId &&
        (replacement.sourceInstanceId === undefined ||
          replacement.sourceInstanceId === instanceId ||
          replacement.sourceInstanceId === previousInstanceId)
      ) {
        const sourceEntry = Array.from(workspaceBindings.entries()).find(
          ([, binding]) =>
            binding.cwd === normalizedCwd &&
            binding.sessionId === replacement.sourceSessionId &&
            targetMatches(binding.target, replacement.target),
        );
        if (sourceEntry) {
          const existingTargetRecord = Array.from(records.values()).find(
            (record) => targetMatches(record.target, replacement.target),
          );
          if (
            rekeyWorkspaceBindingForSession(
              normalizedCwd,
              replacement.sourceSessionId,
              normalizedSessionId,
              replacement.target,
            )
          )
            replacementPreviousInstanceId = existingTargetRecord?.instanceId;
        }
      }
      const effectivePreviousInstanceId =
        previousInstanceId ?? replacementPreviousInstanceId;
      const externalReservedSlots = captureExternalReservedSlots();
      if (!externalReservedSlots) {
        options?.onCapacityUnavailable?.();
        return undefined;
      }
      const externalReservedSlotKeys = externalReservedSlots.map((slot) =>
        slot.toLowerCase(),
      );
      for (const claim of workspaceClaims.values()) {
        if (claim.instanceId !== instanceId) continue;
        if (
          claim.identity.cwd !== normalizedCwd ||
          claim.identity.sessionId !== normalizedSessionId ||
          !claim.identity.slot ||
          externalReservedSlotKeys.includes(claim.identity.slot.toLowerCase())
        ) {
          return undefined;
        }
        if (
          options?.existingBindingOnly &&
          !workspaceBindings.has(getWorkspaceBindingMapKey(claim.identity))
        )
          return undefined;
        return { ...claim.identity };
      }
      const workspaceKey = resolveWorkspaceKey(normalizedCwd);
      if (!workspaceKey) return undefined;
      let legacyRecord = normalizedSessionId
        ? undefined
        : findLegacyWorkspaceMigrationRecord(
            normalizedCwd,
            instanceId,
            previousInstanceId,
          );
      const legacyTarget = legacyRecord?.target;
      const targetBinding = legacyTarget
        ? Array.from(workspaceBindings.values()).find(
            (binding) =>
              binding.cwd === normalizedCwd &&
              targetMatches(binding.target, legacyTarget),
          )
        : undefined;
      let capacityUnavailable = false;
      const claimIdentity = (
        identity: BaleWorkspaceBindingIdentity,
      ): BaleWorkspaceBindingIdentity | undefined => {
        const mapKey = getWorkspaceBindingMapKey(identity);
        const existingClaim = workspaceClaims.get(mapKey);
        if (existingClaim) {
          if (existingClaim.instanceId === instanceId) {
            return { ...existingClaim.identity };
          }
          if (existingClaim.instanceId !== effectivePreviousInstanceId)
            return undefined;
          workspaceClaims.set(mapKey, {
            identity: existingClaim.identity,
            instanceId,
          });
          return { ...existingClaim.identity };
        }
        const binding = workspaceBindings.get(mapKey);
        const liveRecord = binding ? isWorkspaceTargetLive(binding) : undefined;
        if (
          liveRecord &&
          liveRecord.instanceId !== instanceId &&
          liveRecord.instanceId !== effectivePreviousInstanceId
        ) {
          return undefined;
        }
        const ownedProvisions = pendingProvisions.filter(value =>
          value.workspaceBindingKey === identity.bindingKey &&
          (value.instanceId === instanceId || value.instanceId === effectivePreviousInstanceId ||
            (options?.provisionProfileKey !== undefined && value.profileKey === options.provisionProfileKey)));
        if (ownedProvisions.length > 1) return undefined;
        const ownProvision = ownedProvisions[0];
        // A same-cwd session handoff keeps its predecessor's Thread slot; the Workspace commit re-keys that binding.
        const handoffBindings =
          binding ||
          ownProvision ||
          !options?.sessionHandoff ||
          !previousInstanceId ||
          !isSameBaleProcessInstance(previousInstanceId, instanceId)
            ? []
            : Array.from(workspaceBindings.values()).filter(
                (candidate) =>
                  candidate.cwd === identity.cwd &&
                  candidate.sessionId !== identity.sessionId &&
                  Array.from(records.values()).some(
                    (record) =>
                      record.instanceId === previousInstanceId &&
                      record.status === "active" &&
                      targetMatches(record.target, candidate.target),
                  ),
              );
        const handoffBinding =
          handoffBindings.length === 1 ? handoffBindings[0] : undefined;
        const retainedTarget = ownProvision?.target ?? binding?.target ?? handoffBinding?.target ?? legacyRecord?.target;
        const retainedSlot = ownProvision?.slot ?? binding?.slot ?? handoffBinding?.slot ?? legacyRecord?.slot;
        const otherBindings = Array.from(workspaceBindings.values())
          .filter(
            (other) =>
              other.bindingKey !== identity.bindingKey &&
              other.bindingKey !== handoffBinding?.bindingKey &&
              other.slot,
          )
          .map((other) => ({
            bindingKey: other.bindingKey,
            slot: other.slot!.toLowerCase(),
            protection: "unknown" as const,
          }));
        const nowMs = getNowMs();
        const reservedSlots = [
          ...Array.from(workspaceClaims.values()).map(
            (claim) => claim.identity.slot,
          ),
          ...Array.from(records.values())
            .filter(
              (record) =>
                ThreadReconciler.isCurrentThreadRecord(record) &&
                !(
                  retainedTarget && targetMatches(record.target, retainedTarget)
                ),
            )
            .map((record) => record.slot),
          ...reservations
            .filter(
              (reservation) =>
                reservation.expiresAtMs === undefined ||
                reservation.expiresAtMs > nowMs,
            )
            .map((reservation) => reservation.slot),
          ...pendingProvisions
            .filter((provision) => provision !== ownProvision &&
              isPendingProvisionLiveOrTargeted(provision, nowMs),
            )
            .map((provision) => provision.slot),
          ...externalReservedSlots,
        ]
          .filter((slot): slot is string => !!slot)
          .map((slot) => slot.toLowerCase());
        const retainedSlotKey = retainedSlot?.toLowerCase();
        if (retainedSlotKey && reservedSlots.includes(retainedSlotKey))
          return undefined;
        const retainedSlotConflicts =
          !!retainedSlotKey &&
          otherBindings.some((other) => other.slot === retainedSlotKey);
        let slot = retainedSlotConflicts
          ? Array.from(BALE_WORKSPACE_SLOTS)
              .find(
                (candidate) =>
                  !reservedSlots.includes(candidate) &&
                  !otherBindings.some((other) => other.slot === candidate),
              )
              ?.toUpperCase()
          : retainedSlot;
        if (!slot) {
          const allocation = planBaleWorkspaceSlotAllocation({
            bindings: otherBindings,
            reservedSlots,
            nowMs,
          });
          if (
            allocation.kind === "blocked" &&
            allocation.reason === "invalid-state"
          ) {
            return undefined;
          }
          if (allocation.kind !== "free") {
            capacityUnavailable = true;
            return undefined;
          }
          slot = allocation.slot.toUpperCase();
        }
        if (!slot || !/^[A-Z]$/u.test(slot)) return undefined;
        const claimedIdentity = { ...identity, slot };
        workspaceClaims.set(mapKey, {
          identity: claimedIdentity,
          instanceId,
        });
        return { ...claimedIdentity };
      };
      if (options?.existingBindingOnly) {
        const candidates = Array.from(workspaceBindings.values())
          .filter(
            (binding) =>
              binding.cwd === normalizedCwd &&
              binding.sessionId === normalizedSessionId,
          )
          .sort(
            (left, right) =>
              left.instanceSlot.length - right.instanceSlot.length ||
              left.instanceSlot.localeCompare(right.instanceSlot),
          );
        for (const binding of candidates) {
          const claimed = claimIdentity({
            cwd: binding.cwd,
            workspaceKey: binding.workspaceKey,
            ...(binding.sessionId && binding.sessionKey
              ? { sessionId: binding.sessionId, sessionKey: binding.sessionKey }
              : {}),
            instanceSlot: binding.instanceSlot,
            bindingKey: binding.bindingKey,
          });
          if (claimed) return claimed;
        }
        if (!legacyRecord) return undefined;
      }
      if (targetBinding) {
        const claimed = claimIdentity({
          cwd: targetBinding.cwd,
          workspaceKey: targetBinding.workspaceKey,
          instanceSlot: targetBinding.instanceSlot,
          bindingKey: targetBinding.bindingKey,
        });
        if (claimed) return claimed;
        if (options?.existingBindingOnly) return undefined;
        // A migrated live peer is not a handoff or a target for another slot.
        legacyRecord = undefined;
      }
      const attemptLimit = workspaceBindings.size + workspaceClaims.size + 1;
      for (let ordinal = 0; ordinal < attemptLimit; ordinal += 1) {
        const identity = createBaleWorkspaceBindingIdentityWithKey(
          normalizedCwd,
          workspaceKey,
          ordinal,
          normalizedSessionId,
        );
        if (!identity) return undefined;
        const mapKey = getWorkspaceBindingMapKey(identity);
        const binding = workspaceBindings.get(mapKey);
        if (legacyRecord && binding) continue;
        const claimed = claimIdentity(identity);
        if (!claimed) continue;
        if (legacyRecord && !binding) {
          workspaceBindings.set(mapKey, {
            ...identity,
            target: { ...legacyRecord.target },
            ...(legacyRecord.threadName
              ? { threadName: legacyRecord.threadName }
              : {}),
            ...(legacyRecord.slot ? { slot: legacyRecord.slot } : {}),
            updatedAtMs: getNowMs(),
          });
          reconcileWorkspaceSuffixExposure();
          markDirty();
        }
        return claimed;
      }
      if (capacityUnavailable) options?.onCapacityUnavailable?.();
      return undefined;
    },
    releaseWorkspaceClaim(instanceId) {
      let released = false;
      for (const [key, claim] of workspaceClaims) {
        if (claim.instanceId !== instanceId) continue;
        workspaceClaims.delete(key);
        released = true;
      }
      return released;
    },
    upsertWorkspaceBinding(binding, claimInstanceId) {
      if (workspaceRetirementCommitInFlight) return undefined;
      const next = normalizeWorkspaceBindingRecord(binding);
      if (next && hasWorkspaceRetirementConflict(next)) return undefined;
      if (!next || protectedLiveRebindOldTargets(workspaceRestore).some(old => targetMatches(old, next.target))) return undefined;
      const nextMapKey = getWorkspaceBindingMapKey(next);
      let claim = workspaceClaims.get(nextMapKey);
      const replacedTargetBinding = Array.from(workspaceBindings.values()).find(
        (existing) =>
          existing.bindingKey !== next.bindingKey &&
          targetMatches(existing.target, next.target),
      );
      const retainedSources = [
        ...(workspaceBindings.get(nextMapKey)?.journalSources ?? []),
        ...(replacedTargetBinding?.journalSources ?? []),
        ...(next.journalSources ?? []),
      ];
      if (retainedSources.length) {
        const uniqueSources = Array.from(
          new Map(
            retainedSources.map((source) => [JSON.stringify(source), source]),
          ).values(),
        );
        const journalSources = normalizeWorkspaceJournalSources(uniqueSources);
        if (!journalSources) return undefined;
        next.journalSources = journalSources;
      }
      if (
        claimInstanceId &&
        claim?.instanceId === claimInstanceId &&
        replacedTargetBinding?.slot
      ) {
        claim = {
          ...claim,
          identity: { ...claim.identity, slot: replacedTargetBinding.slot },
        };
        workspaceClaims.set(nextMapKey, claim);
        next.slot = replacedTargetBinding.slot;
        if (replacedTargetBinding.threadName && !next.threadName) {
          next.threadName = replacedTargetBinding.threadName;
        }
        if (replacedTargetBinding.manualThreadName && !next.manualThreadName) {
          next.manualThreadName = replacedTargetBinding.manualThreadName;
        }
        if (replacedTargetBinding.displayTitle && !next.displayTitle) {
          next.displayTitle = replacedTargetBinding.displayTitle;
        }
      }
      if (
        next.slot &&
        Array.from(workspaceBindings.values()).some(
          (existing) =>
            existing.bindingKey !== next.bindingKey &&
            existing.slot === next.slot &&
            !targetMatches(existing.target, next.target),
        )
      )
        return undefined;
      for (const existing of workspaceBindings.values()) {
        if (
          existing.workspaceKey === next.workspaceKey &&
          existing.cwd !== next.cwd
        ) {
          return undefined;
        }
      }
      const previous = workspaceBindings.get(nextMapKey);
      if (previous?.showSlotSuffix) next.showSlotSuffix = true;
      if (previous?.threadName && !next.threadName) {
        next.threadName = previous.threadName;
      }
      if (previous?.manualThreadName && !next.manualThreadName) {
        next.manualThreadName = previous.manualThreadName;
      }
      if (previous || replacedTargetBinding) {
        const journalBindingKeys = Array.from(
          new Set([
            ...(previous?.journalBindingKeys ?? []),
            ...(replacedTargetBinding?.journalBindingKeys ?? []),
            ...(next.journalBindingKeys ?? []),
          ]),
        );
        const retainedComplete =
          (!previous || previous.journalBindingsComplete === true) &&
          (!replacedTargetBinding || replacedTargetBinding.journalBindingsComplete === true);
        if (journalBindingKeys.length || retainedComplete)
          next.journalBindingKeys = journalBindingKeys;
        else delete next.journalBindingKeys;
        if (retainedComplete) next.journalBindingsComplete = true;
        else delete next.journalBindingsComplete;
      }
      if (previous && !targetMatches(previous.target, next.target)) {
        delete next.displayTitle;
        delete next.inactiveSinceMs;
      } else if (previous) {
        if (previous.displayTitle) next.displayTitle = previous.displayTitle;
        if (previous.inactiveSinceMs !== undefined)
          next.inactiveSinceMs = previous.inactiveSinceMs;
      }
      if (claimInstanceId) {
        if (claim?.instanceId !== claimInstanceId) return undefined;
        if (next.slot !== undefined && claim.identity.slot !== next.slot)
          return undefined;
        next.slot = claim.identity.slot;
      } else if (claim) {
        return undefined;
      }
      for (const [key, existing] of workspaceBindings) {
        if (key === nextMapKey) continue;
        if (targetMatches(existing.target, next.target)) {
          workspaceBindings.delete(key);
        }
      }
      workspaceBindings.set(nextMapKey, next);
      reconcileWorkspaceSuffixExposure();
      if (claim) workspaceClaims.delete(nextMapKey);
      markDirty();
      return cloneWorkspaceBinding(next);
    },
    upsert(record) {
      const next = cloneRecord(record);
      const nextOwnerKey = getRecordOwnerKey(next);
      const previousRecord = records.get(nextOwnerKey);
      if (ThreadReconciler.isCurrentThreadRecord(next)) {
        for (const existing of Array.from(records.values())) {
          const existingOwnerKey = getRecordOwnerKey(existing);
          if (existingOwnerKey === nextOwnerKey) continue;
          if (!targetMatches(existing.target, next.target)) continue;
          records.delete(existingOwnerKey);
        }
      }
      if (
        next.instanceId &&
        (next.status === "active" || next.status === "starting")
      ) {
        for (const existing of records.values()) {
          if (existing.instanceId !== next.instanceId) continue;
          if (getRecordOwnerKey(existing) === nextOwnerKey) continue;
          if (targetMatches(existing.target, next.target)) continue;
          if (existing.status !== "active" && existing.status !== "starting")
            continue;
          records.delete(getRecordOwnerKey(existing));
        }
      }
      if (!isPersistedThreadRecord(next)) {
        rememberIdentity(next);
        records.delete(nextOwnerKey);
        markDirty();
        return cloneRecord(next);
      }
      records.set(nextOwnerKey, next);
      if (
        !previousRecord ||
        !targetMatches(previousRecord.target, next.target)
      ) {
        rememberSlot(next.slot, next.updatedAtMs);
      }
      rememberIdentity(next);
      markDirty();
      return cloneRecord(next);
    },
    markOfflineByInstanceId(instanceId) {
      let count = 0;
      for (const record of Array.from(records.values())) {
        if (
          record.instanceId !== instanceId ||
          (record.status !== "active" && record.status !== "starting")
        )
          continue;
        records.delete(getRecordOwnerKey(record));
        count += 1;
      }
      if (count > 0) markDirty();
      return count;
    },
    markStaleByTarget(target, syncStatus = "unknown", lastSyncError) {
      const record = Array.from(records.values()).find((entry) =>
        targetMatches(entry.target, target),
      );
      const pending =
        syncStatus === "deleted"
          ? pendingProvisions.find(
              (entry) => entry.target && targetMatches(entry.target, target),
            )
          : undefined;
      const source = record ?? pending;
      // Confirmed absence ends this binding's active target lifetime, even after
      // an earlier stale observation already removed its live record.
      const inactive =
        syncStatus === "deleted" &&
        markWorkspaceBindingInactiveByTarget(target);
      if (!source?.target) return inactive;
      syncObservations = syncObservations.filter(
        (entry) => !targetMatches(entry.target, target),
      );
      syncObservations.push({
        target: { ...source.target },
        syncStatus,
        observedAtMs: getNowMs(),
        ...(source.instanceId ? { instanceId: source.instanceId } : {}),
        ...(source.slot ? { slot: source.slot } : {}),
        ...(lastSyncError ? { lastSyncError } : {}),
        lastReconcileAction: "mark-stale",
      });
      if (record) {
        rememberIdentity(record);
        records.delete(getRecordOwnerKey(record));
      }
      if (syncStatus === "deleted") {
        pendingProvisions = pendingProvisions.filter(
          (entry) => !entry.target || !targetMatches(entry.target, target),
        );
      }
      markDirty();
      return true;
    },
    markActiveByTarget(target) {
      const nowMs = getNowMs();
      for (const record of records.values()) {
        if (!targetMatches(record.target, target)) continue;
        record.status = "active";
        record.updatedAtMs = nowMs;
        record.syncStatus = "open";
        record.lastSyncObservedAtMs = nowMs;
        record.lastReconcileAction = "mark-active";
        delete record.lastError;
        delete record.lastSyncError;
        markDirty();
        return true;
      }
      return false;
    },
    renameByTarget(target, threadName, options) {
      if (hasWorkspaceRetirementConflict({ target })) return undefined;
      const nowMs = getNowMs();
      const normalizedThreadName =
        normalizeBaleTopicTargetThreadName(threadName);
      if (!normalizedThreadName) return undefined;
      for (const record of records.values()) {
        if (!targetMatches(record.target, target)) continue;
        record.manualThreadName = normalizedThreadName;
        record.updatedAtMs = nowMs;
        for (const binding of workspaceBindings.values()) {
          if (!targetMatches(binding.target, target)) continue;
          const previousTitle =
            binding.displayTitle ??
            binding.manualThreadName ??
            binding.threadName;
          binding.manualThreadName = normalizedThreadName;
          binding.displayTitle =
            options?.updateDisplayTitle === false
              ? previousTitle
              : normalizedThreadName;
          binding.updatedAtMs = nowMs;
        }
        markDirty();
        return cloneRecord(record);
      }
      return undefined;
    },
    async renameByTargetAndPersist(target, threadName, options, isCurrent) {
      const name = normalizeBaleTopicTargetThreadName(threadName);
      const path = getPath(),
        profile = activeProfile();
      const capturedTarget = { ...target };
      const current = () =>
        scopeMatches(path, profile) &&
        isCurrent() &&
        !hasWorkspaceRetirementConflict({ target: capturedTarget });
      if (!name || !current()) return undefined;
      const owners = Array.from(records.values()).filter((record) =>
        targetMatches(record.target, capturedTarget),
      );
      if (owners.length !== 1) return undefined;
      const candidate = {
        kind: "manual-name" as const,
        target: capturedTarget,
        owner: cloneRecord(owners[0]!),
        bindings: Array.from(workspaceBindings.values())
          .filter((binding) => targetMatches(binding.target, capturedTarget))
          .map(cloneWorkspaceBinding),
        threadName: name,
        updateDisplayTitle: options.updateDisplayTitle,
        isCurrent: current,
      };
      const published = await persistSnapshot(candidate);
      const renamed = records.get(getRecordOwnerKey(candidate.owner));
      if (
        !published ||
        !current() ||
        !renamed ||
        renamed.manualThreadName !== name
      )
        throw new Error(
          "Bale Workspace manual-name publication lost its exact frame or authority.",
        );
      return cloneRecord(renamed);
    },
    async clearManualNameByTargetAndPersist(target, automaticTitle, isCurrent) {
      const title = normalizeBaleTopicTargetThreadName(automaticTitle);
      const path = getPath(),
        profile = activeProfile(),
        capturedTarget = { ...target };
      const current = () =>
        scopeMatches(path, profile) &&
        isCurrent() &&
        !hasWorkspaceRetirementConflict({ target: capturedTarget });
      if (!title || !current()) return undefined;
      const owners = Array.from(records.values()).filter((record) =>
        targetMatches(record.target, capturedTarget),
      );
      const bindings = Array.from(workspaceBindings.values()).filter(
        (binding) => targetMatches(binding.target, capturedTarget),
      );
      if (owners.length !== 1 || bindings.length !== 1) return undefined;
      const candidate = {
        kind: "manual-name" as const,
        target: capturedTarget,
        owner: cloneRecord(owners[0]!),
        bindings: bindings.map(cloneWorkspaceBinding),
        automaticTitle: title,
        isCurrent: current,
      };
      const published = await persistSnapshot(candidate);
      const reset = records.get(getRecordOwnerKey(candidate.owner));
      const binding = workspaceBindings.get(
        getWorkspaceBindingMapKey(candidate.bindings[0]!),
      );
      if (
        !published ||
        !current() ||
        !reset ||
        reset.manualThreadName !== undefined ||
        !binding ||
        binding.manualThreadName !== undefined ||
        binding.displayTitle !== title
      )
        throw new Error(
          "Bale Workspace manual-name reset publication lost its exact frame or authority.",
        );
      return cloneRecord(reset);
    },
    clearManualNameByTarget(target, automaticTitle) {
      if (hasWorkspaceRetirementConflict({ target })) return undefined;
      const title = normalizeBaleTopicTargetThreadName(automaticTitle);
      if (!title) return undefined;
      const nowMs = getNowMs();
      for (const record of records.values()) {
        if (!targetMatches(record.target, target)) continue;
        delete record.manualThreadName;
        record.updatedAtMs = nowMs;
        for (const binding of workspaceBindings.values()) {
          if (!targetMatches(binding.target, target)) continue;
          delete binding.manualThreadName;
          binding.displayTitle = title;
          binding.updatedAtMs = nowMs;
        }
        markDirty();
        return cloneRecord(record);
      }
      return undefined;
    },
    claimReusableTarget(instanceId, threadName) {
      const nowMs = getNowMs();
      const candidates = Array.from(records.values())
        .filter((record) => {
          if (record.instanceId) return false;
          if (!record.slot || !/^[A-Z]$/u.test(record.slot)) return false;
          if (record.slot === "A") return false;
          if (record.status !== "pending") return false;
          return !Array.from(records.values()).some(
            (other) =>
              other !== record &&
              other.slot === record.slot &&
              (other.status === "active" || other.status === "starting"),
          );
        })
        .sort((left, right) => {
          const leftSlot = left.slot ?? "Z";
          const rightSlot = right.slot ?? "Z";
          if (leftSlot !== rightSlot) return leftSlot.localeCompare(rightSlot);
          return left.createdAtMs - right.createdAtMs;
        });
      const record = candidates[0];
      if (!record) return undefined;
      record.status = "active";
      record.instanceId = instanceId;
      record.updatedAtMs = nowMs;
      if (
        !record.threadName &&
        threadName &&
        isBaleTopicThreadNameValidForSlot(threadName, record.slot)
      )
        record.threadName = threadName;
      delete record.lastError;
      rememberIdentity(record);
      markDirty();
      return cloneRecord(record);
    },
    allocateSlot(profileKey, preferredSlot, workspaceBindingKey, options) {
      if (workspaceRetirementCommitInFlight) return undefined;
      const externalReservedSlots = captureExternalReservedSlots();
      if (!externalReservedSlots) return undefined;
      const isExternalSlotOccupied = (slot: string): boolean =>
        externalReservedSlots.includes(slot);
      const ownerKey = getBaleThreadOwnerKey(
        getBaleThreadOwnerFromProfileKey(profileKey),
      );
      const existing = records.get(ownerKey) ?? records.get(profileKey);
      const nowMs = getNowMs();
      const isWorkspaceSlotOccupied = (slot: string): boolean =>
        Array.from(workspaceBindings.values()).some(
          (binding) =>
            binding.bindingKey !== workspaceBindingKey && binding.slot === slot,
        );
      const isWorkspaceClaimSlotOccupied = (slot: string): boolean =>
        Array.from(workspaceClaims.values()).some(
          (claim) =>
            claim.identity.bindingKey !== workspaceBindingKey &&
            claim.identity.slot === slot,
        );
      if (
        existing?.slot &&
        ThreadReconciler.isCurrentThreadRecord(existing) &&
        !options?.excludeCurrentRecord
      ) {
        const bindingConflict = Array.from(workspaceBindings.values()).some(
          (binding) =>
            binding.bindingKey !== workspaceBindingKey &&
            binding.slot === existing.slot &&
            !targetMatches(binding.target, existing.target),
        );
        const claimConflict = Array.from(workspaceClaims.values()).some(
          (claim) =>
            claim.identity.bindingKey !== workspaceBindingKey &&
            claim.identity.slot === existing.slot &&
            claim.instanceId !== existing.instanceId,
        );
        return bindingConflict ||
          claimConflict ||
          isExternalSlotOccupied(existing.slot)
          ? undefined
          : existing.slot;
      }
      if (workspaceBindingKey) {
        const claim = Array.from(workspaceClaims.values()).find(
          (claim) => claim.identity.bindingKey === workspaceBindingKey,
        );
        const slot = claim?.identity.slot;
        if (!slot) return undefined;
        const foreignClaim = Array.from(workspaceClaims.values()).some(
          (other) => other !== claim && other.identity.slot === slot,
        );
        const foreignBinding = Array.from(workspaceBindings.values()).some(
          (binding) =>
            binding.bindingKey !== workspaceBindingKey && binding.slot === slot,
        );
        if (
          foreignClaim ||
          foreignBinding ||
          isExternalSlotOccupied(slot) ||
          isBaleTopicTargetSlotOccupied(
            slot,
            records,
            reservations,
            pendingProvisions,
            nowMs,
          )
        )
          return undefined;
        return slot;
      }
      if (
        preferredSlot &&
        !isExternalSlotOccupied(preferredSlot) &&
        !isWorkspaceSlotOccupied(preferredSlot) &&
        !isWorkspaceClaimSlotOccupied(preferredSlot) &&
        !isBaleTopicTargetSlotOccupied(
          preferredSlot,
          records,
          reservations,
          pendingProvisions,
          nowMs,
        )
      ) {
        return preferredSlot;
      }
      const next = getNextMonotonicSlot(
        records,
        reservations,
        pendingProvisions,
        nowMs,
        botState.lastSlot,
      );
      if (
        next &&
        !isExternalSlotOccupied(next) &&
        !isWorkspaceSlotOccupied(next) &&
        !isWorkspaceClaimSlotOccupied(next)
      )
        return next;
      return Array.from(BALE_WORKSPACE_SLOTS, (slot) =>
        slot.toUpperCase(),
      ).find(
        (slot) =>
          !isExternalSlotOccupied(slot) &&
          !isWorkspaceSlotOccupied(slot) &&
          !isWorkspaceClaimSlotOccupied(slot) &&
          !isBaleTopicTargetSlotOccupied(
            slot,
            records,
            reservations,
            pendingProvisions,
            nowMs,
          ),
      );
    },
  };
}

function isBaleTopicTargetSlotOccupied(
  slot: string,
  records: Map<string, BaleTopicTargetRecord>,
  reservations: readonly BaleThreadReservation[] = [],
  pendingProvisions: readonly BaleThreadPendingProvision[] = [],
  nowMs = Date.now(),
): boolean {
  for (const record of records.values()) {
    if (record.slot === slot && ThreadReconciler.isCurrentThreadRecord(record))
      return true;
  }
  for (const reservation of reservations) {
    if (
      reservation.expiresAtMs !== undefined &&
      reservation.expiresAtMs <= nowMs
    )
      continue;
    if (reservation.slot === slot) return true;
  }
  for (const provision of pendingProvisions) {
    if (
      provision.status !== "ambiguous" &&
      provision.expiresAtMs !== undefined &&
      provision.expiresAtMs <= nowMs
    )
      continue;
    if (provision.slot === slot) return true;
  }
  return false;
}

function listOccupiedBaleThreadIdentities(input: {
  records: readonly BaleTopicTargetRecord[];
  workspaceBindings?: readonly BaleWorkspaceThreadBinding[];
  pendingProvisions?: readonly BaleThreadPendingProvision[];
  exceptTarget?: BaleTarget;
  exceptWorkspaceBindingKey?: string;
}): string[] {
  const occupied = new Set<string>();
  const add = (threadName: string | undefined): void => {
    if (!threadName) return;
    occupied.add(getBaleTopicIdentityName(threadName));
  };
  for (const record of input.records) {
    if (!ThreadReconciler.isCurrentThreadRecord(record)) continue;
    if (input.exceptTarget && targetMatches(record.target, input.exceptTarget))
      continue;
    add(record.manualThreadName);
    add(record.threadName);
  }
  for (const binding of input.workspaceBindings ?? []) {
    if (binding.bindingKey === input.exceptWorkspaceBindingKey) continue;
    if (input.exceptTarget && targetMatches(binding.target, input.exceptTarget))
      continue;
    add(binding.manualThreadName);
    add(binding.threadName);
  }
  for (const pending of input.pendingProvisions ?? []) {
    if (
      input.exceptTarget &&
      pending.target &&
      targetMatches(pending.target, input.exceptTarget)
    ) {
      continue;
    }
    add(pending.threadName);
  }
  return Array.from(occupied);
}

function getNextBaleThreadNamePaletteSlot(
  records: readonly BaleTopicTargetRecord[],
  fallbackSlot: string | undefined,
): string | undefined {
  let maxCode = "A".charCodeAt(0) - 1;
  for (const record of records) {
    if (!ThreadReconciler.isCurrentThreadRecord(record) || !record.threadName)
      continue;
    const identity = getBaleTopicIdentityName(record.threadName);
    const first = identity[0];
    if (!first || !/^[A-Z]$/.test(first)) continue;
    maxCode = Math.max(maxCode, first.charCodeAt(0));
  }
  if (maxCode < "A".charCodeAt(0)) return fallbackSlot;
  let code = maxCode + 1;
  if (code > "Z".charCodeAt(0)) code = "A".charCodeAt(0);
  return String.fromCharCode(code);
}

/** Pure stored Thread target: a numeric chat and integer Thread id; any other shape is absent. */
function parseStoredThreadTarget(
  value: unknown,
): (BaleTarget & { threadId: number }) | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  const { chatId, threadId } = value as Record<string, unknown>;
  return typeof chatId === "number" &&
    typeof threadId === "number" &&
    Number.isInteger(threadId)
    ? { chatId, threadId }
    : undefined;
}

export interface BalePromoteFollowerBindingToLeaderDeps {
  store: BaleTopicTargetStore;
  instanceId: string;
  cwd?: string;
  sessionId?: string;
  baleProfile?: string;
  target?: BaleTarget;
  slot?: string;
  threadName?: string;
  nowMs?: number;
}

export async function promoteBaleFollowerBindingToLeader(
  deps: BalePromoteFollowerBindingToLeaderDeps,
): Promise<BaleTopicTargetRecord | undefined> {
  const target = deps.target;
  if (typeof target?.threadId !== "number") return undefined;
  await deps.store.load();
  const nowMs = deps.nowMs ?? Date.now();
  const existing = deps.store
    .list()
    .find(
      (record) =>
        record.target.chatId === target.chatId &&
        record.target.threadId === target.threadId,
    );
  const workspaceIdentity = deps.cwd
    ? deps.store.claimWorkspaceIdentity(
        deps.cwd,
        deps.instanceId,
        existing?.instanceId,
        {
          existingBindingOnly: true,
          sessionId: deps.sessionId,
        },
      )
    : undefined;
  const workspaceBinding = workspaceIdentity
    ? deps.store.getWorkspaceBinding(
        workspaceIdentity.cwd,
        workspaceIdentity.instanceSlot,
        workspaceIdentity.sessionId,
      )
    : undefined;
  const exactWorkspaceBinding =
    workspaceBinding && targetMatches(workspaceBinding.target, target)
      ? workspaceBinding
      : undefined;
  const slot = existing
    ? deps.store.allocateSlot(existing.profileKey)
    : exactWorkspaceBinding
      ? workspaceIdentity?.slot
      : undefined;
  if (!slot || (deps.slot && deps.slot !== slot)) {
    deps.store.releaseWorkspaceClaim(deps.instanceId);
    return undefined;
  }
  if (exactWorkspaceBinding && exactWorkspaceBinding.slot !== slot) {
    const committed = deps.store.upsertWorkspaceBinding(
      {
        ...exactWorkspaceBinding,
        slot,
        updatedAtMs: nowMs,
      },
      deps.instanceId,
    );
    if (!committed) {
      deps.store.releaseWorkspaceClaim(deps.instanceId);
      return undefined;
    }
    await deps.store.persist();
  }
  const owner: BaleThreadOwner = {
    kind: "leader",
    cwd: deps.cwd,
    instanceId: deps.instanceId,
    ...(deps.baleProfile ? { baleProfile: deps.baleProfile } : {}),
  };
  const record = deps.store.upsert({
    profileKey: getBaleThreadOwnerKey(owner),
    owner,
    target: { chatId: target.chatId, threadId: target.threadId },
    status: "active",
    createdAtMs: existing?.createdAtMs ?? nowMs,
    updatedAtMs: nowMs,
    ...((existing?.threadName ?? deps.threadName)
      ? { threadName: existing?.threadName ?? deps.threadName }
      : {}),
    instanceId: deps.instanceId,
    slot,
    ...(existing?.syncStatus ? { syncStatus: existing.syncStatus } : {}),
    ...(existing?.lastSyncObservedAtMs !== undefined
      ? { lastSyncObservedAtMs: existing.lastSyncObservedAtMs }
      : {}),
    lastReconcileAction: "follower-promoted-to-leader",
    ...(existing?.rerouteConfirmedAtMs !== undefined
      ? { rerouteConfirmedAtMs: existing.rerouteConfirmedAtMs }
      : {}),
  });
  await deps.store.persist();
  deps.store.releaseWorkspaceClaim(deps.instanceId);
  return record;
}

export interface BaleOwnTopicProvisionDeps {
  getAllowedUserId: () => number | undefined;
  instanceId: string;
  cwd?: string;
  baleProfile?: string;
  requestedThreadName?: string;
  preferredSlot?: string;
  workspaceBindingKey?: string;
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
  store: BaleTopicTargetStore;
  callApi: <TResponse>(
    method: string,
    body: Record<string, unknown>,
  ) => Promise<TResponse>;
  recordEvent: (
    category: string,
    message: string,
    details?: Record<string, unknown>,
  ) => void;
}

export interface BaleOwnTopicProvisionResult {
  target: BaleTarget & { threadId: number };
  slot: string;
  threadName?: string;
  displayTitle?: string;
  reused: boolean;
}

/**
 * Provision a topic for the bus leader's own use (slot A).
 * This is a thread-binding primitive; sync policy decides when startup/connect
 * should call it to ensure the leader has a visible working thread.
 */
export async function provisionOwnBusTopic(
  deps: BaleOwnTopicProvisionDeps,
): Promise<BaleOwnTopicProvisionResult | undefined> {
  const chatId = deps.getAllowedUserId();
  let profileKey = getBaleThreadOwnerKey({
    kind: "leader",
    cwd: deps.cwd,
    instanceId: deps.instanceId,
    baleProfile: deps.baleProfile,
  });
  if (typeof chatId !== "number") return undefined;
  await deps.store.load();
  const reservationCleanupPorts = {
    isCleanupTargetProtected: createBaleCleanupTargetProtection(deps.store),
    callApi: deps.callApi,
    markStaleByTarget: (
      target: BaleTarget & { threadId: number },
      syncStatus?: "closed" | "deleted",
      lastSyncError?: string,
    ) => deps.store.markStaleByTarget(target, syncStatus, lastSyncError),
    removePendingProvisionById: (id: string) =>
      deps.store.removePendingProvision(id),
    persist: () => deps.store.persist(),
    getCurrentLeaderEpoch: deps.getCurrentLeaderEpoch,
    recordRuntimeEvent(
      category: string,
      error: unknown,
      details?: Record<string, unknown>,
    ) {
      deps.recordEvent(
        category,
        error instanceof Error ? error.message : String(error),
        details,
      );
    },
  };
  const reservationCleanupNowMs = Date.now();
  const reservationsBeforeCleanup = deps.store.listReservations();
  const reservationCleanupPlan = ThreadReconciler.planThreadReconciliation({
    nowMs: reservationCleanupNowMs,
    currentLeaderEpoch: deps.getCurrentLeaderEpoch?.(),
    previousState: deps.getThreadReconciliationMachineState?.(),
    records: deps.store.list(),
    reservations: reservationsBeforeCleanup,
    pendingProvisions: deps.store.listPendingProvisions(),
    proactiveReservationCleanup: true,
  });
  deps.recordThreadReconciliationPlan?.(reservationCleanupPlan);
  const reservationCleanupApplyStartedAtMs = Date.now();
  await ThreadReconciler.applyThreadReconciliationPlan(
    reservationCleanupPlan,
    reservationCleanupPorts,
  );
  deps.recordEvent("bus", "Bus leader reservation cleanup reconciled", {
    phase: "leader-topic-reservation-cleanup-duration",
    durationMs: Date.now() - reservationCleanupApplyStartedAtMs,
    actions: reservationCleanupPlan.actions.length,
  });
  const nowMs = Date.now();
  const currentLeaderOwner: BaleThreadOwner = {
    kind: "leader",
    cwd: deps.cwd,
    instanceId: deps.instanceId,
    ...(deps.baleProfile ? { baleProfile: deps.baleProfile } : {}),
  };
  const leaderSessionHandoff = getBaleLeaderSessionHandoff();
  if (
    isBaleLeaderSessionHandoffFresh(leaderSessionHandoff) &&
    leaderSessionHandoff.profileKey === profileKey
  ) {
    const existingHandoffRecord = deps.store
      .list()
      .find((record) =>
        targetMatches(record.target, leaderSessionHandoff.target),
      );
    deps.store.upsert({
      profileKey,
      owner: currentLeaderOwner,
      target: { ...leaderSessionHandoff.target },
      status: "active",
      createdAtMs:
        existingHandoffRecord?.createdAtMs ?? leaderSessionHandoff.createdAtMs,
      updatedAtMs: nowMs,
      threadName:
        existingHandoffRecord?.threadName ?? leaderSessionHandoff.threadName,
      instanceId: deps.instanceId,
      slot: existingHandoffRecord?.slot ?? leaderSessionHandoff.slot,
      ...(existingHandoffRecord?.syncStatus
        ? { syncStatus: existingHandoffRecord.syncStatus }
        : {}),
      ...(existingHandoffRecord?.lastSyncObservedAtMs !== undefined
        ? {
            lastSyncObservedAtMs: existingHandoffRecord.lastSyncObservedAtMs,
          }
        : {}),
      lastReconcileAction: "leader-session-handoff-restored",
    });
    await deps.store.persist();
    setBaleLeaderSessionHandoff(undefined);
    deps.recordEvent("bus", "Bus leader session handoff restored", {
      phase: "leader-session-handoff-restore",
      chatId: leaderSessionHandoff.target.chatId,
      threadId: leaderSessionHandoff.target.threadId,
      slot: existingHandoffRecord?.slot ?? leaderSessionHandoff.slot,
      threadName:
        existingHandoffRecord?.threadName ?? leaderSessionHandoff.threadName,
      previousInstanceId: leaderSessionHandoff.instanceId,
      instanceId: deps.instanceId,
    });
  } else if (leaderSessionHandoff) {
    setBaleLeaderSessionHandoff(undefined);
  }
  const recordsBeforePreviousLeaderCleanup = deps.store.list();
  const previousLeaderCleanupPlan = ThreadReconciler.planThreadReconciliation({
    nowMs,
    currentLeaderEpoch: deps.getCurrentLeaderEpoch?.(),
    previousState: deps.getThreadReconciliationMachineState?.(),
    records: recordsBeforePreviousLeaderCleanup.map((record) => ({
      ...record,
      ownerKind: record.owner?.kind,
    })),
    pendingProvisions: deps.store.listPendingProvisions(),
    previousLeaderCleanup: { currentInstanceId: deps.instanceId },
  });
  deps.recordThreadReconciliationPlan?.(previousLeaderCleanupPlan);
  for (const action of previousLeaderCleanupPlan.actions) {
    if (action.kind !== "close-delete-previous-leader-topic") continue;
    const record = recordsBeforePreviousLeaderCleanup.find((candidate) =>
      targetMatches(candidate.target, action.target),
    );
    if (!record) continue;
    const isSameProfile = record.profileKey === profileKey;
    if (isSameProfile) {
      deps.recordEvent("bus", "Bus leader same-profile topic preserved", {
        phase: "leader-topic-same-profile-preserve",
        chatId: record.target.chatId,
        threadId: record.target.threadId,
        slot: record.slot,
        previousInstanceId: record.instanceId,
        instanceId: deps.instanceId,
        profileKey,
      });
      continue;
    }
    if (isSameBaleProcessInstance(record.instanceId, deps.instanceId)) {
      deps.store.upsert({
        ...record,
        profileKey,
        owner: currentLeaderOwner,
        status: "active",
        instanceId: deps.instanceId,
        updatedAtMs: nowMs,
        lastError: undefined,
        lastReconcileAction: "leader-topic-same-process-preserve",
      });
      deps.recordEvent("bus", "Bus leader same-process topic preserved", {
        phase: "leader-topic-same-process-preserve",
        chatId: record.target.chatId,
        threadId: record.target.threadId,
        slot: record.slot,
        previousInstanceId: record.instanceId,
        instanceId: deps.instanceId,
        profileKey,
      });
      continue;
    }
    const previousLeaderCleanupStartedAtMs = Date.now();
    const isCleanupTargetProtected = createBaleCleanupTargetProtection(
      deps.store,
      record,
    );
    const cleanup = await ThreadReconciler.applyThreadReconciliationPlan(
      { actions: [action] },
      {
        isCleanupTargetProtected,
        callApi: deps.callApi,
        markStaleByTarget: (target, syncStatus, lastSyncError) =>
          deps.store.markStaleByTarget(target, syncStatus, lastSyncError),
        persist: () => deps.store.persist(),
        removePendingProvisionById: (id) =>
          deps.store.removePendingProvision(id),
        getCurrentLeaderEpoch: deps.getCurrentLeaderEpoch,
        recordRuntimeEvent(category, error, details) {
          deps.recordEvent(
            category,
            error instanceof Error ? error.message : String(error),
            details,
          );
        },
      },
    );
    deps.recordEvent("bus", "Bus leader previous-topic cleanup applied", {
      phase: "leader-topic-previous-cleanup-duration",
      durationMs: Date.now() - previousLeaderCleanupStartedAtMs,
      chatId: record.target.chatId,
      threadId: record.target.threadId,
      slot: record.slot,
    });
    if (
      deps.getCurrentLeaderEpoch &&
      (action.leaderEpoch === undefined ||
        deps.getCurrentLeaderEpoch() !== action.leaderEpoch)
    ) {
      deps.recordEvent(
        "bus",
        "Skipped previous-topic local cleanup after leader epoch loss",
        {
          phase: "leader-topic-previous-cleanup-stale-epoch-skip",
          actionLeaderEpoch: action.leaderEpoch,
          currentLeaderEpoch: deps.getCurrentLeaderEpoch(),
          chatId: record.target.chatId,
          threadId: record.target.threadId,
        },
      );
      throw new Error(
        "Bale leader ownership changed during topic reconciliation.",
      );
    }
    if (cleanup.incompleteActions?.length) {
      throw new Error(
        "Previous Bale leader topic deletion was not confirmed.",
      );
    }
    if (isCleanupTargetProtected(action.target, action)) continue;
    deps.store.markStaleByTarget(record.target);
    if (record.slot) {
      deps.store.reserveThread({
        target: record.target,
        slot: record.slot,
        reason: "previous-process-cleaned-without-visible-probe",
        createdAtMs: nowMs,
        updatedAtMs: nowMs,
        expiresAtMs: nowMs + BALE_THREAD_RESERVATION_TTL_MS,
        instanceId: record.instanceId,
        lastReconcileAction: "leader-topic-previous-instance-cleaned-no-probe",
      });
    }
    deps.store.setBotState({
      threadMode: "enabled",
      updatedAtMs: nowMs,
      lastReconcileAction: "leader-topic-next-slot-after-unprobed-previous",
    });
    deps.recordEvent(
      "bus",
      "Bus leader previous-process topic reserved after cleanup without visible probe",
      {
        phase: "leader-topic-previous-instance-reserve-no-probe",
        chatId: record.target.chatId,
        threadId: record.target.threadId,
        slot: record.slot,
        previousInstanceId: record.instanceId,
        instanceId: deps.instanceId,
      },
    );
  }
  const provision = createBaleTopicTargetProvisioner({
    topicChatId: chatId,
    store: deps.store,
    callApi: deps.callApi,
    getNowMs: deps.getNowMs,
    getCurrentLeaderEpoch: deps.getCurrentLeaderEpoch,
    getRandom: deps.getRandom,
    resolveInitialWorkspaceDisplayTitle:
      deps.resolveInitialWorkspaceDisplayTitle,
    claimPendingTargets: false,
  });
  let result = await provision({
    instanceId: deps.instanceId,
    owner: currentLeaderOwner,
    profileKey,
    ...(deps.requestedThreadName
      ? { threadName: deps.requestedThreadName }
      : {}),
    ...(deps.preferredSlot ? { preferredSlot: deps.preferredSlot } : {}),
    ...(deps.workspaceBindingKey
      ? {
          workspaceBindingKey: deps.workspaceBindingKey,
          ...(deps.cwd ? { workspaceCwd: deps.cwd } : {}),
        }
      : {}),
  });
  if (result.reused) {
    // Reused topics may already have a human-chosen Bale title. Do not edit
    // them during leader startup: startup reconciliation must not reset a named
    // topic back to its bare slot or create redundant "renamed the thread" service
    // messages. Also do not probe with Bot API chat actions: every chat action is
    // user-visible as native typing/activity, so reload would falsely signal that
    // the agent is working. Treat the reused binding as optimistically open;
    // ordinary target-scoped sends still detect stale topics and trigger the
    // stale-api-error reconciliation path when real delivery happens.
    const nowMs = Date.now();
    deps.store.upsert({
      ...result.record,
      syncStatus: "open",
      lastSyncObservedAtMs: nowMs,
      lastReconcileAction: "leader-startup-skip-probe",
    });
  }
  deps.store.setBotState({
    threadMode: "enabled",
    updatedAtMs: Date.now(),
    lastReconcileAction: result.reused
      ? "leader-startup-skip-probe"
      : "leader-topic-created",
  });
  await deps.store.persist();
  deps.recordEvent("bus", "Bus leader own topic assigned", {
    phase: "leader-topic",
    chatId: result.target.chatId,
    threadId: result.target.threadId,
    slot: result.record.slot,
    threadName: result.record.threadName,
    reused: result.reused,
  });
  if (!result.record.slot) {
    throw new Error("Bale Thread slot authority is unavailable.");
  }
  return {
    target: result.target,
    slot: result.record.slot,
    ...(result.record.threadName
      ? { threadName: result.record.threadName }
      : {}),
    ...(result.displayTitle ? { displayTitle: result.displayTitle } : {}),
    reused: result.reused,
  };
}

export interface BaleInstanceThreadIdentityCandidate {
  target?: BaleTarget;
  slot?: string;
  threadName?: string;
}

export function resolveBaleInstanceThreadIdentity(options: {
  target?: BaleTarget;
  follower?: BaleInstanceThreadIdentityCandidate;
  leader?: BaleInstanceThreadIdentityCandidate;
  record?: BaleTopicTargetRecord;
}): BaleInstanceThreadIdentityCandidate {
  const targetMatchesCandidate = (
    candidate: BaleInstanceThreadIdentityCandidate | undefined,
  ) => {
    if (!candidate) return false;
    if (!options.target) return true;
    return (
      !!candidate.target && targetMatches(candidate.target, options.target)
    );
  };
  const local = targetMatchesCandidate(options.follower)
    ? options.follower
    : targetMatchesCandidate(options.leader)
      ? options.leader
      : undefined;
  const record =
    options.record &&
    (!options.target || targetMatches(options.record.target, options.target))
      ? options.record
      : undefined;
  return {
    ...((local?.target ?? record?.target)
      ? { target: local?.target ?? record?.target }
      : {}),
    ...((local?.slot ?? record?.slot)
      ? { slot: local?.slot ?? record?.slot }
      : {}),
    ...((local?.threadName ?? record?.threadName)
      ? { threadName: local?.threadName ?? record?.threadName }
      : {}),
  };
}

export interface BaleWorkspaceThreadRenameAuthority {
  context: unknown;
  sessionId?: string;
  sessionGeneration: number;
  cwd?: string;
  profileName?: string;
  botToken?: string;
  operatorUserId?: number;
  leaderEpoch?: string | number;
  ownsDirectDelivery: boolean;
  followerRegistered: boolean;
  localTarget?: BaleTarget;
  localSlot?: string;
}

interface BaleWorkspaceThreadNameRecipientDeps {
  store: BaleTopicTargetStore;
  instanceId: string;
  target: BaleTarget;
  assertAuthority: () => void;
  getAuthority: () => BaleWorkspaceThreadRenameAuthority;
}

function captureBaleWorkspaceThreadNameRecipient(
  deps: BaleWorkspaceThreadNameRecipientDeps,
  operation: "rename" | "reset",
) {
  const {
    store,
    instanceId,
    assertAuthority: assertCaller,
    getAuthority,
  } = deps;
  const target = { ...deps.target };
  assertCaller();
  const capture = () => {
    const { context, ...identity } = getAuthority();
    return {
      context,
      identity: {
        ...identity,
        localTarget: identity.localTarget && { ...identity.localTarget },
      },
    };
  };
  const captured = capture(),
    authority = captured.identity;
  const record = findCurrentBaleInstanceThreadRecord({
    records: store.list(),
    instanceId,
  });
  const bindings = store
    .listWorkspaceBindings()
    .filter(
      (binding) =>
        binding.cwd === authority.cwd &&
        binding.sessionId === authority.sessionId &&
        targetMatches(binding.target, target),
    );
  const binding = bindings[0];
  if (
    !captured.context ||
    !authority.sessionId ||
    !authority.cwd ||
    !authority.botToken ||
    authority.operatorUserId !== target.chatId ||
    authority.leaderEpoch === undefined ||
    !authority.ownsDirectDelivery ||
    authority.followerRegistered ||
    bindings.length !== 1 ||
    !binding?.slot ||
    !record ||
    binding.slot !== record.slot ||
    authority.localSlot !== binding.slot ||
    !authority.localTarget ||
    !targetMatches(authority.localTarget, target)
  )
    throw new Error(
      `Bale Workspace Thread ${operation} recipient authority is unavailable.`,
    );
  const observation =
    operation === "reset"
      ? store.captureWorkspaceThreadResetObservation(binding, record)
      : undefined;
  const observeRename =
    operation === "rename"
      ? store.captureWorkspaceThreadRenameObservation(binding, record)
      : undefined;
  const observeIdentity = observation?.isCurrent ?? observeRename!,
    slot = binding.slot;
  const assertAuthority = () => {
    assertCaller();
    const current = capture();
    if (
      current.context !== captured.context ||
      !isDeepStrictEqual(current.identity, captured.identity) ||
      !observeIdentity()
    )
      throw new Error(
        `Bale Workspace Thread ${operation} lost recipient authority.`,
      );
    // Canonical/supplied observations may synchronously revoke the captured caller or Pi recipient.
    const after = capture();
    assertCaller();
    if (
      after.context !== captured.context ||
      !isDeepStrictEqual(after.identity, captured.identity)
    )
      throw new Error(
        `Bale Workspace Thread ${operation} lost recipient authority.`,
      );
  };
  assertAuthority();
  return {
    assertAuthority,
    target,
    slot,
    observeResult: observation?.isResultCurrent ?? observeRename!,
  };
}

/** Prepared recipient identity/result fences; callers retain Workspace admission and transport effects. */
export function createBaleWorkspaceThreadRenameRecipient(
  deps: BaleWorkspaceThreadNameRecipientDeps,
): {
  assertAuthority: () => void;
  assertResult: (result: BaleTopicTargetRecord) => void;
} {
  const { assertAuthority, target, slot, observeResult } =
    captureBaleWorkspaceThreadNameRecipient(deps, "rename");
  return {
    assertAuthority,
    assertResult(result) {
      assertAuthority();
      if (
        !result.manualThreadName ||
        result.slot !== slot ||
        !targetMatches(result.target, target) ||
        !observeResult(result.manualThreadName)
      )
        throw new Error(
          "Bale Workspace Thread rename result is no longer current.",
        );
      assertAuthority();
    },
  };
}

/** Exact automatic-title/absent-name result fences, separate from recipient identity and issued effects. */
export function createBaleWorkspaceThreadResetRecipient(
  deps: BaleWorkspaceThreadNameRecipientDeps,
): {
  assertAuthority: () => void;
  assertResult: (automaticTitle: string) => void;
} {
  const { assertAuthority, observeResult } =
    captureBaleWorkspaceThreadNameRecipient(deps, "reset");
  return {
    assertAuthority,
    assertResult(title) {
      assertAuthority();
      if (!observeResult(title))
        throw new Error(
          "Bale Workspace Thread reset result is no longer current.",
        );
      assertAuthority();
    },
  };
}

export interface BaleLeaderThreadStateRuntime {
  getTarget(): BaleTarget | undefined;
  getIdentity(): BaleInstanceThreadIdentityCandidate | undefined;
  set(
    input: BaleInstanceThreadIdentityCandidate & { target: BaleTarget },
  ): void;
  clear(): void;
}

export function createBaleLeaderThreadStateRuntime(): BaleLeaderThreadStateRuntime {
  let identity:
    | (BaleInstanceThreadIdentityCandidate & { target: BaleTarget })
    | undefined;
  return {
    getTarget: () => identity?.target,
    getIdentity: () => identity,
    set(input) {
      identity = { ...input, target: { ...input.target } };
    },
    clear() {
      identity = undefined;
    },
  };
}

export interface BaleCurrentInstanceThreadRuntime {
  findRecord(): BaleTopicTargetRecord | undefined;
  getRecord(): BaleTopicTargetRecord | undefined;
  getIdentity(target?: BaleTarget): BaleInstanceThreadIdentityCandidate;
  getRestorationIdentity(): BaleInstanceThreadIdentityCandidate;
}

export interface BaleCurrentInstanceThreadRuntimeDeps {
  instanceId: string;
  listRecords(): readonly BaleTopicTargetRecord[];
  getPreferredTarget(): BaleTarget | undefined;
  getFollower():
    | (BaleInstanceThreadIdentityCandidate & { registered: boolean })
    | undefined;
  getLeader(): BaleInstanceThreadIdentityCandidate | undefined;
}

export function createBaleCurrentInstanceThreadRuntime(
  deps: BaleCurrentInstanceThreadRuntimeDeps,
): BaleCurrentInstanceThreadRuntime {
  const findRecord = function (): BaleTopicTargetRecord | undefined {
    return findCurrentBaleInstanceThreadRecord({
      records: deps.listRecords(),
      instanceId: deps.instanceId,
      preferredTarget: deps.getPreferredTarget(),
    });
  };
  const getRecord = function (): BaleTopicTargetRecord | undefined {
    const record = findRecord();
    const follower = deps.getFollower();
    if (record?.owner?.kind === "manual-follower" && !follower?.registered) {
      return undefined;
    }
    return record;
  };
  return {
    findRecord,
    getRecord,
    getIdentity(target) {
      const follower = deps.getFollower();
      const record = target
        ? findCurrentBaleInstanceThreadRecord({
            records: deps.listRecords(),
            instanceId: deps.instanceId,
            preferredTarget: target,
          })
        : getRecord();
      return resolveBaleInstanceThreadIdentity({
        target,
        follower: follower?.registered ? follower : undefined,
        leader: deps.getLeader(),
        record,
      });
    },
    getRestorationIdentity() {
      const follower = deps.getFollower();
      return resolveBaleInstanceThreadIdentity({
        follower: follower?.registered ? follower : undefined,
        leader: deps.getLeader(),
        record: findRecord(),
      });
    },
  };
}

export function findCurrentBaleInstanceThreadRecord(options: {
  records: readonly BaleTopicTargetRecord[];
  instanceId: string;
  preferredTarget?: BaleTarget;
}): BaleTopicTargetRecord | undefined {
  const target = options.preferredTarget;
  if (typeof target?.threadId === "number") {
    const targetRecord = options.records.find((record) => {
      return (
        record.target.chatId === target.chatId &&
        record.target.threadId === target.threadId
      );
    });
    if (targetRecord) return targetRecord;
  }
  return options.records.find((record) => {
    return (
      record.instanceId === options.instanceId && record.status === "active"
    );
  });
}

export interface BaleThreadStatusProjectionRuntime {
  getBusRole(): "leader" | "follower" | undefined;
  getBusFollowers(): ReturnType<typeof listBaleThreadStatusFollowers>;
  getLocalBus(): {
    leaderSocketPath: string;
    leaderTransport: "socket" | "pipe";
    followerSocketPath: string;
    followerTransport: "socket" | "pipe";
    followerRegistered: boolean;
    followerTarget?: BaleTarget;
    followerSlot?: string;
    followerThreadName?: string;
    leaderProtocol?: {
      protocolVersion: number;
      runtimeBuild: string;
      capabilities: string[];
    };
  };
  getTopicTargets(): ReturnType<typeof listBaleThreadStatusTargets>;
  getThreadReservations(): ReturnType<
    typeof listBaleThreadStatusReservations
  >;
  getTopicSyncObservations(): ReturnType<
    typeof listBaleThreadStatusObservations
  >;
  getInstanceSlot(): string | undefined;
  getInstanceThreadName(): string | undefined;
}

export interface BaleThreadStatusProjectionRuntimeDeps {
  getThreadMode(): "unknown" | "enabled" | "disabled";
  isBusPollingStarted(): boolean;
  isFollowerRegistered(): boolean;
  listFollowers(): readonly BaleThreadStatusFollowerView[];
  listRecords(): readonly BaleTopicTargetRecord[];
  listReservations(): readonly BaleThreadReservation[];
  listSyncObservations(): readonly BaleTopicSyncObservation[];
  getLeaderSocketPath(): string;
  getFollowerSocketPath(): string;
  getTransportKind(path: string): "socket" | "pipe";
  getFollowerTarget(): BaleTarget | undefined;
  getFollowerSlot(): string | undefined;
  getFollowerThreadName(): string | undefined;
  getLeaderProtocol?():
    | {
        protocolVersion: number;
        runtimeBuild: string;
        capabilities: string[];
      }
    | undefined;
  getCurrentIdentity(): BaleInstanceThreadIdentityCandidate;
  getDisplayTitle?: (target: BaleTarget) => string | undefined;
}

export function createBaleThreadStatusProjectionRuntime(
  deps: BaleThreadStatusProjectionRuntimeDeps,
): BaleThreadStatusProjectionRuntime {
  return {
    getBusRole() {
      if (deps.getThreadMode() === "disabled") return undefined;
      if (deps.isBusPollingStarted()) return "leader";
      return deps.isFollowerRegistered() ? "follower" : undefined;
    },
    getBusFollowers() {
      return listBaleThreadStatusFollowers({
        followers: deps.listFollowers(),
        records: deps.listRecords(),
      }).map((follower) => ({
        ...follower,
        threadName:
          (follower.target
            ? deps.getDisplayTitle?.(follower.target)
            : undefined) ?? follower.threadName,
      }));
    },
    getLocalBus() {
      const leaderSocketPath = deps.getLeaderSocketPath();
      const followerSocketPath = deps.getFollowerSocketPath();
      const leaderProtocol = deps.getLeaderProtocol?.();
      const followerTarget = deps.getFollowerTarget();
      return {
        leaderSocketPath,
        leaderTransport: deps.getTransportKind(leaderSocketPath),
        followerSocketPath,
        followerTransport: deps.getTransportKind(followerSocketPath),
        followerRegistered: deps.isFollowerRegistered(),
        followerTarget,
        followerSlot: deps.getFollowerSlot(),
        followerThreadName:
          (followerTarget
            ? deps.getDisplayTitle?.(followerTarget)
            : undefined) ?? deps.getFollowerThreadName(),
        ...(leaderProtocol ? { leaderProtocol } : {}),
      };
    },
    getTopicTargets: () =>
      listBaleThreadStatusTargets(deps.listRecords()).map((record) => ({
        ...record,
        threadName: deps.getDisplayTitle?.(record.target) ?? record.threadName,
      })),
    getThreadReservations: () =>
      listBaleThreadStatusReservations(deps.listReservations()),
    getTopicSyncObservations: () =>
      listBaleThreadStatusObservations(deps.listSyncObservations()),
    getInstanceSlot() {
      if (deps.getThreadMode() === "disabled") return undefined;
      return deps.getCurrentIdentity().slot;
    },
    getInstanceThreadName() {
      if (deps.getThreadMode() === "disabled") return undefined;
      return deps.getCurrentIdentity().threadName;
    },
  };
}

export interface BaleCurrentThreadAssemblyDeps {
  instanceId: string;
  listRecords: BaleCurrentInstanceThreadRuntimeDeps["listRecords"];
  listWorkspaceBindings?: () => readonly BaleWorkspaceThreadBinding[];
  /** Display-mode title for a binding whose tab has no acknowledged title yet (fresh, moved or reclaimed). */
  resolveAutomaticDisplayTitle?: (
    binding: BaleWorkspaceThreadBinding,
  ) => string | undefined;
  getFollowerDisplayTitle?: () => string | undefined;
  getActiveTurnTarget(): BaleTarget | undefined;
  getFollowerTarget(): BaleTarget | undefined;
  isFollowerRegistered(): boolean;
  getFollowerSlot(): string | undefined;
  getFollowerThreadName(): string | undefined;
  getLeaderIdentity(): BaleInstanceThreadIdentityCandidate | undefined;
  getLeaderTarget(): BaleTarget | undefined;
  getLeaderProtocol?: BaleThreadStatusProjectionRuntimeDeps["getLeaderProtocol"];
  status: Pick<
    BaleThreadStatusProjectionRuntimeDeps,
    | "getThreadMode"
    | "isBusPollingStarted"
    | "listFollowers"
    | "listReservations"
    | "listSyncObservations"
    | "getLeaderSocketPath"
    | "getFollowerSocketPath"
    | "getTransportKind"
  >;
}

export interface BaleCurrentThreadAssembly {
  getDisplayTitle: (target: BaleTarget) => string | undefined;
  current: BaleCurrentInstanceThreadRuntime;
  status: BaleThreadStatusProjectionRuntime;
}

/** Own current-thread preference and its matching status projection. */
export function createBaleCurrentThreadAssembly(
  deps: BaleCurrentThreadAssemblyDeps,
): BaleCurrentThreadAssembly {
  const getFollower = () => {
    const target = deps.getFollowerTarget();
    if (!target) return undefined;
    return {
      registered: deps.isFollowerRegistered(),
      target,
      slot: deps.getFollowerSlot(),
      threadName: deps.getFollowerThreadName(),
    };
  };
  const namedCurrent = createBaleCurrentInstanceThreadRuntime({
    instanceId: deps.instanceId,
    listRecords: deps.listRecords,
    getPreferredTarget: () =>
      deps.getActiveTurnTarget() ??
      deps.getFollowerTarget() ??
      deps.getLeaderTarget(),
    getFollower,
    getLeader: deps.getLeaderIdentity,
  });
  const getDisplayTitle = (target: BaleTarget): string | undefined => {
    const followerTarget = deps.getFollowerTarget();
    if (
      followerTarget &&
      targetMatches(followerTarget, target) &&
      deps.isFollowerRegistered()
    ) {
      return deps.getFollowerDisplayTitle?.();
    }
    const binding = deps
      .listWorkspaceBindings?.()
      .find((value) => targetMatches(value.target, target));
    return (
      binding?.displayTitle ??
      (binding ? deps.resolveAutomaticDisplayTitle?.(binding) : undefined)
    );
  };
  const displayIdentity = (
    identity: BaleInstanceThreadIdentityCandidate,
  ) => {
    const title = identity.target
      ? getDisplayTitle(identity.target)
      : undefined;
    return title ? { ...identity, threadName: title } : identity;
  };
  const current = {
    ...namedCurrent,
    getIdentity: (target?: BaleTarget) =>
      displayIdentity(namedCurrent.getIdentity(target)),
  };
  return {
    getDisplayTitle,
    current,
    status: createBaleThreadStatusProjectionRuntime({
      ...deps.status,
      isFollowerRegistered: deps.isFollowerRegistered,
      listRecords: deps.listRecords,
      getFollowerTarget: deps.getFollowerTarget,
      getFollowerSlot: deps.getFollowerSlot,
      getFollowerThreadName: deps.getFollowerThreadName,
      getLeaderProtocol: deps.getLeaderProtocol,
      getDisplayTitle,
      getCurrentIdentity: () =>
        displayIdentity(namedCurrent.getRestorationIdentity()),
    }),
  };
}

export interface BaleThreadStatusFollowerView {
  instanceId: string;
  cwd?: string;
  lastHeartbeatMs: number;
  target?: BaleTarget;
  protocol?: {
    protocolVersion: number;
    runtimeBuild: string;
    capabilities: string[];
  };
}

function getBaleThreadStatusName(
  record: BaleTopicTargetRecord | undefined,
): string | undefined {
  if (!record) return undefined;
  if (
    record.threadName &&
    isBaleTopicThreadNameValidForSlot(record.threadName, record.slot)
  )
    return record.threadName;
  return chooseBaleThreadName({ slot: record.slot });
}

export function listBaleThreadStatusFollowers(options: {
  followers: readonly BaleThreadStatusFollowerView[];
  records: readonly BaleTopicTargetRecord[];
}): Array<{
  instanceId: string;
  cwd?: string;
  lastHeartbeatMs: number;
  target?: BaleTarget;
  protocol?: {
    protocolVersion: number;
    runtimeBuild: string;
    capabilities: string[];
  };
  slot?: string;
  threadName?: string;
  status?: string;
}> {
  return options.followers.map((follower) => {
    const record = options.records.find((record) => {
      return (
        record.target.chatId === follower.target?.chatId &&
        record.target.threadId === follower.target?.threadId
      );
    });
    return {
      instanceId: follower.instanceId,
      cwd: follower.cwd,
      lastHeartbeatMs: follower.lastHeartbeatMs,
      target: follower.target,
      ...(follower.protocol ? { protocol: follower.protocol } : {}),
      slot: record?.slot,
      threadName: getBaleThreadStatusName(record),
      status: record?.status,
    };
  });
}

export function listBaleThreadStatusTargets(
  records: readonly BaleTopicTargetRecord[],
): Array<{
  instanceId?: string;
  status: BaleTopicTargetStatus;
  target: BaleTarget & { threadId: number };
  slot?: string;
  threadName?: string;
  syncStatus?: BaleTopicSyncStatus;
  lastSyncObservedAtMs?: number;
  lastSyncProbeAtMs?: number;
  lastSyncError?: string;
  lastReconcileAction?: string;
}> {
  return records.map((record) => {
    return {
      instanceId: record.instanceId,
      status: record.status,
      target: record.target,
      slot: record.slot,
      threadName: getBaleThreadStatusName(record),
      syncStatus: record.syncStatus,
      lastSyncObservedAtMs: record.lastSyncObservedAtMs,
      lastSyncProbeAtMs: record.lastSyncProbeAtMs,
      lastSyncError: record.lastSyncError,
      lastReconcileAction: record.lastReconcileAction,
    };
  });
}

export function listBaleThreadStatusReservations(
  reservations: readonly BaleThreadReservation[],
): Array<{
  target: BaleTarget & { threadId: number };
  slot: string;
  reason: string;
  instanceId?: string;
  expiresAtMs?: number;
  lastReconcileAction?: string;
}> {
  return reservations.map((reservation) => {
    return {
      target: reservation.target,
      slot: reservation.slot,
      reason: reservation.reason,
      instanceId: reservation.instanceId,
      expiresAtMs: reservation.expiresAtMs,
      lastReconcileAction: reservation.lastReconcileAction,
    };
  });
}

export function listBaleThreadStatusObservations(
  observations: readonly BaleTopicSyncObservation[],
): Array<{
  target: BaleTarget & { threadId: number };
  syncStatus: BaleTopicSyncStatus;
  observedAtMs: number;
  instanceId?: string;
  slot?: string;
  lastSyncError?: string;
  lastReconcileAction?: string;
}> {
  return observations.map((observation) => {
    return {
      target: observation.target,
      syncStatus: observation.syncStatus,
      observedAtMs: observation.observedAtMs,
      instanceId: observation.instanceId,
      slot: observation.slot,
      lastSyncError: observation.lastSyncError,
      lastReconcileAction: observation.lastReconcileAction,
    };
  });
}

export function getBaleTargetFromApiBody(
  body: unknown,
): (BaleTarget & { threadId: number }) | undefined {
  if (!body || typeof body !== "object" || Array.isArray(body))
    return undefined;
  const record = body as Record<string, unknown>;
  const chatId = asInteger(record.chat_id);
  const threadId = asInteger(record.message_thread_id);
  return chatId !== undefined && threadId !== undefined
    ? { chatId, threadId }
    : undefined;
}

export function isBaleTopicTargetStaleError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const status =
    "status" in error && typeof error.status === "number"
      ? error.status
      : undefined;
  if (status !== undefined && status !== 400) return false;
  return (
    ThreadReconciler.isBaleTopicDeletedErrorMessage(error.message) ||
    ThreadReconciler.isBaleTopicClosedErrorMessage(error.message)
  );
}

export function isBaleTopicModeUnavailableError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  return (
    message.includes("not a forum") ||
    message.includes("forum topic") ||
    message.includes("topics are disabled") ||
    message.includes("threaded mode") ||
    message.includes("method is available only for")
  );
}

export function createBaleTopicTargetRenamer(
  deps: BaleTopicTargetRenamerDeps,
): (
  request: BaleTopicTargetRenameRequest,
) => Promise<BaleTopicTargetRecord | undefined> {
  const {
    store,
    callApi,
    assertAuthority,
    shouldRenameDisplayedTitle,
    topicNameTemplate,
  } = deps;
  const renameByTarget = store.renameByTarget.bind(store);
  return async (request) => {
    const target = {
      chatId: request.target.chatId,
      threadId: request.target.threadId,
    };
    const slot = request.slot;
    const threadName = normalizeBaleTopicTargetThreadName(
      request.threadName,
    );
    assertAuthority?.();
    if (
      !threadName ||
      getBaleManualThreadDisplayNameValidationError(threadName)
    )
      return undefined;
    const occupied = new Set(
      listOccupiedBaleThreadIdentities({
        records: store.list(),
        workspaceBindings: store.listWorkspaceBindings(),
        pendingProvisions: store.listPendingProvisions(),
        exceptTarget: target,
      }),
    );
    if (occupied.has(getBaleTopicIdentityName(threadName)))
      return undefined;
    const name = getBaleTopicTitleForThreadName(
      threadName,
      slot ?? "",
      topicNameTemplate,
    );
    const updateDisplayTitle = shouldRenameDisplayedTitle?.() ?? true;
    assertAuthority?.();
    if (updateDisplayTitle) {
      const body = {
        chat_id: target.chatId,
        message_thread_id: target.threadId,
        name,
      };
      // The transport must retain the same authority across issuance, response parsing and retry waits.
      if (assertAuthority)
        await callApi("editForumTopic", body, { assertAuthority });
      else await callApi("editForumTopic", body);
    }
    assertAuthority?.();
    if ((shouldRenameDisplayedTitle?.() ?? true) !== updateDisplayTitle) {
      throw new Error("Bale display mode changed during Workspace rename.");
    }
    assertAuthority?.();
    const renamed = await renameByTarget(target, threadName, {
      updateDisplayTitle,
    });
    assertAuthority?.();
    return renamed;
  };
}

/** Caller holds profile Workspace admission; only an explicit connect grants a fresh creation attempt. */
export async function resetBaleConnectionProvisioning(input: {
  store: BaleTopicTargetStore;
  owner: BaleThreadPendingProvision["owner"];
  instanceId: string;
  profileKey: string;
  isCurrent: () => boolean;
  recordEvent: (category: string, message: unknown, details?: Record<string, unknown>) => void;
}): Promise<void> {
  if (!input.isCurrent()) throw new Error("Bale connection recovery authority changed.");
  const removed: BaleThreadPendingProvision[] = [];
  for (const pending of input.store.listPendingProvisions()) {
    if (pending.owner !== input.owner || pending.target ||
        (pending.profileKey !== input.profileKey && pending.instanceId !== input.instanceId)) continue;
    if (!input.isCurrent()) throw new Error("Bale connection recovery authority changed.");
    if (!await input.store.resetPendingProvisionForConnect(pending, input.isCurrent))
      throw new Error("Bale connection recovery lost publication authority.");
    if (!input.isCurrent()) throw new Error("Bale connection recovery authority changed.");
    removed.push(pending);
  }
  if (removed.length === 0) return;
  input.recordEvent("connection", "Explicit connect reset unfinished Thread creation; an unconfirmed Bale Thread may remain.", {
    phase: "connect-provision-reset", count: removed.length, owner: input.owner,
  });
}

export function createBaleTopicTargetProvisioner(
  deps: BaleTopicTargetProvisionerDeps,
): (
  request: BaleTopicTargetProvisionRequest,
) => Promise<BaleTopicTargetProvisionResult> {
  const getNowMs = deps.getNowMs ?? (() => 0);
  const getRandom = deps.getRandom;
  return async (request) => {
    const leaderEpoch = deps.getCurrentLeaderEpoch?.();
    const assertLeaderEpoch = (phase: string): void => {
      if (
        deps.getCurrentLeaderEpoch &&
        (leaderEpoch === undefined ||
          deps.getCurrentLeaderEpoch() !== leaderEpoch)
      ) {
        throw new Error(
          `Bale topic provisioning lost leader ownership (${phase}).`,
        );
      }
    };
    assertLeaderEpoch("start");
    const isManualFollowerRequest = request.owner?.kind === "manual-follower";
    const identity = deps.store.getIdentityByProfileKey(request.profileKey);
    const nowMs = getNowMs();
    let pendingForRequest = deps.store
      .listPendingProvisions()
      .find(
        (pending) =>
          pending.profileKey === request.profileKey ||
          pending.instanceId === request.instanceId,
      );
    const pendingTarget = pendingForRequest?.target;
    if (
      pendingForRequest &&
      request.workspaceBindingKey &&
      pendingForRequest.workspaceBindingKey !== request.workspaceBindingKey &&
      !(
        pendingTarget &&
        deps.store
          .listWorkspaceBindings()
          .some(
            (binding) =>
              binding.bindingKey === request.workspaceBindingKey &&
              targetMatches(binding.target, pendingTarget),
          )
      )
    ) {
      throw new Error(
        "Bale unfinished Thread creation does not match this session binding.",
      );
    }
    if (pendingForRequest?.target) {
      const target = pendingForRequest.target;
      const observation = deps.store
        .listSyncObservations()
        .find((entry) => targetMatches(entry.target, target));
      assertBalePendingTopicRecoveryAllowed(deps.store, target);
      if (observation?.syncStatus === "deleted") {
        assertLeaderEpoch("before-deleted-provision-settlement");
        deps.store.markStaleByTarget(target, "deleted");
        await deps.store.persist();
        assertLeaderEpoch("after-deleted-provision-settlement");
        pendingForRequest = undefined;
      }
    }
    const matchesWorkspace = (target: BaleTarget): boolean =>
      !request.workspaceBindingKey ||
      deps.store
        .listWorkspaceBindings()
        .some(
          (binding) =>
            binding.bindingKey === request.workspaceBindingKey &&
            targetMatches(binding.target, target),
        ) ||
      (!!pendingForRequest?.target &&
        targetMatches(pendingForRequest.target, target));
    const existing = deps.store.getByProfileKey(request.profileKey);
    if (
      existing &&
      ThreadReconciler.isCurrentThreadRecord(existing) &&
      matchesWorkspace(existing.target)
    ) {
      const slot = existing.slot ?? deps.store.allocateSlot(request.profileKey);
      if (!slot) {
        throw new BaleWorkspaceSlotUnavailableError();
      }
      const occupied = listOccupiedBaleThreadIdentities({
        records: deps.store.list(),
        workspaceBindings: deps.store.listWorkspaceBindings(),
        pendingProvisions: deps.store.listPendingProvisions(),
        exceptTarget: existing.target,
        exceptWorkspaceBindingKey: request.workspaceBindingKey,
      });
      const identityThreadName =
        identity?.threadName &&
        isBaleTopicThreadNameValidForSlot(identity.threadName, slot) &&
        !occupied.includes(getBaleTopicIdentityName(identity.threadName))
          ? identity.threadName
          : undefined;
      const bakedThreadName = chooseBaleThreadName({
        slot: getNextBaleThreadNamePaletteSlot(deps.store.list(), slot),
        entropy: nowMs,
        getRandom,
        occupied,
      });
      const record = deps.store.upsert({
        ...existing,
        status: "active",
        updatedAtMs: nowMs,
        threadName:
          existing.threadName ?? identityThreadName ?? bakedThreadName,
        instanceId: request.instanceId,
        slot,
        owner: request.owner ?? existing.owner,
        lastError: undefined,
      });
      const recoveredTitle =
        pendingForRequest?.target &&
        targetMatches(pendingForRequest.target, record.target)
          ? pendingForRequest.displayTitle
          : undefined;
      if (
        pendingForRequest?.target &&
        targetMatches(pendingForRequest.target, record.target)
      ) {
        if (!request.workspaceBindingKey)
          deps.store.removePendingProvision(pendingForRequest.id);
        await deps.store.persist();
        assertLeaderEpoch("after-recovered-current-binding");
      }
      return {
        target: record.target,
        reused: true,
        record,
        ...(recoveredTitle ? { displayTitle: recoveredTitle } : {}),
      };
    }
    if (pendingForRequest?.target) {
      if (!pendingForRequest.slot) {
        throw new Error("Bale Workspace slot reservation is unavailable.");
      }
      const record = deps.store.upsert({
        profileKey: request.profileKey,
        owner: request.owner,
        target: pendingForRequest.target,
        status: "active",
        createdAtMs: pendingForRequest.startedAtMs,
        updatedAtMs: nowMs,
        threadName: pendingForRequest.threadName,
        instanceId: request.instanceId,
        slot: pendingForRequest.slot,
      });
      if (!request.workspaceBindingKey)
        deps.store.removePendingProvision(pendingForRequest.id);
      await deps.store.persist();
      assertLeaderEpoch("after-recovered-binding");
      return {
        target: record.target,
        reused: true,
        record,
        ...(pendingForRequest.displayTitle
          ? { displayTitle: pendingForRequest.displayTitle }
          : {}),
      };
    }
    if (pendingForRequest) {
      throw new Error(
        `Bale topic provisioning remains ${pendingForRequest.status ?? "in-flight"} for this instance.`,
      );
    }
    const activeForInstance = deps.store.getActiveByInstanceId(
      request.instanceId,
    );
    if (activeForInstance && matchesWorkspace(activeForInstance.target)) {
      if (!activeForInstance.slot) {
        throw new Error("Bale Workspace slot reservation is unavailable.");
      }
      return {
        target: activeForInstance.target,
        reused: true,
        record: activeForInstance,
      };
    }
    // No profileKey match — try to claim an existing inactive thread before creating another Bale tab.
    if (deps.claimPendingTargets !== false) {
      const claimed = deps.store.claimReusableTarget(
        request.instanceId,
        identity?.threadName,
      );
      if (claimed) {
        return { target: claimed.target, reused: true, record: claimed };
      }
    }
    const occupied = listOccupiedBaleThreadIdentities({
      records: deps.store.list(),
      workspaceBindings: deps.store.listWorkspaceBindings(),
      pendingProvisions: deps.store.listPendingProvisions(),
      exceptWorkspaceBindingKey: request.workspaceBindingKey,
    });
    const requestedThreadName =
      request.threadName &&
      isBaleTopicThreadNameValidForSlot(request.threadName, undefined) &&
      !occupied.includes(getBaleTopicIdentityName(request.threadName))
        ? normalizeBaleTopicTargetThreadName(request.threadName)
        : undefined;
    const candidateThreadName = requestedThreadName ?? identity?.threadName;
    const preferredNameSlot =
      getBaleThreadNameLeadingSlot(candidateThreadName) ??
      getNextBaleThreadNamePaletteSlot(deps.store.list(), undefined) ??
      request.preferredSlot;
    const slot =
      (existing && matchesWorkspace(existing.target)
        ? existing.slot
        : undefined) ??
      deps.store.allocateSlot(
        request.profileKey,
        isManualFollowerRequest
          ? request.preferredSlot
          : (request.preferredSlot ??
              (candidateThreadName ? undefined : identity?.slot) ??
              preferredNameSlot),
        request.workspaceBindingKey,
        {
          excludeCurrentRecord:
            !!existing && !matchesWorkspace(existing.target),
        },
      );
    if (!slot) {
      throw new BaleWorkspaceSlotUnavailableError();
    }
    const uniqueCandidate =
      candidateThreadName &&
      isBaleTopicThreadNameValidForSlot(candidateThreadName, slot) &&
      !occupied.includes(getBaleTopicIdentityName(candidateThreadName))
        ? candidateThreadName
        : undefined;
    const requestThreadName =
      uniqueCandidate ??
      chooseBaleThreadName({ slot, entropy: nowMs, getRandom, occupied });
    let displayTitle: string | undefined;
    if (
      deps.resolveInitialWorkspaceDisplayTitle &&
      request.workspaceBindingKey &&
      request.workspaceCwd
    ) {
      const projectedTitle = deps.resolveInitialWorkspaceDisplayTitle({
        bindingKey: request.workspaceBindingKey,
        cwd: request.workspaceCwd,
        slot,
        threadName: requestThreadName,
      });
      if (!projectedTitle?.trim()) {
        throw new Error(
          "Bale Thread display identity is missing or ambiguous.",
        );
      }
      displayTitle = buildBaleTopicName(
        { ...request, threadName: projectedTitle },
        "{threadName}",
        slot,
      );
    }
    const pendingId = `provision:${request.instanceId}:${slot}:${nowMs}:${randomUUID()}`;
    const pendingOwner =
      request.owner?.kind === "leader" ? "leader" : "manual-follower";
    assertLeaderEpoch("before-pending-intent");
    const pendingBase: BaleThreadPendingProvision = {
      id: pendingId,
      owner: pendingOwner,
      instanceId: request.instanceId,
      profileKey: request.profileKey,
      ...(request.workspaceBindingKey
        ? { workspaceBindingKey: request.workspaceBindingKey }
        : {}),
      threadName: requestThreadName,
      ...(displayTitle ? { displayTitle } : {}),
      slot,
      startedAtMs: nowMs,
      ...(leaderEpoch !== undefined ? { leaderEpoch } : {}),
    };
    deps.store.upsertPendingProvision(pendingBase);
    await deps.store.persist();
    assertLeaderEpoch("after-pending-intent");
    let threadId: number | undefined;
    try {
      assertLeaderEpoch("before-createForumTopic");
      const topic = await deps.callApi<BaleTopicResult>(
        "createForumTopic",
        {
          chat_id: deps.topicChatId,
          name:
            displayTitle ??
            buildBaleTopicName(
              {
                ...request,
                ...(requestThreadName ? { threadName: requestThreadName } : {}),
              },
              deps.topicNameTemplate ??
                (requestThreadName ? "{threadName}" : "{slot}"),
              slot,
            ),
        },
        { maxAttempts: 1 },
      );
      threadId = topic.message_thread_id;
      if (typeof threadId !== "number" || !Number.isInteger(threadId)) {
        throw new BaleApiCommitUnknownError(
          "createForumTopic",
          new Error("Bale createForumTopic returned no message_thread_id."),
        );
      }
      assertLeaderEpoch("after-createForumTopic");
      const target = { chatId: deps.topicChatId, threadId };
      deps.store.upsertPendingProvision({ ...pendingBase, target });
      await deps.store.persist();
      assertLeaderEpoch("after-pending-target");
      deps.store.upsert({
        profileKey: request.profileKey,
        owner: request.owner,
        target,
        status: "starting",
        createdAtMs: existing?.createdAtMs ?? nowMs,
        updatedAtMs: nowMs,
        threadName: requestThreadName,
        instanceId: request.instanceId,
        slot,
      });
      await deps.store.persist();
      assertLeaderEpoch("after-starting-binding");
      const record = deps.store.upsert({
        profileKey: request.profileKey,
        owner: request.owner,
        target,
        status: "active",
        createdAtMs: existing?.createdAtMs ?? nowMs,
        updatedAtMs: nowMs,
        threadName: requestThreadName,
        instanceId: request.instanceId,
        slot,
      });
      // Workspace commit consumes the exact title evidence in the same publication.
      if (!request.workspaceBindingKey)
        deps.store.removePendingProvision(pendingId);
      await deps.store.persist();
      assertLeaderEpoch("after-active-binding");
      return {
        target: record.target,
        reused: false,
        record,
        ...(displayTitle ? { displayTitle } : {}),
      };
    } catch (error) {
      if (
        threadId !== undefined &&
        deps.getCurrentLeaderEpoch &&
        deps.getCurrentLeaderEpoch() !== leaderEpoch
      ) {
        await deps.store.recordPendingProvisionTargetRecovery(pendingBase, {
          chatId: deps.topicChatId,
          threadId,
        });
        throw error;
      }
      assertLeaderEpoch("failure-cleanup");
      if (threadId === undefined) {
        if (isBaleApiCommitUnknownError(error)) {
          deps.store.upsertPendingProvision({
            ...pendingBase,
            status: "ambiguous",
          });
        } else {
          deps.store.removePendingProvision(pendingId);
        }
        await deps.store.persist();
      } else {
        try {
          await deps.store.persist();
        } catch {
          // Keep the original post-create failure visible to the caller.
        }
      }
      throw error;
    }
  };
}

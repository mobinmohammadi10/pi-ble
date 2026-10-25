/**
 * Bale bus follower runtime
 * Zones: multi-instance bus, follower lifecycle, manual registration
 * Owns this Pi instance's follower-side bus behavior: manual registration,
 * heartbeat, forwarded-update receiving, and follower-routed API calls.
 * It must not spawn Pi processes or create hidden Bale-originated instances.
 */

import { createHash } from "node:crypto";
import { basename } from "node:path";
import { isDeepStrictEqual } from "node:util";

import type { BalePreparedHeldCommand } from "./commands.ts";
import type {
  BaleWorkspaceRestoreExecutor,
  BaleWorkspaceRestoreIntent,
} from "./threads.ts";
import type {
  BaleLiveInputPreparation,
  BaleLiveSourceCompletionReadiness,
  BaleUpdateAdmissionLifecycleRuntime,
} from "./updates.ts";

import {
  getBaleBusTransportRetryPolicy,
  BALE_BUS_REGISTRATION_RETRY,
} from "./bus-transport.ts";
import {
  createBaleBusFollowerDeliveryIdentity,
  createBaleBusForeignOwnedUpdateForwarder,
  createBaleBusLocalServer,
  createBaleBusRequestIdFactory,
  createUnauthorizedBusAck,
  rejectBaleBusRequest,
  getBaleBusProtocolCompatibility,
  getBaleBusSocketPath,
  hasBaleBusCapability,
  hasBaleBusSteerQueueHandoffCapability,
  isBaleBusEnvelopeAuthorized,
  parseBaleBusEnvelope,
  resolveBaleBusSocketPath,
  sendBaleBusLocalEnvelope,
  BALE_BUS_CAPABILITY_DIRECTORY_DISPLAY_FORMAT,
  BALE_BUS_CAPABILITY_LIVE_REBIND_APPLY,
  BALE_BUS_CAPABILITY_LIVE_REBIND_SAVE,
  BALE_BUS_CAPABILITY_LIVE_REBIND_SETTLE,
  BALE_BUS_CAPABILITY_PRE_DISPATCH_REBIND_EXECUTION,
  BALE_BUS_CAPABILITY_SELECTED_MENU_DELIVERY,
  BALE_BUS_CAPABILITY_SESSION_REPLACEMENT_INTENT,
  BALE_BUS_CAPABILITY_THREAD_DISPLAY_MODE,
  BALE_BUS_CAPABILITY_WORKSPACE_RESTORE,
  BALE_BUS_CAPABILITY_WORKSPACE_THREAD_RENAME,
  BALE_BUS_HELD_COMMAND_CAPABILITIES,
  getBaleBusHeldCommandCapabilities,
  BALE_BUS_LIVE_REBIND_CAPABILITIES,
  BaleBusLocalAuthorityError,
  type BaleBusAgentMessage,
  type BaleBusAgentTargetSelector,
  type BaleBusEnvelope,
  type BaleBusFollowerQueueHandoffOffer,
  type BaleBusForwardOwnership,
  type BaleBusLiveRebindApplyObservation,
  type BaleBusLiveRebindCommandObservation,
  type BaleBusLiveRebindSaveObservation,
  type BaleBusLiveRebindSettlementObservation,
  type BaleBusLiveRebindWorkObservation,
  type BaleBusLiveRebindWorkState,
  type BaleBusProtocolIdentity,
  type BaleBusSelectedMenuDeliveryObservation,
  type BaleBusSelectedMenuTextEffect,
  type BaleBusSocketPathSource,
  type BaleBusWorkspaceRestoreObservation,
  BALE_BUS_FOLLOWER_API_NOT_ALLOWED_MESSAGE,
} from "./bus.ts";
import type {
  BaleConfigStore,
  BaleThreadDisplayMode,
} from "./config.ts";
import {
  parseBaleUpdateJournalQueueOwner,
  type BaleUpdateJournalStoreOptions,
} from "./journal.ts";
import {
  BALE_BUS_LEADER_STALE_HEARTBEAT_MS,
  type BaleLockEntry,
  type BaleLockState,
} from "./locks.ts";
import * as Machine from "./machine.ts";
import { isPiStaleContextError } from "./pi.ts";
import type { BaleQueueHandoffStageResult } from "./queue.ts";
import {
  parseBaleTarget as parseTarget,
  type BaleTarget,
} from "./target.ts";
import {
  isBaleApiMethodRetrySafe,
  assertBaleApiCallAuthority,
  BaleApiAuthorityError,
  BaleApiCommitUnknownError,
  BaleApiFollowerNotAllowedError,
  BaleApiStaleTargetError,
  type BaleApiCallOptions,
} from "./bale-api.ts";
import * as Threads from "./threads.ts";
import { isWireRecord as isRecord } from "./wire.ts";
import {
  createBaleWorkspaceAdmissionOperationId,
  runWithBaleWorkspaceAdmissionsAsync,
  type BaleWorkspaceAdmissionLedger,
} from "./workspace-admission.ts";
import * as WorkspaceIdentity from "./workspace-identity.ts";

const BALE_BUS_FOLLOWER_PROMOTION_GRACE_MS = 2_500;
const BALE_FOLLOWER_SESSION_HANDOFF_TTL_MS = 30_000;
const BALE_BUS_FOLLOWER_CLIENT_TIMEOUT_MS = 30_000;
const BALE_BUS_FOLLOWER_API_SLOW_CALL_MS = 1_500;
const BALE_BUS_FOLLOWER_REGISTRATION_WAIT_MS = 30_000;
export const BALE_BUS_FOLLOWER_HEARTBEAT_TIMEOUT_MS =
  BALE_BUS_LEADER_STALE_HEARTBEAT_MS;
const BALE_BUS_FOLLOWER_REGISTRATION_RETRY_ATTEMPTS =
  BALE_BUS_REGISTRATION_RETRY.attempts;
const BALE_BUS_FOLLOWER_REGISTRATION_RETRY_DELAY_MS =
  BALE_BUS_REGISTRATION_RETRY.delayMs;

const BALE_FOLLOWER_SESSION_HANDOFF_KEY =
  "__piBaleFollowerSessionHandoff";

export interface BaleFollowerSessionHandoff {
  pid: number;
  instanceId: string;
  createdAtMs: number;
  target: BaleTarget;
  slot?: string;
  threadName?: string;
}

export function getBaleFollowerSessionHandoff():
  BaleFollowerSessionHandoff | undefined {
  const value = (globalThis as Record<string, unknown>)[
    BALE_FOLLOWER_SESSION_HANDOFF_KEY
  ];
  if (!value || typeof value !== "object") return undefined;
  const handoff = value as Partial<BaleFollowerSessionHandoff>;
  if (
    typeof handoff.pid !== "number" ||
    typeof handoff.instanceId !== "string" ||
    typeof handoff.createdAtMs !== "number" ||
    !handoff.target ||
    typeof handoff.target !== "object" ||
    typeof handoff.target.chatId !== "number"
  ) {
    return undefined;
  }
  return handoff as BaleFollowerSessionHandoff;
}

export function setBaleFollowerSessionHandoff(
  handoff: BaleFollowerSessionHandoff | undefined,
): void {
  const store = globalThis as Record<string, unknown>;
  if (!handoff) delete store[BALE_FOLLOWER_SESSION_HANDOFF_KEY];
  else store[BALE_FOLLOWER_SESSION_HANDOFF_KEY] = handoff;
}

function isBaleFollowerSessionHandoffFresh(
  handoff: BaleFollowerSessionHandoff | undefined,
  options: { pid?: number; nowMs?: number; ttlMs?: number } = {},
): handoff is BaleFollowerSessionHandoff {
  if (!handoff) return false;
  const pid = options.pid ?? process.pid;
  const nowMs = options.nowMs ?? Date.now();
  const ttlMs = options.ttlMs ?? BALE_FOLLOWER_SESSION_HANDOFF_TTL_MS;
  return handoff.pid === pid && nowMs - handoff.createdAtMs <= ttlMs;
}

export interface BaleBusFollowerRegistrationRuntime<TContext> {
  registerWithLeader: (
    ctx: TContext,
    leader: { busSocketPath?: string; busSecret?: string },
    options?: {
      target?: BaleTarget;
      previousInstanceId?: string;
      restoreWorkspace?: boolean;
      recoverConnection?: boolean;
    },
  ) => Promise<boolean>;
  setContext: (ctx: TContext) => void | Promise<void>;
  disconnectFromLeader?: () => Promise<boolean>;
  renameThread?: (
    target: BaleTarget & { threadId: number },
    threadName: string,
  ) => Promise<string>;
  resetThreadName?: (
    target: BaleTarget & { threadId: number },
  ) => Promise<string>;
  setThreadDisplayMode?: (mode: BaleThreadDisplayMode) => Promise<void>;
  /** Leader-mediated durable publication or successor claim; true only after exact commit. */
  requestSessionReplacement?: (
    operation: "publish" | "settle",
    intent: Threads.BaleSessionReplacementIntent,
  ) => Promise<boolean>;
  stop: () => void;
}

export interface BaleBusFollowerSessionReplacementSuspenderDeps {
  registrationState: Pick<
    BaleBusFollowerRegistrationState,
    "isRegistered" | "getTarget" | "getSlot" | "getThreadName"
  >;
  instanceId: string;
  suspendPolling: () => Promise<void>;
  isLeader?: () => boolean;
  getLeaderBinding?: () => BaleBusFollowerPromotedBinding | undefined;
  getActiveContext?: () => { cwd?: string } | undefined;
  getActiveProfileName?: () => string | undefined;
  recordRuntimeEvent: (
    category: string,
    error: unknown,
    details?: Record<string, unknown>,
  ) => void;
  getNowMs?: () => number;
  getPid?: () => number;
}

export interface BaleBusFollowerSessionRefreshHookDeps<TContext> {
  registrationState: Pick<BaleBusFollowerRegistrationState, "isRegistered">;
  registrationRuntime: Pick<
    BaleBusFollowerRegistrationRuntime<TContext>,
    "registerWithLeader" | "setContext"
  >;
  getLeaderState: () => BaleLockState;
  isSessionActive?: (ctx: TContext) => boolean;
  updateStatus: (ctx: TContext) => void;
  recordRuntimeEvent: (
    category: string,
    error: unknown,
    details?: Record<string, unknown>,
  ) => void;
}

export type BaleBusFollowerControlLifecyclePhase = "electing";

export interface BaleBusFollowerControlState {
  getActiveAuthSecret: () => string | undefined;
  setActiveAuthSecret: (secret: string | undefined) => void;
  getLifecyclePhase: () => BaleBusFollowerControlLifecyclePhase | undefined;
  setLifecyclePhase: (
    phase: BaleBusFollowerControlLifecyclePhase | undefined,
  ) => void;
}

export interface BaleBusFollowerRegistrationState {
  isRegistered: () => boolean;
  getTarget: () => BaleTarget | undefined;
  getSlot: () => string | undefined;
  getThreadName: () => string | undefined;
  getDisplayTitle: () => string | undefined;
  setDisplayTitle: (title: string, generation: string) => boolean;
  getGeneration: () => string | undefined;
  /** Return the acknowledged session only when it matches the caller's current context. */
  getSessionId: (currentSessionId: string | undefined) => string | undefined;
  beginRecovery: () => number;
  cancelRecovery: () => void;
  waitForGeneration: (timeoutMs?: number) => Promise<string | undefined>;
  getLeaderProtocol: () => BaleBusProtocolIdentity | undefined;
  getEligibleElectionSlots: () => readonly string[];
  setEligibleElectionSlots: (slots: readonly string[]) => void;
  setRegistered: (
    registered: boolean,
    target?: BaleTarget,
    metadata?: {
      slot?: string;
      threadName?: string;
      displayTitle?: string;
      generation?: string;
      sessionId?: string;
      leaderProtocol?: BaleBusProtocolIdentity;
    },
  ) => void;
}

export interface BaleBusForwardedUpdateReceiverRuntime {
  start: () => Promise<void>;
  stop: () => Promise<void>;
}

export interface BaleBusFollowerDurableAdmissionResult {
  deliveryId: string;
  sourceUpdateId: number;
}

export interface BaleBusFollowerDurableAdmissionPort<TContext> {
  admit: (
    envelope: Extract<
      BaleBusEnvelope,
      {
        kind:
          | "leader.forwardCallback"
          | "leader.forwardReaction"
          | "leader.forwardMessage"
          | "leader.forwardEditedMessage"
          | "leader.wakeInputCustody";
      }
    >,
    ctx: TContext,
  ) => Promise<BaleBusFollowerDurableAdmissionResult>;
}

export interface BaleBusFollowerClientRuntimeDeps<TMessage = unknown> {
  socketPath: BaleBusSocketPathSource;
  instanceId: string;
  getApiAuthSecret?: () => string | undefined;
  getForwardingAuthSecret?: () => string | undefined;
  getRegistrationGeneration: () => string | undefined;
  waitForRegistrationGeneration?: (
    timeoutMs?: number,
  ) => Promise<string | undefined>;
  getForwardCommentBatchPosition?: (
    message: TMessage,
  ) => "comment" | "forward" | undefined;
  validateForwardOwnership?: (
    ownership: BaleBusForwardOwnership,
  ) => boolean;
  recordRuntimeEvent?: (
    category: string,
    error: unknown,
    details?: Record<string, unknown>,
  ) => void;
  timeoutMs?: number;
}

/** Structural port for run-collapsing diagnostics, implemented by the logging domain. */
export interface BaleFailureRunLogPort {
  record: (error: unknown, details?: Record<string, unknown>) => boolean;
  settled: () => BaleFailureRunSummaryPort | undefined;
  reset: () => void;
}

export interface BaleFailureRunSummaryPort {
  signature: string;
  failedAttempts: number;
  suppressedFailures: number;
  failedForMs: number;
}

export interface BaleBusFollowerApiCallerDeps {
  socketPath: BaleBusSocketPathSource;
  instanceId: string;
  createRequestId: () => string;
  getAuthSecret?: () => string | undefined;
  getRegistrationGeneration: () => string | undefined;
  waitForRegistrationGeneration?: (
    timeoutMs?: number,
  ) => Promise<string | undefined>;
  getNowMs?: () => number;
  timeoutMs?: number;
  /** Receives one diagnostic per call slower than `slowCallMs`; observation only. */
  recordRuntimeEvent?: (
    category: string,
    error: unknown,
    details?: Record<string, unknown>,
  ) => void;
  slowCallMs?: number;
}

export interface BaleBusFollowerRegistrationRuntimeDeps<
  TContext extends { cwd?: string },
> {
  /**
   * Collapses one sustained heartbeat failure run. Optional at this unit boundary, where an absent port records
   * every failure; the runtime assembly requires it so production always supplies the logging domain's owner.
   */
  failureLog?: BaleFailureRunLogPort;
  instanceId: string;
  createRequestId: () => string;
  protocolIdentity: BaleBusProtocolIdentity;
  getLeaderAuthSecret?: (leader: { busSecret?: string }) => string | undefined;
  setActiveAuthSecret?: (secret: string | undefined) => void;
  followerBusSocketPath?: string;
  getFollowerBusSocketPath?: () => string;
  getLeaderSocketPath?: () => string;
  startReceiving?: () => Promise<void>;
  stopReceiving?: () => Promise<void> | void;
  registrationState?: BaleBusFollowerRegistrationState;
  isContextActive?: (ctx: TContext) => boolean;
  getProfileKey?: (ctx: TContext) => string | undefined;
  getThreadName?: (ctx: TContext) => string | undefined;
  getNowMs?: () => number;
  getPid?: () => number;
  getProcessBirthId?: () => string;
  getSessionId?: (ctx: TContext) => string | undefined;
  getSessionGeneration?: () => number;
  timeoutMs?: number;
  registrationTimeoutMs?: number;
  registrationRetryAttempts?: number;
  registrationRetryDelayMs?: number;
  heartbeatMs?: number;
  heartbeatTimeoutMs?: number;
  recordRuntimeEvent?: (
    category: string,
    error: unknown,
    details?: Record<string, unknown>,
  ) => void;
  onHeartbeatFailure?: (error: unknown, ctx: TContext) => Promise<void> | void;
  onRegistered?: (ctx: TContext) => Promise<void> | void;
  onDisplayTitleChanged?: (ctx: TContext) => void;
}

export function createBaleManualFollowerProfileKeyResolver(input: {
  getActiveProfileName: () => string | undefined;
  manualFollowerOwnerId: string;
}): () => string {
  return () =>
    Threads.getBaleThreadOwnerKey({
      kind: "manual-follower",
      instanceId: input.manualFollowerOwnerId,
      baleProfile: input.getActiveProfileName(),
    });
}

export interface BaleBusFollowerElection {
  expectedOwner?: BaleLockEntry;
  /** The expected owner is bus-proven unresponsive; the lock CAS still requires it to be the current owner. */
  unresponsive?: boolean;
}

export type BaleBusFollowerPromotionHandler<TContext> = (
  ctx: TContext,
  binding: BaleBusFollowerPromotedBinding,
  election: BaleBusFollowerElection,
) => Promise<boolean>;

type BaleBusFollowerWorkspaceAdmissionDeps = {
  getWorkspaceAdmission?: () =>
    | Pick<
        BaleWorkspaceAdmissionLedger,
        "acquireAdmission" | "releaseAdmission"
      >
    | undefined;
  recordRuntimeEvent?: (
    category: string,
    error: unknown,
    details?: Record<string, unknown>,
  ) => void;
};

function runBaleBusFollowerWorkspaceMutation<T>(
  deps: BaleBusFollowerWorkspaceAdmissionDeps,
  operationKind: string,
  operation: () => Promise<T>,
): Promise<T> {
  if (!deps.getWorkspaceAdmission) return operation();
  const admission = deps.getWorkspaceAdmission();
  if (!admission) {
    throw new Error("Bale Workspace admission authority is unavailable.");
  }
  return runWithBaleWorkspaceAdmissionsAsync({
    ledger: admission,
    operationId: createBaleWorkspaceAdmissionOperationId(),
    operationKind,
    scopes: [{ kind: "profile" }],
    operation,
    onReleaseError(error) {
      deps.recordRuntimeEvent?.("bus", error, {
        phase: "workspace-admission-release",
        operationKind,
      });
    },
  });
}

export function createBaleBusFollowerPromotionHandler<
  TContext extends { cwd: string },
>(input: {
  topicTargetStore: Threads.BaleTopicTargetStore;
  instanceId: string;
  getActiveProfileName: () => string | undefined;
  getSessionId?: (ctx: TContext) => string | undefined;
  startLeader: (
    ctx: TContext,
    election: BaleBusFollowerElection,
    onAcquired: () => Promise<void>,
  ) => Promise<boolean>;
  recordRuntimeEvent: (
    category: string,
    error: unknown,
    details?: Record<string, unknown>,
  ) => void;
  getNowMs?: () => number;
  getPid?: () => number;
  getWorkspaceAdmission?: BaleBusFollowerWorkspaceAdmissionDeps["getWorkspaceAdmission"];
}): BaleBusFollowerPromotionHandler<TContext> {
  return (ctx, binding, election) =>
    runBaleBusFollowerWorkspaceMutation(
      input,
      "workspace.promote-follower",
      async () => {
        let promotedRecord: Threads.BaleTopicTargetRecord | undefined;
        const promoted = await input.startLeader(ctx, election, async () => {
          promotedRecord = await Threads.promoteBaleFollowerBindingToLeader(
            {
              store: input.topicTargetStore,
              instanceId: input.instanceId,
              cwd: ctx.cwd,
              sessionId: input.getSessionId?.(ctx),
              baleProfile: input.getActiveProfileName(),
              target: binding.target,
              slot: binding.slot,
              threadName: binding.threadName,
            },
          );
          if (!promotedRecord && typeof binding.target?.threadId === "number") {
            throw new Error(
              "Bale follower promotion slot authority is unavailable.",
            );
          }
          if (promotedRecord) {
            input.recordRuntimeEvent(
              "bus",
              "Follower thread binding promoted to leader",
              {
                phase: "follower-promoted-binding",
                chatId: promotedRecord.target.chatId,
                threadId: promotedRecord.target.threadId,
                slot: promotedRecord.slot,
                threadName: promotedRecord.threadName,
              },
            );
          }
        });
        if (
          promoted &&
          promotedRecord &&
          typeof binding.target?.threadId === "number"
        ) {
          const profileKey = Threads.getBaleThreadOwnerKey({
            kind: "leader",
            cwd: ctx.cwd,
            instanceId: input.instanceId,
            baleProfile: input.getActiveProfileName(),
          });
          Threads.setBaleLeaderSessionHandoff({
            pid: input.getPid?.() ?? process.pid,
            instanceId: input.instanceId,
            createdAtMs: input.getNowMs?.() ?? Date.now(),
            profileKey,
            target: {
              chatId: binding.target.chatId,
              threadId: binding.target.threadId,
            },
            slot: promotedRecord.slot,
            threadName: promotedRecord.threadName,
          });
          input.recordRuntimeEvent(
            "bus",
            "Promoted leader binding retained for session replacement",
            {
              phase: "follower-promoted-session-handoff",
              chatId: binding.target.chatId,
              threadId: binding.target.threadId,
              slot: promotedRecord.slot,
              threadName: promotedRecord.threadName,
            },
          );
        }
        return promoted;
      },
    );
}

export type BaleBusFollowerLeaderState =
  | { kind: "inactive" }
  | { kind: "active-here"; lock: BaleBusFollowerLeaderLock }
  | { kind: "active-elsewhere"; lock: BaleBusFollowerLeaderLock }
  | { kind: "stale"; lock: BaleBusFollowerLeaderLock };

export type BaleBusFollowerLeaderLock = BaleLockEntry;

export interface BaleBusFollowerPromotedBinding {
  target?: BaleTarget;
  slot?: string;
  threadName?: string;
}

export interface BaleBusFollowerHeartbeatRecoveryHandlerDeps<TContext> {
  registrationState: Pick<
    BaleBusFollowerRegistrationState,
    | "getTarget"
    | "getSlot"
    | "getThreadName"
    | "getEligibleElectionSlots"
    | "beginRecovery"
    | "setRegistered"
  >;
  getRegistrationRuntime: () => BaleBusFollowerRegistrationRuntime<TContext>;
  getLeaderState: () => BaleBusFollowerLeaderState;
  setLifecyclePhase: (phase: "electing" | undefined) => void;
  updateStatus: (ctx: TContext) => void;
  promoteToLeader: (
    ctx: TContext,
    binding: BaleBusFollowerPromotedBinding,
    election: BaleBusFollowerElection,
  ) => Promise<boolean>;
  sleep?: (ms: number) => Promise<void>;
  scheduleRetry?: (retry: () => void, delayMs: number) => void;
  getActiveContext?: () => TContext | undefined;
  promotionGraceMs?: number;
  /** Bus liveness proof for a live-PID leader that no longer answers; replaces the retired file heartbeat. */
  proveLeaderUnresponsive?: (owner: BaleLockEntry) => Promise<boolean>;
  /** Shared bot state says Threaded Mode is off: followers cannot exist, so recovery goes offline instead. */
  isThreadModeDisabled?: () => boolean | Promise<boolean>;
  recordRuntimeEvent: (
    category: string,
    error: unknown,
    details?: Record<string, unknown>,
  ) => void;
}

export interface BaleBusForwardedUpdateReceiverRuntimeDeps<TContext> {
  socketPath: BaleBusSocketPathSource;
  instanceId: string;
  getAuthSecret?: () => string | undefined;
  getRegistrationGeneration: () => string | undefined;
  getRecipientBindingKey: () => string | undefined;
  /** Live preparation names the current journal, not the stable forwarding/profile identity. */
  getLiveRebindJournalBindingKey?: () => string | undefined;
  durableAdmission: BaleBusFollowerDurableAdmissionPort<TContext>;
  sourceReferenceAdmission?: BaleBusFollowerDurableAdmissionPort<TContext>;
  isSourceReferenceAdmissionEnabled?: () => boolean;
  hasAuthenticatedSourceReferenceTransport?: () => boolean;
  getContext: () => TContext | undefined;
  handleInputCustodyHandoff?: (
    envelope: Extract<
      BaleBusEnvelope,
      { kind: "leader.offerInputCustodyHandoff" }
    >,
    ctx: TContext,
  ) => Promise<unknown> | unknown;
  handleQueueHandoff?: (
    envelope: Extract<
      BaleBusEnvelope,
      { kind: "leader.offerQueueHandoff" }
    >,
    ctx: TContext,
  ) =>
    Promise<BaleQueueHandoffStageResult> | BaleQueueHandoffStageResult;
  getSessionId?: () => string | undefined;
  getLeaderProtocol?: () => BaleBusProtocolIdentity | undefined;
  getLocalProtocol?: () => BaleBusProtocolIdentity | undefined;
  isLiveRebindSaveEnabled?: () => boolean;
  isLiveRebindApplyEnabled?: () => boolean;
  isLiveRebindSettleEnabled?: () => boolean;
  handleLiveRebindSettle?: (
    envelope: Extract<BaleBusEnvelope, { kind: "leader.settleLiveRebind" }>,
    ctx: TContext,
    isCurrent: () => boolean,
  ) => Promise<
    | BaleBusLiveRebindSettlementObservation
    | BaleBusLiveRebindWorkObservation
    | BaleBusLiveRebindCommandObservation
  >;
  handleLiveRebindApply?: (
    envelope: Extract<BaleBusEnvelope, { kind: "leader.applyLiveRebind" }>,
    ctx: TContext,
    isCurrent: () => boolean,
  ) => Promise<BaleBusLiveRebindApplyObservation>;
  /** Availability only; never future recipient activation or a command execution grant. */
  isLiveRebindCommandSetEnabled?: () => boolean;
  handleLiveRebindSave?: (
    envelope: Extract<
      BaleBusEnvelope,
      { kind: "leader.prepareLiveRebind" }
    >,
    ctx: TContext,
    isCurrent: () => boolean,
  ) =>
    | BaleBusLiveRebindSaveObservation
    | Promise<BaleBusLiveRebindSaveObservation>;
  isWorkspaceRestoreEnabled?: () => boolean;
  handleWorkspaceRestore?: (
    input: {
      operationId: string;
      registrationGeneration: string;
      mode: "apply" | "inspect";
    },
    ctx: TContext,
  ) => Promise<BaleBusWorkspaceRestoreObservation>;
  recordRuntimeEvent?: (
    category: string,
    error: unknown,
    details?: Record<string, unknown>,
  ) => void;
}

export interface BaleBusFollowerRuntimeAssembly<TContext> {
  receiver: BaleBusForwardedUpdateReceiverRuntime;
  registration: BaleBusFollowerRegistrationRuntime<TContext>;
  getReadySessionId: () => string | undefined;
}

export interface BaleBusFollowerRuntimeAssemblyPorts<
  TContext extends { cwd?: string },
> {
  instanceId: string;
  /** Collapses one sustained heartbeat failure run; the composition root supplies the logging domain's owner. */
  failureLog: BaleFailureRunLogPort;
  registrationState: BaleBusFollowerRegistrationState;
  recordRuntimeEvent: (
    category: string,
    error: unknown,
    details?: Record<string, unknown>,
  ) => void;
  receiver: Omit<
    BaleBusForwardedUpdateReceiverRuntimeDeps<TContext>,
    "instanceId" | "recordRuntimeEvent" | "getRegistrationGeneration"
  >;
  recovery: Omit<
    BaleBusFollowerHeartbeatRecoveryHandlerDeps<TContext>,
    "getRegistrationRuntime" | "registrationState" | "recordRuntimeEvent"
  >;
  registration: Omit<
    BaleBusFollowerRegistrationRuntimeDeps<TContext>,
    | "startReceiving"
    | "stopReceiving"
    | "onHeartbeatFailure"
    | "instanceId"
    | "registrationState"
    | "recordRuntimeEvent"
    | "protocolIdentity"
  > & {
    protocolIdentity: BaleBusProtocolIdentity;
  };
}

export function createBaleBusFollowerRuntimeAssembly<
  TContext extends { cwd?: string },
>(
  ports: BaleBusFollowerRuntimeAssemblyPorts<TContext>,
): BaleBusFollowerRuntimeAssembly<TContext> {
  // Binding startup needs registration identity before it can grant inbound authority.
  let readyContext:
    | {
        generation: string;
        ctx: TContext;
        sessionGeneration: number | undefined;
        sessionId: string | undefined;
      }
    | undefined;
  const isReadyContext = (): boolean =>
    Boolean(
      readyContext &&
      ports.receiver.getContext() === readyContext.ctx &&
      ports.registrationState.getGeneration() === readyContext.generation &&
      ports.registration.getSessionGeneration?.() ===
        readyContext.sessionGeneration &&
      ports.registration.getSessionId?.(readyContext.ctx) ===
        readyContext.sessionId &&
      ports.registration.isContextActive?.(readyContext.ctx) !== false,
    );
  const prepareContext = async (ctx: TContext): Promise<void> => {
    const generation = ports.registrationState.getGeneration();
    const sessionGeneration = ports.registration.getSessionGeneration?.();
    const sessionId = ports.registration.getSessionId?.(ctx);
    const executionContext = ports.receiver.getContext();
    readyContext = undefined;
    if (
      !generation ||
      executionContext === undefined ||
      ports.registration.isContextActive?.(ctx) === false ||
      ports.registration.isContextActive?.(executionContext) === false ||
      ports.registration.getSessionId?.(executionContext) !== sessionId ||
      (executionContext !== ctx &&
        (sessionId === undefined ||
          !ports.registration.isContextActive ||
          !ports.registration.getSessionGeneration)) ||
      (sessionId !== undefined &&
        ports.registrationState.getSessionId(sessionId) !== sessionId)
    )
      throw new Error(
        "Bale follower session change requires acknowledged leader registration and a current canonical context.",
      );
    // Connect has a command context; inbound work uses the session's canonical object.
    await ports.registration.onRegistered?.(executionContext);
    if (
      generation &&
      ports.registrationState.getGeneration() === generation &&
      ports.registration.getSessionGeneration?.() === sessionGeneration &&
      ports.receiver.getContext() === executionContext &&
      ports.registration.getSessionId?.(ctx) === sessionId &&
      ports.registration.getSessionId?.(executionContext) === sessionId &&
      ports.registration.isContextActive?.(ctx) !== false &&
      ports.registration.isContextActive?.(executionContext) !== false
    )
      readyContext = {
        generation,
        ctx: executionContext,
        sessionGeneration,
        sessionId,
      };
  };
  const sharedRuntimeDeps = {
    instanceId: ports.instanceId,
    registrationState: ports.registrationState,
    recordRuntimeEvent: ports.recordRuntimeEvent,
  };
  const receiver = createBaleBusForwardedUpdateReceiverRuntime({
    ...ports.receiver,
    instanceId: ports.instanceId,
    recordRuntimeEvent: ports.recordRuntimeEvent,
    getRegistrationGeneration() {
      return isReadyContext() ? readyContext?.generation : undefined;
    },
  });
  let registration: BaleBusFollowerRegistrationRuntime<TContext>;
  const recovery = createBaleBusFollowerHeartbeatRecoveryHandler({
    ...ports.recovery,
    registrationState: ports.registrationState,
    recordRuntimeEvent: ports.recordRuntimeEvent,
    getRegistrationRuntime: () => baseRegistration,
  });
  registration = createBaleBusFollowerRegistrationRuntime({
    ...ports.registration,
    failureLog: ports.failureLog,
    ...sharedRuntimeDeps,
    startReceiving: receiver.start,
    stopReceiving: receiver.stop,
    onRegistered: prepareContext,
    onHeartbeatFailure: recovery,
  });
  const baseRegistration = registration;
  registration = {
    ...baseRegistration,
    // Public stop is deliberate (disconnect, suspension); recovery keeps the base stop for promotion.
    stop() {
      recovery.halt();
      baseRegistration.stop();
    },
    registerWithLeader(ctx, leader, options) {
      recovery.resume();
      return baseRegistration.registerWithLeader(ctx, leader, options);
    },
    async setContext(ctx) {
      const sessionGeneration = ports.registration.getSessionGeneration?.();
      if (ports.registration.isContextActive?.(ctx) === false) return;
      await baseRegistration.setContext(ctx);
      if (
        ports.registration.getSessionGeneration?.() !== sessionGeneration ||
        ports.registration.isContextActive?.(ctx) === false
      )
        return;
      if (!isReadyContext()) await prepareContext(ctx);
    },
  };
  return {
    receiver,
    registration,
    getReadySessionId: () =>
      isReadyContext() ? readyContext?.sessionId : undefined,
  };
}

export interface BaleBusFollowerRestoreContext {
  executor: BaleWorkspaceRestoreExecutor;
  profileBindingKey: string;
  operatorUserId: number;
  cwd: string;
  sessionId: string;
  generation: string | number;
  leaderProtocol?: BaleBusProtocolIdentity;
}

/** Binds Restore to real Pi lifetime and the current authenticated transport owner, not request fields. */
export function createBaleBusFollowerRestoreContextGetter<TContext>(deps: {
  isContextCurrent: (ctx: TContext) => boolean;
  getSessionId: (ctx: TContext) => string | undefined;
  getCwd: (ctx: TContext) => string | undefined;
  getGeneration: () => number;
  getProfileBindingKey: () => string | undefined;
  getOperatorUserId: () => number | undefined;
  getLeaderState: () => BaleLockState;
  getAuthenticatedSecret: () => string | undefined;
  getLeaderProtocol: () => BaleBusProtocolIdentity | undefined;
  capability?:
    | typeof BALE_BUS_CAPABILITY_WORKSPACE_RESTORE
    | typeof BALE_BUS_CAPABILITY_LIVE_REBIND_APPLY
    | typeof BALE_BUS_CAPABILITY_SELECTED_MENU_DELIVERY;
}) {
  return (ctx: TContext): BaleBusFollowerRestoreContext | undefined => {
    if (!deps.isContextCurrent(ctx)) return undefined;
    const leader = deps.getLeaderState();
    const secret = deps.getAuthenticatedSecret();
    const leaderProtocol = deps.getLeaderProtocol();
    if (
      !leaderProtocol ||
      !hasBaleBusCapability(
        leaderProtocol,
        deps.capability ?? BALE_BUS_CAPABILITY_WORKSPACE_RESTORE,
      )
    )
      return undefined;
    if (
      leader.kind !== "active-elsewhere" ||
      !secret ||
      leader.lock.busSecret !== secret ||
      !leader.lock.instanceId ||
      leader.lock.leaderEpoch === undefined
    )
      return undefined;
    const profileBindingKey = deps.getProfileBindingKey();
    const operatorUserId = deps.getOperatorUserId();
    const sessionId = deps.getSessionId(ctx);
    const cwd = deps.getCwd(ctx);
    const generation = deps.getGeneration();
    if (
      !profileBindingKey ||
      !sessionId ||
      !cwd ||
      typeof operatorUserId !== "number" ||
      !Number.isSafeInteger(operatorUserId) ||
      operatorUserId <= 0 ||
      !Number.isSafeInteger(generation) ||
      generation < 0 ||
      !deps.isContextCurrent(ctx)
    )
      return undefined;
    return {
      executor: {
        instanceId: leader.lock.instanceId,
        leaderEpoch: String(leader.lock.leaderEpoch),
      },
      profileBindingKey,
      operatorUserId,
      sessionId,
      cwd,
      generation,
      leaderProtocol: structuredClone(leaderProtocol),
    };
  };
}

/** Shared canonical/local target owner and scoped live-carrier hooks; caller authenticates transport, no canonical writes or cleanup. */
export function createBaleBusFollowerWorkspaceRestoreHandler<
  TContext,
>(deps: {
  instanceId: string;
  /** Captures actual Pi lifetime and authenticated leader/profile authority, never request-derived values. */
  getContextAuthority: (
    ctx: TContext,
  ) => BaleBusFollowerRestoreContext | undefined;
  readRestoreIntent: (
    operationId: string,
    profileBindingKey: string,
  ) => BaleWorkspaceRestoreIntent | undefined;
  readLiveRebindIntent?: (
    operationId: string,
    profileBindingKey: string,
  ) => Threads.BaleWorkspaceLiveRebindIntent | undefined;
  topicTargetStore: Pick<
    Threads.BaleTopicTargetStore,
    "load" | "withWorkspaceRestoreSnapshot"
  > &
    Partial<
      Pick<Threads.BaleTopicTargetStore, "withWorkspaceLiveRebindSnapshot">
    >;
  registrationState: Pick<
    BaleBusFollowerRegistrationState,
    | "getTarget"
    | "getSlot"
    | "getGeneration"
    | "setRegistered"
    | "getLeaderProtocol"
  >;
  getWorkspaceAdmission: NonNullable<
    BaleBusFollowerWorkspaceAdmissionDeps["getWorkspaceAdmission"]
  >;
  recordRuntimeEvent?: BaleBusFollowerWorkspaceAdmissionDeps["recordRuntimeEvent"];
}) {
  const handler = async (
    input: {
      operationId: string;
      registrationGeneration: string;
      mode: "apply" | "inspect";
      liveRebind?: {
        sourceUpdateIds: readonly number[];
        isCurrent(): boolean;
        /** Captured prepared-branch target; equality must precede local apply or release grants. */
        expectedTarget?: BaleTarget & { threadId: number };
        release?: (canRelease: () => boolean, target: BaleTarget & { threadId: number }) => void;
        observeWork?: (
          oldTarget: BaleTarget & { threadId: number },
        ) => void;
      };
    },
    ctx: TContext,
  ) => {
    const scope = input.liveRebind,
      ports = scope && {
        isCurrent: scope.isCurrent,
        release: scope.release,
        observeWork: scope.observeWork,
      };
    const suppliedTarget = scope?.expectedTarget,
      expectedTarget = suppliedTarget && { ...suppliedTarget };
    const sourceUpdateIds =
      scope && [...scope.sourceUpdateIds].sort((a, b) => a - b);
    const liveCurrent = scope && ports!.isCurrent.bind(scope),
      release = scope && ports!.release?.bind(scope),
      workObserver = scope && ports!.observeWork?.bind(scope);
    const captured = deps.getContextAuthority(ctx);
    if (!captured) throw new Error("Stale Bale follower Restore context.");
    const snapshotStore = deps.topicTargetStore,
      liveSnapshot = snapshotStore.withWorkspaceLiveRebindSnapshot,
      restoreSnapshot = snapshotStore.withWorkspaceRestoreSnapshot;
    const authority = structuredClone(captured);
    const request = structuredClone({
      operationId: input.operationId,
      registrationGeneration: input.registrationGeneration,
      mode: input.mode,
    });
    const readIntent = () =>
      liveCurrent
        ? deps.readLiveRebindIntent?.(
            request.operationId,
            authority.profileBindingKey,
          )
        : deps.readRestoreIntent(
            request.operationId,
            authority.profileBindingKey,
          );
    let sampleWork: (() => void) | undefined;
    if (suppliedTarget !== undefined && !expectedTarget)
      throw new Error("Invalid prepared live-rebind target.");
    if (
      expectedTarget &&
      (!Number.isSafeInteger(expectedTarget.chatId) ||
        expectedTarget.chatId !== authority.operatorUserId ||
        !Number.isSafeInteger(expectedTarget.threadId) ||
        expectedTarget.threadId <= 0)
    )
      throw new Error("Invalid prepared live-rebind target.");
    if (
      (release || workObserver) &&
      !hasBaleBusCapability(
        authority.leaderProtocol,
        BALE_BUS_CAPABILITY_LIVE_REBIND_SETTLE,
      )
    )
      throw new Error("Live-rebind settlement capability is unavailable.");
    if (
      liveCurrent &&
      !hasBaleBusCapability(
        authority.leaderProtocol,
        BALE_BUS_CAPABILITY_LIVE_REBIND_APPLY,
      )
    )
      throw new Error("Live-rebind apply capability is unavailable.");
    if (
      !authority.profileBindingKey ||
      !authority.sessionId ||
      !authority.cwd ||
      !authority.executor?.instanceId ||
      !authority.executor.leaderEpoch ||
      !(typeof authority.generation === "string"
        ? authority.generation.length > 0
        : Number.isSafeInteger(authority.generation) &&
          authority.generation >= 0) ||
      !Number.isSafeInteger(authority.operatorUserId) ||
      authority.operatorUserId <= 0 ||
      !request.operationId ||
      !request.registrationGeneration ||
      !["apply", "inspect"].includes(request.mode)
    )
      throw new Error("Invalid Bale follower Restore authority.");
    const assertCurrent = (): void => {
      if (
        !isDeepStrictEqual(deps.getContextAuthority(ctx), authority) ||
        deps.topicTargetStore !== snapshotStore ||
        (liveCurrent
          ? snapshotStore.withWorkspaceLiveRebindSnapshot !== liveSnapshot
          : snapshotStore.withWorkspaceRestoreSnapshot !== restoreSnapshot) ||
        liveCurrent?.() === false ||
        (scope &&
          (input.liveRebind !== scope ||
            Object.entries(ports!).some(
              ([key, value]) => Reflect.get(scope, key) !== value,
            ))) ||
        deps.registrationState.getGeneration() !==
          request.registrationGeneration
      )
        throw new Error("Stale Bale follower Restore authority.");
    };
    assertCurrent();
    if (!deps.getWorkspaceAdmission)
      throw new Error("Bale Workspace admission authority is unavailable.");
    const result = await runBaleBusFollowerWorkspaceMutation(
      deps,
      "workspace.restore-follower-target",
      async () => {
        assertCurrent();
        const intent = readIntent();
        assertCurrent();
        if (
          !intent ||
          intent.request.operationId !== request.operationId ||
          (liveCurrent
            ? !("kind" in intent) ||
              intent.kind !== "live-rebind" ||
              (intent.inputRelease !== undefined && !hasBaleBusCapability(authority.leaderProtocol, BALE_BUS_CAPABILITY_PRE_DISPATCH_REBIND_EXECUTION)) ||
              !isDeepStrictEqual(
                [...intent.request.source.updateIds].sort((a, b) => a - b),
                sourceUpdateIds,
              ) ||
              (request.mode === "apply"
                ? intent.phase !== "rebound"
                : !["rebound", "released", "finished"].includes(intent.phase))
            : "kind" in intent ||
              (intent.phase !== "recipient-issued" &&
                intent.phase !== "ready")) ||
          (expectedTarget &&
            !isDeepStrictEqual(intent.request.target, expectedTarget)) ||
          !isDeepStrictEqual(intent.executor, authority.executor) ||
          intent.operatorUserId !== authority.operatorUserId ||
          !intent.recipient ||
          ((request.mode === "apply" || liveCurrent) &&
            (intent.recipient.kind !== "follower" ||
              intent.recipient.instanceId !== deps.instanceId ||
              intent.recipient.generation !==
                request.registrationGeneration)) ||
          intent.recipient.sessionId !== authority.sessionId ||
          intent.request.binding.sessionId !== authority.sessionId ||
          intent.request.binding.cwd !==
            WorkspaceIdentity.normalizeBaleWorkspacePath(authority.cwd)
        )
          throw new Error(
            "Bale follower Restore intent does not match this recipient.",
          );
        const expected = structuredClone(intent);
        await snapshotStore.load();
        assertCurrent();
        const observe = (
          canonical: Readonly<
            Pick<
              Threads.BaleTopicTargetFile,
              "threads" | "workspaceBindings"
            >
          >,
        ): BaleBusWorkspaceRestoreObservation => {
          if (!isDeepStrictEqual(readIntent(), expected))
            throw new Error("Bale follower Restore intent changed.");
          assertCurrent();
          const { binding, target } = expected.request;
          const bindings = (canonical.workspaceBindings ?? []).filter(
            (value) => value.bindingKey === binding.bindingKey,
          );
          const snapshot = canonical.threads;
          const records = snapshot.filter(
            (value) => value.instanceId === deps.instanceId,
          );
          const owners = snapshot.filter(
            (value) =>
              value.status === "active" &&
              (value.slot === binding.slot ||
                isDeepStrictEqual(value.target, target)),
          );
          if (
            bindings.length !== 1 ||
            records.length !== 1 ||
            owners.length !== 1 ||
            bindings[0]?.cwd !== binding.cwd ||
            bindings[0]?.sessionId !== binding.sessionId ||
            bindings[0]?.slot !== binding.slot ||
            bindings[0]?.inactiveSinceMs !== undefined ||
            !isDeepStrictEqual(bindings[0]?.target, target) ||
            records[0]?.status !== "active" ||
            records[0]?.owner?.kind !== "manual-follower" ||
            records[0]?.slot !== binding.slot ||
            !isDeepStrictEqual(records[0]?.target, target) ||
            deps.registrationState.getSlot() !== binding.slot
          )
            throw new Error(
              "Bale follower Restore canonical binding is not committed.",
            );
          const localTarget = deps.registrationState.getTarget();
          const alreadyReady = isDeepStrictEqual(localTarget, target);
          if (!alreadyReady && !isDeepStrictEqual(localTarget, binding.target))
            throw new Error("Bale follower Restore local target changed.");
          assertCurrent();
          if (!alreadyReady && request.mode === "apply") {
            if (
              expected.phase !== (liveCurrent ? "rebound" : "recipient-issued")
            )
              throw new Error("Bale follower Restore readiness regressed.");
            deps.registrationState.setRegistered(true, target, {
              slot: binding.slot,
              threadName: records[0]?.threadName,
              generation: request.registrationGeneration,
              leaderProtocol: deps.registrationState.getLeaderProtocol(),
            });
          }
          assertCurrent();
          const observedTarget = deps.registrationState.getTarget();
          if (
            !observedTarget ||
            (!isDeepStrictEqual(observedTarget, target) &&
              !isDeepStrictEqual(observedTarget, binding.target))
          )
            throw new Error("Bale follower Restore local target changed.");
          const ready = isDeepStrictEqual(observedTarget, target);
          assertCurrent();
          return {
            operationId: request.operationId,
            recipient: {
              kind: "follower" as const,
              instanceId: deps.instanceId,
              sessionId: authority.sessionId,
              generation: request.registrationGeneration,
            },
            target: {
              chatId: observedTarget.chatId,
              threadId: observedTarget.threadId!,
            },
            slot: binding.slot!,
            ready,
          };
        };
        const withSnapshot = (observer: Parameters<typeof restoreSnapshot>[1]): void => {
          assertCurrent();
          if ("kind" in expected) {
            if (!liveSnapshot)
              throw new Error("Live-rebind read-only Workspace snapshot is unavailable.");
            liveSnapshot.call(snapshotStore, expected, observer);
          } else restoreSnapshot.call(snapshotStore, expected, observer);
          assertCurrent();
        };
        let result: BaleBusWorkspaceRestoreObservation | undefined;
        withSnapshot((snapshot) => {
          result = observe(snapshot);
        });
        if (!result)
          throw new Error(
            "Bale follower Restore observation was not completed.",
          );
        if (release || workObserver) {
          if (
            !("kind" in expected) ||
            expected.kind !== "live-rebind" ||
            (release ? !Threads.isBaleLiveRebindInputAuthorized(expected)
              : !(Threads.isBaleLiveRebindInputAuthorized(expected) || expected.phase === "released" && expected.inputRelease === "held" && !expected.cleanup)) ||
            !result.ready ||
            request.mode !== "inspect"
          )
            throw new Error(
              "Live-rebind dispatch has no canonical released/local-applied grant.",
            );
          // Live barriers reobserve read-only Workspace evidence; journal reads never borrow publication authority.
          if (workObserver)
            sampleWork = () => {
              withSnapshot((snapshot) => {
                if (!observe(snapshot).ready)
                  throw new Error(
                    "Live-rebind work observation lost local target application.",
                  );
                workObserver(expected.request.binding.target);
                assertCurrent();
              });
            };
          release?.(() => {
            assertCurrent();
            let ready = false;
            withSnapshot((snapshot) => {
              ready = observe(snapshot).ready;
            });
            assertCurrent();
            return ready;
          }, { ...expected.request.target });
        }
        return result;
      },
    );
    assertCurrent();
    if (
      !isDeepStrictEqual(deps.registrationState.getTarget(), result.target) ||
      deps.registrationState.getSlot() !== result.slot
    )
      throw new Error(
        "Bale follower Restore local registration changed after admission release.",
      );
    // Work can change while admission releases; sample only after that await under a fresh canonical snapshot.
    sampleWork?.();
    assertCurrent();
    return result;
  };
  return Object.assign(handler, {
    /** Capture availability only; asserting current recipient requires canonical released/local-applied ownership. */
    prepareLiveCommandRecipient(
      input: {
        operationId: string;
        registrationGeneration: string;
        sessionId: string;
        sourceUpdateIds: readonly number[];
        target: BaleTarget & { threadId: number };
      },
      ctx: TContext,
    ):
      | Pick<
          BaleBusFollowerCommandOwner<TContext>,
          "isCurrent" | "assertRecipientCurrent"
        >
      | undefined {
      const expected = structuredClone(input),
        getAuthority = deps.getContextAuthority,
        read = deps.readLiveRebindIntent,
        store = deps.topicTargetStore;
      const snapshot = store.withWorkspaceLiveRebindSnapshot,
        state = deps.registrationState;
      const statePorts = {
        getTarget: state.getTarget,
        getSlot: state.getSlot,
        getGeneration: state.getGeneration,
        getLeaderProtocol: state.getLeaderProtocol,
      };
      const instanceId = deps.instanceId,
        authority = structuredClone(getAuthority.call(deps, ctx)),
        oldTarget = structuredClone(state.getTarget()),
        slot = state.getSlot();
      if (
        !authority ||
        !read ||
        !snapshot ||
        !instanceId ||
        !slot ||
        !expected.operationId?.trim() ||
        !expected.registrationGeneration?.trim() ||
        expected.sessionId !== authority.sessionId ||
        expected.sourceUpdateIds.length !== 1 ||
        !Number.isSafeInteger(expected.sourceUpdateIds[0]) ||
        expected.sourceUpdateIds[0]! < 0 ||
        typeof authority.generation !== "number" ||
        !Number.isSafeInteger(authority.generation) ||
        authority.generation < 0 ||
        !authority.profileBindingKey?.trim() ||
        !authority.cwd?.trim() ||
        !authority.executor?.instanceId?.trim() ||
        !authority.executor.leaderEpoch?.trim() ||
        !Number.isSafeInteger(authority.operatorUserId) ||
        authority.operatorUserId <= 0 ||
        expected.target.chatId !== authority.operatorUserId ||
        !Number.isSafeInteger(expected.target.threadId) ||
        expected.target.threadId <= 0 ||
        !oldTarget ||
        oldTarget.chatId !== expected.target.chatId ||
        !Number.isSafeInteger(oldTarget.threadId) ||
        oldTarget.threadId! <= 0
      )
        return undefined;
      const portsCurrent = () =>
        deps.instanceId === instanceId &&
        deps.getContextAuthority === getAuthority &&
        deps.readLiveRebindIntent === read &&
        deps.topicTargetStore === store &&
        store.withWorkspaceLiveRebindSnapshot === snapshot &&
        deps.registrationState === state &&
        Object.entries(statePorts).every(
          ([key, value]) => Reflect.get(state, key) === value,
        );
      const isCurrent = () => {
        try {
          if (
            !portsCurrent() ||
            !isDeepStrictEqual(getAuthority.call(deps, ctx), authority) ||
            state.getGeneration() !== expected.registrationGeneration ||
            state.getSlot() !== slot ||
            !isDeepStrictEqual(
              state.getLeaderProtocol(),
              authority.leaderProtocol,
            ) ||
            ![
              ...BALE_BUS_LIVE_REBIND_CAPABILITIES,
              ...BALE_BUS_HELD_COMMAND_CAPABILITIES,
            ].every((cap) =>
              hasBaleBusCapability(authority.leaderProtocol, cap),
            ) ||
            ![oldTarget, expected.target].some((target) =>
              isDeepStrictEqual(state.getTarget(), target),
            )
          )
            return false;
          return (
            portsCurrent() &&
            isDeepStrictEqual(getAuthority.call(deps, ctx), authority) &&
            state.getGeneration() === expected.registrationGeneration &&
            state.getSlot() === slot &&
            isDeepStrictEqual(
              state.getLeaderProtocol(),
              authority.leaderProtocol,
            ) &&
            [oldTarget, expected.target].some((target) =>
              isDeepStrictEqual(state.getTarget(), target),
            ) &&
            portsCurrent()
          );
        } catch {
          return false;
        }
      };
      if (!isCurrent()) return undefined;
      return {
        isCurrent,
        assertRecipientCurrent() {
          if (!isCurrent())
            throw new Error("Selected command recipient authority changed.");
          const value = read.call(
            deps,
            expected.operationId,
            authority.profileBindingKey,
          );
          if (
            !value ||
            value.kind !== "live-rebind" ||
            !Threads.isBaleLiveRebindInputAuthorized(value) ||
            value.request.operationId !== expected.operationId ||
            value.recipient.kind !== "follower" ||
            value.recipient.instanceId !== instanceId ||
            value.recipient.sessionId !== expected.sessionId ||
            value.recipient.generation !== expected.registrationGeneration ||
            !isDeepStrictEqual(value.executor, authority.executor) ||
            value.operatorUserId !== authority.operatorUserId ||
            !isDeepStrictEqual(
              value.request.source.updateIds,
              expected.sourceUpdateIds,
            ) ||
            !isDeepStrictEqual(value.request.target, expected.target) ||
            !isDeepStrictEqual(value.request.binding.target, oldTarget) ||
            value.request.owner.instanceId !== instanceId ||
            value.request.owner.owner?.kind !== "manual-follower" ||
            value.request.owner.slot !== slot ||
            !isDeepStrictEqual(value.request.owner.target, oldTarget) ||
            value.request.binding.cwd !==
              WorkspaceIdentity.normalizeBaleWorkspacePath(authority.cwd) ||
            value.request.binding.sessionId !== expected.sessionId ||
            value.request.binding.slot !== slot ||
            !isCurrent()
          )
            throw new Error(
              "Selected command recipient has no exact released intent.",
            );
          const intent = structuredClone(value);
          let confirmed = false;
          snapshot.call(store, intent, (canonical) => {
            if (
              !isCurrent() ||
              !isDeepStrictEqual(
                read.call(
                  deps,
                  expected.operationId,
                  authority.profileBindingKey,
                ),
                intent,
              )
            )
              return;
            const bindings = (canonical.workspaceBindings ?? []).filter(
              (row) => row.bindingKey === intent.request.binding.bindingKey,
            );
            const owners = canonical.threads.filter(
              (row) =>
                row.status === "active" &&
                (row.slot === slot ||
                  isDeepStrictEqual(row.target, expected.target)),
            );
            const row = bindings[0],
              owner = owners[0];
            confirmed =
              bindings.length === 1 &&
              row?.sessionId === expected.sessionId &&
              row.cwd === intent.request.binding.cwd &&
              row.slot === slot &&
              row.workspaceKey === intent.request.binding.workspaceKey &&
              row.inactiveSinceMs === undefined &&
              isDeepStrictEqual(row.target, expected.target) &&
              owners.length === 1 &&
              owner?.instanceId === instanceId &&
              owner.owner?.kind === "manual-follower" &&
              owner.slot === slot &&
              owner.profileKey === intent.request.owner.profileKey &&
              isDeepStrictEqual(owner.owner, intent.request.owner.owner) &&
              isDeepStrictEqual(owner.target, expected.target) &&
              isDeepStrictEqual(state.getTarget(), expected.target) &&
              isCurrent() &&
              isDeepStrictEqual(
                read.call(
                  deps,
                  expected.operationId,
                  authority.profileBindingKey,
                ),
                intent,
              );
          });
          if (!confirmed || !isCurrent())
            throw new Error(
              "Selected command canonical/local recipient changed.",
            );
        },
      };
    },
  });
}

export function createBaleBusFollowerClientRuntime<
  TContext,
  TReactionUpdate,
  TCallbackQuery,
  TMessage = unknown,
>(deps: BaleBusFollowerClientRuntimeDeps<TMessage>) {
  const createRequestId = createBaleBusRequestIdFactory(deps.instanceId);
  const timeoutMs = deps.timeoutMs ?? BALE_BUS_FOLLOWER_CLIENT_TIMEOUT_MS;
  const sharedClientDeps = {
    socketPath: deps.socketPath,
    createRequestId,
    timeoutMs,
    waitForRegistrationGeneration: deps.waitForRegistrationGeneration,
  };
  return {
    createRequestId,
    callApi: createBaleBusFollowerApiCaller({
      ...sharedClientDeps,
      instanceId: deps.instanceId,
      getAuthSecret: deps.getApiAuthSecret,
      getRegistrationGeneration: deps.getRegistrationGeneration,
      recordRuntimeEvent: deps.recordRuntimeEvent,
    }),
    agentMessages: createBaleBusAgentMessageClient({
      ...sharedClientDeps,
      instanceId: deps.instanceId,
      getAuthSecret: deps.getApiAuthSecret,
      getRegistrationGeneration: deps.getRegistrationGeneration,
    }),
    foreignOwnedUpdateForwarder: createBaleBusForeignOwnedUpdateForwarder<
      TContext,
      TReactionUpdate,
      TCallbackQuery,
      TMessage
    >({
      ...sharedClientDeps,
      getAuthSecret: deps.getForwardingAuthSecret,
      getForwardCommentBatchPosition: deps.getForwardCommentBatchPosition,
      validateForwardOwnership: deps.validateForwardOwnership,
      recordRuntimeEvent: deps.recordRuntimeEvent,
    }),
    queueHandoff: createBaleBusFollowerQueueHandoffClient({
      ...sharedClientDeps,
      instanceId: deps.instanceId,
      getAuthSecret: deps.getApiAuthSecret,
      getRegistrationGeneration: deps.getRegistrationGeneration,
    }),
  };
}

export function createBaleBusFollowerQueueHandoffClient(
  deps: BaleBusFollowerApiCallerDeps,
): (
  input: BaleBusFollowerQueueHandoffOffer,
) => Promise<BaleQueueHandoffStageResult> {
  const getNowMs = deps.getNowMs ?? Date.now;
  const timeoutMs = deps.timeoutMs ?? BALE_BUS_FOLLOWER_CLIENT_TIMEOUT_MS;
  return async (input) => {
    const registration = await resolveBaleBusFollowerRegistration(
      deps,
      timeoutMs,
    );
    const socketPath = resolveBaleBusSocketPath(deps.socketPath);
    const response = await sendBaleBusOperation(
      socketPath,
      registration.remainingTimeoutMs,
      {
        kind: "follower.offerQueueHandoff",
        requestId: deps.createRequestId(),
        auth: deps.getAuthSecret?.(),
        instanceId: deps.instanceId,
        registrationGeneration: registration.generation,
        ...input,
        sentAtMs: getNowMs(),
      },
    );
    const queueOwner =
      response?.kind === "bus.ack" && isRecord(response.result)
        ? parseBaleUpdateJournalQueueOwner(response.result.queueOwner)
        : undefined;
    if (
      response?.kind === "bus.ack" &&
      response.ok &&
      isRecord(response.result) &&
      response.result.status === "staged" &&
      typeof response.result.receiptId === "string" &&
      Array.isArray(response.result.sourceUpdateIds) &&
      response.result.sourceUpdateIds.every(Number.isSafeInteger) &&
      input.payload.admissionReceipts.length === 1 &&
      response.result.receiptId ===
        input.payload.admissionReceipts[0]?.receiptId &&
      response.result.sourceUpdateIds.length ===
        input.payload.admissionReceipts[0].sourceUpdateIds.length &&
      response.result.sourceUpdateIds.every(
        (updateId, index) =>
          updateId ===
          input.payload.admissionReceipts[0]!.sourceUpdateIds[index],
      ) &&
      queueOwner
    ) {
      return {
        status: "staged",
        receiptId: response.result.receiptId,
        sourceUpdateIds: response.result.sourceUpdateIds as number[],
        queueOwner,
      };
    }
    throw new Error(
      response?.kind === "bus.ack"
        ? (response.message ?? "Bale queue handoff was rejected.")
        : "Bale queue handoff did not return an acknowledgement.",
    );
  };
}

function createBaleBusAgentMessageClient(
  deps: BaleBusFollowerApiCallerDeps,
): {
  resolveTarget: (
    selector: BaleBusAgentTargetSelector,
  ) => Promise<BaleTarget & { threadId: number }>;
  routeMessage: (message: BaleBusAgentMessage) => Promise<void>;
} {
  const getNowMs = deps.getNowMs ?? Date.now;
  const timeoutMs = deps.timeoutMs ?? BALE_BUS_FOLLOWER_CLIENT_TIMEOUT_MS;
  const request = async (
    envelope:
      | Extract<BaleBusEnvelope, { kind: "follower.resolveAgentTarget" }>
      | Extract<BaleBusEnvelope, { kind: "follower.routeAgentMessage" }>,
    requestTimeoutMs = timeoutMs,
  ): Promise<unknown> => {
    const socketPath = resolveBaleBusSocketPath(deps.socketPath);
    const response = await sendBaleBusOperation(
      socketPath,
      requestTimeoutMs,
      envelope,
    );
    if (response?.kind === "bus.ack" && response.ok) return response.result;
    throw new Error(
      response?.kind === "bus.ack"
        ? (response.message ?? "Bale bus agent message failed.")
        : "Bale bus agent message did not return an acknowledgement.",
    );
  };
  const registrationFields = async () => {
    const registration = await resolveBaleBusFollowerRegistration(
      deps,
      timeoutMs,
    );
    return {
      fields: {
        auth: deps.getAuthSecret?.(),
        instanceId: deps.instanceId,
        registrationGeneration: registration.generation,
      },
      remainingTimeoutMs: registration.remainingTimeoutMs,
    };
  };
  return {
    async resolveTarget(selector) {
      const registration = await registrationFields();
      const result = await request(
        {
          kind: "follower.resolveAgentTarget",
          requestId: deps.createRequestId(),
          ...registration.fields,
          selector,
          sentAtMs: getNowMs(),
        },
        registration.remainingTimeoutMs,
      );
      if (!result || typeof result !== "object" || Array.isArray(result)) {
        throw new Error("Bale bus returned an invalid agent target.");
      }
      const target = result as Record<string, unknown>;
      if (
        typeof target.chatId !== "number" ||
        typeof target.threadId !== "number"
      ) {
        throw new Error("Bale bus returned an invalid agent target.");
      }
      return { chatId: target.chatId, threadId: target.threadId };
    },
    async routeMessage(message) {
      const registration = await registrationFields();
      await request(
        {
          kind: "follower.routeAgentMessage",
          requestId: deps.createRequestId(),
          ...registration.fields,
          message,
          sentAtMs: getNowMs(),
        },
        registration.remainingTimeoutMs,
      );
    },
  };
}

/** Private selected text-effect caller; not a guarded ordinary API adapter or follower command admission grant. */
export function createBaleBusFollowerSelectedMenuCaller<TContext>(deps: {
  client: BaleBusFollowerApiCallerDeps;
  protocolIdentity: BaleBusProtocolIdentity;
  recipient: {
    getContextAuthority(
      ctx: TContext,
    ): BaleBusFollowerRestoreContext | undefined;
    getJournalBindingKey(ctx: TContext): string | undefined;
    getProcessIdentity(): { processId: number; processBirthId: string };
    registrationState: Pick<
      BaleBusFollowerRegistrationState,
      "getTarget" | "getSlot" | "getGeneration" | "getLeaderProtocol"
    >;
  };
}) {
  return async (input: {
    ctx: TContext;
    operationId: string;
    registrationGeneration: string;
    effect: BaleBusSelectedMenuTextEffect;
    assertAuthority: () => void;
  }): Promise<BaleBusSelectedMenuDeliveryObservation> => {
    let dispatched = false,
      method = "sendMessage";
    try {
      const client = { ...deps.client },
        recipient = deps.recipient,
        ctx = input.ctx,
        assertAuthority = input.assertAuthority;
      const getAuthority = recipient.getContextAuthority,
        getJournal = recipient.getJournalBindingKey,
        getProcess = recipient.getProcessIdentity;
      const state = recipient.registrationState,
        statePorts = {
          getTarget: state.getTarget,
          getSlot: state.getSlot,
          getGeneration: state.getGeneration,
          getLeaderProtocol: state.getLeaderProtocol,
        };
      const authority = structuredClone(getAuthority.call(recipient, ctx));
      const journalBindingKey = getJournal.call(recipient, ctx),
        process = structuredClone(getProcess.call(recipient)),
        target = structuredClone(state.getTarget()),
        slot = state.getSlot();
      const protocol = structuredClone(deps.protocolIdentity),
        leaderProtocol = structuredClone(state.getLeaderProtocol()),
        auth = client.getAuthSecret?.();
      const endpoint = resolveBaleBusSocketPath(client.socketPath),
        timeoutMs = client.timeoutMs ?? BALE_BUS_FOLLOWER_CLIENT_TIMEOUT_MS;
      if (
        !authority ||
        typeof authority.generation !== "number" ||
        typeof assertAuthority !== "function" ||
        !slot ||
        !auth ||
        !Number.isFinite(timeoutMs) ||
        timeoutMs <= 0
      )
        throw new Error("Selected-menu local owner is unavailable.");
      const decoded = parseBaleBusEnvelope(
        JSON.stringify({
          kind: "follower.deliverSelectedMenu",
          requestId: client.createRequestId(),
          auth,
          instanceId: client.instanceId,
          operationId: input.operationId,
          registrationGeneration: input.registrationGeneration,
          recipient: {
            sessionId: authority.sessionId,
            sessionGeneration: authority.generation,
            ...process,
            profileKey: authority.profileBindingKey,
            journalBindingKey,
            target,
          },
          executor: authority.executor,
          operatorUserId: authority.operatorUserId,
          effect: structuredClone(input.effect),
          sentAtMs: (client.getNowMs ?? Date.now)(),
        }),
      );
      if (decoded?.kind !== "follower.deliverSelectedMenu")
        throw new Error("Selected-menu local description is invalid.");
      const expected = decoded;
      method =
        expected.effect.kind === "send-text"
          ? "sendMessage"
          : "editMessageText";
      const assertCurrent = (allowPending = false) => {
        assertAuthority();
        const local = getAuthority.call(recipient, ctx),
          currentGeneration = client.getRegistrationGeneration();
        if (
          !isDeepStrictEqual(deps.client, client) ||
          deps.recipient !== recipient ||
          recipient.getContextAuthority !== getAuthority ||
          recipient.getJournalBindingKey !== getJournal ||
          recipient.getProcessIdentity !== getProcess ||
          recipient.registrationState !== state ||
          !Object.entries(statePorts).every(
            ([key, value]) => state[key as keyof typeof statePorts] === value,
          ) ||
          !isDeepStrictEqual(local, authority) ||
          getJournal.call(recipient, ctx) !== journalBindingKey ||
          !isDeepStrictEqual(getProcess.call(recipient), process) ||
          !isDeepStrictEqual(state.getTarget(), target) ||
          state.getSlot() !== slot ||
          state.getGeneration() !== expected.registrationGeneration ||
          (!allowPending &&
            currentGeneration !== expected.registrationGeneration) ||
          (currentGeneration !== undefined &&
            currentGeneration !== expected.registrationGeneration) ||
          client.getAuthSecret?.() !== auth ||
          resolveBaleBusSocketPath(client.socketPath) !== endpoint ||
          !isDeepStrictEqual(deps.protocolIdentity, protocol) ||
          !isDeepStrictEqual(state.getLeaderProtocol(), leaderProtocol) ||
          !getBaleBusProtocolCompatibility({
            local: protocol,
            remote: leaderProtocol,
          }).compatible ||
          !hasBaleBusCapability(
            protocol,
            BALE_BUS_CAPABILITY_SELECTED_MENU_DELIVERY,
          ) ||
          !hasBaleBusCapability(
            leaderProtocol,
            BALE_BUS_CAPABILITY_SELECTED_MENU_DELIVERY,
          )
        )
          throw new Error("Selected-menu local authority changed.");
        if (!isDeepStrictEqual(getAuthority.call(recipient, ctx), authority))
          throw new Error(
            "Selected-menu context changed after local observations.",
          );
        assertAuthority();
      };
      assertCurrent(true);
      const registration = await resolveBaleBusFollowerRegistration(
        client,
        timeoutMs,
      );
      if (registration.generation !== expected.registrationGeneration)
        throw new Error("Selected-menu registration changed.");
      assertCurrent();
      dispatched = true;
      const response = await sendBaleBusLocalEnvelope({
        socketPath: endpoint,
        envelope: expected,
        timeoutMs: registration.remainingTimeoutMs,
        retry: { attempts: 1, delayMs: 0 },
        assertAuthority: () => assertCurrent(),
      });
      assertCurrent();
      if (
        response?.kind !== "bus.ack" ||
        response.requestId !== expected.requestId ||
        !response.ok ||
        response.error !== undefined ||
        (response.protocol !== undefined &&
          !isDeepStrictEqual(response.protocol, leaderProtocol)) ||
        !isRecord(response.result)
      )
        throw new Error("Selected-menu acknowledgement is unconfirmed.");
      const result = response.result;
      if (
        !isDeepStrictEqual(Object.keys(result).sort(), [
          "effect",
          "messageId",
          "operationId",
          "recipient",
          "registrationGeneration",
        ]) ||
        result.operationId !== expected.operationId ||
        result.registrationGeneration !== expected.registrationGeneration ||
        result.effect !== expected.effect.kind ||
        !isDeepStrictEqual(result.recipient, expected.recipient) ||
        typeof result.messageId !== "number" ||
        !Number.isSafeInteger(result.messageId) ||
        result.messageId <= 0 ||
        (expected.effect.kind === "edit-text" &&
          result.messageId !== expected.effect.messageId)
      )
        throw new Error("Selected-menu recipient/result is unconfirmed.");
      assertCurrent();
      return {
        operationId: expected.operationId,
        recipient: structuredClone(expected.recipient),
        registrationGeneration: expected.registrationGeneration,
        effect: expected.effect.kind,
        messageId: result.messageId,
      };
    } catch (error) {
      if (
        !dispatched ||
        (error instanceof BaleBusLocalAuthorityError &&
          !error.requestIssued)
      )
        throw new BaleApiAuthorityError(false);
      throw new BaleApiCommitUnknownError(method, error);
    }
  };
}

export function createBaleBusFollowerApiCaller(
  deps: BaleBusFollowerApiCallerDeps,
): (method: string, args: unknown[], localOptions?: Pick<BaleApiCallOptions, "assertAuthority">) => Promise<unknown> {
  const getNowMs = deps.getNowMs ?? Date.now;
  const timeoutMs = deps.timeoutMs ?? BALE_BUS_FOLLOWER_CLIENT_TIMEOUT_MS;
  const slowCallMs = deps.slowCallMs ?? BALE_BUS_FOLLOWER_API_SLOW_CALL_MS;
  const caller = async (
    method: string,
    args: unknown[],
    localOptions: Pick<BaleApiCallOptions, "assertAuthority"> | undefined,
    timing: { registeredAtMs?: number; apiMethod?: string },
  ): Promise<unknown> => {
    const assertion = localOptions?.assertAuthority;
    const assertCurrent = () => assertBaleApiCallAuthority(assertion, false);
    assertCurrent();
    // Match IPC's JSON semantics once, before awaits; send and refusal metadata share this identity.
    const requestArgs = JSON.parse(JSON.stringify(args)) as unknown[];
    const apiMethod = (method === "call" || method === "callMultipart") && typeof requestArgs[0] === "string"
      ? requestArgs[0] : method;
    timing.apiMethod = apiMethod;
    const registration = await resolveBaleBusFollowerRegistration(
      deps,
      timeoutMs,
    );
    timing.registeredAtMs = getNowMs();
    assertCurrent();
    const socketPath = resolveBaleBusSocketPath(deps.socketPath);
    let response: BaleBusEnvelope | undefined;
    try {
      response = await sendBaleBusOperation(
        socketPath,
        registration.remainingTimeoutMs,
        {
          kind: "follower.callApi",
          requestId: deps.createRequestId(),
          auth: deps.getAuthSecret?.(),
          instanceId: deps.instanceId,
          registrationGeneration: registration.generation,
          method,
          args: requestArgs,
          sentAtMs: getNowMs(),
        },
        assertion ? assertCurrent : undefined,
      );
    } catch (error) {
      if (error instanceof BaleBusLocalAuthorityError) throw new BaleApiAuthorityError(error.requestIssued);
      if (!isBaleApiMethodRetrySafe(apiMethod)) {
        throw new BaleApiCommitUnknownError(apiMethod, error);
      }
      throw error;
    }
    if (response?.kind === "bus.ack" && response.ok) return response.result;
    const message =
      response?.kind === "bus.ack"
        ? response.message
        : "Bale bus API call did not return an acknowledgement.";
    if (
      response?.kind === "bus.ack" &&
      response.error?.code === "stale-target" &&
      response.error.chatId !== undefined &&
      response.error.threadId !== undefined
    ) {
      throw new BaleApiStaleTargetError(
        message ?? "Bale thread target is stale.",
        {
          chatId: response.error.chatId,
          threadId: response.error.threadId,
        },
      );
    }
    if (
      response?.kind === "bus.ack" &&
      response.error?.code === "commit-unknown"
    ) {
      throw new BaleApiCommitUnknownError(
        response.error.method ?? method,
        new Error(message ?? "Bale bus API call result is ambiguous."),
      );
    }
    const refusedMethod = response?.kind === "bus.ack" && !response.ok &&
      response.error?.code === "follower-api-not-allowed" &&
      response.error.method === apiMethod
      ? apiMethod : undefined;
    if (refusedMethod || message === BALE_BUS_FOLLOWER_API_NOT_ALLOWED_MESSAGE) {
      const body =
        (method === "call" || method === "callMultipart") && isRecord(requestArgs[1])
          ? requestArgs[1]
          : undefined;
      const chatId = Number(body?.chat_id);
      const threadId = Number(body?.message_thread_id);
      throw new BaleApiFollowerNotAllowedError(
        message ?? BALE_BUS_FOLLOWER_API_NOT_ALLOWED_MESSAGE,
        Number.isSafeInteger(chatId) && Number.isSafeInteger(threadId)
          ? { chatId, threadId }
          : undefined,
        refusedMethod,
      );
    }
    throw new Error(message ?? "Bale bus API call failed.");
  };
  return async (method, args, localOptions) => {
    const startedAtMs = getNowMs();
    const timing: { registeredAtMs?: number; apiMethod?: string } = {};
    let outcome = "ok";
    try {
      return await caller(method, args, localOptions, timing);
    } catch (error) {
      outcome = "error";
      throw error;
    } finally {
      const elapsedMs = getNowMs() - startedAtMs;
      if (elapsedMs >= slowCallMs) {
        const apiMethod = timing.apiMethod ?? method;
        try {
          deps.recordRuntimeEvent?.(
            "bus",
            `Bale bus follower API call was slow (${elapsedMs}ms).`,
            {
              phase: "follower-api-slow",
              method: apiMethod,
              elapsedMs,
              registrationWaitMs:
                (timing.registeredAtMs ?? getNowMs()) - startedAtMs,
              ...(timing.registeredAtMs === undefined
                ? {}
                : { transportMs: getNowMs() - timing.registeredAtMs }),
              outcome,
            },
          );
        } catch {
          // Diagnostics cannot change the API call outcome.
        }
      }
    }
  };
}

async function resolveBaleBusFollowerRegistration(
  deps: Pick<
    BaleBusFollowerApiCallerDeps,
    "getRegistrationGeneration" | "waitForRegistrationGeneration" | "getNowMs"
  >,
  timeoutMs: number,
): Promise<{ generation: string; remainingTimeoutMs: number }> {
  const current = deps.getRegistrationGeneration();
  if (current) return { generation: current, remainingTimeoutMs: timeoutMs };
  const getNowMs = deps.getNowMs ?? Date.now;
  const startedAtMs = getNowMs();
  const restored = await deps.waitForRegistrationGeneration?.(timeoutMs);
  const remainingTimeoutMs = Math.max(
    0,
    timeoutMs - (getNowMs() - startedAtMs),
  );
  if (restored && remainingTimeoutMs > 0) {
    return { generation: restored, remainingTimeoutMs };
  }
  throw new Error("Bale bus follower is not registered.");
}

export function createBaleBusFollowerSessionReplacementSuspender(
  deps: BaleBusFollowerSessionReplacementSuspenderDeps,
): (preserveTarget?: boolean) => Promise<void> {
  const getNowMs = deps.getNowMs ?? Date.now;
  const getPid = deps.getPid ?? (() => process.pid);
  return async (preserveTarget = true) => {
    if (!preserveTarget) {
      setBaleFollowerSessionHandoff(undefined);
      Threads.setBaleLeaderSessionHandoff(undefined);
      await deps.suspendPolling();
      return;
    }
    const target = deps.registrationState.getTarget();
    if (deps.registrationState.isRegistered() && target) {
      setBaleFollowerSessionHandoff({
        pid: getPid(),
        instanceId: deps.instanceId,
        createdAtMs: getNowMs(),
        target,
        slot: deps.registrationState.getSlot(),
        threadName: deps.registrationState.getThreadName(),
      });
      deps.recordRuntimeEvent(
        "bus",
        "Bale follower registration suspended for session replacement",
        {
          phase: "follower-session-handoff",
          instanceId: deps.instanceId,
          chatId: target.chatId,
          threadId: target.threadId,
        },
      );
    } else if (deps.isLeader?.()) {
      const leaderBinding = deps.getLeaderBinding?.();
      if (typeof leaderBinding?.target?.threadId === "number") {
        const activeContext = deps.getActiveContext?.();
        const profileKey = Threads.getBaleThreadOwnerKey({
          kind: "leader",
          cwd: activeContext?.cwd,
          instanceId: deps.instanceId,
          baleProfile: deps.getActiveProfileName?.(),
        });
        Threads.setBaleLeaderSessionHandoff({
          pid: getPid(),
          instanceId: deps.instanceId,
          createdAtMs: getNowMs(),
          profileKey,
          target: {
            chatId: leaderBinding.target.chatId,
            threadId: leaderBinding.target.threadId,
          },
          slot: leaderBinding.slot,
          threadName: leaderBinding.threadName,
        });
        deps.recordRuntimeEvent(
          "bus",
          "Bale leader binding suspended for session replacement",
          {
            phase: "leader-session-handoff",
            instanceId: deps.instanceId,
            chatId: leaderBinding.target.chatId,
            threadId: leaderBinding.target.threadId,
            slot: leaderBinding.slot,
            threadName: leaderBinding.threadName,
          },
        );
      }
    }
    await deps.suspendPolling();
  };
}

export function createBaleBusFollowerSessionRefreshHook<TContext>(
  deps: BaleBusFollowerSessionRefreshHookDeps<TContext>,
): (_event: unknown, ctx: TContext) => Promise<void> {
  return async (_event, ctx) => {
    if (deps.isSessionActive && !deps.isSessionActive(ctx)) return;
    if (!deps.registrationState.isRegistered()) {
      const handoff = getBaleFollowerSessionHandoff();
      const lockState = deps.getLeaderState();
      const handoffIsFresh = isBaleFollowerSessionHandoffFresh(handoff);
      if (handoffIsFresh && lockState.kind === "active-elsewhere") {
        try {
          const restored = await deps.registrationRuntime.registerWithLeader(
            ctx,
            lockState.lock,
            {
              target: handoff.target,
              previousInstanceId: handoff.instanceId,
            },
          );
          if (deps.isSessionActive && !deps.isSessionActive(ctx)) return;
          if (restored) {
            setBaleFollowerSessionHandoff(undefined);
            deps.updateStatus(ctx);
            deps.recordRuntimeEvent(
              "bus",
              "Bale follower registration restored after session replacement",
              {
                phase: "follower-session-restore",
                previousInstanceId: handoff.instanceId,
              },
            );
          }
        } catch (error) {
          deps.recordRuntimeEvent("bus", error, {
            phase: "follower-session-restore",
            previousInstanceId: handoff?.instanceId,
          });
        }
      } else if (handoff) {
        setBaleFollowerSessionHandoff(undefined);
      }
    }
    if (!deps.registrationState.isRegistered()) return;
    if (deps.isSessionActive && !deps.isSessionActive(ctx)) return;
    try {
      await deps.registrationRuntime.setContext(ctx);
    } catch (error) {
      deps.recordRuntimeEvent("bus", error, {
        phase: "follower-session-refresh",
      });
      return;
    }
    if (deps.isSessionActive && !deps.isSessionActive(ctx)) return;
    deps.updateStatus(ctx);
    deps.recordRuntimeEvent(
      "bus",
      "Bale follower session context refreshed",
      { phase: "follower-session-refresh" },
    );
  };
}

export function createBaleBusFollowerControlState(): BaleBusFollowerControlState {
  let activeAuthSecret: string | undefined;
  let lifecyclePhase: BaleBusFollowerControlLifecyclePhase | undefined;
  return {
    getActiveAuthSecret: () => activeAuthSecret,
    setActiveAuthSecret(secret) {
      activeAuthSecret = secret;
    },
    getLifecyclePhase: () => lifecyclePhase,
    setLifecyclePhase(phase) {
      lifecyclePhase = phase;
    },
  };
}

export function createBaleBusFollowerRegistrationState(
  options: { onAvailabilityChanged?: () => void } = {},
): BaleBusFollowerRegistrationState {
  let registered = false;
  let target: BaleTarget | undefined;
  let slot: string | undefined;
  let threadName: string | undefined;
  let displayTitle: string | undefined;
  let generation: string | undefined;
  let sessionId: string | undefined;
  let leaderProtocol: BaleBusProtocolIdentity | undefined;
  let eligibleElectionSlots: string[] = [];
  let recoveryEpoch = 0;
  let activeRecoveryEpoch: number | undefined;
  const generationWaiters = new Set<{
    epoch: number;
    settle: (value: string | undefined) => void;
  }>();
  const settleGenerationWaiters = (
    value: string | undefined,
    epoch?: number,
  ) => {
    for (const waiter of [...generationWaiters]) {
      if (epoch === undefined || waiter.epoch === epoch) waiter.settle(value);
    }
  };
  return {
    isRegistered: () => registered,
    getTarget: () => (target ? { ...target } : undefined),
    getSlot: () => slot,
    getThreadName: () => threadName,
    getDisplayTitle: () => displayTitle,
    setDisplayTitle(title, expectedGeneration) {
      if (
        !registered ||
        !generation ||
        expectedGeneration !== generation ||
        !title.trim() ||
        title.length > 128 ||
        displayTitle === title
      )
        return false;
      displayTitle = title;
      return true;
    },
    getGeneration: () => generation,
    getSessionId: (currentSessionId) =>
      registered && generation && currentSessionId === sessionId
        ? sessionId
        : undefined,
    beginRecovery: () => {
      if (activeRecoveryEpoch !== undefined) return activeRecoveryEpoch;
      activeRecoveryEpoch = ++recoveryEpoch;
      return activeRecoveryEpoch;
    },
    cancelRecovery: () => {
      const epoch = activeRecoveryEpoch;
      activeRecoveryEpoch = undefined;
      if (epoch !== undefined) settleGenerationWaiters(undefined, epoch);
    },
    waitForGeneration: (
      timeoutMs = BALE_BUS_FOLLOWER_REGISTRATION_WAIT_MS,
    ) => {
      if (generation) return Promise.resolve(generation);
      const epoch = activeRecoveryEpoch;
      if (epoch === undefined) return Promise.resolve(undefined);
      return new Promise((resolve) => {
        let timer: NodeJS.Timeout | undefined;
        const settle = (value: string | undefined) => {
          generationWaiters.delete(waiter);
          if (timer) clearTimeout(timer);
          resolve(value);
        };
        const waiter = { epoch, settle };
        generationWaiters.add(waiter);
        timer = setTimeout(() => settle(undefined), Math.max(0, timeoutMs));
      });
    },
    getLeaderProtocol: () =>
      leaderProtocol
        ? { ...leaderProtocol, capabilities: [...leaderProtocol.capabilities] }
        : undefined,
    getEligibleElectionSlots: () => [...eligibleElectionSlots],
    setEligibleElectionSlots: (slots) => {
      eligibleElectionSlots = Array.from(
        new Set(slots.filter((slot) => /^[A-Z]$/.test(slot))),
      ).sort();
    },
    setRegistered: (next, nextTarget, metadata) => {
      const retainedDisplayTitle =
        next &&
        registered &&
        generation === metadata?.generation &&
        target?.chatId === nextTarget?.chatId &&
        target?.threadId === nextTarget?.threadId
          ? displayTitle
          : undefined;
      const retainedSessionId =
        next && registered && generation === metadata?.generation
          ? sessionId
          : undefined;
      const availabilityChanged = registered !== next;
      registered = next;
      target = next ? (nextTarget ? { ...nextTarget } : undefined) : undefined;
      slot = next ? metadata?.slot : undefined;
      threadName = next ? metadata?.threadName : undefined;
      displayTitle =
        next &&
        nextTarget &&
        metadata?.generation &&
        metadata.displayTitle?.trim() &&
        metadata.displayTitle.length <= 128
          ? metadata.displayTitle
          : retainedDisplayTitle;
      generation = next ? metadata?.generation : undefined;
      sessionId = next ? (metadata?.sessionId ?? retainedSessionId) : undefined;
      leaderProtocol =
        next && metadata?.leaderProtocol
          ? {
              ...metadata.leaderProtocol,
              capabilities: [...metadata.leaderProtocol.capabilities],
            }
          : undefined;
      if (availabilityChanged) options.onAvailabilityChanged?.();
      if (generation) {
        activeRecoveryEpoch = undefined;
        settleGenerationWaiters(generation);
      }
    },
  };
}

/** Heartbeat-failure recovery that a deliberate local stop halts until the next deliberate registration. */
export type BaleBusFollowerHeartbeatRecoveryHandler<TContext> = ((
  error: unknown,
  ctx: TContext,
) => Promise<void>) & { halt: () => void; resume: () => void };

/** The whole recovery lifecycle state; only `transitionBaleBusFollowerRecovery` produces a new one. */
export interface BaleBusFollowerRecoveryState {
  /** Bumped by halt and resume, so a recovery or retry from before an operator stop or connect is inert. */
  readonly epoch: number;
  readonly halted: boolean;
  /** One recovery runs at a time; it belongs to the epoch it started in. */
  readonly recovering: boolean;
  readonly retryId: number | null;
  readonly nextRetryId: number;
}

export type BaleBusFollowerRecoveryEvent =
  | { type: "recoverRequested" }
  | { type: "recoverySettled"; epoch: number }
  | { type: "retryRequested"; epoch: number }
  | { type: "retryFired"; retryId: number }
  | { type: "halted" }
  | { type: "resumed" };

export type BaleBusFollowerRecoveryEffect =
  | { type: "runRecovery"; epoch: number }
  | { type: "armRetry"; retryId: number }
  | { type: "cancelRetry"; retryId: number };

export function createBaleBusFollowerRecoveryState(): BaleBusFollowerRecoveryState {
  return {
    epoch: 0,
    halted: false,
    recovering: false,
    retryId: null,
    nextRetryId: 0,
  };
}

/**
 * Pure follower-recovery lifecycle. An operator stop halts it and a connect resumes it, each in a new epoch: work
 * from the old epoch, a recovery still awaiting or a retry still armed, can no longer register or promote.
 */
export function transitionBaleBusFollowerRecovery(
  state: BaleBusFollowerRecoveryState,
  event: BaleBusFollowerRecoveryEvent,
): Machine.BaleMachineStep<
  BaleBusFollowerRecoveryState,
  BaleBusFollowerRecoveryEffect
> {
  const cancelRetry: BaleBusFollowerRecoveryEffect[] =
    state.retryId === null
      ? []
      : [{ type: "cancelRetry", retryId: state.retryId }];
  const start = (
    from: BaleBusFollowerRecoveryState,
  ): Machine.BaleMachineStep<
    BaleBusFollowerRecoveryState,
    BaleBusFollowerRecoveryEffect
  > =>
    from.halted || from.recovering
      ? { state: from, effects: [] }
      : {
          state: { ...from, recovering: true },
          effects: [{ type: "runRecovery", epoch: from.epoch }],
        };
  switch (event.type) {
    case "recoverRequested":
      return start(state);
    case "recoverySettled":
      return event.epoch === state.epoch
        ? { state: { ...state, recovering: false }, effects: [] }
        : { state, effects: [] };
    case "retryRequested": {
      if (event.epoch !== state.epoch || state.halted)
        return { state, effects: [] };
      const retryId = state.nextRetryId + 1;
      return {
        state: { ...state, retryId, nextRetryId: retryId },
        effects: [...cancelRetry, { type: "armRetry", retryId }],
      };
    }
    case "retryFired":
      if (state.retryId !== event.retryId) return { state, effects: [] };
      return start({ ...state, retryId: null });
    case "halted":
    case "resumed":
      return {
        state: {
          ...state,
          epoch: state.epoch + 1,
          halted: event.type === "halted",
          recovering: false,
          retryId: null,
        },
        effects: cancelRetry,
      };
  }
}

export function createBaleBusFollowerHeartbeatRecoveryHandler<TContext>(
  deps: BaleBusFollowerHeartbeatRecoveryHandlerDeps<TContext>,
): BaleBusFollowerHeartbeatRecoveryHandler<TContext> {
  // Promotion stops registration internally and must keep retrying; only an operator stop or a confirmed
  // switch to classic mode halts recovery, so it never re-registers behind a disconnect.
  const promotionGraceMs =
    deps.promotionGraceMs ?? BALE_BUS_FOLLOWER_PROMOTION_GRACE_MS;
  const sleep =
    deps.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  // A cancelled retry still fires through an injected scheduler; its id no longer matches and it does nothing.
  const scheduleRetry =
    deps.scheduleRetry ??
    ((retry: () => void, delayMs: number) => {
      const timer = setTimeout(retry, delayMs);
      timer.unref?.();
    });
  /** The recovery request carried by each retry; the machine decides whether the retry still counts. */
  type RecoveryRequest = {
    reason: unknown;
    ctx: TContext;
    binding?: BaleBusFollowerPromotedBinding;
  };
  const retryRequests = new Map<number, RecoveryRequest>();
  let pendingRetry: RecoveryRequest | undefined;
  let request: RecoveryRequest | undefined;
  let running: Promise<void> = Promise.resolve();
  const machine = Machine.createBaleMachineRunner<
    BaleBusFollowerRecoveryState,
    BaleBusFollowerRecoveryEvent,
    BaleBusFollowerRecoveryEffect
  >({
    initial: createBaleBusFollowerRecoveryState(),
    transition: transitionBaleBusFollowerRecovery,
    run(effect) {
      switch (effect.type) {
        case "runRecovery": {
          const started = request!;
          running = runRecovery(started, effect.epoch).finally(() =>
            machine.dispatch({ type: "recoverySettled", epoch: effect.epoch }),
          );
          return;
        }
        case "armRetry": {
          const retryId = effect.retryId;
          retryRequests.set(retryId, pendingRetry!);
          const fire = () => {
            const carried = retryRequests.get(retryId);
            if (!carried || machine.state.retryId !== retryId) return;
            const activeCtx = deps.getActiveContext
              ? deps.getActiveContext()
              : carried.ctx;
            if (!activeCtx) {
              scheduleRetry(fire, promotionGraceMs);
              return;
            }
            retryRequests.delete(retryId);
            void requestRecovery(
              { ...carried, ctx: activeCtx },
              {
                type: "retryFired",
                retryId,
              },
            );
          };
          scheduleRetry(fire, promotionGraceMs);
          return;
        }
        case "cancelRetry":
          retryRequests.delete(effect.retryId);
          return;
      }
    },
  });
  const requestRecovery = (
    next: RecoveryRequest,
    event: BaleBusFollowerRecoveryEvent,
  ): Promise<void> => {
    const before = running;
    request = next;
    try {
      machine.dispatch(event);
    } finally {
      request = undefined;
    }
    return running === before ? Promise.resolve() : running;
  };
  const runRecovery = async (
    { reason: error, ctx, binding: carriedBinding }: RecoveryRequest,
    epoch: number,
  ): Promise<void> => {
    const isCurrent = (): boolean =>
      machine.state.epoch === epoch && !machine.state.halted;
    const scheduleRecovery = (
      reason: unknown,
      fallbackCtx: TContext,
      binding: BaleBusFollowerPromotedBinding,
    ) => {
      pendingRetry = { reason, ctx: fallbackCtx, binding };
      try {
        machine.dispatch({ type: "retryRequested", epoch });
      } finally {
        pendingRetry = undefined;
      }
    };
    const safeUpdateStatus = (ctx: TContext) => {
      try {
        deps.updateStatus(ctx);
      } catch (error) {
        if (!isPiStaleContextError(error)) throw error;
        deps.recordRuntimeEvent("bus", error, {
          phase: "follower-stale-context-status",
        });
      }
    };
    const clearRegisteredState = (ctx: TContext) => {
      deps.registrationState.setRegistered(false);
      safeUpdateStatus(ctx);
    };
    const tryRegisterWithLeader = async (
      ctx: TContext,
      leader: BaleBusFollowerLeaderLock,
      phase: string,
      binding?: BaleBusFollowerPromotedBinding,
    ) => {
      if (!isCurrent()) return false;
      try {
        const restored = await deps
          .getRegistrationRuntime()
          .registerWithLeader(
            ctx,
            leader,
            binding?.target ? { target: binding.target } : undefined,
          );
        // Registration owns its attempt cleanup; an obsolete recovery cannot stop the shared replacement runtime.
        if (!restored || !isCurrent()) return false;
        deps.setLifecyclePhase(undefined);
        safeUpdateStatus(ctx);
        deps.recordRuntimeEvent(
          "bus",
          "Bale follower registration restored",
          {
            phase,
          },
        );
        return true;
      } catch (error) {
        if (!isCurrent()) return false;
        clearRegisteredState(ctx);
        deps.recordRuntimeEvent("bus", error, { phase });
        return false;
      }
    };
    const snapshotBinding = (): BaleBusFollowerPromotedBinding => ({
      target: deps.registrationState.getTarget(),
      slot: deps.registrationState.getSlot(),
      threadName: deps.registrationState.getThreadName(),
    });
    const promoteToLeader = async (
      reason: unknown,
      ctx: TContext,
      binding: BaleBusFollowerPromotedBinding,
      election: BaleBusFollowerElection,
    ) => {
      if (!isCurrent()) return;
      if (deps.getActiveContext) {
        // Pi hands every event and command a fresh context object, so a manually connected follower never holds
        // the stored session object. Promote through the live session context instead of rescheduling: heartbeat
        // failures re-request recovery faster than the retry grace, so a reschedule-only path never fires.
        const activeCtx = deps.getActiveContext();
        if (!activeCtx) {
          scheduleRecovery(reason, ctx, binding);
          return;
        }
        ctx = activeCtx;
      }
      deps.setLifecyclePhase("electing");
      safeUpdateStatus(ctx);
      deps.recordRuntimeEvent("bus", reason, {
        phase: "follower-promotion-electing",
      });
      deps.getRegistrationRuntime().stop();
      deps.setLifecyclePhase("electing");
      safeUpdateStatus(ctx);
      deps.recordRuntimeEvent("bus", "Bale follower attempting promotion", {
        phase: "follower-promotion-electing",
      });
      const promoted = await deps.promoteToLeader(ctx, binding, election);
      if (!isCurrent()) return;
      deps.setLifecyclePhase(undefined);
      safeUpdateStatus(ctx);
      deps.recordRuntimeEvent(
        "bus",
        promoted
          ? "Bale follower promotion completed"
          : "Bale follower promotion lost election",
        {
          phase: promoted
            ? "follower-promotion-complete"
            : "follower-promotion-lost",
        },
      );
      if (!promoted) scheduleRecovery(reason, ctx, binding);
    };
    const attemptPreferredPromotion = async (
      reason: unknown,
      ctx: TContext,
      binding: BaleBusFollowerPromotedBinding,
      candidateState: BaleBusFollowerLeaderState,
    ): Promise<void> => {
      const slot = binding.slot;
      const lowerEligibleSlot = slot
        ? deps.registrationState
            .getEligibleElectionSlots()
            .find((candidate) => candidate < slot)
        : undefined;
      if (lowerEligibleSlot) {
        deps.recordRuntimeEvent(
          "bus",
          "Bale follower deferring to a lower-slot election candidate",
          {
            phase: "follower-promotion-slot-priority",
            slot,
            lowerEligibleSlot,
          },
        );
        await sleep(promotionGraceMs);
        if (!isCurrent()) return;
        candidateState = deps.getLeaderState();
        if (candidateState.kind === "active-elsewhere") {
          if (
            !(await tryRegisterWithLeader(
              ctx,
              candidateState.lock,
              "follower-register-preferred-successor",
              binding,
            ))
          ) {
            scheduleRecovery(reason, ctx, binding);
          }
          return;
        }
      }
      if (candidateState.kind !== "stale" && candidateState.kind !== "inactive")
        return;
      await promoteToLeader(reason, ctx, binding, {
        expectedOwner:
          candidateState.kind === "stale" ? candidateState.lock : undefined,
      });
    };
    deps.registrationState.beginRecovery();
    const initialBinding = carriedBinding ?? snapshotBinding();
    try {
      let threadModeDisabled = false;
      try {
        threadModeDisabled = (await deps.isThreadModeDisabled?.()) === true;
      } catch (stateError) {
        deps.recordRuntimeEvent("bus", stateError, {
          phase: "follower-thread-mode-read",
        });
      }
      if (!isCurrent()) return;
      if (threadModeDisabled) {
        machine.dispatch({ type: "halted" });
        deps.getRegistrationRuntime().stop();
        deps.setLifecyclePhase(undefined);
        safeUpdateStatus(ctx);
        deps.recordRuntimeEvent(
          "bus",
          "Bale follower went offline: Threaded Mode is off. Run /bale-connect after turning it back on.",
          { phase: "follower-thread-mode-disabled" },
        );
        return;
      }
      const state = deps.getLeaderState();
      if (state.kind === "active-elsewhere") {
        clearRegisteredState(ctx);
        if (
          await tryRegisterWithLeader(
            ctx,
            state.lock,
            "follower-register-restore",
            initialBinding,
          )
        ) {
          return;
        }
        if (!isCurrent()) return;
        deps.setLifecyclePhase("electing");
        safeUpdateStatus(ctx);
        deps.recordRuntimeEvent(
          "bus",
          "Bale follower waiting for leader reload recovery",
          { phase: "follower-promotion-grace" },
        );
        await sleep(promotionGraceMs);
        if (!isCurrent()) return;
        const graceState = deps.getLeaderState();
        if (graceState.kind === "active-elsewhere") {
          if (
            await tryRegisterWithLeader(
              ctx,
              graceState.lock,
              "follower-register-restore-grace",
              initialBinding,
            )
          ) {
            return;
          }
          const unresponsive = await deps.proveLeaderUnresponsive?.(
            graceState.lock,
          );
          if (!isCurrent()) return;
          if (unresponsive) {
            await promoteToLeader(error, ctx, initialBinding, {
              expectedOwner: graceState.lock,
              unresponsive: true,
            });
            return;
          }
          deps.setLifecyclePhase(undefined);
          safeUpdateStatus(ctx);
          deps.recordRuntimeEvent(
            "bus",
            "Bale follower promotion blocked by live leader lease",
            {
              phase: "follower-promotion-live-owner",
              leaderInstanceId: graceState.lock.instanceId,
              leaderEpoch: graceState.lock.leaderEpoch,
            },
          );
          scheduleRecovery(error, ctx, initialBinding);
          return;
        }
        await attemptPreferredPromotion(error, ctx, initialBinding, graceState);
        return;
      }
      await attemptPreferredPromotion(error, ctx, initialBinding, state);
    } catch (promotionError) {
      if (!isCurrent()) return;
      deps.setLifecyclePhase(undefined);
      safeUpdateStatus(ctx);
      if (isPiStaleContextError(promotionError)) {
        deps.recordRuntimeEvent("bus", promotionError, {
          phase: "follower-heartbeat-stale-context",
        });
        return;
      }
      deps.recordRuntimeEvent("bus", promotionError, {
        phase: "follower-promotion-failed",
      });
      scheduleRecovery(promotionError, ctx, initialBinding);
    }
  };
  return Object.assign(
    (error: unknown, ctx: TContext): Promise<void> =>
      requestRecovery({ reason: error, ctx }, { type: "recoverRequested" }),
    {
      halt() {
        machine.dispatch({ type: "halted" });
      },
      resume() {
        machine.dispatch({ type: "resumed" });
      },
    },
  );
}

export function createBaleBusFollowerRegistrationRuntime<
  TContext extends { cwd?: string },
>(
  deps: BaleBusFollowerRegistrationRuntimeDeps<TContext>,
): BaleBusFollowerRegistrationRuntime<TContext> {
  const getNowMs = deps.getNowMs ?? Date.now;
  const getPid = deps.getPid ?? (() => process.pid);
  const heartbeatMs = deps.heartbeatMs ?? 1000;
  const heartbeatTimeoutMs =
    deps.heartbeatTimeoutMs ??
    deps.timeoutMs ??
    BALE_BUS_FOLLOWER_HEARTBEAT_TIMEOUT_MS;
  const registrationTimeoutMs =
    deps.registrationTimeoutMs ?? deps.timeoutMs ?? 30000;
  const registrationRetryAttempts =
    deps.registrationRetryAttempts ??
    BALE_BUS_FOLLOWER_REGISTRATION_RETRY_ATTEMPTS;
  const registrationRetryDelayMs =
    deps.registrationRetryDelayMs ??
    BALE_BUS_FOLLOWER_REGISTRATION_RETRY_DELAY_MS;
  let heartbeatInterval: ReturnType<typeof setInterval> | undefined;
  let heartbeatPromise: Promise<void> | undefined;
  let heartbeatPromiseGeneration: string | undefined;
  let activeLeaderSocketPath: string | undefined;
  let activeAuthSecret: string | undefined;
  let activeRegistrationGeneration: string | undefined;
  let registrationAttempt:
    | {
        ctx: TContext;
        sessionGeneration: number | undefined;
        sessionId: string | undefined;
      }
    | undefined;
  let activeContext: TContext | undefined;
  let lastKnownTarget: BaleTarget | undefined;
  let lastKnownSlot: string | undefined;
  let lastKnownThreadName: string | undefined;
  // A leader result is accepted only for the same endpoint and registration generation that issued the request.
  const isLeaderSessionCurrent = (
    socketPath: string | undefined,
    generation: string | undefined,
  ): boolean =>
    activeLeaderSocketPath === socketPath &&
    activeRegistrationGeneration === generation &&
    (!deps.registrationState ||
      deps.registrationState.getGeneration() === generation);
  const stopHeartbeat = () => {
    // A stopped heartbeat ends the current failure run, so a later run logs its own first failure.
    heartbeatFailureLog.reset();
    if (!heartbeatInterval) return;
    clearInterval(heartbeatInterval);
    heartbeatInterval = undefined;
  };
  const stop = () => {
    registrationAttempt = undefined;
    stopHeartbeat();
    activeAuthSecret = undefined;
    activeRegistrationGeneration = undefined;
    heartbeatPromise = undefined;
    heartbeatPromiseGeneration = undefined;
    deps.setActiveAuthSecret?.(undefined);
    deps.registrationState?.cancelRecovery();
    deps.registrationState?.setRegistered(false);
    lastKnownTarget = undefined;
    lastKnownSlot = undefined;
    lastKnownThreadName = undefined;
    activeContext = undefined;
    void Promise.resolve(deps.stopReceiving?.()).catch((error) => {
      try {
        deps.recordRuntimeEvent?.("bus", error, {
          phase: "follower-receiver-stop",
        });
      } catch {
        // Stop diagnostics cannot create an unhandled Promise.
      }
    });
  };
  /** A sustained leader outage repeats one identical failure every interval; the port collapses the run. */
  const heartbeatFailureLog: BaleFailureRunLogPort =
    deps.failureLog ?? {
      record(error) {
        try {
          deps.recordRuntimeEvent?.("bus", error, {
            phase: "follower-heartbeat",
          });
        } catch {
          // Diagnostics cannot replace heartbeat recovery.
        }
        return true;
      },
      settled: () => undefined,
      reset: () => undefined,
    };
  const sendHeartbeat = async () => {
    const leaderSocketPath = activeLeaderSocketPath;
    const registrationGeneration = activeRegistrationGeneration;
    const heartbeatContext = activeContext;
    const heartbeatTarget = deps.registrationState?.getTarget();
    if (!leaderSocketPath || !registrationGeneration) return;
    const isCurrentHeartbeat = (): boolean =>
      activeLeaderSocketPath === leaderSocketPath &&
      activeRegistrationGeneration === registrationGeneration &&
      activeContext === heartbeatContext;
    try {
      const response = await sendBaleBusOperation(
        leaderSocketPath,
        heartbeatTimeoutMs,
        {
          kind: "follower.heartbeat",
          requestId: deps.createRequestId(),
          auth: activeAuthSecret,
          instanceId: deps.instanceId,
          registrationGeneration,
          sentAtMs: getNowMs(),
        },
      );
      if (!isCurrentHeartbeat()) return;
      if (response?.kind === "bus.ack" && response.ok) {
        heartbeatFailureLog.settled();
        const heartbeatResult = isRecord(response.result)
          ? response.result
          : undefined;
        const slots = Array.isArray(heartbeatResult?.eligibleElectionSlots)
          ? heartbeatResult.eligibleElectionSlots.filter(
              (slot): slot is string => typeof slot === "string",
            )
          : [];
        deps.registrationState?.setEligibleElectionSlots(slots);
        if (
          typeof heartbeatResult?.displayTitle === "string" &&
          isDeepStrictEqual(deps.registrationState?.getTarget(), heartbeatTarget) &&
          deps.registrationState?.setDisplayTitle(
            heartbeatResult.displayTitle,
            registrationGeneration,
          ) &&
          heartbeatContext
        ) {
          try {
            deps.onDisplayTitleChanged?.(heartbeatContext);
          } catch {
            // Display refresh failure must not invalidate a successful heartbeat.
          }
        }
      }
      if (response?.kind === "bus.ack" && !response.ok) {
        throw new Error(
          response.message ?? "Bale bus follower heartbeat was rejected.",
        );
      }
    } catch (error) {
      if (!isCurrentHeartbeat()) return;
      heartbeatFailureLog.record(error);
      if (!heartbeatContext) return;
      try {
        await deps.onHeartbeatFailure?.(error, heartbeatContext);
      } catch (recoveryError) {
        try {
          deps.recordRuntimeEvent?.("bus", recoveryError, {
            phase: "follower-heartbeat-recovery",
          });
        } catch {
          // A diagnostic sink cannot create an unhandled interval rejection.
        }
      }
    }
  };
  const requestHeartbeat = (): Promise<void> => {
    const generation = activeRegistrationGeneration;
    if (heartbeatPromise && heartbeatPromiseGeneration === generation) {
      return heartbeatPromise;
    }
    let tracked: Promise<void>;
    tracked = sendHeartbeat().finally(() => {
      if (heartbeatPromise === tracked) {
        heartbeatPromise = undefined;
        heartbeatPromiseGeneration = undefined;
      }
    });
    heartbeatPromise = tracked;
    heartbeatPromiseGeneration = generation;
    return tracked;
  };
  const startHeartbeat = (socketPath: string) => {
    stopHeartbeat();
    activeLeaderSocketPath = socketPath;
    heartbeatInterval = setInterval(() => {
      void requestHeartbeat();
    }, heartbeatMs);
    heartbeatInterval.unref?.();
  };
  return {
    registerWithLeader: async (ctx, leader, options) => {
      if (deps.isContextActive?.(ctx) === false) return false;
      const sessionGeneration = deps.getSessionGeneration?.();
      const sessionId = deps.getSessionId?.(ctx);
      const attempt = { ctx, sessionGeneration, sessionId };
      registrationAttempt = attempt;
      const isCurrentRequest = () =>
        registrationAttempt === attempt &&
        deps.getSessionGeneration?.() === sessionGeneration &&
        deps.getSessionId?.(ctx) === sessionId &&
        deps.isContextActive?.(ctx) !== false;
      const abandonOwnedRequest = async (): Promise<void> => {
        if (registrationAttempt !== attempt) return;
        registrationAttempt = undefined;
        stopHeartbeat();
        activeLeaderSocketPath = undefined;
        activeAuthSecret = undefined;
        activeRegistrationGeneration = undefined;
        activeContext = undefined;
        deps.registrationState?.setRegistered(false);
        deps.setActiveAuthSecret?.(undefined);
        await deps.stopReceiving?.();
      };
      // Failed registration releases its leader session but keeps the attempt owner for caller-visible errors.
      const failRegistration = async (
        clearGeneration = false,
      ): Promise<void> => {
        stopHeartbeat();
        activeLeaderSocketPath = undefined;
        activeAuthSecret = undefined;
        if (clearGeneration) activeRegistrationGeneration = undefined;
        deps.registrationState?.setRegistered(false);
        deps.setActiveAuthSecret?.(undefined);
        await deps.stopReceiving?.();
      };
      // A fresh handoff belongs to this same process, so a replaced session reuses its Thread: the tab keeps
      // one identity and only its owner rotates. Explicit options still override the preserved target.
      const pendingHandoff = getBaleFollowerSessionHandoff();
      const pendingHandoffOptions = isBaleFollowerSessionHandoffFresh(
        pendingHandoff,
      )
        ? {
            target: pendingHandoff.target,
            previousInstanceId: pendingHandoff.instanceId,
          }
        : undefined;
      const registrationOptions:
        | {
            target?: BaleTarget;
            previousInstanceId?: string;
            restoreWorkspace?: boolean;
            recoverConnection?: boolean;
          }
        | undefined = options ? { ...pendingHandoffOptions, ...options } : pendingHandoffOptions;
      const leaderSocketPath =
        leader.busSocketPath ??
        deps.getLeaderSocketPath?.() ??
        getBaleBusSocketPath();
      await deps.startReceiving?.();
      if (!isCurrentRequest()) {
        await abandonOwnedRequest();
        return false;
      }
      activeAuthSecret = deps.getLeaderAuthSecret
        ? deps.getLeaderAuthSecret(leader)
        : leader?.busSecret;
      deps.setActiveAuthSecret?.(activeAuthSecret);
      const registrationGeneration = deps.createRequestId();
      const registrationEnvelope: BaleBusEnvelope = {
        kind: registrationOptions?.restoreWorkspace
          ? "follower.restoreWorkspace"
          : "follower.register",
        requestId: registrationGeneration,
        auth: activeAuthSecret,
        ...(registrationOptions?.recoverConnection && !registrationOptions.restoreWorkspace
          ? { recoverConnection: true as const } : {}),
        registration: {
          instanceId: deps.instanceId,
          ...(registrationOptions?.previousInstanceId
            ? { previousInstanceId: registrationOptions.previousInstanceId }
            : {}),
          profileKey:
            deps.getProfileKey?.(ctx) ??
            (ctx.cwd ? `cwd:${ctx.cwd}` : undefined),
          threadName:
            deps.registrationState?.getThreadName() ??
            lastKnownThreadName ??
            deps.getThreadName?.(ctx) ??
            (ctx.cwd ? basename(ctx.cwd) : undefined),
          ...((deps.registrationState?.getSlot() ?? lastKnownSlot)
            ? { slot: deps.registrationState?.getSlot() ?? lastKnownSlot }
            : {}),
          cwd: ctx.cwd,
          sessionId,
          pid: getPid(),
          processBirthId: deps.getProcessBirthId?.(),
          sessionGeneration,
          target:
            registrationOptions?.target ??
            deps.registrationState?.getTarget() ??
            lastKnownTarget,
          busSocketPath:
            deps.getFollowerBusSocketPath?.() ?? deps.followerBusSocketPath,
          registrationGeneration,
          protocol: deps.protocolIdentity,
          connectedAtMs: getNowMs(),
        },
      };
      let response: BaleBusEnvelope | undefined;
      try {
        response = await sendBaleBusLocalEnvelope({
          socketPath: leaderSocketPath,
          timeoutMs: registrationTimeoutMs,
          envelope: registrationEnvelope,
          retry: getBaleBusTransportRetryPolicy({
            endpoint: leaderSocketPath,
            operation: "registration",
            overrides: {
              attempts: registrationRetryAttempts,
              delayMs: registrationRetryDelayMs,
            },
          }),
          recordTransportEvent(phase, details) {
            deps.recordRuntimeEvent?.("bus", `Bale bus ${phase}`, {
              phase: `follower-register-${phase}`,
              ...details,
            });
          },
        });
      } catch (error) {
        if (!isCurrentRequest()) {
          await abandonOwnedRequest();
          return false;
        }
        await failRegistration();
        throw error;
      }
      if (!isCurrentRequest()) {
        await abandonOwnedRequest();
        return false;
      }
      const compatibility = getBaleBusProtocolCompatibility({
        local: deps.protocolIdentity,
        remote: response?.kind === "bus.ack" ? response.protocol : undefined,
      });
      // An identity-less error ACK is a rejection/transport failure, not evidence of an incompatible leader.
      const unidentifiedRejection =
        response?.kind === "bus.ack" &&
        !response.ok &&
        response.protocol === undefined;
      if (!compatibility.compatible && !unidentifiedRejection) {
        await failRegistration();
        throw new Error(
          `Incompatible Bale bus leader protocol: ${compatibility.reason}.`,
        );
      }
      if (response?.kind === "bus.ack" && !response.ok) {
        await failRegistration();
        if (
          registrationOptions?.restoreWorkspace &&
          response.error?.code === "workspace-binding-unavailable"
        ) {
          deps.recordRuntimeEvent?.(
            "bus",
            "Bale follower auto-connect refused by leader: Workspace binding unavailable.",
            {
              phase: "follower-auto-connect-skip",
              reason: "leader-binding-unavailable",
            },
          );
          return false;
        }
        throw new Error(
          response.message ??
            "Bale bus follower registration was rejected.",
        );
      }
      if (response?.kind === "bus.ack" && response.ok) {
        const registrationResult = parseRegistrationResult(response.result);
        deps.registrationState?.setRegistered(true, registrationResult.target, {
          ...registrationResult,
          generation: registrationGeneration,
          sessionId,
          ...(response.protocol ? { leaderProtocol: response.protocol } : {}),
        });
        lastKnownTarget = registrationResult.target;
        lastKnownSlot = registrationResult.slot;
        lastKnownThreadName = registrationResult.threadName;
        activeLeaderSocketPath = leaderSocketPath;
        activeRegistrationGeneration = registrationGeneration;
        activeContext = ctx;
        try {
          await deps.onRegistered?.(ctx);
        } catch (error) {
          if (!isCurrentRequest()) {
            await abandonOwnedRequest();
            return false;
          }
          await failRegistration(true);
          throw error;
        }
        if (!isCurrentRequest()) {
          await abandonOwnedRequest();
          return false;
        }
        await requestHeartbeat();
        if (!isCurrentRequest()) {
          await abandonOwnedRequest();
          return false;
        }
        startHeartbeat(leaderSocketPath);
        if (
          pendingHandoffOptions &&
          getBaleFollowerSessionHandoff()?.instanceId ===
            pendingHandoffOptions.previousInstanceId
        ) {
          setBaleFollowerSessionHandoff(undefined);
        }
        return true;
      }
      await failRegistration();
      return false;
    },
    setContext(ctx) {
      // Pi hands every event a fresh context object. Only a replaced session drops an in-flight attempt.
      if (
        registrationAttempt &&
        (registrationAttempt.sessionGeneration !==
          deps.getSessionGeneration?.() ||
          registrationAttempt.sessionId !== deps.getSessionId?.(ctx))
      )
        registrationAttempt = undefined;
      activeContext = ctx;
    },
    async setThreadDisplayMode(mode) {
      const socketPath = activeLeaderSocketPath;
      const generation = activeRegistrationGeneration;
      const auth = activeAuthSecret;
      if (
        !socketPath ||
        !generation ||
        !deps.registrationState?.isRegistered()
      ) {
        throw new Error("Bale follower is not registered with the leader.");
      }
      const requiredCapability =
        mode === "directory-snake" || mode === "directory-title"
          ? BALE_BUS_CAPABILITY_DIRECTORY_DISPLAY_FORMAT
          : BALE_BUS_CAPABILITY_THREAD_DISPLAY_MODE;
      if (
        !hasBaleBusCapability(deps.protocolIdentity, requiredCapability) ||
        !hasBaleBusCapability(
          deps.registrationState.getLeaderProtocol(),
          requiredCapability,
        )
      ) {
        throw new Error(
          "The Bale peers do not support this Thread display setting. Update or restart both instances.",
        );
      }
      const requestId = deps.createRequestId();
      const response = await sendBaleBusLocalEnvelope({
        socketPath,
        timeoutMs: registrationTimeoutMs,
        envelope: {
          kind: "follower.setThreadDisplayMode",
          requestId,
          auth,
          instanceId: deps.instanceId,
          registrationGeneration: generation,
          mode,
        },
      });
      if (
        activeLeaderSocketPath !== socketPath ||
        activeRegistrationGeneration !== generation ||
        activeAuthSecret !== auth ||
        deps.registrationState.getGeneration() !== generation
      ) {
        throw new Error(
          "Bale Thread display setting completed for a stale registration.",
        );
      }
      if (
        response?.kind !== "bus.ack" ||
        !response.ok ||
        response.requestId !== requestId ||
        !isRecord(response.result) ||
        response.result.mode !== mode
      ) {
        throw new Error(
          response?.kind === "bus.ack"
            ? (response.message ??
                "Bale Thread display setting was rejected.")
            : "Bale Thread display setting was not acknowledged.",
        );
      }
    },
    async renameThread(target, threadName) {
      if (!activeLeaderSocketPath || !activeRegistrationGeneration) {
        throw new Error("Bale follower is not registered with the leader.");
      }
      if (
        deps.registrationState &&
        !hasBaleBusCapability(
          deps.registrationState.getLeaderProtocol(),
          BALE_BUS_CAPABILITY_WORKSPACE_THREAD_RENAME,
        )
      ) {
        throw new Error(
          "The active Bale leader does not support Workspace Thread rename. Update or restart that Pi instance.",
        );
      }
      const expectedLeaderSocketPath = activeLeaderSocketPath;
      const expectedRegistrationGeneration = activeRegistrationGeneration;
      const expectedAuthSecret = activeAuthSecret;
      const response = await sendBaleBusOperation(
        expectedLeaderSocketPath,
        registrationTimeoutMs,
        {
          kind: "follower.renameThread",
          requestId: deps.createRequestId(),
          auth: expectedAuthSecret,
          instanceId: deps.instanceId,
          registrationGeneration: expectedRegistrationGeneration,
          target,
          threadName,
          sentAtMs: getNowMs(),
        },
      );
      if (response?.kind !== "bus.ack" || !response.ok) {
        throw new Error(
          response?.kind === "bus.ack"
            ? (response.message ??
                "Bale Workspace Thread rename was rejected.")
            : "Bale Workspace Thread rename was not acknowledged.",
        );
      }
      if (
        !isLeaderSessionCurrent(
          expectedLeaderSocketPath,
          expectedRegistrationGeneration,
        )
      ) {
        throw new Error(
          "Bale Workspace Thread rename completed for a stale follower registration.",
        );
      }
      const renamedThreadName =
        response.result &&
        typeof response.result === "object" &&
        "threadName" in response.result &&
        typeof response.result.threadName === "string"
          ? response.result.threadName
          : threadName;
      const registrationTarget = deps.registrationState?.getTarget();
      if (deps.registrationState && registrationTarget) {
        deps.registrationState.setRegistered(true, registrationTarget, {
          slot: deps.registrationState.getSlot(),
          threadName: renamedThreadName,
          generation: expectedRegistrationGeneration,
          leaderProtocol: deps.registrationState.getLeaderProtocol(),
        });
      }
      return renamedThreadName;
    },
    async resetThreadName(target) {
      if (!activeLeaderSocketPath || !activeRegistrationGeneration) {
        throw new Error("Bale follower is not registered with the leader.");
      }
      if (
        deps.registrationState &&
        !hasBaleBusCapability(
          deps.registrationState.getLeaderProtocol(),
          BALE_BUS_CAPABILITY_WORKSPACE_THREAD_RENAME,
        )
      ) {
        throw new Error(
          "The active Bale leader does not support Workspace Thread reset. Update or restart that Pi instance.",
        );
      }
      const expectedLeaderSocketPath = activeLeaderSocketPath;
      const expectedRegistrationGeneration = activeRegistrationGeneration;
      const response = await sendBaleBusOperation(
        expectedLeaderSocketPath,
        registrationTimeoutMs,
        {
          kind: "follower.resetThreadName",
          requestId: deps.createRequestId(),
          auth: activeAuthSecret,
          instanceId: deps.instanceId,
          registrationGeneration: expectedRegistrationGeneration,
          target,
          sentAtMs: getNowMs(),
        },
      );
      const resetName =
        response?.kind === "bus.ack" &&
        response.ok &&
        response.result &&
        typeof response.result === "object" &&
        "threadName" in response.result &&
        typeof response.result.threadName === "string"
          ? response.result.threadName
          : undefined;
      if (!resetName) {
        throw new Error(
          response?.kind === "bus.ack"
            ? (response.message ??
                "Bale Workspace Thread reset was rejected.")
            : "Bale Workspace Thread reset was not acknowledged.",
        );
      }
      if (
        !isLeaderSessionCurrent(
          expectedLeaderSocketPath,
          expectedRegistrationGeneration,
        )
      ) {
        throw new Error(
          "Bale Workspace Thread reset completed for a stale follower registration.",
        );
      }
      const registrationTarget = deps.registrationState?.getTarget();
      if (deps.registrationState && registrationTarget) {
        deps.registrationState.setRegistered(true, registrationTarget, {
          slot: deps.registrationState.getSlot(),
          threadName: resetName,
          generation: expectedRegistrationGeneration,
          leaderProtocol: deps.registrationState.getLeaderProtocol(),
        });
      }
      return resetName;
    },
    async requestSessionReplacement(operation, intent) {
      if (!activeLeaderSocketPath || !activeRegistrationGeneration) {
        throw new Error("Bale follower is not registered with the leader.");
      }
      if (
        !hasBaleBusCapability(
          deps.protocolIdentity,
          BALE_BUS_CAPABILITY_SESSION_REPLACEMENT_INTENT,
        ) ||
        !hasBaleBusCapability(
          deps.registrationState?.getLeaderProtocol(),
          BALE_BUS_CAPABILITY_SESSION_REPLACEMENT_INTENT,
        )
      ) {
        throw new Error(
          "The active Bale leader does not support follower session replacement. Update or restart that Pi instance.",
        );
      }
      const expectedLeaderSocketPath = activeLeaderSocketPath;
      const expectedRegistrationGeneration = activeRegistrationGeneration;
      const expectedAuthSecret = activeAuthSecret;
      const requestId = deps.createRequestId();
      const response = await sendBaleBusOperation(
        expectedLeaderSocketPath,
        registrationTimeoutMs,
        {
          kind:
            operation === "publish"
              ? "follower.publishSessionReplacement"
              : "follower.settleSessionReplacement",
          requestId,
          auth: expectedAuthSecret,
          instanceId: deps.instanceId,
          registrationGeneration: expectedRegistrationGeneration,
          intent,
          sentAtMs: getNowMs(),
        },
      );
      if (
        response?.kind !== "bus.ack" ||
        !response.ok ||
        response.requestId !== requestId ||
        !isRecord(response.result) ||
        response.result.committed !== true
      ) {
        throw new Error(
          response?.kind === "bus.ack"
            ? (response.message ?? "Bale session replacement was rejected.")
            : "Bale session replacement was not acknowledged.",
        );
      }
      if (
        !isLeaderSessionCurrent(
          expectedLeaderSocketPath,
          expectedRegistrationGeneration,
        ) ||
        activeAuthSecret !== expectedAuthSecret
      ) {
        throw new Error(
          "Bale session replacement completed for a stale follower registration.",
        );
      }
      return true;
    },
    async disconnectFromLeader() {
      if (!activeLeaderSocketPath || !activeRegistrationGeneration) {
        return false;
      }
      const response = await sendBaleBusOperation(
        activeLeaderSocketPath,
        registrationTimeoutMs,
        {
          kind: "follower.disconnect",
          requestId: deps.createRequestId(),
          auth: activeAuthSecret,
          instanceId: deps.instanceId,
          registrationGeneration: activeRegistrationGeneration,
          sentAtMs: getNowMs(),
        },
      );
      if (response?.kind === "bus.ack" && response.ok) return true;
      throw new Error(
        response?.kind === "bus.ack"
          ? (response.message ?? "Bale follower disconnect was rejected.")
          : "Bale follower disconnect was not acknowledged.",
      );
    },
    stop,
  };
}

const BALE_FOLLOWER_FORWARD_BATCH_POSITION_FIELD =
  "pi_bale_forward_comment_batch_position";

/** Bind source-owned sender checks to the journal's already-admitted synchronous v1 hook. */
export function createBaleBusFollowerPairedAdmission(deps: {
  profileName: string;
  tokenSha256: string;
  configStore: Pick<BaleConfigStore, "withPairedUserAdmission">;
  assertExecutionCurrent: () => void;
}): NonNullable<BaleUpdateJournalStoreOptions["withPairedAdmission"]> {
  return (updates, publish) => {
    if (updates.length !== 1) return { admitted: false };
    const update = updates[0]!;
    const keys = Object.keys(update).filter(
      (key) =>
        key !== "update_id" &&
        key !== BALE_FOLLOWER_FORWARD_BATCH_POSITION_FIELD,
    );
    if (keys.length !== 1) return { admitted: false };
    const kind = keys[0];
    if (
      kind !== "message" &&
      kind !== "edited_message" &&
      kind !== "callback_query" &&
      kind !== "message_reaction"
    )
      return { admitted: false };
    const position = update[BALE_FOLLOWER_FORWARD_BATCH_POSITION_FIELD];
    if (
      position !== undefined &&
      (kind !== "message" || (position !== "comment" && position !== "forward"))
    )
      return { admitted: false };
    const carrier = update[kind];
    if (
      !Number.isSafeInteger(update.update_id) ||
      update.update_id < 0 ||
      !isRecord(carrier) ||
      carrier.pi_bale_source_update_id !== update.update_id ||
      carrier.sender_chat !== undefined ||
      carrier.actor_chat !== undefined
    )
      return { admitted: false };
    const sender = kind === "message_reaction" ? carrier.user : carrier.from;
    if (
      !isRecord(sender) ||
      typeof sender.id !== "number" ||
      !Number.isSafeInteger(sender.id) ||
      sender.id <= 0 ||
      sender.is_bot !== false
    )
      return { admitted: false };
    return deps.configStore.withPairedUserAdmission(
      deps.profileName,
      deps.tokenSha256,
      sender.id,
      publish,
      deps.assertExecutionCurrent,
    );
  };
}

/** One authenticated local operation request with the shared operation retry policy; no replay semantics. */
function sendBaleBusOperation(
  socketPath: string,
  timeoutMs: number,
  envelope: BaleBusEnvelope,
  assertAuthority?: () => void,
) {
  return sendBaleBusLocalEnvelope({
    socketPath,
    timeoutMs,
    envelope,
    assertAuthority,
    retry: assertAuthority ? { attempts: 1, delayMs: 0 } : getBaleBusTransportRetryPolicy({
      endpoint: socketPath,
      operation: "operation",
    }),
  });
}

export function prepareBaleBusFollowerJournaledUpdateForExecution<
  TUpdate extends { message?: unknown } & Record<string, unknown>,
>(
  update: TUpdate,
  prepareForwardedMessage: (
    message: NonNullable<TUpdate["message"]>,
    position: "comment" | "forward",
  ) => void,
): TUpdate {
  const position = update[BALE_FOLLOWER_FORWARD_BATCH_POSITION_FIELD];
  if (
    update.message !== undefined &&
    (position === "comment" || position === "forward")
  ) {
    prepareForwardedMessage(
      update.message as NonNullable<TUpdate["message"]>,
      position,
    );
  }
  if (position === undefined) return update;
  const prepared = { ...update };
  delete prepared[BALE_FOLLOWER_FORWARD_BATCH_POSITION_FIELD];
  return prepared;
}

type LiveRebindCarrierEnvelope = Pick<
  Extract<BaleBusEnvelope, { kind: "leader.settleLiveRebind" }>,
  | "operationId"
  | "recipientInstanceId"
  | "recipientSessionId"
  | "recipientRegistrationGeneration"
  | "recipientBindingKey"
  | "sourceUpdateIds"
  | "selectedCommand"
  | "preparedSource"
>;

/** Copy the captured command target for the native owner; ordinary input supplies no target constraint. */
function copyLiveRebindCommandTarget(
  saved: BaleBusLiveRebindSaveObservation,
): { expectedTarget?: BaleTarget & { threadId: number } } {
  return saved.selectedCommand
    ? { expectedTarget: { ...saved.selectedCommand.target } }
    : {};
}

/** Exact operation/recipient/source agreement between a retained save and a later request; identity only, never currency. */
function matchesLiveRebindCarrier(
  saved: BaleBusLiveRebindSaveObservation,
  envelope: LiveRebindCarrierEnvelope,
): boolean {
  return (
    saved.operationId === envelope.operationId &&
    saved.recipient.instanceId === envelope.recipientInstanceId &&
    saved.recipient.sessionId === envelope.recipientSessionId &&
    saved.recipient.generation === envelope.recipientRegistrationGeneration &&
    saved.recipient.bindingKey === envelope.recipientBindingKey &&
    isDeepStrictEqual(
      saved.sourceUpdateIds,
      [...envelope.sourceUpdateIds].sort((a, b) => a - b),
    )
  );
}

/** Exact branch agreement: a command record requires its saved proof; ordinary input refuses any proof. */
function matchesLiveRebindBranch(
  saved: BaleBusLiveRebindSaveObservation,
  status: boolean,
  envelope: LiveRebindCarrierEnvelope,
): boolean {
  return (
    isDeepStrictEqual(saved.selectedCommand, envelope.selectedCommand) &&
    (status
      ? isDeepStrictEqual(saved.preparedSource, envelope.preparedSource)
      : envelope.preparedSource === undefined)
  );
}

/** Existing Commands/menu assembly preflights the copied input and captures independent recipient/transport owners. */
export interface BaleBusFollowerCommandOwner<TContext> {
  isCurrent(): boolean;
  assertRecipientCurrent(): void;
  prepare(
    readiness: BaleLiveSourceCompletionReadiness,
    ctx: TContext,
    input: {
      target: BaleTarget & { threadId: number };
      assertSourceCurrent(): void;
      assertRecipientCurrent(): void;
    },
  ): BalePreparedHeldCommand | undefined;
}

/** One current warm preparation, not a prompt queue or restart recovery record. */
export function createBaleBusFollowerLiveRebindRuntime<TContext>(deps: {
  getAdmission(
    ctx: TContext,
  ):
    | Pick<
        BaleUpdateAdmissionLifecycleRuntime<TContext>,
        "prepareLiveInput" | "appendBatch" | "getJournalBindingKey"
      >
    | undefined;
  applyTarget?: (
    ...args: Parameters<
      ReturnType<
        typeof createBaleBusFollowerWorkspaceRestoreHandler<TContext>
      >
    >
  ) => ReturnType<
    ReturnType<
      typeof createBaleBusFollowerWorkspaceRestoreHandler<TContext>
    >
  >;
  observeWork?: (
    oldTarget: BaleTarget & { threadId: number },
    ctx: TContext,
  ) => BaleBusLiveRebindWorkState;
  /** Pure preflight: undefined refuses before hold/append; this port never activates future recipient authority. */
  getCommandOwner?: (
    input: Readonly<
      Omit<
        Extract<BaleBusEnvelope, { kind: "leader.prepareLiveRebind" }>,
        "kind" | "auth" | "requestId" | "sentAtMs"
      >
    >,
    ctx: TContext,
  ) => BaleBusFollowerCommandOwner<TContext> | undefined;
}) {
  type Status = {
    owner: BaleBusFollowerCommandOwner<TContext>;
    current(): boolean;
    prepare: BaleBusFollowerCommandOwner<TContext>["prepare"];
    recipient: () => void;
    attempted?: true;
    plan?: BalePreparedHeldCommand;
    ports?: Pick<
      BalePreparedHeldCommand,
      "bindCarrier" | "execute" | "inspectCompletion"
    >;
    result?: "completed" | "unknown";
  };
  let retained:
    | {
        operationId: string;
        digest: string;
        current(): boolean;
        held: BaleLiveInputPreparation;
        ctx: TContext;
        observation: BaleBusLiveRebindSaveObservation;
        applyIssued?: true;
        applying?: true;
        settling?: true;
        outcome?: BaleBusLiveRebindSettlementObservation;
        status?: Status;
      }
    | undefined;
  const runtime = {
    save(
      envelope: Extract<
        BaleBusEnvelope,
        { kind: "leader.prepareLiveRebind" }
      >,
      ctx: TContext,
      isCurrent: () => boolean,
    ): BaleBusLiveRebindSaveObservation {
      const captured = structuredClone(envelope),
        selectedCommand = captured.selectedCommand;
      const heldMarker = selectedCommand,
        getCommandOwner = heldMarker ? deps.getCommandOwner : undefined,
        applyOwner = deps.applyTarget;
      if (
        heldMarker !== undefined &&
        (!getCommandOwner || !applyOwner || captured.updates.length !== 1)
      )
        throw new Error("Selected command native consumption is unavailable.");
      const admission = deps.getAdmission(ctx),
        prepareInput = admission?.prepareLiveInput,
        append = admission?.appendBatch;
      let status =
        retained?.operationId === captured.operationId
          ? retained.status
          : undefined;
      const current = () =>
        isCurrent() &&
        deps.getAdmission(ctx) === admission &&
        admission?.getJournalBindingKey() === captured.recipientBindingKey &&
        (!heldMarker ||
          (deps.getCommandOwner === getCommandOwner &&
            deps.applyTarget === applyOwner &&
            admission?.prepareLiveInput === prepareInput &&
            admission?.appendBatch === append &&
            !!status?.current()));
      if (
        retained?.status &&
        retained.operationId !== captured.operationId &&
        retained.outcome?.status === "released" &&
        (retained.status.result !== "completed" ||
          !retained.status.ports?.inspectCompletion.call(retained.status.plan))
      )
        throw new Error(
          "Released held command is unconfirmed; no carrier replacement.",
        );
      if (heldMarker && !status) {
        const {
          recipientInstanceId,
          recipientRegistrationGeneration,
          recipientSessionId,
          recipientBindingKey,
          operationId,
          updates,
        } = captured;
        const owner = getCommandOwner!(
          structuredClone({
            recipientInstanceId,
            recipientRegistrationGeneration,
            recipientSessionId,
            recipientBindingKey,
            operationId,
            updates,
            selectedCommand,
          }),
          ctx,
        );
        if (
          !owner ||
          typeof owner.isCurrent !== "function" ||
          typeof owner.prepare !== "function" ||
          typeof owner.assertRecipientCurrent !== "function"
        )
          throw new Error("Selected command preparation owner is unavailable.");
        const ports = {
          isCurrent: owner.isCurrent,
          prepare: owner.prepare,
          assertRecipientCurrent: owner.assertRecipientCurrent,
        };
        status = {
          owner,
          current: () =>
            Object.entries(ports).every(
              ([key, value]) => Reflect.get(owner, key) === value,
            ) &&
            (!status?.plan ||
              Object.entries(status.ports!).every(
                ([key, value]) => Reflect.get(status!.plan!, key) === value,
              )) &&
            ports.isCurrent.call(owner),
          prepare: ports.prepare,
          recipient: ports.assertRecipientCurrent,
        };
      }
      if (!admission?.prepareLiveInput || !current())
        throw new Error("Live-rebind recipient admission is unavailable.");
      const digest = createHash("sha256")
        .update(JSON.stringify(captured.updates))
        .digest("hex");
      if (retained?.status && !retained.current())
        throw new Error(
          "Prepared command authority changed; no replacement adoption.",
        );
      if (
        retained &&
        (!retained.current() ||
          (retained.operationId !== envelope.operationId &&
            (retained.outcome?.status === "released" ||
              retained.outcome?.status === "discarded")))
      )
        retained = undefined;
      if (
        heldMarker &&
        retained &&
        (retained.ctx !== ctx ||
          retained.observation.recipient.instanceId !==
            captured.recipientInstanceId ||
          retained.observation.recipient.sessionId !==
            captured.recipientSessionId ||
          retained.observation.recipient.generation !==
            captured.recipientRegistrationGeneration ||
          retained.observation.recipient.bindingKey !==
            captured.recipientBindingKey)
      )
        throw new Error("Selected command saved recipient changed.");
      if (
        retained &&
        (retained.operationId !== captured.operationId ||
          retained.digest !== digest ||
          !isDeepStrictEqual(
            retained.observation.selectedCommand,
            selectedCommand,
          ))
      )
        throw new Error(
          "Another live-rebind input or branch is already prepared.",
        );
      if (!retained) {
        const held = admission.prepareLiveInput(
          ctx,
          captured.updates.map((update) => update.update_id),
          current,
        );
        if (!held)
          throw new Error("Live-rebind recipient input cannot be prepared.");
        if (heldMarker && !held.canPrepareStatusConsumption?.()) {
          held.cancelEmpty();
          throw new Error(
            "Selected command native consumption is unavailable.",
          );
        }
        retained = {
          operationId: captured.operationId,
          digest,
          current,
          held,
          ctx,
          ...(status ? { status } : {}),
          observation: {
            operationId: captured.operationId,
            recipient: {
              instanceId: captured.recipientInstanceId,
              sessionId: captured.recipientSessionId,
              generation: captured.recipientRegistrationGeneration,
              bindingKey: captured.recipientBindingKey,
            },
            sourceUpdateIds: [...held.sourceUpdateIds].sort((a, b) => a - b),
            ...(selectedCommand
              ? { selectedCommand: structuredClone(selectedCommand) }
              : {}),
            status: "saved",
          },
        };
        try {
          admission.appendBatch(captured.updates);
        } catch (error) {
          if (!held.confirmSaved()) throw error;
        }
      }
      if (!current() || !retained.held.confirmSaved())
        throw new Error("Live-rebind recipient save is unconfirmed.");
      if (status && !status.plan) {
        if (status.attempted)
          throw new Error(
            "Selected command preparation is unconfirmed; no replay.",
          );
        status.attempted = true;
        const record = retained,
          readiness = record.held.prepareSourceCompletion?.();
        const assertSourceCurrent = () => {
          if (
            retained !== record ||
            !record.current() ||
            !record.held.isOwnerCurrent()
          )
            throw new Error("Selected command source owner changed.");
        };
        const plan =
          readiness &&
          status.prepare.call(status.owner, readiness, ctx, {
            target: { ...heldMarker!.target },
            assertSourceCurrent,
            assertRecipientCurrent: status.recipient,
          });
        if (
          !plan ||
          !current() ||
          !record.held.confirmSaved() ||
          !isDeepStrictEqual(plan.source, readiness!.snapshot.source) ||
          [plan.bindCarrier, plan.execute, plan.inspectCompletion].some(
            (port) => typeof port !== "function",
          )
        )
          throw new Error("Selected command plan is unavailable.");
        status.plan = plan;
        status.ports = {
          bindCarrier: plan.bindCarrier,
          execute: plan.execute,
          inspectCompletion: plan.inspectCompletion,
        };
        const continuation = {
          source: plan.source,
          assertCurrent() {
            assertSourceCurrent();
            if (record.outcome?.status !== "released")
              throw new Error(
                "Selected command has no confirmed peer release.",
              );
            status!.recipient.call(status!.owner);
          },
          bindCarrier: status.ports.bindCarrier.bind(plan),
          async execute() {
            status!.result = "unknown";
            const completed = await status!.ports!.execute.call(plan);
            if (completed && record.current() && record.held.isOwnerCurrent())
              status!.result = "completed";
            return completed;
          },
        };
        if (
          !record.held.prepareStatusConsumption?.(continuation) ||
          !current()
        ) {
          delete status.plan;
          delete status.ports;
          throw new Error("Selected command consumption is unconfirmed.");
        }
        record.observation.preparedSource = { ...plan.source };
      }
      return structuredClone(retained.observation);
    },
    async apply(
      envelope: Extract<
        BaleBusEnvelope,
        { kind: "leader.applyLiveRebind" }
      >,
      ctx: TContext,
      isCurrent: () => boolean,
    ): Promise<BaleBusLiveRebindApplyObservation> {
      const record = retained;
      if (envelope.selectedCommand !== undefined && !record?.status?.plan)
        throw new Error("Selected command native consumption is unavailable.");
      const current = () =>
        retained === record &&
        !!record &&
        record.ctx === ctx &&
        record.current() &&
        isCurrent() &&
        record.held.isCurrent() &&
        matchesLiveRebindBranch(record.observation, !!record.status, envelope);
      if (
        !record ||
        !current() ||
        !record.held.confirmSaved() ||
        !deps.applyTarget ||
        record.applying ||
        record.settling ||
        !matchesLiveRebindCarrier(record.observation, envelope)
      )
        throw new Error(
          "Live-rebind apply has no exact current saved carrier.",
        );
      const mode =
        envelope.mode === "apply" && !record.applyIssued ? "apply" : "inspect";
      if (mode === "apply") record.applyIssued = true;
      record.applying = true;
      try {
        const observation = await deps.applyTarget(
          {
            operationId: record.operationId,
            registrationGeneration: envelope.recipientRegistrationGeneration,
            mode,
            liveRebind: {
              sourceUpdateIds: record.observation.sourceUpdateIds,
              isCurrent: current,
              ...copyLiveRebindCommandTarget(record.observation),
            },
          },
          ctx,
        );
        if (
          !current() ||
          !record.held.confirmSaved() ||
          observation.operationId !== record.operationId ||
          observation.recipient.instanceId !== envelope.recipientInstanceId ||
          observation.recipient.sessionId !== envelope.recipientSessionId ||
          observation.recipient.generation !==
            envelope.recipientRegistrationGeneration
        )
          throw new Error("Live-rebind apply observation changed.");
        return {
          ...structuredClone(record.observation),
          target: { ...observation.target },
          slot: observation.slot,
          status: observation.ready ? "applied" : "saved",
        };
      } finally {
        delete record.applying;
      }
    },
    async settle(
      envelope: Extract<
        BaleBusEnvelope,
        { kind: "leader.settleLiveRebind" }
      >,
      ctx: TContext,
      isCurrent: () => boolean,
    ): Promise<
      | BaleBusLiveRebindSettlementObservation
      | BaleBusLiveRebindWorkObservation
      | BaleBusLiveRebindCommandObservation
    > {
      if (envelope.mode === "observe-command")
        return inspectCommandCompletion(envelope, ctx, isCurrent);
      const record = retained,
        status = record?.status,
        plan = status?.plan;
      if (envelope.selectedCommand !== undefined && !plan)
        throw new Error("Selected command native consumption is unavailable.");
      // Only the marked read-only held work sample may outlive the source worker, through the captured recipient owner.
      const commandWork =
        envelope.mode === "observe" && envelope.selectedCommand !== undefined;
      const recipientCurrent = () => {
        if (
          record?.status !== status ||
          status?.plan !== plan ||
          !status?.current()
        )
          return false;
        try {
          status.recipient.call(status.owner);
          return true;
        } catch {
          return false;
        }
      };
      const current = () =>
        retained === record &&
        !!record &&
        record.ctx === ctx &&
        record.current() &&
        isCurrent() &&
        (commandWork ? recipientCurrent() : record.held.isOwnerCurrent()) &&
        matchesLiveRebindBranch(record.observation, !!record.status, envelope);
      if (
        !record ||
        !current() ||
        record.applying ||
        record.settling ||
        !matchesLiveRebindCarrier(record.observation, envelope)
      )
        throw new Error("Live-rebind settlement has no exact current carrier.");
      if (envelope.mode === "observe" || envelope.mode === "observe-held") {
        const beforeRelease = envelope.mode === "observe-held";
        if (
          (beforeRelease ? !!record.outcome || !record.applyIssued || !record.held.confirmSaved() : record.outcome?.status !== "released") ||
          !deps.applyTarget ||
          !deps.observeWork ||
          !envelope.oldTarget
        )
          throw new Error(
            "Live-rebind work observation has no released carrier or observer.",
          );
        const oldTarget = { ...envelope.oldTarget };
        let work: BaleBusLiveRebindWorkState | undefined;
        record.settling = true;
        try {
          await deps.applyTarget(
            {
              operationId: record.operationId,
              registrationGeneration: envelope.recipientRegistrationGeneration,
              mode: "inspect",
              liveRebind: {
                sourceUpdateIds: record.observation.sourceUpdateIds,
                isCurrent: current,
                ...copyLiveRebindCommandTarget(record.observation),
                observeWork(canonicalOldTarget) {
                  if (
                    !current() ||
                    !isDeepStrictEqual(canonicalOldTarget, oldTarget)
                  )
                    throw new Error("Live-rebind old work target changed.");
                  work = structuredClone(
                    deps.observeWork!(canonicalOldTarget, ctx),
                  );
                  if (
                    !current() ||
                    !isDeepStrictEqual(canonicalOldTarget, oldTarget)
                  )
                    throw new Error(
                      "Live-rebind work observer authority or target changed.",
                    );
                },
              },
            },
            ctx,
          );
          if (!current() || !work)
            throw new Error("Live-rebind work observation is unconfirmed.");
          // Unfinished or unconfirmed selected execution stays unknown; later settled delivery cannot clear it.
          if (!beforeRelease && commandWork && status!.result !== "completed")
            work.unknown = true;
          if (!current())
            throw new Error("Live-rebind work observer authority changed.");
          return {
            ...structuredClone(record.observation),
            status: "observed",
            oldTarget,
            work,
          };
        } finally {
          delete record.settling;
        }
      }
      const action = envelope.mode;
      if (record.outcome) {
        if (record.outcome.action !== envelope.mode)
          throw new Error("Live-rebind input already has another disposition.");
        return structuredClone(record.outcome);
      }
      record.settling = true;
      const observation = (
        status: BaleBusLiveRebindSettlementObservation["status"],
      ): BaleBusLiveRebindSettlementObservation => ({
        ...structuredClone(record.observation),
        action,
        status,
      });
      try {
        if (envelope.mode === "discard") {
          record.outcome = observation("unknown");
          const status = record.held.discardSaved(current);
          record.outcome =
            status === "protected" ? undefined : observation(status);
          if (!current())
            throw new Error("Live-rebind disposal authority changed.");
          return observation(status);
        }
        if (
          !record.held.isCurrent() ||
          !record.held.confirmSaved() ||
          !deps.applyTarget
        )
          throw new Error("Live-rebind input cannot be released.");
        await deps.applyTarget(
          {
            operationId: record.operationId,
            registrationGeneration: envelope.recipientRegistrationGeneration,
            mode: "inspect",
            liveRebind: {
              sourceUpdateIds: record.observation.sourceUpdateIds,
              isCurrent: current,
              ...copyLiveRebindCommandTarget(record.observation),
              release(canRelease, target) {
                if (!target) throw new Error("Live-rebind release target is unconfirmed.");
                record.outcome = observation("unknown");
                record.outcome = record.held.release(
                  () => current() && canRelease(),
                  target,
                )
                  ? observation("released")
                  : undefined;
              },
            },
          },
          ctx,
        );
        if (!current())
          throw new Error("Live-rebind release authority changed.");
        return structuredClone(record.outcome ?? observation("protected"));
      } finally {
        delete record.settling;
      }
    },
  };
  async function inspectCommandCompletion(
    envelope: Extract<BaleBusEnvelope, { kind: "leader.settleLiveRebind" }>,
    ctx: TContext,
    isCurrent: () => boolean,
  ): Promise<BaleBusLiveRebindCommandObservation> {
    const record = retained;
    const current = () =>
      retained === record &&
      !!record?.status?.plan &&
      record.ctx === ctx &&
      record.current() &&
      record.held.isOwnerCurrent() &&
      isCurrent() &&
      matchesLiveRebindBranch(record.observation, true, envelope);
    if (
      !record?.status?.plan ||
      !deps.applyTarget ||
      !current() ||
      record.outcome?.status !== "released" ||
      record.applying ||
      record.settling ||
      !matchesLiveRebindCarrier(record.observation, envelope)
    )
      throw new Error(
        "Selected command completion has no exact released carrier.",
      );
    record.settling = true;
    try {
      const assertRecipient = () => {
        record.status!.recipient.call(record.status!.owner);
        if (!current())
          throw new Error("Selected command completion recipient changed.");
      };
      assertRecipient();
      const observed = await deps.applyTarget(
        {
          operationId: record.operationId,
          registrationGeneration: record.observation.recipient.generation,
          mode: "inspect",
          liveRebind: {
            sourceUpdateIds: record.observation.sourceUpdateIds,
            expectedTarget: { ...record.observation.selectedCommand!.target },
            isCurrent: current,
          },
        },
        ctx,
      );
      if (!observed.ready || !current())
        throw new Error("Selected command completion target is unconfirmed.");
      assertRecipient();
      const sourceAck = record.status.ports!.inspectCompletion.call(
        record.status.plan,
      );
      assertRecipient();
      if (
        sourceAck &&
        !isDeepStrictEqual(sourceAck, record.observation.preparedSource)
      )
        throw new Error("Selected command completion exact ACK changed.");
      const settled = {
        preparedSource: { ...record.observation.preparedSource! },
        command: record.status.result ?? ("not-issued" as const),
        ...(sourceAck ? { sourceAck: { ...sourceAck } } : {}),
      };
      const { selectedCommand } = record.observation;
      if (envelope.mode !== "observe-command" || !selectedCommand)
        throw new Error("Held completion mode does not match its marker.");
      return {
        ...structuredClone(record.observation),
        status: "command-observed",
        selectedCommand: structuredClone(selectedCommand),
        ...settled,
      };
    } finally {
      delete record.settling;
    }
  }
  return runtime;
}

export function createBaleBusFollowerDurableAdmissionRuntime<
  TContext,
>(deps: {
  journal: {
    appendBatch(
      updates: readonly ({ update_id: number } & Record<string, unknown>)[],
    ): unknown;
  };
  signalWorker: (ctx: TContext) => void;
  getNowMs?: () => number;
  /** Bounded process-local replay window; omit for the production 24 h / 4,096-delivery defaults. */
  recentDeliveryLimit?: { maxAgeMs: number; maxEntries: number };
}): BaleBusFollowerDurableAdmissionPort<TContext> {
  // The journal forgets a delivery once its worker completes; this window absorbs a leader retry after a lost ACK.
  const recentDeliveries = new Map<string, number>();
  const getNowMs = deps.getNowMs ?? Date.now;
  const limit = deps.recentDeliveryLimit ?? {
    maxAgeMs: 24 * 60 * 60 * 1000,
    maxEntries: 4096,
  };
  const pruneRecentDeliveries = (nowMs: number): void => {
    for (const [deliveryId, admittedAtMs] of recentDeliveries) {
      if (
        recentDeliveries.size <= limit.maxEntries &&
        nowMs - admittedAtMs < limit.maxAgeMs
      )
        break;
      recentDeliveries.delete(deliveryId);
    }
  };
  return {
    async admit(envelope, ctx) {
      const delivery = envelope.delivery;
      if (!delivery) {
        throw new Error(
          "Bale follower durable admission requires delivery identity.",
        );
      }
      if (envelope.kind === "leader.wakeInputCustody")
        throw new Error(
          "Bale follower custody wake cannot use executable-copy admission.",
        );
      const expected = createBaleBusFollowerDeliveryIdentity({
        kind: envelope.kind,
        recipientBindingKey: delivery.recipientBindingKey,
        sourceUpdateId: delivery.sourceUpdateId,
      });
      if (expected.deliveryId !== delivery.deliveryId) {
        throw new Error("Invalid Bale follower delivery id.");
      }
      const carrier =
        envelope.kind === "leader.forwardCallback"
          ? envelope.query
          : envelope.kind === "leader.forwardReaction"
            ? envelope.reactionUpdate
            : envelope.message;
      if (
        !isRecord(carrier) ||
        carrier.pi_bale_source_update_id !== delivery.sourceUpdateId
      ) {
        throw new Error(
          "Bale follower delivery source update id mismatch.",
        );
      }
      const update = {
        update_id: delivery.sourceUpdateId,
        ...(envelope.kind === "leader.forwardMessage" &&
        envelope.forwardCommentBatchPosition
          ? {
              [BALE_FOLLOWER_FORWARD_BATCH_POSITION_FIELD]:
                envelope.forwardCommentBatchPosition,
            }
          : {}),
        ...(envelope.kind === "leader.forwardCallback"
          ? { callback_query: carrier }
          : envelope.kind === "leader.forwardReaction"
            ? { message_reaction: carrier }
            : envelope.kind === "leader.forwardMessage"
              ? { message: carrier }
              : { edited_message: carrier }),
      };
      const result = {
        deliveryId: delivery.deliveryId,
        sourceUpdateId: delivery.sourceUpdateId,
      };
      pruneRecentDeliveries(getNowMs());
      if (recentDeliveries.has(delivery.deliveryId)) return result;
      deps.journal.appendBatch([update]);
      recentDeliveries.set(delivery.deliveryId, getNowMs());
      pruneRecentDeliveries(getNowMs());
      deps.signalWorker(ctx);
      return result;
    },
  };
}

export interface BaleBusFollowerInputCustodyBundle<TContext> {
  acceptHandoff(
    input: {
      sourceRecoveryKey: string;
      recipientBindingKey: string;
      source: {
        journalBindingKey: string;
        tokenSha256: string;
        updateId: number;
      };
      handoffId: string;
    },
    ctx: TContext,
  ): unknown;
  wakeSource(
    input: BaleBusFollowerDurableAdmissionResult & {
      recipientBindingKey: string;
      sourceRecoveryKey: string;
      sourceClaim: { acquisitionId: string; handoffId: string };
    },
    ctx: TContext,
  ): void;
  resolveForwardReference(input: {
    sourceUpdateId: number;
    recipientBindingKey: string;
  }):
    | {
        sourceRecoveryKey: string;
        source: {
          updateId: number;
          owner: {
            acquisitionId: string;
            handoffId: string;
          };
        };
      }
    | undefined;
}

export function createBaleBusFollowerInputCustodyPorts<TContext>(deps: {
  getInputCustodyBus():
    BaleBusFollowerInputCustodyBundle<TContext> | undefined;
}) {
  const getRequired = (): BaleBusFollowerInputCustodyBundle<TContext> => {
    const bundle = deps.getInputCustodyBus();
    if (!bundle)
      throw new Error("Bale input custody bus binding is unavailable.");
    return bundle;
  };
  return {
    isSourceReferenceAdmissionEnabled: () => Boolean(deps.getInputCustodyBus()),
    handleInputCustodyHandoff(
      envelope: Extract<
        BaleBusEnvelope,
        { kind: "leader.offerInputCustodyHandoff" }
      >,
      ctx: TContext,
    ) {
      return getRequired().acceptHandoff(
        {
          sourceRecoveryKey: envelope.sourceRecoveryKey,
          recipientBindingKey: envelope.recipientBindingKey,
          source: envelope.source,
          handoffId: envelope.handoffId,
        },
        ctx,
      );
    },
    sourceReferenceAdmission:
      createBaleBusFollowerSourceReferenceAdmissionRuntime<TContext>({
        wakeSource(input, ctx) {
          getRequired().wakeSource(input, ctx);
        },
      }),
    resolveInputCustodyReference(input: {
      sourceUpdateId: number;
      recipientBindingKey: string;
    }) {
      return deps.getInputCustodyBus()?.resolveForwardReference(input);
    },
  };
}

export function createBaleBusFollowerSourceReferenceAdmissionRuntime<
  TContext,
>(deps: {
  wakeSource: (
    input: BaleBusFollowerDurableAdmissionResult & {
      recipientBindingKey: string;
      sourceRecoveryKey: string;
      sourceClaim: { acquisitionId: string; handoffId: string };
    },
    ctx: TContext,
  ) => Promise<void> | void;
}): BaleBusFollowerDurableAdmissionPort<TContext> {
  return {
    async admit(envelope, ctx) {
      const delivery = envelope.delivery;
      if (!delivery)
        throw new Error(
          "Bale follower source-reference admission requires delivery identity.",
        );
      if (!delivery.sourceRecoveryKey)
        throw new Error(
          "Bale follower source-reference admission requires a recovery key.",
        );
      if (!delivery.sourceClaim)
        throw new Error(
          "Bale follower source-reference admission requires exact claim evidence.",
        );
      const expected = createBaleBusFollowerDeliveryIdentity({
        kind: envelope.kind,
        recipientBindingKey: delivery.recipientBindingKey,
        sourceUpdateId: delivery.sourceUpdateId,
      });
      if (expected.deliveryId !== delivery.deliveryId)
        throw new Error(
          "Invalid Bale follower source-reference delivery id.",
        );
      const carrier =
        envelope.kind === "leader.wakeInputCustody"
          ? undefined
          : envelope.kind === "leader.forwardCallback"
            ? envelope.query
            : envelope.kind === "leader.forwardReaction"
              ? envelope.reactionUpdate
              : envelope.message;
      if (
        envelope.kind !== "leader.wakeInputCustody" &&
        (!isRecord(carrier) ||
          carrier.pi_bale_source_update_id !== delivery.sourceUpdateId)
      )
        throw new Error(
          "Bale follower source-reference update id mismatch.",
        );
      await deps.wakeSource(
        {
          deliveryId: delivery.deliveryId,
          sourceUpdateId: delivery.sourceUpdateId,
          recipientBindingKey: delivery.recipientBindingKey,
          sourceRecoveryKey: delivery.sourceRecoveryKey,
          sourceClaim: { ...delivery.sourceClaim },
        },
        ctx,
      );
      return {
        deliveryId: delivery.deliveryId,
        sourceUpdateId: delivery.sourceUpdateId,
      };
    },
  };
}

export function createBaleBusForwardedUpdateReceiverRuntime<TContext>(
  deps: BaleBusForwardedUpdateReceiverRuntimeDeps<TContext>,
): BaleBusForwardedUpdateReceiverRuntime {
  const server = createBaleBusLocalServer({
    socketPath: deps.socketPath,
    recordTransportEvent(phase, details) {
      deps.recordRuntimeEvent?.("bus", `Bale bus ${phase}`, {
        phase: `follower-receiver-${phase}`,
        ...details,
      });
    },
    async handleEnvelope(envelope) {
      const authSecret = deps.getAuthSecret?.();
      if (
        deps.getAuthSecret &&
        (!authSecret || !isBaleBusEnvelopeAuthorized(envelope, authSecret))
      ) {
        return createUnauthorizedBusAck(envelope.requestId);
      }
      if (
        (envelope.kind !== "leader.forwardCallback" &&
          envelope.kind !== "leader.forwardReaction" &&
          envelope.kind !== "leader.forwardMessage" &&
          envelope.kind !== "leader.forwardEditedMessage" &&
          envelope.kind !== "leader.wakeInputCustody" &&
          envelope.kind !== "leader.offerInputCustodyHandoff" &&
          envelope.kind !== "leader.workspaceRestore" &&
          envelope.kind !== "leader.prepareLiveRebind" &&
          envelope.kind !== "leader.applyLiveRebind" &&
          envelope.kind !== "leader.settleLiveRebind" &&
          envelope.kind !== "leader.offerQueueHandoff") ||
        envelope.recipientInstanceId !== deps.instanceId
      ) {
        return rejectBaleBusRequest(
          envelope.requestId,
          "Bale bus receiver cannot handle this envelope.",
        );
      }
      const registrationGeneration = deps.getRegistrationGeneration();
      if (
        !registrationGeneration ||
        envelope.recipientRegistrationGeneration !== registrationGeneration
      ) {
        return rejectBaleBusRequest(
          envelope.requestId,
          "Stale Bale bus follower registration generation.",
        );
      }
      if (
        envelope.kind === "leader.prepareLiveRebind" ||
        envelope.kind === "leader.applyLiveRebind" ||
        envelope.kind === "leader.settleLiveRebind"
      ) {
        const apply = envelope.kind !== "leader.prepareLiveRebind",
          settle = envelope.kind === "leader.settleLiveRebind";
        const commandInput = envelope.selectedCommand,
          commandEnabled = deps.isLiveRebindCommandSetEnabled;
        const required = [
          BALE_BUS_CAPABILITY_LIVE_REBIND_SAVE,
          ...(apply ? [BALE_BUS_CAPABILITY_LIVE_REBIND_APPLY] : []),
          ...(settle ? [BALE_BUS_CAPABILITY_LIVE_REBIND_SETTLE] : []),
          ...(envelope.kind === "leader.settleLiveRebind" && envelope.mode === "observe-held"
            ? [BALE_BUS_CAPABILITY_PRE_DISPATCH_REBIND_EXECUTION] : []),
          ...(commandInput
            ? [
                BALE_BUS_CAPABILITY_LIVE_REBIND_APPLY,
                BALE_BUS_CAPABILITY_LIVE_REBIND_SETTLE,
                ...getBaleBusHeldCommandCapabilities(commandInput.name),
              ]
            : []),
        ];
        const ctx = deps.getContext(),
          sessionId = deps.getSessionId?.(),
          bindingKey = deps.getLiveRebindJournalBindingKey?.();
        const protocol = structuredClone(deps.getLeaderProtocol?.()),
          localProtocol = structuredClone(deps.getLocalProtocol?.());
        const current = () =>
          !!authSecret &&
          deps.getAuthSecret?.() === authSecret &&
          deps.getContext() === ctx &&
          deps.getRegistrationGeneration() === registrationGeneration &&
          deps.getSessionId?.() === sessionId &&
          deps.getLiveRebindJournalBindingKey?.() === bindingKey &&
          deps.isLiveRebindSaveEnabled?.() === true &&
          (!apply || deps.isLiveRebindApplyEnabled?.() === true) &&
          (!settle || deps.isLiveRebindSettleEnabled?.() === true) &&
          (!commandInput ||
            (typeof commandEnabled === "function" &&
              deps.isLiveRebindCommandSetEnabled === commandEnabled &&
              commandEnabled())) &&
          isDeepStrictEqual(deps.getLeaderProtocol?.(), protocol) &&
          isDeepStrictEqual(deps.getLocalProtocol?.(), localProtocol);
        if (
          !authSecret ||
          !ctx ||
          !bindingKey ||
          sessionId !== envelope.recipientSessionId ||
          bindingKey !== envelope.recipientBindingKey ||
          !required.every(
            (cap) =>
              hasBaleBusCapability(protocol, cap) &&
              hasBaleBusCapability(localProtocol, cap),
          ) ||
          !localProtocol ||
          !getBaleBusProtocolCompatibility({
            local: localProtocol,
            remote: protocol,
          }).compatible ||
          !current() ||
          (settle
            ? !deps.handleLiveRebindSettle
            : apply
              ? !deps.handleLiveRebindApply
              : !deps.handleLiveRebindSave)
        )
          return rejectBaleBusRequest(
            envelope.requestId,
            "Live-rebind capability or recipient authority is unavailable.",
          );
        try {
          const result =
            envelope.kind === "leader.settleLiveRebind"
              ? await deps.handleLiveRebindSettle!(envelope, ctx, current)
              : envelope.kind === "leader.applyLiveRebind"
                ? await deps.handleLiveRebindApply!(envelope, ctx, current)
                : await deps.handleLiveRebindSave!(envelope, ctx, current);
          if (!current())
            throw new Error("Live-rebind receiver authority changed.");
          return {
            kind: "bus.ack",
            requestId: envelope.requestId,
            ok: true,
            result,
          };
        } catch (error) {
          deps.recordRuntimeEvent?.("bus", error, {
            phase: "follower-live-rebind-control",
          });
          return {
            kind: "bus.ack",
            requestId: envelope.requestId,
            ok: false,
            message:
              error instanceof Error
                ? error.message
                : "Live-rebind request failed.",
          };
        }
      }
      if (envelope.kind === "leader.workspaceRestore") {
        const ctx = deps.getContext();
        if (
          !authSecret ||
          !ctx ||
          !deps.isWorkspaceRestoreEnabled?.() ||
          !deps.handleWorkspaceRestore
        )
          return rejectBaleBusRequest(
            envelope.requestId,
            "Workspace Restore capability is unavailable.",
          );
        try {
          const result = await deps.handleWorkspaceRestore(
            {
              operationId: envelope.operationId,
              registrationGeneration,
              mode: envelope.mode,
            },
            ctx,
          );
          if (
            deps.getAuthSecret?.() !== authSecret ||
            deps.getRegistrationGeneration() !== registrationGeneration ||
            deps.getContext() !== ctx ||
            !deps.isWorkspaceRestoreEnabled()
          )
            throw new Error("Workspace Restore receiver authority changed.");
          return {
            kind: "bus.ack",
            requestId: envelope.requestId,
            ok: true,
            result,
          };
        } catch (error) {
          deps.recordRuntimeEvent?.("bus", error, {
            phase: "follower-workspace-restore",
          });
          return {
            kind: "bus.ack",
            requestId: envelope.requestId,
            ok: false,
            message:
              error instanceof Error
                ? error.message
                : "Workspace Restore failed.",
          };
        }
      }
      if (
        envelope.kind === "leader.offerInputCustodyHandoff" &&
        envelope.recipientBindingKey !== deps.getRecipientBindingKey()
      )
        return rejectBaleBusRequest(
          envelope.requestId,
          "Mismatched Bale follower handoff recipient identity.",
        );
      if (
        envelope.kind !== "leader.offerQueueHandoff" &&
        envelope.kind !== "leader.offerInputCustodyHandoff" &&
        (!envelope.delivery ||
          envelope.delivery.recipientBindingKey !==
            deps.getRecipientBindingKey())
      ) {
        return rejectBaleBusRequest(
          envelope.requestId,
          "Mismatched Bale follower delivery identity.",
        );
      }
      const ctx = deps.getContext();
      if (!ctx) {
        return rejectBaleBusRequest(
          envelope.requestId,
          "Bale bus follower has no active context.",
        );
      }
      try {
        if (envelope.kind === "leader.offerInputCustodyHandoff") {
          if (!(deps.isSourceReferenceAdmissionEnabled?.() ?? false))
            throw new Error(
              "Bale input custody handoff capability is not enabled.",
            );
          if (!deps.hasAuthenticatedSourceReferenceTransport?.())
            throw new Error(
              "Bale input custody handoff requires authenticated transport.",
            );
          if (!deps.handleInputCustodyHandoff)
            throw new Error(
              "Bale input custody handoff acceptance is unavailable.",
            );
          const result = await deps.handleInputCustodyHandoff(envelope, ctx);
          return {
            kind: "bus.ack",
            requestId: envelope.requestId,
            ok: true,
            result,
          };
        }
        if (envelope.kind !== "leader.offerQueueHandoff") {
          const sourceReferenceEnabled =
            envelope.kind === "leader.wakeInputCustody" ||
            (deps.isSourceReferenceAdmissionEnabled?.() ?? false);
          if (
            sourceReferenceEnabled &&
            !deps.hasAuthenticatedSourceReferenceTransport?.()
          )
            throw new Error(
              "Bale follower source-reference admission requires authenticated transport.",
            );
          const admission = sourceReferenceEnabled
            ? deps.sourceReferenceAdmission
            : deps.durableAdmission;
          if (!admission)
            throw new Error(
              "Bale follower source-reference admission is enabled without a wake authority.",
            );
          const receipt = await admission.admit(envelope, ctx);
          return {
            kind: "bus.ack",
            requestId: envelope.requestId,
            ok: true,
            result: receipt,
          };
        }
        if (envelope.payload.queueLane === "steer" &&
            ![deps.getLocalProtocol?.(), deps.getLeaderProtocol?.()].every(hasBaleBusSteerQueueHandoffCapability)) {
          throw new Error("Steer queue handoff capability was not negotiated.");
        }
        if (!deps.handleQueueHandoff) {
          throw new Error(
            "Bale bus receiver cannot accept queue handoff payloads.",
          );
        }
        const result = await deps.handleQueueHandoff(envelope, ctx);
        const receipt = envelope.payload.admissionReceipts[0];
        if (
          envelope.payload.admissionReceipts.length !== 1 ||
          !receipt ||
          result.status !== "staged" ||
          result.receiptId !== receipt.receiptId ||
          result.sourceUpdateIds.length !== receipt.sourceUpdateIds.length ||
          result.sourceUpdateIds.some(
            (updateId, index) => updateId !== receipt.sourceUpdateIds[index],
          )
        ) {
          throw new Error(
            "Bale queue handoff staging returned a mismatched receipt.",
          );
        }
        return {
          kind: "bus.ack",
          requestId: envelope.requestId,
          ok: true,
          result,
        };
      } catch (error) {
        deps.recordRuntimeEvent?.("bus", error, { phase: "follower-forward" });
        return {
          kind: "bus.ack",
          requestId: envelope.requestId,
          ok: false,
          message:
            error instanceof Error
              ? error.message
              : "Bale bus follower dispatch failed.",
        };
      }
    },
  });
  return server;
}

function parseRegistrationResult(value: unknown): {
  target?: BaleTarget;
  slot?: string;
  threadName?: string;
  displayTitle?: string;
} {
  if (!isRecord(value)) return {};
  const target = parseTarget(isRecord(value.target) ? value.target : value);
  return {
    ...(target ? { target } : {}),
    ...(typeof value.slot === "string" ? { slot: value.slot } : {}),
    ...(typeof value.threadName === "string"
      ? { threadName: value.threadName }
      : {}),
    ...(typeof value.displayTitle === "string"
      ? { displayTitle: value.displayTitle }
      : {}),
  };
}

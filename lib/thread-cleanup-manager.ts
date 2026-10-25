/**
 * Proof-only candidate planning for inactive Bale Workspace Thread cleanup
 * Zones: bale threads, workspace lifecycle
 * Owns fail-closed cleanup eligibility projection without persistence or Bot API effects
 */

import { createHash, randomUUID } from "node:crypto";

import {
  publishBalePrivateFile,
  readBalePrivateFile,
  BalePrivateFileError,
  withBaleFileTransaction,
} from "./locks.ts";
import { getBaleJournalPublicationPaths } from "./paths.ts";
import {
  isWireRecord as isObject,
  hasOnlyWireKeys as onlyKeys,
  isNonNegativeWireInteger as safeTime,
} from "./wire.ts";
import type {
  BaleWorkspaceDeletionPermit,
  BaleWorkspaceDestructiveFence,
  BaleWorkspaceRetirementFence,
  BaleWorkspaceAdmissionLedger,
  BaleWorkspaceAdmissionOwner,
} from "./workspace-admission.ts";
import { isBaleWorkspaceRetirementFence } from "./workspace-admission.ts";
import type { BaleTopicTargetStore, BaleWorkspaceThreadBinding } from "./threads.ts";
import type { BaleWorkspaceOperationRunner } from "./workspace-retirement.ts";
import type { BaleWorkspaceThreadDeletionTransport } from "./bale-api.ts";
import type { BaleProcessLiveness } from "./process-identity.ts";

export interface BaleThreadCleanupBindingSnapshot {
  cwd: string;
  workspaceKey: string;
  sessionId?: string;
  sessionKey?: string;
  instanceSlot: string;
  slot?: string;
  bindingKey: string;
  target: { chatId: number; threadId: number };
  inactiveSinceMs?: number;
  updatedAtMs: number;
}

export type BaleThreadCleanupProtectionState =
  "clear" | "protected" | "unknown";

export interface BaleThreadCleanupProtectionEvidence {
  bindingKey: string;
  target: { chatId: number; threadId: number };
  liveOwner: BaleThreadCleanupProtectionState;
  acceptedWork: BaleThreadCleanupProtectionState;
  deliveryAuthority: BaleThreadCleanupProtectionState;
}

export interface BaleThreadCleanupCandidate {
  profileName: string;
  bindingKey: string;
  cwd: string;
  workspaceKey: string;
  sessionId?: string;
  sessionKey?: string;
  instanceSlot: string;
  /** Null is explicit absence in reviewed work; it never denotes a reusable letter. */
  slot: string | null;
  target: { chatId: number; threadId: number };
  inactiveSinceMs: number;
  bindingUpdatedAtMs: number;
}

function targetKey(target: { chatId: number; threadId: number }): string {
  return `${target.chatId}:${target.threadId}`;
}

function validTarget(target: { chatId: number; threadId: number }): boolean {
  return (
    Number.isSafeInteger(target.chatId) &&
    Number.isSafeInteger(target.threadId) &&
    target.threadId > 0
  );
}

function validSessionIdentity(value: {
  sessionId?: unknown;
  sessionKey?: unknown;
}): boolean {
  if (value.sessionId === undefined && value.sessionKey === undefined)
    return true;
  if (
    typeof value.sessionId !== "string" ||
    !value.sessionId ||
    value.sessionId !== value.sessionId.trim() ||
    Buffer.byteLength(value.sessionId, "utf8") > 256 ||
    typeof value.sessionKey !== "string" ||
    !/^[a-f0-9]{64}$/u.test(value.sessionKey)
  ) {
    return false;
  }
  return (
    createHash("sha256").update(value.sessionId).digest("hex") ===
    value.sessionKey
  );
}

/** Returns no candidates when any identity/evidence ambiguity exists. */
export function planBaleInactiveThreadCleanup(input: {
  profileName: string;
  bindings: readonly BaleThreadCleanupBindingSnapshot[];
  protection: readonly BaleThreadCleanupProtectionEvidence[];
  reservedTargets?: readonly { chatId: number; threadId: number }[];
  provisioningTargets?: readonly { chatId: number; threadId: number }[];
  cleanupTargets?: readonly { chatId: number; threadId: number }[];
}): BaleThreadCleanupCandidate[] {
  if (!input.profileName) return [];
  const bindingKeys = new Set<string>();
  const bindingTargets = new Set<string>();
  for (const binding of input.bindings) {
    const key = targetKey(binding.target);
    const slot = binding.slot;
    if (
      !binding.bindingKey ||
      !binding.cwd ||
      !binding.workspaceKey ||
      !binding.instanceSlot ||
      (slot !== undefined && (typeof slot !== "string" || !/^[A-Z]$/u.test(slot))) ||
      !validSessionIdentity(binding) ||
      !validTarget(binding.target) ||
      bindingKeys.has(binding.bindingKey) ||
      bindingTargets.has(key)
    )
      return [];
    bindingKeys.add(binding.bindingKey);
    bindingTargets.add(key);
  }
  const evidenceByBinding = new Map<
    string,
    BaleThreadCleanupProtectionEvidence
  >();
  for (const evidence of input.protection) {
    if (
      !evidence.bindingKey ||
      evidenceByBinding.has(evidence.bindingKey) ||
      !validTarget(evidence.target)
    )
      return [];
    evidenceByBinding.set(evidence.bindingKey, evidence);
  }
  const competingTargets = [
    ...(input.reservedTargets ?? []),
    ...(input.provisioningTargets ?? []),
    ...(input.cleanupTargets ?? []),
  ];
  if (competingTargets.some((target) => !validTarget(target))) return [];
  const competing = new Set(competingTargets.map(targetKey));
  const candidates: BaleThreadCleanupCandidate[] = [];
  for (const binding of input.bindings) {
    const inactiveSinceMs = binding.inactiveSinceMs;
    const slot = binding.slot;
    if (
      !Number.isSafeInteger(inactiveSinceMs) ||
      inactiveSinceMs === undefined ||
      inactiveSinceMs < 0 ||
      !Number.isSafeInteger(binding.updatedAtMs) ||
      binding.updatedAtMs < inactiveSinceMs
    )
      continue;
    const evidence = evidenceByBinding.get(binding.bindingKey);
    if (
      !evidence ||
      targetKey(evidence.target) !== targetKey(binding.target) ||
      evidence.liveOwner !== "clear" ||
      evidence.acceptedWork !== "clear" ||
      evidence.deliveryAuthority !== "clear" ||
      competing.has(targetKey(binding.target))
    )
      continue;
    candidates.push({
      profileName: input.profileName,
      bindingKey: binding.bindingKey,
      cwd: binding.cwd,
      workspaceKey: binding.workspaceKey,
      ...(binding.sessionId && binding.sessionKey
        ? { sessionId: binding.sessionId, sessionKey: binding.sessionKey }
        : {}),
      instanceSlot: binding.instanceSlot,
      slot: slot ?? null,
      target: { ...binding.target },
      inactiveSinceMs,
      bindingUpdatedAtMs: binding.updatedAtMs,
    });
  }
  return candidates.sort((left, right) =>
    left.bindingKey.localeCompare(right.bindingKey),
  );
}

/** Read ports for the bindings and target claims that cleanup evidence is captured from. */
export interface BaleInactiveThreadCleanupEvidencePorts<
  TBinding extends BaleThreadCleanupBindingSnapshot,
> {
  listBindings(): readonly TBinding[];
  getProtection(binding: TBinding): {
    liveOwner: BaleThreadCleanupProtectionState;
    acceptedWork: BaleThreadCleanupProtectionState;
    deliveryAuthority: BaleThreadCleanupProtectionState;
  };
  listReservations(): readonly {
    target: { chatId: number; threadId: number };
  }[];
  listPendingProvisions(): readonly {
    target?: { chatId: number; threadId: number };
  }[];
  listPendingCleanups(): readonly {
    target: { chatId: number; threadId: number };
  }[];
}

export function captureBaleInactiveThreadCleanupEvidence<
  TBinding extends BaleThreadCleanupBindingSnapshot,
>(
  input: BaleInactiveThreadCleanupEvidencePorts<TBinding> & {
    profileName: string;
  },
): Parameters<typeof planBaleInactiveThreadCleanup>[0] {
  const sourceBindings = input.listBindings();
  const bindings = sourceBindings.map((binding) => ({
    cwd: binding.cwd,
    workspaceKey: binding.workspaceKey,
    ...(binding.sessionId && binding.sessionKey
      ? { sessionId: binding.sessionId, sessionKey: binding.sessionKey }
      : {}),
    instanceSlot: binding.instanceSlot,
    ...(binding.slot === undefined ? {} : { slot: binding.slot }),
    bindingKey: binding.bindingKey,
    target: { ...binding.target },
    ...(binding.inactiveSinceMs === undefined
      ? {}
      : { inactiveSinceMs: binding.inactiveSinceMs }),
    updatedAtMs: binding.updatedAtMs,
  }));
  const protection = sourceBindings.map((source, index) => {
    const binding = bindings[index]!;
    try {
      return {
        bindingKey: binding.bindingKey,
        target: { ...binding.target },
        ...input.getProtection(source),
      };
    } catch {
      return {
        bindingKey: binding.bindingKey,
        target: { ...binding.target },
        liveOwner: "unknown" as const,
        acceptedWork: "unknown" as const,
        deliveryAuthority: "unknown" as const,
      };
    }
  });
  return {
    profileName: input.profileName,
    bindings,
    protection,
    reservedTargets: input
      .listReservations()
      .map((entry) => ({ ...entry.target })),
    provisioningTargets: input
      .listPendingProvisions()
      .flatMap((entry) => (entry.target ? [{ ...entry.target }] : [])),
    cleanupTargets: input
      .listPendingCleanups()
      .map((entry) => ({ ...entry.target })),
  };
}

export function createBaleInactiveThreadCleanupReviewRuntime<
  TBinding extends BaleThreadCleanupBindingSnapshot,
>(
  deps: BaleInactiveThreadCleanupEvidencePorts<TBinding> & {
    getProfileName(): string;
    getWorkStore(): BaleThreadCleanupWorkStore;
    runWorkspaceOperation<T>(
      input: {
        operationId: string;
        operationKind: string;
        scopes: readonly [{ kind: "profile" }];
      },
      operation: () => Promise<T>,
    ): Promise<T>;
  },
): { review(): Promise<{ count: number; operationId?: string }> } {
  return {
    review() {
      return deps.runWorkspaceOperation(
        {
          operationId: `thread-cleanup-review:${randomUUID()}`,
          operationKind: "thread-cleanup-review",
          scopes: [{ kind: "profile" }],
        },
        async () => {
          const evidence = captureBaleInactiveThreadCleanupEvidence({
            profileName: deps.getProfileName(),
            listBindings: deps.listBindings,
            getProtection: deps.getProtection,
            listReservations: deps.listReservations,
            listPendingProvisions: deps.listPendingProvisions,
            listPendingCleanups: deps.listPendingCleanups,
          });
          const candidates = planBaleInactiveThreadCleanup(evidence);
          if (candidates.length === 0) return { count: 0 };
          const digest = createHash("sha256")
            .update(JSON.stringify(candidates))
            .digest("hex")
            .slice(0, 32);
          const operationId = `thread-cleanup:${digest}`;
          deps.getWorkStore().prepare(operationId, candidates);
          return { count: candidates.length, operationId };
        },
      );
    },
  };
}

export type BaleThreadCleanupWorkState =
  "prepared" | "outcome-unknown" | "deleted";
export type BaleThreadCleanupWorkEntry = BaleThreadCleanupCandidate & {
  state: BaleThreadCleanupWorkState;
  updatedAtMs: number;
  issuedAtMs?: number;
  permitOperationId?: string;
  permitIntentId?: string;
  permitLeaderEpoch?: number | string;
  deletedAtMs?: number;
};
export interface BaleThreadCleanupWorkSet {
  operationId: string;
  createdAtMs: number;
  entries: BaleThreadCleanupWorkEntry[];
}
interface BaleThreadCleanupWorkFile {
  version: 1;
  profileName: string;
  tokenSha256: string;
  workSets: BaleThreadCleanupWorkSet[];
}
export type BaleThreadCleanupDeletionPermit =
  BaleWorkspaceDeletionPermit;
export type BaleThreadCleanupFence = BaleWorkspaceRetirementFence;

export interface BaleThreadCleanupWorkStore {
  prepare(
    operationId: string,
    candidates: readonly BaleThreadCleanupCandidate[],
  ): { prepared: boolean; workSet: BaleThreadCleanupWorkSet };
  recordDeletionIssued(input: {
    operationId: string;
    bindingKey: string;
    bindingUpdatedAtMs: number;
    permit: BaleThreadCleanupDeletionPermit;
  }): { recorded: boolean; entry: BaleThreadCleanupWorkEntry };
  confirmDeleted(input: { operationId: string; bindingKey: string }): {
    confirmed: boolean;
    entry: BaleThreadCleanupWorkEntry;
  };
  list(): BaleThreadCleanupWorkSet[];
}

function validateWorkSet(
  value: unknown,
  profileName: string,
): BaleThreadCleanupWorkSet {
  if (
    !isObject(value) ||
    !onlyKeys(value, ["operationId", "createdAtMs", "entries"]) ||
    typeof value.operationId !== "string" ||
    !value.operationId ||
    !safeTime(value.createdAtMs) ||
    !Array.isArray(value.entries) ||
    value.entries.length === 0
  )
    throw new Error("Bale Thread cleanup work-set schema is invalid.");
  const createdAtMs = value.createdAtMs as number;
  const entries = value.entries.map((raw) => {
    if (
      !isObject(raw) ||
      !onlyKeys(raw, [
        "profileName",
        "bindingKey",
        "cwd",
        "workspaceKey",
        "sessionId",
        "sessionKey",
        "instanceSlot",
        "slot",
        "target",
        "inactiveSinceMs",
        "bindingUpdatedAtMs",
        "state",
        "updatedAtMs",
        "issuedAtMs",
        "permitOperationId",
        "permitIntentId",
        "permitLeaderEpoch",
        "deletedAtMs",
      ]) ||
      raw.profileName !== profileName ||
      typeof raw.bindingKey !== "string" ||
      !raw.bindingKey ||
      typeof raw.cwd !== "string" ||
      !raw.cwd ||
      typeof raw.workspaceKey !== "string" ||
      !raw.workspaceKey ||
      !validSessionIdentity(raw) ||
      typeof raw.instanceSlot !== "string" ||
      !raw.instanceSlot ||
      (raw.slot !== null && (typeof raw.slot !== "string" || !/^[A-Z]$/u.test(raw.slot))) ||
      !isObject(raw.target) ||
      !onlyKeys(raw.target, ["chatId", "threadId"]) ||
      !validTarget(
        raw.target as unknown as { chatId: number; threadId: number },
      ) ||
      !safeTime(raw.inactiveSinceMs) ||
      !safeTime(raw.bindingUpdatedAtMs) ||
      (raw.bindingUpdatedAtMs as number) < (raw.inactiveSinceMs as number) ||
      !safeTime(raw.updatedAtMs)
    )
      throw new Error("Bale Thread cleanup entry schema is invalid.");
    const base = {
      profileName,
      bindingKey: raw.bindingKey,
      cwd: raw.cwd,
      workspaceKey: raw.workspaceKey,
      ...(typeof raw.sessionId === "string" &&
      typeof raw.sessionKey === "string"
        ? { sessionId: raw.sessionId, sessionKey: raw.sessionKey }
        : {}),
      instanceSlot: raw.instanceSlot,
      slot: raw.slot,
      target: {
        chatId: raw.target.chatId as number,
        threadId: raw.target.threadId as number,
      },
      inactiveSinceMs: raw.inactiveSinceMs as number,
      bindingUpdatedAtMs: raw.bindingUpdatedAtMs as number,
      updatedAtMs: raw.updatedAtMs as number,
    };
    if (base.updatedAtMs < base.bindingUpdatedAtMs)
      throw new Error("Bale Thread cleanup entry clock is invalid.");
    const noPermit =
      raw.permitOperationId === undefined &&
      raw.permitIntentId === undefined &&
      raw.permitLeaderEpoch === undefined;
    if (
      raw.state === "prepared" &&
      raw.issuedAtMs === undefined &&
      raw.deletedAtMs === undefined &&
      noPermit
    )
      return { ...base, state: "prepared" as const };
    const validPermit =
      typeof raw.permitOperationId === "string" &&
      !!raw.permitOperationId &&
      typeof raw.permitIntentId === "string" &&
      !!raw.permitIntentId &&
      (typeof raw.permitLeaderEpoch === "string" ||
        Number.isSafeInteger(raw.permitLeaderEpoch));
    if (
      raw.state === "outcome-unknown" &&
      safeTime(raw.issuedAtMs) &&
      validPermit &&
      raw.issuedAtMs === base.updatedAtMs &&
      raw.deletedAtMs === undefined
    )
      return {
        ...base,
        state: "outcome-unknown" as const,
        issuedAtMs: raw.issuedAtMs,
        permitOperationId: raw.permitOperationId as string,
        permitIntentId: raw.permitIntentId as string,
        permitLeaderEpoch: raw.permitLeaderEpoch as number | string,
      };
    if (
      raw.state === "deleted" &&
      safeTime(raw.issuedAtMs) &&
      validPermit &&
      safeTime(raw.deletedAtMs) &&
      raw.deletedAtMs === base.updatedAtMs &&
      raw.deletedAtMs >= raw.issuedAtMs
    )
      return {
        ...base,
        state: "deleted" as const,
        issuedAtMs: raw.issuedAtMs,
        permitOperationId: raw.permitOperationId as string,
        permitIntentId: raw.permitIntentId as string,
        permitLeaderEpoch: raw.permitLeaderEpoch as number | string,
        deletedAtMs: raw.deletedAtMs,
      };
    throw new Error("Bale Thread cleanup entry state is invalid.");
  });
  if (
    entries.some((entry) => entry.updatedAtMs < createdAtMs) ||
    new Set(entries.map((entry) => entry.bindingKey)).size !== entries.length ||
    new Set(entries.map((entry) => targetKey(entry.target))).size !==
      entries.length
  )
    throw new Error("Bale Thread cleanup work-set identity is ambiguous.");
  return { operationId: value.operationId, createdAtMs, entries };
}

function sameCandidates(
  left: readonly BaleThreadCleanupCandidate[],
  right: readonly BaleThreadCleanupCandidate[],
): boolean {
  const keys = ["profileName", "bindingKey", "cwd", "workspaceKey", "sessionId", "sessionKey", "instanceSlot", "slot", "inactiveSinceMs", "bindingUpdatedAtMs"] as const;
  return left.length === right.length && left.every((candidate, index) => {
    const other = right[index]!;
    return keys.every(key => candidate[key] === other[key]) && targetKey(candidate.target) === targetKey(other.target);
  });
}

function parseBaleThreadCleanupWorkFile(
  value: unknown,
  profileName: string,
  tokenSha256: string,
): BaleThreadCleanupWorkFile {
  if (
    !isObject(value) ||
    !onlyKeys(value, ["version", "profileName", "tokenSha256", "workSets"]) ||
    value.version !== 1 ||
    value.profileName !== profileName ||
    value.tokenSha256 !== tokenSha256 ||
    !Array.isArray(value.workSets)
  )
    throw new Error(
      "Bale Thread cleanup store identity or schema does not match.",
    );
  const workSets = value.workSets.map((workSet) =>
    validateWorkSet(workSet, profileName),
  );
  if (
    new Set(workSets.map((workSet) => workSet.operationId)).size !==
    workSets.length
  )
    throw new Error("Bale Thread cleanup operation identity is ambiguous.");
  return { version: 1, profileName, tokenSha256, workSets };
}

export function createBaleThreadCleanupWorkStore(options: {
  path: string;
  runtimeDir?: string;
  profileName: string;
  tokenSha256: string;
  /** Exact captured ledger identity; standalone fixtures may use the plain profile identity. */
  admissionProfileKey?: string;
  maxWorkSets?: number;
  maxBytes?: number;
  getNowMs?: () => number;
  onPublicationBoundary?: (
    boundary: "after-write-before-rename" | "after-rename",
  ) => void;
}): BaleThreadCleanupWorkStore {
  options = { ...options };
  const publicationPaths = getBaleJournalPublicationPaths(
    options.path,
    options.runtimeDir,
  );
  const maxWorkSets = options.maxWorkSets ?? 32;
  const maxBytes = options.maxBytes ?? 1024 * 1024;
  const now = options.getNowMs ?? Date.now;
  if (
    !options.path ||
    !options.profileName ||
    !/^[a-f0-9]{64}$/u.test(options.tokenSha256) ||
    !Number.isSafeInteger(maxWorkSets) ||
    maxWorkSets <= 0 ||
    !Number.isSafeInteger(maxBytes) ||
    maxBytes <= 0
  )
    throw new Error("Bale Thread cleanup store options are invalid.");
  const empty = (): BaleThreadCleanupWorkFile => ({
    version: 1,
    profileName: options.profileName,
    tokenSha256: options.tokenSha256,
    workSets: [],
  });
  const read = (): BaleThreadCleanupWorkFile => {
    let text: string | undefined;
    try {
      text = readBalePrivateFile(options.path, maxBytes);
    } catch (error) {
      if (!(error instanceof BalePrivateFileError)) throw error;
      throw new Error(
        error.failure === "changed"
          ? "Bale Thread cleanup store changed during inspection."
          : "Bale Thread cleanup store is not a bounded private regular file.",
        { cause: error },
      );
    }
    return text === undefined
      ? empty()
      : parseBaleThreadCleanupWorkFile(
          JSON.parse(text) as unknown,
          options.profileName,
          options.tokenSha256,
        );
  };
  const publish = (file: BaleThreadCleanupWorkFile): void => {
    if (file.workSets.length > maxWorkSets)
      throw new Error("Bale Thread cleanup work-set capacity reached.");
    const serialized = `${JSON.stringify(file, null, 2)}\n`;
    if (Buffer.byteLength(serialized) > maxBytes)
      throw new Error("Bale Thread cleanup byte capacity reached.");
    publishBalePrivateFile(
      options.path,
      publicationPaths.temporaryBasePath,
      serialized,
      "Bale Thread cleanup",
      options.onPublicationBoundary,
    );
  };
  const mutate = <T>(
    operation: (file: BaleThreadCleanupWorkFile) => T,
  ): T =>
    withBaleFileTransaction(publicationPaths.transactionPath, () =>
      operation(read()),
    );
  return {
    prepare(operationId, candidates) {
      if (
        !operationId ||
        candidates.length === 0 ||
        candidates.some(
          (candidate) => candidate.profileName !== options.profileName,
        )
      )
        throw new Error("Bale Thread cleanup work-set is invalid.");
      return mutate((file) => {
        const existing = file.workSets.find(
          (workSet) => workSet.operationId === operationId,
        );
        if (existing) {
          const projected = existing.entries.map(
            ({
              state: _state,
              updatedAtMs: _updated,
              issuedAtMs: _issued,
              permitOperationId: _permitOperation,
              permitIntentId: _permitIntent,
              permitLeaderEpoch: _permitEpoch,
              deletedAtMs: _deleted,
              ...candidate
            }) => candidate,
          );
          if (!sameCandidates(projected, candidates))
            throw new Error("Bale Thread cleanup operation conflicts.");
          return { prepared: false, workSet: structuredClone(existing) };
        }
        const atMs = now();
        if (!safeTime(atMs))
          throw new Error("Bale Thread cleanup clock is invalid.");
        const workSet = validateWorkSet(
          {
            operationId,
            createdAtMs: atMs,
            entries: candidates.map((candidate) => ({
              ...structuredClone(candidate),
              state: "prepared",
              updatedAtMs: atMs,
            })),
          },
          options.profileName,
        );
        publish({ ...file, workSets: [...file.workSets, workSet] });
        return { prepared: true, workSet: structuredClone(workSet) };
      });
    },
    recordDeletionIssued(input) {
      return mutate((file) => {
        const workSet = file.workSets.find(
          (candidate) => candidate.operationId === input.operationId,
        );
        const entry = workSet?.entries.find(
          (candidate) => candidate.bindingKey === input.bindingKey,
        );
        const permit = input.permit;
        if (
          !workSet ||
          !entry ||
          entry.bindingUpdatedAtMs !== input.bindingUpdatedAtMs ||
          permit.destructiveKind !== "manual-thread-cleanup" ||
          permit.profileKey !== (options.admissionProfileKey ?? entry.profileName) ||
          permit.bindingKey !== entry.bindingKey ||
          permit.slot !== entry.slot ||
          targetKey(permit.target) !== targetKey(entry.target) ||
          !permit.operationId ||
          permit.retirementIntentId !== workSet.operationId ||
          !safeTime(permit.issuedAtMs)
        )
          throw new Error(
            "Bale Thread cleanup entry or deletion permit is stale or mismatched.",
          );
        if (entry.state !== "prepared") {
          const exact =
            entry.permitOperationId === permit.operationId &&
            entry.permitIntentId === permit.retirementIntentId &&
            entry.permitLeaderEpoch === permit.leaderEpoch;
          if (!exact)
            throw new Error(
              "Bale Thread cleanup deletion permit conflicts with retained work.",
            );
          return { recorded: false, entry: structuredClone(entry) };
        }
        const atMs = now();
        if (
          !safeTime(atMs) ||
          atMs < entry.updatedAtMs ||
          atMs < permit.issuedAtMs
        )
          throw new Error("Bale Thread cleanup clock is invalid.");
        entry.state = "outcome-unknown";
        entry.issuedAtMs = atMs;
        entry.updatedAtMs = atMs;
        entry.permitOperationId = permit.operationId;
        entry.permitIntentId = permit.retirementIntentId;
        entry.permitLeaderEpoch = permit.leaderEpoch;
        publish(file);
        return { recorded: true, entry: structuredClone(entry) };
      });
    },
    confirmDeleted(input) {
      return mutate((file) => {
        const entry = file.workSets
          .find((candidate) => candidate.operationId === input.operationId)
          ?.entries.find(
            (candidate) => candidate.bindingKey === input.bindingKey,
          );
        if (!entry)
          throw new Error("Bale Thread cleanup entry is missing.");
        if (entry.state === "deleted")
          return { confirmed: false, entry: structuredClone(entry) };
        if (entry.state !== "outcome-unknown")
          throw new Error(
            "Bale Thread cleanup deletion confirmation is premature.",
          );
        const atMs = now();
        if (!safeTime(atMs) || atMs < entry.updatedAtMs)
          throw new Error("Bale Thread cleanup clock is invalid.");
        entry.state = "deleted";
        entry.deletedAtMs = atMs;
        entry.updatedAtMs = atMs;
        publish(file);
        return { confirmed: true, entry: structuredClone(entry) };
      });
    },
    list() {
      return structuredClone(
        withBaleFileTransaction(
          publicationPaths.transactionPath,
          () => read().workSets,
        ),
      );
    },
  };
}

export async function commitBaleInactiveThreadCleanup(input: {
  store: BaleThreadCleanupWorkStore;
  operationId: string;
  bindingKey: string;
  commitBinding(): Promise<boolean>;
}): Promise<boolean> {
  if (!(await input.commitBinding())) return false;
  input.store.confirmDeleted({
    operationId: input.operationId,
    bindingKey: input.bindingKey,
  });
  return true;
}

export async function executeBaleInactiveThreadCleanup(input: {
  store: BaleThreadCleanupWorkStore;
  operationId: string;
  bindingKey: string;
  withWorkspaceDeletionBoundary<T>(operation: () => Promise<T>): Promise<T>;
  loadFreshEvidence(): Promise<
    Parameters<typeof planBaleInactiveThreadCleanup>[0]
  >;
  acquireDeletionPermit(
    candidate: BaleThreadCleanupCandidate,
  ): Promise<
    | { kind: "issued"; permit: BaleThreadCleanupDeletionPermit }
    | { kind: "blocked" | "already-issued" }
  >;
  deleteWithPermit(
    permit: BaleThreadCleanupDeletionPermit,
    candidate: BaleThreadCleanupCandidate,
  ): Promise<void>;
}): Promise<{
  status: "deleted" | "blocked" | "outcome-unknown";
  entry?: BaleThreadCleanupWorkEntry;
}> {
  return input.withWorkspaceDeletionBoundary(async () => {
    const workSet = input.store
      .list()
      .find((candidate) => candidate.operationId === input.operationId);
    const retained = workSet?.entries.find(
      (candidate) => candidate.bindingKey === input.bindingKey,
    );
    if (!retained) return { status: "blocked" };
    if (retained.state === "deleted")
      return { status: "deleted", entry: retained };
    if (retained.state === "outcome-unknown")
      return { status: "outcome-unknown", entry: retained };
    const planned = planBaleInactiveThreadCleanup(
      await input.loadFreshEvidence(),
    );
    const fresh = planned.find(
      (candidate) => candidate.bindingKey === retained.bindingKey,
    );
    const retainedCandidate = (({
      state: _state,
      updatedAtMs: _updated,
      issuedAtMs: _issued,
      permitOperationId: _permitOperation,
      permitIntentId: _permitIntent,
      permitLeaderEpoch: _permitEpoch,
      deletedAtMs: _deleted,
      ...candidate
    }) => candidate)(retained);
    if (!fresh || !sameCandidates([fresh], [retainedCandidate]))
      return { status: "blocked" };
    const permitResult = await input.acquireDeletionPermit(fresh);
    if (permitResult.kind !== "issued") return { status: "blocked" };
    const recorded = input.store.recordDeletionIssued({
      operationId: input.operationId,
      bindingKey: input.bindingKey,
      bindingUpdatedAtMs: retained.bindingUpdatedAtMs,
      permit: permitResult.permit,
    });
    if (!recorded.recorded)
      return { status: "outcome-unknown", entry: recorded.entry };
    await input.deleteWithPermit(permitResult.permit, fresh);
    const confirmed = input.store.confirmDeleted({
      operationId: input.operationId,
      bindingKey: input.bindingKey,
    });
    return { status: "deleted", entry: confirmed.entry };
  });
}

export function createBaleThreadCleanupPermitRuntime(deps: {
  ledger: {
    getProfileKey(): string;
    read(): { fence?: BaleWorkspaceDestructiveFence };
    acquireThreadCleanupFence(input: {
      operationId: string;
      cleanupWorkSetId: string;
      bindingKey: string;
      slot: string | null;
      target: { chatId: number; threadId: number };
      leaderEpoch: number | string;
      cleanupRequestedAtMs: number;
    }):
      | {
          kind: "acquired";
          fence: BaleThreadCleanupFence;
          resumed: boolean;
        }
      | { kind: "blocked"; reason: string };
    adoptThreadCleanupFence(
      fence: BaleThreadCleanupFence,
      replacement: {
        owner: { processId: number; processBirthId: string };
        leaderEpoch: number | string;
      },
    ): BaleThreadCleanupFence;
    issueThreadCleanupDeletionPermit(fence: BaleThreadCleanupFence):
      | {
          kind: "issued";
          fence: BaleThreadCleanupFence;
          permit: BaleThreadCleanupDeletionPermit;
        }
      | { kind: "already-issued"; fence: BaleThreadCleanupFence };
    confirmThreadCleanupAbsence(
      fence: BaleThreadCleanupFence,
    ): BaleThreadCleanupFence;
    releaseUnissuedThreadCleanupFence(
      fence: BaleThreadCleanupFence,
    ): boolean;
    completeThreadCleanupFence(fence: BaleThreadCleanupFence): boolean;
  };
  getLeaderEpoch(): number | string | undefined;
  getProfileName(): string;
  getOwner(): { processId: number; processBirthId: string };
  canAdoptFence(fence: BaleThreadCleanupFence): boolean;
  revalidateUnderFence(
    candidate: BaleThreadCleanupCandidate,
  ): Promise<boolean>;
  getNowMs?: () => number;
}): {
  acquire(
    candidate: BaleThreadCleanupCandidate,
    workSetId: string,
  ): Promise<
    | {
        kind: "issued";
        fence: BaleThreadCleanupFence;
        permit: BaleThreadCleanupDeletionPermit;
      }
    | { kind: "blocked" }
    | { kind: "already-issued" }
  >;
  diagnoseRecovery(
    candidate: BaleThreadCleanupCandidate,
    workSetId: string,
  ):
    | "none"
    | "fenced"
    | "deletion-issued"
    | "commit-ready"
    | "authority-blocked";
  findCommitReady(
    candidate: BaleThreadCleanupCandidate,
    workSetId: string,
  ): BaleThreadCleanupFence | undefined;
  settleDeleted(
    fence: BaleThreadCleanupFence,
    commit: () => Promise<boolean>,
  ): Promise<"completed" | "commit-pending">;
} {
  const now = deps.getNowMs ?? Date.now;
  const findExactFence = (
    candidate: BaleThreadCleanupCandidate,
    workSetId: string,
  ) => {
    const operationId = `thread-cleanup-fence:${createHash("sha256")
      .update(`${workSetId}\u0000${candidate.bindingKey}`, "utf8")
      .digest("hex")}`;
    const fence = deps.ledger.read().fence;
    return fence?.operationId === operationId &&
      fence.destructiveKind === "manual-thread-cleanup" &&
      fence.profileKey === deps.ledger.getProfileKey() &&
      fence.retirementIntentId === workSetId &&
      fence.bindingKey === candidate.bindingKey &&
      fence.slot === candidate.slot &&
      targetKey(fence.target) === targetKey(candidate.target)
      ? fence
      : undefined;
  };
  const adoptExactFence = (
    candidate: BaleThreadCleanupCandidate,
    workSetId: string,
  ) => {
    let fence = findExactFence(candidate, workSetId);
    const leaderEpoch = deps.getLeaderEpoch();
    if (!fence || leaderEpoch === undefined) return undefined;
    const owner = deps.getOwner();
    if (
      fence.leaderEpoch !== leaderEpoch ||
      fence.owner.processId !== owner.processId ||
      fence.owner.processBirthId !== owner.processBirthId
    ) {
      if (!deps.canAdoptFence(fence)) return undefined;
      try {
        const adopted = deps.ledger.adoptThreadCleanupFence(fence, {
          owner,
          leaderEpoch,
        });
        if (adopted.destructiveKind !== "manual-thread-cleanup")
          return undefined;
        fence = adopted;
      } catch {
        return undefined;
      }
    }
    return deps.getLeaderEpoch() === leaderEpoch ? fence : undefined;
  };
  return {
    diagnoseRecovery(candidate, workSetId) {
      const fence = deps.ledger.read().fence;
      if (!fence) return "none";
      const exact = findExactFence(candidate, workSetId);
      if (!exact) return "authority-blocked";
      const owner = deps.getOwner();
      const leaderEpoch = deps.getLeaderEpoch();
      const owns =
        exact.owner.processId === owner.processId &&
        exact.owner.processBirthId === owner.processBirthId &&
        exact.leaderEpoch === leaderEpoch;
      return owns || deps.canAdoptFence(exact)
        ? exact.phase
        : "authority-blocked";
    },
    findCommitReady(candidate, workSetId) {
      const fence = adoptExactFence(candidate, workSetId);
      return fence?.phase === "commit-ready" ? fence : undefined;
    },
    async acquire(candidate, workSetId) {
      const leaderEpoch = deps.getLeaderEpoch();
      if (
        leaderEpoch === undefined ||
        candidate.profileName.length === 0 ||
        candidate.profileName !== deps.getProfileName()
      )
        return { kind: "blocked" };
      const operationId = `thread-cleanup-fence:${createHash("sha256")
        .update(workSetId)
        .update("\0")
        .update(candidate.bindingKey)
        .digest("hex")}`;
      const existing =
        adoptExactFence(candidate, workSetId) ?? deps.ledger.read().fence;
      if (
        existing &&
        existing.operationId === operationId &&
        existing.destructiveKind === "manual-thread-cleanup" &&
        existing.retirementIntentId === workSetId &&
        existing.bindingKey === candidate.bindingKey &&
        existing.slot === candidate.slot &&
        targetKey(existing.target) === targetKey(candidate.target) &&
        existing.leaderEpoch === leaderEpoch &&
        existing.phase !== "fenced"
      ) {
        return { kind: "already-issued" };
      }
      let acquired;
      try {
        acquired = deps.ledger.acquireThreadCleanupFence({
          operationId,
          cleanupWorkSetId: workSetId,
          bindingKey: candidate.bindingKey,
          slot: candidate.slot,
          target: candidate.target,
          leaderEpoch,
          cleanupRequestedAtMs: now(),
        });
      } catch {
        return { kind: "blocked" };
      }
      if (acquired.kind === "blocked") return { kind: "blocked" };
      if (
        deps.getLeaderEpoch() !== leaderEpoch ||
        !(await deps.revalidateUnderFence(candidate))
      ) {
        if (acquired.fence.phase === "fenced")
          deps.ledger.releaseUnissuedThreadCleanupFence(acquired.fence);
        return { kind: "blocked" };
      }
      const issued = deps.ledger.issueThreadCleanupDeletionPermit(
        acquired.fence,
      );
      return issued.kind === "issued"
        ? { kind: "issued", fence: issued.fence, permit: issued.permit }
        : { kind: "already-issued" };
    },
    async settleDeleted(fence, commit) {
      const assertAuthority = () => {
        const owner = deps.getOwner();
        if (deps.getLeaderEpoch() !== fence.leaderEpoch ||
            owner.processId !== fence.owner.processId || owner.processBirthId !== fence.owner.processBirthId)
          throw new Error("Bale Thread cleanup settlement authority changed.");
      };
      assertAuthority();
      const ready = deps.ledger.confirmThreadCleanupAbsence(fence);
      const committed = await commit();
      assertAuthority();
      if (!committed) return "commit-pending";
      deps.ledger.completeThreadCleanupFence(ready);
      return "completed";
    },
  };
}

export interface BaleInactiveThreadCleanupCoordinatorDeps<TBinding> {
  store: BaleThreadCleanupWorkStore;
  permitRuntime: ReturnType<typeof createBaleThreadCleanupPermitRuntime>;
  resolveFullBinding(
    candidate: BaleThreadCleanupCandidate,
  ): Promise<TBinding | undefined>;
  deleteWithPermit(
    permit: BaleThreadCleanupDeletionPermit,
    candidate: BaleThreadCleanupCandidate,
  ): Promise<void>;
  commitBinding(
    candidate: BaleThreadCleanupCandidate,
    currentBinding?: TBinding,
  ): Promise<boolean>;
}

export interface BaleInactiveThreadCleanupAuthority {
  profileName: string;
  leaderEpoch: number | string;
  ledger: BaleWorkspaceAdmissionLedger;
  isCurrent(): boolean;
}

/** Review owns ordinary admission; confirmed cleanup uses the shared gate and its exclusive manual fence instead. */
export function createBaleInactiveThreadCleanupRuntime(deps: {
  store: Pick<BaleTopicTargetStore, "load" | "listWorkspaceBindings" | "listReservations" | "listPendingProvisions" | "listPendingCleanups" | "commitInactiveWorkspaceCleanup">;
  captureAuthority(): BaleInactiveThreadCleanupAuthority | undefined;
  getWorkStore(authority: BaleInactiveThreadCleanupAuthority): BaleThreadCleanupWorkStore;
  getProtection(binding: BaleWorkspaceThreadBinding): {
    liveOwner: BaleThreadCleanupProtectionState;
    acceptedWork: BaleThreadCleanupProtectionState;
    deliveryAuthority: BaleThreadCleanupProtectionState;
  };
  getProcessLiveness(owner: BaleWorkspaceAdmissionOwner): BaleProcessLiveness;
  runExclusive<T>(operation: () => Promise<T>): Promise<T>;
  runWorkspaceOperation: BaleWorkspaceOperationRunner;
  deleteThread: BaleWorkspaceThreadDeletionTransport;
  onError?: (error: unknown) => void;
}): {
  review(): Promise<{ count: number; operationId?: string }>;
  clean(operationId: string): Promise<BaleInactiveThreadCleanupResult>;
} {
  const capture = () => {
    const authority = deps.captureAuthority();
    if (!authority || !authority.isCurrent())
      throw new Error("Inactive Thread cleanup requires current leader authority.");
    const ledgerKey = authority.ledger.getProfileKey();
    const owner = authority.ledger.getOwner();
    const assertCurrent = () => {
      if (!authority.isCurrent() || authority.ledger.getProfileKey() !== ledgerKey)
        throw new Error("Inactive Thread cleanup authority changed.");
    };
    const evidence = () => {
      assertCurrent();
      return captureBaleInactiveThreadCleanupEvidence({
        profileName: authority.profileName,
        listBindings: deps.store.listWorkspaceBindings,
        getProtection: deps.getProtection,
        listReservations: deps.store.listReservations,
        listPendingProvisions: deps.store.listPendingProvisions,
        listPendingCleanups: deps.store.listPendingCleanups,
      });
    };
    return { authority, owner, assertCurrent, evidence };
  };
  return {
    async review() {
      const scope = capture();
      return createBaleInactiveThreadCleanupReviewRuntime({
        getProfileName: () => scope.authority.profileName,
        listBindings: deps.store.listWorkspaceBindings,
        getProtection: deps.getProtection,
        listReservations: deps.store.listReservations,
        listPendingProvisions: deps.store.listPendingProvisions,
        listPendingCleanups: deps.store.listPendingCleanups,
        getWorkStore() { scope.assertCurrent(); return deps.getWorkStore(scope.authority); },
        runWorkspaceOperation(metadata, operation) {
          return deps.runWorkspaceOperation(metadata, async () => {
            scope.assertCurrent();
            await deps.store.load();
            scope.assertCurrent();
            return operation();
          });
        },
      }).review();
    },
    async clean(operationId) {
      const scope = capture();
      return deps.runExclusive(async () => {
        scope.assertCurrent();
        const { authority } = scope;
        const work = deps.getWorkStore(authority);
        const exactBinding = (candidate: BaleThreadCleanupCandidate) => {
          const fresh = planBaleInactiveThreadCleanup(scope.evidence()).find(binding => binding.bindingKey === candidate.bindingKey);
          if (!fresh || !sameCandidates([fresh], [candidate])) return undefined;
          return deps.store.listWorkspaceBindings().find(binding => binding.bindingKey === fresh.bindingKey);
        };
        const loadExactBinding = async (candidate: BaleThreadCleanupCandidate) => {
          scope.assertCurrent();
          await deps.store.load();
          scope.assertCurrent();
          return exactBinding(candidate);
        };
        const permitRuntime = createBaleThreadCleanupPermitRuntime({
          ledger: authority.ledger,
          getLeaderEpoch: () => authority.isCurrent() ? authority.leaderEpoch : undefined,
          getProfileName: () => authority.profileName,
          getOwner: () => scope.owner,
          canAdoptFence: fence => authority.isCurrent() && deps.getProcessLiveness(fence.owner) === "dead",
          revalidateUnderFence: async candidate => !!(await loadExactBinding(candidate)),
        });
        return cleanReviewedInactiveThreads({
          store: work, operationId, permitRuntime,
          resolveFullBinding: loadExactBinding,
          async deleteWithPermit(permit, candidate) {
            try {
              await deps.deleteThread(() => {
                scope.assertCurrent();
                const fence = authority.ledger.read().fence;
                if (!fence || !isBaleWorkspaceRetirementFence(fence) ||
                    fence.destructiveKind !== "manual-thread-cleanup" || fence.phase !== "deletion-issued" ||
                    fence.operationId !== permit.operationId || fence.retirementIntentId !== operationId ||
                    fence.profileKey !== permit.profileKey || fence.bindingKey !== candidate.bindingKey ||
                    fence.slot !== candidate.slot || fence.deletionIssuedAtMs !== permit.issuedAtMs ||
                    fence.leaderEpoch !== authority.leaderEpoch || fence.owner.processId !== scope.owner.processId ||
                    fence.owner.processBirthId !== scope.owner.processBirthId ||
                    targetKey(fence.target) !== targetKey(permit.target) || !exactBinding(candidate))
                  throw new Error("Inactive Thread cleanup deletion permit is stale.");
                return { ...permit.target };
              });
              scope.assertCurrent();
            } catch (error) {
              deps.onError?.(error);
              throw error;
            }
          },
          async commitBinding(candidate) {
            scope.assertCurrent();
            await deps.store.load();
            scope.assertCurrent();
            return deps.store.commitInactiveWorkspaceCleanup(candidate, authority.isCurrent);
          },
        });
      });
    },
  };
}

export function createBaleInactiveThreadCleanupSettingsPort<TBinding>(
  deps: BaleInactiveThreadCleanupCoordinatorDeps<TBinding>,
): (operationId: string) => Promise<BaleInactiveThreadCleanupResult> {
  return (operationId) =>
    cleanReviewedInactiveThreads({ ...deps, operationId });
}

export interface BaleInactiveThreadCleanupResult {
  deleted: number;
  outcomeUnknown: number;
  blocked: number;
  recovery?: "commit-ready" | "deletion-outcome-unknown" | "authority-blocked";
}

export async function cleanReviewedInactiveThreads<TBinding>(
  input: {
    operationId: string;
  } & BaleInactiveThreadCleanupCoordinatorDeps<TBinding>,
): Promise<BaleInactiveThreadCleanupResult> {
  if (!/^thread-cleanup:[a-f0-9]{32}$/u.test(input.operationId))
    throw new Error(
      "Bale Thread cleanup confirmation identity is invalid.",
    );
  const workSet = input.store
    .list()
    .find((candidate) => candidate.operationId === input.operationId);
  if (!workSet) throw new Error("Bale Thread cleanup review is missing.");
  let deleted = 0;
  let outcomeUnknown = 0;
  let blocked = 0;
  for (const entry of workSet.entries) {
    if (entry.state === "deleted") {
      const ready = input.permitRuntime.findCommitReady(
        entry,
        input.operationId,
      );
      if (ready) {
        const settlement = await input.permitRuntime.settleDeleted(ready, async () => true);
        if (settlement === "completed") deleted += 1;
        else outcomeUnknown += 1;
      } else if (input.permitRuntime.diagnoseRecovery(entry, input.operationId) !== "none") {
        outcomeUnknown += 1;
      } else deleted += 1;
      continue;
    }
    if (entry.state === "outcome-unknown") {
      const ready = input.permitRuntime.findCommitReady(
        entry,
        input.operationId,
      );
      if (!ready) {
        outcomeUnknown += 1;
        continue;
      }
      const settlement = await input.permitRuntime.settleDeleted(ready, () =>
        commitBaleInactiveThreadCleanup({
          store: input.store,
          operationId: input.operationId,
          bindingKey: entry.bindingKey,
          commitBinding: () => input.commitBinding(entry),
        }),
      );
      if (settlement === "completed") deleted += 1;
      else outcomeUnknown += 1;
      continue;
    }
    const fullBinding = await input.resolveFullBinding(entry);
    if (!fullBinding) {
      blocked += 1;
      continue;
    }
    const authority = await input.permitRuntime.acquire(
      entry,
      input.operationId,
    );
    if (authority.kind === "blocked") {
      blocked += 1;
      continue;
    }
    if (authority.kind === "already-issued") {
      outcomeUnknown += 1;
      continue;
    }
    try {
      const recorded = input.store.recordDeletionIssued({
        operationId: input.operationId,
        bindingKey: entry.bindingKey,
        bindingUpdatedAtMs: entry.bindingUpdatedAtMs,
        permit: authority.permit,
      });
      if (!recorded.recorded) {
        if (recorded.entry.state === "deleted") {
          const settlement = await input.permitRuntime.settleDeleted(
            authority.fence,
            async () => true,
          );
          if (settlement === "completed") deleted += 1;
          else outcomeUnknown += 1;
        } else outcomeUnknown += 1;
        continue;
      }
      await input.deleteWithPermit(authority.permit, entry);
      const settlement = await input.permitRuntime.settleDeleted(
        authority.fence,
        () =>
          commitBaleInactiveThreadCleanup({
            store: input.store,
            operationId: input.operationId,
            bindingKey: entry.bindingKey,
            commitBinding: () => input.commitBinding(entry, fullBinding),
          }),
      );
      if (settlement === "completed") deleted += 1;
      else outcomeUnknown += 1;
    } catch {
      outcomeUnknown += 1;
    }
  }
  const retainedEntries =
    input.store
      .list()
      .find((candidate) => candidate.operationId === input.operationId)
      ?.entries ?? [];
  if (outcomeUnknown > 0) {
    const diagnosis =
      retainedEntries
        .map((entry) =>
          input.permitRuntime.diagnoseRecovery(entry, input.operationId),
        )
        .find((value) => value !== "none") ?? "none";
    const recovery =
      diagnosis === "commit-ready"
        ? "commit-ready"
        : diagnosis === "deletion-issued"
          ? "deletion-outcome-unknown"
          : "authority-blocked";
    return { deleted, outcomeUnknown, blocked, recovery };
  }
  return { deleted, outcomeUnknown, blocked };
}

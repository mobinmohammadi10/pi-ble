/**
 * Proof-only candidate planning for inactive Bale Workspace Thread cleanup
 * Zones: bale threads, workspace lifecycle
 * Owns fail-closed cleanup eligibility projection without persistence or Bot API effects
 */
import type { BaleWorkspaceDeletionPermit, BaleWorkspaceDestructiveFence, BaleWorkspaceRetirementFence, BaleWorkspaceAdmissionLedger, BaleWorkspaceAdmissionOwner } from "./workspace-admission.ts";
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
    target: {
        chatId: number;
        threadId: number;
    };
    inactiveSinceMs?: number;
    updatedAtMs: number;
}
export type BaleThreadCleanupProtectionState = "clear" | "protected" | "unknown";
export interface BaleThreadCleanupProtectionEvidence {
    bindingKey: string;
    target: {
        chatId: number;
        threadId: number;
    };
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
    target: {
        chatId: number;
        threadId: number;
    };
    inactiveSinceMs: number;
    bindingUpdatedAtMs: number;
}
/** Returns no candidates when any identity/evidence ambiguity exists. */
export declare function planBaleInactiveThreadCleanup(input: {
    profileName: string;
    bindings: readonly BaleThreadCleanupBindingSnapshot[];
    protection: readonly BaleThreadCleanupProtectionEvidence[];
    reservedTargets?: readonly {
        chatId: number;
        threadId: number;
    }[];
    provisioningTargets?: readonly {
        chatId: number;
        threadId: number;
    }[];
    cleanupTargets?: readonly {
        chatId: number;
        threadId: number;
    }[];
}): BaleThreadCleanupCandidate[];
/** Read ports for the bindings and target claims that cleanup evidence is captured from. */
export interface BaleInactiveThreadCleanupEvidencePorts<TBinding extends BaleThreadCleanupBindingSnapshot> {
    listBindings(): readonly TBinding[];
    getProtection(binding: TBinding): {
        liveOwner: BaleThreadCleanupProtectionState;
        acceptedWork: BaleThreadCleanupProtectionState;
        deliveryAuthority: BaleThreadCleanupProtectionState;
    };
    listReservations(): readonly {
        target: {
            chatId: number;
            threadId: number;
        };
    }[];
    listPendingProvisions(): readonly {
        target?: {
            chatId: number;
            threadId: number;
        };
    }[];
    listPendingCleanups(): readonly {
        target: {
            chatId: number;
            threadId: number;
        };
    }[];
}
export declare function captureBaleInactiveThreadCleanupEvidence<TBinding extends BaleThreadCleanupBindingSnapshot>(input: BaleInactiveThreadCleanupEvidencePorts<TBinding> & {
    profileName: string;
}): Parameters<typeof planBaleInactiveThreadCleanup>[0];
export declare function createBaleInactiveThreadCleanupReviewRuntime<TBinding extends BaleThreadCleanupBindingSnapshot>(deps: BaleInactiveThreadCleanupEvidencePorts<TBinding> & {
    getProfileName(): string;
    getWorkStore(): BaleThreadCleanupWorkStore;
    runWorkspaceOperation<T>(input: {
        operationId: string;
        operationKind: string;
        scopes: readonly [{
            kind: "profile";
        }];
    }, operation: () => Promise<T>): Promise<T>;
}): {
    review(): Promise<{
        count: number;
        operationId?: string;
    }>;
};
export type BaleThreadCleanupWorkState = "prepared" | "outcome-unknown" | "deleted";
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
export type BaleThreadCleanupDeletionPermit = BaleWorkspaceDeletionPermit;
export type BaleThreadCleanupFence = BaleWorkspaceRetirementFence;
export interface BaleThreadCleanupWorkStore {
    prepare(operationId: string, candidates: readonly BaleThreadCleanupCandidate[]): {
        prepared: boolean;
        workSet: BaleThreadCleanupWorkSet;
    };
    recordDeletionIssued(input: {
        operationId: string;
        bindingKey: string;
        bindingUpdatedAtMs: number;
        permit: BaleThreadCleanupDeletionPermit;
    }): {
        recorded: boolean;
        entry: BaleThreadCleanupWorkEntry;
    };
    confirmDeleted(input: {
        operationId: string;
        bindingKey: string;
    }): {
        confirmed: boolean;
        entry: BaleThreadCleanupWorkEntry;
    };
    list(): BaleThreadCleanupWorkSet[];
}
export declare function createBaleThreadCleanupWorkStore(options: {
    path: string;
    runtimeDir?: string;
    profileName: string;
    tokenSha256: string;
    /** Exact captured ledger identity; standalone fixtures may use the plain profile identity. */
    admissionProfileKey?: string;
    maxWorkSets?: number;
    maxBytes?: number;
    getNowMs?: () => number;
    onPublicationBoundary?: (boundary: "after-write-before-rename" | "after-rename") => void;
}): BaleThreadCleanupWorkStore;
export declare function commitBaleInactiveThreadCleanup(input: {
    store: BaleThreadCleanupWorkStore;
    operationId: string;
    bindingKey: string;
    commitBinding(): Promise<boolean>;
}): Promise<boolean>;
export declare function executeBaleInactiveThreadCleanup(input: {
    store: BaleThreadCleanupWorkStore;
    operationId: string;
    bindingKey: string;
    withWorkspaceDeletionBoundary<T>(operation: () => Promise<T>): Promise<T>;
    loadFreshEvidence(): Promise<Parameters<typeof planBaleInactiveThreadCleanup>[0]>;
    acquireDeletionPermit(candidate: BaleThreadCleanupCandidate): Promise<{
        kind: "issued";
        permit: BaleThreadCleanupDeletionPermit;
    } | {
        kind: "blocked" | "already-issued";
    }>;
    deleteWithPermit(permit: BaleThreadCleanupDeletionPermit, candidate: BaleThreadCleanupCandidate): Promise<void>;
}): Promise<{
    status: "deleted" | "blocked" | "outcome-unknown";
    entry?: BaleThreadCleanupWorkEntry;
}>;
export declare function createBaleThreadCleanupPermitRuntime(deps: {
    ledger: {
        getProfileKey(): string;
        read(): {
            fence?: BaleWorkspaceDestructiveFence;
        };
        acquireThreadCleanupFence(input: {
            operationId: string;
            cleanupWorkSetId: string;
            bindingKey: string;
            slot: string | null;
            target: {
                chatId: number;
                threadId: number;
            };
            leaderEpoch: number | string;
            cleanupRequestedAtMs: number;
        }): {
            kind: "acquired";
            fence: BaleThreadCleanupFence;
            resumed: boolean;
        } | {
            kind: "blocked";
            reason: string;
        };
        adoptThreadCleanupFence(fence: BaleThreadCleanupFence, replacement: {
            owner: {
                processId: number;
                processBirthId: string;
            };
            leaderEpoch: number | string;
        }): BaleThreadCleanupFence;
        issueThreadCleanupDeletionPermit(fence: BaleThreadCleanupFence): {
            kind: "issued";
            fence: BaleThreadCleanupFence;
            permit: BaleThreadCleanupDeletionPermit;
        } | {
            kind: "already-issued";
            fence: BaleThreadCleanupFence;
        };
        confirmThreadCleanupAbsence(fence: BaleThreadCleanupFence): BaleThreadCleanupFence;
        releaseUnissuedThreadCleanupFence(fence: BaleThreadCleanupFence): boolean;
        completeThreadCleanupFence(fence: BaleThreadCleanupFence): boolean;
    };
    getLeaderEpoch(): number | string | undefined;
    getProfileName(): string;
    getOwner(): {
        processId: number;
        processBirthId: string;
    };
    canAdoptFence(fence: BaleThreadCleanupFence): boolean;
    revalidateUnderFence(candidate: BaleThreadCleanupCandidate): Promise<boolean>;
    getNowMs?: () => number;
}): {
    acquire(candidate: BaleThreadCleanupCandidate, workSetId: string): Promise<{
        kind: "issued";
        fence: BaleThreadCleanupFence;
        permit: BaleThreadCleanupDeletionPermit;
    } | {
        kind: "blocked";
    } | {
        kind: "already-issued";
    }>;
    diagnoseRecovery(candidate: BaleThreadCleanupCandidate, workSetId: string): "none" | "fenced" | "deletion-issued" | "commit-ready" | "authority-blocked";
    findCommitReady(candidate: BaleThreadCleanupCandidate, workSetId: string): BaleThreadCleanupFence | undefined;
    settleDeleted(fence: BaleThreadCleanupFence, commit: () => Promise<boolean>): Promise<"completed" | "commit-pending">;
};
export interface BaleInactiveThreadCleanupCoordinatorDeps<TBinding> {
    store: BaleThreadCleanupWorkStore;
    permitRuntime: ReturnType<typeof createBaleThreadCleanupPermitRuntime>;
    resolveFullBinding(candidate: BaleThreadCleanupCandidate): Promise<TBinding | undefined>;
    deleteWithPermit(permit: BaleThreadCleanupDeletionPermit, candidate: BaleThreadCleanupCandidate): Promise<void>;
    commitBinding(candidate: BaleThreadCleanupCandidate, currentBinding?: TBinding): Promise<boolean>;
}
export interface BaleInactiveThreadCleanupAuthority {
    profileName: string;
    leaderEpoch: number | string;
    ledger: BaleWorkspaceAdmissionLedger;
    isCurrent(): boolean;
}
/** Review owns ordinary admission; confirmed cleanup uses the shared gate and its exclusive manual fence instead. */
export declare function createBaleInactiveThreadCleanupRuntime(deps: {
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
    review(): Promise<{
        count: number;
        operationId?: string;
    }>;
    clean(operationId: string): Promise<BaleInactiveThreadCleanupResult>;
};
export declare function createBaleInactiveThreadCleanupSettingsPort<TBinding>(deps: BaleInactiveThreadCleanupCoordinatorDeps<TBinding>): (operationId: string) => Promise<BaleInactiveThreadCleanupResult>;
export interface BaleInactiveThreadCleanupResult {
    deleted: number;
    outcomeUnknown: number;
    blocked: number;
    recovery?: "commit-ready" | "deletion-outcome-unknown" | "authority-blocked";
}
export declare function cleanReviewedInactiveThreads<TBinding>(input: {
    operationId: string;
} & BaleInactiveThreadCleanupCoordinatorDeps<TBinding>): Promise<BaleInactiveThreadCleanupResult>;

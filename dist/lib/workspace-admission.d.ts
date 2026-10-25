/**
 * Durable Bale Workspace admission and retirement fencing
 * Zones: bale workspace identity, filesystem authority, process recovery
 * Owns profile-scoped admission leases, destructive fences, and deletion permits
 * Excludes journal/API operations, retirement policy, and binding persistence
 */
import { type PathLike } from "node:fs";
import { type BaleProcessLiveness } from "./process-identity.ts";
import { type BaleTarget } from "./target.ts";
export interface BaleWorkspaceAdmissionOwner {
    processId: number;
    processBirthId: string;
}
export type BaleWorkspaceAdmissionScope = {
    kind: "target";
    target: BaleTarget & {
        threadId: number;
    };
} | {
    kind: "chat";
    chatId: number;
} | {
    kind: "profile";
};
interface BaleWorkspaceAdmissionLease {
    operationId: string;
    operationKind: string;
    profileKey: string;
    scope: BaleWorkspaceAdmissionScope;
    owner: BaleWorkspaceAdmissionOwner;
    acquiredAtMs: number;
}
type BaleWorkspaceDestructiveFenceKind = "pressure-retirement" | "manual-thread-cleanup" | "journal-writer-closure";
export type BaleWorkspaceDeletionFenceKind = Exclude<BaleWorkspaceDestructiveFenceKind, "journal-writer-closure">;
interface BaleWorkspaceJournalWriterClosureFence {
    destructiveKind: "journal-writer-closure";
    phase: "fenced";
    operationId: string;
    profileKey: string;
    recoveryKey: string;
    owner: BaleWorkspaceAdmissionOwner;
    requestedAtMs: number;
    acquiredAtMs: number;
}
export declare function normalizeBaleWorkspaceJournalWriterClosureFence(value: unknown, profileKey: string): BaleWorkspaceJournalWriterClosureFence | undefined;
interface BaleWorkspaceJournalWriterProtocolMode {
    version: 1;
    protocol: "custody-v3";
    profileKey: string;
    recoveryKey: string;
    startupAuthorityId: string;
    closureOperationId: string;
    writerInventorySha256: string;
    installedBy: BaleWorkspaceAdmissionOwner;
    installedAtMs: number;
}
export declare function normalizeBaleWorkspaceJournalWriterProtocolMode(value: unknown, profileKey: string): BaleWorkspaceJournalWriterProtocolMode | undefined;
interface BaleWorkspaceRetirementFenceBase {
    destructiveKind?: BaleWorkspaceDeletionFenceKind;
    operationId: string;
    retirementIntentId: string;
    profileKey: string;
    bindingKey: string;
    /** Null is admitted only for explicit manual cleanup of a slotless binding. */
    slot: string | null;
    target: BaleTarget & {
        threadId: number;
    };
    leaderEpoch: number | string;
    retirementRequestedAtMs: number;
    owner: BaleWorkspaceAdmissionOwner;
    acquiredAtMs: number;
}
export type BaleWorkspaceRetirementFence = (BaleWorkspaceRetirementFenceBase & {
    phase: "fenced";
}) | (BaleWorkspaceRetirementFenceBase & {
    phase: "deletion-issued";
    deletionIssuedAtMs: number;
}) | (BaleWorkspaceRetirementFenceBase & {
    destructiveKind?: "pressure-retirement";
    phase: "deletion-rejected";
    deletionIssuedAtMs: number;
    rejectionConfirmedAtMs: number;
}) | (BaleWorkspaceRetirementFenceBase & {
    phase: "commit-ready";
    absenceConfirmedAtMs: number;
    deletionIssuedAtMs?: number;
});
export type BaleWorkspaceDestructiveFence = BaleWorkspaceRetirementFence | BaleWorkspaceJournalWriterClosureFence;
export declare function isBaleWorkspaceRetirementFence(fence: BaleWorkspaceDestructiveFence): fence is BaleWorkspaceRetirementFence;
export interface BaleWorkspaceDeletionPermit {
    readonly destructiveKind?: BaleWorkspaceDeletionFenceKind;
    readonly operationId: string;
    readonly retirementIntentId: string;
    readonly profileKey: string;
    readonly bindingKey: string;
    readonly slot: string | null;
    readonly target: BaleTarget & {
        threadId: number;
    };
    readonly leaderEpoch: number | string;
    readonly issuedAtMs: number;
}
type BaleWorkspaceAdmissionAcquireResult = {
    kind: "acquired";
    lease: BaleWorkspaceAdmissionLease;
    resumed: boolean;
} | {
    kind: "blocked";
    reason: "retirement-fenced";
};
type BaleWorkspaceRetirementFenceAcquireResult = {
    kind: "acquired";
    fence: BaleWorkspaceRetirementFence;
    resumed: boolean;
} | {
    kind: "blocked";
    reason: "admission-active" | "retirement-active";
};
type BaleWorkspaceJournalWriterProtocolInstallResult = {
    mode: BaleWorkspaceJournalWriterProtocolMode;
    resumed: boolean;
};
type BaleWorkspaceJournalWriterClosureAcquireResult = {
    kind: "acquired";
    fence: BaleWorkspaceJournalWriterClosureFence;
    resumed: boolean;
} | {
    kind: "blocked";
    reason: "admission-active" | "retirement-active";
};
type BaleWorkspaceDeletionPermitResult = {
    kind: "issued";
    fence: BaleWorkspaceRetirementFence;
    permit: BaleWorkspaceDeletionPermit;
} | {
    kind: "already-issued";
    fence: BaleWorkspaceRetirementFence;
};
interface BaleWorkspaceAdmissionLedgerSnapshot {
    profileKey: string;
    leases: BaleWorkspaceAdmissionLease[];
    fence?: BaleWorkspaceDestructiveFence;
    writerProtocolMode?: BaleWorkspaceJournalWriterProtocolMode;
}
type BaleWorkspaceAdmissionPublicationBoundary = "before-write" | "after-write-before-rename";
interface BaleWorkspaceAdmissionLedgerOptions {
    path: string;
    /** Explicit logical section identity for the consolidated root; absent means the standalone ledger adapter. */
    stateProfile?: string;
    profileKey: string;
    owner: BaleWorkspaceAdmissionOwner;
    getNowMs?: () => number;
    getProcessLiveness?: (owner: BaleWorkspaceAdmissionOwner) => BaleProcessLiveness;
    publishRename?: (sourcePath: PathLike, destinationPath: PathLike) => void;
    onPublicationBoundary?: (boundary: BaleWorkspaceAdmissionPublicationBoundary, path: string) => void;
    authorizeJournalWriterProtocolClosure?: (input: {
        mode: BaleWorkspaceJournalWriterProtocolMode;
        closure: BaleWorkspaceJournalWriterClosureFence;
    }) => boolean;
}
export declare class BaleWorkspaceAdmissionError extends Error {
    readonly code: "invalid-input" | "invalid-state" | "state-unavailable" | "authority-changed" | "admission-blocked" | "publication-unknown";
    constructor(code: BaleWorkspaceAdmissionError["code"], message: string, options?: ErrorOptions);
}
export interface BaleWorkspaceAdmissionLedger {
    getProfileKey: () => string;
    getOwner: () => BaleWorkspaceAdmissionOwner;
    listReservedSlots: () => string[];
    read: () => BaleWorkspaceAdmissionLedgerSnapshot;
    acquireAdmission: (input: {
        operationId: string;
        operationKind: string;
        scope: BaleWorkspaceAdmissionScope;
    }) => BaleWorkspaceAdmissionAcquireResult;
    releaseAdmission: (expected: BaleWorkspaceAdmissionLease) => boolean;
    acquireJournalWriterClosure: (input: {
        operationId: string;
        recoveryKey: string;
        requestedAtMs: number;
    }) => BaleWorkspaceJournalWriterClosureAcquireResult;
    releaseJournalWriterClosure: (expected: BaleWorkspaceJournalWriterClosureFence) => boolean;
    installJournalWriterProtocolMode: (expected: BaleWorkspaceJournalWriterClosureFence, input: {
        startupAuthorityId: string;
        writerInventorySha256: string;
    }) => BaleWorkspaceJournalWriterProtocolInstallResult;
    acquireJournalWriterAdmission: (input: {
        operationId: string;
        recoveryKey: string;
        startupAuthorityId: string;
        closureOperationId: string;
        writerInventorySha256: string;
    }) => BaleWorkspaceAdmissionAcquireResult;
    acquireRetirementFence: (input: {
        operationId: string;
        retirementIntentId: string;
        bindingKey: string;
        slot: string;
        target: BaleTarget & {
            threadId: number;
        };
        leaderEpoch: number | string;
        retirementRequestedAtMs: number;
    }) => BaleWorkspaceRetirementFenceAcquireResult;
    acquireThreadCleanupFence: (input: {
        operationId: string;
        cleanupWorkSetId: string;
        bindingKey: string;
        slot: string | null;
        target: BaleTarget & {
            threadId: number;
        };
        leaderEpoch: number | string;
        cleanupRequestedAtMs: number;
    }) => BaleWorkspaceRetirementFenceAcquireResult;
    adoptRetirementFence: (expected: BaleWorkspaceRetirementFence, replacement: {
        owner: BaleWorkspaceAdmissionOwner;
        leaderEpoch: number | string;
    }) => BaleWorkspaceRetirementFence;
    adoptThreadCleanupFence: BaleWorkspaceAdmissionLedger["adoptRetirementFence"];
    issueDeletionPermit: (expected: BaleWorkspaceRetirementFence) => BaleWorkspaceDeletionPermitResult;
    issueThreadCleanupDeletionPermit: BaleWorkspaceAdmissionLedger["issueDeletionPermit"];
    confirmRetirementAbsence: (expected: BaleWorkspaceRetirementFence) => BaleWorkspaceRetirementFence;
    confirmThreadCleanupAbsence: BaleWorkspaceAdmissionLedger["confirmRetirementAbsence"];
    /** Caller must have exact transport proof of rejection, never merely target presence. */
    confirmRetirementRejection: (expected: BaleWorkspaceRetirementFence) => BaleWorkspaceRetirementFence;
    /** Caller must first durably withdraw the exact rejected intent, retaining its binding. */
    completeRejectedRetirementFence: (expected: BaleWorkspaceRetirementFence) => boolean;
    releaseUnissuedRetirementFence: (expected: BaleWorkspaceRetirementFence) => boolean;
    releaseUnissuedThreadCleanupFence: BaleWorkspaceAdmissionLedger["releaseUnissuedRetirementFence"];
    completeRetirementFence: (expected: BaleWorkspaceRetirementFence) => boolean;
    completeThreadCleanupFence: BaleWorkspaceAdmissionLedger["completeRetirementFence"];
}
export declare function resolveBaleWorkspaceDestructiveFenceKind(fence: {
    destructiveKind?: BaleWorkspaceDestructiveFenceKind;
}): BaleWorkspaceDestructiveFenceKind;
/** Pure damage check for one consolidated admission section under its own stored profile key; throws when invalid. */
export declare function assertBaleConsolidatedAdmissionSection(value: unknown, stateProfile: string): void;
export declare function createBaleWorkspaceAdmissionOperationId(): string;
export declare function createBaleWorkspaceAdmissionProfileKey(input: {
    profileName?: string;
    botToken: string;
}): string;
interface BaleWorkspaceAdmissionRuntimeBinding {
    resolve: () => BaleWorkspaceAdmissionLedger | undefined;
}
export declare function createBaleWorkspaceAdmissionRuntimeBinding(input: {
    getProfileName: () => string | undefined;
    getBotToken: () => string | undefined;
    owner: BaleWorkspaceAdmissionOwner;
    getNowMs?: () => number;
    getProcessLiveness?: (owner: BaleWorkspaceAdmissionOwner) => BaleProcessLiveness;
} & ({
    getPath: (profileName?: string) => string;
    getStatePath?: never;
} | {
    getStatePath: () => string;
    getPath?: never;
})): BaleWorkspaceAdmissionRuntimeBinding;
/** Stable admission-scope identity used by leases and admission-gated journal operations. */
export declare function getBaleWorkspaceAdmissionScopeKey(scope: BaleWorkspaceAdmissionScope): string;
export declare function runWithBaleWorkspaceAdmissions<T>(input: {
    ledger: Pick<BaleWorkspaceAdmissionLedger, "acquireAdmission" | "releaseAdmission">;
    operationId: string;
    operationKind: string;
    scopes: readonly BaleWorkspaceAdmissionScope[];
    operation: () => T;
}): T;
export declare function createBaleWorkspaceJournalWriterAdmission(input: {
    ledger: Pick<BaleWorkspaceAdmissionLedger, "acquireAdmission" | "acquireJournalWriterAdmission" | "releaseAdmission">;
    protocolAuthority?: Omit<Parameters<BaleWorkspaceAdmissionLedger["acquireJournalWriterAdmission"]>[0], "operationId">;
    createOperationId?: () => string;
    onReleaseError?: (error: unknown) => void;
}): <T>(operation: () => T) => T;
export declare function runWithBaleWorkspaceAdmissionsAsync<T>(input: {
    ledger: Pick<BaleWorkspaceAdmissionLedger, "acquireAdmission" | "releaseAdmission">;
    operationId: string;
    operationKind: string;
    scopes: readonly BaleWorkspaceAdmissionScope[];
    operation: () => Promise<T>;
    onReleaseError?: (error: unknown) => void;
}): Promise<T>;
export declare function createBaleWorkspaceAdmissionLedger(options: BaleWorkspaceAdmissionLedgerOptions): BaleWorkspaceAdmissionLedger;
export {};

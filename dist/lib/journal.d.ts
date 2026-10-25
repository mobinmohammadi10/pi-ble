/**
 * Bale durable inbound update journal
 * Zones: bale inbound, filesystem authority, crash recovery
 * Owns profile/bot-scoped raw updates, schema validation, deduplication,
 * bounded atomic publication, durable queue-receipt/failure state, and compaction.
 * It does not own polling, update execution, queue admission, or follower routing.
 */
import { type BaleProcessLiveness } from "./process-identity.ts";
import { type BaleWorkspaceAdmissionLedger, type BaleWorkspaceAdmissionScope } from "./workspace-admission.ts";
export declare const BALE_UPDATE_JOURNAL_VERSION: 1;
export declare const BALE_UPDATE_JOURNAL_EXCLUSION_VERSION: 2;
export declare const BALE_UPDATE_JOURNAL_CUSTODY_VERSION: 3;
export declare const BALE_UPDATE_JOURNAL_QUEUE_OWNER_ID_MAX_LENGTH = 256;
export declare const BALE_UPDATE_JOURNAL_FAILURE_CLASS_MAX_LENGTH = 128;
export declare const BALE_UPDATE_JOURNAL_FAILURE_SUMMARY_MAX_LENGTH = 512;
export interface BaleFollowerJournalDiscovery {
    paths: string[];
    complete: boolean;
}
/** Read-only discovery for canonical follower journal snapshots and segment roots. */
export declare function discoverBaleFollowerJournalPaths(input: {
    directory: string;
    profileName?: string;
}): BaleFollowerJournalDiscovery;
/** Bounded read-only session-family discovery, not writer closure or deletion authority. */
export declare function discoverBaleSessionJournalPaths(input: {
    directory: string;
    profileName?: string;
    maxDirectoryEntries?: number;
}): BaleFollowerJournalDiscovery;
/** Transitional discovery covers both retained flat recipients and session-owned families. */
export declare function discoverBaleRecipientJournalPaths(input: {
    directory: string;
    profileName?: string;
}): BaleFollowerJournalDiscovery;
export declare const BALE_UPDATE_JOURNAL_COMPACTION_SEGMENT_COUNT = 256;
export declare const BALE_UPDATE_JOURNAL_COMPACTION_SEGMENT_BYTES: number;
export type BaleUpdateJournalErrorCode = "capacity" | "conflict" | "identity-mismatch" | "invalid" | "io" | "unsupported-version" | "pairing-evidence" | "sender-denied";
export declare class BaleUpdateJournalError extends Error {
    readonly code: BaleUpdateJournalErrorCode;
    readonly path: string;
    constructor(code: BaleUpdateJournalErrorCode, path: string, message: string, options?: ErrorOptions);
}
export interface BaleUpdateJournalBotIdentity {
    botId?: number;
    tokenSha256: string;
}
export interface BaleUpdateJournalInput {
    update_id: number;
}
export type BaleJournaledUpdate = BaleUpdateJournalInput & Record<string, unknown>;
export declare function getBaleUpdateJournalAdmissionScopes(updates: readonly (BaleUpdateJournalInput & Record<string, unknown>)[]): BaleWorkspaceAdmissionScope[];
export type BaleUpdateJournalEntryState = "pending" | "retry-wait" | "queued" | "failed";
export type BaleUpdateJournalQueueKind = "prompt" | "control";
export interface BaleUpdateJournalQueueProcessIdentity {
    processId: number;
    processBirthId: string;
}
export interface BaleUpdateJournalQueueRuntimeIdentity extends BaleUpdateJournalQueueProcessIdentity {
    instanceId: string;
}
export interface BaleUpdateJournalQueueOwnerIdentity extends BaleUpdateJournalQueueRuntimeIdentity {
    sessionGeneration: number;
}
export interface BaleUpdateJournalQueueOwner extends BaleUpdateJournalQueueOwnerIdentity {
    acquisitionId: string;
    acquiredAtMs: number;
    handoffId?: string;
}
export interface BaleUpdateJournalQueueHandoff {
    handoffId: string;
    offeredAtMs: number;
    recipientOwner: BaleUpdateJournalQueueOwnerIdentity;
}
export type BaleUpdateJournalInputHandoff = BaleUpdateJournalQueueHandoff;
/** V3 evidence; decoding it grants neither live execution nor Pi queue authority. */
export interface BaleUpdateJournalInputClaim {
    phase: "ready" | "running";
    owner: BaleUpdateJournalQueueOwner;
    recipientBindingKey: string;
    /** Present freezes ready donor execution until exact acceptance or cancellation. */
    handoff?: BaleUpdateJournalInputHandoff;
    /** Absent means the original update; present preserves an exact routed projection. */
    executionUpdate?: BaleJournaledUpdate;
}
/** Immutable transition evidence, never concurrent raw-input execution authority. */
export interface BaleUpdateJournalInputProvenance {
    owner: BaleUpdateJournalQueueOwner;
    recipientBindingKey: string;
    executionUpdate?: BaleJournaledUpdate;
}
export interface BaleUpdateJournalFailure {
    attemptCount: number;
    failedAtMs: number;
    failureClass: string;
    summary: string;
}
export type BaleUpdateJournalOperatorDispositionAction = "retry" | "discard";
export interface BaleUpdateJournalLegacyCustodyEvidence {
    updateId: number;
    state: "retry-wait" | "failed";
    attemptCount: number;
    failedAtMs: number;
    failureClass: string;
    summary: string;
    nextRetryAtMs?: number;
    terminalAtMs?: number;
    terminalReason?: string;
    terminalFailureId?: string;
    evidenceSha256: string;
}
export interface BaleUpdateJournalLegacyCustodyCandidate {
    updateId: number;
    state: "retry-wait" | "failed";
    attemptCount: number;
    failureClass: string;
    evidenceSha256: string;
}
export interface BaleUpdateJournalLegacyCustodyDispositionAuthority {
    version: 1;
    dispositionId: string;
    updateId: number;
    evidenceSha256: string;
    action: "requeue-v3" | "discard";
    operatorAuthorityId: string;
    authorizedAtMs: number;
}
export declare function createBaleUpdateJournalLegacyCustodyEvidence(entry: BaleUpdateJournalEntry): BaleUpdateJournalLegacyCustodyEvidence | undefined;
export declare function normalizeBaleUpdateJournalLegacyCustodyDispositionAuthority(value: unknown, expected: BaleUpdateJournalLegacyCustodyEvidence): BaleUpdateJournalLegacyCustodyDispositionAuthority | undefined;
export interface BaleUpdateJournalTerminalOperatorDisposition {
    failureId: string;
    updateId: number;
    action: BaleUpdateJournalOperatorDispositionAction;
    committedAtMs: number;
    attemptCount: number;
    failureClass: string;
    terminalAtMs: number;
    terminalReason: string;
}
export interface BaleUpdateJournalLegacyCustodyDisposition {
    dispositionKind: "legacy-custody";
    failureId: string;
    updateId: number;
    action: "requeue-v3" | "discard";
    committedAtMs: number;
    evidenceSha256: string;
    operatorAuthorityId: string;
    authorizedAtMs: number;
}
export type BaleUpdateJournalOperatorDisposition = BaleUpdateJournalTerminalOperatorDisposition | BaleUpdateJournalLegacyCustodyDisposition;
export declare const BALE_ROUTING_INPUT_TTL_MS: number;
/** A source-only choice deadline, never a queue lease or a Thread deletion grant. */
/** Where a source's chooser was published, so a restarted owner can revive that exact message. */
export interface BaleUpdateJournalRoutingChooser {
    chatId: number;
    threadId?: number;
    messageId: number;
}
export interface BaleUpdateJournalRoutingInput {
    operatorUserId: number;
    publishedAtMs: number;
    expiresAtMs: number;
    phase: "waiting" | "selected";
    chooser?: BaleUpdateJournalRoutingChooser;
}
export interface BaleUpdateJournalEntry {
    updateId: number;
    update: BaleJournaledUpdate;
    /** Mandatory in v2/v3; immutable veto, never sender authorization. Absent only in legacy v1. */
    preApprovalExcluded?: boolean;
    admittedAtMs: number;
    routingInput?: BaleUpdateJournalRoutingInput;
    state: BaleUpdateJournalEntryState;
    queueKind?: BaleUpdateJournalQueueKind;
    queueReceiptId?: string;
    queueOwner?: BaleUpdateJournalQueueOwner;
    queueHandoff?: BaleUpdateJournalQueueHandoff;
    inputClaim?: BaleUpdateJournalInputClaim;
    inputProvenance?: BaleUpdateJournalInputProvenance;
    failure?: BaleUpdateJournalFailure;
    nextRetryAtMs?: number;
    terminalAtMs?: number;
    terminalReason?: string;
    terminalFailureId?: string;
}
/** Exact parsed journal entry identity, checked inside the source owner's mutation transaction. */
export interface BaleUpdateJournalEntryDigest {
    updateId: number;
    sourceSha256: string;
}
/** Journal-owned removal ACK bound to an opaque, immutable caller acceptance scope. */
export interface BaleUpdateJournalSourceCompletion extends BaleUpdateJournalEntryDigest {
    completionSha256: string;
}
export declare function createBaleUpdateJournalEntryDigest(entry: BaleUpdateJournalEntry): BaleUpdateJournalEntryDigest;
export interface BaleUpdateJournalFile {
    version: typeof BALE_UPDATE_JOURNAL_VERSION | typeof BALE_UPDATE_JOURNAL_EXCLUSION_VERSION | typeof BALE_UPDATE_JOURNAL_CUSTODY_VERSION;
    revision?: number;
    acceptedThroughUpdateId?: number;
    profile: string;
    botIdentity: BaleUpdateJournalBotIdentity;
    entries: BaleUpdateJournalEntry[];
    operatorDispositions?: BaleUpdateJournalOperatorDisposition[];
    sourceCompletions?: BaleUpdateJournalSourceCompletion[];
}
export interface BaleUpdateJournalSnapshot extends BaleUpdateJournalFile {
    exists: boolean;
    serializedBytes: number;
}
export interface BaleUpdateJournalAppendResult {
    /** Retained batch sources without the immutable veto; not sender authorization. */
    nonExcludedUpdateIds: number[];
    addedUpdateIds: number[];
    duplicateUpdateIds: number[];
    entryCount: number;
    serializedBytes: number;
}
export interface BaleUpdateJournalRemoveResult {
    sourceCompletions?: BaleUpdateJournalSourceCompletion[];
    removedUpdateIds: number[];
    entryCount: number;
    serializedBytes: number;
}
export interface BaleUpdateJournalQueueReceipt {
    queueKind: BaleUpdateJournalQueueKind;
    receiptId: string;
    sourceUpdateIds: readonly number[];
    owner: BaleUpdateJournalQueueOwnerIdentity;
}
export interface BaleUpdateJournalQueueResult {
    queuedUpdateIds: number[];
    duplicateUpdateIds: number[];
    queueOwner?: BaleUpdateJournalQueueOwner;
    entryCount: number;
    serializedBytes: number;
}
export interface BaleUpdateJournalQueuedReceiptEvidence {
    receipt: BaleUpdateJournalQueuedCompletion;
    sources: BaleUpdateJournalEntryDigest[];
    queueOwnerSha256: string;
}
export interface BaleUpdateJournalQueuedCompletion {
    queueKind: BaleUpdateJournalQueueKind;
    receiptId: string;
    sourceUpdateIds: readonly number[];
    queueOwner: BaleUpdateJournalQueueOwner;
}
export interface BaleUpdateJournalQueueHandoffInput {
    queueKind: BaleUpdateJournalQueueKind;
    receiptId: string;
    sourceUpdateIds: readonly number[];
    expectedOwner: BaleUpdateJournalQueueOwner;
    recipientOwner: BaleUpdateJournalQueueOwnerIdentity;
    handoffToken: string;
}
export interface BaleUpdateJournalQueueHandoffOfferResult {
    handoff: BaleUpdateJournalQueueHandoff;
    previousOwner: BaleUpdateJournalQueueOwner;
    offeredUpdateIds: number[];
    duplicate: boolean;
    entryCount: number;
    serializedBytes: number;
}
export interface BaleUpdateJournalQueueHandoffAcceptResult {
    handoffId: string;
    previousOwner?: BaleUpdateJournalQueueOwner;
    queueOwner: BaleUpdateJournalQueueOwner;
    acceptedUpdateIds: number[];
    duplicate: boolean;
    entryCount: number;
    serializedBytes: number;
}
export interface BaleUpdateJournalQueueHandoffCancelResult {
    handoffId: string;
    previousOwner: BaleUpdateJournalQueueOwner;
    cancelledUpdateIds: number[];
    entryCount: number;
    serializedBytes: number;
}
export interface BaleUpdateJournalQueueDiscardInput {
    queueKind: BaleUpdateJournalQueueKind;
    receiptId: string;
    sourceUpdateIds: readonly number[];
    expectedOwner: BaleUpdateJournalQueueOwner;
}
export interface BaleUpdateJournalQueueDiscardResult {
    previousOwner: BaleUpdateJournalQueueOwner;
    removedUpdateIds: number[];
    entryCount: number;
    serializedBytes: number;
}
export interface BaleUpdateJournalDeadQueueOwnerRecoveryInput {
    queueKind: BaleUpdateJournalQueueKind;
    receiptId: string;
    sourceUpdateIds: readonly number[];
    deadOwner: BaleUpdateJournalQueueOwner;
    recoveryOwner: BaleUpdateJournalQueueOwnerIdentity;
}
export type BaleUpdateJournalDeadQueueOwnerRecoveryResult = {
    status: "owner-alive" | "owner-unverifiable";
    previousOwner: BaleUpdateJournalQueueOwner;
    recoveredUpdateIds: [];
    entryCount: number;
    serializedBytes: number;
} | {
    status: "recovered";
    previousOwner: BaleUpdateJournalQueueOwner;
    recoveredUpdateIds: number[];
    entryCount: number;
    serializedBytes: number;
};
export interface BaleUpdateJournalFailureInput {
    updateId: number;
    expectedAttemptCount: number;
    failedAtMs: number;
    failureClass: string;
    summary: string;
    disposition: "retry-wait" | "failed";
    nextRetryAtMs?: number;
    terminalReason?: string;
}
export interface BaleUpdateJournalFailureResult {
    entry: BaleUpdateJournalEntry;
    entryCount: number;
    serializedBytes: number;
}
export interface BaleUpdateJournalOperatorDispositionInput {
    updateId: number;
    failureId: string;
    action: BaleUpdateJournalOperatorDispositionAction;
}
export interface BaleUpdateJournalLegacyCustodyDispositionResult {
    disposition: BaleUpdateJournalLegacyCustodyDisposition;
    duplicate: boolean;
    entryCount: number;
    serializedBytes: number;
}
export interface BaleUpdateJournalOperatorDispositionResult {
    disposition: BaleUpdateJournalTerminalOperatorDisposition;
    duplicate: boolean;
    entryCount: number;
    serializedBytes: number;
}
export interface BaleUpdateJournalPendingAbandonmentInput {
    journalBindingKey: string;
    entry: BaleUpdateJournalEntry;
    operatorAuthorityId: string;
    /** Caller proves owner authorization and excludes live chooser/worker dispatch through publication. */
    isCurrent: () => boolean;
}
export interface BaleUpdateJournalPendingAbandonmentResult {
    disposition: BaleUpdateJournalLegacyCustodyDisposition;
    retainedPath: string;
    duplicate: boolean;
    entryCount: number;
    serializedBytes: number;
}
/** Private evidence copy, not execution authority or proof that abandonment committed. */
export interface BaleUpdateJournalRetainedInput {
    version: 1;
    kind: "pending-input-retention";
    journalBindingKey: string;
    entry: BaleUpdateJournalEntry;
    requestedDisposition: BaleUpdateJournalLegacyCustodyDisposition;
}
export interface BaleUpdateJournalPendingRetentionEvidence {
    journalBindingKey: string;
    retainedPath: string;
    requestedDisposition: BaleUpdateJournalLegacyCustodyDisposition;
}
/** Durable proof that an owner abandoned this exact pending source; never delivery or completion proof. */
export interface BaleUpdateJournalAbandonedPendingEvidence {
    journalBindingKey: string;
    updateId: number;
    retainedPath: string;
    operatorAuthorityId: string;
}
export interface BaleRoutingInputAuthority {
    journalBindingKey: string;
    entries: readonly BaleUpdateJournalEntry[];
    operatorUserId: number;
    isCurrent(): boolean;
}
/** Expiry drops a donor attempt without retaining its body or claiming recipient execution/cancellation. */
export type BaleRoutingInputExpiryResult = Omit<BaleUpdateJournalPendingAbandonmentResult, "retainedPath">;
export type BaleRoutingInputExpiryEvidence = Omit<BaleUpdateJournalAbandonedPendingEvidence, "retainedPath">;
/** Package-private v1 capability; raw input custody does not expose it. */
export interface BaleRoutingInputJournal {
    arm(input: BaleRoutingInputAuthority & {
        publishedAtMs: number;
        chooser?: BaleUpdateJournalRoutingChooser;
    }): BaleUpdateJournalEntry[];
    select(input: BaleRoutingInputAuthority): {
        issued: boolean;
        entries: BaleUpdateJournalEntry[];
    };
    expire(input: Omit<BaleRoutingInputAuthority, "entries"> & {
        entry: BaleUpdateJournalEntry;
    }): BaleRoutingInputExpiryResult;
    inspectExpiry(updateId: number): BaleRoutingInputExpiryEvidence | undefined;
    inspectGroupExpiry(updateIds: readonly number[]): BaleRoutingInputExpiryEvidence[] | undefined;
}
export interface BaleUpdateJournalStore {
    routingInputs?: BaleRoutingInputJournal;
    read(): BaleUpdateJournalSnapshot;
    /** Read-only: the committed abandonment tombstone plus its matching private retention, or undefined. */
    inspectAbandonedPending(updateId: number): BaleUpdateJournalAbandonedPendingEvidence | undefined;
    /** Read-only protection evidence for this snapshot entry, never commit/execution authority. */
    inspectPendingRetention(entry: BaleUpdateJournalEntry): BaleUpdateJournalPendingRetentionEvidence | undefined;
    abandonPending(input: BaleUpdateJournalPendingAbandonmentInput): BaleUpdateJournalPendingAbandonmentResult;
    appendBatch<TUpdate extends BaleUpdateJournalInput>(updates: readonly TUpdate[], acceptedThroughUpdateId?: number): BaleUpdateJournalAppendResult;
    markQueued(receipt: BaleUpdateJournalQueueReceipt): BaleUpdateJournalQueueResult;
    markExecutionFailure(input: BaleUpdateJournalFailureInput): BaleUpdateJournalFailureResult;
    applyOperatorDisposition(input: BaleUpdateJournalOperatorDispositionInput): BaleUpdateJournalOperatorDispositionResult;
    applyLegacyCustodyDisposition(authority: BaleUpdateJournalLegacyCustodyDispositionAuthority): BaleUpdateJournalLegacyCustodyDispositionResult;
    offerQueuedHandoff(input: BaleUpdateJournalQueueHandoffInput): BaleUpdateJournalQueueHandoffOfferResult;
    acceptQueuedHandoff(input: BaleUpdateJournalQueueHandoffInput): BaleUpdateJournalQueueHandoffAcceptResult;
    cancelQueuedHandoff(input: BaleUpdateJournalQueueHandoffInput): BaleUpdateJournalQueueHandoffCancelResult;
    completeQueued(receipts: readonly BaleUpdateJournalQueuedCompletion[]): BaleUpdateJournalRemoveResult;
    /** Strict v1 whole-receipt disposal co-publishes caller-scoped ACKs; never a readiness grant. */
    completeQueuedExact(receipts: readonly BaleUpdateJournalQueuedCompletion[], completions: readonly BaleUpdateJournalSourceCompletion[]): BaleUpdateJournalRemoveResult;
    discardQueued(input: BaleUpdateJournalQueueDiscardInput): BaleUpdateJournalQueueDiscardResult;
    recoverDeadQueueOwner(input: BaleUpdateJournalDeadQueueOwnerRecoveryInput): BaleUpdateJournalDeadQueueOwnerRecoveryResult;
    removeCompleted(updateIds: readonly number[]): BaleUpdateJournalRemoveResult;
    /** Guarded completion; every supplied source must still match, and absence is a conflict, not an ACK. */
    removeCompletedExact(updateIds: readonly number[], expectedSources: readonly BaleUpdateJournalEntryDigest[], completions?: readonly BaleUpdateJournalSourceCompletion[], isCurrent?: () => boolean): BaleUpdateJournalRemoveResult;
    /** Strict read-only observation; neither source absence nor a different scope is completion evidence. */
    inspectSourceCompletion(expected: BaleUpdateJournalSourceCompletion): BaleUpdateJournalSourceCompletion | undefined;
    /** Complete strict observation of a retained, unoffered v1 queue receipt; never acquires readiness. */
    inspectQueuedReceipt(expected: BaleUpdateJournalQueuedCompletion): BaleUpdateJournalQueuedReceiptEvidence | undefined;
    isQueueReceiptCurrent?: (receipt: Pick<BaleUpdateJournalQueuedCompletion, "queueKind" | "receiptId" | "sourceUpdateIds"> & {
        journalBindingKey?: string;
    }, owner: BaleUpdateJournalQueueOwner) => boolean;
}
export type BaleUpdateJournalPublicationBoundary = "before-write" | "after-write-before-rename";
export interface BaleUpdateJournalRecoveryEvent {
    kind: "repaired" | "reset";
    path: string;
    revision?: number;
    /** Damaged snapshot/segment paths deleted or atomically replaced; nothing is retained for recovery. */
    deletedPaths?: string[];
    reason: string;
}
export interface BaleUpdateJournalStoreOptions {
    path: string;
    profileName?: string;
    botIdentity: BaleUpdateJournalBotIdentity;
    maxEntries?: number;
    maxBytes?: number;
    getNowMs?: () => number;
    onRecovery?: (event: BaleUpdateJournalRecoveryEvent) => void;
    queueRuntimeIdentity?: BaleUpdateJournalQueueRuntimeIdentity;
    getQueueProcessLiveness?: (owner: BaleUpdateJournalQueueProcessIdentity) => BaleProcessLiveness;
    /** Optional outer writer fence. Must authorize before source serialization/journal locking and must not perform journal I/O. */
    withWriterAdmission?: <T>(operation: () => T) => T;
    /** Explicit operator authority for quarantined legacy retry/failure disposition. Production omission disables mutation. */
    authorizeLegacyCustodyDisposition?: (authority: BaleUpdateJournalLegacyCustodyDispositionAuthority) => boolean;
    /** Lock-only synchronous serialization, not source authorization or schema selection. Use the same config resource as admission hooks. */
    withSourceSerialization?: <T>(operation: () => T) => T;
    /** Opt-in strict consumption. Caller binds all gates to the same config resource and excludes other writers. */
    sourceAccess?: {
        directory: string;
        limits: {
            maxFiles: number;
            maxBytes: number;
            maxEntries: number;
            maxWork: number;
        };
    };
    /** Opt-in v2 for cursor-ordered polling admission only. Must hold config authority through synchronous publish. */
    withPairingAdmission?: <T>(publish: (preApprovalExcluded: boolean) => T) => T;
    /** Paired-only v1 gate over canonical inputs. Runs inside Workspace admission, before journal locking. */
    withPairedAdmission?: <T>(updates: readonly BaleJournaledUpdate[], publish: () => T) => {
        admitted: false;
    } | {
        admitted: true;
        value: T;
    };
    workspaceAdmission?: Pick<BaleWorkspaceAdmissionLedger, "acquireAdmission" | "releaseAdmission">;
    onPublicationBoundary?: (boundary: BaleUpdateJournalPublicationBoundary, publicationPath: string) => void;
}
export interface BaleInputJournalSourceReference {
    journalBindingKey: string;
    tokenSha256: string;
    updateId: number;
}
export interface BaleInputJournalReceipt extends BaleInputJournalSourceReference {
    owner: BaleUpdateJournalQueueOwner;
}
export interface BaleInputJournalReleaseResult {
    released: boolean;
    entryCount: number;
    serializedBytes: number;
}
export interface BaleInputJournalRecoveryInput {
    receipt: BaleInputJournalReceipt;
    recoveryOwner: BaleUpdateJournalQueueOwnerIdentity;
}
export interface BaleInputJournalRecoveryResult {
    status: "owner-alive" | "owner-unverifiable" | "unclaimed" | "recovered";
    entryCount: number;
    serializedBytes: number;
}
export interface BaleInputJournalHandoffOfferInput {
    receipt: BaleInputJournalReceipt;
    recipientOwner: BaleUpdateJournalQueueOwnerIdentity;
    handoffToken: string;
}
export interface BaleInputJournalHandoffAcceptInput {
    source: BaleInputJournalSourceReference;
    recipientOwner: BaleUpdateJournalQueueOwnerIdentity;
    handoffId: string;
}
export interface BaleInputJournalHandoffCancelInput {
    receipt: BaleInputJournalReceipt;
    recipientOwner: BaleUpdateJournalQueueOwnerIdentity;
    handoffId: string;
}
export interface BaleInputJournalQueueInput {
    queueKind: BaleUpdateJournalQueueKind;
    receiptId: string;
    receipts: readonly BaleInputJournalReceipt[];
}
export interface BaleInputJournalQueueResult {
    queued: boolean;
    queueReceipt: BaleUpdateJournalQueuedCompletion;
    entryCount: number;
    serializedBytes: number;
}
export interface BaleInputJournalHandoffOfferResult {
    source: BaleInputJournalSourceReference;
    handoff: BaleUpdateJournalInputHandoff;
    previousOwner: BaleUpdateJournalQueueOwner;
    duplicate: boolean;
    entryCount: number;
    serializedBytes: number;
}
export interface BaleInputJournalHandoffAcceptResult {
    handoffId: string;
    previousOwner?: BaleUpdateJournalQueueOwner;
    receipt: BaleInputJournalReceipt;
    duplicate: boolean;
    entryCount: number;
    serializedBytes: number;
}
export interface BaleInputJournalHandoffCancelResult {
    handoffId: string;
    previousOwner: BaleUpdateJournalQueueOwner;
    cancelled: boolean;
    entryCount: number;
    serializedBytes: number;
}
export interface BaleInputJournalStore {
    read: BaleUpdateJournalStore["read"];
    appendBatch: BaleUpdateJournalStore["appendBatch"];
    listLegacyCustodyCandidates(): BaleUpdateJournalLegacyCustodyCandidate[];
    applyLegacyCustodyDisposition: BaleUpdateJournalStore["applyLegacyCustodyDisposition"];
    /** Removes vetoed input only; an absent ID inside the retained cursor is a no-op, not completion evidence. */
    removeExcluded(updateIds: readonly number[]): BaleUpdateJournalRemoveResult;
    acquireInput(input: {
        updateId: number;
        recipientBindingKey: string;
        executionUpdate?: BaleJournaledUpdate;
    }): {
        acquired: boolean;
        receipt: BaleInputJournalReceipt;
    };
    /** Returns this process's exact ready authority to the same unclaimed input. */
    releaseInput(receipt: BaleInputJournalReceipt): BaleInputJournalReleaseResult;
    /** Releases exact ready authority only after process-birth liveness proves its owner dead. */
    recoverReadyInput(input: BaleInputJournalRecoveryInput): BaleInputJournalRecoveryResult;
    /** Freezes exact ready donor authority around one persisted recipient offer. */
    offerInputHandoff(input: BaleInputJournalHandoffOfferInput): BaleInputJournalHandoffOfferResult;
    /** Replaces the offered donor with one exact ready recipient acquisition. */
    acceptInputHandoff(input: BaleInputJournalHandoffAcceptInput): BaleInputJournalHandoffAcceptResult;
    /** Unfreezes only the exact unaccepted donor offer. */
    cancelInputHandoff(input: BaleInputJournalHandoffCancelInput): BaleInputJournalHandoffCancelResult;
    /** Atomically replaces exact running raw acquisitions with one grouped Pi queue receipt. */
    queueInputs(input: BaleInputJournalQueueInput): BaleInputJournalQueueResult;
    completeQueued: BaleUpdateJournalStore["completeQueued"];
    discardQueued: BaleUpdateJournalStore["discardQueued"];
    recoverDeadQueueOwner: BaleUpdateJournalStore["recoverDeadQueueOwner"];
    offerQueuedHandoff: BaleUpdateJournalStore["offerQueuedHandoff"];
    acceptQueuedHandoff: BaleUpdateJournalStore["acceptQueuedHandoff"];
    cancelQueuedHandoff: BaleUpdateJournalStore["cancelQueuedHandoff"];
    /** One durable start transition, not proof that an external effect ran. Publication errors may be commit-unknown. */
    startInput(receipt: BaleInputJournalReceipt): {
        started: false;
    } | {
        started: true;
        update: BaleJournaledUpdate;
    };
    completeInput(receipt: BaleInputJournalReceipt): BaleUpdateJournalRemoveResult;
}
export interface BaleInputJournalContext {
    owner: BaleUpdateJournalQueueOwnerIdentity;
    recipientBindingKey: string;
}
export type BaleInputJournalStoreOptions = Omit<BaleUpdateJournalStoreOptions, "withPairedAdmission"> & Required<Pick<BaleUpdateJournalStoreOptions, "sourceAccess" | "withSourceSerialization" | "withPairingAdmission" | "queueRuntimeIdentity">> & {
    /** Bound originating profile/token/session/recipient context, not transport role; undefined revokes acquisition/start/transfer. */
    getInputContext: () => BaleInputJournalContext | undefined;
};
export interface BaleUpdateJournalSegment {
    version: BaleUpdateJournalFile["version"];
    revision: number;
    previousRevision: number;
    acceptedThroughUpdateId?: number;
    profile: string;
    botIdentity: BaleUpdateJournalBotIdentity;
    upsertedEntries: BaleUpdateJournalEntry[];
    removedUpdateIds: number[];
    operatorDispositions?: BaleUpdateJournalOperatorDisposition[];
    sourceCompletions?: BaleUpdateJournalSourceCompletion[];
}
export interface BaleUpdateJournalSegmentPublicationResult {
    path: string;
    revision: number;
    serializedBytes: number;
}
export declare function parseBaleUpdateJournalQueueOwner(value: unknown): BaleUpdateJournalQueueOwner | undefined;
export declare function isBaleUpdateJournalQueueOwnerProcess(owner: BaleUpdateJournalQueueOwner, identity: BaleUpdateJournalQueueOwnerIdentity): boolean;
export declare function areBaleUpdateJournalQueueOwnersEqual(left: BaleUpdateJournalQueueOwner, right: BaleUpdateJournalQueueOwner): boolean;
/** Only legacy v1 carries routing-lifetime, scoped-ACK and pairing-free queue-receipt semantics. */
export declare function isBaleUpdateJournalLegacyFamilyVersion(version: unknown): boolean;
/**
 * Isolated evidence only: caller must serialize/quiesce writers before inspection
 * and consumption. Metadata checks detect observable changes, not hostile same-user
 * swaps or whole-profile completeness. No locks, recovery, or publication occurs.
 * maxFiles counts snapshot + every enumerated segment entry (one overflow witness).
 * maxBytes aggregates all retained bytes. maxEntries bounds each raw collection and
 * reconstructed collection; maxWork charges each raw/revalidated collection element.
 * JSON allocation is bounded by maxBytes before decoding; collections before codecs.
 */
export declare function inspectBaleInputCustodySourceStatus(input: Parameters<typeof inspectBaleUpdateJournalFamily>[0]): "absent" | "v3" | "legacy" | "unsupported" | "ambiguous";
export declare function inspectBaleUpdateJournalFamily(input: {
    directory: string;
    path: string;
    profile: string;
    botIdentity: BaleUpdateJournalBotIdentity;
    limits: {
        maxFiles: number;
        maxBytes: number;
        maxEntries: number;
        maxWork: number;
    };
}): {
    kind: "absent";
} | {
    kind: "present";
    file: BaleUpdateJournalFile;
    /** Validation constraint includes the caller's input, not only observed IDs. */
    knownBotId?: number;
    accounting: {
        files: number;
        bytes: number;
        work: number;
    };
};
export interface BaleUpdateJournalRetentionInspection {
    evidence: ReturnType<typeof inspectBaleUpdateJournalFamily>;
    retainedInputs: {
        path: string;
        journalBindingKey: string;
        failureId: string;
        updateId: number;
        state: "committed" | "uncommitted";
    }[];
}
/** Classifies private originals against exact discard tombstones; never replay or deletion authority. */
export declare function inspectBaleUpdateJournalRetention(input: Parameters<typeof inspectBaleUpdateJournalFamily>[0]): BaleUpdateJournalRetentionInspection;
/**
 * Read-only source evidence for cooperating writers serialized by the caller through
 * consumption; never readiness, recovery, or permission to publish. Ancestors retain
 * canonical directory type and endpoint dev/ino/mode/uid/gid, tolerating sibling churn.
 * This deliberately loses ancestor size/nlink/mtime/ctime witnesses: no transient
 * namespace/permission/ACL continuity, inode-ABA resistance, or hostile-same-user
 * protection. Manual relocation/restore/security manipulation is outside the protocol.
 * Files and the segment directory retain full inspection checks and bounded census.
 * Identity is never enriched; accounting is physical inspection work, not store capacity.
 */
export declare function readBaleUpdateJournalSource(input: Parameters<typeof inspectBaleUpdateJournalFamily>[0] & {
    version: BaleUpdateJournalFile["version"];
}): ReturnType<typeof inspectBaleUpdateJournalFamily>;
/**
 * Canonical namespace evidence only, never source readiness or authorization.
 * Caller-proven serialization/quiescence is mandatory through consumption.
 * Recensus detects observable changes, not hostile same-user path swaps; arbitrary
 * consumer references and archive consumption require separate audits.
 */
export interface BaleJournalNamespaceInspectionInput {
    directory: string;
    profile: string;
    botIdentity: BaleUpdateJournalBotIdentity;
    limits: {
        maxDirectoryEntries: number;
        maxFiles: number;
        maxBytes: number;
        maxEntries: number;
        maxWork: number;
    };
    /** Leader polling journal named by owners.json; defaults to the flat root `inbox`. */
    pollingPath?: string;
    /** Hold a participating consumer reference during each physical family read. */
    withSourceReference?: <T>(path: string, operation: () => T) => T;
}
export interface BaleJournalNamespaceInspection {
    /** Original preservation facts only, never replay/deletion grants. */
    retainedInputs?: (BaleUpdateJournalRetentionInspection["retainedInputs"][number] & {
        journalPath: string;
    })[];
    sources: {
        role: "polling" | "follower" | "session";
        path: string;
        evidence: ReturnType<typeof inspectBaleUpdateJournalFamily>;
    }[];
    accounting: {
        directoryEntries: number;
        files: number;
        bytes: number;
        work: number;
    };
    knownBotId?: number;
}
export declare function inspectBaleProfileJournalNamespace(input: BaleJournalNamespaceInspectionInput): BaleJournalNamespaceInspection;
/** Read-only evidence over polling, retained flat recipients and role-neutral session journals. */
export declare function inspectBaleSessionJournalNamespace(input: BaleJournalNamespaceInspectionInput): BaleJournalNamespaceInspection;
/** Whether an update addresses this private-chat Thread anywhere in its payload (message, callback, reaction, …). */
export declare function doesBaleJournalUpdateNameThread(update: unknown, target: {
    chatId: number;
    threadId: number;
}): boolean;
/** A button tap alone carries no input, so it never keeps a tab whose inputs are resolved (the in-flight Cancel itself). */
export declare function isBaleJournalLoneCallbackUpdate(update: unknown): boolean;
/** Complete-empty protection only; caller holds source serialization through consumption. Never deletion authority. */
export declare function isBaleThreadCleanupJournalNamespaceClear(input: BaleJournalNamespaceInspectionInput & {
    requiredJournalBindingKeys: readonly string[];
    withSourceReference: NonNullable<BaleJournalNamespaceInspectionInput["withSourceReference"]>;
    /**
     * The tab being cleaned and its own recorded inputs. When given, a plain pending input with no custody that
     * neither names this tab nor belongs to it cannot be delivered here and does not protect it, nor does a plain
     * button tap even in this tab; without it, every non-empty journal protects, as before.
     */
    cleanup?: {
        target: {
            chatId: number;
            threadId: number;
        };
        ownInputs: readonly {
            journalBindingKey: string;
            updateIds: readonly number[];
        }[];
    };
}): boolean;
/** Demand-driven recovery only; caller holds temporary-cleanup admission. Never a deletion grant. */
export declare function recoverBaleThreadCleanupDeadQueueOwners(input: Parameters<typeof isBaleThreadCleanupJournalNamespaceClear>[0] & {
    recoveryOwner: BaleUpdateJournalQueueOwnerIdentity;
    isCurrent: () => boolean;
    withSourceSerialization: NonNullable<BaleUpdateJournalStoreOptions["withSourceSerialization"]>;
    getQueueProcessLiveness?: BaleUpdateJournalStoreOptions["getQueueProcessLiveness"];
}): number;
export declare function publishBaleUpdateJournalSegment(path: string, segment: BaleUpdateJournalSegment): BaleUpdateJournalSegmentPublicationResult;
export declare function createBaleUpdateQueueHandoffToken(): string;
export declare function createBaleUpdateJournalBotIdentity(input: {
    botToken: string;
    botId?: number;
}): BaleUpdateJournalBotIdentity;
export declare function createBaleUpdateJournalReceiptScope(input: {
    profileName?: string;
    botIdentity: BaleUpdateJournalBotIdentity;
}): string;
export declare function createBaleUpdateJournalBindingKey(input: {
    path: string;
    profileName?: string;
    botIdentity: BaleUpdateJournalBotIdentity;
}): string;
export declare function getBaleUpdateJournalBindingPath(journalBindingKey: string): string | undefined;
export declare function createBaleUpdateJournalReceiptScopeResolver(deps: {
    getProfileName: () => string | undefined;
    getBotToken: () => string | undefined;
    getBotId: () => number | undefined;
}): () => string | undefined;
export interface BaleUpdateJournalRuntimeBinding {
    runtimeKey: string;
    recoveryKey: string;
    journal: BaleUpdateJournalStore;
    readForProtection?: () => {
        entries: readonly BaleUpdateJournalEntry[];
        exists: boolean;
    };
}
export interface BaleUpdateJournalRuntimeBindingResolverDeps {
    getProfileName: () => string | undefined;
    getBotToken: () => string | undefined;
    getBotId: () => number | undefined;
    getJournalPath: (profileName?: string) => string;
    getQueueRuntimeIdentity?: () => BaleUpdateJournalQueueRuntimeIdentity;
    withWriterAdmission?: <T>(operation: () => T) => T;
    withSourceSerialization?: BaleUpdateJournalStoreOptions["withSourceSerialization"];
    getWorkspaceAdmission?: () => Pick<BaleWorkspaceAdmissionLedger, "acquireAdmission" | "releaseAdmission"> | undefined;
    onRecovery?: (event: BaleUpdateJournalRecoveryEvent) => void;
    /** Strict private source handles; on by default on every platform (see BALE_STRICT_READ_FLAGS). */
    strictSourceAccess?: boolean;
}
export declare function createBaleUpdateJournalRuntimeBindingResolver(deps: BaleUpdateJournalRuntimeBindingResolverDeps): () => BaleUpdateJournalRuntimeBinding | undefined;
export type BaleUpdateJournalReferenceClass = "leader-lifecycle" | "follower-lifecycle" | "polling-cursor" | "polling-bootstrap" | "workspace-retirement" | "operator-disposition";
export declare function createBaleUpdateJournalReferenceRegistry(input?: {
    maxActive?: number;
}): {
    acquire(reference: {
        referenceClass: BaleUpdateJournalReferenceClass;
        recoveryKey: string;
    }): () => void;
    list: () => {
        referenceClass: BaleUpdateJournalReferenceClass;
        recoveryKey: string;
    }[];
    withReference<T>(reference: {
        referenceClass: BaleUpdateJournalReferenceClass;
        recoveryKey: string;
    }, operation: () => T): T;
};
export declare function withBaleResolvedUpdateJournalReference<T>(input: {
    registry: ReturnType<typeof createBaleUpdateJournalReferenceRegistry>;
    resolveBinding(): BaleUpdateJournalRuntimeBinding | undefined;
    referenceClass: BaleUpdateJournalReferenceClass;
    operation(binding: BaleUpdateJournalRuntimeBinding): T;
}): T | undefined;
/** Operator-distinct authority: routing never treats it as an owner cancellation. */
export declare const BALE_SESSION_ADOPTION_AUTHORITY_PREFIX = "session-successor:";
export interface BaleSessionPendingAdoptionInput {
    recipientBindingKey: string;
    predecessorSessionId: string;
    successorSessionId: string;
    /** Caller proves the successor registration is current and no predecessor worker runs. */
    isCurrent: () => boolean;
}
export interface BaleSessionPendingAdoptionResult {
    adoptedUpdateIds: number[];
    /** Already committed away by an earlier attempt; never re-appended, the private original remains. */
    retainedUpdateIds: number[];
}
export interface BaleUpdateJournalBindingRuntime {
    resolveLeader: () => BaleUpdateJournalRuntimeBinding | undefined;
    resolveFollower: () => BaleUpdateJournalRuntimeBinding | undefined;
    resolveActive: () => BaleUpdateJournalRuntimeBinding | undefined;
    getActiveRecoveryKey: () => string | undefined;
    /** Exact historical proof lookup; no store, admission, execution, recovery or mutation port. */
    inspectSourceAbandonment: (journalBindingKey: string, updateId: number) => BaleUpdateJournalAbandonedPendingEvidence | undefined;
    inspectSourceGroupExpiry: (journalBindingKey: string, updateIds: readonly number[]) => BaleRoutingInputExpiryEvidence[] | undefined;
    inspectSourceCompletion: (journalBindingKey: string, expected: BaleUpdateJournalSourceCompletion) => BaleUpdateJournalSourceCompletion | undefined;
    inspectQueuedReceipt: (journalBindingKey: string, expected: BaleUpdateJournalQueuedCompletion) => BaleUpdateJournalQueuedReceiptEvidence | undefined;
    /** In-process `/new` succession: move unclaimed predecessor pending inputs into the successor session journal. */
    adoptPredecessorPending: (input: BaleSessionPendingAdoptionInput) => BaleSessionPendingAdoptionResult;
    /** Process-local: adopts from the previously prepared session of the same recipient key, then records the active one. */
    prepareActiveFollowerSuccession: (isCurrent: () => boolean) => BaleSessionPendingAdoptionResult | undefined;
    createRecipientResolver: (recipientBindingKey: string, sessionId?: string) => () => BaleUpdateJournalRuntimeBinding | undefined;
    createLegacyRecipientResolver: (recipientBindingKey: string) => () => BaleUpdateJournalRuntimeBinding | undefined;
    createPathResolver: (path: string) => () => BaleUpdateJournalRuntimeBinding | undefined;
}
export declare function createBaleUpdateJournalBindingRuntime(deps: {
    base: Omit<BaleUpdateJournalRuntimeBindingResolverDeps, "getJournalPath">;
    getLeaderJournalPath: (profileName?: string) => string;
    /** Runtime root; defaults to the leader journal's directory for flat layouts. */
    getRuntimeDir?: () => string;
    getFollowerJournalPath: (bindingKey: string, profileName?: string, sessionId?: string) => string;
    getActiveFollowerBindingKey: () => string;
    getActiveFollowerSessionId?: () => string | undefined;
    isFollowerRegistered: () => boolean;
}): BaleUpdateJournalBindingRuntime;
/**
 * Journal-owned cross-family source serializer, lock-only and never authorization. Its guard lives
 * in the runtime service directory, so journal work never touches `bale.json` or its
 * transaction. Acquire Workspace admission and any sender (config) admission first; never acquire
 * owners inside it. Callbacks must be synchronous: a returned promise is unprotected after its
 * synchronous prefix.
 */
export declare function createBaleJournalSourceSerialization(getTransactionPath?: () => string): <T>(operation: () => T) => T;
export declare function createBaleUpdateJournalStore(options: BaleUpdateJournalStoreOptions): BaleUpdateJournalStore;
/** Opt-in v3 only; does not migrate old files or expose legacy unowned mutation ports. */
export declare function createBaleInputJournalStore(options: BaleInputJournalStoreOptions): BaleInputJournalStore;

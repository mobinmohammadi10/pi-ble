/**
 * Bale singleton lock helpers
 * Zones: bale ownership, filesystem, transport authority
 * Owns filesystem authority, atomic runtime-section publication and Bale bridge ownership semantics
 */
import { renameSync } from "node:fs";
export declare const BALE_LOCK_KEY = "default";
export declare const BALE_BUS_LEADER_STALE_HEARTBEAT_MS = 8000;
export declare const BALE_OWNERSHIP_CHECK_MS = 1000;
export declare const BALE_OWNERSHIP_REFRESH_MS = 2000;
/** Consecutive unverified ownership checks tolerated before standing down; a concurrent shared-state replacement must not stop an owned transport. */
export declare const BALE_OWNERSHIP_CHECK_FAILURE_TOLERANCE = 2;
/**
 * Resolve the extension-local owner slot for the active Bale profile.
 * Default profile → default
 * Named profile → the validated profile name
 */
export declare function resolveBaleLockKey(activeProfile?: string): string;
interface BaleActiveProfileGetter {
    getActiveProfileName: () => string | undefined;
}
export declare function createBaleLockKeyResolver(activeProfile: BaleActiveProfileGetter): () => string;
/** Structural session view; Locks never imports the lifecycle owner. */
interface BaleOwnedStateSessionPort<TContext extends BaleLockContext> {
    get: () => TContext | undefined;
    getGeneration: () => number;
    isCurrent: (ctx: TContext, generation?: number) => boolean;
}
/**
 * Captures exact context, session generation and owned leader epoch before awaits.
 * Session replacement, release or re-election revokes the grant; a successor never renews it.
 */
export declare function createBaleOwnedStateAuthorityCapture<TContext extends BaleLockContext>(lock: Pick<BaleLockRuntime<TContext>, "owns" | "getOwnedLeaderEpoch">, session: BaleOwnedStateSessionPort<TContext>): () => (() => boolean) | undefined;
export interface BaleLockEntry {
    pid: number;
    cwd?: string;
    instanceId?: string;
    heartbeatMs?: number;
    leaderEpoch?: number | string;
    runtimeGeneration?: number;
    busSocketPath?: string;
    busSecret?: string;
    /** Polling journal custody; inherited by every successor and kept after release. */
    journalPath?: string;
}
export interface BaleLockContext {
    cwd: string;
}
export type BaleLockState = {
    kind: "inactive";
} | {
    kind: "active-here";
    lock: BaleLockEntry;
} | {
    kind: "active-elsewhere";
    lock: BaleLockEntry;
} | {
    kind: "stale";
    lock: BaleLockEntry;
};
interface BaleLockAcquireOptions {
    force?: boolean;
    expectedOwner?: BaleLockEntry;
    election?: boolean;
    /** Bus-proven unresponsive owner: treated as stale only while it is still exactly the current owner. */
    unresponsiveOwner?: BaleLockEntry;
}
type BaleLockAcquireResult = {
    ok: true;
    lock: BaleLockEntry;
    replacedStale: boolean;
} | {
    ok: false;
    lock: BaleLockEntry;
};
export type BaleOwnedStatePublicationResult<T> = {
    committed: false;
} | {
    committed: true;
    result: T;
};
export interface BaleLockRuntime<TContext extends BaleLockContext> {
    acquire: (ctx: TContext, options?: BaleLockAcquireOptions) => BaleLockAcquireResult;
    release: () => BaleLockState;
    getState: () => BaleLockState;
    getStatusLabel: () => string;
    getOwnedLeaderEpoch: () => number | string | undefined;
    owns: (ctx?: BaleLockContext) => boolean;
    commitIfOwned: (commit: () => void) => boolean;
    /** Consolidated-store publication; domain reducers retain their own exact payload/CAS rules. */
    publishStateSectionIfOwned?: <T>(section: "workspace" | "runtime", mutate: BaleRuntimeStateSectionReducer<T>, options: BaleOwnedStatePublicationOptions) => BaleOwnedStatePublicationResult<T>;
    refresh: (ctx?: BaleLockContext) => boolean;
    /** The polling journal named by owners.json for this key, owned or not. */
    getJournalPath: () => string | undefined;
}
interface BaleLockOwnershipGuard<TContext extends BaleLockContext> {
    ownsContext: (ctx: TContext) => boolean;
}
interface BaleLockContextStore<TContext extends BaleLockContext> {
    get: () => TContext | undefined;
}
interface BaleLockRuntimeOptions {
    key?: string | (() => string | undefined);
    locksPath?: string;
    /** Consolidated version-2 state envelope; exclusive with `locksPath`. */
    statePath?: string;
    statePublication?: Pick<BaleRuntimeStatePublicationOptions, "onPublicationBoundary" | "publishRename">;
    /** Read-only ownership file of releases that used another directory; a live fresh owner there blocks acquisition. */
    legacyLocksPath?: string;
    pid?: number;
    isProcessAlive?: (pid: number) => boolean;
    instanceId?: string;
    busSocketPath?: string;
    busSecret?: string;
    getNowMs?: () => number;
    mintLeaderEpoch?: () => number | string;
    runtimeGeneration?: number;
    staleHeartbeatMs?: number;
    /** First leader without an inherited pointer names the polling journal it creates. */
    createJournalPath?: (ctx: BaleLockContext) => string | undefined;
}
/**
 * Leader polling journal: the path owners.json names, else the session that would host it on acquisition.
 * Without a session identity, the flat root `inbox` remains the compatibility fallback.
 */
export declare function createBaleLeaderJournalPathResolver(deps: {
    getNamedJournalPath: () => string | undefined;
    getSessionId: () => string | undefined;
    getProfileName: () => string | undefined;
}): {
    createJournalPath: () => string | undefined;
    resolve(profileName?: string): string;
};
/** A released key keeps only `{ journalPath }`: no owner, but the successor's polling custody. */
export declare function readBaleLockJournalPath(value: unknown): string | undefined;
export declare function readLocks(path?: string): Record<string, unknown>;
interface BaleRenameRetryOptions {
    rename?: typeof renameSync;
    attempts?: number;
    retryDelayMs?: number;
}
export type BalePrivateFileFailure = "capacity" | "unsafe" | "changed";
/** Typed private-file refusal; owners map the failure into their own error vocabulary. */
export declare class BalePrivateFileError extends Error {
    readonly failure: BalePrivateFileFailure;
    constructor(failure: BalePrivateFileFailure, message: string);
}
/**
 * Read flags for private runtime files. Where the platform offers them, no-follow and non-blocking opens refuse a
 * swapped link or FIFO at open time. Windows has neither flag and no FIFOs in the file namespace; there the
 * lstat-before/fstat-after identity binding every strict reader performs is the guard, so a link swapped in after
 * inspection opens a different file and is refused as changed.
 */
export declare const BALE_STRICT_READ_FLAGS: number;
/** POSIX owner and permission bits; Windows has no uid, so its ACL-protected agent directory carries privacy. */
export declare function isBaleOwnerPrivate(stat: {
    uid: bigint;
    mode: bigint;
}): boolean;
/**
 * Read one owner-private, single-link, bounded regular file without following links. Absence returns undefined;
 * an inode or metadata change between inspection and open refuses as `changed`.
 */
export declare function readBalePrivateFile(path: string, maxBytes: number): string | undefined;
/** Atomically publish owner-private contents through a unique staging file; the rename consumes staging. */
export declare function publishBalePrivateFile(path: string, temporaryBasePath: string, contents: string, label: string, onBoundary?: (boundary: "after-write-before-rename" | "after-rename") => void): void;
/** Rename one Bale runtime artifact with bounded Windows sharing retries. */
export declare function renameBalePathWithRetry(sourcePath: string, destinationPath: string, options?: BaleRenameRetryOptions): boolean;
export interface BaleFileTransactionOptions {
    recoveryRename?: typeof renameSync;
    publishRename?: typeof renameSync;
    attempts?: number;
    retryDelayMs?: number;
}
export declare function withBaleFileTransaction<T>(transactionPath: string, operation: () => T, options?: BaleFileTransactionOptions): T;
export type BaleRuntimeStateSection = "transport" | "workspace" | "admission" | "runtime";
type BaleRuntimeStateProfile = Partial<Record<BaleRuntimeStateSection, unknown>>;
interface BaleRuntimeStateFile {
    version: 2;
    profiles: Record<string, BaleRuntimeStateProfile>;
}
export declare class BaleRuntimeStateError extends Error {
    readonly code: "invalid" | "authority-changed" | "publication-unknown";
    constructor(code: BaleRuntimeStateError["code"], message: string, options?: ErrorOptions);
}
/** Strict, observational envelope read; section owners validate their own payloads. Legacy state is never adopted here. */
export declare function readBaleRuntimeState(path: string): BaleRuntimeStateFile;
/**
 * Operator-approved optimistic recovery before leader acquisition: when the shared envelope, any transport section or a
 * caller-validated section is damaged, publish a fresh empty envelope instead of refusing. All profiles lose runtime
 * continuity. Filesystem access errors are not damage and still throw. Returns whether a reset was published.
 */
export declare function resetDamagedBaleRuntimeState(path: string, validateProfile?: (profile: string, sections: Readonly<BaleRuntimeStateProfile>) => void): boolean;
/** Pure section reducer: receives the stored section and its profile, returns the next section and result. */
export type BaleRuntimeStateSectionReducer<T> = (current: unknown, observed: Readonly<BaleRuntimeStateProfile>) => BaleRuntimeStateMutation<T>;
export interface BaleRuntimeStateMutation<T> {
    value: unknown;
    result: T;
}
interface BaleRuntimeStatePublicationOptions {
    /** Exact domain authority, recaptured by the caller before invoking this synchronous transaction. */
    isCurrent: () => boolean;
    onPublicationBoundary?: (boundary: "before-write" | "after-write-before-rename" | "after-rename") => void;
    publishRename?: typeof renameSync;
}
export interface BaleOwnedStatePublicationOptions extends BaleRuntimeStatePublicationOptions {
    /** Optional caller-bound physical/logical identity; a mismatch cannot redirect an owner grant. */
    expectedScope?: {
        path: string;
        profile: string;
    };
}
/**
 * One physical read/check/write transaction for one named section. The caller supplies domain policy; copies expose
 * current sibling facts without granting writes to them. No await, nested transaction, repair or legacy import.
 */
export declare function mutateBaleRuntimeStateSection<T>(path: string, profile: string, section: BaleRuntimeStateSection, mutate: BaleRuntimeStateSectionReducer<T>, options: BaleRuntimeStatePublicationOptions): T;
export declare function writeLocks(path: string, locks: Record<string, unknown>): void;
export declare function parseBaleLockEntry(value: unknown): BaleLockEntry | undefined;
/** Exact owner identity (pid, cwd, instance, leader epoch, runtime generation); absent entries never match. */
export declare function isSameBaleLockOwner(current: BaleLockEntry | undefined, expected: BaleLockEntry | undefined): boolean;
export declare function createBaleLockRuntime<TContext extends BaleLockContext>(options?: BaleLockRuntimeOptions): BaleLockRuntime<TContext>;
export declare function createBaleLockOwnershipGuard<TContext extends BaleLockContext>(lock: BaleLockRuntime<TContext>): BaleLockOwnershipGuard<TContext>;
export declare function createBaleDirectDeliveryOwnershipChecker<TContext extends BaleLockContext>(deps: {
    lock: BaleLockRuntime<TContext>;
    contextStore: BaleLockContextStore<TContext>;
}): () => boolean;
interface BaleLockedPollingStartOptions {
    force?: boolean;
    forceFreshLeaderThread?: boolean;
    requestedThreadName?: string;
    election?: {
        expectedOwner?: BaleLockEntry;
        unresponsive?: boolean;
    };
    onAcquired?: () => Promise<void> | void;
}
type BaleLockedPollingStartResult = {
    ok: true;
    message?: string;
    canTakeover?: false;
} | {
    ok: false;
    message: string;
    canTakeover?: boolean;
    owner?: string;
};
export interface BaleLockedPollingRuntime<TContext extends BaleLockContext> {
    start: (ctx: TContext, options?: BaleLockedPollingStartOptions) => Promise<BaleLockedPollingStartResult>;
    stop: () => Promise<string>;
    /** Capture one disconnect attempt before cleanup awaits; a newer start revokes it. */
    captureStop: () => {
        isCurrent: () => boolean;
        stop: () => Promise<string>;
    };
    suspend: () => Promise<void>;
    isSuspended: () => boolean;
    /** Fence one owned polling generation; suspension, restart, conflict or lock loss revokes it. */
    captureTransportAuthority: (ctx: TContext) => (() => boolean) | undefined;
    onPersistentConflict: (ctx: TContext, count: number) => Promise<void>;
    onSessionStart: (_event: unknown, ctx: TContext) => Promise<void>;
    registerFollowerWithOwner?: (ctx: TContext, owner: BaleLockEntry, options?: {
        recoverConnection?: boolean;
    }) => boolean | undefined | Promise<boolean | undefined>;
    restoreFollowerWithOwner?: (ctx: TContext, owner: BaleLockEntry) => boolean | undefined | Promise<boolean | undefined>;
    stopFollowerRegistration?: () => void;
}
interface BaleLockedPollingRuntimeDeps<TContext extends BaleLockContext> {
    lock: BaleLockRuntime<TContext>;
    /** Optimistically replaces a damaged shared runtime state before a non-election acquisition. */
    resetDamagedState?: () => boolean;
    hasBotToken: () => boolean;
    getBotTokenDiagnostic?: () => string | undefined;
    canStartPolling?: (ctx: TContext) => boolean;
    isContextCurrent?: (ctx: TContext) => boolean;
    formatStartBlockedMessage?: (ctx: TContext) => string;
    startPolling: (ctx: TContext, options?: BaleLockedPollingStartOptions) => void | Promise<void>;
    stopPolling: () => Promise<void>;
    registerFollowerWithOwner?: (ctx: TContext, owner: BaleLockEntry, options?: {
        recoverConnection?: boolean;
    }) => boolean | undefined | Promise<boolean | undefined>;
    restoreFollowerWithOwner?: (ctx: TContext, owner: BaleLockEntry) => boolean | undefined | Promise<boolean | undefined>;
    stopFollowerRegistration?: () => void;
    /** Threaded Mode takeover evidence after failed follower registration; replaces the retired file heartbeat. */
    proveOwnerUnresponsive?: (owner: BaleLockEntry) => Promise<boolean>;
    onTransportAvailabilityChanged?: () => void;
    transportMonitor?: {
        start: (ctx: TContext) => void;
        stop: () => void;
    };
    updateStatus: (ctx: TContext) => void;
    recordRuntimeEvent?: (category: string, error: unknown, details?: Record<string, unknown>) => void;
    ownershipCheckMs?: number;
    ownershipRefreshMs?: number;
}
export declare function createBaleLockedPollingRuntime<TContext extends BaleLockContext>(deps: BaleLockedPollingRuntimeDeps<TContext>): BaleLockedPollingRuntime<TContext>;
export {};

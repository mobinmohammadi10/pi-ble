/**
 * Bale diagnostics logs
 * Zones: bale diagnostics, filesystem, session observability
 * Owns bounded JSONL runtime evidence files, previous-log preservation, and profile-aware log paths without becoming routing state
 */
import * as Status from "./status.ts";
/** Sink shape shared with the runtime event recorder this domain already owns. */
export type BaleFailureRecordSink = (category: string, errorOrMessage: unknown, details: Record<string, unknown>) => void;
export interface BaleFailureRunSummary {
    signature: string;
    failedAttempts: number;
    suppressedFailures: number;
    failedForMs: number;
}
export interface BaleFailureRunLog {
    /** Records one failure; a repeated identical failure only extends the current run and returns false. */
    record: (error: unknown, details?: Record<string, unknown>) => boolean;
    /** Closes the run after a success, emitting its single outcome record. */
    settled: () => BaleFailureRunSummary | undefined;
    /** Ends the run without an outcome record, for a stop or replacement that reports its own outcome. */
    reset: () => void;
}
export interface BaleFailureRunLogInput {
    category: string;
    failurePhase: string;
    outcomePhase: string;
    /** Human-readable subject for the outcome record, e.g. `follower heartbeat`. */
    label: string;
    record?: BaleFailureRecordSink;
    /** Static context reapplied to every record of this phase, e.g. a session or profile key. */
    context?: () => Record<string, unknown>;
    getNowMs?: () => number;
}
/** Stable identity of one failure kind: errno when present, otherwise the failure text. */
export declare function getBaleFailureSignature(error: unknown): string;
/**
 * Consecutive identical failure runs for one diagnostic phase: a repeat extends the run instead of logging again,
 * and a closing success or reset emits at most one outcome record. This never gates detection or recovery.
 */
export declare function createBaleFailureRunLog(input: BaleFailureRunLogInput): BaleFailureRunLog;
type BaleLogPathInput = string | (() => string);
interface BaleRuntimeJsonlEvent {
    at: number;
    category: string;
    message: string;
    details?: Record<string, unknown>;
}
interface BaleRuntimeJsonlLogOptions {
    path?: BaleLogPathInput;
    previousPath?: BaleLogPathInput;
    maxBytes?: number;
    getNowMs?: () => number;
    canReset?: () => boolean;
    commitReset?: (commit: () => void) => boolean;
    /** Explicit shared-file protocol; profile-labelled scope reset is an append, never truncation. */
    sharedProfiles?: {
        getProfileName: () => string | undefined;
        captureAuthority: () => (() => boolean) | undefined;
    };
}
interface BaleRuntimeJsonlLog {
    getPath: () => string;
    reset: (reason: string, scope?: Record<string, unknown>) => void;
    resetIfScopeChanged: (scopeKey: string, reason: string, scope?: Record<string, unknown>) => void;
    record: (event: BaleRuntimeJsonlEvent) => void;
}
export declare function getBaleRuntimeLogPath(agentDir?: string, profileName?: string): string;
export declare function getBalePreviousRuntimeLogPath(agentDir?: string, profileName?: string): string;
export declare function createBaleRuntimeJsonlLog(options?: BaleRuntimeJsonlLogOptions): BaleRuntimeJsonlLog;
interface BaleRuntimeDiagnosticsStatusPorts<TContext> {
    instanceId: string;
    updateStatus(ctx: TContext, error?: string): void;
    getStatusState(): Status.BaleBridgeStatusLineState;
    persistSnapshot(snapshot: ReturnType<typeof Status.createBaleStatusSnapshot>): Promise<void>;
    session?: {
        get(): TContext | undefined;
        getGeneration(): number;
        isCurrent(ctx: TContext, generation?: number): boolean;
    };
}
interface BaleRuntimeDiagnosticsRuntime<TContext> {
    events: Status.BaleRuntimeEventRecorder;
    recordRuntimeEvent(category: string, error: unknown, details?: Record<string, unknown>): void;
    /** A phase-scoped failure log whose records travel through this runtime's own event pipeline. */
    createFailureLog(input: Omit<BaleFailureRunLogInput, "record">): BaleFailureRunLog;
    bindStorage(ports: {
        getBotToken(): string | undefined;
        getProfileName(): string | undefined;
        canReset(): boolean;
        commitReset(commit: () => void): boolean;
        captureAuthority?: () => (() => boolean) | undefined;
    }): void;
    bindStatus(ports: BaleRuntimeDiagnosticsStatusPorts<TContext>): void;
    onSessionStart(): void;
    onSessionShutdown(): Promise<void>;
    updateStatus(ctx: TContext, error?: string): void;
    getStatusLines(options?: Status.BaleBridgeStatusLineOptions): string[];
    scheduleSnapshotPersist(): void;
}
export declare function createBaleRuntimeDiagnosticsRuntime<TContext>(options?: {
    sharedFile?: boolean;
    snapshotTimer?: Pick<Parameters<typeof Status.createBaleRuntimeDiagnosticsSnapshotScheduler>[0], "setTimer" | "clearTimer">;
}): BaleRuntimeDiagnosticsRuntime<TContext>;
export {};

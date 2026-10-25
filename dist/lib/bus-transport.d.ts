/**
 * Bale bus local transport boundary
 * Zones: multi-instance bus, IPC transport, Windows named pipes, Unix sockets
 * Owns endpoint derivation, transport-kind detection, retry/error classification, and small timing policy.
 */
export type BaleBusEndpointLayout = "consolidated";
export declare const BALE_BUS_MAX_DIRECT_UNIX_ENDPOINT_BYTES = 80;
export type BaleBusTransportKind = "pipe" | "socket";
export type BaleBusTransportEventRecorder = (phase: string, details: Record<string, unknown>) => void;
export type BaleBusTransportEndpointDiagnostics = Record<string, unknown> & {
    endpoint: string;
    transport: BaleBusTransportKind;
};
export interface BaleBusTransportRetryPolicy {
    attempts: number;
    delayMs: number;
}
export interface BaleBusTransportRetryPolicyOverrides {
    attempts?: number;
    delayMs?: number;
}
export type BaleBusTransportOperation = "registration" | "operation";
export declare const BALE_BUS_REGISTRATION_RETRY: BaleBusTransportRetryPolicy;
export declare function getBaleBusPipePath(input: {
    agentDir: string;
    scope: string;
}): string;
export declare function isBaleBusPipePath(endpoint: string): boolean;
export declare function getBaleBusTransportKind(endpoint: string): BaleBusTransportKind;
export declare function getBaleBusEndpointDiagnostics(endpoint: string): BaleBusTransportEndpointDiagnostics;
export declare function getBaleBusTransportRetryPolicy(input: {
    endpoint: string;
    operation: BaleBusTransportOperation;
    overrides?: BaleBusTransportRetryPolicyOverrides;
}): BaleBusTransportRetryPolicy | undefined;
export declare function getBaleBusLeaderEndpoint(input: {
    agentDir: string;
    platform: NodeJS.Platform | string;
    profileName?: string;
    layout?: BaleBusEndpointLayout;
}): string;
export declare function getBaleBusFollowerEndpoint(input: {
    agentDir: string;
    platform: NodeJS.Platform | string;
    instanceId: string;
    profileName?: string;
    layout?: BaleBusEndpointLayout;
}): string;
export interface BaleBusTransportErrorInfo {
    message: string;
    code?: string;
    syscall?: string;
    kind: "connect" | "timeout" | "auth" | "protocol" | "unknown";
    retryable: boolean;
}
export declare function classifyBaleBusTransportError(error: unknown): BaleBusTransportErrorInfo;
export declare function isRetryableBaleBusTransportError(error: unknown): boolean;
export declare function createBaleBusTransportTimeoutError(message: string): NodeJS.ErrnoException;
export declare function delayBaleBusTransportRetry(ms: number): Promise<void>;
export interface BaleBusTransportProbeResult extends BaleBusTransportEndpointDiagnostics {
    reachable: boolean;
    error?: BaleBusTransportErrorInfo;
}
export declare function probeBaleBusEndpoint(input: {
    endpoint: string;
    timeoutMs?: number;
}): Promise<BaleBusTransportProbeResult>;

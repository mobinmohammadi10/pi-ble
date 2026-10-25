/**
 * Process identity and liveness proofs
 * Zones: shared utils, multi-instance bus, durable admission
 * Owns PID liveness probes and stable Linux/macOS/Windows process-birth identity. Only an absent PID or a
 * mismatched birth proof establishes death; inaccessible metadata stays unverifiable.
 */
export declare function isProcessAlive(pid: number): boolean;
interface BaleProcessBirthIdentityOptions {
    platform?: NodeJS.Platform;
    readProcStat?: (pid: number) => string;
    readDarwinProcessStart?: (pid: number) => string;
    readWindowsProcessStart?: (pid: number) => string;
}
export type BaleProcessLiveness = "alive" | "dead" | "unverifiable";
interface BaleProcessLivenessOptions extends BaleProcessBirthIdentityOptions {
    isProcessAlive?: (pid: number) => boolean;
}
export declare function getBaleProcessBirthIdentity(pid: number, fallbackGeneration: number | string, options?: BaleProcessBirthIdentityOptions): string;
export declare function getBaleProcessLiveness(owner: {
    processId: number;
    processBirthId: string;
}, options?: BaleProcessLivenessOptions): BaleProcessLiveness;
export declare function getBaleProcessBirthIdentityLiveness(processBirthId: string, options?: BaleProcessLivenessOptions): BaleProcessLiveness;
export {};

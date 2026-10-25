/**
 * Workspace slot allocation policy
 * Zones: bale, workspace identity
 * Owns bounded profile-wide letter selection and inactivity ordering.
 * Excludes liveness discovery, persistence, routing, and Bale deletion;
 * a selection is a proposal, never authority to retire a binding.
 */
export declare const BALE_WORKSPACE_SLOTS = "abcdefghijklmnopqrstuvwxyz";
export declare class BaleWorkspaceSlotUnavailableError extends Error {
    constructor();
}
export interface BaleWorkspaceSlotOccupancy {
    bindingKey: string;
    slot: string;
    inactiveSinceMs?: number;
    protection: "eligible" | "protected" | "unknown";
}
export type BaleWorkspaceSlotAllocation = {
    kind: "free";
    slot: string;
} | {
    kind: "reclaim";
    candidate: BaleWorkspaceSlotOccupancy;
} | {
    kind: "blocked";
    reason: "invalid-state" | "protected-capacity";
};
/** A binding whose letter may be reassigned without touching its Thread, journals or accepted work. */
export interface BaleWorkspaceReusableSlot {
    bindingKey: string;
    /** Uppercase display letter currently held by the binding. */
    slot: string;
    /** A live owner counts as most recently used, whatever its stored clocks say. */
    live: boolean;
    /** Last known use: inactivity start for detached bindings, otherwise the last binding update. */
    lastUsedMs: number;
}
/**
 * Metadata-only fallback for a full A-Z pool: pick the least recently used letter,
 * preferring detached bindings over live ones. Unlike pressure retirement this
 * ignores accepted-work protection because reuse deletes nothing.
 * Returns undefined for an empty or malformed candidate set.
 */
export declare function selectBaleWorkspaceReusableSlot(candidates: readonly BaleWorkspaceReusableSlot[]): BaleWorkspaceReusableSlot | undefined;
/** Caller must recheck exact ownership and protected work before retirement. */
export declare function planBaleWorkspaceSlotAllocation(input: {
    bindings: readonly BaleWorkspaceSlotOccupancy[];
    reservedSlots: readonly string[];
    nowMs: number;
}): BaleWorkspaceSlotAllocation;

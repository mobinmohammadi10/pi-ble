/**
 * Bale Thread naming rules and manual-name interaction
 * Zones: thread identity names, palettes, title formatting, runtime controls
 * Owns name/title value policy and one expiring exact-target dialog per session scope.
 * Excludes occupancy/slot allocation, display-mode projection, transport and API/store effects.
 */
import { type BaleTarget } from "./target.ts";
export declare const BALE_THREAD_NAME_DIALOG_TTL_MS: number;
export type BaleThreadNameDialogAction = "reset" | "cancel";
export interface BaleThreadNameDialogCandidate {
    scope: string;
    target: BaleTarget;
    dialogMessageId: number;
    phase: "input";
    expiresAtMs: number;
}
export interface BaleThreadNameDialogLifetime {
    /** Independent recipient effect authority; never the input handle's deadline or ownership. */
    readonly assertAuthority?: () => void;
    isCurrent(): boolean;
    publish(dialogMessageId: number, assertPublicationCurrent?: () => void): BaleThreadNameDialogCandidate | undefined;
    select(action: BaleThreadNameDialogAction): {
        kind: "reset" | "cancel" | "expired";
    };
    consumeName(text: string): {
        kind: "name";
        name: string;
    } | {
        kind: "none" | "empty";
    };
    reopen(): BaleThreadNameDialogCandidate | undefined;
    finish(): void;
}
export declare function createBaleThreadNameDialogRuntime(options?: {
    ttlMs?: number;
    nowMs?: () => number;
}): {
    prepare(input: {
        scope: string;
        target: BaleTarget;
        isCurrent?: () => boolean;
        assertAuthority?: () => void;
    }): BaleThreadNameDialogLifetime | undefined;
    capture(input: {
        scope: string;
        target: BaleTarget;
        dialogMessageId: number;
    }): BaleThreadNameDialogLifetime | undefined;
    open(input: {
        scope: string;
        target: BaleTarget;
        dialogMessageId: number;
    }): BaleThreadNameDialogCandidate;
    select(input: {
        scope: string;
        target: BaleTarget;
        dialogMessageId: number;
        action: BaleThreadNameDialogAction;
    }): {
        kind: "reset" | "cancel" | "expired";
    };
    consumeName(input: {
        scope: string;
        target: BaleTarget;
        text: string;
    }): {
        kind: "name";
        name: string;
    } | {
        kind: "none" | "empty";
    };
    clearScope(scope: string): void;
    inspect(target: BaleTarget): BaleThreadNameDialogCandidate | undefined;
};
export interface BaleThreadTitleInput {
    instanceId: string;
    profileKey: string;
    threadName?: string;
}
export declare function normalizeBaleTopicTargetThreadName(threadName: string): string;
export declare function getBaleTopicIdentityName(threadName: string): string;
export declare function chooseBaleThreadName(input: {
    slot: string | undefined;
    entropy?: number | string;
    getRandom?: () => number;
    occupied?: readonly string[];
}): string | undefined;
export declare function getBaleThreadNameLeadingSlot(threadName: string | undefined): string | undefined;
export declare function getBaleTopicThreadNameValidationError(threadName: string, _slot: string | undefined): string | undefined;
export declare function getBaleManualThreadDisplayNameValidationError(threadName: string): string | undefined;
export declare function isBaleTopicThreadNameValidForSlot(threadName: string, slot: string | undefined): boolean;
export declare function getBaleTopicName(request: BaleThreadTitleInput, template?: string, slot?: string): string;
export declare function getBaleTopicTitleForThreadName(threadName: string, slot: string, template?: string): string;

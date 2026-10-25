import type { BaleThreadDisplayMode } from "./config.ts";
import type { BaleApiCallOptions } from "./bale-api.ts";
import type { BaleTopicTargetStore, BaleWorkspaceDisplayBinding, BaleWorkspaceThreadBinding } from "./threads.ts";
/** Pure directory tokenization shared by previews, initial titles, and reconciliation. */
export declare function tokenizeBaleDirectorySegment(segment: string): string[];
/** Maps one leader-captured authenticated owner roster onto retained binding identities. */
export declare function resolveBaleLiveWorkspaceBindingKeys(bindings: readonly BaleWorkspaceThreadBinding[], leaderTarget: {
    chatId: number;
    threadId?: number;
} | undefined, followers: readonly {
    target?: {
        chatId: number;
        threadId?: number;
    };
}[]): ReadonlySet<string>;
export declare function resolveBaleWorkspaceDisplayNames(bindings: readonly BaleWorkspaceDisplayBinding[], mode: BaleThreadDisplayMode, liveBindingKeys?: ReadonlySet<string>): Map<string, string>;
export declare function resolveBaleInitialWorkspaceDisplayName(input: {
    bindings: readonly BaleWorkspaceDisplayBinding[];
    binding: BaleWorkspaceDisplayBinding;
    mode: BaleThreadDisplayMode;
    preserveRetainedManualName?: boolean;
    liveBindingKeys?: ReadonlySet<string>;
}): string | undefined;
export declare function applyBaleThreadDisplaySetting(mode: BaleThreadDisplayMode, deps: {
    getProfileKey(): string | undefined;
    ownsLeader(): boolean;
    getLeaderSetter(): ((mode: BaleThreadDisplayMode) => Promise<void>) | undefined;
    getFollowerSetter(): ((mode: BaleThreadDisplayMode) => Promise<void>) | undefined;
    reloadConfig(): Promise<void>;
}): Promise<void>;
export interface BaleThreadDisplayReconcilerDeps {
    store: Pick<BaleTopicTargetStore, "listWorkspaceBindings" | "setWorkspaceDisplayTitle" | "persist">;
    getMode(): BaleThreadDisplayMode;
    getProfileKey(): string;
    getLeaderEpoch(): string | number | undefined;
    captureBindingAuthority(binding: BaleWorkspaceThreadBinding): (() => boolean) | undefined;
    captureLiveBindingKeys(bindings: readonly BaleWorkspaceThreadBinding[]): ReadonlySet<string>;
    callApi<TResponse>(method: string, body: Record<string, unknown>, options?: BaleApiCallOptions): Promise<TResponse>;
}
export declare function createBaleThreadDisplaySettingsRuntime(deps: {
    getTarget(): {
        chatId: number;
        threadId?: number;
    } | undefined;
    getBinding(target: {
        chatId: number;
        threadId?: number;
    }): {
        manualThreadName?: string;
    } | undefined;
    apply(mode: BaleThreadDisplayMode): Promise<void>;
    reset(target: {
        chatId: number;
        threadId?: number;
    }): Promise<{
        ok: boolean;
        message?: string;
    }>;
}): {
    isCustom(): boolean;
    setMode(mode: BaleThreadDisplayMode): Promise<void>;
};
/** Caller owns triggering and reporting; no timer or background retry is created. */
export declare function createBaleThreadDisplayReconciler(deps: BaleThreadDisplayReconcilerDeps): {
    reconcile(bindingKey?: string): Promise<{
        changed: number;
    }>;
};

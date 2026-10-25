/**
 * Bale bridge config and pairing helpers
 * Zones: bale config, pairing, filesystem
 * Owns persisted bot/session pairing state, local config storage, live config controls, authorization policy, and first-user pairing side effects
 */
import type { CommandTemplateObjectConfig } from "./command-templates.ts";
import type { BaleInboundHandlerConfig } from "./inbound.ts";
export { BALE_DEFAULT_PROFILE_NAME } from "./paths.ts";
/** Parsed stored bot-token form: a literal secret or one environment-variable reference. */
export type BaleBotTokenReference = {
    kind: "literal";
    token: string;
} | {
    kind: "environment";
    variable: string;
} | {
    kind: "malformed";
};
/** Resolve a persisted token at a validation/activation boundary. */
export declare function resolveBaleBotToken(value: string | undefined, env?: NodeJS.ProcessEnv): string | undefined;
/** Redacted diagnostic for an unresolved or malformed token reference. */
export declare function getBaleBotTokenDiagnostic(value: string | undefined, env?: NodeJS.ProcessEnv): string | undefined;
export interface BaleOutboundHandlerConfig extends CommandTemplateObjectConfig {
    type?: string;
    match?: string | string[];
    output?: string;
    timeout?: number | string;
}
export type BaleTimeMode = "hidden" | "always" | "interval";
export interface BaleTimeConfig {
    interval?: number;
}
export interface ResolvedBaleTimeConfig {
    injectionMode: BaleTimeMode;
    interval: number;
    timezone: string;
}
export type BaleThreadDisplayMode = "letters" | "names" | "directories" | "directory-snake" | "directory-title";
export declare function resolveBaleThreadDisplayMode(config: Pick<BaleConfig, "threads">): BaleThreadDisplayMode;
export declare function setBaleThreadDisplayMode(store: BaleConfigStore, mode: BaleThreadDisplayMode, isCurrent: () => boolean): Promise<void>;
export type BaleAssistantRenderingMode = "rich" | "html";
export type BaleActivityVerbosity = "quiet" | "thinking" | "tools" | "verbose";
export interface BaleConfig {
    /** @deprecated persisted identity belongs in profiles.default; retained for effective/legacy views */
    botToken?: string;
    /** @deprecated persisted identity belongs in profiles.default; retained for effective/legacy views */
    botUsername?: string;
    /** @deprecated persisted identity belongs in profiles.default; retained for effective/legacy views */
    botId?: number;
    /** @deprecated persisted identity belongs in profiles.default; retained for effective/legacy views */
    allowedUserId?: number;
    inboundHandlers?: BaleInboundHandlerConfig[];
    attachmentHandlers?: BaleInboundHandlerConfig[];
    outboundHandlers?: BaleOutboundHandlerConfig[];
    assistant?: {
        draftPreviews?: boolean;
        rendering?: BaleAssistantRenderingMode;
        activity?: BaleActivityVerbosity;
        timeInjection?: BaleTimeMode;
        /** @deprecated use activity */
        activityVerbosity?: BaleActivityVerbosity;
    };
    /** @deprecated use assistant.draftPreviews */
    draftPreviews?: boolean;
    /** @deprecated use assistant.draftPreviews */
    richDraftPreviews?: boolean;
    /** @deprecated use assistant.rendering */
    assistantRendering?: BaleAssistantRenderingMode;
    voice?: {
        /** `hidden` is a read-only compatibility alias for the former manual mode. */
        replyMode?: "manual" | "hidden" | "mirror" | "always";
    };
    time?: BaleTimeConfig;
    threads?: {
        /** Delete this instance's bound Bale thread on graceful Pi quit. */
        automaticCleanup?: boolean;
        /** Automatic Thread title strategy shared by every profile; absent or invalid resolves to `letters`. */
        displayMode?: BaleThreadDisplayMode;
    };
    /** Canonical bot/session profiles, including profiles.default. */
    profiles?: Record<string, BaleBotProfile>;
}
/**
 * Per-profile bot identity and paired owner only.
 * Stored under `profiles.<name>` in bale.json.
 * Shared bridge settings (handlers, assistant, voice, time, threads) stay at
 * the top level and never leak into profiles.
 */
export interface BaleBotProfile {
    botToken: string;
    botUsername?: string;
    botId?: number;
    allowedUserId?: number;
}
export declare function isValidBaleProfileName(name: string): boolean;
/** List defined profile names. */
export declare function getBaleProfileNames(config: BaleConfig): string[];
export interface BaleConfigStore {
    get: () => BaleConfig;
    getStoredConfig: () => BaleConfig;
    set: (config: BaleConfig) => void;
    setProfile: (profileName: string, profile: BaleBotProfile) => void;
    update: (mutate: (config: BaleConfig) => void) => void;
    activateProfile: (profileName: string | undefined) => boolean;
    getActiveProfileName: () => string | undefined;
    getBotToken: () => string | undefined;
    getBotTokenDiagnostic: () => string | undefined;
    hasBotToken: () => boolean;
    getAllowedUserId: () => number | undefined;
    getLegacyPollingCursor: () => number | undefined;
    removeLegacyPollingCursor: () => void;
    getInboundHandlers: () => BaleInboundHandlerConfig[] | undefined;
    getAttachmentHandlers: () => BaleInboundHandlerConfig[] | undefined;
    getOutboundHandlers: () => BaleOutboundHandlerConfig[] | undefined;
    setAllowedUserId: (userId: number) => void;
    /** Publish an unpaired profile owner atomically; true only for the resulting exact owner. */
    persistAllowedUserId: (userId: number, assertExecutionCurrent?: () => void, commitIfOwned?: (commit: () => void) => boolean) => Promise<boolean>;
    /** Trusted synchronous publication only; caller acquires Workspace admission before this config transaction. */
    withPairingAdmission: <T>(profileName: string, tokenSha256: string, publish: (preApprovalExcluded: boolean) => T) => T;
    /** Observe an existing exact owner and refresh an unpaired cache; never create an owner. Callback must be synchronous. */
    withPairedUserAdmission: <T>(profileName: string, tokenSha256: string, userId: number, publish: () => T, assertExecutionCurrent?: () => void) => {
        admitted: false;
    } | {
        admitted: true;
        value: T;
    };
    load: () => Promise<void>;
    didLastLoadRecoverInvalidConfig: () => boolean;
    persist: (config?: BaleConfig, options?: {
        isCurrent?: () => boolean;
    }) => Promise<void>;
}
export declare function createBaleConfigBotIdGetter(store: Pick<BaleConfigStore, "get">): () => number | undefined;
export declare function createBaleActiveProfileKeyGetter(store: Pick<BaleConfigStore, "getActiveProfileName">): () => string;
export interface BaleConfigStoreOptions {
    initialConfig?: BaleConfig;
    agentDir?: string;
    configPath?: string;
    /** Environment used to resolve `$NAME` token references; defaults to process.env. */
    env?: NodeJS.ProcessEnv;
    recordRuntimeEvent?: (category: string, error: unknown, details?: Record<string, unknown>) => void;
}
export interface BaleInvalidConfigRecovery {
    configPath: string;
    recoveryPath: string;
    error: unknown;
}
type BaleMutableConfigStore = Pick<BaleConfigStore, "get" | "set" | "persist"> & {
    load?: () => Promise<void>;
    didLastLoadRecoverInvalidConfig?: () => boolean;
};
export declare function readBaleConfig(configPath: string, options?: {
    onInvalidConfig?: (recovery: BaleInvalidConfigRecovery) => void;
}): Promise<BaleConfig>;
export declare function getBaleProfileFields(config: BaleConfig): BaleBotProfile | undefined;
export declare function normalizeBaleDefaultProfileConfig(config: BaleConfig): {
    config: BaleConfig;
    changed: boolean;
};
export declare function createBaleConfigStore(options?: BaleConfigStoreOptions): BaleConfigStore;
export declare function createBaleVoiceReplyModeGetter(configStore: Pick<BaleConfigStore, "get">): () => "manual" | "mirror" | "always";
export declare function createBaleVoiceReplyModeConfiguredChecker(configStore: Pick<BaleConfigStore, "get">): () => boolean;
export declare function createBaleVoiceReplyModeSetter(configStore: BaleMutableConfigStore): (replyMode: "manual" | "hidden" | "mirror" | "always" | undefined) => Promise<void>;
export declare function resolveBaleTimeConfig(raw: BaleTimeConfig | undefined, timeInjection?: BaleTimeMode | undefined): ResolvedBaleTimeConfig;
export declare function createBaleTimeConfigGetter(configStore: Pick<BaleConfigStore, "get">): () => ResolvedBaleTimeConfig;
export declare function createBaleTimeInjectionModeGetter(configStore: Pick<BaleConfigStore, "get">): () => BaleTimeMode;
export declare function createBaleTimeInjectionModeSetter(configStore: BaleMutableConfigStore): (injectionMode: BaleTimeMode) => Promise<void>;
export interface BaleProactivePushTarget {
    chatId: number;
    threadId?: number;
}
export declare function createBaleProactivePushChatIdGetter(getTarget: () => BaleProactivePushTarget | undefined): () => number | undefined;
export declare function createBaleProactivePushTargetGetter(deps: {
    getActiveTurnTarget: () => BaleProactivePushTarget | undefined;
    getAssignedTarget: () => BaleProactivePushTarget | undefined;
    getAllowedUserId: () => number | undefined;
}): () => BaleProactivePushTarget | undefined;
export declare function createBaleConfigControls(configStore: BaleMutableConfigStore): {
    areDraftPreviewsEnabled: () => boolean;
    setDraftPreviewsEnabled: (enabled: boolean) => Promise<void>;
    getAssistantRenderingMode: () => BaleAssistantRenderingMode;
    setAssistantRenderingMode: (mode: BaleAssistantRenderingMode) => Promise<void>;
    getActivityVerbosity: () => BaleActivityVerbosity;
    refreshActivityVerbosity: () => Promise<void>;
    setActivityVerbosity: (verbosity: BaleActivityVerbosity) => Promise<void>;
    getVoiceReplyMode: () => "manual" | "mirror" | "always";
    isVoiceReplyModeConfigured: () => boolean;
    setVoiceReplyMode: (replyMode: "manual" | "hidden" | "mirror" | "always" | undefined) => Promise<void>;
    getTimeInjectionMode: () => BaleTimeMode;
    setTimeInjectionMode: (injectionMode: BaleTimeMode) => Promise<void>;
    isAutomaticThreadCleanupEnabled: () => boolean;
    resolveAutomaticThreadCleanupEnabled: () => Promise<boolean>;
    setAutomaticThreadCleanupEnabled: (enabled: boolean) => Promise<void>;
};
export type BaleAuthorizationState = {
    kind: "pair";
    userId: number;
} | {
    kind: "allow";
} | {
    kind: "deny";
};
export interface BaleUserPairingDeps<TContext> {
    allowedUserId?: number;
    ctx: TContext;
    persistAllowedUserId: BaleConfigStore["persistAllowedUserId"];
    updateStatus: (ctx: TContext) => void;
    assertExecutionCurrent?: () => void;
}
export interface BaleUserPairingRuntimeDeps<TContext> {
    getAllowedUserId: () => number | undefined;
    persistAllowedUserId: BaleConfigStore["persistAllowedUserId"];
    updateStatus: (ctx: TContext) => void;
}
export interface BaleUserPairingRuntime<TContext> {
    /** True means this user is authorized, whether newly paired or already configured. */
    pairIfNeeded: (userId: number, ctx: TContext, assertExecutionCurrent?: () => void) => Promise<boolean>;
}
export declare function getBaleAuthorizationState(userId: number, allowedUserId?: number): BaleAuthorizationState;
export declare function pairBaleUserIfNeeded<TContext>(userId: number, deps: BaleUserPairingDeps<TContext>): Promise<boolean>;
export declare function createBaleUserPairingRuntime<TContext>(deps: BaleUserPairingRuntimeDeps<TContext>): BaleUserPairingRuntime<TContext>;

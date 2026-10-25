/**
 * Bale setup prompt helpers
 * Zones: pi agent command ui, bale config
 * Computes token-prefill defaults and prompt mode selection for /bale-setup
 */
export interface BaleSetupConfig {
    botToken?: string;
    botId?: number;
    botUsername?: string;
    allowedUserId?: number;
}
export interface BaleBotTokenPromptSpec {
    method: "input" | "editor";
    value: string;
}
export interface BaleSetupUser {
    id: number;
    username?: string;
}
export interface BalePollingStartResult {
    ok: boolean;
    message?: string;
}
export type BaleSetupCompletion = {
    status: "success";
    config: BaleSetupConfig;
} | {
    status: "cancelled" | "unavailable" | "busy" | "validation-failed";
} | {
    status: "polling-failed";
    config: BaleSetupConfig;
};
export interface BaleSetupDeps {
    hasUI: boolean;
    env: NodeJS.ProcessEnv;
    config: BaleSetupConfig;
    promptInput: (label: string, value: string) => Promise<string | undefined>;
    promptEditor: (label: string, value: string) => Promise<string | undefined>;
    getMe: (botToken: string) => Promise<{
        ok: boolean;
        result?: BaleSetupUser;
        description?: string;
    }>;
    /** Resolve a submitted literal token or `$NAME`/`${NAME}` reference. */
    resolveBotToken?: (value: string) => string | undefined;
    /** Redacted diagnostic for an unresolved or malformed token reference. */
    describeBotToken?: (value: string) => string | undefined;
    persistConfig: (config: BaleSetupConfig) => Promise<void>;
    notify: (message: string, level: "info" | "error") => void;
    startPolling: () => unknown | Promise<unknown>;
    updateStatus: () => void;
}
export interface BaleSetupPromptContext {
    hasUI: boolean;
    ui: {
        input: (label: string, value: string) => Promise<string | undefined>;
        editor: (label: string, value: string) => Promise<string | undefined>;
        notify: (message: string, level: "info" | "error") => void;
    };
}
export interface BaleSetupGuard {
    start: () => boolean;
    finish: () => void;
}
export interface BaleSetupPromptRuntimeDeps<TContext extends BaleSetupPromptContext> {
    env?: NodeJS.ProcessEnv;
    getConfig: () => BaleSetupConfig;
    setConfig: (config: BaleSetupConfig) => void;
    setupGuard: BaleSetupGuard;
    getMe: BaleSetupDeps["getMe"];
    resolveBotToken?: BaleSetupDeps["resolveBotToken"];
    describeBotToken?: BaleSetupDeps["describeBotToken"];
    persistConfig: (config: BaleSetupConfig) => Promise<void>;
    startPolling: (ctx: TContext) => unknown | Promise<unknown>;
    updateStatus: (ctx: TContext) => void;
    recordRuntimeEvent?: (category: string, error: unknown, details?: Record<string, unknown>) => void;
}
export declare const BALE_BOT_TOKEN_INPUT_PLACEHOLDER = "123456:ABCDEF...";
export declare function getBaleBotTokenInputDefault(env?: NodeJS.ProcessEnv, configToken?: string): string;
export declare function getBaleBotTokenPromptSpec(env?: NodeJS.ProcessEnv, configToken?: string): BaleBotTokenPromptSpec;
export declare function runBaleSetup(deps: BaleSetupDeps): Promise<BaleSetupCompletion>;
export declare function createBaleSetupPromptRuntime<TContext extends BaleSetupPromptContext>(deps: BaleSetupPromptRuntimeDeps<TContext>): (ctx: TContext) => Promise<BaleSetupCompletion>;

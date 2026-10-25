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

export type BaleSetupCompletion =
  | { status: "success"; config: BaleSetupConfig }
  | { status: "cancelled" | "unavailable" | "busy" | "validation-failed" }
  | { status: "polling-failed"; config: BaleSetupConfig };

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

export interface BaleSetupPromptRuntimeDeps<
  TContext extends BaleSetupPromptContext,
> {
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
  recordRuntimeEvent?: (
    category: string,
    error: unknown,
    details?: Record<string, unknown>,
  ) => void;
}

export const BALE_BOT_TOKEN_INPUT_PLACEHOLDER = "123456:ABCDEF...";
const BALE_BOT_TOKEN_ENV_VARS = [
  "BALE_BOT_TOKEN",
  "BALE_BOT_KEY",
  "BALE_TOKEN",
  "BALE_KEY",
] as const;

/**
 * Default submitted-token handling for structural callers that inject no
 * reference port: plain literals pass through, while `$`-prefixed values fail
 * closed instead of being sent to the Bot API as a literal token.
 */
function resolveSubmittedBaleBotToken(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed || trimmed.startsWith("$")) return undefined;
  return trimmed;
}

function describeSubmittedBaleBotToken(value: string): string | undefined {
  return value.trim().startsWith("$")
    ? "Bale bot token environment reference is unavailable in this setup environment."
    : undefined;
}

function isBalePollingStartResult(
  value: unknown,
): value is BalePollingStartResult {
  return (
    !!value &&
    typeof value === "object" &&
    typeof (value as { ok?: unknown }).ok === "boolean"
  );
}

export function getBaleBotTokenInputDefault(
  env: NodeJS.ProcessEnv = process.env,
  configToken?: string,
): string {
  const trimmedConfigToken = configToken?.trim();
  if (trimmedConfigToken) return trimmedConfigToken;
  for (const key of BALE_BOT_TOKEN_ENV_VARS) {
    // Persist the originating alias rather than copying the resolved secret.
    if (env[key]?.trim()) return `$${key}`;
  }
  return BALE_BOT_TOKEN_INPUT_PLACEHOLDER;
}

export function getBaleBotTokenPromptSpec(
  env: NodeJS.ProcessEnv = process.env,
  configToken?: string,
): BaleBotTokenPromptSpec {
  const value = getBaleBotTokenInputDefault(env, configToken);
  return {
    method: value === BALE_BOT_TOKEN_INPUT_PLACEHOLDER ? "input" : "editor",
    value,
  };
}

export async function runBaleSetup(
  deps: BaleSetupDeps,
): Promise<BaleSetupCompletion> {
  if (!deps.hasUI) return { status: "unavailable" };
  const tokenPrompt = getBaleBotTokenPromptSpec(
    deps.env,
    deps.config.botToken,
  );
  const token =
    tokenPrompt.method === "editor"
      ? await deps.promptEditor("Bale bot token", tokenPrompt.value)
      : await deps.promptInput("Bale bot token", tokenPrompt.value);
  if (!token) return { status: "cancelled" };
  const submittedToken = token.trim();
  const resolveBotToken =
    deps.resolveBotToken ?? resolveSubmittedBaleBotToken;
  const describeBotToken =
    deps.describeBotToken ?? describeSubmittedBaleBotToken;
  const resolvedToken = resolveBotToken(submittedToken);
  const nextConfig: BaleSetupConfig = {
    ...deps.config,
    botToken: submittedToken,
  };
  if (!resolvedToken) {
    deps.notify(
      describeBotToken(submittedToken) ?? "Invalid Bale bot token",
      "error",
    );
    return { status: "validation-failed" };
  }
  let data: Awaited<ReturnType<BaleSetupDeps["getMe"]>>;
  try {
    data = await deps.getMe(resolvedToken);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    deps.notify(`Bale API check failed: ${message}`, "error");
    return { status: "validation-failed" };
  }
  if (!data.ok || !data.result) {
    deps.notify(data.description || "Invalid Bale bot token", "error");
    return { status: "validation-failed" };
  }
  nextConfig.botId = data.result.id;
  nextConfig.botUsername = data.result.username;
  await deps.persistConfig(nextConfig);
  deps.notify(
    `Bale bot connected: @${nextConfig.botUsername ?? "unknown"}`,
    "info",
  );
  deps.notify(
    "Send /start to your bot in Bale to pair this extension with your account.",
    "info",
  );
  let startResult: unknown;
  try {
    startResult = await deps.startPolling();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    deps.notify(`Bale polling failed: ${message}`, "error");
    deps.updateStatus();
    return { status: "polling-failed", config: nextConfig };
  }
  if (isBalePollingStartResult(startResult) && startResult.message) {
    deps.notify(startResult.message, startResult.ok ? "info" : "error");
  }
  deps.updateStatus();
  if (isBalePollingStartResult(startResult) && !startResult.ok) {
    return { status: "polling-failed", config: nextConfig };
  }
  return { status: "success", config: nextConfig };
}

export function createBaleSetupPromptRuntime<
  TContext extends BaleSetupPromptContext,
>(deps: BaleSetupPromptRuntimeDeps<TContext>) {
  return async (ctx: TContext): Promise<BaleSetupCompletion> => {
    if (!ctx.hasUI) return { status: "unavailable" };
    if (!deps.setupGuard.start()) return { status: "busy" };
    try {
      return await runBaleSetup({
        hasUI: ctx.hasUI,
        env: deps.env ?? process.env,
        config: deps.getConfig(),
        promptInput: (label, value) => ctx.ui.input(label, value),
        promptEditor: (label, value) => ctx.ui.editor(label, value),
        getMe: deps.getMe,
        resolveBotToken: deps.resolveBotToken,
        describeBotToken: deps.describeBotToken,
        persistConfig: async (config) => {
          const previousConfig = deps.getConfig();
          deps.setConfig(config);
          try {
            await deps.persistConfig(config);
          } catch (error) {
            deps.setConfig(previousConfig);
            throw error;
          }
        },
        notify: (message, level) => ctx.ui.notify(message, level),
        startPolling: () => deps.startPolling(ctx),
        updateStatus: () => deps.updateStatus(ctx),
      });
    } catch (error) {
      deps.recordRuntimeEvent?.("setup", error);
      throw error;
    } finally {
      deps.setupGuard.finish();
    }
  };
}

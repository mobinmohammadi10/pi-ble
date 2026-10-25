/**
 * Bale bridge config and pairing helpers
 * Zones: bale config, pairing, filesystem
 * Owns persisted bot/session pairing state, local config storage, live config controls, authorization policy, and first-user pairing side effects
 */

import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";

import type { CommandTemplateObjectConfig } from "./command-templates.ts";
import type { BaleInboundHandlerConfig } from "./inbound.ts";
import { withBaleFileTransaction } from "./locks.ts";
import {
  resolveAgentDir,
  resolveBaleConfigPath,
  BALE_DEFAULT_PROFILE_NAME,
} from "./paths.ts";
import { isPiStaleContextError } from "./pi.ts";
import { isWireRecord as isPlainConfigRecord } from "./wire.ts";

export { BALE_DEFAULT_PROFILE_NAME } from "./paths.ts";

const CONFIG_REPLACE_RETRY_ATTEMPTS = 5;
const CONFIG_REPLACE_RETRY_DELAY_MS = 25;

function isRetryableConfigReplaceError(error: unknown): boolean {
  const code = (error as { code?: unknown })?.code;
  return code === "EPERM" || code === "EACCES" || code === "EBUSY";
}

function sleepConfigReplaceRetry(ms: number): void {
  if (ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function replaceBaleConfigFile(tempPath: string, configPath: string): void {
  for (let attempt = 0; attempt < CONFIG_REPLACE_RETRY_ATTEMPTS; attempt += 1) {
    try {
      renameSync(tempPath, configPath);
      return;
    } catch (error) {
      if (
        !isRetryableConfigReplaceError(error) ||
        attempt === CONFIG_REPLACE_RETRY_ATTEMPTS - 1
      ) {
        throw error;
      }
      sleepConfigReplaceRetry(CONFIG_REPLACE_RETRY_DELAY_MS * (attempt + 1));
    }
  }
}

function getConfigPath(): string {
  return resolveBaleConfigPath();
}

const BALE_BOT_TOKEN_ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Parsed stored bot-token form: a literal secret or one environment-variable reference. */
export type BaleBotTokenReference =
  | { kind: "literal"; token: string }
  | { kind: "environment"; variable: string }
  | { kind: "malformed" };

/**
 * Parse a persisted bot-token value. `$NAME` and `${NAME}` are exact
 * environment-variable references. Any other `$`-prefixed value is malformed
 * rather than a literal secret so a broken reference fails closed.
 */
function getBaleBotTokenReference(
  value: string | undefined,
): BaleBotTokenReference | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  if (!trimmed.startsWith("$")) return { kind: "literal", token: trimmed };
  const body =
    trimmed.startsWith("${") && trimmed.endsWith("}")
      ? trimmed.slice(2, -1)
      : trimmed.slice(1);
  return BALE_BOT_TOKEN_ENV_NAME_PATTERN.test(body)
    ? { kind: "environment", variable: body }
    : { kind: "malformed" };
}

/** Resolve a persisted token at a validation/activation boundary. */
export function resolveBaleBotToken(
  value: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const reference = getBaleBotTokenReference(value);
  if (reference?.kind === "literal") return reference.token;
  if (reference?.kind !== "environment") return undefined;
  return env[reference.variable]?.trim() || undefined;
}

/** Redacted diagnostic for an unresolved or malformed token reference. */
export function getBaleBotTokenDiagnostic(
  value: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const reference = getBaleBotTokenReference(value);
  if (reference?.kind === "malformed") {
    return "Bale bot token environment reference is malformed; use $NAME or ${NAME}.";
  }
  if (reference?.kind !== "environment") return undefined;
  if (resolveBaleBotToken(value, env)) return undefined;
  return `Bale bot token environment variable ${reference.variable} is not set.`;
}

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

export type BaleThreadDisplayMode =
  "letters" | "names" | "directories" | "directory-snake" | "directory-title";

const BALE_THREAD_DISPLAY_MODES: readonly BaleThreadDisplayMode[] = [
  "letters",
  "names",
  "directory-snake",
  "directory-title",
];

export function resolveBaleThreadDisplayMode(
  config: Pick<BaleConfig, "threads">,
): BaleThreadDisplayMode {
  const mode = config.threads?.displayMode;
  return BALE_THREAD_DISPLAY_MODES.includes(mode as BaleThreadDisplayMode)
    ? (mode as BaleThreadDisplayMode)
    : "letters";
}

export async function setBaleThreadDisplayMode(
  store: BaleConfigStore,
  mode: BaleThreadDisplayMode,
  isCurrent: () => boolean,
): Promise<void> {
  if (!BALE_THREAD_DISPLAY_MODES.includes(mode)) {
    throw new Error("Invalid Bale Thread display mode.");
  }
  const profile = store.getActiveProfileName();
  const current = () => isCurrent() && store.getActiveProfileName() === profile;
  if (!current())
    throw new Error("Bale Thread display setting lost authority.");
  await store.load();
  if (!current() || !store.hasBotToken()) {
    throw new Error(
      "Bale Thread display setting lost its configured profile.",
    );
  }
  const latest = store.get();
  await store.persist(
    { ...latest, threads: { ...latest.threads, displayMode: mode } },
    { isCurrent: current },
  );
  if (!current())
    throw new Error(
      "Bale Thread display setting changed during persistence.",
    );
}

export type BaleAssistantRenderingMode = "rich" | "html";
export type BaleActivityVerbosity =
  "quiet" | "thinking" | "tools" | "verbose";

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

interface BaleLegacyCursorCarrier {
  lastUpdateId?: number;
}

/** Profile names must contain only lowercase ASCII letters and digits; max 32 chars. */
const BALE_PROFILE_NAME_PATTERN = /^[a-z0-9]{1,32}$/;
const BALE_RESERVED_PROFILE_NAMES: ReadonlySet<string> = new Set([
  "main",
  "active",
]);

export function isValidBaleProfileName(name: string): boolean {
  return (
    BALE_PROFILE_NAME_PATTERN.test(name) &&
    !BALE_RESERVED_PROFILE_NAMES.has(name)
  );
}

/** List defined profile names. */
export function getBaleProfileNames(config: BaleConfig): string[] {
  return Object.keys(config.profiles ?? {}).sort();
}

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
  persistAllowedUserId: (
    userId: number,
    assertExecutionCurrent?: () => void,
    commitIfOwned?: (commit: () => void) => boolean,
  ) => Promise<boolean>;
  /** Trusted synchronous publication only; caller acquires Workspace admission before this config transaction. */
  withPairingAdmission: <T>(
    profileName: string,
    tokenSha256: string,
    publish: (preApprovalExcluded: boolean) => T,
  ) => T;
  /** Observe an existing exact owner and refresh an unpaired cache; never create an owner. Callback must be synchronous. */
  withPairedUserAdmission: <T>(
    profileName: string,
    tokenSha256: string,
    userId: number,
    publish: () => T,
    assertExecutionCurrent?: () => void,
  ) => { admitted: false } | { admitted: true; value: T };
  load: () => Promise<void>;
  didLastLoadRecoverInvalidConfig: () => boolean;
  persist: (
    config?: BaleConfig,
    options?: { isCurrent?: () => boolean },
  ) => Promise<void>;
}

export function createBaleConfigBotIdGetter(
  store: Pick<BaleConfigStore, "get">,
): () => number | undefined {
  return () => store.get().botId;
}

export function createBaleActiveProfileKeyGetter(
  store: Pick<BaleConfigStore, "getActiveProfileName">,
): () => string {
  return () => store.getActiveProfileName() ?? BALE_DEFAULT_PROFILE_NAME;
}

export interface BaleConfigStoreOptions {
  initialConfig?: BaleConfig;
  agentDir?: string;
  configPath?: string;
  /** Environment used to resolve `$NAME` token references; defaults to process.env. */
  env?: NodeJS.ProcessEnv;
  recordRuntimeEvent?: (
    category: string,
    error: unknown,
    details?: Record<string, unknown>,
  ) => void;
}

export interface BaleInvalidConfigRecovery {
  configPath: string;
  recoveryPath: string;
  error: unknown;
}

type BaleMutableConfigStore = Pick<
  BaleConfigStore,
  "get" | "set" | "persist"
> & {
  load?: () => Promise<void>;
  didLastLoadRecoverInvalidConfig?: () => boolean;
};

function isEmptyBaleConfig(config: BaleConfig): boolean {
  return Object.keys(config).length === 0;
}

async function loadLatestBaleConfig(
  configStore: BaleMutableConfigStore,
): Promise<void> {
  if (!configStore.load) return;
  const before = configStore.get();
  await configStore.load();
  if (
    !isEmptyBaleConfig(before) &&
    isEmptyBaleConfig(configStore.get())
  ) {
    configStore.set(before);
  }
}

function getInvalidBaleConfigRecoveryPath(configPath: string): string {
  return `${configPath}.invalid-${process.pid}-${Date.now()}`;
}

export async function readBaleConfig(
  configPath: string,
  options: {
    onInvalidConfig?: (recovery: BaleInvalidConfigRecovery) => void;
  } = {},
): Promise<BaleConfig> {
  if (!existsSync(configPath)) return {};
  const content = readFileSync(configPath, "utf8");
  try {
    return JSON.parse(content) as BaleConfig;
  } catch {
    // Atomic config publication makes ordinary reads safe without serialization.
    // Acquire the transaction only before destructive invalid-file recovery.
    return withBaleFileTransaction(`${configPath}.transaction`, () => {
      if (!existsSync(configPath)) return {};
      const identity = statSync(configPath);
      const currentContent = readFileSync(configPath, "utf8");
      try {
        return JSON.parse(currentContent) as BaleConfig;
      } catch (error) {
        const currentIdentity = statSync(configPath);
        if (
          currentIdentity.dev !== identity.dev ||
          currentIdentity.ino !== identity.ino ||
          currentIdentity.size !== identity.size ||
          currentIdentity.mtimeMs !== identity.mtimeMs
        ) {
          throw new Error(
            `Bale config changed while validating invalid content: ${configPath}`,
            { cause: error },
          );
        }
        const recoveryPath = getInvalidBaleConfigRecoveryPath(configPath);
        renameSync(configPath, recoveryPath);
        options.onInvalidConfig?.({ configPath, recoveryPath, error });
        return {};
      }
    });
  }
}

function cloneBaleConfig<T>(value: T): T {
  return structuredClone(value);
}

function configValuesEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function mergeBaleConfigDelta(
  base: Record<string, unknown>,
  desired: Record<string, unknown>,
  latest: Record<string, unknown>,
): Record<string, unknown> {
  const merged = cloneBaleConfig(latest);
  for (const key of new Set([...Object.keys(base), ...Object.keys(desired)])) {
    const baseHas = Object.hasOwn(base, key);
    const desiredHas = Object.hasOwn(desired, key);
    const baseValue = base[key];
    const desiredValue = desired[key];
    if (baseHas === desiredHas && configValuesEqual(baseValue, desiredValue)) {
      continue;
    }
    if (!desiredHas) {
      delete merged[key];
      continue;
    }
    if (
      isPlainConfigRecord(desiredValue) &&
      (!baseHas || isPlainConfigRecord(baseValue))
    ) {
      merged[key] = mergeBaleConfigDelta(
        isPlainConfigRecord(baseValue) ? baseValue : {},
        desiredValue,
        isPlainConfigRecord(merged[key]) ? merged[key] : {},
      );
      continue;
    }
    merged[key] = cloneBaleConfig(desiredValue);
  }
  return merged;
}

function readBaleConfigForTransaction(configPath: string): BaleConfig {
  if (!existsSync(configPath)) return {};
  const parsed: unknown = JSON.parse(readFileSync(configPath, "utf8"));
  if (!isPlainConfigRecord(parsed)) {
    throw new Error(`Invalid Bale config object: ${configPath}`);
  }
  return parsed as BaleConfig;
}

function writeBaleConfigInTransaction(
  agentDir: string,
  configPath: string,
  config: BaleConfig,
): void {
  mkdirSync(agentDir, { recursive: true, mode: 0o700 });
  const tempConfigPath = `${configPath}.tmp-${process.pid}-${randomUUID()}`;
  writeFileSync(tempConfigPath, `${JSON.stringify(config, null, "\t")}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  chmodSync(tempConfigPath, 0o600);
  try {
    replaceBaleConfigFile(tempConfigPath, configPath);
    chmodSync(configPath, 0o600);
  } finally {
    try {
      unlinkSync(tempConfigPath);
    } catch {
      /* rename consumed the temp file or cleanup is best effort */
    }
  }
}

export function getBaleProfileFields(
  config: BaleConfig,
): BaleBotProfile | undefined {
  const token = config.botToken?.trim();
  if (!token) return undefined;
  return { botToken: token, ...pickBaleRootProfileFields(config) };
}

/** Root-level profile fields other than the token, including the retired legacy cursor. */
function pickBaleRootProfileFields(
  config: BaleConfig,
): Omit<BaleBotProfile, "botToken"> & BaleLegacyCursorCarrier {
  const legacyCursor = (config as BaleConfig & BaleLegacyCursorCarrier)
    .lastUpdateId;
  return {
    ...(config.botUsername !== undefined
      ? { botUsername: config.botUsername }
      : {}),
    ...(config.botId !== undefined ? { botId: config.botId } : {}),
    ...(config.allowedUserId !== undefined
      ? { allowedUserId: config.allowedUserId }
      : {}),
    ...(legacyCursor !== undefined ? { lastUpdateId: legacyCursor } : {}),
  };
}

function omitBaleRootProfileFields(config: BaleConfig): BaleConfig {
  const {
    botToken: _botToken,
    botUsername: _botUsername,
    botId: _botId,
    allowedUserId: _allowedUserId,
    lastUpdateId: _lastUpdateId,
    ...sharedConfig
  } = config as BaleConfig & BaleLegacyCursorCarrier;
  return sharedConfig;
}

function omitRetiredProactivePush(config: BaleConfig): {
  config: BaleConfig;
  changed: boolean;
} {
  const assistant = config.assistant as
    | (NonNullable<BaleConfig["assistant"]> & { proactivePush?: unknown })
    | undefined;
  if (!assistant || !Object.hasOwn(assistant, "proactivePush")) {
    return { config, changed: false };
  }
  const { proactivePush: _proactivePush, ...remainingAssistant } = assistant;
  const next = { ...config };
  if (Object.keys(remainingAssistant).length > 0) {
    next.assistant = remainingAssistant;
  } else {
    delete next.assistant;
  }
  return { config: next, changed: true };
}

export function normalizeBaleDefaultProfileConfig(config: BaleConfig): {
  config: BaleConfig;
  changed: boolean;
} {
  const retiredProactivePush = omitRetiredProactivePush(config);
  config = retiredProactivePush.config;
  const hasLegacyRootProfile = [
    "botToken",
    "botUsername",
    "botId",
    "allowedUserId",
    "lastUpdateId",
  ].some((field) => Object.hasOwn(config, field));
  if (!hasLegacyRootProfile) {
    return { config, changed: retiredProactivePush.changed };
  }
  const canonicalProfile = config.profiles?.[BALE_DEFAULT_PROFILE_NAME];
  const legacyToken = config.botToken?.trim();
  if (Object.hasOwn(config, "botToken") && !legacyToken) {
    throw new Error("Legacy Bale default profile has no bot token");
  }
  const legacyProfile: Partial<BaleBotProfile> &
    BaleLegacyCursorCarrier = {
    ...(legacyToken ? { botToken: legacyToken } : {}),
    ...pickBaleRootProfileFields(config),
  };
  if (!canonicalProfile && !legacyToken) {
    throw new Error("Legacy Bale default profile has no bot token");
  }
  const hasConflict = canonicalProfile
    ? Object.entries(legacyProfile).some(
        ([field, value]) =>
          Object.hasOwn(canonicalProfile, field) &&
          !configValuesEqual(
            canonicalProfile[field as keyof BaleBotProfile],
            value,
          ),
      )
    : false;
  if (hasConflict) {
    throw new Error(
      "Conflicting Bale default profile identity at root and profiles.default",
    );
  }
  const normalizedProfile: BaleBotProfile = canonicalProfile
    ? { ...legacyProfile, ...canonicalProfile }
    : (legacyProfile as BaleBotProfile);
  return {
    config: {
      ...omitBaleRootProfileFields(config),
      profiles: {
        ...(config.profiles ?? {}),
        [BALE_DEFAULT_PROFILE_NAME]: normalizedProfile,
      },
    },
    changed: true,
  };
}

function applyBaleProfile(
  config: BaleConfig,
  profileName: string | undefined,
): BaleConfig {
  const effectiveProfileName = profileName ?? BALE_DEFAULT_PROFILE_NAME;
  const profile = config.profiles?.[effectiveProfileName];
  if (!profile) return omitBaleRootProfileFields(config);
  return {
    ...omitBaleRootProfileFields(config),
    ...profile,
  };
}

function storeBaleEffectiveConfig(
  baseConfig: BaleConfig,
  nextConfig: BaleConfig,
  profileName: string | undefined,
): BaleConfig {
  const effectiveProfileName = profileName ?? BALE_DEFAULT_PROFILE_NAME;
  const profile = getBaleProfileFields(nextConfig);
  const profiles = { ...(baseConfig.profiles ?? {}) };
  if (profile) profiles[effectiveProfileName] = profile;
  else delete profiles[effectiveProfileName];
  return {
    ...omitBaleRootProfileFields(nextConfig),
    profiles: Object.keys(profiles).length > 0 ? profiles : undefined,
  };
}

export function createBaleConfigStore(
  options: BaleConfigStoreOptions = {},
): BaleConfigStore {
  let config: BaleConfig = normalizeBaleDefaultProfileConfig(
    cloneBaleConfig(options.initialConfig ?? {}),
  ).config;
  let persistedConfig: BaleConfig = {};
  let mutationVersion = 0;
  let persistQueue: Promise<void> = Promise.resolve();
  let activeProfileName: string | undefined;
  let lastLoadRecoveredInvalidConfig = false;
  const agentDir = options.agentDir ?? resolveAgentDir();
  const configPath = options.configPath ?? getConfigPath();
  const env = options.env ?? process.env;
  const getEffectiveConfig = () =>
    applyBaleProfile(config, activeProfileName);
  const setEffectiveConfig = (nextConfig: BaleConfig) => {
    config = storeBaleEffectiveConfig(
      config,
      nextConfig,
      activeProfileName,
    );
    mutationVersion += 1;
  };
  const adoptPersistedConfig = (
    merged: BaleConfig,
    preserveLocalChanges: boolean,
  ) => {
    // Local edits are relative to the latest observation, not a queued write's older request baseline.
    const nextConfig = preserveLocalChanges
      ? (mergeBaleConfigDelta(
          persistedConfig as Record<string, unknown>,
          config as Record<string, unknown>,
          merged as Record<string, unknown>,
        ) as BaleConfig)
      : cloneBaleConfig(merged);
    persistedConfig = cloneBaleConfig(merged);
    config = nextConfig;
  };
  const withPersistedPairingProfile = <T>(
    profileName: string,
    tokenSha256: string,
    observe: (latest: BaleConfig, profile: BaleBotProfile) => T,
  ): T => {
    if (
      (profileName !== BALE_DEFAULT_PROFILE_NAME &&
        !isValidBaleProfileName(profileName)) ||
      !/^[a-f0-9]{64}$/u.test(tokenSha256)
    ) {
      throw new Error("Invalid Bale pairing admission identity.");
    }
    return withBaleFileTransaction(`${configPath}.transaction`, () => {
      const latest = readBaleConfigForTransaction(configPath);
      const profile = latest.profiles?.[profileName];
      const resolvedToken =
        typeof profile?.botToken === "string"
          ? resolveBaleBotToken(profile.botToken, env)
          : undefined;
      if (
        !profile ||
        !resolvedToken ||
        createHash("sha256").update(resolvedToken).digest("hex") !==
          tokenSha256 ||
        (profile.allowedUserId !== undefined &&
          (!Number.isSafeInteger(profile.allowedUserId) ||
            profile.allowedUserId <= 0))
      ) {
        throw new Error(
          "Bale pairing admission authority is unavailable or changed.",
        );
      }
      return observe(latest, profile);
    });
  };
  return {
    get: getEffectiveConfig,
    getStoredConfig: () => config,
    set: setEffectiveConfig,
    setProfile: (profileName, profile) => {
      config = {
        ...omitBaleRootProfileFields(config),
        profiles: {
          ...(config.profiles ?? {}),
          [profileName]: cloneBaleConfig(profile),
        },
      };
      mutationVersion += 1;
    },
    update: (mutate) => {
      const nextConfig = getEffectiveConfig();
      mutate(nextConfig);
      setEffectiveConfig(nextConfig);
    },
    activateProfile: (profileName) => {
      const normalizedProfileName =
        !profileName || profileName === BALE_DEFAULT_PROFILE_NAME
          ? undefined
          : profileName;
      if (normalizedProfileName && !config.profiles?.[normalizedProfileName]) {
        return false;
      }
      activeProfileName = normalizedProfileName;
      return true;
    },
    getActiveProfileName: () => activeProfileName,
    getBotToken: () =>
      resolveBaleBotToken(getEffectiveConfig().botToken, env),
    getBotTokenDiagnostic: () =>
      getBaleBotTokenDiagnostic(getEffectiveConfig().botToken, env),
    hasBotToken: () =>
      !!resolveBaleBotToken(getEffectiveConfig().botToken, env),
    getAllowedUserId: () => getEffectiveConfig().allowedUserId,
    getLegacyPollingCursor: () =>
      (getEffectiveConfig() as BaleConfig & BaleLegacyCursorCarrier)
        .lastUpdateId,
    removeLegacyPollingCursor: () => {
      const next = {
        ...(getEffectiveConfig() as BaleConfig &
          BaleLegacyCursorCarrier),
      };
      delete next.lastUpdateId;
      setEffectiveConfig(next);
    },
    getInboundHandlers: () => [
      ...(config.inboundHandlers ?? []),
      ...(config.attachmentHandlers ?? []),
    ],
    getAttachmentHandlers: () => config.attachmentHandlers,
    getOutboundHandlers: () => config.outboundHandlers,
    setAllowedUserId: (userId) => {
      const nextConfig = getEffectiveConfig();
      nextConfig.allowedUserId = userId;
      setEffectiveConfig(nextConfig);
    },
    withPairingAdmission: (profileName, tokenSha256, publish) =>
      withPersistedPairingProfile(
        profileName,
        tokenSha256,
        (_latest, profile) => publish(profile.allowedUserId === undefined),
      ),
    withPairedUserAdmission: (
      profileName,
      tokenSha256,
      userId,
      publish,
      assertExecutionCurrent,
    ) => {
      if (!Number.isSafeInteger(userId) || userId <= 0)
        return { admitted: false };
      assertExecutionCurrent?.();
      return withPersistedPairingProfile(
        profileName,
        tokenSha256,
        (latest, profile) => {
          if (profile.allowedUserId !== userId) return { admitted: false };
          assertExecutionCurrent?.();
          const current = getEffectiveConfig();
          const previousOwner =
            persistedConfig.profiles?.[profileName]?.allowedUserId;
          if (
            (activeProfileName ?? BALE_DEFAULT_PROFILE_NAME) !==
              profileName ||
            current.botToken !== profile.botToken ||
            (current.allowedUserId !== undefined &&
              current.allowedUserId !== userId) ||
            (current.allowedUserId === undefined && previousOwner !== undefined)
          ) {
            throw new Error(
              "Bale paired admission lost local profile authority.",
            );
          }
          // Observation is not a local edit; queued persistence still adopts its own fresh disk result.
          adoptPersistedConfig(latest, true);
          return { admitted: true, value: publish() };
        },
      );
    },
    persistAllowedUserId: (userId, assertExecutionCurrent, commitIfOwned) => {
      const profileName = activeProfileName;
      const profileKey = profileName ?? BALE_DEFAULT_PROFILE_NAME;
      const botToken = getEffectiveConfig().botToken;
      const previousOwner = getEffectiveConfig().allowedUserId;
      const assertCurrent = () => {
        assertExecutionCurrent?.();
        if (
          activeProfileName !== profileName ||
          getEffectiveConfig().botToken !== botToken ||
          getEffectiveConfig().allowedUserId !== previousOwner
        ) {
          throw new Error(
            "Bale pairing lost its originating profile authority.",
          );
        }
      };
      const pairing = persistQueue.then(() => {
        assertCurrent();
        if (!Number.isSafeInteger(userId) || userId <= 0)
          throw new Error("Invalid Bale pairing user ID.");
        let merged: BaleConfig | undefined;
        const publish = () => {
          merged = withBaleFileTransaction(
            `${configPath}.transaction`,
            () => {
              const latest = readBaleConfigForTransaction(configPath);
              const profile = latest.profiles?.[profileKey];
              if (!botToken || profile?.botToken !== botToken) {
                throw new Error(
                  "Bale pairing profile is unavailable or changed.",
                );
              }
              assertCurrent();
              if (profile.allowedUserId !== undefined) return latest;
              const next = {
                ...latest,
                profiles: {
                  ...latest.profiles,
                  [profileKey]: { ...profile, allowedUserId: userId },
                },
              };
              writeBaleConfigInTransaction(agentDir, configPath, next);
              return next;
            },
          );
        };
        if (commitIfOwned) {
          if (!commitIfOwned(publish))
            throw new Error(
              "Bale pairing lost transport ownership before publication.",
            );
        } else {
          publish();
        }
        if (!merged)
          throw new Error("Bale pairing publication did not execute.");
        adoptPersistedConfig(merged, true);
        return merged.profiles?.[profileKey]?.allowedUserId === userId;
      });
      persistQueue = pairing.then(
        () => undefined,
        () => undefined,
      );
      return pairing;
    },
    load: async () => {
      lastLoadRecoveredInvalidConfig = false;
      const loadedConfig = await readBaleConfig(configPath, {
        onInvalidConfig: (recovery) => {
          lastLoadRecoveredInvalidConfig = true;
          options.recordRuntimeEvent?.("config", recovery.error, {
            phase: "load",
            configPath: recovery.configPath,
            recoveryPath: recovery.recoveryPath,
          });
        },
      });
      let normalized: ReturnType<typeof normalizeBaleDefaultProfileConfig>;
      try {
        normalized = normalizeBaleDefaultProfileConfig(loadedConfig);
      } catch (error) {
        options.recordRuntimeEvent?.("config", error, {
          phase: "default-profile-normalize",
          configPath,
        });
        throw error;
      }
      config = normalized.changed
        ? withBaleFileTransaction(`${configPath}.transaction`, () => {
            const latestConfig = readBaleConfigForTransaction(configPath);
            const latestNormalized =
              normalizeBaleDefaultProfileConfig(latestConfig);
            if (latestNormalized.changed) {
              writeBaleConfigInTransaction(
                agentDir,
                configPath,
                latestNormalized.config,
              );
            }
            return latestNormalized.config;
          })
        : normalized.config;
      persistedConfig = cloneBaleConfig(config);
      mutationVersion += 1;
    },
    didLastLoadRecoverInvalidConfig: () => lastLoadRecoveredInvalidConfig,
    persist: (nextConfig = getEffectiveConfig(), options) => {
      const profileName = activeProfileName;
      const desiredConfig = storeBaleEffectiveConfig(
        config,
        cloneBaleConfig(nextConfig),
        profileName,
      );
      const baseConfig = cloneBaleConfig(persistedConfig);
      const capturedMutationVersion = mutationVersion;
      const persist = persistQueue.then(() => {
        const mergedConfig = withBaleFileTransaction(
          `${configPath}.transaction`,
          () => {
            if (options?.isCurrent && !options.isCurrent()) {
              throw new Error(
                "Bale config update lost its originating authority.",
              );
            }
            const latestConfig = readBaleConfigForTransaction(configPath);
            const merged = mergeBaleConfigDelta(
              baseConfig as Record<string, unknown>,
              desiredConfig as Record<string, unknown>,
              latestConfig as Record<string, unknown>,
            ) as BaleConfig;
            if (!configValuesEqual(latestConfig, merged)) {
              writeBaleConfigInTransaction(agentDir, configPath, merged);
            }
            return merged;
          },
        );
        adoptPersistedConfig(
          mergedConfig,
          mutationVersion !== capturedMutationVersion,
        );
      });
      persistQueue = persist.catch(() => undefined);
      return persist;
    },
  };
}

function createBaleDraftPreviewsChecker(
  configStore: Pick<BaleConfigStore, "get">,
): () => boolean {
  return () => {
    const config = configStore.get();
    return (
      config.assistant?.draftPreviews ??
      config.draftPreviews ??
      config.richDraftPreviews ??
      false
    );
  };
}

function createBaleDraftPreviewsSetter(
  configStore: BaleMutableConfigStore,
): (enabled: boolean) => Promise<void> {
  return async (enabled) => {
    await loadLatestBaleConfig(configStore);
    const {
      draftPreviews: _legacyDraftPreviews,
      richDraftPreviews: _legacyRichDraftPreviews,
      ...current
    } = configStore.get();
    const config = {
      ...current,
      assistant: { ...current.assistant, draftPreviews: enabled },
    };
    configStore.set(config);
    await configStore.persist(config);
  };
}

function createBaleAssistantRenderingModeGetter(
  configStore: Pick<BaleConfigStore, "get">,
): () => BaleAssistantRenderingMode {
  return () => {
    const config = configStore.get();
    const mode = config.assistant?.rendering ?? config.assistantRendering;
    return mode === "rich" ? "rich" : "html";
  };
}

function createBaleAssistantRenderingModeSetter(
  configStore: BaleMutableConfigStore,
): (mode: BaleAssistantRenderingMode) => Promise<void> {
  return async (mode) => {
    await loadLatestBaleConfig(configStore);
    const { assistantRendering: _legacyAssistantRendering, ...current } =
      configStore.get();
    const config = {
      ...current,
      assistant: { ...current.assistant, rendering: mode },
    };
    configStore.set(config);
    await configStore.persist(config);
  };
}

function createBaleActivityVerbosityGetter(
  configStore: Pick<BaleConfigStore, "get">,
): () => BaleActivityVerbosity {
  return () => {
    const assistant = configStore.get().assistant;
    if (assistant?.activity !== undefined) {
      if (
        assistant.activity === "thinking" ||
        assistant.activity === "tools" ||
        assistant.activity === "verbose"
      ) {
        return assistant.activity;
      }
      return "quiet";
    }
    if (assistant?.activityVerbosity !== undefined) {
      return assistant.activityVerbosity === "verbose" ? "verbose" : "quiet";
    }
    return "quiet";
  };
}

function createBaleActivityVerbosityRefresher(
  configStore: BaleMutableConfigStore,
): () => Promise<void> {
  return () => loadLatestBaleConfig(configStore);
}

function createBaleActivityVerbositySetter(
  configStore: BaleMutableConfigStore,
): (verbosity: BaleActivityVerbosity) => Promise<void> {
  return async (verbosity) => {
    await loadLatestBaleConfig(configStore);
    const current = configStore.get();
    const { activityVerbosity: _legacyActivityVerbosity, ...assistant } =
      current.assistant ?? {};
    const config = {
      ...current,
      assistant: {
        ...assistant,
        activity: verbosity,
      },
    };
    configStore.set(config);
    await configStore.persist(config);
  };
}

export function createBaleVoiceReplyModeGetter(
  configStore: Pick<BaleConfigStore, "get">,
): () => "manual" | "mirror" | "always" {
  return () => {
    const mode = configStore.get().voice?.replyMode;
    return mode === "mirror" || mode === "always" ? mode : "manual";
  };
}

export function createBaleVoiceReplyModeConfiguredChecker(
  configStore: Pick<BaleConfigStore, "get">,
): () => boolean {
  return () => {
    const mode = configStore.get().voice?.replyMode;
    return mode === "mirror" || mode === "always";
  };
}

export function createBaleVoiceReplyModeSetter(
  configStore: BaleMutableConfigStore,
): (
  replyMode: "manual" | "hidden" | "mirror" | "always" | undefined,
) => Promise<void> {
  return async (replyMode) => {
    await loadLatestBaleConfig(configStore);
    const current = configStore.get();
    if (
      replyMode === undefined ||
      replyMode === "manual" ||
      replyMode === "hidden"
    ) {
      const { replyMode: _replyMode, ...remainingVoice } = current.voice ?? {};
      const next = { ...current };
      if (Object.keys(remainingVoice).length > 0) next.voice = remainingVoice;
      else delete next.voice;
      configStore.set(next);
      await configStore.persist(next);
      return;
    }
    const next = { ...current, voice: { ...(current.voice ?? {}), replyMode } };
    configStore.set(next);
    await configStore.persist(next);
  };
}

function getSystemTimezone(): string {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return tz && tz.length > 0 ? tz : "UTC";
  } catch {
    return "UTC";
  }
}

export function resolveBaleTimeConfig(
  raw: BaleTimeConfig | undefined,
  timeInjection: BaleTimeMode | undefined = undefined,
): ResolvedBaleTimeConfig {
  const injectionMode: BaleTimeMode =
    timeInjection === undefined
      ? "interval"
      : timeInjection === "always" || timeInjection === "interval"
        ? timeInjection
        : "hidden";
  const interval =
    typeof raw?.interval === "number" && raw.interval > 0
      ? raw.interval
      : 60 * 60 * 1000;
  const timezone = getSystemTimezone();
  return { injectionMode, interval, timezone };
}

export function createBaleTimeConfigGetter(
  configStore: Pick<BaleConfigStore, "get">,
): () => ResolvedBaleTimeConfig {
  return () => {
    const config = configStore.get();
    return resolveBaleTimeConfig(
      config.time,
      config.assistant?.timeInjection,
    );
  };
}

export function createBaleTimeInjectionModeGetter(
  configStore: Pick<BaleConfigStore, "get">,
): () => BaleTimeMode {
  return () => {
    const config = configStore.get();
    return resolveBaleTimeConfig(
      config.time,
      config.assistant?.timeInjection,
    ).injectionMode;
  };
}

export function createBaleTimeInjectionModeSetter(
  configStore: BaleMutableConfigStore,
): (injectionMode: BaleTimeMode) => Promise<void> {
  return async (injectionMode) => {
    await loadLatestBaleConfig(configStore);
    const current = configStore.get();
    const next = {
      ...current,
      assistant: {
        ...(current.assistant ?? {}),
        timeInjection: injectionMode,
      },
    };
    configStore.set(next);
    await configStore.persist(next);
  };
}

export interface BaleProactivePushTarget {
  chatId: number;
  threadId?: number;
}

export function createBaleProactivePushChatIdGetter(
  getTarget: () => BaleProactivePushTarget | undefined,
): () => number | undefined {
  return () => getTarget()?.chatId;
}

export function createBaleProactivePushTargetGetter(deps: {
  getActiveTurnTarget: () => BaleProactivePushTarget | undefined;
  getAssignedTarget: () => BaleProactivePushTarget | undefined;
  getAllowedUserId: () => number | undefined;
}): () => BaleProactivePushTarget | undefined {
  return () => {
    const activeTarget = deps.getActiveTurnTarget();
    if (activeTarget) return activeTarget;
    const assignedTarget = deps.getAssignedTarget();
    if (assignedTarget) return assignedTarget;
    const chatId = deps.getAllowedUserId();
    return typeof chatId === "number" ? { chatId } : undefined;
  };
}

function createBaleAutomaticThreadCleanupChecker(
  configStore: Pick<BaleConfigStore, "get">,
): () => boolean {
  return () => configStore.get().threads?.automaticCleanup ?? true;
}

function createBaleAutomaticThreadCleanupResolver(
  configStore: BaleMutableConfigStore,
): () => Promise<boolean> {
  return async () => {
    await loadLatestBaleConfig(configStore);
    if (configStore.didLastLoadRecoverInvalidConfig?.()) {
      throw new Error(
        "Thread cleanup setting is unavailable after invalid Bale config recovery.",
      );
    }
    return createBaleAutomaticThreadCleanupChecker(configStore)();
  };
}

function createBaleAutomaticThreadCleanupSetter(
  configStore: BaleMutableConfigStore,
): (enabled: boolean) => Promise<void> {
  return async (enabled) => {
    await loadLatestBaleConfig(configStore);
    const current = configStore.get();
    const config = {
      ...current,
      threads: { ...current.threads, automaticCleanup: enabled },
    };
    configStore.set(config);
    await configStore.persist(config);
  };
}

export function createBaleConfigControls(
  configStore: BaleMutableConfigStore,
) {
  return {
    areDraftPreviewsEnabled: createBaleDraftPreviewsChecker(configStore),
    setDraftPreviewsEnabled: createBaleDraftPreviewsSetter(configStore),
    getAssistantRenderingMode:
      createBaleAssistantRenderingModeGetter(configStore),
    setAssistantRenderingMode:
      createBaleAssistantRenderingModeSetter(configStore),
    getActivityVerbosity: createBaleActivityVerbosityGetter(configStore),
    refreshActivityVerbosity:
      createBaleActivityVerbosityRefresher(configStore),
    setActivityVerbosity: createBaleActivityVerbositySetter(configStore),
    getVoiceReplyMode: createBaleVoiceReplyModeGetter(configStore),
    isVoiceReplyModeConfigured:
      createBaleVoiceReplyModeConfiguredChecker(configStore),
    setVoiceReplyMode: createBaleVoiceReplyModeSetter(configStore),
    getTimeInjectionMode: createBaleTimeInjectionModeGetter(configStore),
    setTimeInjectionMode: createBaleTimeInjectionModeSetter(configStore),
    isAutomaticThreadCleanupEnabled:
      createBaleAutomaticThreadCleanupChecker(configStore),
    resolveAutomaticThreadCleanupEnabled:
      createBaleAutomaticThreadCleanupResolver(configStore),
    setAutomaticThreadCleanupEnabled:
      createBaleAutomaticThreadCleanupSetter(configStore),
  };
}

export type BaleAuthorizationState =
  { kind: "pair"; userId: number } | { kind: "allow" } | { kind: "deny" };

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
  pairIfNeeded: (
    userId: number,
    ctx: TContext,
    assertExecutionCurrent?: () => void,
  ) => Promise<boolean>;
}

export function getBaleAuthorizationState(
  userId: number,
  allowedUserId?: number,
): BaleAuthorizationState {
  if (allowedUserId === undefined) {
    return { kind: "pair", userId };
  }
  if (userId === allowedUserId) {
    return { kind: "allow" };
  }
  return { kind: "deny" };
}

export async function pairBaleUserIfNeeded<TContext>(
  userId: number,
  deps: BaleUserPairingDeps<TContext>,
): Promise<boolean> {
  const authorization = getBaleAuthorizationState(
    userId,
    deps.allowedUserId,
  );
  if (authorization.kind !== "pair") return authorization.kind === "allow";
  deps.assertExecutionCurrent?.();
  const allowed = await deps.persistAllowedUserId(
    authorization.userId,
    deps.assertExecutionCurrent,
  );
  deps.assertExecutionCurrent?.();
  if (!allowed) return false;
  try {
    deps.updateStatus(deps.ctx);
  } catch (error) {
    if (!isPiStaleContextError(error)) throw error;
  }
  return true;
}

export function createBaleUserPairingRuntime<TContext>(
  deps: BaleUserPairingRuntimeDeps<TContext>,
): BaleUserPairingRuntime<TContext> {
  return {
    pairIfNeeded: (userId, ctx, assertExecutionCurrent) =>
      pairBaleUserIfNeeded(userId, {
        allowedUserId: deps.getAllowedUserId(),
        ctx,
        persistAllowedUserId: deps.persistAllowedUserId,
        updateStatus: deps.updateStatus,
        assertExecutionCurrent,
      }),
  };
}

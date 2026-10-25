/**
 * Bale status rendering helpers
 * Zones: bale ui, pi agent diagnostics, tui
 * Owns status summaries, redacted diagnostics, projection lifecycle and compact connection-failure copy
 * Excludes canonical state, transport admission and filesystem policy
 */

import { isDeepStrictEqual } from "node:util";

/** UI copy is allowlisted; raw exception text belongs only in redacted diagnostics. */
export function formatBaleConnectionFailure(error: unknown): string {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "";
  const status =
    error && typeof error === "object" && "status" in error
      ? error.status
      : undefined;
  const code =
    error && typeof error === "object" && "code" in error
      ? error.code
      : undefined;
  if (status === 401) return "Bale token rejected. Run /bale-setup.";
  if (status === 403)
    return "Bale access denied. Check /bale-status --debug.";
  if (
    (typeof code === "string" &&
      ["ECONNREFUSED", "ETIMEDOUT", "ENOTFOUND", "ECONNRESET"].includes(
        code,
      )) ||
    /network unavailable|fetch failed/i.test(message)
  ) {
    return "Bale network unavailable. Retry /bale-connect.";
  }
  if (
    /Workspace slots?.*(?:unavailable|exhausted)|no free.*slot/i.test(message)
  ) {
    return "No Bale slot available. Check /bale-status --debug.";
  }
  if (
    code === "incompatible-protocol" ||
    /protocol.*(?:incompatible|mismatch)|incompatible.*protocol/i.test(message)
  ) {
    return "Bale instances are incompatible. Update them together.";
  }
  if (
    /unsupported.*(?:journal|version)|(?:journal|version).*unsupported/i.test(
      message,
    )
  ) {
    return "Bale state version unsupported. Use a compatible runtime.";
  }
  if (
    /follower registration failed|active in another Pi instance/i.test(message)
  ) {
    return "Bale leader is active but unavailable. Check /bale-status --debug.";
  }
  if (/unfinished Thread creation does not match/i.test(message)) {
    return "Bale Thread creation is unresolved. Check /bale-status --debug.";
  }
  return "Bale connection failed. Check /bale-status --debug.";
}

const BALE_STATUS_DEFAULT_PROFILE_NAME = "default";

export type BaleStatusQueueLane = "control" | "steer" | "priority" | "default";

export interface BaleUsageStats {
  totalInput: number;
  totalOutput: number;
  totalCacheRead: number;
  totalCacheWrite: number;
  totalCost: number;
  latestCacheHitRate?: number;
}

interface BaleUsageMessage {
  role: string;
  usage?: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    cost: { total: number };
  };
}

interface BaleStatusSessionEntry {
  type: string;
  message?: BaleUsageMessage;
}

interface BaleContextUsage {
  contextWindow?: number;
  percent: number | null;
}

export interface BaleStatusActiveModel {
  provider?: string;
  id?: string;
  contextWindow?: number;
}

export interface BaleStatusLineProviderContext {
  activeModel: BaleStatusActiveModel | undefined;
}

export interface BaleStatusLineProviderResult {
  label: string;
  value: string;
}

export type BaleStatusLineProvider = (
  ctx: BaleStatusLineProviderContext,
) => BaleStatusLineProviderResult | undefined;

export interface BaleStatusContext {
  sessionManager: { getEntries(): BaleStatusSessionEntry[] };
  getContextUsage(): BaleContextUsage | undefined;
  isIdle?: () => boolean;
  hasPendingMessages?: () => boolean;
  isCompactionInProgress?: () => boolean;
  modelRegistry: {
    isUsingOAuth(model: BaleStatusActiveModel): boolean;
  };
}

export type BaleRuntimeEventDetailValue = string | number | boolean | null;

const BALE_STATUS_LINE_PROVIDER_REGISTRY_KEY =
  "__piBaleStatusLineProviders__";
const MAX_RECENT_BALE_RUNTIME_EVENTS = 10;
const MAX_BALE_RUNTIME_EVENT_MESSAGE_LENGTH = 1000;
const MAX_BALE_RUNTIME_EVENT_DETAIL_LENGTH = 1000;

export interface BaleRuntimeEvent {
  at: number;
  category: string;
  message: string;
  details?: Record<string, BaleRuntimeEventDetailValue>;
}

export interface BaleRuntimeEventInput {
  category: string;
  error?: unknown;
  message?: string;
  details?: Record<string, unknown>;
}

export interface BaleRuntimeEventRecorder {
  record: (
    category: string,
    error: unknown,
    details?: Record<string, unknown>,
  ) => void;
  getEvents: () => BaleRuntimeEvent[];
  clear: () => void;
}

export interface BaleRuntimeEventRecorderOptions {
  getBotToken: () => string | undefined;
  maxEvents?: number;
  now?: () => number;
}

export interface BaleBridgeStatusBusFollower {
  instanceId: string;
  cwd?: string;
  lastHeartbeatMs: number;
  target?: { chatId: number; threadId?: number };
  protocol?: {
    protocolVersion: number;
    runtimeBuild: string;
    capabilities: string[];
  };
  slot?: string;
  threadName?: string;
  status?: string;
}

export interface BaleBridgeStatusLocalBus {
  leaderSocketPath?: string;
  leaderTransport?: "pipe" | "socket";
  followerSocketPath?: string;
  followerTransport?: "pipe" | "socket";
  followerRegistered?: boolean;
  followerTarget?: { chatId: number; threadId?: number };
  followerSlot?: string;
  followerThreadName?: string;
  leaderProtocol?: {
    protocolVersion: number;
    runtimeBuild: string;
    capabilities: string[];
  };
}

export interface BaleBridgeStatusTopicTarget {
  instanceId?: string;
  status?: string;
  target?: { chatId: number; threadId?: number };
  slot?: string;
  threadName?: string;
  syncStatus?: string;
  lastSyncObservedAtMs?: number;
  lastSyncProbeAtMs?: number;
  lastSyncError?: string;
  lastReconcileAction?: string;
}

export interface BaleBridgeStatusThreadReservation {
  target?: { chatId: number; threadId?: number };
  slot?: string;
  reason?: string;
  instanceId?: string;
  expiresAtMs?: number;
  lastReconcileAction?: string;
}

export interface BaleBridgeStatusSyncObservation {
  target?: { chatId: number; threadId?: number };
  syncStatus: string;
  observedAtMs: number;
  instanceId?: string;
  slot?: string;
  lastSyncError?: string;
  lastReconcileAction?: string;
}

export interface BaleBridgeStatusSyncSlice {
  status: string;
  updatedAtMs?: number;
  suspectAtMs?: number;
  reason?: string;
  lastReconcileAction?: string;
}

export interface BaleBridgeThreadReconciliationState {
  phase: string;
  event: string;
  atMs: number;
  leaderEpoch?: number | string;
  pendingProvisionCount: number;
  syncActionCount: number;
  cleanupActionCount: number;
}

export type BaleBridgeBusRole = "leader" | "follower";
export type BaleBridgeBusLifecyclePhase = "electing";

export interface BaleBridgePollingState {
  phase: string;
  phaseStartedAtMs?: number;
  currentUpdateId?: number;
  startedAtMs?: number;
  stoppedAtMs?: number;
  lastSuccessfulResponseAtMs?: number;
  lastSuccessfulResponseUpdateCount?: number;
  stopReason?: string;
}

export interface BaleBridgeInboundWorkerState {
  phase: string;
  generation: number;
  phaseStartedAtMs?: number;
  currentUpdateId?: number;
  blockedReason?: string;
  blockedInputCustody?: { updateId: number; kind: string };
  journalEntryCount: number;
  journalSerializedBytes: number;
  oldestAdmittedAtMs?: number;
  deferredClaimCount: number;
  queuedClaimCount: number;
  foreignQueuedCount: number;
  foreignQueuedOwnerLiveness?: "alive" | "dead" | "unverifiable";
  foreignQueuedOwner?: {
    instanceId: string;
    processId: number;
    processBirthId: string;
    sessionGeneration: number;
    acquisitionId: string;
    acquiredAtMs: number;
  };
  retryWaitCount: number;
  failedCount: number;
  nextRetryUpdateId?: number;
  nextRetryAtMs?: number;
  nextRetryAttemptCount?: number;
  nextRetryFailureClass?: string;
  failedUpdateId?: number;
  failedFailureId?: string;
  failedAttemptCount?: number;
  failedClass?: string;
  failedSummary?: string;
  terminalFailureAtMs?: number;
  unsettledExecutionCount: number;
  lastCompletedUpdateId?: number;
  lastCompletedAtMs?: number;
  lastFailureAtMs?: number;
  lastFailurePhase?: string;
}

export interface BaleBridgeStatusLineState {
  hasBotToken?: boolean;
  botUsername?: string;
  /** Redacted named-variable diagnostic when the stored token reference cannot resolve. */
  botTokenDiagnostic?: string;
  activeProfileName?: string;
  diagnosticPaths?: { state: string; logs: string };
  allowedUserId?: number;
  botThreadMode?: "unknown" | "enabled" | "disabled";
  botThreadModeUpdatedAtMs?: number;
  botThreadModeAction?: string;
  busRole?: BaleBridgeBusRole;
  busProtocol?: {
    protocolVersion: number;
    runtimeBuild: string;
    capabilities: string[];
  };
  busLifecyclePhase?: BaleBridgeBusLifecyclePhase;
  instanceSlot?: string;
  instanceThreadName?: string;
  lockState?: string;
  pollingActive: boolean;
  polling?: BaleBridgePollingState;
  inboundWorker?: BaleBridgeInboundWorkerState;
  lastUpdateId?: number;
  activeSourceMessageIds?: number[];
  pendingDispatch: boolean;
  compactionInProgress: boolean;
  activeToolExecutions: number;
  pendingModelSwitch: boolean;
  queuedItems: Array<{ queueLane: BaleStatusQueueLane }>;
  busFollowers?: BaleBridgeStatusBusFollower[];
  localBus?: BaleBridgeStatusLocalBus;
  topicTargets?: BaleBridgeStatusTopicTarget[];
  threadReservations?: BaleBridgeStatusThreadReservation[];
  topicSyncObservations?: BaleBridgeStatusSyncObservation[];
  syncState?: Record<string, BaleBridgeStatusSyncSlice | undefined>;
  threadReconciliation?: BaleBridgeThreadReconciliationState;
  busNowMs?: number;
  recentRuntimeEvents: BaleRuntimeEvent[];
}

export interface BaleStatusBarTheme {
  fg: (
    token: "accent" | "dim" | "error" | "muted" | "warning" | "success",
    text: string,
  ) => string;
}

export interface BaleStatusBarState {
  hasBotToken: boolean;
  pollingActive: boolean;
  pollingStopReason?: string;
  paired: boolean;
  busRole?: BaleBridgeBusRole;
  followerRegistered?: boolean;
  busLifecyclePhase?: BaleBridgeBusLifecyclePhase;
  instanceSlot?: string;
  instanceThreadName?: string;
  compactionInProgress: boolean;
  processing: boolean;
  processingStatus?: string;
  queuedStatus: string;
  error?: string;
}

export interface BaleStatusRuntimeContext {
  ui: {
    theme: BaleStatusBarTheme;
    setStatus: (key: string, text: string) => void;
  };
}

export interface BaleStatusRuntimeDeps<
  TContext extends BaleStatusRuntimeContext,
> {
  statusKey?: string;
  getStatusBarState: (ctx: TContext, error?: string) => BaleStatusBarState;
  getBridgeStatusLineState: () => BaleBridgeStatusLineState;
}

export interface BaleBridgeStatusConfig {
  botToken?: string;
  /** Caller-resolved token availability; falls back to raw presence. */
  botHasToken?: boolean;
  /** Caller-supplied redacted diagnostic for an unresolved token reference. */
  botTokenDiagnostic?: string;
  botUsername?: string;
  allowedUserId?: number;
}

/** Narrow config-store view used to project resolved bot-token availability. */
export interface BaleBridgeStatusConfigSource {
  get: () => BaleBridgeStatusConfig;
  hasBotToken?: () => boolean;
  getBotTokenDiagnostic?: () => string | undefined;
}

/**
 * Project a config store into the status view without moving token-reference
 * resolution into this structural leaf domain.
 */
export function createBaleBridgeStatusConfigGetter(
  source: BaleBridgeStatusConfigSource,
): () => BaleBridgeStatusConfig {
  return () => {
    const config = source.get();
    return {
      ...config,
      ...(source.hasBotToken ? { botHasToken: source.hasBotToken() } : {}),
      ...(source.getBotTokenDiagnostic
        ? { botTokenDiagnostic: source.getBotTokenDiagnostic() }
        : {}),
    };
  };
}

export interface BaleBridgeStatusRuntimeDeps<
  TQueueItem extends { queueLane: BaleStatusQueueLane },
> {
  statusKey?: string;
  getConfig: () => BaleBridgeStatusConfig;
  getActiveProfileName?: () => string | undefined;
  getDiagnosticPaths?: (profileName?: string) => {
    state: string;
    logs: string;
  };
  isPollingActive: () => boolean;
  getPollingState?: () => BaleBridgePollingState;
  getInboundWorkerState?: () => BaleBridgeInboundWorkerState | undefined;
  getAcceptedThroughUpdateId?: () => number | undefined;
  getActiveSourceMessageIds: () => number[] | undefined;
  hasActiveTurn: () => boolean;
  hasDispatchPending: () => boolean;
  isCompactionInProgress: () => boolean;
  getActiveToolExecutions: () => number;
  hasPendingModelSwitch: () => boolean;
  getQueuedItems: () => TQueueItem[];
  getQueuedItemCount?: (items: TQueueItem[]) => number;
  getRecentRuntimeEvents: () => BaleRuntimeEvent[];
  getRuntimeLockState?: () => string;
  getBusRole?: () => BaleBridgeBusRole | undefined;
  getBusProtocol?: () => {
    protocolVersion: number;
    runtimeBuild: string;
    capabilities: string[];
  };
  getBusLifecyclePhase?: () => BaleBridgeBusLifecyclePhase | undefined;
  getBotThreadMode?: () =>
    | {
        threadMode: "unknown" | "enabled" | "disabled";
        updatedAtMs?: number;
        lastReconcileAction?: string;
      }
    | undefined;
  getBusFollowers?: () => BaleBridgeStatusBusFollower[];
  getLocalBus?: () => BaleBridgeStatusLocalBus | undefined;
  getTopicTargets?: () => BaleBridgeStatusTopicTarget[];
  getThreadReservations?: () => BaleBridgeStatusThreadReservation[];
  getTopicSyncObservations?: () => BaleBridgeStatusSyncObservation[];
  getSyncState?: () => Record<
    string,
    BaleBridgeStatusSyncSlice | undefined
  >;
  getThreadReconciliationState?: () =>
    BaleBridgeThreadReconciliationState | undefined;
  getInstanceSlot?: () => string | undefined;
  getInstanceThreadName?: () => string | undefined;
  getNowMs?: () => number;
}

export interface BaleBridgeStatusLineOptions {
  verbose?: boolean;
}

export interface BaleStatusRuntime<
  TContext extends BaleStatusRuntimeContext,
> {
  updateStatus: (ctx: TContext, error?: string) => void;
  getStatusLines: (options?: BaleBridgeStatusLineOptions) => string[];
  getStatusState: () => BaleBridgeStatusLineState;
}

function truncateBaleRuntimeEventText(
  text: string,
  maxLength: number,
): string {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength).trimEnd()}… [truncated ${text.length - maxLength} chars]`;
}

function redactBaleRuntimeText(
  text: string,
  botToken: string | undefined,
  maxLength: number,
): string {
  const redacted = botToken
    ? text.split(botToken).join("<redacted-token>")
    : text;
  return truncateBaleRuntimeEventText(redacted, maxLength);
}

function normalizeBaleRuntimeEventDetails(
  details: Record<string, unknown> | undefined,
  botToken: string | undefined,
): Record<string, BaleRuntimeEventDetailValue> | undefined {
  if (!details) return undefined;
  const normalized: Record<string, BaleRuntimeEventDetailValue> = {};
  for (const [key, value] of Object.entries(details)) {
    if (value === undefined) continue;
    if (typeof value === "string") {
      normalized[key] = redactBaleRuntimeText(
        value,
        botToken,
        MAX_BALE_RUNTIME_EVENT_DETAIL_LENGTH,
      );
      continue;
    }
    if (typeof value === "number" || typeof value === "boolean") {
      normalized[key] = value;
      continue;
    }
    if (value === null) {
      normalized[key] = null;
      continue;
    }
    normalized[key] = redactBaleRuntimeText(
      String(value),
      botToken,
      MAX_BALE_RUNTIME_EVENT_DETAIL_LENGTH,
    );
  }
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function getBaleRuntimeEventMessage(
  input: BaleRuntimeEventInput,
): string {
  if (input.message !== undefined) return input.message;
  if (input.error instanceof Error) return input.error.message;
  return String(input.error);
}

export function recordStructuredBaleRuntimeEvent(
  events: BaleRuntimeEvent[],
  input: BaleRuntimeEventInput,
  options: { botToken?: string; maxEvents: number; now?: number },
): void {
  const details = normalizeBaleRuntimeEventDetails(
    input.details,
    options.botToken,
  );
  events.push({
    at: options.now ?? Date.now(),
    category: input.category,
    message: redactBaleRuntimeText(
      getBaleRuntimeEventMessage(input),
      options.botToken,
      MAX_BALE_RUNTIME_EVENT_MESSAGE_LENGTH,
    ),
    ...(details ? { details } : {}),
  });
  while (events.length > options.maxEvents) {
    events.shift();
  }
}

function getOrCreateBaleStatusLineProviderRegistry(): Map<
  string,
  BaleStatusLineProvider
> {
  const existing = (globalThis as Record<string, unknown>)[
    BALE_STATUS_LINE_PROVIDER_REGISTRY_KEY
  ];
  if (existing instanceof Map)
    return existing as Map<string, BaleStatusLineProvider>;
  const registry = new Map<string, BaleStatusLineProvider>();
  (globalThis as Record<string, unknown>)[
    BALE_STATUS_LINE_PROVIDER_REGISTRY_KEY
  ] = registry;
  return registry;
}

/**
 * Register a compact extension-provided line for the Bale status menu.
 *
 * Providers are synchronous and should return undefined when their line is not
 * relevant for the active model. Errors are isolated so optional extension
 * status cannot break the core Bale menu.
 */
export function registerBaleStatusLineProvider(
  provider: BaleStatusLineProvider,
  options: { id: string },
): () => void {
  const registry = getOrCreateBaleStatusLineProviderRegistry();
  registry.set(options.id, provider);
  return () => {
    if (registry.get(options.id) === provider) registry.delete(options.id);
  };
}

function getBaleStatusLineProviderResults(
  ctx: BaleStatusLineProviderContext,
): BaleStatusLineProviderResult[] {
  const results: BaleStatusLineProviderResult[] = [];
  const registry = getOrCreateBaleStatusLineProviderRegistry();
  for (const provider of registry.values()) {
    try {
      const result = provider(ctx);
      if (!result?.label || !result.value) continue;
      results.push(result);
    } catch {
      continue;
    }
  }
  return results;
}

export function clearBaleStatusLineProviders(): void {
  getOrCreateBaleStatusLineProviderRegistry().clear();
}

export function createBaleRuntimeEventRecorder(
  options: BaleRuntimeEventRecorderOptions,
): BaleRuntimeEventRecorder {
  const events: BaleRuntimeEvent[] = [];
  return {
    record: (category, error, details) => {
      recordStructuredBaleRuntimeEvent(
        events,
        { category, error, details },
        {
          botToken: options.getBotToken(),
          maxEvents: options.maxEvents ?? MAX_RECENT_BALE_RUNTIME_EVENTS,
          now: options.now?.(),
        },
      );
    },
    getEvents: () => events,
    clear: () => {
      events.length = 0;
    },
  };
}

function formatBaleRuntimeEventCategory(
  event: BaleRuntimeEvent,
): string {
  const method = event.details?.method;
  return typeof method === "string"
    ? `${event.category}:${method}`
    : event.category;
}

function formatBaleRuntimeEventDetails(
  event: BaleRuntimeEvent,
): string {
  if (!event.details) return "";
  const details = Object.entries(event.details)
    .filter(([key]) => key !== "method")
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`);
  return details.length > 0 ? ` (${details.join(", ")})` : "";
}

function formatBaleRuntimeEventSummary(
  event: BaleRuntimeEvent,
): string {
  return `${formatBaleRuntimeEventCategory(event)}: ${event.message}${formatBaleRuntimeEventDetails(event)}`;
}

function formatBaleRuntimeEvent(event: BaleRuntimeEvent): string {
  return `${new Date(event.at).toISOString()} ${formatBaleRuntimeEventSummary(event)}`;
}

function buildBaleRuntimeEventSummary(
  events: BaleRuntimeEvent[],
): string {
  const counts = new Map<string, number>();
  for (const event of events) {
    const category = formatBaleRuntimeEventCategory(event);
    counts.set(category, (counts.get(category) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([category, count]) => `${category}=${count}`)
    .join(", ");
}

export function buildBaleRuntimeEventLines(
  events: BaleRuntimeEvent[],
): string[] {
  if (events.length === 0) return ["recent runtime events: none"];
  return [
    "recent runtime events:",
    `- summary: ${buildBaleRuntimeEventSummary(events)}`,
    ...events
      .slice()
      .reverse()
      .map((event) => `- ${formatBaleRuntimeEvent(event)}`),
  ];
}

export function createBaleStatusHtmlBuilder<TContext>(deps: {
  getActiveModel: (ctx: TContext) => BaleStatusActiveModel | undefined;
  isCompactionInProgress?: () => boolean;
  getBridgeStatusLineState?: () => BaleBridgeStatusLineState;
}): (ctx: TContext & BaleStatusContext) => string {
  return (ctx) =>
    buildStatusHtml(
      { ...ctx, isCompactionInProgress: deps.isCompactionInProgress },
      deps.getActiveModel(ctx),
      deps.getBridgeStatusLineState?.(),
    );
}

function resolveStatusBarTheme(
  ctx: BaleStatusRuntimeContext,
): BaleStatusBarTheme | undefined {
  try {
    const theme = ctx.ui?.theme;
    return typeof theme?.fg === "function" ? theme : undefined;
  } catch {
    return undefined;
  }
}

export function createBaleStatusRuntime<
  TContext extends BaleStatusRuntimeContext,
>(deps: BaleStatusRuntimeDeps<TContext>): BaleStatusRuntime<TContext> {
  const statusKey = deps.statusKey ?? "bale";
  return {
    updateStatus: (ctx, error) => {
      const theme = resolveStatusBarTheme(ctx);
      if (!theme) return;
      ctx.ui.setStatus(
        statusKey,
        buildBaleStatusBarText(theme, deps.getStatusBarState(ctx, error)),
      );
    },
    getStatusLines: (options) =>
      buildBaleBridgeStatusLines(deps.getBridgeStatusLineState(), options),
    getStatusState: deps.getBridgeStatusLineState,
  };
}

export function createBaleBridgeStatusRuntime<
  TContext extends BaleStatusRuntimeContext,
  TQueueItem extends { queueLane: BaleStatusQueueLane },
>(
  deps: BaleBridgeStatusRuntimeDeps<TQueueItem>,
): BaleStatusRuntime<TContext> {
  return createBaleStatusRuntime({
    statusKey: deps.statusKey,
    getStatusBarState: (_ctx, error) => {
      const config = deps.getConfig();
      const queuedItems = deps.getQueuedItems();
      const hasPendingDispatch = deps.hasDispatchPending();
      const waitingItems = hasPendingDispatch
        ? queuedItems.slice(1)
        : queuedItems;
      const queuedItemCount =
        deps.getQueuedItemCount?.(waitingItems) ?? waitingItems.length;
      const hasActiveTurn = deps.hasActiveTurn();
      const hasPendingModelSwitch = deps.hasPendingModelSwitch();
      const activeToolExecutions = deps.getActiveToolExecutions();
      const compactionInProgress = deps.isCompactionInProgress();
      const localBus = deps.getLocalBus?.();
      return {
        hasBotToken: config.botHasToken ?? Boolean(config.botToken),
        pollingActive: deps.isPollingActive(),
        paired: !!config.allowedUserId,
        busRole: deps.getBusRole?.(),
        followerRegistered: localBus?.followerRegistered,
        busLifecyclePhase: deps.getBusLifecyclePhase?.(),
        instanceSlot: deps.getInstanceSlot?.(),
        instanceThreadName: deps.getInstanceThreadName?.(),
        compactionInProgress,
        processing:
          hasActiveTurn ||
          hasPendingDispatch ||
          hasPendingModelSwitch ||
          activeToolExecutions > 0 ||
          queuedItemCount > 0,
        processingStatus: getBaleStatusBarProcessingStatus({
          hasActiveTurn,
          hasPendingDispatch,
          hasPendingModelSwitch,
          activeToolExecutions,
          queuedItems: queuedItemCount,
        }),
        queuedStatus: queuedItemCount > 0 ? ` +${queuedItemCount}` : "",
        pollingStopReason: deps.getPollingState?.().stopReason,
        error,
      };
    },
    getBridgeStatusLineState: () => {
      const config = deps.getConfig();
      const botThreadMode = deps.getBotThreadMode?.();
      const activeProfileName = deps.getActiveProfileName
        ? (deps.getActiveProfileName() ?? BALE_STATUS_DEFAULT_PROFILE_NAME)
        : undefined;
      return {
        hasBotToken: config.botHasToken ?? Boolean(config.botToken),
        botUsername: config.botUsername,
        botTokenDiagnostic: config.botTokenDiagnostic,
        activeProfileName,
        diagnosticPaths: deps.getDiagnosticPaths?.(activeProfileName),
        allowedUserId: config.allowedUserId,
        botThreadMode: botThreadMode?.threadMode,
        botThreadModeUpdatedAtMs: botThreadMode?.updatedAtMs,
        botThreadModeAction: botThreadMode?.lastReconcileAction,
        busRole: deps.getBusRole?.(),
        busProtocol: deps.getBusProtocol?.(),
        busLifecyclePhase: deps.getBusLifecyclePhase?.(),
        instanceSlot: deps.getInstanceSlot?.(),
        instanceThreadName: deps.getInstanceThreadName?.(),
        lockState: deps.getRuntimeLockState?.(),
        pollingActive: deps.isPollingActive(),
        ...(deps.getPollingState ? { polling: deps.getPollingState() } : {}),
        ...(deps.getInboundWorkerState
          ? { inboundWorker: deps.getInboundWorkerState() }
          : {}),
        lastUpdateId: deps.getAcceptedThroughUpdateId?.(),
        activeSourceMessageIds: deps.getActiveSourceMessageIds(),
        pendingDispatch: deps.hasDispatchPending(),
        compactionInProgress: deps.isCompactionInProgress(),
        activeToolExecutions: deps.getActiveToolExecutions(),
        pendingModelSwitch: deps.hasPendingModelSwitch(),
        queuedItems: deps.getQueuedItems(),
        busFollowers: deps.getBusFollowers?.(),
        localBus: deps.getLocalBus?.(),
        topicTargets: deps.getTopicTargets?.(),
        threadReservations: deps.getThreadReservations?.(),
        topicSyncObservations: deps.getTopicSyncObservations?.(),
        syncState: deps.getSyncState?.(),
        threadReconciliation: deps.getThreadReconciliationState?.(),
        busNowMs: deps.getNowMs?.(),
        recentRuntimeEvents: deps.getRecentRuntimeEvents(),
      };
    },
  });
}

export interface BaleRuntimeLogScope extends Record<string, unknown> {
  instanceId: string;
  role: string;
  slot?: string;
  threadName?: string;
  lockState?: string;
}

export function createBaleRuntimeLogScope(input: {
  state: BaleBridgeStatusLineState;
  instanceId: string;
}): BaleRuntimeLogScope {
  return {
    instanceId: input.instanceId,
    role: input.state.busRole ?? "classic-or-disconnected",
    slot: input.state.instanceSlot,
    threadName: input.state.instanceThreadName,
    lockState: input.state.lockState,
  };
}

export interface BaleStatusSnapshot {
  runtime: Record<string, unknown>;
  liveRoster: Record<string, unknown>;
  diagnostics: Record<string, unknown>;
}
export interface BaleStoredRuntimeProjection extends BaleStatusSnapshot {
  version: 1;
  source: "snapshot";
  writtenAtMs: number;
}
export function createBaleStatusSnapshot(
  state: BaleBridgeStatusLineState,
): BaleStatusSnapshot {
  return {
    runtime: {
      busRole: state.busRole,
      ...(state.busLifecyclePhase
        ? { busLifecyclePhase: state.busLifecyclePhase }
        : {}),
      botThreadMode: state.botThreadMode,
      botThreadModeUpdatedAtMs: state.botThreadModeUpdatedAtMs,
      botThreadModeAction: state.botThreadModeAction,
      instanceSlot: state.instanceSlot,
      instanceThreadName: state.instanceThreadName,
      pollingActive: state.pollingActive,
      ...(state.polling ? { polling: state.polling } : {}),
      lockState: state.lockState,
    },
    liveRoster: {
      busFollowers: state.busFollowers ?? [],
      ...(state.localBus ? { localBus: state.localBus } : {}),
      topicTargets: state.topicTargets ?? [],
      reservations: state.threadReservations ?? [],
    },
    diagnostics: {
      pendingDispatch: state.pendingDispatch,
      compactionInProgress: state.compactionInProgress,
      activeToolExecutions: state.activeToolExecutions,
      pendingModelSwitch: state.pendingModelSwitch,
      syncState: state.syncState,
      threadReconciliation: state.threadReconciliation,
      recentRuntimeEvents: state.recentRuntimeEvents,
    },
  };
}

function isRuntimeProjection(
  value: unknown,
): value is BaleStoredRuntimeProjection {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    record.version === 1 &&
    record.source === "snapshot" &&
    Number.isSafeInteger(record.writtenAtMs) &&
    (record.writtenAtMs as number) >= 0 &&
    Object.keys(record).every((key) =>
      [
        "version",
        "source",
        "writtenAtMs",
        "runtime",
        "liveRoster",
        "diagnostics",
      ].includes(key),
    ) &&
    ["runtime", "liveRoster", "diagnostics"].every(
      (key) =>
        record[key] !== null &&
        typeof record[key] === "object" &&
        !Array.isArray(record[key]),
    )
  );
}
export interface BaleRuntimeProjectionScope {
  path: string;
  profile: string;
}
export interface BaleRuntimeProjectionStorage {
  read: (scope: BaleRuntimeProjectionScope) => unknown;
  /** The adapter must enforce exact owner plus the supplied physical/logical scope in one transaction. */
  publish: (
    scope: BaleRuntimeProjectionScope,
    mutate: (current: unknown) => { value: unknown; changed: boolean },
    isCurrent: () => boolean,
  ) => boolean;
}
export interface BaleRuntimeProjectionStoreOptions {
  getPath: () => string;
  getProfile: () => string | undefined;
  /** Capture exact owner/context/session authority at submission, never renew it after the queued await. */
  captureAuthority: () => (() => boolean) | undefined;
  storage: BaleRuntimeProjectionStorage;
  getNowMs?: () => number;
}
/** Observational runtime storage only; Workspace, admission, transport, logs and recovery remain with their owners. */
export function createBaleRuntimeProjectionStore(
  options: BaleRuntimeProjectionStoreOptions,
): {
  read: () => BaleStoredRuntimeProjection | undefined;
  persist: (snapshot: BaleStatusSnapshot) => Promise<boolean>;
} {
  let publicationQueue = Promise.resolve();
  const { getPath, getProfile: readProfile, captureAuthority } = options;
  const { read, publish } = options.storage;
  const getNowMs = options.getNowMs ?? Date.now;
  const getProfile = (): string =>
    readProfile() || BALE_STATUS_DEFAULT_PROFILE_NAME;
  return {
    read() {
      try {
        const path = getPath(),
          profile = getProfile(),
          value = read({ path, profile });
        return getPath() === path &&
          getProfile() === profile &&
          isRuntimeProjection(value)
          ? value
          : undefined;
      } catch {
        return undefined;
      }
    },
    async persist(snapshot) {
      const path = getPath(),
        profile = getProfile(),
        authority = captureAuthority();
      if (!authority) return false;
      // Freeze wire content at submission, but do not duplicate the event log in persistent runtime state.
      const semantic = JSON.parse(
        JSON.stringify({
          version: 1,
          source: "snapshot",
          runtime: snapshot.runtime,
          liveRoster: snapshot.liveRoster,
          diagnostics: snapshot.diagnostics,
        }),
      ) as Omit<BaleStoredRuntimeProjection, "writtenAtMs">;
      if (!isRuntimeProjection({ ...semantic, writtenAtMs: 0 }))
        throw new Error("Bale runtime projection is malformed.");
      delete semantic.diagnostics.recentRuntimeEvents;
      // Poll-cycle timestamps change on every response; live status renders them from memory,
      // so persisting them would rewrite state.json each poll for no reader.
      const polling = semantic.runtime.polling;
      if (polling && typeof polling === "object" && !Array.isArray(polling)) {
        const volatile = polling as Record<string, unknown>;
        delete volatile.phaseStartedAtMs;
        delete volatile.lastSuccessfulResponseAtMs;
        delete volatile.lastSuccessfulResponseUpdateCount;
      }
      const isCurrent = (): boolean =>
        getPath() === path && getProfile() === profile && authority() === true;
      const isUnchanged = (
        current: unknown,
      ): current is BaleStoredRuntimeProjection => {
        if (!isRuntimeProjection(current)) return false;
        const { writtenAtMs: _writtenAtMs, ...existing } = current;
        return isDeepStrictEqual(existing, semantic);
      };
      const publication = publicationQueue.then(() => {
        if (!isCurrent()) return false;
        // Observational state needs no transaction when the published projection already matches.
        try {
          if (isUnchanged(read({ path, profile }))) return false;
        } catch {
          // An unreadable envelope stays with the transactional publisher's fail-closed path.
        }
        return (
          publish(
            { path, profile },
            (current) => {
              if (isUnchanged(current))
                return { value: current, changed: false };
              const writtenAtMs = getNowMs();
              if (!Number.isSafeInteger(writtenAtMs) || writtenAtMs < 0)
                throw new Error(
                  "Bale runtime projection timestamp is invalid.",
                );
              return { value: { ...semantic, writtenAtMs }, changed: true };
            },
            isCurrent,
          ) === true
        );
      });
      publicationQueue = publication.then(
        () => undefined,
        () => undefined,
      );
      return publication;
    },
  };
}

const BALE_DIAGNOSTICS_SNAPSHOT_COALESCE_MS = 100;

export function createBaleRuntimeDiagnosticsSnapshotScheduler(deps: {
  persistSnapshot: (isCurrent: () => boolean) => Promise<void>;
  recordError: (error: unknown) => void;
  captureScope?: () => (() => boolean) | undefined;
  setTimer?: (
    callback: () => void,
    ms: number,
  ) => { unref?: () => void } | number;
  clearTimer?: (timer: { unref?: () => void } | number) => void;
}): (() => void) & { resume(): void; suspend(): Promise<void> } {
  const setTimer = deps.setTimer ?? setTimeout;
  const clearTimer =
    deps.clearTimer ??
    ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  let generation = 0;
  let enabled = true;
  let timer:
    { token: object; handle: { unref?: () => void } | number } | undefined;
  let persistPromise: Promise<void> | undefined;
  let pending: (() => boolean) | undefined;
  const recordError = (error: unknown): void => {
    try {
      deps.recordError(error);
    } catch {
      // Snapshot diagnostics cannot create an unhandled scheduler rejection.
    }
  };
  const cancelTimer = (): void => {
    const previous = timer;
    timer = undefined;
    if (previous) {
      try {
        clearTimer(previous.handle);
      } catch (error) {
        recordError(error);
      }
    }
  };
  const capture = (): (() => boolean) | undefined => {
    if (!enabled) return undefined;
    const expectedGeneration = generation;
    let scope: (() => boolean) | undefined;
    try {
      scope = deps.captureScope ? deps.captureScope() : () => true;
    } catch (error) {
      recordError(error);
      return undefined;
    }
    if (!scope) return undefined;
    return () => {
      if (!enabled || generation !== expectedGeneration) return false;
      try {
        return scope!();
      } catch (error) {
        recordError(error);
        return false;
      }
    };
  };
  const arm = (): void => {
    if (timer || persistPromise || !pending) return;
    const authority = pending;
    if (!authority()) {
      pending = undefined;
      return;
    }
    const token = {};
    const handle = setTimer(() => {
      if (timer?.token !== token) return;
      timer = undefined;
      const publicationAuthority = pending;
      pending = undefined;
      if (!authority() || !publicationAuthority?.()) return;
      let tracked: Promise<void>;
      tracked = Promise.resolve()
        .then(() =>
          publicationAuthority()
            ? deps.persistSnapshot(publicationAuthority)
            : undefined,
        )
        .catch(recordError)
        .finally(() => {
          if (persistPromise !== tracked) return;
          persistPromise = undefined;
          // Only an explicitly captured new request can arm a successor publication.
          arm();
        });
      persistPromise = tracked;
    }, BALE_DIAGNOSTICS_SNAPSHOT_COALESCE_MS);
    timer = { token, handle };
    if (typeof handle !== "number") handle.unref?.();
  };
  const request = (): void => {
    const authority = capture();
    if (!authority) return;
    pending = authority;
    arm();
  };
  return Object.assign(request, {
    resume() {
      generation += 1;
      cancelTimer();
      pending = undefined;
      enabled = true;
    },
    suspend() {
      enabled = false;
      generation += 1;
      cancelTimer();
      pending = undefined;
      return persistPromise ?? Promise.resolve();
    },
  });
}

export function getBaleStatusBarProcessingStatus(state: {
  hasActiveTurn: boolean;
  hasPendingDispatch: boolean;
  hasPendingModelSwitch: boolean;
  activeToolExecutions: number;
  queuedItems: number;
}): string | undefined {
  if (state.hasPendingModelSwitch) return "model";
  if (state.hasActiveTurn || state.activeToolExecutions > 0) return "active";
  if (state.hasPendingDispatch) return "dispatching";
  if (state.queuedItems > 0) return "queued";
  return undefined;
}

function getBaleStatusBarLabel(state: BaleStatusBarState): string {
  return state.instanceThreadName?.trim() || "bale";
}

export function buildBaleStatusBarText(
  theme: BaleStatusBarTheme,
  state: BaleStatusBarState,
): string {
  const label = theme.fg("accent", getBaleStatusBarLabel(state));
  const queued = state.queuedStatus ? theme.fg("warning", state.queuedStatus) : "";
  if (!state.hasBotToken)
    return `${label} ${theme.fg("muted", "not configured")}${queued}`;
  if (
    state.pollingStopReason === "persistent-conflict" &&
    state.busRole !== "follower"
  )
    return `${label} ${theme.fg("error", "error")}`;
  if (!state.paired)
    return `${label} ${theme.fg("warning", "awaiting pairing")}${queued}`;
  if (state.busLifecyclePhase === "electing")
    return `${label} ${theme.fg("warning", "electing")}${queued}`;
  if (!state.pollingActive && state.busRole !== "follower")
    return `${label} ${theme.fg("dim", "disconnected")}${queued}`;
  if (state.error) {
    return `${label} ${theme.fg("error", "error")}${queued}`;
  }
  if (state.busRole === "follower" && state.followerRegistered === false) {
    return `${label} ${theme.fg("warning", "reconnecting")}${queued}`;
  }
  if (state.busRole === "follower")
    return `${label} ${theme.fg("success", "follower")}${queued}`;
  if (state.busRole === "leader")
    return `${label} ${theme.fg("success", "leader")}${queued}`;
  return `${label} ${theme.fg("success", "connected")}${queued}`;
}

function formatBaleBridgeBotStatus(
  state: Pick<
    BaleBridgeStatusLineState,
    "hasBotToken" | "botUsername" | "botTokenDiagnostic"
  >,
): string {
  if (state.botUsername) return `@${state.botUsername}`;
  if (state.hasBotToken) return "unknown";
  return state.botTokenDiagnostic ?? "not configured";
}

function formatBaleStatusTarget(
  target: { chatId: number; threadId?: number } | undefined,
): string {
  if (!target) return "";
  return target.threadId === undefined
    ? ` target ${target.chatId}`
    : ` target ${target.chatId}:${target.threadId}`;
}

function formatBaleThreadStatusLabel(input: {
  threadName?: string;
  slot?: string;
}): string {
  const threadName = input.threadName?.trim();
  if (threadName) return threadName;
  return input.slot ? `[${input.slot}]` : "";
}

function formatBaleBusProtocolIdentity(
  protocol:
    | {
        protocolVersion: number;
        runtimeBuild: string;
        capabilities: string[];
      }
    | undefined,
): string {
  if (!protocol) return "";
  const capabilities =
    protocol.capabilities.length > 0
      ? ` capabilities=${protocol.capabilities.join(",")}`
      : " capabilities=none";
  return ` protocol=v${protocol.protocolVersion} build=${protocol.runtimeBuild}${capabilities}`;
}

function buildBaleBusFollowerLines(
  state: Pick<BaleBridgeStatusLineState, "busFollowers" | "busNowMs">,
): string[] {
  const followers = state.busFollowers ?? [];
  if (followers.length === 0) return [];
  const nowMs = state.busNowMs ?? Date.now();
  return [
    "",
    "bus:",
    `- followers: ${followers.length}`,
    ...followers.map((follower) => {
      const ageSeconds = Math.max(
        0,
        Math.round((nowMs - follower.lastHeartbeatMs) / 1000),
      );
      const label = formatBaleThreadStatusLabel(follower);
      const labelSuffix = label ? ` ${label}` : "";
      const statusLabel = follower.status ? ` (${follower.status})` : "";
      const cwd = follower.cwd ? ` ${follower.cwd}` : "";
      const target = formatBaleStatusTarget(follower.target);
      const protocol = formatBaleBusProtocolIdentity(follower.protocol);
      return `- ${follower.instanceId}:${labelSuffix} heartbeat ${ageSeconds}s ago${statusLabel}${target}${cwd}${protocol}`;
    }),
  ];
}

function buildBaleLocalBusLines(
  state: Pick<BaleBridgeStatusLineState, "localBus">,
  options: { verbose?: boolean } = {},
): string[] {
  const localBus = state.localBus;
  if (!localBus) return [];
  const target = formatBaleStatusTarget(localBus.followerTarget);
  const label = formatBaleThreadStatusLabel({
    slot: localBus.followerSlot,
    threadName: localBus.followerThreadName,
  });
  const protocol = formatBaleBusProtocolIdentity(localBus.leaderProtocol);
  const followerLine = `- follower registered: ${localBus.followerRegistered ? "yes" : "no"}${label ? ` ${label}` : ""}${target}${protocol}`;
  const lines = ["", "local bus:", followerLine];
  if (options.verbose) {
    if (localBus.leaderSocketPath) {
      const transport = localBus.leaderTransport
        ? ` [${localBus.leaderTransport}]`
        : "";
      lines.push(`- leader endpoint${transport}: ${localBus.leaderSocketPath}`);
    }
    if (localBus.followerSocketPath) {
      const transport = localBus.followerTransport
        ? ` [${localBus.followerTransport}]`
        : "";
      lines.push(
        `- follower endpoint${transport}: ${localBus.followerSocketPath}`,
      );
    }
  }
  return lines;
}

function buildBaleSyncSliceLines(
  state: Pick<BaleBridgeStatusLineState, "syncState">,
): string[] {
  const syncState = state.syncState;
  if (!syncState || Object.keys(syncState).length === 0) return [];
  return [
    "sync:",
    ...Object.entries(syncState).map(([slice, value]) => {
      const status = value?.status ?? "unknown";
      const action = value?.lastReconcileAction
        ? ` reconcile=${value.lastReconcileAction}`
        : "";
      const reason = value?.reason ? ` reason=${value.reason}` : "";
      return `- ${slice}: ${status}${action}${reason}`;
    }),
  ];
}

function buildBaleThreadReconciliationLines(
  state: Pick<BaleBridgeStatusLineState, "threadReconciliation">,
): string[] {
  const reconciliation = state.threadReconciliation;
  if (!reconciliation) return [];
  const epoch =
    reconciliation.leaderEpoch !== undefined
      ? ` epoch=${reconciliation.leaderEpoch}`
      : "";
  return [
    "reconciliation:",
    `- phase: ${reconciliation.phase} event=${reconciliation.event}${epoch}`,
    `- counts: pending=${reconciliation.pendingProvisionCount}, sync=${reconciliation.syncActionCount}, cleanup=${reconciliation.cleanupActionCount}`,
  ];
}

function buildBaleTopicTargetDiagnosticLines(
  state: Pick<
    BaleBridgeStatusLineState,
    "topicTargets" | "threadReservations" | "topicSyncObservations"
  >,
): string[] {
  const activeTargets = (state.topicTargets ?? []).filter(
    (record) =>
      !!record.instanceId &&
      (record.status === "active" || record.status === "starting"),
  );
  const reservations = state.threadReservations ?? [];
  const observations = state.topicSyncObservations ?? [];
  if (
    activeTargets.length === 0 &&
    reservations.length === 0 &&
    observations.length === 0
  )
    return [];
  const byInstance = new Map<string, BaleBridgeStatusTopicTarget[]>();
  for (const record of activeTargets) {
    const key = record.instanceId;
    if (!key) continue;
    const records = byInstance.get(key) ?? [];
    records.push(record);
    byInstance.set(key, records);
  }
  const duplicateLines = Array.from(byInstance.entries())
    .filter(([, records]) => records.length > 1)
    .map(([instanceId, records]) => {
      const targets = records
        .map((record) => {
          const label = formatBaleThreadStatusLabel(record);
          return `${label}${formatBaleStatusTarget(record.target) || " unknown"}`.trim();
        })
        .join(", ");
      return `- duplicate ${instanceId}: ${records.length} active threads ${targets}`;
    });
  const twinLines = activeTargets.map((record) => {
    const label = formatBaleThreadStatusLabel(record);
    const target = formatBaleStatusTarget(record.target) || " unknown";
    const sync = record.syncStatus ? ` sync=${record.syncStatus}` : "";
    const observed = record.lastSyncObservedAtMs
      ? ` observed=${new Date(record.lastSyncObservedAtMs).toISOString()}`
      : "";
    const probe = record.lastSyncProbeAtMs
      ? ` probed=${new Date(record.lastSyncProbeAtMs).toISOString()}`
      : "";
    const error = record.lastSyncError
      ? ` syncError=${record.lastSyncError}`
      : "";
    const action = record.lastReconcileAction
      ? ` reconcile=${record.lastReconcileAction}`
      : "";
    return `- ${label}${target}${sync}${observed}${probe}${error}${action}`.trim();
  });
  const reservationLines = reservations.map((reservation) => {
    const slot = reservation.slot ? `[${reservation.slot}]` : "";
    const target = formatBaleStatusTarget(reservation.target) || " unknown";
    const reason = reservation.reason ? ` reason=${reservation.reason}` : "";
    const instance = reservation.instanceId
      ? ` instance=${reservation.instanceId}`
      : "";
    const action = reservation.lastReconcileAction
      ? ` reconcile=${reservation.lastReconcileAction}`
      : "";
    return `- reservation ${slot}${target}${reason}${instance}${action}`.trim();
  });
  const observationLines = observations.map((observation) => {
    const slot = observation.slot ? `[${observation.slot}]` : "";
    const target = formatBaleStatusTarget(observation.target) || " unknown";
    const observed = ` observed=${new Date(observation.observedAtMs).toISOString()}`;
    const instance = observation.instanceId
      ? ` instance=${observation.instanceId}`
      : "";
    const error = observation.lastSyncError
      ? ` syncError=${observation.lastSyncError}`
      : "";
    const action = observation.lastReconcileAction
      ? ` reconcile=${observation.lastReconcileAction}`
      : "";
    return `- sync ${slot}${target} sync=${observation.syncStatus}${observed}${instance}${error}${action}`.trim();
  });
  return [
    "topics:",
    `- active bindings: instances=${byInstance.size}, targets=${activeTargets.length}`,
    ...duplicateLines,
    ...twinLines,
    ...reservationLines,
    ...observationLines,
  ];
}

function buildBaleBridgeCompactThreadLines(
  state: Pick<
    BaleBridgeStatusLineState,
    | "busFollowers"
    | "topicTargets"
    | "threadReservations"
    | "topicSyncObservations"
  >,
): string[] {
  const activeTargets = (state.topicTargets ?? []).filter(
    (record) =>
      !!record.instanceId &&
      (record.status === "active" || record.status === "starting"),
  );
  const activeLabels = activeTargets
    .map(formatBaleThreadStatusLabel)
    .filter((label) => label.length > 0);
  const followers = state.busFollowers ?? [];
  const reservations = state.threadReservations ?? [];
  const observations = state.topicSyncObservations ?? [];
  if (
    activeLabels.length === 0 &&
    followers.length === 0 &&
    reservations.length === 0 &&
    observations.length === 0
  ) {
    return [];
  }
  const lines = ["threads:"];
  if (activeLabels.length > 0)
    lines.push(`- active: ${activeLabels.join(", ")}`);
  if (followers.length > 0) lines.push(`- followers: ${followers.length}`);
  if (reservations.length > 0) lines.push(`- reserved: ${reservations.length}`);
  const syncIssueCount = observations.filter(
    (observation) => observation.syncStatus !== "open",
  ).length;
  if (syncIssueCount > 0) lines.push(`- sync issues: ${syncIssueCount}`);
  return lines;
}

function formatBalePollingLifecycle(
  state: Pick<BaleBridgeStatusLineState, "pollingActive" | "polling">,
): string {
  const lifecycle = state.pollingActive ? "running" : "stopped";
  if (!state.polling) return lifecycle;
  if (state.pollingActive) return `${lifecycle} (${state.polling.phase})`;
  return state.polling.stopReason
    ? `${lifecycle} (${state.polling.stopReason})`
    : lifecycle;
}

function buildBalePollingDiagnosticLines(
  polling: BaleBridgePollingState | undefined,
): string[] {
  if (!polling) return [];
  return [
    `- phase: ${polling.phase}`,
    ...(polling.phaseStartedAtMs !== undefined
      ? [`- phase started: ${new Date(polling.phaseStartedAtMs).toISOString()}`]
      : []),
    ...(polling.currentUpdateId !== undefined
      ? [`- current update id: ${polling.currentUpdateId}`]
      : []),
    ...(polling.lastSuccessfulResponseAtMs !== undefined
      ? [
          `- last successful response: ${new Date(polling.lastSuccessfulResponseAtMs).toISOString()} (updates=${polling.lastSuccessfulResponseUpdateCount ?? "unknown"})`,
        ]
      : []),
    ...(polling.startedAtMs !== undefined
      ? [`- started: ${new Date(polling.startedAtMs).toISOString()}`]
      : []),
    ...(polling.stoppedAtMs !== undefined
      ? [`- stopped: ${new Date(polling.stoppedAtMs).toISOString()}`]
      : []),
    ...(polling.stopReason ? [`- stop reason: ${polling.stopReason}`] : []),
  ];
}

function formatBaleInboundWorkerState(
  worker: BaleBridgeInboundWorkerState | undefined,
): string {
  if (!worker) return "not started";
  const depth = worker.journalEntryCount;
  return `${worker.phase} (depth=${depth}, queued=${worker.queuedClaimCount}, foreign=${worker.foreignQueuedCount}, deferred=${worker.deferredClaimCount}, retry=${worker.retryWaitCount}, failed=${worker.failedCount})`;
}

function buildBaleInboundWorkerDiagnosticLines(
  worker: BaleBridgeInboundWorkerState | undefined,
): string[] {
  if (!worker) return ["- state: not started"];
  return [
    `- state: ${worker.phase}`,
    `- generation: ${worker.generation}`,
    ...(worker.phaseStartedAtMs !== undefined
      ? [`- phase started: ${new Date(worker.phaseStartedAtMs).toISOString()}`]
      : []),
    `- journal: entries=${worker.journalEntryCount}, bytes=${worker.journalSerializedBytes}`,
    `- claims: queued=${worker.queuedClaimCount}, foreign-queued=${worker.foreignQueuedCount}, deferred=${worker.deferredClaimCount}, unsettled=${worker.unsettledExecutionCount}`,
    ...(worker.foreignQueuedOwner
      ? [
          `- queued semantic owner: instance=${worker.foreignQueuedOwner.instanceId}, pid=${worker.foreignQueuedOwner.processId}, birth=${worker.foreignQueuedOwner.processBirthId}, session=${worker.foreignQueuedOwner.sessionGeneration}, acquisition=${worker.foreignQueuedOwner.acquisitionId}, liveness=${worker.foreignQueuedOwnerLiveness ?? "unknown"}`,
        ]
      : []),
    `- failures: retry-wait=${worker.retryWaitCount}, terminal=${worker.failedCount}`,
    ...(worker.currentUpdateId !== undefined
      ? [`- current update id: ${worker.currentUpdateId}`]
      : []),
    ...(worker.nextRetryUpdateId !== undefined
      ? [
          `- next retry: update=${worker.nextRetryUpdateId}, attempt=${worker.nextRetryAttemptCount ?? "unknown"}, class=${worker.nextRetryFailureClass ?? "unknown"}${worker.nextRetryAtMs !== undefined ? ` at ${new Date(worker.nextRetryAtMs).toISOString()}` : ""}`,
        ]
      : []),
    ...(worker.failedUpdateId !== undefined
      ? [
          `- terminal update: id=${worker.failedUpdateId}, failure=${worker.failedFailureId ?? "unknown"}, attempts=${worker.failedAttemptCount ?? "unknown"}, class=${worker.failedClass ?? "unknown"}${worker.terminalFailureAtMs !== undefined ? ` at ${new Date(worker.terminalFailureAtMs).toISOString()}` : ""}`,
          ...(worker.failedSummary
            ? [`- terminal summary: ${worker.failedSummary}`]
            : []),
        ]
      : []),
    ...(worker.oldestAdmittedAtMs !== undefined
      ? [
          `- oldest admitted: ${new Date(worker.oldestAdmittedAtMs).toISOString()}`,
        ]
      : []),
    ...(worker.blockedReason
      ? [`- blocked reason: ${worker.blockedReason}`]
      : []),
    ...(worker.blockedInputCustody
      ? [
          `- blocked input custody: update=${worker.blockedInputCustody.updateId}, kind=${worker.blockedInputCustody.kind}`,
        ]
      : []),
    ...(worker.lastCompletedUpdateId !== undefined
      ? [
          `- last completed: ${worker.lastCompletedUpdateId}${worker.lastCompletedAtMs !== undefined ? ` at ${new Date(worker.lastCompletedAtMs).toISOString()}` : ""}`,
        ]
      : []),
    ...(worker.lastFailurePhase
      ? [
          `- last failure: ${worker.lastFailurePhase}${worker.lastFailureAtMs !== undefined ? ` at ${new Date(worker.lastFailureAtMs).toISOString()}` : ""}`,
        ]
      : []),
  ];
}

function countBaleQueueLanes(
  items: BaleBridgeStatusLineState["queuedItems"],
): Record<BaleStatusQueueLane, number> {
  const counts: Record<BaleStatusQueueLane, number> = {
    control: 0,
    steer: 0,
    priority: 0,
    default: 0,
  };
  for (const item of items) counts[item.queueLane]++;
  return counts;
}

function buildBaleBridgeCompactStatusLines(
  state: BaleBridgeStatusLineState,
): string[] {
  const {
    control: controlQueueCount,
    priority: priorityQueueCount,
    default: defaultQueueCount,
    steer: steerQueueCount,
  } = countBaleQueueLanes(state.queuedItems);
  const queueLine = `- queued turns: ${state.queuedItems.length}${
    state.queuedItems.length > 0
      ? ` (control=${controlQueueCount}${steerQueueCount > 0 ? `, steer=${steerQueueCount}` : ""}, priority=${priorityQueueCount}, default=${defaultQueueCount})`
      : ""
  }`;
  const executionState = state.pendingDispatch
    ? "pending dispatch"
    : state.activeSourceMessageIds?.length
      ? "active"
      : "idle";
  const diagnosticsPaths = state.diagnosticPaths ?? {
    state: "~/.pi/agent/tmp/pi-bale/state.json",
    logs: "~/.pi/agent/tmp/pi-bale/logs.jsonl",
  };
  return [
    "connection:",
    `- bot: ${formatBaleBridgeBotStatus(state)}`,
    ...(state.activeProfileName
      ? [`- profile: ${state.activeProfileName}`]
      : []),
    `- user: ${state.allowedUserId ?? "not paired"}`,
    ...(state.botThreadMode ? [`- thread mode: ${state.botThreadMode}`] : []),
    ...(state.busRole ? [`- role: ${state.busRole}`] : []),
    ...(state.busLifecyclePhase
      ? [`- lifecycle: ${state.busLifecyclePhase}`]
      : []),
    ...(state.instanceThreadName || state.instanceSlot
      ? [`- instance: ${state.instanceThreadName ?? state.instanceSlot}`]
      : []),
    ...(state.lockState ? [`- owner: ${state.lockState}`] : []),
    "",
    "health:",
    `- polling: ${formatBalePollingLifecycle(state)}`,
    ...(state.inboundWorker
      ? [
          `- inbound worker: ${formatBaleInboundWorkerState(state.inboundWorker)}`,
        ]
      : []),
    `- state: ${executionState}`,
    queueLine,
    ...(state.activeToolExecutions > 0
      ? [`- active tools: ${state.activeToolExecutions}`]
      : []),
    ...(state.pendingModelSwitch ? ["- pending model switch: yes"] : []),
    ...buildBaleBridgeCompactThreadLines(state),
    ...buildBaleBusFollowerLines(state),
    ...buildBaleLocalBusLines(state),
    ...buildBaleThreadReconciliationLines(state),
    "",
    "diagnostics:",
    `- state: ${diagnosticsPaths.state}`,
    `- logs: ${diagnosticsPaths.logs}`,
    "- full dump: /bale-status --debug",
  ];
}

export function buildBaleBridgeStatusLines(
  state: BaleBridgeStatusLineState,
  options: BaleBridgeStatusLineOptions = {},
): string[] {
  if (options.verbose) return buildBaleBridgeDiagnosticStatusLines(state);
  return buildBaleBridgeCompactStatusLines(state);
}

function buildBaleBridgeDiagnosticStatusLines(
  state: BaleBridgeStatusLineState,
): string[] {
  const {
    control: controlQueueCount,
    priority: priorityQueueCount,
    default: defaultQueueCount,
    steer: steerQueueCount,
  } = countBaleQueueLanes(state.queuedItems);
  return [
    "connection:",
    `- bot: ${formatBaleBridgeBotStatus(state)}`,
    ...(state.activeProfileName
      ? [`- profile: ${state.activeProfileName}`]
      : []),
    `- allowed user: ${state.allowedUserId ?? "not paired"}`,
    ...(state.botThreadMode
      ? [
          `- thread mode: ${state.botThreadMode}${state.botThreadModeAction ? ` reconcile=${state.botThreadModeAction}` : ""}`,
        ]
      : []),
    ...(state.busRole ? [`- bus role: ${state.busRole}`] : []),
    ...(state.busProtocol
      ? [`- bus${formatBaleBusProtocolIdentity(state.busProtocol)}`]
      : []),
    ...(state.busLifecyclePhase
      ? [`- bus lifecycle: ${state.busLifecyclePhase}`]
      : []),
    ...(state.instanceThreadName || state.instanceSlot
      ? [`- instance: ${state.instanceThreadName ?? state.instanceSlot}`]
      : []),
    ...(state.lockState ? [`- owner: ${state.lockState}`] : []),
    "",
    "polling:",
    `- state: ${formatBalePollingLifecycle(state)}`,
    ...buildBalePollingDiagnosticLines(state.polling),
    `- last update id: ${state.lastUpdateId ?? "none"}`,
    "",
    ...(state.inboundWorker
      ? [
          "inbound worker:",
          ...buildBaleInboundWorkerDiagnosticLines(state.inboundWorker),
          "",
        ]
      : []),
    "execution:",
    `- active turn: ${state.activeSourceMessageIds?.join(",") || "no"}`,
    `- pending dispatch: ${state.pendingDispatch ? "yes" : "no"}`,
    `- compaction: ${state.compactionInProgress ? "running" : "idle"}`,
    `- active tools: ${state.activeToolExecutions}`,
    `- pending model switch: ${state.pendingModelSwitch ? "yes" : "no"}`,
    "",
    "queue:",
    `- queued turns: ${state.queuedItems.length}`,
    `- lanes: control=${controlQueueCount}${steerQueueCount > 0 ? `, steer=${steerQueueCount}` : ""}, priority=${priorityQueueCount}, default=${defaultQueueCount}`,
    ...buildBaleBusFollowerLines(state),
    ...buildBaleLocalBusLines(state, { verbose: true }),
    ...buildBaleTopicTargetDiagnosticLines(state),
    ...buildBaleThreadReconciliationLines(state),
    ...buildBaleSyncSliceLines(state),
    "",
    ...buildBaleRuntimeEventLines(state.recentRuntimeEvents),
  ];
}

function formatTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
  return `${Math.round(count / 1000000)}M`;
}

function collectUsageStats(ctx: BaleStatusContext): BaleUsageStats {
  const stats: BaleUsageStats = {
    totalInput: 0,
    totalOutput: 0,
    totalCacheRead: 0,
    totalCacheWrite: 0,
    totalCost: 0,
  };
  for (const entry of ctx.sessionManager.getEntries()) {
    const usage = entry.message?.usage;
    if (
      entry.type !== "message" ||
      entry.message?.role !== "assistant" ||
      !usage
    ) {
      continue;
    }
    stats.totalInput += usage.input;
    stats.totalOutput += usage.output;
    stats.totalCacheRead += usage.cacheRead;
    stats.totalCacheWrite += usage.cacheWrite;
    stats.totalCost += usage.cost.total;
    const promptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
    stats.latestCacheHitRate =
      promptTokens > 0 ? (usage.cacheRead / promptTokens) * 100 : undefined;
  }
  return stats;
}

function formatStatusRowLabel(label: string): string {
  if (!label) return label;
  return `${label[0]?.toUpperCase() ?? ""}${label.slice(1)}`;
}

function buildStatusRow(label: string, value: string): string {
  return `<b>${escapeHtml(formatStatusRowLabel(label))}:</b> <code>${escapeHtml(value)}</code>`;
}

function buildUsageSummary(stats: BaleUsageStats): string | undefined {
  const tokenParts: string[] = [];
  if (stats.totalInput) tokenParts.push(`↑${formatTokens(stats.totalInput)}`);
  if (stats.totalOutput) tokenParts.push(`↓${formatTokens(stats.totalOutput)}`);
  return tokenParts.length > 0 ? tokenParts.join(" ") : undefined;
}

function buildCacheSummary(stats: BaleUsageStats): string | undefined {
  const cacheParts: string[] = [];
  if (stats.totalCacheRead)
    cacheParts.push(`R${formatTokens(stats.totalCacheRead)}`);
  if (stats.totalCacheWrite)
    cacheParts.push(`W${formatTokens(stats.totalCacheWrite)}`);
  if (
    (stats.totalCacheRead > 0 || stats.totalCacheWrite > 0) &&
    stats.latestCacheHitRate !== undefined
  ) {
    cacheParts.push(`CH${stats.latestCacheHitRate.toFixed(1)}%`);
  }
  return cacheParts.length > 0 ? cacheParts.join(" ") : undefined;
}

function buildCostSummary(
  stats: BaleUsageStats,
  usesSubscription: boolean,
): string | undefined {
  if (!stats.totalCost && !usesSubscription) return undefined;
  return `$${stats.totalCost.toFixed(3)}${usesSubscription ? " (sub)" : ""}`;
}

function buildContextSummary(
  ctx: BaleStatusContext,
  activeModel: BaleStatusActiveModel | undefined,
): string {
  const usage = ctx.getContextUsage();
  if (!usage) return "unknown";
  const contextWindow = usage.contextWindow ?? activeModel?.contextWindow ?? 0;
  const percent = usage.percent !== null ? `${usage.percent.toFixed(1)}%` : "?";
  return `${percent}/${formatTokens(contextWindow)}`;
}

function buildStatusSummary(ctx: BaleStatusContext): string {
  if (ctx.isCompactionInProgress?.()) return "compacting";
  if (ctx.hasPendingMessages?.()) return "pending";
  if (ctx.isIdle?.() === false) return "active";
  if (ctx.isIdle?.() === true) return "idle";
  return "unknown";
}

function buildBaleStatusRoleSuffix(
  state: BaleBridgeStatusLineState | undefined,
): string {
  if (state?.botThreadMode !== "enabled" || !state.busRole) return "";
  return ` @${state.busRole}`;
}

function buildStatusHtml(
  ctx: BaleStatusContext,
  activeModel: BaleStatusActiveModel | undefined,
  bridgeStatus?: BaleBridgeStatusLineState,
): string {
  const stats = collectUsageStats(ctx);
  const usesSubscription = activeModel
    ? ctx.modelRegistry.isUsingOAuth(activeModel)
    : false;
  const lines: string[] = [
    buildStatusRow(
      "Status",
      `${buildStatusSummary(ctx)}${buildBaleStatusRoleSuffix(bridgeStatus)}`,
    ),
  ];
  const usageSummary = buildUsageSummary(stats);
  const cacheSummary = buildCacheSummary(stats);
  const costSummary = buildCostSummary(stats, usesSubscription);
  if (usageSummary) {
    lines.push(buildStatusRow("Tokens", usageSummary));
  }
  if (cacheSummary) {
    lines.push(buildStatusRow("Cache", cacheSummary));
  }
  if (costSummary) {
    lines.push(buildStatusRow("Cost", costSummary));
  }
  lines.push(buildStatusRow("Context", buildContextSummary(ctx, activeModel)));
  for (const row of getBaleStatusLineProviderResults({ activeModel })) {
    lines.push(buildStatusRow(row.label, row.value));
  }
  return lines.join("\n");
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

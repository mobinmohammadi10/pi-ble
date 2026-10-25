/**
 * Bale model menu UI helpers
 * Zones: bale ui, model controls, menu composition
 * Owns model-menu state, scoped model pages, model callback planning, and model-menu message rendering
 */

import type { BaleInlineKeyboardMarkup } from "./keyboard.ts";
import {
  getCanonicalModelId,
  type MenuModel,
  modelsMatch,
  parseBaleCliScopedModelPatterns,
  resolveScopedModelPatterns,
  type ScopedBaleModel,
  sortScopedModels,
  type BaleModelSwitchContinuationSource,
  type ThinkingLevel,
} from "./model.ts";
import type { BaleTarget } from "./target.ts";
import {
  BaleApiAuthorityError,
  type BaleApiCallOptions,
} from "./bale-api.ts";

const BALE_MODEL_MENU_CACHE_TTL_MS = 5000;
const BALE_MODEL_MENU_STATE_TTL_MS = 10 * 60 * 1000;
const MAX_STORED_BALE_MODEL_MENUS = 50;

export type BaleModelScope = "all" | "scoped";

export interface BaleModelMenuState<TModel extends MenuModel = MenuModel> {
  chatId: number;
  threadId?: number;
  messageId: number;
  page: number;
  scope: BaleModelScope;
  scopedModels: ScopedBaleModel<TModel>[];
  allModels: ScopedBaleModel<TModel>[];
  note?: string;
  selectedModelIndex?: number;
  selectedModelKey?: string;
  scopedModelPatterns?: string[];
  canMutateScope?: boolean;
  mode:
    | "status"
    | "model"
    | "model-pages"
    | "model-detail"
    | "thinking"
    | "queue"
    | "settings";
}

export interface StoredBaleModelMenuState<
  TModel extends MenuModel = MenuModel,
> {
  state: BaleModelMenuState<TModel>;
  updatedAt: number;
}

export interface BaleModelMenuStoreOptions {
  maxAgeMs: number;
  maxStoredMenus: number;
  now?: number;
}

export interface CachedBaleModelMenuInputs<
  TModel extends MenuModel = MenuModel,
> {
  expiresAt: number;
  availableModels: TModel[];
  configuredScopedModelPatterns: string[];
  cliScopedModelPatterns?: string[];
}

export interface BaleModelMenuInputCacheDeps<
  TModel extends MenuModel = MenuModel,
> {
  cacheTtlMs: number;
  now?: number;
  reloadSettings: () => Promise<void>;
  refreshAvailableModels: () => TModel[];
  getConfiguredScopedModelPatterns: () => string[] | undefined;
  getCliScopedModelPatterns: () => string[] | undefined;
}

export interface BaleModelMenuRuntimeContext<
  TModel extends MenuModel = MenuModel,
> {
  modelRegistry: {
    refresh: () => void;
    getAvailable: () => TModel[];
  };
}

export interface BaleModelMenuRuntimeOptions<
  TContext extends BaleModelMenuRuntimeContext<TModel>,
  TModel extends MenuModel = MenuModel,
> {
  chatId: number;
  threadId?: number;
  activeModel: TModel | undefined;
  cachedInputs: CachedBaleModelMenuInputs<TModel> | undefined;
  cacheTtlMs: number;
  ctx: TContext;
  reloadSettings: () => Promise<void>;
  getConfiguredScopedModelPatterns: () => string[] | undefined;
  getCliScopedModelPatterns?: () => string[] | undefined;
}

export interface MenuSettingsManager {
  reload?: () => Promise<void>;
  flush?: () => Promise<void>;
  getEnabledModels: () => string[] | undefined;
  setEnabledModels?: (patterns: string[] | undefined) => void;
}

export type BaleModelMenuStateBuilderContext<
  TModel extends MenuModel = MenuModel,
> = BaleModelMenuRuntimeContext<TModel> & { cwd: string };

export interface BaleModelMenuStateBuilderDeps<
  TModel extends MenuModel = MenuModel,
  TContext extends BaleModelMenuStateBuilderContext<TModel> =
    BaleModelMenuStateBuilderContext<TModel>,
> {
  runtime: BaleModelMenuRuntime<TModel>;
  createSettingsManager: (
    cwd: string,
  ) => MenuSettingsManager | PromiseLike<MenuSettingsManager>;
  getActiveModel: (ctx: TContext) => TModel | undefined;
}

export type BaleReplyMarkup = BaleInlineKeyboardMarkup;

export interface BaleMenuMessageRuntimeDeps {
  editInteractiveMessage: (
    chatId: number,
    messageId: number,
    text: string,
    mode: "markdown" | "html" | "plain",
    replyMarkup: BaleReplyMarkup,
  ) => Promise<void>;
  sendInteractiveMessage: (
    chatId: number,
    text: string,
    mode: "markdown" | "html" | "plain",
    replyMarkup: BaleReplyMarkup,
    options?: { target?: BaleTarget } & Pick<
      BaleApiCallOptions,
      "assertAuthority"
    >,
  ) => Promise<number | undefined>;
}

/** Per-open delivery lifetime; never retain this guard in stored callback state. */
export function createBaleMenuDelivery<TModel extends MenuModel>(
  target: BaleTarget,
  options: Pick<BaleApiCallOptions, "assertAuthority"> | undefined,
  deps: Pick<BaleMenuMessageRuntimeDeps, "sendInteractiveMessage"> & {
    storeModelMenuState: (state: BaleModelMenuState<TModel>) => void;
  },
) {
  const assertAuthority = options?.assertAuthority,
    capturedTarget = { ...target };
  const sendInteractiveMessage = deps.sendInteractiveMessage,
    storeModelMenuState = deps.storeModelMenuState;
  let requestIssued = false;
  const assertCurrent = () => {
    try {
      assertAuthority?.();
    } catch {
      throw new BaleApiAuthorityError(requestIssued);
    }
  };
  assertCurrent();
  return {
    assertCurrent,
    assertAuthority,
    sendInteractiveMessage: async (
      ...args: Parameters<
        BaleMenuMessageRuntimeDeps["sendInteractiveMessage"]
      >
    ) => {
      assertCurrent();
      const [chatId, text, mode, replyMarkup, sendOptions] = args;
      const messageId = await sendInteractiveMessage(
        assertAuthority ? capturedTarget.chatId : chatId,
        text,
        mode,
        replyMarkup,
        assertAuthority
          ? { ...sendOptions, target: { ...capturedTarget }, assertAuthority }
          : sendOptions,
      );
      requestIssued = true;
      assertCurrent();
      return messageId;
    },
    storeModelMenuState: (state: BaleModelMenuState<TModel>) => {
      assertCurrent();
      if (
        assertAuthority &&
        (state.chatId !== capturedTarget.chatId ||
          state.threadId !== capturedTarget.threadId)
      ) {
        throw new BaleApiAuthorityError(requestIssued);
      }
      storeModelMenuState(state);
      assertCurrent();
    },
  };
}

export type BaleModelMenuCallbackDeps<
  TModel extends MenuModel = MenuModel,
> = {
  answerCallbackQuery: (
    callbackQueryId: string,
    text?: string,
  ) => Promise<void>;
  updateModelMenuMessage: () => Promise<void>;
  updateStatusMessage: () => Promise<void>;
  persistScopedModelPatterns?: (patterns: string[]) => Promise<void>;
  setModel: (model: TModel) => Promise<boolean>;
  setCurrentModel: (model: TModel) => void;
  setThinkingLevel: (level: ThinkingLevel) => void;
  stagePendingModelSwitch: (
    selection: ScopedBaleModel<TModel>,
    continuationTurn: BaleModelSwitchContinuationSource,
  ) => void;
  restartInterruptedBaleTurn: (
    selection: ScopedBaleModel<TModel>,
    continuationTurn: BaleModelSwitchContinuationSource,
  ) => Promise<boolean> | boolean;
};

export interface BaleModelMenuOpenDeps<
  TModel extends MenuModel = MenuModel,
> {
  isIdle: () => boolean;
  canOfferInFlightModelSwitch: () => boolean;
  sendBusyMessage: () => Promise<void>;
  sendNoModelsMessage: () => Promise<void>;
  getModelMenuState: () => Promise<BaleModelMenuState<TModel>>;
  getActiveModel: () => TModel | undefined;
  sendModelMenu: (
    state: BaleModelMenuState<TModel>,
    activeModel: TModel | undefined,
  ) => Promise<number | undefined>;
  storeModelMenuState: (state: BaleModelMenuState<TModel>) => void;
}

export interface BuildBaleModelMenuStateParams<
  TModel extends MenuModel = MenuModel,
> {
  chatId: number;
  threadId?: number;
  activeModel: TModel | undefined;
  availableModels: TModel[];
  configuredScopedModelPatterns: string[];
  cliScopedModelPatterns?: string[];
}

export type BaleMenuMutationResult = "invalid" | "unchanged" | "changed";
export type BaleMenuSelectionResult<TModel extends MenuModel = MenuModel> =
  | { kind: "invalid" }
  | { kind: "missing" }
  | { kind: "selected"; selection: ScopedBaleModel<TModel> };

export interface BaleModelMenuPage<TModel extends MenuModel = MenuModel> {
  page: number;
  pageCount: number;
  start: number;
  items: ScopedBaleModel<TModel>[];
}

export interface BaleMenuRenderPayload {
  nextMode: BaleModelMenuState["mode"];
  text: string;
  mode: "markdown" | "html" | "plain";
  replyMarkup: BaleReplyMarkup;
}

export type BaleModelCallbackPlan<TModel extends MenuModel = MenuModel> =
  | { kind: "ignore" }
  | { kind: "answer"; text?: string }
  | { kind: "update-menu"; text?: string }
  | { kind: "persist-scope"; patterns: string[]; text: string }
  | {
      kind: "refresh-status";
      selection: ScopedBaleModel<TModel>;
      callbackText: string;
      shouldApplyThinkingLevel: boolean;
    }
  | {
      kind: "switch-model";
      selection: ScopedBaleModel<TModel>;
      mode: "idle" | "restart-now" | "restart-after-tool";
      callbackText: string;
    };

export interface BuildBaleModelCallbackPlanParams<
  TModel extends MenuModel = MenuModel,
> {
  data: string | undefined;
  state: BaleModelMenuState<TModel>;
  activeModel: TModel | undefined;
  currentThinkingLevel: ThinkingLevel;
  isIdle: boolean;
  canRestartBusyRun: boolean;
  hasActiveToolExecutions: boolean;
}

export interface BaleModelMenuRuntime<
  TModel extends MenuModel = MenuModel,
> {
  storeState: (state: BaleModelMenuState<TModel>) => void;
  getState: (
    messageId: number | undefined,
    chatId?: number,
  ) => BaleModelMenuState<TModel> | undefined;
  clear: () => void;
  clearCachedInputs: () => void;
  buildState: <TContext extends BaleModelMenuRuntimeContext<TModel>>(
    options: Omit<
      BaleModelMenuRuntimeOptions<TContext, TModel>,
      "cachedInputs" | "cacheTtlMs"
    >,
  ) => Promise<BaleModelMenuState<TModel>>;
}

export const BALE_MODEL_PAGE_SIZE = 6;
const BALE_MODEL_PAGE_PICKER_ROW_SIZE = 4;
export const MODEL_MENU_TITLE = "<b>🤖 Choose a model:</b>";
export const MODEL_PAGE_MENU_TITLE = "<b>Choose a page:</b>";
const MODEL_DETAIL_MENU_TITLE = "<b>🤖 Model:</b>";

function truncateBaleButtonLabel(label: string, maxLength = 56): string {
  return label.length <= maxLength
    ? label
    : `${label.slice(0, maxLength - 1)}…`;
}

function getBaleCliScopedModelPatterns(): string[] | undefined {
  return parseBaleCliScopedModelPatterns(process.argv.slice(2));
}

function parseBaleModelMenuCallbackAction(data: string | undefined):
  | {
      action:
        | "noop"
        | "scope"
        | "page"
        | "pages"
        | "open"
        | "pick"
        | "pick-selected"
        | "scope-enable"
        | "scope-disable"
        | "scope-toggle";
      value?: string;
    }
  | undefined {
  if (!data?.startsWith("model:")) return undefined;
  const [, action, value] = data.split(":");
  if (
    action === "noop" ||
    action === "scope" ||
    action === "page" ||
    action === "pages" ||
    action === "open" ||
    action === "pick" ||
    action === "pick-selected" ||
    action === "scope-enable" ||
    action === "scope-disable" ||
    action === "scope-toggle"
  ) {
    return { action, value };
  }
  return undefined;
}

function applyBaleMenuRenderPayload(
  state: BaleModelMenuState,
  payload: BaleMenuRenderPayload,
): BaleMenuRenderPayload {
  state.mode = payload.nextMode;
  return payload;
}

/** Apply the payload mode to state, then edit the existing menu message in place. */
export async function editBaleMenuMessage(
  state: BaleModelMenuState,
  payload: BaleMenuRenderPayload,
  deps: BaleMenuMessageRuntimeDeps,
): Promise<void> {
  const appliedPayload = applyBaleMenuRenderPayload(state, payload);
  await deps.editInteractiveMessage(
    state.chatId,
    state.messageId,
    appliedPayload.text,
    appliedPayload.mode,
    appliedPayload.replyMarkup,
  );
}

/** Apply the payload mode to state, then send a fresh menu message to its exact chat/Thread. */
export function sendBaleMenuMessage(
  state: BaleModelMenuState,
  payload: BaleMenuRenderPayload,
  deps: BaleMenuMessageRuntimeDeps,
): Promise<number | undefined> {
  const appliedPayload = applyBaleMenuRenderPayload(state, payload);
  return deps.sendInteractiveMessage(
    state.chatId,
    appliedPayload.text,
    appliedPayload.mode,
    appliedPayload.replyMarkup,
    state.threadId !== undefined
      ? { target: { chatId: state.chatId, threadId: state.threadId } }
      : undefined,
  );
}

export function formatScopedModelButtonText<
  TModel extends MenuModel = MenuModel,
>(
  entry: ScopedBaleModel<TModel>,
  currentModel: TModel | undefined,
): string {
  let label = `${modelsMatch(entry.model, currentModel) ? "🟢 " : ""}${entry.model.provider}/${entry.model.id}`;
  if (entry.thinkingLevel) {
    label += ` (${entry.thinkingLevel})`;
  }
  return truncateBaleButtonLabel(label);
}

export function formatStatusButtonLabel(label: string, value: string): string {
  return truncateBaleButtonLabel(`${label}: ${value}`, 64);
}

export function getModelMenuItems<TModel extends MenuModel = MenuModel>(
  state: BaleModelMenuState<TModel>,
): ScopedBaleModel<TModel>[] {
  return state.scope === "scoped" && state.scopedModels.length > 0
    ? state.scopedModels
    : state.allModels;
}

function getBaleMenuStateKey(chatId: number, messageId: number): string {
  return `${chatId}:${messageId}`;
}

export function pruneStoredBaleModelMenus<
  TModel extends MenuModel = MenuModel,
>(
  menus: Map<string, StoredBaleModelMenuState<TModel>>,
  options: BaleModelMenuStoreOptions,
): void {
  const now = options.now ?? Date.now();
  for (const [messageId, entry] of menus.entries()) {
    if (now - entry.updatedAt <= options.maxAgeMs) continue;
    menus.delete(messageId);
  }
  while (menus.size > options.maxStoredMenus) {
    const oldestKey = menus.keys().next().value as string | undefined;
    if (oldestKey === undefined) return;
    menus.delete(oldestKey);
  }
}

export function storeBaleModelMenuState<
  TModel extends MenuModel = MenuModel,
>(
  menus: Map<string, StoredBaleModelMenuState<TModel>>,
  state: BaleModelMenuState<TModel>,
  options: BaleModelMenuStoreOptions,
): void {
  const now = options.now ?? Date.now();
  pruneStoredBaleModelMenus(menus, { ...options, now });
  menus.set(getBaleMenuStateKey(state.chatId, state.messageId), {
    state,
    updatedAt: now,
  });
  pruneStoredBaleModelMenus(menus, { ...options, now });
}

export function getStoredBaleModelMenuState<
  TModel extends MenuModel = MenuModel,
>(
  menus: Map<string, StoredBaleModelMenuState<TModel>>,
  messageId: number | undefined,
  options: BaleModelMenuStoreOptions,
  chatId?: number,
): BaleModelMenuState<TModel> | undefined {
  if (messageId === undefined) return undefined;
  const now = options.now ?? Date.now();
  pruneStoredBaleModelMenus(menus, { ...options, now });
  const key =
    typeof chatId === "number"
      ? getBaleMenuStateKey(chatId, messageId)
      : [...menus.keys()].find((candidate) =>
          candidate.endsWith(`:${messageId}`),
        );
  if (!key) return undefined;
  const entry = menus.get(key);
  if (!entry) return undefined;
  menus.delete(key);
  entry.updatedAt = now;
  menus.set(key, entry);
  return entry.state;
}

export function createBaleModelMenuRuntime<
  TModel extends MenuModel = MenuModel,
>(
  options: Partial<BaleModelMenuStoreOptions> = {},
): BaleModelMenuRuntime<TModel> {
  const menus = new Map<string, StoredBaleModelMenuState<TModel>>();
  let cachedInputs: CachedBaleModelMenuInputs<TModel> | undefined;
  const getStoreOptions = (): BaleModelMenuStoreOptions => ({
    maxAgeMs: options.maxAgeMs ?? BALE_MODEL_MENU_STATE_TTL_MS,
    maxStoredMenus: options.maxStoredMenus ?? MAX_STORED_BALE_MODEL_MENUS,
    now: options.now,
  });
  return {
    storeState: (state) => {
      storeBaleModelMenuState(menus, state, getStoreOptions());
    },
    getState: (messageId, chatId) =>
      getStoredBaleModelMenuState(
        menus,
        messageId,
        getStoreOptions(),
        chatId,
      ),
    clear: () => {
      menus.clear();
      cachedInputs = undefined;
    },
    clearCachedInputs: () => {
      cachedInputs = undefined;
    },
    buildState: async (stateOptions) => {
      const result = await buildBaleModelMenuStateRuntime({
        ...stateOptions,
        cachedInputs,
        cacheTtlMs: BALE_MODEL_MENU_CACHE_TTL_MS,
      });
      cachedInputs = result.cachedInputs;
      return result.state;
    },
  };
}

export function createBaleModelMenuStateBuilder<
  TModel extends MenuModel = MenuModel,
  TContext extends BaleModelMenuStateBuilderContext<TModel> =
    BaleModelMenuStateBuilderContext<TModel>,
>(
  deps: BaleModelMenuStateBuilderDeps<TModel, TContext>,
): (
  chatId: number,
  ctx: TContext,
  threadId?: number,
) => Promise<BaleModelMenuState<TModel>> {
  return async (chatId, ctx, threadId) => {
    const settingsManager = await deps.createSettingsManager(ctx.cwd);
    return deps.runtime.buildState({
      chatId,
      threadId,
      activeModel: deps.getActiveModel(ctx),
      ctx,
      reloadSettings: async () => {
        await settingsManager.reload?.();
      },
      getConfiguredScopedModelPatterns: () =>
        settingsManager.getEnabledModels(),
    });
  };
}

export async function resolveCachedBaleModelMenuInputs<
  TModel extends MenuModel = MenuModel,
>(
  cachedInputs: CachedBaleModelMenuInputs<TModel> | undefined,
  deps: BaleModelMenuInputCacheDeps<TModel>,
): Promise<CachedBaleModelMenuInputs<TModel>> {
  const now = deps.now ?? Date.now();
  if (cachedInputs && cachedInputs.expiresAt > now) return cachedInputs;
  await deps.reloadSettings();
  const availableModels = deps.refreshAvailableModels();
  const cliScopedModelPatterns = deps.getCliScopedModelPatterns();
  const configuredScopedModelPatterns =
    cliScopedModelPatterns ?? deps.getConfiguredScopedModelPatterns() ?? [];
  return {
    expiresAt: now + deps.cacheTtlMs,
    availableModels,
    configuredScopedModelPatterns,
    cliScopedModelPatterns,
  };
}

export function buildBaleModelMenuState<
  TModel extends MenuModel = MenuModel,
>(
  params: BuildBaleModelMenuStateParams<TModel>,
): BaleModelMenuState<TModel> {
  const allModels = sortScopedModels(
    params.availableModels.map((model) => ({ model })),
    params.activeModel,
  );
  const scopedModels =
    params.configuredScopedModelPatterns.length > 0
      ? sortScopedModels(
          resolveScopedModelPatterns(
            params.configuredScopedModelPatterns,
            params.availableModels,
          ),
          params.activeModel,
        )
      : [];
  let note: string | undefined;
  if (
    params.configuredScopedModelPatterns.length > 0 &&
    scopedModels.length === 0
  ) {
    note = params.cliScopedModelPatterns
      ? "No CLI scoped models matched the current auth configuration. Showing all available models."
      : "No scoped models matched the current auth configuration. Showing all available models.";
  }
  return {
    chatId: params.chatId,
    threadId: params.threadId,
    messageId: 0,
    page: 0,
    scope: scopedModels.length > 0 ? "scoped" : "all",
    scopedModels,
    allModels,
    note,
    selectedModelIndex: undefined,
    scopedModelPatterns: params.configuredScopedModelPatterns,
    canMutateScope: !params.cliScopedModelPatterns,
    mode: "status",
  };
}

export async function buildBaleModelMenuStateRuntime<
  TContext extends BaleModelMenuRuntimeContext<TModel>,
  TModel extends MenuModel = MenuModel,
>(
  options: BaleModelMenuRuntimeOptions<TContext, TModel>,
): Promise<{
  state: BaleModelMenuState<TModel>;
  cachedInputs: CachedBaleModelMenuInputs<TModel>;
}> {
  const cachedInputs = await resolveCachedBaleModelMenuInputs(
    options.cachedInputs,
    {
      cacheTtlMs: options.cacheTtlMs,
      reloadSettings: options.reloadSettings,
      refreshAvailableModels: () => {
        options.ctx.modelRegistry.refresh();
        return options.ctx.modelRegistry.getAvailable();
      },
      getConfiguredScopedModelPatterns:
        options.getConfiguredScopedModelPatterns,
      getCliScopedModelPatterns:
        options.getCliScopedModelPatterns ?? getBaleCliScopedModelPatterns,
    },
  );
  return {
    cachedInputs,
    state: buildBaleModelMenuState({
      chatId: options.chatId,
      threadId: options.threadId,
      activeModel: options.activeModel,
      availableModels: cachedInputs.availableModels,
      configuredScopedModelPatterns: cachedInputs.configuredScopedModelPatterns,
      cliScopedModelPatterns: cachedInputs.cliScopedModelPatterns,
    }),
  };
}

export function applyBaleModelScopeSelection(
  state: BaleModelMenuState,
  value: string | undefined,
): BaleMenuMutationResult {
  if (value !== "all" && value !== "scoped") return "invalid";
  if (value === state.scope) return "unchanged";
  state.scope = value;
  state.page = 0;
  return "changed";
}

export function applyBaleModelPageSelection(
  state: BaleModelMenuState,
  value: string | undefined,
): BaleMenuMutationResult {
  const page = Number(value);
  if (!Number.isFinite(page)) return "invalid";
  if (page === state.page) return "unchanged";
  state.page = page;
  return "changed";
}

export function getBaleModelSelection<TModel extends MenuModel = MenuModel>(
  state: BaleModelMenuState<TModel>,
  value: string | undefined,
): BaleMenuSelectionResult<TModel> {
  const index = Number(value);
  if (!Number.isFinite(index)) return { kind: "invalid" };
  const selection = getModelMenuItems(state)[index];
  if (!selection) return { kind: "missing" };
  return { kind: "selected", selection };
}

function applyBaleModelDetailSelection(
  state: BaleModelMenuState,
  value: string | undefined,
): BaleMenuMutationResult {
  const index = Number(value);
  if (!Number.isFinite(index)) return "invalid";
  const selection = getModelMenuItems(state)[index];
  if (!selection) return "invalid";
  state.selectedModelIndex = index;
  state.selectedModelKey = getCanonicalModelId(selection.model);
  state.mode = "model-detail";
  return "changed";
}

function getBaleSelectedDetailModel<TModel extends MenuModel = MenuModel>(
  state: BaleModelMenuState<TModel>,
): BaleMenuSelectionResult<TModel> {
  const indexedSelection = getBaleModelSelection(
    state,
    state.selectedModelIndex?.toString(),
  );
  if (indexedSelection.kind === "selected") {
    if (!state.selectedModelKey) return indexedSelection;
    const indexedKey = getCanonicalModelId(
      indexedSelection.selection.model,
    ).toLowerCase();
    if (indexedKey === state.selectedModelKey.toLowerCase()) {
      return indexedSelection;
    }
  }
  if (state.selectedModelKey) {
    const lowerKey = state.selectedModelKey.toLowerCase();
    const selection = state.allModels.find(
      (entry) => getCanonicalModelId(entry.model).toLowerCase() === lowerKey,
    );
    if (selection) return { kind: "selected", selection };
  }
  return indexedSelection;
}

function isBaleModelScoped(
  state: BaleModelMenuState,
  model: MenuModel,
): boolean {
  const key = getCanonicalModelId(model);
  return state.scopedModels.some(
    (entry) => getCanonicalModelId(entry.model) === key,
  );
}

function focusBaleModelListPage(
  state: BaleModelMenuState,
  model: MenuModel,
  pageSize = BALE_MODEL_PAGE_SIZE,
): void {
  const key = getCanonicalModelId(model).toLowerCase();
  const index = getModelMenuItems(state).findIndex(
    (entry) => getCanonicalModelId(entry.model).toLowerCase() === key,
  );
  state.page = index < 0 ? 0 : Math.floor(index / pageSize);
  state.mode = "model";
}

function formatScopedModelPattern(entry: ScopedBaleModel): string {
  const key = getCanonicalModelId(entry.model);
  return entry.thinkingLevel ? `${key}:${entry.thinkingLevel}` : key;
}

function setBaleModelScope(
  state: BaleModelMenuState,
  model: MenuModel,
  enabled: boolean,
): { patterns: string[]; enabled: boolean } {
  const key = getCanonicalModelId(model);
  const lowerKey = key.toLowerCase();
  const scopedModelPatterns = state.scopedModelPatterns ?? [];
  const allModels = state.allModels.map((entry) => entry.model);
  const patterns: string[] = [];
  for (const pattern of scopedModelPatterns) {
    const resolved = resolveScopedModelPatterns([pattern], allModels);
    const matchesModel = resolved.some(
      (entry) => getCanonicalModelId(entry.model).toLowerCase() === lowerKey,
    );
    if (enabled || !matchesModel) {
      if (pattern.toLowerCase() !== lowerKey) patterns.push(pattern);
      continue;
    }
    for (const entry of resolved) {
      if (getCanonicalModelId(entry.model).toLowerCase() === lowerKey) continue;
      const expandedPattern = formatScopedModelPattern(entry);
      const duplicated = patterns.some(
        (item) => item.toLowerCase() === expandedPattern.toLowerCase(),
      );
      if (!duplicated) patterns.push(expandedPattern);
    }
  }
  if (enabled) patterns.push(key);
  state.scopedModelPatterns = patterns;
  state.scopedModels = sortScopedModels(
    resolveScopedModelPatterns(
      patterns,
      state.allModels.map((entry) => entry.model),
    ),
    model,
  );
  if (state.scope === "scoped" && state.scopedModels.length === 0) {
    state.scope = "all";
  }
  return { patterns, enabled };
}

export function buildBaleModelCallbackPlan<
  TModel extends MenuModel = MenuModel,
>(
  params: BuildBaleModelCallbackPlanParams<TModel>,
): BaleModelCallbackPlan<TModel> {
  const action = parseBaleModelMenuCallbackAction(params.data);
  if (!action) return { kind: "ignore" };
  if (action.action === "noop") return { kind: "answer" };
  if (action.action === "scope") {
    const scopeResult = applyBaleModelScopeSelection(
      params.state,
      action.value,
    );
    if (scopeResult === "invalid") {
      return { kind: "answer", text: "Unknown model scope." };
    }
    if (scopeResult === "unchanged") {
      return { kind: "answer" };
    }
    return {
      kind: "update-menu",
      text: params.state.scope === "scoped" ? "Scoped models" : "All models",
    };
  }
  if (action.action === "pages") {
    if (action.value === "back") {
      params.state.mode = "model";
      return { kind: "update-menu" };
    }
    params.state.mode = "model-pages";
    return { kind: "update-menu" };
  }
  if (action.action === "page") {
    const pageResult = applyBaleModelPageSelection(
      params.state,
      action.value,
    );
    if (pageResult === "invalid") {
      return { kind: "answer", text: "Invalid page." };
    }
    params.state.mode = "model";
    if (pageResult === "unchanged") {
      return { kind: "update-menu" };
    }
    return { kind: "update-menu" };
  }
  if (action.action === "open") {
    const detailResult = applyBaleModelDetailSelection(
      params.state,
      action.value,
    );
    if (detailResult === "invalid") {
      return { kind: "answer", text: "Selected model is no longer available" };
    }
    return { kind: "update-menu" };
  }
  if (
    action.action === "scope-toggle" ||
    action.action === "scope-enable" ||
    action.action === "scope-disable"
  ) {
    if (params.state.canMutateScope === false) {
      return {
        kind: "answer",
        text: "Model scope is controlled by CLI --models",
      };
    }
    const selectionResult = getBaleSelectedDetailModel(params.state);
    if (selectionResult.kind !== "selected") {
      return { kind: "answer", text: "Selected model is no longer available" };
    }
    const model = selectionResult.selection.model;
    const enabled =
      action.action === "scope-toggle"
        ? !isBaleModelScoped(params.state, model)
        : action.action === "scope-enable";
    if (enabled === isBaleModelScoped(params.state, model)) {
      return { kind: "answer" };
    }
    const result = setBaleModelScope(params.state, model, enabled);
    return {
      kind: "persist-scope",
      patterns: result.patterns,
      text: result.enabled
        ? "Added to scoped models"
        : "Removed from scoped models",
    };
  }
  if (action.action !== "pick" && action.action !== "pick-selected") {
    return { kind: "answer" };
  }
  const selectionResult =
    action.action === "pick-selected"
      ? getBaleSelectedDetailModel(params.state)
      : getBaleModelSelection(params.state, action.value);
  if (selectionResult.kind === "invalid") {
    return { kind: "answer", text: "Invalid model selection" };
  }
  if (selectionResult.kind === "missing") {
    return { kind: "answer", text: "Selected model is no longer available" };
  }
  const selection = selectionResult.selection;
  if (modelsMatch(selection.model, params.activeModel)) {
    if (action.action === "pick-selected") {
      focusBaleModelListPage(params.state, selection.model);
    }
    return {
      kind: "refresh-status",
      selection,
      callbackText: `Model: ${selection.model.id}`,
      shouldApplyThinkingLevel:
        !!selection.thinkingLevel &&
        selection.thinkingLevel !== params.currentThinkingLevel,
    };
  }
  if (!params.isIdle) {
    if (!params.canRestartBusyRun) {
      return {
        kind: "answer",
        text: "Pi is busy. Send /abort, /next, or /stop",
      };
    }
    return {
      kind: "switch-model",
      selection,
      mode: params.hasActiveToolExecutions
        ? "restart-after-tool"
        : "restart-now",
      callbackText: params.hasActiveToolExecutions
        ? `Switched to ${selection.model.id}. Restarting after the current tool finishes…`
        : `Switching to ${selection.model.id} and continuing…`,
    };
  }
  return {
    kind: "switch-model",
    selection,
    mode: "idle",
    callbackText: `Switched to ${selection.model.id}`,
  };
}

export async function openBaleModelMenu<
  TModel extends MenuModel = MenuModel,
>(deps: BaleModelMenuOpenDeps<TModel>): Promise<void> {
  if (!deps.isIdle() && !deps.canOfferInFlightModelSwitch()) {
    await deps.sendBusyMessage();
    return;
  }
  const state = await deps.getModelMenuState();
  if (state.allModels.length === 0) {
    await deps.sendNoModelsMessage();
    return;
  }
  const messageId = await deps.sendModelMenu(state, deps.getActiveModel());
  if (messageId === undefined) return;
  state.messageId = messageId;
  state.mode = "model";
  deps.storeModelMenuState(state);
}

export async function handleBaleModelMenuCallbackAction<
  TModel extends MenuModel = MenuModel,
>(
  callbackQueryId: string,
  params: BuildBaleModelCallbackPlanParams<TModel>,
  deps: BaleModelMenuCallbackDeps<TModel>,
): Promise<boolean> {
  const plan = buildBaleModelCallbackPlan(params);
  if (plan.kind === "ignore") return false;
  if (plan.kind === "answer") {
    await deps.answerCallbackQuery(callbackQueryId, plan.text);
    return true;
  }
  if (plan.kind === "update-menu") {
    await deps.updateModelMenuMessage();
    await deps.answerCallbackQuery(callbackQueryId, plan.text);
    return true;
  }
  if (plan.kind === "persist-scope") {
    if (!deps.persistScopedModelPatterns) {
      await deps.answerCallbackQuery(
        callbackQueryId,
        "Scoped model persistence is unavailable",
      );
      return true;
    }
    await deps.persistScopedModelPatterns(plan.patterns);
    await deps.updateModelMenuMessage();
    await deps.answerCallbackQuery(callbackQueryId, plan.text);
    return true;
  }
  if (plan.kind === "refresh-status") {
    if (plan.shouldApplyThinkingLevel && plan.selection.thinkingLevel) {
      deps.setThinkingLevel(plan.selection.thinkingLevel);
    }
    await deps.updateModelMenuMessage();
    await deps.answerCallbackQuery(callbackQueryId, plan.callbackText);
    return true;
  }
  const changed = await deps.setModel(plan.selection.model);
  if (changed === false) {
    await deps.answerCallbackQuery(callbackQueryId, "Model is not available");
    return true;
  }
  deps.setCurrentModel(plan.selection.model);
  if (plan.selection.thinkingLevel) {
    deps.setThinkingLevel(plan.selection.thinkingLevel);
  }
  const continuationTurn: BaleModelSwitchContinuationSource = {
    chatId: params.state.chatId,
    replyToMessageId: params.state.messageId,
    target: {
      chatId: params.state.chatId,
      ...(params.state.threadId === undefined
        ? {}
        : { threadId: params.state.threadId }),
    },
  };
  if (plan.mode === "restart-after-tool") {
    deps.stagePendingModelSwitch(plan.selection, continuationTurn);
    await deps.updateModelMenuMessage();
    await deps.answerCallbackQuery(callbackQueryId, plan.callbackText);
    return true;
  }
  if (plan.mode === "restart-now") {
    const restarted = await deps.restartInterruptedBaleTurn(
      plan.selection,
      continuationTurn,
    );
    await deps.updateModelMenuMessage();
    if (!restarted) {
      await deps.answerCallbackQuery(
        callbackQueryId,
        "Pi is busy. Send /abort, /next, or /stop",
      );
      return true;
    }
  } else {
    await deps.updateModelMenuMessage();
  }
  await deps.answerCallbackQuery(callbackQueryId, plan.callbackText);
  return true;
}

export function getBaleModelMenuPage(
  state: BaleModelMenuState,
  pageSize: number,
): BaleModelMenuPage {
  const items = getModelMenuItems(state);
  const pageCount = Math.max(1, Math.ceil(items.length / pageSize));
  const page = Math.max(0, Math.min(state.page, pageCount - 1));
  const start = page * pageSize;
  return {
    page,
    pageCount,
    start,
    items: items.slice(start, start + pageSize),
  };
}

export function buildModelMenuReplyMarkup(
  state: BaleModelMenuState,
  currentModel: MenuModel | undefined,
  pageSize: number,
): BaleReplyMarkup {
  const menuPage = getBaleModelMenuPage(state, pageSize);
  const rows = [[{ text: "⬆️ Main menu", callback_data: "menu:back" }]];
  if (state.scopedModels.length > 0) {
    rows.push([
      {
        text: state.scope === "scoped" ? "🟡 Scoped" : "⚫️ Scoped",
        callback_data: "model:scope:scoped",
      },
      {
        text: state.scope === "all" ? "🟣 All" : "⚫️ All",
        callback_data: "model:scope:all",
      },
    ]);
  }
  const previousPage =
    menuPage.page === 0 ? menuPage.pageCount - 1 : menuPage.page - 1;
  const nextPage =
    menuPage.page === menuPage.pageCount - 1 ? 0 : menuPage.page + 1;
  if (menuPage.pageCount > 1) {
    rows.push([
      { text: "⬅️", callback_data: `model:page:${previousPage}` },
      {
        text: `${menuPage.page + 1}/${menuPage.pageCount}`,
        callback_data: "model:pages",
      },
      { text: "➡️", callback_data: `model:page:${nextPage}` },
    ]);
  }
  rows.push(
    ...menuPage.items.map((entry, index) => [
      {
        text: formatScopedModelButtonText(entry, currentModel),
        callback_data: `model:open:${menuPage.start + index}`,
      },
    ]),
  );
  return { inline_keyboard: rows };
}

function buildModelDetailMenuReplyMarkup(
  state: BaleModelMenuState,
  currentModel: MenuModel | undefined,
): BaleReplyMarkup {
  const selection = getBaleSelectedDetailModel(state);
  if (selection.kind !== "selected") {
    return {
      inline_keyboard: [
        [{ text: "⬆️ Back", callback_data: "model:pages:back" }],
      ],
    };
  }
  const model = selection.selection.model;
  const active = modelsMatch(model, currentModel);
  const scoped = isBaleModelScoped(state, model);
  return {
    inline_keyboard: [
      [{ text: "⬆️ Back", callback_data: "model:pages:back" }],
      [
        {
          text: active ? "🟢 Active" : "☑️ Activate",
          callback_data: "model:pick-selected",
        },
      ],
      [
        {
          text: scoped ? "🟡 Scoped" : "⚫️ Scoped",
          callback_data: "model:scope-enable",
        },
        {
          text: scoped ? "⚫️ All" : "🟣 All",
          callback_data: "model:scope-disable",
        },
      ],
    ],
  };
}

function buildModelDetailMenuText(state: BaleModelMenuState): string {
  const selection = getBaleSelectedDetailModel(state);
  if (selection.kind !== "selected") return MODEL_DETAIL_MENU_TITLE;
  const model = selection.selection.model;
  return `${MODEL_DETAIL_MENU_TITLE}\n${getCanonicalModelId(model)}`;
}

export function buildModelPageMenuReplyMarkup(
  state: BaleModelMenuState,
  pageSize: number,
): BaleReplyMarkup {
  const menuPage = getBaleModelMenuPage(state, pageSize);
  const rows = [[{ text: "⬆️ Back", callback_data: "model:pages:back" }]];
  for (
    let page = 0;
    page < menuPage.pageCount;
    page += BALE_MODEL_PAGE_PICKER_ROW_SIZE
  ) {
    rows.push(
      Array.from(
        {
          length: Math.min(
            BALE_MODEL_PAGE_PICKER_ROW_SIZE,
            menuPage.pageCount - page,
          ),
        },
        (_unused, offset) => {
          const pageIndex = page + offset;
          return {
            text:
              pageIndex === menuPage.page
                ? `🟣 ${pageIndex + 1}`
                : String(pageIndex + 1),
            callback_data: `model:page:${pageIndex}`,
          };
        },
      ),
    );
  }
  return { inline_keyboard: rows };
}

export function buildBaleModelPageMenuRenderPayload(
  state: BaleModelMenuState,
): BaleMenuRenderPayload {
  return {
    nextMode: "model-pages",
    text: MODEL_PAGE_MENU_TITLE,
    mode: "html",
    replyMarkup: buildModelPageMenuReplyMarkup(state, BALE_MODEL_PAGE_SIZE),
  };
}

export function buildBaleModelMenuRenderPayload(
  state: BaleModelMenuState,
  activeModel: MenuModel | undefined,
): BaleMenuRenderPayload {
  if (state.mode === "model-pages") {
    return buildBaleModelPageMenuRenderPayload(state);
  }
  if (state.mode === "model-detail") {
    return {
      nextMode: "model-detail",
      text: buildModelDetailMenuText(state),
      mode: "html",
      replyMarkup: buildModelDetailMenuReplyMarkup(state, activeModel),
    };
  }
  return {
    nextMode: "model",
    text: MODEL_MENU_TITLE,
    mode: "html",
    replyMarkup: buildModelMenuReplyMarkup(
      state,
      activeModel,
      BALE_MODEL_PAGE_SIZE,
    ),
  };
}

export async function updateBaleModelMenuMessage(
  state: BaleModelMenuState,
  activeModel: MenuModel | undefined,
  deps: BaleMenuMessageRuntimeDeps,
): Promise<void> {
  await editBaleMenuMessage(
    state,
    buildBaleModelMenuRenderPayload(state, activeModel),
    deps,
  );
}

export function sendBaleModelMenuMessage(
  state: BaleModelMenuState,
  activeModel: MenuModel | undefined,
  deps: BaleMenuMessageRuntimeDeps,
): Promise<number | undefined> {
  return sendBaleMenuMessage(
    state,
    buildBaleModelMenuRenderPayload(state, activeModel),
    deps,
  );
}

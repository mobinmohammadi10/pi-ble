/**
 * Bale model control domain helpers
 * Zones: pi agent model control, bale controls, queue continuation
 * Owns model identity, thinking levels, scoped resolution, current-model state, and in-flight model switching
 */

import * as Machine from "./machine.ts";
import {
  truncateBaleQueueSummary,
  type PendingBaleTurn,
} from "./queue.ts";
import { BALE_PREFIX } from "./turns.ts";

export interface MenuModel {
  provider: string;
  id: string;
  name?: string;
  reasoning?: boolean;
}

export type ThinkingLevel =
  "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface ScopedBaleModel<TModel extends MenuModel = MenuModel> {
  model: TModel;
  thinkingLevel?: ThinkingLevel;
}

export const THINKING_LEVELS: readonly ThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

export interface CurrentModelStore<
  TContext,
  TModel extends MenuModel = MenuModel,
> {
  get: (ctx: TContext) => TModel | undefined;
  getStored: () => TModel | undefined;
  set: (model: TModel | undefined) => void;
}

export interface CurrentModelUpdateRuntime<
  TContext,
  TModel extends MenuModel = MenuModel,
> {
  setCurrentModel: (model: TModel | undefined, ctx: TContext) => void;
  onModelSelect: (event: { model: TModel | undefined }, ctx: TContext) => void;
}

export type CurrentModelRuntime<
  TContext,
  TModel extends MenuModel = MenuModel,
> = CurrentModelStore<TContext, TModel> &
  CurrentModelUpdateRuntime<TContext, TModel>;

export function createCurrentModelStore<
  TContext,
  TModel extends MenuModel = MenuModel,
>(
  getContextModel: (ctx: TContext) => TModel | undefined,
): CurrentModelStore<TContext, TModel> {
  let currentModel: TModel | undefined;
  return {
    get: (ctx) => currentModel ?? getContextModel(ctx),
    getStored: () => currentModel,
    set: (model) => {
      currentModel = model;
    },
  };
}

export function createCurrentModelUpdateRuntime<
  TContext,
  TModel extends MenuModel = MenuModel,
>(deps: {
  setCurrentModel: (model: TModel | undefined) => void;
  updateStatus: (ctx: TContext) => void;
}): CurrentModelUpdateRuntime<TContext, TModel> {
  const setAndUpdate = (model: TModel | undefined, ctx: TContext): void => {
    deps.setCurrentModel(model);
    deps.updateStatus(ctx);
  };
  return {
    setCurrentModel: setAndUpdate,
    onModelSelect: (event, ctx) => {
      setAndUpdate(event.model, ctx);
    },
  };
}

export function createCurrentModelRuntime<
  TContext,
  TModel extends MenuModel = MenuModel,
>(deps: {
  getContextModel: (ctx: TContext) => TModel | undefined;
  updateStatus: (ctx: TContext) => void;
}): CurrentModelRuntime<TContext, TModel> {
  const store = createCurrentModelStore(deps.getContextModel);
  return {
    ...store,
    ...createCurrentModelUpdateRuntime({
      setCurrentModel: store.set,
      updateStatus: deps.updateStatus,
    }),
  };
}

export function modelsMatch(
  a: Pick<MenuModel, "provider" | "id"> | undefined,
  b: Pick<MenuModel, "provider" | "id"> | undefined,
): boolean {
  return !!a && !!b && a.provider === b.provider && a.id === b.id;
}

export function getCanonicalModelId(
  model: Pick<MenuModel, "provider" | "id">,
): string {
  return `${model.provider}/${model.id}`;
}

export function isThinkingLevel(value: string): value is ThinkingLevel {
  return THINKING_LEVELS.includes(value as ThinkingLevel);
}

export function parseBaleScopedModelPatternList(value: string): string[] {
  return value
    .split(",")
    .map((pattern) => pattern.trim())
    .filter(Boolean);
}

export function parseBaleCliScopedModelPatterns(
  args: string[],
): string[] | undefined {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--models") {
      const patterns = parseBaleScopedModelPatternList(args[i + 1] ?? "");
      return patterns.length > 0 ? patterns : undefined;
    }
    if (arg.startsWith("--models=")) {
      const patterns = parseBaleScopedModelPatternList(
        arg.slice("--models=".length),
      );
      return patterns.length > 0 ? patterns : undefined;
    }
  }
  return undefined;
}

function escapeRegex(text: string): string {
  return text.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

function globMatches(text: string, pattern: string): boolean {
  let regex = "^";
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];
    if (char === "*") {
      regex += ".*";
      continue;
    }
    if (char === "?") {
      regex += ".";
      continue;
    }
    if (char === "[") {
      const end = pattern.indexOf("]", i + 1);
      if (end !== -1) {
        const content = pattern.slice(i + 1, end);
        regex += content.startsWith("!")
          ? `[^${content.slice(1)}]`
          : `[${content}]`;
        i = end;
        continue;
      }
    }
    regex += escapeRegex(char);
  }
  regex += "$";
  return new RegExp(regex, "i").test(text);
}

function isAliasModelId(id: string): boolean {
  if (id.endsWith("-latest")) return true;
  return !/-\d{8}$/.test(id);
}

function findUniqueModelMatch<TModel extends MenuModel>(
  availableModels: TModel[],
  matches: (model: TModel) => boolean,
): { model?: TModel; ambiguous: boolean } {
  let model: TModel | undefined;
  for (const candidate of availableModels) {
    if (!matches(candidate)) continue;
    if (model) return { ambiguous: true };
    model = candidate;
  }
  return { model, ambiguous: false };
}

function findExactModelReferenceMatch<TModel extends MenuModel = MenuModel>(
  modelReference: string,
  availableModels: TModel[],
): TModel | undefined {
  const trimmedReference = modelReference.trim();
  if (!trimmedReference) return undefined;
  const normalizedReference = trimmedReference.toLowerCase();
  const canonicalMatch = findUniqueModelMatch(
    availableModels,
    (model) => getCanonicalModelId(model).toLowerCase() === normalizedReference,
  );
  if (canonicalMatch.model || canonicalMatch.ambiguous) {
    return canonicalMatch.model;
  }
  const slashIndex = trimmedReference.indexOf("/");
  if (slashIndex !== -1) {
    const provider = trimmedReference.substring(0, slashIndex).trim();
    const modelId = trimmedReference.substring(slashIndex + 1).trim();
    if (provider && modelId) {
      const normalizedProvider = provider.toLowerCase();
      const normalizedModelId = modelId.toLowerCase();
      const providerMatch = findUniqueModelMatch(
        availableModels,
        (model) =>
          model.provider.toLowerCase() === normalizedProvider &&
          model.id.toLowerCase() === normalizedModelId,
      );
      if (providerMatch.model || providerMatch.ambiguous) {
        return providerMatch.model;
      }
    }
  }
  return findUniqueModelMatch(
    availableModels,
    (model) => model.id.toLowerCase() === normalizedReference,
  ).model;
}

function tryMatchScopedModel<TModel extends MenuModel = MenuModel>(
  modelPattern: string,
  availableModels: TModel[],
): TModel | undefined {
  const exactMatch = findExactModelReferenceMatch(
    modelPattern,
    availableModels,
  );
  if (exactMatch) return exactMatch;
  const normalizedPattern = modelPattern.toLowerCase();
  let bestAlias: TModel | undefined;
  let bestDatedVersion: TModel | undefined;
  for (const model of availableModels) {
    if (
      !model.id.toLowerCase().includes(normalizedPattern) &&
      !model.name?.toLowerCase().includes(normalizedPattern)
    ) {
      continue;
    }
    if (isAliasModelId(model.id)) {
      if (!bestAlias || model.id.localeCompare(bestAlias.id) > 0) {
        bestAlias = model;
      }
    } else if (
      !bestDatedVersion ||
      model.id.localeCompare(bestDatedVersion.id) > 0
    ) {
      bestDatedVersion = model;
    }
  }
  return bestAlias ?? bestDatedVersion;
}

function parseScopedModelPattern<TModel extends MenuModel = MenuModel>(
  pattern: string,
  availableModels: TModel[],
): { model: TModel | undefined; thinkingLevel?: ThinkingLevel } {
  const exactMatch = tryMatchScopedModel(pattern, availableModels);
  if (exactMatch) {
    return { model: exactMatch, thinkingLevel: undefined };
  }
  const lastColonIndex = pattern.lastIndexOf(":");
  if (lastColonIndex === -1) {
    return { model: undefined, thinkingLevel: undefined };
  }
  const prefix = pattern.substring(0, lastColonIndex);
  const suffix = pattern.substring(lastColonIndex + 1);
  if (isThinkingLevel(suffix)) {
    const parsedPrefix = parseScopedModelPattern(prefix, availableModels);
    if (parsedPrefix.model) {
      return { model: parsedPrefix.model, thinkingLevel: suffix };
    }
    return parsedPrefix;
  }
  return parseScopedModelPattern(prefix, availableModels);
}

export function resolveScopedModelPatterns<
  TModel extends MenuModel = MenuModel,
>(
  patterns: string[],
  availableModels: TModel[],
): ScopedBaleModel<TModel>[] {
  const resolved: ScopedBaleModel<TModel>[] = [];
  const seen = new Set<string>();
  for (const pattern of patterns) {
    if (
      pattern.includes("*") ||
      pattern.includes("?") ||
      pattern.includes("[")
    ) {
      const colonIndex = pattern.lastIndexOf(":");
      let globPattern = pattern;
      let thinkingLevel: ThinkingLevel | undefined;
      if (colonIndex !== -1) {
        const suffix = pattern.substring(colonIndex + 1);
        if (isThinkingLevel(suffix)) {
          thinkingLevel = suffix;
          globPattern = pattern.substring(0, colonIndex);
        }
      }
      const matches = availableModels.filter(
        (model) =>
          globMatches(getCanonicalModelId(model), globPattern) ||
          globMatches(model.id, globPattern),
      );
      for (const model of matches) {
        const key = getCanonicalModelId(model);
        if (seen.has(key)) continue;
        seen.add(key);
        resolved.push({ model, thinkingLevel });
      }
      continue;
    }
    const matched = parseScopedModelPattern(pattern, availableModels);
    if (!matched.model) continue;
    const key = getCanonicalModelId(matched.model);
    if (seen.has(key)) continue;
    seen.add(key);
    resolved.push({
      model: matched.model,
      thinkingLevel: matched.thinkingLevel,
    });
  }
  return resolved;
}

export function sortScopedModels<TModel extends MenuModel = MenuModel>(
  models: ScopedBaleModel<TModel>[],
  currentModel: TModel | undefined,
): ScopedBaleModel<TModel>[] {
  const sorted = [...models];
  sorted.sort((a, b) => {
    const aIsCurrent = modelsMatch(a.model, currentModel);
    const bIsCurrent = modelsMatch(b.model, currentModel);
    if (aIsCurrent && !bIsCurrent) return -1;
    if (!aIsCurrent && bIsCurrent) return 1;
    const providerCompare = a.model.provider.localeCompare(b.model.provider);
    if (providerCompare !== 0) return providerCompare;
    return a.model.id.localeCompare(b.model.id);
  });
  return sorted;
}

// --- In-Flight Model Switching ---

export interface BaleInFlightModelSwitchState {
  isIdle: boolean;
  hasAbortHandler: boolean;
}

export function canRestartAgentRunForBaleModelSwitch(
  state: BaleInFlightModelSwitchState,
): boolean {
  return !state.isIdle && state.hasAbortHandler;
}

export function shouldTriggerPendingBaleModelSwitchAbort(state: {
  hasPendingModelSwitch: boolean;
  hasContinuationTurn: boolean;
  hasAbortHandler: boolean;
  activeToolExecutions: number;
}): boolean {
  return (
    state.hasPendingModelSwitch &&
    state.hasContinuationTurn &&
    state.hasAbortHandler &&
    state.activeToolExecutions === 0
  );
}

export function buildBaleModelSwitchContinuationText<
  TModel extends MenuModel,
>(
  balePrefix: string,
  model: TModel,
  thinkingLevel?: ScopedBaleModel<TModel>["thinkingLevel"],
): string {
  const modelLabel = `${model.provider}/${model.id}`;
  const thinkingSuffix = thinkingLevel ? `; thinking: ${thinkingLevel}` : "";
  return `${balePrefix} Continue from the last unfinished step. Model: ${modelLabel}${thinkingSuffix}.`;
}

export type BaleModelSwitchContinuationSource = Pick<
  PendingBaleTurn,
  "chatId" | "replyToMessageId" | "target"
>;

export function buildBaleModelSwitchContinuationTurn<
  TModel extends MenuModel,
>(options: {
  turn: BaleModelSwitchContinuationSource;
  selection: ScopedBaleModel<TModel>;
  balePrefix?: string;
  queueOrder: number;
  laneOrder: number;
}): PendingBaleTurn {
  const modelLabel = `${options.selection.model.provider}/${options.selection.model.id}`;
  const statusLabel = truncateBaleQueueSummary(
    `continue on ${options.selection.model.id}`,
    4,
    32,
  );
  return {
    kind: "prompt",
    chatId: options.turn.chatId,
    ...(options.turn.target ? { target: { ...options.turn.target } } : {}),
    replyToMessageId: options.turn.replyToMessageId,
    sourceMessageIds: [],
    queueOrder: options.queueOrder,
    queueLane: "control",
    laneOrder: options.laneOrder,
    queuedAttachments: [],
    content: [
      {
        type: "text",
        text: buildBaleModelSwitchContinuationText(
          options.balePrefix ?? BALE_PREFIX,
          options.selection.model,
          options.selection.thinkingLevel,
        ),
      },
    ],
    historyText: `Continue interrupted request on ${modelLabel}`,
    statusSummary: `↻ ${statusLabel || "continue"}`,
  };
}

export function createBaleModelSwitchContinuationTurnBuilder<
  TModel extends MenuModel,
>(deps: {
  balePrefix?: string;
  allocateItemOrder: () => number;
  allocateControlOrder: () => number;
}): (options: {
  turn: BaleModelSwitchContinuationSource;
  selection: ScopedBaleModel<TModel>;
}) => PendingBaleTurn {
  return (options) =>
    buildBaleModelSwitchContinuationTurn({
      ...options,
      balePrefix: deps.balePrefix,
      queueOrder: deps.allocateItemOrder(),
      laneOrder: deps.allocateControlOrder(),
    });
}

export function createBaleModelSwitchContinuationQueue<
  TContext,
  TSelection extends ScopedBaleModel,
>(deps: {
  createContinuationTurn: (options: {
    turn: BaleModelSwitchContinuationSource;
    selection: TSelection;
  }) => PendingBaleTurn;
  appendQueuedItem: (item: PendingBaleTurn, ctx: TContext) => void;
}): (
  turn: BaleModelSwitchContinuationSource,
  selection: TSelection,
  ctx: TContext,
) => void {
  return (turn, selection, ctx) => {
    deps.appendQueuedItem(
      deps.createContinuationTurn({ turn, selection }),
      ctx,
    );
  };
}

export function createBaleModelSwitchContinuationQueueRuntime<
  TContext,
  TSelection extends ScopedBaleModel,
>(deps: {
  balePrefix?: string;
  allocateItemOrder: () => number;
  allocateControlOrder: () => number;
  appendQueuedItem: (item: PendingBaleTurn, ctx: TContext) => void;
}): (
  turn: BaleModelSwitchContinuationSource,
  selection: TSelection,
  ctx: TContext,
) => void {
  return createBaleModelSwitchContinuationQueue<TContext, TSelection>({
    createContinuationTurn: createBaleModelSwitchContinuationTurnBuilder({
      balePrefix: deps.balePrefix,
      allocateItemOrder: deps.allocateItemOrder,
      allocateControlOrder: deps.allocateControlOrder,
    }),
    appendQueuedItem: deps.appendQueuedItem,
  });
}

export interface BaleModelSwitchControllerDeps<TContext, TSelection> {
  isIdle: (ctx: TContext) => boolean;
  getActiveTurn: () => PendingBaleTurn | undefined;
  getAbortHandler: () => (() => void) | undefined;
  hasAbortHandler: () => boolean;
  getActiveToolExecutions: () => number;
  queueContinuation: (
    turn: BaleModelSwitchContinuationSource,
    selection: TSelection,
    ctx: TContext,
  ) => void;
  updateStatus: (ctx: TContext) => void;
}

export interface BaleModelSwitchController<TContext, TSelection> {
  canOfferInFlightSwitch: (ctx: TContext) => boolean;
  /** A staged switch waits for its abort; queue dispatch and live-work observation treat it as pending control. */
  hasPendingSwitch: () => boolean;
  stagePendingSwitch: (
    selection: TSelection,
    ctx: TContext,
    continuationTurn?: BaleModelSwitchContinuationSource,
  ) => void;
  clearPendingSwitch: () => void;
  queueContinuation: (
    turn: BaleModelSwitchContinuationSource,
    selection: TSelection,
    ctx: TContext,
  ) => void;
  triggerPendingAbort: (ctx: TContext) => boolean;
  restartInterruptedTurn: (
    selection: TSelection,
    ctx: TContext,
    continuationTurn?: BaleModelSwitchContinuationSource,
  ) => boolean;
}

export interface BaleModelSwitchControllerRuntimeDeps<
  TContext,
  TSelection extends ScopedBaleModel,
> extends Omit<
  BaleModelSwitchControllerDeps<TContext, TSelection>,
  "queueContinuation"
> {
  balePrefix?: string;
  allocateItemOrder: () => number;
  allocateControlOrder: () => number;
  appendQueuedItem: (item: PendingBaleTurn, ctx: TContext) => void;
}

export function createBaleModelSwitchControllerRuntime<
  TContext,
  TSelection extends ScopedBaleModel,
>(
  deps: BaleModelSwitchControllerRuntimeDeps<TContext, TSelection>,
): BaleModelSwitchController<TContext, TSelection> {
  return createBaleModelSwitchController({
    isIdle: deps.isIdle,
    getActiveTurn: deps.getActiveTurn,
    getAbortHandler: deps.getAbortHandler,
    hasAbortHandler: deps.hasAbortHandler,
    getActiveToolExecutions: deps.getActiveToolExecutions,
    queueContinuation: createBaleModelSwitchContinuationQueueRuntime({
      balePrefix: deps.balePrefix,
      allocateItemOrder: deps.allocateItemOrder,
      allocateControlOrder: deps.allocateControlOrder,
      appendQueuedItem: deps.appendQueuedItem,
    }),
    updateStatus: deps.updateStatus,
  });
}

/** The whole model-switch state; only `transitionBaleModelSwitch` produces a new one. */
export interface BaleModelSwitchMachineState<TSelection> {
  /** One staged switch: the selection and the turn its continuation answers move and clear together. */
  readonly pending: {
    readonly selection: TSelection;
    /** The active Bale turn at staging, or the model menu's own target for a local run. */
    readonly turn?: BaleModelSwitchContinuationSource;
  } | null;
}

/** Facts owned by other domains, sampled by the shell when the event is dispatched. */
interface BaleModelSwitchRunFacts {
  activeTurn?: BaleModelSwitchContinuationSource;
  hasAbortHandler: boolean;
  activeToolExecutions: number;
}

export type BaleModelSwitchEvent<TSelection> =
  | {
      type: "staged";
      selection: TSelection;
      turn?: BaleModelSwitchContinuationSource;
    }
  | ({ type: "abortRequested" } & BaleModelSwitchRunFacts)
  | {
      type: "restartRequested";
      selection: TSelection;
      turn?: BaleModelSwitchContinuationSource;
      hasAbortHandler: boolean;
    }
  | { type: "cleared" };

export type BaleModelSwitchEffect<TSelection> =
  | {
      type: "queueContinuation";
      turn: BaleModelSwitchContinuationSource;
      selection: TSelection;
    }
  | { type: "abort" };

export interface BaleModelSwitchStep<
  TSelection,
> extends Machine.BaleMachineStep<
  BaleModelSwitchMachineState<TSelection>,
  BaleModelSwitchEffect<TSelection>
> {
  /** `abortRequested` / `restartRequested`: the run was stopped for a continuation. */
  result: boolean;
}

export function createBaleModelSwitchMachineState<
  TSelection,
>(): BaleModelSwitchMachineState<TSelection> {
  return { pending: null };
}

/** The continuation is queued before the abort, so the stopped run always has its successor waiting. */
const restartFor = <TSelection>(
  turn: BaleModelSwitchContinuationSource,
  selection: TSelection,
): BaleModelSwitchStep<TSelection> => ({
  state: { pending: null },
  effects: [{ type: "queueContinuation", turn, selection }, { type: "abort" }],
  result: true,
});

/**
 * Pure model-switch transition. A staged switch fires only once no tool runs and an abort handler exists; any restart
 * or clear consumes the staged switch too, so a stale selection can never abort the continuation run it started.
 */
export function transitionBaleModelSwitch<TSelection>(
  state: BaleModelSwitchMachineState<TSelection>,
  event: BaleModelSwitchEvent<TSelection>,
): BaleModelSwitchStep<TSelection> {
  const unchanged = { state, effects: [], result: false };
  switch (event.type) {
    case "staged":
      return {
        state: {
          pending: {
            selection: event.selection,
            ...(event.turn ? { turn: event.turn } : {}),
          },
        },
        effects: [],
        result: false,
      };
    case "abortRequested": {
      const pending = state.pending;
      const turn = pending?.turn ?? event.activeTurn;
      if (
        !pending ||
        !turn ||
        !shouldTriggerPendingBaleModelSwitchAbort({
          hasPendingModelSwitch: true,
          hasContinuationTurn: true,
          hasAbortHandler: event.hasAbortHandler,
          activeToolExecutions: event.activeToolExecutions,
        })
      )
        return unchanged;
      return restartFor(turn, pending.selection);
    }
    case "restartRequested":
      return event.turn && event.hasAbortHandler
        ? restartFor(event.turn, event.selection)
        : unchanged;
    case "cleared":
      return { state: { pending: null }, effects: [], result: false };
  }
}

/**
 * The shell around `transitionBaleModelSwitch`: it samples the active turn, abort handler and tool count into
 * events, and runs the continuation and abort effects with the caller's context and the handler it sampled.
 */
export function createBaleModelSwitchController<TContext, TSelection>(
  deps: BaleModelSwitchControllerDeps<TContext, TSelection>,
): BaleModelSwitchController<TContext, TSelection> {
  // The context and abort handler of the call being dispatched; effects run synchronously inside that dispatch.
  let call: { ctx: TContext; abort?: () => void } | undefined;
  const machine = Machine.createBaleMachineRunner<
    BaleModelSwitchMachineState<TSelection>,
    BaleModelSwitchEvent<TSelection>,
    BaleModelSwitchEffect<TSelection>,
    BaleModelSwitchStep<TSelection>
  >({
    initial: createBaleModelSwitchMachineState<TSelection>(),
    transition: transitionBaleModelSwitch,
    run(effect) {
      if (!call) return;
      if (effect.type === "queueContinuation")
        deps.queueContinuation(effect.turn, effect.selection, call.ctx);
      else call.abort?.();
    },
  });
  const dispatchFor = (
    ctx: TContext,
    abort: (() => void) | undefined,
    event: BaleModelSwitchEvent<TSelection>,
  ): boolean => {
    const preceding = call;
    call = { ctx, abort };
    try {
      return machine.dispatch(event).result;
    } finally {
      call = preceding;
    }
  };
  const triggerPendingAbort = (ctx: TContext): boolean => {
    const abort = deps.getAbortHandler();
    return dispatchFor(ctx, abort, {
      type: "abortRequested",
      activeTurn: deps.getActiveTurn(),
      hasAbortHandler: deps.hasAbortHandler() && !!abort,
      activeToolExecutions: deps.getActiveToolExecutions(),
    });
  };
  return {
    canOfferInFlightSwitch: (ctx) =>
      canRestartAgentRunForBaleModelSwitch({
        isIdle: deps.isIdle(ctx),
        hasAbortHandler: deps.hasAbortHandler(),
      }),
    hasPendingSwitch: () => machine.state.pending !== null,
    stagePendingSwitch: (selection, ctx, continuationTurn) => {
      const turn = deps.getActiveTurn() ?? continuationTurn;
      machine.dispatch({
        type: "staged",
        selection,
        ...(turn ? { turn } : {}),
      });
      try {
        deps.updateStatus(ctx);
      } finally {
        triggerPendingAbort(ctx);
      }
    },
    clearPendingSwitch: () => {
      machine.dispatch({ type: "cleared" });
    },
    queueContinuation: deps.queueContinuation,
    triggerPendingAbort,
    restartInterruptedTurn: (selection, ctx, continuationTurn) => {
      const abort = deps.getAbortHandler();
      const turn = deps.getActiveTurn() ?? continuationTurn;
      return dispatchFor(ctx, abort, {
        type: "restartRequested",
        selection,
        ...(turn ? { turn } : {}),
        hasAbortHandler: !!abort,
      });
    },
  };
}

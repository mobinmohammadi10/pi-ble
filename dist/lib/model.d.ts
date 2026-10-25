/**
 * Bale model control domain helpers
 * Zones: pi agent model control, bale controls, queue continuation
 * Owns model identity, thinking levels, scoped resolution, current-model state, and in-flight model switching
 */
import * as Machine from "./machine.ts";
import { type PendingBaleTurn } from "./queue.ts";
export interface MenuModel {
    provider: string;
    id: string;
    name?: string;
    reasoning?: boolean;
}
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export interface ScopedBaleModel<TModel extends MenuModel = MenuModel> {
    model: TModel;
    thinkingLevel?: ThinkingLevel;
}
export declare const THINKING_LEVELS: readonly ThinkingLevel[];
export interface CurrentModelStore<TContext, TModel extends MenuModel = MenuModel> {
    get: (ctx: TContext) => TModel | undefined;
    getStored: () => TModel | undefined;
    set: (model: TModel | undefined) => void;
}
export interface CurrentModelUpdateRuntime<TContext, TModel extends MenuModel = MenuModel> {
    setCurrentModel: (model: TModel | undefined, ctx: TContext) => void;
    onModelSelect: (event: {
        model: TModel | undefined;
    }, ctx: TContext) => void;
}
export type CurrentModelRuntime<TContext, TModel extends MenuModel = MenuModel> = CurrentModelStore<TContext, TModel> & CurrentModelUpdateRuntime<TContext, TModel>;
export declare function createCurrentModelStore<TContext, TModel extends MenuModel = MenuModel>(getContextModel: (ctx: TContext) => TModel | undefined): CurrentModelStore<TContext, TModel>;
export declare function createCurrentModelUpdateRuntime<TContext, TModel extends MenuModel = MenuModel>(deps: {
    setCurrentModel: (model: TModel | undefined) => void;
    updateStatus: (ctx: TContext) => void;
}): CurrentModelUpdateRuntime<TContext, TModel>;
export declare function createCurrentModelRuntime<TContext, TModel extends MenuModel = MenuModel>(deps: {
    getContextModel: (ctx: TContext) => TModel | undefined;
    updateStatus: (ctx: TContext) => void;
}): CurrentModelRuntime<TContext, TModel>;
export declare function modelsMatch(a: Pick<MenuModel, "provider" | "id"> | undefined, b: Pick<MenuModel, "provider" | "id"> | undefined): boolean;
export declare function getCanonicalModelId(model: Pick<MenuModel, "provider" | "id">): string;
export declare function isThinkingLevel(value: string): value is ThinkingLevel;
export declare function parseBaleScopedModelPatternList(value: string): string[];
export declare function parseBaleCliScopedModelPatterns(args: string[]): string[] | undefined;
export declare function resolveScopedModelPatterns<TModel extends MenuModel = MenuModel>(patterns: string[], availableModels: TModel[]): ScopedBaleModel<TModel>[];
export declare function sortScopedModels<TModel extends MenuModel = MenuModel>(models: ScopedBaleModel<TModel>[], currentModel: TModel | undefined): ScopedBaleModel<TModel>[];
export interface BaleInFlightModelSwitchState {
    isIdle: boolean;
    hasAbortHandler: boolean;
}
export declare function canRestartAgentRunForBaleModelSwitch(state: BaleInFlightModelSwitchState): boolean;
export declare function shouldTriggerPendingBaleModelSwitchAbort(state: {
    hasPendingModelSwitch: boolean;
    hasContinuationTurn: boolean;
    hasAbortHandler: boolean;
    activeToolExecutions: number;
}): boolean;
export declare function buildBaleModelSwitchContinuationText<TModel extends MenuModel>(balePrefix: string, model: TModel, thinkingLevel?: ScopedBaleModel<TModel>["thinkingLevel"]): string;
export type BaleModelSwitchContinuationSource = Pick<PendingBaleTurn, "chatId" | "replyToMessageId" | "target">;
export declare function buildBaleModelSwitchContinuationTurn<TModel extends MenuModel>(options: {
    turn: BaleModelSwitchContinuationSource;
    selection: ScopedBaleModel<TModel>;
    balePrefix?: string;
    queueOrder: number;
    laneOrder: number;
}): PendingBaleTurn;
export declare function createBaleModelSwitchContinuationTurnBuilder<TModel extends MenuModel>(deps: {
    balePrefix?: string;
    allocateItemOrder: () => number;
    allocateControlOrder: () => number;
}): (options: {
    turn: BaleModelSwitchContinuationSource;
    selection: ScopedBaleModel<TModel>;
}) => PendingBaleTurn;
export declare function createBaleModelSwitchContinuationQueue<TContext, TSelection extends ScopedBaleModel>(deps: {
    createContinuationTurn: (options: {
        turn: BaleModelSwitchContinuationSource;
        selection: TSelection;
    }) => PendingBaleTurn;
    appendQueuedItem: (item: PendingBaleTurn, ctx: TContext) => void;
}): (turn: BaleModelSwitchContinuationSource, selection: TSelection, ctx: TContext) => void;
export declare function createBaleModelSwitchContinuationQueueRuntime<TContext, TSelection extends ScopedBaleModel>(deps: {
    balePrefix?: string;
    allocateItemOrder: () => number;
    allocateControlOrder: () => number;
    appendQueuedItem: (item: PendingBaleTurn, ctx: TContext) => void;
}): (turn: BaleModelSwitchContinuationSource, selection: TSelection, ctx: TContext) => void;
export interface BaleModelSwitchControllerDeps<TContext, TSelection> {
    isIdle: (ctx: TContext) => boolean;
    getActiveTurn: () => PendingBaleTurn | undefined;
    getAbortHandler: () => (() => void) | undefined;
    hasAbortHandler: () => boolean;
    getActiveToolExecutions: () => number;
    queueContinuation: (turn: BaleModelSwitchContinuationSource, selection: TSelection, ctx: TContext) => void;
    updateStatus: (ctx: TContext) => void;
}
export interface BaleModelSwitchController<TContext, TSelection> {
    canOfferInFlightSwitch: (ctx: TContext) => boolean;
    /** A staged switch waits for its abort; queue dispatch and live-work observation treat it as pending control. */
    hasPendingSwitch: () => boolean;
    stagePendingSwitch: (selection: TSelection, ctx: TContext, continuationTurn?: BaleModelSwitchContinuationSource) => void;
    clearPendingSwitch: () => void;
    queueContinuation: (turn: BaleModelSwitchContinuationSource, selection: TSelection, ctx: TContext) => void;
    triggerPendingAbort: (ctx: TContext) => boolean;
    restartInterruptedTurn: (selection: TSelection, ctx: TContext, continuationTurn?: BaleModelSwitchContinuationSource) => boolean;
}
export interface BaleModelSwitchControllerRuntimeDeps<TContext, TSelection extends ScopedBaleModel> extends Omit<BaleModelSwitchControllerDeps<TContext, TSelection>, "queueContinuation"> {
    balePrefix?: string;
    allocateItemOrder: () => number;
    allocateControlOrder: () => number;
    appendQueuedItem: (item: PendingBaleTurn, ctx: TContext) => void;
}
export declare function createBaleModelSwitchControllerRuntime<TContext, TSelection extends ScopedBaleModel>(deps: BaleModelSwitchControllerRuntimeDeps<TContext, TSelection>): BaleModelSwitchController<TContext, TSelection>;
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
export type BaleModelSwitchEvent<TSelection> = {
    type: "staged";
    selection: TSelection;
    turn?: BaleModelSwitchContinuationSource;
} | ({
    type: "abortRequested";
} & BaleModelSwitchRunFacts) | {
    type: "restartRequested";
    selection: TSelection;
    turn?: BaleModelSwitchContinuationSource;
    hasAbortHandler: boolean;
} | {
    type: "cleared";
};
export type BaleModelSwitchEffect<TSelection> = {
    type: "queueContinuation";
    turn: BaleModelSwitchContinuationSource;
    selection: TSelection;
} | {
    type: "abort";
};
export interface BaleModelSwitchStep<TSelection> extends Machine.BaleMachineStep<BaleModelSwitchMachineState<TSelection>, BaleModelSwitchEffect<TSelection>> {
    /** `abortRequested` / `restartRequested`: the run was stopped for a continuation. */
    result: boolean;
}
export declare function createBaleModelSwitchMachineState<TSelection>(): BaleModelSwitchMachineState<TSelection>;
/**
 * Pure model-switch transition. A staged switch fires only once no tool runs and an abort handler exists; any restart
 * or clear consumes the staged switch too, so a stale selection can never abort the continuation run it started.
 */
export declare function transitionBaleModelSwitch<TSelection>(state: BaleModelSwitchMachineState<TSelection>, event: BaleModelSwitchEvent<TSelection>): BaleModelSwitchStep<TSelection>;
/**
 * The shell around `transitionBaleModelSwitch`: it samples the active turn, abort handler and tool count into
 * events, and runs the continuation and abort effects with the caller's context and the handler it sampled.
 */
export declare function createBaleModelSwitchController<TContext, TSelection>(deps: BaleModelSwitchControllerDeps<TContext, TSelection>): BaleModelSwitchController<TContext, TSelection>;
export {};

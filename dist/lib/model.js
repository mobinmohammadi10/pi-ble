/**
 * Bale model control domain helpers
 * Zones: pi agent model control, bale controls, queue continuation
 * Owns model identity, thinking levels, scoped resolution, current-model state, and in-flight model switching
 */
import * as Machine from "./machine.js";
import { truncateBaleQueueSummary, } from "./queue.js";
import { BALE_PREFIX } from "./turns.js";
export const THINKING_LEVELS = [
    "off",
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
];
export function createCurrentModelStore(getContextModel) {
    let currentModel;
    return {
        get: (ctx) => currentModel ?? getContextModel(ctx),
        getStored: () => currentModel,
        set: (model) => {
            currentModel = model;
        },
    };
}
export function createCurrentModelUpdateRuntime(deps) {
    const setAndUpdate = (model, ctx) => {
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
export function createCurrentModelRuntime(deps) {
    const store = createCurrentModelStore(deps.getContextModel);
    return {
        ...store,
        ...createCurrentModelUpdateRuntime({
            setCurrentModel: store.set,
            updateStatus: deps.updateStatus,
        }),
    };
}
export function modelsMatch(a, b) {
    return !!a && !!b && a.provider === b.provider && a.id === b.id;
}
export function getCanonicalModelId(model) {
    return `${model.provider}/${model.id}`;
}
export function isThinkingLevel(value) {
    return THINKING_LEVELS.includes(value);
}
export function parseBaleScopedModelPatternList(value) {
    return value
        .split(",")
        .map((pattern) => pattern.trim())
        .filter(Boolean);
}
export function parseBaleCliScopedModelPatterns(args) {
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === "--models") {
            const patterns = parseBaleScopedModelPatternList(args[i + 1] ?? "");
            return patterns.length > 0 ? patterns : undefined;
        }
        if (arg.startsWith("--models=")) {
            const patterns = parseBaleScopedModelPatternList(arg.slice("--models=".length));
            return patterns.length > 0 ? patterns : undefined;
        }
    }
    return undefined;
}
function escapeRegex(text) {
    return text.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}
function globMatches(text, pattern) {
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
function isAliasModelId(id) {
    if (id.endsWith("-latest"))
        return true;
    return !/-\d{8}$/.test(id);
}
function findUniqueModelMatch(availableModels, matches) {
    let model;
    for (const candidate of availableModels) {
        if (!matches(candidate))
            continue;
        if (model)
            return { ambiguous: true };
        model = candidate;
    }
    return { model, ambiguous: false };
}
function findExactModelReferenceMatch(modelReference, availableModels) {
    const trimmedReference = modelReference.trim();
    if (!trimmedReference)
        return undefined;
    const normalizedReference = trimmedReference.toLowerCase();
    const canonicalMatch = findUniqueModelMatch(availableModels, (model) => getCanonicalModelId(model).toLowerCase() === normalizedReference);
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
            const providerMatch = findUniqueModelMatch(availableModels, (model) => model.provider.toLowerCase() === normalizedProvider &&
                model.id.toLowerCase() === normalizedModelId);
            if (providerMatch.model || providerMatch.ambiguous) {
                return providerMatch.model;
            }
        }
    }
    return findUniqueModelMatch(availableModels, (model) => model.id.toLowerCase() === normalizedReference).model;
}
function tryMatchScopedModel(modelPattern, availableModels) {
    const exactMatch = findExactModelReferenceMatch(modelPattern, availableModels);
    if (exactMatch)
        return exactMatch;
    const normalizedPattern = modelPattern.toLowerCase();
    let bestAlias;
    let bestDatedVersion;
    for (const model of availableModels) {
        if (!model.id.toLowerCase().includes(normalizedPattern) &&
            !model.name?.toLowerCase().includes(normalizedPattern)) {
            continue;
        }
        if (isAliasModelId(model.id)) {
            if (!bestAlias || model.id.localeCompare(bestAlias.id) > 0) {
                bestAlias = model;
            }
        }
        else if (!bestDatedVersion ||
            model.id.localeCompare(bestDatedVersion.id) > 0) {
            bestDatedVersion = model;
        }
    }
    return bestAlias ?? bestDatedVersion;
}
function parseScopedModelPattern(pattern, availableModels) {
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
export function resolveScopedModelPatterns(patterns, availableModels) {
    const resolved = [];
    const seen = new Set();
    for (const pattern of patterns) {
        if (pattern.includes("*") ||
            pattern.includes("?") ||
            pattern.includes("[")) {
            const colonIndex = pattern.lastIndexOf(":");
            let globPattern = pattern;
            let thinkingLevel;
            if (colonIndex !== -1) {
                const suffix = pattern.substring(colonIndex + 1);
                if (isThinkingLevel(suffix)) {
                    thinkingLevel = suffix;
                    globPattern = pattern.substring(0, colonIndex);
                }
            }
            const matches = availableModels.filter((model) => globMatches(getCanonicalModelId(model), globPattern) ||
                globMatches(model.id, globPattern));
            for (const model of matches) {
                const key = getCanonicalModelId(model);
                if (seen.has(key))
                    continue;
                seen.add(key);
                resolved.push({ model, thinkingLevel });
            }
            continue;
        }
        const matched = parseScopedModelPattern(pattern, availableModels);
        if (!matched.model)
            continue;
        const key = getCanonicalModelId(matched.model);
        if (seen.has(key))
            continue;
        seen.add(key);
        resolved.push({
            model: matched.model,
            thinkingLevel: matched.thinkingLevel,
        });
    }
    return resolved;
}
export function sortScopedModels(models, currentModel) {
    const sorted = [...models];
    sorted.sort((a, b) => {
        const aIsCurrent = modelsMatch(a.model, currentModel);
        const bIsCurrent = modelsMatch(b.model, currentModel);
        if (aIsCurrent && !bIsCurrent)
            return -1;
        if (!aIsCurrent && bIsCurrent)
            return 1;
        const providerCompare = a.model.provider.localeCompare(b.model.provider);
        if (providerCompare !== 0)
            return providerCompare;
        return a.model.id.localeCompare(b.model.id);
    });
    return sorted;
}
export function canRestartAgentRunForBaleModelSwitch(state) {
    return !state.isIdle && state.hasAbortHandler;
}
export function shouldTriggerPendingBaleModelSwitchAbort(state) {
    return (state.hasPendingModelSwitch &&
        state.hasContinuationTurn &&
        state.hasAbortHandler &&
        state.activeToolExecutions === 0);
}
export function buildBaleModelSwitchContinuationText(balePrefix, model, thinkingLevel) {
    const modelLabel = `${model.provider}/${model.id}`;
    const thinkingSuffix = thinkingLevel ? `; thinking: ${thinkingLevel}` : "";
    return `${balePrefix} Continue from the last unfinished step. Model: ${modelLabel}${thinkingSuffix}.`;
}
export function buildBaleModelSwitchContinuationTurn(options) {
    const modelLabel = `${options.selection.model.provider}/${options.selection.model.id}`;
    const statusLabel = truncateBaleQueueSummary(`continue on ${options.selection.model.id}`, 4, 32);
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
                text: buildBaleModelSwitchContinuationText(options.balePrefix ?? BALE_PREFIX, options.selection.model, options.selection.thinkingLevel),
            },
        ],
        historyText: `Continue interrupted request on ${modelLabel}`,
        statusSummary: `↻ ${statusLabel || "continue"}`,
    };
}
export function createBaleModelSwitchContinuationTurnBuilder(deps) {
    return (options) => buildBaleModelSwitchContinuationTurn({
        ...options,
        balePrefix: deps.balePrefix,
        queueOrder: deps.allocateItemOrder(),
        laneOrder: deps.allocateControlOrder(),
    });
}
export function createBaleModelSwitchContinuationQueue(deps) {
    return (turn, selection, ctx) => {
        deps.appendQueuedItem(deps.createContinuationTurn({ turn, selection }), ctx);
    };
}
export function createBaleModelSwitchContinuationQueueRuntime(deps) {
    return createBaleModelSwitchContinuationQueue({
        createContinuationTurn: createBaleModelSwitchContinuationTurnBuilder({
            balePrefix: deps.balePrefix,
            allocateItemOrder: deps.allocateItemOrder,
            allocateControlOrder: deps.allocateControlOrder,
        }),
        appendQueuedItem: deps.appendQueuedItem,
    });
}
export function createBaleModelSwitchControllerRuntime(deps) {
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
export function createBaleModelSwitchMachineState() {
    return { pending: null };
}
/** The continuation is queued before the abort, so the stopped run always has its successor waiting. */
const restartFor = (turn, selection) => ({
    state: { pending: null },
    effects: [{ type: "queueContinuation", turn, selection }, { type: "abort" }],
    result: true,
});
/**
 * Pure model-switch transition. A staged switch fires only once no tool runs and an abort handler exists; any restart
 * or clear consumes the staged switch too, so a stale selection can never abort the continuation run it started.
 */
export function transitionBaleModelSwitch(state, event) {
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
            if (!pending ||
                !turn ||
                !shouldTriggerPendingBaleModelSwitchAbort({
                    hasPendingModelSwitch: true,
                    hasContinuationTurn: true,
                    hasAbortHandler: event.hasAbortHandler,
                    activeToolExecutions: event.activeToolExecutions,
                }))
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
export function createBaleModelSwitchController(deps) {
    // The context and abort handler of the call being dispatched; effects run synchronously inside that dispatch.
    let call;
    const machine = Machine.createBaleMachineRunner({
        initial: createBaleModelSwitchMachineState(),
        transition: transitionBaleModelSwitch,
        run(effect) {
            if (!call)
                return;
            if (effect.type === "queueContinuation")
                deps.queueContinuation(effect.turn, effect.selection, call.ctx);
            else
                call.abort?.();
        },
    });
    const dispatchFor = (ctx, abort, event) => {
        const preceding = call;
        call = { ctx, abort };
        try {
            return machine.dispatch(event).result;
        }
        finally {
            call = preceding;
        }
    };
    const triggerPendingAbort = (ctx) => {
        const abort = deps.getAbortHandler();
        return dispatchFor(ctx, abort, {
            type: "abortRequested",
            activeTurn: deps.getActiveTurn(),
            hasAbortHandler: deps.hasAbortHandler() && !!abort,
            activeToolExecutions: deps.getActiveToolExecutions(),
        });
    };
    return {
        canOfferInFlightSwitch: (ctx) => canRestartAgentRunForBaleModelSwitch({
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
            }
            finally {
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

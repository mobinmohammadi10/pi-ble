/**
 * Regression tests for Bale model control helpers
 * Exercises model selection state/resolution plus in-flight model-switch orchestration
 * Zones: bale, pi agent, shared utils
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  buildBaleModelSwitchContinuationText,
  buildBaleModelSwitchContinuationTurn,
  canRestartAgentRunForBaleModelSwitch,
  createCurrentModelRuntime,
  createCurrentModelStore,
  createCurrentModelUpdateRuntime,
  createBaleModelSwitchContinuationQueue,
  createBaleModelSwitchContinuationQueueRuntime,
  createBaleModelSwitchContinuationTurnBuilder,
  createBaleModelSwitchController,
  createBaleModelSwitchControllerRuntime,
  createBaleModelSwitchMachineState,
  getCanonicalModelId,
  isThinkingLevel,
  type MenuModel,
  modelsMatch,
  parseBaleCliScopedModelPatterns,
  parseBaleScopedModelPatternList,
  resolveScopedModelPatterns,
  shouldTriggerPendingBaleModelSwitchAbort,
  sortScopedModels,
  transitionBaleModelSwitch,
  type BaleModelSwitchEffect,
  type BaleModelSwitchEvent,
  THINKING_LEVELS,
} from "../lib/model.ts";
import type { PendingBaleTurn } from "../lib/queue.ts";
import * as Queue from "../lib/queue.ts";

function createModelTestModel(
  provider = "openai",
  id = "gpt-5",
  extra: Partial<MenuModel> = {},
): MenuModel {
  return { provider, id, ...extra };
}

function createModelTestSelection(
  model = createModelTestModel(),
  thinkingLevel?: "high",
): { model: MenuModel; thinkingLevel?: "high" } {
  return thinkingLevel === undefined ? { model } : { model, thinkingLevel };
}

function createModelTestTurn(
  overrides: Partial<PendingBaleTurn> = {},
): PendingBaleTurn {
  return {
    kind: "prompt",
    chatId: 7,
    replyToMessageId: 8,
    sourceMessageIds: [8],
    queueOrder: 0,
    queueLane: "default",
    laneOrder: 0,
    queuedAttachments: [],
    content: [],
    historyText: "active",
    statusSummary: "active",
    ...overrides,
  };
}

test("Current model store prefers explicit Bale model over context fallback", () => {
  const fallback = { provider: "fallback", id: "f", name: "Fallback" };
  const selected = { provider: "selected", id: "s", name: "Selected" };
  const store = createCurrentModelStore<
    { model?: typeof fallback },
    typeof fallback
  >((ctx) => ctx.model);
  assert.equal(store.get({ model: fallback }), fallback);
  assert.equal(store.getStored(), undefined);
  store.set(selected);
  assert.equal(store.get({ model: fallback }), selected);
  assert.equal(store.getStored(), selected);
  store.set(undefined);
  assert.equal(store.get({ model: fallback }), fallback);
});

test("Current model runtime combines store fallback and status updates", () => {
  const fallback = { provider: "fallback", id: "f", name: "Fallback" };
  const selected = { provider: "selected", id: "s", name: "Selected" };
  const statuses: string[] = [];
  const runtime = createCurrentModelRuntime<
    { id: string; model?: typeof fallback },
    typeof fallback
  >({
    getContextModel: (ctx) => ctx.model,
    updateStatus: (ctx) => {
      statuses.push(ctx.id);
    },
  });
  assert.equal(runtime.get({ id: "fallback", model: fallback }), fallback);
  runtime.setCurrentModel(selected, { id: "direct" });
  assert.equal(runtime.get({ id: "fallback", model: fallback }), selected);
  runtime.onModelSelect({ model: undefined }, { id: "event" });
  assert.equal(runtime.get({ id: "fallback", model: fallback }), fallback);
  assert.deepEqual(statuses, ["direct", "event"]);
});

test("Current model update runtime stores selections and refreshes status", () => {
  const selected = { provider: "selected", id: "s", name: "Selected" };
  let stored: typeof selected | undefined;
  const statuses: string[] = [];
  const runtime = createCurrentModelUpdateRuntime<
    { id: string },
    typeof selected
  >({
    setCurrentModel: (model) => {
      stored = model;
    },
    updateStatus: (ctx) => {
      statuses.push(ctx.id);
    },
  });
  runtime.setCurrentModel(selected, { id: "direct" });
  assert.equal(stored, selected);
  runtime.onModelSelect({ model: selected }, { id: "event" });
  assert.deepEqual(statuses, ["direct", "event"]);
});

test("Model helpers match models, detect thinking levels, and expose constants", () => {
  assert.deepEqual(THINKING_LEVELS, [
    "off",
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
  ]);
  assert.equal(
    modelsMatch(createModelTestModel(), createModelTestModel()),
    true,
  );
  assert.equal(
    modelsMatch(
      createModelTestModel(),
      createModelTestModel("anthropic", "gpt-5"),
    ),
    false,
  );
  assert.equal(getCanonicalModelId(createModelTestModel()), "openai/gpt-5");
  assert.equal(isThinkingLevel("high"), true);
  assert.equal(isThinkingLevel("impossible"), false);
});

test("Model helpers parse scoped model pattern lists and CLI flags", () => {
  assert.deepEqual(parseBaleScopedModelPatternList("a, b:high, "), [
    "a",
    "b:high",
  ]);
  assert.deepEqual(
    parseBaleCliScopedModelPatterns(["--models", "a,b:high"]),
    ["a", "b:high"],
  );
  assert.deepEqual(parseBaleCliScopedModelPatterns(["--models=a, b "]), [
    "a",
    "b",
  ]);
  assert.equal(
    parseBaleCliScopedModelPatterns(["--models", "  "]),
    undefined,
  );
  assert.equal(
    parseBaleCliScopedModelPatterns(["--other", "a"]),
    undefined,
  );
});

test("Model helpers resolve scoped model patterns and sort current models first", () => {
  const models: MenuModel[] = [
    createModelTestModel("openai", "gpt-5", { name: "GPT 5" }),
    createModelTestModel("openai", "gpt-5-latest", { name: "GPT 5 Latest" }),
    createModelTestModel("anthropic", "claude-sonnet-20250101", {
      name: "Claude Sonnet",
    }),
  ];
  const resolved = resolveScopedModelPatterns(
    ["gpt-5:high", "anthropic/*:low"],
    models,
  );
  assert.deepEqual(
    resolved.map((entry) => ({
      id: entry.model.id,
      thinking: entry.thinkingLevel,
    })),
    [
      { id: "gpt-5", thinking: "high" },
      { id: "claude-sonnet-20250101", thinking: "low" },
    ],
  );
  const sorted = sortScopedModels(resolved, models[0]);
  assert.equal(sorted[0]?.model.id, "gpt-5");
  assert.deepEqual(
    resolveScopedModelPatterns(
      ["openai/gpt-5"],
      [models[0]!, { ...models[0]! }],
    ),
    [],
  );
});

test("In-flight model switch is allowed for any interruptible active agent run", () => {
  assert.equal(
    canRestartAgentRunForBaleModelSwitch({
      isIdle: false,
      hasAbortHandler: true,
    }),
    true,
  );
  assert.equal(
    canRestartAgentRunForBaleModelSwitch({
      isIdle: true,
      hasAbortHandler: true,
    }),
    false,
  );
  assert.equal(
    canRestartAgentRunForBaleModelSwitch({
      isIdle: false,
      hasAbortHandler: false,
    }),
    false,
  );
});

test("Pending model switch abort waits until no tool executions remain", () => {
  assert.equal(
    shouldTriggerPendingBaleModelSwitchAbort({
      hasPendingModelSwitch: true,
      hasContinuationTurn: true,
      hasAbortHandler: true,
      activeToolExecutions: 0,
    }),
    true,
  );
  assert.equal(
    shouldTriggerPendingBaleModelSwitchAbort({
      hasPendingModelSwitch: true,
      hasContinuationTurn: true,
      hasAbortHandler: true,
      activeToolExecutions: 1,
    }),
    false,
  );
  assert.equal(
    shouldTriggerPendingBaleModelSwitchAbort({
      hasPendingModelSwitch: false,
      hasContinuationTurn: true,
      hasAbortHandler: true,
      activeToolExecutions: 0,
    }),
    false,
  );
});

type SwitchSelection = { model: { provider: string; id: string } };

/** Folds events through the pure model-switch transition, keeping every effect and the last call result. */
function runModelSwitchMachine(events: BaleModelSwitchEvent<SwitchSelection>[]) {
  let state = createBaleModelSwitchMachineState<SwitchSelection>();
  const effects: BaleModelSwitchEffect<SwitchSelection>[] = [];
  let result = false;
  for (const event of events) {
    const next = transitionBaleModelSwitch(state, event);
    state = next.state;
    effects.push(...next.effects);
    result = next.result;
  }
  return { state, effects, result };
}

const SWITCH_TURN = { chatId: 7, replyToMessageId: 9 };
const runFacts = (activeToolExecutions: number, hasAbortHandler = true) => ({
  type: "abortRequested" as const, hasAbortHandler, activeToolExecutions,
});

test("Model-switch machine queues the continuation before the abort", () => {
  const restarted = runModelSwitchMachine([
    { type: "restartRequested", selection: createModelTestSelection(), turn: SWITCH_TURN, hasAbortHandler: true },
  ]);
  assert.equal(restarted.result, true);
  assert.deepEqual(restarted.effects.map((effect) => effect.type), ["queueContinuation", "abort"]);
  const refused = runModelSwitchMachine([
    { type: "restartRequested", selection: createModelTestSelection(), hasAbortHandler: true },
  ]);
  assert.equal(refused.result, false, "No turn means no successor to queue, so nothing is aborted");
  assert.deepEqual(refused.effects, []);
});

test("Model-switch machine waits for tools and an abort handler before firing a staged switch", () => {
  const staged = { type: "staged" as const, selection: createModelTestSelection(), turn: SWITCH_TURN };
  assert.deepEqual(runModelSwitchMachine([staged, runFacts(1)]).effects, []);
  assert.deepEqual(runModelSwitchMachine([staged, runFacts(0, false)]).effects, []);
  const fired = runModelSwitchMachine([staged, runFacts(1), runFacts(0)]);
  assert.equal(fired.result, true);
  assert.deepEqual(fired.effects[0], { type: "queueContinuation", turn: SWITCH_TURN, selection: createModelTestSelection() });
  assert.equal(fired.state.pending, null);
  const local = runModelSwitchMachine([{ type: "staged", selection: createModelTestSelection() }, { ...runFacts(0), activeTurn: SWITCH_TURN }]);
  assert.equal(local.result, true, "Without a staged turn the run's active turn answers");
  assert.deepEqual(runModelSwitchMachine([staged, { type: "cleared" }, runFacts(0)]).effects, []);
});

test("Model-switch machine: a restart consumes a staged switch, so it cannot abort its own continuation", () => {
  const raced = runModelSwitchMachine([
    { type: "staged", selection: { model: { provider: "openai", id: "staged" } }, turn: SWITCH_TURN },
    { type: "restartRequested", selection: createModelTestSelection(), turn: SWITCH_TURN, hasAbortHandler: true },
    { ...runFacts(0), activeTurn: SWITCH_TURN },
  ]);
  assert.equal(raced.state.pending, null);
  assert.deepEqual(raced.effects.map((effect) => effect.type), ["queueContinuation", "abort"],
    "Only the restart acts; the stale staged selection never fires against the continuation run");
});

test("Model-switch controller centralizes pending abort and continuation queueing", () => {
  const events: string[] = [];
  let activeToolExecutions = 1;
  let activeTurn = createModelTestTurn({
    chatId: 1,
    replyToMessageId: 2,
    sourceMessageIds: [2],
    queueOrder: 3,
    laneOrder: 3,
    historyText: "previous",
    statusSummary: "previous",
  });
  const controller = createBaleModelSwitchController<
    object,
    { model: { provider: string; id: string } }
  >({
    isIdle: () => false,
    getActiveTurn: () => activeTurn,
    getAbortHandler: () => {
      return () => {
        events.push("abort");
      };
    },
    hasAbortHandler: () => true,
    getActiveToolExecutions: () => activeToolExecutions,
    queueContinuation: (turn, selection) => {
      events.push(`queue:${turn.replyToMessageId}:${selection.model.id}`);
    },
    updateStatus: () => {
      events.push("status");
    },
  });
  assert.equal(controller.canOfferInFlightSwitch({}), true);
  controller.stagePendingSwitch(createModelTestSelection(), {});
  activeTurn = createModelTestTurn({ replyToMessageId: 99 });
  assert.deepEqual(events, ["status"]);
  activeToolExecutions = 0;
  assert.equal(controller.triggerPendingAbort({}), true);
  assert.deepEqual(events, ["status", "queue:2:gpt-5", "abort"]);
  assert.equal(controller.hasPendingSwitch(), false);
});

test("Model-switch controller resumes a local run in the exact Bale menu target", () => {
  const events: string[] = [];
  let activeToolExecutions = 0;
  const continuationTurn = {
    chatId: 7,
    replyToMessageId: 9,
    target: { chatId: 7, threadId: 11 },
  };
  const controller = createBaleModelSwitchController<
    object,
    { model: { provider: string; id: string } }
  >({
    isIdle: () => false,
    getActiveTurn: () => undefined,
    getAbortHandler: () => () => {
      events.push("abort");
    },
    hasAbortHandler: () => true,
    getActiveToolExecutions: () => activeToolExecutions,
    queueContinuation: (turn, selection) => {
      events.push(
        `queue:${turn.chatId}:${turn.target?.threadId}:${turn.replyToMessageId}:${selection.model.id}`,
      );
    },
    updateStatus: () => {
      events.push("status");
    },
  });

  assert.equal(controller.canOfferInFlightSwitch({}), true);
  assert.equal(
    controller.restartInterruptedTurn(
      createModelTestSelection(),
      {},
      continuationTurn,
    ),
    true,
  );
  assert.deepEqual(events, ["queue:7:11:9:gpt-5", "abort"]);

  activeToolExecutions = 1;
  controller.stagePendingSwitch(
    createModelTestSelection(),
    {},
    continuationTurn,
  );
  assert.equal(controller.triggerPendingAbort({}), false);
  activeToolExecutions = 0;
  assert.equal(controller.triggerPendingAbort({}), true);
  assert.deepEqual(events, [
    "queue:7:11:9:gpt-5",
    "abort",
    "status",
    "queue:7:11:9:gpt-5",
    "abort",
  ]);
  assert.equal(controller.hasPendingSwitch(), false);

  controller.stagePendingSwitch(
    createModelTestSelection(),
    {},
    continuationTurn,
  );
  assert.deepEqual(events.slice(-3), [
    "status",
    "queue:7:11:9:gpt-5",
    "abort",
  ]);
  assert.equal(controller.hasPendingSwitch(), false);

  activeToolExecutions = 1;
  controller.stagePendingSwitch(
    createModelTestSelection(),
    {},
    continuationTurn,
  );
  controller.clearPendingSwitch();
  assert.equal(controller.triggerPendingAbort({}), false);
  assert.equal(controller.hasPendingSwitch(), false);
});

test("Model-switch controller: restart-now supersedes a switch staged behind a running tool", () => {
  const events: string[] = [];
  let activeToolExecutions = 1;
  const controller = createBaleModelSwitchController<object, SwitchSelection>({
    isIdle: () => false,
    getActiveTurn: () => createModelTestTurn({ replyToMessageId: 5 }),
    getAbortHandler: () => () => events.push("abort"),
    hasAbortHandler: () => true,
    getActiveToolExecutions: () => activeToolExecutions,
    queueContinuation: (_turn, selection) => events.push(`queue:${selection.model.id}`),
    updateStatus: () => {},
  });
  controller.stagePendingSwitch({ model: { provider: "openai", id: "staged" } }, {});
  assert.equal(controller.hasPendingSwitch(), true);
  assert.equal(controller.restartInterruptedTurn(createModelTestSelection(), {}), true);
  assert.equal(controller.hasPendingSwitch(), false);
  activeToolExecutions = 0;
  assert.equal(controller.triggerPendingAbort({}), false, "The settled tool finds nothing staged to fire");
  assert.deepEqual(events, ["queue:gpt-5", "abort"]);
});

test("Model-switch controller preserves the outer abort handler across synchronous re-entry", () => {
  const events: string[] = [];
  const outer = { owner: "outer" };
  const nested = { owner: "nested" };
  const controller = createBaleModelSwitchController<object, SwitchSelection>({
    isIdle: () => false,
    getActiveTurn: () => createModelTestTurn(),
    getAbortHandler: () => () => events.push("abort"),
    hasAbortHandler: () => true,
    getActiveToolExecutions: () => 0,
    queueContinuation: (_turn, _selection, ctx) => {
      assert.equal(ctx, outer);
      events.push("queue");
      assert.equal(controller.triggerPendingAbort(nested), false, "The outer restart already consumed pending state");
    },
    updateStatus: () => {},
  });
  assert.equal(controller.restartInterruptedTurn(createModelTestSelection(), outer), true);
  assert.deepEqual(events, ["queue", "abort"], "Nested dispatch cannot erase the outer effect context");
});

test("Model-switch controller runtime binds continuation queue construction", () => {
  const appended: PendingBaleTurn[] = [];
  let aborted = false;
  const activeTurn = createModelTestTurn();
  const controller = createBaleModelSwitchControllerRuntime({
    isIdle: () => false,
    getActiveTurn: () => activeTurn,
    getAbortHandler: () => {
      return () => {
        aborted = true;
      };
    },
    hasAbortHandler: () => true,
    getActiveToolExecutions: () => 0,
    balePrefix: "[bale]",
    allocateItemOrder: () => 5,
    allocateControlOrder: () => 6,
    appendQueuedItem: (item) => {
      appended.push(item);
    },
    updateStatus: () => {},
  });
  assert.equal(controller.triggerPendingAbort(undefined), false, "Nothing is staged yet");
  controller.stagePendingSwitch(createModelTestSelection(), undefined);
  assert.equal(aborted, true, "A staged switch with no running tool fires at once");
  assert.equal(controller.hasPendingSwitch(), false);
  assert.equal(appended[0]?.queueOrder, 5);
  assert.equal(appended[0]?.queueLane, "control");
});

test("Model-switch producer queues Control before abort without retargeting or spending waiting Steer", () => {
  const steer = createModelTestTurn({ queueOrder: 1, laneOrder: 1, queueLane: "steer", target: { chatId: 7, threadId: 42 } });
  const active = createModelTestTurn({ target: steer.target });
  const store = Queue.createBaleQueueStore<string>([steer]);
  const mutation = Queue.createBaleQueueMutationController({ ...store, updateStatus() {} });
  const before = structuredClone(steer);
  let aborts = 0;
  const controller = createBaleModelSwitchControllerRuntime({ isIdle: () => false, getActiveTurn: () => active,
    getAbortHandler: () => () => {
      aborts++;
      assert.equal(store.getQueuedItems()[0]!.queueLane, "control", "Continuation publication precedes abort");
      assert.equal(store.getQueuedItems()[1], steer);
    }, hasAbortHandler: () => true, getActiveToolExecutions: () => 0,
    allocateItemOrder: () => 2, allocateControlOrder: () => 2, appendQueuedItem: mutation.append, updateStatus() {} });
  controller.stagePendingSwitch(createModelTestSelection(), "ctx");
  assert.equal(aborts, 1);
  const continuation = store.getQueuedItems()[0]!;
  assert.ok(continuation.kind === "prompt");
  assert.equal(continuation.queueLane, "control"); assert.deepEqual(continuation.sourceMessageIds, []);
  assert.deepEqual(continuation.target, steer.target);
  assert.deepEqual(steer, before, "A model change adds no task affinity, source rewrite or attempt marker to waiting Steer");
  assert.deepEqual(Queue.planBaleSteerPacket(store.getQueuedItems(), { blocked: false, isItemReady: () => true }), { kind: "none" });
  const started = Queue.consumeDispatchedBalePrompt(store.getQueuedItems(), true);
  assert.equal(started.activeTurn, continuation);
  const packet = Queue.planBaleSteerPacket(started.remainingItems, { blocked: false, isItemReady: () => true });
  assert.equal(packet.kind, "packet");
  if (packet.kind === "packet") assert.equal(packet.items[0], steer, "Same-session continuation preserves later Steer eligibility");
});

test("Model-switch continuation turn stays control-lane and resume-oriented", () => {
  const createContinuationTurn =
    createBaleModelSwitchContinuationTurnBuilder({
      allocateItemOrder: () => 5,
      allocateControlOrder: () => 6,
    });
  const builtTurn = createContinuationTurn({
    turn: { chatId: 1, replyToMessageId: 2 },
    selection: createModelTestSelection(),
  });
  assert.equal(builtTurn.queueOrder, 5);
  assert.equal(builtTurn.laneOrder, 6);
  const sourceTarget = { chatId: 1, threadId: 42 };
  const turn = buildBaleModelSwitchContinuationTurn({
    turn: { chatId: 1, replyToMessageId: 2, target: sourceTarget },
    selection: createModelTestSelection(createModelTestModel(), "high"),
    balePrefix: "[bale]",
    queueOrder: 3,
    laneOrder: 4,
  });
  assert.equal(turn.kind, "prompt");
  assert.equal(turn.queueLane, "control");
  assert.equal(turn.queueOrder, 3);
  assert.equal(turn.laneOrder, 4);
  assert.equal(turn.chatId, 1);
  assert.equal(turn.replyToMessageId, 2);
  assert.deepEqual(turn.target, { chatId: 1, threadId: 42 });
  assert.notEqual(turn.target, sourceTarget);
  assert.deepEqual(turn.sourceMessageIds, []);
  assert.equal(
    turn.historyText,
    "Continue interrupted request on openai/gpt-5",
  );
  assert.equal(turn.statusSummary, "↻ continue on gpt-5");
  assert.match(String(turn.content[0]?.type), /text/);
  assert.match(
    String((turn.content[0] as { text?: string } | undefined)?.text ?? ""),
    /Continue from the last unfinished step\./,
  );
});

test("Model-switch continuation queue runtime builds and appends control-lane turns", () => {
  const appended: PendingBaleTurn[] = [];
  const queueContinuation = createBaleModelSwitchContinuationQueueRuntime({
    allocateItemOrder: () => 3,
    allocateControlOrder: () => 4,
    appendQueuedItem: (item) => {
      appended.push(item);
    },
  });
  queueContinuation(
    createModelTestTurn(),
    createModelTestSelection(),
    undefined,
  );
  assert.equal(appended[0]?.queueOrder, 3);
  assert.equal(appended[0]?.laneOrder, 4);
  assert.equal(appended[0]?.queueLane, "control");
  assert.match(
    String((appended[0]?.content[0] as { text?: string } | undefined)?.text),
    /^\[bale\] Continue/,
  );
});

test("Model-switch continuation queue creates and appends continuation turns", () => {
  const appended: Array<{ item: PendingBaleTurn; ctx: { id: string } }> =
    [];
  const queueContinuation = createBaleModelSwitchContinuationQueue({
    createContinuationTurn: ({ turn, selection }) => ({
      ...turn,
      kind: "prompt" as const,
      queueOrder: 1,
      queueLane: "control" as const,
      laneOrder: 2,
      sourceMessageIds: [],
      queuedAttachments: [],
      content: [{ type: "text" as const, text: selection.model.id }],
      historyText: "continue",
      statusSummary: "continue",
    }),
    appendQueuedItem: (item, ctx: { id: string }) => {
      appended.push({ item, ctx });
    },
  });
  queueContinuation(createModelTestTurn(), createModelTestSelection(), {
    id: "ctx",
  });
  assert.equal(appended[0]?.item.content[0]?.type, "text");
  assert.equal(appended[0]?.item.content[0]?.text, "gpt-5");
  assert.deepEqual(appended[0]?.ctx, { id: "ctx" });
});

test("Continuation prompt keeps scope, model, resume instruction and optional thinking in one compact line", () => {
  for (const thinking of [undefined, "off", "high"] as const) {
    const text = buildBaleModelSwitchContinuationText(
      "[bale]", createModelTestModel(), thinking,
    );
    assert.equal(text, `[bale] Continue from the last unfinished step. Model: openai/gpt-5${
      thinking ? `; thinking: ${thinking}` : ""
    }.`);
  }
});

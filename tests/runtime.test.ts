/**
 * Regression tests for the runtime domain
 * Covers lib/runtime.ts state helpers, controllers, lifecycle hooks, typing, and progress primitives
 */

import assert from "node:assert/strict";
import testRoot, { type TestContext } from "node:test";

import * as Runtime from "../lib/runtime.ts";
import { createBaleThreadTarget } from "../lib/target.ts";
import { createPassthroughFailureLog } from "./fixtures/failure-log.ts";
import { createBaleFailureRunLog } from "../lib/logging.ts";

type RuntimeTestHandler = (context: TestContext) => void | Promise<void>;
function test(name: string, fn: RuntimeTestHandler): void {
  void testRoot(name, { concurrency: false, timeout: 5000 }, fn);
}

async function flushMicrotasks(iterations = 10): Promise<void> {
  for (let i = 0; i < iterations; i++) {
    await Promise.resolve();
  }
}

test("Runtime facade binds grouped operations to one bridge state", () => {
  const state = Runtime.createBaleBridgeRuntimeState();
  const runtime = Runtime.createBaleBridgeRuntime(state);
  assert.equal(runtime.state, state);
  assert.equal(runtime.queue.allocateItemOrder(), 0);
  assert.equal(runtime.queue.allocateControlOrder(), 0);
  runtime.lifecycle.setDispatchPending(true);
  runtime.lifecycle.setCompactionInProgress(true);
  runtime.lifecycle.setActiveToolExecutions(3);
  runtime.lifecycle.setFoldQueuedPromptsIntoHistory(true);
  assert.equal(runtime.lifecycle.hasDispatchPending(), true);
  assert.equal(runtime.lifecycle.isCompactionInProgress(), true);
  assert.equal(runtime.lifecycle.getActiveToolExecutions(), 3);
  runtime.lifecycle.clearDispatchPending();
  runtime.lifecycle.resetActiveToolExecutions();
  assert.equal(runtime.lifecycle.hasDispatchPending(), false);
  assert.equal(runtime.lifecycle.getActiveToolExecutions(), 0);
  assert.equal(runtime.lifecycle.shouldFoldQueuedPromptsIntoHistory(), true);
  assert.equal(runtime.setup.start(), true);
  assert.equal(runtime.setup.isInProgress(), true);
  runtime.setup.finish();
  assert.equal(runtime.setup.isInProgress(), false);
  let abortCount = 0;
  runtime.abort.setHandler(() => {
    abortCount += 1;
  });
  assert.equal(runtime.abort.hasHandler(), true);
  assert.equal(runtime.abort.abortTurn(), true);
  assert.equal(abortCount, 1);
  runtime.abort.clearHandler();
  assert.equal(runtime.abort.hasHandler(), false);
});

test("Runtime state helpers allocate queue order and manage typing loops", async () => {
  const state = Runtime.createBaleBridgeRuntimeState();
  const typing = Runtime.createBaleTypingLoop();
  assert.equal(Runtime.allocateBaleQueueItemOrder(state), 0);
  assert.equal(Runtime.allocateBaleQueueItemOrder(state), 1);
  assert.equal(Runtime.allocateBaleQueueControlOrder(state), 0);
  Runtime.syncBaleQueueRuntimeCounters(state, {
    nextQueuedBaleItemOrder: 10,
    nextQueuedBaleControlOrder: 20,
  });
  assert.equal(Runtime.allocateBaleQueueItemOrder(state), 10);
  assert.equal(Runtime.allocateBaleQueueControlOrder(state), 20);
  assert.equal(Runtime.hasBaleDispatchPending(state), false);
  assert.equal(Runtime.isBaleCompactionInProgress(state), false);
  assert.equal(Runtime.getActiveBaleToolExecutions(state), 0);
  assert.equal(Runtime.shouldFoldQueuedPromptsIntoHistory(state), false);
  Runtime.syncBaleLifecycleRuntimeFlags(state, {
    activeBaleToolExecutions: 2,
    baleTurnDispatchPending: true,
    compactionInProgress: true,
    foldQueuedPromptsIntoHistory: true,
  });
  assert.equal(Runtime.hasBaleDispatchPending(state), true);
  assert.equal(Runtime.isBaleCompactionInProgress(state), true);
  assert.equal(Runtime.getActiveBaleToolExecutions(state), 2);
  assert.equal(Runtime.shouldFoldQueuedPromptsIntoHistory(state), true);
  Runtime.clearBaleDispatchPending(state);
  Runtime.setBaleCompactionInProgress(state, false);
  Runtime.resetActiveBaleToolExecutions(state);
  assert.equal(Runtime.hasBaleDispatchPending(state), false);
  assert.equal(Runtime.getActiveBaleToolExecutions(state), 0);
  Runtime.setActiveBaleToolExecutions(state, 1);
  Runtime.setFoldQueuedPromptsIntoHistory(state, false);
  assert.equal(Runtime.startBaleSetup(state), true);
  assert.equal(Runtime.startBaleSetup(state), false);
  assert.equal(Runtime.isBaleSetupInProgress(state), true);
  Runtime.finishBaleSetup(state);
  assert.equal(Runtime.isBaleSetupInProgress(state), false);
  let abortCount = 0;
  assert.equal(Runtime.hasBaleAbortHandler(state), false);
  assert.equal(Runtime.abortBaleTurn(state), false);
  Runtime.setBaleAbortHandler(state, () => {
    abortCount += 1;
  });
  assert.equal(Runtime.hasBaleAbortHandler(state), true);
  assert.equal(Runtime.abortBaleTurn(state), true);
  assert.equal(abortCount, 1);
  assert.equal(typeof Runtime.getBaleAbortHandler(state), "function");
  Runtime.clearBaleAbortHandler(state);
  assert.equal(Runtime.hasBaleAbortHandler(state), false);
  assert.equal(Runtime.hasBaleDispatchPending(state), false);
  assert.equal(Runtime.isBaleCompactionInProgress(state), false);
  assert.equal(Runtime.getActiveBaleToolExecutions(state), 1);
  assert.equal(Runtime.shouldFoldQueuedPromptsIntoHistory(state), false);
  const typingActions: number[] = [];
  assert.equal(
    typing.start({
      chatId: undefined,
      intervalMs: 1000,
      sendTypingAction: async (chatId) => {
        typingActions.push(chatId);
      },
    }),
    false,
  );
  assert.equal(
    typing.start({
      chatId: 42,
      intervalMs: 1000,
      sendTypingAction: async (chatId) => {
        typingActions.push(chatId);
      },
    }),
    true,
  );
  await flushMicrotasks();
  assert.deepEqual(typingActions, [42]);
  assert.equal(
    typing.start({
      chatId: 43,
      intervalMs: 1000,
      sendTypingAction: async (chatId) => {
        typingActions.push(chatId);
      },
    }),
    true,
  );
  await flushMicrotasks();
  assert.deepEqual(typingActions, [42, 43]);
  assert.equal(typing.stop(), true);
  assert.equal(typing.stop(), false);
});

test("Typing loop retargets chat-level activity into the active thread", async () => {
  const typing = Runtime.createBaleTypingLoop();
  const typingActions: Array<{
    chatId: number;
    threadId?: number;
  }> = [];
  const recordTypingAction = (
    chatId: number,
    options?: { message_thread_id?: number },
  ): void => {
    typingActions.push({
      chatId,
      ...(typeof options?.message_thread_id === "number"
        ? { threadId: options.message_thread_id }
        : {}),
    });
  };
  assert.equal(
    typing.start({
      chatId: 42,
      intervalMs: 1000,
      sendTypingAction: async (chatId, options) => {
        recordTypingAction(chatId, options);
      },
    }),
    true,
  );
  await flushMicrotasks();
  assert.deepEqual(typingActions, [{ chatId: 42 }]);
  assert.equal(
    typing.start({
      chatId: 42,
      target: createBaleThreadTarget(42, 99),
      intervalMs: 1000,
      sendTypingAction: async (chatId, options) => {
        recordTypingAction(chatId, options);
      },
    }),
    true,
  );
  await flushMicrotasks();
  assert.deepEqual(typingActions, [
    { chatId: 42 },
    { chatId: 42, threadId: 99 },
  ]);
  assert.equal(typing.stop(), true);
});

test("Typing keepalive retargets queued work without leaking ticks across threads", async (ctx) => {
  ctx.mock.timers.enable({ apis: ["setInterval"] });
  const typing = Runtime.createBaleTypingLoop();
  const actions: string[] = [];
  const createDeps = (threadId: number): Runtime.BaleTypingLoopDeps => ({
    chatId: 42,
    target: createBaleThreadTarget(42, threadId),
    intervalMs: 1000,
    sendTypingAction: async (_chatId, options) => {
      actions.push(`thread:${options?.message_thread_id ?? "all"}`);
    },
  });

  assert.equal(typing.start(createDeps(7)), true);
  await flushMicrotasks();
  ctx.mock.timers.tick(1000);
  await flushMicrotasks();
  assert.deepEqual(actions, ["thread:7", "thread:7"]);

  assert.equal(typing.start(createDeps(9)), true);
  await flushMicrotasks();
  ctx.mock.timers.tick(2000);
  await flushMicrotasks();
  assert.deepEqual(actions, [
    "thread:7",
    "thread:7",
    "thread:9",
    "thread:9",
  ]);
  assert.equal(typing.stop(), true);
  ctx.mock.timers.reset();
});

test("Typing loop sends chat actions only into the exact thread target", async () => {
  const typing = Runtime.createBaleTypingLoop();
  const typingActions: Array<{
    chatId: number;
    threadId?: number;
  }> = [];
  assert.equal(
    typing.start({
      chatId: 42,
      target: createBaleThreadTarget(42, 99),
      intervalMs: 1000,
      sendTypingAction: async (chatId, options) => {
        typingActions.push({
          chatId,
          threadId: options?.message_thread_id,
        });
      },
    }),
    true,
  );
  await flushMicrotasks();
  assert.deepEqual(typingActions, [{ chatId: 42, threadId: 99 }]);
  assert.equal(typing.stop(), true);
});

test("Typing loop idle wait is bounded for slow in-flight chat actions", async () => {
  const typing = Runtime.createBaleTypingLoop();
  typing.start({ chatId: 42, intervalMs: 60_000, sendTypingAction: () => new Promise(() => {}) });
  await flushMicrotasks();
  const startedAt = Date.now();

  await typing.waitForIdle(1);

  assert.ok(Date.now() - startedAt < 100);
  assert.equal(typing.stop(), true);
});

/** Folds events through the pure typing transition, keeping every effect and the last call result. */
function runTypingMachine(events: Runtime.BaleTypingEvent[]): {
  state: Runtime.BaleTypingMachineState;
  effects: Runtime.BaleTypingEffect[];
  result: boolean;
} {
  let state = Runtime.createBaleTypingMachineState();
  const effects: Runtime.BaleTypingEffect[] = [];
  let result = false;
  for (const event of events) {
    const next = Runtime.transitionBaleTypingLoop(state, event);
    state = next.state;
    effects.push(...next.effects);
    result = next.result;
  }
  return { state, effects, result };
}

const typingStart = (loopId: number, threadId?: number, continues = true): Extract<Runtime.BaleTypingEvent, { type: "started" }> => ({
  type: "started", loopId, chatId: 42, key: `42:${threadId ?? "all"}`, intervalMs: 3000, continues,
  ...(threadId === undefined ? {} : { threadParams: { message_thread_id: threadId } }),
});

test("Typing machine starts with one action and an interval, and refuses a missing chat", () => {
  const started = runTypingMachine([typingStart(1, 7)]);
  assert.equal(started.result, true);
  assert.deepEqual(started.effects, [
    { type: "send", loopId: 1, sendId: 1, chatId: 42, threadParams: { message_thread_id: 7 } },
    { type: "armInterval", intervalMs: 3000 },
  ]);
  const refused = runTypingMachine([{ ...typingStart(1), chatId: 0 }]);
  assert.equal(refused.result, false);
  assert.deepEqual(refused.effects, []);
  assert.equal(refused.state.loop, null);
});

test("Typing machine replaces callbacks on every start but sends at once only for a new target", () => {
  const same = runTypingMachine([typingStart(1, 7), typingStart(2, 7)]);
  assert.equal(same.result, false, "A same-target start tells the caller it does not own the loop");
  assert.deepEqual(same.effects.slice(2), [{ type: "loopEnded", loopId: 1 }]);
  assert.equal(same.state.loop?.id, 2);
  assert.equal(same.state.inFlight, null, "The replaced loop's action no longer blocks the next tick");
  const moved = runTypingMachine([typingStart(1, 7), { type: "sendSettled", sendId: 1 }, typingStart(2, 9)]);
  assert.equal(moved.result, true);
  assert.deepEqual(moved.effects.slice(2), [
    { type: "loopEnded", loopId: 1 },
    { type: "send", loopId: 2, sendId: 2, chatId: 42, threadParams: { message_thread_id: 9 } },
  ], "A running interval keeps its phase; no second interval is armed");
});

test("Typing machine skips ticks while an action is in flight and ignores stale settlements", () => {
  const busy = runTypingMachine([typingStart(1), { type: "ticked", continues: true }]);
  assert.equal(busy.effects.filter((effect) => effect.type === "send").length, 1);
  const stale = runTypingMachine([typingStart(1), typingStart(2, 9), { type: "sendSettled", sendId: 1 }]);
  assert.equal(stale.state.inFlight, 2, "The replaced loop's late settlement cannot clear the new action");
  const next = runTypingMachine([typingStart(1), { type: "sendSettled", sendId: 1 }, { type: "ticked", continues: true }]);
  assert.deepEqual(next.effects.at(-1), { type: "send", loopId: 1, sendId: 2, chatId: 42 });
});

test("Typing machine ends the loop when its caller stops continuing or stop is requested", () => {
  const lost = runTypingMachine([typingStart(1), { type: "sendSettled", sendId: 1 }, { type: "ticked", continues: false }]);
  assert.deepEqual(lost.effects.slice(2), [{ type: "cancelInterval" }, { type: "loopEnded", loopId: 1 }]);
  assert.equal(lost.state.loop, null);
  const stopped = runTypingMachine([typingStart(1), { type: "stopRequested" }]);
  assert.equal(stopped.result, true);
  assert.equal(stopped.state.inFlight, null);
  assert.equal(runTypingMachine([{ type: "stopRequested" }]).result, false);
  const quiet = runTypingMachine([typingStart(1, undefined, false)]);
  assert.deepEqual(quiet.effects, [{ type: "armInterval", intervalMs: 3000 }],
    "A fresh loop whose caller already stopped arms its interval and ends on the first tick");
});

test("Abort handler setter and agent-end resetter bind runtime cleanup", () => {
  const runtime = Runtime.createBaleBridgeRuntime();
  const events: string[] = [];
  const setAbortHandler = Runtime.createBaleContextAbortHandlerSetter(
    runtime.abort,
  );
  setAbortHandler({
    abort: () => {
      events.push("abort");
    },
  });
  assert.equal(runtime.abort.abortTurn(), true);
  const reset = Runtime.createBaleAgentEndResetter({
    abort: runtime.abort,
    typing: runtime.typing,
    clearActiveTurn: () => {
      events.push("active");
    },
    resetToolExecutions: () => {
      events.push("tools");
    },
    clearPendingModelSwitch: () => {
      events.push("switch");
    },
    clearDispatchPending: runtime.lifecycle.clearDispatchPending,
  });
  runtime.lifecycle.setDispatchPending(true);
  reset();
  assert.equal(runtime.abort.hasHandler(), false);
  assert.equal(runtime.lifecycle.hasDispatchPending(), false);
  assert.deepEqual(events, ["abort", "active", "tools", "switch"]);
});

test("Prompt dispatch lifecycle owns dispatch flags, typing, and status", () => {
  const runtime = Runtime.createBaleBridgeRuntime();
  const events: string[] = [];
  const lifecycle = Runtime.createBalePromptDispatchLifecycle<{
    id: string;
  }>({
    lifecycle: runtime.lifecycle,
    typing: runtime.typing,
    startTypingLoop: (ctx, chatId) => {
      events.push(`typing:${ctx.id}:${chatId ?? "default"}`);
    },
    updateStatus: (ctx, error) => {
      events.push(`status:${ctx.id}:${error ?? "ok"}`);
    },
    recordRuntimeEvent: (category, error) => {
      const message = error instanceof Error ? error.message : String(error);
      events.push(`event:${category}:${message}`);
    },
  });
  lifecycle.onPromptDispatchStart({ id: "ctx" }, 42);
  assert.equal(runtime.lifecycle.hasDispatchPending(), true);
  lifecycle.onPromptDispatchFailure({ id: "ctx" }, "boom");
  assert.equal(runtime.lifecycle.hasDispatchPending(), false);
  assert.deepEqual(events, [
    "typing:ctx:42",
    "status:ctx:ok",
    "event:dispatch:boom",
    "status:ctx:dispatch failed: boom",
  ]);
});

test("Prompt dispatch lifecycle records stale status failures", () => {
  const runtime = Runtime.createBaleBridgeRuntime();
  const events: string[] = [];
  const lifecycle = Runtime.createBalePromptDispatchLifecycle<{
    id: string;
  }>({
    lifecycle: runtime.lifecycle,
    typing: runtime.typing,
    startTypingLoop: () => {
      events.push("typing");
    },
    updateStatus: () => {
      throw new Error("stale ctx");
    },
    recordRuntimeEvent: (category, error, details) => {
      const message = error instanceof Error ? error.message : String(error);
      events.push(`${category}:${message}:${details?.phase ?? "event"}`);
    },
  });

  assert.doesNotThrow(() => lifecycle.onPromptDispatchStart({ id: "ctx" }));
  assert.equal(runtime.lifecycle.hasDispatchPending(), true);
  assert.doesNotThrow(() =>
    lifecycle.onPromptDispatchFailure({ id: "ctx" }, "boom"),
  );
  assert.equal(runtime.lifecycle.hasDispatchPending(), false);
  assert.deepEqual(events, [
    "typing",
    "dispatch:stale ctx:status-update",
    "dispatch:boom:event",
    "dispatch:stale ctx:status-update",
  ]);
});

test("Prompt dispatch runtime binds typing starter and dispatch lifecycle", async () => {
  const runtime = Runtime.createBaleBridgeRuntime();
  const sentChatIds: number[] = [];
  const statuses: string[] = [];
  const promptRuntime = Runtime.createBalePromptDispatchRuntime<{
    id: string;
  }>({
    failureLog: createPassthroughFailureLog(),
    lifecycle: runtime.lifecycle,
    typing: runtime.typing,
    getDefaultChatId: () => 7,
    sendTypingAction: async (chatId) => {
      sentChatIds.push(chatId);
    },
    updateStatus: (_ctx, error) => {
      statuses.push(error ?? "ok");
    },
    intervalMs: 1000,
  });
  promptRuntime.onPromptDispatchStart({ id: "ctx" }, 9);
  await flushMicrotasks();
  assert.equal(runtime.lifecycle.hasDispatchPending(), true);
  assert.deepEqual(sentChatIds, [9]);
  promptRuntime.onPromptDispatchFailure({ id: "ctx" }, "boom");
  assert.equal(runtime.lifecycle.hasDispatchPending(), false);
  assert.deepEqual(statuses, ["ok", "dispatch failed: boom"]);
});

test("Typing loop starter uses a conservative native keepalive interval", () => {
  let capturedIntervalMs = 0;
  const startTypingLoop = Runtime.createBaleTypingLoopStarter<{
    id: string;
  }>({
    failureLog: createPassthroughFailureLog(),
    typing: {
      start: (deps) => {
        capturedIntervalMs = deps.intervalMs;
        return true;
      },
      stop: () => true,
      waitForIdle: async () => {},
    },
    getDefaultChatId: () => 7,
    sendTypingAction: async () => {},
    updateStatus: () => {},
  });

  startTypingLoop({ id: "ctx" });

  assert.equal(capturedIntervalMs, 3000);
});

test("Typing loop starter sends one exact thread action", async () => {
  const state = Runtime.createBaleBridgeRuntimeState();
  const runtime = Runtime.createBaleBridgeRuntime(state);
  const actions: string[] = [];
  const startTypingLoop = Runtime.createBaleTypingLoopStarter<{
    id: string;
  }>({
    failureLog: createPassthroughFailureLog(),
    typing: runtime.typing,
    getDefaultChatId: () => undefined,
    sendTypingAction: async (chatId, options) => {
      actions.push(`thread:${chatId}:${options?.message_thread_id ?? "all"}`);
    },
    updateStatus: () => {},
    intervalMs: 1000,
  });

  startTypingLoop({ id: "ctx" }, 8, {
    target: createBaleThreadTarget(8, 44),
  });
  await flushMicrotasks();

  assert.deepEqual(actions, ["thread:8:44"]);
  assert.equal(runtime.typing.stop(), true);
});

test("Typing loop starter collapses one sustained presence failure into a failure and an outcome record", async () => {
  const runtime = Runtime.createBaleBridgeRuntime();
  const events: Array<{ category: string; details?: Record<string, unknown> }> = [];
  let failing = true;
  let attempts = 0;
  const startTypingLoop = Runtime.createBaleTypingLoopStarter<{ id: string }>({
    failureLog: createBaleFailureRunLog({
      category: "typing",
      failurePhase: "typing-presence",
      outcomePhase: "typing-presence-recovered",
      label: "typing presence",
      record: (category, errorOrMessage, details) =>
        events.push({ category, details: { ...details, message: String(errorOrMessage) } }),
    }),
    typing: runtime.typing,
    getDefaultChatId: () => 7,
    sendTypingAction: async () => {
      attempts += 1;
      if (failing) throw Object.assign(new Error("connect ENOENT"), { code: "ENOENT" });
    },
    updateStatus: () => {},
    recordRuntimeEvent: (category, errorOrMessage, details) =>
      events.push({ category, details: { ...details, message: String(errorOrMessage) } }),
    intervalMs: 5,
  });
  const failures = () => events.filter((event) => event.details?.phase === "typing-presence");
  const recovered = () => events.find((event) => event.details?.phase === "typing-presence-recovered");
  try {
    startTypingLoop({ id: "ctx" }, 7);
    for (let tick = 0; tick < 50 && (attempts < 3 || failures().length === 0); tick += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
    assert.ok(attempts >= 3, `expected repeated failing ticks, saw ${attempts}`);
    assert.equal(failures().length, 1, "a repeated identical presence failure is logged once");
    assert.equal(failures()[0]?.category, "typing");
    assert.equal(failures()[0]?.details?.chatId, 7);
    assert.equal(failures()[0]?.details?.failureSignature, "ENOENT");
    // Liveness is untouched: every failed tick still ran through the loop.
    assert.ok(attempts > failures().length);
    failing = false;
    for (let tick = 0; tick < 50 && !recovered(); tick += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
    assert.ok(recovered(), "a working presence closes the failure run");
    assert.match(String(recovered()?.details?.message), /recovered after \d+ failed attempts/u);
    assert.ok(Number(recovered()?.details?.failedAttempts) >= 3);
  } finally {
    runtime.typing.stop();
  }
});

for (const threaded of [false, true]) {
  test(`Prompt dispatch starts typing in its exact queued destination (threaded=${threaded})`, async () => {
    const runtime = Runtime.createBaleBridgeRuntime();
    const calls: Array<{ chatId: number; threadId?: number }> = [];
    const prompt = Runtime.createBalePromptDispatchRuntime({
   failureLog: createPassthroughFailureLog(),
   lifecycle: runtime.lifecycle, typing: runtime.typing,
      getDefaultChatId: () => 7, isThreadedMode: () => threaded,
      sendTypingAction: async (chatId, options) => { calls.push({ chatId, threadId: options?.message_thread_id }); }, updateStatus() {} });
    const target = threaded ? { chatId: 7, threadId: 42 } : { chatId: 7 };
    try {
      prompt.onPromptDispatchStart({}, 7, target); await flushMicrotasks();
      assert.equal(runtime.lifecycle.hasDispatchPending(), true);
      assert.deepEqual(calls, [{ chatId: target.chatId, threadId: target.threadId }]);
    } finally { runtime.typing.stop(); }
  });
}

for (const threadId of [undefined, 0, -1, 1.5, NaN]) {
  test(`Threaded typing refuses an unavailable or invalid Thread before starting (thread=${threadId})`, async () => {
    const typing = Runtime.createBaleTypingLoop(); let calls = 0;
    const start = Runtime.createBaleTypingLoopStarter({
   failureLog: createPassthroughFailureLog(),
   typing, getDefaultChatId: () => 7, isThreadedMode: () => true,
      sendTypingAction: async () => { calls++; }, updateStatus() {} });
    try {
      assert.equal(start({}, 7, { target: { chatId: 7, ...(threadId === undefined ? {} : { threadId }) } }), false);
      await flushMicrotasks(); assert.equal(calls, 0); assert.equal(typing.stop(), false);
    } finally { typing.stop(); }
  });
}

test("A Classic typing loop stops when Threaded Mode activates, without replacing a valid Thread loop", async (ctx) => {
  ctx.mock.timers.enable({ apis: ["setInterval"] });
  const typing = Runtime.createBaleTypingLoop(); let threaded = false;
  const calls: Array<{ chatId: number; threadId?: number }> = [];
  const start = Runtime.createBaleTypingLoopStarter({
   failureLog: createPassthroughFailureLog(),
   typing, getDefaultChatId: () => 7, isThreadedMode: () => threaded,
    sendTypingAction: async (chatId, options) => { calls.push({ chatId, threadId: options?.message_thread_id }); }, updateStatus() {} });
  try {
    assert.equal(start({}), true); await flushMicrotasks(); assert.deepEqual(calls, [{ chatId: 7, threadId: undefined }]);
    threaded = true; ctx.mock.timers.tick(3000); await flushMicrotasks(); assert.equal(calls.length, 1); assert.equal(typing.stop(), false);
    assert.equal(start({}, 7, { target: { chatId: 7, threadId: 42 } }), true); await flushMicrotasks();
    assert.equal(start({}, 7), false); ctx.mock.timers.tick(3000); await flushMicrotasks();
    assert.deepEqual(calls.slice(1), [{ chatId: 7, threadId: 42 }, { chatId: 7, threadId: 42 }]);
  } finally { typing.stop(); }
});

test("Typing loop skips interval ticks while the previous action is in flight", async (ctx) => {
  ctx.mock.timers.enable({ apis: ["setInterval"] });
  const state = Runtime.createBaleBridgeRuntimeState();
  const runtime = Runtime.createBaleBridgeRuntime(state);
  let releaseAction: () => void = () => {};
  const pendingAction = new Promise<void>((resolve) => {
    releaseAction = resolve;
  });
  let calls = 0;
  const startTypingLoop = Runtime.createBaleTypingLoopStarter({
    failureLog: createPassthroughFailureLog(),
    typing: runtime.typing,
    getDefaultChatId: () => 7,
    sendTypingAction: async () => {
      calls += 1;
      await pendingAction;
    },
    updateStatus: () => {},
    intervalMs: 1000,
  });

  startTypingLoop({ id: "ctx" });
  await flushMicrotasks();
  assert.equal(calls, 1);
  ctx.mock.timers.tick(3000);
  await flushMicrotasks();
  assert.equal(calls, 1);

  releaseAction();
  await flushMicrotasks();
  ctx.mock.timers.tick(1000);
  await flushMicrotasks();
  assert.equal(calls, 2);
  assert.equal(runtime.typing.stop(), true);
  ctx.mock.timers.reset();
});

test("Typing loop records failures without changing bridge status", async () => {
  const state = Runtime.createBaleBridgeRuntimeState();
  const runtime = Runtime.createBaleBridgeRuntime(state);
  const sentChatIds: number[] = [];
  const statusErrors: string[] = [];
  const runtimeEvents: string[] = [];
  const recordTypingEvent = (
    category: string,
    error: unknown,
    details?: Record<string, unknown>,
  ) => {
    const message = error instanceof Error ? error.message : String(error);
    runtimeEvents.push(`${category}:${message}:${details?.chatId}`);
  };
  const startTypingLoop = Runtime.createBaleTypingLoopStarter<{
    id: string;
  }>({
    failureLog: createPassthroughFailureLog((error, details) =>
      recordTypingEvent("typing", error, details),
    ),
    typing: runtime.typing,
    getDefaultChatId: () => 7,
    sendTypingAction: async (chatId) => {
      sentChatIds.push(chatId);
    },
    updateStatus: (_ctx: { id: string }, error?: string) => {
      if (error) statusErrors.push(error);
    },
    recordRuntimeEvent: recordTypingEvent,
    intervalMs: 1000,
  });
  startTypingLoop({ id: "ctx" });
  await flushMicrotasks();
  assert.deepEqual(sentChatIds, [7]);
  assert.deepEqual(statusErrors, []);
  assert.equal(runtime.typing.stop(), true);
  const failingStatusErrors: string[] = [];
  const startFailingTypingLoop = Runtime.createBaleTypingLoopStarter<{
    id: string;
  }>({
    failureLog: createPassthroughFailureLog((error, details) =>
      recordTypingEvent("typing", error, details),
    ),
    typing: runtime.typing,
    getDefaultChatId: () => undefined,
    sendTypingAction: async () => {
      throw new Error("boom");
    },
    updateStatus: (_ctx: { id: string }, error?: string) => {
      if (error) failingStatusErrors.push(error);
    },
    recordRuntimeEvent: recordTypingEvent,
    intervalMs: 1000,
  });
  startFailingTypingLoop({ id: "ctx" }, 8);
  await flushMicrotasks();
  assert.deepEqual(failingStatusErrors, []);
  assert.deepEqual(runtimeEvents, ["typing:boom:8"]);
  assert.equal(runtime.typing.stop(), true);
});

test("Typing loop does not start without Bale transport authority", async () => {
  const runtime = Runtime.createBaleBridgeRuntime();
  let calls = 0;
  const startTypingLoop = Runtime.createBaleTypingLoopStarter({
    failureLog: createPassthroughFailureLog(),
    typing: runtime.typing,
    getDefaultChatId: () => 7,
    sendTypingAction: async () => {
      calls += 1;
    },
    updateStatus: () => {},
    isTransportAvailable: () => false,
  });

  startTypingLoop({ id: "ctx" });
  await flushMicrotasks();
  assert.equal(calls, 0);
  assert.equal(runtime.typing.stop(), false);
});

test("Typing loop stops after authority loss even when a request never settles", async (ctx) => {
  ctx.mock.timers.enable({ apis: ["setInterval"] });
  const runtime = Runtime.createBaleBridgeRuntime();
  let available = true;
  let calls = 0;
  const startTypingLoop = Runtime.createBaleTypingLoopStarter({
    failureLog: createPassthroughFailureLog(),
    typing: runtime.typing,
    getDefaultChatId: () => 7,
    sendTypingAction: () => {
      calls += 1;
      return new Promise(() => {});
    },
    updateStatus: () => {},
    isTransportAvailable: () => available,
    intervalMs: 1000,
  });

  startTypingLoop({ id: "ctx" });
  await flushMicrotasks();
  assert.equal(calls, 1);
  available = false;
  ctx.mock.timers.tick(1000);
  assert.equal(runtime.typing.stop(), false);
  assert.equal(calls, 1);
  ctx.mock.timers.reset();
});

test("Typing loop observes authority loss between successful timer ticks", async (ctx) => {
  ctx.mock.timers.enable({ apis: ["setInterval"] });
  const runtime = Runtime.createBaleBridgeRuntime();
  let available = true;
  let calls = 0;
  const startTypingLoop = Runtime.createBaleTypingLoopStarter({
    failureLog: createPassthroughFailureLog(),
    typing: runtime.typing,
    getDefaultChatId: () => 7,
    sendTypingAction: async () => {
      calls += 1;
    },
    updateStatus: () => {},
    isTransportAvailable: () => available,
    intervalMs: 1000,
  });

  startTypingLoop({ id: "ctx" });
  await flushMicrotasks();
  assert.equal(calls, 1);
  available = false;
  ctx.mock.timers.tick(1000);
  assert.equal(runtime.typing.stop(), false);
  assert.equal(calls, 1);
  ctx.mock.timers.reset();
});

test("Typing loop replacement detaches a permanently pending old request", async (ctx) => {
  ctx.mock.timers.enable({ apis: ["setInterval"] });
  const runtime = Runtime.createBaleBridgeRuntime();
  const calls: number[] = [];
  const startTypingLoop = Runtime.createBaleTypingLoopStarter({
    failureLog: createPassthroughFailureLog(),
    typing: runtime.typing,
    getDefaultChatId: () => 7,
    sendTypingAction: (chatId) => {
      calls.push(chatId);
      return chatId === 7 ? new Promise(() => {}) : Promise.resolve();
    },
    updateStatus: () => {},
    intervalMs: 1000,
  });

  startTypingLoop({ id: "ctx" });
  await flushMicrotasks();
  startTypingLoop({ id: "ctx" }, 8);
  ctx.mock.timers.tick(1000);
  await flushMicrotasks();
  assert.deepEqual(calls, [7, 8]);
  assert.equal(runtime.typing.stop(), true);
  ctx.mock.timers.reset();
});

test("Typing loop restarts after authority loss with an old request pending", async (ctx) => {
  ctx.mock.timers.enable({ apis: ["setInterval"] });
  const runtime = Runtime.createBaleBridgeRuntime();
  let available = true;
  const calls: number[] = [];
  const startTypingLoop = Runtime.createBaleTypingLoopStarter({
    failureLog: createPassthroughFailureLog(),
    typing: runtime.typing,
    getDefaultChatId: () => 7,
    sendTypingAction: (chatId) => {
      calls.push(chatId);
      return chatId === 7 ? new Promise(() => {}) : Promise.resolve();
    },
    updateStatus: () => {},
    isTransportAvailable: () => available,
    intervalMs: 1000,
  });

  startTypingLoop({ id: "ctx" });
  await flushMicrotasks();
  available = false;
  ctx.mock.timers.tick(1000);
  assert.equal(runtime.typing.stop(), false);
  available = true;
  startTypingLoop({ id: "ctx" }, 8);
  await flushMicrotasks();
  assert.deepEqual(calls, [7, 8]);
  assert.equal(runtime.typing.stop(), true);
  ctx.mock.timers.reset();
});

test("Typing loop replacement fences late failures from the old loop", async (ctx) => {
  ctx.mock.timers.enable({ apis: ["setInterval"] });
  const runtime = Runtime.createBaleBridgeRuntime();
  let rejectOld: ((error: Error) => void) | undefined;
  const calls: number[] = [];
  const statusErrors: string[] = [];
  const runtimeEvents: string[] = [];
  const startTypingLoop = Runtime.createBaleTypingLoopStarter({
    failureLog: createPassthroughFailureLog(),
    typing: runtime.typing,
    getDefaultChatId: () => 7,
    sendTypingAction: (chatId) => {
      calls.push(chatId);
      if (chatId === 7) {
        return new Promise((_resolve, reject) => {
          rejectOld = reject;
        });
      }
      return Promise.resolve();
    },
    updateStatus: (_ctx, error) => {
      if (error) statusErrors.push(error);
    },
    recordRuntimeEvent: (_category, error) => {
      runtimeEvents.push(String(error));
    },
    intervalMs: 1000,
  });

  startTypingLoop({ id: "ctx" });
  await flushMicrotasks();
  startTypingLoop({ id: "ctx" }, 8);
  rejectOld?.(new Error("stale failure"));
  await flushMicrotasks();
  assert.deepEqual(calls, [7, 8]);
  assert.deepEqual(statusErrors, []);
  assert.deepEqual(runtimeEvents, []);
  assert.equal(runtime.typing.stop(), true);
  ctx.mock.timers.reset();
});

test("Typing loop stops quietly when Bale transport authority is lost", async () => {
  const runtime = Runtime.createBaleBridgeRuntime();
  let available = true;
  let rejectAction: ((error: Error) => void) | undefined;
  const statusErrors: string[] = [];
  const runtimeEvents: string[] = [];
  const startTypingLoop = Runtime.createBaleTypingLoopStarter({
    failureLog: createPassthroughFailureLog(),
    typing: runtime.typing,
    getDefaultChatId: () => 7,
    sendTypingAction: () =>
      new Promise((_resolve, reject) => {
        rejectAction = reject;
      }),
    updateStatus: (_ctx, error) => {
      if (error) statusErrors.push(error);
    },
    isTransportAvailable: () => available,
    recordRuntimeEvent: (_category, error) => {
      runtimeEvents.push(String(error));
    },
  });

  startTypingLoop({ id: "ctx" });
  await flushMicrotasks();
  available = false;
  rejectAction?.(new Error("Bale bus follower is not registered."));
  await flushMicrotasks();
  assert.deepEqual(statusErrors, []);
  assert.deepEqual(runtimeEvents, []);
  assert.equal(runtime.typing.stop(), false);
});

test("Typing loop fences late failures across transport authority generations", async () => {
  const runtime = Runtime.createBaleBridgeRuntime();
  let authority: string | undefined = "A";
  let rejectOld: ((error: Error) => void) | undefined;
  const calls: number[] = [];
  const statusErrors: string[] = [];
  const runtimeEvents: string[] = [];
  const startTypingLoop = Runtime.createBaleTypingLoopStarter({
    failureLog: createPassthroughFailureLog(),
    typing: runtime.typing,
    getDefaultChatId: () => 7,
    sendTypingAction: (chatId) => {
      calls.push(chatId);
      if (chatId === 7) {
        return new Promise((_resolve, reject) => {
          rejectOld = reject;
        });
      }
      return Promise.resolve();
    },
    updateStatus: (_ctx, error) => {
      if (error) statusErrors.push(error);
    },
    getTransportAuthority: () => authority,
    recordRuntimeEvent: (_category, error) => {
      runtimeEvents.push(String(error));
    },
  });

  startTypingLoop({ id: "ctx" });
  await flushMicrotasks();
  authority = undefined;
  authority = "B";
  rejectOld?.(new Error("stale authority failure"));
  await flushMicrotasks();
  assert.deepEqual(statusErrors, []);
  assert.deepEqual(runtimeEvents, []);
  assert.equal(runtime.typing.stop(), false);
  startTypingLoop({ id: "ctx" }, 8);
  await flushMicrotasks();
  assert.deepEqual(calls, [7, 8]);
  assert.equal(runtime.typing.stop(), true);
});

for (const threaded of [false, true]) {
  test(`Stale context cannot start or replace current typing with the same transport epoch (threaded=${threaded})`, async (t) => {
    t.mock.timers.enable({ apis: ["setInterval"] });
    const typing = Runtime.createBaleTypingLoop(), current = {}, stale = {}, calls: number[] = [];
    const start = Runtime.createBaleTypingLoopStarter({
   failureLog: createPassthroughFailureLog(),
   typing, getDefaultChatId: () => 7,
      isThreadedMode: () => threaded, getTransportAuthority: () => "unchanged", isContextActive: ctx => ctx === current,
      sendTypingAction: async (_chat, options) => { calls.push(options?.message_thread_id ?? 0); }, updateStatus() {} });
    try {
      assert.equal(start(stale, 7, { target: { chatId: 7, ...(threaded ? { threadId: 41 } : {}) } }), false);
      await flushMicrotasks(); assert.deepEqual(calls, []); assert.equal(typing.stop(), false);
      assert.equal(start(current, 7, { target: { chatId: 7, ...(threaded ? { threadId: 42 } : {}) } }), true);
      await flushMicrotasks();
      assert.equal(start(stale, 7, { target: { chatId: 7, ...(threaded ? { threadId: 43 } : {}) } }), false);
      t.mock.timers.tick(3000); await flushMicrotasks();
      assert.deepEqual(calls, threaded ? [42, 42] : [0, 0]);
    } finally { typing.stop(); }
  });
}

for (const pending of [false, true]) {
  test(`Typing stops after context loss under the same transport epoch (pending=${pending})`, async (t) => {
    t.mock.timers.enable({ apis: ["setInterval"] });
    const typing = Runtime.createBaleTypingLoop(); let active = true, calls = 0;
    const start = Runtime.createBaleTypingLoopStarter({
   failureLog: createPassthroughFailureLog(),
   typing, getDefaultChatId: () => 7,
      isThreadedMode: () => true, getTransportAuthority: () => "unchanged", isContextActive: () => active,
      sendTypingAction: async () => { calls++; if (pending) await new Promise(() => {}); }, updateStatus() {} });
    try {
      assert.equal(start({}, 7, { target: { chatId: 7, threadId: 42 } }), true); await flushMicrotasks();
      active = false; t.mock.timers.tick(6000); await flushMicrotasks();
      assert.equal(calls, 1); assert.equal(typing.stop(), false);
    } finally { typing.stop(); }
  });
}

for (const pending of [false, true]) {
  test(`Typing captures session generation across reused context and late old failure (pending=${pending})`, async (t) => {
    t.mock.timers.enable({ apis: ["setInterval"] });
    const typing = Runtime.createBaleTypingLoop(), ctx = {}, calls: number[] = [], failures: unknown[] = [];
    let generation = 1, rejectOld: ((error: Error) => void) | undefined;
    const start = Runtime.createBaleTypingLoopStarter({
   failureLog: createPassthroughFailureLog(),
   typing, getDefaultChatId: () => 7,
      isThreadedMode: () => true, getTransportAuthority: () => "unchanged", isContextActive: () => true,
      getSessionGeneration: () => generation,
      sendTypingAction: async (_chat, options) => { const threadId = options?.message_thread_id ?? 0; calls.push(threadId);
        if (pending && threadId === 41) await new Promise((_resolve, reject) => { rejectOld = reject; }); },
      recordRuntimeEvent(_category, error) { failures.push(error); }, updateStatus() {} });
    try {
      assert.equal(start(ctx, 7, { target: { chatId: 7, threadId: 41 } }), true); await flushMicrotasks();
      generation++; t.mock.timers.tick(3000); await flushMicrotasks(); assert.deepEqual(calls, [41]); assert.equal(typing.stop(), false);
      assert.equal(start(ctx, 7, { target: { chatId: 7, threadId: 42 } }), true); await flushMicrotasks();
      rejectOld?.(new Error("old context failure")); await flushMicrotasks();
      t.mock.timers.tick(3000); await flushMicrotasks(); assert.deepEqual(calls, [41, 42, 42]); assert.deepEqual(failures, []);
    } finally { typing.stop(); }
  });
}

for (const replace of [false, true]) test(`Context loss before the scheduled first action refuses sending (replacement=${replace})`, async () => {
  const typing = Runtime.createBaleTypingLoop(), old = {}, replacement = {}, calls: number[] = [];
  let current = old;
  const start = Runtime.createBaleTypingLoopStarter({
   failureLog: createPassthroughFailureLog(),
   typing, getDefaultChatId: () => 7,
    isContextActive: ctx => ctx === current, getTransportAuthority: () => "unchanged", isThreadedMode: () => true,
    sendTypingAction: async (_chat, options) => { calls.push(options?.message_thread_id ?? 0); }, updateStatus() {} });
  try {
    start(old, 7, { target: { chatId: 7, threadId: 41 } });
    current = replacement;
    if (replace) start(replacement, 7, { target: { chatId: 7, threadId: 42 } });
    await flushMicrotasks(); assert.deepEqual(calls, replace ? [42] : []); assert.equal(typing.stop(), replace);
  } finally { typing.stop(); }
});

for (const stage of ["before-issuance", "after-issuance"] as const) {
  test(`Repeated work presence preserves an in-flight typing action ${stage}`, async (t) => {
    t.mock.timers.enable({ apis: ["setInterval"] });
    const typing = Runtime.createBaleTypingLoop(), ctx = {}, failures: unknown[] = [];
    let release!: () => void, issued = 0, completed = 0;
    const held = new Promise<void>(resolve => { release = resolve; });
    const start = Runtime.createBaleTypingLoopStarter({
      failureLog: createPassthroughFailureLog(),
      typing, getDefaultChatId: () => 7, isContextActive: value => value === ctx,
      getSessionGeneration: () => 1, getTransportAuthority: () => "unchanged", isThreadedMode: () => true,
      async sendTypingAction(_chat, options) {
        if (stage === "before-issuance") await held;
        options!.assertAuthority!(); issued++;
        if (stage === "after-issuance") await held;
        options!.assertAuthority!(); completed++;
      },
      recordRuntimeEvent(_category, error) { failures.push(error); }, updateStatus() {},
    });
    try {
      start(ctx, 7, { target: { chatId: 7, threadId: 42 } }); await flushMicrotasks();
      for (let update = 0; update < 100; update++) {
        assert.equal(start(ctx, 7, { target: { chatId: 7, threadId: 42 }, ensure: true }), false);
      }
      release(); await flushMicrotasks();
      assert.equal(issued, 1); assert.equal(completed, 1); assert.deepEqual(failures, []);
      t.mock.timers.tick(3000); await flushMicrotasks();
      assert.equal(issued, 2); assert.equal(completed, 2);
    } finally { release(); typing.stop(); }
  });
}

for (const withGeneration of [true, false]) {
  test(`Fresh SDK context wrappers ${withGeneration ? "preserve" : "replace"} presence ${withGeneration ? "within a session generation" : "without generation evidence"}`, async (t) => {
    t.mock.timers.enable({ apis: ["setInterval"] });
    const typing = Runtime.createBaleTypingLoop(), sessionManager = {};
    const first = { sessionManager }, next = { sessionManager }, guards: Array<() => void> = [];
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const start = Runtime.createBaleTypingLoopStarter<typeof first>({
      failureLog: createPassthroughFailureLog(),
      typing, getDefaultChatId: () => 7, isContextActive: ctx => ctx.sessionManager === sessionManager,
      ...(withGeneration ? { getSessionGeneration: () => 1 } : {}),
      getTransportAuthority: () => "unchanged", isThreadedMode: () => true,
      async sendTypingAction(_chat, options) { guards.push(options!.assertAuthority!); if (guards.length === 1) await held; },
      updateStatus() {},
    });
    try {
      start(first, 7, { target: { chatId: 7, threadId: 42 } }); await flushMicrotasks();
      start(next, 7, { target: { chatId: 7, threadId: 42 }, ensure: true });
      if (withGeneration) assert.doesNotThrow(guards[0]);
      else assert.throws(guards[0], /Typing context authority changed/);
      release(); await flushMicrotasks(); t.mock.timers.tick(3000); await flushMicrotasks();
      assert.doesNotThrow(guards.at(-1)!);
    } finally { release(); typing.stop(); }
  });
}

for (const changed of ["context", "generation", "transport", "chat", "thread", "stopped"] as const) {
  test(`Ensuring work presence cannot retain an action after ${changed} changes`, async (t) => {
    t.mock.timers.enable({ apis: ["setInterval"] });
    const typing = Runtime.createBaleTypingLoop(), firstContext = {}, guards: Array<() => void> = [];
    let current = firstContext, generation = 1, authority = "first", release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const start = Runtime.createBaleTypingLoopStarter({
      failureLog: createPassthroughFailureLog(),
      typing, getDefaultChatId: () => 7, isContextActive: ctx => ctx === current,
      getSessionGeneration: () => generation, getTransportAuthority: () => authority, isThreadedMode: () => true,
      async sendTypingAction(_chat, options) { guards.push(options!.assertAuthority!); if (guards.length === 1) await held; },
      updateStatus() {},
    });
    try {
      start(firstContext, 7, { target: { chatId: 7, threadId: 42 } }); await flushMicrotasks();
      if (changed === "context") current = {};
      if (changed === "generation") generation++;
      if (changed === "transport") authority = "replacement";
      if (changed === "stopped") typing.stop();
      const chatId = changed === "chat" ? 8 : 7, threadId = changed === "thread" ? 43 : 42;
      start(current, chatId, { target: { chatId, threadId }, ensure: true });
      assert.throws(guards[0], /Typing context authority changed/);
      release(); await flushMicrotasks(); t.mock.timers.tick(3000); await flushMicrotasks();
      assert.ok(guards.length >= 2); assert.doesNotThrow(guards.at(-1)!);
    } finally { release(); typing.stop(); }
  });
}

for (const end of ["stop", "same-target-replacement"] as const) {
  test(`Typing transport guard cannot outlive its loop with unchanged context and epoch (${end})`, async (t) => {
    t.mock.timers.enable({ apis: ["setInterval"] });
    const typing = Runtime.createBaleTypingLoop(), ctx = {}, guards: Array<() => void> = [], failures: unknown[] = [];
    let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
    const start = Runtime.createBaleTypingLoopStarter({
   failureLog: createPassthroughFailureLog(),
   typing, getDefaultChatId: () => 7,
      isContextActive: value => value === ctx, getSessionGeneration: () => 1, getTransportAuthority: () => "unchanged", isThreadedMode: () => true,
      async sendTypingAction(_chat, options) { guards.push(options!.assertAuthority!); if (guards.length === 1) await held; options!.assertAuthority!(); },
      recordRuntimeEvent(_category, error) { failures.push(error); }, updateStatus() {} });
    try {
      start(ctx, 7, { target: { chatId: 7, threadId: 42 } }); await flushMicrotasks();
      if (end === "stop") typing.stop(); else start(ctx, 7, { target: { chatId: 7, threadId: 42 } });
      assert.throws(guards[0], /Typing context authority changed/); release(); await flushMicrotasks();
      t.mock.timers.tick(3000); await flushMicrotasks(); assert.deepEqual(failures, []);
      assert.equal(guards.length, end === "stop" ? 1 : 2);
      if (end !== "stop") assert.doesNotThrow(guards[1]);
      assert.equal(typing.stop(), end !== "stop");
    } finally { release(); typing.stop(); }
  });
}

test("Typing loop ignores late failures from a replaced session context", async () => {
  const runtime = Runtime.createBaleBridgeRuntime();
  let active = true;
  let rejectAction: ((error: Error) => void) | undefined;
  const statusErrors: string[] = [];
  const runtimeEvents: string[] = [];
  const startTypingLoop = Runtime.createBaleTypingLoopStarter({
    failureLog: createPassthroughFailureLog(),
    typing: runtime.typing,
    getDefaultChatId: () => 7,
    sendTypingAction: () =>
      new Promise((_resolve, reject) => {
        rejectAction = reject;
      }),
    updateStatus: (_ctx, error) => {
      if (error) statusErrors.push(error);
    },
    isContextActive: () => active,
    recordRuntimeEvent: (_category, error) => {
      runtimeEvents.push(String(error));
    },
  });

  startTypingLoop({ id: "old" });
  await flushMicrotasks();
  active = false;
  runtime.typing.stop();
  rejectAction?.(new Error("late typing failure"));
  await flushMicrotasks();
  assert.deepEqual(statusErrors, []);
  assert.deepEqual(runtimeEvents, []);
});

test("Typing loop failure diagnostics do not invoke status updates", async () => {
  const state = Runtime.createBaleBridgeRuntimeState();
  const runtime = Runtime.createBaleBridgeRuntime(state);
  const runtimeEvents: string[] = [];
  const recordTypingEvent = (
    category: string,
    error: unknown,
    details?: Record<string, unknown>,
  ) => {
    const message = error instanceof Error ? error.message : String(error);
    runtimeEvents.push(
      `${category}:${message}:${details?.phase ?? details?.chatId}`,
    );
  };
  const startTypingLoop = Runtime.createBaleTypingLoopStarter<{
    id: string;
  }>({
    failureLog: createPassthroughFailureLog((error, details) =>
      recordTypingEvent("typing", error, details),
    ),
    typing: runtime.typing,
    getDefaultChatId: () => undefined,
    sendTypingAction: async () => {
      throw new Error("typing failed");
    },
    updateStatus: () => {
      throw new Error("stale ctx");
    },
    recordRuntimeEvent: recordTypingEvent,
    intervalMs: 1000,
  });

  startTypingLoop({ id: "ctx" }, 8);
  await flushMicrotasks();

  assert.deepEqual(runtimeEvents, ["typing:typing failed:8"]);
  assert.equal(runtime.typing.stop(), true);
});

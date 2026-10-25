/**
 * Regression tests for the Bale polling runtime domain
 * Covers polling request helpers, stop conditions, and the long-poll loop runtime in one suite
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  admitBalePollingUpdateBatch,
  applyBaleThreadCapability,
  buildBaleInitialSyncRequest,
  buildBaleLongPollRequest,
  canProbeBaleThreadCapability,
  createBaleDurablePollingRuntimeAssembly,
  createBalePollingActivityReader,
  createBalePollingAdmissionRuntime,
  createBalePollingController,
  createBalePollingControllerRuntime,
  createBalePollingControllerState,
  createBalePollingStateReader,
  createBalePollLoopRunner,
  createBaleThreadAwarePollingPorts,
  createBaleThreadCapabilityMonitor,
  createBaleThreadCapabilityOrchestration,
  createBaleThreadCapabilityStateRuntime,
  type BaleThreadCapabilityState,
  createBaleThreadTargetObservationBinding,
  cutOverBalePollingCursor,
  getLatestBaleUpdateId,
  getBaleGetUpdatesRequestBudgetMs,
  getBalePollingRetryDelayMs,
  isBaleGetUpdatesConflictError,
  isBalePollingControllerActive,
  runBalePollLoop,
  shouldStartBalePolling,
  shouldStopBalePolling,
  sleepBalePollingRetry,
  startBalePollingRuntime,
  stopBalePollingRuntime,
  BALE_ALLOWED_UPDATES,
  BALE_GET_UPDATES_CONFLICT_STOP_LIMIT,
  BalePersistentGetUpdatesConflictError,
  BaleGetUpdatesTimeoutError,
  BalePollingBatchValidationError,
  BalePollingCursorBootstrapError,
} from "../lib/polling.ts";
import { createPassthroughFailureLog } from "./fixtures/failure-log.ts";
import { createBaleFailureRunLog } from "../lib/logging.ts";

const TEST_CONTEXT = "ctx";
const NOOP_JOURNAL_ADMISSION = {
  appendUpdateBatch: (_updates: readonly { update_id: number }[]) => undefined,
  getAcceptedThroughUpdateId: () => 1,
  getJournalEntryCount: () => 0,
  signalUpdateWorker: () => {},
};

async function waitForPollingCondition(
  predicate: () => boolean,
  message: string,
): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.fail(message);
}

test("Polling helpers build the initial sync request", () => {
  assert.deepEqual(buildBaleInitialSyncRequest(), {
    offset: -1,
    limit: 1,
    timeout: 0,
  });
});

test("Polling helpers build long-poll requests with and without lastUpdateId", () => {
  assert.deepEqual(buildBaleLongPollRequest(), {
    offset: undefined,
    limit: 10,
    timeout: 30,
    allowed_updates: BALE_ALLOWED_UPDATES,
  });
  assert.deepEqual(buildBaleLongPollRequest(41), {
    offset: 42,
    limit: 10,
    timeout: 30,
    allowed_updates: BALE_ALLOWED_UPDATES,
  });
});

test("Polling getUpdates budgets derive from the declared long-poll timeout", () => {
  assert.equal(
    getBaleGetUpdatesRequestBudgetMs(buildBaleInitialSyncRequest()),
    10_000,
  );
  assert.equal(
    getBaleGetUpdatesRequestBudgetMs(buildBaleLongPollRequest()),
    40_000,
  );
  assert.equal(getBaleGetUpdatesRequestBudgetMs({ timeout: 2 }, 500), 2_500);
});

test("Polling helpers extract the latest update id", () => {
  assert.equal(getLatestBaleUpdateId([]), undefined);
  assert.equal(
    getLatestBaleUpdateId([{ update_id: 1 }, { update_id: 7 }]),
    7,
  );
});

test("Polling cursor cutover is journal-first, idempotent, and preserves existing authority", async () => {
  let legacyCursor: number | undefined = 5;
  let journalCursor: number | undefined;
  const entries = [{ updateId: 7 }];
  const events: string[] = [];
  let failRemoval = true;
  const cutOver = () =>
    cutOverBalePollingCursor({
      getLegacyCursor: () => legacyCursor,
      readJournal: () => ({
        ...(journalCursor !== undefined
          ? { acceptedThroughUpdateId: journalCursor }
          : {}),
        entries,
      }),
      publishJournalCursor(cursor) {
        events.push(`journal:${cursor}`);
        journalCursor = cursor;
      },
      removeLegacyCursor() {
        events.push("config:remove");
        if (failRemoval) throw new Error("config publication failed");
        legacyCursor = undefined;
      },
    });

  await assert.rejects(cutOver(), /config publication failed/u);
  assert.equal(journalCursor, 7);
  assert.equal(legacyCursor, 5);
  failRemoval = false;
  await cutOver();
  assert.equal(journalCursor, 7);
  assert.equal(legacyCursor, undefined);
  assert.deepEqual(events, ["journal:7", "config:remove", "config:remove"]);

  legacyCursor = 99;
  journalCursor = 100;
  await cutOver();
  assert.equal(journalCursor, 100);
  assert.equal(legacyCursor, undefined);
});

test("Polling cursor cutover never removes config authority when journal publication fails", async () => {
  let removeCalls = 0;
  await assert.rejects(
    cutOverBalePollingCursor({
      getLegacyCursor: () => 5,
      readJournal: () => ({ entries: [] }),
      publishJournalCursor() {
        throw new Error("journal publication failed");
      },
      removeLegacyCursor() {
        removeCalls += 1;
      },
    }),
    /journal publication failed/u,
  );
  assert.equal(removeCalls, 0);
});

test("Polling batch admission journals one latest cursor before worker signal", async () => {
  const config = { botToken: "123:abc", lastUpdateId: 999 };
  let acceptedThroughUpdateId = 5;
  const events: string[] = [];
  const result = await admitBalePollingUpdateBatch({
    updates: [{ update_id: 6 }, { update_id: 7 }],
    config,
    getAcceptedThroughUpdateId: () => acceptedThroughUpdateId,
    appendBatch(updates, cursor) {
      events.push(
        `append:${updates.map((update) => update.update_id).join(",")}:${cursor}`,
      );
      acceptedThroughUpdateId = cursor!;
    },
    async persistConfig() {
      events.push("unexpected-config-persist");
    },
    signalWorker() {
      events.push("signal");
    },
    onPhaseChange(phase, updateId) {
      events.push(`phase:${phase}:${updateId}`);
    },
  });
  assert.deepEqual(result, { updateCount: 2, latestUpdateId: 7 });
  assert.equal(config.lastUpdateId, 999);
  assert.equal(acceptedThroughUpdateId, 7);
  assert.deepEqual(events, [
    "phase:persisting-journal:6",
    "append:6,7:7",
    "signal",
  ]);
});

test("Polling batch admission leaves offset and worker untouched when journal append fails", async () => {
  const config = { botToken: "123:abc", lastUpdateId: 5 };
  let persistCalls = 0;
  let signalCalls = 0;
  await assert.rejects(
    admitBalePollingUpdateBatch({
      updates: [{ update_id: 6 }, { update_id: 7 }],
      config,
      appendBatch() {
        throw new Error("journal unavailable");
      },
      async persistConfig() {
        persistCalls += 1;
      },
      signalWorker() {
        signalCalls += 1;
      },
    }),
    /journal unavailable/u,
  );
  assert.equal(config.lastUpdateId, 5);
  assert.equal(persistCalls, 0);
  assert.equal(signalCalls, 0);
});

test("Polling batch admission leaves cursor and worker untouched when atomic journal publication fails", async () => {
  const config = { botToken: "123:abc", lastUpdateId: 999 };
  let acceptedThroughUpdateId = 5;
  let signalCalls = 0;
  await assert.rejects(
    admitBalePollingUpdateBatch({
      updates: [{ update_id: 6 }],
      config,
      getAcceptedThroughUpdateId: () => acceptedThroughUpdateId,
      appendBatch() {
        throw new Error("journal commit failed");
      },
      async persistConfig() {
        assert.fail("config persistence must not own the polling cursor");
      },
      signalWorker() {
        signalCalls += 1;
      },
    }),
    /journal commit failed/u,
  );
  assert.equal(acceptedThroughUpdateId, 5);
  assert.equal(config.lastUpdateId, 999);
  assert.equal(signalCalls, 0);
});

test("Polling batch admission fails closed on non-monotonic ids", async () => {
  let appendCalls = 0;
  await assert.rejects(
    admitBalePollingUpdateBatch({
      updates: [{ update_id: 7 }, { update_id: 6 }],
      config: { botToken: "123:abc" },
      getAcceptedThroughUpdateId: () => 5,
      appendBatch() {
        appendCalls += 1;
      },
      async persistConfig() {},
      signalWorker() {},
    }),
    BalePollingBatchValidationError,
  );
  assert.equal(appendCalls, 0);
});

test("Polling restart replays journal authority after offset commit but before worker signal", async () => {
  const config = { botToken: "123:abc", lastUpdateId: 999 };
  let acceptedThroughUpdateId = 5;
  const journal = new Set<number>();
  await admitBalePollingUpdateBatch({
    updates: [{ update_id: 6 }],
    config,
    getAcceptedThroughUpdateId: () => acceptedThroughUpdateId,
    appendBatch(updates, cursor) {
      for (const update of updates) journal.add(update.update_id);
      acceptedThroughUpdateId = cursor!;
    },
    async persistConfig() {
      assert.fail("config persistence must not own the polling cursor");
    },
    signalWorker() {
      throw new Error("process exited before worker signal");
    },
  });
  assert.equal(config.lastUpdateId, 999);
  assert.equal(acceptedThroughUpdateId, 6);
  assert.deepEqual([...journal], [6]);

  const replayedOnRestart: number[] = [];
  for (const updateId of journal) replayedOnRestart.push(updateId);
  assert.deepEqual(replayedOnRestart, [6]);
  journal.delete(6);
  assert.deepEqual([...journal], []);
});

test("Polling batch admission contains worker signal failures after durable offset", async () => {
  const config = { botToken: "123:abc", lastUpdateId: 999 };
  let acceptedThroughUpdateId = 5;
  const runtimeEvents: Array<{
    error: unknown;
    details?: Record<string, unknown>;
  }> = [];
  await admitBalePollingUpdateBatch({
    updates: [{ update_id: 6 }],
    config,
    getAcceptedThroughUpdateId: () => acceptedThroughUpdateId,
    appendBatch(_updates, cursor) {
      acceptedThroughUpdateId = cursor!;
    },
    async persistConfig() {
      assert.fail("config persistence must not own the polling cursor");
    },
    signalWorker() {
      throw new Error("worker unavailable");
    },
    recordRuntimeEvent(_category, error, details) {
      runtimeEvents.push({ error, details });
    },
  });
  assert.equal(config.lastUpdateId, 999);
  assert.equal(acceptedThroughUpdateId, 6);
  assert.equal(runtimeEvents.length, 1);
  assert.match(String(runtimeEvents[0]?.error), /worker unavailable/u);
  assert.deepEqual(runtimeEvents[0]?.details, {
    phase: "worker-signal",
    updateCount: 1,
    latestUpdateId: 6,
  });
});

test("Polling activity reports lifecycle ownership without inventing health", () => {
  const state = createBalePollingControllerState();
  const isActive = createBalePollingActivityReader(state);
  const readState = createBalePollingStateReader(state);

  assert.equal(isActive(), false);
  assert.deepEqual(readState(), {
    phase: "stopped",
    phaseStartedAtMs: undefined,
    currentUpdateId: undefined,
    startedAtMs: undefined,
    stoppedAtMs: undefined,
    lastSuccessfulResponseAtMs: undefined,
    lastSuccessfulResponseUpdateCount: undefined,
    stopReason: "not-started",
  });

  state.pollingPromise = new Promise<void>(() => {});
  state.phase = "persisting-journal";
  state.currentUpdateId = 42;
  assert.equal(isActive(), true);
  assert.equal(readState().phase, "persisting-journal");
  assert.equal(readState().currentUpdateId, 42);

  state.pollingPromise = undefined;
  assert.equal(isActive(), false);
});

test("Thread capability probes require direct or registered follower authority", () => {
  assert.equal(
    canProbeBaleThreadCapability(TEST_CONTEXT, {
      ownsLock: () => false,
      isFollowerRegistered: () => false,
    }),
    false,
  );
  assert.equal(
    canProbeBaleThreadCapability(TEST_CONTEXT, {
      ownsLock: () => true,
      isFollowerRegistered: () => false,
    }),
    true,
  );
  assert.equal(
    canProbeBaleThreadCapability(TEST_CONTEXT, {
      ownsLock: () => false,
      isFollowerRegistered: () => true,
    }),
    true,
  );
});

test("Thread capability monitor stays passive before transport authorization", async () => {
  let calls = 0;
  const monitor = createBaleThreadCapabilityMonitor({
    failureLog: createPassthroughFailureLog(),
    getAllowedUserId: () => 7,
    callApi: async <TResponse>() => {
      calls += 1;
      return {} as TResponse;
    },
    topicTargetStore: {
      load: async () => {},
      persist: async () => {},
      getBotState: () => ({}),
      setBotState: () => {},
    },
    ownsLock: () => false,
    isFollowerRegistered: () => false,
    getPollingStartedWithBaleBus: () => false,
    setPollingStartedWithBaleBus: () => {},
    setTopicModeUnavailable: () => {},
    stopFollowerRegistration: () => {},
    startClassicPolling: () => {},
    stopClassicPolling: () => {},
    startBusPolling: () => {},
    stopBusPolling: () => {},
    startLeaderHealth: () => {},
    stopLeaderHealth: () => {},
    updateStatus: () => {},
    recordEvent: () => {},
    intervalMs: 1,
  });

  monitor.start(TEST_CONTEXT);
  await new Promise((resolve) => setTimeout(resolve, 10));
  monitor.stop();
  assert.equal(calls, 0);
});

test("Thread capability monitor stops after synchronous stale-context preflight", async () => {
  let ownershipReads = 0;
  let records = 0;
  let apiCalls = 0;
  const recordEvent = (_category: string, error: unknown) => {
    assert.match(String(error), /ctx is stale/);
    records += 1;
    throw new Error("diagnostic sink failed");
  };
  const staleContext = { get cwd(): string {
    ownershipReads += 1;
    throw new Error("This extension ctx is stale after session replacement or reload.");
  } };
  const monitor = createBaleThreadCapabilityMonitor({
    failureLog: createPassthroughFailureLog((error) => recordEvent("bus", error)),
    getAllowedUserId: () => 7,
    callApi: async <TResponse>() => { apiCalls += 1; return {} as TResponse; },
    topicTargetStore: { load: async () => {}, persist: async () => {},
      getBotState: () => ({}), setBotState: () => {} },
    ownsLock: (ctx: typeof staleContext) => ctx.cwd === "/project",
    isFollowerRegistered: () => false,
    getPollingStartedWithBaleBus: () => false,
    setPollingStartedWithBaleBus: () => {}, setTopicModeUnavailable: () => {},
    stopFollowerRegistration: () => {}, startClassicPolling: () => {},
    stopClassicPolling: () => {}, startBusPolling: () => {}, stopBusPolling: () => {},
    startLeaderHealth: () => {}, stopLeaderHealth: () => {}, updateStatus: () => {},
    recordEvent,
    intervalMs: 1,
  });
  monitor.start(staleContext);
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(ownershipReads, 1);
  assert.equal(apiCalls, 0);
  assert.equal(records, 1);
  monitor.stop();
});

test("Thread capability monitor collapses a sustained probe failure and reports its recovery", async () => {
  const events: Array<{ details?: Record<string, unknown> }> = [];
  let failing = true;
  let probes = 0;
  const monitor = createBaleThreadCapabilityMonitor({
    failureLog: createBaleFailureRunLog({
      category: "bus",
      failurePhase: "capability-monitor",
      outcomePhase: "capability-monitor-recovered",
      label: "Threaded Mode capability probe",
      record: (_category, _errorOrMessage, details) => events.push({ details }),
    }),
    getAllowedUserId: () => 7,
    callApi: async <TResponse>() => {
      probes += 1;
      if (failing) throw Object.assign(new Error("connect ENOENT"), { code: "ENOENT" });
      return { has_topics_enabled: true } as TResponse;
    },
    topicTargetStore: { load: async () => {}, persist: async () => {},
      getBotState: () => ({}), setBotState: () => {} },
    ownsLock: () => true,
    isFollowerRegistered: () => false,
    getPollingStartedWithBaleBus: () => false,
    setPollingStartedWithBaleBus: () => {}, setTopicModeUnavailable: () => {},
    stopFollowerRegistration: () => {}, startClassicPolling: () => {},
    stopClassicPolling: () => {}, startBusPolling: () => {}, stopBusPolling: () => {},
    startLeaderHealth: () => {}, stopLeaderHealth: () => {}, updateStatus: () => {},
    recordEvent: (_category, _error, details) => events.push({ details }),
    intervalMs: 5,
  });
  const failures = () => events.filter((event) => event.details?.phase === "capability-monitor");
  const recovered = () => events.find((event) => event.details?.phase === "capability-monitor-recovered");
  try {
    monitor.start(TEST_CONTEXT);
    for (let tick = 0; tick < 50 && (probes < 3 || failures().length === 0); tick += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
    assert.ok(probes >= 3, `expected repeated probes, saw ${probes}`);
    assert.equal(failures().length, 1, "a repeated identical probe failure is logged once");
    assert.equal(failures()[0]?.details?.failureSignature, "ENOENT");
    failing = false;
    for (let tick = 0; tick < 50 && !recovered(); tick += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
    assert.ok(recovered(), "a successful probe closes the failure run");
    assert.ok(Number(recovered()?.details?.failedAttempts) >= 3);
  } finally {
    monitor.stop();
  }
});

test("Thread capability monitor invalidates a replaced session before reading its context", async () => {
  const reads = { old: 0, current: 0 };
  let records = 0;
  const oldContext = { session: "old" as const };
  const currentContext = { session: "current" as const };
  const monitor = createBaleThreadCapabilityMonitor({
    failureLog: createPassthroughFailureLog(),
    getAllowedUserId: () => 7, callApi: async <TResponse>() => ({} as TResponse),
    topicTargetStore: { load: async () => {}, persist: async () => {},
      getBotState: () => ({}), setBotState: () => {} },
    ownsLock: (ctx: typeof oldContext | typeof currentContext) => {
      reads[ctx.session] += 1;
      if (ctx.session === "old") throw new Error("old context was read");
      return false;
    },
    isFollowerRegistered: () => false, getPollingStartedWithBaleBus: () => false,
    setPollingStartedWithBaleBus: () => {}, setTopicModeUnavailable: () => {},
    stopFollowerRegistration: () => {}, startClassicPolling: () => {},
    stopClassicPolling: () => {}, startBusPolling: () => {}, stopBusPolling: () => {},
    startLeaderHealth: () => {}, stopLeaderHealth: () => {}, updateStatus: () => {},
    recordEvent: () => { records += 1; }, intervalMs: 1,
  });
  monitor.start(oldContext);
  monitor.start(currentContext);
  await new Promise(resolve => setTimeout(resolve, 10));
  monitor.stop();
  assert.equal(reads.old, 0);
  assert.ok(reads.current > 0);
  assert.equal(records, 0);
});

test("Thread capability monitor serializes probes across lifecycle generations", async () => {
  let calls = 0;
  let state: { threadMode?: "enabled" | "disabled" | "unknown" } = {};
  const releases: Array<(value: unknown) => void> = [];
  const monitor = createBaleThreadCapabilityMonitor({
    failureLog: createPassthroughFailureLog(),
    getAllowedUserId: () => 7,
    callApi: <TResponse>() =>
      new Promise<TResponse>((resolve) => {
        calls += 1;
        releases.push(resolve as (value: unknown) => void);
      }),
    topicTargetStore: {
      load: async () => {},
      persist: async () => {},
      getBotState: () => state,
      setBotState: (next) => {
        state = { ...state, ...next };
      },
    },
    ownsLock: () => true,
    isFollowerRegistered: () => false,
    getPollingStartedWithBaleBus: () => false,
    setPollingStartedWithBaleBus: () => {},
    setTopicModeUnavailable: () => {},
    stopFollowerRegistration: () => {},
    startClassicPolling: () => {},
    stopClassicPolling: () => {},
    startBusPolling: () => {},
    stopBusPolling: () => {},
    startLeaderHealth: () => {},
    stopLeaderHealth: () => {},
    updateStatus: () => {},
    recordEvent: () => {},
    intervalMs: 1,
  });

  monitor.start(TEST_CONTEXT);
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(calls, 1);
  monitor.stop();
  monitor.start(TEST_CONTEXT);
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(calls, 1);
  releases[0]?.({ id: 1, has_topics_enabled: true });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(calls, 2);
  assert.equal(state.threadMode, undefined);
  releases[1]?.({ id: 1, has_topics_enabled: true });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(state.threadMode, "enabled");
  monitor.stop();
});

test("Thread target observation binding supports late runtime composition", async () => {
  const events: string[] = [];
  const binding = createBaleThreadTargetObservationBinding<string>();

  await binding.handle("before");
  binding.set(async (ctx) => {
    events.push(ctx);
  });
  await binding.handle("after");

  assert.deepEqual(events, ["after"]);
});

test("Thread capability state runtime owns transition flags", () => {
  const state = createBaleThreadCapabilityStateRuntime();

  assert.equal(state.isBusPollingStarted(), false);
  assert.equal(state.isTopicModeUnavailable(), false);
  assert.equal(state.shouldForceFreshLeaderThread(), false);
  assert.equal(state.getRequestedThreadName(), undefined);

  state.setBusPollingStarted(true);
  state.setTopicModeUnavailable(true);
  state.setForceFreshLeaderThread(true);
  state.setRequestedThreadName("Navigator");

  assert.equal(state.isBusPollingStarted(), true);
  assert.equal(state.isTopicModeUnavailable(), true);
  assert.equal(state.shouldForceFreshLeaderThread(), true);
  assert.equal(state.getRequestedThreadName(), "Navigator");
});

function createCapabilityLifecycleFixture(hooks: {
  getMe: () => Promise<boolean | undefined>;
  initialBot?: BaleThreadCapabilityState;
  ownsLock?: () => boolean;
  isFollowerRegistered?: () => boolean;
  persist?: () => Promise<void>;
  startBus?: () => Promise<void>;
}) {
  const state = createBaleThreadCapabilityStateRuntime();
  let bot: BaleThreadCapabilityState = hooks.initialBot ?? {};
  const calls: string[] = [];
  const runtime = createBaleThreadCapabilityOrchestration<string, unknown>({
    failureLog: createPassthroughFailureLog(),
    state, getAllowedUserId: () => 1,
    callApi: async <TResponse,>() => ({ has_topics_enabled: await hooks.getMe() }) as TResponse,
    topicTargetStore: {
      load: async () => {},
      persist: async () => { calls.push("persist"); await hooks.persist?.(); },
      getBotState: () => bot,
      setBotState: (value) => { bot = value; calls.push(`bot:${value.threadMode}`); },
    },
    ownsLock: hooks.ownsLock ?? (() => true), isFollowerRegistered: hooks.isFollowerRegistered,
    isBusRuntimeEnabled: state.isBusRuntimeEnabled,
    startClassicPolling: () => { calls.push("classic-start"); },
    stopClassicPolling: async () => { calls.push("classic-stop"); },
    startBusLeaderPolling: async () => { calls.push("bus-start"); await hooks.startBus?.(); },
    stopBusLeaderPolling: async () => { calls.push("bus-stop"); },
    startLeaderHealth: () => { calls.push("health-start"); },
    stopLeaderHealth: () => { calls.push("health-stop"); },
    registerFollowerWithLeader: async () => false, stopFollowerRegistration: () => {},
    isTopicModeUnavailableError: () => true,
    updateStatus: () => { calls.push("status"); },
    recordEvent: () => { calls.push("event"); },
  });
  return { runtime, state, calls, getBotState: () => bot };
}

test("A fresh positive probe restores the bus after startup timeout with retained enabled mode", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  let probes = 0;
  const fixture = createCapabilityLifecycleFixture({
    initialBot: { threadMode: "enabled" },
    getMe: async () => {
      if (++probes === 1) throw new Error("connect ETIMEDOUT");
      return probes === 2 ? undefined : true;
    },
  });
  const { runtime, state, calls } = fixture;
  const tick = async () => { t.mock.timers.tick(2500); await new Promise<void>(resolve => setImmediate(resolve)); };
  try {
    await runtime.pollingPorts.startPolling("ctx");
    assert.equal(fixture.getBotState().threadMode, "enabled");
    assert.equal(state.isBusPollingStarted(), false);
    assert.equal(state.isTopicModeUnavailable(), true);
    assert.ok(calls.includes("classic-start"));
    runtime.monitor.start("ctx");
    await tick();
    assert.equal(state.isBusPollingStarted(), false, "An unknown response is not fresh capability proof");
    await tick();
    assert.equal(state.isBusPollingStarted(), true);
    assert.equal(state.isTopicModeUnavailable(), false);
    assert.equal(calls.filter(call => call === "bus-start").length, 1);
    assert.ok(calls.indexOf("classic-stop") < calls.indexOf("bus-start"));
    assert.equal(calls.filter(call => call === "health-start").length, 1);
    await tick();
    assert.equal(calls.filter(call => call === "bus-start").length, 1, "Healthy bus is not restarted");
  } finally {
    runtime.monitor.stop();
    await runtime.pollingPorts.stopPolling();
  }
});

test("An enabled-mode follower probe does not acquire or start a leader bus", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  let probes = 0;
  const { runtime, state, calls } = createCapabilityLifecycleFixture({
    initialBot: { threadMode: "enabled" }, ownsLock: () => false, isFollowerRegistered: () => true,
    getMe: async () => { probes++; return true; },
  });
  try {
    runtime.monitor.start("follower");
    t.mock.timers.tick(2500);
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(probes, 1);
    assert.equal(state.isBusPollingStarted(), false);
    assert.deepEqual(calls, []);
  } finally {
    runtime.monitor.stop();
  }
});

test("Obsolete startup probes cannot overwrite a replacement after query or persistence awaits", async () => {
  for (const boundary of ["query", "persist"] as const) {
    for (const oldMode of [false, true]) {
      let release!: () => void;
      let entered!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const waiting = new Promise<void>((resolve) => { entered = resolve; });
      const pause = async () => { entered(); await gate; };
      let queries = 0;
      let writes = 0;
      const fixture = createCapabilityLifecycleFixture({
        getMe: async () => {
          if (++queries !== 1) return !oldMode;
          if (boundary === "query") await pause();
          return oldMode;
        },
        persist: async () => { if (++writes === 1 && boundary === "persist") await pause(); },
      });
      const { runtime, state, calls } = fixture;
      try {
        const stale = runtime.pollingPorts.startPolling("old");
        await waiting;
        await runtime.pollingPorts.stopPolling();
        await runtime.pollingPorts.startPolling("replacement");
        const replacementCalls = [...calls];
        release();
        await stale;
        assert.deepEqual(calls, replacementCalls, `${boundary}/${oldMode}`);
        assert.equal(fixture.getBotState().threadMode, oldMode ? "disabled" : "enabled");
        assert.equal(state.isTopicModeUnavailable(), oldMode);
        assert.equal(state.isBusPollingStarted(), !oldMode);
      } finally {
        release();
        runtime.monitor.stop();
        await runtime.pollingPorts.stopPolling();
      }
    }
  }
});

test("Stopped capability transitions cannot restart health, fall back, or mutate a replacement", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  for (const source of ["monitor", "observation"] as const) {
    for (const outcome of ["resolve", "reject"] as const) {
      for (const replace of [false, true]) {
        let release!: () => void;
        let entered!: () => void;
        const gate = new Promise<void>((resolve) => { release = resolve; });
        const waiting = new Promise<void>((resolve) => { entered = resolve; });
        let queries = 0;
        let busStarts = 0;
        const fixture = createCapabilityLifecycleFixture({
          getMe: async () => ++queries > 1,
          startBus: async () => {
            if (++busStarts !== 1) return;
            entered();
            await gate;
            if (outcome === "reject") throw new Error("Old transition failed");
          },
        });
        const { runtime, state, calls } = fixture;
        try {
          await runtime.pollingPorts.startPolling("ctx");
          let observation: Promise<void> | undefined;
          if (source === "monitor") {
            runtime.monitor.start("ctx");
            t.mock.timers.tick(2500);
          } else {
            observation = runtime.observeTarget("ctx");
          }
          await waiting;
          runtime.monitor.stop();
          await runtime.pollingPorts.stopPolling();
          if (replace) await runtime.pollingPorts.startPolling("replacement");
          const retainedCalls = [...calls];
          const retainedBot = structuredClone(fixture.getBotState());
          release();
          await observation;
          await new Promise<void>((resolve) => setImmediate(resolve));
          assert.deepEqual(calls, retainedCalls, `${source}/${outcome}/${replace}`);
          assert.deepEqual(fixture.getBotState(), retainedBot);
          assert.equal(calls.filter((call) => call === "health-start").length, replace ? 1 : 0);
          assert.equal(state.isBusPollingStarted(), replace);
        } finally {
          release();
          runtime.monitor.stop();
          await runtime.pollingPorts.stopPolling();
        }
      }
    }
  }
});

test("Thread-aware polling returns disabled mode to classic takeover despite retained thread history", async () => {
  const callApi = async <TResponse,>(): Promise<TResponse> => ({}) as TResponse;
  const store = {
    async load() {},
    async persist() {},
    getBotState() {
      return { threadMode: "disabled" as const };
    },
    setBotState() {},
    list() {
      return [
        {
          status: "active",
          target: { chatId: 42, threadId: 7 },
        },
      ];
    },
  };
  const ports = createBaleThreadAwarePollingPorts({
    getAllowedUserId: () => 42,
    callApi,
    topicTargetStore: store,
    isBusRuntimeEnabled: () => false,
    isTopicModeUnavailableError: () => false,
    getPollingStartedWithBaleBus: () => false,
    setPollingStartedWithBaleBus() {},
    setForceFreshLeaderThreadOnNextStart() {},
    setTopicModeUnavailable() {},
    startClassicPolling() {},
    async stopClassicPolling() {},
    async startBusLeaderPolling() {},
    async stopBusLeaderPolling() {},
    startLeaderHealth() {},
    stopLeaderHealth() {},
    registerFollowerWithLeader: async () => true,
    stopFollowerRegistration() {},
    recordEvent() {},
  });

  assert.equal(
    await ports.registerFollowerWithOwner?.(TEST_CONTEXT, { pid: 1 }),
    undefined,
  );
});

test("Thread-aware polling refreshes owner-published enabled mode over stale local classic state", async () => {
  let followerRegistrations = 0;
  let threadMode: "disabled" | "enabled" = "disabled";
  const store = {
    async load() {},
    async refresh() {
      threadMode = "enabled";
    },
    async persist() {},
    getBotState() {
      return { threadMode };
    },
    setBotState() {},
    list() {
      return [];
    },
  };
  const ports = createBaleThreadAwarePollingPorts({
    getAllowedUserId: () => 42,
    callApi: async <TResponse,>(): Promise<TResponse> => ({}) as TResponse,
    topicTargetStore: store,
    isBusRuntimeEnabled: () => false,
    isTopicModeUnavailableError: () => false,
    getPollingStartedWithBaleBus: () => false,
    setPollingStartedWithBaleBus() {},
    setForceFreshLeaderThreadOnNextStart() {},
    setTopicModeUnavailable() {},
    startClassicPolling() {},
    async stopClassicPolling() {},
    async startBusLeaderPolling() {},
    async stopBusLeaderPolling() {},
    startLeaderHealth() {},
    stopLeaderHealth() {},
    async registerFollowerWithLeader() {
      followerRegistrations += 1;
      return true;
    },
    stopFollowerRegistration() {},
    recordEvent() {},
  });

  assert.equal(
    await ports.registerFollowerWithOwner?.(TEST_CONTEXT, { pid: 1 }),
    true,
  );
  assert.equal(followerRegistrations, 1);
});

test("Thread-aware polling auto-restores followers only for remembered Workspaces", async () => {
  let remembered = false;
  let restores = 0;
  let threadMode: "enabled" | "disabled" = "enabled";
  const reasons: string[] = [];
  const store = {
    async load() {},
    async refresh() {},
    async persist() {},
    getBotState() {
      return { threadMode };
    },
    setBotState() {},
    list() {
      return [];
    },
  };
  const ports = createBaleThreadAwarePollingPorts({
    getAllowedUserId: () => 42,
    callApi: async <TResponse,>(): Promise<TResponse> => ({}) as TResponse,
    topicTargetStore: store,
    isBusRuntimeEnabled: () => false,
    isTopicModeUnavailableError: () => false,
    getPollingStartedWithBaleBus: () => false,
    setPollingStartedWithBaleBus() {},
    setForceFreshLeaderThreadOnNextStart() {},
    setTopicModeUnavailable() {},
    startClassicPolling() {},
    async stopClassicPolling() {},
    async startBusLeaderPolling() {},
    async stopBusLeaderPolling() {},
    startLeaderHealth() {},
    stopLeaderHealth() {},
    registerFollowerWithLeader: async () => true,
    hasRememberedWorkspaceBinding: () => remembered,
    restoreFollowerWithLeader: async () => {
      restores += 1;
      return true;
    },
    stopFollowerRegistration() {},
    recordEvent(_category, _message, details) {
      if (typeof details?.reason === "string") reasons.push(details.reason);
    },
  });

  assert.equal(
    await ports.restoreFollowerWithOwner(TEST_CONTEXT, { pid: 1 }),
    undefined,
  );
  threadMode = "disabled";
  assert.equal(await ports.restoreFollowerWithOwner(TEST_CONTEXT, { pid: 1 }), undefined);
  threadMode = "enabled";
  remembered = true;
  assert.equal(
    await ports.restoreFollowerWithOwner(TEST_CONTEXT, { pid: 1 }),
    true,
  );
  assert.equal(restores, 1);
  assert.deepEqual(reasons, ["session-binding-unavailable", "thread-mode-unavailable"]);
});

test("Thread capability downgrade retries classic restore after failure", async () => {
  let state: {
    threadMode?: "enabled" | "disabled" | "unknown";
    updatedAtMs?: number;
    lastReconcileAction?: string;
  } = {
    threadMode: "enabled",
    lastReconcileAction: "capability-monitor-enabled",
  };
  let pollingStartedWithBus = true;
  let classicStarts = 0;
  let suspendedTargets = 0;
  let persisted = 0;
  const events: Array<{ category: string; details?: Record<string, unknown> }> = [];
  const store = {
    async load() {},
    async persist() {
      persisted += 1;
    },
    getBotState() {
      return state;
    },
    setBotState(next: typeof state) {
      state = { ...state, ...next };
    },
    list() {
      return [
        {
          status: "active",
          target: { chatId: 42, threadId: 7 },
        },
      ];
    },
  };
  const deps = {
    failureLog: createPassthroughFailureLog(),
    getAllowedUserId: () => 42,
    callApi: async <TResponse,>(): Promise<TResponse> => ({}) as TResponse,
    topicTargetStore: store,
    ownsLock: () => true,
    getPollingStartedWithBaleBus: () => pollingStartedWithBus,
    setPollingStartedWithBaleBus(started: boolean) {
      pollingStartedWithBus = started;
    },
    setTopicModeUnavailable() {},
    suspendLiveThreadTarget() {
      suspendedTargets += 1;
    },
    stopFollowerRegistration() {},
    startClassicPolling() {
      assert.equal(suspendedTargets, 1);
      classicStarts += 1;
      if (classicStarts === 1) throw new Error("classic unavailable");
    },
    async stopClassicPolling() {},
    async startBusPolling() {},
    async stopBusPolling() {},
    startLeaderHealth() {},
    stopLeaderHealth() {},
    isTopicModeUnavailableError: () => false,
    updateStatus() {},
    recordEvent(category: string, _error: unknown, details?: Record<string, unknown>) {
      events.push({ category, details });
    },
  };

  await applyBaleThreadCapability(
    TEST_CONTEXT,
    false,
    "capability-monitor-disabled-confirmed",
    deps,
  );
  assert.equal(classicStarts, 1);
  assert.equal(
    state.lastReconcileAction,
    "capability-monitor-disabled-confirmed-classic-restore-failed",
  );
  assert.equal(pollingStartedWithBus, false);
  assert.equal(suspendedTargets, 1);

  await applyBaleThreadCapability(
    TEST_CONTEXT,
    false,
    "capability-monitor-disabled-confirmed",
    deps,
  );
  assert.equal(classicStarts, 2);
  assert.equal(suspendedTargets, 1);
  assert.equal(state.lastReconcileAction, "capability-monitor-disabled-confirmed");
  assert.equal(persisted >= 3, true);
  assert.equal(events[0].details?.phase, "capability-monitor-disabled-confirmed-classic-restore");
});

test("Thread-aware polling still allows classic takeover path without thread bindings", async () => {
  const callApi = async <TResponse,>(): Promise<TResponse> => ({}) as TResponse;
  const store = {
    async load() {},
    async persist() {},
    getBotState() {
      return { threadMode: "disabled" as const };
    },
    setBotState() {},
    list() {
      return [];
    },
  };
  const ports = createBaleThreadAwarePollingPorts({
    getAllowedUserId: () => 42,
    callApi,
    topicTargetStore: store,
    isBusRuntimeEnabled: () => false,
    isTopicModeUnavailableError: () => false,
    getPollingStartedWithBaleBus: () => false,
    setPollingStartedWithBaleBus() {},
    setForceFreshLeaderThreadOnNextStart() {},
    setTopicModeUnavailable() {},
    startClassicPolling() {},
    async stopClassicPolling() {},
    async startBusLeaderPolling() {},
    async stopBusLeaderPolling() {},
    startLeaderHealth() {},
    stopLeaderHealth() {},
    registerFollowerWithLeader: async () => true,
    stopFollowerRegistration() {},
    recordEvent() {},
  });

  assert.equal(
    await ports.registerFollowerWithOwner?.(TEST_CONTEXT, { pid: 1 }),
    undefined,
  );
});

test("Polling helpers start only when a bot token exists and polling is idle", () => {
  assert.equal(
    shouldStartBalePolling({
      hasBotToken: true,
      hasPollingPromise: false,
    }),
    true,
  );
  assert.equal(
    shouldStartBalePolling({
      hasBotToken: false,
      hasPollingPromise: false,
    }),
    false,
  );
  assert.equal(
    shouldStartBalePolling({
      hasBotToken: true,
      hasPollingPromise: true,
    }),
    false,
  );
});

test("Polling runtime starts and stops polling through state ports", async () => {
  const events: string[] = [];
  let pollingPromise: Promise<void> | undefined;
  let pollingController: AbortController | undefined;
  let finishPollLoop: (() => void) | undefined;
  const deps = {
    hasBotToken: () => true,
    getPollingPromise: () => pollingPromise,
    setPollingPromise: (promise: Promise<void> | undefined) => {
      pollingPromise = promise;
      events.push(`promise:${promise ? "set" : "clear"}`);
    },
    getPollingController: () => pollingController,
    setPollingController: (controller: AbortController | undefined) => {
      pollingController = controller;
      events.push(`controller:${controller ? "set" : "clear"}`);
    },
    stopTypingLoop: () => {
      events.push("typing:stop");
    },
    runPollLoop: async (_ctx: string, signal: AbortSignal) => {
      events.push(`run:${signal.aborted}`);
      await new Promise<void>((resolve) => {
        finishPollLoop = resolve;
      });
    },
    updateStatus: (ctx: string) => {
      events.push(`status:${ctx}`);
    },
    onPollingStarted: () => {
      events.push("polling:started");
    },
    onPollingStopped: () => {
      events.push("polling:stopped");
    },
  };
  startBalePollingRuntime("ctx", deps);
  assert.equal(!!pollingPromise, true);
  assert.equal(!!pollingController, true);
  const stopPromise = stopBalePollingRuntime(deps);
  assert.equal(pollingController?.signal.aborted, true);
  assert.equal(!!pollingController, true);
  finishPollLoop?.();
  await stopPromise;
  assert.deepEqual(events, [
    "controller:set",
    "polling:started",
    "run:false",
    "promise:set",
    "status:ctx",
    "typing:stop",
    "promise:clear",
    "controller:clear",
    "polling:stopped",
    "status:ctx",
  ]);
});

test("Polling runtime still aborts and settles when typing cleanup fails", async () => {
  const events: string[] = [];
  let pollingPromise: Promise<void> | undefined;
  let pollingController: AbortController | undefined;
  let finishPollLoop: (() => void) | undefined;
  const deps = {
    hasBotToken: () => true,
    getPollingPromise: () => pollingPromise,
    setPollingPromise: (promise: Promise<void> | undefined) => {
      pollingPromise = promise;
      events.push(`promise:${promise ? "set" : "clear"}`);
    },
    getPollingController: () => pollingController,
    setPollingController: (controller: AbortController | undefined) => {
      pollingController = controller;
      events.push(`controller:${controller ? "set" : "clear"}`);
    },
    stopTypingLoop: () => {
      events.push("typing:throw");
      throw new Error("typing cleanup failed");
    },
    runPollLoop: async (_ctx: string, signal: AbortSignal) => {
      await new Promise<void>((resolve) => {
        finishPollLoop = () => {
          events.push(`run-finish:${signal.aborted}`);
          resolve();
        };
      });
    },
    updateStatus: () => {},
    recordRuntimeEvent: (
      category: string,
      error: unknown,
      details?: Record<string, unknown>,
    ) => {
      events.push(
        `${category}:${error instanceof Error ? error.message : String(error)}:${details?.phase}`,
      );
    },
  };
  startBalePollingRuntime("ctx", deps);
  const stopPromise = stopBalePollingRuntime(deps);
  assert.equal(pollingController?.signal.aborted, true);
  finishPollLoop?.();
  await stopPromise;
  assert.deepEqual(events, [
    "controller:set",
    "promise:set",
    "typing:throw",
    "polling:typing cleanup failed:typing-stop",
    "run-finish:true",
    "promise:clear",
    "controller:clear",
  ]);
});

test("Polling runtime ignores stale-context status failures during cleanup", async () => {
  let pollingPromise: Promise<void> | undefined;
  let pollingController: AbortController | undefined;
  let statusCalls = 0;
  const runtimeEvents: string[] = [];
  const deps = {
    hasBotToken: () => true,
    getPollingPromise: () => pollingPromise,
    setPollingPromise: (promise: Promise<void> | undefined) => {
      pollingPromise = promise;
    },
    getPollingController: () => pollingController,
    setPollingController: (controller: AbortController | undefined) => {
      pollingController = controller;
    },
    stopTypingLoop: () => {},
    runPollLoop: async () => {},
    updateStatus: () => {
      statusCalls += 1;
      if (statusCalls > 1) throw new Error("stale ctx");
    },
    recordRuntimeEvent: (
      category: string,
      error: unknown,
      details?: Record<string, unknown>,
    ) => {
      const message = error instanceof Error ? error.message : String(error);
      runtimeEvents.push(`${category}:${message}:${details?.phase}`);
    },
  };
  startBalePollingRuntime("ctx", deps);
  await pollingPromise;
  assert.equal(statusCalls, 2);
  assert.equal(pollingPromise, undefined);
  assert.equal(pollingController, undefined);
  assert.deepEqual(runtimeEvents, ["polling:stale ctx:status-update"]);
});

test("Polling runtime ignores stale-context status failures during start", () => {
  let pollingPromise: Promise<void> | undefined;
  let pollingController: AbortController | undefined;
  const runtimeEvents: string[] = [];
  const deps = {
    hasBotToken: () => true,
    getPollingPromise: () => pollingPromise,
    setPollingPromise: (promise: Promise<void> | undefined) => {
      pollingPromise = promise;
    },
    getPollingController: () => pollingController,
    setPollingController: (controller: AbortController | undefined) => {
      pollingController = controller;
    },
    stopTypingLoop: () => {},
    runPollLoop: async () => {},
    updateStatus: () => {
      throw new Error("stale ctx");
    },
    recordRuntimeEvent: (
      category: string,
      error: unknown,
      details?: Record<string, unknown>,
    ) => {
      const message = error instanceof Error ? error.message : String(error);
      runtimeEvents.push(`${category}:${message}:${details?.phase}`);
    },
  };

  assert.doesNotThrow(() => startBalePollingRuntime("ctx", deps));
  assert.equal(!!pollingPromise, true);
  assert.equal(!!pollingController, true);
  assert.deepEqual(runtimeEvents, ["polling:stale ctx:status-update"]);
});

test("Polling admission starts the session-owned worker before transport polling", async () => {
  const events: string[] = [];
  let failPollingStart = false;
  let failValidation = false;
  let failPreparation = false;
  const runtime = createBalePollingAdmissionRuntime<string>({
    prepareStart: () => {
      events.push("prepare");
      if (failPreparation) throw new Error("cutover failed");
    },
    validateStart: () => {
      events.push("validate");
      if (failValidation) throw new Error("cursor conflict");
    },
    polling: {
      isActive: () => false,
      start: () => {
        events.push("polling:start");
        if (failPollingStart) throw new Error("polling failed");
      },
      stop: async () => {
        events.push("polling:stop");
      },
    },
    worker: {
      onSessionStart: async (ctx) => {
        events.push(`worker:start:${ctx}`);
      },
    },
  });

  await runtime.start("ctx");
  await runtime.stop();
  assert.deepEqual(events, [
    "prepare",
    "validate",
    "worker:start:ctx",
    "polling:start",
    "polling:stop",
  ]);

  events.length = 0;
  failPollingStart = true;
  await assert.rejects(runtime.start("ctx-2"), /polling failed/u);
  assert.deepEqual(events, [
    "prepare",
    "validate",
    "worker:start:ctx-2",
    "polling:start",
  ]);

  events.length = 0;
  failValidation = true;
  await assert.rejects(runtime.start("ctx-3"), /cursor conflict/u);
  assert.deepEqual(events, ["prepare", "validate"]);

  events.length = 0;
  failValidation = false;
  failPreparation = true;
  await assert.rejects(runtime.start("ctx-4"), /cutover failed/u);
  assert.deepEqual(events, ["prepare"]);
});

test("Polling controller owns polling promise and abort-controller state", async () => {
  const events: string[] = [];
  let finishPollLoop: (() => void) | undefined;
  const state = createBalePollingControllerState();
  const isPollingActive = createBalePollingActivityReader(state);
  const controller = createBalePollingController({
    state,
    hasBotToken: () => true,
    stopTypingLoop: () => {
      events.push("typing:stop");
    },
    runPollLoop: async (_ctx: string, signal: AbortSignal) => {
      events.push(`run:${signal.aborted}`);
      await new Promise<void>((resolve) => {
        finishPollLoop = resolve;
      });
    },
    updateStatus: (ctx: string) => {
      events.push(`status:${ctx}`);
    },
  });
  controller.start("ctx");
  assert.equal(controller.isActive(), true);
  assert.equal(isBalePollingControllerActive(state), true);
  assert.equal(isPollingActive(), true);
  controller.start("ctx");
  const stopPromise = controller.stop();
  finishPollLoop?.();
  await stopPromise;
  assert.equal(controller.isActive(), false);
  assert.equal(isBalePollingControllerActive(state), false);
  assert.equal(isPollingActive(), false);
  assert.deepEqual(events, [
    "run:false",
    "status:ctx",
    "typing:stop",
    "status:ctx",
  ]);
});

test("Polling controller settles unexpected runner failures into diagnostics", async () => {
  const state = createBalePollingControllerState();
  const runtimeEvents: string[] = [];
  const controller = createBalePollingController({
    state,
    getNowMs: () => 2_000,
    hasBotToken: () => true,
    stopTypingLoop: () => {},
    runPollLoop: async () => {
      throw new Error("unexpected poll failure");
    },
    updateStatus: () => {},
    recordRuntimeEvent: (category, error, details) => {
      runtimeEvents.push(
        `${category}:${error instanceof Error ? error.message : String(error)}:${details?.phase}`,
      );
    },
  });

  controller.start(TEST_CONTEXT);
  await waitForPollingCondition(
    () => state.phase === "stopped",
    "failed polling controller did not settle",
  );

  assert.equal(controller.isActive(), false);
  assert.equal(state.stopReason, "failed");
  assert.equal(state.stoppedAtMs, 2_000);
  assert.deepEqual(runtimeEvents, [
    "polling:unexpected poll failure:controller",
  ]);
});

test("Durable polling assembly owns journal ports and cursor bootstrap validation", async () => {
  let bootstrapEntryCount = 1;
  let workerStarts = 0;
  const events: string[] = [];
  const assembly = createBaleDurablePollingRuntimeAssembly<
    { update_id: number },
    string
  >({
    getConfig: () => ({ botToken: "123:abc" }),
    hasBotToken: () => true,
    deleteWebhook: async () => {
      events.push("deleteWebhook");
    },
    getUpdates: async () => {
      throw new DOMException("stop", "AbortError");
    },
    persistConfig: async () => undefined,
    journal: {
      appendBatch: () => ({ nonExcludedUpdateIds: [] }),
      getAcceptedThroughUpdateId: () => undefined,
      getEntryCount: () => 0,
      signalWorker: () => undefined,
      getBootstrapEntryCount: () => bootstrapEntryCount,
      onSessionStart: async () => {
        workerStarts += 1;
      },
    },
    stopTypingLoop: () => undefined,
    updateStatus: () => undefined,
  });

  await assert.rejects(
    () => assembly.admission.start("blocked"),
    BalePollingCursorBootstrapError,
  );
  assert.equal(workerStarts, 0);
  bootstrapEntryCount = 0;
  await assembly.admission.start("ctx");
  assert.equal(workerStarts, 1);
  assert.equal(assembly.controller.isActive(), true);
  await assembly.admission.stop();
  assert.equal(assembly.controller.isActive(), false);
  assert.deepEqual(events, ["deleteWebhook"]);
});

test("Durable polling prepares only admitted non-excluded runs before any microtask consumer", async () => {
  for (const scenario of ["included", "excluded", "barrier", "publication-failure", "preparation-failure", "diagnostic-failure"] as const) {
    const events: string[] = [];
    const prepared: number[][] = [];
    const diagnostics: unknown[] = [];
    let observed: number[][] | undefined;
    let calls = 0;
    let cursor = 0;
    let finished!: () => void;
    const received = new Promise<void>((resolve) => { finished = resolve; });
    const included = scenario === "excluded" ? [] : scenario === "barrier" ? [1, 3] : [1, 2, 3];
    const assembly = createBaleDurablePollingRuntimeAssembly<{ update_id: number }, string>({
      getConfig: () => ({ botToken: "fixture" }), hasBotToken: () => true,
      deleteWebhook: async () => {}, persistConfig: async () => {},
      getUpdates: async () => {
        if (calls++ === 0) return [{ update_id: 1 }, { update_id: 2 }, { update_id: 3 }];
        finished();
        throw new DOMException("stop", "AbortError");
      },
      journal: {
        appendBatch(_updates, admittedCursor) {
          events.push("append");
          if (scenario === "publication-failure") throw new Error("fixture publication failed");
          cursor = admittedCursor!;
          // Models an already-draining consumer, not one started by signalWorker.
          queueMicrotask(() => { observed = prepared.map((batch) => [...batch]); events.push("reader"); });
          return { nonExcludedUpdateIds: included };
        },
        getAcceptedThroughUpdateId: () => cursor,
        getEntryCount: () => 0, getBootstrapEntryCount: () => 0,
        signalWorker: () => { events.push("signal"); }, onSessionStart: async () => {},
      },
      prepareUpdateBatch: (updates) => {
        if (scenario === "preparation-failure" || scenario === "diagnostic-failure") throw new Error("fixture preparation failed");
        const ids = updates.map((update) => update.update_id);
        prepared.push(ids);
        events.push(`prepare:${ids.join(",")}`);
      },
      recordRuntimeEvent: (_category, _error, details) => {
        if (details?.phase !== "batch-preparation") return;
        diagnostics.push(details.phase);
        if (scenario === "diagnostic-failure") throw new Error("fixture diagnostics failed");
      },
      sleep: async () => {}, stopTypingLoop: () => {}, updateStatus: () => {},
    });
    try {
      await assembly.admission.start(TEST_CONTEXT);
      await received;
      const expected = scenario === "included" ? [[1, 2, 3]] : scenario === "barrier" ? [[1], [3]] : [];
      assert.deepEqual(prepared, expected, scenario);
      assert.deepEqual(diagnostics, scenario === "preparation-failure" || scenario === "diagnostic-failure" ? ["batch-preparation"] : [], scenario);
      assert.deepEqual(observed, scenario === "publication-failure" ? undefined : expected, scenario);
      assert.deepEqual(events, ["append", ...expected.map((ids) => `prepare:${ids.join(",")}`),
        ...(scenario === "publication-failure" ? [] : ["reader", "signal"])], scenario);
    } finally {
      await assembly.admission.stop();
    }
  }
});

test("Polling controller runtime binds loop runner and controller state", async () => {
  const events: string[] = [];
  const state = createBalePollingControllerState();
  const controller = createBalePollingControllerRuntime({
    state,
    getConfig: () => ({ botToken: "123:abc" }),
    hasBotToken: () => true,
    deleteWebhook: async () => {
      events.push("deleteWebhook");
    },
    getUpdates: async () => {
      throw new DOMException("stop", "AbortError");
    },
    persistConfig: async () => {
      events.push("persist");
    },
    ...NOOP_JOURNAL_ADMISSION,
    stopTypingLoop: () => {
      events.push("typing:stop");
    },
    updateStatus: (_ctx: string, message?: string) => {
      events.push(`status:${message ?? "ok"}`);
    },
  });
  controller.start("ctx");
  assert.equal(controller.isActive(), true);
  await controller.stop();
  assert.equal(controller.isActive(), false);
  assert.deepEqual(events, [
    "deleteWebhook",
    "status:ok",
    "typing:stop",
    "status:ok",
  ]);
});

test("Polling controller exposes exact phases and retained response evidence", async () => {
  let nowMs = 1_000;
  let getUpdatesCalls = 0;
  let acceptedThroughUpdateId = 5;
  let releaseAppend: (() => void) | undefined;
  let secondPollSignal: AbortSignal | undefined;
  const state = createBalePollingControllerState();
  const controller = createBalePollingControllerRuntime({
    state,
    getNowMs: () => nowMs,
    getConfig: () => ({ botToken: "123:abc", lastUpdateId: 5 }),
    hasBotToken: () => true,
    deleteWebhook: async () => {},
    getUpdates: async (_body, signal) => {
      getUpdatesCalls += 1;
      if (getUpdatesCalls === 1) return [{ update_id: 6 }];
      secondPollSignal = signal;
      return await new Promise<never>(() => {});
    },
    appendUpdateBatch: async (_updates, cursor) => {
      await new Promise<void>((resolve) => {
        releaseAppend = resolve;
      });
      acceptedThroughUpdateId = cursor!;
    },
    getAcceptedThroughUpdateId: () => acceptedThroughUpdateId,
    getJournalEntryCount: () => 0,
    signalUpdateWorker: () => {},
    persistConfig: async () => {
      assert.fail("config persistence must not own the polling cursor");
    },
    stopTypingLoop: () => {},
    updateStatus: () => {},
  });

  controller.start(TEST_CONTEXT);
  await waitForPollingCondition(
    () => state.phase === "persisting-journal" && !!releaseAppend,
    "polling did not enter persisting-journal",
  );
  assert.equal(state.currentUpdateId, 6);
  assert.equal(state.phaseStartedAtMs, 1_000);
  assert.equal(state.lastSuccessfulResponseAtMs, 1_000);
  assert.equal(state.lastSuccessfulResponseUpdateCount, 1);

  nowMs = 1_100;
  releaseAppend?.();
  await waitForPollingCondition(
    () => state.phase === "long-poll" && !!secondPollSignal,
    "polling did not resume long-polling",
  );
  assert.equal(acceptedThroughUpdateId, 6);
  assert.equal(state.currentUpdateId, undefined);
  assert.equal(state.phaseStartedAtMs, 1_100);

  nowMs = 1_300;
  await controller.stop();
  assert.equal(secondPollSignal?.aborted, true);
  assert.equal(state.phase, "stopped");
  assert.equal(state.phaseStartedAtMs, 1_300);
  assert.equal(state.stoppedAtMs, 1_300);
  assert.equal(state.stopReason, "requested");
  assert.equal(state.lastSuccessfulResponseAtMs, 1_000);
});

test("Polling helpers stop only for abort conditions", () => {
  assert.equal(shouldStopBalePolling(true, new Error("ignored")), true);
  assert.equal(
    shouldStopBalePolling(false, new DOMException("aborted", "AbortError")),
    true,
  );
  assert.equal(shouldStopBalePolling(false, new Error("network")), false);
});

test("Poll loop cancels stalled getUpdates at its owner-derived budget", async () => {
  const controller = new AbortController();
  const phases: string[] = [];
  const statusMessages: string[] = [];
  const runtimeEvents: Array<{
    error: unknown;
    details?: Record<string, unknown>;
  }> = [];
  let requestSignal: AbortSignal | undefined;

  await runBalePollLoop({
    ctx: TEST_CONTEXT,
    signal: controller.signal,
    config: { botToken: "123:abc" },
    deleteWebhook: async () => {},
    getUpdatesRequestBudgetMs: (body) => {
      assert.equal(body.timeout, 30);
      return 5;
    },
    getUpdates: async (_body, signal) => {
      requestSignal = signal;
      return await new Promise<never>(() => {});
    },
    persistConfig: async () => {},
    ...NOOP_JOURNAL_ADMISSION,
    onErrorStatus: (message) => {
      statusMessages.push(message);
    },
    onStatusReset: () => {
      statusMessages.push("unexpected reset");
    },
    sleep: async (ms, signal) => {
      assert.equal(ms, 1_000);
      assert.equal(signal, controller.signal);
      controller.abort();
    },
    onPhaseChange: (phase, updateId) => {
      phases.push(`${phase}:${updateId ?? "none"}`);
    },
    recordRuntimeEvent: (_category, error, details) => {
      runtimeEvents.push({ error, details });
    },
  });

  assert.equal(requestSignal?.aborted, true);
  assert.ok(requestSignal?.reason instanceof BaleGetUpdatesTimeoutError);
  assert.deepEqual(phases, ["long-poll:none", "retrying:none"]);
  assert.deepEqual(statusMessages, [
    "Bale getUpdates timed out after 5 ms.",
  ]);
  assert.equal(runtimeEvents.length, 1);
  assert.ok(runtimeEvents[0]?.error instanceof BaleGetUpdatesTimeoutError);
  assert.deepEqual(runtimeEvents[0]?.details, {
    phase: "long-poll",
    timeoutMs: 5,
  });
});

test("Poll loop runner binds config, status, and transport ports", async () => {
  const config: { botToken: string; lastUpdateId?: number } = {
    botToken: "123:abc",
    lastUpdateId: 5,
  };
  const events: string[] = [];
  let acceptedThroughUpdateId = 5;
  let calls = 0;
  const runPollLoop = createBalePollLoopRunner({
    getConfig: () => config,
    deleteWebhook: async () => {
      events.push("deleteWebhook");
    },
    getUpdates: async () => {
      calls += 1;
      if (calls === 1) return [{ update_id: 6 }];
      throw new DOMException("stop", "AbortError");
    },
    persistConfig: async () => {
      assert.fail("config persistence must not own the polling cursor");
    },
    appendUpdateBatch: (updates, cursor) => {
      events.push(
        `append:${updates.map((update) => update.update_id).join(",")}:${cursor}`,
      );
      acceptedThroughUpdateId = cursor!;
    },
    getAcceptedThroughUpdateId: () => acceptedThroughUpdateId,
    getJournalEntryCount: () => 0,
    signalUpdateWorker: () => {
      events.push("signal");
    },
    updateStatus: (ctx, message) => {
      events.push(`status:${ctx}:${message ?? "ok"}`);
    },
    sleep: async () => {
      events.push("sleep");
    },
    onPhaseChange: (phase, updateId) => {
      events.push(`phase:${phase}:${updateId ?? "none"}`);
    },
    onSuccessfulResponse: (updateCount) => {
      events.push(`response:${updateCount}`);
    },
  });
  await runPollLoop("ctx", new AbortController().signal);
  assert.deepEqual(events, [
    "deleteWebhook",
    "phase:long-poll:none",
    "response:1",
    "phase:persisting-journal:6",
    "append:6:6",
    "signal",
    "phase:long-poll:none",
  ]);
});

test("Poll loop runner ignores stale-context status failures while retrying", async () => {
  const config = { botToken: "123:abc", lastUpdateId: 1 };
  const events: string[] = [];
  const runtimeEvents: string[] = [];
  let calls = 0;
  const runPollLoop = createBalePollLoopRunner({
    getConfig: () => config,
    deleteWebhook: async () => {},
    getUpdates: async () => {
      calls += 1;
      if (calls === 1) throw new Error("network down");
      throw new DOMException("stop", "AbortError");
    },
    persistConfig: async () => {},
    ...NOOP_JOURNAL_ADMISSION,
    updateStatus: (_ctx: string, message?: string) => {
      events.push(`status:${message ?? "ok"}`);
      throw new Error("stale ctx");
    },
    sleep: async (ms) => {
      events.push(`sleep:${ms}`);
    },
    recordRuntimeEvent: (category, error, details) => {
      const message = error instanceof Error ? error.message : String(error);
      runtimeEvents.push(`${category}:${message}:${details?.phase}`);
    },
  });
  await runPollLoop("ctx", new AbortController().signal);
  assert.deepEqual(events, ["status:network down", "sleep:1000", "status:ok"]);
  assert.deepEqual(runtimeEvents, [
    "polling:network down:loop",
    "polling:stale ctx:status-update",
    "polling:stale ctx:status-update",
  ]);
});

test("Journal-first poll loop advances before unresolved worker execution", async () => {
  const controller = new AbortController();
  const config = { botToken: "123:abc", lastUpdateId: 999 };
  let acceptedThroughUpdateId = 0;
  const events: string[] = [];
  let getUpdatesCalls = 0;
  let unresolvedWorker: Promise<void> | undefined;

  await runBalePollLoop({
    ctx: TEST_CONTEXT,
    signal: controller.signal,
    config,
    deleteWebhook: async () => undefined,
    getUpdates: async () => {
      getUpdatesCalls += 1;
      if (getUpdatesCalls === 1) return [{ update_id: 1 }];
      assert.equal(acceptedThroughUpdateId, 1);
      assert.ok(unresolvedWorker);
      controller.abort();
      throw new DOMException("stop", "AbortError");
    },
    appendUpdateBatch: (updates, cursor) => {
      events.push(
        `append:${updates.map((update) => update.update_id).join(",")}:${cursor}`,
      );
      acceptedThroughUpdateId = cursor!;
    },
    getAcceptedThroughUpdateId: () => acceptedThroughUpdateId,
    getJournalEntryCount: () => 0,
    signalUpdateWorker: () => {
      events.push("signal");
      unresolvedWorker = new Promise<void>(() => {});
    },
    persistConfig: async () => {
      assert.fail("config persistence must not own the polling cursor");
    },

    onErrorStatus: () => {},
    onStatusReset: () => {},
    sleep: async () => {},
    onPhaseChange: (phase) => events.push(`phase:${phase}`),
  });

  assert.equal(getUpdatesCalls, 2);
  assert.deepEqual(events, [
    "phase:long-poll",
    "phase:persisting-journal",
    "append:1:1",
    "signal",
    "phase:long-poll",
  ]);
});

test("Journal-first poll loop rejects a missing cursor with retained authority", async () => {
  let getUpdatesCalls = 0;
  await assert.rejects(
    runBalePollLoop({
      ctx: TEST_CONTEXT,
      signal: new AbortController().signal,
      config: { botToken: "123:abc" },
      deleteWebhook: async () => undefined,
      getUpdates: async () => {
        getUpdatesCalls += 1;
        return [];
      },
      appendUpdateBatch: () => undefined,
      getJournalEntryCount: () => 1,
      signalUpdateWorker: () => {},
      persistConfig: async () => {},
      onErrorStatus: () => {},
      onStatusReset: () => {},
      sleep: async () => {},
    }),
    BalePollingCursorBootstrapError,
  );
  assert.equal(getUpdatesCalls, 0);
});

test("Poll loop bootstraps once and journals each response batch", async () => {
  const lifecycle: string[] = [];
  const config: { botToken: string; lastUpdateId?: number } = {
    botToken: "123:abc",
  };
  let getUpdatesCalls = 0;
  let acceptedThroughUpdateId: number | undefined;
  await runBalePollLoop({
    ctx: TEST_CONTEXT,
    signal: new AbortController().signal,
    config,
    deleteWebhook: async () => {},
    getUpdates: async () => {
      getUpdatesCalls += 1;
      if (getUpdatesCalls === 1) return [{ update_id: 5 }];
      if (getUpdatesCalls === 2) return [{ update_id: 6 }, { update_id: 7 }];
      throw new DOMException("stop", "AbortError");
    },
    persistConfig: async () => {
      assert.fail("config persistence must not own the polling cursor");
    },
    appendUpdateBatch: (updates, cursor) => {
      lifecycle.push(
        `append:${updates.map((update) => update.update_id).join(",")}:${cursor}`,
      );
      acceptedThroughUpdateId = cursor;
    },
    getAcceptedThroughUpdateId: () => acceptedThroughUpdateId,
    getJournalEntryCount: () => 0,
    signalUpdateWorker: () => lifecycle.push("signal"),

    onErrorStatus: () => {},
    onStatusReset: () => {},
    sleep: async () => {},
  });
  assert.equal(config.lastUpdateId, undefined);
  assert.equal(acceptedThroughUpdateId, 7);
  assert.deepEqual(lifecycle, [
    "append::5",
    "append:6,7:7",
    "signal",
  ]);
});

test("Polling retry sleep resolves immediately when aborted", async () => {
  const controller = new AbortController();
  controller.abort();
  await sleepBalePollingRetry(3000, controller.signal);
});

test("Poll loop stops without status reset when aborted during retry sleep", async () => {
  const config = { botToken: "123:abc", lastUpdateId: 1 };
  const controller = new AbortController();
  const statusMessages: string[] = [];
  let calls = 0;
  await runBalePollLoop({
    ctx: TEST_CONTEXT,
    signal: controller.signal,
    config,
    deleteWebhook: async () => {},
    getUpdates: async () => {
      calls += 1;
      throw new Error("network down");
    },
    persistConfig: async () => {},
    ...NOOP_JOURNAL_ADMISSION,
    onErrorStatus: (message) => {
      statusMessages.push(`error:${message}`);
    },
    onStatusReset: () => {
      statusMessages.push("unexpected:reset");
    },
    sleep: async (_ms, signal) => {
      assert.equal(signal, controller.signal);
      controller.abort();
    },
  });
  assert.equal(calls, 1);
  assert.deepEqual(statusMessages, ["error:network down"]);
});

test("Poll loop suppresses getUpdates conflicts while another long poll drains", async () => {
  const config = { botToken: "123:abc", lastUpdateId: 1 };
  const statusMessages: string[] = [];
  const runtimeEvents: string[] = [];
  let calls = 0;
  await runBalePollLoop({
    ctx: TEST_CONTEXT,
    signal: new AbortController().signal,
    config,
    ...NOOP_JOURNAL_ADMISSION,
    deleteWebhook: async () => {},
    getUpdates: async () => {
      calls += 1;
      if (calls <= 4) {
        throw new Error(
          "Bale API getUpdates failed: HTTP 409: Conflict: terminated by other getUpdates request; make sure that only one bot instance is running",
        );
      }
      throw new DOMException("stop", "AbortError");
    },
    persistConfig: async () => {},
    onErrorStatus: (message) => {
      statusMessages.push(`error:${message}`);
    },
    onStatusReset: () => {
      statusMessages.push("reset");
    },
    sleep: async (ms) => {
      statusMessages.push(`sleep:${ms}`);
    },
    recordRuntimeEvent: (category, error, details) => {
      const message = error instanceof Error ? error.message : String(error);
      runtimeEvents.push(`${category}:${message}:${details?.phase}`);
    },
  });
  assert.equal(
    isBaleGetUpdatesConflictError(
      new Error("HTTP 409: Conflict: terminated by other getUpdates request"),
    ),
    true,
  );
  assert.deepEqual(statusMessages, [
    "sleep:1000",
    "sleep:1000",
    "sleep:3000",
    "sleep:3000",
  ]);
  assert.equal(runtimeEvents.length, 0);
});

test("Poll loop bounds consecutive conflicts, including bootstrap, and resets on other outcomes", async () => {
  const limit = BALE_GET_UPDATES_CONFLICT_STOP_LIMIT;
  for (const cursor of [undefined, 1]) {
    for (const reset of [undefined, "success", "network"] as const) {
      const outcomes = [
        ...(reset ? [...Array(limit - 1).fill("conflict"), reset] : []),
        ...Array(limit).fill("conflict"),
      ];
      let calls = 0;
      let sleeps = 0;
      await assert.rejects(runBalePollLoop({
        ctx: TEST_CONTEXT, signal: new AbortController().signal,
        config: { botToken: "test-token" }, ...NOOP_JOURNAL_ADMISSION,
        getAcceptedThroughUpdateId: () => cursor,
        deleteWebhook: async () => {}, persistConfig: async () => {},
        getUpdates: async () => {
          const outcome = outcomes[calls++];
          if (outcome === "success") return [];
          if (outcome === "network") throw new Error("network down");
          if (!outcome) throw new DOMException("Test safety bound", "AbortError");
          throw new Error("HTTP 409: Conflict: terminated by other getUpdates request");
        },
        onErrorStatus: () => {}, onStatusReset: () => {},
        sleep: async () => { sleeps++; },
      }), (error: unknown) => error instanceof BalePersistentGetUpdatesConflictError && error.count === limit);
      assert.equal(calls, outcomes.length, `${cursor}/${reset}`);
      assert.equal(sleeps, (limit - 1) * (reset ? 2 : 1) + (reset === "network" ? 1 : 0));
    }
  }
});

test("Persistent conflict detaches the poller before awaited outer teardown", async () => {
  const state = createBalePollingControllerState();
  let notifications = 0;
  let typingStops = 0;
  const controller = createBalePollingController({
    state, hasBotToken: () => true, updateStatus: () => {},
    stopTypingLoop: () => { typingStops++; },
    runPollLoop: async () => { throw new BalePersistentGetUpdatesConflictError(10); },
    async onPersistentConflict(ctx, count): Promise<void> {
      assert.equal(ctx, TEST_CONTEXT);
      assert.equal(count, 10);
      assert.equal(state.pollingPromise, undefined);
      await controller.stop();
      notifications++;
    },
  });
  controller.start(TEST_CONTEXT);
  await state.pollingPromise;
  assert.equal(notifications, 1);
  assert.equal(typingStops, 1);
  assert.equal(state.stopReason, "persistent-conflict");
  assert.equal(state.phase, "stopped");
});

test("Rejected stale admission leaves the current pending startup intact", async () => {
  for (const boundary of ["prepare", "worker"] as const) {
    let release!: () => void;
    let entered!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const pause = async () => { entered(); await pending; };
    const starts: string[] = [];
    const runtime = createBalePollingAdmissionRuntime({
      canStart: (ctx) => ctx === "current",
      prepareStart: () => boundary === "prepare" ? pause() : undefined,
      worker: { onSessionStart: async () => { if (boundary === "worker") await pause(); } },
      polling: {
        isActive: () => starts.length > 0,
        start: (ctx: string) => { starts.push(ctx); }, stop: async () => {},
      },
    });
    const current = runtime.start("current");
    await started;
    await runtime.start("obsolete");
    release();
    await current;
    assert.deepEqual(starts, ["current"], boundary);
  }
});

test("Admission startup cannot resurrect a stopped or unauthorized poller after an await", async () => {
  for (const boundary of ["prepare", "worker"] as const) {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    let starts = 0;
    let allowed = true;
    const runtime = createBalePollingAdmissionRuntime({
      canStart: () => allowed,
      prepareStart: () => boundary === "prepare" ? pending : undefined,
      worker: { onSessionStart: async () => { if (boundary === "worker") await pending; } },
      polling: { isActive: () => false, start: () => { starts++; }, stop: async () => {} },
    });
    const start = runtime.start(TEST_CONTEXT);
    await Promise.resolve();
    await runtime.stop();
    release();
    await start;
    assert.equal(starts, 0);
    allowed = false;
    await runtime.start(TEST_CONTEXT);
    assert.equal(starts, 0);
    allowed = true;
    await runtime.start(TEST_CONTEXT);
    assert.equal(starts, 1);
  }
});

test("Poll loop reports retryable errors and sleeps before retrying", async () => {
  const config = { botToken: "123:abc", lastUpdateId: 1 };
  const statusMessages: string[] = [];
  const runtimeEvents: string[] = [];
  let calls = 0;
  await runBalePollLoop({
    ctx: TEST_CONTEXT,
    signal: new AbortController().signal,
    config,
    ...NOOP_JOURNAL_ADMISSION,
    deleteWebhook: async () => {},
    getUpdates: async () => {
      calls += 1;
      if (calls === 1) {
        throw new Error("network down");
      }
      throw new DOMException("stop", "AbortError");
    },
    persistConfig: async () => {},
    onErrorStatus: (message) => {
      statusMessages.push(`error:${message}`);
    },
    onStatusReset: () => {
      statusMessages.push("reset");
    },
    sleep: async (ms) => {
      statusMessages.push(`sleep:${ms}`);
    },
    recordRuntimeEvent: (category, error, details) => {
      const message = error instanceof Error ? error.message : String(error);
      runtimeEvents.push(`${category}:${message}:${details?.phase}`);
    },
  });
  assert.deepEqual(statusMessages, [
    "error:network down",
    "sleep:1000",
    "reset",
  ]);
  assert.deepEqual(runtimeEvents, ["polling:network down:loop"]);
});

test("Poll loop caps retry delay but recovers after a prolonged outage without reconnect", async () => {
  const sleeps: number[] = [];
  const responses: number[] = [];
  let calls = 0;
  await runBalePollLoop({
    ctx: TEST_CONTEXT,
    signal: new AbortController().signal,
    config: { botToken: "123:abc" },
    ...NOOP_JOURNAL_ADMISSION,
    deleteWebhook: async () => {},
    getUpdates: async () => {
      calls++;
      if (calls <= 12) throw new Error("network down");
      if (calls === 13) return [];
      throw new DOMException("stop", "AbortError");
    },
    persistConfig: async () => {},
    onErrorStatus: () => {},
    onStatusReset: () => {},
    onSuccessfulResponse: (count) => { responses.push(count); },
    sleep: async (ms) => { sleeps.push(ms); },
  });
  assert.equal(calls, 14);
  assert.deepEqual(sleeps, [1_000, 2_000, 4_000, 8_000, 16_000, ...Array(7).fill(30_000)]);
  assert.deepEqual(responses, [0], "The existing poller must recover without a new start");
});

test("Poll loop resets backoff after successful durable admission", async () => {
  const config = { botToken: "123:abc", lastUpdateId: 1 };
  const sleeps: number[] = [];
  let calls = 0;
  await runBalePollLoop({
    ctx: TEST_CONTEXT,
    signal: new AbortController().signal,
    config,
    ...NOOP_JOURNAL_ADMISSION,
    deleteWebhook: async () => {},
    getUpdates: async () => {
      calls += 1;
      if (calls === 1 || calls === 3) throw new Error("network down");
      if (calls === 2) return [];
      throw new DOMException("stop", "AbortError");
    },
    persistConfig: async () => {},
    onErrorStatus: () => {},
    onStatusReset: () => {},
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  assert.deepEqual(sleeps, [1_000, 1_000]);
});

test("Polling retry delay saturates and never becomes non-finite", () => {
  assert.equal(getBalePollingRetryDelayMs(1), 1_000);
  assert.equal(getBalePollingRetryDelayMs(5), 16_000);
  assert.equal(getBalePollingRetryDelayMs(6), 30_000);
  assert.equal(getBalePollingRetryDelayMs(1_000), 30_000);
});

test("Successful HTTP responses do not reset backoff while durable admission fails", async () => {
  const sleeps: number[] = [];
  let calls = 0;
  let admissions = 0;
  await runBalePollLoop({
    ctx: TEST_CONTEXT,
    signal: new AbortController().signal,
    config: { botToken: "123:abc" },
    ...NOOP_JOURNAL_ADMISSION,
    appendUpdateBatch: () => {
      admissions++;
      if (admissions <= 2) throw new Error("journal unavailable");
    },
    deleteWebhook: async () => {},
    getUpdates: async () => {
      calls++;
      if (calls === 5) throw new DOMException("stop", "AbortError");
      return [{ update_id: calls + 1 }];
    },
    persistConfig: async () => {},
    onErrorStatus: () => {},
    onStatusReset: () => {},
    sleep: async (ms) => { sleeps.push(ms); },
  });
  assert.equal(admissions, 4);
  assert.deepEqual(sleeps, [1_000, 2_000]);
});

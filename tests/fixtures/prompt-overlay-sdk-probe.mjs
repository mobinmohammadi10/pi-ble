/**
 * Zones: shared utils. Isolated SDK input-selection diagnosis, never a runtime adapter.
 * Real boundary/loop mechanics run on an in-memory facade with a synthetic stream.
 * Private SDK methods are exercised only to expose temporal counterexamples.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const DEFAULT_ROOT = fileURLToPath(new URL("../../node_modules/@earendil-works/pi-coding-agent", import.meta.url));
const OVERLAY = "PROBE_OVERLAY";
const NATIVE = "PROBE_NATIVE";
const MODEL = {
  id: "probe", name: "probe", api: "probe", provider: "probe", baseUrl: "",
  reasoning: false, input: ["text"], contextWindow: 0, maxTokens: 64,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
function assistant(sequence) {
  return {
    role: "assistant", content: [{ type: "text", text: `response-${sequence}` }],
    api: MODEL.api, provider: MODEL.provider, model: MODEL.id, stopReason: "stop",
    timestamp: sequence,
    usage: {
      input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
}
function freshInput(messages) {
  const lastAssistant = messages.findLastIndex((message) => message.role === "assistant");
  return messages.slice(lastAssistant + 1).filter((message) => message.role === "user")
    .flatMap((message) => typeof message.content === "string"
      ? [message.content]
      : message.content.filter((block) => block.type === "text").map((block) => block.text));
}
async function scenario(sdk, core, timing, nativeKind, bridgeMode) {
  const manager = sdk.SessionManager.inMemory(process.cwd());
  const requests = [];
  const boundaryErrors = [];
  const sessionEvents = [];
  let injected = false;
  let checked = false;
  let earlyPending;
  let pendingAtCommit;
  let proposed = false;
  let agent;
  const inject = () => {
    if (nativeKind === "none" || injected) return;
    injected = true;
    agent[nativeKind]({ role: "user", content: NATIVE, timestamp: 20 });
  };
  let toolExecutions = 0;
  agent = new core.Agent({
    initialState: { model: MODEL, tools: bridgeMode ? [{
      name: "probe_tool", label: "Probe", description: "Synthetic tool batch",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      execute: async () => { await Promise.resolve(); toolExecutions++; return { content: [{ type: "text", text: "result" }], details: {} }; },
    }] : [], messages: [] },
    convertToLlm: sdk.convertToLlm,
    streamFn: async (_model, context) => {
      assert.ok(requests.length < 4, "A bounded continuation must terminate");
      requests.push({ freshInput: freshInput(context.messages), nativePending: agent.hasQueuedMessages() });
      if (requests.length === 1 && timing === "before-check") inject();
      const message = assistant(requests.length);
      if (bridgeMode && requests.length === 1) {
        message.content = ["probe-call-1", "probe-call-2"].map(id => ({ type: "toolCall", id, name: "probe_tool", arguments: {} }));
        message.stopReason = "toolUse";
      }
      return {
        async *[Symbol.asyncIterator]() { yield { type: "done", reason: message.stopReason, message }; },
        result: async () => message,
      };
    },
  });
  // No live AgentSession is created: only its compiled boundary mechanics run here.
  const session = Object.assign(Object.create(sdk.AgentSession.prototype), {
    agent, sessionManager: manager, _cwd: process.cwd(), _turnIndex: 0,
    _pendingCustomMessages: [], _entryIdsByMessage: new WeakMap(),
    _boundaryDispatchedMessages: new WeakSet(),
    _eventListeners: [(event) => sessionEvents.push(event.type)],
  });
  let bridge;
  if (bridgeMode) {
    // Node --experimental-strip-types loads the retained implementation, not a copied policy.
    const Queue = await import("../../lib/queue.ts");
    const { createBaleQueueBindingRuntime } = await import("../../lib/bindings.ts");
    const store = Queue.createBaleQueueStore();
    const deferredDispatch = Queue.createBaleDeferredQueueDispatchRuntime();
    deferredDispatch.bind("probe");
    let settlementCalls = 0;
    const disposed = new Set();
    const items = [OVERLAY, "PROBE_SECOND"].map((text, index) => ({
      kind: "prompt", chatId: 7, target: { chatId: 7, threadId: 10 }, replyToMessageId: index + 1,
      queueOrder: index + 1, queueLane: "steer", laneOrder: index + 1, sourceMessageIds: [index + 1],
      content: [{ type: "text", text }], historyText: text, statusSummary: text, queuedAttachments: [],
      admissionReceipts: [Queue.createBaleQueueAdmissionReceipt({ queueKind: "prompt", scope: "probe", sourceUpdateIds: [index + 1] })],
    }));
    store.setQueuedItems(items);
    const runtime = createBaleQueueBindingRuntime({ store, deferredDispatch,
      queue: { allocateItemOrder: () => 3 },
      lifecycle: { isCompactionInProgress: () => false, hasDispatchPending: () => false },
      activeTurn: { has: () => false }, transportStamp: { isActive: () => true },
      admission: { hasPendingQueueMutationForItem: () => false, getSettlement: () => ({
        isItemReady: item => item.admissionReceipts.every(receipt => !disposed.has(receipt.receiptId)),
        onControlSettled: () => {}, onItemsDiscarded: () => false,
        onPromptHandedOff(item) {
          settlementCalls++;
          assert.equal(toolExecutions, 2, "Publication is after the complete parallel tool batch");
          assert.equal(item.admissionReceipts.length, 2);
          disposed.add(item.admissionReceipts[0].receiptId);
          if (bridgeMode === "partial") return false;
          disposed.add(item.admissionReceipts[1].receiptId);
          return true;
        },
      }) },
      promptDispatch: { startTypingLoop: () => assert.fail("no new active turn"),
        onPromptDispatchStart: () => assert.fail("no ordinary dispatch"), onPromptDispatchFailure: () => {} },
      isIdle: () => !agent.state.isStreaming, hasPendingMessages: () => agent.hasQueuedMessages(),
      isContextCurrent: ctx => ctx === "probe", isContextAborted: () => agent.signal?.aborted === true,
      updateStatus: () => {}, sendTextReply: async () => undefined, sendUserMessage: () => assert.fail("no native pending storage"),
    });
    bridge = { runtime, store, disposed, calls: () => settlementCalls };
  }
  const draft = {
    type: "custom_message", customType: "probe.overlay", content: OVERLAY,
    display: false, details: { operation: "isolated-probe" },
  };
  const extension = {
    path: "<isolated-overlay-probe>",
    handlers: new Map([["turn_end", [
      async (event, ctx) => {
        if (bridge) {
          earlyPending ??= ctx.hasPendingMessages();
          const result = bridge.runtime.onTurnEnd(event, "probe");
          proposed ||= result !== undefined;
          return result ? { ...result, entries: [...event.entries, ...result.entries] } : undefined;
        }
        if (checked) return;
        checked = true;
        earlyPending = ctx.hasPendingMessages();
        if (earlyPending) return;
        proposed = true;
        return { entries: [draft], continue: true };
      },
      async (event) => {
        if (event.entries.length > 0 && timing === "after-check") inject();
        if (bridgeMode === "remove") return { entries: event.entries.filter(entry => entry.customType !== "bale-steer"), continue: false };
      },
    ]]]),
  };
  const runner = new sdk.ExtensionRunner([extension], sdk.createExtensionRuntime(), process.cwd(), manager, {});
  runner.createContext = () => ({ hasPendingMessages: () => agent.hasQueuedMessages() });
  runner.onError((error) => boundaryErrors.push(error.error));
  session._extensionRunner = runner;
  const commit = session._commitBoundaryDrafts;
  session._commitBoundaryDrafts = function (drafts) {
    if (drafts.length > 0) {
      if (timing === "before-commit") inject();
      pendingAtCommit = agent.hasQueuedMessages();
    }
    const result = commit.call(this, drafts);
    if (drafts.length > 0 && timing === "after-commit") inject();
    return result;
  };
  agent.subscribe((event) => {
    if (bridgeMode && event.type === "turn_start") session._turnIndex++;
    if (event.type !== "message_end") return;
    const id = manager.appendMessage(event.message);
    session._entryIdsByMessage.set(event.message, id);
  });
  session._installAgentBoundaryHooks();
  session._installAgentRequestProjection();
  agent.prepareNextTurnWithContext = async (turn) => {
    const context = await session._compactBeforeNextAssistantResponse(turn.context);
    if (proposed && timing === "during-prepare") inject();
    return { context };
  };
  await agent.prompt("PROBE_INITIAL");
  assert.deepEqual(boundaryErrors, [], "A harness error is not an SDK counterexample");
  assert.equal(agent.state.errorMessage, undefined);
  assert.equal(manager.getSessionFile(), undefined, "The probe must not create session files");
  const committed = manager.getBranch().filter((entry) => entry.type === "custom_message");
  if (bridge) {
    assert.equal(toolExecutions, 2);
    assert.equal(bridge.calls(), 1);
    assert.equal(requests.length, 2);
    assert.equal(committed.length, bridgeMode === "success" ? 1 : 0);
    assert.equal(requests[1].freshInput.includes(OVERLAY), bridgeMode === "success");
    assert.equal(requests[1].freshInput.includes("PROBE_SECOND"), bridgeMode === "success");
    assert.equal(bridge.store.getQueuedItems().length, bridgeMode === "partial" ? 2 : 0);
    if (bridgeMode === "partial") {
      assert.ok(bridge.store.getQueuedItems().every(item => item.steerAttempted));
      assert.equal(bridge.disposed.size, 1);
      assert.equal(bridge.runtime.onTurnEnd({ turnIndex: 9, outcome: "completed" }, "probe"), undefined);
      assert.equal(bridge.calls(), 1);
    }
    return { bridgeMode, toolExecutions, settlementCalls: bridge.calls(), disposed: bridge.disposed.size,
      retainedQueueItems: bridge.store.getQueuedItems().length, committedEntries: committed.length, requests };
  }
  assert.equal(committed.length, proposed ? 1 : 0);
  assert.equal(earlyPending, timing === "before-check");
  const mixed = requests.some((request) => request.freshInput.includes(OVERLAY) && request.freshInput.includes(NATIVE));
  const expectedMixed = nativeKind !== "none" && timing !== "before-check"
    && !(timing === "during-prepare" && nativeKind === "followUp");
  assert.equal(mixed, expectedMixed, "Changed SDK semantics require re-evaluating the handoff gate");
  assert.equal(agent.hasQueuedMessages(), false, "All admitted native input must actually drain");
  if (timing === "none") {
    assert.equal(requests.length, 2);
    assert.deepEqual(requests[1].freshInput, [OVERLAY]);
  }
  if (timing === "after-check" || timing === "before-commit") assert.equal(pendingAtCommit, true);
  if (timing === "after-commit" || timing === "during-prepare") assert.equal(pendingAtCommit, false);
  if (timing === "before-check") {
    assert.equal(requests.length, 2);
    assert.ok(requests[1].freshInput.includes(NATIVE));
    assert.ok(!requests[1].freshInput.includes(OVERLAY));
  }
  if (timing === "during-prepare" && nativeKind === "followUp") {
    assert.equal(requests.length, 3);
    assert.deepEqual(requests[1].freshInput, [OVERLAY]);
    assert.equal(requests[1].nativePending, true);
    assert.deepEqual(requests[2].freshInput, [NATIVE]);
  }
  return {
    timing, nativeKind, earlyPending, pendingAtCommit, draftCommitted: committed.length === 1,
    requests, mixedFreshInput: mixed,
    sdkEntryNotifications: sessionEvents.filter((type) => type === "entry_appended").length,
  };
}
async function requestHookScenario(sdk, core, hook, effect) {
  const sent = [];
  const errors = [];
  const responses = [];
  let candidateSeen = false;
  let sourceCurrent = true;
  let toolExecutions = 0;
  const messagesOf = (event) => hook === "before_provider_request" ? event.payload.messages : event.messages;
  const resultOf = (event, messages) => hook === "before_provider_request"
    ? { ...event.payload, messages } : { messages };
  const hasCompletedTurn = (messages) => messages.some((message) => message.role === "assistant");
  const runner = new sdk.ExtensionRunner([{
    path: "<isolated-request-hook-probe>",
    handlers: new Map([
      [hook, [
        async (event) => {
          const messages = messagesOf(event);
          if (!hasCompletedTurn(messages)) return;
          candidateSeen = true;
          return resultOf(event, [...messages, { role: "user", content: OVERLAY, timestamp: 40 }]);
        },
        async (event) => {
          const messages = messagesOf(event);
          if (!hasCompletedTurn(messages)) return;
          if (effect === "remove") return resultOf(event, messages.filter((message) => message.content !== OVERLAY));
          if (effect === "throw") {
            sourceCurrent = false;
            throw new Error("Probe source authority lost");
          }
        },
      ]],
      ["after_provider_response", [async (event) => responses.push(Object.keys(event).sort())]],
    ]),
  }], sdk.createExtensionRuntime(), process.cwd(), sdk.SessionManager.inMemory(process.cwd()), {});
  runner.createContext = () => ({});
  runner.onError((error) => errors.push(error.error));
  const agent = new core.Agent({
    initialState: {
      model: MODEL, messages: [], tools: [{
        name: "probe_tool", label: "Probe", description: "Synthetic in-memory tool",
        parameters: { type: "object", properties: {}, additionalProperties: false },
        execute: async () => {
          toolExecutions++;
          return { content: [{ type: "text", text: "PROBE_TOOL_RESULT" }], details: {} };
        },
      }],
    },
    convertToLlm: sdk.convertToLlm,
    transformContext: (messages) => runner.emitContext(messages),
    onPayload: (payload) => runner.emitBeforeProviderRequest(payload),
    onResponse: (response) => runner.emit({
      type: "after_provider_response", status: response.status, headers: response.headers,
    }),
    streamFn: async (_model, context, options) => {
      assert.ok(sent.length < 2, "Only the tool continuation is needed");
      // Match SDK request instrumentation without calling a provider or registering one.
      const payload = await options.onPayload({ messages: context.messages });
      sent.push({ freshInput: freshInput(payload.messages), sourceCurrent });
      await options.onResponse({ status: 200, headers: {} });
      const message = assistant(sent.length);
      if (sent.length === 1) {
        message.content = [{ type: "toolCall", id: "probe-call", name: "probe_tool", arguments: {} }];
        message.stopReason = "toolUse";
      }
      return {
        async *[Symbol.asyncIterator]() {
          yield { type: "start", partial: { ...message, content: [], stopReason: "pending" } };
          yield { type: "done", reason: message.stopReason, message };
        },
        result: async () => message,
      };
    },
  });
  await agent.prompt("PROBE_INITIAL");
  assert.equal(agent.state.errorMessage, undefined, "A harness failure is not a hook witness");
  assert.equal(toolExecutions, 1);
  assert.equal(sent.length, 2);
  assert.equal(candidateSeen, true);
  assert.deepEqual(sent[1].freshInput, effect === "remove" ? [] : [OVERLAY]);
  assert.deepEqual(errors, effect === "throw" ? ["Probe source authority lost"] : []);
  assert.equal(sent[1].sourceCurrent, effect !== "throw");
  assert.deepEqual(responses, Array.from({ length: 2 }, () => ["headers", "status", "type"]));
  return { hook, effect, candidateSeen, sent, errors, responseFields: responses[1] };
}
async function runPromptOverlaySdkProbe(sdkRoot = DEFAULT_ROOT, mode = "native-window") {
  const root = resolve(sdkRoot);
  const requireFromSdk = createRequire(join(root, "package.json"));
  const corePackage = requireFromSdk.resolve("@earendil-works/pi-agent-core/package.json");
  const coreMetadata = JSON.parse(readFileSync(corePackage, "utf8"));
  const coreEntry = resolve(dirname(corePackage), coreMetadata.exports["."].import);
  const [sdk, core] = await Promise.all([
    import(pathToFileURL(join(root, "dist/index.js")).href),
    import(pathToFileURL(coreEntry).href),
  ]);
  assert.ok(["native-window", "request-hooks", "bridge-boundary"].includes(mode), "Unknown probe mode");
  const cases = [];
  if (mode === "native-window") {
    cases.push(await scenario(sdk, core, "none", "none"));
    for (const timing of ["before-check", "after-check", "before-commit", "after-commit", "during-prepare"]) {
      for (const kind of ["steer", "followUp"]) cases.push(await scenario(sdk, core, timing, kind));
    }
  } else if (mode === "bridge-boundary") {
    for (const bridgeMode of ["success", "remove", "partial"]) cases.push(await scenario(sdk, core, "none", "none", bridgeMode));
  } else {
    for (const hook of ["context", "context_with_system", "before_provider_request"]) {
      for (const effect of ["control", "remove", "throw"]) cases.push(await requestHookScenario(sdk, core, hook, effect));
    }
  }
  const hash = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
  return {
    sdkVersion: JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version,
    coreVersion: coreMetadata.version,
    sourceHashes: {
      session: hash(join(root, "dist/core/agent-session.js")),
      runner: hash(join(root, "dist/core/extensions/runner.js")),
      loop: hash(join(dirname(coreEntry), "agent-loop.js")),
      binding: hash(join(root, "dist/core/sdk.js")),
    },
    isolation: "In-memory facade; synthetic stream; no provider, live session, or production integration",
    mode, cases,
  };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(await runPromptOverlaySdkProbe(process.argv[2], process.argv[3]), null, 2));
}

/**
 * Regression tests for the Bale preview domain
 * Covers native rich draft previews, safe-prefix selection, and finalization behavior
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  allocateBaleDraftId,
  buildBalePreviewFinalText,
  createBaleAssistantPreviewRuntime,
  createBalePreviewController,
  createBalePreviewMachineState,
  getSafeBaleRichMarkdownDraftPrefix,
  isBalePreviewBusy,
  shouldSuppressPreviewForGuestTurn,
  transitionBalePreview,
  type BalePreviewControllerDeps,
  type BalePreviewEffect,
  type BalePreviewEvent,
  type BalePreviewMachineState,
} from "../lib/preview.ts";
import { createBaleThreadTarget } from "../lib/target.ts";

/** A controller without throttling whose draft and diagnostic effects land in one event log. */
function createPreviewHarness(
  overrides: Partial<BalePreviewControllerDeps> = {},
) {
  const events: string[] = [];
  const preview = createBalePreviewController({
    minDraftIntervalMs: 0,
    maxMessageLength: 100,
    sendDraft: async (chatId, draftId, text) => {
      events.push(`draft:${chatId}:${draftId}:${text}`);
    },
    recordRuntimeEvent: (_category, _error, details) => {
      events.push(`preview:${details?.phase}`);
    },
    ...overrides,
  });
  const start = (pendingText: string): void => {
    preview.resetState();
    preview.setPendingText(pendingText);
  };
  return { events, preview, start };
}

const MACHINE_CONFIG = {
  maxDraftId: 100,
  maxMessageLength: 100,
  minDraftIntervalMs: 2000,
};
const AT = { now: 10_000, canSend: true };
const REQUEST = { chatId: 7 };

/** Folds events through the pure transition and returns the final state with every effect in order. */
function runPreviewMachine(
  events: BalePreviewEvent[],
  state: BalePreviewMachineState = createBalePreviewMachineState(),
): { state: BalePreviewMachineState; effects: BalePreviewEffect[] } {
  const effects: BalePreviewEffect[] = [];
  for (const event of events) {
    const next = transitionBalePreview(state, event, MACHINE_CONFIG);
    state = next.state;
    effects.push(...next.effects);
  }
  return { state, effects };
}

const flushAt = (now = AT.now, canSend = true): BalePreviewEvent => ({
  type: "flushRequested",
  request: REQUEST,
  now,
  canSend,
});

test("Preview machine keeps one draft in flight and replays the coalesced request on settlement", () => {
  const sent = runPreviewMachine([
    { type: "reset" },
    { type: "textSet", text: "first" },
    flushAt(),
    { type: "textSet", text: "second" },
    flushAt(),
    flushAt(),
  ]);
  assert.deepEqual(
    sent.effects.map((effect) => effect.type),
    ["sendDraft"],
  );
  assert.equal(isBalePreviewBusy(sent.state), true);
  assert.deepEqual(sent.state.pending, REQUEST);
  const settled = runPreviewMachine(
    [
      {
        type: "draftSettled",
        segmentId: 1,
        generation: 1,
        text: "first",
        now: 12_000,
        canSend: true,
      },
    ],
    sent.state,
  );
  assert.equal(settled.state.segment?.lastSentText, "first");
  assert.deepEqual(settled.effects, [
    {
      type: "sendDraft",
      request: REQUEST,
      draftId: 1,
      text: "second",
      segmentId: 1,
      generation: 1,
    },
  ]);
});

test("Preview machine ignores draft results for a replaced segment or an older generation", () => {
  const sent = runPreviewMachine([
    { type: "reset" },
    { type: "textSet", text: "old" },
    flushAt(),
  ]);
  for (const replacement of [
    { type: "segmentStarted" },
    { type: "reset" },
  ] as const) {
    const { state } = runPreviewMachine(
      [
        replacement,
        {
          type: "draftSettled",
          segmentId: 1,
          generation: 1,
          text: "old",
          now: AT.now,
          canSend: true,
        },
      ],
      sent.state,
    );
    assert.equal(state.segment?.lastSentText, "");
    assert.equal(state.inFlight, null);
  }
});

test("Preview machine detaches predecessor dependencies and ignores their late settlements", () => {
  const replacement = runPreviewMachine([
    { type: "reset" },
    { type: "textSet", text: "Old" },
    flushAt(),
    { type: "publicationOpened", id: 1 },
    { type: "invalidated" },
    { type: "reset" },
    { type: "textSet", text: "Replacement" },
    flushAt(),
    { type: "publicationOpened", id: 2 },
  ]);
  assert.equal(replacement.state.inFlight, 2);
  assert.deepEqual(replacement.state.publications, [2]);
  for (const stale of [
    { type: "draftSettled", segmentId: 1, generation: 1, text: "Old", ...AT },
    { type: "publicationSettled", id: 1, ...AT },
    { type: "timerFired", request: REQUEST, segmentId: 1, ...AT },
  ] satisfies BalePreviewEvent[]) {
    const result = runPreviewMachine([stale], replacement.state);
    assert.equal(result.state, replacement.state);
    assert.deepEqual(result.effects, [], "Predecessor completion has no replacement authority");
  }
  const throttled = runPreviewMachine([
    { type: "reset" },
    { type: "textSet", text: "Held replacement" },
    { type: "draftWindowOpened", at: 12_000 },
    flushAt(),
  ], replacement.state);
  const staleTimer = runPreviewMachine([
    { type: "timerFired", request: REQUEST, segmentId: 1, now: 12_000, canSend: true },
  ], throttled.state);
  assert.equal(staleTimer.state, throttled.state, "A stale timer cannot clear the replacement timer's ownership");
});

test("Preview machine arms one throttle timer per segment and drops it with the segment", () => {
  const throttled = runPreviewMachine([
    { type: "reset" },
    { type: "textSet", text: "Opening" },
    { type: "draftWindowOpened", at: 12_000 },
    flushAt(),
    flushAt(11_000),
  ]);
  assert.deepEqual(throttled.effects, [
    { type: "armTimer", delay: 2000, request: REQUEST, segmentId: 1 },
  ]);
  for (const ending of [
    { type: "sealed" },
    { type: "segmentStarted" },
    { type: "discarded" },
  ] as const) {
    const { state, effects } = runPreviewMachine([ending], throttled.state);
    assert.deepEqual(effects, [{ type: "cancelTimer" }]);
    assert.equal(state.timerSegmentId, null);
  }
  const fired = runPreviewMachine(
    [{ type: "timerFired", request: REQUEST, segmentId: 1, now: 12_000, canSend: true }],
    throttled.state,
  );
  assert.equal(fired.effects[0]?.type, "sendDraft");
});

test("Preview machine holds requests behind open publications and clears through a closed gate", () => {
  const blocked = runPreviewMachine([
    { type: "reset" },
    { type: "textSet", text: "Next" },
    { type: "publicationOpened", id: 1 },
    flushAt(),
  ]);
  assert.deepEqual(blocked.effects, []);
  assert.equal(isBalePreviewBusy(blocked.state), true);
  assert.equal(isBalePreviewBusy(blocked.state, false), false);
  const released = runPreviewMachine(
    [{ type: "publicationSettled", id: 1, ...AT }],
    blocked.state,
  );
  assert.equal(released.effects[0]?.type, "sendDraft");
  const closed = runPreviewMachine([
    { type: "reset" },
    { type: "textSet", text: "Hidden" },
    flushAt(AT.now, false),
  ]);
  assert.deepEqual(closed.effects, [
    { type: "clearClosedGate", request: REQUEST },
  ]);
});

/** Small deterministic PRNG so a failing seed reproduces exactly. */
function createSeededRandom(seed: number): () => number {
  let value = seed >>> 0;
  return () => {
    value = (value + 0x6d2b79f5) >>> 0;
    let mixed = Math.imul(value ^ (value >>> 15), 1 | value);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296;
  };
}

test("Preview machine invariants hold across random event sequences", () => {
  const texts = ["", "Hello", "**Bold** and *ita", "Done.", "```ts\nopen", "Longer answer text"];
  for (let seed = 1; seed <= 2000; seed++) {
    const random = createSeededRandom(seed);
    const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!;
    let state = createBalePreviewMachineState();
    let now = 10_000;
    // The environment the runner provides: outstanding draft requests, the armed timer and open publications.
    const drafts: Array<Extract<BalePreviewEffect, { type: "sendDraft" }>> = [];
    let timer: Extract<BalePreviewEffect, { type: "armTimer" }> | undefined;
    const publications: Array<{ id: number; generation: number }> = [];
    let publicationIds = 0;
    const trace: string[] = [];
    for (let index = 0; index < 60; index++) {
      now += Math.floor(random() * 1500);
      const canSend = random() > 0.1;
      const candidates: Array<() => BalePreviewEvent | undefined> = [
        () => ({ type: "reset" }),
        () => ({ type: "invalidated" }),
        () => ({ type: "segmentStarted" }),
        () => ({ type: "segmentEnsured" }),
        () => ({ type: "sealed" }),
        () => ({ type: "discarded" }),
        () => ({ type: "textSet", text: pick(texts) }),
        () => ({ type: "draftWindowOpened", at: now + 2000 }),
        // Flush requests arrive regardless of segment state; the transition must reject them itself.
        () => ({ type: "flushRequested", request: REQUEST, now, canSend }),
        () => timer ? { type: "timerFired", request: timer.request, segmentId: timer.segmentId, now, canSend } : undefined,
        () => {
          const draft = drafts.shift();
          if (!draft) return undefined;
          return {
            type: "draftSettled", segmentId: draft.segmentId, generation: draft.generation,
            ...(random() > 0.2 ? { text: draft.text } : {}), now, canSend,
          };
        },
        () => ({ type: "publicationOpened", id: (publicationIds += 1) }),
        () => {
          if (publications.length === 0) return undefined;
          const { id } = publications.splice(Math.floor(random() * publications.length), 1)[0]!;
          return { type: "publicationSettled", id, now, canSend };
        },
      ];
      const event = pick(candidates)();
      if (!event) continue;
      if (event.type === "timerFired") timer = undefined;
      if (event.type === "publicationOpened")
        publications.push({ id: event.id, generation: state.generation });
      trace.push(event.type);
      const before = state;
      const next = transitionBalePreview(before, event, MACHINE_CONFIG);
      state = next.state;
      const context = `seed ${seed}: ${trace.join(" > ")}`;
      for (const effect of next.effects) {
        if (effect.type === "sendDraft") {
          assert.equal(drafts.filter((draft) => draft.generation === state.generation).length, 0, `generation single flight broken, ${context}`);
          assert.equal(publications.filter((publication) => publication.generation === state.generation).length, 0, `draft sent behind a current publication, ${context}`);
          assert.ok(canSend, `draft sent through a closed gate, ${context}`);
          assert.equal(effect.segmentId, state.segment?.id, `draft for a non-current segment, ${context}`);
          assert.equal(state.segment?.sealed, false, `draft for a sealed segment, ${context}`);
          assert.ok(before.nextDraftAt <= now, `draft sent inside the throttle window, ${context}`);
          assert.notEqual(effect.text, before.segment?.lastSentText, `unchanged draft resent, ${context}`);
          drafts.push(effect);
        } else if (effect.type === "armTimer") {
          assert.equal(timer, undefined, `second timer armed, ${context}`);
          timer = effect;
        } else if (effect.type === "cancelTimer") {
          assert.ok(timer, `cancelled a timer that was not armed, ${context}`);
          timer = undefined;
        }
      }
      assert.equal(state.inFlight, drafts.find((draft) => draft.generation === state.generation)?.segmentId ?? null,
        `in-flight ownership drifted, ${context}`);
      assert.equal(state.timerSegmentId, timer?.segmentId ?? null, `timer ownership drifted, ${context}`);
      if (state.timerSegmentId !== null)
        assert.equal(state.timerSegmentId, state.segment?.id, `timer outlived its segment, ${context}`);
      if (state.pending !== null)
        assert.ok(state.segment && !state.segment.sealed, `pending request without a live segment, ${context}`);
      assert.deepEqual([...state.publications].sort(),
        publications.filter((publication) => publication.generation === state.generation).map((publication) => publication.id).sort(),
        `publication set drifted, ${context}`);
      if (event.type === "draftSettled" && state.segment?.lastSentText !== before.segment?.lastSentText) {
        assert.equal(event.segmentId, state.segment?.id, `stale segment result applied, ${context}`);
        assert.equal(event.generation, state.generation, `stale generation result applied, ${context}`);
      }
    }
  }
});

test("Preview helpers create draft-only state and allocate draft ids", () => {
  const { preview } = createPreviewHarness();
  assert.equal(preview.getState(), undefined);
  preview.resetState();
  const state = preview.getState();
  assert.equal(state?.mode, "draft");
  assert.equal(state?.pendingText, "");
  assert.equal(state?.lastSentText, "");
  assert.equal(state?.draftId, undefined);
  assert.equal(state?.sealed, false);
  assert.equal(allocateBaleDraftId(0, 2), 1);
  assert.equal(allocateBaleDraftId(1, 2), 2);
  assert.equal(allocateBaleDraftId(2, 2), 1);
});

test("Preview final text prefers pending text then last sent draft text", () => {
  assert.equal(
    buildBalePreviewFinalText({
      mode: "draft",
      pendingText: "  final  ",
      lastSentText: "old",
    }),
    "final",
  );
  assert.equal(
    buildBalePreviewFinalText({
      mode: "draft",
      pendingText: "   ",
      lastSentText: "  old  ",
    }),
    "old",
  );
  assert.equal(
    buildBalePreviewFinalText({
      mode: "draft",
      pendingText: "   ",
      lastSentText: "   ",
    }),
    undefined,
  );
});

test("Native Markdown draft prefix keeps only structurally closed Markdown", () => {
  assert.equal(
    getSafeBaleRichMarkdownDraftPrefix("**Bold** and *italic*", 100),
    "**Bold** and *italic*",
  );
  assert.equal(
    getSafeBaleRichMarkdownDraftPrefix("**Bold** and *ita", 100),
    "**Bold** and",
  );
  assert.equal(
    getSafeBaleRichMarkdownDraftPrefix("**Heading still streaming", 100),
    undefined,
  );
  assert.equal(
    getSafeBaleRichMarkdownDraftPrefix("Before\n\n```ts\nconst x = 1", 100),
    "Before",
  );
  assert.equal(
    getSafeBaleRichMarkdownDraftPrefix(
      "Before\n\n```ts\nconst x = 1\n```",
      100,
    ),
    "Before\n\n```ts\nconst x = 1\n```",
  );
  assert.equal(
    getSafeBaleRichMarkdownDraftPrefix(
      "[OpenAI](https://openai.com) and [half",
      100,
    ),
    "[OpenAI](https://openai.com) and",
  );
  assert.equal(
    getSafeBaleRichMarkdownDraftPrefix("Block math:\n\n$$\nx^2", 100),
    "Block math:",
  );
  assert.equal(
    getSafeBaleRichMarkdownDraftPrefix(
      "<!-- bale_button label=Ok",
      100,
    ),
    undefined,
  );
});

test("Preview runtime sends only safe native markdown draft prefixes", async () => {
  const { events, preview, start } = createPreviewHarness();
  start("**Bold** and *ita");
  await preview.flush(7);
  assert.deepEqual(events, ["draft:7:1:**Bold** and"]);
  assert.equal(preview.getState()?.lastSentText, "**Bold** and");
  assert.equal(preview.getState()?.draftId, 1);
});

test("Preview runtime sends draft previews into thread target", async () => {
  const sentOptions: unknown[] = [];
  const { preview, start } = createPreviewHarness({
    sendDraft: async (_chatId, _draftId, _text, options) => {
      sentOptions.push(options);
    },
  });
  start("thread draft");
  await preview.flush(7, { target: createBaleThreadTarget(7, 42) });
  assert.deepEqual(sentOptions, [{ message_thread_id: 42 }]);
});

test("Preview runtime clears thread drafts in thread target", async () => {
  const sentOptions: unknown[] = [];
  const { preview, start } = createPreviewHarness({
    sendDraft: async (_chatId, _draftId, _text, options) => {
      sentOptions.push(options);
    },
  });
  start("new draft");
  const target = createBaleThreadTarget(7, 42);
  await preview.flush(7, { target });
  await preview.clear(7, { target });
  assert.deepEqual(sentOptions, [
    { message_thread_id: 42 },
    { message_thread_id: 42 },
  ]);
});

test("Preview runtime does not send thinking placeholder for unsafe draft tails", async () => {
  const { events, preview, start } = createPreviewHarness();
  start("<!-- bale_button label=Ok");
  await preview.flush(7);
  assert.deepEqual(events, []);
  assert.equal(preview.getState()?.draftId, undefined);
  assert.equal(preview.getState()?.lastSentText, "");
});

test("Preview runtime skips unchanged unsafe draft tails", async () => {
  const { events, preview, start } = createPreviewHarness();
  start("**Bold** and");
  await preview.flush(7);
  preview.setPendingText("**Bold** and *ita");
  await preview.flush(7);
  assert.deepEqual(events, ["draft:7:1:**Bold** and"]);
});

test("Preview runtime records draft failures without plain fallback", async () => {
  const { events, preview, start } = createPreviewHarness({
    sendDraft: async () => {
      throw new Error("draft rejected partial markdown");
    },
  });
  start("abcdef");
  await preview.flush(7);
  assert.deepEqual(events, ["preview:draft"]);
  assert.equal(preview.getState()?.mode, "draft");
  assert.equal(preview.getState()?.lastSentText, "");
});

test("Preview runtime serializes overlapping flush requests", async () => {
  let releaseDraft: (() => void) | undefined;
  const events: string[] = [];
  const { preview, start } = createPreviewHarness({
    sendDraft: async (chatId, draftId, text) => {
      events.push(`draft:${chatId}:${draftId}:${text}`);
      if (!releaseDraft) {
        await new Promise<void>((resolve) => {
          releaseDraft = resolve;
        });
      }
    },
  });
  start("first");
  const firstFlush = preview.flush(7);
  await Promise.resolve();
  preview.setPendingText("second");
  const secondFlush = preview.flush(7);
  assert.equal(preview.isFlushing(), true);
  releaseDraft?.();
  await Promise.all([firstFlush, secondFlush]);
  assert.deepEqual(events, ["draft:7:1:first", "draft:7:1:second"]);
  assert.equal(preview.getState()?.lastSentText, "second");
  assert.equal(preview.isFlushing(), false);
});

test("Preview runtime clears active rich draft on explicit clear", async () => {
  const { events, preview, start } = createPreviewHarness();
  start("new draft");
  await preview.flush(7);
  await preview.clear(7);
  assert.deepEqual(events, ["draft:7:1:new draft", "draft:7:1:undefined"]);
  assert.equal(preview.getState(), undefined);
});

test("Preview runtime optional send gate clears without sending new content", async () => {
  const { events, preview, start } = createPreviewHarness({
    canSend: () => false,
  });
  start("**hello**");
  await preview.flush(7);
  assert.deepEqual(events, []);
  assert.equal(preview.getState(), undefined);
});

test("Draft throttle holds the first frame for one interval then sends the latest snapshot without debounce starvation", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 10_000 });
  const drafts: Array<{ text: string | undefined; at: number }> = [];
  const preview = createBaleAssistantPreviewRuntime<{ text: string }>({
    getActiveTurn: () => ({ chatId: 7 }), isAssistantMessage: () => true, getMessageText: (message) => message.text,
    sendDraft: async (_chat, _id, text) => { drafts.push({ text, at: Date.now() }); },
    sendMarkdownReply: async () => 100,
  });
  try {
    preview.resetState();
    await preview.onMessageUpdate({ message: { text: "First" } }); await preview.flush(7);
    await preview.onMessageUpdate({ message: { text: "Discarded intermediate" } }); await preview.flush(7);
    t.mock.timers.tick(1000);
    await preview.onMessageUpdate({ message: { text: "Latest" } }); await preview.flush(7);
    t.mock.timers.tick(999);
    assert.deepEqual(drafts, [], "The opening frame waits for the initial accumulation window");
    t.mock.timers.tick(1); await preview.flush(7);
    assert.deepEqual(drafts, [{ text: "Latest", at: 12_000 }]);
    await preview.onMessageUpdate({ message: { text: "Tail" } }); await preview.flush(7);
    t.mock.timers.tick(2000); await preview.flush(7);
    assert.deepEqual(drafts, [{ text: "Latest", at: 12_000 }, { text: "Tail", at: 14_000 }]);
  } finally { preview.invalidate(); }
});

test("Message rollover after a long tool gap reopens the opening draft window", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 10_000 });
  const drafts: Array<{ text: string; at: number }> = [];
  const preview = createBaleAssistantPreviewRuntime<{ text: string }>({
    getActiveTurn: () => ({ chatId: 7 }), isAssistantMessage: () => true, getMessageText: (message) => message.text,
    sendDraft: async (_chat, _id, text) => { drafts.push({ text: text!, at: Date.now() }); },
    sendMarkdownReply: async () => 100,
  });
  try {
    preview.resetState();
    await preview.onMessageUpdate({ message: { text: "First segment." } });
    t.mock.timers.tick(2000); await preview.flush(7);
    preview.seal();
    t.mock.timers.tick(30_000);
    await preview.onMessageStart({ message: { text: "" } });
    await preview.onMessageUpdate({ message: { text: "Continuation" } }); await preview.flush(7);
    assert.deepEqual(drafts, [{ text: "First segment.", at: 12_000 }], "A stale cadence boundary must not ship the continuation's first word");
    t.mock.timers.tick(2000); await preview.flush(7);
    assert.deepEqual(drafts, [
      { text: "First segment.", at: 12_000 },
      { text: "Continuation", at: 44_000 },
    ]);
  } finally { preview.invalidate(); }
});

test("Final publication cancels the draft throttle timer without waiting for its deadline", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 10_000 });
  const effects: string[] = [];
  const preview = createBaleAssistantPreviewRuntime<{ text: string }>({
    getActiveTurn: () => ({ chatId: 7 }), isAssistantMessage: () => true, getMessageText: (message) => message.text,
    sendDraft: async (_chat, _id, text) => { effects.push(`draft:${text}`); },
    sendMarkdownReply: async () => { effects.push("final"); return 100; },
  });
  try {
    preview.resetState();
    await preview.onMessageUpdate({ message: { text: "First" } }); await preview.flush(7);
    await preview.onMessageUpdate({ message: { text: "Queued tail" } }); await preview.flush(7);
    assert.equal(await preview.finalizeMarkdown(7, "Complete answer", 21), true);
    assert.equal(Date.now(), 10_000);
    t.mock.timers.tick(2000); await Promise.resolve();
    assert.deepEqual(effects, ["final"], "The held opening frame never shipped");
  } finally { preview.invalidate(); }
});

test("Replacing a throttled preview cancels old text and retains the interval with the new target", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 10_000 });
  let threadId = 42;
  const drafts: Array<{ text: string | undefined; thread: number | undefined }> = [];
  const preview = createBaleAssistantPreviewRuntime<{ text: string }>({
    getActiveTurn: () => ({ chatId: 7, target: { chatId: 7, threadId } }),
    isAssistantMessage: () => true, getMessageText: (message) => message.text,
    sendDraft: async (_chat, _id, text, options) => { drafts.push({ text, thread: options?.message_thread_id }); },
    sendMarkdownReply: async () => 100,
  });
  try {
    preview.resetState();
    await preview.onMessageUpdate({ message: { text: "First" } }); await preview.flush(7);
    t.mock.timers.tick(2000); await preview.flush(7);
    await preview.onMessageUpdate({ message: { text: "Obsolete" } }); await preview.flush(7);
    threadId = 43; preview.resetState();
    await preview.onMessageUpdate({ message: { text: "Replacement" } }); await preview.flush(7);
    t.mock.timers.tick(2000); await preview.flush(7);
    assert.deepEqual(drafts, [{ text: "First", thread: 42 }, { text: "Replacement", thread: 43 }]);
  } finally { preview.invalidate(); }
});

test("Slow draft requests remain single-flight and coalesce updates past the throttle deadline", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 10_000 });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const texts: string[] = [];
  const preview = createBaleAssistantPreviewRuntime<{ text: string }>({
    getActiveTurn: () => ({ chatId: 7 }), isAssistantMessage: () => true, getMessageText: (message) => message.text,
    sendDraft: async (_chat, _id, text) => { texts.push(text!); if (texts.length === 1) await gate; },
    sendMarkdownReply: async () => 100,
  });
  preview.resetState();
  await preview.onMessageUpdate({ message: { text: "First" } });
  try {
    t.mock.timers.tick(2000);
    assert.deepEqual(texts, ["First"]);
    t.mock.timers.tick(2500);
    await preview.onMessageUpdate({ message: { text: "Intermediate" } });
    await preview.onMessageUpdate({ message: { text: "Latest" } });
    assert.deepEqual(texts, ["First"]);
    release();
    await preview.flush(7);
    assert.deepEqual(texts, ["First", "Latest"]);
  } finally { release(); await preview.flush(7).catch(() => {}); preview.invalidate(); }
});

test("Sealed preview ignores late updates while a replacement preview can stream", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 10_000 });
  const drafts: string[] = [];
  const preview = createBaleAssistantPreviewRuntime<{ text: string }>({
    getActiveTurn: () => ({ chatId: 7, replyToMessageId: 55 }),
    isAssistantMessage: () => true,
    getMessageText: (message) => message.text,
    sendDraft: async (_chat, _id, text) => { if (text) drafts.push(text); },
    sendMarkdownReply: async () => { assert.fail("No permanent publication expected"); },
  });
  preview.resetState();
  await preview.onMessageUpdate({ message: { text: "First draft." } });
  t.mock.timers.tick(2000);
  await preview.flush(7);
  preview.seal();
  await preview.onMessageUpdate({ message: { text: "Obsolete late update." } });
  await preview.flush(7);
  assert.equal(preview.getState()?.pendingText, "First draft.");
  preview.resetState();
  await preview.onMessageUpdate({ message: { text: "Replacement draft." } });
  await preview.flush(7);
  t.mock.timers.tick(2000);
  await preview.flush(7);
  assert.deepEqual(drafts, ["First draft.", "Replacement draft."]);
  preview.invalidate();
});

test("Native Markdown finalizer drains only the issued draft and suppresses queued and late drafts", async () => {
  const events: string[] = [];
  const releases: Array<() => void> = [];
  let sends = 0;
  const preview = createBaleAssistantPreviewRuntime<{ text: string }>({
    getActiveTurn: () => ({ chatId: 7 }), isAssistantMessage: () => true,
    getMessageText: (message) => message.text, minDraftIntervalMs: 0,
    sendDraft: async (chatId, draftId, text) => {
      events.push(`draft-start:${chatId}:${draftId}:${text}`);
      if (++sends === 1) await new Promise<void>((resolve) => { releases.push(resolve); });
      events.push(`draft-finish:${chatId}:${draftId}:${text}`);
    },
    sendMarkdownReply: async (chatId, replyToMessageId, markdown) => {
      events.push(`final:${chatId}:${replyToMessageId ?? "none"}:${markdown}`);
      return 88;
    },
  });
  preview.resetState();
  preview.setPendingText("draft body");
  const flush = preview.flush(7);
  await Promise.resolve();
  preview.setPendingText("queued follow-up draft");
  const followUp = preview.flush(7);
  const finalize = preview.finalizeMarkdown(7, "final body", 55);
  const lateFlush = preview.flush(7);
  await Promise.resolve();
  assert.deepEqual(events, ["draft-start:7:1:draft body"]);
  releases.shift()?.();
  await Promise.all([flush, followUp, lateFlush, finalize]);
  assert.deepEqual(events, [
    "draft-start:7:1:draft body",
    "draft-finish:7:1:draft body",
    "final:7:55:final body",
  ]);
  assert.equal(preview.getState(), undefined);
});

test("A deferred draft does not consume its latest text snapshot", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 10_000 });
  const texts: string[] = [];
  const preview = createBaleAssistantPreviewRuntime<{ text: string }>({
    getActiveTurn: () => ({ chatId: 7 }), isAssistantMessage: () => true,
    getMessageText: (message) => message.text,
    sendDraft: async (_chat, _draft, text) => { texts.push(text!); return texts.length > 1; },
    sendMarkdownReply: async () => 100,
  });
  try {
    preview.resetState();
    preview.setPendingText("Latest snapshot");
    await preview.flush(7);
    assert.equal(preview.getState()?.lastSentText, "");
    t.mock.timers.tick(2000);
    await preview.flush(7);
    assert.equal(preview.getState()?.lastSentText, "Latest snapshot");
    assert.deepEqual(texts, ["Latest snapshot", "Latest snapshot"]);
  } finally { preview.invalidate(); }
});

test("Prepared final rechecks delivery authority after its original draft flush", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 10_000 });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let active = true;
  const effects: string[] = [];
  const preview = createBaleAssistantPreviewRuntime<{ text: string }>({
    getActiveTurn: () => ({ chatId: 7 }), isAssistantMessage: () => true,
    getMessageText: (message) => message.text,
    sendDraft: async () => { effects.push("draft"); await gate; },
    sendMarkdownReply: async () => { effects.push("final"); return 1; },
  });
  preview.resetState();
  await preview.onMessageUpdate({ message: { text: "Original draft." } });
  t.mock.timers.tick(2000);
  const original = preview.getState();
  const prepared = preview.prepareDelivery(() => active);
  const result = prepared.finalizeMarkdownPreview(7, "Final.", 21);
  try {
    active = false; release();
    assert.equal(await result, false);
    prepared.setPreviewPendingText("stale mutation");
    await prepared.clearPreview(7);
    assert.deepEqual(effects, ["draft"]);
    assert.equal(preview.getState()?.id, original?.id);
    assert.equal(original?.pendingText, "Original draft.");
  } finally { release(); await result; preview.invalidate(); }
});

test("Native Markdown finalizer stops when preview generation changes during flush", async () => {
  let release: (() => void) | undefined;
  let finalSends = 0;
  const preview = createBaleAssistantPreviewRuntime<{ text: string }>({
    getActiveTurn: () => ({ chatId: 7 }), isAssistantMessage: () => true,
    getMessageText: (message) => message.text, minDraftIntervalMs: 0,
    sendDraft: async () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    sendMarkdownReply: async () => {
      finalSends += 1;
      return 88;
    },
  });
  preview.resetState();
  preview.setPendingText("old draft");
  const flush = preview.flush(7);
  await Promise.resolve();
  const finalize = preview.finalizeMarkdown(7, "old final", 55);
  await Promise.resolve();
  preview.resetState();
  preview.setPendingText("new draft");
  const replacement = preview.getState();
  release?.();

  assert.equal(await finalize, false);
  await flush;
  assert.equal(finalSends, 0);
  assert.equal(preview.getState()?.id, replacement?.id);
  assert.equal(preview.getState()?.pendingText, "new draft");
});

test("Plain preview finalization does not send fallback messages", async () => {
  const { events, preview, start } = createPreviewHarness();
  start("final");
  await preview.flush(7);
  preview.setPendingText("final body");
  assert.equal(await preview.finalize(7), false);
  assert.deepEqual(events, ["draft:7:1:final", "draft:7:1:final body"]);
  assert.equal(preview.getState(), undefined);
});

test("Assistant preview rollover does not republish intermediate assistant text", async () => {
  const events: string[] = [];
  const runtime = createBaleAssistantPreviewRuntime<{
    role: string;
    text?: string;
  }>({
    getActiveTurn: () => ({
      chatId: 7,
      replyToMessageId: 24,
      target: createBaleThreadTarget(7, 42),
    }),
    isAssistantMessage: (message) => message.role === "assistant",
    getMessageText: (message) => message.text ?? "",
    maxMessageLength: 100,
    sendDraft: async () => {},
    sendMarkdownReply: async (chatId, replyToMessageId, markdown, options) => {
      events.push(
        `native-final:${chatId}:${replyToMessageId ?? "none"}:${markdown}:${
          options?.target?.threadId ?? "private"
        }`,
      );
      return 99;
    },
  });
  runtime.resetState();
  runtime.setPendingText("**previous**");
  await runtime.flush(7);
  await runtime.onMessageStart({ message: { role: "assistant" } });
  assert.deepEqual(events, []);
  assert.equal(runtime.getState()?.pendingText, "");
});

test("Preview rollover waits for admitted publication without holding the message-start hook", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 10_000 });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const drafts: string[] = [];
  const runtime = createBaleAssistantPreviewRuntime<{ text: string }>({
    getActiveTurn: () => ({ chatId: 7 }), isAssistantMessage: () => true,
    getMessageText: (message) => message.text,
    sendDraft: async (_chat, _id, text) => {
      drafts.push(text ?? "clear");
      if (drafts.length === 1) await gate;
    },
    sendMarkdownReply: async () => { assert.fail("Preview must not publish intermediate text"); },
  });
  runtime.resetState();
  await runtime.onMessageUpdate({ message: { text: "Old draft." } });
  const preparation = runtime.preparePublication()!;
  let started = false;
  const start = runtime.onMessageStart({ message: { text: "" } }).then(() => { started = true; });
  try {
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(started, true);
    await runtime.onMessageUpdate({ message: { text: "Next draft." } });
    assert.deepEqual(drafts, []);
    release();
    await preparation.wait();
    t.mock.timers.tick(2000);
    assert.deepEqual(drafts, [], "The sealed segment's held opening frame never ships and the next draft waits for the permanent publication");
    preparation.settle();
    await runtime.flush(7);
    assert.deepEqual(drafts, ["Next draft."]);
  } finally {
    release(); preparation.settle(); await start; await runtime.flush(7); runtime.invalidate();
  }
});

for (const replacement of ["rollover", "reset"] as const) {
  test(`Preview publication wait excludes later drafts after ${replacement}`, async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const drafts: string[] = [];
    const preview = createBaleAssistantPreviewRuntime<{ text: string }>({
      getActiveTurn: () => ({ chatId: 7 }),
      isAssistantMessage: () => true,
      getMessageText: (message) => message.text,
      minDraftIntervalMs: 0,
      sendDraft: async (_chat, _id, text) => {
        drafts.push(text!);
        if (drafts.length === 1) await gate;
      },
      sendMarkdownReply: async () => 1,
    });
    preview.resetState();
    preview.setPendingText("First draft");
    const first = preview.flush(7);
    const publication = preview.preparePublication()!;
    let resolved = false;
    const waiting = publication.wait().then(() => { resolved = true; });
    let second: Promise<void> | undefined;
    try {
      assert.deepEqual(drafts, ["First draft"]);
      if (replacement === "rollover")
        await preview.onMessageStart({ message: { text: "" } });
      else preview.resetState();
      preview.setPendingText("Later draft");
      second = preview.flush(7);
      if (replacement === "rollover") {
        assert.equal(resolved, false, "The preceding issued draft is still required");
        assert.deepEqual(drafts, ["First draft"], "The later draft waits for publication settlement");
      }
      release();
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(resolved, true, "Later pending work cannot extend an admitted publication's wait");
      if (replacement === "rollover") assert.deepEqual(drafts, ["First draft"]);
      publication.settle();
      await second;
      assert.deepEqual(drafts, ["First draft", "Later draft"]);
    } finally {
      release();
      publication.settle();
      await Promise.all([first, second, waiting]);
      preview.invalidate();
    }
  });
}

test("Preview publication wait includes earlier publications but excludes later ones", async () => {
  const { preview, start } = createPreviewHarness();
  start("Answer");
  const first = preview.preparePublication()!;
  const second = preview.preparePublication()!;
  let resolved = false;
  const waiting = second.wait().then(() => { resolved = true; });
  const later = preview.preparePublication()!;
  try {
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(resolved, false, "The second publication retains the first publication's boundary");
    first.settle();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(resolved, true, "A later publication cannot become a predecessor");
  } finally {
    first.settle();
    second.settle();
    later.settle();
    await waiting;
    preview.invalidate();
  }
});

for (const settlement of ["old-first", "new-first"] as const) {
  test(`Preview replacement isolates draft and publication dependencies with ${settlement} settlement`, async () => {
    const releases: Array<() => void> = [];
    const gates = [0, 1].map(() => new Promise<void>((resolve) => { releases.push(resolve); }));
    const drafts: string[] = [];
    const finals: string[] = [];
    const preview = createBaleAssistantPreviewRuntime<{ text: string }>({
      getActiveTurn: () => ({ chatId: 7 }),
      isAssistantMessage: () => true,
      getMessageText: (message) => message.text,
      minDraftIntervalMs: 0,
      sendDraft: async (_chat, _id, text) => {
        drafts.push(text!);
        await gates[drafts.length - 1];
      },
      sendMarkdownReply: async (_chat, _reply, markdown) => { finals.push(markdown); return 1; },
    });
    preview.resetState();
    preview.setPendingText("Old draft");
    const oldFlush = preview.flush(7);
    const oldPublication = preview.preparePublication()!;
    let newFlush: Promise<void> | undefined;
    let final: Promise<boolean> | undefined;
    try {
      preview.invalidate();
      preview.resetState();
      preview.setPendingText("Replacement draft");
      newFlush = preview.flush(7);
      assert.deepEqual(drafts, ["Old draft", "Replacement draft"], "A new generation does not inherit an old send or publication");
      final = preview.finalizeMarkdown(7, "Replacement answer");
      oldPublication.settle();
      if (settlement === "old-first") {
        releases[0]!();
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.equal(preview.isFlushing(), true, "An old settlement cannot clear the replacement's in-flight draft");
        assert.equal(preview.getState()?.lastSentText, "");
        assert.deepEqual(finals, []);
      }
      releases[1]!();
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.deepEqual(finals, ["Replacement answer"], "The replacement final waits only for its own generation");
      assert.equal(await final, true);
      assert.equal(preview.getState(), undefined);
    } finally {
      oldPublication.settle();
      for (const release of releases) release();
      await Promise.all([oldFlush, newFlush, final]);
      preview.invalidate();
    }
    assert.deepEqual(finals, ["Replacement answer"], "Late predecessor settlement cannot publish or mutate replacement work");
  });
}

for (const operation of ["final", "clear"] as const) {
  test(`Preview rollover carries issued draft authority into ${operation} without a new update`, async (t) => {
    t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 10_000 });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const effects: string[] = [];
    const runtime = createBaleAssistantPreviewRuntime<{ text: string }>({
      getActiveTurn: () => ({ chatId: 7 }), isAssistantMessage: () => true,
      getMessageText: (message) => message.text,
      sendDraft: async (_chat, _id, text) => { effects.push(text ? "draft" : "clear"); if (text) await gate; },
      sendMarkdownReply: async () => { effects.push("final"); return 1; },
    });
    runtime.resetState();
    await runtime.onMessageUpdate({ message: { text: "Old draft." } });
    t.mock.timers.tick(2000);
    await runtime.onMessageStart({ message: { text: "" } });
    const delivery = operation === "final" ? runtime.finalizeMarkdown(7, "Final.") : runtime.prepareClear(7)();
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.deepEqual(effects, ["draft"]);
      release(); await delivery;
      assert.deepEqual(effects, ["draft", operation]);
    } finally { release(); await delivery; runtime.invalidate(); }
  });
}

test("Assistant preview runtime suppresses text preview for voice-tagged turns", async () => {
  const events: string[] = [];
  const activeTurn = { chatId: 7, voiceReplyPreferred: true };
  const runtime = createBaleAssistantPreviewRuntime<{
    role: string;
    text?: string;
  }>({
    getActiveTurn: () => activeTurn,
    isAssistantMessage: (message) => message.role === "assistant",
    getMessageText: (message) => message.text ?? "",
    maxMessageLength: 100,
    sendDraft: async () => {
      events.push("draft");
    },
    sendMarkdownReply: async () => undefined,
  });
  await runtime.onMessageStart({ message: { role: "assistant" } });
  assert.equal(runtime.getState(), undefined);
  await runtime.onMessageUpdate({
    message: { role: "assistant", text: "hello" },
  });
  assert.equal(runtime.getState(), undefined);
  assert.deepEqual(events, []);
});

test("Assistant preview runtime suppresses text preview for guest turns", async () => {
  const events: string[] = [];
  const activeTurn = { chatId: 0, guestQueryId: "guest-1" };
  const runtime = createBaleAssistantPreviewRuntime<{
    role: string;
    text?: string;
  }>({
    getActiveTurn: () => activeTurn,
    isAssistantMessage: (message) => message.role === "assistant",
    getMessageText: (message) => message.text ?? "",
    maxMessageLength: 100,
    sendDraft: async () => {
      events.push("draft");
    },
    sendMarkdownReply: async () => undefined,
  });
  await runtime.onMessageStart({ message: { role: "assistant" } });
  assert.equal(runtime.getState(), undefined);
  await runtime.onMessageUpdate({
    message: { role: "assistant", text: "hello" },
  });
  assert.equal(runtime.getState(), undefined);
  assert.deepEqual(events, []);
  assert.equal(shouldSuppressPreviewForGuestTurn(activeTurn), true);
  assert.equal(shouldSuppressPreviewForGuestTurn({ guestQueryId: "" }), false);
  assert.equal(shouldSuppressPreviewForGuestTurn(null), false);
  assert.equal(shouldSuppressPreviewForGuestTurn(undefined), false);
});

test("Preview controller runtime binds Bot API draft transport", async () => {
  const events: string[] = [];
  const runtime = createBalePreviewController({
    sendDraft: async (chatId, draftId, text) => {
      events.push(`draft:${chatId}:${draftId}:${text}`);
    },
    maxDraftId: 10,
  });
  runtime.resetState();
  runtime.setPendingText("hello".repeat(60));
  await runtime.flush(7);
  assert.deepEqual(events, [`draft:7:1:${"hello".repeat(60)}`]);
});

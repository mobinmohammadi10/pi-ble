/**
 * Regression tests for Bale media and text extraction helpers
 * Covers inbound file-info collection, text extraction, media groups, id collection, and history formatting
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  collectBaleFileInfos,
  collectBaleMessageIds,
  createBaleMediaGroupController,
  createBalePendingGroupsState,
  transitionBalePendingGroups,
  type BalePendingGroupsEffect,
  type BalePendingGroupsEvent,
  createBaleMediaGroupDispatchRuntime,
  downloadBaleMessageFiles,
  extractFirstBaleMessageText,
  extractBaleMessagesPromptText,
  extractBaleMessagesText,
  formatBaleHistoryText,
  getBaleMediaGroupKey,
  guessMediaType,
} from "../lib/media.ts";

type TestTimer = ReturnType<typeof setTimeout>;

function createTestTimer(id: number): TestTimer {
  return id as unknown as TestTimer;
}

function getTestTimerId(timer: TestTimer): number {
  return timer as unknown as number;
}

test("Media helpers collect file infos across Bale message variants", () => {
  const files = collectBaleFileInfos([
    {
      message_id: 1,
      text: "hello",
      photo: [
        { file_id: "small", file_size: 1 },
        { file_id: "large", file_size: 10 },
      ],
      document: {
        file_id: "doc",
        file_name: "report.png",
        mime_type: "image/png",
      },
      voice: {
        file_id: "voice",
        mime_type: "audio/ogg",
      },
      sticker: {
        file_id: "sticker",
      },
    },
  ]);
  assert.deepEqual(
    files.map((file) => ({
      id: file.file_id,
      name: file.fileName,
      image: file.isImage,
    })),
    [
      { id: "large", name: "photo-1.jpg", image: true },
      { id: "doc", name: "report.png", image: true },
      { id: "voice", name: "voice-1.ogg", image: false },
      { id: "sticker", name: "sticker-1.webp", image: true },
    ],
  );
});

for (const [flags, extension, mimeType, isImage] of [
  [{}, ".webp", "image/webp", true],
  [{ is_video: false, is_animated: false }, ".webp", "image/webp", true],
  [{ is_video: true }, ".webm", "video/webm", false],
  [{ is_animated: true }, ".tgs", "application/x-tgsticker", false],
  [{ is_video: true, is_animated: true }, ".webm", "video/webm", false],
] as const) {
  test(`Sticker format flags preserve non-image attachments: ${JSON.stringify(flags)}`, async () => {
    const messages = [{ message_id: 5, sticker: { file_id: "sticker", ...flags } }];
    const fileName = `sticker-5${extension}`;
    assert.deepEqual(collectBaleFileInfos(messages), [{ file_id: "sticker", fileName, mimeType, kind: "sticker", isImage, source: { kind: "sticker", messageId: 5 } }]);
    const files = await downloadBaleMessageFiles(messages, { async downloadFile(id, name) {
      assert.equal(id, "sticker"); assert.equal(name, fileName); return `/tmp/${name}`;
    } });
    assert.deepEqual(files, [{ path: `/tmp/${fileName}`, fileName, mimeType, kind: "sticker", isImage }]);
  });
}

test("Media helpers collect embedded Rich Message media", () => {
  const files = collectBaleFileInfos([
    {
      message_id: 2,
      rich_message: {
        blocks: [
          { type: "paragraph", text: "caption" },
          {
            type: "photo",
            photo: [
              { file_id: "rich-small", file_size: 1 },
              { file_id: "rich-large", file_size: 10 },
            ],
          },
          {
            type: "details",
            blocks: [
              {
                type: "voice_note",
                voice_note: {
                  file_id: "rich-voice",
                  mime_type: "audio/ogg",
                },
              },
            ],
          },
        ],
      },
    },
  ]);
  assert.deepEqual(files, [
    {
      file_id: "rich-large",
      fileName: "photo-2-1.jpg",
      index: 1,
      source: { kind: "photo", messageId: 2, index: 1 },
      mimeType: "image/jpeg",
      kind: "photo",
      isImage: true,
    },
    {
      file_id: "rich-voice",
      fileName: "voice-2-2.ogg",
      index: 2,
      source: { kind: "voice", messageId: 2, index: 2 },
      mimeType: "audio/ogg",
      kind: "voice",
      isImage: false,
    },
  ]);
});

test("Media downloads forward the message source, chat and sender file name", async () => {
  const seen: unknown[] = [];
  await downloadBaleMessageFiles([
    { message_id: 3, chat: { id: -1009, type: "supergroup", username: "team" }, document: { file_id: "d", file_name: "report.pdf", mime_type: "application/pdf" } },
    { message_id: 4, chat: { id: 7, type: "private" }, voice: { file_id: "v", mime_type: "audio/ogg" } },
  ], { async downloadFile(_id, name, source) { seen.push({ name, source }); return `/tmp/${name}`; } });
  assert.deepEqual(seen, [
    { name: "report.pdf", source: { kind: "document", messageId: 3, userFileName: "report.pdf", chat: { id: -1009, type: "supergroup", username: "team" } } },
    { name: "voice-4.ogg", source: { kind: "voice", messageId: 4, chat: { id: 7, type: "private" } } },
  ]);
});

test("Media helpers download collected file infos", async () => {
  const downloaded = await downloadBaleMessageFiles(
    [
      {
        message_id: 3,
        document: {
          file_id: "doc-id",
          file_name: "report.pdf",
          mime_type: "application/pdf",
        },
      },
    ],
    {
      downloadFile: async (fileId, fileName) => `/tmp/${fileId}-${fileName}`,
    },
  );
  assert.deepEqual(downloaded, [
    {
      path: "/tmp/doc-id-report.pdf",
      fileName: "report.pdf",
      isImage: false,
      mimeType: "application/pdf",
      kind: "document",
    },
  ]);
});

test("Media helpers extract text, ids, and history summaries", () => {
  const messages = [
    { message_id: 1, text: "first" },
    { message_id: 2, caption: "second" },
    { message_id: 2, text: "duplicate id" },
  ];
  assert.equal(
    extractBaleMessagesText(messages),
    "first\n\nsecond\n\nduplicate id",
  );
  assert.equal(extractFirstBaleMessageText(messages), "first");
  assert.deepEqual(collectBaleMessageIds(messages), [1, 2]);
  assert.equal(
    formatBaleHistoryText(
      "hello",
      [{ path: "/tmp/demo.txt" }],
      ["transcript"],
    ),
    "hello\n\n[attachments] /tmp\n- /demo.txt\n\n[outputs]\n- transcript",
  );
});

test("Media helpers keep raw text command-safe and add reply context only for prompts", () => {
  const repliedCommand = {
    message_id: 1,
    text: "/status",
    reply_to_message: { text: "quoted context" },
  };
  const captionReply = {
    message_id: 2,
    caption: "caption reply",
    reply_to_message: { caption: "quoted caption" },
  };
  assert.equal(extractFirstBaleMessageText([repliedCommand]), "/status");
  assert.equal(extractBaleMessagesText([repliedCommand]), "/status");
  assert.equal(
    extractBaleMessagesPromptText([repliedCommand]),
    "/status\n\n[reply] quoted context",
  );
  assert.equal(
    extractBaleMessagesPromptText([captionReply]),
    "caption reply\n\n[reply] quoted caption",
  );
});

test("Media helpers prefer rich-message text for reply context", () => {
  const message = {
    message_id: 1,
    text: "current",
    reply_to_message: {
      text: "## Raw **Markdown** fallback",
      rich_message: {
        blocks: [
          { type: "heading", text: "Rendered heading", size: 2 },
          {
            type: "paragraph",
            text: ["Plain ", { type: "bold", text: "reply" }, " text"],
          },
          {
            type: "list",
            items: [
              {
                label: "1.",
                blocks: [{ type: "paragraph", text: "First item" }],
              },
            ],
          },
        ],
      },
    },
  };
  assert.equal(
    extractBaleMessagesPromptText([message]),
    "current\n\n[reply] Rendered heading\n\nPlain reply text\n\n1. First item",
  );
});

test("Media helpers truncate long reply context for prompt text", () => {
  const longQuote = `${"a".repeat(1000)} extra`;
  assert.equal(
    extractBaleMessagesPromptText([
      {
        message_id: 1,
        text: "current",
        reply_to_message: { text: longQuote },
      },
    ]),
    `current\n\n[reply] ${"a".repeat(1000)}…`,
  );
});

test("Media helpers infer image media types from file paths", () => {
  assert.equal(guessMediaType("/tmp/demo.png"), "image/png");
  assert.equal(guessMediaType("/tmp/demo.txt"), undefined);
});

test("Media helpers key messages by chat and media group", () => {
  assert.equal(
    getBaleMediaGroupKey({
      message_id: 1,
      chat: { id: 7 },
      media_group_id: "album",
    }),
    "7:private:album",
  );
  assert.equal(
    getBaleMediaGroupKey({
      message_id: 1,
      chat: { id: 7 },
      message_thread_id: 42,
      media_group_id: "album",
    }),
    "7:thread:42:album",
  );
  assert.equal(
    getBaleMediaGroupKey({ message_id: 1, chat: { id: 7 } }),
    undefined,
  );
});

test("Media helpers replace debounce timers and dispatch grouped messages", async () => {
  type AlbumMessage = {
    message_id: number;
    chat: { id: number };
    media_group_id?: string;
    marker?: string;
  };
  const cleared: number[] = [];
  const callbacks: Array<() => void> = [];
  const dispatched: AlbumMessage[][] = [];
  let nextTimer = 1;
  const controller = createBaleMediaGroupController<AlbumMessage>({
    debounceMs: 100,
    setTimer: (callback) => {
      callbacks.push(callback);
      return createTestTimer(nextTimer++);
    },
    clearTimer: (timer) => cleared.push(getTestTimerId(timer)),
  });
  const dispatchMessages = (messages: AlbumMessage[]) => {
    dispatched.push(messages);
  };
  assert.equal(
    controller.queueMessage({
      message: { message_id: 1, chat: { id: 7 }, media_group_id: "album" },
      dispatchMessages,
    }),
    true,
  );
  controller.queueMessage({
    message: { message_id: 2, chat: { id: 7 }, media_group_id: "album" },
    dispatchMessages,
  });
  controller.queueMessage({
    message: { message_id: 2, chat: { id: 7 }, media_group_id: "album", marker: "rebound" },
    dispatchMessages,
  });
  assert.deepEqual(cleared, [1, 2]);
  callbacks.at(-1)?.();
  await Promise.resolve();
  assert.deepEqual(dispatched.map((messages) => messages.map((message) => message.message_id)), [[1, 2]]);
  assert.equal(dispatched[0]?.[1]?.marker, "rebound", "A duplicate id replaces the message in place");
  await Promise.resolve();
  assert.equal(await controller.flushMessage(1), false, "A dispatched group is gone");
});

test("Media group keeps messages until asynchronous dispatch succeeds", async () => {
  const callbacks: Array<() => void> = [];
  let attempts = 0;
  const controller = createBaleMediaGroupController<{
    message_id: number;
    chat: { id: number };
    media_group_id?: string;
  }>({
    debounceMs: 10,
    setTimer: (callback) => {
      callbacks.push(callback);
      return createTestTimer(callbacks.length);
    },
    clearTimer: () => {},
  });
  controller.queueMessage({
    message: { message_id: 1, chat: { id: 7 }, media_group_id: "album" },
    dispatchMessages: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("queue admission failed");
    },
  });

  callbacks[0]?.();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(callbacks.length, 2, "A failed batch stays and re-arms its debounce");
  callbacks[1]?.();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(attempts, 2);
  assert.equal(await controller.flushMessage(1), false, "The group leaves only after a successful dispatch");
});

test("Media group recovers from a dispatcher that throws synchronously", async () => {
  const callbacks: Array<() => void> = [];
  let attempts = 0;
  const controller = createBaleMediaGroupController<{
    message_id: number;
    chat: { id: number };
    media_group_id?: string;
  }>({
    debounceMs: 10,
    setTimer: (callback) => {
      callbacks.push(callback);
      return createTestTimer(callbacks.length);
    },
    clearTimer: () => {},
  });
  controller.queueMessage({
    message: { message_id: 1, chat: { id: 7 }, media_group_id: "album" },
    dispatchMessages: () => {
      attempts += 1;
      if (attempts === 1) throw new Error("synchronous admission failure");
    },
  });
  assert.doesNotThrow(() => callbacks[0]?.(), "A timer callback never leaks the dispatcher's exception");
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(callbacks.length, 2, "The group is not stuck dispatching; it retries");
  callbacks[1]?.();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(attempts, 2);
});

test("Media group controller owns timers, removal, and cleanup", () => {
  const cleared: number[] = [];
  const callbacks: Array<() => void> = [];
  const dispatched: number[][] = [];
  let nextTimer = 1;
  const controller = createBaleMediaGroupController<{
    message_id: number;
    chat: { id: number };
    media_group_id?: string;
  }>({
    debounceMs: 100,
    setTimer: (callback) => {
      callbacks.push(callback);
      return createTestTimer(nextTimer++);
    },
    clearTimer: (timer) => {
      cleared.push(getTestTimerId(timer));
    },
  });
  assert.equal(
    controller.queueMessage({
      message: { message_id: 1, chat: { id: 7 }, media_group_id: "album" },
      dispatchMessages: (messages) =>
        dispatched.push(messages.map((message) => message.message_id)),
    }),
    true,
  );
  controller.queueMessage({
    message: { message_id: 2, chat: { id: 7 }, media_group_id: "album" },
    dispatchMessages: (messages) =>
      dispatched.push(messages.map((message) => message.message_id)),
  });
  assert.deepEqual(cleared, [1]);
  assert.equal(controller.removeMessages([2]), 1);
  assert.deepEqual(cleared, [1, 2]);
  callbacks.at(-1)?.();
  assert.equal(dispatched.length, 0);
  controller.queueMessage({
    message: { message_id: 3, chat: { id: 7 }, media_group_id: "album" },
    dispatchMessages: (messages) =>
      dispatched.push(messages.map((message) => message.message_id)),
  });
  controller.clear();
  assert.deepEqual(cleared, [1, 2, 3]);
});

test("Media group controller flushes a reaction target before debounce", async () => {
  const cleared: number[] = [];
  const dispatched: number[][] = [];
  let nextTimer = 1;
  const controller = createBaleMediaGroupController<{
    message_id: number;
    chat: { id: number };
    media_group_id?: string;
  }>({
    debounceMs: 100,
    setTimer: () => createTestTimer(nextTimer++),
    clearTimer: (timer) => cleared.push(getTestTimerId(timer)),
  });
  controller.queueMessage({
    message: { message_id: 1, chat: { id: 7 }, media_group_id: "album" },
    dispatchMessages: (messages) => {
      dispatched.push(messages.map((message) => message.message_id));
    },
  });
  controller.queueMessage({
    message: { message_id: 2, chat: { id: 7 }, media_group_id: "album" },
    dispatchMessages: (messages) => {
      dispatched.push(messages.map((message) => message.message_id));
    },
  });

  assert.equal(await controller.flushMessage(2), true);
  assert.deepEqual(cleared, [1, 2]);
  assert.deepEqual(dispatched, [[1, 2]]);
  assert.equal(await controller.flushMessage(2), false);
});

test("Media group suspension preserves admitted messages for replacement context", async () => {
  const callbacks: Array<() => void> = [];
  const cleared: number[] = [];
  const dispatched: Array<{ ids: number[]; ctx?: string }> = [];
  let nextTimer = 1;
  const controller = createBaleMediaGroupController<
    { message_id: number; chat: { id: number }; media_group_id?: string },
    string
  >({
    debounceMs: 100,
    setTimer: (callback) => {
      callbacks.push(callback);
      return createTestTimer(nextTimer++);
    },
    clearTimer: (timer) => cleared.push(getTestTimerId(timer)),
  });
  controller.queueMessage({
    message: { message_id: 1, chat: { id: 7 }, media_group_id: "album" },
    context: "old-session",
    dispatchMessages: (messages, ctx) =>
      dispatched.push({
        ids: messages.map((message) => message.message_id),
        ctx,
      }),
  });

  controller.suspend();
  controller.resume("new-session");
  callbacks[1]?.();
  await Promise.resolve();

  assert.deepEqual(cleared, [1]);
  assert.deepEqual(dispatched, [{ ids: [1], ctx: "new-session" }]);
});

test("Media group dispatch runtime handles immediate and grouped messages", async () => {
  const callbacks: Array<() => void> = [];
  const dispatched: Array<{ ids: number[]; ctx: string }> = [];
  const controller = createBaleMediaGroupController<
    {
      message_id: number;
      chat: { id: number };
      media_group_id?: string;
    },
    string
  >({
    setTimer: (callback) => {
      callbacks.push(callback);
      return createTestTimer(callbacks.length);
    },
    clearTimer: () => {},
  });
  const runtime = createBaleMediaGroupDispatchRuntime({
    mediaGroups: controller,
    dispatchMessages: async (messages, ctx: string) => {
      dispatched.push({
        ids: messages.map((message) => message.message_id),
        ctx,
      });
    },
  });
  await runtime.handleMessage({ message_id: 1, chat: { id: 7 } }, "ctx-a");
  await runtime.handleMessage(
    { message_id: 2, chat: { id: 7 }, media_group_id: "album" },
    "ctx-b",
  );
  await runtime.handleMessage(
    { message_id: 3, chat: { id: 7 }, media_group_id: "album" },
    "ctx-b",
  );
  callbacks.at(-1)?.();
  assert.deepEqual(dispatched, [
    { ids: [1], ctx: "ctx-a" },
    { ids: [2, 3], ctx: "ctx-b" },
  ]);
});

test("Media helpers remove pending groups by message id", () => {
  const cleared: number[] = [];
  let nextTimer = 10;
  const controller = createBaleMediaGroupController<{
    message_id: number;
    chat: { id: number };
    media_group_id?: string;
  }>({
    setTimer: () => createTestTimer(nextTimer++),
    clearTimer: (timer) => cleared.push(getTestTimerId(timer)),
  });
  controller.queueMessage({ message: { message_id: 1, chat: { id: 7 }, media_group_id: "album" }, dispatchMessages: () => {} });
  controller.queueMessage({ message: { message_id: 2, chat: { id: 7 }, media_group_id: "album" }, dispatchMessages: () => {} });
  assert.equal(controller.removeMessages([2]), 1);
  assert.deepEqual(cleared, [10, 11]);
  assert.equal(controller.removeMessages([1]), 0);
});

type GroupMessage = { message_id: number };
type GroupEvent = BalePendingGroupsEvent<GroupMessage, string, undefined>;
type GroupEffect = BalePendingGroupsEffect<GroupMessage, string>;

/** Folds events through the pure group transition, keeping every effect in order. */
function runPendingGroups(events: GroupEvent[], requireContext = true) {
  let state = createBalePendingGroupsState<GroupMessage, string>();
  const effects: GroupEffect[] = [];
  for (const event of events) {
    const next = transitionBalePendingGroups(state, event, { debounceMs: 10, requireContext });
    state = next.state;
    effects.push(...next.effects);
  }
  return { state, effects };
}

const queuedMessage = (id: number, rearm: "always" | "ifIdle" = "always", context: string | null = "ctx"): GroupEvent => ({
  type: "queued", key: "k", message: { message_id: id }, ...(context === null ? {} : { context }), delayMs: 10, rearm,
});
const batches = (effects: GroupEffect[]) =>
  effects.flatMap((effect) => (effect.type === "dispatch" ? [effect.messages.map((message) => message.message_id)] : []));

test("Pending groups dispatch one batch at a time and keep later messages for the next", () => {
  const run = runPendingGroups([
    queuedMessage(1),
    { type: "timerFired", key: "k", timerId: 1 },
    queuedMessage(2),
    { type: "timerFired", key: "k", timerId: 2 },
    { type: "dispatchSettled", key: "k", dispatchId: 1, ok: true },
  ]);
  assert.deepEqual(batches(run.effects), [[1]], "A timer during a dispatch waits for it");
  assert.deepEqual(run.state.groups.get("k")?.messages, [{ message_id: 2 }]);
  assert.deepEqual(run.effects.at(-1), { type: "armTimer", key: "k", timerId: 3, delayMs: 10 },
    "Settlement re-arms for what is left");
});

test("Pending groups end a closed batch at its message, even while an earlier batch is in flight", () => {
  const run = runPendingGroups([
    queuedMessage(1),
    { type: "timerFired", key: "k", timerId: 1 },
    queuedMessage(2),
    { type: "batchClosed", key: "k" },
    queuedMessage(3),
    { type: "dispatchSettled", key: "k", dispatchId: 1, ok: true },
    { type: "timerFired", key: "k", timerId: 3 },
    { type: "dispatchSettled", key: "k", dispatchId: 2, ok: true },
    { type: "timerFired", key: "k", timerId: 4 },
  ]);
  assert.deepEqual(batches(run.effects), [[1], [2], [3]],
    "A count-based limit taken during the first batch would have sent [2, 3] together");
});

test("Pending groups keep a failed batch, ignore stale timers and settlements, and drop removed groups", () => {
  const failed = runPendingGroups([
    queuedMessage(1),
    { type: "timerFired", key: "k", timerId: 1 },
    { type: "dispatchSettled", key: "k", dispatchId: 1, ok: false },
  ]);
  assert.deepEqual(failed.state.groups.get("k")?.messages, [{ message_id: 1 }]);
  assert.equal(failed.state.groups.get("k")?.timerId, 2);
  const stale = runPendingGroups([
    queuedMessage(1), queuedMessage(2),
    { type: "timerFired", key: "k", timerId: 1 },
    { type: "cleared" },
    { type: "dispatchSettled", key: "k", dispatchId: 1, ok: true },
  ]);
  assert.deepEqual(batches(stale.effects), [], "A replaced timer cannot dispatch");
  assert.equal(stale.state.groups.size, 0);
  const removed = transitionBalePendingGroups(
    runPendingGroups([queuedMessage(1)]).state,
    { type: "removed", messageIds: [1] },
    { debounceMs: 10, requireContext: true },
  );
  assert.equal(removed.result, 1);
  assert.deepEqual(removed.effects, [{ type: "cancelTimer", timerId: 1 }]);
});

test("Pending groups hold timers while suspended and resume in the replacement context", () => {
  const run = runPendingGroups([
    queuedMessage(1),
    { type: "suspended" },
    queuedMessage(2),
    { type: "resumed", context: "next" },
    { type: "timerFired", key: "k", timerId: 2 },
  ]);
  assert.deepEqual(run.effects.slice(0, 2), [
    { type: "armTimer", key: "k", timerId: 1, delayMs: 10 },
    { type: "cancelTimer", timerId: 1 },
  ]);
  const dispatched = run.effects.at(-1);
  assert.equal(dispatched?.type, "dispatch");
  assert.equal(dispatched?.type === "dispatch" ? dispatched.context : undefined, "next");
});

test("Pending groups re-arm a duplicate only when idle and wait without a required context", () => {
  const held = runPendingGroups([queuedMessage(1), queuedMessage(1, "ifIdle")]);
  assert.equal(held.effects.length, 1, "An armed timer already covers the duplicate");
  const contextless = runPendingGroups([queuedMessage(1, "always", null), { type: "timerFired", key: "k", timerId: 1 }]);
  assert.deepEqual(batches(contextless.effects), [], "Text waits for a context");
  const media = runPendingGroups([queuedMessage(1, "always", null), { type: "timerFired", key: "k", timerId: 1 }], false);
  assert.deepEqual(batches(media.effects), [[1]], "Media dispatches without one");
});

/**
 * Tests for the voice domain.
 * Covers policy resolution, turn tagging, suppression helpers, the provider registry,
 * and voice-specific markup parsing.
 */

import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";

import {
  clearBaleVoiceTranscriptionProviders,
  computeVoiceTurnFlags,
  getBaleVoiceReplyMode,
  getBaleVoiceTranscriptionProviders,
  isVoiceTurn,
  registerBaleVoiceTranscriptionProvider,
  shouldSuppressPreviewForVoice,
  BALE_VOICE_REPLY_MODES,
} from "../lib/voice.ts";

import {
  clearBaleVoiceSynthesisProviders,
  getBaleVoiceSynthesisProviders,
  hasBaleVoiceSynthesisProvider,
  registerBaleVoiceSynthesisProvider,
} from "../lib/outbound.ts";
import {
  planBaleVoiceReply,
  stripBaleCommentMarkupForPreview,
} from "../lib/outbound-markup.ts";

// --- Test Setup ---

beforeEach(() => {
  clearBaleVoiceSynthesisProviders();
  clearBaleVoiceTranscriptionProviders();
});

afterEach(() => {
  clearBaleVoiceSynthesisProviders();
  clearBaleVoiceTranscriptionProviders();
});

// --- Policy Resolution ---

test("voice reply modes expose only manual, mirror, and always", () => {
  assert.deepEqual(BALE_VOICE_REPLY_MODES, ["manual", "mirror", "always"]);
});

test("getBaleVoiceReplyMode returns 'manual' by default", () => {
  assert.equal(getBaleVoiceReplyMode(), "manual");
  assert.equal(getBaleVoiceReplyMode(undefined), "manual");
  assert.equal(getBaleVoiceReplyMode({}), "manual");
  assert.equal(getBaleVoiceReplyMode({ voice: {} }), "manual");
});

test("getBaleVoiceReplyMode reads current modes and legacy hidden", () => {
  assert.equal(
    getBaleVoiceReplyMode({ voice: { replyMode: "mirror" } }),
    "mirror",
  );
  assert.equal(
    getBaleVoiceReplyMode({ voice: { replyMode: "always" } }),
    "always",
  );
  assert.equal(
    getBaleVoiceReplyMode({ voice: { replyMode: "hidden" } }),
    "manual",
  );
  assert.equal(
    getBaleVoiceReplyMode({ voice: { replyMode: "manual" } }),
    "manual",
  );
});

test("getBaleVoiceReplyMode ignores invalid config values", () => {
  assert.equal(
    getBaleVoiceReplyMode({ voice: { replyMode: "invalid" as any } }),
    "manual",
  );
  assert.equal(
    getBaleVoiceReplyMode({ voice: { replyMode: "foo" as any } }),
    "manual",
  );
});

test("getBaleVoiceReplyMode ignores provider policy without config", () => {
  registerBaleVoiceSynthesisProvider(
    {
      getVoicePolicy: () => ({ replyMode: "always" }),
    } as any,
    { id: "test-provider-1" },
  );

  assert.equal(getBaleVoiceReplyMode({}), "manual");
});

test("getBaleVoiceReplyMode reads config even when provider returns invalid policy", () => {
  registerBaleVoiceSynthesisProvider(
    {
      getVoicePolicy: () => ({ replyMode: "invalid" as any }),
    } as any,
    { id: "bad-provider" },
  );

  const result = getBaleVoiceReplyMode({ voice: { replyMode: "mirror" } });
  assert.equal(result, "mirror");
});

test("getBaleVoiceReplyMode defaults to manual despite provider policies", () => {
  registerBaleVoiceSynthesisProvider(
    {
      getVoicePolicy: () => ({ replyMode: "mirror" }),
    } as any,
    { id: "mirror-provider" },
  );
  registerBaleVoiceSynthesisProvider(
    {
      getVoicePolicy: () => ({ replyMode: "always" }),
    } as any,
    { id: "always-provider" },
  );

  assert.equal(getBaleVoiceReplyMode(), "manual");
});

// --- Turn Tagging Helpers ---

test("computeVoiceTurnFlags works for all modes", () => {
  assert.deepEqual(computeVoiceTurnFlags("mirror", true), {
    voiceReplyPreferred: true,
    voiceReplyRequired: false,
  });

  assert.deepEqual(computeVoiceTurnFlags("mirror", false), {
    voiceReplyPreferred: false,
    voiceReplyRequired: false,
  });

  assert.deepEqual(computeVoiceTurnFlags("always", false), {
    voiceReplyPreferred: false,
    voiceReplyRequired: true,
  });

  assert.deepEqual(computeVoiceTurnFlags("manual", true), {
    voiceReplyPreferred: false,
    voiceReplyRequired: false,
  });
});

test("isVoiceTurn detects voice-tagged turns correctly", () => {
  assert.equal(isVoiceTurn({ voiceReplyPreferred: true }), true);
  assert.equal(isVoiceTurn({ voiceReplyRequired: true }), true);
  assert.equal(
    isVoiceTurn({ voiceReplyPreferred: true, voiceReplyRequired: true }),
    true,
  );
  assert.equal(
    isVoiceTurn({ voiceReplyPreferred: false, voiceReplyRequired: false }),
    false,
  );
  assert.equal(isVoiceTurn(null), false);
  assert.equal(isVoiceTurn(undefined), false);
  assert.equal(isVoiceTurn({}), false);
});

// --- Preview Suppression ---

test("shouldSuppressPreviewForVoice works correctly", () => {
  assert.equal(
    shouldSuppressPreviewForVoice({ voiceReplyPreferred: true }),
    true,
  );
  assert.equal(
    shouldSuppressPreviewForVoice({ voiceReplyRequired: true }),
    true,
  );
  assert.equal(
    shouldSuppressPreviewForVoice({
      voiceReplyPreferred: false,
      voiceReplyRequired: false,
    }),
    false,
  );
  assert.equal(shouldSuppressPreviewForVoice(null), false);
  assert.equal(shouldSuppressPreviewForVoice(undefined), false);
});

// --- Voice Markup Parsing ---

test("planBaleVoiceReply extracts simple voice text", () => {
  const result = planBaleVoiceReply(
    'Hello\n\n<!-- bale_voice {"text":"World"} -->',
  );
  assert.equal(result.voiceText, "World");
  assert.ok(result.voiceReplies?.length === 1);
});

test("planBaleVoiceReply extracts lang and rate attributes", () => {
  const result = planBaleVoiceReply(
    'Say\n\n<!-- bale_voice text="Hallo" lang="de" rate="1.2" -->',
  );
  assert.equal(result.lang, "de");
  assert.equal(result.rate, "1.2");
  assert.equal(result.voiceText, "Hallo");
});

test("planBaleVoiceReply handles JSON payloads", () => {
  const result = planBaleVoiceReply(
    'Text\n\n<!-- bale_voice {"text":"This is the voice text"} -->',
  );
  assert.equal(result.voiceText, "This is the voice text");
  assert.ok(result.voiceReplies?.length === 1);
});

test("planBaleVoiceReply handles multiple voice blocks", () => {
  const result = planBaleVoiceReply(
    'First\n\n<!-- bale_voice {"text":"One"} -->\n\nand second\n\n<!-- bale_voice {"text":"Two"} -->',
  );
  assert.equal(result.voiceReplies?.length, 2);
  assert.equal(result.voiceText, "One\n\nTwo");
  assert.ok(result.markdown.includes("First"));
  assert.ok(result.markdown.includes("and second"));
  assert.ok(!result.markdown.includes("bale_voice"));
});

test("planBaleVoiceReply returns cleaned markdown", () => {
  const result = planBaleVoiceReply(
    'Normal\n\n<!-- bale_voice {"text":"Voice only"} -->\n\ntext',
  );
  assert.ok(result.markdown.includes("Normal"));
  assert.ok(result.markdown.includes("text"));
  assert.equal(result.voiceText, "Voice only");
  assert.ok(!result.markdown.includes("bale_voice"));
});

// --- Voice Provider Registry ---

test("Voice synthesis provider registry - basic register / get / has / clear", () => {
  assert.equal(hasBaleVoiceSynthesisProvider(), false);
  assert.equal(getBaleVoiceSynthesisProviders().length, 0);

  const dispose1 = registerBaleVoiceSynthesisProvider(
    () => Promise.resolve("audio.mp3"),
    { id: "p1" },
  );
  assert.equal(hasBaleVoiceSynthesisProvider(), true);
  assert.equal(getBaleVoiceSynthesisProviders().length, 1);

  const dispose2 = registerBaleVoiceSynthesisProvider(
    {
      getVoicePolicy: () => ({ replyMode: "always" }),
      getVoicePromptContribution: () => "Be concise.",
    } as any,
    { id: "p2" },
  );
  assert.equal(getBaleVoiceSynthesisProviders().length, 2);

  dispose1();
  assert.equal(getBaleVoiceSynthesisProviders().length, 1);

  dispose2();
  assert.equal(hasBaleVoiceSynthesisProvider(), false);
});

test("Voice synthesis provider registry accepts both function and object form", () => {
  // Function form (backward compat)
  registerBaleVoiceSynthesisProvider(() => Promise.resolve("audio1"), {
    id: "fn",
  });

  // Object form
  registerBaleVoiceSynthesisProvider(
    {
      getVoicePolicy: () => ({ replyMode: "mirror" }),
    } as any,
    { id: "obj" },
  );

  const providers = getBaleVoiceSynthesisProviders();
  assert.equal(providers.length, 2);
  assert.equal(typeof providers[0], "function");
  assert.equal(typeof providers[1], "object");
});

interface VoiceProviderRegistryFixture {
  label: string;
  generatedId: string;
  fixtureId: string;
  register(value: string, id?: string): () => void;
  count(): number;
}

const voiceProviderRegistries: VoiceProviderRegistryFixture[] = [
  {
    label: "synthesis",
    generatedId: "voice-synthesis-provider-0",
    fixtureId: "fixture-tts",
    register: (value, id) =>
      registerBaleVoiceSynthesisProvider(
        () => Promise.resolve(value),
        id ? { id } : undefined,
      ),
    count: () => getBaleVoiceSynthesisProviders().length,
  },
  {
    label: "transcription",
    generatedId: "voice-transcription-provider-0",
    fixtureId: "fixture-stt",
    register: (value, id) =>
      registerBaleVoiceTranscriptionProvider(
        () => Promise.resolve(value),
        id ? { id } : undefined,
      ),
    count: () => getBaleVoiceTranscriptionProviders().length,
  },
];

for (const registry of voiceProviderRegistries) {
  test(`Voice ${registry.label} generated ids skip existing registry entries`, () => {
    registry.register("stable", registry.generatedId);
    registry.register("generated");
    assert.equal(registry.count(), 2);
  });

  test(`Voice ${registry.label} stable id stale disposer does not delete replacement`, () => {
    const disposeFirst = registry.register("first", "stable");
    registry.register("second", "stable");
    disposeFirst();
    assert.equal(registry.count(), 1);
  });

  test(`Voice ${registry.label} fixture re-registers cleanly across lifecycle boundaries`, () => {
    const registerFixture = (generation: string) =>
      registry.register(generation, registry.fixtureId);
    const disposeSessionStart = registerFixture("session-start");
    const disposeResume = registerFixture("resume");
    const disposeReload = registerFixture("reload");

    assert.equal(registry.count(), 1);
    disposeSessionStart();
    disposeResume();
    assert.equal(registry.count(), 1);
    disposeReload();
    assert.equal(registry.count(), 0);
  });

  test(`Voice ${registry.label} generated ids do not collide after disposal`, () => {
    const disposeFirst = registry.register("first");
    registry.register("second");
    disposeFirst();
    registry.register("third");
    assert.equal(registry.count(), 2);
  });
}

test("Voice synthesis provider registry clear works reliably for tests", () => {
  registerBaleVoiceSynthesisProvider(() => Promise.resolve("x"), {
    id: "tmp",
  });
  assert.equal(hasBaleVoiceSynthesisProvider(), true);

  clearBaleVoiceSynthesisProviders();
  assert.equal(hasBaleVoiceSynthesisProvider(), false);
});

// --- Stripping And Generic Parser Interaction ---

test("stripBaleCommentMarkupForPreview removes voice blocks and normalizes whitespace", () => {
  const input = 'Hello\n\n<!-- bale_voice {"text":"World"} -->\n\nWorld';
  const result = stripBaleCommentMarkupForPreview(input);
  assert.ok(!result.includes("bale_voice"));
  assert.ok(!result.includes("\n\n\n"));
});

test("planBaleVoiceReply works with the original generic parsers (fence + comment)", () => {
  const input = 'Text\n```\ncode\n```\n<!-- bale_voice {"text":"Spoken"} -->';
  const result = planBaleVoiceReply(input);
  assert.equal(result.voiceText, "Spoken");
  assert.ok(result.markdown.includes("Text"));
  assert.ok(result.markdown.includes("code"));
});

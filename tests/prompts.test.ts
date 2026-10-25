/**
 * Regression tests for Bale prompt injection helpers
 * Covers native request-head stability, turn context, and compatibility hook binding
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  buildBaleBridgeSystemPrompt,
  createBaleBeforeAgentStartHook,
  createBaleModelContextAvailabilityBinding,
  createBaleModelContextAvailabilityRuntime,
  createBaleProactiveBeforeAgentStartHook,
  BALE_ATTACH_PROMPT_GUIDELINES,
  type BaleSystemPrompt,
  BALE_ATTACH_PROMPT_SNIPPET,
  BALE_CONNECTED_CONTEXT_MESSAGE,
  BALE_DISCONNECTED_CONTEXT_MESSAGE,
  BALE_MESSAGE_PROMPT_GUIDELINES,
  BALE_MESSAGE_PROMPT_SNIPPET,
} from "../lib/prompts.ts";

type BeforeAgentStartHookEvent = Parameters<
  ReturnType<typeof createBaleBeforeAgentStartHook>
>[0];

function createBeforeAgentStartEvent(
  prompt: string,
  systemPrompt: BaleSystemPrompt,
): BeforeAgentStartHookEvent {
  return { prompt, systemPrompt } as BeforeAgentStartHookEvent;
}

test("Prompt hooks normalize missing and null system prompts without losing Bale guidance", async () => {
  for (const systemPrompt of [undefined, null]) {
    const event = { prompt: "[bale] hello", systemPrompt } as BeforeAgentStartHookEvent;
    const hook = createBaleBeforeAgentStartHook({
      localSystemPromptSuffix: "local", baleTurnSystemPromptSuffix: "/bale",
    });
    assert.equal(hook(event).systemPrompt, "local/bale\n- The current user message came from Bale.");
    for (const available of [false, true]) {
      const proactive = createBaleProactiveBeforeAgentStartHook({
        baseHook: hook, isAvailable: () => available,
      });
      assert.deepEqual(
        await proactive(event, undefined),
        available ? { systemPrompt: hook(event).systemPrompt } : undefined,
      );
    }
  }
  assert.deepEqual(buildBaleBridgeSystemPrompt({
    prompt: "local", localSystemPromptSuffix: "suffix", baleTurnSystemPromptSuffix: "bale",
  }), { systemPrompt: "suffix" });
});

test("Custom-message starts keep bridge guidance without claiming Bale user input", async () => {
  for (const systemPrompt of ["base", ["base", "context"], undefined, null]) {
    for (const prompt of [undefined, "[bale] stale user prompt"]) {
      const event = {
        type: "before_agent_start", messageType: "custom", systemPrompt,
        systemPromptOptions: {
          cwd: ".", selectedTools: [], hiddenTools: [], toolSnippets: {}, toolGuidelines: {}, promptGuidelines: [],
          appendSystemPrompt: "", sections: {}, contextFiles: [], skills: [],
        },
        message: { role: "custom", customType: "completion", content: "[bale] quoted text", display: true, timestamp: 0 },
        ...(prompt === undefined ? {} : { prompt }),
      } as BeforeAgentStartHookEvent;
      for (const available of [false, true]) {
        let reconciled = 0;
        const hook = createBaleProactiveBeforeAgentStartHook({
          baseHook: createBaleBeforeAgentStartHook({ localSystemPromptSuffix: "local", baleTurnSystemPromptSuffix: "bale" }),
          reconcileAvailability: () => { reconciled++; },
          isAvailable: () => available,
        });
        const result = await hook(event, undefined);
        const base = systemPrompt ?? "";
        assert.deepEqual(
          result,
          available
            ? { systemPrompt: Array.isArray(base) ? [...base, "local"] : base + "local" }
            : undefined,
        );
        assert.equal(reconciled, 1);
      }
    }
  }
});

test("User starts recognize Bale on both legacy and discriminated Pi events", () => {
  const hook = createBaleBeforeAgentStartHook({ localSystemPromptSuffix: "local", baleTurnSystemPromptSuffix: "bale" });
  for (const messageType of [undefined, "user"] as const) {
    const event = { ...createBeforeAgentStartEvent(" [bale|thread:Test] hello", "base"), ...(messageType ? { messageType } : {}) };
    assert.deepEqual(hook(event), { systemPrompt: "baselocalbale\n- The current user message came from Bale." });
  }
  assert.deepEqual(buildBaleBridgeSystemPrompt({
    systemPrompt: "base", localSystemPromptSuffix: "local", baleTurnSystemPromptSuffix: "bale",
  }), { systemPrompt: "baselocal" });
});

test("Prompt helpers append context-aware system prompt suffixes", () => {
  assert.deepEqual(
    buildBaleBridgeSystemPrompt({
      prompt: " [bale] hello",
      systemPrompt: "base",
      balePrefix: "[bale]",
      localSystemPromptSuffix: "\nlocal bridge available",
      baleTurnSystemPromptSuffix: "\nbale turn contract",
    }),
    {
      systemPrompt:
        "base\nlocal bridge available\nbale turn contract\n- The current user message came from Bale.",
    },
  );
  assert.deepEqual(
    buildBaleBridgeSystemPrompt({
      prompt: "local hello",
      systemPrompt: "base",
      balePrefix: "[bale]",
      localSystemPromptSuffix: "\nlocal bridge available",
      baleTurnSystemPromptSuffix: "\nbale turn contract",
    }),
    { systemPrompt: "base\nlocal bridge available" },
  );
});

test("Prompt helpers preserve ordered system prompt blocks", () => {
  assert.deepEqual(
    buildBaleBridgeSystemPrompt({
      prompt: "local hello",
      systemPrompt: ["base", "project context"],
      balePrefix: "[bale]",
      localSystemPromptSuffix: "\nlocal bridge available",
      baleTurnSystemPromptSuffix: "\nbale turn contract",
    }),
    {
      systemPrompt: [
        "base",
        "project context",
        "\nlocal bridge available",
      ],
    },
  );
});

test("Prompt helpers keep local prompts on compact safety guidance only", () => {
  const result = createBaleBeforeAgentStartHook()(
    createBeforeAgentStartEvent("local hello", "base"),
  ).systemPrompt;
  assert.ok(typeof result === "string");
  assert.match(result, /Bale session connected/);
  assert.match(result, /connectivity alone is not user intent/);
  assert.match(result, /`bale-bridge`/);
  assert.match(result, /`show-me`/);
  assert.match(result, /`generated-control-surface`/);
  assert.match(result, /`generative-apps`/);
  assert.match(result, /bundled Skills in routing order/);
  assert.match(result, /`bale-bridge` for the transport and turn protocol/);
  assert.match(
    result,
    /`show-me` when a user needs a truthful visual explanation of work or behavior/,
  );
  assert.match(
    result,
    /`generated-control-surface` when contextual controls materially shorten feedback/,
  );
  assert.match(
    result,
    /`generative-apps` when the interaction warrants a reusable deterministic app/,
  );
  assert.match(
    result,
    /Load a Skill only if its instructions are not already present in the current context/,
  );
  assert.doesNotMatch(result, /bale_help/);
  assert.doesNotMatch(result, /bale_attach/);
  assert.doesNotMatch(result, /bale_message/);
  assert.doesNotMatch(result, /37 visible cells/);
  assert.doesNotMatch(result, /bale_voice text="Short summary"/);
  assert.doesNotMatch(result, /The current user message came from Bale/);
});

test("Connection context messages are concise and explicit", () => {
  assert.equal(
    BALE_CONNECTED_CONTEXT_MESSAGE,
    "Bale session connected. Use Bale features for Bale-originated turns or explicit Bale requests; connectivity alone is not user intent.",
  );
  assert.equal(
    BALE_DISCONNECTED_CONTEXT_MESSAGE,
    "Bale session disconnected. Do not use Bale delivery, actions, or Bale-specific reply features unless the user reconnects it.",
  );
});

test("Prompt helpers add full Bale-turn guidance for Bale prompts", () => {
  const hook = createBaleBeforeAgentStartHook({
    balePrefix: "[bale]",
    localSystemPromptSuffix: "\nlocal bridge available",
    baleTurnSystemPromptSuffix: "\nbale turn contract",
  });
  assert.deepEqual(
    hook(createBeforeAgentStartEvent(" [bale] hello", "base")),
    {
      systemPrompt:
        "base\nlocal bridge available\nbale turn contract\n- The current user message came from Bale.",
    },
  );
  assert.deepEqual(
    hook(
      createBeforeAgentStartEvent(
        " [bale|chat:supergroup|thread:42] hello",
        "base",
      ),
    ),
    {
      systemPrompt:
        "base\nlocal bridge available\nbale turn contract\n- The current user message came from Bale.",
    },
  );
  const defaultSystemPrompt = createBaleBeforeAgentStartHook()(
    createBeforeAgentStartEvent(" [bale] hello", "base"),
  ).systemPrompt;
  assert.ok(typeof defaultSystemPrompt === "string");
  assert.match(
    defaultSystemPrompt,
    /The current user message came from Bale/,
  );
  assert.match(
    defaultSystemPrompt,
    /Follow the applicable bundled Bale Skills in routing order/,
  );
  assert.match(defaultSystemPrompt, /load only missing instructions/);
  assert.doesNotMatch(defaultSystemPrompt, /bale_help/);
  assert.doesNotMatch(defaultSystemPrompt, /mobile Bale/);
  assert.doesNotMatch(defaultSystemPrompt, /\$\.\.\.\$.*\$\$\.\.\.\$\$/);
  assert.doesNotMatch(defaultSystemPrompt, /37 visible cells/);
  assert.doesNotMatch(
    defaultSystemPrompt,
    /`\[reply\]` is quoted context only/,
  );
  assert.doesNotMatch(defaultSystemPrompt, /`\[outputs\]` are handler results/);
  assert.doesNotMatch(defaultSystemPrompt, /`\[time\]` is wall-clock context/);
  assert.doesNotMatch(
    defaultSystemPrompt,
    /`\[voice\]` gives reply-mode policy/,
  );
  assert.doesNotMatch(defaultSystemPrompt, /bale_attach/);
  assert.doesNotMatch(defaultSystemPrompt, /bale_message/);
  assert.doesNotMatch(defaultSystemPrompt, /bale_voice: Speak this/);
  assert.doesNotMatch(defaultSystemPrompt, /\/bale_voice/);
  assert.doesNotMatch(defaultSystemPrompt, /state\.json/);
  assert.doesNotMatch(defaultSystemPrompt, /logs\.jsonl/);
  assert.doesNotMatch(
    defaultSystemPrompt,
    /thread.*visible Thread identity.*not a bus role/s,
  );
  assert.doesNotMatch(
    defaultSystemPrompt,
    /Give yourself a unique thread name/,
  );
  assert.doesNotMatch(defaultSystemPrompt, /bale_rename_thread/);

  const topicSystemPrompt = createBaleBeforeAgentStartHook()(
    createBeforeAgentStartEvent(" [bale|thread:C] hello", "base"),
  ).systemPrompt;
  assert.ok(typeof topicSystemPrompt === "string");
  assert.match(
    topicSystemPrompt,
    /The current user message came from Bale/,
  );
  assert.doesNotMatch(topicSystemPrompt, /unnamed fresh topic/);
  assert.doesNotMatch(topicSystemPrompt, /bale_rename_thread/);
});

test("Prompt helpers leave local prompts private for proactive result push", async () => {
  const hook = createBaleProactiveBeforeAgentStartHook({
    baseHook: createBaleBeforeAgentStartHook({
      balePrefix: "[bale]",
      localSystemPromptSuffix: "\nlocal bridge available",
      baleTurnSystemPromptSuffix: "\nbale turn contract",
    }),
    isAvailable: () => true,
  });
  const result = await hook(
    createBeforeAgentStartEvent("local prompt", "base"),
    "ctx",
  );
  assert.deepEqual(result, { systemPrompt: "base\nlocal bridge available" });
});

test("Prompt helpers skip suffix injection when Bale transport is unavailable", async () => {
  const hook = createBaleProactiveBeforeAgentStartHook({
    baseHook: createBaleBeforeAgentStartHook({
      balePrefix: "[bale]",
      localSystemPromptSuffix: "\nlocal bridge available",
      baleTurnSystemPromptSuffix: "\nbale turn contract",
    }),
    isAvailable: () => false,
  });
  const stalePrompt = [
    "base",
    `- bale_attach: ${BALE_ATTACH_PROMPT_SNIPPET}`,
    ...BALE_ATTACH_PROMPT_GUIDELINES.map((line) => `- ${line}`),
  ].join("\n");
  const result = await hook(
    createBeforeAgentStartEvent("[bale] hello", stalePrompt),
    "ctx",
  );
  assert.deepEqual(result, { systemPrompt: "base" });
});

test("Prompt helpers strip unavailable Bale tools from each ordered block", async () => {
  const hook = createBaleProactiveBeforeAgentStartHook({
    isAvailable: () => false,
  });
  const stalePrompt = [
    `base\n- bale_attach: ${BALE_ATTACH_PROMPT_SNIPPET}\ntail`,
    "project context",
  ];

  const result = await hook(
    createBeforeAgentStartEvent("[bale] hello", stalePrompt),
    "ctx",
  );

  assert.deepEqual(result, {
    systemPrompt: ["base\ntail", "project context"],
  });
});

test("Prompt helpers return no override when unavailable transport has nothing to strip", async () => {
  const hook = createBaleProactiveBeforeAgentStartHook({
    isAvailable: () => false,
  });
  for (const systemPrompt of ["base", ["base", "project context"]]) {
    const result = await hook(
      createBeforeAgentStartEvent("local prompt", systemPrompt),
      "ctx",
    );
    assert.equal(result, undefined);
  }
  for (const systemPrompt of [undefined, null]) {
    const event = { prompt: "local prompt", systemPrompt } as BeforeAgentStartHookEvent;
    assert.equal(await hook(event, "ctx"), undefined);
  }
});

test("Prompt helpers still force a stripped prompt when unavailable transport has Bale tool metadata", async () => {
  const hook = createBaleProactiveBeforeAgentStartHook({
    isAvailable: () => false,
  });
  const result = await hook(
    createBeforeAgentStartEvent(
      "local prompt",
      `base\n- bale_message: ${BALE_MESSAGE_PROMPT_SNIPPET}`,
    ),
    "ctx",
  );
  assert.deepEqual(result, { systemPrompt: "base" });
});

test("Prompt helpers return no override when the computed prompt equals the incoming prompt", async () => {
  const hook = createBaleProactiveBeforeAgentStartHook({
    baseHook: createBaleBeforeAgentStartHook({
      localSystemPromptSuffix: "",
      baleTurnSystemPromptSuffix: "\nbale turn contract",
    }),
    isAvailable: () => true,
  });
  assert.equal(
    await hook(createBeforeAgentStartEvent("local prompt", "base"), "ctx"),
    undefined,
  );
  assert.deepEqual(
    await hook(createBeforeAgentStartEvent("[bale] hello", "base"), "ctx"),
    {
      systemPrompt:
        "base\nbale turn contract\n- The current user message came from Bale.",
    },
  );
});

function createSectionsEvent(
  prompt: string,
  options: Record<string, unknown> = {},
  extra: Record<string, unknown> = {},
): BeforeAgentStartHookEvent {
  return {
    type: "before_agent_start",
    prompt,
    systemPrompt: "rendered base",
    systemPromptOptions: {
      cwd: ".", selectedTools: [], hiddenTools: [], toolSnippets: {}, toolGuidelines: {}, promptGuidelines: [],
      appendSystemPrompt: "", sections: {}, contextFiles: [], skills: [], ...options,
    },
    ...extra,
  } as unknown as BeforeAgentStartHookEvent;
}

function getSections(event: BeforeAgentStartHookEvent): Record<string, string> {
  return (event as unknown as { systemPromptOptions: { sections: Record<string, string> } })
    .systemPromptOptions.sections;
}

test("Prompt sections carry the connected bridge guidance without forcing a system prompt", async () => {
  const hook = createBaleProactiveBeforeAgentStartHook({ isAvailable: () => true });
  const localEvent = createSectionsEvent("local prompt", { sections: { other: "keep" } });
  assert.equal(await hook(localEvent, "ctx"), undefined);
  assert.deepEqual(Object.keys(getSections(localEvent)), ["other", "bale"]);
  assert.equal(getSections(localEvent).other, "keep");
  const localSection = getSections(localEvent).bale;
  assert.equal(localSection.startsWith(BALE_CONNECTED_CONTEXT_MESSAGE), true);
  assert.equal(localSection.includes("Bale turn note"), false);
  assert.equal(localSection, localSection.trim());

  const baleEvent = createSectionsEvent("  [bale] hello");
  const baleResult = await hook(baleEvent, "ctx");
  assert.deepEqual(baleResult, { message: { customType: "bale-turn", display: false,
    content: "Bale turn note: Follow the applicable bundled Bale Skills in routing order; load only missing instructions.\n- The current user message came from Bale." } });
  assert.equal(getSections(baleEvent).bale, localSection);

  const customEvent = createSectionsEvent("[bale] stale", {}, { messageType: "custom" });
  assert.equal(await hook(customEvent, "ctx"), undefined);
  assert.equal(getSections(customEvent).bale, localSection);

  // Native placement changes, but legacy callers retain the same instruction text.
  const forced = createBaleBeforeAgentStartHook()(createBeforeAgentStartEvent("[bale] hello", ""));
  assert.equal(forced.systemPrompt, `\n\n${localSection}\n\n${baleResult!.message!.content}`);
});

test("Prompt sections drop stale Bale guidance when the bridge is unavailable", async () => {
  const reconciled: string[] = [];
  const hook = createBaleProactiveBeforeAgentStartHook({
    reconcileAvailability: () => { reconciled.push("reconcile"); },
    isAvailable: () => false,
  });
  const event = createSectionsEvent("[bale] hello", {
    sections: { bale: "stale", other: "keep" },
    toolSnippets: {
      bale_attach: BALE_ATTACH_PROMPT_SNIPPET,
      bale_message: BALE_MESSAGE_PROMPT_SNIPPET,
      read: "Read files",
    },
    toolGuidelines: {
      bale_attach: [...BALE_ATTACH_PROMPT_GUIDELINES],
      bale_message: [...BALE_MESSAGE_PROMPT_GUIDELINES],
      read: ["Read carefully"],
    },
  });
  assert.equal(await hook(event, "ctx"), undefined);
  const options = (event as unknown as {
    systemPromptOptions: { sections: object; toolSnippets: object; toolGuidelines: object };
  }).systemPromptOptions;
  assert.deepEqual(options.sections, { other: "keep" });
  assert.deepEqual(options.toolSnippets, { read: "Read files" });
  assert.deepEqual(options.toolGuidelines, { read: ["Read carefully"] });
  assert.deepEqual(reconciled, ["reconcile"]);

  // Pi hands over normalized options, but tolerate partial ones too.
  const partial = { prompt: "x", systemPrompt: "base", systemPromptOptions: { sections: { bale: "stale" } } } as unknown as BeforeAgentStartHookEvent;
  assert.equal(await hook(partial, "ctx"), undefined);
  assert.deepEqual(getSections(partial), {});
});

test("Prompt hooks keep the forced-prompt path when Pi exposes no sections or a custom base hook is supplied", async () => {
  const stale = `base\n- bale_attach: ${BALE_ATTACH_PROMPT_SNIPPET}`;
  for (const systemPromptOptions of [undefined, null, {}, { sections: null }, { sections: "x" }]) {
    const event = { prompt: "[bale] hi", systemPrompt: stale, systemPromptOptions } as unknown as BeforeAgentStartHookEvent;
    const unavailable = createBaleProactiveBeforeAgentStartHook({ isAvailable: () => false });
    assert.deepEqual(await unavailable(event, "ctx"), { systemPrompt: "base" });
    const available = createBaleProactiveBeforeAgentStartHook({ isAvailable: () => true });
    const result = await available({ ...event, systemPrompt: "base" } as BeforeAgentStartHookEvent, "ctx");
    assert.equal(typeof result?.systemPrompt, "string");
    assert.equal((result?.systemPrompt as string).includes(BALE_CONNECTED_CONTEXT_MESSAGE), true);
  }
  const customBase = createBaleProactiveBeforeAgentStartHook({
    baseHook: createBaleBeforeAgentStartHook({ localSystemPromptSuffix: "local", baleTurnSystemPromptSuffix: "turn" }),
    isAvailable: () => true,
  });
  const event = createSectionsEvent("local prompt");
  assert.deepEqual(await customBase(event, "ctx"), { systemPrompt: "rendered baselocal" });
  assert.deepEqual(getSections(event), {});
});

test("Model-context availability binding safely delegates after late composition", () => {
  const calls: string[] = [];
  const binding = createBaleModelContextAvailabilityBinding();
  binding.reconcile();
  binding.bind({ reconcile: () => calls.push("reconcile") });
  binding.reconcile();
  assert.deepEqual(calls, ["reconcile"]);
});

test("Model-context availability removes only active Bale tools and restores that subset", () => {
  let available = false;
  let activeTools = [
    "read",
    "bale_attach",
    "bale_bind",
    "foreign_tool",
    "bale_message",
  ];
  const memory = { suspended: false, toolNames: new Set<string>() };
  const runtime = createBaleModelContextAvailabilityRuntime({
    getActiveTools: () => [...activeTools],
    setActiveTools: (names) => {
      activeTools = names;
    },
    isAvailable: () => available,
    memory,
  });

  runtime.reconcile();
  assert.deepEqual(activeTools, ["read", "foreign_tool"]);
  assert.deepEqual([...memory.toolNames], [
    "bale_attach",
    "bale_bind",
    "bale_message",
  ]);

  available = true;
  runtime.reconcile();
  assert.deepEqual(activeTools, [
    "read",
    "foreign_tool",
    "bale_attach",
    "bale_bind",
    "bale_message",
  ]);
  assert.equal(memory.toolNames.size, 0);
  assert.equal(memory.suspended, false);
});

test("Model-context availability does not enable a Bale tool disabled by the operator", () => {
  let available = false;
  let activeTools = ["read", "bale_message"];
  const runtime = createBaleModelContextAvailabilityRuntime({
    getActiveTools: () => [...activeTools],
    setActiveTools: (names) => {
      activeTools = names;
    },
    isAvailable: () => available,
    memory: { suspended: false, toolNames: new Set<string>() },
  });

  runtime.reconcile();
  available = true;
  runtime.reconcile();

  assert.deepEqual(activeTools, ["read", "bale_message"]);
  assert.equal(activeTools.includes("bale_attach"), false);
});

test("Model-context availability defers active-tool mutation during an in-flight request", () => {
  let canReconcile = false;
  let activeTools = ["read", "bale_attach"];
  const runtime = createBaleModelContextAvailabilityRuntime({
    getActiveTools: () => [...activeTools],
    setActiveTools: (names) => {
      activeTools = names;
    },
    isAvailable: () => false,
    canReconcile: () => canReconcile,
    memory: { suspended: false, toolNames: new Set<string>() },
  });

  runtime.reconcile();
  assert.deepEqual(activeTools, ["read", "bale_attach"]);

  canReconcile = true;
  runtime.reconcile();
  assert.deepEqual(activeTools, ["read"]);
});

test("Model-context availability preserves operator subset across Pi reload defaults", () => {
  let activeTools = ["read", "bale_message"];
  const memory = { suspended: false, toolNames: new Set<string>() };
  const createRuntime = (isAvailable: () => boolean) =>
    createBaleModelContextAvailabilityRuntime({
      getActiveTools: () => [...activeTools],
      setActiveTools: (names) => {
        activeTools = names;
      },
      isAvailable,
      memory,
    });

  createRuntime(() => false).reconcile();
  assert.deepEqual(activeTools, ["read"]);
  assert.deepEqual([...memory.toolNames], ["bale_message"]);

  activeTools = ["read", "bale_attach", "bale_message"];
  createRuntime(() => false).reconcile();
  assert.deepEqual(activeTools, ["read"]);
  assert.deepEqual([...memory.toolNames], ["bale_message"]);

  createRuntime(() => true).reconcile();
  assert.deepEqual(activeTools, ["read", "bale_message"]);
});

for (const available of [false, true]) test(`Prompt hooks preserve an existing forced prompt (${available ? "connected" : "unavailable"})`, async () => {
  const opaque = `Other extension instructions\n- bale_attach: ${BALE_ATTACH_PROMPT_SNIPPET}`;
  const event = createSectionsEvent("local prompt", { forceSystemPrompt: opaque }, { systemPrompt: opaque });
  const result = await createBaleProactiveBeforeAgentStartHook({ isAvailable: () => available })(event, "ctx");
  assert.equal(typeof result?.systemPrompt, "string");
  assert.match(result!.systemPrompt as string, /Other extension instructions/);
  if (available) assert.match(result!.systemPrompt as string, /Bale session connected/);
  else assert.equal(result!.systemPrompt, "Other extension instructions");
  assert.deepEqual(getSections(event), {});
});

for (const initiallyAvailable of [false, true]) test(`Real Pi runtime keeps Bale guidance cache-safe through tools, turns and resume (${initiallyAvailable ? "connected" : "unavailable"})`, async () => {
  const { mkdtemp, realpath, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } = await import("@earendil-works/pi-coding-agent");
  const { fauxProvider, fauxAssistantMessage, fauxToolCall, Type } = await import("@earendil-works/pi-ai");
  const dir = await realpath(await mkdtemp(join(tmpdir(), "pi-bale-native-prompts-")));
  const requests: import("@earendil-works/pi-ai").Message[][] = [], errors: string[] = [];
  let available = initiallyAvailable, forced: string | undefined, enabled = false, removeSearch = false;
  let session: import("@earendil-works/pi-coding-agent").AgentSession | undefined;
  const hook = createBaleProactiveBeforeAgentStartHook({ isAvailable: () => available });
  try {
    const modelRuntime = await ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: null,
      modelsStorePath: join(dir, "models-cache.json"), allowModelNetwork: false, refreshOnCreate: false });
    const faux = fauxProvider({ provider: "bale-prompt-fixture", api: "bale-prompt-fixture", tokensPerSecond: Infinity });
    modelRuntime.registerNativeProvider(faux.provider);
    faux.setResponses(Array.from({ length: 20 }, () => (context: import("@earendil-works/pi-ai").TranscriptContext) => {
      requests.push(structuredClone(context.messages));
      if (!enabled) {
        enabled = true;
        return fauxAssistantMessage(fauxToolCall("web_enable", {}), { stopReason: "toolUse" });
      }
      return fauxAssistantMessage("Fixture completed");
    }));
    const settings = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
    const createSession = async (manager: import("@earendil-works/pi-coding-agent").SessionManager) => {
      const resources = new DefaultResourceLoader({ cwd: dir, agentDir: dir, settingsManager: settings,
        noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
        extensionFactories: [pi => {
          for (const name of ["web_enable", "web_search", "ghost_tool"]) pi.registerTool({ name, label: name,
            description: `Native prompt fixture ${name}`, promptSnippet: `Native prompt fixture ${name}`, parameters: Type.Object({}),
            async execute() {
              if (name === "web_enable") pi.setActiveTools([...new Set([...pi.getActiveTools(), "web_search"])]);
              return { content: [{ type: "text", text: "Fixture tool completed" }], details: undefined };
            } });
          pi.on("before_agent_start", () => {
            pi.setActiveTools(pi.getActiveTools().filter(name => name !== "ghost_tool" && (name !== "web_search" || (enabled && !removeSearch))));
            return forced === undefined ? undefined : { systemPrompt: forced };
          });
        }, pi => {
          pi.on("before_agent_start", async (event, ctx) => {
            const result = await hook(event, ctx);
            if (!result || result.systemPrompt === undefined) return result ? { message: result.message } : undefined;
            assert.equal(typeof result.systemPrompt, "string");
            return { ...result, systemPrompt: result.systemPrompt as string };
          });
        }, pi => {
          pi.on("before_agent_start", event => { event.systemPromptOptions.sections.foreign = "Later extension instructions"; });
        }] });
      await resources.reload();
      assert.deepEqual(resources.getExtensions().errors, []);
      const result = await createAgentSession({ cwd: dir, agentDir: dir, modelRuntime, model: faux.getModel(),
        thinkingLevel: "off", settingsManager: settings, resourceLoader: resources, sessionManager: manager,
        tools: ["read", "web_enable", "web_search", "ghost_tool"] });
      await result.session.bindExtensions({ mode: "rpc", onError: error => { errors.push(JSON.stringify(error)); } });
      return result.session;
    };
    session = await createSession(SessionManager.create(dir, join(dir, "sessions")));
    await session.prompt("Enable the fixture tool");
    assert.equal(requests.length, 2);
    const head = requests[0]![0];
    assert.equal(head?.role, "system");
    assert.match(JSON.stringify(head), /Later extension instructions/);
    assert.doesNotMatch(JSON.stringify(head), /ghost_tool|web_search/);
    assert.ok(requests[1]!.some(message => message.role === "toolResult" && message.toolName === "web_enable" && !message.isError));
    await session.prompt("Observe the enabled fixture tool");
    assert.ok(requests.at(-1)!.slice(1).some(message => message.role === "system" && message.toolsAdded?.some(tool => tool.name === "web_search")),
      "The next run must declare the enabled tool through a trailing system update");
    available = !available;
    await session.prompt("Observe the changed connection");
    assert.ok(requests.at(-1)!.slice(1).some(message => message.role === "system" && Object.hasOwn(message.sections ?? {}, "bale")),
      "A connection change must use a trailing section update");
    available = true;
    await session.prompt("Local prompt before Bale");
    const balePatches = () => requests.at(-1)!.slice(1).filter(message => message.role === "system" && Object.hasOwn(message.sections ?? {}, "bale")).length;
    const beforeBale = balePatches();
    await session.prompt("[bale|thread:Fixture] Bale prompt");
    assert.equal(balePatches(), beforeBale, "Turn origin must not toggle the stable connection section");
    const turnNotes = () => session!.messages.filter(message => message.role === "custom" && message.customType === "bale-turn");
    assert.equal(turnNotes().length, 1);
    const note = turnNotes()[0];
    assert.ok(note && note.role === "custom");
    assert.equal(note.display, false);
    await session.prompt("Local prompt after Bale");
    assert.equal(balePatches(), beforeBale);
    assert.equal(turnNotes().length, 1);
    await session.sendCustomMessage({ customType: "fixture-completion", content: "[bale] quoted completion", display: false }, { triggerTurn: true });
    assert.equal(turnNotes().length, 1, "A custom start cannot acquire Bale user-turn instructions");
    removeSearch = true;
    await session.prompt("Observe removal of the previously declared tool");
    assert.ok(requests.at(-1)!.slice(1).some(message => message.role === "system" && message.toolsRemoved?.some(tool => tool.name === "web_search")),
      "A previously declared tool must be removed through a trailing system update");
    const path = session.sessionManager.getSessionFile();
    assert.ok(path);
    session.dispose();
    session = await createSession(SessionManager.open(path));
    await session.prompt("Resumed local prompt");
    assert.equal(turnNotes().length, 1, "The original turn note stays historical without being re-injected on resume");
    for (const request of requests) assert.deepEqual(request[0], head, "The original request head must survive tools, turns and resume");
    forced = "Other extension opaque instructions";
    await session.prompt("Forced connected prompt");
    assert.match(JSON.stringify(requests.at(-1)![0]), /Other extension opaque instructions/);
    assert.match(JSON.stringify(requests.at(-1)![0]), /Bale session connected/);
    available = false;
    forced = `Other extension opaque instructions\n- bale_attach: ${BALE_ATTACH_PROMPT_SNIPPET}`;
    await session.prompt("Forced unavailable prompt");
    assert.match(JSON.stringify(requests.at(-1)![0]), /Other extension opaque instructions/);
    assert.doesNotMatch(JSON.stringify(requests.at(-1)![0]), /bale_attach/);
    assert.deepEqual(errors, []);
  } finally {
    session?.dispose();
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});

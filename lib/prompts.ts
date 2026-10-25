/**
 * Bale prompt injection helpers
 * Zones: pi agent prompts, bale guidance
 * Owns stable Bale guidance, turn-scoped context, and compatibility fallback hooks
 */

import type { BeforeAgentStartEvent, BeforeAgentStartEventResult } from "./pi.ts";
import { BALE_PREFIX } from "./turns.ts";

export const BALE_CONNECTED_CONTEXT_MESSAGE =
  "Bale session connected. Use Bale features for Bale-originated turns or explicit Bale requests; connectivity alone is not user intent.";
export const BALE_DISCONNECTED_CONTEXT_MESSAGE =
  "Bale session disconnected. Do not use Bale delivery, actions, or Bale-specific reply features unless the user reconnects it.";

const LOCAL_SYSTEM_PROMPT_SUFFIX = `

${BALE_CONNECTED_CONTEXT_MESSAGE} For Bale work, consult bundled Skills in routing order: \`bale-bridge\` for the transport and turn protocol, \`show-me\` when a user needs a truthful visual explanation of work or behavior, \`generated-control-surface\` when contextual controls materially shorten feedback, then \`generative-apps\` when the interaction warrants a reusable deterministic app. Load a Skill only if its instructions are not already present in the current context. Do not use Bale-specific features from unrelated local/TUI prompts.`;

const BALE_TURN_SYSTEM_PROMPT_SUFFIX = `

Bale turn note: Follow the applicable bundled Bale Skills in routing order; load only missing instructions.`;

export const BALE_ATTACH_PROMPT_SNIPPET =
  "Queue files for the active Bale reply; outside Bale turns, send files directly to Bale.";
export const BALE_ATTACH_PROMPT_GUIDELINES = [
  "When handling a [bale] message and the user asked for a file or generated artifact, call bale_attach with the local path instead of only mentioning the path in text.",
  "When a local/TUI user explicitly asks to send a generated file to Bale, bale_attach can deliver it to the paired/default Bale chat even without an active Bale turn.",
  "For an explicit thread target, provide chat_id plus thread_id; registered multi-instance followers default to their assigned thread target.",
] as const;
export const BALE_MESSAGE_PROMPT_SNIPPET =
  "Send direct Bale Markdown text when the user explicitly asks for Bale delivery to a concrete chat, channel, or live Pi Thread outside the normal reply flow.";
export const BALE_MESSAGE_PROMPT_GUIDELINES = [
  "Use bale_message only when the user explicitly asks to send a message to Bale from the local/TUI side, or names a concrete Bale delivery target.",
  "For an explicitly requested channel post, pass its exact numeric id or public @username as chat_id; no local channel registry is required, and Bale remains the authority on the bot's posting permission.",
  "For an explicitly requested channel media post, pass one local .jpg/.jpeg/.png/.webp photo or .mp4 video as media; the text becomes its caption (max 1024 characters), and albums or other media types are rejected.",
  "For a live Pi thread target, provide thread as its case-insensitive name or numeric id; the bridge sends visibly and admits one attributed turn to that live instance. Unknown, ambiguous, same, or offline targets fail before sending.",
  "Add buttons by embedding the same top-level bale_button HTML comments used in normal Bale replies; Bale does not support standalone buttons.",
  "During an active Bale turn, omit bale_message for the current target and answer normally; use thread only when the user requests delivery to a different live Pi thread.",
] as const;

const BALE_TOOL_METADATA_LINES = Object.fromEntries(
  [
    `- bale_attach: ${BALE_ATTACH_PROMPT_SNIPPET}`,
    `- bale_message: ${BALE_MESSAGE_PROMPT_SNIPPET}`,
    ...BALE_ATTACH_PROMPT_GUIDELINES.map((line) => `- ${line}`),
    ...BALE_MESSAGE_PROMPT_GUIDELINES.map((line) => `- ${line}`),
  ].map((line) => [line, true]),
) as Record<string, true>;

const BALE_MODEL_CONTEXT_TOOL_NAMES = new Set([
  "bale_attach",
  "bale_bind",
  "bale_channel_post",
  "bale_channel_posts",
  "bale_message",
]);
const BALE_MODEL_CONTEXT_MEMORY_KEY = Symbol.for(
  "@llblab/pi-bale:model-context-suspended-tools",
);

export interface BaleModelContextAvailabilityMemory {
  suspended: boolean;
  toolNames: Set<string>;
}

function getBaleModelContextAvailabilityMemory(): BaleModelContextAvailabilityMemory {
  const globals = globalThis as unknown as Record<symbol, unknown>;
  const existing = globals[BALE_MODEL_CONTEXT_MEMORY_KEY];
  if (
    existing &&
    typeof existing === "object" &&
    "toolNames" in existing &&
    (existing as { toolNames?: unknown }).toolNames instanceof Set
  ) {
    return existing as BaleModelContextAvailabilityMemory;
  }
  const memory: BaleModelContextAvailabilityMemory = {
    suspended: false,
    toolNames: new Set<string>(),
  };
  globals[BALE_MODEL_CONTEXT_MEMORY_KEY] = memory;
  return memory;
}

export interface BaleModelContextAvailabilityRuntime {
  reconcile: () => void;
}

export interface BaleModelContextAvailabilityBinding extends BaleModelContextAvailabilityRuntime {
  bind: (runtime: BaleModelContextAvailabilityRuntime) => void;
}

export function createBaleModelContextAvailabilityBinding(): BaleModelContextAvailabilityBinding {
  let runtime: BaleModelContextAvailabilityRuntime | undefined;
  return {
    bind(next) {
      runtime = next;
    },
    reconcile() {
      runtime?.reconcile();
    },
  };
}

export function createBaleModelContextAvailabilityRuntime(deps: {
  getActiveTools: () => string[];
  setActiveTools: (names: string[]) => void;
  isAvailable: () => boolean;
  canReconcile?: () => boolean;
  memory?: BaleModelContextAvailabilityMemory;
}): BaleModelContextAvailabilityRuntime {
  const memory = deps.memory ?? getBaleModelContextAvailabilityMemory();
  return {
    reconcile() {
      if (deps.canReconcile && !deps.canReconcile()) return;
      const activeTools = deps.getActiveTools();
      if (!deps.isAvailable()) {
        if (!memory.suspended) {
          memory.toolNames.clear();
          for (const name of activeTools) {
            if (BALE_MODEL_CONTEXT_TOOL_NAMES.has(name)) {
              memory.toolNames.add(name);
            }
          }
          memory.suspended = true;
        }
        const nextTools = activeTools.filter(
          (name) => !BALE_MODEL_CONTEXT_TOOL_NAMES.has(name),
        );
        if (nextTools.length !== activeTools.length) {
          deps.setActiveTools(nextTools);
        }
        return;
      }
      if (!memory.suspended) return;
      const nextTools = [...activeTools];
      for (const name of BALE_MODEL_CONTEXT_TOOL_NAMES) {
        if (memory.toolNames.has(name) && !nextTools.includes(name)) {
          nextTools.push(name);
        }
      }
      memory.toolNames.clear();
      memory.suspended = false;
      if (nextTools.length !== activeTools.length) {
        deps.setActiveTools(nextTools);
      }
    },
  };
}

export type BaleSystemPrompt = string | string[];

// Pi 1.0 user events lack messageType; Pi 1.2 custom starts carry no user prompt.
type BaleBeforeAgentStartEvent = Omit<
  BeforeAgentStartEvent,
  "systemPrompt" | "prompt" | "messageType"
> & {
  messageType?: "user" | "custom";
  prompt?: string;
  systemPrompt?: BaleSystemPrompt | null;
};

type BaleBeforeAgentStartResult = {
  systemPrompt: BaleSystemPrompt;
};

type BaleProactiveBeforeAgentStartResult = Omit<BeforeAgentStartEventResult, "systemPrompt"> & {
  systemPrompt?: BaleSystemPrompt;
};

type BaleBeforeAgentStartHook = (
  event: BaleBeforeAgentStartEvent,
) => BaleBeforeAgentStartResult;

// Returning any systemPrompt makes Pi replace its prompt, which defeats prompt
// caching; return an override only when the computed prompt actually differs.
function overrideSystemPromptIfChanged(
  incoming: BaleSystemPrompt | null | undefined,
  computed: BaleSystemPrompt,
): BaleBeforeAgentStartResult | undefined {
  const base = incoming ?? "";
  const unchanged =
    Array.isArray(base) && Array.isArray(computed)
      ? base.length === computed.length &&
        base.every((block, index) => block === computed[index])
      : base === computed;
  return unchanged ? undefined : { systemPrompt: computed };
}

function buildBaleTurnSuffix(options: {
  prompt?: string;
  balePrefix?: string;
  baleTurnSystemPromptSuffix: string;
}): string {
  const balePrefix = options.balePrefix ?? BALE_PREFIX;
  const baleHead = balePrefix.endsWith("]")
    ? balePrefix.slice(0, -1)
    : balePrefix;
  const trimmedPrompt = options.prompt?.trimStart() ?? "";
  const baleTurn =
    trimmedPrompt.startsWith(`${baleHead}]`) ||
    trimmedPrompt.startsWith(`${baleHead}|`);
  return baleTurn
    ? `${options.baleTurnSystemPromptSuffix}\n- The current user message came from Bale.`
    : "";
}

export function buildBaleBridgeSystemPrompt(options: {
  prompt?: string;
  systemPrompt?: BaleSystemPrompt | null;
  balePrefix?: string;
  localSystemPromptSuffix: string;
  baleTurnSystemPromptSuffix: string;
}): BaleBeforeAgentStartResult {
  const basePrompt = options.systemPrompt ?? "";
  const baleSuffix = buildBaleTurnSuffix(options);
  return {
    systemPrompt: Array.isArray(basePrompt)
      ? [...basePrompt, options.localSystemPromptSuffix + baleSuffix]
      : basePrompt + options.localSystemPromptSuffix + baleSuffix,
  };
}

export function createBaleBeforeAgentStartHook(
  options: {
    balePrefix?: string;
    localSystemPromptSuffix?: string;
    baleTurnSystemPromptSuffix?: string;
  } = {},
): BaleBeforeAgentStartHook {
  return (event) =>
    buildBaleBridgeSystemPrompt({
      prompt: event.messageType === "custom" ? undefined : event.prompt,
      systemPrompt: event.systemPrompt,
      balePrefix: options.balePrefix,
      localSystemPromptSuffix:
        options.localSystemPromptSuffix ?? LOCAL_SYSTEM_PROMPT_SUFFIX,
      baleTurnSystemPromptSuffix:
        options.baleTurnSystemPromptSuffix ??
        BALE_TURN_SYSTEM_PROMPT_SUFFIX,
    });
}

function stripBaleToolMetadataFromString(systemPrompt: string): string {
  return systemPrompt
    .split("\n")
    .filter((line) => BALE_TOOL_METADATA_LINES[line] !== true)
    .join("\n");
}

function stripBaleToolMetadataFromSystemPrompt(
  systemPrompt: BaleSystemPrompt | null | undefined,
): BaleSystemPrompt {
  if (!systemPrompt) return "";
  return Array.isArray(systemPrompt)
    ? systemPrompt.map(stripBaleToolMetadataFromString)
    : stripBaleToolMetadataFromString(systemPrompt);
}

export interface BaleProactivePromptHookDeps<TContext> {
  baseHook?: BaleBeforeAgentStartHook;
  reconcileAvailability?: () => void;
  isAvailable: (ctx: TContext) => boolean;
}

const BALE_TOOL_NAMES = ["bale_attach", "bale_message"];

// Sections cannot modify an opaque prompt owned by an earlier handler.
// Preserve append/strip compatibility there instead of silently losing guidance.
function applyBalePromptSections(
  event: BaleBeforeAgentStartEvent,
  available: boolean,
): boolean {
  const options = event.systemPromptOptions as
    | Partial<BaleBeforeAgentStartEvent["systemPromptOptions"]>
    | undefined;
  const sections = options?.sections;
  if (typeof sections !== "object" || sections === null || options?.forceSystemPrompt !== undefined) return false;
  if (available) {
    sections.bale = LOCAL_SYSTEM_PROMPT_SUFFIX.trim();
    return true;
  }
  delete sections.bale;
  for (const name of BALE_TOOL_NAMES) {
    if (options?.toolSnippets) delete options.toolSnippets[name];
    if (options?.toolGuidelines) delete options.toolGuidelines[name];
  }
  return true;
}

export function createBaleProactiveBeforeAgentStartHook<TContext>(
  deps: BaleProactivePromptHookDeps<TContext>,
): (
  event: BaleBeforeAgentStartEvent,
  ctx: TContext,
) => Promise<BaleProactiveBeforeAgentStartResult | undefined> {
  const baseHook = deps.baseHook ?? createBaleBeforeAgentStartHook();
  return async (event, ctx) => {
    deps.reconcileAvailability?.();
    const available = deps.isAvailable(ctx);
    // A caller-supplied baseHook owns its own prompt text, so it stays on the forced-prompt path.
    if (!deps.baseHook && applyBalePromptSections(event, available)) {
      const turnSuffix = available ? buildBaleTurnSuffix({
        prompt: event.messageType === "custom" ? undefined : event.prompt,
        baleTurnSystemPromptSuffix: BALE_TURN_SYSTEM_PROMPT_SUFFIX,
      }).trim() : "";
      return turnSuffix ? { message: { customType: "bale-turn", content: turnSuffix, display: false } } : undefined;
    }
    if (!available) {
      return overrideSystemPromptIfChanged(
        event.systemPrompt,
        stripBaleToolMetadataFromSystemPrompt(event.systemPrompt),
      );
    }
    return overrideSystemPromptIfChanged(
      event.systemPrompt,
      baseHook(event).systemPrompt,
    );
  };
}

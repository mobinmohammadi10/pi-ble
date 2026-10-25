/**
 * Bale voice reply policy and provider registries
 * Zones: bale, voice, pi agent prompts
 * Owns: voice reply modes (manual / mirror / always), voice turn flags and preview suppression,
 * voice prompt contributions, and the process-global synthesis/transcription provider registries.
 * Excludes: voice markup parsing (outbound-markup), audio generation and Bale delivery
 * (outbound, outbound-voice), queue, preview lifecycle and turn building.
 */

const VOICE_SYNTHESIS_PROVIDER_REGISTRY_KEY =
  "__piBaleVoiceSynthesisProviders__";
const VOICE_TRANSCRIPTION_PROVIDER_REGISTRY_KEY =
  "__piBaleVoiceTranscriptionProviders__";

let nextGeneratedVoiceSynthesisProviderId = 0;
let nextGeneratedVoiceTranscriptionProviderId = 0;

function getNextAvailableProviderId<T>(
  registry: Map<string, T>,
  prefix: string,
  nextId: () => number,
): string {
  let id: string;
  do {
    id = `${prefix}-${nextId()}`;
  } while (registry.has(id));
  return id;
}

export type BaleVoiceReplyMode = "manual" | "mirror" | "always";

export type BaleVoiceSynthesisProviderResult = string | undefined;

export interface BaleVoiceTurnView {
  voiceReplyPreferred?: boolean;
  voiceReplyRequired?: boolean;
  hasVoiceInput?: boolean;
  userText?: string;
}

export interface BaleVoiceSynthesisProvider {
  (
    text: string,
    options?: { lang?: string; rate?: string },
  ): Promise<BaleVoiceSynthesisProviderResult>;
  getVoicePolicy?: () => { replyMode?: BaleVoiceReplyMode };
  getVoicePromptContribution?: (
    view: BaleVoiceTurnView,
  ) => string | undefined;
}

export type BaleVoiceTranscriptionProviderResult =
  string | { text: string; language?: string } | undefined;

export interface BaleVoiceTranscriptionFile {
  path: string;
  fileName?: string;
  mimeType?: string;
  kind?: string;
}

export interface BaleVoiceTranscriptionProvider {
  (
    file: BaleVoiceTranscriptionFile,
    options?: { language?: string },
  ): Promise<BaleVoiceTranscriptionProviderResult>;
}

// --- Voice Synthesis Provider Registry ---

function getOrCreateVoiceSynthesisProviderRegistry(): Map<
  string,
  BaleVoiceSynthesisProvider
> {
  const existing = (globalThis as Record<string, unknown>)[
    VOICE_SYNTHESIS_PROVIDER_REGISTRY_KEY
  ];
  if (existing instanceof Map)
    return existing as Map<string, BaleVoiceSynthesisProvider>;
  const registry = new Map<string, BaleVoiceSynthesisProvider>();
  (globalThis as Record<string, unknown>)[
    VOICE_SYNTHESIS_PROVIDER_REGISTRY_KEY
  ] = registry;
  return registry;
}

/**
 * Register a high-level Bale voice synthesis provider.
 *
 * Stable public API callers must pass a stable `options.id` so diagnostics,
 * replacement, and cleanup can identify the provider. Omitted ids remain a
 * compatibility path for pre-matrix callers and receive generated session-local
 * ids.
 */
export function registerBaleVoiceSynthesisProvider(
  provider:
    | BaleVoiceSynthesisProvider
    | ((
        text: string,
        options?: { lang?: string; rate?: string },
      ) => Promise<BaleVoiceSynthesisProviderResult>),
  options?: { id?: string },
): () => void {
  const registry = getOrCreateVoiceSynthesisProviderRegistry();
  const id =
    options?.id ??
    getNextAvailableProviderId(
      registry,
      "voice-synthesis-provider",
      () => nextGeneratedVoiceSynthesisProviderId++,
    );
  const normalized =
    typeof provider === "function"
      ? (Object.assign(
          (text: string, options?: { lang?: string; rate?: string }) =>
            provider(text, options),
          {
            getVoicePolicy: (provider as BaleVoiceSynthesisProvider)
              .getVoicePolicy,
            getVoicePromptContribution: (
              provider as BaleVoiceSynthesisProvider
            ).getVoicePromptContribution,
          },
        ) as BaleVoiceSynthesisProvider)
      : provider;
  registry.set(id, normalized);
  return () => {
    if (registry.get(id) === normalized) registry.delete(id);
  };
}

export function getBaleVoiceSynthesisProviders(): BaleVoiceSynthesisProvider[] {
  return Array.from(getOrCreateVoiceSynthesisProviderRegistry().values());
}

export function hasBaleVoiceSynthesisProvider(): boolean {
  return getOrCreateVoiceSynthesisProviderRegistry().size > 0;
}

export function clearBaleVoiceSynthesisProviders(): void {
  getOrCreateVoiceSynthesisProviderRegistry().clear();
}

function getOrCreateVoiceTranscriptionProviderRegistry(): Map<
  string,
  BaleVoiceTranscriptionProvider
> {
  const existing = (globalThis as Record<string, unknown>)[
    VOICE_TRANSCRIPTION_PROVIDER_REGISTRY_KEY
  ];
  if (existing instanceof Map) {
    return existing as Map<string, BaleVoiceTranscriptionProvider>;
  }
  const registry = new Map<string, BaleVoiceTranscriptionProvider>();
  (globalThis as Record<string, unknown>)[
    VOICE_TRANSCRIPTION_PROVIDER_REGISTRY_KEY
  ] = registry;
  return registry;
}

/**
 * Register a high-level Bale voice transcription provider.
 *
 * Stable public API callers must pass a stable `options.id`. Omitted ids remain
 * a compatibility path for pre-matrix callers and receive generated
 * session-local ids.
 */
export function registerBaleVoiceTranscriptionProvider(
  provider: BaleVoiceTranscriptionProvider,
  options?: { id?: string },
): () => void {
  const registry = getOrCreateVoiceTranscriptionProviderRegistry();
  const id =
    options?.id ??
    getNextAvailableProviderId(
      registry,
      "voice-transcription-provider",
      () => nextGeneratedVoiceTranscriptionProviderId++,
    );
  registry.set(id, provider);
  return () => {
    if (registry.get(id) === provider) registry.delete(id);
  };
}

export function getBaleVoiceTranscriptionProviders(): BaleVoiceTranscriptionProvider[] {
  return Array.from(getOrCreateVoiceTranscriptionProviderRegistry().values());
}

export function hasBaleVoiceTranscriptionProvider(): boolean {
  return getOrCreateVoiceTranscriptionProviderRegistry().size > 0;
}

export function clearBaleVoiceTranscriptionProviders(): void {
  getOrCreateVoiceTranscriptionProviderRegistry().clear();
}

// --- Voice Reply Modes ---

export const BALE_VOICE_REPLY_MODES = [
  "manual",
  "mirror",
  "always",
] as const;

/**
 * Returns the active voice reply mode for the current session.
 *
 * Pi-bale owns reply-mode policy through bale.json. If
 * config.voice.replyMode is missing, invalid, or legacy `hidden`, the effective
 * mode is manual.
 */
export function getBaleVoiceReplyMode(config?: {
  voice?: { replyMode?: string };
}): BaleVoiceReplyMode {
  const configMode = config?.voice?.replyMode;
  if (configMode === "mirror" || configMode === "always") return configMode;
  return "manual";
}

// --- Voice Turn Helpers ---

/** Small helper to compute the two voice flags from mode + hasVoiceFile */
export function computeVoiceTurnFlags(
  voiceReplyMode: BaleVoiceReplyMode | undefined,
  hasVoiceFile: boolean,
) {
  return {
    voiceReplyPreferred: hasVoiceFile && voiceReplyMode === "mirror",
    voiceReplyRequired: voiceReplyMode === "always",
  };
}

/** Returns true if the given turn is tagged as a voice turn */
export function isVoiceTurn(
  turn:
    | { voiceReplyPreferred?: boolean; voiceReplyRequired?: boolean }
    | null
    | undefined,
): boolean {
  return !!(turn?.voiceReplyPreferred || turn?.voiceReplyRequired);
}

// --- Voice Prompt Contribution ---

export function computeVoicePromptContribution(
  voiceReplyMode: BaleVoiceReplyMode | undefined,
  files: Array<{ kind?: string }>,
  rawText: string,
): string | undefined {
  const hasVoiceFile = files.some(
    (f) => f.kind === "voice" || f.kind === "audio",
  );

  const isVoiceTagged =
    voiceReplyMode === "always" ||
    (voiceReplyMode === "mirror" && hasVoiceFile);

  if (!isVoiceTagged) return undefined;

  const view: BaleVoiceTurnView = {
    ...computeVoiceTurnFlags(voiceReplyMode, hasVoiceFile),
    hasVoiceInput: hasVoiceFile,
    userText: rawText,
  };

  // Let the voice synthesis provider supply additional instructions for the LLM when in voice mode.
  // When multiple providers are registered, the first one (in registration order)
  // that returns a non-empty string wins.
  for (const provider of getBaleVoiceSynthesisProviders()) {
    if (typeof provider.getVoicePromptContribution === "function") {
      const contribution = provider.getVoicePromptContribution(view);
      if (contribution?.trim()) {
        return contribution.trim();
      }
    }
  }

  return undefined;
}

// --- Preview Suppression ---

/**
 * Returns true if the current turn should not show a text preview
 * (e.g. because it's a voice reply).
 */
export const shouldSuppressPreviewForVoice = isVoiceTurn;

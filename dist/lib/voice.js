/**
 * Bale voice reply policy and provider registries
 * Zones: bale, voice, pi agent prompts
 * Owns: voice reply modes (manual / mirror / always), voice turn flags and preview suppression,
 * voice prompt contributions, and the process-global synthesis/transcription provider registries.
 * Excludes: voice markup parsing (outbound-markup), audio generation and Bale delivery
 * (outbound, outbound-voice), queue, preview lifecycle and turn building.
 */
const VOICE_SYNTHESIS_PROVIDER_REGISTRY_KEY = "__piBaleVoiceSynthesisProviders__";
const VOICE_TRANSCRIPTION_PROVIDER_REGISTRY_KEY = "__piBaleVoiceTranscriptionProviders__";
let nextGeneratedVoiceSynthesisProviderId = 0;
let nextGeneratedVoiceTranscriptionProviderId = 0;
function getNextAvailableProviderId(registry, prefix, nextId) {
    let id;
    do {
        id = `${prefix}-${nextId()}`;
    } while (registry.has(id));
    return id;
}
// --- Voice Synthesis Provider Registry ---
function getOrCreateVoiceSynthesisProviderRegistry() {
    const existing = globalThis[VOICE_SYNTHESIS_PROVIDER_REGISTRY_KEY];
    if (existing instanceof Map)
        return existing;
    const registry = new Map();
    globalThis[VOICE_SYNTHESIS_PROVIDER_REGISTRY_KEY] = registry;
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
export function registerBaleVoiceSynthesisProvider(provider, options) {
    const registry = getOrCreateVoiceSynthesisProviderRegistry();
    const id = options?.id ??
        getNextAvailableProviderId(registry, "voice-synthesis-provider", () => nextGeneratedVoiceSynthesisProviderId++);
    const normalized = typeof provider === "function"
        ? Object.assign((text, options) => provider(text, options), {
            getVoicePolicy: provider
                .getVoicePolicy,
            getVoicePromptContribution: provider.getVoicePromptContribution,
        })
        : provider;
    registry.set(id, normalized);
    return () => {
        if (registry.get(id) === normalized)
            registry.delete(id);
    };
}
export function getBaleVoiceSynthesisProviders() {
    return Array.from(getOrCreateVoiceSynthesisProviderRegistry().values());
}
export function hasBaleVoiceSynthesisProvider() {
    return getOrCreateVoiceSynthesisProviderRegistry().size > 0;
}
export function clearBaleVoiceSynthesisProviders() {
    getOrCreateVoiceSynthesisProviderRegistry().clear();
}
function getOrCreateVoiceTranscriptionProviderRegistry() {
    const existing = globalThis[VOICE_TRANSCRIPTION_PROVIDER_REGISTRY_KEY];
    if (existing instanceof Map) {
        return existing;
    }
    const registry = new Map();
    globalThis[VOICE_TRANSCRIPTION_PROVIDER_REGISTRY_KEY] = registry;
    return registry;
}
/**
 * Register a high-level Bale voice transcription provider.
 *
 * Stable public API callers must pass a stable `options.id`. Omitted ids remain
 * a compatibility path for pre-matrix callers and receive generated
 * session-local ids.
 */
export function registerBaleVoiceTranscriptionProvider(provider, options) {
    const registry = getOrCreateVoiceTranscriptionProviderRegistry();
    const id = options?.id ??
        getNextAvailableProviderId(registry, "voice-transcription-provider", () => nextGeneratedVoiceTranscriptionProviderId++);
    registry.set(id, provider);
    return () => {
        if (registry.get(id) === provider)
            registry.delete(id);
    };
}
export function getBaleVoiceTranscriptionProviders() {
    return Array.from(getOrCreateVoiceTranscriptionProviderRegistry().values());
}
export function hasBaleVoiceTranscriptionProvider() {
    return getOrCreateVoiceTranscriptionProviderRegistry().size > 0;
}
export function clearBaleVoiceTranscriptionProviders() {
    getOrCreateVoiceTranscriptionProviderRegistry().clear();
}
// --- Voice Reply Modes ---
export const BALE_VOICE_REPLY_MODES = [
    "manual",
    "mirror",
    "always",
];
/**
 * Returns the active voice reply mode for the current session.
 *
 * Pi-bale owns reply-mode policy through bale.json. If
 * config.voice.replyMode is missing, invalid, or legacy `hidden`, the effective
 * mode is manual.
 */
export function getBaleVoiceReplyMode(config) {
    const configMode = config?.voice?.replyMode;
    if (configMode === "mirror" || configMode === "always")
        return configMode;
    return "manual";
}
// --- Voice Turn Helpers ---
/** Small helper to compute the two voice flags from mode + hasVoiceFile */
export function computeVoiceTurnFlags(voiceReplyMode, hasVoiceFile) {
    return {
        voiceReplyPreferred: hasVoiceFile && voiceReplyMode === "mirror",
        voiceReplyRequired: voiceReplyMode === "always",
    };
}
/** Returns true if the given turn is tagged as a voice turn */
export function isVoiceTurn(turn) {
    return !!(turn?.voiceReplyPreferred || turn?.voiceReplyRequired);
}
// --- Voice Prompt Contribution ---
export function computeVoicePromptContribution(voiceReplyMode, files, rawText) {
    const hasVoiceFile = files.some((f) => f.kind === "voice" || f.kind === "audio");
    const isVoiceTagged = voiceReplyMode === "always" ||
        (voiceReplyMode === "mirror" && hasVoiceFile);
    if (!isVoiceTagged)
        return undefined;
    const view = {
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

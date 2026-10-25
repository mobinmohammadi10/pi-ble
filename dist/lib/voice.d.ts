/**
 * Bale voice reply policy and provider registries
 * Zones: bale, voice, pi agent prompts
 * Owns: voice reply modes (manual / mirror / always), voice turn flags and preview suppression,
 * voice prompt contributions, and the process-global synthesis/transcription provider registries.
 * Excludes: voice markup parsing (outbound-markup), audio generation and Bale delivery
 * (outbound, outbound-voice), queue, preview lifecycle and turn building.
 */
export type BaleVoiceReplyMode = "manual" | "mirror" | "always";
export type BaleVoiceSynthesisProviderResult = string | undefined;
export interface BaleVoiceTurnView {
    voiceReplyPreferred?: boolean;
    voiceReplyRequired?: boolean;
    hasVoiceInput?: boolean;
    userText?: string;
}
export interface BaleVoiceSynthesisProvider {
    (text: string, options?: {
        lang?: string;
        rate?: string;
    }): Promise<BaleVoiceSynthesisProviderResult>;
    getVoicePolicy?: () => {
        replyMode?: BaleVoiceReplyMode;
    };
    getVoicePromptContribution?: (view: BaleVoiceTurnView) => string | undefined;
}
export type BaleVoiceTranscriptionProviderResult = string | {
    text: string;
    language?: string;
} | undefined;
export interface BaleVoiceTranscriptionFile {
    path: string;
    fileName?: string;
    mimeType?: string;
    kind?: string;
}
export interface BaleVoiceTranscriptionProvider {
    (file: BaleVoiceTranscriptionFile, options?: {
        language?: string;
    }): Promise<BaleVoiceTranscriptionProviderResult>;
}
/**
 * Register a high-level Bale voice synthesis provider.
 *
 * Stable public API callers must pass a stable `options.id` so diagnostics,
 * replacement, and cleanup can identify the provider. Omitted ids remain a
 * compatibility path for pre-matrix callers and receive generated session-local
 * ids.
 */
export declare function registerBaleVoiceSynthesisProvider(provider: BaleVoiceSynthesisProvider | ((text: string, options?: {
    lang?: string;
    rate?: string;
}) => Promise<BaleVoiceSynthesisProviderResult>), options?: {
    id?: string;
}): () => void;
export declare function getBaleVoiceSynthesisProviders(): BaleVoiceSynthesisProvider[];
export declare function hasBaleVoiceSynthesisProvider(): boolean;
export declare function clearBaleVoiceSynthesisProviders(): void;
/**
 * Register a high-level Bale voice transcription provider.
 *
 * Stable public API callers must pass a stable `options.id`. Omitted ids remain
 * a compatibility path for pre-matrix callers and receive generated
 * session-local ids.
 */
export declare function registerBaleVoiceTranscriptionProvider(provider: BaleVoiceTranscriptionProvider, options?: {
    id?: string;
}): () => void;
export declare function getBaleVoiceTranscriptionProviders(): BaleVoiceTranscriptionProvider[];
export declare function hasBaleVoiceTranscriptionProvider(): boolean;
export declare function clearBaleVoiceTranscriptionProviders(): void;
export declare const BALE_VOICE_REPLY_MODES: readonly ["manual", "mirror", "always"];
/**
 * Returns the active voice reply mode for the current session.
 *
 * Pi-bale owns reply-mode policy through bale.json. If
 * config.voice.replyMode is missing, invalid, or legacy `hidden`, the effective
 * mode is manual.
 */
export declare function getBaleVoiceReplyMode(config?: {
    voice?: {
        replyMode?: string;
    };
}): BaleVoiceReplyMode;
/** Small helper to compute the two voice flags from mode + hasVoiceFile */
export declare function computeVoiceTurnFlags(voiceReplyMode: BaleVoiceReplyMode | undefined, hasVoiceFile: boolean): {
    voiceReplyPreferred: boolean;
    voiceReplyRequired: boolean;
};
/** Returns true if the given turn is tagged as a voice turn */
export declare function isVoiceTurn(turn: {
    voiceReplyPreferred?: boolean;
    voiceReplyRequired?: boolean;
} | null | undefined): boolean;
export declare function computeVoicePromptContribution(voiceReplyMode: BaleVoiceReplyMode | undefined, files: Array<{
    kind?: string;
}>, rawText: string): string | undefined;
/**
 * Returns true if the current turn should not show a text preview
 * (e.g. because it's a voice reply).
 */
export declare const shouldSuppressPreviewForVoice: typeof isVoiceTurn;

/**
 * Public Bale voice API
 * Zones: package boundary, extension interop
 * Exposes the stable STT/TTS provider surface and voice policy helpers
 */
export { BALE_VOICE_REPLY_MODES, computeVoicePromptContribution, computeVoiceTurnFlags, getBaleVoiceReplyMode, isVoiceTurn, registerBaleVoiceSynthesisProvider, registerBaleVoiceTranscriptionProvider, shouldSuppressPreviewForVoice, } from "../lib/voice.js";

/**
 * Public Bale commands API
 * Zones: package boundary, extension interop
 * Exposes the stable Bale slash-command registration surface while keeping registry internals package-private
 */
export { registerBaleCommand, type PreparedSelectedCommand, type SelectedCommandExecution, type SelectedPreparationInput, type BaleExtensionCommandContext, type BaleExtensionCommandRegistration, } from "../lib/commands.ts";

/**
 * Public Bale sections API
 * Zones: package boundary, extension interop
 * Exposes the stable managed Bale menu-section surface while keeping registry internals package-private
 */

export type { BaleInputRichBlock, BaleInputRichMessage, BaleRichText } from "../lib/bale-api.ts";

export {
  getBaleSectionDiagnostics,
  registerBaleSection,
  type BaleSectionCallbackContext,
  type BaleSectionCallbackResult,
  type BaleSectionContext,
  type BaleSectionDiagnostic,
  type BaleSectionRegistration,
  type BaleSectionSettingsRegistration,
  type BaleSectionView,
} from "../lib/sections.ts";

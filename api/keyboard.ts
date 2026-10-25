/**
 * Public Bale keyboard API
 * Zones: package boundary, extension interop
 * Exposes shared inline-keyboard structural types without runtime exports
 */

export type {
  BaleInlineKeyboardButton,
  BaleInlineKeyboardButtonStyle,
  BaleInlineKeyboardMarkup,
} from "../lib/keyboard.ts";

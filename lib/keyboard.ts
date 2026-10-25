/**
 * Bale inline-keyboard structural contracts
 * Zones: bale ui, shared structure
 * Owns the shared Bot API reply-markup shape while feature domains own their button semantics
 */

export type BaleInlineKeyboardButtonStyle =
  "danger" | "success" | "primary";

export type BaleInlineKeyboardButton = {
  text: string;
  style?: BaleInlineKeyboardButtonStyle;
} & (
  | { callback_data: string; disabled?: never }
  | { disabled: Record<string, never>; callback_data?: never }
);

export interface BaleInlineKeyboardMarkup {
  inline_keyboard: BaleInlineKeyboardButton[][];
}

const BALE_CALLBACK_DATA_MAX_BYTES = 64;

function getBaleCallbackDataByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

export function assertBaleCallbackData(
  callbackData: string,
  context = "Bale callback_data",
): string {
  const byteLength = getBaleCallbackDataByteLength(callbackData);
  if (byteLength > BALE_CALLBACK_DATA_MAX_BYTES) {
    throw new Error(
      `${context} exceeds ${BALE_CALLBACK_DATA_MAX_BYTES} bytes (${byteLength}). Use a shorter action/payload or store state behind a compact key.`,
    );
  }
  return callbackData;
}

export function assertBaleInlineKeyboardCallbackData(
  replyMarkup: unknown,
  context = "Bale inline keyboard callback_data",
): void {
  if (!replyMarkup || typeof replyMarkup !== "object") return;
  const keyboard = (replyMarkup as { inline_keyboard?: unknown })
    .inline_keyboard;
  if (!Array.isArray(keyboard)) return;
  for (const row of keyboard) {
    if (!Array.isArray(row)) continue;
    for (const button of row) {
      if (!button || typeof button !== "object") continue;
      const callbackData = (button as { callback_data?: unknown })
        .callback_data;
      if (typeof callbackData !== "string") continue;
      assertBaleCallbackData(callbackData, context);
    }
  }
}

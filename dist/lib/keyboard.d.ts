/**
 * Bale inline-keyboard structural contracts
 * Zones: bale ui, shared structure
 * Owns the shared Bot API reply-markup shape while feature domains own their button semantics
 */
export type BaleInlineKeyboardButtonStyle = "danger" | "success" | "primary";
export type BaleInlineKeyboardButton = {
    text: string;
    style?: BaleInlineKeyboardButtonStyle;
} & ({
    callback_data: string;
    disabled?: never;
} | {
    disabled: Record<string, never>;
    callback_data?: never;
});
export interface BaleInlineKeyboardMarkup {
    inline_keyboard: BaleInlineKeyboardButton[][];
}
export declare function assertBaleCallbackData(callbackData: string, context?: string): string;
export declare function assertBaleInlineKeyboardCallbackData(replyMarkup: unknown, context?: string): void;

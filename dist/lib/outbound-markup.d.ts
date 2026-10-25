/**
 * Bale outbound markup parsing helpers
 * Zones: bale outbound, assistant markup
 * Owns top-level assistant action comment extraction, attribute parsing, and markup stripping shared by voice and outbound delivery
 */
export interface BaleTopLevelHtmlComment {
    raw: string;
    content: string;
    start: number;
    end: number;
}
export declare function collectTopLevelHtmlComments(markdown: string): {
    comments: BaleTopLevelHtmlComment[];
    openCommentStart?: number;
};
export declare function replaceBaleButtonFences(markdown: string, replace: (payload: string, closed: boolean) => string): string;
export declare function replaceTopLevelHtmlComments(markdown: string, replacer: (comment: BaleTopLevelHtmlComment) => string): string;
export declare function parseBaleButtonPayloadRows(source: string): Record<string, unknown>[][] | undefined;
export declare function parseBaleActionPayloadRows(comment: BaleTopLevelHtmlComment, command: string): Record<string, unknown>[][] | undefined;
export declare function stripBaleCommentMarkupForPreview(markdown: string): string;
export declare function stripBaleCommentMarkupForDelivery(markdown: string): string;
export interface BaleVoiceReplyItem {
    text: string;
    lang?: string;
    rate?: string;
}
export interface BaleVoiceReplyPlan {
    markdown: string;
    voiceText?: string;
    voiceReplies?: BaleVoiceReplyItem[];
    lang?: string;
    rate?: string;
}
export declare function getBaleActionString(payload: Record<string, unknown>, key: string): string | undefined;
export declare function planBaleVoiceReply(markdown: string): BaleVoiceReplyPlan;

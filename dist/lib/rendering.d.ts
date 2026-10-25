/**
 * Bale UI/compat rendering helpers
 * Zones: bale rendering, shared text utils
 * Converts bridge-owned UI/status/menu/interactive text into Bale-safe plain text and HTML chunks with chunk-boundary handling
 */
export declare const MAX_MESSAGE_LENGTH = 4096;
export declare function escapeHtml(text: string): string;
export declare function escapeHtmlAttribute(text: string): string;
export declare function chunkHtmlPreservingTags(html: string, maxLength: number): string[];
export declare function renderBaleInlineMarkdownHtml(text: string, options?: {
    allowLinks?: boolean;
}): string;
export type BaleRenderMode = "plain" | "markdown" | "html";
export interface BaleRenderedChunk {
    text: string;
    parseMode?: "HTML";
}
export declare function renderBaleMessage(text: string, options?: {
    mode?: BaleRenderMode;
}): BaleRenderedChunk[];

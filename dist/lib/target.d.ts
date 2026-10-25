/**
 * Bale transport destination value helpers
 * Zones: Bot API transport, routing, replies/previews, ownership, multi-instance bus
 * Owns the minimal `{ chatId, threadId? }` address shape shared by classic private chats
 * and Bale UI threads mapped through Bot API `message_thread_id`.
 */
export interface BaleTarget {
    chatId: number;
    threadId?: number;
}
export declare function createBalePrivateTarget(chatId: number): BaleTarget;
export declare function createBaleThreadTarget(chatId: number, threadId: number): BaleTarget;
export declare function getBaleTargetKey(target: BaleTarget): string;
export declare function isBaleThreadTarget(target: BaleTarget): target is BaleTarget & {
    threadId: number;
};
export declare function areBaleTargetsEqual(left: BaleTarget, right: BaleTarget): boolean;
export declare function getBaleTargetThreadParams(target: BaleTarget): {
    message_thread_id?: number;
};
/** Pure wire parser for `{ chatId, threadId? }`; unknown fields are dropped and malformed shapes refuse. */
export declare function parseBaleTarget(value: unknown): BaleTarget | undefined;
/** Pure Bot API integer id parser accepting integer numbers or non-blank integer strings. */
export declare function parseBaleIntegerId(value: unknown): number | undefined;

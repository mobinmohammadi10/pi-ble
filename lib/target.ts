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

const PRIVATE_TARGET_THREAD_KEY = "private";

export function createBalePrivateTarget(chatId: number): BaleTarget {
  return { chatId };
}

export function createBaleThreadTarget(
  chatId: number,
  threadId: number,
): BaleTarget {
  return { chatId, threadId };
}

export function getBaleTargetKey(target: BaleTarget): string {
  return `${target.chatId}:${target.threadId ?? PRIVATE_TARGET_THREAD_KEY}`;
}

export function isBaleThreadTarget(
  target: BaleTarget,
): target is BaleTarget & { threadId: number } {
  return Number.isInteger(target.threadId);
}

export function areBaleTargetsEqual(
  left: BaleTarget,
  right: BaleTarget,
): boolean {
  return left.chatId === right.chatId && left.threadId === right.threadId;
}

export function getBaleTargetThreadParams(target: BaleTarget): {
  message_thread_id?: number;
} {
  return isBaleThreadTarget(target)
    ? { message_thread_id: target.threadId }
    : {};
}

/** Pure wire parser for `{ chatId, threadId? }`; unknown fields are dropped and malformed shapes refuse. */
export function parseBaleTarget(
  value: unknown,
): BaleTarget | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return undefined;
  const { chatId, threadId } = value as Record<string, unknown>;
  if (typeof chatId !== "number") return undefined;
  return typeof threadId === "number" ? { chatId, threadId } : { chatId };
}

/** Pure Bot API integer id parser accepting integer numbers or non-blank integer strings. */
export function parseBaleIntegerId(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value !== "string" || value.trim() === "") return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : undefined;
}

/**
 * Durable Workspace identity value construction
 * Zones: workspace identity, session identity, key encoding
 * Owns exact session/CWD normalization, bounded keys and local instance-slot encoding.
 * Excludes allocation, bindings/targets, storage-reference approval, custody and effects.
 */
import { createHash } from "node:crypto";
import { posix, resolve } from "node:path";

export interface BaleWorkspaceBindingIdentity {
  cwd: string;
  workspaceKey: string;
  /** Exact durable Pi session identity; absent only on legacy cwd-only bindings. */
  sessionId?: string;
  /** Full SHA-256 index component for session-qualified bindings. */
  sessionKey?: string;
  /** Immutable legacy binding-key component, not the displayed global letter. */
  instanceSlot: string;
  bindingKey: string;
  /** Profile-wide letter reserved by the transient claim. */
  slot?: string;
}

export const BALE_WORKSPACE_KEY_MAX_LENGTH = 180;
const BALE_SESSION_ID_MAX_LENGTH = 256;

export function normalizeBaleSessionId(
  sessionId: string,
): string | undefined {
  if (typeof sessionId !== "string") return undefined;
  const normalized = sessionId.trim();
  return normalized &&
    Buffer.byteLength(normalized, "utf8") <= BALE_SESSION_ID_MAX_LENGTH
    ? normalized
    : undefined;
}

export function createBaleSessionKey(
  sessionId: string,
): string | undefined {
  const normalized = normalizeBaleSessionId(sessionId);
  return normalized
    ? createHash("sha256").update(normalized).digest("hex")
    : undefined;
}

export function normalizeBaleWorkspacePath(
  cwd: string,
): string | undefined {
  const trimmed = cwd.trim();
  if (!trimmed) return undefined;
  const normalized = trimmed.startsWith("/")
    ? posix.normalize(trimmed)
    : resolve(trimmed).replaceAll("\\", "/");
  const withoutTrailingSeparators =
    normalized.length > 1 ? normalized.replace(/\/+$/u, "") : normalized;
  return process.platform === "win32"
    ? withoutTrailingSeparators.replace(
        /^([A-Z]):/u,
        (_, drive: string) => `${drive.toLowerCase()}:`,
      )
    : withoutTrailingSeparators;
}

export function createBaleWorkspaceDirectoryKey(
  cwd: string,
): string | undefined {
  const normalized = normalizeBaleWorkspacePath(cwd);
  if (!normalized) return undefined;
  const readable =
    normalized.replace(/[^\p{L}\p{N}._-]+/gu, "-").replace(/^-+|-+$/gu, "") ||
    "root";
  const candidate = `--${readable}--`;
  if (candidate.length <= BALE_WORKSPACE_KEY_MAX_LENGTH) return candidate;
  const digest = createHash("sha256")
    .update(normalized)
    .digest("hex")
    .slice(0, 12);
  const prefixLength = BALE_WORKSPACE_KEY_MAX_LENGTH - digest.length - 5;
  return `--${readable.slice(0, prefixLength)}-${digest}--`;
}

function createBaleWorkspaceInstanceSlot(
  ordinal: number,
): string | undefined {
  if (!Number.isSafeInteger(ordinal) || ordinal < 0) return undefined;
  let value = ordinal + 1;
  let slot = "";
  while (value > 0) {
    value -= 1;
    slot = String.fromCharCode(97 + (value % 26)) + slot;
    value = Math.floor(value / 26);
  }
  return slot;
}

export function createBaleWorkspaceBindingIdentityWithKey(
  cwd: string,
  workspaceKey: string,
  ordinal: number,
  sessionId?: string,
): BaleWorkspaceBindingIdentity | undefined {
  const instanceSlot = createBaleWorkspaceInstanceSlot(ordinal);
  if (!instanceSlot) return undefined;
  const normalizedSessionId =
    sessionId === undefined ? undefined : normalizeBaleSessionId(sessionId);
  const sessionKey = normalizedSessionId
    ? createBaleSessionKey(normalizedSessionId)
    : undefined;
  if (sessionId !== undefined && (!normalizedSessionId || !sessionKey)) {
    return undefined;
  }
  const legacyBindingKey =
    instanceSlot === "a" ? workspaceKey : `${workspaceKey}${instanceSlot}`;
  return {
    cwd,
    workspaceKey,
    ...(normalizedSessionId && sessionKey
      ? { sessionId: normalizedSessionId, sessionKey }
      : {}),
    instanceSlot,
    bindingKey: sessionKey
      ? `${legacyBindingKey}-s-${sessionKey}`
      : legacyBindingKey,
  };
}

export function createBaleWorkspaceBindingIdentity(
  cwd: string,
  ordinal = 0,
  sessionId?: string,
): BaleWorkspaceBindingIdentity | undefined {
  const normalized = normalizeBaleWorkspacePath(cwd);
  const workspaceKey = normalized
    ? createBaleWorkspaceDirectoryKey(normalized)
    : undefined;
  if (!normalized || !workspaceKey) return undefined;
  return createBaleWorkspaceBindingIdentityWithKey(
    normalized,
    workspaceKey,
    ordinal,
    sessionId,
  );
}

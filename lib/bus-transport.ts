/**
 * Bale bus local transport boundary
 * Zones: multi-instance bus, IPC transport, Windows named pipes, Unix sockets
 * Owns endpoint derivation, transport-kind detection, retry/error classification, and small timing policy.
 */

import { createHash } from "node:crypto";
import { createConnection } from "node:net";
import { isAbsolute, join, resolve } from "node:path";

import { resolveBaleRuntimeDir, resolveBaleTempDir } from "./paths.ts";

export type BaleBusEndpointLayout = "consolidated";
export const BALE_BUS_MAX_DIRECT_UNIX_ENDPOINT_BYTES = 80;

function requireConsolidatedUnixEndpoint(path: string): string {
  if (!isAbsolute(path) || resolve(path) !== path)
    throw new Error(
      "Consolidated Bale IPC requires an exact absolute runtime path.",
    );
  // Over-budget logical paths keep their identity; socket resolution applies the bounded private external fallback.
  return path;
}

export type BaleBusTransportKind = "pipe" | "socket";

export type BaleBusTransportEventRecorder = (
  phase: string,
  details: Record<string, unknown>,
) => void;

export type BaleBusTransportEndpointDiagnostics = Record<
  string,
  unknown
> & {
  endpoint: string;
  transport: BaleBusTransportKind;
};

export interface BaleBusTransportRetryPolicy {
  attempts: number;
  delayMs: number;
}

export interface BaleBusTransportRetryPolicyOverrides {
  attempts?: number;
  delayMs?: number;
}

export type BaleBusTransportOperation = "registration" | "operation";

export const BALE_BUS_REGISTRATION_RETRY: BaleBusTransportRetryPolicy =
  {
    attempts: 10,
    delayMs: 150,
  };

const BALE_BUS_OPERATION_RETRY: BaleBusTransportRetryPolicy = {
  attempts: 3,
  delayMs: 100,
};

export function getBaleBusPipePath(input: {
  agentDir: string;
  scope: string;
}): string {
  const digest = createHash("sha256")
    .update(resolve(input.agentDir))
    .digest("base64url")
    .slice(0, 16);
  const scope = input.scope.replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 80);
  return `\\\\.\\pipe\\pi-bale-${digest}-${scope}`;
}

export function isBaleBusPipePath(endpoint: string): boolean {
  return /^\\\\[.?]\\pipe\\/i.test(endpoint);
}

export function getBaleBusTransportKind(
  endpoint: string,
): BaleBusTransportKind {
  return isBaleBusPipePath(endpoint) ? "pipe" : "socket";
}

export function getBaleBusEndpointDiagnostics(
  endpoint: string,
): BaleBusTransportEndpointDiagnostics {
  return {
    endpoint,
    transport: getBaleBusTransportKind(endpoint),
  };
}

export function getBaleBusTransportRetryPolicy(input: {
  endpoint: string;
  operation: BaleBusTransportOperation;
  overrides?: BaleBusTransportRetryPolicyOverrides;
}): BaleBusTransportRetryPolicy | undefined {
  const base =
    input.operation === "registration"
      ? BALE_BUS_REGISTRATION_RETRY
      : isBaleBusPipePath(input.endpoint)
        ? BALE_BUS_OPERATION_RETRY
        : undefined;
  if (!base && !input.overrides) return undefined;
  return {
    attempts: Math.max(1, input.overrides?.attempts ?? base?.attempts ?? 1),
    delayMs: Math.max(0, input.overrides?.delayMs ?? base?.delayMs ?? 0),
  };
}

function normalizeBaleBusEndpointScope(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 80);
}

/** Consolidated endpoints hash their identity so profile/instance names never reach the path. */
function getConsolidatedBaleBusEndpoint(
  input: { agentDir: string; platform: NodeJS.Platform | string },
  identity: readonly string[],
  pipePrefix: string,
  socketPrefix: string,
): string {
  const scope = createHash("sha256")
    .update(JSON.stringify(identity))
    .digest("hex")
    .slice(0, 16);
  return input.platform === "win32"
    ? getBaleBusPipePath({
        agentDir: input.agentDir,
        scope: `${pipePrefix}-${scope}`,
      })
    : requireConsolidatedUnixEndpoint(
        join(
          resolveBaleRuntimeDir(input.agentDir),
          `${socketPrefix}.${scope}.sock`,
        ),
      );
}

export function getBaleBusLeaderEndpoint(input: {
  agentDir: string;
  platform: NodeJS.Platform | string;
  profileName?: string;
  layout?: BaleBusEndpointLayout;
}): string {
  if (input.layout !== undefined && input.layout !== "consolidated")
    throw new Error("Bale IPC layout is invalid.");
  if (input.layout === "consolidated") {
    return getConsolidatedBaleBusEndpoint(
      input,
      [input.profileName ?? "default"],
      "bus",
      "bus",
    );
  }
  const profileScope = input.profileName
    ? normalizeBaleBusEndpointScope(input.profileName)
    : undefined;
  return input.platform === "win32"
    ? getBaleBusPipePath({
        agentDir: input.agentDir,
        scope: profileScope ? `bus-${profileScope}` : "bus",
      })
    : join(
        resolveBaleTempDir(input.agentDir),
        profileScope ? `bus.${profileScope}.sock` : "bus.sock",
      );
}

export function getBaleBusFollowerEndpoint(input: {
  agentDir: string;
  platform: NodeJS.Platform | string;
  instanceId: string;
  profileName?: string;
  layout?: BaleBusEndpointLayout;
}): string {
  if (input.layout !== undefined && input.layout !== "consolidated")
    throw new Error("Bale IPC layout is invalid.");
  if (input.layout === "consolidated") {
    return getConsolidatedBaleBusEndpoint(
      input,
      [input.profileName ?? "default", input.instanceId],
      "follower",
      "f",
    );
  }
  const instanceScope = normalizeBaleBusEndpointScope(input.instanceId);
  const profileScope = input.profileName
    ? normalizeBaleBusEndpointScope(input.profileName)
    : undefined;
  return input.platform === "win32"
    ? getBaleBusPipePath({
        agentDir: input.agentDir,
        scope: profileScope
          ? `follower-${profileScope}-${instanceScope}`
          : `follower-${instanceScope}`,
      })
    : join(
        resolveBaleTempDir(input.agentDir),
        "followers",
        ...(profileScope ? [profileScope] : []),
        `${instanceScope}.sock`,
      );
}

export interface BaleBusTransportErrorInfo {
  message: string;
  code?: string;
  syscall?: string;
  kind: "connect" | "timeout" | "auth" | "protocol" | "unknown";
  retryable: boolean;
}

export function classifyBaleBusTransportError(
  error: unknown,
): BaleBusTransportErrorInfo {
  const message = error instanceof Error ? error.message : String(error);
  const maybeNodeError = error as NodeJS.ErrnoException;
  const code =
    typeof maybeNodeError?.code === "string" ? maybeNodeError.code : undefined;
  const syscall =
    typeof maybeNodeError?.syscall === "string"
      ? maybeNodeError.syscall
      : undefined;
  const timeout = code === "ETIMEDOUT" || /timed out/i.test(message);
  const retryable =
    code === "ENOENT" ||
    code === "ECONNREFUSED" ||
    code === "EPIPE" ||
    code === "ECONNRESET" ||
    code === "EBUSY" ||
    timeout;
  const kind = timeout
    ? "timeout"
    : code === "ENOENT" || code === "ECONNREFUSED"
      ? "connect"
      : "unknown";
  return { message, code, syscall, kind, retryable };
}

export function isRetryableBaleBusTransportError(error: unknown): boolean {
  return classifyBaleBusTransportError(error).retryable;
}

export function createBaleBusTransportTimeoutError(
  message: string,
): NodeJS.ErrnoException {
  const error = new Error(message) as NodeJS.ErrnoException;
  error.code = "ETIMEDOUT";
  return error;
}

export function delayBaleBusTransportRetry(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export interface BaleBusTransportProbeResult extends BaleBusTransportEndpointDiagnostics {
  reachable: boolean;
  error?: BaleBusTransportErrorInfo;
}

export function probeBaleBusEndpoint(input: {
  endpoint: string;
  timeoutMs?: number;
}): Promise<BaleBusTransportProbeResult> {
  const timeoutMs = input.timeoutMs ?? 250;
  const diagnostics = getBaleBusEndpointDiagnostics(input.endpoint);
  return new Promise((resolve) => {
    const socket = createConnection(input.endpoint);
    let settled = false;
    const settle = (result: BaleBusTransportProbeResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.destroy();
      resolve(result);
    };
    const timeout = setTimeout(() => {
      settle({
        ...diagnostics,
        reachable: false,
        error: classifyBaleBusTransportError(
          createBaleBusTransportTimeoutError(
            "Timed out probing Bale bus endpoint",
          ),
        ),
      });
    }, timeoutMs);
    socket.once("connect", () => settle({ ...diagnostics, reachable: true }));
    socket.once("error", (error) =>
      settle({
        ...diagnostics,
        reachable: false,
        error: classifyBaleBusTransportError(error),
      }),
    );
  });
}

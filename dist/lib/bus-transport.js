/**
 * Bale bus local transport boundary
 * Zones: multi-instance bus, IPC transport, Windows named pipes, Unix sockets
 * Owns endpoint derivation, transport-kind detection, retry/error classification, and small timing policy.
 */
import { createHash } from "node:crypto";
import { createConnection } from "node:net";
import { isAbsolute, join, resolve } from "node:path";
import { resolveBaleRuntimeDir, resolveBaleTempDir } from "./paths.js";
export const BALE_BUS_MAX_DIRECT_UNIX_ENDPOINT_BYTES = 80;
function requireConsolidatedUnixEndpoint(path) {
    if (!isAbsolute(path) || resolve(path) !== path)
        throw new Error("Consolidated Bale IPC requires an exact absolute runtime path.");
    // Over-budget logical paths keep their identity; socket resolution applies the bounded private external fallback.
    return path;
}
export const BALE_BUS_REGISTRATION_RETRY = {
    attempts: 10,
    delayMs: 150,
};
const BALE_BUS_OPERATION_RETRY = {
    attempts: 3,
    delayMs: 100,
};
export function getBaleBusPipePath(input) {
    const digest = createHash("sha256")
        .update(resolve(input.agentDir))
        .digest("base64url")
        .slice(0, 16);
    const scope = input.scope.replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 80);
    return `\\\\.\\pipe\\pi-bale-${digest}-${scope}`;
}
export function isBaleBusPipePath(endpoint) {
    return /^\\\\[.?]\\pipe\\/i.test(endpoint);
}
export function getBaleBusTransportKind(endpoint) {
    return isBaleBusPipePath(endpoint) ? "pipe" : "socket";
}
export function getBaleBusEndpointDiagnostics(endpoint) {
    return {
        endpoint,
        transport: getBaleBusTransportKind(endpoint),
    };
}
export function getBaleBusTransportRetryPolicy(input) {
    const base = input.operation === "registration"
        ? BALE_BUS_REGISTRATION_RETRY
        : isBaleBusPipePath(input.endpoint)
            ? BALE_BUS_OPERATION_RETRY
            : undefined;
    if (!base && !input.overrides)
        return undefined;
    return {
        attempts: Math.max(1, input.overrides?.attempts ?? base?.attempts ?? 1),
        delayMs: Math.max(0, input.overrides?.delayMs ?? base?.delayMs ?? 0),
    };
}
function normalizeBaleBusEndpointScope(value) {
    return value.replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 80);
}
/** Consolidated endpoints hash their identity so profile/instance names never reach the path. */
function getConsolidatedBaleBusEndpoint(input, identity, pipePrefix, socketPrefix) {
    const scope = createHash("sha256")
        .update(JSON.stringify(identity))
        .digest("hex")
        .slice(0, 16);
    return input.platform === "win32"
        ? getBaleBusPipePath({
            agentDir: input.agentDir,
            scope: `${pipePrefix}-${scope}`,
        })
        : requireConsolidatedUnixEndpoint(join(resolveBaleRuntimeDir(input.agentDir), `${socketPrefix}.${scope}.sock`));
}
export function getBaleBusLeaderEndpoint(input) {
    if (input.layout !== undefined && input.layout !== "consolidated")
        throw new Error("Bale IPC layout is invalid.");
    if (input.layout === "consolidated") {
        return getConsolidatedBaleBusEndpoint(input, [input.profileName ?? "default"], "bus", "bus");
    }
    const profileScope = input.profileName
        ? normalizeBaleBusEndpointScope(input.profileName)
        : undefined;
    return input.platform === "win32"
        ? getBaleBusPipePath({
            agentDir: input.agentDir,
            scope: profileScope ? `bus-${profileScope}` : "bus",
        })
        : join(resolveBaleTempDir(input.agentDir), profileScope ? `bus.${profileScope}.sock` : "bus.sock");
}
export function getBaleBusFollowerEndpoint(input) {
    if (input.layout !== undefined && input.layout !== "consolidated")
        throw new Error("Bale IPC layout is invalid.");
    if (input.layout === "consolidated") {
        return getConsolidatedBaleBusEndpoint(input, [input.profileName ?? "default", input.instanceId], "follower", "f");
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
        : join(resolveBaleTempDir(input.agentDir), "followers", ...(profileScope ? [profileScope] : []), `${instanceScope}.sock`);
}
export function classifyBaleBusTransportError(error) {
    const message = error instanceof Error ? error.message : String(error);
    const maybeNodeError = error;
    const code = typeof maybeNodeError?.code === "string" ? maybeNodeError.code : undefined;
    const syscall = typeof maybeNodeError?.syscall === "string"
        ? maybeNodeError.syscall
        : undefined;
    const timeout = code === "ETIMEDOUT" || /timed out/i.test(message);
    const retryable = code === "ENOENT" ||
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
export function isRetryableBaleBusTransportError(error) {
    return classifyBaleBusTransportError(error).retryable;
}
export function createBaleBusTransportTimeoutError(message) {
    const error = new Error(message);
    error.code = "ETIMEDOUT";
    return error;
}
export function delayBaleBusTransportRetry(ms) {
    return new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
}
export function probeBaleBusEndpoint(input) {
    const timeoutMs = input.timeoutMs ?? 250;
    const diagnostics = getBaleBusEndpointDiagnostics(input.endpoint);
    return new Promise((resolve) => {
        const socket = createConnection(input.endpoint);
        let settled = false;
        const settle = (result) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timeout);
            socket.destroy();
            resolve(result);
        };
        const timeout = setTimeout(() => {
            settle({
                ...diagnostics,
                reachable: false,
                error: classifyBaleBusTransportError(createBaleBusTransportTimeoutError("Timed out probing Bale bus endpoint")),
            });
        }, timeoutMs);
        socket.once("connect", () => settle({ ...diagnostics, reachable: true }));
        socket.once("error", (error) => settle({
            ...diagnostics,
            reachable: false,
            error: classifyBaleBusTransportError(error),
        }));
    });
}

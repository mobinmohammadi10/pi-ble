/**
 * Bale bridge path resolution for Pi-compatible runtimes
 * Zones: telemetry paths, filesystem, runtime identity
 * Owns agent-dir detection and extension-local path derivation
 */

import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";

export const BALE_DEFAULT_PROFILE_NAME = "default";

export interface BaleAgentDirResolutionInput {
  env?: Partial<Pick<NodeJS.ProcessEnv, "PI_CODING_AGENT_DIR">>;
  execPath?: string;
  argv?: readonly string[];
}

/**
 * Resolve the agent data directory for the current Pi-compatible runtime.
 *
 * Precedence:
 * 1. `PI_CODING_AGENT_DIR` env variable, when explicitly set.
 * 2. Detect Pi-compatible runtime identity from the executable or argv[1]
 *    (e.g. OMP vs standard Pi agent).
 * 3. Fallback: `~/.pi/agent`.
 */
export function resolveAgentDir(
  input: BaleAgentDirResolutionInput = {},
): string {
  const env = input.env ?? process.env;
  if (env.PI_CODING_AGENT_DIR) return resolve(env.PI_CODING_AGENT_DIR);
  const execPath = input.execPath ?? process.execPath;
  const argv = input.argv ?? process.argv;
  const execBasename = execPath.toLowerCase().split(/[\\/]/u).pop() ?? "";
  const argv1Last = (argv[1] ?? "").toLowerCase().split(/[\\/]/u).pop() ?? "";
  if (execBasename.startsWith("omp") || argv1Last.startsWith("omp")) {
    return join(homedir(), ".omp", "agent");
  }
  return join(homedir(), ".pi", "agent");
}

/**
 * Pure reference preflight against an independently approved resource path.
 * Reject aliases; never repair relative historical references or redirect storage.
 * Equality proves spelling only, not file identity, consumer closure or migration readiness.
 */
export function requireBaleStoragePathReference(
  path: string,
  expectedPath: string,
): string {
  if (
    typeof path !== "string" ||
    typeof expectedPath !== "string" ||
    !isAbsolute(path) ||
    resolve(path) !== path ||
    !isAbsolute(expectedPath) ||
    resolve(expectedPath) !== expectedPath ||
    path !== expectedPath
  ) {
    throw new Error(
      "Bale storage reference does not match its approved absolute path.",
    );
  }
  return path;
}

/** Bale bridge configuration file (<agentDir>/bale.json). */
export function resolveBaleConfigPath(): string {
  return join(resolveAgentDir(), "bale.json");
}

/**
 * Resolve symlinks in the longest existing prefix of `path` and keep the missing suffix. Strict journal reads require
 * canonical anchors, so a symlinked agent directory (for example macOS `/var` → `/private/var`) must not leak in.
 * Relative input is returned unchanged so callers' exact-absolute-path guards still reject it. On Windows only
 * drive-letter and UNC paths resolve; resolving a drive-less root would add the current drive.
 */
function canonicalizeExistingPrefix(path: string): string {
  if (
    !isAbsolute(path) ||
    (process.platform === "win32" && !/^(?:[a-zA-Z]:[\\/]|\\\\)/u.test(path))
  )
    return path;
  const absolute = resolve(path);
  const missing: string[] = [];
  for (let current = absolute; ; current = dirname(current)) {
    try {
      return join(realpathSync(current), ...missing.reverse());
    } catch (error) {
      if (
        (error as { code?: unknown }).code !== "ENOENT" ||
        dirname(current) === current
      )
        return absolute;
      missing.push(basename(current));
    }
  }
}

/** Bale bridge temporary directory (<agentDir>/tmp/pi-bale); releases before 0.52.0 used `tmp/bale`. */
export function resolveBaleTempDir(agentDir = resolveAgentDir()): string {
  return join(canonicalizeExistingPrefix(agentDir), "tmp", "pi-bale");
}

/** Consolidated-root service artifacts (transaction guards, staging and IPC), never session custody. */
export function resolveBaleRuntimeDir(
  agentDir = resolveAgentDir(),
): string {
  return join(resolveBaleTempDir(agentDir), "runtime");
}

/** Rotated shared runtime event segments, outside the persistent root-file census. */
export function resolveBaleRuntimeLogsDir(
  agentDir = resolveAgentDir(),
): string {
  return join(resolveBaleTempDir(agentDir), "logs");
}

/** Consolidated runtime state for every logical profile (`tmp/pi-bale/state.json`). */
export function resolveBaleStatePath(agentDir = resolveAgentDir()): string {
  return join(resolveBaleTempDir(agentDir), "state.json");
}

/** Flat attachment scratch directory (<agentDir>/tmp/pi-bale/attachments). */
export function resolveBaleAttachmentsDir(
  agentDir = resolveAgentDir(),
): string {
  return join(resolveBaleTempDir(agentDir), "attachments");
}

/** Read-only pre-0.52.0 ownership file, consulted only to refuse a second poller beside a live older leader. */
export function resolveLegacyBaleOwnersPath(
  agentDir = resolveAgentDir(),
): string {
  return join(agentDir, "tmp", "bale", "owners.json");
}

/** Bale transport ownership store (<agentDir>/tmp/pi-bale/owners.json). */
export function resolveBaleOwnersPath(): string {
  return join(resolveBaleTempDir(), "owners.json");
}

export function getBaleProfilePathSuffix(profileName?: string): string {
  if (!profileName || profileName === BALE_DEFAULT_PROFILE_NAME) return "";
  return `.${profileName.replace(/[^a-zA-Z0-9._-]+/g, "_")}`;
}

export function resolveBaleProfileTempFilePath(
  baseName: string,
  extension: string,
  agentDir = resolveAgentDir(),
  profileName?: string,
): string {
  return join(
    resolveBaleTempDir(agentDir),
    `${baseName}${getBaleProfilePathSuffix(profileName)}.${extension}`,
  );
}

/** Shared state/log paths for every profile, under the resolved agent dir (honors `PI_CODING_AGENT_DIR`). */
export function getBaleDiagnosticsDisplayPaths(
  _profileName?: string,
  agentDir = resolveAgentDir(),
): {
  state: string;
  logs: string;
} {
  // Storage paths are canonical, so also match a canonical home (e.g. /home -> /var/home).
  const homes = [homedir()];
  try {
    homes.push(realpathSync(homes[0]!));
  } catch {
    /* An unreadable home only loses the ~ abbreviation. */
  }
  const display = (path: string): string => {
    const home = homes.find(
      (candidate) => path === candidate || path.startsWith(`${candidate}${sep}`),
    );
    return home
      ? `~${path.slice(home.length).split(sep).join("/")}`
      : path;
  };
  return {
    state: display(resolveBaleStatePath(agentDir)),
    logs: display(resolveBaleRuntimeLogPath(agentDir)),
  };
}

/** Durable Workspace admission ledger (<agentDir>/tmp/pi-bale/workspace-admission[.<profile>].json). */
export function resolveBaleWorkspaceAdmissionPath(
  agentDir = resolveAgentDir(),
  profileName?: string,
): string {
  return resolveBaleProfileTempFilePath(
    "workspace-admission",
    "json",
    agentDir,
    profileName,
  );
}

/** Profile-only callback shape; binds storage to the configured agent directory. */
export function resolveBaleWorkspaceAdmissionPathForProfile(
  profileName?: string,
): string {
  return resolveBaleWorkspaceAdmissionPath(resolveAgentDir(), profileName);
}

/** Consolidated non-session service journal (`journals/<kind>.<profile sha256>.json`) and its runtime namespace. */
export function resolveBaleServiceJournalStorage(
  kind: "thread-cleanup" | "channel-posts",
  agentDir = resolveAgentDir(),
  profileName = BALE_DEFAULT_PROFILE_NAME,
): { path: string; runtimeDir: string } {
  const profileHash = createHash("sha256").update(profileName).digest("hex");
  return {
    path: join(
      resolveBaleTempDir(agentDir),
      "journals",
      `${kind}.${profileHash}.json`,
    ),
    runtimeDir: resolveBaleRuntimeDir(agentDir),
  };
}

/** Bind one non-session journal to its exact colocated-root service namespace, never a format fallback. */
export function getBaleJournalPublicationPaths(
  path: string,
  runtimeDir?: string,
): {
  transactionPath: string;
  temporaryBasePath: string;
} {
  if (runtimeDir === undefined)
    return { transactionPath: `${path}.transaction`, temporaryBasePath: path };
  requireBaleStoragePathReference(path, resolve(path));
  requireBaleStoragePathReference(
    runtimeDir,
    join(dirname(dirname(path)), "runtime"),
  );
  if (basename(dirname(path)) !== "journals")
    throw new Error(
      "Bale service journal must use its journals namespace.",
    );
  return {
    transactionPath: join(runtimeDir, `${basename(path)}.transaction`),
    temporaryBasePath: join(runtimeDir, basename(path)),
  };
}

/** Durable inactive Thread cleanup work-set journal. */
export function resolveBaleThreadCleanupWorkPath(
  agentDir = resolveAgentDir(),
  profileName?: string,
): string {
  return resolveBaleProfileTempFilePath(
    "thread-cleanup",
    "json",
    agentDir,
    profileName,
  );
}

/** Durable agent-authored channel post journal. */
export function resolveBaleChannelPostJournalPath(
  agentDir = resolveAgentDir(),
  profileName?: string,
): string {
  return resolveBaleProfileTempFilePath(
    "channel-posts",
    "json",
    agentDir,
    profileName,
  );
}

/** Durable inbound update journal (<agentDir>/tmp/pi-bale/inbox[.<profile>].json). */
export function resolveBaleUpdateJournalPath(
  agentDir = resolveAgentDir(),
  profileName?: string,
): string {
  return resolveBaleProfileTempFilePath(
    "inbox",
    "json",
    agentDir,
    profileName,
  );
}

/** Profile-only callback shape; binds storage to the configured agent directory. */
export function resolveBaleUpdateJournalPathForProfile(
  profileName?: string,
): string {
  return resolveBaleUpdateJournalPath(resolveAgentDir(), profileName);
}

/** Durable follower delivery journal, isolated by stable recipient binding. */
export function resolveBaleFollowerJournalPath(
  recipientBindingKey: string,
  agentDir = resolveAgentDir(),
  profileName?: string,
): string {
  if (!recipientBindingKey) {
    throw new Error("Bale follower journal binding key is required.");
  }
  const bindingHash = createHash("sha256")
    .update(recipientBindingKey)
    .digest("hex")
    .slice(0, 16);
  return resolveBaleProfileTempFilePath(
    `follower-inbox-${bindingHash}`,
    "json",
    agentDir,
    profileName,
  );
}

const BALE_SESSION_DIRECTORY_MAX_LENGTH = 200;
const WINDOWS_RESERVED_NAME =
  /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\..*)?$/u;

/**
 * Directory name for a session id. Lowercase letters, digits, `_`, `-` and inner `.` stay verbatim, so every real
 * (UUID-shaped) id is unchanged; any other UTF-8 byte is percent-encoded. Uppercase is encoded so case-insensitive
 * filesystems never merge two sessions; a leading or trailing dot and Windows reserved names are encoded so the name
 * can never be `.`/`..`, hidden, or a device. The encoding is reversible; an empty or over-long result is refused.
 */
export function encodeBaleSessionDirectoryName(
  sessionId: string,
): string | undefined {
  if (typeof sessionId !== "string" || sessionId.length === 0) return undefined;
  const bytes = Buffer.from(sessionId, "utf8");
  if (bytes.toString("utf8") !== sessionId) return undefined;
  let name = "";
  bytes.forEach((byte, index) => {
    const char = String.fromCharCode(byte);
    const safe =
      /[a-z0-9_-]/u.test(char) ||
      (char === "." && index > 0 && index < bytes.length - 1);
    name += safe
      ? char
      : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  });
  if (WINDOWS_RESERVED_NAME.test(name))
    name = `%${name.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}${name.slice(1)}`;
  return name.length <= BALE_SESSION_DIRECTORY_MAX_LENGTH
    ? name
    : undefined;
}

/** Inverse of `encodeBaleSessionDirectoryName`; undefined unless the name is exactly canonical. */
export function decodeBaleSessionDirectoryName(
  name: string,
): string | undefined {
  if (!/^[a-z0-9_.%A-F-]+$/u.test(name)) return undefined;
  const bytes: number[] = [];
  for (let index = 0; index < name.length; index++) {
    if (name[index] === "%") {
      const hex = name.slice(index + 1, index + 3);
      if (!/^[0-9A-F]{2}$/u.test(hex)) return undefined;
      bytes.push(Number.parseInt(hex, 16));
      index += 2;
    } else bytes.push(name.charCodeAt(index));
  }
  const decoded = Buffer.from(bytes).toString("utf8");
  return encodeBaleSessionDirectoryName(decoded) === name
    ? decoded
    : undefined;
}

/** Root of every session folder (<agentDir>/tmp/pi-bale/sessions). */
export function resolveBaleSessionsDir(
  agentDir = resolveAgentDir(),
): string {
  return join(resolveBaleTempDir(agentDir), "sessions");
}

/** One session's folder (<agentDir>/tmp/pi-bale/sessions/<session id>). */
export function resolveBaleSessionDir(
  sessionId: string,
  agentDir = resolveAgentDir(),
): string {
  const name = encodeBaleSessionDirectoryName(sessionId);
  if (!name)
    throw new Error("Bale session directory requires a usable session id.");
  return join(resolveBaleSessionsDir(agentDir), name);
}

/** Hash naming one recipient incarnation inside its session folder; unchanged from the former follower inbox. */
export function getBaleRecipientJournalHash(
  recipientBindingKey: string,
): string {
  if (!recipientBindingKey)
    throw new Error("Bale session journal binding key is required.");
  return createHash("sha256")
    .update(recipientBindingKey)
    .digest("hex")
    .slice(0, 16);
}

/** Durable per-session journal (`sessions/<session id>/journal.<hash>[.<profile>].json`); the name never reveals a role. */
export function resolveBaleSessionJournalPath(
  sessionId: string,
  recipientBindingKey: string,
  agentDir = resolveAgentDir(),
  profileName?: string,
): string {
  return join(
    resolveBaleSessionDir(sessionId, agentDir),
    `journal.${getBaleRecipientJournalHash(recipientBindingKey)}${getBaleProfilePathSuffix(profileName)}.json`,
  );
}

/** Leader polling journal hosted by the session that first led (`sessions/<id>/inbox[.<profile>].json`); owners.json names it. */
export function resolveBaleSessionPollingJournalPath(
  sessionId: string,
  agentDir = resolveAgentDir(),
  profileName?: string,
): string {
  return join(
    resolveBaleSessionDir(sessionId, agentDir),
    `inbox${getBaleProfilePathSuffix(profileName)}.json`,
  );
}

/** Accept only a canonical `sessions/<id>/inbox[.<profile>].json` beneath this agent's runtime. */
export function isBaleSessionPollingJournalPath(
  path: string,
  agentDir = resolveAgentDir(),
): boolean {
  const parts = relative(resolveBaleSessionsDir(agentDir), path).split(sep);
  return (
    isAbsolute(path) &&
    parts.length === 2 &&
    decodeBaleSessionDirectoryName(parts[0]!) !== undefined &&
    /^inbox(?:\.[a-zA-Z0-9._-]+)?\.json$/u.test(parts[1]!)
  );
}

/** Runtime event log (<agentDir>/tmp/pi-bale/logs.jsonl). */
export function resolveBaleRuntimeLogPath(
  agentDir = resolveAgentDir(),
): string {
  return resolveBaleProfileTempFilePath("logs", "jsonl", agentDir);
}

/** Bounded previous shared log segment below `logs/`. */
export function resolveBalePreviousSharedRuntimeLogPath(
  agentDir = resolveAgentDir(),
): string {
  return join(resolveBaleRuntimeLogsDir(agentDir), "logs._prev.jsonl");
}

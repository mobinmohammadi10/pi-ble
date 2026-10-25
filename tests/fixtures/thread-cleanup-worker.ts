import { closeSync, openSync, writeFileSync } from "node:fs";
import {
  createBaleInactiveThreadCleanupSettingsPort,
  createBaleThreadCleanupPermitRuntime,
  createBaleThreadCleanupWorkStore,
  type BaleThreadCleanupCandidate,
} from "../../lib/thread-cleanup-manager.ts";
import { createBaleWorkspaceAdmissionLedger } from "../../lib/workspace-admission.ts";

const [workPath, ledgerPath, markerPath, attemptDir, operationId, candidateJson] = process.argv.slice(2);
if (!workPath || !ledgerPath || !markerPath || !attemptDir || !operationId || !candidateJson)
  throw new Error("thread cleanup worker arguments are required");
const candidate = JSON.parse(candidateJson) as BaleThreadCleanupCandidate;
const owner = { processId: process.pid, processBirthId: `${process.pid}:worker` };
const store = createBaleThreadCleanupWorkStore({ path: workPath,
  profileName: candidate.profileName, tokenSha256: "a".repeat(64) });
const ledger = createBaleWorkspaceAdmissionLedger({ path: ledgerPath,
  profileKey: candidate.profileName, owner, getProcessLiveness: () => "unverifiable" });
const permitRuntime = createBaleThreadCleanupPermitRuntime({ ledger,
  getLeaderEpoch: () => 1, getProfileName: () => "work", getOwner: () => owner, canAdoptFence: () => false,
  async revalidateUnderFence() { return true; } });
const clean = createBaleInactiveThreadCleanupSettingsPort({ store, permitRuntime,
  async resolveFullBinding() { return candidate; },
  async deleteWithPermit() {
    writeFileSync(`${attemptDir}/${process.pid}.attempt`, "attempt", { mode: 0o600 });
    const fd = openSync(markerPath, "wx", 0o600);
    try { writeFileSync(fd, String(process.pid)); } finally { closeSync(fd); }
    await new Promise(resolve => setTimeout(resolve, 40));
  },
  async commitBinding() { return true; },
});
process.stdout.write(`${JSON.stringify(await clean(operationId))}\n`);

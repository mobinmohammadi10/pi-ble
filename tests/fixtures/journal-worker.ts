/**
 * Cross-process update journal append worker
 * Zones: bale inbound tests, filesystem concurrency
 * Invoked only by journal.test.ts to contend on one authority file.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createBaleConfigStore } from "../../lib/config.ts";
import { createBaleJournalSourceSerialization,
  createBaleInputJournalStore,
  BaleUpdateJournalError,
  createBaleUpdateJournalBotIdentity,
  createBaleUpdateJournalStore,
  type BaleInputJournalHandoffAcceptInput,
  type BaleInputJournalRecoveryInput,
  type BaleUpdateJournalQueueOwnerIdentity,
} from "../../lib/journal.ts";

const [path, workerText, countText, mode = "append"] = process.argv.slice(2);
const worker = Number.parseInt(workerText ?? "", 10);
const count = Number.parseInt(countText ?? "", 10);
if (!path || !Number.isSafeInteger(worker) || !Number.isSafeInteger(count)) {
  throw new Error("journal worker requires path, worker, and count");
}

if (mode === "input-handoff-accept" || mode === "input-handoff-recover") {
  const dir = dirname(path);
  const request = JSON.parse(readFileSync(join(dir, "handoff-worker-request.json"), "utf8")) as {
    acceptance: BaleInputJournalHandoffAcceptInput;
    recovery: BaleInputJournalRecoveryInput;
    recipientBindingKey: string;
    recipientOwner: BaleUpdateJournalQueueOwnerIdentity;
    recoveryOwner: BaleUpdateJournalQueueOwnerIdentity;
  };
  const config = createBaleConfigStore({ agentDir: dir, configPath: join(dir, "bale.json") });
  const journalSerialization = createBaleJournalSourceSerialization(() => join(dir, "journals.transaction"));
  await config.load(); config.activateProfile("work");
  const accepting = mode === "input-handoff-accept";
  const runtime = accepting ? request.recipientOwner : request.recoveryOwner;
  const botIdentity = createBaleUpdateJournalBotIdentity({ botToken: "123:synthetic-input-custody" });
  const store = createBaleInputJournalStore({ path, profileName: "work", botIdentity,
    queueRuntimeIdentity: runtime,
    sourceAccess: { directory: dir, limits: { maxFiles: 100, maxBytes: 1_000_000, maxEntries: 100, maxWork: 1000 } },
    withSourceSerialization: journalSerialization,
    withPairingAdmission: publish => config.withPairingAdmission("work", botIdentity.tokenSha256, publish),
    getInputContext: () => ({ owner: accepting ? request.recipientOwner : request.recoveryOwner,
      recipientBindingKey: request.recipientBindingKey }),
    getQueueProcessLiveness: () => "dead",
  });
  let result: unknown;
  try {
    result = accepting
      ? { kind: "accepted", ...store.acceptInputHandoff(request.acceptance) }
      : { kind: "recovered", ...store.recoverReadyInput(request.recovery) };
  } catch (error) {
    if (!(error instanceof BaleUpdateJournalError) || error.code !== "conflict") throw error;
    result = { kind: "refused", code: error.code };
  }
  writeFileSync(join(dir, `handoff-worker-${worker}.json`), JSON.stringify(result));
} else if (mode === "input-custody") {
  const dir = dirname(path);
  const config = createBaleConfigStore({ agentDir: dir, configPath: join(dir, "bale.json") });
  const journalSerialization = createBaleJournalSourceSerialization(() => join(dir, "journals.transaction"));
  await config.load(); config.activateProfile("work");
  const runtime = { instanceId: `worker-${worker}`, processId: process.pid, processBirthId: `${process.pid}:fixture` };
  const botIdentity = createBaleUpdateJournalBotIdentity({ botToken: "123:synthetic-input-custody" });
  const store = createBaleInputJournalStore({ path, profileName: "work", botIdentity,
    queueRuntimeIdentity: runtime,
    sourceAccess: { directory: dir, limits: { maxFiles: 100, maxBytes: 1_000_000, maxEntries: 100, maxWork: 1000 } },
    withSourceSerialization: journalSerialization,
    withPairingAdmission: publish => config.withPairingAdmission("work", botIdentity.tokenSha256, publish),
    getInputContext: () => ({ owner: { ...runtime, sessionGeneration: 1 }, recipientBindingKey: "workspace:owner" }),
  });
  let result: unknown;
  try {
    const acquisition = store.acquireInput({ updateId: count, recipientBindingKey: "workspace:owner" });
    result = { ...acquisition, started: store.startInput(acquisition.receipt).started };
  } catch (error) {
    if (!(error instanceof BaleUpdateJournalError) || error.code !== "conflict") throw error;
    result = { acquired: false, refused: error.code };
  }
  writeFileSync(`${path}.claim-${worker}.json`, JSON.stringify(result));
} else {
  const rebind = mode === "rebind";
  const store = createBaleUpdateJournalStore({
    path,
    profileName: rebind ? "rebound" : "work",
    botIdentity: createBaleUpdateJournalBotIdentity({
      botToken: rebind ? "123:journal-rebound" : "123:journal-worker",
      botId: rebind ? 88 : 77,
    }),
  });
  if (rebind) store.read();
  for (let index = 0; index < count; index += 1) {
    const updateId = worker * 10_000 + index;
    store.appendBatch([
      { update_id: updateId, message: { text: `worker-${worker}-${index}` } },
    ]);
  }
}

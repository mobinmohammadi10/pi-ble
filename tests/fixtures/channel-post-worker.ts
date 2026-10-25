import { createBaleChannelPostJournalStore } from "../../lib/channel-posts.ts";

const [path, profileName, tokenSha256, action, operationId, mutationId, markdown, runtimeDir] = process.argv.slice(2);
if (!path || !profileName || !tokenSha256 || !action || !operationId) {
  throw new Error("Channel post worker arguments are required.");
}
const store = createBaleChannelPostJournalStore({ path, profileName, tokenSha256, ...(runtimeDir ? { runtimeDir } : {}) });
if (action === "begin") {
  process.stdout.write(`${JSON.stringify(store.beginPublication(operationId))}\n`);
} else if (action === "begin-edit") {
  if (!mutationId || !markdown) throw new Error("Edit mutation arguments are required.");
  process.stdout.write(`${JSON.stringify(store.beginEdit({ operationId, mutationId, markdown }))}\n`);
} else if (action === "begin-delete") {
  if (!mutationId) throw new Error("Delete mutation ID is required.");
  process.stdout.write(`${JSON.stringify(store.beginDelete({ operationId, mutationId }))}\n`);
} else if (action === "list") {
  process.stdout.write(`${JSON.stringify(store.list())}\n`);
} else {
  throw new Error(`Unknown channel post worker action: ${action}`);
}

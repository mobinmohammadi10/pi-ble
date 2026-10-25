/** Bale request compatibility regressions. Zones: bale transport */
import assert from "node:assert/strict";
import { prepareBaleRequest } from "../lib/bale-api.ts";

assert.deepEqual(prepareBaleRequest("sendRichMessage", {
  chat_id: 12, rich_message: { markdown: "**Hello**" },
  reply_parameters: { message_id: 7 },
}), { method: "sendMessage", body: { chat_id: 12, text: "**Hello**", reply_to_message_id: 7 } });
assert.deepEqual(prepareBaleRequest("sendMessage", {
  chat_id: 12, text: "<b>Hello</b> &amp; &lt;world&gt;", parse_mode: "HTML",
}), { method: "sendMessage", body: { chat_id: 12, text: "**Hello** & <world>" } });
assert.throws(() => prepareBaleRequest("createForumTopic", {}), /does not support/);
assert.throws(() => prepareBaleRequest("sendMessageDraft", {}), /does not support/);
assert.throws(() => prepareBaleRequest("sendMessage", { message_thread_id: 2 }), /Thread target/);
assert.throws(() => prepareBaleRequest("sendRichMessage", { rich_message: { blocks: [] } }), /Rich blocks/);
assert.throws(() => prepareBaleRequest("sendMessage", { reply_parameters: { message_id: "7" } }), /Invalid Bale reply/);
const original = { chat_id: 12, text: "hello", parse_mode: "HTML" };
prepareBaleRequest("sendMessage", original);
assert.equal(original.parse_mode, "HTML");
console.log("Bale request compatibility checks passed");

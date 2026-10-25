/**
 * Regression tests for Bale outbound markup helpers
 * Exercises top-level assistant action comment parsing, stripping, and voice reply planning
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  collectTopLevelHtmlComments,
  getBaleActionString,
  planBaleVoiceReply,
  stripBaleCommentMarkupForDelivery,
  stripBaleCommentMarkupForPreview,
} from "../lib/outbound-markup.ts";

test("Action string fields trim exactly once without coercion or payload mutation", () => {
  for (const value of [undefined, null, 1, false, {}, [], new String("text"), "", " \t\n"]) {
    assert.equal(getBaleActionString({ value }, "value"), undefined);
  }
  assert.equal(getBaleActionString({ value: "\t label \n" }, "value"), "label");
  assert.equal(getBaleActionString({}, "missing"), undefined);
  let reads = 0;
  const payload = { get value() { reads++; return " text "; } };
  assert.equal(getBaleActionString(payload, "value"), "text");
  assert.equal(reads, 1);
  assert.ok(Object.getOwnPropertyDescriptor(payload, "value")?.get);
});

test("Drafts hide complete and unfinished button fences but preserve outer code examples", () => {
  assert.equal(stripBaleCommentMarkupForPreview('Before\n```bale_button\n{Hidden|secret prompt}'), 'Before');
  assert.equal(stripBaleCommentMarkupForPreview('Before\n```bale_button\n{Hidden}\n```\nAfter'), 'Before\n\nAfter');
  const example = '````markdown\n```bale_button\n{Literal}\n```\n````';
  assert.equal(stripBaleCommentMarkupForPreview(example), example);
});

test("Markup collector ignores comments inside fenced code", () => {
  const markdown = [
    "```",
    "<!-- bale_voice: literal -->",
    "```",
    "",
    "<!-- bale_voice: real -->",
  ].join("\n");

  const { comments } = collectTopLevelHtmlComments(markdown);

  assert.equal(comments.length, 1);
  assert.equal(comments[0]?.content.trim(), "bale_voice: real");
});

test("Markup stripping removes every HTML comment from Bale surfaces", () => {
  const markdown = [
    "Visible <!-- inline --> text.",
    "",
    "> Quoted <!-- private quote --> text.",
    "",
    "- Listed <!-- private list --> text.",
    "",
    "```md",
    "<!-- private code example -->",
    "const visible = true;",
    "```",
  ].join("\n");
  const delivery = stripBaleCommentMarkupForDelivery(markdown);
  const preview = stripBaleCommentMarkupForPreview(markdown);

  assert.equal(delivery, preview);
  assert.doesNotMatch(delivery, /<!--|-->/u);
  assert.match(delivery, /Visible  text\./u);
  assert.match(delivery, /> Quoted  text\./u);
  assert.match(delivery, /- Listed  text\./u);
  assert.match(delivery, /const visible = true;/u);
  assert.equal(
    stripBaleCommentMarkupForDelivery(
      " \n<!-- first -->\n<!-- second -->\n ",
    ),
    "",
  );
  assert.equal(
    stripBaleCommentMarkupForPreview("Visible\n\n<!-- streaming private tail"),
    "Visible",
  );
});

test("Voice reply planner retains legacy attribute compatibility", () => {
  const plan = planBaleVoiceReply(
    [
      "Visible answer.",
      "",
      '<!-- bale_voice {"text":"JSON voice.","lang":"ru"} -->',
      '<!-- bale_voice {"text":"Rated JSON voice.","rate":"+10%"} -->',
      '<!-- bale_voice text="Attribute voice." lang="en" -->',
      '<!-- bale_voice {"value":"JSON value voice."} -->',
      '<!-- bale_voice value="Attribute value voice." -->',
      '<!-- bale_voice {"value":"Fallback voice.","text":"Explicit voice."} -->',
      '<!-- bale_voice {Keep this voice.} [unrelated envelope text] -->',
    ].join("\n"),
  );

  assert.equal(plan.markdown, "Visible answer.");
  assert.deepEqual(plan.voiceReplies, [
    { text: "JSON voice.", lang: "ru" },
    { text: "Rated JSON voice.", rate: "+10%" },
    { text: "Attribute voice.", lang: "en" },
    { text: "JSON value voice." },
    { text: "Attribute value voice." },
    { text: "Explicit voice." },
    { text: "Keep this voice." },
  ]);
});

test("Voice reply planner ignores payloads outside the canonical action shape", () => {
  const plan = planBaleVoiceReply(
    [
      '<!-- bale_voice [{"text":"Array is unsupported."}] -->',
      '<!-- bale_voice {"lang":"ru"} -->',
      '<!-- bale_voice {"text": -->',
      '<!-- bale_voice {"text":"Must not become CML","rate":} -->',
      '<!-- bale_voice unknown="Speak this." -->',
      '<!-- bale_voice [broken text=Must-not-recover] -->',
      '<!-- bale_voice [[{Matrix is unsupported.}]] -->',
      '<!-- bale_voice {|en} -->',
      '<!-- bale_voice {Too|many|voice|atoms} -->',
    ].join("\n"),
  );

  assert.equal(plan.voiceText, undefined);
  assert.equal(plan.voiceReplies, undefined);
  assert.equal(plan.markdown, "");
});

test("Voice reply planner extracts multiple voice replies and cleans markdown", () => {
  const plan = planBaleVoiceReply(
    [
      "Visible answer.",
      "",
      '<!-- bale_voice {"text":"Первый ответ.","lang":"ru","rate":"+20%"} -->',
      "",
      '<!-- bale_voice lang="en" text="Second answer." -->',
      "",
      "Tail.",
    ].join("\n"),
  );

  assert.equal(plan.markdown, "Visible answer.\n\nTail.");
  assert.equal(plan.voiceText, "Первый ответ.\n\nSecond answer.");
  assert.deepEqual(plan.voiceReplies, [
    { text: "Первый ответ.", lang: "ru", rate: "+20%" },
    { text: "Second answer.", lang: "en" },
  ]);
  assert.equal(plan.lang, "en");
  assert.equal(plan.rate, "+20%");
});

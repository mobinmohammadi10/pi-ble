/**
 * Bale target regression tests
 * Zones: bale transport, routing, multi-instance bus
 * Covers exact address-value identity shared by live routing, delivery and Workspace
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  areBaleTargetsEqual,
  createBalePrivateTarget,
  createBaleThreadTarget,
  getBaleTargetKey,
  getBaleTargetThreadParams,
  isBaleThreadTarget,
  parseBaleIntegerId,
  parseBaleTarget,
} from "../lib/target.ts";

test("Bale target helpers model private chat targets", () => {
  const target = createBalePrivateTarget(7);
  assert.deepEqual(target, { chatId: 7 });
  assert.equal(getBaleTargetKey(target), "7:private");
  assert.equal(isBaleThreadTarget(target), false);
  assert.deepEqual(getBaleTargetThreadParams(target), {});
});

test("Bale target helpers model topic thread targets", () => {
  const target = createBaleThreadTarget(-100123, 42);
  assert.deepEqual(target, { chatId: -100123, threadId: 42 });
  assert.equal(getBaleTargetKey(target), "-100123:42");
  assert.equal(isBaleThreadTarget(target), true);
  assert.deepEqual(getBaleTargetThreadParams(target), {
    message_thread_id: 42,
  });
});

test("Bale target equality is exact address-value equality without normalization", () => {
  const groups = [
    [{ chatId: 1 }, { chatId: 1, threadId: undefined }],
    [{ chatId: -1 }],
    [{ chatId: 1, threadId: 0 }],
    [{ chatId: 1, threadId: 2 }, { chatId: 1, threadId: 2 }],
    [{ chatId: 1, threadId: 3 }],
    [{ chatId: 2, threadId: 2 }],
    [{ chatId: 0, threadId: 0 }],
  ];
  for (const [leftGroup, leftTargets] of groups.entries()) {
    for (const [rightGroup, rightTargets] of groups.entries()) {
      for (const left of leftTargets) {
        for (const right of rightTargets) {
          assert.equal(areBaleTargetsEqual(left, right), leftGroup === rightGroup,
            `${JSON.stringify(left)} vs ${JSON.stringify(right)}`);
        }
      }
    }
  }
  const invalid = { chatId: NaN, threadId: 2 };
  assert.equal(areBaleTargetsEqual(invalid, invalid), false, "reference identity cannot bypass field equality");
  assert.equal(getBaleTargetKey({ chatId: 1, threadId: undefined }), "1:private");
  assert.equal(getBaleTargetKey({ chatId: -1, threadId: 0 }), "-1:0");
});

test("Target wire parsers keep only exact address fields and integer ids", () => {
  assert.deepEqual(parseBaleTarget({ chatId: 7, threadId: 42, extra: true }), { chatId: 7, threadId: 42 });
  assert.deepEqual(parseBaleTarget({ chatId: 7, threadId: "42" }), { chatId: 7 });
  for (const value of [undefined, null, [], "7", { chatId: "7" }]) assert.equal(parseBaleTarget(value), undefined);
  assert.equal(parseBaleIntegerId(42), 42);
  assert.equal(parseBaleIntegerId("-100"), -100);
  for (const value of [1.5, "", " ", "1.5", "x", null, undefined]) assert.equal(parseBaleIntegerId(value), undefined);
});

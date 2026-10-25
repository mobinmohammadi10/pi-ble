/**
 * Workspace slot policy regressions
 * Covers bounded global allocation and pressure reclamation.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  BALE_WORKSPACE_SLOTS,
  planBaleWorkspaceSlotAllocation,
  selectBaleWorkspaceReusableSlot,
  type BaleWorkspaceReusableSlot,
  type BaleWorkspaceSlotOccupancy,
} from "../lib/workspace-slots.ts";

function fullProfile(): BaleWorkspaceSlotOccupancy[] {
  return Array.from(BALE_WORKSPACE_SLOTS, (slot, index) => ({
    bindingKey: `/repo/${index}`,
    slot,
    inactiveSinceMs: 100 + index,
    protection: "eligible",
  }));
}

function reusable(): BaleWorkspaceReusableSlot[] {
  return Array.from("ABCDEFGHIJKLMNOPQRSTUVWXYZ", (slot, index) => ({
    bindingKey: `/repo/${index}`, slot, live: false, lastUsedMs: 100 + index,
  }));
}

test("Reusable letter selection prefers detached bindings by age and ignores protection", () => {
  const candidates = reusable();
  assert.equal(selectBaleWorkspaceReusableSlot(candidates)?.slot, "A");
  candidates[12].lastUsedMs = 1;
  assert.equal(selectBaleWorkspaceReusableSlot(candidates)?.slot, "M");
  // A live owner is the most recently used binding, whatever its stored clock says.
  candidates[12].live = true;
  assert.equal(selectBaleWorkspaceReusableSlot(candidates)?.slot, "A");
  for (const candidate of candidates) candidate.live = true;
  assert.equal(selectBaleWorkspaceReusableSlot(candidates)?.slot, "M", "all-live pools still reuse the oldest");
  candidates.forEach((candidate) => { candidate.live = false; candidate.lastUsedMs = 5; });
  assert.equal(selectBaleWorkspaceReusableSlot(candidates.toReversed())?.slot, "A", "ties resolve by letter");
});

test("Reusable letter selection refuses empty or malformed candidate sets", () => {
  assert.equal(selectBaleWorkspaceReusableSlot([]), undefined);
  const base = reusable().slice(0, 2);
  for (const patch of [{ slot: "a" }, { slot: "AB" }, { bindingKey: "" }, { lastUsedMs: -1 }, { lastUsedMs: 1.5 }, { slot: "A" }, { bindingKey: "/repo/0" }]) {
    assert.equal(selectBaleWorkspaceReusableSlot([base[0]!, { ...base[1]!, ...patch }]), undefined, JSON.stringify(patch));
  }
});

test("Global allocation uses the first free letter across directories and claims", () => {
  const bindings = fullProfile().slice(0, 2);
  assert.deepEqual(planBaleWorkspaceSlotAllocation({
    bindings, reservedSlots: ["c", "e"], nowMs: 1000,
  }), { kind: "free", slot: "d" });
  assert.deepEqual(planBaleWorkspaceSlotAllocation({
    bindings: [], reservedSlots: [], nowMs: 1000,
  }), { kind: "free", slot: "a" });
});

test("Pressure proposes the oldest eligible binding instead of alphabetic wrap", () => {
  const bindings = fullProfile();
  bindings[12].inactiveSinceMs = 1;
  const result = planBaleWorkspaceSlotAllocation({
    bindings, reservedSlots: [], nowMs: 1000,
  });
  assert.equal(result.kind, "reclaim");
  if (result.kind !== "reclaim") return;
  assert.equal(result.candidate.slot, "m");
  assert.equal(result.candidate.bindingKey, "/repo/12");
  result.candidate.bindingKey = "changed";
  assert.equal(bindings[12].bindingKey, "/repo/12");
  assert.equal(bindings.length, 26);
});

test("Elapsed time cannot retire a binding while free capacity remains", () => {
  assert.deepEqual(planBaleWorkspaceSlotAllocation({
    bindings: fullProfile().slice(0, 25),
    reservedSlots: [],
    nowMs: Number.MAX_SAFE_INTEGER,
  }), { kind: "free", slot: "z" });
});

test("Protected, unknown, reserved, and unproven inactivity cannot be victims", () => {
  const bindings = fullProfile();
  bindings[0].protection = "protected";
  bindings[1].protection = "unknown";
  bindings[2].inactiveSinceMs = undefined;
  bindings[3].inactiveSinceMs = NaN;
  bindings[4].inactiveSinceMs = Infinity;
  bindings[5].inactiveSinceMs = -1;
  bindings[6].inactiveSinceMs = 1001;
  const result = planBaleWorkspaceSlotAllocation({
    bindings, reservedSlots: ["h"], nowMs: 1000,
  });
  assert.equal(result.kind, "reclaim");
  if (result.kind === "reclaim") assert.equal(result.candidate.slot, "i");
});

test("All-protected capacity fails closed without extending the alphabet", () => {
  const bindings = fullProfile().map((binding) => ({
    ...binding, protection: "protected" as const,
  }));
  for (const input of [
    { bindings, reservedSlots: [] },
    { bindings: [], reservedSlots: Array.from(BALE_WORKSPACE_SLOTS) },
  ]) {
    assert.deepEqual(planBaleWorkspaceSlotAllocation({ ...input, nowMs: 1000 }), {
      kind: "blocked", reason: "protected-capacity",
    });
  }
});

test("Equal inactivity uses deterministic letter order independent of input order", () => {
  const bindings = fullProfile().map((binding) => ({ ...binding, inactiveSinceMs: 0 }));
  assert.deepEqual(planBaleWorkspaceSlotAllocation({
    bindings: bindings.toReversed(), reservedSlots: [], nowMs: 1000,
  }), { kind: "reclaim", candidate: bindings[0] });
});

test("Duplicate legacy slots, duplicate binding keys, and invalid inputs block planning", () => {
  const first = fullProfile()[0];
  for (const input of [
    { bindings: [first, { ...first, bindingKey: "/other" }], reservedSlots: [], nowMs: 1000 },
    { bindings: [first, { ...first, slot: "b" }], reservedSlots: [], nowMs: 1000 },
    { bindings: [{ ...first, slot: "aa" }], reservedSlots: [], nowMs: 1000 },
    { bindings: [{ ...first, slot: "A" }], reservedSlots: [], nowMs: 1000 },
    { bindings: [{ ...first, bindingKey: "" }], reservedSlots: [], nowMs: 1000 },
    { bindings: [], reservedSlots: ["aa"], nowMs: 1000 },
    { bindings: [], reservedSlots: [], nowMs: NaN },
    { bindings: [], reservedSlots: [], nowMs: -1 },
  ]) {
    assert.deepEqual(planBaleWorkspaceSlotAllocation(input), {
      kind: "blocked", reason: "invalid-state",
    });
  }
});

/**
 * Regression tests for the machine domain
 * Covers lib/machine.ts commit order, effect execution, re-entrant dispatch and state waiters
 */

import assert from "node:assert/strict";
import test from "node:test";

import * as Machine from "../lib/machine.ts";

type CountEvent = { type: "add"; by: number } | { type: "echo" };
type CountEffect = { type: "log"; value: number } | { type: "add"; by: number };

function createCounter(log: number[]) {
  const machine = Machine.createBaleMachineRunner<number, CountEvent, CountEffect>({
    initial: 0,
    transition: (state, event) =>
      event.type === "add"
        ? { state: state + event.by, effects: [{ type: "log", value: state + event.by }] }
        : { state, effects: [{ type: "add", by: 10 }] },
    run(effect) {
      if (effect.type === "log") log.push(machine.state);
      else machine.dispatch({ type: "add", by: effect.by });
    },
  });
  return machine;
}

test("Machine runner commits the next state before its effects run and returns the step", () => {
  const log: number[] = [];
  const machine = createCounter(log);
  const step = machine.dispatch({ type: "add", by: 2 });
  assert.equal(machine.state, 2);
  assert.deepEqual(log, [2], "An effect observes the committed state");
  assert.deepEqual(step, { state: 2, effects: [{ type: "log", value: 2 }] });
});

test("Machine runner lets effects dispatch again", () => {
  const log: number[] = [];
  const machine = createCounter(log);
  machine.dispatch({ type: "echo" });
  assert.equal(machine.state, 10);
  assert.deepEqual(log, [10]);
});

test("Machine runner waiters resolve now or after the dispatch that satisfies them", async () => {
  const machine = createCounter([]);
  let resolved = false;
  await machine.waitFor((state) => state === 0);
  const later = machine.waitFor((state) => state >= 3).then(() => { resolved = true; });
  machine.dispatch({ type: "add", by: 1 });
  await Promise.resolve();
  assert.equal(resolved, false);
  machine.dispatch({ type: "add", by: 2 });
  await later;
  assert.equal(resolved, true);
});

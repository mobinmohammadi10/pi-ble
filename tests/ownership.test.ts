/**
 * Regression tests for Bale message ownership helpers
 * Covers live message-id to target/instance ownership used by multi-instance bus routing
 */

import assert from "node:assert/strict";
import test from "node:test";

import * as Bus from "../lib/bus.ts";
import {
  createBaleBusMessageOwnershipRuntime,
  createBaleMessageOwnershipStore,
} from "../lib/ownership.ts";
import { createBaleThreadTarget } from "../lib/target.ts";

test("Bus ownership runtime rebinds stable follower authority to a replacement generation", () => {
  let followers = [
    {
      instanceId: "follower-a",
      connectedAtMs: 10,
      profileKey: "manual:owner-a",
      registrationGeneration: "generation-a",
    },
  ];
  const runtime = createBaleBusMessageOwnershipRuntime({
    instanceId: "leader",
    getProfileKey: () => "default",
    listFollowers: () => followers,
  });
  runtime.recordRouted({
    chatId: 7,
    messageId: 9,
    target: { chatId: 7, threadId: 11 },
    instanceId: "follower-a",
  });

  assert.equal(
    runtime.isOwnedByFollower({
      chatId: 7,
      messageId: 9,
      follower: followers[0]!,
    }),
    true,
  );
  assert.equal(
    runtime.store.get(7, 9)?.recipientBindingKey,
    "manual:owner-a",
  );
  followers = [
    {
      instanceId: "follower-b",
      connectedAtMs: 20,
      profileKey: "manual:owner-a",
      registrationGeneration: "generation-b",
    },
  ];
  assert.deepEqual(runtime.store.get(7, 9), {
    chatId: 7,
    messageId: 9,
    target: { chatId: 7, threadId: 11 },
    instanceId: "follower-b",
    profileKey: "default",
    ownerGeneration: "generation-b",
    recipientBindingKey: "manual:owner-a",
    createdAt: runtime.store.entries()[0]!.createdAt,
    updatedAt: runtime.store.entries()[0]!.updatedAt,
  });
  assert.equal(
    runtime.isOwnedByFollower({
      chatId: 7,
      messageId: 9,
      follower: followers[0]!,
    }),
    true,
  );
});

test("Forward ownership projects current protocol without caching it across registration changes", () => {
  const registry = Bus.createBaleBusFollowerRegistry();
  let profileKey = "default";
  const runtime = createBaleBusMessageOwnershipRuntime({
    instanceId: "leader", getProfileKey: () => profileKey, listFollowers: registry.list,
  });
  const validate = Bus.createBaleBusForwardOwnershipValidator(registry);
  const registration = {
    instanceId: "follower", connectedAtMs: 1, profileKey: "manual:recipient",
    registrationGeneration: "g1",
    protocol: Bus.createBaleBusProtocolIdentity({
      runtimeBuild: "fixture",
      capabilities: [Bus.BALE_BUS_CAPABILITY_DURABLE_FOLLOWER_ADMISSION],
    }),
  };
  registry.register(registration);
  runtime.recordRouted({ chatId: 7, messageId: 9, instanceId: "follower" });
  const initial = runtime.getForwardOwnership(7, 9)!;
  assert.equal(validate(initial), true);
  assert.deepEqual(initial.protocolIdentity, registration.protocol);
  assert.equal("protocolIdentity" in runtime.store.get(7, 9)!, false);
  const upgraded = Bus.createBaleBusProtocolIdentity({
    runtimeBuild: "fixture-upgrade",
    capabilities: [Bus.BALE_BUS_CAPABILITY_DURABLE_FOLLOWER_ADMISSION,
      Bus.BALE_BUS_CAPABILITY_INPUT_CUSTODY_REFERENCE],
  });
  registry.register({ ...registration, protocol: upgraded });
  const current = runtime.getForwardOwnership(7, 9)!;
  assert.equal(validate(initial), false);
  assert.equal(validate(current), true);
  assert.deepEqual(current.protocolIdentity, upgraded);
  assert.deepEqual(initial.protocolIdentity, registration.protocol);
  registry.register({ ...registration, instanceId: "replacement", registrationGeneration: "g2" });
  const replacement = runtime.getForwardOwnership(7, 9)!;
  assert.equal(validate(current), false);
  assert.equal(validate(replacement), true);
  assert.equal(replacement.instanceId, "replacement");
  assert.equal(replacement.ownerGeneration, "g2");
  assert.equal(replacement.recipientBindingKey, registration.profileKey);
  assert.deepEqual(replacement.protocolIdentity, registration.protocol);
  assert.equal("protocolIdentity" in runtime.store.get(7, 9)!, false);
  registry.remove("replacement");
  assert.equal(validate(replacement), false);
  assert.equal(runtime.getForwardOwnership(7, 9), undefined);
  assert.equal(runtime.store.entries().length, 1);
  registry.register(registration);
  assert.equal(validate(runtime.getForwardOwnership(7, 9)!), true);
  profileKey = "other-bot";
  assert.equal(runtime.getForwardOwnership(7, 9), undefined);
  const local = runtime.recordLocal({ chatId: 7, messageId: 9 });
  assert.deepEqual(runtime.getForwardOwnership(7, 9), local);
  assert.equal(runtime.getForwardOwnership(7, 10), undefined);
});

test("Forward ownership leaves incomplete or mismatched registrations fail-closed", () => {
  const registration = {
    instanceId: "follower", connectedAtMs: 1, profileKey: "manual:recipient",
    registrationGeneration: "g1",
    protocol: Bus.createBaleBusProtocolIdentity({
      runtimeBuild: "fixture",
      capabilities: [Bus.BALE_BUS_CAPABILITY_DURABLE_FOLLOWER_ADMISSION],
    }),
  };
  const cases: Array<[string, Partial<Bus.BaleBusInstanceRegistration>]> = [
    ["changed binding", { profileKey: "manual:other" }],
    ["missing binding", { profileKey: undefined }],
    ["missing generation", { registrationGeneration: undefined }],
    ["missing protocol", { protocol: undefined }],
    ["missing capability", { protocol: Bus.createBaleBusProtocolIdentity({
      runtimeBuild: "fixture", capabilities: [],
    }) }],
  ];
  for (const [name, override] of cases) {
    const registry = Bus.createBaleBusFollowerRegistry();
    registry.register(registration);
    const runtime = createBaleBusMessageOwnershipRuntime({
      instanceId: "leader", getProfileKey: () => "default", listFollowers: registry.list,
    });
    runtime.recordFollower({ chatId: 7, messageId: 9, follower: registration });
    registry.register({ ...registration, ...override });
    const snapshot = runtime.getForwardOwnership(7, 9);
    assert.ok(snapshot, `${name}: retain known foreign ownership`);
    assert.equal(snapshot.instanceId, "follower", name);
    assert.equal(snapshot.recipientBindingKey, "manual:recipient", name);
    assert.equal(snapshot.protocolIdentity, undefined, name);
    assert.equal(Bus.createBaleBusForwardOwnershipValidator(registry)(snapshot), false, name);
  }
});

test("Registration replacement during cache lookup rejects that snapshot but permits a fresh retry", () => {
  const registry = Bus.createBaleBusFollowerRegistry();
  const registration = {
    instanceId: "follower", connectedAtMs: 1, profileKey: "manual:recipient",
    registrationGeneration: "g1",
    protocol: Bus.createBaleBusProtocolIdentity({
      runtimeBuild: "fixture",
      capabilities: [Bus.BALE_BUS_CAPABILITY_DURABLE_FOLLOWER_ADMISSION],
    }),
  };
  registry.register(registration);
  let replace = false;
  const runtime = createBaleBusMessageOwnershipRuntime({
    instanceId: "leader", getProfileKey: () => "default",
    listFollowers() {
      const followers = registry.list();
      if (replace) {
        replace = false;
        registry.register({ ...registration, registrationGeneration: "g2" });
      }
      return followers;
    },
  });
  runtime.recordRouted({ chatId: 7, messageId: 9, instanceId: "follower" });
  replace = true;
  const stale = runtime.getForwardOwnership(7, 9)!;
  const validate = Bus.createBaleBusForwardOwnershipValidator(registry);
  assert.equal(stale.ownerGeneration, "g1");
  assert.equal(validate(stale), false);
  const current = runtime.getForwardOwnership(7, 9)!;
  assert.equal(current.ownerGeneration, "g2");
  assert.equal(validate(current), true);
});

test("Message ownership records default private targets", () => {
  const store = createBaleMessageOwnershipStore();
  const record = store.record({
    chatId: 7,
    messageId: 9,
    instanceId: "instance-a",
    now: 100,
  });
  assert.deepEqual(record, {
    chatId: 7,
    messageId: 9,
    target: { chatId: 7 },
    instanceId: "instance-a",
    createdAt: 100,
    updatedAt: 100,
  });
  assert.deepEqual(store.get(7, 9), record);
});

test("Message ownership preserves createdAt when ownership is refreshed", () => {
  const store = createBaleMessageOwnershipStore();
  store.record({
    chatId: -1007,
    messageId: 11,
    target: createBaleThreadTarget(-1007, 42),
    instanceId: "instance-a",
    now: 100,
  });
  const refreshed = store.record({
    chatId: -1007,
    messageId: 11,
    target: createBaleThreadTarget(-1007, 43),
    instanceId: "instance-b",
    now: 150,
  });
  assert.deepEqual(refreshed, {
    chatId: -1007,
    messageId: 11,
    target: createBaleThreadTarget(-1007, 43),
    instanceId: "instance-b",
    createdAt: 100,
    updatedAt: 150,
  });
});

test("Message ownership can forget a whole target", () => {
  const store = createBaleMessageOwnershipStore();
  store.record({
    chatId: -1007,
    messageId: 1,
    target: createBaleThreadTarget(-1007, 42),
    instanceId: "instance-a",
    now: 1,
  });
  store.record({
    chatId: -1007,
    messageId: 2,
    target: createBaleThreadTarget(-1007, 42),
    instanceId: "instance-a",
    now: 2,
  });
  store.record({
    chatId: -1007,
    messageId: 3,
    target: createBaleThreadTarget(-1007, 43),
    instanceId: "instance-b",
    now: 3,
  });
  assert.equal(store.forgetTarget(createBaleThreadTarget(-1007, 42)), 2);
  assert.equal(store.get(-1007, 1), undefined);
  assert.equal(store.get(-1007, 2), undefined);
  assert.equal(store.get(-1007, 3)?.instanceId, "instance-b");
});

test("Message ownership isolates bot profiles and rejects stale follower generations", () => {
  let profileKey = "work";
  let liveGeneration = "follower-a:100";
  const store = createBaleMessageOwnershipStore({
    getProfileKey: () => profileKey,
    isOwnerGenerationLive: (record) =>
      record.ownerGeneration === liveGeneration,
  });
  store.record({
    chatId: 7,
    messageId: 9,
    instanceId: "follower-a",
    ownerGeneration: "follower-a:100",
    now: 100,
  });
  assert.equal(store.get(7, 9)?.instanceId, "follower-a");

  profileKey = "personal";
  assert.equal(store.get(7, 9), undefined);
  store.record({
    chatId: 7,
    messageId: 9,
    instanceId: "follower-b",
    ownerGeneration: "follower-b:200",
    now: 200,
  });
  liveGeneration = "follower-b:200";
  assert.equal(store.get(7, 9)?.instanceId, "follower-b");

  profileKey = "work";
  liveGeneration = "follower-a:101";
  assert.equal(store.get(7, 9), undefined);
  assert.equal(store.entries().length, 2);
});

test("Message ownership prunes by age and record count", () => {
  const store = createBaleMessageOwnershipStore();
  store.record({ chatId: 7, messageId: 1, instanceId: "a", now: 10 });
  store.record({ chatId: 7, messageId: 2, instanceId: "a", now: 20 });
  store.record({ chatId: 7, messageId: 3, instanceId: "a", now: 30 });
  assert.equal(store.prune({ now: 40, maxAgeMs: 25 }), 1);
  assert.equal(store.get(7, 1), undefined);
  assert.equal(store.prune({ now: 40, maxRecords: 1 }), 1);
  assert.deepEqual(
    store.entries().map((record) => record.messageId),
    [3],
  );
});

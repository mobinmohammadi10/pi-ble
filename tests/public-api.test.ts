/**
 * Regression tests for public package API exports
 * Zones: package boundary, extension interop
 * Guards stable public subpaths and the removal of deep lib wildcard exports
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function assertPackagePathNotExported(specifier: string): Promise<void> {
  await assert.rejects(
    () => import(specifier),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "ERR_PACKAGE_PATH_NOT_EXPORTED",
  );
}

test("Public package subpaths expose the stable extension API", async () => {
  const [
    root,
    inbound,
    outbound,
    delivery,
    activity,
    updates,
    commands,
    sections,
    status,
    voice,
    keyboard,
  ] = await Promise.all([
    import("@llblab/pi-bale"),
    import("@llblab/pi-bale/inbound"),
    import("@llblab/pi-bale/outbound"),
    import("@llblab/pi-bale/delivery"),
    import("@llblab/pi-bale/activity"),
    import("@llblab/pi-bale/updates"),
    import("@llblab/pi-bale/commands"),
    import("@llblab/pi-bale/sections"),
    import("@llblab/pi-bale/status"),
    import("@llblab/pi-bale/voice"),
    import("@llblab/pi-bale/keyboard"),
  ]);

  assert.deepEqual(Object.keys(root), ["default"]);
  assert.deepEqual(Object.keys(inbound).sort(), [
    "registerBaleInboundHandler",
  ]);
  assert.deepEqual(Object.keys(outbound).sort(), [
    "recordBaleRuntimeEvent",
    "registerBaleOutboundHandler",
  ]);
  assert.deepEqual(Object.keys(delivery).sort(), [
    "deleteBaleView",
    "editBaleView",
    "sendBaleChatAction",
    "sendBaleView",
  ]);
  assert.deepEqual(Object.keys(activity).sort(), [
    "registerBaleActivityHandler",
  ]);
  assert.deepEqual(Object.keys(updates).sort(), [
    "assertBaleUpdateExecutionCurrent",
    "carryBaleUpdateExecutionFence",
    "createBaleUpdateExecutionFenceGuard",
    "getBaleUpdateExecutionFence",
    "registerBaleUpdateHandler",
  ]);
  assert.deepEqual(Object.keys(commands).sort(), ["registerBaleCommand"]);
  assert.deepEqual(Object.keys(sections).sort(), [
    "getBaleSectionDiagnostics",
    "registerBaleSection",
  ]);
  assert.deepEqual(Object.keys(status).sort(), [
    "registerBaleStatusLineProvider",
  ]);
  assert.deepEqual(Object.keys(voice).sort(), [
    "BALE_VOICE_REPLY_MODES",
    "computeVoicePromptContribution",
    "computeVoiceTurnFlags",
    "getBaleVoiceReplyMode",
    "isVoiceTurn",
    "registerBaleVoiceSynthesisProvider",
    "registerBaleVoiceTranscriptionProvider",
    "shouldSuppressPreviewForVoice",
  ]);
  assert.deepEqual(Object.keys(keyboard), []);
});

test("Activity API declares the Pi lifecycle compatibility floor", async () => {
  const packageJson = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  ) as { peerDependencies?: Record<string, string> };
  assert.equal(
    packageJson.peerDependencies?.["@earendil-works/pi-coding-agent"],
    ">=1.0.0",
  );
  assert.equal(
    packageJson.peerDependencies?.["@earendil-works/pi-agent-core"],
    ">=1.0.0",
  );
  assert.equal(
    packageJson.peerDependencies?.["@earendil-works/pi-ai"],
    ">=1.0.0",
  );
});

test("Package-private lib implementation paths are not exported", async () => {
  await assertPackagePathNotExported("@llblab/pi-bale/lib/updates.ts");
  await assertPackagePathNotExported("@llblab/pi-bale/lib/sections.ts");
  await assertPackagePathNotExported("@llblab/pi-bale/api/updates.ts");
});

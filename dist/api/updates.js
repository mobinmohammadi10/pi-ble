/**
 * Public Bale updates API
 * Zones: package boundary, extension interop
 * Exposes the stable raw-update handler surface while keeping update routing internals package-private
 */
export { assertBaleUpdateExecutionCurrent, carryBaleUpdateExecutionFence, createBaleUpdateExecutionFenceGuard, getBaleUpdateExecutionFence, registerBaleUpdateHandler, } from "../lib/updates.js";

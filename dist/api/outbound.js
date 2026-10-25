/**
 * Public Bale outbound API
 * Zones: package boundary, extension interop
 * Exposes stable outbound handler and diagnostics surfaces while keeping delivery internals package-private
 */
export { recordBaleRuntimeEvent, registerBaleOutboundHandler, } from "../lib/outbound.js";

/**
 * Public Bale outbound API
 * Zones: package boundary, extension interop
 * Exposes stable outbound handler and diagnostics surfaces while keeping delivery internals package-private
 */
export { recordBaleRuntimeEvent, registerBaleOutboundHandler, type BaleOutboundProgrammaticHandler, } from "../lib/outbound.ts";

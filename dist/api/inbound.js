/**
 * Public Bale inbound API
 * Zones: package boundary, extension interop
 * Exposes the stable programmatic inbound handler surface while keeping handler runtime internals package-private
 */
export { registerBaleInboundHandler, } from "../lib/inbound.js";

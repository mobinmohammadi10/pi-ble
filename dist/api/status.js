/**
 * Public Bale status API
 * Zones: package boundary, extension interop
 * Exposes compact status-menu line registration for extension consumers while keeping status rendering internals package-private
 */
export { registerBaleStatusLineProvider, } from "../lib/status.js";

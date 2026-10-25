/**
 * Public Bale inbound API
 * Zones: package boundary, extension interop
 * Exposes the stable programmatic inbound handler surface while keeping handler runtime internals package-private
 */

export {
  registerBaleInboundHandler,
  type BaleInboundHandlerFile,
  type BaleInboundHandlerOutput,
  type BaleInboundProgrammaticHandler,
  type BaleInboundProgrammaticHandlerInput,
  type BaleInboundProgrammaticHandlerResult,
} from "../lib/inbound.ts";

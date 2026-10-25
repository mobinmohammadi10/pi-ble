/**
 * Public Bale delivery API
 * Zones: package boundary, bale delivery, extension interop
 * Exposes target-aware operational view delivery while keeping transport and runtime binding internals package-private
 */
export { deleteBaleView, editBaleView, sendBaleChatAction, sendBaleView, } from "../lib/delivery.js";

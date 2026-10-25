/**
 * Bundled Bale skill discovery
 * Zones: pi agent, bale guidance
 * Owns source-checkout skill contribution; installed packages use their manifest
 */
import type { ExtensionAPI } from "./pi.ts";
export declare function getBaleExtensionPackageRoot(modulePath: string): string;
export interface BaleRawExtensionCheckoutOptions {
    agentDir?: string;
    cwd?: string;
}
export declare function isRawBaleExtensionCheckout(modulePath: string, options?: BaleRawExtensionCheckoutOptions): boolean;
export declare const BALE_SKILLS_PATH: string;
export declare function registerBaleSkillDiscovery(pi: Pick<ExtensionAPI, "on">, modulePath?: string, options?: BaleRawExtensionCheckoutOptions): boolean;

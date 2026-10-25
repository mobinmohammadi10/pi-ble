/**
 * Bale bus-aware API runtime
 * Zones: multi-instance bus, bale api transport, live instance routing
 * Wraps the direct Bale Bot API runtime so follower instances can route outbound calls through the bus leader
 */
import { type BaleBusSelectedMenuDeliveryObservation, type BaleBusSelectedMenuTextEffect } from "./bus.ts";
import type { BaleApiCallOptions, BaleBridgeApiRuntime } from "./bale-api.ts";
export type BaleBusApiCall = (method: string, args: unknown[], localOptions?: Pick<BaleApiCallOptions, "assertAuthority">) => Promise<unknown>;
export interface BaleBusAwareApiRuntimeDeps {
    directRuntime: BaleBridgeApiRuntime;
    ownsDirect: () => boolean;
    callFollowerApi: BaleBusApiCall;
    getDefaultTarget?: () => {
        chatId: number;
        threadId?: number;
    } | undefined;
}
/** Bound selected-menu projection only; no ordinary/raw API fallback and no activation during preparation. */
export declare function createBaleSelectedMenuTextApi(deps: {
    operationId: string;
    registrationGeneration: string;
    target: {
        chatId: number;
        threadId: number;
    };
    assertAuthority: () => void;
    deliver(effect: BaleBusSelectedMenuTextEffect, assertAuthority: () => void): Promise<BaleBusSelectedMenuDeliveryObservation>;
}): Pick<BaleBridgeApiRuntime, "sendMessage" | "editMessageText">;
export declare function createBaleBusAwareApiRuntime(deps: BaleBusAwareApiRuntimeDeps): BaleBridgeApiRuntime;

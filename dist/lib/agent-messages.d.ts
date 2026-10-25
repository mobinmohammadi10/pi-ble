/**
 * Cross-instance Bale agent message resolution and turn injection
 * Zones: multi-instance bus, inbound routing, operational delivery
 * Owns live target resolution, source attribution, same-target fencing, and synthetic turn construction; excludes Bot API delivery and bus transport.
 */
import type { BaleBusAgentMessage, BaleBusAgentTargetSelector, BaleBusFollowerRegistry } from "./bus.ts";
import type { BaleTarget } from "./target.ts";
export interface BaleAgentMessageRuntimeDeps<TContext, TUpdate> {
    instanceId: string;
    getAllowedChatId: () => number | undefined;
    getLeaderTarget: () => BaleTarget | undefined;
    getLeaderThreadName: () => string | undefined;
    getDisplayTitle?: (target: BaleTarget) => string | undefined;
    followerRegistry: BaleBusFollowerRegistry;
    getContext: () => TContext | undefined;
    handleUpdate: (update: TUpdate, ctx: TContext) => Promise<void>;
    getNowMs?: () => number;
}
export declare function createBaleAgentMessageRuntime<TContext, TUpdate>(deps: BaleAgentMessageRuntimeDeps<TContext, TUpdate>): {
    resolveTarget: (selector: BaleBusAgentTargetSelector, sourceTarget?: BaleTarget) => (BaleTarget & {
        threadId: number;
    }) | undefined;
    route(input: {
        sourceTarget?: BaleTarget;
        sourceThreadName?: string;
        message: BaleBusAgentMessage;
    }): Promise<void>;
};

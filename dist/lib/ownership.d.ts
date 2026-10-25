/**
 * Bale message ownership helpers
 * Zones: bale routing, multi-instance bus, in-memory coordination
 * Owns message-id ownership and live forwarding projections so inbound updates resolve back to the instance/target that owns them
 */
import { type BaleBusFollowerView, type BaleBusForwardOwnership } from "./bus.ts";
import { type BaleTarget } from "./target.ts";
export interface BaleMessageOwnershipRecord {
    chatId: number;
    messageId: number;
    target: BaleTarget;
    instanceId: string;
    profileKey?: string;
    ownerGeneration?: string;
    recipientBindingKey?: string;
    createdAt: number;
    updatedAt: number;
}
export interface BaleMessageOwnershipStore {
    record: (input: {
        chatId: number;
        messageId: number;
        target?: BaleTarget;
        instanceId: string;
        profileKey?: string;
        ownerGeneration?: string;
        recipientBindingKey?: string;
        now?: number;
    }) => BaleMessageOwnershipRecord;
    get: (chatId: number, messageId: number) => BaleMessageOwnershipRecord | undefined;
    forget: (chatId: number, messageId: number) => boolean;
    forgetTarget: (target: BaleTarget) => number;
    prune: (options: {
        now: number;
        maxAgeMs?: number;
        maxRecords?: number;
    }) => number;
    entries: () => BaleMessageOwnershipRecord[];
    clear: () => void;
}
export type BaleFollowerOwnershipView = Pick<BaleBusFollowerView, "instanceId" | "connectedAtMs" | "profileKey" | "registrationGeneration" | "protocol">;
export interface BaleBusMessageOwnershipRuntime {
    store: BaleMessageOwnershipStore;
    getForwardOwnership(chatId: number, messageId: number): BaleBusForwardOwnership | undefined;
    recordLocal(input: {
        chatId: number;
        messageId: number;
        target?: BaleTarget;
    }): BaleMessageOwnershipRecord;
    recordRouted(input: {
        chatId: number;
        messageId: number;
        target?: BaleTarget;
        instanceId: string;
    }): BaleMessageOwnershipRecord;
    recordFollower(input: {
        chatId: number;
        messageId: number;
        target?: BaleTarget;
        follower: BaleFollowerOwnershipView;
    }): BaleMessageOwnershipRecord;
    isOwnedByFollower(input: {
        chatId: number;
        messageId: number;
        follower: BaleFollowerOwnershipView;
    }): boolean;
}
export declare function createBaleBusMessageOwnershipRuntime(deps: {
    instanceId: string;
    getProfileKey(): string;
    listFollowers(): readonly BaleFollowerOwnershipView[];
}): BaleBusMessageOwnershipRuntime;
export declare function createBaleMessageOwnershipStore(options?: {
    getProfileKey?: () => string | undefined;
    isOwnerGenerationLive?: (record: BaleMessageOwnershipRecord) => boolean;
    resolveOwnerReplacement?: (record: BaleMessageOwnershipRecord) => Pick<BaleMessageOwnershipRecord, "instanceId" | "ownerGeneration" | "recipientBindingKey"> | undefined;
}): BaleMessageOwnershipStore;

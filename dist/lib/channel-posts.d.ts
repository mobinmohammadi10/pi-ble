/**
 * Durable journal for Bale channel posts authored by this agent path
 * Zones: bale outbound, filesystem authority
 * Owns publication intent, outcome-unknown fencing, confirmed post identity, and bounded local listing
 */
import type { ExtensionAPI } from "./pi.ts";
export type BaleChannelPostMediaKind = "photo" | "video";
export interface BaleChannelPostMediaIntent {
    kind: BaleChannelPostMediaKind;
    fileName: string;
    sizeBytes: number;
    sha256: string;
}
/** Safe, content-free local validation failure for channel media publication intent. */
export declare class BaleChannelPostValidationError extends Error {
    constructor(message: string);
}
export declare function isBaleChannelPostValidationError(error: unknown): error is BaleChannelPostValidationError;
export declare function resolveBaleChannelPostMediaKind(path: string): BaleChannelPostMediaKind | undefined;
export declare function assertBaleChannelPostMediaSize(kind: BaleChannelPostMediaKind, sizeBytes: number): void;
export declare function inspectBaleChannelPostMedia(path: string): Promise<BaleChannelPostMediaIntent>;
export declare function getBaleChannelPostCaptionLength(caption: string): number;
export declare function assertBaleChannelPostCaptionWithinLimit(caption: string): void;
type ChannelPostJournalCode = "invalid" | "conflict" | "capacity" | "io";
export declare class BaleChannelPostJournalError extends Error {
    readonly code: ChannelPostJournalCode;
    constructor(code: ChannelPostJournalCode, message: string, cause?: unknown);
}
export type BaleChannelPostAddress = number | `@${string}`;
interface BaleChannelPostRecordBase {
    operationId: string;
    requestedChannel: BaleChannelPostAddress;
    markdown: string;
    media?: BaleChannelPostMediaIntent;
    createdAtMs: number;
    updatedAtMs: number;
}
interface BalePublishedChannelPostIdentity {
    issuedAtMs: number;
    publishedAtMs: number;
    channelId: number;
    messageId: number;
    channelUsername?: `@${string}`;
    channelTitle?: string;
    lastMutationId?: string;
}
export type BaleChannelPostRecord = BaleChannelPostRecordBase & ({
    state: "prepared";
} | {
    state: "outcome-unknown";
    issuedAtMs: number;
} | ({
    state: "published";
} & BalePublishedChannelPostIdentity) | ({
    state: "edit-outcome-unknown";
    mutationId: string;
    attemptedMarkdown: string;
    mutationIssuedAtMs: number;
} & BalePublishedChannelPostIdentity) | ({
    state: "delete-outcome-unknown";
    mutationId: string;
    mutationIssuedAtMs: number;
} & BalePublishedChannelPostIdentity) | ({
    state: "deleted";
    mutationId: string;
    deletedAtMs: number;
} & BalePublishedChannelPostIdentity));
export interface BaleChannelPostJournalStoreOptions {
    path: string;
    runtimeDir?: string;
    profileName: string;
    tokenSha256: string;
    maxRecords?: number;
    maxBytes?: number;
    getNowMs?: () => number;
}
export interface BaleChannelPostJournalStore {
    prepare(input: {
        operationId: string;
        channel: BaleChannelPostAddress;
        markdown: string;
        media?: BaleChannelPostMediaIntent;
    }): {
        prepared: boolean;
        record: BaleChannelPostRecord;
    };
    get(operationId: string): BaleChannelPostRecord | undefined;
    beginPublication(operationId: string): {
        began: boolean;
        record: BaleChannelPostRecord;
    };
    confirmPublished(input: {
        operationId: string;
        channelId: number;
        messageId: number;
        channelUsername?: `@${string}`;
        channelTitle?: string;
    }): {
        confirmed: boolean;
        record: BaleChannelPostRecord;
    };
    beginEdit(input: {
        operationId: string;
        mutationId: string;
        markdown: string;
    }): {
        began: boolean;
        record: BaleChannelPostRecord;
    };
    confirmEdited(input: {
        operationId: string;
        mutationId: string;
    }): {
        confirmed: boolean;
        record: BaleChannelPostRecord;
    };
    beginDelete(input: {
        operationId: string;
        mutationId: string;
    }): {
        began: boolean;
        record: BaleChannelPostRecord;
    };
    confirmDeleted(input: {
        operationId: string;
        mutationId: string;
    }): {
        confirmed: boolean;
        record: BaleChannelPostRecord;
    };
    list(input?: {
        channel?: BaleChannelPostAddress;
        limit?: number;
    }): BaleChannelPostRecord[];
}
export declare function publishBaleChannelPost(input: {
    store: BaleChannelPostJournalStore;
    operationId: string;
    channel: BaleChannelPostAddress;
    markdown: string;
    media?: BaleChannelPostMediaIntent;
    observeChannel(channel: BaleChannelPostAddress): Promise<{
        id: number;
        type: string;
        username?: string;
        title?: string;
    }>;
    send(channel: BaleChannelPostAddress, markdown: string): Promise<{
        messageId: number;
        chat: {
            id: number;
            type: string;
        };
    }>;
}): Promise<BaleChannelPostRecord>;
export declare function registerBaleChannelPostMutationTool(pi: ExtensionAPI, deps: {
    mutate(input: {
        action: "edit" | "delete";
        operationId: string;
        mutationId: string;
        markdown?: string;
    }): Promise<BaleChannelPostRecord>;
}): void;
export declare function registerBaleChannelPostListTool(pi: ExtensionAPI, deps: {
    list: BaleChannelPostJournalStore["list"];
}): void;
/** The profile's channel-post journal in the shared runtime directory, bound to the active bot token. */
export declare function openBaleChannelPostJournalStore(input: {
    profileName: string;
    botToken: string;
}): BaleChannelPostJournalStore;
export declare function createBaleChannelPostJournalStore(options: BaleChannelPostJournalStoreOptions): BaleChannelPostJournalStore;
export {};

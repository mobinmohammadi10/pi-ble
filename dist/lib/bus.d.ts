/**
 * Bale multi-instance bus protocol and IPC helpers
 * Zones: multi-instance bus, local IPC contract, live instance routing
 * Owns serializable bus envelopes, socket/auth helpers, local IPC client/server primitives,
 * cross-instance forwarding helpers, and the live follower registry model.
 */
import { type BaleBusEndpointLayout, type BaleBusTransportEventRecorder, type BaleBusTransportRetryPolicy } from "./bus-transport.ts";
import type { BaleThreadDisplayMode } from "./config.ts";
import { type BaleLockEntry, type BaleLockState } from "./locks.ts";
import { type BaleQueueHandoffPayload } from "./queue.ts";
import { type BaleTarget } from "./target.ts";
import { type BaleSessionReplacementIntent } from "./threads.ts";
interface BaleBusProcessRuntime {
    instanceId: string;
    processId: number;
    processBirthId: string;
    manualFollowerOwnerId: string;
    getLeaderSocketPath: () => string;
    getFollowerSocketPath: () => string;
}
export declare function createCurrentBaleBusProcessRuntime(input: {
    getActiveProfileName: () => string | undefined;
    endpointLayout?: BaleBusEndpointLayout;
    pid?: number;
    parentPid?: number;
    createdAtMs?: number;
}): BaleBusProcessRuntime;
export declare function createBaleBusProcessRuntime(input: {
    getActiveProfileName: () => string | undefined;
    endpointLayout?: BaleBusEndpointLayout;
    pid: number;
    parentPid: number;
    parentProcessIdentity?: string;
    createdAtMs: number;
}): BaleBusProcessRuntime;
export declare function createBaleBusAuthSecret(): string;
export declare const BALE_BUS_CAPABILITY_DURABLE_FOLLOWER_ADMISSION: "durable-follower-admission-v1";
export declare const BALE_BUS_CAPABILITY_QUEUE_HANDOFF: "queue-handoff-v1";
/** Unspent Steer lane codec; independent from baseline receipt handoff support. */
export declare const BALE_BUS_CAPABILITY_QUEUE_STEER: "queue-steer-v1";
export declare const BALE_BUS_CAPABILITY_CONNECT_RECOVERY: "explicit-connect-recovery-v1";
export declare const BALE_BUS_CAPABILITY_INPUT_CUSTODY_REFERENCE: "input-custody-reference-v1";
export declare const BALE_BUS_CAPABILITY_WORKSPACE_THREAD_RENAME: "workspace-thread-rename-v1";
export declare const BALE_BUS_CAPABILITY_THREAD_DISPLAY_MODE: "thread-display-mode-v1";
export declare const BALE_BUS_CAPABILITY_DIRECTORY_DISPLAY_FORMAT: "directory-display-format-v1";
export declare const BALE_BUS_CAPABILITY_WORKSPACE_FOLLOWER_AUTO_CONNECT: "workspace-follower-auto-connect-v1";
export declare const BALE_BUS_CAPABILITY_SESSION_REPLACEMENT_INTENT: "session-replacement-intent-v1";
export declare const BALE_BUS_CAPABILITY_WORKSPACE_RESTORE: "workspace-restore-v1";
/** Shared Workspace readers understand independent pre-dispatch input/cleanup state. */
export declare const BALE_BUS_CAPABILITY_PRE_DISPATCH_REBIND: "live-rebind-pre-dispatch-reader-v2";
export declare const BALE_BUS_CAPABILITY_PRE_DISPATCH_REBIND_EXECUTION: "live-rebind-pre-dispatch-v1";
export declare const BALE_BUS_CAPABILITY_LIVE_REBIND_SAVE: "live-thread-rebind-save-v1";
export declare const BALE_BUS_CAPABILITY_LIVE_REBIND_APPLY: "live-thread-rebind-apply-v1";
export declare const BALE_BUS_CAPABILITY_LIVE_REBIND_SETTLE: "live-thread-rebind-settle-v1";
/** Restricted recipient text/menu delivery; negotiated identity and captured effect authority remain required. */
export declare const BALE_BUS_CAPABILITY_SELECTED_MENU_DELIVERY: "selected-menu-delivery-v1";
/** Versioned held-command set; syntax is shared, while the captured recipient Commands registry owns supported plans. */
export declare const BALE_BUS_CAPABILITY_LIVE_REBIND_COMMAND_SET: "live-thread-rebind-command-set-v1";
/** Every live rebinding needs the save/apply/settle trio; held command selections additionally need these two. */
export declare const BALE_BUS_LIVE_REBIND_CAPABILITIES: readonly ["live-thread-rebind-save-v1", "live-thread-rebind-apply-v1", "live-thread-rebind-settle-v1"];
export declare const BALE_BUS_HELD_COMMAND_CAPABILITIES: readonly ["live-thread-rebind-command-set-v1", "selected-menu-delivery-v1"];
/** Start/help are restricted menu aliases, negotiated separately from the original held-command set. */
export declare const BALE_BUS_CAPABILITY_HELD_MENU_ALIASES: "held-menu-aliases-v1";
export declare function getBaleBusHeldCommandCapabilities(name: string): readonly string[];
export interface BaleBusSelectedCommandInput {
    name: string;
    target: BaleTarget & {
        threadId: number;
    };
}
export type BaleBusSelectedMenuTextEffect = {
    text: string;
    parseMode?: "HTML";
    replyMarkup?: {
        inline_keyboard: {
            text: string;
            callback_data: string;
        }[][];
    };
} & ({
    kind: "send-text";
    replyToMessageId?: number;
} | {
    kind: "edit-text";
    messageId: number;
});
/** Serializable identity/effect description, never a process-local callback or standalone delivery grant. */
export interface BaleBusSelectedMenuDelivery {
    kind: "follower.deliverSelectedMenu";
    requestId: string;
    instanceId: string;
    registrationGeneration: string;
    operationId: string;
    recipient: {
        sessionId: string;
        sessionGeneration: number;
        processId: number;
        processBirthId: string;
        profileKey: string;
        journalBindingKey: string;
        target: BaleTarget & {
            threadId: number;
        };
    };
    executor: {
        instanceId: string;
        leaderEpoch: string;
    };
    operatorUserId: number;
    effect: BaleBusSelectedMenuTextEffect;
    sentAtMs: number;
}
export interface BaleBusSelectedMenuDeliveryObservation {
    operationId: string;
    recipient: BaleBusSelectedMenuDelivery["recipient"];
    registrationGeneration: string;
    effect: BaleBusSelectedMenuTextEffect["kind"];
    messageId: number;
}
/** Closed wire projection of prepared recipient source; independent of journal implementation and never a removal grant. */
export interface BaleBusPreparedCommandSource {
    journalBindingKey: string;
    updateId: number;
    sourceSha256: string;
}
export interface BaleBusLiveRebindSaveObservation {
    operationId: string;
    recipient: {
        instanceId: string;
        sessionId: string;
        generation: string;
        bindingKey: string;
    };
    sourceUpdateIds: number[];
    selectedCommand?: BaleBusSelectedCommandInput;
    preparedSource?: BaleBusPreparedCommandSource;
    status: "saved";
}
/** Read-only warm observation; semantic completion and exact source ACK are distinct from detached delivery. */
export interface BaleBusLiveRebindCommandObservation extends Omit<BaleBusLiveRebindSaveObservation, "status" | "preparedSource" | "selectedCommand"> {
    status: "command-observed";
    selectedCommand: BaleBusSelectedCommandInput;
    preparedSource: BaleBusPreparedCommandSource;
    command: "completed" | "unknown" | "not-issued";
    sourceAck?: BaleBusPreparedCommandSource;
}
export interface BaleBusLiveRebindWorkState {
    sessionBusy: boolean;
    targetWork: boolean;
    deliveryPending: boolean;
    unknown: boolean;
}
export interface BaleBusLiveRebindWorkObservation extends Omit<BaleBusLiveRebindSaveObservation, "status"> {
    status: "observed";
    oldTarget: BaleTarget & {
        threadId: number;
    };
    work: BaleBusLiveRebindWorkState;
}
export interface BaleBusLiveRebindSettlementObservation extends Omit<BaleBusLiveRebindSaveObservation, "status"> {
    action: "release" | "discard";
    status: "released" | "discarded" | "protected" | "unknown";
}
export interface BaleBusLiveRebindApplyObservation extends Omit<BaleBusLiveRebindSaveObservation, "status"> {
    status: "saved" | "applied";
    target: BaleTarget & {
        threadId: number;
    };
    slot: string;
}
export interface BaleBusWorkspaceRestoreObservation {
    operationId: string;
    recipient: {
        kind: "follower";
        instanceId: string;
        sessionId: string;
        generation: string;
    };
    target: BaleTarget & {
        threadId: number;
    };
    slot: string;
    ready: boolean;
}
export interface BaleBusProtocolIdentity {
    protocolVersion: number;
    runtimeBuild: string;
    capabilities: string[];
}
interface BaleBusProtocolCompatibility {
    compatible: boolean;
    reason?: "missing-identity" | "version-mismatch" | "missing-capability";
    missingCapabilities: string[];
}
export declare function createBaleBusProtocolIdentity(input: {
    runtimeBuild: string;
    capabilities?: readonly string[];
}): BaleBusProtocolIdentity;
export declare function createBaleCurrentBusProtocolIdentity(capabilities?: readonly string[]): BaleBusProtocolIdentity;
export declare function hasBaleBusCapability(identity: BaleBusProtocolIdentity | undefined, capability: string): boolean;
export declare function hasBaleBusSteerQueueHandoffCapability(identity: BaleBusProtocolIdentity | undefined): boolean;
export declare function getBaleInputCustodyPeerReadiness(followers: readonly Pick<BaleBusFollowerView, "registrationGeneration" | "protocol">[]): ("ready" | "legacy" | "unknown")[];
/** Both peers advertise every required capability over a compatible protocol; reads only the two identities. */
export declare function hasBaleBusSharedCapabilities(local: BaleBusProtocolIdentity, remote: BaleBusProtocolIdentity | undefined, required: readonly string[]): boolean;
export declare function getBaleBusProtocolCompatibility(input: {
    local: BaleBusProtocolIdentity;
    remote?: BaleBusProtocolIdentity;
}): BaleBusProtocolCompatibility;
export declare function getBaleBusSocketPath(agentDir?: string, platform?: NodeJS.Platform, profileName?: string, layout?: BaleBusEndpointLayout): string;
export declare function getBaleBusFollowerSocketPath(instanceId: string, agentDir?: string, platform?: NodeJS.Platform, profileName?: string, layout?: BaleBusEndpointLayout): string;
export interface BaleBusInstanceRegistration {
    instanceId: string;
    previousInstanceId?: string;
    profileKey?: string;
    threadName?: string;
    slot?: string;
    cwd?: string;
    sessionId?: string;
    pid?: number;
    target?: BaleTarget;
    busSocketPath?: string;
    registrationGeneration?: string;
    protocol?: BaleBusProtocolIdentity;
    sessionGeneration?: number;
    processBirthId?: string;
    connectedAtMs: number;
}
export interface BaleBusFollowerView extends BaleBusInstanceRegistration {
    lastHeartbeatMs: number;
}
/** Whether a live follower is still exactly the captured registration: identity, process, session, endpoint and negotiated protocol. */
export declare function isSameBaleBusFollowerRegistration(live: BaleBusInstanceRegistration, captured: BaleBusInstanceRegistration): boolean;
export declare function getBaleFollowerTargetOwnership(input: {
    target: BaleTarget;
    followers: readonly BaleBusFollowerView[];
    activeThreadRecords?: readonly {
        status?: string;
        instanceId?: string;
        profileKey?: string;
        owner?: {
            kind?: string;
        };
        target: BaleTarget;
    }[];
    currentInstanceId?: string;
}): {
    instanceId: string;
    ownerGeneration: string;
    recipientBindingKey: string;
    protocolIdentity: BaleBusProtocolIdentity;
} | undefined;
export declare function markBaleBusCrossTargetDelivery<T extends Record<string, unknown>>(body: T): T;
export declare function stripBaleBusApiMetadata<T extends Record<string, unknown>>(body: T): T;
export declare function isBaleFollowerApiCallAllowed(input: {
    follower: BaleBusFollowerView;
    method: string;
    args: unknown[];
    isMessageOwned?: (chatId: number, messageId: number) => boolean;
}): boolean;
interface BaleFollowerApiCallAuthorizationInput {
    follower: BaleBusFollowerView;
    method: string;
    args: unknown[];
}
export declare function createBaleFollowerApiCallAuthorizer(deps: {
    isMessageOwned(input: {
        chatId: number;
        messageId: number;
        follower: BaleBusFollowerView;
    }): boolean;
}): (input: BaleFollowerApiCallAuthorizationInput) => boolean;
export interface BaleBusAgentTargetSelector {
    chatId?: number;
    threadId?: number;
    threadName?: string;
}
export interface BaleBusAgentMessage {
    target: BaleTarget & {
        threadId: number;
    };
    messageId: number;
    text: string;
}
export interface BaleBusFollowerDeliveryIdentity {
    deliveryId: string;
    sourceUpdateId: number;
    recipientBindingKey: string;
    sourceRecoveryKey?: string;
    sourceClaim?: {
        acquisitionId: string;
        handoffId: string;
    };
}
type BaleBusForeignUpdateFailureClass = "source-update-identity-missing" | "recipient-binding-missing" | "recipient-generation-missing" | "source-reference-missing" | "recipient-ownership-stale" | "transport-failed" | "acknowledgement-missing" | "acknowledgement-rejected" | "acknowledgement-mismatched" | "durable-receipt-missing" | "durable-receipt-mismatched";
export type BaleBusForeignUpdateSettlement = {
    status: "accepted";
    delivery: BaleBusFollowerDeliveryIdentity;
} | {
    status: "retryable" | "terminal-rejected";
    failureClass: BaleBusForeignUpdateFailureClass;
    message: string;
    delivery?: BaleBusFollowerDeliveryIdentity;
    sourceUpdateId?: number;
};
export declare function createBaleBusFollowerDeliveryIdentity(input: {
    kind: "leader.forwardCallback" | "leader.forwardReaction" | "leader.forwardMessage" | "leader.forwardEditedMessage" | "leader.wakeInputCustody";
    recipientBindingKey: string;
    sourceUpdateId: number;
    sourceRecoveryKey?: string;
    sourceClaim?: {
        acquisitionId: string;
        handoffId: string;
    };
}): BaleBusFollowerDeliveryIdentity;
export declare function canUseBaleBusInputCustodyReference(input: {
    local?: BaleBusProtocolIdentity;
    remote?: BaleBusProtocolIdentity;
}): boolean;
export declare function createBaleBusFollowerSourceReferenceDeliveryIdentity(input: {
    kind: "leader.forwardCallback" | "leader.forwardReaction" | "leader.forwardMessage" | "leader.forwardEditedMessage" | "leader.wakeInputCustody";
    recipientBindingKey: string;
    sourceRecoveryKey: string;
    source: {
        updateId: number;
        owner: {
            acquisitionId: string;
            handoffId?: string;
        };
    };
}): BaleBusFollowerDeliveryIdentity;
export type BaleBusEnvelope = ({
    kind: "follower.register";
    requestId: string;
    recoverConnection?: true;
    registration: BaleBusInstanceRegistration;
} | {
    kind: "follower.restoreWorkspace";
    requestId: string;
    registration: BaleBusInstanceRegistration;
} | {
    kind: "follower.heartbeat";
    requestId: string;
    instanceId: string;
    registrationGeneration?: string;
    sentAtMs: number;
} | {
    kind: "follower.disconnect";
    requestId: string;
    instanceId: string;
    registrationGeneration?: string;
    sentAtMs: number;
} | {
    kind: "follower.setThreadDisplayMode";
    requestId: string;
    instanceId: string;
    registrationGeneration: string;
    mode: BaleThreadDisplayMode;
} | {
    kind: "follower.renameThread";
    requestId: string;
    instanceId: string;
    registrationGeneration: string;
    target: BaleTarget & {
        threadId: number;
    };
    threadName: string;
    sentAtMs: number;
} | {
    kind: "follower.resetThreadName";
    requestId: string;
    instanceId: string;
    registrationGeneration: string;
    target: BaleTarget & {
        threadId: number;
    };
    sentAtMs: number;
} | {
    kind: "follower.publishSessionReplacement" | "follower.settleSessionReplacement";
    requestId: string;
    instanceId: string;
    registrationGeneration: string;
    intent: BaleSessionReplacementIntent;
    sentAtMs: number;
} | {
    kind: "leader.forwardCallback";
    requestId: string;
    recipientInstanceId: string;
    recipientRegistrationGeneration: string;
    delivery: BaleBusFollowerDeliveryIdentity;
    query: unknown;
    sentAtMs: number;
} | {
    kind: "leader.forwardReaction";
    requestId: string;
    recipientInstanceId: string;
    recipientRegistrationGeneration: string;
    delivery: BaleBusFollowerDeliveryIdentity;
    reactionUpdate: unknown;
    sentAtMs: number;
} | {
    kind: "leader.forwardMessage";
    requestId: string;
    recipientInstanceId: string;
    recipientRegistrationGeneration: string;
    delivery: BaleBusFollowerDeliveryIdentity;
    message: unknown;
    forwardCommentBatchPosition?: "comment" | "forward";
    sentAtMs: number;
} | {
    kind: "leader.forwardEditedMessage";
    requestId: string;
    recipientInstanceId: string;
    recipientRegistrationGeneration: string;
    delivery: BaleBusFollowerDeliveryIdentity;
    message: unknown;
    sentAtMs: number;
} | {
    kind: "leader.offerInputCustodyHandoff";
    requestId: string;
    recipientInstanceId: string;
    recipientRegistrationGeneration: string;
    recipientBindingKey: string;
    sourceRecoveryKey: string;
    source: {
        journalBindingKey: string;
        tokenSha256: string;
        updateId: number;
    };
    handoffId: string;
    sentAtMs: number;
} | {
    kind: "leader.wakeInputCustody";
    requestId: string;
    recipientInstanceId: string;
    recipientRegistrationGeneration: string;
    delivery: BaleBusFollowerDeliveryIdentity;
    sentAtMs: number;
} | {
    kind: "leader.prepareLiveRebind";
    requestId: string;
    recipientInstanceId: string;
    recipientRegistrationGeneration: string;
    recipientSessionId: string;
    recipientBindingKey: string;
    operationId: string;
    updates: ({
        update_id: number;
    } & Record<string, unknown>)[];
    selectedCommand?: BaleBusSelectedCommandInput;
    sentAtMs: number;
} | {
    kind: "leader.applyLiveRebind";
    requestId: string;
    recipientInstanceId: string;
    recipientRegistrationGeneration: string;
    recipientSessionId: string;
    recipientBindingKey: string;
    operationId: string;
    sourceUpdateIds: number[];
    mode: "apply" | "inspect";
    preparedSource?: BaleBusPreparedCommandSource;
    selectedCommand?: BaleBusSelectedCommandInput;
    sentAtMs: number;
} | {
    kind: "leader.settleLiveRebind";
    requestId: string;
    recipientInstanceId: string;
    recipientRegistrationGeneration: string;
    recipientSessionId: string;
    recipientBindingKey: string;
    operationId: string;
    sourceUpdateIds: number[];
    mode: "release" | "discard" | "observe" | "observe-held" | "observe-command";
    oldTarget?: BaleTarget & {
        threadId: number;
    };
    preparedSource?: BaleBusPreparedCommandSource;
    selectedCommand?: BaleBusSelectedCommandInput;
    sentAtMs: number;
} | {
    kind: "leader.workspaceRestore";
    requestId: string;
    recipientInstanceId: string;
    recipientRegistrationGeneration: string;
    operationId: string;
    mode: "apply" | "inspect";
    sentAtMs: number;
} | {
    kind: "leader.offerQueueHandoff";
    requestId: string;
    recipientInstanceId: string;
    recipientRegistrationGeneration: string;
    donorInstanceId: string;
    donorProcessId: number;
    donorProcessBirthId: string;
    donorSessionGeneration: number;
    donorAcquisitionId: string;
    donorAcquiredAtMs: number;
    handoffToken: string;
    payload: BaleQueueHandoffPayload;
    sentAtMs: number;
} | {
    kind: "follower.offerQueueHandoff";
    requestId: string;
    instanceId: string;
    registrationGeneration: string;
    recipientInstanceId: string;
    recipientRegistrationGeneration: string;
    donorProcessId: number;
    donorProcessBirthId: string;
    donorSessionGeneration: number;
    donorAcquisitionId: string;
    donorAcquiredAtMs: number;
    handoffToken: string;
    payload: BaleQueueHandoffPayload;
    sentAtMs: number;
} | {
    kind: "follower.resolveAgentTarget";
    requestId: string;
    instanceId: string;
    registrationGeneration?: string;
    selector: BaleBusAgentTargetSelector;
    sentAtMs: number;
} | {
    kind: "follower.routeAgentMessage";
    requestId: string;
    instanceId: string;
    registrationGeneration?: string;
    message: BaleBusAgentMessage;
    sentAtMs: number;
} | BaleBusSelectedMenuDelivery | {
    kind: "follower.callApi";
    requestId: string;
    instanceId: string;
    registrationGeneration?: string;
    method: string;
    args: unknown[];
    sentAtMs: number;
} | {
    /** Side-effect-free leader liveness probe; any acknowledgement proves a responsive event loop. */
    kind: "bus.probe";
    requestId: string;
} | {
    kind: "bus.ack";
    requestId: string;
    ok: boolean;
    message?: string;
    result?: unknown;
    protocol?: BaleBusProtocolIdentity;
    error?: {
        code: "commit-unknown" | "request-id-collision" | "ledger-overloaded" | "incompatible-protocol" | "stale-target" | "follower-api-not-allowed" | "workspace-binding-unavailable";
        method?: string;
        chatId?: number;
        threadId?: number;
    };
}) & {
    auth?: string;
};
/** Follower-staged queue handoff offer before the follower adds its own request and registration framing. */
export type BaleBusFollowerQueueHandoffOffer = Omit<Extract<BaleBusEnvelope, {
    kind: "follower.offerQueueHandoff";
}>, "kind" | "requestId" | "instanceId" | "registrationGeneration" | "sentAtMs" | "auth">;
/** Leader-routed queue handoff offer as donors and leaders exchange it before envelope framing. */
export type BaleBusLeaderQueueHandoffOffer = Omit<Extract<BaleBusEnvelope, {
    kind: "leader.offerQueueHandoff";
}>, "kind">;
type BaleBusEnvelopeTrafficClass = "bootstrap" | "generation-fenced" | "response";
export declare function getBaleBusEnvelopeTrafficClass(envelope: BaleBusEnvelope): BaleBusEnvelopeTrafficClass;
export declare function createBaleBusRequestId(input: {
    instanceId: string;
    sequence: number;
}): string;
export declare function createBaleBusRequestIdFactory(instanceId: string): () => string;
export declare function encodeBaleBusEnvelope(envelope: BaleBusEnvelope): string;
export declare function parseBaleBusEnvelope(line: string): BaleBusEnvelope | undefined;
/**
 * One leader liveness observation. `silent` (connected or connecting, no answer within the window) and
 * `unreachable` (an endpoint that refuses connections: nobody listens) can support a takeover. A missing endpoint is
 * `unknown`: a live classic-mode leader has no socket at all. Any bytes or an orderly close prove the peer's event
 * loop handled the connection, so even an older leader rejecting the unknown kind is `responsive`.
 */
export type BaleBusLeaderProbeResult = "responsive" | "silent" | "unreachable" | "unknown";
export declare function probeBaleBusLeader(input: {
    socketPath: BaleBusSocketPathSource;
    secret?: string;
    timeoutMs?: number;
}): Promise<BaleBusLeaderProbeResult>;
/**
 * Takeover evidence replacing the retired file heartbeat: a full silent window, or an unreachable endpoint
 * confirmed again after one more window (a just-started leader binds its socket well within it). The owner must
 * stay the same throughout; the lock acquisition then CAS-checks that exact owner.
 */
export declare function proveBaleBusLeaderUnresponsive(input: {
    probe: () => Promise<BaleBusLeaderProbeResult>;
    isSameOwner: () => boolean;
    sleep: (ms: number) => Promise<void>;
    windowMs?: number;
}): Promise<boolean>;
/** Composition-ready takeover proof for one profile's leader lock and endpoint. */
export declare function createBaleBusLeaderUnresponsivenessProof(deps: {
    getLeaderState: () => BaleLockState;
    getLeaderSocketPath: () => string;
    probe?: typeof probeBaleBusLeader;
    sleep?: (ms: number) => Promise<void>;
}): (owner: BaleLockEntry) => Promise<boolean>;
interface BaleBusLocalServer {
    start: () => Promise<void>;
    stop: () => Promise<void>;
    ensureEndpoint: () => Promise<boolean>;
}
export type BaleBusSocketPathSource = string | (() => string);
export declare function resolveBaleBusSocketPath(source: BaleBusSocketPathSource, platform?: NodeJS.Platform | string): string;
interface BaleBusLocalServerDeps {
    socketPath: BaleBusSocketPathSource;
    handleEnvelope: (envelope: BaleBusEnvelope) => Promise<BaleBusEnvelope | undefined> | BaleBusEnvelope | undefined;
    recordTransportEvent?: BaleBusTransportEventRecorder;
    beforeEndpointPublication?: () => Promise<void> | void;
    commitEndpointPublication?: (commit: () => void) => boolean;
    requestLedgerMaxEntries?: number;
    shouldDropResponse?: (request: BaleBusEnvelope, response: BaleBusEnvelope) => boolean;
}
/** Local IPC issuance proof only: this callback/error never enters the envelope or certifies a remote API effect. */
export declare class BaleBusLocalAuthorityError extends Error {
    readonly requestIssued: boolean;
    constructor(requestIssued: boolean, reason?: string);
}
interface BaleBusLocalClientOptions {
    assertAuthority?: () => void;
    socketPath: string;
    envelope: BaleBusEnvelope;
    timeoutMs?: number;
    retry?: BaleBusTransportRetryPolicy;
    recordTransportEvent?: BaleBusTransportEventRecorder;
}
interface BaleBusForeignOwnedForwarderDeps<TMessage = unknown> {
    socketPath: BaleBusSocketPathSource;
    createRequestId: () => string;
    getNowMs?: () => number;
    timeoutMs?: number;
    getAuthSecret?: () => string | undefined;
    getForwardCommentBatchPosition?: (message: TMessage) => "comment" | "forward" | undefined;
    localProtocolIdentity?: BaleBusProtocolIdentity;
    validateForwardOwnership?: (ownership: BaleBusForwardOwnership) => boolean;
    resolveInputCustodyReference?: (input: {
        sourceUpdateId: number;
        recipientBindingKey: string;
    }) => {
        sourceRecoveryKey: string;
        source: {
            updateId: number;
            owner: {
                acquisitionId: string;
                handoffId?: string;
            };
        };
    } | undefined;
    recordRuntimeEvent?: (category: string, error: unknown, details?: Record<string, unknown>) => void;
}
export interface BaleBusForwardOwnership {
    instanceId: string;
    ownerGeneration?: string;
    recipientBindingKey?: string;
    protocolIdentity?: BaleBusProtocolIdentity;
}
export declare function isBaleBusForwardOwnershipCurrent(expected: BaleBusForwardOwnership, current: BaleBusForwardOwnership | undefined): boolean;
export declare function createBaleBusForeignOwnedUpdateForwarder<TContext, TReactionUpdate, TCallbackQuery, TMessage = unknown>(deps: BaleBusForeignOwnedForwarderDeps<TMessage>): {
    forwardCallback: (input: {
        query: TCallbackQuery;
        ownership: BaleBusForwardOwnership;
        ctx: TContext;
    }) => Promise<BaleBusForeignUpdateSettlement>;
    forwardReaction: (input: {
        reactionUpdate: TReactionUpdate;
        ownership: BaleBusForwardOwnership;
        ctx: TContext;
    }) => Promise<BaleBusForeignUpdateSettlement>;
    forwardMessage: (input: {
        message: TMessage;
        ownership: BaleBusForwardOwnership;
        ctx: TContext;
        /** Process-local source/recipient lifetime; never part of the wire envelope. */
        assertAuthority?: () => void;
    }) => Promise<BaleBusForeignUpdateSettlement>;
    forwardEditedMessage: (input: {
        message: TMessage;
        ownership: BaleBusForwardOwnership;
        ctx: TContext;
    }) => Promise<BaleBusForeignUpdateSettlement>;
};
export declare function listBaleBusLiveThreadTargets(input: {
    leaderTarget?: BaleTarget;
    followers: readonly BaleBusFollowerView[];
}): BaleTarget[];
/** Caller owns the durable one-shot apply grant. Inspections never grant another apply. */
export declare function createBaleBusWorkspaceRestoreController(deps: {
    getFollower: (instanceId: string) => BaleBusFollowerView | undefined;
    localProtocolIdentity: BaleBusProtocolIdentity;
    createRequestId: () => string;
    getAuthSecret: () => string | undefined;
    timeoutMs?: number;
}): (input: {
    operationId: string;
    instanceId: string;
    sessionId: string;
    slot: string;
    target: BaleTarget & {
        threadId: number;
    };
    oldTarget: BaleTarget & {
        threadId: number;
    };
    mode: "apply" | "inspect";
    isCurrent: () => boolean;
}) => Promise<BaleBusWorkspaceRestoreObservation | undefined>;
/** Each capability has its own effect boundary; transport retries never replay save/dispatch/disposal. */
export declare function createBaleBusLiveRebindController(deps: {
    getFollower(instanceId: string): BaleBusFollowerView | undefined;
    localProtocolIdentity: BaleBusProtocolIdentity;
    createRequestId(): string;
    getAuthSecret(): string | undefined;
    timeoutMs?: number;
}): (input: {
    operationId: string;
    instanceId: string;
    sessionId: string;
    recipientBindingKey: string;
    isCurrent(): boolean;
    selectedCommand?: BaleBusSelectedCommandInput;
    preparedSource?: BaleBusPreparedCommandSource;
} & ({
    updates: ({
        update_id: number;
    } & Record<string, unknown>)[];
} | {
    mode: "apply" | "inspect" | "release" | "discard" | "observe" | "observe-held" | "observe-command";
    sourceUpdateIds: number[];
    slot: string;
    target: BaleTarget & {
        threadId: number;
    };
    oldTarget: BaleTarget & {
        threadId: number;
    };
})) => Promise<BaleBusLiveRebindSaveObservation | BaleBusLiveRebindApplyObservation | BaleBusLiveRebindSettlementObservation | BaleBusLiveRebindWorkObservation | BaleBusLiveRebindCommandObservation | undefined>;
export declare function isBaleBusEnvelopeAuthorized(envelope: BaleBusEnvelope, secret: string | undefined): boolean;
/** Negative acknowledgement carrying only a diagnostic message. */
export declare const BALE_BUS_FOLLOWER_API_NOT_ALLOWED_MESSAGE = "Bale bus API call is not allowed for this follower.";
export declare function rejectBaleBusRequest(requestId: string, message: string): Extract<BaleBusEnvelope, {
    kind: "bus.ack";
}>;
export declare function createUnauthorizedBusAck(requestId: string): BaleBusEnvelope;
export declare function createBaleBusLocalServer(deps: BaleBusLocalServerDeps): BaleBusLocalServer;
export declare function sendBaleBusLocalEnvelope(options: BaleBusLocalClientOptions): Promise<BaleBusEnvelope | undefined>;
export interface BaleBusFollowerRegistry {
    register: (registration: BaleBusInstanceRegistration) => BaleBusFollowerView;
    heartbeat: (instanceId: string, nowMs: number) => BaleBusFollowerView | undefined;
    get: (instanceId: string) => BaleBusFollowerView | undefined;
    getByTarget: (target: BaleTarget) => BaleBusFollowerView | undefined;
    list: () => BaleBusFollowerView[];
    remove: (instanceId: string) => boolean;
    clear: () => void;
    observeUnregistered: (follower: BaleBusFollowerView) => {
        isCurrent: () => boolean;
        release: () => void;
    };
    pruneStale: (nowMs: number, staleAfterMs: number) => BaleBusFollowerView[];
}
export declare function createBaleBusForwardOwnershipValidator(registry: Pick<BaleBusFollowerRegistry, "get">): (ownership: BaleBusForwardOwnership) => boolean;
export declare function createBaleBusFollowerRegistry(): BaleBusFollowerRegistry;
/** Shared closed text-effect codec; parsing alone supplies no recipient or issuance authority. */
export declare function parseBaleBusSelectedMenuTextEffect(effect: unknown): BaleBusSelectedMenuTextEffect | undefined;
export {};

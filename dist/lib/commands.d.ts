/**
 * Bale command routing helpers
 * Zones: bale controls, pi agent commands, queue controls
 * Owns Bale slash-command normalization, bot command metadata, pi-side command registration, and command-initiated session replacement orchestration behind runtime ports
 */
import type { BaleActivityPublicationWork } from "./activity.ts";
import { type BaleConfigStore } from "./config.ts";
import type * as Pi from "./pi.ts";
import type { ExtensionAPI, ExtensionCommandContext } from "./pi.ts";
import type { BalePromptTemplateCommand } from "./prompt-templates.ts";
import { createBaleControlItemBuilder, type PendingBaleControlItem, type BaleControlQueueController, type BaleControlQueueControllerDeps, type BaleQueueAdmissionReceipt } from "./queue.ts";
import { type BaleBridgeStatusLineOptions } from "./status.ts";
import { type BaleApiCallOptions } from "./bale-api.ts";
import type { BaleTarget } from "./target.ts";
import type { BaleSessionReplacementIntent } from "./threads.ts";
import { type BaleDeferredSourceEvidence, type BaleLiveSourceCompletionReadiness, type BaleQueueAdmissionReceiptLike } from "./updates.ts";
export type BaleHeldCommandName = "status" | "start" | "help" | "abort" | "stop" | "next" | "continue";
/** Commands-owned no-fold admission over the ordinary recipient queue; source reporting stays separate from removal. */
export interface BaleHeldTurnAdmission {
    assertCurrent(): void;
    report(receipts: readonly BaleQueueAdmissionReceiptLike[]): void;
}
export interface BalePreparedHeldCommand {
    readonly source: BaleDeferredSourceEvidence;
    readonly command: ParsedBaleCommand;
    bindCarrier(value: unknown): boolean;
    execute(): Promise<boolean>;
    /** Source disposal only, independent of detached delivery and ended source-execution/chooser callbacks. */
    inspectCompletion(): BaleDeferredSourceEvidence | undefined;
}
/** Saved-original admission for a held follower plan: fixed target plus independent source and recipient lifetimes. */
export interface BaleHeldCommandAdmission {
    target: {
        chatId: number;
        threadId: number;
    };
    assertSourceCurrent(): void;
    assertRecipientCurrent(): void;
}
/** Recipient-scoped reply sender; the plan never falls back to ordinary follower API delivery. */
export interface BaleHeldCommandReply {
    sendTextReply(chatId: number, replyToMessageId: number, text: string, options: {
        parseMode?: "HTML";
        target: {
            chatId: number;
            threadId: number;
        };
        assertAuthority: () => void;
    }): Promise<unknown>;
}
/** Captured recipient effects; a supplied but unavailable effect never falls back to ordinary dispatch. */
export type BaleHeldCommandEffects<TContext> = Partial<BaleHeldCommandReply & Pick<BaleCommandHandlerTargetRuntimeDeps<BaleCommandRuntimeMessage, TContext>, "showStatus">>;
export interface ParsedBaleCommand {
    name: string;
    args: string;
}
/** Exact singleton operator-private text command original eligible for a held follower plan. */
export declare function isBaleSelectedHeldOriginal(update: unknown, target: {
    chatId: number;
    threadId: number;
}, operator: number | undefined, name: string): boolean;
export interface BaleBotCommandDefinition {
    command: string;
    description: string;
}
export interface BalePromptTemplateMenuCommand {
    command: string;
    description?: string;
}
export interface BaleExtensionCommandContext {
    name: string;
    args: string;
    reply: (text: string) => Promise<void>;
    enqueuePrompt: (prompt: string) => Promise<void>;
}
export interface SelectedPreparationInput {
    readonly name: string;
    readonly args: string;
}
export interface SelectedCommandExecution {
    /** Recheck before producer mutations and after awaits; this is a trusted contract, not a sandbox. */
    assertCurrent(): void;
    /** Acceptance of semantic completion only, never a source-removal ACK or delivery/cleanup proof. */
    reportCompleted(): boolean;
    /** Queue detached recipient text without waiting for delivery as semantic completion. */
    reply(text: string): void;
}
export type PreparedSelectedCommand = {
    kind: "command-only";
    execute(ctx: SelectedCommandExecution): void | Promise<void>;
} | {
    kind: "generated-prompt";
    prompt: string;
};
export interface BaleExtensionCommandRegistration {
    name: string;
    description?: string;
    order?: number;
    showInMenu?: boolean;
    emoji?: string;
    handler: (ctx: BaleExtensionCommandContext) => Promise<void> | void;
    /** Trusted side-effect-free plan preparation for single-message leader selection; ordinary dispatch still uses handler. */
    selected?: {
        prepare(input: SelectedPreparationInput): PreparedSelectedCommand | undefined | Promise<PreparedSelectedCommand | undefined>;
    };
}
interface RegisteredBaleExtensionCommand {
    name: string;
    description?: string;
    order: number;
    showInMenu: boolean;
    emoji?: string;
    handler: BaleExtensionCommandRegistration["handler"];
    selected?: Readonly<BaleExtensionCommandRegistration["selected"]>;
}
export declare function registerBaleCommand(registration: BaleExtensionCommandRegistration): () => void;
export declare function findBaleExtensionCommand(name: string | undefined): RegisteredBaleExtensionCommand | undefined;
/** Preparation only: no execution, admission, source freeze or binding effects. Routing owns those later. */
export declare function prepareBaleSelectedExtensionCommand(command: ParsedBaleCommand, authority: {
    assertSourceCurrent(): void;
    assertRecipientCurrent(): void;
}): Promise<{
    plan: Readonly<PreparedSelectedCommand>;
    assertRegistrationCurrent(): void;
} | undefined>;
export declare function clearBaleExtensionCommands(): void;
export declare const BALE_COMMAND_EMOJI: {
    readonly start: "🟢";
    readonly status: "📊";
    readonly model: "🤖";
    readonly thinking: "🧠";
    readonly compact: "🗜";
    readonly queue: "🔢";
    readonly thread: "🧵";
    readonly next: "⏩";
    readonly continue: "▶️";
    readonly abort: "⏹️";
    readonly stop: "🟥";
    readonly name: "🏷️";
    readonly new: "🆕";
};
export type BaleCommandEmojiName = keyof typeof BALE_COMMAND_EMOJI;
export declare function formatBaleCommandEmojiPrefix(command: BaleCommandEmojiName): string;
export declare function formatBalePiCommandHtml(command: string): string;
export declare function formatBaleInformationHeading(emoji: string, text: string): string;
export declare function formatBaleInvalidInstanceName(validationError: string): string;
export declare function formatBaleThreadDisplayNameSavedHeading(name: string): string;
export declare function formatBaleAutomaticThreadDisplayNameRestoredHeading(name: string): string;
export declare const BALE_COMPACTION_STARTED_MARKDOWN: string;
export declare const BALE_COMPACTION_COMPLETED_MARKDOWN = "**\u2705 Compaction completed.**";
export declare const BALE_BOT_COMMANDS: readonly BaleBotCommandDefinition[];
export declare function getBaleReservedCommandNames(): string[];
export interface BaleBotCommandRegistrationDeps {
    setMyCommands: (commands: readonly BaleBotCommandDefinition[], options?: Pick<BaleApiCallOptions, "assertAuthority">) => Promise<unknown>;
}
export declare function registerBaleBotCommands(deps: BaleBotCommandRegistrationDeps, options?: Pick<BaleApiCallOptions, "assertAuthority">): Promise<void>;
export declare function createBaleBotCommandRegistrar(deps: BaleBotCommandRegistrationDeps): (options?: Pick<BaleApiCallOptions, "assertAuthority">) => Promise<void>;
export interface BaleBridgeCommandStartPollingOptions {
    force?: boolean;
    forceFreshLeaderThread?: boolean;
}
export interface BaleBridgeCommandStartPollingResult {
    ok: boolean;
    message?: string;
    canTakeover?: boolean;
    owner?: string;
}
export interface BaleBridgeCommandRegistrationDeps {
    handleInternalAction?: BaleSessionActionRuntime["handleInternalAction"];
    promptForConfig: (ctx: ExtensionCommandContext, profileName?: string) => Promise<void>;
    getStatusLines: (options?: BaleBridgeStatusLineOptions) => string[];
    reloadConfig: () => Promise<void>;
    hasBotToken: () => boolean;
    getBotTokenDiagnostic?: () => string | undefined;
    startPolling: (ctx: ExtensionCommandContext, options?: BaleBridgeCommandStartPollingOptions) => void | Promise<void | BaleBridgeCommandStartPollingResult> | BaleBridgeCommandStartPollingResult;
    stopPolling: () => Promise<void | string>;
    recordConnectionEvent?: (error: unknown, phase: string) => void;
    getDisconnectThreadName?: () => string | undefined;
    queueAgentConnectionContext?: (connected: boolean) => void;
    updateStatus: (ctx: ExtensionCommandContext) => void;
    isContextCurrent?: (ctx: ExtensionCommandContext) => boolean;
    getSessionGeneration?: () => number;
    connectionIntent?: {
        begin(cwd: string, profileName?: string): string;
        finish(id: string): void;
        isActive(id: string): boolean;
        cancel(): void;
    };
    getProfileNames?: () => string[];
    activateDefaultProfileConfig?: (ctx: ExtensionCommandContext, isCurrent: () => boolean) => Promise<void>;
    activateProfileConfig?: (ctx: ExtensionCommandContext, profileName: string, isCurrent: () => boolean) => Promise<boolean>;
}
/** Bound adapters must carry the optional recipient guard through their own effect/publication awaits. */
export type BaleThreadDisplayNameRenamePort = (target: {
    chatId: number;
    threadId?: number;
}, threadName: string, options?: Pick<BaleApiCallOptions, "assertAuthority">) => Promise<{
    ok: boolean;
    threadName?: string;
    message?: string;
}>;
/** Reset adapters must preserve the same optional recipient lifetime as manual rename adapters. */
export type BaleThreadDisplayNameResetPort = (target: {
    chatId: number;
    threadId?: number;
}, options?: Pick<BaleApiCallOptions, "assertAuthority">) => Promise<{
    ok: boolean;
    threadName?: string;
    message?: string;
}>;
export declare function createBaleThreadDisplayNameResetBinding(): {
    bind: (reset: BaleThreadDisplayNameResetPort) => void;
    reset: BaleThreadDisplayNameResetPort;
};
export declare function createBaleThreadDisplayNameRenameBinding(): {
    bind: (rename: BaleThreadDisplayNameRenamePort) => void;
    rename: BaleThreadDisplayNameRenamePort;
};
export declare function registerBaleBridgeCommands(pi: ExtensionAPI, deps: BaleBridgeCommandRegistrationDeps): void;
export declare const BALE_RESERVED_COMMAND_NAMES: readonly ["stop", "name", "new", "abort", "next", "continue", "status", "queue", "compact", "model", "thinking", "settings", "help", "start"];
export type BaleReservedCommandName = (typeof BALE_RESERVED_COMMAND_NAMES)[number];
export declare function isBaleReservedCommandName(commandName: string | undefined): commandName is BaleReservedCommandName;
export type BaleCommandAction = {
    kind: "ignore";
    executionMode: "ignored";
} | {
    kind: "stop";
    executionMode: "immediate";
} | {
    kind: "name";
    executionMode: "immediate";
} | {
    kind: "new";
    executionMode: "immediate";
} | {
    kind: "abort";
    executionMode: "immediate";
} | {
    kind: "next";
    executionMode: "immediate";
} | {
    kind: "continue";
    executionMode: "immediate";
} | {
    kind: "queue";
    executionMode: "immediate";
} | {
    kind: "compact";
    executionMode: "immediate";
} | {
    kind: "status";
    executionMode: "immediate";
} | {
    kind: "model";
    executionMode: "immediate";
} | {
    kind: "thinking";
    executionMode: "immediate";
} | {
    kind: "settings";
    executionMode: "immediate";
} | {
    kind: "help";
    commandName: "help" | "start";
    executionMode: "immediate";
};
export interface BaleCommandActionDeps<TMessage, TContext> {
    handleStop: (message: TMessage, ctx: TContext) => Promise<void>;
    handleName: (message: TMessage, ctx: TContext, name: string) => Promise<void>;
    handleNew: (message: TMessage, ctx: TContext) => Promise<void>;
    handleAbort: (message: TMessage, ctx: TContext) => Promise<void>;
    handleNext: (message: TMessage, ctx: TContext) => Promise<void>;
    handleContinue: (message: TMessage, ctx: TContext) => Promise<void>;
    handleQueue: (message: TMessage, ctx: TContext) => Promise<void>;
    handleCompact: (message: TMessage, ctx: TContext) => Promise<void>;
    handleStatus: (message: TMessage, ctx: TContext) => Promise<void>;
    handleModel: (message: TMessage, ctx: TContext) => Promise<void>;
    handleThinking: (message: TMessage, ctx: TContext) => Promise<void>;
    handleSettings?: (message: TMessage, ctx: TContext) => Promise<void>;
    handleHelp: (message: TMessage, commandName: "help" | "start", ctx: TContext) => Promise<void>;
}
export interface BaleStopCommandDeps {
    hasAbortHandler: () => boolean;
    clearPendingModelSwitch: () => void;
    cancelNextTransitionAnnouncements?: () => void;
    clearQueuedBaleItems: () => number;
    setFoldQueuedPromptsIntoHistory: (fold: boolean) => void;
    abortCurrentTurn: () => void;
    updateStatus: () => void;
    sendTextReply: (text: string, options?: {
        parseMode?: "HTML";
    }) => Promise<void>;
}
export interface BaleRuntimeEventRecorderPort {
    recordRuntimeEvent?: (category: string, error: unknown, details?: Record<string, unknown>) => void;
}
export interface BaleCompactConfirmationReplyMarkup {
    inline_keyboard: {
        text: string;
        callback_data: string;
    }[][];
}
/** Pi or Bale work that must drain before a session-level command may replace or compact the session. */
export interface BaleSessionBusyPorts {
    isIdle: () => boolean;
    hasPendingMessages: () => boolean;
    hasActiveBaleTurn: () => boolean;
    hasDispatchPending: () => boolean;
    hasQueuedBaleItems: () => boolean;
    isCompactionInProgress: () => boolean;
}
export interface BaleCompactCommandDeps extends BaleRuntimeEventRecorderPort, BaleSessionBusyPorts {
    setCompactionInProgress: (inProgress: boolean) => void;
    updateStatus: () => void;
    dispatchNextQueuedBaleTurn: () => void;
    requestDeferredDispatchNextQueuedBaleTurn?: (dispatch: () => void) => void;
    startTypingLoop?: () => void;
    stopTypingLoop?: () => void;
    compact: (callbacks: {
        onComplete: () => void;
        onError: (error: unknown) => void;
    }) => void;
    sendTextReply: (text: string, options?: {
        parseMode?: "HTML";
    }) => Promise<void>;
    suppressStartNotice?: boolean;
}
export interface BaleCompactConfirmationDeps {
    sendInteractiveMessage: (chatId: number, text: string, mode: "markdown" | "html" | "plain", replyMarkup: BaleCompactConfirmationReplyMarkup, options?: {
        target?: {
            chatId: number;
            threadId?: number;
        };
        assertAuthority?: BaleApiCallOptions["assertAuthority"];
    }) => Promise<number | undefined>;
}
export interface BaleCompactConfirmationCallbackQuery {
    id: string;
    data?: string;
    message?: {
        chat?: {
            id?: number;
        };
        message_id?: number;
        message_thread_id?: number;
    };
}
export interface BaleNewConfirmationCallbackDeps<TContext> {
    ctx: TContext;
    answerCallbackQuery: (callbackQueryId: string, text?: string) => Promise<void>;
    editInteractiveMessage: (chatId: number, messageId: number, text: string, mode: "markdown" | "html" | "plain", replyMarkup: BaleCompactConfirmationReplyMarkup) => Promise<void>;
    deleteMessage: (chatId: number, messageId: number) => Promise<void>;
    runNew: (ctx: TContext) => Promise<void>;
}
export interface BaleCompactConfirmationCallbackDeps<TContext> {
    ctx: TContext;
    answerCallbackQuery: (callbackQueryId: string, text?: string) => Promise<void>;
    editInteractiveMessage: (chatId: number, messageId: number, text: string, mode: "markdown" | "html" | "plain", replyMarkup: BaleCompactConfirmationReplyMarkup) => Promise<void>;
    runCompact: (ctx: TContext, chatId: number, replyToMessageId: number, target?: {
        chatId: number;
        threadId?: number;
    }) => Promise<void>;
}
export type BaleControlCommandType = PendingBaleControlItem<unknown>["controlType"];
export interface BaleCommandRuntimeMessage {
    chat: {
        id: number;
        type?: string;
        title?: string;
    };
    message_id: number;
    message_thread_id?: number;
    from?: {
        id?: number;
        is_bot?: boolean;
    };
    pi_bale_source_update_id?: number;
}
export interface BaleCommandMessageTarget {
    chatId: number;
    threadId?: number;
    replyToMessageId: number;
}
export interface BaleCommandTargetRuntimeDeps<TContext> {
    enqueueControlItem: (target: BaleCommandMessageTarget, ctx: TContext, controlType: BaleControlCommandType, statusSummary: string, execute: (ctx: TContext) => Promise<void>, admissionReceipts?: BaleQueueAdmissionReceipt[], onQueued?: (item: PendingBaleControlItem<TContext>) => void) => void;
    getAdmissionScope?: () => string | undefined;
    getAdmissionJournalBinding?: () => string | undefined;
    /** Ordinary reply destination selected before publication, not resend authority. */
    getReplyTarget?: (message: BaleCommandRuntimeMessage) => BaleTarget | undefined;
    onControlQueued?: (message: BaleCommandRuntimeMessage, receipt: BaleQueueAdmissionReceipt) => void;
    showStatus: (chatId: number, replyToMessageId: number | undefined, ctx: TContext, threadId?: number, options?: Pick<BaleApiCallOptions, "assertAuthority">) => Promise<void>;
    openModelMenu: (chatId: number, replyToMessageId: number | undefined, ctx: TContext, threadId?: number, options?: Pick<BaleApiCallOptions, "assertAuthority">) => Promise<void>;
    openSettingsMenu?: (chatId: number, replyToMessageId: number | undefined, ctx: TContext, threadId?: number, options?: Pick<BaleApiCallOptions, "assertAuthority">) => Promise<void>;
    sendTextReply: (chatId: number, replyToMessageId: number | undefined, text: string, options?: {
        parseMode?: "HTML";
        target?: {
            chatId: number;
            threadId?: number;
        };
        assertAuthority?: BaleApiCallOptions["assertAuthority"];
    }) => Promise<unknown>;
}
export interface BaleCommandTargetRuntime<TMessage extends BaleCommandRuntimeMessage, TContext> {
    enqueueControlItem: (message: TMessage, ctx: TContext, controlType: BaleControlCommandType, statusSummary: string, execute: (ctx: TContext) => Promise<void>) => void;
    showStatus: (message: TMessage, ctx: TContext, options?: Pick<BaleApiCallOptions, "assertAuthority">) => Promise<void>;
    openModelMenu: (message: TMessage, ctx: TContext, options?: Pick<BaleApiCallOptions, "assertAuthority">) => Promise<void>;
    openSettingsMenu: (message: TMessage, ctx: TContext, options?: Pick<BaleApiCallOptions, "assertAuthority">) => Promise<void>;
    sendTextReply: (message: TMessage, text: string, options?: {
        parseMode?: "HTML";
        assertAuthority?: BaleApiCallOptions["assertAuthority"];
    }) => Promise<void>;
}
export declare function getBaleCommandMessageTarget(message: BaleCommandRuntimeMessage): BaleCommandMessageTarget;
export declare function createBaleCommandControlEnqueueAdapter<TContext>(deps: {
    createControlItem: ReturnType<typeof createBaleControlItemBuilder<TContext>>;
    enqueueControlItem: BaleControlQueueController<TContext>["enqueue"];
}): BaleCommandTargetRuntimeDeps<TContext>["enqueueControlItem"];
export type BaleCommandTargetQueueRuntimeDeps<TContext> = BaleControlQueueControllerDeps<TContext> & {
    createControlItem: ReturnType<typeof createBaleControlItemBuilder<TContext>>;
} & Omit<BaleCommandTargetRuntimeDeps<TContext>, "enqueueControlItem">;
export declare function createBaleCommandTargetQueueRuntime<TMessage extends BaleCommandRuntimeMessage, TContext>(deps: BaleCommandTargetQueueRuntimeDeps<TContext>): BaleCommandTargetRuntime<TMessage, TContext>;
export declare function createBaleCommandTargetRuntime<TMessage extends BaleCommandRuntimeMessage, TContext>(deps: BaleCommandTargetRuntimeDeps<TContext>): BaleCommandTargetRuntime<TMessage, TContext>;
export interface BaleCommandOrPromptDispatcherDeps<TMessage, TContext> {
    extractRawText: (messages: TMessage[]) => string;
    shouldIgnoreMessages?: (messages: TMessage[]) => boolean;
    consumeThreadNameInput?: (messages: TMessage[], ctx: TContext) => Promise<boolean>;
    handleCommand: (commandName: string | undefined, message: TMessage, ctx: TContext, commandArgs?: string) => Promise<boolean>;
    executeExtensionCommand?: (command: ParsedBaleCommand, message: TMessage, ctx: TContext) => Promise<boolean>;
    expandPromptTemplateCommand?: (commandName: string, args: string) => string | undefined;
    replaceMessageText: (message: TMessage, text: string) => TMessage;
    enqueueTurn: (messages: TMessage[], ctx: TContext) => Promise<void>;
    assertExecutionCurrent?: (message: TMessage) => void;
}
interface BaleCommandEffectWorkPort {
    beginCommandEffectWork?: () => BaleActivityPublicationWork;
}
export interface BaleCommandRuntimeDeps<TMessage extends BaleCommandRuntimeMessage, TContext> extends BaleRuntimeEventRecorderPort, BaleCommandEffectWorkPort {
    hasAbortHandler: () => boolean;
    clearPendingModelSwitch: () => void;
    hasQueuedBaleItems: () => boolean;
    clearQueuedBaleItems: (ctx: TContext) => number;
    setFoldQueuedPromptsIntoHistory: (fold: boolean) => void;
    abortCurrentTurn: () => void;
    isIdle: (ctx: TContext) => boolean;
    hasPendingMessages: (ctx: TContext) => boolean;
    hasActiveBaleTurn: () => boolean;
    hasDispatchPending: () => boolean;
    isCompactionInProgress: () => boolean;
    setCompactionInProgress: (inProgress: boolean) => void;
    updateStatus: (ctx: TContext) => void;
    isContextActive?: (ctx: TContext) => boolean;
    dispatchNextQueuedBaleTurn: (ctx: TContext) => void;
    requestNextDispatchAnnouncement?: () => void;
    markActiveTurnNextAbortAnnouncement?: () => boolean;
    cancelNextTransitionAnnouncements?: () => void;
    requestDeferredDispatchNextQueuedBaleTurn?: (dispatch: (ctx: TContext) => void) => void;
    startTypingLoop?: (ctx: TContext, chatId?: number, options?: {
        target?: {
            chatId: number;
            threadId?: number;
        };
    }) => void;
    stopTypingLoop?: () => void;
    enqueueContinueTurn: (message: TMessage, ctx: TContext) => Promise<void>;
    heldTurn?: {
        enqueue(message: TMessage, ctx: TContext, kind: "continue" | "prompt", admission: BaleHeldTurnAdmission): Promise<void>;
        templates?: {
            getCommands(): readonly BalePromptTemplateCommand[];
            expand(name: string, args: string): string | undefined;
        };
    };
    requestNewSession?: (message: TMessage) => void;
    compact: (ctx: TContext, callbacks: {
        onComplete: () => void;
        onError: (error: unknown) => void;
    }) => void;
    enqueueControlItem: (message: TMessage, ctx: TContext, controlType: BaleControlCommandType, statusSummary: string, execute: (ctx: TContext) => Promise<void>) => void;
    showStatus: (message: TMessage, ctx: TContext, options?: Pick<BaleApiCallOptions, "assertAuthority">) => Promise<void>;
    /** Supplied adapters must forward recipient authority into issuance and recheck it after awaits. */
    handleForumBootstrap?: (message: TMessage, ctx: TContext, options?: Pick<BaleApiCallOptions, "assertAuthority">) => Promise<string | undefined>;
    openModelMenu: (message: TMessage, ctx: TContext, options?: Pick<BaleApiCallOptions, "assertAuthority">) => Promise<void>;
    openThinkingMenu: (message: TMessage, ctx: TContext, options?: Pick<BaleApiCallOptions, "assertAuthority">) => Promise<void>;
    openQueueMenu: (message: TMessage, ctx: TContext, options?: Pick<BaleApiCallOptions, "assertAuthority">) => Promise<void>;
    openSettingsMenu?: (message: TMessage, ctx: TContext, options?: Pick<BaleApiCallOptions, "assertAuthority">) => Promise<void>;
    validateThreadName?: (threadName: string) => string | undefined;
    renameCurrentThread?: BaleThreadDisplayNameRenamePort;
    resetCurrentThreadName?: BaleThreadDisplayNameResetPort;
    openThreadNameDialog?: (message: TMessage, ctx: TContext, admission?: {
        assertSemanticCurrent(): void;
        assertRecipientCurrent(): void;
    }) => Promise<void | {
        assertPublished(): void;
    }>;
    getAllowedUserId: () => number | undefined;
    persistAllowedUserId: BaleConfigStore["persistAllowedUserId"];
    registerBotCommands: (options?: Pick<BaleApiCallOptions, "assertAuthority">) => Promise<void>;
    getPromptTemplateCommands?: () => readonly BalePromptTemplateMenuCommand[];
    sendTextReply: (message: TMessage, text: string, options?: {
        parseMode?: "HTML";
        assertAuthority?: BaleApiCallOptions["assertAuthority"];
    }) => Promise<void>;
    getActiveTurnReply?: () => ((text: string, options?: {
        parseMode?: "HTML";
    }) => Promise<void>) | undefined;
    sendInteractiveMessage?: BaleCompactConfirmationDeps["sendInteractiveMessage"];
    assertExecutionCurrent?: (message: TMessage) => void;
}
export declare const BALE_APP_MENU_INTRO_HTML: string;
export declare function buildBaleAppMenuHtml(statusHtml: string, promptTemplates?: readonly BalePromptTemplateMenuCommand[]): string;
export declare function createBaleAppMenuHtmlBuilder<TContext>(deps: {
    buildStatusHtml: (ctx: TContext) => string;
    getPromptTemplateCommands?: () => readonly BalePromptTemplateMenuCommand[];
}): (ctx: TContext) => string;
export declare function parseBaleCommand(text: string): ParsedBaleCommand | undefined;
export declare const BALE_COMMAND_ACTIONS: {
    readonly stop: {
        readonly kind: "stop";
        readonly executionMode: "immediate";
    };
    readonly name: {
        readonly kind: "name";
        readonly executionMode: "immediate";
    };
    readonly new: {
        readonly kind: "new";
        readonly executionMode: "immediate";
    };
    readonly abort: {
        readonly kind: "abort";
        readonly executionMode: "immediate";
    };
    readonly next: {
        readonly kind: "next";
        readonly executionMode: "immediate";
    };
    readonly continue: {
        readonly kind: "continue";
        readonly executionMode: "immediate";
    };
    readonly status: {
        readonly kind: "status";
        readonly executionMode: "immediate";
    };
    readonly queue: {
        readonly kind: "queue";
        readonly executionMode: "immediate";
    };
    readonly compact: {
        readonly kind: "compact";
        readonly executionMode: "immediate";
    };
    readonly model: {
        readonly kind: "model";
        readonly executionMode: "immediate";
    };
    readonly thinking: {
        readonly kind: "thinking";
        readonly executionMode: "immediate";
    };
    readonly settings: {
        readonly kind: "settings";
        readonly executionMode: "immediate";
    };
    readonly help: {
        readonly kind: "help";
        readonly commandName: "help";
        readonly executionMode: "immediate";
    };
    readonly start: {
        readonly kind: "help";
        readonly commandName: "start";
        readonly executionMode: "immediate";
    };
};
export declare function buildBaleCommandAction(commandName: string | undefined): BaleCommandAction;
export declare function handleBaleStopCommand(deps: BaleStopCommandDeps): Promise<void>;
export declare function handleBaleAbortCommand(deps: {
    hasAbortHandler: () => boolean;
    hasActiveBaleTurn: () => boolean;
    clearPendingModelSwitch: () => void;
    cancelNextTransitionAnnouncements?: () => void;
    abortCurrentTurn: () => void;
    setFoldQueuedPromptsIntoHistory: (fold: boolean) => void;
    updateStatus: () => void;
    sendTextReply: (text: string, options?: {
        parseMode?: "HTML";
    }) => Promise<void>;
}): Promise<void>;
export declare function handleBaleNextCommand(deps: {
    hasAbortHandler: () => boolean;
    isIdle: () => boolean;
    hasQueuedItems: () => boolean;
    clearPendingModelSwitch: () => void;
    abortCurrentTurn: () => void;
    dispatchNextQueuedTurn: () => void;
    requestNextDispatchAnnouncement?: () => void;
    markActiveTurnNextAbortAnnouncement?: () => boolean;
    clearFoldForDispatch: () => void;
    updateStatus: () => void;
    sendTextReply: (text: string, options?: {
        parseMode?: "HTML";
    }) => Promise<void>;
    getActiveTurnReply?: () => ((text: string, options?: {
        parseMode?: "HTML";
    }) => Promise<void>) | undefined;
}): Promise<void>;
export declare function openBaleNewConfirmation(target: BaleCommandMessageTarget, deps: BaleCompactConfirmationDeps, assertAuthority?: BaleApiCallOptions["assertAuthority"]): Promise<void>;
export declare function handleBaleNewConfirmationCallback<TContext>(query: BaleCompactConfirmationCallbackQuery, deps: BaleNewConfirmationCallbackDeps<TContext>): Promise<boolean>;
export declare function handleBaleCompactConfirmationCallback<TContext>(query: BaleCompactConfirmationCallbackQuery, deps: BaleCompactConfirmationCallbackDeps<TContext>): Promise<boolean>;
export interface BaleNewCommandDeps extends BaleRuntimeEventRecorderPort, BaleSessionBusyPorts {
    requestNewSession?: () => void;
    sendTextReply: (text: string, options?: {
        parseMode?: "HTML";
    }) => Promise<void>;
}
export declare function handleBaleNewCommand(deps: BaleNewCommandDeps): Promise<void>;
export declare function handleBaleCompactCommand(deps: BaleCompactCommandDeps): Promise<void>;
export declare function handleBaleModelCommand<TContext>(deps: {
    ctx: TContext;
    openModelMenu: (ctx: TContext) => Promise<void>;
}): Promise<void>;
export declare function executeBaleCommandAction<TMessage, TContext>(action: BaleCommandAction, message: TMessage, ctx: TContext, deps: BaleCommandActionDeps<TMessage, TContext>, commandArgs?: string): Promise<boolean>;
export interface BaleCommandHandlerTargetRuntimeDeps<TMessage extends BaleCommandRuntimeMessage, TContext> extends Omit<BaleCommandRuntimeDeps<TMessage, TContext>, "enqueueControlItem" | "showStatus" | "openModelMenu" | "openSettingsMenu" | "sendTextReply" | "registerBotCommands">, Omit<BaleCommandTargetQueueRuntimeDeps<TContext>, "createControlItem">, BaleBotCommandRegistrationDeps {
    allocateItemOrder: () => number;
    allocateControlOrder: () => number;
}
export declare function createBaleCommandHandlerTargetRuntime<TMessage extends BaleCommandRuntimeMessage, TContext>(deps: BaleCommandHandlerTargetRuntimeDeps<TMessage, TContext>): ReturnType<typeof createBaleCommandHandler<TMessage, TContext>>;
/** Released exact-source admission for one selected command: source/recipient lifetimes and one completion report. */
export interface BaleSelectedCommandAdmission {
    assertSourceCurrent(): void;
    /** Independent exact recipient/target lifetime, including inside captured menu transport adapters. */
    assertRecipientCurrent(): void;
    reportCompleted(): boolean;
    /** Optional recipient release barrier after acceptance; rejection suppresses effects without replay. */
    beforeEffects?(): Promise<void>;
}
export declare function createBaleCommandHandler<TMessage extends BaleCommandRuntimeMessage, TContext>(deps: BaleCommandRuntimeDeps<TMessage, TContext>): ((commandName: string | undefined, message: TMessage, ctx: TContext, commandArgs?: string) => Promise<boolean>) & {
    /** Command-only producer execution; Routing must supply the captured plan and released exact-source authority. */
    prepareSelectedExtensionCommand(prepared: NonNullable<Awaited<ReturnType<typeof prepareBaleSelectedExtensionCommand>>>, messages: readonly TMessage[], ctx: TContext, admission: BaleSelectedCommandAdmission): (() => Promise<void>) | undefined;
    /** Selected help/start require the existing authenticated owner; cold pairing remains ordinary first contact. */
    prepareSelectedStartCommand: (command: ParsedBaleCommand, messages: readonly TMessage[], ctx: TContext, admission: BaleSelectedCommandAdmission) => (() => Promise<boolean>) | undefined;
    prepareSelectedHelpCommand: (command: ParsedBaleCommand, messages: readonly TMessage[], ctx: TContext, admission: BaleSelectedCommandAdmission) => (() => Promise<boolean>) | undefined;
    /** Selected new handles only confirmation; the later authenticated callback owns replacement admission. */
    prepareSelectedNewCommand: (command: ParsedBaleCommand, messages: readonly TMessage[], ctx: TContext, admission: BaleSelectedCommandAdmission) => (() => Promise<boolean>) | undefined;
    /** Selected compaction handles only confirmation; the later authenticated callback owns actual compaction. */
    prepareSelectedCompactCommand: (command: ParsedBaleCommand, messages: readonly TMessage[], ctx: TContext, admission: BaleSelectedCommandAdmission) => (() => Promise<boolean>) | undefined;
    /** Bare naming completes only after the exact dialog owner confirms current publication, not delivery alone. */
    prepareSelectedNameDialogCommand(command: ParsedBaleCommand, messages: readonly TMessage[], ctx: TContext, admission: BaleSelectedCommandAdmission): (() => Promise<boolean>) | undefined;
    /** Explicit naming retains source authority until its owner result; bare dialogs use their own publication leaf. */
    prepareSelectedNameCommand(command: ParsedBaleCommand, messages: readonly TMessage[], ctx: TContext, admission: BaleSelectedCommandAdmission): (() => Promise<boolean>) | undefined;
    /** Genuine leader originals capture their warm queue owner before release; no hold copy or semantic-completion report. */
    prepareSelectedQueueCommand(command: ParsedBaleCommand, messages: readonly TMessage[], ctx: TContext, admission: BaleHeldCommandAdmission): Omit<BalePreparedHeldCommand, "bindCarrier"> | undefined;
    /** Selected leaders reuse registry semantics; native source/recipient admission and inline transport remain role-owned. */
    prepareSelectedCommand: (command: ParsedBaleCommand, messages: readonly TMessage[], ctx: TContext, admission: BaleSelectedCommandAdmission) => (() => Promise<boolean>) | undefined;
    /** Existing native publication boundary; unrelated/legacy receipts keep their ordinary owner. */
    prepareHeldQueueReceipt: (receipt: BaleQueueAdmissionReceipt, queueOwner: import("./journal.ts").BaleUpdateJournalQueueOwner, context: TContext, isWorkerCurrent: () => boolean) => import("./updates.ts").BaleQueueSourceCompletion[] | undefined;
    /** Pure registry/effect availability; never reads a source or activates future recipient authority. */
    canPrepareHeldCommand(name: string, effects?: BaleHeldCommandEffects<TContext>): boolean;
    /** Compile one registry plan from a saved original; no admission, recipient activation or update-handler replay. */
    prepareHeldCommand(name: string, readiness: BaleLiveSourceCompletionReadiness, ctx: TContext, admission: BaleHeldCommandAdmission, effects?: BaleHeldCommandEffects<TContext>): BalePreparedHeldCommand | undefined;
    /** Warm menu-only issuance; completion reporting is not a receipt or a durable removal ACK. */
    prepareSelectedMenuCommand(command: ParsedBaleCommand, messages: readonly TMessage[], ctx: TContext, admission: BaleSelectedCommandAdmission): (() => Promise<boolean>) | undefined;
};
export declare function createBaleCommandOrPromptDispatcher<TMessage, TContext>(deps: BaleCommandOrPromptDispatcherDeps<TMessage, TContext>): (messages: TMessage[], ctx: TContext) => Promise<void>;
export declare const BALE_CONNECT_COMMAND_NAME = "bale-connect";
export declare const BALE_INTERNAL_COMMAND_FLAG = "--internal";
export declare const BALE_INTERNAL_MANUAL_USE_MESSAGE = "This internal Bale action cannot be run manually.";
export interface BaleSessionActionRuntimeDeps {
    sendUserMessage: Pi.ExtensionAPI["sendUserMessage"];
    notifyResult: (target: {
        chatId: number;
        threadId?: number;
        messageId: number;
    }, result: "success" | "cancelled" | "failure") => Promise<void>;
    prepareReplacement?: (ctx: Pi.ExtensionCommandContext, updateId: number, target: {
        chatId: number;
        threadId?: number;
        messageId: number;
    }) => Promise<void>;
    recordRuntimeEvent?: (category: string, error: unknown) => void;
}
export interface BaleSessionReplacementSettlementDeps {
    getIntent: () => Promise<BaleSessionReplacementIntent | undefined>;
    hasSuccessorContinuity: (intent: BaleSessionReplacementIntent) => boolean;
    editSuccess: (intent: BaleSessionReplacementIntent) => Promise<{
        ok: boolean;
        retryable?: boolean;
        message?: string;
    }>;
    clearIntent: (intent: BaleSessionReplacementIntent) => Promise<boolean>;
    profileName: string | undefined;
    cwd: string;
    sessionId: string;
    now?: () => number;
    sleep?: (delayMs: number) => Promise<void>;
    isCurrent?: () => boolean;
}
export declare function settleBaleSessionReplacement(deps: BaleSessionReplacementSettlementDeps): Promise<"none" | "settled" | "expired" | "failed" | "stale">;
export interface BaleSessionActionAssemblyDeps {
    sendUserMessage: Pi.ExtensionAPI["sendUserMessage"];
    store: {
        load: () => Promise<void>;
        refresh?: () => Promise<void>;
        getWorkspaceBindingByTarget: (target: {
            chatId: number;
            threadId?: number;
        }, sessionId?: string) => {
            cwd: string;
            sessionId?: string;
            slot?: string;
            threadName?: string;
            manualThreadName?: string;
            target: {
                chatId: number;
                threadId: number;
            };
        } | undefined;
        getSessionReplacementIntent: () => BaleSessionReplacementIntent | undefined;
        commitSessionReplacementIntent: (intent: BaleSessionReplacementIntent, isCurrent: () => boolean) => Promise<boolean>;
        removeSessionReplacementIntent: (intent: BaleSessionReplacementIntent, isCurrent: () => boolean) => Promise<boolean>;
    };
    getProfileName: () => string | undefined;
    ownsPersistence: () => boolean;
    /**
     * Registered-follower port. A follower cannot persist leader-owned state, so
     * its Workspace Thread intent is published and claimed by the leader over
     * authenticated generation-fenced bus RPC.
     */
    follower?: {
        instanceId: string;
        isRegisteredFor: (target: {
            chatId: number;
            threadId?: number;
        }) => boolean;
        requestSessionReplacement: (operation: "publish" | "settle", intent: BaleSessionReplacementIntent) => Promise<boolean>;
    };
    sendResult: (target: {
        chatId: number;
        threadId?: number;
    }, html: string) => Promise<{
        ok: boolean;
        retryable?: boolean;
    }>;
    handoffTtlMs: number;
    now?: () => number;
    recordRuntimeEvent?: (category: string, error: unknown) => void;
}
export declare function createBaleSessionActionAssembly(deps: BaleSessionActionAssemblyDeps): {
    action: BaleSessionActionRuntime;
    settlement: {
        onSessionStart: (ctx: Pi.ExtensionContext) => void;
    };
};
export interface BaleSessionActionRuntime {
    handleInternalAction: (args: string, ctx: Pi.ExtensionCommandContext) => Promise<void>;
    scheduleAfterUpdate: (updateId: number, target: {
        chatId: number;
        threadId?: number;
        messageId: number;
    }) => boolean;
    onUpdateCompleted: (updateId: number) => void;
    hasPending: () => boolean;
}
export declare function createBaleSessionActionRuntime(deps: BaleSessionActionRuntimeDeps): BaleSessionActionRuntime;
export {};

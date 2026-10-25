/**
 * Bale bus-aware API runtime
 * Zones: multi-instance bus, bale api transport, live instance routing
 * Wraps the direct Bale Bot API runtime so follower instances can route outbound calls through the bus leader
 */

import {
  markBaleBusCrossTargetDelivery,
  parseBaleBusSelectedMenuTextEffect,
  stripBaleBusApiMetadata,
  type BaleBusSelectedMenuDeliveryObservation,
  type BaleBusSelectedMenuTextEffect,
} from "./bus.ts";
import type { BaleAttachmentSource } from "./media.ts";
import type {
  BaleAnswerGuestQueryOptions,
  BaleApiCallOptions,
  BaleBridgeApiRuntime,
  BaleEditGuestInlineMessageContent,
  BaleEditMessageTextBody,
  BaleSendMessageBody,
  BaleSendMessageDraftBody,
  BaleSendRichMessageBody,
  BaleSendRichMessageDraftBody,
  BaleSentMessage,
  BaleTypingActionOptions,
  BaleUpdate,
} from "./bale-api.ts";
import {
  buildBaleAnswerGuestQueryBody,
  assertBaleApiCallAuthority,
  isBaleApiCommitUnknownError,
  isBaleMessageNotModifiedError,
  BaleApiAuthorityError,
  BaleApiCommitUnknownError,
} from "./bale-api.ts";

export type BaleBusApiCall = (
  method: string,
  args: unknown[],
  localOptions?: Pick<BaleApiCallOptions, "assertAuthority">,
) => Promise<unknown>;

export interface BaleBusAwareApiRuntimeDeps {
  directRuntime: BaleBridgeApiRuntime;
  ownsDirect: () => boolean;
  callFollowerApi: BaleBusApiCall;
  getDefaultTarget?: () => { chatId: number; threadId?: number } | undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asBoolean(value: unknown): boolean {
  return Boolean(value);
}

function asSentMessage(value: unknown): BaleSentMessage {
  return asRecord(value) as unknown as BaleSentMessage;
}

function withDefaultThreadTarget(
  body: Record<string, unknown>,
  target: { chatId: number; threadId?: number } | undefined,
): Record<string, unknown> {
  if (target?.threadId === undefined) return body;
  if (body.message_thread_id !== undefined) return body;
  return body.chat_id === target.chatId
    ? { ...body, message_thread_id: target.threadId }
    : body;
}

function markFollowerCrossTargetDelivery<T extends Record<string, unknown>>(
  body: T,
  defaultTarget: { chatId: number; threadId?: number } | undefined,
): T {
  if (!defaultTarget || body.chat_id !== defaultTarget.chatId) return body;
  const threadId = body.message_thread_id;
  const isDifferentTarget =
    threadId === undefined
      ? defaultTarget.threadId !== undefined
      : threadId !== defaultTarget.threadId;
  return isDifferentTarget ? markBaleBusCrossTargetDelivery(body) : body;
}

function rejectBaleDirectOwnership(method: string): Promise<never> {
  return Promise.reject(
    new Error(`Bale ${method} requires direct transport ownership.`),
  );
}

/** Bound selected-menu projection only; no ordinary/raw API fallback and no activation during preparation. */
export function createBaleSelectedMenuTextApi(deps: {
  operationId: string;
  registrationGeneration: string;
  target: { chatId: number; threadId: number };
  assertAuthority: () => void;
  deliver(
    effect: BaleBusSelectedMenuTextEffect,
    assertAuthority: () => void,
  ): Promise<BaleBusSelectedMenuDeliveryObservation>;
}): Pick<BaleBridgeApiRuntime, "sendMessage" | "editMessageText"> {
  const { operationId, registrationGeneration, assertAuthority, deliver } =
      deps,
    target = { ...deps.target };
  if (
    typeof assertAuthority !== "function" ||
    typeof deliver !== "function" ||
    !operationId?.trim() ||
    operationId.length > 128 ||
    !registrationGeneration?.trim() ||
    registrationGeneration.length > 128 ||
    !Number.isSafeInteger(target.chatId) ||
    target.chatId <= 0 ||
    !Number.isSafeInteger(target.threadId) ||
    target.threadId <= 0
  )
    throw new BaleApiAuthorityError(false);
  const invoke = async (
    edit: boolean,
    raw: Record<string, unknown>,
    options?: Pick<BaleApiCallOptions, "assertAuthority">,
  ) => {
    let issued = false;
    const assertCurrent = () => {
      try {
        assertAuthority();
      } catch {
        throw new BaleApiAuthorityError(issued);
      }
    };
    try {
      if (
        options?.assertAuthority !== assertAuthority ||
        Reflect.ownKeys(raw).some(
          (key) =>
            typeof key !== "string" ||
            ![
              "chat_id",
              "message_thread_id",
              "text",
              "parse_mode",
              "reply_markup",
              ...(edit ? ["message_id"] : ["reply_parameters"]),
            ].includes(key),
        )
      )
        throw new BaleApiAuthorityError(false);
      const body = structuredClone(raw),
        reply = body.reply_parameters;
      if (
        body.chat_id !== target.chatId ||
        body.message_thread_id !== target.threadId ||
        (reply !== undefined &&
          (!reply ||
            typeof reply !== "object" ||
            Array.isArray(reply) ||
            Object.keys(reply).some(
              (key) =>
                !["message_id", "allow_sending_without_reply"].includes(key),
            ) ||
            (reply as Record<string, unknown>).allow_sending_without_reply !==
              true ||
            !Number.isSafeInteger(
              (reply as Record<string, unknown>).message_id,
            ) ||
            ((reply as Record<string, unknown>).message_id as number) <= 0))
      )
        throw new BaleApiAuthorityError(false);
      const effect = parseBaleBusSelectedMenuTextEffect({
        kind: edit ? "edit-text" : "send-text",
        text: body.text,
        ...(body.parse_mode !== undefined
          ? { parseMode: body.parse_mode }
          : {}),
        ...(body.reply_markup !== undefined
          ? { replyMarkup: body.reply_markup }
          : {}),
        ...(edit
          ? { messageId: body.message_id }
          : reply !== undefined
            ? {
                replyToMessageId: (reply as Record<string, unknown>).message_id,
              }
            : {}),
      });
      if (!effect) throw new BaleApiAuthorityError(false);
      assertCurrent();
      issued = true;
      const observed = await deliver.call(deps, effect, assertAuthority);
      assertCurrent();
      if (
        observed.operationId !== operationId ||
        observed.registrationGeneration !== registrationGeneration ||
        observed.effect !== effect.kind ||
        observed.recipient.target.chatId !== target.chatId ||
        observed.recipient.target.threadId !== target.threadId ||
        !Number.isSafeInteger(observed.messageId) ||
        observed.messageId <= 0 ||
        (effect.kind === "edit-text" && observed.messageId !== effect.messageId)
      )
        throw new Error("Selected-menu transport result is unconfirmed.");
      assertCurrent();
      return observed.messageId;
    } catch (error) {
      if (
        error instanceof BaleApiAuthorityError ||
        isBaleApiCommitUnknownError(error)
      )
        throw error;
      if (issued)
        throw new BaleApiCommitUnknownError(
          edit ? "editMessageText" : "sendMessage",
          error,
        );
      throw new BaleApiAuthorityError(false);
    }
  };
  return {
    sendMessage: async (body, options) => ({
      message_id: await invoke(false, body, options),
    }),
    editMessageText: async (body, options) => {
      await invoke(true, body, options);
      return "edited";
    },
  };
}

/** Followers route every chat action through the leader's generic `sendChatAction` call. */
function sendBaleFollowerChatAction(
  deps: Pick<
    BaleBusAwareApiRuntimeDeps,
    "callFollowerApi" | "getDefaultTarget"
  >,
  chatId: number,
  action: string,
  options?: BaleTypingActionOptions,
): Promise<boolean> {
  assertBaleApiCallAuthority(options?.assertAuthority, false);
  const body = withDefaultThreadTarget(
    {
      chat_id: chatId,
      action,
      ...(options?.message_thread_id !== undefined
        ? { message_thread_id: options.message_thread_id }
        : {}),
    },
    deps.getDefaultTarget?.(),
  );
  // Only plain single-attempt policy crosses IPC; the captured assertion is a local issuance fence.
  const args = ["sendChatAction", body, ...(action === "typing"
    ? [{ maxAttempts: 1, retrySafety: "non-idempotent" }] : [])];
  return deps.callFollowerApi("call", args, options?.assertAuthority
    ? { assertAuthority: options.assertAuthority } : undefined).then(asBoolean);
}

export function createBaleBusAwareApiRuntime(
  deps: BaleBusAwareApiRuntimeDeps,
): BaleBridgeApiRuntime {
  return {
    call<TResponse>(
      method: string,
      body: Record<string, unknown>,
      options?: BaleApiCallOptions,
    ): Promise<TResponse> {
      if (deps.ownsDirect())
        return deps.directRuntime.call<TResponse>(method, body, options);
      // A process-local authority callback cannot cross IPC as an enforceable grant.
      if (options?.assertAuthority)
        return Promise.reject(new BaleApiAuthorityError(false));
      return deps.callFollowerApi("call", [
        method,
        body,
        options,
      ]) as Promise<TResponse>;
    },
    callMultipart<TResponse>(
      method: string,
      fields: Record<string, string>,
      fileField: string,
      filePath: string,
      fileName: string,
      options?: BaleApiCallOptions,
    ): Promise<TResponse> {
      if (deps.ownsDirect())
        return deps.directRuntime.callMultipart<TResponse>(
          method,
          fields,
          fileField,
          filePath,
          fileName,
          options,
        );
      if (options?.assertAuthority)
        return Promise.reject(new BaleApiAuthorityError(false));
      return deps.callFollowerApi("callMultipart", [
        method,
        fields,
        fileField,
        filePath,
        fileName,
        options,
      ]) as Promise<TResponse>;
    },
    downloadFile(
      fileId: string,
      suggestedName: string,
      source?: BaleAttachmentSource,
    ): Promise<string> {
      // The source names the file (kind-scope-message); dropping it falls back to the bare generated name.
      return deps.ownsDirect()
        ? deps.directRuntime.downloadFile(fileId, suggestedName, source)
        : (deps.callFollowerApi("downloadFile", [
            fileId,
            suggestedName,
            ...(source ? [source] : []),
          ]) as Promise<string>);
    },
    deleteWebhook(signal?: AbortSignal): Promise<boolean> {
      return deps.ownsDirect()
        ? deps.directRuntime.deleteWebhook(signal)
        : rejectBaleDirectOwnership("deleteWebhook");
    },
    getUpdates(
      body: Record<string, unknown>,
      signal?: AbortSignal,
    ): Promise<BaleUpdate[]> {
      return deps.ownsDirect()
        ? deps.directRuntime.getUpdates(body, signal)
        : rejectBaleDirectOwnership("getUpdates");
    },
    setMyCommands(commands, options): Promise<boolean> {
      if (deps.ownsDirect())
        return deps.directRuntime.setMyCommands(commands, options);
      if (options?.assertAuthority)
        return Promise.reject(new BaleApiAuthorityError(false));
      return deps
        .callFollowerApi("call", ["setMyCommands", { commands }])
        .then(asBoolean);
    },
    sendChatAction(
      chatId: number,
      action: string,
      options?: { message_thread_id?: number },
    ): Promise<boolean> {
      return deps.ownsDirect()
        ? deps.directRuntime.sendChatAction(chatId, action, options)
        : sendBaleFollowerChatAction(deps, chatId, action, options);
    },
    sendTypingAction(
      chatId: number,
      options?: BaleTypingActionOptions,
    ): Promise<unknown> {
      return deps.ownsDirect()
        ? deps.directRuntime.sendTypingAction(chatId, options)
        : sendBaleFollowerChatAction(deps, chatId, "typing", options);
    },
    sendRecordVoiceAction(
      chatId: number,
      options?: { message_thread_id?: number },
    ): Promise<unknown> {
      return deps.ownsDirect()
        ? deps.directRuntime.sendRecordVoiceAction(chatId, options)
        : sendBaleFollowerChatAction(deps, chatId, "record_voice", options);
    },
    sendMessageDraft(
      chatId: number,
      draftId: number,
      text?: string,
      options?: BaleSendMessageDraftBody extends Record<string, unknown>
        ? {
            parse_mode?: string;
            entities?: unknown[];
            message_thread_id?: number;
          }
        : never,
    ): Promise<boolean> {
      const body: Record<string, unknown> = {
        chat_id: chatId,
        draft_id: draftId,
      };
      if (text !== undefined) body.text = text;
      if (options?.parse_mode !== undefined)
        body.parse_mode = options.parse_mode;
      if (options?.entities !== undefined) body.entities = options.entities;
      if (options?.message_thread_id !== undefined) {
        body.message_thread_id = options.message_thread_id;
      }
      const scopedBody = withDefaultThreadTarget(
        body,
        deps.getDefaultTarget?.(),
      );
      return deps.ownsDirect()
        ? deps.directRuntime.sendMessageDraft(chatId, draftId, text, options)
        : deps
            .callFollowerApi("call", ["sendMessageDraft", scopedBody])
            .then(asBoolean);
    },
    sendMessage(
      body: BaleSendMessageBody,
      options?: Pick<BaleApiCallOptions, "assertAuthority">,
    ): Promise<BaleSentMessage> {
      if (deps.ownsDirect())
        return deps.directRuntime.sendMessage(
          stripBaleBusApiMetadata(body),
          options,
        );
      if (options?.assertAuthority)
        return Promise.reject(new BaleApiAuthorityError(false));
      return deps
        .callFollowerApi("call", [
          "sendMessage",
          markFollowerCrossTargetDelivery(body, deps.getDefaultTarget?.()),
        ])
        .then(asSentMessage);
    },
    sendRichMessage(
      body: BaleSendRichMessageBody,
      options?: Pick<BaleApiCallOptions, "assertAuthority">,
    ): Promise<BaleSentMessage> {
      if (deps.ownsDirect())
        return deps.directRuntime.sendRichMessage(
          stripBaleBusApiMetadata(body),
          options,
        );
      if (options?.assertAuthority)
        return Promise.reject(new BaleApiAuthorityError(false));
      return deps
        .callFollowerApi("call", [
          "sendRichMessage",
          markFollowerCrossTargetDelivery(body, deps.getDefaultTarget?.()),
        ])
        .then(asSentMessage);
    },
    sendRichMessageDraft(
      body: BaleSendRichMessageDraftBody,
    ): Promise<boolean> {
      return deps.ownsDirect()
        ? deps.directRuntime.sendRichMessageDraft(body)
        : deps
            .callFollowerApi("call", ["sendRichMessageDraft", body])
            .then(asBoolean);
    },
    async editMessageText(
      body: BaleEditMessageTextBody,
      options?: Pick<BaleApiCallOptions, "assertAuthority">,
    ): Promise<"edited" | "unchanged"> {
      if (deps.ownsDirect())
        return deps.directRuntime.editMessageText(body, options);
      if (options?.assertAuthority) throw new BaleApiAuthorityError(false);
      try {
        await deps.callFollowerApi("call", ["editMessageText", body]);
        return "edited";
      } catch (error) {
        if (isBaleMessageNotModifiedError(error)) return "unchanged";
        throw error;
      }
    },
    async editMessageReplyMarkup(
      chatId: number,
      messageId: number,
      replyMarkup: unknown,
    ): Promise<void> {
      if (deps.ownsDirect()) {
        await deps.directRuntime.editMessageReplyMarkup(
          chatId,
          messageId,
          replyMarkup,
        );
        return;
      }
      await deps.callFollowerApi("call", [
        "editMessageReplyMarkup",
        { chat_id: chatId, message_id: messageId, reply_markup: replyMarkup },
      ]);
    },
    async answerCallbackQuery(
      callbackQueryId: string,
      text?: string,
      options?: Pick<BaleApiCallOptions, "assertAuthority">,
    ): Promise<void> {
      const assertAuthority = options?.assertAuthority;
      if (deps.ownsDirect()) {
        const authorityOptions:
          [] | [Pick<BaleApiCallOptions, "assertAuthority">] =
          assertAuthority ? [{ assertAuthority }] : [];
        await deps.directRuntime.answerCallbackQuery(
          callbackQueryId,
          text,
          ...authorityOptions,
        );
        return;
      }
      if (assertAuthority) throw new BaleApiAuthorityError(false);
      await deps.callFollowerApi("call", [
        "answerCallbackQuery",
        {
          callback_query_id: callbackQueryId,
          ...(text !== undefined ? { text } : {}),
        },
      ]);
    },
    async answerGuestQuery(
      guestQueryId: string,
      text?: string,
      options?: BaleAnswerGuestQueryOptions,
    ): Promise<void> {
      if (deps.ownsDirect()) {
        await deps.directRuntime.answerGuestQuery(guestQueryId, text, options);
        return;
      }
      await deps.callFollowerApi("call", [
        "answerGuestQuery",
        buildBaleAnswerGuestQueryBody(guestQueryId, text, options),
      ]);
    },
    answerGuestQueryForInlineMessage(
      guestQueryId: string,
      text?: string,
      options?: BaleAnswerGuestQueryOptions,
    ): Promise<string | undefined> {
      // Guest answers can only be edited while this instance owns direct
      // transport; follower forwarding cannot preserve the inline message id.
      return deps.ownsDirect()
        ? deps.directRuntime.answerGuestQueryForInlineMessage(
            guestQueryId,
            text,
            options,
          )
        : rejectBaleDirectOwnership("answerGuestQueryForInlineMessage");
    },
    editGuestInlineMessage(
      inlineMessageId: string,
      content: BaleEditGuestInlineMessageContent,
      options?: Pick<BaleApiCallOptions, "assertAuthority">,
    ): Promise<void> {
      return deps.ownsDirect()
        ? deps.directRuntime.editGuestInlineMessage(inlineMessageId, content, options)
        : rejectBaleDirectOwnership("editGuestInlineMessage");
    },
    async deleteMessage(chatId: number, messageId: number): Promise<void> {
      if (deps.ownsDirect())
        return deps.directRuntime.deleteMessage(chatId, messageId);
      await deps.callFollowerApi("call", [
        "deleteMessage",
        {
          chat_id: chatId,
          message_id: messageId,
        },
      ]);
    },
    prepareTempDir(): Promise<number> {
      return deps.directRuntime.prepareTempDir();
    },
  };
}

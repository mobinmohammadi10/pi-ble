/**
 * Bale settings menu UI helpers
 * Zones: bale ui, settings controls, menu composition
 * Owns hidden settings-menu rendering, settings callbacks, and persisted toggle wiring
 */

import type {
  BaleActivityVerbosity,
  BaleAssistantRenderingMode,
  BaleThreadDisplayMode,
  BaleTimeMode,
} from "./config.ts";
import type { BaleInlineKeyboardMarkup } from "./keyboard.ts";
import {
  createBaleMenuDelivery,
  type BaleMenuMessageRuntimeDeps,
  type BaleModelMenuState,
} from "./menu-model.ts";
import type { MenuModel } from "./model.ts";
import {
  getBaleExtensionSettingsRows,
  type BaleSectionRegistry,
} from "./sections.ts";
import type { BaleApiCallOptions } from "./bale-api.ts";
import type { BaleVoiceReplyMode } from "./voice.ts";

export type BaleSettingsMenuReplyMarkup = BaleInlineKeyboardMarkup;

export interface BaleSettingsStateDeps {
  getThreadDisplayMode?: () => BaleThreadDisplayMode | undefined;
  isThreadDisplayCustom?: () => boolean;
  areDraftPreviewsEnabled: () => boolean;
  getAssistantRenderingMode: () => BaleAssistantRenderingMode;
  getActivityVerbosity: () => BaleActivityVerbosity;
  getTimeInjectionMode: () => BaleTimeMode;
  getVoiceReplyMode: () => BaleVoiceReplyMode;
  isVoiceReplyModeConfigured: () => boolean;
  isAutomaticThreadCleanupEnabled: () => boolean;
}

export interface BaleSettingsMutationDeps extends BaleSettingsStateDeps {
  setThreadDisplayMode?: (mode: BaleThreadDisplayMode) => Promise<void>;
  setDraftPreviewsEnabled: (enabled: boolean) => Promise<void>;
  setAssistantRenderingMode: (
    mode: BaleAssistantRenderingMode,
  ) => Promise<void>;
  setActivityVerbosity: (verbosity: BaleActivityVerbosity) => Promise<void>;
  setVoiceReplyMode: (
    mode: BaleVoiceReplyMode | undefined,
  ) => Promise<void>;
  setTimeInjectionMode: (mode: BaleTimeMode) => Promise<void>;
  setAutomaticThreadCleanupEnabled: (enabled: boolean) => Promise<void>;
  reviewInactiveThreads?: () => Promise<{
    count: number;
    operationId?: string;
  }>;
  cleanInactiveThreads?: (operationId: string) => Promise<{
    deleted: number;
    outcomeUnknown: number;
    blocked?: number;
    recovery?:
      "commit-ready" | "deletion-outcome-unknown" | "authority-blocked";
  }>;
}

export interface BaleSettingsMenuOpenDeps<
  TModel extends MenuModel = MenuModel,
> extends BaleSettingsStateDeps {
  getModelMenuState: () => Promise<BaleModelMenuState<TModel>>;
  sendSettingsMenu: (
    state: BaleModelMenuState<TModel>,
    text: string,
    replyMarkup: BaleSettingsMenuReplyMarkup,
  ) => Promise<number | undefined>;
  storeModelMenuState: (state: BaleModelMenuState<TModel>) => void;
}

export interface BaleSettingsMenuCallbackDeps extends BaleSettingsMutationDeps {
  updateSettingsMessage: (
    text: string,
    replyMarkup: BaleSettingsMenuReplyMarkup,
  ) => Promise<void>;
  answerCallbackQuery: (
    callbackQueryId: string,
    text?: string,
  ) => Promise<void>;
  sectionRegistry?: BaleSectionRegistry;
}

export interface BaleSettingsMenuRuntime<TContext> {
  openSettingsMenu: (
    chatId: number,
    replyToMessageId: number | undefined,
    ctx: TContext,
    threadId?: number,
    options?: Pick<BaleApiCallOptions, "assertAuthority">,
  ) => Promise<void>;
  handleCallbackQuery: (
    query: {
      id: string;
      data?: string;
      message?: {
        message_id?: number;
        message_thread_id?: number;
        chat?: { id?: number };
      };
    },
    ctx: TContext,
  ) => Promise<boolean>;
  updateSettingsMenuMessage: (
    state: BaleModelMenuState,
    ctx: TContext,
  ) => Promise<void>;
}

export interface BaleSettingsMenuMessageUpdateDeps extends BaleSettingsStateDeps {
  updateSettingsMessage: (
    text: string,
    replyMarkup: BaleSettingsMenuReplyMarkup,
  ) => Promise<void>;
}

export interface BaleSettingsMenuRuntimeDeps<
  TContext,
  TModel extends MenuModel = MenuModel,
> extends BaleSettingsMutationDeps {
  reloadConfig?: () => Promise<void>;
  getModelMenuState: (
    chatId: number,
    ctx: TContext,
    threadId?: number,
  ) => Promise<BaleModelMenuState<TModel>>;
  getStoredModelMenuState: (
    messageId: number | undefined,
    chatId?: number,
  ) => BaleModelMenuState<TModel> | undefined;
  storeModelMenuState: (state: BaleModelMenuState<TModel>) => void;
  editInteractiveMessage: (
    chatId: number,
    messageId: number,
    text: string,
    mode: "markdown" | "html" | "plain",
    replyMarkup: BaleSettingsMenuReplyMarkup,
  ) => Promise<void>;
  sendInteractiveMessage: BaleMenuMessageRuntimeDeps["sendInteractiveMessage"];
  answerCallbackQuery: (
    callbackQueryId: string,
    text?: string,
  ) => Promise<void>;
}

const SETTINGS_MENU_TITLE = "<b>⚙️ Settings:</b>";
const AUTOMATIC_THREAD_CLEANUP_SETTINGS_TITLE = "<b>🧹 Thread cleanup:</b>";
const INACTIVE_THREAD_REVIEW_TITLE = "<b>🔎 Inactive tabs review:</b>";
const DRAFT_PREVIEWS_SETTINGS_TITLE = "<b>📝 Draft previews:</b>";
const ASSISTANT_RENDERING_SETTINGS_TITLE = "<b>🧾 Assistant rendering:</b>";
const ACTIVITY_VERBOSITY_SETTINGS_TITLE = "<b>🔬 Activity:</b>";
const TIME_INJECTION_MODE_SETTINGS_TITLE = "<b>🕒 Time injection mode:</b>";
const VOICE_REPLY_MODE_SETTINGS_TITLE = "<b>👄 Voice reply mode:</b>";
const THREAD_DISPLAY_SETTINGS_TITLE = "<b>🧵 Thread display:</b>";

function getVoiceReplyModeLabel(mode: BaleVoiceReplyMode): string {
  return mode;
}

function getBaleSettingsStateValueLabel(value: string): string {
  return value.toLowerCase();
}

function getVoiceReplyModeSetting(
  mode: BaleVoiceReplyMode,
  configured: boolean,
): BaleVoiceReplyMode {
  return configured ? mode : "manual";
}

export function buildBaleSettingsMenuText(): string {
  return SETTINGS_MENU_TITLE;
}

export function buildThreadDisplaySettingsText(
  mode: BaleThreadDisplayMode,
  custom = false,
): string {
  return [
    `${THREAD_DISPLAY_SETTINGS_TITLE} <code>${custom ? "custom" : threadDisplayModeLabel(mode)}</code>`,
    "",
    "Choose how this bot profile labels Bale tabs and Pi terminal status. Each slot is unique across this bot profile.",
    "",
    "Set a manual name for the current Thread with /name <code>Name</code>.",
    "",
    "<code>-</code> <code>letters</code> (default): show the unique slot, such as <b><i>A</i></b> or <b><i>B</i></b>.",
    "<code>-</code> <code>names</code>: show the generated dictionary name for the slot, such as <b><i>Anchor</i></b> or <b><i>Briar</i></b>.",
    "<code>-</code> <code>directory-title</code>: humanize the distinguishing directory path, such as <b><i>Api Tools</i></b> or <b><i>Frontend / Extensions A</i></b>.",
    "<code>-</code> <code>directory-snake</code>: normalize the distinguishing directory path to lowercase, such as <b><i>api_tools</i></b> or <b><i>frontend_extensions_a</i></b>.",
  ].join("\n");
}

export function buildAutomaticThreadCleanupSettingsText(
  enabled: boolean,
): string {
  return [
    `${AUTOMATIC_THREAD_CLEANUP_SETTINGS_TITLE} <code>${enabled ? "on" : "off"}</code>`,
    "",
    "Delete this Pi instance's Bale tab when Pi quits normally.",
    "",
    "<code>-</code> <code>on</code> (default): delete the bound thread and release Bale authority on graceful quit.",
    "<code>-</code> <code>off</code>: preserve the tab as a restart hint; manual <code>/bale-disconnect</code> still confirms and deletes it.",
    "",
    "On the leader instance, Review inactive tabs checks current owner and work evidence, including tabs without a letter. Review never deletes tabs.",
  ].join("\n");
}

function buildInactiveThreadReviewText(count: number): string {
  return [
    INACTIVE_THREAD_REVIEW_TITLE,
    "",
    `${count} proven inactive tab${count === 1 ? "" : "s"}.`,
    "No tabs were deleted.",
    "Clean inactive tabs deletes these Bale tabs and all their messages. Pi session history and project files are not removed.",
    "Clean rechecks owner and work protection; a changed or protected tab is skipped. Choose Back to leave without deleting anything.",
  ].join("\n");
}

export function buildInactiveThreadReviewReplyMarkup(
  operationId?: string,
  canCleanInactiveThreads = false,
): BaleSettingsMenuReplyMarkup {
  const validOperationId =
    typeof operationId === "string" &&
    /^thread-cleanup:[a-f0-9]{32}$/u.test(operationId);
  return {
    inline_keyboard: [
      [
        {
          text: "⬆️ Back to Thread cleanup",
          callback_data: "settings:open:automatic-thread-cleanup",
        },
      ],
      ...(canCleanInactiveThreads && validOperationId
        ? [
            [
              {
                text: "🧹 Clean inactive tabs",
                callback_data: `settings:clean:${operationId}`,
              },
            ],
          ]
        : []),
    ],
  };
}

export function buildDraftPreviewsSettingsText(enabled: boolean): string {
  return [
    `${DRAFT_PREVIEWS_SETTINGS_TITLE} <code>${enabled ? "on" : "off"}</code>`,
    "",
    "Show live answer drafts while the model is answering.",
    "",
    "<code>-</code> <code>on</code> (default): stream safe Bale Rich Draft frames before the final answer.",
    "<code>-</code> <code>off</code>: show native active status, then send one final answer.",
  ].join("\n");
}

export function buildAssistantRenderingSettingsText(
  mode: BaleAssistantRenderingMode,
): string {
  return [
    `${ASSISTANT_RENDERING_SETTINGS_TITLE} <code>${mode}</code>`,
    "",
    "Choose how final assistant Markdown answers are delivered.",
    "",
    "<code>-</code> <code>rich</code> (default): use Bale Native Rich Markdown.",
    "<code>-</code> <code>html</code>: use the legacy Markdown-to-HTML renderer.",
  ].join("\n");
}

export function buildActivityVerbositySettingsText(
  verbosity: BaleActivityVerbosity,
): string {
  return [
    `${ACTIVITY_VERBOSITY_SETTINGS_TITLE} <code>${verbosity}</code>`,
    "",
    "Choose how much technical model activity Bale shows.",
    "",
    "<code>-</code> <code>quiet</code>: show no thinking or tool traffic.",
    "<code>-</code> <code>thinking</code>: show persistent collapsed thinking.",
    "<code>-</code> <code>tools</code>: show persistent Rich tool details.",
    "<code>-</code> <code>verbose</code> (default): show both thinking and tools.",
  ].join("\n");
}

export function buildVoiceReplyModeSettingsText(
  mode: BaleVoiceReplyMode,
  configured = true,
): string {
  return [
    `${VOICE_REPLY_MODE_SETTINGS_TITLE} <code>${getVoiceReplyModeLabel(
      getVoiceReplyModeSetting(mode, configured),
    )}</code>`,
    "",
    "Controls when pi-bale converts assistant text replies into Bale voice messages.",
    "",
    "<code>-</code> <code>manual</code> (default): add no automatic voice context; explicit 'bale_voice' actions still work.",
    "<code>-</code> <code>mirror</code>: voice input activates automatic voice delivery; text input follows 'manual' behavior.",
    "<code>-</code> <code>always</code>: activate automatic voice delivery for every reply.",
  ].join("\n");
}

export function buildTimeInjectionModeSettingsText(
  mode: BaleTimeMode,
): string {
  return [
    `${TIME_INJECTION_MODE_SETTINGS_TITLE} <code>${mode}</code>`,
    "",
    "Controls whether Bale-originated prompts include a compact wall-clock [time] line.",
    "",
    "<code>-</code> <code>hidden</code>: no time line is added to prompt context.",
    "<code>-</code> <code>always</code>: add time to every Bale turn.",
    "<code>-</code> <code>interval</code> (default): add time at most once per chat interval (1 hour unless configured).",
  ].join("\n");
}

export function buildBaleSettingsMenuReplyMarkup(
  draftPreviewsEnabled: boolean,
  assistantRenderingModeOrVoiceReplyMode:
    BaleAssistantRenderingMode | BaleVoiceReplyMode,
  voiceReplyModeOrTimeInjectionMode: BaleVoiceReplyMode | BaleTimeMode,
  timeInjectionModeOrSectionRegistry?:
    BaleTimeMode | BaleSectionRegistry,
  sectionRegistryOrVoiceReplyModeConfigured?: BaleSectionRegistry | boolean,
  voiceReplyModeConfigured = true,
  automaticThreadCleanupEnabled = true,
  activityVerbosity: BaleActivityVerbosity = "quiet",
  threadDisplayMode?: BaleThreadDisplayMode,
  threadDisplayCustom = false,
): BaleSettingsMenuReplyMarkup {
  const hasRenderingMode =
    assistantRenderingModeOrVoiceReplyMode === "rich" ||
    assistantRenderingModeOrVoiceReplyMode === "html";
  const assistantRenderingMode: BaleAssistantRenderingMode =
    hasRenderingMode ? assistantRenderingModeOrVoiceReplyMode : "rich";
  const voiceReplyMode = hasRenderingMode
    ? (voiceReplyModeOrTimeInjectionMode as BaleVoiceReplyMode)
    : (assistantRenderingModeOrVoiceReplyMode as BaleVoiceReplyMode);
  const timeInjectionMode = hasRenderingMode
    ? (timeInjectionModeOrSectionRegistry as BaleTimeMode)
    : (voiceReplyModeOrTimeInjectionMode as BaleTimeMode);
  const sectionRegistry = hasRenderingMode
    ? (sectionRegistryOrVoiceReplyModeConfigured as
        BaleSectionRegistry | undefined)
    : (timeInjectionModeOrSectionRegistry as
        BaleSectionRegistry | undefined);
  const effectiveVoiceReplyModeConfigured = hasRenderingMode
    ? voiceReplyModeConfigured
    : typeof sectionRegistryOrVoiceReplyModeConfigured === "boolean"
      ? sectionRegistryOrVoiceReplyModeConfigured
      : true;
  const rows: Array<Array<{ text: string; callback_data: string }>> = [
    [{ text: "⬆️ Main menu", callback_data: "menu:back" }],
  ];
  const settingsButtons: Array<{ text: string; callback_data: string }> = [
    {
      text: `📝 Draft previews: ${draftPreviewsEnabled ? "on" : "off"}`,
      callback_data: "settings:open:draft-previews",
    },
    {
      text: `🧾 Rendering: ${assistantRenderingMode}`,
      callback_data: "settings:open:assistant-rendering",
    },
    {
      text: `👄 Voice reply: ${getBaleSettingsStateValueLabel(
        getVoiceReplyModeLabel(
          getVoiceReplyModeSetting(
            voiceReplyMode,
            effectiveVoiceReplyModeConfigured,
          ),
        ),
      )}`,
      callback_data: "settings:open:voice-reply",
    },
    {
      text: `🔬 Activity: ${activityVerbosity}`,
      callback_data: "settings:open:activity-verbosity",
    },
    {
      text: `🕒 Time injection: ${getBaleSettingsStateValueLabel(timeInjectionMode)}`,
      callback_data: "settings:open:time-injection",
    },
  ];
  if (threadDisplayMode)
    settingsButtons.push(
      {
        text: `🧹 Thread cleanup: ${automaticThreadCleanupEnabled ? "on" : "off"}`,
        callback_data: "settings:open:automatic-thread-cleanup",
      },
      {
        text: `🧵 Thread display: ${threadDisplayCustom ? "custom" : threadDisplayMode}`,
        callback_data: "settings:open:thread-display",
      },
    );
  if (sectionRegistry) {
    const extensionRows = getBaleExtensionSettingsRows(sectionRegistry);
    settingsButtons.push(
      ...extensionRows.map((row) => ({
        text: row.label,
        callback_data: row.callback_data,
      })),
    );
  }
  rows.push(...settingsButtons.map((button) => [button]));
  return { inline_keyboard: rows };
}

async function openBaleSettingsMenu<TModel extends MenuModel = MenuModel>(
  deps: BaleSettingsMenuOpenDeps<TModel>,
  sectionRegistry?: BaleSectionRegistry,
): Promise<void> {
  const state = await deps.getModelMenuState();
  const messageId = await deps.sendSettingsMenu(
    state,
    buildBaleSettingsMenuText(),
    buildCurrentBaleSettingsMenuReplyMarkup(deps, sectionRegistry),
  );
  if (messageId === undefined) return;
  state.messageId = messageId;
  state.mode = "settings";
  deps.storeModelMenuState(state);
}

function threadDisplayModeLabel(mode: BaleThreadDisplayMode): string {
  switch (mode) {
    case "letters":
      return "letters";
    case "names":
      return "names";
    case "directory-title":
      return "directory-title";
    case "directory-snake":
      return "directory-snake";
    default:
      return "letters";
  }
}

export function buildThreadDisplaySettingsReplyMarkup(
  mode: BaleThreadDisplayMode,
  custom = false,
): BaleSettingsMenuReplyMarkup {
  return {
    inline_keyboard: [
      [{ text: "⬆️ Back", callback_data: "settings:list" }],
      ...(
        ["letters", "names", "directory-title", "directory-snake"] as const
      ).map((value) => [
        {
          text: `${!custom && mode === value ? "🟢 " : ""}${threadDisplayModeLabel(value)}`,
          callback_data: `settings:set:thread-display:${value}`,
        },
      ]),
    ],
  };
}

export function buildAutomaticThreadCleanupSettingsReplyMarkup(
  enabled: boolean,
  canReviewInactiveThreads = false,
): BaleSettingsMenuReplyMarkup {
  return {
    inline_keyboard: [
      [{ text: "⬆️ Back", callback_data: "settings:list" }],
      [
        {
          text: enabled ? "🟢 On" : "⚫️ On",
          callback_data: "settings:set:automatic-thread-cleanup:on",
        },
        {
          text: enabled ? "⚫️ Off" : "🟡 Off",
          callback_data: "settings:set:automatic-thread-cleanup:off",
        },
      ],
      ...(canReviewInactiveThreads
        ? [
            [
              {
                text: "🔎 Review inactive tabs",
                callback_data: "settings:review:inactive-threads",
              },
            ],
          ]
        : []),
    ],
  };
}

export function buildDraftPreviewsSettingsReplyMarkup(
  enabled: boolean,
): BaleSettingsMenuReplyMarkup {
  return {
    inline_keyboard: [
      [{ text: "⬆️ Back", callback_data: "settings:list" }],
      [
        {
          text: enabled ? "🟢 On" : "⚫️ On",
          callback_data: "settings:set:draft-previews:on",
        },
        {
          text: enabled ? "⚫️ Off" : "🟡 Off",
          callback_data: "settings:set:draft-previews:off",
        },
      ],
    ],
  };
}

export function buildAssistantRenderingSettingsReplyMarkup(
  mode: BaleAssistantRenderingMode,
): BaleSettingsMenuReplyMarkup {
  const modes: BaleAssistantRenderingMode[] = ["rich", "html"];
  return {
    inline_keyboard: [
      [{ text: "⬆️ Back", callback_data: "settings:list" }],
      ...modes.map((value) => [
        {
          text: `${value === mode ? "🟢 " : ""}${value}`,
          callback_data: `settings:set:assistant-rendering:${value}`,
        },
      ]),
    ],
  };
}

export function buildActivityVerbositySettingsReplyMarkup(
  verbosity: BaleActivityVerbosity,
): BaleSettingsMenuReplyMarkup {
  const button = (value: BaleActivityVerbosity) => ({
    text: `${value === verbosity ? "🟢 " : ""}${value}`,
    callback_data: `settings:set:activity-verbosity:${value}`,
  });
  return {
    inline_keyboard: [
      [{ text: "⬆️ Back", callback_data: "settings:list" }],
      [button("quiet")],
      [button("thinking"), button("tools")],
      [button("verbose")],
    ],
  };
}

export function buildTimeInjectionModeSettingsReplyMarkup(
  mode: BaleTimeMode,
): BaleSettingsMenuReplyMarkup {
  const modes: BaleTimeMode[] = ["hidden", "always", "interval"];
  return {
    inline_keyboard: [
      [{ text: "⬆️ Back", callback_data: "settings:list" }],
      ...modes.map((value) => [
        {
          text: `${value === mode ? "🟢 " : ""}${value}`,
          callback_data: `settings:set:time-injection:${value}`,
        },
      ]),
    ],
  };
}

export function buildVoiceReplyModeSettingsReplyMarkup(
  mode: BaleVoiceReplyMode,
  configured = true,
): BaleSettingsMenuReplyMarkup {
  const activeMode = getVoiceReplyModeSetting(mode, configured);
  const modes: BaleVoiceReplyMode[] = ["manual", "mirror", "always"];
  return {
    inline_keyboard: [
      [{ text: "⬆️ Back", callback_data: "settings:list" }],
      ...modes.map((value) => [
        {
          text: `${value === activeMode ? "🟢 " : ""}${getVoiceReplyModeLabel(value)}`,
          callback_data: `settings:set:voice-reply:${value}`,
        },
      ]),
    ],
  };
}

type BaleSettingsMenuValuePorts = Pick<
  BaleSettingsMenuMessageUpdateDeps,
  | "areDraftPreviewsEnabled"
  | "getAssistantRenderingMode"
  | "getVoiceReplyMode"
  | "getTimeInjectionMode"
  | "isVoiceReplyModeConfigured"
  | "isAutomaticThreadCleanupEnabled"
  | "getActivityVerbosity"
  | "getThreadDisplayMode"
  | "isThreadDisplayCustom"
>;

/** Settings markup from the current setting values; rendering only, no state mutation. */
function buildCurrentBaleSettingsMenuReplyMarkup(
  deps: BaleSettingsMenuValuePorts,
  sectionRegistry?: BaleSectionRegistry,
) {
  return buildBaleSettingsMenuReplyMarkup(
    deps.areDraftPreviewsEnabled(),
    deps.getAssistantRenderingMode(),
    deps.getVoiceReplyMode(),
    deps.getTimeInjectionMode(),
    sectionRegistry,
    deps.isVoiceReplyModeConfigured(),
    deps.isAutomaticThreadCleanupEnabled(),
    deps.getActivityVerbosity(),
    deps.getThreadDisplayMode?.(),
    deps.isThreadDisplayCustom?.() ?? false,
  );
}

async function updateBaleSettingsMenuMessage(
  deps: BaleSettingsMenuMessageUpdateDeps,
  sectionRegistry?: BaleSectionRegistry,
): Promise<void> {
  await deps.updateSettingsMessage(
    buildBaleSettingsMenuText(),
    buildCurrentBaleSettingsMenuReplyMarkup(deps, sectionRegistry),
  );
}

async function updateAutomaticThreadCleanupSettingsMessage(
  deps: BaleSettingsMenuCallbackDeps,
): Promise<void> {
  const enabled = deps.isAutomaticThreadCleanupEnabled();
  await deps.updateSettingsMessage(
    buildAutomaticThreadCleanupSettingsText(enabled),
    buildAutomaticThreadCleanupSettingsReplyMarkup(
      enabled,
      !!deps.reviewInactiveThreads,
    ),
  );
}

async function updateDraftPreviewsSettingsMessage(
  deps: BaleSettingsMenuCallbackDeps,
): Promise<void> {
  const enabled = deps.areDraftPreviewsEnabled();
  await deps.updateSettingsMessage(
    buildDraftPreviewsSettingsText(enabled),
    buildDraftPreviewsSettingsReplyMarkup(enabled),
  );
}

async function updateAssistantRenderingSettingsMessage(
  deps: BaleSettingsMenuCallbackDeps,
): Promise<void> {
  const mode = deps.getAssistantRenderingMode();
  await deps.updateSettingsMessage(
    buildAssistantRenderingSettingsText(mode),
    buildAssistantRenderingSettingsReplyMarkup(mode),
  );
}

async function updateActivityVerbositySettingsMessage(
  deps: BaleSettingsMenuCallbackDeps,
): Promise<void> {
  const verbosity = deps.getActivityVerbosity();
  await deps.updateSettingsMessage(
    buildActivityVerbositySettingsText(verbosity),
    buildActivityVerbositySettingsReplyMarkup(verbosity),
  );
}

async function updateTimeInjectionModeSettingsMessage(
  deps: BaleSettingsMenuCallbackDeps,
): Promise<void> {
  const mode = deps.getTimeInjectionMode();
  await deps.updateSettingsMessage(
    buildTimeInjectionModeSettingsText(mode),
    buildTimeInjectionModeSettingsReplyMarkup(mode),
  );
}

async function updateVoiceReplyModeSettingsMessage(
  deps: BaleSettingsMenuCallbackDeps,
): Promise<void> {
  const mode = deps.getVoiceReplyMode();
  const configured = deps.isVoiceReplyModeConfigured();
  await deps.updateSettingsMessage(
    buildVoiceReplyModeSettingsText(mode, configured),
    buildVoiceReplyModeSettingsReplyMarkup(mode, configured),
  );
}

export async function handleBaleSettingsMenuCallbackAction(
  callbackQueryId: string,
  data: string | undefined,
  deps: BaleSettingsMenuCallbackDeps,
): Promise<boolean> {
  if (!data?.startsWith("settings:")) return false;
  if (
    data === "settings:open:thread-display" ||
    data.startsWith("settings:set:thread-display:")
  ) {
    if (!deps.getThreadDisplayMode?.() || !deps.setThreadDisplayMode) {
      await deps.answerCallbackQuery(
        callbackQueryId,
        "Thread display requires Threaded Mode and a connected instance",
      );
      return true;
    }
    if (data.startsWith("settings:set:thread-display:")) {
      const mode = data.slice("settings:set:thread-display:".length);
      if (
        mode !== "letters" &&
        mode !== "names" &&
        mode !== "directory-snake" &&
        mode !== "directory-title"
      ) {
        await deps.answerCallbackQuery(
          callbackQueryId,
          "Unknown Thread display mode",
        );
        return true;
      }
      try {
        await deps.setThreadDisplayMode(mode);
      } catch {
        await deps.answerCallbackQuery(
          callbackQueryId,
          "Thread display was not fully applied. The preference may be saved; retry after checking the leader",
        );
        return true;
      }
    }
    const mode = deps.getThreadDisplayMode();
    if (!mode) {
      await deps.answerCallbackQuery(
        callbackQueryId,
        "Threaded Mode is no longer available",
      );
      return true;
    }
    await deps.updateSettingsMessage(
      buildThreadDisplaySettingsText(
        mode,
        deps.isThreadDisplayCustom?.() ?? false,
      ),
      buildThreadDisplaySettingsReplyMarkup(
        mode,
        deps.isThreadDisplayCustom?.() ?? false,
      ),
    );
    await deps.answerCallbackQuery(callbackQueryId);
    return true;
  }
  if (data === "settings:list") {
    await updateBaleSettingsMenuMessage(deps, deps.sectionRegistry);
    await deps.answerCallbackQuery(callbackQueryId);
    return true;
  }
  if (data === "settings:open:automatic-thread-cleanup") {
    await updateAutomaticThreadCleanupSettingsMessage(deps);
    await deps.answerCallbackQuery(callbackQueryId);
    return true;
  }
  if (
    data === "settings:open:proactive" ||
    data === "settings:set:proactive:on" ||
    data === "settings:set:proactive:off"
  ) {
    await updateBaleSettingsMenuMessage(deps, deps.sectionRegistry);
    await deps.answerCallbackQuery(
      callbackQueryId,
      "Public assistant output is always delivered while Bale is connected",
    );
    return true;
  }
  if (
    data === "settings:open:draft-previews" ||
    data === "settings:open:rich-drafts"
  ) {
    await updateDraftPreviewsSettingsMessage(deps);
    await deps.answerCallbackQuery(callbackQueryId);
    return true;
  }
  if (data === "settings:open:assistant-rendering") {
    await updateAssistantRenderingSettingsMessage(deps);
    await deps.answerCallbackQuery(callbackQueryId);
    return true;
  }
  if (data === "settings:open:activity-verbosity") {
    await updateActivityVerbositySettingsMessage(deps);
    await deps.answerCallbackQuery(callbackQueryId);
    return true;
  }
  if (data === "settings:open:voice-reply") {
    await updateVoiceReplyModeSettingsMessage(deps);
    await deps.answerCallbackQuery(callbackQueryId);
    return true;
  }
  if (
    data === "settings:open:time-injection" ||
    data === "settings:open:time"
  ) {
    await updateTimeInjectionModeSettingsMessage(deps);
    await deps.answerCallbackQuery(callbackQueryId);
    return true;
  }
  if (data.startsWith("settings:set:voice-reply:")) {
    const mode = data.slice("settings:set:voice-reply:".length);
    if (
      mode === "manual" ||
      mode === "hidden" ||
      mode === "mirror" ||
      mode === "always"
    ) {
      const normalizedMode = mode === "hidden" ? "manual" : mode;
      await deps.setVoiceReplyMode(normalizedMode);
      await updateVoiceReplyModeSettingsMessage(deps);
      await deps.answerCallbackQuery(
        callbackQueryId,
        `Voice reply mode: ${normalizedMode}`,
      );
      return true;
    }
  }
  if (
    data.startsWith("settings:set:time-injection:") ||
    data.startsWith("settings:set:time:")
  ) {
    const mode = data.startsWith("settings:set:time-injection:")
      ? data.slice("settings:set:time-injection:".length)
      : data.slice("settings:set:time:".length);
    const normalizedMode = mode === "off" ? "hidden" : mode;
    if (
      normalizedMode === "hidden" ||
      normalizedMode === "always" ||
      normalizedMode === "interval"
    ) {
      await deps.setTimeInjectionMode(normalizedMode);
      await updateTimeInjectionModeSettingsMessage(deps);
      await deps.answerCallbackQuery(
        callbackQueryId,
        `Time injection: ${normalizedMode}`,
      );
      return true;
    }
  }
  if (
    data === "settings:set:draft-previews:on" ||
    data === "settings:set:draft-previews:off" ||
    data === "settings:set:rich-drafts:on" ||
    data === "settings:set:rich-drafts:off"
  ) {
    const enabled = data.endsWith(":on");
    await deps.setDraftPreviewsEnabled(enabled);
    await updateDraftPreviewsSettingsMessage(deps);
    await deps.answerCallbackQuery(
      callbackQueryId,
      `Draft previews ${enabled ? "enabled" : "disabled"}`,
    );
    return true;
  }
  if (data.startsWith("settings:set:assistant-rendering:")) {
    const mode = data.slice("settings:set:assistant-rendering:".length);
    if (mode === "rich" || mode === "html") {
      await deps.setAssistantRenderingMode(mode);
      await updateAssistantRenderingSettingsMessage(deps);
      await deps.answerCallbackQuery(callbackQueryId, `Rendering: ${mode}`);
      return true;
    }
  }
  if (data.startsWith("settings:set:activity-verbosity:")) {
    const verbosity = data.slice("settings:set:activity-verbosity:".length);
    if (
      verbosity === "quiet" ||
      verbosity === "thinking" ||
      verbosity === "tools" ||
      verbosity === "verbose"
    ) {
      await deps.setActivityVerbosity(verbosity);
      await updateActivityVerbositySettingsMessage(deps);
      await deps.answerCallbackQuery(callbackQueryId, `Activity: ${verbosity}`);
      return true;
    }
  }
  if (data === "settings:review:inactive-threads") {
    if (!deps.reviewInactiveThreads) {
      await deps.answerCallbackQuery(
        callbackQueryId,
        "Inactive tab review is unavailable",
      );
      return true;
    }
    try {
      const review = await deps.reviewInactiveThreads();
      if (review.count === 0) {
        await deps.answerCallbackQuery(
          callbackQueryId,
          "No proven inactive tabs",
        );
      } else {
        await deps.updateSettingsMessage(
          buildInactiveThreadReviewText(review.count),
          buildInactiveThreadReviewReplyMarkup(
            review.operationId,
            !!deps.cleanInactiveThreads,
          ),
        );
        await deps.answerCallbackQuery(
          callbackQueryId,
          "Review prepared. No tabs were deleted",
        );
      }
    } catch {
      await deps.answerCallbackQuery(
        callbackQueryId,
        "Could not safely review inactive tabs",
      );
    }
    return true;
  }
  if (data.startsWith("settings:clean:")) {
    const operationId = data.slice("settings:clean:".length);
    if (
      !/^thread-cleanup:[a-f0-9]{32}$/u.test(operationId) ||
      !deps.cleanInactiveThreads
    ) {
      await deps.answerCallbackQuery(
        callbackQueryId,
        "Cleanup confirmation is unavailable or stale",
      );
      return true;
    }
    try {
      const result = await deps.cleanInactiveThreads(operationId);
      await deps.answerCallbackQuery(
        callbackQueryId,
        `Deleted: ${result.deleted}. Outcome unknown: ${result.outcomeUnknown}` +
          (result.blocked ? `. Blocked: ${result.blocked}` : "") +
          (result.recovery === "commit-ready"
            ? ". Recovery: safe local commit pending"
            : result.recovery === "deletion-outcome-unknown"
              ? ". Recovery: deletion outcome unknown; no retry"
              : result.recovery === "authority-blocked"
                ? ". Recovery: cleanup authority unavailable"
                : ""),
      );
    } catch {
      await deps.answerCallbackQuery(
        callbackQueryId,
        "Cleanup could not be safely completed",
      );
    }
    return true;
  }
  if (
    data === "settings:set:automatic-thread-cleanup:on" ||
    data === "settings:set:automatic-thread-cleanup:off"
  ) {
    const enabled = data.endsWith(":on");
    await deps.setAutomaticThreadCleanupEnabled(enabled);
    await updateAutomaticThreadCleanupSettingsMessage(deps);
    await deps.answerCallbackQuery(
      callbackQueryId,
      `Thread cleanup ${enabled ? "enabled" : "disabled"}`,
    );
    return true;
  }
  await deps.answerCallbackQuery(callbackQueryId);
  return true;
}

export function createBaleSettingsMenuRuntime<
  TContext,
  TModel extends MenuModel = MenuModel,
>(
  deps: BaleSettingsMenuRuntimeDeps<TContext, TModel>,
  sectionRegistry?: BaleSectionRegistry,
): BaleSettingsMenuRuntime<TContext> {
  // Read per call so later port replacement on deps stays visible.
  const readSettingsState = (): BaleSettingsStateDeps => ({
    areDraftPreviewsEnabled: deps.areDraftPreviewsEnabled,
    getAssistantRenderingMode: deps.getAssistantRenderingMode,
    getActivityVerbosity: deps.getActivityVerbosity,
    getVoiceReplyMode: deps.getVoiceReplyMode,
    isVoiceReplyModeConfigured: deps.isVoiceReplyModeConfigured,
    getTimeInjectionMode: deps.getTimeInjectionMode,
    isAutomaticThreadCleanupEnabled: deps.isAutomaticThreadCleanupEnabled,
    getThreadDisplayMode: deps.getThreadDisplayMode,
    isThreadDisplayCustom: deps.isThreadDisplayCustom,
  });
  return {
    openSettingsMenu: async (
      chatId,
      _replyToMessageId,
      ctx,
      threadId,
      options,
    ) => {
      const delivery = createBaleMenuDelivery(
        { chatId, threadId },
        options,
        deps,
      );
      await deps.reloadConfig?.();
      delivery.assertCurrent();
      return openBaleSettingsMenu(
        {
          getModelMenuState: () =>
            deps.getModelMenuState(chatId, ctx, threadId),
          ...readSettingsState(),
          sendSettingsMenu: (state, text, replyMarkup) =>
            delivery.sendInteractiveMessage(
              state.chatId,
              text,
              "html",
              replyMarkup,
            ),
          storeModelMenuState: delivery.storeModelMenuState,
        },
        sectionRegistry,
      );
    },
    updateSettingsMenuMessage: async (state) => {
      await deps.reloadConfig?.();
      return updateBaleSettingsMenuMessage(
        {
          ...readSettingsState(),
          updateSettingsMessage: (text, replyMarkup) =>
            deps.editInteractiveMessage(
              state.chatId,
              state.messageId,
              text,
              "html",
              replyMarkup,
            ),
        },
        sectionRegistry,
      );
    },
    handleCallbackQuery: async (query, ctx) => {
      if (!query.data?.startsWith("settings:")) return false;
      await deps.reloadConfig?.();
      const messageId = query.message?.message_id;
      const chatId = query.message?.chat?.id;
      let state = deps.getStoredModelMenuState(messageId, chatId);
      if (!state) {
        if (typeof messageId !== "number" || typeof chatId !== "number") {
          await deps.answerCallbackQuery(
            query.id,
            "Interactive message expired",
          );
          return true;
        }
        state = await deps.getModelMenuState(
          chatId,
          ctx,
          query.message?.message_thread_id,
        );
        state.messageId = messageId;
        state.mode = "settings";
        deps.storeModelMenuState(state);
      }
      return handleBaleSettingsMenuCallbackAction(query.id, query.data, {
        ...readSettingsState(),
        setThreadDisplayMode: deps.setThreadDisplayMode,
        setDraftPreviewsEnabled: deps.setDraftPreviewsEnabled,
        setAssistantRenderingMode: deps.setAssistantRenderingMode,
        setActivityVerbosity: deps.setActivityVerbosity,
        setVoiceReplyMode: deps.setVoiceReplyMode,
        setTimeInjectionMode: deps.setTimeInjectionMode,
        setAutomaticThreadCleanupEnabled: deps.setAutomaticThreadCleanupEnabled,
        ...(deps.reviewInactiveThreads
          ? { reviewInactiveThreads: deps.reviewInactiveThreads }
          : {}),
        ...(deps.cleanInactiveThreads
          ? { cleanInactiveThreads: deps.cleanInactiveThreads }
          : {}),
        updateSettingsMessage: (text, replyMarkup) =>
          deps.editInteractiveMessage(
            state.chatId,
            state.messageId,
            text,
            "html",
            replyMarkup,
          ),
        answerCallbackQuery: deps.answerCallbackQuery,
        sectionRegistry,
      });
    },
  };
}

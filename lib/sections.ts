/**
 * Bale Extension Sections registry and callback routing
 * Zones: bale ui, extension platform, callback routing
 * Owns section registration, global registry binding, token mapping, main-menu/settings row injection, and section callback dispatch
 */

import {
  assertBaleCallbackData,
  type BaleInlineKeyboardMarkup,
} from "./keyboard.ts";
import type { BaleInputRichMessage } from "./bale-api.ts";

const SECTION_REGISTRY_KEY = "__piBaleSectionRegistry__";

/** @internal */
export type BaleSectionId = string;

/** @internal */
export type BaleSectionToken = string;

/** @internal */
export type BaleSectionCallbackResult = "handled" | "pass";

export interface BaleSectionView {
  text: string;
  /**
   * Source format for extension-provided section content.
   * Defaults to "html" for explicit Bale UI markup; use "markdown"
   * when a section naturally owns Markdown content, or "plain" for text.
   */
  parseMode?: "markdown" | "html" | "plain";
  replyMarkup?: BaleInlineKeyboardMarkup;
}

export interface BaleSectionSettingsRegistration {
  label: string;
  order?: number;
  getLabel?: () => string;
  open: (
    ctx: BaleSectionContext,
  ) => BaleSectionView | Promise<BaleSectionView>;
  handleCallback?: (
    ctx: BaleSectionCallbackContext,
  ) => BaleSectionCallbackResult | Promise<BaleSectionCallbackResult>;
}

export interface BaleSectionRegistration {
  id: BaleSectionId;
  label: string;
  order?: number;
  getLabel?: () => string;
  render: (
    ctx: BaleSectionContext,
  ) => BaleSectionView | Promise<BaleSectionView>;
  handleCallback?: (
    ctx: BaleSectionCallbackContext,
  ) => BaleSectionCallbackResult | Promise<BaleSectionCallbackResult>;
  settings?: BaleSectionSettingsRegistration;
}

export interface BaleSectionContext {
  sectionId: string;
  chatId: number;
  messageId?: number;
  answerCallback(text?: string): Promise<void>;
  edit(view: BaleSectionView): Promise<void>;
  open(view: BaleSectionView): Promise<void>;
  openRich(message: BaleInputRichMessage): Promise<void>;
  enqueuePrompt(prompt: string): Promise<void>;
  callbackData(action: string, payload?: string): string;
  /** Delete the message that triggered this callback (dialog cleanup) */
  deleteMessage(): Promise<void>;
}

export interface BaleSectionCallbackContext extends BaleSectionContext {
  action: string;
  payload: string;
}

/** @internal */
export interface RegisteredBaleSection {
  id: BaleSectionId;
  token: BaleSectionToken;
  label: string;
  order: number;
  registration: BaleSectionRegistration;
}

/** @internal */
export interface BaleSectionDiagnostic {
  id: BaleSectionId;
  token: BaleSectionToken;
  label: string;
  status: "active" | "error";
  lastError?: string;
}

/** @internal */
export interface BaleSectionRegistry {
  register(section: BaleSectionRegistration): () => void;
  getSections(): RegisteredBaleSection[];
  getByToken(
    token: BaleSectionToken,
  ): RegisteredBaleSection | undefined;
  getDiagnostics(): BaleSectionDiagnostic[];
  recordError(
    token: BaleSectionToken,
    message: string,
    source?: string,
  ): void;
  clearError(token: BaleSectionToken, source?: string): void;
  clear(): void;
}

/** @internal */
export interface BaleSectionMainMenuRow {
  text: string;
  callback_data: string;
}

/** @internal */
export interface BaleSectionSettingsRow {
  label: string;
  callback_data: string;
}

// --- Runtime Port Builders ---

/** @internal */
export interface BaleSectionTarget {
  chatId: number;
  threadId?: number;
}

/** @internal */
export interface BaleSectionRuntimeDeps {
  answerCallbackQuery: (id: string, text?: string) => Promise<void>;
  target?: BaleSectionTarget;
  editInteractiveMessage: (
    chatId: number,
    messageId: number,
    text: string,
    mode: "markdown" | "html" | "plain",
    replyMarkup: BaleInlineKeyboardMarkup,
  ) => Promise<void>;
  sendInteractiveMessage: (
    chatId: number,
    text: string,
    mode: "markdown" | "html" | "plain",
    replyMarkup: BaleInlineKeyboardMarkup,
    options?: { target?: BaleSectionTarget },
  ) => Promise<number | undefined>;
  sendRichMessage: (
    chatId: number,
    message: BaleInputRichMessage,
    options?: { target?: BaleSectionTarget },
  ) => Promise<number | undefined>;
  enqueuePrompt: (prompt: string) => Promise<void>;
  deleteMessage: (chatId: number, messageId: number) => Promise<void>;
}

function buildBaleSectionContext(
  sectionId: string,
  token: BaleSectionToken,
  chatId: number,
  messageId: number | undefined,
  callbackQueryId: string | undefined,
  deps: BaleSectionRuntimeDeps,
  backCallback = "menu:back",
  backLabel = "⬆️ Main menu",
): BaleSectionContext {
  return {
    sectionId,
    chatId,
    messageId,
    answerCallback: (text) =>
      callbackQueryId
        ? deps.answerCallbackQuery(callbackQueryId, text)
        : Promise.resolve(),
    edit: (view) =>
      messageId !== undefined
        ? deps.editInteractiveMessage(
            chatId,
            messageId,
            view.text,
            view.parseMode ?? "html",
            prependBackRow(view.replyMarkup, backCallback, backLabel),
          )
        : Promise.resolve(),
    open: (view) =>
      deps
        .sendInteractiveMessage(
          chatId,
          view.text,
          view.parseMode ?? "html",
          view.replyMarkup ?? { inline_keyboard: [] },
          deps.target ? { target: deps.target } : undefined,
        )
        .then(() => {}),
    openRich: (message) =>
      deps
        .sendRichMessage(
          chatId,
          message,
          deps.target ? { target: deps.target } : undefined,
        )
        .then(() => {}),
    enqueuePrompt: deps.enqueuePrompt,
    callbackData: (action, payload) =>
      buildBaleSectionCallbackData(token, action, payload),
    deleteMessage: () =>
      messageId !== undefined
        ? deps.deleteMessage(chatId, messageId)
        : Promise.resolve(),
  };
}

function buildBaleSectionCallbackContext(
  sectionId: string,
  token: BaleSectionToken,
  chatId: number,
  messageId: number | undefined,
  action: string,
  payload: string,
  callbackQueryId: string,
  deps: BaleSectionRuntimeDeps,
  backCallback = "menu:back",
  backLabel = "⬆️ Back",
): BaleSectionCallbackContext {
  return {
    ...buildBaleSectionContext(
      sectionId,
      token,
      chatId,
      messageId,
      callbackQueryId,
      deps,
      backCallback,
      backLabel,
    ),
    action,
    payload,
  };
}

// --- GlobalThis Bridge ---

/** @internal */
function setGlobalBaleSectionRegistry(
  registry: BaleSectionRegistry,
): void {
  (globalThis as Record<string, unknown>)[SECTION_REGISTRY_KEY] = registry;
}

/** @internal */
export function createAndBindBaleSectionRegistry(): BaleSectionRegistry {
  const registry = createBaleExtensionSectionRegistry();
  setGlobalBaleSectionRegistry(registry);
  return registry;
}

/**
 * Register a Bale Extension Section from any pi extension.
 * Returns a disposer. Throws if no section registry is active.
 */
export function registerBaleSection(
  section: BaleSectionRegistration,
): () => void {
  const registry = (globalThis as Record<string, unknown>)[
    SECTION_REGISTRY_KEY
  ] as BaleSectionRegistry | undefined;
  if (!registry) {
    throw new Error(
      "Bale section registry not available. Is pi-bale loaded and initialized?",
    );
  }

  return registry.register(section);
}

/**
 * Get current section diagnostics. Returns empty array when registry is absent.
 * @internal
 */
export function getBaleSectionDiagnostics(): BaleSectionDiagnostic[] {
  const registry = (globalThis as Record<string, unknown>)[
    SECTION_REGISTRY_KEY
  ] as BaleSectionRegistry | undefined;
  return registry ? registry.getDiagnostics() : [];
}

const BACK_NAV_ROW = {
  text: "⬆️ Back",
} as const;

function sectionErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function buildBaleSectionCallbackData(
  token: BaleSectionToken,
  action: string,
  payload?: string,
): string {
  const data = payload
    ? `section:${token}:${action}:${payload}`
    : `section:${token}:${action}`;
  return assertBaleCallbackData(data, "Bale section callback_data");
}

function prependBackRow(
  replyMarkup: BaleInlineKeyboardMarkup | undefined,
  backCallback: string,
  backLabel?: string,
): BaleInlineKeyboardMarkup {
  const backRow = {
    text: backLabel ?? BACK_NAV_ROW.text,
    callback_data: backCallback,
  };
  if (!replyMarkup || replyMarkup.inline_keyboard.length === 0) {
    return { inline_keyboard: [[backRow]] };
  }
  const firstRow = replyMarkup.inline_keyboard[0];
  const firstIsBack =
    firstRow.length === 1 && firstRow[0].callback_data === backCallback;
  if (firstIsBack) return replyMarkup;
  return {
    inline_keyboard: [[backRow], ...replyMarkup.inline_keyboard],
  };
}

/** @internal */
export function createBaleExtensionSectionRegistry(): BaleSectionRegistry {
  const sections = new Map<BaleSectionToken, RegisteredBaleSection>();
  const errors = new Map<
    BaleSectionToken,
    { message: string; source: string }
  >();
  let nextToken = 0;

  const register = (section: BaleSectionRegistration): (() => void) => {
    const duplicate = [...sections.values()].find((s) => s.id === section.id);
    if (duplicate) {
      throw new Error(`Bale section id already registered: ${section.id}`);
    }
    const token = String(nextToken++);
    const registered: RegisteredBaleSection = {
      id: section.id,
      token,
      label: section.label,
      order: section.order ?? 0,
      registration: section,
    };
    sections.set(token, registered);
    return () => {
      sections.delete(token);
      errors.delete(token);
    };
  };

  const getSections = (): RegisteredBaleSection[] => {
    return [...sections.values()].sort((a, b) => {
      if (a.order !== b.order) return a.order - b.order;
      return a.id.localeCompare(b.id);
    });
  };

  const getByToken = (
    token: BaleSectionToken,
  ): RegisteredBaleSection | undefined => {
    return sections.get(token);
  };

  const getDiagnostics = (): BaleSectionDiagnostic[] => {
    return getSections().map((s) => ({
      id: s.id,
      token: s.token,
      label: s.label,
      status: errors.has(s.token) ? "error" : "active",
      lastError: errors.get(s.token)?.message,
    }));
  };

  const recordError = (
    token: BaleSectionToken,
    message: string,
    source = "runtime",
  ): void => {
    if (sections.has(token)) errors.set(token, { message, source });
  };

  const clearError = (token: BaleSectionToken, source?: string): void => {
    const current = errors.get(token);
    if (!source || !current || current.source === source) errors.delete(token);
  };

  const clear = (): void => {
    sections.clear();
    errors.clear();
    nextToken = 0;
  };

  return {
    register,
    getSections,
    getByToken,
    getDiagnostics,
    recordError,
    clearError,
    clear,
  };
}

/** @internal */
export function getBaleExtensionSettingsRows(
  registry: BaleSectionRegistry,
): BaleSectionSettingsRow[] {
  const rows: BaleSectionSettingsRow[] = [];
  for (const section of registry
    .getSections()
    .filter((s) => s.registration.settings)
    .sort((a, b) => {
      const orderA = a.registration.settings!.order ?? 0;
      const orderB = b.registration.settings!.order ?? 0;
      if (orderA !== orderB) return orderA - orderB;
      return a.id.localeCompare(b.id);
    })) {
    try {
      rows.push({
        label:
          section.registration.settings!.getLabel?.() ??
          section.registration.settings!.label,
        callback_data: `section:${section.token}:settings:open`,
      });
      registry.clearError(section.token, "settings_label");
    } catch (error) {
      registry.recordError(
        section.token,
        sectionErrorMessage(error),
        "settings_label",
      );
    }
  }
  return rows;
}

/** @internal */
export function getBaleSectionMainMenuRows(
  registry: BaleSectionRegistry,
): BaleSectionMainMenuRow[] {
  const rows: BaleSectionMainMenuRow[] = [];
  for (const section of registry.getSections()) {
    try {
      rows.push({
        text: section.registration.getLabel?.() ?? section.label,
        callback_data: `section:${section.token}:open`,
      });
      registry.clearError(section.token, "main_label");
    } catch (error) {
      registry.recordError(
        section.token,
        sectionErrorMessage(error),
        "main_label",
      );
    }
  }
  return rows;
}

/** @internal */
export function parseBaleSectionCallback(
  data: string,
): { token: string; action: string; payload: string } | undefined {
  if (!data.startsWith("section:")) return undefined;
  const rest = data.slice("section:".length);
  const firstColon = rest.indexOf(":");
  if (firstColon === -1) return undefined;
  const token = rest.slice(0, firstColon);
  const afterToken = rest.slice(firstColon + 1);
  const secondColon = afterToken.indexOf(":");
  if (secondColon === -1) {
    return { token, action: afterToken, payload: "" };
  }
  return {
    token,
    action: afterToken.slice(0, secondColon),
    payload: afterToken.slice(secondColon + 1),
  };
}

export async function handleBaleSectionOpen(
  registry: BaleSectionRegistry,
  token: BaleSectionToken,
  chatId: number,
  messageId: number,
  callbackQueryId: string,
  deps: BaleSectionRuntimeDeps,
): Promise<boolean> {
  const section = registry.getByToken(token);
  if (!section) {
    await deps.answerCallbackQuery(
      callbackQueryId,
      "This section is no longer available",
    );
    return true;
  }
  try {
    const sectionCtx = buildBaleSectionContext(
      section.id,
      token,
      chatId,
      messageId,
      callbackQueryId,
      deps,
    );
    const view = await section.registration.render(sectionCtx);
    const viewWithBack = {
      ...view,
      replyMarkup: prependBackRow(
        view.replyMarkup,
        "menu:back",
        "⬆️ Main menu",
      ),
    };
    await deps.editInteractiveMessage(
      chatId,
      messageId,
      viewWithBack.text,
      viewWithBack.parseMode ?? "html",
      viewWithBack.replyMarkup,
    );
    await deps.answerCallbackQuery(callbackQueryId);
    registry.clearError(token, "render");
    return true;
  } catch (error) {
    const message = sectionErrorMessage(error);
    registry.recordError(token, message, "render");
    await deps.answerCallbackQuery(
      callbackQueryId,
      `Section error: ${message}`,
    );
    return true;
  }
}

export async function handleBaleSectionCallback(
  registry: BaleSectionRegistry,
  token: BaleSectionToken,
  action: string,
  payload: string,
  chatId: number,
  messageId: number,
  callbackQueryId: string,
  deps: BaleSectionRuntimeDeps,
): Promise<boolean> {
  const section = registry.getByToken(token);
  if (!section) {
    await deps.answerCallbackQuery(
      callbackQueryId,
      "This section is no longer available",
    );
    return true;
  }
  // Try main handleCallback first, then settings handleCallback as fallback.
  const mainHandler = section.registration.handleCallback;
  const settingsHandler = section.registration.settings?.handleCallback;
  const handler = mainHandler ?? settingsHandler;
  if (!handler) {
    await deps.answerCallbackQuery(callbackQueryId);
    return true;
  }
  try {
    const ctx = buildBaleSectionCallbackContext(
      section.id,
      token,
      chatId,
      messageId,
      action,
      payload,
      callbackQueryId,
      deps,
      mainHandler ? `section:${token}:open` : "settings:list",
    );
    let result = await handler(ctx);
    // Fallback: if main handler passed and settings handler exists, try settings
    // with the correct navigation context (back → settings list).
    if (result === "pass" && mainHandler && settingsHandler) {
      const settingsCtx = buildBaleSectionCallbackContext(
        section.id,
        token,
        chatId,
        messageId,
        action,
        payload,
        callbackQueryId,
        deps,
        "settings:list",
      );
      result = await settingsHandler(settingsCtx);
    }
    if (result === "pass") {
      await deps.answerCallbackQuery(callbackQueryId);
    }
    registry.clearError(token, "callback");
    return true;
  } catch (error) {
    const message = sectionErrorMessage(error);
    registry.recordError(token, message, "callback");
    await deps.answerCallbackQuery(
      callbackQueryId,
      `Section error: ${message}`,
    );
    return true;
  }
}

export async function handleBaleSectionSettingsOpen(
  registry: BaleSectionRegistry,
  token: BaleSectionToken,
  chatId: number,
  messageId: number,
  callbackQueryId: string,
  deps: BaleSectionRuntimeDeps,
): Promise<boolean> {
  const section = registry.getByToken(token);
  if (!section || !section.registration.settings) {
    await deps.answerCallbackQuery(
      callbackQueryId,
      "This section is no longer available",
    );
    return true;
  }
  try {
    const sectionCtx = buildBaleSectionContext(
      section.id,
      token,
      chatId,
      messageId,
      callbackQueryId,
      deps,
      "settings:list",
      "⬆️ Back",
    );
    const view = await section.registration.settings.open(sectionCtx);
    const viewWithBack = {
      ...view,
      replyMarkup: prependBackRow(view.replyMarkup, "settings:list", "⬆️ Back"),
    };
    await deps.editInteractiveMessage(
      chatId,
      messageId,
      viewWithBack.text,
      viewWithBack.parseMode ?? "html",
      viewWithBack.replyMarkup,
    );
    await deps.answerCallbackQuery(callbackQueryId);
    registry.clearError(token, "settings_open");
    return true;
  } catch (error) {
    const message = sectionErrorMessage(error);
    registry.recordError(token, message, "settings_open");
    await deps.answerCallbackQuery(
      callbackQueryId,
      `Section error: ${message}`,
    );
    return true;
  }
}

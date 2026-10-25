/**
 * Bale outbound markup parsing helpers
 * Zones: bale outbound, assistant markup
 * Owns top-level assistant action comment extraction, attribute parsing, and markup stripping shared by voice and outbound delivery
 */

import { isWireRecord as isBaleActionPayload } from "./wire.ts";

export interface BaleTopLevelHtmlComment {
  raw: string;
  content: string;
  start: number;
  end: number;
}

interface BaleTopLevelFenceState {
  marker: "`" | "~";
  length: number;
}

function getMarkdownLineEnd(markdown: string, offset: number): number {
  const newlineIndex = markdown.indexOf("\n", offset);
  return newlineIndex === -1 ? markdown.length : newlineIndex + 1;
}

function getMarkdownLineText(
  markdown: string,
  offset: number,
  end: number,
): string {
  return markdown.slice(offset, end).replace(/\r?\n$/, "");
}

function getTopLevelOpeningFence(
  line: string,
): BaleTopLevelFenceState | undefined {
  const match = line.match(/^(?: {0,3})(`{3,}|~{3,})/);
  const sequence = match?.[1];
  if (!sequence) return undefined;
  return {
    marker: sequence[0] as "`" | "~",
    length: sequence.length,
  };
}

function isTopLevelClosingFence(
  line: string,
  fence: BaleTopLevelFenceState,
): boolean {
  const match = line.match(/^(?: {0,3})(`{3,}|~{3,})([ \t]*)$/);
  const sequence = match?.[1];
  return (
    !!sequence &&
    sequence[0] === fence.marker &&
    sequence.length >= fence.length
  );
}

export function collectTopLevelHtmlComments(markdown: string): {
  comments: BaleTopLevelHtmlComment[];
  openCommentStart?: number;
} {
  const comments: BaleTopLevelHtmlComment[] = [];
  let offset = 0;
  let fence: BaleTopLevelFenceState | undefined;
  while (offset < markdown.length) {
    const lineEnd = getMarkdownLineEnd(markdown, offset);
    const line = getMarkdownLineText(markdown, offset, lineEnd);
    if (fence) {
      if (isTopLevelClosingFence(line, fence)) fence = undefined;
      offset = lineEnd;
      continue;
    }
    const nextFence = getTopLevelOpeningFence(line);
    if (nextFence) {
      fence = nextFence;
      offset = lineEnd;
      continue;
    }
    if (line.startsWith("<!--")) {
      const closeIndex = markdown.indexOf("-->", offset + 4);
      if (closeIndex === -1) return { comments, openCommentStart: offset };
      const end = closeIndex + 3;
      const raw = markdown.slice(offset, end);
      const content = raw.slice(4, -3);
      comments.push({ raw, content, start: offset, end });
      offset = getMarkdownLineEnd(markdown, end);
      continue;
    }
    offset = lineEnd;
  }
  return { comments };
}

export function replaceBaleButtonFences(
  markdown: string,
  replace: (payload: string, closed: boolean) => string,
): string {
  let result = "";
  let copied = 0;
  let offset = 0;
  let fence: BaleTopLevelFenceState | undefined;
  let actionStart: number | undefined;
  let contentStart = 0;
  while (offset < markdown.length) {
    const end = getMarkdownLineEnd(markdown, offset);
    const line = getMarkdownLineText(markdown, offset, end);
    if (fence) {
      if (isTopLevelClosingFence(line, fence)) {
        if (actionStart !== undefined) {
          result += markdown.slice(copied, actionStart);
          result += replace(markdown.slice(contentStart, offset), true) + "\n";
          copied = end;
          actionStart = undefined;
        }
        fence = undefined;
      }
    } else if (line.includes("<!--")) {
      const close = markdown.indexOf("-->", offset + line.indexOf("<!--") + 4);
      if (close < 0) break;
      offset = getMarkdownLineEnd(markdown, close + 3);
      continue;
    } else {
      fence = getTopLevelOpeningFence(line);
      if (fence && /^```bale_button[ \t]*$/.test(line)) {
        actionStart = offset;
        contentStart = end;
      }
    }
    offset = end;
  }
  if (actionStart !== undefined) {
    result += markdown.slice(copied, actionStart);
    return result + replace(markdown.slice(contentStart), false);
  }
  return result + markdown.slice(copied);
}

export function replaceTopLevelHtmlComments(
  markdown: string,
  replacer: (comment: BaleTopLevelHtmlComment) => string,
): string {
  const { comments } = collectTopLevelHtmlComments(markdown);
  if (comments.length === 0) return markdown;
  let result = "";
  let offset = 0;
  for (const comment of comments) {
    result += markdown.slice(offset, comment.start);
    result += replacer(comment);
    offset = comment.end;
  }
  return result + markdown.slice(offset);
}

function findTopLevelOpenOrPartialHtmlCommentIndex(markdown: string): number {
  const { openCommentStart } = collectTopLevelHtmlComments(markdown);
  if (openCommentStart !== undefined) return openCommentStart;
  let offset = 0;
  let fence: BaleTopLevelFenceState | undefined;
  while (offset < markdown.length) {
    const lineEnd = getMarkdownLineEnd(markdown, offset);
    const line = getMarkdownLineText(markdown, offset, lineEnd);
    const isLastLine = lineEnd >= markdown.length;
    if (fence) {
      if (isTopLevelClosingFence(line, fence)) fence = undefined;
      offset = lineEnd;
      continue;
    }
    const nextFence = getTopLevelOpeningFence(line);
    if (nextFence) {
      fence = nextFence;
      offset = lineEnd;
      continue;
    }
    if (isLastLine && (line === "<" || line === "<!" || line === "<!-")) {
      return offset;
    }
    offset = lineEnd;
  }
  return -1;
}

function parseTolerantBaleAttributes(
  source: string,
  names: readonly string[],
): Record<string, string> | undefined {
  const attributes: Record<string, string> = {};
  const namePattern = names.join("|");
  const pattern = new RegExp(
    `\\b(${namePattern})\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s]+))`,
    "gu",
  );
  for (const match of source.matchAll(pattern)) {
    const value = (match[2] ?? match[3] ?? match[4] ?? "").trim();
    if (value) attributes[match[1]!] = value;
  }
  return Object.keys(attributes).length > 0 ? attributes : undefined;
}

function removeBaleJsonTrailingCommas(source: string): string {
  let normalized = "";
  let inString = false;
  let escaped = false;
  for (let offset = 0; offset < source.length; offset += 1) {
    const character = source[offset]!;
    if (inString) {
      normalized += character;
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      normalized += character;
      continue;
    }
    if (character === ",") {
      let next = offset + 1;
      while (/\s/u.test(source[next] ?? "")) next += 1;
      if (source[next] === "}" || source[next] === "]") continue;
    }
    normalized += character;
  }
  return normalized;
}

function parseBaleJsonObjectCandidate(
  source: string,
): Record<string, unknown> | undefined {
  const normalized = removeBaleJsonTrailingCommas(source);
  for (const candidate of normalized === source
    ? [source]
    : [source, normalized]) {
    try {
      const value: unknown = JSON.parse(candidate);
      if (isBaleActionPayload(value)) return value;
    } catch {
      // Try the bounded trailing-comma normalization before rejecting JSON.
    }
  }
  return undefined;
}

function looksLikeBaleNamedJsonObject(
  source: string,
  offset: number,
): boolean {
  return /^\{\s*"(?:[^"\\]|\\.)*"\s*:/u.test(source.slice(offset));
}

/** Blank one structured span so tolerant attribute parsing never reads keys inside rejected JSON or matrices. */
function blankBaleActionSpan(
  text: string,
  start: number,
  end: number,
): string {
  return `${text.slice(0, start)}${" ".repeat(end - start)}${text.slice(end)}`;
}

/**
 * Scans one action comment for its first accepted structured payload. Otherwise returns the attribute envelope
 * with every structured span blanked; implausible `[` starts are skipped without a parse attempt.
 */
function scanBaleActionComment<T>(
  comment: BaleTopLevelHtmlComment,
  command: string,
  parseStructured: (content: string, offset: number) => T | undefined,
): { payload: T } | { attributeEnvelope: string } | undefined {
  let content = comment.content.replace(/^\s+/, "").replace(/^!/, "");
  if (!content.startsWith(command)) return undefined;
  content = content.slice(command.length);
  let attributeEnvelope = content;
  for (let offset = 0; offset < content.length; offset += 1) {
    const char = content[offset];
    if (char !== "{" && char !== "[") continue;
    if (char === "{" || isPlausibleBaleMatrixStart(content, offset)) {
      const payload = parseStructured(content, offset);
      if (payload !== undefined) return { payload };
    }
    const end = findBaleStructuredPayloadEnd(content, offset);
    if (end === undefined) continue;
    attributeEnvelope = blankBaleActionSpan(attributeEnvelope, offset, end);
    offset = end - 1;
  }
  return { attributeEnvelope };
}

function parseBaleActionPayload(
  comment: BaleTopLevelHtmlComment,
  command: string,
): Record<string, unknown> | undefined {
  const scanned = scanBaleActionComment(
    comment,
    command,
    (content, offset) =>
      content[offset] === "{"
        ? parseBaleAdaptiveActionPayloadRows(
            content.slice(offset),
            parseBaleVoiceCompactActionPayload,
            { allowTrailing: true },
          )?.rows[0]![0]
        : undefined,
  );
  if (!scanned) return undefined;
  if ("payload" in scanned) return scanned.payload;
  return parseTolerantBaleAttributes(scanned.attributeEnvelope, [
    "text",
    "value",
    "lang",
    "rate",
  ]);
}

const BALE_COMPACT_ACTION_CONTROL_PATTERN = /[\u0000-\u001f\u007f-\u009f]/u;

type BaleCompactActionPayloadParser = (
  atoms: readonly string[],
) => Record<string, unknown> | undefined;

function parseBaleButtonCompactActionPayload(
  atoms: readonly string[],
): Record<string, unknown> | undefined {
  const [label, prompt, selectedStyle, disabled] = atoms;
  if (atoms.length === 1) return label ? { value: label } : undefined;
  const isDisabled = disabled === "1" || disabled === "true";
  if (!prompt && !(atoms.length === 4 && isDisabled)) return undefined;
  const action = label ? { label, prompt } : { prompt };
  if (atoms.length === 2) return action;
  if (
    selectedStyle !== "primary" &&
    selectedStyle !== "success" &&
    selectedStyle !== "danger" &&
    !(atoms.length === 4 && selectedStyle === "")
  )
    return undefined;
  if (
    atoms.length === 4 &&
    !isDisabled &&
    disabled !== "0" &&
    disabled !== "false"
  ) {
    return undefined;
  }
  return {
    ...action,
    ...(selectedStyle ? { selected_style: selectedStyle } : {}),
    ...(atoms.length === 4 ? { disabled: isDisabled } : {}),
  };
}

function parseBaleVoiceCompactActionPayload(
  atoms: readonly string[],
): Record<string, unknown> | undefined {
  const [text, lang, rate] = atoms;
  if (!text) return undefined;
  if (atoms.length === 1) return { text };
  if (!lang) return undefined;
  if (atoms.length === 2) return { text, lang };
  if (!rate) return undefined;
  return { text, lang, rate };
}

function parseBaleAdaptiveActionPayloadRows(
  source: string,
  parseCompactPayload: BaleCompactActionPayloadParser,
  options: { allowTrailing?: boolean; maxCompactAtoms?: number; allowMatrixGroups?: boolean } = {},
): { rows: Record<string, unknown>[][]; end: number } | undefined {
  let offset = 0;
  const isStructuralWhitespace = (character: string | undefined): boolean =>
    character === " " ||
    character === "\t" ||
    character === "\r" ||
    character === "\n";
  const skipWhitespace = (): void => {
    while (isStructuralWhitespace(source[offset])) offset += 1;
  };
  const consumeOptionalSeparator = (): boolean => {
    skipWhitespace();
    if (source[offset] !== ",") return true;
    offset += 1;
    skipWhitespace();
    return source[offset] !== ",";
  };
  const normalizeAtom = (value: string): string | undefined => {
    const normalized = value.trim();
    return !BALE_COMPACT_ACTION_CONTROL_PATTERN.test(normalized)
      ? normalized
      : undefined;
  };
  const parseCompactCell = (): Record<string, unknown> | undefined => {
    if (source[offset] !== "{") return undefined;
    offset += 1;
    const atomSources: string[][] = [[]];
    while (offset < source.length) {
      const character = source[offset]!;
      if (character === "\\") {
        const escaped = source[offset + 1];
        if (escaped !== "|" && escaped !== "}" && escaped !== "\\") {
          return undefined;
        }
        atomSources.at(-1)!.push(escaped);
        offset += 2;
        continue;
      }
      if (character === "|") {
        if (atomSources.length >= (options.maxCompactAtoms ?? 3))
          return undefined;
        atomSources.push([]);
        offset += 1;
        continue;
      }
      if (character === "}") {
        offset += 1;
        const atoms = atomSources.map((atom) => normalizeAtom(atom.join("")));
        if (atoms.some((atom) => atom === undefined)) return undefined;
        return parseCompactPayload(atoms as string[]);
      }
      atomSources.at(-1)!.push(character);
      offset += 1;
    }
    return undefined;
  };
  const parseJsonObjectCell = (): Record<string, unknown> | undefined => {
    if (source[offset] !== "{") return undefined;
    const start = offset;
    const stack: string[] = [];
    let inString = false;
    let escaped = false;
    for (let index = start; index < source.length; index += 1) {
      const character = source[index]!;
      if (inString) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === '"') inString = false;
        continue;
      }
      if (character === '"') {
        inString = true;
        continue;
      }
      if (character === "{" || character === "[") {
        stack.push(character);
        continue;
      }
      if (character !== "}" && character !== "]") continue;
      const opening = stack.pop();
      if (
        (character === "}" && opening !== "{") ||
        (character === "]" && opening !== "[")
      )
        return undefined;
      if (stack.length > 0) continue;
      const candidate = source.slice(start, index + 1);
      const value = parseBaleJsonObjectCandidate(candidate);
      if (!value) return undefined;
      offset = index + 1;
      return value;
    }
    return undefined;
  };
  const parseCell = (): Record<string, unknown> | undefined => {
    const start = offset;
    const jsonCell = parseJsonObjectCell();
    if (jsonCell) return jsonCell;
    offset = start;
    if (looksLikeBaleNamedJsonObject(source, start)) return undefined;
    return parseCompactCell();
  };
  const parseRow = (): Record<string, unknown>[] | undefined => {
    if (source[offset] !== "[") return undefined;
    offset += 1;
    const row: Record<string, unknown>[] = [];
    while (offset < source.length) {
      skipWhitespace();
      if (source[offset] === "]") {
        offset += 1;
        return row.length > 0 ? row : undefined;
      }
      if (source[offset] !== "{") return undefined;
      const cell = parseCell();
      if (!cell) return undefined;
      row.push(cell);
      if (!consumeOptionalSeparator()) return undefined;
    }
    return undefined;
  };
  const parseMatrix = (): Record<string, unknown>[][] | undefined => {
    if (source[offset] !== "[") return undefined;
    offset += 1;
    const rows: Record<string, unknown>[][] = [];
    while (offset < source.length) {
      skipWhitespace();
      const character = source[offset];
      if (character === "]") {
        offset += 1;
        return rows.length > 0 ? rows : undefined;
      }
      if (character === "{") {
        const cell = parseCell();
        if (!cell) return undefined;
        rows.push([cell]);
      } else if (character === "[") {
        const row = parseRow();
        if (!row) return undefined;
        rows.push(row);
      } else {
        return undefined;
      }
      if (!consumeOptionalSeparator()) return undefined;
    }
    return undefined;
  };

  const parseTopLevelRows = (): Record<string, unknown>[][] | undefined => {
    const rows: Record<string, unknown>[][] = [];
    while (offset < source.length) {
      skipWhitespace();
      const character = source[offset];
      if (character === "{") {
        const cell = parseCell();
        if (!cell) return undefined;
        rows.push([cell]);
      } else if (character === "[" && options.allowMatrixGroups) {
        const matrix = parseMatrix();
        if (!matrix) return undefined;
        rows.push(...matrix);
      } else {
        break;
      }
      if (!consumeOptionalSeparator()) return undefined;
    }
    return rows.length > 0 ? rows : undefined;
  };

  skipWhitespace();
  const rows = parseTopLevelRows();
  if (!rows) return undefined;
  skipWhitespace();
  if (!options.allowTrailing && offset !== source.length) return undefined;
  return { rows, end: offset };
}

function findBaleStructuredPayloadEnd(
  source: string,
  start: number,
): number | undefined {
  const stack: string[] = [source[start]!];
  let inString = false;
  let escaped = false;
  for (let offset = start + 1; offset < source.length; offset += 1) {
    const character = source[offset]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      continue;
    }
    if (character === "[" || character === "{") {
      stack.push(character);
      continue;
    }
    if (character !== "]" && character !== "}") continue;
    const expected = character === "]" ? "[" : "{";
    if (stack.at(-1) === expected) stack.pop();
    if (stack.length === 0) return offset + 1;
  }
  return undefined;
}

function isPlausibleBaleMatrixStart(
  source: string,
  start: number,
): boolean {
  let offset = start + 1;
  while (/\s/u.test(source[offset] ?? "")) offset += 1;
  return (
    source[offset] === "{" || source[offset] === "[" || source[offset] === "]"
  );
}

export function parseBaleButtonPayloadRows(
  source: string,
): Record<string, unknown>[][] | undefined {
  return parseBaleAdaptiveActionPayloadRows(
    source.trim(),
    parseBaleButtonCompactActionPayload,
    { maxCompactAtoms: 4, allowMatrixGroups: true },
  )?.rows;
}

export function parseBaleActionPayloadRows(
  comment: BaleTopLevelHtmlComment,
  command: string,
): Record<string, unknown>[][] | undefined {
  const scanned = scanBaleActionComment(
    comment,
    command,
    (content, offset) =>
      parseBaleAdaptiveActionPayloadRows(
        content.slice(offset),
        parseBaleButtonCompactActionPayload,
        { allowTrailing: true, maxCompactAtoms: 4, allowMatrixGroups: true },
      )?.rows,
  );
  if (!scanned) return undefined;
  if ("payload" in scanned) return scanned.payload;
  const attributes = parseTolerantBaleAttributes(
    scanned.attributeEnvelope,
    ["label", "prompt", "value", "selected_style", "disabled"],
  );
  if (!attributes) return undefined;
  return [
    [
      {
        ...attributes,
        ...(attributes.disabled === "true" || attributes.disabled === "false"
          ? { disabled: attributes.disabled === "true" }
          : {}),
      },
    ],
  ];
}

function normalizeMarkdownAfterVoiceExtraction(markdown: string): string {
  return markdown.replace(/\n{3,}/g, "\n\n").trim();
}

function isBaleCommentOnlyLinePrefix(value: string): boolean {
  return /^[ \t]*(?:(?:>[ \t]*)+)?(?:(?:[-+*]|\d+[.)])[ \t]+)?$/u.test(value);
}

function stripBaleHtmlCommentBlocks(markdown: string): string {
  let result = "";
  let offset = 0;
  while (offset < markdown.length) {
    const start = markdown.indexOf("<!--", offset);
    if (start === -1) return result + markdown.slice(offset);
    const close = markdown.indexOf("-->", start + 4);
    const lineStart = markdown.lastIndexOf("\n", start - 1) + 1;
    const afterComment = close === -1 ? markdown.length : close + 3;
    const newlineAfterComment = markdown.indexOf("\n", afterComment);
    const lineEnd =
      newlineAfterComment === -1 ? markdown.length : newlineAfterComment;
    const commentOwnsLine =
      isBaleCommentOnlyLinePrefix(markdown.slice(lineStart, start)) &&
      markdown.slice(afterComment, lineEnd).trim().length === 0;
    result += markdown.slice(offset, commentOwnsLine ? lineStart : start);
    if (close === -1) return result;
    offset = commentOwnsLine
      ? newlineAfterComment === -1
        ? markdown.length
        : newlineAfterComment + 1
      : afterComment;
  }
  return result;
}

export function stripBaleCommentMarkupForPreview(markdown: string): string {
  const withoutClosedBlocks = stripBaleHtmlCommentBlocks(
    replaceBaleButtonFences(markdown, () => ""),
  );
  const openBlockIndex =
    findTopLevelOpenOrPartialHtmlCommentIndex(withoutClosedBlocks);
  const previewMarkdown =
    openBlockIndex >= 0
      ? withoutClosedBlocks.slice(0, openBlockIndex)
      : withoutClosedBlocks;
  return normalizeMarkdownAfterVoiceExtraction(previewMarkdown);
}

export function stripBaleCommentMarkupForDelivery(
  markdown: string,
): string {
  const withoutClosedBlocks = stripBaleHtmlCommentBlocks(markdown);
  const openBlockIndex =
    findTopLevelOpenOrPartialHtmlCommentIndex(withoutClosedBlocks);
  const deliveryMarkdown =
    openBlockIndex >= 0
      ? withoutClosedBlocks.slice(0, openBlockIndex)
      : withoutClosedBlocks;
  return normalizeMarkdownAfterVoiceExtraction(deliveryMarkdown);
}

export interface BaleVoiceReplyItem {
  text: string;
  lang?: string;
  rate?: string;
}

export interface BaleVoiceReplyPlan {
  markdown: string;
  voiceText?: string;
  voiceReplies?: BaleVoiceReplyItem[];
  lang?: string;
  rate?: string;
}

export function getBaleActionString(
  payload: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = payload[key];
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

export function planBaleVoiceReply(
  markdown: string,
): BaleVoiceReplyPlan {
  const voiceReplies: BaleVoiceReplyItem[] = [];
  let lang: string | undefined;
  let rate: string | undefined;
  const stripped = replaceTopLevelHtmlComments(markdown, (comment) => {
    const command = "bale_voice";
    const normalizedContent = comment.content
      .replace(/^\s+/, "")
      .replace(/^!/, "");
    if (!normalizedContent.startsWith(command)) return comment.raw;
    const payload = parseBaleActionPayload(comment, command);
    if (!payload) return "";
    const text =
      getBaleActionString(payload, "text") ??
      getBaleActionString(payload, "value");
    const itemLang = getBaleActionString(payload, "lang");
    const itemRate = getBaleActionString(payload, "rate");
    if (text) {
      voiceReplies.push({
        text,
        ...(itemLang ? { lang: itemLang } : {}),
        ...(itemRate ? { rate: itemRate } : {}),
      });
    }
    if (itemLang) lang = itemLang;
    if (itemRate) rate = itemRate;
    return "";
  });
  const voiceText = voiceReplies
    .map((reply) => reply.text)
    .join("\n\n")
    .trim();
  return {
    markdown: stripBaleCommentMarkupForDelivery(stripped),
    ...(voiceText ? { voiceText } : {}),
    ...(voiceReplies.length > 0 ? { voiceReplies } : {}),
    ...(lang ? { lang } : {}),
    ...(rate ? { rate } : {}),
  };
}

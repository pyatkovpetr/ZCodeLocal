/**
 * 只读扫描 Claude / Codex / Kimi / Cursor 的本地历史。
 * 目录布局与 Orion history_import.sources / discover 一致，不修改来源文件。
 */
import { readFile, readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  classifyForeignTranscript,
  isPlaceholderForeignTitle,
  stripForeignSessionNoise,
} from "./classify.mjs";
import {
  canonicalWorkspacePath,
  collectClaude,
  collectCodex,
  collectCursorFolders,
  collectKimi,
  cursorFolderSessionId,
  cursorProjectSlug,
  cursorSlugFromTranscript,
  cursorUserDir,
  fileTime,
  forEachJsonLine,
  home,
  kimiSessionId,
  sessionIdFromFile,
  sourcePath,
} from "./sessionFiles.js";
import type {
  ForeignSessionPreview,
  ForeignSessionScanInput,
  ForeignSessionScanResult,
  ForeignSessionSelection,
  ForeignSessionSource,
  ForeignSessionSourceStatus,
  ForeignSessionTranscript,
} from "./contract.js";

const DEFAULT_LIMIT = 5000;
const MAX_LIMIT = 5000;
const CURSOR_CAP = 200;
const RECORD_CAP = 4_000;
const MESSAGE_CHARS = 8_000;
const MAX_MESSAGES = 80;
const CURSOR_BUBBLES = 40;

interface Draft {
  source: ForeignSessionSource;
  sessionId: string;
  workspacePath: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  userTexts: string[];
  assistantTexts: string[];
  successfulToolCount: number;
  sawAbort: boolean;
  messages: ForeignSessionTranscript["messages"];
  /** 只根据文件名列出，还没读正文。数量先出来，分类稍后再替换。 */
  inventory?: boolean;
  /** Cursor 个人目录名，用来和其它来源的真实路径对齐。 */
  cursorSlug?: string;
}

const SOURCES: ForeignSessionSource[] = ["claude", "codex", "kimi", "cursor"];

function limitOf(value: number | undefined): number {
  if (!Number.isFinite(value) || !value || value <= 0) return DEFAULT_LIMIT;
  return Math.min(Math.floor(value), MAX_LIMIT);
}

function textOf(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(textOf).filter(Boolean).join("\n");
  if (!value || typeof value !== "object") return "";
  const record = value as Record<string, unknown>;
  if (typeof record.text === "string") return record.text;
  if ("content" in record) return textOf(record.content);
  return "";
}

function clip(text: string): string {
  const normalized = text.replace(/\r\n/g, "\n").trim();
  return normalized.length > MESSAGE_CHARS ? normalized.slice(0, MESSAGE_CHARS) : normalized;
}

function titleFrom(explicit: string, userText: string): string {
  const fromName = stripForeignSessionNoise(explicit).replace(/\s+/g, " ").trim();
  const fromUser = stripForeignSessionNoise(userText).replace(/\s+/g, " ").trim();
  const named = fromName && !fromName.startsWith("<") && !isPlaceholderForeignTitle(fromName) ? fromName : "";
  const clean = named || (fromUser.startsWith("<") ? "" : fromUser);
  if (!clean) return "Imported session";
  return clean.length > 80 ? `${clean.slice(0, 79)}…` : clean;
}

function stamp(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value < 1_000_000_000_000 ? value * 1000 : value;
  }
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function emptyDraft(source: ForeignSessionSource, sessionId: string, updatedAt: number): Draft {
  return {
    source,
    sessionId,
    workspacePath: "",
    title: "",
    createdAt: updatedAt,
    updatedAt,
    userTexts: [],
    assistantTexts: [],
    successfulToolCount: 0,
    sawAbort: false,
    messages: [],
  };
}

function pushMessage(draft: Draft, role: "user" | "assistant", content: string, timestamp: number): void {
  const normalized = content.replace(/\r\n/g, "\n").trim();
  // 先去掉环境块，再截断。反过来会把请求切掉，标题又变回 <environment_context>。
  const visible = stripForeignSessionNoise(normalized);
  const text = clip(visible);
  if (!text) return;
  if (role === "user") draft.userTexts.push(text);
  else draft.assistantTexts.push(text);
  if (draft.messages.length < MAX_MESSAGES) {
    draft.messages.push({ role, content: text, timestamp });
  }
  draft.updatedAt = Math.max(draft.updatedAt, timestamp);
}

const FILE_UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/iu;

function previewOf(draft: Draft): ForeignSessionPreview {
  if (draft.inventory) {
    return {
      source: draft.source,
      sessionId: draft.sessionId,
      workspacePath: draft.workspacePath,
      title: draft.title || draft.sessionId.slice(0, 8),
      updatedAt: draft.updatedAt,
      verdict: "useful",
      reasons: [],
    };
  }
  const classification = classifyForeignTranscript(draft);
  const userText =
    draft.userTexts.find((text) => {
      const clean = stripForeignSessionNoise(text).trim();
      return clean.length > 0 && !/^[[{<]/u.test(clean);
    }) ?? "";
  return {
    source: draft.source,
    sessionId: draft.sessionId,
    workspacePath: draft.workspacePath,
    title: titleFrom(draft.title, userText),
    updatedAt: draft.updatedAt,
    verdict: classification.verdict,
    reasons: classification.reasons,
  };
}

function transcriptOf(draft: Draft): ForeignSessionTranscript {
  const preview = previewOf(draft);
  return {
    source: draft.source,
    sessionId: draft.sessionId,
    workspacePath: draft.workspacePath,
    ...(draft.cursorSlug ? { cursorSlug: draft.cursorSlug } : {}),
    title: preview.title,
    createdAt: draft.createdAt,
    updatedAt: draft.updatedAt,
    messages: draft.messages,
  };
}

function yieldToHost(): Promise<void> {
  // 扫描会读几千个会话文件和 Cursor 的大库。整段同步做完时，Host 读不到
  // Agent 的 SQLite 启动帧，30 秒门禁会误报 startup_status_timeout。
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

async function mapPool<T, R>(
  items: T[],
  limit: number,
  run: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await run(items[index] as T);
      await yieldToHost();
    }
  });
  await Promise.all(workers);
  return results;
}

function applyCursorFolder(draft: Draft, row: Record<string, unknown>, timestamp: number): void {
  const role = row.role === "assistant" ? "assistant" : row.role === "user" ? "user" : "";
  if (!role || !row.message || typeof row.message !== "object") return;
  pushMessage(draft, role, textOf((row.message as { content?: unknown }).content), timestamp);
}

function applyClaude(draft: Draft, row: Record<string, unknown>, timestamp: number): void {
  if (typeof row.cwd === "string") draft.workspacePath = row.cwd;
  if (row.type !== "user" && row.type !== "assistant") return;
  const message = row.message;
  if (!message || typeof message !== "object") return;
  const role = (message as { role?: unknown }).role === "assistant" ? "assistant" : "user";
  pushMessage(draft, role, textOf((message as { content?: unknown }).content), timestamp);
}

function applyCodex(draft: Draft, row: Record<string, unknown>, timestamp: number): void {
  const payload =
    row.payload && typeof row.payload === "object"
      ? (row.payload as Record<string, unknown>)
      : undefined;
  if (row.type === "session_meta" && payload) {
    if (typeof payload.cwd === "string") draft.workspacePath = payload.cwd;
    return;
  }
  if (row.type === "response_item" && payload?.type === "message") {
    const role = payload.role === "assistant" ? "assistant" : payload.role === "user" ? "user" : "";
    if (role) pushMessage(draft, role, textOf(payload.content), timestamp);
    return;
  }
  if (
    row.type === "response_item" &&
    (payload?.type === "function_call_output" || payload?.type === "custom_tool_call_output")
  ) {
    draft.successfulToolCount += 1;
    return;
  }
  if (row.type === "event_msg" && payload?.type === "item_completed") {
    const item =
      payload.item && typeof payload.item === "object"
        ? (payload.item as Record<string, unknown>)
        : undefined;
    const status = typeof item?.status === "string" ? item.status : "";
    if (status === "completed" || item?.success === true) draft.successfulToolCount += 1;
    if (status === "failed" || status === "error") draft.sawAbort = true;
    return;
  }
  if (row.type === "event_msg" && (payload?.type === "turn_aborted" || payload?.type === "error")) {
    draft.sawAbort = true;
  }
}

function applyKimiContext(draft: Draft, row: Record<string, unknown>, timestamp: number): void {
  const role = row.role === "assistant" ? "assistant" : row.role === "user" ? "user" : "";
  if (role) pushMessage(draft, role, textOf(row.content), timestamp);
  if (row.role === "tool") draft.successfulToolCount += 1;
}

function applyKimiWire(draft: Draft, row: Record<string, unknown>, timestamp: number): void {
  if (row.type === "turn.prompt" && Array.isArray(row.input)) {
    pushMessage(draft, "user", row.input.map(textOf).join("\n"), timestamp);
    return;
  }
  if (row.type === "turn.cancel") {
    draft.sawAbort = true;
    return;
  }
  if (row.type !== "context.append_message" || !row.message || typeof row.message !== "object") {
    return;
  }
  const message = row.message as Record<string, unknown>;
  const role = message.role === "assistant" ? "assistant" : message.role === "user" ? "user" : "";
  if (role) pushMessage(draft, role, textOf(message.content), timestamp);
  if (Array.isArray(message.toolCalls) && message.toolCalls.length > 0) {
    draft.successfulToolCount += 1;
  }
}

async function parseJsonl(
  source: ForeignSessionSource,
  file: string,
  sessionId: string,
  wire: boolean,
): Promise<Draft> {
  const updatedAt = await fileTime(file);
  const draft = emptyDraft(source, sessionId, updatedAt);
  let userAppends = 0;
  let records = 0;
  await forEachJsonLine(file, (row) => {
    records += 1;
    const timestamp = stamp(row.timestamp ?? row.time, draft.updatedAt);
    if (source === "claude") applyClaude(draft, row, timestamp);
    else if (source === "cursor") applyCursorFolder(draft, row, timestamp);
    else if (source === "codex") applyCodex(draft, row, timestamp);
    else if (wire) applyKimiWire(draft, row, timestamp);
    else applyKimiContext(draft, row, timestamp);
    if (wire && row.type === "context.append_message") {
      const message = row.message as { role?: unknown } | undefined;
      if (message?.role === "user") userAppends += 1;
    }
    if (source === "codex" && row.type === "session_meta") {
      const payload = row.payload as { id?: unknown; session_id?: unknown } | undefined;
      const id = payload?.id ?? payload?.session_id;
      if (typeof id === "string" && id.trim()) draft.sessionId = id.trim();
    }
  }, () => records >= RECORD_CAP || draft.messages.length >= MAX_MESSAGES);
  if (wire && userAppends > 0) {
    draft.userTexts = [];
    draft.messages = draft.messages.filter((message) => message.role !== "user");
    await forEachJsonLine(file, (row) => {
      if (row.type !== "context.append_message" || !row.message || typeof row.message !== "object") {
        return;
      }
      const message = row.message as Record<string, unknown>;
      if (message.role !== "user") return;
      pushMessage(draft, "user", textOf(message.content), stamp(row.time, draft.updatedAt));
    });
  }
  if (source === "kimi" && !draft.workspacePath) {
    draft.workspacePath = await kimiWorkspace(file);
  }
  if (source === "cursor") draft.cursorSlug = cursorSlugFromTranscript(file);
  if (draft.workspacePath) draft.workspacePath = canonicalWorkspacePath(draft.workspacePath);
  if (!draft.createdAt) draft.createdAt = draft.updatedAt;
  return draft;
}

function linkSharedProjectPaths(drafts: Draft[]): void {
  const bySlug = new Map<string, string>();
  for (const draft of drafts) {
    if (!draft.workspacePath) continue;
    const slug = cursorProjectSlug(draft.workspacePath);
    if (slug && !bySlug.has(slug)) bySlug.set(slug, draft.workspacePath);
  }
  for (const draft of drafts) {
    if (draft.workspacePath || !draft.cursorSlug) continue;
    const match = bySlug.get(draft.cursorSlug);
    if (match) draft.workspacePath = match;
  }
}

async function kimiWorkspace(file: string): Promise<string> {
  let dir = join(file, "..");
  for (let depth = 0; depth < 6; depth += 1) {
    try {
      const state = JSON.parse(await readFile(join(dir, "state.json"), "utf8")) as {
        workDir?: unknown;
      };
      if (typeof state.workDir === "string") return state.workDir;
      if (state.workDir && typeof state.workDir === "object") {
        const path = (state.workDir as { path?: unknown }).path;
        if (typeof path === "string") return path;
      }
    } catch {
      // 这一层没有 state.json 就继续向会话目录上找。
    }
    const parent = join(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  return "";
}

async function openCursor(): Promise<DatabaseSync | null> {
  const file = join(cursorUserDir(), "globalStorage", "state.vscdb");
  try {
    await stat(file);
  } catch {
    return null;
  }
  const db = new DatabaseSync(file, { readOnly: true, timeout: 250 });
  return db;
}

function fileUriToPath(value: string): string {
  if (!value.startsWith("file:")) return value;
  try {
    const pathname = decodeURIComponent(new URL(value).pathname);
    const stripped = platform() === "win32" ? pathname.replace(/^\//u, "") : pathname;
    return platform() === "win32" ? stripped.replace(/\//g, "\\") : stripped;
  } catch {
    return "";
  }
}

async function loadCursorProjects(): Promise<Map<string, string>> {
  const projects = new Map<string, string>();
  const root = join(cursorUserDir(), "workspaceStorage");
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return projects;
  }
  for (const entry of entries.slice(0, 40)) {
    if (!entry.isDirectory()) continue;
    const dir = join(root, entry.name);
    let folder = "";
    try {
      const raw = await readFile(join(dir, "workspace.json"), "utf8");
      const parsed = JSON.parse(raw) as { folder?: unknown };
      if (typeof parsed.folder === "string") folder = fileUriToPath(parsed.folder);
    } catch {
      folder = "";
    }
    try {
      const db = new DatabaseSync(join(dir, "state.vscdb"), { readOnly: true, timeout: 250 });
      try {
        const row = db
          .prepare("SELECT CAST(value AS TEXT) AS value FROM ItemTable WHERE key = ?")
          .get("composer.composerData") as { value?: string } | undefined;
        const parsed = row?.value ? (JSON.parse(row.value) as { allComposers?: { composerId?: string }[] }) : undefined;
        for (const composer of parsed?.allComposers ?? []) {
          if (composer.composerId && folder) projects.set(composer.composerId, folder);
        }
      } finally {
        db.close();
      }
    } catch {
      // 单个工作区库打不开时继续扫其它目录。
    }
  }
  return projects;
}

async function parseCursor(limit: number): Promise<Draft[]> {
  const db = await openCursor();
  if (!db) return [];
  try {
    const projects = await loadCursorProjects();
    const ids = db
      .prepare(
        `SELECT substr(key, 14) AS id
         FROM cursorDiskKV
         WHERE key LIKE 'composerData:%' AND value IS NOT NULL
         ORDER BY rowid DESC
         LIMIT ?`,
      )
      .all(limit) as { id: string }[];
    const rowById = db.prepare(
      `SELECT json_extract(CAST(value AS TEXT), '$.name') AS name,
              json_extract(CAST(value AS TEXT), '$.lastUpdatedAt') AS updated,
              json_extract(CAST(value AS TEXT), '$.createdAt') AS created,
              json_extract(CAST(value AS TEXT), '$.fullConversationHeadersOnly') AS headers,
              json_extract(CAST(value AS TEXT), '$.conversation') AS conversation
       FROM cursorDiskKV
       WHERE key = ?`,
    );
    const bubble = db.prepare(
      "SELECT CAST(value AS TEXT) AS value FROM cursorDiskKV WHERE key = ? AND value IS NOT NULL AND length(value) <= 262144",
    );
    const bubbleList = db.prepare(
      `SELECT CAST(value AS TEXT) AS value
       FROM cursorDiskKV
       WHERE key LIKE ? AND value IS NOT NULL AND length(value) <= 262144
       LIMIT ${CURSOR_BUBBLES}`,
    );
    const drafts: Draft[] = [];
    // state.vscdb 可以到十几 GB。没有 header 时按 bubble 前缀查找会扫很大的表，
    // 只补前几条，避免拖住 Codex 会话文件夹的扫描。
    let prefixLookups = 0;
    for (const idRow of ids) {
      await yieldToHost();
      if (!idRow.id) continue;
      const row = rowById.get(`composerData:${idRow.id}`) as {
        name: string | null;
        updated: number | null;
        created: number | null;
        headers: string | null;
        conversation: string | null;
      } | undefined;
      if (!row) continue;
      const id = idRow.id;
      const updatedAt = stamp(row.updated, Date.now());
      const draft = emptyDraft("cursor", id, updatedAt);
      draft.createdAt = stamp(row.created, updatedAt);
      draft.title = typeof row.name === "string" ? row.name : "";
      draft.workspacePath = projects.get(id) ?? "";
      let bubbles: { bubbleId?: string; type?: number; text?: string }[] = [];
      if (row.headers) {
        try {
          const headers = JSON.parse(row.headers) as { bubbleId?: string }[];
          bubbles = headers.slice(0, CURSOR_BUBBLES).map((header) => {
            const found = bubble.get(`bubbleId:${id}:${header.bubbleId}`) as
              | { value?: string }
              | undefined;
            if (!found?.value) return { bubbleId: header.bubbleId };
            try {
              return JSON.parse(found.value) as { type?: number; text?: string };
            } catch {
              return { bubbleId: header.bubbleId };
            }
          });
        } catch {
          bubbles = [];
        }
      } else if (row.conversation) {
        try {
          bubbles = (JSON.parse(row.conversation) as { type?: number; text?: string }[]).slice(
            0,
            CURSOR_BUBBLES,
          );
        } catch {
          bubbles = [];
        }
      }
      const consume = (item: { type?: number; text?: string }) => {
        const role = item.type === 1 ? "user" : item.type === 2 ? "assistant" : "";
        if (!role || !item.text) return;
        pushMessage(draft, role, item.text, draft.updatedAt);
      };
      for (const item of bubbles) consume(item);
      if (draft.userTexts.length === 0 && prefixLookups < 12) {
        prefixLookups += 1;
        const listed = bubbleList.all(`bubbleId:${id}:%`) as { value?: string }[];
        for (const entry of listed) {
          if (!entry.value) continue;
          try {
            consume(JSON.parse(entry.value) as { type?: number; text?: string });
          } catch {
            // 坏的 bubble 不影响同一会话的其它记录。
          }
        }
      }
      drafts.push(draft);
    }
    return drafts;
  } finally {
    db.close();
  }
}

async function codexTitleIndex(): Promise<Map<string, { title: string; updatedAt: number }>> {
  const titles = new Map<string, { title: string; updatedAt: number }>();
  const file = join(sourcePath("codex"), "session_index.jsonl");
  try {
    await stat(file);
  } catch {
    return titles;
  }
  await forEachJsonLine(file, (row) => {
    if (typeof row.id !== "string" || !row.id.trim()) return;
    titles.set(row.id.trim(), {
      title: typeof row.thread_name === "string" ? row.thread_name : "",
      updatedAt: stamp(row.updated_at, 0),
    });
  });
  return titles;
}

function listedDraft(
  source: ForeignSessionSource,
  sessionId: string,
  title: string,
  updatedAt: number,
): Draft {
  const draft = emptyDraft(source, sessionId, updatedAt || Date.now());
  draft.title = title;
  draft.inventory = true;
  return draft;
}

async function scanSourceQuick(
  source: ForeignSessionSource,
  cap: number,
  status: ForeignSessionSourceStatus,
): Promise<{ status: ForeignSessionSourceStatus; drafts: Draft[] }> {
  if (source === "codex") {
    const [files, titles] = await Promise.all([collectCodex(cap), codexTitleIndex()]);
    const drafts: Draft[] = [];
    for (const file of files) {
      await yieldToHost();
      const id = basename(file).match(FILE_UUID)?.[0] ?? sessionIdFromFile(file);
      const known = titles.get(id);
      drafts.push(listedDraft(source, id, known?.title ?? "", known?.updatedAt || (await fileTime(file))));
    }
    return { status, drafts };
  }
  if (source === "cursor") {
    const files = await collectCursorFolders(cap);
    const drafts: Draft[] = [];
    for (const file of files) {
      await yieldToHost();
      drafts.push(listedDraft(source, cursorFolderSessionId(file), "", await fileTime(file)));
    }
    return { status, drafts };
  }
  if (source === "kimi") {
    const files = await collectKimi(cap);
    const drafts: Draft[] = [];
    for (const item of files) {
      await yieldToHost();
      drafts.push(listedDraft(source, kimiSessionId(item.file), "", await fileTime(item.file)));
    }
    return { status, drafts };
  }
  const files = await collectClaude(cap);
  const drafts: Draft[] = [];
  for (const file of files) {
    await yieldToHost();
    drafts.push(listedDraft(source, sessionIdFromFile(file), "", await fileTime(file)));
  }
  return { status, drafts };
}

async function scanSource(
  source: ForeignSessionSource,
  cap: number,
  quick = false,
): Promise<{ status: ForeignSessionSourceStatus; drafts: Draft[] }> {
  const path = sourcePath(source);
  let available = false;
  try {
    available = (await stat(path)).isDirectory();
  } catch {
    available = false;
  }
  if (source === "kimi") {
    try {
      available = available || (await stat(join(home(), ".kimi-code", "sessions"))).isDirectory();
    } catch {
      // ~/.kimi-code 不存在时保留 ~/.kimi 的结果。
    }
  }
  if (source === "cursor") {
    let folder = false;
    try {
      folder = (await stat(join(home(), ".cursor", "projects"))).isDirectory();
    } catch {
      folder = false;
    }
    try {
      available = (await stat(join(path, "globalStorage", "state.vscdb"))).isFile();
    } catch {
      available = false;
    }
    available = available || folder;
  }
  const status: ForeignSessionSourceStatus = { source, path, available };
  if (!available) return { status, drafts: [] };
  if (quick) return scanSourceQuick(source, cap, status);
  try {
    if (source === "cursor") {
      const fromDatabase = await parseCursor(Math.min(cap, CURSOR_CAP));
      const files = await collectCursorFolders(cap);
      const fromFolders = await mapPool(files, 8, (file) =>
        parseJsonl("cursor", file, cursorFolderSessionId(file), false),
      );
      return { status, drafts: [...fromDatabase, ...fromFolders] };
    }
    if (source === "codex") {
      const [files, titles] = await Promise.all([collectCodex(cap), codexTitleIndex()]);
      const drafts = await mapPool(files, 8, async (file) => {
        const filenameId = basename(file).match(FILE_UUID)?.[0] ?? sessionIdFromFile(file);
        const draft = await parseJsonl(source, file, filenameId, false);
        const known = titles.get(draft.sessionId) ?? titles.get(filenameId);
        if (known?.title.trim()) draft.title = known.title.trim();
        return draft;
      });
      return { status, drafts };
    }
    if (source === "kimi") {
      const files = await collectKimi(cap);
      const drafts = await Promise.all(
        files.map((item) => parseJsonl("kimi", item.file, kimiSessionId(item.file), item.wire)),
      );
      return { status, drafts };
    }
    const files = await collectClaude(cap);
    const drafts = await Promise.all(
      files.map((file) => parseJsonl(source, file, sessionIdFromFile(file), false)),
    );
    return { status, drafts };
  } catch (error) {
    status.error = error instanceof Error ? error.message : String(error);
    return { status, drafts: [] };
  }
}

function dedupe(drafts: Draft[]): Draft[] {
  const byId = new Map<string, Draft>();
  for (const draft of drafts) {
    const key = `${draft.source}:${draft.sessionId}`;
    const previous = byId.get(key);
    if (!previous) {
      byId.set(key, draft);
      continue;
    }
    const previousText = previous.messages.length + previous.userTexts.length;
    const nextText = draft.messages.length + draft.userTexts.length;
    if (previousText === 0 && nextText > 0) byId.set(key, draft);
    else if (nextText > 0 && draft.updatedAt >= previous.updatedAt) byId.set(key, draft);
    else if (nextText === 0 && previousText === 0 && draft.updatedAt >= previous.updatedAt) {
      byId.set(key, draft);
    }
  }
  return [...byId.values()].sort((left, right) => right.updatedAt - left.updatedAt);
}

export async function scanForeignSessions(
  input: ForeignSessionScanInput = {},
): Promise<ForeignSessionScanResult> {
  const selected = (input.sources?.length ? input.sources : SOURCES).filter((source) =>
    SOURCES.includes(source),
  );
  const cap = limitOf(input.limit);
  const scanned = await Promise.all(
    selected.map((source) => scanSource(source, cap, input.quick === true)),
  );
  const drafts = scanned.flatMap((item) => item.drafts);
  linkSharedProjectPaths(drafts);
  const sessions = dedupe(drafts).slice(0, cap).map(previewOf);
  return { sources: scanned.map((item) => item.status), sessions };
}

export async function readForeignSessions(
  selections: ForeignSessionSelection[],
): Promise<(ForeignSessionTranscript | null)[]> {
  const wanted = new Map<string, ForeignSessionSelection>();
  for (const selection of selections) {
    if (!SOURCES.includes(selection.source) || !selection.sessionId.trim()) continue;
    wanted.set(`${selection.source}:${selection.sessionId}`, selection);
  }
  const found = new Map<string, ForeignSessionTranscript>();
  const sources = [...new Set([...wanted.values()].map((item) => item.source))];
  // Cursor 文件没有 cwd。只读 Cursor 时也要带上其它来源的目录，才能并进同一个项目。
  const linkSources = sources.includes("cursor")
    ? [...new Set([...sources, ...SOURCES.filter((source) => source !== "cursor")])]
    : sources;
  const scanned = await Promise.all(linkSources.map((source) => scanSource(source, MAX_LIMIT)));
  const drafts = scanned.flatMap((item) => item.drafts);
  // 不同来源的同一目录要在读正文之后对齐，Cursor 才能落到 Claude/Codex 的项目上。
  linkSharedProjectPaths(drafts);
  for (const draft of dedupe(drafts)) {
    const key = `${draft.source}:${draft.sessionId}`;
    if (!wanted.has(key)) continue;
    const transcript = transcriptOf(draft);
    if (transcript.messages.length === 0) continue;
    found.set(key, transcript);
  }
  return selections.map(
    (selection) => found.get(`${selection.source}:${selection.sessionId}`) ?? null,
  );
}

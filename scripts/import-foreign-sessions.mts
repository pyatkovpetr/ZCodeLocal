/**
 * Проверяет разбор чужих сессий и, с --apply, дописывает ещё не импортированные.
 * Уже лежащие в своей папке не трогает. В вывод попадают только счётчики и короткие id.
 */
import { writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { classifyForeignTranscript } from "../packages/services/src/foreign-session-import/classify.mjs";
import { canonicalWorkspacePath } from "../packages/services/src/foreign-session-import/sessionFiles.ts";
import {
  readForeignSessions,
  scanForeignSessions,
} from "../packages/services/src/foreign-session-import/scan.ts";

const SELECTION_PATH = process.env.ZCODE_FOREIGN_IMPORT_SELECTION ?? "";
const TASK_INDEX = process.env.ZCODE_TASK_INDEX ?? "";
const SESSION_DB = process.env.ZCODE_SESSION_DB ?? "";
const WORKSPACE = process.env.ZCODE_IMPORT_WORKSPACE ?? "";

const MARKERS = ["<environment_context", "<cwd>", "<user_query", "<timestamp"];

function badText(value: string): boolean {
  const text = value.trim().toLowerCase();
  return MARKERS.some((marker) => text.startsWith(marker));
}

interface Selection {
  source: "claude" | "codex" | "kimi" | "cursor";
  sessionId: string;
}

function pathKey(value: string): string {
  return canonicalWorkspacePath(value).toLowerCase();
}

function alreadyImportedKeys(): Set<string> {
  const db = new DatabaseSync(SESSION_DB, { readOnly: true, timeout: 3000 });
  try {
    const rows = db
      .prepare(
        `SELECT directory, title, time_created FROM session
         WHERE time_deleted IS NULL
           AND id IN (
             SELECT session_id FROM message
             WHERE json_extract(data, '$.metadata.migrationSource') IN ('claudeCode','codex','kimi','cursor')
           )`,
      )
      .all() as { directory: string; title: string; time_created: number | null }[];
    return new Set(
      rows.map((row) => `${pathKey(row.directory)}|${row.title}|${Math.max(0, Math.round(row.time_created ?? 0))}`),
    );
  } finally {
    db.close();
  }
}

async function check(): Promise<{ importable: Selection[]; failed: number }> {
  const present = alreadyImportedKeys();
  const listed = await scanForeignSessions({ quick: true, limit: 5000 });
  const bodies = await readForeignSessions(
    listed.sessions.map((session) => ({ source: session.source, sessionId: session.sessionId })),
  );
  const counts = {
    listed: listed.sessions.length,
    parsed: 0,
    empty: 0,
    importable: 0,
    already: 0,
    badTitle: 0,
    badMessage: 0,
    userOnly: 0,
    bySource: {} as Record<string, number>,
  };
  const failures: { id: string; source: string; reason: string }[] = [];
  const importable: Selection[] = [];
  for (const [index, transcript] of bodies.entries()) {
    const listedSession = listed.sessions[index];
    if (!listedSession) continue;
    if (!transcript || transcript.messages.length === 0) {
      counts.empty += 1;
      continue;
    }
    counts.parsed += 1;
    const userTexts = transcript.messages
      .filter((message) => message.role === "user")
      .map((message) => message.content);
    const assistantTexts = transcript.messages
      .filter((message) => message.role === "assistant")
      .map((message) => message.content);
    const verdict = classifyForeignTranscript({
      userTexts,
      assistantTexts,
      successfulToolCount: 0,
      sawAbort: false,
    });
    const titleBad =
      badText(transcript.title) ||
      transcript.title.trim().toLowerCase() === "guardian review" ||
      (transcript.title === "Imported session" && userTexts.some((text) => text.trim().length >= 8));
    const messageBad = transcript.messages.some(
      (message) =>
        badText(message.content) ||
        message.content.includes("questionItemId") ||
        message.content.includes('"risk_level"'),
    );
    if (titleBad) {
      counts.badTitle += 1;
      failures.push({ id: transcript.sessionId.slice(0, 8), source: transcript.source, reason: "bad_title" });
    }
    if (messageBad) {
      counts.badMessage += 1;
      failures.push({ id: transcript.sessionId.slice(0, 8), source: transcript.source, reason: "bad_message" });
    }
    if (titleBad || messageBad) continue;
    if (
      present.has(
        `${pathKey(transcript.workspacePath)}|${transcript.title}|${Math.max(0, Math.round(transcript.createdAt))}`,
      )
    ) {
      counts.already += 1;
      continue;
    }
    if (verdict.verdict !== "useful" || assistantTexts.length === 0) {
      counts.userOnly += 1;
      continue;
    }
    counts.importable += 1;
    counts.bySource[transcript.source] = (counts.bySource[transcript.source] ?? 0) + 1;
    importable.push({ source: transcript.source, sessionId: transcript.sessionId });
  }
  console.log(JSON.stringify({ counts, failureSample: failures.slice(0, 20), failureCount: failures.length }));
  await writeFile(SELECTION_PATH, JSON.stringify(importable), "utf8");
  return { importable, failed: failures.length };
}

function storedShape(since: number): {
  total: number;
  badTitles: number;
  badBodies: number;
  singleMessage: number;
} {
  const db = new DatabaseSync(SESSION_DB, { readOnly: true, timeout: 2000 });
  try {
    const row = db
      .prepare(
        `SELECT
           COUNT(*) AS total,
           SUM(CASE WHEN title LIKE '%<environment_context>%' OR title LIKE '%<cwd>%' OR title LIKE '%<user_query%' THEN 1 ELSE 0 END) AS bad_titles,
           SUM(CASE WHEN IFNULL(first_text, '') LIKE '%<environment_context%' OR IFNULL(first_text, '') LIKE '<cwd>%' THEN 1 ELSE 0 END) AS bad_bodies,
           SUM(CASE WHEN messages < 2 THEN 1 ELSE 0 END) AS single_message
         FROM (
           SELECT
             s.title AS title,
             (SELECT COUNT(*) FROM message m WHERE m.session_id = s.id) AS messages,
             (SELECT json_extract(p.data, '$.text') FROM part p WHERE p.session_id = s.id ORDER BY p.sequence LIMIT 1) AS first_text
           FROM session s
           WHERE s.time_deleted IS NULL AND s.time_created >= ?
         )`,
      )
      .get(since) as {
      total: number;
      bad_titles: number | null;
      bad_bodies: number | null;
      single_message: number | null;
    };
    return {
      total: row.total,
      badTitles: row.bad_titles ?? 0,
      badBodies: row.bad_bodies ?? 0,
      singleMessage: row.single_message ?? 0,
    };
  } finally {
    db.close();
  }
}

async function evaluatePage<T>(expression: string): Promise<T> {
  const list = (await fetch("http://127.0.0.1:9229/json/list").then((response) => response.json())) as {
    type?: string;
    url?: string;
    webSocketDebuggerUrl?: string;
  }[];
  const page = list.find((item) => item.type === "page" && String(item.url).includes("5174"));
  if (!page?.webSocketDebuggerUrl) throw new Error("page_missing");
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let nextId = 0;
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  ws.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data)) as {
      id?: number;
      result?: { result?: { value?: T }; exceptionDetails?: { text?: string } };
      error?: { message?: string };
    };
    if (!message.id || !pending.has(message.id)) return;
    const waiter = pending.get(message.id);
    pending.delete(message.id);
    if (!waiter) return;
    if (message.error) waiter.reject(new Error(message.error.message ?? "cdp_error"));
    else if (message.result?.exceptionDetails) waiter.reject(new Error("page_exception"));
    else waiter.resolve(message.result?.result?.value);
  });
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve());
    ws.addEventListener("error", () => reject(new Error("cdp_socket")));
  });
  const id = ++nextId;
  const value = await new Promise<unknown>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws.send(
      JSON.stringify({
        id,
        method: "Runtime.evaluate",
        params: { expression, awaitPromise: true, returnByValue: true, timeout: 1800000 },
      }),
    );
  });
  ws.close();
  return value as T;
}

async function applyImport(selection: Selection[]): Promise<void> {
  const startedAt = Date.now();
  console.log(JSON.stringify({ importable: selection.length }));
  const expression = `(() => {
    const payload = ${JSON.stringify({ selection, workspacePath: WORKSPACE })};
    const root = document.querySelector("#root");
    const key = root ? Object.keys(root).find((name) => name.startsWith("__reactContainer")) : "";
    const container = key ? root[key] : null;
    const stack = [];
    const seen = new Set();
    if (container && container.child) stack.push(container);
    let service = null;
    while (stack.length) {
      const node = stack.pop();
      if (!node || seen.has(node)) continue;
      seen.add(node);
      const services = node.memoizedProps && node.memoizedProps.services;
      if (services && services.zcodeTaskService && services.zcodeTaskService.importForeignSessions) {
        service = services.zcodeTaskService;
        break;
      }
      if (node.child) stack.push(node.child);
      if (node.sibling) stack.push(node.sibling);
    }
    if (!service) return { ok: false, reason: "service_missing" };
    return (async () => {
      const result = await service.importForeignSessions({
        workspacePath: payload.workspacePath,
        sessions: payload.selection,
      });
      return {
        ok: true,
        imported: result.imported.length,
        failed: result.failed.length,
        skipped: result.skipped.length,
      };
    })();
  })()`;
  const result = await evaluatePage<Record<string, unknown>>(expression);
  console.log(JSON.stringify({ apply: result }));
  const db = new DatabaseSync(TASK_INDEX, { readOnly: true, timeout: 2000 });
  const leftover = db
    .prepare(
      `SELECT COUNT(*) AS n FROM tasks WHERE deleted = 0 AND (title LIKE '<environment_context>%' OR cli_title LIKE '<environment_context>%')`,
    )
    .get() as { n: number };
  db.close();
  console.log(JSON.stringify({ stored: storedShape(startedAt), leftoverEnvTitles: leftover.n }));
}

async function main(): Promise<void> {
  if (!SELECTION_PATH || !TASK_INDEX || !SESSION_DB || !WORKSPACE) {
    console.error("missing_import_paths");
    process.exit(1);
  }
  const apply = process.argv.includes("--apply");
  const { importable, failed } = await check();
  if (!apply) {
    process.exit(failed > 0 ? 1 : 0);
  }
  if (importable.length === 0) {
    console.log(JSON.stringify({ apply: "skipped", reason: "nothing_clean", failed }));
    process.exit(1);
  }
  await applyImport(importable);
}

const invoked = process.argv[1]?.replaceAll("\\", "/").endsWith("import-foreign-sessions.mts");
if (invoked) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.name : "error";
    console.error(message);
    process.exit(1);
  });
}

export { storedShape };

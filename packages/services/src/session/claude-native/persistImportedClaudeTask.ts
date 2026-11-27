import { existsSync, readFileSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ZCodeSessionFile, ZCodeSessionImportHistory } from "@zcode/shared";
import {
  getLegacyDeletedTaskSessionSnapshotPath,
  getLegacyTaskSessionSnapshotPath,
} from "#src/paths.js";
import {
  parseLegacyTaskSessionFile,
  safeParseLegacyTaskSessionFile,
  type LegacyTaskSessionFile,
} from "#src/session/legacyTaskSessionFile.js";

const TASK_SEARCH_TEXT_MAX_CHARS = 200_000;

export function buildSearchableTextFromMessages(messages: ZCodeSessionFile["messages"]): string {
  const parts: string[] = [];
  let total = 0;
  for (const message of messages) {
    const content = message.content.trim();
    if (!content) {
      continue;
    }
    const next = total > 0 ? `\n${content}` : content;
    if (total + next.length > TASK_SEARCH_TEXT_MAX_CHARS) {
      parts.push(next.slice(0, TASK_SEARCH_TEXT_MAX_CHARS - total));
      break;
    }
    parts.push(next);
    total += next.length;
  }
  return parts.join("");
}

async function writeSessionFileAtomic(
  filePath: string,
  sessionFile: LegacyTaskSessionFile,
): Promise<void> {
  const tempPath = `${filePath}.${process.pid}.${Date.now().toString(36)}.${Math.random()
    .toString(36)
    .slice(2, 8)}.tmp`;
  const serialized = JSON.stringify(sessionFile, null, 2);
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(tempPath, `${serialized}\n`, "utf-8");
  await rename(tempPath, filePath);
}

export async function writeImportedClaudeTaskSnapshot(params: {
  sessionFile: LegacyTaskSessionFile;
}): Promise<void> {
  const parsed = parseLegacyTaskSessionFile(params.sessionFile);
  const filePath = getLegacyTaskSessionSnapshotPath(
    parsed.meta.workspacePath,
    parsed.meta.taskId,
    parsed.meta.workspaceIdentity,
  );

  // legacy ACP 下线后 importClaudeSessions 变成空桩，导入虽复制了 jsonl 却没有写
  // ~/.zcode/v2/sessions/{hash}/{taskId}.json。现在真实 ZCode session 承担续聊，legacy snapshot
  // 只保存过滤后的迁移备份，避免 Claude 来源运行态污染当前模型选择。
  await writeSessionFileAtomic(filePath, parsed);
}

const IMPORTED_HISTORY_SOURCES = new Set(["claudeCode", "codex", "kimi", "cursor"]);

function wholeTimestamp(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.round(value))
    : undefined;
}

/** История импорта из legacy snapshot. Нет файла или это не импорт — null. */
export function readLegacyImportedSessionHistory(params: {
  workspacePath: string;
  workspaceIdentity?: string;
  taskId: string;
}): ZCodeSessionImportHistory | null {
  const snapshotPath = [
    getLegacyTaskSessionSnapshotPath(
      params.workspacePath,
      params.taskId,
      params.workspaceIdentity,
    ),
    getLegacyDeletedTaskSessionSnapshotPath(
      params.workspacePath,
      params.taskId,
      params.workspaceIdentity,
    ),
  ].find((path) => existsSync(path));
  if (!snapshotPath) return null;
  let parsed: ReturnType<typeof safeParseLegacyTaskSessionFile>;
  try {
    parsed = safeParseLegacyTaskSessionFile(JSON.parse(readFileSync(snapshotPath, "utf-8")));
  } catch {
    return null;
  }
  if (!parsed.success || parsed.data.messages.length === 0) return null;
  const source = parsed.data.meta.migrationSource;
  if (!source || !IMPORTED_HISTORY_SOURCES.has(source)) return null;
  const title = parsed.data.meta.title?.trim() || "Imported session";
  return {
    source: source as "claudeCode" | "codex" | "kimi" | "cursor",
    title,
    createdAt: wholeTimestamp(parsed.data.meta.createdAt),
    updatedAt: wholeTimestamp(parsed.data.meta.updatedAt),
    messages: parsed.data.messages.map((message) => ({
      role: message.role,
      content: message.content,
      timestamp: wholeTimestamp(message.timestamp),
    })),
  };
}

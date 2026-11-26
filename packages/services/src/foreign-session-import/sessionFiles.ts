/**
 * 只读发现 Claude / Codex / Kimi / Cursor 的会话文件，并按行读 jsonl。
 * 超长工具输出行跳过，不因此停掉后面的真实对话。
 */
import { createReadStream, realpathSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import { homedir, platform } from "node:os";
import { basename, join, normalize, resolve } from "node:path";
import { createZstdDecompress } from "node:zlib";

import type { ForeignSessionSource } from "./contract.js";

const DISCOVER_CAP = 5000;
const LINE_PARSE_CAP = 8_000_000;

export function canonicalWorkspacePath(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return "";
  try {
    return realpathSync.native(trimmed);
  } catch {
    return normalize(resolve(trimmed)).replace(/[\\/]+$/u, "");
  }
}

export function cursorProjectSlug(directory: string): string {
  const canonical = directory.replace(/\//g, "\\");
  const match = /^([A-Za-z]):\\(.*)$/u.exec(canonical);
  if (!match?.[1] || match[2] === undefined) return "";
  return `${match[1].toLowerCase()}-${match[2].replace(/[\\_]/g, "-")}`;
}

export function cursorSlugFromTranscript(file: string): string {
  const parts = file.split(/[\\/]/u);
  const index = parts.lastIndexOf("agent-transcripts");
  return index > 0 ? (parts[index - 1] ?? "") : "";
}

export function home(): string {
  return homedir();
}

export function cursorUserDir(): string {
  if (platform() === "win32") {
    return join(process.env.APPDATA ?? "", "Cursor", "User");
  }
  if (platform() === "darwin") {
    return join(home(), "Library", "Application Support", "Cursor", "User");
  }
  return join(home(), ".config", "Cursor", "User");
}

export function sourcePath(source: ForeignSessionSource): string {
  if (source === "claude") {
    return join(process.env.CLAUDE_CONFIG_DIR || join(home(), ".claude"), "projects");
  }
  if (source === "codex") return process.env.CODEX_HOME || join(home(), ".codex");
  if (source === "cursor") return cursorUserDir();
  return join(home(), ".kimi");
}

// 以前按解压后的总字符数停。工具输出一行就能超过预算，读取停在
// <environment_context> 后面，真实用户话和助手答复都进不了会话。
export async function forEachJsonLine(
  file: string,
  onLine: (value: Record<string, unknown>) => void,
  shouldStop?: () => boolean,
): Promise<void> {
  const input = createReadStream(file);
  const stream = file.endsWith(".zst") ? input.pipe(createZstdDecompress()) : input;
  input.on("error", () => {});
  if (stream !== input) stream.on("error", () => {});
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (shouldStop?.()) break;
      if (!line.trim() || line.length > LINE_PARSE_CAP) continue;
      try {
        const value = JSON.parse(line) as unknown;
        if (value && typeof value === "object" && !Array.isArray(value)) {
          onLine(value as Record<string, unknown>);
        }
      } catch {
        // 坏行跳过，不让一个记录挡住整份会话。
      }
    }
  } catch {
    // 提前关掉解压流，或单个文件损坏：已经读到的行仍然参与分类。
  } finally {
    lines.close();
    stream.destroy();
    input.destroy();
  }
}

export async function fileTime(file: string): Promise<number> {
  try {
    return (await stat(file)).mtimeMs;
  } catch {
    return 0;
  }
}

async function walkFiles(
  root: string,
  depth: number,
  accept: (name: string) => boolean,
  out: string[],
  cap: number,
): Promise<void> {
  if (depth < 0 || out.length >= cap) return;
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (out.length >= cap) return;
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const child = join(root, entry.name);
    if (entry.isDirectory()) {
      await walkFiles(child, depth - 1, accept, out, cap);
    } else if (entry.isFile() && accept(entry.name)) {
      out.push(child);
    }
  }
}

async function newestFiles(files: string[], cap: number): Promise<string[]> {
  const stamped = await Promise.all(
    files.map(async (file) => ({ file, time: await fileTime(file) })),
  );
  return stamped
    .sort((left, right) => right.time - left.time)
    .slice(0, cap)
    .map((item) => item.file);
}

export function sessionIdFromFile(file: string): string {
  return basename(file).replace(/\.jsonl\.zst$/u, "").replace(/\.jsonl$/u, "").replace(/\.zst$/u, "");
}

export function cursorFolderSessionId(file: string): string {
  const name = sessionIdFromFile(file);
  const parent = basename(join(file, ".."));
  if (parent === name) return name;
  return `${basename(join(file, "..", ".."))}/${parent}/${name}`;
}

export function kimiSessionId(file: string): string {
  const parent = basename(join(file, ".."));
  return parent.replace(/^ses_/u, "") || sessionIdFromFile(file);
}

export async function collectClaude(cap: number): Promise<string[]> {
  const files: string[] = [];
  await walkFiles(sourcePath("claude"), 8, (name) => name.endsWith(".jsonl"), files, DISCOVER_CAP);
  return newestFiles(files, cap);
}

export async function collectCodex(cap: number): Promise<string[]> {
  const root = sourcePath("codex");
  const files: string[] = [];
  const isSessionFile = (name: string) => name.endsWith(".jsonl") || name.endsWith(".zst");
  await walkFiles(join(root, "sessions"), 8, isSessionFile, files, DISCOVER_CAP);
  await walkFiles(join(root, "archived_sessions"), 8, isSessionFile, files, DISCOVER_CAP);
  return newestFiles(files, cap);
}

export async function collectCursorFolders(cap: number): Promise<string[]> {
  const files: string[] = [];
  await walkFiles(
    join(home(), ".cursor", "projects"),
    8,
    (name) => name.endsWith(".jsonl"),
    files,
    DISCOVER_CAP,
  );
  return newestFiles(files, cap);
}

export async function collectKimi(cap: number): Promise<{ file: string; wire: boolean }[]> {
  const found: string[] = [];
  for (const root of [join(home(), ".kimi"), join(home(), ".kimi-code")]) {
    await walkFiles(
      join(root, "sessions"),
      8,
      (name) => name === "context.jsonl" || name === "wire.jsonl",
      found,
      DISCOVER_CAP,
    );
  }
  const contextDirs = new Set(
    found.filter((file) => basename(file) === "context.jsonl").map((file) => join(file, "..")),
  );
  const kept = found.filter(
    (file) => basename(file) === "context.jsonl" || !contextDirs.has(join(file, "..")),
  );
  const newest = await newestFiles(kept, cap);
  return newest.map((file) => ({ file, wire: basename(file) === "wire.jsonl" }));
}

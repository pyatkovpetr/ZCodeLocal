/**
 * 标准调用：先只读扫描，再按用户勾选的 id 读取正文。落盘由调用方交给 CLI。
 */
import type { ForeignSessionImportContract } from "./contract.js";

export async function exampleForeignSessionImport(
  contract: ForeignSessionImportContract,
): Promise<void> {
  const scan = await contract.scan({ sources: ["claude", "codex", "kimi", "cursor"], limit: 60 });
  const selected = scan.sessions
    .filter((session) => session.verdict === "useful")
    .map((session) => ({ source: session.source, sessionId: session.sessionId }));
  await contract.read(selected);
}

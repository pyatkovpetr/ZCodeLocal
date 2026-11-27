import { ZCODE_AGENT_PROVIDER, type ZCodeTaskMeta } from "@zcode/shared";
import type { ForeignSessionTranscript } from "#src/foreign-session-import/contract.js";
import {
  buildForeignImportedTaskId,
  buildImportedClaudeTaskFile,
} from "#src/session/claude-native/buildImportedClaudeTaskFile.js";
import {
  buildSearchableTextFromMessages,
  writeImportedClaudeTaskSnapshot,
} from "#src/session/claude-native/persistImportedClaudeTask.js";
import type { ProjectRepositoryContract } from "#src/project-storage/contract.js";
import type { TaskIndexRepo } from "#src/session/taskIndexRepo.js";

function wholeTimestamp(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.round(value))
    : fallback;
}

/**
 * Импорт внешней сессии без ZCode Agent: CLI-факты, legacy snapshot, проект.
 * Открытие чата позже поднимает protocol session из этого snapshot.
 */
export async function persistForeignSessionImport(params: {
  taskIndexRepo: TaskIndexRepo;
  getProjectRepository: () => Promise<ProjectRepositoryContract>;
  transcript: ForeignSessionTranscript;
  workspacePath: string;
  workspaceIdentity?: string;
  migrationSource: NonNullable<ZCodeTaskMeta["migrationSource"]>;
  linkedProjectId?: string;
}): Promise<ZCodeTaskMeta> {
  const taskId = buildForeignImportedTaskId(
    params.transcript.source,
    params.workspacePath,
    params.transcript.sessionId,
  );
  const now = Date.now();
  const createdAt = wholeTimestamp(params.transcript.createdAt, now);
  const updatedAt = wholeTimestamp(params.transcript.updatedAt, Math.max(createdAt, now));

  const sessionFile = buildImportedClaudeTaskFile(
    {
      provider: params.transcript.source,
      sessionId: params.transcript.sessionId,
      workspacePath: params.workspacePath,
      sourcePath: "",
      createdAt,
      updatedAt,
      title: params.transcript.title,
      migrationSource: params.migrationSource,
      messages: params.transcript.messages,
    },
    undefined,
    taskId,
  );

  const meta = await params.taskIndexRepo.applyCliFacts({
    meta: {
      ...sessionFile.meta,
      workspacePath: params.workspacePath,
      ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
      mode: sessionFile.meta.mode ?? "default",
      provider: ZCODE_AGENT_PROVIDER,
      migrationSource: params.migrationSource,
      status: "completed",
    },
    titleSource: "default",
    lastOutcome: "completed",
  });

  await writeImportedClaudeTaskSnapshot({
    sessionFile: {
      ...sessionFile,
      meta: {
        ...sessionFile.meta,
        ...meta,
        ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
      },
    },
  });

  const indexed = await params.taskIndexRepo.updateTaskPresentation({
    workspacePath: meta.workspacePath,
    workspaceIdentity: meta.workspaceIdentity,
    taskId: meta.taskId,
    presentation: { migrationSource: params.migrationSource },
    searchableText: buildSearchableTextFromMessages(sessionFile.messages),
  });
  const finalMeta = indexed ?? meta;
  await params.taskIndexRepo.updateTaskState({
    workspacePath: finalMeta.workspacePath,
    workspaceIdentity: finalMeta.workspaceIdentity,
    taskId: finalMeta.taskId,
    patch: { archived: false },
  });

  if (params.linkedProjectId) {
    try {
      const repository = await params.getProjectRepository();
      repository.moveTask({
        task: {
          taskId: finalMeta.taskId,
          workspacePath: finalMeta.workspacePath,
          ...(finalMeta.workspaceIdentity ? { workspaceIdentity: finalMeta.workspaceIdentity } : {}),
        },
        projectId: params.linkedProjectId,
        addMissingRoot: true,
      });
    } catch {
      // uniqueRootProject уже мог назначить проект; move — уточнение привязки.
    }
  }

  return finalMeta;
}

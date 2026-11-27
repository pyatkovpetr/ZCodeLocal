/**
 * 外部会话导入契约。
 * scan 只读，不落盘，对同一批文件重复调用结果只随文件内容变化。
 * read 按来源和会话 id 重新读取正文，找不到返回 null，也不落盘。
 * Индексация импорта — persistForeignSessionImport (без agent); scan/read только читают источники.
 */
export type ForeignSessionSource = "claude" | "codex" | "kimi" | "cursor";
export type ForeignSessionVerdict = "useful" | "useless";

export interface ForeignSessionScanInput {
  sources?: ForeignSessionSource[];
  limit?: number;
  /** 只按文件名和索引出列表，不读正文。界面先用它显示数量。 */
  quick?: boolean;
}

export interface ForeignSessionSourceStatus {
  source: ForeignSessionSource;
  path: string;
  available: boolean;
  error?: string;
}

export interface ForeignSessionPreview {
  source: ForeignSessionSource;
  sessionId: string;
  workspacePath: string;
  title: string;
  updatedAt: number;
  verdict: ForeignSessionVerdict;
  reasons: string[];
}

export interface ForeignSessionScanResult {
  sources: ForeignSessionSourceStatus[];
  sessions: ForeignSessionPreview[];
}

export interface ForeignSessionSelection {
  source: ForeignSessionSource;
  sessionId: string;
}

export interface ForeignSessionTranscript {
  source: ForeignSessionSource;
  sessionId: string;
  workspacePath: string;
  /** Cursor 个人目录名。导入用它把会话归到已有的真实项目路径。 */
  cursorSlug?: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: { role: "user" | "assistant"; content: string; timestamp: number }[];
}

export interface ForeignSessionImportContract {
  scan(input?: ForeignSessionScanInput): Promise<ForeignSessionScanResult>;
  read(selections: ForeignSessionSelection[]): Promise<(ForeignSessionTranscript | null)[]>;
}

/* eslint-disable max-lines -- 会话导入向导和原有 Claude 迁移放在同一设置页，避免再拆一个未登记的 UI 文件。 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { LoaderCircle, RefreshCcw, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card.js";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert.js";
import { Checkbox } from "@/components/ui/checkbox.js";
import { Input } from "@/components/ui/input.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { useClaudeSessionMigration } from "@/hooks/useClaudeSessionMigration.js";
import { useZCodeTaskService } from "@/hooks/useZCodeTaskService.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import { MigrationCandidatesCard } from "@/settings/MigrationCandidatesCard.js";
import { invalidateTaskQueryCacheByScopes } from "@/store/taskQueryCacheStore.js";
import type {
  ZCodeForeignSessionScanResult,
  ZCodeForeignSessionSource,
  ZCodeImportSessionsResult,
} from "@zcode/shared";

const RANGE_OPTIONS = ["7d", "30d", "90d", "all"] as const;
const WORKSPACE_FILTER_OPTIONS = ["all", "current"] as const;

export function MigrationSection({
  workspacePath,
  workspaceIdentity,
  isDesktop,
}: {
  workspacePath: string | null;
  workspaceIdentity?: string;
  isDesktop?: boolean;
}) {
  const { intl, locale } = useZCodeIntl();
  const {
    supportState,
    workspaceFilterMode,
    setWorkspaceFilterMode,
    hasCurrentWorkspaceFilter,
    range,
    setRange,
    limitInput,
    setLimitInput,
    scanLimit,
    candidates,
    selectedSessionIds,
    selectedCount,
    scanError,
    importError,
    lastImportResult,
    isScanning,
    isImporting,
    scan,
    importSelectedSessions,
    toggleSessionSelection,
    selectAllSessions,
    clearSelectedSessions,
  } = useClaudeSessionMigration({
    workspacePath,
    workspaceIdentity,
    isDesktop,
  });

  const dateTimeFormatter = useMemo(
    () =>
      new Intl.DateTimeFormat(locale, {
        dateStyle: "medium",
        timeStyle: "short",
      }),
    [locale],
  );

  const unsupportedDescription =
    supportState.reason === "desktopOnly"
      ? intl.formatMessage({ id: "settings.migration.unsupported.desktopOnly" })
      : null;

  return (
    <div className="space-y-6">
      <ForeignSessionImportCard
        workspacePath={workspacePath}
        workspaceIdentity={workspaceIdentity}
        supported={supportState.supported}
      />
      <Card className="border border-border bg-card py-0 shadow-none">
        <CardHeader className="border-b border-border">
          <CardAction>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={!supportState.supported || isScanning}
              onClick={() => {
                void scan();
              }}
            >
              {isScanning ? (
                <LoaderCircle className="size-3.5 animate-spin" />
              ) : (
                <RefreshCcw className="size-3.5" />
              )}
              {intl.formatMessage({ id: "settings.migration.scan" })}
            </Button>
          </CardAction>
          <div className="space-y-1">
            <CardTitle>{intl.formatMessage({ id: "settings.migration.filtersTitle" })}</CardTitle>
            <CardDescription>
              {intl.formatMessage({ id: "settings.migration.filtersDescription" })}
            </CardDescription>
          </div>
        </CardHeader>
        <CardContent className="space-y-4 px-4 py-4">
          {!supportState.supported ? (
            <Alert>
              <TriangleAlert className="size-4" />
              <AlertTitle>
                {intl.formatMessage({ id: "settings.migration.unsupported.title" })}
              </AlertTitle>
              <AlertDescription>{unsupportedDescription}</AlertDescription>
            </Alert>
          ) : null}

          <div className="grid gap-4 xl:grid-cols-3">
            <div className="space-y-2">
              <div className="text-ui-base font-medium text-foreground">
                {intl.formatMessage({ id: "settings.migration.workspaceFilterLabel" })}
              </div>
              <Select
                value={workspaceFilterMode}
                disabled={!supportState.supported || isScanning || isImporting}
                onValueChange={(value) =>
                  setWorkspaceFilterMode(value as (typeof WORKSPACE_FILTER_OPTIONS)[number])
                }
              >
                <SelectTrigger size="lg" className="w-full justify-between">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">
                    {intl.formatMessage({ id: "settings.migration.workspaceFilter.all" })}
                  </SelectItem>
                  {hasCurrentWorkspaceFilter ? (
                    <SelectItem value="current">
                      {intl.formatMessage({ id: "settings.migration.workspaceFilter.current" })}
                    </SelectItem>
                  ) : null}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <div className="text-ui-base font-medium text-foreground">
                {intl.formatMessage({ id: "settings.migration.rangeLabel" })}
              </div>
              <Select
                value={range}
                disabled={!supportState.supported || isScanning || isImporting}
                onValueChange={(value) => setRange(value as (typeof RANGE_OPTIONS)[number])}
              >
                <SelectTrigger size="lg" className="w-full justify-between">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {RANGE_OPTIONS.map((option) => (
                    <SelectItem key={option} value={option}>
                      {intl.formatMessage({ id: `settings.migration.range.${option}` })}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <div className="text-ui-base font-medium text-foreground">
                {intl.formatMessage({ id: "settings.migration.limitLabel" })}
              </div>
              <Input
                type="number"
                min={1}
                max={500}
                value={limitInput}
                disabled={!supportState.supported || isScanning || isImporting}
                onChange={(event) => setLimitInput(event.target.value)}
              />
              <div className="text-ui-base text-foreground-subtle">
                {intl.formatMessage(
                  { id: "settings.migration.limitHint" },
                  { max: String(scanLimit) },
                )}
              </div>
            </div>
          </div>

          {scanError ? (
            <Alert>
              <TriangleAlert className="size-4" />
              <AlertTitle>
                {intl.formatMessage({ id: "settings.migration.scanFailedTitle" })}
              </AlertTitle>
              <AlertDescription>
                {intl.formatMessage(
                  { id: "settings.migration.scanFailedDescription" },
                  { error: scanError },
                )}
              </AlertDescription>
            </Alert>
          ) : null}
        </CardContent>
      </Card>

      <MigrationCandidatesCard
        supportState={supportState}
        candidates={candidates}
        selectedSessionIds={selectedSessionIds}
        selectedCount={selectedCount}
        importError={importError}
        lastImportResult={lastImportResult}
        isImporting={isImporting}
        dateTimeFormatter={dateTimeFormatter}
        onToggleSelection={toggleSessionSelection}
        onSelectAll={selectAllSessions}
        onClearSelection={clearSelectedSessions}
        onImportSelected={() => {
          void importSelectedSessions();
        }}
      />
    </div>
  );
}

const FOREIGN_SOURCES: ZCodeForeignSessionSource[] = ["claude", "codex", "kimi", "cursor"];

function foreignKey(source: ZCodeForeignSessionSource, sessionId: string): string {
  return `${source}:${sessionId}`;
}

export function ForeignSessionImportCard({
  workspacePath,
  workspaceIdentity,
  supported,
  embedded = false,
  autoScan = false,
  startImportRef,
}: {
  workspacePath: string | null;
  workspaceIdentity?: string;
  supported: boolean;
  embedded?: boolean;
  autoScan?: boolean;
  startImportRef?: { current: (() => boolean) | null };
}) {
  const { intl } = useZCodeIntl();
  const taskService = useZCodeTaskService(workspacePath ?? undefined, undefined, workspaceIdentity);
  const [enabledSources, setEnabledSources] = useState<ZCodeForeignSessionSource[]>(FOREIGN_SOURCES);
  const [scanResult, setScanResult] = useState<ZCodeForeignSessionScanResult | null>(null);
  const [selectedKeys, setSelectedKeys] = useState<string[]>([]);
  const [scanError, setScanError] = useState<string | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [importResult, setImportResult] = useState<ZCodeImportSessionsResult | null>(null);
  const [isScanning, setIsScanning] = useState(false);
  const [isImporting, setIsImporting] = useState(false);

  const sessions = scanResult?.sessions ?? [];
  // 来源勾选是当前结果的过滤器：取消 Codex 立刻从两列和导入数量里拿走，不必再扫一遍。
  const visibleSessions = sessions.filter((session) => enabledSources.includes(session.source));
  const useful = visibleSessions.filter((session) => session.verdict === "useful");
  const useless = visibleSessions.filter((session) => session.verdict === "useless");
  const countSelected = (items: ZCodeForeignSessionScanResult["sessions"]) =>
    items.filter((session) => selectedKeys.includes(foreignKey(session.source, session.sessionId))).length;
  const usefulSelected = countSelected(useful);
  const uselessSelected = countSelected(useless);
  const importCount = usefulSelected + uselessSelected;

  const autoScannedRef = useRef(false);

  const selectionTouchedRef = useRef(false);
  const scanGenerationRef = useRef(0);
  const applyScan = useCallback((result: ZCodeForeignSessionScanResult, replaceSelection: boolean) => {
    setScanResult(result);
    const usefulKeys = result.sessions
      .filter((session) => session.verdict === "useful")
      .map((session) => foreignKey(session.source, session.sessionId));
    if (replaceSelection || !selectionTouchedRef.current) {
      setSelectedKeys(usefulKeys);
      return;
    }
    const present = new Set(
      result.sessions.map((session) => foreignKey(session.source, session.sessionId)),
    );
    setSelectedKeys((current) => current.filter((key) => present.has(key)));
  }, []);

  const scan = useCallback(async () => {
    if (!supported || enabledSources.length === 0) return;
    const generation = ++scanGenerationRef.current;
    selectionTouchedRef.current = false;
    setIsScanning(true);
    setScanError(null);
    setImportResult(null);
    try {
      // 先按文件名给出数量，窗口不等正文解析。
      const quick = await taskService.scanForeignSessions({
        sources: enabledSources,
        limit: 5000,
        quick: true,
      });
      if (generation !== scanGenerationRef.current) return;
      applyScan(quick, true);
      setIsScanning(false);
      const full = await taskService.scanForeignSessions({
        sources: enabledSources,
        limit: 5000,
      });
      if (generation !== scanGenerationRef.current) return;
      applyScan(full, false);
    } catch (error) {
      if (generation !== scanGenerationRef.current) return;
      const message = error instanceof Error ? error.message : String(error);
      logger.error("[Migration] 扫描外部会话失败", error);
      setScanError(message);
    } finally {
      if (generation === scanGenerationRef.current) setIsScanning(false);
    }
  }, [applyScan, enabledSources, supported, taskService]);

  useEffect(() => {
    if (!autoScan || !supported || autoScannedRef.current || scanResult) return;
    autoScannedRef.current = true;
    void scan();
  }, [autoScan, scan, scanResult, supported]);

  const importSelected = useCallback(async () => {
    if (!supported || importCount === 0) return;
    setIsImporting(true);
    setImportError(null);
    try {
      const selected = visibleSessions.filter((session) =>
        selectedKeys.includes(foreignKey(session.source, session.sessionId)),
      );
      const result = await taskService.importForeignSessions({
        ...(workspacePath ? { workspacePath } : {}),
        ...(workspaceIdentity ? { workspaceIdentity } : {}),
        sessions: selected.map((session) => ({
          source: session.source,
          sessionId: session.sessionId,
        })),
      });
      setImportResult(result);
      if (result.imported.length > 0) {
        invalidateTaskQueryCacheByScopes(
          result.imported.map((item) => ({ workspacePath: item.workspacePath })),
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error("[Migration] 导入外部会话失败", error);
      setImportError(message);
    } finally {
      setIsImporting(false);
    }
  }, [
    importCount,
    selectedKeys,
    supported,
    taskService,
    visibleSessions,
    workspaceIdentity,
    workspacePath,
  ]);

  const backgroundStartedRef = useRef(false);
  const beginBackgroundImport = useCallback(() => {
    if (!supported || importCount === 0 || backgroundStartedRef.current) return false;
    backgroundStartedRef.current = true;
    void importSelected();
    return true;
  }, [importCount, importSelected, supported]);

  useEffect(() => {
    if (!startImportRef) return;
    startImportRef.current = beginBackgroundImport;
    return () => {
      startImportRef.current = null;
    };
  }, [beginBackgroundImport, startImportRef]);

  const toggleSource = (source: ZCodeForeignSessionSource, checked: boolean) => {
    selectionTouchedRef.current = true;
    setEnabledSources((current) =>
      checked ? [...new Set([...current, source])] : current.filter((item) => item !== source),
    );
  };

  const toggleSession = (key: string, checked: boolean) => {
    selectionTouchedRef.current = true;
    setSelectedKeys((current) =>
      checked ? [...new Set([...current, key])] : current.filter((item) => item !== key),
    );
  };

  return (
    <Card className="border border-border bg-card py-0 shadow-none">
      {embedded ? null : (
      <CardHeader className="border-b border-border">
        <CardAction>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={!supported || isScanning || enabledSources.length === 0}
            onClick={() => {
              void scan();
            }}
          >
            {isScanning ? (
              <LoaderCircle className="size-3.5 animate-spin" />
            ) : (
              <RefreshCcw className="size-3.5" />
            )}
            {intl.formatMessage({ id: "settings.migration.foreign.scan" })}
          </Button>
        </CardAction>
        <div className="space-y-1">
          <CardTitle>{intl.formatMessage({ id: "settings.migration.foreign.title" })}</CardTitle>
          <CardDescription>
            {intl.formatMessage({ id: "settings.migration.foreign.description" })}
          </CardDescription>
        </div>
      </CardHeader>
      )}
      <CardContent className="space-y-4 px-4 py-4">
        <div className="flex flex-wrap items-center gap-4">
          {embedded ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={!supported || isScanning || enabledSources.length === 0}
              onClick={() => {
                void scan();
              }}
            >
              {isScanning ? (
                <LoaderCircle className="size-3.5 animate-spin" />
              ) : (
                <RefreshCcw className="size-3.5" />
              )}
              {intl.formatMessage({ id: "settings.migration.foreign.scan" })}
            </Button>
          ) : null}
          {FOREIGN_SOURCES.map((source) => (
            <label key={source} className="flex items-center gap-2 text-ui-base text-foreground">
              <Checkbox
                checked={enabledSources.includes(source)}
                disabled={!supported || isScanning}
                onCheckedChange={(checked) => toggleSource(source, checked === true)}
              />
              {intl.formatMessage({ id: `settings.migration.foreign.source.${source}` })}
            </label>
          ))}
        </div>
        {scanError ? (
          <Alert>
            <TriangleAlert className="size-4" />
            <AlertTitle>{intl.formatMessage({ id: "settings.migration.scanFailedTitle" })}</AlertTitle>
            <AlertDescription>{scanError}</AlertDescription>
          </Alert>
        ) : null}
        {scanResult ? (
          <div className="grid gap-4 lg:grid-cols-2">
            <ForeignSessionList
              title={intl.formatMessage(
                { id: "settings.migration.foreign.useful" },
                { selected: usefulSelected, total: useful.length },
              )}
              sessions={useful}
              selectedKeys={selectedKeys}
              disabled={!supported || isImporting}
              onToggle={toggleSession}
            />
            <ForeignSessionList
              title={intl.formatMessage(
                { id: "settings.migration.foreign.useless" },
                { selected: uselessSelected, total: useless.length },
              )}
              sessions={useless}
              selectedKeys={selectedKeys}
              disabled={!supported || isImporting}
              onToggle={toggleSession}
            />
          </div>
        ) : null}
        <div className="flex items-center justify-between gap-3">
          <div className="text-ui-base text-foreground-subtle">
            {importResult
              ? intl.formatMessage(
                  { id: "settings.migration.foreign.imported" },
                  {
                    imported: importResult.imported.length,
                    skipped: importResult.skipped.length,
                    failed: importResult.failed.length,
                  },
                )
              : null}
            {importError}
          </div>
          {embedded ? null : (
            <Button
              type="button"
              size="sm"
              disabled={!supported || isImporting || importCount === 0}
              onClick={() => {
                void importSelected();
              }}
            >
              {isImporting ? <LoaderCircle className="size-3.5 animate-spin" /> : null}
              {intl.formatMessage(
                { id: "settings.migration.foreign.import" },
                { count: importCount },
              )}
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function ForeignSessionList({
  title,
  sessions,
  selectedKeys,
  disabled,
  onToggle,
}: {
  title: string;
  sessions: ZCodeForeignSessionScanResult["sessions"];
  selectedKeys: string[];
  disabled: boolean;
  onToggle: (key: string, checked: boolean) => void;
}) {
  const { intl } = useZCodeIntl();
  return (
    <div className="space-y-2">
      <div className="text-ui-base font-medium text-foreground">{title}</div>
      <div className="max-h-80 space-y-2 overflow-auto">
        {sessions.length === 0 ? (
          <div className="text-ui-base text-foreground-subtle">
            {intl.formatMessage({ id: "settings.migration.foreign.empty" })}
          </div>
        ) : (
          sessions.map((session) => {
            const key = foreignKey(session.source, session.sessionId);
            return (
              <label key={key} className="flex items-start gap-2 rounded-md border border-border p-2">
                <Checkbox
                  className="mt-0.5"
                  checked={selectedKeys.includes(key)}
                  disabled={disabled}
                  onCheckedChange={(checked) => onToggle(key, checked === true)}
                />
                <span className="min-w-0">
                  <span className="block truncate text-ui-base text-foreground">{session.title}</span>
                  <span className="block truncate text-ui-sm text-foreground-subtle">
                    {intl.formatMessage({
                      id: `settings.migration.foreign.source.${session.source}`,
                    })}
                    {session.workspacePath ? ` · ${session.workspacePath}` : ""}
                    {session.reasons.length > 0
                      ? ` · ${session.reasons
                          .map((reason) =>
                            intl.formatMessage({
                              id: `settings.migration.foreign.reason.${reason}`,
                            }),
                          )
                          .join(", ")}`
                      : ""}
                  </span>
                </span>
              </label>
            );
          })
        )}
      </div>
    </div>
  );
}

/* eslint-disable max-lines -- 设置同步流程聚合了发现、选择与导入状态机，集中维护更利于问题定位 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  SettingsSyncCategory,
  SettingsSyncDiscoveryResult,
  SettingsSyncImportResult,
  SettingsSyncSelection,
} from "@zcode/shared";
import { logger } from "@/logger.js";
import { useServices } from "@/hooks/useServices.js";
import { useZCodeSessionService } from "@/hooks/useZCodeSessionService.js";
import { invalidateDeferredDraftSessionForSkillChange } from "@/lib/zcodeDraftSkillInvalidation.js";
import type { SettingsSyncUiState, SettingsSyncUiTask } from "@/settings-sync/types.js";

const IMPORTING_TASK_DELAY_MS = 320;
const FORCE_SHOW_ONBOARDING_ON_EVERY_REFRESH = false;
// ZCodeLocal 首次启动标记：旧 ~/.zcode 里的 settingsSyncFirstRunPromptHandled 可能已经为 true，
// 改名后的首启仍要展示一次标准会话导入向导。标记存在 localStorage 的 ZCodeLocal 用户目录里。
const ZCODELOCAL_ONBOARDING_MARKER_KEY = "zcodelocal.onboarding.v1";

function hasSeenZCodeLocalOnboarding(): boolean {
  try {
    return globalThis.localStorage?.getItem(ZCODELOCAL_ONBOARDING_MARKER_KEY) === "1";
  } catch {
    return false;
  }
}

export function markZCodeLocalOnboardingSeen(): void {
  try {
    globalThis.localStorage?.setItem(ZCODELOCAL_ONBOARDING_MARKER_KEY, "1");
  } catch {
    // localStorage 不可用时只影响下次是否重复提示，不能阻断关闭向导。
  }
}

/** 首启自动检测与设置页手动重开对“空 discovery”的处理不同。 */
type LoadDiscoveryIntent = "firstRun" | "manual";

function createInitialState(): SettingsSyncUiState {
  return {
    open: false,
    loading: false,
    importing: false,
    step: "selection",
    discovery: null,
    selectedKeys: [],
    tasks: [],
    result: null,
    workspaceRequiredCount: 0,
    error: null,
  };
}

function getSelectionKey(agent: string, category: string): string {
  return `${agent}:${category}`;
}

/**
 * 首启 Onboarding 代理设置：仅模型供应商（providers），不展示、不迁移技能与插件。
 */
function visibleCategoriesForOnboarding(): SettingsSyncCategory[] {
  return ["providers"];
}

function normalizeDiscovery(discovery: SettingsSyncDiscoveryResult): SettingsSyncDiscoveryResult {
  return {
    agents: discovery.agents.map((agent) => {
      const categoryMap = new Map(
        agent.categories.map((category) => [category.category, category]),
      );
      const categories = visibleCategoriesForOnboarding().map((category) => {
        const existing = categoryMap.get(category);
        if (existing) {
          return existing;
        }
        return {
          category,
          discoveredCount: 0,
          importableCount: 0,
          selectedByDefault: false,
        };
      });
      return {
        ...agent,
        categories,
      };
    }),
  };
}

function buildDefaultSelectedKeys(discovery: SettingsSyncDiscoveryResult): string[] {
  return discovery.agents.flatMap((agent) =>
    agent.categories
      .filter((category) => category.selectedByDefault && category.discoveredCount > 0)
      .map((category) => getSelectionKey(agent.agent, category.category)),
  );
}

function buildTasks(
  discovery: SettingsSyncDiscoveryResult,
  selectedKeys: string[],
): SettingsSyncUiTask[] {
  const selected = new Set(selectedKeys);
  return discovery.agents.flatMap((agent) =>
    agent.categories
      .filter((category) => selected.has(getSelectionKey(agent.agent, category.category)))
      .map((category) => ({
        id: getSelectionKey(agent.agent, category.category),
        agent: agent.agent,
        category: category.category,
        discoveredCount: category.discoveredCount,
        status: "pending" as const,
      })),
  );
}

function buildStateSelections(selectedKeys: string[]): SettingsSyncSelection[] {
  return selectedKeys.map((key) => {
    const [agent, category] = key.split(":");
    return {
      agent: agent as SettingsSyncSelection["agent"],
      category: category as SettingsSyncSelection["category"],
    };
  });
}

function countSelectionItems(selection: SettingsSyncSelection): number {
  return (
    selection.skillPaths?.length ??
    selection.commandPaths?.length ??
    selection.pluginPaths?.length ??
    selection.mcpServerPaths?.length ??
    1
  );
}

function buildTasksFromSelections(selections: SettingsSyncSelection[]): SettingsSyncUiTask[] {
  return selections.map((selection, index) => ({
    id: `${selection.agent}:${selection.category}:${selection.sourceScope ?? "all"}:${selection.targetScope ?? "auto"}:${index}`,
    agent: selection.agent,
    category: selection.category,
    discoveredCount: countSelectionItems(selection),
    status: "pending" as const,
  }));
}

/** 导入目标或来源是项目的选择：没有打开的项目时无处读写。 */
function selectionRequiresWorkspace(selection: SettingsSyncSelection): boolean {
  return selection.targetScope === "project" || selection.sourceScope === "project";
}

/**
 * 按 selections 原顺序合并结果：需要项目的项记为失败，其余依次取导入服务的结果。
 * applyTaskResults 按 agent:category 的出现顺序对齐任务，所以顺序必须与 selections 一致。
 */
function mergeWorkspaceRequiredResults(
  selections: SettingsSyncSelection[],
  blocked: ReadonlySet<SettingsSyncSelection>,
  imported: SettingsSyncImportResult,
): SettingsSyncImportResult {
  const importedResults = [...imported.taskResults];
  const taskResults = selections.flatMap((selection) => {
    if (!blocked.has(selection)) {
      const next = importedResults.shift();
      return next ? [next] : [];
    }
    const failedCount = countSelectionItems(selection);
    return [
      {
        agent: selection.agent,
        category: selection.category,
        status: "failed" as const,
        importedCount: 0,
        skippedCount: 0,
        failedCount,
      },
    ];
  });
  const blockedCount = [...blocked].reduce(
    (sum, selection) => sum + countSelectionItems(selection),
    0,
  );
  return {
    successCount: imported.successCount,
    skippedCount: imported.skippedCount,
    failedCount: imported.failedCount + blockedCount,
    taskResults: [...taskResults, ...importedResults],
  };
}

const EMPTY_IMPORT_RESULT: SettingsSyncImportResult = {
  successCount: 0,
  skippedCount: 0,
  failedCount: 0,
  taskResults: [],
};

function normalizeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function applyTaskResults(
  tasks: SettingsSyncUiTask[],
  result: SettingsSyncImportResult,
): SettingsSyncUiTask[] {
  const taskResultQueues = new Map<string, SettingsSyncImportResult["taskResults"]>();
  for (const task of result.taskResults) {
    const key = `${task.agent}:${task.category}`;
    taskResultQueues.set(key, [...(taskResultQueues.get(key) ?? []), task]);
  }
  return tasks.map((task) => {
    const matched = taskResultQueues.get(`${task.agent}:${task.category}`)?.shift();
    return matched ? { ...task, status: matched.status } : { ...task, status: "skipped" };
  });
}

export function useSettingsSync(params: {
  workspacePath?: string;
  workspaceIdentity?: string;
  /** ZCodeLocal 首启：忽略旧 profile 的 handled 标记，强制展示一次标准导入向导。 */
  forceFirstRunOnboarding?: boolean;
}) {
  const { settingsSyncService } = useServices();
  const zcodeSessionService = useZCodeSessionService(
    params.workspacePath,
    undefined,
    params.workspaceIdentity,
  );
  const runningImportRef = useRef(0);
  const discoveryRequestRef = useRef(0);
  const [state, setState] = useState<SettingsSyncUiState>(createInitialState);

  const loadDiscovery = useCallback(
    async (intent: LoadDiscoveryIntent = "firstRun", requestId = ++discoveryRequestRef.current) => {
      // 首启回包曾覆盖手动窗口；关闭和工作区切换后的回包也会复活旧 UI。
      // 每次检测只提交到自己的请求代次，连排队中的 React updater 也要复核。
      const isCurrent = () => discoveryRequestRef.current === requestId;
      const updateState = (update: (current: SettingsSyncUiState) => SettingsSyncUiState) =>
        setState((current) => (isCurrent() ? update(current) : current));

      if (!params.workspacePath) {
        // 首启第一步是本地会话导入，不依赖已打开的项目。没有项目时跳过 settings 扫描，
        // 直接以空 discovery 打开向导，否则新用户必须先选项目才能看到导入入口。
        updateState((current) => ({
          ...current,
          open: true,
          loading: false,
          step: "selection",
          discovery: { agents: [] },
          selectedKeys: [],
          tasks: [],
          result: null,
          workspaceRequiredCount: 0,
          error: null,
        }));
        logger.info("[settings-sync] open onboarding without workspace", { intent });
        return;
      }

      updateState((current) => ({ ...current, loading: true, error: null }));

      try {
        const rawDiscovery = await settingsSyncService.detect({
          workspacePath: params.workspacePath,
          workspaceIdentity: params.workspaceIdentity,
        });
        if (!isCurrent()) return;
        const discovery = normalizeDiscovery(rawDiscovery);
        if (discovery.agents.length === 0) {
          // 第一步是本地会话导入，不依赖 detect 扫到的外部配置。
          // 空结果如果直接关掉，首启和设置页里的「迁移」都会一闪而过。
          updateState((current) => ({
            ...current,
            open: true,
            loading: false,
            step: "selection",
            discovery,
            selectedKeys: [],
            tasks: [],
            result: null,
            error: null,
          }));
          logger.info("[settings-sync] discovery empty, keep onboarding open", {
            workspacePath: params.workspacePath,
            intent,
          });
          return;
        }
        const selectedKeys = buildDefaultSelectedKeys(discovery);
        updateState((current) => ({
          ...current,
          open: true,
          loading: false,
          step: "selection",
          discovery,
          selectedKeys,
          tasks: [],
          result: null,
          error: null,
        }));
        logger.info("[settings-sync] discovery loaded", {
          workspacePath: params.workspacePath,
          agentCount: discovery.agents.length,
          selectedCount: selectedKeys.length,
        });
      } catch (error) {
        if (!isCurrent()) return;
        const message = normalizeError(error);
        logger.error("[settings-sync] discovery failed", {
          workspacePath: params.workspacePath,
          error: message,
        });
        updateState((current) => ({
          ...current,
          open: true,
          loading: false,
          error: message,
        }));
      }
    },
    [params.workspaceIdentity, params.workspacePath, settingsSyncService],
  );

  useEffect(() => {
    const requestId = ++discoveryRequestRef.current;
    const cancel = () => {
      discoveryRequestRef.current += 1;
    };
    // 新工作区不能沿用上一工作区的检测结果或加载状态。
    setState(createInitialState());

    if (FORCE_SHOW_ONBOARDING_ON_EVERY_REFRESH) {
      void loadDiscovery("firstRun", requestId);
      return cancel;
    }

    // 当前 ZCodeLocal 用户目录已经关闭/完成过标准向导时保持安静；
    // 旧 profile 的 handled 标记不参与这里，避免导入 ~/.zcode 后首启被永久压掉。
    if (hasSeenZCodeLocalOnboarding()) {
      return cancel;
    }

    // 改名后的桌面首启固定展示一次标准会话导入向导，即使没有打开项目也照常打开。
    if (params.forceFirstRunOnboarding) {
      void loadDiscovery("firstRun", requestId);
      return cancel;
    }

    void (async () => {
      try {
        // onboarding 弹窗是“首启提示”，不是普通刷新提示。
        // 之前调试阶段直接每次进入 workspace 都弹，用户一旦跳过仍会被重复打断。
        // 这里先读取 handled 状态，只在第一次尚未消费时才继续做检测和展示。
        const promptState = await settingsSyncService.getFirstRunPromptState();
        if (discoveryRequestRef.current !== requestId) {
          return;
        }

        if (promptState.handled) {
          setState((current) =>
            discoveryRequestRef.current === requestId ? createInitialState() : current,
          );
          return;
        }

        await loadDiscovery("firstRun", requestId);
      } catch (error) {
        if (discoveryRequestRef.current !== requestId) return;
        const message = normalizeError(error);
        logger.error("[settings-sync] first run prompt state failed", {
          workspacePath: params.workspacePath,
          error: message,
        });
        setState((current) =>
          discoveryRequestRef.current === requestId
            ? { ...current, open: true, loading: false, error: message }
            : current,
        );
      }
    })();

    return cancel;
  }, [loadDiscovery, params.forceFirstRunOnboarding, params.workspacePath, settingsSyncService]);

  const selectedCount = state.selectedKeys.length;
  const taskProgress = useMemo(() => {
    if (state.tasks.length === 0) return 0;
    const completedCount = state.tasks.filter(
      (task) => task.status !== "pending" && task.status !== "running",
    ).length;
    return Math.round((completedCount / state.tasks.length) * 100);
  }, [state.tasks]);

  const close = useCallback(() => {
    discoveryRequestRef.current += 1;
    runningImportRef.current += 1;
    setState((current) => ({ ...current, open: false, loading: false, importing: false }));
    // 先记 ZCodeLocal 自己的首启标记：即使旧 profile 的 handled 写失败，
    // 也不能在同一用户目录里每次启动都重复弹出标准向导。
    markZCodeLocalOnboardingSeen();
    if (FORCE_SHOW_ONBOARDING_ON_EVERY_REFRESH) {
      return;
    }
    // “关闭 onboarding”本身就表示用户已经处理过这次首启提示，
    // 无论是直接开始还是跳过迁移，都应该立刻落库，避免下次启动再次重复弹出。
    void settingsSyncService.markFirstRunPromptHandled().catch((error) => {
      logger.error("[settings-sync] mark first run prompt handled failed", {
        workspacePath: params.workspacePath,
        error: normalizeError(error),
      });
    });
  }, [params.workspacePath, settingsSyncService]);

  const reopen = useCallback(() => {
    const requestId = ++discoveryRequestRef.current;
    setState((current) => ({ ...current, open: true, loading: false }));
    // 手动打开接管首启检测，不能被旧 loading 阻止，也不能在 updater 内发起副作用。
    if (!state.discovery && params.workspacePath) {
      void loadDiscovery("manual", requestId);
    }
  }, [loadDiscovery, params.workspacePath, state.discovery]);

  const toggleSelection = useCallback((key: string) => {
    setState((current) => {
      const set = new Set(current.selectedKeys);
      if (set.has(key)) {
        set.delete(key);
      } else {
        set.add(key);
      }
      return {
        ...current,
        selectedKeys: [...set],
      };
    });
  }, []);

  const setAgentSelection = useCallback((agent: string, checked: boolean) => {
    setState((current) => {
      if (!current.discovery) {
        return current;
      }
      const next = new Set(current.selectedKeys);
      const targetAgent = current.discovery.agents.find((item) => item.agent === agent);
      if (!targetAgent) {
        return current;
      }
      for (const category of targetAgent.categories) {
        const key = getSelectionKey(agent, category.category);
        if (checked) {
          next.add(key);
        } else {
          next.delete(key);
        }
      }
      return {
        ...current,
        selectedKeys: [...next],
      };
    });
  }, []);

  const setCategorySelectionAllAgents = useCallback(
    (category: SettingsSyncCategory, checked: boolean) => {
      setState((current) => {
        if (!current.discovery) {
          return current;
        }
        const next = new Set(current.selectedKeys);
        for (const agentSummary of current.discovery.agents) {
          if (!agentSummary.categories.some((c) => c.category === category)) {
            continue;
          }
          const key = getSelectionKey(agentSummary.agent, category);
          if (checked) {
            next.add(key);
          } else {
            next.delete(key);
          }
        }
        return {
          ...current,
          selectedKeys: [...next],
        };
      });
    },
    [],
  );

  const startImportWithAdditionalSelections = useCallback(
    async (
      additionalSelections: SettingsSyncSelection[] = [],
      options: { includeCurrentSelections?: boolean } = {},
    ) => {
      const includeCurrentSelections = options.includeCurrentSelections ?? true;
      // 数据迁移向导可临时隐藏代理设置步骤；隐藏时不能把默认选中的 providers 暗中导入。
      const stateSelections =
        includeCurrentSelections && state.discovery ? buildStateSelections(state.selectedKeys) : [];
      const selections: SettingsSyncSelection[] = [...stateSelections, ...additionalSelections];
      if (selections.length === 0) {
        return;
      }
      discoveryRequestRef.current += 1;
      // 修复（决定 24）：原来没有 workspacePath 时直接 return，从数据同步页「迁移」进入时
      // 技能 / MCP / 命令导入被整体静默跳过，结果页仍显示完成。导入服务支持没有项目：
      // 用户级的项照常导入；需要项目的项不导入，记为失败并计数，由完成页写明原因。
      const workspaceRequired = new Set(
        params.workspacePath ? [] : selections.filter(selectionRequiresWorkspace),
      );
      const importableSelections = selections.filter(
        (selection) => !workspaceRequired.has(selection),
      );
      const workspaceRequiredCount = [...workspaceRequired].reduce(
        (sum, selection) => sum + countSelectionItems(selection),
        0,
      );
      const runId = runningImportRef.current + 1;
      runningImportRef.current = runId;
      const initialTasks =
        state.discovery && includeCurrentSelections
          ? [
              ...buildTasks(state.discovery, state.selectedKeys),
              ...buildTasksFromSelections(additionalSelections),
            ]
          : buildTasksFromSelections(selections);

      setState((current) => ({
        ...current,
        loading: false,
        importing: true,
        step: "importing",
        tasks: initialTasks,
        result: null,
        workspaceRequiredCount,
        error: null,
      }));

      logger.info("[settings-sync] import started", {
        workspacePath: params.workspacePath,
        selections,
        workspaceRequiredCount,
      });

      const importPromise =
        importableSelections.length > 0
          ? settingsSyncService
              .importSelected({
                workspacePath: params.workspacePath,
                workspaceIdentity: params.workspaceIdentity,
                selections: importableSelections,
              })
              .then((imported) =>
                mergeWorkspaceRequiredResults(selections, workspaceRequired, imported),
              )
          : Promise.resolve(
              mergeWorkspaceRequiredResults(selections, workspaceRequired, EMPTY_IMPORT_RESULT),
            );

      for (let index = 0; index < initialTasks.length; index += 1) {
        if (runningImportRef.current !== runId) {
          return;
        }
        const task = initialTasks[index];
        if (!task) {
          continue;
        }
        setState((current) => ({
          ...current,
          tasks: current.tasks.map((item) =>
            item.id === task.id ? { ...item, status: "running" } : item,
          ),
        }));
        await new Promise((resolve) => setTimeout(resolve, IMPORTING_TASK_DELAY_MS));
      }

      try {
        const result = await importPromise;
        if (runningImportRef.current !== runId) {
          return;
        }

        if (selections.some((selection) => selection.category === "skills")) {
          await invalidateDeferredDraftSessionForSkillChange({
            workspacePath: params.workspacePath,
            workspaceIdentity: params.workspaceIdentity,
            reason: "settings-sync-skill-import",
          });
        }

        setState((current) => ({
          ...current,
          importing: false,
          step: "complete",
          result,
          tasks: applyTaskResults(current.tasks, result),
        }));
        logger.info("[settings-sync] import completed", {
          workspacePath: params.workspacePath,
          result,
        });
      } catch (error) {
        const message = normalizeError(error);
        if (runningImportRef.current !== runId) {
          return;
        }
        logger.error("[settings-sync] import failed", {
          workspacePath: params.workspacePath,
          error: message,
        });
        setState((current) => ({
          ...current,
          importing: false,
          step: "complete",
          error: message,
          tasks: current.tasks.map((task) => ({ ...task, status: "failed" })),
          result: {
            successCount: 0,
            skippedCount: 0,
            failedCount: current.tasks.length,
            taskResults: current.tasks.map((task) => ({
              agent: task.agent,
              category: task.category,
              status: "failed" as const,
              importedCount: 0,
              skippedCount: 0,
              failedCount: 1,
            })),
          },
        }));
      }
    },
    [
      params.workspaceIdentity,
      params.workspacePath,
      settingsSyncService,
      zcodeSessionService,
      state.discovery,
      state.selectedKeys,
    ],
  );

  const startImport = useCallback(async () => {
    await startImportWithAdditionalSelections();
  }, [startImportWithAdditionalSelections]);

  const finish = useCallback(() => {
    close();
  }, [close]);

  return {
    state,
    selectedCount,
    taskProgress,
    actions: {
      close,
      reopen,
      reloadDiscovery: loadDiscovery,
      toggleSelection,
      setAgentSelection,
      setCategorySelectionAllAgents,
      startImport,
      startImportWithAdditionalSelections,
      finish,
    },
  };
}

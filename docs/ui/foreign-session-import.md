# 外部会话导入向导

2026-11-25。桌面设置里的「会话导入向导」只读扫描本机 Claude Code、Codex、Kimi、Cursor 的历史，标出有用和没用的会话，再把用户勾选的会话导入当前 ZCode 任务列表。

筛选不调用模型。规则取自 Orion 知识库导入（`history_labels.noise` 与 `history_outcomes.evaluate` 里不依赖标注的结构条件）：

- 可见正文先去掉外壳标签：环境、时间、图片清单、IDE 选区、系统提醒，以及成对的 `<user_query>` / `<send_user_message_question_reply>`。后两种只留下里面的话；问题回复里的 JSON 只取 `question` 和 `answer`，不留 `questionItemId`。Codex 的 Guardian 决定（`risk_level` / `outcome`）不是消息。索引里的名字 `Guardian review` 不是标题，改用去掉外壳后的第一句用户话。单独一行的开标签或闭标签不进历史。
- 正文按记录往下读，不因某一行工具输出很大就停在第一段环境信息上。单行超过上限就跳过这一行并继续。可见历史只保留用户和助手的对话，环境块本身不进会话。
- 没有足够长的用户任务，视为没用。
- 没有足够长的助手答复，也没有成功的工具结果，视为没用。
- 记录到中断或失败，且没有上述结果，视为没用。

有用户任务，并且有助手答复或成功的工具结果，视为有用。未知工作区只是备注，不单独把会话打成没用。

桌面首次引导把这一步放在第一位，标题是「Импорт сессий」。后面的 Claude 工作区选择、技能、MCP 和命令仍按原顺序保留。

扫描不写会话。导入沿现有 `createSession.importedHistory`：CLI 是正文的唯一写者，Host 只写任务列表镜像。来源目录还在时，任务写进这个目录的真实路径（大小写和斜杠先归一），并归入已有的同路径项目；没有才新建。创建会话时第一次归属可能先记成「无项目」，导入后再把任务挂到这个项目，否则侧边栏文件夹是空的，会话却出现在总任务列表。 Cursor 个人目录名如果能对应到这条真实路径，Claude、Codex、Kimi 和 Cursor 进同一个项目。来源目录不存在时才写进当前打开的工作区。再次导入同一来源会新建一条任务，不覆盖已经继续聊过的会话。两边目录都不存在时，该条跳过。

来源勾选立刻过滤当前列表，不重新扫描。列标题是「已勾选 / 该列可见条数」。取消一条或关掉一个来源，这两个数一起变。引导里没有单独的导入按钮：「继续」按当前勾选在后台开始导入，并立刻进入下一步。设置页里的同一张卡片仍保留导入按钮。同一次引导里再次点「继续」不会再导一遍。

来源目录与 Orion 相同，并加上各应用自己的个人文件夹：

- Claude：`CLAUDE_CONFIG_DIR` 或 `~/.claude/projects` 下的 `.jsonl`。
- Codex：`CODEX_HOME` 或 `~/.codex` 的 `sessions` 与 `archived_sessions`（`.jsonl` 和 `.jsonl.zst`）。不打开 `state_*.sqlite`。
- Kimi：`~/.kimi/sessions` 与 `~/.kimi-code/sessions` 的 `context.jsonl` / `wire.jsonl`。
- Cursor：`~/.cursor/projects` 里的 `agent-transcripts/**/*.jsonl`，另外仍读 `%APPDATA%/Cursor/User` 的 `state.vscdb`。同一 id 优先留有正文的那份。

只读打开，不修改来源文件。向导先做快速清点：只看文件名和 Codex 的 `session_index.jsonl`，几秒内显示数量并允许继续。正文分类在后台替换列表，不挡住窗口。扫描每处理一条会话就把 Host 事件循环让出去，避免挡住 Agent 的第一帧 SQLite 状态。

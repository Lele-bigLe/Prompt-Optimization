# Codex CLI 提示词优化（0.1.0 试用入口）

在正常 Codex CLI 中填写草稿，按 **Ctrl+G** 后台优化，完成后自动填回未发送草稿。不打开浏览器，不向原聊天插入优化消息。

当前适配 Windows x64、Node.js 18.20+，协议以 Codex CLI 0.166.0 为依据。使用官方实验性的本地 app-server / remote TUI 接口；后续 Codex 版本变更需要重新核对兼容性。

## 试用状态与已知问题

已实测首次优化、继续优化、恢复原文、附件保留、双终端隔离及错误时保留原稿。取消操作已验证初始化阶段，真实模型生成期间的中断尚未验收。

终端自动化测试中，带前导换行的粘贴曾在指定“不提交”后意外提交草稿，额外启动了一次主聊天调用，发现后已中断。根因尚未定位；请先在测试会话体验，不能将该粘贴路径视为已验证安全。

## 准备与启动

在仓库根目录执行：

```powershell
Push-Location cli
npm install
Pop-Location
node cli/index.cjs start --cwd D:/你的项目
```

程序查找官方 Codex，可用 `--codex` 指定 `codex.exe` 的绝对路径。使用当前 Codex 登录和环境配置，不读取或复制登录令牌。

启动后正常写草稿，按 Ctrl+G。优化完成后检查草稿，自行按 Enter 发送。自动配置的 `VISUAL` / `EDITOR` 仅对这次进程生效。

恢复已有 Codex 对话：

```powershell
node cli/index.cjs start --cwd D:/你的项目 -- resume
```

`--` 后传 Codex 的原生参数，如 `resume 对话ID`、`fork 对话ID` 或 `-m 模型ID`。本入口自己管理本地服务，暂不支持原生 `--remote`、`--no-daemon`、`--worktree` 和 `--profile`。这些用法继续使用普通 Codex。

恢复已有对话时沿用该对话的权限，不要同时传 `-s` / `--sandbox` 或 `-a` / `--ask-for-approval` 等权限覆盖参数；Codex 的 remote resume 会拒绝这些组合。

## 选择优化模型、思考程度和模板

```powershell
node cli/index.cjs models
node cli/index.cjs templates
node cli/index.cjs start --model 目录中的模型ID --effort high --template builtin-task --cwd D:/你的项目
```

优化模型与主聊天独立。未指定模型时，优先使用这次聊天建立时的模型，再使用 Codex 环境默认模型。支持的思考档位以 `models` 返回的目录为准；不支持的组合会停止并保留原稿。`auto` 为模型默认，`low` 简单，`medium` 适中，`high` 深入，`xhigh` 更深入；只有目录支持时才使用相应档位。

保存下次启动时使用的偏好：

```powershell
node cli/index.cjs config --effort medium --context on --timeout 90 --template builtin-basic
```

默认参考最近 8 轮聊天、最多 24000 字，仅取用户正文和最终回复。使用 `--context off` 只优化草稿。配置修改在下一次 `start` 生效。

新建且尚未发过消息的空对话只使用草稿；开始聊天后再读取该对话的近期内容。

## 继续优化、恢复原文与取消

- 再次按 Ctrl+G：草稿、参考聊天和配置未变时，沿用独立优化会话继续改善。
- 补充修改要求：在**另一个终端的本仓库根目录**执行下面的 `continue`，然后回到对应 Codex 按 Ctrl+G。
- 恢复原稿：在另一个终端执行 `undo`，再回到对应 Codex 按 Ctrl+G。草稿已手动修改时停止恢复，防止覆盖新内容。
- 取消正在进行的优化：在另一个终端执行 `cancel`，不需要再次按 Ctrl+G。未写回的原稿保留。

```powershell
node cli/index.cjs continue --instructions "更简洁，保留验收条件"
node cli/index.cjs undo
node cli/index.cjs cancel
```

这些是工具命令，不要输入到 Codex 的聊天正文中。原生 Codex 只在外部编辑器返回时接收草稿，所以恢复及指定继续优化目前需要“独立命令准备 + Ctrl+G”两步。

多个终端同时使用时，先运行 `node cli/index.cjs sessions`，再给控制命令加 `--session 入口ID`。入口 ID 对应启动时显示的 ID；工具不会猜测最近打开的终端或聊天。

发生错误时原稿保留，可在另一个终端运行 `node cli/index.cjs last-error --session 入口ID` 查看原因。

## 会话与数据范围

每个入口单独启动本地服务，仅监听回环地址并要求临时认证；通过自己连接中的 `thread/start` / `thread/resume` / `thread/fork` 响应识别当前对话。不按目录挑选聊天，也不信任继承的 `CODEX_THREAD_ID`。切换会话或聊天内容变化时，中止仍未完成的优化。

优化使用独立、禁用工具的临时会话，只改写文字。模型失败、超时、附件占位改变或原稿被修改时停止写回，不自动重试、执行草稿任务或发送聊天消息。

本版保留原生图片附件占位，但**不向优化模型发送图片原图**。仅支持现有 Codex 登录后端；Claude Code、第三方 API 及完整历史回顾界面后续接入。

数据位于 `$CODEX_HOME/prompt-optimizer-cli`，未设置 `CODEX_HOME` 时位于 `~/.codex/prompt-optimizer-cli`：

- `config.json`：模型、模板、思考和上下文偏好，不保存 API 密钥。
- `runs/`：运行中的入口信息及临时认证，正常退出时移除。
- `backups/`：本次入口的原稿与候选备份，不包含聊天记录和图片二进制；恢复命令针对当前入口中最近的优化。
- `errors/`：本次入口的最近错误，不记录模型原始协议或凭据。

CLI 依赖只安装在 `cli/`，不改变 VS Code 扩展的运行依赖和安装副本。

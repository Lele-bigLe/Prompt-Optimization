# Codex CLI 提示词优化（0.2.0 开发版）

在 Codex CLI 中填写草稿，按 **Ctrl+G** 优化并直接填回输入框，不发送消息。再次按 Ctrl+G 可继续改善。需要查看和调整时，可选择先预览。

当前适配 Windows x64、Node.js 18.20+，协议以 Codex CLI 0.166.0 为依据。使用官方实验性的本地 app-server / remote TUI 接口；后续 Codex 版本变更需要重新核对兼容性。

## 试用状态与已知问题

以下为 2026-11-09 的开发验证记录，不代表 0.2.0 全面验收或稳定版发布。使用原生 Codex 0.167.0、Windows ConPTY 和独立合成历史会话；优化模型为 `gpt-6.1-terra`、思考程度 `low`。

| 验证路径 | 观察结果 |
| --- | --- |
| 原生 TUI：空输入 Ctrl+G、Esc 返回 | 设置可打开并返回 |
| 原生 TUI：历史草稿优化、回填后追加文字 | 真实优化完成，输入框可继续编辑 |
| 原生 TUI：主聊天完成后优化下一条草稿 | 真实优化完成 |
| 原生 TUI：对候选再次 Ctrl+G | 继续优化完成 |
| 协议集成：取消订阅并收到 `notLoaded` / `thread/closed` | 按原 ID 读取历史并完成优化写回；该卸载序列未在原生 TUI 测试中自然触发 |
| 协议集成：服务端拒绝 `turn/start` 后优化 | 修复前残留 `busy=true`；修复后状态恢复并完成真实优化写回 |
| 协议集成：真实生成中再发被拒绝的请求 | 仍拦截优化，完成通知后恢复 |

本轮共五次真实优化、三次明确提交的合成主聊天调用，未观察到优化草稿被额外提交。语法检查和差异检查通过。本地详细记录位于 `artifacts/cli-history-check-2026-11-09/RESULT.md`，最终故障分支证据为 `rejected-final.json` 和 `active-control-final.json`；这些原始记录不随仓库提交。

已修正的状态处理：空草稿进入设置不再要求绑定聊天；取消订阅或卸载保留原对话 ID，允许读取 `notLoaded` 的持久化历史，不自动 resume；被拒绝的 `turn/start` 恢复其预置状态且不覆盖后续通知。真正切换、断开连接、归档或删除仍使绑定失效。`thread/read` 在真实生成中也曾返回 `idle`，不能单独用它清除已订阅会话的生成标记。

尚未确认用户最新一次“仍在生成”错误是否由拒绝请求分支触发，也未还原旧历史对话状态核对错误的具体事件序列。回填后可继续编辑的 ConPTY 结果不等于 Windows Terminal 桌面焦点问题已解决；终端预览、生成中取消、S 转设置、滚动、中文/窄窗/resize 及完整无闪动体验仍待验收。编辑器退出的 stdin 清理修正不证明此前不能输入的完整原因已定位。

0.1.0 已实测首次优化、继续优化、恢复原文、附件保留、双终端隔离及错误时保留原稿。取消操作只验证过初始化阶段。

终端自动化测试中，带前导换行的粘贴曾在指定“不提交”后意外提交草稿，额外启动了一次主聊天调用，发现后已中断。根因尚未定位；请先在测试会话体验，不能将该粘贴路径视为已验证安全。

## 准备与启动

完成一次 PowerShell 启动接入后，日常使用：

```powershell
codex
codex resume
```

写好草稿后按 Ctrl+G，直接回填模式不打开优化器的生成页面、不绘制进度，完成后更新输入框。检查后自行按 Enter 发送。等待期间仍可按 Esc 取消，或按 S 停止生成并打开设置；空输入框按 Ctrl+G 直接打开设置。

启动接入修改 PowerShell 用户配置中的 `codex` 函数。新开 PowerShell 才会加载，正在运行的 Codex 不会原地接入；已有聊天可用 `codex resume` 恢复。不需要修改官方 Codex 安装文件、系统 PATH 或全局编辑器环境变量。

其他机器安装好本项目 CLI 依赖后，可先备份 PowerShell 用户配置，再将自己的 `codex` 函数接入：

```powershell
function codex {
    & node 'D:/me-project/Prompt-Optimization/cli/index.cjs' launch -- @args
}
```

把路径改成实际仓库位置；已有同名函数时保留原来的官方程序定位逻辑，在调用中通过 `launch --codex 官方codex.exe绝对路径 -- @args` 指定程序。

`codex --help`、`codex --version` 和 `exec`、`login`、`mcp` 等独立子命令转交官方程序。`--profile`、`--worktree`、`--no-daemon` 及自行指定远程服务的启动方式暂未适配，仍转交官方程序，并提示本次没有优化快捷键。直接调用 `codex.exe` 或不加载该 PowerShell 配置的终端不会经过此接入。

临时使用预览或跳过优化接入：

```powershell
codex --optimizer-preview resume
codex --optimizer-off resume
```

服务随增强会话自动管理，无需单独启动。实际优化沿用当前 Codex 登录和环境配置。

### 不接入 PowerShell 时

在仓库根目录执行：

```powershell
Push-Location cli
npm install
Pop-Location
node cli/index.cjs start --cwd D:/你的项目
```

程序查找官方 Codex，可用 `--codex` 指定 `codex.exe` 的绝对路径。使用当前 Codex 登录和环境配置，不读取或复制登录令牌。

### 预览模式

使用 `codex --optimizer-preview`、`start --mode preview`，或在设置中将应用方式改为“先预览”。写好草稿后按 Ctrl+G，面板逐步显示优化文本，并提供以下操作：

| 按键 | 操作 |
| --- | --- |
| A | 应用结果，返回 Codex 输入框；不会发送。 |
| R | 单独填写“想怎么再改”，在上一版基础上继续优化；留空则继续改善。 |
| O | 从原始输入重新生成一版。 |
| U | 恢复本次优化链的原始输入并返回 Codex。 |
| V / P | 分别查看原始输入 / 当前完整结果，可滚动对照。 |
| S | 调整优化模型、思考程度、模板、参考聊天及应用方式。 |
| ↑ / ↓ | 滚动当前列表或正文。 |
| PageUp / PageDown | 上下翻页。 |
| Home / End | 跳到顶部 / 底部；生成中 End 恢复跟随最新内容。 |
| Esc / Ctrl+C | 生成中取消；填写修改要求时放弃输入；预览中返回 Codex、保持打开面板前的草稿。 |

字母操作键无需 Enter。设置中的列表按序号选择并 Enter 确认；设置首页按 Enter 保存并返回，Esc 放弃修改。Enter 不会应用或发送聊天消息。

面板在独立终端屏幕内原位刷新，设置、列表和结果分别显示，底部固定操作提示。内容超出窗口时显示当前位置，可用以上按键滚动；调整窗口大小后重新排版。填写修改要求时，左右键移动光标，Ctrl+U 清空输入，粘贴换行按空格处理，不自动确认。

输入框为空时直接打开设置，不要求先建立聊天绑定，也不调用优化模型。按 Esc 放弃修改并返回 Codex 填写草稿。

应用后可在 Codex 输入框手动修改，检查后自行按 Enter 发送。预览模式下再次按 Ctrl+G 时，草稿仍等于刚应用的结果就直接显示预览，不会立即重复调用模型；可按 R 继续改善或 U 恢复。直接回填模式下再次按 Ctrl+G 会立即继续优化。手动改稿后重新优化会以新草稿为原文。

自动配置的 `VISUAL` / `EDITOR` 仅对这次进程生效。面板需要交互式终端，不支持将输入输出重定向到文件。已有增强入口需正常退出后重新 `start` 才能使用新协议；普通 Codex 窗口不能直接接入。

恢复已有 Codex 对话：

```powershell
node cli/index.cjs start --cwd D:/你的项目 -- resume
```

`--` 后传 Codex 的原生参数，如 `resume 对话ID`、`fork 对话ID` 或 `-m 模型ID`。本入口自己管理本地服务，暂不支持原生 `--remote`、`--no-daemon`、`--worktree` 和 `--profile`。这些用法继续使用普通 Codex。

恢复已有对话时沿用该对话的权限，不要同时传 `-s` / `--sandbox` 或 `-a` / `--ask-for-approval` 等权限覆盖参数；Codex 的 remote resume 会拒绝这些组合。

## 选择优化模型、思考程度和模板

预览中按 S 即可设置；直接回填模式可在空输入框按 Ctrl+G，或在生成中按 S 停止生成并进入设置。模板排在设置第一项，列出名称与用途，切换模板不需要连接模型服务；只有进入模型或思考程度选项时才读取模型目录。

思考程度只列出所选模型目录支持的档位；切换模型时重置为模型默认。设置首页按 Enter 保存，下一次优化使用新设置，同时保存为以后启动的偏好；应用方式在下一次按 Ctrl+G 时生效，Esc 放弃修改。设置显示未保存状态，模型目录读取失败后仍可调整模板，保存失败时保留本次编辑。

已有草稿且希望先改设置、不开始生成时，可在另一个终端执行 `node cli/index.cjs settings`，再回到对应 Codex 按 Ctrl+G。多入口时加 `--session 入口ID`。保存后按 O 从原文生成，已有结果也可按 R 继续优化。

也可继续使用命令：

```powershell
node cli/index.cjs models
node cli/index.cjs templates
node cli/index.cjs start --model 目录中的模型ID --effort high --template builtin-task --cwd D:/你的项目
```

优化模型与主聊天独立。未指定模型时，优先使用这次聊天建立时的模型，再使用 Codex 环境默认模型。支持的思考档位以 `models` 返回的目录为准；不支持的组合会停止并保留原稿。`auto` 为模型默认，`low` 简单，`medium` 适中，`high` 深入，`xhigh` 更深入；只有目录支持时才使用相应档位。

保存下次启动时使用的偏好：

```powershell
node cli/index.cjs config --effort medium --context on --timeout 90 --template builtin-basic
node cli/index.cjs config --mode direct
```

`config`、`templates`、`sessions`、`last-error` 默认显示便于阅读的中文信息；需要脚本读取时加 `--json`。`templates` 标记的是已保存的启动偏好，当前入口使用的模板以面板为准。

默认参考最近 8 轮聊天、最多 24000 字，仅取用户正文和最终回复；优先为用户要求预留一半预算，剩余空间补充助手回复。使用 `--context off` 只优化草稿。`config` 命令的修改在下一次 `start` 生效，面板设置可用于当前入口。

新建且尚未发过消息的空对话只使用草稿；开始聊天后再读取该对话的近期内容。

## 连续优化与写回保护

R 使用原始输入、上一版结果和单独填写的修改要求；上下文及配置一致时沿用独立优化会话，变化后新建优化会话并带上必要背景。不会把修改要求追加到主聊天草稿中。

生成中不改动草稿文件。直接回填、A 应用或 U 恢复前检查当前对话与原草稿，先保存备份，再通过临时文件替换；文件变化时停止覆盖。直接回填失败时显示错误并保留原稿，不自动打开预览；取消时返回并保留原稿。预览模式还会保留上一版完整结果，流式输出的片段不能直接应用。关闭未应用的预览会释放临时优化会话。

## 兼容原来的控制命令

日常操作直接使用面板即可。也保留其他终端中的控制命令：

```powershell
node cli/index.cjs continue --instructions "更简洁，保留验收条件"
node cli/index.cjs undo
node cli/index.cjs cancel
```

`continue` 和 `undo` 在另一个终端准备操作后，回到对应 Codex 按 Ctrl+G；`cancel` 可直接取消生成。面板已打开时请在面板中继续优化或恢复。以上工具命令不要输入到 Codex 的聊天正文中。

多个终端同时使用时，先运行 `node cli/index.cjs sessions`，再给控制命令加 `--session 入口ID`。入口 ID 对应启动时显示的 ID；工具不会猜测最近打开的终端或聊天。

优化错误直接显示在面板中；也可在另一个终端运行 `node cli/index.cjs last-error --session 入口ID` 查看最近原因。

## 会话与数据范围

每个入口单独启动本地服务，仅监听回环地址并要求临时认证；通过自己连接中的 `thread/start` / `thread/resume` / `thread/fork` 响应识别当前对话。不按目录挑选聊天，也不信任继承的 `CODEX_THREAD_ID`。切换会话或聊天内容变化时，中止仍未完成的优化。

优化使用独立、禁用工具的临时会话，只改写文字。模型失败、超时、附件占位改变或原稿被修改时停止写回，不自动重试、执行草稿任务或发送聊天消息。

本版保留原生图片附件占位，但**不向优化模型发送图片原图**。仅支持现有 Codex 登录后端；Claude Code、第三方 API 及完整历史回顾界面后续接入。

数据位于 `$CODEX_HOME/prompt-optimizer-cli`，未设置 `CODEX_HOME` 时位于 `~/.codex/prompt-optimizer-cli`：

- `config.json`：模型、模板、思考和上下文偏好，不保存 API 密钥。
- `runs/`：运行中的入口信息及临时认证，正常退出时移除。
- `backups/`：写回前保存的原稿与候选备份，不包含聊天记录和图片二进制；恢复针对当前入口中最近的优化，未应用的预览仅驻留内存。
- `errors/`：本次入口的最近错误，不记录模型原始协议或凭据。

CLI 依赖只安装在 `cli/`，不改变 VS Code 扩展的运行依赖和安装副本。

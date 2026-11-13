# Codex CLI 提示词优化（Rust 0.4.3 开发版）

原生入口使用 Rust、Ratatui 和 Crossterm，终端界面、事件循环、配置、供应商调用、草稿保护与 Codex 协议桥接均由 Rust 实现。可执行文件自身不需要 Node；Codex / Claude Code 登录连接仍需对应官方程序。

## Rust 构建与启动

在 Windows x64、Rust 1.94+ 环境中执行：

```powershell
cargo build --release --locked --manifest-path cli/Cargo.toml
node cli/index.cjs launch --
node cli/index.cjs launch -- resume
```

首次构建需下载 Cargo 依赖；锁文件随源码维护。内置模板直接从 `core/templates.json` 编译嵌入，独立 exe 无需携带模板文件。

`launch` 沿用原命令的转交规则，独立原生命令、帮助、版本及尚未适配的参数交给官方 Codex。原有 `node cli/index.cjs` 和已接入的 PowerShell `codex` 函数会把原生程序按文件指纹放入共享目录的 `runtimes`，再启动对应版本。构建目录的 exe 不用于长时间运行，更新时无需关闭其他窗口；找不到原生程序时明确报错。已有窗口及其 Ctrl+G 编辑器固定使用启动时的同一版本，各窗口保留独立的管道与运行记录。相同版本复用一份文件，旧运行版本保留。

CLI 偏好仍位于 `CPO_HOME`，默认是 `CODEX_HOME/prompt-optimizer-cli`（未设置 `CODEX_HOME` 时为用户 `.codex` 下的同名目录）。首次从旧 `config.json` 迁移至 `preferences-v2.json`，只保存 CLI 默认选择、模板与偏好；供应商统一保存在 `%LOCALAPPDATA%\CodexPromptOptimizer\connections.json`，不再向 CLI 偏好复制供应商池。`CPO_SHARED_HOME` 可指定共享目录，两端需使用相同设置。

API 密钥优先读取 Windows 共享凭据，兼容旧连接的环境变量引用。扩展首次启动会通过 SecretStorage API 迁移旧密钥；CLI 首次迁移时也会保存当前可读取的环境变量密钥。旧文件和扩展旧密钥保留用于恢复。更换 API 地址或服务类型需要提供新地址的密钥。当前连接、模型和思考程度按窗口独立，连接资料修改在下一次请求读取；保存冲突会保留草稿并提示重新读取。

## 原生终端界面

设置中的供应商、模型、思考程度和模板支持 ←→ 直接切换；开关左键关闭、右键开启，应用方式左键预览、右键直接回填。连接表单中的枚举项也支持 ←→。模型列表可直接输入名称或 ID 筛选，支持粘贴、退格及 Ctrl+U 清空，Enter 选择、Esc 放弃；没有匹配项时不会改变当前模型。左右切换复用本次读取的模型目录，Enter 打开列表时重新读取。

API Key 可在“管理连接 → 编辑当前连接 → API Key”直接填写，输入隐藏，已保存的密钥不回填，留空保留。填好后选择“完成编辑”，再按 Ctrl+S 保存到共享凭据存储；Esc 放弃。未保存的新 Key 也可用于获取模型目录，不会提前写入凭据存储。环境变量为可选的兼容方式，更换 API 地址或服务类型需重新提供密钥。

- 日常仍在 Codex 输入草稿，Ctrl+G 默认优化并直接回填；不会自动发送。直接模式不绘制优化器生成页，S 停止并打开设置，Esc 取消。
- 空草稿 Ctrl+G 打开设置。设置、连接表单与选择列表使用 ↑↓ 和 Enter；Esc 返回或放弃。设置的“保存并返回”或 Ctrl+S 提交保存，其余编辑先留在本次设置草稿中。
- 设置页和连接表单的模型均从当前供应商目录中选择，不提供模型文本输入。API 连接可直接使用已共享的密钥；新增连接也可填写密钥环境变量名。目录读取失败或没有可选模型时保留当前值并提示错误。
- 预览使用 `launch -- --optimizer-preview` 或设置中的“先预览”。宽窗口并排显示原文和结果；窄窗口 Tab 切换，↑↓ / PgUp / PgDn / Home / End 滚动，鼠标滚轮滚动当前正文。向上滚动暂停跟随，End 恢复。
- 预览操作为 A 回填、R 继续优化、O 从原文重新生成、U 恢复、S 设置、Esc 保留原稿返回。Enter 不应用或发送。
- R 打开多行修改要求，Enter 换行，Ctrl+S 提交继续优化，Esc 放弃；单行连接字段使用 Enter 确认。粘贴不会触发提交。
- 渲染由 Ratatui 对比缓冲区后更新；网络任务与终端输入独立处理。退出时恢复进入前的 Windows 控制台模式。

0.4.3 活动会话优化调整：允许原任务执行期间优化下一条草稿；开启参考聊天时固定本次读取的已完成轮次，继续核对这些轮次的内容，原任务完成后的新回复不混入本次优化。新一轮提交、切换会话、历史回退、压缩或草稿变化仍会使相关优化失效。

2026-11-13 交付核对：`cargo build --release --locked --manifest-path cli/Cargo.toml` 成功；`node cli/index.cjs --version` 返回 `prompt-optimizer 0.4.3`；构建产物、`native/` 副本与共享运行副本 SHA-256 一致，普通 PowerShell `codex` 函数仍经过本项目入口。新启动窗口使用新版，已有窗口继续使用各自启动时的运行副本。尚未完成主任务并行生成期间的真实优化、取消与回填验收，不代表稳定版发布。

CLI 通过 `VISUAL` / `EDITOR` 和 app-server 接入，不修改官方扩展文件，也不按 VS Code 扩展版本锁定；Codex CLI 协议或终端行为更新仍需核对兼容性。Ctrl+G 的外部编辑器退出前，原 Codex 界面等待回填，优化器接管输入；直接模式不绘制新页面也不等于原聊天可以交互滚动。滚动问题按用户要求暂不处理，0.4.3 不改变终端显示模式或滚动行为。

Rust 编辑器协议为 8。此前直接占用构建文件的旧入口需保存草稿后正常退出一次，再用 `codex` 或增强入口 `resume`；之后的窗口使用隔离版本，无需为编译关闭会话。

此前 Rust 界面验证：`cargo check --locked` 与 Release 编译通过；在 Windows ConPTY、Codex 0.167.1 中核对了空草稿设置、模板选择和保存、连接表单的中文输入和保存、非空草稿进入设置及放弃、宽窄窗口切换、返回 Codex 后继续输入和草稿保留。模型目录读取返回 8 个模型。连接表单使用独立配置目录和明确标记的占位模型，不代表供应商调用成功；当时没有发起模型推理，真实生成、流式结果、继续优化、取消生成和结果写回仍待调用验收。ConPTY 样本不代替桌面焦点与完整无闪动体验验收。

0.4.0 已用独立配置完成双窗口核对：共享连接可见，各窗口模型选择独立，旧面板保存提示冲突；两个窗口运行期间 Release 编译成功。新窗口使用更新后的文件指纹，旧窗口及其编辑器继续使用原副本。未发起模型推理，扩展宿主中的真实密钥迁移仍待重载新版扩展后核对。

其他命令沿用原入口：`config`、`templates`、`models`、`sessions`、`settings`、`continue`、`undo`、`cancel`、`last-error`、`quota`。`models` 读取当前默认连接的模型目录；日常启动继续使用 `codex` 或 `node cli/index.cjs launch --`，避免长期直接运行构建目录的 exe。

## Node 0.2 实现与历史验证记录

以下内容保留原实现的使用与验证记录，不作为 Rust 重构的运行验证结论。

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

上述历史会话测试共五次真实优化、三次明确提交的合成主聊天调用，未观察到优化草稿被额外提交。语法检查和差异检查通过。本地详细记录位于 `artifacts/cli-history-check-2026-11-09/RESULT.md`，最终故障分支证据为 `rejected-final.json` 和 `active-control-final.json`；这些原始记录不随仓库提交。

已修正的状态处理：空草稿进入设置不再要求绑定聊天；取消订阅或卸载保留原对话 ID，允许读取 `notLoaded` 的持久化历史，不自动 resume；被拒绝的 `turn/start` 恢复其预置状态且不覆盖后续通知。真正切换、断开连接、归档或删除仍使绑定失效。`thread/read` 在真实生成中也曾返回 `idle`，不能单独用它清除已订阅会话的生成标记。

尚未确认用户最新一次“仍在生成”错误是否由拒绝请求分支触发，也未还原旧历史对话状态核对错误的具体事件序列。回填后可继续编辑的 ConPTY 结果不等于 Windows Terminal 桌面焦点问题已解决；终端预览、生成中取消、S 转设置、滚动、中文/窄窗/resize 及完整无闪动体验仍待验收。编辑器退出的 stdin 清理修正不证明此前不能输入的完整原因已定位。

同日后续“修改模型和思考程度后报错”的记录实际为“原对话状态读取失败”，来自修复前启动的旧入口；目录支持所选 `gpt-6.1-terra + high`，没有证据将此次失败归因为档位不兼容。新入口已在独立 ConPTY 中完成修改设置、保存、真实优化回填及继续输入；旧报错窗口重启后的恢复效果仍待现场确认。记录见本地 `artifacts/cli-quota-check-2026-11-09/RESULT.md`。

0.1.0 已实测首次优化、继续优化、恢复原文、附件保留、双终端隔离及错误时保留原稿。取消操作只验证过初始化阶段。

后续开发修正：协议 3 的空输入设置已在同一旧入口的独立终端中验证可打开并正常退出，草稿未改动。历史分页不支持时，通过独立连接按同一 ID 读取；分页会话不再回退到完整历史读取，仅明确为 `legacy` 的会话保留该兼容路径。历史读取与生成状态拦截通过协议回归，但原窗口是否停止产生弃用警告仍待确认。

2026-11-10 的现场读取失败原因为 `thread not loaded`。已复现并修复临时会话创建响应替换原聊天绑定的问题，修复后原 ID 保持且历史可读取；缺少现场切换请求日志，不能据此断言最新现场错误已完全解决。未配置 `VISUAL` / `EDITOR` 则属于未进入优化器的启动问题，可用 `node cli/index.cjs launch -- resume` 明确经过增强入口；用户本机启动绕过的具体原因尚未确认。

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

自动配置的 `VISUAL` / `EDITOR` 仅对这次进程生效。面板需要交互式终端，不支持将输入输出重定向到文件。编辑器协议为 5，仍兼容协议 3、4 的空输入基本设置；供应商切换需要重启入口。旧入口优化非空草稿前，会提示先保存草稿、退出后通过 `codex resume` 恢复。更新源码不会热加载已运行的服务；普通 Codex 窗口不能直接接入。

恢复已有 Codex 对话：

```powershell
node cli/index.cjs start --cwd D:/你的项目 -- resume
```

`--` 后传 Codex 的原生参数，如 `resume 对话ID`、`fork 对话ID` 或 `-m 模型ID`。本入口自己管理本地服务，暂不支持原生 `--remote`、`--no-daemon`、`--worktree` 和 `--profile`。这些用法继续使用普通 Codex。

恢复已有对话时沿用该对话的权限，不要同时传 `-s` / `--sandbox` 或 `-a` / `--ask-for-approval` 等权限覆盖参数；Codex 的 remote resume 会拒绝这些组合。

## 选择优化模型、思考程度和模板

预览中按 S 即可设置；直接回填模式可在空输入框按 Ctrl+G，或在生成中按 S 停止生成并进入设置。模板排在设置第一项，列出名称与用途，切换模板不需要连接模型服务；只有进入模型或思考程度选项时才读取模型目录。

思考程度只列出所选模型目录支持的档位；切换模型时重置为模型默认。设置首页按 Enter 保存，下一次优化使用新设置，同时保存为以后启动的偏好；应用方式在下一次按 Ctrl+G 时生效，Esc 放弃修改。设置显示未保存状态，模型目录读取失败后仍可调整模板，保存失败时保留本次编辑。

设置第 6 项“API 余额（官方账单页）”或 `node cli/index.cjs quota` 请求在默认浏览器打开 [OpenAI API 账单页](https://platform.openai.com/settings/organization/billing/overview)。请在页面中选择正确的 API 组织查看余额；CLI 不读取浏览器凭据、不显示订阅限额，也不根据用量估算余额。当前核对的 [官方 API 额度说明](https://developers.openai.com/api/docs/guides/chatgpt-api-credits) 指向该页面，尚未确认可用于 CLI 直接读取余额的公开接口。

已有草稿且希望先改设置、不开始生成时，可在另一个终端执行 `node cli/index.cjs settings`，再回到对应 Codex 按 Ctrl+G。多入口时加 `--session 入口ID`。保存后按 O 从原文生成，已有结果也可按 R 继续优化。

设置第 7 项“供应商”可新增、编辑和切换 CLI 独立连接，设置首页按 Enter 才保存。支持已登录的 Codex、已登录的 Claude Code、DeepSeek、Claude API 和 OpenAI 兼容 API；每个连接保存自己的模型及思考程度。Claude Code 需填写 `.exe` 绝对路径，API 连接手动填写模型 ID、API 地址和密钥环境变量名（例如 `OPENAI_API_KEY`，不是密钥本身）。环境变量须在启动入口前设置；未读取到密钥时停止优化，不回退到其他供应商。兼容 API 可选择 `max_tokens` 或 `max_completion_tokens`。

切换只改变提示词优化器，不改变主聊天；参考聊天及草稿保护继续生效，连接变化后重新建立优化会话。连接信息保存在 CLI 的 `config.json`，不读取 VS Code 的连接或密钥。API 与 Claude Code 当前返回完整结果后显示，不提供 Codex 路径的流式预览。该功能目前完成源码接入，尚未执行真实供应商调用和终端交互验收。

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

本版保留原生图片附件占位，但**不向优化模型发送图片原图**。供应商支持范围见设置说明；完整历史回顾界面尚未接入。`models` 命令仍查询 Codex 目录，其他连接请在面板中配置模型。

数据位于 `$CODEX_HOME/prompt-optimizer-cli`，未设置 `CODEX_HOME` 时位于 `~/.codex/prompt-optimizer-cli`：

- `config.json`：模型、模板、思考和上下文偏好，不保存 API 密钥。
- `runs/`：运行中的入口信息及临时认证，正常退出时移除。
- `backups/`：写回前保存的原稿与候选备份，不包含聊天记录和图片二进制；恢复针对当前入口中最近的优化，未应用的预览仅驻留内存。
- `errors/`：本次入口的最近错误，不记录模型原始协议或凭据。

CLI 依赖只安装在 `cli/`，不改变 VS Code 扩展的运行依赖和安装副本。

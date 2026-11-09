# 来源与授权说明

## 项目来源

本项目的提示词优化按钮、优化后写回与恢复等交互思路参考了以下公开项目：

- 原项目：[jokerjiang666/codex-prompt-optimizer-button](https://github.com/jokerjiang666/codex-prompt-optimizer-button)
- 原项目介绍与讨论：[分享一个我做的 codex 小工具：Codex 提示词内容优化按钮](https://linux.do/t/topic/2920101)
- 原帖发布者：LINUX DO 用户 yunjing（云景）。原帖明确声明“完整开源，无未开源部分”。

感谢原项目及社区分享。本仓库包含 VS Code 扩展与 Codex CLI 优化入口；原桌面增强器源码与历史不包含在本仓库中。

内置模板的 8 类名称、分类及用途参考上游 [Services/TemplateLibrary.cs](https://github.com/jokerjiang666/codex-prompt-optimizer-button/blob/main/Services/TemplateLibrary.cs)，规则文本为适配本扩展重新编写；变量占位符与模板 JSON 导入格式沿用其公开约定。本仓库没有将上游桌面模板管理器的实现复制进 VS Code 扩展。

## CLI 交互参考

CLI 的流式预览、独立填写修改要求、确认后填回草稿及用户消息优先的上下文筛选，参考了 [Y1X1n/dsh-prompt-optimizer](https://github.com/Y1X1n/dsh-prompt-optimizer) 和 [ALIve114514awa/dsh-prompt-optimizer](https://github.com/ALIve114514awa/dsh-prompt-optimizer) 的公开思路。

本轮 CLI 实现重新编写，未复制或引入这两个项目的源码，也不依赖 DSH。以上链接用于保留参考来源，不将本仓库的 MIT 许可表述为这些项目的授权。

## 本仓库许可

本仓库保留创建时已有的 MIT 许可证，版权声明为 `Copyright (c) 2026 LeleHello`，完整条款见 [LICENSE](LICENSE)。

该 MIT 许可用于本仓库发布的新增实现，不将其表述为上游项目的 MIT 授权。上游来源与公开声明通过以上链接保留；引用或再分发第三方作品时，其原有版权与授权条款仍适用。

## 官方产品与模型服务

Codex、VS Code、Claude Code 及其他模型服务的版权和商标归各自权利人。本仓库不包含官方扩展的完整代码包，只提供针对已核对版本的接入脚本；相关产品与服务仍遵循其各自条款。

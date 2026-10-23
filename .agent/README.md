# 私人秘书工作区说明

`.agent/SPEC.md` 是秘书系统的行为和边界规格。`.agent` 由服务使用，普通笔记不需要维护这里的运行文件。

生产链路是 **Core → AstrBot → NapCat → QQ**：Core 管理文件、习惯、任务、调度、权限和投递；AstrBot 负责理解、提案和短文案；NapCat 负责 QQ 登录与 OneBot v11 连接。

| 位置 | 用途 |
| --- | --- |
| [config.json](config.json) | 非秘密默认配置 |
| [prompts](prompts/system.md) | 秘书身份、语言和工作规则 |
| [contracts](contracts/acceptance.md) | 领域、权限、同步和验收索引 |
| [schema.sql](contracts/schema.sql) | 最小运行数据库结构 |
| [secrets.example.env](secrets.example.env) | 只有变量名的部署示例 |

运行时由 Core 创建 `state/` 和 `data/`。它们保存习惯、任务、当天事实和短期投递状态，不属于用户可见的笔记正文，也不应手工维护。

真正的笔记仍是 Markdown：日记、周期计划、Decisions、Manual、想做清单和附件都在工作区内；不把正文复制进 SQLite 或 Agent 会话。

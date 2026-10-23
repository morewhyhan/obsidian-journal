# 私人秘书系统

[开发规格说明书](SPEC.md)是后续开发、测试和交付的唯一主规格，基线日期为 2026-10-23。

已确定：Web 云端编辑、Pi、QQ 私聊、Core 内部调度、Markdown 正文唯一真源、独立秘书业务文件、五表轻量 SQLite、私有 GitHub 自动备份。电脑与手机都通过浏览器使用服务器上的同一份资料。

先读主规格，再使用以下配套文件：

| 位置 | 用途 |
| --- | --- |
| [config.json](config.json) | 本规格确定的默认参数；不含真实密钥 |
| [prompts](prompts/system.md) | 身份、性格与日常工作规则 |
| [context/user.md](context/user.md) | 用户已明确表达的偏好与来源 |
| [contracts/schema.sql](contracts/schema.sql) | 五张运行表的结构，不保存文档正文 |
| [contracts/acceptance.md](contracts/acceptance.md) | 验收入口 |
| [secrets.example.env](secrets.example.env) | 部署变量名示例 |

`state/`将在运行时由 Core 创建，保存接受的习惯、任务、安排和当天反馈；`data/`保存短期运行记录，不是用户笔记目录。普通 Web 不展示这两个目录，用户无需维护它们。

当前交付的是规格与契约，服务尚未开发或上线。本轮不启用真实习惯、任务、QQ、调度或远端推送。产品决策已经足以开始开发；服务器、域名和真实凭据在部署时提供。

# 日常 · 私人秘书

主规格位于笔记库 `.agent/SPEC.md`。本工程与笔记数据分开，提供响应式 Web、确定性 Core、受限 AstrBot 插件、NapCat/OneBot 通道与最小 SQLite。正文始终是 Markdown；长期秘书事实是 JSON 文件；短期 SQL 表只管理运行和投递状态。

当前运行链路是 Core/AstrBot/NapCat；模型、域名、QQ 登录和私人 Git 备份都由部署环境配置。隔离验证见[验收说明](docs/ACCEPTANCE.md)，部署维护见[操作说明](docs/OPERATIONS.md)。

## 本地运行

需要 Node.js 24：

```sh
npm ci
npm run build
npm test
```

运行隔离演示库：

```sh
npm run fixture
```

演示库写入工程内 `.runtime/demo-vault-3180`，不含正式笔记或任务，也不会发送消息或推送远端。真实服务使用仓库外的独立数据目录和密钥文件。

## 真实服务

生产需要独立服务器、域名、Web 密码哈希和会话密钥、模型配置、NapCat QR 登录的机器人账号与唯一使用者，以及可选的私有 Git 远端。缺少某类接入时保持该功能关闭，不虚构成功。

Core 使用 `SECRETARY_VAULT_ROOT`、`SECRETARY_WEB_PASSWORD_HASH`、`SECRETARY_SESSION_SIGNING_KEY` 和 `SECRETARY_PUBLIC_ORIGIN`。生产启动命令为 `npm run start:production`；AstrBot 运行 `integrations/astrbot/astrbot_plugin_secretary`，NapCat 运行独立容器。

## 代码入口

- `apps/core/app.ts`：鉴权、文档与业务 API、内部模型代理。
- `apps/core/core.ts`：输入、提案、命令执行和日记联动。
- `apps/core/store.ts`：文件、SQLite、单写入和恢复。
- `packages/calendar/`：自然季度、跨年周和父级引用。
- `integrations/astrbot/astrbot_plugin_secretary/`：受限工具和 QQ 转发。
- `apps/web/`：Web 编辑器、主页、事项和助理。
- `tests/`：隔离业务、协议、恢复和浏览器测试。

新建周期笔记使用统一模板入口，不重新渲染已有正文；Decisions 和 Manual 不自动生成研究或技能内容。

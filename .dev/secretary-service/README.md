# 日常 · 私人秘书

主规格位于笔记库 `.agent/SPEC.md`。本工程与笔记数据分开，提供响应式 Web、确定性 Core、隔离 Pi SDK 适配器、QQ OneBot 通道与最小 SQLite。正文始终是 Markdown；长期秘书事实是 JSON 文件；五张 SQL 表只管理短期操作和投递。

当前为持续开发版本。已经有可运行的 Web、核心业务、Pi 协议、调度和部署产物，但**尚未完成全部规格验收，也没有连接真实模型、QQ 或私有 GitHub**。状态以 [验收记录](docs/ACCEPTANCE.md) 和 [实施记录](WORKLOG.md) 为准。

## 本地运行

需要 Node.js 24。先安装锁定依赖并构建：

```sh
npm ci
npm run build
npm test
```

启动隔离演示库：

```sh
npm run fixture
```

访问 `http://127.0.0.1:3180`，演示密码为 `local-demo-password`。数据写到工程内 `.runtime/demo-vault-3180`；这不是当前私人笔记库，不含正式习惯或任务，也不会发送消息或推送远端。示例密码只能用于本地演示。

开发前端可另外执行 `npm run dev:web`，API 代理到 3180。生产构建的 Web 由 Core 直接提供。

浏览器验收：

```sh
npm exec -- playwright install --no-shell chromium
npm run test:e2e
```

若已经安装 Chrome，可设置环境变量 `PLAYWRIGHT_CHANNEL=chrome`。浏览器测试使用独立 3187 端口及演示库，不能指向个人资料。

## 真实服务

不要直接把本地演示改成生产服务。准备独立数据目录和仓库外的密钥文件，参考 [部署说明](docs/OPERATIONS.md)。

至少需要：服务器和域名、Web 密码哈希与签名密钥、模型 ID/地址/API Key、QQ 网关与指定私聊用户、私有数据仓库与专用 SSH deploy key。缺少某类接入时保持该功能关闭，不虚构成功。

Core 启动参数由环境变量提供：`SECRETARY_VAULT_ROOT`、`SECRETARY_WEB_PASSWORD_HASH`、`SECRETARY_SESSION_SIGNING_KEY`、`SECRETARY_PUBLIC_ORIGIN`。生产启动命令是 `npm run start:production`，Pi 容器执行 `npm run start:pi:production`。可用 Node 的 `--env-file=/仓库外/secret.env`注入环境，或使用 Compose；真实密钥不能提交到工程。

`npm run password`生成 scrypt 密码哈希。交互输入在本机终端可见，不要把真实密码发送到聊天或写入命令历史。

## 数据位置

| 文件 | 用途 |
| --- | --- |
| 用户 Markdown、Attachment | 唯一正文与附件 |
| `.agent/state/registry.json` | 习惯、任务、安排、暂停、提案和绑定 |
| `.agent/state/days/*.json` | 每日行为事实及更正，不随 SQL 清理删除 |
| `.agent/data/state.sqlite` | schema_meta/documents/inbox/events/outbox，短期记录 |
| `.agent/data/core.lock/` | 有心跳的单实例锁；崩溃后15秒过期 |
| 浏览器 IndexedDB | 尚未成功提交的本机草稿 |

不要手工删除活跃 WAL/SHM 或修改运行中的状态文件。文件与 SQLite 不拥有跨介质事务；Core 通过 prepared 操作记录、原子文件替换和幂等恢复完成一致性处理。

## 代码入口

- `apps/core/app.ts`：鉴权、文档与业务 API、内部模型代理。
- `apps/core/core.ts`：输入、提案、命令执行和日记联动。
- `apps/core/store.ts`：五表存储、业务文件、单写入与恢复。
- `packages/domain/actions.ts`：习惯/任务/时间块规则。
- `packages/calendar/`：自然季度、跨年周分段及父级引用。
- `apps/pi-adapter/`：Pi SDK、显式工具白名单、内存会话。
- `apps/web/`：Web 编辑器、主页、事项和助理。
- `tests/`：隔离业务/API/SDK与真实浏览器测试。

更新已有笔记时不重渲染整篇模板，AI 只操作绑定复选框；Decisions、Manual 不自动生成研究或技能模板。

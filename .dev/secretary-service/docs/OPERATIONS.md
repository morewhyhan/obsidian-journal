# 部署、更新与恢复

本说明属于当前开发版本。未经过真实环境验证的项不得按已上线处理；见 ACCEPTANCE.md。

## 1. 准备目录

Linux 上将代码放在服务工程，数据独立放 `/srv/secretary/vault`，密钥独立放 `/etc/secretary/`。容器以 UID/GID 1000 运行，只授予数据目录所需权限。先用隔离库验证，确认后再复制自己的笔记；复制保留 Markdown 与附件，禁止对历史笔记批量套模板。

复制 `deploy/secret.env.example`和`deploy/deployment.env.example`到工程之外的受控目录，填实际值，设为仅部署用户可读。任何真实文件都不进入代码仓库或笔记仓库。

部署文件中的 NODE_IMAGE、CADDY_IMAGE 应固定通过测试的镜像 digest。当前示例保留主版本标签，尚未获得本机可用的 Registry 清单和完整容器构建证据；这项仍是上线前检查，不能把标签当固定摘要。

## 2. 配置

`secret.env`供 Core：Web 密码哈希、会话签名密钥、Pi 内部令牌、供应商模型凭据，以及 QQ、私有数据远端配置。设置 `SECRETARY_QQ_ENABLED=1`或`SECRETARY_GIT_ENABLED=1`才启用对应接入。

`deployment.env`供 Compose：域名、主机数据目录、secret 文件位置、SSH key/known_hosts 路径，以及 Pi 的内部令牌和模型 ID（与 secret.env 相同）。不把供应商 Key 交给 Pi。

QQ 网关独立运行，只开放到 Core 能访问的受限网络，采用 OneBot v11 正向 WebSocket。指定机器人 ID 与私聊用户 ID；网关账号会话不挂载给 Core 或 Pi。接入后必须实测主动发送、消息 ID、引用回复、超时和断线。

Git 使用仅能访问目标私有数据仓库的 deploy key，配已核验的 known_hosts。不要复用全账户权限密钥。生产数据仓库的忽略规则与模板不同：日记、附件、state、context 必须纳入，数据库、密钥、日志、`.dev/`和 Obsidian workspace 必须排除。

## 3. 启动

```sh
docker compose --env-file /etc/secretary/deployment.env -f deploy/compose.yaml config --quiet
docker compose --env-file /etc/secretary/deployment.env -f deploy/compose.yaml build core
docker compose --env-file /etc/secretary/deployment.env -f deploy/compose.yaml up -d
docker compose --env-file /etc/secretary/deployment.env -f deploy/compose.yaml ps
```

只有 Caddy 暴露 80/443。Core、Pi 端口不映射到公网；Caddy 拦截 `/internal/*`、`/healthz`和`/readyz`。Pi 仅在 internal 网络，无用户数据卷，模型请求经 Core 的固定供应商代理。

Core 启动时先校验配置、获得单实例锁、恢复操作，再开放业务与调度。异常退出留下的目录锁有15秒过期窗口；不要同时启动两个 Core。Compose 自动重启会在锁过期后继续尝试，不要直接删运行中的锁。

## 4. 更新

先在测试数据卷运行自动化验收，停止旧 Core，再更新服务镜像。保留数据卷、secret 文件和之前的服务镜像。不要执行删除数据卷的命令。数据库 schema 迁移必须先做隔离恢复演练，不能在未知版本上覆盖建表。

## 5. 正文恢复

优先使用 Web 版本历史读取某次 Git 内容，再作为新的保存提交；不要 reset 正在运行的资料库。网页草稿在当前浏览器，发生冲突时保留草稿和服务器内容，人工合并后保存。

删除的笔记进入 `.agent/data/trash/`短期恢复区，7天内保留；用户无需管理该目录。恢复区界面仍在补齐，开发阶段应停止服务后根据同名 JSON 中的原始相对路径恢复，并校验不覆盖已有文件；不得以此替代最终界面验收。

## 6. 更换服务器或数据库丢失

停止旧服务，确认最新私有 Git 推送成功。在新服务器检出数据文件，重新注入密钥。SQLite 不从 Git 取回：正文和长期事实存在，但刚发的消息回执和未处理输入可能丢失；必须保守重建，不补发当天旧提醒。

损坏数据库由 Core 隔离为 quarantine 文件，不覆盖原文件。不要手动删除活跃 WAL/SHM。正常情况下不需要用户定期维护运行记录，系统自动清理。

## 7. 运行观察

Web“设置与状态”查看调度、QQ、模型是否配置、最后提交/推送、运行库大小和恢复期。`docker compose logs --tail 100 core`仅用于必要诊断，不应包含正文或密钥。生产日常不需要打开后台，更不要求用户每日打分或汇报维护状态。

正常保存与 GitHub 备份是两件事：远端不可用时本地继续保存，备份状态降级。远端非快进冲突时停止推送，不能 force push 或自动用一侧覆盖另一侧。

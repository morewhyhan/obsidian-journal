# 部署与维护

服务代码和私人笔记必须分开。复制 `deploy/deployment.env.example` 与 `deploy/secret.env.example` 到部署目录，在仓库外填写域名、数据目录、Web 会话密钥、模型配置、AstrBot bridge 令牌、NapCat 令牌和两个 QQ 账号；文件设为仅部署用户可读，禁止提交到 Git。

## 启动

```sh
docker compose --env-file /etc/secretary/deployment.env \
  -f deploy/compose.yaml up -d --build
```

Core 只挂载笔记根目录。AstrBot 不挂载笔记、SQLite、Git、密钥或宿主路径，只通过内部 bridge 调用 Core；NapCat 只负责 QQ 登录和 OneBot v11 连接。NapCat WebUI 默认只绑定回环地址，扫码状态和会话只留在 NapCat 卷。

## 数据与备份

- Markdown 和 Attachment 是正文；`.agent/state/` 是长期秘书事实；SQLite 是短期运行状态。
- 不要手工删除活跃的 WAL/SHM、锁目录或 state 文件。
- 启用 Git 备份前先校验远端是指定的私有数据仓库，并使用仓库专用 SSH deploy key 和 known_hosts。
- 冲突时停止推送、保留双方，不强推、不自动覆盖；服务器仍可继续保存本地文件。

## 日常检查

检查 Core、AstrBot 和 NapCat 的健康状态，确认最近 tick、模型自检、QQ 连接、最后备份和恢复计数。日志默认不输出日记正文、消息正文、提示词、令牌或密码。生产不需要用户打开后台或每日维护运行状态。

SQLite 损坏时由 Core 隔离原文件并暂停旧主动投递；安全的纯 Markdown 保存仍可继续。重启时先恢复未完成操作，再恢复调度；未知投递不盲目重发。

## 更新与故障

先在隔离库运行 `npm run check && npm test && npm run build`，再构建镜像并滚动更新。QQ 不可用时 Web 和文件编辑仍应可用；模型不可用时不承诺已执行；Git 不可用时本地保存继续，状态显示备份延迟。恢复前保留原日志和被隔离数据库，不覆盖现场。

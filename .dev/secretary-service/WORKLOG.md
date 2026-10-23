# 实施记录

唯一主规格：../../.agent/SPEC.md。工程独立于用户笔记；只使用隔离夹具，不读取真实日记正文、不连接真实账号、不推送私人仓库。

## 当前发布状态（2026-10-23）

- 本地仓库已清理为可复用模板：历史私人年份目录、日记正文和个人任务已移除；模板、空的总体目标、Agent 规格与服务工程保留。
- 清理后的 `master` 已通过 WSL Git 推送到 `morewhyhan/obsidian-journal`；服务器 `/opt/secretary-release` 已快进到同一提交，笔记工作副本位于 `/srv/secretary/vault`。
- 服务器已完成 Node 24 Docker 镜像构建并运行 Compose 的 Core/Pi 服务；Git 运行时备份按当前配置关闭，凭据保存在仓外的 `/etc/secretary/secret.env`（600 权限）。
- 当前模型为 `deepseek-flash`，Pi 开启思考并固定 Low；Core 在供应商边界强制 `thinking.enabled + reasoning_effort.low`，并将思考模式不接受的 `tool_choice: required` 兼容为 `auto`。
- QQ 官方协议已真实连接并完成绑定；服务器状态接口实测 Core/Pi 自检通过、调度正常、SQLite 运行正常。公网服务仍未启动：域名/HTTPS 入口尚未确定，服务器现有 Caddy 已占用 80/443；避免覆盖现有服务。

## 已完成的实作

- Web/Core/五表SQLite/长期JSON事实、Pi官方SDK与QQ OneBot、调度、日记投影、Git备份、维护和部署文件已有可运行代码；不是静态原型。
- 修复幂等、批量同版本更新、计数与成果区分、工具实物证据、并发接受提案、发送前复核与领取、unknown预算、跨午夜引用、失库抑制和旧消息不重放。
- 加入习惯/任务显式关联、确认偏好与可重建摘要。日记行删除解绑、改名/重复待关联；笔记重命名及引用修复、删除恢复有可恢复操作。历史正文和用户模板未批量改写。
- 完整本地协议闭环已通过：Web → Core → Pi SDK → 固定模型代理 → 本机OneBot网关 → 反馈 → 日记 → 暂停。供应商与QQ网关为桩，不能当真实接入成功。
- Git隔离裸仓库测试覆盖本地提交/断线/非快进/私有核验失败/长期state与附件/旧目录映射，禁止强推和整库暂存。未对真实数据仓库初始化或推送。
- OpenAPI/JSON Schema由实际路由生成。已加机器凭据边界、日志脱敏与清理、SSE优雅关闭、转发IP限制、模板符号链接防护、未知SQL版本拒绝。

## 最近验证

- Windows 最新一次全量为98项测试通过；服务改动已通过 Node/TypeScript/Docker 生产构建，并在服务器真实容器中完成 Pi 结构化提案与模型代理验证。
- Chromium八项真实浏览器测试通过；新增Git版本预览/恢复用例待复验。
- WSL Linux / Node24.11.0：88项测试通过（历史快照）；本轮模型适配通过生产构建及服务器真实自检，未把无法在裁剪后生产镜像中运行的 Vitest 结果伪称为通过。
- 2核/2GiB约束已从cgroup实测：5000篇、100MiB；首次搜索261.62ms，读取p95 5.16ms，保存p95 22.03ms。证据 docs/evidence/performance-linux-2c-2g.json。
- Node Linux官方包SHA256已核验，保存在忽略的.runtime/linux-tools；Linux工程在/var/tmp/secretary-linux-validation，脚本可重跑，不替换系统Node。/tmp会在WSL重新启动时清空，不能依赖它持久保存运行时。

## 已确认外部限制

- Docker CLI可用，Compose静态解析通过；引擎未启动。backend.error.json确认遗留run/dockerInference端点无法访问；无Docker进程时非递归Remove-Item也失败。未删除或改动Docker镜像/容器/卷/数据盘。停止盲目重启。
- 官方Docker Registry连接超时；镜像摘要、镜像构建、容器挂载/网络隔离及容器重启尚未验证，不能声称已部署。
- Windows 本地 Docker 引擎仍未启动；服务器容器已启动并通过健康检查，公网域名/HTTPS 仍未配置，尚未进行主动 QQ 消息发送联调。

## 接续

1. 完成新增Git历史浏览器验证，处理最终全量与构建错误。
2. 补齐契约导出、配置预检、容器验收脚本与简明运维/使用说明，核对主规格40项。
3. 更新 docs/ACCEPTANCE.md，逐项区分本地证据、真实接入、容器验证。
4. 在可用Linux Docker和真实部署输入具备后构建、隔离、重启与实际联调；未全部达标保持Goal进行中。

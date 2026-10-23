# Agent 选择已经确定

生产使用 **AstrBot**，通过本项目受限插件运行秘书回合；NapCat 是 QQ 的 OneBot v11 适配器。完整集成、权限和接口见主规格迁移附录及服务代码。

AstrBot 在独立容器中调用四个显式工具：`get_context`、`secretary`、`workspace`、`submit_proposal`。Core 承担业务事实、调度、权限、文件和消息；AstrBot 不挂载笔记卷、不接触密钥，也不能直接发送 QQ 消息。

具体模型账号、模型 ID 和网关地址是部署输入，通过内部模型代理接入，不改变业务架构。

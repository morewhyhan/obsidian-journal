# 验收说明

这份说明只定义如何验收，不保存真实服务器地址、QQ 账号、消息正文或密钥。详细边界以仓库根目录的 `.agent/SPEC.md` 为准。

## 本地隔离验证

```sh
npm ci
npm run check
npm test
npm run build
```

浏览器测试使用独立演示库和端口：

```sh
npm exec -- playwright install --no-shell chromium
npm run test:e2e
```

本地通过只说明代码和模拟链路可用，不能代替真实模型、QQ、域名、私有 Git 或生产容器验证。

## 真实环境检查

1. Core 的数据根目录与服务代码分离，启动前通过 preflight。
2. Web 使用 HTTPS、单用户登录和正确 Origin；Web 与 QQ 操作同一工作副本。
3. AstrBot 只加载本插件，NapCat 已扫码登录机器人账号，唯一使用者的私聊事件能进入 Core。
4. DeepSeek 或其他模型只通过 Core 的固定内部代理访问，供应商密钥不出 Core。
5. 真实验证主动发送、消息 ID、引用回复、断线、未知投递和暂停，不将模拟成功写成真实成功。
6. 若启用 Git，验证目标为私有数据仓库，Markdown、附件和长期状态纳入备份，数据库、密钥、日志和服务代码排除。

缺少域名、模型、QQ 登录或私有 Git 凭据时，只标记对应项目为未验证，不伪造成功。

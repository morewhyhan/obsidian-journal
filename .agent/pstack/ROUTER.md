# pstack 在本项目中的路由

## 1. 所有开发任务先判断类型

| 当前任务 | 使用的上游 skill 或 playbook | 本项目的落点 |
| --- | --- | --- |
| 只想了解代码或设计原因 | `how`、`why`、`teach` | 先读真实代码、合同和测试，不凭文档推断已实现 |
| 新功能或行为变化 | `architect`、`feature` | 先写数据形状、边界和失败条件，再改 `.dev/secretary-service` |
| 已知 bug | `bug-fix`、`tdd` | 先在相同入口复现，再写失败测试和最小修复 |
| 跨模块架构改动 | `architect`、`arena`、`interrogate` | 比较候选方案，记录选择，检查所有调用方 |
| 性能或响应变慢 | `perf-issue`、`benchmark-checklist` | 先记录分阶段耗时，不用总耗时猜根因 |
| 需要验证真实用户流程 | `create-verification-skill`、`maintain-verification-skill` | 使用 `.dev/secretary-service` 的实际启动和测试入口，保留证据路径 |
| 任务完成后的经验沉淀 | `reflect`、`correct` | 只有重复出现的经验才进入项目规则、测试或脚本 |
| 需要并行探索 | `swarm` 或 `arena` | 只在任务真的可分割时使用；先定义每个分支的交付和合并规则 |
| 写研究、架构或交付文档 | `technical-writing`、`unslop` | 文档必须能指向实现、验证或明确的未决问题 |

默认从 `poteto-mode` 的路由思想开始，但不机械复制它的 Cursor 命令。简单改动不需要人为套完整流程。

## 2. 当前项目的固定检查

服务代码改动默认在 `.dev/secretary-service` 执行：

```text
npm run contracts
npm run check
npm test
```

涉及真实浏览器流程时再运行 `npm run test:e2e`。涉及 QQ、NapCat、AstrBot、模型或服务器时，必须区分模拟验证和真实联调，不能用模型桩或静态回复宣称真实链路通过。

## 3. pstack 原则如何翻译到本项目

| 上游原则 | 当前项目的具体要求 |
| --- | --- |
| model the domain | Task、Habit、Schedule、Work、Run、Delivery 不混成一个状态字段 |
| boundary discipline | 外部消息、模型输出、工具参数在入口解析；核心业务不依赖 QQ 文本 |
| make operations idempotent | 任务创建、文件提交、提醒投递和恢复都带操作身份 |
| separate before serializing shared state | 不用一把全局锁串住模型等待；短提交协调，长执行让出容量 |
| prove it works | 检查文件、数据库、实际投递和用户可观察结果，不只看模型回答 |
| test behavior, not implementation | 断言“用户交代后发生什么”，不锁死内部函数调用顺序 |
| fix root causes | 重复出现的问题优先修数据边界、类型、检查和脚本，最后才补提示词 |
| encode lessons in structure | 可机械检查的经验进入测试、类型、命令或规则，不只写在聊天里 |

## 4. 明确不能直接搬入的部分

- 不把 pstack 的工程原则、Cursor 专用命令和模型分工写入 QQ 助理的 persona。
- 不假设本项目拥有 Cursor Cloud Agent、Bugbot、自动合并、Tailscale 或外部项目管理系统。
- 不因为上游有 58 个 skill 就为当前服务增加 58 个运行时工具。
- 不把 `poteto-mode` 的“并行”理解成可以绕过 Core 的授权、版本和提交入口。
- 不把上游 README、技能文本或原型的验证结果写成当前项目已经通过。

## 5. 完成一项开发任务的最低交付

交付必须包含目标、改动范围、验证命令、实际结果和未验证项。跨模块任务还要说明数据如何流动、旧操作怎样失效、失败后怎样恢复。没有这些证据，任务只能标记为进行中。

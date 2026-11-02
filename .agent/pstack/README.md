# pstack 项目适配层

这里不是 pstack 的复制品，而是当前仓库对它的接入说明。

上游完整源码在 [../vendor/cursor-plugins/pstack](../vendor/cursor-plugins/pstack)，来源与抓取版本见 [../vendor/pstack-SOURCE.md](../vendor/pstack-SOURCE.md)。上游技能保持原样，便于更新和对照；本项目的约束、路径和验证命令只写在这里。

## 它在本项目里负责什么

pstack 管理“怎样进行可靠的软件开发”：先理解问题，设计边界，写最小改动，验证真实行为，记录可复用的经验。

它不进入 QQ 助理的运行提示词。QQ 助理只使用 `.agent/prompts` 中的产品角色、对话规则和工作流。把工程技能全部加入用户助理上下文，会增加无关上下文，也会让用户得到工程化的回答。

## 使用入口

遇到非平凡开发任务，按 [ROUTER.md](ROUTER.md) 选择上游 skill。默认入口是上游的 `skills/poteto-mode/SKILL.md`；当前环境没有 Cursor 的 `/add-plugin` 菜单，因此使用本地文件路径和本项目命令执行同样的步骤。

适配层只改变三件事：项目路径、产品边界和可实际运行的验证命令。它不把 Cursor、Grok、Cloud Agent、Bugbot 或自动合并能力假装成本项目已有能力。

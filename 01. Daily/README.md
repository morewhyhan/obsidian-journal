# 🗓 日记
[首页](../MOC.md) · [[02. Decisions/README|Decisions]] · [[03. Manual/README|Manual]] · [[灵感]]

这里安排日常生活、记录行动、经历与感受，并通过周、月、季、年计划接续推进。笔记按实际日期放入年、季、月、周目录。

热力图在[主页](../MOC.md#记录日历)。这里用于查找日记和按年浏览。

## 🧭 日记目录

~~~dataviewjs
const plugin = app.plugins.plugins['light-okr'];
if (plugin?.engine) await plugin.engine.home(dv);
else dv.paragraph('日记联动尚未加载。请启用「轻量 OKR 联动」，或重载 Obsidian；已有笔记仍可从左侧文件夹打开。');
~~~

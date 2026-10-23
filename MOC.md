---
cssclasses:
  - journal-home
aliases:
  - 主页
---

# 主页

```dataviewjs
const plugin = app.plugins.plugins['light-okr'];
if (plugin?.dashboard) await plugin.dashboard.start(dv);
else dv.paragraph('主页联动尚未加载。请在「设置 → 第三方插件」启用「轻量 OKR 联动」，或重载 Obsidian。');
```

## 记录日历

写过日记的日子，会在这里点亮。

```contributionGraph
graphType: default
dateRangeType: LATEST_YEAR
dateRangeValue: 1
startOfWeek: "1"
showCellRuleIndicators: false
dataSource:
  type: PAGE
  value: '"01. Daily"'
  dateField:
    type: FILE_NAME
    format: yyyy-MM-DD
  countField:
    type: DEFAULT
fillTheScreen: true
enableMainContainerShadow: false
cellStyleRules:
  - id: diary
    min: "1"
    max: "1000"
    color: "#8ea6c8ff"
cellStyle:
  minWidth: 13px
  minHeight: 13px
```

## 三个板块

```dataviewjs
const plugin = app.plugins.plugins['light-okr'];
if (plugin?.dashboard) plugin.dashboard.navigation(dv);
else dv.list([
  dv.fileLink('01. Daily/README', false, 'Daily · 日记与计划'),
  dv.fileLink('02. Decisions/README', false, 'Decisions · 问题研究'),
  dv.fileLink('03. Manual/README', false, 'Manual · 技能手册')
]);
```

## 最近的日记

```dataviewjs
const plugin = app.plugins.plugins['light-okr'];
if (plugin?.dashboard) plugin.dashboard.recent(dv);
else {
  const pages = dv.pages('"01. Daily"')
    .where(p => p.type === 'daily' || /^\d{4}-\d{2}-\d{2}$/.test(p.file.name))
    .sort(p => p.file.name, 'desc').slice(0, 5);
  if (pages.length) dv.list(pages.map(p => p.file.link));
  else dv.paragraph('还没有日记。');
}
```

---

[仓库说明](README.md)

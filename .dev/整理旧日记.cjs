const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const assert = require('assert/strict');
const core = require('../.obsidian/plugins/light-okr/core');
const root = path.resolve(__dirname, '..');
const backup = path.join(root, '.local', '日记整理');
const sources = [
  {name: '日记', root: 'C:/Users/why/Documents/日记'},
  {name: '原库日记', root: 'C:/Users/why/Documents/example-obsidian-library-of-dice/01. Daily'}
];
const slash = p => p.replaceAll('\\', '/');
const hash = s => crypto.createHash('sha256').update(s).digest('hex');
const normalize = s => s.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').trim();
const nodes = new Map(), records = [], duplicateMap = new Map(), aliases = new Map();
const issues = [], extraLinks = new Map(), assetCopies = new Map();
function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, {withFileTypes: true})) {
    if (e.isSymbolicLink()) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!['.git', '.obsidian', '.trash', 'node_modules'].includes(e.name)) walk(p, out);
    } else out.push(p);
  }
  return out;
}
function validDate(year, month, day) {
  const s = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  core.parse(s);
  return s;
}
function note(kind, date) {
  const target = core.route(kind, date);
  if (!nodes.has(target)) {
    const actual = core.identify(target).date;
    nodes.set(target, {target, kind, date: actual, sections: new Map(), habits: new Map(), sources: new Set()});
    const parents = {daily: ['monthly', 'weekly'], weekly: ['monthly'], monthly: ['quarterly'], quarterly: ['yearly'], yearly: []};
    for (const parent of parents[kind]) note(parent, actual);
  }
  return nodes.get(target);
}
function extra(target) {
  if (!nodes.has(target)) nodes.set(target, {target, kind: 'extra', sections: new Map(), habits: new Map(), sources: new Set()});
  return nodes.get(target);
}
function put(n, section, text, rec, label = '') {
  text = normalize(text);
  if (!text) return;
  if (!n.sections.has(section)) n.sections.set(section, []);
  const blocks = n.sections.get(section);
  if (!blocks.some(b => normalize(b.text) === text)) blocks.push({text, label, source: rec});
  rec.targets.add(n.target); n.sources.add(rec.id);
}
function stripFront(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---(?:\n|$)/);
  return {body: m ? text.slice(m[0].length) : text, front: m ? m[1] : ''};
}
function cleanOld(text, reference) {
  let {body} = stripFront(normalize(text));
  if (!reference) return body;
  body = body.replace(/^([ \t]*)(`{3,}|~{3,})(contributionGraph|dataviewjs|dataview|tracker|habits)\b[^\n]*\n[\s\S]*?^\1\2[ \t]*$/gm, '');
  return body.split('\n').filter(line => {
    if (/^\s*(?:#Note\/\S+\s*)+$/.test(line) && line.trim().split(/\s+/).every(t => /^#Note\/life\/(?:daily|weekly|monthly|quarterly|yearly|20\d{2}\/(?:weekly|month|phase)(?:\/\S+)?)$/.test(t))) return false;
    if (/^\s*(?:weeknote|daynote|Score|Study Score|Entertainment Score|Habit Score)::/.test(line)) return false;
    if (/^\s*>\s*(?:\[![^\]]+\].*|!\[\[.*\]\]|)$/.test(line)) return false;
    const rest = line.replace(/!?\[\[[^\]]+\]\]/g, '').replace(/[\s|<>:—-]/g, '');
    if (line.includes('[[') && !rest) return false;
    if (/^\s*\|[\s|:-]*$/.test(line)) return false;
    return true;
  }).join('\n');
}
// Each segment holds only its own text; heading ancestry identifies its original purpose.
function segments(text) {
  const out = [], stack = [];
  let current = {title: '', ancestry: [], lines: []}, fence = null;
  for (const line of text.split('\n')) {
    const f = line.match(/^\s*(`{3,}|~{3,})/);
    if (f) fence = fence ? (f[1][0] === fence ? null : fence) : f[1][0];
    const m = !fence && line.match(/^(#{1,6})\s+(.+?)\s*$/);
    if (m) {
      out.push({...current, body: current.lines.join('\n')});
      while (stack.length && stack.at(-1).level >= m[1].length) stack.pop();
      stack.push({level: m[1].length, title: m[2]});
      current = {title: m[2], ancestry: stack.map(s => s.title), lines: []};
    } else current.lines.push(line);
  }
  out.push({...current, body: current.lines.join('\n')});
  return out;
}
function dateLine(line, year) {
  const s = line.replace(/^#{1,6}\s*/, '').trim();
  let m = s.match(/^(20\d{2})\s*(?:年|[./-])\s*(\d{1,2})\s*(?:月|[./-])\s*(\d{1,2})\s*(?:日|号)?(?:\s*[（(][^）)]*[）)])?\s*$/);
  if (m) return validDate(+m[1], +m[2], +m[3]);
  m = s.match(/^(\d{1,2})\s*月\s*(\d{1,2})\s*(?:日|号)?(?:\s*[（(][^）)]*[）)])?\s*$/);
  return m ? validDate(year, +m[1], +m[2]) : null;
}
function splitDated(text, year) {
  let current = {date: null, lines: []}, fence = null;
  const chunks = [];
  for (const line of text.split('\n')) {
    const f = line.match(/^\s*(`{3,}|~{3,})/);
    if (f) fence = fence ? (fence === f[1][0] ? null : fence) : f[1][0];
    const d = !fence && dateLine(line, year);
    if (d) { chunks.push({...current, body: current.lines.join('\n')}); current = {date: d, lines: []}; }
    else current.lines.push(line);
  }
  chunks.push({...current, body: current.lines.join('\n')});
  return chunks;
}
function cleanLabel(title) { return title.replace(/^[^\p{L}\p{N}]+/u, '').trim(); }
function daily(rec, date, body) {
  const n = note('daily', date);
  rec.targets.add(n.target); n.sources.add(rec.id);
  if (!normalize(body)) return;
  const known = /今日待办|今日任务|普通待办|长期习惯|今日反思|📍Task|Shortcoming|Realisation|Memos|Academic gains|Interesting gains|art of inside and out/;
  if (!known.test(body)) { put(n, '# 随笔', body, rec); return; }
  const parts = segments(body);
  for (let i = 0; i < parts.length; i++) {
    const s = parts[i];
    if (!normalize(s.body)) {
      // Preserve meaningful user headings, but omit empty fields from the old daily template.
      const boilerplate = /^(?:➤ Direction|😉 Get already\?|🤔 Review|🌾 Gains|⚡️Academic gains|🌸 Interesting gains|🥺Shortcoming|🌌 Realisation|🪄Memos|❤️ The art of inside and out|📍Task|今日待办|今日任务|普通待办|长期习惯|今日反思|明日计划)$/;
      if (s.title && !boilerplate.test(s.title) && !(parts[i + 1]?.ancestry.length > s.ancestry.length)) put(n, '# 随笔', s.title, rec);
      continue;
    }
    const p = s.ancestry.join(' / ');
    const section = /长期习惯/.test(p) ? '# 习惯' : /普通待办|今日待办|今日任务|📍Task/.test(p) ? '# 任务' : /Shortcoming|改进措施/.test(p) ? '# 改进' : /今日反思|Realisation|art of inside and out/.test(p) ? '# 禅' : '# 随笔';
    const label = /^(?:普通待办|长期习惯|📍Task|🥺Shortcoming|🌌 Realisation|🪄Memos)$/.test(s.title) ? '' : cleanLabel(s.title);
    put(n, section, s.body, rec, label);
  }
}
function parseHabits(rec, date) {
  const front = stripFront(rec.text).front;
  const n = note('daily', date);
  for (const line of front.split('\n')) {
    const m = line.match(/^\(🍭\d+\)\s*([^:]+):\s*(true|false)\s*$/);
    if (m) n.habits.set(m[1].trim(), (n.habits.get(m[1].trim()) || false) || m[2] === 'true');
  }
}
const focusTitle = {weekly: '# 本周重点', monthly: '# 本月重点', quarterly: '# 本季重点', yearly: '# 今年重点'};
const reviewTitle = {
  weekly: '## 本周重点推进到哪了？', monthly: '## 本月重点推进到哪了？',
  quarterly: '## 本季重点推进到哪了？', yearly: '## 这一年有哪些重要经历和变化？'
};
const nextTitle = {
  weekly: '## 下周接着做什么，准备怎么做？', monthly: '## 下个月优先做什么，减少什么？',
  quarterly: '## 下季度集中做什么？', yearly: '## 明年想把时间留给什么？'
};
function period(rec, kind, date, body, annotation = '') {
  const n = note(kind, date);
  rec.targets.add(n.target); n.sources.add(rec.id);
  if (annotation) put(n, reviewTitle[kind], annotation, rec);
  let parts = segments(body);
  // Heading-free old plans are still genuine planning text.
  if (parts.length === 1) { put(n, focusTitle[kind], body, rec); return; }
  for (const s of parts) {
    let text = normalize(s.body), label = cleanLabel(s.title);
    if (/^(?:目标|关键结果)[：:]/.test(s.title)) {
      const embedded = s.title.replace(/^(?:目标|关键结果)[：:]\s*/, '');
      if (embedded) text = embedded + (text ? '\n\n' + text : '');
      label = s.title.startsWith('目标') ? '原主题' : '原阶段记录';
    }
    if (!text) continue;
    const p = s.ancestry.join(' / ');
    let section = /未来计划|下周计划|明年.*期望/.test(p) ? nextTitle[kind] : /关键结果/.test(p) ? reviewTitle[kind] : /业绩目标|目标[：:]|最高优先级|最值得将时间|核心目标/.test(p) ? focusTitle[kind] : reviewTitle[kind];
    if (kind === 'weekly' && /值得将时间|困难|教训|缺点|不值得/.test(p) && !/最高优先级/.test(p)) section = '## 什么做法有效，什么问题反复出现？';
    if (kind === 'monthly' && /缺点|困难|不值得/.test(p)) section = '## 时间和精力花得合适吗？';
    put(n, section, text, rec, label);
  }
}
function registerAlias(rec) {
  if (!rec.primary) return;
  for (const a of [rec.relative, rec.relative.replace(/\.md$/, ''), path.basename(rec.file), path.basename(rec.file, '.md')]) {
    if (!aliases.has(a)) aliases.set(a, new Set());
    aliases.get(a).add(rec.primary);
  }
}
function processRecord(rec) {
  const basename = path.basename(rec.file, '.md');
  const text = cleanOld(rec.text, rec.source === '原库日记');
  let m;
  if (basename === 'MOC' || /(?:日记模板|日记模版)$/.test(basename)) {rec.status = '仅保留原件（旧入口或旧模板）'; return;}
  if (/^20\d{2}-\d{2}-\d{2}$/.test(basename)) {
    core.parse(basename); daily(rec, basename, text); parseHabits(rec, basename); rec.primary = core.route('daily', basename);
  } else if ((m = basename.match(/^(20\d{2})-W(\d{2})$/))) {
    const jan4 = core.date(+m[1], 1, 4), start = core.add(jan4, 1 - (jan4.getUTCDay() || 7) + (+m[2] - 1) * 7);
    const date = core.iso(start); assert.equal(core.week(start).key, basename);
    period(rec, 'weekly', date, text); rec.primary = core.route('weekly', date);
  } else if ((m = basename.match(/^(20\d{2})-M(\d{2})$/))) {
    const date = validDate(+m[1], +m[2], 1); period(rec, 'monthly', date, text); rec.primary = core.route('monthly', date);
  } else if ((m = basename.match(/^(20\d{2})-Q0?([1-4])$/))) {
    const date = validDate(+m[1], (+m[2] - 1) * 3 + 1, 1); period(rec, 'quarterly', date, text); rec.primary = core.route('quarterly', date);
  } else if ((m = basename.match(/^(20\d{2})-Overview$/))) {
    const date = `${m[1]}-01-01`; period(rec, 'yearly', date, text); rec.primary = core.route('yearly', date);
  } else if (basename === '长期待办任务') {
    put(extra('总体目标.md'), '# 以前记录的方向和待办', text, rec); rec.primary = '总体目标.md';
  } else if ((m = basename.match(/^(20\d{2})-(\d{1,2})$/))) {
    const year = +m[1], month = +m[2];
    for (const c of splitDated(text, year)) {
      if (!normalize(c.body)) continue;
      if (!c.date) {put(extra(`01. Daily/${year}年/第${Math.ceil(month / 3)}季度/${String(month).padStart(2, '0')}月/未注明日期的记录.md`), '# 原记录', c.body, rec); continue;}
      const pieces = c.body.split(/\n---\s*\n(?=\s*（无日期，承接上文）)/);
      daily(rec, c.date, pieces.shift().replace(/\n---\s*$/, ''));
      for (const unknown of pieces) {
        const folder = path.posix.dirname(path.posix.dirname(core.route('daily', c.date)));
        const target = folder + '/未注明日期的记录.md';
        put(extra(target), '# 原记录', unknown.replace(/\n---\s*$/, ''), rec, `原文位于 ${c.date} 之后，具体日期未注明`);
        if (!extraLinks.has(folder)) extraLinks.set(folder, new Set()); extraLinks.get(folder).add(target);
      }
    }
    rec.primary = core.route('monthly', validDate(year, month, 1)); note('monthly', validDate(year, month, 1));
  } else if (/月\d{1,2}日?[-—]/.test(basename) || basename === '寒假okr') {
    const winter = basename === '寒假okr';
    const year = winter ? 2026 : +(rec.relative.match(/(20\d{2})年/) || [])[1];
    assert(year);
    const first = winter ? [null, '1', '1'] : basename.match(/^(\d{1,2})月(\d{1,2})/);
    assert(first, rec.relative);
    const date = validDate(year, +first[1], +first[2]);
    const marker = /(^##\s*状态指标\s*$)/m.exec(text);
    const plan = winter ? splitDated(text, year).filter(c => !c.date).map(c => c.body).join('\n') : marker ? text.slice(0, marker.index) : text;
    const diaryPart = winter ? text : marker ? text.slice(marker.index + marker[0].length) : '';
    const annotation = winter ? '原寒假计划位于旧库 2025 年末的跨年阶段，按上下文归入 2026 年 1 月；原文保留，目标不代表当前建议。' : `原记录范围：${year}年 ${basename}；旧文件可能跨多个自然周，明确日期的正文已分别放入当天日记。`;
    period(rec, winter ? 'monthly' : 'weekly', date, plan, annotation);
    for (const c of splitDated(diaryPart, year)) {
      if (!normalize(c.body)) continue;
      if (c.date) daily(rec, c.date, c.body.replace(/\n---\s*$/, ''));
      else if (!winter) put(note('weekly', date), reviewTitle.weekly, c.body, rec, '原状态记录（未注明日期）');
    }
    rec.primary = core.route(winter ? 'monthly' : 'weekly', date);
  } else if (/^(?:月OKR|月目标)$/.test(basename)) {
    const year = +(rec.relative.match(/(20\d{2})年/) || [])[1], month = +(rec.relative.match(/\/(\d{1,2})月\//) || [])[1];
    const date = validDate(year, month, 1); period(rec, 'monthly', date, text); rec.primary = core.route('monthly', date);
  } else if (basename === '年OKR') {
    const year = +(rec.relative.match(/(20\d{2})年/) || [])[1], date = `${year}-01-01`;
    period(rec, 'yearly', date, text); rec.primary = core.route('yearly', date);
  } else if (basename === '季度OKR') {
    const year = +(rec.relative.match(/(20\d{2})年/) || [])[1], oldQuarter = +(rec.relative.match(/\/([1-4])季度\//) || [])[1];
    const startMonths = {2: 6, 3: 9, 4: 11}, ranges = {2: '6—8月', 3: '9—10月', 4: '11月至次年1月'};
    const date = validDate(year, startMonths[oldQuarter], 1);
    period(rec, 'quarterly', date, text, `原阶段计划覆盖 ${year}年${ranges[oldQuarter]}，并非自然季度；按起始月份存放，跨期内容按原意保留。`);
    rec.primary = core.route('quarterly', date);
  } else {
    const year = (rec.relative.match(/20\d{2}/) || ['未注明年份'])[0];
    rec.primary = `01. Daily/${year}年/${basename}.md`;
    put(extra(rec.primary), '# 原记录', text, rec); issues.push({source: rec.id, issue: '无法自动判断周期，保留独立原记录'});
  }
  rec.status = '已整理'; registerAlias(rec);
}
function demote(text) {
  let fence = null;
  return text.split('\n').map(line => {
    const f = line.match(/^\s*(`{3,}|~{3,})/);
    if (f) fence = fence ? (fence === f[1][0] ? null : fence) : f[1][0];
    if (!fence) return line.replace(/^(#{1,6})\s/, (_, h) => '#'.repeat(Math.min(h.length + 2, 6)) + ' ');
    return line;
  }).join('\n');
}
function resolveCalendarLink(target) {
  const clean = target.replace(/\.md$/, '');
  if (nodes.has(clean + '.md')) return clean + '.md';
  const candidates = aliases.get(clean) || aliases.get(path.posix.basename(clean));
  if (candidates?.size === 1) return [...candidates][0];
  const b = path.posix.basename(clean);
  if (/^20\d{2}-\d{2}-\d{2}$/.test(b)) {note('daily', b); return core.route('daily', b);}
  return null;
}
function remap(text, rec) {
  let fence = null;
  return text.split('\n').map(line => {
    const f = line.match(/^\s*(`{3,}|~{3,})/);
    if (f) { fence = fence ? (fence === f[1][0] ? null : fence) : f[1][0]; return line; }
    if (fence) return line;
    return line.replace(/(!?)\[\[([^\]]+)\]\]/g, (full, embed, inside) => {
    const [destination, ...labelParts] = inside.split('|');
    const [target, ...anchorParts] = destination.split('#');
    if (!target) return full;
    const mapped = resolveCalendarLink(target);
    if (mapped) {
      const id = core.identify(mapped);
      const oldAnchor = anchorParts.join('#');
      let heading = oldAnchor;
      if (id && /核心目标|最高优先级|最值得将时间/.test(heading)) heading = {daily: '任务', weekly: '本周重点', monthly: '本月重点', quarterly: '本季重点', yearly: '今年重点'}[id.kind];
      if (id?.kind === 'daily' && oldAnchor) heading = /Task/.test(oldAnchor) ? '任务' : /Shortcoming/.test(oldAnchor) ? '改进' : /Realisation|art of/.test(oldAnchor) ? '禅' : '随笔';
      return `${embed}[[${mapped.replace(/\.md$/, '')}${heading ? '#' + heading : ''}${labelParts.length ? '|' + labelParts.join('|') : '|' + path.posix.basename(target)}]]`;
    }
    if (/\.(?:png|jpe?g|gif|webp|svg|pdf|mp3|mp4|wav|excalidraw)$/i.test(target)) {
      const source = sources.find(s => s.name === rec.source);
      const vault = rec.source === '原库日记' ? path.dirname(source.root) : source.root;
      const candidates = [path.resolve(path.dirname(rec.file), target), path.join(vault, target), path.join(vault, 'Attachment', target)];
      const found = candidates.find(p => fs.existsSync(p) && fs.statSync(p).isFile());
      if (found) {
        const content = fs.readFileSync(found), base = path.basename(found), digest = hash(content);
        let name = base;
        if ([...assetCopies.values()].some(a => a.target === 'Attachment/' + name && a.hash !== digest)) name = path.parse(base).name + '-' + digest.slice(0, 8) + path.extname(base);
        const dest = 'Attachment/' + name;
        assetCopies.set(found, {file: found, target: dest, hash: digest});
        return `${embed}[[${dest}${labelParts.length ? '|' + labelParts.join('|') : ''}]]`;
      }
    }
    issues.push({source: rec.id, link: target, issue: '引用目标不在本次两处日记内容中或原文件已缺失'});
    return full;
    });
  }).join('\n');
}
function insert(text, heading, body) {
  const lines = text.split('\n'), start = lines.indexOf(heading), level = heading.match(/^#+/)[0].length;
  if (start < 0) return text.trimEnd() + '\n\n' + heading + '\n\n' + body + '\n';
  let end = start + 1;
  while (end < lines.length && !(new RegExp('^#{1,' + level + '} ')).test(lines[end])) end++;
  const current = lines.slice(start + 1, end).filter(l => !/^\s*- \[ \]\s*$/.test(l)).join('\n').trim();
  lines.splice(start + 1, end - start - 1, '\n' + (current ? current + '\n\n' : '') + body + '\n');
  return lines.join('\n');
}
async function main() {
  for (const source of sources) {
    for (const file of walk(source.root)) {
      if (!file.endsWith('.md')) continue;
      const raw = fs.readFileSync(file), text = normalize(raw.toString('utf8'));
      const relative = slash(path.relative(source.root, file));
      records.push({id: source.name + '/' + relative, source: source.name, relative, file, rawHash: hash(raw), text, targets: new Set()});
    }
  }
  for (const rec of records) {
    const key = path.basename(rec.file) + ':' + hash(rec.text);
    if (duplicateMap.has(key)) {rec.duplicateOf = duplicateMap.get(key); rec.status = '重复副本，合并保留'; continue;}
    duplicateMap.set(key, rec); processRecord(rec);
  }
  for (const rec of records.filter(r => r.duplicateOf)) {
    rec.primary = rec.duplicateOf.primary; rec.targets = new Set(rec.duplicateOf.targets); registerAlias(rec);
  }
  for (const [folder, files] of extraLinks) {
    const monthly = nodes.get(folder + '/月度计划.md');
    assert(monthly);
    const rec = records.find(r => r.targets.has([...files][0]));
    for (const file of files) put(monthly, '# 同月未注明日期的记录', `[[${file.replace(/\.md$/, '')}|未注明日期的记录]]`, rec);
  }
  // Rewrite content references before rendering, because referenced dates may add ancestor plans.
  for (const n of nodes.values()) for (const blocks of n.sections.values()) for (const b of blocks) b.remapped = remap(b.text, b.source);
  const app = {vault: {adapter: {read: async p => fs.readFileSync(path.join(root, p), 'utf8')}} , plugins: {plugins: {}}};
  const engine = new core.Engine(app); app.plugins.plugins['light-okr'] = {engine};
  const output = new Map();
  for (const n of nodes.values()) {
    let text = n.kind === 'extra' ? n.target === '总体目标.md' ? fs.readFileSync(path.join(root, n.target), 'utf8') : '' : await engine.render(n.kind, n.target);
    if (n.kind === 'daily') {
      text = text.replace(/(# 习惯\n)[\s\S]*?(?=\n# 任务)/, '$1' + (n.habits.size ? [...n.habits].map(([name, done]) => `- [${done ? 'x' : ' '}] ${name}`).join('\n') : '<!-- 原记录未注明习惯完成情况。 -->') + '\n');
    }
    for (const [heading, blocks] of n.sections) {
      const body = blocks.map(b => (b.label ? '### ' + b.label + '\n\n' : '') + demote(b.remapped)).join('\n\n');
      text = insert(text, heading, body);
    }
    output.set(n.target, text.trimEnd() + '\n');
  }
  const summary = {
    inputNotes: records.length,
    duplicateCopies: records.filter(r => r.duplicateOf).length,
    sourceOnlyNotes: records.filter(r => r.status.startsWith('仅保留')).length,
    outputs: Object.fromEntries(['daily', 'weekly', 'monthly', 'quarterly', 'yearly', 'extra'].map(k => [k, [...nodes.values()].filter(n => n.kind === k).length])),
    assets: assetCopies.size,
    unresolvedReferences: [...new Map(issues.map(i => [JSON.stringify(i), i])).values()],
    dateRange: [...nodes.values()].filter(n => n.kind === 'daily').map(n => n.date).sort().filter((_, i, a) => i === 0 || i === a.length - 1)
  };
  const missing = [];
  for (const rec of records.filter(r => r.status === '已整理')) {
    const combined = [...rec.targets].map(p => output.get(p) || '').join('\n');
    const body = cleanOld(rec.text, rec.source === '原库日记');
    let fence = null;
    for (const line of body.split('\n')) {
      const f = line.match(/^\s*(`{3,}|~{3,})/);
      if (f) {fence = fence ? (fence === f[1][0] ? null : fence) : f[1][0]; continue;}
      let s = line.trim();
      if (!s || /^[-|\s]+$/.test(s) || /^-\s*(?:\[ \])?\s*$/.test(s) || (!fence && dateLine(s, 2026))) continue;
      if (/^#+\s/.test(s)) {
        // The old headings are reorganized; validate text and prose rather than old field labels.
        continue;
      }
      if (s.startsWith('>')) s = s.replace(/^>\s*/, '');
      if (combined.includes(s)) continue;
      // Renamed internal references are checked separately against the new destinations.
      if (/\[\[[^\]]+\]\]/.test(s)) continue;
      missing.push({source: rec.id, text: s});
    }
  }
  summary.unpreservedBodyLines = missing;
  assert.equal(missing.length, 0, '仍有正文未保留，停止写入');
  for (const [file, text] of output) {
    if (nodes.get(file).kind === 'daily') {
      let fence = null;
      const headings = text.split('\n').filter(l => {
        const f = l.match(/^\s*(`{3,}|~{3,})/);
        if (f) {fence = fence ? (fence === f[1][0] ? null : fence) : f[1][0]; return false;}
        return !fence && /^# /.test(l);
      });
      assert.deepEqual(headings, ['# 习惯', '# 任务', '# 善意与美好', '# 禅', '# 改进', '# 随笔'], '日记栏目结构异常 ' + file);
    }
    for (const m of text.matchAll(/!\[\[([^#]+)#(?:本周重点|本月重点|本季重点|今年重点)\|[^\]]+\]\]/g)) assert(output.has(m[1] + '.md'), '上级重点未补齐 ' + m[1]);
  }
  for (const rec of records) assert(rec.targets.size || /仅保留|重复/.test(rec.status), '未处理 ' + rec.id);
  assert(!fs.existsSync(path.join(root, '.git')), '导入私人日记前应先移除 .git');
  if (!process.argv.includes('--apply')) {
    console.log(JSON.stringify({...summary, nonstandardPeriods: records.filter(r => /季度OKR|寒假okr/.test(r.file)).map(r => ({source: r.id, target: r.primary}))}, null, 2));
    return;
  }
  assert(!fs.existsSync(backup), '本次整理备份已存在，避免重复迁移');
  for (const [p] of output) if (p !== '总体目标.md') assert(!fs.existsSync(path.join(root, p)), '拒绝覆盖现有记录 ' + p);
  fs.mkdirSync(backup, {recursive: true});
  fs.copyFileSync(path.join(root, '总体目标.md'), path.join(backup, '导入前总体目标.md'));
  for (const rec of records) {
    const dest = path.join(backup, '原始文件', rec.source, rec.relative);
    fs.mkdirSync(path.dirname(dest), {recursive: true}); fs.copyFileSync(rec.file, dest);
    assert.equal(hash(fs.readFileSync(dest)), rec.rawHash, '原件副本校验失败');
  }
  for (const [p, text] of output) {const dest = path.join(root, p); fs.mkdirSync(path.dirname(dest), {recursive: true}); fs.writeFileSync(dest, text, 'utf8');}
  for (const asset of assetCopies.values()) {const dest = path.join(root, asset.target); assert(!fs.existsSync(dest), '附件目标已存在'); fs.copyFileSync(asset.file, dest);}
  const manifest = {summary, records: records.map(r => ({source: r.id, hash: r.rawHash, status: r.status, duplicateOf: r.duplicateOf?.id, targets: [...r.targets]})), outputs: [...output].map(([file, text]) => ({file, hash: hash(Buffer.from(text)), kind: nodes.get(file).kind}))};
  fs.writeFileSync(path.join(backup, '整理清单.json'), JSON.stringify(manifest, null, 2));
  for (const rec of records) assert.equal(hash(fs.readFileSync(rec.file)), rec.rawHash, '源文件发生变化');
  for (const [file, text] of output) assert.equal(fs.readFileSync(path.join(root, file), 'utf8'), text);
  console.log(JSON.stringify(summary, null, 2));
}
main().catch(e => {console.error(e); process.exitCode = 1;});

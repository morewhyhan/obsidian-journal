const fs = require('fs'), path = require('path'), crypto = require('crypto'), assert = require('assert/strict');
const core = require('../.obsidian/plugins/light-okr/core');
const root = path.resolve(__dirname, '..');
const first = path.join(root, '.local/日记整理');
const restored = path.join(root, '.local/旧笔记原样恢复');
const manifest = JSON.parse(fs.readFileSync(path.join(restored, '恢复清单.json'), 'utf8'));
const previous = JSON.parse(fs.readFileSync(path.join(first, '整理清单.json'), 'utf8'));
const index = JSON.parse(fs.readFileSync(path.join(root, '.obsidian/plugins/light-okr/legacy-notes.json'), 'utf8'));
const sources = {日记: 'C:/Users/why/Documents/日记', 原库日记: 'C:/Users/why/Documents/example-obsidian-library-of-dice/01. Daily'};
const hash = content => crypto.createHash('sha256').update(content).digest('hex');
const mask = text => text.replace(/(!?)\[\[[^\]]+\]\]/g, '$1[[LINK]]');
assert(!fs.existsSync(path.join(root, '.git')), '当前目录不应连接 Git');
for (const rec of manifest.records) {
  const [source, ...parts] = rec.source.split('/');
  assert.equal(hash(fs.readFileSync(path.join(sources[source], parts.join('/')))), rec.sourceHash, '源文件改变 ' + rec.source);
  assert.equal(hash(fs.readFileSync(path.join(first, '原始文件', rec.source))), rec.sourceHash, '原件副本不一致 ' + rec.source);
  if (rec.target) assert(fs.existsSync(path.join(root, rec.target)), '缺少旧笔记 ' + rec.target);
}
assert.equal(index.files.length, manifest.outputs.length);
for (const out of manifest.outputs) {
  const bytes = fs.readFileSync(path.join(root, out.file));
  const original = fs.readFileSync(path.join(first, '原始文件', out.source));
  assert.equal(hash(bytes), out.outputHash, '整理结果发生变化 ' + out.file);
  assert.equal(mask(bytes.toString('utf8')), mask(original.toString('utf8')), '除内部链接外原文发生变化 ' + out.file);
  assert(index.files.some(file => file.path === out.file && file.kind === out.kind));
  if (['daily', 'weekly', 'monthly', 'quarterly', 'yearly'].includes(out.kind)) assert.equal(index.routes[core.route(out.kind, out.date)], out.file);
  if (out.kind === 'daily') assert.equal(core.route('daily', out.date), out.file);
}
const active = new Set(manifest.outputs.map(out => out.file));
for (const old of previous.outputs) {
  if (old.file.startsWith('01. Daily/') && !active.has(old.file)) assert(!fs.existsSync(path.join(root, old.file)), '仍有旧自动生成笔记 ' + old.file);
}
assert.equal(hash(fs.readFileSync(path.join(root, '总体目标.md'))), hash(fs.readFileSync(path.join(restored, '恢复前/总体目标.md'))), '用户修改过的总体目标应保留');
console.log('PASS: ' + manifest.records.length + ' originals and backups unchanged; ' + manifest.outputs.length + ' whole notes restored; text, headings and formatting unchanged apart from internal wikilinks; duplicates and variants accounted for; obsolete generated notes removed; existing overall goals preserved; no Git connection.');
console.log(JSON.stringify(manifest.summary, null, 2));

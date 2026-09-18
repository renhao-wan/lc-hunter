/*
 * 验证「中文标签只有一个来源」这条约定没被破坏。
 *
 * 背景：难度→中文原来在三个文件各写一遍，键名还是两套
 * （cli.js/generate.js 用 EASY，app.js 用 Easy）；状态词也是两套说法
 * （命令行「AC/未AC/未做」 vs 页面「已通过/做过没过/没做过」）。
 * 现在统一收进 src/labels.js，web/app.js 留一份副本（静态目录 import 不到 src/）。
 *
 * 这个脚本干两件事：
 *   1. 行为验证：normalizeDifficulty / difficultyCn / statusCn 各条分支
 *   2. 一致性守卫：读 web/app.js 源码，把里面的 DIFF_CN / STATUS_CN 抠出来
 *      和 src/labels.js 的做深比较；再全仓扫一遍，禁止任何地方再出现
 *      就地写死的难度中文映射（防止有人顺手又抄一份）
 *
 * 纯 Node，不开浏览器 —— 跑起来是瞬间的事，适合挂在提交前。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { DIFF_CN, STATUS_CN, normalizeDifficulty, difficultyCn, statusCn } from '../src/labels.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const results = [];
function check(name, ok, detail) {
  results.push([name, !!ok, detail]);
}

// ---------- 1. 行为验证 ----------

const normCases = [
  ['MEDIUM', 'Medium'],
  ['Medium', 'Medium'],
  ['medium', 'Medium'],
  ['Med', 'Medium'],
  ['EASY', 'Easy'],
  ['easy', 'Easy'],
  ['HARD', 'Hard'],
  ['hard', 'Hard'],
  ['', null],
  [null, null],
  [undefined, null],
  ['UNKNOWN', null],
];
for (const [input, want] of normCases) {
  const got = normalizeDifficulty(input);
  check(`normalizeDifficulty(${JSON.stringify(input)}) → ${JSON.stringify(want)}`, got === want, `实际 ${JSON.stringify(got)}`);
}

check('difficultyCn("MEDIUM") → 中等', difficultyCn('MEDIUM') === '中等');
check('difficultyCn("easy") → 简单（大小写不敏感）', difficultyCn('easy') === '简单');
check('difficultyCn(null) → "-"', difficultyCn(null) === '-');
check('difficultyCn(null, "未知") → "未知"（可换兜底）', difficultyCn(null, '未知') === '未知');
check('difficultyCn 认不出时原样返回', difficultyCn('怪东西') === '怪东西', `实际 ${difficultyCn('怪东西')}`);

check('statusCn("ac") → 已通过', statusCn('ac') === '已通过');
check('statusCn("notac") → 做过没过', statusCn('notac') === '做过没过');
check('statusCn("new") → 没做过', statusCn('new') === '没做过');
check('statusCn(未知) 兜底成没做过', statusCn('???') === '没做过', `实际 ${statusCn('???')}`);

// 白话，不许出现圈内黑话
const slang = Object.values(STATUS_CN).filter((v) => /AC|未做/.test(v));
check('状态词里没有「AC / 未做」这类黑话', slang.length === 0, slang.join(','));

// ---------- 2. 与 web/app.js 的副本对账 ----------

const appSrc = fs.readFileSync(path.join(ROOT, 'web', 'app.js'), 'utf8');

function grabObject(src, name) {
  const m = src.match(new RegExp(`const\\s+${name}\\s*=\\s*\\{([^}]*)\\}`));
  if (!m) return null;
  const out = {};
  for (const part of m[1].split(',')) {
    const kv = part.match(/^\s*([\w$]+)\s*:\s*'([^']*)'\s*$/);
    if (kv) out[kv[1]] = kv[2];
  }
  return Object.keys(out).length ? out : null;
}

const webDiff = grabObject(appSrc, 'DIFF_CN');
const webStatus = grabObject(appSrc, 'STATUS_CN');

check('web/app.js 里有 DIFF_CN', !!webDiff);
check('web/app.js 里有 STATUS_CN', !!webStatus);

if (webDiff) {
  const ok = JSON.stringify(webDiff) === JSON.stringify(DIFF_CN);
  check('web 的 DIFF_CN 与 src/labels.js 完全一致', ok, `web=${JSON.stringify(webDiff)} src=${JSON.stringify(DIFF_CN)}`);
}
if (webStatus) {
  const ok = JSON.stringify(webStatus) === JSON.stringify(STATUS_CN);
  check('web 的 STATUS_CN 与 src/labels.js 完全一致', ok, `web=${JSON.stringify(webStatus)} src=${JSON.stringify(STATUS_CN)}`);
}

// ---------- 3. 全仓扫描：不许再就地写死难度中文映射 ----------

function walk(dir, acc = []) {
  for (const name of fs.readdirSync(dir)) {
    if (name === 'node_modules' || name === '.git' || name === '.lc' || name.startsWith('.')) continue;
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) walk(p, acc);
    else if (name.endsWith('.js')) acc.push(p);
  }
  return acc;
}

const INLINE_MAP = /(?:EASY|MEDIUM|HARD|Easy|Medium|Hard)\s*:\s*'[^']*'[^}]*\}/;
const allowed = new Set([
  path.join(ROOT, 'src', 'labels.js'), // 唯一来源
  path.join(ROOT, 'web', 'app.js'), // 静态目录，只能是副本（上面已经对过账）
]);

const offenders = [];
for (const file of [...walk(path.join(ROOT, 'src')), ...walk(path.join(ROOT, 'web')), ...walk(path.join(ROOT, 'bin'))]) {
  if (allowed.has(file)) continue;
  const text = fs.readFileSync(file, 'utf8');
  text.split('\n').forEach((line, i) => {
    if (line.trim().startsWith('*') || line.trim().startsWith('//')) return; // 注释不算
    if (INLINE_MAP.test(line)) offenders.push(`${path.relative(ROOT, file)}:${i + 1}  ${line.trim()}`);
  });
}
check('没有第四处就地写死的难度中文映射', offenders.length === 0, offenders.join('\n      '));

/*
 * 状态黑话同理：命令行输出的「AC / 未AC / 未做」不许再出现（注释里提到不算）。
 *
 * 注意只认「未AC / 未做」和「AC ${」这两种写法 —— 不能简单地扫 'AC' 三个字母，
 * leetcode/client.js:24 的 `if (v === 'AC') return 'ac'` 是在比对接口原始值，
 * 那是数据层的事，跟给人看的文案无关。
 */
const slangHits = [];
for (const file of [...walk(path.join(ROOT, 'src')), ...walk(path.join(ROOT, 'bin'))]) {
  fs.readFileSync(file, 'utf8')
    .split('\n')
    .forEach((line, i) => {
      const t = line.trim();
      if (t.startsWith('*') || t.startsWith('//')) return;
      if (/未AC|未做|AC \$\{/.test(line)) slangHits.push(`${path.relative(ROOT, file)}:${i + 1}  ${t}`);
    });
}
check('命令行文案里不再有「AC / 未AC / 未做」黑话', slangHits.length === 0, slangHits.join('\n      '));

// 引用关系也要在：这三个文件必须从 labels.js 取中文，而不是自己算
const mustImport = [
  ['src/cli.js', ['difficultyCn', 'statusCn']],
  ['src/engine/generate.js', ['difficultyCn']],
  ['src/routes/helpers.js', ['normalizeDifficulty']],
];
for (const [rel, names] of mustImport) {
  const text = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  const hasImport = /from\s+'\.\.?\/(?:\.\.\/)?labels\.js'/.test(text);
  const hasNames = names.every((n) => new RegExp(`\\b${n}\\b`).test(text));
  check(`${rel} 从 labels.js 引 ${names.join(' / ')}`, hasImport && hasNames, `import=${hasImport} names=${hasNames}`);
}

// ---------- 输出 ----------

console.log('=== 中文标签一致性 ===');
let pass = 0;
for (const [name, ok, detail] of results) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok && detail) console.log(`          ${detail}`);
  if (ok) pass++;
}
console.log('');
console.log(`${pass}/${results.length} 通过`);
process.exit(pass === results.length ? 0 : 1);

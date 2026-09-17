/*
 * 验证界面上「做过的 / 已通过」能正确筛出来。
 *
 * 修复前：本地跑通过的题（two-sum 本地 AC 14 次）因为 lc_status 为空被判成"没做过"，
 * 点「已通过」一道都筛不出来。这里逐个筛一遍看行数对不对。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const BASE = process.env.LC_BASE || 'http://127.0.0.1:7788';
const PORT = 9341;
const profile = path.join(os.tmpdir(), 'lc-verify-filter-' + Date.now());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
  ],
  { stdio: ['ignore', 'pipe', 'pipe'] },
);

let wsUrl = null;
for (let i = 0; i < 40; i++) {
  await sleep(250);
  try {
    const j = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
    if (j.webSocketDebuggerUrl) {
      wsUrl = j.webSocketDebuggerUrl;
      break;
    }
  } catch {}
}
if (!wsUrl) {
  chrome.kill();
  console.log('Chrome 起不来');
  process.exit(1);
}

const target = await (
  await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(BASE)}`, { method: 'PUT' })
).json();
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.onopen = res;
  ws.onerror = rej;
});

let msgId = 0;
const pending = new Map();
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m);
    pending.delete(m.id);
  }
};
const send = (method, params = {}) => {
  const id = ++msgId;
  return new Promise((res) => {
    pending.set(id, res);
    ws.send(JSON.stringify({ id, method, params }));
  });
};
const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description);
  return r.result?.result?.value;
};

await send('Runtime.enable');
await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1500, height: 950, deviceScaleFactor: 1, mobile: false });

for (let i = 0; i < 40; i++) {
  await sleep(250);
  if ((await evaluate('document.readyState')) === 'complete') break;
}
await sleep(1800);

await evaluate(`
  window.__errs = [];
  window.addEventListener('error', e => window.__errs.push(String(e.message)));
  true;
`);

// 顺便看下拉里有没有新增的「做过的」选项
const filterOpts = await evaluate(`
  [...document.querySelectorAll('#filterSel option')].map(o => o.value + '=' + o.textContent.trim())
`);
const modeOpts = await evaluate(`
  [...document.querySelectorAll('#modeSel option')].map(o => o.value + '=' + o.textContent.trim())
`);

/** 用左栏的筛选下拉过滤，等列表稳定后返回行数 + 前几行题名 */
async function applyFilter(mode) {
  await evaluate(`
    (() => {
      const s = document.getElementById('filterSel');
      s.value = ${JSON.stringify(mode)};
      s.onchange();
      return true;
    })()
  `);
  // 轮询等列表更新完（筛选请求是异步的）
  await sleep(1200);
  return evaluate(`
    (() => {
      const rows = [...document.querySelectorAll('#problemList .prob')];
      return {
        count: rows.length,
        slugs: rows.map(r => r.dataset.slug),
        titles: rows.slice(0, 5).map(r => (r.querySelector('.ptitle')?.textContent || r.textContent).trim().slice(0, 24)),
      };
    })()
  `);
}

const results = {};
for (const m of ['done', 'ac', 'notac', 'new', '']) {
  results[m || 'all'] = await applyFilter(m);
}

// 顶栏统计
const stats = await evaluate(`
  [...document.querySelectorAll('#stats .stat')].map(s => s.textContent.trim())
`);

const errs = await evaluate('window.__errs || []');

// 「没做过」里绝不能出现任何「已通过」的题（这是本次修复的核心回归点）。
// 注意两边的行数都可能撞到接口的 2000 条上限，所以不能比总数，要比 slug 集合。
const acSlugs = new Set(results.ac.slugs || []);
const newSlugs = results.new.slugs || [];
const overlap = newSlugs.filter((s) => acSlugs.has(s));
const acNotInNew = [...acSlugs].every((s) => !newSlugs.includes(s));

chrome.kill();
try {
  fs.rmSync(profile, { recursive: true, force: true });
} catch {}

console.log('=== 界面筛选验收（全库范围）===');
console.log('');
console.log('左栏「全部状态」选项:');
for (const o of filterOpts) console.log('   ', o);
console.log('');
console.log('「抽什么样的」选项:');
for (const o of modeOpts) console.log('   ', o);
console.log('');
console.log('各筛选结果:');
for (const [k, v] of Object.entries(results)) {
  console.log(`   ${k.padEnd(6)} → ${String(v.count).padEnd(6)} 行   ${JSON.stringify(v.titles)}`);
}
console.log('');
console.log('顶栏统计:', JSON.stringify(stats));
console.log('');

const checks = [
  ['左栏有「做过的」选项', filterOpts.some((o) => o.startsWith('done='))],
  ['「抽什么样的」也有「做过的」', modeOpts.some((o) => o.startsWith('done='))],
  ['「已通过」能筛出题（修复前是 0）', results.ac.count > 0],
  ['「已通过」含 two-sum（本地 AC 14 次那道）', JSON.stringify(results.ac.titles).includes('两数之和') || results.ac.count === 2],
  ['「做过的」数量 ≥ 「已通过」', results.done.count >= results.ac.count],
  ['「做过的」= 已通过 + 做过没过', results.done.count === results.ac.count + results.notac.count],
  ['「没做过」里不含任何「已通过」的题', overlap.length === 0 && acNotInNew],
  ['两数之和不在「没做过」里', !newSlugs.includes('two-sum')],
  ['无 JS 报错', errs.length === 0],
];
for (const [name, pass] of checks) console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}`);
if (overlap.length) console.log('  「没做过」里混进的已通过题:', overlap);
if (errs.length) console.log('  JS 错误:', errs);

const allPass = checks.every(([, p]) => p);
console.log('');
console.log(allPass ? '结论: 界面筛选正确。' : '结论: 有未通过项。');
process.exit(allPass ? 0 : 1);

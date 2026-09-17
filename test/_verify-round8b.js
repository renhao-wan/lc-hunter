/*
 * 补验两处细节：
 *  1. 「全部计划」列表里到底渲染了什么（分组标题 + 卡片），确认折叠按钮点的是对的东西
 *  2. 代码区把手在收起态的实际布局 —— 它的父级是 grid 项，
 *     width 可能被拉满整行（视觉上把手会变成一条横贯的长条）
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const BASE = process.env.LC_BASE || 'http://127.0.0.1:7788';
const PORT = 9337;
const profile = path.join(os.tmpdir(), 'lc-verify-r8b-' + Date.now());
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
// 用桌面宽度，走三栏布局，才能验到第 3 列
await send('Emulation.setDeviceMetricsOverride', {
  width: 1600,
  height: 1000,
  deviceScaleFactor: 1,
  mobile: false,
});

for (let i = 0; i < 40; i++) {
  await sleep(250);
  if ((await evaluate('document.readyState')) === 'complete') break;
}
await sleep(1400);

await evaluate(`localStorage.removeItem('lc-collapse-code'); localStorage.removeItem('lc-code-lock'); true;`);

// --- 1. 计划弹窗内容
await evaluate(`document.getElementById('plansBtn').click()`);
// /api/plans 要从力扣现拉，实测约 6 秒 —— 等短了量到的是「加载中…」占位
for (let i = 0; i < 30; i++) {
  await sleep(700);
  const done = await evaluate(`
    document.querySelectorAll('#allPlansList .plan-card').length > 0
  `);
  if (done) break;
}
await sleep(600);
const plansInfo = await evaluate(`
  (() => {
    const box = document.getElementById('allPlansList');
    return {
      groupTitles: box.querySelectorAll('.plan-group-title').length,
      cards: box.querySelectorAll('.plan-card').length,
      allChildren: box.children.length,
      firstTitle: box.querySelector('.plan-group-title')?.textContent.trim(),
      toggleVisible: (() => {
        const t = document.getElementById('allPlansToggle');
        const r = t.getBoundingClientRect();
        return { w: Math.round(r.width), h: Math.round(r.height), inView: r.top >= 0 && r.bottom <= innerHeight };
      })(),
      searchInputRight: (() => {
        const r = document.getElementById('planSearch').getBoundingClientRect();
        return Math.round(r.right);
      })(),
      toggleRight: Math.round(document.getElementById('allPlansToggle').getBoundingClientRect().right),
    };
  })()
`);

// 收起全部计划，确认真的收干净（分组标题也要一起隐藏）
await evaluate(`document.getElementById('allPlansToggle').click()`);
await sleep(500);
const collapsedInfo = await evaluate(`
  (() => {
    const box = document.getElementById('allPlansList');
    return { hidden: box.hidden, offsetH: box.offsetHeight, visibleChildren: [...box.children].filter(c => c.offsetHeight > 0).length };
  })()
`);

await evaluate(`document.getElementById('plansClose').click()`);
await sleep(500);

// --- 2. 代码区把手布局（桌面三栏）
await evaluate(`applyCollapse()`);
await sleep(400);
const handle = await evaluate(`
  (() => {
    const r = document.getElementById('reopenCode');
    if (!r || r.hidden) return { exists: false };
    const rect = r.getBoundingClientRect();
    const main = document.getElementById('mainArea');
    const cols = getComputedStyle(main).gridTemplateColumns.split(' ').map(x => Math.round(parseFloat(x)));
    // writing-mode 挂在内层 .reopen-label 上（外层按钮要留成正常书写方向，
    // flex 主轴才竖直，内容才能上下居中）。量按钮本身永远是 horizontal-tb，
    // 区分不出桌面竖排 / 窄屏横排，所以这里量内层。
    const label = r.querySelector('.reopen-label') || r;
    // 内容组（文字 + 箭头）在整条把手里的上下留白，用来判断"居中"而不是"贴顶"
    const kids = [...r.children].map(c => c.getBoundingClientRect());
    const top = Math.min(...kids.map(k => k.top));
    const bottom = Math.max(...kids.map(k => k.bottom));
    return {
      exists: true,
      w: Math.round(rect.width), h: Math.round(rect.height),
      left: Math.round(rect.left), top: Math.round(rect.top),
      writingMode: getComputedStyle(label).writingMode,
      upperGap: Math.round(top - rect.top),
      lowerGap: Math.round(rect.bottom - bottom),
      cols,
      mainW: Math.round(main.getBoundingClientRect().width),
    };
  })()
`);

const errs = await evaluate('window.__errs || []');

chrome.kill();
try {
  fs.rmSync(profile, { recursive: true, force: true });
} catch {}

console.log('=== 补验：计划弹窗内容 + 代码区把手布局（1600x1000 桌面）===');
console.log('');
console.log('1. 「全部计划」渲染内容:');
console.log('   分组标题数:', plansInfo.groupTitles, ' 卡片数:', plansInfo.cards, ' 子元素总数:', plansInfo.allChildren);
console.log('   第一个分组:', JSON.stringify(plansInfo.firstTitle));
console.log('   折叠标题尺寸:', JSON.stringify(plansInfo.toggleVisible));
console.log('   折叠标题右边界:', plansInfo.toggleRight, ' 搜索框右边界:', plansInfo.searchInputRight);
console.log('   收起后:', JSON.stringify(collapsedInfo));
console.log('');
console.log('2. 代码区把手（收起态，桌面三栏）:');
console.log('  ', JSON.stringify(handle));
console.log('');

const checks = [
  ['「全部计划」里渲染了分组标题', plansInfo.groupTitles > 0],
  ['「全部计划」里渲染了卡片', plansInfo.cards > 0],
  ['折叠标题在视口内可点', plansInfo.toggleVisible.inView],
  ['搜索框仍在标题右侧（未被挤走）', plansInfo.searchInputRight > plansInfo.toggleRight - 5],
  ['收起后内容整块隐藏（可见子元素 0）', collapsedInfo.visibleChildren === 0],
  ['桌面三栏布局下第 3 列收成 40px', Array.isArray(handle.cols) && handle.cols[2] === 40],
  ['代码区把手出现', handle.exists === true],
  ['桌面下把手文字竖排', handle.writingMode === 'vertical-rl'],
  // 内容要居中，不是顶在 850px 竖栏的最上面（用户反馈过"不在中间"）
  ['把手内容上下居中', handle.exists === true && Math.abs(handle.upperGap - handle.lowerGap) <= 2],
];
for (const [name, pass] of checks) console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}`);
if (errs.length) console.log('  JS 错误:', errs);

const allPass = checks.every(([, p]) => p);
console.log('');
console.log(allPass ? '结论: 通过。' : '结论: 有未通过项。');
process.exit(allPass ? 0 : 1);

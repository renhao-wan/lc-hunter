/*
 * 验收本轮三项改动：
 *   A. 「从哪抽题」下拉里每个选项的括号数字随「抽什么样的」实时变化
 *   B. 没有工作区时右侧代码区自动收起；生成后自动展开；手动能改
 *   C. 计划弹窗里「我全部计划」两节都能折叠
 *
 * 用 CDP 直接量 DOM 与布局，不靠肉眼。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const BASE = process.env.LC_BASE || 'http://127.0.0.1:7788';
const PORT = 9336;
const profile = path.join(os.tmpdir(), 'lc-verify-round8-' + Date.now());
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
  if (r.result?.exceptionDetails) {
    throw new Error(r.result.exceptionDetails.exception?.description || 'eval 失败');
  }
  return r.result?.result?.value;
};

await send('Runtime.enable');
await send('Page.enable');

async function ready() {
  for (let i = 0; i < 40; i++) {
    await sleep(250);
    if ((await evaluate('document.readyState')) === 'complete') break;
  }
  await sleep(1400);
}

await ready();
await evaluate(`
  window.__errs = [];
  window.addEventListener('error', e => window.__errs.push(String(e.message)));
  true;
`);

// 清掉上一轮可能留下的折叠状态，保证起点干净
await evaluate(`localStorage.removeItem('lc-collapse-code'); localStorage.removeItem('lc-code-lock'); localStorage.removeItem('lc-collapse-list'); localStorage.removeItem('lc-collapse-desc'); true;`);

// ============================================================
// A. 下拉括号数字随模式变化
// ============================================================
const optTexts = () =>
  evaluate(`
    [...document.querySelectorAll('#planSel option')].map(o => o.textContent.trim())
  `);

async function setMode(m) {
  await evaluate(`
    (() => {
      const s = document.getElementById('modeSel');
      s.value = ${JSON.stringify(m)};
      s.dispatchEvent(new Event('change'));
      return true;
    })()
  `);
  await sleep(900);
}

const modeAll = await setMode('all').then(optTexts);
const modeNew = await setMode('new').then(optTexts);
const modeAc = await setMode('ac').then(optTexts);
const modeDue = await setMode('due').then(optTexts);

// 只看「面试经典 150 题」那一项在各模式下的括号数字
const pick = (arr) => (arr.find((t) => t.includes('面试经典')) || '').match(/（(\d+)）/)?.[1];
const pickAll = pick(modeAll);
const pickNew = pick(modeNew);
const pickAc = pick(modeAc);
const pickDue = pick(modeDue);

const allOptAll = modeAll.find((t) => t.startsWith('全部题目')) || '';

// ============================================================
// B. 代码区自动收起 / 展开
// ============================================================
const codeState = () =>
  evaluate(`
    (() => {
      const main = document.getElementById('mainArea');
      const panel = document.getElementById('codePanel');
      const reopen = document.getElementById('reopenCode');
      const cs = getComputedStyle(main).gridTemplateColumns.split(' ').map(x => Math.round(parseFloat(x)));
      return {
        classCollapsed: main.classList.contains('code-collapsed'),
        panelDisplay: panel ? getComputedStyle(panel).display : 'n/a',
        reopenHidden: reopen ? reopen.hidden : 'no-handle',
        reopenW: reopen ? Math.round(reopen.getBoundingClientRect().width) : 0,
        cols: cs,
      };
    })()
  `);

// 起点：没抽题、没工作区
await evaluate(`localStorage.removeItem('lc-code-lock'); localStorage.removeItem('lc-collapse-code'); if (document.getElementById('reopenCode')) document.getElementById('reopenCode').remove(); true;`);
await evaluate(`applyCollapse()`);
await sleep(400);
const noWorkspace = await codeState();

// 打开一道题（会连带生成工作区）。
// 必须先把模式设回「不限」—— 上一节 A 结束时停在 'due'，
// 而库里现在没有到期题，那样会抽不到任何题、工作区也就不会出现。
await evaluate(`
  (() => {
    const s = document.getElementById('modeSel');
    s.value = 'all';
    s.dispatchEvent(new Event('change'));
    return true;
  })()
`);
await sleep(1200);

const opened = await evaluate(`
  (async () => {
    document.getElementById('drawBtn').click();
    return 'clicked';
  })()
`);
// 轮询等题目真的打开（抽题 + 拉详情是异步的，别用固定 sleep）
for (let i = 0; i < 30; i++) {
  await sleep(700);
  const has = await evaluate(`!!(window.state && state.current && (state.current.files || []).length > 0)`);
  if (has) break;
}
await sleep(700);
const withWorkspace = await codeState();

// ============================================================
// C. 计划弹窗两节折叠
// ============================================================
await evaluate(`document.getElementById('plansBtn').click()`);
await sleep(2500);

const modalState = () =>
  evaluate(`
    (() => {
      const mineBox = document.getElementById('myPlansList');
      const allBox = document.getElementById('allPlansList');
      const mineT = document.getElementById('myPlansToggle');
      const allT = document.getElementById('allPlansToggle');
      return {
        mineToggleExists: !!mineT,
        allToggleExists: !!allT,
        allToggleHasCaret: !!allT?.querySelector('.caret'),
        mineVisibleBefore: mineBox ? !mineBox.hidden : null,
        allVisibleBefore: allBox ? !allBox.hidden : null,
        allCards: document.querySelectorAll('#allPlansList .plan-card').length,
      };
    })()
  `);

const modalBefore = await modalState();

// 点「全部计划」收起
await evaluate(`document.getElementById('allPlansToggle').click()`);
await sleep(500);
const modalAfterAll = await evaluate(`
  (() => {
    const b = document.getElementById('allPlansList');
    const c = document.getElementById('allPlansToggle').querySelector('.caret');
    return { hidden: b.hidden, offsetH: b.offsetHeight, caret: c?.textContent,
             stored: localStorage.getItem('lc-hide-allplans') };
  })()
`);

// 点「我加入的计划」收起
await evaluate(`document.getElementById('myPlansToggle').click()`);
await sleep(400);
const modalAfterMine = await evaluate(`
  (() => {
    const b = document.getElementById('myPlansList');
    const c = document.getElementById('myPlansToggle').querySelector('.caret');
    return { hidden: b.hidden, offsetH: b.offsetHeight, caret: c?.textContent };
  })()
`);

const errs = await evaluate('window.__errs || []');

chrome.kill();
try {
  fs.rmSync(profile, { recursive: true, force: true });
} catch {}

// ============================================================
// 输出
// ============================================================
const checks = [
  ['A 下拉里「全部题目」带括号计数', /（\d+）/.test(allOptAll)],
  ['A 括号数字随模式变化（all≠new）', pickAll !== pickNew],
  ['A 「做过的」比「不限」少', Number(pickAc) < Number(pickAll)],
  ['A 「还没做过的」比「不限」少', Number(pickNew) < Number(pickAll)],
  ['B 没工作区时代码区收起', noWorkspace.classCollapsed === true],
  ['B 收起时列宽收窄到 40px 或整行收成 40px', noWorkspace.cols[2] === 40 || noWorkspace.cols.length === 2],
  ['B 收起时面板不渲染', noWorkspace.panelDisplay === 'none'],
  ['B 收起时把手可见', noWorkspace.reopenHidden === false],
  ['B 生成工作区后自动展开', withWorkspace.classCollapsed === false],
  // 列数取决于视口：宽屏三栏 [left, desc, code]，窄屏两栏 [left, desc] 且代码区在第 2 行
  ['B 展开后代码区重新可见', withWorkspace.panelDisplay !== 'none'],
  ['C 「全部计划」有折叠标题', modalBefore.allToggleExists && modalBefore.allToggleHasCaret],
  ['C 点一下「全部计划」能收起', modalAfterAll.hidden === true && modalAfterAll.offsetH === 0],
  ['C 收起后箭头翻转', modalAfterAll.caret === '▸'],
  ['C 状态写进 localStorage', modalAfterAll.stored === '1'],
  ['C 点一下「我加入的计划」能收起', modalAfterMine.hidden === true && modalAfterMine.offsetH === 0],
  ['无 JS 报错', errs.length === 0],
];

console.log('=== 第八轮改动验收 ===');
console.log('');
console.log('A. 下拉括号随模式变化（以「面试经典 150 题」为例）');
console.log('   不限        →', pickAll, ' 还没做过的 →', pickNew, ' 做过的 →', pickAc, ' 今天该复习 →', pickDue);
console.log('   「全部题目」项:', JSON.stringify(allOptAll));
console.log('');
console.log('   各模式下下拉完整内容（all）:');
for (const t of modeAll) console.log('     ', t);
console.log('');
console.log('B. 代码区自动收起');
console.log('   无工作区:', JSON.stringify(noWorkspace));
console.log('   有工作区:', JSON.stringify(withWorkspace));
console.log('');
console.log('C. 计划弹窗折叠');
console.log('   改前:', JSON.stringify(modalBefore));
console.log('   收「全部计划」后:', JSON.stringify(modalAfterAll));
console.log('   收「我加入的」后:', JSON.stringify(modalAfterMine));
console.log('');
for (const [name, pass] of checks) console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}`);
if (errs.length) console.log('  JS 错误:', errs);

const allPass = checks.every(([, p]) => p);
console.log('');
console.log(allPass ? '结论: 全部通过。' : '结论: 有未通过项。');
process.exit(allPass ? 0 : 1);

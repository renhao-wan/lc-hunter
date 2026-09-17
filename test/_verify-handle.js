/*
 * 验收：折叠后的展开把手要「撑满整行」，跟旁边的题目区一样高。
 *
 * 之前是 align-self: start，把手只有文字那么高（约 65px），
 * 悬在顶部像一小块碎片。
 *
 * 顺带量一下窄屏题面区的高度构成，确认 descH 的变化来自哪里。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const BASE = process.env.LC_BASE || 'http://127.0.0.1:7788';
const PORT = 9342;
const profile = path.join(os.tmpdir(), 'lc-verify-handle-' + Date.now());
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

const results = [];

/* ---------- 一、桌面：三个把手都要撑满整行 ---------- */
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
await sleep(1800);

// 先确保有工作区（代码区展开着），这样收起的只有左栏/题面，行高是完整的一行
await evaluate(`localStorage.removeItem('lc-code-lock'); true;`);
await evaluate(`
  (() => {
    const s = document.getElementById('modeSel');
    s.value = 'all';
    s.dispatchEvent(new Event('change'));
    return true;
  })()
`);
await sleep(1000);
await evaluate(`document.getElementById('drawBtn').click()`);
for (let i = 0; i < 30; i++) {
  await sleep(700);
  if (await evaluate(`!!(window.state && state.current && (state.current.files||[]).length>0)`)) break;
}
await sleep(600);

// 左栏收起 + 题面收起 → 两个把手并排，都该是满高
await evaluate(`
  localStorage.setItem('lc-collapse-list','1');
  localStorage.setItem('lc-collapse-desc','1');
  applyCollapse();
  true;
`);
await sleep(600);

const bothCollapsed = await evaluate(`
  (() => {
    const h = (id) => {
      const e = document.getElementById(id);
      if (!e || e.hidden) return null;
      const r = e.getBoundingClientRect();
      return { w: Math.round(r.width), h: Math.round(r.height), top: Math.round(r.top), bottom: Math.round(r.bottom) };
    };
    const main = document.getElementById('mainArea');
    const code = document.getElementById('codePanel');
    const areaH = Math.round(main.getBoundingClientRect().height);
    return {
      mainH: areaH,
      mainRows: getComputedStyle(main).gridTemplateRows,
      mainCols: getComputedStyle(main).gridTemplateColumns,
      reopenList: h('reopenList'),
      reopenDesc: h('reopenDesc'),
      codeH: Math.round(code.getBoundingClientRect().height),
      codeTop: Math.round(code.getBoundingClientRect().top),
      codeBottom: Math.round(code.getBoundingClientRect().bottom),
    };
  })()
`);

// 只收左栏（题面在，量把手和题面是否等高）
await evaluate(`
  localStorage.setItem('lc-collapse-list','1');
  localStorage.setItem('lc-collapse-desc','0');
  applyCollapse();
  true;
`);
await sleep(600);
const onlyList = await evaluate(`
  (() => {
    const rl = document.getElementById('reopenList');
    const dp = document.getElementById('descPanel');
    const r1 = rl.getBoundingClientRect();
    const r2 = dp.getBoundingClientRect();
    return {
      handleH: Math.round(r1.height), handleW: Math.round(r1.width),
      descH: Math.round(r2.height),
      sameHeight: Math.abs(r1.height - r2.height) <= 2,
      sameTop: Math.abs(r1.top - r2.top) <= 2,
    };
  })()
`);

/* ---------- 二、窄屏：量题面区高度构成 ---------- */
await send('Emulation.setDeviceMetricsOverride', {
  width: 900,
  height: 640,
  deviceScaleFactor: 1,
  mobile: false,
});
await send('Page.navigate', { url: BASE });
for (let i = 0; i < 40; i++) {
  await sleep(250);
  if ((await evaluate('document.readyState')) === 'complete') break;
}
await sleep(1800);

await evaluate(`
  localStorage.setItem('lc-collapse-list','0');
  localStorage.setItem('lc-collapse-desc','0');
  localStorage.removeItem('lc-code-lock');
  localStorage.removeItem('lc-collapse-code');
  true;
`);
await send('Page.navigate', { url: BASE });
for (let i = 0; i < 40; i++) {
  await sleep(250);
  if ((await evaluate('document.readyState')) === 'complete') break;
}
await sleep(1600);

await evaluate(`
  (() => {
    const s = document.getElementById('modeSel');
    s.value = 'all'; s.dispatchEvent(new Event('change')); return true;
  })()
`);
await sleep(1000);
await evaluate(`document.getElementById('drawBtn').click()`);
for (let i = 0; i < 30; i++) {
  await sleep(700);
  if (await evaluate(`!!(window.state && state.current && (state.current.files||[]).length>0)`)) break;
}
await sleep(800);

const narrow = await evaluate(`
  (() => {
    const rect = (sel) => {
      const e = document.querySelector(sel);
      if (!e) return null;
      const r = e.getBoundingClientRect();
      return { h: Math.round(r.height), top: Math.round(r.top) };
    };
    const desc = document.getElementById('problemDesc');
    return {
      rows: getComputedStyle(document.getElementById('mainArea')).gridTemplateRows,
      descPanel: rect('#descPanel'),
      descHead: rect('#descPanel .panel-head'),
      descMeta: rect('#problemMeta'),
      descScroll: rect('#problemDesc'),
      descFoot: rect('.desc-foot'),
      metaText: document.getElementById('problemMeta').textContent.trim().slice(0, 120),
      metaLines: (() => {
        const el = document.getElementById('problemMeta');
        const lh = parseFloat(getComputedStyle(el).lineHeight) || 20;
        return Math.round(el.scrollHeight / lh);
      })(),
      toggleHidden: document.getElementById('descToggle').hidden,
    };
  })()
`);

chrome.kill();
try {
  fs.rmSync(profile, { recursive: true, force: true });
} catch {}

console.log('=== 一、桌面（1600x1000）三个把手撑满情况 ===');
console.log('主区域高:', bothCollapsed.mainH, ' rows:', bothCollapsed.mainRows, ' cols:', bothCollapsed.mainCols);
console.log('左栏把手:', JSON.stringify(bothCollapsed.reopenList));
console.log('题面把手:', JSON.stringify(bothCollapsed.reopenDesc));
console.log('代码区  高:', bothCollapsed.codeH, `(${bothCollapsed.codeTop}~${bothCollapsed.codeBottom})`);
console.log('');
console.log('只收左栏时（应和题面等高）:');
console.log(' ', JSON.stringify(onlyList));
console.log('');
console.log('=== 二、窄屏（900x640）题面区高度构成 ===');
console.log('  rows:', narrow.rows);
console.log('  题面面板:', JSON.stringify(narrow.descPanel));
console.log('    标题栏:', JSON.stringify(narrow.descHead));
console.log('    meta  :', JSON.stringify(narrow.descMeta), ' 行数≈', narrow.metaLines);
console.log('    正文  :', JSON.stringify(narrow.descScroll));
console.log('    底部  :', JSON.stringify(narrow.descFoot));
console.log('  正文内容:', JSON.stringify(narrow.metaText));
console.log('  展开按钮 hidden =', narrow.toggleHidden);

const checks = [
  ['左栏把手撑满整行（不再是一小块）', bothCollapsed.reopenList.h > bothCollapsed.mainH * 0.9],
  ['题面把手撑满整行', bothCollapsed.reopenDesc.h > bothCollapsed.mainH * 0.9],
  ['两个把手等高', Math.abs(bothCollapsed.reopenList.h - bothCollapsed.reopenDesc.h) <= 2],
  ['把手宽度仍是 40px', bothCollapsed.reopenList.w === 40 && bothCollapsed.reopenDesc.w === 40],
  ['只收左栏时和题面等高', onlyList.sameHeight && onlyList.sameTop],
  ['题面展开按钮在窄屏仍可见', narrow.toggleHidden === false],
];
console.log('');
for (const [name, pass] of checks) console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}`);

const allPass = checks.every(([, p]) => p);
console.log('');
console.log(allPass ? '结论: 把手已撑满整行，与题目区等高。' : '结论: 有未通过项。');
process.exit(allPass ? 0 : 1);

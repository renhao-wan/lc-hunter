/*
 * 窄视口下的自定义下拉。
 *
 * 单独一个脚本是因为这属于「弹层定位」类改动最容易翻车的地方：
 * 弹层是 fixed 定位的，视口一小、操作条一换行，就可能
 *   1. 跑到视口外面（用户根本看不到）；
 *   2. 压在触发器上或者方向反了；
 *   3. 把左栏标题栏里的搜索框挤成 0 宽。
 * 三条都量出来。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const BASE = process.env.LC_BASE || 'http://127.0.0.1:7788';
const PORT = 9391;
const profile = path.join(os.tmpdir(), 'lc-dd-narrow-' + Date.now());
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

for (let i = 0; i < 40; i++) {
  await sleep(250);
  try {
    const j = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
    if (j.webSocketDebuggerUrl) break;
  } catch {}
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
const consoleErrors = [];
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.method === 'Runtime.exceptionThrown') {
    consoleErrors.push(m.params?.exceptionDetails?.exception?.description || 'unknown');
  }
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

async function setViewport(w, h) {
  await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 2, mobile: false });
}
async function ready() {
  for (let i = 0; i < 40; i++) {
    await sleep(250);
    if ((await evaluate('document.readyState')) === 'complete') break;
  }
  await sleep(1800);
}
async function shot(name) {
  const s = await send('Page.captureScreenshot', { format: 'png' });
  if (s.result?.data) {
    fs.writeFileSync(name, Buffer.from(s.result.data, 'base64'));
    console.log('  已保存', name);
  }
}

await setViewport(900, 640);
await ready();
await evaluate(`localStorage.setItem('lc-collapse-list','0'); localStorage.setItem('lc-collapse-desc','0'); localStorage.removeItem('lc-code-lock'); localStorage.removeItem('lc-collapse-code'); true;`);
await send('Page.navigate', { url: BASE });
await ready();

const checks = [];
const sizes = [
  [900, 640],
  [1024, 700],
  [1280, 820],
];

for (const [w, h] of sizes) {
  await setViewport(w, h);
  await sleep(600);
  console.log(`\n=== ${w}x${h} ===`);

  // 三个下拉逐个打开量弹层位置
  for (const id of ['planSel', 'modeSel', 'filterSel']) {
    const r = await evaluate(`
      (() => {
        document.body.click(); // 先关掉可能开着的
        const s = document.getElementById(${JSON.stringify(id)});
        const trg = s.parentElement.querySelector('.dd-trigger');
        trg.click();
        const pop = document.querySelector('.dd-pop:not([hidden])');
        if (!pop) return { open: false };
        const p = pop.getBoundingClientRect();
        const t = trg.getBoundingClientRect();
        return {
          open: true,
          pw: Math.round(p.width), ph: Math.round(p.height),
          inside: p.left >= -1 && p.top >= -1 && p.right <= innerWidth + 1 && p.bottom <= innerHeight + 1,
          // 弹层要么在触发器下方，要么（空间不够时）翻到上方，两者不能压在触发器上
          below: p.top >= t.bottom - 2,
          above: p.bottom <= t.top + 2,
          left: Math.round(p.left), top: Math.round(p.top),
        };
      })()
    `);
    const ok = r.open && r.inside && (r.below || r.above);
    console.log(
      `  ${id.padEnd(10)} 开=${r.open} 尺寸=${r.pw}x${r.ph} 视口内=${r.inside} 下方=${r.below} 上方=${r.above} left=${r.left} top=${r.top} ${ok ? '' : '★'}`,
    );
    checks.push([`${w}x${h} ${id} 弹层完整在视口内且不压触发器`, ok]);
  }
  await evaluate(`document.body.click()`);

  // 左栏标题栏里搜索框不能被下拉挤没
  const head = await evaluate(`
    (() => {
      const head = document.querySelector('#listPanel .panel-head');
      const inp = document.getElementById('searchInput');
      const dd = document.querySelector('#filterSel').parentElement;
      const btn = document.getElementById('collapseList');
      return {
        headW: Math.round(head.getBoundingClientRect().width),
        searchW: Math.round(inp.getBoundingClientRect().width),
        ddW: Math.round(dd.getBoundingClientRect().width),
        btnW: Math.round(btn.getBoundingClientRect().width),
        overflow: head.scrollWidth > head.clientWidth + 1,
      };
    })()
  `);
  console.log(`  左栏标题栏: 宽=${head.headW} 搜索框=${head.searchW} 下拉=${head.ddW} 折叠按钮=${head.btnW} 横向溢出=${head.overflow}`);
  checks.push([`${w}x${h} 搜索框没被下拉挤没（>40px）`, head.searchW > 40]);
  checks.push([`${w}x${h} 左栏标题栏不横向溢出`, !head.overflow]);
}

await setViewport(900, 640);
await sleep(500);
await evaluate(`document.querySelector('#filterSel').parentElement.querySelector('.dd-trigger').click()`);
await sleep(500);
await shot('test/_polish-8-dd-narrow.png');

chrome.kill();
try {
  fs.rmSync(profile, { recursive: true, force: true });
} catch {}

console.log('\n=== 结果 ===');
let fail = 0;
for (const [name, ok] of checks) {
  if (!ok) fail++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`);
}
console.log(`  ${consoleErrors.length === 0 ? 'PASS' : 'FAIL'}  无 JS 报错`);
console.log(`\n${fail === 0 && consoleErrors.length === 0 ? '全部通过' : '有失败项：' + fail}`);

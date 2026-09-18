/*
 * 桌面化改造的截图验收：
 *   1. 新顶栏（应用图标 + 学习计划 + 统计 + 设置，没有"绑定账号"）
 *   2. 设置面板五个分类各自的样子
 * 需要先起服务：LC_BASE 默认 http://127.0.0.1:7788
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const BASE = process.env.LC_BASE || 'http://127.0.0.1:7788';
const PORT = 9351;
const profile = path.join(os.tmpdir(), 'lc-shots-desk-' + Date.now());
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
await send('Emulation.setDeviceMetricsOverride', {
  width: 1500,
  height: 900,
  deviceScaleFactor: 2,
  mobile: false,
});

/*
 * 截图。统一输出 JPEG：
 * PNG 走读图工具时会被"内容相同"判定命中缓存 —— 改完样式重新截，
 * 看到的还是改动前那张，白排查半天。JPEG 这条路实测每次都拿到新帧。
 */
async function shot(name) {
  const file = name.replace(/\.png$/, '') + '.jpg';
  const s = await send('Page.captureScreenshot', { format: 'jpeg', quality: 88 });
  if (s.result?.data) {
    fs.writeFileSync(file, Buffer.from(s.result.data, 'base64'));
    console.log('已保存', file, fs.statSync(file).size, '字节');
  } else console.log('截图失败', file);
}

async function ready() {
  for (let i = 0; i < 40; i++) {
    await sleep(250);
    if ((await evaluate('document.readyState')) === 'complete') break;
  }
  await sleep(1800);
}

await ready();

// 自检：DOM 层面的结构性检查。state 是脚本顶层的 const（不挂 window），
// 但它在全局词法作用域里，直接写 state 就能读到
const errs = await evaluate(`
  (() => {
    const out = [];
    if (typeof state === 'undefined') out.push('app.js 没跑起来（state 不存在）');
    if (!document.getElementById('settingsBtn')) out.push('没有设置按钮');
    if (document.getElementById('bindBtn')) out.push('顶栏还挂着旧的绑定按钮');
    if (document.getElementById('themeBtn')) out.push('顶栏还挂着旧的主题按钮');
    if (!document.querySelector('.brand-mark')) out.push('顶栏没有应用图标');
    if (!document.getElementById('syncMine')?.closest('#settingsModal'))
      out.push('同步按钮不在设置面板里');
    const st = document.getElementById('stats');
    if (!st || !st.textContent.trim()) out.push('顶栏统计是空的');
    return out;
  })()
`);
console.log('自检问题：', errs.length ? errs.join(' / ') : '无');

/*
 * 截图环境（headless Chrome）的 prefers-color-scheme 是浅色，
 * 而应用默认「跟随系统」，所以不显式指定的话两套主题截出来都是浅色。
 */
await evaluate(`setThemeMode('dark')`);
await sleep(400);
console.log(
  '截图前状态：',
  await evaluate(`document.documentElement.dataset.theme`),
  await evaluate(`getComputedStyle(document.body).backgroundColor`),
);
await shot('test/_desk-1-main-dark.png');

// 设置：五个分类逐个截图
for (const pane of ['account', 'plans', 'data', 'appearance', 'about']) {
  await evaluate(`openSettings(${JSON.stringify(pane)})`);
  await sleep(pane === 'account' ? 1600 : 700);
  await shot(`test/_desk-2-settings-${pane}.png`);
}

// 浅色下再看一眼设置（桌面端两种系统主题都会遇到）
await evaluate(`setThemeMode('light'); switchPane('data'); true`);
await sleep(500);
await shot('test/_desk-3-settings-light.png');
await evaluate(`setThemeMode('dark'); true`);

// 学习计划广场（三个同步按钮应该已经不在这里了）
await evaluate(`closeSettings(); openPlans(); true`);
await sleep(9000);
await shot('test/_desk-4-plans.png');

chrome.kill();
try {
  fs.rmSync(profile, { recursive: true, force: true });
} catch {}

/*
 * 「登录后自动导入学习计划」验收。
 *
 * 验收的是编排本身，不是网络：把 /api/plans/sync 与 /api/sync/status 拦下来
 * 返回假数据，然后看自动流程有没有按正确顺序、用正确的参数把这两步走完。
 * （真去力扣拉一次要一两分钟，没法进回归。）
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const BASE = process.env.LC_BASE || 'http://127.0.0.1:7788';
const PORT = 9354;
const profile = path.join(os.tmpdir(), 'lc-auto-import-' + Date.now());
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
    await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
    break;
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
for (let i = 0; i < 40; i++) {
  await sleep(250);
  if ((await evaluate('document.readyState')) === 'complete') break;
}
await sleep(2500);

// --- 装好拦截器
await evaluate(`
  (() => {
    window.__calls = [];
    const orig = window.fetch;
    const json = (obj) => Promise.resolve(new Response(JSON.stringify(obj), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    }));
    window.fetch = function (url, init) {
      const u = String(url);
      const m = (init && init.method) || 'GET';
      window.__calls.push(m + ' ' + u + (init && init.body ? ' ' + init.body : ''));
      if (u.includes('/api/plans/sync')) {
        return json({ ok: true, plans: [{ slug: 'top-100-liked', name: '热题 100', count: 100 }] });
      }
      if (u.includes('/api/sync/status')) {
        return m === 'POST'
          ? json({ ok: true, started: true })
          : json({ ok: true, running: false, done: true, message: '已同步 4443 题' });
      }
      return orig.apply(this, arguments);
    };
    return true;
  })()
`);

// --- 1. 自动导入：应该先导计划，再补刷题状态
const autoRun = await evaluate(`
  (async () => {
    window.__calls = [];
    await autoImportPlans();
    return { calls: window.__calls.slice(), toast: document.getElementById('toast').textContent };
  })()
`);

// --- 2. 关掉开关时，启动流程不该发任何请求
const offRun = await evaluate(`
  (async () => {
    localStorage.setItem('lc-auto-sync', '0');
    // 读开关必须在恢复之前 —— 先 setItem('1') 再读，读到的永远是 true
    const enabledWhileOff = autoSyncEnabled();
    window.__calls = [];
    await maybeAutoSync();
    const calls = window.__calls.slice();
    localStorage.setItem('lc-auto-sync', '1');
    return { calls, enabled: enabledWhileOff };
  })()
`);

// --- 3. 开关打开、但本地已经有我加入的计划且状态是新鲜的 → 也不该动
const freshRun = await evaluate(`
  (async () => {
    window.__calls = [];
    await maybeAutoSync();
    return {
      calls: window.__calls.slice(),
      mine: (lastState?.plans || []).filter(p => p.source === 'mine').length,
      syncedAt: lastState?.statusSyncedAt || null,
    };
  })()
`);

chrome.kill();
try {
  fs.rmSync(profile, { recursive: true, force: true });
} catch {}

const importedPlan = autoRun.calls.some((c) => c.startsWith('POST /api/plans/sync') && c.includes('"mine":true'));
const importedStatus = autoRun.calls.some((c) => c.startsWith('POST /api/sync/status'));
const orderOk =
  autoRun.calls.findIndex((c) => c.includes('/api/plans/sync')) <
  autoRun.calls.findIndex((c) => c.includes('/api/sync/status'));

const checks = [
  ['自动导入发起了「同步我加入的计划」', importedPlan],
  ['自动导入接着补了「刷题状态」', importedStatus],
  ['顺序是「先导计划、再同步状态」', orderOk],
  ['完成后给了用户一句提示', /自动导入|已同步|学习计划/.test(autoRun.toast)],
  ['关掉开关后启动流程不发请求', offRun.calls.length === 0],
  ['开关关闭状态能被读到', offRun.enabled === false],
  [
    '已有计划且状态新鲜时不动手（不做无谓的全量同步）',
    freshRun.calls.length === 0 && freshRun.mine > 0 && freshRun.syncedAt,
  ],
];

console.log('=== 自动导入学习计划验收 ===\n');
let bad = 0;
for (const [name, ok] of checks) {
  if (!ok) bad++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`);
}
console.log('\n自动导入发出的请求：');
for (const c of autoRun.calls) console.log('  ·', c.slice(0, 110));
console.log(
  `\n当前状态：我加入的计划 ${freshRun.mine} 个 · 最后同步 ${
    freshRun.syncedAt ? new Date(Number(freshRun.syncedAt)).toLocaleString('zh-CN') : '从未'
  }`,
);
console.log(bad ? `\n结论: ${bad} 项不通过。` : '\n结论: 全部通过。');

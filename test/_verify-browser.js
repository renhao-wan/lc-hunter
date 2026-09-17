/**
 * 验证浏览器探测 + CDP 抓 Cookie 这条路能不能走通。
 * 不真的让用户登录：只起浏览器、连 CDP、读一次 Cookie，确认链路是活的。
 */
import fs from 'node:fs';
import { findBrowser, browserReport } from '../src/leetcode/browser.js';

const out = [];
const log = (s) => { out.push(s); console.log(s); };

log('=== 浏览器探测 ===');
log(JSON.stringify(browserReport(), null, 2));

const b = findBrowser();
if (!b) {
  log('没找到浏览器，退出');
  fs.writeFileSync('test/_verify-browser.txt', out.join('\n'), 'utf8');
  process.exit(1);
}

// 只验证能起来 + CDP 能读 Cookie，不进入登录等待循环
log('\n=== 起浏览器 + 连 CDP ===');
const { spawn } = await import('node:child_process');
const os = await import('node:os');
const path = await import('node:path');

const port = 9333;
const profileDir = path.join(os.tmpdir(), `lc-probe-${Date.now()}`);
fs.mkdirSync(profileDir, { recursive: true });

const child = spawn(
  b.path,
  [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-blink-features=AutomationControlled',
    '--window-size=520,760',
    'https://leetcode.cn/accounts/login/',
  ],
  { stdio: 'ignore' },
);
log('spawned pid=' + child.pid);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  // 等 CDP 就绪
  let ver = null;
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (r.ok) { ver = await r.json(); break; }
    } catch { /* retry */ }
    await sleep(300);
  }
  if (!ver) throw new Error('CDP 端口没起来');
  log('CDP 就绪: ' + ver.Browser);

  const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json());
  log('targets: ' + targets.map((t) => `${t.type}:${(t.url || '').slice(0, 60)}`).join(' | '));

  const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
  if (!page) throw new Error('没有 page target');

  // 手写的最小 CDP
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res);
    ws.addEventListener('error', () => rej(new Error('ws error')));
    setTimeout(() => rej(new Error('ws timeout')), 8000);
  });
  log('WebSocket 已连接');

  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data));
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id);
      pending.delete(m.id);
      m.error ? reject(new Error(m.error.message)) : resolve(m.result);
    }
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const i = ++id;
    pending.set(i, { resolve, reject });
    ws.send(JSON.stringify({ id: i, method, params }));
    setTimeout(() => { if (pending.has(i)) { pending.delete(i); reject(new Error(method + ' timeout')); } }, 10000);
  });

  await send('Network.enable');
  log('Network.enable OK');

  const cookies = await send('Network.getCookies', { urls: ['https://leetcode.cn/'] });
  const names = (cookies.cookies || []).map((c) => c.name);
  log('cookies on leetcode.cn: ' + JSON.stringify(names));
  log('LEETCODE_SESSION present? ' + names.includes('LEETCODE_SESSION'));

  // 确认页面真的加载了力扣（DOM 里有东西）
  await sleep(2500);
  const r = await send('Runtime.evaluate', { expression: 'document.title + " | " + document.location.href', returnByValue: true });
  log('page title/url: ' + JSON.stringify(r.result?.value));

  ws.close();
  log('\n结论: 链路可用 —— 能起浏览器、连 CDP、读 Cookie、读页面。');
} catch (e) {
  log('\n失败: ' + e.message);
} finally {
  try { child.kill(); } catch { /* ignore */ }
  await sleep(1500);
  try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch { /* ignore */ }
}

fs.writeFileSync('test/_verify-browser.txt', out.join('\n'), 'utf8');
console.log('\nwritten test/_verify-browser.txt');

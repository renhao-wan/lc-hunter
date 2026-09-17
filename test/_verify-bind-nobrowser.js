/*
 * 验收：没有浏览器时，绑定弹窗给出的是"去装一个浏览器"的指引，
 * 而不是任何形式的"粘贴 Cookie"退路。
 *
 * 手法：在页面里把 /api/bind/capability 的响应改写成 browser.ok=false，
 * 然后重新打开弹窗，看界面怎么表现。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const BASE = process.env.LC_BASE || 'http://127.0.0.1:7788';
const PORT = 9334;
const profile = path.join(os.tmpdir(), 'lc-verify-nb-' + Date.now());

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
  { stdio: ['ignore', 'pipe', 'pipe'] }
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

for (let i = 0; i < 40; i++) {
  await sleep(250);
  if ((await evaluate('document.readyState')) === 'complete') break;
}
await sleep(1200);

// 拦掉能力探测，让界面以为本机没有浏览器
await evaluate(`
  (() => {
    const orig = window.fetch;
    window.fetch = function (url, opts) {
      if (String(url).includes('/api/bind/capability')) {
        return Promise.resolve(new Response(JSON.stringify({
          ok: true,
          browser: { ok: false, name: null, path: null, source: null,
                     hint: '没找到 Chrome / Edge / Chromium。装一个任意的即可。' },
          bound: false,
          account: { signedIn: false },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
      }
      return orig.apply(this, arguments);
    };
    return true;
  })()
`);

// 重新走一遍打开弹窗的流程（会重新拉 capability）
const opened = await evaluate(`
  (async () => {
    const btn = document.getElementById('bindBtn');
    if (btn) btn.click();
    else { document.getElementById('bindModal').hidden = false; if (window.loadBind) await window.loadBind(); }
    await new Promise(r => setTimeout(r, 1500));
    return 'ok';
  })()
`);

const r = await evaluate(`
  (() => {
    const modal = document.getElementById('bindModal');
    const scope = modal || document;
    const fields = scope.querySelectorAll('input, textarea');
    const bio = document.getElementById('bindBrowserInfo');
    const login = document.getElementById('bindLogin');
    const text = modal ? modal.innerText : '';
    return {
      fieldCount: fields.length,
      fieldIds: [...fields].map(f => f.id || f.tagName),
      manualWrap: !!document.getElementById('bindManualWrap'),
      browserInfo: bio ? bio.textContent.trim() : '',
      browserInfoCls: bio ? bio.className : '',
      loginText: login ? login.textContent.trim() : '',
      loginDisabled: login ? !!login.disabled : null,
      mentionsInstall: /装一个|Chrome|Edge/.test(text),
      mentionsPaste: /粘贴|复制.*Cookie|开发者工具/i.test(text),
      lead: document.getElementById('bindLead')?.textContent.trim() || '',
      modalText: text.replace(/\\s+/g, ' ').slice(0, 300),
    };
  })()
`);

chrome.kill();
try {
  fs.rmSync(profile, { recursive: true, force: true });
} catch {}

const checks = [
  ['弹窗内 input/textarea 仍为 0', r.fieldCount === 0],
  ['旧的 #bindManualWrap 不存在', !r.manualWrap],
  ['提示里给出了"装一个浏览器"的指引', r.mentionsInstall],
  ['提示里没有出现粘贴/开发者工具字样', !r.mentionsPaste],
  ['主按钮被禁用', r.loginDisabled === true],
  ['主按钮文案说明缺什么', /浏览器/.test(r.loginText)],
  ['引导语不再让人"点下面按钮"', !/点下面按钮/.test(r.lead)],
];

console.log('=== 「没有浏览器」路径验收 ===');
console.log('打开方式:', opened);
console.log('');
for (const [name, pass] of checks) console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}`);
console.log('');
console.log('  浏览器提示:', JSON.stringify(r.browserInfo), `[${r.browserInfoCls}]`);
console.log('  引导语    :', JSON.stringify(r.lead));
console.log('  主按钮    :', JSON.stringify(r.loginText), r.loginDisabled ? '(已禁用)' : '(可点)');
console.log('  弹窗文本  :', JSON.stringify(r.modalText));

const allPass = checks.every(([, p]) => p);
console.log('');
console.log(allPass ? '结论: 没有浏览器时引导用户去装，不存在任何粘贴退路。' : '结论: 有未通过项。');
process.exit(allPass ? 0 : 1);

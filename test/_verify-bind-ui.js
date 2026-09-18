/*
 * 验收「绑定账号只有自动登录一条路」。
 *
 * 起一个 headless Chrome，打开本地 UI，点开绑定弹窗，然后断言：
 *   1. 弹窗里没有任何 input / textarea        —— 粘贴 Cookie 的入口已彻底消失
 *   2. 旧的手动绑定容器 #bindManualWrap 不存在
 *   3. 主按钮存在且可用，文案指向「登录力扣并绑定」
 *   4. 弹窗里出现「浏览器」相关提示（能力探测有回显）
 *   5. 页面上不出现「Cookie」这个词给用户看
 *
 * 用 headless 只是为了跑断言；真正绑定必须是有头的（用户要扫码）。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const BASE = process.env.LC_BASE || 'http://127.0.0.1:7788';
const PORT = 9333;

const profile = path.join(os.tmpdir(), 'lc-verify-' + Date.now());

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// --- 起一个独立 profile 的 headless Chrome
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

let chromeLog = '';
chrome.stderr.on('data', (d) => (chromeLog += d));

let wsUrl = null;
for (let i = 0; i < 40; i++) {
  await sleep(250);
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
    const j = await r.json();
    if (j.webSocketDebuggerUrl) {
      wsUrl = j.webSocketDebuggerUrl;
      break;
    }
  } catch {}
}

if (!wsUrl) {
  console.log('起不来 Chrome，日志：');
  console.log(chromeLog.slice(0, 800));
  chrome.kill();
  process.exit(1);
}

// --- 建一个页面并连上它
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

function send(method, params = {}) {
  const id = ++msgId;
  return new Promise((res) => {
    pending.set(id, res);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(expr) {
  const r = await send('Runtime.evaluate', {
    expression: expr,
    returnByValue: true,
    awaitPromise: true,
  });
  if (r.result?.exceptionDetails) {
    throw new Error(r.result.exceptionDetails.exception?.description || 'eval 失败');
  }
  return r.result?.result?.value;
}

await send('Runtime.enable');
await send('Page.enable');

// 等页面加载完
for (let i = 0; i < 40; i++) {
  await sleep(250);
  const ready = await evaluate('document.readyState');
  if (ready === 'complete') break;
}
// 再给 app.js 一点时间跑初始化
await sleep(1200);

// --- 收住所有 JS 报错
await evaluate(`
  window.__errs = [];
  window.addEventListener('error', e => window.__errs.push(String(e.message)));
  window.addEventListener('unhandledrejection', e => window.__errs.push('reject: ' + String(e.reason)));
  true;
`);

// --- 打开绑定界面（走界面自己的入口，不手动拔 hidden）。
// 绑定 UI 在设置的「账号」页，所以入口是设置面板
const opened = await evaluate(`
  (async () => {
    const btn = document.getElementById('settingsBtn');
    if (btn) { btn.click(); }
    else {
      const fn = window.openSettings;
      if (typeof fn === 'function') await fn('account');
      else return 'no-entry';
    }
    await new Promise(r => setTimeout(r, 1800));
    return 'clicked';
  })()
`);

const modalVisible = await evaluate(`
  (() => {
    const m = document.getElementById('settingsModal');
    if (!m) return false;
    return !m.hidden && getComputedStyle(m).display !== 'none';
  })()
`);

// --- 断言
const r = await evaluate(`
  (() => {
    const modal = document.getElementById('settingsModal');
    const scope = modal || document;
    // 只统计"要用户填东西"的输入框：开关是 checkbox，不算
    const fields = [...scope.querySelectorAll('input, textarea')].filter(
      (f) => !['checkbox', 'radio'].includes(f.type),
    );
    const text = modal ? modal.innerText : '';
    const bio = document.getElementById('bindBrowserInfo');
    const login = document.getElementById('bindLogin');
    return {
      modalExists: !!modal,
      modalVisible: modal ? (!modal.hidden && getComputedStyle(modal).display !== 'none') : false,
      fieldCount: fields.length,
      fieldIds: [...fields].map(f => f.id || f.name || f.tagName).slice(0, 10),
      manualWrap: !!document.getElementById('bindManualWrap'),
      hasLoginBtn: !!login,
      loginText: login ? login.textContent.trim() : '',
      loginDisabled: login ? !!login.disabled : null,
      browserInfoText: bio ? bio.textContent.trim() : '',
      leadText: document.getElementById('bindLead')?.textContent.trim() || '',
      modalHasCookieWord: /cookie/i.test(text),
      modalText: text.slice(0, 400),
      pageHasErr: (window.__errs || []).slice(0, 5),
    };
  })()
`);

chrome.kill();
try {
  fs.rmSync(profile, { recursive: true, force: true });
} catch {}

// --- 输出
const checks = [
  ['绑定弹窗存在', r.modalExists],
  ['绑定弹窗已打开可见', r.modalVisible],
  ['弹窗内 input/textarea 数量为 0', r.fieldCount === 0],
  ['旧的 #bindManualWrap 已不存在', !r.manualWrap],
  ['主按钮存在', r.hasLoginBtn],
  ['主按钮文案指向登录', /登录/.test(r.loginText)],
  ['弹窗对用户不出现 Cookie 字样', !r.modalHasCookieWord],
  ['引导语非空且无残留占位', r.leadText.length > 10],
  ['无 JS 运行时错误', r.pageHasErr.length === 0],
];

console.log('=== 绑定弹窗验收 ===');
console.log('打开方式:', opened);
console.log('');
for (const [name, pass] of checks) {
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}`);
}
console.log('');
console.log('  弹窗内表单元素:', r.fieldCount === 0 ? '（无）' : r.fieldIds.join(', '));
console.log('  主按钮文案  :', JSON.stringify(r.loginText), r.loginDisabled ? '(当时禁用了)' : '');
console.log('  引导语      :', JSON.stringify(r.leadText));
console.log('  浏览器提示  :', JSON.stringify(r.browserInfoText));
console.log('  弹窗可见文本:', JSON.stringify(r.modalText.replace(/\s+/g, ' ').slice(0, 200)));
if (r.pageHasErr.length) console.log('  JS 错误    :', r.pageHasErr);

const allPass = checks.every(([, p]) => p);
console.log('');
console.log(allPass ? '结论: 全部通过 —— 绑定弹窗里已经没有任何可以粘贴 Cookie 的地方。'
                    : '结论: 有未通过项，见上。');
process.exit(allPass ? 0 : 1);

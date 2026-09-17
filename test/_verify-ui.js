/*
 * 界面验收：直连 CDP 打开本地页面，采集布局色值 + DOM 状态，并截图。
 *
 * 为什么不用 agent-browser：本环境 bash 缺 dirname/sed，它的 shell wrapper 起不来；
 * 改成 spawn JS 入口后又会被后台任务的杀进程逻辑卡死。项目里本来就有
 * 一个手写的极简 CDP 客户端（src/leetcode/browser.js），直接拿来用最稳。
 *
 * 用法：node test/_verify-ui.js [theme]
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const URL = 'http://127.0.0.1:7788/';
const THEME = process.argv[2] || 'light';
const OUT = 'test/_verify.json';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
    srv.on('error', reject);
  });
}

async function waitDevtools(port, timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (r.ok) return await r.json();
    } catch {
      /* not up yet */
    }
    await sleep(300);
  }
  throw new Error('devtools 端口未就绪');
}

/** 极简 CDP：只要 navigate + evaluate + screenshot */
class Cdp {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.id = 0;
    this.pending = new Map();
    this.ws = null;
  }
  async connect() {
    this.ws = new WebSocket(this.wsUrl);
    await new Promise((res, rej) => {
      const to = setTimeout(() => rej(new Error('CDP connect timeout')), 10000);
      this.ws.addEventListener('open', () => {
        clearTimeout(to);
        res();
      });
      this.ws.addEventListener('error', (e) => {
        clearTimeout(to);
        rej(new Error('CDP error: ' + (e.message || '?')));
      });
    });
    this.ws.addEventListener('message', (ev) => {
      let m;
      try {
        m = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data));
      } catch {
        return;
      }
      const p = this.pending.get(m.id);
      if (p) {
        this.pending.delete(m.id);
        m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result);
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error('CDP 调用超时: ' + method));
        }
      }, 20000);
    });
  }
  close() {
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
  }
}

const log = [];
function note(step, data) {
  log.push({ step, ...data });
  fs.writeFileSync(OUT, JSON.stringify(log, null, 1), 'utf8');
}

const port = await freePort();
const profile = `C:/Users/Lenovo/AppData/Local/Temp/lc-verify-${Date.now()}`;

note('launch', { port, chrome: fs.existsSync(CHROME) });

const chrome = spawn(
  CHROME,
  [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--headless=new',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--window-size=1440,900',
    'about:blank',
  ],
  { stdio: 'ignore', detached: false },
);

try {
  await waitDevtools(port);
  note('devtools-ready', { ok: true });

  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = targets.find((t) => t.type === 'page');
  if (!page) throw new Error('没有可用的 page target');

  const cdp = new Cdp(page.webSocketDebuggerUrl);
  await cdp.connect();
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');

  // 先注入主题，再导航，避免闪一下深色
  await cdp.send('Page.navigate', { url: URL });
  await sleep(1800);
  await cdp.send('Runtime.evaluate', {
    expression: `document.documentElement.dataset.theme=${JSON.stringify(THEME)}; localStorage.setItem('lc-theme',${JSON.stringify(THEME)});`,
  });
  await sleep(400);

  // 采一份状态。用 Runtime.evaluate 的 returnByValue 直接拿对象
  const expr = `(() => {
    const cs = (sel) => { const n=document.querySelector(sel); return n?getComputedStyle(n):null; };
    const g = (sel,prop) => { const s=cs(sel); return s?s[prop]:null; };
    return {
      theme: document.documentElement.dataset.theme,
      pool: (document.getElementById('poolCount')||{}).textContent,
      poolClass: (document.getElementById('poolCount')||{}).className,
      stats: (document.getElementById('stats')||{}).innerText,
      rows: document.querySelectorAll('.prob').length,
      groupHeads: [...document.querySelectorAll('.group-head')].map(n=>n.innerText.replace(/\\s+/g,' ')),
      firstRow: (document.querySelector('.prob')||{}).innerText,
      scopeBarHidden: (document.getElementById('scopeBar')||{}).hidden,
      scopeLabel: (document.getElementById('scopeLabel')||{}).textContent,
      modeOptions: [...document.querySelectorAll('#modeSel option')].map(o=>o.textContent),
      colors: {
        body: g('body','backgroundColor'),
        topbar: g('.topbar','backgroundColor'),
        actionbar: g('.actionbar','backgroundColor'),
        panel: g('.panel','backgroundColor'),
        panelHead: g('.panel-head','backgroundColor'),
        editor: g('#editor','backgroundColor'),
        border: g('.panel','borderTopColor'),
        shadow: g('.panel','boxShadow'),
      },
      sizes: {
        mainGap: g('#mainArea','columnGap'),
        mainPad: g('#mainArea','padding'),
        topbarH: cs('.topbar')?.height,
      },
      descClamp: {
        hasClass: document.getElementById('problemDesc')?.className,
        toggleHidden: document.getElementById('descToggle')?.hidden,
      },
      error: window.__lastError || null,
    };
  })()`;

  const res = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true });
  note('state', { value: res.result?.value || null, exception: res.exceptionDetails?.text || null });

  // 选一个计划，看分组与数量联动
  await cdp.send('Runtime.evaluate', {
    expression: `(() => {
      const s=document.getElementById('planSel');
      const opt=[...s.options].find(o=>o.value==='top-interview-150');
      if(opt){ s.value='top-interview-150'; s.dispatchEvent(new Event('change')); return 'selected'; }
      return 'not-found:'+[...s.options].map(o=>o.value).join(',');
    })()`,
    returnByValue: true,
  }).then((r) => note('select-plan', { value: r.result?.value }));
  await sleep(1500);

  const res2 = await cdp.send('Runtime.evaluate', {
    expression: `JSON.stringify({
      pool: (document.getElementById('poolCount')||{}).textContent,
      rows: document.querySelectorAll('.prob').length,
      groupHeads: [...document.querySelectorAll('.group-head')].map(n=>n.innerText.replace(/\\s+/g,' ')),
      scopeLabel: (document.getElementById('scopeLabel')||{}).textContent,
      firstTitle: (document.querySelector('.pname')||{}).textContent
    })`,
    returnByValue: true,
  });
  note('after-plan', { value: res2.result?.value });

  // 切「抽什么样的」→ 数量应立刻变
  for (const m of ['new', 'ac', 'due', 'all']) {
    await cdp.send('Runtime.evaluate', {
      expression: `(() => { const s=document.getElementById('modeSel'); s.value=${JSON.stringify(m)}; s.dispatchEvent(new Event('change')); })()`,
    });
    await sleep(900);
    const r = await cdp.send('Runtime.evaluate', {
      expression: `(document.getElementById('poolCount')||{}).textContent`,
      returnByValue: true,
    });
    note('mode-' + m, { pool: r.result?.value });
  }

  // 打开一道题，检查题面折叠
  await cdp.send('Runtime.evaluate', {
    expression: `document.querySelector('.prob')?.click()`,
  });
  await sleep(2200);
  const r3 = await cdp.send('Runtime.evaluate', {
    expression: `JSON.stringify({
      title: (document.getElementById('problemTitle')||{}).textContent,
      descClass: document.getElementById('problemDesc')?.className,
      toggleHidden: document.getElementById('descToggle')?.hidden,
      toggleText: (document.getElementById('descToggle')||{}).textContent,
      meta: (document.getElementById('problemMeta')||{}).innerText,
      welcomeHidden: (document.getElementById('welcome')||{}).hidden
    })`,
    returnByValue: true,
  });
  note('problem-open', { value: r3.result?.value });

  // 展开题面
  await cdp.send('Runtime.evaluate', {
    expression: `document.getElementById('descToggle')?.click()`,
  });
  await sleep(500);
  const r4 = await cdp.send('Runtime.evaluate', {
    expression: `JSON.stringify({
      descClass: document.getElementById('problemDesc')?.className,
      toggleText: (document.getElementById('descToggle')||{}).textContent
    })`,
    returnByValue: true,
  });
  note('desc-expanded', { value: r4.result?.value });

  // 截图
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(`test/_verify-${THEME}.png`, Buffer.from(shot.data, 'base64'));
  note('screenshot', { file: `test/_verify-${THEME}.png` });

  cdp.close();
} catch (e) {
  note('ERROR', { message: e.message, stack: (e.stack || '').slice(0, 600) });
} finally {
  try {
    chrome.kill();
  } catch {
    /* ignore */
  }
  console.log('VERIFY_DONE');
  process.exit(0);
}

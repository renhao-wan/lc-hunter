/*
 * 验证三处折叠：左栏收起 / 题面收起 / 计划分组折叠。
 * 收起后必须满足两条：
 *  1. 展开把手可见且不浮在别的内容上（占自己的格子，宽度 40px）
 *  2. 各栏宽度之和等于容器宽度（没有 0 宽度的坑）
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const URL = 'http://127.0.0.1:7788/';
const OUT = 'test/_verify-collapse.json';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freePort() {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
}

async function waitDevtools(port, timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (r.ok) return;
    } catch {
      /* not yet */
    }
    await sleep(300);
  }
  throw new Error('devtools 未就绪');
}

class Cdp {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.id = 0;
    this.pending = new Map();
  }
  async connect() {
    this.ws = new WebSocket(this.wsUrl);
    await new Promise((res, rej) => {
      const to = setTimeout(() => rej(new Error('connect timeout')), 10000);
      this.ws.addEventListener('open', () => {
        clearTimeout(to);
        res();
      });
      this.ws.addEventListener('error', (e) => {
        clearTimeout(to);
        rej(new Error('ws error ' + (e.message || '')));
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
          reject(new Error('timeout ' + method));
        }
      }, 20000);
    });
  }
  eval(expr) {
    return this.send('Runtime.evaluate', { expression: expr, returnByValue: true }).then(
      (r) => r.result?.value,
    );
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
const note = (step, data) => {
  log.push({ step, ...data });
  fs.writeFileSync(OUT, JSON.stringify(log, null, 1), 'utf8');
};

const port = await freePort();
const profile = `C:/Users/Lenovo/AppData/Local/Temp/lc-collapse-${Date.now()}`;
const chrome = spawn(
  CHROME,
  [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--headless=new',
    '--no-first-run',
    '--no-default-browser-check',
    '--window-size=1440,900',
    'about:blank',
  ],
  { stdio: 'ignore' },
);

// 量一次布局：三栏宽度 + 把手位置，判断有没有互相遮挡
const MEASURE = `JSON.stringify({
  mainCols: getComputedStyle(document.getElementById('mainArea')).gridTemplateColumns,
  mainW: document.getElementById('mainArea').clientWidth,
  listVisible: document.getElementById('listPanel').offsetWidth > 0,
  descVisible: document.getElementById('descPanel').offsetWidth > 0,
  codeW: document.querySelector('.code-panel').offsetWidth,
  reopenList: (() => { const n=document.getElementById('reopenList'); return n?{hidden:n.hidden,w:n.offsetWidth,left:n.getBoundingClientRect().left,text:n.textContent}:null; })(),
  reopenDesc: (() => { const n=document.getElementById('reopenDesc'); return n?{hidden:n.hidden,w:n.offsetWidth,left:n.getBoundingClientRect().left,text:n.textContent}:null; })(),
  listClass: document.getElementById('mainArea').className,
  codeLeft: document.querySelector('.code-panel').getBoundingClientRect().left
})`;

try {
  await waitDevtools(port);
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = targets.find((t) => t.type === 'page');
  const cdp = new Cdp(page.webSocketDebuggerUrl);
  await cdp.connect();
  await cdp.send('Page.enable');
  await cdp.send('Page.navigate', { url: URL });
  await sleep(2000);
  await cdp.eval(`localStorage.clear()`);
  await cdp.send('Page.navigate', { url: URL });
  await sleep(2000);
  await cdp.eval(`document.getElementById('planSel').value='top-interview-150';document.getElementById('planSel').dispatchEvent(new Event('change'))`);
  await sleep(1200);

  note('初始', { layout: JSON.parse(await cdp.eval(MEASURE)) });

  // 收起左栏
  await cdp.eval(`document.getElementById('collapseList').click()`);
  await sleep(600);
  note('收起左栏', { layout: JSON.parse(await cdp.eval(MEASURE)) });

  // 再收起题面
  await cdp.eval(`document.getElementById('collapseDesc').click()`);
  await sleep(600);
  note('左右都收起', { layout: JSON.parse(await cdp.eval(MEASURE)) });

  // 恢复左栏
  await cdp.eval(`document.getElementById('reopenList').click()`);
  await sleep(600);
  note('仅题面收起', { layout: JSON.parse(await cdp.eval(MEASURE)) });

  // 恢复题面
  await cdp.eval(`document.getElementById('reopenDesc').click()`);
  await sleep(600);
  note('全部恢复', { layout: JSON.parse(await cdp.eval(MEASURE)) });

  // 打开一道题，验证题面折叠按钮
  await cdp.eval(`document.querySelector('.prob').click()`);
  await sleep(2200);
  note('题目打开', {
    data: JSON.parse(
      await cdp.eval(
        `JSON.stringify({clamp:document.getElementById('problemDesc').className, btnHidden:document.getElementById('descToggle').hidden, btn:document.getElementById('descToggle').textContent})`,
      ),
    ),
  });
  const shot1 = await cdp.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync('test/_collapse-clamped2.png', Buffer.from(shot1.data, 'base64'));

  // 展开题面
  await cdp.eval(`document.getElementById('descToggle').click()`);
  await sleep(500);
  note('题面展开', {
    data: JSON.parse(
      await cdp.eval(
        `JSON.stringify({clamp:document.getElementById('problemDesc').className, btn:document.getElementById('descToggle').textContent})`,
      ),
    ),
  });
  const shot2 = await cdp.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync('test/_collapse-expanded2.png', Buffer.from(shot2.data, 'base64'));

  // 打开计划弹窗，检查分组折叠
  await cdp.eval(`document.getElementById('plansBtn').click()`);
  await sleep(11000);
  note('计划弹窗', {
    data: JSON.parse(
      await cdp.eval(
        `JSON.stringify({
          heads: [...document.querySelectorAll('.group-toggle')].map(n=>n.innerText.replace(/\\s+/g,' ')),
          cards: document.querySelectorAll('#allPlansList .plan-card').length,
          visible: [...document.querySelectorAll('#allPlansList .plan-card')].filter(n=>!n.hidden).length
        })`,
      ),
    ),
  });
  // 收起第一个分组
  await cdp.eval(`document.querySelector('.group-toggle')?.click()`);
  await sleep(600);
  note('收起第一组', {
    data: JSON.parse(
      await cdp.eval(
        `JSON.stringify({
          visible: [...document.querySelectorAll('#allPlansList .plan-card')].filter(n=>!n.hidden).length,
          total: document.querySelectorAll('#allPlansList .plan-card').length,
          firstCaret: document.querySelector('.group-toggle')?.innerText
        })`,
      ),
    ),
  });
  const shot3 = await cdp.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync('test/_collapse-plans2.png', Buffer.from(shot3.data, 'base64'));

  cdp.close();
} catch (e) {
  note('ERROR', { message: e.message, stack: (e.stack || '').slice(0, 500) });
} finally {
  try {
    chrome.kill();
  } catch {
    /* ignore */
  }
  console.log('COLLAPSE_DONE');
  process.exit(0);
}

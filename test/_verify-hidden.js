/*
 * 检查计划弹窗折叠后，被 hidden 的卡片是否真的不占位（高度应为 0）。
 * 只看 DOM 属性的测试不够 —— 必须量 offsetHeight。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const URL = 'http://127.0.0.1:7788/';
const OUT = 'test/_verify-hidden.json';
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
async function waitDevtools(port, t = 25000) {
  const d = Date.now() + t;
  while (Date.now() < d) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (r.ok) return;
    } catch {
      /* wait */
    }
    await sleep(300);
  }
  throw new Error('devtools timeout');
}

class Cdp {
  constructor(u) {
    this.u = u;
    this.id = 0;
    this.pending = new Map();
  }
  async connect() {
    this.ws = new WebSocket(this.u);
    await new Promise((res, rej) => {
      const to = setTimeout(() => rej(new Error('t/o')), 10000);
      this.ws.addEventListener('open', () => {
        clearTimeout(to);
        res();
      });
      this.ws.addEventListener('error', (e) => {
        clearTimeout(to);
        rej(new Error('ws ' + (e.message || '')));
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
  send(m, p = {}) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.pending.set(id, { resolve: res, reject: rej });
      this.ws.send(JSON.stringify({ id, method: m, params: p }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          rej(new Error('timeout ' + m));
        }
      }, 20000);
    });
  }
  async eval(e) {
    const r = await this.send('Runtime.evaluate', { expression: e, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
    return r.result?.value;
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
const note = (s, d) => {
  log.push({ step: s, ...d });
  fs.writeFileSync(OUT, JSON.stringify(log, null, 1), 'utf8');
};

const port = await freePort();
const profile = `C:/Users/Lenovo/AppData/Local/Temp/lc-hid-${Date.now()}`;
const chrome = spawn(
  CHROME,
  [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--headless=new',
    '--no-first-run',
    '--no-default-browser-check',
    '--window-size=1440,1200',
    'about:blank',
  ],
  { stdio: 'ignore' },
);

try {
  await waitDevtools(port);
  const tl = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = tl.find((t) => t.type === 'page');
  const cdp = new Cdp(page.webSocketDebuggerUrl);
  await cdp.connect();
  await cdp.send('Page.enable');
  await cdp.send('Page.navigate', { url: URL });
  await sleep(2000);
  await cdp.eval(`localStorage.clear(); document.getElementById('plansBtn').click()`);
  await sleep(12000);

  const MEASURE = `(() => {
    const grid = document.getElementById('allPlansList');
    const cards = [...grid.querySelectorAll('.plan-card')];
    const hidden = cards.filter(c => c.hidden);
    const shown = cards.filter(c => !c.hidden);
    return {
      total: cards.length,
      hiddenCount: hidden.length,
      hiddenHeights: hidden.slice(0,3).map(c => c.offsetHeight),
      hiddenDisplay: hidden.slice(0,3).map(c => getComputedStyle(c).display),
      shownHeights: [...new Set(shown.slice(0,4).map(c => c.offsetHeight))],
      gridH: grid.offsetHeight,
      // 第一组标题到第二组标题之间的垂直距离 —— 折叠后应该很小
      gapBetweenHeads: (() => {
        const heads = [...document.querySelectorAll('.group-toggle')];
        if (heads.length < 2) return null;
        return Math.round(heads[1].getBoundingClientRect().top - heads[0].getBoundingClientRect().bottom);
      })()
    };
  })()`;

  note('展开态', { data: JSON.parse(await cdp.eval('JSON.stringify(' + MEASURE + ')')) });

  await cdp.eval(`document.querySelector('.group-toggle').click()`);
  await sleep(800);
  note('第一组折叠后', { data: JSON.parse(await cdp.eval('JSON.stringify(' + MEASURE + ')')) });

  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync('test/_hidden-check2.png', Buffer.from(shot.data, 'base64'));

  cdp.close();
} catch (e) {
  note('ERROR', { message: e.message });
} finally {
  try {
    chrome.kill();
  } catch {
    /* ignore */
  }
  console.log('HIDDEN_DONE');
  process.exit(0);
}

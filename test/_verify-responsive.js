/*
 * 多视口布局验收 —— 折叠高度是否自适应、按钮是否始终在屏内。
 *
 * 为什么单独一个脚本：题干折叠上限是 min(62vh, 460px)（窄屏 42vh/340px），
 * 这类跟视口走的样式在固定 1280x820 的截图里看不出问题。
 * 曾经的 bug 就是窄屏 1fr 1fr 把题面压到 130px，示例和按钮全被挤出可视区。
 *
 * 用法：node test/_verify-responsive.js
 */
import { spawn } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const BASE = process.env.LC_BASE || 'http://127.0.0.1:7788';
const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].find((p) => fs.existsSync(p));
if (!CHROME) { console.log('NO_CHROME'); process.exit(0); }

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.waiting = new Map();
    ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data);
      if (m.id && this.waiting.has(m.id)) {
        const { res, rej } = this.waiting.get(m.id);
        this.waiting.delete(m.id);
        m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.waiting.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval failed');
    return r.result.value;
  }
}

const freePort = () =>
  new Promise((r) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 量一屏的布局：题面高度 / 按钮位置 / 三栏矩形。表达式独立成函数，避免 shell 转义。 */
const MEASURE = `JSON.stringify((() => {
  const box = (sel) => {
    const el = document.querySelector(sel);
    if (!el) return { missing: sel };
    const r = el.getBoundingClientRect();
    return { top: Math.round(r.top), bottom: Math.round(r.bottom), h: Math.round(r.height), w: Math.round(r.width), x: Math.round(r.left) };
  };
  const d = document.getElementById('problemDesc');
  const b = document.getElementById('descToggle');
  const br = b.getBoundingClientRect();
  return {
    vh: window.innerHeight,
    vw: window.innerWidth,
    descCls: d.className,
    descH: Math.round(d.getBoundingClientRect().height),
    descScrollH: d.scrollHeight,
    btnHidden: b.hidden,
    btnText: b.textContent,
    btnTop: Math.round(br.top),
    btnBottom: Math.round(br.bottom),
    btnInView: br.top >= 0 && br.bottom <= window.innerHeight,
    list: box('#listPanel'),
    desc: box('#descPanel'),
    code: box('#codePanel'),
  };
})())`;

(async () => {
  const cdpPort = await freePort();
  const prof = path.join(os.tmpdir(), 'lc-responsive-' + Date.now());
  const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--user-data-dir=' + prof, '--remote-debugging-port=' + cdpPort, 'about:blank'], { stdio: 'ignore' });

  let target = null;
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${cdpPort}/json/list`);
      target = (await r.json()).find((t) => t.type === 'page');
      if (target) break;
    } catch {}
    await sleep(250);
  }
  if (!target) { console.log('NO_TARGET'); chrome.kill(); process.exit(1); }

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.addEventListener('open', r); ws.addEventListener('error', j); });
  const cdp = new Cdp(ws);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');

  const VIEWPORTS = [
    [1600, 1000, 'xl'],
    [1280, 820, 'lg'],
    [1024, 700, 'md'],
    [900, 640, 'sm'],
  ];

  const out = [];
  for (const [w, h, tag] of VIEWPORTS) {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
    await cdp.send('Page.navigate', { url: BASE + '/' });
    await sleep(3000);

    // 选计划 → 开一道长题（两数之和有 3 个示例块，够长）
    await cdp.eval(`(() => { const s = document.getElementById('planSel'); if (s) { s.value = 'top-interview-150'; s.onchange && s.onchange(); } return !!s; })()`);
    await sleep(1800);
    await cdp.eval(`(() => { const el = document.querySelector('.prob'); if (el) el.click(); return !!el; })()`);
    await sleep(2200);

    const info = JSON.parse(await cdp.eval(MEASURE));
    out.push({ tag, w, h, ...info });
    console.log(
      `${tag} ${w}x${h}  descH=${info.descH}(content ${info.descScrollH})  ` +
      `btn=${info.btnHidden ? 'hidden' : `${info.btnText}@${info.btnTop}`} inView=${info.btnInView}  ` +
      `list.h=${info.list.h ?? '-'} desc.h=${info.desc.h ?? '-'} code.h=${info.code.h ?? '-'}`,
    );

    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(`test/_shot-${tag}.png`, Buffer.from(shot.data, 'base64'));
  }

  fs.writeFileSync('test/_verify-responsive.json', JSON.stringify(out, null, 1));
  console.log('RESPONSIVE_DONE');

  ws.close();
  chrome.kill();
  try { fs.rmSync(prof, { recursive: true, force: true }); } catch {}
  process.exit(0);
})();

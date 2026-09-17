/*
 * 浏览器快照工具。
 *
 * 本环境两个坑叠在一起：
 *  1. bash 缺 dirname/sed/uname，agent-browser 的 shell wrapper 起不来 → 直接 spawn JS 入口
 *  2. PowerShell 直接跑长命令会被杀掉 → 用 run_in_background 跑本脚本，结果落盘后读文件
 *
 * 用法：node test/_probe-ui.js <session> <url> <输出png>
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const NODE = 'C:/Users/Lenovo/.workbuddy/binaries/node/versions/22.22.2-3/node.exe';
const CLI = 'D:/nodejs/GlobalNodeModules/node_modules/agent-browser/bin/agent-browser.js';

const SESSION = process.argv[2] || 'probe';
const URL = process.argv[3] || 'http://127.0.0.1:7788/';
const SHOT = process.argv[4] || 'test/_probe.png';
const OUT = 'test/_probe.out.txt';

function run(argv, timeoutMs = 90000) {
  return new Promise((resolve) => {
    const p = spawn(NODE, [CLI, ...argv], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const t = setTimeout(() => {
      try {
        p.kill();
      } catch {
        /* 已经退出了 */
      }
    }, timeoutMs);
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('close', (code) => {
      clearTimeout(t);
      resolve({ code, out: out.trim(), err: err.trim() });
    });
  });
}

// 在页面里要采集的东西：布局色值 + 关键 DOM 状态
const PROBE = `JSON.stringify({
  theme: document.documentElement.dataset.theme,
  title: document.title,
  stats: (document.getElementById('stats')||{}).textContent,
  pool: (document.getElementById('poolCount')||{}).textContent,
  rows: document.querySelectorAll('.prob').length,
  groups: [...document.querySelectorAll('.group-head')].map(n=>n.innerText.replace(/\\s+/g,' ')),
  firstRow: (document.querySelector('.prob')||{}).innerText,
  scope: (document.getElementById('scopeBar')||{}).hidden === false
    ? document.getElementById('scopeLabel').textContent : null,
  descToggleHidden: (document.getElementById('descToggle')||{}).hidden,
  colors: {
    body: getComputedStyle(document.body).backgroundColor,
    topbar: getComputedStyle(document.querySelector('.topbar')).backgroundColor,
    actionbar: getComputedStyle(document.querySelector('.actionbar')).backgroundColor,
    panel: getComputedStyle(document.querySelector('.panel')).backgroundColor,
    panelHead: getComputedStyle(document.querySelector('.panel-head')).backgroundColor,
    panelShadow: getComputedStyle(document.querySelector('.panel')).boxShadow,
    mainBg: getComputedStyle(document.getElementById('mainArea')).rowGap,
    bodyVsPanelDiff: 'see values'
  }
})`;

const log = [];

// 1. 打开页面
log.push({ step: 'open', ...(await run(['--session', SESSION, 'open', URL])) });
// 2. 采集状态
const b64 = Buffer.from(PROBE, 'utf8').toString('base64');
log.push({ step: 'probe', ...(await run(['--session', SESSION, 'eval', '-b', b64])) });
// 3. 截图
log.push({
  step: 'screenshot',
  ...(await run(['--session', SESSION, 'screenshot', SHOT])),
});

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(log, null, 1), 'utf8');
console.log('PROBE_DONE');

/**
 * 浏览器探测 + 登录态捕获。
 *
 * 设计目标：让"绑定力扣账号"这件事不需要用户碰 Cookie 字符串。
 *
 * 做法：
 *   1. 找一个能用的 Chromium 系浏览器（优先用户已装的 Chrome / Edge，
 *      都没有再用应用自带的）
 *   2. 用 --remote-debugging-port 起一个独立 profile 的实例，打开力扣登录页
 *   3. 用户在弹出的窗口里正常登录（扫码 / 账号密码都行）
 *   4. 我们轮询 CDP 的 Network.getCookies，一旦拿到 LEETCODE_SESSION 就收工
 *   5. 用完把这个临时浏览器实例关掉
 *
 * 为什么必须用独立 profile（--user-data-dir 指到临时目录）：
 *   直接复用用户日常 profile 会撞上"Chrome 已经在运行"的问题 ——
 *   已运行的实例不会接受新的 --remote-debugging-port，CDP 连不上去。
 *   独立 profile 虽然要重新登录一次，但行为可预期，也不会碰到用户的浏览数据。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

/** 常见的 Chromium 系浏览器安装位置（Windows / macOS / Linux） */
const CANDIDATES = {
  win32: [
    ['Chrome', 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'],
    ['Chrome', 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'],
    ['Chrome', path.join(os.homedir(), 'AppData\\Local\\Google\\Chrome\\Application\\chrome.exe')],
    ['Edge', 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'],
    ['Edge', 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'],
    ['Brave', 'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe'],
  ],
  darwin: [
    ['Chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'],
    ['Edge', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'],
    ['Brave', '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser'],
    ['Chromium', '/Applications/Chromium.app/Contents/MacOS/Chromium'],
  ],
  linux: [
    ['Chrome', '/usr/bin/google-chrome'],
    ['Chrome', '/usr/bin/google-chrome-stable'],
    ['Chromium', '/usr/bin/chromium'],
    ['Chromium', '/usr/bin/chromium-browser'],
    ['Edge', '/usr/bin/microsoft-edge'],
  ],
};

/**
 * 找一个可用的浏览器。
 * @returns {{ name: string, path: string, source: string } | null}
 */
export function findBrowser() {
  const list = CANDIDATES[process.platform] || [];

  // 1) 用户自己装的
  for (const [name, p] of list) {
    try {
      if (fs.existsSync(p)) return { name, path: p, source: 'installed' };
    } catch {
      /* 权限问题就跳过 */
    }
  }

  // 2) 应用自带的（agent-browser 装的那份），只在系统里找不到时兜底
  const local = process.env.LC_CHROMIUM_PATH;
  if (local && fs.existsSync(local)) return { name: 'Chromium', path: local, source: 'bundled' };

  const bundledDirs = [
    path.join(os.homedir(), '.agent-browser', 'browsers'),
    path.join(os.homedir(), '.cache', 'ms-playwright'),
  ];
  for (const dir of bundledDirs) {
    try {
      if (!fs.existsSync(dir)) continue;
      for (const sub of fs.readdirSync(dir)) {
        for (const rel of [
          'chrome-win64/chrome.exe',
          'chrome-win/chrome.exe',
          'chrome-linux64/chrome',
          'chrome-mac/Chromium.app/Contents/MacOS/Chromium',
          'chrome-mac-arm64/Chromium.app/Contents/MacOS/Chromium',
          'chrome-win/chrome.exe',
        ]) {
          const p = path.join(dir, sub, rel);
          if (fs.existsSync(p)) return { name: 'Chromium', path: p, source: 'bundled' };
        }
      }
    } catch {
      /* 忽略 */
    }
  }

  return null;
}

/** 启动浏览器时的诊断信息，给界面显示用 */
export function browserReport() {
  const b = findBrowser();
  if (b) {
    return { ok: true, name: b.name, path: b.path, source: b.source };
  }
  return {
    ok: false,
    hint:
      '没找到 Chrome / Edge / Chromium。装一个任意的即可，' +
      '或者在本机 .lc/config.json 里加一行 "browserPath": "你的浏览器路径"。',
  };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** 用 CDP 的 HTTP 端点问一下调试端口起了没 */
async function waitForDevtools(port, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (r.ok) return await r.json();
    } catch {
      /* 还没起来 */
    }
    await sleep(300);
  }
  throw new Error(`浏览器调试端口 ${port} 在 ${timeoutMs}ms 内没就绪`);
}

/** 挑一个端口，从 9222 往后找一个没被占的 */
async function pickPort(start = 9222) {
  for (let p = start; p < start + 60; p++) {
    try {
      const r = await fetch(`http://127.0.0.1:${p}/json/version`, { signal: AbortSignal.timeout(200) });
      if (r.ok) continue; // 被占了
    } catch {
      return p; // 连不上 = 空闲
    }
  }
  throw new Error('找不到空闲的调试端口');
}

/**
 * 极简 CDP 客户端。
 * 只用到 Network.getCookies 和 Page.navigate，不值得引一个 websocket 库 ——
 * Node 22 自带 WebSocket，直接手写就够了。
 */
class Cdp {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.ws = null;
    this.id = 0;
    this.pending = new Map();
  }

  async connect() {
    // Node 22 的全局 WebSocket
    this.ws = new WebSocket(this.wsUrl);
    await new Promise((resolve, reject) => {
      const to = setTimeout(() => reject(new Error('连接 CDP 超时')), 8000);
      this.ws.addEventListener('open', () => {
        clearTimeout(to);
        resolve();
      });
      this.ws.addEventListener('error', (e) => {
        clearTimeout(to);
        reject(new Error('连接 CDP 失败：' + (e.message || 'unknown')));
      });
    });
    this.ws.addEventListener('message', (ev) => {
      let msg;
      try {
        msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data));
      } catch {
        return;
      }
      if (msg.id != null && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message || 'CDP 错误'));
        else resolve(msg.result);
      }
    });
    return this;
  }

  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP ${method} 超时`));
        }
      }, 20000);
    });
  }

  close() {
    try {
      this.ws?.close();
    } catch {
      /* 忽略 */
    }
  }
}

/**
 * 打开浏览器让用户登录，并捕获 Cookie。
 *
 * @param {object} opts
 * @param {string} opts.site   https://leetcode.cn
 * @param {number} [opts.timeoutMs] 用户最长的登录等待时间
 * @param {(msg:string)=>void} [opts.onStatus] 进度回调，界面可以实时显示
 * @returns {Promise<{LEETCODE_SESSION:string, csrftoken:string}>}
 */
export async function loginAndCapture({ site = 'https://leetcode.cn', timeoutMs = 300000, onStatus } = {}) {
  const status = onStatus || (() => {});
  const browser = findBrowser();
  if (!browser) {
    throw new Error(browserReport().hint);
  }
  status(`使用 ${browser.name}（${browser.source === 'installed' ? '系统已安装' : '应用自带'}）`);

  const port = await pickPort(9222);
  // 独立 profile：避免和用户正在用的浏览器实例冲突，也避免动到用户的浏览数据
  const profileDir = path.join(os.tmpdir(), `lc-hunter-login-${Date.now()}`);
  fs.mkdirSync(profileDir, { recursive: true });

  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    // 把"Chrome 正受到自动测试软件控制"的提示关掉，减少困惑
    '--disable-blink-features=AutomationControlled',
    '--no-first-run',
    '--no-default-browser-check',
    '--window-size=520,760',
    `${site}/accounts/login/`,
  ];

  status('正在打开登录窗口…');
  const child = spawn(browser.path, args, {
    detached: false,
    stdio: 'ignore',
  });

  let cdp = null;
  let closed = false;
  const cleanup = () => {
    if (closed) return;
    closed = true;
    cdp?.close();
    try {
      child.kill();
    } catch {
      /* 忽略 */
    }
    // 等一小会儿再删 profile，否则文件可能还被占着
    setTimeout(() => {
      try {
        fs.rmSync(profileDir, { recursive: true, force: true });
      } catch {
        /* 删不掉就算了，在临时目录里 */
      }
    }, 3000);
  };

  try {
    const info = await waitForDevtools(port);
    status('登录窗口已打开，请在窗口里完成登录');

    // 找到那个标签页
    const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json());
    const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
    if (!page) throw new Error('没找到浏览器标签页');

    cdp = await new Cdp(page.webSocketDebuggerUrl).connect();
    await cdp.send('Network.enable').catch(() => {});
    await cdp.send('Page.enable').catch(() => {});

    // 顺序很重要：先按域名取 Cookie（能顺带拿到 HttpOnly 的
    // LEETCODE_SESSION），不行再退回全量列表里筛。
    const wanted = ['leetcode.cn', 'leetcode.com'];
    const deadline = Date.now() + timeoutMs;
    let lastStatus = 0;

    while (Date.now() < deadline) {
      if (child.exitCode !== null) {
        // 用户把窗口关了
        throw new Error('登录窗口被关闭了，绑定未完成');
      }

      let jar = [];
      try {
        const r = await cdp.send('Network.getCookies', { urls: wanted.map((d) => `https://${d}/`) });
        jar = r?.cookies ?? [];
      } catch {
        /* 标签页可能在导航，忽略这一次 */
      }

      const session = jar.find((c) => c.name === 'LEETCODE_SESSION')?.value;
      const csrf = jar.find((c) => c.name === 'csrftoken')?.value;

      if (session) {
        status('已捕获登录态，正在验证…');
        cleanup();
        return { LEETCODE_SESSION: session, csrftoken: csrf || '' };
      }

      if (Date.now() - lastStatus > 5000) {
        lastStatus = Date.now();
        const left = Math.max(0, Math.round((deadline - Date.now()) / 1000));
        status(`等待登录中…（剩余 ${left} 秒，窗口里登录成功后会自动完成）`);
      }
      await sleep(900);
    }
    throw new Error('等待登录超时。可以重试。');
  } catch (e) {
    cleanup();
    throw e;
  }
}

/**
 * Electron 主进程 —— 把现有的本地 Web 服务套进一个桌面窗口。
 *
 * 为什么不重写成 IPC 架构：本项目的内核本来就是「Node HTTP 服务 + 浏览器 UI」，
 * 界面和后端之间已经是 HTTP 了。套 Electron 只要让主进程把服务起起来、
 * 再让窗口去访问它，src/ 和 web/ 一行都不用改。改成 IPC 反而是重写。
 *
 * 代价是窗口里跑的是 127.0.0.1 的回环请求（和现在用浏览器打开完全一样），
 * 好处是桌面化之后所有本机能力都还在：SQLite、javac/java、弹浏览器登录（CDP）。
 * 这几样一旦挪到云端就全没了 —— 这正是选择桌面端而不是 Vercel 的原因。
 */
import { app, BrowserWindow, shell, dialog } from 'electron';

/*
 * 单实例锁：双击第二次应该聚焦到已经开着的窗口，
 * 而不是再起一个进程（两个进程抢同一个 SQLite 文件会出问题）。
 */
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}

let win = null;
let server = null;

async function boot() {
  /*
   * 关键：必须在 import 任何业务模块之前把 LC_HOME 设好。
   *
   * src/config.js 在模块初始化时就把 PROJECT_ROOT / DATA_DIR 算死了，
   * 晚一步设就会拿到 asar 内部的只读路径。所以这里用动态 import，
   * 不能写成顶层的静态 import（ESM 的静态 import 会先于本行执行）。
   */
  process.env.LC_HOME = app.getPath('userData');

  const { startServer } = await import('../src/server.js');

  const started = await startServer({ port: 0, host: '127.0.0.1' });
  server = started.server;

  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: 'lc-hunter',
    backgroundColor: '#0f1115',
    show: false,
    webPreferences: {
      // 只访问本机回环，不给 node 集成，保持最小权限
      nodeIntegration: false,
      contextIsolation: true,
      // 允许页面用 localStorage 存折叠状态等偏好（UI 依赖它）
      // Electron 默认就允许，这里显式写出来是为了说明为什么不能禁
    },
  });

  // 页面里的外链（题面里的力扣链接、"查看原题"）交给系统浏览器，
  // 不要在这个窗口里跳走 —— 跳走就回不来了，用户会以为应用崩了。
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://127.0.0.1')) return { action: 'allow' };
    shell.openExternal(url);
    return { action: 'deny' };
  });

  // 同理，主动导航到外部域名时也放行到系统浏览器
  win.webContents.on('will-navigate', (e, url) => {
    if (url.startsWith('http://127.0.0.1')) return;
    e.preventDefault();
    shell.openExternal(url);
  });

  win.once('ready-to-show', () => win.show());
  win.on('closed', () => {
    win = null;
  });

  await win.loadURL(started.url);
}

app.on('second-instance', () => {
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
});

app.on('window-all-closed', () => {
  // Windows / Linux 上关窗即退出；macOS 习惯是保留应用，这里随平台
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  // 不关服务的话，端口会挂着，下次启动抢不到（虽然用的是随机端口，但进程会残留）
  if (server) {
    server.close();
    server = null;
  }
});

app.on('activate', () => {
  // macOS 点 Dock 图标重新开一个窗口
  if (BrowserWindow.getAllWindows().length === 0 && server) {
    boot().catch((e) => dialog.showErrorBox('启动失败', e.message));
  }
});

app
  .whenReady()
  .then(boot)
  .catch((e) => {
    dialog.showErrorBox('lc-hunter 启动失败', String(e?.stack || e?.message || e));
    app.quit();
  });

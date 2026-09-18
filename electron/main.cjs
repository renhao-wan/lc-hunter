/**
 * Electron 主进程 —— 把现有的本地 Web 服务套进一个桌面窗口。
 *
 * 为什么是 .cjs 而不是 .js：项目 package.json 是 "type": "module"，
 * 但 **Electron 的内置模块在 ESM 里拿不到命名导出** ——
 * `import { app } from 'electron'` 会报
 * "does not provide an export named 'BrowserWindow'"，因为 ESM 侧的
 * require('electron') 解析到的是 node_modules 里那个「导出 exe 路径字符串」的包，
 * 而不是运行时对象。CommonJS 下 require 才是注入好的运行时。
 * 所以这个入口刻意用 .cjs；业务模块仍是 ESM，靠动态 import() 加载。
 *
 * 为什么不做 IPC 架构：内核本来就是「Node HTTP 服务 + 浏览器 UI」，
 * 前后端之间已经是 HTTP。套壳只要起服务 + 开窗口加载它，
 * src/ 和 web/ 一行都不用改 —— 改成 IPC 反而等于重写一遍。
 *
 * 桌面模式与浏览器模式的差别都集中在本文件：
 *   · 去掉菜单栏（Windows/Linux 上的 File/View/Help 对刷题用户毫无意义）
 *   · 关掉开发者工具（面向普通用户，F12 打开的是一堆报错而不是功能）
 *   · 窗口图标 / 固定标题 / 外链交给系统浏览器
 */
const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow, Menu, shell, dialog } = require('electron');

/** 窗口与任务栏图标。打包后要从 asar 里读，所以路径得是包内路径 */
const ICON = path.join(__dirname, '..', 'assets', 'icon.png');

/*
 * 单实例锁：双击第二次应该聚焦到已开的窗口，而不是再起一个进程。
 * 两个进程同时读写同一个 SQLite 文件会出问题。
 */
if (!app.requestSingleInstanceLock()) {
  app.quit();
}

let win = null;
let server = null;
let serverUrl = null;

/**
 * 开发模式下把关键步骤打到控制台。
 * 打包后（app.isPackaged）没有控制台可看，就不打了 —— 免得在用户机器上产生噪音。
 */
function trace(msg) {
  if (!app.isPackaged) console.log(`[lc-hunter] ${msg}`);
}

/**
 * 菜单栏。
 *
 * Windows / Linux 直接整条拿掉：默认模板里 Windows 上能点的只有
 * 「重新加载」「切换开发者工具」「放大缩小」，全是开发期的东西，
 * 摆在用户面前只会被点出事。
 *
 * macOS 不能全拿掉 —— 系统把「复制/粘贴/全选」的快捷键也挂在应用菜单上，
 * 菜单为空会让 Ctrl(⌘)+C 一起失效。所以 mac 上只留应用菜单和编辑菜单。
 */
function installMenu() {
  if (process.platform === 'darwin') {
    Menu.setApplicationMenu(
      Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }]),
    );
  } else {
    Menu.setApplicationMenu(null);
  }
  trace(`菜单栏 ${Menu.getApplicationMenu() ? '保留最小集（macOS）' : '已移除'}`);
}

/** 服务只起一次。macOS 上关窗不退应用，再点图标时应复用已起的服务 */
async function ensureServer() {
  if (serverUrl) return serverUrl;
  /*
   * 关键顺序：必须在 import 任何业务模块之前设好 LC_HOME。
   * src/config.js 在模块初始化时就把 PROJECT_ROOT / DATA_DIR 算死了，
   * 晚一步就会拿到只读的 app.asar 内部路径。
   * 这里用动态 import() 就是为了卡住这个顺序（CJS 里也没有静态 import）。
   */
  process.env.LC_HOME = app.getPath('userData');
  process.env.LC_DESKTOP = '1';
  trace(`数据目录 ${process.env.LC_HOME}`);

  const { startServer } = await import('../src/server.js');
  const started = await startServer({ port: 0, host: '127.0.0.1' });
  server = started.server;
  serverUrl = started.url;
  trace(`服务已起 ${serverUrl}`);
  return serverUrl;
}

async function createWindow(url) {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: 'lc-hunter',
    icon: ICON,
    backgroundColor: '#161616',
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      // 打包给用户之后，开发者工具没有任何存在理由
      devTools: !app.isPackaged,
    },
  });

  trace(`窗口图标 ${fs.existsSync(ICON) ? ICON : '缺失（' + ICON + '）'}`);

  // 页面里的 <title> 不许改窗口标题，不然窗口上会挂着「· 力扣刷题辅助」这种尾巴
  win.on('page-title-updated', (e) => e.preventDefault());

  /*
   * 外链交给系统浏览器（题面里的力扣链接、"查看原题"）。
   * 在这个窗口里跳走的话用户就回不来了，看起来像应用崩了。
   */
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    if (target.startsWith('http://127.0.0.1')) return { action: 'allow' };
    shell.openExternal(target);
    return { action: 'deny' };
  });

  win.webContents.on('will-navigate', (e, target) => {
    if (target.startsWith('http://127.0.0.1')) return;
    e.preventDefault();
    shell.openExternal(target);
  });

  /*
   * 快捷键兜底。
   *
   * devTools:false 已经让开发者工具打不开了，但 Windows 上 F12 / Ctrl+Shift+I
   * 仍会走一遍「尝试打开」的流程；Ctrl+R 则会重新加载页面，
   * 把当前抽到一半的题和未保存的代码冲掉 —— 桌面应用里没有"刷新"这个概念。
   */
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown') return;
    const key = (input.key || '').toLowerCase();
    const devtools =
      key === 'f12' || (input.control && input.shift && ['i', 'j', 'c'].includes(key));
    const reload = input.control && key === 'r';
    if (devtools || reload) e.preventDefault();
  });

  win.once('ready-to-show', () => {
    trace('窗口已就绪');
    win.show();
  });
  win.on('closed', () => {
    win = null;
  });

  await win.loadURL(url);
  trace('页面已加载');
  return win;
}

async function boot() {
  installMenu();
  const url = await ensureServer();
  await createWindow(url);
}

app.on('second-instance', () => {
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
});

app.on('window-all-closed', () => {
  // Windows / Linux 关窗即退出；macOS 习惯保留应用
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  // 不关的话端口会挂着，进程也可能残留
  if (server) {
    server.close();
    server = null;
    serverUrl = null;
  }
});

/** macOS：点 Dock 图标重新开窗（服务是现成的，直接复用） */
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    (serverUrl ? createWindow(serverUrl) : boot()).catch((e) =>
      dialog.showErrorBox('lc-hunter 启动失败', String(e && e.message)),
    );
  }
});

app
  .whenReady()
  .then(boot)
  .catch((e) => {
    dialog.showErrorBox('lc-hunter 启动失败', String((e && e.stack) || (e && e.message) || e));
    app.quit();
  });

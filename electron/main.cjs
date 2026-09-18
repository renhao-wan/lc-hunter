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
 */
const { app, BrowserWindow, shell, dialog } = require('electron');

/*
 * 单实例锁：双击第二次应该聚焦到已开的窗口，而不是再起一个进程。
 * 两个进程同时读写同一个 SQLite 文件会出问题。
 */
if (!app.requestSingleInstanceLock()) {
  app.quit();
}

let win = null;
let server = null;

/**
 * 开发模式下把关键步骤打到控制台。
 * 打包后（app.isPackaged）没有控制台可看，就不打了 —— 免得在用户机器上产生噪音。
 */
function trace(msg) {
  if (!app.isPackaged) console.log(`[lc-hunter] ${msg}`);
}

async function boot() {
  /*
   * 关键顺序：必须在 import 任何业务模块之前设好 LC_HOME。
   * src/config.js 在模块初始化时就把 PROJECT_ROOT / DATA_DIR 算死了，
   * 晚一步就会拿到只读的 app.asar 内部路径。
   * 这里用动态 import() 就是为了卡住这个顺序（CJS 里也没有静态 import）。
   */
  process.env.LC_HOME = app.getPath('userData');
  trace(`数据目录 ${process.env.LC_HOME}`);

  const { startServer } = await import('../src/server.js');
  const started = await startServer({ port: 0, host: '127.0.0.1' });
  server = started.server;
  trace(`服务已起 ${started.url}`);

  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: 'lc-hunter',
    backgroundColor: '#0f1115',
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  /*
   * 外链交给系统浏览器（题面里的力扣链接、"查看原题"）。
   * 在这个窗口里跳走的话用户就回不来了，看起来像应用崩了。
   */
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://127.0.0.1')) return { action: 'allow' };
    shell.openExternal(url);
    return { action: 'deny' };
  });

  win.webContents.on('will-navigate', (e, url) => {
    if (url.startsWith('http://127.0.0.1')) return;
    e.preventDefault();
    shell.openExternal(url);
  });

  win.once('ready-to-show', () => {
    trace('窗口已就绪');
    win.show();
  });
  win.on('closed', () => {
    win = null;
  });

  await win.loadURL(started.url);
  trace('页面已加载');
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
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0 && server) {
    boot().catch((e) => dialog.showErrorBox('启动失败', e.message));
  }
});

app
  .whenReady()
  .then(boot)
  .catch((e) => {
    dialog.showErrorBox('lc-hunter 启动失败', String((e && e.stack) || (e && e.message) || e));
    app.quit();
  });

/**
 * 应用自身的环境信息 + 系统操作。
 *
 * 为什么这些要单独一组：「设置」面板要告诉用户"你的东西存在哪"，
 * 而目录路径是运行环境决定的（命令行下是项目目录，桌面端是 userData），
 * 前端算不出来，只能问后端。顺带给出版本号，方便用户报 bug 时说清楚环境。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as cfgm from '../config.js';
import { HttpError } from '../http.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** package.json 里的版本号。读一次缓存住，这个文件在运行期不会变 */
let cachedVersion = null;
function version() {
  if (cachedVersion) return cachedVersion;
  try {
    const pkgPath = path.resolve(__dirname, '..', '..', 'package.json');
    cachedVersion = JSON.parse(fs.readFileSync(pkgPath, 'utf8')).version || '0.0.0';
  } catch {
    cachedVersion = '0.0.0';
  }
  return cachedVersion;
}

/**
 * 用系统文件管理器打开一个目录。
 *
 * 全程不 await、不看退出码：这三个命令都会立刻 fork 出去再返回，
 * 而且 explorer.exe 在路径合法时也**返回非零退出码**，拿退出码判成败只会误报。
 * 所以真正的校验放在前面 —— 目录必须存在。
 */
function openInFileManager(dir) {
  let cmd;
  let args;
  if (process.platform === 'win32') {
    // explorer 只认反斜杠路径
    cmd = 'explorer.exe';
    args = [dir.replace(/\//g, '\\')];
  } else if (process.platform === 'darwin') {
    cmd = 'open';
    args = [dir];
  } else {
    cmd = 'xdg-open';
    args = [dir];
  }
  const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
  child.on('error', () => {}); // 命令不存在就算了，不要让异常冒到请求里
  child.unref();
}

export default {
  /** 运行环境 + 各类目录的实际位置 */
  'GET /api/env': async (ctx) => {
    const { cfg } = ctx;
    return {
      ok: true,
      // 桌面端（Electron）由主进程设 LC_DESKTOP=1；浏览器里打开时没有
      desktop: !!process.env.LC_DESKTOP,
      version: version(),
      platform: process.platform,
      node: process.versions.node,
      electron: process.versions.electron || null,
      paths: {
        home: cfgm.PROJECT_ROOT,
        data: cfgm.DATA_DIR,
        config: cfgm.CONFIG_PATH,
        db: cfgm.DB_PATH,
        workspace: cfgm.resolveWorkspace(cfg),
      },
    };
  },

  /**
   * 在系统文件管理器里打开目录。
   *
   * 只接受两个白名单值，不让前端传路径 —— 这个服务虽然只听 127.0.0.1，
   * 但"能打开任意路径"是个没必要的口子。
   */
  'POST /api/open-folder': async (ctx) => {
    const which = String(ctx.body?.which || '');
    if (which !== 'workspace' && which !== 'data') {
      throw new HttpError(400, '只能打开 workspace 或 data 目录');
    }
    const dir = which === 'workspace' ? cfgm.resolveWorkspace(ctx.cfg) : cfgm.DATA_DIR;
    if (!fs.existsSync(dir)) throw new HttpError(404, `目录不存在：${dir}`);
    openInFileManager(dir);
    return { ok: true, opened: dir };
  },
};

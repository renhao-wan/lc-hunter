/**
 * 本地 Web 后端 —— 界面与内核之间唯一的接口层。
 *
 * 这个进程既是命令行 `lc ui` 的服务端，也是桌面端（Electron）窗口里那个页面的服务端。
 * 两种模式共用同一份代码、同一个端口策略（随机端口 + 只听 127.0.0.1），
 * 差别只在「谁来打开这个地址」——浏览器，还是 Electron 的窗口。
 * 所以 src/ 与 web/ 不需要知道自己在被谁用；桌面相关的特殊性（图标、菜单栏、
 * 数据目录）全部收在 electron/main.cjs 里。
 *
 * 只监听 127.0.0.1 —— 这是本地工具，不该在局域网里裸奔。
 *
 * 结构（从原来 624 行的单文件拆出来的）：
 *   - src/http.js            HTTP 骨架：读请求体 / 写 JSON / 防目录穿越 / 静态文件 / 启动
 *   - src/routes/helpers.js  路由共享的题目 helper（rowToProblem / hydrateDetail …）
 *   - src/routes/*.js        按域拆的路由，每个导出一个 { 'METHOD /path': handler }
 *   - 本文件                  只负责把各域路由 register 成一张表，交给 http.createServer
 */
import * as http from './http.js';

import plans from './routes/plans.js';
import problems from './routes/problems.js';
import review from './routes/review.js';
import kama from './routes/kama.js';
import account from './routes/account.js';
import sync from './routes/sync.js';
import settings from './routes/settings.js';

/** 把所有域的路由合并成一张 { 'METHOD /path': handler } 表 */
function registerRoutes() {
  return Object.assign({}, plans, problems, review, kama, account, sync, settings);
}

/** 创建 HTTP server（cli.js 里 `ui` 命令和测试都从这走） */
export function createServer() {
  return http.createServer(registerRoutes());
}

export async function startServer({ port = 0, host = '127.0.0.1' } = {}) {
  return http.startServer(registerRoutes(), { port, host });
}

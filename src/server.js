/**
 * 本地 Web 后端 —— 给 GUI 用的 JSON API。
 *
 * 为什么不是 Electron：Electron 要装 ~150MB 的二进制，而这个项目的原则是零 npm 依赖
 * （数据库用 node:sqlite，HTTP 用 node:http）。先做一个纯 Node 的本地服务 + 浏览器 UI，
 * 内核完全不动；真要打包成 .exe 桌面端，后面再套 Electron/Tauri 就是一层壳的事。
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

/** 把所有域的路由合并成一张 { 'METHOD /path': handler } 表 */
function registerRoutes() {
  return Object.assign({}, plans, problems, review, kama, account, sync);
}

/** 创建 HTTP server（cli.js 里 `ui` 命令和测试都从这走） */
export function createServer() {
  return http.createServer(registerRoutes());
}

export async function startServer({ port = 0, host = '127.0.0.1' } = {}) {
  return http.startServer(registerRoutes(), { port, host });
}

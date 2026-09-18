/**
 * HTTP 基础设施 —— 本地 Web 服务的骨架，与业务无关。
 *
 * 从 src/server.js 拆出来的原因：server.js 原来 624 行，既装路由又装
 * 「读请求体 / 写 JSON / 防目录穿越 / 静态文件 / 启动监听」这些通用件，
 * 谁想改路由都得先跳过一堆 boilerplate。现在：
 *   - 这里只负责「一个请求怎么进、怎么出」的机械流程
 *   - 具体每个接口干什么，见 src/routes/*.js
 *   - src/server.js 只把各域路由 register 进来，是个薄壳
 *
 * HttpError 单独一个类，是为了让路由里能 `throw new HttpError(404, …)`
 * 直接表达「这是业务上可预期的失败」，由 createServer 统一转成对应状态码，
 * 而不是每个 handler 里自己 try/catch 包一层。
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as cfgm from './config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.resolve(__dirname, '..', 'web');

export const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};

export class HttpError extends Error {
  constructor(code, msg) {
    super(msg);
    this.code = code;
  }
}

export function json(res, code, data) {
  const body = JSON.stringify(data);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

export function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let buf = '';
    req.on('data', (c) => {
      buf += c;
      if (buf.length > 2_000_000) {
        reject(new Error('请求体过大'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!buf) return resolve({});
      try {
        resolve(JSON.parse(buf));
      } catch (e) {
        reject(new Error('JSON 解析失败：' + e.message));
      }
    });
    req.on('error', reject);
  });
}

/** 工作区目录 → 只允许在这个目录里读写文件，防目录穿越 */
export function safeResolve(dir, rel) {
  const abs = path.resolve(dir, rel);
  const base = path.resolve(dir);
  if (abs !== base && !abs.startsWith(base + path.sep)) {
    throw new Error('非法路径');
  }
  return abs;
}

function serveStatic(req, res, urlPath) {
  let rel = urlPath === '/' ? 'index.html' : decodeURIComponent(urlPath).replace(/^\/+/, '');
  const file = path.resolve(WEB_DIR, rel);
  if (!file.startsWith(WEB_DIR)) {
    res.writeHead(403).end('forbidden');
    return;
  }
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('404');
    return;
  }
  const ext = path.extname(file).toLowerCase();
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Cache-Control': 'no-cache',
  });
  fs.createReadStream(file).pipe(res);
}

/**
 * 组装一次请求的上下文 ctx 并跑 handler。
 *
 * ctx.cfg 是懒加载的：ensureDirs() 要建两个目录 + 读一次配置文件，而
 * 纯查库的接口（如 /api/due）根本用不上它。用 getter 做到「谁要谁付钱」，
 * 同时保证一次请求内只算一遍。
 */
function dispatch(routes, req, res) {
  const u = new URL(req.url, 'http://127.0.0.1');
  const pathname = u.pathname;

  if (!pathname.startsWith('/api/')) {
    serveStatic(req, res, pathname);
    return;
  }

  const key = `${req.method} ${pathname}`;
  const handler = routes[key];
  if (!handler) {
    json(res, 404, { ok: false, error: `没有这个接口 ${key}` });
    return;
  }

  (async () => {
    try {
      const body = req.method === 'POST' || req.method === 'PUT' ? await readJsonBody(req) : {};
      const query = Object.fromEntries(u.searchParams.entries());

      let cfgOnce;
      const ctx = {
        body,
        query,
        req,
        get cfg() {
          if (!cfgOnce) cfgOnce = cfgm.ensureDirs();
          return cfgOnce;
        },
      };

      const data = await handler(ctx);
      json(res, 200, data);
    } catch (e) {
      const code = e instanceof HttpError ? e.code : 500;
      json(res, code, { ok: false, error: e.message });
    }
  })();
}

/** 用一份路由表创建 HTTP server。routes 来自 src/server.js 的 registerRoutes。 */
export function createServer(routes) {
  return http.createServer((req, res) => dispatch(routes, req, res));
}

export async function startServer(routes, { port = 0, host = '127.0.0.1' } = {}) {
  const server = createServer(routes);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  const actual = server.address().port;
  return { server, port: actual, url: `http://${host}:${actual}` };
}

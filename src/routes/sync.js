/**
 * 数据同步路由：把计划/题目详情/刷题状态同步进本地库。
 */
import * as cfgm from '../config.js';
import * as db from '../db.js';
import * as sync from '../engine/sync.js';
import { HttpError } from '../http.js';

/**
 * 刷题状态同步的实时进度（内存态，进程重启即失效）。
 *
 * 为什么要有这个：全站同步要遍历 4400+ 道题，实测 50 秒左右。
 * HTTP 请求不该挂这么久（浏览器/代理随时会超时），所以做成
 * 「POST 起任务 → GET 轮询进度」，和登录那条链路一个路子。
 */
let statusJob = { running: false, done: false, message: '', synced: 0, statusCount: 0, error: null };

export default {
  'POST /api/sync': async (ctx) => {
    const { plan = null, details = 0 } = ctx.body;
    const { cfg } = ctx;
    const creds = cfgm.loadCredentials();
    const out = await sync.syncPlans({ cfg, creds, only: plan ? [plan] : null, onLog: () => {} });
    if (Number(details) > 0) {
      const slugs = sync.pendingDetailSlugs(plan, Number(details));
      await sync.fetchDetailsFor(slugs, { cfg, creds, limit: Number(details) });
    }
    return { ok: true, plans: out, stats: db.stats() };
  },

  /**
   * 起一个「同步刷题状态」的后台任务。
   *
   * 这条链路以前只有 CLI 的 `lc sync` 能走，界面上一个入口都没有 ——
   * 于是界面上显示的「已通过」永远是本地跑过的那几题，跟力扣实际进度差很远
   * （实测 hot100：本地记 2 题，力扣实际 91 题）。
   */
  'POST /api/sync/status': async (ctx) => {
    const { cfg } = ctx;
    const creds = cfgm.loadCredentials();
    if (!creds?.LEETCODE_SESSION) {
      throw new HttpError(403, '未绑定力扣账号，同步刷题状态需要登录态');
    }
    if (statusJob.running) {
      return { ok: true, started: false, reason: 'busy', hint: '上一次同步还没跑完' };
    }

    statusJob = { running: true, done: false, message: '准备中…', synced: 0, statusCount: 0, error: null };

    // 刻意不 await —— 任务在后台跑，前端轮询 GET /api/sync/status 看进度
    (async () => {
      try {
        const r = await sync.syncCatalog({
          cfg,
          creds,
          onLog: (m) => {
            statusJob.message = m;
          },
        });
        statusJob = {
          running: false,
          done: true,
          message: `已同步 ${r.total} 题，其中 ${r.statusCount} 题有刷题状态`,
          synced: r.total,
          statusCount: r.statusCount,
          error: null,
        };
      } catch (e) {
        statusJob = {
          running: false,
          done: true,
          message: '同步失败',
          synced: 0,
          statusCount: 0,
          error: e.message,
        };
      }
    })();

    return { ok: true, started: true };
  },

  /** 轮询刷题状态同步的进度 */
  'GET /api/sync/status': async () => {
    return { ok: true, ...statusJob };
  },
};

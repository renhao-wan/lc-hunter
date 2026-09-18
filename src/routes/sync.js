/**
 * 数据同步路由：把计划/题目详情同步进本地库。
 */
import * as cfgm from '../config.js';
import * as db from '../db.js';
import * as sync from '../engine/sync.js';

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
};

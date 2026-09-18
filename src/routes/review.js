/**
 * 复习（间隔重复）相关路由：手动记一次 + 从最近运行结果自动排。
 */
import * as db from '../db.js';
import * as draw from '../engine/draw.js';
import { HttpError } from '../http.js';

export default {
  'POST /api/review': async (ctx) => {
    const { slug, quality } = ctx.body || {};
    if (!slug) throw new HttpError(400, '缺少 slug');
    const { cfg } = ctx;
    const r = draw.scheduleReview(slug, Number(quality), cfg);
    return { ok: true, review: r };
  },

  /** 从最近一次运行结果推断 quality 并排下次复习（"跑通了就自动安排复习"） */
  'POST /api/review/auto': async (ctx) => {
    const { slug } = ctx.body || {};
    if (!slug) throw new HttpError(400, '缺少 slug');
    const { cfg } = ctx;
    const last = db.lastAttempt(slug);
    if (!last) throw new HttpError(400, '没有运行记录，先跑一次');
    const quality = draw.qualityFromRun({
      total: last.total,
      passed: last.passed,
      failed: Math.max(0, last.total - last.passed),
    });
    const r = draw.scheduleReview(slug, quality, cfg);
    return { ok: true, quality, review: r };
  },
};

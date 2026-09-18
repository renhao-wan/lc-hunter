/**
 * 卡码网 ACM 绑定相关路由：搜索候选、绑定、解绑。
 */
import * as db from '../db.js';
import { hydrateProblem } from '../engine/generate.js';
import { fetchKamaProblem } from '../kama/index.js';
import { findCandidates } from '../kama/match.js';
import { HttpError } from '../http.js';

export default {
  'GET /api/kama/search': async (ctx) => {
    const { q = '' } = ctx.query;
    if (!q.trim()) return { ok: true, candidates: [] };
    const list = db.listKamaProblems();
    return { ok: true, candidates: findCandidates(q, list, { limit: 8, minScore: 0.35 }) };
  },

  'POST /api/kama/bind': async (ctx) => {
    const { slug, pid, strict = true } = ctx.body;
    if (!slug || !pid) throw new HttpError(400, '缺少 slug/pid');
    const row = db.getProblem(slug);
    if (!row) throw new HttpError(404, '本地没有这道题');
    const k = await fetchKamaProblem(pid);
    const { checkIoCompat, formatIoCheck } = await import('../kama/verify.js');
    const check = checkIoCompat(hydrateProblem(row), k);
    if (check.level === 'bad' && strict) {
      return { ok: false, skipped: true, level: check.level, reasons: check.reasons, kama: { title: k.title } };
    }
    db.updateAcmSource(slug, {
      source: 'kama',
      kamaPid: k.pid,
      inputDesc: k.inputDesc,
      outputDesc: k.outputDesc,
      inputExample: k.inputExample,
      outputExample: k.outputExample,
    });
    return {
      ok: true,
      level: check.level,
      reasons: check.reasons,
      kama: { pid: k.pid, title: k.title, inputDesc: k.inputDesc, outputDesc: k.outputDesc },
    };
  },

  'POST /api/kama/unbind': async (ctx) => {
    const { slug } = ctx.body;
    if (!slug) throw new HttpError(400, '缺少 slug');
    db.updateAcmSource(slug, { source: 'none' });
    return { ok: true };
  },
};

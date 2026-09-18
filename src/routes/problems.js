/**
 * 题目浏览 / 抽题 / 详情 / 生成 / 文件读写 相关路由。
 */
import fs from 'node:fs';
import path from 'node:path';

import * as db from '../db.js';
import * as draw from '../engine/draw.js';
import { getProfile } from '../lang/index.js';
import { generateWorkspace, hydrateProblem, problemDir, loadWorkspaceMeta } from '../engine/generate.js';
import { runWorkspace } from '../engine/runner.js';
import { HttpError, safeResolve } from '../http.js';
import { rowToProblem, groupKeyOf, hydrateDetail, reviewInfo } from './helpers.js';

export default {
  'GET /api/problems': async (ctx) => {
    const { plan, mode, q, limit } = ctx.query;
    const rows = db.getBrowseRows({
      planSlug: plan || null,
      mode: mode || null,
      keyword: (q || '').trim() || null,
      limit: Number(limit) || 2000,
    });

    const out = rows.map(rowToProblem);
    // 每行带上分组名，左栏按计划分节显示时要靠它
    for (let i = 0; i < out.length; i++) out[i].group = groupKeyOf(rows[i]);

    // 顺带告诉界面"这个范围里每种模式各有多少题"，
    // 用户切换「抽什么样的」时括号里的数字要立刻跟着变。
    const counts = db.browseCounts({ planSlug: plan || null, keyword: (q || '').trim() || null });
    return {
      ok: true,
      problems: out,
      total: out.length,
      matched: out.length,
      counts,
      searching: !!((q || '').trim()),
      group: plan ? db.listPlans().find((p) => p.slug === plan)?.name || plan : '全部题目',
    };
  },

  'GET /api/due': async () => {
    return { ok: true, problems: db.listDue(100).map((r) => ({ ...r, title: r.title_cn || r.title_en || r.slug })) };
  },

  'POST /api/draw': async (ctx) => {
    const { plan = null, mode = 'all', count = 1, gen = false, allowNonJava = false } = ctx.body || {};
    const { cfg } = ctx;
    const r = draw.draw({
      cfg,
      planSlug: plan || null,
      mode,
      count: Number(count) || 1,
      allowNonJava: !!allowNonJava,
    });
    const picked = r.picked.map((p) => rowToProblem(p));
    if (gen) {
      const profile = await getProfile(cfg.lang);
      for (const p of picked) {
        // required:false —— 本地没这道题就跳过，不要让整个抽题请求失败
        const hit = await hydrateDetail(p.slug, cfg, { required: false, ignoreFetchError: true });
        if (!hit) continue;
        await generateWorkspace(hit.q, { cfg, profile, modes: ['core', 'acm'] });
      }
    }
    return {
      ok: true,
      picked,
      pool: r.pool,
      filtered: r.filtered || 0,
      stats: draw.drawStats({ cfg, planSlug: plan || null }),
    };
  },

  /** 抽题池体检：界面上要显示"这个计划里有多少能抽" */
  'GET /api/draw/stats': async (ctx) => {
    const { cfg } = ctx;
    const plan = ctx.query.plan || null;
    return { ok: true, stats: draw.drawStats({ cfg, planSlug: plan }) };
  },

  /**
   * 只查数量、不搬题目，给操作条上「抽什么样的」旁边的括号用。
   * 用户切一下模式就要看到数字变，走 /api/problems 会把几千行数据白搬一遍。
   */
  'GET /api/problems/count': async (ctx) => {
    const { plan, q } = ctx.query;
    const counts = db.browseCounts({
      planSlug: plan || null,
      keyword: (q || '').trim() || null,
    });
    return { ok: true, counts };
  },

  'GET /api/problem': async (ctx) => {
    const slug = ctx.query.slug;
    if (!slug) throw new HttpError(400, '缺少 slug');
    const { cfg } = ctx;
    const { row, q } = await hydrateDetail(slug, cfg);

    const dir = problemDir(q, cfg);
    let files = [];
    let meta = null;
    if (fs.existsSync(dir)) {
      files = fs
        .readdirSync(dir)
        .filter((f) => fs.statSync(path.join(dir, f)).isFile())
        .sort((a, b) => {
          const order = ['Solution.java', 'Main.java'];
          const ia = order.indexOf(a);
          const ib = order.indexOf(b);
          if (ia !== -1 || ib !== -1) return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
          return a.localeCompare(b);
        });
      meta = loadWorkspaceMeta(dir);
    }

    return {
      ok: true,
      problem: {
        ...rowToProblem(row),
        titleEn: row.title_en,
        contentMd: q.content_md || '',
        tags: q.tags || [],
        acmSource: row.acm_source,
        kamaPid: row.kama_pid,
        kamaInputDesc: row.kama_input_desc,
        kamaOutputDesc: row.kama_output_desc,
        url: `${cfg.site}/problems/${slug}/`,
      },
      dir,
      files,
      meta,
      // 复习状态单独给一份：界面上要把「下次复习日期」显示出来
      review: reviewInfo(slug),
      // 计划归属：让用户知道"这题属于我看的哪个计划"
      plans: db.plansOfProblem(slug).map((p) => ({ slug: p.slug, name: p.name, group: p.grp })),
    };
  },

  'POST /api/gen': async (ctx) => {
    const { slug, mode = 'both', force = false, resetSolution = false } = ctx.body;
    if (!slug) throw new HttpError(400, '缺少 slug');
    const { cfg } = ctx;
    const { q } = await hydrateDetail(slug, cfg);
    const profile = await getProfile(cfg.lang);
    const modes = mode === 'core' ? ['core'] : mode === 'acm' ? ['acm'] : ['core', 'acm'];
    const res = await generateWorkspace(q, { cfg, profile, modes, force: !!force, resetSolution: !!resetSolution });
    return { ok: true, dir: res.dir, level: res.level, cases: res.cases, written: res.written, notes: res.notes };
  },

  'GET /api/file': async (ctx) => {
    const { slug, name } = ctx.query;
    if (!slug || !name) throw new HttpError(400, '缺少 slug/name');
    const { cfg } = ctx;
    const row = db.getProblem(slug);
    if (!row) throw new HttpError(404, '本地没有这道题');
    const dir = problemDir(hydrateProblem(row), cfg);
    const file = safeResolve(dir, name);
    if (!fs.existsSync(file)) throw new HttpError(404, '文件不存在');
    return { ok: true, name, content: fs.readFileSync(file, 'utf8') };
  },

  'PUT /api/file': async (ctx) => {
    const { slug, name, content } = ctx.body;
    if (!slug || !name) throw new HttpError(400, '缺少 slug/name');
    const { cfg } = ctx;
    const row = db.getProblem(slug);
    if (!row) throw new HttpError(404, '本地没有这道题');
    const dir = problemDir(hydrateProblem(row), cfg);
    const file = safeResolve(dir, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content ?? '', 'utf8');
    return { ok: true, name };
  },

  'POST /api/run': async (ctx) => {
    const { slug } = ctx.body;
    if (!slug) throw new HttpError(400, '缺少 slug');
    const { cfg } = ctx;
    const row = db.getProblem(slug);
    if (!row) throw new HttpError(404, '本地没有这道题');
    const dir = problemDir(hydrateProblem(row), cfg);
    const profile = await getProfile(cfg.lang);
    const res = await runWorkspace(dir, { cfg, profile });
    db.markLocalRun(slug, !!res.summary && res.summary.failed === 0 && res.summary.passed > 0);
    db.addAttempt({ slug, mode: 'acm', passed: res.summary?.passed || 0, total: res.summary?.total || 0 });
    return { ok: true, ...res };
  },
};

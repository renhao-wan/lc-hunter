/**
 * 本地 Web 后端 —— 给 GUI 用的 JSON API。
 *
 * 为什么不是 Electron：Electron 要装 ~150MB 的二进制，而这个项目的原则是零 npm 依赖
 * （数据库用 node:sqlite，HTTP 用 node:http）。先做一个纯 Node 的本地服务 + 浏览器 UI，
 * 内核完全不动；真要打包成 .exe 桌面端，后面再套 Electron/Tauri 就是一层壳的事。
 *
 * 只监听 127.0.0.1 —— 这是本地工具，不该在局域网里裸奔。
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as cfgm from './config.js';
import * as db from './db.js';
import * as draw from './engine/draw.js';
import * as sync from './engine/sync.js';
import { getProfile } from './lang/index.js';
import { generateWorkspace, hydrateProblem, problemDir, loadWorkspaceMeta } from './engine/generate.js';
import { runWorkspace } from './engine/runner.js';
import { fetchKamaProblem } from './kama/index.js';
import { findCandidates } from './kama/match.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.resolve(__dirname, '..', 'web');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};

// ---------------- 小工具 ----------------

function json(res, code, data) {
  const body = JSON.stringify(data);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readJsonBody(req) {
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
function safeResolve(dir, rel) {
  const abs = path.resolve(dir, rel);
  const base = path.resolve(dir);
  if (abs !== base && !abs.startsWith(base + path.sep)) {
    throw new Error('非法路径');
  }
  return abs;
}

/**
 * 难度归一化成 Easy/Medium/Hard。
 * 力扣不同接口返回的大小写不统一（列表接口给 "MEDIUM"，有的地方给 "Medium"），
 * 直接透给 UI 会让 CSS 类名匹配不上、中文映射也失效。
 */
function normDiff(d) {
  if (!d) return null;
  const s = String(d).toLowerCase();
  if (s.startsWith('easy')) return 'Easy';
  if (s.startsWith('medium') || s.startsWith('med')) return 'Medium';
  if (s.startsWith('hard')) return 'Hard';
  return null;
}

function rowToProblem(row) {
  return {
    slug: row.slug,
    frontendId: row.frontend_id,
    title: row.title_cn || row.title_en || row.slug,
    difficulty: normDiff(row.difficulty),
    /*
     * 状态用 db.effectiveStatus 算，不要只看 row.lc_status。
     *
     * lc_status 是从力扣同步来的（要登录），而 local_ac_count / local_run_count
     * 是用户在本工具里自己跑出来的。只看前者，本地跑通过的题会显示成「未做」——
     * 实测 two-sum 本地 AC 了 14 次，界面上还是「未做」，用户会以为筛选坏了。
     * 这里返回 'ac' / 'notac' / 'new' 三种，UI 按小写判断。
     */
    status: db.effectiveStatus(row),
    dueDate: row.due_date || null,
    paidOnly: !!row.paid_only,
    tags: row.tags ? String(row.tags).split(',').filter(Boolean) : [],
    // 抽题结果带上权重与理由，UI 里能解释"为什么抽中这道题"
    weight: row.weight ?? null,
    reasons: row.reasons || null,
  };
}

/**
 * 题目的分组键。
 *
 * 计划里的题归到计划名下，不在任何计划里的归到「其它题目」——
 * 这样左栏标题显示「面试经典 150 题（12）」时，括号里的数就是下面真实的行数，
 * 而不是「库里一共有多少题」。用户看到的数量必须和看到的题对得上。
 */
function groupKeyOf(row) {
  return row.plan_name || row.plan_slug || '其它题目';
}

// ---------------- API ----------------

const routes = {
  'GET /api/state': async () => {
    const cfg = cfgm.ensureDirs();
    const creds = cfgm.loadCredentials();
    // 光看本地有没有 Cookie 不够 —— Cookie 可能是过期的。
    // 绑定了就顺手验一次，让界面能如实显示"已绑定/已失效"。
    let account = null;
    if (creds?.LEETCODE_SESSION) {
      try {
        const client = sync.makeClient(cfg, creds);
        const me = await client.userStatus();
        account = me?.isSignedIn ? toAccount(me) : { signedIn: false };
      } catch (e) {
        account = { signedIn: false, error: e.message };
      }
    }
    return {
      ok: true,
      cfg: {
        lang: cfg.lang,
        site: cfg.site,
        workspace: cfgm.resolveWorkspace(cfg),
        draw: cfg.draw,
      },
      bound: !!creds?.LEETCODE_SESSION,
      account,
      stats: db.stats(),
      plans: db.listPlans().map((p) => ({
        slug: p.slug,
        name: p.name || p.slug,
        count: p.total,
        source: p.source,
        ac: p.ac || 0,
      })),
      // 每个计划在四种抽题模式下各有多少题能抽 —— 下拉里括号的数字靠它。
      // 前端切「抽什么样的」时不用再发请求，直接从这份表里取。
      planCounts: Object.fromEntries(
        db.planModeCounts().map((x) => [x.slug, x.counts]),
      ),
      kamaIndexed: db.countKamaProblems(),
    };
  },

  /**
   * 学习计划广场：全部可用计划（免登录）+ 我加入的计划（需登录）。
   * 这是主线的第一步 —— 用户得先能看见计划，才能选计划、抽计划里的题。
   */
  'GET /api/plans': async (ctx) => {
    const cfg = cfgm.ensureDirs();
    const withMine = ctx.query.mine !== '0';
    const local = db.listPlans();

    let all = [];
    let allError = null;
    try {
      all = await sync.listAllPlans({ cfg });
    } catch (e) {
      allError = e.message;
    }

    // 官方计划列表拉不到时，至少把内置清单和本地已同步的端出来，别让界面空着
    if (!all.length && !allError) allError = '没有拿到任何计划';

    const localMap = new Map(local.map((p) => [p.slug, p]));
    const merged = all.map((p) => {
      const l = localMap.get(p.slug);
      return {
        slug: p.slug,
        name: p.name,
        total: p.total,
        group: p.group,
        desc: p.desc,
        plusOnly: p.plusOnly,
        drawable: p.drawable,
        synced: !!l,
        syncedCount: l?.total ?? 0,
        ac: l?.ac ?? 0,
      };
    });

    // 本地有、但官方列表里没有的（比如已下线的计划）也要显示，否则用户找不到自己同步过的东西
    for (const l of local) {
      if (!merged.some((m) => m.slug === l.slug)) {
        merged.push({
          slug: l.slug,
          name: l.name,
          total: l.question_num,
          group: '本地已同步',
          plusOnly: false,
          drawable: true,
          synced: true,
          syncedCount: l.total,
          ac: l.ac || 0,
        });
      }
    }

    let mine = [];
    let mineError = null;
    const creds = cfgm.loadCredentials();
    if (withMine && creds?.LEETCODE_SESSION) {
      try {
        const client = sync.makeClient(cfg, creds);
        const seen = new Map();
        for (const pt of ['ON_GOING', 'HISTORY']) {
          const r = await client.fetchMyStudyPlans(pt);
          for (const it of r.items) {
            if (it.slug && !seen.has(it.slug)) seen.set(it.slug, { ...it, progressType: pt });
          }
        }
        mine = [...seen.values()].map((it) => ({
          ...it,
          synced: localMap.has(it.slug),
          syncedCount: localMap.get(it.slug)?.total ?? 0,
        }));
      } catch (e) {
        mineError = e.message;
      }
    }

    return {
      ok: true,
      plans: merged,
      mine,
      mineError,
      allError,
      bound: !!creds?.LEETCODE_SESSION,
      stats: db.stats(),
    };
  },

  /** 同步指定计划；不传 slug 就同步内置精选清单 */
  'POST /api/plans/sync': async (ctx) => {
    const { slug = null, mine = false } = ctx.body || {};
    const cfg = cfgm.ensureDirs();
    const creds = cfgm.loadCredentials();
    const only = slug ? [String(slug)] : null;
    const logs = [];
    const out = await sync.syncPlans({
      cfg,
      creds,
      only,
      mine: !!mine,
      onLog: (m) => logs.push(m),
    });
    return {
      ok: true,
      plans: out,
      logs,
      stats: db.stats(),
      // 计划同步回来的题先别急着拉详情 —— 100 题要 2 分钟，让用户按需触发
    };
  },

  /** 把某计划的题补进本地题目目录（只补目录，不拉详情） */
  'GET /api/plans/detail': async (ctx) => {
    const { slug } = ctx.query;
    if (!slug) throw new HttpError(400, '缺少 slug');
    const cfg = cfgm.ensureDirs();
    const rows = db.getPlanProblems(slug);
    const plan = db.getPlan(slug);
    const today = draw.todayStr();
    return {
      ok: true,
      plan: plan ? { slug: plan.slug, name: plan.name, source: plan.source } : null,
      problems: rows.map((r) => {
        const { weight, reasons } = draw.computeWeight(r, cfg, { today });
        return { ...rowToProblem(r), group: r.grp, weight, reasons };
      }),
      stats: draw.drawStats({ cfg, planSlug: slug }),
    };
  },

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
    const cfg = cfgm.ensureDirs();
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
        const row = db.getProblem(p.slug);
        if (!row) continue;
        let q = hydrateProblem(row);
        if (!q.metaData) {
          try {
            await sync.fetchDetail({ cfg, creds: cfgm.loadCredentials(), slug: p.slug });
            q = hydrateProblem(db.getProblem(p.slug) || row);
          } catch {
            /* 拉不到详情也让后面的流程继续，openProblem 里有兜底 */
          }
        }
        await generateWorkspace(q, { cfg, profile, modes: ['core', 'acm'] });
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
    const cfg = cfgm.ensureDirs();
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
    const cfg = cfgm.ensureDirs();
    let row = db.getProblem(slug);
    if (!row) throw new HttpError(404, '本地没有这道题');

    let q = hydrateProblem(row);
    if (!q.metaData) {
      await sync.fetchDetail({ cfg, creds: cfgm.loadCredentials(), slug });
      row = db.getProblem(slug) || row;
      q = hydrateProblem(row);
    }

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
      review: (() => {
        const rv = db.getReview(slug);
        return rv
          ? {
              dueDate: rv.due_date,
              repetitions: rv.repetitions,
              intervalDays: rv.interval_days,
              easiness: rv.easiness,
              lastReviewed: rv.last_reviewed,
            }
          : null;
      })(),
      // 计划归属：让用户知道"这题属于我看的哪个计划"
      plans: db.plansOfProblem(slug).map((p) => ({ slug: p.slug, name: p.name, group: p.grp })),
    };
  },

  'POST /api/gen': async (ctx) => {
    const { slug, mode = 'both', force = false, resetSolution = false } = ctx.body;
    if (!slug) throw new HttpError(400, '缺少 slug');
    const cfg = cfgm.ensureDirs();
    let row = db.getProblem(slug);
    if (!row) throw new HttpError(404, '本地没有这道题');
    let q = hydrateProblem(row);
    if (!q.metaData) {
      await sync.fetchDetail({ cfg, creds: cfgm.loadCredentials(), slug });
      q = hydrateProblem(db.getProblem(slug) || row);
    }
    const profile = await getProfile(cfg.lang);
    const modes = mode === 'core' ? ['core'] : mode === 'acm' ? ['acm'] : ['core', 'acm'];
    const res = await generateWorkspace(q, { cfg, profile, modes, force: !!force, resetSolution: !!resetSolution });
    return { ok: true, dir: res.dir, level: res.level, cases: res.cases, written: res.written, notes: res.notes };
  },

  'GET /api/file': async (ctx) => {
    const { slug, name } = ctx.query;
    if (!slug || !name) throw new HttpError(400, '缺少 slug/name');
    const cfg = cfgm.ensureDirs();
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
    const cfg = cfgm.ensureDirs();
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
    const cfg = cfgm.ensureDirs();
    const row = db.getProblem(slug);
    if (!row) throw new HttpError(404, '本地没有这道题');
    const dir = problemDir(hydrateProblem(row), cfg);
    const profile = await getProfile(cfg.lang);
    const res = await runWorkspace(dir, { cfg, profile });
    db.markLocalRun(slug, !!res.summary && res.summary.failed === 0 && res.summary.passed > 0);
    db.addAttempt({ slug, mode: 'acm', passed: res.summary?.passed || 0, total: res.summary?.total || 0 });
    return { ok: true, ...res };
  },

  'POST /api/review': async (ctx) => {
    const { slug, quality } = ctx.body || {};
    if (!slug) throw new HttpError(400, '缺少 slug');
    const cfg = cfgm.ensureDirs();
    const r = draw.scheduleReview(slug, Number(quality), cfg);
    return { ok: true, review: r };
  },

  /** 从最近一次运行结果推断 quality 并排下次复习（"跑通了就自动安排复习"） */
  'POST /api/review/auto': async (ctx) => {
    const { slug } = ctx.body || {};
    if (!slug) throw new HttpError(400, '缺少 slug');
    const cfg = cfgm.ensureDirs();
    const rows = db.getDb()
      .prepare('SELECT mode, passed, total FROM attempts WHERE slug = ? ORDER BY id DESC LIMIT 1')
      .get(slug);
    if (!rows) throw new HttpError(400, '没有运行记录，先跑一次');
    const quality = draw.qualityFromRun({
      total: rows.total,
      passed: rows.passed,
      failed: Math.max(0, rows.total - rows.passed),
    });
    const r = draw.scheduleReview(slug, quality, cfg);
    return { ok: true, quality, review: r };
  },

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
    const { checkIoCompat, formatIoCheck } = await import('./kama/verify.js');
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

  'POST /api/sync': async (ctx) => {
    const { plan = null, details = 0 } = ctx.body;
    const cfg = cfgm.ensureDirs();
    const creds = cfgm.loadCredentials();
    const out = await sync.syncPlans({ cfg, creds, only: plan ? [plan] : null, onLog: () => {} });
    if (Number(details) > 0) {
      const slugs = sync.pendingDetailSlugs(plan, Number(details));
      await sync.fetchDetailsFor(slugs, { cfg, creds, limit: Number(details) });
    }
    return { ok: true, plans: out, stats: db.stats() };
  },

  /*
   * 注意这里没有「粘贴 Cookie 绑定」的端点，是有意为之。
   *
   * 绑定的唯一入口是下面的 POST /api/login/browser ——
   * 弹浏览器让用户正常登录，我们自动把 Cookie 抓回来。
   * 曾经有过一个 /api/bind 接收用户粘贴的 Cookie，但它带来两个问题：
   *   1. 把"去开发者工具里找 Cookie"这种开发者操作推给了普通用户
   *   2. Cookie 容易被复制不全（少了 HttpOnly 的那个）或已过期，
   *      表现为"提示绑定成功但状态还是未登录"，比直接失败更难排查
   * 现在没有浏览器时会明确告诉用户去装一个，而不是给一条隐蔽的退路。
   */

  'POST /api/unbind': async () => {
    cfgm.clearCredentials();
    return { ok: true, bound: false };
  },

  /**
   * 一键登录：弹一个浏览器窗口让用户登录力扣，自动把 Cookie 抓回来。
   * 这是绑定的主路径 —— 用户不需要知道 Cookie 是什么。
   */
  'POST /api/login/browser': async () => {
    const cfg = cfgm.ensureDirs();
    const { loginAndCapture, findBrowser } = await import('./leetcode/browser.js');

    const br = findBrowser();
    if (!br) {
      // 没有浏览器就没法自动登录。这里不是 500 —— 缺少浏览器是可预期的环境问题，
      // 用带 hint 的正常响应让界面能给出可操作的指引。
      return {
        ok: false,
        reason: 'no-browser',
        hint:
          '没找到 Chrome / Edge / Chromium。装一个任意的即可，' +
          '或者在本机 .lc/config.json 里加一行 "browserPath": "你的浏览器路径"。',
      };
    }

    loginStatus = { running: true, message: '准备中…', startedAt: Date.now(), done: false };
    try {
      const creds = await loginAndCapture({
        site: cfg.site,
        onStatus: (m) => {
          loginStatus.message = m;
        },
      });
      cfgm.saveCredentials(creds);

      // 拿到就立刻验一次，顺便把用户名带回去显示
      const client = sync.makeClient(cfg, creds);
      let account = null;
      try {
        const me = await client.userStatus();
        if (me?.isSignedIn) account = toAccount(me);
      } catch {
        /* 验不了也没关系，Cookie 已经存了 */
      }

      loginStatus = { running: false, done: true, message: '绑定成功', account };
      return { ok: true, bound: true, signedIn: !!account, account };
    } catch (e) {
      loginStatus = { running: false, done: true, error: e.message };
      return { ok: false, reason: 'failed', hint: e.message };
    }
  },

  /** 界面轮询这个看登录进度（CDP 是长任务，HTTP 请求不该一直挂着） */
  'GET /api/login/status': async () => {
    return { ok: true, ...loginStatus };
  },

  /** 开局自检：让界面知道能不能一键登录、有没有已绑的账号 */
  'GET /api/bind/capability': async () => {
    const { browserReport } = await import('./leetcode/browser.js');
    const report = browserReport();
    const creds = cfgm.loadCredentials();
    let account = null;
    if (creds?.LEETCODE_SESSION) {
      const cfg = cfgm.ensureDirs();
      try {
        const me = await sync.makeClient(cfg, creds).userStatus();
        if (me?.isSignedIn) {
          account = toAccount(me);
        }
      } catch {
        /* Cookie 过期 / 网络问题都当作"未登录"，界面会引导重新绑定 */
      }
    }
    return {
      ok: true,
      browser: report,
      bound: !!creds?.LEETCODE_SESSION,
      account,
    };
  },
};

/** 一键登录的实时进度（内存态就够了，进程重启即失效） */
let loginStatus = { running: false, done: false, message: '' };

/**
 * 把 userStatus 的返回整理成界面要的账号对象。
 *
 * 名字优先级很重要：userSlug 是力扣自动生成的（形如 upbeat-parezbl），
 * 直接显示给用户会像是乱码。优先用 realName（用户自己设置的昵称），
 * 其次 username，最后才退回 userSlug。
 */
function toAccount(me) {
  return {
    signedIn: true,
    name: me.realName || me.username || me.userSlug || '已登录',
    userSlug: me.userSlug || '',
    avatar: me.avatar || '',
    premium: !!me.isPremium,
  };
}

class HttpError extends Error {
  constructor(code, msg) {
    super(msg);
    this.code = code;
  }
}

// ---------------- 静态资源 ----------------

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

// ---------------- 启动 ----------------

export function createServer() {
  return http.createServer(async (req, res) => {
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

    try {
      const body = req.method === 'POST' || req.method === 'PUT' ? await readJsonBody(req) : {};
      const query = Object.fromEntries(u.searchParams.entries());
      const data = await handler({ body, query, req });
      json(res, 200, data);
    } catch (e) {
      const code = e instanceof HttpError ? e.code : 500;
      json(res, code, { ok: false, error: e.message });
    }
  });
}

export async function startServer({ port = 0, host = '127.0.0.1' } = {}) {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  const actual = server.address().port;
  return { server, port: actual, url: `http://${host}:${actual}` };
}

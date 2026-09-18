/**
 * 计划相关路由：state / 计划广场 / 同步计划 / 计划详情。
 */
import * as cfgm from '../config.js';
import * as db from '../db.js';
import * as draw from '../engine/draw.js';
import * as sync from '../engine/sync.js';
import { HttpError } from '../http.js';
import { rowToProblem } from './helpers.js';

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

export default {
  'GET /api/state': async (ctx) => {
    const { cfg } = ctx;
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
      // 刷题状态最后一次从力扣同步的时间；null = 从没同步过，
      // 界面据此提示「通过状态可能不是最新的」。
      statusSyncedAt: db.lastStatusSyncAt(),
    };
  },

  /**
   * 学习计划广场：全部可用计划（免登录）+ 我加入的计划（需登录）。
   * 这是主线的第一步 —— 用户得先能看见计划，才能选计划、抽计划里的题。
   */
  'GET /api/plans': async (ctx) => {
    const { cfg } = ctx;
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
    const { cfg } = ctx;
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
    const { cfg } = ctx;
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
};

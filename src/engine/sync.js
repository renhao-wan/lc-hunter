/**
 * 同步层：把力扣的数据搬进本地库。
 * 所有网络交互集中在这里，抽题/生成/运行都不碰网络。
 */
import { LeetCodeClient, normalizeStatus } from '../leetcode/client.js';
import * as db from '../db.js';

export function makeClient(cfg, creds) {
  return new LeetCodeClient({
    site: cfg.site,
    creds,
    intervalMs: cfg.requestIntervalMs,
  });
}

function tagNames(topicTags) {
  return (topicTags || []).map((t) => t.nameTranslated || t.name || t.slug).filter(Boolean);
}

/** 题目目录 + 全站刷题状态 */
export async function syncCatalog({ cfg, creds, onLog } = {}) {
  const client = makeClient(cfg, creds);
  const log = onLog || (() => {});
  let total = 0;
  let statusCount = 0;

  await client.fetchProblemList({
    onPage: async (questions) => {
      for (const q of questions) {
        db.upsertProblem({
          slug: q.titleSlug,
          questionId: null,
          frontendId: q.frontendQuestionId,
          titleEn: q.title,
          titleCn: q.titleCn || q.title,
          difficulty: q.difficulty,
          paidOnly: !!q.paidOnly,
          tags: tagNames(q.topicTags),
        });
        const st = normalizeStatus(q.status);
        if (st) {
          db.upsertProgress(q.titleSlug, { lcStatus: st });
          statusCount++;
        }
        total++;
      }
      log(`  已同步 ${total} 题…`);
    },
  });

  return { total, statusCount };
}

/** 单个学习计划的题目清单 */
export async function syncPlanDetail(client, planSlug, { onLog } = {}) {
  const log = onLog || (() => {});
  const detail = await client.fetchStudyPlanDetail(planSlug);
  if (!detail) return null;

  const items = [];
  for (const it of detail.items || []) {
    // 占位入库；计划详情里自带难度/中文名的，顺手写进去，省一次详情请求
    db.upsertProblem({
      slug: it.slug,
      titleCn: it.title || null,
      difficulty: it.difficulty || null,
    });
    items.push(it);
  }
  db.upsertPlan({
    slug: detail.slug,
    name: detail.name,
    source: 'official',
    questionNum: detail.items?.length ?? null,
  });
  db.replacePlanProblems(detail.slug, items);
  log(`  题单「${detail.name}」：${items.length} 题`);
  return { slug: detail.slug, name: detail.name, count: items.length, empty: items.length === 0 };
}

/**
 * 同步学习计划。
 *
 * @param {string[]} [opts.only] 只同步指定 slug（跳过"列出我的题单"这一步）
 * @param {boolean}  [opts.mine] 只同步「我加入的计划」（需要登录）
 *
 * 关键点：不传 only、又不是 mine 时，默认同步**内置精选清单**而不是"我加入的计划"。
 * 因为「我加入的计划」需要登录，未登录时返回空列表 —— 那样用户会以为功能坏了。
 * 精选清单免登录可用，保证"选计划 → 抽题"这条主线随时能跑通。
 */
export async function syncPlans({ cfg, creds, onLog, only = null, mine = false } = {}) {
  const client = makeClient(cfg, creds);
  const log = onLog || (() => {});

  // 1) 显式指定 slug
  if (only && only.length) {
    const out = [];
    for (const s of only) {
      try {
        const r = await syncPlanDetail(client, s, { onLog });
        if (r) out.push(r);
      } catch (e) {
        log(`  题单 ${s} 同步失败：${e.message}`);
      }
    }
    return out;
  }

  // 2) 只同步我加入的（需要登录）
  if (mine) {
    let myPlans = [];
    try {
      myPlans = await client.fetchStudyPlans();
    } catch (e) {
      throw new Error(
        `拉取「我加入的学习计划」失败：${e.message}\n` +
          `  这条链路需要登录 Cookie。先用 lc bind 绑定，或者改用\n` +
          `    lc sync --plan <slug>      同步某个指定计划\n` +
          `    lc sync --featured         同步内置精选计划（免登录）`,
      );
    }
    if (!myPlans.length) {
      log('  账号下没有已加入的学习计划（或 Cookie 已失效）');
      return [];
    }
    log(`  你加入了 ${myPlans.length} 个计划`);
    const out = [];
    for (const p of myPlans) {
      try {
        const r = await syncPlanDetail(client, p.slug, { onLog });
        if (r) {
          // 记下"这是我自己加入的"，GUI 里可以单独分组
          db.upsertPlan({ slug: r.slug, name: r.name, source: 'mine', questionNum: r.count });
          out.push({ ...r, mine: true, finished: p.finished, planTotal: p.total });
        }
      } catch (e) {
        log(`  题单 ${p.slug} 同步失败：${e.message}`);
      }
    }
    return out;
  }

  // 3) 默认：内置精选清单（免登录）
  const { FEATURED_PLANS } = await import('../leetcode/plans.js');
  log(`  同步内置精选计划（${FEATURED_PLANS.length} 个，不需要登录）`);
  const out = [];
  for (const p of FEATURED_PLANS) {
    try {
      const r = await syncPlanDetail(client, p.slug, { onLog });
      if (r) out.push(r);
    } catch (e) {
      log(`  题单 ${p.slug} 同步失败：${e.message}`);
    }
  }
  return out;
}

/**
 * 拉取全部可用计划（免登录），并标注内置元信息。
 * CLI / GUI 的「学习计划广场」用它。
 *
 * 分组策略：优先用**官方分类名**（分类是站点自己维护的，最不会错），
 * 内置清单的 group 只作为分类缺失时的兜底 —— 否则同一个计划会同时出现在
 * "面试准备"（内置）和"面试准备 · 全面通关"（官方）两个组里。
 */
export async function listAllPlans({ cfg, onLog } = {}) {
  const { planMeta, isDrawablePlan } = await import('../leetcode/plans.js');
  const client = makeClient(cfg, null);
  const plans = await client.fetchAllPlans({ onLog });
  return plans.map((p) => {
    const meta = planMeta(p.slug);
    return {
      ...p,
      group: p.catalogName || meta?.group || '其它',
      desc: meta?.desc || null,
      plusOnly: meta?.plusOnly ?? !!p.premiumOnly,
      drawable: isDrawablePlan(p.slug),
    };
  });
}

/** 拉取单题详情（题面 / metaData / 官方代码签名 / 样例） */
export async function fetchDetail({ cfg, creds, slug, onLog } = {}) {
  const client = makeClient(cfg, creds);
  const d = await client.fetchQuestionDetail(slug);
  if (!d) return null;

  db.upsertProblem({
    slug: d.slug,
    questionId: d.questionId,
    frontendId: d.frontendId,
    titleEn: d.titleEn,
    titleCn: d.titleCn,
    difficulty: d.difficulty,
    paidOnly: d.paidOnly,
    tags: d.topicTags,
  });
  db.updateProblemDetail(d.slug, d);
  onLog?.(`  ${d.frontendId}. ${d.titleCn}（${d.difficulty}）详情已入库`);
  return d;
}

/** 批量补详情：优先补题单里 detail_fetched=0 的 */
export async function fetchDetailsFor(slugs, { cfg, creds, onLog, limit = null } = {}) {
  const log = onLog || (() => {});
  const client = makeClient(cfg, creds);
  const list = limit ? slugs.slice(0, limit) : slugs;
  let ok = 0;
  let fail = 0;
  for (let i = 0; i < list.length; i++) {
    const slug = list[i];
    try {
      const d = await client.fetchQuestionDetail(slug);
      if (!d) {
        fail++;
        continue;
      }
      db.upsertProblem({
        slug: d.slug,
        questionId: d.questionId,
        frontendId: d.frontendId,
        titleEn: d.titleEn,
        titleCn: d.titleCn,
        difficulty: d.difficulty,
        paidOnly: d.paidOnly,
        tags: d.topicTags,
      });
      db.updateProblemDetail(d.slug, d);
      ok++;
      log(`  [${i + 1}/${list.length}] ${d.frontendId}. ${d.titleCn}`);
    } catch (e) {
      fail++;
      log(`  [${i + 1}/${list.length}] ${slug} 失败：${e.message}`);
    }
  }
  return { ok, fail };
}

/** 题单里还没拉详情的 slug 列表 */
export function pendingDetailSlugs(planSlug, limit = null) {
  const rows = db.getPlanProblems(planSlug);
  const out = rows.filter((r) => !r.paid_only).map((r) => r.slug);
  const db_ = db.getDb();
  const have = new Set(
    db_.prepare('SELECT slug FROM problems WHERE detail_fetched = 1').all().map((r) => r.slug),
  );
  const pending = out.filter((s) => !have.has(s));
  return limit ? pending.slice(0, limit) : pending;
}

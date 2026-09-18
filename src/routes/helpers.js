/**
 * 路由共享的题目相关 helper。
 *
 * 从 src/server.js 拆出来 —— rowToProblem / hydrateDetail 被 problems、plans、
 * draw、gen 等多个域的路由用到，放回 server.js 会让各路由模块互相 import 壳文件，
 * 形成环形依赖。单独成文件，谁用谁引。
 */
import * as db from '../db.js';
import * as cfgm from '../config.js';
import * as sync from '../engine/sync.js';
import { hydrateProblem } from '../engine/generate.js';
import { normalizeDifficulty } from '../labels.js';
import { HttpError } from '../http.js';

/** 难度归一化，直接转发 labels 的实现，调用点不用改 */
const normDiff = normalizeDifficulty;

export function rowToProblem(row) {
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
export function groupKeyOf(row) {
  return row.plan_name || row.plan_slug || '其它题目';
}

/**
 * 拿到一道题的完整对象（含 metaData / content_md），本地没拉过详情就现拉一次。
 *
 * 为什么抽出来：这段「查行 → hydrate → 没 metaData 就 fetchDetail → 再查回来 hydrate」
 * 在 /api/problem、/api/gen、/api/draw 里各抄了一遍，三份的实现细节还不一样
 * （有的吞异常有的往外抛，有的 !row 时 throw 有的 continue）。
 *
 * 两个开关对应那三处原本的差异：
 *   required          false 时查不到返回 null，交给调用方决定跳过还是报错
 *   ignoreFetchError  true 时拉详情失败也返回现状（生成工作区场景下，拉不到详情
 *                     也得让流程走下去，generateWorkspace 里对空 metaData 有兜底）
 */
export async function hydrateDetail(slug, cfg, { required = true, ignoreFetchError = false } = {}) {
  const row = db.getProblem(slug);
  if (!row) {
    if (required) throw new HttpError(404, '本地没有这道题');
    return null;
  }
  let q = hydrateProblem(row);
  if (q.metaData) return { row, q };
  try {
    await sync.fetchDetail({ cfg, creds: cfgm.loadCredentials(), slug });
    const fresh = db.getProblem(slug) || row;
    return { row: fresh, q: hydrateProblem(fresh) };
  } catch (e) {
    if (!ignoreFetchError) throw e;
    return { row, q };
  }
}

/** 界面上要显示「下次复习日期」，单独给一份。没有复习记录就是 null。 */
export function reviewInfo(slug) {
  const rv = db.getReview(slug);
  if (!rv) return null;
  return {
    dueDate: rv.due_date,
    repetitions: rv.repetitions,
    intervalDays: rv.interval_days,
    easiness: rv.easiness,
    lastReviewed: rv.last_reviewed,
  };
}

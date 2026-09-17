/**
 * 抽题引擎 + SM-2 复习调度。
 *
 * 权重设计（相对基数 1.0）：
 *   - 复习到期：× dueWeight（默认 5）——"该复习了"优先级最高
 *   - 做过没 AC：× notacWeight（默认 3）——欠债优先还
 *   - 已 AC 且复习次数达标：× masteredDecay（默认 0.3）——真会了就少抽
 *   - 刚抽过（冷却期内）：线性降权到 8%，避免连着几天同一题
 *   - 难度：中等 ×1.2，困难 ×1.35（简单题权重最低，但不会被排除）
 *   - 付费题：权重 0，直接排除
 */
import * as db from '../db.js';
import { isDrawablePlan } from '../leetcode/plans.js';

const DAY = 24 * 60 * 60 * 1000;

export function todayStr(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function addDays(dateStr, n) {
  const [y, m, d] = String(dateStr || todayStr())
    .split('-')
    .map(Number);
  const dt = new Date(y, (m || 1) - 1, d || 1);
  dt.setDate(dt.getDate() + Math.round(n));
  return todayStr(dt);
}

/** 计算单题权重，并返回可读的原因（GUI 里可以直接展示"为什么抽中它"） */
export function computeWeight(row, cfg, { now = Date.now(), today = todayStr() } = {}) {
  const d = cfg.draw || {};
  if (row.paid_only) return { weight: 0, reasons: ['付费题，排除'] };

  let w = 1;
  const reasons = [];

  const diff = String(row.difficulty || '').toUpperCase();
  if (diff === 'MEDIUM') {
    w *= 1.2;
    reasons.push('中等 ×1.2');
  } else if (diff === 'HARD') {
    w *= 1.35;
    reasons.push('困难 ×1.35');
  }

  // 状态一律走 db.effectiveStatus —— 它同时看「力扣同步来的 lc_status」和
  // 「本地自己跑出来的 local_*_count」。只看前者的话，本地跑通过的题会被当成没做过，
  // 于是「做过的（复习）」抽不出来、「还没做过的」又把做过的题再推一遍。
  const status = db.effectiveStatus(row);
  const reps = row.repetitions || 0;

  if (status === 'notac') {
    w *= d.notacWeight ?? 3;
    reasons.push(`未 AC ×${d.notacWeight ?? 3}`);
  } else if (status === 'ac' && reps >= (d.masteredThreshold ?? 3)) {
    w *= d.masteredDecay ?? 0.3;
    reasons.push(`已掌握（复习 ${reps} 次）×${d.masteredDecay ?? 0.3}`);
  }

  if (row.due_date && row.due_date <= today) {
    w *= d.dueWeight ?? 5;
    reasons.push(`复习到期(${row.due_date}) ×${d.dueWeight ?? 5}`);
  }

  if (row.last_drawn_at) {
    const days = (now - row.last_drawn_at) / DAY;
    const cd = d.cooldownDays ?? 3;
    if (days < cd) {
      const f = Math.max(0.08, days / cd);
      w *= f;
      reasons.push(`冷却中（${days.toFixed(1)}/${cd} 天）×${f.toFixed(2)}`);
    }
  }

  if (reasons.length === 0) reasons.push('基础权重');
  return { weight: Math.max(w, 0), reasons };
}

const MODE_FILTERS = {
  all: () => true,
  // 「还没做过的」= 力扣没同步到状态，且本地也从没跑过
  new: (r) => db.effectiveStatus(r) === 'new',
  // 「做过的（复习）」：只要做过就算，包括本地跑通过但还没同步到力扣的
  ac: (r) => db.effectiveStatus(r) === 'ac',
  // 「做过的」：已通过 + 做过没过，都算
  done: (r) => db.effectiveStatus(r) !== 'new',
  due: (r, today) => !!r.due_date && r.due_date <= today,
};

/** 按权重无放回抽样 */
function pickWeighted(candidates, count, rng = Math.random) {
  const pool = candidates.slice();
  const picked = [];
  while (picked.length < count && pool.length > 0) {
    const total = pool.reduce((s, c) => s + c.weight, 0);
    if (total <= 0) {
      // 全 0（比如都在冷却且被压到 0）：退回均匀随机，保证还能抽出来
      const i = Math.floor(rng() * pool.length);
      picked.push(pool[i]);
      pool.splice(i, 1);
      continue;
    }
    let r = rng() * total;
    let idx = 0;
    for (let i = 0; i < pool.length; i++) {
      r -= pool[i].weight;
      if (r <= 0) {
        idx = i;
        break;
      }
      idx = i;
    }
    picked.push(pool[idx]);
    pool.splice(idx, 1);
  }
  return picked;
}

/**
 * 抽题。
 * @param {object} opts
 * @param {string} [opts.planSlug] 限定学习计划；不传则从全库抽
 * @param {'all'|'new'|'ac'|'due'} [opts.mode]
 * @param {number} [opts.count]
 * @param {string[]} [opts.exclude] 排除的 slug
 * @param {boolean} [opts.persist] 是否写入"最近抽取"记录（默认 true）
 * @param {boolean} [opts.allowNonJava] 是否允许抽非 Java 计划（SQL/Pandas/JS）里的题，默认 false
 */
export function draw({
  cfg,
  planSlug = null,
  mode = 'all',
  count = null,
  exclude = [],
  persist = true,
  rng,
  allowNonJava = false,
} = {}) {
  const rows = planSlug ? db.getPlanProblems(planSlug) : db.getAllProblemRows();
  if (!rows.length) return { picked: [], pool: 0, mode, planSlug, filtered: 0 };

  const today = todayStr();
  const now = Date.now();
  const filter = MODE_FILTERS[mode] || MODE_FILTERS.all;
  const ex = new Set(exclude);

  // 全库抽题时要躲开 SQL / Pandas / JS 计划的题 —— 那些题的题面是 SQL 或 JS，
  // 抽到了也没法用 Java 写。指定了具体计划就尊重用户的选择，不再过滤。
  const skipSet = new Set();
  if (!planSlug && !allowNonJava) {
    for (const p of db.listPlans()) {
      if (isDrawablePlan(p.slug)) continue;
      for (const s of db.planProblemSlugs(p.slug)) skipSet.add(s);
    }
  }

  const candidates = [];
  let filtered = 0;
  for (const r of rows) {
    if (ex.has(r.slug) || skipSet.has(r.slug)) continue;
    if (!filter(r, today)) continue;
    const { weight, reasons } = computeWeight(r, cfg, { now, today });
    if (weight <= 0) {
      filtered++;
      continue;
    }
    candidates.push({ ...r, weight, reasons });
  }

  const n = count ?? cfg.draw?.defaultCount ?? 1;
  const picked = pickWeighted(candidates, n, rng);

  if (persist) {
    for (const p of picked) db.markDrawn(p.slug);
  }

  return { picked, pool: candidates.length, mode, planSlug, filtered };
}

/** 抽题池体检：看看现在有多少可抽、多少到期 */
export function drawStats({ cfg, planSlug = null, allowNonJava = false } = {}) {
  const rows = planSlug ? db.getPlanProblems(planSlug) : db.getAllProblemRows();
  const today = todayStr();

  const skipSet = new Set();
  if (!planSlug && !allowNonJava) {
    for (const p of db.listPlans()) {
      if (isDrawablePlan(p.slug)) continue;
      for (const s of db.planProblemSlugs(p.slug)) skipSet.add(s);
    }
  }

  let ac = 0;
  let notac = 0;
  let fresh = 0;
  let due = 0;
  let excluded = 0;
  for (const r of rows) {
    if (skipSet.has(r.slug)) {
      excluded++;
      continue;
    }
    if (r.paid_only) continue;
    const st = db.effectiveStatus(r);
    if (st === 'ac') ac++;
    else if (st === 'notac') notac++;
    else fresh++;
    if (r.due_date && r.due_date <= today) due++;
  }
  return { total: rows.length, ac, notac, fresh, due, excluded };
}

// ---------------- SM-2 间隔重复 ----------------

/**
 * 记录一次复习结果。
 * @param {number} quality 0-5：5=秒杀，4=有点卡但过了，3=勉强，<3=没做出来
 */
export function scheduleReview(slug, quality, cfg) {
  const q = Math.max(0, Math.min(5, Number(quality) || 0));
  const prev = db.getReview(slug) || { slug, easiness: 2.5, interval_days: 0, repetitions: 0 };

  let ef = Number(prev.easiness ?? 2.5);
  let reps = Number(prev.repetitions ?? 0);
  let interval = Number(prev.interval_days ?? 0);

  if (q < 3) {
    // 没做出来：从头再来
    reps = 0;
    interval = 1;
  } else {
    reps += 1;
    if (reps === 1) interval = cfg?.review?.firstIntervalDays ?? 1;
    else if (reps === 2) interval = 6;
    else interval = Math.max(1, Math.round(interval * ef));
  }

  ef = ef + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02));
  if (ef < 1.3) ef = 1.3;

  const rec = {
    slug,
    easiness: Math.round(ef * 100) / 100,
    intervalDays: interval,
    repetitions: reps,
    dueDate: addDays(todayStr(), interval),
    lastReviewed: todayStr(),
  };
  db.upsertReview(rec);
  return rec;
}

/** 依据本地对拍结果推断一个 quality（0-5） */
export function qualityFromRun(summary) {
  if (!summary) return 0;
  const { total = 0, passed = 0, failed = 0 } = summary;
  if (total === 0) return 0;
  if (failed === 0 && passed > 0) return 5;
  if (passed === 0) return 1;
  const ratio = passed / (passed + failed);
  if (ratio >= 0.7) return 3;
  return 2;
}

/**
 * 全站中文标签的唯一来源（后端侧）。
 *
 * 为什么要有这个文件 ——
 * 「难度 → 中文」原来在三处各写一遍，而且键名是两套：
 *   src/cli.js              { EASY: '简单', MEDIUM: '中等', HARD: '困难' }
 *   src/engine/generate.js  { EASY: '简单', MEDIUM: '中等', HARD: '困难' }  ← 同上，另抄一份
 *   web/app.js              { Easy: '简单', Medium: '中等', Hard: '困难' }  ← 键名是另一套
 * 状态词也是两套说法：CLI 里是「AC / 未AC / 未做」的圈内黑话，页面里是
 * 「已通过 / 做过没过 / 没做过」的大白话。同一份数据两种说法，改一处必漏一处。
 *
 * 约定（改代码时请守）——
 *   1. 规范键名只有一套：难度 'Easy' | 'Medium' | 'Hard'，
 *      状态 'ac' | 'notac' | 'new'。任何地方拿到原始值，先过 normalizeDifficulty()
 *      再查表，因为力扣不同接口给的大小写不一样（"MEDIUM" / "Medium" 都有）。
 *   2. 后端要中文，一律从本文件取。不要再就地 new 一个对象字面量。
 *   3. web/ 是静态目录、没有打包器，前端 import 不到 src/，所以 web/app.js
 *      里保留一份副本；test/_verify-labels.js 会读出两份做深比较，
 *      哪边改了另一边没跟上就直接报红。
 */

export const DIFF_CN = { Easy: '简单', Medium: '中等', Hard: '困难' };

// 状态词都用大白话。「AC / 未AC」是刷题圈的黑话，第一次用的人看不懂。
// 后端只会产出这三种（见 src/db.js 的 effectiveStatus）。
export const STATUS_CN = { ac: '已通过', notac: '做过没过', new: '没做过' };

/**
 * 难度归一化成 Easy / Medium / Hard，认不出来返回 null。
 * 力扣不同接口返回的大小写不统一（列表接口给 "MEDIUM"，有的地方给 "Medium"），
 * 不归一化会导致 CSS 类名匹配不上、中文映射也查不到。
 */
export function normalizeDifficulty(d) {
  if (!d) return null;
  const s = String(d).toLowerCase();
  if (s.startsWith('easy')) return 'Easy';
  if (s.startsWith('medium') || s.startsWith('med')) return 'Medium';
  if (s.startsWith('hard')) return 'Hard';
  return null;
}

/**
 * 难度中文名。认不出来的原样返回（网络抖动时可能是别的东西），
 * 空值给 fallback。
 */
export function difficultyCn(d, fallback = '-') {
  const key = normalizeDifficulty(d);
  if (key) return DIFF_CN[key];
  return d || fallback;
}

/**
 * 状态中文名。未知状态按「没做过」处理 —— 和 CLI 里
 * statusCn 的兜底行为一致（宁可说没做过，也不要把未知状态
 * 渲染成已通过，那会让用户以为刷过了）。
 */
export function statusCn(s) {
  return STATUS_CN[s] || STATUS_CN.new;
}

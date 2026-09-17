/*
 * 回归：列表接口和详情接口给出的状态必须一致。
 *
 * 背景（2026-09-17 修掉的 bug）：
 *   db.getProblem() 用的是 `SELECT * FROM problems`，而 problems 表里没有
 *   lc_status / local_ac_count / local_run_count。于是左栏列表（走 getBrowseRows，
 *   有 JOIN，状态正确）和详情面板（走 getProblem，状态恒为 new）会对同一道题
 *   给出两个答案 —— two-sum 本地 AC 15 次，列表标「已通过」，详情写「没做过」。
 *
 * 这个脚本故意挑「有本地记录」的题来比：全是 new 的题两边都 new，看不出问题。
 * 所以先自己找出候选，避免依赖硬编码的 slug（换库/清库后就失效了）。
 */
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';

const BASE = process.env.LC_BASE || 'http://127.0.0.1:7788';
const DB = 'D:/projects/lc-hunter/.lc/lc-hunter.db';

// --- 1. 直接从库里挑出「有本地记录」的题，它们才有区分度 ---
const db = new DatabaseSync(DB);
const sql =
  "SELECT slug, lc_status, local_ac_count, local_run_count FROM progress " +
  "WHERE (lc_status IS NOT NULL AND lc_status <> '') " +
  "   OR COALESCE(local_ac_count,0) > 0 OR COALESCE(local_run_count,0) > 0";
const rows = db.prepare(sql).all();

console.log('=== 有本地记录的题 ===');
if (rows.length === 0) {
  console.log('  （没有）—— 先在库里跑通或跑挂至少一道题，这个用例才有意义');
}
for (const r of rows) {
  console.log(
    `  ${r.slug.padEnd(34)} lc_status=${String(r.lc_status).padEnd(5)} local_ac=${r.local_ac_count} local_run=${r.local_run_count}`,
  );
}

// --- 2. 逐题比对列表接口 vs 详情接口 ---
const list = await (await fetch(`${BASE}/api/problems?limit=2000`)).json();
const bySlug = new Map((list.problems || list.rows || list.items || []).map((p) => [p.slug, p]));

console.log('\n=== 列表接口 vs 详情接口 ===');
let checked = 0;
let bad = 0;
for (const r of rows) {
  const inList = bySlug.get(r.slug);
  if (!inList) {
    // 详情一定查得到（不依赖列表分页），单独核对
    const d = (await (await fetch(`${BASE}/api/problem?slug=${encodeURIComponent(r.slug)}`)).json()).problem;
    console.log(`  ${r.slug.padEnd(34)} 列表里没有（超出 2000 条上限）  详情=${d.status}`);
    continue;
  }
  const d = (await (await fetch(`${BASE}/api/problem?slug=${encodeURIComponent(r.slug)}`)).json()).problem;
  const ok = inList.status === d.status;
  checked++;
  if (!ok) bad++;
  console.log(
    `  ${r.slug.padEnd(34)} 列表=${String(inList.status).padEnd(6)} 详情=${String(d.status).padEnd(6)} ${ok ? '一致' : '★不一致★'}`,
  );
}

// --- 3. 详情接口不该把任何一道有本地 AC 的题判成 new ---
console.log('\n=== 关键回归：本地跑通过 => 详情不能是 new ===');
let failAc = 0;
for (const r of rows) {
  if ((r.local_ac_count || 0) === 0) continue;
  const d = (await (await fetch(`${BASE}/api/problem?slug=${encodeURIComponent(r.slug)}`)).json()).problem;
  const ok = d.status === 'ac';
  if (!ok) failAc++;
  console.log(`  ${r.slug.padEnd(34)} 详情=${String(d.status).padEnd(6)} ${ok ? '正确' : '★错误★'}`);
}

console.log('\n--- 结论 ---');
console.log(`  比对 ${checked} 道，不一致 ${bad} 道`);
console.log(`  本地 AC 但详情非 ac：${failAc} 道`);
if (bad === 0 && failAc === 0) {
  console.log('  PASS  列表与详情口径一致');
  process.exit(0);
} else {
  console.log('  FAIL  详情接口的状态口径又漂了，检查 db.getProblem 有没有 JOIN progress');
  process.exit(1);
}

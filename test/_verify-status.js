/*
 * 验证「做过的」判定口径修好了。
 *
 * 背景：本地跑通过的题（local_ac_count > 0）以前被当成「没做过」，
 * 导致「已通过」筛不出来、「还没做过的」把做过的题再推一遍。
 *
 * 这个脚本直接用库里的数据比对：把 library 层各查询的结果，和手工按
 * 「力扣同步状态 OR 本地跑通过」算出来的期望值对一遍。
 */
import * as db from '../src/db.js';
import * as draw from '../src/engine/draw.js';

const rows = db.getAllProblemRows();
console.log('全库题目行:', rows.length);

// --- 手工算期望值（口径：lc_status='ac' 或 local_ac_count>0 → ac；两者皆无 → new；其余 → notac）
//
// 注意这里**不过滤付费题** —— browseCounts 也不过滤，两边口径要对齐才比得出来。
// （drawStats 会额外排除付费题和非 Java 计划，那部分单独看，不参与这里的比对。）
const expect = { ac: 0, notac: 0, new: 0 };
const expectSlugs = { ac: [], notac: [], new: [] };
for (const r of rows) {
  const lc = r.lc_status == null ? '' : String(r.lc_status);
  const localAc = r.local_ac_count || 0;
  const localRun = r.local_run_count || 0;
  let st;
  if (lc === 'ac' || localAc > 0) st = 'ac';
  else if ((lc === '' || lc === 'not_started') && localRun === 0) st = 'new';
  else st = 'notac';
  expect[st]++;
  expectSlugs[st].push(r.slug);
}

console.log('');
console.log('=== 期望值（手工按口径算）===');
console.log('  已通过:', expect.ac, ' 做过没过:', expect.notac, ' 没做过:', expect.new);

// --- 实际：逐行调 effectiveStatus，看是否与期望一致
const actual = { ac: 0, notac: 0, new: 0 };
let mismatch = 0;
for (const r of rows) {
  const st = db.effectiveStatus(r);
  actual[st]++;
  if (!expectSlugs[st].includes(r.slug)) mismatch++;
}
console.log('');
console.log('=== 实际 effectiveStatus ===');
console.log('  已通过:', actual.ac, ' 做过没过:', actual.notac, ' 没做过:', actual.new);
console.log('  与期望不一致的行数:', mismatch);

// --- 关键回归：本地 AC 过但 lc_status 为空的题，必须被算成"已通过"
const localOnly = rows.filter((r) => (r.local_ac_count || 0) > 0 && !r.lc_status);
console.log('');
console.log('=== 关键回归：本地跑通过但没同步到力扣的题 ===');
console.log('  这类题共', localOnly.length, '道:');
for (const r of localOnly.slice(0, 8)) {
  const st = db.effectiveStatus(r);
  console.log(
    `    ${r.slug.padEnd(38)} local_ac=${String(r.local_ac_count).padEnd(3)} lc_status=${JSON.stringify(r.lc_status).padEnd(6)} → ${st}  ${st === 'ac' ? '✓' : '✗ 应该是 ac'}`,
  );
}

// --- 通过 SQL 层验一遍（这才是界面真正走的路径）
console.log('');
console.log('=== SQL 层（browseCounts）===');
const counts = db.browseCounts({});
console.log(' ', JSON.stringify(counts));
const sqlOk =
  counts.ac === expect.ac && counts.notac === expect.notac && counts.new === expect.new;
console.log('  与期望一致:', sqlOk ? '是' : '否');

console.log('');
console.log('=== SQL 层（getBrowseRows 各模式行数）===');
for (const mode of [null, 'done', 'ac', 'notac', 'new']) {
  const n = db.getBrowseRows({ mode, limit: 100000 }).length;
  const label = mode === null ? '不限' : mode;
  console.log(`  mode=${String(label).padEnd(6)} → ${n} 行`);
}

// --- 抽题引擎
console.log('');
console.log('=== 抽题引擎（MODE_FILTERS 池子大小）===');
const cfg = { draw: {} };
for (const mode of ['all', 'new', 'done', 'ac', 'due']) {
  const r = draw.draw({ cfg, planSlug: null, mode, count: 1 });
  console.log(`  mode=${mode.padEnd(5)} → 池子 ${String(r.pool).padEnd(6)} 抽到 ${r.picked.length} 题`);
}

const allPass = mismatch === 0 && sqlOk;
console.log('');
console.log(allPass ? '结论: 口径统一，本地跑通过的题已被正确算作"做过了"。' : '结论: 仍有不一致。');
process.exit(allPass ? 0 : 1);

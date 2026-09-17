// 修复历史数据：把 title_cn 里存成英文的那批题，用计划详情接口的中文名覆盖回来。
//
// 背景：STUDY_PLAN_DETAIL 之前只查了 title（英文），没查 translatedTitle，
// 导致计划同步进来的题中文名全是英文。查询已修，这里补历史数据。
//
// 幂等：只覆盖 "title_cn 不含中文" 的行，重复跑没有副作用。
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';

const url = 'https://leetcode.cn/graphql/';
const dbPath = path.resolve(import.meta.dirname, '..', '.lc', 'lc-hunter.db');
const db = new DatabaseSync(dbPath);

const hasCJK = (s) => /[\u4e00-\u9fa5]/.test(s || '');

// 先看哪些计划需要修
const plans = db
  .prepare(
    `SELECT DISTINCT p.plan_slug AS slug
     FROM plan_problems p JOIN problems q ON q.slug = p.problem_slug
     WHERE q.title_cn NOT GLOB '*[一-龥]*'`,
  )
  .all()
  .map((r) => r.slug);

console.log(`需要修复的计划：${plans.join(', ') || '(无)'}`);
if (!plans.length) {
  console.log('没有需要修复的数据。');
  db.close();
  process.exit(0);
}

const QUERY = `query studyPlanV2Detail($planSlug: String!) {
  studyPlanV2Detail(planSlug: $planSlug) {
    name slug
    planSubGroups { slug name questions { titleSlug title translatedTitle difficulty } }
  }
}`;

const upd = db.prepare(`UPDATE problems SET title_cn = ? WHERE slug = ? AND (title_cn IS NULL OR title_cn = '' OR title_cn NOT GLOB '*[一-龥]*')`);

let totalFixed = 0;

for (const planSlug of plans) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Referer: 'https://leetcode.cn/' },
    body: JSON.stringify({ query: QUERY, variables: { planSlug } }),
  });
  const j = await r.json();
  if (j.errors) {
    console.log(`  ${planSlug}: ❌ ${j.errors.map((e) => e.message).join(' | ')}`);
    continue;
  }
  const groups = j.data?.studyPlanV2Detail?.planSubGroups ?? [];
  const qs = groups.flatMap((g) => g.questions ?? []);

  let n = 0;
  let skipped = 0;
  for (const q of qs) {
    const cn = q.translatedTitle;
    if (!cn || !hasCJK(cn)) {
      // 本来就没有官方译名（比如纯 SQL 题），保持原样
      skipped++;
      continue;
    }
    const res = upd.run(cn, q.titleSlug);
    if (res.changes > 0) n++;
  }
  totalFixed += n;
  console.log(`  ${planSlug}: ${qs.length} 题，修好 ${n}，无中文译名跳过 ${skipped}`);
  // 别把站点打得太紧
  await new Promise((r) => setTimeout(r, 350));
}

console.log('');
const still = db.prepare(`SELECT COUNT(*) AS n FROM problems WHERE title_cn NOT GLOB '*[一-龥]*'`).get();
console.log(`共修复 ${totalFixed} 题。剩余仍无中文名的：${still.n} 题（多为 SQL/数据库类，官方本就没有中文译名）。`);

db.close();

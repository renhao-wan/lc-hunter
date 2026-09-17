// 冒烟测试：验证 SQLite 通路 + 力扣网络通路（题目详情无需登录）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureDirs } from '../src/config.js';
import * as db from '../src/db.js';
import { LeetCodeClient } from '../src/leetcode/client.js';
import { PROBLEMSET_LIST } from '../src/leetcode/queries.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, 'smoke-out.txt');
const lines = [];
const log = (...a) => lines.push(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x, null, 2))).join(' '));

async function main() {
  const cfg = ensureDirs();

  log('=== 1. 力扣网络：拉取 two-sum 题目详情（无需 Cookie）===');
  const client = new LeetCodeClient({ site: cfg.site, creds: null, intervalMs: 1100 });
  let detail = null;
  try {
    detail = await client.fetchQuestionDetail('two-sum');
  } catch (e) {
    log('FETCH FAILED:', e.name, '-', e.message);
    if (e.payload) log('payload:', e.payload);
  }

  if (detail) {
    log('题号:', detail.frontendId, '|', detail.titleCn, '|', detail.difficulty);
    log('metaData:', detail.metaData);
    log('sampleTestCase:', JSON.stringify(detail.sampleTestCase));
    log('exampleTestcases:', JSON.stringify(detail.exampleTestcases));
    const java = detail.codeSnippets.find((c) => c.langSlug === 'java');
    log('java snippet:\n' + (java ? java.code : '(none)'));

    db.upsertProblem({
      slug: detail.slug,
      questionId: detail.questionId,
      frontendId: detail.frontendId,
      titleEn: detail.titleEn,
      titleCn: detail.titleCn,
      difficulty: detail.difficulty,
      paidOnly: detail.paidOnly,
      tags: detail.topicTags,
    });
    db.updateProblemDetail(detail.slug, detail);
    log('已入库:', db.getProblem('two-sum') ? 'OK' : 'FAILED');
  }

  log('\n=== 2. 题单分页查询（1 页）===');
  try {
    const data = await client.graphql(
      PROBLEMSET_LIST,
      { categorySlug: '', skip: 0, limit: 3, filters: {} },
      'problemsetQuestionList',
    );
    const l = data.problemsetQuestionList;
    log('total:', l.total);
    log('sample:', l.questions);
  } catch (e) {
    log('LIST QUERY FAILED:', e.message, e.payload ?? '');
  }

  log('\n=== 3. Schema 探测：确认可用字段 ===');
  for (const [label, query] of [
    ['Query 顶层字段(含 plan/study)', `{ __type(name: "Query") { fields { name } } }`],
    ['TopicTagNode 字段', `{ __type(name: "TopicTagNode") { fields { name } } }`],
  ]) {
    try {
      const d = await client.graphql(query);
      const names = (d?.__type?.fields ?? []).map((f) => f.name);
      const interesting = names.filter((n) =>
        /plan|study|question|problem|user/i.test(n),
      );
      log(`${label}: 共 ${names.length} 个字段`);
      log('  相关字段:', interesting.join(', ') || '(introspection 受限)');
    } catch (e) {
      log(`${label}: introspection 失败 -> ${e.message}`);
    }
  }

  log('\n=== 4. 统计 ===');
  log('stats:', db.stats());
}

main()
  .catch((e) => {
    log('UNCAUGHT:', e.stack || e.message);
  })
  .finally(() => {
    fs.writeFileSync(OUT, lines.join('\n'), 'utf8');
    db.closeDb();
  });

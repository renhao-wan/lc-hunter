// 探针 2：坐实学习计划字段名，并验证题单最终查询
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LeetCodeClient } from '../src/leetcode/client.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, 'probe-list2-out.txt');
const lines = [];
const log = (...a) => lines.push(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x, null, 2))).join(' '));

const CANDIDATES = [
  {
    label: 'A1: 题单最终版',
    q: `query p($categorySlug: String, $limit: Int, $skip: Int, $filters: QuestionListFilterInput) {
      problemsetQuestionList(categorySlug: $categorySlug, limit: $limit, skip: $skip, filters: $filters) {
        total hasMore
        questions { titleSlug title titleCn difficulty status paidOnly frontendQuestionId acRate solutionNum
          topicTags { name nameTranslated slug } }
      }
    }`,
    vars: { categorySlug: '', skip: 0, limit: 3, filters: {} },
  },
  {
    label: 'D1: 学习计划列表 (ProgressStatus)',
    q: `query s($progressType: ProgressStatus, $offset: Int, $limit: Int) {
      studyPlanV2UserProgresses(progressType: $progressType, offset: $offset, limit: $limit) {
        total
        planUserProgresses { id startedAt plan { slug name } }
      }
    }`,
    vars: { progressType: 'ON_GOING', offset: 0, limit: 20 },
  },
  {
    label: 'E1: planSubGroups.questions',
    q: `query d($planSlug: String!) {
      studyPlanV2Detail(planSlug: $planSlug) { name slug
        planSubGroups { slug name questions { titleSlug } } }
    }`,
    vars: { planSlug: 'lcof' },
  },
  {
    label: 'E2: planSubGroups.questionList',
    q: `query d($planSlug: String!) {
      studyPlanV2Detail(planSlug: $planSlug) { name slug
        planSubGroups { slug name questionList { titleSlug } } }
    }`,
    vars: { planSlug: 'lcof' },
  },
  {
    label: 'E3: 故意查错字段，套出建议',
    q: `query d($planSlug: String!) {
      studyPlanV2Detail(planSlug: $planSlug) { planSubGroups { zzzz } }
    }`,
    vars: { planSlug: 'lcof' },
  },
];

async function main() {
  const client = new LeetCodeClient({ site: 'https://leetcode.cn', creds: null, intervalMs: 1100 });
  for (const c of CANDIDATES) {
    log('\n===== ' + c.label + ' =====');
    try {
      const d = await client.graphql(c.q, c.vars);
      log('OK:', JSON.stringify(d).slice(0, 1200));
    } catch (e) {
      log('FAIL:', e.message);
    }
  }
}

main()
  .catch((e) => log('UNCAUGHT:', e.stack || e.message))
  .finally(() => fs.writeFileSync(OUT, lines.join('\n'), 'utf8'));

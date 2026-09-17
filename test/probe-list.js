// 探针：CN 站 introspection 被禁用，用"试错 + 收集全部 GraphQL 错误"的方式反推真实字段
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LeetCodeClient } from '../src/leetcode/client.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, 'probe-list-out.txt');
const lines = [];
const log = (...a) => lines.push(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x, null, 2))).join(' '));

const CANDIDATES = [
  {
    label: 'A: total/hasMore/questions + 别名',
    q: `query p($categorySlug: String, $limit: Int, $skip: Int, $filters: QuestionListFilterInput) {
      problemsetQuestionList(categorySlug: $categorySlug, limit: $limit, skip: $skip, filters: $filters) {
        total hasMore
        questions { titleSlug title titleCn difficulty status acRate
          frontendQuestionId: questionFrontendId paidOnly: isPaidOnly solutionNum
          topicTags { name nameTranslated slug } }
      }
    }`,
  },
  {
    label: 'B: 去掉别名，用直名',
    q: `query p($categorySlug: String, $limit: Int, $skip: Int, $filters: QuestionListFilterInput) {
      problemsetQuestionList(categorySlug: $categorySlug, limit: $limit, skip: $skip, filters: $filters) {
        total hasMore
        questions { titleSlug title titleCn difficulty status acRate
          questionFrontendId isPaidOnly solutionNum
          topicTags { name translatedName slug } }
      }
    }`,
  },
  {
    label: 'C: 最小化（只要 total/questions{titleSlug}）',
    q: `query p($categorySlug: String, $limit: Int, $skip: Int, $filters: QuestionListFilterInput) {
      problemsetQuestionList(categorySlug: $categorySlug, limit: $limit, skip: $skip, filters: $filters) {
        total
        questions { titleSlug }
      }
    }`,
  },
  {
    label: 'D: 学习计划列表 studyPlanV2UserProgresses',
    q: `query s($progressType: ProgressType, $offset: Int, $limit: Int) {
      studyPlanV2UserProgresses(progressType: $progressType, offset: $offset, limit: $limit) {
        total
        planUserProgresses { id startedAt plan { slug name } }
      }
    }`,
    vars: { progressType: 'ON_GOING', offset: 0, limit: 20 },
  },
  {
    label: 'E: 学习计划详情 studyPlanV2Detail(lcof)',
    q: `query d($planSlug: String!) {
      studyPlanV2Detail(planSlug: $planSlug) { name slug description
        planSubGroups { slug name questionSlugs } }
    }`,
    vars: { planSlug: 'lcof' },
  },
];

async function main() {
  const client = new LeetCodeClient({ site: 'https://leetcode.cn', creds: null, intervalMs: 1100 });
  for (const c of CANDIDATES) {
    log('\n===== ' + c.label + ' =====');
    try {
      const d = await client.graphql(c.q, c.vars ?? { categorySlug: '', skip: 0, limit: 2, filters: {} });
      log('OK:', JSON.stringify(d).slice(0, 900));
    } catch (e) {
      log('FAIL:', e.message);
      if (e.payload) log('  payload:', JSON.stringify(e.payload).slice(0, 900));
    }
  }
}

main()
  .catch((e) => log('UNCAUGHT:', e.stack || e.message))
  .finally(() => fs.writeFileSync(OUT, lines.join('\n'), 'utf8'));

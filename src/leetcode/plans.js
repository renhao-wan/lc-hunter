/**
 * 精选学习计划清单（内置，不依赖登录）。
 *
 * 为什么要有这份静态清单：
 *   studyPlansV2ByCatalog 虽然免登录可用，但它会变（活动计划上下线、改 slug）。
 *   把「够稳、够常用」的计划固化下来，好处是：
 *     1. 没绑 Cookie 也能一键同步题库、直接抽题
 *     2. 官方接口万一改字段，内置清单仍能让主流程活着
 *
 * 排除范围（按用户要求）：纯 SQL / Pandas / JavaScript 的专项计划不收录 ——
 * 这个工具是给 Java 算法刷题用的，那些计划的题面是 SQL 或 JS，进来只会污染抽题池。
 *
 * 每个计划的 lang 表示它的题目语言，只有 'java' 才允许被抽题引擎选中。
 */

/** 语言无关的算法/面试类计划 */
export const FEATURED_PLANS = [
  // ---- 面试准备 ----
  {
    slug: 'top-interview-150',
    name: '面试经典 150 题',
    group: '面试准备',
    lang: 'java',
    desc: '覆盖面试高频知识点，最经典的入门清单',
  },
  {
    slug: 'top-100-liked',
    name: 'LeetCode 热题 100',
    group: '面试准备',
    lang: 'java',
    desc: '按热度排序的 100 道必刷题',
  },
  {
    slug: 'leetcode-75',
    name: 'LeetCode 75',
    group: '面试准备',
    lang: 'java',
    desc: '75 题精简路线，适合时间紧的时候',
  },
  {
    slug: 'cracking-the-coding-interview',
    name: '程序员面试金典',
    group: '面试准备',
    lang: 'java',
    desc: '《Cracking the Coding Interview》配套题',
  },
  {
    slug: 'coding-interviews-special',
    name: '119 经典题变种挑战',
    group: '面试准备',
    lang: 'java',
    desc: '经典题的变体，练手很合适',
  },
  {
    slug: '2024-spring-sprint-100',
    name: '2024 春招冲刺百题计划',
    group: '面试准备',
    lang: 'java',
    desc: '春招冲刺路线',
  },

  // ---- 专项深入 ----
  {
    slug: 'dynamic-programming',
    name: '动态规划（基础版）',
    group: '专项突破',
    lang: 'java',
    desc: 'DP 从入门到能用',
  },
  {
    slug: 'graph-theory',
    name: '图论 · 从入门到精通',
    group: '专项突破',
    lang: 'java',
    desc: '图论专题',
  },
  {
    slug: 'binary-search',
    name: '二分查找 · 系统掌握',
    group: '专项突破',
    lang: 'java',
    desc: '二分专题',
  },
  {
    slug: 'programming-skills',
    name: '编程基础 0 到 1',
    group: '专项突破',
    lang: 'java',
    desc: '基础语法与入门数据结构',
  },
  {
    slug: 'primers-list',
    name: '「新」动计划 · 编程入门',
    group: '专项突破',
    lang: 'java',
    desc: '零基础起步',
  },
];

/**
 * 名企冲刺计划全量都是 Plus 专属（实测 studyPlanV2Detail 返回 0 题），
 * 所以只作为「如果你有会员，可以试试」的提示存在，不参与默认抽题。
 */
export const COMPANY_SPRINT_PLANS = [
  { slug: 'huawei-2023-fall-sprint', name: '华为秋招冲刺', lang: 'java' },
  { slug: 'tencent-2023-fall-sprint', name: '腾讯秋招高效备战', lang: 'java' },
  { slug: 'ali-2023-fall-sprint', name: '阿里秋招面试宝典', lang: 'java' },
  { slug: 'jd-2023-fall-sprint', name: '京东秋招备考计划', lang: 'java' },
  { slug: 'bytedance-2023-fall-sprint', name: '字节跳动秋招计划', lang: 'java' },
  { slug: 'kuaishou-2023-fall-sprint', name: '快手秋招真题', lang: 'java' },
  { slug: 'pdd-2023-fall-sprint', name: '拼多多秋招备战', lang: 'java' },
  { slug: 'meituan-2023-fall-sprint', name: '美团秋招攻略', lang: 'java' },
  { slug: 'baidu-2023-fall-sprint', name: '百度秋招突击手册', lang: 'java' },
  { slug: 'didi-2023-fall-sprint', name: '滴滴秋招橙意计划', lang: 'java' },
  { slug: 'mi-2023-fall-sprint', name: '小米秋招真题笔记', lang: 'java' },
  { slug: 'mihoyo-2023-fall-sprint', name: '米哈游秋招面试题', lang: 'java' },
  { slug: 'xiaohongshu-2023-fall-sprint', name: '小红书秋招特训', lang: 'java' },
  { slug: 'dji-2023-fall-sprint', name: '大疆秋招真题实录', lang: 'java' },
];

/**
 * 明确排除的计划：这些计划里的题不是 Java 算法题，进来会污染题池。
 * 抽题引擎会拿这个集合做过滤，避免"抽到一道 SQL 题却发现没法写 Java"。
 */
export const EXCLUDED_PLANS = new Set([
  'sql-free-50',
  'sql-premium-50',
  'introduction-to-pandas',
  '30-days-of-pandas',
  '30-days-of-javascript',
]);

/** slug → 计划元信息（仅供内置清单用；官方接口同步来的计划也会走一次标注） */
export const PLAN_META = new Map([
  ...FEATURED_PLANS.map((p) => [p.slug, { ...p }]),
  ...COMPANY_SPRINT_PLANS.map((p) => [p.slug, { ...p, group: '名企冲刺', plusOnly: true }]),
]);

/**
 * 判断一个计划是否适合参与 Java 抽题。
 * 官方接口同步回来的计划没有 lang 标记，只能靠 slug 排除法兜底。
 */
export function isDrawablePlan(slug) {
  if (!slug) return true;
  if (EXCLUDED_PLANS.has(slug)) return false;
  const meta = PLAN_META.get(slug);
  if (meta) return meta.lang === 'java';
  // 未知计划：用命名兜底
  if (/^sql-|pandas|javascript|^php-|^golang-|^python-/.test(slug)) return false;
  return true;
}

export function planMeta(slug) {
  return PLAN_META.get(slug) || null;
}

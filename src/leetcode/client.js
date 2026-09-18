import {
  USER_STATUS,
  PROBLEMSET_LIST,
  QUESTION_DETAIL,
  STUDY_PLAN_PROGRESSES,
  STUDY_PLAN_DETAIL,
  STUDY_PLAN_CATALOGS,
  STUDY_PLAN_BY_CATALOG,
  STUDY_PLAN_ADS,
  ALL_QUESTIONS_BETA,
} from './queries.js';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/**
 * 归一化刷题状态。
 * CN 站返回 AC / TRIED / NOT_STARTED（未登录时全部是 NOT_STARTED）；
 * 国际站是 ac / notac / null。统一成 ac / notac / null 三种。
 */
export function normalizeStatus(s) {
  if (!s) return null;
  const v = String(s).toUpperCase();
  if (v === 'AC' || v === 'ACCEPTED') return 'ac';
  if (v === 'TRIED' || v === 'NOTAC' || v === 'ATTEMPTED' || v === 'WRONG') return 'notac';
  return null;
}

class LeetCodeError extends Error {
  constructor(message, { status, payload } = {}) {
    super(message);
    this.name = 'LeetCodeError';
    this.status = status;
    this.payload = payload;
  }
}

export class LeetCodeClient {
  /**
   * @param {object} opts
   * @param {string} opts.site  形如 https://leetcode.cn
   * @param {object} [opts.creds] { LEETCODE_SESSION, csrftoken }
   * @param {number} [opts.intervalMs] 请求最小间隔
   */
  constructor({ site = 'https://leetcode.cn', creds = null, intervalMs = 1100 } = {}) {
    this.site = site.replace(/\/$/, '');
    this.creds = creds;
    this.intervalMs = intervalMs;
    this._lastRequestAt = 0;
  }

  get endpoint() {
    return `${this.site}/graphql/`;
  }

  get isAuthed() {
    return !!(this.creds && (this.creds.LEETCODE_SESSION || this.creds.leetcode_session));
  }

  _cookieHeader() {
    if (!this.creds) return '';
    const { LEETCODE_SESSION, csrftoken } = this.creds;
    const parts = [];
    if (LEETCODE_SESSION) parts.push(`LEETCODE_SESSION=${LEETCODE_SESSION}`);
    if (csrftoken) parts.push(`csrftoken=${csrftoken}`);
    // 兼容小写键名
    if (this.creds.leetcode_session) parts.push(`LEETCODE_SESSION=${this.creds.leetcode_session}`);
    if (this.creds.csrf_token) parts.push(`csrftoken=${this.creds.csrf_token}`);
    return parts.join('; ');
  }

  async _throttle() {
    const wait = this.intervalMs - (Date.now() - this._lastRequestAt);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    this._lastRequestAt = Date.now();
  }

  async graphql(query, variables = {}, operationName = undefined) {
    await this._throttle();
    const headers = {
      'Content-Type': 'application/json',
      'User-Agent': UA,
      Accept: '*/*',
      Referer: `${this.site}/`,
      Origin: this.site,
    };
    const cookie = this._cookieHeader();
    if (cookie) headers['Cookie'] = cookie;
    if (this.creds?.csrftoken) headers['x-csrftoken'] = this.creds.csrftoken;

    const body = JSON.stringify({ query, variables, ...(operationName ? { operationName } : {}) });

    let res;
    try {
      res = await fetch(this.endpoint, { method: 'POST', headers, body });
    } catch (e) {
      throw new LeetCodeError(`网络请求失败: ${e.message}`);
    }

    const text = await res.text();
    if (!res.ok) {
      throw new LeetCodeError(`HTTP ${res.status} ${res.statusText}`, { status: res.status, payload: text.slice(0, 500) });
    }

    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw new LeetCodeError('响应不是合法 JSON（可能是 Cloudflare 拦截或需要登录）', {
        status: res.status,
        payload: text.slice(0, 500),
      });
    }

    if (json.errors && json.errors.length) {
      const msg = json.errors.map((e) => e.message).join(' | ');
      throw new LeetCodeError(`GraphQL 错误: ${msg}`, { status: res.status, payload: json.errors });
    }

    return json.data;
  }

  // ---------- 具体接口 ----------

  async userStatus() {
    const data = await this.graphql(USER_STATUS, {}, 'userStatus');
    return data?.userStatus ?? null;
  }

  /**
   * 全量拉取题目目录 + 刷题状态。
   * 注：CN 站响应里没有可靠的 total，改为"翻到空页为止"。
   */
  async fetchProblemList({ onPage, limit = 100, maxPages = 100 } = {}) {
    let skip = 0;
    let collected = 0;
    for (let page = 0; page < maxPages; page++) {
      const data = await this.graphql(
        PROBLEMSET_LIST,
        { categorySlug: '', skip, limit, filters: {} },
        'problemsetQuestionList',
      );
      const questions = data?.problemsetQuestionList?.questions ?? [];
      if (questions.length === 0) break;
      collected += questions.length;
      if (onPage) await onPage(questions, { skip, page });
      skip += questions.length;
    }
    return { collected };
  }

  async fetchQuestionDetail(titleSlug) {
    const data = await this.graphql(QUESTION_DETAIL, { titleSlug }, 'questionData');
    const q = data?.question;
    if (!q) return null;
    let metaData = null;
    if (q.metaData) {
      try {
        metaData = JSON.parse(q.metaData);
      } catch {
        metaData = null;
      }
    }
    return {
      questionId: q.questionId,
      frontendId: q.questionFrontendId,
      titleEn: q.title,
      titleCn: q.translatedTitle || q.title,
      slug: q.titleSlug,
      difficulty: q.difficulty,
      paidOnly: !!q.isPaidOnly,
      contentMd: q.translatedContent || q.content || '',
      codeSnippets: q.codeSnippets ?? [],
      metaData,
      sampleTestCase: q.sampleTestCase ?? '',
      exampleTestcases: q.exampleTestcases ?? '',
      topicTags: (q.topicTags ?? []).map((t) => t.translatedName || t.name),
      hints: q.hints ?? [],
    };
  }

  /**
   * 我加入的学习计划（进行中 / 历史）。**需要登录**。
   *
   * progressType 必须传具体值（PlanUserProgressTypeEnum! 是非空的）。
   * 站点前端只用到 ON_GOING 和 HISTORY 两个入口，就照抄它。
   *
   * @param {'ON_GOING'|'HISTORY'} progressType
   */
  async fetchMyStudyPlans(progressType = 'ON_GOING') {
    const data = await this.graphql(
      STUDY_PLAN_PROGRESSES,
      { progressType, offset: 0, limit: 100 },
      'GetMyStudyPlan',
    );
    const r = data?.studyPlanV2UserProgresses;
    if (!r) return { total: 0, items: [] };
    const items = (r.planUserProgresses ?? []).map((it) => ({
      slug: it.plan?.slug || null,
      name: it.plan?.name || it.plan?.slug || null,
      total: it.plan?.questionNum ?? null,
      finished: it.finishedQuestionNum ?? null,
      premiumOnly: !!it.plan?.premiumOnly,
      onGoing: it.plan?.onGoing ?? null,
      startedAt: it.startedAt || null,
      latestSubmissionAt: it.latestSubmissionAt || null,
      allCompletedAt: it.allCompletedAt || null,
      // 站点直接告诉你「下一题是什么」，抽题时可以优先推荐
      nextQuestion: it.nextQuestionInfo?.nextQuestion
        ? {
            slug: it.nextQuestionInfo.nextQuestion.titleSlug,
            title: it.nextQuestionInfo.nextQuestion.translatedTitle || it.nextQuestionInfo.nextQuestion.title,
            frontendId: it.nextQuestionInfo.nextQuestion.questionFrontendId,
          }
        : null,
    }));
    return { total: r.total ?? items.length, items };
  }

  /**
   * 兼容旧调用：把我的学习计划按 进行中 → 历史 合并去重。
   *
   * 注意：这里不再像以前那样"第一个类型失败就抛" —— 未登录时接口返回的是空列表
   * 而不是报错，抛出去会把"没登录"误报成"接口坏了"。真正的鉴权判断交给 userStatus()。
   */
  async fetchStudyPlans() {
    const seen = new Map();
    const errors = [];
    for (const pt of ['ON_GOING', 'HISTORY']) {
      try {
        const { items } = await this.fetchMyStudyPlans(pt);
        for (const it of items) {
          if (it.slug && !seen.has(it.slug)) seen.set(it.slug, it);
        }
      } catch (e) {
        errors.push(`${pt}: ${e.message}`);
      }
    }
    if (!seen.size && errors.length === 2) {
      throw new LeetCodeError(`拉取学习计划失败：${errors.join(' | ')}`);
    }
    return [...seen.values()];
  }

  /** 全部学习计划分类（**免登录**） */
  async fetchPlanCatalogs() {
    const data = await this.graphql(STUDY_PLAN_CATALOGS, {}, 'GetStudyPlanCatalogs');
    return (data?.studyPlanV2Catalogs ?? []).map((c) => ({
      slug: c.slug,
      name: c.name,
      recommended: c.recommendedStudyPlans ?? [],
    }));
  }

  /** 按分类翻页取计划列表（**免登录**） */
  async fetchPlansByCatalog(catalogSlug, { offset = 0, limit = 100 } = {}) {
    const data = await this.graphql(
      STUDY_PLAN_BY_CATALOG,
      { catalogSlug, offset, limit },
      'GetStudyPlanByCatalog',
    );
    const r = data?.studyPlansV2ByCatalog;
    return {
      total: r?.total ?? 0,
      hasMore: !!r?.hasMore,
      plans: (r?.studyPlans ?? []).map((p) => ({
        slug: p.slug,
        name: p.name,
        total: p.questionNum ?? null,
        premiumOnly: !!p.premiumOnly,
        onGoing: !!p.onGoing,
        highlight: p.highlight || null,
        cover: p.cover || null,
      })),
    };
  }

  /** 首页广告位计划（**免登录**），可作为计划全量的补充来源 */
  async fetchPlanAds() {
    const data = await this.graphql(STUDY_PLAN_ADS, {}, 'GetStudyPlanListAds');
    return (data?.studyPlansV2AdFeature ?? []).map((p) => ({
      slug: p.slug,
      name: p.name,
      total: p.questionNum ?? null,
      premiumOnly: !!p.premiumOnly,
      cover: p.cover || null,
    }));
  }

  /**
   * 拉全部计划（分类 + 各分类下清单 + 广告位），去重后返回。
   * 全流程免登录 —— 这是"没绑账号也能抽计划里的题"的基础。
   */
  async fetchAllPlans({ onLog } = {}) {
    const log = onLog || (() => {});
    const map = new Map();
    const put = (p) => {
      if (!p?.slug) return;
      const prev = map.get(p.slug);
      // 后到的信息更全就覆盖（广告位没有 total 时别把已有值冲掉）
      map.set(p.slug, { ...prev, ...p, total: p.total ?? prev?.total ?? null });
    };

    let catalogs = [];
    try {
      catalogs = await this.fetchPlanCatalogs();
      log(`  计划分类 ${catalogs.length} 个`);
    } catch (e) {
      log(`  分类接口失败（${e.message}），退回内置清单`);
    }

    for (const c of catalogs) {
      try {
        const r = await this.fetchPlansByCatalog(c.slug);
        for (const p of r.plans) put({ ...p, catalog: c.slug, catalogName: c.name });
        log(`  分类「${c.name}」${r.plans.length} 个计划`);
      } catch (e) {
        log(`  分类 ${c.slug} 拉取失败：${e.message}`);
      }
    }

    try {
      const ads = await this.fetchPlanAds();
      for (const p of ads) put(p);
    } catch {
      /* 广告位失败无所谓 */
    }

    return [...map.values()];
  }

  /**
   * 学习计划题目列表。站点字段可能变动，失败时抛出由上层降级处理。
   *
   * 注意：Plus 专属计划在未订阅时返回 planSubGroups=[]（不是报错），
   * 所以"0 题"要区分成「确实空」和「需要会员」两种情况，由调用方提示。
   */
  async fetchStudyPlanDetail(planSlug) {
    const data = await this.graphql(STUDY_PLAN_DETAIL, { planSlug }, 'studyPlanV2Detail');
    const d = data?.studyPlanV2Detail;
    if (!d) return null;
    const items = [];
    let ord = 0;
    for (const g of d.planSubGroups ?? []) {
      for (const q of g.questions ?? []) {
        const slug = typeof q === 'string' ? q : q?.titleSlug;
        if (slug) {
          items.push({
            slug,
            group: g.name || g.slug || null,
            // 计划详情里自带难度的计划（大部分）能省一次详情请求
            difficulty: typeof q === 'object' ? q.difficulty : null,
            // title 是英文原标题，translatedTitle 才是中文站的中文名。
            // 优先取中文，退回英文（英文站 / 未翻译的题）。
            title: typeof q === 'object' ? q.translatedTitle || q.title : null,
            ord: ord++,
          });
        }
      }
    }
    return {
      slug: d.slug || planSlug,
      name: d.name || planSlug,
      description: d.description || null,
      items,
    };
  }

  async fetchAllStatus() {
    const data = await this.graphql(ALL_QUESTIONS_BETA, {}, 'allQuestionsBeta');
    return data?.allQuestionsBeta ?? [];
  }
}

// 力扣（中国站）GraphQL 查询集合。
// 注意：这不是官方开放 API，是站点自用接口（逆向而来）。
// 仅供个人自用；请配合本地缓存与请求节流，勿高频调用。

export const USER_STATUS = `
query userStatus {
  userStatus {
    isSignedIn
    username
    userSlug
    realName
    isPremium
    avatar
  }
}
`;

// CN 站点实测（2026-09）：
//  - Query 上是 problemsetQuestionList 本身，没有 leetcode.com 的 Query.questionList
//  - 返回类型 QuestionListNode，题目节点是 QuestionLightNode
//  - 字段是 paidOnly / frontendQuestionId（不是 isPaidOnly / questionFrontendId）
//  - 标签节点 CommonTagNode 用 nameTranslated（不是 translatedName）
//  - status 取值 NOT_STARTED / TRIED / AC（不是 leetcode.com 的 null / notac / ac）
export const PROBLEMSET_LIST = `
query problemsetQuestionList($categorySlug: String, $limit: Int, $skip: Int, $filters: QuestionListFilterInput) {
  problemsetQuestionList(categorySlug: $categorySlug, limit: $limit, skip: $skip, filters: $filters) {
    questions {
      acRate
      difficulty
      freqBar
      frontendQuestionId
      isFavor
      paidOnly
      solutionNum
      status
      title
      titleCn
      titleSlug
      topicTags { name nameTranslated slug }
    }
  }
}
`;

export const QUESTION_DETAIL = `
query questionData($titleSlug: String!) {
  question(titleSlug: $titleSlug) {
    questionId
    questionFrontendId
    title
    titleSlug
    translatedTitle
    content
    translatedContent
    difficulty
    isPaidOnly
    sampleTestCase
    exampleTestcases
    metaData
    codeSnippets { lang langSlug code }
    topicTags { name translatedName slug }
    hints
  }
}
`;

// 用户已加入的学习计划（进行中 / 历史）。
//
// 这个 query 是从站点前端 chunk 里挖出来的（pages/studyplan 的共享模块 84889），
// 和站点自己发的请求逐字一致。两个坑：
//   1. $progressType 的类型是 PlanUserProgressTypeEnum!（非空），不是 ProgressStatus。
//      写成 ProgressStatus 会直接 400：Variable "$progressType" of type "ProgressStatus"
//      used in position expecting type "PlanUserProgressTypeEnum!". —— 这个错曾让学习计划
//      同步整条链路瘫掉。
//   2. 必须传非空值。前端枚举表（module 35208）里合法值是：
//      NOT_START / ON_GOING / COMPLETED / QUITTED / DELETED，前端只用到 ON_GOING 和 HISTORY 两个入口。
//
// 注意 limit 是必填（Int!），不传也会 400。
export const STUDY_PLAN_PROGRESSES = `
query GetMyStudyPlan($progressType: PlanUserProgressTypeEnum!, $offset: Int!, $limit: Int!) {
  studyPlanV2UserProgresses(progressType: $progressType, offset: $offset, limit: $limit) {
    hasMore
    total
    planUserProgresses {
      id
      startedAt
      finishedQuestionNum
      latestSubmissionAt
      allCompletedAt
      quittedAt
      nextQuestionInfo {
        inPremiumSubgroup
        nextQuestion { id questionFrontendId title titleSlug translatedTitle }
      }
      plan {
        slug
        name
        questionNum
        premiumOnly
        onGoing
        highlight
        cover
      }
    }
  }
}
`;

// 学习计划详情（题单内容）。字段以站点为准，若失效请见 sync 的降级处理。
//
// 注意：questions 里必须带上 translatedTitle。只查 title 的话，
// 计划同步进来的题在中文站会显示成英文名（title 是英文原标题）。
// 同理 difficulty 在中文站也建议交叉验证。
export const STUDY_PLAN_DETAIL = `
query studyPlanV2Detail($planSlug: String!) {
  studyPlanV2Detail(planSlug: $planSlug) {
    name
    slug
    description
    planSubGroups {
      slug
      name
      questions { titleSlug title translatedTitle difficulty }
    }
  }
}
`;

// ---------------------------------------------------------------------------
// 以下三个是从站点前端 chunk 挖出来的官方「学习计划广场」接口。
// 关键价值：**不需要登录**。所以即便没绑 Cookie，也能让用户看到全部计划并同步题库，
// 只是拿不到「我加入了哪些」和「我的进度」。
// ---------------------------------------------------------------------------

/** 计划分类（精选 / 面试 / 算法…）以及每个分类下的推荐计划 slug */
export const STUDY_PLAN_CATALOGS = `
query GetStudyPlanCatalogs {
  studyPlanV2Catalogs {
    name
    slug
    recommendedStudyPlans
  }
}
`;

/** 按分类翻页取计划列表（带题数、难度、是否 Plus 专属） */
export const STUDY_PLAN_BY_CATALOG = `
query GetStudyPlanByCatalog($catalogSlug: String!, $offset: Int!, $limit: Int!) {
  studyPlansV2ByCatalog(catalogSlug: $catalogSlug, offset: $offset, limit: $limit) {
    hasMore
    total
    studyPlans {
      slug
      name
      questionNum
      premiumOnly
      onGoing
      highlight
      cover
    }
  }
}
`;

/** 首页广告位计划（也是全量计划的一个补充来源） */
export const STUDY_PLAN_ADS = `
query GetStudyPlanListAds {
  studyPlansV2AdFeature {
    slug
    name
    questionNum
    premiumOnly
    onGoing
    highlight
    cover
  }
}
`;

// 全站刷题状态（一次请求拿全量 ac/notac/null）
export const ALL_QUESTIONS_BETA = `
query allQuestionsBeta {
  allQuestionsBeta { questionId status }
}
`;

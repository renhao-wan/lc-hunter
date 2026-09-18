import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, DB_PATH } from './config.js';

let _db = null;

export function getDb() {
  if (_db) return _db;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  _db = new DatabaseSync(DB_PATH);
  _db.exec('PRAGMA journal_mode = WAL;');
  migrate(_db);
  return _db;
}

export function closeDb() {
  if (_db) {
    _db.close();
    _db = null;
  }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS problems (
  slug            TEXT PRIMARY KEY,
  question_id     TEXT,
  frontend_id     TEXT,
  title_en        TEXT,
  title_cn        TEXT,
  difficulty      TEXT,
  paid_only       INTEGER DEFAULT 0,
  tags            TEXT,
  content_md      TEXT,
  code_snippets   TEXT,
  meta_data       TEXT,
  sample_testcase TEXT,
  example_testcases TEXT,
  acm_source      TEXT DEFAULT 'none',
  kama_pid        TEXT,
  kama_input_desc TEXT,
  kama_output_desc TEXT,
  detail_fetched  INTEGER DEFAULT 0,
  fetched_at      INTEGER
);

CREATE TABLE IF NOT EXISTS plans (
  slug       TEXT PRIMARY KEY,
  name       TEXT,
  source     TEXT DEFAULT 'official',
  question_num INTEGER,
  fetched_at INTEGER
);

CREATE TABLE IF NOT EXISTS plan_problems (
  plan_slug    TEXT NOT NULL,
  problem_slug TEXT NOT NULL,
  group_name   TEXT,
  ord          INTEGER DEFAULT 0,
  PRIMARY KEY (plan_slug, problem_slug)
);

CREATE TABLE IF NOT EXISTS progress (
  slug           TEXT PRIMARY KEY,
  lc_status      TEXT,
  last_synced    INTEGER,
  last_ac_at     INTEGER,
  local_ac_count INTEGER DEFAULT 0,
  local_run_count INTEGER DEFAULT 0,
  last_drawn_at  INTEGER,
  draw_count     INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS reviews (
  slug          TEXT PRIMARY KEY,
  easiness      REAL DEFAULT 2.5,
  interval_days REAL DEFAULT 0,
  repetitions   INTEGER DEFAULT 0,
  due_date      TEXT,
  last_reviewed TEXT
);

CREATE TABLE IF NOT EXISTS attempts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  slug       TEXT NOT NULL,
  mode       TEXT,
  passed     INTEGER DEFAULT 0,
  total      INTEGER DEFAULT 0,
  created_at INTEGER
);

CREATE TABLE IF NOT EXISTS kama_problems (
  pid        TEXT PRIMARY KEY,
  title      TEXT,
  url        TEXT,
  fetched_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_plan_problems_plan ON plan_problems(plan_slug);
CREATE INDEX IF NOT EXISTS idx_reviews_due ON reviews(due_date);
CREATE INDEX IF NOT EXISTS idx_attempts_slug ON attempts(slug);
`;

function migrate(db) {
  db.exec(SCHEMA);
  // 旧库升级：缺的列补上
  const cols = new Set(db.prepare('PRAGMA table_info(problems)').all().map((c) => c.name));
  const addCol = (name, ddl) => {
    if (!cols.has(name)) db.exec(`ALTER TABLE problems ADD COLUMN ${name} ${ddl}`);
  };
  addCol('kama_input_example', 'TEXT');
  addCol('kama_output_example', 'TEXT');

  // plans 表也一样：question_num 是后加的，老库要补
  const pcols = new Set(db.prepare('PRAGMA table_info(plans)').all().map((c) => c.name));
  if (!pcols.has('question_num')) db.exec('ALTER TABLE plans ADD COLUMN question_num INTEGER');
}

// ---------- problems ----------
export function upsertProblem(p) {
  const db = getDb();
  db.prepare(`
    INSERT INTO problems
      (slug, question_id, frontend_id, title_en, title_cn, difficulty, paid_only, tags, fetched_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(slug) DO UPDATE SET
      question_id = COALESCE(excluded.question_id, question_id),
      frontend_id = COALESCE(excluded.frontend_id, frontend_id),
      title_en    = COALESCE(excluded.title_en, title_en),
      title_cn    = COALESCE(excluded.title_cn, title_cn),
      difficulty  = COALESCE(excluded.difficulty, difficulty),
      paid_only   = excluded.paid_only,
      tags        = COALESCE(excluded.tags, tags),
      fetched_at  = excluded.fetched_at
  `).run(
    p.slug,
    p.questionId ?? null,
    p.frontendId ?? null,
    p.titleEn ?? null,
    p.titleCn ?? null,
    p.difficulty ?? null,
    p.paidOnly ? 1 : 0,
    p.tags ? JSON.stringify(p.tags) : null,
    Date.now(),
  );
}

/*
 * 单题查询。
 *
 * 必须 JOIN progress —— 这里曾经是 `SELECT * FROM problems`，而 problems 表里
 * 根本没有 lc_status / local_ac_count / local_run_count，于是调用方拿到的行
 * 三个字段全是 undefined，effectiveStatus() 恒判 'new'。
 *
 * 后果很隐蔽：左栏列表走 getBrowseRows（有 JOIN，状态是对的），点开同一道题
 * 的详情面板却永远显示「没做过」。实测 two-sum 本地 AC 十几次，列表标「已通过」，
 * 详情写「没做过」，看起来像随机 bug。
 *
 * 回归用例：test/_verify-detail-status.js
 *
 * reviews 一起 JOIN，是因为 rowToProblem 会读 row.due_date。
 */
export function getProblem(slug) {
  return (
    getDb()
      .prepare(
        `SELECT pr.*,
                pg.lc_status, ${PROGRESS_STATUS_COLS}, pg.last_drawn_at, pg.draw_count,
                rv.due_date, rv.repetitions, rv.easiness
           FROM problems pr
           LEFT JOIN progress pg ON pg.slug = pr.slug
           LEFT JOIN reviews  rv ON rv.slug = pr.slug
          WHERE pr.slug = ?`,
      )
      .get(slug) || null
  );
}

/*
 * ================== 「做过了」的唯一判定口径 ==================
 *
 * 一道题做没做过，有**两个来源**，缺一不可：
 *
 *   1. pg.lc_status   —— 从力扣同步来的（要登录才能拉），值是 'ac' / 'notac'
 *   2. pg.local_ac_count / pg.local_run_count
 *                     —— 你在这个工具里自己跑出来的记录
 *
 * 只认第一个会出大问题：本地跑通 10 次的题，lc_status 可能还是 NULL
 * （没同步过），于是「已通过」筛不出来、「还没做过的」又把做过的题再推给你。
 * 实测踩过：two-sum 本地 AC 了 14 次，界面上仍显示「未做」。
 *
 * 所以统一成三个互斥且穷尽的分类，全部查询都用下面这几个常量/函数：
 *   ac    （已通过）  = 力扣标了 ac，或本地跑通过至少一次
 *   new   （没做过）  = 两个来源都没有任何记录
 *   notac （做过没过）= 剩下的情况（跑过但没全过，或力扣标了 notac）
 *
 * 注意每个谓词都包了 COALESCE，保证结果是严格的 TRUE/FALSE 而不是 NULL ——
 * 否则 `NOT 谓词` 会算出 NULL，行会被静默丢掉，notac 就永远筛不出来。
 */
const SQL_IS_AC =
  "(COALESCE(pg.lc_status, '') = 'ac' OR COALESCE(pg.local_ac_count, 0) > 0)";
const SQL_IS_NEW =
  "(COALESCE(pg.lc_status, '') IN ('', 'not_started') AND COALESCE(pg.local_run_count, 0) = 0)";
const SQL_IS_NOTAC = `(NOT ${SQL_IS_AC} AND NOT ${SQL_IS_NEW})`;

/** 上面 SQL 的 JS 版本，口径必须与之一致（抽题引擎和接口层用它） */
export function effectiveStatus(row) {
  const lc = row.lc_status == null ? '' : String(row.lc_status);
  const localAc = row.local_ac_count || 0;
  const localRun = row.local_run_count || 0;
  if (lc === 'ac' || localAc > 0) return 'ac';
  if ((lc === '' || lc === 'not_started') && localRun === 0) return 'new';
  return 'notac';
}

/** 每个查询都要带上这两列，否则 effectiveStatus 算不出来 */
const PROGRESS_STATUS_COLS = 'pg.local_ac_count, pg.local_run_count';

export function updateProblemDetail(slug, d) {
  getDb()
    .prepare(`
      UPDATE problems SET
        content_md = ?, code_snippets = ?, meta_data = ?,
        sample_testcase = ?, example_testcases = ?,
        difficulty = COALESCE(?, difficulty),
        title_cn = COALESCE(?, title_cn),
        detail_fetched = 1, fetched_at = ?
      WHERE slug = ?
    `)
    .run(
      d.contentMd ?? null,
      d.codeSnippets ? JSON.stringify(d.codeSnippets) : null,
      d.metaData ? JSON.stringify(d.metaData) : null,
      d.sampleTestCase ?? null,
      d.exampleTestcases ?? null,
      d.difficulty ?? null,
      d.titleCn ?? null,
      Date.now(),
      slug,
    );
}

export function updateAcmSource(slug, { source, kamaPid, inputDesc, outputDesc, inputExample, outputExample }) {
  getDb()
    .prepare(
      `UPDATE problems SET acm_source = ?, kama_pid = ?, kama_input_desc = ?, kama_output_desc = ?,
        kama_input_example = ?, kama_output_example = ? WHERE slug = ?`,
    )
    .run(
      source,
      kamaPid ?? null,
      inputDesc ?? null,
      outputDesc ?? null,
      inputExample ?? null,
      outputExample ?? null,
      slug,
    );
}

/** 全库题目行（抽题时不限制题单用），字段与 getPlanProblems 对齐 */
export function getAllProblemRows() {
  return getDb()
    .prepare(
      // meta_data 要带上：卡码网匹配后的 IO 结构校验需要参数表
      `SELECT pr.slug AS slug, NULL AS grp, 0 AS ord,
              pr.frontend_id, pr.title_cn, pr.title_en, pr.difficulty, pr.paid_only,
              pr.meta_data, pr.sample_testcase,
              pg.lc_status, ${PROGRESS_STATUS_COLS}, pg.last_drawn_at, pg.draw_count,
              rv.due_date, rv.repetitions, rv.easiness
       FROM problems pr
       LEFT JOIN progress pg ON pg.slug = pr.slug
       LEFT JOIN reviews  rv ON rv.slug = pr.slug
       ORDER BY CAST(pr.frontend_id AS INTEGER)`,
    )
    .all();
}

/**
 * 左栏浏览用：把题目连同它所属的计划名一起查出来。
 *
 * 和 getPlanProblems 的区别是「一条题可能同时属于多个计划，这里只取一个主计划」——
 * 左栏是按计划分组的，同一道题在两个组里各出现一次会让人以为题库有重复。
 *
 * 优先级：**当前选中的计划排最前**，其次我加入的计划，再次内置精选。
 * 选中计划必须排第一，否则会出现"我选了面试经典 150 题，
 * 下面却冒出 67 道「LeetCode 热题 100」"这种看起来像串数据的情况。
 */
export function getBrowseRows({ planSlug = null, mode = null, keyword = null, limit = 2000 } = {}) {
  const db = getDb();
  const where = [];
  const args = [];

  if (planSlug) {
    where.push('pr.slug IN (SELECT problem_slug FROM plan_problems WHERE plan_slug = ?)');
    args.push(planSlug);
  }
  if (keyword) {
    where.push('(pr.title_cn LIKE ? OR pr.title_en LIKE ? OR pr.slug LIKE ?)');
    const like = `%${keyword}%`;
    args.push(like, like, like);
  }
  // 状态筛选走统一口径（见文件上方 SQL_IS_AC / SQL_IS_NEW 的说明）——
  // 只认 lc_status 的话，本地已经跑通的题会被当成"没做过"
  if (mode === 'ac') where.push(SQL_IS_AC);
  else if (mode === 'notac') where.push(SQL_IS_NOTAC);
  else if (mode === 'new') where.push(SQL_IS_NEW);
  // 「做过的」= 不是没做过的，包含了「已通过」和「做过没过」两种
  else if (mode === 'done') where.push(`(NOT ${SQL_IS_NEW})`);
  else if (mode === 'due') where.push("rv.due_date IS NOT NULL AND rv.due_date <= date('now')");

  // 选定计划的优先级：命中当前 planSlug 的排 0，然后是"我加入的"，最后是其它
  const orderExpr = planSlug
    ? "CASE WHEN pp.plan_slug = ? THEN 0 WHEN p.source = 'mine' THEN 1 ELSE 2 END"
    : "CASE WHEN p.source = 'mine' THEN 0 ELSE 1 END";

  const sql = `
    SELECT pr.slug AS slug,
           pr.frontend_id, pr.title_cn, pr.title_en, pr.difficulty, pr.paid_only,
           pg.lc_status, ${PROGRESS_STATUS_COLS}, rv.due_date,
           (SELECT p.name FROM plan_problems pp
              JOIN plans p ON p.slug = pp.plan_slug
             WHERE pp.problem_slug = pr.slug
             ORDER BY ${orderExpr}, pp.plan_slug
             LIMIT 1) AS plan_name
    FROM problems pr
    LEFT JOIN progress pg ON pg.slug = pr.slug
    LEFT JOIN reviews  rv ON rv.slug = pr.slug
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY CAST(pr.frontend_id AS INTEGER)
    LIMIT ?`;

  const orderArgs = planSlug ? [planSlug] : [];
  args.push(limit);
  return db.prepare(sql).all(...orderArgs, ...args);
}

/**
 * 每个计划在四种抽题模式下的可用题数 —— 「从哪抽题」下拉里括号的数字靠它。
 *
 * 下拉里每个计划的括号必须跟着「抽什么样的」变（选「还没做过的」就该显示剩余新题数），
 * 否则用户会以为模式切换没生效。一条 SQL 把全部计划 × 四种模式一次算出来，
 * 避免为每个计划各发一次请求（计划有几十个，那样会很慢）。
 *
 * 「全部题目」那一项不在这里 —— 它没有 plan 过滤，用 browseCounts() 单独算。
 */
export function planModeCounts() {
  return getDb()
    .prepare(
      `SELECT pp.plan_slug AS slug,
              COUNT(*) AS total,
              SUM(CASE WHEN ${SQL_IS_AC} THEN 1 ELSE 0 END) AS ac,
              SUM(CASE WHEN ${SQL_IS_NEW} THEN 1 ELSE 0 END) AS fresh,
              SUM(CASE WHEN rv.due_date IS NOT NULL AND rv.due_date <= date('now') THEN 1 ELSE 0 END) AS due
       FROM plan_problems pp
       JOIN problems pr ON pr.slug = pp.problem_slug
       LEFT JOIN progress pg ON pg.slug = pr.slug
       LEFT JOIN reviews  rv ON rv.slug = pr.slug
       GROUP BY pp.plan_slug`,
    )
    .all()
    .map((r) => ({
      slug: r.slug,
      counts: {
        all: r.total || 0,
        new: r.fresh || 0,
        ac: r.ac || 0,
        // 「做过的」= 总数 - 没做过的，不必再查一次
        done: (r.total || 0) - (r.fresh || 0),
        due: r.due || 0,
      },
    }));
}

/** 当前条件下每个分类各有多少题 —— 操作条上括号里的数字靠它 */
export function browseCounts({ planSlug = null, keyword = null } = {}) {
  const db = getDb();
  const scope = [];
  const args = [];
  if (planSlug) {
    scope.push('pr.slug IN (SELECT problem_slug FROM plan_problems WHERE plan_slug = ?)');
    args.push(planSlug);
  }
  if (keyword) {
    scope.push('(pr.title_cn LIKE ? OR pr.title_en LIKE ? OR pr.slug LIKE ?)');
    const like = `%${keyword}%`;
    args.push(like, like, like);
  }
  const scopeSql = scope.length ? 'WHERE ' + scope.join(' AND ') : '';
  const row = db
    .prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN ${SQL_IS_AC} THEN 1 ELSE 0 END) AS ac,
              SUM(CASE WHEN ${SQL_IS_NOTAC} THEN 1 ELSE 0 END) AS notac,
              SUM(CASE WHEN ${SQL_IS_NEW} THEN 1 ELSE 0 END) AS fresh,
              SUM(CASE WHEN rv.due_date IS NOT NULL AND rv.due_date <= date('now') THEN 1 ELSE 0 END) AS due
       FROM problems pr
       LEFT JOIN progress pg ON pg.slug = pr.slug
       LEFT JOIN reviews  rv ON rv.slug = pr.slug
       ${scopeSql}`,
    )
    .get(...args);
  return {
    total: row.total || 0,
    all: row.total || 0,
    ac: row.ac || 0,
    notac: row.notac || 0,
    new: row.fresh || 0,
    done: (row.ac || 0) + (row.notac || 0),
    due: row.due || 0,
  };
}

/** 今天（含）到期需要复习的题 */
export function listDue(limit = 50) {
  return getDb()
    .prepare(
      `SELECT r.slug, r.due_date, r.repetitions, r.easiness,
              pr.frontend_id, pr.title_cn, pr.title_en
       FROM reviews r LEFT JOIN problems pr ON pr.slug = r.slug
       WHERE r.due_date IS NOT NULL AND r.due_date <= date('now')
       ORDER BY r.due_date LIMIT ?`,
    )
    .all(limit);
}

// ---------- plans ----------
export function upsertPlan(plan) {
  getDb()
    .prepare(
      `INSERT INTO plans (slug, name, source, question_num, fetched_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(slug) DO UPDATE SET
         name = COALESCE(excluded.name, name),
         -- source 只在有意义时升级：mine（我加入的）优先于 official
         source = CASE
           WHEN excluded.source = 'mine' THEN 'mine'
           WHEN plans.source = 'mine' THEN 'mine'
           ELSE excluded.source END,
         question_num = COALESCE(excluded.question_num, question_num),
         fetched_at = excluded.fetched_at`,
    )
    .run(
      plan.slug,
      plan.name ?? plan.slug,
      plan.source ?? 'official',
      plan.questionNum ?? null,
      Date.now(),
    );
}

export function listPlans({ source = null } = {}) {
  const where = source ? 'WHERE p.source = ?' : '';
  const sql = `SELECT p.slug, p.name, p.source, p.question_num,
              COUNT(pp.problem_slug) AS total,
              SUM(CASE WHEN ${SQL_IS_AC} THEN 1 ELSE 0 END) AS ac
       FROM plans p
       LEFT JOIN plan_problems pp ON pp.plan_slug = p.slug
       LEFT JOIN progress pg ON pg.slug = pp.problem_slug
       ${where}
       GROUP BY p.slug
       ORDER BY CASE p.source WHEN 'mine' THEN 0 ELSE 1 END, p.slug`;
  const stmt = getDb().prepare(sql);
  return source ? stmt.all(source) : stmt.all();
}

export function getPlan(slug) {
  return getDb().prepare('SELECT * FROM plans WHERE slug = ?').get(slug) || null;
}

/** 抽题时用来把"非 Java 计划"的题过滤掉（SQL/Pandas/JS 专项计划） */
export function planProblemSlugs(planSlug) {
  return getDb()
    .prepare('SELECT problem_slug AS slug FROM plan_problems WHERE plan_slug = ?')
    .all(planSlug)
    .map((r) => r.slug);
}

/** 反查：这道题出现在哪些计划里（界面上显示"属于哪个计划"用） */
export function plansOfProblem(problemSlug) {
  return getDb()
    .prepare(
      `SELECT pp.plan_slug AS slug, p.name, pp.group_name AS grp
       FROM plan_problems pp
       LEFT JOIN plans p ON p.slug = pp.plan_slug
       WHERE pp.problem_slug = ?
       ORDER BY CASE p.source WHEN 'mine' THEN 0 ELSE 1 END, pp.plan_slug`,
    )
    .all(problemSlug);
}

export function replacePlanProblems(planSlug, items) {
  const db = getDb();
  db.prepare('DELETE FROM plan_problems WHERE plan_slug = ?').run(planSlug);
  const stmt = db.prepare(
    'INSERT OR IGNORE INTO plan_problems (plan_slug, problem_slug, group_name, ord) VALUES (?, ?, ?, ?)',
  );
  items.forEach((it, i) => stmt.run(planSlug, it.slug, it.group ?? null, it.ord ?? i));
}

/**
 * 计划里的题目行。
 *
 * 用 INNER JOIN problems 而不是 LEFT JOIN：problem_slug 只是占位时，
 * problems 表里一定有对应行（syncPlanDetail 里 upsert 过）。
 * 用 LEFT JOIN 会在题目被删时返回一堆 NULL 行，抽题时看着像"有题但点不开"。
 */
export function getPlanProblems(planSlug) {
  return getDb()
    .prepare(
      `SELECT pp.problem_slug AS slug, pp.group_name AS grp, pp.ord,
              pr.frontend_id, pr.title_cn, pr.title_en, pr.difficulty, pr.paid_only,
              pr.meta_data, pr.sample_testcase,
              pg.lc_status, ${PROGRESS_STATUS_COLS}, pg.last_drawn_at, pg.draw_count,
              rv.due_date, rv.repetitions, rv.easiness
       FROM plan_problems pp
       JOIN problems pr ON pr.slug = pp.problem_slug
       LEFT JOIN progress pg ON pg.slug = pp.problem_slug
       LEFT JOIN reviews  rv ON rv.slug = pp.problem_slug
       WHERE pp.plan_slug = ?
       ORDER BY pp.ord`,
    )
    .all(planSlug);
}

// ---------- 卡码网索引 ----------
export function replaceKamaIndex(items) {
  const db = getDb();
  db.exec('DELETE FROM kama_problems');
  const stmt = db.prepare('INSERT OR REPLACE INTO kama_problems (pid, title, url, fetched_at) VALUES (?, ?, ?, ?)');
  const now = Date.now();
  for (const it of items) stmt.run(String(it.pid), it.title || '', it.url || '', now);
  return items.length;
}

export function listKamaProblems() {
  return getDb().prepare('SELECT pid, title, url FROM kama_problems ORDER BY CAST(pid AS INTEGER)').all();
}

export function countKamaProblems() {
  return getDb().prepare('SELECT COUNT(*) AS n FROM kama_problems').get().n;
}

// ---------- progress ----------
export function upsertProgress(slug, { lcStatus }) {
  const db = getDb();
  db.prepare(
    `INSERT INTO progress (slug, lc_status, last_synced) VALUES (?, ?, ?)
     ON CONFLICT(slug) DO UPDATE SET lc_status = excluded.lc_status, last_synced = excluded.last_synced`,
  ).run(slug, lcStatus ?? null, Date.now());
}

/**
 * 刷题状态最后一次从力扣同步的时间（毫秒时间戳），从没同步过返回 null。
 *
 * 界面靠它显示「通过状态最后同步于 X」——不显示的话，用户看到一份几个月前的
 * 陈旧数据时无从判断，会以为是工具算错了（实际只是没同步）。
 */
export function lastStatusSyncAt() {
  const r = getDb().prepare('SELECT MAX(last_synced) AS t FROM progress').get();
  return r?.t ?? null;
}

export function markDrawn(slug) {
  getDb()
    .prepare(
      `INSERT INTO progress (slug, last_drawn_at, draw_count) VALUES (?, ?, 1)
       ON CONFLICT(slug) DO UPDATE SET last_drawn_at = excluded.last_drawn_at, draw_count = draw_count + 1`,
    )
    .run(slug, Date.now());
}

export function markLocalRun(slug, allPassed) {
  getDb()
    .prepare(
      `INSERT INTO progress (slug, local_run_count, local_ac_count) VALUES (?, 1, ?)
       ON CONFLICT(slug) DO UPDATE SET
         local_run_count = local_run_count + 1,
         local_ac_count = local_ac_count + ?`,
    )
    .run(slug, allPassed ? 1 : 0, allPassed ? 1 : 0);
}

// ---------- reviews ----------
export function getReview(slug) {
  return getDb().prepare('SELECT * FROM reviews WHERE slug = ?').get(slug) || null;
}

export function upsertReview(r) {
  getDb()
    .prepare(
      `INSERT INTO reviews (slug, easiness, interval_days, repetitions, due_date, last_reviewed)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(slug) DO UPDATE SET
         easiness = excluded.easiness, interval_days = excluded.interval_days,
         repetitions = excluded.repetitions, due_date = excluded.due_date,
         last_reviewed = excluded.last_reviewed`,
    )
    .run(r.slug, r.easiness, r.intervalDays, r.repetitions, r.dueDate, r.lastReviewed);
}

// ---------- attempts ----------
export function addAttempt({ slug, mode, passed, total }) {
  getDb()
    .prepare('INSERT INTO attempts (slug, mode, passed, total, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(slug, mode, passed, total, Date.now());
}

export function recentAttempts(limit = 10) {
  return getDb().prepare('SELECT * FROM attempts ORDER BY id DESC LIMIT ?').all(limit);
}

/** 某道题最近一次运行记录。没有记录返回 undefined。 */
export function lastAttempt(slug) {
  return getDb().prepare('SELECT * FROM attempts WHERE slug = ? ORDER BY id DESC LIMIT 1').get(slug);
}

export function stats() {
  const db = getDb();
  const one = (sql) => db.prepare(sql).get();
  return {
    problems: one('SELECT COUNT(*) AS n FROM problems').n,
    detailed: one('SELECT COUNT(*) AS n FROM problems WHERE detail_fetched = 1').n,
    plans: one('SELECT COUNT(*) AS n FROM plans').n,
    // 复用同一套谓词（把表别名写成 pg 即可），避免顶栏的数字和列表筛出来的对不上
    ac: one(`SELECT COUNT(*) AS n FROM progress pg WHERE ${SQL_IS_AC}`).n,
    notac: one(`SELECT COUNT(*) AS n FROM progress pg WHERE ${SQL_IS_NOTAC}`).n,
    due: one("SELECT COUNT(*) AS n FROM reviews WHERE due_date IS NOT NULL AND due_date <= date('now')").n,
    attempts: one('SELECT COUNT(*) AS n FROM attempts').n,
  };
}

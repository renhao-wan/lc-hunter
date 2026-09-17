#!/usr/bin/env node
/**
 * lc-hunter CLI —— 力扣刷题辅助工具的内核。
 *
 * 典型流程：
 *   lc bind        绑定力扣账号（弹出浏览器登录，全自动）
 *   lc sync        同步题目目录 / 刷题状态 / 学习计划
 *   lc plans       看看有哪些题单
 *   lc draw --plan xxx -n 1 --gen   抽 1 题并生成工作区
 *   lc run         编译 + 跑样例对拍
 *   lc review 3    记一次复习结果（0-5），自动排下次复习时间
 */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

import * as cfgm from './config.js';
import * as db from './db.js';
import { getProfile, listSupportedLanguages } from './lang/index.js';
import { LeetCodeClient } from './leetcode/client.js';
import * as sync from './engine/sync.js';
import * as draw from './engine/draw.js';
import { generateWorkspace, hydrateProblem, problemDir, loadWorkspaceMeta } from './engine/generate.js';
import { runWorkspace } from './engine/runner.js';
import { fetchKamaProblem, fetchAllProblems } from './kama/index.js';
import { findCandidates, pickAuto } from './kama/match.js';
import { checkIoCompat, formatIoCheck } from './kama/verify.js';

// ---------------- 基础工具 ----------------
// 颜色一律用 \u001b 转义，不要写裸 ESC 控制字符：
// 裸控制字符会让部分写入端把文件当二进制、退化成 GBK 编码，中文会变乱码。

const C = {
  reset: '\u001b[0m',
  dim: '\u001b[2m',
  bold: '\u001b[1m',
  red: '\u001b[31m',
  green: '\u001b[32m',
  yellow: '\u001b[33m',
  blue: '\u001b[34m',
  cyan: '\u001b[36m',
};

function log(...a) {
  console.log(...a);
}
function ok(...a) {
  console.log(C.green + '✓' + C.reset, ...a);
}
function warn(...a) {
  console.log(C.yellow + '!' + C.reset, ...a);
}
function err(...a) {
  console.log(C.red + '✗' + C.reset, ...a);
}
function head(t) {
  console.log(C.bold + C.cyan + t + C.reset);
}

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const eq = key.indexOf('=');
      if (eq >= 0) {
        flags[key.slice(0, eq)] = key.slice(eq + 1);
      } else if (i + 1 < argv.length && !argv[i + 1].startsWith('-')) {
        flags[key] = argv[i + 1];
        i++;
      } else {
        flags[key] = true;
      }
    } else if (a.startsWith('-') && a.length > 1) {
      // 短参数（-n 2）也要吃掉后面的值
      const key = a.slice(1);
      if (i + 1 < argv.length && !argv[i + 1].startsWith('-')) {
        flags[key] = argv[i + 1];
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

function ask(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve((answer || '').trim());
    });
  });
}

function requireCreds() {
  const creds = cfgm.loadCredentials();
  if (!creds || !creds.LEETCODE_SESSION) {
    throw new Error('还没有绑定账号。请先执行：lc bind');
  }
  return creds;
}

/** 支持用 slug 或题号定位题目 */
function resolveSlug(input) {
  if (!input) return null;
  const direct = db.getProblem(input);
  if (direct) return direct.slug;
  const byId = db
    .getDb()
    .prepare('SELECT slug FROM problems WHERE frontend_id = ? OR question_id = ?')
    .get(String(input), String(input));
  if (byId) return byId.slug;
  return input; // 可能是还没入库的 slug，交给调用方去 fetch
}

function loadHydrated(slug) {
  const row = db.getProblem(slug);
  if (!row) return null;
  return hydrateProblem(row);
}

const DIFF_CN = { EASY: '简单', MEDIUM: '中等', HARD: '困难' };
function diffCn(d) {
  return DIFF_CN[String(d || '').toUpperCase()] || d || '-';
}

function statusCn(s) {
  if (s === 'ac') return C.green + 'AC' + C.reset;
  if (s === 'notac') return C.yellow + '未AC' + C.reset;
  return C.dim + '未做' + C.reset;
}

// ---------------- 命令 ----------------

async function cmdDoctor() {
  head('环境检查');
  const cfg = cfgm.ensureDirs();
  log(`  Node        ${process.version}`);
  log(`  项目目录    ${cfgm.PROJECT_ROOT}`);
  log(`  数据目录    ${cfgm.DATA_DIR}`);
  log(`  工作区      ${cfgm.resolveWorkspace(cfg)}`);
  log(`  站点        ${cfg.site}`);
  log(`  语言        ${cfg.lang}（已支持: ${listSupportedLanguages().join(', ')}）`);

  const profile = await getProfile(cfg.lang);
  const det = await profile.detect(cfg);
  if (det.ok) ok(`工具链 ${profile.displayName}: ${det.version}`);
  else err(`工具链 ${profile.displayName}: ${det.hint}`);

  const creds = cfgm.loadCredentials();
  if (creds?.LEETCODE_SESSION) {
    try {
      const client = new LeetCodeClient({ site: cfg.site, creds, intervalMs: cfg.requestIntervalMs });
      const me = await client.userStatus();
      if (me?.isSignedIn) ok(`已登录：${me.username || me.userSlug || '(匿名)'}`);
      else err('登录已失效，请重新运行：lc bind');
    } catch (e) {
      err(`账号检查失败：${e.message}`);
    }
  } else {
    warn('还没绑定力扣账号。公开题目仍可拉取，但刷题状态和学习计划需要登录。');
  }

  const s = db.stats();
  log('');
  head('本地数据');
  log(
    `  题目 ${s.problems}（已拉详情 ${s.detailed}）　题单 ${s.plans}　AC ${s.ac}　未AC ${s.notac}　待复习 ${s.due}　运行记录 ${s.attempts}`,
  );
}

/**
 * 绑定力扣账号。
 *
 * 只有一条路径：打开浏览器让用户正常登录，我们自动抓 Cookie。
 * 不再支持 `lc bind --session <值>` 这种粘贴方式 —— 让用户去开发者工具里
 * 翻 Cookie 既劝退又容易出错（漏掉 HttpOnly 的那条、或复制到过期的值），
 * 而且失败时的表现是"提示成功但状态仍是未登录"，比直接报错更难查。
 *
 * 注意这里没有 headless 选项：绑定需要用户在弹出的窗口里扫码或输密码，
 * 无头模式根本没法完成登录（这正是"自动绑定"和"自动测试"的区别）。
 */
async function cmdBind({ flags }) {
  const cfg = cfgm.ensureDirs();
  const { browserReport, loginAndCapture } = await import('./leetcode/browser.js');

  const rep = browserReport();
  if (!rep.ok) {
    err('没找到可用的浏览器');
    log(C.dim + '  ' + rep.hint + C.reset);
    return;
  }

  log(`将打开 ${rep.name}，请在窗口里登录力扣（扫码或账号密码都行）。`);
  log(C.dim + '  登录成功后会自动完成绑定，然后关掉那个窗口。' + C.reset);

  let creds;
  try {
    creds = await loginAndCapture({
      site: cfg.site,
      onStatus: (m) => log(C.dim + '  ' + m + C.reset),
    });
  } catch (e) {
    err(e.message);
    return;
  }

  cfgm.saveCredentials(creds);

  // 存完立刻验一次 —— 只回"绑定成功"但实际没登上，是最容易让人困惑的体验
  const client = new LeetCodeClient({ site: cfg.site, creds, intervalMs: cfg.requestIntervalMs });
  try {
    const me = await client.userStatus();
    if (me?.isSignedIn) ok(`绑定成功：${me.username || me.userSlug}${me.isPremium ? '（会员）' : ''}`);
    else warn('登录态已保存，但站点返回未登录（可能登录没走完）。重新运行 lc bind 再试一次。');
  } catch (e) {
    warn(`登录态已保存，但验证请求失败：${e.message}`);
  }
}

async function cmdWhoami() {
  const cfg = cfgm.ensureDirs();
  const creds = requireCreds();
  const client = new LeetCodeClient({ site: cfg.site, creds, intervalMs: cfg.requestIntervalMs });
  const me = await client.userStatus();
  if (!me?.isSignedIn) {
    err('未登录，登录态可能已过期，重新运行 lc bind 即可');
    return;
  }
  ok(`${me.username || me.userSlug}${me.realName ? `（${me.realName}）` : ''}${me.isPremium ? ' [会员]' : ''}`);
}

async function cmdSync({ flags }) {
  const cfg = cfgm.ensureDirs();
  const creds = cfgm.loadCredentials();

  const onlyCatalog = !!flags.catalog;
  const planArg = flags.plan ? String(flags.plan).split(',').filter(Boolean) : null;
  const detailLimit = flags.details ? Number(flags.details) : 0;

  if (flags.catalog || !planArg) {
    head('同步题目目录');
    try {
      const r = await sync.syncCatalog({ cfg, creds, onLog: (m) => log(C.dim + m + C.reset) });
      ok(`题目 ${r.total} 条，其中 ${r.statusCount} 条有刷题状态`);
    } catch (e) {
      err(`目录同步失败：${e.message}`);
    }
  }

  if (!onlyCatalog) {
    head('同步学习计划');
    const mine = !!flags.mine;
    if (mine && !creds?.LEETCODE_SESSION) {
      warn('--mine 需要先绑定账号，请运行 lc bind。这次改同步内置精选清单。');
    }
    if (!planArg && !mine) {
      log(
        C.dim +
          '  默认同步内置精选计划（免登录）。想只同步你自己加入的用 --mine，' +
          '想同步指定计划用 --plan <slug>。' +
          C.reset,
      );
    }
    try {
      const plans = await sync.syncPlans({
        cfg,
        creds,
        only: planArg,
        mine: mine && !!creds?.LEETCODE_SESSION,
        onLog: (m) => log('  ' + m),
      });
      const good = plans.filter((p) => p.count > 0);
      const empty = plans.filter((p) => p.count === 0);
      for (const p of good) {
        ok(`${p.name}（${p.slug}）—— ${p.count} 题${p.mine ? ' [我加入的]' : ''}`);
      }
      for (const p of empty) {
        warn(`${p.name}（${p.slug}）—— 0 题（大概率是 Plus 会员专属计划）`);
      }
    } catch (e) {
      err(e.message);
    }
  }

  if (detailLimit > 0) {
    head(`补齐题目详情（${detailLimit} 条）`);
    let slugs = [];
    if (planArg) {
      for (const p of planArg) slugs = slugs.concat(sync.pendingDetailSlugs(p));
    }
    if (slugs.length === 0) {
      slugs = db
        .getDb()
        .prepare('SELECT slug FROM problems WHERE detail_fetched = 0 ORDER BY CAST(frontend_id AS INTEGER) LIMIT ?')
        .all(detailLimit)
        .map((r) => r.slug);
    } else {
      slugs = slugs.slice(0, detailLimit);
    }
    if (!slugs.length) {
      log('  没有需要补详情的题目');
    } else {
      const r = await sync.fetchDetailsFor(slugs, { cfg, creds, onLog: (m) => log(C.dim + m + C.reset) });
      ok(`详情入库 ${r.ok} 条，失败 ${r.fail} 条`);
    }
  }

  const s = db.stats();
  log('');
  ok(`当前库内：题目 ${s.problems}（详情 ${s.detailed}）　题单 ${s.plans}　AC ${s.ac}　未AC ${s.notac}`);
}

/**
 * 列出所有可用的学习计划（免登录）。
 * 这是"选计划 → 抽题"这条主线的入口：先让用户看见有哪些计划。
 */
async function cmdPlanList({ flags }) {
  const cfg = cfgm.ensureDirs();
  head('学习计划广场（免登录可看）');

  let plans = [];
  try {
    plans = await sync.listAllPlans({ cfg, onLog: (m) => log(C.dim + m + C.reset) });
  } catch (e) {
    err(`拉取计划列表失败：${e.message}`);
    log(C.dim + '  退回内置清单：lc plans 看已同步的' + C.reset);
    return;
  }

  const local = new Set(db.listPlans().map((p) => p.slug));
  const groups = new Map();
  for (const p of plans) {
    if (!p.drawable && !flags.all) continue;
    if (!groups.has(p.group)) groups.set(p.group, []);
    groups.get(p.group).push(p);
  }

  for (const [g, list] of groups) {
    log('');
    log(C.bold + g + C.reset);
    for (const p of list) {
      const mark = local.has(p.slug) ? C.green + '●' + C.reset : C.dim + '○' + C.reset;
      const plus = p.plusOnly ? C.yellow + ' [Plus]' + C.reset : '';
      const n = p.total != null ? `${String(p.total).padStart(3)} 题` : '  ? 题';
      log(`  ${mark} ${String(p.slug).padEnd(36)} ${n}  ${p.name}${plus}`);
    }
  }

  const drawable = plans.filter((p) => p.drawable);
  log('');
  log(C.dim + `  ● 已同步   ○ 未同步　共 ${drawable.length} 个可刷计划` + C.reset);
  log('');
  log(`  同步某个计划：${C.cyan}lc sync --plan top-100-liked${C.reset}`);
  log(`  从计划抽题：  ${C.cyan}lc draw --plan top-100-liked --gen${C.reset}`);
  log(C.dim + '  想连 SQL / Pandas / JS 计划一起看：lc plan-list --all' + C.reset);
}

async function cmdMyPlans() {
  const cfg = cfgm.ensureDirs();
  const creds = requireCreds();
  const client = new LeetCodeClient({ site: cfg.site, creds, intervalMs: cfg.requestIntervalMs });

  const me = await client.userStatus();
  if (!me?.isSignedIn) {
    err('登录已失效，请重新运行：lc bind');
    return;
  }
  head(`${me.username || me.userSlug} 的学习计划`);

  const local = new Set(db.listPlans({ source: 'mine' }).map((p) => p.slug));
  for (const [pt, label] of [
    ['ON_GOING', '进行中'],
    ['HISTORY', '历史'],
  ]) {
    let r;
    try {
      r = await client.fetchMyStudyPlans(pt);
    } catch (e) {
      err(`${label} 拉取失败：${e.message}`);
      continue;
    }
    log('');
    log(C.bold + `${label}（${r.items.length}）` + C.reset);
    if (!r.items.length) {
      log(C.dim + '  无' + C.reset);
      continue;
    }
    for (const it of r.items) {
      const mark = local.has(it.slug) ? C.green + '●' + C.reset : C.dim + '○' + C.reset;
      const prog = it.total ? `${it.finished ?? 0}/${it.total}` : '?';
      log(`  ${mark} ${String(it.slug).padEnd(34)} ${prog.padStart(9)}  ${it.name}`);
      if (it.nextQuestion) {
        log(C.dim + `      下一题：${it.nextQuestion.frontendId}. ${it.nextQuestion.title}` + C.reset);
      }
    }
  }
  log('');
  log(`  同步我加入的全部计划：${C.cyan}lc sync --mine${C.reset}`);
}

async function cmdPlans() {
  const plans = db.listPlans();
  if (!plans.length) {
    warn('本地还没有已同步的题单。');
    log('');
    log(`  看看有哪些计划：${C.cyan}lc plan-list${C.reset}　（免登录）`);
    log(`  同步精选计划：  ${C.cyan}lc sync${C.reset}`);
    return;
  }
  const cfg = cfgm.loadConfig();
  const mine = plans.filter((p) => p.source === 'mine');
  const others = plans.filter((p) => p.source !== 'mine');

  const render = (list) => {
    for (const p of list) {
      const st = draw.drawStats({ cfg, planSlug: p.slug });
      log(`  ${C.bold}${p.slug}${C.reset}  ${p.name}`);
      log(
        `    ${C.dim}共 ${st.total} 题　AC ${st.ac}　未AC ${st.notac}　未做 ${st.fresh}　待复习 ${st.due}${C.reset}`,
      );
    }
  };

  if (mine.length) {
    head('我加入的学习计划');
    render(mine);
  }
  if (others.length) {
    head(mine.length ? '其它已同步的题单' : '已同步的题单');
    render(others);
  }
  log('');
  log(`  ${C.dim}查看题单内容：lc plan <slug>　　从题单抽题：lc draw --plan <slug> --gen${C.reset}`);
  log(`  ${C.dim}看更多计划：lc plan-list${C.reset}`);
}

async function cmdPlan({ positional }) {
  const slug = positional[0];
  if (!slug) {
    err('用法：lc plan <题单slug>');
    return;
  }
  const rows = db.getPlanProblems(slug);
  if (!rows.length) {
    warn(`题单 ${slug} 没有题目（可能没同步，或 slug 不对）`);
    return;
  }
  const cfg = cfgm.loadConfig();
  const today = draw.todayStr();
  head(`题单 ${slug}（${rows.length} 题）`);
  const limit = Number(process.env.LC_PLAN_LIMIT || 40);
  rows.slice(0, limit).forEach((r) => {
    const due = r.due_date && r.due_date <= today ? C.red + ` 复习到期(${r.due_date})` + C.reset : '';
    const w = draw.computeWeight(r, cfg, { today }).weight;
    log(
      `  ${String(r.frontend_id || '').padStart(4)} ${r.title_cn || r.title_en || r.slug}  ${statusCn(
        db.effectiveStatus(r),
      )}  ${diffCn(r.difficulty)}  ${C.dim}w=${w.toFixed(2)}${C.reset}${due}`,
    );
  });
  if (rows.length > limit) log(C.dim + `  …还有 ${rows.length - limit} 题（LC_PLAN_LIMIT 可调）` + C.reset);
}

async function cmdFetch({ positional }) {
  const cfg = cfgm.ensureDirs();
  const creds = cfgm.loadCredentials();
  const input = positional[0];
  if (!input) {
    err('用法：lc fetch <slug 或 题号>');
    return;
  }
  const slug = resolveSlug(input);
  head(`拉取 ${slug}`);
  const d = await sync.fetchDetail({ cfg, creds, slug, onLog: (m) => log('  ' + m) });
  if (!d) {
    err('没拉到（题名是否正确？付费题需要会员）');
    return;
  }
  ok(`${d.frontendId}. ${d.titleCn} 已入库`);
  log(`  metaData: ${d.metaData ? JSON.stringify(d.metaData) : '(无)'}`);
  log(`  sample  : ${JSON.stringify(d.sampleTestCase)}`);
}

async function cmdDraw({ flags }) {
  const cfg = cfgm.ensureDirs();
  const planSlug = flags.plan ? String(flags.plan) : null;
  const mode = String(flags.mode || 'all');
  const count = Number(flags.n || 1);
  if (!['all', 'new', 'done', 'ac', 'due'].includes(mode)) {
    err('mode 只能是 all / new / done / ac / due');
    return;
  }

  const pool = draw.drawStats({ cfg, planSlug });
  const r = draw.draw({ cfg, planSlug, mode, count });
  if (!r.picked.length) {
    warn(`没有可抽的题目（模式=${mode}，题单=${planSlug || '全库'}）`);
    log(
      C.dim +
        `  当前池子：共 ${pool.total}　AC ${pool.ac}　未AC ${pool.notac}　未做 ${pool.fresh}　到期 ${pool.due}` +
        C.reset,
    );
    return;
  }

  head(`抽题结果（模式=${mode}${planSlug ? `，题单=${planSlug}` : ''}，候选 ${r.pool}）`);
  for (const p of r.picked) {
    log(
      `  ${C.bold}${p.frontend_id}. ${p.title_cn || p.title_en || p.slug}${C.reset}  ${diffCn(
        p.difficulty,
      )}  ${C.dim}${p.slug}${C.reset}`,
    );
    log(`    ${C.dim}${p.reasons.join(' / ')}${C.reset}`);
  }

  if (flags.gen) {
    const profile = await getProfile(cfg.lang);
    const m = String(flags.modes || 'both');
    const modes = m === 'core' ? ['core'] : m === 'acm' ? ['acm'] : ['core', 'acm'];
    log('');
    for (const p of r.picked) {
      await genOne(p.slug, { cfg, profile, modes, force: !!flags.force, resetSolution: !!flags.resetSolution });
    }
  } else {
    log('');
    log(C.dim + `  生成工作区：lc gen ${r.picked[0].slug}` + C.reset);
  }
}

async function genOne(slugInput, {
  cfg,
  profile,
  modes = ['core', 'acm'],
  force = false,
  resetSolution = false,
  autoFetch = true,
  refreshAcm = false,
}) {
  const slug = resolveSlug(slugInput);
  let q = loadHydrated(slug);
  if ((!q || !q.metaData) && autoFetch) {
    process.stdout.write(C.dim + `  拉取 ${slug} 详情… ` + C.reset);
    try {
      await sync.fetchDetail({ cfg, creds: cfgm.loadCredentials(), slug });
      q = loadHydrated(slug);
      log('完成');
    } catch (e) {
      log('失败：' + e.message);
    }
  }
  if (!q) {
    err(`本地没有 ${slug}，且拉取失败`);
    return null;
  }

  profile = profile || (await getProfile(cfg.lang));
  const res = await generateWorkspace(q, { cfg, profile, modes, force, resetSolution, refreshAcm });
  log(`  ${C.bold}${res.dir}${C.reset}`);
  log(`    ACM 等级 ${res.level}　用例 ${res.cases} 组　生成文件 ${res.written.join(', ')}`);
  res.notes.forEach((n) => log(C.dim + `    · ${n}` + C.reset));
  return res;
}

async function cmdGen({ positional, flags }) {
  const cfg = cfgm.ensureDirs();
  const input = positional[0];
  if (!input) {
    err('用法：lc gen <slug 或题号> [--mode core|acm|both] [--force]');
    return;
  }
  const m = String(flags.mode || 'both');
  const modes = m === 'core' ? ['core'] : m === 'acm' ? ['acm'] : ['core', 'acm'];
  head('生成工作区');
  await genOne(input, { cfg, modes, force: !!flags.force, resetSolution: !!flags.resetSolution });
}

async function cmdRun({ positional, flags }) {
  const cfg = cfgm.ensureDirs();
  const profile = await getProfile(cfg.lang);
  const input = positional[0];

  let dir;
  if (!input) {
    // 没给参数：用最近一次抽到的题
    const last = db.getDb().prepare('SELECT slug FROM progress ORDER BY last_drawn_at DESC LIMIT 1').get();
    if (!last) {
      err('没有最近抽到的题。用法：lc run <slug 或 工作区目录>');
      return;
    }
    const q = loadHydrated(last.slug);
    dir = q ? problemDir(q, cfg) : null;
  } else if (fs.existsSync(input) && fs.statSync(input).isDirectory()) {
    dir = path.resolve(input);
  } else {
    const q = loadHydrated(resolveSlug(input));
    dir = q ? problemDir(q, cfg) : null;
  }

  if (!dir || !fs.existsSync(dir)) {
    err(`工作区不存在：${dir || input}。先执行 lc gen <题目>`);
    return;
  }

  head(`运行 ${path.basename(dir)}`);
  const t0 = Date.now();
  const r = await runWorkspace(dir, { cfg, profile, timeoutMs: Number(flags.timeout || 10000) });
  const ms = Date.now() - t0;

  if (!r.ok) {
    err(r.error || '编译失败');
    if (r.build) {
      if (r.build.stdout) log(r.build.stdout.trim());
      if (r.build.stderr) log(C.red + r.build.stderr.trim() + C.reset);
    }
    return;
  }

  for (const c of r.results) {
    const shown = c.input.replace(/\n/g, ' ⏎ ');
    if (c.pass === true) {
      ok(`用例 ${c.index} 通过 ${C.dim}(${c.ms}ms)${C.reset}`);
    } else if (c.pass === false) {
      err(`用例 ${c.index} 不通过 ${C.dim}(${c.ms}ms)${C.reset}`);
      log(`    输入   ${shown}`);
      log(`    期望   ${c.expected}`);
      log(`    实际   ${c.actual || '(空)'}`);
      if (c.stderr) log(C.red + '    ' + c.stderr.trim().split('\n').slice(0, 5).join('\n    ') + C.reset);
    } else {
      warn(`用例 ${c.index} 无期望值，仅运行 ${C.dim}(${c.ms}ms)${C.reset}`);
      log(`    输入   ${shown}`);
      log(`    输出   ${c.actual || '(空)'}`);
      if (!c.ran && c.stderr) {
        log(C.red + '    ' + c.stderr.trim().split('\n').slice(0, 5).join('\n    ') + C.reset);
      }
    }
  }

  const s = r.summary;
  log('');
  const line = `共 ${s.total}　通过 ${s.passed}　失败 ${s.failed}　无判定 ${s.pending}　${ms}ms`;
  if (s.failed === 0 && s.passed > 0) ok(line);
  else if (s.failed > 0) err(line);
  else warn(line);

  const meta = loadWorkspaceMeta(dir);
  if (meta?.slug) {
    db.addAttempt({ slug: meta.slug, mode: 'run', passed: s.passed, total: s.total });
    db.markLocalRun(meta.slug, s.failed === 0 && s.passed > 0);
  }
  return { summary: s, dir };
}

async function cmdReview({ positional, flags }) {
  const cfg = cfgm.ensureDirs();
  const input = positional[0];
  const quality = positional[1] != null ? positional[1] : flags.q;
  if (!input || quality == null) {
    err('用法：lc review <slug 或题号> <0-5>');
    log(C.dim + '  5=秒杀  4=有点卡但过了  3=勉强  <3=没做出来' + C.reset);
    return;
  }
  const slug = resolveSlug(input);
  const rec = draw.scheduleReview(slug, quality, cfg);
  ok(
    `${slug}：下次复习 ${rec.dueDate}（间隔 ${rec.intervalDays} 天，连续答对 ${rec.repetitions} 次，难度系数 ${rec.easiness}）`,
  );
}

async function cmdDue() {
  const rows = db.listDue(100);
  if (!rows.length) {
    ok('今天没有到期的复习题');
    return;
  }
  head(`待复习 ${rows.length} 题`);
  for (const r of rows) {
    log(
      `  ${String(r.frontend_id || '').padStart(4)} ${r.title_cn || r.title_en || r.slug}  ${C.dim}到期 ${r.due_date}　已复习 ${r.repetitions} 次${C.reset}`,
    );
  }
  log('');
  log(C.dim + '  从到期题里抽：lc draw --mode due -n 1' + C.reset);
}

async function cmdStats() {
  const s = db.stats();
  head('本地数据');
  log(`  题目       ${s.problems}（已拉详情 ${s.detailed}）`);
  log(`  学习计划   ${s.plans}`);
  log(`  已 AC      ${s.ac}`);
  log(`  未 AC      ${s.notac}`);
  log(`  待复习     ${s.due}`);
  log(`  运行记录   ${s.attempts}`);
  const recent = db.recentAttempts(5);
  if (recent.length) {
    log('');
    head('最近运行');
    for (const a of recent) {
      log(`  ${a.slug}  ${a.passed}/${a.total}  ${C.dim}${new Date(a.created_at).toLocaleString('zh-CN')}${C.reset}`);
    }
  }
}

async function cmdConfig({ positional }) {
  if (!positional.length) {
    log(JSON.stringify(cfgm.loadConfig(), null, 2));
    return;
  }
  const [key, ...rest] = positional;
  if (!rest.length) {
    log(JSON.stringify(cfgm.loadConfig()[key] ?? null, null, 2));
    return;
  }
  cfgm.setConfigValue(key, rest.join(' '));
  ok(`${key} = ${JSON.stringify(rest.join(' '))}`);
  log(C.dim + `  配置文件：${cfgm.CONFIG_PATH}` + C.reset);
}

async function cmdOpen({ positional }) {
  const cfg = cfgm.ensureDirs();
  const target = positional[0];
  let dir;
  if (!target) dir = cfgm.resolveWorkspace(cfg);
  else if (fs.existsSync(target)) dir = path.resolve(target);
  else {
    const q = loadHydrated(resolveSlug(target));
    dir = q ? problemDir(q, cfg) : cfgm.resolveWorkspace(cfg);
  }
  if (process.platform === 'win32') {
    spawn('explorer', [dir], { detached: true, stdio: 'ignore' }).unref();
  } else if (process.platform === 'darwin') {
    spawn('open', [dir], { detached: true, stdio: 'ignore' }).unref();
  } else {
    spawn('xdg-open', [dir], { detached: true, stdio: 'ignore' }).unref();
  }
  ok(`已打开 ${dir}`);
}

// ---------------- 卡码网映射辅助 ----------------

/** 本地索引优先；没有就现建一次 */
async function ensureKamaIndex(onLog) {
  const n = db.countKamaProblems();
  if (n > 0) {
    onLog?.(C.dim + `  用本地索引（${n} 题）。重建：lc kama --build-index` + C.reset);
    return db.listKamaProblems();
  }
  onLog?.('  本地还没有卡码网索引，先建一次（约 10 秒）…');
  const items = await fetchAllProblems({ onLog });
  db.replaceKamaIndex(items);
  onLog?.(C.dim + `  索引完成：${items.length} 题` + C.reset);
  return db.listKamaProblems();
}

/**
 * 把一道力扣题绑到某个卡码网 pid（ACM 等级升到 L1）。
 *
 * strict=true（自动匹配时）遇到 IO 结构对不上会直接拒绝；
 * strict=false（人工指定 pid 时）只警告 —— 用户点名的 pid 应该被尊重。
 */
async function bindKama(slug, pid, { cfg, force = false, gen = false, k: preFetched = null, strict = false } = {}) {
  const k = preFetched || (await fetchKamaProblem(pid));

  const row = db.getProblem(slug);
  if (row) {
    const check = checkIoCompat(hydrateProblem(row), k);
    const text = formatIoCheck(check);
    if (text) {
      log('');
      log((check.level === 'bad' ? C.yellow : C.dim) + text + C.reset);
      if (check.level === 'bad') {
        if (strict) {
          warn(`IO 结构对不上，已跳过 ${slug}（卡码网同名题很多是改造版）`);
          log(C.dim + `  确认就是要绑的话：lc kama ${k.pid} --for ${slug}` + C.reset);
          return null;
        }
        warn('仍然按你的指定绑定了；如果其实不是同一道题，用 lc kama --clear ' + slug + ' 解绑');
      }
    }
  }

  db.updateAcmSource(slug, {
    source: 'kama',
    kamaPid: k.pid,
    inputDesc: k.inputDesc,
    outputDesc: k.outputDesc,
    inputExample: k.inputExample,
    outputExample: k.outputExample,
  });
  ok(`已绑定 ${slug} ← 卡码网 pid=${k.pid}「${k.title}」（ACM 等级 L1）`);
  if (gen) {
    const profile = await getProfile(cfg.lang);
    // refreshAcm：绑定/解绑会改变 IO 规格，Main.java 必须跟着重写（旧的会备份成 .bak）
    await genOne(slug, { cfg, profile, modes: ['core', 'acm'], force, refreshAcm: true });
  } else {
    log(C.dim + `  重新生成工作区：lc gen ${slug} --force` + C.reset);
  }
  return k;
}

/** 单题自动匹配 */
async function kamaAuto(slugInput, { cfg, flags }) {
  const slug = resolveSlug(slugInput);
  const row = db.getProblem(slug);
  if (!row) {
    err(`本地没有题目 ${slug}，先执行 lc fetch ${slug}`);
    return;
  }
  const q = hydrateProblem(row);
  const title = q.title_cn || q.title_en || slug;

  const list = await ensureKamaIndex((m) => log('  ' + m));
  const cands = findCandidates(title, list, { limit: 5 });

  head(`匹配 ${q.frontend_id ? q.frontend_id + '. ' : ''}${title}`);
  if (!cands.length) {
    warn('卡码网里没找到像的题目——两边真正重合的题本来就不多');
    return;
  }
  cands.forEach((c, i) => log(`  ${i + 1}. [${c.score}]  pid=${c.pid}  ${c.title}`));

  let pick = pickAuto(cands, { threshold: Number(flags.threshold || 1) });
  if (!pick) {
    if (flags.yes) {
      warn('没有唯一的高分候选，未自动绑定。去掉 --yes 可以手动挑一个');
      return;
    }
    log('');
    const ans = await ask('输入序号绑定（直接回车取消）> ');
    if (!ans) {
      warn('已取消');
      return;
    }
    const n = Number(ans);
    if (!Number.isInteger(n) || n < 1 || n > cands.length) {
      err('序号不对');
      return;
    }
    pick = cands[n - 1];
  }
  await bindKama(slug, pick.pid, { cfg, force: !!flags.force, gen: !!flags.gen, strict: true });
}

/** 批量匹配：只绑"完全确定"的，有歧义的留给人工 */
async function kamaAutoAll({ flags, cfg, creds }) {
  const planSlug = flags.plan ? String(flags.plan) : null;
  const limit = Number(flags.limit || 0);
  let rows = planSlug ? db.getPlanProblems(planSlug) : db.getAllProblemRows();
  if (limit > 0) rows = rows.slice(0, limit);

  const list = await ensureKamaIndex((m) => log('  ' + m));
  head(`批量匹配 ${rows.length} 题${planSlug ? `（题单 ${planSlug}）` : ''}`);

  let bound = 0;
  let ambiguous = 0;
  let none = 0;
  let noDetail = 0;
  const mismatched = [];
  for (const r of rows) {
    const title = r.title_cn || r.title_en || r.slug;
    const cands = findCandidates(title, list, { limit: 3 });
    const pick = pickAuto(cands, { threshold: 1 });
    if (!pick) {
      if (cands.length) ambiguous++;
      else none++;
      continue;
    }
    try {
      const k = await fetchKamaProblem(pick.pid);
      // 没有 metaData 就没法做结构校验。候选数量很少，就地补拉一次详情，
      // 而不是"没数据就放行"——那正是同名改造题混进来的口子。
      let row = r;
      if (!r.meta_data) {
        const d = await sync.fetchDetail({ cfg, creds, slug: r.slug });
        if (d) row = db.getProblem(r.slug) || r;
      }
      if (!row.meta_data) {
        log(`  ${C.dim}-${C.reset} ${String(r.frontend_id || '').padStart(4)}. ${title}  缺详情（付费题或未登录），无法校验，跳过`);
        noDetail++;
        continue;
      }
      const check = checkIoCompat(hydrateProblem(row), k);
      if (check.level === 'bad') {
        // 标题一样但 IO 结构对不上 —— 大概率是同名改造题，绝不自动绑
        log(`  ${C.yellow}?${C.reset} ${String(r.frontend_id || '').padStart(4)}. ${title}  pid=${pick.pid} 疑似同名不同题，已跳过`);
        for (const reason of check.reasons) log(C.dim + '      ' + reason + C.reset);
        mismatched.push({ slug: r.slug, title, pid: pick.pid });
        await new Promise((res) => setTimeout(res, 400));
        continue;
      }
      db.updateAcmSource(r.slug, {
        source: 'kama',
        kamaPid: k.pid,
        inputDesc: k.inputDesc,
        outputDesc: k.outputDesc,
        inputExample: k.inputExample,
        outputExample: k.outputExample,
      });
      log(`  ${C.green}✓${C.reset} ${String(r.frontend_id || '').padStart(4)}. ${title}  ←  pid=${pick.pid} ${pick.title}`);
      bound++;
      await new Promise((res) => setTimeout(res, 700));
    } catch (e) {
      log(`  ${C.red}✗${C.reset} ${title}：${e.message}`);
    }
  }
  log('');
  ok(
    `已绑定 ${bound} 题；有歧义待人工确认 ${ambiguous}；卡码网没有 ${none}；` +
      `疑似同名不同题 ${mismatched.length}；缺详情跳过 ${noDetail}`,
  );
  if (mismatched.length) {
    log(C.dim + '  这些需要你自己看一眼，确认是同一道题再手动绑：' + C.reset);
    for (const m of mismatched) log(C.dim + `    lc kama ${m.pid} --for ${m.slug}` + C.reset);
  }
  if (ambiguous > 0) log(C.dim + '  对某题单独跑 lc kama --auto <slug> 可以手动挑候选' + C.reset);
}

async function cmdKama({ positional, flags }) {
  const cfg = cfgm.ensureDirs();

  if (flags.clear) {
    const slug = resolveSlug(String(flags.clear));
    db.updateAcmSource(slug, { source: 'none' });
    ok(`已解绑 ${slug} 的卡码网 IO（退回 ACM L2）`);
    return;
  }

  if (flags['build-index']) {
    head('构建卡码网题库索引');
    const items = await fetchAllProblems({ onLog: (m) => log('  ' + m) });
    db.replaceKamaIndex(items);
    ok(`索引完成：${items.length} 题（存在本地库 kama_problems 表）`);
    return;
  }

  if (flags.auto) {
    await kamaAuto(String(flags.auto), { cfg, flags });
    return;
  }

  if (flags.autoall) {
    const creds = cfgm.loadCredentials();
    await kamaAutoAll({ flags, cfg, creds });
    return;
  }

  const pid = positional[0];
  if (!pid) {
    err('用法：lc kama <卡码网题号pid> [--for <力扣slug或题号>] [--gen]');
    log(C.dim + '  解绑：lc kama --clear <slug>' + C.reset);
    log(C.dim + '  例：lc kama 1002 --for two-sum' + C.reset);
    log(C.dim + '  题号在卡码网题目页 URL 的 ?pid= 后面' + C.reset);
    return;
  }

  let k;
  try {
    k = await fetchKamaProblem(pid);
  } catch (e) {
    err(`抓取失败：${e.message}`);
    return;
  }

  head(`${k.title}  (pid=${k.pid})`);
  log(C.dim + '  ' + k.url + C.reset);
  if (k.desc) {
    log('');
    log(k.desc);
  }
  log('');
  log('【输入描述】');
  log(k.inputDesc || '-');
  log('');
  log('【输出描述】');
  log(k.outputDesc || '-');
  log('');
  log('【输入示例】');
  log(k.inputExample || '-');
  log('【输出示例】');
  log(k.outputExample || '-');

  if (flags.for) {
    const slug = resolveSlug(flags.for);
    if (!db.getProblem(slug)) {
      err(`本地没有题目 ${slug}，先执行 lc fetch ${slug}`);
      return;
    }
    await bindKama(slug, k.pid, { cfg, k, gen: !!flags.gen, force: !!flags.force });
    return;
  }

  log('');
  log(C.dim + `  绑定到某道力扣题：lc kama ${pid} --for <slug>` + C.reset);
}

/** 启动本地 Web 界面 */
async function cmdUi({ flags }) {
  const port = Number(flags.port || 5173);
  const { startServer } = await import('./server.js');
  const { url } = await startServer({ port });

  head('lc-hunter 本地界面');
  log(`  ${C.bold}${url}${C.reset}`);
  log(C.dim + '  只监听 127.0.0.1，Ctrl+C 退出' + C.reset);

  const open = flags.open !== false && flags['no-open'] !== true;
  if (open) {
    try {
      const { spawn } = await import('node:child_process');
      const cmd = process.platform === 'win32' ? 'explorer' : process.platform === 'darwin' ? 'open' : 'xdg-open';
      spawn(cmd, [url], { stdio: 'ignore', detached: true }).unref();
    } catch {
      /* 打不开就算了，地址已经打印出来了 */
    }
  }

  // 别让进程退出
  await new Promise(() => {});
}

function cmdHelp() {
  log(`${C.bold}lc-hunter${C.reset} —— 力扣刷题辅助（核心代码模式 + ACM 模式）

${C.bold}三步上手${C.reset}
  lc bind                       绑定力扣账号（弹出浏览器登录，全自动）
  lc plan-list                  看有哪些学习计划（免登录）
  lc sync --plan top-100-liked  把某个计划的题拉进本地
  lc draw --plan top-100-liked --gen   从该计划抽 1 题并生成工作区

${C.bold}学习计划${C.reset}   ← 主线：绑定 → 关联计划 → 抽计划里的题
  lc plan-list                  列出全部可用计划（免登录，● 表示已同步）
  lc plan-list --all            连 SQL / Pandas / JS 计划一起列
  lc my-plans                   我加入的计划 + 进度 + 下一题（需要登录）
  lc sync                       同步内置精选计划（免登录，一次拉 11 个）
  lc sync --mine                同步我加入的全部计划（需要登录）
  lc sync --plan A,B            同步指定计划（逗号分隔）
  lc plans                      我本地已同步的题单（含 AC / 到期统计）
  lc plan <slug>                查看题单内容（含权重与到期状态）

${C.bold}日常刷题${C.reset}
  lc draw --plan lcof -n 1      按权重抽 1 题
  lc draw --mode new -n 1       只抽没做过的
  lc draw --mode done -n 1      只抽做过的（含没通过的）
  lc draw --mode ac -n 1        只抽已通过的（复习）
  lc draw --mode due -n 1       只抽到期复习的
  lc draw -n 3 --gen            一次抽 3 题并生成工作区
  lc gen two-sum --force        重新生成脚手架（默认保留你的 Solution.java）
  lc run                        编译并跑样例对拍
  lc review two-sum 4           记录复习结果，自动排下次时间
  lc due                        今天该复习哪些题
  lc ui                         启动本地 Web 界面（127.0.0.1:5173）

${C.bold}ACM 权威 IO${C.reset}
  lc kama --build-index         爬一遍卡码网题库，建本地索引（映射表的基础）
  lc kama --auto two-sum        按题名自动匹配卡码网题目并绑定
  lc kama --autoall --plan X    批量匹配整个题单（只绑"完全确定"的）
  lc kama <pid>                 抓取卡码网某题的输入/输出描述与样例
  lc kama --clear <slug>        解绑卡码网 IO，退回 ACM L2
  lc kama <pid> --for two-sum   把权威 IO 绑到力扣某题，ACM 等级升到 L1

${C.bold}其它${C.reset}
  lc doctor                     环境与账号自检
  lc whoami                     当前登录的账号
  lc sync --catalog             只同步题目目录
  lc sync --details 30          顺带补 30 题的详情（题面/metaData/样例）
  lc fetch <slug|题号>          单独拉一题详情
  lc stats                      本地数据统计
  lc config [key] [value]       查看/修改配置
  lc open [slug]                在文件管理器里打开工作区

${C.bold}抽题模式${C.reset}  --mode all(默认) | new(没做过) | done(做过的) | ac(已通过复习) | due(该复习)
`);
}

// ---------------- 入口 ----------------

const COMMANDS = {
  doctor: cmdDoctor,
  bind: cmdBind,
  unbind: async () => {
    cfgm.clearCredentials();
    ok('已解绑，本地登录态已清除');
  },
  whoami: cmdWhoami,
  sync: cmdSync,
  plans: cmdPlans,
  'plan-list': cmdPlanList,
  planlist: cmdPlanList,
  'my-plans': cmdMyPlans,
  myplans: cmdMyPlans,
  plan: cmdPlan,
  fetch: cmdFetch,
  draw: cmdDraw,
  gen: cmdGen,
  run: cmdRun,
  review: cmdReview,
  due: cmdDue,
  stats: cmdStats,
  config: cmdConfig,
  open: cmdOpen,
  kama: cmdKama,
  ui: cmdUi,
  help: cmdHelp,
};

export async function main(argv = process.argv.slice(2)) {
  const { positional, flags } = parseArgs(argv);
  const name = (positional[0] || 'help').toLowerCase();
  const handler = COMMANDS[name];

  if (flags.help || flags.h) {
    cmdHelp();
    return 0;
  }
  if (!handler) {
    err(`未知命令：${name}`);
    cmdHelp();
    return 1;
  }

  try {
    await handler({ positional: positional.slice(1), flags });
    return 0;
  } catch (e) {
    err(e.message);
    if (process.env.LC_DEBUG) console.error(e);
    return 1;
  } finally {
    db.closeDb();
  }
}

// 直接执行时才跑（被 import 时不跑）
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().then((code) => process.exit(code));
}

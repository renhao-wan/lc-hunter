/**
 * 卡码网（kamacoder.com）抓取器 —— ACM 输入输出格式的权威数据源。
 *
 * 为什么需要它：力扣的 metaData 只表达"一行一个参数"，
 * 而笔试/牛客常见的"第一行 n，接下来 m 行边"这种自定义格式官方数据里根本没有。
 * 卡码网的题面是服务端渲染的纯 HTML，含完整的输入描述/输出描述/输入输出示例。
 *
 * 页面结构（实测 2026-09）：
 *   <div class="fs-4 fw-semibold mb-2"> 3. A+B问题III </div>
 *   <div class="mt-3"><h6 class="h6">题目描述</h6><div class="quote">…</div></div>
 *   <div class="mt-3"><h6 class="h6">输入描述</h6><div class="quote">…</div></div>
 *   … 输入示例 / 输出示例 用 <pre><code>…</code></pre>
 */

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const KAMA_BASE = 'https://kamacoder.com';

function kamaUrl(pid) {
  return `${KAMA_BASE}/problempage.php?pid=${encodeURIComponent(pid)}`;
}

/** 从 start 开始做 div 配对，返回配对区间内的 HTML */
function readBalancedDiv(s, start) {
  const re = /<(\/?)div\b[^>]*>/gi;
  re.lastIndex = start;
  let depth = 1;
  let m;
  while ((m = re.exec(s))) {
    depth += m[1] === '/' ? -1 : 1;
    if (depth === 0) return s.slice(start, m.index);
  }
  return s.slice(start);
}

/**
 * HTML 实体解码。
 * 跑两轮是因为卡码网存在双重转义：源码里是 `n&amp;#44; m`，
 * 第一轮把 &amp; 还原成 &，第二轮才认得出数字实体 &#44;（逗号）。
 */
function decodeEntities(s) {
  let out = String(s);
  for (let i = 0; i < 2; i++) {
    out = out
      .replace(/&#x([0-9a-f]+);/gi, (_, h) => safeCodePoint(parseInt(h, 16)))
      .replace(/&#(\d+);/g, (_, d) => safeCodePoint(Number(d)))
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&nbsp;/g, ' ')
      .replace(/&#39;/g, "'")
      .replace(/&apos;/g, "'")
      .replace(/&amp;/g, '&');
  }
  return out;
}

function safeCodePoint(n) {
  return Number.isFinite(n) && n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '';
}

/** HTML → 纯文本，保留换行 */
function htmlToText(html) {
  if (!html) return '';
  return decodeEntities(
    String(html)
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|li|h[1-6])>/gi, '\n')
      .replace(/<li[^>]*>/gi, '- ')
      .replace(/<[^>]+>/g, '')
  )
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function extractCode(html) {
  const m = /<pre[^>]*>[\s\S]*?<code[^>]*>([\s\S]*?)<\/code>[\s\S]*?<\/pre>/i.exec(html || '');
  if (m) return htmlToText(m[1]);
  // 退化：直接去掉 pre 标签
  return htmlToText((html || '').replace(/<\/?pre[^>]*>/gi, ''));
}

/**
 * 匹配紧跟在 h6 后面的内容块。
 * 坑：卡码网的块 class 不统一 —— 示例是 `<div class="quote">`，
 * 而输入/输出描述是 `<div class="quote js-md">`。早先这里写死精确串，
 * 导致描述类小节全部匹配不到、内容错位成了示例值。
 */
const QUOTE_RE = /<div class="quote[^"]*">/;

/** 解析出各个小节 */
function parseKamaPage(html) {
  const sections = {};
  const re = /<h6 class="h6">([^<]*)<\/h6>/g;
  let m;
  while ((m = re.exec(html))) {
    const title = (m[1] || '').trim();
    const rest = html.slice(m.index + m[0].length);
    const q = QUOTE_RE.exec(rest);
    if (!q) continue;
    const start = q.index + q[0].length;
    sections[title] = readBalancedDiv(rest, start);
  }

  const titleM =
    /<div class="fs-4 fw-semibold mb-2">([\s\S]*?)<\/div>/.exec(html) ||
    /<title>([\s\S]*?)<\/title>/.exec(html);

  return {
    title: titleM ? htmlToText(titleM[1]) : '',
    desc: htmlToText(sections['题目描述'] || ''),
    inputDesc: htmlToText(sections['输入描述'] || ''),
    outputDesc: htmlToText(sections['输出描述'] || ''),
    inputExample: extractCode(sections['输入示例'] || ''),
    outputExample: extractCode(sections['输出示例'] || ''),
    sections,
  };
}

// ---------------- 题库索引 ----------------

function problemsetUrl(page = 1, search = '') {
  const q = new URLSearchParams();
  if (page > 1) q.set('page', String(page));
  if (search) q.set('search', search);
  const s = q.toString();
  return `${KAMA_BASE}/problemset.php${s ? '?' + s : ''}`;
}

function parseListPage(html) {
  const items = [];
  const re = /href="problempage\.php\?pid=(\d+)"[^>]*>([\s\S]{0,160}?)<\/a>/g;
  let m;
  while ((m = re.exec(html))) {
    items.push({
      pid: m[1],
      // 标题形如 "21. 构造二叉树"，去掉前面的 "N. " 序号
      title: htmlToText(m[2]).replace(/^\d+\s*[.、]\s*/, '').trim(),
      url: kamaUrl(m[1]),
    });
  }
  // 同一 pid 会重复出现（题目链接 + 提交数链接），去重
  const seen = new Map();
  for (const it of items) if (!seen.has(it.pid)) seen.set(it.pid, it);
  return [...seen.values()];
}

function maxPageFromHtml(html) {
  const pages = [...html.matchAll(/problemset\.php\?page=(\d+)/g)].map((m) => Number(m[1]));
  return pages.length ? Math.max(...pages) : 1;
}

async function getPage(url, { timeoutMs = 15000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9' },
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 抓一页题库。返回 { items, maxPage, page }
 */
async function fetchProblemsetPage(page = 1, { search = '' } = {}) {
  const url = problemsetUrl(page, search);
  const html = await getPage(url);
  return { page, url, items: parseListPage(html), maxPage: maxPageFromHtml(html) };
}

/**
 * 建立全量题库索引。
 *
 * 坑：卡码网的题库页不是连续的 —— 实测第 5/6/7 页是空的，第 8 页又冒出 1 题。
 * 所以不能"遇到空页就停"，必须扫完整个范围，只用"连续很多页都空"当安全阀。
 */
export async function fetchAllProblems({ onLog, maxPages = 20, emptyStreakLimit = 10, intervalMs = 700 } = {}) {
  const log = onLog || (() => {});
  const all = new Map();
  let emptyStreak = 0;

  for (let page = 1; page <= maxPages; page++) {
    let r;
    try {
      r = await fetchProblemsetPage(page);
    } catch (e) {
      log(`  第 ${page} 页抓取失败：${e.message}`);
      break;
    }

    if (r.items.length === 0) {
      emptyStreak++;
      if (emptyStreak >= emptyStreakLimit) break;
    } else {
      emptyStreak = 0;
      for (const it of r.items) all.set(it.pid, it);
      log(`  第 ${page} 页：${r.items.length} 题（累计 ${all.size}）`);
    }

    await new Promise((res) => setTimeout(res, intervalMs));
  }

  return [...all.values()];
}

/** 抓取并在本地解析 */
export async function fetchKamaProblem(pid, { timeoutMs = 15000 } = {}) {
  const url = kamaUrl(pid);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9' },
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();
    if (!/输入描述/.test(html)) {
      throw new Error(`页面里没有"输入描述"，pid 可能不存在（${url}）`);
    }
    const p = parseKamaPage(html);
    return { pid: String(pid), url, ...p };
  } finally {
    clearTimeout(timer);
  }
}

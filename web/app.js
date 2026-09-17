/* lc-hunter Web UI —— 原生 JS，无框架无构建 */
'use strict';

const $ = (id) => document.getElementById(id);

const state = {
  problems: [],
  current: null,   // 当前题目的详情（含 dir/files）
  activeFile: null,
  dirty: false,
  stats: null,
  plans: null,     // /api/plans 的结果
  scope: null,     // 当前抽题范围 { slug, name } | null（全库）
  counts: null,    // 当前范围下每种模式各有多少题
  group: '',       // 当前范围的名字，显示在左栏
};

// ---------------- 基础 ----------------

async function api(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method || 'GET',
    headers: opts.body ? { 'Content-Type': 'application/json' } : undefined,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({ ok: false, error: '响应不是 JSON' }));
  if (!res.ok || data.ok === false) {
    // 卡码网绑定被拦截不算错误，交给调用方处理
    if (data.skipped) return data;
    throw new Error(data.error || `HTTP ${res.status}`);
  }
  return data;
}

let toastTimer = null;
function toast(msg, kind = '') {
  const el = $('toast');
  el.textContent = msg;
  el.className = 'toast ' + kind;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 3200);
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

const DIFF_CN = { Easy: '简单', Medium: '中等', Hard: '困难' };
// 状态词都用大白话。「AC」「未AC」是刷题圈的黑话，第一次用的人看不懂。
// 后端算好的是 ac / notac / new 三种（见 src/db.js 的 effectiveStatus）。
const STATUS_CN = { ac: '已通过', notac: '做过没过', new: '没做过' };

/**
 * 题面渲染。
 *
 * 力扣的 content 字段本身就是 HTML（<p>/<ul>/<pre>/<strong>…），
 * 所以不能整体转义——那样页面上会直接显示出一堆尖括号。
 * 做法是先按"是不是 HTML"分流，HTML 走白名单净化，markdown 走极简渲染。
 */

const ALLOWED = new Set([
  'P', 'BR', 'HR', 'PRE', 'CODE', 'STRONG', 'B', 'EM', 'I', 'U', 'S', 'DEL',
  'UL', 'OL', 'LI', 'BLOCKQUOTE', 'SPAN', 'SUB', 'SUP', 'TABLE', 'THEAD',
  'TBODY', 'TR', 'TD', 'TH', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
]);

/** 用 DOMParser 走一遍白名单，去掉 script/style/on* 和所有属性 */
function sanitizeHtml(src) {
  const doc = new DOMParser().parseFromString(`<div id="root">${src}</div>`, 'text/html');
  const root = doc.getElementById('root');

  const walk = (node, out) => {
    for (const child of node.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) {
        out.appendChild(doc.createTextNode(child.nodeValue));
        continue;
      }
      if (child.nodeType !== Node.ELEMENT_NODE) continue;
      const tag = child.tagName.toUpperCase();
      if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'IFRAME') continue;
      if (!ALLOWED.has(tag)) {
        // 不认识的标签：保留文字，丢掉标签
        walk(child, out);
        continue;
      }
      const el = doc.createElement(tag.toLowerCase());
      walk(child, el);
      out.appendChild(el);
    }
  };

  const out = doc.createElement('div');
  walk(root, out);
  return out.innerHTML;
}

function looksLikeHtml(s) {
  return /<\/?(p|div|ul|ol|li|pre|code|strong|em|table|h[1-6]|br|blockquote)\b[^>]*>/i.test(s);
}

function renderMarkdown(md) {
  let html = esc(md);
  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_, l, code) => `<pre><code>${code.replace(/\n$/, '')}</code></pre>`);
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
  html = html.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
  html = html.replace(/^### (.*)$/gm, '<h4>$1</h4>');
  html = html.replace(/^## (.*)$/gm, '<h3>$1</h3>');
  html = html.replace(/^&gt; (.*)$/gm, '<blockquote>$1</blockquote>');
  html = html.replace(/(?:^|\n)([ \t]*-[ \t]+.*(?:\n[ \t]*-[ \t]+.*)*)/g, (block) => {
    const items = block.trim().split('\n').map((l) => `<li>${l.replace(/^[ \t]*-[ \t]+/, '')}</li>`).join('');
    return `<ul>${items}</ul>`;
  });
  html = html.replace(/\n/g, '<br>');
  // <br> 不该出现在 pre 里
  html = html.replace(/<pre>([\s\S]*?)<\/pre>/g, (m) => m.replace(/<br>/g, '\n'));
  return html;
}

function renderMd(content) {
  if (!content) return '<p class="muted">题面未拉取，点「生成工作区」会自动补拉。</p>';
  if (looksLikeHtml(content)) return sanitizeHtml(content);
  return renderMarkdown(content);
}

// ---------------- 初始化 ----------------

let lastState = null;

async function loadState() {
  const s = await api('/api/state');
  state.stats = s.stats;
  lastState = s;

  // 统计数字用大白话，鼠标悬停给出完整解释。
  // 「AC」「题单」这类词只有刷题老手看得懂，第一次用的人会一脸问号。
  const st = s.stats;
  $('stats').innerHTML = [
    `<span class="stat" title="本地已收录的题目总数">题库 <b>${st.problems}</b></span>`,
    `<span class="stat" title="本地已同步的学习计划数量">计划 <b>${st.plans}</b></span>`,
    `<span class="stat" title="你已通过的题目数（需要绑定账号）">已通过 <b>${st.ac}</b></span>`,
    st.due > 0
      ? `<span class="stat" title="按复习计划，今天该重做的题">待复习 <b>${st.due}</b></span>`
      : '',
  ]
    .filter(Boolean)
    .join('');

  renderPlanSelect(s.plans);
  renderBindButton(s);
  renderWelcome();
  return s;
}

/** 顶栏的绑定按钮：按"没绑 / 绑了但失效 / 绑好了"三态显示 */
function renderBindButton(s) {
  const btn = $('bindBtn');
  if (!s.bound) {
    btn.textContent = '绑定账号';
    btn.title = '绑定力扣账号后，可以同步你的学习计划进度和通过状态';
    btn.classList.remove('ok');
  } else if (s.account?.signedIn) {
    btn.textContent = s.account.name + (s.account.premium ? ' ★' : '');
    btn.title = s.account.premium
      ? `已登录 ${s.account.name}（Plus 会员）。点这里可以换账号`
      : `已登录 ${s.account.name}。点这里可以换账号`;
    btn.classList.add('ok');
  } else {
    btn.textContent = '登录已过期';
    btn.title = '登录状态失效了，点这里重新绑定';
    btn.classList.remove('ok');
  }
}

/**
 * 顶栏的抽题范围下拉。
 *
 * 每个计划后面的括号跟着「抽什么样的」走 —— 选「还没做过的」就显示这个计划剩多少新题，
 * 选「今天该复习的」就显示今天到期几道。数字来自 /api/state 里的 planCounts，
 * 切模式时不用再发请求，直接重渲染选项即可。
 *
 * 「全部题目」那一项没有计划过滤，用当前已拉到的 total 兜底显示。
 */
function renderPlanSelect(plans) {
  const sel = $('planSel');
  const prev = sel.value;
  const mine = plans.filter((p) => p.source === 'mine');
  const rest = plans.filter((p) => p.source !== 'mine');

  const mode = $('modeSel')?.value || 'all';
  const counts = lastState?.planCounts || {};
  const nOf = (slug) => {
    const c = counts[slug];
    if (!c) return null;
    return c[mode] ?? c.all ?? null;
  };

  const opt = (p) => {
    const n = nOf(p.slug);
    return `<option value="${esc(p.slug)}">${esc(p.name)}（${n == null ? p.count : n}）</option>`;
  };

  // 「全部题目」括号里也给个数，否则它看起来像唯一没有信息的选项
  const allCount = state?.stats?.problems ?? '';
  sel.innerHTML =
    `<option value="">全部题目${allCount === '' ? '' : `（${allCount}）`}</option>` +
    (mine.length ? `<optgroup label="我加入的">${mine.map(opt).join('')}</optgroup>` : '') +
    (rest.length ? `<optgroup label="已同步的计划">${rest.map(opt).join('')}</optgroup>` : '');
  if (prev && plans.some((p) => p.slug === prev)) sel.value = prev;
}

async function loadProblems() {
  const plan = $('planSel').value;
  const mode = $('filterSel').value;
  const q = $('searchInput').value.trim();

  // 一个题单都没同步时，别让用户对着空列表发呆 —— 直接给出下一步该点哪里
  if (!plan && !q && !mode && lastState && lastState.plans.length === 0) {
    state.problems = [];
    renderScope(null);
    $('problemList').innerHTML = `<div class="empty-hint">
      <strong>还没同步任何学习计划</strong>
      <span>点左上角「选择学习计划」，挑一个（比如「面试经典 150 题」），
      点「同步」，就能按计划抽题了。</span>
      <div class="empty-actions">
        <button class="primary small-btn" onclick="document.getElementById('plansBtn').click()">去挑学习计划</button>
      </div>
      <span class="muted small">不需要绑定账号也能用。</span>
    </div>`;
    updatePoolCount();
    return;
  }

  const params = new URLSearchParams();
  if (plan) params.set('plan', plan);
  if (mode) params.set('mode', mode);
  if (q) params.set('q', q);
  params.set('limit', '2000');

  const r = await api('/api/problems?' + params.toString());
  state.problems = r.problems;
  state.counts = r.counts || null;
  state.group = r.group || '';
  renderScope(plan);
  renderList();
  renderPoolCount(r.counts);
}

/**
 * 操作条上那个「能抽到的题」数字。
 *
 * 用户切「从哪抽题」或「抽什么样的」时，这个数必须跟着变 ——
 * 否则他会以为模式切换没生效。数字来自后端按同样条件算的 COUNT。
 */
function renderPoolCount(counts) {
  const box = $('poolCount');
  if (!box) return;
  if (!counts) {
    box.textContent = '—';
    box.className = 'pool-count loading';
    return;
  }
  const mode = $('modeSel').value;
  // 「不限」对应 all，其余一一对应
  const n = counts[mode] ?? counts.all ?? 0;
  box.textContent = n + ' 题';
  box.className = 'pool-count' + (n === 0 ? ' zero' : '');
  box.title =
    n === 0
      ? '这个范围下没有符合「' + $('modeSel').selectedOptions[0].textContent + '」的题，换个条件试试'
      : `当前范围下，符合「${$('modeSel').selectedOptions[0].textContent}」的有 ${n} 题`;
}

/** 只查数量，不搬题目 —— 切模式时走这条，快很多 */
async function updatePoolCount() {
  const box = $('poolCount');
  if (!box) return;
  box.textContent = '…';
  box.className = 'pool-count loading';
  try {
    const params = new URLSearchParams();
    const plan = $('planSel').value;
    const q = $('searchInput').value.trim();
    if (plan) params.set('plan', plan);
    if (q) params.set('q', q);
    const r = await api('/api/problems/count?' + params.toString());
    renderPoolCount(r.counts);
  } catch {
    box.textContent = '—';
    box.className = 'pool-count loading';
  }
}

/** 左栏顶部的范围提示条 */
function renderScope(plan) {
  const bar = $('scopeBar');
  if (!plan) {
    bar.hidden = true;
    return;
  }
  const p = (lastState?.plans || []).find((x) => x.slug === plan);
  $('scopeLabel').textContent = `范围：${p ? p.name : plan}`;
  bar.hidden = false;
}

function renderList() {
  const box = $('problemList');
  if (!state.problems.length) {
    const plan = $('planSel').value;
    if ($('searchInput').value.trim()) {
      box.innerHTML = `<div class="empty-hint">
        <strong>没搜到</strong>
        <span>换个关键词试试，或者清空搜索框。</span>
      </div>`;
    } else if ($('filterSel').value) {
      box.innerHTML = `<div class="empty-hint">
        <strong>这个条件下没有题</strong>
        <span>「${esc($('filterSel').selectedOptions[0].textContent)}」在当前范围里一道都没有。</span>
        <div class="empty-actions">
          <button class="ghost small-btn" onclick="document.getElementById('filterSel').value='';document.getElementById('filterSel').onchange()">看全部状态</button>
        </div>
      </div>`;
    } else if (plan) {
      const p = (lastState?.plans || []).find((x) => x.slug === plan);
      box.innerHTML = `<div class="empty-hint">
        <strong>这个计划还没有题</strong>
        <span>「${esc(p ? p.name : plan)}」还没同步到本地。</span>
        <div class="empty-actions">
          <button class="primary small-btn" onclick="document.getElementById('plansBtn').click()">去同步</button>
        </div>
      </div>`;
    } else {
      box.innerHTML = `<div class="empty-hint">
        <strong>本地还没有题目</strong>
        <span>先去挑一个学习计划，把题目同步下来。</span>
        <div class="empty-actions">
          <button class="primary small-btn" onclick="document.getElementById('plansBtn').click()">挑学习计划</button>
        </div>
      </div>`;
    }
    return;
  }

  // 按计划分组显示。
  // 原来是一长条平铺的列表，用户选了「面试经典 150 题」看到里面混着
  // 「LeetCode 热题 100」的题，会以为是搜错了站点。加分组标题就能解释清楚：
  // 这些题确实在你看的计划里，只是它同时也属于另一个计划。
  const groups = new Map();
  for (const p of state.problems) {
    const g = p.group || '其它题目';
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(p);
  }

  // 只有一个分组时不用显示分组标题（纯属噪音）
  const multi = groups.size > 1;
  const parts = [];
  for (const [g, items] of groups) {
    if (multi) {
      parts.push(
        `<div class="group-head"><span class="gn" title="${esc(g)}">${esc(g)}</span>` +
          `<span class="gc">${items.length}</span></div>`,
      );
    }
    for (const p of items) parts.push(probRow(p));
  }
  box.innerHTML = parts.join('');

  box.querySelectorAll('.prob').forEach((el) => {
    el.onclick = () => openProblem(el.dataset.slug, el);
  });
}

/** 一行题目。slug 直接写在 DOM 上，多题抽取时才不会指错元素 */
function probRow(p) {
  const badges = [];
  // 只给「已通过 / 做过没过」挂徽章 —— "没做过"是常态，每行都标一遍纯属噪音
  if (p.status === 'ac' || p.status === 'notac') {
    badges.push(
      `<span class="badge ${p.status === 'ac' ? 'badge-ok' : ''}">${esc(STATUS_CN[p.status])}</span>`,
    );
  }
  if (p.dueDate) badges.push('<span class="badge badge-due">该复习了</span>');
  return `<div class="prob" data-slug="${esc(p.slug)}">
    <span class="pid">${esc(p.frontendId || '')}</span>
    <span class="pname" title="${esc(p.title)}">${esc(p.title)}</span>
    <span class="diff ${esc(p.difficulty || '')}">${DIFF_CN[p.difficulty] || ''}</span>
    ${badges.length ? `<span class="pstate">${badges.join('')}</span>` : ''}
  </div>`;
}

// ---------------- 打开题目 ----------------

async function openProblem(slug, el) {
  document.querySelectorAll('.prob').forEach((n) => n.classList.remove('active'));
  if (el) el.classList.add('active');

  try {
    const r = await api('/api/problem?slug=' + encodeURIComponent(slug));
    state.current = r.problem;
    state.current.files = r.files;
    state.current.dir = r.dir;

    const p = r.problem;
    // .meta.json 的等级键名换过：早期版本写 level，现在写 acmLevel。
    // 只认新键名的话，升级前生成的工作区会静默丢掉这个标记 ——
    // 明明有 Main.java + LeetCodeIO.java，界面上却看不出它是 ACM 几级。
    const acmLevel = r.meta?.acmLevel || r.meta?.level || null;
    $('problemTitle').textContent = `${p.frontendId ? p.frontendId + '. ' : ''}${p.title}`;
    $('problemMeta').innerHTML = [
      `<span class="diff ${esc(p.difficulty || '')}">${DIFF_CN[p.difficulty] || p.difficulty || '-'}</span>`,
      p.status ? STATUS_CN[p.status] || p.status : '没做过',
      esc((p.tags || []).slice(0, 6).join('、')),
      acmLevel ? `ACM ${esc(acmLevel)}` : '',
      r.review?.dueDate ? `下次复习 ${esc(r.review.dueDate)}（第 ${r.review.repetitions} 次）` : '',
      (r.plans || []).length ? `属于：${esc(r.plans.map((x) => x.name || x.slug).join('、'))}` : '',
    ]
      .filter(Boolean)
      .join('　·　');

    $('lcLink').href = p.url;
    $('lcLink').hidden = false;
    $('problemDesc').innerHTML = renderMd(p.contentMd);
    renderKama(p);
    renderTabs(r.files);
    $('runResult').innerHTML = '';
    $('runStatus').textContent = '还没运行';
    $('reviewBox').hidden = false;

    // 有题了就把引导收起来，换成题面。题面默认折叠，短题自动不显示展开按钮
    showDesc();
    applyDescClamp(false);
    // 这道题有工作区就展开代码区，没有就继续保持收起 —— 不用用户手动管
    if (!localStorage.getItem('lc-code-lock')) applyCollapse();
  } catch (e) {
    toast(e.message, 'err');
  }
}

/** 中间栏在「引导」和「题面」之间切换 */
function showDesc() {
  const w = $('welcome');
  const d = $('descWrap');
  if (state.current) {
    w.hidden = true;
    d.hidden = false;
  } else {
    w.hidden = false;
    d.hidden = true;
  }
}

/**
 * 长题干折叠 —— 像力扣那样只露一部分，点「展开完整题面」看全。
 *
 * 判据是「内容是否真的超出可显示高度」：短题不显示按钮，
 * 否则每道简单题下面都挂一个没用的「展开」，反而更乱。
 *
 * 可显示高度由 CSS 决定，两种形态：
 *   宽屏 .desc.is-clamped 有 max-height: min(62vh, 460px) —— 取这个上限
 *   窄屏（堆叠布局）max-height: none，高度由栅格行给出 —— 取元素可见高度
 * 所以阈值统一交给 visibleLimitPx 算，这里不写死任何数字。
 *
 * 每换一道题都重置成折叠态 —— 上道题展开了不代表这道题也要展开。
 */
function applyDescClamp(expanded = false) {
  const desc = $('problemDesc');
  const btn = $('descToggle');
  if (!desc || !btn) return;

  desc.classList.toggle('is-clamped', !expanded);
  // 必须在收起状态下量 —— 展开态是 flex:1，量不出真实内容长度
  const limit = visibleLimitPx(desc);
  const overflowing = desc.scrollHeight > limit + 8;

  btn.hidden = !overflowing;
  btn.textContent = expanded ? '收起题面' : '展开完整题面';
  state.descExpanded = expanded;
}

/**
 * 题面当前「最多能露出多少像素」。
 *
 * 不直接读 getComputedStyle(maxHeight)：对 min()/vh 这类计算值它会原样吐字符串
 * （"min(62vh, 460px)"），Number() 得不出数。用探针元素让浏览器自己算：
 * 脱离文档流避免影响布局、宽度对齐 desc、内容撑到极高，高度就会被 max-height 封顶。
 *
 * 窄屏下 max-height 是 none，探针量到 100000 —— 此时退回 desc 的可见高度
 * （栅格行给出来的就是可显示空间），这正是"超出就该给按钮"的阈值。
 */
function visibleLimitPx(desc) {
  const probe = document.createElement('div');
  probe.className = 'desc is-clamped';
  probe.style.cssText = 'visibility:hidden;pointer-events:none;position:absolute;left:-9999px;width:' + desc.clientWidth + 'px;';
  probe.innerHTML = '<div style="height:100000px"></div>';
  desc.parentElement.appendChild(probe);
  const px = probe.getBoundingClientRect().height;
  probe.remove();

  if (px > 10 && px < 20000) return px;   // 有明确上限，用它
  // 没上限（窄屏）或量崩了：用元素自己的可见高度
  return desc.clientHeight || 320;
}

/**
 * 中间栏的空状态。
 *
 * 之前这里是一行灰字「从左边选一道题，或者直接抽一题」——
 * 新人打开不知道「抽题」和「点题」的区别。现在给一句人话 + 一个入口，
 * 但不再放四步流程图（那是多余的视觉噪音）。
 */
function renderWelcome() {
  const plans = lastState?.plans || [];
  const hasPlan = plans.length > 0;
  const bound = !!lastState?.bound;

  $('welcome').innerHTML = `
    <div class="welcome-inner">
      <p class="welcome-title">${hasPlan ? '还没选题' : '本地还没有题目'}</p>
      <p class="welcome-sub">${
        hasPlan
          ? '点右上角「抽一道题」，或者直接点左边列表里的题目。'
          : '先去挑一个学习计划，把题目同步到本地。'
      }</p>
      <div class="welcome-cta">
        ${
          hasPlan
            ? `<button class="primary" onclick="document.getElementById('drawBtn').click()">抽一道题</button>`
            : `<button class="primary" onclick="document.getElementById('plansBtn').click()">挑选学习计划</button>
               <button class="ghost" onclick="document.getElementById('drawBtn').click()">从全部题目里抽</button>`
        }
      </div>
      ${bound ? '' : '<p class="welcome-hint">绑定力扣账号可以同步你的学习进度，不绑也能正常刷题。</p>'}
    </div>`;
}

function renderKama(p) {
  const box = $('kamaBox');
  if (!p.kamaPid) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  box.innerHTML = `
    <div class="khead">ACM L1 · 已绑卡码网 pid=${esc(p.kamaPid)}</div>
    <div><b>输入：</b>${esc(p.kamaInputDesc || '-')}</div>
    <div><b>输出：</b>${esc(p.kamaOutputDesc || '-')}</div>
    <button class="ghost small unbind" id="unbindBtn">解绑（退回 L2）</button>`;
  $('unbindBtn').onclick = async () => {
    await api('/api/kama/unbind', { method: 'POST', body: { slug: p.slug } });
    toast('已解绑卡码网 IO');
    await openProblem(p.slug);
  };
}

function renderTabs(files) {
  const box = $('fileTabs');
  if (!files.length) {
    box.innerHTML = '<span class="muted small">点「准备工作区」生成代码文件</span>';
    $('editor').value = '';
    return;
  }
  box.innerHTML = files.map((f) => `<span class="tab" data-f="${esc(f)}">${esc(f)}</span>`).join('');
  box.querySelectorAll('.tab').forEach((el) => {
    el.onclick = () => openFile(el.dataset.f);
  });
  const first = files.find((f) => f === 'Solution.java') || files[0];
  openFile(first);
}

async function openFile(name) {
  if (state.dirty && !confirm('有未保存的修改，要放弃吗？')) return;
  document.querySelectorAll('.tab').forEach((n) => n.classList.toggle('active', n.dataset.f === name));
  state.activeFile = name;
  const r = await api(`/api/file?slug=${encodeURIComponent(state.current.slug)}&name=${encodeURIComponent(name)}`);
  $('editor').value = r.content;
  state.dirty = false;
}

async function saveFile() {
  if (!state.current || !state.activeFile) return;
  await api('/api/file', {
    method: 'PUT',
    body: { slug: state.current.slug, name: state.activeFile, content: $('editor').value },
  });
  state.dirty = false;
  toast('已保存 ' + state.activeFile, 'ok');
}

// ---------------- 抽题 / 生成 / 运行 ----------------

async function doDraw() {
  const btn = $('drawBtn');
  btn.disabled = true;
  btn.textContent = '抽题中…';
  const plan = $('planSel').value || null;
  try {
    const r = await api('/api/draw', {
      method: 'POST',
      body: {
        plan,
        mode: $('modeSel').value,
        count: Number($('countInput').value) || 1,
        gen: true,
      },
    });
    if (!r.picked.length) {
      const s = r.stats || {};
      if (plan && s.total === 0) {
        toast('这个计划本地还没有题，先去「学习计划」里同步它', 'err');
      } else if (plan && (s.ac || 0) > 0 && $('modeSel').value === 'new') {
        toast('这个计划里没有未做的题了，把「抽什么样的」换成「不限」试试', 'err');
      } else if ($('modeSel').value === 'due') {
        toast('现在没有到复习时间的题', 'err');
      } else {
        toast('没有可抽的题（换个条件试试）', 'err');
      }
      return;
    }
    // 只展示这次抽中的题，并且只高亮第一道 —— 页面渲染后再按 slug 精确选中，
    // 不能直接拿 querySelector('.prob')，那样在多题抽取时会指错元素
    state.problems = r.picked;
    renderList();
    const firstEl = [...document.querySelectorAll('.prob')].find(
      (n) => n.dataset.slug === r.picked[0].slug,
    );
    await openProblem(r.picked[0].slug, firstEl);

    const why = (r.picked[0].reasons || []).join('；');
    const more = r.picked.length > 1 ? `（另抽中 ${r.picked.length - 1} 题）` : '';
    toast(`抽中：${r.picked[0].title}${more}${why ? '（' + why + '）' : ''}`, 'ok');
  } catch (e) {
    toast(e.message, 'err');
  } finally {
    btn.disabled = false;
    btn.textContent = '随机抽题';
  }
}

async function doGen() {
  if (!state.current) return;
  const btn = $('genBtn');
  btn.disabled = true;
  try {
    const r = await api('/api/gen', { method: 'POST', body: { slug: state.current.slug, mode: 'both', force: true } });
    toast(`已生成（ACM ${r.level}，${r.cases} 组用例）`, 'ok');
    // 生成了工作区就该把代码区展开 —— 用户下一步就是写代码。
    // 清除 lock，让自动判断重新接管（否则之前手动收起过就永远不弹开了）
    localStorage.removeItem('lc-code-lock');
    await openProblem(state.current.slug, document.querySelector('.prob.active'));
  } catch (e) {
    toast(e.message, 'err');
  } finally {
    btn.disabled = false;
  }
}

async function doRun() {
  if (!state.current) return;
  if (state.dirty) await saveFile();
  const btn = $('runBtn');
  btn.disabled = true;
  $('runStatus').textContent = '编译并运行中…';
  try {
    const r = await api('/api/run', { method: 'POST', body: { slug: state.current.slug } });
    renderRun(r);
  } catch (e) {
    $('runStatus').textContent = '失败';
    $('runResult').innerHTML = `<div class="fail">${esc(e.message)}</div>`;
  } finally {
    btn.disabled = false;
  }
}

function renderRun(r) {
  const box = $('runResult');
  if (!r.ok) {
    $('runStatus').textContent = '运行失败';
    box.innerHTML = `<div class="fail">${esc(r.error || '未知错误')}</div>` +
      (r.build?.stderr ? `<pre class="warnline">${esc(r.build.stderr)}</pre>` : '');
    return;
  }
  const s = r.summary || { total: 0, passed: 0, failed: 0, pending: 0 };
  $('runStatus').innerHTML =
    `共 <b>${s.total}</b>　通过 <b class="pass">${s.passed}</b>　失败 <b class="fail">${s.failed}</b>　无判定 ${s.pending}`;

  const parts = [];
  if (r.build?.stderr) parts.push(`<pre class="warnline">${esc(r.build.stderr)}</pre>`);
  for (const c of r.results || []) {
    const mark = c.pass === true ? '<span class="pass">✓ 通过</span>'
      : c.pass === false ? '<span class="fail">✗ 不通过</span>'
      : '<span class="warnline">? 无判定</span>';
    parts.push(`<div class="case">
      ${mark}　用例 ${c.index}　(${c.ms}ms)
      <div>输入：${esc(c.input)}</div>
      <div>期望：${esc(c.expected)}</div>
      <div>实际：${esc(c.actual)}</div>
      ${c.stderr ? `<pre class="warnline">${esc(c.stderr)}</pre>` : ''}
    </div>`);
  }
  box.innerHTML = parts.join('') || '<div class="muted">没有用例</div>';
}

async function doReview(q) {
  if (!state.current) return;
  await api('/api/review', { method: 'POST', body: { slug: state.current.slug, quality: q } });
  // 别把 quality=4 这种内部参数丢给用户看，直接说人话
  const word = q >= 5 ? '秒杀' : q === 4 ? '有点卡但做出来了' : q === 3 ? '做得勉强' : '没做出来';
  toast(`已记录：${word}。下次复习时间已重新安排`, 'ok');
  loadState();
}

// ---------------- 学习计划广场 ----------------
//
// 这是主线的入口：绑定账号 → 关联学习计划 → 抽计划里的题。
// 关键设计：**不绑定账号也能用**。全部计划的题库（studyPlanV2Detail）免登录可取，
// 所以"选计划 → 同步 → 抽题"全程不需要 Cookie；
// 绑定后额外解锁"我加入的计划 + 我的 AC 状态 + 进度"。

async function openPlans() {
  $('plansModal').hidden = false;
  // 这个接口要现去力扣拉全部计划，实测 5~7 秒。
  // 不先摆个占位的话，用户会对着空白弹窗等，以为坏了。
  $('plansStatus').textContent = '加载中…';
  if (!$('allPlansList').children.length) {
    $('allPlansList').innerHTML =
      '<div class="empty-hint" style="grid-column:1/-1"><span class="dot"></span>正在从力扣读取学习计划列表…</div>';
  }
  try {
    const r = await api('/api/plans');
    state.plans = r;
    renderPlansModal(r);
    $('plansStatus').textContent = '';
  } catch (e) {
    $('plansStatus').textContent = '';
    $('allPlansList').innerHTML = `<div class="empty-hint" style="grid-column:1/-1">
      <strong>加载失败</strong>
      <span>${esc(e.message)}</span>
    </div>`;
    toast('加载学习计划失败：' + e.message, 'err');
  }
}

function renderPlansModal(r) {
  // 顶部账号状态
  const acc = $('plansAccount');
  if (!r.bound) {
    acc.innerHTML =
      '<span>未绑定账号。' +
      '全部学习计划都可以直接同步并抽题；' +
      '绑定后还能看到 <b>我加入的计划</b> 和你的 <b>通过状态</b>。</span>';
  } else if (lastState?.account?.signedIn) {
    acc.innerHTML = `已登录 <b>${esc(lastState.account.name || '')}</b>${
      lastState.account.premium ? '（Plus 会员）' : ''
    }　·　可同步「我加入的计划」与通过状态`;
  } else {
    acc.innerHTML =
      '<span class="warn">登录信息已保存但力扣返回未登录（可能已过期）。' +
      '计划的题目仍可同步，但拿不到「我加入的计划」。</span>';
  }

  // 我加入的计划
  const myBox = $('myPlansList');
  const hint = $('myPlansHint');
  if (!r.bound) {
    hint.textContent = '';
    myBox.innerHTML =
      '<div class="empty-hint" style="grid-column:1/-1">' +
      '绑定力扣账号后，这里会列出你在力扣上加入的学习计划，并显示每份计划的进度。' +
      '</div>';
  } else if (r.mineError) {
    hint.textContent = '';
    myBox.innerHTML = `<div class="empty-hint" style="grid-column:1/-1">拉取失败：${esc(r.mineError)}</div>`;
  } else if (!r.mine.length) {
    hint.textContent = '';
    myBox.innerHTML =
      '<div class="empty-hint" style="grid-column:1/-1">' +
      '账号下没有已加入的学习计划。可以去下面的「全部计划」里挑一个同步，效果一样。' +
      '</div>';
  } else {
    hint.textContent = `（${r.mine.length} 个）`;
    myBox.innerHTML = r.mine.map((p) => planCard(p, { mine: true })).join('');
  }

  // 全部计划
  renderAllPlans(r.plans);
  $('planSearch').value = '';

  // 恢复「我加入的计划」/「全部计划」两节的收起状态
  const hideMine = localStorage.getItem('lc-hide-myplans') === '1';
  $('myPlansList').hidden = hideMine;
  const caret = $('myPlansToggle').querySelector('.caret');
  if (caret) caret.textContent = hideMine ? '▸' : '▾';

  const hideAll = localStorage.getItem('lc-hide-allplans') === '1';
  $('allPlansList').hidden = hideAll;
  const caretAll = $('allPlansToggle').querySelector('.caret');
  if (caretAll) caretAll.textContent = hideAll ? '▸' : '▾';
}

function renderAllPlans(plans, keyword = '') {
  const box = $('allPlansList');
  const kw = keyword.trim().toLowerCase();

  // 默认只显示"能刷 Java 的"计划。
  // SQL / Pandas / JavaScript 专项计划里的题不是 Java 算法题，混在列表里只会干扰选择。
  // 用户在搜索框里主动搜（比如输入 sql）时，才把它们放出来。
  let list = kw ? plans : plans.filter((p) => p.drawable !== false);

  if (kw) {
    list = list.filter(
      (p) =>
        p.name.toLowerCase().includes(kw) ||
        p.slug.toLowerCase().includes(kw) ||
        (p.group || '').toLowerCase().includes(kw),
    );
  }

  if (!list.length) {
    box.innerHTML = '<div class="empty-hint" style="grid-column:1/-1">没有匹配的计划</div>';
    return;
  }

  // 按分组归类显示。分组标题做成可折叠的 ——
  // 「全部计划」有十几个分类、五六十张卡片，不折叠要找半天。
  const groups = new Map();
  for (const p of list) {
    const g = p.group || '其它';
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(p);
  }

  const collapsed = readCollapsedGroups();
  const parts = [];
  for (const [g, items] of groups) {
    const isCollapsed = collapsed.has(g);
    parts.push(
      `<div class="plan-group-title group-toggle ${isCollapsed ? 'collapsed' : ''}" data-group="${esc(g)}">` +
        `<span class="caret">${isCollapsed ? '▸' : '▾'}</span>` +
        `<span class="gt-name">${esc(g)}</span>` +
        `<span class="gt-count">${items.length}</span>` +
        `</div>`,
    );
    // 折叠时把卡片标成 hidden（CSS 里 [hidden] 是 display:none !important，
    // 能压过 .plan-card 的 display:flex），展开时不用重新请求
    for (const p of items) parts.push(planCard(p, { hidden: isCollapsed }));
  }
  box.innerHTML = parts.join('');

  // 分组标题可点。事件委托挂在标题自己身上，每次渲染后重新绑
  box.querySelectorAll('.group-toggle').forEach((el) => {
    el.onclick = () => {
      const g = el.dataset.group;
      const set = readCollapsedGroups();
      if (set.has(g)) set.delete(g);
      else set.add(g);
      writeCollapsedGroups(set);
      renderAllPlans(state.plans?.plans || [], $('planSearch')?.value || '');
    };
  });
}

/** 记住哪些计划分组被收起了，刷新/切搜索词后保持 */
function readCollapsedGroups() {
  try {
    return new Set(JSON.parse(localStorage.getItem('lc-collapsed-groups') || '[]'));
  } catch {
    return new Set();
  }
}

function writeCollapsedGroups(set) {
  try {
    localStorage.setItem('lc-collapsed-groups', JSON.stringify([...set]));
  } catch {
    /* 隐私模式下 localStorage 可能不可写，忽略即可 */
  }
}

function planCard(p, { mine, hidden } = {}) {
  const cls = ['plan-card'];
  if (p.synced) cls.push('synced');
  if (mine || p.mine) cls.push('mine');
  // Plus 专属计划没有会员题面拿不到，弱化显示
  if (p.plusOnly && !p.synced) cls.push('dim');

  const tags = [];
  if (mine || p.mine) tags.push('<span class="tag mine">我加入的</span>');
  if (p.synced && p.syncedCount > 0) tags.push(`<span class="tag ok">已同步 ${p.syncedCount} 题</span>`);
  else if (p.synced) tags.push('<span class="tag">空</span>');
  if (p.plusOnly) tags.push('<span class="tag plus">Plus</span>');

  // 我加入的计划带进度条
  let progress = '';
  if (mine && p.total) {
    const pct = Math.min(100, Math.round(((p.finished || 0) / p.total) * 100));
    progress = `
      <div class="progbar"><i style="width:${pct}%"></i></div>
      <div class="plan-meta">进度 ${p.finished || 0}/${p.total}（${pct}%）${
        p.nextQuestion ? `　下一题 ${esc(p.nextQuestion.frontendId || '')}. ${esc(p.nextQuestion.title)}` : ''
      }</div>`;
  }

  const meta = [];
  if (!mine) {
    if (p.total != null) meta.push(`${p.total} 题`);
    if (p.ac) meta.push(`已通过 ${p.ac}`);
    if (p.desc) meta.push(esc(p.desc));
  }

  const btnSync = p.synced && p.syncedCount > 0 ? '重新同步' : '同步';
  const canBrowse = p.synced && p.syncedCount > 0;

  return `<div class="${cls.join(' ')}"${hidden ? ' hidden' : ''}>
    <div class="plan-title">
      <span class="nm" title="${esc(p.name)}">${esc(p.name)}</span>
      ${tags.join('')}
    </div>
    <div class="plan-slug">${esc(p.slug)}</div>
    ${meta.length ? `<div class="plan-meta">${meta.join('　·　')}</div>` : ''}
    ${progress}
    <div class="plan-actions">
      <button class="ghost sync-1" data-slug="${esc(p.slug)}">${btnSync}</button>
      ${
        canBrowse
          ? `<button class="primary browse-1" data-slug="${esc(p.slug)}" data-name="${esc(p.name)}">抽这个计划的题</button>`
          : ''
      }
    </div>
  </div>`;
}

/** 同步一个计划，然后刷新弹窗 */
async function syncOnePlan(slug) {
  const btn = document.querySelector(`.sync-1[data-slug="${slug}"]`);
  const planName = btn?.closest('.plan-card')?.querySelector('.nm')?.textContent || slug;
  if (btn) {
    btn.disabled = true;
    btn.textContent = '同步中…';
  }
  // 显示计划名而不是 slug —— slug 是给接口用的，用户不认识
  $('plansStatus').textContent = '正在同步「' + planName + '」…';
  try {
    const r = await api('/api/plans/sync', { method: 'POST', body: { slug } });
    const p = r.plans?.[0];
    if (!p) {
      toast('没有同步到任何题', 'err');
    } else if (p.count === 0) {
      toast(`${p.name}：0 题（大概率是 Plus 会员专属计划）`, 'err');
    } else {
      toast(`已同步「${p.name}」${p.count} 题`, 'ok');
    }
    await loadState();
    await openPlans();
    await loadProblems();
  } catch (e) {
    toast('同步失败：' + e.message, 'err');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = '同步';
    }
    $('plansStatus').textContent = '';
  }
}
async function syncMine() {
  const btn = $('syncMine');
  btn.disabled = true;
  btn.textContent = '同步中…';
  $('plansStatus').textContent = '正在同步你加入的全部计划，可能要一会儿…';
  try {
    const r = await api('/api/plans/sync', { method: 'POST', body: { mine: true } });
    const good = (r.plans || []).filter((p) => p.count > 0);
    if (!good.length) {
      toast('没有同步到题目。先绑定账号，或去「全部计划」里手动同步。', 'err');
    } else {
      toast(`已同步 ${good.length} 个计划，共 ${good.reduce((s, p) => s + p.count, 0)} 题`, 'ok');
    }
    await loadState();
    await openPlans();
    await loadProblems();
  } catch (e) {
    toast(e.message, 'err');
  } finally {
    btn.disabled = false;
    btn.textContent = '同步我加入的全部计划';
    $('plansStatus').textContent = '';
  }
}

async function syncFeatured() {
  const btn = $('syncFeatured');
  btn.disabled = true;
  btn.textContent = '同步中…';
  $('plansStatus').textContent = '正在同步内置精选计划（约 11 个，需要一点时间）…';
  try {
    const r = await api('/api/plans/sync', { method: 'POST', body: {} });
    const good = (r.plans || []).filter((p) => p.count > 0);
    toast(`已同步 ${good.length} 个精选计划，共 ${good.reduce((s, p) => s + p.count, 0)} 题`, 'ok');
    await loadState();
    await openPlans();
    await loadProblems();
  } catch (e) {
    toast('同步失败：' + e.message, 'err');
  } finally {
    btn.disabled = false;
    btn.textContent = '同步精选计划';
    $('plansStatus').textContent = '';
  }
}

/** 把抽题范围设成某个计划，并关掉弹窗 */
async function usePlanAsScope(slug, name) {
  $('plansModal').hidden = true;
  await loadState();
  $('planSel').value = slug;
  await loadProblems();
  toast(`抽题范围已设为「${name}」，点「随机抽题」开始`, 'ok');
}

// ---------------- 绑定 ----------------

let bindCap = null;
let bindTimer = null;

async function openBind() {
  $('bindModal').hidden = false;
  $('bindProgress').hidden = true;
  $('bindResult').hidden = true;
  $('bindResult').textContent = '';
  try {
    bindCap = await api('/api/bind/capability');
  } catch {
    bindCap = { browser: { ok: false, hint: '探测失败' }, account: null };
  }
  renderBindModal(bindCap);
}

/**
 * 渲染绑定弹窗。
 *
 * 只有两种状态：
 *   - 已登录   → 显示账号卡片 + 「重新登录（换个账号）」
 *   - 未登录   → 显示「登录力扣并绑定」
 * 没有浏览器时按钮禁用并提示去装一个（不再有"手动粘贴 Cookie"这一路）。
 */
function renderBindModal(cap) {
  const acct = cap.account;
  const b = cap.browser || {};

  // 账号卡片
  if (acct && acct.signedIn) {
    const name = acct.name || '已登录';
    $('bindAcct').hidden = false;
    $('bindAcct').innerHTML = `
      <div class="acct-avatar">${(name[0] || 'L').toUpperCase()}</div>
      <div class="acct-info">
        <div class="acct-name">${esc(name)}</div>
        <div class="acct-sub">${esc(acct.userSlug || '')}${acct.premium ? ' · Plus 会员' : ''}</div>
      </div>
      <button class="ghost" id="bindUnbind">解绑</button>`;
    $('bindAcct').querySelector('#bindUnbind').onclick = doUnbind;
    $('bindLogin').textContent = '重新登录（换个账号）';
  } else {
    $('bindAcct').hidden = true;
    $('bindLogin').textContent = '登录力扣并绑定';
  }

  // 浏览器能力提示
  //
  // 没有浏览器时不能只报错 —— 用户会卡死在这一步。这里把"怎么解决"讲清楚：
  // 装一个 Chrome/Edge，或者手动在配置里指路径。不再提供粘贴 Cookie 的退路。
  const info = $('bindBrowserInfo');
  const lead = $('bindLead');
  if (b.ok) {
    info.className = 'capability ok';
    info.textContent = `将使用 ${b.name}（${b.source === 'installed' ? '本机已安装' : '内置内核'}）`;
    // 引导语跟着状态走，别在按钮已经写了「换个账号」时还在说"首次绑定"
    lead.textContent = acct?.signedIn
      ? '点下面按钮，会弹出一个小窗口让你重新登录力扣（换账号用）。登录成功就自动替换掉当前账号。'
      : '点下面按钮，会弹出一个小窗口让你登录力扣。登录成功就自动完成绑定，不需要手动复制任何东西。';
  } else {
    info.className = 'capability warn';
    info.innerHTML =
      `没找到可用的浏览器。装一个 <b>Chrome</b> 或 <b>Edge</b> 即可，` +
      `也可以在本机 <code>.lc/config.json</code> 里加一行 ` +
      `<code>"browserPath": "你的浏览器路径"</code>。`;
    // 没有浏览器时按钮是禁用的，引导语不能再说"点下面按钮"
    lead.textContent = '自动登录需要一个浏览器。装好之后关掉这个窗口再打开，就能直接登录了。';
  }

  // 没有浏览器时主按钮禁用，避免点了没反应
  $('bindLogin').disabled = !b.ok;
  if (!b.ok) $('bindLogin').textContent = '需要先装一个浏览器';
}

async function doUnbind() {
  if (!confirm('确定解绑当前力扣账号？本地题目与计划数据会保留。')) return;
  try {
    await api('/api/unbind', { method: 'POST' });
    toast('已解绑', 'ok');
    $('bindModal').hidden = true;
    await loadState();
    if (!$('plansModal').hidden) await openPlans();
  } catch (e) {
    toast(e.message, 'err');
  }
}

/** 一键登录：弹出浏览器 → 用户登录 → 自动抓 Cookie */
async function doBrowserLogin() {
  if (!bindCap?.browser?.ok) return toast('没有可用的浏览器', 'err');
  $('bindProgress').hidden = false;
  $('bindResult').hidden = true;
  $('bindResult').textContent = '';
  setBindStatus('正在打开登录窗口…');
  const btn = $('bindLogin');
  btn.disabled = true;
  startBindPoll();

  try {
    // 注意：这个请求会一直挂着直到登录成功或超时，所以必须是异步等待
    const r = await api('/api/login/browser', { method: 'POST', body: { site: 'cn' } });
    stopBindPoll();
    if (r.ok) {
      setBindStatus('登录成功，正在读取账号信息…');
      $('bindProgress').hidden = true;
      $('bindResult').hidden = false;
      $('bindResult').className = 'bind-result ok';
      $('bindResult').textContent = `已绑定：${r.account?.name || '力扣账号'}`;
      await loadState();
      if (!$('plansModal').hidden) await openPlans();
      setTimeout(() => {
        $('bindModal').hidden = true;
        toast('绑定成功，可以开始抽题了', 'ok');
      }, 900);
    } else {
      $('bindProgress').hidden = true;
      $('bindResult').hidden = false;
      $('bindResult').className = 'bind-result err';
      $('bindResult').textContent = r.hint || r.error || '登录未完成';
    }
  } catch (e) {
    stopBindPoll();
    $('bindProgress').hidden = true;
    $('bindResult').hidden = false;
    $('bindResult').className = 'bind-result err';
    // 把后端的技术性报错翻译成用户能看懂的一句话
    const m = e.message || '';
    if (m.includes('被关闭')) {
      $('bindResult').textContent = '登录窗口被关闭了，绑定未完成，可以重试。';
    } else if (m.includes('超时')) {
      $('bindResult').textContent = '等待登录超时，可以重试。';
    } else {
      $('bindResult').textContent = m || '登录未完成';
    }
  } finally {
    btn.disabled = false;
    if (bindCap?.browser?.ok) btn.textContent = '重试登录';
  }
}

function setBindStatus(t) {
  $('bindStatusText').textContent = t;
}

/** 轮询后端登录进度，把「等待登录中…」这类文案显示出来 */
function startBindPoll() {
  stopBindPoll();
  bindTimer = setInterval(async () => {
    try {
      const s = await api('/api/login/status');
      if (s.message) setBindStatus(s.message);
      if (s.done && s.ok) stopBindPoll();
    } catch {
      /* 轮询失败不影响主流程 */
    }
  }, 1000);
}

function stopBindPoll() {
  if (bindTimer) clearInterval(bindTimer);
  bindTimer = null;
}

// ---------------- 事件绑定 ----------------

$('drawBtn').onclick = doDraw;
$('genBtn').onclick = doGen;
$('runBtn').onclick = doRun;
$('saveBtn').onclick = saveFile;
$('bindBtn').onclick = openBind;
$('bindLogin').onclick = doBrowserLogin;
$('bindCancel').onclick = () => {
  stopBindPoll();
  $('bindModal').hidden = true;
};

// 学习计划
$('plansBtn').onclick = openPlans;
$('plansClose').onclick = () => ($('plansModal').hidden = true);
$('syncMine').onclick = syncMine;
$('syncFeatured').onclick = syncFeatured;
$('planSearch').oninput = () => {
  if (state.plans) renderAllPlans(state.plans.plans, $('planSearch').value);
};
// 「我加入的计划」整节可收起
$('myPlansToggle').onclick = () => {
  const box = $('myPlansList');
  const caret = $('myPlansToggle').querySelector('.caret');
  const hide = !box.hidden;
  box.hidden = hide;
  caret.textContent = hide ? '▸' : '▾';
  localStorage.setItem('lc-hide-myplans', hide ? '1' : '0');
};
// 「全部计划」整节也可收起（计划有几十个，滚动很长）
$('allPlansToggle').onclick = () => {
  const box = $('allPlansList');
  const caret = $('allPlansToggle').querySelector('.caret');
  const hide = !box.hidden;
  box.hidden = hide;
  caret.textContent = hide ? '▸' : '▾';
  localStorage.setItem('lc-hide-allplans', hide ? '1' : '0');
};
// 计划卡片上的按钮用事件委托 —— 卡片是动态渲染的，逐个绑定会在重渲染后失效
$('plansModal').addEventListener('click', (e) => {
  const sync = e.target.closest('.sync-1');
  if (sync) {
    syncOnePlan(sync.dataset.slug);
    return;
  }
  const browse = e.target.closest('.browse-1');
  if (browse) {
    usePlanAsScope(browse.dataset.slug, browse.dataset.name);
  }
});

$('planSel').onchange = () => {
  loadProblems();
};
$('filterSel').onchange = loadProblems;

/*
 * 「抽什么样的」和左栏的「全部状态」是同一件事的两个入口：
 * 一个是给抽题用的，一个是给翻列表用的。两边都改同一个 state，
 * 用户在哪边选另一边的列表都会跟着变，不用猜"我刚选的那个生效了吗"。
 */
$('modeSel').onchange = () => {
  const m = $('modeSel').value;
  $('filterSel').value = m === 'all' ? '' : m;
  // 下拉里每个计划的括号数字也要跟着换，否则会出现
  // 「选了『还没做过的』但括号还是计划总题数」这种对不上的情况
  renderPlanSelect(lastState?.plans || []);
  loadProblems();
};
$('scopeClear').onclick = () => {
  $('planSel').value = '';
  loadProblems();
};
// 题面「展开 / 收起」。短题不显示这个按钮（由 applyDescClamp 控制）
$('descToggle').onclick = () => applyDescClamp(!state.descExpanded);

// ---------------- 折叠 ----------------
//
// 学 leetcode 的做法：题目列表和题面都能收起，把宽度让给编辑器。
// 状态存在 localStorage，刷新后保持。

function applyCollapse() {
  const list = localStorage.getItem('lc-collapse-list') === '1';
  const desc = localStorage.getItem('lc-collapse-desc') === '1';
  const main = $('mainArea');
  $('reopenList').hidden = !list;
  /*
   * 题面把手是动态建的一次性元素。
   *
   * 必须插在 #reopenList 之后、#descPanel 之前 —— 不能图省事插在 #descPanel 后面。
   * 因为 #descPanel 收起时是 display:none，grid 自动放置会把后面的元素
   * 当成"行内第二个可见项"从头排，结果把手掉进左栏那一列被拉成大块。
   * DOM 顺序固定成 [listPanel, reopenList, reopenDesc, descPanel, codePanel]，
   * 再配合 CSS 里显式的 grid-column，四种收起组合都能落对位置。
   */
  let reopenDesc = $('reopenDesc');
  if (!reopenDesc) {
    reopenDesc = document.createElement('button');
    reopenDesc.id = 'reopenDesc';
    reopenDesc.className = 'panel-reopen';
    reopenDesc.title = '展开题面';
    reopenDesc.textContent = '题面 ›';
    reopenDesc.onclick = () => {
      localStorage.setItem('lc-collapse-desc', '0');
      applyCollapse();
    };
    $('reopenList').after(reopenDesc);
  }
  reopenDesc.hidden = !desc;

  /*
   * 代码区（工作区）折叠。
   *
   * 和左栏/题面不同，这一栏的收起是「自动」的：没生成工作区时它本来就空着，
   * 占一整列只是浪费空间（用户反馈：默认没有工作区时可以不显示）。
   * 一旦点了「准备工作区」，就自动展开 —— 那时候用户正要写代码。
   *
   * 手动点击把手也能压过自动判断（codeLock 记用户的显式选择），
   * 否则用户手动收起后一切题又被强行弹开，很烦。
   */
  let reopenCode = $('reopenCode');
  if (!reopenCode) {
    reopenCode = document.createElement('button');
    reopenCode.id = 'reopenCode';
    reopenCode.className = 'panel-reopen';
    reopenCode.title = '展开代码区';
    reopenCode.textContent = '代码 ›';
    reopenCode.onclick = () => {
      localStorage.setItem('lc-collapse-code', '0');
      localStorage.setItem('lc-code-lock', '1');
      applyCollapse();
    };
    reopenDesc.after(reopenCode);
  }

  const hasWorkspace = (state.current?.files || []).length > 0;
  const locked = localStorage.getItem('lc-code-lock') === '1';
  // 没工作区 → 默认收起；有工作区 → 默认展开。用户手动改过就听用户的
  const code = locked ? localStorage.getItem('lc-collapse-code') === '1' : !hasWorkspace;

  reopenCode.hidden = !code;

  // class 最后加，避免布局闪一下
  main.classList.toggle('list-collapsed', list);
  main.classList.toggle('desc-collapsed', desc);
  main.classList.toggle('code-collapsed', code);
}

$('collapseList').onclick = () => {
  const cur = localStorage.getItem('lc-collapse-list') === '1';
  localStorage.setItem('lc-collapse-list', cur ? '0' : '1');
  applyCollapse();
};
$('reopenList').onclick = () => {
  localStorage.setItem('lc-collapse-list', '0');
  applyCollapse();
};
$('collapseDesc').onclick = () => {
  localStorage.setItem('lc-collapse-desc', '1');
  applyCollapse();
};
$('collapseCode').onclick = () => {
  localStorage.setItem('lc-collapse-code', '1');
  localStorage.setItem('lc-code-lock', '1');
  applyCollapse();
};
$('reviewBox').onclick = (e) => {
  if (e.target.classList.contains('qbtn')) doReview(Number(e.target.dataset.q));
};

let searchTimer = null;
$('searchInput').oninput = () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(loadProblems, 260);
};

$('themeBtn').onclick = () => {
  const cur = document.documentElement.dataset.theme;
  const next = cur === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  localStorage.setItem('lc-theme', next);
};

$('editor').addEventListener('input', () => (state.dirty = true));
$('editor').addEventListener('keydown', (e) => {
  if (e.key === 'Tab') {
    e.preventDefault();
    const t = e.target;
    const s = t.selectionStart;
    t.value = t.value.slice(0, s) + '    ' + t.value.slice(t.selectionEnd);
    t.selectionStart = t.selectionEnd = s + 4;
    state.dirty = true;
  }
  if ((e.ctrlKey || e.metaKey) && e.key === 's') {
    e.preventDefault();
    saveFile();
  }
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
    e.preventDefault();
    doRun();
  }
});

// ---------------- 启动 ----------------

async function boot() {
  const saved = localStorage.getItem('lc-theme');
  if (saved) document.documentElement.dataset.theme = saved;
  else document.documentElement.dataset.theme = matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';

  showDesc();
  applyCollapse();
  try {
    await loadState();
    await loadProblems();
  } catch (e) {
    toast('初始化失败：' + e.message, 'err');
  }
}

(async function () {
  await boot();
})();

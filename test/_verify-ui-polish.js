/*
 * 验收本轮两处 UI 改动：
 *   A. 自定义下拉 —— 原生 select 被藏起来、触发器文案跟得上、弹层能开合、
 *      带 <optgroup> 的计划下拉分组渲染正确、选中项打勾、键盘能走
 *   B. 折叠符号 —— 换成 SVG 后真居中（量 ink 而不是量盒子），
 *      展开/收起同为旋转关系（形状不变）
 *
 * 关键：**不能只量盒子的中心**。改前量的几何偏差就是 0.0px，
 * 但肉眼看着不居中 —— 因为字形盒子里 ink 是偏的。
 * 现在换成对称 SVG，所以 ink 中心 == 盒子中心，量盒子才有意义。
 * 这里额外用 getBBox() 取 path 的真实包围盒来交叉验证。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const BASE = process.env.LC_BASE || 'http://127.0.0.1:7788';
const PORT = 9371;
const profile = path.join(os.tmpdir(), 'lc-shots-polish-' + Date.now());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
  ],
  { stdio: ['ignore', 'pipe', 'pipe'] },
);

for (let i = 0; i < 40; i++) {
  await sleep(250);
  try {
    const j = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
    if (j.webSocketDebuggerUrl) break;
  } catch {}
}
const target = await (
  await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(BASE)}`, { method: 'PUT' })
).json();
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.onopen = res;
  ws.onerror = rej;
});

let msgId = 0;
const pending = new Map();
const consoleErrors = [];
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.method === 'Runtime.exceptionThrown') {
    consoleErrors.push(m.params?.exceptionDetails?.exception?.description || 'unknown');
  }
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m);
    pending.delete(m.id);
  }
};
const send = (method, params = {}) => {
  const id = ++msgId;
  return new Promise((res) => {
    pending.set(id, res);
    ws.send(JSON.stringify({ id, method, params }));
  });
};
const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description);
  return r.result?.result?.value;
};

await send('Runtime.enable');
await send('Page.enable');

async function setViewport(w, h, scale = 2) {
  await send('Emulation.setDeviceMetricsOverride', {
    width: w,
    height: h,
    deviceScaleFactor: scale,
    mobile: false,
  });
}
async function ready() {
  for (let i = 0; i < 40; i++) {
    await sleep(250);
    if ((await evaluate('document.readyState')) === 'complete') break;
  }
  await sleep(1800);
}
async function shot(name) {
  const s = await send('Page.captureScreenshot', { format: 'png' });
  if (s.result?.data) {
    fs.writeFileSync(name, Buffer.from(s.result.data, 'base64'));
    console.log('  已保存', name);
  }
}
async function shotClip(name, sel, pad = 12) {
  const r = await evaluate(`
    (() => {
      const el = document.querySelector(${JSON.stringify(sel)});
      if (!el) return null;
      const b = el.getBoundingClientRect();
      return { x: b.x, y: b.y, width: b.width, height: b.height };
    })()
  `);
  if (!r) {
    console.log('  跳过（找不到）', sel);
    return;
  }
  const s = await send('Page.captureScreenshot', {
    format: 'png',
    clip: { x: Math.max(0, r.x - pad), y: Math.max(0, r.y - pad), width: r.width + pad * 2, height: r.height + pad * 2, scale: 3 },
  });
  if (s.result?.data) {
    fs.writeFileSync(name, Buffer.from(s.result.data, 'base64'));
    console.log('  已保存', name);
  }
}

await setViewport(1500, 900);
await ready();
await evaluate(
  `localStorage.setItem('lc-collapse-list','0'); localStorage.setItem('lc-collapse-desc','0'); localStorage.removeItem('lc-code-lock'); localStorage.removeItem('lc-collapse-code'); true;`,
);
await send('Page.navigate', { url: BASE });
await ready();

await evaluate(`openProblem('two-sum', null)`);
for (let i = 0; i < 30; i++) {
  await sleep(500);
  if (await evaluate(`!!(window.state && state.current && state.current.slug === 'two-sum')`)) break;
}
await sleep(1200);

const checks = [];

/* ---------------- A. 自定义下拉 ---------------- */

console.log('=== A. 自定义下拉 ===');
const ddInit = await evaluate(`
  (() => {
    const out = {};
    for (const id of ['planSel','modeSel','filterSel']) {
      const s = document.getElementById(id);
      const trg = s.parentElement.querySelector('.dd-trigger');
      const st = getComputedStyle(s);
      out[id] = {
        inDd: s.parentElement.classList.contains('dd'),
        trigger: !!trg,
        triggerLabel: trg?.querySelector('.dd-label')?.textContent,
        selectLabel: s.selectedOptions[0]?.textContent.trim(),
        selectHidden: st.clipPath === 'inset(50%)' || s.offsetWidth <= 1,
        nativeDisplay: st.display,
      };
    }
    return out;
  })()
`);
for (const [id, v] of Object.entries(ddInit)) {
  console.log(
    `  ${id.padEnd(10)} 包进.dd=${v.inDd} 触发器=${v.trigger} 触发器文案=${JSON.stringify(v.triggerLabel)} select文案=${JSON.stringify(v.selectLabel)} select已藏=${v.selectHidden}`,
  );
}
checks.push(['A 三个 select 都被包进 .dd', Object.values(ddInit).every((v) => v.inDd && v.trigger)]);
checks.push(['A 原生 select 视觉隐藏但仍可读', Object.values(ddInit).every((v) => v.selectHidden && v.nativeDisplay !== 'none')]);
checks.push([
  'A 触发器文案与 select 当前项一致',
  Object.values(ddInit).every((v) => v.triggerLabel === v.selectLabel),
]);

// 打开「计划」下拉，检查 optgroup 分组 + 当前项打勾
await evaluate(`document.querySelector('#planSel').parentElement.querySelector('.dd-trigger').click()`);
await sleep(600);
const planPop = await evaluate(`
  (() => {
    const pop = document.querySelector('.dd-pop:not([hidden])');
    if (!pop) return null;
    const r = pop.getBoundingClientRect();
    const trg = document.querySelector('#planSel').parentElement.querySelector('.dd-trigger').getBoundingClientRect();
    return {
      groups: [...pop.querySelectorAll('.dd-group')].map(e => e.textContent),
      items: pop.querySelectorAll('.dd-item').length,
      selected: pop.querySelectorAll('.dd-item.on').length,
      ticks: pop.querySelectorAll('.dd-item.on .tick').length,
      firstText: pop.querySelector('.dd-item .dd-text')?.textContent,
      inViewport: r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight,
      aligned: Math.abs(r.left - trg.left) < 2,
      belowTrigger: r.top >= trg.bottom - 2,
    };
  })()
`);
console.log('  计划下拉弹层:', JSON.stringify(planPop));
checks.push(['A 计划下拉渲染了 optgroup 分组', !!planPop && planPop.groups.length > 0]);
checks.push(['A 当前项打了勾且只有一个', !!planPop && planPop.selected === 1 && planPop.ticks === 1]);
checks.push(['A 弹层完整落在视口内', !!planPop && planPop.inViewport]);
checks.push(['A 弹层与触发器左对齐', !!planPop && planPop.aligned]);
checks.push(['A 弹层在触发器下方', !!planPop && planPop.belowTrigger]);
await shotClip('test/_polish-1-dd-plan.png', '.dd-pop:not([hidden])', 10);

// 点第二项，看是否真的改了 select 并触发 change
const beforeVal = await evaluate(`document.getElementById('planSel').value`);
const afterClick = await evaluate(`
  (() => {
    const pop = document.querySelector('.dd-pop:not([hidden])');
    const items = [...pop.querySelectorAll('.dd-item')];
    const target = items.find(i => Number(i.dataset.i) !== document.getElementById('planSel').selectedIndex);
    if (!target) return null;
    const want = document.getElementById('planSel').options[Number(target.dataset.i)].textContent.trim();
    target.click();
    return { want, value: document.getElementById('planSel').value,
             label: document.querySelector('#planSel').parentElement.querySelector('.dd-label').textContent,
             popClosed: !document.querySelector('.dd-pop:not([hidden])') };
  })()
`);
console.log('  点击选项前 value =', JSON.stringify(beforeVal));
console.log('  点击选项后:', JSON.stringify(afterClick));
checks.push([
  'A 点选项能改 select.value 且触发器文案跟上',
  !!afterClick && afterClick.value !== beforeVal && afterClick.label === afterClick.want,
]);
checks.push(['A 选完自动收起', !!afterClick && afterClick.popClosed]);

// 还原成「全部题目」，避免影响后面的截图
await evaluate(`document.getElementById('planSel').value = ''; true;`);
await sleep(300);

// 点别处应该收起
await evaluate(`document.querySelector('#planSel').parentElement.querySelector('.dd-trigger').click()`);
await sleep(300);
const opened = await evaluate(`!!document.querySelector('.dd-pop:not([hidden])')`);
await evaluate(`document.body.click()`);
await sleep(300);
const closedByOutside = !(await evaluate(`!!document.querySelector('.dd-pop:not([hidden])')`));
console.log(`  打开=${opened} 点别处后收起=${closedByOutside}`);
checks.push(['A 点页面别处会收起弹层', opened && closedByOutside]);

// 键盘：Enter 开、ArrowDown 走、Enter 选中
const kbd = await evaluate(`
  (() => {
    const trg = document.querySelector('#planSel').parentElement.querySelector('.dd-trigger');
    trg.focus();
    const fire = (key) => trg.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
    fire('Enter');
    const openedByKey = !!document.querySelector('.dd-pop:not([hidden])');
    fire('ArrowDown');
    const hl = document.querySelector('.dd-pop:not([hidden]) .dd-item.hl')?.dataset.i;
    fire('Escape');
    return { openedByKey, hl, closed: !document.querySelector('.dd-pop:not([hidden])') };
  })()
`);
console.log('  键盘:', JSON.stringify(kbd));
checks.push(['A 键盘能开、能走、Esc 能收', kbd.openedByKey && kbd.hl != null && kbd.closed]);

// 左栏的「全部状态」下拉也截一张
await evaluate(`document.querySelector('#filterSel').parentElement.querySelector('.dd-trigger').click()`);
await sleep(500);
await shotClip('test/_polish-2-dd-filter.png', '#listPanel .panel-head', 10);
await evaluate(`document.body.click()`);
await sleep(300);

/* ---------------- B. 折叠符号 ---------------- */

console.log('\n=== B. 折叠符号 ===');
const chevGeo = await evaluate(`
  (() => {
    const out = [];
    const probe = (label, iconSel, hostSel) => {
      const icon = document.querySelector(iconSel);
      const host = document.querySelector(hostSel);
      if (!icon || !host) { out.push({ label, missing: true }); return; }
      const i = icon.getBoundingClientRect();
      const h = host.getBoundingClientRect();
      // 取 path 的真实包围盒，交叉验证"盒子中心 == 笔画中心"
      let bbox = null;
      try { const b = icon.getBBox(); bbox = { x: +b.x.toFixed(2), y: +b.y.toFixed(2), w: +b.width.toFixed(2), h: +b.height.toFixed(2) }; } catch {}
      out.push({
        label,
        off: +(i.y + i.height / 2 - (h.y + h.height / 2)).toFixed(2),
        offX: +(i.x + i.width / 2 - (h.x + h.width / 2)).toFixed(2),
        icon: { w: +i.width.toFixed(1), h: +i.height.toFixed(1) },
        hostH: +h.height.toFixed(1),
        dir: icon.classList.contains('to-right') ? 'right' : icon.classList.contains('to-left') ? 'left' : 'down',
        bbox,
      });
    };
    probe('左栏折叠', '#collapseList .chev', '#listPanel .panel-head');
    probe('题面折叠', '#collapseDesc .chev', '#descPanel .panel-head');
    probe('代码区折叠', '#collapseCode .chev', '#codePanel .panel-head');
    return out;
  })()
`);
for (const g of chevGeo) {
  if (g.missing) {
    console.log(`  ${g.label}: 找不到`);
    continue;
  }
  // path 的包围盒应该以 12,12 为中心（viewBox 24x24），即 bbox 中心 = 12
  const bcx = g.bbox ? +(g.bbox.x + g.bbox.w / 2).toFixed(2) : null;
  const bcy = g.bbox ? +(g.bbox.y + g.bbox.h / 2).toFixed(2) : null;
  console.log(
    `  ${g.label.padEnd(10)} 方向=${g.dir.padEnd(5)} 竖直偏差=${String(g.off).padStart(6)}px 水平偏差=${String(g.offX).padStart(6)}px  图标 ${g.icon.w}x${g.icon.h} 容器高 ${g.hostH}  path中心=(${bcx},${bcy})`,
  );
}
checks.push([
  'B 折叠箭头在标题栏里垂直居中（偏差 < 0.6px）',
  chevGeo.every((g) => !g.missing && Math.abs(g.off) < 0.6),
]);
checks.push([
  'B path 包围盒以下方中心对称（形状本身居中，不靠字体基线）',
  chevGeo.every((g) => g.bbox && Math.abs(g.bbox.x + g.bbox.w / 2 - 12) < 0.6),
]);

// 展开/收起是同一个形状的旋转（不是换字形）
const rot = await evaluate(`
  (() => {
    const t = document.getElementById('allPlansToggle');
    const svg = t.querySelector('.chev');
    const shape = () => svg.querySelector('path').getAttribute('d');
    const before = { cls: svg.getAttribute('class'), d: shape() };
    t.click();
    const after = { cls: svg.getAttribute('class'), d: shape() };
    t.click();
    return { before, after };
  })()
`);
console.log('  展开态:', JSON.stringify(rot.before));
console.log('  收起态:', JSON.stringify(rot.after));
checks.push(['B 两态形状不变、只换旋转 class', rot.before.d === rot.after.d && rot.before.cls !== rot.after.cls]);

/* ---------------- 截图 ---------------- */
console.log('\n=== 截图 ===');
await shotClip('test/_polish-3-head-list.png', '#listPanel .panel-head');
await shotClip('test/_polish-4-head-desc.png', '#descPanel .panel-head');
await shotClip('test/_polish-5-head-code.png', '#codePanel .panel-head');

// 收起三栏，看把手是否居中
await evaluate(`
  localStorage.setItem('lc-collapse-list','1');
  localStorage.setItem('lc-collapse-desc','1');
  localStorage.setItem('lc-collapse-code','1');
  localStorage.setItem('lc-code-lock','1');
  applyCollapse();
  true;
`);
await sleep(900);
const handleGeo = await evaluate(`
  (() => {
    const out = [];
    for (const id of ['reopenList','reopenDesc','reopenCode']) {
      const b = document.getElementById(id);
      if (!b || b.hidden) { out.push({ id, missing: true }); continue; }
      // 内容组（label + 箭头）的联合包围盒，看它在整条把手里的位置
      const kids = [...b.children].map(c => c.getBoundingClientRect());
      if (!kids.length) { out.push({ id, missing: true }); continue; }
      const top = Math.min(...kids.map(k => k.top));
      const bottom = Math.max(...kids.map(k => k.bottom));
      const br = b.getBoundingClientRect();
      out.push({
        id,
        hostTop: Math.round(br.top), hostH: Math.round(br.height),
        contentTop: Math.round(top), contentH: Math.round(bottom - top),
        upperGap: Math.round(top - br.top),
        lowerGap: Math.round(br.bottom - bottom),
      });
    }
    return out;
  })()
`);
console.log('\n=== 收起后的把手（内容是否居中）===');
for (const h of handleGeo) {
  if (h.missing) {
    console.log(`  ${h.id}: 不可见`);
    continue;
  }
  const centered = Math.abs(h.upperGap - h.lowerGap) <= 2;
  console.log(
    `  ${h.id.padEnd(12)} 把手高=${h.hostH} 内容高=${h.contentH} 上留白=${h.upperGap} 下留白=${h.lowerGap} ${centered ? '居中' : '★不居中★'}`,
  );
}
checks.push(['B 收起把手的内容上下居中（上下留白差 ≤2px）', handleGeo.every((h) => h.missing || Math.abs(h.upperGap - h.lowerGap) <= 2)]);
await shot('test/_polish-6-collapsed.png');

// 展开回来
await evaluate(`
  localStorage.setItem('lc-collapse-list','0');
  localStorage.setItem('lc-collapse-desc','0');
  localStorage.setItem('lc-collapse-code','0');
  applyCollapse();
  true;
`);
await sleep(700);

// 计划弹窗的小节标题
await evaluate(`openPlans()`);
await sleep(6500);
await shotClip('test/_polish-7-sec-toggle.png', '#allPlansSection .section-head');
const modalChev = await evaluate(`
  (() => {
    const t = document.getElementById('allPlansToggle');
    const svg = t.querySelector('.chev');
    const c = svg.getBoundingClientRect(), tb = t.getBoundingClientRect();
    return { off: +(c.y + c.height / 2 - (tb.y + tb.height / 2)).toFixed(2),
             textFirst: t.textContent.trim().slice(0, 8) };
  })()
`);
console.log('  计划弹窗折叠标题:', JSON.stringify(modalChev));
checks.push(['B 计划弹窗的箭头也居中', Math.abs(modalChev.off) < 0.6]);

const errs = consoleErrors;
chrome.kill();
try {
  fs.rmSync(profile, { recursive: true, force: true });
} catch {}

console.log('\n=== 结果 ===');
let fail = 0;
for (const [name, ok] of checks) {
  if (!ok) fail++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`);
}
console.log(`  ${errs.length === 0 ? 'PASS' : 'FAIL'}  无 JS 报错${errs.length ? ' → ' + errs.slice(0, 3).join(' | ') : ''}`);
console.log(`\n${fail === 0 && errs.length === 0 ? '全部通过' : '有失败项：' + fail}`);

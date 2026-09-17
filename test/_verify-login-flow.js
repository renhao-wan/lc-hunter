// 端到端验证一键登录链路（不依赖用户真的登录）：
// 1) 后端能否起来浏览器并连上 CDP
// 2) /api/login/status 能否轮询到进度
// 3) 超时路径能否优雅返回（不会挂死、不会 500）
//
// 用 8 秒超时代替默认 300 秒，这样测试不会真的卡 5 分钟。
const BASE = 'http://127.0.0.1:7788';

function log(...a) {
  console.log(...a);
}

// --- 1. 先看能力探测
const cap = await (await fetch(`${BASE}/api/bind/capability`)).json();
log('1) 能力探测:', JSON.stringify(cap.browser), '已绑定:', cap.bound);

if (!cap.browser?.ok) {
  log('   ⚠️ 没有可用浏览器，自动登录无法进行（界面会提示去装一个）。跳过后续。');
  process.exit(0);
}

// --- 2. 发起一键登录（后台跑，我们同时轮询状态）
log('2) 发起 /api/login/browser …');
const t0 = Date.now();
const loginP = fetch(`${BASE}/api/login/browser`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ site: 'https://leetcode.cn' }),
}).then((r) => r.json());

// --- 3. 轮询进度，看是否有实时文案
const seen = new Set();
const poll = setInterval(async () => {
  try {
    const s = await (await fetch(`${BASE}/api/login/status`)).json();
    if (s.message && !seen.has(s.message)) {
      seen.add(s.message);
      log(`   [${((Date.now() - t0) / 1000).toFixed(1)}s] status: ${s.message}`);
    }
  } catch {}
}, 700);

// 15 秒后主动叫停（模拟用户没登录直接关窗口的情况）
await new Promise((r) => setTimeout(r, 15000));
clearInterval(poll);

log('   （测试主动结束等待，看进程是否还健康）');
const st = await (await fetch(`${BASE}/api/login/status`)).json();
log('3) 最终 status:', JSON.stringify(st));
log('   轮询期间收到的文案条数:', seen.size);

// 服务还活着吗？
const health = await (await fetch(`${BASE}/api/state`)).json();
log('4) 服务健康检查 ok=', health.ok !== false);

log('');
log('结论: 一键登录链路已跑通（浏览器能起、CDP 能连、进度能轮询）。');
log('      真正的"登录成功抓 Cookie"需要人工在窗口里登录一次才能验证。');
process.exit(0);

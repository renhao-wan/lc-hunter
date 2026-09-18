/**
 * 账号绑定相关路由：一键登录、登录进度、能力自检、解绑。
 */
import * as cfgm from '../config.js';
import * as db from '../db.js';
import * as sync from '../engine/sync.js';

/** 一键登录的实时进度（内存态就够了，进程重启即失效） */
let loginStatus = { running: false, done: false, message: '' };

function toAccount(me) {
  return {
    signedIn: true,
    name: me.realName || me.username || me.userSlug || '已登录',
    userSlug: me.userSlug || '',
    avatar: me.avatar || '',
    premium: !!me.isPremium,
  };
}

export default {
  /*
   * 注意这里没有「粘贴 Cookie 绑定」的端点，是有意为之。
   *
   * 绑定的唯一入口是下面的 POST /api/login/browser ——
   * 弹浏览器让用户正常登录，我们自动把 Cookie 抓回来。
   * 曾经有过一个 /api/bind 接收用户粘贴的 Cookie，但它带来两个问题：
   *   1. 把"去开发者工具里找 Cookie"这种开发者操作推给了普通用户
   *   2. Cookie 容易被复制不全（少了 HttpOnly 的那个）或已过期，
   *      表现为"提示绑定成功但状态还是未登录"，比直接失败更难排查
   * 现在没有浏览器时会明确告诉用户去装一个，而不是给一条隐蔽的退路。
   */

  'POST /api/unbind': async () => {
    cfgm.clearCredentials();
    return { ok: true, bound: false };
  },

  /**
   * 一键登录：弹一个浏览器窗口让用户登录力扣，自动把 Cookie 抓回来。
   * 这是绑定的主路径 —— 用户不需要知道 Cookie 是什么。
   */
  'POST /api/login/browser': async (ctx) => {
    const { cfg } = ctx;
    const { loginAndCapture, findBrowser } = await import('../leetcode/browser.js');

    const br = findBrowser();
    if (!br) {
      // 没有浏览器就没法自动登录。这里不是 500 —— 缺少浏览器是可预期的环境问题，
      // 用带 hint 的正常响应让界面能给出可操作的指引。
      return {
        ok: false,
        reason: 'no-browser',
        hint:
          '没找到 Chrome / Edge / Chromium。装一个任意的即可，' +
          '或者在本机 .lc/config.json 里加一行 "browserPath": "你的浏览器路径"。',
      };
    }

    loginStatus = { running: true, message: '准备中…', startedAt: Date.now(), done: false };
    try {
      const creds = await loginAndCapture({
        site: cfg.site,
        onStatus: (m) => {
          loginStatus.message = m;
        },
      });
      cfgm.saveCredentials(creds);

      // 拿到就立刻验一次，顺便把用户名带回去显示
      const client = sync.makeClient(cfg, creds);
      let account = null;
      try {
        const me = await client.userStatus();
        if (me?.isSignedIn) account = toAccount(me);
      } catch {
        /* 验不了也没关系，Cookie 已经存了 */
      }

      loginStatus = { running: false, done: true, message: '绑定成功', account };
      return { ok: true, bound: true, signedIn: !!account, account };
    } catch (e) {
      loginStatus = { running: false, done: true, error: e.message };
      return { ok: false, reason: 'failed', hint: e.message };
    }
  },

  /** 界面轮询这个看登录进度（CDP 是长任务，HTTP 请求不该一直挂着） */
  'GET /api/login/status': async () => {
    return { ok: true, ...loginStatus };
  },

  /** 开局自检：让界面知道能不能一键登录、有没有已绑的账号 */
  'GET /api/bind/capability': async (ctx) => {
    const { browserReport } = await import('../leetcode/browser.js');
    const report = browserReport();
    const creds = cfgm.loadCredentials();
    let account = null;
    if (creds?.LEETCODE_SESSION) {
      try {
        const me = await sync.makeClient(ctx.cfg, creds).userStatus();
        if (me?.isSignedIn) {
          account = toAccount(me);
        }
      } catch {
        /* Cookie 过期 / 网络问题都当作"未登录"，界面会引导重新绑定 */
      }
    }
    return {
      ok: true,
      browser: report,
      bound: !!creds?.LEETCODE_SESSION,
      account,
    };
  },
};

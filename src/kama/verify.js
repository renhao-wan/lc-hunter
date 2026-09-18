/**
 * 绑定前的 IO 结构校验。
 *
 * 为什么要它：卡码网有大量「同名不同题」的改造版。
 * 典型例子：力扣 200「岛屿数量」是给你一个 grid 数连通块；
 * 卡码网 pid=1041 也叫「岛屿数量」，却是 addLand 动态加陆地、每次输出一次答案，
 * 输入是「m / n / k / 接下来 k 行坐标」。标题归一化后完全相等，自动匹配会直接绑错。
 *
 * 所以除了比标题，还要比「输入长什么样」：
 *   - 力扣全标量参数 → 卡码网输入示例首行的 token 数必须对得上参数个数
 *   - 力扣只有 1 个参数、但卡码网描述里出现「第一行 / 接下来 / 后续」→ 高度可疑
 *   - 力扣返回单个值、但卡码网输出示例是多行 → 可疑
 */

const SCALAR = /^(integer|int|long|string|double|float|boolean|character|char|number)$/i;
const MULTI_BLOCK = /第一行|第二行|第三行|接下来|随后|后续|下面\s*\d|共有?\s*\d+\s*行/;

function nonEmptyLines(s) {
  return String(s || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
}

/** metaData 可能是字符串也可能是对象 */
function parseMetaData(md) {
  if (!md) return null;
  if (typeof md === 'object') return md;
  try {
    return JSON.parse(md);
  } catch {
    return null;
  }
}

/**
 * @param {{metaData?: any, title_cn?: string}} problem 力扣题（hydrate 过的或 db row 都行）
 * @param {{inputDesc?: string, outputDesc?: string, inputExample?: string, outputExample?: string}} kama 卡码网题
 * @returns {{level:'ok'|'warn'|'bad', reasons: string[]}}
 */
export function checkIoCompat(problem, kama) {
  const reasons = [];
  const meta = parseMetaData(problem?.metaData ?? problem?.meta_data);
  const inLines = nonEmptyLines(kama?.inputExample);
  const outLines = nonEmptyLines(kama?.outputExample);

  if (!meta || !Array.isArray(meta.params) || meta.params.length === 0) {
    // 没有 metaData 就没法校验，不制造噪音
    return { level: 'ok', reasons: [] };
  }

  const params = meta.params;
  const types = params.map((p) => String(p?.type || ''));
  const allScalar = types.every((t) => SCALAR.test(t));
  const firstLine = inLines[0] || '';
  const tokens = firstLine.split(/\s+/).filter(Boolean);

  // 规则 1：全标量参数，首行 token 数必须等于参数个数
  if (allScalar) {
    if (inLines.length === 1 && tokens.length !== params.length) {
      reasons.push(
        `力扣有 ${params.length} 个参数（${params.map((p) => p.name).join(', ')}），` +
          `但卡码网输入示例首行是「${firstLine}」（${tokens.length} 个值）`
      );
    } else if (inLines.length > params.length) {
      reasons.push(
        `力扣只有 ${params.length} 个参数，但卡码网输入示例有 ${inLines.length} 行，像是分块输入`
      );
    }
  }

  // 规则 2：力扣单参数，卡码网却是「第一行…接下来…」的分块格式
  if (params.length === 1 && MULTI_BLOCK.test(kama?.inputDesc || '')) {
    reasons.push(
      `力扣只有 1 个参数（${params[0].name}），卡码网输入描述却是分块格式（含「第一行/接下来」这类措辞），很可能是厂商改造版`
    );
  }

  // 规则 3：返回值形态对不上
  const retType = String(meta?.return?.type || '');
  const retIsContainer = /\[\]|List|array|TreeNode|ListNode/i.test(retType);
  if (!retIsContainer && outLines.length > 1) {
    reasons.push(`力扣返回单个 ${retType || '值'}，卡码网输出示例却有 ${outLines.length} 行`);
  }

  // 规则 4：卡码网输出是多行，而力扣返回值是容器 —— 不强判定，只提示
  if (retIsContainer && outLines.length > 1 && /每次|依次|分别输出/.test(kama?.outputDesc || '')) {
    reasons.push('卡码网输出描述像是「逐次输出多个结果」，而力扣是一次性返回一个容器');
  }

  if (reasons.length === 0) return { level: 'ok', reasons: [] };
  // 命中规则 1/2（输入形态不符）算硬伤；只命中输出规则算提醒
  const hard = allScalar || params.length === 1;
  return { level: hard ? 'bad' : 'warn', reasons };
}

/** 把校验结果渲染成一两行提示（返回 null 表示没问题不用显示） */
export function formatIoCheck(res) {
  if (!res || res.level === 'ok' || !res.reasons?.length) return null;
  const icon = res.level === 'bad' ? '[!]' : '[?]';
  return res.reasons.map((r) => `${icon} ${r}`).join('\n');
}

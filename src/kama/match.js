/**
 * 力扣题目 ↔ 卡码网题目的标题匹配。
 *
 * 为什么只靠标题：两边都没有官方的对应关系，唯一稳定的公共信息就是中文题名。
 * 卡码网的题目大量是自研的（A+B 系列、模拟笔试），与力扣真正重合的可能只有一部分，
 * 所以匹配是"尽力而为"——给出候选并打分，宁可让人确认，也不要瞎绑。
 */

/** 归一化：去序号前缀、去空白标点、全角转半角、小写 */
export function normalizeTitle(t) {
  if (!t) return '';
  return String(t)
    .replace(/^\d+\s*[.、:：]\s*/, '') // "21. 构造二叉树" -> "构造二叉树"
    .replace(/[（(].*?[)）]/g, '') // 去掉括号备注，如"（第七期模拟笔试）"
    .replace(/[\s\-_·、,，。.！!？?：:；;'"“”‘’]/g, '')
    .replace(/[０-９Ａ-Ｚａ-ｚ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .toLowerCase()
    .trim();
}

/**
 * 打分：1 = 完全可信，0 = 完全不相关
 */
export function scoreMatch(lcTitle, kamaTitle) {
  const a = normalizeTitle(lcTitle);
  const b = normalizeTitle(kamaTitle);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.length >= 3 && b.includes(a)) return 0.8;
  if (b.length >= 3 && a.includes(b)) return 0.7;

  // 字面重合度（按字符 bigram），兜底用
  return bigramScore(a, b) * 0.6;
}

function bigrams(s) {
  const out = new Set();
  for (let i = 0; i + 1 < s.length; i++) out.add(s.slice(i, i + 2));
  return out;
}

function bigramScore(a, b) {
  const A = bigrams(a);
  const B = bigrams(b);
  if (A.size === 0 || B.size === 0) return 0;
  let hit = 0;
  for (const g of A) if (B.has(g)) hit++;
  return (2 * hit) / (A.size + B.size);
}

/**
 * 在一堆卡码网题目里找最像的。
 * @returns {Array<{pid,title,score}>} 按分数降序
 */
export function findCandidates(lcTitle, kamaList, { limit = 5, minScore = 0.5 } = {}) {
  const scored = [];
  for (const k of kamaList) {
    const s = scoreMatch(lcTitle, k.title);
    if (s >= minScore) scored.push({ pid: k.pid, title: k.title, score: Math.round(s * 100) / 100 });
  }
  scored.sort((x, y) => y.score - x.score);
  return scored.slice(0, limit);
}

/** 有唯一且高分的候选才算「自动可绑」 */
export function pickAuto(candidates, { threshold = 1 } = {}) {
  if (!candidates.length) return null;
  const top = candidates[0];
  if (top.score < threshold) return null;
  // 第二名同分 → 有歧义，不自动绑
  if (candidates.length > 1 && candidates[1].score >= top.score) return null;
  return top;
}

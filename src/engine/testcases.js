/**
 * 测试用例：从题面抽取（力扣只给输入，输出需要从示例里抓），
 * 以及 testcases.txt 的读写与结果比对。
 */

export function stripHtml(html) {
  if (!html) return '';
  return String(html)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\r/g, '');
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 把 "nums = [2,7,11,15], target = 9" 按参数名拆成 ["[2,7,11,15]", "9"]
 */
function splitParamValues(inputStr, names) {
  const hits = [];
  for (const n of names) {
    const re = new RegExp('(?:^|[,\\s\\uFF0C])' + escapeRe(n) + '\\s*=\\s*');
    const m = re.exec(inputStr);
    if (m) hits.push({ name: n, start: m.index + m[0].length, boundary: m.index });
  }
  hits.sort((a, b) => a.start - b.start);
  return hits.map((h, i) => {
    const end = i + 1 < hits.length ? hits[i + 1].boundary : inputStr.length;
    return inputStr
      .slice(h.start, end)
      .trim()
      .replace(/[,\uFF0C]+$/, '')
      .trim();
  });
}

/**
 * 从题面（力扣中文 content）里抽示例的输入/输出对。
 * 力扣只在题面里给出期望输出，API 不给，所以这是本地对拍的关键数据来源。
 */
export function extractExamplesFromContent(contentMd, metaData) {
  const text = stripHtml(contentMd);
  if (!text) return [];
  const lines = text.split('\n').map((l) => l.trim());

  const raw = [];
  let pending = null;
  for (const line of lines) {
    const inMatch = line.match(/^输入[：:]\s*(.*)$/);
    const outMatch = line.match(/^输出[：:]\s*(.*)$/);
    if (inMatch) {
      pending = { inputRaw: inMatch[1].trim(), outputRaw: null };
    } else if (outMatch && pending) {
      pending.outputRaw = outMatch[1].trim();
      raw.push(pending);
      pending = null;
    }
  }

  const names = (metaData?.params || []).map((p) => p.name);
  const cases = [];
  for (const r of raw) {
    if (!r.outputRaw) continue;
    let input;
    if (names.length === 0) {
      input = r.inputRaw;
    } else if (names.length === 1 && !r.inputRaw.includes('=')) {
      input = r.inputRaw;
    } else {
      const vals = splitParamValues(r.inputRaw, names);
      input = vals.length === names.length ? vals.join('\n') : null;
    }
    if (!input) continue;
    cases.push({ input, output: r.outputRaw, source: 'statement' });
  }
  return cases;
}

/**
 * 用 sampleTestCase 兜底：力扣的 sampleTestCase 是"每个参数一行"，
 * 但只有输入没有输出，因此只作为"能跑起来"的冒烟用例。
 */
export function casesFromSample(sampleTestCase) {
  if (!sampleTestCase) return [];
  return [{ input: String(sampleTestCase), output: null, source: 'sample' }];
}

/** 序列化成可手写的文本格式 */
export function formatTestcases(cases) {
  return cases
    .map((c, i) => {
      const head = `# 用例 ${i + 1}${c.source ? `（来源: ${c.source}）` : ''}`;
      const out = c.output == null ? '' : c.output;
      return `${head}\n[in]\n${c.input}\n[out]\n${out}`;
    })
    .join('\n\n');
}

export function parseTestcases(txt) {
  const cases = [];
  if (!txt) return cases;
  const blocks = txt.split(/\[in\]/).slice(1);
  for (const b of blocks) {
    const idx = b.indexOf('[out]');
    if (idx < 0) continue;
    const input = b.slice(0, idx).replace(/^\s*\n/, '').replace(/\s+$/, '');
    const rest = b.slice(idx + 5);
    const nl = rest.indexOf('\n#');
    const output = (nl >= 0 ? rest.slice(0, nl) : rest).replace(/^\s*\n/, '').replace(/\s+$/, '');
    cases.push({ input, output: output === '' ? null : output });
  }
  return cases;
}

/** 数值容错比对（力扣对 double 有精度容忍） */
function normalizeToken(t) {
  return String(t).trim().replace(/^"(.*)"$/, '$1');
}

/** 空串和 "null" 都不算数字——否则 Number('') === 0 会把 [] 误判成 [0] */
function numOrNaN(t) {
  const s = String(t).trim();
  if (s === '' || s.toLowerCase() === 'null') return NaN;
  return Number(s);
}

export function compareOutput(actual, expected) {
  if (expected == null || expected === '') return null; // 无期望值，不做判定
  const a = String(actual).trim();
  const b = String(expected).trim();
  if (a === b) return true;

  const strip = (s) => s.replace(/^\[/, '').replace(/\]$/, '');
  const ta = strip(a).split(',').map(normalizeToken);
  const tb = strip(b).split(',').map(normalizeToken);
  if (ta.length !== tb.length) return false;
  for (let i = 0; i < ta.length; i++) {
    const na = numOrNaN(ta[i]);
    const nb = numOrNaN(tb[i]);
    if (!Number.isNaN(na) && !Number.isNaN(nb)) {
      if (Math.abs(na - nb) > 1e-6) return false;
    } else if (ta[i] !== tb[i]) {
      return false;
    }
  }
  return true;
}

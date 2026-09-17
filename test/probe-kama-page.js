// dump 卡码网题目页里所有 h6 小节及其原始 HTML，排查解析错位
import fs from 'node:fs';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const pid = process.argv[2] || '1067';
const out = [];

const res = await fetch(`https://kamacoder.com/problempage.php?pid=${pid}`, {
  headers: { 'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9' },
});
const html = await res.text();
out.push(`pid=${pid} HTTP=${res.status} len=${html.length}`);

// 所有 h6
const h6s = [...html.matchAll(/<h6[^>]*>([\s\S]{0,80}?)<\/h6>/g)];
out.push(`\n## h6 count=${h6s.length}`);
h6s.forEach((m, i) => out.push(`  [${i}] "${m[1].replace(/<[^>]+>/g, '').trim()}"`));

// 每个 h6 之后 400 字符
out.push('\n## h6 contexts');
h6s.forEach((m, i) => {
  const rest = html.slice(m.index, m.index + 500);
  out.push(`\n--- [${i}] ${m[1].replace(/<[^>]+>/g, '').trim()}`);
  out.push('    ' + rest.replace(/\s+/g, ' ').slice(0, 420));
});

// quote 块数量
const quotes = [...html.matchAll(/<div class="quote">/g)];
out.push(`\n## quote blocks=${quotes.length}`);

fs.writeFileSync(process.argv[3] || 'kama-page.txt', out.join('\n'), 'utf8');

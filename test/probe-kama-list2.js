// 分析卡码网题库页结构：标题-pid 配对、分页、分类
import fs from 'node:fs';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const out = [];
const res = await fetch('https://kamacoder.com/problemset.php', {
  headers: { 'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9' },
});
const html = await res.text();
out.push(`HTTP ${res.status} len=${html.length}`);

// 1) 标题-pid 配对
const pairs = [...html.matchAll(/<a[^>]+href="problempage\.php\?pid=(\d+)"[^>]*>([\s\S]{0,200}?)<\/a>/g)];
out.push(`\n## anchor pairs = ${pairs.length}`);
for (const m of pairs.slice(0, 8)) {
  out.push(`  pid=${m[1]}  raw=${m[2].replace(/\s+/g, ' ').trim().slice(0, 120)}`);
}

// 2) 所有其它站内链接（找分页/分类）
const links = [...new Set([...html.matchAll(/href="([^"]+\.php[^"]*)"/g)].map((m) => m[1]))];
out.push(`\n## php links (${links.length})`);
for (const l of links.slice(0, 60)) out.push('  ' + l);

// 3) 分页关键词
for (const kw of ['下一页', 'page=', 'pagination', '分页', '共']) {
  const i = html.indexOf(kw);
  out.push(`\n## kw="${kw}" idx=${i}`);
  if (i >= 0) out.push('   ' + html.slice(Math.max(0, i - 200), i + 200).replace(/\s+/g, ' '));
}

// 4) 标题附近结构（第一条的上下文）
const i0 = html.indexOf('problempage.php?pid=');
out.push('\n## first anchor context');
out.push(html.slice(Math.max(0, i0 - 600), i0 + 400).replace(/\s+/g, ' '));

fs.writeFileSync(process.argv[2] || 'kama-list2.txt', out.join('\n'), 'utf8');

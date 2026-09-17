// 探测卡码网是否有可爬的题库列表 / 搜索接口（结果写入文件，避免 PowerShell 捕获乱码）
import fs from 'node:fs';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const urls = [
  'https://kamacoder.com/',
  'https://kamacoder.com/problemlist.php',
  'https://kamacoder.com/problemset.php',
  'https://kamacoder.com/problem.php',
  'https://kamacoder.com/problemlist.php?page=1',
  'https://kamacoder.com/problems.php',
  'https://kamacoder.com/sitemap.xml',
  'https://kamacoder.com/robots.txt',
];

const out = [];
for (const url of urls) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 10000);
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9' },
      redirect: 'follow',
      signal: ctrl.signal,
    });
    clearTimeout(t);
    const text = await res.text();
    out.push(`### ${url}`);
    out.push(`    HTTP ${res.status}  len=${text.length}  final=${res.url}`);
    const pids = [...text.matchAll(/problempage\.php\?pid=(\d+)/g)].map((m) => m[1]);
    const uniq = [...new Set(pids)];
    out.push(`    pidLinks=${uniq.length} sample=${uniq.slice(0, 15).join(',')}`);
    if (res.status === 200 && text.length < 2000) {
      out.push('    body: ' + text.replace(/\s+/g, ' ').slice(0, 800));
    }
    out.push('');
  } catch (e) {
    out.push(`### ${url}`);
    out.push(`    FAILED: ${e.message}`);
    out.push('');
  }
  await new Promise((r) => setTimeout(r, 500));
}

fs.writeFileSync(process.argv[2] || 'kama-list-probe.txt', out.join('\n'), 'utf8');

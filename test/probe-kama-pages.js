// 逐页统计卡码网题库条目数，确认索引没有漏页
import fs from 'node:fs';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const out = [];

for (let page = 1; page <= 16; page++) {
  const url = `https://kamacoder.com/problemset.php?page=${page}`;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 12000);
    const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: ctrl.signal });
    clearTimeout(t);
    const html = await res.text();
    const pids = [...new Set([...html.matchAll(/href="problempage\.php\?pid=(\d+)"[^>]*>([\s\S]{0,160}?)<\/a>/g)].map((m) => m[1]))];
    const titles = [...html.matchAll(/href="problempage\.php\?pid=(\d+)"[^>]*>([\s\S]{0,160}?)<\/a>/g)]
      .map((m) => m[2].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim())
      .filter(Boolean);
    out.push(`page=${String(page).padStart(2)}  HTTP ${res.status}  len=${html.length}  items=${pids.length}  first="${titles[0] || ''}"  last="${titles[titles.length - 1] || ''}"`);
  } catch (e) {
    out.push(`page=${page}  FAILED ${e.message}`);
  }
  await new Promise((r) => setTimeout(r, 500));
}

fs.writeFileSync(process.argv[2] || 'kama-pages.txt', out.join('\n'), 'utf8');

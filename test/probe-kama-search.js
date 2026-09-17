// 验证卡码网 problemset.php?search= 能否按中文题名搜索，并确定题库总页数
import fs from 'node:fs';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const out = [];

async function get(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 12000);
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9' }, signal: ctrl.signal });
    const text = await res.text();
    return { status: res.status, text };
  } finally {
    clearTimeout(t);
  }
}

function parseList(html) {
  return [...html.matchAll(/href="problempage\.php\?pid=(\d+)"[^>]*>([\s\S]{0,120}?)<\/a>/g)].map((m) => ({
    pid: m[1],
    title: m[2].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim(),
  }));
}

function maxPage(html) {
  const pages = [...html.matchAll(/problemset\.php\?page=(\d+)/g)].map((m) => Number(m[1]));
  return pages.length ? Math.max(...pages) : 1;
}

// 1) 搜索
for (const kw of ['两数之和', '反转链表', '最长回文子串', '二叉树']) {
  const url = `https://kamacoder.com/problemset.php?search=${encodeURIComponent(kw)}`;
  const { status, text } = await get(url);
  const items = parseList(text);
  out.push(`## search="${kw}"  HTTP ${status}  hits=${items.length}`);
  items.slice(0, 8).forEach((i) => out.push(`   pid=${i.pid}  ${i.title}`));
  out.push('');
  await new Promise((r) => setTimeout(r, 600));
}

// 2) 总页数
{
  const { status, text } = await get('https://kamacoder.com/problemset.php?page=1');
  out.push(`## page1 HTTP ${status} items=${parseList(text).length} maxPageLink=${maxPage(text)}`);
  await new Promise((r) => setTimeout(r, 600));
  const { text: t2 } = await get('https://kamacoder.com/problemset.php?page=99');
  out.push(`## page99 items=${parseList(t2).length} maxPageLink=${maxPage(t2)}`);
}

fs.writeFileSync(process.argv[2] || 'kama-search.txt', out.join('\n'), 'utf8');

// 在卡码网页面里定位"输入/输出描述"与"示例"的结构
const pid = process.argv[2] || '1002';
const url = `https://kamacoder.com/problempage.php?pid=${pid}`;
const res = await fetch(url, {
  headers: {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'Accept-Language': 'zh-CN,zh;q=0.9',
  },
});
const text = await res.text();
console.log('HTTP', res.status, 'len', text.length);

const keywords = ['输入描述', '输出描述', '输入示例', '输出示例', '提示', '题目描述', 'js-md'];
for (const k of keywords) {
  const idxs = [];
  let i = text.indexOf(k);
  while (i >= 0 && idxs.length < 5) {
    idxs.push(i);
    i = text.indexOf(k, i + 1);
  }
  console.log(`\n##### ${k}  出现 ${idxs.length} 次`);
  for (const idx of idxs.slice(0, 2)) {
    console.log('---context---');
    console.log(text.slice(Math.max(0, idx - 400), idx + 400).replace(/\s+/g, ' '));
  }
}

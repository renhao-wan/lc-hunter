// 探测卡码网题目页结构（服务端渲染的纯 HTML），为 ACM 权威 IO 抓取做准备
const pids = process.argv.slice(2);
const list = pids.length ? pids : ['1002', '1003', '1004'];

for (const pid of list) {
  const url = `https://kamacoder.com/problempage.php?pid=${pid}`;
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        'Accept-Language': 'zh-CN,zh;q=0.9',
      },
    });
    const text = await res.text();
    console.log(`=== pid=${pid} HTTP ${res.status} len=${text.length} ===`);
    // 打印头 2000 字符，够看出结构
    console.log(text.slice(0, 2000));
    console.log('');
  } catch (e) {
    console.log(`=== pid=${pid} FAILED: ${e.message} ===`);
  }
  await new Promise((r) => setTimeout(r, 800));
}

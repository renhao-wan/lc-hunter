// 静态一致性检查：app.js 里引用的每个元素 id 都必须在 index.html 里存在。
// 这类"JS 里写了 id 但 HTML 没这个元素"的问题在运行时表现为
// "Cannot set properties of null"，而且往往只在某个分支才触发，很难靠手点发现。
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const html = fs.readFileSync(path.join(root, 'web/index.html'), 'utf8');
const js = fs.readFileSync(path.join(root, 'web/app.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'web/style.css'), 'utf8');

// HTML 里定义的所有 id
const htmlIds = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));

// app.js 里引用的 id：$('x') / getElementById('x')
const used = new Set();
for (const m of js.matchAll(/\$\('([^']+)'\)/g)) used.add(m[1]);
for (const m of js.matchAll(/getElementById\('([^']+)'\)/g)) used.add(m[1]);
// querySelector('#x') 也一起查
for (const m of js.matchAll(/querySelector\('#([A-Za-z0-9_-]+)'\)/g)) used.add(m[1]);

// JS 里动态插入到 innerHTML 的 id 也算已定义（比如计划卡片）
const jsInlineIds = new Set([...js.matchAll(/\bid="([A-Za-z0-9_-]+)"/g)].map((m) => m[1]));
// 也可能是 createElement 之后赋 id
for (const m of js.matchAll(/\.id\s*=\s*'([A-Za-z0-9_-]+)'/g)) jsInlineIds.add(m[1]);

const missing = [...used].filter((id) => !htmlIds.has(id) && !jsInlineIds.has(id));
const unused = [...htmlIds].filter((id) => !used.has(id) && !jsInlineIds.has(id));

console.log(`HTML 定义 id: ${htmlIds.size} 个`);
console.log(`app.js 引用 id: ${used.size} 个`);
console.log('');
if (missing.length) {
  console.log('❌ app.js 引用了但 HTML/JS 里都不存在的 id:');
  for (const id of missing) console.log('   - ' + id);
} else {
  console.log('✅ app.js 引用的 id 全部存在');
}

if (unused.length) {
  console.log('');
  console.log('ℹ️  HTML 里有、但 app.js 没引用的 id（可能被别的脚本用，或已废弃）:');
  for (const id of unused) console.log('   - ' + id);
}

// CSS 类名抽查：JS 里 add/remove/className 用到的关键类是否在 css 里有定义
const jsClasses = new Set();
for (const m of js.matchAll(/className\s*=\s*['"]([^'"]+)['"]/g)) {
  for (const c of m[1].split(/\s+/)) if (c) jsClasses.add(c);
}
const cssClasses = new Set([...css.matchAll(/\.([A-Za-z][A-Za-z0-9_-]*)/g)].map((m) => m[1]));
const noStyle = [...jsClasses].filter((c) => !cssClasses.has(c));
if (noStyle.length) {
  console.log('');
  console.log('ℹ️  JS 里设置了 className 但 css 里没找到的类（不一定是问题）:');
  for (const c of noStyle) console.log('   - ' + c);
}

process.exit(missing.length ? 1 : 0);

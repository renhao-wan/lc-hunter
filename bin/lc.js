#!/usr/bin/env node
/**
 * 启动器。
 * 1) 屏蔽 node:sqlite 的 ExperimentalWarning（每次启动都打印太吵）
 * 2) 再交棒给 src/cli.js
 */
process.removeAllListeners('warning');
process.on('warning', (w) => {
  if (w && w.name === 'ExperimentalWarning' && /SQLite/i.test(w.message || '')) return;
  console.warn(w);
});

const { main } = await import('../src/cli.js');
const code = await main(process.argv.slice(2));
process.exit(code);

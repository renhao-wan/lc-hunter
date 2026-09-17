/*
 * 截图工具：本环境 bash 缺 dirname/sed，agent-browser 的 shell wrapper 跑不起来，
 * 所以直接 spawn JS 入口，并把 stdout 落到文件里（PowerShell 抓不到原生命令输出）。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';

const NODE = 'C:/Users/Lenovo/.workbuddy/binaries/node/versions/22.22.2-3/node.exe';
const CLI = 'D:/nodejs/GlobalNodeModules/node_modules/agent-browser/bin/agent-browser.js';

const args = process.argv.slice(2);

function run(argv) {
  return new Promise((resolve) => {
    const p = spawn(NODE, [CLI, ...argv], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('close', (code) => resolve({ code, out, err }));
  });
}

const results = [];
for (const step of args.length ? [args] : []) {
  const r = await run(step);
  results.push({ step: step.join(' '), code: r.code, out: r.out, err: r.err });
}
fs.writeFileSync('test/_shot.out.txt', JSON.stringify(results, null, 1), 'utf8');
console.log('done');

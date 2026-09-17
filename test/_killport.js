/* 杀掉占用指定端口的进程（改完 src/ 后重启 UI 用）。用法: node test/_killport.js 7788 */
import { execFileSync } from 'node:child_process';

const PORT = Number(process.argv[2] || 7788);
let pid = null;
try {
  const out = execFileSync('netstat', ['-ano'], { encoding: 'utf8' });
  for (const line of out.split(/\r?\n/)) {
    if (line.includes(`:${PORT}`) && /LISTEN/i.test(line)) {
      const parts = line.trim().split(/\s+/);
      pid = parts[parts.length - 1];
      break;
    }
  }
} catch (e) {
  console.log('netstat 失败:', e.message);
}

if (!pid) {
  console.log(`端口 ${PORT} 无监听进程`);
  process.exit(0);
}
console.log(`端口 ${PORT} 被 PID ${pid} 占用，结束它`);
try {
  execFileSync('taskkill', ['/PID', pid, '/F'], { stdio: 'inherit' });
  console.log('已结束');
} catch (e) {
  console.log('taskkill 失败:', e.message);
}

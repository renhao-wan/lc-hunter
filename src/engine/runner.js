import fs from 'node:fs';
import path from 'node:path';
import { parseTestcases, compareOutput } from './testcases.js';

/**
 * 编译并跑工作区里的所有用例。
 * 关键：javac 只编译一次，多组用例循环喂 stdin（Java 编译约 1s，逐用例编译会很慢）。
 */
export async function runWorkspace(dir, { cfg, profile, timeoutMs = 10000 } = {}) {
  const tcPath = path.join(dir, 'testcases.txt');
  if (!fs.existsSync(tcPath)) {
    return { ok: false, error: '缺少 testcases.txt', results: [] };
  }
  const cases = parseTestcases(fs.readFileSync(tcPath, 'utf8'));

  const build = await profile.build(dir, cfg);
  if (!build.ok) {
    return { ok: false, build, results: [] };
  }

  const results = [];
  for (let i = 0; i < cases.length; i++) {
    const c = cases[i];
    const r = await profile.run(dir, c.input + '\n', { ...cfg, timeoutMs });
    const actual = (r.stdout || '').trim();
    results.push({
      index: i + 1,
      input: c.input,
      expected: c.output,
      actual,
      ran: r.ok,
      stderr: r.stderr || '',
      ms: r.ms,
      pass: compareOutput(actual, c.output),
    });
  }

  const judged = results.filter((r) => r.pass !== null);
  return {
    ok: true,
    build,
    results,
    summary: {
      total: results.length,
      ran: results.filter((r) => r.ran).length,
      passed: judged.filter((r) => r.pass === true).length,
      failed: judged.filter((r) => r.pass === false).length,
      pending: results.filter((r) => r.pass === null).length,
    },
  };
}

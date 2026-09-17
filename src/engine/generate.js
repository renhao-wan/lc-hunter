import fs from 'node:fs';
import path from 'node:path';
import { resolveWorkspace } from '../config.js';
import { copyRuntime } from '../lang/index.js';
import { extractExamplesFromContent, casesFromSample, formatTestcases, stripHtml } from './testcases.js';

export function hydrateProblem(row) {
  return {
    ...row,
    codeSnippets: row.code_snippets ? JSON.parse(row.code_snippets) : [],
    metaData: row.meta_data ? JSON.parse(row.meta_data) : null,
    tags: row.tags ? JSON.parse(row.tags) : [],
  };
}

export function problemDirName(q) {
  const id = String(q.frontend_id || q.frontendId || '0000').padStart(4, '0');
  return `${id}-${q.slug}`;
}

export function problemDir(q, cfg) {
  return path.join(resolveWorkspace(cfg), problemDirName(q));
}

function buildReadme(q, { level, notes, kama }) {
  const title = q.title_cn || q.title_en || q.slug;
  const diffMap = { EASY: '简单', MEDIUM: '中等', HARD: '困难' };
  const diff = diffMap[String(q.difficulty).toUpperCase()] || q.difficulty || '-';
  const tags = (q.tags || []).join('、');
  const body = stripHtml(q.content_md || '(题面未拉取，执行 lc fetch 获取)').trim();

  const lines = [];
  lines.push(`# ${q.frontend_id || ''}. ${title}`);
  lines.push('');
  lines.push(`- 难度：${diff}　- 标签：${tags || '-'}`);
  lines.push(`- 链接：${'https://leetcode.cn/problems/' + q.slug + '/'}`);
  lines.push(`- ACM 模板等级：${level}${level === 'L1' ? '（卡码网权威 IO 描述）' : level === 'L2' ? '（metaData 自动生成）' : '（仅核心模式）'}`);
  if (notes && notes.length) lines.push(`- 提示：${notes.join('；')}`);
  lines.push('');
  lines.push('## 题面');
  lines.push('');
  lines.push(body);
  if (kama) {
    lines.push('');
    lines.push('## ACM 输入输出说明（卡码网）');
    lines.push('');
    lines.push('**输入**：');
    lines.push('');
    lines.push(kama.inputDesc || '-');
    lines.push('');
    lines.push('**输出**：');
    lines.push('');
    lines.push(kama.outputDesc || '-');
    if (kama.inputExample) {
      lines.push('');
      lines.push('**输入示例**：');
      lines.push('');
      lines.push('```');
      lines.push(kama.inputExample);
      lines.push('```');
      lines.push('');
      lines.push('**输出示例**：');
      lines.push('');
      lines.push('```');
      lines.push(kama.outputExample || '-');
      lines.push('```');
    }
  }
  lines.push('');
  return lines.join('\n');
}

/**
 * 生成题目工作区。
 * @param {object} q 已 hydrate 的题目
 * @param {object} opts { cfg, profile, modes:['core','acm'], force }
 */
export async function generateWorkspace(q, { cfg, profile, modes = ['core', 'acm'], force = false, resetSolution = false, refreshAcm = false }) {
  const dir = problemDir(q, cfg);
  fs.mkdirSync(dir, { recursive: true });

  const written = [];
  const notes = [];
  let level = 'L3';
  let kama = null;

  if (q.acm_source === 'kama' && q.kama_input_desc) {
    kama = {
      inputDesc: q.kama_input_desc,
      outputDesc: q.kama_output_desc,
      inputExample: q.kama_input_example,
      outputExample: q.kama_output_example,
    };
  }

  const write = (file) => {
    const dest = path.join(dir, file.path);
    const exists = fs.existsSync(dest);

    // 解法文件永远受保护：只有显式 resetSolution 才覆盖，避免 --force 冲掉你写的代码
    if (file.protect && !resetSolution && exists) {
      notes.push(`已存在，保留你的代码: ${file.path}`);
      return;
    }

    // 运行时辅助类由工具拥有，永远同步（否则升级后旧副本会把编译搞挂）
    if (file.toolOwned) {
      if (file.copyFrom) copyRuntime(file.copyFrom, dir);
      else fs.writeFileSync(dest, file.content, 'utf8');
      written.push(file.path);
      return;
    }

    // 按规格生成的模板（Main.java）：默认不覆盖你的手改，但绑定/解绑卡码网这种
    // 规格变更时必须重写 —— 重写前先留一份 .bak，避免手写的解析逻辑丢了
    if (file.specDriven && exists) {
      if (!force && !refreshAcm) {
        notes.push(`已存在，跳过（避免覆盖你的代码）: ${file.path}`);
        return;
      }
      const old = fs.readFileSync(dest, 'utf8');
      if (old !== file.content) {
        fs.writeFileSync(dest + '.bak', old, 'utf8');
        notes.push(`已重写（旧版备份为 ${file.path}.bak）: ${file.path}`);
      }
    }

    if (!force && !file.specDriven && exists && file.path.endsWith(profile.fileExt)) {
      notes.push(`已存在，跳过（避免覆盖你的代码）: ${file.path}`);
      return;
    }
    if (file.copyFrom) {
      copyRuntime(file.copyFrom, dir);
      written.push(path.basename(file.copyFrom));
    } else {
      fs.writeFileSync(dest, file.content, 'utf8');
      written.push(file.path);
    }
  };

  if (modes.includes('core')) {
    const core = profile.renderCore(q);
    if (core.ok) core.files.forEach(write);
    else notes.push(...(core.notes || []));
  }

  if (modes.includes('acm')) {
    const acm = profile.renderAcm(q, { kama });
    level = acm.level || 'L3';
    if (acm.ok) acm.files.forEach(write);
    notes.push(...(acm.notes || []));
  }

  // 测试用例优先级：
  //   1) 卡码网权威样例（格式与它的输入描述严格对应，是笔试用例的正确来源）
  //   2) 力扣题面示例（有期望输出，可对拍）
  //   3) 力扣 sampleTestCase（只有输入，只能冒烟）
  let cases = [];
  if (kama && kama.inputExample) {
    cases = [{ input: kama.inputExample, output: kama.outputExample || null, source: 'kama' }];
  }
  if (cases.length === 0) cases = extractExamplesFromContent(q.content_md, q.metaData);
  if (cases.length === 0) cases = casesFromSample(q.sample_testcase);
  fs.writeFileSync(path.join(dir, 'testcases.txt'), formatTestcases(cases), 'utf8');
  written.push('testcases.txt');

  fs.writeFileSync(path.join(dir, 'README.md'), buildReadme(q, { level, notes, kama }), 'utf8');
  written.push('README.md');

  fs.writeFileSync(
    path.join(dir, '.meta.json'),
    JSON.stringify(
      { slug: q.slug, frontendId: q.frontend_id, difficulty: q.difficulty, acmLevel: level, generatedAt: Date.now() },
      null,
      2,
    ),
    'utf8',
  );
  written.push('.meta.json');

  return { dir, written, notes, level, cases: cases.length };
}

export function loadWorkspaceMeta(dir) {
  const p = path.join(dir, '.meta.json');
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null;
}

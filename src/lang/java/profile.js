import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { LanguageProfile, copyRuntime } from '../index.js';

const RUNTIME = 'java/runtime/LeetCodeIO.java';

/**
 * 把力扣 metaData 的类型串映射成 Java 类型 + 读取表达式。
 * 返回 null 表示暂不支持（调用方降级到 L3：只给核心代码模式）。
 */
function resolveType(rawType) {
  if (!rawType) return null;
  const t = String(rawType).toLowerCase().replace(/\s+/g, '');
  const L = 'LeetCodeIO.nextLine()';

  const table = {
    integer: ['int', `Integer.parseInt(${L})`],
    int: ['int', `Integer.parseInt(${L})`],
    long: ['long', `Long.parseLong(${L})`],
    double: ['double', `Double.parseDouble(${L})`],
    float: ['double', `Double.parseDouble(${L})`],
    boolean: ['boolean', `Boolean.parseBoolean(${L})`],
    bool: ['boolean', `Boolean.parseBoolean(${L})`],
    character: ['char', `LeetCodeIO.parseChar(${L})`],
    char: ['char', `LeetCodeIO.parseChar(${L})`],
    string: ['String', `LeetCodeIO.parseString(${L})`],

    'integer[]': ['int[]', `LeetCodeIO.parseIntArray(${L})`],
    'int[]': ['int[]', `LeetCodeIO.parseIntArray(${L})`],
    'long[]': ['long[]', `LeetCodeIO.parseLongArray(${L})`],
    'double[]': ['double[]', `LeetCodeIO.parseDoubleArray(${L})`],
    'boolean[]': ['boolean[]', `LeetCodeIO.parseBooleanArray(${L})`],
    'character[]': ['char[]', `LeetCodeIO.parseCharArray(${L})`],
    'char[]': ['char[]', `LeetCodeIO.parseCharArray(${L})`],
    'string[]': ['String[]', `LeetCodeIO.parseStringArray(${L})`],

    'integer[][]': ['int[][]', `LeetCodeIO.parseIntMatrix(${L})`],
    'int[][]': ['int[][]', `LeetCodeIO.parseIntMatrix(${L})`],
    'long[][]': ['long[][]', `LeetCodeIO.parseIntMatrix(${L}).length == 0 ? new long[0][] : null`],
    'character[][]': ['char[][]', `LeetCodeIO.parseCharMatrix(${L})`],
    'char[][]': ['char[][]', `LeetCodeIO.parseCharMatrix(${L})`],
    'string[][]': ['String[][]', `LeetCodeIO.parseStringMatrix(${L})`],

    'list<integer>': ['List<Integer>', `LeetCodeIO.parseIntList(${L})`],
    'list<string>': [
      'List<String>',
      `new java.util.ArrayList<>(java.util.Arrays.asList(LeetCodeIO.parseStringArray(${L})))`,
    ],
    'list<list<integer>>': ['List<List<Integer>>', `LeetCodeIO.parseIntListList(${L})`],

    listnode: ['ListNode', `LeetCodeIO.buildList(LeetCodeIO.parseIntArray(${L}))`],
    treenode: ['TreeNode', `LeetCodeIO.buildTree(LeetCodeIO.parseIntegerBoxedArray(${L}))`],
  };

  const hit = table[t];
  if (!hit) return null;
  return { javaType: hit[0], parse: hit[1] };
}

const LIST_NODE_SRC = `class ListNode {
    int val;
    ListNode next;
    ListNode() {}
    ListNode(int val) { this.val = val; }
    ListNode(int val, ListNode next) { this.val = val; this.next = next; }
}
`;

const TREE_NODE_SRC = `class TreeNode {
    int val;
    TreeNode left;
    TreeNode right;
    TreeNode() {}
    TreeNode(int val) { this.val = val; }
    TreeNode(int val, TreeNode left, TreeNode right) {
        this.val = val; this.left = left; this.right = right;
    }
}
`;

function ensureImports(code) {
  if (/^\s*import\s+/m.test(code)) return code;
  return `import java.util.*;\nimport java.io.*;\n\n${code}`;
}

/** 空方法体的默认返回值：让脚手架能编译，跑出来是 FAIL 而不是编译错误 */
function defaultExpr(javaType) {
  const t = String(javaType || '').replace(/\s+/g, '');
  if (!t || t === 'void') return null;
  if (t === 'int' || t === 'Integer') return '0';
  if (t === 'long' || t === 'Long') return '0L';
  if (t === 'double' || t === 'float' || t === 'Double') return '0.0';
  if (t === 'boolean' || t === 'Boolean') return 'false';
  if (t === 'char' || t === 'Character') return "' '";
  return 'null';
}

/** 从 metaData 推断返回值的 Java 类型（void / 未知返回 null） */
function metaReturnType(q) {
  const raw = q?.metaData?.return?.type;
  if (!raw || raw === 'void') return null;
  const r = resolveType(raw);
  return r ? r.javaType : null;
}

/**
 * 给空方法体注入 TODO + 默认返回。
 * 力扣官方代码片段本身是不完整的（提交空体会 Compile Error），
 * 本地跑需要先让它能编译，否则用户看到的是满屏编译错误而不是 FAIL。
 */
function injectStub(code, javaReturnType) {
  const expr = defaultExpr(javaReturnType);
  if (expr === null) return code;
  return code.replace(
    /\)\s*\{\s*\n[ \t]*\n(\s*)\}/,
    `) {\n        // TODO: 在这里写你的解法\n        return ${expr};\n$1}`,
  );
}

export function createProfile() {
  return new JavaProfile();
}

class JavaProfile extends LanguageProfile {
  get id() {
    return 'java';
  }
  get displayName() {
    return 'Java';
  }
  get fileExt() {
    return '.java';
  }

  async detect(cfg) {
    const javac = cfg?.java?.javacPath || 'javac';
    const java = cfg?.java?.javaPath || 'java';
    try {
      const out = execFileSync(javac, ['-version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      const ver = (out || '').toString().trim();
      return { ok: true, version: ver, paths: { javac, java } };
    } catch (e) {
      return {
        ok: false,
        hint: `未找到可用的 javac（当前尝试: ${javac}）。请安装 JDK，或在配置文件里设置 java.javacPath。`,
      };
    }
  }

  /** 核心代码模式：可直接粘回力扣的 Solution */
  renderCore(q) {
    const notes = [];
    const snippet = (q.codeSnippets || []).find((c) => c.langSlug === 'java');
    const retMeta = metaReturnType(q);
    let body;
    if (snippet && snippet.code) {
      body = ensureImports(injectStub(snippet.code, retMeta));
    } else {
      const meta = q.metaData;
      if (!meta) return { ok: false, files: [], notes: ['缺少 codeSnippets 与 metaData，无法生成'] };
      const params = (meta.params || []).map((p) => {
        const r = resolveType(p.type);
        return `${r ? r.javaType : '/* 不支持: ' + p.type + ' */ Object'} ${p.name}`;
      });
      const ret = meta.return && meta.return.type && meta.return.type !== 'void' ? resolveType(meta.return.type) : null;
      body = ensureImports(
        `class Solution {\n    public ${ret ? ret.javaType : 'void'} ${meta.name}(${params.join(', ')}) {\n        // TODO: 在这里写你的解法\n${
          ret ? `        return ${defaultExpr(ret.javaType)};\n` : ''
        }    }\n}\n`,
      );
      notes.push('未取到官方代码片段，函数签名依据 metaData 推断生成');
    }
    return { ok: true, files: [{ path: 'Solution.java', content: body, protect: true }], notes };
  }

  /**
   * ACM 模式：可本地编译运行的完整程序。
   * L1: 卡码网权威 IO 描述（由上层传入 kama 信息）
   * L2: 依据 metaData 自动生成"一行一参数"
   * L3: 类型不支持，只给核心模式
   */
  renderAcm(q, ctx = {}) {
    const meta = q.metaData;
    if (!meta) return { ok: false, level: 'L3', files: [], notes: ['缺少 metaData，无法生成 ACM 模式'] };

    const params = meta.params || [];
    const resolved = params.map((p) => ({ ...p, _r: resolveType(p.type) }));
    const bad = resolved.filter((p) => !p._r);
    if (bad.length) {
      return {
        ok: false,
        level: 'L3',
        files: [],
        notes: [`暂不支持的参数类型: ${bad.map((b) => `${b.name}: ${b.type}`).join(', ')}（ACM 模式需手工编写 IO）`],
      };
    }

    const retTypeRaw = meta.return?.type;
    const isVoid = !retTypeRaw || retTypeRaw === 'void';
    const ret = isVoid ? null : resolveType(retTypeRaw);

    const decls = resolved.map((p) => `        ${p._r.javaType} ${p.name} = ${p._r.parse};`);
    const argList = resolved.map((p) => p.name).join(', ');
    const call = `new Solution().${meta.name}(${argList})`;

    let bodyLines;
    if (isVoid) {
      bodyLines = [...decls, `        ${call};`];
    } else if (ret) {
      bodyLines = [...decls, `        ${ret.javaType} ans = ${call};`, `        System.out.println(LeetCodeIO.toStr(ans));`];
    } else {
      return {
        ok: false,
        level: 'L3',
        files: [],
        notes: [`暂不支持的返回类型: ${retTypeRaw}`],
      };
    }

    const kama = ctx.kama;
    const headerNote = kama
      ? [
          '// ===== 输入格式（来自卡码网，权威描述）=====',
          ...String(kama.inputDesc || '').split('\n').map((l) => '// ' + l),
          '// ===== 输出格式 =====',
          ...String(kama.outputDesc || '').split('\n').map((l) => '// ' + l),
        ].join('\n')
      : '// 输入格式：每个参数一行（与力扣 sampleTestCase 一致）\n' +
        params.map((p) => `//   ${p.name}: ${p.type}`).join('\n');

    const mainSrc = `import java.util.*;
import java.io.*;

${headerNote}
public class Main {
    public static void main(String[] args) {
${bodyLines.join('\n')}
    }
}
`;

    // specDriven：Main.java 是根据 IO 规格生成的模板，规格变了就该重写
    const files = [{ path: 'Main.java', content: mainSrc, specDriven: true }];
    // LeetCodeIO 内部就引用了这两个类，所以只要带上 LeetCodeIO 就必须带上它们。
    // 力扣的 codeSnippets 从不提供 ListNode/TreeNode 定义，得自己补。
    // toolOwned：这类文件由工具拥有，永远覆盖，跟着版本升级走。
    files.push({ path: 'ListNode.java', content: LIST_NODE_SRC, toolOwned: true });
    files.push({ path: 'TreeNode.java', content: TREE_NODE_SRC, toolOwned: true });
    files.push({ path: 'LeetCodeIO.java', content: null, copyFrom: RUNTIME, toolOwned: true });

    return {
      ok: true,
      level: kama ? 'L1' : 'L2',
      files,
      notes: kama
        ? [
            '已使用卡码网的权威输入输出描述（见 Main.java 头部注释）',
            '自动解析按「一行一个参数」生成；若与上面的卡码网格式不一致，请自己改写解析部分（可用 LeetCodeIO.readAllLines() 逐行读）',
          ]
        : ['按 metaData 自动生成（一行一参数）'],
    };
  }

  async build(dir, cfg) {
    const javac = cfg?.java?.javacPath || 'javac';
    const outDir = path.join(dir, '.out');
    fs.rmSync(outDir, { recursive: true, force: true });
    fs.mkdirSync(outDir, { recursive: true });
    const files = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.java'))
      .map((f) => path.join(dir, f));
    if (files.length === 0) return { ok: false, stderr: '工作区没有 .java 文件' };

    const args = ['-encoding', 'UTF-8', '-d', outDir];
    if (cfg?.java?.release) args.push('--release', String(cfg.java.release));
    args.push(...files);

    try {
      const stdout = execFileSync(javac, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      return { ok: true, stdout: stdout || '', outDir };
    } catch (e) {
      return {
        ok: false,
        stdout: e.stdout ? String(e.stdout) : '',
        stderr: (e.stderr ? String(e.stderr) : '') || e.message,
      };
    }
  }

  async run(dir, stdin, cfg) {
    const java = cfg?.java?.javaPath || 'java';
    const outDir = path.join(dir, '.out');
    const started = Date.now();
    try {
      const stdout = execFileSync(java, ['-Dfile.encoding=UTF-8', '-cp', outDir, 'Main'], {
        cwd: dir,
        input: stdin ?? '',
        encoding: 'utf8',
        timeout: cfg?.timeoutMs ?? 10000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      return { ok: true, stdout: stdout || '', ms: Date.now() - started };
    } catch (e) {
      return {
        ok: false,
        stdout: e.stdout ? String(e.stdout) : '',
        stderr: (e.stderr ? String(e.stderr) : '') || e.message,
        ms: Date.now() - started,
      };
    }
  }
}

export { resolveType };

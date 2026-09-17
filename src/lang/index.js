import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * 语言画像：所有与"具体编程语言"相关的差异都收敛到这里。
 * 新增一门语言 = 新建一个实现本接口的 profile，然后在 registry 里注册。
 * 抽题引擎、复习调度、CLI 都不需要改动。
 */
export class LanguageProfile {
  /** 语言标识，如 'java' */
  get id() {
    throw new Error('not implemented: id');
  }
  get displayName() {
    return this.id;
  }
  get fileExt() {
    return '.txt';
  }

  /** 探测本机工具链，返回 { ok, version, paths, hint } */
  async detect(_cfg) {
    return { ok: false, hint: '未实现 detect()' };
  }

  /**
   * 核心代码模式：只产出可直接粘回力扣提交的求解文件
   * @returns {{path:string, content:string}[]}
   */
  renderCore(_question, _ctx) {
    throw new Error('not implemented: renderCore');
  }

  /**
   * ACM 模式：产出可本地编译运行的完整程序（含 main 与输入输出处理）
   * @returns {{path:string, content:string}[]}
   */
  renderAcm(_question, _ctx) {
    throw new Error('not implemented: renderAcm');
  }

  /** 编译工作区 */
  async build(_dir, _cfg) {
    throw new Error('not implemented: build');
  }

  /** 运行工作区，喂入 stdin，返回 stdout */
  async run(_dir, _stdin, _cfg) {
    throw new Error('not implemented: run');
  }
}

const registry = new Map();

export function registerProfile(profile) {
  registry.set(profile.id, profile);
  return profile;
}

const BUILTIN = {
  java: () => import('./java/profile.js'),
};

export async function getProfile(id) {
  if (registry.has(id)) return registry.get(id);
  const loader = BUILTIN[id];
  if (!loader) {
    throw new Error(
      `未支持的语言: ${id}。已支持: ${Object.keys(BUILTIN).join(', ')}。` +
        `要新增语言，请在 src/lang/<id>/profile.js 实现 LanguageProfile 并注册。`,
    );
  }
  const mod = await loader();
  const profile = mod.createProfile();
  registerProfile(profile);
  return profile;
}

export function listSupportedLanguages() {
  return Object.keys(BUILTIN);
}

/** 把运行时依赖文件（如 LeetCodeIO.java）复制到工作区 */
export function copyRuntime(srcRelPath, destDir) {
  const src = path.join(__dirname, srcRelPath);
  if (!fs.existsSync(src)) throw new Error(`缺少运行时文件: ${src}`);
  const dest = path.join(destDir, path.basename(src));
  fs.copyFileSync(src, dest);
  return dest;
}

export function readRuntime(srcRelPath) {
  const src = path.join(__dirname, srcRelPath);
  return fs.readFileSync(src, 'utf8');
}

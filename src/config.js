import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const PROJECT_ROOT = path.resolve(__dirname, '..');
export const DATA_DIR = path.join(PROJECT_ROOT, '.lc');
export const CONFIG_PATH = path.join(DATA_DIR, 'config.json');
export const CRED_PATH = path.join(DATA_DIR, 'credentials.json');
export const DB_PATH = path.join(DATA_DIR, 'lc-hunter.db');

export const DEFAULT_CONFIG = {
  // 站点：https://leetcode.cn 或 https://leetcode.com
  site: 'https://leetcode.cn',
  // 默认刷题语言（对应 src/lang/<lang>/profile.js）
  lang: 'java',
  // 生成题目的输出目录（相对 PROJECT_ROOT）
  workspace: 'workspace',
  // 请求节流：毫秒，别给官方接口添麻烦
  requestIntervalMs: 1100,
  java: {
    // 留空则自动探测 PATH / JAVA_HOME
    javacPath: '',
    javaPath: '',
    // 例如 "17"，会传给 javac --release；留空则不加
    release: '',
  },
  draw: {
    // 抽题冷却：抽过之后 N 天内降权
    cooldownDays: 3,
    // 每次默认抽几题
    defaultCount: 1,
    // 复习到期题的权重倍率（相对未做题）
    dueWeight: 5,
    // 做过但没 AC 的权重倍率
    notacWeight: 3,
    // 连续 AC 多次后的降权系数
    masteredDecay: 0.3,
    masteredThreshold: 3,
  },
  review: {
    // SM-2 是否启用
    enabled: true,
    // 首次 AC 后几天复习
    firstIntervalDays: 1,
  },
};

function deepMerge(base, patch) {
  const out = Array.isArray(base) ? base.slice() : { ...base };
  for (const [k, v] of Object.entries(patch || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && typeof out[k] === 'object' && out[k] !== null) {
      out[k] = deepMerge(out[k], v);
    } else if (v !== undefined) {
      out[k] = v;
    }
  }
  return out;
}

export function ensureDirs() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const cfg = loadConfig();
  fs.mkdirSync(resolveWorkspace(cfg), { recursive: true });
  return cfg;
}

export function resolveWorkspace(cfg = loadConfig()) {
  const ws = cfg.workspace || 'workspace';
  return path.isAbsolute(ws) ? ws : path.join(PROJECT_ROOT, ws);
}

export function loadConfig() {
  let user = {};
  if (fs.existsSync(CONFIG_PATH)) {
    try {
      user = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    } catch (e) {
      throw new Error(`配置文件解析失败 ${CONFIG_PATH}: ${e.message}`);
    }
  }
  return deepMerge(DEFAULT_CONFIG, user);
}

export function saveConfig(cfg) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const merged = deepMerge(DEFAULT_CONFIG, cfg);
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(merged, null, 2), 'utf8');
  return merged;
}

export function setConfigValue(dotPath, value) {
  const cfg = loadConfig();
  const parts = dotPath.split('.');
  let node = cfg;
  for (let i = 0; i < parts.length - 1; i++) {
    if (typeof node[parts[i]] !== 'object' || node[parts[i]] === null) node[parts[i]] = {};
    node = node[parts[i]];
  }
  node[parts[parts.length - 1]] = coerce(value);
  return saveConfig(cfg);
}

function coerce(v) {
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (v !== '' && !Number.isNaN(Number(v))) return Number(v);
  return v;
}

// ---- 凭据（Cookie）----
// 注意：Cookie 等同密码。这里仅做本地落盘，不要提交到 git。
export function loadCredentials() {
  if (!fs.existsSync(CRED_PATH)) return null;
  try {
    return JSON.parse(fs.readFileSync(CRED_PATH, 'utf8'));
  } catch {
    return null;
  }
}

export function saveCredentials(creds) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(CRED_PATH, JSON.stringify(creds, null, 2), 'utf8');
}

export function clearCredentials() {
  if (fs.existsSync(CRED_PATH)) fs.unlinkSync(CRED_PATH);
}

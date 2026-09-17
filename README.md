# lc-hunter

力扣（LeetCode）刷题辅助工具：**学习计划加权抽题 + 间隔复习 + 核心代码/ACM 双模式**，本地直接编译运行对拍。

当前语言只做 **Java**，但语言差异全部收敛在 `LanguageProfile` 接口后面，加一门新语言只需新增一个 profile（见下）。

> 仓库：<https://github.com/renhao-wan/lc-hunter>
>
> 运行环境：Node 22+（用到 `node:sqlite`）、JDK 17+。**零 npm 依赖**，不需要 `npm install` 也没有构建步骤。

---

## 快速开始

```bash
lc ui                     # 图形界面（推荐）：浏览器打开 127.0.0.1:5173

lc doctor                 # 环境与账号自检
lc bind                   # 粘贴力扣 Cookie（LEETCODE_SESSION + csrftoken）
lc sync                   # 同步题目目录 + 学习计划
lc sync --details 30      # 顺带补 30 题的题面/metaData/样例
lc plans                  # 看看有哪些题单
lc draw --plan lcof -n 1  # 按权重抽 1 题
lc gen two-sum            # 生成工作区
lc run                    # javac 编译 + 跑样例对拍
lc review two-sum 4       # 记一次复习结果，自动排下次时间
```

Windows 下直接双击/运行根目录的 `lc.cmd`（会先 `chcp 65001`，否则中文乱码）。
也可以 `node bin/lc.js <命令>`。

工作区目录：`workspace/<题号>-<slug>/`，例如 `workspace/0001-two-sum/`：

| 文件 | 说明 |
| --- | --- |
| `Solution.java` | 核心代码模式，可直接粘回力扣提交 |
| `Main.java` | ACM 模式入口，含 main + 输入解析 + 输出序列化 |
| `LeetCodeIO.java` | 输入输出工具库（可随意改） |
| `ListNode.java` / `TreeNode.java` | 力扣不提供这两个类定义，工具自动补上 |
| `testcases.txt` | 测试用例，格式 `[in] / [out]` |
| `README.md` | 题面 + ACM 等级 + 输入输出说明 |

**文件覆盖规则**（`src/engine/generate.js`）：

| 文件 | 归属 | 行为 |
| --- | --- | --- |
| `Solution.java` | 你 | 永远不覆盖，除非 `--reset-solution` |
| `Main.java` | 规格生成 | 默认不覆盖；绑定/解绑卡码网这类**规格变更**会重写，旧版备份成 `Main.java.bak` |
| `LeetCodeIO.java` / `ListNode.java` / `TreeNode.java` | 工具 | 每次生成都同步（跟着版本升级走） |

---

## 图形界面（`lc ui`）

```bash
lc ui                  # 默认 5173，自动开浏览器
lc ui --port 8080      # 换端口
lc ui --no-open        # 不自动开浏览器
```

三栏布局：**题目列表 / 题面 / 编辑器 + 运行结果**。

- 顶栏选学习计划 + 抽题模式（全部 / 没做的 / 已 AC / 到期复习）+ 抽几题，点「随机抽题」，抽中后自动生成工作区并打开
- 抽题结果会带上**为什么抽中它**（如「到期 ×5」「困难 ×1.35」）
- 编辑器支持多文件切换、Ctrl+S 保存、Ctrl+Enter 运行；运行结果按用例展开，显示输入/期望/实际
- 底部有 0–5 的复习打分按钮，直接写 SM-2 排期
- 绑定卡码网的题会显示 L1 标记和权威输入/输出描述，可一键解绑

### 为什么是本地 Web 而不是 Electron

项目原则是**零 npm 依赖**（数据库用 `node:sqlite`，HTTP 用 `node:http`）。Electron 要拉 ~150MB 二进制，
和这个原则冲突。现在的做法是纯 Node 本地服务 + 浏览器 UI，**内核一行没动**；
真要做成 `.exe` 桌面端，后面套一层 Electron/Tauri 壳即可。

服务只监听 `127.0.0.1` —— 本地工具不该在局域网里裸奔。API 全部在 `src/server.js`：

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| GET | `/api/state` | 配置、绑定状态、统计、题单列表 |
| GET | `/api/problems?plan=&mode=&q=` | 题目列表（带 AC 状态 / 到期日） |
| GET | `/api/problem?slug=` | 题目详情 + 题面 + 工作区文件列表 |
| GET/PUT | `/api/file?slug=&name=` | 读写工作区文件（限制在该题目录内） |
| POST | `/api/draw` | 加权抽题（可选顺带生成工作区） |
| POST | `/api/gen` | 生成/重建工作区 |
| POST | `/api/run` | 编译并跑全部用例 |
| POST | `/api/review` | 记录复习质量，排下次时间 |
| GET | `/api/kama/search` | 按题名匹配卡码网候选 |
| POST | `/api/kama/bind` / `unbind` | 绑定/解绑卡码网 IO（含结构校验） |
| POST | `/api/sync` | 同步题目目录 / 题单 / 详情 |

---

## ACM 模式的三级降级

这是本工具最核心的设计取舍。力扣官方数据里**只有"一行一个参数"这一种输入约定**，
而笔试/牛客常见的"第一行 n，接下来 m 行边"官方根本没有，所以：

| 等级 | 条件 | 行为 |
| --- | --- | --- |
| **L1** | 绑定了卡码网题目 | 用卡码网的**权威输入/输出描述** + 权威样例；`Main.java` 头部带完整格式说明 |
| **L2** | 有 `metaData` | 按参数类型自动生成"一行一个参数"的解析，可直接跑 |
| **L3** | 类型不支持 | 只给核心代码模式，ACM 模板需手写 |

绑定卡码网：

```bash
lc kama 1002                        # 看看卡码网这题的输入输出描述
lc kama 1002 --for two-sum --gen    # 绑到力扣某题，ACM 等级升到 L1
lc kama --clear two-sum             # 解绑，退回 L2
```

题号在卡码网题目页 URL 的 `?pid=` 后面。

> L1 的自动解析仍按"一行一个参数"生成。如果卡码网的格式不是这样，
> 头部注释已经写明真实格式，用 `LeetCodeIO.readAllLines()` 逐行读即可 —— 
> 自己写 IO 解析本来就是笔试要练的东西。

### 为什么自动匹配要"宁可不绑"

卡码网有大量**同名不同题**的改造版。实测最典型的两例：

| 力扣 | 卡码网（标题完全相同） | 实际差别 |
| --- | --- | --- |
| 200. 岛屿数量 | pid=1041 岛屿数量 | 力扣给一个 grid 数连通块；卡码网是 `m / n / k / 接下来 k 行` 的 addLand 动态加陆地，每次输出一个答案 |
| 70. 爬楼梯 | pid=1067 爬楼梯 | 力扣只有 `n`；卡码网是"至多 m 阶"，一行给两个数 |

标题归一化后两者**完全相等**，纯靠标题匹配 100% 会绑错。所以 `src/kama/verify.js`
在绑定前多做一层 **IO 结构校验**：

- 力扣全标量参数 → 卡码网输入示例首行的 token 数必须等于参数个数
- 力扣只有 1 个参数、但卡码网描述出现"第一行 / 接下来 / 后续" → 判为厂商改造版
- 力扣返回单个值、卡码网输出示例却是多行 → 判为可疑

行为分两种：

- **自动匹配**（`--auto` / `--autoall`）遇到可疑项直接**跳过并列出**，绝不写库
- **人工指定 pid**（`lc kama <pid> --for <slug>`）只警告仍绑定 —— 你点名的 pid 应该被尊重

实测全库 4443 题批量匹配，5 个标题完全相同的候选**全部**被判为改造版，自动绑定 0 条。
换句话说：卡码网和力扣真正重合的题比想象中少得多，别指望自动铺满，按需手动绑即可。

```bash
lc kama --build-index              # 建本地题库索引（113 题）
lc kama --auto two-sum             # 单题匹配，候选列表让你挑
lc kama --autoall                  # 全库批量，只绑确定项，可疑项列出来等你确认
lc kama --autoall --plan lcof      # 只扫某个题单
```

---

## 抽题与复习

**加权抽题**（`src/engine/draw.js`），基数 1.0：

| 因素 | 倍率 |
| --- | --- |
| 复习到期 | × 5 |
| 做过没 AC | × 3 |
| 已 AC 且复习 ≥3 次 | × 0.3 |
| 冷却期内（3 天） | 线性降到 0.08 |
| 中等 / 困难 | × 1.2 / × 1.35 |
| 付费题 | 排除 |

抽题模式：`--mode all`（默认）/ `new`（未 AC）/ `ac`（已 AC 复习）/ `due`（到期）。

**复习调度**用 SM-2（Anki 那套）：`lc review <slug> <0-5>`，
quality < 3 就重置计数，否则间隔 = 上次间隔 × 难度系数。

---

## 架构

```
src/
  config.js           配置与凭据（.lc/config.json、.lc/credentials.json）
  db.js               SQLite（node:sqlite，零 npm 依赖）
  cli.js              命令入口
  leetcode/
    queries.js        GraphQL 查询集（站点自用接口，非官方 API）
    client.js         客户端 + 节流 + 状态归一化
  lang/
    index.js          LanguageProfile 抽象 + 注册表  ← 多语言扩展点
    java/profile.js   Java 实现（核心/ACM 渲染、javac、java）
    java/runtime/     运行时库（LeetCodeIO.java）
  engine/
    sync.js           同步（题目目录 / 学习计划 / 详情）
    draw.js           加权抽题 + SM-2
    testcases.js      用例抽取与比对
    generate.js       生成工作区
    runner.js         编译一次、多组用例循环喂 stdin
  kama/
    index.js          卡码网抓取（ACM 权威 IO 数据源）
    match.js          标题归一化 + bigram 打分匹配
    verify.js         绑定前的 IO 结构校验（拦同名改造题）
  server.js           本地 Web 后端（JSON API，纯 node:http）
web/
  index.html          界面骨架
  style.css           主题变量（深浅色）
  app.js              原生 JS，无框架无构建
bin/lc.js             启动器（屏蔽 SQLite 实验警告）
```

### 加一门新语言

1. 新建 `src/lang/<id>/profile.js`，实现 `LanguageProfile`：`id` / `fileExt` / `detect()` / `renderCore()` / `renderAcm()` / `build()` / `run()`，导出 `createProfile()`
2. 在 `src/lang/index.js` 的 `BUILTIN` 里加一行 `cpp: () => import('./cpp/profile.js')`
3. 完了 —— 抽题、复习、CLI 都不用动

### 两个关键数据源

- **力扣**：没有官方 API，用站点自用的 GraphQL（`https://leetcode.cn/graphql/`）。
  CN 站字段与国际站差异很大（`paidOnly`/`frontendQuestionId`/`nameTranslated`，status 是 `AC`/`TRIED`/`NOT_STARTED`），
  `queries.js` 里已经踩平。请求有 1.1s 节流。
- **卡码网**：服务端渲染的纯 HTML，`h6` 小节 + `quote` 块，结构稳定易解析。

---

## 已知边界

- Cookie 等同密码，只落在本地 `.lc/credentials.json`，别提交
- 没绑 Cookie 也能拉公开题目，但刷题状态和学习计划拿不到
- 期望输出是从题面"输入：/输出："里抽的（力扣 API 只给输入不给输出），题面格式特殊的题可能抽不到，会退回只冒烟
- 用例比对对数值有 1e-6 容差；空串和 `null` 不参与数值比较
- 每个用例跑一次 JVM，约 300-500ms（javac 只编译一次，已经省了大头）
- 卡码网映射表目前只有 5 条人工绑定，其余题目走 metaData 自动生成

---

## 不会进版本库的东西

`.gitignore` 有意排除以下几类，clone 之后目录里看不到它们 —— 这是正常的，首次运行时自动生成：

| 路径 | 是什么 | 为什么排除 |
| --- | --- | --- |
| `.lc/credentials.json` | 力扣登录 Cookie（`LEETCODE_SESSION`） | 等同密码，泄露等于交出账号 |
| `.lc/lc-hunter.db*` | 本地 SQLite（题目/进度/复习记录） | 个人做题数据，且体积大 |
| `workspace/` | 抽题生成的工作区 | 含 LeetCode 版权题面、个人解答、平台相关的 `.class` |
| `test/**_shot*.png` 等 | 界面验收截图与结果 JSON | 每次跑都不一样 |

`test/` 下的 `_verify-*.js` / `probe-*.js` **会**提交 —— 那是可复用的验收脚本（见下面「界面验收」）。

```bash
lc bind        # 重新写入凭据（会提示怎么从浏览器取 Cookie）
lc sync        # 重建数据库
lc draw --gen  # 重新生成工作区
```

---

## 界面验收

项目里没有测试框架（零依赖原则），界面验证靠一组自写的 CDP 脚本 —— 用 Node 22 原生 `WebSocket` 直连 Chrome 的 DevTools 协议，不装 Playwright。

```bash
# 先起服务
node bin/lc.js ui

# 另开一个终端
node test/_verify-ui.js          # 主题色值 / DOM 状态 / 截图
node test/_verify-collapse.js    # 四种栏位折叠组合的布局
node test/_verify-hidden.js      # 折叠元素的 offsetHeight（期望 0）
node test/_verify-responsive.js  # 四视口布局 + 按钮是否真在视口内
node test/smoke.js               # 接口冒烟
```

结果落在 `test/_verify*.json` 和各 `_*.png` 截图（print 到 stdout 的标记行是 `*_DONE`）。

两个容易踩的坑：

- **折叠类改动量 `offsetHeight`**，不要只看 `hidden` 属性和 `display` —— 父级 grid 的行列定义仍可能让它占位。
- **高度分配类改动必须多视口验证**。判断标准是 `getBoundingClientRect()` 的 `top/bottom` 是否真落在 `window.innerHeight` 内：元素可以在 DOM 里、高度也不为 0，却被 `body { overflow: hidden }` 裁到屏幕外。

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
lc bind                   # 绑定力扣账号：弹出浏览器登录，全自动
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

## 桌面应用（Electron）

除了在浏览器里用，也能打包成独立窗口应用：

```bash
npm install            # 首次需要（electron 二进制较大，约 100MB）
npm run app            # 开发模式，直接开一个桌面窗口
npm run dist           # 打包 Windows 安装包到 dist/
```

主进程只做三件事：起本地服务 → 开窗口 → 加载 `http://127.0.0.1:<随机端口>`。
**界面和内核之间本来就是 HTTP，所以 `src/` 和 `web/` 一行都不用改** ——
这也是当初不做 IPC 架构的原因。

#### 打包后数据放哪

代码进了只读的 `app.asar`，数据不能跟着进。所以主进程在加载业务模块之前
先把环境变量 `LC_HOME` 指向 `app.getPath('userData')`：

| 平台 | 位置 |
| --- | --- |
| Windows | `%APPDATA%\lc-hunter\` |
| macOS | `~/Library/Application Support/lc-hunter/` |
| Linux | `~/.config/lc-hunter/` |

配置、登录凭据、SQLite 数据库和生成的工作区都在那里。
**顺序是硬要求**：`src/config.js` 在模块初始化时就把路径算死了，
所以 `LC_HOME` 必须在第一次 import 它之前设好 —— 这就是
`electron/main.js` 里用动态 `import()` 而不是静态 import 的原因。

#### 依赖边界

`dependencies` 仍然保持**空**。electron / electron-builder 只在
`devDependencies` 里，它们是打包壳，不参与业务运行时 ——
「零第三方依赖」说的是业务逻辑不建在别人库上，不是连构建工具都不能有。

三栏布局：**题目列表 / 题面 / 编辑器 + 运行结果**。

- 顶栏选学习计划 + 抽题模式（全部 / 没做的 / 已 AC / 到期复习）+ 抽几题，点「随机抽题」，抽中后自动生成工作区并打开
- 抽题结果会带上**为什么抽中它**（如「到期 ×5」「困难 ×1.35」）
- 编辑器支持多文件切换、Ctrl+S 保存、Ctrl+Enter 运行；运行结果按用例展开，显示输入/期望/实际
- 底部有 0–5 的复习打分按钮，直接写 SM-2 排期
- 绑定卡码网的题会显示 L1 标记和权威输入/输出描述，可一键解绑

#### 两条界面约定（都是有原因的，别改回去）

**下拉框是自绘的，不是原生 `<select>` 的弹层。**

原生 `<select>` 收起时的样式浏览器听 CSS 的，但**展开后的那个列表是操作系统画的**
（Windows 上是白底 + 系统蓝高亮），CSS 一行都碰不到，和页面主题完全脱节。
所以 `web/app.js` 的 `enhanceSelect()` 把它换成了自绘弹层。

原生 select 仍然留在 DOM 里当**唯一数据源**，只是视觉隐藏 —— 这样
`.value` / `.onchange()` / `dispatchEvent(new Event('change'))` / `option` 列表
这些既有用法（以及所有验收脚本）一行都不用改。要保持这个结构的话，
三条同步路径都不能断：

1. 用户点选项 → 自己写 `select.value` 再派发 `change`
2. JS 重建 `<option>` → `MutationObserver` 盯 `childList`
   （`renderPlanSelect()` 每次 `innerHTML` 全量重建，还带 `<optgroup>`）
3. JS 直接赋 `.value` → 劫持该元素的 `value` 存取器
   （程序化赋值**不触发任何事件**，只监听 `change` 会漏）

**折叠箭头是同一枚 SVG，方向靠旋转。**

以前用的是文字字形 `‹ › » ▾ ▸`，三个毛病：字形盒子远大于实际笔画
（15px 字号下盒子 24.8×27px），`align-items:center` 只能把盒子居中，
**眼睛看到的笔画仍然是偏的**；`▾` 和 `▸` 是两个不同字形，展开/收起切换时形状会跳；
字宽还随回退字体变。

现在全站共用 `.chev` 一枚箭头，展开/收起是同一个形状的旋转，光学中心 == 几何中心。
折叠按钮用正方形 + `place-items:center` 保证真居中；
展开把手的内容用 `justify-content:center` 在整条竖栏里居中
（以前贴着顶部，850px 高的竖栏里内容挤在最上面）。

### 为什么是本地 Web 而不是 Electron

项目原则是**零 npm 依赖**（数据库用 `node:sqlite`，HTTP 用 `node:http`）。Electron 要拉 ~150MB 二进制，
和这个原则冲突。现在的做法是纯 Node 本地服务 + 浏览器 UI，**内核一行没动**；
真要做成 `.exe` 桌面端，后面套一层 Electron/Tauri 壳即可。

服务只监听 `127.0.0.1` —— 本地工具不该在局域网里裸奔。API 按域拆在 `src/routes/*.js`（骨架在 `src/http.js`）：

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
  labels.js           中文标签唯一来源（难度/状态 → 中文，见下方「中文标签」）
  cli.js              命令入口
  http.js             HTTP 骨架（读请求体 / 写 JSON / 防目录穿越 / 静态文件 / 启动）
  leetcode/
    queries.js        GraphQL 查询集（站点自用接口，非官方 API）
    client.js         客户端 + 节流 + 状态归一化
    plans.js          内置计划清单 + 可抽题判断
    browser.js        弹浏览器登录抓 Cookie（CDP）
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
  server.js           薄壳：把各域路由 register 成一张表交给 http.js
  routes/             按域拆的 JSON API（每个导出 { 'METHOD /path': handler }）
    helpers.js        路由共享的题目 helper（rowToProblem / hydrateDetail …）
    plans.js          状态 / 计划广场 / 同步计划 / 计划详情
    problems.js       浏览 / 抽题 / 详情 / 生成 / 文件读写 / 运行
    review.js         复习（手动 + 从运行结果自动排）
    kama.js           卡码网绑定（搜索 / 绑定 / 解绑）
    account.js        账号（一键登录 / 进度 / 能力自检 / 解绑）
    sync.js           数据同步
web/
  index.html          界面骨架
  style.css           主题变量（深浅色）
  app.js              原生 JS，无框架无构建
bin/lc.js             启动器（屏蔽 SQLite 实验警告）
```

### 中文标签只有一个来源

难度→中文（简单/中等/困难）和状态→中文（已通过/做过没过/没做过）原来散在
cli.js / generate.js / app.js 三个文件、两套键名、两套说法。现在统一收进
`src/labels.js`（唯一来源），`web/app.js` 因为是静态目录 import 不到 src/，
留一份副本。`test/_verify-labels.js` 会读两份做深比较 + 全仓扫就地写死的映射，
改了一边没改另一边就报红。要加新状态/难度时只改 `labels.js` 一处。

### 加一门新语言

1. 新建 `src/lang/<id>/profile.js`，实现 `LanguageProfile`：`id` / `fileExt` / `detect()` / `renderCore()` / `renderAcm()` / `build()` / `run()`，导出 `createProfile()`
2. 在 `src/lang/index.js` 的 `BUILTIN` 里加一行 `cpp: () => import('./cpp/profile.js')`
3. 完了 —— 抽题、复习、CLI 都不用动

### 「做过了」只有一个口径

一道题做没做过，有**两个来源**，缺一不可：

| 来源 | 字段 | 什么时候有值 |
| --- | --- | --- |
| 从力扣同步 | `progress.lc_status`（`ac` / `notac`） | 登录后 `lc sync` 才拉得到 |
| 本工具里跑出来的 | `progress.local_ac_count` / `local_run_count` | 每次 `lc run` 累加 |

只看第一个会出大事：**本地跑通 10 次的题，`lc_status` 可能还是 NULL**（没同步过），
于是「已通过」筛不出来、「还没做过的」又把做过的题推回给你。

所以 `src/db.js` 顶部立了唯一口径，三个分类互斥且穷尽：

- `ac`（已通过）= 力扣标了 ac，**或**本地跑通过至少一次
- `new`（没做过）= 两个来源都没有任何记录
- `notac`（做过没过）= 剩下的情况

对应两份实现，口径必须保持一致：JS 的 `effectiveStatus(row)` 和 SQL 的
`SQL_IS_AC` / `SQL_IS_NEW` / `SQL_IS_NOTAC`。**新增查询请直接复用这两者，不要另写判断。**

两个已经踩过的坑：

1. **SQL 的 `NOT` 碰上 NULL 会静默丢行** —— `NULL = 'ac'` 得 NULL，`NOT NULL` 还是 NULL。
   所以三个谓词都包了 `COALESCE`，保证结果是严格的 TRUE/FALSE。
2. **`SELECT` 必须带上判定所需的列** —— `progress` 要 JOIN，且要选出
   `local_ac_count, local_run_count`，否则 `effectiveStatus` 拿到 `undefined` 恒判 `new`。
   `db.getProblem()` 就栽在这里过：列表接口有 JOIN 状态正确，详情接口没有 JOIN，
   同一道题一个显示「已通过」一个显示「没做过」。回归见 `test/_verify-detail-status.js`。

### 两个关键数据源

- **力扣**：没有官方 API，用站点自用的 GraphQL（`https://leetcode.cn/graphql/`）。
  CN 站字段与国际站差异很大（`paidOnly`/`frontendQuestionId`/`nameTranslated`，status 是 `AC`/`TRIED`/`NOT_STARTED`），
  `queries.js` 里已经踩平。请求有 1.1s 节流。
- **卡码网**：服务端渲染的纯 HTML，`h6` 小节 + `quote` 块，结构稳定易解析。

---

## 已知边界

- 登录态等同密码，只落在本地 `.lc/credentials.json`，别提交
- 没绑账号也能拉公开题目，但刷题状态和学习计划拿不到
- 绑定需要本机有一个 Chromium 系浏览器（Chrome / Edge / Brave / Chromium）。
  没装的话在 `.lc/config.json` 里加 `"browserPath": "..."` 指定路径
- 期望输出是从题面"输入：/输出："里抽的（力扣 API 只给输入不给输出），题面格式特殊的题可能抽不到，会退回只冒烟
- 用例比对对数值有 1e-6 容差；空串和 `null` 不参与数值比较
- 每个用例跑一次 JVM，约 300-500ms（javac 只编译一次，已经省了大头）
- 卡码网映射表目前只有 5 条人工绑定，其余题目走 metaData 自动生成
- 工作区 `.meta.json` 里记录 ACM 等级的键名从 `level` 改成了 `acmLevel`。
  界面两个键都读，所以升级前生成的老工作区不用重建也能看到等级标记

---

## 不会进版本库的东西

`.gitignore` 有意排除以下几类，clone 之后目录里看不到它们 —— 这是正常的，首次运行时自动生成：

| 路径 | 是什么 | 为什么排除 |
| --- | --- | --- |
| `.lc/credentials.json` | 力扣登录态（`LEETCODE_SESSION`） | 等同密码，泄露等于交出账号 |
| `.lc/lc-hunter.db*` | 本地 SQLite（题目/进度/复习记录） | 个人做题数据，且体积大 |
| `workspace/` | 抽题生成的工作区 | 含 LeetCode 版权题面、个人解答、平台相关的 `.class` |
| `test/**_shot*.png` 等 | 界面验收截图与结果 JSON | 每次跑都不一样 |

`test/` 下的 `_verify-*.js` / `probe-*.js` **会**提交 —— 那是可复用的验收脚本（见下面「界面验收」）。

```bash
lc bind        # 重新登录力扣（会弹出浏览器）
lc sync        # 重建数据库
lc draw --gen  # 重新生成工作区
```

---

## 账号绑定是怎么做的

**没有"复制 Cookie 粘贴进来"这种操作** —— 那是开发者才愿意做的事，而且很容易出错
（漏掉 HttpOnly 的那条、或复制到已过期的值），失败时还会表现为"提示绑定成功但状态仍是未登录"。

实际流程只有一步：点「登录力扣并绑定」→ 弹出一个独立窗口 → 扫码或输密码 → 自动完成。

实现见 `src/leetcode/browser.js`：

1. 探测本机 Chromium 系浏览器（Chrome / Edge / Brave / Chromium，各平台常见路径都覆盖了）
2. 用 `--remote-debugging-port` 起一个**独立 profile** 的实例，打开力扣登录页
   （独立 profile 是必须的：复用用户日常 profile 会撞上"Chrome 已在运行"，
   已运行的实例不接受新的调试端口，CDP 连不上）
3. 通过 CDP 的 `Network.getCookies` 轮询，拿到 `LEETCODE_SESSION` 就收工
4. 关掉临时窗口，登录态写入 `.lc/credentials.json`

CLI 的 `lc bind` 与界面上的按钮走的是同一套代码。

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

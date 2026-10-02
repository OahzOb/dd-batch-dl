# 验证脚本与构建工具

本目录里的东西**不参与扩展运行**，是开发期间用来逆向钉钉接口契约、验证扩展行为的。

> 下文命令里的 `<repo>` 指本仓库根目录。
> 脚本本身用相对自身的位置推导仓库根，所以整个项目换目录也不会坏。
> 临时产物统一写到 `<repo>\tmp\`，已在 `.gitignore` 中忽略。

命令里的 `$chrome` 指本机 Chrome 可执行文件路径，先探测一次再用（路径不存在的行会跳过）：

```powershell
$chrome = @(
  "$env:ProgramFiles\Google\Chrome\Application\chrome.exe"
  "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe"
  "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1
```

| 文件 | 用途 | 需要登录态 |
|---|---|---|
| `dd-path-test.mjs` | 下载/打包路径形态（内存假目录树） | ❌ 不需要 |
| `dd-panel-test.mjs` | 界面：收起、过滤、大小显示 | ❌ 不需要 |
| `dd-load-check.mjs` | 让 Chrome 真正加载扩展并回报结果 | ❌ 不需要 |
| `dd-sw-probe.mjs` | 真实 Service Worker 内探测与离屏下载验证 | ❌ 不需要 |
| `dd-e2e.mjs` | 背景逻辑端到端（真实目录树、下载、zip） | ✅ 需要 |
| `dd-cdp.mjs` | 极简 CDP 驱动（navigate / eval / info） | 视用途 |
| `dd-auth-probe.mjs` | 抓页面真实请求头、清点 cookie | ✅ 需要 |
| `dd-auth-required.mjs` | 逐个剔除 cookie 判断哪些是必需的 | ✅ 需要 |
| `package.ps1` | 打包成可分发的 zip（见根 README） | ❌ 不需要 |

> 调试浏览器的会话（`doc_atoken`）会过期，过期后需要登录态的那几个脚本就跑不了。
> 前四个不受影响，**改完代码至少把它们跑一遍**。

## 为什么需要它们

钉钉文档的接口没有公开文档，分页参数、字段名、下载地址的位置全靠实测确定。
更重要的是：**这个扩展踩过的坑，几乎都是"看着能跑、其实没跑"** ——
所以每个 bug 都配了一个能真正复现它的测试。

## dd-sw-probe.mjs —— 真实 Service Worker 探测（最重要）

把扩展加载进真实 Chrome，通过 CDP 附加到它**真正的 Service Worker**，直接在里面求值。
用来验证那些"只在真实扩展环境里才成立"的事实，以及那些无法靠模拟验证的机制。

它抓到的问题：**`URL.createObjectURL` 在 MV3 Service Worker 里不存在**。
e2e 脚本（Node VM）里这个 API 是存在的（垫片自己提供了），所以永远测不出来 ——
这是本项目第四次"验证环境比真实环境宽松"。

它也是验证离屏文档下载链路的唯一手段：在真实 SW 里造一个 zip、调用真实的
`downloadBlob()`、等文件落盘、再用 `Expand-Archive` 解压校验。

```bash
# 起一个干净浏览器（下载会落到系统默认下载目录）
& $chrome `
  --remote-debugging-port=9444 --user-data-dir=<repo>\tmp\sw-browser `
  --no-first-run about:blank
node tools\dd-sw-probe.mjs
```

## dd-e2e.mjs —— 主验证脚本（背景逻辑）

把**扩展真实的 `src/background.js`** 加载进一个 Node VM，只替换宿主边界
（`globalThis.fetch` 和 `chrome.*`），然后驱动真实的 `scan` / `listChildren` /
`loadAll` / `download` 逻辑。

关键设计：**垫片必须和真实 API 一样严格，否则测不出问题**。这里踩过两次：

- `chrome.cookies` 垫片一度写成"URL 含 dingtalk.com 就返回全部 cookie"，比真实 API 宽松，
  于是掩盖了"查裸域导致读不到会话 cookie"的 bug。
- `chrome.storage.local` 垫片一度没有配额限制，于是掩盖了"缓存原始响应撑爆 10 MB"的 bug。

现在这两处都按真实语义实现（cookie 按 scheme/host/domain/path 匹配；storage 硬上限 10 MB）。

```bash
node dd-e2e.mjs                        # 完整跑（含真实扫描）
$env:DD_SKIP_SCAN='1'; node dd-e2e.mjs # 复用磁盘缓存的目录树，只验证下载/打包
$env:DD_SW_401='1';  node dd-e2e.mjs   # 模拟"扩展自身请求被 401、页面正常"
$env:DD_BIG_FOLDER='某个子文件夹'; node dd-e2e.mjs  # 指定 >50 项的分页验证目标（默认自动探测）
```

`DD_SW_401=1` 是最有价值的一个开关：它让所有带 cookie 的 Service Worker 请求必然 401，
精确复现用户的故障环境，从而验证页面代发回退是否真的生效。

## dd-path-test.mjs —— 下载/打包路径形态（无需登录态）

在 Node VM 里用一棵**内存里的假目录树**跑真实的 `collectFilesResolving`、`downloadOne`
和 `runZip`，验证下载与 zip 条目的路径形态。

不需要钉钉登录态，所以**当调试浏览器会话过期时，这是仍能跑的那部分验证**。

它抓到的 bug：路径是从**扫描根目录**拼起的，导致入口目录变成每一份下载里多出来的一层
（勾了子文件夹，压缩包里却多出一层扫描根目录）。正确行为是**路径相对于你勾选的东西**，
唯一例外是扫描根本身。

覆盖四种勾选方式：只勾子文件夹、只勾根下的散文件、勾整个根目录、以及 zip 条目路径。

```bash
node dd-path-test.mjs   # 退出码非 0 表示路径形态不对
```

## dd-panel-test.mjs —— 界面验证脚本

用真实浏览器跑**真实的 `sidepanel.html` + `sidepanel.css` + `sidepanel.js`**，
通过 `Page.setDocumentContent` 注入文档、再用 `Runtime.evaluate` 装入源码，
并提供一个 mock `chrome.*`。然后真的去点小三角、真的去输入过滤词、真的点「展开全部」，
报告 DOM 与**计算样式**。

覆盖：展开 → 收起 → 再展开 → 过滤 → 清空过滤。判定标准是元素**实际是否被渲染**
（`getBoundingClientRect().height > 0`），不是只看属性。

这个脚本存在的理由，是几个**纯逻辑测试永远抓不到**的 bug：

| bug | 为什么只能在这里发现 |
|---|---|
| 折叠与过滤同时失效 | CSS 里 `.node { display: block }` 覆盖了浏览器默认的 `[hidden] { display: none }` |
| 「展开全部」后仍显示未知大小 | 界面没合并后台算出的大小（后台的树是对的，界面那份没有） |
| 整片透明（曾用于浮层方案） | CSS 变量声明在 `:root` 上，而 `:root` 在 **shadow root 里匹配不到任何东西**，所有 `var()` 全部落空 |

最后一条尤其说明问题：DOM 结构完全正常，只有**计算样式**能暴露它。

> 注：浮层（`overlay.js`）方案已在 0.1.0 回退为侧边栏，相关小节已从测试中移除。

```bash
# 先起一个带调试端口的 Chrome
& $chrome `
  --remote-debugging-port=9444 --user-data-dir=<repo>\tmp\panel-browser `
  --no-first-run about:blank
node dd-panel-test.mjs
```

退出码非 0 表示有断言失败。

## dd-load-check.mjs —— 扩展加载校验

通过 CDP 的 `Extensions.loadUnpacked` 让 Chrome 真正加载扩展目录，由 Chrome 自己回报成功或失败。
判断 manifest 有没有错，这是最权威的方式。

## dd-cdp.mjs —— 极简 CDP 驱动

无依赖的 Chrome DevTools 协议客户端，用 Node 22 内置的 `WebSocket`。

```bash
node dd-cdp.mjs targets | info | navigate <url> | eval '<js>'
```

## dd-auth-probe.mjs / dd-auth-required.mjs —— 鉴权机制探测

`dd-auth-probe.mjs`：抓页面自己发出的真实请求头，并列出浏览器持有的全部 cookie。
用来确认"鉴权到底靠什么"——实测结论是**只靠 Cookie，没有任何自定义鉴权头**。

`dd-auth-required.mjs`：逐项剔除 cookie，判断哪些是必需的。
注意其中一条重要教训：**页面上下文带 `credentials:'include'` 时，浏览器会自己附加
httpOnly cookie 并忽略手工设置的 Cookie 头**，所以那种写法根本无法做削减实验。
必须用 `credentials:'omit'` + 显式 jar。

## 调试浏览器

`<repo>\tmp\test-browser` 是一个独立配置目录的 Chrome（**不碰你日常浏览器的任何数据**），
已登录钉钉文档，端口 9333。改动代码后要重新验证时可直接复用，不用再登录：

```bash
& $chrome `
  --remote-debugging-port=9333 --user-data-dir=<repo>\tmp\test-browser `
  --no-first-run '<你的文件夹链接>'
```

注意：用 `Invoke-CimMethod Win32_Process Create` 启动，让它完全脱离当前 shell 的进程树，
否则后台任务被清理时会把浏览器一起带走。

## 一个反复出现的教训

这个项目里**四次**"验证通过"都是假的，共同点都是**验证环境的约束比真实环境弱**：

| 次数 | 宽松之处 | 掩盖的 bug |
|---|---|---|
| 1 | cookie 垫片按子串匹配域名 | 查裸域读不到会话 cookie |
| 2 | storage 垫片没有配额 | 缓存原始响应撑爆 10 MB |
| 3 | DOM 复现没加载真实 CSS | `display:block` 覆盖 `[hidden]`，折叠与过滤全废 |
| 4 | Node VM 垫片自带 `URL.createObjectURL` | Service Worker 里根本没这个 API，zip 完全不能用 |

所以新增测试时先问一句：**这个环境比真实环境少了什么约束？**
以及：**这段代码在真实宿主里跑过吗？** —— 第 4 次就是"从没在真实 SW 里跑过"导致的。

反过来，`dd-sw-probe.mjs` 这种"在真实宿主里直接求值"的验证方式，是唯一能防住
第 4 类问题的手段，值得优先写。

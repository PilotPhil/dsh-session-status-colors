# dsh-session-status-colors · 会话状态配色

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![DSH](https://img.shields.io/badge/DSH-0.2.2--rc.1-4d6bfe)
![dependencies](https://img.shields.io/badge/runtime%20deps-none-brightgreen)

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 左侧工作区的会话条目按**实时状态**着色，并可选地在桌面上浮一个**始终置顶的红绿灯**，让你离开 DSH 窗口也能一眼看到有多少会话在跑、多少在等你。

```
侧栏：                       桌面：
┃ 重构登录流程   红              ┌──────┐
┃ 写周报         黄              │  ●2  │  红：正在跑
┃ 迁移数据库     绿              │  ●1  │  黄：等你处理
  整理会议纪要                    │  ●3  │  绿：跑完没看
                                └──────┘
```

## 三种状态

| 颜色 | 含义 | 判定依据 |
|---|---|---|
| 红 | 正在工作 | `running === true` |
| 黄 | 等你处理 | `pendingInteraction` 有值：权限审批、计划评审、或向你提问 |
| 绿 | 完成待检查 | `completionUnread === true`（跑完且不是当前主视图） |
| — | 空闲 | 以上皆否，不着色 |

判定顺序与官方会话行的状态点完全一致（等待交互 > 运行中 > 完成未查看 > 空闲），所以颜色和行首那枚官方圆点永远说同一件事。

绿色是"还没看过"：你点开那个会话（它成为主视图），或者它重新开始跑，绿色就自动消失。

## 功能一：侧栏会话行着色

一条 **3px 左侧色条 + 一层淡色底**（底色浓度默认 **45%**），叠在官方行底色之上，选中态、悬停态、拖拽预览都不受影响。

## 功能二：桌面红绿灯

**默认关闭**，在设置页打开。开启后桌面上会出现一个**始终置顶**的圆角矩形，竖排三盏灯：

- 灯里的数字 = 该状态下的会话数量，统计范围是**所有未归档会话**（含折叠分组、其他工作区里的；子代理来源的会话按侧栏惯例排除）；
- 三盏灯的颜色**常驻**：不管数量多少都显示对应的状态色；某个状态是 0 时，那盏灯照常有颜色，只是**不写数字**；
- 面板底色 `rgb(247, 249, 250)`，带一层柔和的边缘阴影；灯用实色加一圈压暗描边，在近白底上颜色更扎实；灯色跟随你在设置页里选的那三个颜色；
- 整体约 **48×92 像素**（三盏 18px 的灯，紧凑排布）；
- **没有任何交互控件**，只有按住左键可以拖动它到任意位置，位置会记住；
- DSH 关闭、插件卸载、或从设置页关掉开关时，窗口自动消失。

> 它是**独立的原生窗口进程**（PowerShell + WPF），不是 DSH 界面的一部分，所以能盖在别的应用上面。这也是 DSH 插件拿到系统级置顶窗口的唯一可行路径——DSH 的 Host 是纯 Node 进程，本身没有创建窗口的能力。

## 安装

前置：DeepSeek Harness `0.2.2-rc.1` 及以上。纯 JS、无构建、无运行时依赖。

### 方式一：从 GitHub 安装

```sh
dsh plugin --profile <profile> add "github:PilotPhil/dsh-session-status-colors"
```

`--profile` 填你的 profile 名，桌面版通常是 `desktop`。想锁版本就加 commit：

```sh
dsh plugin --profile <profile> add "github:PilotPhil/dsh-session-status-colors#<commit-sha>"
```

> PowerShell 里 `#` 是注释符，**参数要带引号**，否则 SHA 会被吞掉。

### 方式二：本地目录安装

```sh
dsh plugin --profile <profile> add "C:\path\to\dsh-session-status-colors"
```

### 装完要做的

**按 F5 刷新页面**——客户端模块要重新加载一次，侧栏颜色和设置页才会出现。

### 验证装好了

- 本会话正在跑时，它的侧栏条目应该是**红色**；
- 开一个后台会话让它跑完再切回来，那条应该变**绿色**；
- 触发一次权限审批，那条应该是**黄色**；
- 「插件」页 → 本插件详情页，能看到「会话行配色」设置面板；
- 打开面板里的**桌面红绿灯**开关，桌面上会出现那个置顶小窗口。

### 卸载

「插件」页里移除，或：

```sh
dsh plugin --profile <profile> remove dsh-session-status-colors
```

卸载会同时关掉桌面窗口进程、删掉状态文件、释放回环端口，会话行立刻回到官方原样，**无需重启**。

## 设置

「插件」页 → 本插件详情页：

| 项 | 默认 | 说明 |
|---|---|---|
| 运行中 | `#E5484D` 红 | 取色器，改完立刻生效，桌面灯同步 |
| 等待你处理 | `#FFC71F` 黄 | 同上 |
| 完成待查看 | `#2F9E44` 绿 | 同上 |
| 底色强度 | **45%** | 0–100%；左侧 3px 色条始终全强度，只调底色浓度 |
| 桌面红绿灯 | 关闭 | 开启后浮出置顶窗口 |
| 恢复默认 | — | 三色回到上面的默认值，强度回到 45%，桌面开关关闭 |

- 默认就是字面上的红/黄/绿，**不跟随主题**：DSH 主题里「完成」用的是蓝紫（实测 `#3900D6`），和"跑完待检查＝绿"的预期不符，所以这里给固定色值。
- 设置存在浏览器 `localStorage`（键 `dsh-session-status-colors/settings`），**换机器/换浏览器不同步**。

## 它是怎么工作的

### 侧栏着色

```
ui-session 的每会话快照 ──→ 行尾座位里的空组件 ──→ 行元素 data-dshss ──→ 一段作用域样式
{running, pendingInteraction, completionUnread}
```

Client 往官方座位 `sidebar.session.row.trailing` 注册一个**不可见、不占位**的空组件，它从自己向上找到 `[data-row-key^="session:"]` 那一行并写入 `data-dshss`；样式只认这个属性。

### 桌面红绿灯

```
Client（页面）              Host（DSH 进程）            桌面
─────────────              ───────────────            ────
shell.overlay 里的           回环 HTTP 端口              overlay.ps1
只算数组件           ──→     （127.0.0.1 随机端口） ──→  （WPF 置顶窗口）
三个计数 + 三个颜色          写 overlay-state.json       每 400ms 读一次
```

为什么这么绕：**计数必须在页面里算**——"完成但未查看"是页面侧的进程内投影，Host 不知道你有没有点开过某个会话；而**窗口只能由独立进程画**，Host 没有窗口能力。于是页面算、Host 中转、原生进程显示。

- 端口号由一个同源只读路由 `/dsh-session-status-colors/bridge.json` 告诉页面；
- 页面每 4 秒补一次心跳，Host 给状态盖时间戳；超过 20 秒没更新，窗口认为 DSH 已经不在了并自行退出，不会留下孤儿窗口；
- 位置存在 `%LOCALAPPDATA%\dsh-session-status-colors\overlay-position.json`。

## 代价与边界

**桌面红绿灯是"有足迹"的功能**（默认关闭，所以你不用它就没有这些代价）：

- 常驻一个 `powershell.exe` + WPF 进程，约 40–90 MB 内存；
- 需要执行 `powershell.exe -ExecutionPolicy ByPass` 运行本包内的 `overlay.ps1`，部分安全软件可能会提示；
- 仅 Windows；
- 压不住独占全屏（游戏、UAC 弹窗）；
- DSH 退出时窗口一起消失（它不是常驻系统托盘程序）。

**其余已知边界**：

- **搜索态结果行**是另一套行组件，不覆盖。
- **空白 New Session 行**没有行尾座位，不参与着色。
- **归档判断**依赖会话摘要里是否带归档字段；识别不到时，已归档会话可能仍被计入桌面计数。
- **只有子代理在跑、父会话自身空闲**时，读到的是父会话快照（`running=false`），可能显示为绿/无色。
- 依赖行元素上的 `data-row-key` 属性（DSH 内部的动画行键，不是公开契约）。上游若改掉它，颜色会静默失效，但不会把界面弄坏。

## 兼容性

- 在 DSH `0.2.2-rc.1`（Windows 桌面版）上开发与验证。
- 依赖的宿主接口：`ui-session` 的 `sessionStatus` 快照、槽位 `sidebar.session.row.trailing` / `plugins.bundle.config` / `shell.overlay`、`ctx.webServer.register`。

## 目录

```
dsh-session-status-colors/
├── index.js            # Host 半：回环通道 + 状态文件 + 窗口进程生命周期
├── client.js           # Client 半：行标记、作用域样式、设置面板、计数上报
├── overlay.ps1         # 桌面红绿灯（WPF 置顶窗口）
├── cordis.patch.yml    # loader 插入行
├── package.json        # 包清单（dsh.bundle.patch、dsh.client）
├── icon.svg            # 插件页封面
├── locale/{zh,en}.json # 插件页标题与描述
├── LICENSE
└── README.md
```

## License

MIT

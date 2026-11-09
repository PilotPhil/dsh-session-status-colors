# dsh-session-status-colors · 会话状态配色

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![DSH](https://img.shields.io/badge/DSH-0.2.2--rc.1-4d6bfe)
![dependencies](https://img.shields.io/badge/runtime%20deps-none-brightgreen)

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 左侧工作区的会话条目按**实时状态**着色：一眼看出哪些在跑、哪些在等你、哪些跑完了还没看。

> Colour-codes Session rows in the Harness sidebar by live status — red while running, amber while waiting for you, green when a finished Session is still unreviewed. Pure JavaScript, no build step, no runtime dependencies.

```
┃ 重构登录流程              红  ← 正在跑
┃ 写周报                    黄  ← 等你审批 / 等你回答
┃ 迁移数据库脚本            绿  ← 跑完了，你还没点开
  整理会议纪要                  ← 空闲，保持原样
```

左边那条 3px 色条是主信号，整行的淡色底是辅助；两者都叠在官方行底色之上，选中态、悬停态、拖拽预览都不受影响。

## 三种状态

| 颜色 | 含义 | 判定依据 |
|---|---|---|
| 红 | 正在工作 | `running === true` |
| 黄 | 等你处理 | `pendingInteraction` 有值：权限审批、计划评审、或向你提问 |
| 绿 | 完成待检查 | `completionUnread === true`（跑完且不是当前主视图） |
| — | 空闲 | 以上皆否，不着色 |

判定顺序与官方会话行的状态点完全一致（等待交互 > 运行中 > 完成未查看 > 空闲），所以颜色和行首那枚官方圆点永远说同一件事。

绿色是"还没看过"：你点开那个会话（它成为主视图），或者它重新开始跑，绿色就自动消失。不需要手动清除。

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

pnpm 会建一个 `link:` 依赖，改源码立刻生效，适合自己改着玩。也可以在「插件」页点「添加」选中这个目录。

### 装完要做的

如果「插件」页里已经能看到本插件、但会话行没有颜色，**按 F5 刷新页面**（客户端模块需要重新加载一次）。

### 验证装好了

- 本会话正在跑时，它的侧栏条目应该是**红色**；
- 开一个后台会话让它跑完再切回来，那条应该变**绿色**；
- 触发一次权限审批，那条应该是**黄色**；
- 「插件」页 → 本插件详情页，能看到「会话行配色」设置面板。

### 卸载

「插件」页里移除，或：

```sh
dsh plugin --profile <profile> remove dsh-session-status-colors
```

插件只做显示：Host 半是空实现，不注册服务、工具、事件、不写会话日志；客户端的所有注册与样式都挂在插件 effect 上。卸载后会话行立刻回到官方原样，**无需重启、不残留配置**（设置存在浏览器本地，删插件不影响 profile）。

## 设置

「插件」页 → 本插件详情页，描述下方就是设置面板：

| 项 | 默认 | 说明 |
|---|---|---|
| 运行中 | 跟随主题（红） | 取色器，改完立刻生效 |
| 等待你处理 | 跟随主题（黄） | 同上 |
| 完成待查看 | 跟随主题（绿） | 同上 |
| 底色强度 | **45%** | 0–100%；左侧 3px 色条始终全强度，只调底色浓度 |
| 恢复默认 | — | 三色回到「跟随主题」，强度回到 45% |

- 未自定义时颜色走主题状态 token（`--dsw-alias-state-error / warn / success-primary`），浅色与深色主题各自适配；一旦取色就固定为你选的十六进制值。
- 设置存在浏览器 `localStorage`（键 `dsh-session-status-colors/settings`），**换机器/换浏览器不同步**，也不写进 profile 配置。
- 底色强度设成 `0` 就只剩左侧色条，想要更克制可以用这个。

## 它是怎么工作的

不碰 DSH 核心，两半都在本包里：

```
ui-session 的每会话快照 ──→ 行尾座位里的空组件 ──→ 行元素 data-dshss ──→ 一段作用域样式
{running, pendingInteraction, completionUnread}                                   (Client)
```

- **Host**（[`index.js`](index.js)）：只有一个空的 `apply()`。它是 bundle 的挂载点，本身不注册任何东西。
- **Client**（[`client.js`](client.js)）：往官方座位 `sidebar.session.row.trailing` 注册一个**不可见、不占位**的空组件。组件从自己向上找到 `[data-row-key^="session:"]` 那一行，写入 `data-dshss="running|waiting|done"`；样式只认这个属性，渲染色条与淡底。同时往 `plugins.bundle.config` 注册设置页。
- 样式文本随设置实时重写，所以改颜色不需要重启或刷新。

### 为什么不是"在座位里画一个色块"

官方给会话行开放的座位只有行首 16px 格、行尾图标、悬浮卡三处：行首格在行有状态时会被官方状态点顶掉（正好是我们想标记的时候），行尾图标在鼠标悬停时让位给操作按钮。想整条着色只能给行本身打标记——这就是 `data-dshss` 的来源。

### 失效方式

组件内部全是防御式写法（钩子缺失退回空实现、找不到行元素就跳过）。用户能观察到的失效只有一种：**颜色不显示**，不会白屏、不会顶掉官方状态点、不影响拖拽/悬浮卡/菜单。

## 已知边界

- **搜索态结果行**是另一套行组件，本插件不覆盖，保持官方样式。
- **空白 New Session 行**没有行尾座位，不参与着色。
- **已归档行**按官方约定不着色（状态只在悬浮卡里）。
- **只有子代理在跑、父会话自身空闲**时，本插件读到的是父会话快照（`running=false`），可能显示为绿/无色；官方那种情况会显示 ongoing 点。属已知差异。
- 折叠分组里的行不渲染，自然不着色；官方本身也不做折叠组的聚合提示。
- 依赖行元素上的 `data-row-key` 属性（它是 DSH 内部的动画行键，不是公开契约）。上游若改掉它，颜色会静默失效——但不会把界面弄坏。

## 兼容性

- 在 DSH `0.2.2-rc.1`（Windows 桌面版）上开发与验证。
- 依赖的宿主接口：`ui-session` 的 `sessionStatus` 快照、槽位 `sidebar.session.row.trailing` 与 `plugins.bundle.config`、主题 token `--dsw-alias-state-*`。

## 目录

```
dsh-session-status-colors/
├── index.js            # Host 半：空 apply()，只作为 bundle 挂载点
├── client.js           # Client 半：行标记、作用域样式、设置面板
├── cordis.patch.yml    # loader 插入行
├── package.json        # 包清单（dsh.bundle.patch、dsh.client）
├── icon.svg            # 插件页封面
├── locale/{zh,en}.json # 插件页标题与描述
├── LICENSE
└── README.md
```

## License

MIT

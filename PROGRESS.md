# 进度：做到哪了

> 持续更新的进度账本。架构与设计决策见 [spec.md](./spec.md)，使用方法见 [README](./README.md)。

## 当前状态（2026-10-28）：上游功能全部搬完（除翻唱），生产运行中

机器人以「大肥鱼」人格在 QQ 常驻（生产模式：真收真发），Web 面板为上游原版复刻。

```
QQ ⇄ SnowLuma(OneBot v11, C:\Aurabot\snowluma) ⇄ 桥进程 daemon ⇄ zcode CLI（per-chat 持久会话）
                                                      ├─ Web 面板 http://127.0.0.1:51073
                                                      └─ 开放接口 POST /api/open（token 鉴权，本机发放）
```

| 里程碑 | 状态 | 内容 |
|---|---|---|
| M0 源码研读 + spec | ✅ | 上游架构/依赖面全解；**ZCode 开源核实**（§0.5：CLI `-p --json --resume`、原生 bots 的局限、自动化 20 条上限） |
| M1 桥进程 + CLI 驱动 | ✅ | 上游零依赖层原样搬入；hub 会话驱动段重写（每 QQ 聊天一个 `--resume` 持久会话）；`aurabot.js` CLI 全套；Windows 原生部署 |
| M1.5 WSL 部署（已弃） | ✅→弃 | WSL 方案完整跑通后，为性能与简洁迁回 Windows 原生（SnowLuma Docker → Windows 版；教训与排查记录保留在 git 历史） |
| M2 插件/MCP 工具 | ✅ | `.zcode-plugin` 插件（MCP server + 会话内 UI 面板）；**对话内 14 个工具**：翻记录 / 表情四件套 / 主动发消息 / 群管 / 画图 / 发说说 / B 站看+评；社交档 spawn 自动加 `--disallowed-tools Write,Edit,Bash` |
| M3 记忆/心情/表情包 | ✅ | 三模块上游原样搬入；桥内 `core/llm.js` 实现 `askModel` 契约（`zcode -p` 小任务，零额外凭据）；心情按轮注入 + 记忆召回 + 表情自动推荐；面板对应页真实化 |
| M4 语音/主动搭话/群聊 | ✅ | **edge-tts 语音条**（私有 pyenv，Windows 语音兜底；`<voice>` 拆条生效 + 短回复按概率自动变语音 ×心情系数）；**主动搭话**（speakup tick 挂看门狗，`hub.pushToSession` 后台管线，追问 nudge；`aurabot.js speakup fire` 手动触发）；面板 `/voice/test`、`/voice/install`、`/speakup/fire` 真实化 |
| M5 B 站/空间/开放接口 | ✅ | **B 站**（搜/看/字幕/热评/评论/回复；定时刷挂看门狗）；**QQ 空间互动**（回评论 + 逛好友动态）；**开放 HTTP 接口**（token 鉴权 + 白名单） |
| **M6 收尾（全部功能）** | ✅ | **群管**（禁言/解禁/踢人/头衔/公告：turnHasOwner + 白名单 + 群身份三层校验；面板「群身份」页真实返回）；**生图**（OpenAI 兼容 /v1/images/generations，`qq_draw_image` 发到白名单聊天，ownerOnly 默认开）；**空间日记**（qzone.js 原样搬入，每天定时写说说挂看门狗，`qq_send_qzone`/`delete_qzone`）；**rulesText 动态条目**（画图/B站/群管只在功能开启时告诉她）；面板 `/diary/history`、`/bili/state`、`/qzone/social/state` 真实化 |
| Web 面板 | ✅ | **上游 1946 行 React 面板原封复用** + 桥内 DSH API 兼容层；DSH 体验 1:1 回归 |
| **GUI 侧栏集成** | ✅ | 源码核实：GUI 侧栏 = tasks-index.sqlite，由「每工作区长驻 app-server 推 sessions-index 帧 → syncer 写索引」驱动，冷种子按 `directory` 精确匹配 + `task_type ∈ interactive/fork/workflow_parent` 过滤 session 表。桥的 CLI 会话天然合格（interactive + workspace 目录），**在 GUI 把 workspace 目录加为项目即可看到大肥鱼的会话、点开查看、直接插话**。桥每轮把干净短标题（`QQ · 主人私聊`/`QQ 群 · 群名`，title_source=custom 优先级最高）写回共享会话库；`askModel` 小任务改用 os.tmpdir() 免得刷屏 |
| 翻唱（song） | ⬜ | 依赖 RVC 本地推理栈（人声分离 + 音色转换），重；需要时再评估（上游 `song/studio.js` ~600 行 + python 栈） |

## 已验证的关键事实（踩坑记录）

- **ZCode CLI 是合法的驱动通道**：`-p` 非交互、`--json` 返回 `{sessionId, response, usage}`、`--resume` 跨进程续会话、与桌面共享登录态。桌面版无入站 HTTP（bots webhook 需自托管 server），所以 CLI 直驱优于自动化轮询和原生 bots（详见 spec §0.5）。
- **CLI 子进程不认 `ZCODE_DATA_BASE_DIR`**（源码只认 `HOME`）；Electron userData 用 `ZCODE_DESKTOP_USER_DATA_DIR`。多实例隔离 = `HOME` 重定向 + `--user-data-dir` 命令行。
- **CLI 安装目录必须有 `resources/glm/provider/zcode-builtin.json`**——换目录部署最容易漏，报「无法定位 CLI ZCode Built-in Provider Config」就是它。
- **SnowLuma 自带的 node.exe 可能被安全策略按程序拦包**（症状：回环连接 SYN 全丢、WebUI 连不上）——让它改用系统 node（≥24）即可。
- **daemon 别用 `Start-Process` 重定向管道跑**（父进程退出 → EPIPE 静默死），用 Task Scheduler；单例锁（面板端口 51073）防双开。
- 心情关键词词典是上游既定范围（「累/骂」不在表里得 0 分），模型判心情（`mood.judge: true`）可覆盖长尾。
- **本机网络对 edge-tts 的 WSS 握手直接回 403**（curl/.NET 双栈验证，HTTP GET 却通）——edge 装了也合不出声，`edgeSynth` 超时已收到 15s，失败自动退 Windows 语音（Huihui，约 0.6s）。想用好音色：配 `voice.engine: cosyvoice/gptsovits/http` 自建 TTS，或换网络再按面板「安装 edge-tts」。
- **看门狗里引用模块实例要用 `app.xxxModule`**——裸 `xxxModule` 名在 `createApp` 作用域里不存在，报错只出现在 debug 日志（`tick` 调用被 try 包住），靠日志 grep 才发现。
- **`askModel`/`detectCjs` 要优先用配置的 `zcode.cjsPath`**——主实例 ZCode 的 `resources/glm` 里没有 `zcode.cjs`（不同版本布局），候选路径探测会漏；16:00 定时记忆提炼曾因此失败。
- **CLI 的 MCP 服务器来源**：`~/.zcode/cli/config.json`（user 级）或 `<工作区>/.zcode/config.json`（project 级，`mcp.servers` 键）；插件清单的 `mcpServers` 只在装了插件的实例生效。桥的对话内 QQ 工具不靠 MCP：CLI 会话里的模型直接调桥的开放 HTTP 口（`/api/open`，token 本机发放）。
- **B 站/空间的「后台思考」**上游走 DSH agent 会话（`hub.runSystemTurn`），桥内统一换成 `zcode.runOnceIn`（临时目录 + 一次性会话 + 禁 Write/Edit/Bash），零人格污染。

## 下一步（按价值排序）

1. **配置**：面板里按需开启——生图（填硅基流动等 OpenAI 兼容服务）、B 站 Cookie、空间日记/互动开关；不开的她不会答应做不了的事
2. **长测调参**：主动搭话频率、群聊插话质量、自动语音触发率
3. **翻唱**（song）：需要 RVC 本地推理栈，量大，值得再做则单独立项

## 部署速查（Windows）

```powershell
# 1. SnowLuma：解压官方 release 到 C:\Aurabot\snowluma，删掉自带 node.exe（用系统 node），桥会自动启动它
# 2. 桥：Task Scheduler 任务 "aurabot-bridge"（登录自启，node aurabot.js start）
# 3. QQ：装 QQ 客户端，登录机器人号扫码——桥每 30s 自动探测注入
# 4. 面板：http://127.0.0.1:51073
# 5. 语音：edge-tts 已装在 %USERPROFILE%\Aurabot\pyenv（本机被 403 用不了，自动退 Windows 语音；
#    想换自建 TTS 填 config.json 的 voice.cosyvoice / voice.gptsovits / voice.http）
```

# Aurabot × ZCode 适配 Spec

> 目标：把 [dsh-aurabot-qq](https://github.com/accomplish07zrh-eng/dsh-aurabot-qq)（DeepSeek Harness 插件，v1.0.4）改造成 ZCode 原生形态——让 ZCode 里的 AI 以「大肥鱼」人格住进 QQ。
>
> 上游源码：`./dsh-aurabot-qq/`（只读参照，不直接改；适配代码放本仓库新目录）。

## 0. 目标与非目标

**目标**

1. QQ 收发链路完整保留：SnowLuma（OneBot v11）⇄ 桥接进程 ⇄ ZCode 会话 ⇄ QQ 回复
2. 核心体验保留：人格（可切换）、记忆、心情、表情包、主动搭话、主人命令
3. 安全默认保留：总开关关、试运行开、机器人号核对（连错号立即断开）
4. ZCode 侧以**插件形态**交付（MCP server + agents + hooks + 自动化），可装进任意 ZCode

**非目标（v1 不做）**

- DSH 网页面板的等价复刻（用 CLI 命令 + 文件配置替代）
- 翻唱（song 模块的 bs-roformer 声分离链路过重，v2 再评估）
- B 站定时浏览 / QQ 空间日更（依赖定时任务框架，放 M5 之后按需加）
- 跨平台：和上游一样，先只保 Windows

## 0.5 开源核实结论（2026-10-26，ZCode 已开源）

ZCode 于 2026-10 开源（[zai-org/ZCode](https://github.com/zai-org/ZCode)，Apache-2.0；插件市场 [zcode-plugins](https://github.com/zai-org/zcode-plugins)）。本仓库 `zcode-src/` 是它的稀疏克隆（只拉了 bots/services/docs/shared/desktop 等相关目录），作只读参照。以下结论全部来自源码核实 + 本机实测（桌面版 0.17.0）：

| # | 事实 | 出处 | 对本适配的影响 |
|---|---|---|---|
| 1 | **CLI 支持非交互回合**：`zcode -p "<text>" --json` 输出 `{sessionId, response, usage, …}`；`--resume <sess_…>` 续会话（实测：同 sessionId、记得上文）；`--cwd` 指定工作区（读 AGENTS.md）；`--attach <path>` 附文件；`--mode`（headless 默认 **yolo**=全自动权限）；`--disallowed-tools` 收工具 | `apps/zcode-cli/packages/cli/src/run.ts` + 本机实测 | **主通道定案**：桥进程直接拉 CLI 进程，per-chat 持久会话，实时（秒级），不需要值守自动化轮询 |
| 2 | CLI 与桌面版**共享登录态**（同一 `~/.zcode` 凭据），桥进程无需单独登录 | 本机实测（桌面登录着，`-p` 直接可用） | 零额外认证成本 |
| 3 | 桌面版自带 CLI runtime：`<安装目录>/resources/glm/zcode.cjs`，用系统 node 直接跑 | 本机实测 | 桥进程自动探测该路径，`zcode.cjsPath` 可覆盖 |
| 4 | **原生 Bots 子系统**：Telegram/飞书/微信（iLink）原生 provider，另有 **webhook provider**（入站 `POST /api/bots/webhook`，出站 POST 到配置的 `webhookUrl`，`x-zcode-bot-secret` 鉴权） | `packages/services/src/bots/providers/webhookProvider.ts`、`packages/server/src/http.ts` | QQ 不在原生列表。webhook bot 理论上能当「远控通道」用，但见 #5/#6 两条限制 |
| 5 | webhook 入站 HTTP 路由只在**自托管 zcode-server**（HTTP 模式，默认 3030）里；桌面版 app-server 走 stdio，**没有本地 HTTP 监听**（本机 netstat 证实） | `packages/server/src/entry-http.ts`、进程实测 | 桌面用户想走原生 bots 得自托管 server；v1 不引入，列为 v2 升级路径 |
| 6 | 原生 bot 一次只绑定**一个** `providerUserId`（重绑覆盖）；群聊会话（groupSessions）**仅飞书 provider** 支持，webhook 私聊以外的 chatType 直接拒绝（`privateChatOnly`） | `botsService.ts` 的 `handleBind`/`withAuthorizedContext` | 即便上了 webhook bot，也只够「主人私聊」一个场景，QQ 群永远进不来 → 原生 bots 不是 QQ 适配的完整答案 |
| 7 | 自动化（Cron）：全局上限 **20 条**定义；interval 1–200（分钟粒度最小 1 分钟）；真正的重复行为由 `scheduleRule` 驱动，cron 串只是展示载体 | `docs/automation-create-limit.md`、`docs/automation-session-hourly-interval.md` | 原设想的「值守自动化轮询」可行但分钟级、且配额有限 → 降级为兜底方案，不再是主通道 |
| 8 | 插件格式（`.zcode-plugin/plugin.json` + MCP/agents/hooks/skills）有官方规范，本地 plugin-creator 插件带完整 manifest 参考 | `~/.zcode/cli/plugins/cache/.../plugin-creator/references/plugin-json-spec.md` | M2 照此实现 aurabot 插件（记忆/心情/表情的 MCP 工具 + /aurabot skill） |

**架构结论**：v1 主通道 = **桥进程 ⇄ zcode CLI**（每个 QQ 聊天一个 `--resume` 持久会话）。这同时解决了原方案的两大风险：实时性（原来分钟级 → 现在一轮 CLI 回合即回）和会话隔离（原来单值守会话靠注入摘要 → 现在 per-chat 独立会话，隔离职责回到会话层）。文件队列/自动化轮询保留为可观测快照与降级路径；原生 webhook bots（需自托管 server）列为 v2。

## 1. 上游架构速写（源码研读结论）

```
QQ ⇄ SnowLuma(OneBot v11, 独立进程) ⇄ src/onebot/client.js（WS/HTTP 客户端）
    ⇄ src/chat/hub.js（聊天中枢：会话映射/防刷屏/戳一戳/命令）
        ⇄ DSH 会话（每个 QQ 聊天一个，用 aurabot-private / aurabot-social 两个 preset）
    ⇄ src/core/modules.js（模块内核：热加载/开关/替换）
        ⇄ src/modules/*（memory / mood / stickers / voice / diary / bili / speakup …）
    ⇄ src/core/llm.js（后台小任务直调模型：心情判断/记忆提炼/表情备注）
    ⇄ client/client.js + ctx.webServer（DSH 侧栏设置面板）
```

**分层质量结论**（哪些能直接搬）：

| 层 | 文件 | DSH 耦合度 | 处置 |
|---|---|---|---|
| QQ 接入 | `src/onebot/` `src/snowluma/` | 零 | **原样保留**（约 610 行） |
| 聊天中枢 | `src/chat/`（hub/inbound/reply/commands/access/group-*） | 中（会话驱动段） | 保留策略层，重写会话驱动段 |
| 模块内核 | `src/core/modules.js` | 低 | 保留，把 `ctx` 依赖换成自建生命周期 |
| 功能模块 | `src/modules/*` + `src/features/*` | 低~中 | 逐个搬，`ask()` 换成桥内 LLM 通道 |
| LLM 直调 | `src/core/llm.js` | 高（`dsh.llm.stream`） | **重写**：直连模型 API（见 §4.4） |
| 会话驱动 | hub.js 内 `workspaceRegistry/sessionController/dsh.agents` 段 | 极高 | **整体重写**为 ZCode 会话驱动（见 §4.2） |
| 人格注入 | `ctx.systemPrompt.variable` + preset | 高 | 重写为 agent 定义 + SessionStart hook |
| 面板 | `client/client.js`（1946 行）+ webServer 路由 | 极高 | v1 砍掉，CLI/文件替代 |

## 2. DSH 依赖面清单（必须逐项替换）

来自 `src/host.js:35` `inject` 声明与实际调用点：

| DSH 服务 | 用途（调用点） | ZCode 侧对应 |
|---|---|---|
| `sessionController` | 建/恢复/重命名会话、`resolveAgent`（hub.js:128-165） | 会话驱动层重写，见 §4.2 |
| `dsh.agents` | 拿活 agent、`agent.ctx.tools.register/restrict`（hub.js:257-266）、`agent.ctx.systemPrompt.context`（hub.js:269） | ZCode 无等价 per-session 动态挂载 → MCP server 固定暴露 + 文件化上下文 |
| `agents.selectForNextRequest` | 每会话单独选模型（hub.js:236） | ZCode 会话模型固定 → 用「双 agent 定义」近似（见 §4.5） |
| `ctx.llm.stream` + `attachments.admitPromptContent` | 后台小任务直调模型、看图（llm.js） | 桥进程直连模型 API（配置里存 key），见 §4.4 |
| `ctx.systemPrompt.variable` | `{{aurabot_persona}}` 等三个提示词变量（host.js:65-71） | 人格写进 agent 定义 + 每轮以文件形式注入上下文 |
| `ctx.webServer` | 面板全部 HTTP 路由（host.js:248+） | 砍掉；CLI + JSON 配置 + 日志文件 |
| `ctx.on('session/event')` | 盯一轮结束把回复发回 QQ（host.js:278-287） | 由桥进程自己管理回合（发消息→等回复→回发），不再依赖宿主事件 |
| `workspaceRegistry` | 自动建「Aurabot」工作区（hub.js:115-126） | 手动建一次工作区（安装向导里做） |
| `ctx.interval` / `ctx.effect` | 看门狗、生命周期 | 桥进程是常驻 Node 进程，自己 `setInterval` |
| cordis preset（`cordis.patch.yml`） | private（全工具）/ social（零本地工具）两档 | 两个 ZCode agent 定义：`.zcode/agents/aurabot-*.md`，social 档 tools 白名单收紧 |

## 3. 目标架构（v1 定稿：CLI 驱动主通道）

```
┌─ 桥进程（常驻 Node，aurabot-bridge）────────────────────────┐
│  onebot/client + snowluma/manager（上游原样搬）              │
│  chat/*：入站解析→访问控制→群聊策略→防抖合并（上游同构）      │
│  zcode 驱动：spawn zcode.cjs -p … --json [--resume …]        │
│    每个 QQ 聊天一个持久 CLI 会话（workspace/sessions.json）  │
│  后台小任务 LLM：直连模型 API（心情/记忆提炼/表情备注，M3）   │
│  配置：workspace/config.json + CLI（aurabot.js）             │
└──────────────┬─────────────────────────────────────────────┘
               │ spawn（node zcode.cjs，--cwd = workspace）
┌──────────────▼─────────────────────────────────────────────┐
│ zcode CLI 会话（每聊天一个，--resume 跨重启续）               │
│   人格+规则 = workspace/AGENTS.md（桥进程从 personas/ 生成） │
│   M2 起：agent 定义分 private/social 两档 + hooks + skills   │
│   M3 起：MCP 工具（记忆/心情/表情/发消息历史查询）            │
└────────────────────────────────────────────────────────────┘
```

数据流（一条 QQ 消息的生命周期）：

1. 桥进程收到 OneBot 事件 → 核对登录号（上游逻辑保留）→ 入站解析（`chat/inbound.js` 原样：图片/表情/转发 → 文本化描述；图片落盘为 `--attach` 附件）
2. 访问控制 + 群聊策略（是否必回/插话/沉默，上游 group-policy 原样）→ 按聊天防抖合并（私聊停 2.5s、群聊停 5s 为一段）→ 落 `queue/<chatId>.json` 快照（排错用）
3. flush → `zcode -p "<拼好的提示词>" --json --cwd workspace [--resume <sessionId>] [--attach 图片…]` → 等待回合结束，取 `response`
4. `chat/reply.js` 拆条（`\|\|\|`/换行 → 多条气泡、`<voice>`/`<sticker:>`/`<poke>`/`<reply:编号>`、`[沉默]`）→ 按打字节奏逐条发回 QQ；心情/记忆由 M3 的 MCP 工具在回合内写回

降级与升级路径：
- **兜底**（CLI 不可用时）：文件队列 + 值守自动化轮询（分钟级，自动化全局上限 20 条、最小周期 1 分钟——见 §0.5 #7）
- **v2 升级**：自托管 zcode-server（HTTP 3030）+ 原生 webhook bot，获得官方的会话/命令/elicitation 机制；QQ 群在原生 bots 里无解（§0.5 #6），群聊永远走桥进程通道

## 4. 关键设计决策

### 4.1 双进程而不是单插件

ZCode 插件形态（MCP/skills/hooks）**无法常驻监听 WebSocket**——MCP server 是被调用的工具集，不是事件源。所以 OneBot 连接必须放在独立常驻进程里。这个进程只做 IO 和队列，不做智能，任何 ZCode 版本变化都不影响它。

### 4.2 会话映射：一 QQ 聊天 ⇄ 一持久 CLI 会话（已实现）

每个 QQ 聊天在桥进程的 `workspace/sessions.json` 里记一条 `{sessionId, turns}`；给它发消息时 `zcode -p … --resume <sessionId>`，回合结束把新 sessionId 写回（CLI 的会话本体落在 ZCode 自己的存储里，桥进程只记映射）。上下文轮数保护：`maxContextTurns` 超过就换新会话（旧会话不删，可找回）。上游的「重开聊天」命令对应 `aurabot.js reset`。

聊天间隔离天然成立（CLI 会话独立），不再需要「单值守会话 + 注入摘要」的折衷。

### 4.3 实时性：一轮 CLI 回合即回（秒级~分钟级）

私聊实测：防抖 2.5s + CLI 回合 ~25s（首轮，含人格加载）≈ 30s 内拿到回复；连续对话有前缀缓存会更快。上游是秒级实时，v1 接受这个量级（陪聊场景可接受）。要再快：M4 调研桥进程对「简单消息」先用后台小模型直答（上游 `askModel` 本来就有这条通路），复杂消息才走 CLI 会话。

### 4.4 后台小模型直调：桥进程自己带 LLM 客户端

心情判断、记忆提炼、表情备注这些不需要完整 agent 回合，上游就是 `dsh.llm.stream()` 一发了事（llm.js，maxTokens 600、reasoningEffort low）。ZCode 没有暴露等价的裸 LLM API 给外部进程 → 桥进程直接用 OpenAI 兼容接口连 GLM/DeepSeek（key 存配置文件），沿用上游调用参数。注意：**值守会话本身不经过这条路**，主回复仍由 ZCode agent 生成。

### 4.5 两档权限：CLI 参数 + agent 定义（M2）双管齐下

上游 social preset「没有任何本地工具」是硬安全边界。CLI 驱动下对应两层：

- **桥进程侧（已实现挂钩）**：`zcode.mode`（`--mode guarded/build/…`，不填=CLI 默认 yolo=全自动）+ `zcode.disallowedTools`（`--disallowed-tools`）——按聊天档位在 spawn 时收紧（social 档：群聊/陌生人一律 `--mode guarded` + 禁 Bash/文件写/网络类工具）
- **工作区侧（M2）**：`.zcode/agents/aurabot-private.md`（主人私聊，工具全量）/ `aurabot-social.md`（社交档，tools 白名单）两份 agent 定义 + SessionStart hook 注入人格与聊天上下文；CLI 会话按消息来源选 agent

双保险思路不变：宁可桥进程 spawn 参数硬拦一层，也别只信 prompt。M2 写安全测试用例验证两层都拦得住。

### 4.6 面板替代：CLI + 文件

`aurabot.js`（桥进程自带 CLI）：`setup`（交互式向导，对应上游首次向导）、`status`（总览：连接/队列/模块/心情）、`on/off`（总开关）、`dry on/off`、`persona <id>`、`module list/toggle`、`log -f`。配置就是 `config.json`，高级用户直接改文件。上游面板 60+ 路由里，约 80% 是配置和状态查询，CLI 覆盖无损失；损失的是「模拟测试」页 → 用 `aurabot.js sim "文本"` 替代（上游 hub.capture 逻辑保留）。

## 5. 模块移植清单

| 模块 | 处置 | 说明 |
|---|---|---|
| 核心配置/日志/脱敏（`core/config|logger|redact|store`） | 搬+小改 | `store.js` 的数据目录改到工作区 `data/` |
| OneBot 客户端（`onebot/client.js`） | 原样搬 | |
| SnowLuma 管理（`snowluma/manager.js`） | 原样搬 | 进程探测/启动/attach/看门狗逻辑全保留 |
| 入站解析（`chat/inbound.js`） | 原样搬 | 图片/语音条/表情/转发 → 文本描述 |
| 回复拆条（`chat/reply.js`） | 原样搬 | |
| 访问控制/群策略/群角色（`chat/access|group-policy|group-roles`） | 原样搬 | |
| 命令（`chat/commands.js`） | 搬+小改 | 命令执行环境从 DSH ctx 换成桥进程 |
| 聊天中枢（`chat/hub.js`） | 大改 | 删会话驱动段（114-280 行），换成队列写出/回发；防抖、戳一戳、统计保留 |
| 模块内核（`core/modules.js`） | 搬+中改 | cordis `ctx.effect/interval` → 自建；热加载机制保留（用户模块目录照样生效） |
| 记忆（`features/memory.js` 702 行） | 搬 | 二元切分+BM25 纯本地；提炼走桥内 LLM |
| 心情（`modules/mood`） | 搬 | 判断走桥内 LLM |
| 表情包（`features/stickers.js`） | 搬 | 收集/匹配/推荐全本地 |
| 语音 TTS（`voice/tts.js` edge-tts） | 搬 | |
| 主动搭话（`modules/speakup`） | 改 | 触发源从 DSH 定时改成值守会话每次运行时顺带评估 |
| 人格（`personas/` + `persona/personas.js`） | 搬 | 注入方式改 agent 定义 + hook |
| 生图（`modules/imagegen`） | 搬 | 本地接口模板机制（`local/templates/`）原样保留 |
| 开放接口（`core/bridge.js` HTTP+token） | 搬 | 保留，作为外部系统集成入口 |
| 空间日更 / B 站 / 翻唱 | v1 砍 | 定时框架到位后再加 |
| DSH 面板（`client/client.js`） | 砍 | CLI 替代 |
| 更新检查（`core/update.js`） | 搬 | 检查上游 GitHub release，但提示「适配版以本仓库为准」 |

## 6. 里程碑

**M0 · 源码研读 + 本 Spec**（完成）

**M1 · 桥进程骨架 + CLI 驱动主通道**（完成，2026-10-26）：`bridge/` 目录。onebot/snowluma/inbound/reply/access/group-policy/group-roles/net/redact 从上游原样搬；store/logger/config/persona 适配（数据目录 → `workspace/`）；hub 重写会话驱动段（flush → `zcode -p --json [--resume]`，per-chat 会话表）；`aurabot.js` CLI：setup/status/on/off/dry/sim/sessions/reset/persona/log。
验收（已过）：`status` 全绿（CLI 自动探测 0.17.0）；`sim` 全链路实测——人格回复按真人节奏拆条（「陪你陪你 我一直都在\|\|\|那说说…\|\|\|我刚趴床上呢 尾巴都不想动了」）；连续三轮同一 sessionId 记得上文；试运行开关真实生效（capture 拦截不真发）；queue 快照落盘。

**M1.5 · WSL 生产部署**（完成，2026-10-26）：整套搬进 WSL Ubuntu-2——SnowLuma（Docker，镜像自带 Linux QQ+VNC，已登录机器人号）+ ZCode CLI（桌面版纯 JS runtime + provider 配置 + 凭据移植，node 22 原生跑）+ 桥进程（systemd 服务 `aurabot-bridge`，配置热加载：`aurabot on/off` 秒级生效不用重启）。验收（已过）：WSL 内 `sim` 人格全链路；WS 实连 SnowLuma（`self_id` 与配置核对一致）；`on`→热加载→连上、`off`→热加载→断开的闭环日志。当前待命（总开关关）；切换时先停旧栈 `dsh-web.service` 防双重回复。

**M2 · 权限档位 + 插件雏形**：`.zcode/agents/` 两档 agent 定义 + SessionStart hook（聊天上下文注入）+ spawn 参数按档位收紧 + 安全测试用例；插件（`.zcode-plugin/`）骨架带最小 MCP server（qq_chat_history 等）。
验收：社交档 spawn 参数禁本地工具实测生效；主人私聊可让她动电脑、群里不能。

**M3 · 记忆/心情/表情包**（完成，2026-10-27）：三模块从上游原样搬入（features/stickers|companion|memory，1254 行），桥内 core/llm.js 重写为「zcode -p 一次性小任务」实现上游 askModel(dsh,o) 契约（表情备注/心情判断/记忆提炼，零额外凭据）；hub 扩展（chatlog 读取/recentMedia/turnHasOwner 时间窗近似/contextInject 每轮注入挂点 + 表情自动推荐恢复）；面板接口真实化（/stickers /insights /memories /sticker/* 全通）。
验收（已过）：心情 65→83→92→100 带理由和历史；记忆 add→recall→contextFor 注入全链（「主人最喜欢的番…」召回并进提示词）；表情面板上传→库索引→pickForReply 匹配（「卖萌」标签匹配日志确认）；mood 词典外词汇得 0 分属上游既有行为。

**M4 · 群聊 + 主动搭话**：群策略链路实测（@/拍一拍/话题相关度插话）、speakup（触发源改为桥进程定时评估，不再依赖宿主）、语音条（edge-tts）。
验收：群聊不刷屏、可被拍一拍唤起、会主动找主人聊天。

**M5 · 打磨**：开放 HTTP 接口（core/bridge.js）、主人命令全套（chat/commands.js）、模块内核热加载（core/modules.js）、上游同步策略、（可选）自托管 zcode-server + webhook bot 升级路径验证。

## 7. 风险与未决问题

| # | 风险/问题 | 应对 |
|---|---|---|
| ~~1~~ | ~~自动化最小周期未实测~~ → **已核实并绕开**：全局 20 条上限、最小 1 分钟；主通道已改 CLI 驱动（实时），自动化只剩兜底用途 | 见 §0.5 #7 |
| ~~2~~ | ~~值守会话上下文膨胀~~ → **已消解**：per-chat CLI 会话天然隔离 | 剩余课题：单会话内上下文随轮数膨胀 → `maxContextTurns` 滚动换新 + 上游 compaction 思路 |
| 3 | 社交档安全：CLI headless 默认 `--mode yolo`（全自动权限） | 桥进程按档位强制传 `--mode` + `--disallowed-tools`；M2 加安全测试用例（「群里让她删文件必须失败」） |
| 4 | SnowLuma 是第三方闭源组件，更新可能破坏 OneBot 假设 | 锁版本 + 保留上游的探测/降级逻辑 |
| 5 | 上游仍在活跃发版，长期同步成本；ZCode 也在活跃开发（CLI 参数面 0.17 与主干已有差异：主干 `--output-format`，0.17 是 `--json`） | 以模块为单位定期 cherry-pick；driver 对 CLI 输出做容错解析（取最后一个可解析的 JSON 对象） |
| 6 | 桥内直连模型 API 的 key 管理与脱敏 | 沿用上游 `redact.js`，key 不进日志、不进 CLI 会话 |
| 7 | 每条消息 spawn 一个 CLI 进程，冷启动成本（首轮实测 ~25s） | 连续对话可接受；M4 评估简单消息小模型直答 + app-server 常驻进程两种提速 |
| 8 | 未决：`--attach` 图片在人格侧的实际理解效果、群聊提示词在 CLI 上下文里的表现 | M2/M4 实测定稿 |

## 8. 目录规划

```
aurabot-zcode/
├── spec.md                # 本文件
├── dsh-aurabot-qq/        # 上游源码（只读参照）
├── zcode-src/             # ZCode 开源源码稀疏克隆（只读参照，bots/services/docs 等）
├── bridge/                # M1：桥进程（已实现）
│   ├── aurabot.js         # CLI：setup/status/on/off/dry/sim/sessions/reset/persona/log/start
│   ├── personas/          # 自带人格卡（dafeiyu）
│   └── src/
│       ├── app.js         # 装配：config/logger/snowluma/onebot/hub/zcode + 看门狗
│       ├── zcode.js       # CLI 驱动：spawn -p --json --resume，会话表，并发上限
│       ├── core/          # store（数据目录→workspace/）/ logger / config / redact / net
│       ├── onebot/        # 上游原样
│       ├── snowluma/      # 上游原样
│       ├── chat/          # inbound/reply/access/group-policy/group-roles 上游原样；hub 重写驱动段
│       └── persona/       # 人格卡读写 + 规则文本（写进 AGENTS.md）
├── workspace/             # 运行时数据（config/logs/queue/chatlog/sessions/personas + AGENTS.md，CLI 会话的 cwd）
├── plugin/                # M2：ZCode 插件（.zcode-plugin/ + agents/ + hooks/ + skills/ + mcp/）
└── docs/                  # 安装向导、命令手册（M2 起）
```

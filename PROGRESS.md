# 进度：做到哪了

> 持续更新的进度账本。架构与设计决策见 [spec.md](./spec.md)，使用方法见 [README](./README.md)。

## 当前状态（2026-10-27）：M4 完成，生产运行中

机器人以「大肥鱼」人格在 QQ 常驻（生产模式：真收真发），Web 面板为上游原版复刻。

```
QQ ⇄ SnowLuma(OneBot v11, C:\Aurabot\snowluma) ⇄ 桥进程 daemon ⇄ zcode CLI（per-chat 持久会话）
                                                      └─ Web 面板 http://127.0.0.1:51073
```

| 里程碑 | 状态 | 内容 |
|---|---|---|
| M0 源码研读 + spec | ✅ | 上游架构/依赖面全解；**ZCode 开源核实**（§0.5：CLI `-p --json --resume`、原生 bots 的局限、自动化 20 条上限） |
| M1 桥进程 + CLI 驱动 | ✅ | 上游零依赖层原样搬入；hub 会话驱动段重写（每 QQ 聊天一个 `--resume` 持久会话）；`aurabot.js` CLI 全套；Windows 原生部署 |
| M1.5 WSL 部署（已弃） | ✅→弃 | WSL 方案完整跑通后，为性能与简洁迁回 Windows 原生（SnowLuma Docker → Windows 版；教训与排查记录保留在 git 历史） |
| M2 权限/插件雏形 | ✅ 部分 | `.zcode-plugin` 插件（MCP server + 会话内 UI 面板）已做；~~spawn 按档位收权限~~ → **M4 补齐**：社交档自动加 `--disallowed-tools Write,Edit,Bash` |
| M3 记忆/心情/表情包 | ✅ | 三模块上游原样搬入；桥内 `core/llm.js` 实现 `askModel` 契约（`zcode -p` 小任务，零额外凭据）；心情按轮注入 + 记忆召回 + 表情自动推荐；面板对应页真实化 |
| **M4 语音/主动搭话/群聊** | ✅ | **edge-tts 语音条**（`voice/tts.js` 搬入，私有 pyenv，Windows 语音兜底；`<voice>` 拆条生效 + 短回复按概率自动变语音 ×心情系数）；**主动搭话**（speakup tick 挂看门狗，`hub.pushToSession` 后台管线，追问 nudge；`aurabot.js speakup fire` 手动触发）；**群聊权限收紧**；面板 `/voice/test`、`/voice/install`、`/speakup/fire` 真实化 |
| Web 面板 | ✅ | **上游 1946 行 React 面板原封复用** + 桥内 DSH API 兼容层（60+ 接口）；DSH 体验 1:1 回归 |
| M5 B 站/空间/开放接口 | ⬜ | 依赖定时框架；开放 HTTP 接口 |

## 已验证的关键事实（踩坑记录）

- **ZCode CLI 是合法的驱动通道**：`-p` 非交互、`--json` 返回 `{sessionId, response, usage}`、`--resume` 跨进程续会话、与桌面共享登录态。桌面版无入站 HTTP（bots webhook 需自托管 server），所以 CLI 直驱优于自动化轮询和原生 bots（详见 spec §0.5）。
- **CLI 子进程不认 `ZCODE_DATA_BASE_DIR`**（源码只认 `HOME`）；Electron userData 用 `ZCODE_DESKTOP_USER_DATA_DIR`。多实例隔离 = `HOME` 重定向 + `--user-data-dir` 命令行。
- **CLI 安装目录必须有 `resources/glm/provider/zcode-builtin.json`**——换目录部署最容易漏，报「无法定位 CLI ZCode Built-in Provider Config」就是它。
- **SnowLuma 自带的 node.exe 可能被安全策略按程序拦包**（症状：回环连接 SYN 全丢、WebUI 连不上）——让它改用系统 node（≥24）即可。
- **daemon 别用 `Start-Process` 重定向管道跑**（父进程退出 → EPIPE 静默死），用 Task Scheduler；单例锁（面板端口 51073）防双开。
- 心情关键词词典是上游既定范围（「累/骂」不在表里得 0 分），模型判心情（`mood.judge: true`）可覆盖长尾。
- **本机网络对 edge-tts 的 WSS 握手直接回 403**（curl/.NET 双栈验证，HTTP GET 却通）——edge 装了也合不出声，`edgeSynth` 超时已收到 15s，失败自动退 Windows 语音（Huihui，约 0.6s）。想用好音色：配 `voice.engine: cosyvoice/gptsovits/http` 自建 TTS，或换网络再按面板「安装 edge-tts」。
- **看门狗里引用模块实例要用 `app.xxxModule`**——裸 `xxxModule` 名在 `createApp` 作用域里不存在，报错只出现在 debug 日志（`tick` 调用被 try 包住），靠日志 grep 才发现。

## 下一步（按价值排序）

1. **M2 收尾**：ZCode 插件的 MCP 工具补齐（qq_chat_history / 表情管理进对话，`rulesText` 里那两行承诺兑现）
2. **M5**：B 站/空间（需要定时任务框架，可复用看门狗 tick 模式）、开放 HTTP 接口
3. 群聊长测：社交档收紧后的真实群里跑几天，调 `group` 策略参数

## 部署速查（Windows）

```powershell
# 1. SnowLuma：解压官方 release 到 C:\Aurabot\snowluma，删掉自带 node.exe（用系统 node），桥会自动启动它
# 2. 桥：Task Scheduler 任务 "aurabot-bridge"（登录自启，node aurabot.js start）
# 3. QQ：装 QQ 客户端，登录机器人号扫码——桥每 30s 自动探测注入
# 4. 面板：http://127.0.0.1:51073
# 5. 语音：edge-tts 已装在 %USERPROFILE%\Aurabot\pyenv（本机被 403 用不了，自动退 Windows 语音；
#    想换自建 TTS 填 config.json 的 voice.cosyvoice / voice.gptsovits / voice.http）
```

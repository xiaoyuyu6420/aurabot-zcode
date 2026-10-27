# aurabot-zcode

把 [dsh-aurabot-qq](https://github.com/accomplish07zrh-eng/dsh-aurabot-qq)（DeepSeek Harness 的 QQ 人格机器人插件）适配到 [ZCode](https://github.com/zai-org/ZCode)（已开源）。

- **适配规格**：[spec.md](./spec.md) —— 架构映射、开源核实结论（§0.5）、里程碑与验收标准
- **上游源码**：`dsh-aurabot-qq/`（只读参照，v1.0.4，不直接修改）
- **ZCode 源码**：`zcode-src/`（稀疏克隆只读参照：bots/services/docs/shared 等）
- **M1 已完成**：`bridge/`（桥进程 + CLI）可用，见下文「当前状态」

## 架构（v1 定稿：CLI 驱动主通道）

```
QQ ⇄ SnowLuma(OneBot v11) ⇄ 桥进程(bridge/)
                              ├─ 入站解析/访问控制/群聊策略/防抖合并（上游同构）
                              └─ zcode 驱动：spawn zcode.cjs -p … --json [--resume …]
                                        │  每个 QQ 聊天一个持久 CLI 会话
                                        ▼
                              zcode CLI 会话（--cwd workspace，人格 = AGENTS.md）
```

为什么不是「自动化任务轮询队列」或「原生 bots webhook」：见 spec.md §0.5——桌面版没有入站 HTTP；原生 webhook bot 需自托管 server 且一次只绑一个用户、群聊仅飞书。CLI 直驱同时解决了实时性和 per-chat 隔离两个原方案的最大风险。

## 当前状态（M1 完成，2026-10-26）

- ✅ 上游零依赖层原样搬入（onebot/snowluma/inbound/reply/access/group-policy/group-roles/net/redact）
- ✅ hub 会话驱动段重写：防抖合并 → `zcode -p --json` → 拆条发回（`|||`、`<voice>`、`<sticker:>`、`<poke>`、`<reply:编号>`、`[沉默]` 全保留）
- ✅ per-chat 持久会话（`--resume`，实测跨回合记得上文）、登录号核对连错即断、试运行默认开
- ✅ `sim` 全链路实测通过（真调 ZCode，不真发 QQ）
- ✅ M3 完成（2026-10-27）：心情/记忆/表情包三模块上线——心情随聊天起伏并按轮注入、记忆跨重启召回、表情库面板管理+自动配表情；面板 http://127.0.0.1:51073 为上游原版复刻
- ⬜ M4：语音条 + 主动搭话 + 群聊打磨；M5：B 站/空间/开放接口

## 用法

前置：Windows + ZCode Desktop（装好并登录过）+ Node ≥ 22。SnowLuma 按上游文档自己下载解压（EULA 不允许自动部署）。

```bash
cd bridge
node aurabot.js setup        # 首次向导：机器人号 / 主人号 / SnowLuma 目录
node aurabot.js status       # 总览（CLI 探测 / 连接 / 会话 / 开关）
node aurabot.js sim "在吗"   # 不连 QQ 也能测：真调 ZCode 生成回复，但不发出去
node aurabot.js on           # 总开关（默认关；开了还有试运行兜底）
node aurabot.js dry off      # 确认没问题后关试运行（此时才真发 QQ）
node aurabot.js start        # 常驻跑（Ctrl+C 退出）
```

其余命令：`sessions`（会话表）、`reset [聊天ID]`、`persona [id]`、`log [n]`。

## 生产部署（WSL Ubuntu-2，2026-10-26 已装好）

机器人在 WSL 里常驻，不占 Windows：

| 组件 | 位置 / 形态 |
|---|---|
| SnowLuma（含 Linux QQ，Docker） | 容器 `snowluma`（已登录 3413283914）；WebUI 5099 / noVNC 6081 / OneBot WS 127.0.0.1:3001 |
| ZCode CLI | `/home/ubuntu/zcode-runtime/`（从桌面版拷的纯 JS runtime + provider 配置 + 凭据），node 22 直接跑 |
| 桥进程 | `/home/ubuntu/aurabot-zcode/bridge`，systemd 服务 `aurabot-bridge`（开机自启，当前待命：总开关关） |
| 数据区 | `/home/ubuntu/aurabot-zcode/workspace`（config/日志/队列/会话表/AGENTS.md 人格） |

日常操作（WSL 内，`cd ~/aurabot-zcode/bridge`）：

```bash
node aurabot.js status      # 看连接/开关/会话
node aurabot.js on / off    # 总开关（服务热加载，秒级生效，不用重启服务）
node aurabot.js dry off     # 关试运行（真发 QQ）
node aurabot.js sim "文本"  # 模拟测试
node aurabot.js log 50      # 看日志
sudo systemctl status aurabot-bridge   # 服务本身
```

⚠️ **切换前必读**：旧栈 `dsh-web.service`（DSH 版大肥鱼）现在还连着同一个 SnowLuma 在跑。两边同时开会**双重回复**。切换顺序：

```bash
sudo systemctl stop dsh-web && sudo systemctl disable dsh-web   # 1. 停旧栈
node ~/aurabot-zcode/bridge/aurabot.js on                        # 2. 开新桥（先试运行观察）
node ~/aurabot-zcode/bridge/aurabot.js dry off                   # 3. 确认没问题后真发
# 回滚：反向三步
```

代码改动流程：Windows 侧 `Desktop/aurabot-zcode/bridge/` 是源码，改完拷进 WSL 再 `sudo systemctl restart aurabot-bridge`。

## 快速导航

| 想看什么 | 位置 |
|---|---|
| 开源核实结论（bots/自动化/CLI 能力） | `spec.md` §0.5 |
| 桥进程装配 | `bridge/src/app.js` |
| zcode CLI 驱动（会话映射核心） | `bridge/src/zcode.js` |
| 聊天中枢（重写的会话驱动段） | `bridge/src/chat/hub.js` |
| DSH 依赖面总入口（上游） | `dsh-aurabot-qq/src/host.js:35` |
| 模块扩展 API（上游） | `dsh-aurabot-qq/src/modules/API.md` |
| 用户手册（上游） | `dsh-aurabot-qq/docs/USER-MANUAL.md` |

下一步从 spec.md §6 的 **M2（权限档位 + 插件雏形）** 开始。

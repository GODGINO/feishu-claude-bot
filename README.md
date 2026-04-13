# Sigma — 飞书 AI 工作流助手

将 Claude Code 的完整能力（代码编写、文件操作、网页浏览、命令执行）桥接到飞书，支持多人多会话、微信互通、远程设备控制。

## 核心能力

- **多会话管理** — 群/私聊独立上下文，`--resume` 持久化，crash 自动恢复
- **三渠道互通** — 飞书 + 微信 + Admin Dashboard 共享同一个 Claude 上下文，消息跨渠道回显
- **远程设备控制** — Sigma Terminal (macOS/Windows) + 浏览器插件，远程执行命令、编辑代码、控制屏幕、操作手机
- **卡片交互** — 流式卡片回复、工具调用面板、交互按钮（动作按钮 + 链接按钮）
- **邮件收发** — IMAP/SMTP 多账号，加密存储，实时推送
- **定时任务** — Cron 表达式，热加载，绑定会话执行
- **Chrome 浏览器** — 按需启动 Chrome，MCP 操作网页
- **Skill 系统** — 可扩展技能框架，内置 20+ 技能
- **记忆系统** — 基于 claude-mem 的跨会话记忆
- **Admin Dashboard** — Web 管理后台，会话管理、知识库编辑、在线聊天

## 架构

```
飞书用户 ←── 飞书 WebSocket ──→ Bot 服务器 (localhost:3333)
微信用户 ←── iLink 长轮询 ────→      │
Admin   ←── REST API ─────────→      │
                                      ├── Claude Code 进程池 (stream-json + --resume)
                                      ├── Relay Server (WebSocket 桥 → 远程设备)
                                      ├── Admin Dashboard (React SPA)
                                      └── Cloudflare Tunnel → sigma.tixool.com
```

### 远程设备控制架构

```
Claude → remote-terminal-mcp.ts (stdio MCP)
  → HTTP POST /api/relay/command
    → relay-server.ts (WebSocket 桥, HMAC 命令签名)
      → Sigma Terminal.app / 浏览器插件 (验证签名后执行)
```

**35 个远程工具**：
| 类别 | 工具 |
|------|------|
| Code Use (9) | shell_exec, file_read/write/edit, glob, grep, system_info, open, notify |
| Computer Use (13) | screenshot, mouse (move/click/drag/scroll/position), keyboard (type/key), app (launch/list/focus/quit), window (list/resize) |
| Phone Use (13) | adb_devices/info, adb_screenshot, adb_tap/swipe/long_press/text/keyevent, adb_install/app_list/app_launch/app_force_stop |

## 安全

### 四层纵深防御

```
┌──────────────────┬───────────────────────────────────────────┐
│ TLS              │ WSS 加密，中间人无法篡改                   │
├──────────────────┼───────────────────────────────────────────┤
│ Cloudflare       │ 证书验证，无法伪造域名                     │
├──────────────────┼───────────────────────────────────────────┤
│ SessionKey       │ 不可枚举，session 必须存在                 │
├──────────────────┼───────────────────────────────────────────┤
│ HMAC 命令签名     │ 每条命令签名，客户端验证后才执行            │
└──────────────────┴───────────────────────────────────────────┘
```

### 服务端防护

- 双密码 Admin 登录 + Rate Limit (5 次/5 分钟)
- Timing-safe token 比较
- 所有列表端点需认证 (relay/status, session-names, sessions)
- 下载端点严格文件名白名单
- file_write 限制 home 目录 + 危险命令拦截
- shell_exec 环境变量白名单
- 提示词注入防护 (sender name 转义)

## 快速开始

### 1. 创建飞书应用

1. [飞书开放平台](https://open.feishu.cn/app) 创建企业自建应用，添加「机器人」能力
2. 配置事件订阅：`im.message.receive_v1`
3. 配置权限：`im:message`、`im:message:send_as_bot`、`im:chat`
4. 记录 App ID 和 App Secret

### 2. 安装与配置

```bash
git clone https://github.com/GODGINO/feishu-claude-bot.git
cd feishu-claude-bot
bash scripts/setup.sh
vim .env
```

### 3. 启动

```bash
npm run bot          # 启动
npm run bot:restart  # 重启
npm run bot:stop     # 停止
npm run bot:status   # 状态
npm run bot:log      # 日志
```

## 配置

`.env` 文件：

| 变量 | 必填 | 说明 |
|------|------|------|
| `FEISHU_APP_ID` | 是 | 飞书应用 App ID |
| `FEISHU_APP_SECRET` | 是 | 飞书应用 App Secret |
| `ADMIN_PASSWORD` | 是 | Admin 双密码，逗号分隔（如 `pass1,pass2`） |
| `CF_TUNNEL_URL` | 否 | Cloudflare Tunnel URL |
| `CF_TUNNEL_TOKEN` | 否 | Cloudflare Tunnel Token |
| `CLAUDE_MODEL` | 否 | Claude 模型，默认 `sonnet` |
| `CLAUDE_PATH` | 否 | Claude CLI 路径 |
| `MAX_CONCURRENT` | 否 | 最大并发数，默认 `3` |
| `PROCESS_TIMEOUT` | 否 | 进程超时(ms)，默认 `120000` |
| `EMAIL_ENCRYPTION_KEY` | 否 | 邮箱凭据加密密钥 |

## 项目结构

```
src/
├── index.ts                    # 入口
├── config.ts                   # 配置
├── feishu/                     # 飞书 SDK
│   ├── event-handler.ts        # 事件处理
│   ├── message-sender.ts       # 消息发送（卡片/文本）
│   ├── card-builder.ts         # 卡片构建（工具面板/按钮）
│   ├── card-streamer.ts        # 流式卡片 + heartbeat
│   ├── im-mcp.ts               # 飞书 IM MCP 服务
│   └── feishu-tools-mcp.ts     # 飞书工具 MCP
├── bridge/                     # 消息桥接
│   ├── message-bridge.ts       # 核心路由 + 三渠道回显
│   ├── message-queue.ts        # 消息队列
│   ├── command-handler.ts      # /命令处理
│   └── group-context.ts        # 群聊上下文
├── claude/                     # Claude Code 管理
│   ├── process-pool.ts         # 持久进程池 (stream-json)
│   ├── stream-parser.ts        # 流式解析 (含 subagent 事件)
│   ├── mcp-manager.ts          # MCP 配置管理
│   ├── session-manager.ts      # 会话目录管理
│   └── runner.ts               # 运行器
├── admin/                      # Admin Dashboard
│   ├── server.ts               # HTTP + WebSocket 服务
│   ├── admin-chat.ts           # Admin Chat WebSocket
│   └── routes.ts               # REST API
├── relay/                      # 远程设备中继
│   ├── relay-server.ts         # WebSocket 桥 (HMAC 签名)
│   ├── remote-terminal-mcp.ts  # 终端 MCP (35 tools)
│   ├── remote-browser-mcp.ts   # 浏览器 MCP (15 tools)
│   └── protocol.ts             # 协议类型
├── wechat/                     # 微信桥接
│   └── wechat-bridge.ts        # iLink Bot 长轮询
├── email/                      # 邮件系统
├── chrome/                     # Chrome 管理
├── scheduler/                  # 定时任务
└── utils/

sigma-terminal/                 # Electron 桌面客户端
├── src/main/
│   ├── index.ts                # 入口 (Menubar Tray App)
│   ├── relay-client.ts         # WebSocket + HMAC 验证
│   ├── executor.ts             # 35 tool 实现
│   ├── security.ts             # 危险命令拦截
│   ├── computer-use/           # 屏幕/鼠标/键盘/应用/窗口
│   ├── phone-use/              # ADB 设备控制
│   ├── onboarding.ts           # macOS 权限请求
│   └── abort-controller.ts     # ESC 全局中止
└── src/renderer/               # Tray Popup UI

browser-extension/              # Chrome 扩展 (MV3)
├── manifest.json
├── service-worker.js           # WebSocket + HMAC 验证
├── content.js                  # DOM 操作 + a11y 树
└── popup.html/js               # Session 管理 UI

skills/                         # 内置技能 (20+)
├── browser/                    # 浏览器操作
├── terminal/                   # 远程终端
├── card-buttons/               # 卡片按钮
├── email/                      # 邮箱管理
└── ...

web/                            # Admin Dashboard (React + Vite)
├── src/pages/                  # 页面
├── src/components/             # 组件 (ChatHistory, KnowledgeView...)
└── src/lib/api.ts              # API 客户端
```

## License

[MIT](LICENSE)

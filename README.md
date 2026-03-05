# feishu-claude-bot

飞书 + Claude Code 的 AI 工作流助手。将 Claude Code 的完整能力（代码编写、文件操作、网页浏览、命令执行）桥接到飞书，支持多人多会话。

## 功能

- **多会话管理** — 每个飞书群/私聊独立会话，上下文持久化，支持 `--resume` 自动恢复
- **邮件收发** — IMAP/SMTP 多账号，加密存储凭据，支持实时推送
- **定时任务** — Cron 表达式，支持热加载，可绑定指定会话执行
- **Chrome 浏览器** — 按需启动 Chrome，通过 MCP 操作网页（截图、点击、填写）
- **Skill 系统** — 可扩展的技能框架，内置邮件/定时任务/开发者注册等技能
- **记忆系统** — 基于 [claude-mem](https://github.com/thedotmack/claude-mem) 的跨会话记忆
- **图片识别** — 支持发送图片给 Claude 进行多模态分析
- **后台任务** — 长时间任务自动转后台，完成后推送通知

## 架构

```
飞书用户 ──► 飞书开放平台 ──► event-handler ──► message-bridge ──► process-pool
                                                     │                    │
                                                     │              Claude Code
                                                     │              (persistent)
                                                     │                    │
                                                message-queue ◄──── stream-parser
                                                     │
                                              message-sender ──► 飞书卡片消息
```

```
sessions/
├── group_xxx/              # 每个群/私聊一个目录
│   ├── .claude/settings.json  # 权限 + MCP 配置
│   ├── mcp-servers.json       # Chrome MCP (按需加载)
│   ├── start-chrome.sh        # Chrome 启动脚本
│   └── ...                    # 会话文件、技能、邮件配置
```

## 前置依赖

- **Node.js** >= 18
- **[Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code)** — `npm install -g @anthropic-ai/claude-code`
- **[claude-mem 插件](https://github.com/thedotmack/claude-mem)** — `claude plugins install claude-mem@thedotmack`（`setup.sh` 自动安装）

## 快速开始

### 1. 创建飞书应用

1. 前往 [飞书开放平台](https://open.feishu.cn/app) 创建企业自建应用
2. 添加「机器人」能力
3. 配置事件订阅（接收消息）：
   - `im.message.receive_v1` — 接收消息
4. 配置权限：
   - `im:message` — 获取与发送消息
   - `im:message:send_as_bot` — 以机器人身份发消息
   - `im:chat` — 获取群信息
5. 记录 App ID 和 App Secret

### 2. 安装与配置

```bash
git clone https://github.com/gezenghui/feishu-claude-bot.git
cd feishu-claude-bot

# 一键安装（检查依赖 + 安装 claude-mem + 编译）
bash scripts/setup.sh

# 编辑 .env 填写飞书凭据
vim .env
```

### 3. 启动

```bash
npm run bot          # 启动（后台运行）
npm run bot:stop     # 停止
npm run bot:restart  # 重启
npm run bot:status   # 查看状态
npm run bot:log      # 查看最近日志
```

开发模式（前台运行，实时日志）:
```bash
npm run dev
```

### 4. 配置飞书 Webhook

Bot 启动后会在终端输出回调地址，将其填入飞书开放平台的事件订阅 URL。

## 配置说明

`.env` 文件：

| 变量 | 必填 | 说明 |
|------|------|------|
| `FEISHU_APP_ID` | 是 | 飞书应用 App ID |
| `FEISHU_APP_SECRET` | 是 | 飞书应用 App Secret |
| `CLAUDE_MODEL` | 否 | Claude 模型，默认 `sonnet` |
| `CLAUDE_PATH` | 否 | Claude CLI 路径，默认自动检测 |
| `SESSIONS_DIR` | 否 | 会话目录，默认 `./sessions` |
| `MAX_CONCURRENT` | 否 | 最大并发数，默认 `3` |
| `PROCESS_TIMEOUT` | 否 | 进程超时(ms)，默认 `120000` |
| `SYSTEM_PROMPT` | 否 | Bot 系统提示词 |
| `LOG_LEVEL` | 否 | 日志级别，默认 `info` |

也可以将系统提示词写入 `system-prompt.txt` 文件（优先级低于环境变量）。

## 项目结构

```
src/
├── index.ts                 # 入口：启动飞书客户端 + 消息桥
├── config.ts                # 配置加载
├── feishu/                  # 飞书 SDK 封装
│   ├── client.ts            # 飞书客户端初始化
│   ├── event-handler.ts     # 事件订阅处理
│   ├── message-sender.ts    # 消息发送（卡片/文本）
│   └── typing.ts            # 打字中状态
├── bridge/                  # 消息桥接层
│   ├── message-bridge.ts    # 核心：飞书 ↔ Claude 消息路由
│   ├── message-queue.ts     # 消息队列 + 并发控制
│   ├── command-handler.ts   # /命令处理
│   ├── group-context.ts     # 群聊上下文注入
│   └── email-setup.ts       # 邮箱交互式配置
├── claude/                  # Claude Code 进程管理
│   ├── process-pool.ts      # 持久进程池（stream-json 模式）
│   ├── stream-parser.ts     # 流式 JSON 解析
│   ├── mcp-manager.ts       # MCP 配置管理（Chrome/Feishu/自定义）
│   ├── session-manager.ts   # 会话目录管理
│   └── runner.ts            # 类型定义
├── email/                   # 邮件系统
│   ├── account-store.ts     # 加密凭据存储
│   ├── imap-client.ts       # IMAP 收件
│   ├── smtp-client.ts       # SMTP 发件
│   ├── idle-monitor.ts      # IMAP IDLE 实时推送
│   ├── email-processor.ts   # 邮件处理
│   └── cli.ts               # 邮件 CLI 工具
├── chrome/
│   └── idle-checker.ts      # Chrome 空闲自动关闭
├── scheduler/
│   └── cron-runner.ts       # 定时任务执行器
└── utils/
    └── logger.ts            # 日志工具

scripts/                     # 运维脚本
├── bot.sh                   # Bot 启停管理
├── setup.sh                 # 一键安装
├── chrome-mcp-wrapper.sh    # Chrome MCP 启动包装
├── memory-mcp.cjs           # 记忆 MCP 服务
├── cron-mcp.cjs             # 定时任务 MCP 服务
└── http-mcp-proxy.cjs       # HTTP→stdio MCP 代理

skills/                      # 内置技能
├── author/                  # 开发者身份注册
├── cron/                    # 定时任务管理
├── email/                   # 邮箱管理
├── feishu/                  # 飞书 Bot 管理
├── memory/                  # 记忆管理
└── skill-creator/           # 技能创建器
```

## License

[MIT](LICENSE)

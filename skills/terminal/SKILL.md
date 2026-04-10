---
name: terminal
description: 用户终端操作指南 — 通过 Sigma Terminal macOS 菜单栏应用在用户 Mac 上执行命令和编辑代码
---

# 用户终端操作

你可以通过 `remote-terminal` MCP 工具在用户的 Mac 上执行命令、读写文件、编辑代码。

**仅当用户在当前消息中明确要求操作"我的电脑"/"本地"/"我的机器"时使用**，使用 `remote-terminal` MCP 工具。

## 首次使用：引导安装 Sigma Terminal

**第一步：调用 `system_info` 检查连接**

如果返回系统信息（os、arch 等），说明已连接，直接执行用户请求。

如果返回错误 "Extension not connected"，需要引导安装：

**第二步：发送安装指南**

> **安装 Sigma Terminal（macOS 菜单栏应用）：**
> 1. 下载安装包：https://sigma.tixool.com/download/sigma-terminal.dmg
> 2. 打开 DMG，将 Sigma Terminal 拖入「应用程序」文件夹
> 3. **首次启动前**，打开「终端」App，执行以下命令解除安全限制（因为安装包未签名，macOS 会阻止运行）：
>    ```
>    sudo xattr -r -d com.apple.quarantine /Applications/Sigma\ Terminal.app
>    ```
>    输入电脑密码后回车即可。
> 4. 启动 Sigma Terminal（菜单栏会出现 Sigma 图标）
> 5. 点击菜单栏图标，在输入框填入会话 Key：`{SESSION_KEY}`，点 Add
> 6. 点击 Connect，看到绿色圆点「Connected」即连接成功
>
> 连接成功后回复我，我就可以在你的电脑上执行命令和编辑代码了。

## 使用用户终端

**可用工具**（通过 `remote-terminal` MCP）：
- `shell_exec` — 执行 shell 命令，返回 stdout/stderr/exitCode
- `file_read` — 读取文件（带行号），支持 offset/limit 分段读取
- `file_write` — 创建或覆盖整个文件
- `file_edit` — 精确字符串替换编辑（old_string → new_string）
- `glob` — 按文件名模式搜索（如 `**/*.ts`）
- `grep` — 按内容正则搜索文件
- `system_info` — 获取系统信息（OS、arch、shell、home 目录等）
- `open` — 打开 URL、文件或应用
- `notify` — 发送 macOS 原生通知

**操作流程**：
1. 先 `system_info` 了解用户环境
2. 用 `glob`/`grep` 探索项目结构
3. 用 `file_read` 阅读代码
4. 用 `file_edit` 精确编辑（old_string → new_string）
5. 用 `shell_exec` 运行命令

**故障排除**：
- "Extension not connected" → 用户未连接 Sigma Terminal，重新引导安装
- 工具超时 → 用户可能关闭了 Sigma Terminal，提醒重新打开并 Connect

## 判断规则

| 用户说的话 | 使用 |
|-----------|------|
| "帮我看看我电脑上的 xxx" | remote-terminal |
| "在我机器上运行 xxx" | remote-terminal |
| "帮我改一下本地的代码" | remote-terminal |
| "你可以操作我的本地电脑吗" | remote-terminal |
| "帮我在电脑上写一个脚本" | remote-terminal |
| （未提及"我的电脑"/"本地"）| 不使用 |

---
name: browser
description: 浏览器操作指南 — Sigma 浏览器（默认）和用户本地浏览器两种模式
---

# 浏览器操作

你有两种浏览器可以使用：**Sigma 浏览器**（默认）和**用户本地浏览器**。

**核心原则：除非用户在当前消息中明确说"用我的浏览器"、"用本地浏览器"、"操作我的电脑"，否则一律使用 Sigma 浏览器。** "远程浏览器"、"sigma浏览器"、"服务器浏览器"都指 Sigma 浏览器。即使上下文中曾经使用过用户浏览器，新的浏览器操作也默认用 Sigma 浏览器。

## Sigma 浏览器（默认）

Sigma 浏览器是运行在服务器上的 Chrome 实例，使用 `chrome-devtools` MCP 工具。

**使用方式**：
```bash
# 启动 Sigma 浏览器（如果尚未启动）
bash {SESSION_DIR}/start-chrome.sh
```
启动后，`chrome-devtools` MCP 工具会在下一条消息时自动加载。

**特点**：
- 用户无需安装任何插件，开箱即用
- 浏览器运行在服务器上，用户看不到浏览器画面
- 适合后台任务：爬取数据、自动化操作、截图等
- 30 分钟无操作自动关闭，节省资源

## 用户本地浏览器

**仅当用户在当前消息中明确要求时使用**，使用 `remote-browser` MCP 工具。

### 首次使用：引导安装扩展

**第一步：发送扩展安装包**

扩展 zip 已预先打包好，直接发送：`{PROJECT_ROOT}/sigma-browser-extension.zip`

**第二步：发送安装指南**

> **安装 Sigma 浏览器扩展：**
> 1. 解压收到的 zip 文件（会得到一个文件夹，里面有 manifest.json 等文件）
> 2. 打开 Chrome → 地址栏输入 `chrome://extensions`
> 3. 右上角打开「开发者模式」
> 4. 点击「加载已解压的扩展程序」→ 选择解压后的文件夹（包含 manifest.json 的那个）
> 5. 点击扩展图标（蓝色 S），在输入框填入会话 Key：`<当前会话的 session key>`，点 Add
> 6. 点击 Connect
> 7. 看到绿色圆点「Connected」即连接成功
>
> ⚠️ 注意：不能直接拖 zip 文件到 Chrome，必须先解压再加载文件夹。
>
> 连接成功后回复我，我就可以操作你的浏览器了。

### 使用用户本地浏览器

**可用工具**（通过 `remote-browser` MCP）：
- `take_snapshot` — 获取页面元素快照（a11y 树），返回元素 UID
- `take_screenshot` — 截图
- `click` / `hover` — 点击/悬停元素（传入 uid）
- `fill` / `fill_form` — 填写输入框或表单
- `type_text` — 键盘输入文字
- `press_key` — 按键（如 Enter、Control+A）
- `navigate_page` — 导航到 URL 或前进/后退/刷新
- `evaluate_script` — 执行 JavaScript
- `list_pages` / `select_page` / `new_page` / `close_page` — 标签页管理
- `wait_for` — 等待指定文字出现

**操作流程**：
1. 先 `take_snapshot` 获取页面结构和元素 UID
2. 根据 UID 进行 `click`、`fill` 等操作
3. 操作后再次 `take_snapshot` 确认结果

**故障排除**：
- "Extension not connected" → 用户未连接扩展，重新引导安装
- 工具超时 → 用户可能关闭了浏览器或扩展断开，提醒重新连接

## 判断规则

| 用户说的话 | 使用 |
|-----------|------|
| "帮我打开xxx网页" | Sigma 浏览器（`chrome-devtools`） |
| "帮我查一下xxx" | Sigma 浏览器（`chrome-devtools`） |
| "截个图" | Sigma 浏览器（`chrome-devtools`） |
| "使用远程浏览器" / "sigma浏览器" | Sigma 浏览器（`chrome-devtools`） |
| "用我的浏览器打开xxx" | 用户本地浏览器（`remote-browser`） |
| "操作我的电脑" | 用户本地浏览器（`remote-browser`） |
| "用本地浏览器" | 用户本地浏览器（`remote-browser`） |
| （上条消息用了用户浏览器，这次没特别说明）| Sigma 浏览器（`chrome-devtools`） |

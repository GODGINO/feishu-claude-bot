---
name: feishu-mcp-bind
description: |
  飞书 MCP 绑定引导。当用户尝试使用飞书文档/表格/日历/任务等功能但未绑定 MCP 时，引导用户完成绑定。

  **当以下情况时使用此 Skill**:
  (1) 用户想使用飞书功能但系统提示未绑定 MCP
  (2) 用户询问如何绑定飞书
  (3) 用户发送了飞书 MCP URL（以 https://mcp.feishu.cn 开头的链接）
---

# 飞书 MCP 绑定引导

## 什么是飞书 MCP？

飞书 MCP（Model Context Protocol）让 Sigma bot 能以你的身份操作飞书文档、多维表格、日历、任务等。每个用户需要独立绑定自己的 MCP URL。

## 绑定流程

### 步骤 1：获取 MCP URL

引导用户访问以下链接获取自己的 MCP URL：

```
https://open.feishu.cn/page/mcp
```

告诉用户：
1. 打开上面的链接
2. 登录飞书账号
3. 在页面上找到 **MCP 链接**（以 `https://mcp.feishu.cn` 开头的 URL）
4. 复制该链接，发送给我

### 步骤 2：接收并保存 URL

当用户发送了 MCP URL（以 `https://mcp.feishu.cn` 开头）：

1. 从消息上下文获取用户的 open_id（`ou_xxx`）和名字
2. 读取 `authors.json`，更新该用户的 `feishuMcpUrl` 字段：

```bash
# 读取现有 authors.json
cat authors.json

# 更新 feishuMcpUrl 字段（使用 jq 或手动编辑）
# 确保 authors.json 结构正确
```

3. 写入更新后的 `authors.json`
4. 执行 `touch .mcp-changed` 触发 MCP 配置热重载

### 步骤 3：验证绑定

绑定完成后，尝试调用一个简单的飞书 MCP 工具（如 list-tools）来验证连通性。

## 关于 authors.json 结构

```json
{
  "authors": {
    "ou_xxx": {
      "name": "用户名",
      "feishuMcpUrl": "https://mcp.feishu.cn/sse/xxx..."
    }
  }
}
```

## 注意事项

- MCP URL 是敏感信息，不要在群聊中展示完整 URL
- 每个用户的 MCP URL 独立，不能共用
- URL 可能会过期，如果工具调用失败，可能需要重新获取
- 群聊中每个用户使用自己的 MCP，工具名格式为 `mcp__feishu_ou_xxx__<tool>`

# Sigma 工作日志 — 2026-03-13

## 一、技能安装（Tutor 角色）✅

为 Tutor 角色批量安装了 7 个 eachlabs AI 视频处理技能：

| 技能 | 用途 |
|------|------|
| video-format-conversion | 视频格式转换（MP4/WebM/GIF/ProRes） |
| video-speed-adjustment | 速度调整（慢动作/快进/变速） |
| video-localization | 视频本地化（字幕翻译/配音替换） |
| image-upscaling | 图片超分辨率（缩略图/素材高清化） |
| video-trimming | 视频裁剪（精确剪辑/片段提取） |
| video-watermark | 视频水印（品牌 Logo/文字水印） |
| youtube-video-generation | YouTube 视频生成（文本→视频） |

**Tutor 现有技能总计 11 个**：image-to-video、video-stabilization、video-noise-reduction + 以上 7 个 + 此前的 video-format-conversion 等。所有技能均需 `EACHLABS_API_KEY`。

---

## 二、Silvestre Chicken Marketing Kit ⏳

**客户需求**：Silvestre Chicken（Rotisserie & Grill，EST. 2005）
**推广内容**：First Order 10% Off（Online only — App/Web）
**物料尺寸**：24"×36" 海报 + 4"×6" 卡片

### 已完成
- 解析客户 Pre-Onboarding Form 获取品牌信息
- 尝试通过 Chrome 自动化调用 Gemini AI 生成设计（未成功，需 Google 登录）
- 回退到 HTML/CSS 方案，生成两个 mockup：
  - `silvestre_poster_24x36.html` → `silvestre_poster_24x36.png`
  - `silvestre_card_4x6.html` → `silvestre_card_4x6.png`
- 客户提供了 QR 码图片和 Pho 22 参考海报

### 待办
- Amanda 反馈设计不够出彩，表示会提供更多设计样本供学习
- QR 码尚未集成到设计中
- 需要更好的 AI 图片生成工具（Gemini 需登录 Google 账号）

**产出文件**：
- `silvestre_poster_24x36.html` / `.png`
- `silvestre_card_4x6.html` / `.png`
- `gemini_check.jpg` / `gemini_login.jpg` / `gemini_tools.jpg` / `gemini_prompt.jpg` / `gemini_result.jpg`

---

## 三、Peblla 名片编辑（Mina Lu）✅

**任务**：将 Peblla 标准名片上的 "David Kang" 改为 "Albert Tsai"

### 技术挑战与解决
1. **模板获取**：通过飞书 Open API（tenant_access_token）直接下载 PDF，MCP 工具无法暴露 file_key
2. **字体子集问题**：PDF 内嵌 `DFZGCR+Roboto-Medium` 仅含原文字形，新字符渲染失败
3. **解决方案**：从 GitHub 下载完整 Roboto-Medium.ttf（511KB），用 pymupdf redact+insert 方法

### 最终工作流（可复用）
```python
import pymupdf
doc = pymupdf.open('mina_businesscard.pdf')
page = doc[0]
# Redact 姓名区域
page.add_redact_annot(pymupdf.Rect(18, 10, 110, 52), fill=(1,1,1))
page.add_redact_annot(pymupdf.Rect(18, 40, 100, 82), fill=(1,1,1))
page.apply_redactions()
# 插入新名字
page.insert_text((21.49, 42.60), "Albert", fontsize=28, fontfile='Roboto-Medium.ttf', fontname="RobMed")
page.insert_text((21.49, 72.59), "Tsai", fontsize=28, fontfile='Roboto-Medium.ttf', fontname="RobMed")
doc.save('output.pdf')
```

### 永久规则（Mina 指定）
> 以后制作名片，每一个名片需要跟 template 一模一样，Logo、排版、字体、颜色与尺寸都不变。仅替换姓名。

**产出文件**：
- `mina_businesscard.pdf`（原始模板）
- `Roboto-Medium.ttf`（完整字体）
- `Peblla_Business_Card_Albert_Tsai_v3.pdf` / `.png`（最终版，Mina 确认通过）

---

## 四、Blogger 角色 — SEO 知识库 ✅

从飞书 Wiki 下载并提炼了 7 份 SEO 文档，整合为 `blogger_seo_knowledge.md`：

| 文档 | 内容 |
|------|------|
| Content Writing Guide | 内容写作规范 |
| SEO Blog Prompts | SEO blog 写作提示词 |
| SEO 关键词 Brain Storming | 关键词研究方法 |
| Peblla Websites SEO practices | 网站 SEO 实践 |
| SEO 落地页指南 | Landing page 优化 |
| SEO 软文工作流程 SOP | 软文写作 SOP |
| SEO 网站内容汇总 | 现有内容盘点 |

---

## 五、竞品研究 ✅

### YouTube 竞品分析（Nana/Tutor 角色参考）
- **Toast POS**：YouTube 频道分析，模块化培训视频体系
- **SpotOn POS**：功能模块化选题策略
- **Square POS**：标准化硬件安装教程
- **Otter POS**：简洁 How-to 风格

### SaaS 视频营销趋势
- 病毒式 SaaS 视频模式：会议内容 + 产品驱动策略
- 高效 SaaS Demo 视频：问题优先方法可缩短销售周期
- 餐厅 YouTube 生态：业务运营内容 > 技术评测

### ClickUp 任务分析
- Marketing Kit 列表含 443 个任务
- 查询了 2026 年新创建的任务
- 确认了任务状态流：waiting for operation CN → printing → done

---

## 六、浏览器自动化 ✅

- Chrome DevTools MCP 确认可用（端口 9329）
- 实现了页面导航控制、截图、表单填写
- Gemini AI 图片生成需要 Google 账号登录（当前未解决）
- ChatGPT Blogs 项目界面检查完成

---

## 七、角色花名册 ⏳

计划创建群聊置顶消息，列出所有角色及其分工和技能。
- 发现飞书 Bot API 不支持消息置顶功能
- 方案：发送消息后由用户手动置顶
- **状态**：尚未发送

---

## 八、关键经验总结

### 技术经验
1. **PDF 字体编辑**：嵌入式子集字体只含已用字形，必须用完整字体文件
2. **飞书文件下载**：MCP `get_messages` 返回 `[file]` 摘要不含 file_key，需直接调 Open API
3. **Gemini 图片生成**：需要 Google 账号登录，无法通过未登录的 Chrome 使用
4. **HTML→PNG**：Chrome CDP 渲染 HTML 是可靠的设计 mockup 方案

### 流程经验
1. **名片制作**：已建立标准化流程（模板 PDF → pymupdf 编辑 → 输出），可快速批量生产
2. **SEO 知识库**：飞书 Wiki → JSON-RPC → Markdown 提取 → 本地知识库的完整链路
3. **技能安装**：`npx skills add` 批量安装后需逐一记录到 CLAUDE.md

---

## 九、待办事项汇总

| 优先级 | 任务 | 负责人 | 状态 |
|--------|------|--------|------|
| P1 | Silvestre Chicken 设计优化 | Amanda 提供样本 → Sigma 重新设计 | ⏳ 等待样本 |
| P1 | 群聊角色花名册置顶消息 | Sigma | ⏳ 未发送 |
| P2 | Gemini 账号登录配置 | 需人工操作 | ❌ Blocked |
| P2 | QR 码集成到 Silvestre 海报 | Sigma | ⏳ 等待设计定稿 |

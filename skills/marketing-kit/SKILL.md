---
name: marketing-kit
description: Peblla Marketing Kit 设计制作全流程技能（Momo 专属）。当用户要求制作 marketing kit、postcard、poster、宣传物料时使用。
triggers:
  - marketing kit
  - postcard
  - poster
  - 宣传物料
  - kit 设计
  - flyer
  - 传单
---

# Marketing Kit 设计制作技能（Momo 专属）

> 本技能由 Amanda Zhu 培训，基于 10 个真实 Peblla 客户案例总结提炼。

## 一、产品规格

| 物料 | 尺寸 | 像素（@300dpi） | 方向 |
|------|------|-----------------|------|
| **Postcard** | 4×6 in | 1200×1800 px | **竖版（永久）** |
| **Poster** | 24×36 in | 2400×3600 px（= Postcard 2x 放大） | **竖版（永久）** |

**⚠️ 不再制作横版 Business Card 正面促销卡**（永久·Amanda Zhu 要求·2026-03-27）

### 打印组合（二选一，客户在 CIF 表单选择）
- Combo 1: 1张 24×36 poster + 500张 4×6 postcard
- Combo 2: 1张 24×36 window vinyl + 100张 4×6 postcard

### 印刷要求
- 分辨率：300 DPI 最低
- 格式：JPEG quality=95 或 PDF
- 出血区：38px + 内容安全边距 50px
- VistaPrint 接受 PDF 和 PNG，不强制裁切线

---

## 二、设计模板（两种路线）

### Route A：标准模板（8/10 品牌使用，推荐）

**结构分三段：**

```
┌─────────────────────────┐
│   2×3 食物网格（40-50%）  │  ← 满铺，紧凑 2-4px 间距
├─────────────────────────┤
│ 促销文案（左） │ 手机（右）│  ← 品牌主色背景
├─────────────────────────┤
│ QR码 │ Logo │ GET APP按钮 │  ← 品牌副色 Banner
└─────────────────────────┘
     "Powered by peblla" ↗
```

#### 第一段：食物网格（顶部 40-50%）
- 2×3 网格，**满铺全宽**，无侧边距
- 间距 2-4px（极窄）
- 每张图用 `ImageOps.fit()` 裁切填满，不留黑边
- 食物图要有食欲感，暖色调优先

#### 第二段：促销文案 + 手机 Mockup（中间 35-40%）
- **左侧文案层级**（从上到下）：
  1. `FIRST ORDER` — 白色，中号
  2. `X% OFF!` — **金色/强调色，超大字号**（整张卡最大的文字）
  3. `EARN REWARDS EVERY TIME YOU ORDER` — 白色，小号
  4. `FREE DELIVERY ON YOUR FIRST APP ORDER!` — 强调色，小号
  5. `REFER FRIENDS & GET 10 BONUS POINTS!` — 白色，小号
  6. 品牌 Tagline（如有）
- **右侧手机 Mockup**：
  - 逼真智能手机外形：圆角矩形 + 深色边框 + 屏幕内容
  - 屏幕显示在线点餐界面：品牌色头部 "ORDER NOW" + 菜品列表（含缩略图+价格+按钮）
  - 比例约 67:145（标准手机比例）

#### 第三段：底部 Banner（底部 15-20%）
- 品牌副色/强调色背景
- 左：QR Code（≥360px，白色衬底，下方 "SCAN ME"）
- 中：餐厅 Logo
- 右：`GET APP` 胶囊按钮（圆角，强调色）
- 右下角：`Powered by peblla` 极小字

### Route B：摄影主图路线（2/10 品牌使用）
- 全幅高质量食物摄影作为背景
- 叠加半透明色块 + 文字
- 适合有专业摄影素材的品牌

---

## 三、色彩策略

### 提取品牌色
1. 访问餐厅官网/在线点餐页面
2. 提取 2-3 个品牌色：主色 + 副色 + 强调色
3. 主色用于大面积背景
4. 强调色用于价格数字和 CTA 按钮（制造视觉冲击）
5. 白色文字在深色背景上保证可读性

### 色彩分配
| 元素 | 用色 |
|------|------|
| 中间段背景 | 品牌主色（深色优先） |
| 底部 Banner | 品牌副色 |
| 折扣数字 | 强调色（金色/亮色） |
| CTA 按钮 | 强调色 |
| 正文/副文案 | 白色 |
| QR 衬底 | 纯白 |

---

## 四、字体层级

| 层级 | 用途 | 大小比例 | 字重 |
|------|------|---------|------|
| **XL** | 折扣数字（10% OFF!） | 最大 | Extra Bold |
| **L** | 段落标题（FIRST ORDER） | 大 | Bold |
| **M** | 促销副文案 | 中 | Semi-Bold |
| **S** | 细节说明 | 小 | Regular |
| **XS** | Powered by peblla | 极小 | Light |

---

## 五、信息密度原则（永久·Amanda Zhu 训练）

**画面不能只有一条促销信息！** 必须用有营销价值的文案填满画面。

### 必须包含的 CTA（至少 4 个）：
1. ✅ `First Order X% OFF` — 主促销
2. ✅ `Free Delivery` — 配送优惠
3. ✅ `Download our APP` / `GET APP` — 下载引导
4. ✅ `Order @ {website-URL}` — 网址引导
5. ✅ `Earn Rewards` — 积分奖励
6. ✅ `Refer Friends & Get Bonus Points` — 推荐奖励
7. ✅ QR Code 指向点餐页面 — 扫码入口

### 参考标杆
- `shared/marketing-kit-examples/HH tea - Baltimore, MD/` — 信息量充足的金标准

---

## 六、QR Code 规范

- **尺寸**：≥ 1.2 inch（360px @300dpi）
- **衬底**：白色 padding 包围，确保可扫描
- **标签**：下方写 "SCAN ME" 或 "SCAN TO ORDER"
- **Logo**：如提供带 Logo 的 QR，优先使用
- **来源**：Amanda 提供（不自行生成）

---

## 七、Powered by Peblla

- 位置：右下角
- 大小：极小，不抢眼
- Logo 素材：`shared/peblla-logo/01 Peblla Logo/`
- 参考 Amanda 确认的风格

---

## 八、素材来源规则

| 素材 | 来源 |
|------|------|
| 食物照片 | 餐厅在线点餐页面 `{品牌}.peblla.com` 或官网 |
| Logo | 餐厅官网 |
| QR Code | Amanda 提供 |
| Promotion 内容 | CIF 表单 |
| 品牌色 | 从餐厅官网/Logo 提取 |

**⚠️ 食物图片必须与该餐厅实际菜品相关**，不能用无关素材图

---

## 九、完整工作流

```
1. 接收任务（ClickUp / Amanda 通知）
   ↓
2. 收集信息
   - 店名、地址、电话
   - 官网 URL
   - Promotion 内容（X% OFF）
   - QR Code（Amanda 提供）
   ↓
3. 素材准备
   - 访问餐厅官网 → 提取 Logo、品牌色
   - 访问在线点餐页面 → 下载菜品图（6张）
   ↓
4. 设计制作
   - 使用 Python + Pillow 生成
   - 参考代码模板：gen_krispy_kit_v2.py
   - 输出：postcard_4x6.jpg + poster_24x36.jpg
   ↓
5. 发群审核
   - 发给 Amanda 确认
   ↓
6. 迭代修改
   - 根据反馈调整
   ↓
7. 交付最终文件
   - PDF/PNG 格式，用于 VistaPrint 打印
```

---

## 十、代码模板参考

基础生成脚本结构（`gen_krispy_kit_v2.py`）：

```python
from PIL import Image, ImageDraw, ImageFont, ImageOps, ImageEnhance, ImageFilter

# === 品牌参数（每个客户替换） ===
BRAND_NAME = "Restaurant Name"
BRAND_PRIMARY = '#001333'    # 主色（深色背景）
BRAND_SECONDARY = '#dd282c'  # 副色（底部 Banner）
BRAND_ACCENT = '#f5a623'     # 强调色（折扣数字、CTA）
PROMO_TEXT = "10% OFF!"
ADDRESS = "123 Main St, City, ST 12345"
WEBSITE = "restaurantname.com"

# === 画布尺寸 ===
POSTCARD_W, POSTCARD_H = 1200, 1800  # 4×6 @300dpi
POSTER_W, POSTER_H = 2400, 3600      # 24×36 @300dpi

# === 模块化结构 ===
# 1. 食物网格（顶部 42%）
# 2. 促销文案 + 手机 Mockup（中间 38%）
# 3. 底部 Banner（底部 20%）

# Poster = Postcard.resize((2400, 3600))
```

### 关键技术点
- `ImageOps.fit(img, size)` — 裁切填充，不留黑边
- `ImageEnhance.Color(img).enhance(1.2)` — 暖色调增强
- 手机 Mockup：圆角矩形 + 深色边框 + 内部绘制菜单 UI
- QR 白衬底：先画白色圆角矩形，再贴 QR 图片
- 胶囊按钮：`rounded_rectangle` + 居中文字

---

## 十一、品牌案例库

以下 10 个品牌的 example 文件保存在 `shared/marketing-kit-examples/`，可作为设计参考：

| 品牌 | 路线 | 特色 |
|------|------|------|
| HH Tea (Baltimore) | A 标准 | **金标准**，信息量充足 |
| City Light | A 标准 | 干净排版 |
| Wee Tea | A 标准 | 线下物料完整套装 |
| Sno Thai | A 标准 | 泰式色彩搭配 |
| Hulu Skewer House | A 标准 | 中式烧烤风格 |
| Lil M Bubble Tea | A 标准 | 奶茶品牌年轻风 |
| V Florist | B 摄影 | 花店摄影主图 |
| Filicori Zecchini | A 标准 | 意式咖啡高级感 |
| Cuppa Tea | A 标准 | INS 海报风格 |
| Krispy Krunchy Chicken | A 标准 | 美式炸鸡连锁 |

---

## 十二、检查清单（发稿前必检）

- [ ] 竖版方向（portrait）
- [ ] 食物图来自真实菜品（非无关素材）
- [ ] QR Code ≥ 360px，有白色衬底
- [ ] 信息量充足（≥4 个 CTA）
- [ ] 折扣数字是画面最大文字
- [ ] "Powered by peblla" 右下角极小
- [ ] 品牌色正确（与官网一致）
- [ ] 300 DPI，印刷清晰度达标
- [ ] 无拼写错误（店名、地址、网址）
- [ ] Poster 与 Postcard 设计一致（仅尺寸不同）

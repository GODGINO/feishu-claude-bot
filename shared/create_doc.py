#!/usr/bin/env python3
import json
import subprocess
import sys

MCP_URL = "https://mcp.feishu.cn/mcp/mcp_speyKlMS0Z2bBnkpTZXBqDGgSFLd6x27pkAp2exxrOPBMlcBjErx_lsXqAHBS6SToayieJ2Z6sU"

PART1 = r"""## 一、公司定位与核心价值

### 我们是谁

UBT 是一家技术 IT 软件公司，为北美小型巴士运营商提供 **白标 SaaS 票务系统**（Web / mWeb / App / Admin），帮助客户低成本建立自有品牌的线上售票能力。

### 两大核心交付价值

| 价值维度 | 具体内容 | 客户收益 |
|---------|---------|---------|
| **线上化运营** | 白标票务 SaaS（Web/mWeb/App/Admin），可低成本更换 logo 变成新租户 | 从 0 到 1 建立线上售票能力，告别电话/柜台售票 |
| **销售量提升** | 自然流量（GEO/SEO）+ 付费流量（Google Ads）代运营 | 把乘客带进来，填满座位，提升上座率 |

<callout emoji="💡" background-color="light-blue">一句话 Pitch：帮小型巴士运营商在网上卖票，并把客人带来填满座位。</callout>

---

## 二、目标客户画像

### 基本特征

| 维度 | 描述 |
|------|------|
| **行业** | 北美城际/区域巴士运营商 |
| **规模** | 5-30 辆车，1-10 条固定线路 |
| **团队** | 5-30 人，无技术/无市场团队 |
| **年营收** | $500K - $5M |
| **类型** | 家族企业、小型创业公司、Charter 转型公司 |
| **地理** | 美国（东北走廊、德州、加州、佛州）、加拿大、墨西哥 |

### 决策者画像

- **角色**：Owner / GM，一人管所有
- **技术能力**：能用 Facebook，不会建网站
- **价格敏感**：但愿意为看得到效果的方案付费

### 五大核心痛点

1. **没有线上售票系统** — 还在用电话/柜台/纸质票
2. **依赖第三方平台佣金高** — Wanderu、Busbud 等抽成 15-25%
3. **Google 搜不到** — 搜线路名找不到自己公司
4. **品牌感弱** — 没有专业网站，客户信任度低
5. **上座率低** — 旺季忙不过来，淡季空跑

### 四大购买动机触发点

<callout emoji="🎯" background-color="light-blue">
- "Google 上搜不到我"
- "平台佣金太高了"
- "竞争对手都有自己网站了"
- "旺季电话接不过来"
</callout>

---

## 三、客户分级体系

根据数字化成熟度，将目标客户分为四类，匹配不同的获客话术和服务方案：

### Type A：零线上

- **特征**：没有网站，只有电话/柜台售票
- **痛点**：完全依赖线下渠道，错失所有线上客源
- **话术**：「你的竞争对手已经在网上卖票了」
- **方案**：全套 SaaS + 官网建设 + SEO

### Type B：有网站无售票

- **特征**：有基础官网但无在线售票功能
- **痛点**：网站只是展示页，客户看到了但买不了票
- **话术**：「你有网站但没有在线购票，访客来了又走了」
- **方案**：SaaS 票务系统嵌入 + 转化优化

### Type C：平台依赖型

- **特征**：通过 Wanderu、Busbud 等第三方平台售票
- **痛点**：每张票被抽 15-25% 佣金，无自有客户数据
- **话术**：「你每年付给平台 $XX 万佣金，用我们的系统一年就能回本」
- **方案**：白标票务系统 + 直销渠道建设

### Type D：有系统需优化

- **特征**：有自有网站和售票系统，但流量不足
- **痛点**：系统功能 OK 但没人来买
- **话术**：「Google 搜 [线路名] 你排在第 X 页」
- **方案**：SEO/GEO 优化 + Google Ads 代运营

---

## 四、获客渠道与战术

### 4.1 线上获客渠道

#### （1）Bus Operator Grader 评估工具

<callout emoji="💡" background-color="light-blue">核心思路：打造免费的「巴士公司线上评分工具」，通过 100 分制评估吸引潜在客户，同时收集 leads。参考 Owner.com 模式。</callout>

**评分维度（100 分制）**：

| 维度 | 权重 | 评估项 |
|------|------|--------|
| **搜索可见度** | 40 分 | 域名质量、H1 标签、Meta 描述、Open Graph、关键词覆盖、服务区域定位 |
| **网站体验** | 40 分 | CTA 有效性、内容完整度、联系方式、社交链接、营业时间、在线购票能力 |
| **本地曝光** | 20 分 | Google Business Profile、地图标注、评论数量和评分、分类准确性 |

**转化路径**：
1. 运营商输入公司名或网址 → 生成免费评分报告
2. 报告展示得分、竞争对手排名对比、预估损失金额
3. CTA：「35 秒修复这些问题」→ 进入 demo 预约

#### （2）Google Ads 精准投放

- **关键词**：bus ticketing software、bus booking system、charter bus management software
- **定向**：按地理位置定向（高密度巴士运营区域）
- **落地页**：直达 Grader 工具或 Demo 预约页

#### （3）SEO 内容营销

- 博客文章：「小型巴士公司如何在线卖票」「减少平台佣金的 5 种方法」
- 案例研究：已签约客户的成功故事
- 行业报告：北美小型巴士运营商数字化白皮书

#### （4）LinkedIn 精准触达

- 搜索 Owner / GM / Operations Manager at Bus Company
- 发送个性化 InMail（引用其公司具体情况）
- 分享行业内容建立专业形象

### 4.2 线下获客渠道

#### （1）行业展会

- ABA Marketplace（美国巴士协会年度大会）
- UMA Motorcoach Expo
- 各州巴士协会年会

#### （2）行业协会合作

- 美国巴士协会（ABA）会员名录 → 精准客户列表
- 各州交通运营商协会
- 申请成为协会推荐供应商

#### （3）地推 + 电话

- 重点区域派业务员拜访（德州、东北走廊、加州）
- 电话跟进 Grader 工具注册但未转化的 leads"""

PART2 = r"""## 五、已调研的潜在客户

### Top 优先级（强匹配度）

| 公司 | 地区 | 特征 | 获客切入点 |
|------|------|------|-----------|
| **Valley Transit Company** | 德州 Harlingen | 运营德州南部 & 北墨西哥，50+ 每日班次，依赖 Busbud/CheckMyBus 等平台售票 | Type C — 佣金节省 ROI 计算。网站有但购票走第三方 |
| **Vamoose Bus** | NYC ↔ DC | 2004 年成立，运营纽约-华盛顿走廊，有自有网站+购票功能，但仍同时在 Wanderu/Busbud/CheckMyBus 分销 | Type C/D 混合 — 优化渠道组合，减少佣金依赖，提升直销占比 |
| **Pacific Crest Bus Lines** | 俄勒冈 Redmond | 运营太平洋西北线路（Bend-Eugene/Portland），有自有购票系统 | Type D — SEO/流量优化，427 条线路但直销渠道流量不足 |

### 中优先级（需进一步验证）

| 公司 | 地区 | 特征 | 获客切入点 |
|------|------|------|-----------|
| **Peoria Charter** | 伊利诺伊 Peoria | 1941 年家族企业，伊州最大私有 charter 公司，100+ 员工 | 大型 charter 转型线路运营 |
| **Barons Bus** | 俄亥俄 Cleveland/Columbus | 2012 年成立，覆盖 6 州 90+ 城市，有自有购票系统但仍用 4 个第三方平台 | Type C/D — 佣金优化空间大 |
| **Southeastern Stages** | 乔治亚 Atlanta | 1933 年三代家族企业，65 员工，年运 40 万乘客 | 传统家族企业数字化转型 |
| **Salt Lake Express** | 犹他 | 24/7 运营，135 个目的地跨 7 州，含机场接驳服务 | 大型区域运营商，多线路管理需求强 |

---

## 六、获客话术模板

### 冷邮件模板（Type C：平台依赖型）

> **Subject**: [公司名] — 每年在平台佣金上花了多少？
>
> Hi [Name],
>
> I noticed [公司名] sells tickets through Busbud and Wanderu. Those platforms charge 15-25% per ticket — for a company running 50 daily schedules, that's easily $50,000-100,000/year in commissions.
>
> We help bus operators like you build your own branded booking website. Your passengers book directly with you — zero commissions.
>
> One of our clients saved $72,000 in their first year after switching.
>
> Want to see a quick demo? Takes 15 minutes.

### 冷邮件模板（Type A：零线上）

> **Subject**: [公司名] 的乘客正在 Google 搜你 — 但找不到你
>
> Hi [Name],
>
> I searched "[线路名] bus tickets" on Google — [公司名] doesn't show up in the first 3 pages. Your competitors do.
>
> We build branded ticket booking websites for bus operators. Your passengers can find you on Google, book online, and pay — no more phone-only bookings.
>
> Takes 2 weeks to launch. Can I show you what it'd look like for [公司名]?

---

## 七、获客漏斗与关键指标

```mermaid
graph LR
    A["目标客户池<br/>1000+<br/>行业数据库"] --> B["触达<br/>200<br/>邮件/广告"]
    B --> C["兴趣<br/>50<br/>Grader"]
    C --> D["Demo<br/>15<br/>预约演示"]
    D --> E["签约<br/>3-5<br/>付费客户"]
```

### 关键指标（KPI）

| 阶段 | 指标 | 目标值 |
|------|------|--------|
| 触达 | 每月冷触达数 | 200 家 |
| 兴趣 | Grader 工具注册 / 邮件回复率 | 25%（50 家） |
| Demo | Demo 预约率 | 30%（15 家） |
| 签约 | Demo → 签约转化率 | 20-33%（3-5 家） |
| 留存 | 月度客户流失率 | < 3% |

---

## 八、执行时间表

| 阶段 | 时间 | 重点工作 |
|------|------|---------|
| **Phase 1**（第 1-2 周） | 基础准备 | 完善客户名单、准备话术模板、搭建 Grader 工具 MVP |
| **Phase 2**（第 3-4 周） | 首轮触达 | 冷邮件发送 Top 优先级 3 家 + 中优先级 4 家，LinkedIn 触达 |
| **Phase 3**（第 5-8 周） | 规模化 | 启动 Google Ads、SEO 内容发布、扩大客户池至 50+ 家 |
| **Phase 4**（第 9-12 周） | 优化迭代 | 分析转化数据、优化话术、准备案例研究、参加行业展会 |

---

## 九、竞争优势总结

<callout emoji="✅" background-color="light-green">UBT SaaS 的核心优势：固定月费零佣金、自有品牌、客户数据归运营商、可定制、SEO 流量归自己、自主可控无平台依赖风险。</callout>

| 对比维度 | 第三方平台（Wanderu/Busbud） | UBT SaaS |
|---------|--------------------------|----------|
| 佣金 | 15-25% 每张票 | 固定月费，零佣金 |
| 品牌 | 客户看到的是平台品牌 | 客户看到的是运营商自有品牌 |
| 客户数据 | 归平台所有 | 归运营商所有 |
| 定制能力 | 无 | 可定制 UI/功能 |
| SEO 价值 | 流量归平台 | 流量归运营商官网 |
| 依赖风险 | 平台调价/下架风险 | 自主可控 |"""


def call_mcp(payload):
    """Call MCP endpoint and return parsed JSON response."""
    payload_json = json.dumps(payload, ensure_ascii=False)
    result = subprocess.run(
        ["curl", "-s", "--max-time", "120",
         "-H", "Content-Type: application/json",
         "-d", "@-",
         MCP_URL],
        input=payload_json.encode("utf-8"),
        capture_output=True
    )
    stdout = result.stdout.decode("utf-8")
    stderr = result.stderr.decode("utf-8")
    if result.returncode != 0:
        print(f"curl failed: {stderr}", file=sys.stderr)
        sys.exit(1)
    # MCP may return multiple JSON-RPC lines (SSE-style or newline-delimited)
    # Try to find the one with our result
    lines = stdout.strip().split("\n")
    for line in reversed(lines):
        line = line.strip()
        if not line:
            continue
        # Handle SSE format
        if line.startswith("data:"):
            line = line[5:].strip()
        if not line:
            continue
        try:
            parsed = json.loads(line)
            if "result" in parsed or "error" in parsed:
                return parsed
        except json.JSONDecodeError:
            continue
    # If no structured response found, print raw and try to parse whole
    print(f"Raw response:\n{stdout}", file=sys.stderr)
    try:
        return json.loads(stdout)
    except:
        print("Could not parse response", file=sys.stderr)
        sys.exit(1)


# Step 1: Create doc with part 1
print("Creating document with part 1...")
create_payload = {
    "jsonrpc": "2.0",
    "id": 2,
    "method": "tools/call",
    "params": {
        "name": "create-doc",
        "arguments": {
            "title": "UBT 北美巴士票务 SaaS 获客方案",
            "markdown": PART1
        }
    }
}

resp1 = call_mcp(create_payload)
print(f"Create response: {json.dumps(resp1, ensure_ascii=False, indent=2)}")

# Extract doc_id and doc_url from response
if "error" in resp1:
    print(f"Error creating doc: {resp1['error']}", file=sys.stderr)
    sys.exit(1)

# The result content is typically in resp1["result"]["content"][0]["text"]
result_text = resp1.get("result", {}).get("content", [{}])[0].get("text", "")
print(f"Result text: {result_text}")

# Parse the result text to find doc_id
import re
result_data = json.loads(result_text) if result_text.startswith("{") else {}
doc_id = result_data.get("doc_id", "")
doc_url = result_data.get("doc_url", "")

if not doc_id:
    # Try regex
    match = re.search(r'"doc_id"\s*:\s*"([^"]+)"', result_text)
    if match:
        doc_id = match.group(1)
    match2 = re.search(r'"doc_url"\s*:\s*"([^"]+)"', result_text)
    if match2:
        doc_url = match2.group(1)

if not doc_id:
    print("Could not extract doc_id from response", file=sys.stderr)
    sys.exit(1)

print(f"\ndoc_id: {doc_id}")
print(f"doc_url: {doc_url}")

# Step 2: Append part 2
print("\nAppending part 2...")
update_payload = {
    "jsonrpc": "2.0",
    "id": 3,
    "method": "tools/call",
    "params": {
        "name": "update-doc",
        "arguments": {
            "doc_id": doc_id,
            "mode": "append",
            "markdown": PART2
        }
    }
}

resp2 = call_mcp(update_payload)
print(f"Update response: {json.dumps(resp2, ensure_ascii=False, indent=2)}")

print(f"\n===== DONE =====")
print(f"doc_url: {doc_url}")

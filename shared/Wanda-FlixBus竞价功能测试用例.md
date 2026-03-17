# Wanda FlixBus 竞价功能测试用例

**文档版本**: 1.0
**创建日期**: 2026-03-13
**功能模块**: FlixBus 竞价定价系统（价格取整模式 / 跟价模式 / 利润追踪）

---

## 功能背景说明

本次改动包含三个核心新增功能：

1. **price_rounding_mode**（价格取整模式）：none / floor / ceil / round，在折扣计算前对竞品价格进行取整处理
2. **pricing_mode**（跟价模式）：undercut（仅降价）/ follow（跟涨跟跌），follow 模式下每个渠道可配置 price_cap（价格上限）
3. **profit_amount**（利润记录）：ticketPrice - originPrice，存入 ticket_competition_info

**价格计算公式**：`finalPrice = max(roundedCompetitorPrice - discount, floorPrice)`
**跟价上限逻辑**：`cappedPrice = min(cap, roundedCompetitorPrice - discount)`，且 cap 不能低于 floorPrice
**三个渠道**（Web / App / Wanderu）各自独立配置：discount、floorPrice、priceCap
**竞品平台**：GoToBus 和 FlixBus，系统自动取两者中的更低价格

---

## 测试用例分类目录

| 分类编号 | 分类名称 |
|---------|---------|
| TC-01 | 价格取整模式（Price Rounding） |
| TC-02 | Undercut 模式（仅降价，向下兼容验证） |
| TC-03 | Follow 模式 - 价格上涨场景 |
| TC-04 | Follow 模式 - 价格下降场景 |
| TC-05 | Follow 模式 - 价格上限（Price Cap） |
| TC-06 | Follow 模式 - Price Cap vs Floor Price 冲突 |
| TC-07 | 取整 + 跟价模式组合 |
| TC-08 | profit_amount 计算验证 |
| TC-09 | Admin UI 交互逻辑 |
| TC-10 | Admin 页面展示逻辑（取整后价格展示） |
| TC-11 | SQL 迁移 - 历史数据回填正确性 |
| TC-12 | 向下兼容性验证 |
| TC-13 | 边界与异常场景 |

---

## TC-01 价格取整模式（Price Rounding）

### TC-01-01

| 字段 | 内容 |
|------|------|
| **编号** | TC-01-01 |
| **分类** | 价格取整模式 |
| **测试项** | price_rounding_mode = none，竞品价格为小数，不做取整 |
| **前置条件** | 路线配置 price_rounding_mode = none；竞品价格（FlixBus）= 29.75；discount = 2.00；floorPrice = 10.00 |
| **操作步骤** | 1. 触发定价计算任务<br>2. 查询最终售价 |
| **预期结果** | 取整后竞品价格 = 29.75（不变）；最终售价 = 29.75 - 2.00 = **27.75** |

---

### TC-01-02

| 字段 | 内容 |
|------|------|
| **编号** | TC-01-02 |
| **分类** | 价格取整模式 |
| **测试项** | price_rounding_mode = floor，竞品价格向下取整 |
| **前置条件** | price_rounding_mode = floor；竞品价格 = 29.75；discount = 2.00；floorPrice = 10.00 |
| **操作步骤** | 1. 触发定价计算<br>2. 查询最终售价 |
| **预期结果** | 取整后竞品价格 = 29（floor(29.75)）；最终售价 = 29 - 2 = **27.00** |

---

### TC-01-03

| 字段 | 内容 |
|------|------|
| **编号** | TC-01-03 |
| **分类** | 价格取整模式 |
| **测试项** | price_rounding_mode = ceil，竞品价格向上取整 |
| **前置条件** | price_rounding_mode = ceil；竞品价格 = 29.20；discount = 2.00；floorPrice = 10.00 |
| **操作步骤** | 1. 触发定价计算<br>2. 查询最终售价 |
| **预期结果** | 取整后竞品价格 = 30（ceil(29.20)）；最终售价 = 30 - 2 = **28.00** |

---

### TC-01-04

| 字段 | 内容 |
|------|------|
| **编号** | TC-01-04 |
| **分类** | 价格取整模式 |
| **测试项** | price_rounding_mode = round，竞品价格四舍五入（0.5 进位） |
| **前置条件** | price_rounding_mode = round；竞品价格 = 29.50；discount = 2.00；floorPrice = 10.00 |
| **操作步骤** | 1. 触发定价计算<br>2. 查询最终售价 |
| **预期结果** | 取整后竞品价格 = 30（round(29.50)）；最终售价 = 30 - 2 = **28.00** |

---

### TC-01-05

| 字段 | 内容 |
|------|------|
| **编号** | TC-01-05 |
| **分类** | 价格取整模式 |
| **测试项** | price_rounding_mode = round，竞品价格四舍五入（0.4 舍去） |
| **前置条件** | price_rounding_mode = round；竞品价格 = 29.40；discount = 2.00；floorPrice = 10.00 |
| **操作步骤** | 1. 触发定价计算<br>2. 查询最终售价 |
| **预期结果** | 取整后竞品价格 = 29（round(29.40)）；最终售价 = 29 - 2 = **27.00** |

---

### TC-01-06

| 字段 | 内容 |
|------|------|
| **编号** | TC-01-06 |
| **分类** | 价格取整模式 |
| **测试项** | 竞品价格本身为整数时，取整模式不影响结果 |
| **前置条件** | price_rounding_mode = floor；竞品价格 = 30.00；discount = 2.00；floorPrice = 10.00 |
| **操作步骤** | 1. 触发定价计算<br>2. 查询最终售价 |
| **预期结果** | 取整后竞品价格 = 30（整数不变）；最终售价 = 30 - 2 = **28.00** |

---

### TC-01-07

| 字段 | 内容 |
|------|------|
| **编号** | TC-01-07 |
| **分类** | 价格取整模式 |
| **测试项** | 取整后价格减折扣仍低于 floorPrice，应取 floorPrice |
| **前置条件** | price_rounding_mode = floor；竞品价格 = 12.80；discount = 5.00；floorPrice = 10.00 |
| **操作步骤** | 1. 触发定价计算<br>2. 查询最终售价 |
| **预期结果** | 取整后竞品价格 = 12；12 - 5 = 7 < 10（floorPrice）；最终售价 = **10.00**（floor price 保底） |

---

### TC-01-08

| 字段 | 内容 |
|------|------|
| **编号** | TC-01-08 |
| **分类** | 价格取整模式 |
| **测试项** | 取整操作是动态计算，不存储到竞品价格字段 |
| **前置条件** | price_rounding_mode = ceil；竞品价格 = 29.30 |
| **操作步骤** | 1. 触发定价计算<br>2. 查询数据库中 ticket_competition_info 的竞品价格字段 |
| **预期结果** | 数据库存储的竞品原价仍为 **29.30**（未取整），取整仅在计算时动态应用 |

---

## TC-02 Undercut 模式（仅降价，向下兼容验证）

### TC-02-01

| 字段 | 内容 |
|------|------|
| **编号** | TC-02-01 |
| **分类** | Undercut 模式 |
| **测试项** | undercut 模式基本功能：竞品价格低于我方价格，触发降价 |
| **前置条件** | pricing_mode = undercut；竞品价格 = 25.00；当前售价 = 30.00；discount = 2.00；floorPrice = 10.00 |
| **操作步骤** | 1. 触发定价计算<br>2. 查询新售价 |
| **预期结果** | 新售价 = 25.00 - 2.00 = **23.00** |

---

### TC-02-02

| 字段 | 内容 |
|------|------|
| **编号** | TC-02-02 |
| **分类** | Undercut 模式 |
| **测试项** | undercut 模式：竞品价格高于我方价格，不调价 |
| **前置条件** | pricing_mode = undercut；竞品价格 = 35.00；当前售价 = 25.00；discount = 2.00；floorPrice = 10.00 |
| **操作步骤** | 1. 触发定价计算<br>2. 查询新售价 |
| **预期结果** | 价格**不变**，保持当前售价 25.00（undercut 模式不跟涨） |

---

### TC-02-03

| 字段 | 内容 |
|------|------|
| **编号** | TC-02-03 |
| **分类** | Undercut 模式 |
| **测试项** | undercut 模式：竞品降价后结果低于 floorPrice，取 floorPrice |
| **前置条件** | pricing_mode = undercut；竞品价格 = 11.00；discount = 3.00；floorPrice = 10.00 |
| **操作步骤** | 1. 触发定价计算<br>2. 查询新售价 |
| **预期结果** | 计算值 = 11 - 3 = 8 < 10；最终售价 = **10.00**（floor 保底） |

---

### TC-02-04

| 字段 | 内容 |
|------|------|
| **编号** | TC-02-04 |
| **分类** | Undercut 模式 |
| **测试项** | undercut 模式：priceCap 字段配置无效（priceCap 仅 follow 模式生效） |
| **前置条件** | pricing_mode = undercut；竞品价格 = 25.00；discount = 2.00；floorPrice = 10.00；Web priceCap = 20.00 |
| **操作步骤** | 1. 触发定价计算<br>2. 查询新售价 |
| **预期结果** | priceCap 不生效；新售价 = 25 - 2 = **23.00**（不受 cap=20 限制） |

---

### TC-02-05

| 字段 | 内容 |
|------|------|
| **编号** | TC-02-05 |
| **分类** | Undercut 模式 |
| **测试项** | 三个渠道各自使用独立的 discount 和 floorPrice |
| **前置条件** | pricing_mode = undercut；竞品价格 = 25.00<br>Web: discount=2, floor=10<br>App: discount=1, floor=12<br>Wanderu: discount=3, floor=15 |
| **操作步骤** | 1. 触发定价计算<br>2. 分别查询三个渠道售价 |
| **预期结果** | Web = 23.00；App = 24.00；Wanderu = 22.00（均高于各自 floor，直接计算） |

---

## TC-03 Follow 模式 - 价格上涨场景

### TC-03-01

| 字段 | 内容 |
|------|------|
| **编号** | TC-03-01 |
| **分类** | Follow 模式 - 价格上涨 |
| **测试项** | follow 模式：竞品价格高于当前售价，我方跟涨 |
| **前置条件** | pricing_mode = follow；竞品价格 = 40.00；当前售价 = 25.00；discount = 2.00；floorPrice = 10.00；priceCap = null |
| **操作步骤** | 1. 触发定价计算<br>2. 查询新售价 |
| **预期结果** | 新售价 = 40 - 2 = **38.00**（follow 模式跟涨） |

---

### TC-03-02

| 字段 | 内容 |
|------|------|
| **编号** | TC-03-02 |
| **分类** | Follow 模式 - 价格上涨 |
| **测试项** | follow 模式跟涨时，profit_amount 应为正数 |
| **前置条件** | pricing_mode = follow；竞品价格 = 40.00；originPrice（成本）= 20.00；discount = 2.00；floorPrice = 10.00 |
| **操作步骤** | 1. 触发定价计算<br>2. 查询 ticket_competition_info.profit_amount |
| **预期结果** | ticketPrice = 38.00；profit_amount = 38 - 20 = **+18.00**（正数，代表盈利） |

---

### TC-03-03

| 字段 | 内容 |
|------|------|
| **编号** | TC-03-03 |
| **分类** | Follow 模式 - 价格上涨 |
| **测试项** | follow 模式跟涨，验证三个渠道均独立跟涨 |
| **前置条件** | pricing_mode = follow；竞品价格 = 40.00<br>Web: discount=2, floor=10, cap=null<br>App: discount=1, floor=12, cap=null<br>Wanderu: discount=3, floor=15, cap=null |
| **操作步骤** | 1. 触发定价计算<br>2. 分别查询三渠道售价 |
| **预期结果** | Web = 38.00；App = 39.00；Wanderu = 37.00 |

---

## TC-04 Follow 模式 - 价格下降场景

### TC-04-01

| 字段 | 内容 |
|------|------|
| **编号** | TC-04-01 |
| **分类** | Follow 模式 - 价格下降 |
| **测试项** | follow 模式：竞品价格低于当前售价，我方跟跌 |
| **前置条件** | pricing_mode = follow；竞品价格 = 20.00；当前售价 = 30.00；discount = 2.00；floorPrice = 10.00；priceCap = null |
| **操作步骤** | 1. 触发定价计算<br>2. 查询新售价 |
| **预期结果** | 新售价 = 20 - 2 = **18.00** |

---

### TC-04-02

| 字段 | 内容 |
|------|------|
| **编号** | TC-04-02 |
| **分类** | Follow 模式 - 价格下降 |
| **测试项** | follow 模式跟跌，结果低于 floorPrice，取 floorPrice |
| **前置条件** | pricing_mode = follow；竞品价格 = 11.00；discount = 3.00；floorPrice = 10.00 |
| **操作步骤** | 1. 触发定价计算<br>2. 查询新售价 |
| **预期结果** | 计算值 = 8 < 10；最终售价 = **10.00** |

---

### TC-04-03

| 字段 | 内容 |
|------|------|
| **编号** | TC-04-03 |
| **分类** | Follow 模式 - 价格下降 |
| **测试项** | follow 模式跟跌，profit_amount 可能为负数 |
| **前置条件** | pricing_mode = follow；竞品价格 = 20.00；originPrice = 22.00；discount = 2.00；floorPrice = 10.00 |
| **操作步骤** | 1. 触发定价计算<br>2. 查询 profit_amount |
| **预期结果** | ticketPrice = 18.00；profit_amount = 18 - 22 = **-4.00**（负数，低于成本） |

---

## TC-05 Follow 模式 - 价格上限（Price Cap）

### TC-05-01

| 字段 | 内容 |
|------|------|
| **编号** | TC-05-01 |
| **分类** | Follow 模式 - Price Cap |
| **测试项** | follow 模式：竞品价格上涨超过 priceCap，最终价格不超过 cap |
| **前置条件** | pricing_mode = follow；竞品价格 = 50.00；discount = 2.00；floorPrice = 10.00；Web priceCap = 35.00 |
| **操作步骤** | 1. 触发定价计算<br>2. 查询 Web 渠道售价 |
| **预期结果** | 计算值 = 50 - 2 = 48 > cap=35；Web 售价 = **35.00**（受 cap 限制） |

---

### TC-05-02

| 字段 | 内容 |
|------|------|
| **编号** | TC-05-02 |
| **分类** | Follow 模式 - Price Cap |
| **测试项** | follow 模式：价格未超过 priceCap，cap 不生效 |
| **前置条件** | pricing_mode = follow；竞品价格 = 30.00；discount = 2.00；floorPrice = 10.00；Web priceCap = 35.00 |
| **操作步骤** | 1. 触发定价计算<br>2. 查询 Web 渠道售价 |
| **预期结果** | 计算值 = 30 - 2 = 28 < cap=35；Web 售价 = **28.00**（cap 未触发） |

---

### TC-05-03

| 字段 | 内容 |
|------|------|
| **编号** | TC-05-03 |
| **分类** | Follow 模式 - Price Cap |
| **测试项** | 三个渠道配置不同的 priceCap，各自独立生效 |
| **前置条件** | pricing_mode = follow；竞品价格 = 50.00；discount = 2.00；floorPrice = 10.00<br>Web priceCap = 35.00<br>App priceCap = 40.00<br>Wanderu priceCap = null |
| **操作步骤** | 1. 触发定价计算<br>2. 分别查询三个渠道售价 |
| **预期结果** | Web = **35.00**（受 cap 限制）；App = **40.00**（受 cap 限制）；Wanderu = **48.00**（无 cap，正常计算） |

---

### TC-05-04

| 字段 | 内容 |
|------|------|
| **编号** | TC-05-04 |
| **分类** | Follow 模式 - Price Cap |
| **测试项** | priceCap 仅在 follow 模式下生效，undercut 模式忽略 cap |
| **前置条件** | pricing_mode = undercut；竞品价格 = 50.00；discount = 2.00；floorPrice = 10.00；Web priceCap = 35.00 |
| **操作步骤** | 1. 触发定价计算<br>2. 查询 Web 渠道售价 |
| **预期结果** | undercut 模式竞品价高于当前价不调价，**价格不变**（priceCap 无效） |

---

## TC-06 Follow 模式 - Price Cap vs Floor Price 冲突

### TC-06-01

| 字段 | 内容 |
|------|------|
| **编号** | TC-06-01 |
| **分类** | Price Cap vs Floor Price 冲突 |
| **测试项** | priceCap 低于 floorPrice，以 floorPrice 为准 |
| **前置条件** | pricing_mode = follow；竞品价格 = 50.00；discount = 2.00；floorPrice = 15.00；Web priceCap = 12.00（cap < floor） |
| **操作步骤** | 1. 触发定价计算<br>2. 查询 Web 渠道售价 |
| **预期结果** | cap=12 < floor=15；最终售价 = **15.00**（floor 价优先，cap 不能违反 floor） |

---

### TC-06-02

| 字段 | 内容 |
|------|------|
| **编号** | TC-06-02 |
| **分类** | Price Cap vs Floor Price 冲突 |
| **测试项** | priceCap 等于 floorPrice，正常生效 |
| **前置条件** | pricing_mode = follow；竞品价格 = 50.00；discount = 2.00；floorPrice = 15.00；Web priceCap = 15.00（cap = floor） |
| **操作步骤** | 1. 触发定价计算<br>2. 查询 Web 渠道售价 |
| **预期结果** | 最终售价 = **15.00**（cap = floor，取 cap 值即可） |

---

### TC-06-03

| 字段 | 内容 |
|------|------|
| **编号** | TC-06-03 |
| **分类** | Price Cap vs Floor Price 冲突 |
| **测试项** | Admin 配置时，priceCap < floorPrice，系统应拒绝保存或给出警告 |
| **前置条件** | 进入路线竞价配置页；pricing_mode = follow；floorPrice = 15.00 |
| **操作步骤** | 1. 在 Web priceCap 字段输入 12.00<br>2. 点击保存 |
| **预期结果** | 系统提示错误："priceCap 不能低于 floorPrice"，**拒绝保存**（或前端实时校验提示） |

---

## TC-07 取整 + 跟价模式组合

### TC-07-01

| 字段 | 内容 |
|------|------|
| **编号** | TC-07-01 |
| **分类** | 取整 + 跟价组合 |
| **测试项** | floor 取整 + follow 跟涨：取整在折扣计算前应用 |
| **前置条件** | price_rounding_mode = floor；pricing_mode = follow；竞品价格 = 40.75；discount = 2.00；floorPrice = 10.00；priceCap = null |
| **操作步骤** | 1. 触发定价计算<br>2. 查询新售价 |
| **预期结果** | 取整后 = 40；40 - 2 = **38.00**（先取整后减折扣） |

---

### TC-07-02

| 字段 | 内容 |
|------|------|
| **编号** | TC-07-02 |
| **分类** | 取整 + 跟价组合 |
| **测试项** | ceil 取整 + follow + priceCap：取整后的价格适用 cap 限制 |
| **前置条件** | price_rounding_mode = ceil；pricing_mode = follow；竞品价格 = 39.10；discount = 2.00；floorPrice = 10.00；priceCap = 38.00 |
| **操作步骤** | 1. 触发定价计算<br>2. 查询售价 |
| **预期结果** | 取整后 = 40；40 - 2 = 38；38 = cap；最终售价 = **38.00** |

---

### TC-07-03

| 字段 | 内容 |
|------|------|
| **编号** | TC-07-03 |
| **分类** | 取整 + 跟价组合 |
| **测试项** | round 取整 + follow + priceCap：取整后超过 cap，取 cap 值 |
| **前置条件** | price_rounding_mode = round；pricing_mode = follow；竞品价格 = 39.60；discount = 2.00；floorPrice = 10.00；priceCap = 36.00 |
| **操作步骤** | 1. 触发定价计算<br>2. 查询售价 |
| **预期结果** | 取整后 = 40；40 - 2 = 38 > cap=36；最终售价 = **36.00** |

---

### TC-07-04

| 字段 | 内容 |
|------|------|
| **编号** | TC-07-04 |
| **分类** | 取整 + 跟价组合 |
| **测试项** | 取整后价格 + follow 跌价 + floorPrice 保底 |
| **前置条件** | price_rounding_mode = floor；pricing_mode = follow；竞品价格 = 13.90；discount = 5.00；floorPrice = 10.00 |
| **操作步骤** | 1. 触发定价计算<br>2. 查询售价 |
| **预期结果** | 取整后 = 13；13 - 5 = 8 < 10；最终售价 = **10.00**（floor 保底） |

---

## TC-08 profit_amount 计算验证

### TC-08-01

| 字段 | 内容 |
|------|------|
| **编号** | TC-08-01 |
| **分类** | profit_amount 计算 |
| **测试项** | undercut 跟跌，profit_amount = ticketPrice - originPrice（正值） |
| **前置条件** | pricing_mode = undercut；竞品价格 = 25.00；discount = 2.00；floorPrice = 10.00；originPrice = 15.00 |
| **操作步骤** | 1. 触发定价计算<br>2. 查询 ticket_competition_info.profit_amount |
| **预期结果** | ticketPrice = 23.00；profit_amount = 23 - 15 = **+8.00** |

---

### TC-08-02

| 字段 | 内容 |
|------|------|
| **编号** | TC-08-02 |
| **分类** | profit_amount 计算 |
| **测试项** | follow 跟涨，profit_amount 为正值且较大 |
| **前置条件** | pricing_mode = follow；竞品价格 = 50.00；discount = 2.00；floorPrice = 10.00；originPrice = 20.00；priceCap = null |
| **操作步骤** | 1. 触发定价计算<br>2. 查询 profit_amount |
| **预期结果** | ticketPrice = 48.00；profit_amount = 48 - 20 = **+28.00** |

---

### TC-08-03

| 字段 | 内容 |
|------|------|
| **编号** | TC-08-03 |
| **分类** | profit_amount 计算 |
| **测试项** | follow 跟跌至亏损，profit_amount 为负值 |
| **前置条件** | pricing_mode = follow；竞品价格 = 15.00；discount = 2.00；floorPrice = 10.00；originPrice = 20.00 |
| **操作步骤** | 1. 触发定价计算<br>2. 查询 profit_amount |
| **预期结果** | ticketPrice = 13.00；profit_amount = 13 - 20 = **-7.00**（亏损） |

---

### TC-08-04

| 字段 | 内容 |
|------|------|
| **编号** | TC-08-04 |
| **分类** | profit_amount 计算 |
| **测试项** | 触发 floorPrice 保底时，profit_amount 基于 floorPrice 计算 |
| **前置条件** | pricing_mode = follow；竞品价格 = 11.00；discount = 5.00；floorPrice = 10.00；originPrice = 8.00 |
| **操作步骤** | 1. 触发定价计算<br>2. 查询 profit_amount |
| **预期结果** | ticketPrice = 10.00（floor 保底）；profit_amount = 10 - 8 = **+2.00** |

---

### TC-08-05

| 字段 | 内容 |
|------|------|
| **编号** | TC-08-05 |
| **分类** | profit_amount 计算 |
| **测试项** | profit_amount 字段存储在 ticket_competition_info 表中，每次计算后更新 |
| **前置条件** | 已有历史 ticket_competition_info 记录（旧 profit_amount = 5.00）；本次计算 ticketPrice = 18.00；originPrice = 15.00 |
| **操作步骤** | 1. 触发定价计算<br>2. 查询 ticket_competition_info.profit_amount |
| **预期结果** | profit_amount 更新为 18 - 15 = **+3.00**（覆盖旧值） |

---

## TC-09 Admin UI 交互逻辑

### TC-09-01

| 字段 | 内容 |
|------|------|
| **编号** | TC-09-01 |
| **分类** | Admin UI 交互 |
| **测试项** | pricing_mode = undercut 时，priceCap 输入框隐藏 |
| **前置条件** | 进入路线竞价配置 Admin 页面；当前 pricing_mode = undercut |
| **操作步骤** | 1. 查看表单各字段显示状态 |
| **预期结果** | Web / App / Wanderu 的 priceCap 输入框**不显示**（或置灰不可编辑） |

---

### TC-09-02

| 字段 | 内容 |
|------|------|
| **编号** | TC-09-02 |
| **分类** | Admin UI 交互 |
| **测试项** | pricing_mode = follow 时，priceCap 输入框显示 |
| **前置条件** | 进入路线竞价配置 Admin 页面；当前 pricing_mode = undercut |
| **操作步骤** | 1. 将 pricing_mode 切换为 follow<br>2. 查看表单变化 |
| **预期结果** | Web / App / Wanderu 的 priceCap 输入框**出现**（可编辑，允许为空） |

---

### TC-09-03

| 字段 | 内容 |
|------|------|
| **编号** | TC-09-03 |
| **分类** | Admin UI 交互 |
| **测试项** | 从 follow 切换回 undercut，priceCap 输入框重新隐藏 |
| **前置条件** | pricing_mode = follow，已显示 priceCap 字段 |
| **操作步骤** | 1. 将 pricing_mode 切换为 undercut<br>2. 查看表单变化 |
| **预期结果** | priceCap 输入框**重新隐藏**；已填写的 cap 值在 UI 中不可见 |

---

### TC-09-04

| 字段 | 内容 |
|------|------|
| **编号** | TC-09-04 |
| **分类** | Admin UI 交互 |
| **测试项** | price_rounding_mode 下拉框包含全部 4 个选项 |
| **前置条件** | 进入路线竞价配置 Admin 页面 |
| **操作步骤** | 1. 点击 price_rounding_mode 下拉框 |
| **预期结果** | 选项包含：none / floor / ceil / round，共 4 个 |

---

### TC-09-05

| 字段 | 内容 |
|------|------|
| **编号** | TC-09-05 |
| **分类** | Admin UI 交互 |
| **测试项** | pricing_mode 下拉框包含 undercut 和 follow 两个选项 |
| **前置条件** | 进入路线竞价配置 Admin 页面 |
| **操作步骤** | 1. 点击 pricing_mode 下拉框 |
| **预期结果** | 选项包含：undercut / follow，共 2 个 |

---

### TC-09-06

| 字段 | 内容 |
|------|------|
| **编号** | TC-09-06 |
| **分类** | Admin UI 交互 |
| **测试项** | follow 模式下 priceCap 可以为空（nullable） |
| **前置条件** | pricing_mode = follow，priceCap 输入框显示 |
| **操作步骤** | 1. 将 priceCap 留空<br>2. 点击保存 |
| **预期结果** | 保存成功，不报错；priceCap 存为 null |

---

## TC-10 Admin 页面展示逻辑（取整后价格展示）

### TC-10-01

| 字段 | 内容 |
|------|------|
| **编号** | TC-10-01 |
| **分类** | Admin 价格展示 |
| **测试项** | Admin 页面展示 FlixBus 价格时，应显示取整后的价格 |
| **前置条件** | price_rounding_mode = floor；FlixBus 原始价格 = 29.75 |
| **操作步骤** | 1. 进入路线竞价监控/详情页<br>2. 查看 FlixBus 价格展示 |
| **预期结果** | 显示 **29.00**（floor 取整后），而非 29.75 |

---

### TC-10-02

| 字段 | 内容 |
|------|------|
| **编号** | TC-10-02 |
| **分类** | Admin 价格展示 |
| **测试项** | price_rounding_mode = none 时，Admin 展示原始价格 |
| **前置条件** | price_rounding_mode = none；FlixBus 原始价格 = 29.75 |
| **操作步骤** | 1. 查看 Admin 页面 FlixBus 价格展示 |
| **预期结果** | 显示 **29.75**（不取整） |

---

### TC-10-03

| 字段 | 内容 |
|------|------|
| **编号** | TC-10-03 |
| **分类** | Admin 价格展示 |
| **测试项** | Admin 展示 GoToBus 价格也应用同样取整逻辑 |
| **前置条件** | price_rounding_mode = ceil；GoToBus 原始价格 = 28.10 |
| **操作步骤** | 1. 查看 Admin 页面 GoToBus 价格展示 |
| **预期结果** | 显示 **29.00**（ceil 取整后） |

---

## TC-11 SQL 迁移 - 历史数据回填正确性

### TC-11-01

| 字段 | 内容 |
|------|------|
| **编号** | TC-11-01 |
| **分类** | SQL 迁移 |
| **测试项** | 历史路线数据迁移后，pricing_mode 默认为 undercut |
| **前置条件** | 执行 migration SQL 前，数据库中存在旧版竞价路线配置（无 pricing_mode 字段） |
| **操作步骤** | 1. 执行数据库迁移脚本<br>2. 查询所有路线的 pricing_mode 值 |
| **预期结果** | 所有历史路线的 pricing_mode = **undercut**（向下兼容默认值） |

---

### TC-11-02

| 字段 | 内容 |
|------|------|
| **编号** | TC-11-02 |
| **分类** | SQL 迁移 |
| **测试项** | 历史数据迁移后，price_rounding_mode 默认为 none |
| **前置条件** | 执行 migration SQL 前，旧版数据无 price_rounding_mode 字段 |
| **操作步骤** | 1. 执行迁移脚本<br>2. 查询所有路线的 price_rounding_mode |
| **预期结果** | 所有历史路线的 price_rounding_mode = **none** |

---

### TC-11-03

| 字段 | 内容 |
|------|------|
| **编号** | TC-11-03 |
| **分类** | SQL 迁移 |
| **测试项** | 历史数据迁移后，priceCap 默认为 null |
| **前置条件** | 执行迁移前，旧版数据无 priceCap 字段 |
| **操作步骤** | 1. 执行迁移脚本<br>2. 查询所有渠道的 priceCap 值 |
| **预期结果** | Web/App/Wanderu 的 priceCap 均为 **null** |

---

### TC-11-04

| 字段 | 内容 |
|------|------|
| **编号** | TC-11-04 |
| **分类** | SQL 迁移 |
| **测试项** | 历史 ticket_competition_info 数据回填 profit_amount |
| **前置条件** | 历史记录中有 ticketPrice 和 originPrice；执行迁移脚本前 profit_amount 为空 |
| **操作步骤** | 1. 执行迁移脚本<br>2. 查询历史记录的 profit_amount |
| **预期结果** | profit_amount = ticketPrice - originPrice（按历史实际值计算回填）；无 originPrice 记录的行保持 null |

---

### TC-11-05

| 字段 | 内容 |
|------|------|
| **编号** | TC-11-05 |
| **分类** | SQL 迁移 |
| **测试项** | 迁移脚本幂等性：重复执行不产生脏数据 |
| **前置条件** | 第一次迁移已完成 |
| **操作步骤** | 1. 再次执行迁移脚本<br>2. 查询数据库状态 |
| **预期结果** | 数据**无变化**，不产生重复记录或覆盖已有正确值 |

---

## TC-12 向下兼容性验证

### TC-12-01

| 字段 | 内容 |
|------|------|
| **编号** | TC-12-01 |
| **分类** | 向下兼容 |
| **测试项** | 迁移后存量 undercut 规则计算结果与迁移前一致 |
| **前置条件** | 路线 A 迁移前：竞品价格 = 25；discount = 2；floorPrice = 10；计算结果 = 23<br>迁移后：pricing_mode = undercut，price_rounding_mode = none |
| **操作步骤** | 1. 迁移后触发定价计算<br>2. 查询路线 A 售价 |
| **预期结果** | 售价仍为 **23.00**，与迁移前完全一致 |

---

### TC-12-02

| 字段 | 内容 |
|------|------|
| **编号** | TC-12-02 |
| **分类** | 向下兼容 |
| **测试项** | 迁移后存量 undercut 规则中 floorPrice 保底逻辑不变 |
| **前置条件** | 路线 B：竞品价格 = 11；discount = 5；floorPrice = 10；迁移后 pricing_mode = undercut；price_rounding_mode = none |
| **操作步骤** | 1. 触发定价计算<br>2. 查询售价 |
| **预期结果** | 售价 = **10.00**（floorPrice 保底逻辑不变） |

---

### TC-12-03

| 字段 | 内容 |
|------|------|
| **编号** | TC-12-03 |
| **分类** | 向下兼容 |
| **测试项** | 迁移后存量规则：GoToBus 和 FlixBus 取低价逻辑不变 |
| **前置条件** | GoToBus 价格 = 22；FlixBus 价格 = 28；discount = 2；floorPrice = 10；pricing_mode = undercut |
| **操作步骤** | 1. 触发定价计算<br>2. 查询售价 |
| **预期结果** | 取 GoToBus 更低价；售价 = 22 - 2 = **20.00** |

---

### TC-12-04

| 字段 | 内容 |
|------|------|
| **编号** | TC-12-04 |
| **分类** | 向下兼容 |
| **测试项** | 新增 price_rounding_mode / pricing_mode 字段不影响未配置这些字段的旧 API 调用 |
| **前置条件** | 旧版 API 请求体中不含 price_rounding_mode 和 pricing_mode 字段 |
| **操作步骤** | 1. 发送不含新字段的旧格式请求到竞价配置 API<br>2. 查看响应 |
| **预期结果** | 请求成功；新字段使用默认值（rounding_mode=none, pricing_mode=undercut）；**不报错** |

---

## TC-13 边界与异常场景

### TC-13-01

| 字段 | 内容 |
|------|------|
| **编号** | TC-13-01 |
| **分类** | 边界场景 |
| **测试项** | follow 模式下 priceCap = null，价格上涨无限制 |
| **前置条件** | pricing_mode = follow；竞品价格 = 100.00；discount = 2.00；floorPrice = 10.00；priceCap = null |
| **操作步骤** | 1. 触发定价计算<br>2. 查询售价 |
| **预期结果** | 售价 = 100 - 2 = **98.00**（无上限限制） |

---

### TC-13-02

| 字段 | 内容 |
|------|------|
| **编号** | TC-13-02 |
| **分类** | 边界场景 |
| **测试项** | 竞品价格等于我方当前售价，follow 模式下价格保持不变 |
| **前置条件** | pricing_mode = follow；竞品价格 = 25.00；当前售价 = 25.00；discount = 0.00；floorPrice = 10.00 |
| **操作步骤** | 1. 触发定价计算<br>2. 查询新售价 |
| **预期结果** | 新售价 = 25 - 0 = **25.00**（与当前相同） |

---

### TC-13-03

| 字段 | 内容 |
|------|------|
| **编号** | TC-13-03 |
| **分类** | 边界场景 |
| **测试项** | GoToBus 和 FlixBus 均无报价，竞价不触发 |
| **前置条件** | pricing_mode = follow；GoToBus 价格 = null；FlixBus 价格 = null |
| **操作步骤** | 1. 触发定价计算<br>2. 查询定价状态 |
| **预期结果** | 不进行定价调整；价格**保持不变**；记录竞品无价格的状态 |

---

### TC-13-04

| 字段 | 内容 |
|------|------|
| **编号** | TC-13-04 |
| **分类** | 边界场景 |
| **测试项** | 仅 FlixBus 有价格，GoToBus 无报价，使用 FlixBus 价格 |
| **前置条件** | pricing_mode = follow；GoToBus 价格 = null；FlixBus 价格 = 30.00；discount = 2.00；floorPrice = 10.00 |
| **操作步骤** | 1. 触发定价计算<br>2. 查询售价 |
| **预期结果** | 使用 FlixBus 价格；售价 = 30 - 2 = **28.00** |

---

### TC-13-05

| 字段 | 内容 |
|------|------|
| **编号** | TC-13-05 |
| **分类** | 边界场景 |
| **测试项** | 仅 GoToBus 有价格，FlixBus 无报价，使用 GoToBus 价格 |
| **前置条件** | pricing_mode = follow；GoToBus 价格 = 28.00；FlixBus 价格 = null；discount = 2.00；floorPrice = 10.00 |
| **操作步骤** | 1. 触发定价计算<br>2. 查询售价 |
| **预期结果** | 使用 GoToBus 价格；售价 = 28 - 2 = **26.00** |

---

### TC-13-06

| 字段 | 内容 |
|------|------|
| **编号** | TC-13-06 |
| **分类** | 边界场景 |
| **测试项** | GoToBus 和 FlixBus 价格相同，取其中一个（结果相同） |
| **前置条件** | GoToBus 价格 = 25.00；FlixBus 价格 = 25.00；discount = 2.00；floorPrice = 10.00 |
| **操作步骤** | 1. 触发定价计算<br>2. 查询售价 |
| **预期结果** | 售价 = 25 - 2 = **23.00**（两者取低价结果一致） |

---

### TC-13-07

| 字段 | 内容 |
|------|------|
| **编号** | TC-13-07 |
| **分类** | 边界场景 |
| **测试项** | discount = 0 时，最终价格等于取整后竞品价格 |
| **前置条件** | price_rounding_mode = round；pricing_mode = follow；竞品价格 = 25.60；discount = 0；floorPrice = 10.00 |
| **操作步骤** | 1. 触发定价计算<br>2. 查询售价 |
| **预期结果** | 取整后 = 26；26 - 0 = **26.00** |

---

### TC-13-08

| 字段 | 内容 |
|------|------|
| **编号** | TC-13-08 |
| **分类** | 边界场景 |
| **测试项** | 竞品价格极低（低于 floorPrice），直接取 floorPrice |
| **前置条件** | pricing_mode = follow；竞品价格 = 5.00；discount = 0；floorPrice = 10.00 |
| **操作步骤** | 1. 触发定价计算<br>2. 查询售价 |
| **预期结果** | 5 - 0 = 5 < 10；最终售价 = **10.00**（floor 保底） |

---

### TC-13-09

| 字段 | 内容 |
|------|------|
| **编号** | TC-13-09 |
| **分类** | 边界场景 |
| **测试项** | priceCap 精确等于计算后价格，不触发上限截断 |
| **前置条件** | pricing_mode = follow；竞品价格 = 40.00；discount = 2.00；floorPrice = 10.00；priceCap = 38.00 |
| **操作步骤** | 1. 触发定价计算<br>2. 查询售价 |
| **预期结果** | 计算值 = 38 = cap；最终售价 = **38.00**（恰好等于 cap，不截断） |

---

### TC-13-10

| 字段 | 内容 |
|------|------|
| **编号** | TC-13-10 |
| **分类** | 边界场景 |
| **测试项** | 三个渠道中，只有部分渠道配置了 priceCap（follow 模式） |
| **前置条件** | pricing_mode = follow；竞品价格 = 50.00；discount = 2.00；floorPrice = 10.00<br>Web priceCap = 35.00<br>App priceCap = null<br>Wanderu priceCap = null |
| **操作步骤** | 1. 触发定价计算<br>2. 分别查询三渠道售价 |
| **预期结果** | Web = **35.00**（受 cap 限制）；App = **48.00**（无 cap）；Wanderu = **48.00**（无 cap） |

---

## 测试用例汇总

| 编号 | 分类 | 测试项 | 优先级 |
|------|------|--------|--------|
| TC-01-01 | 价格取整 | none 模式不取整 | P1 |
| TC-01-02 | 价格取整 | floor 向下取整 | P1 |
| TC-01-03 | 价格取整 | ceil 向上取整 | P1 |
| TC-01-04 | 价格取整 | round 四舍五入（.5 进位） | P1 |
| TC-01-05 | 价格取整 | round 四舍五入（.4 舍去） | P1 |
| TC-01-06 | 价格取整 | 整数价格取整无变化 | P2 |
| TC-01-07 | 价格取整 | 取整后低于 floor，取 floor | P1 |
| TC-01-08 | 价格取整 | 取整不存储（动态计算） | P1 |
| TC-02-01 | Undercut | 竞品低，触发降价 | P1 |
| TC-02-02 | Undercut | 竞品高，不涨价 | P1 |
| TC-02-03 | Undercut | 降价触发 floor 保底 | P1 |
| TC-02-04 | Undercut | priceCap 在 undercut 下无效 | P1 |
| TC-02-05 | Undercut | 三渠道独立配置 | P2 |
| TC-03-01 | Follow 涨价 | 竞品高，跟涨 | P1 |
| TC-03-02 | Follow 涨价 | 跟涨 profit_amount 为正 | P1 |
| TC-03-03 | Follow 涨价 | 三渠道独立跟涨 | P2 |
| TC-04-01 | Follow 跌价 | 竞品低，跟跌 | P1 |
| TC-04-02 | Follow 跌价 | 跟跌触发 floor 保底 | P1 |
| TC-04-03 | Follow 跌价 | 跟跌 profit_amount 可为负 | P1 |
| TC-05-01 | Price Cap | 超过 cap，取 cap | P1 |
| TC-05-02 | Price Cap | 未超 cap，cap 不生效 | P1 |
| TC-05-03 | Price Cap | 三渠道独立 cap | P1 |
| TC-05-04 | Price Cap | cap 在 undercut 下无效 | P1 |
| TC-06-01 | Cap vs Floor | cap < floor，取 floor | P1 |
| TC-06-02 | Cap vs Floor | cap = floor，正常 | P2 |
| TC-06-03 | Cap vs Floor | Admin 保存时校验 cap >= floor | P1 |
| TC-07-01 | 取整+跟价 | floor + follow 跟涨 | P1 |
| TC-07-02 | 取整+跟价 | ceil + follow + cap | P1 |
| TC-07-03 | 取整+跟价 | round + follow + cap 超限 | P1 |
| TC-07-04 | 取整+跟价 | floor + follow 触发 floor 保底 | P2 |
| TC-08-01 | profit_amount | undercut 跟跌，正值 | P1 |
| TC-08-02 | profit_amount | follow 跟涨，大正值 | P1 |
| TC-08-03 | profit_amount | follow 跟跌，负值 | P1 |
| TC-08-04 | profit_amount | 触发 floor 时基于 floor 计算 | P2 |
| TC-08-05 | profit_amount | 每次计算后更新 | P2 |
| TC-09-01 | Admin UI | undercut 时隐藏 priceCap | P1 |
| TC-09-02 | Admin UI | follow 时显示 priceCap | P1 |
| TC-09-03 | Admin UI | 切换回 undercut，cap 重新隐藏 | P1 |
| TC-09-04 | Admin UI | rounding_mode 下拉 4 选项 | P2 |
| TC-09-05 | Admin UI | pricing_mode 下拉 2 选项 | P2 |
| TC-09-06 | Admin UI | follow 模式 cap 可为空 | P1 |
| TC-10-01 | Admin 展示 | FlixBus 展示取整后价格 | P2 |
| TC-10-02 | Admin 展示 | none 模式展示原始价格 | P2 |
| TC-10-03 | Admin 展示 | GoToBus 也应用取整展示 | P2 |
| TC-11-01 | SQL 迁移 | 历史数据默认 undercut | P1 |
| TC-11-02 | SQL 迁移 | 历史数据默认 rounding=none | P1 |
| TC-11-03 | SQL 迁移 | 历史数据 priceCap=null | P1 |
| TC-11-04 | SQL 迁移 | 历史 profit_amount 回填 | P2 |
| TC-11-05 | SQL 迁移 | 迁移脚本幂等性 | P2 |
| TC-12-01 | 向下兼容 | 存量规则计算结果不变 | P1 |
| TC-12-02 | 向下兼容 | floor 保底逻辑不变 | P1 |
| TC-12-03 | 向下兼容 | 取低价逻辑不变 | P1 |
| TC-12-04 | 向下兼容 | 旧 API 不传新字段不报错 | P1 |
| TC-13-01 | 边界场景 | cap=null 无上限 | P2 |
| TC-13-02 | 边界场景 | 竞品等于当前价 | P2 |
| TC-13-03 | 边界场景 | 两平台均无报价 | P1 |
| TC-13-04 | 边界场景 | 仅 FlixBus 有价 | P2 |
| TC-13-05 | 边界场景 | 仅 GoToBus 有价 | P2 |
| TC-13-06 | 边界场景 | 两平台价格相同 | P2 |
| TC-13-07 | 边界场景 | discount=0 | P2 |
| TC-13-08 | 边界场景 | 竞品价格极低（低于 floor） | P2 |
| TC-13-09 | 边界场景 | 计算值恰好等于 cap | P2 |
| TC-13-10 | 边界场景 | 部分渠道有 cap，部分无 | P2 |

**总计**：60 个测试用例，其中 P1（核心验证）38 个，P2（扩展验证）22 个

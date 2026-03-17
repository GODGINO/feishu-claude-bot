# Wanda FlixBus 竞价功能改动总结

**分支**: `feature/wanda-dynamic-pricing-flixbus-competition-6899522700`
**基于**: `prod`
**改动规模**: 19 文件，+532/-38 行

---

## 一、需求概述

在现有 FlixBus/GoToBus 竞价系统基础上，新增三项功能：

1. **价格取整模式** — 对竞对价格动态取整（不影响原始数据存储）
2. **Follow 跟涨模式** — 新增跟随竞对价格涨跌的比价模式（原来只有压价）
3. **收益追踪** — 落库记录每笔比价的模式、策略和收益金额

---

## 二、功能详情

### 2.1 价格取整模式（price_rounding_mode）

| 模式 | 说明 | 示例（原价 $138.02） |
|------|------|---------------------|
| `none` | 保持原价（默认） | $138.02 |
| `floor` | 向下取整 | $138 |
| `ceil` | 向上取整 | $139 |
| `round` | 四舍五入 | $138 |

- **作用时机**：仅在价格计算和 Admin 展示时动态应用，不影响竞对价格落库
- **作用范围**：应用于竞对原始价格，取整后再减去 discount 得到各渠道价格

### 2.2 Follow 跟涨模式（pricing_mode）

| 模式 | 行为 | 适用场景 |
|------|------|---------|
| `undercut`（默认） | 仅当竞价低于我方价格时才替换 | 保守策略，只压价 |
| `follow` | 竞价与我方价格不同时均替换（涨跌都跟） | 跟随市场价格波动 |

- **价格上限（price_cap）**：仅在 follow 模式下生效，三个渠道独立配置，可为空（不设上限）
- **底线价格（floor price）**：两种模式下均生效，price_cap 不会突破底线价格
- **优先级**：`竞对价格取整 → 减去discount → max(底线价格) → min(价格上限) → max(底线价格)`

### 2.3 收益追踪（profit_amount）

- **字段**：`ticket_competition_info.profit_amount`
- **计算**：`ticketPrice - originPrice`
- **含义**：正值 = 跟涨带来的额外营收；负值 = 压价/跟跌的让利金额
- **查询示例**：
  ```sql
  -- 按模式查看总收益
  SELECT pricing_mode, SUM(profit_amount) as total, COUNT(*) as tickets
  FROM ticket_competition_info GROUP BY pricing_mode;
  ```

---

## 三、改动文件清单（19个）

### 3.1 数据库（1个文件）

| 文件 | 改动 |
|------|------|
| `wanda-admin/sql/feature-...-6899522700.sql` | ① `gotobus_price_discount_rule` 新增 5 列（price_rounding_mode, pricing_mode, price_cap, price_cap_app, price_cap_wanderu）<br>② `ticket_competition_info` 新增 3 列（pricing_mode, price_rounding_mode, profit_amount）<br>③ 历史数据补全 SQL |

### 3.2 API 层 — 核心比价逻辑（7个文件）

| 文件 | 改动 | 影响范围 |
|------|------|---------|
| `GotoBusPricingService.java` | ① 竞对价格取整（applyRounding，公共静态方法）<br>② follow 模式价格上限（min cap → max floor）<br>③ safeLowest helper 消除重复代码<br>④ VO 传递 pricingMode 和 priceRoundingMode | **核心**：所有竞价计算的入口 |
| `SearchBusAction.java` | follow 模式下无论涨跌都替换价格（静态价格 + 动态价格） | 搜索接口出价逻辑 |
| `TripSchedule.java` | ① follow 模式支持（跟涨也触发比价）<br>② 计算 profitAmount 并填入 competitionInfo | 下单时实际票价计算 |
| `CompetitivePricesVo.java` | 新增 pricingMode、priceRoundingMode 字段 | 比价结果传递对象 |
| `FlixbusListPriceAction.java` | 调用公共 applyRounding（消除重复代码） | Admin 端 Flixbus 价格展示 |
| `GotobusPriceDiscountRule.java`（API） | 新增 5 个字段 + getter/setter | API 层规则模型 |
| `GotobusPriceDiscountRule.xml` | ① resultMap 新增 5 列映射<br>② 所有 4 个 SELECT 查询新增 5 列 | iBatis 数据映射 |

### 3.3 API 层 — 落库（2个文件）

| 文件 | 改动 | 影响范围 |
|------|------|---------|
| `TicketCompetitionInfo.java` | 新增 pricingMode、priceRoundingMode、profitAmount 字段 | 比价信息 BO |
| `Ticket.xml` | INSERT 语句新增 3 列 | 比价信息写入 DB |

### 3.4 Admin 层 — 后端（5个文件）

| 文件 | 改动 | 影响范围 |
|------|------|---------|
| `GotobusPriceDiscountRule.java`（Admin） | 新增 5 个字段 + @Column 注解 | Admin Hibernate 模型 |
| `IGotobusPriceDiscountRuleService.java` | 新增 updatePricingFields 接口 | 服务接口 |
| `GotobusPriceDiscountRuleServiceImpl.java` | ① 实现 updatePricingFields<br>② 列表查询填充 pricingMode/priceRoundingMode | 规则管理服务 |
| `GotobusPriceDiscountRulesAction.java` | ① addSave/editSave 处理新字段<br>② 新增 5 个表单参数 + getter/setter | 规则增删改接口 |
| `GotobusPriceDiscountRuleVo.java` | 新增 pricingMode、priceRoundingMode 字段 | 列表展示 VO |

### 3.5 Admin 层 — 比价信息查询（2个文件）

| 文件 | 改动 | 影响范围 |
|------|------|---------|
| `TicketCompetitionInfoVo.java` | 新增 pricingMode、priceRoundingMode、profitAmount 字段 | 比价信息展示 VO |
| `TicketDao.java`（Admin） | SELECT 新增 3 列 | 比价信息查询 |

### 3.6 前端（2个文件）

| 文件 | 改动 | 影响范围 |
|------|------|---------|
| `gotobus-price-discount-rules.js` | ① ruleForm 新增 5 个字段<br>② saveRule 按模式条件发送 priceCap<br>③ editRule 加载新字段 | 规则表单交互逻辑 |
| `gotobus-price-discount-rules.jsp` | ① 列表新增 Pricing Mode / Rounding 列<br>② 表单新增 Pricing Settings 区域<br>③ 三个渠道各增加 Price Cap 输入（follow 模式可见） | 规则管理页面 UI |

---

## 四、影响范围分析

### 4.1 直接影响的业务流程

| 流程 | 影响点 | 风险等级 |
|------|--------|---------|
| **搜索出价** | SearchBusAction — follow 模式涨跌都替换 | ⚠️ 中（核心出价路径） |
| **下单计价** | TripSchedule — follow 模式跟涨记录 | ⚠️ 中（影响实际票价） |
| **竞价计算** | GotoBusPricingService — 取整 + 价格上限 | ⚠️ 中（影响所有渠道价格） |
| **Admin 规则管理** | 表单增删改查 | 🟢 低 |
| **Admin 价格展示** | FlixbusListPriceAction 展示取整后价格 | 🟢 低 |

### 4.2 不受影响的部分

- GoToBus/Flixbus 价格拉取和缓存逻辑 — 未改动
- 退款流程 — 未改动
- 其他模块（排班、库存、支付等）— 未改动
- 现有 undercut 模式行为 — 完全向后兼容

### 4.3 向后兼容性

- 所有新字段均有默认值：`pricing_mode='undercut'`、`price_rounding_mode='none'`、`price_cap=NULL`
- 不执行 SQL 迁移的情况下，现有功能不受影响（新字段使用 Java 默认值）
- 历史数据补全 SQL 保证存量记录字段完整

---

## 五、数据库变更汇总

### gotobus_price_discount_rule（新增 5 列）

| 列名 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| price_rounding_mode | VARCHAR(10) | 'none' | 取整模式 |
| pricing_mode | VARCHAR(10) | 'undercut' | 比价模式 |
| price_cap | DECIMAL(10,2) | NULL | Web 价格上限 |
| price_cap_app | DECIMAL(10,2) | NULL | App 价格上限 |
| price_cap_wanderu | DECIMAL(10,2) | NULL | Wanderu 价格上限 |

### ticket_competition_info（新增 3 列）

| 列名 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| pricing_mode | VARCHAR(10) | NULL | 比价模式 |
| price_rounding_mode | VARCHAR(10) | NULL | 取整模式 |
| profit_amount | DECIMAL(10,2) | NULL | 收益金额 |

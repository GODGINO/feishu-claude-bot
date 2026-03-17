# Wanda FlixBus 竞价功能 — 技术全景

## 一、功能概述

竞价系统通过定时抓取竞对（GoToBus、Flixbus）票价，在用户搜索车票时动态调整 Wanda 售价，使其始终低于竞对一定金额。支持 **Web、App、Wanderu** 三个渠道独立配置差价和底价，具备价格预警邮件、Mock 测试、手动同步等运维能力。

核心流程：`定时抓取 → Redis 缓存 → 搜索时比价 → 动态调价 → 价格预警`

---

## 二、竞价规则管理（Admin 后台）

**入口**：`/system/bus-bidding-rules`，Action 类 `GotobusPriceDiscountRulesAction`

### 核心接口

| 接口 | 功能 |
|------|------|
| `gotobus-price-discount-rule-list-query` | 查询当前公司所有竞价规则 |
| `gotobus-price-discount-rule-query` | 按 ID 查询单条规则 |
| `gotobus-price-discount-rule-add-save` | 新增规则 |
| `gotobus-price-discount-rule-edit-save` | 编辑规则 |
| `gotobus-price-discount-rule-change-status` | 启用/停用规则 |
| `gotobus-price-discount-rule-subbusline-list` | 按出发/到达城市查可用子线路 |
| `gotobus-price-trigger-sync` | 手动触发价格同步（支持传 `platform` 参数） |
| `gotobus-competitor-trip-list` | 查询规则下的竞对班次配置 |
| `gotobus-competitor-trip-add` | 新增竞对班次 |
| `gotobus-competitor-trip-delete` | 删除竞对班次 |

### 规则参数说明

每条规则可独立配置：

- **Wanda 城市对**：`departureCityId` / `arrivalCityId`（内部城市 ID）
- **GoToBus 城市对**：`gotobusDepartureCityName` / `gotobusArrivalCityName`（GoToBus 城市名）
- **Flixbus 城市对**：`flixbusDepartureCityName` / `flixbusArrivalCityName`（Flixbus 城市 UUID）
- **三渠道差价与底价**：
  - Web：`cheaperPriceThanGotobus` / `availableLowestPrice`
  - App：`cheaperPriceThanGotobusApp` / `availableLowestPriceApp`
  - Wanderu：`cheaperPriceThanGotobusWanderu` / `availableLowestPriceWanderu`
- **预警价**：`warningPrice`（竞对价格低于此值时触发邮件告警）
- **关联子线路**：`subBuslineIds`（逗号分隔，一条规则可关联多条子线路）

### Competitor Trip（竞对班次过滤）

通过 `GotobusPriceDiscountRuleCompetitorTrip` 表，可以为每条规则指定**需要参与比价的竞对具体班次**（按出发站名、到达站名、出发时间 HH:mm 三元组匹配）。若未配置，则取全量班次最低价。

新增/编辑规则时，前端通过 `competitorTripsJson` 字段以 JSON 数组全量提交，后端先删除旧的再批量插入（全量替换策略）。

---

## 三、价格抓取机制

### 3.1 GoToBus 价格抓取

- 工具类：`GotoBusUtil` + `GotoBusRemoteUtil`
- `GotoBusRemoteUtil.storeGetGotoBusPriceFromRemote(from, to)` 调用 GoToBus 远程接口获取未来若干天的票价
- 返回 `RoutePriceResultVo`（含各日期价格列表 `List<PriceDetailVo>` 和最低价 `lowest`）
- 抓取后序列化为 JSON 存入 Redis，key 格式：`wanda:gotobus-price:<from>-<to>`，TTL 3 小时
- 支持 Mock 数据（`wanda:gotobus-mock-response` 缓存 key）

### 3.2 Flixbus 价格抓取

- 工具类：`FlixbusRemoteUtil` + `FlixbusUtil`
- API 地址：`https://global.api.flixbus.com/search/service/v4/search`
- 通过 **ScraperAPI 代理**访问（配置 `scraperApiKey`），避免被封
- 业务开关：`SysConfig.isFlixbusPriceComparisonOpen()`
- 每次抓取**未来 28 天**的价格数据
- 全量班次（含出发站名、到达站名、出发时间 HH:mm、价格）缓存到 Redis，key 格式：`wanda:flixbus-trips:<fromCityId>-<toCityId>:<date>`，TTL 3 小时
- 读取时按 `competitor_trip` 配置过滤后取最低价

### 3.3 Mock 支持

- Flixbus Mock Action：`FlixbusMockAction`（API 接口），支持 `set`/`clear`/`view` 三个操作
- Mock 数据优先级高于真实 API 调用，存入 Redis `wanda:flixbus-mock-response:<route>`，TTL 24 小时
- Mock registry 统一管理所有 mock 规则的 key

---

## 四、搜索结果竞价逻辑

核心入口：`SearchBusAction.execute()`

### 4.1 整体流程

1. `ScheduleService.searchScheduleTickets()` 查询出本公司班次及原始价格
2. 计算早鸟优惠（Early Booking Discount）
3. Web 端额外计算 App 展示价
4. **调用竞价引擎** `GotoBusPricingService.calculateCompetitivePricesAfterCompare(subBuslineIdList, date)`
5. 用竞价结果更新各渠道价格
6. 重新处理最低价标识

### 4.2 竞价引擎核心算法（GotoBusPricingService）

```
竞对基准价 = min(gotobusPrice, flixbusPrice)   // 两平台取低者
渠道价格 = max(竞对基准价 - 差价, 底线价格)       // 差价后不得低于底线
```

详细步骤：

1. 查询所有激活规则 `GotobusPriceDiscountRuleDao.findAllActiveRules()`
2. 构建 `subBuslineId -> List<Rule>` 映射（同一子线路可配多条规则）
3. 批量从 Redis 读取 GoToBus 缓存价格
4. 从 Redis 读取 Flixbus 全量班次缓存，按 competitor_trip 过滤后取最低价
5. GoToBus 与 Flixbus 取**较低者**作为竞对基准价
6. 分别计算 Web/App/Wanderu 三渠道价格
7. 同一 subBuslineId 有多条规则时，取 **webPrice 最低**的结果
8. 返回 `Map<Integer, CompetitivePricesVo>`（key=subBuslineId）

### 4.3 价格更新逻辑（compareAndUpdatePrices）

对每个 SearchResult：

- **静态价格**（PricingPlanStatic）：copy 原对象后，对 adult/child/infant 三种票价分别比较，竞价更低则替换
- **动态价格**：直接比较 dynamicPrice，竞价更低则替换
- **App 客户端**：isApp=true 时，主价格（staticPlan/dynamicPrice）也使用 App 价格
- **Wanderu 渠道**：独立的 staticPlanWanderu / wanderuDynamicPrice

**关键技术点**：`PricingPlanStatic.copy()` — 使用深拷贝避免多渠道共享同一对象引用导致价格互相污染。

---

## 五、告警邮件机制

### 5.1 告警任务

| 任务类 | 职责 | 触发条件 |
|--------|------|----------|
| `GotoBusPriceAlertTask` | GoToBus 单独预警 | 竞对价格 <= warningPrice |
| `FlixbusPriceAlertTask` | Flixbus 单独预警 | Flixbus 最低价 <= warningPrice |
| `CombinedPriceAlertTask` | **合并预警（当前使用）** | GoToBus 或 Flixbus 任一触发 |

### 5.2 去重机制

- 以**规则维度的最低价**作为状态标识，存入 Redis（`wanda:gotobus-rule-min-price-alert:<ruleId>` / `wanda:flixbus-rule-min-price-alert:<ruleId>`），TTL 7 天
- 同一最低价不重复发送邮件
- 价格回升至预警线以上时清除缓存，下次再跌破时重新触发

### 5.3 邮件内容

- 邮件主题：`Price Alert`（合并）/ `GoToBus Price Alert` / `Flixbus Price Alert`
- 内容为 HTML 格式，按规则分组，列出触发预警的日期和价格
- GoToBus 邮件中同时附带同日 Flixbus 参考价
- 每个日期附带可点击的搜索链接（GoToBus/Flixbus 官网搜索 URL）
- 收件人配置：`SysConfig.getGotobusWarningEmailReceivers()`

---

## 六、缓存机制

| Redis Key | 说明 | TTL |
|-----------|------|-----|
| `wanda:gotobus-price:<from>-<to>` | GoToBus 完整抓取数据（JSON 序列化 RoutePriceResultVo） | 3 小时 |
| `wanda:flixbus-trips:<fromCityId>-<toCityId>:<date>` | Flixbus 全量班次缓存（JSON 数组 `[{ds,as,dt,p}]`） | 3 小时 |
| `wanda:gotobus-rule-min-price-alert:<ruleId>` | GoToBus 规则最低价预警状态 | 7 天 |
| `wanda:flixbus-rule-min-price-alert:<ruleId>` | Flixbus 规则最低价预警状态 | 7 天 |
| `wanda:gotobus-mock-response:<route>` | GoToBus Mock 数据 | - |
| `wanda:flixbus-mock-response:<route>` | Flixbus Mock 数据 | 24 小时 |
| `wanda:flixbus-mock-response:registry` | Flixbus Mock 注册表 | 24 小时 |

---

## 七、定时同步与手动触发

### 定时任务

`PriceSyncTask`（extends `TimerTask`），定时执行合并同步：

1. 获取 Redis 分布式锁 `GotoBusPriceTaskLock`（防止多实例重复执行）
2. 执行 `GotoBusUtil.fetchScheduledPrices(activeRules)` 抓取 GoToBus 价格
3. 执行 `FlixbusUtil.fetchScheduledPrices(activeRules)` 抓取 Flixbus 未来 28 天价格
4. 异步启动 `CombinedPriceAlertTask` 处理预警邮件

### 手动触发

两个入口：

- Admin 后台：`gotobus-price-trigger-sync` 接口（`GotobusPriceDiscountRulesAction`），通过 `ToolsUtils.triggerPriceSync(platform)` 在新线程中执行
- API 端：`FlixbusTriggerTaskAction`，直接调用 `PriceSyncTask.run()`

### 验证接口

- `FlixbusListPriceAction`：列出所有激活规则在 Redis 中的 Flixbus 缓存价格（未来 28 天）
- `FlixbusPriceAction`：查询指定城市对和日期的 Flixbus 当日价格和近 7 天最低价

---

## 八、技术要点

### 8.1 PricingPlanStatic copy 防止污染

`SearchBusAction.updateStaticPlanPrices()` 在更新价格前先调用 `staticPlan.copy()` 创建新对象，避免 Web/App/Wanderu 三个渠道共享同一引用导致改一个影响全部。

### 8.2 多规则取优

同一 `subBuslineId` 可能匹配多条规则（不同竞对城市对），引擎对每条规则独立计算后取 `webPrice` 最低的结果。

### 8.3 多竞对平台取低价

GoToBus 和 Flixbus 两个平台的价格取**较低者**作为竞对基准价，并记录实际采用的平台（`competitorPlatform` 字段）。

### 8.4 Competitor Trip 过滤

Flixbus 缓存全量班次数据，读取时按 `gotobus_price_discount_rule_competitor_trip` 表中配置的 (departureStationName, arrivalStationName, departureTime) 三元组精确匹配过滤。未配置 trip 时取全量最低价。

### 8.5 ScraperAPI 代理

Flixbus API 通过 ScraperAPI 代理访问（`SysConfig.getScraperApiKey()`），防止 IP 被 Flixbus 封禁。

### 8.6 异步处理

- 价格预警邮件在新线程中异步执行（`new Thread(new CombinedPriceAlertTask(...)).start()`）
- Admin 手动同步也在新线程中执行，接口立即返回

### 8.7 分布式锁

`GotoBusPriceTaskLock` 基于 Redis 实现，防止多实例同时执行价格同步任务。

### 8.8 Mock 测试体系

Flixbus 完整支持 Mock：通过 `FlixbusMockAction` 设置模拟响应 → `FlixbusRemoteUtil.fetchTrips()` 优先读取 Mock → 写入正常的 trips 缓存 → 竞价引擎正常消费。

### 8.9 Spring ASM 兼容性

项目使用较老版本的 Spring，内置 ASM 不支持 Java 8 lambda 字节码（invokedynamic 指令）。所有异步代码使用匿名内部类 `new Runnable()` 替代 lambda。

---

## 九、数据模型

### 9.1 `gotobus_price_discount_rule` 表

| 字段 | 类型 | 说明 |
|------|------|------|
| id | Integer | 主键 |
| departure_city_id | Integer | Wanda 出发城市 ID |
| arrival_city_id | Integer | Wanda 到达城市 ID |
| gotobus_departure_city_name | String | GoToBus 出发城市名 |
| gotobus_arrival_city_name | String | GoToBus 到达城市名 |
| flixbus_departure_city_name | String | Flixbus 出发城市 UUID |
| flixbus_arrival_city_name | String | Flixbus 到达城市 UUID |
| cheaper_price_than_gotobus | BigDecimal | Web 渠道比竞对便宜的金额 |
| available_lowest_price | BigDecimal | Web 渠道底线价格 |
| cheaper_price_than_gotobus_app | BigDecimal | App 渠道比竞对便宜的金额 |
| available_lowest_price_app | BigDecimal | App 渠道底线价格 |
| cheaper_price_than_gotobus_wanderu | BigDecimal | Wanderu 渠道比竞对便宜的金额 |
| available_lowest_price_wanderu | BigDecimal | Wanderu 渠道底线价格 |
| warning_price | BigDecimal | 预警价格阈值 |
| sub_busline_ids | String | 关联子线路 ID（逗号分隔） |
| company_id | Integer | 公司 ID |
| is_active | Boolean | 是否启用 |
| create_time | Date | 创建时间 |
| last_modify | Date | 最后修改时间 |

### 9.2 `gotobus_price_discount_rule_competitor_trip` 表

| 字段 | 类型 | 说明 |
|------|------|------|
| id | Integer | 主键 |
| rule_id | Integer | 关联的规则 ID（外键） |
| platform | String | 平台标识，如 "flixbus" |
| departure_station_name | String | 出发站点名 |
| arrival_station_name | String | 到达站点名 |
| departure_time | String | 出发时间（HH:mm） |
| create_time | Date | 创建时间 |

### 9.3 关键 VO 对象

- **CompetitivePricesVo**：竞价计算结果，包含 webPrice / appPrice / wanderuPrice / gotoBusPrice（实际竞对价格）/ competitorPlatform
- **DateRoutePriceVo**：某日期价格 + 近期最低价
- **RoutePriceResultVo**：完整路线抓取结果（from / to / departurePrices / lowest）
- **PriceDetailVo**：单日期价格（date + price）

---

## 十、关键源文件索引

| 文件 | 路径 |
|------|------|
| 竞价引擎 | `wanda-api/src/com/wanda/api/online/service/GotoBusPricingService.java` |
| 搜索竞价 | `wanda-api/src/com/wanda/api/online/action/search/SearchBusAction.java` |
| Admin 规则管理 | `wanda-admin/src/com/wanda/admin/action/system/GotobusPriceDiscountRulesAction.java` |
| 竞价结果 VO | `wanda-api/src/com/wanda/api/online/action/vo/CompetitivePricesVo.java` |
| Flixbus 工具类 | `wanda-api/src/com/wanda/util/FlixbusUtil.java` |
| Flixbus 远程调用 | `wanda-api/src/com/wanda/util/FlixbusRemoteUtil.java` |
| GoToBus 工具类 | `wanda-api/src/com/wanda/util/GotoBusUtil.java` |
| GoToBus 远程调用 | `wanda-api/src/com/wanda/util/GotoBusRemoteUtil.java` |
| 合并预警任务 | `wanda-api/src/com/wanda/util/CombinedPriceAlertTask.java` |
| GoToBus 预警任务 | `wanda-api/src/com/wanda/util/GotoBusPriceAlertTask.java` |
| Flixbus 预警任务 | `wanda-api/src/com/wanda/util/FlixbusPriceAlertTask.java` |
| 定时同步任务 | `wanda-api/src/com/wanda/listener/PriceSyncTask.java` |
| 手动触发接口 | `wanda-api/src/com/wanda/api/online/action/config/FlixbusTriggerTaskAction.java` |
| Mock 接口 | `wanda-api/src/com/wanda/api/online/action/config/FlixbusMockAction.java` |
| 缓存价格列表 | `wanda-api/src/com/wanda/api/online/action/config/FlixbusListPriceAction.java` |
| 价格查询接口 | `wanda-api/src/com/wanda/api/online/action/config/FlixbusPriceAction.java` |
| Redis Key 定义 | `wanda-api/src/com/wanda/util/RedisCacheKey.java` |
| 规则数据模型 | `wanda-api/src/com/wanda/basedata/model/GotobusPriceDiscountRule.java` |
| 竞对班次模型 | `wanda-api/src/com/wanda/basedata/model/GotobusPriceDiscountRuleCompetitorTrip.java` |
| 静态价格模型 | `wanda-api/src/com/wanda/basedata/model/PricingPlanStatic.java` |

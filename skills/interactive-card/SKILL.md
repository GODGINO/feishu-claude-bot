---
name: interactive-card
description: >
  卡片交互能力（按钮 / 下拉选择器）。在流式卡片回复中追加可点击按钮或表单字段，
  用于操作确认、链接入口、单选/多选、多字段配置等场景。
  当回复需要用户做选择、确认、填表，或包含可点击链接时自动使用。
---

# 卡片交互（Interactive Card v2）

回复末尾可以追加交互元素让用户在卡片内直接操作。提供两种**互斥**范式：

| 范式 | 触发标签 | 适用场景 |
|------|---------|---------|
| **BUTTON**（按钮） | `<<BUTTON:...>>` × N | 单维度决策、立即触发的单步操作 |
| **SELECT / MSELECT**（下拉表单） | `<<SELECT:...>>` / `<<MSELECT:...>>` × N | 多维度决策、需要先填好多个独立字段再统一提交。SELECT = 单选，MSELECT = 多选，两者可共存于同一表单 |

**核心规则：BUTTON 与 SELECT/MSELECT 互斥，一个回复只能用一种范式。** 同时写 BUTTON 和 SELECT/MSELECT 时系统会强制丢弃 SELECT/MSELECT 并打 warn 日志。SELECT 和 MSELECT 之间不互斥，可以在同一回复里混合使用。

---

## 模式 A：BUTTON

### 语法

```
<<BUTTON:显示文案|操作标识|样式?>>
```

- **显示文案**：按钮上显示的文字（2-6 字）
- **操作标识**：
  - 普通字符串 → 点击后下一 turn 收到 `[<用户名> 点击了按钮: 显示文案]`
  - `http(s)://...` → 直接在浏览器打开链接，不通知你，文案自动加 🔗 前缀
  - `/foo` 斜杠开头 → 路由到 slash 命令处理器（等同用户输入）
- **样式**（可选）：`primary`（蓝）、`danger`（红），默认灰色

点击行为：点击瞬间**所有按钮都禁用**，被点的按钮文字自动加 `@<用户名>` + 变 primary 高亮。

### 适用场景

#### 1. 操作确认

```
代码修改完成，所有测试通过。
<<BUTTON:推送代码|push|primary>>
<<BUTTON:查看 diff|show_diff>>
<<BUTTON:撤销修改|revert|danger>>
```

#### 2. 链接入口

```
页面已部署完成！
<<BUTTON:查看页面|https://example.com/preview|primary>>
<<BUTTON:打开文档|https://docs.example.com|primary>>
```

#### 3. 单维度多选项

```
有两种实现方案：
- 方案 A：REST API，简单但慢
- 方案 B：WebSocket，复杂但实时
<<BUTTON:选 A|plan_a|primary>>
<<BUTTON:选 B|plan_b|primary>>
```

### BUTTON 严禁清单

每个按钮必须是一个**可直接执行的具体指令**。

禁止：
- `OK` / `好的` / `收到` / `确认` —— 纯确认无动作
- `可以用` / `没问题` / `满意` —— 态度表达，不是指令
- `还要改` / `不满意` —— 模糊，不知道改什么
- `继续` / `下一步` —— 没指定继续做什么
- `了解` / `明白了` —— 无后续操作

允许：
- `推送代码` / `部署到生产` —— 具体动作
- `提高分辨率到 600 DPI` —— 明确参数
- `生成移动端版本` —— 新明确任务
- `发送给 @Amanda` —— 指定接收人

---

## 模式 B：SELECT / MSELECT（表单字段）

一个表单可以同时包含若干 SELECT（单选下拉）和 MSELECT（多选下拉）。系统会把它们合并成同一个 form 元素并自动追加一个"提交"按钮。

### 语法

```
<<SELECT:placeholder|name|key1=文案1|key2=文案2|...>>      （单选）
<<MSELECT:placeholder|name|key1=文案1|key2=文案2|...>>     （多选）
```

- **placeholder**：下拉占位文字（如"选择周期"），同时也是提交后显示的字段名
- **name**：内部字段名，用于回调（如 `cycle`、`time`、`provider`、`sectors`）
- **key=文案**：每个选项的内部键 + 用户看到的文案。可写 `daily=每天`、也可写 `daily`（key 和 label 相同）

行为流程：
1. 用户看到 N 个独立下拉（SELECT 单选 + MSELECT 多选）+ 一个"提交"按钮
2. 全部选完点提交 → 提交按钮高亮 + 文案变 `✓ 已提交 @<用户名>` 且 disabled
3. 所有字段收敛为只读 markdown 行：`**<placeholder>**：<选中 label>`（多选用顿号连接）
4. 下一 turn 收到 `[<用户名> 选择了: name1=label1 / name2=labelA,labelB]`（多选值用逗号分隔）

### 适用场景

#### 1. 创建 cron 任务

```
建定时任务，请配置三个维度：
<<SELECT:周期|cycle|daily=每天|weekly=每周|monthly=每月>>
<<SELECT:时间|time|morning=早 8:00|noon=中午 12:00|evening=晚 8:00>>
<<SELECT:任务类型|kind|brief=简报|digest=摘要|alert=监控>>
```

#### 2. 配置邮箱账号

```
请选择邮箱类型和用途：
<<SELECT:邮箱服务商|provider|gmail=Gmail|outlook=Outlook|qq=QQ 邮箱|163=网易 163|custom=其他 IMAP>>
<<SELECT:用途标签|purpose|work=工作|personal=个人|finance=金融|all=全部>>
```

#### 3. 多维度筛选

```
查询股票，请定位：
<<SELECT:市场|market|a=A股|hk=港股|us=美股>>
<<SELECT:板块|sector|tech=科技|finance=金融|energy=能源|consumer=消费>>
<<SELECT:时间窗口|window|1d=今天|1w=一周|1m=一月|1y=一年>>
```

#### 4. 创建 alert

```
监控条件请配置：
<<SELECT:监控对象|target|email=邮件|stock=股票|file=文件|pr=PR>>
<<SELECT:触发条件|condition|new=新增|change=变化|threshold=阈值>>
<<SELECT:通知方式|notify|im=飞书|wechat=微信|both=两个都发>>
```

#### 5. 订阅多个板块（MSELECT 多选）

```
请勾选要订阅的板块（可多选）：
<<MSELECT:订阅板块|sectors|tech=科技|finance=金融|energy=能源|consumer=消费|healthcare=医药>>
<<SELECT:推送频率|freq|daily=每天|weekly=每周>>
```

回调：`[<用户名> 选择了: sectors=科技,金融,医药 / freq=每天]`

#### 6. 混合 SELECT + MSELECT

```
配置看板：
<<SELECT:市场|market|a=A股|hk=港股|us=美股>>
<<MSELECT:关注板块|sectors|tech=科技|finance=金融|energy=能源>>
<<MSELECT:推送渠道|channels|im=飞书|email=邮件|wechat=微信>>
```

### SELECT / MSELECT 严禁清单

禁止：
- 选项超过 7 个 —— 长下拉用户难选，改用让用户文字输入
- 单维度单选强行用 SELECT —— 1 个字段的 select 等同于 N 个 BUTTON，应该用 BUTTON
- 在同一回复里**和 BUTTON 一起写** —— 系统会强制丢 SELECT/MSELECT（warn 日志）
- 把 cron 表达式、文件路径这种需要精确输入的东西塞进下拉 —— 让用户输入
- MSELECT 用在"只能选一个"的场景 —— 选 SELECT；MSELECT 是"可以选多个"

允许：
- 多个**独立维度**的离散选择
- 选项数量稳定在 2-6 个
- 用户记得住、不需要查的标签
- SELECT 和 MSELECT 在同一表单中共存

---

## 决策表：BUTTON / SELECT / MSELECT 选哪个？

| 问题 | 用什么 |
|------|--------|
| 一个 yes / no 决定 | BUTTON × 2 |
| 在 3 个方案里挑 1 个 | BUTTON × 3 |
| 完成任务后给后续操作入口 | BUTTON |
| 链接打开 | BUTTON（URL 形式） |
| 选周期 + 时间 + 类型（3 个独立维度，每维度单选） | SELECT × 3 |
| 选市场 + 板块（2 个独立维度，每维度单选） | SELECT × 2 |
| 让用户从一组标签里勾选多个 | MSELECT |
| 多个维度，部分单选部分多选 | SELECT + MSELECT 混合 |
| 配置一个表单类的东西 | SELECT / MSELECT |
| 一个独立维度，但选项 7+ 个 | 让用户文字输入（不要下拉） |
| 没有有意义的后续 | 都不要 |

**判别原则**：
- "用户点完立即触发一个动作"→ BUTTON
- "用户先填好几个字段，全部填完再提交触发"→ SELECT / MSELECT
- "该字段只能选一个" → SELECT；"该字段可以选多个" → MSELECT

---

## 互斥规则（再次强调）

```
<<BUTTON:foo|a>> + <<SELECT:bar|b|x=X>>           ❌ 系统会丢弃 SELECT
<<BUTTON:foo|a>> + <<MSELECT:bar|b|x=X>>          ❌ 系统会丢弃 MSELECT
<<BUTTON:foo|a>> + <<BUTTON:bar|b>>               ✅ 多按钮可以
<<SELECT:foo|a|x=X>> + <<SELECT:bar|b|y=Y>>       ✅ 多下拉可以
<<MSELECT:foo|a|x=X>> + <<MSELECT:bar|b|y=Y>>     ✅ 多个多选可以
<<SELECT:foo|a|x=X>> + <<MSELECT:bar|b|y=Y>>      ✅ SELECT 和 MSELECT 可共存
```

一个回复内的所有交互元素：BUTTON 和 SELECT/MSELECT 不能同时出现。SELECT 之间、MSELECT 之间、SELECT 与 MSELECT 之间都可以自由组合。如果业务上确实需要 BUTTON + 表单混合（罕见），就拆成两个回复：先发表单收集字段，根据用户选择再发按钮确认。

# 采购中心（Procurement Center）设计契约

> 两轮设计评审（2026-06-12）合并落档。本文是 V1 动工前的**契约文档**：范围、铁律、决策点以此为准。
> 状态：设计已确认；V1 migration 草案与排期另行评审后才动代码。

---

## 0. 四条铁律（落档要求，不可违背）

1. **不做独立采购系统**。采购中心必须长在订单节拍器之上：采购是订单生命周期中的一个责任阶段，复用既有节点 / SLA / 红黄绿灯 / 责任人 / 日志 / matters 体系。
2. **订单是唯一主线**。任何采购行必须追溯到 `order_id`；找料需求必须挂 `order_id` 或 `quote_id` 至少其一（市场调研型除外，见决策 6）。
3. **`factories` 是供应商底座**。不新建 suppliers 表；factories 扩展为全品类供应商库（garment / fabric / trim / printing / washing / embroidery）。
4. **`procurement_line_items` 是唯一采购执行行表**。吸收 `procurement_tracking` 的进度、审批、通知字段；tracking 冻结为历史只读，不再作为新流程主表。

---

## 1. 已确认决策（8 项，2026-06-12 拍板）

| # | 决策 | 结论 |
|---|------|------|
| 1 | 双表合并 | ✅ line_items 唯一执行行表；tracking 冻结只读 |
| 2 | 供应商库 | ✅ 复用并扩展 factories，不新建 suppliers |
| 3 | 让步接收审批 | ✅ V1 仅 procurement_manager + admin 可审批 |
| 4 | 价格超基线 | V1 只记录 + 页面标色提醒（price_baseline / price_variance_pct）；**不阻断流转**。V2 价格库成熟后再开硬门禁（防样本不足误伤） |
| 5 | 命名 | V1–V2「采购中心」；数据结构按供应链级设计；V3 外协/印洗/成衣并入后升级「供应链中心」 |
| 6 | 找料追溯锚 | sourcing_requests 必挂 order_id 或 quote_id 其一；市场调研型须 procurement_manager 创建/审批，标 `source_type='market_research'` |
| 7 | 缺料硬闸 override | **仅 admin 可放行**；procurement_manager 只能发起 override request。强排必留痕：谁放行 / 原因 / 风险说明 / 影响订单 |
| 8 | 绩效权重两套模板 | 跟单：准时 40 / 异常关闭 25 / 数据完整 20 / 成本节约 10 / 新供应商 5。经理：成本节约 30 / 供应商开发 25 / 异常关闭 20 / 准时 15 / 数据完整 10 |

---

## 2. 整体架构

```
                          订单（唯一主线）
                             │
            ┌────────────────┼────────────────┐
       materials_bom    18关卡里程碑      order_cost_baseline
       (要什么料)      (采购4节点=锚点)     (预算红线)
            └───────┬────────┴────────┬───────┘
                    ▼                 │
        procurement_plans (V2 计划层) ◄┘  订单评审完成自动生成草案
                    ▼
        procurement_line_items (执行层，行级状态机)
           ▼       ▼       ▼
      goods_    价格快照    催货/异常
      receipts  price_history  daily_tasks
   ════════ 沉淀层（公司资产，自动从订单数据物化）════════
   material_library(V2)   price_history   factories(供应商视角)
                    ▼              ▼
            supplier_scores(V2 月度物化)   procurement_matters(风险物化)
                                              → CEO 看板
```

三层铁律：执行层全挂 order_id；资产层**不是录入出来的，是从采购行自动沉淀的**；风险层是物化投影（完全复用 customer_matters 模式：matter_key / severity / evidence / upsert+过期清理 / dry_run→execute→nightly cron）。

---

## 3. 数据库设计（全量蓝图；V1 子集见 §11）

### 3.1 `procurement_line_items`（扩展现有表）
新增：`plan_id(V2)` · `supplier_id(FK→factories)` · `line_status`(状态机) · `required_by`(需到日=齐料点倒推) · `promised_date` · `expected_arrival` · `po_no` · `confirmed_at` · `shipped_at` · `last_chased_at` · `chase_count` · `price_baseline`(下单时历史中位价快照) · `price_variance_pct`(生成列) · 从 tracking 迁入 `is_supplement / supplement_reason / approved_by_name / approved_at`。

### 3.2 `goods_receipts`（到货验收，一行可多批）
`line_item_id` · `order_id` · `received_qty/unit` · `received_at/by` · `inspection_result(pass/concession/reject/pending)` · `aql_level` · `defect_notes` · `concession_approved_by`(限 PM/admin) · `return_required/status` · `photos(jsonb)`。

### 3.3 `procurement_logs`（复制 milestone_logs 结构）
`line_item_id` · `order_id` · `actor_user_id` · `action`(status_transition/chase/receive/inspect/approve/override/cancel) · `from_status/to_status` · `note` · `payload`。

### 3.4 `price_history`（每次下单自动写）
`order_id` · `line_item_id` · `supplier_id` · `material_name/specification`(V1 文本；V2 加 material_id FK) · `unit_price/currency/unit/qty` · `quoted_at` · `source(order/quote/market)`。

### 3.5 `factories` 供应商扩展
`payment_terms` · `default_lead_days` · `moq_notes` · `contact_wechat` · `supplier_grade(A/B/C/D)` · `grade_updated_at`。

### 3.6 `procurement_matters`（克隆 customer_matters）
`order_id/order_no` · `supplier_id` · `line_item_id` · `matter_type(material_shortage/supplier_delay/price_anomaly/quality_reject/chase_stalled/risk_schedule)` · `severity(high/medium)` · `title` · `evidence(jsonb)` · `source/source_ref` · `matter_key(UNIQUE)` · `detected_at/materialized_at`。RLS：service-role 写 / 登录读。

### 3.7 V2 表（蓝图预留，V1 不建）
`procurement_plans`（计划头：三个齐料点 fabric/trims/packing_needed_by）· `material_library`（材料资产，定料/关行时自动 upsert）· `supplier_scores`（月度物化）· `buyer_scores`（团队绩效月度物化）· `sourcing_requests` + `sourcing_candidates`（找料流程）。

---

## 4. 采购行状态机

```
draft → pending_order → ordered → confirmed → [in_production] → shipped → arrived
  → accepted / concession(PM·admin审批) / rejected(退货→新行回 pending_order)
  → closed（触发沉淀：price_history + V2 material_library + 供应商交期实绩）
任意状态 → cancelled（必填理由，留日志）
```
- 每次转换写 `procurement_logs`；`arrived→accepted` 强制存在 goods_receipts（凭证机制）。
- **红黄绿灯与状态正交**，由日期差驱动：`expected_arrival(或 promised_date) vs required_by` → 绿(余量>3天)/黄(0–3天)/红(已晚或将晚)；未下单行用 `now vs (required_by − 品类默认 lead_days)` 判"再不下单就晚"。
- 价格提醒（V1）：`price_variance_pct` 超阈值页面标黄/标红，不阻断（决策 4）。

---

## 5. 页面设计（工作队列模式）

```
/procurement
├── Dashboard      今日工作台（待下单N·待催货N·待验收N·红灯TopN）
├── 采购计划(V2)
├── 待下单         pending_order，按 required_by 紧迫排序；超基线价标色
├── 待催货         在途行 expected 临近/已晚；一键催货留痕；3天无响应升级 PM
├── 待验收         arrived 未验收；验收+照片；让步走 PM/admin 审批
├── 供应商库       factories 供应商视角（档案/等级/合作状态/黑名单）
├── 材料库(V2) · 价格库(V2分析,V1仅沉淀) · 找料需求(V2)
├── 风险中心       procurement_matters 只读
└── 采购分析(V2)   准时率/节约/评分榜/团队绩效
```
订单详情页 `ProcurementTab` 保持单订单视角（行级操作入口）；采购中心是跨订单工作队列——同一数据两个视角。

---

## 6. KPI 与团队绩效

- 跟单（小吴→procurement 角色）：日=待下单清零/应催未催=0/到货当日登记；周=下单及时率/催货闭环率/验收≤1天；月=经手行准时率/预警提前天数/数据完整率。
- 经理（Helen→procurement_manager 角色）：日=价格审批≤4h/异常当日闭环；周=超基线占比与节约额/供应商档案更新/让步留痕100%；月=采购成本率/成本节约额/评分覆盖/D级处置/新源开发。
- 部门：周=准时到料率/缺料停工次数；月=趋势+成本节约+库覆盖率。
- **buyer_scores（V2 物化）**：两套权重模板见决策 8；样本<10 行标低置信不评级；豁免留痕；指标全部来自系统行为数据（倒逼数据完整率）。

## 7. 供应商评分（V2 月度物化）

质量 40%（合格批率/让步率/拒收率）· 交期 30%（准时率/延期衰减）· 价格 20%（vs 同类中位指数，封顶防低价劣质）· 配合度 10%（催货响应+经理月评）。≥85 A / 70–84 B / 55–69 C(新单需PM批) / <55 D(停用候选)。月批次<5 标低置信不自动降级。物化纪律同 customer_rhythm：cron 算、回写 factories.supplier_grade、页面只读。

## 8. CEO 看板

`/ceo` 增「🧵 采购风险」区（matters 模式，nightly 物化零页面计算）：本月准时到料率+趋势 · 成本节约额 · 缺料风险订单（齐料点倒排）· 未来7天风险日历（开裁/上线倒排）· 延期供应商 Top · 价格异常待批。

## 9. 与订单节拍器集成

| 接入点 | 方案 |
|---|---|
| 订单节点 | 评审完成→自动生成采购行草案（扩展现有 initDefaultProcurementItems，需求源=materials_bom）；fabric 行全 closed→提示完成 `materials_received_inspected` |
| SLA | `required_by` 从排期锚点倒推（lib/schedule.ts 体系）：开裁齐料=production_kickoff.due−3天缓冲 |
| 红黄绿灯 | 行级灯+订单聚合灯（最差行），复用现有色板语义 |
| 风险 | ① procurement_matters 物化；② 高危缺料发 runtime_events → 交付置信度扣分（fire-and-forget 钩子规范） |
| 责任人 | 行 owner=下单人；审批类归 procurement_manager；沿用 default-assignees+多角色；**价格字段不暴露给 production/merchandiser**（既有红线） |
| 日志 | procurement_logs 复制 milestone_logs 结构，全动作留痕 |
| 任务/通知 | 催货/验收进 daily_tasks（新 task_type）；升级走 notifications |

## 10. Production OS 联动（V2–V3，V1 只留结构）

- 三 kit：cutting/sewing/packing；`kit_rate=已验收量/需求量`；`kit_status=ready(≥98%且关键行accepted)/arriving/at_risk/missing`。
- **硬闸**：cutting_kit ∈ {at_risk,missing} → 禁止排入裁剪计划；**仅 admin 可 override**（PM 只能发起 request），强排留痕（谁/原因/风险/影响订单）。
- **软闸**：arriving 且余量<3天 → 允许排单标 `risk_schedule`，进 matters+置信度扣分。
- APS 输入视图 `aps_order_inputs`：earliest_cut_date / expected_full_kit / kit_status×3 / bottleneck_material / material_risk_level（V3 加交期预测 P50/P90）。
- 反向：排期变化（anchor_changed）→ 重算 required_by → 灯刷新 → 红行进催货队列。

## 11. V1 范围（2周，止血闭环）——逐项明确

**只做这 9 件**：
1. 采购行状态机（line_status + 转换规则 + procurement_logs）
2. 待下单队列
3. 待催货队列（催货留痕 + 升级）
4. 待验收队列
5. 到货验收（goods_receipts + 让步审批限 PM/admin）
6. 行级红黄绿灯（required_by 倒推）
7. 采购风险 matters（克隆 customer_matters：dry_run→人审→execute→nightly cron）
8. 价格快照（price_baseline + price_history 自动写入 + 页面标色提醒，不阻断）
9. factories 供应商字段扩展 + 双表合并落地（tracking 冻结只读）

**V1 明确不做**（只预留结构）：AI 全部能力 · buyer_scores/supplier_scores 复杂绩效 · 完整 APS 联动与排单闸门 · procurement_plans 计划层 · material_library · sourcing 找料流程 · 价格硬门禁 · 供应链中心改名。

## 12. 路线图

- **V1（2周）**：§11 止血闭环。验收：跟单全流程在系统操作；CEO 提前≥3天看到缺料风险；每笔采购价自动留痕。
- **V2（1个月）**：计划层+材料库+价格库分析+供应商评分+buyer_scores+找料流程+验收标准化+KPI报表+超价硬门禁+daily_tasks 接入。验收：业务不再帮找料；供应商首次月度评分；Helen 有价格抓手。
- **V3（3个月）**：AI 能力（价格异常→交期预测→催货草稿→推荐→日报，全部 PureSkill 契约进 trade-agent-skills）+ 外协/印洗/成衣并入 + 改名供应链中心 + APS 排单联动。

## 13. SaaS 分层（商业版）

Standard=V1 止血闭环；Pro=V2 管理层（评分/绩效/找料/审批/APS输入）；AI=V3 预测层。分层用单一 `PROCUREMENT_TIER` flag；引擎 `[SHARED]`、数据按"每客户独立 Supabase Project"物理隔离（既有商业版决策，无 tenant_id）；不写死人名/供应商名。

## 14. 实施纪律

- 所有 migration / 物化 / 数据迁移：**先 dry_run → 人审 → 再 execute**；
- 每步 `npm run build && npm run check`；push 前 fetch 核对 `HEAD..origin/main`（CLAUDE.md 规程）；
- tracking 冻结前先只读盘点在途行，出迁移/共存方案再动；
- 高危事件钩子 fire-and-forget，永不阻塞主链路。

---
*落档于 2026-06-12。V1 migration 草案与实施排期另行评审，未经确认不改代码。*

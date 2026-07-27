# 节点体系 V3 · 部门线 + 顺序审批流(2026-07-27)

> 承接 [Milestone-V2-Departments-Redesign.md](./Milestone-V2-Departments-Redesign.md)。
> CEO 2026-07-27 拍板方向:**每个部门有自己的节点 + 自己的完成权;上游部门节点完成才解锁下游(硬卡)。**
> 范围:整条链一次做。前置门禁:硬卡。模板版本化:V3 仅对新单生效,在途 V2/V1 订单不动。
>
> **✅ 决策已锁定(CEO 2026-07-27):整条链一次做 · 硬卡前置 · 拆成独立部门节点(纯部门线,15→18)。开始实施。**

## 一、问题(V2 现状)

V2 把跨部门审核做成**一个节点多方会签**(`milestone_confirmations` + `MILESTONE_CONFIRMATION_PARTIES`):
`po_confirmed` 要业务执行经理 + 财务同签、`final_qc_sales_check` 要 QC + 业务同签、`booking_done`/`shipment_execute` 带财务…

痛点(CEO 反馈):**节点挂在一个责任人名下,别的部门不点,逾期就一直压在责任人这里**,催不动就卡死。业务无法独立推进自己那部分。

## 二、核心原则(V3)

1. **单一归属 + 单一完成权**:每个节点只属一个部门,只有该部门(+admin)能完成。取消"多方同签一个节点"。
2. **跨部门 = 顺序节点 + 硬前置**:原来的"会签",拆成各部门各自的节点,用 `SEQUENTIAL_REQUIREMENTS`(现成、目前留空)做**硬前置**——上游节点没 done,下游节点点完成时被服务端硬拦。
3. **审批流 = 前置图**:权限=节点 owner;审批流=前置依赖。钱/风险的硬闸收编进节点图,不再散在各 action 里。
4. **每个部门有自己的线**:业务/财务/采购/生产/QC/物流各自看到"轮到我了"的节点,按进度推进,互不卡完成权。

## 三、全链节点图(V3 提案)

> 部门口径沿用 V2:业务执行=merchandiser/order_manager;财务=finance;采购=procurement;生产=production;QC=qc;物流=logistics。
> ⭐=关键节点(交付置信度引擎读 is_critical)。「硬前置」列 = 该节点点完成时,列出的上游节点必须已 done。

| # | step_key | 节点名 | 归属部门·完成权 | 硬前置 | ⭐ |
|---|---|---|---|---|---|
| 1 | `po_confirmed` | PO审查确认 | 业务执行 | — | ⭐ |
| 2 | `finance_approval` | 订单财务审核·预算录入 | **财务**(复活为独立节点) | po_confirmed | ⭐ |
| 3 | `pi_confirmed` | PI制作·客户确认 | 业务执行 | po_confirmed | ⭐ |
| 4 | `production_order_upload` | 生产单·原辅料单制作 | 业务执行 | pi_confirmed | |
| 5 | `order_kickoff_meeting` | 订单评审会 | 业务执行 | production_order_upload | ⭐ |
| 6 | `procurement_order_placed` | 采购核料提交·下单 | **采购** | finance_approval + order_kickoff_meeting | ⭐ |
| 7 | `pre_production_sample_sent` | 产前样寄出 | 业务执行 | procurement_order_placed | |
| 8 | `pps_procurement_check` | 产前样·大货原辅料品质核 | **采购**(拆自 V2 会签) | pre_production_sample_sent | |
| 9 | `pre_production_sample_approved` | 产前样·客户/业务确认 | 业务执行 | pps_procurement_check | ⭐ |
| 10 | `mid_qc_check` | 中期验货·QC | **QC**(拆自 V2) | pre_production_sample_approved | |
| 11 | `packing_method_confirmed` | 包装方式确认 | 业务执行 | mid_qc_check | |
| 12 | `final_qc_check` | 尾期验货·QC | **QC**(拆自 V2 会签) | packing_method_confirmed | ⭐ |
| 13 | `final_qc_sales_check` | 尾查·业务放行 | 业务执行 | final_qc_check | ⭐ |
| 14 | `shipping_sample_send` | 船样准备·寄出 | 业务执行 | final_qc_sales_check | |
| 15 | `ci_made` | PackingList·CI·报关单 | 业务执行 | final_qc_sales_check | ⭐ |
| 16 | `booking_done` | 订舱出货 | 业务执行(财务只喊停,不卡——见 §4) | ci_made | ⭐ |
| 17 | `shipment_execute` | 发货出运 | **物流**(财务放行硬闸——见 §4) | booking_done | ⭐ |
| 18 | `payment_received` | 收款完成 | 财务 | shipment_execute | ⭐ |

V2 的 15 节点 → V3 的 18 节点(新增/拆分:`finance_approval`、`pps_procurement_check`、`mid_qc_check`/`final_qc_check` 独立)。

## 四、与现有机制的收编(关键)

1. **`SEQUENTIAL_REQUIREMENTS`(app/actions/milestones.ts,现留空)** → 按上表「硬前置」列填满。这是硬卡的执行点(非 admin 缺前置 → `必须先完成前置节点`)。
2. **预算闸(今天临时改的 createPurchaseOrder 提醒)** → 收编为 #6 采购节点的硬前置 `finance_approval`。财务 `finance_approval` 节点完成即"预算已确认",采购节点自然解锁;`order_finance_events.budget.confirmed` 可继续作为财务系统回传的自动完成信号。
3. **财务放行闸(shipment_confirmations / allow_shipment)** → 保留,作为 #17 发货出运的**独立硬闸**(CEO 已拍板:发货必须财务放行 fail-closed)。#16 订舱:财务只喊停不卡(与既有决策一致)。⚠️ 需定:订舱/发货的财务动作走 shipment_confirmations 还是也做成 `finance_approval` 式节点?(见 §7)
4. **`MILESTONE_CONFIRMATION_PARTIES` / `milestone_confirmations`** → V3 节点不再多方会签,该表退役(保留历史数据;V2 在途单仍用)。软会签集合 `SOFT_CONFIRM_STEPS` 一并退役。

## 五、模板版本化

- 新增 `MILESTONE_TEMPLATE_V3`(18 节点),`lib/milestoneTemplate.ts`;路由:2026-07-27 之后新单用 V3,在途/历史用 V2/V1(单一真相,仅新单生效)。
- `is_critical` 按上表 ⭐ 物化到行(交付置信度引擎读行,不硬编码)。
- `pre-deploy-check` 增 V3 断言(18 节点/前置图完整/每节点单一 owner)。

## 六、实施改动清单(审图通过后)

1. `lib/milestoneTemplate.ts`:加 `MILESTONE_TEMPLATE_V3` + 路由。
2. `app/actions/milestones.ts`:`SEQUENTIAL_REQUIREMENTS` 按 §3 填满(硬前置)。
3. `lib/domain/confirmationParties.ts`:V3 节点退出会签(退役该机制,V2 保留)。
4. `lib/runtime/criticalNodes.ts`:补 V3 新 step_key 的关键判定。
5. `lib/production/stage.ts`:阶段信号 key 补 V3 新节点(避免 [[v1-v2-stepkey-drift]] 那种漏改)。
6. `lib/domain/schedule.ts` TIMELINE:补 V3 新节点排期锚点。
7. 采购:移除今天的临时预算提醒(收编进 #6 前置);发货财务放行闸保留。
8. `scripts/pre-deploy-check.ts`:V3 断言。
9. 各部门工作台:确保新节点在对应部门的"轮到我"视图可见(采购/生产/QC 中心)。

## 七、需 CEO 定稿的开放项

1. **节点归属/顺序**上表是否准确?(尤其:PI 确认 #3 与 财务审核 #2 是否可并行,还是必须财务先?图中设为二者都只前置 po_confirmed,即**并行**——业务做 PI 的同时财务审预算,互不等。)
2. **采购解锁条件** #6 前置设为 `finance_approval + order_kickoff_meeting`(财务预算 + 评审会都过)。是否只要财务过即可开采购,不必等评审会?
3. **订舱/发货的财务动作**:走现有 shipment_confirmations 放行闸(#16 喊停/#17 硬放),还是也拆成 `finance_approval` 式独立节点排进链里?
4. **产前样/验货拆分**是否过细?(#8 采购品质核 / #10 #12 QC 独立节点——若嫌节点太多,可保留为业务节点+部门在卡片旁"标记已核"的轻确认。)

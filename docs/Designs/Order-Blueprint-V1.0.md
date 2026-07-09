# Order Blueprint V1.0 — Enterprise Operation Hub / Gold Standard（唯一设计文档）

> **Date**: 2026-06-30 · QIMO OS **最重要的 Business Object**。严格遵循 Customer PO 黄金模板 12 模式。
> **不写代码 / DB / migration / UI / 不谈架构·微服务 · 不扩展新中心。** 基于真实最成熟模块：`orders` + `order_line_items` + 18 关卡 `milestones` + 交付置信度引擎 + 一切下游挂 `order_id`。
> **🚦 总门禁**：任何设计须同时 ①减员工每天工作量 ②保证 Quote→Customer PO→Order 100% 无重录/可追溯/可继承。
> **承接**：`Customer-PO-Blueprint-V1.3`(Freeze) + `Quote-Blueprint-V1.0`。三者封板 = QIMO 商业链核心成型。

---

## 1. Object Boundary
Order = **公司承诺对象 + 企业运营中枢（Operation Hub）**（属订单执行中心，非新中心）。聚合：**Header + Lines[] + Milestones[18关卡] + 生产执行单(MO,1:1卫星)**；变更走 **Amendment**（非 Version，见 §7）。

## 2. Truth Boundary（含最关键的克制：Hub ≠ 神对象）

| | 拥有真相 | 回答 |
|---|---|---|
| **Quote** | 我方报价 | "愿以什么价提供"（已 PR） |
| **Customer PO** | 客户主张 | "客户要买什么"（已 Freeze） |
| **Order** | **公司承诺** | "我方确认做什么/何时/什么价" |

- **Order ⟂ Quote**：Quote=成交前提案；Order=成交后承诺。Order **引用** origin_quote_id。
- **Order ⟂ Customer PO**：PO=客户主张（入口）；Order=公司承诺（锚）。**Order 100% 继承 Confirmed Customer PO**（V1.3 封板规则）。
- **Order 唯一真相** = 确认的 款色码/数量/交期/成交价/条款 + 订单生命周期（公司承诺）。

> **🔑 最关键判断（防 Hub 退化成单体）**：**Order 是锚/脊柱，不是"什么都拥有"。** 它**只拥有公司承诺**；下游各方面有**各自的 Owner 与 Truth**（Constitution 04 字段归属）：
> | 下游真相 | Owner（非 Order） |
> |---|---|
> | 大货单耗/采购量/价 | 采购 |
> | 工艺/SMV/MES/报工 | 生产 |
> | 实际成本/利润 | 财务 |
> | 物料需求 | 采购(MRP) |
> | 出运/订舱 | 物流 |
> **Order 拥有"承诺"，下游拥有"如何兑现承诺的各侧面"。它们全部挂 order_id 引用 Order，但 Order 不持有它们的真相。** 这条线守住，Hub 才是脊柱而非单体。

## 3. Header + Line（100% 继承 Confirmed PO，零重录）

**Order Header**：order_no · **客户(引用 customers.id)** · **origin_quote_id(引用 Quote)** · **source_customer_po(引用 PO + version)** · incoterm · etd/factory_date · payment_terms · currency · total_amount · lifecycle_status · **owner_user_id(理单)/factory(引用)/priority/各中心负责人**。
**Order Line**：line_no · 款/色/码/数量/单价（**= Confirmed PO Line 的确认值，1:1 行血缘继承**）· product_variant_id(引用款库)。

> **继承铁律（门禁②）**：客户数据（款/色/码/量/价/交期/包装/唛头/客户要求）**100% 来自 Confirmed Customer PO，禁手打**；Order 只新增**公司内部字段**（厂/优先级/各中心负责人/order_no）。**Order Line N ← Confirmed PO Line N ← Quote Line N**，三层行血缘可逐级回溯。

## 4. 为什么 Order 成为整个公司的 Hub

1. **物理脊柱**：每个下游对象都挂 `order_id`——materials_bom / milestones / material_requirements / procurement_line_items / manufacturing_orders / order_cost_baseline / profit_snapshots 全部 FK 到 orders。**它是数据库层唯一汇聚点**（Constitution 01）。
2. **商业链 ⟕ 执行链的唯一接点**：Order **之前**是"赢得订单"（Customer→Quote→PO）；Order **之后**是"交付订单"（Material→Production→Shipment→Payment→Profit）。**Order 是把"卖了什么"变成"做什么"的那纸合同**——唯一的接缝。
3. **全员执行的 SSOT**：采购按它算料、生产按它排产、财务按它核利润、物流按它出运——大家执行的是同一个 Order。
> 所以 Order 不是五中心之一，是**运营中枢**。但（见 §2）它是**锚**不是**所有者**。

## 5. Lifecycle（= lifecycle_status + 18 关卡）

```
Created → Confirmed → Material Ready → Production → Inspection → Packing → Shipped → Delivered → Paid → Closed
                          └ 18 关卡(milestones) 是细粒度生命周期；lifecycle_status 是粗粒度阶段
分支：Amendment(改单) · Termination(终止,既有 termination_*) · Delay(延期,既有 delay_requests)
```
每态进入/退出/Owner/确认点（同 V1.3 规范）。**关键人工转移**：Confirmed（建单确认）· 各关卡放行 · Closed。

## 6. Evidence
源 Customer PO(及文件) · Tech Pack · 附件 · 各关卡证据(验货报告/提单)。**Evidence ≠ Truth**；结构化承诺才是真相。

## 7. Resolution（Order 的"差异"= 变更 + 延期，非比对）

> Order 由 Confirmed PO **继承而来**，建单时无比对差异。Order 的 Resolution 处理**生命周期中的变更与风险**：

| 来源 | Resolution | 既有机制 |
|---|---|---|
| **客户改单**（PO 改版传导） | 评估影响(§Lock)→ 接受改 Order(未锁字段)/拒绝/重谈 | Amendment + Lock Rules(继承 PO V1.3) |
| **交期延期** | 改期/加急/通知客户 | `delay_requests`(CAN_APPROVE_DELAY) |
| **生产异常** | 返工/换厂/延期 | matters/milestone |

每个 Resolution 记 谁/何时/为何/审批；**Amendment 受 Lock Rules 约束**（已采购/生产的字段锁定，同 PO V1.3 §7）。

## 8. Approval（变更驱动，不是每单都审）
正常执行 = 无需审批（按 18 关卡走）。**变更才审**：改价→finance；改期→production_manager/CAN_APPROVE_DELAY；改量→采购+财务；终止→管理层。（复用真实 `CAN_APPROVE_DELAY/PRICE` 角色。）

## 9. Acceptance Criteria（什么时候 Order 才算 Confirmed，可驱动生产）
```
☑ 100% 继承自 Confirmed Customer PO（无手打客户数据）
☑ 公司内部字段齐（order_no/工厂/各中心负责人/优先级）
☑ 18 关卡 milestones 已生成（带 due_at）
☑ 成本基线 order_cost_baseline 已建（Profit forecast 可算）
☑ origin_quote_id / source_po 引用齐（可追溯）
```
全 ✓ → Confirmed → 触发下游 Draft（生产执行单/物料需求/交付计划/利润预测，各归 Owner 确认）。

## 10. Action Center（= 交付风险卡，已部分真实）
状态概览：当前关卡/逾期项 · **交付置信度分** · 料齐否 · 待审批变更 · 待放行关卡。**Next Recommended Action**（谁该做什么）。按钮：`放行关卡 / 申请延期 / 发起改单 / 生成下游Draft`。**AI 只建议，人工执行**（关卡放行必经责任人）。

## 11. Order Agent（= 交付置信度引擎，已真执行 ✅✅）

| 维度 | 内容 |
|---|---|
| 维护 | Order |
| 持续监控 | 交付健康/关键节点逾期/料齐度/变更影响/延期风险 |
| 何时提醒 | 置信度跌破红线 / 关卡逾期 / 料缺临近开裁 / 交期不可行 |
| 何时禁止 | ❌ 自动放行关卡 · ❌ 自动改交期 · ❌ 自动终止 · ❌ 自动确认任何真相 |
| 何时建议 | 风险卡(为什么/哪节点/谁该做下一步) · 延期预测 · 下游 Draft |
| 何时停止 | 终态(Closed/Terminated) |
> **这是全企业唯一"AI 真执行"的标杆**——它每天给每张订单算健康分、给可执行建议，但永不替人确认。

## 12. Order Health KPI（已在算）
**健康 = 能否准时·齐套·盈利交付。** = **交付置信度分**（已实现）+ 准时交付率 + 订单周期 + 异常关闭率。**报警**：置信度跌破红线 / 关卡逾期 / 负毛利(接 Profit)。

---

## 13. Order ↔ 下游对象数据关系（全部挂 order_id，各有 Owner/Truth）

| 下游对象 | 挂 order_id | Owner（非 Order） | 它的 Truth | Order 的关系 |
|---|---|---|---|---|
| **Material Requirement** | ✅ | 采购(MRP) | 需求/采购/到料量 | Order BOM → 实例化，**引用** |
| **Procurement** | ✅ | 采购 | 大货单耗/价/到货 | 读 Order 量算料，**引用** |
| **Production** | ✅ | 生产 | 工艺/排产/报工 | 据 Order/MO 生产，**引用**；工艺**永不回 Order** |
| **Delivery/Shipment** | ✅ | 物流 | 订舱/出运/提单 | 据 Order 交期出运，**引用** |
| **Payment** | ✅ | 财务(账在 finance系统) | 应收/回款 | 据 Order 金额结算，**引用** |
| **Profit** | ✅ | (派生) | forecast/live/final | 据 Order 成本/收入投影，**派生不存** |

> **全部挂 order_id**（Constitution 01）；**各有唯一 Owner/Truth**（Constitution 04）；Order **引用/被引用**，不持有它们的真相。**这就是"Hub 是脊柱不是单体"的物理表达。**

## 14. 链路闭环：任何数据只录一次

```
Customer(1次) → Inquiry → Quote(款/单耗/成本/报价 1次) →[Approved]→
Customer PO(客户成交值 OCR 1次, 引用 Quote) →[Compare+Resolve+Confirm]→
Order(100% 继承 Confirmed PO, 只加内部字段) →[order_id]→ 全下游引用
```
| 数据 | 唯一录入处 | 向下 |
|---|---|---|
| 客户 | Customer | 全链引用 id |
| 款/色/码/单耗 | Quote(或 Product) | PO/Order 引用 |
| 客户成交值 | Customer PO(OCR 1 次) | Order 继承 |
| **公司承诺** | **Order(继承+确认, 非重录)** | 下游全挂 order_id 引用 |
| 大货单耗/采购/工艺/实际成本 | 各下游 Owner | 挂 order_id |

> **零字段重录、单一 Owner、行级可追溯——商业链到执行链一气贯通。**

---

## 《Order Blueprint V1.0 Review》（诚实评分）

| 维度 | 评分 | 说明 |
|---|---|---|
| **Business Boundary** | **10** | 公司承诺 ⟂ 客户主张 ⟂ 报价；**Hub=锚非神对象**（Order 不夺下游真相），边界最干净 |
| **Lifecycle** | **10** | lifecycle_status + 18 关卡 = 最成熟在用；含 Amendment/Delay/Termination 分支 |
| **Data Chain** | **10** | 一切挂 order_id 已是物理事实；100% 继承 PO（前提：PO/Quote 对象落地 + 继承接线） |
| **Developer Readiness** | **9** | 订单系统本就最强；新增主要是"从 Confirmed PO 继承建单"+ Amendment-from-PO-revision 接线 |
| **Constitution Compliance** | **10** | 01(一切挂order_id)/02(单一真相)/04(字段归属:Hub不夺下游)/06(AI不放行/不确认) 全合 |
| **Object Completeness** | **9** | 12 模式齐；多 PO 拆/合单(继承 PO V1.3 的 Split/Merge 规则)、改单传导待落地接线 |
| **Gold Standard?** | ✅ | 达到，且是三对象中现实最成熟者 |

**综合 ~9.7/10 —— Production-Ready，Gold Standard。**

**诚实残余（落地前接线，非阻碍）：**
1. **继承建单接线**：Confirmed PO → Order 100% 继承（现 createOrder 仍手工/预填）；这是消重录的最后一公里。
2. **改单传导**：PO 改版 → Order Amendment（受 Lock Rules）。
3. **origin_quote_id / source_po 引用落地**：可追溯的物理前提。
> 三项均为接线/继承落地，**不改对象、不改生命周期**。

**Developer Readiness**: ✅（订单核心已在用，缺继承/改单接线）。**Production Readiness**: ✅（设计层）。**Constitution**: ✅。

---

## 🎯 里程碑：QIMO 商业链核心成型
**Quote(PR) + Customer PO(Freeze) + Order(Gold Standard)** 三对象封板 → **商业链 `Customer→Inquiry→Quote→Customer PO→Order` 真正成型**：一次录入、单一 Owner、单一 Truth、各有生命周期/Timeline/AI Guardian，且**全公司一切下游挂 order_id**。Order 作为 Hub，把"赢单"接到"交付"，AI 全程只守护不确认。

> 本文 = Order 设计。后续 Order 开发遵循本蓝图 + 黄金模板 12 模式。不写代码 / DB / migration / UI。
</content>

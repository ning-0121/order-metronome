# 采购执行流设计 — Procurement Execution Flow（采购单 · 供应商主数据 · 分权 · 财务同步）

> **Date**: 2026-07-01 · **Design 层**(阶段实施方案)。补 `docs/Domains/Procurement.md v2.1` 的"怎么买/谁审/谁看/买完的账"一半;不覆盖 v2.1 的 Material Requirement/MRP/Snapshot/Brain(那是"要什么"脊柱)。
> **铁律**:Evolution not Rewrite · One Order 为轴 · 卡风险不走流程 · 系统计算·人决策 · 采购成本真相一处(不双轨)。**不写代码 / migration / DB。**

---

## 0. 轴与两个 PO（钉死,防混淆）
- **轴 = Order**(源自 `customer_po`;Business Chain Contract:一切挂 `order_id`)。
- **Customer PO**(`customer_po`,客户→我方)≠ **采购单/Purchase Order**(我方→供应商)。本文只设计后者。
- 采购挂在 Order 的**物料需求行**之上(需求脊柱见 v2.1;P1 可先直接挂 order+物料,requirement 接线放 P3)。

## 1. 修正后的采购主线
```
Order → 业务冻结物料快照 → 物料需求行(MRP,v2.1)
  → 采购整理/跨订单合并(采购部) → 采购单草稿(头+行,引用需求+供应商)
  → 风险驱动审批(采购经理 / 财务,仅异常) → 下单 → 导出给供应商
  → 供应商确认交期 → 到货/验收(回填需求) → 结案
  → 尾货统计 + 采购成本核算 → 喂利润 / 复用池
```
**流程修正要点**:① 业务拥有"要什么"(需求/快照),不碰采购价/供应商决策 ② "合并"= 跨订单同物料净需求(省钱)③ 下单审核 = **差异/风险驱动,不是每单必审** ④ 采购审批(买得对不对)与财务审批(付得起/账期)分离。

## 2. 新增对象(过对象准入双门禁)
### Supplier Master 供应商主数据（新表 · 反转 2026-06-13「不新建 suppliers」决策）
- **拆独立 `suppliers` 表**(分叉1=B):原辅料供应商 ≠ 成衣工厂;`factories` 从此只做生产工厂,不再当供应商。旧 `procurement_line_items.supplier_id→factories` 保留 legacy 不迁(清理放 P2),新采购单供应商归宿 = `suppliers`。
- **字段级分工(用户拍板)**:业务填 `name/address/phone/contact_name/main_category`;财务填 `payment_method/net_days/bank_info/tax_id`。字段级编辑权在 action 层强制。
- **单一真相=suppliers**;`supplier_id` 共享财务/生产/仓库**引用**,不重录;P2 经契约同步财务。

### 采购单 Purchase Order（头+行,新头 + 演进现有行）
- **头 `purchase_orders`**(新):`po_no / supplier_id / order_ids[](可跨订单) / status / 币种·总额 / 付款条款·交期 / 审批信息 / created_by`。
- **行**:演进现有 `procurement_line_items`(+`purchase_order_id` +`supplier_id` +价格分级),不新造。
- 行引用 `requirement_id`(要什么,P3 接)+ `supplier_id`(向谁买)。

## 3. 采购单生命周期
`draft(整理/合并)` → `pending_approval(仅风险触发)` → `approved` → `placed(下单)` → `exported` → `confirmed(供应商确认交期)` → `receiving` → `received/QC` → `closed`。

## 4. 审批模型（差异/风险驱动 —— 灵魂）
| 情形 | 审批 |
|---|---|
| 标准供应商 + 价正常 + 预算内 + 标准账期 | **采购自定**(快路径,零审批) |
| 价格异常 / 超预算 | 采购经理 + 财务 |
| 新供应商 / 非标账期 / 大额 | 采购经理(+财务对账期·信用) |
| 交期风险(order-by 已过) | 采购经理 + 提示生产跟单 |
> 无差异=不审批(护效率)。复用现有 `price_approval` 机制。

## 5. 字段分权可见（三层）
| 角色 | 能进 | 可见 | **隐藏** |
|---|---|---|---|
| 业务 | 只读 | 采购进度/料齐/到货 · **采购建议价** | ❗**大货采购底价**(实际谈价) |
| 采购 | 全 | 建议价 + 底价 + 全流程 | — |
| 财务 | 采购单/供应商 | 价/账期/付款/对账 | 不改采购进度 |
| 生产跟单 | 只读 | 料齐/到货/交期 | 采购价 |
| 仓库 | 收货 | 到货量/批次 | 价 |
> **关键规则(用户拍板)**:两个价**复用现有列**(不加新列)—— `price_baseline`(采购建议价,业务可见)vs `unit_price`(大货采购底价,采购/财务 only)。read action 层剥离 `unit_price` 给业务角色,非 UI 隐藏。

## 6. 财务同步（供应商 + 采购单 → 财务系统）
沿用三仓库契约模式(共享 ID + Contract API,不共库):
- Supplier → `supplier_id` + 账期/付款/银行/税号经契约同步 → 财务建应付主体。
- 采购单下单/收货 → 金额/账期事件 → 财务生成应付/付款计划(finance 侧自 repo 实现 accept)。
- 财务引用 `supplier_id`/`po_no`,不重录;成本/付款真相归财务。

## 7. 尾货 + 成本核算（订单完成后）
- 尾货 = 采购确认量 − 实际消耗(领料回填) → 余料池 → 下单时 MRP 扣减复用。
- 成本核算 = 采购单行实际成本 vs `order_cost_baseline` → 差异 → 喂 profit forecast(不双轨)。

## 8. AI 辅助 + 校正（复用 AI Supply Brain,不新引擎）
建议供应商/价 · 跨订单合并建议 · 断料预警(order_by_date)· **价格异常校正** · 尾货复用建议 · 供应商履约评分。**AI 只建议,人决策。**

## 9. 落地切片（别一次全做）
| 切片 | 内容 |
|---|---|
| **P1（先做）** | Supplier Master(建供应商)+ 采购单头对象(合并 line_items 成单)+ 导出 + **字段分权(建议价/底价)** |
| P2 | 风险驱动审批(采购经理/财务)+ 财务同步(supplier + 采购单) |
| P3 | 跨订单合并(netting)+ 需求行接线(依赖 v2.1 B0-B1) |
| P4 | 尾货统计 + 成本核算回流利润 |
| P5 | AI Supply Brain 决策卡 |
> `requirement` 脊柱(v2.1)可与 P1 并行;P1 采购单先挂 order+物料,`requirement_id` 放 P3,不阻塞采购先用。

---
> 每切片:设计→确认→build/check→diff→批准→push;migration 手动执行 + DB 门禁。本文 = 设计,不写代码。

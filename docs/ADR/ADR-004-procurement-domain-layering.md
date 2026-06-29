# ADR-004 — Procurement Domain 分层与核料原则

**Status**: Accepted (2026-06-29) · 第一阶段已由 P1′ 验证(`docs/Designs/P1.md`,commit 86b3455)

## Context
重新规划采购域时发现:**我们一直站在"程序员视角"(逐 BOM 行)设计采购,而不是"采购经理视角"(归并后的物料)。**
- 采购每天第一件事**不是下 PO,是核料**(Material Consolidation):把同物料+同颜色的需求合并成一个总量,再决定怎么买。
- 采购管的是**物料**,不是产品/BOM 行。订单里 Legging/Bra/Short 都用 N75/SP25 Black,采购看到的是**一个物料 + 总需求 + 来源明细 + 最终采购方案**。
- `materials_bom.qty_per_piece` 是**开发单耗**(打样得出);真正采购必须用**大货单耗**(排料/缩率),二者不同。
- 若不把"核料 + 大货单耗"设计进系统,采购会一直回到 Excel 手工加总,系统价值落空。

## Decision
确立 Procurement Domain 分层与核料原则(10 条):

1. **采购域核心对象 = Procurement Item(采购核料项)**,不是 PO、不是供应商、不是到料。
2. **采购按归并后的物料工作,不按 BOM 行工作。**
3. **Material Package**(`materials_bom`)**属业务** —— 记录客户需求与**开发单耗**;不能改采购信息。
4. **Material Requirement**(`material_requirements`)**属系统** —— 记录系统计算需求(可重算投影);人不直接编辑。
5. **Procurement Item**(`procurement_items`)**属采购** —— 记录归并/核料、**大货单耗**、供应商、价格、**最终采购量**、决策、状态。
6. **Purchase Order**(`procurement_line_items`)**属采购执行** —— 记录下单与到料。
7. **Receiving / Warehouse 属仓库**。
8. **大货单耗 `production_consumption` 属采购,不属于业务**(业务只负责开发单耗)。
9. **系统负责自动归并和计算,采购负责确认**(`suggested_purchase_qty` 系统算,`final_purchase_qty` 采购拍)。
10. **不允许采购回到 Excel 手工加总** —— 归并是系统职责。

### 分层与所有权
```
Customer Order
 └ Material Package(业务:开发单耗)
   └ Material Requirement(系统:MRP 需求,可重算)
     └ Procurement Item(采购:核料归并 + 大货单耗 + 供应商/价/决策/最终采购量)
       └ Purchase Order(采购执行:下单 + 到料)
         └ Receiving / Warehouse(仓库)
```
**四层不混,只能引用,不能复制**:Procurement Item 锚稳定物料身份(`order_id + 物料身份 + 颜色 + 单位`),引用 Material Requirement 的需求量(live,不复制),需求重算只标 `needs_reconfirm`,不丢采购确认。

## Consequences
- ✅ 采购告别 Excel 手工加总;系统按物料自动归并。
- ✅ 开发单耗(业务)与大货单耗(采购)职责分明,采购量系统自动算。
- ✅ 四层职责清晰,为 P2(Purchase Order)/P3(Receiving)/P4(Supplier Master)/P5(跨订单核料)留好位置,3-5 年不推翻。
- ✅ 不改 B1/material_requirements(只读引用),不影响线上。
- ⏭ 本 ADR 验证多阶段稳定后,"四层不混 + 核料归并"可考虑升级进 Constitution(现按修宪纪律留在 ADR)。

关联:`docs/Designs/P1.md`(P1′ 实现)· Constitution 02/03/04。

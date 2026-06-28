# ADR-002 — Material Requirement 为跨域脊柱 + Explainable 时间分段 MRP

**Status**: Accepted (2026-06-28),已实现(B0/B1 上线)

## Context
采购/仓库/生产/出运都需要"物料需求"作为协作锚点。若各域各自维护一份需求 → 数据漂移(违反 Constitution 02)。MRP 若只算"买多少"不算"何时下单",无法驱动交付风险。

## Decision
- 脊柱下沉到 **Material Requirement 行**:`Order → material_package_snapshots(不可变快照/ECM)→ material_plans(1:1)→ material_requirements(逐物料行)`。
- MRP = **可重算投影**(仿 runtime/deliveryConfidence):量(gross/loss/inventory/reuse/net)+ 时间(required_stage / required_date / supplier_lead_days / order_by_date)+ `explain_json`。纯函数 `lib/services/mrp.ts`,30 项单测入 npm check。
- 物料包提交即冻 Snapshot;下游引用同一快照,改需修订审批,不自动切。
- 数据来源现有表(materials_bom / order_cost_baseline / milestones),不双轨。

## Consequences
- ✅ 一份需求,全域消费(Constitution 02)。
- ✅ MRP 可解释 + 时间分段,驱动"料齐放行"。
- ✅ B1 不生成 procurement_line_items(查看=B2,执行=B3),边界清晰。
- 关联:`Domains/Procurement.md`、`Designs/B1.md`。

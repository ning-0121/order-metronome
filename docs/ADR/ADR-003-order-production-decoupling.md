# ADR-003 — Order Domain ⊥ Production Domain(经 Manufacturing Order 解耦)

**Status**: Accepted (2026-06-28) → **已升级为 Constitution 07 + 08**

## Context
传统 ERP 的订单系统不断吸收工艺职责(SMV/IE/MES/工艺路线/吊挂),最终膨胀成复杂 PLM(Gerber/Lectra/Centric),业务难维护、AI 难理解。QIMO OS 必须避免"煮沸海洋"。

## Decision
- **Order Domain 只表达需求**,**Production Domain 实现需求**,两域通过 **Manufacturing Order(生产任务单,原 "Production Package" 改名)** 解耦。
- Manufacturing Order 只含:产品/数量/颜色/尺码/包装/印绣/QC重点/特殊要求/风险/交期/附件。**绝不含** 工艺路线/工序/SMV/IE/工位/吊挂/机器/SOP/MES。
- 订单中心导航固定三模块:客户订单 / 原辅料包 / 生产任务单;采购/生产/仓储中心只消费,不维护第二份。

## Consequences
- ✅ 订单中心永不膨胀成 PLM;未来扩 MES/IE/APS/吊挂不污染订单域。
- ✅ 已验证长期成立 → **升级进 Constitution 07(MO 定义)+ 08(域职责)**。
- 关联:`Domains/Order.md §0.1`、`Designs/O2.md`(Manufacturing Order 录入)。

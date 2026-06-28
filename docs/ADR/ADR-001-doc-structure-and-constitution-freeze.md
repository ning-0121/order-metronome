# ADR-001 — 文档四层体系 + Constitution V1.0 冻结

**Status**: Accepted (2026-06-28)

## Context
随着 QIMO OS 演进,架构原则在多份文档里累积(qimo-os-architecture.md §0、order-domain-v3.0.md §0/§0.1),宪法越写越长。很多系统失败正是因为"宪法越来越长,最后没人遵守"。需要把"几乎不变的最高原则"与"变化快的设计/决策"分层。

## Decision
1. **Constitution 永远 ≤ 10 条**,冻结为 V1.0(见 `00-Constitution/Constitution.md`)。
2. 文档固定**四层**:`00-Constitution / ADR / Domains / Designs`(见 `00-Constitution/README.md`)。
3. **修宪纪律**:新原则不得直接进 Constitution,必须先进 ADR,经多阶段验证后才升级。开发纪律写入 `CLAUDE.md`。
4. 迁移核心架构文档:order-domain-v3.0 → `Domains/Order.md`;supply-chain-v2.1 → `Domains/Procurement.md`;O1/O1a/B1/供应链草案/采购流 → `Designs/`。legacy 运营/审计/手册类文档保留原位,渐进迁移。

## Consequences
- ✅ Constitution 稳定、可被真正遵守;变化沉淀到 ADR/Domain/Design。
- ✅ 每份新文档有明确归属。
- ⚠️ 旧文档内部交叉引用路径可能短暂滞后(逐步修);记忆指针已更新。
- ⚠️ `qimo-os-architecture.md §0` 宪法部分被 Constitution.md 取代(已加 banner),其余(资产盘点/路线)仍有效。

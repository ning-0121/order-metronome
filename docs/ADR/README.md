# ADR — Architecture Decision Records

记录**重要架构决策**(为什么这么定)。经常新增。经多阶段验证、确认长期成立的,才升级进 `00-Constitution/Constitution.md`。

格式(每条 ADR):`Status / Context / Decision / Consequences`。

| ADR | 标题 | 状态 |
|---|---|---|
| [ADR-001](ADR-001-doc-structure-and-constitution-freeze.md) | 文档四层体系 + Constitution V1.0 冻结 | Accepted |
| [ADR-002](ADR-002-material-requirement-spine.md) | Material Requirement 为跨域脊柱 + Explainable 时间分段 MRP | Accepted |
| [ADR-003](ADR-003-order-production-decoupling.md) | Order Domain ⊥ Production Domain(经 Manufacturing Order 解耦)| Accepted(已升级为 Constitution 07/08) |
| [ADR-004](ADR-004-procurement-domain-layering.md) | Procurement Domain 分层与核料原则(Procurement Item 采购核料项 / 开发单耗≠大货单耗 / 系统归并采购确认)| Accepted(P1′ 验证) |
| [ADR-005](ADR-005-deterministic-kernel-single-compute.md) | 确定性内核:单域单算法,SQL 不做计算 | Accepted |
| [ADR-006](ADR-006-data-access-layering-ratchet.md) | 数据访问分层与直连棘轮(存量入基线 / 新增 fail / 只 repository·adapter·migration·白名单 infra 可直连)| Accepted |
| [ADR-007](ADR-007-internal-command-vs-public-server-action.md) | 内部特权编排走 internal command,不走公开 Server Action(Symbol 方案是过渡态不是范例)| Accepted |
| [ADR-008](ADR-008-migration-governance.md) | MIGRATION-GOV-001:生产迁移是显式部署产物(APPROVED.json 批准清单 + db:migrate preflight all-or-nothing);branch isolation ≠ migration isolation | Accepted |

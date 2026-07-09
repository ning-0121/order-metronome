# QIMO OS — Enterprise Integration（跨仓库企业集成）

> **Status**: 🟡 审计 + 集成设计（纯设计，不写代码 / 不写 migration / 不改库 / 不提交 / 不 push）。**Evolution NOT Rewrite**。
> **Date**: 2026-06-29。范围：QIMO OS · finance-system · clients-Hunters-OS（araos）。`growth-os` 暂不纳入（待定）。

## 核心结论
三个仓库不是重复造系统，而是**一条企业价值链的三个阶段**，被脆弱的"名字字符串"胶水连着：
- **ARAOS（clients-Hunters）= 获客前端** · `hpdcqjf…`
- **QIMO OS = 订单/生产编排核心（宿主）** · `scrtebex…`
- **finance-system = 钱的真相** · `qpoboel…`

三个**独立 Supabase** → 集成靠**身份脊柱（共享 Customer/Order/Quote ID）+ 契约 API/事件**，**不合库、不跨库 FK、不 Rewrite**。

## 四份文档
| # | 文档 | 内容（对应审计步骤） |
|---|---|---|
| 1 | [01-Enterprise-Integration-Audit](01-Enterprise-Integration-Audit.md) | Repository Audit + Cross-Repo Object Audit + Relationship（步骤 1/2/3） |
| 2 | [02-Repository-Integration-Map](02-Repository-Integration-Map.md) | 每仓库保留/迁移/独立/UI/DB 处置（步骤 4） |
| 3 | [03-Cross-Repository-Object-Map](03-Cross-Repository-Object-Map.md) | 企业域映射 + 跨库表 Owner/SoT/Consumers + 身份脊柱（步骤 5/7） |
| 4 | [04-Enterprise-Integration-Roadmap](04-Enterprise-Integration-Roadmap.md) | Phase 0–5 路线（步骤 6，含对原排法的挑战） |

## 三个最关键的现状缺陷（集成要解决的）
1. **无共享身份键** → 客户/订单/报价在三处各存一份、靠 name 匹配（重复与脆弱的总根源）。
2. **finance 直连 QIMO 库**（`METRONOME_SUPABASE_SERVICE_KEY` 读 orders 表）→ 最危险耦合，Phase 0 拆。
3. **ARAOS→QIMO 赢单桥已建但关闭**（`METRONOME_WEBHOOK_URL` 未设）→ 赢单死在 `metronome_handoffs='pending'`，Phase 1 打开。
</content>

# QIMO OS 修复路线图

| 阶段 | Owner | 范围 | 依赖 | 估时 | 业务价值 | 主要风险 | 验收与部署 |
|---|---|---|---|---|---|---|---|
| Phase 0（1–3 天） | Order + Security + Finance | 冻结公开敏感附件上传；修 Finance date-only；建单/收货人工对账与告警；发布 SOT-004 | CEO 批准 bucket/Production | 1–3 天 | 阻断泄露、日期错误和静默失联 | 数据迁移、主链变更 | 单项 PR、Preview、只读核验、可回滚 Production |
| Phase 1（1–2 周） | Platform + 模块 Owner | order-create transaction；receipt outbox；QC→shipment gate；跨系统持久幂等 | schema/RPC 评审 | 7–10 人日 | 打通关键端到端连续性 | 锁、历史兼容 | 故障注入、重复事件、全链 Golden Order |
| Phase 2（2–4 周） | Ops Product | 角色工作台、异常中心、统一状态/责任/下一动作 | Phase 1 contracts | 10–20 人日 | 降低漏单、无人负责 | 角色边界歧义 | 每角色队列、SLA、员工验收、灰度 |
| Phase 3（3–6 周） | AI Platform + Security | Finance/Order provider 旁路迁移；Agent RBAC、tool gate、成本/trace | Runtime registry | 15–25 人日 | 可控 AI 成本与风险 | 行为回归 | mock 授权、provider metadata、零自主财务写入 |
| Phase 4（后续） | Architecture | 多租户隔离、统一合同版本、商业化审计与灾备 | 前三阶段稳定 | 另行估算 | 商业扩展与合规 | 大范围迁移 | 独立环境、租户隔离和灾备演练 |

## 30 天执行顺序

角色责任纠偏优先插入 Phase 1：评审并应用 additive `order_responsibilities`；先以 `orders.owner_user_id` 兼容派生 Business Execution owner，再让新交接/定厂/排产/指派写入并行 responsibility。禁止历史批量回填，旧单仅在人工变更责任时进入新模型。

1. 48 小时内处理 SEC-003 和 FIN-007，并为 ORD-001/PROC-002 增加运营对账。
2. 第 1 周完成订单创建事务设计、收货 outbox schema 与 QC release gate RFC。
3. 第 2 周分别上线订单事务和采购 outbox，禁止合并成一个不可回滚发布。
4. 第 3 周上线异常责任队列与 KPI 统一 predicate。
5. 第 4 周迁移最高风险 Agent 入口和 Finance Anthropic 直连，执行 Golden Order 全链回归。

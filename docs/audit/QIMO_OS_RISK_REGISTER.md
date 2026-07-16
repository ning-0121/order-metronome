# QIMO OS 风险登记册（2026-07-16）

严重度按 P0–P3；证据均来自当前 `origin/main` 或 Finance `main` 的代码与本轮测试。

| ID | 级别 | 模块 | 业务影响 | 证据/位置 | 实际与期望 | 建议与复杂度 | 回归门禁 / 发布风险 |
|---|---|---|---|---|---|---|---|
| ORD-001 | P0 | 建单 | 可产生有订单头、无明细或下游初始化不完整的订单 | `app/actions/orders.ts`：明细、BOM、Finance 后续失败仅记录并继续 | 实际为分段写入；期望原子创建或可恢复 outbox | 建立事务 RPC + 幂等键 + 补偿状态；L | 故障注入验证全回滚；改动交易主链，高风险 |
| PROC-002 | P0 | 采购/库存 | 收货成功但库存、齐套、Finance 同步失败，可能重复采购或错误开裁 | `app/actions/procurement.ts` 多条收货路径将后续失败标记“不阻断” | 实际允许跨域失联；期望持久 outbox 与可重放状态 | 收货事务写 outbox，消费者幂等；L | 模拟每一步失败及重放；高风险 |
| SEC-003 | P0 | 附件 | 物流凭证、BOM/采购附件可能通过公开 URL 被未授权读取 | `20260702_s1_1_product_images_bucket.sql` 将 bucket 设为 public；`LogisticsSubtaskChecklist.tsx` 使用它 | 实际由 URL 公开；期望私有 bucket、授权签名 URL | 新私有 bucket、对象迁移、短期签名 URL；L | 未授权 URL 必须 403；需迁移和 CEO 批准 |
| SOT-004 | P1 | PO/订单真相 | 冻结快照可被覆盖，生产单曾直接读取 AI 快照 | `app/actions/po-parser.ts`、`manufacturing-order.ts`；本分支 `8dd50d6` 已修复 | Production 仍可能存在该风险；期望快照只预填 | 发布已测试兼容修复；M | snapshot/order truth tests；低至中风险 |
| RBAC-005 | P1 | 权限 | 未识别角色会静默映射为 sales，可能错误分配任务 | `lib/domain/roles.ts::normalizeRoleToDb` | 实际 fail-open；期望拒绝未知角色 | 改为 Result/显式错误并清理调用方；M | 未知角色不得产生节点；中风险 |
| QC-006 | P1 | QC/物流 | QC 失败到出货冻结缺少单一、可证明的服务器门禁 | 状态分散于 milestone、dispatch、report 和 UI | 实际链路难以证明；期望服务器端 release gate | 建立 shipment-release policy service；L | QC fail/reinspect/release E2E；高风险 |
| FIN-007 | P1 | Finance | 结算发票日期跨时区减一天 | Finance `export-settlement-invoice.test.ts`：期望 03-20、实际 03-19 | 实际受时区转换；期望业务日期不漂移 | 使用 date-only 解析/格式化；S | 当前 36/37，修复后 37/37；低风险 |
| FIN-008 | P1 | Finance Agent | `/api/agents/run` 仅验证登录，未证明 Finance/Admin 角色 | Finance `src/app/api/agents/run/route.ts` | 实际认证范围过宽；期望最小角色 + 工具门禁 | 增加 RBAC 与审批策略；M | 非财务角色 403；中风险 |
| INT-009 | P1 | 跨系统 | Serverless 内存幂等不能提供全局一次性保证 | Finance 集成路径的进程内 map 与异步回调 | 实际冷启动可重复；期望持久幂等记录 | 统一 event_id/outbox/inbox 唯一约束；L | 重复 webhook 只产生一次业务结果；中高风险 |
| AI-010 | P1 | AI | Order 仍有 18 个审计登记的 Provider 旁路，Finance 有直接 Anthropic SDK | Provider gate 输出；Finance document-engine/API | 实际治理不完整；期望统一 Runtime、明确实际 provider | 分批迁移，不改业务契约；L | boundary count 单调下降；中风险 |
| STATE-011 | P1 | 工作流 | 状态与责任定义分散，存在无 owner、重复节点风险 | milestones、dispatch、workbench、各模块 status 常量 | 实际多个真相；期望注册表 + transition service | 先统一状态字典和不变量；L | reachable/owner/idempotency tests；高风险 |
| KPI-012 | P2 | Analytics | 取消/测试/贸易单、时区及“避免损失”口径不统一 | 多个 dashboard/analytics 查询 | 实际同名 KPI 口径不同；期望版本化定义 | 落实 KPI register 和共享 predicates；M | 固定数据集跨页面一致；中风险 |
| UX-013 | P2 | 操作恢复 | 部分失败只 toast/log，异常未进入有 owner 的队列 | 多处 server action/UI catch | 实际需人工发现；期望 actionable exception queue | 统一安全错误分类与责任人；M | 故障均生成下一动作；低风险 |
| DEBT-014 | P3 | 工程 | 旧文件存在大量 `any`，Next metadata/middleware 警告 | scoped lint 197 errors/18 warnings；build warnings | 实际构建通过但类型边界弱 | 按模块偿债，不阻塞业务热修；M | 新代码零新增 lint debt；低风险 |
| ROLE-015 | P1 | 角色/工作流 | 单一 `orders.owner_user_id` + 节点 owner 无法完整表达业务执行、生产主管、生产跟单/QC、物流并行责任 | orders/milestones schema；生产跟单从节点推导 | 实际容易在指派时替换责任或提前结束；期望 additive responsibility truth | 新增 `order_responsibilities`，不回填历史；M | handoff/assignment/shipment owner invariants；需 migration 审批 |
| ROLE-016 | P1 | RBAC | 未知/空角色静默降级为 sales | `lib/domain/roles.ts::normalizeRoleToDb` | 实际 fail-open；期望拒绝未知角色 | 本分支已改为 throw/fail closed；S | unknown-role regression；低风险 |

## 立即控制

- 在 ORD-001、PROC-002 修复前，对建单与收货采用人工对账清单，不把“页面成功”视为跨模块完成。
- 在 SEC-003 修复前，不再向公开 `product-images` 上传新的敏感物流、采购或 QC 凭证；现有 URL 不应外发。
- Finance Agent 保持建议/草稿模式；财务过账、付款和审批必须由认证员工完成。
- 不以 Preview live test 写共享 Production Supabase；仅使用 mock 或经批准 TEST 数据。

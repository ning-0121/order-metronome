<!-- 2026-07-13 角色审计·财务/审批闭环簇 交接清单。来源:qimo-role-journey-audit(49 agent)。 -->

# 财务 / 审批闭环簇 —— 待办交接清单

> 来源:2026-07-12/13 角色视角审计(9 角色 + 4 横切)。本簇 = 「财务收到审批 / 审批闭环 / 多系统账目准确性」相关的确认发现。
> **为何交接不直接做**:①并行窗口正深度重修 `app/api/integration/finance-callback/route.ts`(order_finance_events 恒 0 的三重根因:qimo_order_id 空 / insert 约束 / event_type)——本簇多条就在该文件,避免改同一文件打架;②财务 repo(`~/Projects/财务系统`)有另一会话的未提交 WIP。**按并行会话卫生纪律,等这两处落定再接。**

## 已修(不在待办,存档参考)
| 条 | commit | 说明 |
|---|---|---|
| 出货发票缺 exchange_rate | `038b223` | 节拍器补发订单锁汇率(order_cost_baseline.exchange_rate);财务侧本就读 `data.exchange_rate`(webhook route.ts:734),无需改 |
| 价格审批权限口径打架(待审批中心) | `1e7adb2` | pending-approvals.service.ts 对齐 CAN_APPROVE_PRICE=admin/sales_manager |
| 内部 approvePurchaseOrder 架空外部审批 | `a911da6` | finance-scope 单禁走内部审批 + 隐死按钮 |
| 台账 LG vs 对账 PR/DP 重复付款(**根因**) | `3b01255` | 面料归台账 LG 独占,系统PO对账排除面料行 → 同批面料只一条渠道推财务 |
| 改单幽灵单 / 出运三方确认漏应收 / 退货双减 | `9de407b`/`775ee43` 等 | 见 audit-2026-07-12-role-journey 记忆 |

---

## 待办(open)

### A. 节拍器侧 · `finance-callback/route.ts`(⚠️ 并行窗口正改此文件,等它收完再接)

**A1 · P2 · 价格审批回传不通知申请业务员**
- 位置:`app/api/integration/finance-callback/route.ts:150`(price 分支)
- 场景:财务在财务系统批准价格审批 → 回传 finance-callback。price 分支只 `update pre_order_price_approvals.status`,**不向 requested_by 发 notifications/企微**(对比本地 approvePriceApproval:146-159 会发)。业务员离开建单表单后零感知,订单迟迟不建。
- 修:price 分支 update 成功后,按 `pre_order_price_approvals.requested_by` 补发 notifications(type=price_approval)+企微,与本地 approvePriceApproval 同口径。

**A2 · P2 · 财务部分付款回传即标全额已付**
- 位置:`app/api/integration/finance-callback/route.ts`(applyProcurementPayment)
- 场景:收到 `payment.completed` 无条件把 `procurement_payment_requests.status='paid'`。财务对同一 source_ref 分两笔部分付,第一笔回传后即显示「已付」(paid_amount 只累加一半)。
- 修:仅当 `paid_amount + amount ≥ pr.amount` 才置 `paid`,否则 `partial`/保持 submitted。

**A3 · P3 · 同 source_ref 同金额分批付款被幂等键去重、漏记一期**
- 位置:同上 finance-callback(去重键 = order_finance_events.request_id;财务 client.ts:66 detId=[source_ref,amount,currency])
- 场景:同一付款申请分两笔、且金额+币种恰好相同(定金/尾款各半)→ 两次 request_id 完全一致 → 第二笔当重放丢弃 → 对账 paid_amount 少记一期。
- 修:回传幂等键并入财务侧付款执行行 id(batch_line.id),不只 source_ref+amount;applyProcurementPayment 按累计 paid_amount vs net_payable 定 status。
- 注:A2/A3 同源,建议一起改。

### B. 节拍器侧 · 其它文件(可独立做,不撞 finance-callback)

**B1 · P2 · settlement 回传 qimo_order_id 给 araos(订单级ID断链)**
- 位置:`app/actions/araos-po.ts`(buildOrderFromAraosPO 建单成功后)
- 场景:araos 赢单交接只回 qimo_customer_id,从不回 qimo_order_id → araos 侧 `orders.qimo_order_id` 恒 null、标 pushed_to_metronome=true → 订单级双向断链、无逾期兜底。
- 修:建单拿到 res.orderId 后,用 araos 契约同口径 signedPostHeaders 向 `{OS_ARAOS_URL}/api/webhooks/qimo/settlement` POST `{araos_order_id, qimo_order_id, ...}`。
- **前置**:先核实 araos 仓(`~/Projects/终极版客户开发系统/araos`)该回调端点存在 + 契约认证(env 变量名/HMAC),别发错端点。

**B2 · P3 · 退货不回传 goods_receipt.recorded → 财务实收口径偏高(潜伏)**
- 位置:`app/actions/procurement-reconciliation.ts`(confirmProcurementReturn 末尾)
- 场景:收货三入口都 syncGoodsReceiptToFinance 发 received_qty_total;退货确认重算了 received_qty/冲库存/回填 return_qty,但**不重发 goods_receipt.recorded** → 财务实收停在退货前的高值。
- 修:confirmProcurementReturn 末尾对每个受影响 line 补发 `syncGoodsReceiptToFinance({line_id, received_qty_total: newReceived, line_status})`(fire-and-forget)。

### C. 财务 repo 侧 · `~/Projects/财务系统`(⚠️ 有另一会话 WIP,财务先上纪律;等 WIP 落定)

**C1 · P2 · 财务独立作废订单时不撤销/不回传节拍器在途审批 → 孤儿**
- 位置:`src/lib/financial/order-void.ts`(cascadeVoidOrder)
- 场景:节拍器已发出审批(shipment/cancel/milestone/purchase_order.approval_requested),财务侧对象仍 pending。财务走独立作废 → order-void 把 pending_approvals 置 expired、fin_purchase_orders 待审单 soft-delete,但**没有任何回传节拍器** → 节拍器在途审批永久孤儿(pre_order_price_approvals / shipment_confirmations / milestones / cancel_requests 停 pending)。
- 修:cascadeVoidOrder 对每条被 expired 的 pending_approvals / 被删的待审 fin_purchase_orders,补发 `approval.callback(decision='rejected', note='订单作废自动撤销')` 或专用 `*.cancelled` 事件,复用 sendApprovalToMetronome + fin_outbound_outbox。
- 节拍器侧:确认已消费 approval_cancelled / approval.callback rejected(记忆 [[procurement-finance-chain-fixes]] 提到已消费 approval_cancelled;核对各审批类型都清)。

**C2 · P2 · payment.completed 回传浏览器端 best-effort、掉线即丢**
- 位置:`src/app/(main)/payment-batches/page.tsx:209`(executeBatchLine 后浏览器另发 fetch)
- 场景:放款 RPC `execute_batch_line_payment` 服务端已完成付款+核销,但 `payment.completed` 回传是**浏览器**在 RPC 返回后发的 fetch。用户关页/跳转/网络失败 → 回传既没发也不入 outbox → 采购付款申请永久 unpaid。
- 修:把回传移到**服务端**付款路径(execute_batch_line_payment 调用方 server action 内 await notifyFinanceProgress),或落付款回传 outbox 行由 cron 保证投递,不依赖浏览器存活。

### D. 双侧 · P3 · 跨系统审批无超时兜底
- 位置:节拍器 `app/actions/price-approvals.ts`(expires_at=+24h)+ 财务 pending_approvals
- 场景:两侧都存了 expires_at,但**没有 cron 到期自动 expire/回传** → 财务不批则节拍器无限期挂起。
- 修:加到期扫描 cron,对超 expires_at 仍 pending 的集成审批自动升级通知或置终态并双向回传。

---

## 建议顺序
1. **等并行窗口收完 finance-callback 三重根因** → 再做 A1/A2/A3(同文件,别撞)。
2. B1/B2 可现在做(独立文件),但 B1 先核 araos 端点。
3. **等财务 repo WIP 落定** → 做 C1/C2(财务先上,再节拍器核对消费端)。
4. D(cron 超时兜底)最后,量小但要双侧约定。

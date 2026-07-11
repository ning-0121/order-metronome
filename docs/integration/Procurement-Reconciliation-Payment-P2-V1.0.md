# 采购对账 + 付款申请 → 财务联通(V1.0)

2026-07-11。采购先和供应商完成第一次对账(数据采购最清楚),对账确认后分批(每周·自定义金额)
提交付款申请给财务,财务照现有周排款/审批/出纳付款,付完回传节拍器累加对账已付。

## 架构 — 所有权拆分(Constitution 单一真相源/数据所有权)

| 归属 | 内容 | 系统 |
|---|---|---|
| **采购对账** | 收货实况 / 退货返修 / 折扣扣款 → 净应付 | **节拍器**(采购手里才有一手数据) |
| **付款** | 应付账款 / 周排款 / 审批 / 出纳付款 | **财务系统**(已全建好,不重造) |
| **桥** | 采购对账确认后分批推净应付;财务付完回传 | 双向 webhook |

粒度:**一 PO 一张对账单**(供应商×PO)。连接键:`procurement_line_items.id`(财务 `fin_po_lines.line_id` 已锚)+ 规范化 `supplier_name`(财务应付/付款层按 name 聚合,非 id)。

## 数据模型

**节拍器(P1,commit 39b0e7a,迁移 20260711_procurement_reconciliation)**
- `procurement_reconciliations`(对账单头,一 PO 一张):status(draft→confirmed→submitted→paid)、system_amount / return_amount / discount_amount / **net_payable**(=Σ(收货−退货)×价−逐行折扣−整单折扣)/ supplier_statement_amount(采购录供应商对账单金额比对)/ paid_amount。
- `procurement_reconciliation_lines`(逐行,对一 pli):系统 ordered/received/price + 采购录 supplier_qty/amount/line_discount + return_qty + net_amount。
- `procurement_returns` / `procurement_return_lines`(退货/返修:type=return/replace/rework,disposition=refund/replace/rework;refund 冲减对账 net_payable + 回写 goods_receipts.return_status)。

**节拍器(P2,commit ca3f551,迁移 20260711_procurement_payment_requests)**
- `procurement_payment_requests`(付款申请):一对账单挂多笔,采购自定义金额,Σ(未驳回)≤ net_payable。status(submitted→approved→paid/rejected)、request_no(PR-YYYYMMDD-NNN=财务 bill_no)、finance_payable_ref、paid_amount。

**财务(P2,迁移 20260711_payable_records_source_ref)**
- `payable_records.source_ref text` + 局部唯一索引(=节拍器付款申请 id;入站幂等 + 付款完成回带)。

## 契约(闭环)

```
采购对账确认(net_payable 锁定)
  → 采购提付款申请(自定义金额)
    → 节拍器 emit payable.created { source_ref=付款申请id, bill_no=PR单号, supplier_name, amount, currency, description, po_no, order_refs }
      → 财务 handlePayableCreated → 建 payable_records(payment_status=unpaid, source_ref, bill_no)
        → 财务周排款/审批/出纳付款
          → payment.completed 回带 source_ref
            → 节拍器 finance-callback: 累加对账 paid_amount、标付款申请 paid;付满 → 对账 status=paid
```

出站事件 `payable.created`;回传复用现有 `payment.completed`(加一个 `source_ref` 字段透传)。

## 节拍器侧改动(已上线)
- `lib/integration/finance-sync.ts`:WebhookEventType 加 `payable.created` + `emitProcurementPayableToFinance`。
- `app/actions/procurement-payment.ts`:`submitPaymentRequest`(校验额度≤净应付+emit)、`listPaymentRequests`。
- `app/api/integration/finance-callback/route.ts`:payment.completed 带 source_ref → `applyProcurementPayment`;加 request_id 幂等前置查(重放不重复累加)。
- `components/procurement/ProcurementReconciliationPanel.tsx`:「付款申请(分批)」区。

## 财务侧改动 spec(待财务仓应用+部署)
1. `src/lib/integration/types.ts`:`WebhookEventType` 加 `| 'payable.created'`。
2. `src/app/api/integration/webhook/route.ts`:switch 加 `case 'payable.created': return handlePayableCreated(payload.data, payload.request_id)` + 新 handler(仿 handlePurchaseOrderPlaced;按 supplier_name 认供应商;source_ref/bill_no 幂等;插 payable_records payment_status='unpaid')。
3. `payment.completed` 带上 `source_ref`(3 处):`payment-batches/page.tsx` doExec(payable select 加 source_ref + 回传 body 加)、`finance-progress/route.ts`(透传)、`client.ts notifyFinanceProgress`(data 类型加 source_ref + 并进 request_id 哈希)。

`handlePayableCreated` 代码见本次会话交付。

## 部署顺序
**财务侧先上**(能接 payable.created),再让采购提第一笔;否则节拍器发的事件财务落 `default: ignored`(不炸,不建应付)。节拍器 outbox 重试 6 次,财务上线后可 resync。

## 待办(P3+)
- 退货 inventory 出库反映(退回供应商减在手)。
- 付款申请撤回/驳回回流(财务驳回 → 节拍器付款申请标 rejected,释放额度)。
- 对账单一键导出 Excel(复用 exportReconciliationSheet)。

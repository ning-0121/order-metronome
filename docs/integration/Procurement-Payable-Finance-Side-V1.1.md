# 采购付款申请 → 财务应付入账(P2 财务侧完整实现)V1.1

**日期**：2026-07-11
**背景**：节拍器采购对账确认后,采购提付款申请 → emit `payable.created`。但**财务侧从未实现接收 handler**
(webhook 无 `case 'payable.created'`、类型无该值)→ 付款申请一直没落到财务应付。本文给财务侧完整落地步骤。
节拍器侧已就绪(payable.created 出站、含 `lines[]` 核对明细;payment.completed 回带 source_ref 的 finance-callback)。

**契约**:approval/回传均以 `source_ref` = 节拍器 `procurement_payment_requests.id` 为幂等键 & 关联键。
入站 payload(节拍器已发):
```
{ source_ref, bill_no, supplier_name, supplier_id, amount, currency, description,
  reconciliation_id, purchase_order_id, po_no, order_refs[], due_date,
  lines: [{ material_name, specification, ordered_qty, unit_price, po_amount,
            received_qty, supplier_qty, supplier_amount, net_amount }] }
```

---

## 1. 迁移 — `payable_records` 加 `detail jsonb`(存 lines 等)
`source_ref` 列已在 `20260711_payable_records_source_ref.sql`(已跑 PASS)。再加 detail 存明细:

```sql
-- migrations/20260711_payable_records_detail.sql
ALTER TABLE public.payable_records
  ADD COLUMN IF NOT EXISTS detail jsonb NOT NULL DEFAULT '{}'::jsonb;
COMMENT ON COLUMN public.payable_records.detail IS
  '外部来源明细:采购对账付款存 { lines[], order_refs[], reconciliation_id, purchase_order_id }。lines 每行含采购订单数量/单价/金额 + 供应商对账数量/金额,供付款审批核对。';
-- 验证:SELECT column_name FROM information_schema.columns WHERE table_name='payable_records' AND column_name='detail';
```

## 2. 类型 — `src/lib/integration/types.ts`
`WebhookEventType` 加一项:
```ts
  | 'payable.created'   // 采购对账付款申请 → 财务应付入账(source_ref=节拍器付款申请id;回传复用 payment.completed 带 source_ref)
```

## 3. webhook — `src/app/api/integration/webhook/route.ts`
**(a)** switch 加 case:
```ts
    case 'payable.created':
      return handlePayableCreated(payload.data as Record<string, unknown>, payload.request_id)
```
**(b)** 新增 handler(幂等:source_ref 有局部唯一索引,但为兼容 partial index 用「查-改/插」而非 upsert onConflict):
```ts
// 采购对账付款申请入账(2026-07-11 P2 财务侧):source_ref=节拍器付款申请id,幂等。
// detail.lines 存采购订单/供应商对账明细,供付款审批页核对实际付款。
async function handlePayableCreated(data: Record<string, unknown>, _requestId: string) {
  const supabase = createServiceClient()
  const sourceRef = String(data.source_ref || '')
  if (!sourceRef) return { action: 'ignored', reason: 'payable.created 缺 source_ref' }
  const num = (v: unknown) => (v == null ? 0 : Number(v))

  const row: Record<string, unknown> = {
    source_ref: sourceRef,
    supplier_name: (data.supplier_name as string) || '(未标注供应商)',   // NOT NULL
    description: (data.description as string) || '采购对账付款',           // NOT NULL
    order_no: (data.po_no as string) || null,
    cost_category: 'raw_material',
    amount: num(data.amount),                                              // NOT NULL
    currency: (data.currency as string) || 'CNY',
    bill_no: (data.bill_no as string) || null,
    due_date: (data.due_date as string) || null,
    payment_status: 'unpaid',
    detail: {
      lines: Array.isArray(data.lines) ? data.lines : [],
      order_refs: Array.isArray(data.order_refs) ? data.order_refs : [],
      reconciliation_id: (data.reconciliation_id as string) ?? null,
      purchase_order_id: (data.purchase_order_id as string) ?? null,
    },
  }

  // 幂等:先按 source_ref 查(局部唯一索引 where source_ref not null and deleted_at is null)
  const { data: existing } = await supabase.from('payable_records')
    .select('id, payment_status').eq('source_ref', sourceRef).is('deleted_at', null).maybeSingle()
  if (existing) {
    // 已入账:仅在未付/待审时刷新金额与明细(已付/已批不覆盖,防回改已决记录)
    if (['unpaid', 'pending_approval'].includes(existing.payment_status)) {
      const { error } = await supabase.from('payable_records')
        .update({ ...row, updated_at: new Date().toISOString() }).eq('id', existing.id)
      if (error) throw new Error(`payable 更新失败: ${error.message}`)
    }
    return { action: 'payable_updated', source_ref: sourceRef }
  }
  const { error } = await supabase.from('payable_records').insert(row)
  if (error) throw new Error(`payable 入账失败: ${error.message}`)
  return { action: 'payable_created', source_ref: sourceRef, supplier: row.supplier_name }
}
```
> 若 `payable_records` 无 `bill_no` / `deleted_at` 列(视你库而定),插入前去掉对应字段或补加列。付款页(payments/page.tsx)已在用 `bill_no`+`deleted_at`,一般已存在。

## 4. 付款完成回传带 `source_ref`(关键闭环)
财务给一笔 `source_ref` 非空的 payable 付款(出纳/周排款执行)后,回传节拍器时**必须带上 `source_ref`**:
```
POST {节拍器}/api/integration/finance-callback
{ event:'payment.completed', request_id, data:{ source_ref, amount, currency, at, note } }
```
节拍器 finance-callback 已就绪:收到即累加对账 `paid_amount`、标付款申请 paid、付满 → 对账 status=paid。
(找财务侧现有"付款执行→回传节拍器"处,把 payable_records.source_ref 透传进 payment.completed 的 data。手工建的 payable source_ref 为 NULL → 不回传,不影响。)

## 5. 展示 — 付款审批/应付明细页
读 `payable_records.detail.lines`,在该笔付款详情里按行展示两栏对照,差异高亮:

| 物料 | 规格 | 采购订单(数量 / 单价 / 金额) | 供应商对账(数量 / 金额) | 净应付 |
|---|---|---|---|---|
| material_name | specification | ordered_qty / unit_price / po_amount | supplier_qty / supplier_amount | net_amount |

供应商侧字段(supplier_qty/supplier_amount)可能为空(采购未录对账数)→ 显示「—」。
核对点:`supplier_amount` vs `po_amount`、`supplier_qty` vs `ordered_qty` 不一致时高亮,提示财务人工确认。

放置位置建议:`src/app/(main)/payables/SupplierPayableDetail.tsx` 或付款审批弹窗,渲染 `record.detail?.lines`。

---

## 端到端验证
1. 财务跑迁移(第 1 步)。
2. 财务上代码(2/3 步)+ 部署。
3. 节拍器采购:对账确认 → 提一笔付款申请。
4. 财务应付/付款审批出现该笔 → 点开看到「采购订单 ↔ 供应商对账」明细两栏。
5. 财务付款执行 → 回传带 source_ref(第 4 步)→ 节拍器对账 paid_amount 累加、付满转 paid。

**注意**:财务仓工作树现混着多会话 WIP,提交请 `git commit --only -- <本次文件>`,勿 `-A`/`-am` 全扫。

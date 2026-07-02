# 财务 ⇄ 订单系统 采购数据链契约 V1.1(草案)

> 2026-07-03。目标:让财务系统能做出 **订单预算单 / 单款预算单 / 订单决算 / 单款决算 / 供应商对账单**。
> 两仓库分工:订单系统(order-metronome)推"干净的事实数据";财务系统建单据与聚合。
> 铁律:两系统**独立 Supabase 绝不共库**,只靠 webhook + 共享 ID 融合(Phase-0 脊柱)。

## 一、现有契约(V1.0,已在生产代码,财务侧应已有接收端)

**方向 A:订单系统 → 财务系统**
- `POST {FINANCE_SYSTEM_URL}/api/integration/webhook`
- Headers:`x-api-key`(共享 INTEGRATION_API_KEY)· `x-webhook-signature` = HMAC-SHA256(原始请求体, INTEGRATION_WEBHOOK_SECRET) · `x-source: order-metronome`
- 信封:`{ event, timestamp, source:'order-metronome', request_id:'om-…', data, signature }`
  (体内 signature 字段冗余,**验证以 header 对 raw body 为准**,timingSafeEqual)
- 既有事件:`order.created/updated/activated/completed/cancelled/resync`、`milestone.updated`、`price_approval.requested`、`delay.requested`、`supplier.upserted`、`purchase_order.placed`
- `purchase_order.placed` 现有 payload(**太薄,只够记应付,做不了单款预算**):
  `{ po_no, purchase_order_id, supplier_id, total_amount, currency, payment_terms, delivery_date, order_refs[], status, placed_at }`
- 健康检查:订单系统会 GET `{FINANCE_SYSTEM_URL}/api/integration/health`

**方向 B:财务系统 → 订单系统**
- `POST {ORDER_SYSTEM_URL}/api/integration/finance-callback`
- 同样 x-api-key + x-webhook-signature;body `{ event, source:'finance-system', data:{ approval_id, approval_type:'price'|'delay'|'cancel'|'milestone', decision:'approved'|'rejected', decider_name, decision_note } }`
- 目前**只处理这四种审批回传**。budget.completed 等新回传要等订单侧加处理(见 §四)。

## 二、V1.1 新增/加厚事件(订单侧待实现,财务侧按此预留 schema)

### 1. `purchase_order.placed`(加厚,含行明细)
```jsonc
{
  "po_no": "PO-20260703-001",
  "purchase_order_id": "uuid",
  "supplier_id": "uuid", "supplier_name": "旺泽面料",
  "total_amount": 12345.6, "currency": "RMB",
  "payment_terms": "月结30", "delivery_date": "2026-07-20",
  "order_refs": [ { "order_id": "uuid", "order_no": "QM-20260702-018", "internal_order_no": "1022925" } ],
  "status": "placed", "placed_at": "…",
  "lines": [ {
    "line_id": "uuid",                  // procurement_line_items.id(对账/收货核销的锚)
    "order_id": "uuid", "order_no": "QM-…",
    "style_no": "ZL077-1",              // 单款预算的关键(可 null=整单通用)
    "material_name": "280克防水仿锦拉毛布", "material_code": "FAB-0001",
    "specification": "150cm", "category": "fabric",
    "ordered_qty": 745.2, "ordered_unit": "kg",
    "unit_price": 32.5, "amount": 24219.0
  } ]
}
```

### 2. `goods_receipt.recorded`(新,每登记一批发一次)
```jsonc
{
  "receipt_id": "uuid",                 // goods_receipts.id(幂等键)
  "line_id": "uuid", "po_no": "PO-…", "purchase_order_id": "uuid",
  "order_id": "uuid", "order_no": "QM-…", "style_no": "ZL077-1",
  "supplier_id": "uuid", "supplier_name": "…",
  "material_name": "…", "material_code": "FAB-0001", "category": "fabric",
  "batch_qty": 300, "unit": "kg", "received_at": "2026-07-03",
  "total_received": 600, "ordered_qty": 745.2,      // 累计/订购,财务可判收齐
  "unit_price": 32.5, "batch_amount": 9750.0,        // 决算/对账用
  "inspection_result": "pass",                        // pass/concession/reject
  "slip_urls": ["https://…signed…"],                 // 收货码单,签名URL 7 天有效
  "slip_paths": ["receipts/…/x.jpg"]                 // 存档路径(URL过期后凭此找订单系统重签)
}
```
财务侧收到后**应立即把码单文件下载转存到自己的存储**(签名 URL 会过期)。

### 3. `purchase_order.supplement_approved`(新,阶段二:补采购)
```jsonc
{
  "po_no": "PO-…", "purchase_order_id": "uuid", "order_id": "uuid", "order_no": "QM-…",
  "is_supplement": true,
  "supplement_reason": "面料缩水超预期",
  "responsible_party": "supplier" | "factory" | "internal" | "customer",  // 归因:谁造成谁付账
  "responsible_name": "旺泽面料",
  "amount": 3200.0, "currency": "RMB",
  "approved_by": "财务-张三", "approved_at": "…",
  "lines": [ /* 同 §1.lines */ ]
}
```

## 三、财务系统侧要建的(单据真相在财务库)

1. **接收端加固**:按 `request_id` 幂等(重发不重记);验签(header 对 raw body);事件落 inbox 表再异步处理。
2. **登记簿(建议表)**:`fin_purchase_orders` + `fin_po_lines`(按 §二.1)、`fin_goods_receipts`(按 §二.2,含转存后的码单文件引用)、供应商主档(收 `supplier.upserted`)。
3. **单据/聚合**:
   - **订单预算单** = Σ该 order 的 po lines 金额(按下单价);**单款预算单** = 按 lines.style_no 分组。
   - **订单决算 / 单款决算** = Σ实收批次金额(goods_receipt)± 补采购(§二.3,按 responsible_party 归因列示)。
   - **供应商对账单** = 按 supplier 汇总某期间的实收批次(数量×单价,附码单),对 payment_terms 生成应付账期。
4. **回传**(方向 B):继续用现契约发四种审批;`budget.completed` 等新事件**先别发**,等订单侧 finance-callback 加处理后再启用(双方同步升级)。

## 四、订单系统侧待办(本仓库,配套实现)
- [ ] `purchase_order.placed` payload 加 `lines[]`(supplier_name、行明细含 style_no/code/价/量)。
- [ ] `recordReceiptBatch`/`recordGoodsReceipt` 末尾 fire-and-forget 发 `goods_receipt.recorded`(含签名 URL + path)。
- [ ] 码单重签接口(财务凭 slip_path 换新 URL,api-key 鉴权)——或财务转存后不需要。
- [ ] 补采购新流程(结构化归因)+ `purchase_order.supplement_approved` 事件(阶段二)。
- [ ] finance-callback 支持 `budget.completed`(阶段二)。
- [ ] 生产环境确认 `FINANCE_SYSTEM_URL / INTEGRATION_API_KEY / INTEGRATION_WEBHOOK_SECRET` 已配(Vercel),否则一切静默跳过。

## 五、验收(两边联调)
1. 订单系统 `/api/integration/test-finance-health` → 财务 `/api/integration/health` 返回 200。
2. 下一张真实采购单 → 财务 inbox 收到 `purchase_order.placed`(V1.1 后含 lines)。
3. 收货登记一批 → 财务收到 `goods_receipt.recorded`,码单可打开并已转存。
4. 同一 request_id 重发 → 财务不重复记账(幂等)。
5. 财务生成:该订单预算单、单款预算单、该供应商对账单,数字与订单系统一致。

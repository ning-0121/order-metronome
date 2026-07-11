# 出货财务审批 → 财务系统「集成审批」队列  V1.0

**日期**：2026-07-11
**问题**：业务在节拍器「申请出货」后,财务系统收不到审批通知、审批队列也没有这笔待审 —— 出货财务审批
当初只在节拍器**内部**由 finance 角色审批(`approveShipment`),从未推给外部财务系统,与价格/取消/里程碑
审批走的是两条路。
**方案**：新增 `shipment_approval.requested` 事件,业务申请出货即推财务「集成审批」队列;财务批/驳后
回传节拍器执行(approved→放行物流;rejected→退回业务)。完全复用现有 `handleGenericApprovalRequest`
+ `approval.callback` 通道,纯加法。

契约 = 节拍器发起 → 财务队列 → 财务批/驳 → 回传节拍器。approval_id = `shipment_confirmations.id`,
approval_type = `'shipment'`。

---

## 节拍器侧(本仓,已实现)

| 文件 | 改动 |
|---|---|
| `lib/integration/finance-sync.ts` | WebhookEventType 加 `shipment_approval.requested`;新增 `syncShipmentApprovalToFinance(p: ApprovalRequestPayload)` |
| `app/actions/shipments.ts` | `createShipmentConfirmation` 插入成功后 fire-and-forget 推送(带 order_no/客户/申请人/数量/箱数/detail);未配置 FINANCE_SYSTEM_URL 时内部静默跳过,永不阻塞出货申请 |
| `app/api/integration/finance-callback/route.ts` | approval_type union 加 `'shipment'`;新增回传处理:approved→`status='warehouse_signed'`(放行物流)、rejected→`status='pending'`(退回业务),状态闸 `.eq('status','sales_signed')` 防重放 |

emit 载荷(`ApprovalRequestPayload`):
```
{ id: shipment_confirmations.id, order_no, customer_name, requester_name,
  summary: "申请出货 N 件 / M 箱",
  detail: { internal_order_no, shipment_qty, carton_count, order_qty, product_name,
            delivery_method, shipping_port, destination_port, requested_ship_date, ci_number },
  created_at }
```

---

## 财务侧(~/Projects/财务系统,待应用)

### 1. 迁移:放行 `pending_approvals.approval_type = 'shipment'`
照抄 `migrations/20260705_pending_approval_milestone.sql`,把 CHECK 从
`('price','delay','cancel','milestone')` 扩到含 `'shipment'`:

```sql
-- migrations/20260711_pending_approval_shipment.sql
DO $do$
DECLARE con record;
BEGIN
  FOR con IN
    SELECT con.conname FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = rel.relnamespace
    WHERE n.nspname='public' AND rel.relname='pending_approvals'
      AND con.contype='c' AND pg_get_constraintdef(con.oid) ILIKE '%approval_type%'
  LOOP
    EXECUTE format('ALTER TABLE public.pending_approvals DROP CONSTRAINT %I', con.conname);
  END LOOP;
  ALTER TABLE public.pending_approvals ADD CONSTRAINT pending_approvals_approval_type_check
    CHECK (approval_type IN ('price','delay','cancel','milestone','shipment'));
END $do$;
-- 验证:SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname='pending_approvals_approval_type_check';  -- 期望含 shipment
```
⚠️ 不跑迁移 → shipment 审批 upsert 违反 CHECK、审批**静默丢**。先跑迁移再上代码。

### 2. `src/app/api/integration/webhook/route.ts`
- switch 加一个 case:
```ts
case 'shipment_approval.requested':
  return handleGenericApprovalRequest(payload.data as Record<string, unknown>, 'shipment')
```
- `handleGenericApprovalRequest` 的 `type` 形参扩为 `'cancel' | 'milestone' | 'shipment'`,并给 shipment 默认 summary:
```ts
summary: (data.summary as string) || (
  type === 'cancel' ? '取消订单待财务审批'
  : type === 'shipment' ? '出货待财务审批'
  : '里程碑待财务确认'),
```

### 3. `src/app/(main)/approvals/IntegrationApprovals.tsx`
- `approval_type` union(L22)加 `| 'shipment'`。
- `TYPE_LABEL` 加:`shipment: { label: '出货审批', color: 'bg-teal-100 text-teal-700' }`。
- 顶部说明文案(L190)「价格 / 延期 / 取消订单 / 里程碑」→ 加「 / 出货」。
- (可选)detail 中文标签 `KEY_LABEL` 补:`shipment_qty:'出货数量', carton_count:'出货箱数', order_qty:'订单数量', delivery_method:'交货方式', requested_ship_date:'申请出运日', destination_port:'目的港', ci_number:'CI号', internal_order_no:'内部订单号'`。

### 4. `src/app/api/integration/approve/route.ts`
**无需改动** —— 已通用透传 `approval_type`,财务点通过/驳回后自动带 `approval_type='shipment'` 回传节拍器
`finance-callback`,命中新加的 shipment 分支执行。

---

## 端到端验证
1. 财务跑迁移(第 1 步)。
2. 财务上代码(2/3 步)。
3. 节拍器业务对一张已验货订单点「申请出货」→ 财务「审批队列 · 集成审批」应出现「出货审批」一行。
4. 财务点通过 → 回传节拍器 → 该订单出货状态转「待物流执行」(warehouse_signed),物流可执行出运。
5. 财务点驳回 → 节拍器出货状态退回 pending,业务可改后重报。

**kill-switch**:节拍器未配置 `FINANCE_SYSTEM_URL` → emit 静默跳过,出货申请照常(退回节拍器内部 finance 审批兜底)。

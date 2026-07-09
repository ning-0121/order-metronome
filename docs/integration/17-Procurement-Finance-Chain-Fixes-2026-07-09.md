# 采购 → 财务 链修复 + 财务端对接规格(2026-07-09)

节拍器(QIMO)侧已修完并发出正确数据;本文档给**财务系统仓库**(`~/Projects/财务系统`,独立 repo / 独立 Supabase)一份要实现的对接规格。三件事对应用户反馈的三个问题。

来源反馈(财务「采购审批」页 PO-20260708-005 截图):
1. 删除的订单,财务采购审批里还挂着。
2. 想按一个内部订单号,集中看它下面的多张采购单。
3. 财务看到的采购单没有供应商 / 没有明细行,无法审批+付款归集。

---

## 一、节拍器侧已改(本 repo,已上线)

| 修复 | 文件 | 说明 |
|---|---|---|
| **order_refs 补富** | `lib/integration/finance-sync.ts` 新增 `fetchOrderRefs()`;三处发送处([purchase-orders.ts:509]、[placeCore.ts:46]、[procurement.ts:830])都改传富 order_refs | 此前 `order_refs` 退回用裸 `order_ids`(UUID),财务只看到 UUID。现在带 `{id, order_no, internal_order_no, customer_name}`。 |
| **审批路径改 service-role** | `app/actions/purchase-orders.ts:507` | 审批发起时查 `suppliers`/`procurement_line_items` 改用 service-role,消除用户会话撞 RLS 把 `supplier_name` 查空的隐患。 |
| **删单/取消单撤审批** | `finance-sync.ts` 新增 `cancelPurchaseOrderApproval()` + 事件 `purchase_order.approval_cancelled`;删单([api/orders/[id]/route.ts])、取消单([ordersRepo.ts finalizeCancelledOrder])对 `approval_status='pending'` 的 PO 逐张发出。 |

> 说明:问题③的 payload(单头 `supplier_name` + `lines[]`)在 2026-07-08 就已修;截图那张是**修复前发出的旧事件**,财务侧需对存量脏数据清一次(见下第四节)。

---

## 二、财务端要实现:消费 `purchase_order.approval_cancelled`(修问题①)

**新事件**,节拍器在订单删除/取消、且其下有待审 PO 时逐张发送:

```jsonc
{
  "event": "purchase_order.approval_cancelled",
  "timestamp": "2026-07-09T...",
  "data": {
    "purchase_order_id": "<PO uuid>",   // 定位主键
    "po_no": "PO-20260708-005",          // 兜底定位
    "order_id": "<被删/取消的订单 uuid>",
    "reason": "order_deleted" | "order_cancelled"
  }
}
```

**财务侧动作**:按 `purchase_order_id`(或 `po_no`)找到「采购审批」队列里 `status=pending` 的待审条目 → 置为 `cancelled/withdrawn`,移出待审列表。幂等(重复收到当 no-op)。这样删单后审批不再积压。

---

## 三、财务端要实现:按内部订单号聚合采购单 UI(修问题②)

节拍器现在在 `purchase_order.placed` / `purchase_order.approval_requested` 的 payload 里带:

```jsonc
"order_refs": [
  { "id": "<order uuid>", "order_no": "QM-...", "internal_order_no": "<内部单号>", "customer_name": "..." }
]
```

**财务侧动作**:
1. 落库时把 `order_refs[].internal_order_no` 存到 PO 应付/审批记录上(一张 PO 可关联多单,存数组或建关联表)。
2. 「采购审批」和「应付」列表支持**按 internal_order_no 分组**:点开一个内部订单号 → 展开它下面所有采购编号(po_no)的采购单。
3. 展示用 `internal_order_no` 取代现在的裸 UUID。

---

## 四、财务端要做的一次性数据订正(存量脏数据)

问题③根因是**旧事件**,不是当前 payload。财务侧对**修复前**落库的 PO(如 PO-20260708-005:无 supplier_name / 无 lines)需:
- 要么请节拍器对这些 PO 触发一次 resync(节拍器补价 resync 已带全字段);
- 要么财务侧手动补 supplier / 标记为待订正。

节拍器可提供 resync:对指定 PO 重新发 `purchase_order.placed`(带全字段)。如需,在节拍器加个 admin resync 入口即可。

---

## 五、契约事件清单(截至 2026-07-09,采购相关)

| 事件 | 何时发 | 财务动作 |
|---|---|---|
| `purchase_order.placed` | PO 下单 / 补价 resync | 建/更新应付 + 付款计划(带 lines/order_refs) |
| `purchase_order.approval_requested` | PO ≥¥5000 提交审批 | 建待审条目(带 supplier_name/lines/order_refs/internal_risk_flags) |
| `purchase_order.approval_cancelled` | **新**;删单/取消单时对待审 PO | 撤掉待审条目 |
| `order.deleted` / `order.cancelled` | 删/取消订单 | 冲销应收/应付/预算(带 po_nos) |

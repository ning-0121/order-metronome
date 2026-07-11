# 多PO合单 P3:按来源PO做局部操作(取消/减量/拆分)设计方案 V1.0

> 2026-07-11,用户口述需求整理。状态:**定稿待签 → 开建**。
> 前置:[Multi-PO-Merge-Order-V1.0](Multi-PO-Merge-Order-V1.0.md)(P1/P2 已上线)。
> 原则:复用现有改单闸(order_amendments)+ 建单范式(createOrderFromPO)+ MRP/财务/风险联动,**不重造**;纯加法迁移;操作全走审批留痕。

## 一、业务背景

多张客户PO合并成一个内部订单统一生产后,偶尔某张PO要单独处理:
- **取消/减量某张PO**:客户砍掉其中一张PO,或某张PO减掉部分款/量;其余PO照常生产。
- **改期某张PO**:某张PO交期变了 —— 但这些PO当初**因交期相同才合并**,交期一改前提就破,正确做法是**把它拆出去独立成单**走自己的交期,而非在合并单里单独排期(单订单只有一条时间线)。

## 二、用户拍板口径(2026-07-11)

① **取消粒度**:整张PO一键取消 + 部分减量(某张PO里减某些款/量)**都做**。
② **改期语义**:**拆分成独立订单** —— 拆出该PO的明细生成一个新内部订单(继承客户/款色/自己的新交期),母单减去该PO。

## 三、双门禁准入

### 🏛 Architecture Gate
- **属哪个 Domain**:Order 域。局部操作 = Order 的 amendment(改单),不新建平行生命周期。
- **数据所有权**:操作对象是 `order_line_items`(明细真相)按 `source_order_po_id` 圈出的子集 + `order_customer_pos`(PO容器状态)。冲销/联动仍由 MRP/财务/风险各自的现有真相源负责。
- **触及 Constitution 的地方(必须小心)**:
  - *单一真相源*:减量**改 `order_line_items` 明细**(不再是 P1 的纯加法),审计留痕落 `order_amendments`(记 before/after),明细仍是唯一真相,不双轨。
  - *生命周期非复制*:拆分**新建一个完整 order**(走 createOrder,自带全套里程碑),母子通过 `split_from_order_id` 关联,**不复制生命周期、不共享节点**。

### 🔮 Future Gate
- 3年后/10工厂成立:多PO单里砍单/拆单是常态。用「改单闸 + 拆分建标准单」而非特例分支,长期可演进。
- 拒绝过度设计:不做「某张PO单独排期」(违背单时间线);不做负向库存行(污染下游);不自动砍已下采购单(留人工冲销)。

## 四、数据模型(纯加法迁移)

```
order_customer_pos  加:
  + status            text default 'active' CHECK(active/cancelled/split_out)
  + split_to_order_id uuid REFERENCES orders(id)   -- 拆出成了哪张子单(status=split_out 时)

orders  加:
  + split_from_order_id uuid REFERENCES orders(id)  -- 子单指回母单(拆分溯源)

order_amendments  加:
  + po_operation      jsonb   -- 非空 = PO 级局部操作;结构见下
```

`po_operation` 结构(审批批准时驱动应用):
```jsonc
{
  "kind": "cancel_po" | "reduce_po" | "split_po",
  "source_order_po_id": "uuid",              // 目标PO容器
  "customer_po_number": "PO-A",              // 冗余便于展示/通知
  // reduce_po 专用:逐行减量(按 order_line_items.id)
  "line_reductions": [{ "line_item_id": "uuid", "reduce_sizes": {"M": 20}, "reduce_qty": 20 }],
  // split_po 专用:子单参数
  "child_internal_order_no": "1022832-S1",   // 人确认/可改(唯一约束)
  "child_factory_date": "2026-09-10",        // 子单新交期
  "child_etd": null
}
```

**明细减量落地方式**:目标行**就地改小** `sizes`/`qty_pcs`(整张取消 = 减到 0),不删行(保留 line_no/审计);before/after 快照进 `order_amendments.po_operation` 与 `order_logs`。下游(MRP/PI/装箱/生产单)天然按 `qty_pcs>0` 汇总,0 量行自动落选。

## 五、路径①:取消/减量某张PO(P3a)

### 提交(走现有改单闸)
- UI:订单详情多PO区,每张PO一个「取消该PO / 减量」入口 → 选整张 or 勾款减量 → 组 `po_operation` → `submitOrderAmendment`。
- **窗口闸**:复用 `amendment-policy.ts` 的 `quantity_decrease` 规则,cutoff=`production_kickoff`(**开裁前**可减;开裁后拦截,提示走线下/整单取消)。审批人按 policy(finance/sales_manager)。

### 批准应用(新 `applyPoReduction`,仿 applyCustomerAddOrder 逆操作)
1. 圈行:`order_line_items` where `source_order_po_id = 目标`;按 `line_reductions` 就地减 `sizes`/`qty_pcs`(整张=全减到0)。
2. 表头:`orders.quantity -= Σ减量`;`total_amount = quantity × unit_price` 重算。
3. PO容器:整张取消 → `order_customer_pos.status='cancelled'`。
4. **采购冲销**:`submitBomToProcurement` + `consolidateOrderProcurementItems({apply:{refresh}})`(需求按缩小后的 line_items 自动重算)+ executeSideEffects 的 `notify_procurement`(打 `needs_reconfirm`,**不自动砍已下采购单**,采购人工核减余料)。
5. **财务**:`syncOrderToFinance(fresh,'order.updated')`(口径②:整单 total_amount 变小重发,不按PO拆应收)。
6. **风险**:`recomputeDeliveryConfidence('amendment_applied')` + 通知采购/生产/财务/跟单。

### 护栏
- **不能减最后一张活跃PO**:若操作会使订单所有PO都 cancelled → 这是**整单取消**,拦截并引导走现有 `decideCancelAction`/`finalizeCancelledOrder`(finance/admin 审批)。
- 减量后 `Σline_items != orders.quantity` 自检,不一致则中止+告警(不留脏数)。

## 六、路径②:拆分某张PO成独立订单(P3b)

### 提交
- UI:该PO「拆分独立成单」→ 填子单新交期 + 确认子单 internal_order_no(默认 `母单号-S{n}`,可改;n=母单已拆次数+1)→ 组 `po_operation{kind:'split_po'}` → 走改单闸(同 cutoff=开裁前)。

### 批准应用(新 `applyPoSplit`)
顺序保一致性(**先建子单、后减母单**,子单是价值载体不能先丢):
1. 读母单该PO明细:`getOrderLineItems` → 过滤 `source_order_po_id` → 得 styles[](正是 createOrder 认的 `line_items` 形状)。
2. 建子单:仿 `createOrderFromPO` 组 FormData(客户/款色/incoterm/order_type 沿用母单;`factory_date/etd`=子单新交期;`internal_order_no`=子单号;`customer_po_number`=该PO号)→ `preGenerateOrderNo()` → `createOrder(fd, orderNo)`。子单**自动跑全套里程碑/排期/财务/明细**(按自己的交期)。
3. 回填溯源:子单 `orders.split_from_order_id = 母单`;母单 `order_customer_pos.status='split_out'` + `split_to_order_id=子单`。
4. 母单减该PO:= 路径①的 `applyPoReduction`(整张减到0)+ 采购/财务/风险联动。
5. **一致性兜底**:子单建成但母单减量失败 → 不回滚子单(有效数据),标 `order_customer_pos.status='split_out'` + 记 `order_logs` 告警,提示 admin 人工核对母单数量(防重复计数)。子单建单失败 → 整体中止,母单不动。

### 子单继承什么 / 不继承什么
- 继承:客户、款色码明细(该PO的)、贸易条款、工厂、该PO的 `order_customer_pos` 元数据(可迁移一行过去,seq 重置 1)。
- 不继承:母单其余PO的明细、母单的里程碑进度(子单全新排期)、母单已下的采购/财务(子单独立重算)。

## 七、分期

- **P3a**(先做):取消/减量某张PO —— 迁移(order_customer_pos.status + order_amendments.po_operation)+ applyPoReduction + UI + 联动 + 护栏。
- **P3b**(后做):拆分成独立订单 —— 迁移(split_to_order_id + orders.split_from_order_id)+ applyPoSplit + 子单号生成 + UI。P3b 的母单减量直接复用 P3a 的 applyPoReduction。

## 八、迁移清单

| # | 迁移 | 内容 |
|---|---|---|
| 1 | `2026xxxx_ocp_status.sql` | order_customer_pos 加 status + split_to_order_id + 验证SQL |
| 2 | `2026xxxx_amendment_po_operation.sql` | order_amendments 加 po_operation jsonb + 验证SQL |
| 3 | `2026xxxx_orders_split_from.sql` | orders 加 split_from_order_id(P3b 用) |

均纯加法;执行后按 [数据库门禁] 逐条验证 PASS 才写码/build/commit/push;逐个 commit 归档。

## 九、DoD 硬闸
- [ ] 3 迁移门禁 PASS · build/check 过 · 改动区零新增 tsc 错
- [ ] 权限:减量/拆分入口有 auth + 走改单审批闸;不泄底价/po_amount
- [ ] 护栏:减最后一张PO→引导整单取消;拆分先建子单后减母单+失败告警;数量自检一致
- [ ] 无回归:单PO单 / 无多PO的老单不受影响
- [ ] 采购标 needs_reconfirm(不自动砍已下单);财务按内部单号重发;风险重算
- [ ] 用户 diff 审查

## 十、边界/风险
- 开裁后不允许在系统内减量/拆分(窗口闸);需要则走整单取消或线下。
- 拆分是两订单跨事务操作,非原子 → 用「先建子单、后减母单 + 状态标记 + 告警」补偿,不做分布式事务。
- 采购减量默认只提醒人工冲销,不自动砍单(避免误砍在途采购)。

## 附:复用锚点
| 用途 | 函数/文件 |
|---|---|
| 改单闸/审批 | `app/actions/order-amendments.ts` submit/approveOrderAmendment;`lib/domain/amendment-policy.ts` quantity_decrease |
| 加单逆操作参照 | order-amendments.ts `applyCustomerAddOrder` |
| 整单取消(减最后PO时引导) | `lib/repositories/ordersRepo.ts` finalizeCancelledOrder;`app/actions/orders.ts` decideCancelAction |
| 建子单范式 | `app/actions/order-from-po.ts` createOrderFromPO |
| 读母单明细 | `app/actions/order-line-items.ts` getOrderLineItems |
| MRP/采购归并 | `app/actions/bom.ts` submitBomToProcurement;`app/actions/procurement-items.ts` consolidateOrderProcurementItems |
| 财务同步 | `lib/integration/finance-sync.ts` syncOrderToFinance |
| 风险重算 | `app/actions/runtime-confidence.ts` recomputeDeliveryConfidence |
| 排期 | `lib/schedule.ts` calcDueDates;`app/actions/reschedule-order.ts` |

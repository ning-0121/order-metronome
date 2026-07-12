<!-- 2026-07-12 多agent多维度对抗式审计 · 67 agent/6维度/28确认发现 · workflow qimo-multichain-audit -->

# 订单节拍器 · 全链审计报告
（安全 / 生命周期 / 采购 / 财务 / 数据完整性 / 新功能六维度，双验证器对抗式复核后确认为真的发现）

---

## 一、Executive Summary（整体健康度 + 最该先修）

整体判断：**核心业务链能跑通，但"金额线"和"权限线"上有系统性护栏缺失。** 28 条确认发现里没有会当场崩系统或匿名公网可利用的洞（爆炸半径都限定在已登录的 `@qimoclothing.com` 内部账号），但有 5 条 P1 直接触及**采购底价泄露、成倍超采、重复应付、单人自批改价改量**——都是"钱"和"职责分离"的红线。最密集的问题区是本周新上线的两块：**供应商面料台账（supplier-ledger）** 和 **采购收货/对账链**。

最该先修的三条（理由见文末优先级清单）：

1. **P1｜供应商面料台账底价对全员敞开**（读+导出 Server Action 无角色门禁，RLS 仅 `auth.uid() IS NOT NULL`）——违反项目一贯的底价列级封锁纪律，等于开后门。
2. **P1｜库存抵扣同步执行行漏 `.is('size', null)`，尺码拆分项被成倍超采**——姊妹函数已有正确写法，此处是同一修复的遗漏，直接多采购多付款。
3. **P1｜改单审批无"不能自批"门禁**——业务经理可自提自批改价改量并打穿财务应收；延期路径有正确样板，改单路径漏了。

一个贯穿全局的根因值得单独强调：**多张新表的 RLS 停留在 `auth.uid() IS NOT NULL` 基线**（materials_bom / supplier_fabric_ledger / supplier_ledger_payables / goods_receipts），而 `procurement_items` 早在 2026-07-04 就收紧过——新表没跟上同一纪律，Server Action 层的角色门禁又时有遗漏，导致"任意登录员工直连 PostgREST 绕过应用层"这一类问题反复出现。

---

## 二、按严重度分组的发现

> 说明：多条发现是同一底层缺陷在不同审计维度被各自记录（如台账 `bill_no` 生成被 finance/newfeatures/dataintegrity 三次命中）。下面已去重合并，并标注置信度与双视角是否一致。

### P0（最高危）
**该级别未发现确认问题。** 所有确认发现的爆炸半径都需要已认证的内部账号，无匿名公网可利用项，也无当场崩系统 / 永久 brick 项。

---

### P1（高危：钱 / 权限红线，需尽快修）

**P1-1　供应商面料台账底价对所有登录用户敞开（读 + 导出均无角色门禁）**
- 位置：`app/actions/supplier-ledger.ts:186`（`getSupplierLedger`）、`:498`（`exportSupplierLedgerExcel`）、`:431`（`getLedgerImports`）；RLS 见 `supabase/migrations/20260711_supplier_fabric_ledger.sql:63`（`sfl_select USING(auth.uid() IS NOT NULL)`）
- 失败场景：三个读/导出 action 只有 `if(!user)`，无 `requireRoleGroup`，唯一守卫是 auth-only 的 RLS。页面 `/procurement/ledger` 有 `requireProcurementPage`（仅 admin/procurement/procurement_manager），但 Next.js Server Action 是可独立调用的 POST 端点，action id 随客户端 bundle 下发；production/qc/logistics/merchandiser/sales 任一登录账号直接调 `exportSupplierLedgerExcel()` 即可绕过页面重定向导出每家供应商每种面料的 `unit_price_ex_tax`、`amount_ex_tax`、含税金额。同文件所有**写** action 都 gate 了 `CAN_EDIT_PROCUREMENT_EXEC`，唯独读/导出漏了。
- 影响：供应商成交底价/采购金额全量泄露给无关角色，违反 `lib/procurement/visibility.ts:36` 的 `procurementCost` 屏蔽规则与 CLAUDE.md「不向 production 暴露价格」。
- 修复：三个读/导出函数补 `requireRoleGroup(...,'CAN_SEE_PROCUREMENT_FLOOR')`；并把 `supplier_fabric_ledger` / `supplier_ledger_payables` 的 SELECT RLS 从 auth-only 收紧到采购侧角色（参照 20260704 对 procurement_items 的收紧），或整表读改走 service-role + action 门禁。
- 置信度：**双视角一致，high**。注：另有一条 newfeatures 维度对同一问题的复报被下调为 P2（理由是"打开页面即看到"这条路径被 `requireProcurementPage` 挡住），但 security 维度确认的"直接构造 action 调用"向量成立，故本条按 **P1** 采信。核心争议在利用门槛（需构造 action 调用），底价敞开这一事实两方都认。

**P1-2　materials_bom RLS 全操作 auth-only，任意登录用户可直连改/删任意订单 BOM 并读预算成本**
- 位置：`supabase/migration.sql:877-881`（`bom_select/insert/update/delete_auth` 均 `USING(auth.uid() IS NOT NULL)`）
- 失败场景：`procurement-items.ts` 里 `saveBomSupplyMode/saveBomProductionConsumption/saveBomBudgetUnitPrice` 虽有角色门，但写入走 user-session，真正边界是 RLS。任意登录用户（如 logistics）持自身 JWT 直连 `PATCH /rest/v1/materials_bom?id=eq.X` 设 `{customer_supplied:true}` 或改 `production_consumption`、`SELECT` 读 `budget_unit_price`、`DELETE` 行，全部绕过 action 层。
- 影响：**完整性 + 机密性双风险**——①标客供 → 核料归并跳过 → 订单静默少采购；②篡改单耗 → 破坏 MRP；③直读面料预算成本。与 2026-07-04 修过的 procurement_items 同源同类洞，materials_bom 被漏改。
- 修复：新建 migration 把四条策略收紧为 `user_is_procurement_side(auth.uid()) OR user_can_access_order(auth.uid(), order_id)`（至少 UPDATE/DELETE 限采购侧）；`budget_unit_price` 列考虑列级 REVOKE。
- 置信度：**双视角一致，high**（一方指出按完整性影响甚至可主张 P0）。

**P1-3　库存抵扣同步执行行漏加尺码过滤，尺码拆分采购项被成倍超采**
- 位置：`app/actions/procurement-items.ts:182`（`deductFromStock` 的 update）
- 失败场景：某辅料已确认并按尺码拆成多条执行行（S:100、M:100）。采购点「用库存尾料抵扣」，`deductFromStock` 算出标量 `remaining`（如 150）。第 182-186 行 update 只按 `procurement_item_id + line_status + purchase_order_id is null` 过滤，缺 `.is('size', null)`，于是把**每一条**尺码行的 `ordered_qty` 都写成 150 → Σ=300，远超应采 150。姊妹函数 `consolidateOrderProcurementItems`（`:799`）对同一同步逻辑显式加了 `.is('size', null)` 并有 N1 注释，此处是同一修复的遗漏。
- 影响：库存抵扣一旦作用于尺码拆分项，出单量被行数倍数放大，归单/导出/发供应商/财务应付全按虚高量走 → 多采购、多付款。
- 修复：在该 update 追加 `.is('size', null)`（size 列不存在时容错）；尺码拆分行改标 `needs_reconfirm` 让采购重生成执行行，而非整项标量覆盖。
- 置信度：**双视角一致，high**。

**P1-4　台账推财务防重推存在 TOCTOU，并发/双击会重复建应付（重复付款）**
- 位置：`app/actions/supplier-ledger.ts:353`（`pushLedgerGroupToFinance`）
- 失败场景：`:350` 读 rows → `:353` 用 `lines.some(l=>l.payable_pushed_at)` 判重 → `:374` 建 payable → `:383` 才回写 `payable_pushed_at`，中间无锁；且 `:383` 回写用无条件 `.in('id', ids)`，不像本文件其它函数那样加 `.is('payable_pushed_at', null)` 守卫。两个标签页/两个授权用户并发推同一组：都在对方回写前读到 null、都通过防重，各自 insert（`bill_no` 因 count 读取被 insert 隔开而不同号）、各自 emit `payable.created`，财务建两笔应付 → 重复入账/重复付款。`bill_no` UNIQUE 只在两次恰好同号时挡一次，时序错开挡不住。
- 影响：同一批面料在财务重复建应付 → 重复付款。
- 修复：改为"先条件回写抢占再建 payable"——`UPDATE ... SET payable_pushed_at=now() WHERE id IN(...) AND payable_pushed_at IS NULL RETURNING id`，只有拿到全部目标行才继续 insert+emit；或对未推组加唯一约束。
- 置信度：**双视角一致**（correctness high / reachability medium，因需真并发交错触发；后果为财务实损，两方均定 P1）。

**P1-5　改单审批无自批门禁，业务经理可自提自批改价改量并打穿财务应收**
- 位置：`app/actions/order-amendments.ts:180`（`approveOrderAmendment`）、`:326`（`bulkApproveAllPendingAmendments`）
- 失败场景：一个 sales_manager/order_manager 本身是订单 owner/created_by，提交 `unit_price 10→5` 或 `quantity 1000→1500` 后调用 `approveOrderAmendment(id, true)`。该函数只校验 `canApproveAmendment = isAdmin||order_manager||sales_manager`（`:188`），全程无 `requested_by===user.id` 的自批拦截 → 自己批自己 → orders 金额/数量被改、`total_amount` 重算、`order.updated` 推给财务应收（`:271-289`）。`bulkApproveAllPendingAmendments` 同样无自批过滤，一次批量把自己的改单一起放行。对照 `delays.ts:564` 延期路径有明确的 `if(requested_by===user.id && !isAdmin) return failure(...)`——改单路径漏了同款门禁。
- 影响：单人绕过复核篡改订单价/量并打穿财务应收，击穿职责分离；历史审计已列「审批链可自批」为待修项，改单侧仍未堵。
- 修复：两个函数批准前加 `if(amendment.requested_by===user.id && !isAdmin) 拒绝/跳过`，与 `approveDelayRequestCore:564` 同口径（bulk 里把自己的改单计入 failed 跳过）。
- 置信度：**双视角一致，high**。

---

### P2（中危：数据一致性 / 内控 / 单据质量）

**P2-1　goods_receipts INSERT/UPDATE RLS auth-only，可直连伪造/篡改收货记录**
- 位置：`supabase/migrations/20260613_procurement_center_v1.sql:130-134`
- 场景：`recordGoodsReceipt`/`recordReceiptBatch` 有 `checkOperator`（仅采购/admin）但走 user-session，边界是 RLS。任意登录用户 `POST /rest/v1/goods_receipts` 插一条虚高 `received_qty` 的 pass 记录，或 `PATCH` 改 `inspection_result`/`return_status`。
- 影响：收货数据被非采购角色伪造/篡改，污染对账与库存派生流水，`checkOperator` 形同虚设。裸 REST 写入不触发 Server Action 的财务同步副作用，故定 P2 而非更高。
- 修复：收紧 insert/update RLS 到采购侧或订单可访问者；或收货写入统一改 service-role + action 门禁，DB 层禁 authenticated 直写。
- 置信度：**双视角一致，high**。

**P2-2　重归并改需求时尺码拆分的未下单执行行不同步也不清除，PO 可按陈旧量下单**
- 位置：`app/actions/procurement-items.ts:798`
- 场景：某尺码拆分项（S/M 两条 pending_order 未归单）上游需求变动后重跑 `consolidateOrderProcurementItems`，`.is('size', null)` 只更新整量行 → 该项无 size=null 行 → 0 行更新，S/M 仍是旧量；仅标软性 `needs_reconfirm`（`:780`），无硬闸阻止随后从陈旧行建 PO。UI「重新确认」只清标记不修行，反而可能掩盖。
- 影响：需求下调后按旧量发供应商，超采/少采；`needs_reconfirm` 只是软提示不阻断。
- 修复：检测到尺码拆分项且总需求变化时，主动删除其未下单尺码执行行（或阻止进入下单队列），强制重生成。
- 置信度：**双视角一致，high**。

**P2-3　recordGoodsReceipt 部分验收即置 accepted，状态机禁止二次累加，剩余量被静默丢弃**
- 位置：`app/actions/procurement.ts:1005`
- 场景：订购 500 的行到货，QC 录 `received_qty=300, result='pass'` → 置 accepted。`VALID_LINE_TRANSITIONS`（`lib/domain/procurement.ts:51`）中 accepted 只能→closed，剩余 200 无法再经 QC 入账，且从催货/收货/待验收三队列消失。超收闸按多批 `prevTotal` 累加设计，暗示支持累加，但 pass 即锁死，设计自相矛盾。
- 影响：部分验收让 200 短缺静默消失，缺料被掩盖。
- 修复：`received_qty < ordered_qty` 且 pass 时不置 accepted，保持 arrived（或新增 partially_accepted）允许继续累加，仅累计达标或人工勾"收齐"才 accepted。
- 置信度：**双视角一致**（一方 correctness high，一方 reachability medium 认为需操作员误用终态判定入口而降至 P3；综合取 P2）。

**P2-4　对账页 recordReceipt 覆盖写 received_qty 后，批次收货按 goods_receipts 重算会抹掉该量并写负库存**
- 位置：`app/actions/procurement.ts:1151`（批次重算）、`:464`（覆盖写入口）
- 场景：先走对账页 `recordReceipt` 覆盖写 `received_qty=500`（不插 goods_receipts、入库 500），它只拦"批次在先→覆盖在后"这一方向；随后对同行走 `recordReceiptBatch` 录 100，`:1151-1156` 把 `received_qty` 重算为 goods_receipts 汇总（仅这批 100），先前 500 被覆盖丢 400，库存 delta = 100−500 = −400 自我回落到 100。
- 影响：实收/库存/应付一起从真实 600 塌成 100（欠记 400）。注：验证器纠正了原发现"库存滞留 600 双轨打架"的说法——库存实际会自我纠偏到 100，真正危害是**欠记**而非双轨冲突。
- 修复：覆盖写入口也写一条 goods_receipts（或收敛到单一 goods_receipts 真相），两入口共用同一汇总口径。
- 置信度：**双视角一致**（一方因 impact 描述被证伪而将 dataintegrity 维度复报降至 P3；合并取 P2）。

**P2-5　台账 bill_no 用全表 count+1 生成，非原子且不按日重置，并发/删行撞 UNIQUE**
- 位置：`app/actions/supplier-ledger.ts:371`
- 场景：`billNo = LG-<date>-<全表count+1>`，`bill_no` NOT NULL UNIQUE。两个采购同日几乎同时各推一组 → 读到相同 count → 相同 bill_no → 第二个 insert 撞唯一键 → 无重试直接返回「建付款申请失败」。这正是 `procurement-payment.ts:68-99` 与 `procurement-reconciliation.ts:225` 已明文废弃并修过的老套路（改为"当天最大号+1 + 唯一键冲突自增重试"），台账未跟进。
- 影响：并发推财务偶发失败（可重试自愈）；NNN 非按日序号，对账可读性差。
- 修复：照搬姊妹代码——取当天已存在 `LG-` 前缀最大序号+1，并对唯一键冲突自增重试。
- 置信度：**双视角一致，high**（该缺陷被 finance/newfeatures/dataintegrity 三个维度分别命中，其中一维定 P3；综合取 P2）。

**P2-6　台账推财务时 fetchOrderRefs 实参错位，order_refs 永远为空，财务无法按内部订单号归集**
- 位置：`app/actions/supplier-ledger.ts:391`
- 场景：`fetchOrderRefs(db, orderIds)` 第一参须是 client，但此处写成 `fetchOrderRefs([orderId])`，把 id 数组当 db 传入，`orderIds=undefined` → 内部 `if(!ids.length) return []` 早返回。因 `db:any` 不报编译错。即便台账组已关联系统订单，emit 的 `payable.created` 里 `order_refs` 恒 `[]`。对照 `procurement-payment.ts:113` 正确写法 `fetchOrderRefs(supabase, ...)`。
- 影响：台账应付在财务侧拿不到 `internal_order_no` 富标识，无法按内部订单号聚合——与该功能设计目标直接相悖。金额/税额不受影响，属功能降级。
- 修复：改为 `fetchOrderRefs(svc, [orderId])`，传 service-role client 作首参。
- 置信度：**双视角一致，high**。

**P2-7　台账应付（LG）与采购对账应付（PR/DP）双轨无互斥，同批面料可被重复推财务**
- 位置：`app/actions/supplier-ledger.ts:402`
- 场景：同一批面料存在两条独立入账链——①`procurement_reconciliations` → `submitPaymentRequest/submitPurchaseDeposit`（bill_no=PR-/DP-）；②《面料采购明细表汇总》导入后 `pushLedgerGroupToFinance`（bill_no=LG-）。两者 source_ref/bill_no 完全不同，财务侧 `(supplier_name, bill_no)` 去重识别不出是同批货。若采购对同一 PO 既做对账付款、又录进台账汇总并推财务，财务建两笔应付。
- 影响：同批面料重复计入应付，重复付款风险；当前仅靠人工不重叠操作两条链兜底。
- 修复：推台账应付前按 `(supplier_id, internal_order_no/po_no)` 检查是否已存在对账应付，命中告警/阻断；或财务契约层用统一业务键跨链去重。
- 置信度：**双视角一致**（correctness high / reachability medium，因需运营口径上两链真的落在同批货）。

**P2-8　确认退货冲减了应付，但从不冲减 received_qty / 库存 → 退回料仍算"已收/料齐"且留在库存池**
- 位置：`app/actions/procurement-reconciliation.ts:299`（`confirmProcurementReturn`）
- 场景：订购 100kg、已收 100，建 refund 退 30 并确认。该函数只做两件事：①累加对账行 `return_qty`（net_payable 1000→700）；②置 `goods_receipts.return_status='returned'`（`inspection_result` 仍 pass）。从不改 `procurement_line_items.received_qty`（仍=100），也不写任何 inventory 冲减（代码注释自认"库存反映退回=出库 P2 再接"延后）。
- 影响：应付已冲减，但 `received_qty` 仍=100 → 「料齐」误判、里程碑可能自动完成；库存派生余额仍含被退 30kg → 幽灵库存可被领料。`received_qty` 汇总用 `.neq('inspection_result','reject')` 排除拒收，但退回批次仍是 pass、只有 `return_status='returned'`，不在排除口径内。
- 修复：refund 退货同步写一笔 inventory issue/负 receipt 冲减库存，并重算 `received_qty`（或收货汇总口径同时排除 `return_status='returned'`）。
- 置信度：**双视角一致，high**。

**P2-9　供应商台账重复导入无去重 + 推财务按组跨批次求和 → 应付金额翻倍推财务**
- 位置：`app/actions/supplier-ledger.ts:346`
- 场景：采购发现笔误，未先 `deleteLedgerImport` 旧批就再传一次更正表。`importSupplierLedger`（`:73-120`）每次新建 batch 并 insert 全部行，无自然键去重（表也无 UNIQUE 约束）。`pushLedgerGroupToFinance` 用 `.eq(supplier_name_raw).eq(order_no_raw)` 选该组全部行（不区分 `import_batch_id`）并 reduce 求和 → `amount_incl_tax` 翻倍推财务。UI 删除提示写"可重新上传更正"，但无 replace 语义或重复拦截兑现该前提。
- 影响：台账金额/数量翻倍显示，推财务双倍应付 → 供应商多付一倍（财务侧 status=submitted 需人工复核，非自动付款，故 P2）。
- 修复：导入按 `(supplier_name_raw, internal_order_no, fabric_name, color, ...)` 自然键 upsert/去重，或强制"重传前先删旧批"；推财务限定单一批次或对同组多批次告警。
- 置信度：**双视角一致，high**。

**P2-10　改单每字段声明的 approvers（如改数量需 finance）被完全忽略，sales_manager 可批准本该财务审批的价量变更**
- 位置：`app/actions/order-amendments.ts:188`
- 场景：`amendment-policy.ts` 为 `quantity_increase/decrease/unit_price/payment_terms` 声明了 `approvers=['admin','finance']`，但全库 grep 证实 `rule.approvers` 从未被任何运行时代码读取。`approveOrderAmendment` 只用一把粗门禁 `isAdmin||order_manager||sales_manager`。非 finance 的 sales_manager 即可批准 `quantity 1000→2000` 的改单，财务从未参与就落库+改应收。per-field approvers 沦为死元数据。
- 影响：财务本应把关的金额/数量/账期变更被业务经理单方批准；策略表看似分级审批，运行时无效。
- 修复：`approveOrderAmendment` 按 `amendment.fields_to_change` 每个 field 取 `AMENDMENT_RULES[field].approvers` 求并集，校验当前用户角色覆盖所有被改字段的 approvers（缺 finance 角色时对含 finance 的字段拒批）。
- 置信度：**双视角一致，high**（注：把审批权放开给 order_manager/sales_manager 是 2026-07-11 有意决策，但细粒度 approvers 从未接线——这是真实的分级审批失效；一方指出"应收控制形同虚设"略夸大，核心判断成立）。

**P2-11　quantity 改单只写 orders.quantity，不同步 order_line_items → 下游按旧量生产采购、财务按新量计费**
- 位置：`app/actions/order-amendments.ts:249`
- 场景：对富录入表订单（order_line_items 为真相源）提交 `quantity 1000→1500`。批准时只把 `change.to` 写进 `orders.quantity` 并重算 `total_amount`，sideEffects 仅 `recalc_unit_cost`（实为 no-op）+通知，全程不改 order_line_items。于是 `orders.quantity=1500`、财务应收按 1500，而 Σ(line_items.sizes) 仍=1000 → 生产任务单/PI、MRP 采购、装箱单都按 1000 备料，财务按 1500 开票。专门的客户加单路径 `applyCustomerAddOrder` 才追加 line_items，普通数量改单不走。
- 影响：批准数量改单后生产/采购按旧量（少产少采 500 件）、财务按新量收款，单据链静默错配；越是走富录入表的正规订单越受影响，减量方向甚至无正确替代路径。
- 修复：quantity 改单在批准时按比例/按行同步调整 order_line_items（并 bump sizes）；或对已有 line_items 的订单禁走普通 quantity 改单，强制走客户加单/子订单通道。
- 置信度：**双视角一致，high**。

**P2-12　approveDeferralStep 无提交人自批拦截，且先落库再调 core 自批被拒 → 残留 current_step 越界的不一致态**
- 位置：`app/actions/delays.ts:476`
- 场景：两问题同源。①`approveDeferralStep`（`:424`）全程无 `requested_by===user.id` 检查，且 `:443` `hasRoleInGroup(CAN_APPROVE_DELAY)` 会短路 needRole 匹配 → 经理为自己订单提交"转紧急·不退交期"后，可代 procurement/production 逐级替签"下游能压缩到原交期"，两团队根本没参与。②到链末位时 `:476` 先写 `current_step=chain.length`，`:488` 才调 `approveDelayRequestCore`，core 对本人自批返回 SELF_APPROVAL，但 `:476` 的写库未回滚 → 残留 `status=pending` 且 `current_step>=chain.length` 的矛盾态；再次确认时 `needRole=chain[step]=undefined`，累积垃圾 approval。
- 影响：转紧急的下游背书可被发起经理自己橡皮图章；自批被拒后残留链越界+pending 脏状态。core 的自批闸挡住了"真正落地改期"（非 admin 卡住），故非高危，但审计记录被伪造+脏态真实。
- 修复：`approveDeferralStep` 开头加 `requested_by===user.id` 自批拦截（admin 例外）；把落库 `current_step/approvals` 放到 core 成功返回之后，或 core 返回错误时回滚该步 update。
- 置信度：**双视角一致，high**。

**P2-13　采购单辅料图 image_urls 未过 IMG_EXT，webp 参考图被当 jpeg 嵌入变成破图**
- 位置：`app/actions/purchase-orders.ts:1178`（主表）、`:1341`（附页）
- 场景：`imgFromUrls` 只过 `/^https?:\/\//`，不校验 IMG_EXT；紧邻的 `imgFromAtt` 用 IMG_EXT 明确排除了 webp。`img` 优先取 `imgFromUrls`。上传框 `accept="image/*"` 允许 webp 且保留原扩展名，故 `image_urls[0]` 可能是 `.webp`。贴图循环 `:1260` ext 只区分 png/gif，其余一律 'jpeg' → webp 字节以 `extension:'jpeg'` 塞进 ExcelJS，Excel 打开是破图。注释 `:1177` 明说 ExcelJS 不支持 webp，却只对 attachment 生效。
- 影响：发给供应商的采购单出现破损辅料图，供应商看不到吊卡/烫标样图，采购返工；webp 命中率不低。（PDF 不是有效向量，`accept=image/*` 挡住。）
- 修复：`imgFromUrls` 的 find 加 `&& IMG_EXT.test(u)`，附页 `:1341` 同改。
- 置信度：**双视角一致，high**。

**P2-14　面料台账解析器跳小计正则作用于整行拼接文本，含关键词的真数据行被静默丢弃且金额漏计**
- 位置：`lib/services/fabric-ledger-parser.ts:138`
- 场景：`:137-138` 用 `row.map(s).join('')` 把整行拼成一串，再用 `/总金额|合计|小计|总计|明细表汇总|采购数量|实到数量/` 判跳过。任何真数据行只要某列（备注 deliveryNote、客户 customerName 等自由文本）含"小计""合计"子串（如备注"尾数已按合计核对"），整行被 continue 跳过，不进 out[] 也不计入 totalAmount，且无 warning。
- 影响：供应商对账金额少计、明细缺行，与真实采购不符且无告警难发现；备注含"合计/小计"在面料收货台账中相当常见。
- 修复：跳过判定只针对订单号列/首列文本，或要求整行只有金额、其余关键列全空才判小计；不要对全行 join 做子串匹配。
- 置信度：**双视角一致**（medium——缺陷确定，触发依赖备注内容而非无条件发生）。

---

### P3（低危：健壮性 / 边缘场景 / 报表口径）

**P3-1　付款申请净应付上限校验为 TOCTOU，并发分批可突破 net_payable**
- 位置：`app/actions/procurement-payment.ts:59`
- 场景：`:57-63` 读现有申请求和 `used`、判 `used+amt≤net_payable`，再 `:88` insert，中间无锁；DB 无 `Σamount≤net_payable` 约束。同一对账单两笔并发提交（各自在剩余额度内、相加超额）都通过校验、都 emit `payable.created`。
- 影响：并发可绕过净应付封顶。属 over-REQUEST 非 over-PAYMENT，财务下游有审批/排款兜底，故 P3。
- 修复：insert 前对 reconciliation 行 `SELECT ... FOR UPDATE` 或用带条件的原子累加/约束。
- 置信度：**双视角一致**（correctness high / reachability medium）。

**P3-2　已推财务的供应商×订单组，后续新导入的行永远推不出去 → 这部分应付漏推（少付）**
- 位置：`app/actions/supplier-ledger.ts:231`
- 场景：组已推（组内有行 `payable_pushed_at`），之后补导入同组新行（`payable_pushed_at=null`）。`getSupplierLedger:231` 的 `og.pushed` 只要组内任一行已推即置 true → UI 禁用「推财务」按钮；服务端 `:353` 也拒推整组。新行双重锁死。
- 影响：新补应付行卡在台账永远进不了财务 → 静默少付/漏账。与 P2-9（重复导入翻倍）同根因："推财务按组聚合、导入无去重"。
- 修复：推财务的选取与 pushed 判定只针对 `payable_pushed_at IS NULL` 的行，允许对同组剩余未推行增量补推。
- 置信度：**双视角一致，high**。

**P3-3　confirmProcurementReturn 无退货量上限校验，累计退货可超已收 → net_payable 变负（供应商倒欠）**
- 位置：`app/actions/procurement-reconciliation.ts:290`
- 场景：对账行已收 100，分两张退货单先退 80 再退 50，各自只校验自身 `status==='draft'`，无跨单累计上限。recompute 里 `lineNet=(100-130)*price-disc` 为负 → net_payable 变负。DB 侧 `net_payable` 无 `CHECK>=0`，`return_qty` 无 `CHECK<=received_qty`。
- 影响：净应付负数被当真相锁定，将来推财务表现为供应商倒欠。因 P2 财务推送尚未上线、负数目前只锁在节拍器侧且界面可见，故 P3。
- 修复：累加 `return_qty` 前校验 `已有return_qty + 本次qty ≤ received_qty`，超出拒绝。
- 置信度：**双视角一致，high**。

**P3-4　收货对账单导出硬选 received_address，列缺失时整表返回空（与写入的降级不对称）**
- 位置：`app/actions/goods-receipt-export.ts:35`（`loadReceiptRows`）
- 场景：写入路径 `procurement.ts:1137-1145` 对 `received_address` 列不存在（20260711 迁移未跑）做了降级重试——代码自证该列在生产可能尚未建。但导出的 `loadReceiptRows:34-37` 硬 select 该列，列不存在时 PostgREST 报错、只解构 data 被吞成 null → 返回 []，对所有供应商返回"没有符合条件的收货记录"，即便记录真实存在。
- 影响：迁移滞后于部署时，收货能记但对账单一条导不出，且误导为"无记录"。迁移跑完即自愈。
- 修复：`loadReceiptRows` 对 `received_address` 做同样 catch 降级（缺列去掉该列重查、address 置空）。
- 置信度：**双视角一致，high/medium**。

**P3-5　收货对账单/筛选项装配无分页，PostgREST 默认行数上限静默截断**
- 位置：`app/actions/goods-receipt-export.ts:34`
- 场景：`loadReceiptRows` 首查询 `goods_receipts` 无 limit/分页，`:42` 的 `.in('id', lineIds)` 同理，受 PostgREST 默认 max-rows（通常 1000）限制。累计收货批次或执行行 >1000 时，导出静默丢弃超出部分（升序排序，丢的是最新批次），合计数量/金额随之偏少。`app/api/backup/route.ts:66` 显式写 `.limit(10000)`，证明团队认知该上限存在。
- 影响：长期运营后对账单不完整、合计偏小，供应商对账少算，无提示。
- 修复：对 `goods_receipts` 及 `.in` 查询做 range 分页循环取全量，或限定时间窗并在导出标明范围。
- 置信度：**双视角不完全一致**（一方 correctness 判真 medium；另一方 reachability 判为伪——因无法从仓库确认该项目 Max Rows 是否仍为默认 1000）。**采信为 P3，但需先确认 Supabase 项目的 Max Rows 配置再决定是否修**。

---

## 三、跨发现的系统性问题（反复出现的根因）

1. **新表 RLS 停留在 `auth.uid() IS NOT NULL` 基线，未跟进 2026-07-04 的收紧纪律。**
   命中：`materials_bom`（P1-2）、`supplier_fabric_ledger`/`supplier_ledger_payables`（P1-1）、`goods_receipts`（P2-1）。
   `procurement_items` 早已收紧为 `user_is_procurement_side OR user_can_access_order`，但后续新表没沿用同一模板 → "任意登录员工直连 PostgREST 绕过应用层"这一威胁模型反复复现。**建议：把"新表 RLS 必须带角色/归属谓词"写进对象准入门禁清单，migration review 强制核对。**

2. **Server Action 层角色门禁不对称：写有门禁、读/导出漏门禁；且误把页面门禁当 action 边界。**
   命中：P1-1（读/导出无 requireRoleGroup）、P2-1（同理）。
   Next.js Server Action 是独立 POST 端点，`requireProcurementPage` 只保护 RSC 页面。**建议：敏感读/导出 action 一律显式 `requireRoleGroup`，不依赖页面重定向；底价列继续走列级 REVOKE。**

3. **"不能审批自己提交的"自批门禁缺失 + per-field 审批分级形同虚设。**
   命中：P1-5（改单 approve/bulk）、P2-10（改单忽略 rule.approvers）、P2-12（延期 approveDeferralStep）。
   `delays.ts:564` 有正确样板，但改单侧、延期分步侧都没接线，且策略表的 `approvers` 是死元数据。**建议：抽一个统一的 `assertNotSelfApprove(requested_by, user, isAdmin)` + `assertRoleCoversApprovers(fields, userRoles)`，所有审批入口强制调用。**

4. **单号/bill_no 用"全表 count+1"生成，非原子、无冲突重试、不按日重置。**
   命中：P2-5（台账 bill_no，被三个维度重复命中）、间接关联 P1-4 / P3-1 的并发窗口。
   `procurement-payment.ts` 与 `procurement-reconciliation.ts` 都已明文废弃这套并改为"当天最大号+1 + 唯一键冲突自增重试"，台账未跟进。**建议：把编号生成收敛成一个共享工具函数（或 DB 序列），全库统一。**

5. **"推财务/建应付"缺幂等与去重：按组聚合而非按批次/未推状态，且多入口无跨链互斥。**
   命中：P1-4（TOCTOU 重复应付）、P2-7（LG vs PR/DP 双轨）、P2-9（重复导入翻倍）、P3-2（新增行漏推）。
   这些都是同一设计缺陷的不同表现：**emit 无幂等 + 聚合口径错（按 supplier×order 组而非按行/批次/business key）**。**建议：财务契约层用统一业务键（供应商+内部订单号+料/批次）做幂等去重；推送前先"条件抢占回写"再 emit。**

6. **check-then-write TOCTOU 普遍缺锁。**
   命中：P1-4、P2-5、P3-1。读求和/读 count 与 insert 之间无事务/`FOR UPDATE`/advisory lock。**建议：涉及金额封顶、唯一编号、防重推的写入统一走 DB 侧原子校验或条件 UPDATE 抢占。**

7. **尺码拆分执行行与"整量同步"逻辑不一致（`.is('size', null)` 时加时漏）。**
   命中：P1-3（deductFromStock 漏加）、P2-2（重归并后陈旧行不清）。同一不变量在一个函数被遵守、在另一个被违反。**建议：把"尺码拆分行不得被整项标量覆盖"提取成共享的同步 helper，所有改 `ordered_qty` 的路径复用。**

8. **收货真相多入口不统一（goods_receipts 汇总 vs received_qty 直写），派生态（库存/料齐/应付）不跟随。**
   命中：P2-3（部分验收锁死）、P2-4（覆盖写被抹）、P2-8（退货不冲库存）。**建议：收敛到 goods_receipts 单一真相，received_qty 一律从其汇总派生，退货写负 receipt，禁止旁路直写。**

9. **改单只改 orders 标量，不下沉到 order_line_items 明细真相源。**
   命中：P2-11（quantity 改单）。富录入表订单的明细是生产/采购/PI 的真相源，改单不同步就静默错配。**建议：任何改 orders.quantity 的路径必须同步 line_items 或强制走已有的加单/子订单通道。**

10. **写路径做了 schema-drift 降级容错，读路径没对齐。**
    命中：P3-4（received_address 写降级、读硬选）。**建议：迁移滞后窗口内的容错要成对出现（读写都降级）。**

---

## 四、修复优先级清单（先做哪几条、为什么）

**第一批（本周内，堵钱和权限红线）：**
1. **P1-1 台账底价读/导出补角色门禁 + 收紧 RLS** —— 底价全员可导出，违反核心纪律，改动小（三个 action 加 `requireRoleGroup` + 一条 migration），收益最大。
2. **P1-3 deductFromStock 补 `.is('size', null)`** —— 一行修复，直接止住尺码拆分项成倍超采多付款，姊妹函数已有样板。
3. **P1-5 改单审批加自批拦截（approve + bulk）** —— 复用 `delays.ts:564` 口径，堵单人自批改价改量打穿应收。
4. **P1-2 materials_bom RLS 收紧** —— 与 P1-1 同一 migration 批次处理，消除"直连改 BOM 静默少采购 + 读预算成本"。
5. **P1-4 台账推财务改"条件抢占回写再 emit"** —— 消除重复应付/重复付款；与系统性问题 5、6 同一改法，一并做。

**第二批（两周内，数据一致性与内控）：**
6. **P2-6 fetchOrderRefs 实参修正** —— 一行修复，恢复财务按内部订单号归集（该功能当前完全失效）。
7. **P2-9 + P3-2 台账导入去重 + 推财务按未推行增量** —— 同根因一起改，堵翻倍推送和漏推少付。
8. **P2-5 台账 bill_no 改共享编号工具** —— 顺带覆盖 P3 层的同一缺陷。
9. **P2-1 goods_receipts RLS 收紧** —— 与第一批 RLS migration 合并做，避免多次迁移。
10. **P2-10 + P2-11 改单接线 per-field approvers + 同步 line_items** —— 恢复分级审批、消除生产/财务量错配。
11. **P2-8 退货同步冲库存 + received_qty** —— 消除幽灵库存和"料齐"误判。

**第三批（排期处理，健壮性/单据质量/边缘）：**
12. P2-2 重归并清陈旧尺码行、P2-3 部分验收不锁死、P2-4 覆盖写收敛单一真相、P2-12 延期自批+脏态。
13. P2-13 采购单 webp 破图、P2-14 台账解析器跳小计误伤 —— 影响供应商单据质量，改动局部。
14. P3-1 付款申请 TOCTOU、P3-3 退货超收 net_payable 负数、P3-4 received_address 读降级。
15. P3-5 收货对账单分页 —— **先确认 Supabase 项目 Max Rows 配置**，若已调高则可延后。

**批次编排理由**：第一批集中在"钱"和"权限"两条红线，且多条共享同一 RLS migration 与同一"条件抢占"改法，一次改多条收益最高；第二批集中清理台账链和改单链的数据一致性（这两块是本周新上线、问题最密集处）；第三批是不影响资金正确性的健壮性与报表口径，可随迭代处理。所有 migration 改动记得按项目纪律单独 commit 归档并在 Supabase SQL Editor 执行后逐条验证 PASS。

---

相关文件（绝对路径）：
- `/Users/ning/dev/order-metronome/app/actions/supplier-ledger.ts`（P1-1, P1-4, P2-5/6/7/9, P3-2）
- `/Users/ning/dev/order-metronome/app/actions/procurement-items.ts`（P1-3, P2-2）
- `/Users/ning/dev/order-metronome/app/actions/order-amendments.ts`（P1-5, P2-10, P2-11）
- `/Users/ning/dev/order-metronome/app/actions/procurement.ts`（P2-3, P2-4/P3 收货入口）
- `/Users/ning/dev/order-metronome/app/actions/procurement-reconciliation.ts`（P2-8, P3-3）
- `/Users/ning/dev/order-metronome/app/actions/procurement-payment.ts`（P3-1）
- `/Users/ning/dev/order-metronome/app/actions/delays.ts`（P2-12；自批样板在 :564）
- `/Users/ning/dev/order-metronome/app/actions/purchase-orders.ts`（P2-13）
- `/Users/ning/dev/order-metronome/app/actions/goods-receipt-export.ts`（P3-4, P3-5）
- `/Users/ning/dev/order-metronome/lib/services/fabric-ledger-parser.ts`（P2-14）
- `/Users/ning/dev/order-metronome/supabase/migration.sql`（P1-2, materials_bom RLS :877）
- `/Users/ning/dev/order-metronome/supabase/migrations/20260613_procurement_center_v1.sql`（P2-1, :130）
- `/Users/ning/dev/order-metronome/supabase/migrations/20260711_supplier_fabric_ledger.sql`（P1-1 RLS :63）
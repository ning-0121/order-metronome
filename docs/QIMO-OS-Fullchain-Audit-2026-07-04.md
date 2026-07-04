# 绮陌 OS 全链审计报告 · 2026-07-04

> 多agent跨三仓审计(araos客户开发 / 节拍器订单+采购 / 财务),对抗式复核。
> **CONFIRMED 17 · PLAUSIBLE 4 · REFUTED 3**。按维度归类,标注修复状态。


## araos→节拍器数据链

### [HIGH] (跨仓) araos/lib/metronome/client.ts:20
- **缺陷**:araos 把订单交接 POST 到 节拍器 /api/contract/v1/handoff/araos，但 节拍器 根本没有这个路由——整条 araos→节拍器 推送链指向一个 404 端点。
- **复现**:输入:业务在 araos confirmOrder→enqueueHandoff 建了一条 metronome_handoffs(status=pending)。worker cron 每分钟跑 processPendingHandoffs→pushHandoff 向 `${QIMO_CONTRACT_URL}/api/contract/v1/handoff/araos` 发签名 POST。节拍器 app/api/contract/v1 下只有 GET 只读路由(customers/quotes/orders/finance),没有 handoff/araos。结果:Next.js 返回 404。client.ts line 88-91 把 4xx 判为终态 REJECT(不重试),recordSettlement 记 REJECT。该 araos 订单永远不会在 节拍器 建单,且不再重试,静默黑洞。
- **建议**:要么在 节拍器 新建 POST /api/contract/v1/handoff/araos 写接口(withContract 目前只支持只读 handler,需扩展支持写),把 araos 订单落成 customer_po/order;要么把 araos 推送目标改为已存在的 ignite/PO 摄取入口。当前二者都不存在,必须先在 节拍器 建一个真正的 PO 摄取写端点。

### [HIGH] (跨仓) araos/actions/orders.ts:75
- **缺陷**:araos 交接的是 araos『orders』表(buildOrderPayload 读 orders),字段是 order_ref/product_lines/order_value_usd 等松散字段;而 节拍器 真正的订单真相是 customer_po(带 quote 快照/逐款明细/BOM)。两套订单模型互不相干,即使 handoff 端点存在,payload 也无法喂进 节拍器 的 PO→Order 快照派生管线。
- **复现**:输入:araos confirmOrder(orderId) → buildOrderPayload 从 araos orders 表取 product_lines(『style:qty:price』纯文本行解析而来,见 orders.ts line 17-22)。节拍器 createOrderFromPO 期望的是 customer_po + approved quote snapshot(getApprovedQuoteForCompare→buildLineItemsFromSnapshot 逐款色码×件数+布料)。两者字段结构完全不同:araos 无 quote_id/quote_snapshot_version/逐款色码明细。结果:即便补上 handoff 写端点,araos 的 order payload 也建不出合规的 节拍器 order(snapshot_gate 硬门会 fail 或明细/BOM 全空)。
- **建议**:统一订单真相入口:araos 应推 PO(带 quote 快照引用)而非松散 orders,或在 节拍器 摄取层把 araos payload 映射成 customer_po+quote snapshot。当前 araos orders 表与 节拍器 customer_po/quote 链是两条断裂的轨道。

### [HIGH] (跨仓) order-metronome/app/api/contract/v1/_lib/withContract.ts:24
- **缺陷**:节拍器 Contract API v1 架构上是纯只读:withContract 的 handler 签名只返回 {entityId,data}(读结果),araos key 的 scope 恒为 commercial.read。没有任何写/摄取 scope 或 handler 形态,导致 araos 的一切推送在契约层根本无处落地。
- **复现**:输入:araos 用 CONTRACT_KEY_ARAOS 签名想写数据进 节拍器。scopes.ts 只有 finance.read/commercial.read 两种 scope,araos 恒得 commercial.read(auth.ts line 34-36)。withContract(line 24-26)handler 只能返回读结果或 null(404),无写路径。结果:即使把 handoff 挂到 contract/v1 下,araos 也只有读权限、且 wrapper 不支持写语义。跨系统『建客户/建订单』这一写操作在契约层完全没有被设计出来——只做了 finance/araos 反向读快照,没做正向写摄取。
- **建议**:契约层需新增写 scope(如 commercial.write / handoff.ingest)与支持写的 handler 形态,再实现 handoff 摄取路由。否则 araos→节拍器 的写方向永远无法通过契约 API 实现。


## 采购全流程阶段机

### [HIGH] (节拍器) app/actions/procurement.ts:403
- **缺陷**:收货存在两套互相打架的真相：recordReceipt(对账Tab入口)覆盖写 received_qty 且不写 goods_receipts，而 recordReceiptBatch/recordGoodsReceipt 用 goods_receipts 求和回写 received_qty。两个入口作用于同一 procurement_line_items 行，互相抹掉对方的收货量。
- **复现**:同一采购行：仓库先用采购中心「收货登记」录一批 recordReceiptBatch(30)（插 goods_receipts 一行=30，received_qty=30）；随后有人在订单页「采购对账」Tab 用 recordReceipt(itemId, 100) 覆盖 → received_qty 被直接改成 100，但 goods_receipts 仍只有 30。反向更糟：先 recordReceipt(100)（received_qty=100，无 goods_receipts，库存 +100），再 recordReceiptBatch(30) → 汇总 goods_receipts 只得 30，把 received_qty 从 100 覆盖成 30，line_status 从 accepted 退回 arrived，同时 recordInventoryReceipt 算 delta=30−100=−70 写一条负入库流水，凭空抹掉 70 单位库存。采购单详情 getPurchaseOrder 读 goods_receipts 展示的批次历史与行 received_qty 永久对不上。
- **建议**:废除 recordReceipt 覆盖写入口，或让它同样 append 一条 goods_receipts 并用求和回写 received_qty，使三条收货入口共用 goods_receipts 单一真相。至少在 recordReceipt 里把 overReceiptCheck 的 prev 从固定 0 改为已存在的 goods_receipts 累计，并禁止在已有 goods_receipts 批次的行上做覆盖写。

### [MEDIUM] (节拍器) app/actions/procurement.ts:397
- **缺陷**:recordReceipt(对账Tab)在收齐/超发时直接把 line_status 置 accepted，绕过 arrived→accepted 的 AQL/质检验收闸（recordGoodsReceipt 的 pass/concession/reject 与状态机校验）。
- **复现**:采购行本应经「已送达待验收」→ QC 验收（recordGoodsReceipt 走 isValidLineTransition + AQL + 让步需 PM 审批）。但操作者在订单页采购对账 Tab 用 recordReceipt 录入等于/大于订购量的数 → line_status 直接跳到 accepted，离开 receive 队列，既不写 goods_receipts 也不做任何状态机/质检门校验，让步接收的 PM 审批与拒收退货路径被整体绕过。
- **建议**:recordReceipt 收货只应把行推进到 arrived（待验收），验收结论(accepted/concession/rejected)统一收敛到 recordGoodsReceipt 一个入口，保留 AQL 与让步审批闸。


## 权限/安全全链

### [HIGH] (跨仓) araos: lib/metronome/client.ts:82
- **缺陷**:araos→节拍器 派生 handoff POST 到一个节拍器根本不存在的端点 /api/contract/v1/handoff/araos,导致每个派生订单落成 REJECT/RECONCILE 黑洞
- **复现**:araos pushHandoff() 用 signedPostHeaders POST 到 process.env.QIMO_CONTRACT_URL + '/api/contract/v1/handoff/araos'。节拍器 app/api/contract/v1/ 下只有 4 个 GET 读端点(orders/customers/quotes/finance.order-snapshot),没有任何 handoff/intake 的 POST 路由。因此 araos 每次派生真实订单都收到 404 → 被 client.ts:88 当作 4xx 终态 REJECT → recordSettlement 写 REJECT → araos lib/qimo/settlement.ts interpretSettlement 返回 reconcile:true。结果:节拍器永远建不出这张订单,araos 侧永远显示'系统错误/待对账'。整条 araos→节拍器 自动派生链在网络层就是断的。
- **建议**:要么在节拍器新建带 withContract+POST 的 /api/contract/v1/handoff/araos 入站建单端点(HMAC 已就绪,复用 verifyContractRequest,写入 idempotency_key 唯一约束),要么在 araos 明确关闭 pushHandoff 自动链并保留手动 3 步。当前 lib/metronome/client.ts 无任何调用方(pushHandoff 无 caller),属'已接线但目标不存在'的隐雷:一旦有人接上 cron 就全线 REJECT。

### [HIGH] (araos) app/api/webhooks/qimo/settlement/route.ts:44
- **缺陷**:araos 建了 QIMO→araos 结算回调入站端点并让整个 RFU 执行态只由结算事件驱动,但节拍器从不发这个回调,导致所有已派生订单 24h 后被判 reconcile
- **复现**:araos settlement webhook + lib/qimo/settlement.ts 是 RFU 执行态的唯一真相源(§5/§12):araos 在 pushHandoff 成功时本地写 HARD_COMMIT(qimoState='accepted'),然后等节拍器回调 ACK(qimoState 变 in_production/shipped…)来推进。interpretSettlement 对 HARD_COMMIT 超过 ACK_SLA_HOURS(24h)未收到进一步事件 → staleCommit=true → reconcile:true。节拍器全仓 grep 无任何对 araos settlement 的出站调用(无 signedPostHeaders/无 OS_ARAOS_URL 出站 fetch)。所以即便 handoff 建单成功,节拍器也永不回发执行进度,araos 每张订单 24h 后一律翻成'需对账',closedWon 永为 false。
- **建议**:在节拍器订单生命周期关键节点(如进入大货生产/出运/完成)加一个出站 signed-POST 客户端,按 araos 契约口径(POST + body sha256 + x-timestamp + x-signature)回发 ACK/state 到 araos /api/webhooks/qimo/settlement。目前节拍器根本没有任何出站签名 POST 能力(lib 里只有入站 verify),需新建。

### [HIGH] (节拍器) app/actions/order-financials.ts:51
- **缺陷**:getOrderFinancials 只校验登录、不校验 CAN_SEE_FINANCIALS,把毛利/margin/成本/定金尾款全量返回;仅靠 RLS 兜底,而 RLS 的 owner 子句超授给非财务角色
- **复现**:getOrderFinancials(orderId) 用用户会话 select('*') from order_financials,返回 gross_profit_rmb / margin_pct / cost_* / deposit_* 全部字段,action 层无 CAN_SEE_FINANCIALS 门禁(对比同文件写函数 updateOrderFinancials/recordPayment 都硬校验 ['admin','finance'])。唯一防线是 migration 20260703_trial_security_rls_bom_images.sql 的 order_financials_select RLS,但该策略除财务组外还放行 orders.created_by = auth.uid() OR owner_user_id = auth.uid()。于是一个 production/qc/merchandiser 用户,只要被指派为该订单 owner_user_id,就能通过此 action 读到完整毛利率/成本/利润——而 CAN_SEE_FINANCIALS=[admin,finance,sales,sales_manager,order_manager] 明确不含这些角色。此外该 migration 属'待执行'集,若线上未跑,则表无 RLS,任意登录角色全读。
- **建议**:在 getOrderFinancials 开头加 hasRoleInGroup(roles,'CAN_SEE_FINANCIALS') 门禁(与 updateOrderFinancials 一致),非授权角色返回错误或剥离成本/利润字段;RLS owner 子句应收紧或与 action 层口径对齐,不能让'订单负责人'身份绕过财务可见性红线。

### [HIGH] (财务) src/app/api/integration/approve/route.ts:18
- **缺陷**:审批回写端点的集成调用路径只验静态 API Key、无 HMAC 签名/无时间戳,持有共享 key 即可伪造任意审批决定并回传节拍器
- **复现**:POST /api/integration/approve 若带 x-api-key 且 verifyApiKey 通过(isIntegrationCall=true),直接跳过前端的登录+admin/finance_manager 校验,拿 body 里的 approval_id/decision 更新 pending_approvals 并 sendApprovalToMetronome 回传节拍器执行审批结果。此路径无 verifySignature、无时间戳窗口(对比同仓 webhook 走 validateRequest 强制 HMAC+时间戳+幂等)。INTEGRATION_API_KEY 是跨系统共享静态 bearer,在每个 webhook/health 请求头里反复传输。任何拿到该 key 的一方(或抓到一次请求头)都能对任意 approval_id 提交 approved/rejected,并让决定通过 finance→metronome 回调链落到节拍器 pre_order_price_approvals/delay_requests/milestones,越权放行价格/延期/取消/里程碑审批。
- **建议**:集成路径也强制 HMAC 签名+时间戳(复用 validateRequest 口径),不要让'仅 API Key'成为审批这种高危写动作的唯一凭据;审批 body 应带 payload.timestamp 与 request_id 幂等。

### [MEDIUM] (节拍器) app/api/integration/finance-callback/route.ts:45
- **缺陷**:财务→节拍器审批回调只验 API Key + body HMAC,缺时间戳窗口和幂等,审批回调可被无限重放
- **复现**:verifySignature 只对 body 做 HMAC,POST 处理器全程不读 x-timestamp、不查 request_id 幂等。一个此前合法的 approved 回调(body+签名)被抓包后可原样重放任意多次:approval_type=price/delay/cancel/milestone 会反复把 pre_order_price_approvals/delay_requests/cancel_requests/milestones 置为 approved(milestone 还会写 actual_at 和 status='已完成')。对比财务侧 src/lib/integration/security.ts 的 validateRequest 已强制时间戳+DB 幂等(fin_inbox_events),节拍器这个反向回调是防重放的短板。一旦某次驳回后又想翻案,或攻击者重放旧的 approved,即可绕过当前审批状态。
- **建议**:在 finance-callback 加 x-timestamp ±5min 窗口校验(payload 已带 timestamp 字段,直接用)+ 基于 request_id 的幂等表/唯一约束,拒绝过期与重复请求,和财务侧 validateRequest 口径对齐。

### [MEDIUM] (财务) src/lib/integration/security.ts:79
- **缺陷**:verifyApiKey/validateRequest 用同一静态 INTEGRATION_API_KEY 作为跨系统总钥,一处泄露即三仓审批/同步全线可被冒充
- **复现**:INTEGRATION_API_KEY 同时用于:入站 webhook 的 verifyApiKey、approve 路径的集成鉴权、以及节拍器出站 webhook 头。它是单一共享静态密钥,无 keyId 区分、无轮换、无 per-consumer scope。任一系统的 env 泄露或一次请求头被截获,持钥方即可:向财务 webhook/approve 冒充节拍器,或向节拍器 finance-callback 冒充财务(finance-callback 甚至只需 key+可重放的旧签名)。注意契约 API(app/api/contract/v1)已升级为 per-consumer keyId+secret+scope 的更好模型,但老的 INTEGRATION_* 审批/同步链仍停留在单钥模式。
- **建议**:把审批/同步链迁移到与 contract v1 一致的 per-consumer keyId + 独立 secret + scope + 强制签名时间戳模型,或至少为审批这类高危写动作单独一把带签名的密钥,支持轮换。


## 采购数据实时到业务

### [HIGH] (跨仓) lib/integration/finance-sync.ts:248
- **缺陷**:收货(goods_receipts)从不通知财务——采购只在下单(placed)时同步一次应付,收齐/短缺/超收/让步接收全部不回财务,应付无法按实收冲销/核销。
- **复现**:采购在采购中心用 recordReceipt / recordGoodsReceipt / recordReceiptBatch(app/actions/procurement.ts:403、~855、~937)记收货并回写 received_qty,三条路径均无任何 finance-sync 调用;财务侧 webhook(财务系统 src/app/api/integration/webhook/route.ts)也没有 purchase_order.received / goods_receipt 事件分支。结果:一张 PO 全部收齐或严重短缺,财务看到的仍是下单时那笔应付,永远拿实际到货数据做付款审批=按过期/理论数据付款,短缺退款、超收补付、让步扣款都要人工发现。
- **建议**:新增 purchase_order.received / goods_receipt.recorded 事件:在三条收货写入成功后 fire-and-forget syncReceiptToFinance(po_no/line_id/received_qty/inspection_result);财务侧 webhook 增 case 按 line_id 冲销/核销应付。

### [HIGH] (节拍器) app/actions/purchase-orders.ts:318
- **缺陷**:无价版采购单 placed 时发 total_amount=null + amount_pending,后续补价从不 resync 财务,财务应付永远停在金额待定。
- **复现**:无价版 PO 下单:buildPurchaseOrderSyncPayload(finance-sync.ts:222)因 total_amount<=0 发 total_amount:null。之后采购在 app/actions/procurement.ts:711 给行填 unit_price(且从不回算 purchase_orders.total_amount,也不再调 syncPurchaseOrderToFinance——全仓仅 placePurchaseOrder 一处调用)。财务 fin_purchase_orders.total_amount 永远为 null,无任何补价信号。财务据此做付款计划/账期审批时金额缺失,付款闸依据过期空值。
- **建议**:补价 action(procurement.ts setLineStatus->ordered)成功后:回算该 PO total_amount 并调 syncPurchaseOrderToFinance(内容变→deterministicRequestId 新键→财务据 po_no 幂等更新应付金额)。

### [MEDIUM] (节拍器) app/actions/procurement.ts:1265
- **缺陷**:采购风险中心(缺料/供应商延期/催货停滞/质量拒收/价格异常)只读 nightly cron 物化的 procurement_matters,采购当天的催货/收货/状态变化最多滞后近 24 小时才进风险中心。
- **复现**:getProcurementMatters(app/actions/procurement.ts:1265)只 select procurement_matters,该表仅由 /api/cron/daily(vercel.json schedule '0 0 * * *',每天 0 点一次)调 materializeProcurementMatters 刷新。采购上午催货第 6 次(chase_stalled 阈值)、下午质量拒收,CEO/PM 打开风险中心看到的是昨夜 0 点快照——决策(要不要补采购/换供应商/预警交付)基于最长 ~24h 前的过期风险集。无 on-demand 或写后即刷。
- **建议**:在收货/催货/状态变更成功后 fire-and-forget 增量 upsert 对应 matter_key(或缩短 cron 频次并加手动刷新按钮);风险中心页提供即时重算入口。

### [LOW] (节拍器) app/actions/procurement.ts:424
- **缺陷**:收货完成不联动里程碑'materials_received_inspected'(交付置信度 medium 关键节点),也不触发 recomputeDeliveryConfidence,收齐后风险卡仍显示原料未到风险直到手工勾节点。
- **复现**:criticalNodes.ts:45 materials_received_inspected='medium' 参与交付置信度。收货三入口(recordReceipt 等)回写 received_qty、联动 procurement_item 状态、自动入库,但全仓无任何路径据收齐自动完成 materials_received_inspected 里程碑,也不 fire runtime_event。且无 nightly recompute confidence(仅 milestone_status_changed/delay_approved 才重算)。结果:原料实际全部到厂后,业务/管理在风险卡(RuntimeRiskCard)看到的交付置信度仍把'原料到厂检验'算作未完成的拖累项,直到有人手工勾里程碑,置信度与真实进度脱节。
- **建议**:收货收齐(line_status=accepted 且整单料齐)时自动完成 materials_received_inspected 里程碑并 recomputeDeliveryConfidence(materials_received),与 procurement_order_placed 的既有自动完成对齐。


## 订单↔采购模块流通

### [MEDIUM] (节拍器) app/actions/procurement-items.ts:127
- **缺陷**:库存抵扣(deductFromStock)只加 procurement_items.stock_deduct_qty,从不回写已生成的执行行 procurement_line_items.ordered_qty,导致对供应商重复采购已用库存抵扣的量。
- **复现**:采购项确认(confirmed)→ generateExecutionLines 生成 PLI(ordered_qty=orderableQty=定案量,含全量,因抵扣尚为0)→ 采购在编辑面板点「用库存抵扣」(deductStock→deductFromStock)。deductFromStock(第164-172行)只把 stock_deduct_qty 累加、更新 orderableQty 派生的 remaining 返回给前端提示,但对已存在的 procurement_line_items 一行未动。此时 PLI.ordered_qty 仍是抵扣前的全量,归采购单/导出采购单/下单发给供应商的数量都是全量 → 抵扣掉的那批库存被重复向供应商采购。UI(ProcurementItemsTab 第920-931行)只要有可用库存且该项被选中就显示抵扣按钮,不校验执行行是否已生成,故该顺序完全可达。consolidateOrderProcurementItems 里的执行行同步(第493-499行)只在重归并且总需求变化时触发,且只同步 purchase_order_id IS NULL 的行——单纯抵扣不会触发它,已归 PO 的行更永不同步。
- **建议**:deductFromStock 末尾对该 procurement_item_id 且 purchase_order_id IS NULL 的执行行按新 orderableQty 回写 ordered_qty(与 consolidate 第493-499行同款逻辑);已归入采购单的行(purchase_order_id 非空)则拒绝抵扣或改为标 needs_reconfirm 提示走补数量流程,绝不静默。

### [LOW] (节拍器) app/actions/supply-chain.ts:21
- **缺陷**:getOrderSupplyChainOverview 的四个状态桶漏了 ready_to_ship / rejected / cancelled 三个真实执行行状态,导致订单侧供应链概览统计与实际执行行状态不一致、有物料行从概览里凭空消失。
- **复现**:line_status 状态机(lib/domain/procurement.ts 第45-50行)可达 ready_to_ship('已完成待送货')、rejected(拒收)、cancelled(取消)。但 supply-chain.ts 第21-24行:PENDING={draft,pending_order}、TRANSIT={ordered,confirmed,in_production,shipped}(缺 ready_to_ship)、ARRIVED={arrived}、DONE={accepted,closed,concession}(缺 rejected/cancelled)。第79-83行按这四集合累加,任一执行行处于 ready_to_ship/rejected/cancelled 时不进任何一桶。结果:SupplyChainTab 五张统计卡(待下单/在途/已到厂/已验收)之和 < lines.length,一条『工厂已完成待送货』的行在订单侧供应链概览里既不在途也不到厂,业务/管理看订单时以为该料没进展,与采购工作台(procurement.ts 第1184行把 ready_to_ship 明确归『待送货』队列)两张皮。
- **建议**:把 ready_to_ship 并入 TRANSIT(或单列在途),rejected/cancelled 明确归类(rejected 可入需关注,cancelled 单列/排除);或改为『其余全部归 other 桶并展示』,确保四桶之和恒等于 lines.length,与 lib/domain/procurement.ts 的全量状态集对齐。


## PLAUSIBLE(跨仓无法完全证实,待确认)

- [HIGH] (跨仓) order-metronome/app/actions/order-from-po.ts:60 — 节拍器 订单由 customer_po 派生(createOrderFromPO 读 customer_po 表),但没有任何路由/流程把 araos 的客户或 PO 写进 节拍器 customer_po——PO 必须人手在 节拍器 里录。araos 侧完全没有 push customer_po 的代码。
- [LOW] (节拍器) order-metronome/app/api/contract/v1/customers/[id]/route.ts:15 — 共享 ID 脊柱只有『节拍器→读』一半:customers.source_araos_company_id 只被 contract GET 读出返回,没有任何写入路径填充它;orders 契约无 araos_order_id 回链字段。araos 无法按 araos_company_id 反查 节拍器 customer,双向对账断链。
- [LOW] (节拍器) app/actions/procurement.ts:384 — recordReceipt 的超收硬闸把 prev 写死为 0，忽略已存在的 goods_receipts 批次累计，导致相对真实累计收货的超收永远检测不到（配合它的覆盖语义）。
- [LOW] (财务) src/app/api/integration/webhook/route.ts:224 — 财务侧按 lines(fin_po_lines,line_id 对账锚点)做行级应付对账,但节拍器 placed payload 从不发 lines,该对账路径永远收到 0 行=死代码。


## 修复状态(2026-07-04)

- ✅ 批1(4882935):getOrderFinancials 财务泄露门禁 · supply-chain 漏状态桶 · deductFromStock 回写执行行
- ✅ 批2(411ea64):recordReceipt 收货双真相止血(已有批次禁覆盖写)
- ⏳ 待批3(节拍器):无价补价resync财务 · 收货回财务(需财务侧加handler) · recordReceipt跳质检闸 · 收货联动里程碑/置信度 · 风险中心24h滞后
- 🔨 大工程/需决策:**araos→节拍器 客户/PO 实时同步(当前完全没建通,推送指向404端点)** · 财务侧鉴权加固(HMAC/时间戳/幂等) · 财务不发settlement回调致araos订单24h reconcile

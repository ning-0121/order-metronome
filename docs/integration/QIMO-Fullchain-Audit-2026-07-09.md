# QIMO 三仓企业 OS 全链路审计报告

## Headline(整体健康度)

三套系统(araos 客户开发 / 节拍器订单 OS / 财务系统)**各自内部跑得通,但跨仓"数据链"多处只通了表层、没通到底**。链路看似闭合(webhook 全程 HTTP 200、数据落 inbox/明细表不丢),实则关键核销、审批写回、规格承接三处存在"假闭环"。**最要命的四条**:① **P0**——PI 形式发票查看/导出完全无价格门禁,客户成交价向生产/QC/仓库等无权角色泄露且可下载 Excel 外传;② **P1**——收货实收数据推到财务后**从不回冲应付**,short/超收/让步/拒收都不驱动应付调整,规模化必然系统性错付;③ **P1**——财务→节拍器的 price/delay/milestone 审批回写走**匿名 client**,被 RLS 静默挡成 0 行,审批永久丢失、订单卡死;④ **P1**——拒收批次(reject)被错计入 received_qty,污染库存+应付+"料齐"里程碑。此外财务侧审批 outbox 重试每天只跑一次,首发失败最长滞后近 24h。**结论:全链路尚未达生产级,收货→应付核销、跨仓审批写回是两个必须先补的硬洞。**

---

## ① 全链路数据流通(业务开发→执行→采购→生产→财务)

**结论:有洞。** "客户"这一段通了电,但"订单规格"和"收货核销"两段是断的——前者无数据桥(靠人肉重录),后者数据到财务却无人消费(空实现)。

- **P2 · araos→节拍器订单规格无接收方(承接链漏一环)**
  araos 推送体 `lib/metronome/payloads.ts:buildOrderPayload` 含 order_ref/product_lines/order_value_usd/required_delivery 等完整规格;但 QIMO 接收端 `app/api/contract/v1/handoff/araos/route.ts` 明确注释"不自动建 PO/订单",只做 customers upsert + 一条文本通知 + 落 `araos_handoffs_inbox.payload` JSON。全仓 grep `araos_handoffs_inbox|araos_link|araos_order_id`(除接收路由外)**零命中**;PO→Order 派生入口 `app/actions/order-from-po.ts:60` 绑 `quote_id`,与 araos 无 source 链接(grep 零命中)。
  **失败场景**:业务执行在节拍器建单时查不到中标单的 product_lines/数量/货值/交期,只有一条通知文本,必须切回 araos 人工抄录 → 规格漂移/漏项。
  **修法**:建单入口按 `customers.source_araos_company_id` 反查 inbox.payload 预填草稿(仍人工确认定价),或在客户页渲染 araos_link + 明细摘要。

- **P1 · 收货实收到达财务却从不回冲应付**(详见 ⑦,证据 `app/actions/procurement.ts:492/1086/1170` → 财务 `webhook/route.ts:347-380` 只写 `fin_po_lines.received_qty` 无人读)。这是"采购→财务"段最实质的断链:数据落库了,核销没发生。

- **P2 · reschedule 改的工厂交期 factory_date/warehouse_due_date 被财务丢弃**
  发送端 `lib/integration/finance-sync.ts:179-181` 明确带 factory_date(注释"财务需看到新交期");但财务 `handleOrderSync` 的 synced_orders upsert(`webhook/route.ts:655-678`)只映射 etd,财务 migrations 全仓无这两列,src/ 不引用 factory_date。
  **影响**:发送端声明的意图未兑现,工厂交期变更在财务侧静默丢失(死字段传输)。
  **修法**:财务加列并映射,或删掉发送端字段+误导注释。

- **P3 · mapPoLineForFinance 的 budget_bucket 被财务整体丢弃**
  `finance-sync.ts:268-269` 算 budget_bucket,财务 `handlePurchaseOrderPlaced`(`webhook/route.ts:278-296`)不含该字段,全仓 grep 0 命中,财务改用 category 自行归桶。当前同源无错算,属冗余+文档漂移。

---

## ② 预设功能完整性(端到端是否接通)

**结论:有洞。** 存在若干"两端都有消费代码、中间没有生产者/接收者"的幽灵能力和空实现。

- **P3 · delay.requested 审批回环有完整消费代码却无生产者(幽灵能力)**
  财务 `webhook/route.ts:184-185` handleDelayApprovalRequest 写 pending_approvals、节拍器 `finance-callback route.ts:126-137` 处理 approval_type='delay'、`finance-sync.ts:33` 含 'delay.requested';但全仓 grep 无任何 `sendToFinanceSystem('delay.requested'…)` 调用点——改期实际只走节拍器内部审批链(`app/actions/delays.ts:191/241`),从不推财务。两端各维护一段永不通电代码,误接线风险。
  **修法**:删两端 delay 死代码,或补发起端。

- **P3 · araos 订单型 handoff 字段与接收端 normalize() 不对齐**
  接收端 normalize() 读 d.quantity/d.contact_phone/d.shipping.country;但 `buildOrderPayload`(订单型)不发 contact_phone、不发 quantity、不发 shipping/country(仅 buildSamplePayload 样品型才发)。
  **失败场景**:订单型交接建的客户 phone=null/country=null,赢单通知因 quantity 恒空不显示件数;样品型却字段齐全——同一接收端两种 payload 表现不一致。

- **收货核销空实现**(见 ⑦ P1):`received_qty` 是死写、`fin_goods_receipts` 表仅存在于注释("待建",`webhook/route.ts:216/345`)从未建——预设的"按实收核销应付"功能端到端不成立。

---

## ③ 流通表格 & 生成格式/数据正确性

**结论:有洞,含一个 P0 泄露。** 多张对外/对内表格存在硬编码尺码、混单位合计、缺价静默漏计、以及最严重的价格越权导出。

- **P0 · PI 形式发票无价格角色门禁,客户成交价泄露给所有登录角色**
  `app/actions/order-pi.ts:186-191` exportPI 只校验登录、无 CAN_SEE_FINANCIALS 判断;getPI(`order-pi.ts:89-91`)同样。getPI 用普通会话读 `order_line_items` 把 `unit_price = po_unit_price`(`order-pi.ts:152`,注释明写"单价取客户 PO 成交价")返回,exportPI 原样写入 Excel L/M 列(`order-pi.ts:236-237`)。对照 CI(`shipping-docs.ts:35-36`)有 `canSeeFin` 门禁,PI 无——对称漏洞。`po_unit_price` 无列级 REVOKE(`20260706_order_line_po_price.sql` 只建列),RLS 只挡行不挡列;PI tab(`app/orders/[id]/page.tsx:417-441`)对所有角色无条件渲染。
  **失败场景**:生产/QC 用户打开任一可见订单点"🧾 PI"tab 或直调 exportPI,即得含每款客户成交单价+金额的可下载 Excel。违反 CLAUDE.md 价格红线。
  **修法**:exportPI/getPI 增加与 CI 一致的 canSeeFin 门禁,无权角色下发降级版或拒绝;PI tab 按 canSeeFinancials 条件渲染。

- **P2 · 生产单(PO 解析版)主表尺码列硬编码 S/M/L/XL,非标尺码被静默丢弃**
  `app/actions/generate-production-order.ts:226-236` 表头固定 S/M/L/XL,`:260-262` 只写这 4 key,`:258` 数量公式 `=E+F+G+H`;而 color.sizes 是任意 key 的 Record(`po-parser.ts:23`),同文件尺寸表 sheet 却用动态 sizeLabels(`:363-411`)——证明主表是硬编码缺陷。
  **失败场景**:尺码含 XXL 或数字码(36/38/40)时,该码件数不进任何列、总数少算;纯数字码单整张数量归 0,工厂裁错量。
  **修法**:主表尺码列按 data.size_labels 动态生成,数量公式按实际列区间 SUM。

- **P2 · 采购对账单"差异"列逐行是数量差、合计行却塞金额差**
  `app/actions/procurement.ts:687` 逐行写 `difference_qty`(数量差),`:709` 合计行同列写 `(totalReceivedAmt - totalOrderedAmt).toFixed(2)`(金额差),且未收货行 received_qty=null→receivedAmt=0 被整额扣减;`.toFixed(2)` 还使合计单元格变文本。
  **失败场景**:有未收货物料时,合计"差异"=巨大负数(把未到货整额订购金额算成差异),财务/供应商误判巨额短缺,且该合计非本列纵向求和、单位不一致。

- **P2 · CI 商业发票缺客户成交价的款被静默排除在总额外**
  `lib/services/shipping-docs.ts:116-118`:po_unit_price 缺失的款 amount=null,不进 ciTotals.amount 也不进单元格,但 qty 仍列在明细;合计(`:94`)只汇总有价款。
  **失败场景**:3 款中 1 款未录价 → TOTAL AMOUNT 仅为另 2 款之和,发票总额低于应收且无警示,报关/收汇金额不实。
  **修法**:缺价款阻断生成或显著标红提示,不静默跳过求和。

---

## ④ UI 交互便捷性

**结论:有洞。** 一处 P2 价格可见性泄露 + 若干误操作/死路。

- **P2 · "🛒采购核料"tab 把预算/成本(¥)暴露给 production_manager/qc/logistics(可见不可改)**
  `app/orders/[id]/page.tsx:110` 算出 canSeeFinancials 却未在此 tab 用;`:884-904` 仅按 isAdmin 分支,两支都显示价格;`:424` tab 导航无条件渲染;仅 `isProcurementOnly`(纯采购)才改道离开(`procurement-page-guard.ts:24-27`)。BomBudgetEntry 展示预算单价/加工费/辅料总价/自动面料预算,读取 action 无角色守卫、materials_bom RLS 为"登录可读"、budget_unit_price 无列级 REVOKE。CAN_SEE_FINANCIALS(`roles.ts:156`)不含这些角色。
  **注**:复核确认**篡改一侧已被服务端守卫封住**——saveBomBudgetUnitPrice(`:396-400`)/saveOrderStyleBudgets(`:450-454`)硬白名单,无价角色保存会被拒;故实际影响是内部预算金额对 3 个无价内部角色**只读可见**(非底价/毛利/非外部),故 P2 而非 P1。
  **修法**:该 tab 加 canSeeFinancials 门禁,读 action 补角色守卫。

- **P2 · 核料页聚焦单料(?item=)时批量确认仍操作整单全部物料**
  `components/tabs/ProcurementItemsTab.tsx:428-429` visibleItems 聚焦时仅 1 行,但 `:440` doneCount / `:450` bulkEligible / `:439` pendingItems 全基于整单 items;工具条"全选可批量确认(N)""批量确认"覆盖看不见的料。入口来自 `ProcurementQueueClient.tsx:63-67` 每行"📋任务单"带 ?item= 进来。
  **失败场景**:采购以为在操作聚焦这一款,点批量确认却把整单其它未在屏物料一并 confirm,无从核对。
  **修法**:聚焦时把计数/勾选限定在 visibleItems,或聚焦态隐藏批量工具条。

- **P3 · 收货"让步/拒收"前端不强制填缺陷说明**
  `components/ProcurementQueueClient.tsx:497-501` submit 仅校验 `qty>=0`,concession/reject 不校验 defect;`:505` placeholder 写"让步/拒收必填写清楚"却无 required 校验。审计留痕缺失、文案与校验不符。

- **P3 · 指派跟单人:候选为空/加载失败时下拉成死路**
  `components/MerchandiserAssign.tsx:20-26` 只 `if(res.data)`,无 error/空态;`:28-30` selectedId 空时静默 return;空态下每次 open 重复请求。用户无法判断是无人可选还是系统故障。

---

## ⑤ 权限设定是否安全准确

**结论:有洞(含 P0/P1)。** 见 ③ 的 PI P0 与 ④ 的核料 tab P2;跨仓写回还有一个 P1 的匿名 client 漏改。

- **P1 · 财务→节拍器 price/delay/milestone 审批回调走匿名 createClient(),被 RLS 静默挡成 0 行,审批写回永久丢失**
  `app/api/integration/finance-callback/route.ts:108` `const supabase = await createClient()`(ANON+cookies,webhook 无登录 cookie → auth.uid()=NULL)。三分支都用它写:price(`:113-124` 更新 pre_order_price_approvals)、delay(`:126-137` delay_requests)、milestone(`:156-179` milestones);而 cancel(`:142-143`)/purchase(`:184-185`)已改 `createServiceRoleClient()`——漏改不一致。对应 RLS 均要求 auth.uid() 非空:pre_order_price_approvals 仅 admin(`20260519…:120-132`)、delay_requests 仅负责人/admin(`ADD_roles_array.sql:44-58`)、milestones 仅 owner/角色/admin(`:16-28`)。匿名 → 三条 UPDATE 命中 0 行。
  **失败场景**:财务批准价格/延期/里程碑 → 合法 HMAC 回调 → 匿名 client update 命中 0 行 → 落入 skipLog"非待审批,跳过"返回 200 → 财务侧标 decided,节拍器侧永停 pending,milestone 分支 recomputeDeliveryConfidence 也永不触发。全程静默像正常幂等跳过。price 还是建单前置门禁,直接堵订单启动。
  **修法**:三分支统一改 createServiceRoleClient()(与 cancel/purchase 一致),保留 `.eq('status','pending')` 做幂等,写回后补触发 recompute/通知,用真实回调验证影响行数>0。

- **P3 · getOrder 异常分支 fail-open(保守放行),与全局 fail-safe 鉴权口径相反**
  `app/actions/orders.ts:1053-1056` catch 块 return { data: order } 放行;对比 `orderAccess.ts:34-36` canUserAccessOrder 异常 return false。当前被 orders_select_v2 RLS 兜底不可利用,但一旦放宽 SELECT RLS 即成唯一越权口子;注释"保守放行"措辞误导。
  **修法**:异常分支改 fail-safe 拒绝或复用 canUserAccessOrder。

---

## ⑥ 通知 & 审批是否即时可达

**结论:有洞。** 反方向(财务→节拍器)审批回环即时性不达生产级:重试节奏严重不对称、审批扇出缺实时推送、幂等状态闸阻断重试、死信无人告警。

- **P1 · 财务→节拍器审批回传 outbox 重试每天只跑一次(`0 1 * * *`),首发失败停摆近 24h**
  财务回传失败落 outbox(`src/lib/integration/client.ts:77-81`),retryFinanceOutbox(`client.ts:87`)**唯一调用点**是 `cron/orchestrate/route.ts:131`,而财务 `vercel.json` crons 只注册 orchestrate schedule=`0 1 * * *`。对照节拍器 processFinanceOutbox 由 `cron/reminders/route.ts:51-52` 调、注册 `*/15 * * * *`——两向节奏严重不对称。UI 仅弹"稍后可重推"toast 却无对应重推路由/按钮(人工兜底更弱)。
  **失败场景**:财务批准 ≥¥5000 采购单(同步 await 回传),此刻节拍器冷启/部署/抖动 → 落 outbox → 财务侧已 approved 但节拍器 approval_status 仍 pending、PO 从未 place、供应商从未下单 → 等次日 01:00 才补投,最长滞后近 24h,期间采购/生产被卡且无告警。
  **修法**:财务加一条高频 cron(`*/15 * * * *`)专跑 retryFinanceOutbox,与节拍器对齐。

- **P2 · 审批扇出 notifyUsersByRole 只写站内通知,不发邮件也不推企微**
  `lib/utils/notifications.ts:121-149` 只做 notifications 表 insert(email_sent:false),不调 sendEmailNotification 也不调 wechat-push。所有审批待办都走它:采购≥¥5000 待审(`purchase-orders.ts:751`)、风险闸(`:805`)、改期(`delays.ts:241`)、取消回通知(`finance-callback route.ts:203/219`);对照逾期升级链(`cron/reminders/route.ts:216/343/443`)都调 pushToUsers 推企微。
  **失败场景**:¥8000 采购单提交审批,审批人当时没登录节拍器 → 无邮件无企微 → 只有站内红点,采购单久卡。
  **修法**:notifyUsersByRole 对审批类 type 追加 pushToUsers 企微推送。

- **P2 · 采购审批"批准"先翻 approved 再下单,placeCore 首发失败后被状态闸挡死 → PO 批而不下**
  `finance-callback route.ts:190-200`:先 update approval_status='approved' WHERE pending(命中1行),再 placePurchaseOrderCore;若 pr.error 则 throw 500。`placeCore.ts:16-18` 初始 status→placed 失败返回 error(status 仍 draft)。财务次日重投,但 `:192` gate 命中 0 行(已 approved)→ `:196` 打印"非 pending,跳过(幂等)"→ placeCore 再不被调。
  **失败场景**:approval_status 置 approved 成功但 placeCore 遇瞬时 DB 错 → 抛 500 → 重投被幂等闸跳过 → PO 停在 approved/draft,从未下单、从未 emit purchase_order.placed、供应商从未收到,无告警。
  **修法**:下单成功后再翻 approval_status,或重试判据基于"approved 且 status=draft";至少 pr.error 分支回滚 approval_status 回 pending。

- **P3 · 两侧 outbox 耗尽置 dead 后只 console.log,无人告警**
  财务 `client.ts:102-108`/orchestrate `:132` 仅 console.log;节拍器 `finance-sync.ts:147-148`/reminders `:48` 仅返回计数。无 notifications/WeCom 告警。审批彻底投递失败后成无人知晓的死行,放大 P1 后果。
  **修法**:转 dead 时给 admin/finance 发站内+企微告警,或纳入 runIntegrityCheck 红线。

- **P3 · araos handoff 幂等只认已写入 processed 行,处理中失败/并发重投会重复触发赢单通知**
  `handoff/araos/route.ts` step3 幂等短路条件是 `existing.status==='processed' && qimo_customer_id`,而该标记只在 step6 末尾写入;step4(建客户)先于 step5(通知)先于 step6。araos 侧 pushHandoff 对 5xx 重试(MAX_ATTEMPTS=5)。
  **失败场景**:step4 建客户后、step6 落库前抛错 → 500 → araos 重试 → step3 查不到 processed → step5 再次 notify → 业务收到重复"araos 赢单"通知;company_id 缺失/非 UUID 时极端并发下 step4 走 ilike 姓名匹配可能重复建客户。
  **修法**:进入处理前先 upsert `status='received'`(onConflict araos_order_id)抢占幂等锁,并对 customers 加唯一约束。

---

## ⑦ 财务归集是否达生产级

**结论:不达。** 离生产级差三件事:**① 收货→应付冲销整环缺失(最致命)**、② 拒收批次污染实收、③ 预算确认后实际价被冻结。

- **P1 · 收货核销未通电:应付按理论下单量登记,实收永不冲销,received_qty 是死写**
  节拍器三收货入口(`procurement.ts:492/1086/1170`)发 goods_receipt.recorded 携 received_qty_total;财务 handleGoodsReceiptRecorded(`webhook/route.ts:347-380`)把实收写入 `fin_po_lines.received_qty`。但全仓 grep received_qty **只有写入处、无任何读取点**(死写);`fin_goods_receipts` 仅存在于注释(`:216/345` "待建")从未建。真实应付台账 cost_items 仅来自手工录入(`costs/page.tsx:386/460/514`、ExcelImportDialog、executor),"登记为费用"是人工把 PO 下单额 total_amount 填成 cost_items 并置 fin_status='registered'(`costs/page.tsx:571-575`);应付页 `payables/page.tsx:156-194` unpaid=Σcost_items−付款(按供应商名匹配),与实收毫无关联。
  **失败场景**:下单 1000m @¥10=¥10000 登记应付,实到 600m,received_qty_total=600 推财务写 fin_po_lines 后无人读,应付仍 ¥10000 → 对短装多付 ¥4000;超收/让步同理不冲销。
  **离生产级差什么**:整个"实收→应付冲销"环。规模化后任何短装/超收/退货都需人工在 cost_items 手改才不错付。
  **修法**:建 fin_goods_receipts(或直接用 fin_po_lines.received_qty)驱动应付,登记费用时按 min(已收,已订)或实收入账;至少让 payables 计算消费 received_qty;付款界面对 received_qty≠ordered_qty 的行做红黄提示。

- **P1 · 拒收批次(inspection_result=reject)被计入 received_qty → 污染库存/应付/"料齐"里程碑**
  `procurement.ts:1032-1035` 超收闸刻意排除拒收(`.neq('inspection_result','reject')`),但紧接着回写(`:1063-1065`)对同表求和**未排除拒收**,`:1067-1069` update received_qty=totalReceived(含拒收)。三处下游读该污染字段无兜底:① `inventory.ts` recordInventoryReceipt(`:31/35/42/59`)把拒收料当良品入库;② `procurement-items.ts:1208/1226/1233` 据 received>=ordered 自动完成 materials_received_inspected 里程碑并重算风险卡;③ `procurement.ts:1087-1089` 送财务 received_qty_total=totalReceived。拒收仅置 return_status='pending'(`:1058`),无任何路径把 received_qty 归零。
  **失败场景**:ordered=1000,QC 判 reject 实收 300 → received_qty 被写 300 而非 0 → 300 拒收料入库+按 300 核销应付+若顶到 ordered 则误判"料齐"推进订单。与系统自身超收闸口径自相矛盾。
  **修法**:回写 received_qty 与超收闸同口径 `.neq('inspection_result','reject')`(或只累加 pass/concession)。

- **P2 · 预算单一旦离开 draft,采购实际价永不再同步 → 预算 vs 采购价对账被冻结**
  财务 handleOrderBudgetUpdated(`webhook/route.ts:579-580`)`if (bo.status !== "draft") return { action:"ok" }` 直接丢弃;handleQuotationFrozen 同闸(`:415-416`)。而节拍器把"实际采购价"(actual_fabric/accessory/cmt)与预算打包在同一 order.budget_updated 事件发送(`quote-baseline.ts:399-417`),实际价天然发生在预算之后;财务实际值落 `_cost_breakdown._actual_*`(`route.ts:601-603`)。budget_orders 会被 confirm 成 confirmed/locked。
  **失败场景**:财务先确认预算锁定计划,之后采购填真实单价 → 事件命中 status!=='draft' 静默丢弃 → _actual_* 停留确认时刻(常为空)→"预算 vs 采购价差额"实际列缺失/过期,超支不可见。这是财务归集头号卖点。
  **修法**:actual_totals 写入与 draft 门禁解耦(即使已确认仍允许更新 _actual_*,不动预算标量),或走单独"实际回填"通道留痕。

- **P3 · 加工费"实际"恒等于"预算",processing 桶差额永远为 0**
  `quote-baseline.ts:415` `actual_cmt_amount: cmtTotalAmt`,而 cmtTotalAmt 正是预算加工费(`:366`),同一变量;财务 `route.ts:508/512` 分别落 processing 与 _actual_processing 必然相等。三桶对账里加工桶的"预算 vs 实际"是装饰性的。若未来加工费需真实回填,须另接生产/结算端来源;否则 UI 标注"同预算(采购不另议)"避免误读。

---

## P0 / P1 修复优先级清单

| 优先级 | 问题 | 涉及仓 |
|---|---|---|
| **1 · P0** | PI 形式发票无价格门禁,客户成交价泄露+可下载 Excel(getPI/exportPI 加 canSeeFin,PI tab 条件渲染) | 节拍器 |
| **2 · P1** | 财务→节拍器 price/delay/milestone 审批回调走匿名 client 被 RLS 挡 0 行(三分支改 service-role) | 节拍器 |
| **3 · P1** | 收货→应付核销整环缺失,received_qty 死写、应付按理论下单量(建 fin_goods_receipts 驱动应付/让 payables 消费实收) | 财务(+节拍器发送端已通) |
| **4 · P1** | 拒收批次被计入 received_qty,污染库存/应付/料齐里程碑(回写 received_qty 排除 reject) | 节拍器 |
| **5 · P1** | 财务审批 outbox 重试每天只跑一次,首发失败停摆近 24h(加 `*/15` 高频 cron 跑 retryFinanceOutbox) | 财务 |
| **6 · P1** | araos→节拍器订单规格无接收方,建单靠人肉重录(建单入口反查 inbox.payload 预填草稿) | 节拍器 |

> 说明:P0 的 PI 泄露与 #2 匿名 client 修法明确、影响面直接,应最先动;#3/#4 属资金/库存正确性核心,须一并规划(#4 是 #3 的数据前置,建议同批修)。P2/P3 项(核料 tab 只读泄露、采购对账/CI 表格口径、审批推送通道、预算冻结等)可在上述 P0/P1 落地后按 ③④⑥⑦ 分节顺序处理。

---

## 附:全部存活发现明细(JSON)

```json
[
 {
  "severity": "P1",
  "dimension": "全链数据流通/收货→应付核销断链",
  "title": "收货实收数据到达财务但从不回冲应付/采购单金额 —— 应付永远按订购量、短装即多付",
  "evidence": "节拍器三个收货入口都 fire syncGoodsReceiptToFinance:app/actions/procurement.ts:492-495(recordReceipt)、1086-1089(QC 验收)、1170-1176(批量收货),line_id=procurement_line_items.id 与 PO 明细同源。财务 handleGoodsReceiptRecorded(财务系统 src/app/api/integration/webhook/route.ts:347-380)只 update fin_po_lines.received_qty/inspection_result,全函数不写 payable_records、不改 fin_purchase_orders.total_amount;route.ts:215-216、344-345 注释自认『按实收核销应付待建 fin_goods_receipts 表后做』。应付金额建立于 PO placed 时的 total_amount(ordered),此后短收/超收/让步接收/拒收永不驱动应付调整。",
  "failure_scenario": "某采购单订 1000m 面料建应付 ¥10000,实到 600m(短装 400m)。节拍器把 received_qty_total=600 推财务,财务只把 600 写进 fin_po_lines.received_qty,应付仍 ¥10000。财务按订购量付款 → 多付 ¥4000,且无任何差异告警。",
  "impact": "采购付款与实收脱节,短装系统性多付、超收系统性少计,收货→应付这一环在财务侧实为空实现;链路看似闭合(HTTP 200、数据落 fin_po_lines/inbox 不丢)实则核销未发生。",
  "fix_hint": "财务侧在 handleGoodsReceiptRecorded 内按 line_status/received_qty 生成应付调整(短收冲减、超收补提、拒收全冲),或建 fin_goods_receipts 表驱动应付重算;在此之前应在财务付款界面对 received_qty≠ordered_qty 的行做红黄提示,避免按理论量放款。",
  "_dim": "dataflow-idlinkage",
  "verdict": {
   "real": true,
   "severity_adjusted": "P1",
   "reason": "证据核对成立。节拍器三条收货入口(procurement.ts recordReceipt ~490-495 / QC验收 ~1086-1089 / 批量收货 ~1170-1176)确实 fire syncGoodsReceiptToFinance,传 received_qty_total + line_status/inspection_result。财务 handleGoodsReceiptRecorded(webhook route.ts:344-380)只 update fin_po_lines.received_qty/inspection_result/received_at,全函数不碰任何应付/成本/PO金额;route.ts:215、344 注释亲口承认「按实收核销应付待建 fin_goods_receipts 表后做」。关键复核:全财务仓 grep received_qty 除该 webhook 写入点外零消费(payables/payments 页从 costs 表按预算/订购量 c.amount·unit_price×qty 取数,完全不读 received_qty),故短装/超收/让步/拒收均不驱动应付调整,付款界面也无 received≠ordered 红黄提示。收货→应付这一环在财务侧确为空实现,链路看似闭合(HTTP200、数据落 fin_po_lines/inbox)实则核销未发生。轻微不准:标题称应付建立于 PO placed 的 total_amount,实际应付源自 costs 表(预算派生)而非 fin_purchase_orders.total_amount,但不影响核心结论(实收永不回冲应付、无差异告警)。按\"链路漏一环/功能不达生产级\"判 P1 成立。"
  }
 },
 {
  "severity": "P2",
  "dimension": "口径漂移/订单交期字段断链",
  "title": "reschedule 改的工厂交期 factory_date、warehouse_due_date 推给财务却被 handleOrderSync 丢弃",
  "evidence": "发送端 lib/integration/finance-sync.ts:179-181 明确带上 factory_date(注释『审计#2:重排改的是工厂日,财务需看到新交期』)、warehouse_due_date;app/actions/reschedule-order.ts:252-253 调 syncOrderToFinance 并注释『载荷已含 factory_date/etd/warehouse_due_date』。但财务 handleOrderSync 的 synced_orders upsert(财务系统 src/app/api/integration/webhook/route.ts:655-678)只映射 etd,不含 factory_date/warehouse_due_date;财务 migrations 全仓 grep 无这两列(仅 20260516_synced_orders_quotation.sql 加了 quotation_data/quotation_applied_at),src/ 全代码不引用 factory_date。",
  "failure_scenario": "订单重排把工厂交期从 6/1 改到 7/1(etd 不变或同步改),节拍器推 order.updated 含新 factory_date;财务只更新 etd 视图,工厂交期字段无处落库,财务侧任何按工厂交期排的付款/备料计划看不到变更。",
  "impact": "发送端声明『财务需看到新交期』的意图未兑现,工厂交期变更在财务侧静默丢失;当前财务不消费该字段故无直接错账,属口径断裂+死字段传输。",
  "fix_hint": "若财务需要工厂交期:给 synced_orders 加 factory_date/warehouse_due_date 列并在 handleOrderSync upsert 中映射;若确实不需要,删掉发送端这两个字段与误导性注释,避免『推了没人收』的假象。",
  "_dim": "dataflow-idlinkage",
  "verdict": null
 },
 {
  "severity": "P3",
  "dimension": "两套采购对象一致性/冗余字段",
  "title": "mapPoLineForFinance 计算的 budget_bucket 被财务 fin_po_lines 落库整体丢弃",
  "evidence": "发送端 lib/integration/finance-sync.ts:268-269 为每行算 budget_bucket = category==='fabric'?'fabric':'accessory',注释『财务按 budget_bucket 汇总预算』。财务 handlePurchaseOrderPlaced 的 fin_po_lines 行映射(财务系统 src/app/api/integration/webhook/route.ts:278-296)不含 budget_bucket 字段;财务全仓 grep budget_bucket 无任何引用(0 命中),财务实际改用 fin_po_lines.category 自行归桶。",
  "failure_scenario": "发送端与财务对『非 fabric 归辅料』的归桶口径若将来分叉(如新增 lining/packing 类目),两侧各自 category 判断可能不一致,而本应作为单一真相的 budget_bucket 未落库,无法作为对账锚点。",
  "impact": "传输冗余+发送端注释与财务实现不符;当前 category 同源故预算归桶结果一致,无实际错算,属轻微口径冗余与文档漂移。",
  "fix_hint": "要么财务 fin_po_lines 增列存 budget_bucket 并以它为归桶权威,要么删除发送端该字段与注释,让 category 成为唯一归桶依据,消除双口径隐患。",
  "_dim": "dataflow-idlinkage",
  "verdict": null
 },
 {
  "severity": "P1",
  "dimension": "收货核销正确性(短缺/让步/超收回财务)",
  "title": "拒收批次(inspection_result=reject)被计入 received_qty → 污染库存/财务应付/原料到厂里程碑",
  "evidence": "app/actions/procurement.ts:1032-1035 超收闸刻意排除拒收:`.select('received_qty').eq('line_item_id', lineItemId).neq('inspection_result', 'reject')`;但紧接着的回写(1063-1065)对同一表求和时**没有**排除拒收:`const { data: receipts } = await (supabase.from('goods_receipts')).select('received_qty').eq('line_item_id', lineItemId); const totalReceived = (receipts||[]).reduce(...)` → 1067-1069 `update({ line_status: nextStatus, received_qty: totalReceived })`。随后 1075 `recordInventoryReceipt(lineItemId)` 读该 received_qty 增量入库;1087-1089 `syncGoodsReceiptToFinance({ received_qty_total: totalReceived, ... })` 回财务核销。",
  "failure_scenario": "某采购行 ordered_qty=1000,QC 走 recordGoodsReceipt 判 result='reject' 实收 300(应退货 return_required=true)。写库时 received_qty 被写成 300(而非 0):① inventory.recordInventoryReceipt 把 300 拒收料当良品入库;② 财务收到 goods_receipt.recorded received_qty_total=300,按 300 核销应付/准备付款;③ 若拒收量把累计顶到 ordered,syncProcurementItemReceivingStatus(procurement-items.ts:1225-1234)据 received>=ordered 自动完成「原料到厂检验」里程碑,订单当作料齐推进。",
  "impact": "拒收/退货的原料被同时错记进库存、应付和交付里程碑;付了不该付的钱、库存虚高、风险卡误判料齐。与系统自身超收闸对拒收的口径自相矛盾。",
  "fix_hint": "回写 received_qty 时与超收闸同口径,过滤掉 reject:`.neq('inspection_result','reject')`(或只累加 pass/concession)。同步保证 recordInventoryReceipt 与 syncGoodsReceiptToFinance 拿到的是「验收合格实收」而非含拒收的毛实收。",
  "_dim": "chain-procurement",
  "verdict": {
   "real": true,
   "severity_adjusted": "P1",
   "reason": "证据全部核对属实。procurement.ts:1032-1035 超收闸用 .neq('inspection_result','reject') 明确排除拒收(注释1031「拒收本就不入账退货」);但1063-1065 回写汇总对同表求和未加该过滤,1068 写入 received_qty=totalReceived(含拒收)。三处下游均读该被污染字段且无兜底:①inventory.ts:31/35/42/59 recordInventoryReceipt 直接读 line.received_qty 计 delta 入库,无 reject/line_status 过滤→拒收料当良品入账;②procurement-items.ts:1208 汇总 received_qty、1226 received>=ordered→1233 自动完成 materials_received_inspected 里程碑并重算风险卡;③procurement.ts:1087-1089 送财务 received_qty_total=totalReceived,finance-sync.ts:446 原样转发,单条 inspection_result 无法拆分累计中的拒收量。拒收仅置 return_status='pending'(1058),无任何路径把 received_qty 归零或冲销库存/财务/里程碑,污染持久。系统与自身超收口径自相矛盾。真实触发条件=QC 走 recordGoodsReceipt 判 result='reject' 且 received_qty>0(1029 仅挡<0),为现实负路径。严重度维持 P1:触发受限于拒收路径,但命中即造成库存虚高、错误应付/付款、交付里程碑误判料齐。"
  }
 },
 {
  "severity": "P2",
  "dimension": "审批闸(≥¥5000/超预算)可被绕过",
  "title": "勾选「价格待定」的采购单以 total_amount=0 走完下单,彻底绕过 ≥¥5000 财务审批 + 预算闸",
  "evidence": "app/actions/purchase-orders.ts:648-665 当 price_tbd=true 时跳过「每行必须有底价」的价格闸直接放行;而 total_amount 在 createPurchaseOrder(135-139)由行 ordered_amount(=ordered_qty×unit_price 生成列)求和,价格待定时 unit_price 为 null → total_amount=0。下单时 694 `if ((Number(po.total_amount)||0) >= 5000)` 永不命中,769-775 风险闸 totalAmount 也为 0、price_baseline/unit_price 均 null 无偏离,computeBudgetGate 的 ordered_amount 为 0 → decision.needsApproval=false → 815-817 直接 place。",
  "failure_scenario": "采购对一张真实价值 5 万的采购单勾「价格待定」,下单时 total_amount=0,既不触发 ≥¥5000 外部财务审批,也不触发内部大额/偏离基线/超预算闸,approval_status 直接置 not_required 并 placed。事后经 transitionProcurementLine→ordered 补价,total_amount 被重算并 resync 财务(procurement.ts:880-889),但**不再触发任何审批**(单已 placed)。",
  "impact": "任意采购员用一个勾选即可让任意金额的采购单跳过全部审批治理,事后补价也不会补审批,财务/采购经理审批闸形同虚设。",
  "fix_hint": "price_tbd 单下单时改用「预估额」评估审批(如按 price_baseline×ordered_qty 或报价基线估值)再判 ≥¥5000/预算;或强制 price_tbd 单一律进审批队列;并在事后补价把 total_amount 顶过阈值时补触发审批。",
  "_dim": "chain-procurement",
  "verdict": null
 },
 {
  "severity": "P2",
  "dimension": "取消订单级联作废采购行(跨订单合并单)",
  "title": "跨订单共享采购单被取消其中一单时,total_amount 不重算、已下单单不对被作废行做财务应付冲销",
  "evidence": "lib/repositories/ordersRepo.ts:877-892 finalizeCancelledOrder:对 `contains('order_ids',[orderId])` 的 PO,若 remain=order_ids 去掉本单后仍非空 → 只 `update({ order_ids: remain })`(886-887),**不改 total_amount**;890-892 把本单的执行行 line_status 置 cancelled。全程只对 approval_status='pending' 的 PO 调 cancelPurchaseOrderApproval(900-901),对已 placed 的共享单的被作废行没有任何 goods_receipt/应付冲销事件发给财务;total_amount 仍含被取消订单的金额。",
  "failure_scenario": "一张 B3 跨订单合并采购单同时服务订单 A、B 且已 placed(应付已按 A+B 全额建账)。取消订单 A:A 的执行行被 cancelled、order_ids 收缩为 [B],但 purchase_orders.total_amount 仍是 A+B;财务侧只收到「订单A已取消」通知(含 po_nos),PO 本身对 B 仍有效,财务无从得知该冲销 A 的那部分应付。",
  "impact": "共享采购单的应付与订单实际发生错位——要么财务整单撤销少付 B,要么保持全额多付 A 的份额;QIMO 侧 total_amount 长期虚高,采购流水/成本核算口径失真。",
  "fix_hint": "remain 非空时按被作废行重算 total_amount 并对已 placed 单发送针对被取消订单份额的应付冲销事件(line 级),而非仅整单通知;pending 与 placed 两种状态都要处理财务侧。",
  "_dim": "chain-procurement",
  "verdict": null
 },
 {
  "severity": "P2",
  "dimension": "采购流水对账口径漂移",
  "title": "exportProcurementLedger 用中文状态字面量过滤,而 purchase_orders.status 存英文 → 草稿/已取消采购单未被排除,对账金额虚高",
  "evidence": "app/actions/purchase-orders.ts:262-263 `else poq = poq.not('status', 'in', '(\"草稿\",\"已取消\")')`;但 status 全程存英文:createPurchaseOrder 151 `status:'draft'`、placeCore 17 `'placed'`、finalizeCancelledOrder(ordersRepo.ts:885)`'cancelled'`。中文字面量永不匹配英文值 → 排除条件失效,草稿(从未真正下单)和已取消采购单一并进入「采购流水对账」导出;同理传入 params.status 若为英文也无对应中文可选。",
  "failure_scenario": "财务做月度对账导出采购流水(不传 status,期望排除草稿/已取消)。系统实际把该时段所有 draft(还没发供应商)、cancelled(已作废)采购单的明细都列进流水与供应商小计/总计。",
  "impact": "对账银行流水口径把未下单/已取消金额算进供应商应付合计,财务据此对账会多算,与真实已下单采购不符。",
  "fix_hint": "把过滤改成英文:`.not('status','in','(\"draft\",\"cancelled\")')`(状态是字符串数组时注意 in 的引号格式),并核对 params.status 传参口径统一为英文枚举。",
  "_dim": "chain-procurement",
  "verdict": null
 },
 {
  "severity": "P1",
  "dimension": "财务归集-应付收货核销",
  "title": "收货核销未通电:应付按下单(理论)量登记,实收永不冲销,received_qty 是死写",
  "evidence": "节拍器三个收货入口(app/actions/procurement.ts:492/1086/1170)发 goods_receipt.recorded,携 received_qty_total。财务侧 handleGoodsReceiptRecorded(财务系统/src/app/api/integration/webhook/route.ts:347-380)把实收写入 fin_po_lines.received_qty。但全仓 grep received_qty 只在 webhook 写入处出现、无任何读取点(确认死写);fin_goods_receipts 表仅存在于注释(webhook/route.ts:216/345「待建」),从未建。真实应付台账是 cost_items,其 insert 仅来自手工录入(costs/page.tsx:386/460/514、ExcelImportDialog.tsx:256、executor.ts:396),从不来自 fin_po_lines/fin_purchase_orders。PurchaseOrderInbox 的「登记为费用」是人工把 PO『下单额』(total_amount)填成 cost_items(costs/page.tsx:571-575 置 fin_status='registered')。应付页 payables/page.tsx:156-194 unpaid = Σcost_items − 付款(按供应商名匹配),与收货实收毫无关联。",
  "failure_scenario": "采购单下单 1000m 面料 @¥10=¥10000,财务在采购单工作台『登记为费用』记 ¥10000 应付。实到 600m(短装),节拍器发 goods_receipt.recorded received_qty_total=600 → 财务写入 fin_po_lines.received_qty=600 → 无人读取。应付仍 ¥10000,付款环节据此付款 → 对短装供应商多付 ¥4000,除非人工肉眼发现。超收/让步接收同理不冲销。",
  "impact": "应付金额停留在理论下单量,收货核销链形同虚设;代码注释宣称『按 line_id/po_no 冲销核销应付』但端到端不成立。任何短装/超收/退货都需人工在 cost_items 手改才不错付,规模化后必然错付/漏冲,离生产级差『实收→应付冲销』这一整环。",
  "fix_hint": "建 fin_goods_receipts(或直接用 fin_po_lines.received_qty)驱动应付:登记费用时按 min(已收,已订)或实收额入账;或在 handleGoodsReceiptRecorded 内对已 registered 的 cost_items 做实收差额红冲/补记。至少要让 payables 计算消费 received_qty,而非纯 cost_items 手工额。",
  "_dim": "chain-finance",
  "verdict": {
   "real": true,
   "severity_adjusted": "P1",
   "reason": "证据逐条核对成立。(1) 节拍器三收货入口 procurement.ts:491/1086/1170 均 syncGoodsReceiptToFinance 携 received_qty_total。(2) 财务 webhook/route.ts:357-369 handleGoodsReceiptRecorded 把实收写入 fin_po_lines.received_qty(带 po_no+料名兜底)。(3) 全仓 grep received_qty 仅出现在该 webhook 写入处及注释,零读取点——确系死写。(4) fin_goods_receipts 仅存在于注释(route.ts:216/345「待建」),从未建表。(5) 应付 payables/page.tsx 的 rows 来自 cost_items(query 只 select amount 等,不含 received_qty),unpaid=Σcost_items.amount−付款(按供应商名匹配),与实收毫无关联。(6) cost_items 仅来自手工录入 costs/page.tsx:386/460/514;「登记为费用」是人工建 cost_items 后置 fin_purchase_orders.fin_status='registered'(costs/page.tsx:571-575),记的是下单额,永不按实收冲销。无任何别处兜底。收货→应付冲销这一环端到端不成立,注释宣称的『按 line_id/po_no 冲销核销』落空。真实触发:任何短装/超收/让步/退货,除非人工肉眼在 cost_items 手改,否则应付停留在理论下单额→规模化必然错付/漏冲。判 P1(链路漏一环+功能不达生产级);未升 P0 因付款仍需人工登记+付款,非自动静默错付,财务可手填实际额。"
  }
 },
 {
  "severity": "P2",
  "dimension": "财务归集-预算vs实际口径",
  "title": "预算单一旦离开 draft,采购实际价永不再同步 —— 预算vs采购价对账被冻结",
  "evidence": "财务 handleOrderBudgetUpdated(财务系统/src/app/api/integration/webhook/route.ts:579-580)『if (bo.status !== \"draft\") return { action: \"ok\" }』直接丢弃写入;handleQuotationFrozen 同一保守闸(route.ts:415-416)。而节拍器把『实际采购价』(actual_fabric/accessory/cmt_amount)与预算打包在同一 order.budget_updated 事件里发送(quote-baseline.ts:399-417),实际价来自采购填价(computeActualFabricTotal/computeActualAccessoryTotal, quote-baseline.ts:390-397),天然发生在预算之后。财务侧实际值落在 budget_orders.items[0]._cost_breakdown._actual_fabric/_actual_accessory/_actual_processing(route.ts:601-603)。budget_orders 会被 confirm 成 confirmed/locked/approved(webhook/route.ts:934 及 demo-data 状态集)。",
  "failure_scenario": "财务为锁定计划先把预算单确认(status='confirmed')。之后采购在采购核料填入真实面料/辅料单价 → 节拍器发 order.budget_updated(含 actual_totals)→ 财务命中 status!=='draft' 分支,返回 action:'ok' 静默丢弃 → _actual_* 永远停留在确认时刻(常为空)→『预算 vs 采购价 差额』对账看到的实际列缺失或过期。",
  "impact": "『预算 vs 采购价』是财务归集头号卖点,但实际列在预算确认后被冻结;采购超基线的真实成本无法回流已确认预算,超支不可见。属口径/生产级缺口。",
  "fix_hint": "把 actual_totals 的写入与 draft 门禁解耦:即使预算已确认,仍允许更新 _cost_breakdown._actual_*(只更新实际、不动预算标量),或对已确认预算走单独的『实际回填』通道并留痕。",
  "_dim": "chain-finance",
  "verdict": null
 },
 {
  "severity": "P3",
  "dimension": "财务归集-三桶口径一致性",
  "title": "加工费『实际』恒等于『预算』,processing 桶差额永远为 0",
  "evidence": "节拍器 quote-baseline.ts:415 `actual_cmt_amount: cmtTotalAmt` —— 而 cmtTotalAmt 正是预算加工费(quote-baseline.ts:366),二者同一变量。财务侧 route.ts:508/512 分别落 processing(预算) 与 _actual_processing(实际),值必然相等。",
  "failure_scenario": "任何订单:预算加工费与『实际加工费』在财务对账里三桶(面料/辅料/加工)中的加工桶差额恒为 0,即使工厂实际加工报价与核料估算不同,财务也永远看不到加工费偏差。",
  "impact": "三桶对账里加工桶的『预算vs实际』是装饰性的;代码注释承认『采购不另议→=预算加工费』为有意为之,故仅口径提示。若未来加工费需真实回填(如生产端结算加工费),需另接实际来源。",
  "fix_hint": "若要加工桶对账有意义,actual_cmt 应取生产/结算端真实加工费,而非复用预算加工费;否则 UI 上把加工桶实际列标注『同预算(采购不另议)』以免误读为已核。",
  "_dim": "chain-finance",
  "verdict": null
 },
 {
  "severity": "P1",
  "dimension": "权限安全/跨仓",
  "title": "财务→节拍器审批回调 price/delay/milestone 三类走匿名 createClient()，被 RLS 静默挡成 0 行，审批写回永久丢失",
  "evidence": "app/api/integration/finance-callback/route.ts:108 `const supabase = await createClient()`（ANON 会话，lib/supabase/server.ts:6-11 用 NEXT_PUBLIC_SUPABASE_ANON_KEY+cookies；webhook 无登录 cookie → auth.uid()=NULL）。随后三分支都用这个匿名 client 写：price 分支 L113-124 `supabase.from('pre_order_price_approvals').update({status:decision}).eq('id',approval_id).eq('status','pending')`；delay 分支 L126-137 更新 delay_requests；milestone 分支 L156-179 更新 milestones。而 cancel(L142-143)/purchase(L184-185) 分支明确改用了 createServiceRoleClient()。对应 RLS 全部要求 auth.uid() 非空且为特定角色/负责人：pre_order_price_approvals UPDATE 仅 admin（20260519_ai_usage_log_and_price_approval_rls.sql:120-132 EXISTS profiles WHERE user_id=auth.uid() AND admin）；delay_requests UPDATE 仅里程碑负责人/admin（ADD_roles_array.sql:44-58）；milestones UPDATE 仅 owner/角色匹配/admin（ADD_roles_array.sql:16-28）。匿名 auth.uid()=NULL → 三条 UPDATE 均匹配 0 行。",
  "failure_scenario": "财务人员在财务系统批准一条『价格审批/延期/里程碑(加工费·核准出运·收款)』→ 财务 approve 路由 sendApprovalToMetronome 携 approval_type='price'|'delay'|'milestone' 且带合法 HMAC 签名 POST 到 /api/integration/finance-callback → 通过验签 → 匿名 client 执行 .update() 命中 0 行 → 落入 skipLog('price'/'delay'/'milestone')『非待审批,跳过』并返回 200 ok。财务侧 pending_approvals 标记 decided，节拍器侧对应审批/里程碑永远停在 pending，milestone 分支 L168-178 的 recomputeDeliveryConfidence 也永不触发。全程静默、日志看起来像正常幂等跳过，无人察觉。",
  "impact": "跨仓审批链断裂:财务批过的价格/延期/里程碑决策无法写回节拍器,订单被审批闸永久卡住或风险卡不刷新;price 审批还是建单前置门禁,直接堵住订单启动。与 cancel/purchase 分支已修为 service-role 形成明显不一致,说明是漏改。",
  "fix_hint": "把 price/delay/milestone 三个分支的写入统一改用 createServiceRoleClient()(与 cancel/purchase 分支一致),绕过 RLS;保留 `.eq('status','pending')` 状态闸做幂等。写回后各自补触发既有 recompute/通知。修完用一次真实回调端到端验证 update 影响行数>0。",
  "_dim": "x-permissions",
  "verdict": {
   "real": true,
   "severity_adjusted": "P1",
   "reason": "证据逐条核对属实。finance-callback/route.ts:108 确用 anon createClient();price(L113-124)/delay(L126-137)/milestone(L156-179)三分支均走该 anon client,而 cancel(L142-146)/purchase(L184+)已改 service-role,漏改不一致成立。三张目标表 RLS 均已 ENABLE 且 UPDATE 要求 auth.uid() 非空(pre_order_price_approvals 仅 admin 20260519:120-132/表 enable 20260408:40;delay_requests ADD_roles_array:44-53/enable 20240123:88;milestones ADD_roles_array:16-28/enable migration.sql:740)。webhook 无 cookie → auth.uid()=NULL → UPDATE 命中 0 行且不抛 error(RLS 过滤行不报错)→ rows.length===0 → skipLog → 返回 200 ok,静默丢失。链路真实接通非死代码:节拍器 finance-sync.ts 发 price_approval.requested/delay.requested/milestone.requested;财务 webhook:181/184/190 落 pending_approvals 且 approval_type=price/delay/milestone(847/872/907),approve 路由原样透传回调。未被任何别处兜底。price 是建单前置门禁,回写永久丢失致订单卡审批闸、里程碑不刷新、recompute 不触发。属跨仓审批链断 3/5 类型 + 关键写回静默丢失,评 P1;未达 P0(cancel/purchase 仍通,非泄露/资金错乱/全链断)。"
  }
 },
 {
  "severity": "P3",
  "dimension": "权限安全",
  "title": "getOrder 订单级访问控制在异常分支 fail-open(保守放行),与其余 fail-safe 鉴权口径相反",
  "evidence": "app/actions/orders.ts:1053-1056 catch 块注释『权限判定异常 → 保守放行但记录』,实际 return { data: order } 放行;对比 lib/domain/orderAccess.ts:34-36 canUserAccessOrder 同类异常是 `return false`(安全侧拒绝)。",
  "failure_scenario": "getUserRoles 或 milestones 鉴权查询抛错时,直接返回订单。当前被 orders_select_v2 RLS(20260425_fix_rls_infinite_recursion.sql:74-83 仅 see-all/created_by/owner_user_id)兜底——order 行只有 RLS 放行才拿得到,故实际不可被越权利用;但一旦未来放宽 orders 的 SELECT RLS,该 fail-open 即成为唯一失效的越权口子。",
  "impact": "当前被 RLS 掩盖不可利用,属防御纵深弱点+口径漂移;注释『保守放行』措辞误导(实为 fail-open)。",
  "fix_hint": "异常分支改为 fail-safe 拒绝(return { error })或直接复用 canUserAccessOrder,与全局鉴权口径统一;订正注释。",
  "_dim": "x-permissions",
  "verdict": null
 },
 {
  "severity": "P1",
  "dimension": "审批回环即时性",
  "title": "财务→节拍器审批回传的 outbox 重试只每天跑一次(0 1 * * *),首发失败即停摆近24h",
  "evidence": "财务侧回传失败落 outbox:src/lib/integration/client.ts:77-81(sendApprovalToMetronome)与:66-69(notifyFinanceProgress)调 enqueueOutbox。重试函数 retryFinanceOutbox 定义于 client.ts:87,**唯一调用点**是 src/app/api/cron/orchestrate/route.ts:131。而 财务系统/vercel.json crons 只注册了 orchestrate,schedule=\"0 1 * * *\"(每天 01:00 一次)。对照节拍器侧 processFinanceOutbox 由 app/api/cron/reminders/route.ts:51-52 调用,vercel.json 注册 \"/api/cron/reminders\" schedule=\"*/15 * * * *\"(每15分钟)。两个方向的重试节奏严重不对称。",
  "failure_scenario": "财务点「批准」一张 ≥¥5000 采购单(src/app/api/purchase-approvals/decide/route.ts:56 或 approve/route.ts:86 同步 await 回传)。此刻节拍器正在冷启动/部署/网络抖动 → postMetronomeCallback 返回 !res.ok → 落 fin_outbound_outbox。财务侧 fin_purchase_orders 已置 approved,但节拍器 purchase_orders.approval_status 仍为 pending、PO 从未 place、供应商从未下单。要等到次日 01:00 orchestrate 跑 retryFinanceOutbox 才补投 —— 最长滞后近 24 小时,期间采购/生产被卡且无人被告警。cancel/price/milestone 回传同理。",
  "impact": "关键审批回环即时性不达生产级:财务已决策、节拍器最长 24h 才知道,阻塞采购下单与生产,业务侧看到「已提交财务审批」却迟迟不动。",
  "fix_hint": "给财务系统增加一条高频 cron(如每 15 分钟)专门跑 retryFinanceOutbox,或在 orchestrate 之外单独注册 \"/api/cron/integration-outbox\" \"*/15 * * * *\";与节拍器侧 15 分钟节奏对齐。",
  "_dim": "x-notify-approval",
  "verdict": {
   "real": true,
   "severity_adjusted": "P1",
   "reason": "证据核对成立。财务系统 vercel.json 仅注册一个 cron /api/cron/orchestrate schedule=\\\"0 1 * * *\\\"(每日01:00);retryFinanceOutbox(client.ts:87)全仓唯一调用点即 orchestrate/route.ts:131(grep 证实),故 outbox 自动重试每天仅一次。审批回传为同步 await sendApprovalToMetronome(decide/route.ts:56),失败不回滚审批结论、payload 落 fin_outbound_outbox(client.ts:79);postMetronomeCallback(client.ts:20-45)是单次 fetch+10s 超时、无内联重试,首发失败直接进 outbox。退避 next_retry_at 被日级 cron 节奏封顶,首发失败最早次日01:00才补投。无手工重推端点——UI 仅弹「稍后可重推」toast(page.tsx:121)却无对应路由/按钮,人工兜底比发现所述更弱。未被任何别处兜底/降级抵消。触发条件为条件性(审批瞬间节拍器不可达:部署/冷启/抖动),非必然断链,但一旦触发已批准 PO 最长滞后~24h、阻塞下游下单且无告警,反方向为15分钟,不对称属实。证据中 approve/route.ts:86 不存在(仅 decide/route.ts),属轻微引用瑕疵,不影响核心机制成立。维持 P1。"
  }
 },
 {
  "severity": "P2",
  "dimension": "通知触达渠道",
  "title": "审批扇出 notifyUsersByRole 只写站内通知,不发邮件也不推企业微信 —— 审批人不开 App 就不知情",
  "evidence": "lib/utils/notifications.ts:121-149 notifyUsersByRole 只做 notifications 表 insert(email_sent:false),既不调 sendEmailNotification 也不调 wechat-push 的 pushToUsers。所有审批待办扇出都走它:采购单≥¥5000 待审(app/actions/purchase-orders.ts:751)、风险闸待审(:805)、改期待审批(app/actions/delays.ts:241)、取消待审(finance-callback 回通知 route.ts:203/219)。对照:逾期升级链 app/api/cron/reminders/route.ts:216/343/443 都调 pushToUsers 推企业微信。且全局邮件有 kill-switch(notifications.ts:48-62),即使邮件没被关,notifyUsersByRole 这条路径也从不发邮件。",
  "failure_scenario": "一张 ¥8000 采购单提交财务审批,系统给 finance/procurement_manager 角色 insert 站内通知。审批人当时没登录节拍器 → 无邮件、无企微推送 → 通知只静静躺在站内红点里,审批人可能数小时后才偶然打开 App 看到,采购单一直卡在待审批。",
  "impact": "审批类「待你处理」通知缺少实时推送通道(企微),在邮件被暂停的前提下等同只有站内红点,审批时效不可控。",
  "fix_hint": "在 notifyUsersByRole 内对审批类 type(po_approval/po_finance_approval/deferral_approval/cancel 等)追加 pushToUsers 企业微信推送,与逾期升级链一致;或让这些审批发起点显式补一次 WeCom 推送。",
  "_dim": "x-notify-approval",
  "verdict": null
 },
 {
  "severity": "P2",
  "dimension": "审批回环幂等/恢复",
  "title": "采购审批「批准」把 approval_status 先翻成 approved 再下单,若 placeCore 首发失败,daily 重试被已消费的状态闸挡死 → PO 永远批而不下",
  "evidence": "app/api/integration/finance-callback/route.ts:190-200:先 update approval_status='approved' WHERE approval_status='pending'(gate 命中1行),再 placePurchaseOrderCore;若 pr.error 则 throw → 500。lib/procurement/placeCore.ts:16-18 的初始 update status='placed' WHERE status='draft' 失败时返回 {error}(未真正 place,status 仍 draft)。财务侧收到 500 → 落 outbox 次日重投 → 但重投时 finance-callback:192 的 gate 命中 0 行(approval_status 已是 approved)→ route.ts:196 打印「非 pending,跳过下单(幂等)」→ placeCore 再也不被调用。",
  "failure_scenario": "财务批准回调到达,节拍器把 approval_status 置 approved 成功,但紧接着 placeCore 的 status→placed 更新遇到瞬时 DB 错误返回 error → finance-callback 抛 500。财务 outbox 次日重投,却因 approval_status 已 approved 被幂等闸跳过,placeCore 永不重跑:该 PO 停在 approval_status=approved / status=draft,从未下单、从未 emit purchase_order.placed、供应商从未收到,且无告警。",
  "impact": "审批与下单非原子,重试路径被已消费的状态闸阻断,单张 PO 可能批而不下且不可自动恢复,只能人工发现。",
  "fix_hint": "下单成功后再翻 approval_status,或让重试判据基于「approved 且 status=draft」而非「pending」;至少在 pr.error 分支回滚 approval_status 回 pending 以便重投能重入。",
  "_dim": "x-notify-approval",
  "verdict": null
 },
 {
  "severity": "P3",
  "dimension": "死信可见性",
  "title": "两侧 outbox 耗尽重试置 dead 后只 console.log,无任何人被告警",
  "evidence": "财务 src/lib/integration/client.ts:102-108 置 dead 仅计数,orchestrate/route.ts:132 仅 console.log;节拍器 lib/integration/finance-sync.ts:147-148 置 dead 仅计数,app/api/cron/reminders/route.ts:48 注释「置 dead 可见」但仅返回计数。无 notifications/WeCom 告警。",
  "failure_scenario": "一条审批回传连续失败达 OUTBOX_MAX_ATTEMPTS(财务8次/节拍器6次)后置 dead,从此不再重投,也没有任何人收到「有审批彻底投递失败」的提醒 —— 变成一条无人知晓的死行,审批链永久断裂。",
  "impact": "永久失败的审批/资金事件成为静默死信,需人工主动查表才能发现,放大 P1 的后果。",
  "fix_hint": "outbox 转 dead 时给 admin/finance 发一条站内+企微告警,或在健康巡检中把 dead 计数纳入 runIntegrityCheck 红线。",
  "_dim": "x-notify-approval",
  "verdict": null
 },
 {
  "severity": "P3",
  "dimension": "链路一致性",
  "title": "delay.requested 审批回环两端有完整消费代码却无任何生产者(幽灵能力)",
  "evidence": "财务 src/app/api/integration/webhook/route.ts:184-185 handleDelayApprovalRequest 写 pending_approvals;节拍器 finance-callback route.ts:126-137 处理 approval_type='delay';finance-sync.ts:33 WebhookEventType 含 'delay.requested'。但全仓 grep 无任何 sendToFinanceSystem('delay.requested'…) 调用点 —— 改期审批实际只走节拍器内部 deferralChainFor 审批链(app/actions/delays.ts:191/241),从不推财务。",
  "failure_scenario": "无实际故障(设计上改期为内部审批),但财务侧 handleDelayApprovalRequest 与节拍器 finance-callback 'delay' 分支是永不被触发的死代码,易误导后续维护者以为改期会进财务队列。",
  "impact": "两端各维护一段永不通电的审批回环代码,认知负担与误接线风险。",
  "fix_hint": "要么删除两端 delay 审批的死代码,要么补上 delay.requested 的发起端(若确需财务参与改期审批)。",
  "_dim": "x-notify-approval",
  "verdict": null
 },
 {
  "severity": "P0",
  "dimension": "生成表格 - 越权泄露/价格",
  "title": "PI(形式发票)查看与导出完全无价格角色门禁,客户成交价泄露给生产/QC/所有登录角色",
  "evidence": "app/actions/order-pi.ts:186-191 exportPI 只校验 `const { userId } = await auth(); if (!userId) return...`,无任何 CAN_SEE_FINANCIALS/角色判断;getPI(order-pi.ts:89-91)同样只校验登录。getPI 用普通用户会话读 order_line_items 并把 `unit_price: Number(first.po_unit_price)`(order-pi.ts:152,注释7行明确写「单价取客户 PO 成交价」)返回,exportPI 再原样写入 Excel L 列 UNIT PRICE + M 列 AMOUNT(order-pi.ts:236-237)。对照 app/actions/shipping-docs.ts:35-36 的 CI 生成 `if (!canSeeFin) return { error: 'CI 含客户成交价,仅财务/业务/管理员可生成' }` —— CI 有门禁而 PI 无。UI 侧 app/orders/[id]/page.tsx:417-441 的 tab 列表把 `{ key: 'pi' }` 无条件渲染给所有角色(不像 canSeeFinancials 包裹的 FinanceEventsTimeline)。po_unit_price 无列级 REVOKE(仅 supabase/migrations/20260706_order_line_po_price.sql 建列,无 grant/revoke),RLS 只挡行不挡列,任何能打开该订单的生产/QC 用户即可读取。",
  "failure_scenario": "生产或 QC 角色用户打开任一自己可见的订单 → 点「🧾 PI」tab(或直接调用 exportPI server action)→ 界面/Excel 直接显示每款客户成交单价与总金额。违反 CLAUDE.md『不暴露价格信息给 production/merchandiser/admin_assistant 角色』。",
  "impact": "客户成交价(公司最敏感的销售价)向生产/QC/仓库等无权角色泄露,且是可直接下载的 Excel 文件,可外传。属越权泄露。",
  "fix_hint": "exportPI 和 getPI 增加与 CI 一致的 canSeeFin(hasRoleInGroup CAN_SEE_FINANCIALS)门禁;无权角色下发不含 unit_price/amount 的降级版或直接拒绝;PI tab 也按 canSeeFinancials 条件渲染。",
  "_dim": "gen-tables",
  "verdict": {
   "real": true,
   "severity_adjusted": "P0",
   "reason": "证据逐条核实成立。getPI(order-pi.ts:89-91,152)用普通用户会话读 order_line_items.po_unit_price(客户成交价)并作为 unit_price 返回;exportPI(order-pi.ts:186-191,236-237)仅校验登录即把单价/金额写入 Excel L/M 列,均无 CAN_SEE_FINANCIALS 门禁。对照 CI(shipping-docs.ts:35-36)有 canSeeFin 门禁,PI 无,形成对称漏洞。po_unit_price 无列级 REVOKE——迁移 20260706_order_line_po_price.sql 明写保护靠\"server端剥离(非UI隐藏)\",而这两个函数恰恰没剥离;RLS 仅挡行不挡列,生产/QC 因需渲染生产任务单本就有 order_line_items 行读权限,故能读到该列。CAN_SEE_FINANCIALS(roles.ts:156)不含 production/qc/logistics/merchandiser。PI tab(page.tsx:423)对所有角色无条件渲染,且 server action 可直接调用。无任何别处兜底。触发条件:任一生产/QC 用户打开自己可见订单点 PI tab 或直调 exportPI 即得含客户成交价的可下载 Excel。属越权泄露,按 rubric 越权泄露=P0,故由 P1 上调至 P0。"
  }
 },
 {
  "severity": "P2",
  "dimension": "生成表格 - 数据正确性/尺码错位",
  "title": "生产单(PO 解析版)主表尺码列硬编码 S/M/L/XL,非标尺码数量被静默丢弃、总数量算错",
  "evidence": "app/actions/generate-production-order.ts:226-236 表头 HEADERS 固定 [5,'S'][6,'M'][7,'L'][8,'XL'] 四个尺码列;:260-262 数据行只写 `['S','M','L','XL'].forEach(...)` 四个 key;:258 数量公式 `=E${r}+F${r}+G${r}+H${r}` 只加这 4 列。而 color.sizes 是 `Record<string,number>` 任意 key(app/actions/po-parser.ts:23,size_labels 为动态数组:50)。同文件的尺寸表 sheet 却用动态 `sizeLabels`(:43,:363-411)—— 两张表对尺码的处理不一致,证明主表是硬编码缺陷。",
  "failure_scenario": "客户下单尺码为 ['S','M','L','XL','XXL'] 或数字码 ['36','38','40'] 时:XXL 的件数(如 100 件)不会写入任何列也不进 =E+F+G+H,主表『数量』与『总计』少算;若全部是数字码,则 S/M/L/XL 全取不到值,整张生产单数量显示为 0。工厂据此裁剪会裁错数量。",
  "impact": "发给工厂的生产任务单数量与实际订单不符(漏码单少算、纯数字码单归零),直接误导裁床/大货数量。",
  "fix_hint": "主表尺码列改为按 data.size_labels 动态生成(与尺寸表 sheet 一致),数量公式按实际尺码列区间 SUM,而非固定 E:H。",
  "_dim": "gen-tables",
  "verdict": null
 },
 {
  "severity": "P2",
  "dimension": "生成表格 - 口径漂移/合计对齐",
  "title": "采购对账单『差异』列:逐行是数量差、合计行却塞金额差,同列混单位且合计非本列之和",
  "evidence": "app/actions/procurement.ts:687 逐行『差异』列(第11列)写 `item.difference_qty ?? ''`,即『实收数量−订购数量』的数量差(:614 diffQty = recv − ordered);而 :709 合计行同一列写 `(totalReceivedAmt - totalOrderedAmt).toFixed(2)` —— 金额差,且 totalReceivedAmt=Σ(received_qty×unit_price)(:671),对未收货行 received_qty 为 null → receivedAmt=0,合计里被整额扣减订购金额。表头(:646)该列名为『差异』。此外 :709 用 `.toFixed(2)` 生成字符串,合计单元格是文本而逐行金额列(如订购金额)是数字。",
  "failure_scenario": "有部分物料尚未收货时导出对账单:合计行『差异』= 一个很大的负数(把未到货物的整额订购金额算成了差异),财务/供应商看到会误判为巨额短缺;同时该合计与其上方『差异』列(数量差)单位不同、并非该列纵向求和。",
  "impact": "发给财务/供应商的对账单合计口径误导,数量差与金额差混列,易引发对账争议。",
  "fix_hint": "合计行的差异应对齐列语义(数量差列放 Σ数量差,或单独设『金额差』列);未收货行不应把订购金额计入差异;金额合计用数值而非 toFixed 字符串,便于 Excel 求和。",
  "_dim": "gen-tables",
  "verdict": null
 },
 {
  "severity": "P2",
  "dimension": "生成表格 - 数据正确性/合计",
  "title": "CI 商业发票:任一款缺客户成交价时,该款金额留空且被静默排除在发票总额外,总额少计无提示",
  "evidence": "lib/services/shipping-docs.ts:116-118 `const price = canSeeFin ? (m.po_unit_price ?? null) : null; const amount = price != null ? Math.round(price*g.qty*100)/100 : null; ... if (amount != null) ciTotals.amount += amount;` —— po_unit_price 缺失的款 amount=null,既不进 ciTotals.amount 也在 app/actions/shipping-docs.ts:85 写成空单元格,但该款的 qty 仍列在明细里。合计行(shipping-docs.ts:94)`cell(r,13, ciTotals.amount)` 因此只汇总了有价款。",
  "failure_scenario": "一张订单里有 3 款,其中 1 款 order_line_items.po_unit_price 未录入 → CI 明细该款单价/金额空白,但 TOTAL AMOUNT 仅为另外 2 款之和,发票总金额低于应收,且无任何警示。",
  "impact": "对外商业发票金额可能被静默低报,用于报关/收汇时金额不实。",
  "fix_hint": "缺价款应阻断生成或在文档上显著标红提示『N 款缺成交价,总额不完整』,而非静默跳过求和。",
  "_dim": "gen-tables",
  "verdict": null
 },
 {
  "severity": "P2",
  "dimension": "UI交互-角色越权/价格泄露",
  "title": "订单详情「🛒采购核料」tab 把预算/成本(¥)一键暴露且可编辑给 production_manager/qc/logistics 等无价权限角色",
  "evidence": "app/orders/[id]/page.tsx:110 `canSeeFinancials` 被算出但此 tab 完全没用它做门禁;884-904 tab 内容仅 `isAdmin ? <ProcurementItemsTab> : <BomBudgetEntry>`,两支都显示价格;424 行 tab 导航数组无条件把「🛒 采购核料」渲染给所有角色;106-108 只有 `isProcurementOnly` 才被改道离开订单详情,而 isProcurementOnly(lib/utils/procurement-page-guard.ts:24-27)仅 procurement/procurement_manager 为真。BomBudgetEntry(components/tabs/BomBudgetEntry.tsx:13,110-117,138,153)展示并可 onBlur 编辑【预算单价】【加工费元/件】【辅料总价】及自动算出的【面料预算 ¥】。CAN_SEE_FINANCIALS(lib/domain/roles.ts:156)= admin/finance/sales/sales_manager/order_manager,不含 production_manager/qc/merchandiser/logistics。",
  "failure_scenario": "production_manager(或 qc/logistics)登录→打开任一可见订单→点顶部「🛒 采购核料」tab→直接看到该单每款布料预算单价、加工费、辅料总价及合计金额,并可就地改写覆盖业务预算,CLAUDE 红线『production/merchandiser/admin_assistant/procurement/logistics 不可见价格』被绕过。",
  "impact": "成本/预算金额对无价权限角色一键可见且可篡改,违反明确的价格可见性红线;篡改后影响财务『预算 vs 实际』基线。",
  "fix_hint": "该 tab 内容用 canSeeFinancials 门禁:非 admin/finance/业务角色渲染只读占位或隐藏该 tab(nav 数组按角色过滤);BomBudgetEntry 增加自身 role guard,只读态对无价角色不渲染 ¥ 字段。",
  "_dim": "ux",
  "verdict": {
   "real": true,
   "severity_adjusted": "P2",
   "reason": "证据部分成立。可见性泄露属实:page.tsx:106-108 仅把纯采购改道,production_manager/qc/logistics/merchandiser 均可进订单详情;tab 导航(417-424)无条件渲染「🛒采购核料」,内容(884-904)仅按 isAdmin 分支,确实未用第110行算出的 canSeeFinancials 门禁;BomBudgetEntry 渲染¥预算单价/加工费/辅料总价/自动面料预算。其读取 action listBomConsumptionLines(267-268)与 getOrderStyleBudgets(423-424)只查 if(!user) 无角色守卫,materials_bom RLS 为「登录即可读写」(20260606 迁移注释确认)且 budget_unit_price 无列级 REVOKE,故无价角色确实能看到预算金额——违反 CLAUDE 价格可见红线。但发现被显著高估:写入/篡改一侧被服务端守卫抵消——saveBomBudgetUnitPrice(396-400)与 saveOrderStyleBudgets(450-454)都硬白名单 sales/merchandiser/sales_manager/order_manager/procurement/procurement_manager/admin,production_manager/qc/logistics 保存会被拒('仅业务/理单/采购/管理员可填…'),客户端虽显示可编辑输入但服务端拒收,所以「可就地改写覆盖业务预算/污染财务基线」对这些角色不成立。真实影响=内部预算金额(非底价/毛利/非外部)对3个无价内部角色只读可见,篡改路径已被封。故 P1→P2。修复仍应给该 tab 加 canSeeFinancials 门禁并在读 action 补角色守卫。"
  }
 },
 {
  "severity": "P2",
  "dimension": "UI交互-计数与可见行对不上/误操作",
  "title": "核料页聚焦单料(?item=)时,批量确认工具条与「待核」快捷条仍统计并操作整单全部物料——可确认看不见的料",
  "evidence": "components/tabs/ProcurementItemsTab.tsx:428-429 `focusItem=...; visibleItems = focusItem?[focusItem]:items`,888 行表格只渲染 `visibleItems.map`(聚焦时仅 1 行);但 440 `doneCount=items.length-...`、450 `bulkEligible=items.filter(canBulkConfirm)`、439 `pendingItems=items.filter(...)` 全部基于整单 items。工具条 842 显示『核料进度 doneCount/items.length』、848-855『全选可批量确认(bulkEligible.length)』『批量确认(checkedEligible.length)』、862-865 待核 chips 用 pendingItems——聚焦(只看 1 行)时这些数字/按钮仍覆盖看不见的其它料。ProcurementQueueClient.tsx:63-67 每行「📋任务单」正是带 ?item= 进来聚焦。",
  "failure_scenario": "采购在采购中心某行点「📋任务单」→ 核料页只显示这一款料(横幅『🔎只看这一款料』)→ 采购以为在操作这一款,却点『全选可批量确认(N)』+『批量确认』,N/勾选来自整单,系统把该订单其它未在屏幕上的料一并 confirm,采购无从核对。",
  "impact": "聚焦视图下计数与可见行数不一致,且批量确认作用于不可见物料,存在误确认整单未核物料的风险。",
  "fix_hint": "聚焦时把进度/bulkEligible/pendingItems/checked 全部限定在 visibleItems 范围,或在聚焦态隐藏批量确认工具条与待核 chips,只保留单料操作。",
  "_dim": "ux",
  "verdict": null
 },
 {
  "severity": "P3",
  "dimension": "UI交互-二次确认/校验缺失",
  "title": "收货「验收判定」让步/拒收前端不强制填缺陷说明,与提示文案不符",
  "evidence": "components/ProcurementQueueClient.tsx:497-501 ReceiveForm.submit 仅校验 `parseFloat(qty)>=0` 就 onSubmit,concession/reject 均不校验 defect;505 行输入框 placeholder 写『缺陷说明(让步/拒收必填写清楚)』但无对应 required 校验;508 拒收按钮直接可点。",
  "failure_scenario": "采购在待验收行点『验收判定』→ 只填实收数量、缺陷说明留空 → 直接点『让步』或『拒收』,前端放行(是否落库取决于服务端 recordGoodsReceipt),让步/拒收无缺陷留痕即成立。",
  "impact": "让步/拒收缺少缺陷证据,审计链信息缺失;文案承诺与实际校验不一致,易误导。",
  "fix_hint": "submit('concession'|'reject') 时校验 defect.trim() 非空,否则内联报错并阻止提交。",
  "_dim": "ux",
  "verdict": null
 },
 {
  "severity": "P3",
  "dimension": "UI交互-死路/空态",
  "title": "指派跟单人:候选为空或加载失败时下拉只剩占位项,无提示、无法完成,成死路",
  "evidence": "components/MerchandiserAssign.tsx:20-26 open 时拉 getMerchandiserCandidates,仅 `if(res.data) setCandidates`,无 error/空态处理;59-70 select 只渲染候选,空时仅有『选择跟单人员』占位;28-30 handleAssign 在 selectedId 为空时直接 return 无反馈。候选长度为 0 时 useEffect 依赖 candidates.length 仍为 0,每次 open 重复请求。",
  "failure_scenario": "某环境无符合条件跟单候选(或 getMerchandiserCandidates 返回 error)→ 点『指定』→ 下拉里没有任何人可选,『确认』按钮因 !selectedId 恒 disabled,用户无任何提示,卡死无法指派也不知原因。",
  "impact": "指派跟单在候选缺失/查询异常时无反馈的死路,用户无从判断是无人可选还是系统故障。",
  "fix_hint": "候选加载后区分空/错误态给文案(如『暂无可指派的跟单人员,请联系管理员』),并展示 res.error;避免空态下静默重复请求。",
  "_dim": "ux",
  "verdict": null
 },
 {
  "severity": "P2",
  "dimension": "业务开发(araos)→节拍器→业务执行 承接",
  "title": "araos赢单的订单明细(款/量/货值/交期)在节拍器无接收方——只落客户+一条通知,建单靠人肉重录到另一系统",
  "evidence": "araos推送体 lib/metronome/payloads.ts:buildOrderPayload 含 order_ref/product_lines/order_value_usd/required_delivery/moq_agreed/araos_link 等完整规格。QIMO接收端 app/api/contract/v1/handoff/araos/route.ts 明确注释『不自动建PO/订单』,POST只做:customers upsert(step4)+notifyUsersByRole文本通知(step5)+落 araos_handoffs_inbox.payload JSON(step6)。全仓 grep 证实:`grep -rn araos_handoffs_inbox|araos_link|araos_order_id app components lib`(除接收路由外)零命中;PO→Order派生入口 app/actions/order-from-po.ts:60 `customer_po` 绑定 `quote_id`,与 araos 无任何 source_araos 链接(grep 零命中)。即 araos 赢单规格只存在于 inbox.payload JSON(无任何UI/action读取)与一条不含数量的通知里。",
  "failure_scenario": "araos 赢单→节拍器建客户成功→业务执行要在节拍器建单时,系统里查不到 araos 那一单的 product_lines/数量/货值/交期,只有一条通知文本;必须切回 araos(靠 araos_link,但该link也埋在没人读的JSON里)人工抄录,再走 Quote→customer_po→Order 全内部链重录。规格在两系统间靠人搬运→漂移/漏项风险,且 order_line_items 逐款明细真相与 araos 中标规格无系统级一致性保证。",
  "impact": "承接链漏一环:araos→节拍器的『订单规格』这一段没有数据桥,只有『客户』这一段通了电。逐款明细/货值/交期无法自动带入建单,人工重录易与中标口径漂移。",
  "fix_hint": "在建单入口(createOrderFromPO 或新建 quote/customer_po 时)按 customers.source_araos_company_id 反查 araos_handoffs_inbox.payload,把 product_lines/order_ref/required_delivery/order_value 作为草稿预填(仍人工确认定价,不违反Plan A);或至少在客户页/通知里渲染 araos_link 与明细摘要,让建单人一键看到中标规格。",
  "_dim": "chain-araos-execution",
  "verdict": null
 },
 {
  "severity": "P3",
  "dimension": "业务开发(araos)→节拍器→业务执行 承接",
  "title": "订单类型 handoff 的字段与接收端 normalize() 不对齐:quantity/contact_phone/country 从不发送,接收端读取恒为空",
  "evidence": "接收端 app/api/contract/v1/handoff/araos/route.ts normalize() 读取 d.quantity(通知数量)、d.contact_phone(customers.phone)、d.shipping.country/d.country(customers.country)。但 araos lib/metronome/payloads.ts:buildOrderPayload(订单型)只发 contact_email 不发 contact_phone,不发 quantity(只发 product_lines/order_value_usd/moq_agreed),不发 shipping/country。仅 buildSamplePayload(样品型)才发 contact_phone/shipping/country。",
  "failure_scenario": "araos 订单型赢单交接:QIMO 新建的客户 phone=null、country=null;赢单通知文案 dealBits 因 d.quantity 恒空而不显示件数(只显示单号/款/交期)。样品型交接则字段齐全——同一接收端对两种 payload 表现不一致。",
  "impact": "订单型交接建立的客户缺电话/国别,通知缺数量;口径不一致但不致数据错乱。",
  "fix_hint": "buildOrderPayload 补 contact_phone、quantity(可由 product_lines 汇总)、country/shipping;或接收端 normalize 对订单型从 product_lines 汇总数量。二选一使两端口径对齐。",
  "_dim": "chain-araos-execution",
  "verdict": null
 },
 {
  "severity": "P3",
  "dimension": "业务开发(araos)→节拍器→业务执行 承接",
  "title": "幂等只认已写入的 processed 行,处理中失败/并发重投会重复触发赢单通知",
  "evidence": "app/api/contract/v1/handoff/araos/route.ts:step3 幂等短路条件为 existing.status==='processed' && qimo_customer_id;而『已处理』标记只在 step6 末尾 upsert 写入,处理前不预写 received/pending 行。step4(客户 upsert)先于 step5(通知)先于 step6(落库)。araos 侧 lib/metronome/client.ts:pushHandoff 对 5xx/网络错误按 backoff 重试(MAX_ATTEMPTS=5)。",
  "failure_scenario": "首次请求在 step4 建客户后、step6 落 processed 前抛错(如 inbox upsert 失败)→返回500→araos 重试→step3 查不到 processed 行→重跑 step4(靠 source_araos_company_id 命中已建客户,不重复建客户,OK)但 step5 再次 notifyUsersByRole→业务收到重复『araos 赢单』通知。若 araos_company_id 缺失/非UUID 则 source 匹配失效,极端并发下 step4 走 ilike 姓名匹配还可能并发重复建客户。",
  "impact": "最坏为重复赢单通知(骚扰,不致资金/数据错乱);company_id 缺失时的并发窗口存在极小概率重复建客户。",
  "fix_hint": "进入处理前先 upsert 一行 status='received'(onConflict araos_order_id)抢占幂等锁;通知发送前再判一次是否已 processed;并对 customers 的 (source_araos_company_id) 或姓名加唯一约束兜底并发。",
  "_dim": "chain-araos-execution",
  "verdict": null
 }
]
```

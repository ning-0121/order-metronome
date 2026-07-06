# QIMO OS 三系统数据链审计 2026-07-06

> 范围：节拍器 Order Metronome ↔ 财务系统 ↔ araos 客户开发系统。共享 ID + HMAC webhook 契约融合。只读审计，双端 file:line 证据。
> 结论已对抗复核，严重度按真实影响（资金/数据损坏 > 功能阻断 > 通知不即达 > 数据陈旧/可维护性）排。

---

## 一、总评：数据链现在到底通不通

**基础管道是通的，但"能不能自动跑起来"和"该到的人即刻收到"两件事大面积不达标——而这两件恰恰是"卡风险不走流程"的命门。**

三系统的鉴权底座（HMAC、API Key、幂等、outbox+cron 重试）逐字对齐、握手正常，赢单交接的客户维度、财务出站的大部分审批事件、财务回调的批准子链都是真通的。但审计确认了一个 **P0 真断点**：近几周"去审批"改动后，标准 V2 生产单建单即卡在 `草稿`、永不激活，导致 AI 巡检、晨报、日报三大风险面板对**所有新生产单静默失效**——一个以"卡风险"为核心卖点的产品，新单进来根本没被扫。除此之外还有一批 P1：延期审批从不推财务、采购单不带明细导致收货 100% 核销失败、真实收款/付款进度事件是死代码从不发送、以及**几乎所有内部审批与财务回调结果都只写哑站内通知**（不发邮件/企微），审批人只能靠自己登录看铃铛。ID 映射也有硬伤：节拍器→财务不传 `customer_id`，财务只能按客户名精确匹配挂应收，同名即错配。

一句话：**电线接好了、灯座装好了，但主开关（激活）没合、好几路信号灯（收款/延期/预算）根本没通电、门铃普遍不响。不是"没搭起来"，是"搭起来了但不会自己动、也不叫人"。**

---

## 二、六条链段流通评分卡

| 链段 | 流通判定 | 一句话 |
|---|---|---|
| A. araos → 节拍器 交接 | **部分通** | 客户维度真通（落客户+通知业务，按方案1不自动建单，符合设计）；但 PO 明细只进通知文案+无人读的收件箱 jsonb，业务仍需手动重录建单，PO 结构化映射未打通。 |
| B. 节拍器 → 财务 出站 | **部分通** | HMAC/幂等/outbox+cron 基础链通、大部分事件对齐；但延期审批**从不发送**、重排新交期字段被财务**丢弃**、采购单**不带 lines** 导致收货 100% 核销失败——三处真断。 |
| C. 财务 → 节拍器 回调 | **部分通** | 审批回传（price/delay/cancel/milestone/purchase）端到端真通；但资金进度子链基本断：唯一在发的 `settlement.closed` 只写只读日志不推进任何节点，`collection.received`/`payment.completed` 从不发送，`budget.completed` 根本不存在。 |
| D. 节拍器内部链 完整性 | **部分通（含 P0）** | 报价→PO→订单→里程碑→BOM→需求→归并→采购项→执行行→生产中心 每跳能派生；但"去审批"留下 P0 真断点：标准生产单永久卡 `草稿`、永不激活，风险扫描/晨报/AI 巡检对全部新单静默失效。 |
| E. 审批 + 通知 及时性 | **断** | 多个关键审批（超预算/取消/多方确认/财务回调后的价格·延期·里程碑）要么只写哑站内、要么根本不通知责任方，普遍靠登录看铃铛，非即刻可达；提醒类 15 分钟 cron 尚可接受但单点无告警。 |
| F. 跨系统 ID 映射 | **部分通** | ID 链只在"araos→节拍器客户"和"节拍器→财务订单"两跳打通；客户维度断在节拍器→财务这跳（订单同步不带 `customer_id`，财务 `customers.qimo_customer_id` 永远为空），同名即错配。 |

---

## 三、确认成立的缺陷（P0 → P3）

### 🔴 P0 — 必须最先修

#### P0-1 标准 V2 生产单建单即卡 `草稿`、永不激活 → 风险扫描/晨报/AI 巡检对全部新单静默失效
- **涉及系统**：节拍器内部（建单 → 里程碑 → 激活 → 风险扫描/晨报/AI Agent）
- **断在哪**："去审批"改动后，标准生产单（V2 9 节点）新建后 `lifecycle_status` 停在 DB 默认值 `草稿`，**没有任何路径把它翻成 active**。而自动激活闸有两道各自独立的坎，任一不修都激活不了；即便激活了，三大风险面板的白名单又不含 `草稿`/`draft`。
- **双端证据**：
  - 发送端（落 `草稿` 且永不激活）：
    - `lib/milestoneTemplate.ts:66-92` `MILESTONE_TEMPLATE_V2` 只有 9 个 step_key，**无 `finance_approval`**（注释 57-58 说明已并入 `po_confirmed` 不再单列）。
    - `app/actions/orders.ts:318-377` `insertPayload` 不含 `lifecycle_status` → 取 DB 默认；`supabase/migrations/20240121000000_add_order_lifecycle.sql:9` `default '草稿'`。
    - `createOrder` 普通新单（非 import、无 past_date）全程不写 `lifecycle_status='active'`；唯二激活分支 `orders.ts:613`（仅 isImport）、`orders.ts:746/768/777`（仅 pastDateStatus）都不满足。
  - 接收端（激活闸恒 false + 消费端排除）：
    - `app/actions/milestones.ts:910` `stage1Keys=['po_confirmed','finance_approval']`，`:916` 要求 `stage1Milestones.length===stage1Keys.length`（=2）；V2 单只物化 1 行 → 恒 `1 !== 2` → `allStage1Done` 恒 false → `activateOrder` 永不触发。
    - 第二道坎：`milestones.ts:921` 判 `=== 'draft'`（英文），DB 存 `草稿`（中文），也不会激活。
    - `app/api/cron/agent-scan/route.ts:193`、`morning-briefing/route.ts:148`、`daily-summary/route.ts:59` 全部 `.in('lifecycle_status', ['执行中','running','active','已生效'])`，`草稿` 被排除。
- **修法**：二选一，推荐后者 + 顺手修 stale key：
  1. **推荐**：`createOrder` 正常路径（非 import、非 past_date）也显式 `lifecycle_status:'active'`（"去审批"已拍板创建即 active），与 import 分支 `orders.ts:613` 对齐。
  2. 把 stage1 激活口径改为 V2 现实：`stage1Keys=['po_confirmed']`（或"存在即算"判定）。
  - 无论选哪个，都应同时修 `milestones.ts:921` 的中英不匹配（见 P1-5），防旧 draft 单被卡。

---

### 🟠 P1 — 尽快修（功能缺口/审批不即达，非资金损坏）

#### P1-1 延期审批 `delay.requested` 从不发送——发送端函数零调用点，财务永远收不到延期审批
- **涉及系统**：节拍器 → 财务
- **断在哪**：`pushDelayApprovalToFinance` 定义存在，但全仓零调用；`app/actions/delays.ts` 主流程只做站内通知/邮件/企微，从不推财务。财务接收端完好但成死代码。
- **双端证据**：
  - 发送端：`lib/integration/finance-sync.ts:227` 定义 `pushDelayApprovalToFinance`（`:242` `sendToFinanceSystem('delay.requested', ...)`），全仓 grep 仅命中定义行本身；`app/actions/delays.ts`（1412 行）无 finance-sync import、无该函数调用，唯一 `finance` 是角色标签映射字符串。
  - 接收端：财务 `src/app/api/integration/webhook/route.ts:184` `case 'delay.requested'` → `handleDelayApprovalRequest`（655 行）已实现并 upsert `pending_approvals`，完好但永远收不到。
- **修法**：在 `app/actions/delays.ts` 的 `createDelayRequest`（186-377 行）主流程末尾 fire-and-forget 调用 `pushDelayApprovalToFinance`，payload 对齐 `DelayApprovalRequest`（id/order_no/milestone_name/requester_name/reason_type/proposed_new_date），与 `cancel.requested` 同样落 outbox 重试。

#### P1-2 采购单同步不带 lines → 财务 `fin_po_lines` 永远空 → 收货 100% 匹配失败、应付永不核销
- **涉及系统**：节拍器 → 财务
- **断在哪**：`buildPurchaseOrderSyncPayload` 只发头信息、无 `lines`；财务 `handlePurchaseOrderPlaced` 读 `data.lines` 恒空 → `fin_po_lines` 从不写入。之后收货发 `goods_receipt.recorded` 带 `line_id`，财务按 `line_id` update `fin_po_lines` 恒 0 行匹配 → 返回 `ignored '未匹配到采购对账行'`，inbox 堆积 pending，"按实收核销应付"设计目标 100% 落空（收齐/短缺/超收都无法冲销）。
- **双端证据**：
  - 发送端：`lib/integration/finance-sync.ts:277-292` `buildPurchaseOrderSyncPayload` 返回对象无 `lines` 键（grep `lines` 仅命中 `:310` 一条**谎称"载荷含 lines"的注释**）；三调用方 `procurement.ts:794`、`placeCore.ts:42`、`purchase-orders.ts:421` 均只传 PO 头。`app/actions/procurement.ts:457` 收货发 `line_id: itemId`（itemId = `procurement_line_items.id`）。
  - 接收端：财务 `route.ts:264` `const lines = Array.isArray(data.lines)?...:[]` 恒空 → `:284` `fin_po_lines.upsert` 永不执行；`handleGoodsReceiptRecorded` `route.ts:312-316` `.eq('line_id', lineId)` 恒 0 行 → `:316` 返回 `ignored`。
- **修法**：`buildPurchaseOrderSyncPayload` 增加 `lines` 数组（`line_id` 用 `procurement_line_items.id`，与收货发的 itemId 同源；含 order_id/material_name/ordered_qty/unit_price/amount），财务侧才能落 `fin_po_lines` 并按 line_id 核销。

#### P1-3 `collection.received` / `payment.completed` 两个资金进度事件是死代码——真实收款/付款进度对节拍器全黑盒
- **涉及系统**：财务 → 节拍器
- **断在哪**：`FinanceProgressEvent` 声明三种事件，节拍器接收端也认三种，但财务全仓只有 `settlement.closed` 一处调用 `notifyFinanceProgress`。代表"钱到账/付款完成"的另两种**从无 emit 点** → 节拍器永远收不到，即便修好 P2-3 的"推进收款节点"也没有触发源。
- **双端证据**：
  - 发送端：财务 `src/lib/integration/client.ts:58` 声明三事件；全 src grep `collection.received`/`payment.completed` 仅出现在类型声明；`notifyFinanceProgress(` 唯一实际调用点 `src/app/api/orders/[id]/settlement/route.ts:158`，硬编码 `'settlement.closed'`。
  - 接收端：节拍器 `app/api/integration/finance-callback/route.ts:68` `FINANCE_PROGRESS = new Set([...三种])`；后两者接收端认、发送端从不发。消费侧 `FinanceEventsTimeline.tsx:9-11` 为三事件都配了标签，结果时间线永远只显示 `settlement.closed`。
- **修法**：财务系统在实际登记收款/付款完成动作处调用 `notifyFinanceProgress('collection.received'/'payment.completed', {qimo_order_id,...})`；若无此业务动作则删除这两个 case 避免误导。

#### P1-4 超预算审批（`ensureBudgetApproval`）通知审批人=纯哑站内，无邮件无企微 → 采购卡死直至审批人主动登录
- **涉及系统**：节拍器内部（采购 → 业务经理/财务）
- **断在哪**：BOM 单耗超基线是硬闸（拦下采购提交），但 `notifyApprovers` 只写 `notifications` 表，不 `pushToUsers`、不 `sendEmailNotification`；全库无任何 cron 把 `budget_approval` 转邮件/企微。审批人不知有待办 → 采购卡死。
- **双端证据**：
  - 发送端：`app/actions/budget-approvals.ts:66` `ensureBudgetApproval` → `:84-90` `notifyApprovers` 仅 `svc.from('notifications').insert(rows)`（type=`budget_approval`），无 push/email。对照同仓 `price-approvals.ts:141-153`、`delays.ts:342/364-367`、`orders.ts:585-586` 全部走 `pushToUsers + sendEmailNotification`——唯独 budget_approval 两者都没有。
  - 接收端：`app/api/cron/reminders/route.ts` 三处读 notifications 表（`:177/252/401`）全是去重存在性检查，不扫 `budget_approval` 转发；无任一 cron 通用转发到邮件/企微。
- **修法**：`notifyApprovers` 末尾对 recipients 调 `pushToUsers`（budget_approval 属 URGENT 语义）并对审批人邮箱走 `sendEmailNotification`；或把 `budget_approval` 纳入 `shouldPushInstant` 白名单统一走 `sendNotification`。修复成本极低（照抄 price-approvals 两行）。

#### P1-5 里程碑激活判定读中文 `草稿` 却比英文 `'draft'` → 即便修好 stale key 仍激活不了（与 P0-1 叠加）
- **涉及系统**：节拍器内部（里程碑完成 → 订单激活）
- **断在哪**：`milestones.ts:921` 裸比 `=== 'draft'`，DB 默认存 `草稿`，`createOrder` 不写也不归一化。这是激活分支的**第二道独立坎**，与 P0-1 的 stale `finance_approval` key 相互独立。
- **双端证据**：
  - 发送端：`supabase/migrations/20240121000000_add_order_lifecycle.sql:9` `default '草稿'`；`app/actions/orders.ts:318-377` 无 lifecycle_status 也无归一化；`20260515_normalize_lifecycle_status.sql` 归一化迁移唯独没有 `草稿→draft`、也没改列 DEFAULT。
  - 接收端：`app/actions/milestones.ts:919-924` `.select('lifecycle_status')` 原样回读，`if (orderCheck?.lifecycle_status === 'draft')` → `'草稿' === 'draft'` 恒 false。映射证据 `lib/domain/lifecycleStateMachine.ts:66-85` 确认二者是需映射的不同字面量。
- **修法**：判定改成 `['draft','草稿'].includes(...)` 或先过 `normalizeLifecycleStatus` 再比较。若采用 P0-1 的"创建即 active"修法，此分支对新单不再关键，但仍应修以防旧 draft 单被卡（有 `activateOrderAction` 手动兜底，故非 P0）。

#### P1-6 财务回调批准 delay/milestone/price 后，节拍器侧申请人/责任人零通知
- **涉及系统**：财务 → 节拍器（回调后内部责任人）
- **断在哪**：`finance-callback` 收到审批结果后，price/delay/milestone 三分支**只 update 状态、不给任何人发通知**（站内/邮件/企微都没有），只有 purchase 分支调了 `notifyUsersByRole`。业务/跟单/责任人只能反复刷页面才知财务批了。
- **双端证据**：
  - 接收端：`app/api/integration/finance-callback/route.ts` price `:113-124` 仅 update `pre_order_price_approvals`、delay `:126-137` 仅 update `delay_requests`、milestone `:156-179` 仅 update `milestones`+recompute，均无 notify；全文件仅 purchase `:202/:218` 有 `notifyUsersByRole`。
  - "有接收人可通知"成立：`pre_order_price_approvals.requested_by`（`20260408_pre_order_price_approvals.sql:12`）、`delay_requests.requested_by`+`order_id`、`milestones.order_id`+`owner_role`+`owner_user_id`（`migration.sql:85-89`）；基建 `lib/utils/notifications.ts` 有 `createInAppNotification`/`notifyUsersByRole`。
- **修法**：三分支命中更新后查出申请人并 `sendNotification`（price_approval/delay_approved 已在 URGENT 表）+ `pushToUsers`，把"财务已批/驳回"即刻推给责任人。

#### P1-7 多方确认节点（po_confirmed 等）无人被通知"该你确认了"
- **涉及系统**：节拍器内部（节点 → 财务/生产/采购确认方）
- **断在哪**：改动②把 PO 确认改成财务+生产双确认，另有产前会/产前样/尾查/发货多方节点；门禁只在**完成时**拦截，全链路无任何代码在节点进入待确认时通知要求确认的"方"。各方只能自己翻订单详情卡片发现。
- **双端证据**：
  - 触发端：`lib/domain/confirmationParties.ts:42-45`（po_confirmed 需 finance+production）另有 `:47-51/:53-56/:58-61/:63-67` 多方节点；`app/actions/milestones.ts:454-471` 门禁仅完成时 `return {error}`，不发通知；`autoAdvanceNextMilestone :1172-1193` 只对 finance_approval 通知，对多方确认节点无分支。
  - 接收端：`milestone-confirmations.ts:108-197` `confirmMilestoneParty` 只在"有人确认后"判是否全齐，无通知未确认方逻辑；`MilestoneConfirmations.tsx` 是纯拉取式 UI。唯一部分缓解：`po_confirmed` owner_role=finance，转 in_progress 时命中 H3 钩子（`milestonesRepo.ts:663-681`）向**外部财务系统**发 `milestone.requested`——但仅触达 finance、不覆盖 production，且是外部 webhook 非节拍器内即时通知。
- **修法**：节点进入 in_progress/懒建确认行时（`ensureConfirmationRows`/`markMilestoneStarted`），对 `pendingParties` 每个 party.roles 用 `notifyUsersByRole+pushToUsers` 发"订单 X『节点名』待你确认"；每有一方确认后通知剩余方。

#### P1-8 取消审批"申请→财务""批准→采购/生产"通知均为哑站内，`cancel` 未走即时通道
- **涉及系统**：节拍器内部（取消申请 → 财务；批准 → 采购/生产）
- **断在哪**：`notifyUsersByRole` 只 insert notifications 表（`email_sent:false`），既不发邮件也不推企微。财务不知有取消待审批、采购可能继续为已取消单下单排产。
- **双端证据**：
  - 发送端：`lib/repositories/ordersRepo.ts:707-713` `requestCancel → notifyUsersByRole(['finance','admin'], type:'cancel_approval')`；`:893-898` `finalizeCancelledOrder → notifyUsersByRole(['procurement',...,'production',...], type:'order_cancelled')`。
  - 接收端：`lib/utils/notifications.ts:121-149` `notifyUsersByRole` 内部只 `insert`（`:137-141` 写死 `email_sent:false`），不调 sendEmail/pushToUsers、不查 policy。对照延期流三通道齐发（`delays.ts:216-217/342/364-367`）。
  - **修正**：emit 的 type 是 `cancel_approval`/`order_cancelled`，二者均未注册进 `NOTIFICATION_TIERS`，`getTier` 默认 DIGEST——即便去查策略也不会推。缺口双重成立。
  - **兜底存在（故 P1 非 P0）**：取消申请仍走 `syncCancelRequestToFinance`（`ordersRepo:716-729`）推财务队列、取消冲销走 `notifyOrderCancelled` finance webhook（`:887-891`），跨系统资金侧有独立可达路径。
- **修法**：给 `notifyUsersByRole` 增加：`shouldPushInstant(type)` 时对命中 user_id 调 `pushToUsers` 并 `sendEmailNotification`；或在取消两处显式追加。同时把 `cancel_approval`/`order_cancelled` 注册进 URGENT。

#### P1-9 节拍器→财务 订单同步不带 `customer_id`，财务只能按客户名匹配主体（`qimo_customer_id` 列永远空）
- **涉及系统**：araos → 节拍器 → 财务
- **断在哪**：araos 赢单已把客户 UUID 落到节拍器 `customers.source_araos_company_id`，但节拍器 `syncOrderToFinance` payload 只含 `customer_name`；财务只能调 `get_or_create_customer` 按客户名精确匹配。财务 `customers.qimo_customer_id`（identity spine 建的列）在 finance src 里从无写入=永久空。后果：同名/改名 → 挂错客户主体、AR 与利润归错；三系统同一客户无共享 ID、财务反查不到 araos/节拍器实体。
- **双端证据**：
  - 发送端：`lib/integration/finance-sync.ts:162-186` payload 无 `customer_id`/`qimo_customer_id`/`source_araos_company_id`（三词零命中），只有 `customer_name`（`:166`）；araos `lib/metronome/payloads.ts:23,58` 只把 `araos_company_id` 传节拍器，节拍器不向下游转发。
  - 接收端：财务 `src/app/api/integration/webhook/route.ts:792-803` `handleOrderSync` 用 `cleanCustomerName` 调 `get_or_create_customer(p_name)` 精确名匹配，写 `budget_orders.customer_id`（`:844`）；migration `20260629_...identity_spine.sql:19` 建 `qimo_customer_id` 列但全 src 零写入；`20260704_customer_exact_match.sql:7-8` 注释自认"节拍器订单 payload 目前只带 customer_name 不带 qimo_customer_id"。
- **修法**：节拍器 `syncOrderToFinance` payload 增补 `customer_id`（=`orders.customer_id`）与 `source_araos_company_id`；财务 `handleOrderSync` 用 `qimo_customer_id` 等值匹配优先、名匹配兜底，命中/新建后回写 `customers.qimo_customer_id`。

---

### 🟡 P2 — 排后修（数据陈旧/镜像失真/可运维性）

#### P2-1 araos 赢单 PO 明细只进通知文案，落不进任何可查结构化字段——业务凭一条通知手动重录建单
- **涉及系统**：araos → 节拍器
- **断在哪**：接收端 normalize 出的 `deal.{po_number,style,quantity,target_delivery,note}` 只拼进 `notifyUsersByRole` 的 message 文本；原始明细仅整包塞进 `araos_handoffs_inbox.payload`(jsonb)，该表全库无任何 UI/action 读取、RLS 默认拒绝。
- **双端证据**：发送端 araos `payloads.ts:52-75` 发完整单据字段（order_ref/product_lines/moq_agreed/required_delivery/order_value_usd）；接收端 `route.ts:170-183` 仅拼进通知文本、`:186-197` 明细进 inbox jsonb；grep 全库 `araos_handoffs_inbox` 仅命中写入端自身（`route.ts` + migration），无读取端。
- **修法**：建业务可读的"待建单收件箱"页面（读 inbox 走 service-role），把字段结构化展示并一键带入建单表单；或至少落成 `customer_pos` 草稿行。（注：按方案1既定"只传客户不自动建单"设计，客户已可靠落库，故 P2 非更高。）

#### P2-2 客户 upsert 未回写联系人/国别到已匹配老客户，老客户新联系方式被丢弃
- **涉及系统**：araos → 节拍器
- **断在哪**：`matchPath=source/name` 命中已存客户时只补写 `source_araos_company_id`，araos 带来的最新 `contact_name/email/phone/country` 完全不更新（只有全新客户才写）。重复赢单场景（常见路径）老客户资料停在首建旧值。
- **双端证据**：接收端 `route.ts:137-141`（source 命中不写字段）、`:142-152`（name 命中仅 `:149` 补 source_araos_company_id），字段仅在新建分支 `:153-167` 写入；发送端 araos `payloads.ts:58-63` 每次都带联系人（**修正**：order 路径实际带 contact_name/email，phone/country 只在 sample payload）。
- **修法**：命中已存客户时对 `contact_name/email/phone/country` 做"空则补、非空可选覆盖"合并更新（勿用 araos 空值覆盖已有值）。

#### P2-3 财务进度事件只落 append-only 日志，不推进任何里程碑/预算/风险（收款完成节点永远靠人手推）
- **涉及系统**：财务 → 节拍器
- **断在哪**：`settlement.closed` 等在节拍器只 upsert 进 `order_finance_events`（只读时间线），不推进 `payment_received`（is_critical=true）里程碑、不更新 `order_financials`、不解交付风险。资金到位对业务链纯展示、不参与流程推进。
- **双端证据**：发送端财务 `settlement/route.ts:158` `notifyFinanceProgress('settlement.closed', ...)`；接收端 `finance-callback/route.ts:68-91` FINANCE_PROGRESS 分支仅 upsert 后 return（`:87/:89`），里程碑/预算/风险动作全在 `:93` 之后的 approval_type 分支、该事件到不了；消费端 `order-financials.ts:110` 仅 select 展示；`lib/milestoneTemplate.ts:48` `payment_received` is_critical=true 存在但无一处被这些事件置完成。
- **修法**：收到 `collection.received/payment.completed` 时按 `qimo_order_id` 定位并把 `payment_received` 里程碑走 `updateMilestone` 推进（触发 recompute 钩子）再 `recomputeDeliveryConfidence`；`settlement.closed` 可选回写 `order_financials` 决算。（P2 因该节点仍可 finance 角色手工推进、链路不中断。）

#### P2-4 `budget.completed`（财务批完预算回传）链路完全不存在——发送端不发、接收端不认
- **涉及系统**：财务 → 节拍器
- **断在哪**：财务预算冻结/批复后无任何 `budget.completed` 或等价事件回传节拍器；节拍器 finance-callback 无识别预算完成的分支。
- **双端证据**：发送端财务 `client.ts:58` 出站事件仅三资金事件、无 budget.*；预算批复 `recompute-budget/route.ts:178` 置 `status='approved'` 不触发任何 callback。接收端 `finance-callback/route.ts:68` 集合无 budget、`:23` approval_type union 无 budget 分支。
- **修法**：若业务需要预算批复回传推进订单资料/放行采购，则财务预算确认处新增 `notifyFinanceProgress('budget.completed', {qimo_order_id,budget_amount,...})` + finance-callback 加分支；若不需要则文档明确该方向不做，避免语义悬空。（P2 因节拍器"财务审批"节点走 `approval_type='milestone'` 通道推进、有兜底；且预算主真相在财务侧、非复制符合宪法"生命周期非复制"。）

#### P2-5 重排订单改的工厂交期 `factory_date`/`warehouse_due_date` 发出但财务丢弃——`synced_orders` 无此列
- **涉及系统**：节拍器 → 财务
- **断在哪**：发送端刻意把新交期塞进 payload（注释"财务需看到新交期"），但财务 `handleOrderSync` upsert 不读这两字段、`synced_orders` 表也无这两列 → 财务台账停在旧交期，应收/回款计划口径错。
- **双端证据**：发送端 `finance-sync.ts:177-179` 发两字段、`reschedule-order.ts:250-253` 重排后 syncOrderToFinance('order.updated')；接收端 财务 `webhook/route.ts:473-496` upsert 只读 `factory_name/etd`、`schema-integration.sql` `synced_orders` 只有 `factory_name/etd` 无这两列，grep 财务 src 零命中。
- **修法**：财务 `schema-integration.sql` 给 `synced_orders` 加 `factory_date/warehouse_due_date` 列 + `handleOrderSync` 补读。

#### P2-6 采购单 `supplier_name` 未发送，财务应付主体名恒 null
- **涉及系统**：节拍器 → 财务
- **断在哪**：`buildPurchaseOrderSyncPayload` 只发 `supplier_id` 不发 `supplier_name`；财务读 `data.supplier_name ?? null` → 恒 null，应付台账只看到 UUID。
- **双端证据**：发送端 `finance-sync.ts:277-292` payload 无 supplier_name；接收端财务 `route.ts:249` `supplier_name: data.supplier_name ?? null`。部分缓解 `suppliers.ts:21` 走 `supplier.upserted` 发 name，但财务 `fin_purchase_orders.supplier_name` 列仍恒 null、且 supplier_id 只存进 `suppliers.notes` 自由文本无法可靠反查。
- **修法**：`buildPurchaseOrderSyncPayload` 增加 `supplier_name`（join `suppliers.name`）。

#### P2-7 normal 路径订单停留 `草稿`，从不补发 `order.activated`（仅发 `order.created`）
- **涉及系统**：节拍器 → 财务
- **断在哪**："去审批·创建即 active"后只有 import 路径显式置 active 并发 `order.activated`；normal 路径取 DB 默认 `草稿`、仅发 `order.created` 带 `草稿`，之后不再触发 activated。财务 `synced_orders.lifecycle_status` 长期停 `草稿`，与"创建即执行"口径不一致（预算不丢、仅状态镜像失真）。
- **双端证据**：发送端 `orders.ts:675` normal 发 `order.created`、insertPayload 不含 lifecycle_status → DB 默认 `草稿`；`order.activated` 只在 import(`:640`)/手动 `activateOrderAction(:1223)` 发。接收端财务 `route.ts:166-170` created/activated 同走 handleOrderSync 均建预算，但 `synced_orders.lifecycle_status` 落 `草稿`。
- **修法**：normal 路径插入后置 `lifecycle_status='active'` 并发 `order.activated`（或 order.created 就带 active）。**与 P0-1 同源，修 P0-1 时一并解决。**

#### P2-8 财务→节拍器 客户/订单反查通道只按 `order_no`，拿不到也回填不了 `qimo_customer_id`
- **涉及系统**：财务 → 节拍器
- **断在哪**：财务反查函数只有按 `order_no` 的，无按 `customer_id` 反查客户的通道；节拍器虽有 contract v1 `customers/[id]` 能按 `qimo_customer_id` 返回，但财务从未持有该 UUID（见 P1-9）也未接入。财务无法用 ID 精确双向反查客户主体。
- **双端证据**：发送端财务 `client.ts:114-197` 只有 `fetchOrder(s)FromMetronome` 按 order_no；grep 财务 src `contract/v1`/`qimo_customer_id` 零命中。接收端节拍器 `orders/[orderNo]/route.ts:28` 只按 order_no、`contract/v1/customers/[id]/route.ts:21-25` 能按 UUID 返回但财务无此 ID。
- **修法**：P1-9 补传 `qimo_customer_id` 落库后，财务接入节拍器 contract `customers/[id]` 端点，建立 财务 `customers.qimo_customer_id` ↔ 节拍器 `customers.id` ↔ araos `companies.source_araos_company_id` 三段可反查链。

#### P2-9 财务 `synced_orders.qimo_quote_id` 专列未即时落库，报价来源反查靠 JSON 内嵌
- **涉及系统**：节拍器 → 财务
- **断在哪**：identity spine 给财务建了 `synced_orders.qimo_quote_id` 专列，但 `handleOrderSync` 从不写它；只有 `quotation.frozen` 把 quote_id 塞进 `quotation_data` JSON 快照。订单先同步/未发 frozen 时该订单反查不到源报价。
- **双端证据**：发送端 `finance-sync.ts:162-186` order.* payload 无 quote_id、仅 `buildQuotationFrozenPayload:364` 在 frozen 才发；接收端财务 `webhook/route.ts:473-496` handleOrderSync upsert 无 qimo_quote_id、唯一写该列在 `:351`（handleQuotationFrozen 内）。
- **修法**：节拍器 order 同步 payload 增补 `origin_quote_id`（`orders.origin_quote_id` 已存在）；财务 `handleOrderSync` 落到 `synced_orders.qimo_quote_id` 专列。

#### P2-10 提醒/督办/升级靠 15 分钟 cron 轮询 + DIGEST 合并，非即刻；且 cron 一挂全部静默
- **涉及系统**：节拍器内部（提醒/督办/升级）
- **断在哪**：`remind_48/24/12/overdue` 在 policy 里是 DIGEST（只写站内、合并到每日简报）；到期/逾期/督办/升级/PO 提醒/财务 outbox 重试全挂 `/api/cron/reminders` 每 15 分钟单点，无独立健康告警——cron 一挂全部同时静默且无人知。
- **双端证据**：`vercel.json:7-11` `/api/cron/reminders */15`；`notifications.ts:330` DIGEST 类型 return 不发邮件；`notification-policy.ts:46-50` overdue/remind_* 全 DIGEST；`reminders/route.ts:13-53` 提醒/升级/PO/财务 outbox 全挂同一 handler；grep cron health/heartbeat/watchdog 全仓无命中。
- **修法**：提醒类保持 15 分钟可接受，但给 reminders cron 加失败告警（连续 N 次未跑成功 → 企微群机器人报警）；对真正紧急的 overdue 关键节点考虑降到即时企微而非仅进次日简报。（P2 因 URGENT 审批/风险事件仍即时发、提醒非即时是可接受设计；真正缺陷是单点无监控。）

#### P2-11 企业微信送达依赖群机器人 webhook 单点，未配 env 时全部推送静默失败（吞错、零可观测）
- **涉及系统**：节拍器 → 企业微信（所有推送）
- **断在哪**：`pushToUsers` 优先走 `WECOM_WEBHOOK_URL` 群机器人，三档 env 全缺 → 对无个人 push_key 用户返回 0，调用方普遍 `.catch(()=>{})` 吞错，无 outbox/重试/送达可观测性。
- **双端证据**：发送端 `wechat-push.ts:27-28` 未配 URL 直接 return false、`:48-55` 失败仅 console.warn、`:201-224` 三档降级全 no-op；约 15 处调用点吞错（`notifications.ts:502-509`、`reminders/route.ts:214-220`、`cost-control.ts:423` 等），仅 `nudge/route.ts:151-152` 用了返回值。**修正**：报告"多数哑通知连邮件都没有"被证伪——被点名两站点实际都有站内+邮件慢通道补位。
- **修法**：确认生产已配 `WECOM_WEBHOOK_URL` 并加启动自检；`pushToUsers` 返回送达数，关键审批推送为 0 时回退邮件并记 `delivery_failed` 审计。（P2 因关键升级点均有站内+邮件慢通道兜底、不破坏 HMAC 契约链；真实缺陷是零可观测。）

#### P2-12 财务侧删单红冲靠 `order_no`/`po_no` 文本定位，非稳定 ID → 占位符/空值致幽灵审批残留
- **涉及系统**：节拍器 → 财务
- **断在哪**：`handleOrderReversal` 撤审批按 `order_no`、关联采购单按 `po_no` 文本数组；若审批入库时 order_no 被占位符（`'(未标注订单)'`）或空值兜底，撤审批命中 0 行、幽灵审批残留。
- **双端证据**：发送端 `finance-sync.ts:203-207` `notifyOrderDeleted` 只带 order_no/internal_order_no/po_nos（业务单号非 ID）；接收端财务 `route.ts:610`（按 order_no 撤审批）、`:599`（按 po_no 文本匹配）、`:698` `handleGenericApprovalRequest` order_no 为空写占位。**降级依据**：真正动钱的冲销走稳定 ID（镜像按 `order.id:554`、预算按 FK`:561-574`）或保守人工，资金完整性不破，残留仅卫生问题。
- **修法**：审批同步以稳定 ID（approval id）为唯一键，`order.deleted` 冲销按 `qimo_order_id`/`purchase_order_id` 定位；审批入库 order_no 用真实值不用占位符。

---

### ⚪ P3 — 技术债/可维护性隐患（当前不断链）

#### P3-1 araos payload 字段名双端别名依赖，改名会静默丢值
- **涉及**：araos → 节拍器。当前字段全对得上，无现存断链，但契约无 schema 校验，任一端改名会被 optional-chain 静默吞成 null（仅退化通知文案一段字）。
- **证据**：发送端 araos `payloads.ts:60` order_ref、`:71` brand_requirements、`:65` product_lines；接收端 `route.ts:79` po_number=order_ref、`:84` note=spec_notes‖brand_requirements、`:80` style=stylesSummary(product_lines)‖styles_requested。
- **修法**：字段名固化为双仓共享契约常量（同一 zod/schema），或接收端关键字段缺失时落 warning 到 `inbox.error`。

#### P3-2 两套 timestamp 口径并存（contract=epoch ms vs finance-GET=ISO 串），复制签名代码会踩 401
- **涉及**：节拍器内部。当前 araos contract 链自洽正常，非断链；仅维护陷阱。
- **证据**：araos `contract-sign.ts:36` `Date.now().toString()` ↔ 节拍器 `v1/_lib/auth.ts:90` `Number(timestamp)`（对齐）；对照 `inbound-auth.ts:38` `Date.parse(ISO)`（另一口径）。
- **修法**：文档/注释显式区分两套端点口径，或统一为 epoch ms。

#### P3-3 财务 `ApprovalDecision` 类型缺 `'milestone'`，靠 `as` 断言绕过（运行时通、类型不设防）
- **涉及**：财务 → 节拍器。milestone 审批回传运行时打通、数据链不断；但财务类型层缺该值，将来按类型补 switch 会静默漏分支。
- **证据**：财务 `types.ts:125` union 无 milestone；`IntegrationApprovals.tsx:21/66` 透传含 milestone 字符串 → `approve/route.ts:46` `as ApprovalDecision` 强制；节拍器 `finance-callback/route.ts:23/:156` 分支正常处理。
- **修法**：财务 `ApprovalDecision.approval_type` 补上 `'milestone'`。

#### P3-4 仅 BOM 页填料、未走完整采购链的订单，生产中心恒显 `awaiting_procurement`、不自愈
- **涉及**：节拍器内部（BOM→执行行→生产中心）。兜底输出正确（确未下单），无崩溃/错值；属设计上的人工依赖。
- **证据**：接收端 `production-center.ts:62-66` m.total===0 时唯一自动进阶条件是 `procurement_order_placed` DONE；发送端 `autoCompleteProcurementPlacedForOrder`（`procurement-items.ts:204-207`）要求全部采购项 ordered，而采购项/material_plans active 唯一产生路径是 `submitBomToProcurement`，BOM 页填料不触发插入。
- **修法**：对 total=0 且 `procurement_order_placed` 未完成的单显式打"采购链未启动"标签，与真·新单区分，而非混在 awaiting_procurement。

#### P3-5 技术确认单必传闸无豁免口径，翻单/纯辅料单会被误锁在"提交采购"
- **涉及**：节拍器内部（BOM→提交采购）。设计内 gate 的边缘副作用，有明确绕过路径（上传一张确认单），非跨系统断链。
- **证据**：`bom.ts:703-709` `!hasTechConfirm` 无条件 return；`tech-confirm.ts:46-51` 仅按附件 count 无订单类型豁免。
- **修法**：技术确认单闸增加豁免口径（翻单 repeat/trade/无布料行免传），或允许"无技术确认单原因"留痕放行。

---

## 四、"完美对接·即刻可达"差距清单（对照用户 5 项要求逐条打分）

| # | 用户要求 | 打分 | 依据 |
|---|---|---|---|
| 1 | 数据链完整流通 | **部分** | 主干每跳能派生，但 P0-1 激活断点使新生产单不进风险体系；P1-2 采购 lines 缺失致收货核销 100% 失败；P2-1 PO 明细落不进结构化字段。流而不全。 |
| 2 | 审批通知及时到达各系统 | **否** | 内部超预算/取消/多方确认/财务回调结果普遍只写哑站内通知（P1-4/6/7/8），审批人靠登录看铃铛；延期审批根本不推财务（P1-1）。"即刻可达"在审批维度系统性不达标。 |
| 3 | 跨系统映射完整高效准确即时 | **部分** | ID 链只通两跳（araos→节拍器客户、节拍器→财务订单）；客户维度断在节拍器→财务（P1-9，无 customer_id，同名即错配）；报价/供应商反查靠 JSON/文本（P2-6/9）；PO 明细不结构化（P2-1）。 |
| 4 | 三系统完美对接 | **部分** | HMAC/API Key/幂等/outbox 底座对齐、握手正常、审批批准子链真通；但资金进度回传（collection/payment/budget）三分之二是死代码或不存在（P1-3/P2-4），重排交期/供应商名被财务丢弃（P2-5/6）。对接≠对齐。 |
| 5 | 审批通知即刻可达 | **否** | 与第 2 项同源。唯一真正即时的是 URGENT 类站外推送，但企微单点无可观测（P2-11）、多数关键审批 type 未注册 URGENT（P1-8）、财务回调结果零通知（P1-6）。提醒类 15 分钟 cron 尚可但单点无告警（P2-10）。 |

**总评：5 项中 0 项"是"，3 项"部分"，2 项"否"。** 两个"否"都落在通知/即达维度——这是当前离"卡风险不走流程"设计目标最远的一块。

---

## 五、修复优先级建议

### 第一批（P0 — 立即，本周内）
1. **P0-1 修复生产单激活断点**（命门，先做）：`createOrder` 正常路径显式置 `lifecycle_status:'active'` 并发 `order.activated`，同时把 `milestones.ts:910` stale key 改为 `['po_confirmed']`、`:921` 判定改为 `['draft','草稿'].includes(...)`。
   - **一次改动同时解决 P0-1 + P1-5 + P2-7**（三者同源：激活口径与状态镜像）。
   - 验证：新建一张标准 V2 单，确认 `lifecycle_status='active'`、能进 agent-scan/morning-briefing/daily-summary 三面板、财务侧 `synced_orders.lifecycle_status` 镜像为 active。

### 第二批（P1 通知即达 — 紧接 P0，一周内）
这批修复成本低（多为照抄现有 pushToUsers/sendEmail 两行），收益直击"审批即刻可达"：
2. **P1-4** 超预算审批加 `pushToUsers + sendEmailNotification`（采购卡死，最痛）。
3. **P1-6** 财务回调 price/delay/milestone 三分支补申请人通知。
4. **P1-8** 取消审批注册 URGENT + 走即时通道；**P1-7** 多方确认节点进入待确认时通知各方。

### 第三批（P1 跨系统断链 — 两周内）
5. **P1-2** 采购单 payload 增补 `lines`（收货核销从 0% 恢复，财务应付正确性）。
6. **P1-1** 延期审批补 `pushDelayApprovalToFinance` 调用。
7. **P1-9** 订单同步增补 `customer_id`/`source_araos_company_id`，财务按 ID 匹配并回写 `qimo_customer_id`（打通客户 identity spine，同时为 P2-8 铺路）。
8. **P1-3** 财务端在真实收款/付款完成处补发 `collection.received`/`payment.completed`（否则 P2-3 无触发源）。

### 第四批（P2 数据质量/可运维 — 排期）
9. P2-3（收款节点自动推进，依赖 P1-3 先落）、P2-5（重排交期列）、P2-6（supplier_name）、P2-1（PO 明细收件箱页面）、P2-11（企微送达可观测 + 启动自检）、P2-10（reminders cron 健康告警）。
10. P2-4/P2-9/P2-8/P2-2/P2-12 视业务需要排入。

### 第五批（P3 技术债 — 随手清）
11. P3-1（契约字段共享 schema）、P3-3（财务补 milestone 类型）、P3-2（timestamp 口径注释）、P3-4/P3-5（生产中心标签 + 技术确认单豁免）。

**决策要点**：P0-1 是唯一直接掏空产品核心卖点的断点，必须最先且独立验证；第二批"通知即达"投入产出比最高（几行代码换回整个审批链的即时性）；第三批才是真正的跨系统数据正确性修复，工作量较大需分单推进。

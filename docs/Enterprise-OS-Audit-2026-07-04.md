# QIMO 企业 OS 全面审计报告 — 2026-07-04

> **范围**:三仓库全企业 —— QIMO OS(order-metronome,910 文件)、araos 客户开发
> (292 文件)、财务系统(finance-system,550 文件),三独立 Supabase。
> **方法**:7 个并行审计员,7 个维度(QIMO 功能/算账 · QIMO 权限安全 · QIMO 角色使用 ·
> QIMO UI · araos 综合 · 财务综合 · 跨仓数据链)。多审计员交叉印证的标 ✕N。
> **纪律**:发现是线索,修前先复现。已修的不重报。

---

## 一句话结论

**三个系统各自内部大体跑通,但"企业数据链"严格说还没真正通电**,叠加**若干直接失守级安全洞**和**算钱/卡闸的旁路**。最危险的三类:①认证/提权失守;②删单/取消不冲销财务、赢单静默不进 QIMO(数据链断);③补采购闸旁路 + 库存抵扣算错。

---

## ✅ 已修复(本次,已推送)

| commit | 修了什么 |
|---|---|
| `8548a09` | **账号接管后门**(update-password Method 3 删除)+ **profiles roles[] 自助提权**(守卫加数组判定,迁移待执行) |
| `d6d0cde` `d67819b` | 执行层底价直连读列级封锁 + 生产经理不看底价(前序会话) |

---

## 🔴 P0 — 直接失守 / 算错钱 / 丢单 / 数据永久不一致

### A. 安全 · 认证与提权(QIMO)
| # | 位置 | 问题 | 状态 |
|---|---|---|---|
| A1 | `app/api/auth/update-password:44` | 公开路由凭 body.user_id + service-role 改任意人密码 → 账号接管 | ✅ 已修 `8548a09` |
| A2 | `profiles` 守卫 trigger | 只拦标量 role 不拦 roles[] → 直连自升 admin | ✅ 已修(迁移待执行) |
| A3 | `app/actions/order-notes.ts:83` deleteOrderNote | 零校验,任意人删任意订单备注(篡改审计) | ⬜ 待修 |
| A4 | `app/actions/batch-milestones.ts:83` | 非执行者分支空 no-op → 任意人驱动任意订单出运节点完成(绕 QC 放货) | ⬜ 待修 |
| A5 | suppliers 读(`suppliers.ts:41` getSupplier/listSuppliers)+ `purchase-orders.ts:169` getPurchaseOrder 的 `suppliers(*)` | 供应商银行账号/税号/账期对全体登录用户可读(读没脱敏) | ⬜ 待修 |
| A6 | `app/actions/order-line-items.ts:15` | 逐款明细/PO快照无订单级鉴权 → 跨单读;merchandiser 全局放行 → 跨单改 | ⬜ 待修 |
| A7 | **根因** | 整库 RLS 基线 = `auth.uid() IS NOT NULL`(只认证不授权)→ orders/suppliers/PO/customer_po/milestones 等可 PostgREST 直连绕过 action 门禁 | ⬜ 根因治理 |

### B. 安全 · 资金动作越权(财务系统)
| # | 位置 | 问题 |
|---|---|---|
| B1 | `api/gl/process` + `gl/queue/[id]/retry` + `orders/[id]/settlement` | 只 requireAuth 无 requireRole → 任意登录用户触发过账/确认决算/生成应付 |
| B2 | `lib/accounting/fx-gains.ts:42` | 汇兑重估取所有 approved/closed USD 单(不看是否已收清),每期对已结汇老单反复计提 → 凭空入账 |

### C. 数据链 · 跨仓断链(交叉印证 ✕2,跨仓+araos)
| # | 位置 | 问题 |
|---|---|---|
| C1 | QIMO emit `order.deleted` / 财务 webhook | 财务**不接收** order.deleted/cancelled(落 default:ignored) → 删单/取消后预算草稿+应付**永久残留成幽灵单据**;QIMO 刚把发送端当 P0 修了却没接收端,给"已修复"错觉 |
| C2 | 财务 `fin_inbox_events`/`fin_purchase_orders`/`fin_po_lines` | 三张接收核心表**全仓无 migration** → 若线上没建,采购→应付链默默断;幂等降级成每实例内存 Map |
| C3 | araos→QIMO handoff | 协议不对齐(araos 发 bearer webhook 打 `/api/intake`,QIMO 无此路由;0c 队列纯设计没建)+ 默认关 → 赢单永久死在 `metronome_handoffs=pending`,只能人工搬 |
| C4 | araos handoff error 态 | error 永不重试 + 全仓无 UI/健康/审计读该表 → 确认的订单静默丢给生产端,无告警 |
| C5 | 共享 ID 脊柱(三仓) | 跨库 ID 列全建了、**无一行代码写入** → 财务靠客户名模糊匹配建预算,同名撞车/异名漏配 |
| C6 | QIMO emit `supplier.upserted` / 财务 | 财务不接收 → `fin_purchase_orders.supplier_id` 指向财务侧不存在的 UUID(孤儿应付主体) |

### D. 算账 / 卡闸旁路(QIMO)
| # | 位置 | 问题 |
|---|---|---|
| D1 | `procurement-items.ts:492` | 补采购降级插入分支 strip 掉 is_supplement/finance_approval_status → schema-drift 时补采购项变普通项,**财务闸完全不触发**(漏钱) |
| D2 | `procurement-items.ts:369` | 生产单耗路径 `pieces×prod` 重算毛需求,**丢掉 MRP 已扣库存** → 重复采购已有库存(MRP_INVENTORY_DEDUCT 开时算错) |
| D3 | `procurement-items.ts:355` | 老行按 `net/dev` 反推件数,net 已扣库存且向上取整 → 件数低估/噪声污染 → 采购量错 |
| D4 | `lib/services/netting.ts:49` | 跨订单 netting 归并键不传 material_master_id,退化为名称键;与库存/采购项/入库的 master-id 键**两套口径对不上** |

---

## 🟠 P1 — 会丢/会错但当前被兜住 / 局部降级 / 敏感读未收窄

### 数据链
- **幂等键每次随机生成**(finance-sync.ts:55)→ 形同虚设,靠业务层 upsert 兜住;任何未来 INSERT 型事件会立刻重复入账。
- **全链 fire-and-forget**,失败即丢,无 outbox/重试/死信;未配 URL 静默跳过。
- **finance-callback 无时间戳防重放 + 无幂等 + 盲写不校验命中行**。
- 财务→QIMO 拉单打 404(`/api/integration/orders/{no}` 不存在,新契约端点财务无 client)。
- **两套签名口径并存**(新契约 API 部署了但没通电,财务/araos 无对应 client)。
- 契约 V1.1 加厚 payload(PO lines[]、收货/补采购事件)QIMO 未 emit → 财务做不了单款预算/决算。

### 安全(QIMO)
- **~10 个 cron 路由 fail-open**(CRON_SECRET 未设即跳过守卫,service-role 裸跑);araos 4 个 cron 同病。
- `commissions.ts:52` calculateOrderScore **零 auth**;`getOrderCommissions:327` 佣金费率/等级无角色门禁。
- `customer-profile.ts` / `customer-credit.ts` 客户营收/信用画像无 CAN_SEE_FINANCIALS 门禁(后门)。
- milestones 读(getMilestonesByOrder/getUserMilestones/getMilestoneLogs)、order-notes 写、订单级延期 createOrderLevelDelayRequest 全局 isSales 分支 —— 均无订单归属校验。
- 采购"上次采购"记忆(procurement-tracking)带 unit_price 未剥离(主查询剥了此处漏)。

### 安全 / 资金(财务)
- `requireAuth` role 查不到时默认回退 `finance_staff`(fail-open 提权)。
- USD 供应商付款(对账单页直录未折 CNY)→ gl-queue 缺汇率抛 MISSING_RATE 永挂 failed,**付款永不入账**。
- `corrected_by:'current_user'` 字面量(审计身份伪造,批次A同类漏网)。
- order.cancelled 不红冲已确认收入 → 虚增收入/应收挂账。

### 算账(QIMO)
- **利润 `||` 吞零三连**(profit.service.ts:96-102):cost_cmt/cost_material 合法 0 值被当缺失 fallback → 加工费/材料成本算错 → 毛利失真。
- **完整度检查恒真 bug**(profit.service.ts:53):`!!x !== undefined` 恒 true,运费永远算"已填"。
- 汇率兜底硬编码 7.2 静默参与毛利,无告警。
- recordReceipt 覆盖写与 batch 累计/库存 delta 口径混用,超收可能漏判。

### 角色使用(QIMO)
- **待审批/待办总入口断裂**(骨架 P0→归为流程 P1):聚合服务 pending-approvals 存在,却不在任何角色导航落地路径;`/my-today` 不在 Navbar。财务/业务/生产主管无法从导航到达自己的待批队列。
- 生产/QC 在生产 tab **只读不能报产量**(canReport 排除 production/qc)。
- PO→Order 明细/BOM 写入无断言无测试;富录入布料款级信息逐行复制存储;`internal_order_no` "财务审批"是空承诺(UI 指向不存在的流程)。

---

## 🟡 P2 — 一致性 / 稳健性 / 可观测性 / UI
- MRP 布料需求 `Math.ceil` 到整数(kg/米小数合法)→ 系统性偏大;时区解析不一致(±1 天灯色抖动);归并键颜色中英文别名不覆盖 netting/库存;降级正则过宽掩盖真错。
- 财务:webhook 缺 timestamp 放行、rateLimit 内存态多实例失效、无鉴权 health 端点需核回显。
- UI:风险语义色**三套并存**(red/rose、green/emerald、amber/yellow);design tokens 存在但几乎没人用;多张宽表无 sticky 表头/首列(BomTab/ProcurementTrackingTab/quoter);`MilestoneActions.tsx:959` HTML 结构破损;多处对比度不达 WCAG;价格屏蔽靠零散布尔无统一 `canSeePrice` helper;重路由缺 loading 骨架。

---

## 关键算账函数单测缺口(高危,算钱/卡闸却零护栏)
`computeSuggestedPurchaseQty`(建议采购量)· `overReceiptCheck`(收货±10%硬闸)· `orderableQty`(出单量=定案−抵扣)· `consolidateProcurementItems` 组装逻辑(布料按款×色算料)· `priceVarianceLevel`/`computeLineLamp`(价格标色+红黄绿灯)· `assessSmallBatch*`(碎单预警)· `aggregateProfitNumbers`/`checkDataCompleteness`(利润,P1 bug 全在此)。
> 2026-07-04 已修的收货三入口/色名翻倍/删单半删/MRP 不暗扣损耗**逻辑正确但全部无单测护栏**,回归风险高。

---

## 各仓亮点(经核实非应付,避免误伤)
- **araos**:报价泄价红线到位、不假发邮件、治理闸门 server 端强制纯函数、策略引擎真算法、34 表全开 RLS。
- **财务**:GL 凭证构造即自平衡+双保险、外币缺汇率抛错不套默认、收款差额模型全走 DB RPC 事务+余额守卫、供应商付款结构化幂等键、cron fail-close。
- **QIMO**:用户管理红线全到位、契约 API HMAC+防重放稳、里程碑执行权限逻辑扎实、RuntimeRiskCard 四维呈现清晰、orders 列表双布局是范本。

---

## 建议修复路线(分批,每批 build+check+push)
1. **✅ 批1(已完成)**:账号接管 + roles[] 自助提权。
2. **批2 QIMO 鉴权洞**(补几行):deleteOrderNote/batch-milestones/order-line-items 加订单级鉴权 + 供应商财务列脱敏 + cron 全改 fail-close。
3. **批3 财务资金越权**:gl/process、retry、settlement 补 requireRole;requireAuth 缺 role 回退最小权限;fx-gains 重估口径;corrected_by 真身份。
4. **批4 算账/卡闸**:补采购闸旁路(D1,禁降级)、库存抵扣生产单耗路径(D2/D3)、利润 `||` 吞零 + 恒真 bug、netting 归并键统一;**同步补关键算账单测**。
5. **批5 数据链**(最需跨仓协调,最该先确认再动):先查财务三张接收表线上是否存在(C2)→ 财务接 order.deleted/cancelled/supplier.upserted 冲销(C1/C6)→ 幂等键改稳定实体键 + outbox 重投(P1)→ araos handoff 定协议通电(C3/C4)→ 共享 ID 脊柱接线(C5)。
6. **批6 角色使用 + UI**:待办总入口进导航、生产/QC 可报产量;风险色收敛到单一真相源、宽表 sticky、修 HTML 破损。

## 需你执行的迁移(Supabase SQL Editor)
- `20260704_guard_profiles_roles_array.sql`(批1,堵自助提权)
- `20260704_pli_floor_column_revoke.sql`(前序,执行层底价封锁 —— 若还没跑)

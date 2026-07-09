# 采购 + 库存链审计 · 剩余待办清单（P1/P2）

> **背景**：2026-07-04，4 个审计员并行深挖采购 + 库存链（4000+ 行），四维度覆盖
> 数据链贯通 / 算账正确 / 权限安全 / 边界健壮。多处问题被 2–3 个视角独立交叉印证。
> P0 已分五批修复推送完毕（见下方"已关闭"）。本清单是**剩余 P1/P2**，按优先级排。
>
> **纪律**：每条修前先"复现"（写一条能触发的单测或跑一次真实路径），确认现象真实再动手——
> 审计发现是线索不是结论。改完补单测锁回归。

---

## 已关闭（P0 五批 + 批 5，2026-07-04）

| 批 | commit | 关闭的问题 |
|---|---|---|
| 1 泄价（读侧） | `86e7eb3` | 核料/对账页 server 端剥离底价；归并主入口角色门禁；`getOrder` 订单级访问控制；`procurement_items` RLS 收紧 |
| 2 多买料 | `7898a20` | 色名双重累加翻倍；收货 ±10% 闸统一到 3 入口；补算账单测 |
| 3 库存抵扣 | `20b4165` | `final_purchase_qty` 语义拆开（防重复采购）；`consumeReservation` 领料兑现（防永久锁死）；执行行补 `required_by`（恢复采购灯/超期） |
| 4 删除订单 | `5c7f76c` | 防半删残废订单；采购单孤儿清理；财务 `order.deleted` 作废联动 |
| 5 泄价（写侧） | `b16f0fe` | 对账层增删行/批量增/同步/手填底价/导出含价对账单 → 全收紧到采购角色 |

---

## ✅ 已修（P0 残留 · 执行层底价可浏览器直连读）— commit `d6d0cde`，2026-07-04

> **状态**：代码已推送；**迁移 `20260704_pli_floor_column_revoke.sql` 待用户执行**
> （REVOKE 表级 SELECT + 动态 GRANT 回非价列）。代码不依赖迁移先后，可先部署。
> 修法见下（保留原分析备查）。顺带修了两处同源既有泄价：getProcurementQueues 未剥价、
> supply-chain 概览把底价挂在含 sales 的 canSeeFinancials 上（改挂 CAN_SEE_PROCUREMENT_FLOOR）。
>
> **已决（commit `d67819b`）**：用户拍板 production_manager 不看大货底价 →
> `lib/procurement/visibility.ts` 的 `procurementCost` 移除 `production_manager`（现 = admin/procurement）。
> production_manager 仍可看采购视图（供应商分组/执行量），只是不含底价/金额。
> （注：`procurement_manager` 也不在本视图 cost 名单，但它是 PO 审批角色、经主采购页可见底价，本视图 gap 不影响审批；如需可另加。）

> **原分析（备查）**：2026-07-04 批 1 的 RLS 迁移只收紧了**归并层 `procurement_items`**。
> **执行层 `procurement_line_items` 的直连底价读曾一直开着**——这是两张不同的表
> （见 [procurement-spine-b3]），批 1/批 5 都没覆盖到执行层的列级泄露。

- **现象**：`procurement_line_items` 的 `pli_select` RLS（`20260703_pli_procurement_access.sql`）=
  `user_is_procurement_side(uid) OR user_can_access_order(uid, order_id)`。RLS 是**行级、管不到列**。
- **触发**：
  - `user_is_procurement_side` **包含 `merchandiser`（跟单）** → 跟单浏览器直连
    `select order_id, material_name, unit_price from procurement_line_items` 拉到**全库所有订单底价**。
    跟单**不在** `CAN_SEE_PROCUREMENT_FLOOR` 名单 → 直接违背"底价对业务屏蔽"红线。
  - 订单创建者/负责人（建单 sales）直连读到自己订单的执行层底价。
- **为什么 action 门禁挡不住**：`getProcurementItems` 等在 server action 里用 `maskFloorForLines`
  剥价，但**直连 PostgREST 绕过 action 层**，maskFloorForLines 形同虚设。
- **影响**：底价、供应商成交价对业务/跟单**实质透明**（只要会开浏览器控制台）。红线级。
- **改法（需 service-role 重构，非小改）**：
  1. `REVOKE SELECT (unit_price, ordered_amount, difference_amount) ON procurement_line_items FROM authenticated;`
     + `GRANT SELECT (其余非价列) ...` → 任何 authenticated 直连都读不到价列。
  2. 需要底价的读路径（核料/对账/导出）改走 **service-role 客户端** 或 SECURITY DEFINER RPC，
     在其中按 `CAN_SEE_PROCUREMENT_FLOOR` 决定是否带价 → 保留 floor 角色能力，堵死直连。
  3. 把 action 里的 `select('*')` 改成显式列，避免 revoke 后 `*` 整体失败。
  4. 同法评估 `procurement_items` 归并层：批 1 只做了**行级**收紧，`unit_price` 列同样能被
     采购侧/订单可见者直连读；若要对"能看行、但不能看价"的角色（如 merchandiser 若纳入采购侧）
     彻底屏蔽，也需同样的列级 revoke。
- **文件**：`supabase/migrations/`（新迁移，列级 revoke/grant）；`app/actions/procurement.ts`
  + `app/actions/procurement-items.ts`（读路径改 service-role + 显式列）；`lib/domain/roles.ts`。
- **验收**：用跟单账号 + 订单创建者账号各跑一次直连 `select ... unit_price ...` → 应拿不到价列
  （报权限错或列不存在），而采购/财务经 action 仍能看到价。

---

## P1 — 该尽快排（不涉资金/泄密，但会静默丢数据或误导决策）

### P1-1 · 上游 join 不接 error → 静默丢数据
- **现象**：采购项相关查询用 `.select('a, b, foreign(...)')` 但只取 `data`、不看 `error`。
  FK 缺失 / 列名拼错时整条查询 fail，`data=null` 被当"无数据"吞掉。
- **触发**：PostgREST schema 缓存里关系不存在时（新表 FK 未声明），页面显示"空"而非报错。
- **影响**：核料/对账数据凭空消失，排查方向被带偏（会先怀疑 RLS，参见 [prod-schema-drift]）。
- **改法**：`const { data, error } = await ...`，`if (error) return { error: error.message }`。
  `bom.ts` 已修一处，采购项查询这处漏了。
- **文件**：`app/actions/procurement-items.ts`（listProcurementItems / getProcurementItems 的上游 join）。

### P1-2 · 降级正则过宽 → 静默丢箱数 / 补采购绕过财务闸
- **现象**：解析/降级分支的正则匹配过宽，能吃掉本该保留的字段（箱数），
  或让补采购走进不经财务审批的分支。
- **触发**：输入格式稍偏离预期模板时命中过宽分支。
- **影响**：生产任务单箱数丢失；补采购绕过 ±10% / 财务闸。
- **改法**：收紧正则到精确格式；补采购一律强制过财务审批分支，删掉"降级绕过"路径。
- **文件**：补采购解析处 + 降级分支（需定位：grep 补采购/降级正则）。

### P1-3 · 重复入库并发窗口
- **现象**：收货入库无幂等键 / 无行锁，快速连点或并发两次收货可能重复入库。
- **触发**：网络慢用户连点"确认收货"；或两人同时收同一行。
- **影响**：`inventory_transactions` 重复流水 → 派生库存虚高 → 后续抵扣误判有货。
- **改法**：入库加幂等键（batch_id / receipt_id 唯一约束）或行级锁；写前查重。
- **文件**：`app/actions/inventory.ts` recordInventoryReceipt；`recordReceiptBatch` / `recordGoodsReceipt`。

### P1-4 · 纯抵扣项让"待采购卡"不消失
- **现象**：一个采购项若需求被库存全额抵扣（出单量=0），它仍停留在"待采购"卡不消失。
- **触发**：库存充足、`stock_deduct_qty` 覆盖全部需求的采购项。
- **影响**：采购看到永远处理不掉的幽灵卡，误以为还要下单 → 可能重复采购。
- **改法**：待采购队列过滤条件加"派生出单量 > 0"；出单量=0 的归到"已由库存满足"分组。
- **文件**：`getProcurementQueues`（procurement.ts:1018）+ 前端队列筛选。

### P1-5 · 退货补料"只进不退"
- **现象**：退货/退料场景只做了入库方向，出库（退回供应商 / 冲减）没做。
- **触发**：收到料后发现质量问题需退货。
- **影响**：库存账面只增不减，虚高；真尾货算不准。
- **改法**：补退料出库流水（append-only 负向流水），走同一 ±10% 单位口径。
- **文件**：`app/actions/inventory.ts`（消耗/退料域，W1-W2 范围，见 [inventory-consumption-domain]）。

---

## P2 — 可排后（体验 / 稳健性 / 长期，不影响资金与泄密）

### P2-1 · MOQ 对安全库存放大
- **现象**：建议采购量同时叠加 MOQ 下限和安全库存，二者可能重复放大需求。
- **影响**：建议采购量偏高，采购需人工下调。
- **改法**：明确 MOQ 与安全库存的叠加顺序（取 max 而非相加？），补单测固化口径。
- **文件**：`computeSuggestedPurchaseQty`（已有单测，扩充 MOQ×安全库存组合用例）。

### P2-2 · ±10% 收货闸单位不校验
- **现象**：超收比例按数值算，但不校验收货单位与订购单位是否一致（kg vs 匹）。
- **影响**：单位不一致时 ±10% 判定失真（可能误放行或误拦）。
- **改法**：`overReceiptCheck` 入参加单位一致性校验，不一致直接拦并提示换算。
- **文件**：`lib/domain/procurement.ts` overReceiptCheck（已有单测，加单位用例）。

### P2-3 · 3% / 10% 双阈值易混
- **现象**：对账差异警示用 3%，收货超收闸用 10%，两个阈值散落、命名不清易混改错。
- **改法**：抽成命名常量（`RECONCILE_DISCREPANCY_PCT=3` / `OVER_RECEIPT_PCT=10`）集中定义。
- **文件**：procurement.ts:118（3%）+ overReceiptCheck（10%）。

### P2-4 · 真尾货依赖人工录领料
- **现象**：真尾货 = 采购入库 − 实际消耗，但"实际消耗"靠人真录领料，不录则尾货算不准。
- **影响**：尾货数字取决于人的录入自觉，非系统真相。
- **改法**：长期靠 W1-W2 领料域落地（见 [inventory-consumption-domain]）；短期在尾货卡标注
  "基于已录领料，未录领料的款尾货偏高"。
- **文件**：库存/消耗域（W1-W2 路线）。

### P2-5 · 关键算账函数单测覆盖仍不全
- **现象**：`overReceiptCheck` / `computeSuggestedPurchaseQty` 已补单测（批 2）；
  但逐款求和、色名归并、真尾货、库存抵扣派生出单量等路径仍无单测。
- **影响**：这类"多算两匹布"的洞正是从无单测的算账路径溜进来的。
- **改法**：给每个纯算账函数补边界单测，纳入 `scripts/pre-deploy-check.ts`。
- **文件**：`bom.ts` 逐款求和 / 色名归并；`deductFromStock` 派生量；对应 check 脚本。

---

## 建议排期

1. **P1-1（join 不接 error）** — 最省事、最易踩坑，半小时，先做。
2. **P1-4 + P1-2** — 影响采购决策（幽灵卡 / 绕过财务闸），一组做。
3. **P1-3（并发入库）** — 需加约束/迁移，单独一批。
4. **P1-5（退料出库）** — 属库存消耗域 W1-W2，随该域推进。
5. **P2 全部** — 随手补，或攒一批做常量抽取 + 单测补全。

> 关联记忆：[procurement-chain-audit-fixes] · [inventory-consumption-domain] ·
> [procurement-spine-b3] · [trial-security-audit]

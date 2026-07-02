# 订单录入 → BOM → 提交采购 → 采购模块 全链审计
**日期**:2026-07-02 · **方法**:3 路并行代码探查 + 生产库 schema 探测 + 人工逐条验证
**范围**:订单录入两路径 / BOM 五入库口 / 提交采购五层脊柱 / 采购核料归并 / 采购单建-审-下-收-库存闭环

---

## 结论一句话
五层脊柱(BOM→快照→计划→MRP需求→核料→执行行→采购单→收货→库存)**架构完整、方向正确**,但有 **3 个已验证的高危断点**(其中 2 个是今天 S1.2 每款布料上线后新引入的口径错位)和一批权限/流程债。

---

## 🔴 必修(全部经人工验证,非 agent 推测)

### R1. 多款订单的款级布料 MRP 需求被整单数量放大
- `submitBomToProcurement` 对每行 BOM 都用 `po_quantity = orders.quantity`(整单)喂 MRP;`lib/services/mrp.ts:111` `gross = po_quantity × qty_per_piece`。
- S1.2 之前 BOM 无款维度,该假设成立;现在 `style_no` 款级布料行(每款单耗不同)会按**全订单件数**放大 → 多款订单布料采购需求系统性偏大 → 多买。
- **修法**:快照行带 `bom_id` → 需求生成时回查 `materials_bom.style_no` → 款行用该款件数(Σ order_line_items.qty_pcs where style_no),整单通用行才用 orders.quantity。无需改表。

### R2. 缺单耗的 BOM 行在采购链里被静默吞掉
- `qty_per_piece=null` → MRP `status='needs_input'`, `net_purchase_qty=null`(mrp.ts:105-109)→ 核料归并 `Number(null)||0` 计 0(procurement-items.ts:81)→ 该物料**无声消失**,采购不知道漏了。
- 高发面:AI 识别行经常没单耗;布料同步行单耗留空时同样中招。
- **修法**:①提交采购前硬校验/警示缺单耗行清单;②核料归并把 needs_input 行显式列成「⚠ 缺单耗」项而非并 0。

### R3. 采购中心「待下单」队列永远为空(执行行状态断链)
- `procurement_line_items.line_status` DB 默认 `'draft'`(20260613_procurement_center_v1.sql:17);`buildExecutionLineRow` 不设状态;**全代码库无任何写入 `'pending_order'` 的地方**(grep 验证)。
- 队列过滤 `line_status='pending_order'`(procurement.ts:887)→ 核料生成的执行行在采购中心三个队列全不可见;风险中心 matters 判断同样漏。
- 现在能用是因为「新建采购单」页只按 `purchase_order_id IS NULL` 过滤,绕过了状态。
- **修法**:`buildExecutionLineRow` 显式 `line_status:'pending_order'` + 一条 SQL 把存量 draft 行(未归单的)批量更新。

---

## 🟠 建议尽快

| # | 问题 | 位置 | 说明 |
|---|---|---|---|
| O1 | 「从 PO 创建」不落逐款明细、不同步布料 BOM | order-from-po.ts:89-120(FormData 从不 set line_items) | PO 继承的是报价快照行(无色码矩阵),属设计局限;建单后可在生产任务单 tab 补录(链路通)。可改进:把 snapshot lines 至少 seed 成款级骨架 |
| O2 | AI 解析的 `unit_consumption`(单件用量)解析了但没喂给布料单耗 | LegacyOrderForm 预填映射;po-parser 已解析 measurements/quality_notes/sample_requirements 同样未用 | 白花解析 token;补映射即可缓解 R2 |
| O3 | createOrder 明细落库失败/布料同步失败只 console.warn | orders.ts:824,830 | 订单建成但明细/BOM 悄悄缺;至少应记订单备注或通知 |
| O4 | `recordReceipt` 权限过宽(含 sales/finance) | procurement.ts:52 ALLOWED_ROLES | 销售可自记收货绕过 QC;建议收紧为 理单/物流/采购/管理员 |
| O5 | 同名物料名称微差(280g仿锦 vs 280克仿锦)会分裂核料项 | consolidationKey 名称派生 | 今日 autocode 已让同名同类复用同 master(大幅缓解);残余靠主数据管理员归并 |
| O6 | BOM 二次提交无撤销;旧核料项标 needs_reconfirm 与新项并存 | submitBomToProcurement | 有变更检测(签名相同复用快照),但缺「撤销提交」反向操作 |
| O7 | 采购单无改/删/取消 action | purchase-orders.ts | draft 单错了只能 DB 手改;建议 draft 可改可删,placed 只读+反向单 |
| O8 | 收货双路径(recordReceipt / recordGoodsReceipt)状态口径不完全互斥 | procurement.ts:347,768 | 入库有按 source_ref 补差的幂等保护(验证过),但 line_status 语义两套,建议收敛为 QC 一条路 |

## 🟡 观察(设计取舍/低风险)
- style_no 不进快照/需求 → 采购侧看不到款维度(核料本来就该跨款归并,可接受;要追款时再加列)
- 下单风险闸 `orderBudget` 恒 null → 超预算规则从不触发(跨订单采购单确实难挂单一预算)
- procurement.ts 自有 ALLOWED_ROLES/OPERATOR_ROLES 未统一进 roles.ts ROLE_GROUPS(漂移风险)
- /procurement/netting 无入口但 URL 直达可用(按拍板"没用"→建议删页面或留)
- 库存流水 material_key 与核料 consolidation_key 同口径(收货时优先取采购项 key,验证过);老手工行(无 procurement_item_id)靠字段派生,可能对不上

## ✅ 澄清 agent 误报
- 「exportPurchaseOrder 泄露底价」**不成立**:该 action 有 `CAN_PROCURE` 检查(purchase-orders.ts:241),仅采购可导出;导出含底价是发供应商的设计。
- 「合并同料应建单时物理合并」**不采纳**:物理行保持一行一订单是脊柱纪律(order_id peg),导出呈现层合并是刻意设计。

## 验证过的健康面
- 生产库无 schema drift:material_requirements / procurement_items / snapshot_lines.bom_id / submit_status / merge_same_materials / fabric_* 全部真实存在(anon 探测)
- 提交采购的快照签名去重、需求删重建防孤儿、P0 吞错教训已内建(快照行读取失败即中止)
- 下单风险闸(≥5万/价差>5%/新供应商/账期<60天)无法绕过;审批双 scope(采购经理/财务)分权正确
- 库存入库 append-only + 按 source_ref 补差幂等
- 底价对 sales 的屏蔽在读取层(getPurchaseOrder maskFloorForLines)正确

## 建议修复顺序
1. R3(一行代码+一条 SQL,救活采购中心队列)
2. R1 + R2(同在 submitBomToProcurement,一次改完:款件数 + 缺单耗警示)
3. O2(unit_consumption 映射,顺手)
4. O4(收货权限收紧)
5. O3 / O6 / O7 按节奏排

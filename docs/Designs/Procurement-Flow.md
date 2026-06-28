# 采购 / 供应链 真实流程设计(QIMO OS 供应链域核心)

> 状态:**待审批**(只设计,不写代码)
> 日期:2026-06-28 · 作者:架构审核员(Claude)
> 背景:现采购中心的 149 条"待下单"是 `/api/backfill-procurement` 一次性塞的**默认占位假数据**(每个生产单 4 条:大货面料/拉链纽扣/吊牌洗标/包装袋纸箱,创建人=System),**不是真实流程产生的**。真正的采购流起点(业务提交原辅料单)在系统里缺失。本设计补上整条真实流。

---

## 0. 用户确认的真实流程(10 步 + 放行生产)

```
① 订单下达
② 业务提交原辅料单（结构化:款/料/规格/单耗/颜色 + 附图/样品标记）
③ 流转到采购 / 供应链
④ 线下给采购样品
⑤ 采购按「原辅料单 × PO 数量 × 单耗」自动汇总需求
⑥ 给供应商询价（多家报价）
⑦ 下单
⑧ 追踪进度（催货 / 在途）
⑨ 大货材料到厂:确认数量 + 品质验收
⑩ 品质结果回传业务复核
   ↓
✅ 料齐 + 品质确认 + 业务复核通过 → 放行大货生产（production_kickoff）
```

**铁律:②是起点,⑩之后才放行开裁。料不到位不准开裁。**

---

## 1. 每步设计(动作 / 数据 / 谁来做)

| 步 | 动作 | 数据落点 | 角色 |
|---|---|---|---|
| ② 提交原辅料单 | 业务在订单「原辅料」Tab 录料(单耗/颜色/规格)→ 点**提交采购** | `materials_bom`(增列)+ 提交状态 | sales |
| ③ 流转 | 提交后通知采购 + 进入采购中心"待汇总"队列 | `notifications` + 状态 | 系统 |
| ④ 给样品(线下) | 系统标记"样品已交采购"(checkbox/附图),不强制 | `materials_bom.sample_status` | sales/采购 |
| ⑤ 汇总 | 采购按 `单耗 × PO数量 ×(1+损耗)` 算需求量,生成采购需求 | `procurement_line_items`(从 BOM 生成,带 `bom_id`) | procurement |
| ⑥ 询价 | 录入多供应商报价,选定 | 🆕 `supplier_quotes` | procurement |
| ⑦ 下单 | 选定供应商 → 下单(PO号/单价/承诺期) | `procurement_line_items`(状态机,已有) | procurement |
| ⑧ 追踪 | 催货 / 在途 / 到厂 | `procurement_line_items` + `procurement_logs`(已有) | procurement |
| ⑨ 大货确认 | 到货录实收 + 品质验收(通过/让步/拒收) | `goods_receipts`(已有) | 采购/品控 |
| ⑩ 品质复核 | 品质结果回传业务,业务确认 | 🆕 复核状态 + 通知 | qc → sales |
| 放行 | 全部料齐+复核通过 → 放行 `production_kickoff` | 料齐信号 → 生产节点 | 系统/生产 |

---

## 2. 数据模型(最大化复用,少新建)

### 复用(加少量列)
- **`materials_bom`**(= 原辅料单,已有 material_name/qty_per_piece/color/placement/spec):
  增列 → `submit_status`('draft'|'submitted_to_procurement')、`submitted_at`、`submitted_by`、`image_url`(附图)、`sample_required` bool、`sample_status`('none'|'given'|'confirmed')。
- **`procurement_line_items`**(采购执行,状态机已有):
  增列 → `bom_id`(FK→materials_bom,**让采购行有真实来源**)、`required_qty_calc`(汇总算出的需求量)。**今后由 BOM 汇总生成,不再 backfill。**
- **`goods_receipts`**(到货验收,已有):⑨ 直接用(pass/concession/reject + AQL)。
- **`procurement_logs`**(已有 append-only):全程留痕。

### 新建(确实没有的)
- 🆕 **`supplier_quotes`**(询价):`order_id` / `bom_id` or `line_item_id` / `supplier_id` / `unit_price` / `moq` / `lead_days` / `quoted_at` / `selected` bool。一物料多报价、选优。
- 🆕 **复核回环**:可不建表,用 `goods_receipts` 加 `sales_review_status`('pending'|'approved'|'rejected') + `reviewed_by` 列实现"品质→业务复核"。

> 不新建:suppliers(用 factories)、不建库存/库位/批次(那是 Phase 2 仓库,本流程不需要)。

---

## 3. 与现有里程碑的衔接(放行大货生产)

- 精简模板已删"原料检验"节点,所以**这条材料流就是 `production_kickoff` 的前置闸**。
- **料齐信号** = 该订单所有 `submit_status='submitted'` 的关键物料(面料必须)都 `goods_receipts` 验收通过 + 业务复核 approved。
- 放行方式两种(**待你定**):
  - **A 软提醒(推荐,合"卡风险不走流程")**:料没齐就开裁 → 风险卡/通知告警,但不硬挡。
  - **B 硬闸**:料没齐,`production_kickoff` 不能标完成。

---

## 4. 那 149 条假数据怎么处理(待你定)

它们是 System 占位、`line_status='pending_order'`、无 PO、无 ordered_by。建议:
- **A 清掉(推荐)**:删除 System 回填、未被任何采购动作触碰的占位行,让采购中心只剩真实数据。一条 SQL,写好你执行。
- **B 标记**:加 `is_placeholder=true`,UI 灰显"待业务提交原辅料单"。

> 不论哪种,真实流程上线后,采购行只能由"业务提交原辅料单 → 采购汇总"产生。

---

## 5. UI 落点(都在现有结构里长,不新建系统)

- **业务端**:订单「🧵 原辅料」Tab 增"提交采购"按钮 + 附图/样品标记。
- **采购端**:`/procurement` 采购中心增"待汇总"队列(收到业务提交的单)→ 汇总 → 询价 → 下单(下单/追踪/验收已有)。
- **复核**:品质验收后,业务在订单收到"请复核"通知 → 一键复核。
- **供应链 Tab**(我 Phase 1 那个只读概览):升级为这条流的"一页总览",数据从此是真的。

---

## 6. 实施分期(每段独立可上线 / 可回滚 / 走 build+check+diff+你批 push)

- **Step A 起点**:materials_bom 增列 + 业务"提交采购"动作 + 通知采购 + 清理假数据。
- **Step B 汇总**:采购中心"待汇总"队列 + 按 PO×单耗 生成采购需求(procurement_line_items 带 bom_id)。
- **Step C 询价**:supplier_quotes 表 + 录报价/选优。
- **Step D 复核 + 放行**:goods_receipts 加业务复核 + 料齐信号 → production_kickoff 软提醒/硬闸。

---

## 7. 待你拍板(然后我逐段实现)
1. **流程**:✅ 已确认 10 步 + 放行生产。
2. **放行方式**:软提醒 A 还是硬闸 B?
3. **149 假数据**:清掉 A 还是标记 B?
4. **询价**:要不要做完整询价(supplier_quotes 多报价选优),还是先简单到"下单时填供应商+单价"就够?
5. **样品**:系统里只做个"已交样品"标记够吗,还是要记样品确认结果?

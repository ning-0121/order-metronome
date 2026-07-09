# 订单明细结构化设计契约 — 款号/数量/颜色/尺码

> 多智能体工作流评估落档（2026-06-19，9 agent:4 测绘→4 设计→1 综合）。
> 状态:设计已确认建议;**未动工**。动工前以此为契约。

---

## 1. 结论:应该做,但要为对的理由做

**判断:做,且现在是低成本窗口期。** 但不是"完整订单系统该有明细"这种流程话术(那违背"卡风险不走流程"的定位)。真正理由三条:

1. **数据已在手、却被当场扔掉。** `app/orders/new/page.tsx` 建单时 `po-parser` 早已解析出完整 `styles[]→colors[]→sizes` 矩阵(每款每色每码件数都有),但只拿去 `fillIfEmpty` 三个汇总数(总量/款数/颜色数),原始明细展示给业务核对后即丢弃、从不入库。这是**最大杠杆**——捡回已付过 AI 费的成果,不是造新能力。
2. **不做明细=看不见一类真实风险。** `quantity = rawQty × setMultiplier`(套×2/三件套×3)一次性折平且**不可逆**,连"原始几套"都还原不出。小单多款多色、尺码配比异常、某款超量、出货分批与款色对不齐——都是真实交付风险,系统因无 SKU 维度而**完全看不见**。
3. **下游已在"假装有明细"。** 《订单资料.xlsx》能逐款逐色逐码渲染,但数据源是内存草稿/`po_parse_drafts`、不读订单;`documents.ts` 无 PO 缓存时退化成单行占位 → 单据明细真实性取决于"该单是否解析过 PO",**改单后 Excel 会和订单对不上(已存在的一致性 bug)**。

**诚实的边界:** 节拍器核心(18 关卡、`schedule.ts`、`deliveryConfidence`/`criticalNodes`)**完全不读 quantity、更不读 SKU**(已逐文件核实)。所以明细**不会让排期更准、不会改善现有风险卡**。价值在「单据质量 + 款色码风险可见性 + 数据资产沉淀」,**不在节拍器本身**。故按**纯加法旁挂层**做,绝不借机动核心。

---

## 2. 推荐数据模型(方案C骨架 + 方案D复用;排除A/B)

### 2.1 新表 `order_line_items`(唯一新结构)
`id` · `order_id`(FK→orders **必须 DB 显式声明**,否则 PostgREST 嵌套 join 静默失败——CLAUDE.md 血泪教训) · `line_no` · `style_no` · `product_name` · `color_cn/color_en` · `sizes jsonb`(尺码配比 `{"S":10,"M":30}`,**命名对齐** `packing_list_lines.size_breakdown` / `ExtractedPO.line_items[].sizes`,杜绝第 5 套 SKU 模型) · `unit`(pcs/套/三件套) · `set_multiplier`(1/2/3,与 `orders.ts:184` 同口径) · `qty_pcs`(**唯一权威数量列**=Σsizes×set_multiplier) · `qty_raw`(客户原始数字,还原 PO) · `source`(po_parse/po_extract/manual/backfill/placeholder) · `source_extraction_id`(溯源可重灌) · `created_at/updated_at`。

`orders` 加 3 个轻量标记列(**不动 quantity**):`detail_source`(default 'none') · `detail_confidence` · `detail_verified_at`(人工核对盖章)。
死列 `orders.colors/sizes`(恒为 `[]`)标 DEPRECATED,唯一读者 `export-sample-request.ts` 改读新表聚合。
诊断视图 `order_qty_check(order_id, sum_pieces, orders_quantity, is_consistent)`。

### 2.2 件数何去何从(关键)
- **`orders.quantity` 保留、语义不变、NOT NULL 不动** → 所有现存消费方(重单检测三元组、销售目标累加、finance-sync、利润 per-piece×qty、出货 GENERATED `qty_variance`)**零改动**。
- **套语义下沉到行级:** `qty_pcs = qty_raw × set_multiplier`,`SUM(qty_pcs)` 天然等于现在 `createOrder:184` 的折算结果(完全兼容);客户"几套"用 `qty_pcs/set_multiplier` **永久可还原(修了折平不可逆缺陷)**。
- **软校验非硬约束:** 有明细时 quantity 由 SUM 带出;手填≠Σ明细时给**非阻塞黄条**提示,绝不拦保存。配 `order_qty_check` 视图查漂移。

### 2.3 为何排除
- **排除 B(orders 加 jsonb 列):** JSONB 行无稳定主键,采购/装箱永远无法外键引用某行明细;是过渡非终态,不如一步建表。
- **排除 A(触发器硬绑 quantity≡SUM + CHECK):** 过度工程化,给"卡风险不卡流程"的系统引入新硬卡点,与"存量 quantity 用户直填"冲突。明细覆盖率短期不可能 100% → 软校验更匹配。

---

## 3. 存量 vs 新单

### 存量(三档,不强制、容忍缺失)
- **A 自动回填:** 解析过 PO 的单,从 `document_extractions`(confirmed/modified 优先)经 mapper 落库,`source='backfill'`;**仅 SUM 与 quantity 差异 ±5% 内才置信**,超差只写明细+告警、不覆盖 quantity。
- **B 按需补录:** 手工/无 PO 单,详情页给"从 PO 重解析 / 手动补录"入口,用到哪填哪。
- **C 永不回填:** 已完结/已出运历史单,只走 quantity 统计。
- **铁律:绝不把 quantity 机械拆成单行假明细**(无法还原款色码=垃圾数据)。宁可留空。回填脚本必 dry-run + 可重入 + 只 INSERT 不覆盖 quantity。

### 新单(PO 自动落库为主、明细可选不强制)
1. 建单拿到 orderId 后,内存里已解析的 `styles[]` 经 mapper **fire-and-forget 落库**(沿用 Runtime 钩子"永不阻塞主链路"),失败不阻断建单。
2. 手工建单:表单维持现状向后兼容;数量区下加**可折叠"订单明细(可选)"动态行编辑器**。
3. **第一阶段明细一律可选**,不抬高建单门槛;稳定后再用 flag 按客户/类型灰度收紧。

---

## 4. 分阶段路线(全程 Feature Flag `ORDER_LINE_ITEMS=off/admin/on`,回滚=改 env)

| 阶段 | 内容 | 性质 |
|---|---|---|
| **0 基建** | 建表(显式FK+RLS)+ orders 加 3 列 + 诊断视图 + 共享 mapper + 薄落库 action | 纯加法,不接任何流程 |
| **1 读路径双轨** | 抽 `resolveLineItems()`:新表→提取缓存→单行占位;导出/单据全切到它 | 纯加法(表空时 100% 同现状) |
| **2 新单 PO 落库** | 建单后 fire-and-forget 落明细 + 软校验黄条;导出改读 DB(**修改单后 Excel 不一致 bug**) | 纯加法(flag 控) |
| **3 手工编辑器 + 按需补录 UI** | 建单动态明细行编辑器 + 详情页补录入口 | 纯加法 |
| **4 存量回填** | `scripts/backfill-order-line-items.ts`(±5%、dry-run、分批、不覆盖 quantity) | 纯加法 |
| **5(本期不含)下游收口** | 采购/装箱引用 order_line_items 作上游真源;`small_complex` 风险输入切明细 | 轻触采购/出货 |

**绝对不动:** schedule / gate-scheduler / milestoneTemplate / deliveryConfidence / criticalNodes 一行不改;每阶段后跑 `pre-deploy-check` 守边界。
**最小可发布闭环 = 阶段 0–2(新单自动有明细 + 导出修正),约 4–5 工程日,兑现绝大部分价值。**

---

## 5. 三大风险与规避
1. **双源一致性漂移:** 统一折件口径让两者天然对齐 + 软校验黄条 + 诊断视图;有明细则 quantity 由 SUM 派生。
2. **回填时套折算算错(翻倍/腰斩):** 套别下沉行级、**绝不机器猜倍率**;回填 dry-run + ±阈值 + 只告警不覆盖;mapper 与 `createOrder:184-185` 逐字对齐。
3. **建单链路被拖垮 / 2000 行表单回归:** 落库 fire-and-forget 失败不阻断;明细全程可选、flag 灰度;写路径走 `orderLineItemsRepo`+白名单(注意 `sanitizePayload` 会静默丢未加白名单字段,`aql_standard` 踩过)。

---

## 6. 第一步(0 风险、可独立上线)
阶段 0:建 `order_line_items`(显式 FK+RLS)+ orders 加 3 标记列 + `order_qty_check` 视图 + 共享 mapper + 薄落库 action,SQL 追加到 `supabase/migrations/` 通知执行。不接任何现有流程,`npm run build && npm run check` 过即可部署,生产无感知。

**关键事实锚点:** `app/orders/new/page.tsx:360-399`(解析后丢 styles[]) · `app/actions/orders.ts:184-185`(折平不可逆) · `generate-production-order.ts`(尺码矩阵数据源是草稿非订单) · `documents.ts:179-197`(无缓存退化单行) · `lib/schedule.ts`/`deliveryConfidence.ts`(核心不读 quantity/SKU)。
</content>

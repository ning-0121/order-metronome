# Product Domain Phase 2 设计 — Material Package 实例化 + Override

> **Status**: 设计待审。**不编码 / 不 migration / 不 commit / 不 push,等审批**(本文件也是)。
> **Date**: 2026-06-29 · 遵守 EA V1.0 + DoD + 双门禁。
> **拆分(用户建议,采纳)**:**2A** = Material Package 实例化 + Override(只影响 Product Domain,**不接采购**)· **2B** = P1′ 改读 Material Package(正式接采购)。先 2A 稳定几天再 2B。

---

## 四问(先答,不编码)

### Q1 — Material Package 建在哪张表?
**答:扩展现有 `materials_bom`(= Order Material Package),不新建表。** 纯加 2 个可空列:
- `product_bom_template_id uuid`(FK → product_bom_templates,ON DELETE SET NULL)—— 这行实例化自哪条模板;
- `source text`(`'template'` / `'manual'`)—— 来自产品模板 / 手动新增。

**为什么**:`materials_bom` **本就是** Order Material Package(B1/P1′ 已读它,款色码/单耗都在)。新建平行表 = 重复真相(违反 Constitution 02)。加可空列 = **B1/P1′ 读取不变、旧行零影响**(Evolution NOT Rewrite)。
> ⚠️ 这会**碰 materials_bom**(你 Phase 2 已明确"Order Material Package 才允许修改";Material Master 不碰)。我保证**纯加法、不动现有列、不改 B1/P1′ 的读**。请确认这个扩展边界。

### Q2 — 实例化什么时候发生?
**答:显式按钮「从产品款实例化原辅料」**(订单 原辅料 Tab),在 Variant 已绑定订单行(Phase 1b)之后,**业务手动点**(DP-4 系统算·人决策,不自动)。
- 模式:**追加** / **清空后实例化**(沿用「复制上一单」交互,默认追加防误删)。
- 去重:同模板行已实例化则跳过/更新,不重复。
- 推荐手动按钮而非"绑定即自动":业务控制时机,且与现有 BomTab 一致、可回滚。
> 备选(否):Confirm Definition 时自动 / 下采购前自动 —— 都不如显式按钮可控。

### Q3 — Override 如何保存?
**答:Template 永不可改;Override 用「链接 + 值对比」隐式追踪,Phase 2A 不建 Override 表。**
- `product_bom_templates` 行**永不被订单操作修改**(只读源)。
- `materials_bom` 行 = 实例(实例化时拷模板值)+ `product_bom_template_id` 链回源。
- 四种修改可追踪:
  - **改单耗** → 编辑 materials_bom.qty_per_piece,与 template.development_consumption 不等 = override;
  - **换物料** → 改 material_master_id/material_name = override;
  - **删除** → 删 materials_bom 行(模板有、订单无 = removed);
  - **新增** → 加 materials_bom 行 `product_bom_template_id=null, source='manual'` = added。
- Override 状态**派生**(对比行 vs 模板),UI 标「来自模板 / 已改 / 手动新增」。无需单独 override 表(2A 最小)。

### Q4 — P1′ 如何读取?
**答:2A 完全不动 P1′;2B 才让 P1′ 默认读模板大货单耗。**
- **2A**:P1′ 一行不改。它照常读 `materials_bom`(只是这些行现在源自 Product);采购主链路零影响。
- **2B**:P1′ 的核料归并里,`production_consumption`(大货单耗)默认值 = 该 materials_bom 行 `product_bom_template_id → template.production_consumption`(**带入**);采购仍可 Override。这是唯一对 P1′ 的改动 = **只读取默认值,不改 MRP 计算**。
- 关系链清晰:`Product BOM Template(大货单耗标准) → materials_bom(实例,链接) → P1′ Procurement Item(大货单耗带入,可 Override)`。

---

## EA 九章设计

### ① 数据流
```
Product Definition (BOM Template,含 开发/大货单耗)
   │ ② 实例化(2A,显式按钮;读订单行绑定的 Variant → Definition → Template)
   ▼
materials_bom (Order Material Package,+product_bom_template_id +source)   ← 单一真相,B1/P1′ 照读
   │ 业务 Override(改单耗/换料/删/增,可追踪)
   ├─▶ submitBomToProcurement → material_requirements → P1′(2A 不变)
   └─▶ (2B) P1′ 大货单耗默认 = 链回 template.production_consumption
```

### ② 生命周期(materials_bom 行)
`实例化(source=template,来自模板) → [可 Override:改/换/删/增] → 提交采购(submit_status,既有)`。Product Template 全程**不可变**。

### ③ 状态机
materials_bom 行不新增 status 列;**Override 状态派生**:`来自模板未改` / `已改(override)` / `手动新增(manual)` / `模板有订单无(removed,UI 提示)`。Product Definition 状态机沿用 Phase 1(draft→active)。

### ④ ER(只加 2 列,不新表)
```
product_bom_templates (1) ──< (N) materials_bom.product_bom_template_id  [SET NULL]
materials_bom: + product_bom_template_id (nullable)  + source ('template'|'manual')
其余 materials_bom 列/关系不变;B1 snapshot / P1′ consolidate 读法不变。
```

### ⑤ API
- **2A**:`instantiateOrderMaterialPackage(orderId, mode)` —— 读订单行 `product_variant_id` → 各 Variant 的 product 的 active Definition → BOM Template 行 → upsert materials_bom(写 template 值 + product_bom_template_id + source='template');`getMaterialPackageWithOverride(orderId)` —— 行 + 派生 override 状态(对比模板)。
- **2B**:P1′ `consolidateOrderProcurementItems` 内,采购项 `production_consumption` 默认带入 = 来源行 template.production_consumption(经 product_bom_template_id);**不改归并/算量逻辑,只填默认**。

### ⑥ UI
- **2A**:BomTab 加按钮「🧬 从产品款实例化」(追加/清空后实例化)+ 每行 Override 徽标(来自模板/已改/手动)。
- **2B**:P1′ 采购核料 Tab 的大货单耗输入框**预填**模板值(采购可改)。

### ⑦ Migration
- **2A**:`ALTER TABLE materials_bom ADD COLUMN product_bom_template_id uuid REFERENCES product_bom_templates(id) ON DELETE SET NULL; ADD COLUMN source text; CREATE INDEX`。纯加法、幂等。
- **2B**:**无 migration**(纯代码读链接)。

### ⑧ Rollback
- 2A:`DROP INDEX; ALTER TABLE materials_bom DROP COLUMN product_bom_template_id, DROP COLUMN source;` + revert 代码。materials_bom 既有数据完好。
- 2B:`git revert`(无 DB 变更)。

### ⑨ 风险分析
| 风险 | 级别 | 缓解 |
|---|---|---|
| 碰 materials_bom(线上 B1/P1′ 读)| 中 | **纯加 2 可空列**,不动现有列;B1 snapshot / P1′ 读法不变;旧行 NULL 无影响 |
| 实例化覆盖现有手动 BOM | 中 | 默认**追加**模式;清空模式显式确认;去重防重复 |
| 模板变更后实例已脱节 | 低 | Definition 版本化;行链 specific template row id(版本内不可变);Override 派生只对比该行 |
| 2B 改 P1′ | 中 | 2B **只填默认值**,不改 MRP 计算;采购可 Override;2A/2B 分开上,2B 单独可回滚 |
| 删行丢链(removed 追踪)| 低 | UI 用"模板有订单无"提示;2A 不做硬追踪表(留 Phase 3 若需) |

---

## DoD(完成后必须满足)
① Product Variant → 生成 Material Package ✅ · ② Material Package 允许 Override ✅ · ③ Product Template 永不变 ✅ · ④ P1′ 默认读 Material Package(2B)✅ · ⑤ 原有订单完全兼容(纯加法)✅ · ⑥ build/check 全绿 · ⑦ 一键回滚(DROP 2 列 / revert)。

## 待你审批
1. **Q1 扩展 materials_bom 加 2 列**(碰 Order Material Package,纯加法,不动 B1/P1′ 读)—— 认可?
2. **Q2 显式「实例化」按钮 + 追加/清空模式** —— 认可?
3. **Q3 Override 隐式追踪(链接+对比,不建 override 表)** —— 认可?
4. **Q4 2A 不动 P1′ / 2B 才带入大货单耗** —— 认可?
5. **2A/2B 分两次上线** —— 认可先做 2A?
> 批准后:先定稿 **2A migration 草案**(加 2 列)→ 你执行 + 数据库门禁 → 再编码 2A。**现在不写代码、不 migration、不 commit。**

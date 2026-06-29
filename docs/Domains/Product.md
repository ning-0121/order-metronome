# Product Domain Design V1.0 — Digital Product Definition

> QIMO OS **第二块基石**(第一块 = Enterprise Architecture)。严格按 [`../00-Constitution/Domain-Template.md`](../00-Constitution/Domain-Template.md) 九章。
> **Status**: Domain 定义(纯设计,**一张表都不建**)。定义做到极致,再开始第一张表。
> **Date**: 2026-06-29 · 遵守 Constitution + Development Principles + EA V1.0。

> **核心命题**:绮陌是 **Product Company**。Order 只是某个 Product 的**一次销售**。Product 不是一条记录,是一个**聚合(Digital Product Definition)**。

---

## 01 Vision（为什么存在)
Product 是公司的**核心资产**与真相源。一个款的商业/工程/制造/成本/文档定义**集中在 Product**,订单只引用、只 Override,**永不复制**。
- 消除根本重复:同款给美国/巴西/墨西哥**不再建 3 套 BOM**,只有 1 套 Definition + 各 Variant/Order Override(修复 Constitution 02)。
- 未来 AI Designer / Pattern AI / BOM AI / Cost AI **全部围绕 Product Definition** 工作。

## 02 Capability（提供什么能力)
对应 Capability-Map 的 **Product Development**:款式/版型/码色/BOM 模板/印绣/样衣/TechPack/成本定义/版本管理。

## 03 Business Objects（对象 = 一个聚合)
**Aggregate Root = `Product`(= Style)**。下挂五个维度 + Variant + Definition(版本化)+ Documents。

```
Product（款,Aggregate Root)
 ├─ Commercial（商业定义)        Style · Season · Brand · Category · Target Customer
 ├─ Product Variant [N]          市场/客户配置:Country · Brand · Customer · Fabric Version · Package Version
 │                               (同款不同市场吊牌/洗标 → Product 不变,Variant 变)
 ├─ Product Definition [版本化]   工程 + 制造 + 成本 真相(可多版本,冻结快照)
 │    ├─ Engineering：BOM Template · Pattern · Measurement/Size Spec · Construction · Printing · Embroidery
 │    ├─ Manufacturing：Production Consumption(大货单耗模板)· Operation Library · Quality Standard · Packing Template
 │    └─ Cost：Material Cost · Labor Cost · Target FOB
 ├─ Documents（证据,Evidence≠Data)  Sample · Tech Pack · Photos · Videos
 └─ Version + Lifecycle
```

### 颜色两层规则(2026-06-29 拍板,防颜色维度失控)
- **普通 color = Order Line 属性**(留 `order_line_items.color_cn/en`,不进 Variant)。
- **Colorway with construction difference = Product Variant**:**仅当**该颜色导致 不同面料 / 不同印花 / 不同绣花 / 不同洗水 / 不同包装 / 不同成本 / 不同客户确认资料 时,才升级为 Variant。
- 判据:颜色只是"染不同色" → Order Line;颜色带来"造法/物料/成本不同" → Variant。

---

### §03 数据模型(逐对象;标 Owner / SoT / 生命周期 / 关系 / Phase。**不建表**)

> 约定:**SoT** = Source of Truth(✅ 真相源 / ❌ 证据或派生);**P1/P2** = Phase 1 必须 / Phase 2 再做。所有 Owner = Product Domain。

**① Product（款,聚合根)** · SoT ✅ · 生命周期 开发→打样→确认→量产款→归档
- 关系:1:N Variant · 1:N Definition(版本)· 1:N Documents;被 `order_line_items` 经 Variant 引用;跨订单可复用。
- **P1**:id · product_code(款号,唯一)· product_name · category · season · brand · target_customer · status · created_by/at
- **P2**:collection · gender · fit · 设计师 · 更多商业属性

**② Product Variant（可订配置)** · SoT ✅ · 生命周期 active / discontinued
- 关系:N:1 Product;**被 `order_line_items.product_variant_id` 引用**;可指向某 Definition 版本。
- **P1**:id · product_id(FK)· variant_code · country · customer · status
- **P2**:brand · fabric_version · package_version · colorway(构造差异色)· definition_version_ref
- 规则:见上「颜色两层」。

**③ Product Definition（工程+制造+成本真相,版本化)** · SoT ✅ · 生命周期 draft→confirmed→active(变更出新版,旧版冻结,在用订单引用旧版不被动改)
- 关系:N:1 Product;BOM Template/Pattern/印绣/Packing/Cost 子项挂它;**Material Package 实例化其 BOM Template**;**Procurement 读其大货单耗**。
- **P1**:id · product_id(FK)· version(int)· status · confirmed_by/at
- **P2**:effective_date · supersedes · change_reason

**④ BOM Template（款标准物料构成)** · SoT ✅ · 生命周期 随 Definition 版本
- 关系:**→ Material(materials_bom 实例化这些行 + Order Override)** · 引用 Material Master · **大货单耗喂 Procurement**。
- **P1**:id · definition_id(FK)· material_master_id(→Material)· material_name · category · unit · **development_consumption(开发单耗标准)** · **production_consumption(大货单耗标准)** · default_color · default_placement · special_req
- **P2**:损耗标准 · 替代料 · 多 UoM
- 注:大货单耗(Definition.Manufacturing)落在每条 BOM Template 行上(逐物料),P1′ 采购的 production_consumption 由此带入。

**⑤ Pattern / Measurement（版型/尺寸)** · SoT ✅ · 生命周期 随 Definition 版本
- 关系:→ Production(版型/纸样/尺寸表)。
- **P1**:id · definition_id(FK)· size_spec(jsonb 尺寸表)
- **P2**:pattern 文件 refs · grading 放码 · construction 工艺结构

**⑥ Sample（样衣)** · SoT ❌(证据/样衣记录)· 生命周期 requested→made→sent→approved/rejected
- 关系:→ Order(产前样节点)· → Production。
- **P1**:id · product_id(FK)· sample_type · status
- **P2**:photos refs · approved_by/at · 与订单产前样里程碑联动

**⑦ Tech Pack（技术包)** · SoT ❌(证据文件;**结构化真相在 Definition**,Evidence≠Data)· 生命周期 随 Definition 版本
- 关系:各域只读引用。
- **P1**:id · product_id(FK)· file refs · version
- **P2**:版本对比 · AI 解析(草稿→人确认→进 Definition)

**⑧ Printing / Embroidery（印绣规范)** · SoT ✅ · 生命周期 随 Definition 版本
- 关系:→ Production(执行)· → Procurement(印绣服务料/外协)。
- **P1**:id · definition_id(FK)· type(print/embroidery)· placement · technique
- **P2**:artwork refs · color/position 详规 · 指定供应商

**⑨ Packing Template（款标准包装)** · SoT ✅ · 生命周期 随 Definition 版本(+ Variant 市场 override)
- 关系:**→ Packing Domain(实例化)** · → MP(生产任务单含包装)。
- **P1**:id · definition_id(FK)· polybag · carton_spec
- **P2**:prepack/assort 比 · carton mark · 装箱率/重量/尺寸 · 客户包装规则(Amazon/Costco/Ross/TJX/DDS)

**⑩ Cost Definition（款标准成本)** · SoT ✅ · 生命周期 随 Definition 版本 · **CAN_SEE_FINANCIALS 门控**
- 关系:→ Finance · → Quoter(报价)。
- **P1**:(P2 为主)id · definition_id(FK)· material_cost · labor_cost · target_fob · currency
- **P2**:成本拆解 · 历史成本 · AI 成本分析

**⑪ Product Version（版本控制)** · SoT ✅ · 生命周期 每次 Definition 变更出新版,旧版冻结
- 关系:订单/Variant **pin 到某 Definition 版本**,不自动跟随变更(像 Material Snapshot)。
- **P1**:体现为 Product Definition.version(int)+ status(P1 不单建版本对象)
- **P2**:独立 Version 对象 · diff/compare · effective/supersede 链

### 关系矩阵(Product ↔ 其他域)
| 对象 | Order | Material | Procurement | Production | Packing |
|---|---|---|---|---|---|
| Product / Variant | Order Line 引用 Variant | — | — | — | — |
| BOM Template | — | **实例化→materials_bom** | 大货单耗带入 | — | — |
| 印绣 | — | — | 印绣服务 | 执行 | — |
| Pattern/Measurement | — | — | — | 版型/纸样 | — |
| Packing Template | — | — | — | — | **实例化** |
| Cost Definition | — | — | 价参考 | — | — |
| (Definition 大货单耗) | — | — | **Procurement Item 带入+Override** | — | — |

### Phase 1 最小集(将来第一张 migration 的范围,现在仍不建)
**Product · Product Variant · Product Definition · BOM Template** + `order_line_items.product_variant_id`(可空)。其余对象 P2 起。

## 04 Business Events
`ProductCreated` · `ProductVariantCreated` · `ProductDefinitionVersioned`(出新版)· `ProductBOMTemplateConfirmed` · `SampleApproved` · `ProductActivated`(转量产款)· `ProductArchived`。
> 下游监听:Material(实例化 BOM)、Procurement(大货单耗带入)、Production(工序/质量)、Finance(成本)。

## 05 Lifecycle
```
开发 Developing → 打样 Sampling → 确认 Confirmed → 量产款 Active → 归档 Archived
```
- Product Definition **版本化**:Active 后改动 = 出新版本(旧版冻结,在用订单引用旧版,不被动改)—— 同 Material Snapshot 思路。
- Variant 各自可有状态(某市场停产)。

## 06 Data Ownership（Constitution 04)
| 数据 | 拥有者 | 别人怎么用 |
|---|---|---|
| 款式/版型/BOM模板/印绣/大货单耗模板/工序/成本定义/样衣/TechPack | **Product** | 只引用 / 实例化,不复制 |
| 订单/款色码/数量/交期 | Order | Order Line 引用 Product Variant |
| 每单 BOM 实例(开发单耗 + Override)| Material(materials_bom)| 实例化自 Product BOM Template |
| 大货单耗(采购确认值)| Procurement(procurement_items)| **带入自** Product Definition,采购 Override |
> **Template + Override 铁律**:Product 持"标准模板",下游持"本单 Override",**永不整份复制**。

## 07 APIs（能力接口,概念,不写代码)
`createProduct` · `addVariant` · `createDefinitionVersion` · `getActiveDefinition(productId)` · `getBOMTemplate(definitionId)` · `instantiateOrderBOM(orderLineId)`(从 Template+Override 生成 materials_bom 行)· `getProductionConsumption(productId)`(喂采购)。

## 08 UI（入口,非"页面";Center 是 UI,Domain 才是系统)
款库(Web)· Product Definition 编辑器 · 版本对比 · 样衣/TechPack 管理 · 未来 AI Designer/Pattern/BOM/Cost 入口 · API(供其他域/集成调用)。

## 09 Future Roadmap
- **阶段 1(立即,纯加法)**:Product + Product Variant + Product Definition(BOM Template 起步)+ `order_line_items.product_variant_id`。`materials_bom`/B1/P1′ **一行不动**。
- **阶段 2**:Material 改造 —— materials_bom **实例化自 Product BOM Template + Order Override**(升级版「复制上一单」,源头变 Product);大货单耗从 Definition 带入采购。
- **阶段 3**:采购回归 **Product 驱动**(Product → Material Package → MRP → Procurement Item)。
- **阶段 4+**:Pattern/Operation/Quality/Packing Template 喂 Production/Quality/Packing;Cost 喂 Finance;**AI Designer/Pattern/BOM/Cost 围绕 Product Definition**。

---

## 🛡 Evolution NOT Rewrite（护线上)
`materials_bom` / `order_line_items` 是线上的。Product Domain **纯加法**:新增 Product 系列对象 + order_line_items 加**可空** product_variant_id。**O1/B1/P1′/线上零影响**;实例化与 Override 在阶段 2 渐进接入,任何一步不打断线上。

## 🏛 Architecture Gate / 🔮 Future Gate
- **属哪个域**:Product Domain(新,聚合)。**所有权**:Product 持产品定义真相。**有无重复真相**:消除同款多套 BOM 的复制。✅
- **三年/十工厂**:Product 跨订单复用、Definition 版本化、Variant 多市场 —— 量产/多工厂/多客户天然支持;AI 全围绕 Definition。✅

## 已确认(2026-06-29 拍板,定义锁定)
1. ✅ **聚合边界**:Product(根)+ Variant(销售/市场/客户)+ Definition(工程/制造/成本,版本化)+ Documents(证据)。核心是 Digital Product Definition 聚合,非 products 表。
2. ✅ **Variant 维度** + **颜色两层规则**:普通色=Order Line;有构造差异的 Colorway=Variant(见 §03 颜色两层)。
3. ✅ **大货单耗** 标准模板属 **Product Definition.Manufacturing**(不属订单、不属采购临时记忆);采购带入 + Order Override。
4. ✅ **Order 链接** = `order_line_items.product_variant_id`;**禁止 order.product_id**(一单多款)。

## 下一步
§03 数据模型已逐对象展开(Owner/SoT/生命周期/关系/Phase)。**仍不建表、不写 migration、不写代码。**
→ 你审这份数据模型;满意后再谈 **Phase 1 最小集**(Product/Variant/Definition/BOM Template + order_line_items.product_variant_id)的第一张 migration 草案(走数据库门禁)。

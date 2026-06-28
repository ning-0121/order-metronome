# QIMO OS — Order Domain V3.0 Architecture(订单域重构)

> 状态:**架构设计待审**。不写代码 / 不写 migration / 不改现有系统。仅完整设计文档。
> 日期:2026-06-28 · 视角:Chief Architect + DDD + 服装 OEM/ODM ERP + CPO + SAP/Oracle/Kinaxis 产品架构。
> 背景:验证发现**全系统无结构化 BOM**——业务一直上传 PO/Excel/PDF/Tech Pack,从未把订单真正录入系统。Supply Chain / MRP / AI 因此都没有真相源。**暂停 Supply Chain UI(B2/B3),优先重构 Order Domain。**

---

## 0. Order Domain Constitution(订单域宪法)

1. **One Order = 唯一 Root Aggregate**。Supply Chain / Warehouse / Production / QC / Logistics / Finance / AI 全部依附 Order,**不存在第二个订单对象**。
2. **Evidence ≠ Truth**。客户上传的 PO / Tech Pack / Excel / PDF / 图片 / 邮件 / 聊天,**全是证据**,不能作为系统业务数据。业务数据只来自 **QIMO OS 结构化数据**。
3. **Attachment ≠ Database**。附件只允许:上传 / 查看 / 下载 / 版本管理。**永不参与计算**。采购 / 生产 / 仓库 / MRP / AI / 模板**全部读数据库,绝不解析附件运行**。
4. **AI Assist, Human Confirm**。流程:上传 → AI 解析 → **业务确认** → 写入数据库 → 生成业务对象。AI **永不绕过人工确认**,只产出草稿。
5. **Build Once, Generate Everywhere**。结构化数据录一次,所有单据(生产单/采购单/工艺单/QC/装箱/样衣/出货)自动生成,**零重复录入**。
6. **Evolution NOT Rewrite**。现有 orders / order_line_items / materials_bom / snapshots / requirements / attachments / po-parser / document-templates 全部保留并纳入,不推倒。
7. **Order Domain 表达需求,不定义工艺(Express Demand, Not Process)**。Order Domain 把**客户语言**翻译成**企业可执行的业务语言**——它**不是** MES / IE / PLM / SOP / 工艺系统 / 生产管理系统。订单域最终只产出**三个真相源对象**,**不再有第四个订单对象**:

   ```
   Customer Order  →  Material Package  →  Manufacturing Order
   ```

   **Manufacturing Order(生产任务单)** 只表达「客户要什么 + 工厂内部要执行什么」(产品/数量/颜色/尺码/包装/印绣/QC重点/特殊要求/风险提醒/交期/附件);**绝不承载** 工艺路线/工序/SMV/IE/工位/吊挂/机器配置/SOP/MES 执行——这些属于 **Production Execution Domain**,由生产主管/工艺员/IE/样衣/技术部在生产域完善。两域通过 Manufacturing Order **解耦**。**优先级高于后续所有设计**(O2/O3/Production/MES/AI 全部遵守)。详见 §0.1。

---

## 0.1 Principle 7 详解 — Order Domain ⊥ Production Domain(ADR)

> 本节为 Principle 7 的权威展开。后续 O2(Manufacturing Order)、O3(Template Engine)、Production Domain、MES、AI 全部必须遵守。

### 三真相源(订单域唯一输出,对应三个部门)
| 真相源 | 维护部门 | 说明 |
|---|---|---|
| **Customer Order**(客户订单) | 销售 | 客户/PO/条款/价格/交期 |
| **Material Package**(原辅料包) | 采购 | 结构化 BOM,引用 Material Master(O1 已建) |
| **Manufacturing Order**(生产任务单) | 业务/跟单 | 客户 PO 整理成工厂可执行的内部订单 |

**不再增加第四个订单对象。**

### Manufacturing Order 职责边界
| ✅ 承担(表达需求) | ❌ 不承担(属于 Production Domain) |
|---|---|
| 客户要求 / 产品信息 / 数量 / 颜色 / 尺码 | 工艺路线 / 工序 / SMV |
| 包装要求 / 印绣要求 / QC 重点 | IE / 工位 / 吊挂站位 |
| 特殊要求 / 风险提醒 / 交期 / 附件 | 机器配置 / 设备 / 节拍 / 工艺优化 / SOP / MES 执行 |

### Production Domain 职责
接收 Manufacturing Order → 由生产主管/工艺员/IE/样衣/技术部 继续完善:工艺路线 / 工序 / SMV / IE / 吊挂站位 / 工位 / 设备 / 机器 / 节拍 / 工艺优化。**Manufacturing Order 永不承担 Production Domain 的职责。**

### 在 Principle 7 下重申既有宪法
- **Attachment**:客户 PO / Tech Pack / 生产资料 / Word / Excel / PDF / 图片 / 视频 = Evidence,只能作附件;真正的 Manufacturing Order 必须**全部来自结构化数据**(= Principle 2/3)。
- **AI**:可解析 PO / Tech Pack / 客户资料,生成 Manufacturing Order **草稿**;但**永不直接写数据库**,必须人工确认后才生成(= Principle 4)。
- **Template**:生产任务单 / 工厂版生产单 / 客户确认版 / QC 单 / 包装说明 / PDF / Excel / Word **全部来自 Manufacturing Order**;模板只是表现形式,**Manufacturing Order 才是真相源**(= Principle 5)。

### 组织职责边界(必须遵守,与现有组织结构一致)
| 部门 | 维护 |
|---|---|
| **业务** | Customer Order · Material Package · Manufacturing Order |
| **采购** | Supplier · PO · MRP · 到料 |
| **生产** | Production Execution · 工艺 · IE · SMV · MES · 吊挂 · QC |
| **AI** | Assist · Draft · Recommendation —— **永远不是真相源** |

### ADR:这是 QIMO OS 与传统 ERP 的核心区别
- **传统 ERP**:订单系统承担越来越多工艺职责 → 最终膨胀成复杂 PLM(煮沸海洋)。
- **QIMO OS**:Order Domain 只**表达**需求,Production Domain 只**实现**需求,两者经 Manufacturing Order **解耦**。→ 业务更易维护、组织职责更清晰、AI 更易理解;未来扩 MES / IE / APS / 吊挂**不会污染订单中心**。

### 订单中心 IA(左侧导航固定为三模块)
```
订单信息
├── 客户订单(Customer Order)      ← 销售维护
├── 原辅料包(Material Package)     ← 采购维护
└── 生产任务单(Manufacturing Order)← 业务/跟单维护
```
采购中心 / 生产中心 / 仓储中心 **只消费**这三份结构化数据,**不维护第二份**(杜绝重复录入,长期演进更稳)。

---

## 1. 新 Order Domain Architecture(分层全景)

V3.0 把订单域分成**证据层 → AI 解析 → 人工确认 → 结构化真相 → 生成层 → 各域消费**:

```
【证据层】Attachment Center(只存不算)        ← 复用 attachments / order_attachments
   PO · Tech Pack · Excel · PDF · 图片 · 邮件 · 聊天
        │ AI Extraction(只产草稿,assist)     ← 复用 po-parser / document_extractions
        ▼
【人工确认】Order Builder(结构化录入工作台)   ← 演进 /orders/new
        │ 业务 Review / Confirm / Save
        ▼
【结构化真相】Order Aggregate(Source of Truth)
   Order Header + Order Items(款×色×码)+ Material Package + Manufacturing Order + Pricing + Dates
        │ One Data 发布(快照/事件)
        ├──▶ Supply Chain Domain:Material Package→Snapshot→MRP→Requirements(B1 ✅)
        ├──▶ Production Domain:接收 Manufacturing Order →(生产域)补工艺/排产/开裁(料齐放行,Principle 7 解耦)
        ├──▶ Warehouse Domain:物料→库存/收发(Phase2)
        ├──▶ Finance Domain:Pricing/Cost→利润(order_financials/baseline)
        └──▶ 【生成层】Template Engine                ← 演进 export-* / document-templates
                生产单 · 采购单 · 工艺单 · QC单 · 装箱单 · 样衣单 · 出货资料(打印/PDF/Word/客户版/工厂版)
```

**一句话**:证据进 Attachment Center,AI 把证据解析成草稿,人确认后写进结构化 Order,所有域和所有单据都从结构化 Order 长出来。

---

## 2. Domain Model(DDD)

**Aggregate Root:`Order`**

**Order Domain 内的聚合 / 实体:**
| 对象 | 角色 | 演进自 |
|---|---|---|
| Order Header | 客户/PO号/交期/条款/价格 | `orders` |
| Order Items | 款×色×码矩阵 + 配比 | `order_line_items` |
| **Material Package** | 结构化原辅料包(聚合)| `materials_bom` 升级 + 引用 Material Master |
| **Manufacturing Order** | 工厂内部生产任务单(聚合)—— 表达需求,**不含工艺/SMV/IE/MES**(见 §0.1)| 🆕 |
| Pricing | 报价/成本 | `order_cost_baseline` / `order_financials` |

**支撑对象(Order Domain 之外但服务它):**
| 对象 | 角色 | 演进自 |
|---|---|---|
| **Material Master** | 可复用物料主数据(编码/默认单耗/默认供应商/价格史)| 🆕(`customer_trim_library` 是半个起点)|
| Attachment | 证据(只存不算)| `attachments` / `order_attachments` |
| Extraction Draft | AI 解析草稿(待确认)| `document_extractions` |
| Generated Document | 生成的单据 | `documents` + `document-templates.ts` |

**Value Objects**:Money(币种+金额)、DateAnchor(阶段+日期)、SizeBreakdown(尺码配比)、Consumption(单耗+单位)、Color。

**Bounded Contexts**:Order Domain(本)是**上游**,通过**发布结构化数据(快照/事件)**供 Supply Chain / Production / Warehouse / Finance / AI 消费。各域不反向写 Order 的真相(只读 + 回传执行结果)。

---

## 3. 数据流(Evidence → Truth → Everywhere)

```
1. 上传 PO.pdf / Tech Pack → Attachment Center(存为证据,打标签/版本)
2. AI Extraction 解析 → 产出 Extraction Draft(订单/数量/颜色/交期/价格/Style;Material/Production/QC)
3. 业务在 Order Builder 里 Review:逐字段确认(低置信度高亮)→ 修正 → Confirm
4. Confirm 写入结构化 Order Aggregate(Header/Items/Material Package/Manufacturing Order/Pricing)
5. 关键节点(提交采购/放行生产)→ 冻结 Snapshot(已有 B0)+ 发布事件
6. 各域消费:供应链跑 MRP、生产排产、财务算利润、Template Engine 生成单据
7. 各域回传执行结果(到货/验货/消耗)→ 写各域自己的表,不改 Order 真相
```
**铁律**:第 2 步 AI 只产草稿,第 3 步人确认前,**没有任何业务对象生成**;附件(第 1 步)永远不被第 5/6 步计算读取。

---

## 4. UI Flow — Order Builder(交互设计,CPO 视角)

**结论:不是 Wizard,也不是纯 Form,而是「持续在线的 Builder 工作台」+ AI 预填。**

为什么不是线性 Wizard:服装订单是**非线性、反复编辑**的(先有 PO 再补工艺,款色码随时改)。强制一步步走会很痛。
为什么不是纯 Form:字段太多(款色码矩阵、物料、工艺),一张大表单 = 劝退。

**推荐体验:左侧分区导航 + 随手保存 + 完成度仪表 + AI 预填(类 Notion/Linear 的结构化编辑器)**
```
┌── Order Builder：QM-2026xxxx ───────────── 完成度 ▓▓▓▓░ 72% ──┐
│ 左侧分区          │  右侧工作区(当前分区)                      │
│ ● 客户/PO         │   [拖入 PO.pdf → AI 预填,黄色=待确认]        │
│ ● 产品/款色码     │   款 A:黑 S/M/L=… 红 …(矩阵编辑)            │
│ ● 交期/价格       │                                              │
│ ○ 原辅料包 ⚠      │                                              │
│ ○ 生产资料        │                                              │
│ ● 附件(证据)     │                                              │
│ → 确认/冻结快照   │   [提交采购 / 放行生产 按完成度解锁]          │
└──────────────────────────────────────────────────────────────┘
```
- **AI 快路径**:拖入 PO/Tech Pack → AI 预填各分区 → 人只复核**高亮低置信字段** → Confirm。**这是采用率的命门:结构化录入必须比拖文件还快,否则没人用。**
- **完成度驱动**:物料包齐 → 可"提交采购";生产资料齐 → 可"放行生产"。
- 随手保存(草稿),不丢失;关键动作才冻结快照 + 发布。

---

## 5. 数据库对象(设计层,不写 migration)

| 对象 | 新建/演进 | 说明 |
|---|---|---|
| `orders` | 复用 | Root |
| `order_line_items` | 复用/扩展 | 款×色×码矩阵 + 配比 |
| 🆕 `material_master` | **新建(关键)** | 可复用物料主数据:code/name/category/默认单耗/默认供应商/价格史 |
| `materials_bom` → Material Package | 演进 | 引用 material_master,补 version/审批/工艺关联 |
| `material_package_snapshots(+lines)` | 复用(B0)| 冻结快照 |
| 🆕 `production_packages(+sections/lines)` | **新建** | 结构化生产资料(工艺/车缝/印绣/洗水/包装/QC/客户要求/注意事项)|
| `attachments`/`order_attachments` → Attachment Center | 演进 | 加 version/tag/extraction 链接/引用关系 |
| `document_extractions` | 演进 | AI 解析草稿(待确认)|
| 🆕 `document_templates` + `generated_documents` | 演进(document-templates.ts/documents.ts)| Template Engine |
| `order_cost_baseline`/`order_financials` | 复用 | Pricing/Cost |

> 原则:**Material Master 是这次最关键的新对象** —— 没有它,每单重录物料 = 采用率崩溃(见 §13 压力测试)。

---

## 6. 与 Supply Chain 的关系
Order Domain **发布 Material Package** → Supply Chain 冻结 Snapshot(B0)→ 跑 Explainable MRP(B1)→ Material Requirements。**Order 是源,供应链是消费端**;采购执行/到货结果回传供应链自己的表,不改 Material Package 真相(改料走 Order 的"修订→新快照")。

## 7. 与 Production 的关系
Order Domain **发布 Manufacturing Order(只表达需求)** → Production Domain **据此补**工艺/排产/SMV/IE(Principle 7 解耦,这些数据归生产域,不回写订单);**料齐(B1 requirements 满足)软提醒放行 `production_kickoff`**。生产实际消耗回传生产域,对比需求。

## 8. 与 Warehouse 的关系(Phase2)
仓库收料/库存**按 Material Requirement 行归集**(B0 已留 requirement 脊柱);库存反哺 MRP 扣减。Order Domain 不直接管库存,只提供"需要什么"。

## 9. 与 Finance 的关系
Order 的 Pricing(售价)+ Material/Production 的成本 → `order_financials`/`order_cost_baseline` 算利润。财务**读结构化 Order**,不再解析成本单文件(承接之前的财务手填表单)。

## 10. 与 AI 的关系
AI = **录入助手 + 决策大脑**,**不是数据源**:
- **AI Data Extraction**(承接 po-parser/document_extractions):上传 PO→解析订单/数量/颜色/交期/价格/Style;上传 Tech Pack→解析 Material/Production/QC/Packaging → **产草稿,人确认才写库**。
- **AI Supply Brain**(V2.1):消费结构化真相 → 每日决策。
- AI 永不写真相、永不绕过确认、永不解析附件直接驱动业务。

---

## 11. Migration Strategy
- **Evolution**:现有表全留。新增 `material_master` / `production_packages` / Template Engine 表;演进 attachments(+version/extraction 链接)。
- **Feature Flag** 新 Order Builder 与旧 `/orders/new` 并行;验证后切换。
- **文件不删**:历史上传留作证据(Attachment Center),只是不再当数据。
- **回填**:存量订单可选回填(从 order_line_items/已传文件 AI 解析→草稿→人确认);不强制。
- SQL 人工执行 / build+check / diff 审 / 批了才 push(沿用纪律)。

## 12. Roadmap(先源头,后消费端)
| Phase | 内容 | 解决什么 |
|---|---|---|
| **O1** | **Material Master + Material Package 结构化录入** | **直接解决"无结构化 BOM",喂活 B1/MRP;采用率基石** |
| O2 | **Manufacturing Order(生产任务单)结构化录入** | 把客户 PO 整理成工厂可执行的内部订单(**不含工艺/SMV/MES**,Principle 7)|
| O3 | Order Builder(统一录入 + AI 预填)| 让录入比传文件还快 |
| O4 | Template Engine(生产单/采购单/工艺单 先行)| Build once generate everywhere |
| O5 | Attachment Center(证据 + 解析链接)| 文件归位为附件 |
| O6 | AI Extraction 确认闭环 | 上传→解析→确认→入库 |
| 之后 | 恢复 Supply Chain B2/B3 | 消费端 UI |

> ⚠️ **用户 2026-06-28 指示(Principle 7 落地)**:① Manufacturing Order(原 Production Package)**升为 O2 优先级**,O2 重新设计;② 订单中心固定为三模块导航(客户订单 / 原辅料包 / 生产任务单),见 §0.1;③ **禁止把工艺/SMV/MES/IE 放回订单中心**。O2 具体范围(Order Builder 与 Manufacturing Order 的先后/合并)待启动设计时与用户确认。

---

## 13. 压力测试(SAP/Oracle/Kinaxis 视角)+ 五年风险(不迎合)

**🔴 风险 1(存亡级):采用率 —— 结构化录入必须比 Excel/传文件更快,否则全盘失败。**
你现在的问题不是"系统没录入功能",是"业务嫌录入比拖文件慢"。如果 V3.0 做出一个漂亮但比拖文件慢的录入,业务会立刻退回传文件,我们又回到原点。**对策:AI 预填(拖 PO 自动填)+ Material Master(不重录)+ 随手保存。录入体验必须是"确认"而非"从零敲"。**

**🔴 风险 2:Material Master 不是"五年后"的事,是 O1 就必须做的采用率基石。**
SAP/Oracle 的绝对核心就是物料主数据。没有它,每单重录面料/拉链 = 重录地狱 = 放弃。**我坚持把 Material Master 提到 O1,与 Material Package 一起做**——这是我对"先做 Package 再说 Master"的明确反对。

**🟠 风险 3:Template Engine "一个库无限模板" = 报表设计器,是个独立大产品,别现在造通用引擎。**
通用模板引擎(布局/i18n/客户专属格式/打印保真)是 Centric/SAP 级工程。**对策:O4 先做 ~5 个精选生成器**(复用现有 exceljs export-* 函数,结构化数据→固定版式),验证后再谈通用引擎。"Build once generate everywhere"先落成"一把精选生成器",不是泛化引擎。

**🟢 风险 4(已由 Principle 7 结构性化解):Manufacturing Order 全结构化 = 在造 PLM(Gerber/Lectra/Centric)。**
**Principle 7 已把它从"缓解"升级为"宪法禁止"**:Manufacturing Order 只表达需求(产品/数量/颜色/尺码/包装/印绣/QC重点/特殊要求/风险/交期/附件),**工艺路线/工序/SMV/IE/吊挂/MES 一律不进订单域**,归 Production Domain。因此订单中心永不膨胀成 PLM。深技术工艺在生产域结构化或先附件渐进。

**🟡 风险 5:AI 解析准确率(我们已被烧过)。** AI 草稿→人确认是对的,但确认 UX 必须让改正**极易**(低置信高亮 + 从修正中学习),否则"确认"退化成"重录"。

**🟡 风险 6:处处版本+审批 = 流程臃肿,违背"卡风险不走流程"。** 重版本+审批只用在该用的地方(Material 快照给采购、Manufacturing Order 放行工厂);其余轻量。

**🟡 风险 7:订单拆分/翻单。** One-Order 聚合必须容得下多 PO/多交期/翻单(`orders.order_type=repeat` 已在),不能因为拆单冒出第二个订单对象。

### 自评分:**8/10**
强:分层清晰(证据/真相/生成解耦)、DDD 聚合正确、全部 Evolution、AI 定位准(assist not source)。
扣分:① 采用率/录入速度是最大不确定性,设计能减负但能否真比 Excel 快需实测;② Template Engine 与 Manufacturing Order 有过度工程风险(已用"精选/渐进"对冲);③ Material Master 的多 UoM/换算、跨订单价格史深度未展开(留后续)。

### 一句话总结
**V3.0 把"上传文件"降为证据,把"系统录入"升为唯一真相,用 AI 预填把录入变成"确认"。地基对了,B1/MRP/AI/模板才都有数据。最大的仗不是技术,是采用率——所以第一刀(O1)必须是 Material Master + 物料包录入,且必须比 Excel 快。**

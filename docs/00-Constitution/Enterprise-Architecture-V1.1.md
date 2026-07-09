# QIMO OS — Enterprise Architecture V1.1 Upgrade Plan（商业起源重定根）

> **Status**: 🟡 Proposed · 待审 · 待多阶段验证。**尚未取代 V1.0**。锁定前须先落 ADR-005（Commercial Origination）+ 新 Domain 文档。
> **Date**: 2026-06-29 · 遵守 `Constitution.md`（10 条）+ `Development-Principles.md`（DP-1~8）+ `Definition-of-Done.md` + 修宪纪律。
> **承接**: EA V1.0（`Enterprise-Architecture.md`）+ Order Domain V3.0（`../Domains/Order.md`）+ Product Domain V1.0（`../Domains/Product.md`）+ O2（`../Designs/O2.md`）。
> **一句话**: V1.0 的脊柱是「订单到收款」；V1.1 把**真相的起点前移到「客户开发 → 询盘 → 报价 → 审核」**，让 Customer PO / 生产任务单 / 采购核料 / 财务利润**全部继承自已审核 Quote Package**，而不是各自从空表重录。

---

## 0. 本次升级的本质（先说结论 — Pyramid）

> **V1.1 不是新建系统，是把已经各自存在的"孤岛"接线 + 把真相重新定根。**

调研发现（现状盘点，见 §11 资产清单）：用户设想的 V1.1 蓝图，**大部分能力已上线，但彼此不连**：

| 设想对象 | 现状 | V1.1 动作 |
|---|---|---|
| Quote Package | `quoter_quotes` 全套（成本拆解/单耗/CMT/margin/币种/生命周期）+ 5 张训练表 + RAG/Vision AI ✅ | **升级**为商业起源域 + 接线 customer/product |
| Inquiry | `parseInquiryFile`（已能 OCR 询盘→结构化 JSON）但**结果不落库** 🟡 | **新增**轻量 Inquiry 对象固化 |
| Quote Approval | `orders.quote_status` + `quote_stage` 已存在，但挂在 orders、与 quoter.status 双轨 🟡 | **收口**到 Quote Domain 的 Approved Quote 快照 |
| Customer PO + PO Compare | ⬜ 不存在 | **新增**（PO Compare 是 V1.1 唯一全新且最高风险的件） |
| Production Work Order | = Manufacturing Order `manufacturing_orders`（O2 已建）✅ | **重定根**：从空表录入 → 继承 Quote+PO 生成 |
| Finance 利润闭环 | `profit_snapshots`（forecast/live/final）+ `order_cost_baseline` + `system_alerts` 骨架已在 ✅ | **接通**：Quote=forecast，执行=live，完工=final |
| Lead / 客户开发 | `customer_rhythm`（A/B/C 分级 + 跟进节奏）✅ | **纳入** Customer Development 视角 |

**因此 V1.1 的真正四个动作**：
1. 把 **Quote** 从独立计算器升为**商业真相的起点**（商业起源域），接线 Customer + Product + Order。
2. 新增 **Customer PO Snapshot + PO Compare** —— 证据核对层（Evidence≠Data 的最佳落地）。
3. 把 **生产任务单（Manufacturing Order）生成重定根**到 已审核 Quote + Customer PO + Compare + 业务补充。
4. **接通已有的 Finance 利润闭环**（forecast→live→final），不重建。

> 这正是 Constitution 10（Evolution NOT Rewrite）：现有 quoter / orders / manufacturing_orders / profit_snapshots / customer_rhythm **一张表都不推倒**，只新增连接对象 + 可空外键 + 快照。

---

## 0.1 与 Constitution 的红线对账（最关键 — 是否违宪？）

V1.1 引入 Inquiry / Quote Package / Approved Quote / Customer PO Snapshot / PO Compare Result，**会不会违反 Constitution 01「Order 域只有三个对象，不得创建第四个订单对象」？**

**答：不违反。** 逐条核对：

| 新对象 | 属哪个域 | 是不是"第四个订单对象"？ |
|---|---|---|
| Inquiry | **Inquiry Domain（新，订单上游）** | 否。它在 Order **之前**，是商业机会，不是订单。 |
| Quote Package | **Quote Domain（新，订单上游）** | 否。报价是商业提案，不是订单。 |
| Approved Quote | Quote Domain（冻结快照） | 否。是 Quote Package 的版本快照（同 Material Snapshot / Definition version 思路）。 |
| Customer PO Snapshot | **Order/PO Domain** | 否。它是**入站证据的结构化提取**（Constitution 05 Evidence≠Data），核对后写回 Customer Order，不是独立真相对象。 |
| PO Compare Result | Order/PO Domain | 否。是 diff 投影 + 审计留痕（AI 产、人确认），不持有业务真相。 |
| Production Work Order | = Manufacturing Order（已存在第 3 对象） | **同一个对象**，用户用的是英文别名。不新增对象。 |

> **订单域仍然只有三真相对象**：`Customer Order → Material Package → Manufacturing Order`。
> V1.1 新增的 Inquiry / Quote 在订单**上游**（新域）；Customer PO Snapshot / PO Compare 是订单域内的**证据/投影**（非真相）。**Constitution 01 守住。**

其余条款对账：
- **02 单一真相源**：商业价格/成本/利润真相 → Quote/Finance；工程 BOM 结构真相 → Product Definition；成交确认真相 → Customer Order。**不重复**（见 §3 边界、§7 所有权）。
- **05 Evidence≠Data**：客户 PO 文件永远是证据；Customer PO Snapshot 是其提取草稿，**人工确认后**才写 Customer Order。
- **06 AI 是助手**：Inquiry 解析 / PO OCR / Compare diff / MO 草稿 **全部只产草稿**，人工确认闸门不可绕过。
- **09 Build once**：Approved Quote 一次确认 → 派生 Product Definition / Customer Order / Manufacturing Order / 各单据，零重录。
- **10 Evolution**：见 §0、§10 红线、§11 资产清单。

---

## 1. 更新后的 Business Flow（价值流 V1.1）

V1.0 价值流（十年不变的主干）：
```
客户需求 → 订单 → 产品开发 → 原辅料 → 生产计划 → 采购 → 仓库 → 生产 → 质检 → 包装 → 出运 → 收款
```

V1.1 **不改主干**，而是把「客户需求 → 订单」这一段**展开**成商业起源弧（Commercial Origination Arc），并显式标出证据核对点：

```
【商业起源弧 — 新展开】                          【执行弧 — V1.0 已贯通 / 在建】
Customer Development（客户开发/线索）
   │ 线索成熟
   ▼
Inquiry（询盘 / RFQ）  ──────────────── 证据：客户询盘文件（AI 解析→草稿）
   │ 业务报价
   ▼
Quote Package（报价包：产品/款号/BOM/单耗/工艺/成本/利润）★商业真相起点
   │ 内部审核
   ▼
Quote Approval（报价审核 → Approved Quote 冻结快照）
   │ 客户下单
   ▼
Customer PO（客户采购订单）─────────── 证据：客户 PO 文件（AI/OCR→草稿）
   │
   ▼
PO Compare（PO 与 Approved Quote 比对，差异人工确认）★证据核对层
   │ 确认 → 写 Customer Order
   ▼
Production Work Order（= 生产任务单 / Manufacturing Order，继承生成）
   │
   ▼
Material Package（原辅料包，实例化自 Product BOM Template）
   │ 提交采购 + MRP
   ▼
MRP（Material Requirement，可重算投影）
   │ 核料归并
   ▼
Procurement Item（采购核料项：大货单耗→算量→采购确认）
   │ 下单
   ▼
Purchase Order ─► Receiving ─► Warehouse（库存）
   │ 领料
   ▼
Production（生产）─► Quality（IQC/IPQC/FQC/OQC）─► Packing（包装）─► Shipment（出运）
   │ 出运触发
   ▼
Invoice（开票/应收）─► Payment（收款/回款）
```

**关键变化**：
- 真相的**起点从 Order 前移到 Quote Package**。Quote 是「产品 / 款号 / BOM / 单耗 / 工艺 / 成本 / 利润」的**第一来源**（用户论点 2）。
- **Customer PO 不是全部业务数据的源头**，而是对 Quote 的**确认**（用户论点 4）。它带来的是「成交数量 / 成交价 / 客户款号 / 交期 / 包装 / 特殊要求」的**确认或差异**，经 PO Compare 核对后写入 Customer Order。
- 财务**读取** Quote / PO / Cost / Purchase / Shipment / Payment，**不重复录入**（用户论点 6）。

---

## 2. 新增 / 升级的 Domain

V1.0 是 13 一级域。V1.1 在「客户需求 / 订单」段细化出**商业起源域群**，并明确与现有域的边界。**不新增价值流、不新增稳定能力**（Capability Map 不动），只是把 Order Management / Customer Management 能力**拆出当前实现域**（Capability-Map §「能力可拆，能力名不变」的合法演进）。

### 2.1 域清单（V1.1）

| 域 | 状态 | 实现哪个稳定 Capability | 与 V1.0 的关系 |
|---|---|---|---|
| **Customer Development Domain** | 🟡 升级 | Customer Management | = 现 Customer Domain 向**前**延伸到线索/开发（纳入 `customer_rhythm`） |
| **Inquiry Domain** | ⬜ 新增（轻） | Order Management（接单前段） | 询盘登记，订单上游；固化现有 `parseInquiryFile` 的输出 |
| **Quote Domain** | 🟡 升级（核心） | Order Management（报价）+ Cost Management | = 现 quoter 模块**升为一级域**；商业真相起点 |
| **Order / PO Domain** | ✅ 升级 | Order Management | = 现 Order Domain（V3.0）+ 新增 PO Snapshot / PO Compare 子能力 |
| **Manufacturing Planning Domain** | ✅ 重定根 | Manufacturing Planning | 不变域，但 MO 生成来源从「空表」改为「继承 Quote+PO」（演进 O2） |
| **Finance Domain** | 🟡 接通 | Financial Management | 不变域，接通已有 `profit_snapshots` forecast→live→final 闭环 |
| Product / Material / Procurement / Supplier / Warehouse / Production / Quality / Packing / Shipment | 不变 | 同 V1.0 | V1.1 不动其定义，只补「上游真相来自 Quote」的接线 |

### 2.2 三个商业起源域定义

#### Customer Development Domain 🟡（= Customer 域前延）
- **职责**：客户线索（Lead）→ 客户开发 → 跟进节奏 → 转为正式客户 → 年度目标 → 复盘。
- **核心对象**：Customer Lead（新，轻）、Customer（`customers`）、Customer Rhythm（`customer_rhythm`，已建：A/B/C 分级 + `next_followup_at` + `followup_status` + `risk_score`）、Sales Target、Customer Trim Library。
- **关系**：是 Inquiry / Quote 的源头；喂 Product（客户款）、Material（客户标准库）。
- **Evolution**：**纯加法**。`customers` / `customer_rhythm` 不动；Lead 可先作为 `customer_rhythm` 的一个 `stage='lead'` 态，不急于建新表。

#### Inquiry Domain ⬜（新增，刻意轻量）
- **职责**：登记一次客户询盘（要什么款、数量、目标价、面料、交期、包装），作为报价的触发与上下文。
- **核心对象**：Inquiry（询盘）。
- **现状**：`app/actions/quoter.ts::parseInquiryFile` **已能** 用 Claude Vision 把询盘图片/PDF/Excel 解析成结构化 JSON（customer_name / style_no / garment_type / fabric / quantity / colors / sizes / packaging / notes），**但结果只在内存，不落库**。
- **V1.1 动作**：把这份解析结果**固化为 Inquiry 对象**（人确认后落库），让 Quote 有可追溯的来源；Inquiry 文件本身留作 Evidence。
- **边界（防膨胀）**：Inquiry 只是「商业机会上下文」，**不是合同、不是订单**。一个 Inquiry 可派生 0~N 个 Quote（多轮报价）。**P0 可先不建独立表**，用 Quote.draft + Inquiry 附件承载，待量大再升级（见 §9 路线，DP-7 分阶段不追完美）。

#### Quote Domain 🟡（升级为一级域 —— V1.1 的心脏）
- **职责**：把客户需求**翻译成商业提案**：选款（可新建款）→ 估单耗 → 估 CMT/工序 → 估面料/辅料/包装/物流成本 → 定 margin → 出报价（多币种/数量档）→ 内部审核 → Approved Quote。
- **核心对象**：
  - **Quote Package**（`quoter_quotes` 升级）：一次报价的商业聚合。
  - **Approved Quote**（新，冻结快照）：审核通过的 Quote Package 版本快照 —— 后续一切继承的不可变基线。
- **现状资产**（全部已上线，见 §11）：`quoter_quotes`（含 `fabric_consumption_kg` / `cmt_operations` / 五项成本 / `margin_rate` / `quote_price_per_piece` / `currency` / `status: draft→sent→won/lost/abandoned`）+ `quoter_fabric_records`（单耗 RAG）+ `quoter_cmt_operations`（工序库）+ `quoter_cmt_rates`（工价表）+ `quoter_cmt_training_samples`（工价单训练）+ `quoter_training_feedback`（AI 学习闭环）。
- **生命周期**：`draft → (内部)reviewing → approved（→Approved Quote 快照）→ won / lost / abandoned`。
- **数据所有权**：Quote Domain **永久拥有**「报价/成本构成/单耗假设/margin」这份**商业真相**。它**不拥有**工程 BOM 结构（属 Product Definition），也不拥有成交后实际成本（属 Finance）。

### 2.3 与现有 Customer / Order / Product / Material / Procurement 的关系（一句话各表）
- **Customer**：Quote 的客户**必须**指向 `customers.id`（今天是 name 字符串，V1.1 接 FK）。客户开发是 Quote 的上游。
- **Order**：Customer Order **从 Approved Quote 继承生成**（继承款/数量/价/交期/条款），不再从空白 `/orders/new` 起。Quote→Order 今天是 URL 预填（`convertQuoteToOrder`），V1.1 升级为 DB 级继承 + 反向引用。
- **Product**：Quote **是 Product Definition 的诞生地之一**（见 §3）。Approved Quote 可**晋升**为 Product + Variant + Product Definition + BOM Template（Build once，人确认）。
- **Material**：Material Package（`materials_bom`）实例化自 Product BOM Template（Phase 2A 已上线），而 BOM Template 可由 Approved Quote 晋升而来 → 链路打通。
- **Procurement**：采购核料的大货单耗，源头追溯到 Product Definition（晋升自 Quote），修复 P1′「来源只到物料行、未到产品」的缺口。

---

## 3. Quote Package 的定位（核心架构问题 — 必须正面回答）

> **一句话**：Quote Package **不是** Product Definition 的"商业版拷贝"，而是 Product Definition 的**商业起源包装（Commercial Origination Wrapper）**。它是某个款**第一份定义的诞生地**，但晋升之后，**工程结构真相归 Product，商业价格真相留 Quote**，二者不重复（守 Constitution 02）。

逐问回答用户的六问：

### Q1. Quote Package 是不是 Product Definition 的商业版本？
**否（部分是其起源，不是其副本）。**
- Product Definition = 一个款跨所有订单/市场**长期复用**的**工程 + 制造 + 标准成本**真相（BOM 结构 / 版型 / 工艺 / 大货单耗模板 / 标准成本），版本冻结，归 Product Domain。
- Quote Package = **某一次交易**在**某时点**的**商业提案**：选了哪个款（可能还**不是** Product）、数量档、报价、成本构成、单耗**假设**、margin、客户、有效期，归 Quote Domain。
- 二者关系是「**起源 / 引用**」，不是「副本」：报价时若款已存在 → Quote **引用并 pin** 某个 Definition 版本（像订单一样）；若款是全新的 → Quote 先在自己域里捕获 BOM/单耗/成本，**赢单后晋升**成 Product Definition。

### Q2. Quote Package 是否可以创建 Product / Variant？
**可以 —— 在 Approved 时通过"晋升（Promote）"，人工确认。**
- 这正是 Constitution 09「Build once, generate everywhere」的落地：报价阶段录的款信息，赢单后**一次确认**即生成 Product + Variant，而不是让业务在产品库**重录一遍**。
- 闸门：晋升是**人工动作**（业务/产品负责人确认），AI 只做字段建议（Constitution 06 / DP-5）。

### Q3. Quote Package 是否可以生成 Product BOM Template？
**可以 —— 同 Q2，赢单晋升时把 Quote 内的 BOM/单耗/成本草案发布为 BOM Template。**
- Quote 内已捕获 `fabric_consumption_kg`、`cmt_operations`、辅料/包装成本 → 晋升时映射为 BOM Template 行（`material_name` / `category` / `development_consumption` / `production_consumption` / 成本）。
- 晋升后，**BOM 结构真相归 Product Definition**；Quote 保留的是「当时报价用的成本/单耗假设」（用于复盘与 AI 训练 `quoter_training_feedback`）。

### Q4. Quote Package 是否是生产任务单的数据来源？
**是 —— 但是间接来源，经 Approved Quote → Product Definition + Customer Order。**
- 生产任务单（Manufacturing Order）继承自：**Approved Quote**（款/BOM/单耗/工艺要点/包装/印绣）+ **Customer Order**（成交数量/款色码/交期/成交价，来自 PO Compare 确认）+ **业务补充生产信息**。
- 详见 §5。

### Q5. Quote Package 和 Product Definition 的边界在哪里？
| 维度 | Quote Package（Quote 域） | Product Definition（Product 域） |
|---|---|---|
| 时间性 | **交易时点的快照**（这单这价） | **长期复用**（跨订单/跨市场） |
| 真相内容 | 报价 / 成本构成 / margin / 单耗**假设** | BOM 结构 / 版型 / 工艺 / 大货单耗**标准** / 标准成本 |
| 生命周期 | draft→approved→won/lost | 开发→打样→确认→量产→归档（版本冻结） |
| 复用 | 不复用（一单一报） | 复用（一款多单） |
| 谁拥有价格 | **报价价**（quoted） | 标准成本（target FOB） |
| 关系 | **晋升出** Definition / **引用并 pin** Definition | 被 Quote 晋升 or 被 Quote 引用 |

> **边界铁律**：赢单晋升那一刻，**结构走 Product，价格留 Quote**。同一个款再来第二单：Quote 直接**引用** Product Definition（不再重录 BOM），只调商业参数（数量/价/margin）→ 彻底消除「同款多套 BOM」（Constitution 02）。

### Q6. Quote Package 和 Finance 的关系是什么？
- Quote **拥有报价侧的商业真相**：quoted 成本、quoted 售价、计划 margin。
- Finance **不重录这些**，而是把 Approved Quote 读为**利润基线（forecast）**。
- 现状已有 `profit_snapshots.snapshot_type='forecast'` —— V1.1 让它**直接取自 Approved Quote**。之后 `live`（执行中实际）/`final`（完工实际）由下游域回填，形成利润闭环（见 §6）。
- **Quote 不拥有实际成本**（那是 Finance + Procurement + Production 的）。Quote 拥有的是「当初怎么算的」，供复盘与 AI 训练。

---

## 4. PO Compare 的定位（V1.1 唯一全新、最高风险件）

> 目标：客户 PO 一上传，系统**自动**把它和 Approved Quote 对一遍，**差异高亮、人工拍板**，确认后才进生产任务单。这是 Evidence≠Data + AI 助手 + 人工确认三条宪法的最佳合体落地。

### 4.1 数据流
```
客户 PO 文件（PDF/图片/Excel/邮件）
   │ 上传 → Attachment Center（证据，只存不算 · Constitution 05）
   ▼
AI/OCR 提取（复用 parseInquiryFile 的 Claude Vision 能力）
   │ 产出 Customer PO Snapshot（结构化草稿，置信度标注）
   ▼
PO Compare（Snapshot ⟷ Approved Quote 逐字段比对）
   │ 产出 PO Compare Result（差异清单 + 严重度）
   ▼
业务/销售 逐差异确认（接受客户 / 沿用报价 / 改单 / 退回重谈）
   │ 全部 resolved → 写 Customer Order（orders + order_line_items）
   ▼
触发 Production Work Order 继承生成（§5）
```

### 4.2 AI/OCR 提取字段（Customer PO Snapshot 草稿）
客户款号、我方款号（若 PO 标注）、品名、颜色、尺码配比、**数量**、**单价**、**金额**、币种、**交期/船期**、**包装要求**、**面料要求**、印绣/特殊要求、**付款条款 / 贸易条款（FOB/CIF/DDP…）**、收货地址、唛头。
> 全部为**草稿**，逐字段带置信度；低置信高亮。**AI 永不直接写 Customer Order**（Constitution 06 / Order 域 V3.0 Principle 4）。

### 4.3 比对项（Snapshot ⟷ Approved Quote）
| 比对项 | Quote 侧来源 | PO 侧来源 | 差异严重度（建议） |
|---|---|---|---|
| 客户款号 | inquiry/quote.style_no | PO 款号 | 🟡 中（影响识别） |
| 我方款号 | quote.style_no / Product code | PO（若有） | 🟡 中 |
| 颜色 | quote.size/color | PO 颜色 | 🟡 中 |
| **数量** | quote.quantity / 数量档 | PO 数量 | 🔴 高（影响算量/价/产能） |
| **单价** | quote.quote_price_per_piece | PO 单价 | 🔴 高（影响利润） |
| **金额** | quote 总价 | PO 总额 | 🔴 高（勾稽校验：数量×单价） |
| 交期 | quote 交期假设 | PO 船期 | 🔴 高（影响排产/MRP 软化） |
| 包装要求 | quote/inquiry packaging | PO 包装 | 🟡 中 |
| 面料要求 | quote.fabric_* | PO 面料 | 🟡 中 |
| 特殊要求 | quote.notes | PO 特殊要求 | 🟢 低 |
| 付款/贸易条款 | quote 条款 | PO 条款 | 🔴 高（影响应收/现金流） |

### 4.4 差异提示 / 谁确认 / 确认后去向
- **提示**：三色（🔴 高 / 🟡 中 / 🟢 低）。🔴 差异**必须**逐条 resolve 才能进生产任务单（硬闸）；🟡/🟢 可批量接受。
- **谁确认**：**业务/销售**（成交侧归属，Constitution 04 字段归属）。涉及利润红线（单价/金额/条款）的 🔴 差异，建议联动 **Finance** 二次确认（可配置）。
- **确认后**：差异 resolved → 把**确认值**写入 Customer Order（`orders` + `order_line_items`）；Approved Quote 与 PO Compare Result 作为**审计留痕**保留（谁、何时、为什么接受差异）。
- **进生产**：Customer Order 确认完整 → 解锁「生成生产任务单」（§5）。

> **PO Compare Result 不是真相对象**，是 diff 投影 + 审计；真相落在 Customer Order。守 Constitution 01（不增第四订单对象）。

---

## 5. Production Work Order 的定位（= Manufacturing Order，重定根）

> **澄清命名**：Production Work Order = **Manufacturing Order = 生产任务单 = O2 的 `manufacturing_orders`**。同一个对象（Constitution 第 3 真相对象），用户用英文别名。**V1.1 不新建对象**，只改它的**生成来源**。

### 5.1 从「空表录入」到「继承生成」
O2 现状（已上线）：`manufacturing_orders` 1:1 卫星表，业务**手填** 4 个翻译字段（印绣/QC重点/特殊要求/风险），其余 join 现有真相。
V1.1 演进（呼应 O2 自身 Roadmap O2-3「接 AI 但守闸门」）：MO **从三处继承预填**，业务只**复核 + 补充**：
```
Approved Quote          ──► 款/BOM要点/单耗/工艺要点/印绣/包装假设（草稿带入）
Customer PO Snapshot     ──► 成交数量/款色码/交期/包装/特殊要求（经 Compare 确认）
PO Compare Result        ──► 差异确认结论（哪些以 PO 为准、哪些以 Quote 为准）
业务补充生产信息          ──► 工厂内部执行说明 / QC 重点 / 风险提醒（人工录）
        │ 人工确认（Constitution 06，AI 永不直接生成可执行 MO — O2 §0 红线）
        ▼
Manufacturing Order（生产任务单，确认 → 下发工厂）
```

### 5.2 字段去向矩阵
| 字段 | 自动带入来源 | 业务是否必须确认 | 流向下游域 |
|---|---|---|---|
| 产品/款号 | Approved Quote / Product | 否（只读绑定） | 采购 / 生产 |
| 款色码矩阵 | Customer Order（PO Compare 确认后） | **是** | 采购（算量）/ 生产 |
| 数量 | Customer Order（PO 为准） | **是**（🔴 差异已 resolve） | 采购 / 生产 / 财务 |
| 交期 | Customer Order（PO 船期） | **是** | 生产排产 / MRP 软化 / 出运 |
| BOM / 单耗 | Product BOM Template（晋升自 Quote） | 否（实例化，Phase 2A） | **采购**（Material Package→MRP→核料） |
| 大货单耗 | Product Definition（晋升自 Quote） | 采购 Override | **采购**（Procurement Item，Phase 2B） |
| 成交价 / 条款 | Customer Order（PO 为准） | **是** | **财务**（应收/利润） |
| 印绣 / 包装要求 | Quote 假设 + PO 确认 | **是** | 生产 / 包装 |
| QC 重点 / 风险提醒 / 工厂执行说明 | 业务手录（MO 翻译字段） | **是**（人工录） | 生产 / 质检 |
| 工艺 / SMV / IE / MES | **不进 MO**（Constitution 07/08） | — | **永不**（属 Production Domain） |

> **红线不变**：MO 仍只「表达需求」，工艺/SMV/IE/MES 一律不进（Constitution 07/08，ADR-003）。V1.1 只是把「需求」的**来源**从空表换成 Quote+PO 继承。

---

## 6. Finance Domain 接入（利润闭环 — 大部分已在，接通即可）

> **现状**：`profit_snapshots`（`snapshot_type ∈ forecast/live/final`，含 revenue/cost 拆解/gross_margin/margin_status）+ `order_cost_baseline`（fabric/CMT/FOB + `actual_consumption_kg` 回流）+ `system_alerts`（low/negative margin 告警）**已上线**（Trade OS foundation）。V1.1 **不重建**，只把数据源接到 Quote 与下游执行。

### 6.1 利润闭环的三个快照（映射已有 `profit_snapshots`）
| 阶段 | snapshot_type | 数据来源（V1.1 接线） | 含义 |
|---|---|---|---|
| 报价 | **forecast** | **Approved Quote**（quoted 成本/售价/margin） | 计划利润（这单该赚多少） |
| 成交 | forecast→修正 | Customer Order（PO 成交价，经 Compare） | 成交价修正后的计划利润 |
| 执行中 | **live** | 采购实际成本（Procurement Item/PO）+ 生产实际（`order_cost_baseline.actual_*`） | 在制利润（正在变成多少） |
| 完工 | **final** | 实际采购 + 实际生产 + 实际物流 + 应收/回款 | 结案利润（实际赚了多少） |

### 6.2 利润闭环数据流
```
Quote（报价成本/售价/margin）
        │ Approved → 写 profit_snapshots(forecast)
        ▼
Customer PO 成交价（PO Compare 确认）
        │ 修正 forecast revenue
        ▼
采购实际成本（Procurement Item 确认价 / Purchase Order）
生产实际成本（order_cost_baseline.actual_fabric_used_kg / actual_consumption_kg）
        │ 写 profit_snapshots(live) + 触发 system_alerts(若 margin 跌破阈值)
        ▼
出运（Shipment）→ Invoice（应收）
回款（Payment）
        │ 写 profit_snapshots(final) + 实际单耗回流 quoter_training_feedback
        ▼
利润闭环 = forecast → live → final，且 actual 单耗反哺 Quote AI（已有回流字段）
```
> **关键**：Finance **只读** Quote/PO/Cost/Purchase/Shipment/Payment（用户论点 6），**不重复录入**。财务录入仅在「外部财务系统 budget 回传」处（见 memory `finance-budget-entry`），不与此冲突。
> **门控**：价格/利润按 `CAN_SEE_FINANCIALS` 角色门控（不暴露给 production/merchandiser/admin_assistant）。

---

## 7. Data Ownership（每对象唯一真相源 — V1.1）

| 对象 | 唯一真相源（Owner 域） | 别人怎么用 | 现状落点 |
|---|---|---|---|
| **Customer / Lead** | Customer Development | Quote/Order 引用 `customers.id` | `customers` + `customer_rhythm` ✅ |
| **Inquiry** | Inquiry Domain | Quote 引用（来源上下文） | `parseInquiryFile` 产出，待固化 🟡 |
| **Quote Package** | **Quote Domain** | Order/Product/Finance 读为商业基线 | `quoter_quotes` ✅（待接 FK） |
| **Approved Quote** | **Quote Domain**（冻结快照） | Order 继承 / Product 晋升 / Finance forecast | 🆕 快照（待建） |
| **Product / Variant** | Product Domain | Order Line 引用 Variant | `products` / `product_variants` ✅ |
| **Product Definition / BOM Template** | Product Domain | Material 实例化 / 采购带大货单耗 | `product_definitions` / `product_bom_templates` ✅ |
| **Customer PO Snapshot** | （证据，非真相）Order/PO | 仅供 Compare；确认值写 Customer Order | 🆕（待建，证据层） |
| **PO Compare Result** | （投影/审计，非真相）Order/PO | 审计留痕；不被下游计算 | 🆕（待建） |
| **Customer Order** | **Order Domain** | 一切挂 order_id；MO/采购/财务消费 | `orders` + `order_line_items` ✅ |
| **Production Work Order**（= Manufacturing Order） | **Manufacturing Planning** | Production 据此补工艺（解耦） | `manufacturing_orders` ✅ |
| **Material Package** | Material Domain | 提交采购 / MRP | `materials_bom` ✅ |
| **Material Requirement** | Procurement·系统 | 核料归并（可重算投影） | `material_requirements` ✅ |
| **Procurement Item** | Procurement | 下单 / 应付预估 | `procurement_items` ✅ |
| **Purchase Order** | Procurement 执行 | 到料 / 财务应付 | `procurement_line_items` 🟡 |
| **Invoice / Payment** | **Finance** | 应收应付 / 回款 / 目标达成 | 🟡/⬜ |
| （quoted 成本/利润） | **Quote** | Finance forecast 读 | `quoter_quotes` ✅ |
| （actual 成本/利润） | **Finance** | 利润 live/final | `profit_snapshots` + `order_cost_baseline` ✅ |

> **去重判据**：商业价格真相在 **Quote/Finance**；工程结构真相在 **Product**；成交确认真相在 **Order**；执行实际在**各执行域**。同一字段绝不两域共同拥有（Constitution 02/04）。

---

## 8. Object Relationship Map V1.1（对象关系全图）

> 图例：`(1)`一 ·`(N)`多 ·`→`引用/产生 ·`⇢`晋升/继承（人确认）·`[域]`拥有域 ·`✅🟡⬜`落地状态。

```
                       ┌─────────────────────────────────────────────┐
【商业起源弧 — 新】     │                                             │
Customer Lead [CustDev] 🟡                                           │
   │ 成熟                                                           │
   ▼                                                                │
Customer [CustDev] ✅                                                │
   │ (1:N)                                                          │
   ▼                                                                │
Inquiry [Inquiry] ⬜ ········ 证据：询盘文件（AI 解析→草稿）         │
   │ (1:N) 报价                                                     │
   ▼                                                                │
Quote Package [Quote] ✅(quoter_quotes) ── 引用 ──▶ Customer         │
   │  ├─ 引用/pin ──▶ Product Definition（款已存在）                │
   │  └─ ⇢ 晋升(赢单,人确认) ──▶ Product ⇢ Variant ⇢ Definition ⇢ BOM Template
   │ (1:1) 审核冻结                                                 │
   ▼                                                                │
Approved Quote [Quote] ⬜ ★商业基线快照                              │
   │                                                                │
   │ 客户下单 ········ 证据：客户 PO 文件（AI/OCR→草稿）            │
   ▼                                                                │
Customer PO Snapshot [Order/PO·证据] ⬜                              │
   │ (1:1) 比对                                                     │
   ▼                                                                │
PO Compare Result [Order/PO·投影] ⬜ ──(diff)──▶ Approved Quote      │
   │ 差异 resolved(人确认) → 写真相                                 │
   ▼                                                                │
═══════════════════════════════════════════════════════════════════╪═══ 真相边界 ═══
                                                                    │
Customer Order [Order] ✅ ──(1:N)──▶ Order Line Item [Order] ✅       │
   │  └ order_line_items.product_variant_id → Product Variant ✅    │
   │ ⇢ 继承生成(Quote+PO+Compare+业务补充, 人确认)                  │
   ▼                                                                │
Production Work Order = Manufacturing Order [MP] ✅(manufacturing_orders, 1:1 order)
   │                                                                │
   ▼                                                                │
Material Package / materials_bom [Material] ✅  ◀─实例化─ Product BOM Template ✅(Phase2A)
   │ 提交采购 + MRP                                                 │
   ▼                                                                │
Material Requirement [Procurement·系统] ✅                           │
   │ 核料归并 (N:1)                                                 │
   ▼                                                                │
Procurement Item [Procurement] ✅  ◀─大货单耗带入─ Product Definition (Phase2B)
   │ 下单 (1:N)                                                     │
   ▼                                                                │
Purchase Order [Procurement执行] 🟡 ─▶ Receiving [Warehouse] ⬜ ─▶ Inventory [Warehouse] ⬜
                                                                    │ 领料
   ┌────────────────────────────────────────────────────────────────┘
   ▼
Production [Production] 🟡 ◀─(消费)─ Manufacturing Order
   │ 完工
   ▼
Quality(IQC/IPQC/FQC/OQC) [Quality] 🟡 ─▶ Packing [Packing] ⬜ ─▶ Shipment [Shipment] 🟡
   │ 出运
   ▼
Invoice [Finance] 🟡 ─▶ Payment [Finance] ⬜

【利润闭环 — 横切 Finance，读不写真相】
Approved Quote ─(quoted)─▶ profit_snapshots(forecast) ✅
Procurement/Production 实际 ─▶ profit_snapshots(live) ✅ ─▶ system_alerts(margin) ✅
Invoice+Payment 实际 ─▶ profit_snapshots(final) ✅ ─▶ 实际单耗回流 quoter_training_feedback ✅
```

**跨订单可复用（被引用不被拥有）**：Customer · Product/Variant/Definition · Material Master · Supplier。
**与 V1.0 ORM 的差异**：新增了 Approved Quote 之前的整条商业起源弧 + Customer PO Snapshot/Compare 证据核对层；真相边界线明确画出（线上是证据/投影，线下是真相）。

---

## 9. Roadmap（重排优先级 + 对用户排序的挑战）

> 用户倾向：P0=Quote+Approval / PO Snapshot+Compare / MO 模板生成；P1=Product/Material/Procurement 连接；P2=PO/Receiving/Warehouse；P3=Finance 利润闭环；P4=AI 全面接入。
> **我的结论：方向对，但有 4 点要调整。**

### 9.1 我同意的部分
- ✅ **Quote + Approval 必须最先**：它是新真相起点，PO Compare 要拿它来比，MO 要继承它。无 Quote 则后续皆空。
- ✅ **PO Compare 在 MO 之前**：MO 继承的成交数据来自 Compare 确认结果。顺序正确。
- ✅ **执行端（PO/Receiving/Warehouse）靠后**：它们消费上游真相，先有源才有消费。

### 9.2 我挑战的 4 点（含理由）

**挑战 1：P0 太大，必须拆。PO Compare 是全系统唯一全新且最高风险件，应单独成阶段。**
> Quote 重定根、Approval 收口、Quote→Product 晋升、PO OCR、PO Compare diff+resolve UX、MO 重定根 —— 这是 6 个里程碑级工作量塞进一个 P0。其中 **PO Compare 依赖 OCR 准确率 + 跨款号匹配（客户款号⟷我方款号）+ 差异确认 UX**，是采用率与正确性的双重赌注（项目已被 AI 解析准确率烧过，见 Order V3.0 风险 5）。把它和 Quote 捆在一个阶段，会让整个 P0 被最难的件拖死。**拆开。**

**挑战 2：Finance forecast 不是 P3，几乎是 P0 的免费搭车。**
> `profit_snapshots(forecast)` + `order_cost_baseline` 已建，Quote 已算成本/margin。「Approved Quote → 写 forecast 快照」是几十行接线，**应随 P0 一起落**。真正要等的是 **final 实际成本闭环**（依赖采购/生产实际），那才靠后。**把 Finance 拆成两段：forecast 基线=P0 顺带；actual 闭环=执行端之后。** 不要把整个 Finance 推到 P3 —— 那会让「这单赚不赚」的可见性白白晚三个阶段，而它现在几乎免费。

**挑战 3：「AI 全面接入」不该是 P4 的独立阶段。AI 是横切 Platform Service（EA 第 5 章），每个阶段都带、都过人工确认闸门。**
> AI 已深嵌（quoter RAG、`parseInquiryFile`、训练闭环）。**PO Compare 的 OCR 是 P0/P1 的核心，不可能等到 P4**。所以 AI 不是一个"阶段"，而是每阶段内的一层（OCR@PO-Compare、字段建议@MO、Supply Brain@Analytics）。**真正属于最后的，是「Agent/Automation 围绕事件自治编排」**，而那要先有 Event Bus（Event-Catalog 第 2/3 步）。把 P4 从「AI 全面接入」改名为「事件驱动 + Agent 编排」。

**挑战 4：Quote→Product 晋升属于 P0，不是 P1。**
> 没有晋升，Approved Quote 无法喂 Product Definition / BOM Template / MO，整条继承链断在起点。**晋升是 Quote Domain 闭环的一部分**，应在 P0。P1 留给「采购回归 Product 驱动」（修 P1′ 缺口）这类**深化**工作。

### 9.3 我建议的重排

| 阶段 | 名称 | 内容 | 为什么这个位置 |
|---|---|---|---|
| **P0** | **商业起源脊柱** | Quote 重定根（接 customer_id/product）+ Quote Approval 收口（Approved Quote 快照）+ **Quote→Product 晋升** + **Finance forecast 基线**（顺带） | 立起新真相起点；晋升与 forecast 几乎免费搭车 |
| **P1** | **PO 核对 + MO 重定根** | Customer PO Snapshot（复用 parseInquiryFile OCR）+ **PO Compare**（diff+resolve UX）+ MO 从 Quote+PO 继承生成 | **隔离最高风险件**；MO 继承依赖 Compare |
| **P2** | **Product/Material/Procurement 深化** | Procurement 回归 Product 驱动（修 P1′）+ 大货单耗从 Definition 带入（即暂停的 Phase 2B）| 消费端深化，需先有上游真相 |
| **P3** | **执行端** | Purchase Order 拆单 + Receiving + Warehouse 库存 | 消费 P2 的采购真相 |
| **P4** | **Finance 实际利润闭环** | live/final 实际成本（采购/生产/物流/应收/回款）+ 实际单耗回流训练 | 依赖 P3 执行实际数据；forecast 已在 P0 |
| **P5** | **事件驱动 + Agent 编排** | Event Bus / Outbox + AI Agent 围绕事件自治（守 DP-5）| 全链结构化后才有事件可编排 |

> 与用户排序的净差异：**① P0 拆成 P0+P1（隔离 PO Compare）；② Finance forecast 提到 P0、actual 闭环留 P4；③ AI 不单列阶段，改为每阶段横切 + P5 事件编排；④ Quote→Product 晋升从 P1 提到 P0。** 其余（执行端靠后）与用户一致。

---

## 10. 红线（V1.1 必守，逐条对账）

| # | 红线 | V1.1 如何保证 |
|---|---|---|
| 1 | 不推翻已上线订单系统 | `orders`/`order_line_items`/18 关卡/Runtime Confidence **零改动**；Customer Order 仍是订单真相根 |
| 2 | 不影响 O1/O2/Product Phase1/Material Package/B1/P1′ | 全部**纯加法接线**：新增可空 FK（quote→customer/product、order→quote）+ 新增证据/快照对象；既有表结构不动 |
| 3 | Evolution NOT Rewrite | quoter / manufacturing_orders / profit_snapshots / customer_rhythm **一张表不推**；Quote 升域 = 加 FK + 快照；MO 重定根 = 改来源不改对象（Constitution 10） |
| 4 | 文件仍作 Evidence | 询盘文件 / 客户 PO 文件 → Attachment Center，**只存不算**；结构化真相来自确认后的 Snapshot（Constitution 05 / Order V3.0 Principle 2/3） |
| 5 | AI 只提取/比对/提醒，不写真相 | Inquiry 解析 / PO OCR / Compare diff / MO 草稿**全部只产草稿**，人工确认闸门不可绕过（Constitution 06 / DP-5 / O2 §0） |
| 6 | Quote/PO/MO 必须人工确认才进后续 | Quote→Approved（审核）/ PO Compare 🔴 差异逐条 resolve（硬闸）/ MO confirmed 留痕才下发（三道人工闸门） |

> **Constitution 01 复核**：全程不新增第四订单对象。Inquiry/Quote 在订单上游（新域）；PO Snapshot/Compare 是证据/投影（非真相）；Production Work Order = 既有 Manufacturing Order。

---

## 11. 现状资产清单（Evolution 的依据 — 每项都"已存在"）

> 每个 V1.1 能力都对照"现状已有什么"，证明这是接线而非新建。

| V1.1 能力 | 现有资产（文件 / 表） | 缺口 |
|---|---|---|
| Quote Package | `quoter_quotes` + `app/actions/quoter.ts`（preview/save/list/duplicate/convertToOrder/compare/feedback）+ `lib/quoter/*`（fabric/cmt/trim RAG）| 未接 `customers.id` / `product_variant_id`；status 与 orders.quote_stage 双轨 |
| Quote AI/训练 | `quoter_fabric_records` / `quoter_cmt_operations` / `quoter_cmt_rates` / `quoter_cmt_training_samples` / `quoter_training_feedback` + `/quoter/training` | 实际单耗回流已有字段，未全自动 |
| Inquiry 解析 | `quoter.ts::parseInquiryFile`（Claude Vision，已能解析图片/PDF/Excel）| 结果不落库 → 需固化 Inquiry 对象 |
| Quote Approval | `orders.quote_status`/`quote_approved_by/at`/`quote_stage` | 挂 orders 而非 Quote；需收口到 Approved Quote 快照 |
| Customer PO + Compare | — | **全新**（最高风险，P1） |
| Production Work Order | `manufacturing_orders`（O2）+ `app/actions/manufacturing-order.ts` + `components/tabs/ManufacturingOrderTab.tsx` | 来源是空表录入 → 重定根为继承 |
| Material Package 实例化 | `materials_bom` + `instantiateOrderMaterialPackage`（Phase 2A 刚上线）+ `product_bom_templates` | 已通；大货单耗带入留 Phase 2B |
| Finance 利润闭环 | `profit_snapshots`(forecast/live/final) + `order_cost_baseline`(含 actual 回流) + `system_alerts` | forecast 未接 Quote；live/final 待执行端 |
| 客户开发 / 线索 | `customers` + `customer_rhythm`(A/B/C+跟进) + `customer_matters` + `/my-customers` | Lead 态未显式建模（可先用 rhythm.stage） |

---

## 12. 落地纪律（修宪路径）

本文件是 **Proposal**，不是冻结的 EA。按修宪纪律落地顺序：
1. **本 V1.1 Upgrade Plan**（你审）。
2. 拆出 **ADR-005「Commercial Origination — Quote 为订单上游商业真相起点」**（记录"为什么把真相起点前移"+ Quote/Product 边界决策）。
3. 升级 **Domain 文档**：新建 `Domains/Quote.md`、`Domains/Inquiry.md`；升级 `Domains/Customer.md`、`Domains/Order.md`（+PO Compare 子能力）、`Domains/Finance.md`。
4. 每阶段（P0…P5）开工前过 **DoD 双门禁**（Architecture Gate + Future Gate）。
5. 多阶段验证长期成立后，才把 V1.1 升级为锁定 EA 基线、并考虑是否有原则需进 Constitution（**优先不动 Constitution**）。

> **不写代码 / 不写 migration / 不提交 / 不 push** —— 本轮只产出设计。
</content>
</invoke>

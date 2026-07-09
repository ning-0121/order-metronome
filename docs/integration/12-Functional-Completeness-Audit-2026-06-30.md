# QIMO OS — Functional Completeness Audit（功能完整度 / 跑通审计）

> **Date**: 2026-06-30 · 立场：**不替你乐观**。"完美实现且跑通"是高门槛——这里**分档诚实标注**，不一律打绿。
> **证据分档**：
> - ✅✅ **本轮亲验**（这次会话我门禁/测试/部署过）
> - ✅ **生产在用**（路由已编译 + 表已建 + `app/actions` 代码 + CLAUDE.md 证明在线；**本轮未逐一亲测端到端**）
> - 🟡 **部分 / 已建未接通 / 未验证**
> - 🔴 **设计 or 缺失**
> **三系统**：QIMO `scrtebex`（订单/生产/采购/报价中枢）· finance `qpoboel`（钱）· araos `hpdcqjf`（获客）。

---

## 一句话结论（先说）
**三个系统各自"内部"基本跑通且强**——尤其 QIMO 的「报价 → 订单 → 18 关卡 → 采购执行」+ 交付置信度风险引擎，是真正在用、且完成度高的运营核心；finance 是完整账务系统；araos 是完整获客系统。
**但系统"之间"的统一数据链还没流起来**：本轮建的身份脊柱是**惰性地基**（列全 NULL、无人读写）、契约 API **部署了但没激活**、araos 赢单桥**关着**、0c/0d 还在设计/未启动。
**新的"商业起源弧"（询盘 / Quote 作真相源 / Customer PO / PO Compare / 从报价生成生产单）是设计稿，未落地。**

---

## A. 服装外贸价值链 — 逐环节状态

| # | 环节 | 状态 | 在哪 | 已跑通的具体能力 / 缺口 |
|---|---|---|---|---|
| 1 | **客户开发 / CRM** | ✅ 生产在用 | araos + QIMO | araos：companies/contacts/deals/外联/会话（完整获客）。QIMO：`customers` + `customer_rhythm`（A/B/C 分级+跟进节奏）+ `customer_matters`（投诉/风险检测）。**各自在用。** |
| 2 | **询盘 Inquiry** | 🟡 部分 | QIMO | `parseInquiryFile`（Claude Vision 解析询盘图片/PDF/Excel）**已能解析**，但结果**不落库**、无 Inquiry 对象。→ AI 能力在，未固化。 |
| 3 | **报价 Quote** | ✅ 生产在用（强） | QIMO + araos | QIMO `/quoter`：单耗 RAG、CMT 工序/工价、margin、多币种、训练反馈闭环、Vision 解析、导出报价单、convertQuoteToOrder。araos `quote_strategies`（售前议价）。**真正成型在用。** |
| 4 | **样品 Sample** | 🟡 各自有、不连 | araos + QIMO | araos `samples`（requested/confirmed/in_production）；QIMO 18 关卡里的「产前样完成/寄出/确认」。**两边各自track，未打通**（handoff 关着）。 |
| 5 | **Customer PO + PO Compare** | 🔴 设计稿 | — | EA V1.1 设计，**未建**。当前订单靠 quote 预填**手工**建，无 PO OCR、无差异比对。 |
| 6 | **订单 Order**（核心） | ✅ 生产在用（最强） | QIMO | `orders`+`order_line_items`+**18 关卡** milestones+延期申请+lifecycle+理单负责人+复盘+**交付置信度风险引擎**（Runtime Phase1，2026-05-06 上线）。`/orders/*` 全套页面。**整个企业最成熟的节点。** |
| 7 | **生产任务单 MO** | ✅ 生产在用 | QIMO | `manufacturing_orders`（O2）：结构化录入翻译字段+生命周期+生成生产单。按宪法**不含工艺/MES**（那是生产域）。 |
| 8 | **物料 / BOM** | ✅ 生产在用（开发单耗） | QIMO | `materials_bom`+`material_master`+`product_bom_templates`+**从产品款实例化 BOM**（Phase 2A，`3bd7c00`）。🟡 大货单耗从 Definition 带入（Phase 2B）**暂停**。 |
| 9 | **采购 Procurement** | ✅ 生产在用 + ✅✅ 本轮加只读视图 | QIMO | 执行：`procurement_line_items`（订/收/差异状态机+催货+收货检验+跨单队列+风险事项）`/procurement` 在用。MRP：`material_requirements`（ADR-002 脊柱）。🟡 归并 `procurement_items`（P1，schema 未提交）。**本轮新增**：只读采购视图+返单 payload+quote 校验 API（55/55 测试+部署，**但还没 UI 消费**）。 |
| 10 | **仓库 Warehouse** | 🟡 部分 | QIMO | `/warehouse` 页面在；收货量在 `procurement_line_items.received_qty` 层 track；结构化 Receiving/Inventory/批次对象**未建**（EA 标 ⬜）。 |
| 11 | **生产 Production** | 🟡 里程碑级 | QIMO | 经 18 关卡 track（大货启动等）；工艺/SMV/MES**有意不建**（宪法 07/08）。 |
| 12 | **质检 QC** | 🟡 里程碑级 | QIMO | 18 关卡里「中期验货/尾期验货/QC预约/QC完成」track；结构化 Inspection 对象 🟡（Quality 域 🟡）。 |
| 13 | **包装 Packing** | 🟡 里程碑级 | QIMO | 「包装到位」track；独立 Packing 域（吊牌/装箱/Carton）⬜ 规划。 |
| 14 | **出运 Shipment** | 🟡 里程碑级+部分 | QIMO | 「订舱完成/出运完成」track；`shipment_confirmations` 表在；结构化 Shipment 域 🟡。 |
| 15 | **发票 / 收款** | ✅ 生产在用 | finance | finance：`actual_invoices` + `receivable_payments`(AR) + `payable_records`(AP) + `order_settlements`。**完整账务在用。** |
| 16 | **利润 Profit** | ✅ 生产在用（但双源风险） | finance + QIMO | finance：结算利润真相。QIMO：`profit_snapshots`(forecast/live/final)+`order_cost_baseline`+`system_alerts`（Trade OS）。🟡 live/final 应读 finance、现状可能自算 → **双真相源风险**（架构审计已记）。 |

---

## B. 系统"之间"的连接 — 跑通了吗？

| 连接 | 状态 | 说明 |
|---|---|---|
| QIMO → finance 订单/预算同步 | ✅ 生产在用 | webhook 推 order+报价 → finance `synced_orders` + **自动建预算草稿**。**老桥在跑。** |
| finance → QIMO 审批回调 | ✅ 生产在用 | `finance-callback` 接审批结果。 |
| finance 直连 QIMO 库 | ✅ 生产在用（脆） | service-key 跨库读 orders（最脆耦合，0d 要拆）。 |
| **araos → QIMO 赢单 handoff** | 🔴 **关着** | `METRONOME_WEBHOOK_URL` 未设，赢单死在 `pending`。获客→订单**断链**。 |
| **0a 身份脊柱**（本轮） | ✅✅ 已发但**惰性** | 三库 15 列已门禁 PASS+归档，但**全 NULL、无人读写** → 地基铺了，数据没流。 |
| **0b 契约 API**（本轮） | ✅✅ 已部署但**未激活** | 4 只读端点+日志表+middleware 豁免已上线；但 `CONTRACT_KEY_*` env **未配** + 自签名自测**未确认 PASS** → 无 key 即 401，**没真正对外跑通**。 |
| 0c handoff 队列 | 🔴 设计稿 | 仅 `docs/integration/10` 设计 + 已锁定（无 auto-convert）；**无代码**。 |
| 0d finance 拆直连 | 🔴 未启动 | 待"事件决策"（架构审计 P0）。 |

---

## C. 本轮会话我**亲自验证**过的交付（✅✅）

| 交付 | 验证方式 | commit |
|---|---|---|
| 0a 身份脊柱（QIMO 5 + finance 4 + araos 6 列） | 三库各跑 8–10 项 DB 门禁全 PASS | `ffdc602` / finance `fc352cf` / araos `257e8bb` |
| 0b 契约日志两表 | 10 项 DB 门禁全 PASS | `9c8f0f5` |
| 0b 契约 API v1（4 只读端点 + HMAC/scope/log 框架） | 12 项单元 + build + check + 部署（401 无 key） | `fc220dc` |
| middleware 豁免 `/api/contract` | build+check + 线上 307→401 修正 | `8e826cc` |
| **采购只读视图 + 返单 + quote 校验** | **55/55** 单元（含**零写**断言）+ build + check + 部署（307 受保护） | `036fc9c` |

> 注：这些"亲验"= 我验了**门禁/测试/构建/部署存在**；契约 API 与采购视图的**带登录态 200 业务路径**需你真实账号验证（我无法登录）。

---

## D. 诚实的"**还没跑通**"清单

1. **跨系统统一数据链**：身份脊柱惰性、契约未激活、赢单桥关着 → araos→QIMO→finance **没有用同一企业 id 真正流起来**。
2. **商业起源弧**（EA V1.1）：Inquiry 固化 / Quote 作企业真相源 / Customer PO / PO Compare / 从报价继承生成生产单 → **全是设计稿**。
3. **采购新视图无 UI**：API 测过、部署了，但**没有页面消费**，业务员还看不到。
4. **利润双源未消除**：QIMO live/final vs finance 结算 → 未统一读 finance。
5. **下游结构化**：Warehouse/Quality/Packing/Shipment **多停在里程碑级**，无结构化对象。
6. **origin_quote_id 未接线**：列在（0a），但订单创建流程**没写它** → quote→order 链路在库里还断着。

---

## E. verdict + 最高优先下一步

**verdict**：运营**核心**（报价→订单→18关卡→采购执行→财务账务）**真在用、真跑通**；这是你最该自豪的部分。但"**一条企业数据链**"目前是 **3 条各自跑通的链 + 没接上的接头**。本轮把"接头的地基"（身份/契约/采购读层）打好了，**但还没通电**。

**最高性价比的下一步（任选其一，都小且真实）**：
- **A. 通电赢单桥**（最高商业价值/最低成本）：设 `METRONOME_WEBHOOK_URL` + 0c handoff 队列（已设计、无 auto-convert）→ araos 赢单**真进** QIMO 待确认队列。获客→订单断链补上。
- **B. 激活契约 API**：配 4 个 env + 跑线上自签名自测 → 0b 从"部署"变"跑通"（也是 0d 拆 finance 直连的前置）。
- **C. 采购视图接最小 UI**：让业务员真能在订单页看到采购视图/返单（把本轮 API 变成"业务看得见"）。
- **D. origin_quote_id 接线**：一处最小改动，把 quote→order 链路在库里接通。

> 我的建议排序：**先 C 或 D（把刚发的东西变成业务可见/数据接通，闭环本轮）→ 再 A（补获客断链）→ 再 B（激活契约，为 0d 铺路）。** B 之前你欠一个"0b 线上自测 PASS"。
</content>

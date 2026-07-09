# Business Object Integration Review V1.0 — Quote ⊕ Customer PO ⊕ Order

> **Date**: 2026-06-30 · 四视角审计：CTO / CPO / COO / 外贸服装运营负责人。
> **目标**：验证 Quote→Customer PO→Order 是否真正组成**一条完整、自洽、零重复的商业数据链**。**不设计新对象、不碰代码/DB/架构。**
> **审计对象**：`Quote-Blueprint-V1.0` · `Customer-PO-Blueprint-V1.3(Freeze)` · `Order-Blueprint-V1.0`。
> **诚实立场**：发现 6 个真实跨对象缺口（含一处我在 Order 蓝图**过度声称**），逐个给出闭合规则；闭合后方可封板。

---

## 第一部分 — Business Object Relationship（Ownership/Truth/Reference/Inheritance）

```
Customer ─owns─► customers ◄─reference(id)─ Quote / Customer PO / Order
Inquiry  ─source─► Quote(reference)
Sample   ─(里程碑级,非对象,见 §发现6)─► 挂 Quote/Order
Quote ──REFERENCE(quote_id, 比对基线)──► Customer PO ──INHERITANCE(100% Confirmed)──► Order
```
| 关系 | 类型 | 含义 |
|---|---|---|
| Customer → Quote/PO/Order | **Reference**（id） | 客户录一次，全链引用 |
| Quote → Customer PO | **Reference** | PO 引用 Quote 作比对基线（非继承！PO 真相是客户主张） |
| Customer PO → Order | **Inheritance** | Order 100% 继承 Confirmed PO（公司承诺） |
| Order → 下游 | **挂 order_id** | 各下游各 Owner，引用 Order |

> **关键澄清**：Quote→PO 是**引用**（PO 不继承 Quote 值，PO 真相=客户写的）；PO→Order 是**继承**（Order 继承确认值）。**两段关系类型不同**——这是全链最易混淆处，必须钉死。

---

## 第二部分 — Truth Boundary Review（逐字段查重复）

| 字段 | Quote | Customer PO | Order | 判定 |
|---|---|---|---|---|
| 客户 | customer_name **字符串** 🔴 | 引用 customers.id | 引用 customers.id | **🔴 发现3：Quote 用字符串未连 id → 客户重表述** |
| 款/Style | 自己存 or 引用 Product? 🟡 | 引用 quote 款 | 引用 product_variant_id | **🟡 发现2：款 Owner 不清(Quote vs Product)** |
| 颜色/尺码 | Quote Line | PO Line(客户主张) | Order Line(继承) | 产品身份"捕获+比对"，非拥有两次 ✅ |
| **数量** | quoted(报价量) | ordered(客户量) | confirmed(确认量) | **3 个不同事实，非重复** ✅ |
| **单价** | quoted price(提案价) | 客户 PO 价 | confirmed price(成交价) | **3 个不同事实** ✅ |
| 成本/margin | ✅ Quote 拥有 | — | — | 单一 ✅ |
| 交期 | 报价假设 | 客户期 | 确认期 | 3 事实 ✅ |
| 大货单耗/工艺/实际成本 | — | — | **下游 Owner**(非 Order) | Order 是锚非神对象 ✅ |

**结论**：核心商业字段（量/价/期）= **三个不同事实（quoted/ordered/confirmed），非重复拥有/维护** ✅。**两处边界要修**：客户(字符串→id)、款(Owner 不清)。

---

## 第三部分 — Data Flow Review（录一次/重录/复制/引用/继承/派生）

| 数据 | 应是 | 现状 |
|---|---|---|
| 客户 | 录一次(customers)，全链引用 | 🔴 Quote 仍字符串(伪重录) |
| 款/色/码/单耗 | Quote(或 Product)录一次，向下引用 | 🟡 款 Owner 待定 |
| 客户成交值 | PO OCR 一次 | ✅ 设计如此 |
| 公司承诺 | Order **继承** Confirmed PO | 🔴 现 createOrder 仍预填重打(未接线) |
| 大货单耗/采购/工艺/实际成本 | 各下游 Owner，挂 order_id | ✅ |
| PO Compare / Profit / 交付健康 / 看板 | **Derived** | ✅ |

> **复制 vs 继承的宪法澄清（CTO 视角）**：Order 继承 Confirmed PO **不违反 Constitution 02**——因为 Order.qty 是**新事实(公司承诺)**，来源于 PO 但**由 Order 拥有**；PO.qty 冻结为客户主张、不再维护。**无双维护** = 不是禁止的"复制维护"，是"继承成新真相"。改单时 Order 可独立变（受 Lock），PO 不动。✅
> **真正残余的"重录"= 未接线**：origin_quote_id / customer_id / PO→Order 继承——**今天仍重打**，接线后归零。

---

## 第四部分 — Header/Line Review + 血缘真伪（🔴 最重要的发现）

**Header/Line 结构一致性** ✅：三对象都 Header + Line（line_no/款/色/码/量/价），结构对齐。

**🔴 发现1（我在 Order 蓝图过度声称，必须更正）**：我曾写"Quote Line → PO Line → Order Line **三层 1:1 血缘**"。**这是错的。**
- **Quote Line ↔ PO Line：不是 1:1。** 客户 PO 是**客户的文件**，它的行结构按**客户**的写法（可能合并多款一行、或拆分），**不保证对齐我方 Quote 行**。
- **正确血缘**：
```
Quote Line  ──M:N 映射(PO Compare 时人工/AI 映射)──►  PO Line  ──1:1 继承──►  Order Line
```
- **闭合规则**：Quote↔PO 是**映射关系**（PO Compare 阶段建立：每条客户 PO 行映射到一/多条 Quote 行；记录映射）；只有 **PO Line → Order Line 是 1:1 继承**。追溯仍成立（PO 行记其映射的 Quote 行；Order 行记其 PO 行）。
> 这是集成审计最有价值的一抓——若不修，开发会做错"自动 1:1 继承"，导致客户合并行/拆行时**数据错位**。

---

## 第五部分 — Timeline / State Machine Review

| | Quote | Customer PO | Order |
|---|---|---|---|
| 状态机 | Draft→Reviewing→Approved→Sent→Negotiating→Accepted→Converted(+Expired/Lost) | Received→…→Resolution→Approval→Confirmed→Convert→Archived(+Hold/Cancel/Partial) | Created→Confirmed→…(18关卡)→Closed(+Amend/Delay/Term) |
| **PATTERN** | Draft→Review→Approve→Active→Terminal | 同 | 同 |

**判定**：状态机**不应统一成一个**（不同对象不同阶段，正确）；但 **PATTERN 一致**（草稿→复核→审批→激活→终态）✅。
**🟡 发现4**：**状态词汇不统一**（Approved/Confirmed/Converted/Accepted 混用）。**闭合规则**：标准化共用词汇——每个商业对象遵循 `Draft → Reviewing → Approved → Active → Terminal{Won/Closed | Lost/Cancelled/Expired}`，对象特有中间态可加。降认知负荷（黄金模板补充）。Timeline 三对象**各自独立**（Quote=报价响应、PO=接单、Order=18关卡），**正确不该合并**。

---

## 第六部分 — Approval Review

三对象**都差异驱动** ✅（无差异快路径）。
**🟡 发现5（COO 视角：减重复审批）**：价格可能被审两次——Quote 审 margin、PO 审"客户改价差"。
- **闭合规则（价格地板协同）**：**Quote Approval 时设一个价格地板/最低毛利**；客户 PO 价 **≥ 地板 → PO 阶段不重审（自动过）**；**< 地板 → 才走 PO 财务审批**。**消除重复审批**，业务更省事（过门禁①）。
其余无重复（PO 审"客户主张差异"、Order 审"改单/延期"——不同决策）。

---

## 第七部分 — AI / Agent Review

| Agent | 职责 | 阶段 | 越权? |
|---|---|---|---|
| Quote Agent | 成本/毛利/成交概率 | 报价时 | 无 |
| PO Agent | 完整性/Compare/风险/Business Impact | PO 复核~确认时 | 无 |
| Order Agent | 交付置信度/料齐/延期 | 成单后 | 无 |

- **职责清晰**：各守一对象、各在不同生命周期阶段 ✅。**无 AI 越权**（三个都"只建议不确认"）✅。
- **🟡 发现（轻）**：PO 的 Business Impact（毛利/交付/物料影响预演）与 Order Agent（交付健康）、Quote Agent（毛利）**底层分析重叠**。**闭合规则**：margin/delivery/material 这些**分析能力应共享**（同一对象 KPI 引擎），各 Agent 在各自阶段**调用**，**不三处各实现一遍**（防"三套毛利算法"漂移）。
- **遗漏**：Inquiry/Sample 无 Agent（上游，已知，非本次三对象问题）。

---

## 第八部分 — Developer Review（开发一定会回来问的地方）

| # | 开发会问 | 闭合状态 |
|---|---|---|
| 1 | Quote 行怎么映射到客户 PO 行？ | ✅ 本 Review 发现1 给了映射规则 |
| 2 | 款 Owner 是 Quote 还是 Product？ | ✅ 发现2 规则：Product 拥有,Quote 捕获新款赢单晋升 |
| 3 | Quote 客户何时连 customer_id？ | ✅ 发现3：必须连,字符串仅显示 |
| 4 | 各对象状态枚举到底叫什么？ | ✅ 发现4 标准化词汇 |
| 5 | 价格审批会不会审两次？ | ✅ 发现5 地板协同 |
| 6 | PO→Order 到底继承哪些字段、改单如何分叉？ | 🟡 须列**继承字段清单** + Amendment 分叉(PO V1.3 Lock 已覆盖,落地列清单) |
| 7 | 多币种/多交期一张单的 Header 汇总口径 | 🟡 PO V1.3 已标残余,落地定 |
| 8 | 一 PO 拆多 Order 的映射机制 | 🟡 PO V1.3 §3 已设,落地列字段 |
> 1-5 本 Review 已闭合；6-8 是落地清单项（非设计缺陷，规则已在，须列字段表）。

---

## 第九部分 — Five Centers Review（职责清晰/越权/重复）

| 中心 | 拥有(这三对象) | 越权? 重复? |
|---|---|---|
| 业务开发 | **Quote**（+客户/询盘） | 无 |
| 订单执行(Hub) | **Customer PO + Order** | 无 |
| 采购/生产/财务 | 只引用 Order(挂 order_id) | 无（⚠️ 旧 procurement.ts 让 finance 写采购=既有越权,与这三对象无关,待收紧） |

**判定**：就 Quote/PO/Order 而言，**Owner 清晰、无越权、无重复**（无中心拥有两个真相）✅。Quote→PO 的交接（业务开发出 Quote、订单执行收客户 PO 引用之）干净。

---

## 第十部分 — 最终 Review（诚实裁决）

**Quote+PO+Order 是否已形成 QIMO OS 商业数据链？**

| 目标 | 设计层 | 说明 |
|---|---|---|
| 单一 Owner | ✅ | 每对象一 Owner，无重叠 |
| 单一 Truth | ✅(闭合后) | 量/价/期=三事实非重复；修客户(id)+款(Owner)后无边界不清 |
| 单一生命周期 | ✅ | 各自独立、PATTERN 一致；词汇待标准化(发现4) |
| 真正一次录入 | ✅设计 / 🔴未接线 | 设计零重录；**今天仍重打（origin_quote_id/customer_id/继承未接线）** |
| 真正零重复 | ✅(闭合后) | 发现1-3 修后 |
| 真正数据共享 | ✅ | 挂 order_id 物理共享 |

**6 个集成缺口及闭合：**
1. **Quote↔PO 行非 1:1**（我曾过度声称）→ **映射关系**；只 PO→Order 1:1 继承。✅闭合
2. **款 Owner 不清** → Product 拥有、Quote 捕获新款、赢单晋升。✅闭合
3. **Quote 客户字符串** → 必须连 customer_id。✅闭合
4. **状态词汇不统一** → 标准化 `Draft→Reviewing→Approved→Active→Terminal`。✅闭合
5. **价格双重审批** → Quote 设地板，PO 价≥地板自动过。✅闭合
6. **Sample 在理想链但非对象** → 确认保持里程碑级（不新增对象）。✅闭合

> 6 个全是**规格澄清（规则即可闭合），无一需要重设计对象或生命周期。**

---

## ✅ 裁决：闭合 6 项后，商业链可正式封板

**Quote + Customer PO + Order 在设计层已形成自洽的 QIMO OS 商业数据链**：单一 Owner、单一 Truth、各有生命周期/Timeline/AI Guardian、全下游挂 order_id、AI 全程只守护不确认。**前述 6 个集成缺口已用规则闭合（写入本 Review，作为三蓝图的集成补充条款）。**

> **商业链正式 Design Freeze（含本 Review 的 6 项闭合规则）。以后进入开发阶段，不再讨论商业链产品设计。**
>
> **进入开发的"最后一公里"= 接线（非设计）**：① origin_quote_id / customer_id 连接 ② Confirmed PO → Order 100% 继承（列继承字段清单）③ Quote↔PO 行映射 ④ 价格地板协同。这 4 件是**实现接线**，落地阶段处理。
>
> 本文 = 集成审计 + 闭合规则。不写代码 / DB / migration / UI。
</content>

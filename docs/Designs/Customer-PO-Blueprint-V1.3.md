# Customer PO Blueprint V1.3 — Final / Gold Standard（唯一设计文档 · Design Freeze 候选）

> **Date**: 2026-06-30 · Customer PO **最后一次产品设计**。覆盖外贸服装 ~95% 真实场景。
> **不写代码 / DB / migration / UI / 不谈架构 · 不扩展其它对象。** 升级自 V1.2，**全部哲学不变、不推翻**。
> **🚦 两问门禁**：每个新增须同时①减每天工作量 ②强数据链，否则不加。本版每项已过（见 §12）。

---

## 0. 锁定哲学（不可改）
Customer PO = **Customer Truth（客户主张）** ⟂ Order = **Company Truth（公司承诺）** · PO Compare = **Derived** · 文件 = **Evidence** · **AI Never Confirms Truth** · One Object One Owner · Order Center = Operation Hub。

## A. 对象模型（V1.2 锁定 + 显式 Version）
```
Customer PO  =  Header  +  Lines[]  +  Versions[]      （都是 PO 聚合内子对象，非新企业对象）
 Header: PO号/客户(引用)/币种/付款/Incoterm/总交期/唛头/备注/Quote(引用)/文件(Evidence,冻结)
 Line:   line_no/Style/Color/Size/Qty/UnitPrice/Currency/行交期/包装/吊牌/装箱/备注/附件/Status
 Version: v1/v2/v3 … 每版=一次客户修订(见 §1)
```
生命周期（V1.2 锁定）：`Received→AI Parsing→Human Review→PO Compare→Resolution→Approval→Confirmed→Generate Order Draft→Converted→Archived`（+ Hold/退回、Rejected、🆕 Partially Confirmed、🆕 Cancelled）。
Resolution（V1.2 锁定）：每差异一 Resolution，`Open→Proposed→(Approved/Rejected)→Applied`；🔴 未 Applied 不能 Confirm。
Acceptance（V1.2 锁定）：8 项 checklist 全 ✓ 才 Confirmed。

---

# 本次：10 个真实业务场景

## 1. Customer Revision PO（客户改版 · 最关键）

> Customer PO 天然**多版本**：PO V1 → V2 → V3。每版是同一个 PO 对象的一个 **Version**（非新对象），各自挂自己的客户文件(Evidence)。

| 机制 | 设计 |
|---|---|
| **Revision Version** | PO 持 version 链；当前生效版=latest；历史版冻结只读 |
| **Revision Timeline** | 每次改版记 Who/When/客户文件/变更摘要（并入 §7 Timeline） |
| **Revision Compare** | 新版 vs 上一版**逐行逐字段** diff（不是从零比对，只看"这次改了什么"） |
| **哪些字段变了** | Revision Compare 直接列出变更字段（如 Line3.Qty 1000→1200） |
| **哪些 Resolution 重确认** | **只有变更字段的 Resolution 重置为 Open**；未变字段的 Resolution **保留**（不重做） |
| **哪些 Approval 重走** | **只有变更的 🔴 字段重走对应审批**；其余审批保留 |
| **哪些 Order Draft 自动更新** | 若 PO 未 Converted：Order Draft 整体重生成。若已 Converted：**未锁定字段**的 Order 值**生成更新草稿**(人工确认)，§7 Lock Rules 决定 |
| **哪些已锁定不能更新** | 已进入采购/生产的字段（见 §7）→ 改版**不能自动改 Order**，标"需人工变更处理/可能不接受" |

> **关键**：改版只重做"变了的那部分"，不推翻整单。**两问**：①减工作量✅（不重核全单）②数据链✅（版本可追、变更可审）。

---

## 2. Partial Confirmation（部分确认）

> 真实：10 行不一定一次全确认。**逐行确认**：确认 8 行、Hold 2 行。

| 机制 | 设计 |
|---|---|
| PO Line.Status | confirmed / held / rejected（行级） |
| PO Header.Status | 由行派生：全确认=Confirmed；部分=**Partially Confirmed**；全 hold=Reviewing |
| **Order Draft 继承** | **只继承 Confirmed Lines**；Held Lines **不进** Order |
| Held Lines 去向 | **继续停留在 Customer PO**（held），待后续确认 → 追加进同 Order 或新建 Order |
| 退出条件 | 所有行 confirmed→converted 或 rejected → PO 才 Archived |

> **两问**：①减工作量✅（不为 2 行卡住 8 行）②数据链✅（行级状态精确，无含糊）。

---

## 3. Split Order（一 PO 拆多单）

> 一个 Customer PO 因 **工厂/交期/船期/国家不同** 拆成多个 Order。

```
Customer PO (Lines 1-10)
   ├─ Order A ← Lines {1,2,3}  (工厂甲, 7月船)
   ├─ Order B ← Lines {4,5,6}  (工厂乙, 8月船)
   └─ Order C ← Lines {7..10}  (美国仓)
```
| 机制 | 设计 |
|---|---|
| **Split Mapping** | Convert 时**人工把 PO Lines 分组 → 各 Order**（AI 可建议分组，人工定） |
| 行血缘 | 仍 **1:1**：每条 Order Line ← 一条 PO Line（不破坏继承） |
| Order 追溯来源 | 每个 Order 记 source_po + source_po_version；每 Order Line 记 source_po_line |
| PO 状态 | 全部行 Converted 后 PO→Archived |

> **两问**：①减工作量✅（一次 PO 解析→多单分组，零重录）②数据链✅（多单仍可回溯到同一 PO 的具体行）。

---

## 4. Merge PO（克制纠偏：**不在 PO/Order 层合并**）

> 两个客户 PO 想"一起生产"。**判断：不允许把两个 PO 合并成一张 Order。**

**为什么不合并：** 两个 PO = 两份独立的客户承诺。合成一张 Order 会：丢失"一 PO 一承诺"的清晰、破坏 1:1 追溯、一方改/取消时无法干净拆开、审批与利润口径混乱。

**正确做法（合并下沉）：**
| 层 | 怎么"一起" |
|---|---|
| PO/Order 层 | **各自独立成单**（PO1→Order1，PO2→Order2），互不合并 |
| **采购层** | **同布同色合并采购**（Material Agent 跨单汇总——本就存在）|
| **生产层** | 排产时合并投产（同款/同工厂）|

> 即"一起生产"发生在**物料/生产层的派生汇总**，不在客户承诺层。**两问**：①减工作量✅（采购/生产该合的照合）②数据链✅（PO→Order 追溯不被污染）。**满足业务诉求，又不牺牲追溯——这是克制的胜利。**

---

## 5. PO Cancellation（按阶段）

| 取消时机 | 生命周期处置 |
|---|---|
| **未 Confirm** | PO → **Cancelled**（干净，无下游）|
| **已 Confirm 未 Converted** | PO → Cancelled + 丢弃 Order Draft |
| **已 Converted 未采购** | **Order 终止**（现有 `orders.termination_type/reason/approved_by`）+ PO Cancelled |
| **已采购** | 商业问题：Order 终止 + **物料损失/退料对账**；PO Cancelled 但**成本/责任留痕** |
| **已生产** | 一般**不接受取消** → 转**索赔/库存处理**；PO 不能简单 Cancel，进争议处置 |
| **已出货** | 不可取消 → **退货/索赔**流程（出 Customer 事项）|

> 取消**联动 Order 终止**（用既有字段），各阶段责任与成本可追。**两问**：①减工作量✅（每阶段有明确处置，不临时拍）②数据链✅（取消与损失留痕）。

---

## 6. Customer Change Impact（AI 分析六维，永不自改）

客户改 **数量/颜色/价格/交期/包装** → Business Impact Engine 自动预演（派生只读）：

| 影响维度 | AI 分析 |
|---|---|
| **Material Impact** | 缺口/多余/同布同色/MOQ/补货 |
| **Production Impact** | 排产/产能/工艺 |
| **Delivery Impact** | 交期可行性/交付风险 |
| **Financial Impact** | 利润/成本/加工费 |
| **Supplier Impact** | 已下采购是否要改/供应商交付 |
| **Order Impact** | 哪些 Order 字段受影响/是否锁定 |

> AI **只分析、绝不自动修改任何对象**（Constitution 06）。

---

## 7. Lock Rules Matrix（字段锁定规则）

| 字段类 | Received~Review | Confirmed | 已采购 | 已生产 | 已出货 |
|---|---|---|---|---|---|
| PO Number / 原始文件 / 提取快照 / 行血缘 | 🔒 永不可改 | 🔒 | 🔒 | 🔒 | 🔒 |
| 提取值（核对中） | ✏️ 可改 | — | — | — | — |
| **价/币种/付款** | ✏️ | 改需**重审批(finance)** | 🔁 重审批+成本影响 | 🔒 锁 | 🔒 |
| **数量** | ✏️ | 重审批(采购+财务) | 🔁 涉退/补料 | 🔒 | 🔒 |
| **交期** | ✏️ | 重审批(生产) | 🔁 重排产 | 🔁 紧急评估 | 🔒 |
| **款/色/码** | ✏️ | 重审批(跟单) | 🔒 料已定锁 | 🔒 | 🔒 |
| 包装/唛头/装箱 | ✏️ | 业务改 | ✏️ 改包装料 | 🔁 | 🔒 |
| 公司内部字段(厂/优先级/负责人) | — | ✏️ 始终可改 | ✏️ | ✏️ | ✏️ |

图例：✏️ 可改 · 🔁 改后须重新 Approval/重算 · 🔒 锁定不可改。
> **两问**：①减工作量✅（什么能改一目了然，不反复试错）②数据链✅（防止下游已动后乱改上游，保完整性）。

---

## 8. Traceability（全血缘，追到客户原始 PDF）

> 任何一个 **Order / Order Line** 都能逐级回溯：
```
Order Line
 → source_po_line (哪一行)
 → source_po + source_po_version (哪个 PO 的哪一版)
 → Resolution (该字段如何 resolve 的 · 确认值)
 → Approval (谁批的 · 何时 · 为何)
 → Attachment / Evidence (该行附件)
 → 客户原始 PO 文件 (PDF, 冻结)
```
| 保证 | 机制 |
|---|---|
| 每一跳都有引用 | 全链 id 引用，非复制 |
| 终点冻结 | 原始 PDF + 提取快照不可改 |
| 改版可追 | source_po_version 指向具体版本 |

> **两问**：①减工作量✅（出问题秒查来源，不翻聊天/邮件）②数据链✅（端到端可审计=数据完整性的终极证明）。

---

## 9. Customer PO Dashboard（全派生统计，Derived-Never-Stored）

| 统计 | 含义 |
|---|---|
| Today's PO | 今日新到 PO 数 |
| Pending Parsing / Review / Resolution / Approval | 各阶段积压（暴露瓶颈）|
| Ready To Convert | 已 Confirmed 待建单 |
| Overdue | 超时未处理（接 Action Center）|
| Average Confirm Time | 平均"收到→Confirmed"时长（接单效率 KPI）|
| AI Accuracy | OCR/提取准确率（来自人工核对纠正率，反哺训练）|
| Revision Count | 改版次数（高=客户/报价不稳信号）|

> 全部**派生只读**，不另存统计表（守 Derived-Never-Stored）。

---

## 10. Action Center（V1.2 锁定 · 重申）
状态概览 + Next Recommended Action（AI 建议）+ 按钮（Resolve/Approve/Reject/Generate Order Draft/Return）；**AI 只建议，人工执行**。

---

## 11. Developer Lock Checklist（开发前完整性确认）

| 组件 | 是否完整 | 依据 |
|---|---|---|
| ☑ Object（Header+Line+Version 聚合，子对象非新企业对象） | ✅ | §A/§1 |
| ☑ Lifecycle（含 Partial/Revision/Split/Cancel/Hold 分支） | ✅ | §0/§1-5 |
| ☑ State Machine（每态进入/退出/Owner/确认点） | ✅ | V1.2 §2 + 分支 |
| ☑ Line Object（字段 + 行血缘 1:1） | ✅ | §A |
| ☑ Resolution（对象/生命周期/审计/与审批关系） | ✅ | V1.2 §2 |
| ☑ Approval（差异驱动 + 字段分级） | ✅ | V1.2 §3 |
| ☑ Timeline（Who/When/Duration/AI/Evidence + 改版） | ✅ | §7记录 + V1.2 |
| ☑ Acceptance（8 项 checklist 硬闸） | ✅ | V1.2 §9 |
| ☑ Permissions（Owner/只读/引用/不可改 + Lock Matrix） | ✅ | §7 + V1.2 |
| ☑ Action Center（状态+建议+按钮，AI 不自动） | ✅ | §10 |
| ☑ Dashboard（9 项派生统计） | ✅ | §9 |
| ☑ Traceability（全血缘到 PDF） | ✅ | §8 |

> **12 组件全 ✅ → 设计完整，开发者可直接实现。**

---

# 《Customer PO V1.3 Final Review》

**Q1：是否足够支持未来 5 年绮陌服饰真实业务？**
✅ **是。** 覆盖：多版本改版、部分确认、拆单、合并(下沉)、各阶段取消、客户改单六维影响、字段锁定、全血缘、运营看板——这些是外贸服装接单的**主体真实场景（~95%）**。对象模型（Header+Line+Version+Resolution+lineage）+ 生命周期（含全部分支）+ Lock Rules 已自洽闭环。

**Q2：哪些地方以后必须改数据库？**
**无"必须推翻"项；仅有"纯加列"的演进（合宪 Evolution）：**
- 客户要求若出现全新品类（如新增某种唛头规则）→ **加字段**，非改结构。
- 多币种/多交期混一单的 Header 汇总口径 → 实现策略，**加派生计算**，非改对象。
- `origin_quote_id` 接线 → 既定要做，**加引用**，非改结构。
> 这些都是 ADD COLUMN 级，**不会推翻表**。

**Q3：哪些地方以后必须推翻生命周期？**
**无。** 主体分支（Revision/Partial/Split/Cancel/Hold）已纳入。残余的极端流（如出货后反复改单）走"索赔/退货/Customer 事项"既有出口，不需新增 PO 状态机。
> 唯一**业务政策待你拍**（不是技术风险）：**Merge PO 是否永久"下沉到采购/生产"**（我强烈建议是）。若将来坚持"PO 层合并"，是加一个映射、非推翻——但会牺牲追溯，**不建议**。

**Q4：诚实残余项（实现前拍板，非冻结障碍）**
1. Merge PO 政策确认（建议下沉）。
2. 多币种/多交期 Header 汇总口径。
3. `origin_quote_id` 接线随 PO 一起落地。
> 三项均为**政策/实现细节**，**不影响对象与生命周期的冻结**。

---

## ✅ Customer PO Blueprint 正式封板（Design Freeze）

**对象、生命周期、真相边界、Resolution、Approval、Timeline、Acceptance、Lock Rules、Traceability、Dashboard 全部闭环；无可预见的数据库推翻、无可预见的生命周期推翻。** Customer PO 成为 QIMO OS 第一个 Production-Ready Business Object，并为后续所有对象立下**黄金模板 12 模式**（Header+Line · 真相边界 · Evidence vs Truth · Lifecycle · Difference→Resolution→Audit · 差异驱动 Approval · Draft 100% 继承 · Timeline · Action Center · Acceptance Checklist · Object Agent · Health KPI）。

> **以后进入开发阶段，不再讨论 Customer PO 产品设计。** 开发须守两红线：**Order 草稿从 Confirmed PO 100% 继承（不重打）· 原始文件与提取快照冻结**。落地前拍板上面 3 个残余政策项。
>
> 本文 = 设计封板稿。不写代码 / DB / migration / UI。
</content>

# Quote — Implementation Plan（实现计划 · 待批准后编码）

> **Date**: 2026-06-30 · **不写代码 / 不写 migration / 不执行 SQL / 不提交。** 仅实现计划，等批准。
> **强制遵守**：`Quote-Blueprint-V1.0` + `Business-Chain-Contract-V1.0`。**不得为实现方便改产品设计。**
> **目标**：Quote 成为 **Customer PO Compare 的可靠基线**——支持 Header + Line + Version + customer_id 接线，明确"如何被 Customer PO 引用"。
> **核心现实**：`quoter_quotes`（单款）+ 5 训练表 + RAG 成本引擎 + actions/页面**已在生产** → **Evolution not Rewrite**：演进为多款，不推倒、不破坏现有报价。
> **顺序锁定**：Quote → Customer PO → PO Compare → Resolution → Order Draft → Order。Customer PO migration 暂缓（依赖本 Quote 结构定稿）。

---

## 0. 链路核心设计（先讲清，决定一切）

**Quote 如何成为 PO Compare 的可靠基线：**
1. **Approved Version 冻结**：Quote 一旦 Approved，该版 Header+Lines 写入**不可变快照**（`quote_version_snapshot`）。
2. **Customer PO 引用**：`customer_po.origin_quote_id` → 指向 **Quote Header + 具体 Approved Version**；`customer_po_line` 经映射表指向 **`quote_line.id`**（M:N，Contract 一）。
3. **PO Compare 读冻结版**：比对的是"**客户接受的那一版**"，**不是最新草稿** → 即使后续 re-quote 出新版，已成交 PO 的比对基线**不被动改**（同 Material Snapshot/Definition 思路）。

> 没有"冻结版"，PO Compare 就不可靠。这是本计划第一优先。

---

## 1. 文件清单（Evolution：改现有 quoter + 新增）

**Migration（下一步，本计划不做）**
- 演进 `quoter_quotes`（加 `validity_date / margin_target / price_floor / version`；**保留现有列向后兼容**）。
- 新增 `quote_line`（多款行）· `quote_version_snapshot`（冻结版）。
- **回填**：现有每条 `quoter_quotes` → 1 条 `quote_line`（单款→Header+1Line，不丢数据）。

**Server Actions（演进 `app/actions/quoter.ts`，不破坏现有签名优先加新）**
- 演进：`saveQuote`（Header+Lines）· `previewQuote`（逐行成本）。
- 新增：`linkCustomer`（接 customer_id）· `addLine/updateLine` · `createVersion`（re-quote）· `submitForApproval/approveQuote`（设 price_floor）· `sendQuote` · `markExpired` · `markWonLost`。
- **链路关键**：`getApprovedQuoteForCompare(quoteId)` → 返回**冻结 Approved 版** Header+Lines，供 Customer PO Compare 调用。

**lib（保留成本引擎，新增）**
- 保留：`lib/quoter/{api,fabric/*,cmt/*,trim/*}`（RAG 成本=Quote Agent，已真执行）。
- 新增：`lib/quoter/{lines,version,acceptance,floor}.ts`（多行/版本/Acceptance/地板逻辑，纯函数）。

**页面（演进 `app/quoter/*`）**
- `app/quoter/new`：单款表单 → **多款行表单**（Header + Lines）。
- `app/quoter/[id]`：加 **Version 历史 / Approval / Timeline / Acceptance 状态**。
- `app/quoter`：列表加 Quote Health/有效期/版本数。

**测试**：`scripts/test-quote.ts`（tsx）。

---

## 2. 数据流（生命周期 → 表/动作）

```
Inquiry   parseInquiryFile(已有) → 草稿
Draft     saveQuote → quoter_quotes(Header,version1) + quote_line[] ; linkCustomer→customer_id
Reviewing previewQuote/RAG → 逐行成本/单耗/CMT(AI) ; 人工核
Approved  submitForApproval→approveQuote → 设 price_floor + **冻结 version 快照** (人工)
Sent      sendQuote → exportQuoteSheet(已有) 发客户(人工)
Negotiating 客户还价 → Resolution(让价/hold) → createVersion(re-quote, 新冻结版)
Accepted(Won) markWon → 等客户下 PO
被引用     Customer PO.origin_quote_id + line map → getApprovedQuoteForCompare(冻结版)
分支: Expired(过有效期) / Lost / Abandoned
```

---

## 3. API / Server Actions（契约约束）

| Action | 输入 | 输出 | 契约红线 |
|---|---|---|---|
| `saveQuote(header, lines[])` | Header+Lines | quote_id | **customer_id 必填**(引用,非字符串) |
| `previewQuote/RAG` | 行 | 成本草稿 | AI 只估算，**不确认** |
| `createVersion(id, reason)` | re-quote | version+1 | 旧版冻结不可改 |
| `approveQuote(id, floor)` | 价格地板 | Approved + **冻结快照** | 毛利<底线须 CAN_APPROVE_PRICE |
| `sendQuote(id)` | — | Sent | **人工发**，AI 不自动发 |
| `getApprovedQuoteForCompare(id)` | quote_id | 冻结版 Header+Lines | **PO Compare 的唯一基线源** |
| `markWon/Lost/Expired` | — | 终态 | — |

> 全 server action：`createClient()` + `getUserRoles` 门控；成本/价受 `CAN_SEE_FINANCIALS`。**AI MUST NOT 确认/发送/审批。**

---

## 4. 页面（演进，不重做）
`app/quoter/new`：Header（客户选择器→customer_id / 币种 / 有效期 / margin 目标）+ **多行 Lines**（每行款/色/码/量/面料/单耗(AI)/CMT/成本/报价）。
`app/quoter/[id]`：Header + Lines + **Version 历史(冻结版只读)** + Approval(地板) + Timeline + Acceptance 状态 + Action Center（Submit/Approve/Send/Re-quote/Mark Lost；AI 不自动点）。
`app/quoter`：列表 + Quote Health（毛利质量/有效期临近/成交率/版本数，**派生**）。

---

## 5. 权限（真实角色 + 差异驱动）

| 动作 | 谁 |
|---|---|
| 建/改/发报价 | 业务（sales/admin） |
| 看成本/margin | CAN_SEE_FINANCIALS(admin/finance/sales) |
| **毛利<地板审批** | CAN_APPROVE_PRICE(sales_manager/admin) + finance |
| 标准毛利标准条款 | 业务自定（快路径，无审批） |
| 只读 | 全员（采购看款不看 margin） |
> 价格地板：Approved 时设；客户 PO 价≥地板→PO 阶段自动过（消重复审批，Contract 六）。

---

## 6. AI（Contract 七）

| MAY | NEVER |
|---|---|
| 单耗/CMT 估算(RAG) · 报价草稿 · 毛利分析 · 成交概率 · 成本异常 · 询盘解析 | 确认报价 · 发客户 · 审批毛利 · 建 PO/Order · 改成本真相 |
> 复用现有 RAG 成本引擎（= Quote Agent，已真执行）+ `parseInquiryFile`。AI 输出 MUST 草稿/派生。

---

## 7. 测试（`scripts/test-quote.ts`，tsx）

- 单元：成本计算(fabric/CMT) · 多行汇总 · **版本冻结**(Approved 后快照不可改) · 地板逻辑 · Acceptance 闸门 · customer_id 必填校验。
- **红线断言**：① AI 路径绝不写 Approved/Sent ② 冻结版快照不可改 ③ `getApprovedQuoteForCompare` 返回的是冻结版非最新草稿 ④ 毛利<地板未审批时 approveQuote 被拒。
- 闸门：`npm run build && npm run check` 必过；diff 审；每子阶段停、批准再继续。

---

## 8. Migration（描述，本计划不做；批准后出正式草案走门禁）

| 动作 | 内容 |
|---|---|
| 演进 `quoter_quotes`(Header) | + `validity_date / margin_target / price_floor / version`；保留现有列 |
| 新增 `quote_line` | id · **quote_id(FK)** · line_no · style/product_variant_id · color · sizes · quantity · 面料spec · fabric_consumption · cmt(factory/ops/cost) · trim/packing/logistics · total_cost · margin_rate · **quoted_price** · status |
| 新增 `quote_version_snapshot` | quote_id · version · **snapshot(jsonb,冻结)** · reason · created_at（不可改） |
| **回填** | 现有每条 quoter_quotes → 1 条 quote_line（单款→Header+1Line，零丢失） |
| customer_id | 列已在(phase0a)，**接线**（建单连 customers，customer_name 转显示） |
| RLS | 新表启用；沿用 quoter 现有策略口径 |
> **Evolution 铁律**：不破坏现有 `quoter_quotes` 与 `/quoter` 页面；回填幂等；门禁逐条验证 PASS 才编码。残余政策（多币种/多交期）→ **Line 为准、Header 汇总展示**（schema 不锁，Header 不强约束币种一致）。

---

## 9. 开发顺序（Quote 内部 · 每子阶段 build/check/review/diff → 停 → 批准）

| # | 子阶段 | 产出 |
|---|---|---|
| **0** | Migration 定稿（演进+2新表+回填）→ 你执行 → 门禁 PASS → 归档 | 表就绪、现有数据回填 |
| **1** | customer_id 接线 + Header/Line 重构（saveQuote 多行；现有页面不破） | Quote 多款可建、连客户 |
| **2** | Version + Approval(price_floor) + **冻结快照** | 可审批、可 re-quote、有冻结基线 |
| **3** | **`getApprovedQuoteForCompare`**（链路基线源）+ Acceptance + Sent/Negotiating | **PO Compare 可靠基线就绪** |
| **4** | 页面演进（多行表单 + 版本/审批/Timeline/Health） | 业务可用 |
| **5** | 测试齐 + build+check + diff | 可归档 |

> 子阶段 3 是**交付给 Customer PO 的接口**——Quote 完成后，Customer PO 才有可靠 Compare 基线。**整个 Quote 完成、批准后，再进入 Customer PO。**

---

## 链路三问（你的特别要求，逐个答）
1. **customer_id 接线**：列已在(phase0a)；`saveQuote` MUST 传 customer_id（客户选择器选 customers）；`customer_name` 降为显示字段。**单一客户真相 = customers。**
2. **Quote 如何被 Customer PO 引用**：`customer_po.origin_quote_id` → Quote Header；`customer_po_line_quote_map.quote_line_id` → `quote_line.id`（M:N）；PO Compare 调 `getApprovedQuoteForCompare` 取**冻结 Approved 版**。
3. **Header+Line+Version**：Header=deal 级(客户/币种/有效期/margin目标/地板/version)；Line=逐款成本+报价(可寻址 id,供 PO 映射)；Version=每次 re-quote 冻结快照，Approved 版=PO 基线。

> **本文 = Quote 实现计划。批准后才出 Migration 正式草案（演进+2新表+回填，走门禁）→ 再编码。不写代码 / 不写 migration / 不提交。**
</content>

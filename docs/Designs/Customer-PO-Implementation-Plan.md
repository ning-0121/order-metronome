# Customer PO — Implementation Plan（实现计划 · 待批准后编码）

> **Date**: 2026-06-30 · **不写代码 / 不执行 SQL / 不提交 / 不 push。** 仅输出实现计划，等批准。
> **强制遵守**：`Customer-PO-Blueprint-V1.3(Freeze)` + `Business-Chain-Contract-V1.0`。**不得为实现方便改产品设计。**
> **依赖**：PO Compare 需 Quote 作基线 → 入口半段(无依赖)先建，比对半段(需 Quote)后建。
> **现状**：Customer PO 是**全新对象**（QIMO 今天手工建单，无 PO 对象）→ 需新表 + 新 actions + 新页面。

---

## 1. 文件清单（全新增；不改现有 orders/quoter）

**Migration（先做，走数据库门禁）**
- `supabase/migrations/2026XXXX_customer_po.sql` — 5 张新表（见 §8）。

**Server Actions（QIMO 模式：`app/actions/*.ts`，session + 角色门控）**
- `app/actions/customer-po.ts` — uploadPO / parsePO / reviewLine / runCompare / resolveDifference / submitApproval / approveDifference / confirmPO / generateOrderDraft / createRevision / partialConfirm / cancelPO / getPO / listPO。

**AI lib（复用现有 Claude Vision 模式，类比 `quoter.ts::parseInquiryFile`）**
- `lib/customer-po/extract.ts` — OCR 提取 PO → 结构化草稿（置信度）。
- `lib/customer-po/compare.ts` — **派生** PO⟷Quote 逐字段差异（never stored）。
- `lib/customer-po/impact.ts` — Business Impact 派生预演（料/产/期/财/供/单）。
- `lib/customer-po/acceptance.ts` — 8 项 Acceptance Checklist 纯函数。
- `lib/customer-po/inherit.ts` — Confirmed PO → Order Draft 继承映射（纯函数）。
- `lib/customer-po/types.ts`。

**页面（App Router）**
- `app/customer-po/page.tsx` — 列表 + Dashboard。
- `app/customer-po/[id]/page.tsx` + 客户端组件 — 9 区工作台。

**测试（tsx，无框架）**
- `scripts/test-customer-po.ts` — compare/resolution 状态机/acceptance/继承映射/权限/**零自动确认**断言。

---

## 2. 数据流（生命周期 → 表/动作）

```
Received   uploadPO   → customer_po(status=received) + version1 快照 + 文件(Evidence,冻结)
AI Parsing parsePO    → lib/extract(Claude Vision) → customer_po_line[] (草稿+置信度) + timeline
Human Rev. reviewLine → 人工核对/补字段 → line.status=reviewed
PO Compare runCompare → lib/compare(PO⟷Quote) **派生**差异(不存) ; 需 quote_id 已关联
Resolution resolveDifference → customer_po_resolution(Open→Proposed) + 行映射(quote line)
Approval   approveDifference → 差异驱动(§5) → resolution.approval=Approved
Confirmed  confirmPO  → lib/acceptance 全✓闸门 → status=confirmed (人工)
OrderDraft generateOrderDraft → lib/inherit → Order 草稿 payload(交 Order 阶段建单)
Converted/Archived
分支: createRevision(改版,§Version) · partialConfirm(部分行) · cancelPO(分阶段)
```

---

## 3. API / Server Actions（契约约束）

| Action | 输入 | 输出 | 契约红线 |
|---|---|---|---|
| `uploadPO(file, customer_id, quote_id?)` | PO 文件 | customer_po_id | 文件=Evidence；customer/quote=引用 id |
| `parsePO(id)` | po_id | lines 草稿 | AI 只提取草稿，**不确认** |
| `reviewLine(lineId, patch)` | 修正值 | — | 改"确认中提取值"，**不覆盖原始快照** |
| `runCompare(id)` | po_id | **派生差异**(不入库) | Compare = Derived-Never-Stored |
| `resolveDifference(diff, choice, reason)` | 选项 | resolution | 每差异一 Resolution + 审计 |
| `approveDifference(resId, decision)` | — | — | 差异驱动；价≥Quote地板自动过 |
| `confirmPO(id)` | po_id | confirmed | **Acceptance 8 项全✓才允许**(硬闸) |
| `generateOrderDraft(id)` | po_id | Order Draft payload | 客户数据 100% 继承、**禁手打**；实际建单属 Order 阶段 |
| `createRevision(id, file)` | 改版文件 | version+1 | 只变更字段重 resolve/审批 |
| `partialConfirm(id, lineIds)` | 确认行 | — | Order 只继承 confirmed 行 |
| `cancelPO(id, stage)` | — | — | 按阶段处置(§PO V1.3) |

> 全部 server action：`createClient()` + `getUserRoles` 角色门控；写库走 session（RLS）或 service-role（AI 解析）。**AI 动作 MUST NOT 跨人工闸门。**

---

## 4. 页面（9 区工作台，只消费别中心数据）

`app/customer-po/[id]`：① PO Information ② Compare ③ Resolution ④ Business Impact ⑤ Production Impact ⑥ Material Impact ⑦ Approval Chain ⑧ Timeline ⑨ AI Analysis（同 Blueprint V1.3 §11）。
按钮：Resolve / Approve / Reject / Generate Order Draft / Return to Review（**AI 不自动点**）。
`app/customer-po`：列表 + Dashboard（今日 PO/各阶段积压/待建单/超时/平均确认时长/AI 准确率/改版数）——**全派生**。

---

## 5. 权限（真实角色 + 差异驱动）

| 动作 | 谁 | 依据 |
|---|---|---|
| upload/parse/review/resolve/confirm | 业务/订单执行（sales/merchandiser/admin） | 订单中心拥有 PO |
| 价/币种/付款 🔴 审批 | finance | CAN_SEE_FINANCIALS/CAN_APPROVE_PRICE |
| 交期 🔴 审批 | production_manager | CAN_APPROVE_DELAY |
| 数量 🔴 审批 | procurement + finance | — |
| 客户要求审批 | merchandiser | — |
| 只读 | 全员 | — |
| **不可改** | 原始文件 + 提取快照（任何人） | 冻结 |
> 无 🔴 差异 / 价≥Quote地板 → 业务快确认，**不触发审批**（Contract 六）。

---

## 6. AI（Contract 七，逐项）

| MAY | NEVER |
|---|---|
| OCR 提取 / Compare 差异 / Business Impact 预演 / Order Draft 草稿 / 下一步建议 | 确认 PO / 审批 / 建正式 Order / 改价量利润状态 / resolve 差异 / 发客户 |
> 复用现有 Claude Vision（`parseInquiryFile` 同款）；低置信高亮。AI 输出 MUST 是草稿/派生。

---

## 7. 测试（`scripts/test-customer-po.ts`，tsx）

- 单元：compare 逐字段+严重度 · resolution 状态机(Open→Proposed→Approved→Applied) · acceptance 8 项闸门 · 继承映射(Confirmed PO Line→Order Draft Line) · 价格地板协同 · 权限裁剪。
- **红线断言**：① AI 路径**绝不**写 confirmed/approved ② runCompare **零写库**(派生) ③ 原始快照不可改 ④ 🔴 差异未 Applied 时 confirmPO 被拒。
- 闸门：`npm run build && npm run check` 必须过；diff 审；**每子阶段停、批准再继续**。

---

## 8. Migration（草案 — 定稿后走数据库门禁，PASS 才编码）

> 5 张新表，纯加法；PO Compare/Impact/Dashboard **不建表**（派生）。

| 表 | 关键列 |
|---|---|
| `customer_po` | id · po_no · **customer_id(FK customers)** · **origin_quote_id(FK quoter_quotes,可空)** · inquiry_id(可空) · currency/payment_terms/incoterm/delivery_date · packing_req/shipping_mark/remarks · **status** · **version** · source_file(Evidence) · parsed_at/by · confirmed_at/by · created_by/at |
| `customer_po_line` | id · **customer_po_id(FK)** · line_no · style_no/customer_style_no · color · sizes(jsonb) · quantity · unit_price/currency · delivery_date · packing/label/carton_req · customer_remark · **status**(pending/resolved/confirmed/held) · extraction_snapshot(冻结) |
| `customer_po_line_quote_map` | **po_line_id(FK)** · **quote_line_id** · （**M:N 映射**，Compare 时建立） |
| `customer_po_resolution` | id · customer_po_id · po_line_id · field · customer_value · quote_value · severity · resolution_choice · confirmed_value · reason · resolved_by/at · approval_status/by |
| `customer_po_timeline` | id · customer_po_id · step · who · at · duration · comments · ai_summary · evidence_ref（append-only） |
| `customer_po_version_snapshot` | customer_po_id · version · snapshot(jsonb,冻结) · file_ref · created_at（不可改） |

- RLS：启用全表；service-role 写（解析）；session 读写（人工动作，角色门控）。
- **orders 加 `source_po`/`source_po_version` 引用列** → **留 Order 阶段**（继承接线时加），本阶段不动 orders。
- 门禁：建表后逐条验证 SQL 真返回 → PASS 才编码（同 0a/0b 纪律）。

---

## 9. 开发顺序（Customer PO 内部 · 每子阶段 build/check/review/diff → 停 → 批准）

| # | 子阶段 | 依赖 | 产出 |
|---|---|---|---|
| **0** | Migration 定稿 → 你执行 → 门禁 PASS → 归档 | — | 5 表 |
| **1** | 入口半段：types + upload + parse(Vision) + review + timeline + 生命周期(到 Parsed/NeedReview) | **无 Quote 依赖** | PO 能上传/解析/核对 |
| **2** | 比对半段：runCompare(派生) + Resolution + 行映射 + Approval(差异驱动) | **需 Quote 存在** | 差异可 resolve/审批 |
| **3** | 确认半段：Acceptance 闸门 + confirmPO + generateOrderDraft(继承映射,payload) | 1+2 | Confirmed + Order 草稿 |
| **4** | 页面：9 区工作台 + 列表 Dashboard | 1-3 | 业务可用 |
| **5** | 改版/部分确认/取消 分支 | 1-3 | 覆盖真实场景 |
| **6** | 测试齐 + build+check + diff | 全部 | 可归档 |

> **每子阶段完成：build + check + review + diff 全过 → 停 → 等批准 → 下一子阶段。** 整个 Customer PO 完成后再进入下一对象（Order）。

---

## ⚠️ 待你拍板（编码前）
1. **顺序**：按 Phase1（Quote 先）→ 则子阶段 2(比对)有 Quote 可依赖；若先做 Customer PO，则子阶段 1 先行、2 待 Quote。**你定先 Quote 还是先 Customer PO 入口半段。**
2. **Migration 5 表定稿**：是否照此 schema 出正式 migration 草案走门禁。
3. **3 个残余政策**（PO V1.3）：多币种/多交期 Header 汇总 · 拆/合单字段 · `origin_quote_id` 接线时机——可在子阶段中逐个落，但 schema 要先留位。

> **本文 = 实现计划。批准后才出 Migration 正式草案 + 编码。不写代码 / 不执行 SQL / 不提交 / 不 push。**
</content>

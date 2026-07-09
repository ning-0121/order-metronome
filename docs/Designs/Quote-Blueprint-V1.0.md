# Quote Blueprint V1.0 — Gold Standard Business Object（唯一设计文档）

> **Date**: 2026-06-30 · QIMO OS 第二个 Gold Standard 对象。严格遵循 `Customer-PO-Blueprint-V1.3` 的对象规范（12 模式）。
> **不写代码 / DB / migration / UI / 不谈架构·微服务 · 不扩展新中心。** 基于真实 `quoter_quotes`(+5 训练表) + RAG 成本引擎 + 审批角色。
> **🚦 总门禁（凌驾全文）**：Quote 服务于**整条数据链**，不服务报价模块本身。任何新增字段/流程/审批/页面必须同时 ①减业务员每天工作量 ②保证 **Quote→Customer PO→Order 数据 100% 无重录、可追溯、可继承**。**不能同时满足→拒绝。**
> **现状基线（诚实）**：现有 quoter 是**单款一报**、AI 成本引擎已在用(✅真执行)；本蓝图把它**泛化为 Header+Lines 多款** + Version + 接入链路，**非重做报价系统**。

---

## 1. Object Boundary（对象边界）
Quote = **我方报价提案对象**（属业务开发中心，**非新中心**）。聚合：**Header + Lines[] + Versions[] + Attachments[]**（皆 Quote 聚合内子对象，非新企业对象）。

## 2. Truth Boundary（最关键 · 三个不同事实，非双真相）

| | 拥有的真相 | 回答 |
|---|---|---|
| **Quote** | **我方报价主张**：成本构成 + 单耗/工序假设 + margin + **报价(quoted price)** + 有效期 + 报价条款 + 款式定义 | "我方愿以什么成本/价/条件提供" |
| **Customer PO** | 客户主张 | "客户要买什么"（已封板） |
| **Order** | 公司承诺 | "我方确认做什么"（已封板） |

- **Quote ⟂ Customer PO**：Quote 是**我方 offer**（先）；PO 是**客户 order**（后，客户接受报价后下 PO）。**PO 100% 引用 Quote**(quote_id) 作比对基线；客户 PO 的值可与报价不同 → PO Compare 抓差异。
- **Quote ⟂ Order**：Quote 是**成交前提案**；Order 是**PO 确认后承诺**。Quote 的成本 → 喂 **Profit forecast**；Quote 的 quoted_price 是"提案价"，Order 的 price 是"成交确认价"(resolve 后)。
- **唯一真相一句话**：Quote 拥有"**我方报价**"——款式定义 + 成本 + 报价 + 有效期。**款式/单耗在 Quote 录一次，向下引用；报价值是 Quote 的真相，PO/Order 的"成交值"是另一事实（不是重录）。**

## 3. Header + Line

**Quote Header**：quote_no · **客户(引用 customers.id)** · **来源 Inquiry(引用)** · season/brand · 币种 · 汇率 · **有效期 validity_date** · margin 目标 · status · version。
**Quote Line（逐款逐色）**：line_no · **款(引用 products 款库,无则本行捕获)** · 颜色 · garment_type · 尺码配比 · 数量 · 面料(类型/成分/幅宽/单价) · **单耗(AI RAG)** · CMT(工厂/工序/成本) · 辅料/包装/物流成本 · **total_cost_per_piece** · margin_rate · **quoted_price_per_piece** · 行 status。

> **为什么 Header+Line（过门禁）**：① 一个询盘常多款 → 一张多款报价，业务不必建 N 张单（减工作量）② 一张多款 PO **引用同一张多行 Quote**，款式/价基线逐行可比、向下逐行可继承（链 100% 可追溯）。**行血缘锚 = line_no**：`Quote Line → (PO 引用) → Order Line`。

## 4. Lifecycle

```
Draft → Reviewing → Approved → Sent → Negotiating →(Re-quote→新Version)→ Accepted(Won) → Converted(被 Customer PO 引用) → Archived
                                          ├──► Expired（过有效期）
                                          └──► Lost / Abandoned
```
映射真实 `quoter_quotes.status`(draft/sent/won/lost/abandoned)，本蓝图细化出 Reviewing/Approved/Negotiating/Expired。每态：进入/退出/Owner/AI/人工确认点（同 V1.3 规范）。**Approved（人工）、Sent（人工）、Accepted（客户）为关键转移。**

## 5. Evidence（证据 ≠ 真相）
成本来源单据(工价单/单耗记录,训练表) · 客户询盘文件 · **导出的报价单 PDF**。**文件永远是 Evidence，结构化成本/价才是真相**；发出去的报价单 PDF 版本**冻结**（对应某 Version）。

## 6. Timeline（属于 Quote）
`Draft→Reviewing→Approved→Sent→Negotiating→Accepted/Lost→Converted` 每步记 **Who/When/Duration/Comments/AI Summary/Evidence**。
> 属于 Quote 因为这是**报价响应过程**（接询盘到成交的运营故事）；它是报价效率/响应时长的审计真相（≠ Order 的 18 关卡）。**Duration 暴露"报价卡了几天/客户晾了几天"。**

## 7. Resolution（报价的"差异"= 谈判差异 + 成本/毛利缺口）

> Quote 不像 PO 比对上游；它的差异来自**客户还价**与**成本变动**。

| 差异来源 | Resolution 选项 | 效果 |
|---|---|---|
| **客户还价**（客户要 5.85，我报 5.95） | Hold Price / Re-quote(降价,新 Version) / Concede / Walk Away | 决定是否让价 |
| **成本变动**（面料涨价） | Re-quote / Absorb(吃成本保价) / Renegotiate | 更新成本与价 |
| **毛利低于底线** | 申请审批 / 调价 / 放弃 | 触发 Approval |

每个 Resolution 记 谁/何时/为何/审批结论；**每轮谈判 = 一个 Resolution + 一个新 Version**（可追"为何从 5.95 降到 5.85"）。
> **过门禁**：①让价决策一键记录、不靠记忆/口头 ②报价变更全程留痕、可追。

## 8. Approval（毛利驱动，不是每张都审 · 同 PO 的差异驱动哲学）

| 情形 | 审批 |
|---|---|
| 毛利 ≥ 底线 + 标准条款 | **业务自定**（快路径，零额外审批，护门禁①） |
| **毛利 < 底线** | → `CAN_APPROVE_PRICE`(sales_manager/admin) + finance |
| 战略客户特价 / 非标付款条款 | → 管理层审批 |
| 最后 | 业务 Approve → 可 Sent |

字段分级：**必须审批**=低毛利/特价/非标条款；**业务即可**=标准毛利报价；**AI 只提醒**=毛利异常/成本异常。（复用真实 `CAN_APPROVE_PRICE` / `CAN_SEE_FINANCIALS` 角色。）

## 9. Acceptance Criteria（什么时候 Quote 才算 Approved，可发客户）
```
☑ 所有 Line 成本齐全（面料/CMT/辅料/包装/物流）
☑ 每行毛利 ≥ 底线 或 已审批
☑ 在有效期内
☑ 必填齐全（客户/款/色/量/币种/有效期）
☑ 客户/Inquiry 已关联（引用，非重录）
☑ Timeline 留痕齐
```
全 ✓ → Approved → 可 Sent；否则停当前态，Action Center 提示缺项。

## 10. Action Center（指导下一步）
状态概览：当前状态 · 待补成本行 · 毛利预警 · 待审批 · **客户已晾 N 天** · **有效期剩 N 天** · 成交概率。
**Next Recommended Action**（AI 建议）。按钮：`Submit for Approval / Approve / Send / Re-quote / Mark Lost`。**AI 只建议，人工执行**。

## 11. Quote Agent（Object Guardian）

| 维度 | 内容 |
|---|---|
| 维护 | Quote |
| 持续监控 | 成本完整性 · **毛利健康**(低于底线) · 成交概率 · **有效期临近** · 谈判停滞(客户晾着) · 成本异常 |
| 何时提醒 | 毛利破底线 / 有效期剩 X 天 / 客户 N 天未回 / 成本缺行 |
| 何时禁止 | ❌ 自动确认报价 · ❌ 自动发客户 · ❌ 自动审批毛利 · ❌ 自动建 PO/Order · ❌ 自动改成本真相 |
| 何时建议 | 单耗/CMT 估算 · 报价草稿 · 让价建议 · 成交概率 · re-quote 提示 |
| 何时停止 | 终态(Converted/Lost/Abandoned/Expired) |

> Quote Agent **已部分真实**（RAG 成本引擎在算单耗/CMT）——这是"AI 真执行"，本蓝图把它正名为对象守护者。

## 12. Quote Health KPI
**健康 = 这张报价能否快速、足利、被客户接受。** AI 持续算：毛利质量 · 响应时长 · 有效期内成交率 · 改版次数 · **成本准确率**(来自 `quoter_training_feedback` 实际回流)。**报警**：毛利破底 / 临期未成 / 改版过多(报价不稳)。

---

## 13. 特别要求：链路 100% 引用/继承（任何数据只录一次）

```
Customer(录1次) → Inquiry(解析1次) → Sample → Quote(款/色/码/单耗/成本/报价 录1次)
        │ Approved+Sent，客户接受
        ▼
Customer PO  ──100% 引用 Quote(quote_id)──►  以 Quote 为比对基线；款式引用不重录；
        │                                     客户的成交值=PO 自身真相(客户主张,非重录 Quote)
        │ PO Compare + Resolution + Confirmed
        ▼
Order  ──100% 继承 Confirmed Customer PO──►  客户数据 100% 继承(V1.3 封板规则)，禁手打
```

| 数据 | 录入处(唯一) | 向下 |
|---|---|---|
| 客户 | Customer | 全链引用 id |
| 款/色/码/工艺/单耗 | **Quote**(或 Product 款库) | PO/Order **引用**，不重录 |
| 成本/毛利 | Quote | 喂 Profit forecast |
| **报价(quoted price)** | Quote | = PO Compare 的**基线** |
| 客户成交值(ordered qty/price) | **Customer PO**(客户 PO 文件,OCR 1 次) | Order 继承确认值 |
| 公司承诺(confirmed) | **Order**(resolve 结论,非新录) | 全链脊柱 |

> **关键澄清（守门禁②）**：款式/单耗在 Quote **录一次**，PO/Order 全靠**引用/继承**；报价值是 Quote 真相、客户成交值是 PO 真相、确认值是 Order 真相——**三个不同事实，零字段重录**。
> **过渡说明（Evolution，非重做）**：旧 `convertQuoteToOrder`(报价直接预填订单) 在本链中被 **Quote→Customer PO→Order** 取代（PO 入中间）；旧路径是 PO 对象之前的临时桥，不推翻、随落地收编。

---

## 《Quote Blueprint V1.0 Review》（诚实评分）

| 维度 | 评分 | 说明 |
|---|---|---|
| **Business Boundary** | **10** | 我方报价 ⟂ 客户主张 ⟂ 公司承诺，三事实清晰，无双真相 |
| **Lifecycle** | **9** | Draft→…→Converted/Expired/Lost 完整；含 Version/Negotiation/Re-quote 分支 |
| **Data Chain** | **9** | Quote→PO(引用)→Order(继承) 链清晰、零重录；**前提：customer_id 接线 + PO 引用 quote_id 落地** |
| **Developer Readiness** | **8** | 现有 quoter 单款→须**泛化 Header+Lines** + 加 Version；AI 成本引擎已在，readiness 较高但有泛化工作 |
| **Constitution Compliance** | **10** | 01/02/05/06 全合；AI 全程不确认/不发/不审批 |
| **Object Completeness** | **9** | 12 模式齐；边角(多款不同币种/有效期、战略客户框架价)待落地决策 |

**综合 ~9.2/10。**

**诚实残余（落地前拍板，非阻碍）：**
1. **单款→多款泛化**：现 quoter 一报一款；Header+Lines 是主要扩展点（过门禁：多款一报减工作量 + 一 PO 引一 Quote 强链路）。
2. **customer_id / quote_id 接线**：Quote 连 customers、PO 引用 quote——消重录的物理前提（与本对象一起落地）。
3. **框架报价/年度价**：战略客户的"一价多单"是否要 Quote 之上的框架层——**暂不新增对象**（过不了"减每天工作量"则不做），待业务确有高频再议。

**是否 Production Ready？** ✅ **设计层 Production-Ready**：对象/边界/生命周期/Version/Resolution/Approval/Acceptance/Timeline/Agent/Health/链路引用 全闭环，且每项过两问门禁。开发须守：**款式/单耗 Quote 录一次向下引用 · 报价值作 PO 比对基线 · AI 永不确认/发送/审批**。落地先做 Header+Lines + customer_id/quote_id 接线。

---

> 本文 = Quote 设计。后续 Quote 开发遵循本蓝图与 Customer PO 黄金模板 12 模式。不写代码 / DB / migration / UI。
</content>

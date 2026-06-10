# 打样申请系统审计 — Sample Request Audit

> 性质：**纯审计**。审计当下未改任何业务逻辑 / 数据库 / UI / action。
> 同批仅做一处**低风险文档漂移修复**（打样节点数 7→8，详见末尾）。
> 审计日期：2026-06-10。

---

## 1. 系统边界

⚠️ 系统里其实有**两套**命名相近但完全不同的 "sample" 子系统，审计与维护时必须分清：

| 子系统 | 触发 | 模板 | 本审计对象 |
|--------|------|------|-----------|
| **A. 独立样品单（打样申请系统）** | `/orders/new?type=sample` → `order_purpose='sample'` | `SAMPLE_MILESTONE_TEMPLATE`（8 节点） | ✅ 是 |
| B. 量产单内嵌样品阶段 | 量产单选「样品阶段」（dev_sample / 产前样） | 插入 `MILESTONE_TEMPLATE_V1` 的头样/产前样节点 | ❌ 旁系，仅作边界提示 |

**本文只审计 A（独立样品单）。** B 是量产订单时间线里的一段，与独立样品单不共用模板、不共用状态字段，不要混为一谈。

---

## 2. 当前链路（子系统 A）

```
建单：/orders/new?type=sample
  → 表单 isSampleOrder = (searchParams.type === 'sample')   [app/orders/new/page.tsx:154]
  → 提交时 rawFormData.set('order_purpose', 'sample')        [app/orders/new/page.tsx:841]
落库：createOrder 写 order_purpose='sample'                   [app/actions/orders.ts]
路由：getApplicableMilestones(orderPurpose==='sample')
  → 返回 SAMPLE_MILESTONE_TEMPLATE（8 节点）                  [lib/milestoneTemplate.ts:210]
导出：详情页「导出打样申请单」按钮
  → exportSampleRequest(orderId) 生成 Excel（1:1 复刻绮陌纸质模板）
                                                              [app/actions/export-sample-request.ts]
                                                              [components/ExportSampleRequestButton.tsx]
```

**8 节点模板**（`SAMPLE_MILESTONE_TEMPLATE`，`lib/milestoneTemplate.ts:161`）：
`sample_confirm` → `sample_material` → `sample_making` → `sample_qc` → `sample_shipping_arrange` → `sample_sent` → `sample_customer_confirm` → `sample_complete`。

---

## 3. 数据模型

`orders` 表打样相关列（来源 `supabase/migrations/20260404_quote_sample_flow.sql`）：

| 列 | 取值 / 类型 | 现状 |
|----|------------|------|
| `order_purpose` | `'inquiry' \| 'sample' \| 'production'`（默认 production） | ✅ 子系统 A 的真正驱动字段 |
| `sample_status` | `'pending' \| 'making' \| 'sent' \| 'approved' \| 'rejected'` | ⚠️ **从不写入**（死列，见 F1） |
| `parent_order_id` | uuid → orders(id) | ⚠️ **从不使用**（死列，见 F2） |
| `product_description` | text | ✅ 导出打样单时使用 |
| `target_price` | text | 报价/询盘用，子系统 A 导出未用 |

另注：`order_type`（`sample \| bulk \| repeat`）是**独立于** `order_purpose` 的另一个字段（见 F3）。

---

## 4. 六个发现

### 🟡 F1 — `sample_status` 死列 + AI 误读
- **从不写入**：全代码库无任何 insert/update 设置 `sample_status`；建单 `app/actions/orders.ts` 也不设。
- 却被**读取并喂进 AI**：`lib/agent/complianceCheck.ts:57,298`、`lib/agent/emailOrderCompare.ts:51,98`。AI 拿到的"样品状态"**永远是 null**。
- 更糟：`complianceCheck.ts:298` 判断 `sample_status === 'in_progress'` —— 此值**不在 CHECK 约束内**（约束仅 pending/making/sent/approved/rejected），是恒不成立的死分支。
- **影响**：样品单状态机名存实亡；AI 合规检查基于恒空字段判断，可能误判。

### 🟡 F2 — `parent_order_id` 死列（样品→量产无链接）
- 只出现在 `lib/repositories/ordersRepo.ts:51` 白名单，**全系统再无引用**。
- `app/actions/generate-production-order.ts` 生成量产单时**不写 `parent_order_id`、不读 `order_purpose`**（仅用文本 `sample_requirements`）。
- **影响**：样品单与其催生的量产单**无可追溯链接**；`quote_sample_flow` 暗示的"询盘→样品→量产"链条只建了字段、没建逻辑。

### 🟡 F3 — `order_type` vs `order_purpose` 双口径（单一真相缺失）
- 标记"样品"有两条独立路：`order_type='sample'`（选择器）与 `order_purpose='sample'`（URL 触发），二者互不联动。
- **路由只认** `order_purpose==='sample'`（`lib/milestoneTemplate.ts:210`）；**导出认两者其一**（`app/actions/export-sample-request.ts:62`）。
- **影响**：若某单 `order_type='sample'` 但 `order_purpose!='sample'`，会拿到**完整量产模板**，却仍显示「导出打样申请单」按钮 —— 行为自相矛盾。

### 🟢 F4 — 节点数文档漂移（代码对、文档错）
- 代码与 `scripts/pre-deploy-check.ts:29,59` 都断言 **8** 节点 ✅；但 `lib/milestoneTemplate.ts:159` 注释写"**7** 个节点"，`CLAUDE.md` 也写"打样=7关卡"。
- **影响**：非运行 bug，但治理文档与现实不符，误导后续维护。→ 本批修复（7→8）。

### 🟢 F5 — 导出权限只校验邮箱后缀
- `exportSampleRequest` 仅 `email.endsWith('@qimoclothing.com')`，**无角色检查、无订单归属检查** —— 任何登录用户可导出**任意**样品单的打样申请单。
- 只读内部文档，风险低；但与 CLAUDE.md "新 action 须 auth+角色检查" 规程不一致。

### 🟢 F6 — gsm / 尺寸结构化缺口
- **克重（gsm）无专列**，从 `materials_bom.notes` 取（`export-sample-request.ts:168`）；尺码配比网格**留空手填**（`orders.sizes` 无结构化尺寸，与辅料库审计同源问题）。

---

## 5. 建议优先级

| 优先级 | 动作 | 说明 |
|--------|------|------|
| **P1** | **`sample_status` 去留决策** | 要么在 8 节点关键步进时接上写入，要么删列 + 删 complianceCheck/emailOrderCompare 的读取（含非法 `'in_progress'` 分支） |
| **P1** | **`order_purpose` 作为唯一真相** | 导出与路由统一只认 `order_purpose`；`order_type='sample'` 若属 legacy 则清理 |
| **P2** | **`parent_order_id` 预留/接上** | 要么在 generate-production-order 时回填实现样品→量产链接，要么显式标注"预留未启用" |
| **P3** | **文档漂移 7→8** | CLAUDE.md + milestoneTemplate.ts:159 注释（本批已修） |
| **P3** | **导出权限补角色/归属** | 可选，内部低风险 |

---

## 6. 本批改动范围

- ✅ 新增本审计文档。
- ✅ 低风险文档漂移修复：`CLAUDE.md`「打样=7关卡」→「8关卡」、`lib/milestoneTemplate.ts:159` 注释「7 个节点」→「8 个节点」。
- ❌ **未改**：sample_status / parent_order_id / order_type / order_purpose 逻辑 / exportSampleRequest 权限 / 数据库 / UI / 其它 actions。

> P1/P2 项均需单独决策后再动，不在本批范围。

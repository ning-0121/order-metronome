# Order Metronome 集成契约（Integration Contract）

> 状态：草案 v0.2 · 仅契约，不含实现代码 · 维护：Claude（架构审核 / 发布负责人）
> 本文件对应「Priority 4：接口预留」。当前只完成 **Finance（收款回写）** 一节。
> ARAOS（Lead→Customer→Quote→Order）与 QuoteMate（Quote→Baseline Cost→Order）两节待后续补写。
>
> **v0.2 变更（2026-06-02）**：补齐审查发现的 3 个 P0 缺口 —— §1.5 付款模型语义（TT/OA/Unknown）、§2.5 客户级 AR、§5.5 控制字段归属（不再"未决"）；并补 P1 —— 新增 `payment.reversed`/`payment.adjusted`/`customer_ar.updated` 事件、冻结状态枚举、引擎读取映射、事件乱序状态机。

---

# 一、Finance 收款回写契约

## 0. 背景与 SoT 判定（结论先行）

- **SoT（唯一真相源）= 外部 Finance System**（已由 CEO 拍板）。
- **现状双轨证据**：
  - 出站 `lib/integration/finance-sync.ts`：OM→Finance 推送订单主数据 + 审批请求（order/milestone/price_approval/delay）。**不含收款**。
  - 入站 `app/api/integration/finance-callback/route.ts`：Finance→OM 只回写 **审批决定**（price / delay / cancel / milestone）。**没有任何写 `order_financials` 收款字段的分支**。
- **关键事实（代码级，与 env 无关）**：当前集成接通的是「审批流」，**不是「收款流」**。
- **两边现状**：
  - Finance System：**基本没有**收款/水单/核销/账龄数据。
  - Order Metronome：`order_financials` 收款字段由「无人写入」，是悬空死数据；`recordPayment()` 无前端入口（死函数）。
- **判定**：收款 SoT **两边都还没有** → 这是「两边都要补 + 有明确先后」。先 Finance 补建，再回写 OM，OM 全程只读。

---

## 1. Finance System 是否已有收款数据？（契约点 1）

**答：基本没有。** Finance System 目前主要承载审批，尚无收款登记 / 水单 / 核销 / 账龄能力。

→ 因此本契约的前提是：**Finance 侧需先补建收款能力**（见点 3），在此之前 OM 收款状态应保持「未知（unknown）」，不得伪装成「正常 / 已收」。

---

## 1.5 付款模型语义（TT / OA / Unknown）（P0 · 契约核心）

> 这是整份契约的**操作语义基石**：收款对操作的意义，TT 与 OA **相反**。下游所有闸门（§5.5）与引擎（§8）都必须按订单的 `payment_terms` 分流，不得统一处理。

| 付款模型 | `payment_terms` 取值（OM 主数据） | 收款 → 操作语义 | 应收/账龄风险 |
|----------|----------------------------------|----------------|----------------|
| **TT（预付/分段）** | `TT` / `TT30/70` 等 | **定金未收 → 禁止生产**（`allow_production=false`）；**尾款未收 → 禁止放单/出货**（`allow_document_release=false`） | 低（钱在前，货在后） |
| **OA / Net（赊销）** | `OA` / `Net30` / `Net60` | **允许出货**（`allow_shipment=true`），收款**不硬卡任何操作**；出货即形成应收 | **高**（货已走，钱未回）→ 走 §2.5 客户级 AR 监控 + `payment_hold` 仅 warning |
| **Unknown（未知）** | Finance 尚未回写 / 无 `payment_terms` | **默认不硬卡**，只告警（"收款状态待财务确认"） | 不报绿灯、不误伤正常 OA |

**铁律**：
1. `payment_terms` 是 **OM 主数据**（建单时录入），出站推给 Finance 供其算到期日；Finance **不改** `payment_terms`。
2. **TT 的收款是操作闸门**；**OA 的收款是应收风险**，绝不能用 TT 的硬卡逻辑去拦正常 OA 出货（否则得罪 40% 的赊销客户）。
3. `unknown` **永不**触发 hard block，最多 warning —— 防止"没数据"被误判为"未收款"而误伤。

> **业务依据**：绮陌 TT 60% / OA 40%。OA 那 40% 正是回款风险最高、最该监控、却最不能硬卡的部分。

---

## 2. OM 需要新增哪些入站 webhook 事件？（契约点 2）

**复用现有入站通道**：`POST /api/integration/finance-callback`（已具备 `x-api-key` + HMAC-SHA256 签名 `x-webhook-signature` + `source` 校验，无需新建端点、无需新表）。

**新增 4 个收款事件类型**（在现有 `approval_type` 之外，扩展一个并列的 `event` 维度，或新增 `payment_event` 字段；二选一在实现期定）：

| 事件 | 触发时机（Finance 侧） | 写入 OM 的目标 |
|------|----------------------|----------------|
| `payment.received` | 某笔应收（定金/尾款）全额到账并核销 | 对应 `*_status='received'` + `*_received` + `*_received_at` |
| `payment.partial` | 部分到账 | `*_status='partial'` + `*_received`（累计已收额） |
| `payment.overdue` | 到期日已过仍未收齐 | `*_status='overdue'` + `overdue_days` |
| `payment.write_off` | 坏账核销 / 财务冲销 | `*_status='written_off'` + `blocked_reason`（注明冲销原因） |
| `payment.reversed` | 退票 / 退款 / 错误核销冲正（OA 支票跳票、T/T 退汇） | 回退上一状态：`received`→上一态；`*_received` 扣减 |
| `payment.adjusted` | 质量索赔扣款 / 银行手续费 / 短付协议（OA 高频） | `*_status='adjusted'` + 记录 `adjusted_amount` 与原因；**不等于未收** |
| `customer_ar.updated` | 客户级应收汇总变化（见 §2.5） | 写客户级 AR 只读副本（非 `order_financials`） |

> 所有事件由 **Finance System 主动推送**，OM 被动接收。OM 不主动拉取、不主动计算收款状态。
> 订单腿级事件（received/partial/overdue/write_off/reversed/adjusted）写 `order_financials`；客户级事件（customer_ar.updated）写客户级 AR 副本（§2.5）。

---

## 2.5 客户级 AR（Customer-level AR）（P0 · Priority 2 地基）

> 订单腿级回写（§2）只能回答"这一单收了没"，回答不了"这个客户一共欠多少、账龄多久、还能不能继续赊销"——而 Priority 2 的「客户欠款统计 / OA 风险监控 / 客户信用风险评分」全是**客户级**。故必须补一条**客户级 AR 汇总**回写。

**SoT 归属**：客户级 AR 的唯一真相源 = **Finance System**（与订单级一致）。OM **只读展示 + 用于风险判断**，**绝不本地汇总、不本地计算账龄/额度**（避免与 Finance 口径分叉）。

**事件**：`customer_ar.updated`，由 Finance 在客户应收发生变化时推送。字段：

| 字段 | 含义 | OM 用途 |
|------|------|---------|
| `customer_id` / `customer_no` | 客户定位 | 关联 |
| `total_outstanding` | 未结应收总额 | 客户欠款统计、CEO 看板 |
| `overdue_amount` | 其中已逾期金额 | OA 风险监控 |
| `aging_0_30` / `aging_31_60` / `aging_61_90` / `aging_90_plus` | 账龄分桶 | 账龄看板 |
| `credit_limit` | 信用额度 | 风险/接单判断 |
| `credit_available` | 可用额度（= 额度 − 未结） | 新单是否超额预警 |
| `highest_overdue_days` | 最长逾期天数 | 信用评分、红线告警 |
| `customer_credit_status` | 信用状态枚举：`normal` / `watch` / `over_limit` / `frozen` | 风险分级、是否暂停赊销 |
| `currency` | 汇总币种 | 展示 |
| `as_of` | 汇总时点 | 幂等/时序 |

**存储**：客户级 AR 存为**只读副本**（实现期定落点，**本契约不建表**）；与 `customers` 按 `customer_id` 关联。

**消费**：`riskAssessment` / `orderDecisionRules` / CEO 看板 / `customer-credit.ts` 读此副本做客户级回款风险；**不**进 `deliveryConfidence`（交付与回款两个口径，见 §8）。

> **现状提示**：`customer-credit.ts` 现读 `customer_rhythm.overdue_payments` 派生信用分——那是 OM 本地派生，**应在 Finance 回写上线后改读此 AR 副本**，统一到 Finance SoT。

---

## 3. 若 Finance 没有，应先补什么？（契约点 3）

Finance System 在能回写前，**必须先具备**（这是 Finance 侧工作，不在 OM）：

1. **收款登记**：每笔到账记录（金额、币种、日期、付款方、水单/银行回单附件）。
2. **核销（matching）**：把收款笔 ↔ 订单 / 发票（PI/CI）关联，得出"某订单定金/尾款已收多少"。
3. **应收口径**：基于 `payment_terms`（TT / OA / Net30 / Net60）算出每笔应收的**到期日**。
4. **账龄与逾期判定**：到期日 vs 当前，产出 `overdue_days` 与 `overdue` 状态。
5. **按上面 §2 的事件 schema 推送给 OM。**

> OM 这边**只需补「接收端」**（§2 的 4 个事件分支）。在 Finance 完成 1–5 之前，OM 不应上线任何收款展示「绿灯」，避免误导。

---

## 4. OM 只读展示哪些字段（契约点 4）

`order_financials` 中以下字段，OM **只读展示**，写入权一律归 Finance（经 §2 webhook）：

| 字段 | 含义 | OM 行为 |
|------|------|---------|
| `deposit_status` / `balance_status` | 定金/尾款状态（unknown/pending/partial/received/overdue/written_off） | 只读 |
| `deposit_received` / `balance_received` | 已收金额 | 只读 |
| `deposit_received_at` / `balance_received_at` | 到账时间 | 只读 |
| `deposit_due_date` / `balance_due_date` | 应收到期日 | 只读（注：到期日由 Finance 算并回写） |
| `overdue_days` | 逾期天数 | 只读 |

---

## 5. OM 禁止手动修改哪些字段（契约点 5）

**禁止 OM 端（含 UI、Server Action、Agent）写入**上述 §4 全部字段。具体：

- **停用** `recordPayment()`（`order-financials.ts:210`）—— 当前无 UI、且会绕过 Finance SoT，应在实现期**删除或改为 no-op**。
- `updateOrderFinancials()`（`order-financials.ts:132`）对**收款类字段**的写权限应移除（保留它对**成本/售价/毛利**等 OM 自有字段的写权限）。
- `initOrderFinancials()` 仅初始化成本/毛利与确认模块；**不得**为收款字段写入任何"假默认值"（如 `status='pending'` 也应视为占位，语义等同 unknown，直到 Finance 回写）。

---

## 5.5 控制字段归属（P0 · 取代原"未决"）

> 控制字段是 TT 闸门的"牙齿"。归属方案**明确如下，不再保留未决**：
> **Finance 只回写收款事实（§2 事件）；OM 依据 `payment_terms` + Finance 回写状态，派生控制字段。** 即 Finance 管"钱到没到"，OM 管"据此能不能动"。

| 控制字段 | 写入方 | 派生规则（按付款模型分流） |
|----------|--------|---------------------------|
| `allow_production` | **OM 派生** | **TT**：定金未收（`deposit_status` ∈ {unknown 除外的未收态}）→ `false`；定金 `received` → `true`。**OA/Net**：恒 `true`（不卡生产）。**Unknown**：`true` + warning（不硬卡） |
| `allow_shipment` | **OM 派生** | **TT**：尾款逻辑见 `allow_document_release`，出货本身可放行。**OA/Net**：恒 `true`（先出货后收款）。**Unknown**：`true` + warning |
| `allow_document_release`（放单/放 BL） | **OM 派生** | **TT**：尾款未收 → `false`（不放单据/不放 BL）；尾款 `received` → `true`。**OA/Net**：恒 `true`。**Unknown**：`true` + warning |
| `payment_hold` | **OM 派生（warning 级）** | **OA/Net**：当 `payment.overdue` 或 `customer_credit_status` ∈ {`over_limit`,`frozen`} → 置位为**告警标记**（不等于 hard block）。**TT**：硬卡已由上面三个 allow_* 表达，`payment_hold` 仅作并行提示 |

**要点**：
1. **派生是纯函数**：输入 = `payment_terms` + Finance 回写的收款/AR 状态；输出 = 4 个控制字段。OM 不凭空写，只"翻译"Finance 事实。
2. `allow_document_release` 是**新增语义字段**（区别于 `allow_shipment`）：TT 业务里"货可以出厂"与"单据/BL 可以放给客户"是两件事，尾款卡的是后者。**本契约只约定语义，不建表**；实现期若复用现有字段或新增由实现决定。
3. **OA 永不因未收款被 hard block**，最多 `payment_hold` warning + 客户级 AR 风险分级。

---

## 6. 收款事件 Schema（契约点 6）

复用 `finance-callback` 的信封（envelope）：`{ event, timestamp, source:'finance-system', request_id, data, signature }`，签名与鉴权同现有审批回调。`data` 部分如下：

```jsonc
// payment.received —— 某笔应收全额到账并核销
{
  "event": "payment.received",
  "data": {
    "order_no": "QM-20260522-002",     // 用 order_no 或 order_id 定位（实现期定）
    "leg": "deposit",                   // "deposit" | "balance"
    "amount_received": 12000.00,        // 本次累计已收（该 leg）
    "currency": "USD",
    "received_at": "2026-06-01T08:00:00Z",
    "matched_receipt_ids": ["rcpt_001"],// Finance 侧水单/核销凭证号（审计追溯）
    "finance_ref": "FIN-AR-2026-0345"
  }
}

// payment.partial —— 部分到账
{
  "event": "payment.partial",
  "data": {
    "order_no": "QM-...", "leg": "balance",
    "amount_received": 5000.00,         // 已收
    "amount_expected": 12000.00,        // 应收
    "currency": "USD",
    "received_at": "2026-06-01T08:00:00Z",
    "finance_ref": "FIN-AR-..."
  }
}

// payment.overdue —— 到期未收齐
{
  "event": "payment.overdue",
  "data": {
    "order_no": "QM-...", "leg": "balance",
    "due_date": "2026-05-20",
    "overdue_days": 13,
    "amount_outstanding": 7000.00,
    "currency": "USD",
    "finance_ref": "FIN-AR-..."
  }
}

// payment.write_off —— 坏账/冲销
{
  "event": "payment.write_off",
  "data": {
    "order_no": "QM-...", "leg": "balance",
    "amount_written_off": 7000.00,
    "currency": "USD",
    "reason": "客户破产，按坏账核销",
    "approved_by": "财务总监",
    "finance_ref": "FIN-WO-..."
  }
}
```

```jsonc
// payment.reversed —— 退票/退款/错误核销冲正（回退 received）
{
  "event": "payment.reversed",
  "data": {
    "order_no": "QM-...", "leg": "balance",
    "amount_reversed": 12000.00,
    "revert_to_status": "overdue",      // 回退后的目标态：overdue | pending
    "currency": "USD",
    "reason": "客户支票跳票",
    "event_time": "2026-06-05T02:00:00Z",
    "event_id": "evt_rev_001", "finance_ref": "FIN-REV-..."
  }
}

// payment.adjusted —— 扣款/手续费/短付协议（非未收，金额口径调整）
{
  "event": "payment.adjusted",
  "data": {
    "order_no": "QM-...", "leg": "balance",
    "adjusted_amount": -800.00,          // 负=扣减（质量索赔扣款）/ 正=补差
    "adjust_type": "quality_claim",      // quality_claim | bank_fee | short_pay_agreed
    "currency": "USD",
    "reason": "客户验货扣 800（疵品）",
    "event_time": "2026-06-05T02:00:00Z",
    "event_id": "evt_adj_001", "finance_ref": "FIN-ADJ-..."
  }
}

// customer_ar.updated —— 客户级应收汇总（写客户级 AR 副本，非 order_financials）
{
  "event": "customer_ar.updated",
  "data": {
    "customer_no": "EHL",
    "total_outstanding": 85000.00,
    "overdue_amount": 12000.00,
    "aging_0_30": 50000, "aging_31_60": 23000, "aging_61_90": 12000, "aging_90_plus": 0,
    "credit_limit": 100000.00, "credit_available": 15000.00,
    "highest_overdue_days": 47,
    "customer_credit_status": "watch",   // normal | watch | over_limit | frozen
    "currency": "USD",
    "as_of": "2026-06-05T00:00:00Z",
    "event_id": "evt_ar_001", "finance_ref": "FIN-AR-SUM-..."
  }
}
```

**幂等性约定**：订单腿级以 `(order_no, leg, finance_ref)` 去重，客户级以 `(customer_no, event_id)` 去重；同一键重复推送只更新不重复累加。时序与状态转移见 §8.2。

---

## 7. `order_financials` 字段去留（契约点 7）

| 类别 | 字段 | 处置 |
|------|------|------|
| **保留为 Finance 回写副本（只读缓存）** | `deposit_status`/`balance_status`、`deposit_received`/`balance_received`、`*_received_at`、`*_due_date`、`overdue_days` | 保留。仅由 webhook 写 |
| **保留为 OM 自有** | `sale_price_per_piece`、`sale_total`、`cost_*`、`gross_profit_rmb`、`margin_pct`、`min_margin_alert`、`exchange_rate`、`sale_currency` | 保留，OM 写（与收款无关） |
| **应废弃 / 停用** | `recordPayment()` 函数；`deposit_rate`（若仅用于 OM 自算收款，交给 Finance 后失去意义——实现期确认） | 废弃 |
| **语义补强（不新增表，仅约定取值）** | `*_status` 冻结枚举（见下「状态枚举冻结」） | 见点 8 |

**状态枚举冻结（P1 · 不再"二选一"）**：`deposit_status` / `balance_status` 取值**冻结为以下 8 个**，发送端（Finance）与消费端（OM 引擎）必须一致：

```
unknown      —— Finance 尚未回写（默认；不报绿、不硬卡，仅 warning）
pending      —— 已知有应收、未到期、未收（正常等待）
partial      —— 部分到账
received      —— 全额到账并核销
overdue       —— 到期未收齐
written_off   —— 坏账/冲销
reversed      —— 退票/退款/错误核销冲正（回退 received）
adjusted      —— 扣款/手续费/短付协议（非未收，金额口径调整）
```

> 控制字段 `payment_hold` / `allow_production` / `allow_shipment` / `allow_document_release` 的归属与派生规则：**已在 §5.5 明确定为「OM 依 payment_terms + Finance 回写状态派生」，不再未决。**

---

## 8. 消费端如何改用回写状态而非死字段（契约点 8）

**当前问题**：`deliveryConfidence.ts:412`、`riskAssessment.ts:919`、`blockRules.ts:149`、`orderBusinessEngine.ts:488` 等读 `balance_status==='overdue'/'partial'` 扣分/拦货。因该值永不被写，规则**全失效**；且代码把"空值"当"正常"，无法区分「确认未逾期」与「根本不知道」。

**契约要求（仅方向，实现期落地，本阶段不写码）**：

1. **引入 `unknown` 语义**：Finance 尚未回写的订单，状态视为 `unknown`。
2. **消费端三态处理**：
   - `unknown` → **静默，不扣分、不拦货、不报绿灯**（显示"收款状态待财务确认"）。
   - `received` / 未到期 → 正常（绿）。
   - `partial` / `overdue` / `written_off` → 按严重度扣分 / 风险提示（这才是真正生效的回款预警）。
3. **禁止**把 `unknown` 误判为「正常」（当前 bug 根因）。

→ 这样 OA 40% 客户的逾期预警才会**第一次真正生效**，且不会对没数据的订单误报。

### 8.1 各引擎读取映射（P1 · 按付款模型分流）

| 引擎 | 读什么 | TT 行为 | OA/Net 行为 | Unknown |
|------|--------|---------|-------------|---------|
| `blockRules`（硬闸门） | `*_status` + `payment_terms` + §5.5 控制字段 | **唯一可 hard block**：定金未收拦生产、尾款未收拦放单 | **只 warning，绝不 hard block** 出货 | 不拦，仅 warning |
| `deliveryConfidence`（交付置信度） | **不读收款状态** | — | — | — |
| `riskAssessment` | `*_status` + §2.5 `customer_ar` | 回款风险提示 | **重点**：OA 逾期/超额 → 回款风险（非交付） | 静默 |
| `orderDecisionRules` | `*_status` + `customer_ar.customer_credit_status` | 接单/推进决策 | 超信用额度 / `frozen` → CAUTION/STOP | 不影响决策 |
| CEO 看板 | §2.5 `customer_ar` 汇总 | 客户欠款/账龄/超额排行 | 同左（OA 为主） | 不计入 |

**铁律两条**：
1. **`deliveryConfidence` 永不混入回款风险**——交付（货能不能按时出）与回款（钱能不能收回）是两个独立口径，混在一起会让"能按时交付但客户赊账逾期"的订单错误飘红，污染交付预警。回款风险归 `riskAssessment` + CEO 看板。
2. **只有 `blockRules` 能 hard block，且只对 TT**；其余引擎一律 warning / 风险分级。

### 8.2 事件乱序与状态机（P1 · 幂等 + 时序）

网络/补推会导致事件乱序到达。OM 按 **`event_time`（事实发生时间）+ `event_id`（幂等键）** 处理，规则：

- **幂等**：同 `event_id` 重复到达 → 只认一次，不重复累加金额。
- **时序**：仅当来件 `event_time` **晚于**当前已记录的 `last_event_time` 才覆盖；更早的迟到事件**丢弃**（记日志）。
- **状态转移**（合法迁移，非法迁移记日志告警不应用）：
  - `received` 可覆盖 `overdue` / `partial` / `pending`（钱补齐了）。
  - `reversed` 可把 `received` 回退（退票/退款）→ 转回 `overdue` 或 `pending`（由事件携带目标态）。
  - `adjusted` **不**等于"未收"——它调整金额口径（扣款/短付），状态可仍为 `received`/`partial`，不得据此判逾期。
  - `written_off` 为终态，仅 `reversed`（误冲销）可逆。
- **客户级 AR**：`customer_ar.updated` 以 `as_of` 做时序，旧 `as_of` 丢弃。

---

## 9. 数据流向图

```
┌──────────────┐  order.created/updated/activated/completed     ┌─────────────────┐
│ Order        │ ───────────────────────────────────────────▶ │ Finance System  │
│ Metronome    │   (现有出站 finance-sync，含 payment_terms)     │  (SoT)          │
│ (OM)         │                                               │                 │
│              │                                               │  收款登记/水单   │
│              │                                               │  核销/账龄/逾期  │ ← Finance 须先补建(点3)
│              │   payment.received / partial / overdue /       │                 │
│  order_      │ ◀── write_off  (新增入站, finance-callback) ── │                 │
│  financials  │   只读缓存                                      └─────────────────┘
│  (只读)      │
│      │       │
│      ▼       │
│ deliveryConfidence / riskAssessment / CEO看板                 三态: unknown 静默 / received 绿 / overdue 红
└──────────────┘
```

---

## 落地顺序（P0/P1/P2，本契约的实施建议——待 CEO 批准后才进入实现）

| 优先级 | 动作 | 归属 | 说明 |
|--------|------|------|------|
| **P0** | Finance 侧补建收款登记/核销/账龄/逾期判定 + **客户级 AR 汇总**（§2.5） | Finance System | 前置，不在 OM。无此则一切回写无源 |
| **P0** | OM 加 `payment.*` + `customer_ar.updated` 入站分支（finance-callback） | OM | 只加接收端，复用现有端点，无新表 |
| **P0** | OM 按 §5.5 派生 `allow_production`/`allow_shipment`/`allow_document_release`/`payment_hold`（TT/OA 分流） | OM | TT 闸门的执行；OA 永不硬卡 |
| **P1** | OM 消费端三态（unknown/received/逾期）+ §8.1 各引擎按付款模型分流读取 | OM | 让回款预警真正生效且不误报、不污染交付口径 |
| **P1** | 实现 §8.2 事件乱序/幂等状态机 | OM | 防退票/补推导致状态错乱 |
| **P2** | 废弃 `recordPayment()` 死函数、收紧 `updateOrderFinancials` 收款字段写权 | OM | 防 SoT 被旁路写入 |
| **P2** | `customer-credit.ts` 改读 §2.5 客户 AR 副本（替代本地 `customer_rhythm` 派生） | OM | 统一到 Finance SoT |

> 以上为契约与顺序建议，**不含任何代码**。进入实现需 CEO 单独批准，并仍遵守「不新增表、不做 Finance OS、先审计后开发」铁律。

---

# 二、ARAOS 集成契约（待写 · Priority 4）

> Lead → Customer → Quote → Order 的边界与数据流。占位，后续补。

# 三、QuoteMate 集成契约（待写 · Priority 4）

> Quote → Baseline Cost → Order 的边界与数据流。占位，后续补。

---

# 四、PO 审批附件契约（2026-07-11 · 财务侧已上线，OM 发起端待接线）

> 老板需求：财务审 PO 前，必须看到 **PO 单据 + 内部报价单（成本核算单）**；
> 财务系统 AI 识别核算单 → 预填预算草稿 → 财务调价生成预算单 → **有预算单才能批准放行 PO**（预算闸门）。
> 财务侧全链路已上线（commit 5b98e9e/feb3e98，识别已用真实核算单实测 4 款全对）。OM 侧只差把附件带上。

## 1. 两条发送路径（二选一或并用，财务侧都已支持）

### 路径 A：随 PO 审批推送内联（推荐）
`purchase_order.approval_requested` / `purchase_order.placed` 的 data 增加 `attachments[]`：

```jsonc
{
  // …原有 po_no / purchase_order_id / lines / order_refs 等不变…
  "attachments": [
    {
      "id": "om-file-uuid",            // 可选：OM 文件 id（幂等键；不给则财务按 采购单+file_url 去重）
      "file_name": "日本CLMB内部成本核算单.xlsx",
      "file_type": "excel",            // 财务 CHECK 仅收 excel/pdf/image/word
      "file_size": 38400,              // 可选
      "file_url": "https://…publicUrl…", // 必须财务服务端可直接 GET（公开桶 publicUrl 或签名 URL）
      "doc_hint": "internal_quote",    // 必给：'po'=采购单据 | 'internal_quote'=内部报价单(财务跑AI识别)
      "order_id": "orders.id"          // 可选：多订单 PO 时，报价单挂到对应订单
    }
  ]
}
```

代码已就位：`buildPurchaseOrderSyncPayload(..., attachments)` / `requestPurchaseOrderApproval(..., attachments)`
（`lib/integration/finance-sync.ts`，`PoAttachment` 类型）。

### 路径 B：独立 `file.uploaded` 事件补发
`syncFileToFinance({...})` 新增三个可选字段：`purchase_order_id`、`order_id`、`doc_hint`。
适合"PO 先推、核算单后补"的场景；带 `purchase_order_id` 即挂到该采购单的审批页。

## 2. 文件要求

- `file_url` 财务服务端 30s 内可 GET（沿用 shipping-docs 的 `order-docs` 公开桶 publicUrl 模式即可）；
- 内部核算单支持 xlsx/xls/csv/pdf/jpg/png/webp；绮陌真实格式（单件成本口径、一款一行、
  含税价/面料A·B/加工价/辅料备注算式）已按真实样例校准，识别实测逐行金额与表格一致；
- `doc_hint` 决定财务侧行为：`internal_quote` → 审批页出现「识别报价单」→ 预填预算草稿；`po` → 仅供查看。

## 3. 财务侧行为（已上线，OM 无需做）

识别是按需触发（财务点按钮）、结果只做建议；预算落库由财务调价确认（记真实审批人）。
**预算闸门**：PO 关联订单（order_refs → synced_orders）没有预算单时，「批准放行」禁用 +
decide API 409 `BUDGET_REQUIRED`；驳回不受限；历史非 UUID order_refs 不拦截。

## 4. OM 侧待接线（唯一 TODO）

在提交 PO 审批的动作里（`app/actions/purchase-orders.ts` 两处 `requestPurchaseOrderApproval` 调用点，
L~501 / L~763），把该订单的内部成本核算单文件（业务上传处/报价冻结产物）上传到 `order-docs` 桶取
publicUrl，组装 `attachments[]` 传入。若 OM 当前没有存核算单原件，需在 PO 提交界面加"附核算单"上传。

## 5. 验收标准

1. OM 推一张带 `attachments`（含 internal_quote）的 PO → 财务「采购审批」页该单出现"附件与内部报价单"卡；
2. 财务点「识别报价单」→ 成本行逐行显示、与 PO 行单价差红绿对照；
3. 「生成预算草稿」→ 调价保存 → 预算闸门解锁 → 批准放行回传 OM 正常；
4. 同一 PO 重推附件不重复（幂等）。

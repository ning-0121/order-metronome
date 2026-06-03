# Order Metronome 集成契约（Integration Contract）

> 状态：草案 v0.1 · 仅契约，不含实现代码 · 维护：Claude（架构审核 / 发布负责人）
> 本文件对应「Priority 4：接口预留」。当前只完成 **Finance（收款回写）** 一节。
> ARAOS（Lead→Customer→Quote→Order）与 QuoteMate（Quote→Baseline Cost→Order）两节待后续补写。

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

## 2. OM 需要新增哪些入站 webhook 事件？（契约点 2）

**复用现有入站通道**：`POST /api/integration/finance-callback`（已具备 `x-api-key` + HMAC-SHA256 签名 `x-webhook-signature` + `source` 校验，无需新建端点、无需新表）。

**新增 4 个收款事件类型**（在现有 `approval_type` 之外，扩展一个并列的 `event` 维度，或新增 `payment_event` 字段；二选一在实现期定）：

| 事件 | 触发时机（Finance 侧） | 写入 OM 的目标 |
|------|----------------------|----------------|
| `payment.received` | 某笔应收（定金/尾款）全额到账并核销 | 对应 `*_status='received'` + `*_received` + `*_received_at` |
| `payment.partial` | 部分到账 | `*_status='partial'` + `*_received`（累计已收额） |
| `payment.overdue` | 到期日已过仍未收齐 | `*_status='overdue'` + `overdue_days` |
| `payment.write_off` | 坏账核销 / 财务冲销 | `*_status='written_off'` + `blocked_reason`（注明冲销原因） |

> 所有事件由 **Finance System 主动推送**，OM 被动接收。OM 不主动拉取、不主动计算收款状态。

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

**幂等性约定**：OM 以 `(order_no, leg, finance_ref)` 去重；同一 `finance_ref` 重复推送只更新不重复累加。

---

## 7. `order_financials` 字段去留（契约点 7）

| 类别 | 字段 | 处置 |
|------|------|------|
| **保留为 Finance 回写副本（只读缓存）** | `deposit_status`/`balance_status`、`deposit_received`/`balance_received`、`*_received_at`、`*_due_date`、`overdue_days` | 保留。仅由 webhook 写 |
| **保留为 OM 自有** | `sale_price_per_piece`、`sale_total`、`cost_*`、`gross_profit_rmb`、`margin_pct`、`min_margin_alert`、`exchange_rate`、`sale_currency` | 保留，OM 写（与收款无关） |
| **应废弃 / 停用** | `recordPayment()` 函数；`deposit_rate`（若仅用于 OM 自算收款，交给 Finance 后失去意义——实现期确认） | 废弃 |
| **语义补强（不新增表，仅约定取值）** | `*_status` 增加 `'unknown'`（或约定 `'pending'`=未知占位） | 见点 8 |

> 控制字段 `payment_hold` / `allow_production` / `allow_shipment` / `blocked_reason`：**归属待定**——它们是"门禁动作"，可能由 Finance 回写驱动，也可能 OM 按回写状态派生。建议实现期单列一次小讨论，本契约暂标 ⚠️ 未决。

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
| **P0** | Finance 侧补建收款登记/核销/账龄/逾期判定 | Finance System | 前置，不在 OM。无此则一切回写无源 |
| **P0** | OM 加 `payment.*` 入站分支（finance-callback） | OM | 只加接收端，复用现有端点，无新表 |
| **P1** | OM 消费端区分 `unknown` vs `confirmed`（点 8） | OM | 让回款预警真正生效且不误报 |
| **P2** | 废弃 `recordPayment()` 死函数、收紧 `updateOrderFinancials` 收款字段写权 | OM | 防 SoT 被旁路写入 |

> 以上为契约与顺序建议，**不含任何代码**。进入实现需 CEO 单独批准，并仍遵守「不新增表、不做 Finance OS、先审计后开发」铁律。

---

# 二、ARAOS 集成契约（待写 · Priority 4）

> Lead → Customer → Quote → Order 的边界与数据流。占位，后续补。

# 三、QuoteMate 集成契约（待写 · Priority 4）

> Quote → Baseline Cost → Order 的边界与数据流。占位，后续补。

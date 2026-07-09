# QIMO OS — Enterprise Integration Roadmap（企业集成路线）

> **Status**: 🟡 路线建议（不写代码 / 不写 migration / 不改库 / 不提交 / 不 push）。**Evolution NOT Rewrite**。
> **本文 = 第六步**。承接 `01/02/03-…`。每阶段先列**用户原排法**，再给**我的调整 + 理由**（findings 强烈暗示的修正）。

---

## 0. 路线总原则（贯穿每阶段）

1. **三库不合并**——集成靠身份脊柱 + 契约 + 事件，不靠跨库 FK（物理上做不到）。
2. **先拆危险耦合，再加功能**——finance 直连 QIMO 库（service key）是定时炸弹，Phase 0 就换掉。
3. **打开已有的桥，别造新桥**——finance 三通道、ARAOS handoff 都在，多是"升级为契约"。
4. **每阶段先建身份/契约，后接业务**——没有共享 ID，业务打通都是猜名字。
5. **AI 永不跨系统写真相**（DP-5）；**Quote/PO/客户晋升必经人工确认**（Constitution 06）。

---

## 1. 对用户 Phase 排法的三点挑战（先说分歧）

> 用户原排：P0 仅建连接(FK/Bridge/Reference/Status) → P1 Quote/Customer/Product/Order → P2 Manufacturing/Material/Procurement → P3 Warehouse/Production/Quality/Packing/Shipment → P4 Finance/Profit/Payment/Forecast → P5 Analytics/Automation/AI。
> **方向认可，但 3 点必须调：**

**挑战 1：P0 的"FK"在跨 Supabase 下不存在。必须改为"身份脊柱 + 契约 API + 拆危险耦合"。**
> 三个独立 Supabase 之间**无法建 Postgres FK**。P0 的"建立连接"只能是：共享企业 ID（Customer/Order/Quote）+ 只读契约 API + 事件订阅 + 状态映射。**并且 P0 必须顺带拆掉 finance 直连 QIMO 库的 service-key 耦合**——它是现存最大隐患，越早换越好。

**挑战 2：Finance 不该排在 P4。它已经在线、已经三通道耦合——是"加固"，不是"新建"。**
> finance 与 QIMO **已经在跑**（webhook/直连/callback）。真正的痛点不是"建 finance 集成"，而是 ①把脆弱耦合换成契约（P0）②**让实际成本/利润/收款回流 QIMO**（早做，消除"QIMO 看不到真实收款/双轨利润"）。把整个 finance 推到 P4 = 让最痛的可见性缺口白等四个阶段。**finance 回流提前到 P2。**

**挑战 3：ARAOS→QIMO 赢单 handoff 现在是关闭的死胡同，应是 P1 第一刀。**
> 赢单的 sample/order 全卡在 `metronome_handoffs='pending'`（`METRONOME_WEBHOOK_URL` 未设）。这是"获客→订单"价值链的**断点**，商业价值最高、技术成本最低（桥已建好，只差开关 + 共享 id）。P1 优先打开它。

> 其余（QIMO 内部 Warehouse/Production/Quality/Packing/Shipment 深化）确实靠后，与用户一致——但它们更多是 **QIMO 单仓库内部建设**（走 EA V1.0/V1.1 路线），不是跨仓库集成，本路线不重复展开。

---

## 2. 推荐路线（调整版）

### **Phase 0 — 身份脊柱 + 契约层 + 拆危险耦合**（地基，最高优先）
> 用户原意「仅建立连接」——做对的方式。

| 动作 | 内容 |
|---|---|
| **企业 ID 脊柱** | QIMO 暴露 `customers.id` / `orders.id` / `quoter_quotes.id` 为企业 Customer/Order/Quote ID。finance & ARAOS 各加**可空** `qimo_customer_id` / `qimo_order_id` / `qimo_quote_id` 列（纯加法）。 |
| **契约 API（QIMO 提供）** | `GET /api/contract/{customers,orders,quotes}/{id}`（只读、HMAC、版本化）。 |
| **拆危险耦合** | finance **删除** `METRONOME_SUPABASE_SERVICE_KEY` 直连读库，改调上面的契约 API。 |
| **状态映射表** | 统一三系统的客户/订单/报价状态枚举映射（ARAOS deal.stage ↔ QIMO order 阶段 ↔ finance 结算态）。 |
| **回填脚本（一次性）** | 用 name/order_no 历史匹配，把存量数据补上 `qimo_*_id`（人工核对高风险匹配；不自动覆盖）。 |
| **不做** | 不合库、不改任何系统内部真相表结构（只加可空引用列）。 |
| **验收** | 三系统任意一条客户/订单记录，能用同一个企业 ID 在另两系统定位；finance 不再直连 QIMO 库。 |

### **Phase 1 — 商业起源打通（ARAOS → QIMO）**
> 用户 P1（Quote/Customer/Order 打通），从价值链断点切入。

| 动作 | 内容 |
|---|---|
| **打开赢单桥** | 设 `METRONOME_WEBHOOK_URL`，升级 handoff payload 带 `qimo_*_id`；ARAOS deal=won → QIMO 收到 → **人工确认** → 创建/关联 `customers` + 预填 `orders`（对接 EA V1.1「从 Approved Quote 继承」）。 |
| **客户晋升** | ARAOS `companies(account_status=won)` → 晋升写 QIMO `customers`，双向存 id。停止 finance 按 name 自建。 |
| **Quote 收口** | ARAOS 售前 `quote_strategies`（议价区间）→ 触发 QIMO 正式 `quoter_quotes`（成本/单耗/价/确认）→ Approved Quote。一份成交真相。 |
| **状态回流（QIMO→ARAOS，新增）** | QIMO 订单进展（确认/生产/出运）→ 回写 ARAOS deal/conversation 阶段，销售看得到成交后进展。 |
| **验收** | ARAOS 赢一单 → QIMO 自动出现待确认订单（带客户+报价继承）→ 销售在 ARAOS 看到该单进展。 |

### **Phase 2 — 财务回流（finance ⇄ QIMO 双向闭环）**
> 把用户 P4 的关键部分提前：finance 已耦合，缺的是"实际回流"。

| 动作 | 内容 |
|---|---|
| **正向（已在，加固）** | QIMO order/quotation → finance `budget_orders`（改用 `qimo_order_id`，停 notes ILIKE）。 |
| **forecast 接 Quote** | finance/QIMO：Approved Quote → `profit_snapshots(forecast)`（EA V1.1 已设计，几乎免费）。 |
| **反向回流（新增，核心）** | finance 实际成本/结算利润/**收款（AR）** → 契约回流 QIMO → 写 `profit_snapshots(live/final)` 只读缓存 + 客户目标达成。**消除双轨利润真相**：QIMO live/final 不再自算，读 finance。 |
| **审批闭环（已在）** | finance 审批 → QIMO `finance-callback`（保留，改用企业 id）。 |
| **验收** | QIMO 订单卡上能看到"计划利润(forecast,来自Quote) / 实际利润(final,来自finance) / 已收款(来自finance AR)"，三者同源不矛盾。 |

### **Phase 3 — QIMO 内部深化（Material / Procurement / 生产链）**
> 合并用户 P2+P3：这些是 QIMO **单仓库内部**建设，走 EA V1.0/V1.1，不是跨仓库集成。

| 动作 | 内容 |
|---|---|
| 采购回归 Product 驱动（修 P1′）+ 大货单耗从 Definition 带入（暂停的 Phase 2B） | EA V1.1 的 P2 |
| Warehouse / Production / Quality / Packing / Shipment 结构化 | EA V1.0 路线 |
| **跨仓库接口** | 仅在 Shipment 完成 → 触发 finance 开票（事件），其余 QIMO 内部。 |

### **Phase 4 — 共享主数据清理（Supplier / FX）**
| 动作 | 内容 |
|---|---|
| **Supplier 共享** | QIMO Supplier 域（寻源身份）+ finance `suppliers`（付款属性）共享 supplier id；ARAOS `factory_*` 归档、Reference QIMO 制造真相。 |
| **FX 单源** | finance `exchange_rates` = 企业 FX master；QIMO 报价 pin 快照引用，不再各维护。 |

### **Phase 5 — 企业级 Analytics / Automation / AI**
| 动作 | 内容 |
|---|---|
| **企业看板（只读聚合）** | QIMO Analytics 跨三系统只读契约：获客漏斗(ARAOS) + 订单/生产(QIMO) + 现金/利润(finance)。不拥有真相。 |
| **事件驱动 Automation** | 落 Event Bus/Outbox（Event-Catalog 第 2/3 步），三系统订阅；告警跨系统聚合。 |
| **AI Agent 围绕事件** | 各系统 AI agent 监听企业事件做建议/检查/推荐，**人工确认才写真相**（DP-5）。 |

---

## 3. 路线对比（用户 vs 调整版）

| 阶段 | 用户原排 | 调整版 | 关键差异 |
|---|---|---|---|
| P0 | 仅建连接（FK） | **身份脊柱 + 契约 API + 拆 finance 直连库** | 跨库无 FK；P0 顺带拆最大隐患 |
| P1 | Quote/Customer/Product/Order | **打开 ARAOS 赢单桥 + Quote 收口 + 状态回流** | 从价值链断点切入（商业价值最高/成本最低） |
| P2 | Manufacturing/Material/Procurement | **财务回流（finance⇄QIMO 闭环）** | finance 提前（已耦合，缺回流）；消除双轨利润 |
| P3 | Warehouse…Shipment | **QIMO 内部深化（Material/Procurement/生产链）** | 合并 P2+P3，定性为 QIMO 内部建设 |
| P4 | Finance/Profit/Payment/Forecast | **共享主数据（Supplier/FX）** | finance 大头已在 P2；P4 只剩主数据清理 |
| P5 | Analytics/Automation/AI | **企业 Analytics + 事件驱动 + AI agent** | 一致（AI 是横切，非独立终点） |

> 净差异：**① P0 把"FK"改为"身份脊柱+契约"并顺带拆危险耦合；② finance 从 P4 提到 P2（回流闭环）；③ ARAOS 赢单桥提为 P1 第一刀；④ QIMO 内部建设合并、与"跨仓库集成"分开定性。**

---

## 4. 红线复核（每阶段必守）
- **不推翻任何线上系统**：三库全留，纯加法（可空引用列 + 契约 API）。
- **不合并数据库**：联邦架构，Evolution（CLAUDE.md「绝不共用 Supabase」）。
- **Evidence≠Data**：跨系统传的是结构化契约 + 企业 ID，不是文件；文件仍各自作 Evidence。
- **AI 不跨系统写真相**：晋升/回流/比对皆人工确认闸门（Constitution 06 / DP-5）。
- **One Owner**：每对象一个 SoT（`03-…` 已定）；跨系统只引用，不克隆。
- **先 ID 后业务**：任何阶段先有共享身份，再接业务流。

---

## 5. 立即可做的"零风险第一步"（若你批准启动 Phase 0）
1. 三系统各加**可空** `qimo_customer_id` / `qimo_order_id` 列（纯加法，不影响线上）。
2. QIMO 出 `GET /api/contract/orders/{id}` 只读契约（finance 先并行调用，验证后再撤直连库）。
3. 写一次性回填脚本（name/order_no→id），**人工核对**高风险匹配。
> 仍遵守：不写代码进生产前先设计审、build+check、diff 审、数据库门禁、批了才 push。**本轮只到设计为止。**
</content>

# Shared Core Registry — 跨产品复用登记表

> 这份文件登记**所有可在 internal 产品和 commercial-product 之间复用**的核心逻辑。
> 每条登记必须说明：适用场景 / 触发节点 / 规则 / Override 机制 / 是否含 Qimo 专属数据。
>
> 标记说明：
> - `[SHARED]` — 通用逻辑，commercial-product 可直接同步
> - `[INTERNAL]` — 仅适用 Qimo 内部，不可同步
> - `[ABSTRACTED]` — 通用骨架 + 可配置参数，同步时需替换参数

---

## delivery-info-progressive-validation `[SHARED]`

**适用场景**：订单的某些资料（地址、客户确认信息等）在下单时尚未确定，但下游某个具体节点必须依赖该信息才能继续。

**当前实例**（生产中）：
- 国内送仓订单的 5 个送货字段：仓库名 / 详细地址 / 联系人 / 电话 / 客户要求送达日期
- 部分客户（如年年旺）下单时仅口头通知，仓库地址需后续确认

**核心原则**：
> 创建订单不追求资料 100% 齐全；但**关键执行节点完成前必须补齐**。

**4 个组件**（按执行顺序）：

| 阶段 | 行为 | 实现位置 |
|------|------|---------|
| 1. 创建时 | 字段允许全空。表单 label 标注「待确认可空」+ 一句提示告知下游 hard-block 位置 | `app/orders/new/page.tsx` |
| 2. 后端创建 | 不做硬校验。直接落库 NULL | `app/actions/orders.ts` |
| 3. 中段催办 | 创建 ≥7 天后任一字段为空 → `missing_info` 任务发给 owner；≥14 天升级 priority=1 | `lib/services/daily-tasks.service.ts → generateMissingInfoTasks` |
| 4. 节点 hard-block | 推进到 `packing_method_confirmed` 或 `domestic_delivery` 前，任一字段为空 → 返回 error 并列出缺失项 | `app/actions/milestones.ts → updateMilestone` 中的 `DOMESTIC_DELIVERY_GATE_KEYS` 检查 |

**Hard Block 规则**：

```
条件: delivery_type === 'domestic'
     AND step_key ∈ {packing_method_confirmed, domestic_delivery}
     AND any({warehouse_name, address, contact, phone, required_at}) is empty
动作: 返回 error，禁止完成节点
文案: "国内送仓信息缺失：<具体字段列表>。请先在订单详情页补齐后再完成此节点（包装/唛头依赖送货地址）。"
```

**Admin Override 规则**：
- `isAdmin === true` 的用户绕过 hard-block
- 用途：应急放行（业务员离职、客户长期不回复等极端场景）
- 绕过后**不记审计**（依赖 milestone 日志的标准审计链）

**UI 反馈**：
- 订单详情页顶部，琥珀色 banner 列出缺失字段
- 仅对 `delivery_type === 'domestic'` 且有字段空时显示
- 字段补齐后 banner 自动消失

**Qimo 专属性**：
- ✅ 通用骨架完全可复用：5 个字段 + 节点 hard-block + missing_info 催办
- ✅ 不含任何 Qimo 客户名、地址、业务术语
- ✅ `packing_method_confirmed` / `domestic_delivery` 是行业通用 milestone key（外贸行业标准）
- → **commercial-product 可直接同步全部代码与文案**

**Anti-Pattern（已规避）**：
- ❌ "创建时强制必填" → 业务员被迫填假地址绕过校验，污染数据
- ❌ "全程不校验" → 真到包装环节才发现地址不全，工厂已开始排产
- ✅ "渐进式校验" → 信息流动节奏匹配业务现实，hard-block 卡在真正会出问题的节点

---

## computeTaskPriority `[SHARED]`

**用途**：任务优先级计算的唯一入口。

**位置**：`lib/services/daily-tasks.service.ts`

**签名**：`computeTaskPriority(staleDays: number, urgentAfterDays: number): 1 | 2 | 3`

**规则**：`staleDays >= urgentAfterDays → 1`（紧急）；否则 → 2（中等）。

**Qimo 专属性**：无。纯函数，**commercial-product 可直接同步**。

---

## escalateStaleTasks `[SHARED]`

**用途**：日常 cron 末尾，对 `priority > 1` 且 `task_date < yesterday` 的 pending 任务做 priority bump + `escalate_count + 1`。

**位置**：`lib/services/daily-tasks.service.ts`

**Qimo 专属性**：无。**commercial-product 可直接同步**。

---

## delivery_confidence 引擎 `[SHARED]`

**用途**：18 关卡 + 延期申请 + 利润快照 → 单一 0-100 分。

**位置**：`lib/runtime/deliveryConfidence.ts`

**Qimo 专属性**：算法本身通用。参数（关键节点列表、扣分系数）属于 Qimo 调优结果，但可作为 `[ABSTRACTED]` 默认值给 commercial-product 使用。

---

## customer_rhythm SoT 模式 `[SHARED]`

**用途**：客户画像由 nightly cron 物化，页面只读，禁止页面计算。

**位置**：`lib/services/customer-rhythm.service.ts` + `lib/services/customer/customer-pnl.service.ts`

**Qimo 专属性**：行为标签集合（`A类客户` / `付款慢` 等）通用。**commercial-product 可直接同步**。

---

## finance-resync 模式 `[SHARED]`

**用途**：当外部财务系统是收款 SoT 时，OM 端提供单向手动「重新同步」按钮。

**位置**：`app/actions/finance-resync.ts` + `components/OrderActions.tsx`

**Qimo 专属性**：依赖 Qimo 配置的 `FINANCE_SYSTEM_URL`。骨架通用，env var 不同。属于 `[ABSTRACTED]`。

---

## TODO(SoT) 标注约定 `[SHARED]`

**用途**：当某字段的真正 SoT 在外部系统（如财务系统），但 OM 仍在读取/缓存旧值时，在读取点标注此 TODO。

**示例位置**：`lib/runtime/deliveryConfidence.ts` 等 9 个文件，共 11 处。

**Qimo 专属性**：无。**commercial-product 可直接同步**。

---

## 同步策略

每次 `[SHARED]` 模块更新 main 时：
1. 在本登记表加一条变更记录
2. commercial-product 分支按需 cherry-pick（不强制实时同步）
3. 同步前确认改动不引入 Qimo-specific 数据

每次 `[INTERNAL]` 模块更新时：
- 不需要同步到 commercial-product
- 但要确保不污染 `[SHARED]` 模块

---

*最后更新：2026-05-14*

# 节点/风险 改期处置机制 · 设计（V1.0 · 2026-07-05）

> 目标:解决"整个系统全是红"——让每个逾期节点/采购风险点**可被处置**(改期),
> 处置走**可配置的多级审批链**,全链点头则红点清除、日期更新、留全程审批链。
> 红 = 真没人管的;黄 = 已申请改期在审;绿/受控 = 已处置。

---

## 1. 核心理念

每个"红"(节拍器里程碑逾期 **或** 采购风险点)都能点「**申请改期**」:
填 **新完成日期 + 原因 + (可选)阻塞根因**。→ 按路由发到**审批链** → 逐级确认 →
全部确认 = 红点清除、节点 `due_at` 更新、留痕。

业务开发审批时决定:**退交期**(定新整体交期,客户承诺变更)/ **不退→转紧急**
(保持交期,压缩下游,采购+生产共担)。

---

## 2. 路由 = 可配置表（铁律:不写死在代码里）

**按"谁延期(节点 owner_role)"定"审批链(有序角色列表,逐级)":**

```ts
// lib/domain/deferral-routing.ts（配置,改这里即可调整,不动引擎）
export const DEFERRAL_ROUTING: Record<string, string[]> = {
  procurement:  ['merchandiser', 'order_manager'], // 采购提交→业务执行审批→业务执行经理审批
  merchandiser: ['sales'],                         // 业务执行延期→业务开发确认
  production:   ['merchandiser'],                  // 生产延期→业务执行确认
  // 兜底:其余节点(finance/sales 自己的)→ admin
  _default:     ['admin'],
};
```

**部门↔角色对照(2026版组织):**
- 业务开发 = `sales`(开发业务部;+ araos 开发人员,跨系统一期先用 sales)
- 业务执行 = `merchandiser`(订单管理部·理单)
- 业务执行经理 = `order_manager`(订单管理经理)
- 采购 = `procurement` / 采购经理 = `procurement_manager`
- 生产 = `production`

> 路由随组织调整时,只改 `DEFERRAL_ROUTING`,引擎与 UI 不动。

---

## 3. 数据模型

复用现有 `delay_requests`(里程碑延期)+ 扩展多级审批链:

```sql
-- 迁移 20260705_deferral_approval_chain.sql（纯加法）
ALTER TABLE public.delay_requests
  ADD COLUMN IF NOT EXISTS approval_chain   jsonb NOT NULL DEFAULT '[]'::jsonb,  -- 有序角色 ['merchandiser','order_manager']
  ADD COLUMN IF NOT EXISTS approvals        jsonb NOT NULL DEFAULT '[]'::jsonb,  -- [{role,user_id,at,note}] 已确认的
  ADD COLUMN IF NOT EXISTS current_step     int  NOT NULL DEFAULT 0,             -- 当前轮到链上第几级
  ADD COLUMN IF NOT EXISTS reschedule_mode  text,                               -- push_delivery(退交期)/urgent(转紧急)
  ADD COLUMN IF NOT EXISTS block_root_cause text;                               -- 阻塞根因(客户未确认/供应商未回/上游未交)
```
- `approval_chain` = 建申请时按 DEFERRAL_ROUTING[owner_role] 快照(冻结,防路由改了影响在途)。
- 逐级:`current_step` 那级的角色确认 → 追加进 `approvals` + `current_step++`;到头 = 全确认 → 应用。
- 任一级驳回 → status=rejected,红点保留。

---

## 4. 应用（全确认后）

- **里程碑改期**:更新该 milestone `due_at`=新日期,红消,记 milestone_logs + 触发交付置信度重算。
- **退交期(push_delivery)**:业务开发确认新的整体交期 → 走既有 recalc-milestones/reschedule 重排下游。
- **转紧急(urgent)**:订单打紧急标,不动最终交期,压缩后子节点期限收紧;采购+生产在链上确认即代表认下压缩。

---

## 5. 通知（复用 notifyUsersByRole）

- 建申请 → 通知**当前链首角色**"有改期待审批"。
- 每级确认 → 通知下一级;全确认 → 通知发起人+相关方"已改期到 X"。
- 驳回 → 通知发起人。

---

## 6. 分阶段建

1. **P1 里程碑改期引擎**:路由 config + 迁移 + createDeferral/approveStep/rejectDeferral(多级) + 红节点上「申请改期」按钮 + 逐级确认 UI + 通知。核心。
2. **P2 采购风险点处置**:风险中心每条红加「填预计到货日/申请改期」;采购填 expected_arrival,若 ≤ 需求日直接消红,若破需求日则走 P1 同款审批链(owner_role=procurement)。顺带修"预计未定"报红 + 同料同供应商去重/显色。
3. **P3 退交期/转紧急分支**:业务开发审批面板二选一 + 紧急标 + 下游压缩联动。

---

## 7. 减少"红"产生（配套)

- **分级**:未到期只逼近 → 黄(提醒);真逾期且未处置 → 红;已申请改期 → "审批中"(不算红)。
- **根因归属**:申请时选阻塞根因,风险卡显示"卡在谁那"(客户/供应商/上游),而非笼统红。
- 已处置/改期的节点不再拖累交付置信度。

---

## 待确认/风险
- 路由已定稿(§2),随组织可改配置。
- araos 开发人员参与"业务开发"确认 = 跨系统,一期先用节拍器 sales 角色;跨系统确认待 araos 打通后接。

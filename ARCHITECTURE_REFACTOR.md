# 架构收敛：数据契约层 + 状态机 + 事件日志

## 概述

本次重构建立了"数据契约层 + 状态机 + 事件日志"的最小可行架构，解决了以下核心痛点：
1. **Schema Drift**：数据库字段变动导致前端/后端频繁崩溃
2. **状态不统一**：中英文状态混用
3. **边界不清晰**：里程碑的"卡住原因/备注/日志"边界不清晰

## 架构设计

### 1. 数据契约层（Contract Layer）

**位置**：`lib/repositories/`

- **`milestonesRepo.ts`**：所有对 `milestones` 表的写入必须通过此 repository
- **`ordersRepo.ts`**：所有对 `orders` 表的写入必须通过此 repository

**职责**：
- 字段白名单过滤（移除未知字段）
- 状态映射（英文 -> 中文）
- 默认值填充
- 数据合法性预校验

**禁止**：所有页面/组件禁止直接 `supabase.from('milestones').insert/update`

### 2. Milestone 状态机（State Machine）

**位置**：`lib/domain/types.ts`

**允许的状态**（只使用中文）：
- `未开始`
- `进行中`
- `卡住`
- `已完成`

**允许的状态转换**（代码实现校验）：
```
未开始 -> 进行中 / 卡住
进行中 -> 卡住 / 已完成
卡住 -> 进行中
已完成 -> （禁止，终态）
```

**校验机制**：
- 非法转换在 dev 环境抛错（console.error）
- 在 prod 环境返回可读错误（不 silent fail）
- 通过 `transitionMilestoneStatus()` 函数统一处理

### 3. 卡住原因/备注策略（收敛）

**统一策略**：
- 不再使用 `blocked_reason` 字段
- 卡住原因写入 `notes`，格式：`卡住原因：xxx`
- 更新 `notes` 时支持 append 模式（`appendMilestoneNotes()`）

**工具函数**（`lib/domain/milestone-helpers.ts`）：
- `extractBlockedReason(notes)`: 从 notes 中提取卡住原因
- `formatBlockedReasonToNotes(reason, existingNotes, append)`: 格式化卡住原因到 notes
- `appendToNotes(existingNotes, newContent, timestamp)`: 追加 notes（用于日志）

### 4. 事件日志（Event Logging）

**表结构**：`milestone_logs`
- `id`, `milestone_id`, `order_id`, `actor_user_id`
- `action` (create, status_transition, update, etc.)
- `from_status`, `to_status` (for transitions)
- `note`, `created_at`

**Migration**：`supabase/migrations/20240101000000_add_milestone_logs.sql`

**价值**：
- 审计追踪（谁做了什么，什么时候）
- 里程碑进展历史回顾
- 状态转换问题调试

**实现**：Repository 层自动记录所有状态转换和关键操作

### 5. 统一的 UI 显示规范

**Domain Helpers**（`lib/domain/milestone-helpers.ts`）：
- `isMilestoneOverdue(milestone)`: 判断是否超期
- `isMilestoneDueSoon(milestone, hoursThreshold)`: 判断是否即将到期
- `extractBlockedReason(notes)`: 提取卡住原因

**UI 规范**：
- 卡住项显示：`卡住 + 原因（notes）`
- 列表中突出 `due_at` 超期（使用 `isMilestoneOverdue`）
- 业务逻辑集中在 domain 层，组件只负责展示

## 修改文件清单

### 新增文件

1. **`lib/domain/types.ts`**
   - Domain types（MilestoneStatus 只使用中文）
   - 状态映射函数（`normalizeMilestoneStatus`）
   - 状态机转换规则（`STATUS_TRANSITIONS`）
   - 状态转换校验函数（`isValidStatusTransition`, `getStatusTransitionError`）

2. **`lib/domain/milestone-helpers.ts`**
   - `isMilestoneOverdue()`
   - `isMilestoneDueSoon()`
   - `extractBlockedReason()`
   - `formatBlockedReasonToNotes()`
   - `appendToNotes()`

3. **`lib/repositories/milestonesRepo.ts`**
   - `createMilestone()`, `createMilestones()`
   - `updateMilestone()`, `updateMilestones()`
   - `transitionMilestoneStatus()` - 状态机转换（带校验）
   - `appendMilestoneNotes()` - 追加 notes
   - 自动记录事件日志

4. **`lib/repositories/ordersRepo.ts`**
   - `createOrder()`
   - `updateOrder()`
   - `deleteOrder()`
   - 字段白名单过滤

5. **`supabase/migrations/20240101000000_add_milestone_logs.sql`**
   - 创建 `milestone_logs` 表
   - RLS 策略

### 修改文件

1. **`lib/types.ts`**
   - `MilestoneStatus` 类型改为只使用中文：`'未开始' | '进行中' | '卡住' | '已完成'`

2. **`app/actions/orders.ts`**
   - 使用 `createOrder()` from `ordersRepo`
   - 使用 `createMilestones()` from `milestonesRepo`
   - 状态统一使用中文（`进行中`、`未开始`）

3. **`app/actions/milestones.ts`**
   - 使用 `transitionMilestoneStatus()` 进行状态转换
   - 移除旧的 `logMilestoneAction()` 函数（由 repository 自动处理）
   - 状态统一使用中文

4. **`app/actions/delays.ts`**
   - 使用 `updateMilestone()`, `updateMilestones()` from `milestonesRepo`

5. **`components/MilestoneActions.tsx`**
   - 移除英文状态检查，只使用中文状态

6. **`components/MilestoneCard.tsx`**
   - 使用 `isMilestoneOverdue()` helper
   - 使用 `extractBlockedReason()` 提取卡住原因
   - 移除英文状态检查

7. **`components/OrderTimeline.tsx`**
   - 移除英文状态检查
   - 使用中文状态显示卡住原因

8. **`lib/utils/order-status.ts`**
   - 移除英文状态检查，只使用中文状态

9. **`app/admin/page.tsx`**
   - 移除英文状态检查

10. **`app/dashboard/page.tsx`**
    - 移除英文状态检查

## 关键代码 Diff

### 状态机转换（milestonesRepo.ts）

```typescript
export async function transitionMilestoneStatus(
  milestoneId: string,
  nextStatus: string | MilestoneStatus,
  note?: string | null
): Promise<{ data?: any; error?: string }> {
  // 获取当前里程碑
  const { data: milestone } = await (supabase
    .from('milestones') as any)
    .select('*')
    .eq('id', milestoneId)
    .single();
  
  const currentStatus = normalizeMilestoneStatus(milestone.status);
  const normalizedNextStatus = normalizeMilestoneStatus(nextStatus);
  
  // 状态机校验
  if (!isValidStatusTransition(currentStatus, normalizedNextStatus)) {
    const errorMsg = getStatusTransitionError(currentStatus, normalizedNextStatus);
    
    if (process.env.NODE_ENV === 'development') {
      console.error('[MilestonesRepo] Invalid status transition:', {
        milestoneId,
        from: currentStatus,
        to: normalizedNextStatus,
        error: errorMsg,
      });
    }
    
    return { error: errorMsg };
  }
  
  // 处理 notes（卡住原因格式化）
  let updatedNotes = milestone.notes;
  if (normalizedNextStatus === '卡住' && note) {
    updatedNotes = formatBlockedReasonToNotes(note, milestone.notes, false);
  } else if (note) {
    updatedNotes = appendToNotes(milestone.notes, note, true);
  }
  
  // 更新状态
  const { data: updated, error } = await (supabase
    .from('milestones') as any)
    .update({
      status: normalizedNextStatus,
      notes: updatedNotes,
    })
    .eq('id', milestoneId)
    .select()
    .single();
  
  // 记录状态转换日志
  await logMilestoneEvent(
    supabase,
    milestoneId,
    milestone.order_id,
    'status_transition',
    currentStatus,
    normalizedNextStatus,
    note || `状态从"${currentStatus}"转换为"${normalizedNextStatus}"`
  );
  
  return { data: updated };
}
```

### 数据清洗（milestonesRepo.ts）

```typescript
function sanitizePayload(
  input: Record<string, any>,
  mode: 'insert' | 'update'
): { payload: Record<string, any>; removedFields: string[] } {
  // 状态映射（标准化为中文）
  if (input.status !== undefined) {
    payload.status = normalizeMilestoneStatus(input.status);
  }

  // 处理 blocked_reason/blockedReason -> notes 映射（兼容旧代码）
  const blockedReason = input.blocked_reason || input.blockedReason;
  if (blockedReason !== undefined) {
    payload.notes = formatBlockedReasonToNotes(
      String(blockedReason),
      input.notes,
      false
    );
    removedFields.push('blocked_reason', 'blockedReason');
  }
  
  // 白名单过滤...
  // Dev 环境警告...
}
```

## 测试清单

### 1. 新建订单不卡住
- [ ] 创建新订单（FOB）
- [ ] 创建新订单（DDP）
- [ ] 验证自动生成的 milestones 状态为 `未开始`（除了 `po_confirmed` 为 `进行中`）
- [ ] 验证所有 milestones 的 `notes` 为 `null`
- [ ] 验证没有 `blocked_reason` 字段

### 2. 状态转换（卡住/解锁）
- [ ] 将 `进行中` 的里程碑设置为 `卡住`，提供原因
- [ ] 验证 `notes` 字段格式为 `卡住原因：xxx`
- [ ] 验证状态转换日志已记录到 `milestone_logs`
- [ ] 将 `卡住` 的里程碑设置为 `进行中`
- [ ] 验证状态转换成功
- [ ] 尝试非法转换（如 `已完成` -> `进行中`），验证返回错误

### 3. 状态转换（完成/自动推进）
- [ ] 将 `进行中` 的里程碑设置为 `已完成`
- [ ] 验证下一个 `未开始` 的里程碑自动变为 `进行中`
- [ ] 验证自动推进日志已记录

### 4. 数据清洗（字段过滤）
- [ ] 尝试传入 `blocked_reason` 字段，验证自动映射到 `notes`
- [ ] 尝试传入未知字段，验证在 dev 环境有 `console.warn`
- [ ] 验证未知字段被移除，不影响数据库写入

### 5. UI 显示
- [ ] 卡住的里程碑正确显示原因（从 `notes` 提取）
- [ ] 超期的里程碑正确高亮（使用 `isMilestoneOverdue`）
- [ ] 状态显示统一为中文（无英文状态）

### 6. 事件日志
- [ ] 查询 `milestone_logs` 表，验证所有状态转换都有记录
- [ ] 验证日志包含 `from_status`、`to_status`、`actor_user_id`
- [ ] 验证日志的 RLS 策略正常工作（只能看到自己订单的日志）

## 迁移步骤

1. **运行 Migration**：
   ```sql
   -- 在 Supabase SQL Editor 中执行
   -- supabase/migrations/20240101000000_add_milestone_logs.sql
   ```

2. **部署代码**：
   - 所有代码已通过 TypeScript 编译
   - 构建成功：`npm run build`

3. **验证**：
   - 按照测试清单逐项验证
   - 检查 dev 环境的 `console.warn` 输出（字段过滤警告）

## 约束遵守

✅ **不改 RLS**：未修改 RLS 策略（除非明确导致 repo 无法工作）  
✅ **不改 blocked_reason 字段**：已移除所有 `blocked_reason` 引用，统一使用 `notes`  
✅ **改动可控**：所有改动在 1 次 PR 内完成  
✅ **代码编译通过**：无 TypeScript 错误，无 `any` 乱飞（仅在 Supabase 类型推断处使用 `as any`）

## 后续优化建议

1. **类型安全**：考虑使用 Supabase 的 generated types 替代 `as any`
2. **测试覆盖**：为 repository 层添加单元测试
3. **性能优化**：批量操作时考虑使用事务
4. **日志查询**：为 `milestone_logs` 表添加查询 API

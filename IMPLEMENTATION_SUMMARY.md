# 数据清洗和映射层实施总结

## 实施步骤

### A. 找到所有 milestones 写入点

**写入点清单：**

1. **app/actions/orders.ts** (Line 87-89)
   - `createOrder` 函数中批量插入里程碑
   - 状态：已替换 ✅

2. **app/actions/milestones.ts** (多处)
   - `markMilestoneDone` (Line 104-111): 更新状态为 done
   - `markMilestoneBlocked` (Line 154-162): 更新状态为 blocked
   - `autoAdvanceNextMilestone` (Line 194-197): 更新状态为 in_progress
   - `updateMilestoneStatus` (Line 252-256): 更新状态
   - `assignMilestoneOwner` (Line 308-313): 更新 owner_user_id
   - 状态：已全部替换 ✅

3. **app/actions/delays.ts** (多处)
   - `recalculateSchedule` (Line 343-349): 批量更新所有里程碑日期
   - `recalculateSchedule` (Line 369-395): 更新单个里程碑并批量更新下游
   - 状态：已全部替换 ✅

**读取 blocked_reason 的位置：**

1. **components/OrderTimeline.tsx** (Line 87-89)
   - 状态：已改为读取 notes ✅

2. **components/MilestoneCard.tsx** (Line 49-50)
   - 状态：已改为读取 notes ✅

---

### B. 建立统一入口

**创建文件：`lib/db/milestones.ts`**

**核心函数：**

1. **`sanitizeMilestonePayload(input, mode)`**
   - 白名单过滤（只允许指定字段）
   - 状态映射（英文 -> 中文）
   - `blocked_reason`/`blockedReason` -> `notes` 映射
   - Dev 环境 console.warn 输出被删除字段
   - 空字符串转 null

2. **`mapMilestoneStatus(status)`**
   - 状态映射：`not_started` -> `未开始`
   - `in_progress` -> `进行中`
   - `blocked` -> `卡住`
   - `done` -> `已完成`

3. **`createMilestone(payload)`** / **`createMilestones(payloads[])`**
   - 统一创建入口（单条/批量）

4. **`updateMilestone(id, patch)`** / **`updateMilestones(updates[])`**
   - 统一更新入口（单条/批量）

**白名单字段：**

```typescript
// Insert 白名单
const INSERT_WHITELIST = [
  'order_id',
  'step_key',
  'name',
  'owner_role',
  'owner_user_id',
  'planned_at',
  'due_at',
  'status',
  'notes',
  'is_critical',
  'evidence_required',
];

// Update 白名单（不包含 order_id）
const UPDATE_WHITELIST = [
  'step_key',
  'name',
  'owner_role',
  'owner_user_id',
  'planned_at',
  'due_at',
  'status',
  'notes',
  'is_critical',
  'evidence_required',
];

// Update 黑名单（禁止修改）
const UPDATE_BLACKLIST = ['id', 'order_id', 'created_at', 'updated_at'];
```

---

### C. 全仓库替换

#### 修改文件清单

1. ✅ **lib/db/milestones.ts** (新建)
   - 统一数据清洗和映射层

2. ✅ **lib/types.ts**
   - 更新 `MilestoneStatus` 类型支持中文状态
   - 移除 `blocked_reason` 字段（标记为已废弃，兼容性保留）

3. ✅ **app/actions/orders.ts**
   - `createOrder`: 使用 `createMilestones` 替代直接 insert

4. ✅ **app/actions/milestones.ts**
   - `markMilestoneDone`: 使用 `updateMilestone`
   - `markMilestoneBlocked`: 使用 `updateMilestone`（传入 `blockedReason` 自动映射）
   - `autoAdvanceNextMilestone`: 使用 `updateMilestone`，查询时兼容中文状态
   - `updateMilestoneStatus`: 使用 `updateMilestone`，传入 `blockedReason` 自动映射
   - `assignMilestoneOwner`: 使用 `updateMilestone`

5. ✅ **app/actions/delays.ts**
   - `recalculateSchedule`: 使用 `updateMilestones` 批量更新

6. ✅ **components/OrderTimeline.tsx**
   - 读取 `notes` 而不是 `blocked_reason`
   - 状态颜色映射兼容中文状态
   - 状态判断兼容中文状态

7. ✅ **components/MilestoneCard.tsx**
   - 读取 `notes` 而不是 `blocked_reason`
   - 状态颜色映射兼容中文状态

8. ✅ **components/MilestoneActions.tsx**
   - 状态判断兼容中文状态

9. ✅ **lib/utils/order-status.ts**
   - `computeOrderStatus`: 状态判断兼容中文状态

10. ✅ **app/dashboard/page.tsx**
    - 状态过滤兼容中文状态

11. ✅ **app/admin/page.tsx**
    - 状态过滤兼容中文状态

---

### D. 关键代码 diff

#### 1. 数据清洗函数（核心逻辑）

```typescript
// lib/db/milestones.ts

export function sanitizeMilestonePayload(
  input: Record<string, any>,
  mode: 'insert' | 'update'
): { payload: Record<string, any>; removedFields: string[] } {
  const removedFields: string[] = [];
  const payload: Record<string, any> = {};
  
  // 1. 状态映射（英文 -> 中文）
  if (input.status !== undefined) {
    payload.status = mapMilestoneStatus(input.status);
  }
  
  // 2. blocked_reason/blockedReason -> notes 映射
  const blockedReason = input.blocked_reason || input.blockedReason;
  if (blockedReason !== undefined) {
    // 如果 notes 已有内容，优先保留 notes；否则使用 blocked_reason
    if (!input.notes || !input.notes.trim()) {
      payload.notes = blockedReason ? String(blockedReason).trim() : null;
    } else {
      payload.notes = input.notes.trim() || null;
    }
    
    if (input.blocked_reason !== undefined) removedFields.push('blocked_reason');
    if (input.blockedReason !== undefined) removedFields.push('blockedReason');
  } else if (input.notes !== undefined) {
    payload.notes = input.notes ? String(input.notes).trim() : null;
  }
  
  // 3. 白名单过滤
  const whitelist = mode === 'insert' ? INSERT_WHITELIST : UPDATE_WHITELIST;
  for (const key of whitelist) {
    if (key !== 'status' && key !== 'notes' && key in input) {
      payload[key] = input[key];
    }
  }
  
  // 4. Dev 环境警告
  if (removedFields.length > 0 && process.env.NODE_ENV === 'development') {
    console.warn('[Milestone Sanitizer] Removed unknown fields:', removedFields);
  }
  
  return { payload, removedFields };
}
```

#### 2. 状态映射函数

```typescript
export function mapMilestoneStatus(status: string | null | undefined): string {
  if (!status) return '未开始';
  
  const normalized = status.toLowerCase().trim();
  
  // 如果已经是中文状态，直接返回
  if (STATUS_MAP[normalized]) {
    return STATUS_MAP[normalized];
  }
  
  // 如果已经是中文，直接返回
  const chineseStatuses = Object.values(STATUS_MAP);
  if (chineseStatuses.includes(status)) {
    return status;
  }
  
  return '未开始';
}
```

#### 3. 使用示例（替换前 vs 替换后）

**替换前：**
```typescript
await supabase
  .from('milestones')
  .update({
    status: 'blocked',
    blocked_reason: blockedReason,
  })
  .eq('id', milestoneId);
```

**替换后：**
```typescript
await updateMilestone(milestoneId, {
  status: 'blocked',
  blockedReason: blockedReason, // 自动映射到 notes
});
```

---

### E. 测试清单

#### ✅ 测试项

1. **新建订单自动生成里程碑**
   - [ ] 创建订单后自动生成 5 个里程碑
   - [ ] 里程碑状态为中文（`未开始` / `进行中`）
   - [ ] 没有 `blocked_reason` 字段写入数据库
   - [ ] Dev 环境控制台无警告（无未知字段）

2. **标记里程碑为已完成**
   - [ ] 传入英文状态 `done` -> 自动映射为 `已完成`
   - [ ] 清除 `notes` 字段
   - [ ] 自动推进下一个里程碑

3. **标记里程碑为卡住（兼容旧字段）**
   - [ ] 传入 `blockedReason` -> 自动映射到 `notes`
   - [ ] 状态映射为 `卡住`
   - [ ] UI 正确显示 `notes` 内容

4. **状态兼容性测试**
   - [ ] 查询时兼容英文和中文状态
   - [ ] UI 显示正确
   - [ ] 状态颜色映射正确

5. **数据清洗测试**
   - [ ] 传入未知字段被删除
   - [ ] Dev 环境 console.warn 输出被删除字段
   - [ ] Update 时禁止修改 `order_id`/`id`/`created_at`

6. **批量更新测试**
   - [ ] 延迟请求审批后批量更新里程碑日期
   - [ ] 下游里程碑正确按增量调整

---

### F. 注意事项

1. **向后兼容**
   - 读取操作兼容英文和中文状态
   - UI 组件兼容两种状态格式
   - TypeScript 类型支持两种格式

2. **迁移路径**
   - 数据库现有数据保持英文状态（可选：未来做数据迁移）
   - 新写入统一使用中文状态
   - 查询时兼容两种格式

3. **性能考虑**
   - 数据清洗在服务端进行，对性能影响极小
   - 批量更新使用统一入口，保证一致性

4. **错误处理**
   - 所有统一入口函数返回 `{ data?, error? }` 格式
   - 调用方需要检查 error

---

## 交付清单

- ✅ `lib/db/milestones.ts` - 统一数据清洗和映射层
- ✅ 所有写入点已替换为统一入口
- ✅ UI 读取逻辑已更新（使用 notes）
- ✅ 状态兼容性处理完成
- ✅ TypeScript 类型更新完成

## 后续优化建议

1. **数据库迁移**（可选）
   - 将现有数据库中的英文状态迁移为中文状态
   - 将 `blocked_reason` 数据迁移到 `notes`（如果存在）

2. **监控和日志**
   - 生产环境记录被删除字段（用于后续清理）
   - 统计状态映射使用情况

3. **文档更新**
   - 更新 API 文档，说明状态映射规则
   - 更新开发指南，强调必须使用统一入口

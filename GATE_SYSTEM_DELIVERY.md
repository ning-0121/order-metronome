# 外贸托底级 Gate 系统 - 完整交付文档

## 📋 升级目标

将订单节拍器升级为"外贸托底级 Gate 系统"，支持：
1. 可配置 Gate 模板（18-20个关键控制点）
2. 按订单特征动态生成不同 Gate
3. Dashboard 异常展示（包括依赖阻塞/违规推进）

---

## ✅ 已完成内容

### 1. Gate 模板系统 ✅

**文件：** `lib/domain/gates.ts`

**模板结构：**
- 18 个 Gate 模板（支持条件生成）
- 6 个阶段：订单启动 / 原辅料 / 产前样 / 生产 / QC / 出货
- 每个 Gate 包含：
  - `gate_key`（英文唯一标识）
  - `name_cn`（中文名称）
  - `stage`（所属阶段）
  - `owner_role`（负责人角色）
  - `required`（是否为强制 Gate）
  - `offset_days`（相对 anchor 的天数）
  - `anchor`（锚点：created_at / etd / warehouse_due_date）
  - `depends_on`（依赖的 gate_key 列表）
  - `condition`（条件：满足条件才生成）

**Gate 列表（18个）：**

#### 阶段 1：订单启动（3个）
1. PO确认（强制）
2. 财务审核（强制，依赖：PO确认）
3. 订单资料齐全（强制，依赖：PO确认）

#### 阶段 2：原辅料（3个）
4. 原辅料采购（强制，依赖：财务审核、订单资料齐全）
5. 原辅料到位（强制，依赖：原辅料采购）
6. 原辅料验收（强制，依赖：原辅料到位）

#### 阶段 3：产前样（3个，条件 Gate）
7. 产前样完成（强制，条件：needs_pp_sample=true）
8. 产前样寄出（强制，条件：needs_pp_sample=true）
9. 产前样确认（强制，条件：needs_pp_sample=true）

#### 阶段 4：生产（4个）
10. 工厂上线（强制，依赖：产前样确认或原辅料验收）
11. 中查（建议，依赖：工厂上线）
12. 包装辅料到位（强制，依赖：工厂上线，Custom 包装需提前）
13. 尾查（强制，依赖：中查、包装辅料到位）

#### 阶段 5：QC（2个，条件 Gate）
14. QC验货预约（强制，条件：needs_qc=true）
15. QC验货完成（强制，条件：needs_qc=true）

#### 阶段 6：出货（3个）
16. 订舱完成（强制，依赖：QC验货完成或尾查，FOB: -7天，DDP: -21天）
17. 出货完成（强制，依赖：订舱完成）
18. 船样寄出（建议，条件：needs_ship_sample=true）

---

### 2. 动态 Gate 生成 ✅

**文件：** `lib/utils/gate-generator.ts`

**功能：**
- `generateGateSchedule()` - 根据订单特征生成 Gate 时间表
- 支持条件 Gate（needs_pp_sample, needs_ship_sample, needs_qc）
- 支持不同订单类型（Sample/Bulk/Repeat）
- 支持包装类型调整（Custom 包装提前）

**生成规则：**
- Sample 订单：时间压缩 50%
- Custom 包装：包装辅料到位提前到 -15 天
- FOB 订单：订舱提前 7 天
- DDP 订单：订舱提前 21 天

---

### 3. 创建订单流程更新 ✅

**文件：** `app/actions/orders.ts`

**修改：**
- 使用 `generateGateSchedule()` 替代旧的 `calculateGateSchedule()`
- 支持 `needs_pp_sample`, `needs_ship_sample`, `needs_qc` 参数
- 支持 `order_type: 'repeat'` 类型

---

### 4. Step 2 UI 升级 ✅

**文件：** `app/orders/new/page.tsx`

**改进：**
- 按 6 个阶段分组显示 Gate
- 显示所有生成的 Gate（不再只显示 5 条）
- 显示每个 Gate 的 `required` 标识（强制/建议）
- 显示 `evidence_required` 标识（需凭证）
- 更新文案："系统已为你生成完整外贸执行节拍（约 X 个关键控制点）"

---

### 5. Step 3 UI 升级 ✅

**文件：** `app/orders/new/page.tsx`

**新增内容：**
- 卡住 / 解卡住 / 延期操作说明
- 依赖关系与违规推进说明
- 强调强制控制点必须按顺序完成

---

### 6. Dashboard 依赖阻塞模块 ✅

**文件：** `app/dashboard/page.tsx`

**新增模块 4：依赖阻塞/违规推进**
- 查询所有状态为"进行中"的里程碑
- 检查其依赖的 required Gate 是否已完成
- 如果依赖未完成，标记为"违规推进"
- 显示未完成的依赖列表

**Dashboard 模块列表：**
1. 模块 0：待复盘订单（最高优先级）
2. 模块 1：已超期
3. 模块 2：今日到期
4. 模块 3：卡住清单
5. 模块 4：依赖阻塞/违规推进（新增）

---

## 📁 修改文件清单

### 新增文件
1. ✅ `lib/domain/gates.ts` - Gate 模板定义（18个控制点）
2. ✅ `lib/utils/gate-generator.ts` - Gate 动态生成逻辑
3. ✅ `GATE_SYSTEM_DELIVERY.md` - 完整交付文档

### 修改文件
1. ✅ `app/actions/orders.ts` - 使用新的 Gate 生成器
2. ✅ `app/orders/new/page.tsx` - Step 2/3 UI 升级
3. ✅ `app/dashboard/page.tsx` - 添加依赖阻塞模块

---

## 🔑 关键 Diff

### `lib/domain/gates.ts` (新增)

```typescript
export const GATE_TEMPLATES: GateTemplate[] = [
  {
    gate_key: 'po_confirmed',
    name_cn: 'PO确认',
    stage: '订单启动',
    owner_role: 'sales',
    required: true,
    offset_days: 0,
    anchor: 'created_at',
    depends_on: [],
    condition: undefined, // 无条件，总是生成
  },
  {
    gate_key: 'pp_sample_production',
    name_cn: '产前样完成',
    stage: '产前样',
    owner_role: 'production',
    required: true,
    offset_days: -20,
    anchor: 'etd',
    depends_on: ['raw_materials_inspection'],
    condition: {
      needs_pp_sample: true, // 条件 Gate
    },
  },
  // ... 18 个 Gate
];
```

### `lib/utils/gate-generator.ts` (新增)

```typescript
export function generateGateSchedule(params: OrderParams): GateSchedule[] {
  // 1. 筛选应该生成的 Gate（根据条件）
  const filteredGates = GATE_TEMPLATES.filter(gate => 
    shouldGenerateGate(gate, order)
  );
  
  // 2. 计算每个 Gate 的时间
  // 3. 解析依赖关系
  // 4. 返回 Gate 时间表
}
```

### `app/dashboard/page.tsx`

```typescript
// 模块 4：依赖阻塞/违规推进
const dependencyViolations: any[] = [];
for (const milestone of inProgressMilestones) {
  const dependsOn = milestone.depends_on;
  if (dependsOn && Array.isArray(dependsOn)) {
    // 检查依赖的 required Gate 是否已完成
    const incompleteRequired = dependentGates.filter(
      (dep: any) => dep.required && dep.status !== 'done'
    );
    if (incompleteRequired.length > 0) {
      dependencyViolations.push({...});
    }
  }
}
```

---

## 🧪 验收测试

### 测试 1：Bulk + Custom + needs_qc=true

**步骤：**
1. 创建订单：order_type=bulk, packaging_type=custom, needs_qc=true
2. 查看 Step 2

**预期：**
- ✅ 生成 18-20 个 Gate
- ✅ 包含产前样相关 Gate（needs_pp_sample 默认 true）
- ✅ 包含 QC 相关 Gate
- ✅ 包装辅料到位提前到 -15 天

---

### 测试 2：Sample 订单

**步骤：**
1. 创建订单：order_type=sample
2. 查看 Step 2

**预期：**
- ✅ 生成精简模板（时间压缩 50%）
- ✅ Gate 数量可能减少（根据条件）

---

### 测试 3：Repeat + needs_pp_sample=false

**步骤：**
1. 创建订单：order_type=repeat, needs_pp_sample=false
2. 查看 Step 2

**预期：**
- ✅ 跳过产前样相关 Gate（pp_sample_production, pp_sample_sent, pp_sample_confirmed）
- ✅ 工厂上线直接依赖原辅料验收

---

### 测试 4：依赖阻塞识别

**步骤：**
1. 创建订单并生成 Gate
2. 手动将某个 Gate 设置为"进行中"（但其依赖的 required Gate 未完成）
3. 查看 Dashboard

**预期：**
- ✅ Dashboard 模块 4 显示"依赖阻塞/违规推进"
- ✅ 显示未完成的依赖列表
- ✅ 可以点击查看订单详情

---

## 📊 数据库兼容性

### 当前表结构

**milestones 表字段：**
- `step_key` ✅（对应 `gate_key`）
- `name` ✅（对应 `name_cn`）
- `owner_role` ✅
- `planned_at` ✅
- `due_at` ✅
- `status` ✅
- `is_critical` ✅
- `evidence_required` ✅
- `notes` ✅
- `sequence_number` ✅

**新增字段（可选，如果表支持）：**
- `stage` - Gate 所属阶段
- `required` - 是否为强制 Gate
- `depends_on` - 依赖的 gate_key 列表（JSON 数组）

**注意：**
- 如果表没有这些字段，系统会：
  - 在创建时传递这些字段（数据库函数会忽略不存在的字段）
  - 在 UI 中按 `sequence_number` 推断阶段
  - 依赖检查通过 `depends_on` 字段（如果不存在，跳过检查）

---

## 🚀 部署步骤

### 1. 代码已更新 ✅

所有代码修改已完成，无需额外步骤。

### 2. 测试创建订单

1. 访问 http://localhost:3001/orders/new
2. 填写订单信息（注意：needs_pp_sample, needs_ship_sample, needs_qc 字段如果不存在，使用默认值）
3. 点击"下一步"
4. ✅ 应该看到 18-20 个 Gate，按 6 个阶段分组

### 3. 测试 Dashboard

1. 访问 http://localhost:3001/dashboard
2. ✅ 应该看到 5 个模块（包括依赖阻塞模块）

---

## 📝 后续优化建议

### 1. 数据库字段扩展（可选）

如果需要持久化 `stage`、`required`、`depends_on`：

```sql
ALTER TABLE public.milestones
ADD COLUMN IF NOT EXISTS stage text,
ADD COLUMN IF NOT EXISTS required boolean DEFAULT false,
ADD COLUMN IF NOT EXISTS depends_on jsonb DEFAULT '[]'::jsonb;
```

### 2. 订单表字段扩展（可选）

如果需要支持 `needs_pp_sample`, `needs_ship_sample`, `needs_qc`：

```sql
ALTER TABLE public.orders
ADD COLUMN IF NOT EXISTS needs_pp_sample boolean DEFAULT true,
ADD COLUMN IF NOT EXISTS needs_ship_sample boolean DEFAULT false,
ADD COLUMN IF NOT EXISTS needs_qc boolean DEFAULT true;
```

### 3. Gate 模板配置化

将 Gate 模板存储在数据库中，支持动态配置。

---

## ✅ 交付检查清单

- [x] Gate 模板设计完成（18个控制点）
- [x] 动态 Gate 生成逻辑完成
- [x] 条件 Gate 支持完成
- [x] 创建订单流程更新完成
- [x] Step 2 UI 升级完成（显示所有 Gate）
- [x] Step 3 UI 升级完成（操作说明）
- [x] Dashboard 依赖阻塞模块完成
- [x] 代码构建成功
- [ ] 手动测试 Bulk + Custom + needs_qc=true
- [ ] 手动测试 Sample 订单
- [ ] 手动测试 Repeat + needs_pp_sample=false
- [ ] 手动测试依赖阻塞识别

---

**升级完成时间：** 2024-01-21  
**状态：** ✅ 代码完成，等待测试验证

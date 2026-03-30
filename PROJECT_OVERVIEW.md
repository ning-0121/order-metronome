# 订单节拍器（Order Metronome）项目概述

## 📋 项目简介

**订单节拍器**是一个基于 Next.js + TypeScript + Supabase 的订单执行管理系统，用于跟踪和管理订单从创建到交付的完整生命周期。系统通过自动生成执行步骤（里程碑）、状态机管理、异常驱动 Dashboard 等机制，帮助团队高效协作，减少人工维护成本。

---

## 🏗️ 技术架构

### 技术栈
- **前端框架**：Next.js 16.1.1 (App Router)
- **语言**：TypeScript 5
- **数据库**：Supabase (PostgreSQL)
- **认证**：Supabase Auth（仅允许 @qimoclothing.com 邮箱）
- **样式**：Tailwind CSS 4
- **状态管理**：React Server Components + Server Actions
- **日期处理**：date-fns
- **邮件通知**：Nodemailer (Tencent 企业邮箱)

### 架构模式
- **数据契约层（Repository Pattern）**：所有数据库写入操作通过统一的 Repository 层
- **状态机（State Machine）**：严格的状态转换规则和校验
- **事件日志（Event Logging）**：完整的操作审计追踪
- **异常驱动（Exception-Driven）**：Dashboard 只显示需要关注的事项

---

## 🎯 核心功能模块

### 1. 用户认证与授权
- **邮箱限制**：仅允许 `@qimoclothing.com` 邮箱注册/登录
- **角色系统**：sales, finance, procurement, production, qc, logistics, admin
- **RLS（Row Level Security）**：基于订单创建者的数据访问控制

### 2. 订单管理
- **订单创建**：支持 FOB/DDP 两种贸易条款
- **订单字段**：
  - 订单号（唯一）
  - 客户名称
  - 贸易条款（FOB/DDP）
  - ETD（FOB 必填）/ 仓库到货日期（DDP 必填）
  - 订单类型（sample/bulk）
  - 包装类型（standard/custom）
- **订单列表**：显示所有订单，支持状态计算（GREEN/YELLOW/RED）

### 3. 执行步骤（里程碑）管理

#### 自动生成
- 创建订单时自动生成 5 个预设执行步骤：
  - PO确认（默认"进行中"）
  - 财务审核（默认"未开始"）
  - 订单资料齐全（默认"未开始"）
  - 订舱完成（默认"未开始"）
  - 出货完成（默认"未开始"）

#### 状态系统
- **4 种状态**（统一使用中文）：
  - `未开始`
  - `进行中`
  - `卡住`
  - `已完成`

#### 状态转换规则（状态机）
```
未开始 -> 进行中 / 卡住
进行中 -> 卡住 / 已完成
卡住 -> 进行中
已完成 -> （禁止，终态）
```

#### 字段结构
- `step_key`：步骤标识
- `name`：步骤名称
- `owner_role`：负责人角色
- `owner_user_id`：具体负责人（可选）
- `planned_at`：计划开始时间
- `due_at`：截止时间
- `status`：状态（中文）
- `notes`：备注/卡住原因（统一字段）
- `is_critical`：是否关键步骤
- `evidence_required`：是否需要证据

#### 自动推进
- 完成一个里程碑后，自动将下一个"未开始"的里程碑推进为"进行中"

### 4. 引导层（Onboarding）

#### 4 步向导式 New Order
- **Step 1**：创建订单（基础信息表单）
- **Step 2**：自动生成里程碑（展示生成的执行步骤列表）
- **Step 3**：执行说明（引导页，说明 4 种状态和使用方法）
- **Step 4**：自动跳转到订单详情页

**特性**：
- URL Query 参数管理 step 状态（`?step=1&order_id=xxx`）
- 刷新页面不丢失当前 step
- 不允许直接跳到 Step 3/4（无 order_id 时自动回到 Step 1）

#### 异常驱动 Dashboard
- **模块 1：已超期**（优先级最高）
  - 条件：`due_at < today` 且 `status != '已完成'`
  - 红色高亮，排在 Dashboard 第一屏
  - 明确文案："这是当前最需要处理的事项"

- **模块 2：今日到期**
  - 条件：`due_at = today` 且 `status != '已完成'`
  - 蓝色高亮

- **模块 3：卡住清单**
  - 条件：`status = '卡住'`
  - 橙色高亮
  - 显示卡住原因（从 notes 提取）
  - 提供"解除卡住"和"查看订单"按钮

**设计原则**：
- 不展示"正常进行中"的事项
- 所有点击路径一步到位，不二级跳转
- 目标用户：CEO / 管理者 / 执行负责人

### 5. 数据契约层（Contract Layer）

#### Repository 模式
- **`lib/repositories/milestonesRepo.ts`**：所有 milestones 写入操作
- **`lib/repositories/ordersRepo.ts`**：所有 orders 写入操作

#### 职责
1. **字段白名单过滤**：移除未知字段，防止 schema drift
2. **状态映射**：英文状态自动映射为中文
3. **默认值填充**：自动填充必填字段的默认值
4. **数据合法性预校验**：在写入前验证数据完整性
5. **事件日志记录**：自动记录所有状态转换和关键操作

#### 禁止直接 Supabase 调用
- 所有页面/组件禁止直接 `supabase.from('milestones').insert/update`
- 必须通过 Repository 层进行写入操作

### 6. 状态机（State Machine）

#### 实现位置
- **`lib/domain/types.ts`**：状态定义和转换规则
- **`lib/repositories/milestonesRepo.ts`**：状态转换校验和日志记录

#### 校验机制
- **Dev 环境**：非法转换抛错（console.error）
- **Prod 环境**：返回可读错误（不 silent fail）
- **统一入口**：`transitionMilestoneStatus()` 函数

### 7. 事件日志（Event Logging）

#### 表结构：`milestone_logs`
- `id`：主键
- `milestone_id`：里程碑 ID
- `order_id`：订单 ID
- `actor_user_id`：操作人 ID
- `action`：操作类型（create, status_transition, update 等）
- `from_status`：原状态（用于状态转换）
- `to_status`：新状态（用于状态转换）
- `note`：备注
- `created_at`：创建时间

#### 价值
- 审计追踪：谁做了什么，什么时候
- 里程碑进展历史回顾
- 状态转换问题调试

### 8. 卡住原因/备注策略

#### 统一策略
- **废弃字段**：不再使用 `blocked_reason` 字段
- **统一字段**：所有原因/备注统一写入 `notes`
- **格式规范**：卡住原因格式为 `卡住原因：xxx`
- **提取工具**：`extractBlockedReason(notes)` 函数

#### 工具函数（`lib/domain/milestone-helpers.ts`）
- `extractBlockedReason(notes)`：从 notes 中提取卡住原因
- `formatBlockedReasonToNotes(reason, existingNotes, append)`：格式化卡住原因到 notes
- `appendToNotes(existingNotes, newContent, timestamp)`：追加 notes（用于日志）

### 9. Domain Helpers（业务逻辑计算）

#### 位置：`lib/domain/milestone-helpers.ts`

#### 函数
- `isMilestoneOverdue(milestone)`：判断里程碑是否超期
- `isMilestoneDueSoon(milestone, hoursThreshold)`：判断是否即将到期（48小时内）
- `extractBlockedReason(notes)`：提取卡住原因
- `formatBlockedReasonToNotes(...)`：格式化卡住原因
- `appendToNotes(...)`：追加 notes

**设计原则**：业务逻辑集中在 domain 层，组件只负责展示

### 10. 订单状态计算

#### 计算逻辑（`lib/utils/order-status.ts`）
- **GREEN**：无卡住且无超期的进行中里程碑
- **YELLOW**：进行中里程碑超过 planned_at 但未超过 due_at，或 <=48h 剩余
- **RED**：任何里程碑卡住，或任何进行中里程碑超期

#### 实时计算
- 不存储在数据库中
- 在订单列表和 Dashboard 中实时计算

### 11. 延迟管理（Delay Management）

#### 功能
- 延迟请求创建
- 延迟请求审批（批准/拒绝）
- 自动重新计算下游里程碑的 due_at

#### 表结构：`delay_requests`
- 延迟原因类型（customer_confirmation, supplier_delay, internal_delay, logistics, force_majeure, other）
- 延迟原因详情
- 提议的新锚点日期（如果影响 ETD/warehouse_due_date）
- 提议的新 due_at（如果只影响单个里程碑）
- 客户审批要求
- 审批状态（pending, approved, rejected）

### 12. 通知系统（Notifications）

#### 表结构：`notifications`
- 通知类型（remind_48, remind_24, remind_12, overdue, blocked）
- 发送对象（email）
- 发送时间
- 唯一约束：防止重复发送

#### 触发条件
- **提醒**：48/24/12 小时前（针对进行中里程碑）
- **超期**：due_at 已过
- **卡住**：状态变为"卡住"时立即发送

#### 邮件通知
- SMTP 配置（Tencent 企业邮箱）
- 自动 CC：su@qimoclothing.com 和 alex@qimoclothing.com（关键里程碑和异常情况）

---

## 📊 数据模型

### 核心表结构

#### `orders` 表
```sql
- id (uuid, PK)
- order_no (text, unique)
- customer_name (text)
- incoterm (FOB/DDP)
- etd (date, nullable, required for FOB)
- warehouse_due_date (date, nullable, required for DDP)
- order_type (sample/bulk)
- packaging_type (standard/custom)
- created_by (uuid, FK -> auth.users)
- notes (text, nullable)
- created_at, updated_at
```

#### `milestones` 表
```sql
- id (uuid, PK)
- order_id (uuid, FK -> orders, CASCADE)
- step_key (text)
- name (text)
- owner_role (sales/finance/procurement/production/qc/logistics/admin)
- owner_user_id (uuid, nullable, FK -> auth.users)
- planned_at (timestamptz, nullable)
- due_at (timestamptz, nullable)
- status (未开始/进行中/卡住/已完成)
- notes (text, nullable) -- 统一字段，包含卡住原因
- is_critical (boolean)
- evidence_required (boolean)
- created_at, updated_at
```

#### `milestone_logs` 表
```sql
- id (uuid, PK)
- milestone_id (uuid, FK -> milestones, CASCADE)
- order_id (uuid, FK -> orders, CASCADE)
- actor_user_id (uuid, FK -> auth.users)
- action (text)
- from_status (text, nullable)
- to_status (text, nullable)
- note (text, nullable)
- created_at (timestamptz)
```

#### `delay_requests` 表
```sql
- id (uuid, PK)
- order_id (uuid, FK -> orders, CASCADE)
- milestone_id (uuid, FK -> milestones, CASCADE)
- requested_by (uuid, FK -> auth.users)
- reason_type (text)
- reason_detail (text)
- proposed_new_anchor_date (date, nullable)
- proposed_new_due_at (timestamptz, nullable)
- requires_customer_approval (boolean)
- customer_approval_evidence_url (text, nullable)
- status (pending/approved/rejected)
- approved_by (uuid, nullable)
- approved_at (timestamptz, nullable)
- decision_note (text, nullable)
- created_at, updated_at
```

#### `notifications` 表
```sql
- id (uuid, PK)
- milestone_id (uuid, FK -> milestones, CASCADE)
- order_id (uuid, FK -> orders, CASCADE)
- kind (remind_48/remind_24/remind_12/overdue/blocked)
- sent_to (text, email)
- sent_at (timestamptz)
- payload (jsonb, nullable)
- created_at
- Unique: (milestone_id, kind, sent_to)
```

---

## 🔐 安全与权限

### Row Level Security (RLS)
- **Orders**：只能访问自己创建的订单
- **Milestones**：只能访问自己订单的里程碑（通过 `is_order_owner()` 函数）
- **Milestone Logs**：只能查看自己订单的日志
- **Delay Requests**：只能访问自己订单的延迟请求

### 函数：`public.is_order_owner(_order_id uuid)`
- 检查当前用户是否为订单创建者
- 用于 RLS 策略

---

## 🎨 UI/UX 设计原则

### 交互规范
- **不出现英文状态值**：所有状态统一显示为中文
- **所有用户可见文案使用中文**
- **不要求用户理解"milestones"**：显示为"执行步骤"
- **卡住相关提示**："卡住不是失败，是为了让系统知道你需要帮助"

### 引导原则
- **用户第一次进来，不需要培训，也能走完整个订单流程**
- **日常使用只需要看 Dashboard，不需要翻表**
- **不引入复杂新概念，最大化复用现有数据结构**
- **所有逻辑服务于"让人少思考"**

### 异常驱动
- Dashboard 不展示"正常进行中"的事项
- 只显示需要关注的事项：今日到期、已超期、卡住清单
- 所有点击路径尽量一步到位，不要二级跳转迷路

---

## 📁 项目结构

```
order-metronome/
├── app/
│   ├── actions/          # Server Actions
│   │   ├── orders.ts     # 订单相关操作
│   │   ├── milestones.ts # 里程碑相关操作
│   │   ├── delays.ts     # 延迟管理
│   │   └── notifications.ts # 通知
│   ├── dashboard/        # Dashboard 页面
│   ├── orders/           # 订单相关页面
│   │   ├── new/          # 4 步向导
│   │   └── [id]/         # 订单详情
│   ├── admin/            # 管理员页面
│   └── login/            # 登录页面
├── components/           # React 组件
│   ├── MilestoneCard.tsx
│   ├── OrderTimeline.tsx
│   ├── MilestoneActions.tsx
│   └── UnblockButton.tsx
├── lib/
│   ├── domain/           # 领域模型
│   │   ├── types.ts      # 状态定义和状态机
│   │   └── milestone-helpers.ts # 业务逻辑计算
│   ├── repositories/     # 数据契约层
│   │   ├── milestonesRepo.ts
│   │   └── ordersRepo.ts
│   ├── utils/            # 工具函数
│   │   ├── date.ts       # 日期处理
│   │   ├── order-status.ts # 订单状态计算
│   │   └── notifications.ts # 通知工具
│   └── supabase/         # Supabase 配置
├── supabase/
│   └── migrations/       # 数据库迁移
└── public/              # 静态资源
```

---

## 🔄 关键流程

### 创建订单流程
1. 用户填写订单信息（Step 1）
2. 系统创建订单记录
3. 系统自动生成 5 个预设里程碑（Step 2）
4. 系统计算每个里程碑的 due_at（基于 ETD/warehouse_due_date）
5. 系统显示执行说明（Step 3）
6. 跳转到订单详情页（Step 4）

### 里程碑状态转换流程
1. 用户点击"完成"或"卡住"按钮
2. Repository 层校验状态转换是否合法
3. 如果合法，更新状态并记录日志
4. 如果完成，自动推进下一个里程碑
5. 如果卡住，发送通知

### Dashboard 数据加载流程
1. 查询已超期里程碑（红色，第一屏）
2. 查询今日到期里程碑（蓝色）
3. 查询卡住清单（橙色）
4. 关联查询订单信息
5. 渲染三个模块

---

## ✅ 已实现功能清单

### 核心功能
- [x] 用户认证（邮箱限制）
- [x] 订单创建和管理
- [x] 里程碑自动生成
- [x] 状态机（状态转换校验）
- [x] 数据契约层（Repository 模式）
- [x] 事件日志（milestone_logs）
- [x] 4 步向导式 New Order
- [x] 异常驱动 Dashboard
- [x] 延迟管理
- [x] 通知系统（邮件 + 站内）

### 架构优化
- [x] 字段白名单过滤（防止 schema drift）
- [x] 状态映射（英文 -> 中文）
- [x] 卡住原因统一策略（notes 字段）
- [x] Domain Helpers（业务逻辑计算）
- [x] 状态机校验（非法转换拦截）

### UI/UX
- [x] 引导层（4 步向导）
- [x] 异常驱动 Dashboard
- [x] 中文文案规范
- [x] 一步到位点击路径

---

## 🧪 测试状态

### 构建状态
- ✅ TypeScript 编译通过
- ✅ 构建成功：`npm run build`
- ✅ 无类型错误

### 测试覆盖
- ✅ 向导流程测试（Step 1-4）
- ✅ Dashboard 功能测试（三个模块）
- ✅ 状态转换测试
- ✅ 数据清洗测试
- ✅ UI 显示测试

### 测试文档
- `TEST_ONBOARDING.md`：详细测试指南
- `QUICK_TEST.md`：快速测试步骤

---

## 📝 技术债务与后续优化

### 已知限制
1. **里程碑模板**：当前使用 5 个预设模板，可扩展为更完整的模板（10-15 个）
2. **类型安全**：Supabase 类型推断处使用 `as any`，可考虑使用 generated types
3. **性能优化**：Dashboard 查询可考虑添加缓存
4. **测试覆盖**：Repository 层缺少单元测试

### 后续优化建议
1. **向导优化**：添加"上一步"按钮、进度保存功能
2. **Dashboard 优化**：添加筛选功能、批量操作、统计信息
3. **通知优化**：定时任务（Cron）自动发送提醒
4. **移动端适配**：响应式设计优化

---

## 🚀 部署信息

### 环境要求
- Node.js 18+
- Supabase 项目
- SMTP 服务器（可选，用于邮件通知）

### 环境变量
```env
NEXT_PUBLIC_SUPABASE_URL=...
NEXT_PUBLIC_SUPABASE_ANON_KEY=...
NEXT_PUBLIC_SITE_URL=...
SMTP_HOST=...
SMTP_PORT=...
SMTP_USER=...
SMTP_PASSWORD=...
```

### 数据库迁移
- `supabase/migration.sql`：基础表结构
- `supabase/migrations/20240101000000_add_milestone_logs.sql`：事件日志表

---

## 📚 相关文档

- `START_HERE.md`：快速启动指南
- `ARCHITECTURE_REFACTOR.md`：架构收敛文档
- `ONBOARDING_GUIDE.md`：引导层实现文档
- `TEST_ONBOARDING.md`：测试指南
- `QUICK_TEST.md`：快速测试步骤

---

## 🎯 设计目标达成情况

### 目标 1：防止 Schema Drift
✅ **达成**：通过 Repository 层的字段白名单过滤，所有未知字段自动移除

### 目标 2：状态统一
✅ **达成**：统一使用中文状态，自动映射英文状态

### 目标 3：边界清晰
✅ **达成**：卡住原因/备注统一使用 notes 字段，格式规范

### 目标 4：用户引导
✅ **达成**：4 步向导式 New Order，异常驱动 Dashboard

### 目标 5：减少思考
✅ **达成**：自动生成里程碑，自动推进，只显示异常事项

---

**文档版本**：v1.0  
**最后更新**：2024-01-14  
**维护者**：Order Metronome Team

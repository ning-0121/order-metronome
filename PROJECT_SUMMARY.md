# 订单节拍器项目摘要（供 ChatGPT 审核）

## 项目定位
基于 Next.js + TypeScript + Supabase 的订单执行管理系统，通过自动生成执行步骤、状态机管理、异常驱动 Dashboard 等机制，帮助团队高效协作。

## 核心架构

### 1. 数据契约层（Repository Pattern）
- **位置**：`lib/repositories/milestonesRepo.ts`、`ordersRepo.ts`
- **职责**：字段白名单过滤、状态映射、默认值填充、数据合法性校验
- **禁止**：所有页面/组件禁止直接 `supabase.from('milestones').insert/update`

### 2. 状态机（State Machine）
- **状态**：`未开始`、`进行中`、`卡住`、`已完成`（统一中文）
- **转换规则**：
  ```
  未开始 -> 进行中 / 卡住
  进行中 -> 卡住 / 已完成
  卡住 -> 进行中
  已完成 -> （禁止，终态）
  ```
- **校验**：Dev 环境抛错，Prod 环境返回可读错误

### 3. 事件日志（Event Logging）
- **表**：`milestone_logs`
- **记录**：所有状态转换和关键操作（who, what, when）
- **价值**：审计追踪、历史回顾、问题调试

### 4. 引导层（Onboarding）
- **4 步向导**：创建订单 → 生成里程碑 → 执行说明 → 进入执行
- **异常驱动 Dashboard**：只显示"今日到期"、"已超期"、"卡住清单"

## 核心功能

### 订单管理
- 支持 FOB/DDP 两种贸易条款
- 自动生成 5 个预设执行步骤（里程碑）
- 实时计算订单状态（GREEN/YELLOW/RED）

### 里程碑管理
- 自动生成：创建订单时自动生成执行步骤
- 状态机：严格的状态转换规则和校验
- 自动推进：完成一个里程碑后自动推进下一个
- 卡住原因：统一使用 `notes` 字段，格式 `卡住原因：xxx`

### Dashboard
- **已超期**（红色，第一屏，优先级最高）
- **今日到期**（蓝色）
- **卡住清单**（橙色，可解除卡住）

## 技术栈
- Next.js 16.1.1 (App Router)
- TypeScript 5
- Supabase (PostgreSQL)
- Tailwind CSS 4
- React Server Components + Server Actions

## 数据模型

### 核心表
- `orders`：订单信息
- `milestones`：执行步骤（里程碑）
- `milestone_logs`：事件日志
- `delay_requests`：延迟请求
- `notifications`：通知记录

### 关键字段
- `milestones.status`：状态（统一中文）
- `milestones.notes`：备注/卡住原因（统一字段）
- `milestones.owner_role`：负责人角色

## 安全与权限
- RLS（Row Level Security）：基于订单创建者的数据访问控制
- 邮箱限制：仅允许 `@qimoclothing.com` 邮箱注册/登录

## 设计原则
1. **防止 Schema Drift**：Repository 层字段白名单过滤
2. **状态统一**：统一使用中文状态，自动映射英文状态
3. **边界清晰**：卡住原因/备注统一使用 notes 字段
4. **用户引导**：4 步向导式 New Order，异常驱动 Dashboard
5. **减少思考**：自动生成里程碑，自动推进，只显示异常事项

## 已实现功能
- ✅ 用户认证（邮箱限制）
- ✅ 订单创建和管理
- ✅ 里程碑自动生成
- ✅ 状态机（状态转换校验）
- ✅ 数据契约层（Repository 模式）
- ✅ 事件日志（milestone_logs）
- ✅ 4 步向导式 New Order
- ✅ 异常驱动 Dashboard
- ✅ 延迟管理
- ✅ 通知系统（邮件 + 站内）

## 构建状态
- ✅ TypeScript 编译通过
- ✅ 构建成功：`npm run build`
- ✅ 无类型错误

## 文档
- `PROJECT_OVERVIEW.md`：完整项目概述（542行）
- `ARCHITECTURE_REFACTOR.md`：架构收敛文档
- `ONBOARDING_GUIDE.md`：引导层实现文档
- `TEST_ONBOARDING.md`：测试指南

---

**请 ChatGPT 审核的重点**：
1. 架构设计是否合理（Repository Pattern、State Machine、Event Logging）
2. 状态机转换规则是否完整
3. 数据模型设计是否合理
4. 安全与权限设计是否充分
5. 用户体验设计是否符合"减少思考"的原则
6. 是否有潜在的技术债务或风险

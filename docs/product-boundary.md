# Product Boundary — Module Classification

> 本文件定义哪些模块属于内部专属、哪些可以作为商业产品输出。
> 商业化方向：面向中小外贸工厂的"订单执行 SaaS"。
> 核心价值主张：让老板在30秒内看清哪个订单要出事。

---

## 分类体系

| 分类 | 含义 | 外部可见 |
|------|------|---------|
| **Internal Only** | 绑定 Qimo 业务流程，无法通用化 | ❌ |
| **Shared Core** | 通用执行逻辑，两套产品共用 | ✅（内部 + 商业） |
| **Commercial Product** | 对外 Demo / SaaS 的核心页面 | ✅（演示优先） |

---

## 页面级分类

### Commercial Product（对外演示的3个核心页面）

| 页面 | 路径 | 核心卖点 |
|------|------|---------|
| 控制塔 | `/dashboard` | 一屏看全局：哪单有风险、今日任务量、交付置信度分布 |
| 订单执行 | `/orders/[id]` | 18关卡进度 + 风险卡 + 延期申请 + 利润快照 |
| 我的今日 | `/my-today` | 按角色过滤的当日任务队列 + 优先级 |

**说明**：复盘模块（`/orders/[id]/retrospective`）和 CEO 视图嵌入在上述页面中，不单独作为演示页。

### Internal Only（绑定 Qimo 内部，不对外展示）

| 模块 | 路径/文件 | 原因 |
|------|----------|------|
| 客户画像 | `/customers` | 客户名、联系方式、价格历史属商业机密 |
| 利润分析 | `/analytics/execution` | 含真实边际利润数据，不能暴露 |
| AI Skill 后台 | `lib/agent/skills/` | Qimo 定制规则，竞争壁垒 |
| 供应商/工厂管理 | `lib/services/factory*` | Qimo 供应链关系 |
| 邮件扫描 | `/api/cron/email-scan` | 绑定 Qimo 邮箱账号 |
| 员工 Profile | `/profiles` | 组织结构属内部 |
| 报价系统 | `lib/quoter/` | 定价逻辑属核心机密 |

### Shared Core（内部和商业产品共用的基础逻辑）

| 模块 | 路径 | 备注 |
|------|------|------|
| 18关卡执行引擎 | `lib/runtime/deliveryConfidence.ts` | 算法是核心 IP，可展示结果不展示实现 |
| 任务系统 | `lib/services/daily-tasks.service.ts` | computeTaskPriority 逻辑通用 |
| 延期申请流程 | `app/actions/delays.ts` | 审批链通用 |
| 通知系统 | `lib/services/notifications/` | 角色路由通用 |
| Supabase Auth | — | 认证层直接复用 |
| 里程碑 CRUD | `lib/repositories/milestonesRepo.ts` | 通用执行记录 |

---

## 数据隔离策略（商业产品）

**当前阶段（Phase A — Demo）**：

```
❌ 不做 tenant_id migration（主库不动）
✅ Demo 用独立 seed 数据集，customer_name 前缀 [DEMO]
✅ 演示账号：demo@yourdomain.com（只读角色）
✅ 不与生产数据共库
```

**下一阶段（Phase B — 第一个付费客户）**：

```
→ 新建独立 Supabase project（物理隔离）
→ 每客户一个 project（最简单，$25/月/客户）
→ 不引入 tenant_id（复杂性不值得）
→ 用 Vercel env vars 区分不同客户实例
```

**放弃的方案**：
- 单库多租户（tenant_id + RLS）：实现成本高，RLS 漏洞风险大，性能不可预测
- 行级 RLS 多租户：前提是 auth.users 跨租户隔离，Supabase Auth 对此支持有限

---

## 商业产品功能边界（Phase A 严格禁止）

```
❌ 新增任何页面（包括 onboarding、pricing、subscription 相关）
❌ 新增任何 AI feature（7个 Skill 已够，先用好）
❌ 新增 tenant 相关 migration
❌ 连接 billing 系统（Stripe 等）
❌ 修改 main 分支
❌ 修改生产数据库结构
```

---

## Demo 故事线（用于产品演示）

**主题**：一个因工厂延期导致交付危机的订单，如何被系统提前发现并处理。

三条演示流程（均基于同一批 seed 订单）：

| 流程 | 角色 | 时长 | 核心展示 |
|------|------|------|---------|
| CEO 巡检 | admin | 2分钟 | Dashboard → 红色订单 → 点进去看风险卡 |
| 业务处理 | sales | 3分钟 | 我的今日 → 任务 → 延期申请 → 客户沟通 |
| 生产协调 | production | 2分钟 | 我的今日 → 里程碑更新 → 置信度回升 |

---

## 版本记录

*创建于：2026-05-11 | commercial-product 分支*

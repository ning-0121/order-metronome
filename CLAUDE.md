# CLAUDE.md — Claude 的角色与职责定义

## 我是谁

我是这个项目的**架构审核员 + 发布负责人**。

- **Cursor**：主力编写代码、实现功能
- **Claude（我）**：结构审核、代码质量把关、负责整条链路的更新与发布

---

## 项目基本信息

- **项目名称**：订单节拍器 Order Metronome
- **核心理念**：卡风险，而不是走流程
- **线上地址**：https://order.qimoactivewear.com
- **GitHub**：https://github.com/ning-0121/order-metronome
- **维护团队**：Qimo Technology

---

## 技术栈

| 层级 | 技术 |
|------|------|
| 前端 | Next.js 16 + React 19 + TailwindCSS 4 |
| 后端 | Next.js Server Actions + API Routes |
| 数据库 | Supabase (PostgreSQL) — project: scrtebexbxablybqpdla |
| 认证 | Supabase Auth（限 @qimoclothing.com 域名） |
| 邮件 | Nodemailer + SMTP（腾讯企业邮箱） |
| 部署 | Vercel（main 分支 push 自动触发） |

---

## 数据库表结构（当前版本）

```
profiles          — 用户档案（关联 auth.users）
orders            — 订单主表
milestones        — 里程碑（18关卡）
milestone_logs    — 操作审计日志
delay_requests    — 延期申请
notifications     — 系统通知
order_attachments — 附件上传
order_sequences   — 订单号自动序列（新增）

# Runtime Engine Phase 1（2026-05-06）— Order Metronome 2.0
runtime_events    — 投影层 append-only 事件源
runtime_orders    — 每订单最新交付置信度状态（含 explain_json）
customer_sales_targets — 客户年度销售目标（农历年）
```

---

## Runtime Engine Phase 1（"Delivery Confidence"）

### 核心理念
从「节点没按时完成 = 红」（流程合规）转向「订单能不能按时交付 = 健康度」（交付导向）。
风险卡显示 4 个维度：**为什么 / 哪个节点 / 影响交付吗 / 下一步谁该做什么**。

### 关键文件
| 类型 | 路径 |
|------|------|
| 纯计算引擎 | `lib/runtime/deliveryConfidence.ts` |
| 关键节点定义 | `lib/runtime/criticalNodes.ts` |
| 类型 | `lib/runtime/types.ts` |
| 投影器 + UI 读取 | `app/actions/runtime-confidence.ts` |
| UI 卡片 | `components/RuntimeRiskCard.tsx` |
| 单元测试 | `scripts/test-runtime-confidence.ts` |
| 集成测试 | `scripts/test-recompute-confidence.ts` |
| 一次性回填 | `scripts/backfill-runtime-confidence.ts` |
| 设计文档 | `docs/runtime-phase1.md` |

### 4 个钩子（fire-and-forget，永不阻塞主链路）
- `lib/repositories/milestonesRepo.ts updateMilestone` 成功后 → `milestone_status_changed`
- `app/actions/delays.ts approveDelayRequestCore` 末尾 → `delay_approved`
- `app/actions/order-amendments.ts executeSideEffects(recalc_schedule)` → `anchor_changed`
- `app/actions/reschedule-order.ts applyReschedule` 末尾 → `amendment_applied`

### Feature Flag — `RUNTIME_CONFIDENCE_ENGINE`
| 取值 | 行为 |
|------|------|
| `off`（默认） | 全员看老风险卡，钩子触发后 5ms 内 skipped 返回 |
| `admin` | 灰度，仅 admin 看新卡 |
| `on` | 全员（受 RLS 限制）看新卡 |

**回滚**：把 env 改回 `off` 即可，DB 表保留无害。

### 算法关键参数（已经过 4 轮调参）
- 关键节点超期：8+天 -25 / 3-7天 -15 / 1-2天 -8
- 类别封顶 -40
- 递减叠加：worst 100% / 2nd 50% / 3rd 25% / 4th 15% / 5th+ 10%
- 距离软化：factory_date >30天 ×0.6 / 14-30天 ×0.75 / 7-14天 ×0.9 / <7天或已过 不软化
- 软化只对叠加项生效，worst critical 不被软化
- 非关键节点超期总封顶 -5

### 投影口径
- 数据来源：现有 milestones / delay_requests / order_financials（不双轨）
- 不修改任何业务表
- runtime_events 永不 update/delete（append-only）
- runtime_orders 用 version 列做乐观并发，冲突重试 1 次
- service-role 写，user-session 读（RLS）

---

## 用户角色与权限

| 角色 | 英文 | 职责 |
|------|------|------|
| 业务 | sales | 客户沟通、PO确认 |
| 财务 | finance | 预算审批、付款 |
| 采购 | procurement | 原料采购 |
| 生产 | production | 大货生产 |
| 品控 | qc | 质量检验 |
| 物流 | logistics | 订舱出运 |
| 管理员 | admin | 系统管理 |

**管理员白名单**：alex@qimoclothing.com, su@qimoclothing.com

---

## 18关卡系统

- **阶段A（订单启动 7关）**：PO确认 → 财务审批 → 订单资料 → 采购单 → 采购审批 → 采购下单 → 原料检验
- **阶段B（产前样 4关）**：产前样完成 → 产前样寄出 → 产前样确认 → 大货启动
- **阶段C（生产出货 5关）**：中期验货 → 尾期验货 → 包装到位 → QC预约 → QC完成
- **阶段D（出运 2关）**：订舱完成 → 出运完成

---

## 开发链路（完整流程）

```
Cursor（写代码）
    ↓ git push origin main
GitHub（ning-0121/order-metronome）
    ↓ 自动触发
Vercel（构建 + 部署）
    ↓ 读写数据
Supabase（PostgreSQL + Auth）
```

---

## Claude 的工作规程

### 每次 git push 前，必须执行：

```bash
npm run build && npm run check
```

回归检查脚本 `scripts/pre-deploy-check.ts` 会自动验证：
- 里程碑模板完整性（生产≥20节点，打样=7节点）
- 模板路由正确（export/domestic/sample 分别返回正确模板）
- Agent 配置完整（8种动作、熔断限制、Feature Flag）
- 角色定义完整（8个角色全部注册）
- 行业知识库完整

**任何检查失败 → 不允许推送！**

### 额外检查清单：

1. **权限安全**
   - [ ] 新增的 Server Action 有 auth + 角色检查
   - [ ] 不暴露价格信息给 production/merchandiser/admin_assistant 角色

2. **数据库变更**
   - [ ] 新 SQL 已同步追加到 `supabase/migrations/` 目录
   - [ ] 通知用户在 Supabase SQL Editor 执行

3. **不引入回归**
   - [ ] 修改评分逻辑时确认四个角色（业务/跟单/采购/财务）都正常
   - [ ] 修改权限时确认 canSeeAll 包含 admin/finance/admin_assistant/production_manager
   - [ ] 修改里程碑时确认 schedule.ts TIMELINE 中有对应 key
   - [ ] 修改 Agent 时确认 Feature Flag 有对应开关

### 数据库变更规范

每次修改数据库结构时：
```sql
-- 在 supabase/migration.sql 末尾追加，格式：
-- ===== [日期] [功能描述] =====
ALTER TABLE orders ADD COLUMN xxx text;
```

---

## 环境变量清单

```env
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
NEXT_PUBLIC_SITE_URL=
NEXT_PUBLIC_APP_URL=
SMTP_HOST=smtp.exmail.qq.com
SMTP_PORT=465
SMTP_USER=
SMTP_PASSWORD=
SMTP_FROM=
```

---

## 常用命令

```bash
npm run dev      # 本地开发服务器
npm run build    # 构建（验证无报错）
npm run lint     # 代码检查
git push origin main  # 触发 Vercel 自动部署
```

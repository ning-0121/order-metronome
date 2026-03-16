# CLAUDE.md — Claude 的角色与职责定义

## 我是谁

我是这个项目的**架构审核员 + 发布负责人**。

- **Cursor**：主力编写代码、实现功能
- **Claude（我）**：结构审核、代码质量把关、负责整条链路的更新与发布

---

## 项目基本信息

- **项目名称**：订单节拍器 Order Metronome
- **核心理念**：卡风险，而不是走流程
- **线上地址**：https://order-metronome.vercel.app
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
```

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

### 每次发布前，我会检查：

1. **代码审核**
   - [ ] TypeScript 类型是否正确（无 any 滥用）
   - [ ] Server Actions 是否有权限校验
   - [ ] RLS 策略是否覆盖新表/新操作
   - [ ] 无 console.log 遗留在生产代码中

2. **数据库变更**
   - [ ] 新 SQL 已同步追加到 `supabase/migration.sql`
   - [ ] 已在 Supabase SQL Editor 手动执行
   - [ ] RLS 策略已为新表配置

3. **环境变量**
   - [ ] 新增变量已在 Vercel 环境变量中配置
   - [ ] 已同步更新 README 中的环境变量示例

4. **部署验证**
   - [ ] Vercel 构建状态为 Ready（无 Error）
   - [ ] 线上地址功能正常访问
   - [ ] 无 console 报错

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

# 订单节拍器 Order Metronome

> 外贸订单执行追踪系统 | Foreign Trade Order Tracking System
>
> **核心理念：卡风险，而不是走流程**

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/ning-0121/order-metronome)

## 产品文档

- **[完整产品手册](./docs/PRODUCT_MANUAL.md)** - 详细功能说明、操作指南、常见问题

## 功能概览

### 核心功能

| 功能 | 说明 |
|------|------|
| **18关卡系统** | 覆盖订单全生命周期的关键控制点 |
| **智能排期** | 基于ETD/入仓日自动倒推计算里程碑日期 |
| **风险预警** | 红黄绿灯状态，超期/阻塞实时告警 |
| **延期管理** | 延期申请-审批流程，自动级联更新 |
| **邮件提醒** | 到期前7天/3天/当天自动提醒 |
| **复盘沉淀** | 订单完成后强制复盘，沉淀经验 |

### 页面结构

```
/dashboard     - 我的工作台（超期、今日到期、阻塞、待复盘）
/orders        - 订单列表
/orders/new    - 新建订单（4步向导）
/orders/[id]   - 订单详情（里程碑时间线）
/admin         - 管理后台（风险订单、瓶颈分析）
/admin/ceo     - CEO控制台（今日必须处理、延期审批）
```

### 用户角色

| 角色 | 英文 | 职责 |
|------|------|------|
| 业务 | sales | 客户沟通、PO确认 |
| 财务 | finance | 预算审批、付款 |
| 采购 | procurement | 原料采购 |
| 生产 | production | 大货生产 |
| 品控 | qc | 质量检验 |
| 物流 | logistics | 订舱出运 |
| 管理员 | admin | 系统管理 |

## 技术栈

- **前端**: Next.js 16 + React 19 + TailwindCSS 4
- **后端**: Next.js Server Actions + API Routes
- **数据库**: Supabase (PostgreSQL)
- **认证**: Supabase Auth
- **邮件**: Nodemailer + SMTP (腾讯企业邮箱)

## 快速开始

### 1. 环境要求

- Node.js 18+
- Supabase 账号
- SMTP 邮箱配置

### 2. 安装

```bash
npm install
```

### 3. 环境变量

创建 `.env.local` 文件：

```env
NEXT_PUBLIC_SUPABASE_URL=your_supabase_url
NEXT_PUBLIC_SUPABASE_ANON_KEY=your_supabase_anon_key
NEXT_PUBLIC_SITE_URL=http://localhost:3000

# SMTP 配置
SMTP_HOST=smtp.exmail.qq.com
SMTP_PORT=465
SMTP_USER=your_email@qimoclothing.com
SMTP_PASSWORD=your_password
SMTP_FROM=noreply@qimoclothing.com
```

### 4. 数据库初始化

在 Supabase SQL Editor 中执行 `supabase/migration.sql`

### 5. 启动开发服务器

```bash
npm run dev
```

访问 http://localhost:3000

## 项目结构

```
order-metronome/
├── app/
│   ├── actions/          # Server Actions
│   ├── api/              # API Routes (nudge, cron)
│   ├── admin/            # 管理后台
│   │   └── ceo/          # CEO控制台
│   ├── dashboard/        # 我的工作台
│   ├── orders/           # 订单管理
│   │   ├── new/          # 新建订单
│   │   └── [id]/         # 订单详情
│   │       └── retrospective/  # 订单复盘
│   └── login/            # 登录页
├── components/           # React 组件
├── lib/
│   ├── domain/           # 业务逻辑 (gates, requirements)
│   ├── supabase/         # 数据库客户端
│   └── utils/            # 工具函数
├── docs/
│   └── PRODUCT_MANUAL.md # 产品手册
└── supabase/
    └── migration.sql     # 数据库迁移
```

## 核心模块

### 18关卡系统

```
阶段A: 订单启动 (7关)
├── PO确认 → 财务审批 → 订单资料 → 采购单 → 采购审批 → 采购下单 → 原料检验

阶段B: 产前样 (4关)
├── 产前样完成 → 产前样寄出 → 产前样确认 → 大货启动

阶段C: 生产出货 (5关)
├── 中期验货 → 尾期验货 → 包装到位 → QC预约 → QC完成

阶段D: 出运 (2关)
└── 订舱完成 → 出运完成
```

### 订单状态机

```
草稿 → 已生效 → 执行中 → 已完成/已取消 → 待复盘 → 已复盘
```

### 里程碑状态

- ⚪ **未开始**: 等待前置条件
- 🔵 **进行中**: 正在处理
- 🟠 **卡住**: 遇到阻塞
- 🟢 **已完成**: 完成（终态）

## 部署

### Vercel（推荐）

1. Fork 本仓库
2. 在 Vercel 导入项目
3. 配置环境变量
4. 部署完成

### 其他平台

支持所有 Next.js 部署平台，确保环境变量配置正确。

## 开发命令

```bash
npm run dev      # 开发服务器
npm run build    # 构建
npm run start    # 生产服务器
npm run lint     # 代码检查
```

## 访问限制

- 仅限 `@qimoclothing.com` 邮箱域名登录
- 管理员：alex@qimoclothing.com, su@qimoclothing.com

## License

MIT

---

**版本**: v1.0
**维护**: Qimo Technology

# 🚀 快速启动指南

## 第一步：检查依赖

如果还没有安装依赖，先安装：

```bash
cd /Users/ning/order-metronome
npm install
```

## 第二步：配置环境变量

创建 `.env.local` 文件（在项目根目录）：

```bash
# 在项目根目录执行
touch .env.local
```

然后编辑 `.env.local`，填入以下内容：

```env
# Supabase 配置（必需）
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=your-anon-key

# 站点 URL（开发环境）
NEXT_PUBLIC_SITE_URL=http://localhost:3000

# SMTP 配置（可选，用于邮件通知）
SMTP_HOST=smtp.exmail.qq.com
SMTP_PORT=465
SMTP_USER=your-email@qimoclothing.com
SMTP_PASSWORD=your-password
SMTP_FROM=noreply@qimoclothing.com

# Cron Secret（用于保护定时任务端点，可选）
CRON_SECRET=your-random-secret-key-here
```

**如何获取 Supabase 配置：**
1. 登录 [Supabase Dashboard](https://app.supabase.com)
2. 选择你的项目
3. 进入 Settings → API
4. 复制 `Project URL` 到 `NEXT_PUBLIC_SUPABASE_URL`
5. 复制 `anon public` key 到 `NEXT_PUBLIC_SUPABASE_ANON_KEY`

## 第三步：运行数据库迁移

在 Supabase SQL Editor 中按顺序执行：

1. **基础迁移**：运行 `supabase/migration.sql`
2. **里程碑迁移**：运行 `supabase/migration_milestones.sql`
3. **T5/T4/T6 迁移**：运行 `supabase/migration_t5_t4_t6.sql`

## 第四步：启动开发服务器

```bash
npm run dev
```

看到以下输出表示启动成功：
```
  ▲ Next.js 16.1.1
  - Local:        http://localhost:3000
  - Environments: .env.local
```

## 第五步：打开浏览器

访问：**http://localhost:3000**

## 📱 使用流程

1. **首次访问**：会自动跳转到 `/login` 页面
2. **注册账号**：使用 `@qimoclothing.com` 邮箱注册
3. **登录后**：会跳转到 `/dashboard`（My Beats 页面）

## 🔍 检查是否正常运行

### 1. 检查依赖
```bash
npm list --depth=0
```

### 2. 检查环境变量
```bash
# 在项目根目录
cat .env.local
# 确保能看到 Supabase 配置
```

### 3. 检查数据库连接
- 打开 http://localhost:3000/login
- 尝试登录/注册
- 如果出现错误，检查 Supabase 配置

### 4. 检查编译错误
```bash
npm run build
```

## 🐛 常见问题

### 问题 1: 端口 3000 已被占用
```bash
# 使用其他端口启动
PORT=3001 npm run dev
# 然后访问 http://localhost:3001
```

### 问题 2: 找不到模块
```bash
# 重新安装依赖
rm -rf node_modules package-lock.json
npm install
```

### 问题 3: Supabase 连接错误
- 检查 `.env.local` 中的 URL 和 KEY 是否正确
- 检查 Supabase 项目是否正常运行
- 检查网络连接

### 问题 4: 数据库表不存在
- 确保已经运行了所有迁移 SQL
- 检查 Supabase SQL Editor 中是否有报错

## 📂 项目结构说明

- `/login` - 登录/注册页面
- `/dashboard` - 我的工作台（用户专属里程碑）
- `/orders` - 订单列表
- `/orders/new` - 创建新订单
- `/orders/[id]` - 订单详情页
- `/admin` - 管理员仪表板

## 🎯 下一步

启动成功后，参考 `TESTING_GUIDE.md` 进行功能测试！

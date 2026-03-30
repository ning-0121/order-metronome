# 🚀 部署与使用指南

## ✅ 内部测试使用

### 当前状态检查

项目已经可以正常构建和运行。要开始内部测试，请按以下步骤操作：

### 1. 检查环境配置

确保 `.env.local` 文件已配置：

```bash
# 检查环境变量文件是否存在
ls -la .env.local
```

必需的环境变量：
- `NEXT_PUBLIC_SUPABASE_URL` - Supabase 项目 URL
- `NEXT_PUBLIC_SUPABASE_ANON_KEY` - Supabase 匿名密钥
- `NEXT_PUBLIC_SITE_URL` - 站点 URL（开发环境用 `http://localhost:3000`）

可选的环境变量（用于邮件通知）：
- `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM`

### 2. 确认数据库迁移已完成

在 Supabase SQL Editor 中确认已执行：
- `supabase/migration.sql`
- `supabase/migration_milestones.sql`
- `supabase/migration_t5_t4_t6.sql`

### 3. 启动开发服务器

```bash
npm run dev
```

访问：**http://localhost:3000**

### 4. 同一局域网内访问

如果其他设备在同一局域网（WiFi），可以通过本机 IP 访问：

**macOS/Linux:**
```bash
# 查看本机 IP 地址
ifconfig | grep "inet " | grep -v 127.0.0.1
# 或
ipconfig getifaddr en0  # macOS
```

**Windows:**
```bash
ipconfig
```

然后修改启动命令，允许外部访问：

```bash
# 方式 1：使用 -H 0.0.0.0
npm run dev -- -H 0.0.0.0

# 方式 2：设置环境变量
HOSTNAME=0.0.0.0 npm run dev
```

其他设备访问：`http://你的IP地址:3000`

例如：`http://192.168.1.100:3000`

---

## 🌐 不同局域网之间使用

有几种方案可以实现跨局域网访问：

### 方案 1：部署到 Vercel（推荐 ⭐）

**优点：**
- 免费，简单易用
- 自动 HTTPS
- 全球 CDN 加速
- 自动部署

**步骤：**

1. **准备代码仓库**
   ```bash
   # 如果还没有 Git 仓库
   git init
   git add .
   git commit -m "Initial commit"
   
   # 推送到 GitHub
   git remote add origin <your-github-repo-url>
   git push -u origin main
   ```

2. **在 Vercel 部署**
   - 访问 [vercel.com](https://vercel.com)
   - 使用 GitHub 账号登录
   - 点击 "New Project"
   - 导入你的 GitHub 仓库
   - 配置环境变量（在 Vercel 项目设置中添加 `.env.local` 中的所有变量）
   - 点击 "Deploy"

3. **更新环境变量**
   
   在 Vercel 项目设置中，将 `NEXT_PUBLIC_SITE_URL` 更新为 Vercel 提供的域名：
   ```
   NEXT_PUBLIC_SITE_URL=https://your-project.vercel.app
   ```

4. **完成**
   
   部署完成后，你会得到一个公网可访问的 URL，例如：
   ```
   https://order-metronome.vercel.app
   ```
   
   任何有网络的地方都可以访问！

---

### 方案 2：使用内网穿透工具

**适用场景：** 临时测试，不想部署到公网

#### 2.1 使用 ngrok（最简单）

1. **安装 ngrok**
   ```bash
   # macOS
   brew install ngrok
   
   # 或下载：https://ngrok.com/download
   ```

2. **注册并获取 token**
   - 访问 [ngrok.com](https://ngrok.com) 注册账号
   - 获取 authtoken

3. **配置 ngrok**
   ```bash
   ngrok config add-authtoken <your-token>
   ```

4. **启动本地服务**
   ```bash
   npm run dev
   ```

5. **启动 ngrok**
   ```bash
   ngrok http 3000
   ```

6. **获取公网 URL**
   
   ngrok 会显示一个公网 URL，例如：
   ```
   Forwarding: https://abc123.ngrok.io -> http://localhost:3000
   ```
   
   将这个 URL 分享给其他局域网的用户即可访问。

**注意：** 免费版 ngrok 每次重启 URL 会变化，付费版可以固定域名。

#### 2.2 使用 Cloudflare Tunnel（免费，更稳定）

1. **安装 cloudflared**
   ```bash
   # macOS
   brew install cloudflared
   ```

2. **创建隧道**
   ```bash
   cloudflared tunnel --url http://localhost:3000
   ```

3. **获取公网 URL**
   
   会显示类似：`https://random-name.trycloudflare.com`

---

### 方案 3：部署到自己的服务器

**适用场景：** 有公网 IP 的服务器或云服务器

#### 3.1 使用 PM2 部署

1. **在服务器上安装依赖**
   ```bash
   # 克隆代码
   git clone <your-repo-url>
   cd order-metronome
   
   # 安装依赖
   npm install
   
   # 安装 PM2
   npm install -g pm2
   ```

2. **配置环境变量**
   ```bash
   # 创建 .env.local
   nano .env.local
   # 填入所有环境变量
   ```

3. **构建项目**
   ```bash
   npm run build
   ```

4. **使用 PM2 启动**
   ```bash
   pm2 start npm --name "order-metronome" -- start
   ```

5. **配置 Nginx 反向代理（可选）**
   
   创建 `/etc/nginx/sites-available/order-metronome`:
   ```nginx
   server {
       listen 80;
       server_name your-domain.com;
       
       location / {
           proxy_pass http://localhost:3000;
           proxy_http_version 1.1;
           proxy_set_header Upgrade $http_upgrade;
           proxy_set_header Connection 'upgrade';
           proxy_set_header Host $host;
           proxy_cache_bypass $http_upgrade;
       }
   }
   ```

6. **配置域名和 SSL（可选）**
   ```bash
   # 使用 Let's Encrypt
   certbot --nginx -d your-domain.com
   ```

---

### 方案 4：使用 VPN

**适用场景：** 公司内部使用，需要安全访问

如果所有用户都在同一个 VPN 网络中，可以直接使用方案 1（同一局域网访问）的方法。

---

## 📋 快速检查清单

在开始使用前，请确认：

- [ ] `.env.local` 文件已配置
- [ ] Supabase 数据库迁移已完成
- [ ] `npm run build` 构建成功
- [ ] `npm run dev` 可以正常启动
- [ ] 可以访问 `http://localhost:3000`
- [ ] 可以注册/登录（使用 @qimoclothing.com 邮箱）

---

## 🔧 常见问题

### Q1: 如何让 Next.js 允许外部访问？

修改 `package.json` 中的 dev 脚本：
```json
{
  "scripts": {
    "dev": "next dev -H 0.0.0.0"
  }
}
```

### Q2: 防火墙阻止了访问怎么办？

**macOS:**
```bash
# 允许端口 3000
sudo pfctl -f /etc/pf.conf
```

**Linux:**
```bash
# 允许端口 3000
sudo ufw allow 3000
```

**Windows:**
- 在 Windows 防火墙中添加端口 3000 的入站规则

### Q3: Vercel 部署后邮件通知不工作？

检查 Vercel 环境变量中是否配置了 SMTP 相关变量。

### Q4: 如何查看当前运行状态？

```bash
# 检查进程
ps aux | grep next

# 检查端口占用
lsof -i :3000
```

---

## 🎯 推荐方案

**开发测试阶段：**
- 使用 `npm run dev -H 0.0.0.0` 在同一局域网内测试

**正式使用：**
- **首选：** 部署到 Vercel（最简单，免费）
- **备选：** 使用 ngrok 临时测试
- **企业：** 部署到自己的服务器

---

**最后更新：** 2024-01-21

# 三系统迁香港 · 迁移 Runbook（V1.0 · 2026-07-04）

> 目标：把 **订单节拍器 / 财务系统 / 客户开发系统(araos)** 的 Supabase 数据库 + Vercel 函数
> 全部迁到**香港区**（Supabase `East Asia (Hong Kong)` = ap-east-1；Vercel `hkg1`），
> 服务器与数据库同区、又离中国团队最近。预期中国用户 TTFB 1.5s → 0.3-0.5s，全线快 3-5 倍。
>
> **根因回顾（有实测）**：三系统原都在美东 iad1 + Supabase 在美国。慢的大头是"服务器↔数据库"跨太平洋。
> 单搬 Vercel 到香港会让"香港服务器→美国库"更慢（实测 DB 查询 463ms→2190ms）。所以**库和服务器必须一起搬**。

---

## ⚠️ 铁律

1. **一次只迁一个系统,先拿节拍器练手**（有旧库随时回滚,跑通再上财务/araos）。
2. **旧项目全程保留**,验证通过、观察 1-2 天再删,任何异常立刻把 env 指回旧库即回滚。
3. **在中国深夜低峰做**（团队不在线时),割接窗口约 30-60 分钟/系统。
4. **自定义域名不变**（order.qimoactivewear.com / finance.qimoactivewear.com / araos 域名）——
   三系统互相调用靠的是**域名 + HMAC 密钥**,不是 Supabase 项目 ref。所以只要域名重新指到新部署,
   **跨系统契约(webhook/契约API/OS跳转)自动继续生效,无需改对方**。这是本次迁移最大的安全垫。

---

## 谁做什么

| 步骤 | 谁 | 说明 |
|---|---|---|
| Supabase 新建香港项目 | **你**（Supabase 后台) | 我没有你的 Supabase 账号/建项目权限 |
| 拿源库/新库连接串(含密码) | **你** | Settings→Database→Connection string,密码只在后台可见 |
| pg_dump 导出 / pg_restore 导入 | **你 或 我带你跑** | 需要上面的连接串;我可给命令,你在能连库的机器上执行 |
| Storage 桶文件迁移 | **我**（脚本) | 用两边 service-role key 逐桶拷贝 order-docs / product-images |
| Vercel env 换新库 + 区域 hkg1 | **我**（vercel CLI) | 三个 key + regions |
| 割接/验证/回滚 | **我 + 你** | 我出验证脚本跑,你确认业务 |

---

## 单系统迁移步骤（以节拍器为模板,财务/araos 照抄）

### 阶段 0 · 准备（不停服,可提前做）
- [ ] 你在 Supabase 建香港新项目：New Project → Region 选 **East Asia (Hong Kong)**。记下新项目 ref。
- [ ] 你把**源库**连接串（Settings→Database→URI,带密码）和**新库**连接串各拷一份给我(或自己留好)。
- [ ] 确认本机/一台能连外网的机器装了 `postgres` 客户端（`pg_dump`/`psql`,或用 `docker run postgres`）。
- [ ] 记下现有 Storage 桶清单（节拍器：`order-docs`、`product-images`）。

### 阶段 1 · 结构 + 数据迁移（停写窗口内）
> 停写：把当前系统临时置只读/挂维护页,或就在深夜无人时做（10-30 分钟)。

```bash
# 1) 导出源库(schema+data+RLS+函数+auth用户；--no-owner 避免角色不匹配)
pg_dump "postgresql://postgres:<源库密码>@db.<源ref>.supabase.co:5432/postgres" \
  --no-owner --no-privileges --schema=public --schema=auth --schema=storage \
  -f qimo_metronome_dump.sql

# 2) 导入新香港库
psql "postgresql://postgres:<新库密码>@db.<新ref>.supabase.co:5432/postgres" \
  -f qimo_metronome_dump.sql
```
- [ ] 注意：`auth` schema（登录用户）必须一起迁,否则所有人要重新注册。上面已含 `--schema=auth`。
- [ ] 若报扩展缺失（如 `pgcrypto`/`uuid-ossp`),先在新库 SQL Editor `CREATE EXTENSION IF NOT EXISTS ...` 再重导。
- [ ] 迁完在新库 SQL Editor 抽验行数：`SELECT count(*) FROM orders;` 等关键表与旧库一致。

### 阶段 2 · Storage 桶文件迁移（我来,脚本）
- [ ] 我用两边 service-role key 遍历 `order-docs`/`product-images` 逐对象下载→上传到新库同名桶。
- [ ] 先在新库后台建同名桶（同 public/private 设置),再跑拷贝脚本。

### 阶段 3 · 切 Vercel（我来）
```bash
# 换三个 env 指向香港新库（Production）
vercel env rm NEXT_PUBLIC_SUPABASE_URL production -y && printf '<新库URL>' | vercel env add ...
vercel env rm NEXT_PUBLIC_SUPABASE_ANON_KEY production -y && ...
vercel env rm SUPABASE_SERVICE_ROLE_KEY production -y && ...
# vercel.json 设 regions:["hkg1"]，push 触发重部署
```
- [ ] env：`NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY` / `SUPABASE_SERVICE_ROLE_KEY` 换成新库的。
- [ ] `vercel.json` 加 `"regions": ["hkg1"]`。
- [ ] **其余 env 不动**（域名、HMAC 密钥、SMTP、集成 URL 全不变 → 跨系统契约不断）。

### 阶段 4 · 验证（我出脚本 + 你点业务）
- [ ] 实测 TTFB：login / 一个带库的授权 API,应从 ~1.5s 降到 ~0.3-0.5s。
- [ ] 登录能进（auth 迁移成功);随手开订单/采购/财务页数据齐。
- [ ] 集成：发一条签名 webhook 到财务、查 `fin_inbox_events` 落地；OS 跳转正常。
- [ ] 定时任务：`/api/cron/reminders` 手动打一次(带 CRON_SECRET)返回 200。
- [ ] 上传/下载凭证(order-docs)能读到迁过去的文件。

### 阶段 5 · 观察 & 收尾
- [ ] 观察 1-2 天。旧库**先别删**,留作回滚。
- [ ] 稳定后：删旧 Supabase 项目、归档旧 env。

### 🔙 回滚（任何阶段异常）
把 Vercel 那三个 env 指回**旧库** + `vercel.json` 去掉 `regions` → 重部署,1 分钟回到迁移前。旧库一直没动,数据不丢。

---

## 三系统顺序 & 差异

1. **节拍器**（先做,练手)：库 `scrtebexbxablybqpdla`,桶 order-docs/product-images,Vercel `order-metronome`。
2. **财务系统**：库 `qpoboelobqnfbytugzkw`,Vercel `finance-system`（团队 alexs-projects）。桶按其实际清单。
3. **客户开发系统 araos**：`~/Projects/终极版客户开发系统/araos`,独立库/Vercel/桶。

⚠️ 三者迁移**互不依赖**（靠域名+HMAC 通信,域名不变)。所以可以一个一个来,每个跑通再下一个。
唯一注意：迁移某系统的停写窗口内,它发给别系统的 webhook 会暂停,割接完自动恢复(对端幂等,不重记)。

---

## 待你拍板/提供
1. ✅ 区域已定：香港。
2. 需要你：在 Supabase 后台**建 3 个香港新项目**并把**源库/新库连接串(含密码)**给我 → 我就能带你跑 dump/restore + 我做 Storage 迁移 + Vercel 切换。
3. 先从**节拍器**开工?（推荐)

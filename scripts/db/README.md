# 数据库迁移运行器(消灭 schema drift)

**背景**:以前迁移全靠手动在 Supabase SQL Editor 粘贴,没人记录哪些跑过 → 线上 schema 和代码假设长期不一致(schema drift)。典型事故:`purchase_unit_cost` 列没落生产,保存明细报错触发降级,把面料单价连坐删掉。

这套运行器让**新增迁移可靠地、自动地、只执行一次**地落到生产库。

## 一次性接入(只做一次)

1. **粘自举 SQL**:在 Supabase SQL Editor 粘贴执行一次 [`scripts/db/bootstrap.sql`](./bootstrap.sql)。
   建 `public._app_migrations`(记录已执行的迁移)+ `exec_sql(text)` RPC(仅 service_role 可调)。
2. **基线化历史迁移**:`npm run db:baseline`
   把 `supabase/migrations` 里【当前全部】文件标记为"已执行"(不真跑)——因为历史迁移都手动粘过了。
   基线化后,只有【将来新增】的文件才会被 apply。

## 日常用法

```bash
npm run db:status          # 已执行 N / 待执行 M(+ 列出待执行文件)
npm run db:migrate         # apply 所有待执行迁移(按文件名顺序,逐条执行,成功后记录)
npm run db:migrate -- --dry  # 只列出会跑什么,不真跑
```

**流程**:写完新迁移 `.sql` → `npm run db:migrate` → 生产库同步。不再手动粘贴、不再漏跑、不再重复跑。

## 原理

- 用 `.env.local` 的 `SUPABASE_SERVICE_ROLE_KEY` 连库,调 `exec_sql` RPC 执行 DDL。零新依赖、不需要 DB 连接串/密码。
- `exec_sql` 只授权给 `service_role`(anon/authenticated/public 一律不能调)——不新增攻击面(有 service-role key 的人本就有全库权限)。
- 运行器把每个 `.sql` 切成独立语句执行(exec_sql 底层一次跑一条),切分器尊重 `$$`/`$tag$` 函数体、字符串、`--` 与 `/* */` 注释;已对全部 224 个历史迁移验证不切坏。
- 单文件内多条语句不是同一事务(RPC 无状态)→ 迁移**务必写成幂等**(`if not exists` / `add column if not exists` / `create or replace` / `drop policy if exists`),失败重跑时前面的语句自动跳过。

## 注意

- 迁移文件名带日期前缀,按字典序 = 执行顺序,别用会打乱顺序的命名。
- 破坏性操作(drop/truncate/delete)运行器不拦——审查迁移内容仍是你的责任。

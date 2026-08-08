# QIMO OS Restore Runbook(R1-F 演练定稿,2026-08-09)

## 演练实绩(2026-08-09,生产备份实测)
- 备份:`backups/daily/2026-08-07_21-55-06.json`(11.25MB,版本 4.0-r1a)
- 恢复 5 表 6,240 行 → **9.4 秒**;全流程(建表+恢复+校验+清理)14.3 秒
- 校验全绿:行数 5/5 一致;UUID/时间/JSON/JSONB/中文/nullable 保真;
  3 张随机订单关联链(order→明细→节点→日志)与生产逐一相符;孤儿外键 0
- **结论:RESTORE DRILL PASS**

## 恢复步骤(照抄可用)
1. 取备份:`svc.storage.from('backups').list('daily')` 取最新 → download → JSON.parse
2. 隔离目标:新 Supabase 项目,或同库 `create table drill_<t> (like public.<t> including defaults)`
   (LIKE 不带 FK —— 故意的,恢复顺序免疫;关系用逻辑 join 校验)
3. `notify pgrst, 'reload schema'` 后等 3-5s
4. 逐表 500 行/批 insert(service-role)
5. 校验清单(缺一不可):行数=backup.stats;UUID/时间/JSONB 形态;中文;nullable;
   ≥3 单关联链抽查;孤儿外键=0
6. 真恢复到生产 = 把 drill 表数据回灌业务表(先停写、按 orders→line_items→milestones→logs 顺序)

## RPO / 覆盖范围
- **RPO ≈ 24h**(每日 02:00 北京一备,30 天滚动)
- 覆盖:22 张业务表全量(orders/milestones/审计/财务/采购/通知等)
- **尚未覆盖(known gaps,列入 R2)**:
  ① Storage 文件本体(附件 PDF/图片 1,797 个,只备了元数据行)
  ② auth 凭据(密码哈希;恢复后需用户重置或 Supabase 项目级恢复)
  ③ 外部系统状态(财务系统 synced 数据、企微)

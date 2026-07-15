# PO 历史自动学习 V1

## 它是什么

这是系统级、客户级的结构经验复用，不是训练 OpenAI 或 Claude 基础模型。

员工在订单中核对并修改逐款明细后，点击“重新冻结”。该明确的人工作业同时生成一份脱敏学习画像。下一次解析同客户 PO 时，系统最多读取最近五份已批准画像，提醒模型重点核对历史上常被纠正的结构。

## 保存与不保存

保存：常见尺码标签、套装倍率、被纠正的字段类别、来源订单和审核人。

不保存：完整 PO、价格、数量、地址、邮箱、电话、银行信息、完整模型输出。

历史经验始终是建议；当前 PO 内容优先。它不能自动批准订单，也不能绕过 schema 校验或人工复核。

## 启用

由 CEO 在 Supabase SQL Editor 手工执行：

`supabase/migrations/20260715_po_history_learning.sql`

未执行迁移时，PO 通用识别继续工作；“重新冻结”会明确提示学习记录未保存。

执行后只读验证：

```sql
select column_name, data_type, is_nullable
from information_schema.columns
where table_schema = 'public' and table_name = 'po_learning_examples'
order by ordinal_position;

select policyname, cmd, roles
from pg_policies
where schemaname = 'public' and tablename = 'po_learning_examples'
order by policyname;
```

## V1 边界

V1 能学习客户结构习惯，但无法从现有数据可靠反推原始 Excel 列名到字段的映射。后续如需模板级学习，应在人工确认时保存脱敏的 source-cell → approved-field 映射，而不是把完整历史 PO 直接塞进提示词。

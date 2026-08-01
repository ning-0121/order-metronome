-- 拆 orders.customer_po_number 这个诱饵列(B-5,2026-08-01)
--
-- 现状:PO 号这件事在代码里有三个名字,其中一个是假的。
--   ① 表单 input  name="customer_po_number"   (LegacyOrderForm.tsx:1393)
--   ② createOrder 读 ① 之后写进 orders.po_number 列  (orders.ts:148 → :407)
--   ③ orders.customer_po_number 列 —— 建了,但**从来没有任何代码写过它**,
--      生产 202 张单全部为 NULL。
--
-- ③ 就是个诱饵:名字跟表单字段一模一样,谁按直觉 select 它都会拿到永久 NULL,
-- 而且不报错。本轮审计已经被"字段名 ≠ 列名"坑过三次(checklist_data 是 JSON
-- 字符串、风险标写进 special_tags、allow_shipment 全是补建默认值),都是同一
-- 类误判。留着它就是留个雷,拆掉。
--
-- 注:代码里其余 customer_po_number 的读写全部打在 order_customer_pos
-- (多客户PO合单容器)上,与 orders 无关,不受影响。

do $$
declare
  n_dirty bigint;
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'orders' and column_name = 'customer_po_number'
  ) then
    raise notice 'orders.customer_po_number 不存在,跳过(幂等重跑)';
    return;
  end if;

  -- 自证守卫:只在**确实全空**时才拆。哪怕有一行有值,就说明我判断错了,宁可炸也不能删数据。
  execute 'select count(*) from public.orders where customer_po_number is not null'
    into n_dirty;

  if n_dirty > 0 then
    raise exception '中止:orders.customer_po_number 有 % 行非空,与"从未被写过"的判断矛盾。请先核查数据再决定是否删列。', n_dirty;
  end if;

  alter table public.orders drop column customer_po_number;
  raise notice 'orders.customer_po_number 已拆除(删除前确认 0 行非空)';
end $$;

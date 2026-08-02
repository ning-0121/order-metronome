-- 报价器整条下线(CEO 2026-08-01 拍板「报价器,不留」)
--
-- 全面审计发现这是一条**从头到尾零使用的平行建单链**:
--   报价器 quoter_quotes 0 → 客户PO customer_po 0 → 「从 PO 建单」PO 模式
-- 而实际所有订单(202 张)走的都是手工录入表单。更糟的是建单页把这条空链标成
-- 「PO 驱动 · 主路径」,把真正在用的手工录入标成「legacy 回退模式」,方向写反了。
--
-- 代码侧已删:app/quoter/(4 页)、app/customer-po/、app/actions/quoter*.ts、
-- POOrderForm、order-from-po、order-intake-read、/api/os/ignite-po,
-- 建单页的双模式切换器收敛成唯一表单。
--
-- 本迁移收尾:删掉这六张始终为空的表。
-- 注意 **不要**误删 order_customer_pos(6 行,多客户PO合单容器,在用)
-- 和 app/actions/customer-po.ts 对应的订单附件版本管理 —— 那是另一回事。
--
-- lib/quoter/*(纯类型与算料函数)保留:它们被 lib/po/types.ts、lib/order/from-po.ts
-- 等仍在编译的模块引用,且没有 UI 成本。清理它们是独立的第二步,风险与收益都另算。

do $$
declare
  t text;
  n bigint;
begin
  foreach t in array array[
    'quoter_quotes', 'quote_line', 'quote_version_snapshot', 'quoter_training_feedback',
    'customer_po', 'customer_po_line'
  ] loop
    if not exists (
      select 1 from information_schema.tables
      where table_schema = 'public' and table_name = t
    ) then
      raise notice '% 不存在,跳过(幂等重跑)', t;
      continue;
    end if;

    -- 自证守卫:只在确实空表时删。有一行都说明我判断错了,宁可中止也不能删数据。
    execute format('select count(*) from public.%I', t) into n;
    if n > 0 then
      raise exception '中止:% 有 % 行数据,与「零使用」的判断矛盾。请先核查再决定。', t, n;
    end if;

    execute format('drop table public.%I cascade', t);
    raise notice '% 已删除(删除前确认 0 行)', t;
  end loop;
end $$;

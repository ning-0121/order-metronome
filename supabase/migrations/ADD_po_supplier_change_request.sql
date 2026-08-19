-- 已下单/已付款采购单改供应商:走财务审批(2026-08-19 CEO)
-- 草稿单仍直改;非草稿单发起「改供应商申请」→ 财务审批 → 批准后套用。
-- 全部幂等(add column if not exists),单文件多语句非同一事务,失败重跑要能跳过已成功的。

alter table public.purchase_orders add column if not exists supplier_change_status        text;         -- null | pending | approved | rejected
alter table public.purchase_orders add column if not exists supplier_change_to            uuid;         -- 目标供应商 id
alter table public.purchase_orders add column if not exists supplier_change_to_name       text;         -- 目标供应商名(冗余,列表免 join)
alter table public.purchase_orders add column if not exists supplier_change_from          uuid;         -- 申请时的原供应商 id(审计/回滚参照)
alter table public.purchase_orders add column if not exists supplier_change_reason        text;         -- 申请原因(为什么要改;已付款单必填)
alter table public.purchase_orders add column if not exists supplier_change_requested_by  uuid;
alter table public.purchase_orders add column if not exists supplier_change_requested_at  timestamptz;
alter table public.purchase_orders add column if not exists supplier_change_decided_by    uuid;
alter table public.purchase_orders add column if not exists supplier_change_decided_at    timestamptz;
alter table public.purchase_orders add column if not exists supplier_change_decide_note   text;         -- 财务审批意见

-- 只索引 pending(审批中心只查待办;局部索引小而快)
create index if not exists idx_po_supplier_change_pending
  on public.purchase_orders (supplier_change_status)
  where supplier_change_status = 'pending';

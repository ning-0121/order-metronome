-- ===== 2026-07-09 出货单据元数据(CI 页脚 + 币种,业务填) =====
-- CI 的付款条件/运费/出厂日/定金/银行信息 因客户/成交而异,存 packing_lists.doc_meta(jsonb)。
-- 结构:{ currency:'USD'|'CNY', deposit:number, payment_terms, freight, exit_factory_date,
--        bank:{ beneficiary_bank, swift, bank_address, beneficiary_name, routing_no, account_no, company_address } }
ALTER TABLE public.packing_lists ADD COLUMN IF NOT EXISTS doc_meta jsonb DEFAULT '{}'::jsonb;

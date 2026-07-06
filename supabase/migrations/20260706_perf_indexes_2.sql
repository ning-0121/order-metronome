-- ============================================================
-- 20260706_perf_indexes_2 —— 热路径补索引(业务/采购最常用页提速)
-- 纯加法 IF NOT EXISTS:已有的跳过,不影响。补的是订单详情/工作台/采购中心高频按 order_id/用户 查的表。
-- (milestones/procurement_line_items 的 order_id 索引早已建,此处补其余。)
-- ============================================================

-- 订单详情:附件/文档/收货/预留/取消·延期 按 order_id
CREATE INDEX IF NOT EXISTS idx_order_attachments_order   ON public.order_attachments(order_id);
CREATE INDEX IF NOT EXISTS idx_order_documents_order      ON public.order_documents(order_id);
CREATE INDEX IF NOT EXISTS idx_cancel_requests_order      ON public.cancel_requests(order_id);
CREATE INDEX IF NOT EXISTS idx_delay_requests_order       ON public.delay_requests(order_id);

-- 工作台/订单列表:业务看自己建的/负责的单
CREATE INDEX IF NOT EXISTS idx_orders_created_by          ON public.orders(created_by);
CREATE INDEX IF NOT EXISTS idx_orders_owner_user          ON public.orders(owner_user_id);
CREATE INDEX IF NOT EXISTS idx_orders_lifecycle           ON public.orders(lifecycle_status);

-- 采购/MRP:需求按 plan、采购项/BOM 按 order
CREATE INDEX IF NOT EXISTS idx_material_requirements_plan ON public.material_requirements(material_plan_id);
CREATE INDEX IF NOT EXISTS idx_material_plans_order       ON public.material_plans(order_id);
CREATE INDEX IF NOT EXISTS idx_procurement_items_order    ON public.procurement_items(order_id);
CREATE INDEX IF NOT EXISTS idx_materials_bom_order        ON public.materials_bom(order_id);

-- 库存:按 order / material_key(余额派生高频)
CREATE INDEX IF NOT EXISTS idx_inv_txn_order              ON public.inventory_transactions(order_id);
CREATE INDEX IF NOT EXISTS idx_inv_txn_material_key       ON public.inventory_transactions(material_key);

-- 通知铃铛:按用户 + 未读
CREATE INDEX IF NOT EXISTS idx_notifications_user_order   ON public.notifications(related_order_id);

-- ── 验证(抽查几条)──
-- SELECT indexname FROM pg_indexes
--   WHERE indexname IN ('idx_orders_created_by','idx_material_requirements_plan','idx_inv_txn_material_key');

-- ========================================================================
-- 供应商 + 物料主数据:存量重复合并 → 唯一索引防重复 → DELETE 权限(支持删除功能)
-- ========================================================================
-- 背景(2026-07-03 用户反馈):同名供应商/物料可重复录入,已出现重复;且无删除能力。
-- 本迁移三步:
--   ① 合并存量重复(保留最早一条,引用全部改指保留行,重复行归档 status='archived')
--   ② 唯一索引(数据库级防线;app 层同时有同名拒绝提示)
--   ③ suppliers / material_master 加 DELETE RLS 策略(删除按钮依赖;角色权限在 action 层把关)
-- ⚠️ 由人手动在 Supabase SQL Editor 执行;执行后逐条跑「验证」,全 PASS 才算过门禁。
-- ========================================================================

-- ────────────────────────────────────────────────────────────
-- ① -A 合并重复供应商(按 忽略大小写/首尾空格 的名称,未归档范围内)
-- ────────────────────────────────────────────────────────────
CREATE TEMP TABLE _sup_dupes AS
SELECT id,
       first_value(id) OVER (PARTITION BY lower(trim(name)) ORDER BY created_at, id) AS keeper_id
FROM public.suppliers
WHERE status <> 'archived';
DELETE FROM _sup_dupes WHERE id = keeper_id;

-- 引用改指保留行:采购单
UPDATE public.purchase_orders po SET supplier_id = d.keeper_id
FROM _sup_dupes d WHERE po.supplier_id = d.id;

-- 引用改指保留行:物料-供应商报价(改指后会撞 UNIQUE(material_master_id, supplier_id) 的先删掉)
DELETE FROM public.material_supplier ms
USING _sup_dupes d
WHERE ms.supplier_id = d.id
  AND EXISTS (SELECT 1 FROM public.material_supplier k
              WHERE k.material_master_id = ms.material_master_id AND k.supplier_id = d.keeper_id);
UPDATE public.material_supplier ms SET supplier_id = d.keeper_id
FROM _sup_dupes d WHERE ms.supplier_id = d.id;

-- 重复行归档(名称加后缀避免归档区内再撞名,可追溯)
UPDATE public.suppliers s
SET status = 'archived', name = s.name || ' [重复合并-' || left(s.id::text, 8) || ']', updated_at = now()
FROM _sup_dupes d WHERE s.id = d.id;

-- ────────────────────────────────────────────────────────────
-- ① -B 合并重复物料(按 名称+类别+规格,正式且 active 范围内)
--    2026-07-03 变体模式:同名不同规格(克重/门幅)= 合法变体,不算重复不合并。
-- ────────────────────────────────────────────────────────────
CREATE TEMP TABLE _mm_dupes AS
SELECT id,
       first_value(id) OVER (PARTITION BY lower(trim(material_name)), coalesce(category,''),
                                          lower(trim(coalesce(specification,'')))
                             ORDER BY created_at, id) AS keeper_id
FROM public.material_master
WHERE status = 'active' AND is_temporary = false;
DELETE FROM _mm_dupes WHERE id = keeper_id;

-- 引用改指保留行(简单外键:订单BOM/采购归并项/库存预留/产品BOM模板)
UPDATE public.materials_bom t SET material_master_id = d.keeper_id
FROM _mm_dupes d WHERE t.material_master_id = d.id;
UPDATE public.procurement_items t SET material_master_id = d.keeper_id
FROM _mm_dupes d WHERE t.material_master_id = d.id;
UPDATE public.inventory_reservation t SET material_master_id = d.keeper_id
FROM _mm_dupes d WHERE t.material_master_id = d.id;
UPDATE public.product_bom_templates t SET material_master_id = d.keeper_id
FROM _mm_dupes d WHERE t.material_master_id = d.id;

-- 带唯一约束的引用:先删撞行再改指
DELETE FROM public.material_supplier ms USING _mm_dupes d
WHERE ms.material_master_id = d.id
  AND EXISTS (SELECT 1 FROM public.material_supplier k
              WHERE k.material_master_id = d.keeper_id AND k.supplier_id = ms.supplier_id);
UPDATE public.material_supplier ms SET material_master_id = d.keeper_id
FROM _mm_dupes d WHERE ms.material_master_id = d.id;

DELETE FROM public.material_uom u USING _mm_dupes d
WHERE u.material_master_id = d.id
  AND EXISTS (SELECT 1 FROM public.material_uom k
              WHERE k.material_master_id = d.keeper_id AND k.from_unit = u.from_unit AND k.to_unit = u.to_unit);
UPDATE public.material_uom u SET material_master_id = d.keeper_id
FROM _mm_dupes d WHERE u.material_master_id = d.id;

-- 替代料:主侧+替代侧都改指;先清撞行,最后清「自己替代自己」
DELETE FROM public.material_alternative a USING _mm_dupes d
WHERE a.material_master_id = d.id
  AND EXISTS (SELECT 1 FROM public.material_alternative k
              WHERE k.material_master_id = d.keeper_id AND k.alt_material_master_id = a.alt_material_master_id);
UPDATE public.material_alternative a SET material_master_id = d.keeper_id
FROM _mm_dupes d WHERE a.material_master_id = d.id;
DELETE FROM public.material_alternative a USING _mm_dupes d
WHERE a.alt_material_master_id = d.id
  AND EXISTS (SELECT 1 FROM public.material_alternative k
              WHERE k.alt_material_master_id = d.keeper_id AND k.material_master_id = a.material_master_id);
UPDATE public.material_alternative a SET alt_material_master_id = d.keeper_id
FROM _mm_dupes d WHERE a.alt_material_master_id = d.id;
DELETE FROM public.material_alternative WHERE material_master_id = alt_material_master_id;

-- 使用次数并入保留行
UPDATE public.material_master k
SET usage_count = k.usage_count + s.total
FROM (SELECT d.keeper_id, sum(m.usage_count) AS total
      FROM _mm_dupes d JOIN public.material_master m ON m.id = d.id
      GROUP BY d.keeper_id) s
WHERE k.id = s.keeper_id AND s.total > 0;

-- 重复行归档(保留 material_code 不动,编码本就唯一)
UPDATE public.material_master m
SET status = 'archived', updated_at = now()
FROM _mm_dupes d WHERE m.id = d.id;

-- ────────────────────────────────────────────────────────────
-- ② 唯一索引(数据库级防重复;app 层提示是第一道,这是兜底铁闸)
-- ────────────────────────────────────────────────────────────
-- 供应商:未归档范围内名称唯一(忽略大小写/首尾空格)
CREATE UNIQUE INDEX IF NOT EXISTS uq_suppliers_name_active
  ON public.suppliers (lower(trim(name)))
  WHERE status <> 'archived';

-- 物料:active 正式物料 名称+类别+规格 唯一(临时物料不受限,不挡订单录入自动沉淀)
-- 同名不同规格 = 合法变体(如「仿锦直贡呢拉毛」260g/270g/275g 三行,各自编码/价格/库存)
CREATE UNIQUE INDEX IF NOT EXISTS uq_mm_name_cat_active
  ON public.material_master (lower(trim(material_name)), coalesce(category,''),
                             lower(trim(coalesce(specification,''))))
  WHERE status = 'active' AND is_temporary = false;

-- ────────────────────────────────────────────────────────────
-- ③ DELETE RLS 策略(此前只有 SELECT/INSERT/UPDATE → 删除会静默 0 行)
--    谁能删在 server action 里按角色把关(供应商=业务/采购/管理员;物料=理单/采购/管理员)
-- ────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS suppliers_delete ON public.suppliers;
CREATE POLICY suppliers_delete ON public.suppliers FOR DELETE USING (auth.uid() IS NOT NULL);
DROP POLICY IF EXISTS mm_del ON public.material_master;
CREATE POLICY mm_del ON public.material_master FOR DELETE USING (auth.uid() IS NOT NULL);

-- ========================================================================
-- 验证(执行后逐条跑,期望值见注释;全 PASS 才算过门禁)
-- ========================================================================
-- ① 期望 0 行(未归档供应商无重名):
-- SELECT lower(trim(name)), count(*) FROM public.suppliers
--  WHERE status <> 'archived' GROUP BY 1 HAVING count(*) > 1;
-- ② 期望 0 行(active 正式物料无 名称+类别+规格 重复;同名不同规格是变体,不算):
-- SELECT lower(trim(material_name)), coalesce(category,''), lower(trim(coalesce(specification,''))), count(*)
--   FROM public.material_master
--  WHERE status='active' AND is_temporary=false GROUP BY 1,2,3 HAVING count(*) > 1;
-- ③ 期望 2 行(两个唯一索引都在):
-- SELECT indexname FROM pg_indexes
--  WHERE indexname IN ('uq_suppliers_name_active','uq_mm_name_cat_active');
-- ④ 期望 2 行(两个 DELETE 策略都在):
-- SELECT polname FROM pg_policy WHERE polname IN ('suppliers_delete','mm_del');
-- ⑤ 期望 0 行(没有采购单指向已归档的重复供应商 —— 都改指保留行了):
-- SELECT count(*) FROM public.purchase_orders po
--  JOIN public.suppliers s ON s.id = po.supplier_id
--  WHERE s.name LIKE '%[重复合并-%';
--  (注:count=0 显示 1 行 count 0,即 count 应为 0)
-- ⑥ 看一眼合并了多少(信息,无期望值):
-- SELECT count(*) AS 归档的重复供应商 FROM public.suppliers WHERE name LIKE '%[重复合并-%';

-- ========================================================================
-- 回滚
-- ========================================================================
-- DROP INDEX IF EXISTS public.uq_suppliers_name_active;
-- DROP INDEX IF EXISTS public.uq_mm_name_cat_active;
-- DROP POLICY IF EXISTS suppliers_delete ON public.suppliers;
-- DROP POLICY IF EXISTS mm_del ON public.material_master;
-- (合并/归档不自动回滚:归档行仍在库里,名称带 [重复合并-xxxx] 后缀可人工识别恢复)

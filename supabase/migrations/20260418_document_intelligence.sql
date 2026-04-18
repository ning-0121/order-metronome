-- ===== 2026-04-18 文件智能层（Document Intelligence Layer） =====
--
-- 核心设计原则：一次识别，多次复用
--   PO / 采购单 / 截图上传后触发一次 Claude Vision 提取，
--   结果缓存在 document_extractions，后续订单创建/合规比对/PI-CI生成均从缓存读取，
--   不重复消耗 token。
--

-- ────────────────────────────────────────────────────────────────
-- 1. document_extractions — AI 文件提取缓存表
--    关联 order_attachments，存储 Claude Vision 的结构化输出
-- ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS document_extractions (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id              uuid REFERENCES orders(id) ON DELETE CASCADE,
  attachment_id         uuid REFERENCES order_attachments(id) ON DELETE SET NULL,

  -- 来源信息
  source_type           text NOT NULL CHECK (source_type IN (
                          'pdf', 'image_po', 'screenshot_wechat',
                          'screenshot_email', 'email_body', 'manual'
                        )),
  file_name             text,
  doc_category          text DEFAULT 'customer_po' CHECK (doc_category IN (
                          'customer_po',        -- 客户 PO
                          'procurement_order',  -- 采购单
                          'packing_list_in',    -- 来货装箱单
                          'other'
                        )),

  -- 提取结果（核心）
  extracted_json        jsonb,          -- 结构化 JSON，见下方 schema 说明
  raw_text              text,           -- 原始 OCR 文本（调试用）
  confidence_score      numeric(3,2),   -- 0.00–1.00
  uncertain_fields      text[],         -- AI 不确定的字段名列表

  -- 提取元数据
  extraction_model      text DEFAULT 'claude-sonnet-4-20250514',
  extraction_tokens     integer,
  extracted_at          timestamptz,
  extract_error         text,

  -- 业务审核流程
  -- pending_review → confirmed / modified（业务修改后确认）/ rejected（无效文件）
  review_status         text DEFAULT 'pending_review' CHECK (review_status IN (
                          'pending_review', 'confirmed', 'modified', 'rejected'
                        )),
  reviewed_by           uuid REFERENCES auth.users(id),
  reviewed_at           timestamptz,
  review_notes          text,            -- 业务备注（修改原因等）

  -- 一次提取，多次复用标记
  used_for_order_create   boolean DEFAULT false,  -- 是否已用于订单创建预填充
  used_for_compliance     boolean DEFAULT false,  -- 是否已用于 PO 合规比对
  used_for_pi_ci          boolean DEFAULT false,  -- 是否已用于 PI/CI 生成

  created_by            uuid REFERENCES auth.users(id),
  created_at            timestamptz DEFAULT now(),
  updated_at            timestamptz DEFAULT now()
);

-- 每个 attachment 只保留最新一次成功提取（confirmed/modified）
CREATE INDEX IF NOT EXISTS idx_doc_extractions_attachment ON document_extractions(attachment_id);
CREATE INDEX IF NOT EXISTS idx_doc_extractions_order     ON document_extractions(order_id);
CREATE INDEX IF NOT EXISTS idx_doc_extractions_status    ON document_extractions(order_id, review_status);

-- extracted_json 结构说明（注释，实际由业务代码维护）:
-- {
--   "header": {
--     "po_number": "...",
--     "issue_date": "YYYY-MM-DD",
--     "delivery_date": "YYYY-MM-DD",
--     "incoterm": "FOB",
--     "currency": "USD",
--     "ship_to": "...",
--     "customer_name": "..."
--   },
--   "line_items": [
--     {
--       "line_no": 1,
--       "style_no": "...",
--       "description": "...",
--       "color": "...",
--       "sizes": {"XS":10, "S":20, "M":30, "L":20, "XL":10},
--       "total_quantity": 90,
--       "unit": "PCS",
--       "delivery_date": "YYYY-MM-DD",
--       "notes": "..."
--     }
--   ],
--   "total_quantity": 0,
--   "packaging_requirements": {
--     "carton_spec": "...",      -- 外箱规格
--     "hangtag": "...",          -- 吊牌要求
--     "barcode": "...",          -- 条形码
--     "polybag": "...",          -- 胶袋
--     "hanger": "...",           -- 衣架
--     "inner_packing": "...",    -- 内包装
--     "label": "...",            -- 贴标
--     "assortment": "..."        -- 配色配码要求
--   },
--   "production_notes": ["..."],      -- 生产注意事项
--   "quality_requirements": ["..."],   -- 品质要求
--   "special_instructions": "...",     -- 其他特殊说明
--   "extraction_meta": {
--     "confidence": 0.95,
--     "uncertain_fields": ["delivery_date"],
--     "source_language": "en"
--   }
-- }

-- RLS
ALTER TABLE document_extractions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "document_extractions_select" ON document_extractions
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM orders o
      WHERE o.id = document_extractions.order_id
    )
  );
CREATE POLICY "document_extractions_insert" ON document_extractions
  FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);
CREATE POLICY "document_extractions_update" ON document_extractions
  FOR UPDATE USING (auth.uid() IS NOT NULL);


-- ────────────────────────────────────────────────────────────────
-- 2. procurement_shared_sheets — 采购共享进程表（表头）
--    所有角色可见，采购可编辑，全流程跟踪
-- ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS procurement_shared_sheets (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id              uuid REFERENCES orders(id) ON DELETE CASCADE,
  sheet_no              text,    -- e.g. "PS-QM-20260418-001-V1"
  title                 text,    -- e.g. "QM-20260418-001 采购进程表"
  status                text DEFAULT 'active' CHECK (status IN (
                          'draft', 'active', 'confirmed', 'archived'
                        )),
  source_attachment_id  uuid REFERENCES order_attachments(id) ON DELETE SET NULL,
  extraction_id         uuid REFERENCES document_extractions(id) ON DELETE SET NULL,

  -- 可见/编辑权限（角色列表）
  visible_roles         text[] DEFAULT ARRAY[
    'procurement','sales','merchandiser','finance',
    'logistics','warehouse','production','admin'
  ],
  editable_roles        text[] DEFAULT ARRAY['procurement','admin'],

  notes                 text,
  created_by            uuid REFERENCES auth.users(id),
  confirmed_by          uuid REFERENCES auth.users(id),
  confirmed_at          timestamptz,
  created_at            timestamptz DEFAULT now(),
  updated_at            timestamptz DEFAULT now()
);

-- ────────────────────────────────────────────────────────────────
-- 3. procurement_sheet_items — 采购明细行（每一行物料）
-- ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS procurement_sheet_items (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sheet_id              uuid REFERENCES procurement_shared_sheets(id) ON DELETE CASCADE,
  order_id              uuid REFERENCES orders(id),
  row_no                integer NOT NULL DEFAULT 1,

  -- 物料基本信息
  material_name         text,          -- 物料名称（面料/拉链/吊牌等）
  material_code         text,          -- 物料编号/款号
  specification         text,          -- 规格/颜色/成分
  unit                  text DEFAULT 'M',  -- 单位（M/PCS/KG等）
  quantity              numeric,       -- 数量
  unit_price            numeric,       -- 单价（采购/财务可见）
  amount                numeric,       -- 金额（unit_price * quantity）
  supplier              text,          -- 供应商名称
  required_date         date,          -- 需求到货日

  -- 进度跟踪
  order_placed_date     date,          -- 采购下单日期
  expected_arrival      date,          -- 预计到货
  actual_arrival        date,          -- 实际到货
  arrival_qty           numeric,       -- 到货数量
  arrival_status        text DEFAULT 'pending' CHECK (arrival_status IN (
                          'pending',      -- 待下单
                          'ordered',      -- 已下单
                          'partial',      -- 部分到货
                          'arrived',      -- 已到货
                          'inspecting',   -- 验货中
                          'passed',       -- 验货通过
                          'failed'        -- 验货不合格
                        )),

  -- 各角色备注（只有对应角色才能编辑自己的备注）
  procurement_notes     text,   -- 采购备注
  qc_notes              text,   -- 品控备注
  warehouse_notes       text,   -- 仓库备注
  sales_notes           text,   -- 业务备注

  -- 审计
  last_updated_by       uuid REFERENCES auth.users(id),
  last_updated_at       timestamptz DEFAULT now(),
  created_at            timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_psi_sheet      ON procurement_sheet_items(sheet_id);
CREATE INDEX IF NOT EXISTS idx_psi_order      ON procurement_sheet_items(order_id);
CREATE INDEX IF NOT EXISTS idx_psi_status     ON procurement_sheet_items(arrival_status);

-- RLS for procurement tables
ALTER TABLE procurement_shared_sheets ENABLE ROW LEVEL SECURITY;
ALTER TABLE procurement_sheet_items   ENABLE ROW LEVEL SECURITY;

CREATE POLICY "procurement_sheets_select" ON procurement_shared_sheets
  FOR SELECT USING (auth.uid() IS NOT NULL);
CREATE POLICY "procurement_sheets_insert" ON procurement_shared_sheets
  FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);
CREATE POLICY "procurement_sheets_update" ON procurement_shared_sheets
  FOR UPDATE USING (auth.uid() IS NOT NULL);

CREATE POLICY "procurement_items_select" ON procurement_sheet_items
  FOR SELECT USING (auth.uid() IS NOT NULL);
CREATE POLICY "procurement_items_insert" ON procurement_sheet_items
  FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);
CREATE POLICY "procurement_items_update" ON procurement_sheet_items
  FOR UPDATE USING (auth.uid() IS NOT NULL);


-- ────────────────────────────────────────────────────────────────
-- 4. orders 表补充字段：AI 巡检日期缓存
--    用于 agent-scan 每日去重：规则引擎每小时跑，AI 增强每天最多1次
-- ────────────────────────────────────────────────────────────────
ALTER TABLE orders ADD COLUMN IF NOT EXISTS ai_scan_date date;  -- 最后一次 AI 增强日期
ALTER TABLE orders ADD COLUMN IF NOT EXISTS ai_scan_suggestion_count integer DEFAULT 0; -- 上次生成数

COMMENT ON COLUMN orders.ai_scan_date IS 'agent-scan 最后一次 AI 增强日期（每天最多触发一次 Claude API）';
COMMENT ON COLUMN orders.ai_scan_suggestion_count IS '上次 AI 增强生成的建议数';


-- ────────────────────────────────────────────────────────────────
-- 5. order_documents 补充：关联 PO 提取数据
-- ────────────────────────────────────────────────────────────────
ALTER TABLE order_documents ADD COLUMN IF NOT EXISTS extraction_id uuid REFERENCES document_extractions(id);
ALTER TABLE order_documents ADD COLUMN IF NOT EXISTS template_version text DEFAULT 'v1';

COMMENT ON COLUMN order_documents.extraction_id IS '生成此单据时使用的 PO 提取数据 ID（一次提取多次使用）';

-- ===== 单据中心 V1 =====
-- 2026-04-01

-- 单据主表
CREATE TABLE IF NOT EXISTS order_documents (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  order_id uuid NOT NULL REFERENCES orders(id),
  document_type text NOT NULL CHECK (document_type IN ('pi','production_sheet','packing_list','ci','material_sheet','purchase_order')),
  source_mode text NOT NULL DEFAULT 'manual_created' CHECK (source_mode IN ('ai_generated','manual_upload','manual_created')),
  version_no integer NOT NULL DEFAULT 1,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','pending_review','approved','rejected','locked','archived')),
  document_no text,
  file_name text,
  file_path text,
  file_url text,
  editable_json jsonb,
  created_by uuid,
  updated_by uuid,
  approved_by uuid,
  approved_at timestamptz,
  rejected_by uuid,
  rejected_at timestamptz,
  reject_reason text,
  is_current boolean DEFAULT true,
  is_official boolean DEFAULT false,
  locked_at timestamptz,
  deleted_at timestamptz,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_order_documents_order ON order_documents(order_id);
CREATE INDEX IF NOT EXISTS idx_order_documents_type ON order_documents(order_id, document_type);

ALTER TABLE order_documents ENABLE ROW LEVEL SECURITY;
CREATE POLICY "order_documents_select" ON order_documents FOR SELECT USING (auth.uid() IS NOT NULL);
CREATE POLICY "order_documents_insert" ON order_documents FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);
CREATE POLICY "order_documents_update" ON order_documents FOR UPDATE USING (auth.uid() IS NOT NULL);

-- 操作日志表
CREATE TABLE IF NOT EXISTS document_logs (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  document_id uuid NOT NULL REFERENCES order_documents(id),
  order_id uuid NOT NULL,
  action text NOT NULL,
  actor_user_id uuid,
  detail jsonb,
  created_at timestamptz DEFAULT now()
);

ALTER TABLE document_logs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "document_logs_select" ON document_logs FOR SELECT USING (auth.uid() IS NOT NULL);
CREATE POLICY "document_logs_insert" ON document_logs FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);

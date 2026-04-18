-- ===== 2026-04-18 客户订单模板（Order Templates） =====
--
-- 用途：
--   管理员在后台预设常用订单模板（如"欧美FOB标准模板"、"国内人民币模板"），
--   业务新建订单时一键套用，减少重复填写，避免漏填关键字段。
--
-- 模板覆盖字段（与 orders/new 表单对应）：
--   - 贸易条款（incoterm）
--   - 交付方式（delivery_type）
--   - 订单类型（order_type）
--   - 样品阶段（sample_phase）
--   - 风险标记（risk_flags）
--   - 默认备注（default_notes）
--   - 样品确认天数（sample_confirm_days_override）
--   - 是否需要船样（shipping_sample_required）

CREATE TABLE IF NOT EXISTS order_templates (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- 模板基本信息
  name                        text NOT NULL,              -- 模板名称，如"欧美FOB出口"
  description                 text,                       -- 模板说明（可选）
  template_type               text DEFAULT 'production'   -- 'production' | 'sample'
    CHECK (template_type IN ('production', 'sample')),

  -- 贸易 & 交付
  incoterm                    text CHECK (incoterm IN (
                                'FOB', 'DDP', 'RMB_EX_TAX', 'RMB_INC_TAX'
                              )),
  delivery_type               text CHECK (delivery_type IN ('export', 'domestic')),

  -- 订单类型
  order_type                  text CHECK (order_type IN (
                                'trial', 'bulk', 'repeat', 'urgent'
                              )),

  -- 样品相关
  sample_phase                text CHECK (sample_phase IN (
                                'confirmed', 'dev_sample',
                                'dev_sample_with_revision', 'skip_all'
                              )),
  sample_confirm_days_override integer,                   -- 0 = 不覆盖
  shipping_sample_required    boolean DEFAULT false,

  -- 风险标记（复用 orders/new 表单里的 checkbox name 列表）
  risk_flags                  text[] DEFAULT '{}',
  -- 可选值：new_customer / new_factory / has_plus_size / high_stretch /
  --         light_color_risk / color_clash_risk / complex_print / tight_deadline

  -- 默认备注
  default_notes               text,

  -- 管理
  is_active                   boolean DEFAULT true,
  sort_order                  integer DEFAULT 0,          -- 排序权重，越小越靠前
  usage_count                 integer DEFAULT 0,          -- 被使用次数（统计用）

  created_by                  uuid REFERENCES auth.users(id),
  updated_by                  uuid REFERENCES auth.users(id),
  created_at                  timestamptz DEFAULT now(),
  updated_at                  timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_order_templates_active ON order_templates(is_active, sort_order);

-- RLS
ALTER TABLE order_templates ENABLE ROW LEVEL SECURITY;

-- 所有登录用户可以读取模板（业务需建单时选用）
CREATE POLICY "order_templates_select" ON order_templates
  FOR SELECT USING (auth.uid() IS NOT NULL);

-- 只有管理员可以写入
CREATE POLICY "order_templates_insert" ON order_templates
  FOR INSERT WITH CHECK (
    EXISTS (
      SELECT 1 FROM profiles
      WHERE user_id = auth.uid()
        AND (role = 'admin' OR 'admin' = ANY(roles))
    )
  );

CREATE POLICY "order_templates_update" ON order_templates
  FOR UPDATE USING (
    EXISTS (
      SELECT 1 FROM profiles
      WHERE user_id = auth.uid()
        AND (role = 'admin' OR 'admin' = ANY(roles))
    )
  );

CREATE POLICY "order_templates_delete" ON order_templates
  FOR DELETE USING (
    EXISTS (
      SELECT 1 FROM profiles
      WHERE user_id = auth.uid()
        AND (role = 'admin' OR 'admin' = ANY(roles))
    )
  );

-- 预置 4 个常用模板
INSERT INTO order_templates
  (name, description, template_type, incoterm, delivery_type, order_type, sample_phase, shipping_sample_required, default_notes, sort_order)
VALUES
  (
    '欧美 FOB 出口标准',
    'FOB 离岸价，含产前样+中期+尾查，适合欧美大客户',
    'production', 'FOB', 'export', 'bulk', 'confirmed', false,
    '', 1
  ),
  (
    'DDP 完税交货',
    'DDP 完税后交货，含订舱/报关/出运全流程',
    'production', 'DDP', 'export', 'bulk', 'confirmed', true,
    '', 2
  ),
  (
    '国内人民币含税',
    '国内客户，人民币含税，送仓流程，跳过出运节点',
    'production', 'RMB_INC_TAX', 'domestic', 'bulk', 'skip_all', false,
    '', 3
  ),
  (
    '样品单（快速通道）',
    '样品单，跳过大部分节点，仅保留核心样品确认流程',
    'sample', 'FOB', 'export', 'trial', 'confirmed', false,
    '', 4
  );

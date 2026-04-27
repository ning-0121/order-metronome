-- ============================================================
-- Trade OS Foundation — P0 数据层
-- 建表顺序：按外键依赖
-- 1. system_alerts
-- 2. customer_rhythm
-- 3. email_process_log
-- 4. profit_snapshots
-- 5. ai_context_cache
-- 6. daily_tasks
-- ============================================================

-- ===== 1. system_alerts =====
CREATE TABLE IF NOT EXISTS public.system_alerts (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  alert_type text NOT NULL CHECK (alert_type IN (
    'low_margin','negative_margin',
    'order_overdue','milestone_stuck',
    'customer_inactive','customer_at_risk',
    'email_urgent','approval_pending',
    'system_error'
  )),
  severity text NOT NULL DEFAULT 'warning' CHECK (severity IN ('info','warning','critical')),
  entity_type text CHECK (entity_type IN ('order','customer','factory','system')),
  entity_id text,
  title text NOT NULL,
  description text,
  data_json jsonb DEFAULT '{}'::jsonb,
  -- alert_key 用于去重，格式如 'low_margin:order-uuid'
  alert_key text,
  is_read bool DEFAULT false,
  is_resolved bool DEFAULT false,
  resolved_at timestamptz,
  resolved_by uuid,
  -- 到期自动关闭（如利润告警在订单完成后自动消失）
  auto_resolve_at timestamptz,
  created_at timestamptz DEFAULT now()
);

ALTER TABLE public.system_alerts ENABLE ROW LEVEL SECURITY;

-- 去重索引：同 alert_key 只保留一条
CREATE UNIQUE INDEX IF NOT EXISTS idx_system_alerts_key
  ON public.system_alerts(alert_key)
  WHERE alert_key IS NOT NULL AND is_resolved = false;

CREATE INDEX IF NOT EXISTS idx_system_alerts_severity
  ON public.system_alerts(severity, is_resolved);

CREATE INDEX IF NOT EXISTS idx_system_alerts_entity
  ON public.system_alerts(entity_type, entity_id);

CREATE INDEX IF NOT EXISTS idx_system_alerts_created
  ON public.system_alerts(created_at DESC);

-- RLS：admin + finance 可读；普通用户不可直接访问
CREATE POLICY "system_alerts_read_management"
  ON public.system_alerts FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE user_id = auth.uid()
        AND (
          ('admin' = ANY(roles)) OR role = 'admin'
          OR ('finance' = ANY(roles)) OR role = 'finance'
          OR ('production_manager' = ANY(roles)) OR role = 'production_manager'
        )
    )
  );

-- 解决告警：admin only
CREATE POLICY "system_alerts_update_admin"
  ON public.system_alerts FOR UPDATE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE user_id = auth.uid()
        AND (('admin' = ANY(roles)) OR role = 'admin')
    )
  );

-- ===== 2. customer_rhythm =====
CREATE TABLE IF NOT EXISTS public.customer_rhythm (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  customer_name text NOT NULL,
  -- 客户分级：A=战略客户 B=重要客户 C=普通客户
  tier text DEFAULT 'B' CHECK (tier IN ('A','B','C')),
  -- 跟进节奏
  last_contact_at timestamptz,
  next_followup_at timestamptz,
  followup_interval_days int DEFAULT 14,
  followup_status text DEFAULT 'normal' CHECK (followup_status IN (
    'normal','due','overdue','at_risk','inactive'
  )),
  -- 业务数据（从 orders 聚合）
  total_order_count int DEFAULT 0,
  total_order_value_usd numeric DEFAULT 0,
  avg_order_value_usd numeric DEFAULT 0,
  last_order_at timestamptz,
  active_order_count int DEFAULT 0,
  -- 风险评估
  risk_score int DEFAULT 0 CHECK (risk_score >= 0 AND risk_score <= 100),
  risk_factors jsonb DEFAULT '[]'::jsonb,
  -- 手动备注（sales 可写）
  notes text,
  updated_at timestamptz DEFAULT now(),
  created_at timestamptz DEFAULT now(),
  UNIQUE(customer_name)
);

ALTER TABLE public.customer_rhythm ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_customer_rhythm_status
  ON public.customer_rhythm(followup_status);

CREATE INDEX IF NOT EXISTS idx_customer_rhythm_followup
  ON public.customer_rhythm(next_followup_at)
  WHERE followup_status != 'inactive';

CREATE INDEX IF NOT EXISTS idx_customer_rhythm_tier
  ON public.customer_rhythm(tier);

-- 读：admin + finance + sales + merchandiser
CREATE POLICY "customer_rhythm_read"
  ON public.customer_rhythm FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE user_id = auth.uid()
        AND (
          role IN ('admin','finance','sales','merchandiser','production_manager')
          OR roles && ARRAY['admin','finance','sales','merchandiser','production_manager']
        )
    )
  );

-- 写：sales 可更新 notes + next_followup_at；admin 全字段
CREATE POLICY "customer_rhythm_update_sales"
  ON public.customer_rhythm FOR UPDATE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE user_id = auth.uid()
        AND (
          role IN ('admin','sales','merchandiser')
          OR roles && ARRAY['admin','sales','merchandiser']
        )
    )
  );

-- Insert/Delete 由 service_role 或管理员操作
CREATE POLICY "customer_rhythm_insert_admin"
  ON public.customer_rhythm FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE user_id = auth.uid()
        AND (('admin' = ANY(roles)) OR role = 'admin')
    )
  );

-- ===== 3. email_process_log =====
CREATE TABLE IF NOT EXISTS public.email_process_log (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  -- 邮件唯一标识（防止重复处理）
  email_uid text NOT NULL,
  message_id text,
  subject text,
  from_email text,
  received_at timestamptz,
  processed_at timestamptz DEFAULT now(),
  -- AI 分析结果（缓存，避免重复调用）
  customer_detected text,
  order_detected text,
  action_type text CHECK (action_type IN (
    'inquiry','followup','complaint','approval','payment','info','other','none'
  )),
  urgency_level text DEFAULT 'normal' CHECK (urgency_level IN ('urgent','normal','low')),
  summary_text text,
  requires_action bool DEFAULT false,
  action_description text,
  -- Token 成本追踪
  token_used int DEFAULT 0,
  model_used text,
  -- 处理失败记录
  error_message text,
  UNIQUE(email_uid)
);

ALTER TABLE public.email_process_log ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_email_process_log_processed
  ON public.email_process_log(processed_at DESC);

CREATE INDEX IF NOT EXISTS idx_email_process_log_customer
  ON public.email_process_log(customer_detected);

CREATE INDEX IF NOT EXISTS idx_email_process_log_action
  ON public.email_process_log(requires_action)
  WHERE requires_action = true;

-- 读：admin only（邮件内容敏感）
CREATE POLICY "email_process_log_read_admin"
  ON public.email_process_log FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE user_id = auth.uid()
        AND (('admin' = ANY(roles)) OR role = 'admin')
    )
  );

-- ===== 4. profit_snapshots =====
CREATE TABLE IF NOT EXISTS public.profit_snapshots (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  order_id uuid NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,
  snapshot_type text NOT NULL DEFAULT 'live' CHECK (snapshot_type IN (
    'forecast',  -- 报价阶段预测
    'live',      -- 执行中实时快照
    'final'      -- 订单完成后终态
  )),
  -- 收入
  revenue_usd numeric,
  revenue_cny numeric,
  exchange_rate numeric DEFAULT 7.2,
  -- 成本分项
  material_cost numeric DEFAULT 0,
  processing_cost numeric DEFAULT 0,
  logistics_cost numeric DEFAULT 0,
  other_cost numeric DEFAULT 0,
  -- 计算字段（由 service 写入，避免 DB GENERATED 的复杂性）
  total_cost numeric,
  gross_profit numeric,
  gross_margin numeric,         -- 0.0 - 1.0，如 0.15 = 15%
  margin_status text CHECK (margin_status IN (
    'healthy',    -- >= 15%
    'warning',    -- 10% - 15%
    'critical',   -- < 10% 且 > 0%
    'negative',   -- 亏损
    'unset'       -- 数据不完整，无法计算
  )),
  -- 数据质量
  data_completeness int DEFAULT 0 CHECK (data_completeness >= 0 AND data_completeness <= 100),
  missing_fields jsonb DEFAULT '[]'::jsonb,
  -- 元数据
  version int DEFAULT 1,
  notes text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  created_by uuid,
  -- 每种类型对每个订单只保留一条，更新时用 upsert
  UNIQUE(order_id, snapshot_type)
);

ALTER TABLE public.profit_snapshots ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_profit_snapshots_order
  ON public.profit_snapshots(order_id);

CREATE INDEX IF NOT EXISTS idx_profit_snapshots_margin_status
  ON public.profit_snapshots(margin_status)
  WHERE margin_status IN ('critical','negative');

CREATE INDEX IF NOT EXISTS idx_profit_snapshots_updated
  ON public.profit_snapshots(updated_at DESC);

-- 读：admin + finance
CREATE POLICY "profit_snapshots_read_finance"
  ON public.profit_snapshots FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE user_id = auth.uid()
        AND (
          role IN ('admin','finance')
          OR roles && ARRAY['admin','finance']
        )
    )
  );

-- ===== 5. ai_context_cache =====
CREATE TABLE IF NOT EXISTS public.ai_context_cache (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  context_type text NOT NULL CHECK (context_type IN (
    'customer',   -- 客户完整画像
    'order',      -- 订单上下文
    'factory',    -- 工厂档案
    'product',    -- 产品/款式知识
    'global'      -- 全局系统上下文
  )),
  entity_id text NOT NULL,            -- customer_name / order_id / factory_name
  -- 缓存内容
  summary_json jsonb NOT NULL DEFAULT '{}'::jsonb,   -- 结构化摘要（用于程序读取）
  raw_context_text text,              -- 压缩后的文字上下文（直接给 AI 用）
  -- 成本追踪
  token_estimate int DEFAULT 0,       -- 估算的 token 数
  model_used text,
  -- 缓存控制
  last_updated_at timestamptz DEFAULT now(),
  valid_until timestamptz,            -- NULL = 永不过期，依赖 is_stale
  is_stale bool DEFAULT false,        -- 手动标记失效
  invalidation_reason text,           -- 失效原因，用于 debug
  version int DEFAULT 1,
  UNIQUE(context_type, entity_id)
);

ALTER TABLE public.ai_context_cache ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_ai_context_stale
  ON public.ai_context_cache(is_stale, context_type);

CREATE INDEX IF NOT EXISTS idx_ai_context_valid_until
  ON public.ai_context_cache(valid_until)
  WHERE valid_until IS NOT NULL;

-- 读：admin only（可能包含业务敏感信息）
CREATE POLICY "ai_context_cache_read_admin"
  ON public.ai_context_cache FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE user_id = auth.uid()
        AND (('admin' = ANY(roles)) OR role = 'admin')
    )
  );

-- ===== 6. daily_tasks =====
CREATE TABLE IF NOT EXISTS public.daily_tasks (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  assigned_to uuid NOT NULL REFERENCES public.profiles(user_id) ON DELETE CASCADE,
  task_date date NOT NULL DEFAULT CURRENT_DATE,
  task_type text NOT NULL CHECK (task_type IN (
    'milestone_overdue',      -- 我负责的里程碑已逾期
    'milestone_due_today',    -- 今天到期的里程碑
    'customer_followup',      -- 客户跟进提醒
    'delay_approval',         -- 待我审批的延期申请
    'quote_approval',         -- 待我审批的报价
    'profit_warning',         -- 订单利润预警
    'system_alert',           -- 系统告警
    'email_action'            -- 邮件需要处理
  )),
  priority int NOT NULL DEFAULT 3 CHECK (priority IN (1,2,3)),
  -- 1=紧急（今天必须处理）2=重要（应该处理）3=普通（有空处理）
  title text NOT NULL,
  description text,
  -- 行动按钮
  action_url text,
  action_label text DEFAULT '去处理',
  -- 关联实体
  related_order_id uuid REFERENCES public.orders(id) ON DELETE SET NULL,
  related_customer text,
  related_milestone_id uuid,
  -- 来源追踪（用于防重复生成）
  source_type text,           -- 'milestone' / 'delay_request' / 'customer_rhythm' / 'profit_snapshot'
  source_id text,             -- 来源记录的 ID
  -- 状态
  status text DEFAULT 'pending' CHECK (status IN ('pending','done','snoozed','dismissed')),
  completed_at timestamptz,
  snoozed_until timestamptz,
  created_at timestamptz DEFAULT now(),
  -- 防重复：同一人同一来源同一天只生成一条任务
  UNIQUE(assigned_to, source_type, source_id, task_date)
);

ALTER TABLE public.daily_tasks ENABLE ROW LEVEL SECURITY;

-- 主查询索引：用户今日待处理任务
CREATE INDEX IF NOT EXISTS idx_daily_tasks_user_date
  ON public.daily_tasks(assigned_to, task_date, status);

CREATE INDEX IF NOT EXISTS idx_daily_tasks_priority
  ON public.daily_tasks(priority, task_date)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_daily_tasks_type
  ON public.daily_tasks(task_type, task_date);

-- RLS：用户只能看自己的任务
CREATE POLICY "daily_tasks_read_own"
  ON public.daily_tasks FOR SELECT
  TO authenticated
  USING (assigned_to = auth.uid());

-- admin 可看所有人的任务
CREATE POLICY "daily_tasks_read_admin"
  ON public.daily_tasks FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE user_id = auth.uid()
        AND (('admin' = ANY(roles)) OR role = 'admin')
    )
  );

-- 用户只能更新自己任务的状态
CREATE POLICY "daily_tasks_update_own"
  ON public.daily_tasks FOR UPDATE
  TO authenticated
  USING (assigned_to = auth.uid())
  WITH CHECK (assigned_to = auth.uid());

-- Insert 由 service_role 或 admin
CREATE POLICY "daily_tasks_insert_admin"
  ON public.daily_tasks FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE user_id = auth.uid()
        AND (('admin' = ANY(roles)) OR role = 'admin')
    )
  );

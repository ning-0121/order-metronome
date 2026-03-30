UPDATE public.milestones
SET due_at = t0_due + (new_day::double precision / 44.0) * (anchor_due - t0_due)
FROM (
  SELECT
    ms.id AS milestone_id,
    md.new_day,
    p.due_at AS t0_due,
    s.due_at AS anchor_due
  FROM public.milestones ms
  JOIN public.milestones p ON p.order_id = ms.order_id AND p.step_key = 'po_confirmed'
  JOIN public.milestones s ON s.order_id = ms.order_id AND s.step_key = 'shipment_execute'
  JOIN (VALUES
    ('production_order_upload', 4),
    ('pre_production_sample_ready', 14),
    ('pre_production_sample_sent', 15),
    ('pre_production_sample_approved', 19),
    ('production_kickoff', 20)
  ) AS md(skey, new_day) ON md.skey = ms.step_key
  WHERE ms.status IN ('pending', 'in_progress')
    AND p.due_at IS NOT NULL
    AND s.due_at IS NOT NULL
    AND s.due_at > p.due_at
) AS calc
WHERE milestones.id = calc.milestone_id;

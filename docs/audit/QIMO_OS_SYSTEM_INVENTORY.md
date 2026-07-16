# QIMO OS System Inventory

Audit date: 2026-07-16. Evidence is from repository source, Git metadata, Vercel metadata and migration files. No Production data was read or changed.

## Systems in scope

| System | Repository / local path | Production function | Database | Principal interfaces |
|---|---|---|---|---|
| Order Metronome | `ning-0121/order-metronome` / `~/Projects/order-metronome` | Sales handoff, order truth, milestones, BOM, procurement, production, QC, logistics and finance integration | Supabase `scrtebexbxablybqpdla` | Next.js Server Actions, API routes, cron routes, Supabase Auth/Storage, signed Finance/ARAOS contracts |
| Finance System | `ning-0121/finance-system` / `~/Projects/财务系统` | Receivables, payables, bank reconciliation, costs, profit, settlement, GL and financial approvals | Supabase `qpoboelobqnfbytugzkw` | Next.js APIs, signed Metronome integration, WeCom, Supabase, document/agent engines |
| ARAOS / customer development | `~/Projects/终极版客户开发系统/araos` (integration dependency only in this audit) | Lead/customer and upstream handoff | Supabase `hpdcqjfwmcbdlgywhjog` per integration docs | `CONTRACT_KEY_ARAOS`, `CONTRACT_SECRET_ARAOS`, handoff APIs |

## Order Metronome code inventory

- Frontend/backend: Next.js 16, React 19, Server Actions and route handlers.
- Auth: Supabase Auth; middleware protects employee routes.
- Core tables evidenced in migrations: `orders`, `order_line_items`, `po_parse_drafts`, `products`, `product_variants`, `materials_bom`, `material_requirements`, `procurement_items`, `purchase_orders`, `goods_receipts`, `production_dispatch`, `milestones`, `delay_requests`, `qc_inspections`, `shipment_batches`, `order_financials`, `order_attachments`, `runtime_events`, `runtime_orders`.
- Document workflow tables: `size_chart_imports`, `accessory_import_candidates`, `document_extractions`, `order_documents`, `order_attachments`.
- Agent tables: `agent_actions`, `agent_batch_jobs`, `ai_skill_runs`, `ai_skill_actions`, `ai_usage_log`, `ai_knowledge_base`, `ai_context_cache`.
- Storage responsibilities visible in code: order documents, product images and generated safe attachment keys. Bucket existence/policy needs live metadata validation.
- Background execution: cron routes for reminders, mail ingestion, Agent scans, compliance, cost monitoring, order audit, daily/weekly/monthly reporting and runtime maintenance.

## Finance code inventory

- Next.js 16 application under `src/app`, with independent Supabase database.
- Domains: orders/budgets, receivables, payables, bank journal/reconciliation, payment batches, tax refund, profit control, settlement, general ledger and control center.
- Cross-system routes: integration sync/webhook/approval/health, Metronome attachments, finance progress, create budget and purpose approvals.
- Financial engines: integrity, freeze, closing, audit, submit gate, trust, override, orchestration, GL queue/posting and source lineage.
- AI/automation: Anthropic dependency remains; document extraction and financial agents exist. `AGENTS.md` requires AI read-only/recommendation behavior and authenticated human approval for writes.

## Worktrees and preservation boundary

| Path | Branch / SHA | Audit handling |
|---|---|---|
| `order-metronome` | `audit/qimo-os-enterprise-202607` from Production main `060a88e` | audit writes permitted |
| `order-metronome-autofill` | `fix/order-autofill-and-downstream-mapping` / `a1f4622` | read-only historical/feature comparison |
| `order-metronome-release-p0` | `release/p0-20260716` / `9e4435f` | read-only release evidence |
| Finance root | `main` / `ac426f6`; dirty user files present | strictly read-only; no reset/clean/edit |

Finance pre-existing user changes: `.claude/worktrees/condescending-blackburn-3c1b28`, `_run_20260711_all.sql`, `exports/`, and two `_batch0_*` scripts. They are not audit changes.

## External services and configuration names

- Supabase Auth, PostgreSQL and Storage.
- Vercel Git deployments and cron.
- OpenAI QIMO Runtime; Anthropic remains configured for audited legacy paths.
- SMTP/IMAP and WeCom messaging.
- Signed Order/Finance/ARAOS contracts.
- No secret value was read. Variable names are recorded in the deployment map.

## Ownership gaps

Repository ownership is Qimo Technology / GitHub actor `ning-0121`. Business owner and on-call owner are not machine-readable for most modules; this is a P2 governance gap because cron, integration and Agent incidents lack an explicit accountable owner.

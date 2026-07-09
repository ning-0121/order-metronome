# Enterprise Architecture Audit — Before Phase 0c

> **Reviewer stance**: Principal/Enterprise/Distributed-Systems/DDD/AI-OS Architect. **Ruthless, not polite. Optimize for 10 years, not for protecting work already done.** Reviewing the SYSTEM, not the code.
> **Date**: 2026-06-29 · Scope: QIMO ⊕ finance ⊕ araos federation, Phase 0a (done) / 0b (done) / 0c (design only).
> **Rule honored**: previous decisions are NOT assumed correct; where wrong, replace completely.

---

# Executive Summary

**Verdict: YES WITH CHANGES.** Continue Phase 0c — but make **4 architectural decisions NOW**, before Phase 0d calcifies the integration pattern across three systems.

The architecture is **strong on governance, weak on its own stated paradigm.** The DDD ownership model, the federated 3-DB design (no cross-DB FK), the identity spine, the SSOT discipline, and the AI Constitution compliance are genuinely well-built — top quartile for an SME-scale system. The single biggest gap: **this is not an Event-Driven Architecture, despite the 10-year "millions of events / 20 agents" vision.** It is **RPC + webhooks + table-queues**. There is no durable event log / outbox / append-only fact stream. That's fine for today's scale (one company, ~137 orders) but it is the **one retrofit that is cheap today and brutally expensive in two years** once 0c (handoff_queue) and 0d (finance reconciliation) hard-code point-to-point integrations.

Second concern: I am **reversing my own Phase 0b framing.** The Contract API was positioned as "the way finance reads orders" (synchronous pull replacing direct-DB read). That trades a DB coupling for an **HTTP runtime coupling + SPOF on QIMO's app being up.** The durable pattern is **event-carried state transfer**: QIMO pushes order events → finance updates its local `synced_orders` cache → finance reads its OWN cache (zero runtime dependency on QIMO). The Contract API should be **reconciliation + on-demand detail**, not the hot path.

Nothing here blocks 0c — 0c is isolated, additive, reversible, and (after the user killed auto-convert) Constitution-clean. But **0d must not start until the event-backbone decision and the contract-API-role decision are made**, because 0d wires the finance↔QIMO pattern permanently.

---

# Scorecard (0–10, honest, not inflated)

| Dimension | Score | One-line why |
|---|---|---|
| **Enterprise Direction** | **7.5** | Right federation + discipline; drifting toward a *distributed monolith* via synchronous coupling. |
| **DDD** | **8.0** | Clean ownership; latent risk of treating Lead/Customer/Billing as "one Customer in 3 places." |
| **Source of Truth** | **8.0** | Strong SSOT; latent forecast-vs-actual dual-source in profit/cost. |
| **Event Driven** | **4.0** | **Not EDA.** RPC + webhooks + table-queues. No event log/outbox. Biggest gap vs vision. |
| **Scalability (5–10y)** | **5.5** | Fine now; synchronous contract pulls, finance in-memory idempotency, and no replay break first. |
| **Security** | **7.5** | HMAC+scope+timestamp+request_id solid; secret-rotation undesigned; finance in-memory dedup unsafe multi-instance. |
| **Coupling** | **6.0** | DB-coupling → HTTP-coupling = better encapsulation, **same/worse availability**; accidental runtime coupling on QIMO. |
| **Maintainability** | **6.5** | Clean code/docs; **no cross-system correlation id** → tracing a business event across 3 systems is painful. |
| **AI Constitution** | **9.0** | Best dimension. Human-confirm gates, trace-only, no auto-write; auto-convert correctly killed in 0c. |
| **Operational Complexity** | **6.0** | 3 systems/3 DBs/4 channels; no distributed trace, no replay/DR story yet. |
| **Overall** | **~6.9** | Good direction, real gaps, all cheap to fix *now*. |

---

# P0 Issues (decide before continuing — these are DECISIONS, not code)

> 0c itself is safe to build. These P0s are about **not letting the pattern calcify in 0d.**

**P0-1 — Decide the event backbone NOW (then defer the build).**
You keep referencing an "Event Bus / outbox" as Phase 5, but you are about to build two integrations (0c handoff_queue, 0d finance reconciliation) that are **point-to-point, not event-sourced.** Decision required: adopt the **Transactional Outbox** pattern as the convention — each system writes domain events to an `outbox` table **in its own DB, in the same transaction as the business write**; a relay ships them to consumers. You don't build the bus now (YAGNI at this scale), but you **declare handoff_queue and finance sync as outbox consumers**, so they aren't rebuilt later. Cost now: a design decision + one table convention. Cost in 2 years: re-plumbing 3 systems.

**P0-2 — Reframe the Contract API's role before 0d.**
0b made `finance/order-snapshot` the replacement for finance's direct-DB read — a synchronous pull. That makes finance's runtime depend on QIMO being up. **Decide:** finance reads its **local `synced_orders` cache** (kept fresh by QIMO order events — it already exists!); the Contract API is **reconciliation + gap-fill only**, never the hot path. This is the difference between "federation" and "distributed monolith." If you skip this, 0d hard-codes the wrong dependency.

**P0-3 — Introduce a cross-system `correlation_id` now.**
Today a single business thread (araos deal-won → QIMO order → finance budget → payment) crosses 3 systems with **no shared trace id.** `request_id` is per-call, not per-business-thread. Add a `correlation_id` (or anoint `qimo_order_id` as the business trace) propagated through every log/event/handoff. Cost now: a column + a header convention. Cost in 5 years: un-debuggable production incidents.

**P0-4 — finance idempotency must be durable, not in-memory.**
finance's inbound webhook uses **in-memory** `isRequestProcessed` (1h). On Vercel multi-instance / cold starts this **silently fails to dedup** → double budget drafts. (My 0b contract layer already uses the durable `contract_request_log` table — finance's older path does not.) This is a latent financial-correctness bug today, not a scale problem. Fix before more write paths exist.

---

# P1 Issues (fix soon)

- **P1-1 — "Customer" is one word for three different concepts.** araos `company`(lead) ≠ QIMO `customer`(confirmed) ≠ finance `customer`(billing account). Modeled as linked-by-id (good) but **named as if one entity** (`qimo_customer_id` everywhere). Make the distinction explicit in domain language (Lead / Customer / BillingAccount) to prevent semantic drift over 10 years.
- **P1-2 — Forecast vs actual = latent dual SoT.** `profit_snapshots(forecast)`@QIMO, `(live/final)` must read finance. `order_cost_baseline`@QIMO (estimate) vs finance actual cost. The rule "QIMO never computes live/final" is **documented but not enforced**. One careless PR re-introduces a second profit truth. Add an enforcement note + ideally a guard.
- **P1-3 — Matching is embedded MDM.** Fuzzy customer matching (name/email/phone) inside the handoff endpoint is fine now (advisory), but identity resolution is a **shared capability** that will sprawl across systems. Keep it advisory and **extract to an identity-resolution module** before a second consumer needs it.
- **P1-4 — Secret rotation undesigned.** HMAC secrets are single env values. No rotation story (overlapping keys, key versioning). At 10 systems / key compromise, you'll need zero-downtime rotation. Design the registry to hold **multiple active secrets per key** now.

# P2 Improvements (nice to have)

- P2-1 — Replay/DR story for the outbox/event log (once adopted).
- P2-2 — Rate limiting moved from in-memory to a shared store (Redis/Upstash) when multi-instance.
- P2-3 — A thin "integration health" dashboard (lag, dead-letter, unmatched handoffs).
- P2-4 — Schema-version negotiation beyond `/v1` (consumer capability headers) when >2 consumers.

---

# Architecture Drift — where, and why

1. **Drift from "event-driven" to "RPC-with-extra-steps."** The vision says events; every concrete integration built so far is a synchronous call or a poll-a-table queue. **Why:** events are harder to build than an HTTP route, so each phase reaches for the easy synchronous tool. Each is locally reasonable; together they drift the system away from EDA.
2. **Drift from "federation" toward "distributed monolith."** Replacing finance's direct-DB read with a synchronous Contract pull *feels* like decoupling but installs a **runtime dependency** on QIMO. **Why:** "encapsulation" was optimized for, "availability/autonomy" was not.
3. **Drift from "3 bounded contexts" toward "QIMO-centric hub with thin satellites."** Increasingly everything routes through QIMO (host, identity, contract, queue). **Why:** QIMO is the most-built system, so it accretes responsibility. Watch that finance/araos stay autonomous, not reduced to QIMO appendages.

> None of these is fatal **yet**. All three are at the "cheap to correct now" stage.

---

# Long-Term Risks

**5-year:**
- Synchronous cross-system calls become the availability ceiling (one system down → others degrade).
- No correlation id → production incidents take days, not minutes.
- Point-to-point integrations: adding the 4th system means N×M new wiring instead of "subscribe to events."

**10-year:**
- Without an event log, you **cannot add a new AI agent without backfilling** — agents need history; queues don't keep it.
- The "20 agents / millions of events" target is **architecturally unreachable** on RPC+queues; it requires an event backbone you haven't committed to.
- Over-engineering risk in the *other* direction: if the 10-year AI-OS vision is **not validated**, the contract/scope/reconciliation elaboration is gold-plating for an SME. Match build-complexity to **validated** need; build the event bus when there's a *second* agent, not before.

---

# Recommended Changes (architecture only)

1. **Adopt Transactional Outbox as the integration convention** (decide now, build incrementally). Reclassify `handoff_queue` and finance sync as outbox consumers/projections of events, not bespoke pipes.
2. **Event-carried state transfer for finance.** QIMO pushes order events → finance updates `synced_orders` (local cache) → finance reads its own cache. Contract API = reconciliation/gap-fill, not hot path. **Reframe 0d around this.**
3. **Correlation id across all systems** (business-thread trace), threaded through logs, contract calls, handoffs, webhooks.
4. **Durable idempotency everywhere** (kill finance in-memory dedup; standardize on `*_request_log` tables).
5. **Multi-secret key registry** (rotation-ready) for HMAC.
6. **Name the three customer concepts distinctly** (Lead / Customer / BillingAccount) even though linked by id.
7. **Keep matching advisory + extract** to an identity-resolution module before reuse.

> Explicitly **do NOT** do now: full event sourcing, CQRS read models, a message broker (Kafka/SQS), a service mesh. These are over-engineering at current scale. Outbox + cache + correlation-id give 80% of EDA's durability at 5% of the cost.

---

# Challenge Every Assumption (dimension 12)

| Question | Verdict |
|---|---|
| Should **Contract API** exist? | **Yes, but reframe role** — reconciliation/on-demand, not finance's runtime read path. |
| Should **Handoff Queue** exist? | **Yes** — as a *projection/work-list of handoff events* (decide event model first), not the primary fact store. |
| Should **Matching** exist? | **Yes, advisory only**; extract from the endpoint before reuse. Never let confidence auto-bind (already enforced). |
| Should **Approval** exist? | **Yes** — Constitution core. Keep. |
| Should **Identity Spine** be different? | **Mostly correct.** Add `correlation_id` as a sibling. Keep cross-id columns trace-only. |
| **Event sourcing** replace queues? | **No (full ES) / Yes (outbox).** Adopt outbox, not event sourcing. |
| **Projections** handled differently? | **Yes** — profit live/final should be *event-fed* from finance, not pulled/recomputed. |
| **Dramatically simpler** architecture possible? | For current scale, yes — but 3 real systems justify the federation. Simplify by **not pre-building** scope/phase elaboration ahead of validated need. |

---

# Phase Planning Review

| Phase | Verdict |
|---|---|
| 0a Identity Spine | ✅ Correct, correctly first. |
| 0b Read Contract | ✅ Good — **but reclassify as "reconciliation API," not the read hot path** (P0-2). |
| **0c Handoff Ingestion** | ✅ Safe to proceed — isolated, additive, Constitution-clean. **Add `correlation_id` + treat queue as event-consumer.** |
| 0d finance decouple | ⚠️ **Highest-risk existing time-bomb (live direct-DB coupling).** Do **not** start until P0-1/P0-2 decided. Consider parallelizing the *forecast→event* part earlier. |
| **NEW: Phase 0-Event-Decision** | ➕ **Insert before 0d.** Decide outbox + event-carried-state-transfer + correlation-id. One design doc, no build. |
| 1+ | Re-derive after event decision. |

> Sequencing call: **0c before 0d is defensible** (0c is isolated/low-risk new value; 0d touches live finance and needs the parallel reconciliation). But the finance direct-DB coupling staying live is a standing risk — **don't let 0d slip indefinitely behind feature work.**

---

# Final Verdict

**As the CTO accountable for this platform for 10 years: I approve continuing Phase 0c** — with the auto-convert removal already locked, 0c is isolated, reversible, and Constitution-clean. It does not increase systemic risk.

**But I withhold approval for Phase 0d** until four decisions are made (all design, all cheap now):
1. **Outbox** as the integration convention (P0-1).
2. **Contract API = reconciliation, finance reads local cache via events** (P0-2).
3. **Cross-system `correlation_id`** (P0-3).
4. **Durable idempotency everywhere** (P0-4).

**Why:** the architecture's governance is excellent and rare; its **paradigm is not yet what its vision requires.** 0c won't make that worse. 0d will **permanently encode** the finance↔QIMO pattern — getting it wrong there is the expensive mistake. Decide the event model and the contract role **before** 0d, build them incrementally, and this becomes a genuine Enterprise AI OS rather than three apps wired together synchronously.

**One honest caution against the brief itself:** "20 agents / millions of events" is an *aspiration*, not a validated requirement. Do not build the full event infrastructure for it now — that is the opposite failure mode (gold-plating an SME). Adopt the **cheap, reversible** primitives (outbox table, local cache, correlation id) that keep the 10-year door open without paying for a scale you haven't reached.
</content>

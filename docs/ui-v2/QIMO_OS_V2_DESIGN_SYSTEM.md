# QIMO OS V2 Design System

This system is a UX foundation, not a visual re-skin.

It standardizes hierarchy, density, and interaction patterns across QIMO OS.

## 1. Design Tokens

### Colors

#### Background

- `--qimo-page`: `#F8FAFC`
- `--qimo-bg`: `#FAFBFC`
- `--qimo-surface`: `#FFFFFF`
- `--qimo-surface-muted`: `#F5F7FB`
- `--qimo-border`: `#E2E8F0`

#### Text

- `--qimo-text`: `#0F172A`
- `--qimo-text-primary`: `#182033`
- `--qimo-text-secondary`: `#475569`
- `--qimo-muted`: `#94A3B8`
- `--qimo-text-muted`: `#8A93A6`
- `--qimo-text-disabled`: `#B5BDCC`

#### Brand / role color mapping

- `--qimo-primary`: `#4F46E5`
- `--qimo-primary-hover`: `#4338CA`
- `--qimo-primary-soft`: `#EEF2FF`
- `--qimo-brand`: `#4F46E5`
- `--qimo-brand-hover`: `#4338CA`
- `--qimo-brand-soft`: `#EEF2FF`
- `--qimo-order`: `#3B82F6`
- `--qimo-procurement`: `#14B8A6`
- `--qimo-production`: `#22C55E`
- `--qimo-logistics`: `#F59E0B`
- `--qimo-finance`: `#8B5CF6`

#### Semantic

- `--qimo-success`: `#059669`
- `--qimo-warning`: `#D97706`
- `--qimo-risk`: `#E11D48`
- `--qimo-critical`: `#DC2626`
- `--qimo-info`: `#0284C7`

Color rules:

- purple / blue for navigation and primary actions;
- green for completed / healthy;
- orange for waiting / attention;
- red only for blocked / overdue / high risk;
- gray for secondary / inactive state.

### Typography

- Page title: `32px`, `700`, `1.15`
- Section title: `22px`, `600`, `1.2`
- Card title: `18px`, `600`, `1.25`
- Body: `14px`, `400`, `1.5`
- Caption: `12px`, `400`, `1.35`

Typography rules:

- use one font system across the product;
- keep Chinese headings compact;
- avoid uppercase styling on Chinese labels;
- avoid excessive tracking in operational UI.

### Spacing

Use a fixed spacing scale only:

- `8`
- `16`
- `24`
- `32`
- `48`

### Radius

Approved radius scale:

- `8px` for controls
- `12px` for cards
- `16px` for higher-level surfaces

### Shadow

- `none`
- `subtle`
- `floating`

Do not use heavy gradients or glass effects.

## 2. Shared Components

### `QimoPage`

Usage: page shell for module centers and detail workspaces.

Variants: `default`, `compact`.

Role behavior: content only, no business logic.

Accessibility: main landmark, predictable heading order.

Prohibited usage: nested inside another page shell.

### `QimoPageHeader`

Usage: module title, subtitle, search, refresh, settings, more.

Variants: `default`, `compact`.

Accessibility: title must be a real heading.

Prohibited usage: oversized hero headers.

### `QimoQuickEntryItem` / `QimoQuickEntry`

Usage: primary navigation cards at the top of module dashboards.

Variants: `default`, `active`, `disabled`.

States: hover, focus, active, disabled.

Accessibility: full-surface click target, visible focus ring, keyboard activation.

Prohibited usage: nested button inside button, subtitle-heavy card.

### `QimoKpiGrid` / `QimoKpiCard`

Usage: six-card KPI summary row.

Variants: `neutral`, `success`, `warning`, `risk`, `info`.

Prohibited usage: more than one number hierarchy per card.

### `QimoAiToday`

Usage: AI recommendations with evidence and next action.

Must show:

- suggestion;
- reason;
- evidence;
- impact;
- owner;
- confidence.

Prohibited usage: conversational AI panel without a decision.

### `QimoApprovalCard`

Usage: short approval queue items.

Max visible rows: 5.

Prohibited usage: approval tables in dashboard context.

### `QimoRiskCard`

Usage: compact risk summary rows.

Must show:

- object;
- reason;
- owner;
- next step;
- impact.

Prohibited usage: risk tables on the homepage.

### `QimoCommandGrid` / `QimoCommandPanel`

Usage: multi-column dashboard panel layout.

Prohibited usage: wrapping heavy tables.

### `QimoCompactTaskRow`

Usage: collapsed workbench row or compact command panel row.

Prohibited usage: card-with-card nesting.

### `QimoDataTable`

Usage: volume-oriented workbench data.

Rules:

- paginate or virtualize when large;
- keep headers stable;
- avoid wrapping every column.

### `QimoFilterBar`

Usage: search, filter, saved-view controls.

Prohibited usage: dense action bar with unrelated buttons.

### `QimoStickySummary`

Usage: detail pages.

Must show identity, current stage, current owner, next action, risk state.

### `QimoCollapsibleSection`

Usage: large datasets and optional modules.

Must default to collapsed when the section is optional or heavy.

### `QimoExternalSystemEntry`

Usage: portal-only card for ARAOS and Finance OS.

Prohibited usage: inside core execution stage flows.

## 3. Status Registry

| Canonical status | Chinese label | Semantic category | Color | Icon | Severity | Actionable | Modules |
|---|---|---|---|---|---|---|---|
| draft | 草稿 | neutral | gray | ○ | low | yes | forms, intake |
| pending_confirmation | 待确认 | attention | orange | ◐ | medium | yes | orders, procurement |
| pending_approval | 待审批 | attention | orange | ◔ | medium | yes | approvals, change requests |
| in_progress | 进行中 | active | blue | ● | medium | yes | all core modules |
| completed | 已完成 | success | green | ✓ | low | no | all core modules |
| cancelled | 已取消 | neutral | gray | ✕ | low | no | orders, approvals |
| overdue | 已超期 | risk | red | ! | high | yes | orders, production, logistics |
| risk | 风险 | risk | red | ! | high | yes | all modules |
| blocked | 阻塞 | critical | red | ⛔ | critical | yes | all modules |
| partial | 部分完成 | attention | orange | ◑ | medium | yes | production, logistics |
| missing_info | 待补资料 | attention | orange | ? | medium | yes | orders, intake |
| pending_assignment | 待分配 | attention | orange | ⇢ | medium | yes | production, procurement |
| ready_to_ship | 待出货 | active | blue | ↗ | medium | yes | logistics |

Status rules:

- the same status must never change color between modules;
- different statuses must not share identical treatment when meaning differs materially;
- red is reserved for blocked, overdue, or high-risk conditions only.

## 4. Component Tree

Recommended shell order:

1. `QimoPage`
2. `QimoPageHeader`
3. `QimoQuickEntryItem`
4. `QimoKpiGrid`
5. `QimoAiToday`
6. `QimoApprovalCard`
7. `QimoRiskCard`
8. `QimoCommandGrid`
9. `QimoCollapsibleSection`
10. `QimoDataTable` or `QimoCompactTaskRow`
11. Detail route

## 5. Migration Map

### Existing components to absorb

- `Navbar` → shell/header primitives
- `CollapsibleSection` → `QimoCollapsibleSection`
- `TaskCard` → `QimoCompactTaskRow`
- `DashboardAIAdvice` → `QimoAiToday`
- `CollabRiskGroups` → `QimoRiskCard`
- `OrderSearchBar` → `QimoFilterBar`
- `ExpandableList` → `QimoCollapsibleSection` or `QimoDataTable`

### Components to keep domain-specific

- order forms;
- production scheduling;
- procurement ledgers;
- logistics shipment flows;
- approval execution actions.

## 6. Non-Goals

- no database changes;
- no workflow state changes;
- no RBAC changes;
- no server action changes;
- no API changes;
- no AI agent changes.

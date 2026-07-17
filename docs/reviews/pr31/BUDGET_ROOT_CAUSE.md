# PR #31 Budget Unit Price Root Cause

Issue reviewed:

- “面料单价保存后自动消失”
- current PR adds save → read-back → compare → notify UX

## Evidence trail

### Write path

`app/actions/procurement-items.ts`

`saveBomBudgetUnitPrice(orderId, entries)`:

- authenticates the user
- checks role membership in the budget-edit role list
- loops `materials_bom` rows
- writes:

  ```ts
  .update({ budget_unit_price: v }).eq('id', bomId).eq('order_id', orderId)
  ```

- only checks `error`
- does not verify affected row count
- does not re-read the written row in the action itself

### Read path

`listBomConsumptionLines(orderId)` in the same file:

- reads `materials_bom`
- exposes:

  ```ts
  budget_unit_price: b.budget_unit_price ?? quoteOf(b).price ?? null
  ```

- so if `budget_unit_price` is still null, the UI falls back to quote-baseline data

### UI path

`components/tabs/BomBudgetEntry.tsx`

- saves budget data
- re-reads the same model
- compares `expected` vs `actual`
- shows a warning if the read-back does not match

`components/tabs/ProcurementItemsTab.tsx`

- same pattern for the procurement summary surface

## Root cause answer

The mismatch is caused by a persistence/read-back boundary problem:

1. the write action can complete without proving that a row actually changed
2. the read model can still fall back to quote-baseline data when `budget_unit_price` is null
3. the UI therefore cannot distinguish:
   - a real persisted value
   - a no-op write
   - a read that fell back to baseline

I did not find a competing writer in the repository that intentionally overwrites `materials_bom.budget_unit_price` after save.
I also did not find a client-side state overwrite that would explain the symptom by itself.

That localizes the failure to the server-action persistence contract and the read-model fallback, not to React state alone.

## Why did it happen?

The likely mechanism is:

- a save request did not persist the intended value for at least one row, or
- the UI rehydrated from a fallback source because the persisted field was still null

The code does not currently prove which of those two happened on every save.

## Can it happen again?

Yes.

As long as the action:

- uses a row update without checking affected rows
- and the read path silently substitutes fallback data

the same symptom can recur.

## Which layer is responsible?

Primary responsibility:

- `app/actions/procurement-items.ts`
  - `saveBomBudgetUnitPrice()`
  - `listBomConsumptionLines()`

Secondary responsibility:

- the budget-entry UI for showing a warning instead of silently pretending the value persisted

This is not a React-only issue.
This is a write-path truthfulness issue.

## Can this PR permanently solve it?

No.

This PR improves user feedback and makes mismatches visible, but it does not fully eliminate the underlying persistence risk.

## Permanent fix

The permanent fix should be a follow-up server-side hardening change:

1. make the write path prove persistence
   - require a non-zero affected row count, or
   - use a write path that cannot silently no-op
2. return an explicit failure when the row was not actually written
3. keep the read model on one authoritative source
4. keep the UI read-back warning so operators can see the truth immediately

## Conclusion

The PR improves detection and operator feedback.
The root cause is still the save/read truth boundary.
The symptom can recur until the server action proves the write actually landed.


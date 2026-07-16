# Create Order customer selection execution trace

## Flow and former failure

`LegacyOrderForm` uploads the PO, calls the PO parser, and receives recognized text such as `伊彤`. The old autofill code directly changed `CustomerSelect`'s hidden `customer_name` DOM input. It did not select a customer record and therefore never populated `customer_id`.

At the same time, `CustomerSelect` owned a separate internal `selected` record, while `LegacyOrderForm` owned only a customer-name string read from DOM change events. The green PO summary rendered the AI text and said it had been filled in. React could subsequently restore the controlled hidden inputs from the selector's empty internal state. On submit, `FormData` therefore contained an empty `customer_id` and usually an empty `customer_name`, despite the visible AI summary showing `伊彤`.

The submission path is:

`PO parser result` → recognized-name suggestion → `CustomerSelect` employee selection → canonical `{ id, name }` in `LegacyOrderForm` → submit-time `FormData` rewrite → `createOrder` server action → authorized customer lookup → order validation → `createOrderRepo` insert → attachments/BOM/Finance initialization.

## Fixed contract

- The parent owns one nullable `{ id, name }` selection. The selector changes or clears the pair atomically.
- AI text is only a suggestion and never mutates customer hidden fields. Manual selection remains authoritative.
- The UI distinguishes `AI识别客户：…，待确认`, `已选择客户：…`, and `尚未选择客户`.
- Both initial submit and delayed post-dialog submit rewrite `customer_id` and `customer_name` from current canonical state. Missing confirmation is blocked at the customer field.
- Safe draft restoration reconstructs the pair only when both values exist. Generic DOM restoration skips both customer fields.
- The server requires `customer_id`, resolves an active customer through the authenticated caller's RLS scope, derives the canonical database name, and rejects a conflicting client pair.

## Transaction safety

Customer validation executes before duplicate checks, order insertion, attachment upload, BOM work, or Finance initialization. The reported empty-customer failure therefore cannot create a partial order through this code path. Existing submission-in-flight and order-number idempotency guards remain unchanged.

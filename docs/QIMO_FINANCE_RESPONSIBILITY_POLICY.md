# QIMO finance responsibility policy

The implemented operating model is **B: event-driven finance queues**.

Order Metronome creates finance work from order review, budget confirmation, payable, receivable, shipment-release and settlement events. There is no reliable existing business rule assigning one finance employee for the whole lifetime of each order. `finance_owner` therefore remains optional and is used only when an authorized Finance workflow explicitly assigns a named case owner.

No automatic `finance_owner` row is created from order creation, procurement or shipment. Responsibility assignment never grants payment approval, posting authority, settlement override or access to operational decisions. Existing Finance-system approval and human identity remain authoritative.

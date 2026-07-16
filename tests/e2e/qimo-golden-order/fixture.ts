export const GOLDEN_ORDER = {
  id: 'TEST-QIMO-E2E-001',
  customer: 'TEST / NOT A REAL CUSTOMER',
  poNumber: 'TEST-PO-001',
  internalOrderNo: 'TEST-INTERNAL-001',
  quantitySets: 7700,
  piecesPerSet: 2,
  currency: 'USD',
  paymentTerms: '30% deposit, 70% before shipment',
  styles: [{
    styleNo: 'TEST-STYLE-001',
    colors: ['TEST BLACK', 'TEST BLUE'],
    sizes: { S: 1000, M: 2200, L: 2700, XL: 1800 },
    components: [
      { name: 'TEST TOP', consumption: '0.35', unit: 'kg/件', basis: 'PER_SET' as const },
      { name: 'TEST BOTTOM', consumption: '0.32', unit: 'kg/件', basis: 'PER_SET' as const },
    ],
  }],
  packaging: { packQuantity: 1, cartonMark: 'TEST / NOT REAL' },
  qc: { firstPiece: true, inline: true, final: true },
  shipments: [{ quantity: 4000 }, { quantity: 3700 }],
  receivables: [{ percent: 30 }, { percent: 70 }],
} as const;

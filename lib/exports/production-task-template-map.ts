export const PRODUCTION_TASK_TEMPLATE_VERSION = 'QIMO 生产任务单标准模板 V1.0';
export const PRODUCTION_TASK_TEMPLATE_RELATIVE_PATH =
  'public/templates/QIMO_生产任务单标准模板_V1.0.xlsx';

export const PRODUCTION_TASK_SHEETS = {
  main: 'LU21-SET 上衣',
  size: 'LU21-SET尺寸表',
} as const;

/** Only these master-template cells may receive business values. */
export const PRODUCTION_TASK_CELLS = {
  header: {
    internalOrderNumber: 'D2', orderDate: 'J2', productName: 'D3', materialComposition: 'J3',
    deliveryDate: 'D4', fabricWeight: 'J4', totalQuantity: 'D5',
  },
  colorRows: [7, 8, 9, 10],
  colorColumns: {
    styleNumber: 'A', color: 'B', cartonCount: 'C', colorQuantity: 'D',
    sizes: ['E', 'F', 'G'], packaging: 'H',
  },
  totals: { cartonCount: 'C11', quantity: 'D11' },
  consumption: 'A12',
  sampling: {
    preProductionDate: 'B14', preProductionRequirement: 'D14',
    shipmentDate: 'B15', shipmentRequirement: 'D15',
  },
  requirements: {
    garmentAccessories: 'B16', packagingAccessories: 'B17', cutting: 'B18', sewing: 'B19',
    inspection: 'B20', packaging: 'B21', carton: 'B22', attention: 'B23',
  },
  signature: { receiver: 'B25', receiptTime: 'J25' },
  size: {
    title: 'A1', topSizeColumns: ['C', 'D', 'E'], bottomSizeColumns: ['H', 'I', 'J'],
    rows: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13], topSequence: 'A', topPosition: 'B',
    bottomPosition: 'G',
  },
} as const;

export const PRODUCTION_TASK_FIXED_CELLS = [
  'A1', 'A2', 'I2', 'A3', 'I3', 'A4', 'I4', 'A5', 'I5',
  'A6', 'B6', 'C6', 'D6', 'H6', 'A11', 'B13', 'D13', 'A14', 'A15',
  'A16', 'A17', 'A18', 'A19', 'A20', 'A21', 'A22', 'A23', 'A24', 'A25', 'I25',
] as const;

export type ProductionTaskSizeMeasurement = {
  sequence?: string | number | null;
  position?: string | null;
  values?: Record<string, string | number | null | undefined> | null;
};

export type ProductionTaskTemplateModel = {
  internalOrderNumber?: string | null; customer?: string | null; orderDate?: string | Date | null;
  productName?: string | null; materialComposition?: string | null; deliveryDate?: string | Date | null;
  fabricWeight?: string | null; totalQuantity?: number | null; styleNumber?: string | null;
  quantityBasis?: 'piece' | 'set' | 'component';
  colors: Array<{ styleNumber?: string | null; color?: string | null; colorCn?: string | null; colorEn?: string | null;
    cartonCount?: number | null; quantity?: number | null; sizes?: Record<string, number | null | undefined> | null }>;
  sizeOrder?: string[] | null; customerPackaging?: string | null;
  fabrics?: Array<{ name?: string | null; consumption?: number | null; unit?: string | null; basis?: string | null }>;
  sampling?: { preProductionDate?: string | null; preProductionRequirement?: string | null;
    shipmentDate?: string | null; shipmentRequirement?: string | null };
  requirements?: { garmentAccessories?: string | null; packagingAccessories?: string | null;
    cutting?: string | null; sewing?: string | null; inspection?: string | null; packaging?: string | null;
    carton?: string | null; attention?: string | null };
  receiver?: string | null; receiptTime?: string | Date | null;
  sizeChart?: { top?: ProductionTaskSizeMeasurement[] | null; bottom?: ProductionTaskSizeMeasurement[] | null } | null;
};

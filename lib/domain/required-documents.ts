/**
 * Required Documents per Milestone (V1)
 *
 * This module defines document types and required documents for each milestone step_key.
 * Used to enforce evidence gates - staff cannot mark milestones as done without
 * uploading the required supporting documents.
 */

// Document type enum
export type DocumentType =
  | 'PO'
  | 'PO_CONFIRM_EMAIL'
  | 'PRODUCTION_SHEET'
  | 'PACKING_SPEC'
  | 'PROCUREMENT_SHEET'
  | 'SUPPLIER_PO'
  | 'IQC_REPORT'
  | 'TEST_REPORT'
  | 'SAMPLE_PHOTO'
  | 'COURIER_RECEIPT'
  | 'CUSTOMER_APPROVAL'
  | 'QA_REPORT'
  | 'PACKING_MATERIAL_RECEIPT'
  | 'LABEL_PHOTO'
  | 'BOOKING_CONFIRMATION'
  | 'CI'
  | 'PL'
  | 'BL_DRAFT'
  | 'PAYMENT_RECEIPT'
  | 'OTHER';

// Document type labels (Chinese)
export const DOC_TYPE_LABELS: Record<DocumentType, string> = {
  PO: 'PO订单',
  PO_CONFIRM_EMAIL: 'PO确认邮件',
  PRODUCTION_SHEET: '生产工艺单',
  PACKING_SPEC: '包装规格书',
  PROCUREMENT_SHEET: '采购单',
  SUPPLIER_PO: '供应商订单',
  IQC_REPORT: 'IQC检验报告',
  TEST_REPORT: '测试报告',
  SAMPLE_PHOTO: '样品照片',
  COURIER_RECEIPT: '快递单据',
  CUSTOMER_APPROVAL: '客户确认',
  QA_REPORT: 'QA验货报告',
  PACKING_MATERIAL_RECEIPT: '包材到货单',
  LABEL_PHOTO: '唛头/标签照片',
  BOOKING_CONFIRMATION: '订舱确认',
  CI: '商业发票(CI)',
  PL: '装箱单(PL)',
  BL_DRAFT: '提单草稿(BL Draft)',
  PAYMENT_RECEIPT: '付款凭证',
  OTHER: '其他',
};

// All document types for dropdown
export const ALL_DOC_TYPES: DocumentType[] = [
  'PO',
  'PO_CONFIRM_EMAIL',
  'PRODUCTION_SHEET',
  'PACKING_SPEC',
  'PROCUREMENT_SHEET',
  'SUPPLIER_PO',
  'IQC_REPORT',
  'TEST_REPORT',
  'SAMPLE_PHOTO',
  'COURIER_RECEIPT',
  'CUSTOMER_APPROVAL',
  'QA_REPORT',
  'PACKING_MATERIAL_RECEIPT',
  'LABEL_PHOTO',
  'BOOKING_CONFIRMATION',
  'CI',
  'PL',
  'BL_DRAFT',
  'PAYMENT_RECEIPT',
  'OTHER',
];

// Required document types per milestone step_key
// Key: step_key, Value: array of required document types
export const REQUIRED_DOCS_BY_STEP: Record<string, DocumentType[]> = {
  // A. Order Setup Chain
  po_confirmed: ['PO', 'PO_CONFIRM_EMAIL'],
  order_docs_complete: ['PRODUCTION_SHEET'],
  rm_purchase_sheet_submit: ['PROCUREMENT_SHEET'],
  procurement_order_placed: ['SUPPLIER_PO'],
  materials_received_inspected: ['IQC_REPORT'],

  // B. PPS & Start Production
  pps_ready: ['SAMPLE_PHOTO'],
  pps_sent: ['COURIER_RECEIPT'],
  pps_customer_approved: ['CUSTOMER_APPROVAL'],

  // C. Production → Shipping
  final_qc_check: ['QA_REPORT'],
  packaging_materials_ready: ['PACKING_MATERIAL_RECEIPT'],
  packing_labeling_done: ['LABEL_PHOTO'],
  booking_done: ['BOOKING_CONFIRMATION'],

  // D. Ship & Payment
  shipment_done: ['CI', 'PL'], // BL_DRAFT is optional
  payment_received: ['PAYMENT_RECEIPT'],
};

// Optional but recommended documents (not blocking)
export const OPTIONAL_DOCS_BY_STEP: Record<string, DocumentType[]> = {
  order_docs_complete: ['PACKING_SPEC'],
  materials_received_inspected: ['TEST_REPORT'],
  shipment_done: ['BL_DRAFT'],
};

/**
 * Get required document types for a milestone step_key
 */
export function getRequiredDocsForStep(stepKey: string): DocumentType[] {
  return REQUIRED_DOCS_BY_STEP[stepKey] || [];
}

/**
 * Get optional document types for a milestone step_key
 */
export function getOptionalDocsForStep(stepKey: string): DocumentType[] {
  return OPTIONAL_DOCS_BY_STEP[stepKey] || [];
}

/**
 * Check if a milestone has required documents defined
 */
export function hasRequiredDocs(stepKey: string): boolean {
  const required = REQUIRED_DOCS_BY_STEP[stepKey];
  return !!required && required.length > 0;
}

/**
 * Get default document type suggestion for a milestone
 * Returns the first required doc type, or 'OTHER' if none defined
 */
export function getDefaultDocType(stepKey: string): DocumentType {
  const required = REQUIRED_DOCS_BY_STEP[stepKey];
  return required && required.length > 0 ? required[0] : 'OTHER';
}

/**
 * Get document type label in Chinese
 */
export function getDocTypeLabel(docType: DocumentType | string): string {
  return DOC_TYPE_LABELS[docType as DocumentType] || docType;
}

/**
 * Validate uploaded documents against requirements
 * Returns missing document types
 */
export function validateRequiredDocs(
  stepKey: string,
  uploadedDocTypes: (string | null)[]
): { isValid: boolean; missingDocs: DocumentType[] } {
  const required = getRequiredDocsForStep(stepKey);

  if (required.length === 0) {
    return { isValid: true, missingDocs: [] };
  }

  const uploadedSet = new Set(uploadedDocTypes.filter(Boolean));
  const missingDocs = required.filter(docType => !uploadedSet.has(docType));

  return {
    isValid: missingDocs.length === 0,
    missingDocs,
  };
}

/**
 * Get all document types that can be uploaded for a milestone
 * Prioritizes required and optional docs, then adds OTHER
 */
export function getAvailableDocTypes(stepKey: string): DocumentType[] {
  const required = getRequiredDocsForStep(stepKey);
  const optional = getOptionalDocsForStep(stepKey);

  // Create unique list: required first, then optional, then OTHER
  const docTypes = new Set<DocumentType>([...required, ...optional]);

  // Add all other types for flexibility
  ALL_DOC_TYPES.forEach(dt => docTypes.add(dt));

  return Array.from(docTypes);
}

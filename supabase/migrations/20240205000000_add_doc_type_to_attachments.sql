-- Migration: Add doc_type field to attachments table for document classification
-- This enables the "Required Documents per Milestone" feature (V1)

-- Add doc_type column (nullable for backward compatibility)
ALTER TABLE public.attachments
ADD COLUMN IF NOT EXISTS doc_type text;

-- Add required_for_step_key column (optional link to milestone step_key)
ALTER TABLE public.attachments
ADD COLUMN IF NOT EXISTS required_for_step_key text;

-- Create index for faster queries by doc_type
CREATE INDEX IF NOT EXISTS idx_attachments_doc_type ON public.attachments(doc_type);

-- Create index for faster queries by required_for_step_key
CREATE INDEX IF NOT EXISTS idx_attachments_required_for_step_key ON public.attachments(required_for_step_key);

-- Add comments
COMMENT ON COLUMN public.attachments.doc_type IS 'Document type classification (e.g., PO, PO_CONFIRM_EMAIL, PRODUCTION_SHEET, etc.)';
COMMENT ON COLUMN public.attachments.required_for_step_key IS 'Optional: which milestone step_key this document is required for';

-- V1 Document Types:
-- PO, PO_CONFIRM_EMAIL, PRODUCTION_SHEET, PACKING_SPEC,
-- PROCUREMENT_SHEET, SUPPLIER_PO,
-- IQC_REPORT, TEST_REPORT,
-- SAMPLE_PHOTO, COURIER_RECEIPT,
-- CUSTOMER_APPROVAL, QA_REPORT,
-- PACKING_MATERIAL_RECEIPT, LABEL_PHOTO,
-- BOOKING_CONFIRMATION,
-- CI, PL, BL_DRAFT,
-- PAYMENT_RECEIPT, OTHER

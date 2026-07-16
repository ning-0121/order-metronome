export type SelectedCustomer = { id: string; name: string } | null;

export function toSelectedCustomer(customer: { id?: string | null; customer_name?: string | null }): SelectedCustomer {
  const id = customer.id?.trim();
  const name = customer.customer_name?.trim();
  return id && name ? { id, name } : null;
}

export function selectedCustomerFromDraft(fields: Array<[string, string]>): SelectedCustomer {
  const values = new Map(fields);
  const id = values.get('customer_id')?.trim();
  const name = values.get('customer_name')?.trim();
  return id && name ? { id, name } : null;
}

export function writeSelectedCustomer(formData: FormData, selected: SelectedCustomer): boolean {
  if (!selected?.id.trim() || !selected.name.trim()) {
    formData.delete('customer_id');
    formData.delete('customer_name');
    return false;
  }
  formData.set('customer_id', selected.id.trim());
  formData.set('customer_name', selected.name.trim());
  return true;
}

export function customerSelectionLabel(selected: SelectedCustomer, recognizedName: string): string {
  if (selected) return `已选择客户：${selected.name}`;
  if (recognizedName.trim()) return `AI识别客户：${recognizedName.trim()}，待确认`;
  return '尚未选择客户';
}

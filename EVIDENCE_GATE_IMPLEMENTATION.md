# Evidence Gate Implementation

## Summary
Implemented Evidence Gate feature for milestones with file upload, storage, and completion blocking.

---

## Files Created/Modified

### 1. Migration: `supabase/migrations/20240122000000_add_attachments_table.sql`

**Created:** New attachments table with RLS policies.

**Schema:**
```sql
CREATE TABLE public.attachments (
  id uuid PRIMARY KEY,
  milestone_id uuid REFERENCES milestones(id) ON DELETE CASCADE,
  order_id uuid REFERENCES orders(id) ON DELETE CASCADE,
  url text NOT NULL,
  file_name text,
  file_type text,
  uploaded_by uuid REFERENCES auth.users(id),
  created_at timestamptz DEFAULT now()
);
```

**RLS Policies:**
- **SELECT**: Order owner or admin can view attachments
- **INSERT**: Order owner or admin can upload attachments
- **DELETE**: Order owner or admin can delete attachments

**Indexes:**
- `idx_attachments_milestone_id`
- `idx_attachments_order_id`
- `idx_attachments_uploaded_by`

---

### 2. Server Actions: `app/actions/attachments.ts` (NEW)

**Functions:**

1. **`getAttachmentsByMilestone(milestoneId)`**
   - Fetch all attachments for a milestone
   - Returns sorted by `created_at` descending

2. **`getAttachmentsByOrder(orderId)`**
   - Fetch all attachments for an order
   - Returns sorted by `created_at` descending

3. **`uploadEvidence(milestoneId, orderId, file)`**
   - Uploads file to Supabase Storage bucket "evidence"
   - Creates attachment record in database
   - Logs action to milestone_logs
   - Returns attachment data or error

4. **`deleteAttachment(attachmentId, orderId)`**
   - Deletes file from Supabase Storage
   - Deletes attachment record from database
   - Returns error if any

5. **`checkMilestoneEvidence(milestoneId)`**
   - Checks if milestone requires evidence
   - Returns `hasEvidence: boolean` and error

---

### 3. Component: `components/EvidenceUpload.tsx` (NEW)

**Features:**
- Shows "Evidence Required" section when `evidence_required=true`
- File upload input with progress indicator
- Lists uploaded files with download links
- Delete button for each file
- Warning message if no evidence uploaded
- Success indicator showing file count

**UI Elements:**
- Blue background section (`bg-blue-50`)
- File upload input
- File list with download links
- Delete buttons (✕)
- Warning message for missing evidence
- Success badge showing file count

---

### 4. Updated: `app/actions/milestones.ts`

**Changes:**

1. **`markMilestoneDone()` - Evidence Check:**
   ```typescript
   // Check if evidence is required and exists
   if (milestone.evidence_required) {
     const { data: attachments } = await supabase
       .from('attachments')
       .select('id')
       .eq('milestone_id', milestoneId)
       .limit(1);
     
     if (!attachments || attachments.length === 0) {
       return { error: 'Evidence is required. Please upload at least one file before marking this milestone as done.' };
     }
   }
   ```

2. **`logEvidenceUpload()` - New Function:**
   - Logs `upload_evidence` action to milestone_logs
   - Includes file name in note

**Updated Log Action Type:**
- Added `'upload_evidence'` to `MilestoneLogAction` type

---

### 5. Updated: `components/OrderTimeline.tsx`

**Changes:**
- Added `EvidenceUpload` component import
- Renders `EvidenceUpload` in expanded milestone details
- Positioned before `MilestoneActions` component

**Code:**
```typescript
{isExpanded && (
  <div className="mt-4 space-y-4 border-t border-gray-200 pt-4">
    {/* Evidence Upload Section */}
    <EvidenceUpload
      milestoneId={milestone.id}
      orderId={orderId}
      evidenceRequired={milestone.evidence_required || false}
    />
    
    <MilestoneActions milestone={milestone} />
    {/* ... rest of expanded content */}
  </div>
)}
```

---

## Supabase Storage Setup

**Bucket Name:** `evidence`

**Required Setup:**
1. Create bucket in Supabase Dashboard:
   - Go to Storage → Create Bucket
   - Name: `evidence`
   - Public: Yes (for public URLs)
   - File size limit: Configure as needed
   - Allowed MIME types: Configure as needed

2. **RLS Policies for Storage:**
   - Users can upload to `evidence/{milestoneId}/*`
   - Users can read from `evidence/*`
   - Users can delete from `evidence/{milestoneId}/*`

**Note:** The migration file does not create the bucket automatically. You must create it manually in Supabase Dashboard.

---

## Workflow

### 1. Upload Evidence
1. User expands milestone details
2. If `evidence_required=true`, Evidence Upload section appears
3. User selects file and uploads
4. File is uploaded to Supabase Storage bucket "evidence"
5. Attachment record is created in database
6. Action is logged to milestone_logs with `upload_evidence`

### 2. View Evidence
1. Evidence Upload section shows list of uploaded files
2. Each file has:
   - File name (clickable link)
   - Upload date
   - File type
   - Delete button

### 3. Complete Milestone
1. User clicks "Done" button
2. System checks if `evidence_required=true`
3. If required, checks if attachments exist
4. If no attachments, blocks completion with error message
5. If attachments exist, allows completion

### 4. Delete Evidence
1. User clicks delete button (✕)
2. Confirmation dialog appears
3. File is deleted from Storage
4. Attachment record is deleted from database
5. UI refreshes to show updated list

---

## Database Schema

### `attachments` Table
| Column | Type | Constraints |
|--------|------|-------------|
| id | uuid | PRIMARY KEY, DEFAULT gen_random_uuid() |
| milestone_id | uuid | NOT NULL, FK milestones(id) ON DELETE CASCADE |
| order_id | uuid | NOT NULL, FK orders(id) ON DELETE CASCADE |
| url | text | NOT NULL |
| file_name | text | NULL |
| file_type | text | NULL |
| uploaded_by | uuid | NULL, FK auth.users(id) |
| created_at | timestamptz | DEFAULT now() |

### Relationships
- `attachments.milestone_id` → `milestones.id` (CASCADE DELETE)
- `attachments.order_id` → `orders.id` (CASCADE DELETE)
- `attachments.uploaded_by` → `auth.users.id`

---

## RLS Policies

### SELECT Policy
```sql
CREATE POLICY "Order owner or admin can select attachments"
  ON public.attachments FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.orders o
      WHERE o.id = attachments.order_id
      AND (
        o.created_by = auth.uid()
        OR EXISTS (
          SELECT 1 FROM public.profiles p
          WHERE p.user_id = auth.uid()
          AND p.role = 'admin'
        )
      )
    )
  );
```

### INSERT Policy
```sql
CREATE POLICY "Order owner or admin can insert attachments"
  ON public.attachments FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.orders o
      WHERE o.id = attachments.order_id
      AND (
        o.created_by = auth.uid()
        OR EXISTS (
          SELECT 1 FROM public.profiles p
          WHERE p.user_id = auth.uid()
          AND p.role = 'admin'
        )
      )
    )
  );
```

### DELETE Policy
```sql
CREATE POLICY "Order owner or admin can delete attachments"
  ON public.attachments FOR DELETE
  USING (
    EXISTS (
      SELECT 1 FROM public.orders o
      WHERE o.id = attachments.order_id
      AND (
        o.created_by = auth.uid()
        OR EXISTS (
          SELECT 1 FROM public.profiles p
          WHERE p.user_id = auth.uid()
          AND p.role = 'admin'
        )
      )
    )
  );
```

---

## Milestone Logs

**Action Type:** `upload_evidence`

**Log Entry:**
```json
{
  "milestone_id": "uuid",
  "order_id": "uuid",
  "actor_user_id": "uuid",
  "action": "upload_evidence",
  "note": "Uploaded evidence: filename.pdf",
  "created_at": "timestamp"
}
```

---

## Error Handling

### Upload Errors
- **Not authenticated**: Returns error "Not authenticated"
- **Upload failed**: Returns error with Supabase Storage error message
- **Insert failed**: Returns error, cleans up uploaded file

### Completion Blocking
- **Evidence required but missing**: Returns error message:
  ```
  "Evidence is required. Please upload at least one file before marking this milestone as done."
  ```

### Delete Errors
- **Attachment not found**: Returns error "Attachment not found"
- **Delete failed**: Returns error with Supabase error message

---

## UI/UX Features

1. **Visual Indicators:**
   - Blue background section for evidence area
   - Success badge showing file count
   - Warning message if no evidence uploaded
   - File list with download links

2. **User Feedback:**
   - Loading states during upload/delete
   - Error messages displayed in red
   - Success indicators
   - Confirmation dialog for delete

3. **Accessibility:**
   - Clear labels
   - Button states (disabled during loading)
   - Error messages
   - File type and date information

---

## Testing Checklist

- [ ] Create Supabase Storage bucket "evidence"
- [ ] Run migration to create attachments table
- [ ] Test file upload for milestone with `evidence_required=true`
- [ ] Test file download (click file name)
- [ ] Test file delete
- [ ] Test milestone completion with evidence
- [ ] Test milestone completion without evidence (should block)
- [ ] Test RLS policies (order owner vs admin vs other user)
- [ ] Verify milestone_logs entries for upload_evidence
- [ ] Test multiple file uploads
- [ ] Test file upload for milestone with `evidence_required=false` (should not show)

---

## Status

✅ **Complete** - Evidence Gate feature implemented:
- Attachments table with RLS
- File upload to Supabase Storage
- Evidence check before milestone completion
- UI components for upload/view/delete
- Logging to milestone_logs
- Build passes successfully

---

## Next Steps

1. **Create Supabase Storage Bucket:**
   - Go to Supabase Dashboard → Storage
   - Create bucket named "evidence"
   - Set as public (or configure RLS for Storage)

2. **Run Migration:**
   - Apply `20240122000000_add_attachments_table.sql`

3. **Test:**
   - Upload evidence for milestone with `evidence_required=true`
   - Try to complete milestone without evidence (should block)
   - Complete milestone with evidence (should succeed)

---

## Notes

- Storage bucket must be created manually in Supabase Dashboard
- Files are stored in `evidence/{milestoneId}/{timestamp}-{random}.{ext}` format
- Public URLs are generated for file access
- All file operations are logged to milestone_logs
- RLS ensures only order owners and admins can manage attachments

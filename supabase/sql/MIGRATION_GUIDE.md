# Supabase SQL Migrations Guide

## Important: Run All Migrations in Order

The pago_en_caja functionality requires these recent migrations to be executed in your Supabase project.
Copy-paste each migration's content into the Supabase SQL Editor (https://app.supabase.com/project/YOUR_PROJECT/sql) and run them in order.

## Checklist of Migrations to Verify

- [ ] 002_functions.sql - Core functions (is_dueño, handle_new_user, marcar_pedido_entregado)
- [ ] 003_rls_policies.sql - RLS policies for existing tables
- [ ] 004_pagos_table.sql - Pagos table and RLS
- [ ] 030_add_estado_to_pagos.sql - Add estado column to pagos
- [ ] 034_add_creado_por_to_pagos.sql - Add creado_por column (audit trail)
- [ ] 035_create_pago_en_caja_table.sql - **CRITICAL** - pago_en_caja table
- [ ] 036_fix_profile_names.sql - Profile name handling

## Step-by-Step

1. Open Supabase Dashboard → SQL Editor
2. Go to each migration file above in order
3. Copy the entire content
4. Paste into SQL Editor
5. Click "Run" or press Ctrl+Enter
6. Verify no errors (should see green checkmark)
7. Move to next migration

## After Running Migrations

1. Test the app by clicking "Marcar sumado a caja" on a payment
2. Run the debug query (see debug_pago_en_caja.sql) to verify data

## If You See Errors

- "Table already exists" - This is OK, migrations use CREATE TABLE IF NOT EXISTS
- "Relation does not exist" - A prerequisite migration wasn't run
- "Permission denied" - Ensure you're logged in as project owner

## Quick Verification Query

After running all migrations, paste this in SQL Editor to verify pago_en_caja works:

```sql
-- Check pago_en_caja table exists
SELECT EXISTS (
  SELECT FROM information_schema.tables
  WHERE table_schema = 'public'
  AND table_name = 'pago_en_caja'
);

-- Should return: true
```

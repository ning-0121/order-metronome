# QIMO Preview Environment Isolation

## Current risk

The current Vercel Preview and Production deployments share the same Supabase project, auth, and storage identities. That means Preview write actions are not sandboxed and can affect live Production tables and buckets.

## Why Preview is not a sandbox

- Preview and Production environment variables resolve to the same Supabase URL.
- Preview and Production use the same Supabase anon key and service role key.
- Preview uploads and writes therefore reach the same backend as Production.
- A browser-authenticated UAT flow in Preview can mutate live business truth.

## Recommended future architecture

1. Isolated Supabase Preview project
   - separate database
   - separate auth
   - separate storage buckets

2. Environment-scoped secrets
   - distinct `NEXT_PUBLIC_SUPABASE_URL`
   - distinct anon key
   - distinct service-role key
   - separate site URLs

3. Safe seed data
   - one or more dedicated test tenants
   - deterministic test orders
   - no live customer references

4. Migration synchronization
   - automated schema sync from main
   - controlled seed refresh
   - no Production data copy beyond approved fixtures

5. Reset / cleanup process
   - explicit fixture reset job
   - storage cleanup for test buckets only
   - authentication reset for test users

## Phased implementation proposal

Phase 1
- stand up isolated Preview Supabase
- wire Preview-only env vars in Vercel

Phase 2
- seed test tenant and test orders
- validate read/write UAT against isolated data only

Phase 3
- add automatic schema sync and reset tooling
- document rollback and cleanup procedures

## Scope note

This is technical debt and release infrastructure work. It is not implemented in PR #31.

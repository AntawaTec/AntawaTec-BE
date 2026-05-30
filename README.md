# AntawaTec Backend

Supabase backend for the Antawa ecosystem (AntawaTec first; Driver, CarSOS and
others will run on this same foundation). This repo is the **source of truth**
for the database schema, RLS policies, storage, and Edge Functions. Supabase is
where it *runs*; this repo is where it *lives*.

> Architecture, conventions and domain rules: see `CLAUDE.md`.

## Repo structure

```
antawatec-backend/
├─ supabase/
│  ├─ config.toml            # Supabase CLI project config
│  ├─ migrations/            # versioned schema — the source of truth
│  │   ├─ 0001_foundation.sql
│  │   ├─ 0002_tenancy.sql
│  │   ├─ 0003_customers_vehicles.sql
│  │   ├─ 0004_inventory_catalog.sql
│  │   ├─ 0005_quotation.sql
│  │   ├─ 0006_appointments.sql
│  │   ├─ 0007_work_orders.sql
│  │   ├─ 0008_inventory_movements.sql
│  │   ├─ 0009_platform.sql
│  │   └─ 0010_storage.sql
│  └─ functions/             # Edge Functions (added later)
├─ scripts/                  # dev tooling (not run by the CLI)
│  ├─ verify_schema_rows.sql # read-only schema verification
│  ├─ seed.sql               # demo data (needs auth UIDs pasted in)
│  └─ test_isolation.sql     # RLS isolation tests
├─ CLAUDE.md                 # architecture & conventions
├─ .gitignore
└─ README.md
```

## Prerequisites

- [Supabase CLI](https://supabase.com/docs/guides/cli) (`brew install supabase/tap/supabase`)
- Docker (only for local dev via `supabase start`)
- Access to the Supabase project (project ref + database password)

## First-time setup (baseline an already-applied schema)

The schema in `migrations/` was applied to the live database by hand before this
repo existed, so we register those migrations as **already applied** instead of
re-running them.

```bash
supabase login
supabase link --project-ref <PROJECT_REF>

# confirm the local migration versions and that remote has none tracked
supabase migration list

# mark the existing migrations as already applied on the remote
supabase migration repair --status applied \
  0001 0002 0003 0004 0005 0006 0007 0008 0009 0010

# verify: every migration now shows applied on both local and remote
supabase migration list
```

## Daily workflow

**Schema change**
```bash
supabase migration new <descriptive_name>   # creates a timestamped .sql
# edit the new file (remember: enable RLS in the same migration as the table)
supabase db push                             # applies pending migrations to remote
```

**Local development (optional, mirrors prod)**
```bash
supabase start        # spins up a local Postgres + Studio (needs Docker)
supabase db reset     # rebuilds local DB from migrations/ (clean slate)
supabase stop
```

**Edge Functions**
```bash
supabase functions new <name>
supabase functions deploy <name>
supabase secrets set KEY=value     # never commit secrets
```

## Conventions

- Every schema change is a migration in `migrations/`. No manual edits in the
  dashboard SQL editor that aren't captured here.
- Every tenant-scoped table ships with its RLS policies in the **same** migration.
- Secrets (Meta/WhatsApp, Hotmart, Resend) live in Supabase secrets / env — never
  in this repo.
- See `CLAUDE.md` for the full set of architectural principles.

## Dev scripts (`scripts/`)

Run in the Supabase SQL Editor; these are tooling, not migrations:

- `verify_schema_rows.sql` — read-only PASS/FAIL audit of tables, RLS, policies,
  helper functions, the stock view, enums and constraints.
- `seed.sql` — 2 demo shops with data. Requires pasting 3 auth user UIDs.
- `test_isolation.sql` — impersonates each user to prove tenant isolation.
```
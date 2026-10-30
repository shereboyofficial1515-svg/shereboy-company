-- =========================================================
-- MIGRATION 2026-10-29 — portfolio previews, media library, services detail,
-- core values. Safe to run more than once (every statement is idempotent).
--
-- Run in Supabase: SQL Editor > New query > paste > Run.
--
-- The website keeps working BEFORE this is run: the backend detects the
-- missing columns/tables and falls back. Running it unlocks:
--   * project ordering, per-project "Live Preview" switch
--   * service benefits lists
--   * editable company core values
--   * the admin Media Library (images + PDF documents)
-- =========================================================

-- ---------- Projects ----------
alter table projects add column if not exists preview_enabled boolean not null default true;
alter table projects add column if not exists display_order int not null default 0;
create index if not exists idx_projects_display_order on projects(display_order);

-- ---------- Services ----------
-- One benefit per array item, shown as a checklist on the public site.
alter table services add column if not exists benefits text[] not null default '{}';

-- ---------- Company ----------
-- One value per line, e.g. "Reliability — we ship what we promise".
alter table company_settings add column if not exists core_values text;

-- ---------- Media library ----------
create table if not exists media_assets (
  id uuid primary key default gen_random_uuid(),
  bucket text not null,
  storage_path text not null,
  url text,                       -- public URL (null for private documents)
  file_name text,                 -- sanitized original filename, for display only
  mime_type text not null,
  size_bytes int,
  folder text,
  description text,               -- alt text / caption
  is_private boolean not null default false,
  uploaded_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (bucket, storage_path)
);
create index if not exists idx_media_created on media_assets(created_at desc);

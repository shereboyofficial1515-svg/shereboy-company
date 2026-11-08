-- =========================================================
-- Lets feedback sent from inside the products (for example JOB RUSH's
-- in-app "Help & Feedback") arrive in the same Reviews & Feedback dashboard.
--
--  * rating becomes optional: in-app feedback has no star rating, and none is
--    invented. Website feedback still requires one (checked by the server).
--  * source records where the feedback came from ('website', 'job-rush-app', ...)
--  * external_id is the item's id in the product's own database, so forwarding the
--    same item again (a retry, or the one-off backfill) never creates a duplicate.
--
-- Safe to run more than once. Changes no existing data; existing rows become
-- source 'website'. Take a backup first, then run this in the SQL Editor.
-- =========================================================
alter table feedback alter column rating drop not null;
alter table feedback add column if not exists source text not null default 'website';
alter table feedback add column if not exists external_id text;
alter table feedback add column if not exists submitted_at timestamptz;
create unique index if not exists feedback_external_key on feedback (product_id, source, external_id) where external_id is not null;
create index if not exists feedback_source_idx on feedback (source);

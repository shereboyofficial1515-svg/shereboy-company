-- =========================================================
-- Turns on Row Level Security for every table of this site.
--
-- Why: the website's server uses the service role key, which bypasses RLS, so the
-- site keeps working exactly as before. Without RLS, anyone holding the project's
-- public "anon" key could read and change these tables through Supabase's API.
-- With RLS on and no policies, the anon and authenticated roles have no access.
--
-- Safe to run more than once. It changes no data. Take a backup first anyway
-- (Supabase Dashboard > Database > Backups), then run this in the SQL Editor.
--
-- To undo for one table: alter table <name> disable row level security;
-- =========================================================
alter table if exists users enable row level security;
alter table if exists company_settings enable row level security;
alter table if exists services enable row level security;
alter table if exists projects enable row level security;
alter table if exists reviews enable row level security;
alter table if exists categories enable row level security;
alter table if exists tags enable row level security;
alter table if exists blog_posts enable row level security;
alter table if exists blog_tags enable row level security;
alter table if exists admin_sessions enable row level security;
alter table if exists activity_log enable row level security;
alter table if exists ai_chat_log enable row level security;
alter table if exists contact_messages enable row level security;
alter table if exists media_assets enable row level security;

-- Check afterwards: every row should show rowsecurity = true
-- select tablename, rowsecurity from pg_tables where schemaname = 'public' order by tablename;

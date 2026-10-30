-- =========================================================
-- OPTIONAL SEED — the service catalogue requested for the redesign.
-- Run AFTER 2026-10-29-portfolio-media-admin.sql (needs services.benefits).
--
-- Review the wording first: only keep services SHEREBOY TECH LTD actually
-- offers. Each row is inserted only if no service with the same title exists,
-- so existing services are never overwritten or duplicated. Everything here can
-- be edited or unpublished afterwards from Admin > Services.
-- =========================================================

insert into services (title, description, icon, display_order, published, benefits)
select v.title, v.description, v.icon, v.display_order, true, v.benefits
from (values
  ('Website Design and Development',
   'Professional, mobile-friendly websites that present your business clearly and turn visitors into enquiries.',
   'web', 10,
   array['Looks right on phones, tablets and desktops','Built to be found on Google','Easy for your team to update']),
  ('Web Application Development',
   'Online systems your customers or staff log in to — portals, booking tools, dashboards and more.',
   'app', 20,
   array['Replaces manual, paper-based work','Secure accounts and permissions','Works in any modern browser']),
  ('Custom Software Development',
   'Software designed around the way your business already works, instead of forcing you into an off-the-shelf tool.',
   'code', 30,
   array['Built for your exact process','You own the solution','Can grow as your business grows']),
  ('Business Management Systems',
   'Systems for managing records, inventory, customers, staff and reports in one place.',
   'system', 40,
   array['One source of truth for your data','Clear reports for decision-making','Less time on admin']),
  ('Mobile Application Development',
   'Mobile-ready applications that put your service in your customers'' pockets.',
   'mobile', 50,
   array['Reach customers on their phones','Fast, simple user experience','Connected to your existing systems']),
  ('API Development and Integration',
   'Connecting your website or software to payment providers, messaging services and other platforms.',
   'api', 60,
   array['Systems that talk to each other','Fewer manual data transfers','Secure, documented connections']),
  ('Website Maintenance and Technical Support',
   'Ongoing care for your website or application: updates, fixes, backups and help when you need it.',
   'support', 70,
   array['Problems fixed quickly','Kept secure and up to date','A dependable technical partner'])
) as v(title, description, icon, display_order, benefits)
where not exists (select 1 from services s where lower(s.title) = lower(v.title));

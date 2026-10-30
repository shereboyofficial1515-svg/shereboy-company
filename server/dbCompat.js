// server/dbCompat.js
// Columns/tables added by database/migrations/2026-10-29-portfolio-media-admin.sql.
// Until that migration is run, queries that touch them fail with PostgREST
// "unknown column" errors. These helpers detect that and retry without the new
// fields, so the site keeps working on an un-migrated database.

function isMissingColumnError(error) {
  if (!error) return false;
  return error.code === 'PGRST204' || error.code === '42703' ||
    /column .* does not exist|could not find the .* column/i.test(error.message || '');
}

function isMissingTableError(error) {
  if (!error) return false;
  return error.code === '42P01' || error.code === 'PGRST205' ||
    /relation .* does not exist|could not find the table/i.test(error.message || '');
}

// run(payload) must return a supabase query promise ({ data, error }).
async function writeWithOptionalColumns(run, payload, optionalKeys) {
  let result = await run(payload);
  if (result.error && isMissingColumnError(result.error)) {
    const stripped = { ...payload };
    optionalKeys.forEach(k => delete stripped[k]);
    result = await run(stripped);
  }
  return result;
}

// build(useOptional) must return a supabase query promise. Tried with the
// optional columns first, then without.
async function queryWithFallback(build) {
  const result = await build(true);
  if (result.error && isMissingColumnError(result.error)) return build(false);
  return result;
}

module.exports = { isMissingColumnError, isMissingTableError, writeWithOptionalColumns, queryWithFallback };

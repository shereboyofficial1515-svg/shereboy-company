// server/feedbackShared.js
// Values shared by the public feedback form and the admin module.
const CATEGORIES = {
  general: 'General Review',
  bug: 'Bug Report',
  feature: 'Feature Request',
  complaint: 'Complaint',
  suggestion: 'Suggestion',
  ux: 'User Experience',
  other: 'Other'
};
const STATUSES = ['new', 'under_review', 'in_progress', 'responded', 'resolved', 'archived'];
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MIGRATION = { error: 'Reviews & Feedback needs the latest database update. Run database/migrations/2026-11-06-reviews-feedback.sql.', code: 'MIGRATION_REQUIRED' };

const testimonialName = (name, productName) => (name && name.trim()) || `A ${productName} user`;

module.exports = { CATEGORIES, STATUSES, SLUG_RE, MIGRATION, testimonialName };

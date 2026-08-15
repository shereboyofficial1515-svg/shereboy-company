// scripts/hash-password.js
// Usage: node scripts/hash-password.js "your-chosen-password"
// Prints a bcrypt hash to paste into ADMIN_PASSWORD_HASH in your .env

const bcrypt = require('bcryptjs');

const password = process.argv[2];
if (!password) {
  console.error('Usage: node scripts/hash-password.js "your-chosen-password"');
  process.exit(1);
}

bcrypt.hash(password, 12).then((hash) => {
  console.log('\nAdd this to your .env as ADMIN_PASSWORD_HASH:\n');
  console.log(hash);
  console.log('');
});

// server/routes/auth.js
const express = require('express');
const router = express.Router();
const { login, logout, checkSession } = require('../auth');
const { loginLimiter } = require('../middleware/security');

router.post('/login', loginLimiter, login);
router.post('/logout', logout);
router.get('/session', checkSession);

module.exports = router;

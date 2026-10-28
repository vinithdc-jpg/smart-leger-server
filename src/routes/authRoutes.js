const express = require("express");

const { login, logout, getMe } = require("../controllers/authController");

const authenticate = require("../middleware/authMiddleware");
const createLoginRateLimit = require("../middleware/loginRateLimit");

const router = express.Router();

router.post("/login", createLoginRateLimit(), login);

router.post("/logout", logout);

router.get("/me", authenticate, getMe);

module.exports = router;

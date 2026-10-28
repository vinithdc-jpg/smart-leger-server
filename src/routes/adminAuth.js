const express = require("express");

const { superAdminLogin, adminGetMe, adminLogout } = require("../controllers/superAdmin");
const requireAdmin = require("../middleware/requireAdmin");
const createLoginRateLimit = require("../middleware/loginRateLimit");

const routes = express.Router();

// Public route — admin login
routes.post("/adminLogin", createLoginRateLimit(), superAdminLogin);

// Protected routes — require valid admin_token
routes.get("/adminMe", requireAdmin, adminGetMe);
routes.post("/adminLogout", requireAdmin, adminLogout);

module.exports = routes;
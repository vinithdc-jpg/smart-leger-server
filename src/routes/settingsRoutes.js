const express = require("express");
const { getGstRate, updateGstRate } = require("../controllers/settingsController");
const requireAdmin = require("../middleware/requireAdmin");

const router = express.Router();

// Get active GST rate (available for calculating transactions)
router.get("/gst", getGstRate);

// Update GST rate (Super Admin only)
router.patch("/gst", requireAdmin, updateGstRate);
router.put("/gst", requireAdmin, updateGstRate);

module.exports = router;

const express = require("express");
const router = express.Router();
const requireAdmin = require("../middleware/requireAdmin");

const {
  getDashboardStats,
  getStaffPerformance,
  getStaffOptions,
  getClubPaymentStatus,
  getTransactionRecords,
  exportTransactionRecords,
} = require("../controllers/reportController");

// Protect all report routes — admin only
router.use(requireAdmin);

router.get("/stats", getDashboardStats);
router.get("/staff-performance", getStaffPerformance);
router.get("/staff-options", getStaffOptions);
router.get("/payment-status", getClubPaymentStatus);
router.get("/transaction-records", getTransactionRecords);
router.get("/export", exportTransactionRecords);

module.exports = router;

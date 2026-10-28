const express = require("express");

const {
  getTransactionHistories,
} = require("../controllers/transactionHistoryController");

const authenticate = require("../middleware/authMiddleware");

const router = express.Router();

router.get("/", authenticate, getTransactionHistories);

module.exports = router;
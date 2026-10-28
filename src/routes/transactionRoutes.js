const express = require("express");
const authenticate = require("../middleware/authMiddleware");
const { getTransactions, getTransaction, createTransaction, updateTransaction, deleteTransaction } = require("../controllers/transactionController");

const router = express.Router();
router.get("/", authenticate, getTransactions);
router.get("/:transactionId", authenticate, getTransaction);
router.post("/", authenticate, createTransaction);
router.patch("/:transactionId", authenticate, updateTransaction);
router.delete("/:transactionId", authenticate, deleteTransaction);

module.exports = router;
const express = require("express");

const { transactionChat } = require("../controllers/transactionChatController");

const authenticate = require("../middleware/authMiddleware");

const router = express.Router();

router.post("/", authenticate, transactionChat);

module.exports = router;

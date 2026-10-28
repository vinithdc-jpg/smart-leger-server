const express = require("express");

const {
  getMembers,
  getMember,
  getMemberSummary,
  createMember,
  updateMember,
  deleteMember,
  generateTransactionSummary,
} = require("../controllers/memberController");

const authenticate = require("../middleware/authMiddleware");

const router = express.Router();

router.get("/", authenticate, getMembers);
router.get("/:memberId/summary", authenticate, getMemberSummary);
router.post("/", authenticate, createMember);
router.post("/transaction-summary", authenticate, generateTransactionSummary);
router.get("/:memberId", authenticate, getMember);
router.patch("/:memberId", authenticate, updateMember);
router.delete("/:memberId", authenticate, deleteMember);

module.exports = router;

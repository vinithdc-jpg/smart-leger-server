const express = require("express");

const {
	ingestKnowledge,
	searchKnowledge,
	updateKnowledge,
	deleteKnowledge,
} = require("../controllers/knowledgeController");

const authenticate = require("../middleware/authMiddleware");

const router = express.Router();

router.post("/ingest", authenticate, ingestKnowledge);
router.patch("/:documentId", authenticate, updateKnowledge);
router.delete("/:documentId", authenticate, deleteKnowledge);
router.get("/search", authenticate, searchKnowledge);
router.post("/search", authenticate, searchKnowledge);

module.exports = router;

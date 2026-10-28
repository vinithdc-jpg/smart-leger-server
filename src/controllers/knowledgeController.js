const pool = require("../config/db");
const mistral = require("../config/mistral");
const vectorService = require("../services/vectorService");

function getRequestedClubId(req) {
  return typeof req.query.clubId === "string" ? req.query.clubId.trim() : "";
}

function validateKnowledgeInput({ clubId, title, content }) {
  if (!clubId) return "clubId is required";
  if (!title || !String(title).trim()) return "Title is required";
  if (!content || !String(content).trim()) return "Content is required";
  return null;
}

const searchKnowledge = async (req, res) => {
  try {
    const { q: queryParam, limit: queryLimit = 5 } = req.query;
    const q = queryParam || req.body?.query;
    const limit = queryLimit || req.body?.limit || 5;

    if (!q || !String(q).trim()) {
      return res.status(400).json({
        success: false,
        message: "q is required",
      });
    }

    const results = await vectorService.searchDocuments({
      query: String(q),
      clubId: req.user.clubId,
      limit: Math.min(Math.max(Number(limit) || 5, 1), 20),
    });

    const reusableKnowledge = results.filter(
      (document) =>
        !["transaction", "payment", "member"].includes(document.source_type),
    );
    return res.status(200).json({ success: true, results: reusableKnowledge });
  } catch (error) {
    console.error("Knowledge search error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to search knowledge documents",
    });
  }
};

const ingestKnowledge = async (req, res) => {
  let stage = "request validation";

  try {
    const clubId = getRequestedClubId(req);

    const { title, category, content } = req.body || {};

    const validationError = validateKnowledgeInput({ clubId, title, content });
    if (validationError) {
      return res.status(400).json({ success: false, message: validationError });
    }

    // 1. Authentication

    const loggedInClubId = req.user.clubId;

    if (clubId !== loggedInClubId) {
      return res.status(403).json({
        success: false,
        message: "You are not authorized to access this club",
      });
    }

    const finalClubId = loggedInClubId;

    // 2. Verify club exists
    stage = "club verification";

    const clubResult = await pool.query(
      `
      SELECT club_id, title
      FROM clubs
      WHERE club_id = $1
      AND status = 'active'
      `,
      [finalClubId],
    );

    if (clubResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Club not found or inactive",
      });
    }

    // 3. Use Mistral to process knowledge
    stage = "Mistral processing";

    const mistralResponse = await mistral.chat.completions.create({
      model: process.env.MISTRAL_MODEL || "mistral-large-latest",

      messages: [
        {
          role: "system",
          content: `
You are a knowledge-document processing assistant.

Clean and organize the provided knowledge document.

Return JSON with:
{
  "cleanedContent": "...",
  "summary": "...",
  "keywords": ["keyword1", "keyword2"]
}

Do not invent information.
Only use information contained in the provided document.
            `,
        },
        {
          role: "user",
          content: `
Title: ${title}

Category: ${category || "general"}

Content:
${content}
            `,
        },
      ],

      response_format: {
        type: "json_object",
      },
    });

    // 4. Parse Mistral response

    const aiContent = mistralResponse.choices[0].message.content;

    let processedDocument;

    try {
      processedDocument = JSON.parse(aiContent);
    } catch (error) {
      return res.status(500).json({
        success: false,
        message: "Invalid response received from Mistral",
      });
    }

    if (
      !processedDocument.cleanedContent ||
      !processedDocument.summary ||
      !Array.isArray(processedDocument.keywords)
    ) {
      return res.status(500).json({
        success: false,
        message: "Mistral returned an incomplete document",
      });
    }

    // 5. Generate document ID

    const documentId = `kd_${Date.now()}`;

    // 6. Generate the embedding and store the document in PostgreSQL
    stage = "embedding and database insert";

    const document = await vectorService.addDocument({
      documentId,
      clubId: finalClubId,
      title,
      category: category || "general",
      content: processedDocument.cleanedContent,
      summary: processedDocument.summary,
      keywords: processedDocument.keywords,
    });

    // 10. Response

    return res.status(201).json({
      success: true,
      message: "Knowledge document ingested successfully",

      document: {
        id: document.id,
        clubId: document.club_id,
        title: document.title,
        category: document.category,
        content: document.content,
      },

      ai: {
        summary: processedDocument.summary,
        keywords: processedDocument.keywords,
      },

      vector: { stored: true, provider: "pgvector" },
    });
  } catch (error) {
    console.error(`Knowledge ingestion error during ${stage}:`, error);

    return res.status(500).json({
      success: false,
      message: "Failed to ingest knowledge document",
    });
  }
};

const updateKnowledge = async (req, res) => {
  try {
    const clubId = getRequestedClubId(req);
    const { title, category, content } = req.body;
    const validationError = validateKnowledgeInput({ clubId, title, content });

    if (validationError) {
      return res.status(400).json({ success: false, message: validationError });
    }

    if (clubId !== req.user.clubId) {
      return res.status(403).json({
        success: false,
        message: "You are not authorized to access this club",
      });
    }

    const document = await vectorService.updateDocument({
      documentId: req.params.documentId,
      clubId,
      title: String(title).trim(),
      category,
      content: String(content).trim(),
    });

    if (!document) {
      return res.status(404).json({
        success: false,
        message: "Knowledge document not found",
      });
    }

    return res.status(200).json({ success: true, document });
  } catch (error) {
    console.error("Knowledge update error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to update knowledge document",
    });
  }
};

const deleteKnowledge = async (req, res) => {
  try {
    const clubId = getRequestedClubId(req);
    if (!clubId) {
      return res
        .status(400)
        .json({ success: false, message: "clubId is required" });
    }

    if (clubId !== req.user.clubId) {
      return res.status(403).json({
        success: false,
        message: "You are not authorized to access this club",
      });
    }

    const document = await vectorService.deleteDocument({
      documentId: req.params.documentId,
      clubId,
    });

    if (!document) {
      return res.status(404).json({
        success: false,
        message: "Knowledge document not found",
      });
    }

    return res.status(200).json({
      success: true,
      message: "Knowledge document deleted successfully",
    });
  } catch (error) {
    console.error("Knowledge delete error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to delete knowledge document",
    });
  }
};

module.exports = {
  ingestKnowledge,
  searchKnowledge,
  updateKnowledge,
  deleteKnowledge,
};

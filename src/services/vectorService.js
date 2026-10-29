const pool = require("../config/db");
const {
  generateEmbedding,
  EMBEDDING_DIMENSION,
} = require("./embeddingService");

function toPgVector(embedding) {
  if (!Array.isArray(embedding) || embedding.length !== EMBEDDING_DIMENSION) {
    throw new Error(
      `Invalid embedding dimension: expected ${EMBEDDING_DIMENSION}, received ${embedding?.length ?? 0}`,
    );
  }

  if (!embedding.every((value) => Number.isFinite(value))) {
    throw new Error("Invalid embedding: all values must be finite numbers");
  }

  return `[${embedding.join(",")}]`;
}

function validateClubId(clubId) {
  if (!clubId || !String(clubId).trim()) {
    throw new Error("Invalid clubId");
  }
}

async function addDocument({
  documentId,
  clubId,
  title,
  content,
  category,
}) {
  return upsertSourceDocument({
    documentId,
    clubId,
    sourceType: ["policy", "faq", "procedure"].includes(category)
      ? category
      : "general",
    sourceId: documentId,
    title,
    content,
    category: category || "general",
    source: "manual",
    approved: true,
  });
}

async function matchDocuments({
  queryEmbedding,
  clubId,
  limit = 5,
  threshold = 0,
}) {
  validateClubId(clubId);
  const vector = toPgVector(queryEmbedding);
  const boundedLimit = Math.min(Math.max(Number(limit) || 5, 1), 20);
  const boundedThreshold = Math.min(Math.max(Number(threshold) || 0, 0), 1);

  try {
    const result = await pool.query(
      `
      SELECT * FROM public.match_documents($1::vector, $2::real, $3::integer, $4::text)
      `,
      [vector, boundedThreshold, boundedLimit, String(clubId)],
    );

    const documents = result.rows.map((row) => ({
      ...row,
      documentId: row.id,
      clubId: row.club_id,
      score: Number(row.similarity),
      distance: 1 - Number(row.similarity),
    }));
    return filterToCurrentClubSources(documents, clubId);
  } catch (error) {
    console.error("Knowledge vector search failed:", error);
    throw error;
  }
}

async function filterToCurrentClubSources(documents, clubId) {
  const sourceGroups = [
    { types: ["transaction", "payment"], table: "transaction_history" },
    { types: ["member"], table: "members" },
    { types: ["ai_chat"], table: "ai_chat_logs" },
  ];
  const validSources = new Map();

  for (const group of sourceGroups) {
    const sourceIds = documents
      .filter((document) => group.types.includes(document.source_type))
      .map((document) => document.source_id);
    if (!sourceIds.length) continue;

    const result = await pool.query(
      `SELECT id::text AS id FROM ${group.table} WHERE id::text = ANY($1::text[]) AND club_id::text = $2`,
      [sourceIds, String(clubId)],
    );
    validSources.set(group.types[0], new Set(result.rows.map((row) => row.id)));
  }

  return documents.filter((document) => {
    const group = sourceGroups.find((candidate) => candidate.types.includes(document.source_type));
    if (!group) return true;
    return validSources.get(group.types[0])?.has(String(document.source_id)) || false;
  });
}

async function searchDocuments({ query, clubId, limit = 5, threshold = 0 }) {
  validateClubId(clubId);
  if (!query || !String(query).trim()) return [];

  const queryEmbedding = await generateEmbedding(String(query));
  return matchDocuments({ queryEmbedding, clubId, limit, threshold });
}

async function assertSourceBelongsToClub({ sourceType, sourceId, clubId }) {
  if (["transaction", "payment"].includes(sourceType)) {
    const result = await pool.query(
      `SELECT id FROM transaction_history WHERE id::text = $1 AND club_id::text = $2 LIMIT 1`,
      [String(sourceId), String(clubId)],
    );
    if (!result.rows.length) throw new Error("Source transaction not found in club");
  } else if (sourceType === "member") {
    const result = await pool.query(
      `SELECT id FROM members WHERE id::text = $1 AND club_id::text = $2 LIMIT 1`,
      [String(sourceId), String(clubId)],
    );
    if (!result.rows.length) throw new Error("Source member not found in club");
  } else if (sourceType === "ai_chat") {
    const result = await pool.query(
      `SELECT id FROM ai_chat_logs WHERE id::text = $1 AND club_id::text = $2 LIMIT 1`,
      [String(sourceId), String(clubId)],
    );
    if (!result.rows.length) throw new Error("Source chat log not found in club");
  } else if (!["policy", "faq", "procedure", "general"].includes(sourceType)) {
    throw new Error("Unsupported knowledge source type");
  }
}

async function upsertSourceDocument({
  documentId,
  clubId,
  sourceType,
  sourceId,
  title,
  content,
  category = "general",
  metadata = {},
  source = "ingestion",
  approved = true,
}) {
  validateClubId(clubId);
  if (!sourceType || !sourceId || !title?.trim() || !content?.trim()) {
    throw new Error("sourceType, sourceId, title and content are required");
  }
  await assertSourceBelongsToClub({ sourceType, sourceId, clubId });

  const embedding = await generateEmbedding(
    `Title: ${title}\nCategory: ${category}\nSource: ${sourceType}\n\n${content}`,
  );
  const vector = toPgVector(embedding);
  const id = documentId || `kd_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const result = await pool.query(
    `
    INSERT INTO knowledge_docs (
      id, club_id, source_type, source_id, title, category, content,
      metadata, embedding, source, approved
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::vector, $10, $11)
    ON CONFLICT (club_id, source_type, source_id) DO UPDATE SET
      title = EXCLUDED.title,
      category = EXCLUDED.category,
      content = EXCLUDED.content,
      metadata = EXCLUDED.metadata,
      embedding = EXCLUDED.embedding,
      source = EXCLUDED.source,
      approved = EXCLUDED.approved,
      updated_at = CURRENT_TIMESTAMP
    RETURNING *
    `,
    [id, clubId, sourceType, String(sourceId), title.trim(), category, content.trim(), JSON.stringify(metadata), vector, source, approved],
  );
  return result.rows[0];
}

async function indexTransaction({ transactionId, clubId }) {
  validateClubId(clubId);
  const result = await pool.query(
    `
    SELECT th.id, th.slip_no, (th.amount_taken_date AT TIME ZONE 'Asia/Kolkata')::date AS date,
      th.payment_status, th.payment_method, th.types,
      th.amount_excluding_gst, th.total_gst_amount, th.total_amount_with_gst,
      th.received_amount, th.balance_amount, th.pending_amount,
      m.id AS member_id, m.member_id AS member_number,
      m.first_name || ' ' || m.last_name AS member_name
    FROM transaction_history th
    INNER JOIN members m ON m.id = th.member_id AND m.club_id = th.club_id
    WHERE th.id::text = $1 AND th.club_id::text = $2
    `,
    [String(transactionId), String(clubId)],
  );
  const transaction = result.rows[0];
  if (!transaction) throw new Error("Source transaction not found in club");

  const content = [
    `Transaction ID: ${transaction.id}`,
    `Member: ${transaction.member_number} (${transaction.member_name})`,
    `Type: ${transaction.types}`,
    `Payment Status: ${transaction.payment_status}`,
    `Payment Method: ${transaction.payment_method}`,
    `Total Amount: INR ${transaction.total_amount_with_gst}`,
    `Received Amount: INR ${transaction.received_amount}`,
    `Balance Amount: INR ${transaction.balance_amount}`,
    `Date: ${transaction.date}`,
  ].join("\n");

  return upsertSourceDocument({
    clubId,
    sourceType: "transaction",
    sourceId: transaction.id,
    title: `Transaction ${transaction.id}`,
    content,
    category: "transaction",
    metadata: { memberId: transaction.member_id },
    source: "postgres_transaction",
    approved: true,
  });
}

async function saveKnowledgeCandidate({
  clubId,
  title,
  category,
  content,
  sourceId,
}) {
  validateClubId(clubId);

  if (!title?.trim() || !content?.trim()) {
    return { created: false, reason: "invalid_candidate" };
  }
  if (!sourceId) return { created: false, reason: "missing_source_id" };
  await assertSourceBelongsToClub({
    sourceType: "ai_chat",
    sourceId,
    clubId,
  });

  const embedding = await generateEmbedding(
    `Title: ${title}\nCategory: ${category || "general"}\n\n${content}`,
  );
  const vector = toPgVector(embedding);

  const duplicateResult = await pool.query(
    `
    SELECT id
    FROM knowledge_docs
    WHERE club_id = $2
      AND embedding IS NOT NULL
      AND 1 - (embedding <=> $1::vector) >= 0.9
    ORDER BY embedding <=> $1::vector
    LIMIT 1
    `,
    [vector, clubId],
  );

  if (duplicateResult.rows.length > 0) {
    return {
      created: false,
      reason: "similar_knowledge_exists",
      documentId: duplicateResult.rows[0].id,
    };
  }

  const documentId = `kd_ai_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const result = await pool.query(
    `
    INSERT INTO knowledge_docs (
      id, club_id, source_type, source_id, title, category, content,
      metadata, embedding, source, approved
    )
    VALUES ($1, $2, 'ai_chat', $3, $4, $5, $6, '{}'::jsonb, $7::vector, 'ai_generated', true)
    ON CONFLICT (club_id, source_type, source_id) DO UPDATE SET
      title = EXCLUDED.title, category = EXCLUDED.category,
      content = EXCLUDED.content, embedding = EXCLUDED.embedding,
      updated_at = CURRENT_TIMESTAMP
    RETURNING id
    `,
    [documentId, clubId, String(sourceId || documentId), title.trim(), category || "general", content.trim(), vector],
  );

  return {
    created: true,
    documentId: result.rows[0].id,
  };
}

async function updateDocument({
  documentId,
  clubId,
  title,
  content,
  category,
}) {
  validateClubId(clubId);

  const existingResult = await pool.query(
    `SELECT title, content, category FROM knowledge_docs WHERE id = $1 AND club_id = $2`,
    [documentId, clubId],
  );

  if (existingResult.rows.length === 0) {
    return null;
  }

  const current = existingResult.rows[0];
  const contentChanged =
    current.content !== content ||
    current.title !== title ||
    current.category !== (category || "general");
  let vector = null;

  if (contentChanged) {
    let embedding;
    try {
      embedding = await generateEmbedding(
        `Title: ${title}\nCategory: ${category || "general"}\n\n${content}`,
      );
    } catch (error) {
      throw new Error(`Embedding generation failed: ${error.message}`, {
        cause: error,
      });
    }
    vector = toPgVector(embedding);
  }

  const result = await pool.query(
    `
    UPDATE knowledge_docs
    SET
      title = $1,
      category = $2,
      content = $3,
      source = 'manual',
      approved = true,
      embedding = COALESCE($4::vector, embedding),
      updated_at = CURRENT_TIMESTAMP
    WHERE id = $5 AND club_id = $6
    RETURNING *
    `,
    [title, category || "general", content, vector, documentId, clubId],
  );

  return result.rows[0] || null;
}

async function deleteDocument({ documentId, clubId }) {
  validateClubId(clubId);

  const result = await pool.query(
    `DELETE FROM knowledge_docs WHERE id = $1 AND club_id = $2 RETURNING id`,
    [documentId, clubId],
  );

  return result.rows[0] || null;
}

module.exports = {
  addDocument,
  searchDocuments,
  matchDocuments,
  upsertSourceDocument,
  indexTransaction,
  updateDocument,
  deleteDocument,
  saveKnowledgeCandidate,
};
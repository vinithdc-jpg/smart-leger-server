const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const pool = require("../src/config/db");
const vectorService = require("../src/services/vectorService");
const { isSafeKnowledgeCandidate } = require("../src/controllers/transactionChatController");

const migrationPath = path.join(__dirname, "..", "sql", "knowledge_docs_pgvector.sql");

test("vector search passes the authenticated club scope to the database RPC", async () => {
  const originalQuery = pool.query;
  let queryText;
  let values;
  pool.query = async (sql, params) => {
    queryText = sql;
    values = params;
    return { rows: [] };
  };

  try {
    await vectorService.matchDocuments({
      queryEmbedding: Array(384).fill(0),
      clubId: "club_A",
      limit: 5,
      threshold: 0.65,
    });

    assert.match(queryText, /match_documents\(/i);
    assert.deepEqual(values.slice(1), [0.65, 5, "club_A"]);
  } finally {
    pool.query = originalQuery;
  }
});

test("database RPC filters club ownership before ranking, with no null-club fallback", () => {
  const migration = fs.readFileSync(migrationPath, "utf8");

  assert.match(migration, /WHERE d\.club_id::text = filter_club_id/i);
  assert.doesNotMatch(migration, /OR\s+d\.club_id\s+IS\s+NULL/i);
});

test("knowledge classifier accepts boolean and string true but keeps false and financial facts rejected", () => {
  assert.equal(
    isSafeKnowledgeCandidate({ reusable: " TRUE ", title: "AMC policy", content: "Renew annually." }).safe,
    true,
  );
  assert.equal(
    isSafeKnowledgeCandidate({ reusable: false, title: "Balance", content: "No reusable policy." }).reason,
    "not_reusable",
  );
  assert.equal(
    isSafeKnowledgeCandidate({ reusable: true, title: "Balance", content: "Amount INR 5000" }).reason,
    "private_or_transaction_data",
  );
});

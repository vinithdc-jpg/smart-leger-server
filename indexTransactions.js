const pool = require("./src/config/db");
const vectorService = require("./src/services/vectorService");

async function indexExistingTransactions() {
  let indexed = 0;
  let failed = 0;
  const clubs = await pool.query(
    `SELECT DISTINCT club_id::text AS club_id
     FROM transaction_history
     WHERE club_id IS NOT NULL
     ORDER BY club_id::text`,
  );

  for (const { club_id: clubId } of clubs.rows) {
    let lastId = "";

    while (true) {
      const transactions = await pool.query(
        `SELECT id::text AS id
         FROM transaction_history
         WHERE club_id::text = $1 AND id::text > $2
         ORDER BY id::text
         LIMIT 100`,
        [clubId, lastId],
      );
      if (!transactions.rows.length) break;

      for (const transaction of transactions.rows) {
        try {
          await vectorService.indexTransaction({
            transactionId: transaction.id,
            clubId,
          });
          indexed += 1;
        } catch (error) {
          failed += 1;
          console.error(`Transaction indexing failed (${transaction.id}): ${error.message}`);
        }
        lastId = transaction.id;
      }
    }
  }

  console.log(`Transaction indexing complete: ${indexed} indexed, ${failed} failed`);
}

indexExistingTransactions()
  .catch((error) => {
    console.error("Transaction indexing failed:", error);
    process.exitCode = 1;
  })
  .finally(() => pool.end());

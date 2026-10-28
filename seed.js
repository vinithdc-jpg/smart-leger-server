require("dotenv").config();

const pool = require("./src/config/db");
const { generateEmbedding } = require("./src/services/embeddingService");

const knowledgeData = [
  {
    id: "knowledge_001",
    club_id: "club_001",
    title: "Annual Membership Payment Policy",
    category: "payment",
    content:
      "All club members must complete their annual membership payment before the membership renewal due date. Members with unpaid annual fees may have their membership temporarily suspended until the outstanding amount is cleared.",
  },

  {
    id: "knowledge_002",
    club_id: "club_001",
    title: "Membership Renewal",
    category: "membership",
    content:
      "Membership renewal is required every year. Members should renew their membership before the expiry date to avoid interruption of club services and benefits. Renewal status can be checked from the member account.",
  },

  {
    id: "knowledge_003",
    club_id: "club_001",
    title: "Late Payment Policy",
    category: "payment",
    content:
      "Members who fail to pay their outstanding balance by the payment due date may receive a payment reminder. Continued non-payment can result in temporary suspension of membership benefits.",
  },

  {
    id: "knowledge_004",
    club_id: "club_001",
    title: "Payment Methods",
    category: "payment",
    content:
      "The club accepts payments through cash, bank transfer, UPI, debit card, and credit card. Members should keep their payment receipt or transaction reference number for future verification.",
  },

  {
    id: "knowledge_005",
    club_id: "club_001",
    title: "Refund Policy",
    category: "refund",
    content:
      "Refund requests must be submitted to the club administration with the relevant payment receipt and transaction details. Refund eligibility depends on the type of payment and the club's applicable refund rules.",
  },

  {
    id: "knowledge_006",
    club_id: "club_001",
    title: "AMC Payment Policy",
    category: "amc",
    content:
      "Annual Maintenance Contract payments must be completed according to the agreed payment schedule. An AMC transaction is recorded separately from normal membership transactions for accounting and reporting purposes.",
  },

  {
    id: "knowledge_007",
    club_id: "club_001",
    title: "Outstanding Balance",
    category: "transactions",
    content:
      "A member's outstanding balance represents the amount that has not yet been received by the club. Staff should verify the transaction history before confirming the current pending amount.",
  },

  {
    id: "knowledge_008",
    club_id: "club_001",
    title: "Transaction Verification",
    category: "transactions",
    content:
      "Before confirming a payment, staff should verify the transaction date, invoice number, receipt number, payment method, received amount, and remaining balance. Incorrect transactions should be reported to the club administrator.",
  },

  {
    id: "knowledge_009",
    club_id: "club_001",
    title: "Member Account Update",
    category: "members",
    content:
      "Member contact information such as phone number, email address, and other account details should be kept up to date. Staff members should verify the member identity before changing account information.",
  },

  {
    id: "knowledge_010",
    club_id: "club_001",
    title: "Staff Responsibilities",
    category: "staff",
    content:
      "Club staff members are responsible for maintaining accurate member information, recording payments, checking outstanding balances, verifying transactions, and assisting members with account-related questions.",
  },

  {
    id: "knowledge_011",
    club_id: "club_001",
    title: "Payment Receipt",
    category: "payment",
    content:
      "After receiving a payment, staff should ensure that the transaction is recorded correctly and that the member receives the appropriate payment receipt. The receipt should contain relevant transaction information.",
  },

  {
    id: "knowledge_012",
    club_id: "club_001",
    title: "Inactive Membership",
    category: "membership",
    content:
      "A member may be marked inactive when their membership has expired, been cancelled, or has been suspended according to club rules. Inactive members should not be treated as active members until their status is updated.",
  },
];

async function seedKnowledge() {
  try {
    console.log("Starting knowledge base seeding...");

    for (const document of knowledgeData) {
      console.log(`Generating embedding: ${document.title}`);

      const embedding = await generateEmbedding(document.content);

      if (!embedding || embedding.length === 0) {
        throw new Error(`Failed to generate embedding for ${document.id}`);
      }

      console.log(`Embedding generated: ${embedding.length} dimensions`);

      await pool.query(
        `
        INSERT INTO knowledge_docs (
          id,
          club_id,
          source_type,
          source_id,
          title,
          category,
          content,
          metadata,
          embedding,
          source,
          approved
        )
        VALUES (
          $1,
          $2,
          CASE WHEN LOWER($4) IN ('policy', 'faq', 'procedure') THEN LOWER($4) ELSE 'general' END,
          $1,
          $3,
          $4,
          $5,
          '{}'::jsonb,
          $6::vector,
          'manual',
          true
        )
        ON CONFLICT (id)
        DO UPDATE SET
          title = EXCLUDED.title,
          source_type = EXCLUDED.source_type,
          source_id = EXCLUDED.source_id,
          category = EXCLUDED.category,
          content = EXCLUDED.content,
          metadata = EXCLUDED.metadata,
          embedding = EXCLUDED.embedding,
          updated_at = CURRENT_TIMESTAMP
        `,
        [
          document.id,
          document.club_id,
          document.title,
          document.category,
          document.content,
          JSON.stringify(embedding),
        ],
      );

      console.log(`✓ Added: ${document.title}`);
    }

    console.log("\nKnowledge base seeded successfully.");

    const result = await pool.query(`
      SELECT
        id,
        club_id,
        title,
        category,
        vector_dims(embedding) AS dimensions
      FROM knowledge_docs
      ORDER BY created_at DESC
    `);

    console.table(result.rows);
  } catch (error) {
    console.error("Knowledge seed error:", error);
  } finally {
    await pool.end();
  }
}

seedKnowledge();

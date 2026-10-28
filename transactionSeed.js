require("dotenv").config();

const pool = require('./src/config/db');

// --------------------------------------------------
// Configuration
// --------------------------------------------------

const CLUB_ID = "club_001";
const STAFF_ID = "staff_001";

const TOTAL_TRANSACTIONS = 70;

const paymentMethods = ["cash", "upi", "bank_transfer", "card"];

const amcTransactionTypes = ["renewal", "new", "upgrade"];

// --------------------------------------------------
// Helpers
// --------------------------------------------------

function randomItem(items) {
  return items[Math.floor(Math.random() * items.length)];
}

function roundMoney(value) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

// --------------------------------------------------
// Create transaction
// --------------------------------------------------

function createTransaction(index, members) {
  // Distribute transactions across all members
  const memberIndex = (index - 1) % members.length;

  const member = members[memberIndex];

  // ------------------------------------------------
  // Date
  // January - June 2026
  // 12 transactions per month initially
  // ------------------------------------------------

  const month = Math.floor((index - 1) / 12);

  const day = ((index - 1) % 25) + 1;

  const date = new Date(Date.UTC(2026, month, day));

  // ------------------------------------------------
  // IDs
  // ------------------------------------------------

  const id = `txn_${String(index).padStart(3, "0")}`;

  const businessTransactionId = `TXN-${String(index).padStart(3, "0")}`;

  const slipNo = `SL-${String(index).padStart(3, "0")}`;

  const invoiceNo = `INV-${1000 + index}`;

  // ------------------------------------------------
  // Transaction amount
  // ------------------------------------------------

  const amount = 2000 + ((index * 1500) % 18000);

  // ------------------------------------------------
  // Payment status
  // ------------------------------------------------

  let paymentStatus;

  if (index % 5 === 0) {
    paymentStatus = "pending";
  } else if (index % 3 === 0) {
    paymentStatus = "partial";
  } else {
    paymentStatus = "completed";
  }

  // ------------------------------------------------
  // Transaction type
  // ------------------------------------------------

  const isAmc = index % 2 === 0;

  const types = isAmc ? "amc" : randomItem(["membership", "service"]);

  // ------------------------------------------------
  // Payment calculation
  // ------------------------------------------------

  let receivedAmount;
  let balanceAmount;

  if (paymentStatus === "partial") {
    receivedAmount = roundMoney(amount * 0.4);

    balanceAmount = roundMoney(amount - receivedAmount);
  } else if (paymentStatus === "pending") {
    receivedAmount = 0;
    balanceAmount = amount;
  } else {
    receivedAmount = amount;
    balanceAmount = 0;
  }

  // ------------------------------------------------
  // GST calculation
  // ------------------------------------------------

  const amountExcludingGst = roundMoney(receivedAmount / 1.18);

  const totalGstAmount = roundMoney(receivedAmount - amountExcludingGst);

  const cgstAmount = roundMoney(totalGstAmount / 2);

  const sgstAmount = roundMoney(totalGstAmount - cgstAmount);

  // ------------------------------------------------
  // Status
  // ------------------------------------------------

  const status = paymentStatus === "pending" ? "pending" : "completed";

  // ------------------------------------------------
  // Transaction object
  // ------------------------------------------------

  return {
    id,

    created_date: date,

    updated_date: date,

    amount_taken_date: date,

    slip_no: slipNo,

    invoice_no: invoiceNo,

    payment_status: paymentStatus,

    debit_amount: 0,

    received_amount: receivedAmount,

    balance_amount: balanceAmount,

    payment_method: randomItem(paymentMethods),

    types,

    status,

    pending_amount: balanceAmount,

    is_amc_transaction_debit: false,

    amc_transaction_type: isAmc ? randomItem(amcTransactionTypes) : null,

    amount_excluding_gst: amountExcludingGst,

    cgst_amount: cgstAmount,

    sgst_amount: sgstAmount,

    total_gst_amount: totalGstAmount,

    total_amount_with_gst: receivedAmount,

    invoice_prefix: "INV",

    transaction_id: businessTransactionId,

    remarks:
      paymentStatus === "partial"
        ? "Partial payment"
        : paymentStatus === "pending"
          ? "Payment pending"
          : "Payment completed",

    member_id: member.id,

    club_id: CLUB_ID,

    staff_id: STAFF_ID,
  };
}

// --------------------------------------------------
// Main seed function
// --------------------------------------------------

async function seedTransactions() {
  const client = await pool.connect();

  try {
    console.log("Starting transaction history seed...");

    await client.query("BEGIN");

    // ------------------------------------------------
    // 1. Clear existing transaction history
    // ------------------------------------------------

    console.log("Clearing existing transaction history...");

    await client.query(`TRUNCATE TABLE transaction_history`);

    console.log("Existing transaction history cleared.");

    // ------------------------------------------------
    // 2. Check club
    // ------------------------------------------------

    const clubResult = await client.query(
      `
      SELECT club_id
      FROM clubs
      WHERE club_id = $1
      `,
      [CLUB_ID],
    );

    if (clubResult.rows.length === 0) {
      throw new Error(`Club '${CLUB_ID}' does not exist`);
    }

    // ------------------------------------------------
    // 3. Check staff
    // ------------------------------------------------

    const staffResult = await client.query(
      `
      SELECT id
      FROM staff
      WHERE id = $1
      AND club_id = $2
      `,
      [STAFF_ID, CLUB_ID],
    );

    if (staffResult.rows.length === 0) {
      throw new Error(`Staff '${STAFF_ID}' does not exist for ${CLUB_ID}`);
    }

    // ------------------------------------------------
    // 4. Get members
    // ------------------------------------------------

    const memberResult = await client.query(
      `
      SELECT
        id,
        member_id,
        first_name,
        last_name
      FROM members
      WHERE club_id = $1
      ORDER BY member_id
      `,
      [CLUB_ID],
    );

    const members = memberResult.rows;

    if (members.length === 0) {
      throw new Error(`No members found for ${CLUB_ID}`);
    }

    console.log(`Found ${members.length} members.`);

    // ------------------------------------------------
    // 5. Generate transactions
    // ------------------------------------------------

    const transactions = [];

    for (let index = 1; index <= TOTAL_TRANSACTIONS; index++) {
      const transaction = createTransaction(index, members);

      transactions.push(transaction);
    }

    // ------------------------------------------------
    // 6. Insert transactions
    // ------------------------------------------------

    const insertQuery = `
      INSERT INTO transaction_history (
        id,
        created_date,
        updated_date,
        amount_taken_date,
        slip_no,
        invoice_no,
        payment_status,
        debit_amount,
        received_amount,
        balance_amount,
        payment_method,
        types,
        status,
        pending_amount,
        is_amc_transaction_debit,
        amc_transaction_type,
        amount_excluding_gst,
        cgst_amount,
        sgst_amount,
        total_gst_amount,
        total_amount_with_gst,
        invoice_prefix,
        transaction_id,
        remarks,
        member_id,
        club_id,
        staff_id
      )
      VALUES (
        $1,
        $2,
        $3,
        $4,
        $5,
        $6,
        $7,
        $8,
        $9,
        $10,
        $11,
        $12,
        $13,
        $14,
        $15,
        $16,
        $17,
        $18,
        $19,
        $20,
        $21,
        $22,
        $23,
        $24,
        $25,
        $26,
        $27
      )
    `;

    for (const transaction of transactions) {
      await client.query(insertQuery, [
        transaction.id,
        transaction.created_date,
        transaction.updated_date,
        transaction.amount_taken_date,
        transaction.slip_no,
        transaction.invoice_no,
        transaction.payment_status,
        transaction.debit_amount,
        transaction.received_amount,
        transaction.balance_amount,
        transaction.payment_method,
        transaction.types,
        transaction.status,
        transaction.pending_amount,
        transaction.is_amc_transaction_debit,
        transaction.amc_transaction_type,
        transaction.amount_excluding_gst,
        transaction.cgst_amount,
        transaction.sgst_amount,
        transaction.total_gst_amount,
        transaction.total_amount_with_gst,
        transaction.invoice_prefix,
        transaction.transaction_id,
        transaction.remarks,
        transaction.member_id,
        transaction.club_id,
        transaction.staff_id,
      ]);
    }

    // ------------------------------------------------
    // 7. Commit
    // ------------------------------------------------

    await client.query("COMMIT");

    console.log(`Successfully inserted ${transactions.length} transactions.`);

    // ------------------------------------------------
    // 8. Print summary
    // ------------------------------------------------

    const summaryResult = await client.query(`
        SELECT
          COUNT(*) AS total_transactions,
          COALESCE(
            SUM(received_amount),
            0
          ) AS total_received,
          COALESCE(
            SUM(balance_amount),
            0
          ) AS total_balance
        FROM transaction_history
        WHERE club_id = '${CLUB_ID}'
      `);

    console.log("Transaction summary:");

    console.table(summaryResult.rows);

    console.log("Transaction seed completed successfully.");
  } catch (error) {
    await client.query("ROLLBACK");

    console.error("Transaction seed failed:");

    console.error(error);

    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

// --------------------------------------------------
// Run
// --------------------------------------------------

seedTransactions();

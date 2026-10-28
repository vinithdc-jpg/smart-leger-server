const pool = require("../config/db");
const { getCurrentGstRate } = require("./settingsController");
const vectorService = require("../services/vectorService");

const transactionColumns = `
  id, created_date, updated_date, amount_taken_date, slip_no, invoice_no,
  payment_status, debit_amount, received_amount, balance_amount,
  payment_method, types, status, pending_amount, is_amc_transaction_debit,
  amc_transaction_type, amount_excluding_gst, cgst_amount, sgst_amount,
  total_gst_amount, total_amount_with_gst, invoice_prefix, transaction_id,
  remarks, member_id, club_id, staff_id
`;
const statuses = new Set(["pending", "partial", "completed"]);

class RequestError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

async function withTransaction(work) {
  const client = await pool.connect();
  let began = false;
  try {
    await client.query("BEGIN");
    began = true;
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    if (began) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        console.error("Transaction rollback error:", rollbackError);
      }
    }
    throw error;
  } finally {
    client.release();
  }
}

function validateFinancialAmount(value, field, { allowZero = false } = {}) {
  if (
    (typeof value !== "number" && typeof value !== "string") ||
    value === undefined ||
    value === null ||
    (typeof value === "string" && value.trim() === "") ||
    !Number.isFinite(Number(value))
  ) {
    throw new RequestError(`${field} must be a valid number`);
  }
  const amount = Number(value);
  if (allowZero ? amount < 0 : amount <= 0) {
    throw new RequestError(
      allowZero
        ? `${field} cannot be negative`
        : `${field} must be greater than 0`,
    );
  }
  return amount;
}

function normalizeTransactionDate(value) {
  if (typeof value !== "string") {
    return null;
  }

  const match =
    /^(\d{4}-\d{2}-\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:\d{2})?)?$/.exec(
      value,
    );
  if (!match) {
    return null;
  }

  const [, date, hour, minute, second = "0", , timezone] = match;
  const [yearValue, monthValue, dayValue] = date.split("-").map(Number);
  const calendarDate = new Date(0);
  calendarDate.setUTCHours(0, 0, 0, 0);
  calendarDate.setUTCFullYear(yearValue, monthValue - 1, dayValue);
  if (
    calendarDate.getUTCFullYear() !== yearValue ||
    calendarDate.getUTCMonth() !== monthValue - 1 ||
    calendarDate.getUTCDate() !== dayValue
  ) {
    return null;
  }

  if (hour === undefined) {
    return `${date}T00:00:00+05:30`;
  }

  if (
    Number(hour) > 23 ||
    Number(minute) > 59 ||
    Number(second) > 59
  ) {
    return null;
  }

  const offset = timezone || "+05:30";
  if (offset !== "Z") {
    const offsetMatch = /^[+-](\d{2}):(\d{2})$/.exec(offset);
    if (
      !offsetMatch ||
      Number(offsetMatch[1]) > 14 ||
      Number(offsetMatch[2]) > 59 ||
      (Number(offsetMatch[1]) === 14 && Number(offsetMatch[2]) !== 0)
    ) {
      return null;
    }
  }

  const timestamp = new Date(`${value}${timezone ? "" : "+05:30"}`);
  return Number.isNaN(timestamp.getTime()) ? null : timestamp.toISOString();
}

function buildFilters(req) {
  const isSuperAdmin = req.user?.role === "super_admin";
  const query = req.query;
  const targetClubId = query.clubId || query.club_id;
  const values = [];
  const filters = [];

  if (!isSuperAdmin) {
    values.push(req.user.clubId);
    filters.push(`club_id = $${values.length}`);
  } else if (targetClubId && targetClubId !== "all") {
    values.push(targetClubId);
    filters.push(`club_id = $${values.length}`);
  }
  if (query.memberId) {
    values.push(query.memberId);
    filters.push(`member_id = $${values.length}`);
  }
  if (query.paymentStatus) {
    if (!statuses.has(String(query.paymentStatus).toLowerCase()))
      throw new RequestError("Invalid paymentStatus");
    values.push(String(query.paymentStatus).toLowerCase());
    filters.push(`payment_status = $${values.length}`);
  }
  if (query.transactionType) {
    values.push(query.transactionType);
    filters.push(`types = $${values.length}`);
  }
  if (query.fromDate) {
    if (Number.isNaN(Date.parse(query.fromDate)))
      throw new RequestError("Invalid fromDate");
    values.push(query.fromDate);
    const dateFilter = /^\d{4}-\d{2}-\d{2}$/.test(query.fromDate)
      ? `($${values.length}::date::timestamp AT TIME ZONE 'Asia/Kolkata')`
      : `$${values.length}`;
    filters.push(`amount_taken_date >= ${dateFilter}`);
  }
  if (query.toDate) {
    if (Number.isNaN(Date.parse(query.toDate)))
      throw new RequestError("Invalid toDate");
    values.push(query.toDate);
    const dateFilter = /^\d{4}-\d{2}-\d{2}$/.test(query.toDate)
      ? `(($${values.length}::date + INTERVAL '1 day')::timestamp AT TIME ZONE 'Asia/Kolkata')`
      : `$${values.length}`;
    filters.push(
      /^\d{4}-\d{2}-\d{2}$/.test(query.toDate)
        ? `amount_taken_date < ${dateFilter}`
        : `amount_taken_date <= ${dateFilter}`,
    );
  }
  if (String(query.search || "").trim()) {
    values.push(`%${String(query.search).trim()}%`);
    const searchParam = `$${values.length}`;
    filters.push(`(
      club_id ILIKE ${searchParam}
      OR payment_status ILIKE ${searchParam}
      OR payment_method ILIKE ${searchParam}
      OR TO_CHAR(amount_taken_date AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD HH24:MI:SS') ILIKE ${searchParam}
      OR EXISTS (
        SELECT 1 FROM clubs c
        WHERE c.club_id = transaction_history.club_id AND c.title ILIKE ${searchParam}
      )
    )`);
  }
  return { values, where: filters.length ? filters.join(" AND ") : "1=1" };
}

const getTransactions = async (req, res) => {
  try {
    const { values, where } = buildFilters(req);
    const page = Math.max(Number.parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(
      Math.max(Number.parseInt(req.query.limit, 10) || 10, 1),
      100,
    );
    const offset = (page - 1) * limit;

    const countResult = await pool.query(
      `SELECT COUNT(*)::int AS count FROM transaction_history WHERE ${where}`,
      values,
    );
    const totalCount = countResult.rows[0].count;

    const queryValues = [...values, limit, offset];
    const result = await pool.query(
      `SELECT
         th.*,
         m.first_name AS member_first_name,
         m.last_name AS member_last_name,
         m.member_id AS member_number,
         m.email AS member_email,
         m.phone AS member_phone
       FROM (
         SELECT ${transactionColumns}
         FROM transaction_history
         WHERE ${where}
         ORDER BY amount_taken_date DESC, created_date DESC
         LIMIT $${queryValues.length - 1} OFFSET $${queryValues.length}
       ) th
       LEFT JOIN members m ON m.id = th.member_id`,
      queryValues,
    );

    return res.status(200).json({
      success: true,
      count: totalCount,
      page,
      limit,
      totalPages: Math.ceil(totalCount / limit),
      transactions: result.rows,
    });
  } catch (error) {
    if (error.status === 400) {
      return res.status(400).json({
        success: false,
        message: error.message,
      });
    }
    console.error("Get transactions error:", error);
    return res
      .status(500)
      .json({ success: false, message: "Failed to fetch transactions" });
  }
};

const getTransaction = async (req, res) => {
  try {
    const isSuperAdmin = req.user?.role === "super_admin";
    const query = isSuperAdmin
      ? `SELECT ${transactionColumns} FROM transaction_history WHERE id = $1`
      : `SELECT ${transactionColumns} FROM transaction_history WHERE id = $1 AND club_id = $2`;
    const params = isSuperAdmin
      ? [req.params.transactionId]
      : [req.params.transactionId, req.user.clubId];

    const result = await pool.query(query, params);
    if (result.rows.length === 0) {
      return res
        .status(404)
        .json({ success: false, message: "Transaction not found" });
    }
    return res.status(200).json({ success: true, transaction: result.rows[0] });
  } catch (error) {
    console.error("Get transaction error:", error);
    return res
      .status(500)
      .json({ success: false, message: "Failed to fetch transaction" });
  }
};

const createTransaction = async (req, res) => {
  try {
    const {
      memberId,
      amount,
      receivedAmount,
      date,
      slipNo,
      invoiceNo,
      paymentStatus,
      paymentMethod,
      transactionType,
      remarks,
      clubId: requestedClubId,
    } = req.body;
    const isSuperAdmin = req.user?.role === "super_admin";
    const targetClubId = isSuperAdmin ? requestedClubId : req.user.clubId;

    if (!targetClubId) {
      return res.status(400).json({
        success: false,
        message: "clubId is required",
      });
    }

    // ---------------------------------------
    // 1. Validate required fields
    // ---------------------------------------

    if (!memberId) {
      return res.status(400).json({
        success: false,
        message: "memberId is required",
      });
    }

    if (amount === undefined || amount === null || amount === "") {
      return res.status(400).json({
        success: false,
        message: "amount is required",
      });
    }

    const transactionDate = date
      ? normalizeTransactionDate(date)
      : new Date().toISOString();
    if (!transactionDate) {
      return res.status(400).json({
        success: false,
        message:
          "date must be a valid YYYY-MM-DD date or ISO-8601 date-time",
      });
    }

    // ---------------------------------------
    // 2. Convert amounts to numbers
    // ---------------------------------------

    const transactionAmount = validateFinancialAmount(amount, "amount");
    const finalReceivedAmount =
      receivedAmount === undefined ||
      receivedAmount === null ||
      receivedAmount === ""
        ? transactionAmount
        : validateFinancialAmount(receivedAmount, "receivedAmount", {
            allowZero: true,
          });
    if (
      paymentStatus &&
      !statuses.has(String(paymentStatus).toLowerCase())
    ) {
      throw new RequestError("Invalid paymentStatus");
    }

    const gstRate = await getCurrentGstRate();
    const amountExcludingGst = transactionAmount;
    const cgstAmount =
      gstRate > 0
        ? Math.round(((amountExcludingGst * (gstRate / 2)) / 100) * 100) / 100
        : 0;
    const sgstAmount =
      gstRate > 0
        ? Math.round(((amountExcludingGst * (gstRate / 2)) / 100) * 100) / 100
        : 0;
    const totalGstAmount = Math.round((cgstAmount + sgstAmount) * 100) / 100;
    const totalAmountWithGst =
      Math.round((amountExcludingGst + totalGstAmount) * 100) / 100;

    if (
      !Number.isFinite(gstRate) ||
      gstRate < 0 ||
      ![
        amountExcludingGst,
        cgstAmount,
        sgstAmount,
        totalGstAmount,
        totalAmountWithGst,
      ].every(Number.isFinite)
    ) {
      throw new RequestError("amount is outside the supported financial range");
    }

    if (finalReceivedAmount > totalAmountWithGst) {
      throw new RequestError(
        `receivedAmount cannot be greater than total amount with GST (${totalAmountWithGst})`,
      );
    }

    // ---------------------------------------
    // 6. Calculate Balance & Automatic Payment Status
    // ---------------------------------------

    const balanceAmount = Math.max(totalAmountWithGst - finalReceivedAmount, 0);
    const pendingAmount = balanceAmount;

    let finalPaymentStatus = paymentStatus
      ? String(paymentStatus).toLowerCase()
      : paymentStatus;
    if (
      !finalPaymentStatus ||
      finalPaymentStatus === "pending" ||
      finalPaymentStatus === "partial" ||
      finalPaymentStatus === "completed"
    ) {
      if (balanceAmount === 0 && finalReceivedAmount > 0) {
        finalPaymentStatus = "completed";
      } else if (finalReceivedAmount > 0 && balanceAmount > 0) {
        finalPaymentStatus = "partial";
      } else {
        finalPaymentStatus = "pending";
      }
    }

    // ---------------------------------------
    // 7. Generate sequential slip_no automatically (SL-001, SL-002, ...)
    // ---------------------------------------

    const transaction = await withTransaction(async (client) => {
      const memberResult = await client.query(
        `
        SELECT id
        FROM members
        WHERE (id::text = $1 OR member_id = $1)
          AND club_id = $2
        FOR UPDATE
        `,
        [String(memberId), String(targetClubId)],
      );
      if (memberResult.rows.length === 0) {
        throw new RequestError("Member not found", 404);
      }
      const memberDatabaseId = String(memberResult.rows[0].id);

      // The transaction-scoped lock serializes prefix-ID allocation across API workers.
      await client.query("SELECT pg_advisory_xact_lock(831003)");
      let finalSlipNo = slipNo;
      if (!finalSlipNo) {
        const lastSlipResult = await client.query(
          `
          SELECT slip_no
          FROM transaction_history
          WHERE slip_no ~ '^SL-[0-9]+$'
          ORDER BY LENGTH(slip_no) DESC, slip_no DESC
          LIMIT 1
          `,
        );
        if (lastSlipResult.rows.length > 0 && lastSlipResult.rows[0].slip_no) {
          const match = lastSlipResult.rows[0].slip_no.match(/^SL-(\d+)$/);
          if (match) {
            const nextSlipNumber = BigInt(match[1]) + 1n;
            finalSlipNo = `SL-${String(nextSlipNumber).padStart(3, "0")}`;
          }
        }
        if (!finalSlipNo) {
          const countResult = await client.query(
            "SELECT COUNT(*)::bigint AS count FROM transaction_history",
          );
          finalSlipNo = `SL-${String(BigInt(countResult.rows[0].count) + 1n).padStart(3, "0")}`;
        }
      }

      const transactionNumberResult = await client.query(
        `
        SELECT COALESCE(MAX(SUBSTRING(id FROM '^txn_([0-9]+)$')::bigint), 0) + 1 AS next_number
        FROM transaction_history
        WHERE id ~ '^txn_[0-9]+$'
        `,
      );
      const transactionId =
        `txn_${String(transactionNumberResult.rows[0].next_number).padStart(3, "0")}`;

      const result = await client.query(
        `
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
          amount_excluding_gst,
          cgst_amount,
          sgst_amount,
          total_gst_amount,
          total_amount_with_gst,
          remarks,
          member_id,
          club_id,
          staff_id,
          transaction_id
        )
        VALUES (
          $1, NOW(), NOW(), $2, $3, $4, $5, $6, $7, $8, $9, $10,
          $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22
        )
        RETURNING ${transactionColumns}
        `,
        [
          transactionId,
          transactionDate,
          finalSlipNo,
          invoiceNo || null,
          finalPaymentStatus,
          totalAmountWithGst,
          finalReceivedAmount,
          balanceAmount,
          paymentMethod || "cash",
          transactionType || "membership",
          "completed",
          pendingAmount,
          amountExcludingGst,
          cgstAmount,
          sgstAmount,
          totalGstAmount,
          totalAmountWithGst,
          remarks || null,
          memberDatabaseId,
          String(targetClubId),
          req.user.staffId ? String(req.user.staffId) : null,
          transactionId,
        ],
      );

      await client.query(
        `
        UPDATE members
        SET pending_amount = (
          SELECT COALESCE(SUM(balance_amount), 0)
          FROM transaction_history
          WHERE member_id = $1 AND club_id = $2
        ),
        updated_date = NOW()
        WHERE id = $1 AND club_id = $2
        `,
        [memberDatabaseId, String(targetClubId)],
      );
      return result.rows[0];
    });

    try {
      await vectorService.indexTransaction({
        transactionId: transaction.id,
        clubId: String(targetClubId),
      });
    } catch (indexError) {
      console.error("Transaction vector indexing skipped:", indexError.message);
    }

    // ---------------------------------------
    // 10. Success response
    // ---------------------------------------

    return res.status(201).json({
      success: true,
      message: "Transaction created successfully",
      transaction,
    });
  } catch (error) {
    console.error("Create transaction error:", error);

    return res.status(error.status || 500).json({
      success: false,
      message: error.status ? error.message : "Failed to create transaction",
    });
  }
};

const updateTransaction = async (req, res) => {
  const fields = {
    invoiceNo: "invoice_no",
    transactionType: "types",
    paymentStatus: "payment_status",
    amount: "amount_excluding_gst",
    receivedAmount: "received_amount",
    balanceAmount: "balance_amount",
    paymentMethod: "payment_method",
    remarks: "remarks",
    date: "amount_taken_date",
  };
  const updates = Object.entries(fields).filter(
    ([key]) => req.body[key] !== undefined,
  );
  if (!updates.length)
    return res
      .status(400)
      .json({ success: false, message: "No editable fields supplied" });
  if (
    req.body.paymentStatus &&
    !statuses.has(String(req.body.paymentStatus).toLowerCase())
  )
    return res
      .status(400)
      .json({ success: false, message: "Invalid paymentStatus" });
  let requestedAmount;
  let requestedReceivedAmount;
  let requestedBalanceAmount;
  try {
    if (req.body.amount !== undefined) {
      requestedAmount = validateFinancialAmount(req.body.amount, "amount");
    }
    if (req.body.receivedAmount !== undefined) {
      requestedReceivedAmount = validateFinancialAmount(
        req.body.receivedAmount,
        "receivedAmount",
        { allowZero: true },
      );
    }
    if (req.body.balanceAmount !== undefined) {
      requestedBalanceAmount = validateFinancialAmount(
        req.body.balanceAmount,
        "balanceAmount",
        { allowZero: true },
      );
    }
  } catch (error) {
    return res.status(error.status || 400).json({
      success: false,
      message: error.message,
    });
  }
  try {
    const isSuperAdmin = req.user?.role === "super_admin";
    const updatedTransaction = await withTransaction(async (client) => {
      const existingTxn = await client.query(
        `SELECT id, amount_excluding_gst, debit_amount, total_amount_with_gst, received_amount, member_id, club_id, cgst_amount, sgst_amount, total_gst_amount FROM transaction_history WHERE id = $1${isSuperAdmin ? "" : " AND club_id = $2"} FOR UPDATE`,
        isSuperAdmin
          ? [req.params.transactionId]
          : [req.params.transactionId, req.user.clubId],
      );
      if (!existingTxn.rows.length) {
        throw new RequestError("Transaction not found", 404);
      }

      const txn = existingTxn.rows[0];
      const memberDatabaseId = txn.member_id;
      const targetClubId = txn.club_id;
      const memberLock = await client.query(
        "SELECT id FROM members WHERE id = $1 AND club_id = $2 FOR UPDATE",
        [memberDatabaseId, targetClubId],
      );
      if (!memberLock.rows.length) {
        throw new RequestError("Member not found", 404);
      }

      let totalAmountWithGst;
      let amountExcludingGst;
      let cgstAmount;
      let sgstAmount;
      let totalGstAmount;

      if (requestedAmount !== undefined) {
        amountExcludingGst = requestedAmount;
        const gstRate = await getCurrentGstRate();
        cgstAmount =
          gstRate > 0
            ? Math.round(((amountExcludingGst * (gstRate / 2)) / 100) * 100) / 100
            : 0;
        sgstAmount =
          gstRate > 0
            ? Math.round(((amountExcludingGst * (gstRate / 2)) / 100) * 100) / 100
            : 0;
        totalGstAmount = Math.round((cgstAmount + sgstAmount) * 100) / 100;
        totalAmountWithGst =
          Math.round((amountExcludingGst + totalGstAmount) * 100) / 100;
        if (
          !Number.isFinite(gstRate) ||
          gstRate < 0 ||
          ![
            amountExcludingGst,
            cgstAmount,
            sgstAmount,
            totalGstAmount,
            totalAmountWithGst,
          ].every(Number.isFinite)
        ) {
          throw new RequestError(
            "amount is outside the supported financial range",
          );
        }
      } else {
        amountExcludingGst = Number(
          txn.amount_excluding_gst || txn.debit_amount || 0,
        );
        cgstAmount = Number(txn.cgst_amount || 0);
        sgstAmount = Number(txn.sgst_amount || 0);
        totalGstAmount = Number(txn.total_gst_amount || 0);
        totalAmountWithGst = Number(
          txn.total_amount_with_gst || txn.debit_amount || 0,
        );
      }

      const newReceived =
        requestedReceivedAmount !== undefined
          ? requestedReceivedAmount
          : Number(txn.received_amount || 0);
      if (
        !Number.isFinite(totalAmountWithGst) ||
        totalAmountWithGst <= 0 ||
        !Number.isFinite(newReceived)
      ) {
        throw new RequestError("Stored transaction amounts are invalid", 409);
      }
      if (newReceived > totalAmountWithGst) {
        throw new RequestError(
          `receivedAmount cannot be greater than total amount with GST (${totalAmountWithGst})`,
        );
      }
      if (
        requestedBalanceAmount !== undefined &&
        requestedBalanceAmount > totalAmountWithGst
      ) {
        throw new RequestError(
          "balanceAmount cannot be greater than total amount with GST",
        );
      }

      const newBalance = Math.max(totalAmountWithGst - newReceived, 0);
      const autoStatus =
        newBalance === 0 && newReceived > 0
          ? "completed"
          : newReceived > 0
            ? "partial"
            : "pending";
      const values = [];
      const assignments = [];

      if (req.body.date !== undefined) {
        const transactionDate = normalizeTransactionDate(req.body.date);
        if (!transactionDate) {
          throw new RequestError(
            "date must be a valid YYYY-MM-DD date or ISO-8601 date-time",
          );
        }
        values.push(transactionDate);
        assignments.push(`amount_taken_date = $${values.length}`);
      }
      if (req.body.paymentMethod !== undefined) {
        values.push(req.body.paymentMethod);
        assignments.push(`payment_method = $${values.length}`);
      }
      if (req.body.invoiceNo !== undefined) {
        values.push(req.body.invoiceNo || null);
        assignments.push(`invoice_no = $${values.length}`);
      }
      if (req.body.transactionType !== undefined) {
        values.push(req.body.transactionType);
        assignments.push(`types = $${values.length}`);
      }
      if (req.body.remarks !== undefined) {
        values.push(req.body.remarks);
        assignments.push(`remarks = $${values.length}`);
      }

      values.push(amountExcludingGst);
      assignments.push(`amount_excluding_gst = $${values.length}`);
      values.push(cgstAmount);
      assignments.push(`cgst_amount = $${values.length}`);
      values.push(sgstAmount);
      assignments.push(`sgst_amount = $${values.length}`);
      values.push(totalGstAmount);
      assignments.push(`total_gst_amount = $${values.length}`);
      values.push(totalAmountWithGst);
      assignments.push(`total_amount_with_gst = $${values.length}`);
      values.push(totalAmountWithGst);
      assignments.push(`debit_amount = $${values.length}`);
      values.push(newReceived);
      assignments.push(`received_amount = $${values.length}`);
      values.push(newBalance);
      assignments.push(`balance_amount = $${values.length}`);
      values.push(newBalance);
      assignments.push(`pending_amount = $${values.length}`);
      values.push(
        req.body.paymentStatus
          ? String(req.body.paymentStatus).toLowerCase()
          : autoStatus,
      );
      assignments.push(`payment_status = $${values.length}`);

      values.push(req.params.transactionId);
      if (!isSuperAdmin) values.push(req.user.clubId);
      const transactionIdParam = values.length - (isSuperAdmin ? 0 : 1);
      const result = await client.query(
        `UPDATE transaction_history SET ${assignments.join(", ")}, updated_date = NOW() WHERE id = $${transactionIdParam}${isSuperAdmin ? "" : ` AND club_id = $${values.length}`} RETURNING ${transactionColumns}`,
        values,
      );
      if (!result.rows.length) {
        throw new RequestError("Transaction not found", 404);
      }

      await client.query(
        `
        UPDATE members
        SET pending_amount = (
          SELECT COALESCE(SUM(balance_amount), 0)
          FROM transaction_history
          WHERE member_id = $1 AND club_id = $2
        ),
        updated_date = NOW()
        WHERE id = $1 AND club_id = $2
        `,
        [memberDatabaseId, String(targetClubId)],
      );
      return { transaction: result.rows[0], clubId: targetClubId };
    });

    try {
      await vectorService.indexTransaction({
        transactionId: updatedTransaction.transaction.id,
        clubId: String(updatedTransaction.clubId),
      });
    } catch (indexError) {
      console.error("Transaction vector indexing skipped:", indexError.message);
    }

    return res.json({
      success: true,
      transaction: updatedTransaction.transaction,
    });
  } catch (error) {
    console.error("Update transaction error:", error);
    return res
      .status(error.status || 500)
      .json({
        success: false,
        message: error.status ? error.message : "Failed to update transaction",
      });
  }
};

const deleteTransaction = async (req, res) => {
  try {
    const isSuperAdmin = req.user?.role === "super_admin";
    await withTransaction(async (client) => {
      const existingTxn = await client.query(
        `SELECT id, member_id, club_id FROM transaction_history WHERE id = $1${isSuperAdmin ? "" : " AND club_id = $2"} FOR UPDATE`,
        isSuperAdmin
          ? [req.params.transactionId]
          : [req.params.transactionId, req.user.clubId],
      );
      if (!existingTxn.rows.length) {
        throw new RequestError("Transaction not found", 404);
      }

      const memberDatabaseId = existingTxn.rows[0].member_id;
      const targetClubId = existingTxn.rows[0].club_id;
      await client.query(
        "SELECT id FROM members WHERE id = $1 AND club_id = $2 FOR UPDATE",
        [memberDatabaseId, targetClubId],
      );
      await client.query(
        "DELETE FROM transaction_history WHERE id = $1 AND club_id = $2",
        [req.params.transactionId, targetClubId],
      );
      await client.query(
        `
        UPDATE members
        SET pending_amount = (
          SELECT COALESCE(SUM(balance_amount), 0)
          FROM transaction_history
          WHERE member_id = $1 AND club_id = $2
        ),
        updated_date = NOW()
        WHERE id = $1 AND club_id = $2
        `,
        [memberDatabaseId, String(targetClubId)],
      );
    });

    return res.json({
      success: true,
      message: "Transaction deleted successfully",
    });
  } catch (error) {
    console.error("Delete transaction error:", error);
    return res
      .status(error.status || 500)
      .json({
        success: false,
        message: error.status ? error.message : "Failed to delete transaction",
      });
  }
};

module.exports = {
  getTransactions,
  getTransaction,
  createTransaction,
  updateTransaction,
  deleteTransaction,
};

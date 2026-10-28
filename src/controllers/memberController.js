const pool = require("../config/db");
const mistral = require("../config/mistral");

const memberColumns = `
  id, created_date, updated_date, first_name, last_name, email, phone,
  member_id, pending_amount, amc_status, club_id, staff_id
`;

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function isValidNonNegativeAmount(value) {
  return (
    (typeof value === "number" || typeof value === "string") &&
    !(typeof value === "string" && value.trim() === "") &&
    Number.isFinite(Number(value)) &&
    Number(value) >= 0
  );
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

function getPagination(query) {
  const page = Math.max(Number.parseInt(query.page, 10) || 1, 1);
  const limit = Math.min(
    Math.max(Number.parseInt(query.limit, 10) || 10, 1),
    100,
  );
  return { page, limit, offset: (page - 1) * limit };
}

const getMembers = async (req, res) => {
  try {
    const { search = "", sort = "created_date", order = "desc" } = req.query;
    const { page, limit, offset } = getPagination(req.query);
    const allowedSorts = new Set([
      "created_date",
      "updated_date",
      "first_name",
      "last_name",
      "member_id",
    ]);
    const sortColumn = allowedSorts.has(sort) ? sort : "created_date";
    const sortOrder = String(order).toLowerCase() === "asc" ? "ASC" : "DESC";
    const isSuperAdmin = req.user?.role === "super_admin";
    const values = isSuperAdmin ? [] : [req.user.clubId];
    let where = isSuperAdmin ? "WHERE 1=1" : "WHERE club_id = $1";

    const targetClubId = req.query.clubId || req.query.club_id;
    if (isSuperAdmin && targetClubId && targetClubId !== "all") {
      values.push(targetClubId);
      where += ` AND club_id = $${values.length}`;
    }

    if (String(search).trim()) {
      values.push(`%${String(search).trim()}%`);
      where += ` AND (member_id ILIKE $${values.length} OR first_name ILIKE $${values.length} OR last_name ILIKE $${values.length} OR email ILIKE $${values.length} OR phone ILIKE $${values.length} OR club_id ILIKE $${values.length} OR EXISTS (SELECT 1 FROM clubs c WHERE c.club_id = members.club_id AND c.title ILIKE $${values.length}))`;
    }

    const countResult = await pool.query(
      `SELECT COUNT(*)::int AS count FROM members ${where}`,
      values,
    );
    values.push(limit, offset);
    const result = await pool.query(
      `SELECT ${memberColumns} FROM members ${where} ORDER BY ${sortColumn} ${sortOrder} LIMIT $${values.length - 1} OFFSET $${values.length}`,
      values,
    );

    return res.status(200).json({
      success: true,
      count: countResult.rows[0].count,
      page,
      limit,
      totalPages: Math.ceil(countResult.rows[0].count / limit),
      members: result.rows,
    });
  } catch (error) {
    console.error("Get members error:", error);
    return res
      .status(500)
      .json({ success: false, message: "Failed to fetch members" });
  }
};

const getMember = async (req, res) => {
  try {
    const isSuperAdmin = req.user?.role === "super_admin";
    const queryText = isSuperAdmin
      ? `SELECT ${memberColumns} FROM members WHERE (id = $1 OR member_id = $1)`
      : `SELECT ${memberColumns} FROM members WHERE (id = $1 OR member_id = $1) AND club_id = $2`;
    const params = isSuperAdmin ? [req.params.memberId] : [req.params.memberId, req.user.clubId];

    const result = await pool.query(queryText, params);
    if (result.rows.length === 0)
      return res
        .status(404)
        .json({ success: false, message: "Member not found" });
    return res.json({ success: true, member: result.rows[0] });
  } catch (error) {
    console.error("Get member error:", error);
    return res
      .status(500)
      .json({ success: false, message: "Failed to fetch member" });
  }
};

const getMemberSummary = async (req, res) => {
  try {
    const { memberId } = req.params;
    const isSuperAdmin = req.user?.role === "super_admin";
    const clubId = req.user.clubId;

    const memberResult = await pool.query(
      `SELECT ${memberColumns}
       FROM members
       WHERE (id::text = $1 OR member_id = $1)
       ${isSuperAdmin ? "" : "AND club_id = $2"}`,
      isSuperAdmin ? [memberId] : [memberId, clubId],
    );

    if (memberResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Member not found",
      });
    }

    const member = memberResult.rows[0];

    const summaryResult = await pool.query(
      `
      SELECT
        COUNT(*)::int AS transaction_count,

        COALESCE(
          SUM(
            CASE
              WHEN COALESCE(total_amount_with_gst, 0) > 0 THEN total_amount_with_gst
              WHEN COALESCE(debit_amount, 0) > 0 THEN debit_amount
              ELSE COALESCE(received_amount, 0) + COALESCE(balance_amount, 0)
            END
          ),
          0
        )::numeric AS total_amount,

        COALESCE(
          SUM(COALESCE(received_amount, 0)),
          0
        )::numeric AS received_amount,

        COALESCE(
          SUM(COALESCE(balance_amount, 0)),
          0
        )::numeric AS balance_amount

      FROM transaction_history
      WHERE member_id = $1
      ${isSuperAdmin ? "" : "AND club_id = $2"}
      `,
      isSuperAdmin ? [member.id] : [member.id, clubId],
    );

    const summary = summaryResult.rows[0];

    const transactionsResult = await pool.query(
      `
      SELECT
        id,
        created_date,
        updated_date,
        amount_taken_date,
        slip_no,
        invoice_no,
        debit_amount,
        received_amount,
        balance_amount,
        payment_status,
        payment_method,
        amount_excluding_gst,
        cgst_amount,
        sgst_amount,
        total_gst_amount,
        total_amount_with_gst,
        types,
        remarks
      FROM transaction_history
      WHERE member_id = $1
      ${isSuperAdmin ? "" : "AND club_id = $2"}
      ORDER BY amount_taken_date DESC, created_date DESC
      `,
      isSuperAdmin ? [member.id] : [member.id, clubId],
    );

    // 4. Return response
    return res.status(200).json({
      success: true,

      data: {
        member: {
          id: member.id,
          memberId: member.member_id,
          firstName: member.first_name,
          lastName: member.last_name,
          email: member.email,
          phone: member.phone,
          pendingAmount: member.pending_amount,
          amcStatus: member.amc_status,
        },

        summary: {
          transactionCount: summary.transaction_count,
          totalAmount: summary.total_amount,
          receivedAmount: summary.received_amount,
          balanceAmount: summary.balance_amount,
        },

        transactions: transactionsResult.rows,
      },
    });
  } catch (error) {
    console.error("Get member summary error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to get member summary",
    });
  }
};

const createMember = async (req, res) => {
  try {
    const {
      firstName,
      lastName,
      email,
      phone,
      pendingAmount = 0,
      amcStatus = "active",
    } = req.body;
    const isSuperAdmin = req.user?.role === "super_admin";
    const targetClubId = isSuperAdmin
      ? req.body.clubId || req.body.club_id
      : req.user.clubId;

    if (!targetClubId) {
      return res.status(400).json({
        success: false,
        message: "clubId is required",
      });
    }

    if (!firstName || !lastName || !email) {
      return res.status(400).json({
        success: false,
        message: "firstName, lastName, and email are required",
      });
    }

    const normalizedEmail = String(email).trim().toLowerCase();
    if (!emailPattern.test(normalizedEmail)) {
      return res.status(400).json({
        success: false,
        message: "A valid email is required, such as example@example.com",
      });
    }

    const parsedPendingAmount = Number(pendingAmount);
    if (!isValidNonNegativeAmount(pendingAmount)) {
      return res.status(400).json({
        success: false,
        message: "pendingAmount must be a valid non-negative number",
      });
    }

    const member = await withTransaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(831002)");
      const existingEmail = await client.query(
        "SELECT 1 FROM members WHERE LOWER(email) = $1 LIMIT 1",
        [normalizedEmail],
      );
      if (existingEmail.rows.length > 0) {
        const conflict = new Error("Member email already exists");
        conflict.code = "23505";
        throw conflict;
      }

      const maxResult = await client.query(
        `SELECT GREATEST(COALESCE(MAX(SUBSTRING(member_id FROM 5)::bigint), 1009) + 1, 1010) AS next_number
         FROM members
         WHERE member_id ~* '^Mem_[0-9]+$'`,
      );
      const memberIdNumber = BigInt(maxResult.rows[0].next_number);
      const memberId = `Mem_${memberIdNumber}`;

      const maxMemberIdResult = await client.query(
        `SELECT COALESCE(MAX(SUBSTRING(id FROM 5)::bigint), 0) + 1 AS next_number
         FROM members
         WHERE id ~ '^mem_[0-9]+$'`,
      );
      const memberNumber = BigInt(maxMemberIdResult.rows[0].next_number);
      const id = `mem_${String(memberNumber).padStart(3, "0")}`;

      const result = await client.query(
        `
          INSERT INTO members (
            id,
            first_name,
            last_name,
            email,
            phone,
            member_id,
            pending_amount,
            amc_status,
            club_id,
            staff_id,
            created_date,
            updated_date
          )
          VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW(), NOW()
          )
          RETURNING ${memberColumns}
        `,
        [
          id,
          firstName.trim(),
          lastName.trim(),
          normalizedEmail,
          phone ? phone.trim() : null,
          memberId,
          parsedPendingAmount,
          amcStatus,
          targetClubId,
          req.user.staffId || null,
        ],
      );
      return result.rows[0];
    });

    return res.status(201).json({
      success: true,
      message: "Member created successfully",
      member,
    });
  } catch (error) {
    console.error("Create member error:", error);

    if (error.code === "23505") {
      return res.status(409).json({
        success: false,
        message: "Member email already exists",
      });
    }

    return res.status(500).json({
      success: false,
      message: "Failed to create member",
    });
  }
};


const updateMember = async (req, res) => {
  const fields = {
    firstName: "first_name",
    lastName: "last_name",
    email: "email",
    phone: "phone",
    pendingAmount: "pending_amount",
    amcStatus: "amc_status",
  };

  const updates = Object.entries(fields).filter(
    ([key]) => req.body[key] !== undefined,
  );
  if (updates.length === 0)
    return res
      .status(400)
      .json({ success: false, message: "No editable fields supplied" });
  let normalizedEmail;
  if (req.body.email !== undefined) {
    normalizedEmail = String(req.body.email).trim().toLowerCase();
    if (!emailPattern.test(normalizedEmail))
      return res.status(400).json({
        success: false,
        message: "A valid email is required, such as example@example.com",
      });
  }
  if (
    req.body.pendingAmount !== undefined &&
    !isValidNonNegativeAmount(req.body.pendingAmount)
  )
    return res.status(400).json({
      success: false,
      message: "pendingAmount must be a non-negative number",
    });

  try {
    const isSuperAdmin = req.user?.role === "super_admin";
    if (normalizedEmail) {
      const existingEmail = await pool.query(
        `SELECT 1 FROM members
         WHERE LOWER(email) = $1
           AND NOT (id = $2 OR member_id = $2)
         LIMIT 1`,
        [normalizedEmail, req.params.memberId],
      );
      if (existingEmail.rows.length > 0) {
        return res.status(409).json({
          success: false,
          message: "Member email already exists",
        });
      }
    }

    const values = [];
    const assignments = updates.map(([key, column]) => {
      values.push(
        key === "pendingAmount"
          ? Number(req.body[key])
          : key === "email"
            ? normalizedEmail
            : req.body[key],
      );
      return `${column} = $${values.length}`;
    });
    values.push(req.params.memberId);
    if (!isSuperAdmin) values.push(req.user.clubId);
    const memberIdParam = values.length - (isSuperAdmin ? 0 : 1);
    const result = await pool.query(
      `UPDATE members SET ${assignments.join(", ")}, updated_date = NOW() WHERE (id = $${memberIdParam} OR member_id = $${memberIdParam})${isSuperAdmin ? "" : ` AND club_id = $${values.length}`} RETURNING ${memberColumns}`,
      values,
    );
    if (result.rows.length === 0)
      return res
        .status(404)
        .json({ success: false, message: "Member not found" });
    return res.json({ success: true, member: result.rows[0] });
  } catch (error) {
    console.error("Update member error:", error);
    if (error.code === "23505") {
      return res.status(409).json({
        success: false,
        message: "Member email already exists",
      });
    }
    return res
      .status(500)
      .json({ success: false, message: "Failed to update member" });
  }
};

const deleteMember = async (req, res) => {
  try {
    const { memberId } = req.params;
    const isSuperAdmin = req.user?.role === "super_admin";
    const clubId = req.user.clubId;

    console.log("Delete member request:", {
      memberId,
      clubId,
    });

    if (!memberId) {
      return res.status(400).json({
        success: false,
        message: "Member ID is required",
      });
    }

    if (!isSuperAdmin && !clubId) {
      return res.status(401).json({
        success: false,
        message: "Club information is missing from authentication",
      });
    }

    // Find member
    const memberResult = await pool.query(
      `
        SELECT id, member_id, first_name, last_name, club_id
        FROM members
        WHERE (id = $1 OR member_id = $1)
        ${isSuperAdmin ? "" : "AND club_id = $2"}
      `,
      isSuperAdmin ? [memberId] : [memberId, clubId],
    );

    if (memberResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Member not found",
      });
    }

    const member = memberResult.rows[0];

    // Check transaction history
    const transactionResult = await pool.query(
      `
        SELECT 1
        FROM transaction_history
        WHERE member_id = $1
          AND club_id = $2
        LIMIT 1
      `,
      [member.id, member.club_id],
    );

    if (transactionResult.rows.length > 0) {
      return res.status(409).json({
        success: false,
        message: "Member has transaction history and cannot be deleted",
      });
    }

    // Delete member
    await pool.query(
      `
        DELETE FROM members
        WHERE id = $1
          AND club_id = $2
      `,
      [member.id, member.club_id],
    );

    return res.status(200).json({
      success: true,
      message: "Member deleted successfully",
    });
  } catch (error) {
    console.error("Delete member error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to delete member",
    });
  }
};

const generateTransactionSummary = async (req, res) => {
  try {
    const { memberId } = req.body;
    const clubId = req.user.clubId;

    if (!memberId) {
      return res.status(400).json({
        success: false,
        message: "memberId is required",
      });
    }

    // 1. GET MEMBER

    const memberResult = await pool.query(
      `
      SELECT ${memberColumns}
      FROM members
      WHERE
        (id::text = $1 OR member_id = $1)
        AND club_id = $2
      `,
      [String(memberId), clubId],
    );

    if (memberResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Member not found",
      });
    }

    const member = memberResult.rows[0];

    // 2. GET TRANSACTION STATISTICS

    const statsResult = await pool.query(
      `
      SELECT
        COALESCE(
          SUM(COALESCE(received_amount, 0)),
          0
        )::numeric AS total_received,

        COUNT(*)::int AS transaction_count,

        COUNT(*) FILTER (
          WHERE LOWER(payment_status) = 'partial'
        )::int AS partial_count,

        COUNT(*) FILTER (
          WHERE LOWER(payment_status) = 'completed'
        )::int AS completed_count,

        COUNT(*) FILTER (
          WHERE LOWER(payment_status) = 'pending'
        )::int AS pending_count,

        COUNT(*) FILTER (
          WHERE LOWER(payment_status) = 'failed'
        )::int AS failed_count,

        (
          SELECT balance_amount
          FROM transaction_history
          WHERE member_id = $1
            AND club_id = $2
          ORDER BY amount_taken_date DESC NULLS LAST, id DESC
          LIMIT 1
        )::numeric AS latest_balance,

        (
          SELECT amount_taken_date
          FROM transaction_history
          WHERE member_id = $1
            AND club_id = $2
          ORDER BY amount_taken_date DESC NULLS LAST, id DESC
          LIMIT 1
        ) AS last_payment_date

      FROM transaction_history
      WHERE member_id = $1
        AND club_id = $2
      `,
      [member.id, clubId],
    );

    const stats = statsResult.rows[0];

    // 3. GET RECENT TRANSACTIONS

    const transactionResult = await pool.query(
      `
      SELECT
        amount_taken_date,
        slip_no,
        received_amount,
        balance_amount,
        payment_status,
        payment_method,
        types,
        remarks
      FROM transaction_history
      WHERE member_id = $1
        AND club_id = $2
      ORDER BY amount_taken_date DESC NULLS LAST, id DESC
      LIMIT 10
      `,
      [member.id, clubId],
    );

    const transactions = transactionResult.rows;

    // 4. CREATE CONTROLLED AI CONTEXT

    const aiContext = {
      member: {
        memberId: member.member_id,
        name: `${member.first_name} ${member.last_name}`.trim(),
        email: member.email,
        amcStatus: member.amc_status,
      },

      stats: {
        totalReceived: stats.total_received,
        latestBalance: stats.latest_balance,
        transactionCount: stats.transaction_count,
        partialCount: stats.partial_count,
        completedCount: stats.completed_count,
        pendingCount: stats.pending_count,
        failedCount: stats.failed_count,
        lastPaymentDate: stats.last_payment_date,
      },

      recentTransactions: transactions,
    };

    // 5. CREATE DATABASE FALLBACK SUMMARY

    const fallbackSummary =
      `${member.first_name} ${member.last_name} has ` +
      `${stats.transaction_count} transaction(s). ` +
      `The total amount received is ₹${Number(
        stats.total_received || 0,
      ).toFixed(2)}. ` +
      `The latest balance is ₹${Number(stats.latest_balance || 0).toFixed(
        2,
      )}. ` +
      `There are ${stats.completed_count} completed, ` +
      `${stats.partial_count} partial, ` +
      `${stats.pending_count} pending, and ` +
      `${stats.failed_count} failed transaction(s). ` +
      `The last payment date was ${
        stats.last_payment_date
          ? new Date(stats.last_payment_date).toLocaleDateString("en-IN")
          : "not available"
      }.`;

    // 6. GENERATE AI SUMMARY

    let aiSummary = fallbackSummary;
    let aiGenerated = false;

    try {
      console.log("Sending data to Mistral...");

      const completion = await mistral.chat.completions.create({
        model: process.env.MISTRAL_MODEL || "mistral-large-latest",

        temperature: 0.2,

        max_completion_tokens: 300,

        messages: [
          {
            role: "system",
            content: `
You are the Smart Ledger AI payment summary assistant.

Generate a short professional payment summary.

RULES:
- Use ONLY the database data provided by the user.
- Never invent financial values.
- Never invent transactions.
- Never change numbers.
- Do not make financial calculations.
- Mention total received amount.
- Mention latest balance.
- Mention transaction count.
- Mention useful payment status information.
- Mention the last payment date when available.
- Format all monetary amounts in Indian rupees using the ₹ symbol. Never use $.
- Keep the response between 2 and 5 sentences.
- Return ONLY the summary text.
            `.trim(),
          },

          {
            role: "user",
            content: `
Generate a payment summary for this member.

DATABASE DATA:

${JSON.stringify(aiContext, null, 2)}
            `.trim(),
          },
        ],
      });

      console.log("Mistral response received");

      const generatedText = completion?.choices?.[0]?.message?.content?.trim();

      if (generatedText) {
        aiSummary = generatedText.replace(/\$(?=\s*[\d,.])/g, "₹");
        aiGenerated = true;
      } else {
        console.warn(
          "Mistral returned an empty response. Using database fallback.",
        );
      }
    } catch (aiError) {
      console.error("========== MISTRAL ERROR ==========");
      console.error("Message:", aiError?.message);
      console.error("Status:", aiError?.status);
      console.error("Code:", aiError?.code);
      console.error("Response:", aiError?.response?.data);
      console.error("Full error:", aiError);
      console.error("================================");

      // Keep database fallback
      aiSummary = fallbackSummary;
      aiGenerated = false;
    }

    // 7. RETURN RESPONSE

    return res.status(200).json({
      success: true,

      memberId: member.member_id,

      memberName: `${member.first_name} ${member.last_name}`.trim(),

      stats: {
        totalReceived: stats.total_received,
        latestBalance: stats.latest_balance,
        transactionCount: stats.transaction_count,
        partialCount: stats.partial_count,
        completedCount: stats.completed_count,
        pendingCount: stats.pending_count,
        failedCount: stats.failed_count,
        lastPaymentDate: stats.last_payment_date,
      },

      summary: aiSummary,

      aiGenerated,

      generatedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error("Generate transaction summary error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to generate transaction summary",
    });
  }
};

module.exports = {
  getMembers,
  getMember,
  getMemberSummary,
  createMember,
  updateMember,
  deleteMember,
  generateTransactionSummary,
};

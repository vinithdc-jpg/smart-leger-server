const pool = require("../config/db");

const getTransactionHistories = async (req, res) => {
  try {
    const { clubId, memberId } = req.query;

    // Get logged-in user's club from JWT
    const loggedInClubId = req.user.clubId;

    // If clubId is provided, make sure it belongs to logged-in user
    if (clubId && clubId !== loggedInClubId) {
      return res.status(403).json({
        success: false,
        message: "You are not authorized to access this club",
      });
    }

    // Always use authenticated user's club
    const finalClubId = loggedInClubId;

    let query = `
      SELECT
        th.id,
        th.created_date,
        th.updated_date,
        th.amount_taken_date,
        th.slip_no,
        th.invoice_no,
        th.payment_status,
        th.debit_amount,
        th.received_amount,
        th.balance_amount,
        th.payment_method,
        th.types,
        th.status,
        th.pending_amount,
        th.is_amc_transaction_debit,
        th.amc_transaction_type,
        th.amount_excluding_gst,
        th.cgst_amount,
        th.sgst_amount,
        th.total_gst_amount,
        th.total_amount_with_gst,
        th.invoice_prefix,
        th.transaction_id,
        th.remarks,

        th.member_id,
        th.club_id,
        th.staff_id,

        m.first_name,
        m.last_name,
        m.email,
        m.phone,
        m.member_id AS member_number

      FROM transaction_history th

      INNER JOIN members m
        ON th.member_id = m.id

      WHERE th.club_id = $1
    `;

    const values = [finalClubId];

    // Optional member filter
    if (memberId) {
      query += ` AND th.member_id = $2`;
      values.push(memberId);
    }

    query += `
      ORDER BY th.amount_taken_date DESC
    `;

    const result = await pool.query(query, values);

    return res.status(200).json({
      success: true,
      count: result.rows.length,
      transactions: result.rows,
    });
  } catch (error) {
    console.error("Get transaction histories error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to fetch transaction histories",
    });
  }
};

module.exports = {
  getTransactionHistories,
};

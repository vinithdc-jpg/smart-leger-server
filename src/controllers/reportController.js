const ExcelJS = require("exceljs");
const PDFDocument = require("pdfkit");
const pool = require("../config/db");

function reportError(res, error, operation) {
  if (error.status === 400) {
    return res.status(400).json({ success: false, message: error.message });
  }
  console.error(`${operation} error`, error);
  return res.status(500).json({ success: false, message: "Server error" });
}

function getDateRange(query) {
  const { startDate, endDate } = query;
  if (!startDate && !endDate) return null;
  if (!startDate || !endDate || !isValidDate(startDate) || !isValidDate(endDate)) {
    throw Object.assign(new Error("A valid start and end date are required."), { status: 400 });
  }
  if (startDate > endDate) {
    throw Object.assign(new Error("Start date must be before end date."), { status: 400 });
  }
  return { startDate, endDate };
}

function isValidDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}

function getPagination(query) {
  const page = Math.max(Number.parseInt(query.page, 10) || 1, 1);
  const limit = Math.min(Math.max(Number.parseInt(query.limit, 10) || 10, 1), 100);
  return { page, limit, offset: (page - 1) * limit };
}

function addClubFilter(req, query, alias, values, clauses) {
  const clubId = req.user?.role === "super_admin"
    ? query.clubId
    : req.user?.clubId;
  if (clubId && clubId !== "all") {
    values.push(clubId);
    clauses.push(`${alias}.club_id = $${values.length}`);
  }
}

function appendDateFilter(
  range,
  expression,
  values,
  clauses,
  useIndiaTimeZone = false,
) {
  if (!range) return null;
  values.push(range.startDate, range.endDate);
  const startIndex = values.length - 1;
  const endIndex = values.length;
  const start = useIndiaTimeZone
    ? `($${startIndex}::date::timestamp AT TIME ZONE 'Asia/Kolkata')`
    : `$${startIndex}::date`;
  const end = useIndiaTimeZone
    ? `(($${endIndex}::date + INTERVAL '1 day')::timestamp AT TIME ZONE 'Asia/Kolkata')`
    : `($${endIndex}::date + INTERVAL '1 day')`;
  clauses.push(`${expression} >= ${start} AND ${expression} < ${end}`);
  return { startIndex, endIndex };
}

const transactionDateExpression =
  "COALESCE(th.amount_taken_date, th.created_date AT TIME ZONE 'UTC')";

function totalAmountExpression(alias) {
  return `COALESCE(NULLIF(${alias}.total_amount_with_gst, 0), NULLIF(${alias}.debit_amount, 0), COALESCE(${alias}.received_amount, 0) + COALESCE(${alias}.balance_amount, 0))`;
}

function buildTransactionFilters(req, query) {
  const values = [];
  const clauses = ["1=1"];
  const range = getDateRange(query);

  addClubFilter(req, query, "th", values, clauses);
  if (query.staffId && query.staffId !== "all") {
    values.push(query.staffId);
    clauses.push(`th.staff_id = $${values.length}`);
  }
  if (query.status && query.status !== "all") {
    values.push(String(query.status).toLowerCase());
    clauses.push(`LOWER(COALESCE(th.payment_status, '')) = $${values.length}`);
  }
  if (query.type && query.type !== "all") {
    values.push(String(query.type).toLowerCase());
    clauses.push(`LOWER(COALESCE(th.types, '')) = $${values.length}`);
  }
  if (String(query.search || "").trim()) {
    values.push(`%${String(query.search).trim().toLowerCase()}%`);
    const searchIndex = values.length;
    clauses.push(`(
      LOWER(COALESCE(th.id, '')) LIKE $${searchIndex}
      OR LOWER(COALESCE(th.slip_no, '')) LIKE $${searchIndex}
      OR LOWER(COALESCE(th.invoice_no, '')) LIKE $${searchIndex}
      OR LOWER(COALESCE(m.first_name, '')) LIKE $${searchIndex}
      OR LOWER(COALESCE(m.last_name, '')) LIKE $${searchIndex}
      OR LOWER(COALESCE(m.member_id, '')) LIKE $${searchIndex}
      OR LOWER(COALESCE(s.first_name, '')) LIKE $${searchIndex}
      OR LOWER(COALESCE(s.last_name, '')) LIKE $${searchIndex}
    )`);
  }
  appendDateFilter(range, transactionDateExpression, values, clauses, true);
  return { values, where: clauses.join(" AND "), range };
}

const getDashboardStats = async (req, res) => {
  try {
    const range = getDateRange(req.query);
    const txValues = [];
    const txClauses = ["1=1"];
    addClubFilter(req, req.query, "th", txValues, txClauses);
    appendDateFilter(range, transactionDateExpression, txValues, txClauses, true);
    const txWhere = txClauses.join(" AND ");

    const memberValues = [];
    const memberClauses = ["1=1"];
    addClubFilter(req, req.query, "m", memberValues, memberClauses);
    appendDateFilter(range, "m.created_date", memberValues, memberClauses);
    const memberWhere = memberClauses.join(" AND ");

    const staffValues = [];
    const staffClauses = ["LOWER(COALESCE(s.status, '')) = 'active'"];
    addClubFilter(req, req.query, "s", staffValues, staffClauses);

    const [totalsResult, membersResult, staffResult, clubsResult, chartResult] = await Promise.all([
      pool.query(`
        SELECT
          COALESCE(SUM(${totalAmountExpression("th")}), 0) AS total_revenue,
          COALESCE(SUM(COALESCE(th.received_amount, 0)), 0) AS total_received,
          COALESCE(SUM(COALESCE(th.balance_amount, 0)), 0) AS total_pending
        FROM transaction_history th
        LEFT JOIN members m ON m.id = th.member_id
        LEFT JOIN staff s ON s.id = th.staff_id
        WHERE ${txWhere}
      `, txValues),
      pool.query(`SELECT COUNT(*)::int AS total_members FROM members m WHERE ${memberWhere}`, memberValues),
      pool.query(`SELECT COUNT(*)::int AS active_staff FROM staff s WHERE ${staffClauses.join(" AND ")}`, staffValues),
      pool.query("SELECT COUNT(*)::int AS total_clubs FROM clubs WHERE status = 'active'"),
      pool.query(`
        SELECT
          (COALESCE(th.amount_taken_date, th.created_date AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Kolkata')::date AS date,
          COALESCE(SUM(${totalAmountExpression("th")}), 0) AS revenue,
          COALESCE(SUM(COALESCE(th.received_amount, 0)), 0) AS received,
          COALESCE(SUM(COALESCE(th.balance_amount, 0)), 0) AS pending
        FROM transaction_history th
        LEFT JOIN members m ON m.id = th.member_id
        LEFT JOIN staff s ON s.id = th.staff_id
        WHERE ${txWhere}
        GROUP BY (COALESCE(th.amount_taken_date, th.created_date AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Kolkata')::date
        ORDER BY date
      `, txValues),
    ]);

    const totals = totalsResult.rows[0];
    res.json({
      success: true,
      data: {
        totalRevenue: Number(totals.total_revenue),
        totalReceived: Number(totals.total_received),
        totalPending: Number(totals.total_pending),
        totalMembers: membersResult.rows[0].total_members,
        activeStaff: staffResult.rows[0].active_staff,
        totalClubs: clubsResult.rows[0].total_clubs,
        chart: chartResult.rows.map((row) => ({
          date: row.date,
          revenue: Number(row.revenue),
          received: Number(row.received),
          pending: Number(row.pending),
        })),
      },
    });
  } catch (error) {
    return reportError(res, error, "getDashboardStats");
  }
};

const getStaffPerformance = async (req, res) => {
  try {
    const range = getDateRange(req.query);
    const { page, limit, offset } = getPagination(req.query);
    const values = [];
    const clauses = ["1=1"];
    addClubFilter(req, req.query, "s", values, clauses);

    if (req.query.status && req.query.status !== "all") {
      values.push(String(req.query.status).toLowerCase());
      clauses.push(`LOWER(COALESCE(s.status, '')) = $${values.length}`);
    }
    if (String(req.query.search || "").trim()) {
      values.push(`%${String(req.query.search).trim().toLowerCase()}%`);
      const searchIndex = values.length;
      clauses.push(`(LOWER(COALESCE(s.first_name, '')) LIKE $${searchIndex} OR LOWER(COALESCE(s.last_name, '')) LIKE $${searchIndex} OR LOWER(COALESCE(s.email, '')) LIKE $${searchIndex} OR LOWER(COALESCE(s.role, '')) LIKE $${searchIndex})`);
    }

    const where = clauses.join(" AND ");
    const countResult = await pool.query(`SELECT COUNT(*)::int AS total FROM staff s WHERE ${where}`, values);
    const resultValues = [...values];
    let memberDate = "";
    let transactionDate = "";
    if (range) {
      resultValues.push(range.startDate, range.endDate);
      const startIndex = resultValues.length - 1;
      const endIndex = resultValues.length;
      memberDate = `AND m.created_date >= $${startIndex}::date AND m.created_date < ($${endIndex}::date + INTERVAL '1 day')`;
      transactionDate = `AND ${transactionDateExpression} >= ($${startIndex}::date::timestamp AT TIME ZONE 'Asia/Kolkata') AND ${transactionDateExpression} < (($${endIndex}::date + INTERVAL '1 day')::timestamp AT TIME ZONE 'Asia/Kolkata')`;
    }
    resultValues.push(limit, offset);
    const limitIndex = resultValues.length - 1;
    const offsetIndex = resultValues.length;
    const result = await pool.query(`
      SELECT
        s.id, s.first_name, s.last_name, s.email, s.role, s.status,
        (SELECT COUNT(*)::int FROM members m WHERE m.staff_id = s.id ${memberDate}) AS onboarded_members,
        (SELECT COUNT(*)::int FROM transaction_history th WHERE th.staff_id = s.id ${transactionDate}) AS transactions_count,
        (SELECT COALESCE(SUM(COALESCE(th.received_amount, 0)), 0) FROM transaction_history th WHERE th.staff_id = s.id ${transactionDate}) AS transaction_value
      FROM staff s
      WHERE ${where}
      ORDER BY transaction_value DESC, s.first_name ASC, s.last_name ASC
      LIMIT $${limitIndex} OFFSET $${offsetIndex}
    `, resultValues);
    const total = countResult.rows[0].total;

    res.json({
      success: true,
      data: result.rows,
      pagination: { total, page, limit, totalPages: Math.ceil(total / limit) },
    });
  } catch (error) {
    return reportError(res, error, "getStaffPerformance");
  }
};

const getStaffOptions = async (req, res) => {
  try {
    const values = [];
    const clauses = ["1=1"];
    addClubFilter(req, req.query, "s", values, clauses);
    const result = await pool.query(`
      SELECT id, first_name, last_name
      FROM staff s
      WHERE ${clauses.join(" AND ")}
      ORDER BY first_name ASC, last_name ASC
    `, values);
    return res.json({ success: true, data: result.rows });
  } catch (error) {
    return reportError(res, error, "getStaffOptions");
  }
};

const getClubPaymentStatus = async (req, res) => {
  try {
    const values = [];
    const clauses = ["1=1"];
    addClubFilter(req, req.query, "c", values, clauses);

    const parsedLimit = Number.parseInt(req.query.limit, 10) || 10;
    const limit = Math.min(Math.max(parsedLimit, 1), 10);
    values.push(limit);

    const result = await pool.query(`
      SELECT
        c.club_id AS "clubId",
        c.title AS "clubName",
        COUNT(th.id) FILTER (WHERE LOWER(COALESCE(th.payment_status, '')) = 'pending')::int AS pending,
        COUNT(th.id) FILTER (WHERE LOWER(COALESCE(th.payment_status, '')) = 'partial')::int AS partial,
        COUNT(th.id) FILTER (WHERE LOWER(COALESCE(th.payment_status, '')) = 'completed')::int AS completed
      FROM clubs c
      LEFT JOIN transaction_history th ON th.club_id = c.club_id
      WHERE ${clauses.join(" AND ")}
      GROUP BY c.club_id, c.title
      ORDER BY c.title ASC, c.club_id ASC
      LIMIT $${values.length}
    `, values);

    return res.json({
      success: true,
      data: result.rows.map((row) => ({
        ...row,
        pending: Number(row.pending),
        partial: Number(row.partial),
        completed: Number(row.completed),
      })),
    });
  } catch (error) {
    return reportError(res, error, "getClubPaymentStatus");
  }
};

async function queryTransactionRecords(req, query, { paginate = true } = {}) {
  const { values, where } = buildTransactionFilters(req, query);
  const sortOrder = String(query.sort).toLowerCase() === "asc" ? "ASC" : "DESC";
  const joins = `
    FROM transaction_history th
    LEFT JOIN members m ON th.member_id = m.id
    LEFT JOIN staff s ON th.staff_id = s.id
    WHERE ${where}
  `;
  const columns = `
    th.id, th.slip_no, th.invoice_no, th.created_date, th.amount_taken_date,
    th.types, th.payment_status, th.payment_method, th.debit_amount,
    th.received_amount, th.balance_amount, th.total_amount_with_gst,
    th.remarks, th.club_id,
    m.first_name AS member_first_name, m.last_name AS member_last_name,
    m.member_id AS member_number, m.email AS member_email, m.phone AS member_phone,
    s.first_name AS staff_first_name, s.last_name AS staff_last_name
  `;

  if (!paginate) {
    const result = await pool.query(`SELECT ${columns} ${joins} ORDER BY ${transactionDateExpression} ${sortOrder}`, values);
    return { rows: result.rows };
  }

  const { page, limit, offset } = getPagination(query);
  const countResult = await pool.query(`SELECT COUNT(*)::int AS total ${joins}`, values);
  const queryValues = [...values, limit, offset];
  const result = await pool.query(`
    SELECT ${columns} ${joins}
    ORDER BY ${transactionDateExpression} ${sortOrder}
    LIMIT $${queryValues.length - 1} OFFSET $${queryValues.length}
  `, queryValues);
  const total = countResult.rows[0].total;
  return {
    rows: result.rows,
    pagination: { total, page, limit, totalPages: Math.ceil(total / limit) },
  };
}

const getTransactionRecords = async (req, res) => {
  try {
    const result = await queryTransactionRecords(req, req.query);
    return res.json({ success: true, data: result.rows, pagination: result.pagination });
  } catch (error) {
    return reportError(res, error, "getTransactionRecords");
  }
};

const transactionExportHeaders = [
  "Date", "Transaction", "Receipt", "Invoice", "Member", "Member Number",
  "Type", "Processed By", "Payment Method", "Revenue", "Received", "Pending",
  "Status", "Remarks",
];

function transactionExportRows(rows) {
  return rows.map((row) => ({
    Date: row.amount_taken_date || row.created_date,
    Transaction: row.id,
    Receipt: row.slip_no || "",
    Invoice: row.invoice_no || "",
    Member: `${row.member_first_name || ""} ${row.member_last_name || ""}`.trim(),
    "Member Number": row.member_number || "",
    Type: row.types || "",
    "Processed By": `${row.staff_first_name || ""} ${row.staff_last_name || ""}`.trim(),
    "Payment Method": row.payment_method || "",
    Revenue: Number(row.total_amount_with_gst || row.debit_amount || 0),
    Received: Number(row.received_amount || 0),
    Pending: Number(row.balance_amount || 0),
    Status: row.payment_status || "",
    Remarks: row.remarks || "",
  }));
}

function csvValue(value) {
  let text = String(value ?? "");
  if (typeof value === "string" && /^[=+@\-]/.test(text.trimStart())) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

async function exportExcel(res, rows) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Transactions", { views: [{ state: "frozen", ySplit: 1 }] });
  const columns = transactionExportHeaders;
  sheet.columns = columns.map((header) => ({ header, key: header, width: Math.min(Math.max(header.length + 3, 14), 28) }));
  sheet.addRows(rows);
  sheet.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
  sheet.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF5B3DF5" } };
  const buffer = await workbook.xlsx.writeBuffer();
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", 'attachment; filename="financial-transactions.xlsx"');
  return res.send(Buffer.from(buffer));
}

function exportPdf(res, rows) {
  const document = new PDFDocument({ size: "A4", layout: "landscape", margin: 28 });
  const chunks = [];
  document.on("data", (chunk) => chunks.push(chunk));
  document.on("end", () => {
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", 'attachment; filename="financial-transactions.pdf"');
    res.send(Buffer.concat(chunks));
  });
  document.fontSize(16).text("Financial Reports & Audit Ledger");
  document.moveDown(0.4).fontSize(7).fillColor("#475569");
  const headers = ["Date", "Transaction", "Receipt", "Member", "Type", "Staff", "Revenue", "Received", "Pending", "Status"];
  const widths = [58, 70, 55, 94, 50, 82, 62, 62, 62, 54];
  const drawHeader = () => {
    document.font("Helvetica-Bold").fillColor("#334155");
    const headerY = document.y;
    let x = document.page.margins.left;
    headers.forEach((header, index) => {
      document.text(header, x, headerY, { width: widths[index], lineBreak: false });
      x += widths[index];
    });
    document.y = headerY + 12;
    document.moveTo(document.page.margins.left, document.y).lineTo(814, document.y).strokeColor("#cbd5e1").stroke();
    document.y += 5;
    document.font("Helvetica").fillColor("#0f172a");
  };
  drawHeader();
  rows.forEach((row) => {
    if (document.y > 545) {
      document.addPage();
      drawHeader();
    }
    const cells = [row.Date, row.Transaction, row.Receipt, row.Member, row.Type, row["Processed By"], row.Revenue, row.Received, row.Pending, row.Status];
    const rowY = document.y;
    let x = document.page.margins.left;
    cells.forEach((cell, index) => {
      const text = String(cell ?? "").slice(0, index === 3 || index === 5 ? 20 : 15);
      document.text(text, x, rowY, { width: widths[index], lineBreak: false });
      x += widths[index];
    });
    document.y = rowY + 12;
  });
  document.end();
}

const exportTransactionRecords = async (req, res) => {
  try {
    const format = String(req.query.format || "csv").toLowerCase();
    if (!["csv", "xlsx", "pdf"].includes(format)) {
      return res.status(400).json({ success: false, message: "Choose CSV, Excel, or PDF export." });
    }
    const { rows: records } = await queryTransactionRecords(req, req.query, { paginate: false });
    const rows = transactionExportRows(records);
    if (format === "xlsx") return await exportExcel(res, rows);
    if (format === "pdf") return exportPdf(res, rows);

    const headers = transactionExportHeaders;
    const csv = [headers.map(csvValue).join(","), ...rows.map((row) => headers.map((header) => csvValue(row[header])).join(","))].join("\r\n");
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", 'attachment; filename="financial-transactions.csv"');
    return res.send(`\uFEFF${csv}`);
  } catch (error) {
    return reportError(res, error, "exportTransactionRecords");
  }
};

module.exports = {
  getDashboardStats,
  getStaffPerformance,
  getStaffOptions,
  getClubPaymentStatus,
  getTransactionRecords,
  exportTransactionRecords,
};

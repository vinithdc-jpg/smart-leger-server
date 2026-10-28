const bcrypt = require("bcryptjs");
const pool = require("../config/db");

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function getPagination(query) {
  const page = Math.max(Number.parseInt(query.page, 10) || 1, 1);
  const limit = Math.min(
    Math.max(Number.parseInt(query.limit, 10) || 10, 1),
    100,
  );
  return { page, limit, offset: (page - 1) * limit };
}

function formatStaff(row) {
  if (!row) return null;
  return {
    id: row.id,
    firstName: row.first_name,
    lastName: row.last_name,
    first_name: row.first_name,
    last_name: row.last_name,
    email: row.email,
    role: row.role,
    status: row.status,
    clubId: row.club_id,
    club_id: row.club_id,
    createdAt: row.created_at,
    created_at: row.created_at,
    updatedAt: row.updated_at,
    updated_at: row.updated_at,
  };
}

// CREATE STAFF
// POST /api/staff/createstaff

const createStaff = async (req, res) => {
  try {
    const firstName = req.body.firstName || req.body.first_name;
    const lastName = req.body.lastName || req.body.last_name;
    const email = req.body.email;
    const password = req.body.password;
    const role = req.body.role || "staff";
    const status = req.body.status || "active";
    const clubId = req.body.clubId || req.body.club_id;

    // Validate required fields

    if (!firstName || !lastName || !email || !password || !clubId) {
      return res.status(400).json({
        success: false,
        message: "firstName, lastName, email, password and clubId are required",
      });
    }

    const normalizedEmail = String(email).trim().toLowerCase();
    if (!emailPattern.test(normalizedEmail)) {
      return res.status(400).json({
        success: false,
        message: "A valid email is required, such as example@example.com",
      });
    }

    // Check club exists

    const clubResult = await pool.query(
      `
      SELECT club_id
      FROM clubs
      WHERE club_id = $1
      `,
      [clubId],
    );

    if (clubResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Club not found",
      });
    }

    // Check duplicate email

    const existingStaff = await pool.query(
      `
      SELECT id
      FROM staff
      WHERE club_id = $1
        AND LOWER(email) = LOWER($2)
      `,
      [clubId, normalizedEmail],
    );

    if (existingStaff.rows.length > 0) {
      return res.status(409).json({
        success: false,
        message: "Staff with this email already exists in this club",
      });
    }

    // Hash password

    const hashedPassword = await bcrypt.hash(password, 10);

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(73149201)");
      const idResult = await client.query(
        `SELECT COALESCE(MAX(substring(id FROM '^staff_([0-9]+)$')::bigint), 0) + 1 AS next_number
         FROM staff`,
      );
      const nextNumber = Number(idResult.rows[0].next_number);
      const staffId = `staff_${String(nextNumber).padStart(3, "0")}`;

      const result = await client.query(
        `
      INSERT INTO staff (
        id,
        first_name,
        last_name,
        email,
        password,
        role,
        status,
        club_id,
        created_at,
        updated_at
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
        NOW(),
        NOW()
      )
      RETURNING
        id,
        first_name,
        last_name,
        email,
        role,
        status,
        club_id,
        created_at,
        updated_at
      `,
        [
          staffId,
          firstName.trim(),
          lastName.trim(),
          normalizedEmail,
          hashedPassword,
          role,
          status,
          clubId,
        ],
      );

      await client.query("COMMIT");

      return res.status(201).json({
        success: true,
        message: "Staff created successfully",
        staff: formatStaff(result.rows[0]),
      });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    console.error("Create staff error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to create staff",
    });
  }
};

// GET ALL STAFF
// GET /api/staff/getAllStaff

const getAllStaff = async (req, res) => {
  try {
    const clubId = req.query.clubId || req.query.club_id;
    const search = String(req.query.search || "").trim();
    const { page, limit, offset } = getPagination(req.query);

    let queryText = `
      SELECT
        id,
        first_name,
        last_name,
        email,
        role,
        status,
        club_id,
        created_at,
        updated_at
      FROM staff
    `;
    const values = [];

    const filters = [];
    if (clubId) {
      values.push(clubId);
      filters.push(`s.club_id = $${values.length}`);
    }
    if (search) {
      values.push(`%${search}%`);
      filters.push(`s.club_id IN (
        SELECT c.club_id
        FROM clubs c
        WHERE c.club_id ILIKE $${values.length} OR c.title ILIKE $${values.length}
      )`);
    }
    queryText = queryText.replace("FROM staff", "FROM staff s");
    queryText += filters.length ? ` WHERE ${filters.join(" AND ")}` : "";

    const countResult = await pool.query(
      `SELECT COUNT(*)::int AS count FROM staff s${filters.length ? ` WHERE ${filters.join(" AND ")}` : ""}`,
      values.slice(0, values.length),
    );
    values.push(limit, offset);
    queryText += ` ORDER BY created_at DESC LIMIT $${values.length - 1} OFFSET $${values.length}`;

    const result = await pool.query(queryText, values);

    return res.status(200).json({
      success: true,
      count: countResult.rows[0].count,
      page,
      limit,
      totalPages: Math.ceil(countResult.rows[0].count / limit),
      staff: result.rows.map(formatStaff),
    });
  } catch (error) {
    console.error("Get all staff error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to fetch staff",
    });
  }
};

// GET STAFF BY ID
// GET /api/staff/:staffId

const getStaffById = async (req, res) => {
  try {
    const { staffId } = req.params;
    const clubId = req.query.clubId || req.query.club_id;

    if (!staffId) {
      return res.status(400).json({
        success: false,
        message: "Staff ID is required",
      });
    }

    let queryText = `
      SELECT
        id,
        first_name,
        last_name,
        email,
        role,
        status,
        club_id,
        created_at,
        updated_at
      FROM staff
      WHERE id = $1
    `;
    const values = [staffId];

    if (clubId) {
      values.push(clubId);
      queryText += ` AND club_id = $2`;
    }

    const result = await pool.query(queryText, values);

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Staff not found",
      });
    }

    return res.status(200).json({
      success: true,
      message: "Staff fetched successfully",
      staff: formatStaff(result.rows[0]),
    });
  } catch (error) {
    console.error("Get staff by ID error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to fetch staff",
    });
  }
};

// UPDATE STAFF
// PATCH /api/staff/:staffId

const updateStaff = async (req, res) => {
  try {
    const { staffId } = req.params;
    const firstName =
      req.body.firstName !== undefined
        ? req.body.firstName
        : req.body.first_name;
    const lastName =
      req.body.lastName !== undefined ? req.body.lastName : req.body.last_name;
    const { email, password, role, status } = req.body;
    const clubId =
      req.body.clubId ||
      req.body.club_id ||
      req.query.clubId ||
      req.query.club_id;

    // Check staff exists

    let checkQuery = `SELECT id, club_id FROM staff WHERE id = $1`;
    const checkValues = [staffId];
    if (clubId) {
      checkValues.push(clubId);
      checkQuery += ` AND club_id = $2`;
    }

    const existingStaff = await pool.query(checkQuery, checkValues);

    if (existingStaff.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Staff not found",
      });
    }

    const targetClubId = existingStaff.rows[0].club_id;

    let normalizedEmail;
    if (email !== undefined && email !== null) {
      normalizedEmail = String(email).trim().toLowerCase();
      if (!emailPattern.test(normalizedEmail)) {
        return res.status(400).json({
          success: false,
          message: "A valid email is required, such as example@example.com",
        });
      }
    }

    // Check duplicate email

    if (email !== undefined && email !== null) {
      const emailCheck = await pool.query(
        `
        SELECT id
        FROM staff
        WHERE club_id = $1
          AND LOWER(email) = LOWER($2)
          AND id <> $3
        `,
        [targetClubId, normalizedEmail, staffId],
      );

      if (emailCheck.rows.length > 0) {
        return res.status(409).json({
          success: false,
          message: "Another staff member already uses this email",
        });
      }
    }

    // Build update query dynamically

    const fields = [];
    const values = [];
    let parameterIndex = 1;

    if (firstName !== undefined) {
      fields.push(`first_name = $${parameterIndex}`);
      values.push(firstName);
      parameterIndex++;
    }

    if (lastName !== undefined) {
      fields.push(`last_name = $${parameterIndex}`);
      values.push(lastName);
      parameterIndex++;
    }

    if (email !== undefined) {
      fields.push(`email = $${parameterIndex}`);
      values.push(normalizedEmail);
      parameterIndex++;
    }

    if (password !== undefined && password !== "") {
      const hashedPassword = await bcrypt.hash(password, 10);
      fields.push(`password = $${parameterIndex}`);
      values.push(hashedPassword);
      parameterIndex++;
    }

    if (role !== undefined) {
      fields.push(`role = $${parameterIndex}`);
      values.push(role);
      parameterIndex++;
    }

    if (status !== undefined) {
      fields.push(`status = $${parameterIndex}`);
      values.push(status);
      parameterIndex++;
    }

    if (fields.length === 0) {
      return res.status(400).json({
        success: false,
        message: "No fields provided for update",
      });
    }

    fields.push(`updated_at = NOW()`);

    values.push(staffId);
    const staffIdParamIndex = parameterIndex;

    const result = await pool.query(
      `
      UPDATE staff
      SET ${fields.join(", ")}
      WHERE id = $${staffIdParamIndex}
      RETURNING
        id,
        first_name,
        last_name,
        email,
        role,
        status,
        club_id,
        created_at,
        updated_at
      `,
      values,
    );

    return res.status(200).json({
      success: true,
      message: "Staff updated successfully",
      staff: formatStaff(result.rows[0]),
    });
  } catch (error) {
    console.error("Update staff error:", error);

    if (error.code === "23505") {
      return res.status(409).json({
        success: false,
        message: "Another staff member already uses this email",
      });
    }

    return res.status(500).json({
      success: false,
      message: "Failed to update staff",
    });
  }
};

// DELETE STAFF
// DELETE /api/staff/:staffId

const deleteStaff = async (req, res) => {
  try {
    const { staffId } = req.params;
    const clubId =
      req.query.clubId ||
      req.query.club_id ||
      req.body?.clubId ||
      req.body?.club_id;

    let queryText = `
      DELETE FROM staff
      WHERE id = $1
    `;
    const values = [staffId];

    if (clubId) {
      values.push(clubId);
      queryText += ` AND club_id = $2`;
    }

    queryText += `
      RETURNING
        id,
        first_name,
        last_name,
        email,
        role,
        status,
        club_id,
        created_at,
        updated_at
    `;

    const result = await pool.query(queryText, values);

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Staff not found",
      });
    }

    return res.status(200).json({
      success: true,
      message: "Staff deleted successfully",
      staff: formatStaff(result.rows[0]),
    });
  } catch (error) {
    console.error("Delete staff error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to delete staff",
    });
  }
};

module.exports = {
  createStaff,
  getAllStaff,
  getStaffById,
  updateStaff,
  deleteStaff,
};

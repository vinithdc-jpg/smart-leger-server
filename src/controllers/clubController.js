const pool = require("../config/db");

function getPagination(query) {
  const page = Math.max(Number.parseInt(query.page, 10) || 1, 1);
  const limit = Math.min(
    Math.max(Number.parseInt(query.limit, 10) || 10, 1),
    100,
  );
  return { page, limit, offset: (page - 1) * limit };
}

function formatClub(row) {
  if (!row) return null;
  return {
    id: row.id,
    club_id: row.club_id,
    clubId: row.club_id,
    title: row.title,
    phone: row.phone,
    status: row.status,
    created_at: row.created_at,
    createdAt: row.created_at,
    updated_at: row.updated_at,
    updatedAt: row.updated_at,
    staff_count:
      row.staff_count !== undefined ? Number(row.staff_count) : undefined,
    member_count:
      row.member_count !== undefined ? Number(row.member_count) : undefined,
  };
}

// CREATE CLUB
// POST /api/club/createclub

const createClub = async (req, res) => {
  try {
    const {
      club_id,
      clubId: altClubId,
      title,
      phone,
      status = "active",
    } = req.body;
    const rawClubId = club_id || altClubId;

    // 1. Validate input
    if (!rawClubId || !title) {
      return res.status(400).json({
        success: false,
        message: "club_id and title are required",
      });
    }

    // 2. Clean input
    const clubId = String(rawClubId).trim();
    const clubTitle = String(title).trim();
    const clubPhone =
      phone !== undefined && phone !== null ? String(phone).trim() : null;
    const clubStatus = status || "active";

    // 3. Check duplicate club_id
    const existingClub = await pool.query(
      `
      SELECT id, club_id, title
      FROM clubs
      WHERE club_id = $1
      `,
      [clubId],
    );

    if (existingClub.rows.length > 0) {
      return res.status(409).json({
        success: false,
        message: "Club ID already exists",
        existingClub: formatClub(existingClub.rows[0]),
      });
    }

    // 4. INSERT new club
    const result = await pool.query(
      `
      INSERT INTO clubs (
        club_id,
        title,
        phone,
        status,
        created_at,
        updated_at
      )
      VALUES ($1, $2, $3, $4, NOW(), NOW())
      RETURNING
        id,
        club_id,
        title,
        phone,
        status,
        created_at,
        updated_at
      `,
      [clubId, clubTitle, clubPhone, clubStatus],
    );

    if (result.rows.length === 0) {
      return res.status(500).json({
        success: false,
        message: "Club was not inserted",
      });
    }

    return res.status(201).json({
      success: true,
      message: "Club created successfully",
      club: formatClub(result.rows[0]),
    });
  } catch (error) {
    if (error.code === "23505") {
      return res.status(409).json({
        success: false,
        message: "Club ID already exists",
      });
    }

    console.error("Create club error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to create club",
      error: process.env.NODE_ENV === "development" ? error.message : undefined,
    });
  }
};

// GET ALL CLUBS
// GET /api/club/getclub

const getClubs = async (req, res) => {
  try {
    const { page, limit, offset } = getPagination(req.query);
    const countResult = await pool.query(
      `SELECT COUNT(*)::int AS count FROM clubs`,
    );
    const result = await pool.query(
      `
      SELECT
        c.id,
        c.club_id,
        c.title,
        c.phone,
        c.status,
        c.created_at,
        c.updated_at,
        COUNT(DISTINCT s.id)::int AS staff_count,
        COUNT(DISTINCT m.id)::int AS member_count
      FROM clubs c
      LEFT JOIN staff s
        ON s.club_id = c.club_id
      LEFT JOIN members m
        ON m.club_id = c.club_id
      GROUP BY
        c.id,
        c.club_id,
        c.title,
        c.phone,
        c.status,
        c.created_at,
        c.updated_at
      ORDER BY c.created_at DESC
      LIMIT $1 OFFSET $2
      `,
      [limit, offset],
    );
    const count = countResult.rows[0].count;

    return res.status(200).json({
      success: true,
      count,
      page,
      limit,
      totalPages: Math.ceil(count / limit),
      clubs: result.rows.map(formatClub),
    });
  } catch (error) {
    console.error("Get clubs error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to get clubs",
    });
  }
};

// GET SINGLE CLUB
// GET /api/club/:clubId

const getClub = async (req, res) => {
  try {
    const { clubId } = req.params;

    const result = await pool.query(
      `
      SELECT
        id,
        club_id,
        title,
        phone,
        status,
        created_at,
        updated_at
      FROM clubs
      WHERE club_id = $1
      `,
      [clubId],
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Club not found",
      });
    }

    return res.status(200).json({
      success: true,
      club: formatClub(result.rows[0]),
    });
  } catch (error) {
    console.error("Get club error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to get club",
    });
  }
};

// UPDATE CLUB
// PATCH /api/club/:clubId

const updateClub = async (req, res) => {
  try {
    const { clubId } = req.params;
    const { title, phone, status } = req.body;

    const fields = [];
    const values = [];
    let parameterIndex = 1;

    if (title !== undefined) {
      fields.push(`title = $${parameterIndex}`);
      values.push(title);
      parameterIndex++;
    }

    if (phone !== undefined) {
      fields.push(`phone = $${parameterIndex}`);
      values.push(phone);
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
    values.push(clubId);

    const result = await pool.query(
      `
      UPDATE clubs
      SET ${fields.join(", ")}
      WHERE club_id = $${parameterIndex}
      RETURNING
        id,
        club_id,
        title,
        phone,
        status,
        created_at,
        updated_at
      `,
      values,
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Club not found",
      });
    }

    return res.status(200).json({
      success: true,
      message: "Club updated successfully",
      club: formatClub(result.rows[0]),
    });
  } catch (error) {
    console.error("Update club error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to update club",
    });
  }
};

// DELETE / DEACTIVATE CLUB
// DELETE /api/club/:clubId

const deleteClub = async (req, res) => {
  try {
    const { clubId } = req.params;

    const result = await pool.query(
      `
      UPDATE clubs
      SET
        status = 'inactive',
        updated_at = NOW()
      WHERE club_id = $1
      RETURNING
        id,
        club_id,
        title,
        status,
        created_at,
        updated_at
      `,
      [clubId],
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Club not found",
      });
    }

    return res.status(200).json({
      success: true,
      message: "Club deactivated successfully",
      club: formatClub(result.rows[0]),
    });
  } catch (error) {
    console.error("Delete club error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to deactivate club",
    });
  }
};

const getClubStatistics = async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        (SELECT COUNT(*) FROM clubs) AS total_clubs,
        (SELECT COUNT(*) FROM clubs WHERE status = 'active') AS active_clubs,
        (SELECT COUNT(*) FROM clubs WHERE status = 'inactive') AS inactive_clubs,
        (SELECT COUNT(*) FROM staff) AS total_staff
    `);

    const data = result.rows[0];

    res.json({
      success: true,
      data: {
        totalClubs: Number(data.total_clubs),
        activeClubs: Number(data.active_clubs),
        inactiveClubs: Number(data.inactive_clubs),
        totalStaff: Number(data.total_staff),
      },
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      success: false,
      message: "Failed to get club statistics",
      error: error.message,
    });
  }
};

module.exports = {
  createClub,
  getClubs,
  getClub,
  updateClub,
  deleteClub,
  getClubStatistics,
};

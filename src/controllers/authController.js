const pool = require('../config/db');
const bcrypt = require("bcryptjs");
const generateToken = require('../utils/generatetoken');

// LOGIN
const login = async (req, res) => {
  try {
    const { clubId, email, password } = req.body;

    // Validate input

    if (!clubId || !email || !password) {
      return res.status(400).json({
        success: false,
        message: "Club ID, email and password are required",
      });
    }

    // Find club

    const clubResult = await pool.query(
      `
      SELECT
        id,
        club_id,
        title,
        phone,
        status
      FROM clubs
      WHERE club_id = $1
      `,
      [clubId],
    );

    //When club id was not find

    if (clubResult.rows.length === 0) {
      return res.status(401).json({
        success: false,
        message: "Invalid club ID",
      });
    }

    const club = clubResult.rows[0];

    // Check club status

    if (club.status !== "active") {
      return res.status(403).json({
        success: false,
        message: "This club is inactive",
      });
    }

    // Find staff

    const staffResult = await pool.query(
      `
      SELECT
        id,
        first_name,
        last_name,
        email,
        password,
        role,
        status,
        club_id
      FROM staff
      WHERE club_id = $1
      AND email = $2
      `,
      [club.club_id, email],
    );

    //When Staff row was not find

    if (staffResult.rows.length === 0) {
      return res.status(401).json({
        success: false,
        message: "Invalid email or password",
      });
    }

    const staff = staffResult.rows[0];

    // Check staff status

    if (staff.status !== "active") {
      return res.status(403).json({
        success: false,
        message: "Staff account is inactive",
      });
    }

    // Compare password

    const passwordMatch = await bcrypt.compare(password, staff.password);

    if (!passwordMatch) {
      return res.status(401).json({
        success: false,
        message: "Invalid email or password",
      });
    }

    // Generate JWT

    const token = generateToken(staff);

    // Store JWT in HTTP-only cookie

    res.cookie("token", token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: 24 * 60 * 60 * 1000,
      path: "/",
    });

    // Response

    return res.status(200).json({
      success: true,
      message: "Login successful",

      staff: {
        id: staff.id,
        firstName: staff.first_name,
        lastName: staff.last_name,
        email: staff.email,
        role: staff.role,
        status: staff.status,
      },

      club: {
        clubId: club.club_id,
        title: club.title,
        phone: club.phone,
        status: club.status,
      },
    });
  } catch (error) {
    console.error("Login error:", error);

    return res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
};

// LOGOUT
const logout = async (req, res) => {
  try {
    res.clearCookie("token", {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
    });

    return res.status(200).json({
      success: true,
      message: "Logged out successfully",
    });
  } catch (error) {
    console.error("Logout error:", error);

    return res.status(500).json({
      success: false,
      message: "Logout failed",
    });
  }
};

// GET CURRENT USER
const getMe = async (req, res) => {
  try {
    const { staffId, clubId } = req.user;

    const result = await pool.query(
      `
      SELECT
        s.id,
        s.first_name,
        s.last_name,
        s.email,
        s.role,
        s.status,
        s.club_id,

        c.title AS club_title,
        c.phone AS club_phone,
        c.status AS club_status

      FROM staff s

      INNER JOIN clubs c
        ON s.club_id = c.club_id

      WHERE s.id = $1
      AND s.club_id = $2
      `,
      [staffId, clubId],
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Staff account not found",
      });
    }

    const user = result.rows[0];

    return res.status(200).json({
      success: true,

      staff: {
        id: user.id,
        firstName: user.first_name,
        lastName: user.last_name,
        email: user.email,
        role: user.role,
        status: user.status,
      },

      club: {
        clubId: user.club_id,
        title: user.club_title,
        phone: user.club_phone,
        status: user.club_status,
      },
    });
  } catch (error) {
    console.error("Get user error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to get user",
    });
  }
};

module.exports = {
  login,
  logout,
  getMe,
};

const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const pool = require("../config/db");

// SUPER ADMIN LOGIN
// POST /api/AdminAuth/adminLogin

const superAdminLogin = async (req, res) => {
  try {
    const { email, password } = req.body;

    // Validate input
    if (!email || !password) {
      return res.status(400).json({
        success: false,
        message: "Email and password are required",
      });
    }

    // Find super admin (case-insensitive email)
    const result = await pool.query(
      `
      SELECT id, email, password, name
      FROM super_admins
      WHERE LOWER(email) = LOWER($1)
      `,
      [String(email).trim()],
    );

    // Admin not found
    if (result.rows.length === 0) {
      return res.status(401).json({
        success: false,
        message: "Invalid email or password",
      });
    }

    const admin = result.rows[0];

    // Compare password with hashed password
    const passwordMatch = await bcrypt.compare(String(password), admin.password);

    if (!passwordMatch) {
      return res.status(401).json({
        success: false,
        message: "Invalid email or password",
      });
    }

    // Generate JWT
    const token = jwt.sign(
      {
        userId: admin.id,
        email: admin.email,
        role: "super_admin",
      },
      process.env.JWT_SECRET,
      {
        expiresIn: "1d",
      },
    );

    // Store in admin_token cookie (separate from staff token cookie)
    res.cookie("admin_token", token, {
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
      admin: {
        id: admin.id,
        email: admin.email,
        name: admin.name,
        role: "super_admin",
      },
    });
  } catch (error) {
    console.error("Super admin login error:", error);

    return res.status(500).json({
      success: false,
      message: "Login failed",
    });
  }
};

// GET ADMIN ME (verify session)
// GET /api/AdminAuth/adminMe

const adminGetMe = async (req, res) => {
  try {
    const { userId } = req.user;

    const result = await pool.query(
      `
      SELECT id, email, name
      FROM super_admins
      WHERE id = $1
      `,
      [userId],
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Admin account not found",
      });
    }

    const admin = result.rows[0];

    return res.status(200).json({
      success: true,
      admin: {
        id: admin.id,
        email: admin.email,
        name: admin.name,
        role: "super_admin",
      },
    });
  } catch (error) {
    console.error("Admin get me error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to get admin",
    });
  }
};

// ADMIN LOGOUT
// POST /api/AdminAuth/adminLogout

const adminLogout = async (req, res) => {
  try {
    res.clearCookie("admin_token", {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
    });

    return res.status(200).json({
      success: true,
      message: "Admin logged out successfully",
    });
  } catch (error) {
    console.error("Admin logout error:", error);

    return res.status(500).json({
      success: false,
      message: "Logout failed",
    });
  }
};

module.exports = {
  superAdminLogin,
  adminGetMe,
  adminLogout,
};

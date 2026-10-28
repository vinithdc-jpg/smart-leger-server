const jwt = require("jsonwebtoken");

// REQUIRE ADMIN MIDDLEWARE
// Validates admin_token cookie (or Bearer header)
// and ensures role === "super_admin"

const requireAdmin = (req, res, next) => {
  try {
    let token = null;

    // 1. Check Authorization header
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith("Bearer ")) {
      token = authHeader.substring(7).trim();
    }

    // 2. Fall back to admin_token cookie (separate from staff token)
    if (!token && req.cookies?.admin_token) {
      token = req.cookies.admin_token;
    }

    // 3. Token not found
    if (!token) {
      return res.status(401).json({
        success: false,
        message: "Admin authentication required. Token not found.",
      });
    }

    // 4. Check JWT secret
    if (!process.env.JWT_SECRET) {
      console.error("JWT_SECRET is not configured");
      return res.status(500).json({
        success: false,
        message: "Server authentication configuration error",
      });
    }

    // 5. Verify token
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // 6. Check admin role
    if (decoded.role !== "super_admin") {
      return res.status(403).json({
        success: false,
        message: "Access denied. Admin privileges required.",
      });
    }

    req.user = decoded;
    next();
  } catch (error) {
    console.error("Admin authentication error:", error.message);

    if (error.name === "TokenExpiredError") {
      return res.status(401).json({
        success: false,
        message: "Admin token has expired. Please login again.",
      });
    }

    if (error.name === "JsonWebTokenError") {
      return res.status(401).json({
        success: false,
        message: "Invalid admin token.",
      });
    }

    return res.status(401).json({
      success: false,
      message: "Admin authentication failed.",
    });
  }
};

module.exports = requireAdmin;

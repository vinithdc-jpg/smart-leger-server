const pool = require("../config/db");

// Ensure system_settings table exists
const ensureSettingsTable = async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS system_settings (
        key VARCHAR(100) PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
  } catch (err) {
    console.error("Error creating system_settings table:", err);
  }
};

ensureSettingsTable();

// Get active GST rate
const getGstRate = async (req, res) => {
  try {
    await ensureSettingsTable();
    const result = await pool.query(
      `SELECT value FROM system_settings WHERE key = 'gst_rate'`,
    );

    const gstRate = result.rows.length > 0 ? Number(result.rows[0].value) : 18;

    return res.status(200).json({
      success: true,
      gstRate,
    });
  } catch (error) {
    console.error("Get GST rate error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch GST rate",
      gstRate: 18,
    });
  }
};

// Update active GST rate (Super Admin only)
const updateGstRate = async (req, res) => {
  try {
    const { gstRate } = req.body;

    if (gstRate === undefined || gstRate === null || gstRate === "") {
      return res.status(400).json({
        success: false,
        message: "gstRate is required",
      });
    }

    const parsedRate = Number(gstRate);
    if (!Number.isFinite(parsedRate) || parsedRate < 0 || parsedRate > 100) {
      return res.status(400).json({
        success: false,
        message: "gstRate must be a valid number between 0 and 100",
      });
    }

    await ensureSettingsTable();

    const result = await pool.query(
      `
      INSERT INTO system_settings (key, value, updated_at)
      VALUES ('gst_rate', $1, NOW())
      ON CONFLICT (key)
      DO UPDATE SET
        value = EXCLUDED.value,
        updated_at = NOW()
      RETURNING key, value, updated_at;
      `,
      [String(parsedRate)],
    );

    return res.status(200).json({
      success: true,
      message: "GST rate updated successfully",
      gstRate: Number(result.rows[0].value),
    });
  } catch (error) {
    console.error("Update GST rate error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to update GST rate",
    });
  }
};

// Utility to get current GST rate internally
const getCurrentGstRate = async () => {
  try {
    await ensureSettingsTable();
    const result = await pool.query(
      `SELECT value FROM system_settings WHERE key = 'gst_rate'`,
    );
    if (result.rows.length > 0) {
      const parsed = Number(result.rows[0].value);
      if (Number.isFinite(parsed)) return parsed;
    }
    return 18;
  } catch {
    return 18;
  }
};

module.exports = {
  getGstRate,
  updateGstRate,
  getCurrentGstRate,
};

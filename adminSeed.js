require('dotenv').config();

const bcrypt = require('bcryptjs');
const pool = require("./src/config/db");

const createSuperAdmin = async () => {
  try {
    const email = "admin@smartledger.com";
    const password = "Admin@123";

    await pool.query(`
      CREATE TABLE IF NOT EXISTS super_admins (
        id SERIAL PRIMARY KEY,
        email VARCHAR(255) UNIQUE NOT NULL,
        password VARCHAR(255) NOT NULL,
        name VARCHAR(255) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await pool.query(`
      ALTER TABLE super_admins
      ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;
    `);

    const hashedPassword = await bcrypt.hash(password, 10);

    await pool.query(
      `
      INSERT INTO super_admins (
        email,
        password,
        name
      )
      VALUES ($1, $2, $3)
      ON CONFLICT (email)
      DO UPDATE SET
        password = EXCLUDED.password,
        updated_at = NOW()
      `,
      [email, hashedPassword, "Super Admin"],
    );

    console.log("Super Admin seeded successfully:", email);
    process.exit(0);
  } catch (error) {
    console.error("Super Admin seed error:", error);
    process.exit(1);
  }
};

createSuperAdmin();

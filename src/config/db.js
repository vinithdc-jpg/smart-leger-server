// const { Pool } = require("pg");
// require("dotenv").config();

// const pool = new Pool({
//   connectionString: process.env.DATABASE_URL,
// });

// pool.on("connect", () => {
//   console.log("PostgreSQL connected");
// });

// pool.on("error", (error) => {
//   console.error("Unexpected PostgreSQL error:", error);
// });

// module.exports = pool;

const { Pool } = require("pg");

const databaseSslEnabled =
  process.env.DATABASE_SSL === "true" ||
  (process.env.DATABASE_SSL !== "false" &&
    (process.env.NODE_ENV === "production" || Boolean(process.env.DATABASE_SSL_CA)));

const databaseSsl = databaseSslEnabled
  ? {
      rejectUnauthorized: true,
    }
  : false;

if (databaseSsl && process.env.DATABASE_SSL_CA) {
  databaseSsl.ca = process.env.DATABASE_SSL_CA.replace(/\\n/g, "\n");
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  keepAlive: true,
  keepAliveInitialDelayMillis: 10000,
  connectionTimeoutMillis: 10000,
  ssl: databaseSsl,
});

pool.on("connect", () => {
  console.log("Supabase PostgreSQL connected");
});

pool.on("error", (err) => {
  console.error("Unexpected database error:", err);
});

module.exports = pool;

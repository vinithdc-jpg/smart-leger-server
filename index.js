const express = require("express");
const cors = require("cors");
const cookieParser = require("cookie-parser");
require("dotenv").config();
const pool = require("./src/config/db");

const authRoutes = require("./src/routes/authRoutes");
const memberRoutes = require("./src/routes/memberRoutes");
const transactionHistoryRoutes = require("./src/routes/transactionHistoryRoutes");
const transactionRoutes = require("./src/routes/transactionRoutes");
const knowledgeRoutes = require("./src/routes/knowledgeRoutes");
const transactionChatRoutes = require("./src/routes/transactionChatRoutes");
const AdminRoutes = require("./src/routes/adminAuth");
const clubRoutes = require("./src/routes/clubRoutes")
const staffRoutes = require("./src/routes/staffRoute")
const settingsRoutes = require("./src/routes/settingsRoutes")
const reportRoutes = require("./src/routes/reportRoutes")
// const supabase = require("./config/supabase");

const app = express();

// Middleware

app.use(
  cors({
    origin: process.env.CLIENT_URL,
    credentials: true,
  }),
);

app.use(express.json());

app.use(express.urlencoded({ extended: true }));

app.use(cookieParser());

// Routes

app.use("/api/auth", authRoutes);
app.use("/api/members", memberRoutes);
app.use("/api/transaction-histories", transactionHistoryRoutes);
app.use("/api/transactions", transactionRoutes);
app.use("/api/ai/knowledge", knowledgeRoutes);
app.use("/api/ai/transaction-chat", transactionChatRoutes);
app.use("/api/AdminAuth", AdminRoutes);

app.use("/api/club", clubRoutes);
app.use("/api/staff", staffRoutes);
app.use("/api/settings", settingsRoutes);
app.use("/api/reports", reportRoutes);

// Health check

app.get("/", (req, res) => {
  res.json({
    success: true,
    message: "Club Management API is running",
  });
});

// app.get("/api/test-db", async (req, res) => {
//   try {
//     const result = await pool.query("SELECT NOW()");

//     res.json({
//       success: true,
//       message: "Supabase database connected",
//       time: result.rows[0].now,
//     });
//   } catch (error) {
//     console.error(error);

//     res.status(500).json({
//       success: false,
//       message: "Database connection failed",
//       error: error.message,
//     });
//   }

const PORT = process.env.PORT || 5000;

async function startServer() {
  try {
    app.listen(PORT, () => {
      console.log(`Server running on port ${PORT}`);
    });
  } catch (error) {
    console.error("Server startup failed:", error);
    process.exitCode = 1;
  }
}

startServer();

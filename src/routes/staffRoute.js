const express = require("express");

const routers = express.Router();

const {
  createStaff,
  getAllStaff,
  getStaffById,
  updateStaff,
  deleteStaff,
} = require("../controllers/staffController");

const requireAdmin = require("../middleware/requireAdmin");

// Protect all staff routes with requireAdmin
routers.use(requireAdmin);

routers.post("/createstaff", createStaff);
routers.get("/getAllStaff", getAllStaff);
routers.get("/:staffId", getStaffById);
routers.patch("/:staffId", updateStaff);
routers.delete("/:staffId", deleteStaff);

module.exports = routers;

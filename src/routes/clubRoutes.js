const express = require("express");

const {
  createClub,
  getClub,
  getClubs,
  updateClub,
  deleteClub,
  getClubStatistics,
} = require("../controllers/clubController");

const requireAdmin = require("../middleware/requireAdmin");

const routers = express.Router();

// Protect all club routes with requireAdmin
routers.use(requireAdmin);

routers.post("/createclub", createClub);
routers.get("/getclub", getClubs);
routers.get("/statistics", getClubStatistics);
routers.get("/:clubId", getClub);
routers.patch("/:clubId", updateClub);
routers.delete("/:clubId", deleteClub);

module.exports = routers;

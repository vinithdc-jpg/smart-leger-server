const jwt = require("jsonwebtoken");

const generatetoken = (staff) => {
  return jwt.sign(
    {
      staffId: staff.id,
      clubId: staff.club_id,
      email: staff.email,
      role: staff.role,
    },
    process.env.JWT_SECRET,
    {
      expiresIn: "7d",
    }
  );
};

module.exports = generatetoken;
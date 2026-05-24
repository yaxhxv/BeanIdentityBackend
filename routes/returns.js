// routes/returns.js
const express = require("express");
const router = express.Router();
const Return = require("../models/Return");

router.post("/", async (req, res) => {
  const data = await Return.create(req.body);
  res.json(data);
});

module.exports = router;
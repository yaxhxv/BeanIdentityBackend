require("dotenv").config();
const express = require("express");
const cors = require("cors");

const app = express();
const connectDB = require("./config/db");



app.use(cors());
app.use(express.json());

app.use("/api/returns", require("./routes/returns"));

app.get("/", (req, res) => {
  res.send("Returns Service Running 🚀");
});

const PORT = process.env.PORT || 5000;
connectDB();

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
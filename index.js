const pool = require('./config/database');
const express = require("express");
const cors = require("cors");
require("dotenv").config();

const app = express();

const cors = require("cors");

const corsOptions = {
  origin: [
    "https://main.d38u4xwtujcspz.amplifyapp.com"
  ],
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  credentials: true
};

app.use(cors(corsOptions));
app.options("*", cors(corsOptions));

app.use(express.json());
app.use(express.json());

// ── Routes ────────────────────────────────────────────────────
app.use('/api/auth',                require('./routes/auth'));
app.use('/api/crm',                 require('./routes/crm'));           // ← THIS WAS MISSING
app.use('/api/expenses',            require('./routes/expenses'));
app.use('/api/products',            require('./routes/products'));
app.use('/api/purchases',           require('./routes/purchases'));
app.use('/api/purchase-returns',    require('./routes/purchaseReturns'));
app.use('/api/stock-adjustments',   require('./routes/stockAdjustments'));
app.use('/api/stock-transfers',     require('./routes/stockTransfers'));
app.use('/api/commission-agents',   require('./routes/commissionAgentsroutes'));
app.use('/api/contacts',            require('./routes/contacts'));
app.use('/api/roles',               require('./routes/roles'));
app.use('/api/users',               require('./routes/users'));
app.use('/api/hrm',                 require('./routes/hrm'));
app.use('/api/settings',            require('./routes/settingRoutes'));
app.use('/api/notification-templates', require('./routes/notificationTemplates'));

// test route
app.get("/", (req, res) => res.send("ERP Backend Running 🚀"));

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
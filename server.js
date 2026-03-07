const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const express = require('express');
const app     = express();

const { getAppConfig } = require('./helpers');
const { decrypt }      = require('./encryption');

const authRoutes         = require('./routes/auth');
const userRoutes         = require('./routes/user');
const transactionRoutes  = require('./routes/transactions');
const referralRoutes     = require('./routes/referral');
const notificationRoutes = require('./routes/notifications');
const adminRoutes        = require('./routes/admin');

app.use(express.json());

app.get('/', (req, res) => {
  res.json({ success: true, message: '✅ DX_APP Server is running!' });
});

app.get('/config', async (req, res) => {
  try {
    const config = await getAppConfig();
    res.json({
      success:        true,
      deposit_wallet: decrypt(config.wallet_address),
      qr_image_url:   config.qr_image_url || null,
    });
  } catch (err) {
    res.json({ success: false, message: err.message });
  }
});

app.get('/market-data', async (req, res) => {
  try {
    const config = await getAppConfig();
    res.json({ success: true, usdt_inr_rate: parseFloat(config.usdt_inr_rate) });
  } catch (err) {
    res.json({ success: false, message: err.message });
  }
});

app.use('/',      authRoutes);
app.use('/',      userRoutes);
app.use('/',      transactionRoutes);
app.use('/',      referralRoutes);
app.use('/',      notificationRoutes);
app.use('/admin', adminRoutes);

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Server running on port ${PORT}`);
  console.log(`📡 Local:   http://localhost:${PORT}`);
  console.log(`📡 Network: http://192.168.20.2:${PORT}`);
});
require('dotenv').config();
const twilio = require('twilio');
const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const express = require('express');
const app = express();
const supabase = require('./supabase');
const bcrypt = require('bcryptjs');
const { encrypt, decrypt } = require('./encryption');
app.use(express.json());

const DEPOSIT_WALLET = process.env.DEPOSIT_WALLET;
const USDT_CONTRACT  = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';

// ─────────────────────────────────────────
// GET / — Health check
// ─────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ success: true, message: '✅ DX_APP Server is running!' });
});

// ─────────────────────────────────────────
// GET /config — Returns public app config (deposit wallet)
// ─────────────────────────────────────────
app.get('/config', (req, res) => {
  if (!DEPOSIT_WALLET) {
    return res.json({ success: false, message: 'Deposit wallet not configured.' });
  }
  res.json({
    success: true,
    deposit_wallet: DEPOSIT_WALLET,
  });
});

// ─────────────────────────────────────────
// GET /balances/:user_id — Fetch USDT and INR balance
// ─────────────────────────────────────────
app.get('/balances/:user_id', async (req, res) => {
  const { user_id } = req.params;
  if (!user_id) return res.json({ success: false, message: 'User ID required' });

  // Sum confirmed deposits → USDT in
  const { data: deposits, error: depErr } = await supabase
    .from('deposits')
    .select('amount')
    .eq('user_id', user_id)
    .eq('status', 'confirmed');

  // Sum completed exchanges → USDT out, INR in
  const { data: exchanges, error: exErr } = await supabase
    .from('exchanges')
    .select('amount_from, amount_to, from_currency, to_currency')
    .eq('user_id', user_id)
    .eq('status', 'completed');

  if (depErr || exErr) {
    return res.json({ success: false, message: 'Failed to fetch balances' });
  }

  const totalDeposited = (deposits  || []).reduce((sum, d) => sum + parseFloat(d.amount), 0);
  const usdtSpent      = (exchanges || []).filter(e => e.from_currency === 'USDT').reduce((sum, e) => sum + parseFloat(e.amount_from), 0);
  const inrReceived    = (exchanges || []).filter(e => e.to_currency   === 'INR' ).reduce((sum, e) => sum + parseFloat(e.amount_to),   0);

  res.json({
    success:      true,
    usdt_balance: parseFloat((totalDeposited - usdtSpent).toFixed(4)),
    inr_balance:  parseFloat(inrReceived.toFixed(2)),
  });
});

// ─────────────────────────────────────────
// POST /deposit — Save deposit transaction
// ─────────────────────────────────────────
app.post('/deposit', async (req, res) => {
  const { user_id, tx_hash, amount, status, from_address, to_address } = req.body;
  if (!user_id || !tx_hash || !amount || !status) {
    return res.json({ success: false, message: 'All fields are required' });
  }
  const { error } = await supabase
    .from('deposits')
    .insert([{ user_id, tx_hash, amount, status, from_address, to_address }]);
  if (error) return res.json({ success: false, message: error.message });
  res.json({ success: true, message: 'Deposit saved.' });
});

// ─────────────────────────────────────────
// POST /exchange — Save exchange transaction
// ─────────────────────────────────────────
app.post('/exchange', async (req, res) => {
  const { user_id, from_currency, to_currency, amount_from, amount_to, rate, status } = req.body;
  if (!user_id || !from_currency || !to_currency || !amount_from || !amount_to || !status) {
    return res.json({ success: false, message: 'All fields are required' });
  }
  const { error } = await supabase
    .from('exchanges')
    .insert([{ user_id, from_currency, to_currency, amount_from, amount_to, rate, status }]);
  if (error) return res.json({ success: false, message: error.message });
  res.json({ success: true, message: 'Exchange saved.' });
});

// ─────────────────────────────────────────
// GET /orders/:user_id — Fetch all user orders
// ─────────────────────────────────────────
app.get('/orders/:user_id', async (req, res) => {
  const { user_id } = req.params;
  if (!user_id) return res.json({ success: false, message: 'User ID required' });

  const { data: deposits,    error: depErr  } = await supabase.from('deposits').select('*').eq('user_id', user_id).order('created_at', { ascending: false });
  const { data: exchanges,   error: exErr   } = await supabase.from('exchanges').select('*').eq('user_id', user_id).order('created_at', { ascending: false });
  const { data: withdrawals, error: withErr } = await supabase.from('withdrawals').select('*').eq('user_id', user_id).order('created_at', { ascending: false });

  if (depErr || exErr || withErr) return res.json({ success: false, message: 'Failed to fetch orders' });
  res.json({ success: true, deposits, exchanges, withdrawals });
});

// ─────────────────────────────────────────
// POST /bank-card — Save or update bank card info
// ─────────────────────────────────────────
app.post('/bank-card', async (req, res) => {
  const { user_id, card_number, card_holder, bank_name, ifsc_code } = req.body;
  if (!user_id || !card_number || !card_holder || !bank_name) {
    return res.json({ success: false, message: 'All fields are required' });
  }
  try {
    const encryptedCardNumber = encrypt(card_number);
    const encryptedCardHolder = encrypt(card_holder);
    const { error } = await supabase
      .from('bank_cards')
      .upsert([{ user_id, card_number: encryptedCardNumber, card_holder: encryptedCardHolder, bank_name, ifsc_code }],
        { onConflict: ['user_id'] });
    if (error) return res.json({ success: false, message: error.message });
    res.json({ success: true, message: 'Bank card info saved.' });
  } catch (err) {
    res.json({ success: false, message: err.message });
  }
});

// ─────────────────────────────────────────
// GET /bank-card/:user_id — Fetch bank card info
// ─────────────────────────────────────────
app.get('/bank-card/:user_id', async (req, res) => {
  const { user_id } = req.params;
  if (!user_id) return res.json({ success: false, message: 'User ID required' });
  const { data, error } = await supabase.from('bank_cards').select('*').eq('user_id', user_id).single();
  if (error || !data) return res.json({ success: false, message: 'No bank card info found' });
  try {
    data.card_number = decrypt(data.card_number);
    data.card_holder = decrypt(data.card_holder);
  } catch (e) {
    return res.json({ success: false, message: 'Decryption failed' });
  }
  res.json({ success: true, data });
});

// ─────────────────────────────────────────
// POST /send-otp
// ─────────────────────────────────────────
app.post('/send-otp', async (req, res) => {
  const { phone } = req.body;
  console.log('📱 Send OTP request for:', phone);
  if (!phone) return res.json({ success: false, message: 'Phone number is required' });

  const { data: existingUser } = await supabase.from('users').select('id').eq('phone', phone).single();
  if (existingUser) {
    return res.json({ success: false, message: 'This number is already registered. Please log in.' });
  }

  try {
    await client.verify.v2.services(process.env.TWILIO_VERIFY_SID).verifications.create({ to: phone, channel: 'sms' });
    console.log('✅ OTP sent to:', phone);
    res.json({ success: true, message: 'OTP sent successfully' });
  } catch (err) {
    console.error('❌ Send OTP error:', err.message);
    res.json({ success: false, message: err.message });
  }
});

// ─────────────────────────────────────────
// POST /verify-and-register
// ─────────────────────────────────────────
app.post('/verify-and-register', async (req, res) => {
  const { name, phone, password, referralCode, code } = req.body;
  console.log('📋 Register request for:', phone);
  if (!name || !phone || !password || !code) {
    return res.json({ success: false, message: 'All fields are required' });
  }

  const { data: existingUser } = await supabase.from('users').select('id').eq('phone', phone).single();
  if (existingUser) {
    return res.json({ success: false, message: 'User already registered with this number' });
  }

  try {
    const result = await client.verify.v2.services(process.env.TWILIO_VERIFY_SID).verificationChecks.create({ to: phone, code });
    console.log('🔍 OTP verification status:', result.status);
    if (result.status !== 'approved') {
      return res.json({ success: false, message: 'Invalid or expired OTP' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const { error: insertErr } = await supabase.from('users').insert([{
      name, phone,
      password: encrypt(hashedPassword),
      referral_code: referralCode || null,
    }]);
    if (insertErr) {
      console.error('❌ Supabase insert error:', insertErr.message);
      return res.json({ success: false, message: 'Failed to register user.' });
    }

    console.log('✅ New user registered:', name, phone);
    res.json({ success: true, message: 'Registration successful!' });
  } catch (err) {
    console.error('❌ Verify & Register error:', err.message);
    res.json({ success: false, message: err.message });
  }
});

// ─────────────────────────────────────────
// POST /login
// ─────────────────────────────────────────
app.post('/login', async (req, res) => {
  const { phone, password } = req.body;
  console.log('🔐 Login request for:', phone);
  if (!phone || !password) {
    return res.json({ success: false, message: 'Phone and password are required' });
  }

  const { data: user } = await supabase.from('users').select('*').eq('phone', phone).single();
  if (!user) {
    return res.json({ success: false, message: 'User not found. Please register first.' });
  }

  let decryptedHash;
  try {
    decryptedHash = decrypt(user.password);
  } catch (e) {
    return res.json({ success: false, message: 'Password decryption failed.' });
  }

  const isMatch = await bcrypt.compare(password, decryptedHash);
  if (!isMatch) {
    console.log('❌ Wrong password for:', phone);
    return res.json({ success: false, message: 'Incorrect password' });
  }

  console.log('✅ Login successful for:', phone);
  res.json({
    success: true,
    message: 'Login successful',
    user: {
      id:    user.id,
      name:  user.name,
      phone: user.phone,
    },
  });
});

// ─────────────────────────────────────────
// POST /withdraw — Save withdrawal request
// ─────────────────────────────────────────
app.post('/withdraw', async (req, res) => {
  const { user_id, amount, address } = req.body;
  if (!user_id || !amount || !address) {
    return res.json({ success: false, message: 'All fields are required' });
  }

  // Check available balance first
  const { data: deposits } = await supabase.from('deposits').select('amount').eq('user_id', user_id).eq('status', 'confirmed');
  const { data: exchanges } = await supabase.from('exchanges').select('amount_from').eq('user_id', user_id).eq('status', 'completed');
  const { data: withdrawals } = await supabase.from('withdrawals').select('amount').eq('user_id', user_id).eq('status', 'pending');

  const totalDeposited = (deposits  || []).reduce((sum, d) => sum + parseFloat(d.amount), 0);
  const totalSpent     = (exchanges || []).reduce((sum, e) => sum + parseFloat(e.amount_from), 0);
  const totalPending   = (withdrawals || []).reduce((sum, w) => sum + parseFloat(w.amount), 0);
  const available      = totalDeposited - totalSpent - totalPending;

  if (parseFloat(amount) > available) {
    return res.json({ success: false, message: 'Insufficient balance' });
  }
  if (parseFloat(amount) < 200) {
    return res.json({ success: false, message: 'Minimum withdrawal is 200 USDT' });
  }

  const { error } = await supabase.from('withdrawals').insert([{ user_id, amount, address, status: 'pending' }]);
  if (error) return res.json({ success: false, message: error.message });

  res.json({ success: true, message: 'Withdrawal request submitted successfully!' });
});

// ─────────────────────────────────────────
// GET /withdrawals/:user_id — Fetch user withdrawals
// ─────────────────────────────────────────
app.get('/withdrawals/:user_id', async (req, res) => {
  const { user_id } = req.params;
  const { data, error } = await supabase.from('withdrawals').select('*').eq('user_id', user_id).order('created_at', { ascending: false });
  if (error) return res.json({ success: false, message: error.message });
  res.json({ success: true, withdrawals: data });
});

// ─────────────────────────────────────────
// POST /withdraw — Submit withdrawal request
// ─────────────────────────────────────────
app.post('/withdraw', async (req, res) => {
  const { user_id, amount, address } = req.body;
  if (!user_id || !amount || !address) {
    return res.json({ success: false, message: 'All fields are required' });
  }
  if (parseFloat(amount) < 200) {
    return res.json({ success: false, message: 'Minimum withdrawal is 200 USDT' });
  }

  // Check available balance
  const { data: deposits }    = await supabase.from('deposits').select('amount').eq('user_id', user_id).eq('status', 'confirmed');
  const { data: exchanges }   = await supabase.from('exchanges').select('amount_from').eq('user_id', user_id).eq('status', 'completed');
  const { data: withdrawals } = await supabase.from('withdrawals').select('amount').eq('user_id', user_id).in('status', ['pending', 'confirmed']);

  const totalDeposited = (deposits    || []).reduce((s, d) => s + parseFloat(d.amount), 0);
  const totalSpent     = (exchanges   || []).reduce((s, e) => s + parseFloat(e.amount_from), 0);
  const totalWithdrawn = (withdrawals || []).reduce((s, w) => s + parseFloat(w.amount), 0);
  const available      = totalDeposited - totalSpent - totalWithdrawn;

  if (parseFloat(amount) > available) {
    return res.json({ success: false, message: `Insufficient balance. Available: ${available.toFixed(2)} USDT` });
  }

  const { error } = await supabase.from('withdrawals').insert([{ user_id, amount, address, status: 'pending' }]);
  if (error) return res.json({ success: false, message: error.message });

  console.log(`✅ Withdrawal submitted: ${amount} USDT for user ${user_id}`);
  res.json({ success: true, message: 'Withdrawal request submitted successfully!' });
});

// ─────────────────────────────────────────
// POST /verify-transaction
// ─────────────────────────────────────────
app.post('/verify-transaction', async (req, res) => {
  const { txHash } = req.body;
  console.log('🔍 Verify transaction request:', txHash);
  if (!txHash) return res.json({ success: false, message: 'Transaction ID is required.' });
  if (!DEPOSIT_WALLET) {
    console.error('❌ DEPOSIT_WALLET not set in .env');
    return res.json({ success: false, message: 'Server configuration error.' });
  }

  try {
    const response = await fetch(`https://apilist.tronscanapi.com/api/transaction-info?hash=${txHash.trim()}`);
    const data = await response.json();

    if (!data || !data.hash)
      return res.json({ success: false, message: 'Transaction ID not found on TronScan.' });
    if (data.contractRet !== 'SUCCESS')
      return res.json({ success: false, message: 'Transaction did not succeed on the blockchain.' });

    const tokenTransfer = data.trc20TransferInfo?.[0];
    if (!tokenTransfer)
      return res.json({ success: false, message: 'No TRC20 token transfer found in this transaction.' });
    if (tokenTransfer.contract_address !== USDT_CONTRACT)
      return res.json({ success: false, message: 'This transaction is not a USDT transfer.' });
    if (tokenTransfer.to_address !== DEPOSIT_WALLET)
      return res.json({ success: false, message: 'This transaction was not sent to our deposit wallet.' });

    const rawAmount  = tokenTransfer.amount_str || tokenTransfer.amount || '0';
    const usdtAmount = (parseFloat(rawAmount) / 1_000_000).toFixed(2);
    const fromAddress = tokenTransfer.from_address || data.ownerAddress || 'Unknown';
    const timestamp   = data.timestamp ? new Date(data.timestamp).toLocaleString() : 'N/A';

    console.log(`✅ Transaction verified: ${usdtAmount} USDT from ${fromAddress}`);
    return res.json({
      success: true,
      message: 'Transaction verified successfully!',
      data: {
        txHash:   data.hash,
        amount:   usdtAmount,
        from:     fromAddress,
        to:       tokenTransfer.to_address,
        time:     timestamp,
      },
    });
  } catch (err) {
    console.error('❌ Verify transaction error:', err.message);
    return res.json({ success: false, message: 'Failed to reach TronScan. Try again later.' });
  }
});

// ─────────────────────────────────────────
// GET /market-data — Live USDT/INR rate
// ─────────────────────────────────────────
app.get('/market-data', async (req, res) => {
  try {
    const response = await fetch(
      'https://api.coingecko.com/api/v3/simple/price?ids=tether&vs_currencies=inr'
    );
    const data = await response.json();
    const rate = data?.tether?.inr || 84.5;
    res.json({ success: true, usdt_inr_rate: rate });
  } catch (err) {
    res.json({ success: true, usdt_inr_rate: 84.5 }); // fallback if API fails
  }
});

// ─────────────────────────────────────────
// GET /user/:user_id — Fetch user info
// ─────────────────────────────────────────
app.get('/user/:user_id', async (req, res) => {
  const { user_id } = req.params;
  if (!user_id) return res.json({ success: false, message: 'User ID required' });
  const { data, error } = await supabase
    .from('users')
    .select('id, name, phone')
    .eq('id', user_id)
    .single();
  if (error || !data) return res.json({ success: false, message: 'User not found' });
  res.json({ success: true, user: data });
});

// ─────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Server running on port ${PORT}`);
  console.log(`📡 Local:   http://localhost:${PORT}`);
  console.log(`📡 Network: http://192.168.20.2:${PORT}`);
});
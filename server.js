const path   = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const twilio = require('twilio');
const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const express = require('express');
const app = express();
const supabase = require('./supabase');
const bcrypt = require('bcryptjs');
const { encrypt, decrypt } = require('./encryption');
const multer = require('multer');

app.use(express.json());

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 },
});

const USDT_CONTRACT       = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
const REFERRAL_COMMISSION = 0.0025; // 0.25%
const ADMIN_PASSWORD      = process.env.ADMIN_PASSWORD || 'admin@dinero2024';

// ── Generate unique 6-char referral code ─────────────────────
function generateReferralCode() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let code = '';
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

async function getUniqueReferralCode() {
  let code, exists = true;
  while (exists) {
    code = generateReferralCode();
    const { data } = await supabase.from('users').select('id').eq('referral_code', code).single();
    exists = !!data;
  }
  return code;
}


async function getAppConfig() {
  const { data, error } = await supabase
    .from('app_config')
    .select('*')
    .order('updated_at', { ascending: false })
    .limit(1)
    .single();
  if (error || !data) throw new Error('App config not found in database');
  return data;
}

// ── Helper: create a notification ────────────────────────────
async function createNotification(user_id, type, title, message) {
  await supabase.from('notifications').insert([{ user_id, type, title, message }]);
}


// ─────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ success: true, message: '✅ DX_APP Server is running!' });
});


// ── Returns deposit wallet + QR image URL from Supabase ──────
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


app.get('/balances/:user_id', async (req, res) => {
  const { user_id } = req.params;
  if (!user_id) return res.json({ success: false, message: 'User ID required' });

  const { data: deposits, error: depErr } = await supabase
    .from('deposits')
    .select('amount')
    .eq('user_id', user_id)
    .eq('status', 'confirmed');

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


app.post('/exchange', async (req, res) => {
  const { user_id, from_currency, to_currency, amount_from, fee, amount_after_fee, amount_to, rate, status } = req.body;
  if (!user_id || !from_currency || !to_currency || !amount_from || !amount_to || !status) {
    return res.json({ success: false, message: 'All fields are required' });
  }

  const { error } = await supabase
    .from('exchanges')
    .insert([{ user_id, from_currency, to_currency, amount_from, fee, amount_after_fee, amount_to, rate, status }]);
  if (error) return res.json({ success: false, message: error.message });

  // ── Referral bonus ────────────────────────────────────────
  const { data: referral } = await supabase
    .from('referrals')
    .select('referred_by')
    .eq('user_id', user_id)
    .single();

  if (referral && referral.referred_by) {
    // Bonus on amount_after_fee (after exchange fee deduction)
    const bonusAmount = parseFloat((parseFloat(amount_after_fee) * REFERRAL_COMMISSION).toFixed(6));

    // 1. Add to referrer's bonus_balance in users table
    const { data: referrer } = await supabase
      .from('users')
      .select('bonus_balance')
      .eq('id', referral.referred_by)
      .single();

    const currentBonus = parseFloat(referrer?.bonus_balance || 0);
    const newBonus     = parseFloat((currentBonus + bonusAmount).toFixed(6));

    await supabase
      .from('users')
      .update({ bonus_balance: newBonus })
      .eq('id', referral.referred_by);

    // 2. Accumulate in referrals table (add, not overwrite)
    const { data: existingReferral } = await supabase
      .from('referrals')
      .select('bonus_amount')
      .eq('user_id', user_id)
      .single();

    const currentReferralBonus = parseFloat(existingReferral?.bonus_amount || 0);
    const newReferralBonus     = parseFloat((currentReferralBonus + bonusAmount).toFixed(6));

    await supabase
      .from('referrals')
      .update({ bonus_amount: newReferralBonus, bonus_paid: true })
      .eq('user_id', user_id);

    // 3. Notify referrer
    await createNotification(
      referral.referred_by,
      'referral_bonus',
      '🎁 Referral Bonus Received',
      `You earned ${bonusAmount.toFixed(6)} USDT bonus from your referral's exchange.`
    );

    console.log(`💰 Referral bonus: ${bonusAmount} USDT credited to ${referral.referred_by}`);
  }

  res.json({ success: true, message: 'Exchange saved.' });
});


app.get('/orders/:user_id', async (req, res) => {
  const { user_id } = req.params;
  if (!user_id) return res.json({ success: false, message: 'User ID required' });

  const { data: deposits,    error: depErr  } = await supabase.from('deposits').select('*').eq('user_id', user_id).order('created_at', { ascending: false });
  const { data: exchanges,   error: exErr   } = await supabase.from('exchanges').select('*').eq('user_id', user_id).order('created_at', { ascending: false });
  const { data: withdrawals, error: withErr } = await supabase.from('withdrawals').select('*').eq('user_id', user_id).order('created_at', { ascending: false });

  if (depErr || exErr || withErr) return res.json({ success: false, message: 'Failed to fetch orders' });
  res.json({ success: true, deposits, exchanges, withdrawals });
});


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

    const hashedPassword      = await bcrypt.hash(password, 10);
    const newUserReferralCode = await getUniqueReferralCode();

    const { data: newUser, error: insertErr } = await supabase.from('users').insert([{
      name, phone,
      password:      encrypt(hashedPassword),
      referral_code: newUserReferralCode,
    }]).select('id').single();

    if (insertErr || !newUser) {
      console.error('❌ Supabase insert error:', insertErr?.message);
      return res.json({ success: false, message: 'Failed to register user.' });
    }

    if (referralCode && referralCode.trim()) {
      const { data: referrer } = await supabase
        .from('users').select('id')
        .eq('referral_code', referralCode.trim().toUpperCase()).single();
      if (referrer) {
        await supabase.from('referrals').insert([{ user_id: newUser.id, referred_by: referrer.id }]);
        console.log(`✅ Referral recorded: ${newUser.id} referred by ${referrer.id}`);
      } else {
        console.log('⚠️ Referral code not found:', referralCode);
      }
    }

    console.log('✅ New user registered:', name, phone, '| Code:', newUserReferralCode);
    res.json({ success: true, message: 'Registration successful!' });
  } catch (err) {
    console.error('❌ Verify & Register error:', err.message);
    res.json({ success: false, message: err.message });
  }
});


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
    user: { id: user.id, name: user.name, phone: user.phone },
  });
});


app.post('/withdraw', async (req, res) => {
  const { user_id, amount, address } = req.body;
  if (!user_id || !amount || !address) {
    return res.json({ success: false, message: 'All fields are required' });
  }
  if (parseFloat(amount) < 200) {
    return res.json({ success: false, message: 'Minimum withdrawal is 200 USDT' });
  }

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


app.get('/withdrawals/:user_id', async (req, res) => {
  const { user_id } = req.params;
  const { data, error } = await supabase.from('withdrawals').select('*').eq('user_id', user_id).order('created_at', { ascending: false });
  if (error) return res.json({ success: false, message: error.message });
  res.json({ success: true, withdrawals: data });
});


app.post('/verify-transaction', async (req, res) => {
  const { txHash } = req.body;
  console.log('🔍 Verify transaction request:', txHash);
  if (!txHash) return res.json({ success: false, message: 'Transaction ID is required.' });

  try {
    const config = await getAppConfig();
    const DEPOSIT_WALLET = decrypt(config.wallet_address);

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

    const rawAmount   = tokenTransfer.amount_str || tokenTransfer.amount || '0';
    const usdtAmount  = (parseFloat(rawAmount) / 1_000_000).toFixed(2);
    const fromAddress = tokenTransfer.from_address || data.ownerAddress || 'Unknown';
    const timestamp   = data.timestamp ? new Date(data.timestamp).toLocaleString() : 'N/A';

    console.log(`✅ Transaction verified: ${usdtAmount} USDT from ${fromAddress}`);
    return res.json({
      success: true,
      message: 'Transaction verified successfully!',
      data: {
        txHash:  data.hash,
        amount:  usdtAmount,
        from:    fromAddress,
        to:      tokenTransfer.to_address,
        time:    timestamp,
      },
    });
  } catch (err) {
    console.error('❌ Verify transaction error:', err.message);
    return res.json({ success: false, message: 'Failed to reach TronScan. Try again later.' });
  }
});


// ── Returns USDT→INR rate from Supabase ──────────────────────
app.get('/market-data', async (req, res) => {
  try {
    const config = await getAppConfig();
    res.json({ success: true, usdt_inr_rate: parseFloat(config.usdt_inr_rate) });
  } catch (err) {
    res.json({ success: false, message: err.message });
  }
});


app.get('/user/:user_id', async (req, res) => {
  const { user_id } = req.params;
  if (!user_id) return res.json({ success: false, message: 'User ID required' });
  const { data, error } = await supabase
    .from('users').select('id, name, phone').eq('id', user_id).single();
  if (error || !data) return res.json({ success: false, message: 'User not found' });
  res.json({ success: true, user: data });
});


app.get('/user-profile/:user_id', async (req, res) => {
  const { user_id } = req.params;
  if (!user_id) return res.json({ success: false, message: 'User ID required' });
  const { data, error } = await supabase
    .from('users').select('id, name, phone, referral_code, bonus_balance').eq('id', user_id).single();
  if (error || !data) return res.json({ success: false, message: 'User not found' });
  res.json({
    success:       true,
    referral_code: data.referral_code || '',
    bonus_balance: parseFloat(data.bonus_balance || 0),
  });
});


app.get('/team/:user_id', async (req, res) => {
  const { user_id } = req.params;
  const { data: referrals, error } = await supabase
    .from('referrals').select('user_id, bonus_amount, bonus_paid, created_at')
    .eq('referred_by', user_id).order('created_at', { ascending: false });

  if (error) return res.json({ success: false, message: error.message });
  if (!referrals || referrals.length === 0) return res.json({ success: true, members: [], total_bonus: 0 });

  const memberIds = referrals.map(r => r.user_id);
  const { data: users } = await supabase
    .from('users').select('id, name, phone, created_at').in('id', memberIds);

  const members = referrals.map(r => {
    const u = (users || []).find(u => u.id === r.user_id);
    return {
      user_id:      r.user_id,
      name:         u?.name || 'Unknown',
      phone:        u?.phone || '',
      joined_at:    u?.created_at || r.created_at,
      bonus_amount: parseFloat(r.bonus_amount || 0),
      bonus_paid:   r.bonus_paid,
    };
  });

  const total_bonus = members.reduce((s, m) => s + m.bonus_amount, 0);
  res.json({ success: true, members, total_bonus: parseFloat(total_bonus.toFixed(6)) });
});


app.get('/check-referral/:user_id', async (req, res) => {
  const { user_id } = req.params;
  const { data } = await supabase.from('referrals').select('id').eq('user_id', user_id).single();
  res.json({ success: true, has_referral: !!data });
});


app.post('/validate-referral-code', async (req, res) => {
  const { code, user_id } = req.body;
  if (!code) return res.json({ valid: false });

  const { data: owner } = await supabase
    .from('users').select('id').eq('referral_code', code.toUpperCase()).single();
  if (!owner) return res.json({ valid: false, message: 'Code not found' });
  if (owner.id === user_id) return res.json({ valid: false, message: 'Cannot use your own code' });

  const { data: existing } = await supabase.from('referrals').select('id').eq('user_id', user_id).single();
  if (existing) return res.json({ valid: false, message: 'Already applied a referral code' });

  res.json({ valid: true });
});


app.post('/apply-referral', async (req, res) => {
  const { user_id, code } = req.body;
  if (!user_id || !code) return res.json({ success: false, message: 'All fields required' });

  const { data: existing } = await supabase.from('referrals').select('id').eq('user_id', user_id).single();
  if (existing) return res.json({ success: false, message: 'You have already applied a referral code.' });

  const { data: referrer } = await supabase
    .from('users').select('id').eq('referral_code', code.toUpperCase()).single();
  if (!referrer) return res.json({ success: false, message: 'Invalid referral code.' });
  if (referrer.id === user_id) return res.json({ success: false, message: 'Cannot use your own code.' });

  const { error } = await supabase.from('referrals').insert([{ user_id, referred_by: referrer.id }]);
  if (error) return res.json({ success: false, message: error.message });

  console.log(`✅ Referral applied: ${user_id} referred by ${referrer.id}`);
  res.json({ success: true, message: 'Referral code applied!' });
});


app.post('/withdraw-bonus', async (req, res) => {
  const { user_id, amount } = req.body;
  if (!user_id || !amount) return res.json({ success: false, message: 'All fields required' });

  const { data: user } = await supabase.from('users').select('bonus_balance').eq('id', user_id).single();
  if (!user) return res.json({ success: false, message: 'User not found' });

  const bonus = parseFloat(user.bonus_balance || 0);
  if (bonus < 10) return res.json({ success: false, message: 'Minimum 10 USDT bonus required to withdraw' });
  if (parseFloat(amount) > bonus) return res.json({ success: false, message: 'Insufficient bonus balance' });

  const { error } = await supabase.from('withdrawals').insert([{
    user_id, amount: parseFloat(amount), address: 'BONUS_WITHDRAWAL', status: 'pending',
  }]);
  if (error) return res.json({ success: false, message: error.message });

  await supabase.from('users').update({ bonus_balance: 0 }).eq('id', user_id);

  console.log(`💰 Bonus withdrawal: ${amount} USDT for user ${user_id}`);
  res.json({ success: true, message: 'Bonus withdrawal submitted!' });
});


app.get('/bonus/:user_id', async (req, res) => {
  const { user_id } = req.params;
  const { data, error } = await supabase
    .from('users').select('bonus_balance').eq('id', user_id).single();
  if (error || !data) return res.json({ success: false, bonus_balance: 0 });
  res.json({ success: true, bonus_balance: parseFloat(data.bonus_balance || 0) });
});


// ══════════════════════════════════════════════════════════════
// ── NOTIFICATION ENDPOINTS ────────────────────────────────────
// ══════════════════════════════════════════════════════════════

app.get('/notifications/:user_id', async (req, res) => {
  const { user_id } = req.params;
  const { data, error } = await supabase
    .from('notifications')
    .select('*')
    .eq('user_id', user_id)
    .order('created_at', { ascending: false })
    .limit(50);
  if (error) return res.json({ success: false, message: error.message });
  const unread = (data || []).filter(n => !n.is_read).length;
  res.json({ success: true, notifications: data || [], unread_count: unread });
});

app.post('/notifications/read-all/:user_id', async (req, res) => {
  const { user_id } = req.params;
  const { error } = await supabase
    .from('notifications')
    .update({ is_read: true })
    .eq('user_id', user_id)
    .eq('is_read', false);
  if (error) return res.json({ success: false, message: error.message });
  res.json({ success: true });
});

app.post('/notifications/read/:notif_id', async (req, res) => {
  const { notif_id } = req.params;
  const { error } = await supabase
    .from('notifications')
    .update({ is_read: true })
    .eq('id', notif_id);
  if (error) return res.json({ success: false, message: error.message });
  res.json({ success: true });
});


// ══════════════════════════════════════════════════════════════
// ── ADMIN ENDPOINTS ───────────────────────────────────────────
// ══════════════════════════════════════════════════════════════

app.post('/admin/login', (req, res) => {
  const { password } = req.body;
  if (password !== ADMIN_PASSWORD) {
    return res.json({ success: false, message: 'Invalid password' });
  }
  res.json({ success: true, message: 'Welcome Admin' });
});


app.get('/admin/users', async (req, res) => {
  const { data, error } = await supabase
    .from('users')
    .select('id, name, phone, referral_code, bonus_balance, created_at')
    .order('created_at', { ascending: false });
  if (error) return res.json({ success: false, message: error.message });
  res.json({ success: true, users: data });
});


app.get('/admin/user/:user_id', async (req, res) => {
  const { user_id } = req.params;

  const [
    { data: user },
    { data: deposits },
    { data: exchanges },
    { data: withdrawals },
    { data: referralRecord },
    { data: bankCardData },
  ] = await Promise.all([
    supabase.from('users').select('id, name, phone, referral_code, bonus_balance, created_at').eq('id', user_id).single(),
    supabase.from('deposits').select('*').eq('user_id', user_id).order('created_at', { ascending: false }),
    supabase.from('exchanges').select('*').eq('user_id', user_id).order('created_at', { ascending: false }),
    supabase.from('withdrawals').select('*').eq('user_id', user_id).order('created_at', { ascending: false }),
    supabase.from('referrals').select('referred_by, bonus_amount, bonus_paid, created_at').eq('user_id', user_id).maybeSingle(),
    supabase.from('bank_cards').select('*').eq('user_id', user_id).maybeSingle(),
  ]);

  if (!user) return res.json({ success: false, message: 'User not found' });

  let referrerName = null;
  if (referralRecord && referralRecord.referred_by) {
    const { data: referrer } = await supabase.from('users').select('name, phone').eq('id', referralRecord.referred_by).single();
    referrerName = referrer ? referrer.name + ' (' + referrer.phone + ')' : 'Unknown';
  }

  const { data: myReferrals } = await supabase
    .from('referrals').select('user_id, bonus_amount, created_at')
    .eq('referred_by', user_id).order('created_at', { ascending: false });

  let referredUsers = [];
  if (myReferrals && myReferrals.length > 0) {
    const ids = myReferrals.map(r => r.user_id);
    const { data: rUsers } = await supabase.from('users').select('id, name, phone').in('id', ids);
    referredUsers = myReferrals.map(r => {
      const u = (rUsers || []).find(u => u.id === r.user_id);
      return { name: u ? u.name : 'Unknown', phone: u ? u.phone : '', bonus_amount: r.bonus_amount, joined_at: r.created_at };
    });
  }

  res.json({
    success: true, user,
    deposits:    deposits    || [],
    exchanges:   exchanges   || [],
    withdrawals: withdrawals || [],
    referral_info: {
      referred_by_name: referrerName,
      referred_by_id:   referralRecord ? referralRecord.referred_by  : null,
      bonus_amount:     referralRecord ? referralRecord.bonus_amount  : 0,
      bonus_paid:       referralRecord ? referralRecord.bonus_paid    : false,
    },
    my_referrals: referredUsers,
    bank_card: bankCardData ? {
      ...bankCardData,
      card_number: (() => { try { return decrypt(bankCardData.card_number); } catch(e) { return bankCardData.card_number; } })(),
      card_holder: (() => { try { return decrypt(bankCardData.card_holder); } catch(e) { return bankCardData.card_holder; } })(),
    } : null,
  });
});


// ── Update status + send notification ────────────────────────
app.post('/admin/update-status', async (req, res) => {
  const { table, id, status } = req.body;
  const allowedTables   = ['deposits', 'exchanges', 'withdrawals'];
  const allowedStatuses = ['completed', 'confirmed', 'failed', 'pending'];

  if (!allowedTables.includes(table))    return res.json({ success: false, message: 'Invalid table' });
  if (!allowedStatuses.includes(status)) return res.json({ success: false, message: 'Invalid status' });

  const { error } = await supabase.from(table).update({ status }).eq('id', id);
  if (error) return res.json({ success: false, message: error.message });

  // Send notification to user
  const { data: record } = await supabase.from(table).select('*').eq('id', id).single();
  if (record) {
    if (table === 'deposits' && status === 'confirmed') {
      await createNotification(
        record.user_id, 'deposit',
        '✅ Deposit Confirmed',
        `Your deposit of ${parseFloat(record.amount).toFixed(2)} USDT has been confirmed.`
      );
    } else if (table === 'exchanges' && status === 'completed') {
      await createNotification(
        record.user_id, 'exchange',
        '💱 Exchange Completed',
        `Your exchange of ${parseFloat(record.amount_from).toFixed(4)} USDT → ₹${parseFloat(record.amount_to).toFixed(2)} INR is complete.`
      );
    } else if (table === 'withdrawals' && status === 'confirmed') {
      await createNotification(
        record.user_id, 'withdrawal',
        '💸 Withdrawal Confirmed',
        `Your withdrawal of ${parseFloat(record.amount).toFixed(2)} USDT has been processed.`
      );
    } else if (status === 'failed') {
      const typeLabel = table === 'deposits' ? 'Deposit' : table === 'exchanges' ? 'Exchange' : 'Withdrawal';
      const amt = parseFloat(record.amount || record.amount_from || 0).toFixed(2);
      await createNotification(
        record.user_id, table,
        `❌ ${typeLabel} Failed`,
        `Your ${typeLabel.toLowerCase()} of ${amt} USDT was unsuccessful. Please contact support.`
      );
    }
  }

  console.log(`✅ Admin updated ${table} ${id} → ${status}`);
  res.json({ success: true, message: `Status updated to ${status}` });
});


app.get('/admin/app-config', async (req, res) => {
  try {
    const config = await getAppConfig();
    res.json({
      success:        true,
      id:             config.id,
      wallet_address: decrypt(config.wallet_address),
      usdt_inr_rate:  parseFloat(config.usdt_inr_rate),
      qr_image_url:   config.qr_image_url || null,
      updated_at:     config.updated_at,
    });
  } catch (err) {
    res.json({ success: false, message: err.message });
  }
});


app.post('/admin/app-config', async (req, res) => {
  const { wallet_address, usdt_inr_rate } = req.body;

  if (!wallet_address || !usdt_inr_rate) {
    return res.json({ success: false, message: 'wallet_address and usdt_inr_rate are required' });
  }

  const rate = parseFloat(usdt_inr_rate);
  if (!Number.isFinite(rate) || rate <= 0) {
    return res.json({ success: false, message: 'Invalid USDT/INR rate' });
  }

  let encryptedWallet;
  try {
    encryptedWallet = encrypt(wallet_address.trim());
  } catch (err) {
    return res.json({ success: false, message: 'Encryption failed: ' + err.message });
  }

  const { data: existing } = await supabase
    .from('app_config').select('id')
    .order('updated_at', { ascending: false }).limit(1).single();

  const payload = {
    wallet_address: encryptedWallet,
    usdt_inr_rate:  rate,
    updated_at:     new Date().toISOString(),
  };

  const { error } = existing
    ? await supabase.from('app_config').update(payload).eq('id', existing.id)
    : await supabase.from('app_config').insert([payload]);

  if (error) return res.json({ success: false, message: error.message });

  console.log(`✅ Admin updated config — rate: ${rate}, wallet: ${wallet_address}`);
  res.json({ success: true, message: 'Config saved successfully!' });
});


app.post('/admin/upload-qr', upload.single('qr'), async (req, res) => {
  if (!req.file) return res.json({ success: false, message: 'No file uploaded' });

  const ext      = req.file.originalname.split('.').pop();
  const filename = `qr_${Date.now()}.${ext}`;

  const { error: upErr } = await supabase.storage
    .from('qrimages')
    .upload(filename, req.file.buffer, {
      contentType: req.file.mimetype,
      upsert: true,
    });

  if (upErr) return res.json({ success: false, message: upErr.message });

  const { data: urlData } = supabase.storage.from('qrimages').getPublicUrl(filename);

  const { data: existing } = await supabase
    .from('app_config').select('id')
    .order('updated_at', { ascending: false }).limit(1).single();

  if (existing) {
    await supabase.from('app_config')
      .update({ qr_image_url: urlData.publicUrl, updated_at: new Date().toISOString() })
      .eq('id', existing.id);
  }

  console.log(`✅ QR image uploaded: ${urlData.publicUrl}`);
  res.json({ success: true, qr_image_url: urlData.publicUrl });
});


const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Server running on port ${PORT}`);
  console.log(`📡 Local:   http://localhost:${PORT}`);
  console.log(`📡 Network: http://192.168.20.2:${PORT}`);
});
const express       = require('express');
const router        = express.Router();
const bcrypt        = require('bcryptjs');
const nodemailer    = require('nodemailer');
const supabase      = require('../supabase');
const { encrypt, decrypt } = require('../encryption');
const { getUniqueReferralCode } = require('../helpers');

// ── Gmail Transporter ─────────────────────────────────────────────
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.GMAIL_USER,      
    pass: process.env.GMAIL_APP_PASS,  
  },
});

// ── In-memory OTP store: { email -> { code, expiresAt } } ─────────
const otpStore = new Map();

function generateOtp() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

async function sendOtpEmail(email, otp) {
  await transporter.sendMail({
    from:    `"Dinero Stakes" <${process.env.GMAIL_USER}>`,
    to:      email,
    subject: 'Your Dinero Stakes OTP',
    text:    `Your OTP is: ${otp}. It expires in 10 minutes.`,
    html: `
      <div style="background:#0f0a02;padding:32px;font-family:Georgia,serif;max-width:480px;margin:auto;border-radius:16px;border:1px solid rgba(200,146,42,0.4)">
        <h2 style="color:#E2C664;letter-spacing:3px;text-align:center;margin-bottom:8px">DINERO STAKES</h2>
        <p style="color:#6a5030;text-align:center;font-size:11px;letter-spacing:2px;margin-bottom:28px">STAKE YOUR LIFE</p>
        <p style="color:#f0e6cc;font-size:14px;margin-bottom:16px">Your verification OTP is:</p>
        <div style="background:rgba(200,146,42,0.08);border:1.5px solid rgba(200,146,42,0.45);border-radius:12px;padding:20px;text-align:center;margin-bottom:24px">
          <span style="font-size:36px;font-weight:900;letter-spacing:10px;color:#E2C664;font-family:monospace">${otp}</span>
        </div>
        <p style="color:#6a5030;font-size:12px;text-align:center">This OTP expires in <strong style="color:#c8922a">10 minutes</strong>.</p>
        <p style="color:#4a3020;font-size:11px;text-align:center;margin-top:12px">Do not share this OTP with anyone.</p>
      </div>
    `,
  });
}


// ── Send OTP (registration) ───────────────────────────────────────
router.post('/send-otp', async (req, res) => {
  const { email } = req.body;
  console.log('📧 Send OTP request for:', email);
  if (!email) return res.json({ success: false, message: 'Email address is required' });

  const { data: existingUser } = await supabase
    .from('users').select('id').eq('email', email).single();
  if (existingUser) {
    return res.json({ success: false, message: 'This email is already registered. Please log in.' });
  }

  try {
    const otp       = generateOtp();
    const expiresAt = Date.now() + 10 * 60 * 1000;
    otpStore.set(email, { code: otp, expiresAt });

    await sendOtpEmail(email, otp);
    console.log('✅ OTP sent to:', email);
    res.json({ success: true, message: 'OTP sent successfully' });
  } catch (err) {
    console.error('❌ Send OTP error:', err.message);
    res.json({ success: false, message: 'Failed to send OTP. Please try again.' });
  }
});


// ── Verify OTP + Register ─────────────────────────────────────────
router.post('/verify-and-register', async (req, res) => {
  const { name, email, password, referralCode, code } = req.body;
  console.log('📋 Register request for:', email);
  if (!name || !email || !password || !code) {
    return res.json({ success: false, message: 'All fields are required' });
  }

  const { data: existingUser } = await supabase
    .from('users').select('id').eq('email', email).single();
  if (existingUser) {
    return res.json({ success: false, message: 'User already registered with this email' });
  }

  const record = otpStore.get(email);
  if (!record) {
    return res.json({ success: false, message: 'OTP not found. Please request a new one.' });
  }
  if (Date.now() > record.expiresAt) {
    otpStore.delete(email);
    return res.json({ success: false, message: 'OTP has expired. Please request a new one.' });
  }
  if (record.code !== code.trim()) {
    return res.json({ success: false, message: 'Invalid OTP' });
  }
  otpStore.delete(email);

  try {
    const hashedPassword      = await bcrypt.hash(password, 10);
    const newUserReferralCode = await getUniqueReferralCode();

    const { data: newUser, error: insertErr } = await supabase
      .from('users')
      .insert([{
        name,
        email,
        password:      encrypt(hashedPassword),
        referral_code: newUserReferralCode,
      }])
      .select('id')
      .single();

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

    console.log('✅ New user registered:', name, email, '| Code:', newUserReferralCode);
    res.json({ success: true, message: 'Registration successful!' });
  } catch (err) {
    console.error('❌ Verify & Register error:', err.message);
    res.json({ success: false, message: err.message });
  }
});


// ── Login ─────────────────────────────────────────────────────────
router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  console.log('🔐 Login request for:', email);
  if (!email || !password) {
    return res.json({ success: false, message: 'Email and password are required' });
  }

  const { data: user } = await supabase
    .from('users')
    .select('id, name, email, password')
    .eq('email', email)
    .single();
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
    console.log('❌ Wrong password for:', email);
    return res.json({ success: false, message: 'Incorrect password' });
  }

  console.log('✅ Login successful for:', email);
  res.json({
    success: true,
    message: 'Login successful',
    user: { id: user.id, name: user.name, email: user.email },
  });
});


// ── Set Transaction Password (OTP via email) ──────────────────────
router.post('/set-transaction-password', async (req, res) => {
  const { user_id, password, otp } = req.body;
  if (!user_id || !password || !otp) {
    return res.json({ success: false, message: 'All fields are required' });
  }

  const { data: user, error: userErr } = await supabase
    .from('users').select('email').eq('id', user_id).single();
  if (userErr || !user) return res.json({ success: false, message: 'User not found' });

  const record = otpStore.get(user.email);
  if (!record) {
    return res.json({ success: false, message: 'OTP not found. Please request a new one.' });
  }
  if (Date.now() > record.expiresAt) {
    otpStore.delete(user.email);
    return res.json({ success: false, message: 'OTP has expired. Please request a new one.' });
  }
  if (record.code !== otp.trim()) {
    return res.json({ success: false, message: 'Invalid OTP' });
  }
  otpStore.delete(user.email);

  try {
    const encrypted = encrypt(password);
    const { error } = await supabase
      .from('users').update({ transaction_password: encrypted }).eq('id', user_id);
    if (error) return res.json({ success: false, message: error.message });
    res.json({ success: true, message: 'Transaction password set successfully!' });
  } catch (err) {
    res.json({ success: false, message: err.message });
  }
});


// ── Send OTP to existing user ─────────────────────────────────────
router.post('/send-otp-existing', async (req, res) => {
  const { email } = req.body;
  console.log('📧 Send OTP (existing user) request for:', email);
  if (!email) return res.json({ success: false, message: 'Email address is required' });

  const { data: existingUser } = await supabase
    .from('users').select('id').eq('email', email).single();
  if (!existingUser) {
    return res.json({ success: false, message: 'User not found with this email.' });
  }

  try {
    const otp       = generateOtp();
    const expiresAt = Date.now() + 10 * 60 * 1000;
    otpStore.set(email, { code: otp, expiresAt });

    await sendOtpEmail(email, otp);
    console.log('✅ OTP sent to (existing user):', email);
    res.json({ success: true, message: 'OTP sent successfully' });
  } catch (err) {
    console.error('❌ Send OTP error:', err.message);
    res.json({ success: false, message: 'Failed to send OTP. Please try again.' });
  }
});


// ── Check Transaction Password ────────────────────────────────────
router.post('/check-transaction-password', async (req, res) => {
  const { user_id, password } = req.body;
  if (!user_id || !password) {
    return res.json({ success: false, message: 'All fields are required' });
  }

  const { data: user, error: userErr } = await supabase
    .from('users').select('transaction_password').eq('id', user_id).single();
  if (userErr || !user) return res.json({ success: false, message: 'User not found' });
  if (!user.transaction_password) {
    return res.json({ success: false, message: 'Transaction password not set' });
  }

  try {
    const decrypted = decrypt(user.transaction_password);
    if (decrypted !== password) {
      return res.json({ success: false, message: 'Incorrect transaction password' });
    }
    res.json({ success: true, message: 'Transaction password verified' });
  } catch (err) {
    res.json({ success: false, message: err.message });
  }
});

module.exports = router;
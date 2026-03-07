const express = require('express');
const router  = express.Router();
const bcrypt  = require('bcryptjs');
const client  = require('../twilioClient');
const supabase = require('../supabase');
const { encrypt, decrypt } = require('../encryption');
const { getUniqueReferralCode } = require('../helpers');


router.post('/send-otp', async (req, res) => {
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


router.post('/verify-and-register', async (req, res) => {
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


router.post('/login', async (req, res) => {
  const { phone, password } = req.body;
  console.log('🔐 Login request for:', phone);
  if (!phone || !password) {
    return res.json({ success: false, message: 'Phone and password are required' });
  }

  
  const { data: user } = await supabase
    .from('users')
    .select('id, name, phone, password')
    .eq('phone', phone)
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


router.post('/set-transaction-password', async (req, res) => {
  const { user_id, password, otp } = req.body;
  if (!user_id || !password || !otp) {
    return res.json({ success: false, message: 'All fields are required' });
  }

  const { data: user, error: userErr } = await supabase.from('users').select('phone').eq('id', user_id).single();
  if (userErr || !user) return res.json({ success: false, message: 'User not found' });

  try {
    const result = await client.verify.v2.services(process.env.TWILIO_VERIFY_SID).verificationChecks.create({ to: user.phone, code: otp });
    if (result.status !== 'approved') {
      return res.json({ success: false, message: 'Invalid or expired OTP' });
    }
    const encrypted = encrypt(password);
    const { error } = await supabase.from('users').update({ transaction_password: encrypted }).eq('id', user_id);
    if (error) return res.json({ success: false, message: error.message });
    res.json({ success: true, message: 'Transaction password set successfully!' });
  } catch (err) {
    res.json({ success: false, message: err.message });
  }
});



router.post('/send-otp-existing', async (req, res) => {
  const { phone } = req.body;
  console.log('📱 Send OTP (existing user) request for:', phone);
  if (!phone) return res.json({ success: false, message: 'Phone number is required' });

  // Only allow if user exists
  const { data: existingUser } = await supabase.from('users').select('id').eq('phone', phone).single();
  if (!existingUser) {
    return res.json({ success: false, message: 'User not found with this number.' });
  }

  try {
    await client.verify.v2.services(process.env.TWILIO_VERIFY_SID).verifications.create({ to: phone, channel: 'sms' });
    console.log('✅ OTP sent to (existing user):', phone);
    res.json({ success: true, message: 'OTP sent successfully' });
  } catch (err) {
    console.error('❌ Send OTP error:', err.message);
    res.json({ success: false, message: err.message });
  }
});


router.post('/check-transaction-password', async (req, res) => {
  const { user_id, password } = req.body;
  if (!user_id || !password) {
    return res.json({ success: false, message: 'All fields are required' });
  }

  const { data: user, error: userErr } = await supabase.from('users').select('transaction_password').eq('id', user_id).single();
  if (userErr || !user) return res.json({ success: false, message: 'User not found' });
  if (!user.transaction_password) return res.json({ success: false, message: 'Transaction password not set' });

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
const express  = require('express');
const router   = express.Router();
const multer   = require('multer');
const supabase = require('../supabase');
const { encrypt, decrypt } = require('../encryption');
const { getAppConfig, createNotification } = require('../helpers');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 },
});


// ── Helper: get current admin password (DB first, .env fallback) ──────────────
async function getAdminPassword() {
  try {
    const { data } = await supabase
      .from('admin_config')
      .select('password')
      .order('updated_at', { ascending: false })
      .limit(1)
      .single();

    if (data?.password) {
      try { return decrypt(data.password); } catch { /* fall through */ }
    }
  } catch { /* fall through */ }

  // Fallback to .env
  return process.env.ADMIN_PASSWORD || 'admin@dinero2024';
}


// ── Login ─────────────────────────────────────────────────────────────────────
router.post('/login', async (req, res) => {
  const { password } = req.body;
  const adminPassword = await getAdminPassword();
  if (password !== adminPassword) {
    return res.json({ success: false, message: 'Invalid password' });
  }
  res.json({ success: true, message: 'Welcome Admin' });
});


// ── Get admin password (decrypted, for dashboard display) ─────────────────────
router.get('/admin-password', async (req, res) => {
  try {
    const { data } = await supabase
      .from('admin_config')
      .select('password, updated_at')
      .order('updated_at', { ascending: false })
      .limit(1)
      .single();

    if (data?.password) {
      try {
        return res.json({
          success:    true,
          password:   decrypt(data.password),
          updated_at: data.updated_at,
          source:     'database',
        });
      } catch { /* fall through */ }
    }

    // No DB row — return .env value
    res.json({
      success:  true,
      password: process.env.ADMIN_PASSWORD || 'admin@dinero2024',
      source:   'env',
    });
  } catch (err) {
    res.json({ success: false, message: err.message });
  }
});


// ── Update admin password ─────────────────────────────────────────────────────
router.post('/admin-password', async (req, res) => {
  const { current_password, new_password } = req.body;

  if (!new_password || new_password.length < 6) {
    return res.json({ success: false, message: 'New password must be at least 6 characters' });
  }

  // Verify current password
  const adminPassword = await getAdminPassword();
  if (current_password !== adminPassword) {
    return res.json({ success: false, message: 'Current password is incorrect' });
  }

  let encryptedPassword;
  try {
    encryptedPassword = encrypt(new_password);
  } catch (err) {
    return res.json({ success: false, message: 'Encryption failed: ' + err.message });
  }

  const payload = {
    password:   encryptedPassword,
    updated_at: new Date().toISOString(),
  };

  // Check if row already exists
  const { data: existing } = await supabase
    .from('admin_config')
    .select('id')
    .order('updated_at', { ascending: false })
    .limit(1)
    .single();

  const { error } = existing
    ? await supabase.from('admin_config').update(payload).eq('id', existing.id)
    : await supabase.from('admin_config').insert([payload]);

  if (error) return res.json({ success: false, message: error.message });

  console.log('✅ Admin password updated');
  res.json({ success: true, message: 'Password updated successfully!' });
});


// ── Users ─────────────────────────────────────────────────────────────────────
router.get('/users', async (req, res) => {
  const { data, error } = await supabase
    .from('users')
    .select('id, name, phone, referral_code, bonus_balance, created_at')
    .order('created_at', { ascending: false });
  if (error) return res.json({ success: false, message: error.message });
  res.json({ success: true, users: data });
});


// ── User Detail ───────────────────────────────────────────────────────────────
router.get('/user/:user_id', async (req, res) => {
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
      referred_by_id:   referralRecord ? referralRecord.referred_by : null,
      bonus_amount:     referralRecord ? referralRecord.bonus_amount : 0,
      bonus_paid:       referralRecord ? referralRecord.bonus_paid   : false,
    },
    my_referrals: referredUsers,
    bank_card: bankCardData ? {
      ...bankCardData,
      card_number: (() => { try { return decrypt(bankCardData.card_number); } catch(e) { return bankCardData.card_number; } })(),
      card_holder: (() => { try { return decrypt(bankCardData.card_holder); } catch(e) { return bankCardData.card_holder; } })(),
    } : null,
  });
});


// ── Update Transaction Status ─────────────────────────────────────────────────
router.post('/update-status', async (req, res) => {
  const { table, id, status } = req.body;
  const allowedTables   = ['deposits', 'exchanges', 'withdrawals'];
  const allowedStatuses = ['completed', 'confirmed', 'failed', 'pending'];

  if (!allowedTables.includes(table))    return res.json({ success: false, message: 'Invalid table' });
  if (!allowedStatuses.includes(status)) return res.json({ success: false, message: 'Invalid status' });

  const { error } = await supabase.from(table).update({ status }).eq('id', id);
  if (error) return res.json({ success: false, message: error.message });

  const { data: record } = await supabase.from(table).select('*').eq('id', id).single();
  if (record) {
    const { recalculateAndUpdateUserBalance } = require('../helpers');
    if (table === 'deposits' && status === 'confirmed') {
      await createNotification(record.user_id, 'deposit', '✅ Deposit Confirmed',
        `Your deposit of ${parseFloat(record.amount).toFixed(2)} USDT has been confirmed.`);
      await recalculateAndUpdateUserBalance(record.user_id);
    } else if (table === 'exchanges' && status === 'completed') {
      await createNotification(record.user_id, 'exchange', '💱 Exchange Completed',
        `Your exchange of ${parseFloat(record.amount_from).toFixed(4)} USDT → ₹${parseFloat(record.amount_to).toFixed(2)} INR is complete.`);
      await recalculateAndUpdateUserBalance(record.user_id);
    } else if (table === 'withdrawals' && (status === 'confirmed' || status === 'completed')) {
      await createNotification(record.user_id, 'withdrawal', '💸 Withdrawal Confirmed',
        `Your withdrawal of ${parseFloat(record.amount).toFixed(2)} USDT has been processed.`);
      await recalculateAndUpdateUserBalance(record.user_id);
    } else if (status === 'failed') {
      const typeLabel = table === 'deposits' ? 'Deposit' : table === 'exchanges' ? 'Exchange' : 'Withdrawal';
      const amt = parseFloat(record.amount || record.amount_from || 0).toFixed(2);
      await createNotification(record.user_id, table, `❌ ${typeLabel} Failed`,
        `Your ${typeLabel.toLowerCase()} of ${amt} USDT was unsuccessful. Please contact support.`);
    }
  }

  console.log(`✅ Admin updated ${table} ${id} → ${status}`);
  res.json({ success: true, message: `Status updated to ${status}` });
});



router.post('/save-transaction-id', async (req, res) => {
  const { table, id, transaction_id } = req.body;
  const allowedTables = ['exchanges', 'withdrawals'];

  if (!allowedTables.includes(table)) {
    return res.json({ success: false, message: 'Invalid table. Only exchanges and withdrawals supported.' });
  }
  if (!transaction_id || !transaction_id.trim()) {
    return res.json({ success: false, message: 'Transaction ID is required.' });
  }
  if (!id) {
    return res.json({ success: false, message: 'Record ID is required.' });
  }

  const { error } = await supabase
    .from(table)
    .update({ transaction_id: transaction_id.trim() })
    .eq('id', id);

  if (error) return res.json({ success: false, message: error.message });

  console.log(`✅ Admin saved transaction_id for ${table} ${id}: ${transaction_id}`);
  res.json({ success: true, message: 'Transaction ID saved successfully.' });
});


// ── App Config GET ────────────────────────────────────────────────────────────
router.get('/app-config', async (req, res) => {
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


// ── App Config POST ───────────────────────────────────────────────────────────
router.post('/app-config', async (req, res) => {
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


// ── Upload QR ─────────────────────────────────────────────────────────────────
router.post('/upload-qr', upload.single('qr'), async (req, res) => {
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


// ── Export ────────────────────────────────────────────────────────────────────
async function exportData(type, res) {
  try {
    const { data: tracker } = await supabase
      .from('export_tracker').select('last_exported_at').eq('type', type).single();

    const cutoffTime = tracker?.last_exported_at || null;
    const now = new Date().toISOString();

    console.log(`📤 Export ${type} — cutoff: ${cutoffTime}`);

    let query = supabase.from(type).select('*').order('created_at', { ascending: false });
    if (cutoffTime) query = query.gt('created_at', cutoffTime);

    const { data, error } = await query;
    console.log(`📤 Export ${type} — records found: ${data?.length}, error: ${error?.message}`);

    if (error) return res.json({ success: false, message: error.message });

    if (data && data.length > 0) {
      await supabase.from('export_tracker').update({ last_exported_at: now }).eq('type', type);
    }

    const userIds = [...new Set((data || []).map(r => r.user_id).filter(Boolean))];
    const { data: users } = userIds.length > 0
      ? await supabase.from('users').select('id, name, phone').in('id', userIds)
      : { data: [] };

    const userMap = {};
    (users || []).forEach(u => { userMap[u.id] = u; });

    let headers, rows;

    if (type === 'exchanges') {
      headers = ['User ID', 'User Name', 'Phone', 'Amount (USDT)', 'INR Amount', 'Account Number', 'Account Name', 'IFSC Code', 'Rate', 'Fee', 'Status', 'Created At'];
      rows = (data || []).map(e => {
        const u = userMap[e.user_id] || {};
        return [
          e.user_id     || '',
          u.name        || '',
          u.phone       || '',
          e.amount_from || '',
          e.amount_to   || '',
          e.account_number ? (() => { try { return decrypt(e.account_number); } catch { return e.account_number; } })() : '',
          e.account_name   ? (() => { try { return decrypt(e.account_name);   } catch { return e.account_name;   } })() : '',
          e.ifsc_code   || '',
          e.rate        || '',
          e.fee         || 0,
          e.status      || '',
          e.created_at  || '',
        ];
      });
    } else {
      headers = ['User ID', 'User Name', 'Phone', 'Amount (USDT)', 'Wallet Address',  'Status', 'Created At'];
      rows = (data || []).map(w => {
        const u = userMap[w.user_id] || {};
        return [
          w.user_id     || '',
          u.name        || '',
          u.phone       || '',
          w.amount      || '',
          w.address     || '',
          w.status      || '',
          w.created_at  || '',
        ];
      });
    }

    const csv = [headers, ...rows]
      .map(r => r.map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(','))
      .join('\n');

    console.log(`📤 CSV rows: ${rows.length}`);

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${type}_export.csv"`);
    res.send('\uFEFF' + csv);

  } catch (err) {
    console.error('❌ Export error:', err.message);
    res.json({ success: false, message: err.message });
  }
}

router.get('/export/exchanges',   (req, res) => exportData('exchanges',   res));
router.get('/export/withdrawals', (req, res) => exportData('withdrawals', res));

module.exports = router;
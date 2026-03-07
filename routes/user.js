const express  = require('express');
const router   = express.Router();
const supabase = require('../supabase');
const { encrypt, decrypt } = require('../encryption');


router.get('/user/:user_id', async (req, res) => {
  const { user_id } = req.params;
  if (!user_id) return res.json({ success: false, message: 'User ID required' });

  const { data, error } = await supabase
    .from('users').select('id, name, phone, transaction_password').eq('id', user_id).single();
  if (error || !data) return res.json({ success: false, message: 'User not found' });
  res.json({ success: true, user: data });
});


router.get('/user-profile/:user_id', async (req, res) => {
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


router.get('/balances/:user_id', async (req, res) => {
  const { user_id } = req.params;
  if (!user_id) return res.json({ success: false, message: 'User ID required' });

  const { data: deposits,    error: depErr } = await supabase
    .from('deposits').select('amount').eq('user_id', user_id).eq('status', 'confirmed');
  const { data: exchanges,   error: exErr  } = await supabase
    .from('exchanges').select('amount_from, amount_to, from_currency, to_currency')
    .eq('user_id', user_id).eq('status', 'completed');
  const { data: withdrawals, error: wdErr  } = await supabase
    .from('withdrawals').select('amount').eq('user_id', user_id).in('status', ['confirmed', 'completed']);

  if (depErr || exErr || wdErr) {
    return res.json({ success: false, message: 'Failed to fetch balances' });
  }

  const totalDeposited = (deposits    || []).reduce((sum, d) => sum + parseFloat(d.amount), 0);
  const usdtSpent      = (exchanges   || []).filter(e => e.from_currency === 'USDT').reduce((sum, e) => sum + parseFloat(e.amount_from), 0);
  const totalWithdrawn = (withdrawals || []).reduce((sum, w) => sum + parseFloat(w.amount), 0);
  const inrReceived    = (exchanges   || []).filter(e => e.to_currency   === 'INR' ).reduce((sum, e) => sum + parseFloat(e.amount_to),   0);

  res.json({
    success:      true,
    usdt_balance: parseFloat((totalDeposited - usdtSpent - totalWithdrawn).toFixed(4)),
    inr_balance:  parseFloat(inrReceived.toFixed(2)),
  });
});


router.get('/bonus/:user_id', async (req, res) => {
  const { user_id } = req.params;
  const { data, error } = await supabase
    .from('users').select('bonus_balance').eq('id', user_id).single();
  if (error || !data) return res.json({ success: false, bonus_balance: 0 });
  res.json({ success: true, bonus_balance: parseFloat(data.bonus_balance || 0) });
});


router.get('/orders/:user_id', async (req, res) => {
  const { user_id } = req.params;
  if (!user_id) return res.json({ success: false, message: 'User ID required' });

  const { data: deposits,    error: depErr  } = await supabase.from('deposits').select('*').eq('user_id', user_id).order('created_at', { ascending: false });
  let   { data: exchanges,   error: exErr   } = await supabase.from('exchanges').select('*').eq('user_id', user_id).order('created_at', { ascending: false });
  let   { data: withdrawals, error: withErr } = await supabase.from('withdrawals').select('*').eq('user_id', user_id).order('created_at', { ascending: false });

  if (withdrawals && Array.isArray(withdrawals)) {
    withdrawals = withdrawals.map(w => ({
      ...w,
      account_number: w.account_number ? decrypt(w.account_number) : '',
      account_name:   w.account_name   ? decrypt(w.account_name)   : '',
    }));
  }

  if (exchanges && Array.isArray(exchanges)) {
    exchanges = exchanges.map(e => ({
      ...e,
      account_number: e.account_number ? decrypt(e.account_number) : '',
      account_name:   e.account_name   ? decrypt(e.account_name)   : '',
    }));
  }

  if (depErr || exErr || withErr) return res.json({ success: false, message: 'Failed to fetch orders' });
  res.json({ success: true, deposits, exchanges, withdrawals });
});


router.post('/bank-card', async (req, res) => {
  const { user_id, card_number, card_holder, bank_name, ifsc_code } = req.body;
  if (!user_id || !card_number || !card_holder || !bank_name) {
    return res.json({ success: false, message: 'All fields are required' });
  }

  try {
    // Check if this account number already exists for user (compare encrypted values would be hard,
    // so we fetch all cards for user and check decrypted values)
    const { data: existing } = await supabase
      .from('bank_cards').select('id, card_number').eq('user_id', user_id);

    if (existing && existing.length > 0) {
      for (const card of existing) {
        try {
          const decrypted = decrypt(card.card_number);
          if (decrypted === card_number.toString()) {
            return res.json({ success: false, message: 'This account number is already saved.' });
          }
        } catch (e) { /* skip decryption errors */ }
      }
    }

    const encryptedCardNumber = encrypt(card_number.toString());
    const encryptedCardHolder = encrypt(card_holder.toString());

    const { error } = await supabase
      .from('bank_cards')
      .insert([{ user_id, card_number: encryptedCardNumber, card_holder: encryptedCardHolder, bank_name, ifsc_code }]);

    if (error) return res.json({ success: false, message: error.message });
    res.json({ success: true, message: 'Bank card added successfully.' });
  } catch (err) {
    res.json({ success: false, message: err.message });
  }
});


router.get('/bank-cards/:user_id', async (req, res) => {
  const { user_id } = req.params;
  if (!user_id) return res.json({ success: false, message: 'User ID required' });

  const { data, error } = await supabase
    .from('bank_cards').select('*').eq('user_id', user_id).order('created_at', { ascending: false });

  if (error) return res.json({ success: false, message: error.message });
  if (!data || data.length === 0) return res.json({ success: true, cards: [] });

  const cards = data.map(card => {
    try {
      return {
        ...card,
        card_number: decrypt(card.card_number),
        card_holder: decrypt(card.card_holder),
      };
    } catch (e) {
      return { ...card, card_number: '', card_holder: '' };
    }
  });

  res.json({ success: true, cards });
});


router.get('/bank-card-by-id/:card_id', async (req, res) => {
  const { card_id } = req.params;
  if (!card_id) return res.json({ success: false, message: 'Card ID required' });

  const { data, error } = await supabase.from('bank_cards').select('*').eq('id', card_id).single();
  if (error || !data) return res.json({ success: false, message: 'Card not found' });

  try {
    data.card_number = decrypt(data.card_number);
    data.card_holder = decrypt(data.card_holder);
  } catch (e) {
    return res.json({ success: false, message: 'Decryption failed' });
  }
  res.json({ success: true, data });
});


router.delete('/bank-card/:card_id', async (req, res) => {
  const { card_id } = req.params;
  const { user_id } = req.body;

  if (!card_id) return res.json({ success: false, message: 'Card ID required' });

  // Verify ownership before deleting
  const { data: card, error: fetchErr } = await supabase
    .from('bank_cards').select('id, user_id').eq('id', card_id).single();

  if (fetchErr || !card) return res.json({ success: false, message: 'Card not found' });
  if (user_id && card.user_id !== user_id) {
    return res.json({ success: false, message: 'Unauthorized' });
  }

  const { error } = await supabase.from('bank_cards').delete().eq('id', card_id);
  if (error) return res.json({ success: false, message: error.message });
  res.json({ success: true, message: 'Bank card deleted.' });
});


router.get('/bank-card/:user_id', async (req, res) => {
  const { user_id } = req.params;
  if (!user_id) return res.json({ success: false, message: 'User ID required' });

  const { data, error } = await supabase
    .from('bank_cards').select('*').eq('user_id', user_id)
    .order('created_at', { ascending: false }).limit(1).single();

  if (error || !data) return res.json({ success: false, message: 'No bank card info found' });

  try {
    data.card_number = decrypt(data.card_number);
    data.card_holder = decrypt(data.card_holder);
  } catch (e) {
    return res.json({ success: false, message: 'Decryption failed' });
  }
  res.json({ success: true, data });
});

module.exports = router;
const express  = require('express');
const router   = express.Router();
const supabase = require('../supabase');
const { encrypt, decrypt } = require('../encryption');
const { getAppConfig, createNotification } = require('../helpers');

const USDT_CONTRACT       = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
const REFERRAL_COMMISSION = 0.0025; // 0.25%


router.post('/deposit', async (req, res) => {
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


router.post('/exchange', async (req, res) => {
  let { user_id, from_currency, to_currency, amount_from, fee, amount_after_fee, amount_to, rate, status, account_number, account_name, ifsc_code } = req.body;
  if (!user_id || !from_currency || !to_currency || !amount_from || !amount_to || !status) {
    return res.json({ success: false, message: 'All fields are required' });
  }

  if (account_number) account_number = encrypt(account_number.toString());
  if (account_name)   account_name   = encrypt(account_name.toString());

  const { error } = await supabase
    .from('exchanges')
    .insert([{ user_id, from_currency, to_currency, amount_from, fee, amount_after_fee, amount_to, rate, status, account_number, account_name, ifsc_code }]);

  if (error) return res.json({ success: false, message: error.message });

  
  const { data: referral } = await supabase
    .from('referrals').select('referred_by').eq('user_id', user_id).single();

  if (referral && referral.referred_by) {
    const bonusAmount = parseFloat((parseFloat(amount_after_fee) * REFERRAL_COMMISSION).toFixed(6));

    // 1. Add to referrer's bonus_balance
    const { data: referrer } = await supabase
      .from('users').select('bonus_balance').eq('id', referral.referred_by).single();
    const currentBonus = parseFloat(referrer?.bonus_balance || 0);
    const newBonus     = parseFloat((currentBonus + bonusAmount).toFixed(6));
    await supabase.from('users').update({ bonus_balance: newBonus }).eq('id', referral.referred_by);

    // 2. Accumulate in referrals table
    const { data: existingReferral } = await supabase
      .from('referrals').select('bonus_amount').eq('user_id', user_id).single();
    const currentReferralBonus = parseFloat(existingReferral?.bonus_amount || 0);
    const newReferralBonus     = parseFloat((currentReferralBonus + bonusAmount).toFixed(6));
    await supabase.from('referrals').update({ bonus_amount: newReferralBonus, bonus_paid: true }).eq('user_id', user_id);

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


router.post('/verify-transaction', async (req, res) => {
  const { txHash } = req.body;
  console.log('🔍 Verify transaction request:', txHash);
  if (!txHash) return res.json({ success: false, message: 'Transaction ID is required.' });

  try {
    const config        = await getAppConfig();
    const DEPOSIT_WALLET = decrypt(config.wallet_address);

    const response = await fetch(`https://apilist.tronscanapi.com/api/transaction-info?hash=${txHash.trim()}`);
    const data     = await response.json();

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
    const timestamp  = data.timestamp ? new Date(data.timestamp).toLocaleString() : 'N/A';

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



router.post('/withdraw', async (req, res) => {
  const { user_id, amount, address } = req.body;

  if (!user_id || !amount || !address) {
    return res.json({ success: false, message: 'user_id, amount and address are required.' });
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

  const { error } = await supabase.from('withdrawals').insert([
    { user_id, amount, address, status: 'pending' }
  ]);
  if (error) return res.json({ success: false, message: error.message });

  await supabase.from('notifications').insert([{
    user_id,
    type: 'withdrawal',
    title: 'Withdrawal Submitted',
    message: `Your withdrawal request for ${amount} USDT has been submitted and is pending review.`
  }]);

  console.log(`✅ Withdrawal submitted: ${amount} USDT for user ${user_id}`);
  res.json({ success: true, message: 'Withdrawal request submitted successfully!' });
});


router.get('/withdrawals/:user_id', async (req, res) => {
  const { user_id } = req.params;
  const { data, error } = await supabase
    .from('withdrawals').select('*').eq('user_id', user_id).order('created_at', { ascending: false });
  if (error) return res.json({ success: false, message: error.message });
  // Decrypt account_number and account_name if present
  const withdrawals = (data || []).map(w => {
    if (w.account_number) {
      try { w.account_number = decrypt(w.account_number); } catch (e) { /* ignore */ }
    }
    if (w.account_name) {
      try { w.account_name = decrypt(w.account_name); } catch (e) { /* ignore */ }
    }
    return w;
  });
  res.json({ success: true, withdrawals });
});


router.post('/withdraw-bonus', async (req, res) => {
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

module.exports = router;
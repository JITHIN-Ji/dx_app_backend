const supabase = require('./supabase');


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

async function createNotification(user_id, type, title, message) {
  await supabase.from('notifications').insert([{ user_id, type, title, message }]);
}


async function recalculateAndUpdateUserBalance(user_id) {
  
  const { data: deposits } = await supabase.from('deposits').select('amount').eq('user_id', user_id).eq('status', 'confirmed');
  
  const { data: exchanges } = await supabase.from('exchanges').select('amount_from').eq('user_id', user_id).eq('status', 'completed');
  
  const { data: withdrawals } = await supabase.from('withdrawals').select('amount').eq('user_id', user_id).in('status', ['confirmed', 'completed']);

  const totalDeposited = (deposits    || []).reduce((s, d) => s + parseFloat(d.amount), 0);
  const totalExchanged = (exchanges   || []).reduce((s, e) => s + parseFloat(e.amount_from), 0);
  const totalWithdrawn = (withdrawals || []).reduce((s, w) => s + parseFloat(w.amount), 0);
  const balance = parseFloat((totalDeposited - totalExchanged - totalWithdrawn).toFixed(6));

  await supabase.from('users').update({ balance }).eq('id', user_id);
}

module.exports = { generateReferralCode, getUniqueReferralCode, getAppConfig, createNotification, recalculateAndUpdateUserBalance };
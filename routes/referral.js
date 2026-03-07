const express  = require('express');
const router   = express.Router();
const supabase = require('../supabase');


router.get('/team/:user_id', async (req, res) => {
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
      name:         u?.name  || 'Unknown',
      phone:        u?.phone || '',
      joined_at:    u?.created_at || r.created_at,
      bonus_amount: parseFloat(r.bonus_amount || 0),
      bonus_paid:   r.bonus_paid,
    };
  });

  const total_bonus = members.reduce((s, m) => s + m.bonus_amount, 0);
  res.json({ success: true, members, total_bonus: parseFloat(total_bonus.toFixed(6)) });
});


router.get('/check-referral/:user_id', async (req, res) => {
  const { user_id } = req.params;
  const { data } = await supabase.from('referrals').select('id').eq('user_id', user_id).single();
  res.json({ success: true, has_referral: !!data });
});


router.post('/validate-referral-code', async (req, res) => {
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


router.post('/apply-referral', async (req, res) => {
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

module.exports = router;
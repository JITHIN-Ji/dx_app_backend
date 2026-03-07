const express  = require('express');
const router   = express.Router();
const supabase = require('../supabase');


router.get('/notifications/:user_id', async (req, res) => {
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


router.post('/notifications/read-all/:user_id', async (req, res) => {
  const { user_id } = req.params;
  const { error } = await supabase
    .from('notifications')
    .update({ is_read: true })
    .eq('user_id', user_id)
    .eq('is_read', false);
  if (error) return res.json({ success: false, message: error.message });
  res.json({ success: true });
});


router.post('/notifications/read/:notif_id', async (req, res) => {
  const { notif_id } = req.params;
  const { error } = await supabase
    .from('notifications')
    .update({ is_read: true })
    .eq('id', notif_id);
  if (error) return res.json({ success: false, message: error.message });
  res.json({ success: true });
});

module.exports = router;
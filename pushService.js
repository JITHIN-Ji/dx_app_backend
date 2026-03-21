const { Expo } = require('expo-server-sdk');
const expo = new Expo();

async function sendPushNotification(pushToken, title, body) {
  if (!pushToken || !Expo.isExpoPushToken(pushToken)) return;
  try {
    await expo.sendPushNotificationsAsync([{
      to: pushToken,
      sound: 'default',
      title,
      body,
      priority: 'high',
    }]);
    console.log(`📲 Push sent: ${title}`);
  } catch (err) {
    console.error('Push error:', err.message);
  }
}

module.exports = { sendPushNotification };
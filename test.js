const { Expo } = require('expo-server-sdk');
const expo = new Expo();

async function test() {
  const result = await expo.sendPushNotificationsAsync([{
    to: 'ExponentPushToken[8Yh0VnLDygaSeLA0AoTNFm]',
    sound: 'default',
    title: '🔔 Test Notification',
    body: 'Push notifications are working!',
    channelId: 'default',
  }]);
  console.log('Result:', JSON.stringify(result, null, 2));
}

test();
// decrypt-password.js
require('dotenv').config(); // loads your .env
const { decrypt } = require('./encryption'); // adjust path if needed

const encryptedFromDB = 'bcb5b68b95c9985a9b66d841927117a5:da69d2cb96cc833ac3caae7307ad897dcc27182a1532c0d13f6d8c3cae1c6b51'; // iv:encryptedtext

try {
  console.log('Decrypted password:', decrypt(encryptedFromDB));
} catch (e) {
  console.error('Failed:', e.message);
}
/**
 * Expo Push Notification utility.
 * Sends push notifications via Expo's push service so they appear
 * on the phone even when the app is not open.
 *
 * Expo push API docs: https://docs.expo.dev/push-notifications/sending-notifications/
 */

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';

/**
 * Send push notifications to one or more Expo push tokens.
 *
 * @param {Array<{ pushToken: string, title: string, body: string, data?: object }>} messages
 * @returns {Promise<void>}
 */
async function sendPushNotifications(messages) {
  if (!messages || messages.length === 0) return;

  // Build the payload array Expo expects
  const payload = messages
    .filter(m => m.pushToken && m.pushToken.startsWith('ExponentPushToken'))
    .map(m => ({
      to: m.pushToken,
      sound: 'default',
      title: m.title,
      body: m.body,
      data: m.data || {},
      priority: 'high',
      channelId: 'default',
    }));

  if (payload.length === 0) return;

  // Expo accepts up to 100 per request; chunk if needed
  const chunks = [];
  for (let i = 0; i < payload.length; i += 100) {
    chunks.push(payload.slice(i, i + 100));
  }

  for (const chunk of chunks) {
    try {
      const res = await fetch(EXPO_PUSH_URL, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Accept-encoding': 'gzip, deflate',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(chunk),
      });

      const result = await res.json();

      // Log any errors from Expo's response
      if (result.data) {
        result.data.forEach((ticket, idx) => {
          if (ticket.status === 'error') {
            console.error(`📱 Push error for token ${chunk[idx].to}:`, ticket.message);
          }
        });
      }
    } catch (err) {
      console.error('📱 Failed to send push notifications:', err);
    }
  }
}

/**
 * Convenience: send a push notification to a single user.
 * Looks up the user's push tokens and sends.
 *
 * @param {object} User - Mongoose User model
 * @param {string} userId - User ID to notify
 * @param {string} title
 * @param {string} body
 * @param {object} data - optional extra data payload
 */
async function sendPushToUser(User, userId, title, body, data = {}) {
  try {
    const user = await User.findById(userId).select('expoPushTokens');
    if (!user || !user.expoPushTokens || user.expoPushTokens.length === 0) return;

    const messages = user.expoPushTokens.map(token => ({
      pushToken: token,
      title,
      body,
      data,
    }));

    await sendPushNotifications(messages);
  } catch (err) {
    console.error(`📱 sendPushToUser error for ${userId}:`, err);
  }
}

module.exports = { sendPushNotifications, sendPushToUser };

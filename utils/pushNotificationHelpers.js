/**
 * Push Notification Helper Functions
 * Reusable utilities for sending push notifications with advanced features
 */

const { sendPushToUser } = require('./pushNotification');

/**
 * Send push to multiple users with error handling
 * @param {Array} userIds - Array of user IDs
 * @param {string} title - Notification title
 * @param {string} body - Notification body
 * @param {object} data - Optional metadata
 * @returns {Promise<{sent: Array, failed: Array}>}
 */
async function sendPushToMultipleUsers(userIds, title, body, data) {
  const results = {
    sent: [],
    failed: []
  };

  for (const userId of userIds) {
    try {
      await sendPushToUser(require('../models/User'), userId, title, body, data);
      results.sent.push(userId);
    } catch (error) {
      console.error(`Failed to send push to ${userId}:`, error);
      results.failed.push({ userId, error: error.message });
    }
  }

  return results;
}

/**
 * Rate-limited push send (cooldown between messages to same user)
 * @param {string} userId - User ID
 * @param {string} title - Notification title
 * @param {string} body - Notification body
 * @param {object} data - Optional metadata
 * @param {number} cooldownMs - Cooldown period in milliseconds (default 60 seconds)
 * @returns {Promise<boolean>} - True if sent, false if skipped due to cooldown
 */
async function sendPushRateLimited(userId, title, body, data, cooldownMs = 60000) {
  try {
    const User = require('../models/User');
    const user = await User.findById(userId);
    if (!user) return false;

    const now = Date.now();
    if (user.lastPushTime && (now - user.lastPushTime) < cooldownMs) {
      console.log(`⏱️  Cooldown active for ${userId}, skipping push`);
      return false;
    }

    await sendPushToUser(User, userId, title, body, data);
    user.lastPushTime = now;
    await user.save();
    return true;
  } catch (error) {
    console.error('Error sending rate-limited push:', error);
    return false;
  }
}

/**
 * Send push with retry logic
 * @param {string} userId - User ID
 * @param {string} title - Notification title
 * @param {string} body - Notification body
 * @param {object} data - Optional metadata
 * @param {number} maxRetries - Max retry attempts (default 3)
 * @returns {Promise<boolean>} - True if sent successfully
 */
async function sendPushWithRetry(userId, title, body, data, maxRetries = 3) {
  const User = require('../models/User');

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`📤 Attempt ${attempt}/${maxRetries} to send push to ${userId}`);
      await sendPushToUser(User, userId, title, body, data);
      console.log(`✅ Push sent on attempt ${attempt}`);
      return true;
    } catch (error) {
      console.error(`❌ Attempt ${attempt} failed:`, error.message);

      if (attempt < maxRetries) {
        // Wait before retry (exponential backoff)
        const delayMs = Math.pow(2, attempt) * 1000;
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }
    }
  }

  console.error(`❌ Failed to send push after ${maxRetries} attempts`);
  return false;
}

/**
 * Clean expired tokens for a user
 * @param {string} userId - User ID
 * @returns {Promise<number>} - Number of tokens removed
 */
async function cleanUserTokens(userId) {
  try {
    const User = require('../models/User');
    const user = await User.findById(userId);
    if (!user?.expoPushTokens) return 0;

    const validTokens = user.expoPushTokens.filter(
      t => t && t.startsWith('ExponentPushToken[')
    );

    const removed = user.expoPushTokens.length - validTokens.length;
    if (removed > 0) {
      user.expoPushTokens = validTokens;
      await user.save();
      console.log(`🧹 Cleaned ${removed} tokens for user ${userId}`);
    }

    return removed;
  } catch (error) {
    console.error('Error cleaning tokens:', error);
    return 0;
  }
}

/**
 * Clean all expired tokens in database
 * @returns {Promise<number>} - Total tokens removed
 */
async function cleanAllExpiredTokens() {
  try {
    const User = require('../models/User');
    const users = await User.find({ expoPushTokens: { $exists: true, $ne: [] } });

    let totalRemoved = 0;
    for (const user of users) {
      const removed = await cleanUserTokens(user._id);
      totalRemoved += removed;
    }

    console.log(`✅ Cleaned ${totalRemoved} expired tokens total`);
    return totalRemoved;
  } catch (error) {
    console.error('Error cleaning all tokens:', error);
    return 0;
  }
}

/**
 * Send broadcast to all users with a specific role
 * @param {string} title - Notification title
 * @param {string} body - Notification body
 * @param {string} role - 'admin', 'user', or undefined for all
 * @param {object} data - Optional metadata
 * @returns {Promise<{success: number, failed: number}>}
 */
async function sendBroadcastByRole(title, body, role, data) {
  try {
    const User = require('../models/User');
    const filter = { isActive: true };

    if (role === 'admin') {
      filter.isAdmin = true;
    } else if (role === 'user') {
      filter.isAdmin = false;
    }

    const users = await User.find(filter).select('_id');
    const results = await sendPushToMultipleUsers(
      users.map(u => u._id),
      title,
      body,
      data
    );

    return {
      success: results.sent.length,
      failed: results.failed.length
    };
  } catch (error) {
    console.error('Error sending broadcast by role:', error);
    return { success: 0, failed: 0 };
  }
}

/**
 * Send maintenance notification to all users
 * @param {string} title - Maintenance title
 * @param {string} body - Maintenance description
 * @returns {Promise<{success: number, failed: number}>}
 */
async function sendMaintenanceNotice(title, body) {
  return sendBroadcastByRole(
    title || 'System Maintenance',
    body || 'We are performing scheduled maintenance',
    undefined,
    { type: 'maintenance', severity: 'high' }
  );
}

/**
 * Get push notification statistics for a user
 * @param {string} userId - User ID
 * @returns {Promise<object>} - Token count, last push time, etc.
 */
async function getPushStats(userId) {
  try {
    const User = require('../models/User');
    const user = await User.findById(userId).select('expoPushTokens lastPushTime');

    return {
      userId,
      tokenCount: user?.expoPushTokens?.length || 0,
      lastPushTime: user?.lastPushTime || null,
      hasTokens: (user?.expoPushTokens?.length || 0) > 0
    };
  } catch (error) {
    console.error('Error getting push stats:', error);
    return { userId, tokenCount: 0, hasTokens: false };
  }
}

/**
 * Unregister push token from a user (e.g., on logout)
 * @param {string} userId - User ID
 * @param {string} token - Push token to remove
 * @returns {Promise<boolean>}
 */
async function removeUserToken(userId, token) {
  try {
    const User = require('../models/User');
    const user = await User.findById(userId);
    if (!user) return false;

    if (user.expoPushTokens) {
      user.expoPushTokens = user.expoPushTokens.filter(t => t !== token);
      await user.save();
      console.log(`✅ Token removed for user ${userId}`);
      return true;
    }
    return false;
  } catch (error) {
    console.error('Error removing token:', error);
    return false;
  }
}

/**
 * Get users with active push tokens
 * @param {number} limit - Max results (default 100)
 * @returns {Promise<Array>} - Users with push tokens
 */
async function getUsersWithTokens(limit = 100) {
  try {
    const User = require('../models/User');
    const users = await User.find(
      { expoPushTokens: { $exists: true, $ne: [] } }
    ).select('_id email expoPushTokens').limit(limit);

    return users.map(u => ({
      userId: u._id,
      email: u.email,
      tokenCount: u.expoPushTokens.length
    }));
  } catch (error) {
    console.error('Error getting users with tokens:', error);
    return [];
  }
}

module.exports = {
  sendPushToMultipleUsers,
  sendPushRateLimited,
  sendPushWithRetry,
  cleanUserTokens,
  cleanAllExpiredTokens,
  sendBroadcastByRole,
  sendMaintenanceNotice,
  getPushStats,
  removeUserToken,
  getUsersWithTokens
};

// Shop tablet accounts: the admin accounts listed in CUSTOMER_TABLET_ADMINS
// (comma-separated emails). Such an account is a kiosk: it can only list
// customers and open their accounts, and loses every other admin right. When
// the setting is empty there is no tablet account.
const tabletAdminEmails = () => String(process.env.CUSTOMER_TABLET_ADMINS || '')
  .split(',')
  .map(email => email.trim().toLowerCase())
  .filter(Boolean);

// `user` is the account as stored in the database.
const isTabletAccount = (user) => {
  if (!user?.isAdmin || !user.email) return false;
  return tabletAdminEmails().includes(String(user.email).trim().toLowerCase());
};

module.exports = { isTabletAccount };

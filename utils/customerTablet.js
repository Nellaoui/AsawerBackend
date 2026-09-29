// Opening a customer's account on the shop tablet is limited to the admin
// accounts listed in CUSTOMER_TABLET_ADMINS (comma-separated emails). When the
// setting is empty nobody can open customer accounts.
const tabletAdminEmails = () => String(process.env.CUSTOMER_TABLET_ADMINS || '')
  .split(',')
  .map(email => email.trim().toLowerCase())
  .filter(Boolean);

const canUseCustomerTablet = (user) => {
  if (!user?.isAdmin || !user.email) return false;
  return tabletAdminEmails().includes(String(user.email).trim().toLowerCase());
};

const customerTabletAuth = (req, res, next) => {
  if (!canUseCustomerTablet(req.user)) {
    return res.status(403).json({ message: 'This admin account cannot open customer accounts.' });
  }
  return next();
};

module.exports = { canUseCustomerTablet, customerTabletAuth };

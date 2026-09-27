const express = require('express');
const path = require('path');

const router = express.Router();
const portalDirectory = path.join(__dirname, 'portal');

function servePortal(page) {
  return (req, res) => {
    res.set({
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    });
    res.sendFile(path.join(portalDirectory, page));
  };
}

// Product size/height/clasp rules, shared with the backend routes.
router.get('/product-options.js', (req, res) => {
  res.set({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.type('application/javascript').sendFile(path.join(portalDirectory, '..', 'utils', 'productOptions.js'));
});
router.get('/workflow', servePortal('workflow.html'));
router.get('/inventory-embed', (req, res, next) => {
  if (req.query.embedded !== '1') return res.redirect(302, '/admin/workflow');
  next();
}, servePortal('index.html'));
router.get('/manage-inventory', (req, res) => res.redirect(302, '/admin/workflow'));

module.exports = router;

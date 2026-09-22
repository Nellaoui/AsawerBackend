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

router.get('/workflow', servePortal('workflow.html'));
router.get('/inventory-embed', servePortal('index.html'));
router.get('/manage-inventory', (req, res) => res.redirect(302, '/admin/workflow'));

module.exports = router;

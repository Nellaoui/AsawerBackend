const crypto = require('crypto');
const path = require('path');
const mongoose = require('mongoose');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const User = require('../models/User');

const accounts = [
  { name: 'Asawer Stock', email: 'stock@asawer.team', workRole: 'stock' },
  { name: 'Asawer Customer Service', email: 'customer.service@asawer.team', workRole: 'customer_service' },
  { name: 'Asawer Boss Models', email: 'boss.models@asawer.team', workRole: 'boss' },
  { name: 'Asawer Wax Printing', email: 'wax.print@asawer.team', workRole: 'wax_print' },
  { name: 'Asawer Resin Printing', email: 'resin.print@asawer.team', workRole: 'resin_print' },
  { name: 'Asawer Quality', email: 'quality@asawer.team', workRole: 'quality' },
  { name: 'Asawer Packing', email: 'packing@asawer.team', workRole: 'packing' }
];

const makeTemporaryPassword = () => `${crypto.randomBytes(12).toString('base64url')}!A7`;

async function main() {
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is not configured');
  await mongoose.connect(process.env.MONGODB_URI);

  const existing = await User.find({ email: { $in: accounts.map(account => account.email) } })
    .select('email role workRole isActive')
    .lean();

  if (process.argv.includes('--check')) {
    console.log(JSON.stringify({
      planned: accounts,
      existing: existing.map(user => ({
        email: user.email,
        role: user.role,
        workRole: user.workRole,
        isActive: user.isActive !== false
      }))
    }, null, 2));
    return;
  }

  const existingEmails = new Set(existing.map(user => user.email));
  const created = [];
  const skipped = [];

  for (const account of accounts) {
    if (existingEmails.has(account.email)) {
      skipped.push({ email: account.email, reason: 'already exists' });
      continue;
    }

    const password = makeTemporaryPassword();
    const user = new User({
      ...account,
      password,
      role: 'employee',
      isAdmin: false,
      isActive: true
    });
    await user.save();
    created.push({ ...account, password });
  }

  console.log(JSON.stringify({ created, skipped }, null, 2));
}

main()
  .catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect();
  });

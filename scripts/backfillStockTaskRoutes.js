// Copy each open stock picking task's Wax/Resin route from its order item, so
// the Wax/Resin filters include stock work created before tasks carried it.
// Dry run by default; pass --apply to write.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const mongoose = require('mongoose');
const WorkflowCase = require('../models/WorkflowCase');
const Order = require('../models/Order');

const apply = process.argv.includes('--apply');

(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  const cases = await WorkflowCase.find({
    requestType: 'stock_pick',
    status: 'stock_picking',
    productionMethod: { $nin: ['wax', 'resin'] },
    orderId: { $ne: null }
  }).select('orderId orderItemId requestedName').lean();

  const orders = await Order.find({ _id: { $in: [...new Set(cases.map(item => String(item.orderId)))] } })
    .select('orderNumber items._id items.productionMethod').lean();
  const routeByItem = new Map(orders.flatMap(order => order.items.map(item => [String(item._id), item.productionMethod])));

  let updated = 0;
  for (const item of cases) {
    const method = routeByItem.get(String(item.orderItemId));
    if (!['wax', 'resin'].includes(method)) continue;
    console.log(`${apply ? 'Set' : 'Would set'} ${item.requestedName} (${item._id}) → ${method}`);
    if (apply) await WorkflowCase.updateOne({ _id: item._id }, { $set: { productionMethod: method } });
    updated += 1;
  }
  console.log(`${cases.length} open stock task(s) without a route; ${updated} ${apply ? 'updated' : 'can be updated'}.`);
  await mongoose.disconnect();
})().catch(error => {
  console.error(error);
  process.exit(1);
});

const terminalOrderStatuses = new Set(['delivered', 'cancelled']);
const closedTaskStatuses = new Set(['completed', 'cancelled', 'rejected']);

const idOf = value => String(value?._id || value?.id || value || '');
const textOf = value => String(value || '').trim();

const minutesBetween = (start, end) => {
  if (!start || !end) return null;
  return Math.max(Math.round((new Date(end).getTime() - new Date(start).getTime()) / 60000), 0);
};

const rankedCounts = counts => [...counts.entries()]
  .map(([value, count]) => ({ value, count }))
  .sort((left, right) => right.count - left.count || left.value.localeCompare(right.value));

function buildCustomerInsights(orders = [], workflowCases = [], now = new Date()) {
  const validOrders = orders.filter(order => order.status !== 'cancelled');
  const productStats = new Map();
  const typeCounts = new Map();
  const sizeCounts = new Map();
  const routeBreakdown = { wax: 0, resin: 0, stock: 0, undecided: 0 };

  for (const order of validOrders) {
    for (const item of order.items || []) {
      const product = item.productId || {};
      const productId = idOf(product);
      const quantity = Number(item.quantity || 0);
      const size = textOf(item.size || product.size);
      const type = textOf(product.type);
      const route = ['wax', 'resin'].includes(item.productionMethod)
        ? item.productionMethod
        : Number(item.printQuantity || 0) > 0 ? 'undecided' : 'stock';

      routeBreakdown[route] += quantity;
      if (size) sizeCounts.set(size, (sizeCounts.get(size) || 0) + quantity);
      if (type) typeCounts.set(type, (typeCounts.get(type) || 0) + quantity);
      if (!productId) continue;

      const current = productStats.get(productId) || {
        productId,
        name: product.name || item.name || 'Product',
        reference: product.serialNumber || '',
        imageUrl: product.imageUrl || '',
        type,
        orderCount: 0,
        quantity: 0,
        lastOrderedAt: null,
        sizes: new Map()
      };
      current.orderCount += 1;
      current.quantity += quantity;
      if (size) current.sizes.set(size, (current.sizes.get(size) || 0) + quantity);
      if (!current.lastOrderedAt || new Date(order.createdAt) > new Date(current.lastOrderedAt)) {
        current.lastOrderedAt = order.createdAt;
      }
      productStats.set(productId, current);
    }
  }

  const topProducts = [...productStats.values()]
    .map(item => ({
      ...item,
      sizes: rankedCounts(item.sizes).slice(0, 5)
    }))
    .sort((left, right) => right.quantity - left.quantity || right.orderCount - left.orderCount)
    .slice(0, 10);

  const activeCases = workflowCases.filter(item => !closedTaskStatuses.has(item.status));
  const stageCounts = {};
  let blockedTasks = 0;
  let lateTasks = 0;
  let printFailures = 0;
  for (const item of workflowCases) {
    if (!closedTaskStatuses.has(item.status)) {
      stageCounts[item.status] = (stageCounts[item.status] || 0) + 1;
      if (item.isBlocked) blockedTasks += 1;
      const start = item.deadlineAt || item.assignedAt || item.stageQueuedAt || item.createdAt;
      const deadline = item.deadlineAt
        ? new Date(item.deadlineAt)
        : start ? new Date(new Date(start).getTime() + Number(item.targetMinutes || 120) * 60000) : null;
      if (deadline && deadline < now) lateTasks += 1;
    }
    for (const event of item.history || []) {
      if (event.action === 'status_changed'
        && ['printing', 'quality_check'].includes(event.fromStatus)
        && ['ready_to_print', 'modeling'].includes(event.toStatus)) printFailures += 1;
    }
  }

  const completedDurations = validOrders
    .filter(order => ['shipped', 'delivered'].includes(order.status))
    .map(order => minutesBetween(order.createdAt, order.updatedAt))
    .filter(value => value !== null);
  const totalSpent = validOrders.reduce((sum, order) => sum + Number(order.totalAmount || 0), 0);
  const totalUnits = validOrders.reduce((sum, order) => sum + (order.items || []).reduce((itemSum, item) => itemSum + Number(item.quantity || 0), 0), 0);

  return {
    metrics: {
      totalOrders: validOrders.length,
      cancelledOrders: orders.length - validOrders.length,
      activeOrders: validOrders.filter(order => !terminalOrderStatuses.has(order.status)).length,
      totalUnits,
      totalSpent,
      averageOrderValue: validOrders.length ? Math.round((totalSpent / validOrders.length) * 100) / 100 : null,
      averageCompletionMinutes: completedDurations.length
        ? Math.round(completedDurations.reduce((sum, value) => sum + value, 0) / completedDurations.length)
        : null,
      lastOrderAt: validOrders[0]?.createdAt || null,
      blockedTasks,
      lateTasks,
      printFailures
    },
    routeBreakdown,
    stageCounts,
    topProducts,
    topSizes: rankedCounts(sizeCounts).slice(0, 10),
    topTypes: rankedCounts(typeCounts).slice(0, 10),
    activeCaseCount: activeCases.length,
    productStats
  };
}

function recommendProducts({ products = [], insights, wishlistProductIds = [], globalProductUnits = new Map(), forcedProductionMethod = 'automatic' }) {
  const purchased = insights.productStats || new Map();
  const favoriteTypes = new Set((insights.topTypes || []).slice(0, 3).map(item => item.value));
  const favoriteSizes = new Set((insights.topSizes || []).slice(0, 5).map(item => item.value));
  const wishlist = new Set(wishlistProductIds.map(String));
  const purchasedIds = new Set(purchased.keys());

  return products.map(product => {
    const productId = idOf(product);
    const imageUrl = textOf(product.imageUrl);
    const printable = product.fulfillmentPolicy !== 'stock_only';
    if (!productId || product.isActive === false || !imageUrl || /placeholder/i.test(imageUrl)) return null;
    if (printable && !['wax', 'resin'].includes(product.printMethod)) return null;
    if (['wax', 'resin'].includes(forcedProductionMethod)
      && printable
      && product.printMethod !== forcedProductionMethod) return null;

    let score = 0;
    const reasons = [];
    const previous = purchased.get(productId);
    if (previous) {
      score += Math.min(40, 18 + previous.quantity * 3);
      reasons.push(`ordered ${previous.quantity} before`);
    }
    if (wishlist.has(productId)) {
      score += 35;
      reasons.push('saved in wishlist');
    }
    if (product.type && favoriteTypes.has(product.type)) {
      score += 22;
      reasons.push(`matches preferred ${product.type}`);
    }
    const productSizes = new Set([product.size, ...(product.availableSizes || [])].map(textOf).filter(Boolean));
    const matchingSizes = [...productSizes].filter(size => favoriteSizes.has(size));
    if (matchingSizes.length) {
      score += 18;
      reasons.push(`available in preferred size ${matchingSizes[0]}`);
    }
    const relatedToHistory = (product.relatedProducts || []).some(item => purchasedIds.has(idOf(item)));
    if (relatedToHistory) {
      score += 15;
      reasons.push('related to a previous purchase');
    }
    const popularity = Number(globalProductUnits.get(productId) || 0);
    if (popularity > 0) {
      score += Math.min(15, Math.ceil(Math.log2(popularity + 1) * 3));
      reasons.push('popular with customers');
    }
    if (!score) return null;

    return {
      productId,
      name: product.name,
      reference: product.serialNumber,
      imageUrl: product.imageUrl,
      type: product.type,
      price: Number(product.price || 0),
      printMethod: product.printMethod,
      score,
      reasons: reasons.slice(0, 4)
    };
  }).filter(Boolean)
    .sort((left, right) => right.score - left.score || left.name.localeCompare(right.name))
    .slice(0, 8);
}

module.exports = { buildCustomerInsights, recommendProducts };

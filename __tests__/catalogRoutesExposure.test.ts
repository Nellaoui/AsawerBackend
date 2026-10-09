jest.mock('../middlewares/auth', () => ({ auth: (req: any, res: any, next: any) => next() }));
jest.mock('../utils/pushNotification', () => ({ sendPushToUser: jest.fn() }));
jest.mock('../models/Catalog', () => ({ find: jest.fn(), populate: jest.fn() }));

const router = require('../routes/catalogs');

// These two were unauthenticated: one made every catalog public, the other
// listed every catalog with its owner and allowed users.
describe('catalog routes no longer expose unauthenticated maintenance endpoints', () => {
  const paths: string[] = router.stack.filter((layer: any) => layer.route).map((layer: any) => layer.route.path);

  test('migrate-public is not registered', () => {
    expect(paths).not.toContain('/migrate-public');
  });

  test('debug-all is not registered', () => {
    expect(paths).not.toContain('/debug-all');
  });

  test('no catalog route is registered without the auth middleware', () => {
    const open = router.stack
      .filter((layer: any) => layer.route)
      .filter((layer: any) => layer.route.stack.length < 2)
      .map((layer: any) => layer.route.path);
    expect(open).toEqual([]);
  });
});

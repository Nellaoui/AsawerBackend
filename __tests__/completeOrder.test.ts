export {};

const Order = require('../models/Order');
const { completeOrder } = require('../utils/completeOrder');

const withStatus = (status: string | null) => jest.spyOn(Order, 'findById').mockReturnValue({
  select: () => ({ lean: async () => (status ? { status } : null) })
});

describe('the last handover completes the order', () => {
  afterEach(() => jest.restoreAllMocks());

  test.each(['confirmed', 'picking', 'packed'])('a %s order goes through shipped to delivered', async (status) => {
    withStatus(status);
    const move = jest.fn().mockResolvedValue({});
    expect(await completeOrder('o1', 'staff', move)).toEqual({ completed: true, status: 'delivered' });
    expect(move.mock.calls.map((call: any) => call[1])).toEqual(['shipped', 'delivered']);
  });

  test('a shipped order only needs the last step', async () => {
    withStatus('shipped');
    const move = jest.fn().mockResolvedValue({});
    await completeOrder('o1', 'staff', move);
    expect(move.mock.calls.map((call: any) => call[1])).toEqual(['delivered']);
  });

  test.each(['delivered', 'pending', 'cancelled'])('a %s order is left as it is', async (status) => {
    withStatus(status);
    const move = jest.fn();
    const result = await completeOrder('o1', 'staff', move);
    expect(move).not.toHaveBeenCalled();
    expect(result.completed).toBe(status === 'delivered');
  });

  test('a refused stock step stops before delivered and the error reaches the caller', async () => {
    withStatus('confirmed');
    const move = jest.fn().mockRejectedValue(new Error('Reserved inventory is inconsistent'));
    await expect(completeOrder('o1', 'staff', move)).rejects.toThrow(/inconsistent/);
    expect(move).toHaveBeenCalledTimes(1);
  });
});

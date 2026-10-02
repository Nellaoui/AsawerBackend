// Shop working hours, used to time workflow steps. A step done by a person only
// counts the hours the shop is open, so nights and closed days do not make a task
// look like it took 75 hours. Printing is done by machines that also run at night,
// so it keeps counting the full clock. Used by the backend routes and loaded as-is
// by the operations portal (window.WorkingTime), so both count time the same way.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.WorkingTime = api;
})(typeof self !== 'undefined' ? self : this, function () {
  const SHOP_HOURS = {
    timeZone: 'Africa/Casablanca',
    openMinute: 9 * 60,
    closeMinute: 19 * 60,
    // 0 is Sunday.
    closedDays: [0]
  };
  const CLOCK_STEPS = ['printing'];
  const DAY_MS = 24 * 60 * 60 * 1000;
  const MAX_DAYS = 400;

  const partsFormat = new Intl.DateTimeFormat('en-US', {
    timeZone: SHOP_HOURS.timeZone,
    year: 'numeric', month: 'numeric', day: 'numeric',
    hour: 'numeric', minute: 'numeric', second: 'numeric', hourCycle: 'h23'
  });

  // How far the shop's clock is ahead of UTC at this moment.
  const offsetMs = (ms) => {
    const parts = {};
    for (const part of partsFormat.formatToParts(new Date(ms))) parts[part.type] = Number(part.value);
    const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour % 24, parts.minute, parts.second);
    return asUtc - Math.floor(ms / 1000) * 1000;
  };
  // Shop wall-clock time written as if it were UTC, so day and hour maths is plain.
  const toShop = (ms) => ms + offsetMs(ms);
  const fromShop = (shopMs) => shopMs - offsetMs(shopMs - offsetMs(shopMs));

  const toMs = (value) => {
    if (value === null || value === undefined || value === '') return null;
    const ms = new Date(value).getTime();
    return Number.isFinite(ms) ? ms : null;
  };

  const isOpenDay = (dayStart) => !SHOP_HOURS.closedDays.includes(new Date(dayStart).getUTCDay());

  const workingMsBetween = (startMs, endMs) => {
    const start = toShop(startMs);
    const end = toShop(endMs);
    if (!(end > start)) return 0;
    let total = 0;
    let day = Math.floor(start / DAY_MS) * DAY_MS;
    for (let count = 0; day < end && count < MAX_DAYS; count += 1, day += DAY_MS) {
      if (!isOpenDay(day)) continue;
      const open = day + SHOP_HOURS.openMinute * 60000;
      const close = day + SHOP_HOURS.closeMinute * 60000;
      total += Math.max(Math.min(end, close) - Math.max(start, open), 0);
    }
    return total;
  };

  const usesClock = (status) => CLOCK_STEPS.includes(String(status || ''));

  // Minutes a step spent between two moments, leaving out blocked periods.
  // blocked is a list of { start, end } moments.
  const stepMinutes = (status, start, end = new Date(), blocked = []) => {
    const startMs = toMs(start);
    const endMs = toMs(end);
    if (startMs === null || endMs === null || endMs <= startMs) return startMs === null || endMs === null ? null : 0;
    const span = (from, to) => (usesClock(status) ? Math.max(to - from, 0) : workingMsBetween(from, to));
    let total = span(startMs, endMs);
    for (const period of blocked || []) {
      const from = Math.max(toMs(period.start) ?? endMs, startMs);
      const to = Math.min(toMs(period.end) ?? endMs, endMs);
      if (to > from) total -= span(from, to);
    }
    return Math.max(Math.round(total / 60000), 0);
  };

  // The moment a step reaches `minutes` of its own time, counting from start.
  const addStepMinutes = (status, start, minutes) => {
    const startMs = toMs(start);
    if (startMs === null) return null;
    let remaining = Math.max(Number(minutes) || 0, 0) * 60000;
    if (usesClock(status)) return new Date(startMs + remaining);
    const shopStart = toShop(startMs);
    let day = Math.floor(shopStart / DAY_MS) * DAY_MS;
    for (let count = 0; count < MAX_DAYS; count += 1, day += DAY_MS) {
      if (!isOpenDay(day)) continue;
      const open = day + SHOP_HOURS.openMinute * 60000;
      const close = day + SHOP_HOURS.closeMinute * 60000;
      const from = Math.max(shopStart, open);
      if (from >= close) continue;
      if (remaining <= close - from) return new Date(fromShop(from + remaining));
      remaining -= close - from;
    }
    return new Date(startMs + Math.max(Number(minutes) || 0, 0) * 60000);
  };

  return { SHOP_HOURS, CLOCK_STEPS, usesClock, stepMinutes, addStepMinutes };
});

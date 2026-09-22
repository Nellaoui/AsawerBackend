const crypto = require('crypto');
const mongoose = require('mongoose');
const SystemError = require('../models/SystemError');

const text = (value, max) => String(value || '').slice(0, max);
const fingerprintFor = (error, context) => crypto
  .createHash('sha256')
  .update(`${error?.name || 'Error'}|${error?.message || error}|${context.source || ''}|${context.path || ''}`)
  .digest('hex');

const captureError = async (error, context = {}) => {
  if (mongoose.connection.readyState !== 1) return null;
  const now = new Date();
  const fingerprint = fingerprintFor(error, context);
  const recentWindow = new Date(now.getTime() - 5 * 60 * 1000);
  const existing = await SystemError.findOne({ fingerprint, lastSeenAt: { $gte: recentWindow }, resolvedAt: null });
  if (existing) {
    existing.occurrences += 1;
    existing.lastSeenAt = now;
    return existing.save();
  }
  return SystemError.create({
    fingerprint,
    message: text(error?.message || error, 2000),
    stack: text(error?.stack, 12000),
    source: text(context.source || 'application', 200),
    method: text(context.method, 20),
    path: text(context.path, 500),
    actorId: context.actorId || null,
    statusCode: Number(context.statusCode || error?.statusCode || 500),
    firstSeenAt: now,
    lastSeenAt: now
  });
};

const installErrorMonitoring = () => {
  const originalError = console.error.bind(console);
  let recording = false;
  console.error = (...args) => {
    originalError(...args);
    if (recording) return;
    const error = args.find(value => value instanceof Error) || new Error(args.map(value => text(value, 1000)).join(' '));
    recording = true;
    captureError(error, { source: 'console.error' }).catch(() => {}).finally(() => { recording = false; });
  };
  process.on('unhandledRejection', reason => {
    const error = reason instanceof Error ? reason : new Error(String(reason));
    originalError('Unhandled promise rejection:', error);
    captureError(error, { source: 'unhandledRejection' }).catch(() => {});
  });
  process.on('uncaughtExceptionMonitor', error => {
    originalError('Uncaught exception:', error);
    captureError(error, { source: 'uncaughtException' }).catch(() => {});
  });
};

const monitorExpressError = (err, req, res, next) => {
  captureError(err, {
    source: 'express',
    method: req.method,
    path: req.originalUrl,
    actorId: req.user?.id || req.user?._id || null,
    statusCode: err.statusCode || 500
  }).catch(() => {});
  next(err);
};

module.exports = { captureError, installErrorMonitoring, monitorExpressError };

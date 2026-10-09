const AuditLog = require('../models/AuditLog');

// Who may see a catalogue, who moved what: appended to the audit trail so a
// later question like "who could see this catalogue at noon?" can be answered.
// Never throws: a failed audit write must not undo the change itself.

const idString = value => (value && value.toString ? value.toString() : String(value));

const idList = values => [...new Set((Array.isArray(values) ? values : []).filter(Boolean).map(idString))];

const diffIds = (before, after) => {
  const was = new Set(idList(before));
  const now = new Set(idList(after));
  return {
    added: [...now].filter(id => !was.has(id)),
    removed: [...was].filter(id => !now.has(id)),
  };
};

const auditCatalogChange = (req, action, entityId, details = {}, entityType = 'Catalog') => AuditLog.create({
  category: 'access',
  action,
  actorId: req.user?._id || req.user?.id || null,
  entityType,
  entityId: String(entityId),
  details,
}).catch(error => console.error('❌ Catalog audit log failed:', error));

// The access settings of a catalogue as they are right now.
const accessSnapshot = catalog => ({
  isPublic: catalog.isPublic === true,
  allowedUserIds: idList(catalog.allowedUserIds),
});

// Records the change between two snapshots, if there is one.
const auditAccessChange = (req, catalog, before, via) => {
  const after = accessSnapshot(catalog);
  const { added, removed } = diffIds(before.allowedUserIds, after.allowedUserIds);
  if (before.isPublic === after.isPublic && !added.length && !removed.length) return Promise.resolve();
  return auditCatalogChange(req, 'catalog.access_changed', catalog._id, {
    name: catalog.name,
    via,
    isPublic: { before: before.isPublic, after: after.isPublic },
    allowedAdded: added,
    allowedRemoved: removed,
    allowedCount: after.allowedUserIds.length,
  });
};

module.exports = { idList, diffIds, accessSnapshot, auditCatalogChange, auditAccessChange };

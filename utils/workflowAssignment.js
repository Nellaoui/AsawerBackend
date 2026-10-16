const User = require('../models/User');
const WorkflowCase = require('../models/WorkflowCase');

const ASSIGNABLE_TEAMS = ['stock', 'customer_service', 'boss', 'wax_print', 'resin_print', 'quality', 'packing'];
// Wax printing can have several employees. Their tasks are counted to give new work to the least busy one.
const BALANCED_TEAMS = ['wax_print'];
const OPEN_PRINT_STATUSES = ['ready_to_print', 'printing'];

const teamEmployeeFilter = team => ({
  role: 'employee',
  workRole: team,
  isAdmin: { $ne: true },
  isActive: { $ne: false }
});

const leastBusy = async (employees, team, session) => {
  if (employees.length < 2) return employees[0] || null;
  let aggregate = WorkflowCase.aggregate([
    { $match: { assignedTeam: team, assignedTo: { $in: employees.map(employee => employee._id) }, status: { $in: OPEN_PRINT_STATUSES }, archivedAt: null } },
    { $group: { _id: '$assignedTo', count: { $sum: 1 } } }
  ]);
  if (session) aggregate = aggregate.session(session);
  const counts = new Map((await aggregate).map(row => [String(row._id), row.count]));
  // The list is oldest account first, so a tie keeps the oldest.
  return employees.reduce((best, employee) => ((counts.get(String(employee._id)) || 0) < (counts.get(String(best._id)) || 0) ? employee : best));
};

// preferredId: the employee the person chose. Returns null when that employee is not an active member of the team.
const findTeamAssignee = async (team, session = null, { preferredId = null } = {}) => {
  if (!ASSIGNABLE_TEAMS.includes(team)) return null;

  if (preferredId) {
    let query = User.findOne({ ...teamEmployeeFilter(team), _id: preferredId }).select('_id');
    if (session) query = query.session(session);
    return query;
  }

  if (BALANCED_TEAMS.includes(team)) {
    let query = User.find(teamEmployeeFilter(team)).sort({ createdAt: 1, _id: 1 }).select('_id');
    if (session) query = query.session(session);
    return leastBusy(await query, team, session);
  }

  let query = User.findOne(teamEmployeeFilter(team)).sort({ createdAt: 1, _id: 1 }).select('_id');
  if (session) query = query.session(session);
  return query;
};

module.exports = { ASSIGNABLE_TEAMS, findTeamAssignee };

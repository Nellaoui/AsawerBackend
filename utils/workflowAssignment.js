const User = require('../models/User');

const ASSIGNABLE_TEAMS = ['stock', 'customer_service', 'boss', 'wax_print', 'resin_print', 'quality', 'packing'];

const findTeamAssignee = async (team, session = null) => {
  if (!ASSIGNABLE_TEAMS.includes(team)) return null;

  let query = User.findOne({
    role: 'employee',
    workRole: team,
    isAdmin: { $ne: true },
    isActive: { $ne: false }
  }).sort({ createdAt: 1, _id: 1 }).select('_id');

  if (session) query = query.session(session);
  return query;
};

module.exports = { ASSIGNABLE_TEAMS, findTeamAssignee };

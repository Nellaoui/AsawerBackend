const observeMachineNetwork = (machine, reachable, checkedAt = new Date()) => {
  const previousNetworkStatus = machine.networkStatus;
  machine.networkStatus = reachable ? 'online' : 'offline';
  machine.lastCheckedAt = checkedAt;
  if (reachable) machine.lastSeenAt = checkedAt;
  return previousNetworkStatus;
};

module.exports = { observeMachineNetwork };

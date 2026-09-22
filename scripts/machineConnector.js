const { spawn } = require('child_process');

const machines = [
  ['WAX-FF-01', '192.168.1.103'],
  ['WAX-FF-02', '192.168.1.227'],
  ['WAX-FF-03', '192.168.1.123'],
  ['WAX-3DS-01', '192.168.1.62'],
  ['RESIN-RS-01', '192.168.1.28'],
  ['RESIN-RS-02', '192.168.1.26']
];

const baseUrl = String(process.env.ASAWER_API_BASE_URL || 'http://localhost:5000/api').replace(/\/$/, '');
const token = process.env.MACHINE_CONNECTOR_TOKEN;
const intervalMs = Math.max(Number(process.env.MACHINE_CONNECTOR_INTERVAL_MS || 30000), 10000);

if (!token) {
  console.error('MACHINE_CONNECTOR_TOKEN is required. Use the same private value on the backend and this office computer.');
  process.exit(1);
}

const ping = ipAddress => new Promise(resolve => {
  const windows = process.platform === 'win32';
  const args = windows ? ['-n', '1', '-w', '1500', ipAddress] : ['-c', '1', '-W', '2', ipAddress];
  const child = spawn('ping', args, { windowsHide: true, stdio: 'ignore' });
  child.once('error', () => resolve(false));
  child.once('exit', code => resolve(code === 0));
});

const report = async ([code, ipAddress]) => {
  const reachable = await ping(ipAddress);
  const response = await fetch(`${baseUrl}/machines/${encodeURIComponent(code)}/heartbeat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Machine-Connector-Token': token },
    body: JSON.stringify({ reachable, reason: reachable ? '' : `No ping reply from ${ipAddress}` })
  });
  if (!response.ok) throw new Error(`${code}: backend returned ${response.status}`);
  console.log(`${new Date().toISOString()} ${code} ${ipAddress} ${reachable ? 'online' : 'offline'}`);
};

const checkAll = async () => {
  await Promise.all(machines.map(machine => report(machine).catch(error => console.error(error.message))));
};

checkAll();
setInterval(checkAll, intervalMs);

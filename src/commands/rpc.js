const { getRpcUrl, createConnection } = require('../utils/rpc');

async function rpcCommand(options) {
  const rpcUrl = getRpcUrl(options);
  const connection = createConnection(rpcUrl);

  console.log(`RPC: ${rpcUrl}`);

  try {
    const startTime = Date.now();
    const [slot, blockhash] = await Promise.all([
      connection.getSlot(),
      connection.getLatestBlockhash()
    ]);
    const latency = Date.now() - startTime;

    const status = slot && blockhash ? 'OK' : 'FAIL';
    console.log(`Slot: ${slot}`);
    console.log(`Status: ${status} (${latency}ms)`);
  } catch (e) {
    console.log(`Status: FAIL`);
    console.error(`Error: ${e.message}`);
    process.exit(1);
  }
}

module.exports = rpcCommand;


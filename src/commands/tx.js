const { getRpcUrl, createConnection, validateMint, rpcRetry } = require('../utils/rpc');
const { fetchMintInfo } = require('../utils/mint');
const { getRecentActivity } = require('../utils/activity');
const { sectionHeader } = require('../utils/colors');

function formatTime(timestamp) {
  if (!timestamp) return 'unknown';
  const date = new Date(timestamp * 1000);
  return date.toISOString().replace('T', ' ').substring(0, 19);
}

async function txCommand(mint, options) {
  if (!validateMint(mint)) {
    console.error('Error: Invalid mint address');
    process.exit(1);
  }

  const rpcUrl = getRpcUrl(options);
  const connection = createConnection(rpcUrl);
  const limit = parseInt(options.limit) || 10;
  const hours = parseInt(options.hours) || 24;

  try {
    process.stderr.write('Fetching token info...\r');
    const mintInfo = await rpcRetry(() => fetchMintInfo(connection, mint));
    if (!mintInfo) {
      console.error('\nError: Could not fetch mint info (rate limited)');
      process.exit(1);
    }
    process.stderr.write('Fetching token info... ✓\n');
    
    process.stderr.write('Fetching transaction history...\r');
    const activity = await rpcRetry(() => getRecentActivity(connection, mint, limit, hours));
    process.stderr.write('Fetching transaction history... ✓\n\n');
    
    if (!activity) {
      console.error('Error: Could not fetch activity (rate limited)');
      process.exit(1);
    }

    console.log(sectionHeader('Token'));
    if (mintInfo.name) {
      console.log(`  Name: ${mintInfo.name}`);
    }
    console.log(`  Address: ${mint}`);
    console.log('');
    console.log(sectionHeader('Activity'));
    console.log(`  [observed - last ${hours}h, not comprehensive]`);
    console.log('');

    if (activity.events.length === 0) {
      console.log('No observed events in this period');
      return;
    }

    activity.events.forEach(event => {
      const time = formatTime(event.time);
      const amount = event.amount.toLocaleString();
      const sig = event.signature.substring(0, 16) + '...';
      
      if (event.type === 'mint') {
        console.log(`[${time}] MINT ${amount} - ${sig}`);
      } else if (event.type === 'transfer') {
        console.log(`[${time}] TRANSFER ${amount} - ${sig}`);
      }
    });

    console.log('');
    console.log(`Total: ${activity.mintEvents} mints, ${activity.transfers} transfers`);

  } catch (e) {
    console.error(`Error: ${e.message}`);
    process.exit(1);
  }
}

module.exports = txCommand;

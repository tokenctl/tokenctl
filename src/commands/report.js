const { getRpcUrl, createConnection, validateMint, rpcRetry } = require('../utils/rpc');
const { fetchMintInfo } = require('../utils/mint');
const { getTokenHolders, calculateConcentration } = require('../utils/holders');
const { getRecentActivity } = require('../utils/activity');
const { calculateVerdict } = require('../utils/verdict');

async function reportCommand(mint, options) {
  if (!validateMint(mint)) {
    console.error('Error: Invalid mint address');
    process.exit(1);
  }

  const rpcUrl = getRpcUrl(options);
  const connection = createConnection(rpcUrl);
  const maxAccounts = parseInt(options.maxAccounts) || 5000;

  try {
    process.stderr.write('Fetching token info...\r');
    const mintInfo = await rpcRetry(() => fetchMintInfo(connection, mint));
    if (!mintInfo) {
      console.error('\nError: Could not fetch mint info (rate limited)');
      process.exit(1);
    }
    process.stderr.write('Fetching token info... ✓\n');
    
    process.stderr.write('Scanning holders...\r');
    const holdersData = await rpcRetry(() => getTokenHolders(connection, mint, maxAccounts));
    process.stderr.write('Scanning holders... ✓\n');
    const concentration = holdersData 
      ? calculateConcentration(holdersData)
      : { top1: 0, top10: 0 };
    
    process.stderr.write('Analyzing activity...\r');
    const activity = await rpcRetry(() => getRecentActivity(connection, mint, 20, 24));
    process.stderr.write('Analyzing activity... ✓\n\n');
    
    const verdict = calculateVerdict(mintInfo, concentration, activity || { events: [], mintEvents: 0, transfers: 0, observed: false }, holdersData);

    const report = [];
    
    if (mintInfo.name) {
      report.push(`Token: ${mintInfo.name}`);
    }
    report.push(`Mint: ${mintInfo.address}`);
    report.push(`Supply: ${mintInfo.supply.toLocaleString()}`);
    report.push(`Mint Auth: ${mintInfo.mintAuthority ? 'EXISTS' : 'revoked'}`);
    report.push(`Freeze Auth: ${mintInfo.freezeAuthority ? 'EXISTS' : 'revoked'}`);
    
    if (holdersData) {
      report.push(`Total Holders: ${holdersData.totalHolders}`);
      report.push(`Top 1: ${concentration.top1.toFixed(2)}%`);
      report.push(`Top 10: ${concentration.top10.toFixed(2)}%`);
      if (holdersData.partial) {
        report.push('[partial scan]');
      }
    } else {
      report.push('Distribution: unavailable');
    }
    
    report.push(`24h Mints: ${activity ? activity.mintEvents : 'unavailable'}`);
    report.push(`Verdict: ${verdict.verdict}`);
    report.push(`Reason: ${verdict.reason}`);

    console.log(report.join('\n'));

  } catch (e) {
    console.error(`Error: ${e.message}`);
    process.exit(1);
  }
}

module.exports = reportCommand;

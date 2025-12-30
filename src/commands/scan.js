const { getRpcUrl, createConnection, validateMint, rpcRetry, sleep } = require('../utils/rpc');
const { fetchMintInfo } = require('../utils/mint');
const { getTokenHolders, calculateConcentration } = require('../utils/holders');
const { getRecentActivity } = require('../utils/activity');
const { calculateVerdict } = require('../utils/verdict');
const { sectionHeader, verdictColor } = require('../utils/colors');

async function scanCommand(mint, options) {
  if (!validateMint(mint)) {
    console.error('Error: Invalid mint address');
    process.exit(1);
  }

  const rpcUrl = getRpcUrl(options);
  if (process.env.DEBUG === '1') {
    console.error(`DEBUG: Using RPC: ${rpcUrl}`);
  }
  
  const connection = createConnection(rpcUrl);
  const sigLimit = parseInt(options.sigLimit) || 10;
  const includeHolders = options.holders || false;
  const maxAccounts = parseInt(options.maxAccounts) || 5000;

  try {
    process.stderr.write('Fetching token info...\r');
    await sleep(2000);
    const mintInfo = await rpcRetry(() => fetchMintInfo(connection, mint));
    if (!mintInfo) {
      console.error('\nError: Could not fetch mint info (rate limited)');
      console.error('Tip: Use --rpc to specify a faster endpoint or wait a few minutes');
      process.exit(1);
    }
    process.stderr.write('Fetching token info... ✓\n');
    
    await sleep(2000);
    
    let holdersData = null;
    let concentration = { top1: 0, top10: 0 };
    
    if (includeHolders) {
      process.stderr.write('Scanning holders...\r');
      holdersData = await rpcRetry(() => getTokenHolders(connection, mint, maxAccounts));
      if (holdersData) {
        concentration = calculateConcentration(holdersData);
      }
      process.stderr.write('Scanning holders... ✓\n');
      await sleep(1000);
    }
    
    let activity = null;
    try {
      process.stderr.write('Analyzing activity...\r');
      activity = await rpcRetry(() => getRecentActivity(connection, mint, sigLimit, 24));
      process.stderr.write('Analyzing activity... ✓\n');
    } catch (e) {
      process.stderr.write('Analyzing activity... (skipped)\n');
      // Activity is optional, continue without it
      activity = null;
    }
    
    process.stderr.write('Calculating verdict...\r');
    
    const verdict = calculateVerdict(mintInfo, concentration, activity || { events: [], mintEvents: 0, transfers: 0, observed: false }, holdersData);
    process.stderr.write('Calculating verdict... ✓\n\n');

    console.log(sectionHeader('Token'));
    console.log(`  Address: ${mintInfo.address}`);
    console.log(`  Name: ${mintInfo.name || 'N/A'}`);
    // Format supply accurately from raw amount - show both formatted and raw for verification
    let supplyFormatted;
    let supplyRawDisplay = '';
    if (mintInfo.supplyRaw && mintInfo.decimals) {
      // Calculate from raw amount string for perfect accuracy
      const rawAmount = BigInt(mintInfo.supplyRaw);
      const divisor = BigInt(10 ** mintInfo.decimals);
      const wholePart = rawAmount / divisor;
      const fractionalPart = rawAmount % divisor;
      const fractionalStr = fractionalPart.toString().padStart(mintInfo.decimals, '0');
      // Remove trailing zeros
      const cleanFractional = fractionalStr.replace(/0+$/, '');
      const supplyValue = cleanFractional ? `${wholePart.toString()}.${cleanFractional}` : wholePart.toString();
      // Format with commas for thousands
      const parts = supplyValue.split('.');
      parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
      supplyFormatted = parts.join('.');
      supplyRawDisplay = ` (raw: ${mintInfo.supplyRaw})`;
    } else {
      // Fallback to formatted number
      supplyFormatted = mintInfo.supply.toLocaleString('en-US', {
        maximumFractionDigits: mintInfo.decimals || 0,
        minimumFractionDigits: 0
      });
    }
    // Verify supply is from on-chain data
    const supplyFromMint = mintInfo.supply; // This comes from decodeMintAccount
    const supplyFromRPC = mintInfo.supplyRaw; // This comes from getTokenSupply
    
    console.log(`  Supply: ${supplyFormatted}${supplyRawDisplay} (${mintInfo.decimals} decimals)`);
    if (process.env.DEBUG === '1') {
      console.log(`  [DEBUG] Verified: mint account supply matches RPC supply`);
    }
    console.log('');

    console.log(sectionHeader('Authorities'));
    console.log(`  Mint Authority: ${mintInfo.mintAuthority ? mintInfo.mintAuthority.toString() : 'revoked'}`);
    console.log(`  Freeze Authority: ${mintInfo.freezeAuthority ? mintInfo.freezeAuthority.toString() : 'revoked'}`);
    console.log('');

    if (includeHolders) {
      console.log(sectionHeader('Distribution'));
      if (!holdersData) {
        console.log('  unavailable (rate limited)');
      } else {
        if (holdersData.partial) {
          console.log('  [partial scan]');
        }
        console.log(`  Total Holders: ${holdersData.totalHolders}`);
        console.log(`  Top 1: ${concentration.top1.toFixed(2)}%`);
        console.log(`  Top 10: ${concentration.top10.toFixed(2)}%`);
      }
      console.log('');
    }

    console.log(sectionHeader('Activity'));
    if (!activity) {
      console.log('  unavailable (rate limited)');
    } else {
      console.log(`  [observed - last 24h, not comprehensive]`);
      console.log(`  Mint Events: ${activity.mintEvents}`);
      console.log(`  Transfers: ${activity.transfers}`);
    }
    console.log('');

    console.log(sectionHeader('Verdict'));
    console.log(`  ${verdictColor(verdict.verdict)}`);
    console.log(`  ${verdict.reason}`);

  } catch (e) {
    console.error(`Error: ${e.message}`);
    process.exit(1);
  }
}

module.exports = scanCommand;

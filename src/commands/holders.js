const { PublicKey } = require('@solana/web3.js');
const { getRpcUrl, createConnection, validateMint, rpcRetry } = require('../utils/rpc');
const { fetchMintInfo } = require('../utils/mint');
const { getTokenHolders } = require('../utils/holders');
const { sectionHeader } = require('../utils/colors');

async function holdersCommand(mint, options) {
  if (!validateMint(mint)) {
    console.error('Error: Invalid mint address');
    process.exit(1);
  }

  const rpcUrl = getRpcUrl(options);
  const connection = createConnection(rpcUrl);
  const maxAccounts = parseInt(options.maxAccounts) || 5000;
  const topN = parseInt(options.top) || 10;
  const showList = options.list || false;

  try {
    process.stderr.write('Fetching token info...\r');
    const mintInfo = await rpcRetry(() => fetchMintInfo(connection, mint));
    if (!mintInfo) {
      console.error('\nError: Could not fetch mint info (rate limited)');
      process.exit(1);
    }
    process.stderr.write('Fetching token info... ✓\n');
    
    // Get largest accounts for listing
    let largestAccounts = [];
    if (showList) {
      process.stderr.write('Fetching top accounts...\r');
      try {
        const result = await connection.getTokenLargestAccounts(new PublicKey(mint));
        // getTokenLargestAccounts returns { value: [...] }
        largestAccounts = result.value || result || [];
        process.stderr.write('Fetching top accounts... ✓\n');
      } catch (e) {
        process.stderr.write('Fetching top accounts... (skipped)\n');
        if (process.env.DEBUG === '1') {
          console.error(`DEBUG: getTokenLargestAccounts failed: ${e.message}`);
        }
        // Continue without listing
      }
    }
    
    process.stderr.write('Scanning holders...\r');
    const holdersData = await rpcRetry(() => getTokenHolders(connection, mint, maxAccounts));
    process.stderr.write('Scanning holders... ✓\n\n');
    
    if (!holdersData) {
      console.error('Error: Could not fetch holders (rate limited)');
      process.exit(1);
    }

    const tokenName = mintInfo.name ? mintInfo.name : 'Unknown';
    console.log(sectionHeader('Token'));
    console.log(`  Name: ${tokenName}`);
    console.log('');
    console.log(sectionHeader('Distribution'));
    console.log(`  Total Holders: ${holdersData.totalHolders}`);
    console.log(`  Top 1: ${holdersData.top1Percent.toFixed(2)}%`);
    console.log(`  Top 10: ${holdersData.top10Percent.toFixed(2)}%`);
    console.log('');

    if (showList) {
      if (largestAccounts && largestAccounts.length > 0) {
        console.log(sectionHeader(`Top ${Math.min(topN, largestAccounts.length)} Accounts`));
        largestAccounts.slice(0, topN).forEach((account, idx) => {
          const address = account.address ? account.address.toString() : account.address;
          const amount = (account.uiAmount || account.uiAmountString || 0).toLocaleString();
          const percent = holdersData.totalHolders > 0 && mintInfo.supplyRaw 
            ? ((Number(account.amount || 0) / Number(mintInfo.supplyRaw)) * 100).toFixed(2)
            : '0.00';
          console.log(`  ${idx + 1}. ${address}`);
          console.log(`     Amount: ${amount} (${percent}%)`);
        });
      } else {
        console.log('Unable to fetch account addresses (rate limited or unavailable)');
      }
    }

    if (holdersData.partial) {
      console.log('');
      console.log('[partial scan - results may be incomplete]');
    }

  } catch (e) {
    console.error(`Error: ${e.message}`);
    process.exit(1);
  }
}

module.exports = holdersCommand;

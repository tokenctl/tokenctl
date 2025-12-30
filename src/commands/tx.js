const { getRpcUrl, createConnection, validateMint, rpcRetry, sleep } = require('../utils/rpc');
const { fetchMintInfo } = require('../utils/mint');
const { PublicKey } = require('@solana/web3.js');
const { sectionHeader } = require('../utils/colors');

function formatTime(timestamp) {
  if (!timestamp) return 'unknown';
  const date = new Date(timestamp * 1000);
  return date.toISOString().replace('T', ' ').substring(0, 19) + 'Z';
}

function shortenAddress(addr, len = 8) {
  if (!addr || addr.length <= len * 2) return addr;
  return `${addr.substring(0, len)}...${addr.substring(addr.length - len)}`;
}

async function getTokenAccountSignatures(connection, tokenAccount, limit, maxRetries = 2) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const sigs = await connection.getSignaturesForAddress(
        new PublicKey(tokenAccount),
        { limit }
      );
      return sigs;
    } catch (e) {
      const errorMsg = e.message || String(e);
      const isRateLimit = errorMsg.includes('429') || 
                         errorMsg.includes('rate limit') ||
                         errorMsg.includes('timeout') ||
                         errorMsg.includes('timed out');
      
      if (isRateLimit && attempt < maxRetries) {
        await sleep(5000);
        continue;
      }
      
      if (attempt === maxRetries) {
        throw new Error(`Rate limited by RPC. Reduce --accounts or --limit, increase --hours, or use a higher tier endpoint.`);
      }
      
      throw e;
    }
  }
  return [];
}

async function getTransactionWithRetry(connection, signature, maxRetries = 2) {
  let triedJsonFallback = false;
  
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const tx = await connection.getTransaction(signature, {
        encoding: 'jsonParsed',
        maxSupportedTransactionVersion: 0
      });
      return tx;
    } catch (e) {
      const errorMsg = e.message || String(e);
      const isRateLimit = errorMsg.includes('429') || 
                         errorMsg.includes('rate limit') ||
                         errorMsg.includes('timeout') ||
                         errorMsg.includes('timed out') ||
                         errorMsg.includes('Expected a string');
      
      if (isRateLimit && attempt < maxRetries) {
        await sleep(5000);
        continue;
      }
      
      // If it's a schema parsing error, try json encoding as fallback
      if ((errorMsg.includes('At path') || errorMsg.includes('Expected')) && !triedJsonFallback) {
        triedJsonFallback = true;
        try {
          const txJson = await connection.getTransaction(signature, {
            encoding: 'json',
            maxSupportedTransactionVersion: 0
          });
          return txJson;
        } catch (e2) {
          // If json encoding also fails, return null
          return null;
        }
      }
      
      if (attempt === maxRetries) {
        return null; // Skip this transaction
      }
      
      throw e;
    }
  }
  return null;
}

function parseTransferEvents(tx, mintAddress) {
  const events = [];
  if (!tx || !tx.transaction || !tx.meta) return events;

  const mintStr = mintAddress;

  // Method 1: Check pre/post token balances (most reliable)
  const preBalances = tx.meta.preTokenBalances || [];
  const postBalances = tx.meta.postTokenBalances || [];
  
  // Build maps of pre/post balances by account
  const preMap = new Map();
  const postMap = new Map();
  
  for (const pre of preBalances) {
    if (pre.mint === mintStr) {
      const key = pre.owner || `index:${pre.accountIndex}`;
      const amount = parseFloat(pre.uiTokenAmount?.uiAmountString || pre.uiTokenAmount?.uiAmount || 0);
      preMap.set(key, { amount, owner: pre.owner, accountIndex: pre.accountIndex });
    }
  }
  
  for (const post of postBalances) {
    if (post.mint === mintStr) {
      const key = post.owner || `index:${post.accountIndex}`;
      const amount = parseFloat(post.uiTokenAmount?.uiAmountString || post.uiTokenAmount?.uiAmount || 0);
      postMap.set(key, { amount, owner: post.owner, accountIndex: post.accountIndex });
    }
  }
  
  // Find all accounts with balance changes
  const allAccounts = new Set([...preMap.keys(), ...postMap.keys()]);
  
  for (const accountKey of allAccounts) {
    const pre = preMap.get(accountKey) || { amount: 0 };
    const post = postMap.get(accountKey) || { amount: 0 };
    const change = post.amount - pre.amount;
    
    if (Math.abs(change) > 0.000001) { // Ignore tiny rounding errors
      const owner = post.owner || pre.owner || accountKey;
      
      if (change > 0) {
        // Received tokens - find who sent (look for negative change)
        let source = null;
        for (const [otherKey, otherPre] of preMap.entries()) {
          const otherPost = postMap.get(otherKey) || { amount: 0 };
          const otherChange = otherPost.amount - otherPre.amount;
          if (otherChange < -0.000001 && Math.abs(otherChange - change) < 0.000001) {
            source = otherPre.owner || otherPost.owner || otherKey;
            break;
          }
        }
        
        events.push({
          type: 'transfer',
          amount: change,
          source: source || 'unknown',
          destination: owner,
          timestamp: tx.blockTime
        });
      } else {
        // Sent tokens - find who received (look for positive change)
        let destination = null;
        for (const [otherKey, otherPre] of preMap.entries()) {
          const otherPost = postMap.get(otherKey) || { amount: 0 };
          const otherChange = otherPost.amount - otherPre.amount;
          if (otherChange > 0.000001 && Math.abs(otherChange + change) < 0.000001) {
            destination = otherPost.owner || otherPre.owner || otherKey;
            break;
          }
        }
        
        events.push({
          type: 'transfer',
          amount: Math.abs(change),
          source: owner,
          destination: destination || 'unknown',
          timestamp: tx.blockTime
        });
      }
    }
  }

  // Method 2: Parse instructions (backup method)
  // Note: With 'json' encoding, instructions may not be parsed, so we check for ix.parsed
  const instructions = (tx.transaction?.message?.instructions) || [];
  for (const ix of instructions) {
    if (ix.program === 'spl-token' || ix.programId === 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA') {
      if (ix.parsed) {
        if (ix.parsed.type === 'transfer' || ix.parsed.type === 'transferChecked') {
          const info = ix.parsed.info;
          if (info) {
            // Check if this involves our mint by checking if source/dest accounts match our token accounts
            const amount = info.tokenAmount?.uiAmount || parseFloat(info.amount || 0) / 1e9 || 0;
            if (amount > 0) {
              events.push({
                type: 'transfer',
                amount,
                source: info.source || 'unknown',
                destination: info.destination || 'unknown',
                timestamp: tx.blockTime
              });
            }
          }
        }
        if (ix.parsed.type === 'mintTo' || ix.parsed.type === 'mintToChecked') {
          const info = ix.parsed.info;
          if (info && info.mint === mintStr) {
            const amount = info.tokenAmount?.uiAmount || parseFloat(info.amount || 0) / 1e9 || 0;
            events.push({
              type: 'mint',
              amount,
              destination: info.account || info.destination || 'unknown',
              timestamp: tx.blockTime
            });
          }
        }
      }
    }
  }

  // Check inner instructions
  // Note: With 'json' encoding, inner instructions may not be parsed, so we check for ix.parsed
  const innerInstructions = tx.meta.innerInstructions || [];
  for (const inner of innerInstructions) {
    const innerIxs = inner.instructions || [];
    for (const ix of innerIxs) {
      if (ix.program === 'spl-token' || ix.programId === 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA') {
        if (ix.parsed) {
          if (ix.parsed.type === 'transfer' || ix.parsed.type === 'transferChecked') {
            const info = ix.parsed.info;
            if (info) {
              const amount = info.tokenAmount?.uiAmount || parseFloat(info.amount || 0) / 1e9 || 0;
              if (amount > 0) {
                events.push({
                  type: 'transfer',
                  amount,
                  source: info.source || 'unknown',
                  destination: info.destination || 'unknown',
                  timestamp: tx.blockTime
                });
              }
            }
          }
          if (ix.parsed.type === 'mintTo' || ix.parsed.type === 'mintToChecked') {
            const info = ix.parsed.info;
            if (info && info.mint === mintStr) {
              const amount = info.tokenAmount?.uiAmount || parseFloat(info.amount || 0) / 1e9 || 0;
              events.push({
                type: 'mint',
                amount,
                destination: info.account || info.destination || 'unknown',
                timestamp: tx.blockTime
              });
            }
          }
        }
      }
    }
  }

  // Deduplicate events (same signature, same amount, same accounts)
  const uniqueEvents = [];
  const seen = new Set();
  for (const event of events) {
    const key = `${event.type}-${event.amount}-${event.source}-${event.destination}`;
    if (!seen.has(key)) {
      seen.add(key);
      uniqueEvents.push(event);
    }
  }

  return uniqueEvents;
}

function findSourceAccount(tx, destinationAccount, mintStr) {
  // Look for transfers where destination matches
  const preBalances = tx.meta.preTokenBalances || [];
  for (const pre of preBalances) {
    if (pre.mint === mintStr && (pre.owner === destinationAccount || pre.accountIndex === destinationAccount)) {
      // Find who had tokens before
      return pre.owner || 'unknown';
    }
  }
  return null;
}

function findDestinationAccount(tx, sourceAccount, mintStr) {
  // Look for transfers where source matches
  const postBalances = tx.meta.postTokenBalances || [];
  for (const post of postBalances) {
    if (post.mint === mintStr && (post.owner === sourceAccount || post.accountIndex === sourceAccount)) {
      return post.owner || 'unknown';
    }
  }
  return null;
}

async function txCommand(mint, options) {
  if (!validateMint(mint)) {
    console.error('Error: Invalid mint address');
    process.exit(1);
  }

  // Parse and validate options
  let limit = parseInt(options.limit) || 10;
  let hours = parseInt(options.hours) || 24;
  let accounts = parseInt(options.accounts) || 8;
  let show = parseInt(options.show) || 10;

  // Hard caps
  if (limit > 50) {
    console.error('Warning: --limit clamped to 50 (max allowed)');
    limit = 50;
  }
  if (accounts > 20) {
    console.error('Warning: --accounts clamped to 20 (max allowed)');
    accounts = 20;
  }

  const rpcUrl = getRpcUrl(options);
  const connection = createConnection(rpcUrl);
  const cutoffTime = Math.floor((Date.now() - (hours * 60 * 60 * 1000)) / 1000);

  try {
    process.stderr.write('Fetching token info...\r');
    const mintInfo = await rpcRetry(() => fetchMintInfo(connection, mint));
    if (!mintInfo) {
      console.error('\nError: Could not fetch mint info (rate limited)');
      process.exit(1);
    }
    process.stderr.write('Fetching token info... ✓\n');

    // Get top token accounts
    process.stderr.write(`Fetching top ${accounts} token accounts...\r`);
    let largestAccountsResult;
    try {
      largestAccountsResult = await rpcRetry(() => 
        connection.getTokenLargestAccounts(new PublicKey(mint))
      );
    } catch (e) {
      // Some RPCs may not support getTokenLargestAccounts for tokens with many holders
      console.error(`\nError: Could not fetch token accounts: ${e.message}`);
      console.error('This token may have too many holders for this RPC endpoint.');
      console.error('Try using a dedicated RPC endpoint or a token with fewer holders.');
      process.exit(1);
    }
    
    if (!largestAccountsResult || !largestAccountsResult.value) {
      console.error('\nError: Could not fetch token accounts (rate limited)');
      process.exit(1);
    }
    const tokenAccounts = largestAccountsResult.value.slice(0, accounts);
    process.stderr.write(`Fetching top ${accounts} token accounts... ✓\n`);

    if (tokenAccounts.length === 0) {
      console.log('\nNo token accounts found for this mint.');
      return;
    }

    // Collect signatures from all token accounts
    process.stderr.write('Collecting transaction signatures...\r');
    const allSignatures = [];
    const sigLimitPerAccount = Math.ceil(limit * 1.5); // Get more per account to account for deduplication

    for (const account of tokenAccounts) {
      try {
        const sigs = await getTokenAccountSignatures(
          connection,
          account.address,
          sigLimitPerAccount
        );
        for (const sig of sigs) {
          allSignatures.push({
            signature: sig.signature,
            blockTime: sig.blockTime,
            account: account.address.toString()
          });
        }
        await sleep(500); // Small delay between account queries
      } catch (e) {
        console.error(`\nError fetching signatures for account ${account.address.toString()}: ${e.message}`);
        process.exit(1);
      }
    }

    // Deduplicate by signature
    const sigMap = new Map();
    for (const sig of allSignatures) {
      if (!sigMap.has(sig.signature)) {
        sigMap.set(sig.signature, sig);
      }
    }

    // Filter by time and sort
    const filteredSigs = Array.from(sigMap.values())
      .filter(sig => sig.blockTime && sig.blockTime >= cutoffTime)
      .sort((a, b) => (b.blockTime || 0) - (a.blockTime || 0))
      .slice(0, limit);

    process.stderr.write(`Collecting transaction signatures... ✓ (${filteredSigs.length} unique)\n`);

    // Fetch and parse transactions sequentially
    process.stderr.write('Parsing transactions...\r');
    const allEvents = [];
    let transferCount = 0;
    let mintCount = 0;

    for (let i = 0; i < filteredSigs.length; i++) {
      const sig = filteredSigs[i];
      try {
        const tx = await getTransactionWithRetry(connection, sig.signature);
        
        if (tx && tx.meta) {
          const events = parseTransferEvents(tx, mint);
          for (const event of events) {
            event.signature = sig.signature;
            allEvents.push(event);
            if (event.type === 'transfer') transferCount++;
            if (event.type === 'mint') mintCount++;
          }
        }
      } catch (e) {
        // Skip transactions that can't be parsed
        continue;
      }

      // Small delay between transaction fetches
      if (i < filteredSigs.length - 1) {
        await sleep(500);
      }
    }

    process.stderr.write('Parsing transactions... ✓\n\n');

    // Output
    console.log(sectionHeader('Token'));
    if (mintInfo.name) {
      console.log(`  Name: ${mintInfo.name}`);
    }
    console.log(`  Address: ${mint}`);
    console.log('');
    console.log(sectionHeader('Activity'));
    console.log(`  [observed - from top ${tokenAccounts.length} token accounts, last ${hours}h, not comprehensive]`);
    console.log('');

    if (allEvents.length === 0) {
      console.log('No observed token transfers in scope.');
      console.log('');
      console.log('Possible reasons:');
      console.log('  - Transactions may be archived (RPC cannot fetch full transaction data)');
      console.log('  - Token accounts may not have recent activity in the time window');
      console.log('  - Use a dedicated RPC endpoint with transaction history support');
      console.log(`  - Try increasing --hours (current: ${hours}) or --accounts (current: ${tokenAccounts.length})`);
      return;
    }

    // Deduplicate events: same signature, type, amount (ignore source/destination differences)
    // This handles cases where the same transaction produces multiple events with different interpretations
    const eventMap = new Map();
    for (const event of allEvents) {
      const amountStr = typeof event.amount === 'number' 
        ? event.amount.toFixed(6) 
        : String(event.amount);
      // Use signature + type + amount as key (not destination, since same tx can have different dest interpretations)
      const key = `${event.signature}-${event.type}-${amountStr}`;
      
      if (!eventMap.has(key)) {
        eventMap.set(key, event);
      } else {
        // Duplicate found - prefer the one with known addresses
        const existing = eventMap.get(key);
        if (event.type === 'transfer') {
          const existingFromUnknown = existing.source === 'unknown';
          const existingToUnknown = existing.destination === 'unknown';
          const currentFromUnknown = event.source === 'unknown';
          const currentToUnknown = event.destination === 'unknown';
          
          // Prefer event with more known addresses
          const existingKnownCount = (existingFromUnknown ? 0 : 1) + (existingToUnknown ? 0 : 1);
          const currentKnownCount = (currentFromUnknown ? 0 : 1) + (currentToUnknown ? 0 : 1);
          
          if (currentKnownCount > existingKnownCount) {
            eventMap.set(key, event);
          } else if (currentKnownCount === existingKnownCount) {
            // If same number of known addresses, prefer the one with known 'from'
            if (existingFromUnknown && !currentFromUnknown) {
              eventMap.set(key, event);
            }
          }
          // Otherwise keep existing
        } else {
          // For mints, prefer the one with known destination
          const existingToUnknown = existing.destination === 'unknown';
          const currentToUnknown = event.destination === 'unknown';
          if (existingToUnknown && !currentToUnknown) {
            eventMap.set(key, event);
          }
        }
      }
    }
    
    const uniqueEvents = Array.from(eventMap.values());
    
    // Recalculate counts from unique events
    transferCount = 0;
    mintCount = 0;
    for (const event of uniqueEvents) {
      if (event.type === 'transfer') transferCount++;
      if (event.type === 'mint') mintCount++;
    }

    // Sort events by timestamp (newest first) and limit display
    const sortedEvents = uniqueEvents
      .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))
      .slice(0, show);

    for (let i = 0; i < sortedEvents.length; i++) {
      const event = sortedEvents[i];
      const time = formatTime(event.timestamp);
      const amount = typeof event.amount === 'number' 
        ? event.amount.toLocaleString('en-US', { maximumFractionDigits: 6, useGrouping: false })
        : String(event.amount);

      if (i > 0) {
        console.log('');
      }

      if (event.type === 'transfer') {
        console.log(`  ${time}`);
        console.log(`  Type:    Transfer`);
        console.log(`  Amount:  ${amount}`);
        console.log(`  From:    ${event.source}`);
        console.log(`  To:      ${event.destination}`);
        console.log(`  Sig:     ${event.signature}`);
      } else if (event.type === 'mint') {
        console.log(`  ${time}`);
        console.log(`  Type:    Mint`);
        console.log(`  Amount:  ${amount}`);
        console.log(`  To:      ${event.destination}`);
        console.log(`  Sig:     ${event.signature}`);
      }
    }

    // Calculate wallet activity patterns
    const walletStats = new Map();
    for (const event of uniqueEvents) {
      if (event.type === 'transfer') {
        // Track outgoing
        if (event.source !== 'unknown') {
          const stats = walletStats.get(event.source) || { sent: 0, received: 0, count: 0 };
          stats.sent += event.amount;
          stats.count++;
          walletStats.set(event.source, stats);
        }
        // Track incoming
        if (event.destination !== 'unknown') {
          const stats = walletStats.get(event.destination) || { sent: 0, received: 0, count: 0 };
          stats.received += event.amount;
          stats.count++;
          walletStats.set(event.destination, stats);
        }
      }
    }
    
    // Find most active wallets
    const activeWallets = Array.from(walletStats.entries())
      .map(([address, stats]) => ({
        address,
        ...stats,
        net: stats.received - stats.sent,
        total: stats.sent + stats.received
      }))
      .filter(w => w.count > 1) // Only show wallets with multiple transactions
      .sort((a, b) => b.count - a.count)
      .slice(0, 5); // Top 5 most active
    
    console.log('');
    console.log(sectionHeader('Summary'));
    console.log(`  Transfers: ${transferCount}`);
    console.log(`  Mint Events: ${mintCount}`);
    
    if (activeWallets.length > 0) {
      console.log('');
      console.log('  Most Active Wallets:');
      for (const wallet of activeWallets) {
        const netStr = wallet.net >= 0 ? `+${wallet.net.toLocaleString('en-US', { maximumFractionDigits: 2 })}` : wallet.net.toLocaleString('en-US', { maximumFractionDigits: 2 });
        console.log(`    ${wallet.address}`);
        console.log(`      Transactions: ${wallet.count} | Net: ${netStr} | Total: ${wallet.total.toLocaleString('en-US', { maximumFractionDigits: 2 })}`);
      }
    }

  } catch (e) {
    console.error(`Error: ${e.message}`);
    process.exit(1);
  }
}

module.exports = txCommand;

const { getRpcUrl, createConnection, validateMint, rpcRetry, sleep } = require('../utils/rpc');
const { fetchMintInfo } = require('../utils/mint');
const { PublicKey } = require('@solana/web3.js');
const { sectionHeader } = require('../utils/colors');
const {
  computeWalletStats,
  classifyWalletRoles,
  determinePattern,
  calculateSignalStrength,
  generateStory,
  detectDEXPrograms
} = require('../utils/tx-analytics');

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

// Wrapper with retry logic (uses watch-core.fetchTransaction)
async function getTransactionWithRetry(connection, signature, maxRetries = 2, timeoutMs = 8000) {
  const { fetchTransaction } = require('../utils/watch-core');
  let triedJsonFallback = false;
  
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      // Race the fetch against a timeout
      const fetchPromise = fetchTransaction(connection, signature, {
        encoding: 'jsonParsed',
        maxSupportedTransactionVersion: 0
      });
      
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Transaction fetch timeout')), timeoutMs)
      );
      
      const tx = await Promise.race([fetchPromise, timeoutPromise]);
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
          const fetchJsonPromise = fetchTransaction(connection, signature, {
            encoding: 'json',
            maxSupportedTransactionVersion: 0
          });
          
          const timeoutJsonPromise = new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Transaction fetch timeout')), timeoutMs)
          );
          
          const txJson = await Promise.race([fetchJsonPromise, timeoutJsonPromise]);
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

// Wrapper: delegates to watch-core.parseTransferEvents
// This maintains backward compatibility for CLI tx command
function parseTransferEvents(tx, mintAddress, tokenProgram = 'spl-token') {
  const { parseTransferEvents: coreParseTransferEvents } = require('../utils/watch-core');
  return coreParseTransferEvents(tx, mintAddress);
}

// OLD IMPLEMENTATION REMOVED - now uses watch-core
// All parsing logic has been consolidated into src/utils/watch-core.js

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
  let timeoutMs = parseInt(options.timeout) || 8000;
  let maxRetries = parseInt(options.retries) || 2;

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

    // Fallback Method: Also query mint address directly for signatures
    // This catches transfers that might not show up in token account queries
    try {
      const mintSigs = await getTokenAccountSignatures(
        connection,
        mint,
        Math.ceil(limit * 2) // Get more from mint address
      );
      for (const sig of mintSigs) {
        allSignatures.push({
          signature: sig.signature,
          blockTime: sig.blockTime,
          account: 'mint' // Mark as from mint address
        });
      }
      await sleep(500);
    } catch (e) {
      // Continue if mint address query fails (some tokens don't have mint signatures)
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

    // Fetch and parse transactions sequentially with live progress
    process.stderr.write('Parsing transactions...\n');
    const allEvents = [];
    const allTransactions = []; // Store for DEX program detection
    let transferCount = 0;
    let mintCount = 0;

    let txFetchCount = 0;
    let txNullCount = 0;
    let txNoMetaCount = 0;
    let txErrorCount = 0;
    
    for (let i = 0; i < filteredSigs.length; i++) {
      const sig = filteredSigs[i];
      const shortSig = sig.signature.slice(0, 8) + '...' + sig.signature.slice(-4);
      const progress = `[${i + 1}/${filteredSigs.length}]`;
      
      // Show which transaction we're fetching
      process.stderr.write(`  ${progress} ${shortSig} fetching...\r`);
      
      try {
        const tx = await getTransactionWithRetry(connection, sig.signature, maxRetries, timeoutMs);
        txFetchCount++;
        
        if (!tx) {
          txNullCount++;
          process.stderr.write(`  ${progress} ${shortSig} ⏱ unavailable/timeout          \n`);
          continue;
        }
        
        if (!tx.meta) {
          txNoMetaCount++;
          process.stderr.write(`  ${progress} ${shortSig} ✗ no metadata               \n`);
          continue;
        }
        
        // Store transaction for analytics (DEX program detection)
        allTransactions.push(tx);
        
        const events = parseTransferEvents(tx, mint);
        
        // Show success with event count
        if (events.length > 0) {
          process.stderr.write(`  ${progress} ${shortSig} ✓ ${events.length} event(s)              \n`);
        } else {
          process.stderr.write(`  ${progress} ${shortSig} ✓ no relevant events       \n`);
        }
        
        for (const event of events) {
          event.signature = sig.signature;
          allEvents.push(event);
          if (event.type === 'transfer') transferCount++;
          if (event.type === 'mint') mintCount++;
        }
      } catch (e) {
        txErrorCount++;
        process.stderr.write(`  ${progress} ${shortSig} ✗ error: ${e.message.slice(0, 30)}...\n`);
        continue;
      }

      // Small delay between transaction fetches
      if (i < filteredSigs.length - 1) {
        await sleep(500);
      }
    }
    
    // Final summary
    const successCount = txFetchCount - txNullCount - txNoMetaCount;
    process.stderr.write(`\nParsing transactions... ✓ (${successCount} succeeded, ${txNullCount} unavailable, ${txNoMetaCount} no metadata, ${txErrorCount} errors)\n\n`);
    
    // Debug output if no events found
    if (allEvents.length === 0 && process.env.DEBUG === '1') {
      console.error(`DEBUG: Fetched ${txFetchCount} transactions, ${txNullCount} were null, ${txNoMetaCount} had no meta`);
      if (allTransactions.length > 0) {
        const sampleTx = allTransactions[0];
        console.error(`DEBUG: Sample tx has meta: ${!!sampleTx.meta}`);
        console.error(`DEBUG: Sample tx preTokenBalances: ${sampleTx.meta?.preTokenBalances?.length || 0}`);
        console.error(`DEBUG: Sample tx postTokenBalances: ${sampleTx.meta?.postTokenBalances?.length || 0}`);
        if (sampleTx.meta?.preTokenBalances) {
          const mints = new Set();
          sampleTx.meta.preTokenBalances.forEach(b => mints.add(b.mint));
          sampleTx.meta.postTokenBalances?.forEach(b => mints.add(b.mint));
          console.error(`DEBUG: Mints in sample tx: ${Array.from(mints).join(', ')}`);
          console.error(`DEBUG: Looking for mint: ${mint}`);
        }
      }
    }

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
      // Check if JSON output is requested
      const enableJson = options.json;
      if (enableJson) {
        const jsonOutput = {
          mint: mint,
          time_window: {
            hours: hours,
            cutoff_time: cutoffTime
          },
          events: [],
          wallet_stats: {},
          roles: {},
          pattern_label: 'Quiet',
          likely_scenarios: ['No activity observed in time window'],
          confidence: 0.0,
          feature_ratings: {
            'Observed Transfers': 'Low',
            'Wallet Concentration': 'Low',
            'Time Clustering': 'Low'
          }
        };
        console.log(JSON.stringify(jsonOutput, null, 2));
        return;
      }
      
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

    // Analytics computation (only if flags are enabled)
    const enableStory = options.story || options.all;
    const enableInterpret = options.interpret || options.all;
    const enableRoles = options.roles || options.all;
    const enableSignal = options.signal || options.all;
    const enableJson = options.json;
    
    if (enableStory || enableInterpret || enableRoles || enableSignal || enableJson) {
      // Compute analytics
      const analyticsStats = computeWalletStats(uniqueEvents);
      const analyticsRoles = classifyWalletRoles(analyticsStats, tokenAccounts);
      const pattern = determinePattern(uniqueEvents, analyticsStats, analyticsRoles);
      const signal = calculateSignalStrength(uniqueEvents, analyticsStats);
      const story = generateStory(uniqueEvents, analyticsStats, analyticsRoles);
      const dexPrograms = detectDEXPrograms(allTransactions);
      
      // JSON output
      if (enableJson) {
        const jsonOutput = {
          mint: mint,
          time_window: {
            hours: hours,
            cutoff_time: cutoffTime
          },
          events: uniqueEvents.map(e => ({
            type: e.type,
            amount: e.amount,
            source: e.source,
            destination: e.destination,
            signature: e.signature,
            timestamp: e.timestamp
          })),
          wallet_stats: Object.fromEntries(
            Array.from(analyticsStats.entries()).map(([addr, stats]) => [
              addr,
              {
                inbound_count: stats.inbound_count,
                outbound_count: stats.outbound_count,
                inbound_total: stats.inbound_total,
                outbound_total: stats.outbound_total,
                net_flow: stats.net_flow,
                total_volume: stats.total_volume,
                unique_counterparties: stats.unique_counterparties,
                burstiness: stats.burstiness
              }
            ])
          ),
          roles: Object.fromEntries(analyticsRoles),
          pattern_label: pattern.pattern,
          likely_scenarios: pattern.scenarios,
          confidence: signal.confidence,
          feature_ratings: signal.feature_ratings
        };
        console.log(JSON.stringify(jsonOutput, null, 2));
        return;
      }
      
      // Text output sections
      if (enableStory) {
        console.log('');
        console.log(sectionHeader('Story'));
        console.log(`  ${story}`);
      }
      
      if (enableInterpret) {
        console.log('');
        console.log(sectionHeader('Interpretation'));
        console.log(`  Pattern: ${pattern.pattern}`);
        console.log('');
        console.log('  Likely Scenarios:');
        for (const scenario of pattern.scenarios) {
          console.log(`    • ${scenario}`);
        }
      }
      
      if (enableRoles) {
        console.log('');
        console.log(sectionHeader('Wallet Roles'));
        if (analyticsRoles.size === 0) {
          console.log('  No wallets matched role classification criteria.');
        } else {
          // Sort by total volume
          const roleWallets = Array.from(analyticsRoles.entries())
            .map(([address, role]) => ({
              address,
              role,
              stats: analyticsStats.get(address)
            }))
            .filter(w => w.stats)
            .sort((a, b) => (b.stats.total_volume || 0) - (a.stats.total_volume || 0));
          
          for (const wallet of roleWallets) {
            const stats = wallet.stats;
            console.log(`  ${wallet.role}: ${wallet.address}`);
            console.log(`    Volume: ${stats.total_volume.toLocaleString('en-US', { maximumFractionDigits: 2 })} | Net: ${stats.net_flow >= 0 ? '+' : ''}${stats.net_flow.toLocaleString('en-US', { maximumFractionDigits: 2 })} | Counterparties: ${stats.unique_counterparties}`);
          }
        }
      }
      
      if (enableSignal) {
        console.log('');
        console.log(sectionHeader('Signal Strength'));
        console.log('  Feature Ratings:');
        for (const [feature, rating] of Object.entries(signal.feature_ratings)) {
          console.log(`    ${feature}: ${rating}`);
        }
        console.log('');
        console.log(`  Confidence: ${signal.confidence.toFixed(2)}`);
      }
      
      // Context section (optional, only if DEX programs detected)
      if (dexPrograms.length > 0) {
        console.log('');
        console.log(sectionHeader('Context'));
        console.log('  Known DEX programs detected:');
        for (const program of dexPrograms) {
          console.log(`    • ${program}`);
        }
      }
    }

  } catch (e) {
    console.error(`Error: ${e.message}`);
    process.exit(1);
  }
}

module.exports = txCommand;
module.exports.parseTransferEvents = parseTransferEvents;
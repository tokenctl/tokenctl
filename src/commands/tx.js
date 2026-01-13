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
  const debug = process.env.DEBUG === '1';

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
  
  if (debug) {
    console.error(`DEBUG parseTransferEvents: Found ${preMap.size} pre balances, ${postMap.size} post balances for mint ${mintStr}`);
    for (const [key, pre] of preMap.entries()) {
      const post = postMap.get(key) || { amount: 0 };
      console.error(`DEBUG parseTransferEvents: Account ${key}: pre=${pre.amount}, post=${post.amount}, change=${post.amount - pre.amount}`);
    }
  }
  
  // Find all accounts with balance changes
  const allAccounts = new Set([...preMap.keys(), ...postMap.keys()]);
  
  if (debug) {
    console.error(`DEBUG parseTransferEvents: Checking ${allAccounts.size} accounts for balance changes`);
  }
  
  for (const accountKey of allAccounts) {
    const pre = preMap.get(accountKey) || { amount: 0 };
    const post = postMap.get(accountKey) || { amount: 0 };
    const change = post.amount - pre.amount;
    
    if (debug) {
      console.error(`DEBUG parseTransferEvents: Account ${accountKey}: pre=${pre.amount}, post=${post.amount}, change=${change}, abs=${Math.abs(change)}`);
    }
    
    if (Math.abs(change) > 0.000001) { // Ignore tiny rounding errors
      const owner = post.owner || pre.owner || accountKey;
      
      if (change > 0) {
        // Received tokens - find who sent (look for negative change)
        // Relaxed matching: look for any negative change, prefer closest match
        let source = null;
        let bestMatch = Infinity;
        for (const [otherKey, otherPre] of preMap.entries()) {
          if (otherKey === accountKey) continue; // Skip self
          const otherPost = postMap.get(otherKey) || { amount: 0 };
          const otherChange = otherPost.amount - otherPre.amount;
          if (otherChange < -0.000001) {
            const diff = Math.abs(Math.abs(otherChange) - change);
            if (diff < bestMatch && diff < change * 0.1) { // Allow 10% difference for fees/etc
              bestMatch = diff;
              source = otherPre.owner || otherPost.owner || otherKey;
            }
          }
        }
        
        if (debug) {
          console.error(`DEBUG parseTransferEvents: Adding transfer event: ${source || 'unknown'} -> ${owner}, amount: ${change}`);
        }
        
        events.push({
          type: 'transfer',
          amount: change,
          source: source || 'unknown',
          destination: owner,
          timestamp: tx.blockTime
        });
      } else if (change < 0) {
        // Sent tokens - find who received (look for positive change)
        // Relaxed matching: look for any positive change, prefer closest match
        let destination = null;
        let bestMatch = Infinity;
        for (const [otherKey, otherPre] of preMap.entries()) {
          if (otherKey === accountKey) continue; // Skip self
          const otherPost = postMap.get(otherKey) || { amount: 0 };
          const otherChange = otherPost.amount - otherPre.amount;
          if (otherChange > 0.000001) {
            const diff = Math.abs(Math.abs(change) - otherChange);
            if (diff < bestMatch && diff < Math.abs(change) * 0.1) { // Allow 10% difference
              bestMatch = diff;
              destination = otherPost.owner || otherPre.owner || otherKey;
            }
          }
        }
        
        if (debug) {
          console.error(`DEBUG parseTransferEvents: Adding transfer event: ${owner} -> ${destination || 'unknown'}, amount: ${Math.abs(change)}`);
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
            // Check if this involves our mint
            let involvesOurMint = false;
            
            // Direct mint match
            if (info.mint === mintStr) {
              involvesOurMint = true;
            } else {
              // Check if source or destination accounts are in our token balance maps
              // (if they appear in pre/post balances for our mint, they're our token accounts)
              const sourceInMap = info.source && (preMap.has(info.source) || postMap.has(info.source));
              const destInMap = info.destination && (preMap.has(info.destination) || postMap.has(info.destination));
              if (sourceInMap || destInMap) {
                involvesOurMint = true;
              }
            }
            
            if (involvesOurMint) {
              const amount = info.tokenAmount?.uiAmount || parseFloat(info.amount || 0) / 1e9 || 0;
              if (amount > 0) {
                if (debug) {
                  console.error(`DEBUG parseTransferEvents: Found transfer from instruction: ${info.source || 'unknown'} -> ${info.destination || 'unknown'}, amount: ${amount}, mint check: ${info.mint === mintStr ? 'direct' : 'account match'}`);
                }
                events.push({
                  type: 'transfer',
                  amount,
                  source: info.source || 'unknown',
                  destination: info.destination || 'unknown',
                  timestamp: tx.blockTime
                });
              }
            } else if (debug && info.source && info.destination) {
              console.error(`DEBUG parseTransferEvents: Transfer instruction found but mint doesn't match: ${info.mint || 'no mint'}, source in map: ${preMap.has(info.source) || postMap.has(info.source)}, dest in map: ${preMap.has(info.destination) || postMap.has(info.destination)}`);
            }
          }
        }
        if (ix.parsed.type === 'mintTo' || ix.parsed.type === 'mintToChecked') {
          const info = ix.parsed.info;
          if (info && info.mint === mintStr) {
            const amount = info.tokenAmount?.uiAmount || parseFloat(info.amount || 0) / 1e9 || 0;
            if (amount > 0) {
              if (debug) {
                console.error(`DEBUG parseTransferEvents: Found mint from instruction: amount: ${amount}, destination: ${info.account || info.destination || 'unknown'}`);
              }
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
              // Check if this involves our mint (same logic as top-level instructions)
              let involvesOurMint = false;
              if (info.mint === mintStr) {
                involvesOurMint = true;
              } else {
                const sourceInMap = info.source && (preMap.has(info.source) || postMap.has(info.source));
                const destInMap = info.destination && (preMap.has(info.destination) || postMap.has(info.destination));
                if (sourceInMap || destInMap) {
                  involvesOurMint = true;
                }
              }
              
              if (involvesOurMint) {
                const amount = info.tokenAmount?.uiAmount || parseFloat(info.amount || 0) / 1e9 || 0;
                if (amount > 0) {
                  if (debug) {
                    console.error(`DEBUG parseTransferEvents: Found transfer from inner instruction: ${info.source || 'unknown'} -> ${info.destination || 'unknown'}, amount: ${amount}`);
                  }
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
          }
          if (ix.parsed.type === 'mintTo' || ix.parsed.type === 'mintToChecked') {
            const info = ix.parsed.info;
            if (info && info.mint === mintStr) {
              const amount = info.tokenAmount?.uiAmount || parseFloat(info.amount || 0) / 1e9 || 0;
              if (amount > 0) {
                if (debug) {
                  console.error(`DEBUG parseTransferEvents: Found mint from inner instruction: amount: ${amount}`);
                }
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
  }

  // Method 3: Fallback - if we found the mint in balances but no changes,
  // check ALL transfer instructions in the transaction more aggressively
  // This handles cases where transfers happen but balances net to zero (e.g., DEX swaps)
  // Also check if ANY token account in the transaction matches accounts we know about
  const knownTokenAccounts = new Set([...preMap.keys(), ...postMap.keys()]);
  
  if (knownTokenAccounts.size > 0 || preBalances.some(b => b.mint === mintStr) || postBalances.some(b => b.mint === mintStr)) {
    // We found our mint in the transaction - check all instructions aggressively
    const allInstructions = [
      ...(tx.transaction?.message?.instructions || []),
      ...(tx.meta?.innerInstructions || []).flatMap(inner => inner.instructions || [])
    ];
    
    // Also build a set of all token account addresses from the transaction
    const allTokenAccountsInTx = new Set();
    for (const pre of preBalances) {
      if (pre.owner) allTokenAccountsInTx.add(pre.owner);
    }
    for (const post of postBalances) {
      if (post.owner) allTokenAccountsInTx.add(post.owner);
    }
    
    for (const ix of allInstructions) {
      if (ix.program === 'spl-token' || ix.programId === 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA') {
        if (ix.parsed && (ix.parsed.type === 'transfer' || ix.parsed.type === 'transferChecked')) {
          const info = ix.parsed.info;
          if (info) {
            // Check if source or destination appears in our known accounts OR in any token account in the tx
            const sourceInMap = info.source && (knownTokenAccounts.has(info.source) || allTokenAccountsInTx.has(info.source));
            const destInMap = info.destination && (knownTokenAccounts.has(info.destination) || allTokenAccountsInTx.has(info.destination));
            
            // Also check if mint matches directly
            const mintMatches = info.mint === mintStr;
            
            if (sourceInMap || destInMap || mintMatches) {
              const amount = info.tokenAmount?.uiAmount || parseFloat(info.amount || 0) / 1e9 || 0;
              if (amount > 0) {
                // Check if we already have this event (avoid duplicates)
                const alreadyExists = events.some(e => 
                  e.type === 'transfer' &&
                  Math.abs(e.amount - amount) < 0.000001 &&
                  e.source === (info.source || 'unknown') &&
                  e.destination === (info.destination || 'unknown')
                );
                
                if (!alreadyExists) {
                  if (debug) {
                    console.error(`DEBUG parseTransferEvents: Found transfer via fallback method: ${info.source || 'unknown'} -> ${info.destination || 'unknown'}, amount: ${amount}, match: ${mintMatches ? 'mint' : (sourceInMap || destInMap ? 'account' : 'none')}`);
                  }
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
          }
        }
      }
    }
  }

  // Deduplicate events (same signature, same amount, same accounts)
  const uniqueEvents = [];
  const seen = new Set();
  for (const event of events) {
    const key = `${event.type}-${event.amount.toFixed(6)}-${event.source}-${event.destination}`;
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

    // Fetch and parse transactions sequentially
    process.stderr.write('Parsing transactions...\r');
    const allEvents = [];
    const allTransactions = []; // Store for DEX program detection
    let transferCount = 0;
    let mintCount = 0;

    let txFetchCount = 0;
    let txNullCount = 0;
    let txNoMetaCount = 0;
    
    for (let i = 0; i < filteredSigs.length; i++) {
      const sig = filteredSigs[i];
      try {
        const tx = await getTransactionWithRetry(connection, sig.signature);
        txFetchCount++;
        
        if (!tx) {
          txNullCount++;
          continue;
        }
        
        if (!tx.meta) {
          txNoMetaCount++;
          continue;
        }
        
        // Store transaction for analytics (DEX program detection)
        allTransactions.push(tx);
        
        const events = parseTransferEvents(tx, mint);
        for (const event of events) {
          event.signature = sig.signature;
          allEvents.push(event);
          if (event.type === 'transfer') transferCount++;
          if (event.type === 'mint') mintCount++;
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
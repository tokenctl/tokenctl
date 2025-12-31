const { PublicKey } = require('@solana/web3.js');
const { getRpcUrl, createConnection, validateMint, rpcRetry, sleep } = require('../utils/rpc');
const { fetchMintInfo } = require('../utils/mint');
const { colorize } = require('../utils/colors');
const {
  computeIntervalMetrics,
  computeBaseline,
  detectDrift,
  detectRoleChanges,
  detectDormantActivation,
  calculateSignalConfidence,
  detectStructuralAlerts,
  computeWalletStats,
  classifyWalletRoles
} = require('../utils/watch-analytics');

// Import parseTransferEvents from tx.js (reuse logic)
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
  const instructions = (tx.transaction?.message?.instructions) || [];
  for (const ix of instructions) {
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

  // Check inner instructions
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

  // Deduplicate events
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

function formatTime() {
  const date = new Date();
  return date.toISOString().replace('T', ' ').substring(0, 19);
}

async function getTransactionWithRetry(connection, signature, maxRetries = 2) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const tx = await connection.getTransaction(signature, {
        maxSupportedTransactionVersion: 0,
        encoding: 'jsonParsed'
      });
      if (tx) return tx;
    } catch (e) {
      const errorMsg = e.message || String(e);
      if (errorMsg.includes('At path') && errorMsg.includes('Expected') && attempt < maxRetries) {
        // Schema error - try with json encoding
        try {
          const tx = await connection.getTransaction(signature, {
            maxSupportedTransactionVersion: 0,
            encoding: 'json'
          });
          if (tx) return tx;
        } catch (e2) {
          // Both failed, continue to next attempt
        }
      }
      if (attempt === maxRetries) {
        return null;
      }
      await sleep(1000);
    }
  }
  return null;
}

async function watchCommand(mint, options) {
  if (!validateMint(mint)) {
    console.error('Error: Invalid mint address');
    process.exit(1);
  }

  const rpcUrl = getRpcUrl(options);
  const connection = createConnection(rpcUrl);
  const interval = parseInt(options.interval) || 30;
  const transferThreshold = parseFloat(options.transferThreshold) || 1000000;
  const mintThreshold = parseFloat(options.mintThreshold) || 1000000;
  const strict = options.strict || false;
  const quiet = options.quiet || false;
  const jsonOutput = options.json || false;

  // Behavioral monitoring state
  const intervalMetrics = [];
  let baseline = null;
  let previousRoles = new Map();
  let activeWallets = new Set();
  let topTokenAccounts = [];
  let firstDEXDetected = false;

  let lastMintInfo = null;
  let lastSupply = null;
  let lastSignature = null;
  let tokenName = null;

  // Fetch initial token info to get name and top accounts
  try {
    const initialMintInfo = await rpcRetry(() => fetchMintInfo(connection, mint));
    if (initialMintInfo && initialMintInfo.name) {
      tokenName = initialMintInfo.name;
    }
    
    // Fetch top token accounts for role classification
    try {
      const mintPubkey = new PublicKey(mint);
      const result = await rpcRetry(() => connection.getTokenLargestAccounts(mintPubkey));
      if (result && result.value) {
        topTokenAccounts = result.value.map(acc => ({
          address: acc.address.toString(),
          amount: Number(acc.amount)
        }));
      }
    } catch (e) {
      // Continue without top accounts
    }
  } catch (e) {
    // Continue without name if fetch fails
  }

  if (!jsonOutput) {
    console.log(`[${formatTime()}] WATCH start`);
    if (tokenName) {
      console.log(`Monitoring: ${tokenName} (${mint})`);
    } else {
      console.log(`Monitoring: ${mint}`);
    }
    console.log(`Interval: ${interval}s`);
    if (strict) {
      console.log(`Mode: strict (lower thresholds)`);
    }
    if (quiet) {
      console.log(`Mode: quiet (alerts only)`);
    }
    console.log('');
  }

  let checkCount = 0;

  while (true) {
    try {
      if (!quiet && !jsonOutput) {
        process.stderr.write(`[${formatTime()}] Checking...\r`);
      }
      const mintInfo = await rpcRetry(() => fetchMintInfo(connection, mint));
      
      if (!mintInfo) {
        if (!quiet && !jsonOutput) {
          console.log(`\n[${formatTime()}] RPC error, retrying in ${interval}s...`);
        }
        await sleep(interval * 1000);
        continue;
      }
      
      // Update token name if we got it
      if (mintInfo.name && !tokenName) {
        tokenName = mintInfo.name;
      }
      
      checkCount++;
      
      // Format supply properly
      let supplyDisplay = 'unknown';
      if (mintInfo.supplyRaw && mintInfo.decimals) {
        const rawAmount = BigInt(mintInfo.supplyRaw);
        const divisor = BigInt(10 ** mintInfo.decimals);
        const wholePart = rawAmount / divisor;
        const fractionalPart = rawAmount % divisor;
        const fractionalStr = fractionalPart.toString().padStart(mintInfo.decimals, '0');
        const cleanFractional = fractionalStr.replace(/0+$/, '');
        const supplyValue = cleanFractional ? `${wholePart.toString()}.${cleanFractional}` : wholePart.toString();
        const parts = supplyValue.split('.');
        parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
        supplyDisplay = parts.join('.');
      } else {
        supplyDisplay = mintInfo.supply.toLocaleString();
      }
      
      // Check for authority changes
      let authorityChanged = false;
      if (lastMintInfo) {
        if (mintInfo.mintAuthority?.toString() !== lastMintInfo.mintAuthority?.toString() ||
            mintInfo.freezeAuthority?.toString() !== lastMintInfo.freezeAuthority?.toString()) {
          authorityChanged = true;
          if (!quiet && !jsonOutput) {
            console.log(`[${formatTime()}] ALERT authority_change`);
            console.log(`  Mint Auth: ${mintInfo.mintAuthority ? mintInfo.mintAuthority.toString() : 'revoked'}`);
            console.log(`  Freeze Auth: ${mintInfo.freezeAuthority ? mintInfo.freezeAuthority.toString() : 'revoked'}`);
          }
          if (jsonOutput) {
            console.log(JSON.stringify({
              timestamp: formatTime(),
              type: 'authority_change',
              mint_authority: mintInfo.mintAuthority ? mintInfo.mintAuthority.toString() : null,
              freeze_authority: mintInfo.freezeAuthority ? mintInfo.freezeAuthority.toString() : null
            }));
          }
        }

        if (mintInfo.supply !== lastSupply) {
          if (!quiet && !jsonOutput) {
            const alertText = `[${formatTime()}] ALERT supply_change`;
            console.log(colorize(alertText, 'white', 'bgRed'));
            console.log(`  Previous: ${lastSupply.toLocaleString()}`);
            console.log(`  Current: ${mintInfo.supply.toLocaleString()}`);
          }
          if (jsonOutput) {
            console.log(JSON.stringify({
              timestamp: formatTime(),
              type: 'supply_change',
              previous: lastSupply,
              current: mintInfo.supply
            }));
          }
        }
      }

      lastMintInfo = mintInfo;
      lastSupply = mintInfo.supply;

      // Collect events for this interval
      const intervalEvents = [];
      const intervalTransactions = [];
      let authorityChangedThisInterval = authorityChanged;

      try {
        // Get signatures from mint address
        const signatures = await rpcRetry(() => 
          connection.getSignaturesForAddress(new PublicKey(mint), { limit: 20 })
        );

        if (signatures && signatures.length > 0) {
          const newestSig = signatures[0].signature;
          
          // Determine which signatures are new
          const newSigs = [];
          if (lastSignature) {
            let foundLast = false;
            for (const sig of signatures) {
              if (sig.signature === lastSignature) {
                foundLast = true;
                break;
              }
              newSigs.push(sig);
            }
            if (!foundLast) {
              newSigs.push(...signatures.slice(0, 10));
            }
          } else {
            newSigs.push(...signatures.slice(0, 10));
          }

          // Fetch and parse transactions
          for (const sig of newSigs) {
            try {
              const tx = await getTransactionWithRetry(connection, sig.signature);
              
              if (tx && tx.meta) {
                intervalTransactions.push(tx);
                
                const events = parseTransferEvents(tx, mint);
                for (const event of events) {
                  event.signature = sig.signature;
                  intervalEvents.push(event);
                }
                
                // Legacy alerts for large transfers/mints
                const parsed = parseTransaction(tx, mint);
                if (parsed.mintEvent && parsed.mintAmount >= mintThreshold) {
                  if (!quiet && !jsonOutput) {
                    console.log(`[${formatTime()}] ALERT mint_event ${parsed.mintAmount.toLocaleString()}`);
                    console.log(`  Signature: ${sig.signature}`);
                  }
                  if (jsonOutput) {
                    console.log(JSON.stringify({
                      timestamp: formatTime(),
                      type: 'mint_event',
                      amount: parsed.mintAmount,
                      signature: sig.signature
                    }));
                  }
                }

                if (parsed.transfer && parsed.transferAmount >= transferThreshold) {
                  if (!quiet && !jsonOutput) {
                    console.log(`[${formatTime()}] ALERT large_transfer ${parsed.transferAmount.toLocaleString()}`);
                    console.log(`  Signature: ${sig.signature}`);
                  }
                  if (jsonOutput) {
                    console.log(JSON.stringify({
                      timestamp: formatTime(),
                      type: 'large_transfer',
                      amount: parsed.transferAmount,
                      signature: sig.signature
                    }));
                  }
                }
              }
            } catch (e) {
              continue;
            }
          }

          lastSignature = newestSig;
        }
      } catch (e) {
        // Continue on signature fetch errors
      }

      // Compute interval metrics
      const currentMetrics = computeIntervalMetrics(intervalEvents);
      intervalMetrics.push(currentMetrics);

      // Update baseline after 3 intervals
      if (intervalMetrics.length >= 3) {
        baseline = computeBaseline(intervalMetrics, 3);
      }

      // Compute wallet stats and roles for this interval
      const walletStats = computeWalletStats(intervalEvents);
      const currentRoles = classifyWalletRoles(walletStats, topTokenAccounts);

      // Detect behavioral drift
      if (baseline) {
        const driftAlerts = detectDrift(currentMetrics, baseline, strict);
        for (const alert of driftAlerts) {
          const confidence = calculateSignalConfidence(
            baseline.intervals_observed,
            currentMetrics.transfers_per_interval,
            baseline.transfers_per_interval
          );
          const baselineStatus = baseline.intervals_observed >= 3 ? 'established' : 'forming';
          
          if (!quiet && !jsonOutput) {
            console.log(`[${formatTime()}] ALERT behavior_drift ${alert.type} ${alert.explanation}`);
            console.log(`  Baseline: ${baselineStatus}, Confidence: ${confidence.toFixed(2)}`);
          }
          if (jsonOutput) {
            console.log(JSON.stringify({
              timestamp: formatTime(),
              type: 'behavior_drift',
              drift_type: alert.type,
              explanation: alert.explanation,
              baseline_status: baselineStatus,
              confidence: confidence
            }));
          }
        }
      }

      // Detect role changes
      const roleChangeAlerts = detectRoleChanges(currentRoles, previousRoles, topTokenAccounts);
      for (const alert of roleChangeAlerts) {
        if (!quiet && !jsonOutput) {
          console.log(`[${formatTime()}] ALERT role_change ${alert.wallet} ${alert.old_role} -> ${alert.new_role}`);
        }
        if (jsonOutput) {
          console.log(JSON.stringify({
            timestamp: formatTime(),
            type: 'role_change',
            wallet: alert.wallet,
            old_role: alert.old_role,
            new_role: alert.new_role
          }));
        }
      }

      // Detect dormant wallet activation
      const dormantThreshold = strict ? transferThreshold * 0.5 : transferThreshold;
      const dormantAlerts = detectDormantActivation(intervalEvents, activeWallets, dormantThreshold);
      for (const alert of dormantAlerts) {
        if (!quiet && !jsonOutput) {
          console.log(`[${formatTime()}] ALERT dormant_activation ${alert.wallet} ${alert.amount.toFixed(2)}`);
        }
        if (jsonOutput) {
          console.log(JSON.stringify({
            timestamp: formatTime(),
            type: 'dormant_activation',
            wallet: alert.wallet,
            amount: alert.amount
          }));
        }
      }

      // Detect structural alerts
      const dominantThreshold = strict ? 0.5 : 0.6;
      const structuralAlerts = detectStructuralAlerts(
        currentMetrics,
        baseline,
        intervalTransactions,
        authorityChangedThisInterval,
        dominantThreshold
      );
      for (const alert of structuralAlerts) {
        // Only alert on first DEX interaction once
        if (alert.type === 'first_dex_interaction' && firstDEXDetected) {
          continue;
        }
        if (alert.type === 'first_dex_interaction') {
          firstDEXDetected = true;
        }
        
        if (!quiet && !jsonOutput) {
          console.log(`[${formatTime()}] ALERT ${alert.type} ${alert.explanation}`);
        }
        if (jsonOutput) {
          const jsonAlert = {
            timestamp: formatTime(),
            type: alert.type,
            explanation: alert.explanation
          };
          if (alert.dex_programs) jsonAlert.dex_programs = alert.dex_programs;
          if (alert.share !== undefined) jsonAlert.share = alert.share;
          console.log(JSON.stringify(jsonAlert));
        }
      }

      // Update active wallets for next interval
      for (const event of intervalEvents) {
        if (event.source !== 'unknown') activeWallets.add(event.source);
        if (event.destination !== 'unknown') activeWallets.add(event.destination);
      }

      // Update previous roles
      previousRoles = new Map(currentRoles);

      // Print interval summary (unless quiet mode)
      if (!quiet && !jsonOutput) {
        const nameDisplay = tokenName ? `${tokenName} - ` : '';
        console.log(`[${formatTime()}] Check #${checkCount} - ${nameDisplay}Supply: ${supplyDisplay}, Auth: ${mintInfo.mintAuthority ? 'EXISTS' : 'revoked'}`);
        if (baseline) {
          console.log(`  Baseline: ${baseline.transfers_per_interval.toFixed(1)} transfers/interval, ${baseline.avg_transfer_size.toFixed(2)} avg size`);
        } else {
          console.log(`  Baseline: forming (${intervalMetrics.length}/3 intervals)`);
        }
        console.log(`  Current: ${currentMetrics.transfers_per_interval} transfers, ${currentMetrics.unique_wallets_per_interval} wallets`);
      }

      await sleep(interval * 1000);

    } catch (e) {
      const errorMsg = e.message || String(e);
      // Check if it's a network/RPC error
      const isNetworkError = errorMsg.includes('fetch failed') || 
                            errorMsg.includes('ECONNREFUSED') ||
                            errorMsg.includes('ETIMEDOUT') ||
                            errorMsg.includes('ENOTFOUND') ||
                            errorMsg.includes('network') ||
                            errorMsg.includes('timeout') ||
                            errorMsg.includes('failed to get info');
      
      if (isNetworkError) {
        if (!quiet && !jsonOutput) {
          const nameDisplay = tokenName ? `${tokenName} - ` : '';
          console.log(`\n[${formatTime()}] ${nameDisplay}RPC connection error, retrying in ${interval}s...`);
        }
      } else {
        if (!quiet && !jsonOutput) {
          let cleanMsg = errorMsg;
          cleanMsg = cleanMsg.replace(/failed to get info about account [^\s]+/gi, 'RPC request failed');
          cleanMsg = cleanMsg.replace(/^Error: /i, '');
          console.log(`\n[${formatTime()}] Error: ${cleanMsg}`);
        }
      }
      await sleep(interval * 1000);
    }
  }
}

// Legacy parseTransaction for backward compatibility with large transfer/mint alerts
function parseTransaction(tx, mintAddress) {
  const result = { mintEvent: false, transfer: false, mintAmount: 0, transferAmount: 0 };

  if (!tx.transaction || !tx.transaction.message) {
    return result;
  }

  const instructions = tx.transaction.message.instructions || [];
  
  for (const ix of instructions) {
    if (ix.program === 'spl-token' || ix.programId === 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA') {
      if (ix.parsed && ix.parsed.type === 'mintTo') {
        if (ix.parsed.info.mint === mintAddress) {
          result.mintEvent = true;
          result.mintAmount = parseAmount(ix.parsed.info.tokenAmount);
        }
      }
      if (ix.parsed && ix.parsed.type === 'transfer') {
        result.transfer = true;
        result.transferAmount = parseAmount(ix.parsed.info.tokenAmount);
      }
    }
  }

  const innerInstructions = tx.meta?.innerInstructions || [];
  for (const inner of innerInstructions) {
    for (const ix of inner.instructions) {
      if (ix.program === 'spl-token' || ix.programId === 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA') {
        if (ix.parsed && ix.parsed.type === 'mintTo') {
          if (ix.parsed.info.mint === mintAddress) {
            result.mintEvent = true;
            result.mintAmount = parseAmount(ix.parsed.info.tokenAmount);
          }
        }
        if (ix.parsed && ix.parsed.type === 'transfer') {
          result.transfer = true;
          result.transferAmount = parseAmount(ix.parsed.info.tokenAmount);
        }
      }
    }
  }

  return result;
}

function parseAmount(tokenAmount) {
  if (!tokenAmount) return 0;
  if (typeof tokenAmount === 'string') {
    return parseFloat(tokenAmount) || 0;
  }
  if (tokenAmount.uiAmount !== undefined) {
    return tokenAmount.uiAmount || 0;
  }
  if (tokenAmount.amount) {
    return parseFloat(tokenAmount.amount) || 0;
  }
  return 0;
}

module.exports = watchCommand;

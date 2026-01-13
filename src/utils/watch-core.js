const { PublicKey } = require('@solana/web3.js');
const { getRpcUrl, createConnection, validateMint, rpcRetry, sleep } = require('./rpc');
const { fetchMintInfo } = require('./mint');
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
} = require('./watch-analytics');
const txCommand = require('../commands/tx');
const parseTransferEvents = txCommand.parseTransferEvents;

// Re-export parseTransaction for watch.js compatibility
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

async function getTransactionWithRetry(connection, signature, maxRetries = 2) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const tx = await connection.getTransaction(signature, {
        commitment: 'confirmed',
        maxSupportedTransactionVersion: 0
      });
      if (tx) return tx;
    } catch (e) {
      if (attempt < maxRetries) {
        await sleep(1000);
      }
    }
  }
  return null;
}

function formatTime() {
  return new Date().toISOString().replace('T', ' ').substring(0, 19) + 'Z';
}

/**
 * Core watch loop that can run in text mode or live mode
 * @param {string} mint - Mint address
 * @param {object} options - Options (interval, transferThreshold, mintThreshold, strict, quiet, jsonOutput, rpc)
 * @param {object} callbacks - Callbacks for different events
 * @returns {Promise<object>} Initial state object
 */
async function createWatchSession(mint, options, callbacks = {}) {
  if (!validateMint(mint)) {
    throw new Error('Invalid mint address');
  }

  const rpcUrl = getRpcUrl(options);
  const connection = createConnection(rpcUrl);
  const interval = parseInt(options.interval) || 30;
  const transferThreshold = parseFloat(options.transferThreshold) || 1000000;
  const mintThreshold = parseFloat(options.mintThreshold) || 1000000;
  const strict = options.strict || false;

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

  // Fetch initial token info
  try {
    const initialMintInfo = await rpcRetry(() => fetchMintInfo(connection, mint));
    if (initialMintInfo && initialMintInfo.name) {
      tokenName = initialMintInfo.name;
    }
    
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

  if (callbacks.onStart) {
    callbacks.onStart({
      mint,
      tokenName,
      interval,
      strict,
      rpcUrl
    });
  }

  let checkCount = 0;

  /**
   * Run a single watch interval
   * @returns {Promise<object>} Interval result object
   */
  async function runInterval() {
    const startedAt = Date.now();
    let rpcErrors = 0;
    let partial = false;

    try {
      const mintInfo = await rpcRetry(() => fetchMintInfo(connection, mint));
      
      if (!mintInfo) {
        rpcErrors++;
        return {
          success: false,
          error: 'RPC error',
          rpcErrors: 1,
          duration_ms: Date.now() - startedAt
        };
      }
      
      if (mintInfo.name && !tokenName) {
        tokenName = mintInfo.name;
      }
      
      checkCount++;
      
      // Format supply
      let supplyDisplay = 'unknown';
      let supplyRaw = null;
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
        supplyRaw = mintInfo.supplyRaw;
      } else {
        supplyDisplay = mintInfo.supply.toLocaleString();
        supplyRaw = mintInfo.supply;
      }
      
      // Check for authority changes
      let authorityChanged = false;
      const alerts = [];
      
      if (lastMintInfo) {
        if (mintInfo.mintAuthority?.toString() !== lastMintInfo.mintAuthority?.toString() ||
            mintInfo.freezeAuthority?.toString() !== lastMintInfo.freezeAuthority?.toString()) {
          authorityChanged = true;
          alerts.push({
            timestamp: formatTime(),
            type: 'authority_change',
            mint_authority: mintInfo.mintAuthority ? mintInfo.mintAuthority.toString() : null,
            freeze_authority: mintInfo.freezeAuthority ? mintInfo.freezeAuthority.toString() : null,
            explanation: `Mint Auth: ${mintInfo.mintAuthority ? mintInfo.mintAuthority.toString() : 'revoked'}, Freeze Auth: ${mintInfo.freezeAuthority ? mintInfo.freezeAuthority.toString() : 'revoked'}`
          });
        }

        if (mintInfo.supply !== lastSupply) {
          alerts.push({
            timestamp: formatTime(),
            type: 'supply_change',
            previous: lastSupply,
            current: mintInfo.supply,
            explanation: `Supply changed from ${lastSupply.toLocaleString()} to ${mintInfo.supply.toLocaleString()}`
          });
        }
      }

      lastMintInfo = mintInfo;
      lastSupply = mintInfo.supply;

      // Collect events for this interval
      const intervalEvents = [];
      const intervalTransactions = [];
      let authorityChangedThisInterval = authorityChanged;

      try {
        const signatures = await rpcRetry(() => 
          connection.getSignaturesForAddress(new PublicKey(mint), { limit: 20 })
        );

        if (signatures && signatures.length > 0) {
          const newestSig = signatures[0].signature;
          
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

          for (const sig of newSigs) {
            try {
              const tx = await getTransactionWithRetry(connection, sig.signature);
              
              if (tx && tx.meta) {
                intervalTransactions.push(tx);
                
                const events = parseTransferEvents(tx, mint) || [];
                if (Array.isArray(events)) {
                  for (const event of events) {
                    event.signature = sig.signature;
                    intervalEvents.push(event);
                  }
                }
                
                const parsed = parseTransaction(tx, mint);
                if (parsed.mintEvent && parsed.mintAmount >= mintThreshold) {
                  alerts.push({
                    timestamp: formatTime(),
                    type: 'mint_event',
                    amount: parsed.mintAmount,
                    signature: sig.signature,
                    explanation: `Mint event: ${parsed.mintAmount.toLocaleString()}`
                  });
                }

                if (parsed.transfer && parsed.transferAmount >= transferThreshold) {
                  alerts.push({
                    timestamp: formatTime(),
                    type: 'large_transfer',
                    amount: parsed.transferAmount,
                    signature: sig.signature,
                    explanation: `Large transfer: ${parsed.transferAmount.toLocaleString()}`
                  });
                }
              }
            } catch (e) {
              partial = true;
              continue;
            }
          }

          lastSignature = newestSig;
        }
      } catch (e) {
        partial = true;
      }

      // Compute interval metrics
      // Ensure intervalEvents is an array
      const eventsArray = Array.isArray(intervalEvents) ? intervalEvents : [];
      const currentMetrics = computeIntervalMetrics(eventsArray);
      if (currentMetrics && typeof currentMetrics === 'object') {
        intervalMetrics.push(currentMetrics);
      }

      // Update baseline after 3 intervals
      if (intervalMetrics.length >= 3) {
        baseline = computeBaseline(intervalMetrics, 3);
      }

      // Compute wallet stats and roles
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
          
          alerts.push({
            timestamp: formatTime(),
            type: 'behavior_drift',
            drift_type: alert.type,
            explanation: alert.explanation,
            baseline_status: baselineStatus,
            confidence: confidence
          });
        }
      }

      // Detect role changes
      const roleChangeAlerts = detectRoleChanges(currentRoles, previousRoles, topTokenAccounts);
      for (const alert of roleChangeAlerts) {
        alerts.push({
          timestamp: formatTime(),
          type: 'role_change',
          wallet: alert.wallet,
          old_role: alert.old_role,
          new_role: alert.new_role,
          explanation: `${alert.wallet} changed from ${alert.old_role} to ${alert.new_role}`
        });
      }

      // Detect dormant wallet activation
      const dormantThreshold = strict ? transferThreshold * 0.5 : transferThreshold;
      const dormantAlerts = detectDormantActivation(intervalEvents, activeWallets, dormantThreshold);
      for (const alert of dormantAlerts) {
        alerts.push({
          timestamp: formatTime(),
          type: 'dormant_activation',
          wallet: alert.wallet,
          amount: alert.amount,
          explanation: `Dormant wallet ${alert.wallet} activated with ${alert.amount.toFixed(2)}`
        });
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
        if (alert.type === 'first_dex_interaction' && firstDEXDetected) {
          continue;
        }
        if (alert.type === 'first_dex_interaction') {
          firstDEXDetected = true;
        }
        
        const jsonAlert = {
          timestamp: formatTime(),
          type: alert.type,
          explanation: alert.explanation
        };
        if (alert.dex_programs) jsonAlert.dex_programs = alert.dex_programs;
        if (alert.share !== undefined) jsonAlert.share = alert.share;
        alerts.push(jsonAlert);
      }

      // Update active wallets
      for (const event of intervalEvents) {
        if (event.source !== 'unknown') activeWallets.add(event.source);
        if (event.destination !== 'unknown') activeWallets.add(event.destination);
      }

      // Update previous roles
      previousRoles = new Map(currentRoles);

      // Calculate total volume for interval
      let totalVolume = 0;
      for (const event of intervalEvents) {
        totalVolume += event.amount || 0;
      }

      const endedAt = Date.now();
      const duration_ms = endedAt - startedAt;

      // Build roles summary
      const rolesSummary = [];
      for (const [address, role] of currentRoles.entries()) {
        const stats = walletStats.get(address);
        if (stats) {
          rolesSummary.push({
            wallet: address,
            role: role,
            volume: stats.total_volume,
            net_flow: stats.net_flow,
            counterparties: stats.unique_counterparties
          });
        }
      }
      rolesSummary.sort((a, b) => b.volume - a.volume);

      const result = {
        success: true,
        checkCount,
        timestamp: formatTime(),
        mint,
        tokenName,
        supply: {
          display: supplyDisplay,
          raw: supplyRaw,
          decimals: mintInfo.decimals
        },
        authorities: {
          mint_authority: mintInfo.mintAuthority ? mintInfo.mintAuthority.toString() : null,
          freeze_authority: mintInfo.freezeAuthority ? mintInfo.freezeAuthority.toString() : null
        },
        currentMetrics,
        baseline: baseline ? {
          transfers_per_interval: baseline.transfers_per_interval,
          avg_transfer_size: baseline.avg_transfer_size,
          unique_wallets_per_interval: baseline.unique_wallets_per_interval,
          dominant_wallet_share: baseline.dominant_wallet_share,
          intervals_observed: baseline.intervals_observed,
          status: baseline.intervals_observed >= 3 ? 'established' : 'forming'
        } : null,
        intervalEvents: {
          transfers: intervalEvents.filter(e => e.type === 'transfer').length,
          mints: intervalEvents.filter(e => e.type === 'mint').length,
          total: intervalEvents.length,
          totalVolume,
          uniqueWallets: currentMetrics.unique_wallets_per_interval
        },
        rolesSummary,
        alerts,
        startedAt,
        endedAt,
        duration_ms,
        rpcErrors,
        partial
      };

      // Call the onInterval callback if provided
      if (callbacks.onInterval) {
        callbacks.onInterval(result);
      }

      return result;

    } catch (e) {
      const errorMsg = e.message || String(e);
      const isNetworkError = errorMsg.includes('fetch failed') || 
                            errorMsg.includes('ECONNREFUSED') ||
                            errorMsg.includes('ETIMEDOUT') ||
                            errorMsg.includes('ENOTFOUND') ||
                            errorMsg.includes('network') ||
                            errorMsg.includes('timeout') ||
                            errorMsg.includes('failed to get info');
      
      rpcErrors++;
      
      if (callbacks.onError) {
        callbacks.onError({
          error: errorMsg,
          isNetworkError,
          rpcErrors
        });
      }

      return {
        success: false,
        error: errorMsg,
        isNetworkError,
        rpcErrors,
        duration_ms: Date.now() - startedAt
      };
    }
  }

  return {
    runInterval,
    getState: () => ({
      mint,
      tokenName,
      interval,
      strict,
      rpcUrl,
      checkCount,
      intervalMetrics,
      baseline,
      previousRoles,
      activeWallets,
      topTokenAccounts,
      firstDEXDetected
    })
  };
}

module.exports = {
  createWatchSession,
  parseTransaction,
  formatTime
};

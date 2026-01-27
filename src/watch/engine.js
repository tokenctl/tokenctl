// Headless watch engine - produces IntervalResult, does not update state
// State updates happen via updateStateFromInterval in state/state.js

const { PublicKey } = require('@solana/web3.js');
const { getRpcUrl, createConnection, validateMint, rpcRetry, sleep } = require('../utils/rpc');
const { fetchMintInfo } = require('../utils/mint');
const {
  computeIntervalMetrics,
  detectDormantActivation,
  computeWalletStats,
  classifyWalletRoles
} = require('../utils/watch-analytics');
const { fetchTransaction, parseTransferEvents } = require('../utils/watch-core');
const { runStage, updateContext, debugLog } = require('../logging/logger');
const fs = require('fs');
const path = require('path');

function formatTime() {
  return new Date().toISOString().replace('T', ' ').substring(0, 19) + 'Z';
}

function formatSupply(mintInfo) {
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
    return parts.join('.');
  }
  return mintInfo.supply.toLocaleString();
}

// TRANSFER PARSING: Supports both SPL Token and Token-2022
// This function uses parseTransferEvents from watch-core which handles both token standards
// Helper to check for mint/transfer events (used for alerts only, not parsing)
function parseTransaction(tx, mintAddress) {
  const result = { mintEvent: false, transfer: false, mintAmount: 0, transferAmount: 0 };
  if (!tx || !tx.transaction || !tx.transaction.message) return result;
  
  const events = parseTransferEvents(tx, mintAddress);
  for (const event of events) {
    if (event.type === 'mint') {
      result.mintEvent = true;
      result.mintAmount = Math.max(result.mintAmount, event.amount);
    }
    if (event.type === 'transfer') {
      result.transfer = true;
      result.transferAmount = Math.max(result.transferAmount, event.amount);
    }
  }
  return result;
}

// Fetch transactions concurrently with retries and fallback (uses watch-core.fetchTransaction)
async function fetchTransactionsConcurrently(connection, signatures, maxConcurrency = 10) {
  const results = new Array(signatures.length);
  
  // Process in batches to preserve ordering
  for (let i = 0; i < signatures.length; i += maxConcurrency) {
    const batch = signatures.slice(i, i + maxConcurrency);
    const batchPromises = batch.map(async (sig) => {
      let triedJsonFallback = false;
      
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          // Try jsonParsed first
          const tx = await fetchTransaction(connection, sig, {
            encoding: 'jsonParsed',
            commitment: 'confirmed',
            maxSupportedTransactionVersion: 0
          });
          
          // If transaction exists but no meta, try json encoding as fallback
          if (tx && !tx.meta && !triedJsonFallback) {
            triedJsonFallback = true;
            try {
              const txJson = await fetchTransaction(connection, sig, {
                encoding: 'json',
                commitment: 'confirmed',
                maxSupportedTransactionVersion: 0
              });
              if (txJson && txJson.meta) {
                return { signature: sig, transaction: txJson };
              }
            } catch (e2) {
              // Fall through to return original tx
            }
          }
          
          return { signature: sig, transaction: tx };
        } catch (e) {
          const errorMsg = e.message || String(e);
          const isRateLimit = errorMsg.includes('429') || 
                             errorMsg.includes('rate limit') ||
                             errorMsg.includes('timeout');
          
          if (isRateLimit && attempt < 1) {
            await sleep(2000);
            continue;
          }
          
          // If it's a schema parsing error, try json encoding as fallback
          if ((errorMsg.includes('At path') || errorMsg.includes('Expected')) && !triedJsonFallback) {
            triedJsonFallback = true;
            try {
              const txJson = await fetchTransaction(connection, sig, {
                encoding: 'json',
                commitment: 'confirmed',
                maxSupportedTransactionVersion: 0
              });
              return { signature: sig, transaction: txJson };
            } catch (e2) {
              // Fall through to return error
            }
          }
          
          if (attempt >= 1) {
            return { signature: sig, transaction: null, error: errorMsg };
          }
        }
      }
      
      return { signature: sig, transaction: null, error: 'Failed after retries' };
    });
    
    const batchResults = await Promise.all(batchPromises);
    // Store results in original order
    batchResults.forEach((result, batchIndex) => {
      results[i + batchIndex] = result;
    });
  }
  
  return results;
}

/**
 * Headless engine: Run a single interval and produce IntervalResult
 * Does NOT update state - that's done by updateStateFromInterval
 * 
 * @param {Object} ctx - Watch context { mint, connection, config, _internal }
 * @returns {Promise<Object>} IntervalResult
 */
async function runInterval(ctx) {
  debugLog('[ENGINE] runInterval entered');
  const { mint, connection, config, _internal } = ctx;
  const totalStart = Date.now();
  const perf = {
    signatures_fetch_ms: 0,
    transactions_fetch_ms: 0,
    parse_ms: 0,
    analytics_ms: 0,
    render_ms: 0,
    total_ms: 0
  };

  try {
    // Check token program - reject only truly unknown programs
    // Now supports both SPL Token and Token-2022
    const tokenProgram = config.tokenProgram || _internal.tokenProgram || 'spl-token';
    
    if (tokenProgram === 'unknown') {
      const errorMsg = 'Unknown token program detected. Only SPL Token (Tokenkeg) and Token-2022 (Tokenz) are supported.';
      
      // Abort interval execution - do not produce zero-filled intervals
      return {
        success: false,
        error: errorMsg,
        isUnsupportedTokenStandard: true,
        tokenProgram: tokenProgram,
        timestamp: formatTime(),
        checkCount: _internal.checkCount || 0,
        performance: { ...perf, total_ms: Date.now() - totalStart }
      };
    }
    
    // Replay mode: use recorded data (no RPC calls)
    if (_internal.replayMode) {
      const replayData = _internal.replayData;
      const index = _internal.replayIndex || 0;
      if (index >= replayData.intervals.length) {
        return {
          success: false,
          error: 'Replay data exhausted',
          timestamp: formatTime(),
          checkCount: _internal.checkCount || 0,
          performance: { ...perf, total_ms: Date.now() - totalStart }
        };
      }
      const recorded = replayData.intervals[index];
      _internal.replayIndex = index + 1;
      
      const intervalEvents = recorded.events || [];
      const currentMetrics = computeIntervalMetrics(intervalEvents);
      
      // Check for supply changes in recorded data
      const alerts = [];
      if (recorded.supply !== undefined && recorded.supply !== null && 
          _internal.lastSupply !== null && _internal.lastSupply !== undefined) {
        if (recorded.supply !== _internal.lastSupply) {
          alerts.push({
            timestamp: recorded.timestamp || formatTime(),
            type: 'supply_change',
            previous: _internal.lastSupply,
            current: recorded.supply,
            explanation: `Supply changed from ${_internal.lastSupply.toLocaleString()} to ${recorded.supply.toLocaleString()}`
          });
        }
      }
      if (recorded.supply !== undefined && recorded.supply !== null) {
        _internal.lastSupply = recorded.supply;
      }
      
      // Create mock mintInfo for integrity checks
      const mockMintInfo = recorded.supply !== undefined && recorded.supply !== null 
        ? { supply: recorded.supply, supplyRaw: recorded.supply } 
        : null;
      
      return {
        success: true,
        timestamp: recorded.timestamp || formatTime(),
        checkCount: (_internal.checkCount || 0) + 1,
        metrics: currentMetrics,
        events: intervalEvents,
        alerts,
        tokenInfo: mockMintInfo ? {
          supply: mockMintInfo.supply,
          supplyRaw: mockMintInfo.supplyRaw
        } : null,
        roles: { roles: [] },
        isFine: true,
        performance: { ...perf, total_ms: Date.now() - totalStart }
      };
    }

    // Normal mode: fetch from RPC
    
    // Token program already validated above - must be 'spl-token' at this point
    // This ensures only SPL Token (Tokenkeg) transfers are processed
    
    // Fetch mint info (with cache refresh every 10 intervals)
    const cacheAge = _internal.mintMetadataCacheAge || 0;
    let mintInfo = null;
    if (cacheAge >= 10 || !_internal.mintMetadataCache) {
      mintInfo = await rpcRetry(() => fetchMintInfo(connection, mint));
      if (mintInfo) {
        _internal.mintMetadataCache = mintInfo;
        _internal.mintMetadataCacheAge = 0;
      } else {
        mintInfo = _internal.mintMetadataCache;
      }
    } else {
      mintInfo = _internal.mintMetadataCache;
      _internal.mintMetadataCacheAge = cacheAge + 1;
    }
    
    if (!mintInfo) {
      return {
        success: false,
        error: 'RPC error: failed to fetch mint info',
        isNetworkError: true,
        timestamp: formatTime(),
        checkCount: _internal.checkCount || 0,
        performance: { ...perf, total_ms: Date.now() - totalStart }
      };
    }
    
    // Check for authority/supply changes
    const alerts = [];
    let shouldRefreshCache = false;
    if (_internal.lastMintInfo) {
      const authChanged = 
        (mintInfo.mintAuthority?.toString() !== _internal.lastMintInfo.mintAuthority?.toString()) ||
        (mintInfo.freezeAuthority?.toString() !== _internal.lastMintInfo.freezeAuthority?.toString());
      
      if (authChanged) {
        shouldRefreshCache = true; // Refresh cache on authority change
        alerts.push({
          timestamp: formatTime(),
          type: 'authority_change',
          mint_authority: mintInfo.mintAuthority ? mintInfo.mintAuthority.toString() : null,
          freeze_authority: mintInfo.freezeAuthority ? mintInfo.freezeAuthority.toString() : null,
          explanation: `Mint Auth: ${mintInfo.mintAuthority ? mintInfo.mintAuthority.toString() : 'revoked'}, Freeze Auth: ${mintInfo.freezeAuthority ? mintInfo.freezeAuthority.toString() : 'revoked'}`
        });
      }

      if (mintInfo.supply !== _internal.lastSupply) {
        alerts.push({
          timestamp: formatTime(),
          type: 'supply_change',
          previous: _internal.lastSupply,
          current: mintInfo.supply,
          explanation: `Supply changed from ${_internal.lastSupply.toLocaleString()} to ${mintInfo.supply.toLocaleString()}`
        });
      }
    }

    // Update internal tracking (will be persisted in context)
    _internal.lastMintInfo = mintInfo;
    _internal.lastSupply = mintInfo.supply;
    
    // Reset cache age if authority changed (forces refresh next interval)
    if (shouldRefreshCache) {
      _internal.mintMetadataCacheAge = 10; // Force refresh next interval
    }

    // Fetch signatures from token accounts
    // 
    // CHAIN SEMANTICS: SPL token transfers do NOT appear in getSignaturesForAddress(mint)
    // because transfers modify token account state, not mint state. The mint address only
    // shows mint/burn authority changes and initial mint operations. To discover transfers,
    // we must query token accounts (which hold balances) using getSignaturesForAddress(tokenAccount).
    // Each token account represents a wallet's balance for this token, and all transfers
    // involving that account will appear in its signature history.
    let signatures = [];
    let newSignatures = [];
    
    await runStage('fetchSignatures', { mint, rpc: config.rpcUrl }, async () => {
      const sigStart = Date.now();
      
      // Get token accounts from _internal cache, or fetch them if not available
      let topTokenAccounts = _internal.topTokenAccounts || [];
      
      // If no token accounts cached, fetch them dynamically
      // This ensures we always have token accounts to query for transfer signatures
      if (topTokenAccounts.length === 0) {
        debugLog('[ENGINE] no cached token accounts, fetching for mint', mint, 'program:', tokenProgram);
        try {
          const mintPubkey = new PublicKey(mint);
          
          // Program-aware account discovery
          // TRANSFER PARSING AUDIT: Only SPL Token (Tokenkeg) is supported
          // This code path only executes for 'spl-token' program (validated above)
          // Use getTokenLargestAccounts for SPL Token account discovery
          const result = await rpcRetry(() => connection.getTokenLargestAccounts(mintPubkey));
          if (result && result.value && result.value.length > 0) {
            topTokenAccounts = result.value.map(acc => ({
              address: acc.address.toString(),
              amount: Number(acc.amount)
            }));
            // Cache for future intervals
            _internal.topTokenAccounts = topTokenAccounts;
            debugLog('[ENGINE] fetched', topTokenAccounts.length, 'SPL token accounts');
          } else {
            debugLog('[ENGINE] getTokenLargestAccounts returned no accounts');
          }
        } catch (e) {
          const errorMsg = e.message || String(e);
          const isAuthError = errorMsg.includes('401') || 
                              errorMsg.includes('403') ||
                              errorMsg.includes('Unauthorized') ||
                              errorMsg.includes('Forbidden') ||
                              errorMsg.includes('invalid api key');
          
          if (isAuthError) {
            // Authentication error - store in _internal for TUI display and stop intervals
            const statusCode = errorMsg.match(/(\d{3})/)?.[1] || '401/403';
            _internal.rpcError = {
              type: 'auth_error',
              message: `RPC authentication failed (${statusCode}): Invalid API key`,
              details: errorMsg,
              fatal: true // Mark as fatal to stop intervals
            };
            debugLog('[ENGINE] AUTH ERROR:', _internal.rpcError.message);
            // Don't throw - let interval complete but mark as error
          } else {
            debugLog('[ENGINE] failed to fetch token accounts:', errorMsg);
            // Continue with empty array - will result in no signatures, but won't crash
          }
        }
      }
      
      // Query token accounts for signatures (this is the correct way to discover SPL transfers)
      if (topTokenAccounts.length > 0) {
        // Fetch signatures from each token account
        const perAccountLimit = Math.max(10, Math.min(20, Math.floor(100 / topTokenAccounts.length)));
        
        // Fetch signatures concurrently from all token accounts
        debugLog('[ENGINE] fetching signatures from', topTokenAccounts.length, 'token accounts');
        const fetchPromises = topTokenAccounts.map(acc => 
          rpcRetry(() => 
            connection.getSignaturesForAddress(new PublicKey(acc.address), { limit: perAccountLimit })
          ).then(result => ({
            account: acc.address,
            signatures: result || []
          })).catch(e => ({
            account: acc.address,
            signatures: [],
            error: e.message
          }))
        );
        
        const accountResults = await Promise.all(fetchPromises);
        perf.signatures_fetch_ms = Date.now() - sigStart;
        
        // Merge signatures from all accounts
        const signatureMap = new Map(); // Deduplicate by signature string
        for (const accountResult of accountResults) {
          for (const sig of accountResult.signatures) {
            if (sig.signature && !signatureMap.has(sig.signature)) {
              signatureMap.set(sig.signature, sig);
            }
          }
        }
        
        // Convert to array and sort by blockTime (descending, nulls last)
        signatures = Array.from(signatureMap.values()).sort((a, b) => {
          const aTime = a.blockTime || 0;
          const bTime = b.blockTime || 0;
          return bTime - aTime; // Descending order
        });
        debugLog('[ENGINE] merged signatures length', signatures.length);
      } else {
        // DISCOVERY GUARANTEE: Zero token accounts - surface as visible warning
        // This should be rare and indicates either a new token with no holders or an RPC issue
        perf.signatures_fetch_ms = Date.now() - sigStart;
        signatures = [];
        debugLog('[ENGINE] WARNING: No token accounts available, cannot discover transfers');
        // Store warning in _internal for TUI display
        _internal.discoveryWarning = 'No token accounts found - token may be new or have no holders';
      }
      
      // Filter out already processed signatures
      if (_internal.lastSignature) {
        for (const sig of signatures) {
          if (sig.signature === _internal.lastSignature) break;
          if (!_internal.processedSignatures.has(sig.signature)) {
            newSignatures.push(sig.signature);
          }
        }
      } else {
        newSignatures = signatures.slice(0, 10).map(s => s.signature);
      }
      
      debugLog('[ENGINE] newSignatures length', newSignatures.length);
      
      if (signatures.length > 0) {
        _internal.lastSignature = signatures[0].signature;
        updateContext({ signature: signatures[0].signature });
      }
    });

    // Fetch transactions concurrently
    const intervalEvents = [];
    const intervalTransactions = [];
    
    if (newSignatures.length > 0) {
      await runStage('fetchTransactions', { mint, signature_count: newSignatures.length }, async () => {
        const txStart = Date.now();
        debugLog('[ENGINE] fetching transactions', newSignatures.length);
        const txResults = await fetchTransactionsConcurrently(connection, newSignatures, 10);
        debugLog('[ENGINE] txResults length', txResults.length);
        perf.transactions_fetch_ms = Date.now() - txStart;
        
        // Parse transactions
        await runStage('parse', { mint, transaction_count: txResults.length }, async () => {
          const parseStart = Date.now();
          
          for (const result of txResults) {
            if (!result.transaction || !result.transaction.meta) {
              continue;
            }
            
            intervalTransactions.push(result.transaction);
            
            // CRITICAL: Check transaction structure before parsing
            if (!result.transaction.transaction) {
              debugLog('[ENGINE] ERROR: Transaction missing .transaction property. Has meta:', !!result.transaction.meta, 'Keys:', Object.keys(result.transaction).join(', '));
              continue;
            }
            
            // ALWAYS call parseTransferEvents - it handles all the logic internally
            const events = parseTransferEvents(result.transaction, mint, 'spl-token') || [];
            
            // Add events if found
            if (events.length > 0) {
              debugLog('[ENGINE] Found', events.length, 'events, adding to intervalEvents (total:', intervalEvents.length, ')');
              for (const event of events) {
                event.signature = result.signature;
                intervalEvents.push(event);
              }
            }
            
            // If no events but transaction has token balances, log diagnostic
            if (events.length === 0) {
              const preBalances = result.transaction.meta.preTokenBalances || [];
              const postBalances = result.transaction.meta.postTokenBalances || [];
              if (preBalances.length > 0 || postBalances.length > 0) {
                const allMints = new Set();
                preBalances.forEach(b => { if (b.mint) allMints.add(b.mint.toLowerCase()); });
                postBalances.forEach(b => { if (b.mint) allMints.add(b.mint.toLowerCase()); });
                const hasOurMint = allMints.has(mint.toLowerCase());
                if (hasOurMint) {
                  debugLog('[ENGINE] DIAGNOSTIC: Tx has mint', mint.substring(0, 8), 'but 0 events. Pre:', preBalances.length, 'Post:', postBalances.length);
                }
              }
            }
            
            // Check for large transfers/mints (regardless of whether we found events)
            if (result.transaction && result.transaction.meta) {
              const parsed = parseTransaction(result.transaction, mint, 'spl-token');
              if (parsed.mintEvent && parsed.mintAmount >= config.mintThreshold) {
                // Refresh cache on mint event
                _internal.mintMetadataCacheAge = 10;
                alerts.push({
                  timestamp: formatTime(),
                  type: 'mint_event',
                  amount: parsed.mintAmount,
                  signature: result.signature,
                  explanation: `Mint event: ${parsed.mintAmount.toLocaleString()}`
                });
              }
              // Check for burn events (transfer to null/zero address)
              if (parsed.transfer) {
                if (parsed.transferAmount >= config.transferThreshold) {
                  alerts.push({
                    timestamp: formatTime(),
                    type: 'large_transfer',
                    amount: parsed.transferAmount,
                    signature: result.signature,
                    explanation: `Large transfer: ${parsed.transferAmount.toLocaleString()}`
                  });
                }
              }
            }
            
            // Mark as processed
            _internal.processedSignatures.add(result.signature);
          }
          
          perf.parse_ms = Date.now() - parseStart;
        });
      });
    }

    // Record mode: save raw data per interval
    if (config.record && _internal.recordDir) {
      const recordFile = path.join(_internal.recordDir, `interval-${(_internal.checkCount || 0) + 1}-${Date.now()}.json`);
      fs.writeFileSync(recordFile, JSON.stringify({
        timestamp: formatTime(),
        checkCount: (_internal.checkCount || 0) + 1,
        signatures: newSignatures,
        transactions: intervalTransactions.map(tx => ({
          signature: tx.transaction?.signatures?.[0] || 'unknown',
          transaction: tx
        })),
        events: intervalEvents,
        supply: mintInfo?.supply || mintInfo?.supplyRaw || null
      }, null, 2));
    }

    // Compute metrics and analytics (timing includes all analytics processing)
    debugLog('[ENGINE] About to compute metrics. intervalEvents.length:', intervalEvents.length);
    if (intervalEvents.length > 0) {
      const transferEvents = intervalEvents.filter(e => e && e.type === 'transfer');
      debugLog('[ENGINE] Transfer events in intervalEvents:', transferEvents.length, 'out of', intervalEvents.length);
      if (transferEvents.length > 0) {
        debugLog('[ENGINE] First transfer event:', { type: transferEvents[0].type, amount: transferEvents[0].amount, source: transferEvents[0].source?.substring(0, 8) });
      }
    }
    // Get topTokenAccounts from _internal (set during initialization)
    const topTokenAccounts = _internal.topTokenAccounts || [];
    
    // Compute analytics and roles
    let currentMetrics;
    let roles = [];
    
    const analyticsResult = await runStage('analytics', { 
      mint, 
      event_count: intervalEvents.length,
      interval_number: (_internal.checkCount || 0) + 1
    }, async () => {
      const analyticsStart = Date.now();
      const metrics = computeIntervalMetrics(intervalEvents);
      debugLog('[ENGINE] Metrics computed:', { transfers: metrics.transfers_per_interval, volume: metrics.total_volume, wallets: metrics.unique_wallets_per_interval });
      
    // Compute wallet stats and roles
    const walletStats = computeWalletStats(intervalEvents);
    const currentRoles = classifyWalletRoles(walletStats, topTokenAccounts);
      
      // Build roles summary
      const rolesArray = [];
      for (const [address, role] of currentRoles.entries()) {
        const stats = walletStats.get(address);
        if (stats) {
          rolesArray.push({
            wallet: address,
            role: role,
            volume: stats.total_volume,
            net_flow: stats.net_flow,
            counterparties: stats.unique_counterparties
          });
        }
      }
      rolesArray.sort((a, b) => b.volume - a.volume);

      // Detect behavioral drift (will use baseline from state)
      // Note: drift detection needs baseline, which comes from state
      // We'll add drift alerts in updateStateFromInterval if needed
      
      // Detect role changes (needs previous roles from state)
      // Will be handled in updateStateFromInterval
      
    // Detect dormant activation
    const dormantThreshold = config.strict ? config.transferThreshold * 0.5 : config.transferThreshold;
    const activeWalletsArray = _internal.activeWallets || [];
    const activeWalletsSet = new Set(Array.isArray(activeWalletsArray) ? activeWalletsArray : []);
    const dormantAlerts = detectDormantActivation(intervalEvents, activeWalletsSet, dormantThreshold);
      for (const alert of dormantAlerts) {
        alerts.push({
          timestamp: formatTime(),
          type: 'dormant_activation',
          wallet: alert.wallet,
          amount: alert.amount,
          explanation: `Dormant wallet ${alert.wallet} activated with ${alert.amount.toFixed(2)}`
        });
      }

      // Detect structural alerts (needs baseline from state)
      // Will be handled in updateStateFromInterval

      perf.analytics_ms = Date.now() - analyticsStart;
      
      return { metrics, roles: rolesArray };
    });
    
    currentMetrics = analyticsResult.metrics;
    roles = analyticsResult.roles;
    
    // OBSERVABILITY: Persistent diagnostic information
    const diagnostics = {
      tokenStandard: tokenProgram,
      tokenAccountsDiscovered: topTokenAccounts.length,
      transfersDiscovered: intervalEvents.length
    };
    debugLog('[ENGINE] DIAGNOSTICS:', 
      `standard=${diagnostics.tokenStandard}`,
      `accounts=${diagnostics.tokenAccountsDiscovered}`,
      `transfers=${diagnostics.transfersDiscovered}`
    );
    
    // Build token info
    const tokenInfo = {
      name: mintInfo.name || null,
      decimals: mintInfo.decimals || null,
      program: tokenProgram, // Include program in token info
      supply: {
        display: formatSupply(mintInfo),
        raw: mintInfo.supplyRaw || mintInfo.supply,
        decimals: mintInfo.decimals
      },
      authorities: {
        mint_authority: mintInfo.mintAuthority ? mintInfo.mintAuthority.toString() : null,
        freeze_authority: mintInfo.freezeAuthority ? mintInfo.freezeAuthority.toString() : null
      },
      topTokenAccounts: topTokenAccounts, // Will be updated from state
      diagnostics: diagnostics // Include diagnostics in token info
    };

    // Integrity check: placeholder isFine (will be enhanced with actual integrity checks)
    // For now, isFine = true if we got valid data
    const isFine = mintInfo !== null && intervalEvents.length >= 0;

    perf.total_ms = Date.now() - totalStart;

    // Update check count
    _internal.checkCount = (_internal.checkCount || 0) + 1;

    debugLog('[ENGINE] interval complete',
      'events=', intervalEvents.length,
      'transfers=', currentMetrics.transfers_per_interval,
      'volume=', currentMetrics.total_volume,
      'wallets=', currentMetrics.unique_wallets_per_interval
    );

    return {
      success: true,
      timestamp: formatTime(),
      checkCount: _internal.checkCount,
      metrics: currentMetrics,
      events: intervalEvents,
      alerts: alerts,
      tokenInfo: tokenInfo,
      roles: { roles: roles },
      isFine: isFine,
      performance: perf
    };

  } catch (e) {
    const errorMsg = e.message || String(e);
    const isNetworkError = errorMsg.includes('fetch failed') || 
                          errorMsg.includes('ECONNREFUSED') ||
                          errorMsg.includes('ETIMEDOUT') ||
                          errorMsg.includes('ENOTFOUND') ||
                          errorMsg.includes('network') ||
                          errorMsg.includes('timeout') ||
                          errorMsg.includes('failed to get info');
    
    perf.total_ms = Date.now() - totalStart;

    return {
      success: false,
      error: errorMsg,
      isNetworkError,
      timestamp: formatTime(),
      checkCount: _internal.checkCount || 0,
      performance: perf
    };
  }
}


module.exports = {
  runInterval, // Headless engine: runInterval(ctx) -> IntervalResult
  formatTime
};

// Headless watch engine - produces IntervalResult, does not update state
// State updates happen via updateStateFromInterval in watch-state.js

const { PublicKey } = require('@solana/web3.js');
const { getRpcUrl, createConnection, validateMint, rpcRetry, sleep } = require('./rpc');
const { fetchMintInfo } = require('./mint');
const {
  computeIntervalMetrics,
  detectDrift,
  detectRoleChanges,
  detectDormantActivation,
  detectStructuralAlerts,
  computeWalletStats,
  classifyWalletRoles
} = require('./watch-analytics');
const txCommand = require('../commands/tx');
const parseTransferEvents = txCommand.parseTransferEvents;
const { createInitialState, updateState, updateStateFromInterval } = require('./watch-state');
const { runStage, addBreadcrumb, updateContext, initContext } = require('../logging/logger');
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

function parseTransaction(tx, mintAddress) {
  const result = { mintEvent: false, transfer: false, mintAmount: 0, transferAmount: 0 };
  if (!tx.transaction || !tx.transaction.message) return result;
  
  const instructions = tx.transaction.message.instructions || [];
  for (const ix of instructions) {
    if (ix.program === 'spl-token' || ix.programId === 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA') {
      if (ix.parsed && ix.parsed.type === 'mintTo' && ix.parsed.info.mint === mintAddress) {
        result.mintEvent = true;
        result.mintAmount = parseFloat(ix.parsed.info.tokenAmount?.uiAmount || 0);
      }
      if (ix.parsed && ix.parsed.type === 'transfer') {
        result.transfer = true;
        result.transferAmount = parseFloat(ix.parsed.info.tokenAmount?.uiAmount || 0);
      }
    }
  }
  return result;
}

// Concurrency control for transaction fetching with Promise batching
// Preserves transaction ordering while using bounded concurrency
async function fetchTransactionsConcurrently(connection, signatures, maxConcurrency = 10) {
  const results = new Array(signatures.length);
  
  // Process in batches to preserve ordering
  for (let i = 0; i < signatures.length; i += maxConcurrency) {
    const batch = signatures.slice(i, i + maxConcurrency);
    const batchPromises = batch.map((sig, batchIndex) => 
      connection.getTransaction(sig, {
        commitment: 'confirmed',
        maxSupportedTransactionVersion: 0
      }).then(tx => ({
        signature: sig,
        transaction: tx
      })).catch(e => ({
        signature: sig,
        transaction: null,
        error: e.message
      }))
    );
    
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

    // Fetch signatures (with caching)
    let signatures = [];
    let newSignatures = [];
    
    await runStage('fetchSignatures', { mint, rpc: config.rpcUrl }, async () => {
      const sigStart = Date.now();
      const result = await rpcRetry(() => 
        connection.getSignaturesForAddress(new PublicKey(mint), { limit: 20 })
      );
      perf.signatures_fetch_ms = Date.now() - sigStart;
      
      signatures = result || [];
      
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
        const txResults = await fetchTransactionsConcurrently(connection, newSignatures, 10);
        perf.transactions_fetch_ms = Date.now() - txStart;
        
        // Parse transactions
        await runStage('parse', { mint, transaction_count: txResults.length }, async () => {
          const parseStart = Date.now();
          
          for (const result of txResults) {
            if (result.transaction && result.transaction.meta) {
              intervalTransactions.push(result.transaction);
              
              // Parse transfer events
              const events = parseTransferEvents(result.transaction, mint) || [];
              
              for (const event of events) {
                event.signature = result.signature;
                intervalEvents.push(event);
              }
              
              // Check for large transfers/mints
              const parsed = parseTransaction(result.transaction, mint);
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
    const currentMetrics = await runStage('analytics', { 
      mint, 
      event_count: intervalEvents.length,
      interval_number: (_internal.checkCount || 0) + 1
    }, async () => {
      const analyticsStart = Date.now();
      const metrics = computeIntervalMetrics(intervalEvents);
      
    // Compute wallet stats and roles
    const walletStats = computeWalletStats(intervalEvents);
    // topTokenAccounts should come from state, but we'll get it from _internal for now
    // (it's set during initialization)
    const topTokenAccounts = _internal.topTokenAccounts || [];
    const currentRoles = classifyWalletRoles(walletStats, topTokenAccounts);
      
      // Build roles summary
      const roles = [];
      for (const [address, role] of currentRoles.entries()) {
        const stats = walletStats.get(address);
        if (stats) {
          roles.push({
            wallet: address,
            role: role,
            volume: stats.total_volume,
            net_flow: stats.net_flow,
            counterparties: stats.unique_counterparties
          });
        }
      }
      roles.sort((a, b) => b.volume - a.volume);

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
      
      return metrics;
    });
    
    // Build token info
    const tokenInfo = {
      name: mintInfo.name || null,
      decimals: mintInfo.decimals || null,
      supply: {
        display: formatSupply(mintInfo),
        raw: mintInfo.supplyRaw || mintInfo.supply,
        decimals: mintInfo.decimals
      },
      authorities: {
        mint_authority: mintInfo.mintAuthority ? mintInfo.mintAuthority.toString() : null,
        freeze_authority: mintInfo.freezeAuthority ? mintInfo.freezeAuthority.toString() : null
      },
      topTokenAccounts: topTokenAccounts // Will be updated from state
    };

    // Integrity check: placeholder isFine (will be enhanced with actual integrity checks)
    // For now, isFine = true if we got valid data
    const isFine = mintInfo !== null && intervalEvents.length >= 0;

    perf.total_ms = Date.now() - totalStart;

    // Update check count
    _internal.checkCount = (_internal.checkCount || 0) + 1;

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

/**
 * Create watch session with state management
 * Wraps headless engine with state management
 */
async function createWatchSession(mint, options, callbacks = {}) {
  if (!validateMint(mint)) {
    throw new Error('Invalid mint address');
  }

  const rpcUrl = getRpcUrl(options);
  const connection = createConnection(rpcUrl);
  
  // Initialize error context (if not already initialized)
  try {
    initContext('watch', [mint], options);
  } catch (e) {
    // Context may already be initialized, continue
  }
  
  // Initialize state
  let state = createInitialState(mint, options);
  state = updateState(state, {
    config: { ...state.config, rpcUrl }
  });

  // Replay mode: load recorded data (file or directory)
  if (options.replay) {
    try {
      let replayData = null;
      const replayPath = options.replay;
      const stats = fs.statSync(replayPath);
      
      if (stats.isDirectory()) {
        // Load all interval files from directory, sorted by checkCount
        const files = fs.readdirSync(replayPath)
          .filter(f => f.startsWith('interval-') && f.endsWith('.json'))
          .sort((a, b) => {
            const aNum = parseInt(a.match(/interval-(\d+)-/)?.[1] || '0');
            const bNum = parseInt(b.match(/interval-(\d+)-/)?.[1] || '0');
            return aNum - bNum;
          });
        
        const intervals = [];
        for (const file of files) {
          const content = JSON.parse(fs.readFileSync(path.join(replayPath, file), 'utf8'));
          intervals.push({
            timestamp: content.timestamp,
            signatures: content.signatures || [],
            transactions: content.transactions || [],
            events: content.events || [],
            supply: content.supply || null
          });
        }
        
        replayData = { intervals };
      } else {
        // Single file - could be a recording manifest or single interval
        const content = JSON.parse(fs.readFileSync(replayPath, 'utf8'));
        if (content.intervals && Array.isArray(content.intervals)) {
          // Manifest file with multiple intervals
          replayData = content;
        } else {
          // Single interval file
          replayData = {
            intervals: [{
              timestamp: content.timestamp,
              signatures: content.signatures || [],
              transactions: content.transactions || [],
              events: content.events || [],
              supply: content.supply || null
            }]
          };
        }
      }
      
      state._internal.replayData = replayData;
      state._internal.replayIndex = 0;
      state._internal.replayMode = true;
    } catch (e) {
      throw new Error(`Failed to load replay data: ${e.message}`);
    }
  }
  
  // Record mode: initialize recording directory
  if (options.record) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const recordDir = path.join(process.cwd(), 'tokenctl-runs', 'raw', timestamp);
    if (!fs.existsSync(recordDir)) {
      fs.mkdirSync(recordDir, { recursive: true });
    }
    state._internal.recordDir = recordDir;
  }

  // Fetch initial token info (skip in replay mode - no RPC calls)
  if (!state._internal.replayMode) {
    try {
      const mintInfo = await rpcRetry(() => fetchMintInfo(connection, mint));
      if (mintInfo) {
        state._internal.mintMetadataCache = mintInfo;
        state._internal.mintMetadataCacheAge = 0;
        
        state = updateState(state, {
          token: {
            name: mintInfo.name || state.token.name,
            decimals: mintInfo.decimals || state.token.decimals,
            supply: {
              display: formatSupply(mintInfo),
              raw: mintInfo.supplyRaw || mintInfo.supply,
              decimals: mintInfo.decimals
            },
            authorities: {
              mint_authority: mintInfo.mintAuthority ? mintInfo.mintAuthority.toString() : null,
              freeze_authority: mintInfo.freezeAuthority ? mintInfo.freezeAuthority.toString() : null
            }
          }
        });
        state._internal.lastSupply = mintInfo.supply || mintInfo.supplyRaw;
      }
    } catch (e) {
      // Continue without name if fetch fails
    }

    // Fetch top token accounts (skip in replay mode)
    try {
      const mintPubkey = new PublicKey(mint);
      const result = await rpcRetry(() => connection.getTokenLargestAccounts(mintPubkey));
      if (result && result.value) {
        const topAccounts = result.value.map(acc => ({
          address: acc.address.toString(),
          amount: Number(acc.amount)
        }));
        state = updateState(state, {
          token: { topTokenAccounts: topAccounts }
        });
        // Store in _internal for headless engine context
        state._internal.topTokenAccounts = topAccounts;
      }
    } catch (e) {
      // Continue without top accounts
    }
  } else {
    // In replay mode, initialize lastSupply from first interval if available
    if (state._internal.replayData && state._internal.replayData.intervals.length > 0) {
      const firstInterval = state._internal.replayData.intervals[0];
      if (firstInterval.supply !== undefined && firstInterval.supply !== null) {
        state._internal.lastSupply = firstInterval.supply;
      }
    }
  }

  // Call onStart callback
  if (callbacks.onStart) {
    callbacks.onStart({
      mint,
      tokenName: state.token.name,
      interval: state.config.interval,
      strict: state.config.strict,
      rpcUrl: state.config.rpcUrl,
      state: state
    });
  }

  /**
   * Run a single watch interval - returns updated state
   * This wraps the headless engine with state management
   */
  async function runIntervalWithState() {
    // Create context for headless engine
    const ctx = {
      mint,
      connection,
      config: state.config,
      _internal: state._internal
    };

    // Run headless engine
    const intervalResult = await runInterval(ctx);

    // Update state from interval result
    if (intervalResult.success) {
      state = updateStateFromInterval(state, intervalResult);
      
      // Update internal state from context (for tracking)
      state._internal = {
        ...state._internal,
        ...ctx._internal
      };
      
      // Call callback with updated state
      if (callbacks.onInterval) {
        callbacks.onInterval(state);
      }
      
      return { success: true, state };
    } else {
      // On error, still update performance metrics
      state = updateState(state, {
        performance: intervalResult.performance || state.performance
      });
      
      if (callbacks.onError) {
        callbacks.onError({
          error: intervalResult.error,
          isNetworkError: intervalResult.isNetworkError
        });
      }
      
      return { success: false, error: intervalResult.error, state };
    }
  }

  // Create session object
  const session = {
    runInterval: runIntervalWithState,
    getState: () => state
  };

  return session;
}

module.exports = {
  createWatchSession,
  runInterval, // Export headless engine for testing
  formatTime
};

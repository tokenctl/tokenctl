// Watch session wrapper - combines headless engine with state management

const { PublicKey } = require('@solana/web3.js');
const { 
  getRpcUrl, 
  createConnection, 
  validateMint, 
  rpcRetry, 
  detectHeliusRpc, 
  checkRpcHealth,
  determineRpcMode,
  getFallbackRpcUrl,
  RPC_MODES
} = require('../utils/rpc');
const { fetchMintInfo, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } = require('../utils/mint');
const { runInterval, formatTime } = require('./engine');
const { createInitialState, updateState, updateStateFromInterval } = require('../state/state');
const { initContext, logInfo } = require('../logging/logger');
const fs = require('fs');
const path = require('path');

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

/**
 * Create watch session with state management
 * Wraps headless engine with state management
 */
async function createWatchSession(mint, options, callbacks = {}) {
  if (!validateMint(mint)) {
    throw new Error('Invalid mint address');
  }

  let rpcUrl = getRpcUrl(options);
  let connection = createConnection(rpcUrl);
  
  // Determine RPC mode
  const rpcMode = determineRpcMode(rpcUrl, options.rpcMode);
  
  // Initialize error context (if not already initialized)
  try {
    initContext('watch', [mint], options);
  } catch (e) {
    // Context may already be initialized, continue
  }
  
  // Perform mandatory RPC health check (skip in replay mode)
  if (!options.replay) {
    let healthCheckPassed = false;
    let useFallback = false;
    
    try {
      const healthResult = await checkRpcHealth(connection, rpcUrl, mint);
      logInfo(`RPC health check passed: block height ${healthResult.blockHeight}`);
      logInfo(`Token accounts supported: ${healthResult.tokenAccountsSupported ? 'yes' : 'no'}`);
      healthCheckPassed = true;
      
      // Log RPC mode
      const heliusInfo = detectHeliusRpc(rpcUrl);
      if (rpcMode === RPC_MODES.HELIUS_RAW || rpcMode === RPC_MODES.HELIUS_ENHANCED) {
        const modeDisplay = rpcMode === RPC_MODES.HELIUS_ENHANCED ? 'Helius Enhanced' : 'Helius Raw';
        logInfo(`RPC Mode: ${modeDisplay} (${rpcUrl})`);
      } else if (rpcMode === RPC_MODES.PUBLIC) {
        logInfo(`RPC Mode: Public (${rpcUrl})`);
      } else {
        logInfo(`RPC Mode: ${rpcMode} (${rpcUrl})`);
      }
    } catch (e) {
      // Check if this is an auth error
      if (e.isAuthError && (e.statusCode === 401 || e.statusCode === 403)) {
        // Hard fail on auth errors - do not proceed
        const errorMsg = e.message || String(e);
        console.error('\n═══════════════════════════════════════════════════════');
        console.error('RPC AUTHORIZATION FAILED');
        console.error('═══════════════════════════════════════════════════════\n');
        console.error(errorMsg);
        console.error('\n═══════════════════════════════════════════════════════\n');
        console.error('This error prevents tokenctl from discovering token transfers.');
        console.error('Please check your RPC API key or use --rpc-fallback to switch to public RPC.\n');
        throw e;
      }
      
      // For non-auth errors, try fallback if enabled
      if (options.rpcFallback) {
        const fallbackUrl = getFallbackRpcUrl(rpcUrl);
        console.error(`[RPC] Primary RPC failed, attempting fallback: ${fallbackUrl}`);
        rpcUrl = fallbackUrl;
        connection = createConnection(rpcUrl);
        
        try {
          const healthResult = await checkRpcHealth(connection, rpcUrl, mint);
          logInfo(`RPC fallback health check passed: block height ${healthResult.blockHeight}`);
          logInfo(`RPC Mode: Public (fallback) - ${rpcUrl}`);
          healthCheckPassed = true;
          useFallback = true;
        } catch (fallbackError) {
          // Fallback also failed
          const errorMsg = fallbackError.message || String(fallbackError);
          console.error('\n═══════════════════════════════════════════════════════');
          console.error('RPC CONNECTION FAILED (including fallback)');
          console.error('═══════════════════════════════════════════════════════\n');
          console.error(`Primary: ${getRpcUrl(options)}\n${e.message}`);
          console.error(`\nFallback: ${fallbackUrl}\n${errorMsg}`);
          console.error('\n═══════════════════════════════════════════════════════\n');
          throw fallbackError;
        }
      } else {
        // No fallback enabled - abort
        const errorMsg = e.message || String(e);
        console.error('\n═══════════════════════════════════════════════════════');
        console.error('RPC CONNECTION FAILED');
        console.error('═══════════════════════════════════════════════════════\n');
        console.error(errorMsg);
        console.error('\n═══════════════════════════════════════════════════════\n');
        console.error('Use --rpc-fallback to automatically switch to public RPC on failure.\n');
        throw e;
      }
    }
    
    if (!healthCheckPassed) {
      throw new Error('RPC health check failed');
    }
  }
  
  // Detect token program for logging and state tracking
  // Now supports both SPL Token and Token-2022
  if (!options.replay) {
    let tokenProgram = 'unknown';
    try {
      const mintPubkey = new PublicKey(mint);
      const accountInfo = await rpcRetry(() => connection.getAccountInfo(mintPubkey));
      if (accountInfo && accountInfo.owner) {
        const ownerStr = accountInfo.owner.toString();
        if (ownerStr === TOKEN_PROGRAM_ID.toString()) {
          tokenProgram = 'spl-token';
          logInfo(`[TOKEN_STANDARD] Detected SPL Token program (Tokenkeg) for mint ${mint}`);
        } else if (ownerStr === TOKEN_2022_PROGRAM_ID.toString()) {
          tokenProgram = 'token-2022';
          logInfo(`[TOKEN_STANDARD] Detected Token-2022 program (Tokenz) for mint ${mint}`);
        } else {
          tokenProgram = 'unknown';
          logInfo(`[TOKEN_STANDARD] Unknown token program owner ${ownerStr} for mint ${mint}`);
        }
      } else {
        throw new Error(`Failed to get account info for mint ${mint}`);
      }
    } catch (e) {
      throw new Error(`Failed to detect token program: ${e.message}`);
    }
    
    // Only reject truly unknown programs
    if (tokenProgram === 'unknown') {
      const errorMsg = `Unknown token program detected. Only SPL Token (Tokenkeg) and Token-2022 (Tokenz) are supported.`;
      
      console.error('\n═══════════════════════════════════════════════════════');
      console.error('UNSUPPORTED TOKEN STANDARD');
      console.error('═══════════════════════════════════════════════════════\n');
      console.error(`Mint: ${mint}`);
      console.error(`Token Program: ${tokenProgram}`);
      console.error(`Error: ${errorMsg}\n`);
      console.error('═══════════════════════════════════════════════════════\n');
      
      throw new Error(errorMsg);
    }
  }
  
  // Initialize state (only reached if token is supported or in replay mode)
  let state = createInitialState(mint, options);
  state = updateState(state, {
    config: { 
      ...state.config, 
      rpcUrl,
      rpcMode: rpcMode
    }
  });

  // Defensive check: ensure processedSignatures is always a Set
  if (!(state._internal.processedSignatures instanceof Set)) {
    throw new Error('processedSignatures must be a Set. Got: ' + typeof state._internal.processedSignatures + '. This indicates a bug in state initialization.');
  }

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
        
        // Detect token program by checking mint account owner
        // Note: Token program support was already validated earlier (before state initialization)
        // This detection is only to populate state with the program identifier
        let tokenProgram = 'spl-token'; // Default to spl-token (already validated as supported)
        try {
          const mintPubkey = new PublicKey(mint);
          const accountInfo = await rpcRetry(() => connection.getAccountInfo(mintPubkey));
          if (accountInfo && accountInfo.owner) {
            const ownerStr = accountInfo.owner.toString();
            if (ownerStr === TOKEN_PROGRAM_ID.toString()) {
              tokenProgram = 'spl-token';
            } else if (ownerStr === TOKEN_2022_PROGRAM_ID.toString()) {
              tokenProgram = 'token-2022';
            } else {
              tokenProgram = 'unknown';
            }
          }
        } catch (e) {
          // If detection fails here, default to spl-token (already validated earlier)
          logInfo(`[TOKEN_STANDARD] Failed to detect token program during state update: ${e.message}`);
        }
        
        // Update state with token info (token is already validated as supported)
        state = updateState(state, {
          token: {
            name: mintInfo.name || state.token.name,
            decimals: mintInfo.decimals || state.token.decimals,
            program: tokenProgram,
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
    let tokenAccountCount = 0;
    let tokenAccountError = null;
    try {
      const mintPubkey = new PublicKey(mint);
      const result = await rpcRetry(() => connection.getTokenLargestAccounts(mintPubkey));
      if (result && result.value) {
        const topAccounts = result.value.map(acc => ({
          address: acc.address.toString(),
          amount: Number(acc.amount)
        }));
        tokenAccountCount = topAccounts.length;
        logInfo(`Token account discovery: found ${tokenAccountCount} token accounts`);
        
        if (tokenAccountCount === 0) {
          logInfo('WARNING: No token accounts found - token may be new or have no holders');
        }
        
        state = updateState(state, {
          token: { topTokenAccounts: topAccounts }
        });
        // Store in _internal for headless engine context
        state._internal.topTokenAccounts = topAccounts;
      } else {
        tokenAccountCount = 0;
        logInfo('WARNING: getTokenLargestAccounts returned no accounts');
      }
    } catch (e) {
      const errorMsg = e.message || String(e);
      const isAuthError = errorMsg.includes('401') || 
                          errorMsg.includes('403') ||
                          errorMsg.includes('Unauthorized') ||
                          errorMsg.includes('Forbidden') ||
                          errorMsg.includes('invalid api key');
      
      tokenAccountError = errorMsg;
      
      if (isAuthError) {
        // Authentication error - surface prominently
        const statusCode = errorMsg.match(/(\d{3})/)?.[1] || '401/403';
        logInfo(`ERROR: Token account discovery failed with ${statusCode} - Invalid API key`);
        // Store error in state for TUI display
        state._internal.rpcError = {
          type: 'auth_error',
          message: `RPC authentication failed (${statusCode}): Invalid API key`,
          details: errorMsg
        };
      } else {
        // Other error - log but continue
        logInfo(`WARNING: Token account discovery failed: ${errorMsg}`);
        state._internal.rpcError = {
          type: 'discovery_error',
          message: `Token account discovery failed: ${errorMsg}`,
          details: errorMsg
        };
      }
    }
    
    // Store token account count for TUI warnings
    state._internal.tokenAccountCount = tokenAccountCount;
  } else {
    // In replay mode, initialize lastSupply from first interval if available
    if (state._internal.replayData && state._internal.replayData.intervals.length > 0) {
      const firstInterval = state._internal.replayData.intervals[0];
      if (firstInterval.supply !== undefined && firstInterval.supply !== null) {
        state._internal.lastSupply = firstInterval.supply;
      }
    }
  }

  // Defensive check: ensure processedSignatures is always a Set before any interval runs
  if (!(state._internal.processedSignatures instanceof Set)) {
    throw new Error('processedSignatures must be a Set. Got: ' + typeof state._internal.processedSignatures + '. This indicates a bug in state initialization.');
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
      config: {
        ...state.config,
        tokenProgram: state.token.program // Pass token program to engine
      },
      _internal: state._internal
    };
    
    // Store token program in _internal for engine access
    ctx._internal.tokenProgram = state.token.program;

    // Run headless engine
    const intervalResult = await runInterval(ctx);

    // Update state from interval result
    if (intervalResult.success) {
      state = updateStateFromInterval(state, intervalResult);
      
      // Update internal state from context (for tracking)
      // Preserve Sets and Maps that may have been modified in context
      state._internal = {
        ...state._internal,
        ...ctx._internal,
        // Ensure processedSignatures remains a Set
        processedSignatures: ctx._internal.processedSignatures instanceof Set 
          ? ctx._internal.processedSignatures 
          : state._internal.processedSignatures instanceof Set
          ? state._internal.processedSignatures
          : new Set(),
        // Ensure activeWallets remains a Set
        activeWallets: ctx._internal.activeWallets instanceof Set
          ? ctx._internal.activeWallets
          : state._internal.activeWallets instanceof Set
          ? state._internal.activeWallets
          : Array.isArray(ctx._internal.activeWallets) || Array.isArray(state._internal.activeWallets)
          ? new Set(Array.isArray(ctx._internal.activeWallets) ? ctx._internal.activeWallets : state._internal.activeWallets)
          : new Set()
      };
      
      // Defensive check: ensure processedSignatures is still a Set
      if (!(state._internal.processedSignatures instanceof Set)) {
        throw new Error('processedSignatures must be a Set after state update. Got: ' + typeof state._internal.processedSignatures);
      }
      
      // Call callback with updated state
      if (callbacks.onInterval) {
        console.error('[SESSION] onInterval fired',
          'checkCount=', state.currentInterval?.checkCount,
          'events=', state.currentInterval?.transfers
        );
        callbacks.onInterval(state);
      }
      
      return { success: true, state };
    } else {
      // Always run state updater even on failure so last_refresh_ms advances
      state = updateStateFromInterval(state, intervalResult);

      if (callbacks.onInterval) callbacks.onInterval(state);

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
  formatTime
};

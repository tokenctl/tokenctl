const blessed = require('blessed');
const contrib = require('blessed-contrib');
const fs = require('fs');
const path = require('path');
// Use new state-based watch core
const { createWatchSession, formatTime } = require('../watch/session');
const { initContext, setTUIState, runStage, showTUIErrorOverlay, handleFatalError, addBreadcrumb, debugLog, initDebugLog } = require('../logging/logger');

const MIN_WIDTH = 120;
const MIN_HEIGHT = 30;

function createDashboard(mint, options) {
  const screen = blessed.screen({
    smartCSR: true,
    fullUnicode: true,
    title: `tokenctl live - ${mint.substring(0, 8)}...`
  });

  // Check terminal size
  const width = screen.width;
  const height = screen.height;
  
  if (width < MIN_WIDTH || height < MIN_HEIGHT) {
    const warningBox = blessed.box({
      top: 'center',
      left: 'center',
      width: 60,
      height: 10,
      content: `Terminal too small!\n\nRequired: ${MIN_WIDTH}x${MIN_HEIGHT}\nCurrent: ${width}x${height}\n\nPress 'q' to exit.`,
      tags: true,
      border: {
        type: 'line'
      },
      style: {
        fg: 'white',
        bg: 'red',
        border: {
          fg: 'white'
        }
      }
    });
    screen.append(warningBox);
    screen.key(['q', 'escape', 'C-c'], () => {
      screen.destroy();
      process.exit(0);
    });
    screen.render();
    return { screen, dashboard: null };
  }

  const grid = new contrib.grid({
    rows: 12,
    cols: 12,
    screen: screen
  });

  // Top bar
  const topBar = grid.set(0, 0, 1, 12, blessed.box, {
    content: '',
    tags: true,
    style: {
      fg: 'white',
      bg: 'blue'
    }
  });

  // Row 1: Two charts
  const transfersChart = grid.set(1, 0, 3, 6, contrib.line, {
    label: 'Transfers per Interval',
    showLegend: false,
    wholeNumbersOnly: true,
    style: {
      line: 'yellow',
      text: 'green',
      baseline: 'black',
      border: {
        fg: 'cyan'
      }
    }
  });

  const walletsChart = grid.set(1, 6, 3, 6, contrib.line, {
    label: 'Unique Wallets per Interval',
    showLegend: false,
    wholeNumbersOnly: true,
    style: {
      line: 'green',
      text: 'green',
      baseline: 'black',
      border: {
        fg: 'cyan'
      }
    }
  });

  // Row 2: Two charts
  const avgSizeChart = grid.set(4, 0, 3, 6, contrib.line, {
    label: 'Avg Transfer Size',
    showLegend: false,
    style: {
      line: 'magenta',
      text: 'green',
      baseline: 'black',
      border: {
        fg: 'cyan'
      }
    }
  });

  const dominantShareChart = grid.set(4, 6, 3, 6, contrib.line, {
    label: 'Dominant Wallet Share',
    showLegend: false,
    style: {
      line: 'red',
      text: 'green',
      baseline: 'black',
      border: {
        fg: 'cyan'
      }
    }
  });

  // Row 3: Alerts table
  const alertsTable = grid.set(7, 0, 3, 12, contrib.table, {
    label: 'Recent Alerts',
    columnSpacing: 2,
    columnWidth: [20, 25, 50, 10]
  });

  // Bottom left: Current interval summary
  const summaryBox = grid.set(10, 0, 2, 6, blessed.box, {
    label: 'Current Interval',
    tags: true,
    content: '',
    border: {
      type: 'line'
    },
    style: {
      fg: 'white',
      border: {
        fg: 'cyan'
      }
    },
    scrollable: true,
    alwaysScroll: true
  });

  // Bottom right: Roles summary
  const rolesBox = grid.set(10, 6, 2, 6, blessed.box, {
    label: 'Wallet Roles',
    tags: true,
    content: '',
    border: {
      type: 'line'
    },
    style: {
      fg: 'white',
      border: {
        fg: 'cyan'
      }
    },
    scrollable: true,
    alwaysScroll: true
  });

  // Footer
  const footer = grid.set(12, 0, 1, 12, blessed.box, {
    content: '',
    tags: true,
    style: {
      fg: 'white',
      bg: 'blue'
    }
  });

  const dashboard = {
    screen,
    topBar,
    transfersChart,
    walletsChart,
    avgSizeChart,
    dominantShareChart,
    alertsTable,
    summaryBox,
    rolesBox,
    footer
  };

  return { screen, dashboard };
}

function updateTopBar(dashboard, watchState) {
  // Read from centralized state object
  const tokenName = watchState.token?.name || watchState.config?.mint?.substring(0, 16) + '...' || 'Unknown';
  const baselineStatus = watchState.baseline?.status || 'forming';
  const rpcHost = watchState.config?.rpcUrl ? new URL(watchState.config.rpcUrl).hostname : 'default';
  const interval = watchState.config?.interval || 30;
  const mint = watchState.config?.mint || 'unknown';
  const tokenProgram = watchState.token?.program || 'spl-token';
  const programDisplay = tokenProgram === 'token-2022' ? 'Token-2022' : 'SPL';
  
  const content = `Token: ${tokenName} | Mint: ${mint.substring(0, 8)}... | Program: ${programDisplay} | Interval: ${interval}s | Baseline: ${baselineStatus} | RPC: ${rpcHost}`;
  dashboard.topBar.setContent(content);
}

function updateCharts(dashboard, watchState) {
  // Read from centralized state object
  if (!dashboard) return;
  
  const series = watchState.series || { transfers: [], wallets: [], avgSize: [], dominantShare: [] };
  const currentInterval = watchState.currentInterval || {};
  
  
  // Ensure all series arrays exist and are arrays
  if (!Array.isArray(series.transfers)) series.transfers = [];
  if (!Array.isArray(series.wallets)) series.wallets = [];
  if (!Array.isArray(series.avgSize)) series.avgSize = [];
  if (!Array.isArray(series.dominantShare)) series.dominantShare = [];
  
  // FALLBACK: If series is empty but currentInterval has data, use currentInterval for display
  // This ensures charts show data even if series hasn't been populated yet
  const useCurrentInterval = series.transfers.length === 0 && currentInterval.transfers > 0;
  
  // Transfers per interval - use rolling window scaling
  // Blessed-contrib line charts need at least 2 points to render properly
  let transfersData;
  if (useCurrentInterval) {
    // Use currentInterval data as fallback
    transfersData = [currentInterval.transfers || 0, currentInterval.transfers || 0];
  } else {
    transfersData = series.transfers.length > 0 ? series.transfers : [0, 0];
    if (transfersData.length === 1) transfersData = [transfersData[0], transfersData[0]];
  }
  const transfersX = transfersData.map((_, i) => String(i));
  const transfersY = transfersData.map(v => Number(v) || 0);
  
  // Always update chart if data is valid
  if (Array.isArray(transfersX) && Array.isArray(transfersY) && transfersX.length > 0 && transfersY.length > 0) {
    try {
      if (dashboard.transfersChart && typeof dashboard.transfersChart.setData === 'function') {
        debugLog('[LIVE] Setting transfers chart data, x.length=', transfersX.length, 'y.length=', transfersY.length, 'y values:', transfersY.slice(0, 5));
        dashboard.transfersChart.setData([{
          title: 'Transfers',
          x: transfersX,
          y: transfersY,
          style: {
            line: 'yellow'
          }
        }]);
      } else {
        debugLog('[LIVE] transfersChart missing or setData not a function');
      }
    } catch (e) {
      // Log chart errors for debugging
      debugLog('[LIVE] Chart update error (transfers):', e.message, e.stack);
    }
  } else {
    debugLog('[LIVE] Transfers chart data invalid - x:', transfersX?.length, 'y:', transfersY?.length);
  }

  // Unique wallets per interval
  // Blessed-contrib line charts need at least 2 points to render properly
  let walletsData;
  if (useCurrentInterval) {
    walletsData = [currentInterval.uniqueWallets || 0, currentInterval.uniqueWallets || 0];
  } else {
    walletsData = series.wallets.length > 0 ? series.wallets : [0, 0];
    if (walletsData.length === 1) walletsData = [walletsData[0], walletsData[0]];
  }
  const walletsX = walletsData.map((_, i) => String(i));
  const walletsY = walletsData.map(v => Number(v) || 0);
  
  if (Array.isArray(walletsX) && Array.isArray(walletsY) && walletsX.length > 0 && walletsY.length > 0) {
    try {
      if (dashboard.walletsChart && typeof dashboard.walletsChart.setData === 'function') {
        dashboard.walletsChart.setData([{
          title: 'Wallets',
          x: walletsX,
          y: walletsY,
          style: {
            line: 'green'
          }
        }]);
      }
    } catch (e) {
      // Log chart errors for debugging
      debugLog('[LIVE] Chart update error (wallets):', e.message);
    }
  }

  // Avg transfer size
  // Blessed-contrib line charts need at least 2 points to render properly
  let avgSizeData;
  if (useCurrentInterval) {
    avgSizeData = [currentInterval.avgTransferSize || 0, currentInterval.avgTransferSize || 0];
  } else {
    avgSizeData = series.avgSize.length > 0 ? series.avgSize : [0, 0];
    if (avgSizeData.length === 1) avgSizeData = [avgSizeData[0], avgSizeData[0]];
  }
  const avgSizeX = avgSizeData.map((_, i) => String(i));
  const avgSizeY = avgSizeData.map(v => Number(v) || 0);
  
  if (Array.isArray(avgSizeX) && Array.isArray(avgSizeY) && avgSizeX.length > 0 && avgSizeY.length > 0) {
    try {
      if (dashboard.avgSizeChart && typeof dashboard.avgSizeChart.setData === 'function') {
        dashboard.avgSizeChart.setData([{
          title: 'Avg Size',
          x: avgSizeX,
          y: avgSizeY,
          style: {
            line: 'magenta'
          }
        }]);
      }
    } catch (e) {
      // Log chart errors for debugging
      debugLog('[LIVE] Chart update error (avgSize):', e.message);
    }
  }

  // Dominant wallet share - already normalized to [0, 100] in state
  // Blessed-contrib line charts need at least 2 points to render properly
  let dominantShareData;
  if (useCurrentInterval) {
    // Normalize to [0, 100] if needed
    const share = (currentInterval.dominantWalletShare || 0) * 100;
    dominantShareData = [share, share];
  } else {
    dominantShareData = series.dominantShare.length > 0 ? series.dominantShare : [0, 0];
    if (dominantShareData.length === 1) dominantShareData = [dominantShareData[0], dominantShareData[0]];
  }
  const dominantShareX = dominantShareData.map((_, i) => String(i));
  const dominantShareY = dominantShareData.map(v => Number(v) || 0);
  
  if (Array.isArray(dominantShareX) && Array.isArray(dominantShareY) && dominantShareX.length > 0 && dominantShareY.length > 0) {
    try {
      if (dashboard.dominantShareChart && typeof dashboard.dominantShareChart.setData === 'function') {
        dashboard.dominantShareChart.setData([{
          title: 'Dominant Share',
          x: dominantShareX,
          y: dominantShareY,
          style: {
            line: 'red'
          }
        }]);
      }
    } catch (e) {
      // Log chart errors for debugging
      debugLog('[LIVE] Chart update error (dominantShare):', e.message);
    }
  }
}

function updateAlertsTable(dashboard, watchState) {
  // Read from centralized state object
  if (!dashboard || !dashboard.alertsTable) return;
  
  const alerts = watchState.alerts || [];
  const recentAlerts = alerts.slice(-20).reverse(); // Most recent first, keep last 20
  const tableData = [];
  
  for (const alert of recentAlerts) {
    if (!alert || typeof alert !== 'object') continue;
    const time = alert.timestamp ? alert.timestamp.substring(11, 19) : 'N/A';
    const type = alert.type || 'unknown';
    const severity = alert.severity || 'info';
    const details = (alert.explanation || alert.drift_type || '').substring(0, 45);
    const confidence = alert.confidence !== undefined ? alert.confidence.toFixed(2) : '0.00';
    tableData.push([time, `${type} [${severity}]`, details, confidence]);
  }
  
  // Table expects {headers: [...], data: [...]} format
  try {
    dashboard.alertsTable.setData({
      headers: ['Time', 'Type', 'Details', 'Confidence'],
      data: tableData.length > 0 ? tableData : [['No alerts', '', '', '']]
    });
  } catch (e) {
    // Ignore table errors
  }
}

function updateSummaryBox(dashboard, watchState) {
  // Read from centralized state object
  if (!watchState || !watchState.currentInterval) {
    dashboard.summaryBox.setContent('Waiting for first interval...');
    return;
  }
  
  const interval = watchState.currentInterval;
  const supply = watchState.token?.supply || {};
  const authorities = watchState.token?.authorities || {};
  const perf = watchState.performance || {};
  
  let content = '';
  content += `Transfers: ${interval.transfers || 0}\n`;
  content += `Mint Events: ${interval.mints || 0}\n`;
  content += `Total Volume: ${(interval.totalVolume || 0).toLocaleString()}\n`;
  content += `Unique Wallets: ${interval.uniqueWallets || 0}\n`;
  content += `\nSupply: ${supply.display || 'unknown'}\n`;
  content += `Mint Auth: ${authorities.mint_authority ? 'EXISTS' : 'revoked'}\n`;
  content += `Freeze Auth: ${authorities.freeze_authority ? 'EXISTS' : 'revoked'}\n`;
  content += `\nLast Refresh: ${perf.total_ms || 0}ms\n`;
  if (interval.partial) {
    content += `{red-fg}Partial data{/red-fg}\n`;
  }
  if (!interval.integrity?.valid) {
    content += `{red-fg}Integrity: FAILED{/red-fg}\n`;
  }
  
  dashboard.summaryBox.setContent(content);
}

function updateRolesBox(dashboard, watchState) {
  // Read from centralized state object
  const roles = watchState.roles || [];
  
  if (!Array.isArray(roles) || roles.length === 0) {
    dashboard.rolesBox.setContent('No roles detected');
    return;
  }
  
  let content = '';
  for (const role of roles) {
    if (!role || typeof role !== 'object') continue;
    const walletShort = (role.wallet || 'unknown').substring(0, 8) + '...';
    content += `${role.role || 'Unknown'}: ${walletShort}\n`;
    content += `  Volume: ${(role.volume || 0).toLocaleString()}\n`;
    content += `  Net: ${(role.net_flow || 0) >= 0 ? '+' : ''}${(role.net_flow || 0).toLocaleString()}\n`;
    content += `  Counterparties: ${role.counterparties || 0}\n\n`;
  }
  
  dashboard.rolesBox.setContent(content);
}

function updateFooter(dashboard, uiState, watchState, renderMs = 0) {
  // UI state (paused, autosave, etc.)
  const status = uiState.paused ? 'PAUSED' : 'RUNNING';
  const lastUpdate = watchState.currentInterval?.timestamp 
    ? watchState.currentInterval.timestamp.substring(11, 19) 
    : 'Never';
  const autosave = uiState.autosave ? 'ON' : 'OFF';
  const jsonPath = uiState.lastSavePath || 'N/A';
  
  // Check for RPC errors in _internal
  const rpcError = watchState._internal?.rpcError;
  const tokenAccountCount = watchState._internal?.tokenAccountCount;
  const unsupportedTokenStandard = watchState._internal?.unsupportedTokenStandard;
  const tokenStandardError = watchState._internal?.tokenStandardError;
  const discoveryWarning = watchState._internal?.discoveryWarning;
  
  // Check for unsupported token standard (highest priority)
  const currentInterval = watchState.currentInterval;
  const isUnsupported = currentInterval?.isUnsupportedTokenStandard || unsupportedTokenStandard;
  
  // Build error/warning message
  let errorMsg = '';
  if (isUnsupported && tokenStandardError) {
    errorMsg = ` | ERROR: ${tokenStandardError}`;
  } else if (rpcError) {
    if (rpcError.fatal) {
      errorMsg = ` | ERROR: ${rpcError.message}`;
    } else {
      errorMsg = ` | WARNING: ${rpcError.message}`;
    }
  } else if (discoveryWarning) {
    errorMsg = ` | WARNING: ${discoveryWarning}`;
  } else if (tokenAccountCount !== undefined && tokenAccountCount === 0) {
    errorMsg = ' | WARNING: No token accounts found';
  }
  
  // Performance metrics from watch state - display all timings
  const perf = watchState.performance || {};
  const renderTime = renderMs || perf.render_ms || 0;
  const perfStr = perf.total_ms 
    ? ` | sig=${perf.signatures_fetch_ms || 0}ms tx=${perf.transactions_fetch_ms || 0}ms parse=${perf.parse_ms || 0}ms analytics=${perf.analytics_ms || 0}ms render=${renderTime}ms total=${perf.total_ms}ms`
    : '';
  
  const content = `Status: ${status} | Last Update: ${lastUpdate} | Autosave: ${autosave} | Last Save: ${jsonPath}${errorMsg}${perfStr}`;
  dashboard.footer.setContent(content);
}

function saveSnapshot(watchState) {
  // Save complete state object
  const runsDir = path.join(process.cwd(), 'tokenctl-runs');
  if (!fs.existsSync(runsDir)) {
    fs.mkdirSync(runsDir, { recursive: true });
  }
  
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `snapshot-${timestamp}.json`;
  const filepath = path.join(runsDir, filename);
  
  // Create snapshot from state (exclude _internal for cleaner output)
  const snapshot = {
    timestamp: formatTime(),
    config: watchState.config,
    token: watchState.token,
    baseline: watchState.baseline,
    series: watchState.series,
    currentInterval: watchState.currentInterval,
    roles: watchState.roles,
    alerts: watchState.alerts,
    performance: watchState.performance
  };
  
  fs.writeFileSync(filepath, JSON.stringify(snapshot, null, 2));
  return filepath;
}

async function liveCommand(mint, options) {
  // Initialize error context
  initContext('live', [mint], options);
  
  // Initialize debug log file
  const debugLogPath = initDebugLog();
  console.log(`Debug logs: ${debugLogPath}`);
  
  // Create watch session FIRST - before any TUI initialization
  // This ensures unsupported tokens fail immediately without terminal side effects
  let watchSession;
  let screen = null;
  let dashboard = null;
  let intervalTimer = null;
  let isRunning = false;
  
  // Declare TUI variables before callbacks (callbacks will capture these by reference)
  let uiState = null;
  let watchState = null;
  let lastStateHash = null;
  let lastIntervalCheckCount = -1;
  let lastRenderMs = 0;
  let renderScheduled = false;
  let shouldRender = null;
  let doRender = null;
  let hashState = null;

  try {
    watchSession = await createWatchSession(mint, options, {
      onStart: (startInfo) => {
        // Get initial state from startInfo or session
        watchState = startInfo.state || watchSession?.getState() || null;
        if (watchState && dashboard && uiState && doRender) {
          // TUI is initialized, update UI
          // Check for token account warnings on startup
          const tokenAccountCount = watchState._internal?.tokenAccountCount;
          if (tokenAccountCount !== undefined && tokenAccountCount === 0) {
            debugLog('[LIVE] WARNING: No token accounts found - token may be new or have no holders');
          }
          
          updateTopBar(dashboard, watchState);
          updateFooter(dashboard, uiState, watchState, 0);
          doRender();
        }
      },
      onInterval: async (newState) => {
        try {
          // CRITICAL: Capture previous state values before updating reference
          const prevRefreshMs = watchState?.currentInterval?.last_refresh_ms || 0;
          
          // CRITICAL: Update state reference immediately - ensures renderer always has latest state
          watchState = newState;
          
          // Guard: TUI must be initialized before processing intervals
          if (!dashboard || !uiState || !doRender) return;
          
          if (uiState.paused) return;
          
          // Validate state structure
          if (!newState || typeof newState !== 'object') {
            addBreadcrumb('error', 'Invalid state received in onInterval');
            return;
          }
          
          // Check for fatal RPC errors
          const rpcError = newState._internal?.rpcError;
          if (rpcError && rpcError.fatal) {
            // Fatal auth error - stop intervals
            console.error('\n[LIVE] Fatal RPC error detected in onInterval, stopping intervals');
            console.error(`[LIVE] ${rpcError.message}`);
            if (intervalTimer) {
              clearInterval(intervalTimer);
              intervalTimer = null;
            }
            isRunning = false;
            uiState.paused = true; // Pause UI
            updateFooter(dashboard, uiState, watchState, 0);
            doRender();
            return;
          }
          
          const newRefreshMs = newState.currentInterval?.last_refresh_ms || 0;
          
          // Always render if last_refresh_ms changed (monotonic marker ensures interval progress)
          // Also check other state changes via shouldRender
          const refreshChanged = newRefreshMs !== prevRefreshMs;
          const shouldRenderNow = shouldRender(newState) || refreshChanged;
          
          // If refresh marker changed, ensure render happens (critical for showing interval progress)
          if (refreshChanged) {
            renderScheduled = false; // Reset render flag to allow render
          }
          
          // CRITICAL: Always update charts when state changes, even if we skip render
          // This ensures charts have the latest data when render does happen
          updateCharts(dashboard, watchState);
          
          if (!shouldRenderNow) {
            return; // Skip render if no changes (but charts already updated above)
          }
          
          // Measure render time
          const renderStart = Date.now();
          
          // Update UI from state (read-only) - widgets are not recreated
          updateTopBar(dashboard, watchState);
          updateAlertsTable(dashboard, watchState);
          updateSummaryBox(dashboard, watchState);
          updateRolesBox(dashboard, watchState);
          
          // Render once per interval
          doRender();
          
          // Update footer with render timing
          updateFooter(dashboard, uiState, watchState, lastRenderMs);
          
          // Autosave (doesn't trigger render)
          if (uiState.autosave) {
            try {
              const savePath = saveSnapshot(watchState);
              uiState.lastSavePath = path.basename(savePath);
              updateFooter(dashboard, uiState, watchState, lastRenderMs);
              // Footer update doesn't require re-render, will show on next interval
            } catch (e) {
              // Ignore save errors
            }
          }
        } catch (e) {
          // Log error but don't crash
          const { logError } = require('../logging/logger');
          logError('Error in onInterval callback', e);
          updateFooter(dashboard, uiState, watchState, 0);
          doRender();
        }
      },
      onError: (errorInfo) => {
        // Guard: TUI must be initialized before handling errors
        if (dashboard && uiState && doRender) {
          updateFooter(dashboard, uiState, watchState, 0);
          doRender();
        }
      }
    });
    
    // TUI INITIALIZATION: Only happens after successful session creation
    // This ensures unsupported tokens never initialize the TUI
    const dashboardResult = createDashboard(mint, options);
    screen = dashboardResult.screen;
    dashboard = dashboardResult.dashboard;
    
    if (!dashboard) {
      // Terminal too small, warning already shown
      return;
    }
    
    // Set TUI state for error handling
    setTUIState(true, screen);

    // UI state (separate from watch state)
    uiState = {
      paused: false,
      autosave: options.autosave !== false, // Default true
      lastSavePath: 'N/A'
    };

    // Render optimization: state change detection and throttling
    watchState = null;
    lastStateHash = null;
    lastIntervalCheckCount = -1;
    lastRenderMs = 0; // Track render timing for display
    renderScheduled = false; // Track if render is scheduled for this interval

    // Hash state for change detection (only key fields that affect display)
    hashState = (state) => {
      if (!state) return null;
      const key = JSON.stringify({
        checkCount: state.currentInterval?.checkCount,
        timestamp: state.currentInterval?.timestamp,
        last_refresh_ms: state.currentInterval?.last_refresh_ms, // Monotonic marker - ensures renders every interval
        alerts: state.alerts?.length,
        series: {
          transfers: state.series?.transfers?.slice(-1)[0],
          wallets: state.series?.wallets?.slice(-1)[0]
        },
        performance: state.performance
      });
      return key;
    };

    // Render only once per interval after state changes
    shouldRender = (newState) => {
      const newCheckCount = newState.currentInterval?.checkCount || 0;
      const newHash = hashState(newState);
      
      // Always render on new interval (checkCount changed)
      if (newCheckCount !== lastIntervalCheckCount) {
        lastIntervalCheckCount = newCheckCount;
        lastStateHash = newHash;
        renderScheduled = false; // Reset for new interval
        return true;
      }
      
      // Render if state hash changed within same interval
      if (newHash !== lastStateHash) {
        lastStateHash = newHash;
        return true;
      }
      
      return false;
    };

    // Render function: called once per interval or on user input
    doRender = (forceUserInput = false) => {
      // Prevent multiple renders per interval unless forced by user input
      if (!forceUserInput && renderScheduled) {
        return;
      }
      
      renderScheduled = !forceUserInput; // Mark as scheduled unless user input
      
      const renderStart = Date.now();
      screen.render();
      lastRenderMs = Date.now() - renderStart;
    };
    
    // Get initial state (session is now available)
    watchState = watchSession.getState();

    // Track interval number for debug logging
    let intervalNumber = 0;
    
    // Execute a single interval - always call watchSession.runInterval() directly
    const executeInterval = async () => {
      if (uiState.paused) {
        // If paused, don't run and don't schedule next
        return;
      }
      
      if (isRunning) {
        // If already running, schedule next and return (avoid overlapping intervals)
        scheduleNext();
        return;
      }
      
      isRunning = true;
      intervalNumber++;
      
      try {
        const result = await watchSession.runInterval();
        
        // Check for fatal RPC errors and stop intervals
        const currentState = watchSession.getState();
        const rpcError = currentState._internal?.rpcError;
        if (rpcError && rpcError.fatal) {
          // Fatal auth error - stop intervals
          console.error('\n[LIVE] Fatal RPC error detected, stopping intervals');
          console.error(`[LIVE] ${rpcError.message}`);
          if (intervalTimer) {
            clearInterval(intervalTimer);
            intervalTimer = null;
          }
          isRunning = false;
          uiState.paused = true; // Pause UI
          updateFooter(dashboard, uiState, currentState, 0);
          doRender();
          return;
        }
        
        // State is updated via onInterval callback, but ensure we have latest state
        if (result && result.state) {
          watchState = result.state;
        } else {
          // Fallback: get state from session
          watchState = watchSession.getState();
        }
        
        // Debug logging (if --debug flag is set)
        // Format: interval number, total_ms, transfers, unique_wallets
        if (options.debug) {
          const perf = watchState?.performance || {};
          const transfers = watchState?.currentInterval?.transfers || 0;
          const wallets = watchState?.currentInterval?.uniqueWallets || 0;
          console.log(`${intervalNumber} ${perf.total_ms || 0} ${transfers} ${wallets}`);
        }
        
      } catch (e) {
        // Log error for debugging
        if (options.debug) {
          console.log(`[DEBUG] interval=${intervalNumber} ERROR: ${e.message}`);
        }
        // Show error in footer
        updateFooter(dashboard, uiState, watchState, 0);
        doRender();
      } finally {
        isRunning = false;
        // Always schedule next interval, even on error
        scheduleNext();
      }
    };

    // Set up interval timer (defined here for use in keyboard handlers)
    const scheduleNext = () => {
      if (uiState.paused) {
        // Don't schedule if paused
        return;
      }
      
      // Clear any existing timer
      if (intervalTimer) {
        clearTimeout(intervalTimer);
        intervalTimer = null;
      }
      
      const interval = watchState?.config?.interval || 30;
      intervalTimer = setTimeout(() => {
        // Run interval and schedule next (executeInterval will call scheduleNext in finally)
        executeInterval().catch(e => {
          // Catch any unhandled errors in the timer callback
          if (options.debug) {
            console.log(`[DEBUG] scheduleNext error: ${e.message}`);
          }
          // Still schedule next to keep loop running
          scheduleNext();
        });
      }, interval * 1000);
    };

    // Initial render with empty state
    if (watchState) {
      updateTopBar(dashboard, watchState);
      updateCharts(dashboard, watchState);
      updateAlertsTable(dashboard, watchState);
      updateSummaryBox(dashboard, watchState);
      updateRolesBox(dashboard, watchState);
      updateFooter(dashboard, uiState, watchState, 0);
    }
    doRender();
    
    // Start the interval loop immediately - run first interval now, then schedule subsequent ones
    if (!uiState.paused) {
      // Run first interval immediately (executeInterval will schedule next in finally block)
      executeInterval().catch(e => {
        // Catch any errors in first interval
        if (options.debug) {
          console.log(`[DEBUG] first interval error: ${e.message}`);
        }
        // Still schedule next to keep loop running
        scheduleNext();
      });
    }

    // Keyboard controls - MUST be inside try block to prevent execution if createWatchSession() throws
    let helpVisible = false;
    let currentPanel = 0;
    const panels = ['alerts', 'summary', 'roles'];

    // Helper to safely handle keyboard handler errors
    const safeKeyHandler = (handler) => {
    return (...args) => {
      try {
        return handler(...args);
      } catch (error) {
        // Keyboard handler error - write crash report and exit
        try {
          const { writeCrashReport } = require('../logging/logger');
          const report = writeCrashReport(error);
          const logFile = report.logFile || 'failed';
          showTUIErrorOverlay(screen, error, logFile);
          // Wait for user to press q in overlay, then exit
        } catch (reportError) {
          // If crash report fails, at least try to destroy screen and exit
          try {
            screen.destroy();
          } catch (e) {
            // Ignore destroy errors
          }
          console.error('Fatal error in keyboard handler');
          process.exit(1);
        }
      }
    };
    };

    screen.key(['q', 'escape', 'C-c'], safeKeyHandler(() => {
      if (intervalTimer) {
        clearTimeout(intervalTimer);
      }
      try {
        screen.destroy();
      } catch (e) {
        // Ignore destroy errors on normal exit
      }
      process.exit(0);
    }));

    screen.key(['p'], safeKeyHandler(() => {
    uiState.paused = !uiState.paused;
    if (uiState.paused) {
      // Clear timer
      if (intervalTimer) {
        clearTimeout(intervalTimer);
        intervalTimer = null;
      }
    } else {
      // Resume
      scheduleNext();
    }
      updateFooter(dashboard, uiState, watchState, 0);
      doRender(true); // Force render on user input (doesn't affect interval render)
    }));

    screen.key(['r'], safeKeyHandler(async () => {
    // If paused, don't allow refresh
    if (uiState.paused) {
      return;
    }
    
    // If already running, wait for it to complete then run another
    if (isRunning) {
      // Wait for current interval to finish, then trigger another
      const checkComplete = setInterval(() => {
        if (!isRunning) {
          clearInterval(checkComplete);
          // Trigger immediate refresh using watchSession.runInterval()
          watchSession.runInterval().then(result => {
            // Get latest state
            watchState = watchSession.getState();
            // Force render
            updateTopBar(dashboard, watchState);
            updateCharts(dashboard, watchState);
            updateAlertsTable(dashboard, watchState);
            updateSummaryBox(dashboard, watchState);
            updateRolesBox(dashboard, watchState);
            updateFooter(dashboard, uiState, watchState, 0);
            doRender(true);
          }).catch(e => {
            if (options.debug) {
              console.log(`[DEBUG] manual refresh error: ${e.message}`);
            }
            watchState = watchSession.getState();
            updateFooter(dashboard, uiState, watchState, 0);
            doRender(true);
          });
        }
      }, 50);
      return;
    }
    
    // Force immediate refresh
    isRunning = true;
    try {
      const result = await watchSession.runInterval();
      
      // Get latest state (onInterval callback should have updated it, but ensure we have latest)
      watchState = watchSession.getState();
      
      // Force render regardless of shouldRender check (user requested refresh)
      updateTopBar(dashboard, watchState);
      updateCharts(dashboard, watchState);
      updateAlertsTable(dashboard, watchState);
      updateSummaryBox(dashboard, watchState);
      updateRolesBox(dashboard, watchState);
      updateFooter(dashboard, uiState, watchState, 0);
      doRender(true); // Force render on user input
    } catch (e) {
      if (options.debug) {
        console.log(`[DEBUG] manual refresh error: ${e.message}`);
      }
      watchState = watchSession.getState();
      updateFooter(dashboard, uiState, watchState, 0);
      doRender(true);
    } finally {
      isRunning = false;
      }
    }));

    screen.key(['s'], safeKeyHandler(() => {
    try {
      const currentState = watchSession.getState();
      const savePath = saveSnapshot(currentState);
      uiState.lastSavePath = path.basename(savePath);
      updateFooter(dashboard, uiState, watchState, 0);
      doRender(true); // Force render on user input
      
      // Show brief confirmation
      const msg = blessed.message({
        parent: screen,
        top: 'center',
        left: 'center',
        width: 30,
        height: 5,
        border: {
          type: 'line'
        },
        style: {
          fg: 'green',
          border: {
            fg: 'green'
          }
        }
      });
      msg.display(`Saved: ${path.basename(savePath)}`, 2, () => {});
      doRender(true); // Force render for message
    } catch (e) {
      const msg = blessed.message({
        parent: screen,
        top: 'center',
        left: 'center',
        width: 30,
        height: 5,
        border: {
          type: 'line'
        },
        style: {
          fg: 'red',
          border: {
            fg: 'red'
          }
        }
      });
      msg.display(`Error: ${e.message}`, 2, () => {});
      doRender(true); // Force render for error message
      }
    }));

    screen.key(['?'], safeKeyHandler(() => {
    helpVisible = !helpVisible;
    if (helpVisible) {
      const helpBox = blessed.box({
        top: 'center',
        left: 'center',
        width: 50,
        height: 12,
        content: `Keyboard Controls:\n\nq - Quit\np - Pause/Resume\nr - Force refresh\ns - Save snapshot\ntab - Cycle panels\n? - Toggle help`,
        tags: true,
        border: {
          type: 'line'
        },
        style: {
          fg: 'white',
          bg: 'blue',
          border: {
            fg: 'white'
          }
        }
      });
      screen.append(helpBox);
      helpBox.focus();
      doRender(true); // Force render on user input
      
      helpBox.key(['?', 'escape'], safeKeyHandler(() => {
        screen.remove(helpBox);
        helpBox.destroy();
        helpVisible = false;
        doRender(true); // Force render on user input
      }));
      }
    }));

    screen.key(['tab'], safeKeyHandler(() => {
      // Cycle focus between panels (visual only, no functional change for now)
      currentPanel = (currentPanel + 1) % panels.length;
      doRender(true); // Force render on user input
    }));

    screen.render();

  } catch (e) {
    // Fatal error - handle with crash report
    // This catch block ensures unsupported tokens never initialize TUI or keyboard handlers
    if (screen) {
      const { writeCrashReport } = require('../logging/logger');
      const { logFile } = writeCrashReport(e);
      showTUIErrorOverlay(screen, e, logFile);
      // Wait for user to press q, then exit
      return;
    }
    handleFatalError(e);
  }
}

module.exports = liveCommand;

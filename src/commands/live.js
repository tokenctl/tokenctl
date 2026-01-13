const blessed = require('blessed');
const contrib = require('blessed-contrib');
const fs = require('fs');
const path = require('path');
// Use new state-based watch core
const { createWatchSession, formatTime } = require('../utils/watch-core-v2');
const { initContext, setTUIState, runStage, showTUIErrorOverlay, handleFatalError, addBreadcrumb } = require('../logging/logger');

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
  
  const content = `Token: ${tokenName} | Mint: ${mint.substring(0, 8)}... | Interval: ${interval}s | Baseline: ${baselineStatus} | RPC: ${rpcHost}`;
  dashboard.topBar.setContent(content);
}

function updateCharts(dashboard, watchState) {
  // Read from centralized state object
  if (!dashboard) return;
  
  const series = watchState.series || { transfers: [], wallets: [], avgSize: [], dominantShare: [] };
  
  // Ensure all series arrays exist and are arrays
  if (!Array.isArray(series.transfers)) series.transfers = [];
  if (!Array.isArray(series.wallets)) series.wallets = [];
  if (!Array.isArray(series.avgSize)) series.avgSize = [];
  if (!Array.isArray(series.dominantShare)) series.dominantShare = [];
  
  // Transfers per interval - use rolling window scaling
  const transfersData = series.transfers.length > 0 ? series.transfers : [0];
  const transfersX = transfersData.map((_, i) => String(i));
  const transfersY = transfersData.map(v => Number(v) || 0);
  
  // Validate arrays before passing to chart
  if (!Array.isArray(transfersX) || !Array.isArray(transfersY)) return;
  if (transfersX.length === 0 || transfersY.length === 0) return;
  
  try {
    if (dashboard.transfersChart && typeof dashboard.transfersChart.setData === 'function') {
      dashboard.transfersChart.setData([{
        title: 'Transfers',
        x: transfersX,
        y: transfersY,
        style: {
          line: 'yellow'
        }
      }]);
    }
  } catch (e) {
    // Ignore chart errors
  }

  // Unique wallets per interval
  const walletsData = series.wallets.length > 0 ? series.wallets : [0];
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
      // Ignore chart errors
    }
  }

  // Avg transfer size
  const avgSizeData = series.avgSize.length > 0 ? series.avgSize : [0];
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
      // Ignore chart errors
    }
  }

  // Dominant wallet share - already normalized to [0, 100] in state
  const dominantShareData = series.dominantShare.length > 0 ? series.dominantShare : [0];
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
      // Ignore chart errors
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
  
  // Performance metrics from watch state - display all timings
  const perf = watchState.performance || {};
  const renderTime = renderMs || perf.render_ms || 0;
  const perfStr = perf.total_ms 
    ? ` | sig=${perf.signatures_fetch_ms || 0}ms tx=${perf.transactions_fetch_ms || 0}ms parse=${perf.parse_ms || 0}ms analytics=${perf.analytics_ms || 0}ms render=${renderTime}ms total=${perf.total_ms}ms`
    : '';
  
  const content = `Status: ${status} | Last Update: ${lastUpdate} | Autosave: ${autosave} | Last Save: ${jsonPath}${perfStr}`;
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
  
  const { screen, dashboard } = createDashboard(mint, options);
  
  if (!dashboard) {
    // Terminal too small, warning already shown
    return;
  }
  
  // Set TUI state for error handling
  setTUIState(true, screen);

  // UI state (separate from watch state)
  const uiState = {
    paused: false,
    autosave: options.autosave !== false, // Default true
    lastSavePath: 'N/A'
  };

  // Render optimization: state change detection and throttling
  let lastRenderTime = 0;
  let pendingRender = false;
  let watchState = null;
  let lastStateHash = null;
  let lastIntervalRenderTime = 0;
  let userInputPending = false;
  let lastRenderMs = 0; // Track render timing for display

  // Hash state for change detection (only key fields that affect display)
  const hashState = (state) => {
    if (!state) return null;
    const key = JSON.stringify({
      checkCount: state.currentInterval?.checkCount,
      timestamp: state.currentInterval?.timestamp,
      alerts: state.alerts?.length,
      series: {
        transfers: state.series?.transfers?.slice(-1)[0],
        wallets: state.series?.wallets?.slice(-1)[0]
      },
      performance: state.performance
    });
    return key;
  };

  // Render only if state changed or user input occurred
  const shouldRender = (newState) => {
    const newHash = hashState(newState);
    if (newHash !== lastStateHash) {
      lastStateHash = newHash;
      return true;
    }
    // Always render on user input
    if (userInputPending) {
      userInputPending = false;
      return true;
    }
    return false;
  };

  // Throttled render: once per interval unless key input
  const throttledRender = (force = false) => {
    const now = Date.now();
    // If forced (user input), render immediately
    if (force) {
      userInputPending = true;
      lastRenderTime = now;
      lastIntervalRenderTime = now;
      screen.render();
      return;
    }
    // Otherwise, throttle to once per interval (30s default = 30000ms)
    const interval = watchState?.config?.interval || 30;
    const minInterval = interval * 1000;
    if (now - lastIntervalRenderTime < minInterval && !force) {
      pendingRender = true;
      return;
    }
    lastRenderTime = now;
    lastIntervalRenderTime = now;
    pendingRender = false;
    screen.render();
  };

  // Create watch session
  let watchSession;
  let intervalTimer = null;
  let isRunning = false;

  try {
    watchSession = await createWatchSession(mint, options, {
      onStart: (startInfo) => {
        // Get initial state from startInfo or session
        watchState = startInfo.state || watchSession?.getState() || null;
        if (watchState) {
          updateTopBar(dashboard, watchState);
          updateFooter(dashboard, uiState, watchState, 0);
          throttledRender();
        }
      },
      onInterval: (newState) => {
        try {
          if (uiState.paused) return;
          
          // Validate state structure
          if (!newState || typeof newState !== 'object') {
            addBreadcrumb('error', 'Invalid state received in onInterval');
            return;
          }
          
          // Check if state changed before updating UI
          if (!shouldRender(newState)) {
            return; // Skip render if no changes
          }
          
          // Measure render time
          const renderStart = Date.now();
          
          // Update watch state (atomic)
          watchState = newState;
          
          // Update UI from state (read-only) - widgets are not recreated
          updateTopBar(dashboard, watchState);
          updateCharts(dashboard, watchState);
          updateAlertsTable(dashboard, watchState);
          updateSummaryBox(dashboard, watchState);
          updateRolesBox(dashboard, watchState);
          
          // Measure render time (includes screen.render call)
          const renderBeforeScreen = Date.now();
          throttledRender(); // Throttled render (once per interval)
          lastRenderMs = Date.now() - renderBeforeScreen;
          
          // Update footer with render timing
          updateFooter(dashboard, uiState, watchState, lastRenderMs);
          
          // Autosave
          if (uiState.autosave) {
            try {
              const savePath = saveSnapshot(watchState);
              uiState.lastSavePath = path.basename(savePath);
              updateFooter(dashboard, uiState, watchState, lastRenderMs);
              // Don't force render for autosave - wait for next interval
            } catch (e) {
              // Ignore save errors
            }
          }
        } catch (e) {
          // Log error but don't crash
          const { logError } = require('../logging/logger');
          logError('Error in onInterval callback', e);
          updateFooter(dashboard, uiState, watchState, 0);
          throttledRender();
        }
      },
      onError: (errorInfo) => {
        // Update footer with error info
        updateFooter(dashboard, uiState, watchState, 0);
        throttledRender();
      }
    });
    
    // Get initial state (session is now available)
    watchState = watchSession.getState();

    // Start first interval immediately
    const runInterval = async () => {
      if (uiState.paused || isRunning) return;
      isRunning = true;
      try {
        const result = await watchSession.runInterval();
        // State is updated via onInterval callback
        if (result && result.state) {
          watchState = result.state;
        }
        // Process pending render if any
        if (pendingRender) {
          throttledRender();
        }
        } catch (e) {
        // Show error in footer
        updateFooter(dashboard, uiState, watchState, 0);
        throttledRender();
      } finally {
        isRunning = false;
      }
    };

    // Set up interval timer (defined here for use in keyboard handlers)
    const scheduleNext = () => {
      if (!uiState.paused && !isRunning) {
        if (intervalTimer) clearTimeout(intervalTimer);
        const interval = watchState?.config?.interval || 30;
        intervalTimer = setTimeout(async () => {
          await runInterval();
          scheduleNext();
        }, interval * 1000);
      }
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
    throttledRender();
    
    // Run first interval
    await runInterval();
    scheduleNext();

  } catch (e) {
    // Fatal error - handle with crash report
    if (screen) {
      const { writeCrashReport } = require('../logging/logger');
      const { logFile } = writeCrashReport(e);
      showTUIErrorOverlay(screen, e, logFile);
      // Wait for user to press q, then exit
      return;
    }
    handleFatalError(e);
  }

  // Keyboard controls
  let helpVisible = false;
  let currentPanel = 0;
  const panels = ['alerts', 'summary', 'roles'];

  screen.key(['q', 'escape', 'C-c'], () => {
    if (intervalTimer) {
      clearTimeout(intervalTimer);
    }
    process.removeListener('uncaughtException', errorHandler);
    process.removeListener('unhandledRejection', errorHandler);
    screen.destroy();
    process.exit(0);
  });

  screen.key(['p'], () => {
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
    throttledRender(true); // Force render on user input
  });

  screen.key(['r'], async () => {
    if (uiState.paused || isRunning) return;
    isRunning = true;
    try {
      await watchSession.runInterval();
    } finally {
      isRunning = false;
    }
  });

  screen.key(['s'], () => {
    try {
      const currentState = watchSession.getState();
      const savePath = saveSnapshot(currentState);
      uiState.lastSavePath = path.basename(savePath);
      updateFooter(dashboard, uiState, watchState, 0);
      throttledRender(true); // Force render on user input
      
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
      throttledRender(true); // Force render for message
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
      throttledRender(true); // Force render for error message
    }
  });

  screen.key(['?'], () => {
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
      throttledRender(true); // Force render on user input
      
      helpBox.key(['?', 'escape'], () => {
        screen.remove(helpBox);
        helpBox.destroy();
        helpVisible = false;
        throttledRender(true); // Force render on user input
      });
    }
  });

  screen.key(['tab'], () => {
    // Cycle focus between panels (visual only, no functional change for now)
    currentPanel = (currentPanel + 1) % panels.length;
    throttledRender(true); // Force render on user input
  });

  screen.render();
}

module.exports = liveCommand;

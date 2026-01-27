// Centralized error logging and crash reporting for tokenctl
const fs = require('fs');
const path = require('path');
const { version } = require('../../package.json');

// Error context tracking
let errorContext = {
  command: null,
  args: [],
  mint: null,
  rpc: null,
  interval: null,
  phase: null,
  signature: null,
  last_ok_phase: null,
  timings: {},
  state_summary: null,
  flags: {}
};

// Breadcrumbs for debugging
const breadcrumbs = [];

// TUI state tracking
let tuiActive = false;
let tuiScreen = null;

/**
 * Initialize error context
 */
function initContext(command, args, options = {}) {
  errorContext = {
    command,
    args,
    mint: args[0] || null,
    rpc: options.rpc || null,
    interval: options.interval || null,
    phase: null,
    signature: null,
    last_ok_phase: null,
    timings: {},
    state_summary: null,
    flags: options
  };
  breadcrumbs.length = 0;
}

/**
 * Set TUI state
 */
function setTUIState(active, screen = null) {
  tuiActive = active;
  tuiScreen = screen;
}

/**
 * Add breadcrumb
 */
function addBreadcrumb(phase, message) {
  breadcrumbs.push({
    ts: new Date().toISOString(),
    phase,
    msg: message
  });
  // Keep last 50 breadcrumbs
  if (breadcrumbs.length > 50) {
    breadcrumbs.shift();
  }
}

/**
 * Update error context
 */
function updateContext(updates) {
  Object.assign(errorContext, updates);
}

/**
 * Extract origin from stack trace (first user code frame)
 */
function extractOrigin(stack) {
  if (!stack) return null;
  
  const lines = stack.split('\n');
  for (const line of lines) {
    // Skip node internals and node_modules
    if (line.includes('node:') || 
        line.includes('node_modules') ||
        line.includes('internal/') ||
        line.includes('(native)')) {
      continue;
    }
    
    // Match: at functionName (file:line:column) or at file:line:column
    const match = line.match(/at\s+(?:(\S+)\s+\()?([^:]+):(\d+):(\d+)\)?/);
    if (match) {
      const functionName = match[1] || null;
      const file = match[2].trim();
      const line = parseInt(match[3], 10);
      const column = parseInt(match[4], 10);
      
      // Only return if it's our code (not node_modules)
      if (!file.includes('node_modules')) {
        return {
          file: path.relative(process.cwd(), file) || file,
          line,
          column,
          function: functionName
        };
      }
    }
  }
  
  return null;
}

/**
 * Write crash report
 */
function writeCrashReport(error, context = null) {
  const ctx = context || errorContext;
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const command = ctx.command || 'unknown';
  
  // Ensure errors directory exists
  const errorsDir = path.join(process.cwd(), 'tokenctl-runs', 'errors');
  if (!fs.existsSync(errorsDir)) {
    fs.mkdirSync(errorsDir, { recursive: true });
  }
  
  // Extract origin
  const origin = extractOrigin(error.stack);
  
  // Build crash report
  const report = {
    timestamp: new Date().toISOString(),
    version,
    node_version: process.version,
    platform: process.platform,
    command,
    argv: process.argv,
    context: {
      mint: ctx.mint,
      rpc: ctx.rpc,
      interval: ctx.interval,
      phase: ctx.phase,
      signature: ctx.signature,
      flags: ctx.flags
    },
    timings: ctx.timings || {},
    error: {
      name: error.name || 'Error',
      message: error.message || String(error),
      stack: error.stack || ''
    },
    origin,
    breadcrumbs: breadcrumbs.slice(-20), // Last 20 breadcrumbs
    last_state_summary: ctx.state_summary || null
  };
  
  // Write JSON report
  const jsonFile = path.join(errorsDir, `${timestamp}_${command}.json`);
  fs.writeFileSync(jsonFile, JSON.stringify(report, null, 2));
  
  // Write human-readable log
  const logFile = path.join(errorsDir, `${timestamp}_${command}.log`);
  const logContent = [
    `Tokenctl Crash Report`,
    `====================`,
    ``,
    `Timestamp: ${report.timestamp}`,
    `Version: ${report.version}`,
    `Node: ${report.node_version}`,
    `Platform: ${report.platform}`,
    ``,
    `Command: ${command}`,
    `Arguments: ${process.argv.join(' ')}`,
    ``,
    `Context:`,
    `  Mint: ${ctx.mint || 'N/A'}`,
    `  RPC: ${ctx.rpc || 'N/A'}`,
    `  Interval: ${ctx.interval || 'N/A'}`,
    `  Phase: ${ctx.phase || 'N/A'}`,
    `  Signature: ${ctx.signature || 'N/A'}`,
    ``,
    `Error:`,
    `  Type: ${error.name || 'Error'}`,
    `  Message: ${error.message || String(error)}`,
    ``,
    origin ? `Origin:` : '',
    origin ? `  File: ${origin.file}` : '',
    origin ? `  Line: ${origin.line}` : '',
    origin ? `  Column: ${origin.column}` : '',
    origin ? `  Function: ${origin.function || 'N/A'}` : '',
    origin ? `` : '',
    `Stack Trace:`,
    error.stack || 'No stack trace available',
    ``,
    `Timings:`,
    ...Object.entries(ctx.timings || {}).map(([k, v]) => `  ${k}: ${v}ms`),
    ``,
    `Breadcrumbs:`,
    ...breadcrumbs.slice(-20).map(b => `  [${b.ts}] ${b.phase}: ${b.msg}`),
    ``,
    `Last State Summary:`,
    ctx.state_summary ? JSON.stringify(ctx.state_summary, null, 2) : 'N/A'
  ].filter(Boolean).join('\n');
  
  fs.writeFileSync(logFile, logContent);
  
  return { jsonFile, logFile };
}

/**
 * Safe stage runner with error handling
 * Wraps stage execution, tracks timing, captures errors, and writes crash reports on failure
 * Logs warning if stage exceeds 2x interval duration
 */
async function runStage(stageName, ctx, fn) {
  const start = Date.now();
  const previousPhase = errorContext.phase;
  errorContext.phase = stageName;
  addBreadcrumb(stageName, 'Starting');
  
  // Merge provided context if given
  if (ctx && typeof ctx === 'object') {
    updateContext(ctx);
  }
  
  try {
    const result = await fn();
    const duration = Date.now() - start;
    errorContext.timings[stageName] = duration;
    errorContext.last_ok_phase = stageName;
    addBreadcrumb(stageName, `Completed in ${duration}ms`);
    
    // Check for timeout warning: if stage exceeds 2x interval duration
    const intervalSeconds = errorContext.interval ? parseInt(errorContext.interval, 10) : 30;
    const intervalMs = intervalSeconds * 1000;
    const timeoutThreshold = intervalMs * 2;
    
    if (duration > timeoutThreshold) {
      logWarn(`Stage '${stageName}' exceeded 2x interval duration: ${duration}ms (threshold: ${timeoutThreshold}ms, interval: ${intervalSeconds}s)`);
    }
    
    return result;
  } catch (error) {
    const duration = Date.now() - start;
    errorContext.timings[stageName] = duration;
    addBreadcrumb(stageName, `Failed: ${error.message}`);
    
    // Ensure error has a stack trace
    if (!error.stack) {
      error.stack = new Error(error.message).stack;
    }
    
    // Write crash report for this stage error
    try {
      const { logFile } = writeCrashReport(error, errorContext);
      logError(`Stage '${stageName}' failed`, error);
      logError(`Crash report written to: ${logFile}`);
    } catch (reportError) {
      // If crash report writing fails, at least log the error
      logError(`Failed to write crash report: ${reportError.message}`);
    }
    
    // Re-throw to allow caller to handle
    throw error;
  }
}

/**
 * Log info
 */
function logInfo(message) {
  if (!tuiActive) {
    console.log(`[INFO] ${message}`);
  }
  addBreadcrumb('info', message);
}

/**
 * Log warning
 */
function logWarn(message) {
  if (!tuiActive) {
    console.warn(`[WARN] ${message}`);
  }
  addBreadcrumb('warn', message);
}

/**
 * Log error (non-fatal)
 * Includes file and line number if available
 */
function logError(message, error = null) {
  let errorDetails = message;
  
  if (error) {
    const origin = extractOrigin(error.stack);
    if (origin) {
      errorDetails = `${message} (${origin.file}:${origin.line})`;
    } else {
      errorDetails = `${message}: ${error.message || String(error)}`;
    }
    
    if (!tuiActive) {
      console.error(`[ERROR] ${errorDetails}`);
      if (error.stack) {
        console.error(error.stack);
      }
    }
  } else {
    if (!tuiActive) {
      console.error(`[ERROR] ${errorDetails}`);
    }
  }
  
  addBreadcrumb('error', errorDetails);
}

/**
 * Handle fatal error
 * Restores terminal cleanly and writes crash report
 */
function handleFatalError(error) {
  // Ensure error has stack trace
  if (!error.stack) {
    error.stack = new Error(error.message || String(error)).stack;
  }
  
  // Restore terminal if TUI is active
  if (tuiActive && tuiScreen) {
    try {
      tuiScreen.destroy();
    } catch (e) {
      // Ignore errors during cleanup
    }
    // Reset TUI state
    tuiActive = false;
    tuiScreen = null;
  }
  
  // Write crash report
  let jsonFile, logFile;
  try {
    const report = writeCrashReport(error);
    jsonFile = report.jsonFile;
    logFile = report.logFile;
  } catch (e) {
    // If crash report writing fails, use fallback
    logFile = 'failed to write crash report';
    jsonFile = 'N/A';
  }
  
  // Extract origin for display
  const origin = extractOrigin(error.stack);
  const originText = origin ? `${origin.file}:${origin.line}` : 'unknown';
  
  // Show error message
  console.error('\n\n═══════════════════════════════════════════════════════');
  console.error('FATAL ERROR');
  console.error('═══════════════════════════════════════════════════════\n');
  console.error(`Error: ${error.message || String(error)}`);
  if (origin) {
    console.error(`Origin: ${origin.file}:${origin.line}${origin.function ? ` (${origin.function})` : ''}`);
  }
  console.error(`\nCrash report: ${logFile}`);
  console.error(`Full details: ${jsonFile}`);
  console.error('\n═══════════════════════════════════════════════════════\n');
  
  process.exit(1);
}

/**
 * Setup global error handlers
 */
function setupErrorHandlers() {
  process.on('uncaughtException', (error) => {
    handleFatalError(error);
  });
  
  process.on('unhandledRejection', (reason, promise) => {
    const error = reason instanceof Error ? reason : new Error(String(reason));
    error.message = `Unhandled Promise Rejection: ${error.message}`;
    handleFatalError(error);
  });
}

/**
 * Show TUI error overlay
 * Minimal overlay showing error summary and crash report path
 */
function showTUIErrorOverlay(screen, error, logFile) {
  if (!screen) return;
  
  // Extract origin for display
  const origin = extractOrigin(error.stack);
  const originText = origin ? `${origin.file}:${origin.line}` : 'unknown';
  
  // Create minimal error summary
  const errorSummary = error.message || String(error);
  const summaryLines = errorSummary.split('\n');
  const displaySummary = summaryLines[0].substring(0, 50) + (summaryLines[0].length > 50 ? '...' : '');
  
  // Format log file path (show relative path if possible)
  const logPath = path.relative(process.cwd(), logFile) || logFile;
  
  const errorBox = require('blessed').box({
    top: 'center',
    left: 'center',
    width: 70,
    height: 12,
    content: `Fatal Error\n\n${displaySummary}\n\nOrigin: ${originText}\n\nCrash report:\n${logPath}\n\nPress 'q' to exit`,
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
    },
    scrollable: true
  });
  
  screen.append(errorBox);
  screen.render();
  
  screen.key(['q', 'escape', 'C-c'], () => {
    screen.destroy();
    process.exit(1);
  });
}

// Debug log file writer (shared across modules)
let debugLogStream = null;
let debugLogPath = null;

function initDebugLog() {
  const runsDir = path.join(process.cwd(), 'tokenctl-runs');
  if (!fs.existsSync(runsDir)) {
    fs.mkdirSync(runsDir, { recursive: true });
  }
  const timestamp = new Date().toISOString().replace(/:/g, '-').replace(/\..+/, '');
  debugLogPath = path.join(runsDir, `debug-${timestamp}.log`);
  debugLogStream = fs.createWriteStream(debugLogPath, { flags: 'a' });
  return debugLogPath;
}

function debugLog(...args) {
  if (!debugLogStream) {
    initDebugLog();
  }
  const timestamp = new Date().toISOString();
  const message = args.map(arg => typeof arg === 'object' ? JSON.stringify(arg, null, 2) : String(arg)).join(' ');
  debugLogStream.write(`[${timestamp}] ${message}\n`);
}

module.exports = {
  initContext,
  setTUIState,
  addBreadcrumb,
  updateContext,
  writeCrashReport,
  runStage,
  logInfo,
  logWarn,
  logError,
  handleFatalError,
  setupErrorHandlers,
  showTUIErrorOverlay,
  debugLog,
  initDebugLog
};

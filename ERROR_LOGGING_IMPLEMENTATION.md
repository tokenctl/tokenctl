# Error Logging and Crash Reporting Implementation

## Overview
Comprehensive error logging and crash reporting system for tokenctl with first-class error handling, crash reports, and TUI-safe error display.

## Implementation Status

### ✅ Completed

1. **Centralized Logger Module** (`src/logging/logger.js`)
   - `logInfo`, `logWarn`, `logError` functions
   - `writeCrashReport` function
   - `runStage` wrapper for safe execution
   - Error context tracking
   - Breadcrumb system for debugging
   - Stack trace parsing to extract origin (file, line, column, function)
   - TUI state tracking

2. **Error Context System**
   - Tracks: command, args, mint, rpc, interval, phase, signature, last_ok_phase, timings, state_summary
   - Context initialized at command start
   - Updated throughout execution pipeline

3. **Stage Wrapping**
   - All critical stages wrapped with `runStage()`:
     - `fetchSignatures`
     - `fetchTransactions`
     - `parse`
     - `analytics`
     - `render`
   - Each stage tracks timing and breadcrumbs
   - Errors caught and re-thrown with context

4. **Crash Report Format**
   - JSON report: `./tokenctl-runs/errors/<timestamp>_<command>.json`
   - Human-readable log: `./tokenctl-runs/errors/<timestamp>_<command>.log`
   - Includes: timestamp, version, node_version, platform, command, argv, context, timings, error details, origin, breadcrumbs, last_state_summary

5. **TUI Error Handling**
   - TUI mode: shows minimal error overlay (no raw stack traces)
   - Non-TUI mode: shows full error details
   - Terminal always restored on crash
   - Crash report path displayed to user

6. **Global Error Handlers**
   - `process.on('uncaughtException')` handler
   - `process.on('unhandledRejection')` handler
   - Setup in `bin/tokenctl` entry point

7. **Debug Mode**
   - `--debug` flag for watch/live commands
   - Writes interval snapshots to `./tokenctl-runs/debug/`
   - Includes extra breadcrumbs

## Files Created/Modified

### New Files
- `src/logging/logger.js` - Centralized logging and crash reporting

### Modified Files
- `src/utils/watch-core-v2.js` - Integrated error logging, stage wrapping
- `src/commands/live.js` - Integrated error logging, TUI error handling
- `bin/tokenctl` - Added global error handlers, debug flag

## Usage

### Normal Operation
Errors are automatically logged and crash reports are written on fatal errors.

### Debug Mode
```bash
tokenctl live <mint> --debug
tokenctl watch <mint> --debug
```

This enables:
- Interval debug snapshots in `./tokenctl-runs/debug/`
- Extra breadcrumbs for debugging

### Crash Reports
When an error occurs:
1. Crash report JSON written to `./tokenctl-runs/errors/<timestamp>_<command>.json`
2. Human-readable log written to `./tokenctl-runs/errors/<timestamp>_<command>.log`
3. In TUI mode: minimal overlay shown, terminal restored
4. In non-TUI mode: full error details shown
5. Process exits with code 1

## Crash Report Contents

### JSON Format
```json
{
  "timestamp": "2024-12-XX...",
  "version": "1.3.0",
  "node_version": "v18.20.8",
  "platform": "linux",
  "command": "live",
  "argv": [...],
  "context": {
    "mint": "...",
    "rpc": "...",
    "interval": 30,
    "phase": "analytics",
    "signature": "...",
    "flags": {...}
  },
  "timings": {
    "fetchSignatures": 150,
    "fetchTransactions": 500,
    "parse": 50,
    "analytics": 100
  },
  "error": {
    "name": "TypeError",
    "message": "...",
    "stack": "..."
  },
  "origin": {
    "file": "src/utils/watch-core-v2.js",
    "line": 372,
    "column": 15,
    "function": "processIntervalData"
  },
  "breadcrumbs": [...],
  "last_state_summary": {
    "baseline_status": "forming",
    "series_lengths": {...},
    "alerts_count": 0
  }
}
```

### Log Format
Human-readable text log with all the same information in a readable format.

## Testing

To test error handling:
1. Add intentional error: `throw new Error("test")` in any stage
2. Verify crash reports are created
3. Verify origin is correctly extracted
4. Verify TUI shows overlay (if in TUI mode)
5. Verify process exits with code 1

## Known Issues

- Need to verify data flow issue in live command (investigating why data isn't showing)

# TUI Refactor Summary

## Architecture Changes

### 1. Centralized State Management (`src/utils/watch-state.js`)
- Single immutable state object updated atomically per interval
- All data flows through state: watcher updates state, renderer reads state
- No direct rendering calls from data logic
- State includes: config, token metadata, baseline, series, currentInterval, roles, alerts, performance metrics

### 2. Refactored Watch Core (`src/utils/watch-core-v2.js`)
- Uses state management system
- Performance instrumentation: tracks signatures_fetch_ms, transactions_fetch_ms, parse_ms, analytics_ms, render_ms, total_ms
- Caching: processed signatures cache, mint metadata cache (refreshed every 10 intervals)
- Concurrency: fetch transactions concurrently (max 10)
- Record mode: saves raw transactions and events to `./tokenctl-runs/raw/`
- Replay mode: loads recorded data and runs deterministically
- Data integrity checks: validates all metrics before baseline update

### 3. Alert System Hardening
- Severity tiers: info, watch, warning, critical
- Deduplication: suppresses repeated alerts unless severity increases or condition worsens
- Stable alert_id: derived from type + wallet + condition key
- Confidence scores: calculated from baseline delta percentage and duration

### 4. Chart and Metric Normalization
- Dominant wallet share clamped to [0, 100]
- Rolling window scaling for all charts (not absolute max)
- Zero transfer intervals render cleanly

### 5. Data Integrity Gates
- Validates: dominant_share ∈ [0,100], non-negative integers, avg_transfer_size = 0 when transfers = 0
- Marks intervals as partial on failure
- Emits data_integrity alerts
- Baseline only updates on verified intervals

### 6. Performance Improvements
- Signature caching: only fetch new signatures per interval
- Concurrent transaction fetching: max 10 concurrent requests
- Metadata caching: refresh every 10 intervals
- Render throttling: only render on state change, once per interval

## Integration Steps

1. Replace `watch-core.js` with `watch-core-v2.js` (or rename)
2. Update `live.js` to read from state object instead of processing data
3. Add render throttling to live.js
4. Update footer to show performance metrics
5. Add record/replay command line options
6. Add unit tests for replay mode

## Status

- ✅ State management module created
- ✅ Watch core v2 created with state system
- ✅ Alert system hardening implemented
- ✅ Data integrity checks implemented
- ✅ Performance instrumentation added
- ✅ Caching and concurrency implemented
- ⏳ Live.js refactor to read from state (in progress)
- ⏳ Render throttling (pending)
- ⏳ Record/replay integration (pending)
- ⏳ Unit tests (pending)

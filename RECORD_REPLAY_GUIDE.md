# Record and Replay Guide

## Overview

The watch/live commands now support deterministic record and replay functionality. This allows you to:
- Record a monitoring session to disk for later analysis
- Replay recorded sessions offline without RPC calls
- Verify determinism: same recording produces identical results

## Files Changed

1. **`bin/tokenctl`** - Added `--record` and `--replay <fileOrDir>` CLI options
2. **`src/utils/watch-core-v2.js`** - Core recording/replay implementation
3. **`src/utils/watch-state.js`** - Enhanced integrity checks
4. **`src/commands/watch.js`** - Updated to use watch-core-v2 and handle data_integrity alerts
5. **`test/record-replay.test.js`** - Unit tests for determinism

## Usage Examples

### Recording a Session

Record a monitoring session to disk:

```bash
# Record watch command
tokenctl watch EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v --record --interval 30

# Record live command
tokenctl live EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v --record --interval 30
```

Recordings are saved to `./tokenctl-runs/raw/<timestamp>/` with one JSON file per interval:
- `interval-1-<timestamp>.json`
- `interval-2-<timestamp>.json`
- etc.

Each file contains:
- `timestamp`: When the interval was recorded
- `checkCount`: Interval number
- `signatures`: Transaction signatures fetched
- `transactions`: Raw transaction data
- `events`: Extracted transfer/mint events
- `supply`: Token supply at interval time

### Replaying a Session

Replay from a directory (recommended):

```bash
# Replay from directory
tokenctl watch EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v --replay ./tokenctl-runs/raw/2025-01-15T10-30-00-000Z/

# Replay with live command
tokenctl live EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v --replay ./tokenctl-runs/raw/2025-01-15T10-30-00-000Z/
```

Replay from a single manifest file:

```bash
# If you have a manifest file with all intervals
tokenctl watch EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v --replay ./recording.json
```

**Important**: Replay mode makes **zero RPC calls**. All data comes from the recording.

### Complete Example: Record Then Replay

```bash
# Step 1: Record a session (run for a few intervals, then Ctrl+C)
tokenctl watch EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v --record --interval 30

# This creates: ./tokenctl-runs/raw/2025-01-15T10-30-00-000Z/
#   - interval-1-1705312200000.json
#   - interval-2-1705312230000.json
#   - interval-3-1705312260000.json

# Step 2: Replay the recorded session (offline, no RPC)
tokenctl watch EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v --replay ./tokenctl-runs/raw/2025-01-15T10-30-00-000Z/

# Step 3: Verify determinism - run replay twice and compare outputs
tokenctl watch EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v --replay ./tokenctl-runs/raw/2025-01-15T10-30-00-000Z/ --json > replay1.json
tokenctl watch EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v --replay ./tokenctl-runs/raw/2025-01-15T10-30-00-000Z/ --json > replay2.json
diff replay1.json replay2.json  # Should be identical
```

## Integrity Checks

The system validates interval data integrity:

1. **dominant_share** must be in [0, 100]
2. **transfers** and **unique_wallets** must be non-negative integers
3. **avg_size = 0** when transfers = 0
4. **volume = 0** when transfers = 0
5. **Supply changes** require mint or burn events

If integrity checks fail:
- Interval is marked as `partial: true`
- `data_integrity` alert is emitted
- Baseline is **not updated** (prevents poisoning)

Example alert:
```
[2025-01-15 10:30:00Z] ALERT data_integrity Supply increased from 1000000 to 2000000 but no mint events found
```

## Determinism

The system ensures determinism:
- Same recording → identical `IntervalResult` hashes
- Same recording → identical `AppState` hashes
- Verified by unit tests in `test/record-replay.test.js`

Run tests:
```bash
npm test -- test/record-replay.test.js
```

## File Structure

```
./tokenctl-runs/
  raw/
    2025-01-15T10-30-00-000Z/
      interval-1-1705312200000.json
      interval-2-1705312230000.json
      interval-3-1705312260000.json
```

Each interval file contains:
```json
{
  "timestamp": "2025-01-15 10:30:00Z",
  "checkCount": 1,
  "signatures": ["sig1", "sig2", ...],
  "transactions": [...],
  "events": [
    {
      "type": "transfer",
      "source": "A...",
      "destination": "B...",
      "amount": 100,
      "signature": "sig1"
    }
  ],
  "supply": 1000000
}
```

## Notes

- Recordings are saved per-interval, not as a single file
- Replay mode supports both directory and single-file formats
- No RPC calls are made in replay mode
- TUI layout is unchanged
- Alert logic and performance code are unchanged

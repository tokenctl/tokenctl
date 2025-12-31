# tokenctl v1.3.0 Release Notes

## Overview

tokenctl v1.3.0 extends the `watch` command into a comprehensive behavioral security monitoring tool. This release adds baseline behavior tracking, behavioral drift detection, wallet role change monitoring, dormant wallet activation alerts, and structural security analysis.

## New Features

### Behavioral Security Monitoring

The `watch` command now tracks baseline behavior and detects anomalies:

#### Baseline Behavior Tracking

After 3 intervals, establishes rolling baseline for:
- **transfers_per_interval**: Average number of transfers per monitoring interval
- **avg_transfer_size**: Average size of transfers
- **unique_wallets_per_interval**: Average number of unique wallets transacting
- **dominant_wallet_share**: Average share of volume controlled by top wallet

Baseline status is shown as "forming" (1-2 intervals) or "established" (3+ intervals).

#### Behavioral Drift Alerts

Detects when behavior deviates materially from baseline:
- **transfer_rate_spike**: Transfer count exceeds baseline by >2x (or >1.5x in strict mode)
- **volume_spike**: Average transfer size exceeds baseline by >2x (or >1.5x in strict mode)
- **counterparties_spike**: Unique wallet count exceeds baseline by >2x (or >1.5x in strict mode)

Each drift alert includes:
- Baseline status (forming | established)
- Signal confidence score (0.00-1.00)
- Brief explanation with percentage deviation

#### Role Change Detection

Tracks wallet roles per interval using the same heuristics as `tx` command:
- **Distributor**: High outbound, negative net flow, top volume
- **Accumulator**: High inbound, positive net flow, top 3 by inbound
- **Relay**: High volume, balanced flow, 3+ counterparties
- **Sink**: High inbound, zero outbound
- **Dormant Whale**: Large balance, no activity

Alerts when:
- Wallet changes role (e.g., `Accumulator -> Distributor`)
- New Distributor appears (potential distribution event)

#### Dormant Wallet Activation

Detects wallets that had no activity in prior intervals but suddenly transact above threshold:
- Tracks all wallets that have been active in any previous interval
- Alerts when previously inactive wallet transacts above threshold
- Threshold: `--transfer-threshold` (or 50% of threshold in strict mode)

#### Structural Security Alerts

- **first_dex_interaction**: First detection of known DEX program (Raydium, Jupiter, Orca) in transactions
- **dominant_wallet_share**: Single wallet controls >60% of interval volume (or >50% in strict mode)
- **authority_activity_coincidence**: Authority change coincided with >1.5x increase in transfer activity

### New Command Flags

- **`--strict`**: Use stricter thresholds for behavioral drift detection (1.5x instead of 2x baseline multiplier)
- **`--quiet`**: Only print alerts, suppress interval summaries and baseline status
- **`--json`**: Output structured JSON alert events (one JSON object per line)

### Output Format

#### Standard Output

Interval summaries show:
- Check number, token name, supply, authority status
- Baseline status (forming/established) with metrics
- Current interval metrics (transfers, wallets)

Alerts follow format:
```
[timestamp] ALERT <type> <details>
  Baseline: <status>, Confidence: <score>
```

#### JSON Output

Each alert is a JSON object:
```json
{"timestamp":"2025-01-01 12:00:00","type":"behavior_drift","drift_type":"transfer_rate_spike","explanation":"...","baseline_status":"established","confidence":0.85}
```

### Technical Details

- **No new RPC calls**: Reuses existing `getSignaturesForAddress` and `getTransaction` calls
- **Deterministic behavior**: All calculations are deterministic, no randomness
- **Lightweight**: Minimal CPU and memory overhead, suitable for long-running sessions
- **No persistence**: All state maintained in memory during session
- **No financial advice**: All alerts use neutral language, no buy/sell signals

## Improvements

- Enhanced error handling for network/RPC errors with cleaner messages
- Improved transaction parsing with fallback to `json` encoding when `jsonParsed` fails
- Better integration with existing `tx` analytics for role classification
- Token name display in monitoring output and alerts

## Breaking Changes

None. All existing `watch` command usage remains compatible.

## Migration Guide

No migration needed. New features are opt-in via flags:
- Default behavior unchanged (baseline tracking happens automatically)
- Use `--strict` for more sensitive detection
- Use `--quiet` for alert-only output
- Use `--json` for programmatic monitoring

## Examples

```bash
# Standard monitoring with baseline tracking
tokenctl watch EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v

# Strict mode with quieter output
tokenctl watch EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v --strict --quiet

# JSON output for monitoring systems
tokenctl watch EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v --json | jq '.type'
```

## Testing

Unit tests added for:
- Baseline formation and computation
- Behavioral drift detection (normal and strict modes)
- Role change detection
- Dormant wallet activation
- Signal confidence calculation
- Structural security alert detection

All tests use synthetic data, no RPC calls required.

## Version

- **Previous**: v1.2.0
- **Current**: v1.3.0


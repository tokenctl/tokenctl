# Alert Quality Implementation Report

## Overview
Implemented comprehensive alert deduplication, severity tiers, and numeric confidence scoring to improve alert quality and reduce spam.

## Files Changed

1. **src/utils/watch-state.js**
   - Updated `generateAlertId()` to use SHA-256 hash of `type + wallet + condition_key`
   - Enhanced `calculateConfidence()` with baseline delta percentage and duration scaling
   - Improved `processAlerts()` for deduplication with severity and condition worsening checks
   - Updated `updateStateFromInterval()` to skip baseline learning for partial/integrity-failed intervals
   - Fixed `processAlerts()` to use `_internal.alertHistory` (per user's architecture)

2. **src/utils/watch-analytics.js**
   - Updated `detectDrift()` to prevent drift alerts for zero-transfer intervals
   - Added `condition_key` to all structural alerts in `detectStructuralAlerts()`

3. **src/utils/watch-core-v2.js**
   - Added `condition_key` to all alert types (authority_change, supply_change, mint_event, large_transfer, data_integrity, role_change, dormant_activation)

## Exact Confidence Formula

Confidence is calculated as: **baseConfidence + durationBonus**, clamped to [0.0, 1.0]

### Base Confidence Calculation

**If baseline not established:**
```
confidence = 0.3
```

**For behavior_drift alerts:**
```
delta = |currentValue - baselineValue| / baselineValue
baseConfidence = min(0.8, 0.4 + (delta * 0.4))
```

**For dominant_wallet_share alerts:**
```
share = parseFloat(alert.share)  // 0-1 range
baseConfidence = min(0.8, 0.5 + (share * 0.3))
```

**For authority_change or supply_change alerts:**
```
baseConfidence = 0.9
```

**For all other alerts:**
```
baseConfidence = 0.6
```

### Duration Bonus

```
durationBonus = min(0.2, durationIntervals * 0.05)
```

- Each interval the alert persists adds 0.05 to confidence
- Maximum duration bonus is 0.2 (achieved after 4 intervals)
- Duration resets if severity decreases

### Final Formula

```
confidence = max(0.0, min(1.0, baseConfidence + durationBonus))
```

**Example:**
- Behavior drift with 3x baseline spike (delta = 2.0)
- Base confidence = min(0.8, 0.4 + (2.0 * 0.4)) = 0.8
- After 3 intervals: durationBonus = min(0.2, 3 * 0.05) = 0.15
- Final confidence = min(1.0, 0.8 + 0.15) = 0.95

## Severity Tiers

### Critical
- **authority_change**: Mint or freeze authority changes
- **supply_change**: Token supply changes

### Warning
- **large_transfer**: Transfer exceeds `--transferThreshold`
- **mint_event**: Mint exceeds `--mintThreshold`
- **dominant_wallet_share**: Share ≥ 80%

### Watch
- **behavior_drift**: Transfer rate, volume, or counterparties spike >2x baseline (or >1.5x in strict mode)
- **dominant_wallet_share**: Share ≥ 60% but < 80%

### Info
- **role_change**: Wallet role changes (Distributor/Accumulator/Relay/Sink)
- **dormant_activation**: Previously inactive wallet activates with significant amount
- **first_dex_interaction**: First DEX program interaction detected
- **data_integrity**: Data validation failures

## How to Trigger Each Severity Level

### Critical Alerts

**1. Authority Change (critical)**
```bash
# Monitor a token, then change its mint authority or freeze authority
tokenctl live <mint_address>
# Authority change will be detected on next interval
```

**2. Supply Change (critical)**
```bash
# Monitor a token, then mint or burn tokens
tokenctl live <mint_address>
# Supply change will be detected on next interval
```

### Warning Alerts

**3. Large Transfer (warning)**
```bash
# Monitor token with --transferThreshold set low (e.g., 1000)
tokenctl live <mint_address> --transferThreshold 1000
# Execute a transfer > 1000 tokens
```

**4. Mint Event (warning)**
```bash
# Monitor token with --mintThreshold set low (e.g., 1000)
tokenctl live <mint_address> --mintThreshold 1000
# Execute a mint > 1000 tokens
```

**5. Dominant Wallet Share ≥ 80% (warning)**
```bash
# Monitor token where single wallet controls ≥80% of interval volume
tokenctl live <mint_address>
# Wait for interval where one wallet does most transfers
```

### Watch Alerts

**6. Behavior Drift - Transfer Rate Spike (watch)**
```bash
# After baseline established (3+ intervals), spike transfer activity >2x baseline
tokenctl live <mint_address>
# Wait for baseline, then execute many transfers in one interval
```

**7. Behavior Drift - Volume Spike (watch)**
```bash
# After baseline established, execute transfers with avg size >2x baseline
tokenctl live <mint_address>
# Wait for baseline, then execute large transfers
```

**8. Behavior Drift - Counterparties Spike (watch)**
```bash
# After baseline established, spike unique wallets >2x baseline
tokenctl live <mint_address>
# Wait for baseline, then execute transfers from many new wallets
```

**9. Dominant Wallet Share 60-80% (watch)**
```bash
# Monitor token where single wallet controls 60-80% of interval volume
tokenctl live <mint_address>
# Wait for interval where one wallet does 60-80% of transfers
```

### Info Alerts

**10. Role Change (info)**
```bash
# Monitor token, wait for wallet to change role classification
tokenctl live <mint_address>
# Wallet transitions between Distributor/Accumulator/Relay/Sink
```

**11. Dormant Activation (info)**
```bash
# Monitor token, wait for previously inactive wallet to activate
tokenctl live <mint_address> --transferThreshold 1000
# Wallet that hasn't been active activates with transfer > threshold
```

**12. First DEX Interaction (info)**
```bash
# Monitor new token, wait for first DEX program interaction
tokenctl live <mint_address>
# Execute first swap/transfer through DEX program
```

**13. Data Integrity (info)**
```bash
# Triggered automatically when interval data fails validation
# Examples: dominant_share out of range, negative transfers, etc.
```

## Deduplication Logic

Alerts are deduplicated using stable `alert_id` (hash of `type + wallet + condition_key`).

**Suppression Rules:**
- Alert is suppressed if:
  - Same `alert_id` exists in history
  - Current severity ≤ last severity
  - Condition has NOT worsened numerically

**Alert is NOT suppressed if:**
- Severity increases (e.g., watch → warning)
- Condition worsens numerically (e.g., share increases from 0.65 to 0.75)
- First occurrence of this alert_id

**Duration Tracking:**
- Duration increments each interval the alert persists
- Duration resets if severity decreases
- Duration affects confidence calculation (up to +0.2 bonus)

## Normalization

### Dominant Wallet Share
- **Clamped to [0, 100]** via `normalizeDominantShare()` function
- Applied in:
  - `currentInterval.dominantWalletShare` (line 508)
  - `series.dominantShare` (line 432)
- Baseline stores as ratio (0-1), which is correct

### Zero-Transfer Intervals
- **No drift alerts** emitted when `transfers_per_interval === 0`
- Prevents false positives during inactive periods
- Implemented in `detectDrift()` function

## Baseline Learning

Baseline learning is **skipped** for:
- Partial intervals (`isFine === false`)
- Integrity-failed intervals (`integrity.valid === false`)

**Implementation:**
```javascript
if (isFine && integrity.valid) {
  // Only update baseline here
  intervalMetrics.push(metrics);
  // ... baseline computation
}
```

This ensures baseline is only computed from verified, complete interval data.

## Testing Recommendations

1. **Test deduplication**: Generate same alert twice, verify suppression**
2. **Test severity escalation**: Trigger same alert with worsening condition**
3. **Test confidence**: Verify confidence increases with duration**
4. **Test zero-transfer**: Verify no drift alerts during inactive periods**
5. **Test baseline skip**: Verify baseline doesn't update on partial intervals**

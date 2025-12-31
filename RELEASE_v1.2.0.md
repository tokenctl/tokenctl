# tokenctl v1.2.0 Release Notes

## Overview

tokenctl v1.2.0 adds comprehensive analytics to the `tx` command, providing behavioral insights and pattern detection from observed token transfers. This release includes wallet role classification, pattern labeling, signal strength analysis, and machine-readable JSON output.

## New Features

### Analytics Flags for `tx` Command

- **`--story`**: Prints a compact 2-4 sentence summary of observed transfer behavior
- **`--interpret`**: Shows pattern classification with likely scenarios:
  - Concentrated Distribution
  - Consolidation
  - Churn
  - Quiet
  - Mixed Activity
- **`--roles`**: Classifies key wallets by behavioral role:
  - **Distributor**: High outbound activity, negative net flow, top volume
  - **Accumulator**: High inbound activity, positive net flow, top 3 by inbound
  - **Relay**: High volume with balanced flow (net flow ≤10% of total), 3+ counterparties
  - **Sink**: High inbound with zero outbound
  - **Dormant Whale**: Large balance but no activity in time window
- **`--signal`**: Displays feature ratings and confidence score:
  - Feature ratings: Observed Transfers, Wallet Concentration, Time Clustering (Low/Medium/High)
  - Confidence score: 0.00 to 1.00 based on event count, data completeness, and volume diversity
- **`--all`**: Enables all analytics sections (equivalent to `--story --interpret --roles --signal`)
- **`--json`**: Outputs machine-readable JSON document with events and analytics

### Wallet Statistics

For each wallet address, the analytics compute:
- `inbound_count`, `outbound_count`: Transaction counts
- `inbound_total`, `outbound_total`: Total amounts
- `net_flow`: Inbound minus outbound
- `total_volume`: Inbound plus outbound
- `unique_counterparties`: Number of unique addresses interacted with
- `burstiness`: Time clustering score (0-1)

### Pattern Detection

The system automatically detects transfer patterns:
- **Concentrated Distribution**: Single dominant distributor sending to 2+ recipients in clustered time periods
- **Consolidation**: Multiple sources feeding into primary accumulator
- **Churn**: Multiple relays with high volume and near-zero net flows
- **Quiet**: Low event count with no dominant actors

### Context Detection

Automatically detects known DEX programs in transactions (Raydium, Jupiter, Orca) and displays them in an optional Context section when detected.

## Technical Details

- **No new RPC calls**: All analytics derived from existing transaction data
- **Deterministic**: Results are consistent across runs with identical data
- **Lightweight**: Analytics computation adds minimal overhead
- **Backward compatible**: Default behavior unchanged, analytics only shown when flags are used

## Output Format

Analytics sections are appended after the Summary section in this order:
1. Story (if `--story` or `--all`)
2. Interpretation (if `--interpret` or `--all`)
3. Wallet Roles (if `--roles` or `--all`)
4. Signal Strength (if `--signal` or `--all`)
5. Context (optional, only if DEX programs detected)

## JSON Output

The `--json` flag outputs a complete JSON document containing:
- `mint`: Token mint address
- `time_window`: Hours and cutoff time
- `events`: Array of transfer/mint events
- `wallet_stats`: Map of wallet statistics
- `roles`: Map of wallet addresses to roles
- `pattern_label`: Detected pattern
- `likely_scenarios`: Array of possible explanations
- `confidence`: Confidence score (0.00-1.00)
- `feature_ratings`: Object with feature ratings

## Migration Notes

No migration required. This is a drop-in update. Existing workflows continue to work unchanged. Analytics are opt-in via flags.

## Examples

```bash
# Basic usage (unchanged)
tokenctl tx <mint>

# Get all analytics
tokenctl tx <mint> --all

# Get JSON output for processing
tokenctl tx <mint> --json

# Individual sections
tokenctl tx <mint> --story --roles
```

## Known Limitations

- Analytics are based on observed transfers only (same limitations as base `tx` command)
- Role classification requires minimum activity thresholds
- Pattern detection may not capture all complex behaviors
- Confidence scores are estimates based on data quality and completeness






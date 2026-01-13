# tokenctl

A fast, deterministic Solana token snapshot CLI utility (v1.1). Provides on-chain token analysis without financial advice or audit claims.

## Installation

### From GitHub

```bash
git clone <repository-url>
cd tokenctl
npm install
npm link
```

This will make `tokenctl` available globally in your terminal.

## RPC Configuration

**Important**: The default public RPC is heavily rate limited. For reliable operation, use a dedicated RPC endpoint.

### Setting Your RPC Endpoint

You can configure your RPC endpoint in three ways (priority order):

1. **Config file** (Recommended - persistent across sessions)
   ```bash
   echo "RPC=https://your-rpc-endpoint.com" > ~/.tokenctlrc
   ```

2. **Environment variable** (Current session or permanent)
   ```bash
   export TOKENCTL_RPC=https://your-rpc-endpoint.com
   # Or add to ~/.bashrc/~/.zshrc for permanent
   ```

3. **Command line flag** (Overrides everything)
   ```bash
   tokenctl scan <mint> --rpc https://your-rpc-endpoint.com
   ```

**Priority**: `--rpc` flag > `TOKENCTL_RPC` env var > `~/.tokenctlrc` config file > default

**Rate Limiting**: The tool includes delays and retries, but public RPCs may still throttle requests. Use a dedicated RPC endpoint for best performance.

## Commands

### `tokenctl rpc`

**What it does**: Tests your RPC endpoint connection and measures response latency. Useful for verifying your RPC is working before running other commands.

**When to use**: 
- Before running scans to verify RPC connectivity
- When troubleshooting connection issues
- To compare latency between different RPC endpoints

```bash
tokenctl rpc
tokenctl rpc --rpc https://your-rpc-endpoint.com
```

Output:
```
RPC: https://your-rpc-endpoint.com
Slot: 123456789
Status: OK (245ms)
```

### `tokenctl scan <mint>`

**What it does**: Performs a deterministic on-chain snapshot of a token. Fetches token metadata (name from Metaplex or Token 2022), supply, authority status, recent activity, and provides a risk verdict. **Holder distribution is NOT included by default** to keep it fast - use `--holders` flag for that.

**When to use**:
- Quick token health check (default, fast)
- Full analysis including holder distribution (`--holders` flag, slower)
- Before trading or investing in a token
- To verify token properties match expectations

**What it shows**:
- **Token**: Mint address, name (if available), total supply with decimals, raw supply amount
- **Authorities**: Whether mint authority and freeze authority are revoked or still active
- **Distribution**: Total holder count, top 1% concentration, top 10% concentration (only with `--holders`)
- **Activity**: Observed mint events and transfers in last 24 hours (sampled, not comprehensive). Note: Activity reflects mint-level interactions, not DEX trading volume.
- **Verdict**: CLEAN / WATCH / RISKY classification with reasoning

```bash
# Quick scan (fast, no holders)
tokenctl scan EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v

# Full scan with holder distribution (slower)
tokencl scan EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v --holders

# Scan with more activity history
tokenctl scan EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v --sig-limit 20
```

Example output:
```
Token
  Address: CQ1eU5VLsw2WyaDgVJPDBb1RyroeZoJaMeRaNkwtpump
  Name: unknown
  Symbol: unknown
  Supply: 999,956,503,587,000 (6 decimals)

Authorities
  Mint Authority: revoked
  Freeze Authority: revoked

Distribution
  unavailable (use --holders flag to include)

Activity
  [observed - last 24h, not comprehensive]
  Mint Events: 0
  Transfers: 0

Verdict
  CLEAN
  Mint and freeze authorities revoked with no observed mint activity in 24h
```

**Understanding Verdicts**:

The `scan` command provides a risk classification based on on-chain data:

- **CLEAN** (Green): Lowest risk indicators
  - Mint and freeze authorities are revoked (cannot mint new tokens or freeze accounts)
  - No observed mint activity in the last 24 hours
  - Reasonable holder distribution (not extremely concentrated)
  - **Note**: This does not guarantee safety, only that basic on-chain indicators are positive

- **WATCH** (Yellow): Requires monitoring
  - Active mint or freeze authority exists (can mint new tokens or freeze accounts)
  - High top 10 holder concentration (>90%)
  - Low holder count (<100 holders)
  - Other factors that warrant caution
  - **Note**: Many legitimate tokens may have active authorities during initial distribution

- **RISKY** (Red): High risk indicators
  - Very few holders (<10) with high concentration (top 10 >30% or top 1 >15%) - classic scam pattern
  - Low holder count (<100) with very high concentration (top 10 >30% with <50 holders, or top 10 >50% with <100 holders)
  - Active mint authority with high top holder concentration (>50%) or recent mint events
  - **Warning**: These patterns are commonly associated with rug pulls and scams

**Important**: Verdicts are based solely on on-chain data analysis and are not financial advice. Always conduct your own research and due diligence.

### `tokenctl report <mint>`

**What it does**: Generates a compact, single-block text report with all key token information. Designed for easy copy-paste into Telegram, Discord, or other chat platforms.

**When to use**:
- Sharing token analysis in chat groups
- Quick reference format
- When you need a condensed summary

**What it shows**: Token name, mint address, supply, authority status, holder concentration, activity, and verdict in a compact format.

```bash
tokenctl report EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v
```

Output is a compact text block suitable for copy-paste sharing.

### `tokenctl holders <mint>`

**What it does**: Analyzes token holder distribution by querying all token accounts for the mint. Uses `getTokenLargestAccounts` for fast top holder analysis and `getProgramAccounts` for total holder count. This is a separate command because it's a heavy operation that can hit rate limits on public RPCs.

**When to use**:
- Analyzing token concentration and whale holdings
- Checking if a token is heavily concentrated
- Verifying holder distribution claims
- When you need detailed holder data separate from the main scan

**What it shows**:
- Total number of unique holders (accounts with balance > 0)
- Top 1% holder concentration percentage
- Top 10% holder concentration percentage
- Optionally lists top account addresses with `--list` flag

```bash
# Basic holder analysis
tokenctl holders EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v

# Show top 20 holders
tokenctl holders EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v --top 20

# List top account addresses
tokenctl holders EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v --list

# Scan more accounts (slower but more complete)
tokenctl holders EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v --max-accounts 10000
```

### `tokenctl tx <mint>`

**What it does**: Observes recent on-chain token transfers by scanning transaction history from the top token accounts for the mint. Detects SPL token `transfer`, `transferChecked`, `mintTo`, and `mintToChecked` instructions by analyzing balance deltas and parsed instructions from transactions. **This is NOT a DEX trading history** - it shows raw token movements between accounts, complementing tools like Dexscreener which focus on swap activity.

**When to use**:
- Observing actual token transfers between accounts
- Analyzing wallet behavior patterns
- Understanding token distribution and accumulation
- Detecting suspicious activity patterns
- Verifying token movement activity from top holders
- Investigating raw token account transfers (not DEX swaps)
- Understanding token flow patterns from largest accounts

**What it shows**:
- Observed SPL token transfers with amounts, source addresses, destination addresses, timestamps, and transaction signatures
- Observed mint events with amounts and destination addresses
- Events are derived from transactions involving the top N token accounts (configurable with `--accounts`)
- **Important**: This is observed data from a sample of top accounts, not comprehensive. Many transfers may not appear, especially those involving smaller accounts or older transactions that are archived.

**How it works**:
- Queries the top N largest token accounts using `getTokenLargestAccounts`
- Collects transaction signatures from those accounts using `getSignaturesForAddress`
- Fetches and parses transactions to detect transfers via:
  - Token balance deltas (`preTokenBalances` / `postTokenBalances`)
  - Parsed SPL token instructions (`transfer`, `transferChecked`, `mintTo`, `mintToChecked`)
- Deduplicates events to show each transfer once

**Output format**:
```
Token
  Address: <mint>
  
Activity
  [observed - from top N token accounts, last H hours, not comprehensive]
  
  2025-12-23 20:50:17Z
  Type:    Transfer
  Amount:  2556.277882
  From:    <full source address>
  To:      <full destination address>
  Sig:     <full transaction signature>
  
  [additional events...]
  
Summary
  Transfers: X
  Mint Events: Y
```

```bash
# Recent activity (last 24 hours, 10 signatures, top 8 accounts)
tokenctl tx EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v

# More history (48 hours, 20 signatures, top 12 accounts)
tokenctl tx EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v --limit 20 --hours 48 --accounts 12

# Show more events in output
tokenctl tx EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v --show 20

# Analytics flags - get behavioral insights
tokenctl tx EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v --story
tokenctl tx EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v --interpret
tokenctl tx EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v --roles
tokenctl tx EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v --signal

# Enable all analytics sections
tokenctl tx EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v --all

# JSON output for machine processing
tokenctl tx EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v --json
```

**Analytics Flags** (v1.2.0+):

The `tx` command includes optional analytics to help understand transfer patterns:

- `--story`: Prints a compact 2-4 sentence summary of observed behavior
- `--interpret`: Shows pattern classification (Concentrated Distribution, Consolidation, Churn, Quiet) with likely scenarios
- `--roles`: Classifies key wallets by behavioral role (see "Understanding Wallet Roles" below)
- `--signal`: Displays feature ratings (Observed Transfers, Wallet Concentration, Time Clustering) and confidence score (0.00-1.00)
- `--all`: Enables all analytics sections (equivalent to `--story --interpret --roles --signal`)
- `--json`: Outputs machine-readable JSON with events and analytics data

**Understanding Wallet Roles**:

Wallet roles are automatically classified based on observed transfer behavior in the time window:

- **Distributor**: 
  - Criteria: ≥3 outbound transactions, negative net flow (sends more than receives), top volume sender
  - Indicates: Controlled distribution, airdrops, treasury operations, or selling activity
  - Example: A wallet that sends tokens to multiple recipients but receives little or nothing back

- **Accumulator**: 
  - Criteria: ≥3 inbound transactions, positive net flow (receives more than sends), top 3 by inbound volume
  - Indicates: Accumulation, buying activity, or consolidation behavior
  - Example: A wallet that receives tokens from multiple sources, building up a position

- **Relay**: 
  - Criteria: High total volume, balanced flow (net flow ≤10% of total volume), ≥3 unique counterparties
  - Indicates: Routing activity, market making, intermediary operations, or token forwarding
  - Example: A wallet that moves tokens through but maintains relatively balanced inflows and outflows

- **Sink**: 
  - Criteria: High inbound volume, zero outbound transactions
  - Indicates: Final destination wallets that receive tokens but don't send them
  - Example: A wallet that accumulates tokens without redistributing them

- **Dormant Whale**: 
  - Criteria: Large balance holder (appears in top token accounts) but zero activity in the observed time window
  - Indicates: Inactive large holders who haven't moved tokens during the observation period
  - Example: A top holder that hasn't transacted in the last 24 hours (or specified time window)

Note: A wallet may not be assigned any role if it doesn't meet the criteria for classification. Roles are based on observed behavior only and do not indicate financial advice or investment signals.

**Example with `--all`**:
```
Token
  Address: <mint>

Activity
  [observed - from top 8 token accounts, last 24h, not comprehensive]
  
  [transfer events...]

Summary
  Transfers: 10
  Mint Events: 0

Story
  Dominant wallet ABC... distributed 124,250 tokens to 2 recipients. Activity was clustered within 2.3 hours. Movement appears concentrated from a single source.

Interpretation
  Pattern: Concentrated Distribution
  
  Likely Scenarios:
    • Controlled distribution
    • Airdrop or reward distribution
    • Treasury rebalance

Wallet Roles
  Distributor: ABC...
    Volume: 124,250.83 | Net: -124,250.83 | Counterparties: 2
    (High outbound activity, negative net flow, top volume sender)
  
  Accumulator: XYZ...
    Volume: 88,329.60 | Net: +88,329.60 | Counterparties: 1
    (High inbound activity, positive net flow, top 3 by inbound)
  
  Relay: DEF...
    Volume: 200,000.00 | Net: +5,000.00 | Counterparties: 5
    (High volume with balanced flow, multiple counterparties)
  
  Sink: GHI...
    Volume: 50,000.00 | Net: +50,000.00 | Counterparties: 1
    (High inbound, zero outbound - final destination)

Signal Strength
  Feature Ratings:
    Observed Transfers: Medium
    Wallet Concentration: High
    Time Clustering: High
  
  Confidence: 0.65
```

**Limitations**:
- **Not comprehensive**: Only shows transfers observed from top token accounts in the specified time window
- **Not DEX trading data**: Shows raw token transfers, not swap transactions or trading volume
- **Archived transactions**: Older transactions may not be available from public RPCs
- **Large holder tokens**: Tokens with extremely large holder counts (like USDC with 200M+ holders) may fail on public RPCs
- **RPC dependency**: Requires an RPC endpoint with transaction history support for best results
- Default limits: `--limit` max 50, `--accounts` max 20

### `tokenctl watch <mint>`

**What it does**: Behavioral security monitoring tool that continuously monitors a token for changes using polling. Tracks baseline behavior, detects behavioral drift, role changes, dormant wallet activations, and structural security issues.

**When to use**:
- Monitoring a token for security anomalies
- Alerting on authority changes (potential rug pull)
- Tracking supply changes (new mints)
- Detecting unusual transfer patterns or behavioral drift
- Monitoring wallet role changes and dormant activations
- Watching for first DEX interactions and structural security issues

**What it monitors**:
- **Authority changes**: Alerts if mint or freeze authority changes (potential red flag)
- **Supply changes**: Alerts when total supply increases or decreases
- **Large transfers**: Alerts when transfers exceed your threshold
- **Mint events**: Alerts when new tokens are minted above your threshold
- **Behavioral drift**: Detects when transfer rate, volume, or counterparties spike >2x baseline
- **Role changes**: Alerts when wallet roles change (e.g., Accumulator → Distributor)
- **Dormant activations**: Detects wallets that were inactive but suddenly transact
- **Structural security**: First DEX interactions, dominant wallet share, authority+activity coincidences

**Baseline behavior**: After 3 intervals, establishes rolling baseline for:
- Transfers per interval
- Average transfer size
- Unique wallets per interval
- Dominant wallet share

**Alerts**:
- `ALERT authority_change` - Mint or freeze authority changed
- `ALERT supply_change` - Total supply changed (highlighted in red)
- `ALERT large_transfer` - Transfer above threshold detected
- `ALERT mint_event` - Mint event above threshold detected
- `ALERT behavior_drift <type>` - Behavioral deviation from baseline (transfer_rate_spike, volume_spike, counterparties_spike)
- `ALERT role_change <wallet> <old_role> -> <new_role>` - Wallet role changed
- `ALERT dormant_activation <wallet> <amount>` - Previously inactive wallet activated
- `ALERT first_dex_interaction` - First DEX program interaction detected
- `ALERT dominant_wallet_share` - Single wallet controls >60% of interval volume
- `ALERT authority_activity_coincidence` - Authority change coincided with activity spike

**Flags**:
- `--strict` - Use stricter thresholds (1.5x instead of 2x for drift detection)
- `--quiet` - Only print alerts, suppress interval summaries
- `--json` - Output structured JSON alert events

Press `Ctrl+C` to stop monitoring.

```bash
# Basic monitoring (30 second intervals)
tokenctl watch EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v

# Strict mode with quieter output
tokenctl watch EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v --strict --quiet

# JSON output for programmatic monitoring
tokenctl watch EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v --json

# Custom thresholds
tokenctl watch EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v --transfer-threshold 5000000 --mint-threshold 1000000
```

### `tokenctl live <mint>`

**What it does**: Full-screen TUI (Terminal User Interface) dashboard for behavioral security monitoring. Provides a Cloudflare-style dashboard with real-time charts, alerts table, and interval summaries. Uses the same underlying analytics as `watch` but presents data in a visual, at-a-glance format.

**When to use**:
- Visual monitoring of token behavior over time
- Tracking multiple metrics simultaneously (transfers, wallets, volume, roles)
- Quick overview of recent alerts and current state
- Situations where you want to see trends and patterns visually

**Dashboard Layout**:
- **Top Bar**: Token name, mint address, interval, baseline status, RPC host
- **Row 1 Charts**: Transfers per interval (left), Unique wallets per interval (right) - rolling 30 point window
- **Row 2 Charts**: Avg transfer size (left), Dominant wallet share (right) - rolling 30 point window
- **Alerts Table**: Most recent 20 alerts with time, type, details, confidence
- **Current Interval Summary**: Transfers count, mint events, total volume, unique wallets, supply, authority status, refresh duration
- **Wallet Roles Summary**: Classified wallets (Distributor, Accumulator, Relay, Sink, Dormant Whale) with volume, net flow, counterparties
- **Footer**: Status (running/paused), last update time, autosave status, last save path

**Keyboard Controls**:
- `q` or `ESC` or `Ctrl+C` - Quit and restore terminal
- `p` - Pause/Resume data polling (freezes charts when paused)
- `r` - Force immediate refresh (run interval now)
- `s` - Save snapshot to `./tokenctl-runs/` directory
- `tab` - Cycle focus between panels (visual navigation)
- `?` - Toggle help overlay

**Autosave**: By default, snapshots are automatically saved to `./tokenctl-runs/` directory after each interval. Each snapshot is a timestamped JSON file containing:
- Series data (transfers, wallets, avg size, dominant share arrays)
- Current interval metrics
- Roles summary
- All alerts
- Baseline status

Disable autosave with `--no-autosave` flag.

**Terminal Requirements**: Minimum terminal size 120x30. If terminal is too small, a warning screen is displayed with required dimensions.

**Flags**:
- `--rpc <url>` - RPC endpoint URL (overrides config/env)
- `--interval <seconds>` - Polling interval in seconds (default: 30)
- `--transfer-threshold <number>` - Alert threshold for large transfers (default: 1000000)
- `--mint-threshold <number>` - Alert threshold for mint events (default: 1000000)
- `--strict` - Use stricter thresholds for behavioral drift detection (1.5x instead of 2x)
- `--no-autosave` - Disable automatic snapshot saving (default: autosave enabled)

**Note**: All data shown is observed from top token accounts only, not comprehensive. No financial advice is provided. The dashboard uses the same analytics logic as `watch` command.

```bash
# Launch dashboard (default 30s interval, autosave enabled)
tokenctl live EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v

# Custom interval, strict mode, no autosave
tokenctl live EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v --interval 60 --strict --no-autosave

# Custom thresholds
tokenctl live EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v --transfer-threshold 5000000
```

## Options

### Global Options

- `--rpc <url>` - Override RPC endpoint (highest priority)
- `TOKENCTL_RPC` - Environment variable for RPC endpoint
- `~/.tokenctlrc` - Config file with `RPC=https://...` line

### Command-Specific Options

**scan:**
- `--sig-limit <number>` - Number of signatures to fetch for activity (default: 10)
- `--holders` - Include holder distribution (heavy operation, off by default)
- `--max-accounts <number>` - Maximum accounts to scan for holders (default: 5000)

**holders:**
- `--top <number>` - Number of top holders to show (default: 10)
- `--max-accounts <number>` - Maximum accounts to scan (default: 5000)

**tx:**
- `--limit <number>` - Number of signatures to fetch (default: 10, max: 50)
- `--hours <number>` - Hours to look back (default: 24)
- `--accounts <number>` - Number of largest token accounts to scan (default: 8, max: 20)
- `--show <number>` - Number of events to display (default: 10)

**watch:**
- `--interval <seconds>` - Polling interval in seconds (default: 30)
- `--transfer-threshold <number>` - Large transfer threshold (default: 1000000)
- `--mint-threshold <number>` - Mint event threshold (default: 1000000)
- `--strict` - Use stricter thresholds for behavioral drift (1.5x instead of 2x)
- `--quiet` - Only print alerts, suppress interval summaries
- `--json` - Output structured JSON alert events

**live:**
- `--interval <seconds>` - Polling interval in seconds (default: 30)
- `--transfer-threshold <number>` - Large transfer threshold (default: 1000000)
- `--mint-threshold <number>` - Mint event threshold (default: 1000000)
- `--strict` - Use stricter thresholds for behavioral drift (1.5x instead of 2x)
- `--no-autosave` - Disable automatic snapshot saving (default: autosave enabled)

## Performance & Limits

- **Holder scanning is off by default** in `scan` to avoid rate limits
- Default `--sig-limit` is 10 to reduce RPC calls
- Default `--max-accounts` is 5000 to balance speed and completeness
- Partial scan warnings appear when account limit is reached
- Rate limit errors show clear messages with retry suggestions
- All outputs are deterministic and copy-paste friendly

## Examples

```bash
# Quick health check
tokenctl rpc

# Full snapshot (fast, no holders)
tokenctl scan EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v

# Full snapshot with holders (slower)
tokenctl scan EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v --holders

# Compact report for sharing
tokenctl report EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v

# Check holder distribution separately
tokenctl holders EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v --top 5

# Recent transfer activity
tokenctl tx EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v --limit 10 --accounts 8

# Live monitoring (text mode)
tokenctl watch EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v --interval 60

# Live dashboard (TUI mode)
tokenctl live EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v
```

## Notes

- All activity data is "observed" and not comprehensive
- Distribution analysis may show "partial scan" if account limit is reached
- Verdicts are based on on-chain data only, not financial advice
- Use a reliable RPC endpoint for best performance
- Holder scanning is intentionally separate to avoid rate limits on public RPCs
- `tx` command shows raw token transfers, not DEX trading activity - use Dexscreener or similar tools for swap/trading data

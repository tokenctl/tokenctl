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
```

**Limitations**:
- **Not comprehensive**: Only shows transfers observed from top token accounts in the specified time window
- **Not DEX trading data**: Shows raw token transfers, not swap transactions or trading volume
- **Archived transactions**: Older transactions may not be available from public RPCs
- **Large holder tokens**: Tokens with extremely large holder counts (like USDC with 200M+ holders) may fail on public RPCs
- **RPC dependency**: Requires an RPC endpoint with transaction history support for best results
- Default limits: `--limit` max 50, `--accounts` max 20

### `tokenctl watch <mint>`

**What it does**: Continuously monitors a token for changes using polling. Checks authorities, supply, and recent transactions at regular intervals and alerts when significant events occur.

**When to use**:
- Monitoring a token you're interested in
- Alerting on authority changes (potential rug pull)
- Tracking supply changes (new mints)
- Watching for large transfers or mint events

**What it monitors**:
- **Authority changes**: Alerts if mint or freeze authority changes (potential red flag)
- **Supply changes**: Alerts when total supply increases or decreases
- **Large transfers**: Alerts when transfers exceed your threshold
- **Mint events**: Alerts when new tokens are minted above your threshold

**Alerts**:
- `ALERT authority_change` - Mint or freeze authority changed (potential rug pull warning)
- `ALERT supply_change` - Total supply changed (new mints or burns)
- `ALERT large_transfer` - Transfer above threshold detected
- `ALERT mint_event` - Mint event above threshold detected

Press `Ctrl+C` to stop monitoring.

```bash
# Basic monitoring (30 second intervals)
tokenctl watch EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v

# Slower polling (60 second intervals)
tokenctl watch EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v --interval 60

# Custom thresholds for alerts
tokenctl watch EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v --transfer-threshold 5000000 --mint-threshold 1000000
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

# Live monitoring
tokenctl watch EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v --interval 60
```

## Notes

- All activity data is "observed" and not comprehensive
- Distribution analysis may show "partial scan" if account limit is reached
- Verdicts are based on on-chain data only, not financial advice
- Use a reliable RPC endpoint for best performance
- Holder scanning is intentionally separate to avoid rate limits on public RPCs
- `tx` command shows raw token transfers, not DEX trading activity - use Dexscreener or similar tools for swap/trading data

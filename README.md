# tokenctl

A universal on-chain intelligence layer for Solana (v1.3.0). Provides deterministic token analysis, behavioral monitoring, and wallet classification without financial advice or audit claims.

## What's New in v1.3.0

- **Token-2022 Support**: Full compatibility with Token-2022 program across all commands
- **Live Progress Feedback**: Real-time per-transaction status for `tx` command
- **Configurable RPC Reliability**: `--timeout` and `--retries` options to handle slow endpoints
- **Debug Logging**: Clean TUI with diagnostics redirected to file

---

## Installation

### From GitHub

```bash
git clone <repository-url>
cd tokenctl
npm install
npm link
```

This makes `tokenctl` available globally in your terminal.

---

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

---

## Core Commands

### `tokenctl rpc`

Tests RPC endpoint connection and measures response latency.

```bash
tokenctl rpc
tokenctl rpc --rpc https://your-rpc-endpoint.com
```

**Use when:**
- Verifying RPC connectivity before running analysis
- Troubleshooting connection issues
- Comparing latency between different endpoints

---

### `tokenctl scan <mint>`

Performs a deterministic on-chain snapshot of a token. Fetches metadata, supply, authority status, recent activity, and provides a risk verdict.

**Holder distribution is OFF by default** to keep scans fast. Use `--holders` flag for distribution analysis.

```bash
# Quick scan (fast, no holders)
tokenctl scan EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v

# Full scan with holder distribution (slower)
tokenctl scan EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v --holders

# More activity history
tokenctl scan EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v --sig-limit 20
```

**What it shows:**
- **Token**: Mint address, name (Metaplex/Token-2022), supply
- **Authorities**: Mint and freeze authority status (revoked or active)
- **Distribution**: Holder count, top 1%/10% concentration (with `--holders`)
- **Activity**: Observed transfers and mint events (last 24h, sampled)
- **Verdict**: CLEAN / WATCH / RISKY classification

**Understanding Verdicts:**

- **CLEAN** (Green): Lowest risk indicators
  - Authorities revoked, no recent mint activity, reasonable distribution
  - Note: Does not guarantee safety, only positive on-chain indicators

- **WATCH** (Yellow): Requires monitoring
  - Active authorities, high concentration (>90%), low holder count (<100)
  - Note: Legitimate tokens may have active authorities during distribution

- **RISKY** (Red): High risk indicators
  - Very few holders with high concentration, active authorities with recent mints
  - Warning: Patterns commonly associated with rug pulls and scams

**Important**: Verdicts are based solely on on-chain data and are not financial advice. Always conduct your own research.

---

### `tokenctl report <mint>`

Generates a compact, single-block text report for easy copy-paste into chat platforms (Telegram, Discord).

```bash
tokenctl report EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v
```

---

### `tokenctl holders <mint>`

Analyzes token holder distribution. Separate command because it's a heavy operation that can hit rate limits.

```bash
# Basic holder analysis
tokenctl holders EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v

# Show top 20 holders
tokenctl holders EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v --top 20

# List top account addresses
tokenctl holders EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v --list
```

**What it shows:**
- Total unique holders (balance > 0)
- Top 1% and 10% concentration percentages
- Optional: Top account addresses with `--list`

---

### `tokenctl tx <mint>`

Observes recent on-chain token transfers by scanning transaction history from top token accounts. **NOT DEX trading history** - shows raw token movements, complementing tools like Dexscreener.

```bash
# Recent activity (last 24 hours, 10 signatures, top 8 accounts)
tokenctl tx EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v

# More history with custom parameters
tokenctl tx EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v --limit 20 --hours 48 --accounts 12

# Enable all analytics sections
tokenctl tx EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v --all

# JSON output for machine processing
tokenctl tx EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v --json

# Configure RPC reliability
tokenctl tx <mint> --timeout 30000 --retries 5
```

**Live Progress Feedback (v1.3.0):**
```
Parsing transactions...
  [1/20] abc12345...xyz9 fetching...
  [1/20] abc12345...xyz9 ✓ 3 event(s)
  [2/20] def67890...uvw8 ⏱ unavailable/timeout
  [3/20] ghi11223...rst7 ✗ no metadata
  ...
  
Parsing transactions... ✓ (15 succeeded, 3 unavailable, 2 no metadata, 0 errors)
```

**Analytics Flags:**
- `--story`: Compact 2-4 sentence summary of observed behavior
- `--interpret`: Pattern classification with likely scenarios
- `--roles`: Classifies wallets by behavioral role (see below)
- `--signal`: Feature ratings and confidence score (0.00-1.00)
- `--all`: Enables all analytics sections
- `--json`: Machine-readable JSON output

**Understanding Wallet Roles:**

Roles are automatically classified based on observed transfer behavior:

- **Distributor**: High outbound activity, negative net flow, top volume sender
  - Indicates: Controlled distribution, airdrops, treasury operations, selling

- **Accumulator**: High inbound activity, positive net flow, top 3 by inbound volume
  - Indicates: Accumulation, buying activity, consolidation

- **Relay**: High volume, balanced flow (net ≤10% of total), ≥3 counterparties
  - Indicates: Routing, market making, intermediary operations

- **Sink**: High inbound volume, zero outbound transactions
  - Indicates: Final destination wallets that accumulate without redistributing

- **Dormant Whale**: Large balance holder with zero activity in observation window
  - Indicates: Inactive large holders who haven't moved tokens

Note: Roles are based on observed behavior only and do not indicate financial advice.

---

### `tokenctl watch <mint>`

Behavioral security monitoring tool that continuously monitors a token for changes. Tracks baseline behavior and detects anomalies.

```bash
# Basic monitoring (30 second intervals)
tokenctl watch EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v

# Strict mode with quieter output
tokenctl watch EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v --strict --quiet

# JSON output for programmatic monitoring
tokenctl watch EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v --json
```

**What it monitors:**
- Authority changes (mint/freeze)
- Supply changes (new mints)
- Large transfers above threshold
- Behavioral drift (>2x baseline spikes in rate/volume/counterparties)
- Wallet role changes (e.g., Accumulator → Distributor)
- Dormant wallet activations
- Structural security (first DEX interactions, dominant wallet share)

**Alerts:**
- `authority_change` - Authority changed (potential red flag)
- `supply_change` - Total supply changed
- `large_transfer` - Transfer above threshold
- `mint_event` - New mint above threshold
- `behavior_drift` - Behavioral deviation from baseline
- `role_change` - Wallet role changed
- `dormant_activation` - Previously inactive wallet activated
- `first_dex_interaction` - First DEX program detected
- `dominant_wallet_share` - Single wallet >60% of interval volume
- `authority_activity_coincidence` - Authority change + activity spike

Press `Ctrl+C` to stop monitoring.

---

### `tokenctl live <mint>`

Full-screen TUI dashboard for behavioral security monitoring. Cloudflare-style dashboard with real-time charts, alerts, and summaries.

```bash
# Launch dashboard (default 30s interval, autosave enabled)
tokenctl live EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v

# Custom interval, strict mode, no autosave
tokenctl live EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v --interval 60 --strict --no-autosave
```

**Dashboard Layout:**
- **Top Bar**: Token name, mint, interval, baseline status, RPC host
- **Row 1 Charts**: Transfers per interval, Unique wallets per interval (30 point window)
- **Row 2 Charts**: Avg transfer size, Dominant wallet share (30 point window)
- **Alerts Table**: Most recent 20 alerts with time, type, details, confidence
- **Current Interval Summary**: Transfers, mint events, volume, wallets, supply, authorities
- **Wallet Roles Summary**: Classified wallets with volume, net flow, counterparties
- **Footer**: Status, last update, autosave status

**Keyboard Controls:**
- `q` / `ESC` / `Ctrl+C` - Quit
- `p` - Pause/Resume polling
- `r` - Force refresh
- `s` - Save snapshot
- `tab` - Cycle focus
- `?` - Toggle help

**Autosave**: Snapshots automatically saved to `./tokenctl-runs/` after each interval. Disable with `--no-autosave`.

**Terminal Requirements**: Minimum 120x30 size.

---

## Command-Specific Options

**scan:**
- `--sig-limit <number>` - Signatures to fetch for activity (default: 10)
- `--holders` - Include holder distribution (heavy operation)
- `--max-accounts <number>` - Max accounts to scan for holders (default: 5000)

**holders:**
- `--top <number>` - Top holders to show (default: 10)
- `--max-accounts <number>` - Max accounts to scan (default: 5000)
- `--list` - List top account addresses

**tx:**
- `--limit <number>` - Signatures to fetch (default: 10, max: 50)
- `--hours <number>` - Hours to look back (default: 24)
- `--accounts <number>` - Largest accounts to scan (default: 8, max: 20)
- `--show <number>` - Events to display (default: 10)
- `--timeout <ms>` - RPC timeout per transaction (default: 15000)
- `--retries <number>` - Retry attempts for failed RPC calls (default: 3)
- `--story` / `--interpret` / `--roles` / `--signal` - Analytics flags
- `--all` - Enable all analytics
- `--json` - JSON output

**watch:**
- `--interval <seconds>` - Polling interval (default: 30)
- `--transfer-threshold <number>` - Large transfer threshold (default: 1000000)
- `--mint-threshold <number>` - Mint event threshold (default: 1000000)
- `--strict` - Stricter thresholds (1.5x instead of 2x for drift)
- `--quiet` - Only alerts, suppress summaries
- `--json` - JSON output

**live:**
- `--interval <seconds>` - Polling interval (default: 30)
- `--transfer-threshold <number>` - Large transfer threshold (default: 1000000)
- `--mint-threshold <number>` - Mint event threshold (default: 1000000)
- `--strict` - Stricter thresholds (1.5x instead of 2x)
- `--no-autosave` - Disable automatic snapshots

**Global options:**
- `--rpc <url>` - Override RPC endpoint (highest priority)
- `TOKENCTL_RPC` - Environment variable for RPC
- `~/.tokenctlrc` - Config file with `RPC=https://...`

---

## Token-2022 Support

**All commands fully support Token-2022** in addition to SPL Token:

- Automatic detection of token program (SPL vs Token-2022)
- Fallback handling for Token-2022 transaction encoding differences
- Unknown token program safety: Process stops with warning for unsupported programs
- Full feature parity across `scan`, `tx`, `watch`, and `live`

**Technical details:**
- SPL Token: `TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA`
- Token-2022: `TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb`
- Automatic retry with `json` encoding if `jsonParsed` fails (Token-2022 schema compatibility)

---

## Quick Examples

```bash
# RPC health check
tokenctl rpc

# Quick token scan (fast)
tokenctl scan EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v

# Full scan with holders (slower)
tokenctl scan EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v --holders

# Compact report for sharing
tokenctl report EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v

# Holder distribution analysis
tokenctl holders EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v --top 5

# Recent transfer activity with analytics
tokenctl tx EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v --all

# Live monitoring (text mode)
tokenctl watch EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v --interval 60

# Live dashboard (TUI mode)
tokenctl live EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v
```

---

## Notes & Limitations

**Data Coverage:**
- All activity data is "observed" from top token accounts, not comprehensive
- Many transfers may not appear (smaller accounts, archived transactions)
- Distribution may show "partial scan" if account limit is reached

**Performance:**
- Holder scanning is off by default in `scan` to avoid rate limits
- Use a dedicated RPC endpoint for best performance
- Public RPCs may throttle requests despite built-in delays and retries

**Scope:**
- `tx` command shows raw token transfers, not DEX trading activity
- Use Dexscreener or similar tools for swap/trading volume data
- Observed activity reflects mint-level interactions, not market trading

**Disclaimers:**
- Verdicts and classifications based solely on on-chain data
- Not financial advice or security audits
- Always conduct your own research and due diligence

---

## License

MIT

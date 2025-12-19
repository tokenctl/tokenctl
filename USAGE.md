# tokenctl Terminal Usage Guide

## Quick Start

### 1. Install Dependencies
```bash
cd /home/gc/tokenctl
npm install
```

### 2. Link the CLI (make it available globally)
```bash
npm link
```

### 3. Verify Installation
```bash
tokenctl --help
```

## Command Reference

### Check RPC Health
```bash
tokenctl rpc
tokenctl rpc --rpc https://api.mainnet-beta.solana.com
```

### Full Token Snapshot
```bash
tokenctl scan <mint-address>
tokenctl scan EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v
tokenctl scan EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v --max-accounts 10000
tokenctl scan EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v --rpc https://your-rpc.com
```

### Compact Report (Telegram-friendly)
```bash
tokenctl report <mint-address>
tokenctl report EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v
```

### Holder Distribution
```bash
tokenctl holders <mint-address>
tokenctl holders EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v --top 20
tokenctl holders EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v --max-accounts 10000
```

### Transaction History
```bash
tokenctl tx <mint-address>
tokenctl tx EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v --limit 50
tokenctl tx EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v --hours 48
tokenctl tx EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v --limit 30 --hours 72
```

### Live Monitoring
```bash
tokenctl watch <mint-address>
tokenctl watch EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v --interval 60
tokenctl watch EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v --transfer-threshold 5000000
tokenctl watch EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v --mint-threshold 1000000 --interval 30
```

Press `Ctrl+C` to stop the watch command.

## Setting Your RPC Endpoint

You can set your RPC endpoint in three ways (priority order):

### Option 1: Config File (Recommended)
Create `~/.tokenctlrc` in your home directory:
```bash
echo "RPC=https://your-rpc-endpoint.com" > ~/.tokenctlrc
```

This is persistent and works across all terminal sessions.

### Option 2: Environment Variable (Current Session)
```bash
export TOKENCTL_RPC=https://your-rpc-endpoint.com
tokenctl scan <mint-address>
```

### Option 3: Environment Variable (Permanent)
Add to your shell profile (`~/.bashrc` or `~/.zshrc`):
```bash
echo 'export TOKENCTL_RPC=https://your-rpc-endpoint.com' >> ~/.bashrc
source ~/.bashrc
```

**Priority**: Command line `--rpc` flag > Environment variable > Config file > Default

## Common Workflows

### Quick Token Check
```bash
tokenctl scan <mint-address>
```

### Share Token Info
```bash
tokenctl report <mint-address>
# Copy output and paste into Telegram/Discord
```

### Check Holder Concentration
```bash
tokenctl holders <mint-address> --top 10
```

### Monitor for Changes
```bash
tokenctl watch <mint-address> --interval 60
```

### Recent Activity Check
```bash
tokenctl tx <mint-address> --limit 20 --hours 24
```

## Troubleshooting

### Command Not Found
If `tokenctl` is not found after `npm link`:
```bash
# Check if npm global bin is in PATH
npm config get prefix
# Add to PATH if needed
export PATH=$PATH:$(npm config get prefix)/bin
```

### RPC Rate Limits
If you see rate limit errors:
```bash
# Use a different RPC endpoint
tokenctl scan <mint> --rpc https://your-rpc-endpoint.com

# Or set environment variable
export TOKENCTL_RPC=https://your-rpc-endpoint.com
```

### Partial Scan Warning
If you see "[partial scan]" in output:
```bash
# Increase max accounts (slower but more complete)
tokenctl scan <mint> --max-accounts 10000
```

## Examples with Real Mint Addresses

### USDC (Solana)
```bash
tokenctl scan EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v
tokenctl holders EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v --top 5
```

### USDT (Solana)
```bash
tokenctl scan Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB
tokenctl report Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB
```

## Tips

1. **Use a reliable RPC**: Free public RPCs may have rate limits. Consider using a paid RPC for production use.

2. **Watch command**: Runs indefinitely until stopped. Use `--interval` to adjust polling frequency.

3. **Copy-paste friendly**: All outputs are designed to be easily copied and shared.

4. **Deterministic**: Same inputs produce same outputs (except for live data like current slot).

5. **No financial advice**: This tool provides on-chain data only, not investment recommendations.


# tokenctl v1.1 Release Notes

## Overview

tokenctl v1.1 focuses on improving the `tx` command to accurately detect and display real token transfers from on-chain data. This release includes robust transaction parsing, duplicate removal, and improved output formatting.

## Changes

### Fixed `tx` Command Transfer Detection

- **Rewrote transaction parsing logic** to detect SPL token transfers using two methods:
  - Primary: Token balance deltas (`preTokenBalances` / `postTokenBalances`) - most reliable
  - Fallback: Parsed SPL token instructions (`transfer`, `transferChecked`, `mintTo`, `mintToChecked`)
- **Added robust encoding fallback**: If `jsonParsed` encoding fails with schema errors, automatically retries with `json` encoding to ensure transactions can be parsed
- **Improved source/destination detection**: Better logic for identifying transfer sources and destinations from balance changes

### Removed Duplicate Transfer Output

- **Deduplication logic**: Events are now deduplicated before display based on signature, type, amount, and destination
- **Preference for known addresses**: When duplicates exist, the event with a known source address (not "unknown") is preferred
- **Accurate counts**: Summary counts now reflect unique transfers only

### Improved Output Formatting

- **Structured display**: Each transfer event now displays with clear labels:
  - Timestamp
  - Type (Transfer/Mint)
  - Amount
  - From (source address)
  - To (destination address)
  - Signature (full transaction signature)
- **Full addresses**: All addresses and signatures are displayed in full (no truncation)
- **Summary section**: Added clear summary block with transfer and mint event counts

### Documentation Updates

- **Clarified `tx` command behavior**: Updated README to accurately describe that `tx` shows observed token transfers from top accounts, not comprehensive transaction history
- **Removed misleading claims**: Removed any implication of full transaction history or guaranteed visibility
- **Added limitations section**: Clear documentation of what `tx` does and does not show
- **Noted DEX distinction**: Explicitly states that `tx` shows raw token transfers, not DEX trading activity (complements tools like Dexscreener)

## Technical Details

- **No breaking changes**: All existing commands (`scan`, `holders`, `watch`, `report`) remain unchanged
- **Backward compatible**: Command flags and options unchanged
- **Improved error handling**: Better handling of archived transactions and RPC limitations

## Migration Notes

No migration required. This is a drop-in update with improved functionality.

## Known Limitations

- `tx` command shows observed transfers from top token accounts only, not comprehensive history
- Archived transactions may not be available from public RPC endpoints
- Tokens with extremely large holder counts may require dedicated RPC endpoints
- Shows raw token transfers, not DEX swap/trading data

## Recommendations

- Use a dedicated RPC endpoint with transaction history support for best `tx` results
- For DEX trading data, use specialized tools like Dexscreener
- Increase `--hours` or `--accounts` flags if you need to see more activity




# tokenctl v1.1.1 Release Notes

## Overview

tokenctl v1.1.1 includes significant improvements to token name detection, activity analysis, and transaction display. This release makes the `scan` command more useful with better activity detection and adds wallet activity summaries to the `tx` command.

## Changes Since v1.1.0

### Token Name Detection Improvements

- **Dexscreener API Fallback**: Added automatic fallback to Dexscreener's public API when on-chain metadata is not available. This ensures token names are displayed for tokens sourced from Dexscreener, even if they don't have on-chain metadata accounts.
- **Metadata URI Fallback**: If a metadata account exists but the name field is empty, the tool now fetches the JSON from the metadata URI to extract the token name.
- **Improved Metadata Parsing**: Enhanced Metaplex metadata parsing with better validation, error handling, and support for edge cases.
- **Always Show Name Field**: The `scan` command now always displays the "Name" field, showing "N/A" if no name can be found (instead of hiding the field entirely).

### Activity Detection Enhancements

- **Token Account-Based Activity Detection**: The `scan` command's activity detection now checks top token accounts (like the `tx` command) instead of only querying the mint address. This makes `--sig-limit` actually useful and finds real trading activity.
- **Better Error Handling**: Activity detection now returns partial results instead of throwing errors, preventing "unavailable (rate limited)" messages when partial data is available.
- **Improved Signature Collection**: Collects signatures from multiple token accounts and the mint address, with intelligent deduplication and time filtering.

### Transaction Command Improvements

- **Wallet Activity Summary**: Added "Most Active Wallets" section to `tx` command output, showing:
  - Transaction counts per wallet
  - Net flow (received - sent) to identify buyers vs sellers
  - Total volume per wallet
  - Only shows wallets with multiple transactions to highlight patterns
- **Better Deduplication**: Improved event deduplication logic to handle cases where the same transaction produces multiple events with different source/destination interpretations. Now uses signature + type + amount as the key (not destination) to properly deduplicate.

### Holder Count Fix

- **Accurate Holder Counting**: Fixed issue where `getProgramAccounts` would sometimes return fewer accounts than `getTokenLargestAccounts`. The tool now uses `getTokenLargestAccounts` count as a fallback when `getProgramAccounts` is incomplete, providing more accurate holder counts.

### Documentation

- **Verdict Classifications**: Added detailed explanations of CLEAN, WATCH, and RISKY verdict classifications to help users understand the risk assessment.

## Technical Details

- **No Breaking Changes**: All existing commands and flags remain compatible
- **Backward Compatible**: Existing workflows continue to work unchanged
- **Improved RPC Handling**: Better rate limit handling and error recovery

## Migration Notes

No migration required. This is a drop-in update with improved functionality.

## Known Limitations

- Token names from Dexscreener API require internet connectivity
- Activity detection may still show 0 transfers if there's genuinely no recent activity
- Some tokens may not have metadata available from any source

## Recommendations

- Use `--sig-limit 20` or higher with `scan` to check more token accounts for activity
- The wallet activity summary in `tx` helps identify trading bots and liquidity pools
- Token names will now display for most tokens from Dexscreener


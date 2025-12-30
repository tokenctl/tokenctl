# RPC Methods Used by tokenctl

This document details the Solana RPC methods used by each command and the rationale for each choice.

## `tokenctl rpc`

**Purpose**: Health check and latency test

**RPC Methods Used**:
- `getSlot()` - Gets current slot number
- `getLatestBlockhash()` - Gets latest blockhash

**Why**:
- Lightweight methods that test basic connectivity
- `getSlot()` confirms the RPC is synced and responding
- `getLatestBlockhash()` tests write capability (needed for transactions)
- Both are fast and don't require account data

---

## `tokenctl scan <mint>`

**Purpose**: Comprehensive token analysis

### Core Token Info (always fetched)
**RPC Methods**:
- `getAccountInfo(mintPubkey)` - Fetches mint account data
- `getTokenSupply(mintPubkey)` - Gets token supply with decimals
- `getAccountInfo(metadataPDA)` - Fetches Metaplex metadata (optional, for name)

**Why**:
- `getAccountInfo()` - Raw account data needed to decode mint authority, freeze authority, and supply from account layout
- `getTokenSupply()` - Provides accurate supply with decimals and UI-friendly formatting (avoids manual decimal math)
- `getAccountInfo(metadataPDA)` - Metaplex standard for token names/symbols (most tokens use this)

**Note**: Sequential calls with 500ms delays to avoid rate limits

### Holder Distribution (only with `--holders` flag)
**RPC Methods**:
- `getTokenLargestAccounts(mintPubkey)` - Gets top holders by balance
- `getProgramAccounts(programId, filters)` - Gets all token accounts for the mint

**Why**:
- `getTokenLargestAccounts()` - Fast, efficient way to get top N holders without scanning all accounts. Used for concentration calculations (top 1%, top 10%)
- `getProgramAccounts()` - Required to count total holders. Uses filters:
  - `dataSize: 165` - Standard token account size
  - `memcmp: { offset: 0, bytes: mintPubkey }` - Filters accounts by mint address
- Tries both `TOKEN_PROGRAM_ID` and `TOKEN_2022_PROGRAM_ID` for compatibility
- Tries both base58 string and Buffer format for memcmp (RPC compatibility)

**Note**: This is the heaviest operation - can hit rate limits on public RPCs

### Activity Analysis (optional, can fail gracefully)
**RPC Methods**:
- `getSignaturesForAddress(mintPubkey, { limit })` - Gets transaction signatures
- `getTransaction(signature, { encoding: 'jsonParsed' })` - Fetches full transaction data

**Why**:
- `getSignaturesForAddress()` - Gets list of recent transactions involving the mint
- `getTransaction()` with `jsonParsed` - Parses transaction instructions automatically (easier than manual parsing)
- Checks both main instructions and inner instructions for mint/transfer events
- Limited to 5-10 transactions by default to reduce RPC load

**Note**: 2 second delay between transaction fetches to avoid rate limits

---

## `tokenctl holders <mint>`

**Purpose**: Detailed holder distribution analysis

**RPC Methods**:
- `getTokenSupply(mintPubkey)` - For percentage calculations
- `getTokenLargestAccounts(mintPubkey)` - Gets top N holders
- `getProgramAccounts(programId, filters)` - Counts total holders

**Why**:
- Same as `scan --holders` but dedicated command
- `getTokenLargestAccounts()` - Efficient for top holder list
- `getProgramAccounts()` - Required for accurate total holder count
- Uses same dual-program and dual-format approach as scan

**Note**: Can be rate-limited on public RPCs for tokens with many holders

---

## `tokenctl tx <mint>`

**Purpose**: Transaction history analysis

**RPC Methods**:
- `getAccountInfo(mintPubkey)` - Basic mint validation (via fetchMintInfo)
- `getTokenSupply(mintPubkey)` - Basic mint validation (via fetchMintInfo)
- `getSignaturesForAddress(mintPubkey, { limit })` - Gets transaction signatures
- `getTransaction(signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 })` - Fetches transactions

**Why**:
- `getSignaturesForAddress()` - Gets chronological list of transactions
- `getTransaction()` with `jsonParsed` - Automatic instruction parsing
- `maxSupportedTransactionVersion: 0` - Ensures compatibility with transaction format
- Checks up to `--limit` signatures (default 10)
- Shows all checked signatures even if no events found (transparency)

**Note**: 2 second delay between transaction fetches

---

## `tokenctl watch <mint>`

**Purpose**: Continuous monitoring

**RPC Methods** (called every `--interval` seconds):
- `getAccountInfo(mintPubkey)` - Checks mint account (via fetchMintInfo)
- `getTokenSupply(mintPubkey)` - Checks supply (via fetchMintInfo)
- `getAccountInfo(metadataPDA)` - Checks metadata (via fetchMintInfo)
- `getSignaturesForAddress(mintPubkey, { limit: 10 })` - Monitors for new transactions
- `getTransaction(signature, { encoding: 'jsonParsed' })` - Analyzes new transactions

**Why**:
- Polling approach (not websockets) for reliability
- `getSignaturesForAddress()` - Detects new transactions by comparing newest signature
- `getTransaction()` - Analyzes new transactions for mint/transfer events
- Only fetches transactions when newest signature changes (efficiency)
- Uses `rpcRetry()` wrapper for automatic retry on rate limits

**Note**: Exponential backoff on errors, up to 60 seconds

---

## `tokenctl report <mint>`

**Purpose**: Compact report format

**RPC Methods**: Same as `scan` command (reuses same logic)

---

## RPC Method Summary

| Method | Commands Using It | Purpose | Rate Limit Risk |
|--------|------------------|---------|------------------|
| `getSlot()` | `rpc` | Health check | Low |
| `getLatestBlockhash()` | `rpc` | Health check | Low |
| `getAccountInfo()` | `scan`, `watch`, `report` | Mint account data, metadata | Medium |
| `getTokenSupply()` | `scan`, `holders`, `watch`, `report` | Supply with decimals | Low |
| `getTokenLargestAccounts()` | `scan --holders`, `holders` | Top holders | Medium |
| `getProgramAccounts()` | `scan --holders`, `holders` | Total holder count | **High** |
| `getSignaturesForAddress()` | `scan`, `tx`, `watch` | Transaction history | Medium |
| `getTransaction()` | `scan`, `tx`, `watch` | Transaction details | **High** |

## Design Decisions

1. **Sequential calls with delays**: Avoids overwhelming public RPCs
2. **Dual program support**: Tries both Token and Token 2022 programs
3. **Dual format support**: Tries both base58 string and Buffer for memcmp filters (RPC compatibility)
4. **Graceful degradation**: Commands continue even if optional sections fail
5. **Retry logic**: `rpcRetry()` wrapper handles 429/timeout errors automatically
6. **jsonParsed encoding**: Easier than manual instruction parsing, but requires RPC support
7. **Holder scanning optional**: Separated into `--holders` flag to avoid rate limits on default scan

## Rate Limit Considerations

- **Heaviest operations**: `getProgramAccounts()` and `getTransaction()` (multiple calls)
- **Mitigation**: Delays between calls, retry logic, optional operations
- **Recommendation**: Use dedicated RPC endpoint for production use




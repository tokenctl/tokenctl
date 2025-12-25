# tokenctl Execution Flow Documentation

This document describes the function call sequence for each `tokenctl` command, showing how code flows from the CLI entry point through all utility functions.

---

## Entry Point: `bin/tokenctl`

The CLI entry point uses `commander.js` to parse commands and route to command handlers:

```
bin/tokenctl
  └─> program.parse() [commander.js]
      └─> Routes to command handler based on user input
```

---

## Command: `tokenctl rpc`

**Purpose:** Check RPC endpoint health

**Execution Flow:**
```
bin/tokenctl
  └─> rpcCommand(options)
      └─> src/utils/rpc.js::getRpcUrl(options)
          ├─> Check options.rpc (command line flag)
          ├─> Check process.env.TOKENCTL_RPC (environment variable)
          ├─> Check ~/.tokenctlrc (config file via getConfigRpc())
          └─> Fallback to DEFAULT_RPC
      └─> src/utils/rpc.js::createConnection(rpcUrl)
          └─> new Connection(rpcUrl, 'confirmed')
      └─> connection.getSlot() [parallel]
      └─> connection.getLatestBlockhash() [parallel]
      └─> Calculate latency and print results
```

**Functions Called:**
1. `getRpcUrl(options)` - Resolve RPC URL
2. `getConfigRpc()` - Read config file (if needed)
3. `createConnection(rpcUrl)` - Create Solana connection
4. `connection.getSlot()` - Get current slot
5. `connection.getLatestBlockhash()` - Get latest blockhash

---

## Command: `tokenctl scan <mint>`

**Purpose:** Full token snapshot with optional holder distribution

**Execution Flow:**
```
bin/tokenctl
  └─> scanCommand(mint, options)
      └─> src/utils/rpc.js::validateMint(mint)
          └─> new PublicKey(mint) [validates address]
      └─> src/utils/rpc.js::getRpcUrl(options)
      └─> src/utils/rpc.js::createConnection(rpcUrl)
      └─> src/utils/rpc.js::rpcRetry(() => fetchMintInfo(...))
          └─> src/utils/mint.js::fetchMintInfo(connection, mint)
              ├─> new PublicKey(mintAddress)
              ├─> src/utils/mint.js::getMetadataPDA(mintAddress)
              │   └─> PublicKey.findProgramAddressSync(...)
              ├─> connection.getAccountInfo(mintPubkey)
              ├─> sleep(500)
              ├─> connection.getTokenSupply(mintPubkey)
              ├─> sleep(500)
              ├─> src/utils/mint.js::decodeMintAccount(accountInfo.data)
              ├─> connection.getAccountInfo(metadataPDA) [optional - for name]
              ├─> src/utils/mint.js::parseMetaplexMetadata(metadataInfo.data) [if metadata exists]
              └─> src/utils/mint.js::parseToken2022Metadata(accountInfo.data) [fallback for name]
      
      [IF --holders flag is set]
      └─> src/utils/rpc.js::rpcRetry(() => getTokenHolders(...))
          └─> src/utils/holders.js::getTokenHolders(connection, mint, maxAccounts)
              ├─> new PublicKey(mintAddress)
              ├─> connection.getTokenSupply(mintPubkey)
              ├─> connection.getTokenLargestAccounts(mintPubkey)
              ├─> Calculate top1Percent and top10Percent from largestAccounts
              ├─> connection.getProgramAccounts(TOKEN_PROGRAM_ID, {...}) [try base58]
              │   └─> Filters: dataSize: 165, memcmp: mint bytes
              ├─> connection.getProgramAccounts(TOKEN_PROGRAM_ID, {...}) [try Buffer if base58 fails]
              ├─> connection.getProgramAccounts(TOKEN_2022_PROGRAM_ID, {...}) [try Token 2022]
              ├─> src/utils/holders.js::parseTokenAccount(account.data) [for each account]
              └─> Count holders with balance > 0
          └─> src/utils/holders.js::calculateConcentration(holdersData)
      
      [Activity section - optional, continues on failure]
      └─> src/utils/rpc.js::rpcRetry(() => getRecentActivity(...))
          └─> src/utils/activity.js::getRecentActivity(connection, mint, sigLimit, 24)
              ├─> new PublicKey(mintAddress)
              ├─> connection.getSignaturesForAddress(mintPubkey, { limit })
              ├─> [For each signature in time window]
              │   ├─> sleep(2000) [between transactions]
              │   ├─> connection.getTransaction(signature, { encoding: 'jsonParsed' })
              │   └─> src/utils/activity.js::parseTransaction(tx, mintAddress)
              │       ├─> Check for DEX programs (Raydium, Jupiter, Orca)
              │       ├─> Parse instructions for 'mintTo' / 'transfer'
              │       ├─> Parse innerInstructions
              │       └─> src/utils/activity.js::parseAmount(tokenAmount)
              └─> Return events, mintEvents, transfers, swaps counts
      
      └─> src/utils/verdict.js::calculateVerdict(mintInfo, concentration, activity, holdersData)
          └─> Analyze authorities, concentration, activity, holder count
          └─> Return verdict: 'CLEAN' | 'WATCH' | 'RISKY' with reason
      
      └─> Format and print output using:
          └─> src/utils/colors.js::sectionHeader(text)
          └─> src/utils/colors.js::verdictColor(verdict)
```

**Functions Called:**
1. `validateMint(mint)` - Validate mint address
2. `getRpcUrl(options)` - Resolve RPC URL
3. `createConnection(rpcUrl)` - Create connection
4. `rpcRetry(fn)` - Retry wrapper with rate limit handling
5. `fetchMintInfo(connection, mint)` - Fetch mint account data
   - `getMetadataPDA(mintAddress)` - Calculate Metaplex PDA
   - `decodeMintAccount(data)` - Decode mint account structure
   - `parseMetaplexMetadata(data)` - Parse Metaplex metadata
   - `parseToken2022Metadata(data)` - Parse Token 2022 metadata
6. `getTokenHolders(connection, mint, maxAccounts)` - [if --holders]
   - `parseTokenAccount(data)` - Parse token account data
   - `calculateConcentration(holdersData)` - Calculate percentages
7. `getRecentActivity(connection, mint, limit, hours)` - [optional]
   - `parseTransaction(tx, mintAddress)` - Parse transaction events
   - `parseAmount(tokenAmount)` - Parse token amounts
8. `calculateVerdict(mintInfo, concentration, activity, holdersData)` - Calculate verdict
9. `sectionHeader(text)` - Format section headers
10. `verdictColor(verdict)` - Colorize verdict output

---

## Command: `tokenctl report <mint>`

**Purpose:** Compact Telegram-friendly report

**Execution Flow:**
```
bin/tokenctl
  └─> reportCommand(mint, options)
      └─> src/utils/rpc.js::validateMint(mint)
      └─> src/utils/rpc.js::getRpcUrl(options)
      └─> src/utils/rpc.js::createConnection(rpcUrl)
      └─> src/utils/rpc.js::rpcRetry(() => fetchMintInfo(...))
          └─> [Same as scan command - see above]
      └─> src/utils/rpc.js::rpcRetry(() => getTokenHolders(...))
          └─> [Same as scan command - see above]
      └─> src/utils/rpc.js::rpcRetry(() => getRecentActivity(...))
          └─> [Same as scan command - see above]
      └─> src/utils/verdict.js::calculateVerdict(...)
      └─> Format compact output (no colors, single-line format)
```

**Functions Called:** (Same as `scan`, but output format differs)

---

## Command: `tokenctl holders <mint>`

**Purpose:** Token holder distribution analysis

**Execution Flow:**
```
bin/tokenctl
  └─> holdersCommand(mint, options)
      └─> src/utils/rpc.js::validateMint(mint)
      └─> src/utils/rpc.js::getRpcUrl(options)
      └─> src/utils/rpc.js::createConnection(rpcUrl)
      └─> src/utils/rpc.js::rpcRetry(() => fetchMintInfo(...))
          └─> [Same as scan command - see above]
      
      [IF --list flag is set]
      └─> connection.getTokenLargestAccounts(new PublicKey(mint))
          └─> Returns { value: [...] } with top accounts
      
      └─> src/utils/rpc.js::rpcRetry(() => getTokenHolders(...))
          └─> [Same as scan command - see above]
      
      └─> Format and print output:
          └─> src/utils/colors.js::sectionHeader(text)
          └─> Display top N accounts with addresses [if --list]
```

**Functions Called:**
1. `validateMint(mint)`
2. `getRpcUrl(options)`
3. `createConnection(rpcUrl)`
4. `rpcRetry(() => fetchMintInfo(...))`
5. `connection.getTokenLargestAccounts(...)` [if --list]
6. `rpcRetry(() => getTokenHolders(...))`
7. `sectionHeader(text)`

---

## Command: `tokenctl tx <mint>`

**Purpose:** Recent transaction activity from top token accounts

**Execution Flow:**
```
bin/tokenctl
  └─> txCommand(mint, options)
      └─> src/utils/rpc.js::validateMint(mint)
      └─> src/utils/rpc.js::getRpcUrl(options)
      └─> src/utils/rpc.js::createConnection(rpcUrl)
      └─> src/utils/rpc.js::rpcRetry(() => fetchMintInfo(...))
          └─> [Same as scan command - see above]
      
      └─> connection.getTokenLargestAccounts(new PublicKey(mint))
          └─> Get top N accounts (default 8, max 20)
      
      └─> [For each token account]
          └─> getTokenAccountSignatures(connection, tokenAccount, limit)
              └─> connection.getSignaturesForAddress(tokenAccount, { limit })
              └─> Retry on rate limit (max 2 retries, 5s sleep)
      
      └─> Deduplicate signatures by signature string
      └─> Filter by time (cutoffTime = now - hours)
      └─> Sort by blockTime (newest first)
      └─> Slice to limit
      
      └─> [For each signature]
          ├─> getTransactionWithRetry(connection, signature)
          │   └─> connection.getTransaction(signature, { encoding: 'jsonParsed' })
          │   └─> Retry on rate limit (max 2 retries, 5s sleep)
          ├─> sleep(500) [between transaction fetches]
          └─> parseTransferEvents(tx, mint)
              ├─> Parse preTokenBalances / postTokenBalances
              ├─> Calculate balance changes
              ├─> Parse instructions for 'transfer' / 'mintTo'
              ├─> Parse innerInstructions
              └─> Deduplicate events
      
      └─> Format and print output:
          └─> src/utils/colors.js::sectionHeader(text)
          └─> formatTime(timestamp) - Format timestamps
          └─> shortenAddress(addr, len) - Shorten addresses
          └─> Display events with time, type, amount, addresses, signature
```

**Functions Called:**
1. `validateMint(mint)`
2. `getRpcUrl(options)`
3. `createConnection(rpcUrl)`
4. `rpcRetry(() => fetchMintInfo(...))`
5. `connection.getTokenLargestAccounts(...)`
6. `getTokenAccountSignatures(...)` - Custom function in tx.js
7. `getTransactionWithRetry(...)` - Custom function in tx.js
8. `parseTransferEvents(tx, mint)` - Custom function in tx.js
9. `formatTime(timestamp)` - Custom function in tx.js
10. `shortenAddress(addr, len)` - Custom function in tx.js
11. `sectionHeader(text)`
12. `sleep(ms)` - Between operations

---

## Command: `tokenctl watch <mint>`

**Purpose:** Live monitoring with alerts

**Execution Flow:**
```
bin/tokenctl
  └─> watchCommand(mint, options)
      └─> src/utils/rpc.js::validateMint(mint)
      └─> src/utils/rpc.js::getRpcUrl(options)
      └─> src/utils/rpc.js::createConnection(rpcUrl)
      
      └─> [Infinite loop - every interval seconds]
          ├─> src/utils/rpc.js::rpcRetry(() => fetchMintInfo(...))
          │   └─> [Same as scan command - see above]
          │
          ├─> [Check for authority changes]
          │   └─> Compare mintAuthority / freezeAuthority with lastMintInfo
          │
          ├─> [Check for supply changes]
          │   └─> Compare supply with lastSupply
          │
          ├─> connection.getSignaturesForAddress(mintPubkey, { limit: 10 })
          │
          ├─> [For new signatures since lastSignature]
          │   ├─> connection.getTransaction(signature, { encoding: 'jsonParsed' })
          │   └─> parseTransaction(tx, mint)
          │       ├─> Check instructions for 'mintTo' / 'transfer'
          │       ├─> Check innerInstructions
          │       └─> parseAmount(tokenAmount)
          │
          ├─> [Alert on mint events >= mintThreshold]
          ├─> [Alert on transfers >= transferThreshold]
          │
          └─> sleep(interval * 1000)
```

**Functions Called:**
1. `validateMint(mint)`
2. `getRpcUrl(options)`
3. `createConnection(rpcUrl)`
4. `rpcRetry(() => fetchMintInfo(...))` - Repeated in loop
5. `connection.getSignaturesForAddress(...)` - Repeated in loop
6. `connection.getTransaction(...)` - Repeated in loop
7. `parseTransaction(tx, mint)` - Custom function in watch.js
8. `parseAmount(tokenAmount)` - Custom function in watch.js
9. `formatTime()` - Custom function in watch.js
10. `sleep(ms)` - Between polling intervals

---

## Utility Functions Reference

### `src/utils/rpc.js`

- **`getRpcUrl(options)`**: Resolves RPC URL from command line → env → config → default
- **`getConfigRpc()`**: Reads `~/.tokenctlrc` file for RPC configuration
- **`createConnection(rpcUrl)`**: Creates Solana Connection instance
- **`validateMint(mintAddress)`**: Validates mint address using PublicKey
- **`sleep(ms)`**: Promise-based delay utility
- **`rpcRetry(fn, maxRetries)`**: Retry wrapper with exponential backoff on rate limits

### `src/utils/mint.js`

- **`getMetadataPDA(mintAddress)`**: Calculates Metaplex metadata PDA address
- **`decodeMintAccount(data)`**: Decodes mint account binary data
- **`parseMetaplexMetadata(data)`**: Parses Metaplex DataV2 structure for token name
- **`parseToken2022Metadata(data)`**: Parses Token 2022 extension for token name
- **`fetchMintInfo(connection, mintAddress)`**: Main function to fetch all mint information

### `src/utils/holders.js`

- **`parseTokenAccount(data)`**: Decodes token account binary data
- **`getTokenHolders(connection, mintAddress, maxAccounts)`**: Fetches holder distribution
- **`calculateConcentration(holdersData)`**: Calculates top 1% and top 10% percentages

### `src/utils/activity.js`

- **`getRecentActivity(connection, mintAddress, limit, hours)`**: Fetches recent transaction activity
- **`parseTransaction(tx, mintAddress)`**: Parses transaction for mint/transfer/swap events
- **`parseAmount(tokenAmount)`**: Parses token amount from various formats

### `src/utils/verdict.js`

- **`calculateVerdict(mintInfo, concentration, activity, holdersData)`**: Calculates token verdict (CLEAN/WATCH/RISKY)

### `src/utils/colors.js`

- **`colorize(text, color, bgColor)`**: Applies ANSI color codes
- **`sectionHeader(text)`**: Formats section headers with blue background
- **`verdictColor(verdict)`**: Colorizes verdict output (green/yellow/red)

---

## RPC Methods Used

### Common RPC Methods:
- `connection.getSlot()` - Get current slot
- `connection.getLatestBlockhash()` - Get latest blockhash
- `connection.getAccountInfo(publicKey)` - Get account data
- `connection.getTokenSupply(publicKey)` - Get token supply
- `connection.getTokenLargestAccounts(publicKey)` - Get top N token accounts
- `connection.getProgramAccounts(programId, filters)` - Get all accounts owned by program
- `connection.getSignaturesForAddress(address, options)` - Get transaction signatures
- `connection.getTransaction(signature, options)` - Get full transaction data

### Rate Limiting:
- All RPC calls are wrapped in `rpcRetry()` for automatic retry on 429/timeout
- Delays (`sleep()`) are added between sequential RPC calls to reduce load
- Commands fail gracefully with "unavailable (rate limited)" messages

---

## Error Handling Flow

1. **Validation Errors**: Exit immediately with error message
2. **RPC Errors**: 
   - Wrapped in `rpcRetry()` for automatic retry (3 attempts, 5s delay)
   - Returns `null` if all retries fail
   - Commands check for `null` and display "unavailable (rate limited)"
3. **Parsing Errors**: 
   - Caught and logged (if DEBUG=1)
   - Continue with fallback values (e.g., `name: null`)
4. **Rate Limit Errors**: 
   - Detected by error message containing "429", "rate limit", "timeout"
   - Triggers retry with exponential backoff
   - Final failure shows user-friendly message with tips

---

## Data Flow Summary

```
User Input (CLI)
  ↓
Command Handler (src/commands/*.js)
  ↓
RPC Utilities (src/utils/rpc.js)
  ↓
Solana Connection (@solana/web3.js)
  ↓
RPC Endpoint (Solana network)
  ↓
Response Data
  ↓
Parsing Utilities (src/utils/mint.js, holders.js, activity.js)
  ↓
Business Logic (src/utils/verdict.js)
  ↓
Formatting (src/utils/colors.js)
  ↓
Output (stdout/stderr)
```

---

## Notes

- All commands validate mint address first
- RPC URL resolution follows priority: CLI flag → env var → config file → default
- Heavy operations (holders, activity) are optional or behind flags
- All RPC calls include retry logic and rate limit handling
- Progress indicators are written to `stderr` to allow clean `stdout` output
- Commands are designed to fail gracefully when RPC data is unavailable


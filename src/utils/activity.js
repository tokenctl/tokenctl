const { PublicKey } = require('@solana/web3.js');

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function getRecentActivity(connection, mintAddress, limit = 50, hours = 24) {
  // Declare variables outside try block so they're accessible in catch
  let events = [];
  let mintEvents = 0;
  let transfers = 0;
  let swaps = 0;
  let checkedSignatures = [];
  let signatures = [];
  
  try {
    const mintPubkey = new PublicKey(mintAddress);
    const cutoffTime = Date.now() - (hours * 60 * 60 * 1000);
    
    // Get top token accounts to check for activity (like tx command does)
    // This is more effective than checking the mint address directly
    let tokenAccounts = [];
    try {
      const result = await connection.getTokenLargestAccounts(mintPubkey);
      const accounts = result.value || result || [];
      // Check more accounts when sig-limit is higher
      // Default (10): 2 accounts, --sig-limit 20: 4 accounts, --sig-limit 50: 5 accounts
      const maxAccounts = Math.min(5, Math.max(1, Math.floor(limit / 5)));
      tokenAccounts = accounts.slice(0, maxAccounts);
      if (process.env.DEBUG === '1') {
        console.error(`DEBUG: Checking ${tokenAccounts.length} top token accounts for activity (from ${accounts.length} total)`);
      }
    } catch (e) {
      if (process.env.DEBUG === '1') {
        console.error(`DEBUG: Failed to get token accounts, falling back to mint address: ${e.message}`);
      }
    }
    
    // Collect signatures from token accounts (more effective) and mint address (fallback)
    const allSignatures = [];
    
    // Prioritize token accounts - they show actual trading activity
    if (tokenAccounts.length > 0) {
      const sigLimitPerAccount = Math.ceil(limit / tokenAccounts.length);
      
      // Get signatures from token accounts
      for (const account of tokenAccounts) {
        try {
          const sigs = await connection.getSignaturesForAddress(
            new PublicKey(account.address),
            { limit: sigLimitPerAccount }
          );
          // Filter by time and add to collection
          for (const sig of sigs) {
            if (sig.blockTime && sig.blockTime * 1000 >= cutoffTime) {
              allSignatures.push(sig);
            }
          }
          if (tokenAccounts.indexOf(account) < tokenAccounts.length - 1) {
            await sleep(1000); // Rate limit protection
          }
        } catch (e) {
          if (process.env.DEBUG === '1') {
            console.error(`DEBUG: Failed to get signatures for account ${account.address}: ${e.message}`);
          }
          // Continue with other accounts
        }
      }
    }
    
    // Also check mint address (for mint events) - but only if we have room
    if (allSignatures.length < limit) {
      try {
        const remaining = limit - allSignatures.length;
        const mintSignatures = await connection.getSignaturesForAddress(mintPubkey, { limit: Math.min(5, remaining) });
        for (const sig of mintSignatures) {
          if (sig.blockTime && sig.blockTime * 1000 >= cutoffTime) {
            allSignatures.push(sig);
          }
        }
        if (process.env.DEBUG === '1') {
          console.error(`DEBUG: getSignaturesForAddress(mint) returned ${mintSignatures.length} signatures`);
        }
      } catch (e) {
        if (process.env.DEBUG === '1') {
          console.error(`DEBUG: Failed to get signatures from mint address: ${e.message}`);
        }
      }
    }
    
    // Deduplicate signatures by signature string
    const uniqueSignatures = [];
    const seenSigs = new Set();
    for (const sig of allSignatures) {
      if (!seenSigs.has(sig.signature)) {
        seenSigs.add(sig.signature);
        uniqueSignatures.push(sig);
      }
    }
    
    // Sort by blockTime (newest first) and limit
    uniqueSignatures.sort((a, b) => (b.blockTime || 0) - (a.blockTime || 0));
    signatures = uniqueSignatures.slice(0, limit);
    
    if (process.env.DEBUG === '1') {
      console.error(`DEBUG: Total unique signatures collected: ${signatures.length} (from ${tokenAccounts.length} token accounts + mint)`);
    }

    events = [];
    mintEvents = 0;
    transfers = 0;
    swaps = 0;
    checkedSignatures = [];
    const maxTxs = Math.min(limit, signatures.length);

  for (let i = 0; i < signatures.length && i < maxTxs; i++) {
    const sig = signatures[i];
    if (sig.blockTime && sig.blockTime * 1000 < cutoffTime) {
      break;
    }

    if (i > 0) {
      await sleep(2000);
    }

    // Use the same retry logic as tx command
    const tx = await getTransactionWithRetry(connection, sig.signature);

    if (!tx) {
      checkedSignatures.push({
        signature: sig.signature,
        time: sig.blockTime,
        status: 'not_found',
        error: 'Transaction not found (may be archived)',
        hasEvent: false
      });
      continue;
    }
    
    if (!tx.meta) {
      checkedSignatures.push({
        signature: sig.signature,
        time: sig.blockTime,
        status: 'no_meta',
        error: 'Transaction missing metadata',
        hasEvent: false
      });
      continue;
    }

    if (!tx.transaction) {
      checkedSignatures.push({
        signature: sig.signature,
        time: sig.blockTime,
        status: 'error',
        error: 'Invalid transaction',
        hasEvent: false
      });
      continue;
    }

    // Use the same parsing logic as tx command (more reliable)
    const transferEvents = parseTransferEvents(tx, mintAddress);
    const hasEvent = transferEvents.length > 0;
    
    checkedSignatures.push({
      signature: sig.signature,
      time: sig.blockTime,
      status: tx.meta.err ? 'failed' : 'success',
      error: tx.meta.err,
      hasEvent
    });

    // Count events by type
    for (const event of transferEvents) {
      if (event.type === 'mint') {
        mintEvents++;
        events.push({
          signature: sig.signature,
          time: sig.blockTime,
          type: 'mint',
          amount: event.amount
        });
      } else if (event.type === 'transfer') {
        transfers++;
        events.push({
          signature: sig.signature,
          time: sig.blockTime,
          type: 'transfer',
          amount: event.amount
        });
      }
    }
  }

    if (process.env.DEBUG === '1') {
      console.error(`DEBUG: Activity summary - signatures found: ${signatures.length}, checked: ${checkedSignatures.length}, mintEvents: ${mintEvents}, transfers: ${transfers}, swaps: ${swaps}`);
      if (signatures.length > 0 && mintEvents === 0 && transfers === 0 && swaps === 0) {
        console.error(`DEBUG: WARNING: Found ${signatures.length} signatures but no activity detected. This may be because:`);
        console.error(`DEBUG:   1. DEX trades don't involve the mint address directly (they use token accounts)`);
        console.error(`DEBUG:   2. Transactions may be archived or unparseable`);
        console.error(`DEBUG:   3. Use 'tokenctl tx <mint>' to see transfers from token accounts`);
      }
    }

    return {
      events,
      mintEvents,
      transfers,
      swaps,
      signaturesFound: signatures.length,
      signaturesChecked: checkedSignatures.length,
      checkedSignatures,
      allSignatures: signatures, // Keep original signatures for display
      observed: true
    };
  } catch (e) {
    // If we hit rate limits or other errors, return partial results instead of throwing
    const errorMsg = e.message || String(e);
    const isRateLimit = errorMsg.includes('429') || 
                       errorMsg.includes('rate limit') ||
                       errorMsg.includes('timeout') ||
                       errorMsg.includes('timed out');
    
    if (process.env.DEBUG === '1') {
      console.error(`DEBUG: getRecentActivity error: ${errorMsg}`);
    }
    
    // Return partial results if we have any
    if (events.length > 0 || signatures.length > 0) {
      return {
        events,
        mintEvents,
        transfers,
        swaps: 0,
        signaturesFound: signatures.length,
        signaturesChecked: checkedSignatures.length,
        checkedSignatures,
        allSignatures: signatures,
        observed: true
      };
    }
    
    // If we have no results and it's a rate limit, throw so rpcRetry can handle it
    if (isRateLimit) {
      throw e;
    }
    
    // For other errors, return empty results
    return {
      events: [],
      mintEvents: 0,
      transfers: 0,
      swaps: 0,
      signaturesFound: 0,
      signaturesChecked: 0,
      checkedSignatures: [],
      allSignatures: [],
      observed: false
    };
  }
}

// DEX Program IDs
const RAYDIUM_V4 = '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8';
const RAYDIUM_CLMM = 'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK';
const JUPITER_V6 = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4';
const JUPITER_V4 = 'JUP4Fb2cqiRUauTHVu89rAMUo44NQvCyZaa9mxs6bqf';
const ORCA_WHIRLPOOL = 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc';
const ORCA_V2 = '9W959DqEETiGZocYWCQPaJ6sBmUzgfxXfqGeTEdp3aQP';

function parseTransaction(tx, mintAddress) {
  const result = { 
    mintEvent: false, 
    transfer: false, 
    swap: false,
    mintAmount: 0, 
    transferAmount: 0,
    swapAmount: 0,
    swapType: null // 'buy' or 'sell'
  };

  if (!tx.transaction || !tx.transaction.message) {
    return result;
  }

  const instructions = tx.transaction.message.instructions || [];
  const accountKeys = tx.transaction.message.accountKeys || [];
  
  // Check for DEX swaps first (most useful)
  for (const ix of instructions) {
    const programId = ix.programId || (typeof ix.program === 'string' ? ix.program : null);
    
    // Check if this is a DEX program
    if (programId === RAYDIUM_V4 || programId === RAYDIUM_CLMM || 
        programId === JUPITER_V6 || programId === JUPITER_V4 ||
        programId === ORCA_WHIRLPOOL || programId === ORCA_V2) {
      
      // Look for token transfers involving our mint in the transaction
      // DEX swaps create token transfers as inner instructions
      result.swap = true;
      result.swapType = 'trade'; // We'll refine this if we can determine direction
    }
  }

  // Parse token transfers to find amounts
  for (const ix of instructions) {
    if (ix.program === 'spl-token' || ix.programId === 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA') {
      if (ix.parsed && ix.parsed.type === 'mintTo') {
        if (ix.parsed.info.mint === mintAddress) {
          result.mintEvent = true;
          result.mintAmount = parseAmount(ix.parsed.info.tokenAmount);
        }
      }
      if (ix.parsed && ix.parsed.type === 'transfer') {
        if (ix.parsed.info.mint === mintAddress) {
          result.transfer = true;
          const amount = parseAmount(ix.parsed.info.tokenAmount);
          if (amount > result.transferAmount) {
            result.transferAmount = amount;
          }
        }
      }
    }
  }

  // Check inner instructions (where DEX swaps often show token movements)
  const innerInstructions = tx.meta?.innerInstructions || [];
  for (const inner of innerInstructions) {
    for (const ix of inner.instructions) {
      if (ix.program === 'spl-token' || ix.programId === 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA') {
        if (ix.parsed && ix.parsed.type === 'mintTo') {
          if (ix.parsed.info.mint === mintAddress) {
            result.mintEvent = true;
            result.mintAmount = parseAmount(ix.parsed.info.tokenAmount);
          }
        }
        if (ix.parsed && ix.parsed.type === 'transfer') {
          if (ix.parsed.info.mint === mintAddress) {
            result.transfer = true;
            const amount = parseAmount(ix.parsed.info.tokenAmount);
            if (amount > result.transferAmount) {
              result.transferAmount = amount;
            }
            // If we detected a swap, use transfer amount as swap amount
            if (result.swap && amount > result.swapAmount) {
              result.swapAmount = amount;
            }
          }
        }
      }
    }
  }

  // Try to determine buy vs sell by looking at pre/post token balances
  if (result.swap && tx.meta && tx.meta.preTokenBalances && tx.meta.postTokenBalances) {
    const preBalances = tx.meta.preTokenBalances.filter(b => b.mint === mintAddress);
    const postBalances = tx.meta.postTokenBalances.filter(b => b.mint === mintAddress);
    
    // If user's balance increased, it's a buy
    // If user's balance decreased, it's a sell
    // This is simplified - real DEX swaps are more complex
  }

  return result;
}

function parseAmount(tokenAmount) {
  if (!tokenAmount) return 0;
  if (typeof tokenAmount === 'string') {
    return parseFloat(tokenAmount) || 0;
  }
  if (tokenAmount.uiAmount !== undefined) {
    return tokenAmount.uiAmount || 0;
  }
  if (tokenAmount.amount) {
    return parseFloat(tokenAmount.amount) || 0;
  }
  return 0;
}

module.exports = {
  getRecentActivity
};


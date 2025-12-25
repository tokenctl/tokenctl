const { PublicKey } = require('@solana/web3.js');

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function getRecentActivity(connection, mintAddress, limit = 50, hours = 24) {
  const mintPubkey = new PublicKey(mintAddress);
  const cutoffTime = Date.now() - (hours * 60 * 60 * 1000);
  
  let signatures;
  try {
    signatures = await connection.getSignaturesForAddress(mintPubkey, { limit });
  } catch (e) {
    if (e.message && (e.message.includes('429') || e.message.includes('rate limit'))) {
      throw new Error('RPC rate limit exceeded. Try again later or use a different RPC endpoint.');
    }
    throw e;
  }

  const events = [];
  let mintEvents = 0;
  let transfers = 0;
  let swaps = 0;
  const checkedSignatures = [];
  const maxTxs = Math.min(limit, signatures.length);

  for (let i = 0; i < signatures.length && i < maxTxs; i++) {
    const sig = signatures[i];
    if (sig.blockTime && sig.blockTime * 1000 < cutoffTime) {
      break;
    }

    if (i > 0) {
      await sleep(2000);
    }

    let tx = null;
    let parseError = null;
    
    // Try jsonParsed first, fallback to base64 if it fails
    try {
      tx = await connection.getTransaction(sig.signature, {
        maxSupportedTransactionVersion: 0,
        encoding: 'jsonParsed'
      });
    } catch (e) {
      // If jsonParsed fails, try base64
      try {
        tx = await connection.getTransaction(sig.signature, {
          maxSupportedTransactionVersion: 0,
          encoding: 'base64'
        });
        // If we got base64, we can't parse it easily, so skip
        if (tx) {
          checkedSignatures.push({
            signature: sig.signature,
            time: sig.blockTime,
            status: 'unparseable',
            error: 'Transaction format not supported',
            hasEvent: false
          });
          continue;
        }
      } catch (e2) {
        parseError = e2.message;
      }
    }

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

    if (parseError || !tx.transaction) {
      checkedSignatures.push({
        signature: sig.signature,
        time: sig.blockTime,
        status: 'error',
        error: parseError || 'Invalid transaction',
        hasEvent: false
      });
      continue;
    }

    const parsed = parseTransaction(tx, mintAddress);
    const hasEvent = parsed.mintEvent || parsed.transfer || parsed.swap;
    
    checkedSignatures.push({
      signature: sig.signature,
      time: sig.blockTime,
      status: tx.meta.err ? 'failed' : 'success',
      error: tx.meta.err,
      hasEvent
    });

      if (parsed.swap) {
        // DEX swap - this is what users actually want to see
        swaps++;
        events.push({
          signature: sig.signature,
          time: sig.blockTime,
          type: 'swap',
          amount: parsed.swapAmount || parsed.transferAmount,
          swapType: parsed.swapType
        });
      } else if (parsed.mintEvent) {
        mintEvents++;
        events.push({
          signature: sig.signature,
          time: sig.blockTime,
          type: 'mint',
          amount: parsed.mintAmount
        });
      } else if (parsed.transfer) {
        transfers++;
        events.push({
          signature: sig.signature,
          time: sig.blockTime,
          type: 'transfer',
          amount: parsed.transferAmount
        });
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


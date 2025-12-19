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
  const maxTxs = Math.min(limit, 5);

  for (let i = 0; i < signatures.length && i < maxTxs; i++) {
    const sig = signatures[i];
    if (sig.blockTime && sig.blockTime * 1000 < cutoffTime) {
      break;
    }

    if (i > 0) {
      await sleep(2000);
    }

    try {
      const tx = await connection.getTransaction(sig.signature, {
        maxSupportedTransactionVersion: 0,
        encoding: 'jsonParsed'
      });

      if (!tx || !tx.meta) continue;

      const parsed = parseTransaction(tx, mintAddress);
      if (parsed.mintEvent) {
        mintEvents++;
        events.push({
          signature: sig.signature,
          time: sig.blockTime,
          type: 'mint',
          amount: parsed.mintAmount
        });
      }
      if (parsed.transfer) {
        transfers++;
        events.push({
          signature: sig.signature,
          time: sig.blockTime,
          type: 'transfer',
          amount: parsed.transferAmount
        });
      }
    } catch (e) {
      // Skip failed transactions
      continue;
    }
  }

  return {
    events,
    mintEvents,
    transfers,
    observed: true
  };
}

function parseTransaction(tx, mintAddress) {
  const result = { mintEvent: false, transfer: false, mintAmount: 0, transferAmount: 0 };

  if (!tx.transaction || !tx.transaction.message) {
    return result;
  }

  const instructions = tx.transaction.message.instructions || [];
  
  for (const ix of instructions) {
    if (ix.program === 'spl-token' || ix.programId === 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA') {
      if (ix.parsed && ix.parsed.type === 'mintTo') {
        if (ix.parsed.info.mint === mintAddress) {
          result.mintEvent = true;
          result.mintAmount = parseAmount(ix.parsed.info.tokenAmount);
        }
      }
      if (ix.parsed && ix.parsed.type === 'transfer') {
        if (ix.parsed.info.mint === mintAddress || 
            (ix.parsed.info.source && ix.parsed.info.destination)) {
          result.transfer = true;
          result.transferAmount = parseAmount(ix.parsed.info.tokenAmount);
        }
      }
    }
  }

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
          result.transfer = true;
          result.transferAmount = parseAmount(ix.parsed.info.tokenAmount);
        }
      }
    }
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


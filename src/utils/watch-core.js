// Canonical transaction fetching and transfer parsing module
// This is the ONLY place that calls connection.getTransaction and parses transfer events
// Pure functions: no logging, no retries, no side effects

const { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } = require('./mint');

/**
 * Fetch a single transaction (pure function, no retries)
 * @param {Connection} connection - Solana connection
 * @param {string} signature - Transaction signature
 * @param {object} options - Options (encoding, commitment, maxSupportedTransactionVersion)
 * @returns {Promise<object|null>} Transaction or null if not found
 */
async function fetchTransaction(connection, signature, options = {}) {
  const {
    encoding = 'jsonParsed',
    commitment = 'confirmed',
    maxSupportedTransactionVersion = 0
  } = options;

  try {
    const tx = await connection.getTransaction(signature, {
      encoding,
      commitment,
      maxSupportedTransactionVersion
    });
    return tx;
  } catch (e) {
    // Pure function: throw errors, don't handle them
    throw e;
  }
}

/**
 * Parse transfer events from a transaction (pure function, no logging)
 * Supports both SPL Token and Token-2022
 * @param {object} tx - Transaction object
 * @param {string} mintAddress - Mint address to filter for
 * @returns {Array} Array of transfer/mint events
 */
function parseTransferEvents(tx, mintAddress) {
  const events = [];
  
  if (!tx || !tx.transaction || !tx.meta) {
    return events;
  }

  const mintStr = mintAddress;
  const splTokenProgramId = TOKEN_PROGRAM_ID.toString();
  const token2022ProgramId = TOKEN_2022_PROGRAM_ID.toString();

  // Method 1: Check pre/post token balances (most reliable)
  const preBalances = tx.meta.preTokenBalances || [];
  const postBalances = tx.meta.postTokenBalances || [];
  
  // Build maps of pre/post balances by account
  const preMap = new Map();
  const postMap = new Map();
  
  // Normalize mint address for comparison
  const normalizeMint = (m) => {
    if (!m) return null;
    const mStr = typeof m === 'string' ? m : m.toString();
    return mStr.toLowerCase().trim();
  };
  const normalizedMint = normalizeMint(mintStr);
  
  for (const pre of preBalances) {
    const preMint = normalizeMint(pre.mint);
    if (preMint === normalizedMint) {
      const key = pre.owner || `index:${pre.accountIndex}`;
      const amount = parseFloat(pre.uiTokenAmount?.uiAmountString || pre.uiTokenAmount?.uiAmount || 0);
      preMap.set(key, { amount, owner: pre.owner, accountIndex: pre.accountIndex });
    }
  }
  
  for (const post of postBalances) {
    const postMint = normalizeMint(post.mint);
    if (postMint === normalizedMint) {
      const key = post.owner || `index:${post.accountIndex}`;
      const amount = parseFloat(post.uiTokenAmount?.uiAmountString || post.uiTokenAmount?.uiAmount || 0);
      postMap.set(key, { amount, owner: post.owner, accountIndex: post.accountIndex });
    }
  }
  
  // Find all accounts with balance changes
  const allAccounts = new Set([...preMap.keys(), ...postMap.keys()]);
  
  for (const accountKey of allAccounts) {
    const pre = preMap.get(accountKey) || { amount: 0 };
    const post = postMap.get(accountKey) || { amount: 0 };
    const change = post.amount - pre.amount;
    
    if (Math.abs(change) > 0.000001) { // Ignore tiny rounding errors
      const owner = post.owner || pre.owner || accountKey;
      
      if (change > 0) {
        // Received tokens - find who sent (look for negative change)
        let source = null;
        let bestMatch = Infinity;
        for (const [otherKey, otherPre] of preMap.entries()) {
          if (otherKey === accountKey) continue;
          const otherPost = postMap.get(otherKey) || { amount: 0 };
          const otherChange = otherPost.amount - otherPre.amount;
          if (otherChange < -0.000001) {
            const diff = Math.abs(Math.abs(otherChange) - change);
            if (diff < bestMatch && diff < change * 0.1) {
              bestMatch = diff;
              source = otherPre.owner || otherPost.owner || otherKey;
            }
          }
        }
        
        events.push({
          type: 'transfer',
          amount: change,
          source: source || 'unknown',
          destination: owner,
          timestamp: tx.blockTime
        });
      } else if (change < 0) {
        // Sent tokens - find who received (look for positive change)
        let destination = null;
        let bestMatch = Infinity;
        for (const [otherKey, otherPre] of preMap.entries()) {
          if (otherKey === accountKey) continue;
          const otherPost = postMap.get(otherKey) || { amount: 0 };
          const otherChange = otherPost.amount - otherPre.amount;
          if (otherChange > 0.000001) {
            const diff = Math.abs(Math.abs(change) - otherChange);
            if (diff < bestMatch && diff < Math.abs(change) * 0.1) {
              bestMatch = diff;
              destination = otherPost.owner || otherPre.owner || otherKey;
            }
          }
        }
        
        events.push({
          type: 'transfer',
          amount: Math.abs(change),
          source: owner,
          destination: destination || 'unknown',
          timestamp: tx.blockTime
        });
      }
    }
  }

  // Method 2: Parse instructions (backup method)
  // Now supports both SPL Token and Token-2022
  const instructions = (tx.transaction?.message?.instructions) || [];
  for (const ix of instructions) {
    const isSPLToken = ix.program === 'spl-token' || 
                      ix.programId === splTokenProgramId;
    const isToken2022 = ix.program === 'token-2022' || 
                        ix.programId === token2022ProgramId;
    
    // Accept both SPL Token and Token-2022 instructions
    if (isSPLToken || isToken2022) {
      if (ix.parsed) {
        if (ix.parsed.type === 'transfer' || ix.parsed.type === 'transferChecked') {
          const info = ix.parsed.info;
          if (info) {
            let involvesOurMint = false;
            
            if (info.mint === mintStr) {
              involvesOurMint = true;
            } else {
              const sourceInMap = info.source && (preMap.has(info.source) || postMap.has(info.source));
              const destInMap = info.destination && (preMap.has(info.destination) || postMap.has(info.destination));
              if (sourceInMap || destInMap) {
                involvesOurMint = true;
              }
            }
            
            if (involvesOurMint) {
              const amount = info.tokenAmount?.uiAmount || parseFloat(info.amount || 0) / 1e9 || 0;
              if (amount > 0) {
                events.push({
                  type: 'transfer',
                  amount,
                  source: info.source || 'unknown',
                  destination: info.destination || 'unknown',
                  timestamp: tx.blockTime
                });
              }
            }
          }
        }
        if (ix.parsed.type === 'mintTo' || ix.parsed.type === 'mintToChecked') {
          const info = ix.parsed.info;
          if (info && info.mint === mintStr) {
            const amount = info.tokenAmount?.uiAmount || parseFloat(info.amount || 0) / 1e9 || 0;
            if (amount > 0) {
              events.push({
                type: 'mint',
                amount,
                destination: info.account || info.destination || 'unknown',
                timestamp: tx.blockTime
              });
            }
          }
        }
      }
    }
  }

  // Check inner instructions
  // Now supports both SPL Token and Token-2022
  const innerInstructions = tx.meta.innerInstructions || [];
  for (const inner of innerInstructions) {
    const innerIxs = inner.instructions || [];
    for (const ix of innerIxs) {
      const isSPLToken = ix.program === 'spl-token' || 
                        ix.programId === splTokenProgramId;
      const isToken2022 = ix.program === 'token-2022' || 
                          ix.programId === token2022ProgramId;
      
      // Accept both SPL Token and Token-2022 instructions
      if (isSPLToken || isToken2022) {
        if (ix.parsed) {
          if (ix.parsed.type === 'transfer' || ix.parsed.type === 'transferChecked') {
            const info = ix.parsed.info;
            if (info) {
              let involvesOurMint = false;
              if (info.mint === mintStr) {
                involvesOurMint = true;
              } else {
                const sourceInMap = info.source && (preMap.has(info.source) || postMap.has(info.source));
                const destInMap = info.destination && (preMap.has(info.destination) || postMap.has(info.destination));
                if (sourceInMap || destInMap) {
                  involvesOurMint = true;
                }
              }
              
              if (involvesOurMint) {
                const amount = info.tokenAmount?.uiAmount || parseFloat(info.amount || 0) / 1e9 || 0;
                if (amount > 0) {
                  events.push({
                    type: 'transfer',
                    amount,
                    source: info.source || 'unknown',
                    destination: info.destination || 'unknown',
                    timestamp: tx.blockTime
                  });
                }
              }
            }
          }
          if (ix.parsed.type === 'mintTo' || ix.parsed.type === 'mintToChecked') {
            const info = ix.parsed.info;
            if (info && info.mint === mintStr) {
              const amount = info.tokenAmount?.uiAmount || parseFloat(info.amount || 0) / 1e9 || 0;
              if (amount > 0) {
                events.push({
                  type: 'mint',
                  amount,
                  destination: info.account || info.destination || 'unknown',
                  timestamp: tx.blockTime
                });
              }
            }
          }
        }
      }
    }
  }

  // Method 3: Fallback - check all transfer instructions if mint found in balances
  // Now supports both SPL Token and Token-2022
  const knownTokenAccounts = new Set([...preMap.keys(), ...postMap.keys()]);
  
  if (knownTokenAccounts.size > 0 || preBalances.some(b => b.mint === mintStr) || postBalances.some(b => b.mint === mintStr)) {
    const allInstructions = [
      ...(tx.transaction?.message?.instructions || []),
      ...(tx.meta?.innerInstructions || []).flatMap(inner => inner.instructions || [])
    ];
    
    const allTokenAccountsInTx = new Set();
    for (const pre of preBalances) {
      if (pre.owner) allTokenAccountsInTx.add(pre.owner);
    }
    for (const post of postBalances) {
      if (post.owner) allTokenAccountsInTx.add(post.owner);
    }
    
    for (const ix of allInstructions) {
      // Accept both SPL Token and Token-2022
      if (ix.program === 'spl-token' || ix.program === 'token-2022' || 
          ix.programId === splTokenProgramId || ix.programId === token2022ProgramId) {
        if (ix.parsed && (ix.parsed.type === 'transfer' || ix.parsed.type === 'transferChecked')) {
          const info = ix.parsed.info;
          if (info) {
            const sourceInMap = info.source && (knownTokenAccounts.has(info.source) || allTokenAccountsInTx.has(info.source));
            const destInMap = info.destination && (knownTokenAccounts.has(info.destination) || allTokenAccountsInTx.has(info.destination));
            const mintMatches = info.mint === mintStr;
            
            if (sourceInMap || destInMap || mintMatches) {
              const amount = info.tokenAmount?.uiAmount || parseFloat(info.amount || 0) / 1e9 || 0;
              if (amount > 0) {
                // Check if we already have this event (avoid duplicates)
                const alreadyExists = events.some(e => 
                  e.type === 'transfer' &&
                  Math.abs(e.amount - amount) < 0.000001 &&
                  e.source === (info.source || 'unknown') &&
                  e.destination === (info.destination || 'unknown')
                );
                
                if (!alreadyExists) {
                  events.push({
                    type: 'transfer',
                    amount,
                    source: info.source || 'unknown',
                    destination: info.destination || 'unknown',
                    timestamp: tx.blockTime
                  });
                }
              }
            }
          }
        }
      }
    }
  }

  // Deduplicate events
  const uniqueEvents = [];
  const seen = new Set();
  for (const event of events) {
    const key = `${event.type}-${event.amount.toFixed(6)}-${event.source}-${event.destination}`;
    if (!seen.has(key)) {
      seen.add(key);
      uniqueEvents.push(event);
    }
  }

  return uniqueEvents;
}

module.exports = {
  fetchTransaction,
  parseTransferEvents
};

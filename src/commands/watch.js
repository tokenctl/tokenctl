const { PublicKey } = require('@solana/web3.js');
const { getRpcUrl, createConnection, validateMint, rpcRetry, sleep } = require('../utils/rpc');
const { fetchMintInfo } = require('../utils/mint');

function formatTime() {
  const date = new Date();
  return date.toISOString().replace('T', ' ').substring(0, 19);
}

async function watchCommand(mint, options) {
  if (!validateMint(mint)) {
    console.error('Error: Invalid mint address');
    process.exit(1);
  }

  const rpcUrl = getRpcUrl(options);
  const connection = createConnection(rpcUrl);
  const interval = parseInt(options.interval) || 30;
  const transferThreshold = parseFloat(options.transferThreshold) || 1000000;
  const mintThreshold = parseFloat(options.mintThreshold) || 1000000;

  let lastMintInfo = null;
  let lastSupply = null;
  let lastSignature = null;

  console.log(`[${formatTime()}] WATCH start`);
  console.log(`Monitoring: ${mint}`);
  console.log(`Interval: ${interval}s`);
  console.log('');

  let checkCount = 0;

  while (true) {
    try {
      process.stderr.write(`[${formatTime()}] Checking...\r`);
      const mintInfo = await rpcRetry(() => fetchMintInfo(connection, mint));
      
      if (!mintInfo) {
        console.log(`\n[${formatTime()}] RPC error, retrying in ${interval}s...`);
        await sleep(interval * 1000);
        continue;
      }
      
      checkCount++;
      
      // Format supply properly
      let supplyDisplay = 'unknown';
      if (mintInfo.supplyRaw && mintInfo.decimals) {
        const rawAmount = BigInt(mintInfo.supplyRaw);
        const divisor = BigInt(10 ** mintInfo.decimals);
        const wholePart = rawAmount / divisor;
        const fractionalPart = rawAmount % divisor;
        const fractionalStr = fractionalPart.toString().padStart(mintInfo.decimals, '0');
        const cleanFractional = fractionalStr.replace(/0+$/, '');
        const supplyValue = cleanFractional ? `${wholePart.toString()}.${cleanFractional}` : wholePart.toString();
        const parts = supplyValue.split('.');
        parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
        supplyDisplay = parts.join('.');
      } else {
        supplyDisplay = mintInfo.supply.toLocaleString();
      }
      
      // Print status every check
      console.log(`[${formatTime()}] Check #${checkCount} - Supply: ${supplyDisplay}, Auth: ${mintInfo.mintAuthority ? 'EXISTS' : 'revoked'}`);
      
      if (lastMintInfo) {
        if (mintInfo.mintAuthority?.toString() !== lastMintInfo.mintAuthority?.toString() ||
            mintInfo.freezeAuthority?.toString() !== lastMintInfo.freezeAuthority?.toString()) {
          console.log(`[${formatTime()}] ALERT authority_change`);
          console.log(`  Mint Auth: ${mintInfo.mintAuthority ? mintInfo.mintAuthority.toString() : 'revoked'}`);
          console.log(`  Freeze Auth: ${mintInfo.freezeAuthority ? mintInfo.freezeAuthority.toString() : 'revoked'}`);
        }

        if (mintInfo.supply !== lastSupply) {
          console.log(`[${formatTime()}] ALERT supply_change`);
          console.log(`  Previous: ${lastSupply.toLocaleString()}`);
          console.log(`  Current: ${mintInfo.supply.toLocaleString()}`);
        }
      }

      lastMintInfo = mintInfo;
      lastSupply = mintInfo.supply;

      try {
        const signatures = await rpcRetry(() => 
          connection.getSignaturesForAddress(new PublicKey(mint), { limit: 10 })
        );

        if (signatures && signatures.length > 0) {
          const newestSig = signatures[0].signature;
          
          if (lastSignature && newestSig !== lastSignature) {
            const newSigs = [];
            let foundLast = false;
            
            for (const sig of signatures) {
              if (sig.signature === lastSignature) {
                foundLast = true;
                break;
              }
              newSigs.push(sig);
            }

            if (!foundLast) {
              newSigs.push(...signatures.slice(0, 5));
            }

            for (const sig of newSigs) {
              try {
                const tx = await rpcRetry(() => 
                  connection.getTransaction(sig.signature, {
                    maxSupportedTransactionVersion: 0,
                    encoding: 'jsonParsed'
                  })
                );

                if (!tx || !tx.meta) continue;

                const parsed = parseTransaction(tx, mint);
                
                if (parsed.mintEvent && parsed.mintAmount >= mintThreshold) {
                  console.log(`[${formatTime()}] ALERT mint_event ${parsed.mintAmount.toLocaleString()}`);
                  console.log(`  Signature: ${sig.signature}`);
                }

                if (parsed.transfer && parsed.transferAmount >= transferThreshold) {
                  console.log(`[${formatTime()}] ALERT large_transfer ${parsed.transferAmount.toLocaleString()}`);
                  console.log(`  Signature: ${sig.signature}`);
                }
              } catch (e) {
                continue;
              }
            }
          }

          lastSignature = newestSig;
        }
      } catch (e) {
        // Continue on signature fetch errors
      }

      await sleep(interval * 1000);

    } catch (e) {
      console.error(`[${formatTime()}] Error: ${e.message}`);
      await sleep(interval * 1000);
    }
  }
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
        result.transfer = true;
        result.transferAmount = parseAmount(ix.parsed.info.tokenAmount);
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

module.exports = watchCommand;

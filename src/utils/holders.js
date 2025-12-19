const { PublicKey } = require('@solana/web3.js');
const { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } = require('./mint');

const TOKEN_ACCOUNT_LAYOUT = {
  mint: 0,
  owner: 32,
  amount: 64,
  state: 72,
  isNative: 73,
  delegate: 74,
  delegatedAmount: 106,
  closeAuthority: 138
};

function parseTokenAccount(data) {
  if (data.length < 165) {
    return null;
  }
  
  const mint = new PublicKey(data.slice(TOKEN_ACCOUNT_LAYOUT.mint, TOKEN_ACCOUNT_LAYOUT.owner));
  const owner = new PublicKey(data.slice(TOKEN_ACCOUNT_LAYOUT.owner, TOKEN_ACCOUNT_LAYOUT.amount));
  const amount = data.readBigUInt64LE(TOKEN_ACCOUNT_LAYOUT.amount);
  
  return {
    mint: mint.toString(),
    owner: owner.toString(),
    amount: Number(amount)
  };
}

async function getTokenHolders(connection, mintAddress, maxAccounts = 5000) {
  const mintPubkey = new PublicKey(mintAddress);
  
  // Get token supply for percentage calculations
  let tokenSupply = null;
  try {
    const supply = await connection.getTokenSupply(mintPubkey);
    tokenSupply = supply.value;
  } catch (e) {
    // Continue without supply
  }
  
  // Get largest accounts (fast and reliable)
  let largestAccounts = [];
  try {
    const result = await connection.getTokenLargestAccounts(mintPubkey);
    // getTokenLargestAccounts returns { value: [...] }
    largestAccounts = result.value || result || [];
    if (process.env.DEBUG === '1') {
      console.error(`DEBUG: getTokenLargestAccounts returned ${largestAccounts.length} accounts`);
      if (largestAccounts.length > 0) {
        console.error(`DEBUG: Top account: ${largestAccounts[0].address.toString()}, amount: ${largestAccounts[0].amount}`);
      }
    }
  } catch (e) {
    if (process.env.DEBUG === '1') {
      console.error(`DEBUG: getTokenLargestAccounts failed: ${e.message}`);
    }
  }
  
  // Calculate top 1 and top 10 from largest accounts
  let top1Percent = 0;
  let top10Percent = 0;
  const totalSupplyAmount = tokenSupply ? Number(tokenSupply.amount) : null;
  
  if (largestAccounts && largestAccounts.length > 0 && totalSupplyAmount && totalSupplyAmount > 0) {
    // Use raw amount for accurate percentage
    const top1Amount = Number(largestAccounts[0].amount);
    top1Percent = (top1Amount / totalSupplyAmount) * 100;
    
    const top10 = largestAccounts.slice(0, Math.min(10, largestAccounts.length));
    const top10Amount = top10.reduce((sum, acc) => sum + Number(acc.amount), 0);
    top10Percent = (top10Amount / totalSupplyAmount) * 100;
    
    if (process.env.DEBUG === '1') {
      console.error(`DEBUG: Top 1%: ${top1Percent.toFixed(2)}%, Top 10%: ${top10Percent.toFixed(2)}%`);
      console.error(`DEBUG: Total supply: ${totalSupplyAmount}, Top 1 amount: ${top1Amount}`);
    }
  } else {
    if (process.env.DEBUG === '1') {
      console.error(`DEBUG: Cannot calculate percentages - largestAccounts: ${largestAccounts?.length || 0}, totalSupplyAmount: ${totalSupplyAmount}`);
    }
  }
  
  // Get total holders count via getProgramAccounts
  let accounts = [];
  let partial = false;
  
  // Try both Token and Token 2022 programs
  const programs = [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID];
  
  for (const programId of programs) {
    try {
      // Use base58 string for memcmp (some RPCs prefer this)
      const programAccounts = await connection.getProgramAccounts(programId, {
        filters: [
          {
            dataSize: 165
          },
          {
            memcmp: {
              offset: 0,
              bytes: mintPubkey.toBase58()
            }
          }
        ],
        dataSlice: {
          offset: 0,
          length: 165
        }
      });
      
      if (programAccounts.length > 0) {
        accounts = programAccounts;
        if (process.env.DEBUG === '1') {
          console.error(`DEBUG: Found ${accounts.length} accounts for program ${programId.toString()}`);
        }
        break;
      }
    } catch (e) {
      if (process.env.DEBUG === '1') {
        console.error(`DEBUG: getProgramAccounts failed for ${programId.toString()}: ${e.message}`);
      }
      // Try next program
      continue;
    }
  }
  
  // If base58 didn't work, try with Buffer
  if (accounts.length === 0) {
    for (const programId of programs) {
      try {
        const programAccounts = await connection.getProgramAccounts(programId, {
          filters: [
            {
              dataSize: 165
            },
            {
              memcmp: {
                offset: 0,
                bytes: mintPubkey.toBuffer()
              }
            }
          ],
          dataSlice: {
            offset: 0,
            length: 165
          }
        });
        
        if (programAccounts.length > 0) {
          accounts = programAccounts;
          if (process.env.DEBUG === '1') {
            console.error(`DEBUG: Found ${accounts.length} accounts with Buffer format`);
          }
          break;
        }
      } catch (e) {
        // Try next program
        continue;
      }
    }
  }
  
  if (accounts.length >= maxAccounts) {
    partial = true;
    accounts = accounts.slice(0, maxAccounts);
  }

  // Count holders with balance > 0
  let totalHolders = 0;
  for (const account of accounts) {
    const parsed = parseTokenAccount(account.account.data);
    if (parsed && parsed.amount > 0) {
      totalHolders++;
    }
  }
  
  // If getProgramAccounts returned results but we're capped, note it
  if (partial && totalHolders > 0) {
    // We have a partial count
  } else if (totalHolders === 0 && accounts.length > 0) {
    // All accounts have 0 balance (unlikely but possible)
    if (process.env.DEBUG === '1') {
      console.error(`DEBUG: Found ${accounts.length} accounts but all have 0 balance`);
    }
  } else if (totalHolders === 0 && largestAccounts && largestAccounts.length > 0) {
    // Fallback: if we can't get program accounts but have largest accounts, 
    // we know there are at least that many holders
    // Note: This is a minimum estimate, not the actual total
    totalHolders = largestAccounts.length;
    if (process.env.DEBUG === '1') {
      console.error(`DEBUG: Using largest accounts count as minimum holder estimate: ${totalHolders}`);
    }
  }

  return {
    totalHolders,
    top1Percent,
    top10Percent,
    partial
  };
}

function calculateConcentration(holdersData) {
  if (!holdersData) {
    return { top1: 0, top10: 0 };
  }
  return {
    top1: holdersData.top1Percent || 0,
    top10: holdersData.top10Percent || 0
  };
}

module.exports = {
  getTokenHolders,
  calculateConcentration
};

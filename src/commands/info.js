// CLI truth command: tokenctl info <mint>
// Outputs token program, support status, and reason if unsupported
// No analytics, no TUI, no extras - just the facts

const { getRpcUrl, createConnection, validateMint, rpcRetry } = require('../utils/rpc');
const { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } = require('../utils/mint');
const { PublicKey } = require('@solana/web3.js');

async function infoCommand(mint, options) {
  if (!validateMint(mint)) {
    console.error('Error: Invalid mint address');
    process.exit(1);
  }

  const rpcUrl = getRpcUrl(options);
  const connection = createConnection(rpcUrl);

  try {
    // Fetch mint account to determine program
    const mintPubkey = new PublicKey(mint);
    const accountInfo = await rpcRetry(() => connection.getAccountInfo(mintPubkey));
    
    if (!accountInfo) {
      console.error('Error: Mint account not found');
      process.exit(1);
    }

    const ownerStr = accountInfo.owner.toString();
    let tokenProgram = 'unknown';
    let supported = false;
    let reason = '';

    if (ownerStr === TOKEN_PROGRAM_ID.toString()) {
      tokenProgram = 'spl-token';
      supported = true;
    } else if (ownerStr === TOKEN_2022_PROGRAM_ID.toString()) {
      tokenProgram = 'token-2022';
      supported = true;
    } else {
      tokenProgram = 'unknown';
      supported = false;
      reason = `Unknown token program: ${ownerStr}. Only SPL Token (Tokenkeg) is supported.`;
    }

    // Output
    console.log(`Token Program: ${tokenProgram}`);
    console.log(`Supported: ${supported ? 'yes' : 'no'}`);
    if (!supported && reason) {
      console.log(`Reason: ${reason}`);
    }

  } catch (e) {
    console.error(`Error: ${e.message}`);
    process.exit(1);
  }
}

module.exports = infoCommand;

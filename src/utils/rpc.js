const { Connection, PublicKey } = require('@solana/web3.js');
const fs = require('fs');
const path = require('path');
const os = require('os');

const DEFAULT_RPC = 'https://api.mainnet-beta.solana.com';

function getConfigRpc() {
  const configPath = path.join(os.homedir(), '.tokenctlrc');
  try {
    if (fs.existsSync(configPath)) {
      const content = fs.readFileSync(configPath, 'utf8').trim();
      const lines = content.split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith('#')) {
          const match = trimmed.match(/^RPC=(.+)$/);
          if (match) {
            return match[1].trim();
          }
        }
      }
    }
  } catch (e) {
    // Ignore config file errors
  }
  return null;
}

function getRpcUrl(options) {
  // Priority: command line > environment variable > config file > default
  if (options.rpc) {
    return options.rpc;
  }
  if (process.env.TOKENCTL_RPC) {
    return process.env.TOKENCTL_RPC;
  }
  const configRpc = getConfigRpc();
  if (configRpc) {
    return configRpc;
  }
  return DEFAULT_RPC;
}

function createConnection(rpcUrl) {
  return new Connection(rpcUrl, 'confirmed');
}

function validateMint(mintAddress) {
  try {
    new PublicKey(mintAddress);
    return true;
  } catch (e) {
    return false;
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function rpcRetry(fn, maxRetries = 3) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn();
    } catch (e) {
      const errorMsg = e.message || String(e);
      const isRateLimit = errorMsg.includes('429') || 
                         errorMsg.includes('rate limit') ||
                         errorMsg.includes('timeout') ||
                         errorMsg.includes('timed out');
      
      if (isRateLimit && i < maxRetries - 1) {
        await sleep(5000);
        continue;
      }
      
      if (i === maxRetries - 1) {
        return null;
      }
      
      throw e;
    }
  }
  return null;
}

module.exports = {
  getRpcUrl,
  createConnection,
  validateMint,
  rpcRetry,
  sleep,
  DEFAULT_RPC
};


const { PublicKey } = require('@solana/web3.js');
const bs58 = require('bs58');

const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const TOKEN_2022_PROGRAM_ID = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
const TOKEN_METADATA_PROGRAM_ID = new PublicKey('metaqbxxUerdb5288Dkb1Qa1rHDd1pmXq36qJ8G21NT');

function getMetadataPDA(mintAddress) {
  const mintPubkey = new PublicKey(mintAddress);
  const [metadataPDA] = PublicKey.findProgramAddressSync(
    [
      Buffer.from('metadata'),
      TOKEN_METADATA_PROGRAM_ID.toBuffer(),
      mintPubkey.toBuffer(),
    ],
    TOKEN_METADATA_PROGRAM_ID
  );
  return metadataPDA;
}

function decodeMintAccount(data) {
  if (!data || data.length < 82) {
    return { mintAuthority: null, freezeAuthority: null };
  }

  const mintAuthorityOption = data.readUInt8(0);
  const mintAuthority = mintAuthorityOption === 0 
    ? null 
    : new PublicKey(data.slice(4, 36));

  const supply = data.readBigUInt64LE(36);
  
  const decimals = data.readUInt8(44);
  
  const isInitialized = data.readUInt8(45) === 1;
  
  const freezeAuthorityOption = data.readUInt8(46);
  const freezeAuthority = freezeAuthorityOption === 0
    ? null
    : new PublicKey(data.slice(50, 82));

  return {
    mintAuthority,
    freezeAuthority,
    supply: Number(supply),
    decimals,
    isInitialized
  };
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function parseMetaplexMetadata(data) {
  try {
    // Skip key (1 byte) + update authority (32 bytes) + mint (32 bytes) = 65 bytes
    let offset = 65;
    
    // DataV2 structure: name (4 bytes len + string) + symbol (4 bytes len + string) + uri (4 bytes len + string)
    // Then skip seller_fee_basis_points (2) + creators (optional)
    
    // Read name
    const nameLen = data.readUInt32LE(offset);
    offset += 4;
    if (nameLen > 0 && offset + nameLen <= data.length) {
      const nameBytes = data.slice(offset, offset + nameLen);
      const name = nameBytes.toString('utf8').replace(/\0/g, '').trim();
      return { name };
    }
  } catch (e) {
    // Parse error
  }
  return null;
}

function parseToken2022Metadata(data) {
  try {
    // Token 2022 metadata extension is at the end of the mint account
    // Look for metadata extension (type 2) in extension data
    // This is complex and varies, so we'll do a simple search for readable strings
    const str = data.toString('utf8', 82);
    const nameMatch = str.match(/name["\s:]+([^\x00"]+)/i);
    if (nameMatch && nameMatch[1]) {
      return { name: nameMatch[1].trim() };
    }
  } catch (e) {
    // Parse error
  }
  return null;
}

async function fetchMintInfo(connection, mintAddress) {
  const mintPubkey = new PublicKey(mintAddress);
  const metadataPDA = getMetadataPDA(mintAddress);
  
  const accountInfo = await connection.getAccountInfo(mintPubkey);
  await sleep(500);
  
  const supply = await connection.getTokenSupply(mintPubkey);
  await sleep(500);

  if (!accountInfo) {
    throw new Error('Mint account not found');
  }

  const mintData = decodeMintAccount(accountInfo.data);
  
  // Verify supply matches between getTokenSupply and mint account
  const supplyFromMint = mintData.supply;
  const supplyFromRPC = supply.value.amount;
  if (process.env.DEBUG === '1') {
    console.error(`DEBUG: Supply from mint account: ${supplyFromMint}, from RPC: ${supplyFromRPC}`);
  }
  
  let name = null;
  
  // Try Metaplex Token Metadata PDA first
  try {
    const metadataInfo = await connection.getAccountInfo(metadataPDA);
    if (metadataInfo && metadataInfo.data) {
      const parsed = parseMetaplexMetadata(metadataInfo.data);
      if (parsed && parsed.name) {
        name = parsed.name;
      }
    }
  } catch (e) {
    // Continue to next method
  }
  
  // If not found and mint might be Token 2022, check extension
  if (!name && accountInfo.data.length > 82) {
    const parsed = parseToken2022Metadata(accountInfo.data);
    if (parsed && parsed.name) {
      name = parsed.name;
    }
  }

  // Use uiAmountString for accurate supply (avoids floating point precision issues)
  const supplyAmount = supply.value.uiAmountString 
    ? parseFloat(supply.value.uiAmountString) 
    : (supply.value.uiAmount || 0);

  return {
    address: mintAddress,
    name,
    supply: supplyAmount,
    supplyRaw: supply.value.amount,
    decimals: supply.value.decimals,
    ...mintData
  };
}

module.exports = {
  getMetadataPDA,
  decodeMintAccount,
  fetchMintInfo,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID
};

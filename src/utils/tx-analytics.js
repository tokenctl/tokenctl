// Analytics functions for tx command
// Computes wallet stats, roles, patterns, and signal strength from transfer events

/**
 * Compute wallet statistics from transfer events
 * @param {Array} events - Array of transfer/mint events with source, destination, amount, timestamp
 * @returns {Map} Map of wallet address -> stats object
 */
function computeWalletStats(events) {
  const stats = new Map();
  
  // Ensure events is an array
  if (!Array.isArray(events)) {
    return stats;
  }
  
  for (const event of events) {
    if (!event || typeof event !== 'object' || event.type !== 'transfer') continue;
    if (event.source === 'unknown' && event.destination === 'unknown') continue;
    
    // Track outbound (source)
    if (event.source !== 'unknown') {
      const walletStats = stats.get(event.source) || {
        inbound_count: 0,
        outbound_count: 0,
        inbound_total: 0,
        outbound_total: 0,
        counterparties: new Set(),
        timestamps: []
      };
      walletStats.outbound_count++;
      walletStats.outbound_total += event.amount;
      if (event.destination !== 'unknown') {
        walletStats.counterparties.add(event.destination);
      }
      walletStats.timestamps.push(event.timestamp || 0);
      stats.set(event.source, walletStats);
    }
    
    // Track inbound (destination)
    if (event.destination !== 'unknown') {
      const walletStats = stats.get(event.destination) || {
        inbound_count: 0,
        outbound_count: 0,
        inbound_total: 0,
        outbound_total: 0,
        counterparties: new Set(),
        timestamps: []
      };
      walletStats.inbound_count++;
      walletStats.inbound_total += event.amount;
      if (event.source !== 'unknown') {
        walletStats.counterparties.add(event.source);
      }
      walletStats.timestamps.push(event.timestamp || 0);
      stats.set(event.destination, walletStats);
    }
  }
  
  // Convert to final format
  const result = new Map();
  for (const [address, walletStats] of stats.entries()) {
    const netFlow = walletStats.inbound_total - walletStats.outbound_total;
    const totalVolume = walletStats.inbound_total + walletStats.outbound_total;
    const uniqueCounterparties = walletStats.counterparties.size;
    
    // Calculate burstiness: measure of time clustering
    // Lower burstiness = more evenly distributed, higher = more clustered
    let burstiness = 0;
    if (walletStats.timestamps.length > 1) {
      const sorted = walletStats.timestamps.sort((a, b) => a - b);
      const intervals = [];
      for (let i = 1; i < sorted.length; i++) {
        intervals.push(sorted[i] - sorted[i - 1]);
      }
      if (intervals.length > 0) {
        const mean = intervals.reduce((a, b) => a + b, 0) / intervals.length;
        const variance = intervals.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / intervals.length;
        const stdDev = Math.sqrt(variance);
        // Burstiness = (stdDev - mean) / (stdDev + mean), normalized to 0-1
        burstiness = mean > 0 ? Math.max(0, Math.min(1, (stdDev - mean) / (stdDev + mean + 1))) : 0;
      }
    }
    
    result.set(address, {
      inbound_count: walletStats.inbound_count,
      outbound_count: walletStats.outbound_count,
      inbound_total: walletStats.inbound_total,
      outbound_total: walletStats.outbound_total,
      net_flow: netFlow,
      total_volume: totalVolume,
      unique_counterparties: uniqueCounterparties,
      burstiness: burstiness
    });
  }
  
  return result;
}

/**
 * Classify wallet roles based on stats
 * @param {Map} walletStats - Map of address -> stats
 * @param {Array} topTokenAccounts - Array of top token accounts with address and amount
 * @returns {Map} Map of address -> role
 */
function classifyWalletRoles(walletStats, topTokenAccounts = []) {
  const roles = new Map();
  
  // Sort wallets by total volume for ranking
  const sortedByVolume = Array.from(walletStats.entries())
    .sort((a, b) => b[1].total_volume - a[1].total_volume);
  
  // Create map of top accounts for Dormant Whale detection
  const topAccountMap = new Map();
  for (const acc of topTokenAccounts) {
    const addr = acc.address ? acc.address.toString() : acc.address;
    topAccountMap.set(addr, acc);
  }
  
  for (const [address, stats] of walletStats.entries()) {
    // Distributor: outbound_count >= 3 and net_flow is negative and outbound_total is top 1 by volume
    if (stats.outbound_count >= 3 && stats.net_flow < 0 && sortedByVolume[0] && sortedByVolume[0][0] === address) {
      roles.set(address, 'Distributor');
      continue;
    }
    
    // Accumulator: inbound_count >= 3 and net_flow positive and inbound_total among top 3
    if (stats.inbound_count >= 3 && stats.net_flow > 0) {
      const top3Inbound = Array.from(walletStats.entries())
        .sort((a, b) => b[1].inbound_total - a[1].inbound_total)
        .slice(0, 3)
        .map(([addr]) => addr);
      if (top3Inbound.includes(address)) {
        roles.set(address, 'Accumulator');
        continue;
      }
    }
    
    // Relay: total_volume high but abs(net_flow) <= 10% of total_volume and counterparties >= 3
    if (stats.total_volume > 0 && Math.abs(stats.net_flow) <= (stats.total_volume * 0.1) && stats.unique_counterparties >= 3) {
      roles.set(address, 'Relay');
      continue;
    }
    
    // Sink: inbound_total high with outbound_count == 0
    if (stats.inbound_total > 0 && stats.outbound_count === 0) {
      roles.set(address, 'Sink');
      continue;
    }
    
    // Dormant Whale: large balance but no events in window
    // Check if this address is in top accounts but has no activity
    if (topAccountMap.has(address) && stats.total_volume === 0) {
      roles.set(address, 'Dormant Whale');
      continue;
    }
  }
  
  return roles;
}

/**
 * Determine pattern label from events and wallet stats
 * @param {Array} events - Array of transfer events
 * @param {Map} walletStats - Map of address -> stats
 * @param {Map} roles - Map of address -> role
 * @returns {Object} { pattern, scenarios }
 */
function determinePattern(events, walletStats, roles) {
  const transferEvents = events.filter(e => e.type === 'transfer');
  
  if (transferEvents.length === 0) {
    return {
      pattern: 'Quiet',
      scenarios: ['No activity observed in time window']
    };
  }
  
  // Count roles
  const distributors = Array.from(roles.entries()).filter(([_, role]) => role === 'Distributor');
  const accumulators = Array.from(roles.entries()).filter(([_, role]) => role === 'Accumulator');
  const relays = Array.from(roles.entries()).filter(([_, role]) => role === 'Relay');
  
  // Check for Concentrated Distribution
  if (distributors.length === 1 && distributors[0]) {
    const distAddr = distributors[0][0];
    const distStats = walletStats.get(distAddr);
    if (distStats && distStats.outbound_count >= 2) {
      // Check if sends to 2+ unique recipients
      const recipients = new Set();
      for (const event of transferEvents) {
        if (event.source === distAddr && event.destination !== 'unknown') {
          recipients.add(event.destination);
        }
      }
      if (recipients.size >= 2) {
        // Check time clustering
        const distEvents = transferEvents.filter(e => e.source === distAddr);
        if (distEvents.length > 0) {
          const timestamps = distEvents.map(e => e.timestamp || 0).sort((a, b) => a - b);
          const timeSpan = timestamps[timestamps.length - 1] - timestamps[0];
          const avgInterval = timeSpan / (timestamps.length - 1);
          // If events are clustered (short intervals relative to window), it's concentrated
          const hours = (Date.now() / 1000 - timestamps[0]) / 3600;
          if (avgInterval < hours * 0.3 || distEvents.length >= 5) {
            return {
              pattern: 'Concentrated Distribution',
              scenarios: ['Controlled distribution', 'Airdrop or reward distribution', 'Treasury rebalance']
            };
          }
        }
      }
    }
  }
  
  // Check for Consolidation
  if (accumulators.length >= 1 && distributors.length >= 2) {
    return {
      pattern: 'Consolidation',
      scenarios: ['Treasury rebalance', 'Liquidity movement', 'Controlled distribution']
    };
  }
  
  // Check for Churn
  if (relays.length >= 2) {
    const relayVolumes = relays.map(([addr]) => walletStats.get(addr)?.total_volume || 0);
    const totalRelayVolume = relayVolumes.reduce((a, b) => a + b, 0);
    const totalVolume = Array.from(walletStats.values()).reduce((sum, s) => sum + s.total_volume, 0);
    if (totalRelayVolume > totalVolume * 0.5) {
      return {
        pattern: 'Churn',
        scenarios: ['Bot routing', 'Liquidity movement', 'Market maker activity']
      };
    }
  }
  
  // Default to Quiet if low activity
  if (transferEvents.length < 5) {
    return {
      pattern: 'Quiet',
      scenarios: ['Low activity period', 'Normal trading', 'Limited observation window']
    };
  }
  
  // Mixed pattern
  return {
    pattern: 'Mixed Activity',
    scenarios: ['Normal trading', 'Liquidity movement', 'Market maker activity']
  };
}

/**
 * Calculate signal strength and confidence
 * @param {Array} events - Array of transfer events
 * @param {Map} walletStats - Map of address -> stats
 * @returns {Object} { feature_ratings, confidence }
 */
function calculateSignalStrength(events, walletStats) {
  const transferEvents = events.filter(e => e.type === 'transfer');
  const totalEventCount = transferEvents.length;
  const totalVolume = Array.from(walletStats.values()).reduce((sum, s) => sum + s.total_volume, 0);
  
  // Feature 1: Observed Transfers
  let transferRating = 'Low';
  if (totalEventCount >= 20) {
    transferRating = 'High';
  } else if (totalEventCount >= 10) {
    transferRating = 'Medium';
  }
  
  // Feature 2: Wallet Concentration
  const sortedByVolume = Array.from(walletStats.entries())
    .sort((a, b) => b[1].total_volume - a[1].total_volume);
  const top1Volume = sortedByVolume[0] ? sortedByVolume[0][1].total_volume : 0;
  const top1Share = totalVolume > 0 ? top1Volume / totalVolume : 0;
  
  let concentrationRating = 'Low';
  if (top1Share >= 0.5) {
    concentrationRating = 'High';
  } else if (top1Share >= 0.3) {
    concentrationRating = 'Medium';
  }
  
  // Feature 3: Time Clustering
  let clusteringRating = 'Low';
  if (transferEvents.length > 0) {
    const timestamps = transferEvents.map(e => e.timestamp || 0).sort((a, b) => a - b);
    if (timestamps.length > 1) {
      const intervals = [];
      for (let i = 1; i < timestamps.length; i++) {
        intervals.push(timestamps[i] - timestamps[i - 1]);
      }
      const mean = intervals.reduce((a, b) => a + b, 0) / intervals.length;
      const variance = intervals.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / intervals.length;
      const stdDev = Math.sqrt(variance);
      const cv = mean > 0 ? stdDev / mean : 0; // Coefficient of variation
      // Low CV = clustered, High CV = spread out
      if (cv < 0.5) {
        clusteringRating = 'High';
      } else if (cv < 1.0) {
        clusteringRating = 'Medium';
      }
    }
  }
  
  // Confidence calculation (weighted formula)
  // Based on: event count, data completeness, volume diversity
  let confidence = 0.0;
  
  // Event count component (0-0.4)
  const eventComponent = Math.min(0.4, totalEventCount / 50);
  
  // Data completeness component (0-0.3)
  const unknownCount = transferEvents.filter(e => e.source === 'unknown' || e.destination === 'unknown').length;
  const completeness = totalEventCount > 0 ? 1 - (unknownCount / totalEventCount) : 0;
  const completenessComponent = completeness * 0.3;
  
  // Volume diversity component (0-0.3)
  // More diverse = higher confidence (less concentration)
  const diversityComponent = (1 - top1Share) * 0.3;
  
  confidence = eventComponent + completenessComponent + diversityComponent;
  confidence = Math.max(0.0, Math.min(1.0, confidence)); // Clamp to 0-1
  
  return {
    feature_ratings: {
      'Observed Transfers': transferRating,
      'Wallet Concentration': concentrationRating,
      'Time Clustering': clusteringRating
    },
    confidence: parseFloat(confidence.toFixed(2))
  };
}

/**
 * Generate story section (2-4 sentences)
 * @param {Array} events - Array of transfer events
 * @param {Map} walletStats - Map of address -> stats
 * @param {Map} roles - Map of address -> role
 * @returns {string} Story text
 */
function generateStory(events, walletStats, roles) {
  const transferEvents = events.filter(e => e.type === 'transfer');
  if (transferEvents.length === 0) {
    return 'No transfer activity observed in the time window.';
  }
  
  const sortedByVolume = Array.from(walletStats.entries())
    .sort((a, b) => b[1].total_volume - a[1].total_volume);
  
  const topWallet = sortedByVolume[0];
  const sentences = [];
  
  if (topWallet) {
    const [addr, stats] = topWallet;
    const role = roles.get(addr);
    
    if (stats.net_flow < 0) {
      // Net outflow
      const recipients = new Set();
      for (const event of transferEvents) {
        if (event.source === addr && event.destination !== 'unknown') {
          recipients.add(event.destination);
        }
      }
      sentences.push(`Dominant wallet ${addr} distributed ${Math.abs(stats.net_flow).toLocaleString('en-US', { maximumFractionDigits: 2 })} tokens to ${recipients.size} recipient${recipients.size !== 1 ? 's' : ''}.`);
    } else if (stats.net_flow > 0) {
      // Net inflow
      sentences.push(`Primary accumulator ${addr} received ${stats.net_flow.toLocaleString('en-US', { maximumFractionDigits: 2 })} tokens across ${stats.inbound_count} transaction${stats.inbound_count !== 1 ? 's' : ''}.`);
    }
  }
  
  // Add clustering info
  if (transferEvents.length > 0) {
    const timestamps = transferEvents.map(e => e.timestamp || 0).sort((a, b) => a - b);
    const timeSpan = timestamps[timestamps.length - 1] - timestamps[0];
    const hours = timeSpan / 3600;
    if (hours < 6 && transferEvents.length >= 5) {
      sentences.push(`Activity was clustered within ${hours.toFixed(1)} hours.`);
    } else if (transferEvents.length >= 10) {
      sentences.push(`Activity was distributed across ${hours.toFixed(1)} hours.`);
    }
  }
  
  // Add pattern description
  const distributors = Array.from(roles.values()).filter(r => r === 'Distributor').length;
  const accumulators = Array.from(roles.values()).filter(r => r === 'Accumulator').length;
  
  if (distributors > 0 && accumulators === 0) {
    sentences.push('Movement appears concentrated from a single source.');
  } else if (accumulators > 0 && distributors === 0) {
    sentences.push('Movement appears concentrated toward accumulation wallets.');
  } else if (distributors > 0 && accumulators > 0) {
    sentences.push('Movement shows both distribution and accumulation patterns.');
  } else {
    sentences.push('Activity shows mixed patterns without dominant actors.');
  }
  
  // Ensure 2-4 sentences
  if (sentences.length === 0) {
    return `Observed ${transferEvents.length} transfer${transferEvents.length !== 1 ? 's' : ''} with ${walletStats.size} active wallet${walletStats.size !== 1 ? 's' : ''}.`;
  }
  
  return sentences.slice(0, 4).join(' ');
}

/**
 * Detect known DEX programs from transaction data
 * @param {Array} transactions - Array of transaction objects
 * @returns {Array} Array of detected program names
 */
function detectDEXPrograms(transactions) {
  const knownPrograms = {
    '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8': 'Raydium V4',
    'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK': 'Raydium CLMM',
    'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4': 'Jupiter V6',
    'JUP4Fb2cqiRUauTHVu89rAMUo44NQvCyZaa9mxs6bqf': 'Jupiter V4',
    'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc': 'Orca Whirlpool',
    '9W959DqEETiGZocYWCQPaJ6sBmUzgfxXfqGeTEdp3aQP': 'Orca V2'
  };
  
  const detected = new Set();
  
  for (const tx of transactions) {
    if (!tx || !tx.transaction || !tx.transaction.message) continue;
    
    const instructions = tx.transaction.message.instructions || [];
    for (const ix of instructions) {
      const programId = ix.programId || (typeof ix.program === 'string' ? ix.program : null);
      if (programId && knownPrograms[programId]) {
        detected.add(knownPrograms[programId]);
      }
    }
    
    const innerInstructions = tx.meta?.innerInstructions || [];
    for (const inner of innerInstructions) {
      const innerIxs = inner.instructions || [];
      for (const ix of innerIxs) {
        const programId = ix.programId || (typeof ix.program === 'string' ? ix.program : null);
        if (programId && knownPrograms[programId]) {
          detected.add(knownPrograms[programId]);
        }
      }
    }
  }
  
  return Array.from(detected);
}

module.exports = {
  computeWalletStats,
  classifyWalletRoles,
  determinePattern,
  calculateSignalStrength,
  generateStory,
  detectDEXPrograms
};






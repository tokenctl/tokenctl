// Analytics functions for watch command
// Tracks baseline behavior, detects drift, role changes, and dormant activations

const { computeWalletStats, classifyWalletRoles, detectDEXPrograms } = require('./tx-analytics');

/**
 * Compute interval metrics from transfer events
 * @param {Array} events - Array of transfer events
 * @returns {Object} Interval metrics
 */
function computeIntervalMetrics(events) {
  const transferEvents = events.filter(e => e.type === 'transfer');
  
  if (transferEvents.length === 0) {
    return {
      transfers_per_interval: 0,
      avg_transfer_size: 0,
      unique_wallets_per_interval: 0,
      dominant_wallet_share: 0,
      total_volume: 0
    };
  }
  
  const walletStats = computeWalletStats(transferEvents);
  const uniqueWallets = new Set();
  const walletVolumes = new Map();
  
  for (const event of transferEvents) {
    if (event.source !== 'unknown') uniqueWallets.add(event.source);
    if (event.destination !== 'unknown') uniqueWallets.add(event.destination);
    
    if (event.source !== 'unknown') {
      walletVolumes.set(event.source, (walletVolumes.get(event.source) || 0) + event.amount);
    }
    if (event.destination !== 'unknown') {
      walletVolumes.set(event.destination, (walletVolumes.get(event.destination) || 0) + event.amount);
    }
  }
  
  const totalVolume = transferEvents.reduce((sum, e) => sum + e.amount, 0);
  const avgTransferSize = totalVolume / transferEvents.length;
  
  // Find dominant wallet share
  let dominantWalletShare = 0;
  if (walletVolumes.size > 0) {
    const sortedVolumes = Array.from(walletVolumes.entries())
      .sort((a, b) => b[1] - a[1]);
    const topWalletVolume = sortedVolumes[0][1];
    dominantWalletShare = totalVolume > 0 ? topWalletVolume / totalVolume : 0;
  }
  
  return {
    transfers_per_interval: transferEvents.length,
    avg_transfer_size: avgTransferSize,
    unique_wallets_per_interval: uniqueWallets.size,
    dominant_wallet_share: dominantWalletShare,
    total_volume: totalVolume
  };
}

/**
 * Maintain rolling baseline from intervals
 * @param {Array} intervalMetrics - Array of interval metric objects
 * @param {number} baselineIntervals - Number of intervals to use for baseline (default: 3)
 * @returns {Object} Baseline metrics or null if not enough data
 */
function computeBaseline(intervalMetrics, baselineIntervals = 3) {
  if (intervalMetrics.length < baselineIntervals) {
    return null;
  }
  
  // Use most recent N intervals for baseline
  const recent = intervalMetrics.slice(-baselineIntervals);
  
  const transfers = recent.map(m => m.transfers_per_interval);
  const avgSizes = recent.map(m => m.avg_transfer_size);
  const uniqueWallets = recent.map(m => m.unique_wallets_per_interval);
  const dominantShares = recent.map(m => m.dominant_wallet_share);
  
  return {
    transfers_per_interval: transfers.reduce((a, b) => a + b, 0) / transfers.length,
    avg_transfer_size: avgSizes.reduce((a, b) => a + b, 0) / avgSizes.length,
    unique_wallets_per_interval: uniqueWallets.reduce((a, b) => a + b, 0) / uniqueWallets.length,
    dominant_wallet_share: dominantShares.reduce((a, b) => a + b, 0) / dominantShares.length,
    intervals_observed: intervalMetrics.length
  };
}

/**
 * Detect behavioral drift from baseline
 * @param {Object} currentMetrics - Current interval metrics
 * @param {Object} baseline - Baseline metrics
 * @param {boolean} strict - Use stricter thresholds (1.5x instead of 2x)
 * @returns {Array} Array of drift alerts
 */
function detectDrift(currentMetrics, baseline, strict = false) {
  const alerts = [];
  const threshold = strict ? 1.5 : 2.0;
  
  if (!baseline) return alerts;
  
  // Transfer rate spike
  if (baseline.transfers_per_interval > 0) {
    const ratio = currentMetrics.transfers_per_interval / baseline.transfers_per_interval;
    if (ratio > threshold) {
      alerts.push({
        type: 'transfer_rate_spike',
        explanation: `Transfer count ${currentMetrics.transfers_per_interval} exceeds baseline ${baseline.transfers_per_interval.toFixed(1)} by ${(ratio * 100).toFixed(0)}%`
      });
    }
  }
  
  // Volume spike (avg transfer size)
  if (baseline.avg_transfer_size > 0) {
    const ratio = currentMetrics.avg_transfer_size / baseline.avg_transfer_size;
    if (ratio > threshold) {
      alerts.push({
        type: 'volume_spike',
        explanation: `Average transfer size ${currentMetrics.avg_transfer_size.toFixed(2)} exceeds baseline ${baseline.avg_transfer_size.toFixed(2)} by ${(ratio * 100).toFixed(0)}%`
      });
    }
  }
  
  // Counterparties spike
  if (baseline.unique_wallets_per_interval > 0) {
    const ratio = currentMetrics.unique_wallets_per_interval / baseline.unique_wallets_per_interval;
    if (ratio > threshold) {
      alerts.push({
        type: 'counterparties_spike',
        explanation: `Unique wallets ${currentMetrics.unique_wallets_per_interval} exceeds baseline ${baseline.unique_wallets_per_interval.toFixed(1)} by ${(ratio * 100).toFixed(0)}%`
      });
    }
  }
  
  return alerts;
}

/**
 * Track wallet roles across intervals and detect changes
 * @param {Map} currentRoles - Current interval roles (address -> role)
 * @param {Map} previousRoles - Previous interval roles (address -> role)
 * @param {Array} topTokenAccounts - Top token accounts for role classification
 * @returns {Array} Array of role change alerts
 */
function detectRoleChanges(currentRoles, previousRoles, topTokenAccounts = []) {
  const alerts = [];
  
  // Check for role changes
  for (const [address, currentRole] of currentRoles.entries()) {
    const previousRole = previousRoles.get(address);
    
    if (previousRole && previousRole !== currentRole) {
      alerts.push({
        type: 'role_change',
        wallet: address,
        old_role: previousRole,
        new_role: currentRole,
        explanation: `${address} changed from ${previousRole} to ${currentRole}`
      });
    }
  }
  
  // Check for new Distributors
  for (const [address, role] of currentRoles.entries()) {
    if (role === 'Distributor' && !previousRoles.has(address)) {
      alerts.push({
        type: 'new_distributor',
        wallet: address,
        explanation: `New Distributor detected: ${address}`
      });
    }
  }
  
  return alerts;
}

/**
 * Detect dormant wallet activation
 * @param {Array} currentEvents - Current interval events
 * @param {Set} activeWallets - Set of wallets that were active in previous intervals
 * @param {number} threshold - Minimum amount to trigger alert
 * @returns {Array} Array of dormant activation alerts
 */
function detectDormantActivation(currentEvents, activeWallets, threshold = 0) {
  const alerts = [];
  const transferEvents = currentEvents.filter(e => e.type === 'transfer');
  
  // Track wallets active in this interval
  const currentActiveWallets = new Set();
  const walletAmounts = new Map();
  
  for (const event of transferEvents) {
    if (event.source !== 'unknown') {
      currentActiveWallets.add(event.source);
      walletAmounts.set(event.source, (walletAmounts.get(event.source) || 0) + event.amount);
    }
    if (event.destination !== 'unknown') {
      currentActiveWallets.add(event.destination);
      walletAmounts.set(event.destination, (walletAmounts.get(event.destination) || 0) + event.amount);
    }
  }
  
  // Find wallets that are active now but weren't before
  for (const wallet of currentActiveWallets) {
    if (!activeWallets.has(wallet)) {
      const amount = walletAmounts.get(wallet) || 0;
      if (amount >= threshold) {
        alerts.push({
          type: 'dormant_activation',
          wallet: wallet,
          amount: amount,
          explanation: `Dormant wallet ${wallet} activated with ${amount.toFixed(2)} tokens`
        });
      }
    }
  }
  
  return alerts;
}

/**
 * Calculate signal confidence based on intervals observed and event density
 * @param {number} intervalsObserved - Number of intervals in baseline
 * @param {number} currentEventCount - Current interval event count
 * @param {number} baselineEventCount - Baseline average event count
 * @returns {number} Confidence score 0.00-1.00
 */
function calculateSignalConfidence(intervalsObserved, currentEventCount, baselineEventCount) {
  // Base confidence on number of intervals (more = higher confidence)
  let confidence = Math.min(1.0, intervalsObserved / 5.0);
  
  // Adjust based on event density (more events = higher confidence)
  if (baselineEventCount > 0) {
    const densityRatio = currentEventCount / baselineEventCount;
    // Higher density increases confidence, but cap at 1.0
    confidence = Math.min(1.0, confidence * (1 + Math.min(1.0, densityRatio * 0.2)));
  }
  
  return Math.max(0.0, Math.min(1.0, confidence));
}

/**
 * Detect structural security issues
 * @param {Object} currentMetrics - Current interval metrics
 * @param {Object} baseline - Baseline metrics
 * @param {Array} transactions - Current interval transactions
 * @param {boolean} authorityChanged - Whether authority changed in this interval
 * @param {number} dominantThreshold - Threshold for dominant wallet share alert (default: 0.6)
 * @returns {Array} Array of structural security alerts
 */
function detectStructuralAlerts(currentMetrics, baseline, transactions, authorityChanged, dominantThreshold = 0.6) {
  const alerts = [];
  
  // First DEX interaction
  const dexPrograms = detectDEXPrograms(transactions);
  if (dexPrograms.length > 0) {
    alerts.push({
      type: 'first_dex_interaction',
      dex_programs: dexPrograms,
      explanation: `First DEX interaction detected: ${dexPrograms.join(', ')}`
    });
  }
  
  // Dominant wallet share
  if (currentMetrics.dominant_wallet_share > dominantThreshold) {
    alerts.push({
      type: 'dominant_wallet_share',
      share: currentMetrics.dominant_wallet_share,
      explanation: `Dominant wallet controls ${(currentMetrics.dominant_wallet_share * 100).toFixed(1)}% of interval volume`
    });
  }
  
  // Authority change with increased activity
  if (authorityChanged && baseline) {
    const activityIncrease = currentMetrics.transfers_per_interval > baseline.transfers_per_interval * 1.5;
    if (activityIncrease) {
      alerts.push({
        type: 'authority_activity_coincidence',
        explanation: `Authority change coincided with ${((currentMetrics.transfers_per_interval / baseline.transfers_per_interval) * 100).toFixed(0)}% increase in transfer activity`
      });
    }
  }
  
  return alerts;
}

module.exports = {
  computeIntervalMetrics,
  computeBaseline,
  detectDrift,
  detectRoleChanges,
  detectDormantActivation,
  calculateSignalConfidence,
  detectStructuralAlerts,
  computeWalletStats,
  classifyWalletRoles
};


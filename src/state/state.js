// Centralized immutable state management for watch/live commands
// All data flows through a single state object that updates atomically per interval

const crypto = require('crypto');

/**
 * Create initial state object
 */
function createInitialState(mint, options) {
  return {
    // Immutable config
    config: {
      mint,
      interval: parseInt(options.interval) || 30,
      transferThreshold: parseFloat(options.transferThreshold) || 1000000,
      mintThreshold: parseFloat(options.mintThreshold) || 1000000,
      strict: options.strict || false,
      rpcUrl: null, // Set on start
      record: options.record || false,
      replay: options.replay || null
    },
    
    // Token metadata (cached, refreshed periodically)
    token: {
      name: null,
      decimals: null,
      program: 'spl-token', // 'spl-token' | 'token-2022'
      supply: {
        display: 'unknown',
        raw: null,
        decimals: null
      },
      authorities: {
        mint_authority: null,
        freeze_authority: null
      },
      topTokenAccounts: [],
      metadataCacheAge: 0 // intervals since last refresh
    },
    
    // Baseline tracking
    baseline: {
      status: 'forming', // 'forming' | 'established'
      intervals_observed: 0,
      transfers_per_interval: 0,
      avg_transfer_size: 0,
      unique_wallets_per_interval: 0,
      dominant_wallet_share: 0
    },
    
    // Time series data (rolling window of 30 points)
    series: {
      transfers: [],
      wallets: [],
      avgSize: [],
      dominantShare: []
    },
    
    // Current interval metrics
    currentInterval: {
      checkCount: 0,
      timestamp: null,
      transfers: 0,
      mints: 0,
      totalVolume: 0,
      uniqueWallets: 0,
      avgTransferSize: 0,
      dominantWalletShare: 0,
      integrity: {
        valid: true,
        errors: []
      },
      partial: false,
      last_refresh_ms: 0 // Monotonic refresh marker - updates every interval
    },
    
    // Wallet roles (current interval)
    roles: [],
    
    // Alerts (last 20, with deduplication)
    alerts: [],
    alertHistory: {}, // alert_id -> last occurrence (plain object for serialization)
    
    // Performance metrics
    performance: {
      signatures_fetch_ms: 0,
      transactions_fetch_ms: 0,
      parse_ms: 0,
      analytics_ms: 0,
      render_ms: 0,
      total_ms: 0
    },
    
    // Internal tracking (not part of immutable state)
    _internal: {
      previousRoles: new Map(),
      activeWallets: new Set(),
      firstDEXDetected: false,
      lastMintInfo: null,
      lastSupply: null,
      lastSignature: null,
      intervalMetrics: [], // For baseline computation
      processedSignatures: new Set(), // Cache for signature deduplication
      mintMetadataCache: null,
      mintMetadataCacheAge: 0
    }
  };
}

/**
 * Create immutable state update (returns new state object)
 */
function updateState(currentState, updates) {
  // Deep clone current state
  const newState = JSON.parse(JSON.stringify(currentState));
  
  // Update specified fields
  if (updates.token) {
    Object.assign(newState.token, updates.token);
  }
  if (updates.baseline) {
    Object.assign(newState.baseline, updates.baseline);
  }
  if (updates.series) {
    // CRITICAL: Replace entire series object to ensure arrays are properly updated
    newState.series = updates.series;
  }
  if (updates.currentInterval) {
    Object.assign(newState.currentInterval, updates.currentInterval);
  }
  if (updates.roles) {
    newState.roles = updates.roles;
  }
  if (updates.alerts) {
    newState.alerts = updates.alerts;
  }
  if (updates.alertHistory) {
    newState.alertHistory = updates.alertHistory;
  }
  if (updates.performance) {
    Object.assign(newState.performance, updates.performance);
  }
  if (updates._internal) {
    // Merge internal state (not deep cloned)
    Object.assign(newState._internal, updates._internal);
  }
  
  // Restore Set objects in _internal (JSON.stringify destroys Sets)
  if (newState._internal) {
    // Restore processedSignatures as Set
    if (currentState._internal && currentState._internal.processedSignatures instanceof Set) {
      // Preserve existing Set if it exists
      newState._internal.processedSignatures = currentState._internal.processedSignatures;
    } else if (updates._internal && updates._internal.processedSignatures instanceof Set) {
      // Use Set from updates if provided
      newState._internal.processedSignatures = updates._internal.processedSignatures;
    } else {
      // Recreate Set from array if it was serialized, or create new Set
      const existing = newState._internal.processedSignatures;
      if (Array.isArray(existing)) {
        newState._internal.processedSignatures = new Set(existing);
      } else if (!(existing instanceof Set)) {
        newState._internal.processedSignatures = new Set();
      }
    }
    
    // Restore activeWallets as Set
    if (currentState._internal && currentState._internal.activeWallets instanceof Set) {
      newState._internal.activeWallets = currentState._internal.activeWallets;
    } else if (updates._internal && updates._internal.activeWallets instanceof Set) {
      newState._internal.activeWallets = updates._internal.activeWallets;
    } else {
      const existing = newState._internal.activeWallets;
      if (Array.isArray(existing)) {
        newState._internal.activeWallets = new Set(existing);
      } else if (!(existing instanceof Set)) {
        newState._internal.activeWallets = new Set();
      }
    }
    
    // Restore previousRoles as Map
    if (currentState._internal && currentState._internal.previousRoles instanceof Map) {
      newState._internal.previousRoles = currentState._internal.previousRoles;
    } else {
      const existing = newState._internal.previousRoles;
      if (Array.isArray(existing)) {
        newState._internal.previousRoles = new Map(existing);
      } else if (!(existing instanceof Map)) {
        newState._internal.previousRoles = new Map();
      }
    }
  }
  
  return newState;
}

/**
 * Validate interval data integrity
 */
function validateIntervalIntegrity(interval, state, intervalEvents, mintInfo) {
  const errors = [];
  
  // dominant_share ∈ [0,100]
  if (interval.dominantWalletShare < 0 || interval.dominantWalletShare > 100) {
    errors.push(`dominant_wallet_share out of range: ${interval.dominantWalletShare}`);
  }
  
  // transfers and unique_wallets are non-negative integers
  if (!Number.isInteger(interval.transfers) || interval.transfers < 0) {
    errors.push(`transfers must be non-negative integer: ${interval.transfers}`);
  }
  if (!Number.isInteger(interval.uniqueWallets) || interval.uniqueWallets < 0) {
    errors.push(`unique_wallets must be non-negative integer: ${interval.uniqueWallets}`);
  }
  
  // avg_transfer_size = 0 when transfers = 0
  if (interval.transfers === 0 && interval.avgTransferSize !== 0) {
    errors.push(`avg_transfer_size must be 0 when transfers = 0: ${interval.avgTransferSize}`);
  }
  
  // total_volume = 0 when transfers = 0
  if (interval.transfers === 0 && interval.totalVolume !== 0) {
    errors.push(`total_volume must be 0 when transfers = 0: ${interval.totalVolume}`);
  }
  
  // Supply changes require mint or burn events
  if (mintInfo && state._internal.lastSupply !== null && state._internal.lastSupply !== undefined) {
    const currentSupply = mintInfo.supply || mintInfo.supplyRaw;
    if (currentSupply !== null && currentSupply !== undefined) {
      const supplyChanged = currentSupply !== state._internal.lastSupply;
      if (supplyChanged) {
        const mintEvents = intervalEvents.filter(e => e.type === 'mint');
        const supplyIncrease = currentSupply > state._internal.lastSupply;
        const supplyDecrease = currentSupply < state._internal.lastSupply;
        
        if (supplyIncrease && mintEvents.length === 0) {
          errors.push(`supply increased from ${state._internal.lastSupply} to ${currentSupply} but no mint events found`);
        }
        if (supplyDecrease && mintEvents.length === 0) {
          errors.push(`supply decreased from ${state._internal.lastSupply} to ${currentSupply} but no burn events found`);
        }
      }
    }
  }
  
  return {
    valid: errors.length === 0,
    errors
  };
}

/**
 * Generate stable alert ID for deduplication
 * Hash of: type + wallet + condition_key
 */
function generateAlertId(alert) {
  const type = alert.type || 'unknown';
  const wallet = alert.wallet || '';
  const conditionKey = alert.condition_key || alert.drift_type || '';
  
  const input = `${type}|${wallet}|${conditionKey}`;
  return crypto.createHash('sha256').update(input).digest('hex').substring(0, 16);
}

/**
 * Calculate alert severity
 */
function calculateSeverity(alert) {
  const type = alert.type || '';
  
  // Critical: Authority changes, supply changes
  if (type === 'authority_change' || type === 'supply_change') {
    return 'critical';
  }
  
  // Warning: Large transfers/mints, dominant wallet share > 80%
  if (type === 'large_transfer' || type === 'mint_event') {
    return 'warning';
  }
  if (type === 'dominant_wallet_share') {
    const share = parseFloat(alert.share || 0);
    if (share >= 80) return 'warning';
    if (share >= 60) return 'watch';
  }
  
  // Watch: Behavioral drift
  if (type === 'behavior_drift') {
    return 'watch';
  }
  
  // Info: Role changes, dormant activation, first DEX
  if (type === 'role_change' || type === 'dormant_activation' || type === 'first_dex_interaction') {
    return 'info';
  }
  
  return 'info';
}

/**
 * Calculate confidence score for alert
 * Based on baseline delta percent and duration sustained
 */
function calculateConfidence(alert, baseline, currentMetrics, durationIntervals = 0) {
  // If baseline not established, confidence is low
  if (!baseline || baseline.status !== 'established') {
    return 0.3;
  }
  
  // Base confidence from baseline delta percentage
  let baseConfidence = 0.5;
  
  // For behavior_drift alerts, use baseline delta percentage
  if (alert.type === 'behavior_drift') {
    const driftType = alert.drift_type;
    let baselineValue = 0;
    let currentValue = 0;
    
    if (driftType === 'transfer_rate_spike') {
      baselineValue = baseline.transfers_per_interval;
      currentValue = currentMetrics.transfers_per_interval || 0;
    } else if (driftType === 'volume_spike') {
      baselineValue = baseline.avg_transfer_size;
      currentValue = currentMetrics.avg_transfer_size || 0;
    } else if (driftType === 'counterparties_spike') {
      baselineValue = baseline.unique_wallets_per_interval;
      currentValue = currentMetrics.unique_wallets_per_interval || 0;
    }
    
    if (baselineValue > 0) {
      const delta = Math.abs(currentValue - baselineValue) / baselineValue;
      // Base confidence increases with delta magnitude (capped at 0.8)
      baseConfidence = Math.min(0.8, 0.4 + (delta * 0.4));
    }
  } else if (alert.type === 'dominant_wallet_share') {
    // For dominant wallet share, use share percentage as base
    const share = parseFloat(alert.share || 0);
    baseConfidence = Math.min(0.8, 0.5 + (share * 0.3));
  } else if (alert.type === 'authority_change' || alert.type === 'supply_change') {
    // Structural alerts have high base confidence
    baseConfidence = 0.9;
  } else {
    // Default base confidence
    baseConfidence = 0.6;
  }
  
  // Duration bonus: confidence increases with duration sustained (up to +0.2)
  // Each interval adds 0.05, capped at 4 intervals (0.2 bonus)
  const durationBonus = Math.min(0.2, durationIntervals * 0.05);
  
  // Final confidence: base + duration bonus, clamped to [0, 1]
  return Math.max(0.0, Math.min(1.0, baseConfidence + durationBonus));
}

/**
 * Deduplicate and process alerts
 */
function processAlerts(newAlerts, currentState) {
  const processed = [];
  // alertHistory is stored in _internal per user's changes
  const alertHistory = currentState._internal?.alertHistory || {};
  const baseline = currentState.baseline;
  const currentMetrics = currentState.currentInterval;
  const intervalSeconds = currentState.config.interval || 30;
  
  for (const alert of newAlerts) {
    // Generate stable ID using hash
    const alertId = generateAlertId(alert);
    const lastAlert = alertHistory[alertId];
    
    // Calculate severity
    const severity = calculateSeverity(alert);
    
    // Track duration: if alert exists, increment duration; otherwise start at 1 interval
    let durationIntervals = 1;
    if (lastAlert && lastAlert.durationIntervals !== undefined) {
      // Check if condition still matches (same severity or higher)
      const lastSeverityLevel = getSeverityLevel(lastAlert.severity || 'info');
      const currentSeverityLevel = getSeverityLevel(severity);
      
      // Only increment duration if severity hasn't decreased
      if (currentSeverityLevel >= lastSeverityLevel) {
        durationIntervals = (lastAlert.durationIntervals || 1) + 1;
      } else {
        // Severity decreased, reset duration
        durationIntervals = 1;
      }
    }
    
    // Calculate confidence with duration
    const confidence = calculateConfidence(alert, baseline, currentMetrics, durationIntervals);
    
    // Check if we should suppress this alert
    let shouldSuppress = false;
    if (lastAlert) {
      // Suppress if same or lower severity and condition hasn't worsened
      const lastSeverityLevel = getSeverityLevel(lastAlert.severity || 'info');
      const currentSeverityLevel = getSeverityLevel(severity);
      
      if (currentSeverityLevel <= lastSeverityLevel) {
        // Check if condition worsened numerically
        const worsened = hasConditionWorsened(alert, lastAlert);
        if (!worsened) {
          shouldSuppress = true;
        }
      }
    }
    
    if (!shouldSuppress) {
      // Build details object from alert fields (excluding standard fields)
      const details = {};
      const standardFields = ['timestamp', 'type', 'explanation'];
      for (const [key, value] of Object.entries(alert)) {
        if (!standardFields.includes(key) && value !== undefined) {
          details[key] = value;
        }
      }
      
      // Alert contract: { id, severity, confidence, details }
      // Also include all original fields for backward compatibility with renderer
      const processedAlert = {
        id: alertId, // Required: id field
        alert_id: alertId, // Keep for backward compatibility
        type: alert.type,
        timestamp: alert.timestamp || new Date().toISOString(),
        severity, // Required: severity field
        confidence: parseFloat(confidence.toFixed(2)), // Required: confidence field (always numeric, 2 decimal places)
        explanation: alert.explanation || '',
        details, // Required: details object
        // Include all original fields for backward compatibility
        ...alert
      };
      processed.push(processedAlert);
      // Store in history with duration for next interval
      alertHistory[alertId] = {
        ...processedAlert,
        durationIntervals
      };
    } else {
      // Even if suppressed, update duration in history for tracking
      if (lastAlert) {
        alertHistory[alertId] = {
          ...lastAlert,
          durationIntervals
        };
      }
    }
  }
  
  // Merge with existing alerts, keep last 20
  const allAlerts = [...currentState.alerts, ...processed];
  const recentAlerts = allAlerts.slice(-20);
  
  return {
    alerts: recentAlerts,
    alertHistory
  };
}

function getSeverityLevel(severity) {
  const levels = { 'info': 1, 'watch': 2, 'warning': 3, 'critical': 4 };
  return levels[severity] || 0;
}

function hasConditionWorsened(newAlert, lastAlert) {
  // For numeric conditions, check if value increased
  if (newAlert.share !== undefined && lastAlert.share !== undefined) {
    return parseFloat(newAlert.share) > parseFloat(lastAlert.share);
  }
  if (newAlert.amount !== undefined && lastAlert.amount !== undefined) {
    return parseFloat(newAlert.amount) > parseFloat(lastAlert.amount);
  }
  // For behavior_drift, check if drift_type delta increased
  if (newAlert.type === 'behavior_drift' && lastAlert.type === 'behavior_drift') {
    // If same drift type, we can't easily compare without baseline context
    // Assume worsened if severity increased (handled by severity check)
    return false;
  }
  return false;
}

/**
 * Normalize dominant wallet share to [0, 100]
 */
function normalizeDominantShare(share) {
  return Math.max(0, Math.min(100, share * 100));
}

/**
 * Update series with new data point (rolling window of 30)
 * Returns series with scaling metadata for charts
 */
function updateSeries(series, metrics) {
  // CRITICAL: Ensure arrays exist before pushing
  const newSeries = {
    transfers: Array.isArray(series.transfers) ? [...series.transfers] : [],
    wallets: Array.isArray(series.wallets) ? [...series.wallets] : [],
    avgSize: Array.isArray(series.avgSize) ? [...series.avgSize] : [],
    dominantShare: Array.isArray(series.dominantShare) ? [...series.dominantShare] : []
  };
  
  // Clamp dominant share to [0, 100]
  const dominantShare = normalizeDominantShare(metrics.dominant_wallet_share || 0);
  
  newSeries.transfers.push(metrics.transfers_per_interval || 0);
  if (newSeries.transfers.length > 30) newSeries.transfers.shift();
  
  newSeries.wallets.push(metrics.unique_wallets_per_interval || 0);
  if (newSeries.wallets.length > 30) newSeries.wallets.shift();
  
  newSeries.avgSize.push(metrics.avg_transfer_size || 0);
  if (newSeries.avgSize.length > 30) newSeries.avgSize.shift();
  
  newSeries.dominantShare.push(dominantShare);
  if (newSeries.dominantShare.length > 30) newSeries.dominantShare.shift();
  
  // Add rolling window scaling metadata for charts (without redesigning charts)
  // These are computed from the rolling window, not absolute max
  const windowSize = Math.min(30, Math.max(newSeries.transfers.length, newSeries.wallets.length, newSeries.avgSize.length, newSeries.dominantShare.length));
  
  if (windowSize > 0) {
    newSeries._scaling = {
      transfers: {
        min: Math.min(...newSeries.transfers),
        max: Math.max(...newSeries.transfers),
        windowSize
      },
      wallets: {
        min: Math.min(...newSeries.wallets),
        max: Math.max(...newSeries.wallets),
        windowSize
      },
      avgSize: {
        min: Math.min(...newSeries.avgSize),
        max: Math.max(...newSeries.avgSize),
        windowSize
      },
      dominantShare: {
        min: Math.min(...newSeries.dominantShare),
        max: Math.max(...newSeries.dominantShare),
        windowSize
      }
    };
  }
  
  return newSeries;
}

/**
 * Pure function: Update state from IntervalResult
 * This is the single source of truth for state updates.
 * Same input -> same output (deterministic)
 * 
 * @param {Object} prevState - Previous AppState
 * @param {Object} intervalResult - IntervalResult from headless engine
 * @returns {Object} Next AppState
 */
function updateStateFromInterval(prevState, intervalResult) {
  const { computeBaseline } = require('../utils/watch-analytics');
  
  // If interval failed, return state with error info (no state change except performance and refresh marker)
  if (!intervalResult.success) {
    // Check for unsupported token standard error
    if (intervalResult.isUnsupportedTokenStandard) {
      // Store error in _internal for TUI display
      const internalUpdates = {
        unsupportedTokenStandard: true,
        tokenStandardError: intervalResult.error
      };
      return updateState(prevState, {
        _internal: { ...prevState._internal, ...internalUpdates },
        performance: intervalResult.performance || prevState.performance,
        currentInterval: {
          ...prevState.currentInterval,
          isUnsupportedTokenStandard: true,
          last_refresh_ms: Math.max(
            intervalResult.performance?.total_ms || 0,
            (prevState.currentInterval?.last_refresh_ms || 0) + 1
          )
        }
      });
    }
    
    // Ensure last_refresh_ms is monotonic (always increases)
    const prevRefresh = prevState.currentInterval?.last_refresh_ms || 0;
    const newRefresh = intervalResult.performance?.total_ms || prevRefresh + 1;
    return updateState(prevState, {
      performance: intervalResult.performance || prevState.performance,
      currentInterval: {
        ...prevState.currentInterval,
        last_refresh_ms: Math.max(newRefresh, prevRefresh + 1) // Always increment
      }
    });
  }
  
  const { metrics, events, alerts: rawAlerts, tokenInfo, roles, isFine, performance } = intervalResult;
  
  // Build current interval object
  const currentInterval = {
    checkCount: intervalResult.checkCount,
    timestamp: intervalResult.timestamp,
    transfers: metrics.transfers_per_interval || 0,
    mints: events.filter(e => e.type === 'mint').length,
    totalVolume: metrics.total_volume || 0,
    uniqueWallets: metrics.unique_wallets_per_interval || 0,
    avgTransferSize: metrics.avg_transfer_size || 0,
    dominantWalletShare: normalizeDominantShare(metrics.dominant_wallet_share || 0),
    integrity: { valid: isFine, errors: [] },
    partial: !isFine,
    // Monotonic refresh marker - always increments to ensure renders happen every interval
    last_refresh_ms: Math.max(
      performance?.total_ms || 0,
      (prevState.currentInterval?.last_refresh_ms || 0) + 1
    )
  };
  
  // Validate integrity (with supply change checks)
  const integrity = validateIntervalIntegrity(currentInterval, prevState, events, tokenInfo);
  currentInterval.integrity = integrity;
  
  // If integrity check fails, mark as partial
  if (!integrity.valid) {
    currentInterval.partial = true;
  }
  
  // Only update baseline if isFine is true (verified interval)
  let baseline = prevState.baseline;
  const intervalMetrics = [...(prevState._internal.intervalMetrics || [])];
  
  if (isFine && integrity.valid) {
    // Add to interval metrics for baseline
    intervalMetrics.push(metrics);
    
    // Update baseline after 3 verified intervals
    if (intervalMetrics.length >= 3) {
      const computedBaseline = computeBaseline(intervalMetrics, 3);
      if (computedBaseline) {
        baseline = {
          status: 'established',
          intervals_observed: intervalMetrics.length,
          transfers_per_interval: computedBaseline.transfers_per_interval,
          avg_transfer_size: computedBaseline.avg_transfer_size,
          unique_wallets_per_interval: computedBaseline.unique_wallets_per_interval,
          dominant_wallet_share: computedBaseline.dominant_wallet_share
        };
      } else {
        baseline = {
          ...baseline,
          status: 'forming',
          intervals_observed: intervalMetrics.length
        };
      }
    } else {
      baseline = {
        ...baseline,
        status: 'forming',
        intervals_observed: intervalMetrics.length
      };
    }
    
    // Update internal interval metrics
    prevState._internal.intervalMetrics = intervalMetrics;
  } else {
    // Keep existing baseline if interval not verified
    baseline = { ...baseline };
  }
  
  // Update token info if provided
  const tokenUpdates = {};
  const internalUpdates = {};
  if (tokenInfo) {
    if (tokenInfo.name !== undefined) tokenUpdates.name = tokenInfo.name;
    if (tokenInfo.decimals !== undefined) tokenUpdates.decimals = tokenInfo.decimals;
    if (tokenInfo.supply) tokenUpdates.supply = tokenInfo.supply;
    if (tokenInfo.authorities) tokenUpdates.authorities = tokenInfo.authorities;
    if (tokenInfo.topTokenAccounts) {
      tokenUpdates.topTokenAccounts = tokenInfo.topTokenAccounts;
      // Also update _internal for headless engine context
      internalUpdates.topTokenAccounts = tokenInfo.topTokenAccounts;
    }
  }
  
  // Detect behavioral drift (needs baseline from state)
  const driftAlerts = [];
  if (isFine && integrity.valid && prevState.baseline.status === 'established') {
    const { detectDrift } = require('../utils/watch-analytics');
    const driftResults = detectDrift(metrics, prevState.baseline, prevState.config.strict);
    for (const alert of driftResults) {
      driftAlerts.push({
        timestamp: intervalResult.timestamp,
        type: 'behavior_drift',
        drift_type: alert.type,
        explanation: alert.explanation,
        condition_key: alert.type
      });
    }
  }
  
  // Detect role changes (needs previous roles from state)
  const roleChangeAlerts = [];
  if (roles && roles.roles) {
    const { detectRoleChanges } = require('../utils/watch-analytics');
    const previousRolesMap = new Map(prevState._internal.previousRoles || []);
    const currentRolesMap = new Map();
    for (const roleInfo of roles.roles) {
      currentRolesMap.set(roleInfo.wallet, roleInfo.role);
    }
    const roleChanges = detectRoleChanges(currentRolesMap, previousRolesMap, tokenInfo?.topTokenAccounts || []);
    for (const alert of roleChanges) {
      roleChangeAlerts.push({
        timestamp: intervalResult.timestamp,
        type: 'role_change',
        wallet: alert.wallet,
        old_role: alert.old_role,
        new_role: alert.new_role,
        explanation: `${alert.wallet} changed from ${alert.old_role} to ${alert.new_role}`
      });
    }
  }
  
  // Detect structural alerts (needs baseline from state)
  const structuralAlerts = [];
  if (isFine) {
    const { detectStructuralAlerts } = require('../utils/watch-analytics');
    const dominantThreshold = prevState.config.strict ? 0.5 : 0.6;
    const authorityChanged = rawAlerts.some(a => a.type === 'authority_change');
    const structural = detectStructuralAlerts(
      metrics,
      prevState.baseline.status === 'established' ? prevState.baseline : null,
      [], // transactions not needed
      authorityChanged,
      dominantThreshold
    );
    structuralAlerts.push(...structural);
  }
  
  // Combine all alerts
  const allRawAlerts = [...(rawAlerts || []), ...driftAlerts, ...roleChangeAlerts, ...structuralAlerts];
  
  // Process alerts (deduplication, severity, confidence)
  const processed = processAlerts(allRawAlerts, prevState);
  
  // Update series
  const series = updateSeries(prevState.series, metrics);
  
  // Verify series was updated (debug logging removed - check debug log file)
  
  // Update active wallets (internal state)
  // Convert from array to Set if needed
  const activeWalletsArray = prevState._internal.activeWallets || [];
  const activeWallets = new Set(Array.isArray(activeWalletsArray) ? activeWalletsArray : []);
  for (const event of events || []) {
    if (event.source !== 'unknown') activeWallets.add(event.source);
    if (event.destination !== 'unknown') activeWallets.add(event.destination);
  }
  
  // Update previous roles (internal state) - convert to array for serialization
  const previousRolesArray = [];
  if (roles && roles.roles) {
    for (const roleInfo of roles.roles) {
      previousRolesArray.push([roleInfo.wallet, roleInfo.role]);
    }
  }
  
  // Build state updates
  const updates = {
    baseline,
    series,
    currentInterval,
    roles: roles?.roles || [],
    alerts: processed.alerts,
    performance: performance || prevState.performance,
    _internal: {
      ...prevState._internal,
      intervalMetrics: intervalMetrics,
      alertHistory: processed.alertHistory,
      activeWallets: Array.from(activeWallets),
      previousRoles: previousRolesArray,
      ...internalUpdates
    }
  };
  
  if (Object.keys(tokenUpdates).length > 0) {
    updates.token = tokenUpdates;
  }
  
  return updateState(prevState, updates);
}

module.exports = {
  createInitialState,
  updateState,
  updateStateFromInterval,
  validateIntervalIntegrity,
  generateAlertId,
  calculateSeverity,
  calculateConfidence,
  processAlerts,
  normalizeDominantShare,
  updateSeries
};

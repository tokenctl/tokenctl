/**
 * Type definitions and contracts for watch system
 * 
 * All live data flows through a single immutable state object (AppState)
 * that updates once per interval via IntervalResult.
 */

/**
 * @typedef {Object} IntervalResult
 * @property {boolean} success - Whether the interval executed successfully
 * @property {string} [error] - Error message if success is false
 * @property {boolean} [isNetworkError] - Whether the error is a network error
 * @property {string} timestamp - ISO timestamp of the interval
 * @property {number} checkCount - Sequential check number
 * @property {IntervalMetrics} metrics - Computed metrics for this interval
 * @property {Array<TransferEvent>} events - Transfer/mint events in this interval
 * @property {Array<Alert>} alerts - Alerts generated in this interval
 * @property {TokenInfo} tokenInfo - Current token metadata
 * @property {WalletRoles} roles - Wallet role classifications
 * @property {boolean} isFine - Whether this interval passed integrity checks (for baseline learning)
 * @property {PerformanceMetrics} performance - Performance timing data
 */

/**
 * @typedef {Object} IntervalMetrics
 * @property {number} transfers_per_interval - Number of transfers in interval
 * @property {number} avg_transfer_size - Average transfer size
 * @property {number} unique_wallets_per_interval - Unique wallets in interval
 * @property {number} dominant_wallet_share - Dominant wallet share (0-1)
 * @property {number} total_volume - Total volume in interval
 */

/**
 * @typedef {Object} TransferEvent
 * @property {string} type - 'transfer' | 'mint'
 * @property {string} source - Source wallet address
 * @property {string} destination - Destination wallet address
 * @property {number} amount - Token amount
 * @property {string} signature - Transaction signature
 */

/**
 * @typedef {Object} Alert
 * @property {string} alert_id - Stable identifier for deduplication
 * @property {string} type - Alert type (authority_change, supply_change, etc.)
 * @property {string} timestamp - ISO timestamp
 * @property {string} severity - 'info' | 'watch' | 'warning' | 'critical'
 * @property {number} confidence - Confidence score 0.0-1.0
 * @property {string} explanation - Human-readable explanation
 * @property {string} [wallet] - Wallet address if applicable
 * @property {string} [drift_type] - Drift type if behavior_drift
 * @property {Object} [details] - Additional alert-specific data
 */

/**
 * @typedef {Object} TokenInfo
 * @property {string} name - Token name
 * @property {number} decimals - Token decimals
 * @property {SupplyInfo} supply - Supply information
 * @property {AuthoritiesInfo} authorities - Authority information
 * @property {Array<TopAccount>} topTokenAccounts - Top token accounts
 */

/**
 * @typedef {Object} SupplyInfo
 * @property {string} display - Formatted supply string
 * @property {string|number} raw - Raw supply value
 * @property {number} decimals - Token decimals
 */

/**
 * @typedef {Object} AuthoritiesInfo
 * @property {string|null} mint_authority - Mint authority address or null
 * @property {string|null} freeze_authority - Freeze authority address or null
 */

/**
 * @typedef {Object} TopAccount
 * @property {string} address - Account address
 * @property {number} amount - Token amount
 */

/**
 * @typedef {Object} WalletRoles
 * @property {Array<RoleInfo>} roles - Array of wallet role information
 */

/**
 * @typedef {Object} RoleInfo
 * @property {string} wallet - Wallet address
 * @property {string} role - Role classification
 * @property {number} volume - Total volume
 * @property {number} net_flow - Net flow (positive = receiving, negative = sending)
 * @property {number} counterparties - Number of unique counterparties
 */

/**
 * @typedef {Object} PerformanceMetrics
 * @property {number} signatures_fetch_ms - Time to fetch signatures
 * @property {number} transactions_fetch_ms - Time to fetch transactions
 * @property {number} parse_ms - Time to parse transactions
 * @property {number} analytics_ms - Time for analytics computation
 * @property {number} render_ms - Time for rendering (not used in headless engine)
 * @property {number} total_ms - Total interval time
 */

/**
 * @typedef {Object} AppState
 * @property {Config} config - Immutable configuration
 * @property {TokenInfo} token - Token metadata
 * @property {Baseline} baseline - Behavioral baseline
 * @property {TimeSeries} series - Time series data (rolling window)
 * @property {CurrentInterval} currentInterval - Current interval data
 * @property {Array<RoleInfo>} roles - Current wallet roles
 * @property {Array<Alert>} alerts - Recent alerts (last 20)
 * @property {PerformanceMetrics} performance - Performance metrics
 * @property {Object} _internal - Internal tracking state (not part of immutable contract)
 */

/**
 * @typedef {Object} Config
 * @property {string} mint - Mint address
 * @property {number} interval - Interval in seconds
 * @property {number} transferThreshold - Transfer threshold for alerts
 * @property {number} mintThreshold - Mint threshold for alerts
 * @property {boolean} strict - Strict mode flag
 * @property {string} rpcUrl - RPC URL
 */

/**
 * @typedef {Object} Baseline
 * @property {string} status - 'forming' | 'established'
 * @property {number} intervals_observed - Number of intervals observed
 * @property {number} transfers_per_interval - Average transfers per interval
 * @property {number} avg_transfer_size - Average transfer size
 * @property {number} unique_wallets_per_interval - Average unique wallets
 * @property {number} dominant_wallet_share - Dominant wallet share (0-1)
 */

/**
 * @typedef {Object} TimeSeries
 * @property {Array<number>} transfers - Transfer counts (max 30)
 * @property {Array<number>} wallets - Unique wallet counts (max 30)
 * @property {Array<number>} avgSize - Average transfer sizes (max 30)
 * @property {Array<number>} dominantShare - Dominant wallet shares (max 30, 0-100)
 */

/**
 * @typedef {Object} CurrentInterval
 * @property {number} checkCount - Sequential check number
 * @property {string} timestamp - ISO timestamp
 * @property {number} transfers - Number of transfers
 * @property {number} mints - Number of mint events
 * @property {number} totalVolume - Total volume
 * @property {number} uniqueWallets - Unique wallets
 * @property {number} avgTransferSize - Average transfer size
 * @property {number} dominantWalletShare - Dominant wallet share (0-100)
 * @property {IntegrityInfo} integrity - Integrity validation result
 * @property {boolean} partial - Whether data is partial/incomplete
 */

/**
 * @typedef {Object} IntegrityInfo
 * @property {boolean} valid - Whether integrity check passed
 * @property {Array<string>} errors - Array of error messages
 */

/**
 * Watch context passed to runInterval
 * @typedef {Object} WatchContext
 * @property {string} mint - Mint address
 * @property {object} connection - Solana connection
 * @property {Config} config - Configuration
 * @property {Object} _internal - Internal state (caches, tracking, etc.)
 */

module.exports = {
  // Types are exported for documentation purposes
  // Actual validation happens in implementation
};

// Unit tests for watch analytics
// Tests baseline formation, drift detection, role changes, and dormant activation

const {
  computeIntervalMetrics,
  computeBaseline,
  detectDrift,
  detectRoleChanges,
  detectDormantActivation,
  calculateSignalConfidence,
  detectStructuralAlerts,
  computeWalletStats,
  classifyWalletRoles
} = require('../src/utils/watch-analytics');

// Mock transactions for DEX detection
const mockDEXTx = {
  transaction: {
    message: {
      instructions: [{
        programId: '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8',
        program: 'Raydium V4'
      }]
    }
  },
  meta: {}
};

describe('watch-analytics', () => {
  describe('computeIntervalMetrics', () => {
    test('returns zero metrics for empty events', () => {
      const metrics = computeIntervalMetrics([]);
      expect(metrics.transfers_per_interval).toBe(0);
      expect(metrics.avg_transfer_size).toBe(0);
      expect(metrics.unique_wallets_per_interval).toBe(0);
      expect(metrics.dominant_wallet_share).toBe(0);
    });

    test('computes metrics from transfer events', () => {
      const events = [
        { type: 'transfer', source: 'A', destination: 'B', amount: 100 },
        { type: 'transfer', source: 'A', destination: 'C', amount: 200 },
        { type: 'transfer', source: 'B', destination: 'D', amount: 50 }
      ];
      const metrics = computeIntervalMetrics(events);
      expect(metrics.transfers_per_interval).toBe(3);
      expect(metrics.avg_transfer_size).toBeCloseTo(116.67, 1);
      expect(metrics.unique_wallets_per_interval).toBe(4);
      expect(metrics.dominant_wallet_share).toBeGreaterThan(0);
    });
  });

  describe('computeBaseline', () => {
    test('returns null with insufficient intervals', () => {
      const metrics = [
        { transfers_per_interval: 5, avg_transfer_size: 100, unique_wallets_per_interval: 2, dominant_wallet_share: 0.5 }
      ];
      expect(computeBaseline(metrics, 3)).toBeNull();
    });

    test('computes baseline from 3 intervals', () => {
      const metrics = [
        { transfers_per_interval: 5, avg_transfer_size: 100, unique_wallets_per_interval: 2, dominant_wallet_share: 0.5 },
        { transfers_per_interval: 7, avg_transfer_size: 120, unique_wallets_per_interval: 3, dominant_wallet_share: 0.6 },
        { transfers_per_interval: 6, avg_transfer_size: 110, unique_wallets_per_interval: 2, dominant_wallet_share: 0.55 }
      ];
      const baseline = computeBaseline(metrics, 3);
      expect(baseline).not.toBeNull();
      expect(baseline.transfers_per_interval).toBeCloseTo(6, 0);
      expect(baseline.avg_transfer_size).toBeCloseTo(110, 0);
      expect(baseline.intervals_observed).toBe(3);
    });
  });

  describe('detectDrift', () => {
    test('returns empty array when no baseline', () => {
      const current = { transfers_per_interval: 10, avg_transfer_size: 200, unique_wallets_per_interval: 5 };
      expect(detectDrift(current, null)).toEqual([]);
    });

    test('detects transfer rate spike', () => {
      const baseline = { transfers_per_interval: 5, avg_transfer_size: 100, unique_wallets_per_interval: 2, dominant_wallet_share: 0.5 };
      const current = { transfers_per_interval: 12, avg_transfer_size: 100, unique_wallets_per_interval: 2, dominant_wallet_share: 0.5 };
      const alerts = detectDrift(current, baseline, false);
      expect(alerts.length).toBeGreaterThan(0);
      expect(alerts[0].type).toBe('transfer_rate_spike');
    });

    test('detects volume spike', () => {
      const baseline = { transfers_per_interval: 5, avg_transfer_size: 100, unique_wallets_per_interval: 2, dominant_wallet_share: 0.5 };
      const current = { transfers_per_interval: 5, avg_transfer_size: 250, unique_wallets_per_interval: 2, dominant_wallet_share: 0.5 };
      const alerts = detectDrift(current, baseline, false);
      expect(alerts.some(a => a.type === 'volume_spike')).toBe(true);
    });

    test('uses stricter thresholds in strict mode', () => {
      const baseline = { transfers_per_interval: 5, avg_transfer_size: 100, unique_wallets_per_interval: 2, dominant_wallet_share: 0.5 };
      const current = { transfers_per_interval: 8, avg_transfer_size: 100, unique_wallets_per_interval: 2, dominant_wallet_share: 0.5 };
      const alertsStrict = detectDrift(current, baseline, true);
      const alertsNormal = detectDrift(current, baseline, false);
      expect(alertsStrict.length).toBeGreaterThanOrEqual(alertsNormal.length);
    });
  });

  describe('detectRoleChanges', () => {
    test('detects role change', () => {
      const previousRoles = new Map([['A', 'Accumulator']]);
      const currentRoles = new Map([['A', 'Distributor']]);
      const alerts = detectRoleChanges(currentRoles, previousRoles);
      expect(alerts.length).toBe(1);
      expect(alerts[0].type).toBe('role_change');
      expect(alerts[0].old_role).toBe('Accumulator');
      expect(alerts[0].new_role).toBe('Distributor');
    });

    test('detects new distributor', () => {
      const previousRoles = new Map();
      const currentRoles = new Map([['A', 'Distributor']]);
      const alerts = detectRoleChanges(currentRoles, previousRoles);
      expect(alerts.some(a => a.type === 'new_distributor')).toBe(true);
    });

    test('returns empty for no changes', () => {
      const previousRoles = new Map([['A', 'Accumulator']]);
      const currentRoles = new Map([['A', 'Accumulator']]);
      const alerts = detectRoleChanges(currentRoles, previousRoles);
      expect(alerts.length).toBe(0);
    });
  });

  describe('detectDormantActivation', () => {
    test('detects dormant wallet activation', () => {
      const activeWallets = new Set(['A', 'B']);
      const events = [
        { type: 'transfer', source: 'C', destination: 'D', amount: 1000 }
      ];
      const alerts = detectDormantActivation(events, activeWallets, 500);
      expect(alerts.length).toBeGreaterThan(0);
      expect(alerts.some(a => a.type === 'dormant_activation' && (a.wallet === 'C' || a.wallet === 'D'))).toBe(true);
    });

    test('respects threshold', () => {
      const activeWallets = new Set(['A']);
      const events = [
        { type: 'transfer', source: 'B', destination: 'C', amount: 100 }
      ];
      const alerts = detectDormantActivation(events, activeWallets, 500);
      expect(alerts.length).toBe(0);
    });

    test('ignores already active wallets', () => {
      const activeWallets = new Set(['A', 'B']);
      const events = [
        { type: 'transfer', source: 'A', destination: 'B', amount: 1000 }
      ];
      const alerts = detectDormantActivation(events, activeWallets, 500);
      expect(alerts.length).toBe(0);
    });
  });

  describe('calculateSignalConfidence', () => {
    test('returns 0 for no intervals', () => {
      expect(calculateSignalConfidence(0, 10, 5)).toBe(0);
    });

    test('increases with more intervals', () => {
      const conf1 = calculateSignalConfidence(3, 10, 5);
      const conf5 = calculateSignalConfidence(5, 10, 5);
      expect(conf5).toBeGreaterThanOrEqual(conf1);
    });

    test('returns value between 0 and 1', () => {
      const conf = calculateSignalConfidence(5, 10, 5);
      expect(conf).toBeGreaterThanOrEqual(0);
      expect(conf).toBeLessThanOrEqual(1);
    });
  });

  describe('detectStructuralAlerts', () => {
    test('detects first DEX interaction', () => {
      const metrics = { transfers_per_interval: 5, avg_transfer_size: 100, unique_wallets_per_interval: 2, dominant_wallet_share: 0.5 };
      const transactions = [mockDEXTx];
      const alerts = detectStructuralAlerts(metrics, null, transactions, false, 0.6);
      expect(alerts.some(a => a.type === 'first_dex_interaction')).toBe(true);
    });

    test('detects dominant wallet share', () => {
      const metrics = { transfers_per_interval: 5, avg_transfer_size: 100, unique_wallets_per_interval: 2, dominant_wallet_share: 0.7 };
      const alerts = detectStructuralAlerts(metrics, null, [], false, 0.6);
      expect(alerts.some(a => a.type === 'dominant_wallet_share')).toBe(true);
    });

    test('detects authority change with activity', () => {
      const baseline = { transfers_per_interval: 5, avg_transfer_size: 100, unique_wallets_per_interval: 2, dominant_wallet_share: 0.5 };
      const metrics = { transfers_per_interval: 10, avg_transfer_size: 100, unique_wallets_per_interval: 2, dominant_wallet_share: 0.5 };
      const alerts = detectStructuralAlerts(metrics, baseline, [], true, 0.6);
      expect(alerts.some(a => a.type === 'authority_activity_coincidence')).toBe(true);
    });
  });
});


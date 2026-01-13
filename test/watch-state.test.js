const { createInitialState, updateStateFromInterval } = require('../src/utils/watch-state');

describe('watch-state updateStateFromInterval', () => {
  test('should be deterministic - same input produces same output', () => {
    const initialState = createInitialState('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', {
      interval: 30,
      transferThreshold: 1000000,
      mintThreshold: 1000000,
      strict: false
    });
    
    const intervalResult1 = {
      success: true,
      timestamp: '2024-01-01T00:00:00Z',
      checkCount: 1,
      metrics: {
        transfers_per_interval: 10,
        avg_transfer_size: 1000,
        unique_wallets_per_interval: 5,
        dominant_wallet_share: 0.3,
        total_volume: 10000
      },
      events: [],
      alerts: [],
      tokenInfo: {
        name: 'Test Token',
        decimals: 6,
        supply: {
          display: '1,000,000',
          raw: '1000000000000',
          decimals: 6
        },
        authorities: {
          mint_authority: 'TestAuth',
          freeze_authority: null
        },
        topTokenAccounts: []
      },
      roles: { roles: [] },
      isFine: true,
      performance: {
        signatures_fetch_ms: 100,
        transactions_fetch_ms: 200,
        parse_ms: 50,
        analytics_ms: 30,
        render_ms: 0,
        total_ms: 380
      }
    };
    
    // Run updateStateFromInterval twice with same input
    const state1 = updateStateFromInterval(initialState, intervalResult1);
    const state2 = updateStateFromInterval(initialState, intervalResult1);
    
    // Results should be identical
    expect(state1.currentInterval.checkCount).toBe(state2.currentInterval.checkCount);
    expect(state1.currentInterval.transfers).toBe(state2.currentInterval.transfers);
    expect(state1.baseline.status).toBe(state2.baseline.status);
    expect(state1.baseline.intervals_observed).toBe(state2.baseline.intervals_observed);
    expect(state1.series.transfers.length).toBe(state2.series.transfers.length);
    expect(state1.alerts.length).toBe(state2.alerts.length);
    
    // Deep equality check for critical fields
    expect(JSON.stringify(state1.currentInterval)).toBe(JSON.stringify(state2.currentInterval));
    expect(JSON.stringify(state1.baseline)).toBe(JSON.stringify(state2.baseline));
    expect(JSON.stringify(state1.series)).toBe(JSON.stringify(state2.series));
  });
  
  test('should only update baseline when isFine is true', () => {
    const initialState = createInitialState('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', {
      interval: 30
    });
    
    const fineResult = {
      success: true,
      timestamp: '2024-01-01T00:00:00Z',
      checkCount: 1,
      metrics: {
        transfers_per_interval: 10,
        avg_transfer_size: 1000,
        unique_wallets_per_interval: 5,
        dominant_wallet_share: 0.3,
        total_volume: 10000
      },
      events: [],
      alerts: [],
      tokenInfo: null,
      roles: { roles: [] },
      isFine: true,
      performance: {}
    };
    
    const notFineResult = {
      ...fineResult,
      isFine: false
    };
    
    // Add 3 fine intervals to establish baseline
    let state = initialState;
    for (let i = 0; i < 3; i++) {
      state = updateStateFromInterval(state, { ...fineResult, checkCount: i + 1 });
    }
    
    expect(state.baseline.status).toBe('established');
    expect(state.baseline.intervals_observed).toBe(3);
    
    // Add a not-fine interval - baseline should not update
    const stateBefore = JSON.parse(JSON.stringify(state));
    state = updateStateFromInterval(state, { ...notFineResult, checkCount: 4 });
    
    expect(state.baseline.intervals_observed).toBe(stateBefore.baseline.intervals_observed);
    expect(state.baseline.status).toBe(stateBefore.baseline.status);
  });
  
  test('should handle failed intervals without crashing', () => {
    const initialState = createInitialState('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', {
      interval: 30
    });
    
    const failedResult = {
      success: false,
      error: 'RPC error',
      isNetworkError: true,
      timestamp: '2024-01-01T00:00:00Z',
      checkCount: 1,
      performance: {
        total_ms: 1000
      }
    };
    
    const state = updateStateFromInterval(initialState, failedResult);
    
    // State should remain unchanged except performance
    expect(state.currentInterval.checkCount).toBe(initialState.currentInterval.checkCount);
    expect(state.baseline.status).toBe(initialState.baseline.status);
    expect(state.performance.total_ms).toBe(1000);
  });
  
  test('should update series correctly', () => {
    const initialState = createInitialState('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', {
      interval: 30
    });
    
    const intervalResult = {
      success: true,
      timestamp: '2024-01-01T00:00:00Z',
      checkCount: 1,
      metrics: {
        transfers_per_interval: 10,
        avg_transfer_size: 1000,
        unique_wallets_per_interval: 5,
        dominant_wallet_share: 0.3,
        total_volume: 10000
      },
      events: [],
      alerts: [],
      tokenInfo: null,
      roles: { roles: [] },
      isFine: true,
      performance: {}
    };
    
    const state = updateStateFromInterval(initialState, intervalResult);
    
    expect(state.series.transfers).toHaveLength(1);
    expect(state.series.transfers[0]).toBe(10);
    expect(state.series.wallets).toHaveLength(1);
    expect(state.series.wallets[0]).toBe(5);
    expect(state.series.avgSize).toHaveLength(1);
    expect(state.series.avgSize[0]).toBe(1000);
    expect(state.series.dominantShare).toHaveLength(1);
    expect(state.series.dominantShare[0]).toBe(30); // 0.3 * 100
  });
  
  test('should cap series at 30 points', () => {
    const initialState = createInitialState('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', {
      interval: 30
    });
    
    const intervalResult = {
      success: true,
      timestamp: '2024-01-01T00:00:00Z',
      checkCount: 1,
      metrics: {
        transfers_per_interval: 10,
        avg_transfer_size: 1000,
        unique_wallets_per_interval: 5,
        dominant_wallet_share: 0.3,
        total_volume: 10000
      },
      events: [],
      alerts: [],
      tokenInfo: null,
      roles: { roles: [] },
      isFine: true,
      performance: {}
    };
    
    // Add 35 intervals
    let state = initialState;
    for (let i = 0; i < 35; i++) {
      state = updateStateFromInterval(state, { ...intervalResult, checkCount: i + 1 });
    }
    
    // Series should be capped at 30
    expect(state.series.transfers.length).toBe(30);
    expect(state.series.wallets.length).toBe(30);
    expect(state.series.avgSize.length).toBe(30);
    expect(state.series.dominantShare.length).toBe(30);
  });
});

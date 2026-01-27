const { colorize } = require('../utils/colors');
const { createWatchSession, formatTime } = require('../watch/session');
const { initContext } = require('../logging/logger');

async function watchCommand(mint, options) {
  // Initialize error context
  initContext('watch', [mint], options);
  
  const interval = parseInt(options.interval) || 30;
  const transferThreshold = parseFloat(options.transferThreshold) || 1000000;
  const mintThreshold = parseFloat(options.mintThreshold) || 1000000;
  const strict = options.strict || false;
  const quiet = options.quiet || false;
  const jsonOutput = options.json || false;

  let tokenName = null;

  if (!jsonOutput) {
    console.log(`[${formatTime()}] WATCH start`);
    console.log(`Monitoring: ${mint}`);
    console.log(`Interval: ${interval}s`);
    if (strict) {
      console.log(`Mode: strict (lower thresholds)`);
    }
    if (quiet) {
      console.log(`Mode: quiet (alerts only)`);
    }
    console.log('');
  }

  const watchSession = await createWatchSession(mint, options, {
    onStart: (startInfo) => {
      tokenName = startInfo.tokenName;
      if (!jsonOutput) {
        if (tokenName) {
          console.log(`Monitoring: ${tokenName} (${mint})`);
        } else {
          console.log(`Monitoring: ${mint}`);
        }
      }
    },
    onInterval: (state) => {
      // Update token name if we got it
      if (state.token?.name && !tokenName) {
        tokenName = state.token.name;
      }

      // Format supply
      const supplyDisplay = state.token?.supply?.display || 'unknown';

      // Check for authority changes and supply changes (already in alerts)
      // Print alerts
      if (state.alerts && state.alerts.length > 0) {
        for (const alert of state.alerts) {
          if (alert.type === 'authority_change') {
            if (!quiet && !jsonOutput) {
              console.log(`[${formatTime()}] ALERT authority_change`);
              console.log(`  Mint Auth: ${alert.mint_authority || 'revoked'}`);
              console.log(`  Freeze Auth: ${alert.freeze_authority || 'revoked'}`);
            }
            if (jsonOutput) {
              console.log(JSON.stringify({
                timestamp: alert.timestamp,
                type: alert.type,
                mint_authority: alert.mint_authority,
                freeze_authority: alert.freeze_authority
              }));
            }
          } else if (alert.type === 'supply_change') {
            if (!quiet && !jsonOutput) {
              const alertText = `[${formatTime()}] ALERT supply_change`;
              console.log(colorize(alertText, 'white', 'bgRed'));
              console.log(`  Previous: ${alert.previous.toLocaleString()}`);
              console.log(`  Current: ${alert.current.toLocaleString()}`);
            }
            if (jsonOutput) {
              console.log(JSON.stringify({
                timestamp: alert.timestamp,
                type: alert.type,
                previous: alert.previous,
                current: alert.current
              }));
            }
          } else if (alert.type === 'mint_event') {
            if (!quiet && !jsonOutput) {
              console.log(`[${formatTime()}] ALERT mint_event ${alert.amount.toLocaleString()}`);
              console.log(`  Signature: ${alert.signature}`);
            }
            if (jsonOutput) {
              console.log(JSON.stringify({
                timestamp: alert.timestamp,
                type: alert.type,
                amount: alert.amount,
                signature: alert.signature
              }));
            }
          } else if (alert.type === 'large_transfer') {
            if (!quiet && !jsonOutput) {
              console.log(`[${formatTime()}] ALERT large_transfer ${alert.amount.toLocaleString()}`);
              console.log(`  Signature: ${alert.signature}`);
            }
            if (jsonOutput) {
              console.log(JSON.stringify({
                timestamp: alert.timestamp,
                type: alert.type,
                amount: alert.amount,
                signature: alert.signature
              }));
            }
          } else if (alert.type === 'behavior_drift') {
            if (!quiet && !jsonOutput) {
              console.log(`[${formatTime()}] ALERT behavior_drift ${alert.drift_type} ${alert.explanation}`);
              console.log(`  Baseline: ${alert.baseline_status}, Confidence: ${alert.confidence.toFixed(2)}`);
            }
            if (jsonOutput) {
              console.log(JSON.stringify({
                timestamp: alert.timestamp,
                type: alert.type,
                drift_type: alert.drift_type,
                explanation: alert.explanation,
                baseline_status: alert.baseline_status,
                confidence: alert.confidence
              }));
            }
          } else if (alert.type === 'role_change') {
            if (!quiet && !jsonOutput) {
              console.log(`[${formatTime()}] ALERT role_change ${alert.wallet} ${alert.old_role} -> ${alert.new_role}`);
            }
            if (jsonOutput) {
              console.log(JSON.stringify({
                timestamp: alert.timestamp,
                type: alert.type,
                wallet: alert.wallet,
                old_role: alert.old_role,
                new_role: alert.new_role
              }));
            }
          } else if (alert.type === 'dormant_activation') {
            if (!quiet && !jsonOutput) {
              console.log(`[${formatTime()}] ALERT dormant_activation ${alert.wallet} ${alert.amount.toFixed(2)}`);
            }
            if (jsonOutput) {
              console.log(JSON.stringify({
                timestamp: alert.timestamp,
                type: alert.type,
                wallet: alert.wallet,
                amount: alert.amount
              }));
            }
          } else if (alert.type === 'data_integrity') {
            if (!quiet && !jsonOutput) {
              console.log(`[${formatTime()}] ALERT data_integrity ${alert.explanation}`);
            }
            if (jsonOutput) {
              console.log(JSON.stringify({
                timestamp: alert.timestamp,
                type: alert.type,
                explanation: alert.explanation,
                errors: alert.errors
              }));
            }
          } else {
            // Other structural alerts
            if (!quiet && !jsonOutput) {
              console.log(`[${formatTime()}] ALERT ${alert.type} ${alert.explanation}`);
            }
            if (jsonOutput) {
              const jsonAlert = {
                timestamp: alert.timestamp,
                type: alert.type,
                explanation: alert.explanation
              };
              if (alert.dex_programs) jsonAlert.dex_programs = alert.dex_programs;
              if (alert.share !== undefined) jsonAlert.share = alert.share;
              console.log(JSON.stringify(jsonAlert));
            }
          }
        }
      }

      // Print interval summary (unless quiet mode)
      if (!quiet && !jsonOutput) {
        const nameDisplay = tokenName ? `${tokenName} - ` : '';
        const mintAuth = state.token?.authorities?.mint_authority ? 'EXISTS' : 'revoked';
        console.log(`[${formatTime()}] Check #${state.currentInterval?.checkCount || 0} - ${nameDisplay}Supply: ${supplyDisplay}, Auth: ${mintAuth}`);
        if (state.baseline && state.baseline.status === 'established') {
          console.log(`  Baseline: ${state.baseline.transfers_per_interval.toFixed(1)} transfers/interval, ${state.baseline.avg_transfer_size.toFixed(2)} avg size`);
        } else {
          const intervals = state.baseline?.intervals_observed || 0;
          console.log(`  Baseline: forming (${intervals}/3 intervals)`);
        }
        const transfers = state.currentInterval?.transfers || 0;
        const wallets = state.currentInterval?.uniqueWallets || 0;
        console.log(`  Current: ${transfers} transfers, ${wallets} wallets`);
      }
    },
    onError: (errorInfo) => {
      if (!quiet && !jsonOutput) {
        const nameDisplay = tokenName ? `${tokenName} - ` : '';
        if (errorInfo.isNetworkError) {
          console.log(`\n[${formatTime()}] ${nameDisplay}RPC connection error, retrying in ${interval}s...`);
        } else {
          let cleanMsg = errorInfo.error;
          cleanMsg = cleanMsg.replace(/failed to get info about account [^\s]+/gi, 'RPC request failed');
          cleanMsg = cleanMsg.replace(/^Error: /i, '');
          console.log(`\n[${formatTime()}] Error: ${cleanMsg}`);
        }
      }
    }
  });

  // Run watch loop
  while (true) {
    const result = await watchSession.runInterval();
    if (result.success) {
      // Sleep for interval duration
      await new Promise(resolve => setTimeout(resolve, interval * 1000));
    } else {
      // On error, still sleep before retry
      if (!quiet && !jsonOutput) {
        const nameDisplay = tokenName ? `${tokenName} - ` : '';
        console.log(`\n[${formatTime()}] ${nameDisplay}Error: ${result.error || 'Unknown error'}`);
      }
      await new Promise(resolve => setTimeout(resolve, interval * 1000));
    }
  }
}

module.exports = watchCommand;

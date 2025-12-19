function calculateVerdict(mintInfo, concentration, activity, holdersData) {
  const { mintAuthority, freezeAuthority } = mintInfo;
  const { top1, top10 } = concentration;
  const { mintEvents } = activity;
  const totalHolders = (holdersData && holdersData.totalHolders) || 0;

  const authoritiesRevoked = !mintAuthority && !freezeAuthority;
  const noMintActivity = mintEvents === 0;
  const highTop1Concentration = top1 > 50;
  const highTop10Concentration = top10 > 90;
  const hasAuthority = !!mintAuthority || !!freezeAuthority;
  
  // Red flags for scam patterns
  const veryLowHolders = totalHolders > 0 && totalHolders < 10;
  const lowHolders = totalHolders > 0 && totalHolders < 100;
  const highConcentrationLowHolders = (top10 > 30 && totalHolders < 50) || (top10 > 50 && totalHolders < 100);

  // RISKY: Very few holders with high concentration (classic scam pattern)
  if (veryLowHolders && (top10 > 30 || top1 > 15)) {
    return {
      verdict: 'RISKY',
      reason: `Very few holders (${totalHolders}) with high concentration (top 10: ${top10.toFixed(2)}%) - potential scam/rug pull`
    };
  }

  // RISKY: Low holders with very high concentration
  if (lowHolders && highConcentrationLowHolders) {
    return {
      verdict: 'RISKY',
      reason: `Low holder count (${totalHolders}) with high concentration (top 10: ${top10.toFixed(2)}%) - high risk`
    };
  }

  // RISKY: Active mint authority with high concentration or recent mints
  if (mintAuthority && (highTop1Concentration || mintEvents > 0)) {
    return {
      verdict: 'RISKY',
      reason: `Mint authority exists${highTop1Concentration ? ' with high top holder concentration' : ''}${mintEvents > 0 ? ' and observed mint events' : ''}`
    };
  }

  // CLEAN: Only if authorities revoked, no activity, AND reasonable distribution
  if (authoritiesRevoked && noMintActivity && !veryLowHolders && !highConcentrationLowHolders) {
    return {
      verdict: 'CLEAN',
      reason: 'Mint and freeze authorities revoked with no observed mint activity in 24h'
    };
  }

  // WATCH: Authorities exist or high concentration
  if (hasAuthority || highTop10Concentration || lowHolders) {
    const reasons = [];
    if (hasAuthority) reasons.push('Authority exists');
    if (highTop10Concentration) reasons.push('high top 10 holder concentration');
    if (lowHolders) reasons.push(`low holder count (${totalHolders})`);
    return {
      verdict: 'WATCH',
      reason: reasons.join(' and ')
    };
  }

  return {
    verdict: 'WATCH',
    reason: 'Token requires monitoring'
  };
}

module.exports = {
  calculateVerdict
};



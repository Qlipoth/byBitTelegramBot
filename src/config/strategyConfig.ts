export const STRATEGY_CONFIG = {
  watcher: {
    minMoveThreshold: 0.45,
    maxMoveThresholdMultiplier: 1.5,
  },
  candleBuilder: {
    minAtrPct: 0.15,
    minMoveThreshold: 0.15,
    minCvdThreshold: 300,
    historyLimit: 500,
    volumeAvgPeriod: 30,
  },
  fsm: {
    minMoveThreshold: 0.4,
    minCvdThreshold: 1500,
    maxSetupDurationMs: 5 * 60 * 1000,
    cooldownDurationMs: 0,
    maxRangeHoldMs: 45 * 60 * 1000,
    maxTrendHoldMs: 90 * 60 * 1000,
    maxPositionDurationMs: 45 * 60 * 1000,
    extendedCvdCheckAfterMs: 45 * 60 * 1000,
  },
  exit: {
    stopLossPct: 1.2,
    takeProfitPct: 2,
    cvdReversalBtcEth: 500000,
    cvdReversalAlt: 150000,
    microProfitHoldPct: 0.5,
    fundingLong: 0.0006,
    fundingShort: -0.0006,
    maxHoldTimeMs: 90 * 60 * 1000,
    extendedCvdReversalAbs: 2_500_000,
  },
  // Тюнинг под 1h: меньше шума, строже вход, выход к средней
  adaptiveBollinger: {
    bbPeriod: 20,
    bbStd: 2.2,                 // Чуть шире полосы = только сильные отклонения
    emaPeriod: 20,
    rsiLongPeriod: 14,
    rsiNeutral: 50,
    rsiDeadband: 10,            // Строже RSI — не входим в зоне флэта
    signalThreshold: 70,      // Только явные сетапы
    scoreGap: 15,              // Чёткое преимущество long vs short
    minBandDistance: 0.008,     // Вход только при достаточном отходе от средней (1h)
    emaTrendTolerance: 0.001,
    clusterAtrFactor: 0.35,    // Чуть сильнее кластер
    bandSlippageTolerance: 0.0015, // Жёстче у полосы
    maxEmaDistanceForLong: 0.02,   // Не лонг, если цена >2% ниже EMA (сильный даунтренд)
    maxEmaDistanceForShort: 0.02, // Не шорт, если цена >2% выше EMA (сильный аптренд)
    use1hInLive: true,          // В лайве использовать 1h свечи (как в бэктесте)
    supportedSymbols: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT'],
  },
  adaptiveBacktest: {
    defaultSymbol: 'ETHUSDT',
    stopAtrMult: 3.0,           // Широкий стоп — только катастрофа
    catastrophicStopPct: 0.07,  // Выход по стопу при −7% (было 5%) — даём откату время
    takeAtrMult: 1.5,
    riskPerTrade: 0.008,       // 0.8% — меньше размер при проигрыше
    startBalance: 1000,
    feeRate: 0.0005,
    meanExitTolerance: 0.0025,  // Выход чуть раньше средней (фикс профита)
  },
} as const;

export type StrategyConfig = typeof STRATEGY_CONFIG;

class TradingState {
  private enabled = false;

  enable() {
    this.enabled = true;
    console.log('[TRADING] ENABLED');
  }

  disable() {
    this.enabled = false;
    console.log('[TRADING] DISABLED');
  }

  isEnabled() {
    return this.enabled;
  }
}

export const tradingState = new TradingState();

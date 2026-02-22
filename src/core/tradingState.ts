class TradingState {
  private enabled = false;
  /** Режим «только закрытие»: вотчеры работают, выход по стратегии — новые сделки не открываются */
  private closeOnlyMode = false;

  enable() {
    this.enabled = true;
    this.closeOnlyMode = false;
    console.log('[TRADING] ENABLED');
  }

  disable() {
    this.enabled = false;
    this.closeOnlyMode = false;
    console.log('[TRADING] DISABLED');
  }

  /** Включить режим «только закрытие» — новые сделки не открывать, текущие закрывать по стратегии */
  setCloseOnlyMode(value: boolean) {
    this.closeOnlyMode = value;
    console.log(`[TRADING] Close-only mode: ${value ? 'ON' : 'OFF'}`);
  }

  isCloseOnlyMode() {
    return this.closeOnlyMode;
  }

  isEnabled() {
    return this.enabled;
  }

  /** Разрешено открывать новые позиции (включено и не режим «только закрытие») */
  allowNewEntries() {
    return this.enabled && !this.closeOnlyMode;
  }
}

export const tradingState = new TradingState();

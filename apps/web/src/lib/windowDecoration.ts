export interface WindowDecorationState {
  supported: boolean;
  titleBar: 'system' | 'hidden';
  activeTitleBar: 'system' | 'hidden';
  restartRequired: boolean;
}

export interface WindowDecorationBridge {
  getState(): Promise<WindowDecorationState | null>;
  setTitleBar(value: WindowDecorationState['titleBar']): Promise<WindowDecorationState | null>;
}

declare global {
  interface Window { mingleWindowDecoration?: WindowDecorationBridge }
}

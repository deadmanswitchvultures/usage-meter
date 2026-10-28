export type UsageMeterRange = '24h' | '7d'
export type UsageMeterView = 'limits' | 'sessions'

declare module 'claude-code' {
  interface PluginState {
    'usage-meter': {
      /** What the pane charts. */
      range: UsageMeterRange
      /** Which view of the pane: limits over time, or spend per session. */
      view: UsageMeterView
      /** Bumped after each recorded sample, so an open pane redraws. */
      rev: number
    }
  }
}

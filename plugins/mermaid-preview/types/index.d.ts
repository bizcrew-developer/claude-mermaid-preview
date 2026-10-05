export type Block =
  | { kind: 'md'; text: string }
  | { kind: 'svg'; source: string; alt: string; width: number; height: number }
  | { kind: 'err'; code: string; message: string }

// The block shown enlarged in the pane, by its index in `blocks`, and its scale.
export type Zoom = { index: number; scale: number }

declare module 'claude-code' {
  interface PluginState {
    'mermaid-preview': { file: string | null; blocks: Block[]; error: string | null; zoom: Zoom | null }
  }
}

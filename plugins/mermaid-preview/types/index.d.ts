export type Block =
  | { kind: 'md'; text: string }
  | { kind: 'svg'; source: string; alt: string; width: number; height: number }
  | { kind: 'err'; code: string; message: string }

export type Zoom = { source: string; alt: string; width: number; height: number; scale: number }

declare module 'claude-code' {
  interface PluginState {
    'mermaid-preview': { file: string | null; blocks: Block[]; error: string | null; zoom: Zoom | null }
  }
}

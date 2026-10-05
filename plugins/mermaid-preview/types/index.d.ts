export type Block =
  | { kind: 'md'; text: string }
  | { kind: 'svg'; source: string; alt: string }
  | { kind: 'err'; code: string; message: string }

declare module 'claude-code' {
  interface PluginState {
    'mermaid-preview': { file: string | null; blocks: Block[]; error: string | null }
  }
}

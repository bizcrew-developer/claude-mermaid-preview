import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Block } from '../types'

const PANE = 'mermaid-preview'
const SVG_LIMIT = 131072
const MMDC_PACKAGE = '@mermaid-js/mermaid-cli'

const file = atom({ plugin: 'mermaid-preview', key: 'file' } as const, null)
const blocks = atom({ plugin: 'mermaid-preview', key: 'blocks' } as const, [])
const error = atom({ plugin: 'mermaid-preview', key: 'error' } as const, null)
const zoom = atom({ plugin: 'mermaid-preview', key: 'zoom' } as const, null)

const SCALES = [0.5, 0.75, 1, 1.25, 1.5, 2, 2.5, 3, 4]

type Segment = { kind: 'md'; text: string } | { kind: 'mermaid'; code: string }

const FENCE = /^(```|~~~)[ \t]*mermaid[^\n]*\n([\s\S]*?)^\1[ \t]*$/gm

function split(text: string): Segment[] {
  const out: Segment[] = []
  let last = 0
  for (const m of text.matchAll(FENCE)) {
    const start = m.index ?? 0
    if (start > last) out.push({ kind: 'md', text: text.slice(last, start) })
    out.push({ kind: 'mermaid', code: m[2] ?? '' })
    last = start + m[0].length
  }
  if (last < text.length) out.push({ kind: 'md', text: text.slice(last) })
  return out.filter(s => s.kind === 'mermaid' || s.text.trim() !== '')
}

function basename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path
}

function cleanError(stderr: string): string {
  const lines = stderr.trim().split(/\r?\n/)
  const end = lines.findIndex(l => /^\s*(at |Parser\.)/.test(l))
  const kept = (end === -1 ? lines : lines.slice(0, end)).join('\n').trim()
  return (kept || 'mmdc produced no SVG').slice(0, 1000)
}

// The desktop draws an Svg on a white box, so a transparent diagram shows on
// white. A diagram written for Mermaid's dark theme gets the pane's own dark
// colour behind it instead; every other diagram keeps white, which its dark
// text needs.
function background(code: string): string {
  return /%%\{\s*init:[^}]*['"]?theme['"]?\s*:\s*['"]dark['"]/.test(code) ? '#1a1a1a' : 'white'
}

// Mermaid writes width="100%" with a max-width, which leaves the desktop's box
// to guess a height: a tall diagram shrank into a short box with white beside
// it. Give the markup its own size from the viewBox, so the box fits it exactly.
function sizeSvg(svg: string): string {
  const open = svg.match(/^<svg[^>]*>/)
  const box = open?.[0].match(/viewBox="[-\d.]+ [-\d.]+ ([\d.]+) ([\d.]+)"/)
  if (!open || !box) return svg
  const tag = open[0]
    .replace(/\swidth="[^"]*"/, '')
    .replace(/\sheight="[^"]*"/, '')
    .replace(/max-width:\s*[\d.]+px;?\s*/, '')
    .replace(/^<svg/, `<svg width="${Math.ceil(Number(box[1]))}" height="${Math.ceil(Number(box[2]))}"`)
  return tag + svg.slice(open[0].length)
}

function dirname(path: string): string {
  const i = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return i > 0 ? path.slice(0, i) : path
}

function lastPathLine(stdout: string, isAbs: (l: string) => boolean): string | null {
  const lines = stdout.split(/\r?\n/).map(l => l.trim()).filter(isAbs)
  return lines[lines.length - 1] ?? null
}

const cache = new Map<string, Block>()
let isWindows = false
// The argv prefix that runs mmdc, and the environment it needs; null until found.
let mmdc: { argv: string[]; env?: Record<string, string> } | null = null
let installing: Promise<string | null> | null = null
// Why the last install failed; kept so the 2 s refresh never re-runs npm. Cleared on open.
let installError: string | null = null
let lastText: string | null = null
let running: Promise<void> | null = null
let watcher: { cancel: () => void } | null = null

// Runs a command line through the person's own shell, so PATH (nvm, Homebrew,
// a Windows Node install) is what their terminal sees.
async function shell($: EngineInterface, line: string, timeoutMs = 15000) {
  const argv = isWindows ? ['cmd.exe', '/d', '/s', '/c', line] : ['/bin/zsh', '-ic', line]
  try {
    return await $.process.run(argv, { timeoutMs })
  } catch (err) {
    if (isWindows) throw err
    // No zsh (Linux): fall back to a login sh.
    return await $.process.run(['/bin/sh', '-lc', line], { timeoutMs })
  }
}

async function findMmdc($: EngineInterface): Promise<boolean> {
  try {
    if (isWindows) {
      const isAbs = (l: string) => /^[a-z]:\\/i.test(l)
      let path = lastPathLine((await shell($, 'where mmdc.cmd')).stdout, isAbs)
      if (!path) {
        const prefix = lastPathLine((await shell($, 'npm prefix -g')).stdout, isAbs)
        if (prefix && (await $.fs.exists(`${prefix}\\mmdc.cmd`))) path = `${prefix}\\mmdc.cmd`
      }
      if (path) mmdc = { argv: ['cmd.exe', '/d', '/s', '/c', path] }
    } else {
      const isAbs = (l: string) => l.startsWith('/')
      let path = lastPathLine((await shell($, 'command -v mmdc')).stdout, isAbs)
      if (!path) {
        const prefix = lastPathLine((await shell($, 'npm prefix -g')).stdout, isAbs)
        if (prefix && (await $.fs.exists(`${prefix}/bin/mmdc`))) path = `${prefix}/bin/mmdc`
      }
      // mmdc is a Node script: put its own bin folder (where node sits too) on PATH.
      if (path) {
        mmdc = {
          argv: [path],
          env: { PATH: `${dirname(path)}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin` },
        }
      }
    }
  } catch {
    // leave mmdc unset
  }
  return mmdc !== null
}

// Finds mmdc, installing it with npm the first time it is missing. Resolves
// null when ready, or the reason it is not.
function ensureMmdc($: EngineInterface): Promise<string | null> {
  if (mmdc) return Promise.resolve(null)
  if (installError) return Promise.resolve(installError)
  if (installing) return installing
  installing = (async () => {
    if (await findMmdc($)) return null
    const npm = await shell($, isWindows ? 'npm --version' : 'command -v npm')
    if (npm.exitCode !== 0) {
      return 'Mermaid CLI (mmdc) is missing and npm was not found. Install Node.js from https://nodejs.org, then reopen the preview.'
    }
    await $.ui.toast('Installing Mermaid CLI (mmdc) with npm. First time only; this can take a few minutes.')
    const r = await shell($, `npm install -g ${MMDC_PACKAGE}`, 600000)
    if (r.exitCode !== 0 || !(await findMmdc($))) {
      const why = cleanError(r.stderr || r.stdout)
      const hint = isWindows
        ? 'Try running "npm install -g @mermaid-js/mermaid-cli" in a terminal opened as Administrator.'
        : 'Try running "npm install -g @mermaid-js/mermaid-cli" in a terminal (with sudo if your Node is a system install).'
      return `Installing mmdc failed. ${hint}\n${why}`
    }
    await $.ui.toast('Mermaid CLI installed.')
    return null
  })()
    .then(problem => {
      installError = problem
      return problem
    })
    .finally(() => {
      installing = null
    })
  return installing
}

async function renderDiagram($: EngineInterface, code: string): Promise<Block> {
  const hit = cache.get(code)
  if (hit) return hit
  let block: Block
  try {
    if (!mmdc) throw new Error('mmdc is not available')
    const sep = isWindows ? '\\' : '/'
    const config = `${$.plugin.root}${sep}hooks${sep}mermaid-config.json`
    const r = await $.process.run(
      [...mmdc.argv, '-i', '-', '-o', '-', '-e', 'svg', '-b', background(code), '-c', config],
      { stdin: code, timeoutMs: 60000, ...(mmdc.env ? { env: mmdc.env } : {}) },
    )
    const svg = sizeSvg(r.stdout.slice(r.stdout.indexOf('<svg')))
    if (r.exitCode !== 0 || !svg.startsWith('<svg')) {
      block = { kind: 'err', code, message: cleanError(r.stderr) }
    } else if (svg.length > SVG_LIMIT) {
      block = { kind: 'err', code, message: `Diagram SVG is ${svg.length} characters, over the ${SVG_LIMIT} limit.` }
    } else {
      const size = svg.match(/^<svg width="(\d+)" height="(\d+)"/)
      block = {
        kind: 'svg',
        source: svg,
        alt: `Mermaid diagram: ${code.trim().split('\n')[0]}`,
        width: Number(size?.[1] ?? 800),
        height: Number(size?.[2] ?? 600),
      }
    }
  } catch (err) {
    block = { kind: 'err', code, message: String(err) }
  }
  cache.set(code, block)
  return block
}

async function renderNow($: EngineInterface, force: boolean) {
  const path = await read($, file)
  if (!path) return
  let text: string
  try {
    text = await $.fs.read(path)
  } catch (err) {
    await update($, error, () => `Cannot read ${path}: ${String(err)}`)
    return
  }
  if (!force && text === lastText) return
  lastText = text
  const segments = split(text)
  const out: Block[] = []
  if (segments.some(seg => seg.kind === 'mermaid')) {
    const problem = await ensureMmdc($)
    if (problem) {
      for (const seg of segments) out.push(seg.kind === 'md' ? seg : { kind: 'err', code: seg.code, message: 'Not drawn: mmdc is unavailable.' })
      await update($, blocks, () => out)
      await update($, error, () => problem)
      lastText = null
      return
    }
  }
  for (const seg of segments) {
    out.push(seg.kind === 'md' ? seg : await renderDiagram($, seg.code))
  }
  await update($, blocks, () => out)
  await update($, error, () => null)
}

function render($: EngineInterface, force = false): Promise<void> {
  if (running) return running
  running = renderNow($, force).finally(() => {
    running = null
  })
  return running
}

function watch($: EngineInterface) {
  watcher?.cancel()
  watcher = $.clock.every(2000, () => {
    void (async () => {
      const panes = await $.ui.panes()
      if (!panes.some((p: { id: string }) => p.id === PANE)) {
        watcher?.cancel()
        watcher = null
        return
      }
      await render($)
    })()
  })
}

async function openPreview($: EngineInterface, arg: string): Promise<string> {
  let path = arg
  try {
    const st = await $.fs.stat(arg, { resolve: true })
    path = st.realPath ?? arg
  } catch {
    return `File not found: ${arg}`
  }
  await update($, file, () => path)
  await update($, blocks, () => [])
  lastText = null
  installError = null
  // Open first, within the press or command, then draw: mmdc can take seconds.
  await update($, zoom, () => null)
  // `focus` lets the first tap in the pane press a button instead of focusing it.
  await $.ui.open({ id: PANE, title: `Mermaid: ${basename(path)}`, focus: true })
  watch($)
  await render($, true)

  return `Mermaid preview of ${basename(path)} opened.`
}

// Paths of .md files a reply mentions: markdown links and `code` spans.
const MD_LINK = /\]\(<?([^)\s>]+?\.md)(?::\d+(?:-\d+)?)?>?\)|`([^`\s]+?\.md)`/gi
const hasMermaid = new Map<string, { at: number; yes: boolean }>()

function mdPaths(text: string): string[] {
  const out = new Set<string>()
  for (const m of text.matchAll(MD_LINK)) {
    const raw = m[1] ?? m[2]
    if (!raw || /^https?:/i.test(raw)) continue
    out.add(decodeURI(raw.replace(/^file:\/\//, '')))
  }
  return [...out].slice(0, 8)
}

async function withMermaid($: EngineInterface, path: string): Promise<boolean> {
  const now = Date.now()
  const hit = hasMermaid.get(path)
  if (hit && now - hit.at < 5000) return hit.yes
  let yes = false
  try {
    yes = /^(```|~~~)[ \t]*mermaid/m.test(await $.fs.read(path))
  } catch {
    yes = false
  }
  hasMermaid.set(path, { at: now, yes })
  return yes
}

// After a press redraws the pane, make sure it still holds the keyboard with
// the ring on `key`: a pane without the keyboard spends the person's next tap
// taking it back. The single tree below keeps the pressed button, so this is
// a safety net for a surface that redraws the element anyway.
async function keepFocus($: EngineInterface, key: string) {
  await $.clock.sleep(250)
  const pane = (await $.ui.panes()).find(p => p.id === PANE)
  if (pane && !pane.isFocused) {
    const path = await read($, file)
    await $.ui.open({ id: PANE, title: `Mermaid: ${basename(path ?? PANE)}`, focus: true })
  }
  await $.ui.focus({ requestId: PANE, key })
}

// Expand and Back are one button, drawn under the same key in the same place
// in both views, so the element the person pressed survives the redraw and
// the pane keeps the keyboard: one tap each.
async function toggleZoom($: EngineInterface, index: number) {
  const key = `zoom-open-${index}`
  const cur = await read($, zoom)
  const isOpening = !(cur && cur.index === index)
  await update($, zoom, () => (isOpening ? { index, scale: 1 } : null))
  await keepFocus($, key)
  // Bring the diagram's row to the top: the enlarged view starts there, and
  // Back returns to the diagram instead of the top of the plan. Right after
  // the pane reopens the key can briefly read as undrawn, so retry once.
  const scrolled = await $.ui.scroll({ to: { key }, in: PANE, block: 'start' })
  if (scrolled.deny) {
    await $.clock.sleep(250)
    await $.ui.scroll({ to: { key }, in: PANE, block: 'start' })
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'mermaid-preview',
      description: 'Preview a Markdown file with its Mermaid diagrams rendered',
      argumentHint: '<file.md>',
    })
    isWindows = (await $.env.get('OS')) === 'Windows_NT'
    // After a hot reload, pick the open preview back up.
    if (await read($, file)) {
      const panes = await $.ui.panes()
      if (panes.some(p => p.id === PANE)) watch($)
    }

    return next(e)
  })

  on('command.run', { command: 'mermaid-preview' }, async ($, e) => {
    const arg = e.args.trim().replace(/^["']|["']$/g, '')
    if (!arg) return { text: 'Usage: /mermaid-preview <file.md>' }

    return { text: await openPreview($, arg) }
  })

  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    if (e.tool === 'Write' || e.tool === 'Edit') {
      const open = await read($, file)
      const edited = (e as { file_path?: string }).file_path
      if (open && edited && (edited === open || open.endsWith(`/${edited}`))) await render($)
    }

    return ran
  })

  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    const drawn = await next(e)
    if (e.surface === 'terminal') return drawn
    const paths: string[] = []
    for (const p of mdPaths(e.props.text)) if (await withMermaid($, p)) paths.push(p)
    if (paths.length === 0) return drawn
    const { Box, Button } = $.ui.resolve(e)

    return (
      <Box flexDirection="column">
        {drawn}
        <Box flexDirection="row" gap={1} flexWrap="wrap" marginTop={1}>
          {paths.map((p, i) => (
            <Button
              key={`mermaid-open-${i}-${p}`}
              label={paths.length === 1 ? 'View Plan' : `View Plan: ${basename(p)}`}
              onPress={async () => {
                await openPreview($, p)
              }}
            />
          ))}
        </Box>
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Markdown, Code, Button } = $.ui.resolve(e)
    const Svg = e.surface === 'terminal' ? null : ($.ui.resolve(e) as any).Svg
    const list = await read($, blocks)
    const problem = await read($, error)
    const path = await read($, file)
    const z = await read($, zoom)
    // The block shown enlarged, or null for the whole plan. Both views draw the
    // same tree, every block in its place and the others hidden while one is
    // enlarged, so the Expand/Back button the person pressed stays the same
    // element and the pane keeps the keyboard.
    const zi = z && Svg && typeof z.index === 'number' && list[z.index]?.kind === 'svg' ? z.index : null
    const scale = z?.scale ?? 1
    const rows = Math.max(10, (e.viewport?.rows ?? 40) - 1)
    const columns = e.viewport?.columns ?? 80
    const step = (by: number) => async () => {
      await update($, zoom, cur =>
        cur ? { ...cur, scale: SCALES[Math.min(SCALES.length - 1, Math.max(0, SCALES.indexOf(cur.scale) + by))] ?? cur.scale } : cur,
      )
    }

    return (
      <Box flexDirection="column" gap={1}>
        {problem && <Text color="red">{problem}</Text>}
        {!path && <Text dimColor>Run /mermaid-preview &lt;file.md&gt; to preview a file.</Text>}
        {path && list.length === 0 && !problem && <Text dimColor>Rendering…</Text>}
        {list.map((b, i) => {
          const isZoomed = zi === i
          const display = zi === null || isZoomed ? ('flex' as const) : ('none' as const)
          if (b.kind === 'md') {
            return (
              <Box key={`block-${i}`} flexDirection="column" display={display}>
                <Markdown text={b.text} />
              </Box>
            )
          }
          if (b.kind === 'err') {
            return (
              <Box key={`block-${i}`} flexDirection="column" display={display}>
                <Text color="red">Mermaid error: {b.message}</Text>
                <Code language="mermaid" source={b.code} />
              </Box>
            )
          }
          if (!Svg) {
            return (
              <Box key={`block-${i}`} flexDirection="column" display={display}>
                <Text dimColor>(Mermaid diagram; open this pane in the desktop app to see it drawn)</Text>
              </Box>
            )
          }
          const width = Math.round((b.width || 800) * scale)
          const height = Math.round((b.height || 600) * scale)
          // Centre only what fits (cells taken at their smallest, 7 by 16 px):
          // a flex-centred drawing larger than its box is cut off on both sides.
          const fitsAcross = width <= (columns - 4) * 7
          const fitsDown = height <= (rows - 4) * 16

          return (
            <Box
              key={`block-${i}`}
              flexDirection="column"
              display={display}
              {...(isZoomed ? { gap: 1, ...(fitsDown ? { height: rows } : {}) } : {})}
            >
              <Box flexDirection="row" gap={1} alignItems="center" justifyContent={isZoomed ? 'center' : 'flex-end'}>
                <Button
                  key={`zoom-open-${i}`}
                  label={isZoomed ? '← Back' : '⤢ Expand'}
                  onPress={async () => {
                    await toggleZoom($, i)
                  }}
                />
                {isZoomed && <Button key="zoom-out" label="−" onPress={step(-1)} />}
                {isZoomed && <Text>{Math.round(scale * 100)}%</Text>}
                {isZoomed && <Button key="zoom-in" label="+" onPress={step(1)} />}
                {isZoomed && (
                  <Button
                    key="zoom-reset"
                    label="100%"
                    onPress={async () => {
                      await update($, zoom, cur => (cur ? { ...cur, scale: 1 } : cur))
                    }}
                  />
                )}
              </Box>
              <Box
                flexDirection="column"
                {...(isZoomed
                  ? {
                      flexGrow: 1,
                      justifyContent: fitsDown ? ('center' as const) : ('flex-start' as const),
                      alignItems: fitsAcross ? ('center' as const) : ('flex-start' as const),
                    }
                  : {})}
              >
                <Svg source={b.source} alt={b.alt} isInteractive {...(isZoomed ? { width, height } : {})} />
              </Box>
            </Box>
          )
        })}
      </Box>
    )
  })
}

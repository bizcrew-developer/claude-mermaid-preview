import { test, expect, mock } from 'claude-code/testing'

const PLAN_PATH = '/plans/long-plan.md'
const CRLF_PATH = '/plans/crlf.md'
const BIG_PATH = '/plans/big-code.md'
// A plan as long as a real one: a diagram, then about 27,000 characters of
// headings, paragraphs and tables, far past one Markdown element's 10,000.
const section = (n: number) =>
  `## Section ${n}\n\n${'Words that fill the paragraph of this section. '.repeat(20)}\n\n| Item | Detail |\n|---|---|\n| a${n} | b${n} |\n\n`
const LONG_PLAN =
  '# Long plan\n\n```mermaid\nflowchart TD\n  A --> B\n```\n\n' + Array.from({ length: 25 }, (_, n) => section(n)).join('')

const FILES: Record<string, string> = {
  [PLAN_PATH]: LONG_PLAN,
  [CRLF_PATH]: '# Title\r\n\r\nIntro line\r\n\r\n```mermaid\r\nflowchart TD\r\n  A --> B\r\n```\r\n\r\nThe end.\r\n',
  [BIG_PATH]: '# Big\n\nBefore.\n\n```kotlin\n' + 'val x = 1 // a filler line of code\n'.repeat(1200) + '```\n\nAfter.\n',
}
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100"><rect width="200" height="100" fill="#1a1a1a"/></svg>'
const PANE = { title: 'Mermaid', isFocused: true, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 70 }, view: {} } as const
const VIEWPORT = { columns: 177, rows: 76, isFullscreen: true }
const SURFACES = ['desktop', 'vscode', 'mobile', 'terminal'] as const

function world(on: any) {
  const clock = mock.clock(on)
  mock.env(on, {})
  const ran = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
  on('fs.stat', async (_$: any, e: any) =>
    FILES[e.path] !== undefined ? { value: { kind: 'file', size: FILES[e.path]!.length, mtimeMs: 0, isLink: false, realPath: e.path } } : { deny: 'missing' })
  on('fs.read', async (_$: any, e: any) => (FILES[e.path] !== undefined ? { value: FILES[e.path] } : { deny: 'missing' }))
  on('fs.exists', async (_$: any, e: any) => ({ value: FILES[e.path] !== undefined }))
  on('process.run', async (_$: any, e: any) => (e.argv.includes('-e') ? ran(SVG) : ran('/usr/local/bin/mmdc\n')))
  on('ui.open', async () => ({ value: { isPlaced: true } }))
  on('ui.focus', async () => ({ deny: 'test world' }))
  on('ui.scroll', async () => ({ deny: 'test world' }))
  on('ui.panes', async () => ({ value: [{ id: 'mermaid-preview', title: 'Mermaid', isShown: true, isFocused: true, isPlaced: true }] }))
  return clock
}

async function openPane($: any, path: string, surface: (typeof SURFACES)[number]) {
  await $.command.run({ command: 'mermaid-preview', args: path })
  return $.ui.mount({ plugin: 'mermaid-preview', surface, component: 'Pane', requestId: 'mermaid-preview', props: PANE, viewport: VIEWPORT })
}

for (const surface of SURFACES) {
  test(`a long plan draws on ${surface}`, async ($: any, on: any) => {
    world(on)
    const ui = await openPane($, PLAN_PATH, surface)
    const md = await ui.findAll({ type: 'Markdown' })
    expect(md.length).toBeGreaterThan(2)
    for (const m of md) expect(m.text.length <= 10000).toBe(true)
    if (surface !== 'terminal') expect((await ui.findAll({ type: 'Svg' })).length).toBe(1)
  })
}

test('Windows line endings: the diagram is found and no carriage return is drawn', async ($: any, on: any) => {
  world(on)
  const ui = await openPane($, CRLF_PATH, 'desktop')
  expect((await ui.findAll({ type: 'Svg' })).length).toBe(1)
  for (const m of await ui.findAll({ type: 'Markdown' })) expect(m.text.includes('\r')).toBe(false)
})

test('a code block longer than a piece is cut with its fence closed and reopened', async ($: any, on: any) => {
  world(on)
  const ui = await openPane($, BIG_PATH, 'desktop')
  const md = await ui.findAll({ type: 'Markdown' })
  expect(md.length).toBeGreaterThan(2)
  for (const m of md) {
    expect(m.text.length <= 10000).toBe(true)
    const fences = m.text.split('\n').filter((l: string) => /^ {0,3}```/.test(l)).length
    expect(fences % 2).toBe(0)
  }
  expect(md.map((m: any) => m.text).join('').includes('After.')).toBe(true)
})

test('Expand and Back on a long plan keep a drawable tree', async ($: any, on: any) => {
  const clock = world(on)
  const ui = await openPane($, PLAN_PATH, 'desktop')
  const expand = (await ui.findAll({ type: 'Button' })).find((b: any) => String(b.props.label).includes('Expand'))
  expect(expand).toBeDefined()
  const pressing = ui.press({ key: expand.key })
  await clock.advance(5000)
  await pressing
  const labels = (await ui.findAll({ type: 'Button' })).map((b: any) => String(b.props.label))
  expect(labels.some((l: string) => l.includes('Back'))).toBe(true)
  const back = ui.press({ key: expand.key })
  await clock.advance(5000)
  await back
  const again = (await ui.findAll({ type: 'Button' })).map((b: any) => String(b.props.label))
  expect(again.some((l: string) => l.includes('Expand'))).toBe(true)
})

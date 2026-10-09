import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadContent } from '../vite-plugin-content.ts'
import { diskPath, IncidentShell, sameInvocation, words } from '../src/game/shell.ts'
import { atStage } from '../src/schema/stages.ts'
import { commandsHit, evidenceSeen, newSession, step, type GameEvent } from '../src/game/engine.ts'
import { score } from '../src/game/scoring.ts'

const content = loadContent(path.resolve(import.meta.dirname, '../content'))
const incident = (id: string) => content.scenarios.find((s) => s.id === id)!

describe('matching scripted commands', () => {
  it('splits words like a shell', () => {
    expect(words(`aws s3api head-object --query "[A, B]" --key 'x y'`)).toEqual(['aws', 's3api', 'head-object', '--query', '[A, B]', '--key', 'x y'])
  })
  it('ignores flag order, = versus space, and long/short spellings', () => {
    const scripted = words('kubectl get pods -n shop -l app=search-api')
    expect(sameInvocation(scripted, words('kubectl get pods -l app=search-api --namespace shop'))).toBe(true)
    expect(sameInvocation(scripted, words('kubectl get pods --namespace=shop -l app=search-api'))).toBe(true)
    expect(sameInvocation(scripted, words('kubectl get pods -n other -l app=search-api'))).toBe(false)
    expect(sameInvocation(scripted, words('kubectl get deploy -n shop -l app=search-api'))).toBe(false)
  })
  it('finds files on disk from artifact names', () => {
    expect(diskPath('/etc/fstab', '/home/ops')).toBe('/etc/fstab')
    expect(diskPath('invoice-worker/job.py (excerpt)', '/home/ops')).toBe('/home/ops/invoice-worker/job.py')
    expect(diskPath('Change record: media disk migration (Sat 09-27)', '/home/ops')).toBeUndefined()
  })
})

describe('the shell', () => {
  const none = new Set<string>()

  it('pipes a scripted tool into real text tools, and reports the hit', async () => {
    const s = incident('crashloopbackoff')
    const sh = new IncidentShell(s)
    const r = await sh.run('kubectl get pods -n shop | grep -c CrashLoopBackOff', s, none)
    expect(r.output).toBe('3')
    expect(r.hits).toEqual(['kubectl get pods -n shop'])
  })

  it('keeps directory, variables and files between commands', async () => {
    const s = incident('crashloopbackoff')
    const sh = new IncidentShell(s)
    await sh.run('cd /tmp && export N=7 && echo $((N*6)) > answer', s, none)
    expect(sh.cwd).toBe('/tmp')
    expect((await sh.run('cat answer', s, none)).output).toBe('42')
  })

  it('puts the incident files on disk, so real tools work on them', async () => {
    const s = incident('full-disk')
    const sh = new IncidentShell(s)
    expect((await sh.run('grep -c log /etc/logrotate.d/app', s, none)).output).toMatch(/^\d+$/)
    expect((await sh.run('cat /etc/hostname', s, none)).output).toBe('web-01')
  })

  it('less and more print like cat (no terminal to page on), ignore their flags and read stdin', async () => {
    const s = incident('crashloopbackoff')
    const sh = new IncidentShell(s)
    await sh.run('cd /tmp && printf "a\\nb\\n" > f', s, none)
    for (const cmd of ['less f', 'less -N f', 'less -R +G f', 'more f', 'cat f | less', 'less < f'])
      expect(await sh.run(cmd, s, none), cmd).toMatchObject({ output: 'a\nb', exitCode: 0 })
    expect(await sh.run('less nope', s, none)).toMatchObject({ output: 'less: nope: No such file or directory', exitCode: 1 })
  })

  it('answers --help with what the tool can show here, and is honest about the rest', async () => {
    const s = incident('crashloopbackoff')
    const sh = new IncidentShell(s)
    expect((await sh.run('kubectl --help', s, none)).output).toMatch(/kubectl get pods -n shop/)
    expect((await sh.run('kubectl get nodes', s, none)).output).toMatch(/no simulated output/)
    expect((await sh.run('nope', s, none)).output).toBe('bash: nope: command not found')
  })

  it('ssh runs a command on another host, or logs in until exit', async () => {
    const s = incident('incomplete-cert-chain')
    const sh = new IncidentShell(s)
    const r = await sh.run('ssh api-01 grep ssl_certificate /etc/nginx/sites-enabled/api', s, none)
    expect(r.output).toMatch(/api\.example\.com\.crt/)
    expect((await sh.run('ssh nowhere uptime', s, none)).output).toMatch(/Could not resolve hostname nowhere/)
    await sh.run('ssh api-01', s, none)
    expect(sh.currentHost).toBe('api-01')
    expect((await sh.run('cat /etc/hostname', s, none)).output).toBe('api-01')
    await sh.run('exit', s, none)
    expect(sh.currentHost).not.toBe('api-01')
  })

  it('sudo runs shell commands and finds scripted sudo lines', async () => {
    const s = incident('media-disk-migration-major')
    const sh = new IncidentShell(s)
    expect((await sh.run('sudo mkdir -p /mnt/rootfs && ls -d /mnt/rootfs', s, none)).output).toBe('/mnt/rootfs')
  })

  it('stage files appear on disk when the stage does', async () => {
    const s = incident('pgbouncer-transaction-pooling-major')
    const sh = new IncidentShell(s)
    expect((await sh.run('ls ~/invoice-worker 2>&1', s, none)).output).toMatch(/No such file/)
    expect((await sh.run('grep -c advisory ~/invoice-worker/job.py', atStage(s, 1), none)).output).toBe('2')
  })
})

describe('the engine and SHELL_RAN', () => {
  it('a pipeline that starts with a pattern command is the shell\'s to run', async () => {
    const { engineHandles } = await import('../src/game/engine.ts')
    const s = incident('full-disk')
    expect(engineHandles(s, 'journalctl -u checkout', [])).toBe(true)
    expect(engineHandles(s, 'journalctl -u checkout | grep -c Errno', [])).toBe(false)
    expect((await new IncidentShell(s).run('journalctl -u checkout | grep -c Errno', s, new Set())).output).toBe('1')
  })

  it('counts tools run inside a pipeline for evidence, the breakdown and verification', () => {
    const s = content.scenarios.find((x) => x.terminal?.commands.some((c) => c.evidence && c.match && !c.when_actions))!
    let t = 0
    const ev = (e: Record<string, unknown>) => ({ ...e, at: (t += 1000) }) as GameEvent
    const tagged = s.terminal!.commands.find((c) => c.evidence && c.match && !c.when_actions)!
    const log = [
      ev({ type: 'START' }),
      ev({ type: 'RUN_COMMAND', input: `${tagged.match} | head -3` }),
      ev({ type: 'SHELL_RAN', commands: [tagged.match] }),
    ].reduce((x, e) => step(s, x, e), newSession()).log
    expect(evidenceSeen(s, log).has(tagged.evidence!)).toBe(true)
    expect(commandsHit(s, log).has(tagged.match!)).toBe(true)
    expect(score(s, log).verified).toBe(false) // nothing fixed yet
  })
})

describe('fixes made by editing files', () => {
  it('a fix taken with its button writes the fixed file, so the disk agrees with the game', async () => {
    const s = incident('full-disk')
    const sh = new IncidentShell(s)
    expect((await sh.run('head -1 /etc/logrotate.d/app', s, new Set())).output).toBe('/var/log/ap/*.log {')
    await sh.update(s, new Set(['fix-logrotate']))
    expect((await sh.read('/etc/logrotate.d/app'))?.split('\n')[0]).toBe('/var/log/app/*.log {')
  })

  it('the incident file wins over the skeleton (resolv.conf)', async () => {
    const s = incident('dns-resolution-failure')
    const sh = new IncidentShell(s)
    expect((await sh.run('grep nameserver /etc/resolv.conf', s, new Set())).output).toBe('nameserver 10.0.0.53')
  })

  it('validates file fixes: on disk, not already fixed, and `after` counts as fixed', async () => {
    const { ScenarioSchema } = await import('../src/schema/scenario.ts')
    const s = structuredClone(incident('full-disk'))
    const fix = s.actions.find((a) => a.id === 'fix-logrotate')!
    expect(ScenarioSchema.safeParse(s).success).toBe(true)
    expect(ScenarioSchema.safeParse({ ...s, actions: s.actions.map((a) => (a.id === 'fix-logrotate' ? { ...a, file: { ...fix.file!, path: '/etc/nope' } } : a)) }).error?.issues.map((i) => i.message)).toContain(
      "/etc/nope isn't on disk at this stage (add it as a file, a log with that name, or a scripted cat)",
    )
    expect(ScenarioSchema.safeParse({ ...s, actions: s.actions.map((a) => (a.id === 'fix-logrotate' ? { ...a, file: { ...fix.file!, matches: 'daily' } } : a)) }).error?.issues.map((i) => i.message)).toContain(
      'the file already matches before any fix',
    )
    expect(ScenarioSchema.safeParse({ ...s, actions: s.actions.map((a) => (a.id === 'fix-logrotate' ? { ...a, file: { ...fix.file!, after: 'nothing' } } : a)) }).error?.issues.map((i) => i.message)).toContain(
      "`after` doesn't match `matches`",
    )
  })
})

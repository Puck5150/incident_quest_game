// The real shell behind the terminal (PLAN_TERMINAL.md). just-bash gives us
// bash syntax and its text tools over an in-memory filesystem; the incident's
// own tools (aws, kubectl, systemctl...) are custom commands that answer from
// its scripted commands, so their output can be piped, redirected and saved.
// Each host the incident mentions has its own filesystem; `ssh` moves between
// them.
//
// Loaded lazily: it's a large chunk, and only the terminal needs it.
import { Bash, defineCommand, getCommandNames, type CommandName } from 'just-bash'
import type { Scenario } from '../schema/scenario.ts'
import { normalize } from './engine.ts'

// Real tools that just-bash doesn't implement. Each answers from the incident's
// scripted commands, or says honestly that this incident doesn't cover it.
const TOOLS = [
  'aws', 'az', 'gcloud', 'gsutil', 'bq', 'kubectl', 'helm', 'docker', 'terraform', 'gh', 'git',
  'systemctl', 'journalctl', 'service', 'ps', 'top', 'free', 'df', 'uptime', 'lsblk', 'blkid', 'findmnt',
  'mount', 'umount', 'dmesg', 'ausearch', 'getenforce', 'restorecon', 'namei', 'crontab', 'logrotate',
  'ip', 'ss', 'netstat', 'ping', 'traceroute', 'tracepath', 'mtr', 'dig', 'nslookup', 'host', 'nc', 'telnet',
  'arping', 'nft', 'iptables', 'ufw', 'openssl', 'certbot', 'nginx', 'apachectl', 'curl', 'wget', 'scp',
  'psql', 'pg_isready', 'mysql', 'sqlcmd', 'redis-cli', 'rabbitmqctl', 'rabbitmq-diagnostics',
  'kafka-consumer-groups.sh', 'kafka-consumer-groups', 'named-checkzone', 'sshd', 'Test-NetConnection', 'net',
  'npm', 'node', 'python3', 'python', 'pip', 'make', 'chown', 'chgrp', 'kill', 'pkill', 'lsof', 'strace',
  'timedatectl', 'id', 'last', 'w', 'vmstat', 'iostat', 'sar', 'nproc', 'lscpu', 'uname',
]
// Built in to just-bash but not usable in the browser build (archive tools need
// Node's zlib, sqlite3 a WASM module).
const OFF = ['gzip', 'gunzip', 'zcat', 'tar', 'sqlite3', 'html-to-markdown', 'xan']
const BUILTINS = new Set<string>(getCommandNames())

// Long and short spellings of the same flag, per tool, so either matches.
const ALIASES: Record<string, Record<string, string>> = {
  kubectl: { '--namespace': '-n', '--output': '-o', '--selector': '-l', '--container': '-c', '--follow': '-f' },
  az: { '--resource-group': '-g', '--name': '-n', '--output': '-o', '--out': '-o', '--subscription': '-s' },
  gh: { '--limit': '-L', '--repo': '-R' },
  systemctl: { '--property': '-p' },
  journalctl: { '--unit': '-u', '--lines': '-n', '--boot': '-b', '--follow': '-f' },
  psql: { '--dbname': '-d', '--command': '-c', '--username': '-U', '--host': '-h', '--port': '-p' },
}

// Split a command line into words the way a shell would (quotes group, and
// are removed). Good enough for comparing scripted commands.
export function words(line: string): string[] {
  const out: string[] = []
  let cur = ''
  let quote: string | undefined
  let started = false
  for (const ch of line) {
    if (quote) {
      if (ch === quote) quote = undefined
      else cur += ch
    } else if (ch === '"' || ch === "'") {
      quote = ch
      started = true
    } else if (/\s/.test(ch)) {
      if (started) out.push(cur)
      cur = ''
      started = false
    } else {
      cur += ch
      started = true
    }
  }
  if (started) out.push(cur)
  return out
}

// Two invocations of the same tool are the same if they run the same
// subcommand with the same arguments and the same flags, whatever order the
// flags come in, `--flag=value` or `--flag value`, long or short spelling.
export function sameInvocation(a: string[], b: string[]): boolean {
  const shape = (w: string[]) => {
    const alias = ALIASES[w[0]] ?? {}
    const expanded = w
      .flatMap((x) => {
        const m = x.match(/^(--[\w-]+)=(.*)$/)
        return m ? [m[1], m[2]] : [x]
      })
      .map((x) => alias[x] ?? x)
    const head: string[] = []
    const groups: string[] = []
    let i = 0
    while (i < expanded.length && !expanded[i].startsWith('-')) head.push(expanded[i++])
    while (i < expanded.length) {
      const group = [expanded[i++]]
      while (i < expanded.length && !expanded[i].startsWith('-')) group.push(expanded[i++])
      groups.push(group.join('\u0000'))
    }
    return head.join('\u0000') + '\u0001' + groups.sort().join('\u0001')
  }
  return shape(a) === shape(b)
}

const quote = (a: string) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`)
const withNewline = (s: string) => (s && !s.endsWith('\n') ? s + '\n' : s)

// An artifact's path on disk, if its name is one: "/etc/fstab",
// "~/notes.txt", or "deploy/main.tf (excerpt)" relative to the home directory.
export function diskPath(name: string, home: string): string | undefined {
  const bare = name.replace(/ \([^)]*\)$/, '')
  if (/\s/.test(bare)) return undefined
  if (bare.startsWith('/')) return bare
  if (bare.startsWith('~/')) return home + bare.slice(1)
  if (/^\.?[\w.-]+(\/[\w.@-]+)+$/.test(bare)) return `${home}/${bare}`
  return undefined
}

type Ctx = { cwd: string; exec?: (command: string, options: { cwd: string }) => Promise<{ stdout: string; stderr: string; exitCode: number }> }
type Out = { stdout: string; stderr: string; exitCode: number }
export type ShellResult = { output: string; exitCode: number; hits: string[] }

export class IncidentShell {
  readonly user: string
  readonly mainHost: string
  private host: string
  private hosts = new Map<string, Bash>()
  private envs = new Map<string, Record<string, string>>()
  private known: Set<string>
  private context: { scenario: Scenario; taken: Set<string> }
  private hits: string[] = []
  private mounted = new Set<string>()
  private ready: Promise<unknown>
  private readonly base: Scenario

  constructor(scenario: Scenario) {
    this.base = scenario
    this.context = { scenario, taken: new Set() }
    const m = scenario.terminal?.prompt.match(/^([\w.-]+)@([\w.-]+)/)
    this.user = m?.[1] ?? 'ops'
    this.mainHost = m?.[2] ?? 'localhost'
    this.host = this.mainHost
    // Hosts the incident reaches over ssh.
    this.known = new Set([this.mainHost])
    for (const c of this.allCommands()) {
      const h = normalize(c.match ?? c.example ?? '').match(/^ssh (?:-\S+ )*([\w.-]+)(?: |$)/)?.[1]
      if (h) this.known.add(h)
    }
    this.ready = this.makeHost(this.mainHost)
  }

  private allCommands() {
    return [this.base, ...(this.base.stages ?? [])].flatMap((p) => p.terminal?.commands ?? [])
  }

  get home() {
    return this.user === 'root' ? '/root' : `/home/${this.user}`
  }
  get cwd() {
    return this.envs.get(this.host)?.PWD ?? this.home
  }
  get currentHost() {
    return this.host
  }

  // A host's filesystem: a small, believable Linux skeleton, plus (on the
  // host you start on) the incident's files and logs at their paths.
  private async makeHost(name: string): Promise<Bash> {
    const existing = this.hosts.get(name)
    if (existing) return existing
    const home = this.home
    const programs = new Set(TOOLS)
    for (const c of this.allCommands()) {
      const w = words(normalize(c.match ?? c.example ?? ''))
      const first = w[0] === 'ssh' ? w.find((x, i) => i > 1 && !x.startsWith('-') && x !== 'sudo') : w[0] === 'sudo' ? w[1] : w[0]
      if (first && /^[\w.-]+$/.test(first)) programs.add(first)
    }
    for (const b of BUILTINS) programs.delete(b)
    programs.delete('ssh')
    programs.delete('sudo')
    const bash = new Bash({
      cwd: home,
      env: { USER: this.user, LOGNAME: this.user, HOSTNAME: name, HOME: home, TERM: 'xterm-256color', SHELL: '/bin/bash', LANG: 'C.UTF-8' },
      files: {
        '/etc/hostname': name + '\n',
        '/etc/hosts': `127.0.0.1 localhost\n127.0.1.1 ${name}\n`,
        '/etc/os-release': 'PRETTY_NAME="Ubuntu 24.04.1 LTS"\nNAME="Ubuntu"\nVERSION_ID="24.04"\nID=ubuntu\n',
        '/etc/passwd': `root:x:0:0:root:/root:/bin/bash\n${this.user === 'root' ? '' : `${this.user}:x:1000:1000::${home}:/bin/bash\n`}`,
        '/etc/resolv.conf': 'nameserver 127.0.0.53\noptions edns0 trust-ad\n',
        [`${home}/.bashrc`]: '# ~/.bashrc\nalias ll="ls -alF"\n',
        [`${home}/.bash_history`]: '',
      },
      commands: getCommandNames().filter((c) => !OFF.includes(c)) as CommandName[],
      customCommands: [
        ...[...programs].map((p) => defineCommand(p, (args) => Promise.resolve(this.program(name, p, args)))),
        defineCommand('ssh', (args) => this.ssh(name, args)),
        defineCommand('sudo', (args, ctx) => this.sudo(name, args, ctx as unknown as Ctx)),
      ],
      executionLimits: { maxExecutionTimeMs: 5_000 },
    })
    this.hosts.set(name, bash)
    await bash.exec('mkdir -p /tmp /var/log /var/tmp /root /usr/local/bin /opt /srv')
    this.envs.set(name, (await bash.exec('true')).env)
    return bash
  }

  // Put the files and logs of the current stage on disk (on the starting
  // host), the first time they're available. Scripted `cat /path` outputs
  // count as files too, so grep and wc work on them.
  private async mount(scenario: Scenario) {
    const bash = this.hosts.get(this.mainHost)!
    const add = async (path: string, content: string) => {
      if (this.mounted.has(path)) return
      this.mounted.add(path)
      if (await bash.fs.exists(path)) return
      await bash.fs.mkdir(path.replace(/\/[^/]*$/, '') || '/', { recursive: true })
      await bash.fs.writeFile(path, withNewline(content))
    }
    for (const f of scenario.files ?? []) {
      const p = diskPath(f.path, this.home)
      if (p) await add(p, f.content)
    }
    for (const l of scenario.logs ?? []) {
      const p = diskPath(l.name, this.home)
      if (p) await add(p, l.lines)
    }
    for (const c of scenario.terminal?.commands ?? []) {
      const file = normalize(c.match ?? c.example ?? '').match(/^(?:sudo )?cat (\/\S+)$/)?.[1]
      if (file && !c.when_actions?.length) await add(file, c.output)
    }
  }

  // A tool invocation inside the shell: the scripted output whose command
  // matches (given the actions taken so far), or an honest "not covered here".
  private program(host: string, name: string, args: string[], sudo = false): Out {
    const want = [name, ...args]
    const { scenario, taken } = this.context
    // On another host, scripted commands are written "ssh HOST ...".
    const prefix = host === this.mainHost ? [] : ['ssh', host]
    const forms = sudo ? [[...prefix, 'sudo', ...want], [...prefix, ...want]] : [[...prefix, ...want], [...prefix, 'sudo', ...want]]
    const hit = (scenario.terminal?.commands ?? []).find((c) => {
      if (!(c.when_actions ?? []).every((a) => taken.has(a))) return false
      if (c.match !== undefined) {
        const w = words(normalize(c.match))
        return forms.some((f) => sameInvocation(w, f))
      }
      const rx = new RegExp(c.match_regex!)
      return forms.some((f) => rx.test(normalize(f.map(quote).join(' '))) || rx.test(normalize(f.join(' '))))
    })
    if (hit) {
      this.hits.push(hit.match ?? hit.example ?? want.join(' '))
      return { stdout: withNewline(hit.output), stderr: '', exitCode: 0 }
    }
    if (args.includes('--help') || args[0] === 'help' || (args.length === 1 && args[0] === '-h')) {
      const here = [...new Set(this.allCommands().map((c) => normalize(c.match ?? c.example ?? '')).filter((c) => c.startsWith(name + ' ')))]
      const list = here.length ? `\nIn this incident, ${name} can show you:\n${here.map((h) => `  ${h}`).join('\n')}\n` : ''
      return { stdout: `Usage: ${name} [subcommand] [flags]\n(simulated: this ${name} answers from the incident's data)\n${list}`, stderr: '', exitCode: 0 }
    }
    const note = (scenario.terminal?.unknown_output ?? '{cmd}: no simulated output for that here. Type help for commands that work.').replaceAll('{cmd}', name)
    return { stdout: '', stderr: note + '\n', exitCode: 1 }
  }

  // sudo COMMAND: tools answer from scripted "sudo ..." lines first; the
  // shell's own commands just run (you're allowed everything here).
  private async sudo(host: string, args: string[], ctx: Ctx): Promise<Out> {
    const rest = args[0] === '-u' ? args.slice(2) : args.filter((a, i) => !(i === 0 && a.startsWith('-')))
    if (!rest.length) return { stdout: '', stderr: 'usage: sudo command\n', exitCode: 1 }
    if (args[0] === '-u' || !BUILTINS.has(rest[0])) return this.program(host, args[0] === '-u' ? 'sudo' : rest[0], args[0] === '-u' ? args : rest.slice(1), args[0] !== '-u')
    if (!ctx.exec) return { stdout: '', stderr: 'sudo: unavailable\n', exitCode: 1 }
    return ctx.exec(rest.map(quote).join(' '), { cwd: ctx.cwd })
  }

  // ssh HOST [COMMAND]: with a command, run it there; without, log in.
  private async ssh(from: string, args: string[]): Promise<Out> {
    const i = args.findIndex((a) => !a.startsWith('-'))
    if (i < 0) return { stdout: '', stderr: 'usage: ssh [-options] destination [command]\n', exitCode: 255 }
    const dest = args[i].replace(/^[\w.-]+@/, '')
    const command = args.slice(i + 1)
    // A scripted "ssh HOST ..." line answers first.
    if (command.length) {
      const scripted = this.program(this.mainHost, 'ssh', args)
      if (scripted.exitCode === 0) return scripted
    }
    if (!this.known.has(dest)) return { stdout: '', stderr: `ssh: Could not resolve hostname ${dest}: Name or service not known\n`, exitCode: 255 }
    const bash = await this.makeHost(dest)
    if (!command.length) {
      this.host = dest
      return { stdout: `Welcome to Ubuntu 24.04.1 LTS\nLast login from ${from}\n`, stderr: '', exitCode: 0 }
    }
    const env = this.envs.get(dest)!
    const r = await bash.exec(command.map(quote).join(' '), { env, cwd: env.PWD })
    return { stdout: r.stdout, stderr: r.stderr, exitCode: r.exitCode }
  }

  // Run one line typed at the prompt. `scenario` is the incident as it stands
  // at the player's current stage; `taken` the actions taken so far.
  async run(input: string, scenario: Scenario, taken: Set<string>): Promise<ShellResult> {
    await this.ready
    this.context = { scenario, taken }
    this.hits = []
    await this.mount(scenario)
    if (/^\s*(exit|logout)\s*$/.test(input) && this.host !== this.mainHost) {
      const was = this.host
      this.host = this.mainHost
      return { output: `logout\nConnection to ${was} closed.`, exitCode: 0, hits: [] }
    }
    const bash = this.hosts.get(this.host)!
    const env = this.envs.get(this.host)!
    const r = await bash.exec(input, { env, cwd: env.PWD })
    this.envs.set(this.host, r.env)
    return { output: (r.stdout + r.stderr).replace(/\n$/, ''), exitCode: r.exitCode, hits: [...new Set(this.hits)] }
  }

  // Names in a directory on the current host, for Tab completion of paths.
  async list(dir: string): Promise<{ name: string; dir: boolean }[]> {
    await this.ready
    const bash = this.hosts.get(this.host)!
    const path = bash.fs.resolvePath(this.cwd, dir || '.')
    try {
      const names = await bash.fs.readdir(path)
      return await Promise.all(names.map(async (n) => ({ name: n, dir: (await bash.fs.stat(`${path}/${n}`.replace(/\/+/g, '/'))).isDirectory })))
    } catch {
      return []
    }
  }

  // A file's contents on the starting host (for fixes made by editing files).
  async read(path: string): Promise<string | undefined> {
    await this.ready
    try {
      return await this.hosts.get(this.mainHost)!.fs.readFile(path)
    } catch {
      return undefined
    }
  }
}

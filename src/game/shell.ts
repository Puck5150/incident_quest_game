// The real shell behind the terminal (PLAN_TERMINAL.md). just-bash gives us
// bash syntax and its text tools over an in-memory filesystem; the incident's
// own tools (aws, kubectl, systemctl...) are custom commands that answer from
// its scripted commands, so their output can be piped, redirected and saved.
//
// Loaded lazily: it's a large chunk, and only the terminal needs it.
import { Bash, defineCommand, getCommandNames } from 'just-bash'
import type { Scenario } from '../schema/scenario.ts'
import { normalize } from './engine.ts'

// Real tools that just-bash doesn't implement. Each answers from the incident's
// scripted commands, or says honestly that this incident doesn't cover it.
const TOOLS = [
  'aws', 'az', 'gcloud', 'gsutil', 'bq', 'kubectl', 'helm', 'docker', 'terraform', 'gh', 'git',
  'systemctl', 'journalctl', 'service', 'ps', 'top', 'free', 'df', 'uptime', 'lsblk', 'blkid', 'findmnt',
  'mount', 'umount', 'dmesg', 'ausearch', 'getenforce', 'restorecon', 'namei', 'crontab', 'logrotate',
  'ip', 'ss', 'netstat', 'ping', 'traceroute', 'tracepath', 'mtr', 'dig', 'nslookup', 'host', 'nc', 'telnet',
  'arping', 'nft', 'iptables', 'ufw', 'openssl', 'certbot', 'nginx', 'apachectl', 'curl', 'wget', 'ssh', 'scp',
  'psql', 'pg_isready', 'mysql', 'sqlcmd', 'redis-cli', 'rabbitmqctl', 'rabbitmq-diagnostics',
  'kafka-consumer-groups.sh', 'kafka-consumer-groups', 'named-checkzone', 'sshd', 'Test-NetConnection', 'net',
  'npm', 'node', 'python3', 'python', 'pip', 'make', 'sudo', 'chown', 'chgrp', 'kill', 'pkill', 'lsof', 'strace',
]

// What the scripted commands are matched against: the line with quotes removed
// and spaces collapsed, so `--query 'a b'` and `--query "a b"` are the same.
const loose = (s: string) => normalize(s.replace(/["']/g, ''))
const quote = (a: string) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`)

type Context = { scenario: Scenario; taken: Set<string> }

export type ShellResult = { output: string; exitCode: number }

export class IncidentShell {
  private bash: Bash
  private env: Record<string, string> = {}
  private context: Context
  private homeDir: string

  constructor(scenario: Scenario) {
    this.context = { scenario, taken: new Set() }
    const programs = new Set(TOOLS)
    for (const part of [scenario, ...(scenario.stages ?? [])])
      for (const c of part.terminal?.commands ?? []) {
        const first = normalize(c.match ?? c.example ?? '').split(' ')[0]
        if (first && /^[\w.-]+$/.test(first)) programs.add(first)
      }
    const user = scenario.terminal?.prompt.match(/^([\w.-]+)@([\w.-]+)/)
    this.homeDir = '/home/' + (user?.[1] ?? 'ops')
    this.bash = new Bash({
      cwd: '/home/' + (user?.[1] ?? 'ops'),
      env: { USER: user?.[1] ?? 'ops', HOSTNAME: user?.[2] ?? 'host', HOME: '/home/' + (user?.[1] ?? 'ops'), TERM: 'xterm-256color' },
      files: { [`/home/${user?.[1] ?? 'ops'}/.bash_history`]: '' },
      // Not in the browser build: archive tools need Node's zlib, sqlite3 a WASM module.
      commands: getCommandNames().filter((c) => !['gzip', 'gunzip', 'zcat', 'tar', 'sqlite3', 'html-to-markdown', 'xan'].includes(c)),
      customCommands: [...programs].map((name) => defineCommand(name, (args) => Promise.resolve(this.program(name, args)))),
      executionLimits: { maxExecutionTimeMs: 5_000 },
    })
    // A few directories every Linux host has (T3 adds per-host filesystems).
    this.ready = this.bash.exec('mkdir -p /etc /tmp /var/log /var/tmp /root').then(() => undefined)
  }

  private ready: Promise<void>

  // A tool invocation inside the shell: the scripted output whose command
  // matches, given the actions taken so far, or an honest "not covered here".
  private program(name: string, args: string[]) {
    const line = [name, ...args].map(quote).join(' ')
    const { scenario, taken } = this.context
    const want = loose([name, ...args].join(' '))
    const hit = (scenario.terminal?.commands ?? []).find(
      (c) =>
        (c.when_actions ?? []).every((a) => taken.has(a)) &&
        (c.match !== undefined ? loose(c.match) === want : new RegExp(c.match_regex!).test(normalize(line))),
    )
    if (hit) return { stdout: hit.output.endsWith('\n') || !hit.output ? hit.output : hit.output + '\n', stderr: '', exitCode: 0 }
    const note = (scenario.terminal?.unknown_output ?? '{cmd}: no simulated output for that here. Type help for commands that work.').replaceAll('{cmd}', name)
    return { stdout: '', stderr: note + '\n', exitCode: 1 }
  }

  // Run one line typed at the prompt. `scenario` is the incident as it stands
  // at the player's current stage; `taken` the actions taken so far.
  async run(input: string, scenario: Scenario, taken: Set<string>): Promise<ShellResult> {
    await this.ready
    this.context = { scenario, taken }
    const r = await this.bash.exec(input, { env: this.env, cwd: this.env.PWD })
    this.env = r.env
    return { output: (r.stdout + r.stderr).replace(/\n$/, ''), exitCode: r.exitCode }
  }

  get home() {
    return this.env.HOME ?? this.homeDir
  }

  get cwd() {
    return this.env.PWD ?? this.bash.getCwd()
  }
}

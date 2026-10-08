// Where the lab's files live and the lock file `init` writes. Dependency-free
// so the eagerly loaded paths.ts can use it without pulling in the simulator.
import type { TerraformBlock } from '../../schema/scenario.ts'

export const PROVIDER_VERSION = '5.67.0'
export const AWS_SOURCE = 'registry.terraform.io/hashicorp/aws'

export const join = (a: string, b: string) => `${a.replace(/\/+$/, '')}/${b.replace(/^\.?\//, '')}`

export const labDir = (tf: TerraformBlock, startDir: string, home: string) =>
  !tf.dir ? startDir : tf.dir.startsWith('/') ? tf.dir : tf.dir.startsWith('~/') ? join(home, tf.dir.slice(2)) : join(startDir, tf.dir)

export const labFiles = (tf: TerraformBlock, startDir: string, home: string) => {
  const dir = labDir(tf, startDir, home)
  return tf.files.map((f) => ({ path: join(dir, f.path), content: f.content }))
}

export const lockBlock = (p: string) => `provider "${p}" {\n  version = "${PROVIDER_VERSION}"\n  hashes = [\n    "h1:Zq0uB8Zc1nS5eYpR3m7KpTz2W0k6YV3d8J4bN1xQwLs=",\n  ]\n}\n`
export const lockFile = (providers: string[]) => {
  const blocks = providers.map(lockBlock)
  return `# This file is maintained automatically by "terraform init".\n# Manual edits may be lost in future updates.\n\n${blocks.join('\n')}`
}
// The text mounted for an initialised lab (an AWS-only lock file).
export const LOCK_FILE = lockFile([AWS_SOURCE])

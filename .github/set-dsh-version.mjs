import { readFileSync, writeFileSync } from 'node:fs'

const version = process.argv[2]?.replace(/^dsh-v/, '')
if (version === undefined || !/^\d+\.\d+\.\d+(?:-rc\.\d+)?$/.test(version)) {
  throw new Error(`Invalid DeepSeek Harness release: ${process.argv[2] ?? ''}`)
}

const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
for (const dependencies of [pkg.peerDependencies, pkg.devDependencies]) {
  for (const name of Object.keys(dependencies)) {
    if (name.startsWith('@deepseek-ai/dsh-')) dependencies[name] = version
  }
}
writeFileSync('package.json', `${JSON.stringify(pkg, null, 2)}\n`)

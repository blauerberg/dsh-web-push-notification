import { readFileSync, writeFileSync } from 'node:fs'

const version = process.argv[2]?.replace(/^dsh-v/, '')
if (version === undefined || !/^\d+\.\d+\.\d+(?:-rc\.\d+)?$/.test(version)) {
  throw new Error(`Invalid DeepSeek Harness release: ${process.argv[2] ?? ''}`)
}

const pkg = JSON.parse(readFileSync('package.json', 'utf8'))

const dependencyGroups = [pkg.peerDependencies, pkg.devDependencies]
const dshPackageNames = new Set(
  dependencyGroups
    .flatMap((dependencies) => Object.keys(dependencies ?? {}))
    .filter((name) => name.startsWith('@deepseek-ai/dsh-')),
)

const publishedPackageNames = new Set()
for (const name of dshPackageNames) {
  const response = await fetch(
    `https://registry.npmjs.org/${encodeURIComponent(name)}/${version}`,
  )
  if (response.status === 404) {
    await response.body?.cancel()
    continue
  }
  if (!response.ok) {
    throw new Error(
      `Unable to check ${name}@${version}: npm registry returned HTTP ${response.status}`,
    )
  }

  const packageInfo = await response.json()
  if (packageInfo.name !== name || packageInfo.version !== version) {
    throw new Error(`Unexpected npm metadata for ${name}@${version}`)
  }
  publishedPackageNames.add(name)
}

for (const dependencies of dependencyGroups) {
  for (const name of Object.keys(dependencies ?? {})) {
    if (publishedPackageNames.has(name)) dependencies[name] = version
  }
}

const unpublishedPackageNames = [...dshPackageNames].filter(
  (name) => !publishedPackageNames.has(name),
)
if (unpublishedPackageNames.length > 0) {
  console.log(
    `Keeping declared versions for DSH packages not published at ${version}: ${unpublishedPackageNames.join(', ')}`,
  )
}

writeFileSync('package.json', `${JSON.stringify(pkg, null, 2)}\n`)

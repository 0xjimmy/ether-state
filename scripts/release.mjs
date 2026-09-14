export function releaseVersion(packageJson, lockfile) {
  if (packageJson.name !== 'ether-state') throw new Error('Unexpected package name')
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(packageJson.version)) {
    throw new Error('Only stable versions can publish from release')
  }
  if (packageJson.version !== lockfile.version || packageJson.version !== lockfile.packages?.['']?.version) {
    throw new Error('Package and lockfile versions differ')
  }
  return packageJson.version
}

export function shouldPublish(version, metadata) {
  if (metadata.versions === undefined || typeof metadata.versions !== 'object' || metadata.versions === null) {
    throw new Error('Registry versions are missing')
  }
  if (Object.hasOwn(metadata.versions, version)) return false
  const latest = metadata['dist-tags']?.latest
  if (typeof latest !== 'string' || !/^\d+\.\d+\.\d+$/.test(latest)) throw new Error('Registry latest version is invalid')
  const current = latest.split('.').map(BigInt)
  const next = version.split('.').map(BigInt)
  for (let index = 0; index < 3; index++) {
    if (next[index] > current[index]) return true
    if (next[index] < current[index]) throw new Error('Release would downgrade npm latest')
  }
  throw new Error('Registry latest version is missing from its versions')
}

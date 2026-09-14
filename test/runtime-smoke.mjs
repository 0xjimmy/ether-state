export async function smoke(api) {
  for (const name of ['EvmClient', 'getChainList', 'getChain', 'getRpcEndpoints', 'getExplorers']) {
    if (typeof api[name] !== 'function') throw new Error(`Missing export: ${name}`)
  }
  if ('EtherState' in api || 'TriggerType' in api) throw new Error('Legacy API still exported')
  return 'ok'
}

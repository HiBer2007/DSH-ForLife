import { Config, resolveConfig } from './src/config.ts'
const resolved = Config({})
console.log('Config({}) 的 exposePanelApi =', JSON.stringify(resolved.exposePanelApi))
console.log('Config({}) 的 registerTools =', JSON.stringify(resolved.registerTools))
const plain = resolveConfig({})
console.log('resolveConfig({}) 的 exposePanelApi =', JSON.stringify(plain.exposePanelApi))
console.log('resolveConfig({verbose:true}) 的 exposePanelApi =', JSON.stringify(resolveConfig({ verbose: true }).exposePanelApi))
process.exit(0)

import { builtinHarness } from './builtin'
import type { HarnessAdapter, ProviderAdapter } from './contracts'
import { compatibleProvider } from './provider'
import { AdapterRegistry } from './registry'
import { TaskRuntime, type RuntimePersistence } from './runtime'

export function createAssistantRuntime(persistence: RuntimePersistence) {
  const harnesses = new AdapterRegistry<HarnessAdapter>('阅读伙伴')
  const providers = new AdapterRegistry<ProviderAdapter>('模型连接')
  harnesses.register(builtinHarness)
  providers.register(compatibleProvider)
  harnesses.select(builtinHarness.id)
  providers.select(compatibleProvider.id)
  return new TaskRuntime(harnesses, providers, persistence)
}

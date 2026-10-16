type Adapter = { id: string; capabilities: object }

/** Only application-bundled adapters are registered here; this never loads plugin code. */
export class AdapterRegistry<T extends Adapter> {
  private adapters = new Map<string, { adapter: T; enabled: boolean }>()
  private listeners = new Set<() => void>()
  private selected: string | null = null

  constructor(private label: string) {}

  get selectedId() {
    return this.selected
  }

  register(adapter: T) {
    if (!/^[a-zA-Z0-9_-]{1,160}$/.test(adapter.id)) throw new Error('后端标识无效。')
    if (this.adapters.has(adapter.id)) throw new Error('同一后端已经注册，请先移除旧版本。')
    this.adapters.set(adapter.id, { adapter, enabled: true })
    this.emit()
  }

  select(id: string) {
    const entry = this.entry(id)
    if (!entry.enabled) throw new Error(`${this.label}已停用，请先启用。`)
    if (this.selected === id) return
    this.selected = id
    this.emit()
  }

  setEnabled(id: string, enabled: boolean) {
    const entry = this.entry(id)
    if (entry.enabled === enabled) return
    entry.enabled = enabled
    this.emit()
  }

  unregister(id: string) {
    if (!this.adapters.delete(id)) return
    if (this.selected === id) this.selected = null
    this.emit()
  }

  current(): T | null {
    const entry = this.selected ? this.adapters.get(this.selected) : null
    return entry?.enabled ? entry.adapter : null
  }

  list() {
    return [...this.adapters.entries()].map(([id, { adapter, enabled }]) => ({
      id,
      capabilities: structuredClone(adapter.capabilities),
      enabled,
      selected: this.selected === id,
    }))
  }

  subscribe(listener: () => void) {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private entry(id: string) {
    const entry = this.adapters.get(id)
    if (!entry) throw new Error(`${this.label}尚未注册。`)
    return entry
  }

  private emit() {
    for (const listener of this.listeners) listener()
  }
}

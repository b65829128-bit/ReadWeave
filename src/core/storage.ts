import { invoke, isTauri } from '@tauri-apps/api/core'

export type Collection = 'books' | 'annotations' | 'conversations' | 'settings' | 'packs'
const collections: Collection[] = ['books', 'annotations', 'conversations', 'settings', 'packs']
let database: Promise<IDBDatabase> | undefined

function openDatabase(): Promise<IDBDatabase> {
  return (database ??= new Promise((resolve, reject) => {
    const request = indexedDB.open('readweave', 1)
    request.onupgradeneeded = () => {
      for (const name of [...collections, 'blobs']) request.result.createObjectStore(name)
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => {
      database = undefined
      reject(new Error('无法打开本地数据库，请检查浏览器存储设置。'))
    }
  }))
}

async function transaction<T>(
  collection: string,
  mode: IDBTransactionMode,
  operation: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await openDatabase()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(collection, mode)
    const request = operation(tx.objectStore(collection))
    tx.oncomplete = () => resolve(request.result)
    tx.onerror = () => reject(new Error('本地数据保存失败。请检查剩余空间，并导出备份。'))
    tx.onabort = () => reject(new Error('本地数据操作中断。'))
  })
}

export const storage = {
  async credentialHas(): Promise<boolean> {
    if (!isTauri()) return false
    try {
      return await invoke('credential_has')
    } catch {
      throw new Error('无法读取本机系统安全凭据，请检查系统凭据存储。')
    }
  },
  async credentialSet(apiKey: string): Promise<void> {
    if (!isTauri()) throw new Error('浏览器预览不提供密钥持久化。')
    try {
      await invoke('credential_set', { apiKey })
    } catch {
      throw new Error('无法保存到本机系统安全凭据，请检查系统凭据存储。')
    }
  },
  async credentialDelete(): Promise<void> {
    if (!isTauri()) return
    try {
      await invoke('credential_delete')
    } catch {
      throw new Error('无法从本机系统安全凭据中删除密钥。')
    }
  },
  async list<T>(collection: Collection): Promise<T[]> {
    return isTauri()
      ? invoke('records_list', { collection })
      : transaction(collection, 'readonly', (s) => s.getAll())
  },
  async get<T>(collection: Collection, id: string): Promise<T | undefined> {
    if (isTauri()) return (await invoke<T | null>('record_get', { collection, id })) ?? undefined
    return transaction(collection, 'readonly', (s) => s.get(id))
  },
  async put<T>(collection: Collection, id: string, value: T): Promise<void> {
    if (isTauri()) return invoke('record_put', { collection, id, value })
    await transaction(collection, 'readwrite', (s) => s.put(value, id))
  },
  async remove(collection: Collection, id: string): Promise<void> {
    if (isTauri()) return invoke('record_delete', { collection, id })
    await transaction(collection, 'readwrite', (s) => s.delete(id))
  },
  async putBlob(key: string, blob: Blob): Promise<void> {
    if (isTauri()) {
      const bytes = await blob.arrayBuffer()
      // Tauri 2's Android dispatcher does not accept raw request bodies.
      if (/Android/i.test(navigator.userAgent))
        return invoke('book_blob_put', { key, bytes: Array.from(new Uint8Array(bytes)) })
      return invoke('book_blob_put_binary', bytes, { headers: { 'x-readweave-book': key } })
    }
    await transaction('blobs', 'readwrite', (s) => s.put(blob, key))
  },
  async getBlob(key: string): Promise<Blob | undefined> {
    if (isTauri()) {
      try {
        const bytes = await invoke<ArrayBuffer | number[]>('book_blob_get', { key })
        return new Blob([Array.isArray(bytes) ? new Uint8Array(bytes) : bytes], {
          type: 'application/epub+zip',
        })
      } catch (error) {
        if (error === 'BOOK_NOT_FOUND') return undefined
        throw error
      }
    }
    return transaction('blobs', 'readonly', (s) => s.get(key))
  },
  async merge(entries: { collection: Collection; id: string; value: unknown }[]): Promise<void> {
    if (isTauri()) return invoke('records_merge', { entries })
    const db = await openDatabase()
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(collections, 'readwrite')
      for (const entry of entries) tx.objectStore(entry.collection).put(entry.value, entry.id)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(new Error('恢复失败，原有记录已保留。'))
      tx.onabort = () => reject(new Error('恢复中断，原有记录已保留。'))
    })
  },
}

export async function sha256(blob: Blob): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer())
  return Array.from(new Uint8Array(digest), (x) => x.toString(16).padStart(2, '0')).join('')
}

export function download(name: string, content: Blob | string, type = 'text/plain;charset=utf-8') {
  const url = URL.createObjectURL(
    typeof content === 'string' ? new Blob([content], { type }) : content,
  )
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = name
  anchor.click()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

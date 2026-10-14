import { useState } from 'react'
import { Check, Download, KeyRound, LockKeyhole, Moon, Sun, Upload } from 'lucide-react'
import { Modal } from './Modal'
import { defaultModel, type ModelSettings, type Preferences, type Theme } from '../core/types'
import { completionEndpoint } from '../harness/provider'

export function Appearance({
  value,
  onChange,
}: {
  value: Preferences
  onChange(preferences: Preferences): void
}) {
  return (
    <div className="appearance-settings">
      <div className="field-heading">阅读主题</div>
      <div className="theme-options">
        {(
          [
            { id: 'paper', name: '纸白', icon: Sun },
            { id: 'sepia', name: '暖黄', icon: Sun },
            { id: 'night', name: '深夜', icon: Moon },
          ] as const
        ).map((theme) => (
          <button
            key={theme.id}
            className={`theme-option ${theme.id} ${value.theme === theme.id ? 'selected' : ''}`}
            onClick={() => onChange({ ...value, theme: theme.id as Theme })}
          >
            <theme.icon size={19} />
            {theme.name}
            {value.theme === theme.id && <Check size={15} />}
          </button>
        ))}
      </div>
      <label className="range-field">
        <span>
          正文字号 <strong>{value.fontSize}px</strong>
        </span>
        <input
          aria-label="正文字号"
          type="range"
          min="14"
          max="30"
          step="1"
          value={value.fontSize}
          onChange={(event) => onChange({ ...value, fontSize: Number(event.target.value) })}
        />
      </label>
      <label className="range-field">
        <span>
          行间距 <strong>{value.lineHeight.toFixed(1)}</strong>
        </span>
        <input
          aria-label="行间距"
          type="range"
          min="1.4"
          max="2.4"
          step="0.1"
          value={value.lineHeight}
          onChange={(event) => onChange({ ...value, lineHeight: Number(event.target.value) })}
        />
      </label>
    </div>
  )
}

export function SettingsDialog({
  settings,
  apiKey,
  preferences,
  onSave,
  onPreferences,
  onExport,
  onRestore,
  onClose,
}: {
  settings: ModelSettings
  apiKey: string
  preferences: Preferences
  onSave(settings: ModelSettings, apiKey: string): Promise<void>
  onPreferences(preferences: Preferences): void
  onExport(includeOriginals: boolean): Promise<void>
  onRestore(): void
  onClose(): void
}) {
  const [tab, setTab] = useState<'model' | 'reading' | 'data'>('model')
  const [draft, setDraft] = useState(settings)
  const [key, setKey] = useState(apiKey)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const [includeOriginals, setIncludeOriginals] = useState(false)
  const save = async (event: React.FormEvent) => {
    event.preventDefault()
    setError('')
    try {
      const endpoint = completionEndpoint(draft.endpoint)
      if (!key.trim() && !['localhost', '127.0.0.1', '[::1]'].includes(new URL(endpoint).hostname))
        throw new Error('请输入密钥；无需密钥的本机服务可以留空。')
      if (!draft.model.trim() || !draft.systemPrompt.trim())
        throw new Error('请填写模型名称和回答偏好。')
      setSaving(true)
      await onSave(
        { ...draft, endpoint: draft.endpoint.trim(), model: draft.model.trim() },
        key.trim(),
      )
      onClose()
    } catch (error) {
      setError(error instanceof Error ? error.message : '设置保存失败。')
    } finally {
      setSaving(false)
    }
  }
  return (
    <Modal title="让阅读更合你心意" onClose={onClose}>
      <div className="segmented tabs-three">
        {(
          [
            { id: 'model', label: '模型连接' },
            { id: 'reading', label: '阅读偏好' },
            { id: 'data', label: '数据与备份' },
          ] as const
        ).map((item) => (
          <button
            key={item.id}
            className={tab === item.id ? 'active' : ''}
            onClick={() => setTab(item.id)}
          >
            {item.label}
          </button>
        ))}
      </div>
      {tab === 'model' && (
        <form onSubmit={save} className="settings-form">
          <p className="muted settings-intro">
            使用你自己的模型服务。只在你发送问题后，才会发送阅读资料。
          </p>
          <label className="field">
            模型服务
            <select
              value={draft.provider}
              onChange={(event) =>
                setDraft(
                  event.target.value === 'deepseek'
                    ? {
                        ...draft,
                        provider: 'deepseek',
                        endpoint: defaultModel.endpoint,
                        model: defaultModel.model,
                      }
                    : { ...draft, provider: 'compatible' },
                )
              }
            >
              <option value="deepseek">DeepSeek</option>
              <option value="compatible">其他兼容服务</option>
            </select>
          </label>
          <label className="field">
            服务地址
            <input
              value={draft.endpoint}
              type="url"
              required
              maxLength={2048}
              onChange={(event) => setDraft({ ...draft, endpoint: event.target.value })}
              placeholder="https://your-provider.example/v1"
            />
            <small>支持 Chat Completions 兼容接口；本机服务可用 HTTP。</small>
          </label>
          <label className="field">
            模型名称
            <input
              value={draft.model}
              aria-label="模型名称"
              required
              maxLength={160}
              onChange={(event) => setDraft({ ...draft, model: event.target.value })}
              placeholder="模型服务提供的名称"
              list={draft.provider === 'deepseek' ? 'deepseek-models' : undefined}
            />
            {draft.provider === 'deepseek' && (
              <>
                <datalist id="deepseek-models">
                  <option value="deepseek-flash" />
                  <option value="deepseek-v4-pro" />
                </datalist>
                <small>
                  官方当前模型：deepseek-flash、deepseek-v4-pro。已有模型名称会保留，可自行切换。
                </small>
              </>
            )}
          </label>
          {draft.provider === 'deepseek' && (
            <div className="thinking-settings">
              <label className="field">
                思考模式
                <select
                  aria-label="思考模式"
                  value={draft.thinking}
                  onChange={(event) =>
                    setDraft({
                      ...draft,
                      thinking: event.target.value as ModelSettings['thinking'],
                    })
                  }
                >
                  <option value="enabled">开启 · 展示模型的思考过程</option>
                  <option value="disabled">关闭 · 直接回答</option>
                </select>
              </label>
              <label className="field">
                思考强度
                <select
                  aria-label="思考强度"
                  value={draft.reasoningEffort}
                  disabled={draft.thinking === 'disabled'}
                  onChange={(event) =>
                    setDraft({
                      ...draft,
                      reasoningEffort: event.target.value as ModelSettings['reasoningEffort'],
                    })
                  }
                >
                  <option value="low">低 · 更快</option>
                  <option value="high">高 · 日常推理</option>
                  <option value="max">最高 · 复杂推理</option>
                </select>
                <small>思考内容逐步显示在回答上方，可展开或收起；更高强度可能等待更久。</small>
              </label>
            </div>
          )}
          <label className="field">
            单次输出预算
            <select
              aria-label="单次输出预算"
              value={draft.maxTokens}
              onChange={(event) => setDraft({ ...draft, maxTokens: Number(event.target.value) })}
            >
              {[8192, 16384, 32768, 65536].map((value) => (
                <option key={value} value={value}>
                  {value.toLocaleString()} tokens
                </option>
              ))}
            </select>
            <small>思考与回答共用此预算，实际用量由模型服务计费。</small>
          </label>
          <label className="field">
            <span>
              <KeyRound size={14} /> 服务密钥
            </span>
            <input
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={key}
              maxLength={8192}
              onChange={(event) => setKey(event.target.value)}
              placeholder="仅保留在本次运行的内存中"
            />
          </label>
          <div className="inline-notice">
            <LockKeyhole size={17} />
            <span>
              密钥在关闭应用后清除，不写入书籍数据库或默认备份。安全凭据持久化尚在验证中。
            </span>
          </div>
          <label className="field">
            回答偏好
            <textarea
              rows={4}
              required
              maxLength={8000}
              value={draft.systemPrompt}
              onChange={(event) => setDraft({ ...draft, systemPrompt: event.target.value })}
            />
          </label>
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          <div className="modal-footer">
            <span className="muted">外部 Harness 和联网搜索尚未接入</span>
            <button className="button primary" type="submit" disabled={saving}>
              {saving ? '保存中…' : '保存设置'}
            </button>
          </div>
        </form>
      )}
      {tab === 'reading' && (
        <div className="settings-body">
          <Appearance value={preferences} onChange={onPreferences} />
          <label className="field">
            提问时允许读取的范围
            <select
              aria-label="允许读取的范围"
              value={preferences.scope}
              onChange={(event) =>
                onPreferences({ ...preferences, scope: event.target.value as Preferences['scope'] })
              }
            >
              <option value="to-position">截至提问位置（默认）</option>
              <option value="chapter">当前章节</option>
              <option value="book">整本书</option>
            </select>
            <small>
              范围变化会新建问答，首次发送时可预览。限制应用提供的资料，无法限制模型已有知识。
            </small>
          </label>
        </div>
      )}
      {tab === 'data' && (
        <div className="settings-body">
          <div className="data-card">
            <LockKeyhole size={22} />
            <h3>阅读数据，保存在你的设备上</h3>
            <p>原书、阅读进度、笔记和问答默认留在本机。此原型没有云同步，也不会上传遥测。</p>
          </div>
          <label className="check-field">
            <input
              type="checkbox"
              checked={includeOriginals}
              onChange={(event) => setIncludeOriginals(event.target.checked)}
            />
            JSON 备份包含原始 EPUB（总计最多 32 MB）
          </label>
          <button
            className="button full"
            disabled={saving}
            onClick={async () => {
              setSaving(true)
              setError('')
              try {
                await onExport(includeOriginals)
              } catch (error) {
                setError(error instanceof Error ? error.message : '导出失败。')
              } finally {
                setSaving(false)
              }
            }}
          >
            <Download size={17} />
            导出 JSON 备份
          </button>
          <button className="button full" onClick={onRestore}>
            <Upload size={17} />
            从备份恢复
          </button>
          <p className="muted small">
            恢复前会自动下载一份当前数据备份。未包含原书的备份，恢复后需要重新导入相同
            EPUB。版本升级迁移仍需进一步验证。
          </p>
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
        </div>
      )}
    </Modal>
  )
}

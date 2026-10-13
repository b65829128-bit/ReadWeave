import { Download, History, Puzzle, Trash2, Upload } from 'lucide-react'
import type { InstalledPack } from '../core/plugins'

export function ActionPacks({
  packs,
  onImport,
  onToggle,
  onExport,
  onRemove,
  onRollback,
}: {
  packs: InstalledPack[]
  onImport(): void
  onToggle(pack: InstalledPack): void
  onExport(pack: InstalledPack): void
  onRemove(pack: InstalledPack): void
  onRollback(pack: InstalledPack): void
}) {
  return (
    <div className="content-page">
      <div className="page-eyebrow">
        <span className="tiny-dot" /> 用你喜欢的方式理解
      </div>
      <div className="page-title-row">
        <div>
          <h1>你的阅读动作</h1>
          <p className="page-description">把常用的提问方式，放在触手可及的地方。</p>
        </div>
        <button className="button primary" onClick={onImport}>
          <Upload size={17} />
          安装动作包
        </button>
      </div>
      <div className="pack-grid">
        {packs.map((pack) => (
          <article className="pack-card" key={pack.id}>
            <div className="pack-top">
              <span className="pack-icon">
                <Puzzle size={24} />
              </span>
              <label className="switch">
                <input
                  aria-label={`启用${pack.manifest.name}`}
                  type="checkbox"
                  checked={pack.enabled}
                  onChange={() => onToggle(pack)}
                />
                <span />
              </label>
            </div>
            <h2>{pack.manifest.name}</h2>
            <p className="muted">{pack.manifest.description || '自定义阅读动作包'}</p>
            <div className="action-tags">
              {pack.manifest.actions.map((action) => (
                <span key={action.id}>{action.label}</span>
              ))}
            </div>
            <div className="pack-meta">
              <span>v{pack.manifest.version}</span>
              <span>{pack.enabled ? '已启用' : '已停用'}</span>
            </div>
            <div className="pack-footer">
              <button className="text-button" onClick={() => onExport(pack)}>
                <Download size={15} />
                导出
              </button>
              {pack.previous && (
                <button className="text-button" onClick={() => onRollback(pack)}>
                  <History size={15} />
                  回滚
                </button>
              )}
              <button
                className="icon-button"
                onClick={() => onRemove(pack)}
                aria-label={`卸载${pack.manifest.name}`}
              >
                <Trash2 size={16} />
              </button>
            </div>
          </article>
        ))}
      </div>
      <div className="inline-notice spacious">
        <Puzzle size={20} />
        <span>
          动作包包含提示词与快捷动作，不运行代码，不读取密钥，不自动启用联网。安装本地文件即可分享你的阅读习惯。
        </span>
      </div>
      {!packs.length && (
        <div className="empty-state">
          <Puzzle size={28} />
          <h3>安装第一个阅读动作包</h3>
          <p>项目的 examples 目录中提供了历史阅读示例。</p>
        </div>
      )}
    </div>
  )
}

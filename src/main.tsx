import ReactDOM from 'react-dom/client'
import App from './App'
import 'katex/dist/katex.min.css'
import './styles.css'

// foliate-js uses Object.groupBy; retain a narrow fallback for older Android WebViews.
if (!Object.groupBy) {
  Object.groupBy = function <K extends PropertyKey, T>(
    items: Iterable<T>,
    keySelector: (item: T, index: number) => K,
  ): Partial<Record<K, T[]>> {
    const groups = Object.create(null) as Partial<Record<K, T[]>>
    let index = 0
    for (const item of items) (groups[keySelector(item, index++)] ??= []).push(item)
    return groups
  }
}
ReactDOM.createRoot(document.getElementById('root')!).render(<App />)

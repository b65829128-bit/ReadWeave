# foliate-js

Source: https://github.com/johnfactotum/foliate-js  
Commit: `78914aef4466eb960965702401634c2cb348e9b1`  
License: MIT (see LICENSE in this directory).

Only the EPUB rendering dependency graph is included. Five local patch groups are applied reproducibly by `node scripts/vendor-foliate.mjs` against a checkout at `.local/foliate-source`:

1. `view.js`: remove generic format/network loading. The reader accepts only book objects created by our validated, sanitized EPUB importer.
2. `paginator.js`: remove `allow-scripts` from the content iframe sandbox. Official targets use Chromium/WebView2, not the WebKit workaround described upstream. Selection and touch behavior still require Android device verification.
3. `paginator.js`: defer ResizeObserver layout writes to the next animation frame, disconnect observers from their actual observed containers, and guard delayed font/style callbacks after teardown. These address observed Chromium resize warnings and null-document errors when closing, resizing and reopening the React reader.
4. `epubcfi.js`: accept an optional per-document WeakMap in `fromRange` to reuse sibling indexing during bulk paragraph extraction. Callers must keep the document and filter unchanged while using a cache. The importer creates a fresh cache for each sanitized document and discards it afterwards. The CFI algorithm and results are unchanged; interactive calls retain the original uncached behavior.
5. `paginator.js` / `view.js`: when the host sets `host-controls-input`, disable the paginator's competing touch swipe and delayed pointer-selection auto-pagination. ReaderAdapter owns swipe recognition and suppresses navigation for the entire selection gesture, including pointer cancellation and release outside the iframe. Preserve the relocation `reason` in view callbacks so layout-only `anchor` changes retain captured selections. Native text selection, handles, copying, keyboard selection and publication sanitization remain active.

Raw EPUB is never passed to upstream `makeBook`. Host-owned XHTML sanitization, restrictive content CSP and resource validation are additional layers, not a claim that an iframe alone isolates the native bridge.

The `.d.ts` files in this directory are ReadWeave-owned declarations, not upstream JavaScript. They describe only the APIs used by the adapter and tests (including text-range CFI conversion and underline drawing). Highlight interaction, selection normalization and gesture decisions are implemented in the host adapter.

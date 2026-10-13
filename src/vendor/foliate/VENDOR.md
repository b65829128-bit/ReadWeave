# foliate-js

Source: https://github.com/johnfactotum/foliate-js  
Commit: `78914aef4466eb960965702401634c2cb348e9b1`  
License: MIT (see LICENSE in this directory).

Only the EPUB rendering dependency graph is included. Three local patch groups are applied reproducibly by `node scripts/vendor-foliate.mjs` against a checkout at `.local/foliate-source`:

1. `view.js`: remove generic format/network loading. The reader accepts only book objects created by our validated, sanitized EPUB importer.
2. `paginator.js`: remove `allow-scripts` from the content iframe sandbox. Official targets use Chromium/WebView2, not the WebKit workaround described upstream. Selection and touch behavior still require Android device verification.
3. `paginator.js`: defer ResizeObserver layout writes to the next animation frame, disconnect observers from their actual observed containers, and guard delayed font/style callbacks after teardown. These address observed Chromium resize warnings and null-document errors when closing, resizing and reopening the React reader.

Raw EPUB is never passed to upstream `makeBook`. Host-owned XHTML sanitization, restrictive content CSP and resource validation are additional layers, not a claim that an iframe alone isolates the native bridge.

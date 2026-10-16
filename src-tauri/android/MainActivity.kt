package app.readweave.reader

import android.os.Bundle
import android.view.View
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import androidx.core.graphics.Insets
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
  }

  override fun onWebViewCreate(webView: WebView) {
    super.onWebViewCreate(webView)
    if (BuildConfig.DEBUG) WebView.setWebContentsDebuggingEnabled(true)

    // The native container owns these insets, including on WebViews before M139.
    val root = findViewById<View>(android.R.id.content)
    val types = WindowInsetsCompat.Type.systemBars() or
      WindowInsetsCompat.Type.displayCutout() or WindowInsetsCompat.Type.ime()
    ViewCompat.setOnApplyWindowInsetsListener(root) { view, insets ->
      val padding = insets.getInsets(types)
      view.setPadding(padding.left, padding.top, padding.right, padding.bottom)
      // Keep dispatching updates, with handled dimensions zeroed to avoid double padding.
      WindowInsetsCompat.Builder(insets).setInsets(types, Insets.NONE).build()
    }
    root.post { ViewCompat.requestApplyInsets(root) }
  }
}

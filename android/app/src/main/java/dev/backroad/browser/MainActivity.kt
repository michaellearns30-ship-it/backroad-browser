package dev.backroad.browser

import android.annotation.SuppressLint
import android.app.Activity
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.os.Bundle
import android.speech.RecognizerIntent
import android.util.Base64
import android.util.Log
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.inputmethod.EditorInfo
import android.webkit.JavascriptInterface
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.util.Locale
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * backroad — the browser, and the hands.
 *
 * Two WebViews stacked in one screen:
 *   browser  the page you are looking at, and the thing that gets driven
 *   console  the web console in wap/, fetched at launch so it can change without
 *            a new APK. Hidden until you tap the console button.
 *
 * The console talks to this class through window.Android.call(method, argsJson).
 * Every method returns a JSON string so nothing is guessed.
 */
class MainActivity : Activity() {

    private lateinit var root: FrameLayout
    private lateinit var browser: WebView
    private lateinit var console: WebView
    private lateinit var address: EditText
    private lateinit var bar: LinearLayout
    private var consoleOpen = false

    companion object {
        /** Where the console lives. Change this one string after you publish the repo. */
        private const val CONSOLE_URL = "https://michaellearns30-ship-it.github.io/backroad-browser/wap/"
        private const val START_URL = "https://duckduckgo.com/"
        private const val VOICE_REQ = 41
        private const val TAG = "backroad"
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        root = FrameLayout(this)

        val column = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        browser = newWebView("browser")
        console = newWebView("console")

        bar = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(6), dp(6), dp(6), dp(6))
            setBackgroundColor(Color.parseColor("#0e0f0d"))
        }

        address = EditText(this).apply {
            setSingleLine()
            imeOptions = EditorInfo.IME_ACTION_GO
            hint = "search or address"
            setTextColor(Color.parseColor("#e8e6df"))
            setHintTextColor(Color.parseColor("#7d847a"))
            setBackgroundColor(Color.parseColor("#171a17"))
            setPadding(dp(12), dp(8), dp(12), dp(8))
            textSize = 15f
            setOnEditorActionListener { _, actionId, _ ->
                if (actionId == EditorInfo.IME_ACTION_GO) {
                    go(address.text.toString())
                    true
                } else false
            }
        }

        bar.addView(
            iconButton("‹") { if (browser.canGoBack()) browser.goBack() },
            LinearLayout.LayoutParams(dp(44), dp(44))
        )
        bar.addView(
            address,
            LinearLayout.LayoutParams(0, dp(44), 1f).apply { marginStart = dp(4); marginEnd = dp(4) }
        )
        bar.addView(iconButton("⌗") { openConsole() }, LinearLayout.LayoutParams(dp(44), dp(44)).apply { marginEnd = dp(4) })
        bar.addView(iconButton("🎙") { listen() }, LinearLayout.LayoutParams(dp(44), dp(44)))

        column.addView(browser, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))
        column.addView(bar, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))

        root.addView(column, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        root.addView(console, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        console.visibility = View.GONE

        setContentView(root)

        if (savedInstanceState == null) browser.loadUrl(START_URL)
    }

    // ------------------------------------------------------------------ chrome

    private fun dp(v: Int): Int = (v * resources.displayMetrics.density).toInt()

    private fun iconButton(label: String, onClick: () -> Unit): Button =
        Button(this).apply {
            text = label
            textSize = 18f
            setTextColor(Color.parseColor("#e8e6df"))
            setBackgroundColor(Color.parseColor("#1f231f"))
            setPadding(0, 0, 0, 0)
            isAllCaps = false
            minWidth = 0
            minHeight = 0
            setOnClickListener { onClick() }
        }

    @SuppressLint("SetJavaScriptEnabled")
    private fun newWebView(role: String): WebView {
        val w = WebView(this)
        w.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            databaseEnabled = true
            useWideViewPort = true
            loadWithOverviewMode = true
            setSupportZoom(true)
            builtInZoomControls = true
            displayZoomControls = false
            mediaPlaybackRequiresUserGesture = false
            cacheMode = WebSettings.LOAD_DEFAULT
            mixedContentMode = WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE
            // Drop the "wv" token so sites that block WebViews are less likely to
            // turn us away; the engine is Chrome either way.
            userAgentString = userAgentString.replace("; wv", "")
        }
        w.setBackgroundColor(Color.parseColor("#0e0f0d"))

        if (role == "console") {
            w.addJavascriptInterface(Bridge(), "Android")
        } else {
            w.webChromeClient = WebChromeClient()
        }

        w.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val u = request.url
                val scheme = (u.scheme ?: "").lowercase(Locale.ROOT)
                return if (scheme == "http" || scheme == "https") {
                    false
                } else {
                    try {
                        startActivity(Intent(Intent.ACTION_VIEW, u))
                        true
                    } catch (t: Throwable) {
                        Log.w(TAG, "cannot hand off $u", t)
                        true
                    }
                }
            }

            override fun onPageFinished(view: WebView, url: String) {
                if (view === browser) {
                    address.setText(url)
                    if (consoleOpen) pushObservation()
                }
            }
        }
        return w
    }

    /** Search if it looks like words, load it if it looks like an address. */
    private fun go(input: String) {
        val raw = input.trim()
        if (raw.isEmpty()) return
        val looksLikeAddress = raw.contains(".") && !raw.contains(" ")
        val url = when {
            raw.startsWith("http://") || raw.startsWith("https://") -> raw
            looksLikeAddress -> "https://$raw"
            else -> "https://duckduckgo.com/?q=" + java.net.URLEncoder.encode(raw, "UTF-8")
        }
        browser.loadUrl(url)
        address.clearFocus()
    }

    // ----------------------------------------------------------------- console

    private fun openConsole() {
        if (console.url == null) console.loadUrl(CONSOLE_URL)
        console.visibility = View.VISIBLE
        consoleOpen = true
        console.bringToFront()
        pushObservation()
    }

    private fun closeConsole() {
        console.visibility = View.GONE
        consoleOpen = false
    }

    private fun tellConsole(fn: String, text: String) {
        val js = "window.$fn && window.$fn(${JSONObject.quote(text)})"
        runOnUiThread { console.evaluateJavascript(js, null) }
    }

    private fun toast(text: String) {
        runOnUiThread { Toast.makeText(this, text, Toast.LENGTH_SHORT).show() }
    }

    // -------------------------------------------------------------------- voice

    private fun listen() {
        val i = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
            putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
            putExtra(RecognizerIntent.EXTRA_LANGUAGE, Locale.getDefault().toLanguageTag())
            putExtra(RecognizerIntent.EXTRA_PROMPT, "What should I do?")
        }
        try {
            startActivityForResult(i, VOICE_REQ)
        } catch (t: Throwable) {
            toast("No speech recogniser on this phone")
            tellConsole("androidVoiceFailed", "no recogniser installed")
        }
    }

    @Deprecated("fine without appcompat")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode != VOICE_REQ) return
        val heard = data?.getStringArrayListExtra(RecognizerIntent.EXTRA_RESULTS)?.firstOrNull()
        if (resultCode != RESULT_OK || heard.isNullOrBlank()) {
            tellConsole("androidVoiceFailed", "nothing heard")
            return
        }
        openConsole()
        tellConsole("onVoice", heard)
    }

    override fun onBackPressed() {
        if (consoleOpen) {
            closeConsole()
            return
        }
        if (browser.canGoBack()) {
            browser.goBack()
            return
        }
        super.onBackPressed()
    }

    // ------------------------------------------------------------------- bridge

    /**
     * The control surface. Called from the console page on a WebView background
     * thread, so blocking here is safe — it never blocks the UI thread.
     */
    private inner class Bridge {

        @JavascriptInterface
        fun call(method: String, argsJson: String): String {
            return try {
                val a = if (argsJson.isBlank()) JSONObject() else JSONObject(argsJson)
                when (method) {
                    "observe" -> observe()
                    "click" -> click(a.optString("selector"))
                    "type" -> typeInto(a.optString("selector"), a.optString("text"), a.optBoolean("submit", false))
                    "scroll" -> scroll(a.optInt("dy", 600))
                    "press" -> press(a.optString("key", "Enter"))
                    "goto" -> {
                        runOnUiThread { go(a.optString("url")) }
                        ok()
                    }
                    "back" -> {
                        runOnUiThread { if (browser.canGoBack()) browser.goBack() }
                        ok()
                    }
                    "url" -> JSONObject()
                        .put("ok", true)
                        .put("url", browser.url ?: "")
                        .put("title", browser.title ?: "")
                        .toString()
                    "shot" -> shot()
                    "closeConsole" -> {
                        runOnUiThread { closeConsole() }
                        ok()
                    }
                    "log" -> {
                        Log.i(TAG, a.optString("text"))
                        ok()
                    }
                    else -> err("unknown method: $method")
                }
            } catch (t: Throwable) {
                err(t.message ?: t.toString())
            }
        }

        @JavascriptInterface
        fun startVoice() {
            runOnUiThread { listen() }
        }

        // Kept for pages that prefer the plural form.
        @JavascriptInterface
        fun startVoiceInput() {
            runOnUiThread { listen() }
        }
    }

    private fun ok(extra: String = "ok"): String =
        JSONObject().put("ok", true).put("summary", extra).toString()

    private fun err(message: String): String =
        JSONObject().put("ok", false).put("error", message).toString()

    // --------------------------------------------------------------- the hands

    /** Run JS in the browser page and wait for its answer. Never call from the UI thread. */
    private fun eval(js: String): String? {
        val latch = CountDownLatch(1)
        var out: String? = null
        runOnUiThread {
            browser.evaluateJavascript(js) { value ->
                out = value
                latch.countDown()
            }
        }
        if (!latch.await(6, TimeUnit.SECONDS)) return null
        return out
    }

    private fun jsString(result: String?): String {
        if (result == null) return ""
        return result.trim().removeSurrounding("\"")
    }

    private fun pushObservation() {
        if (!consoleOpen) return
        val seen = observe()
        if (seen.contains("\"ok\":false")) return
        console.evaluateJavascript(
            "window.backroadState && window.backroadState(${JSONObject.quote(seen)})",
            null
        )
    }

    private fun observe(): String {
        val js = """
            (function(){
              function vis(e){
                var r=e.getBoundingClientRect(),s=getComputedStyle(e);
                if(s.visibility==='hidden'||s.display==='none'||s.opacity==='0')return false;
                return r.width>2&&r.height>2&&r.bottom>0&&r.top<innerHeight*1.5;
              }
              function lab(e){
                var t=e.innerText||e.value||e.getAttribute('aria-label')||e.getAttribute('placeholder')||e.title||'';
                return String(t).replace(/\s+/g,' ').trim().slice(0,80);
              }
              var nodes=document.querySelectorAll('a,button,input,textarea,select,[role=button],[role=link],[role=tab],[onclick],[contenteditable=true]');
              var out=[],i=0;
              for(var n=0;n<nodes.length&&out.length<70;n++){
                var e=nodes[n];
                if(!vis(e))continue;
                if(e.tagName==='INPUT'&&e.type==='hidden')continue;
                var id='b'+(i++);
                e.setAttribute('data-br',id);
                out.push({
                  id:id,
                  tag:e.tagName.toLowerCase(),
                  text:lab(e),
                  type:e.getAttribute('type')||'',
                  href:(e.href||'').slice(0,140)
                });
              }
              var body=((document.body&&document.body.innerText)||'').replace(/\s+/g,' ').trim().slice(0,1500);
              return JSON.stringify({
                ok:true,
                url:location.href,
                title:document.title,
                scroll:Math.round(scrollY)+'/'+Math.round(document.body?document.body.scrollHeight:0),
                nodes:out,
                text:body
              });
            })()
        """.trimIndent()
        val answer = eval(js) ?: return err("page did not answer")
        // evaluateJavascript hands back a JSON-encoded string; unwrap it once.
        return try {
            val unwrapped = JSONObject("{\"v\":$answer}").getString("v")
            JSONObject(unwrapped).toString()
        } catch (t: Throwable) {
            err("bad page state")
        }
    }

    private fun click(selector: String): String {
        if (selector.isBlank()) return err("no selector")
        val js = """
            (function(){
              var e=document.querySelector(${JSONObject.quote(selector)});
              if(!e)return 'missing';
              e.scrollIntoView({block:'center'});
              try{e.click();}catch(x){}
              return 'ok';
            })()
        """.trimIndent()
        val r = jsString(eval(js))
        return if (r == "ok") ok("clicked") else err("nothing matched $selector")
    }

    private fun typeInto(selector: String, text: String, submit: Boolean): String {
        if (selector.isBlank()) return err("no selector")
        val enter = if (submit) {
            "e.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',keyCode:13,which:13,bubbles:true}));" +
                "var f=e.form;if(f&&f.requestSubmit){try{f.requestSubmit();}catch(x){}}"
        } else ""
        val js = """
            (function(){
              var e=document.querySelector(${JSONObject.quote(selector)});
              if(!e)return 'missing';
              e.focus();
              if(e.isContentEditable){
                e.textContent=${JSONObject.quote(text)};
              } else {
                var d=Object.getOwnPropertyDescriptor(e.constructor.prototype,'value');
                if(d&&d.set){d.set.call(e,${JSONObject.quote(text)});}else{e.value=${JSONObject.quote(text)};}
              }
              e.dispatchEvent(new Event('input',{bubbles:true}));
              e.dispatchEvent(new Event('change',{bubbles:true}));
              $enter
              return 'ok';
            })()
        """.trimIndent()
        val r = jsString(eval(js))
        return if (r == "ok") ok(if (submit) "typed and submitted" else "typed") else err("nothing matched $selector")
    }

    private fun scroll(dy: Int): String {
        val js = "window.scrollBy(0,($dy));'ok'"
        val r = jsString(eval(js))
        return if (r == "ok") ok("scrolled $dy") else err("scroll failed")
    }

    private fun press(key: String): String {
        val js = """
            (function(){
              var e=document.activeElement||document.body;
              if(!e)return 'missing';
              e.dispatchEvent(new KeyboardEvent('keydown',{key:${JSONObject.quote(key)},bubbles:true}));
              e.dispatchEvent(new KeyboardEvent('keyup',{key:${JSONObject.quote(key)},bubbles:true}));
              return 'ok';
            })()
        """.trimIndent()
        val r = jsString(eval(js))
        return if (r == "ok") ok("pressed $key") else err("press failed")
    }

    /** A small JPEG of what is on screen — the agent's eyes. 480px, quality 55. */
    private fun shot(): String {
        val latch = CountDownLatch(1)
        var encoded: String? = null
        runOnUiThread {
            try {
                val w = browser.width
                val h = browser.height
                if (w <= 0 || h <= 0) {
                    latch.countDown()
                    return@runOnUiThread
                }
                val full = Bitmap.createBitmap(w, h, Bitmap.Config.RGB_565)
                browser.draw(Canvas(full))
                val targetW = 480
                val small = Bitmap.createScaledBitmap(full, targetW, h * targetW / w, true)
                val bytes = ByteArrayOutputStream()
                small.compress(Bitmap.CompressFormat.JPEG, 55, bytes)
                encoded = Base64.encodeToString(bytes.toByteArray(), Base64.NO_WRAP)
                full.recycle()
                small.recycle()
            } catch (t: Throwable) {
                Log.w(TAG, "shot failed", t)
            }
            latch.countDown()
        }
        latch.await(6, TimeUnit.SECONDS)
        val b64 = encoded ?: return err("no picture")
        return JSONObject().put("ok", true).put("width", 480).put("jpeg", b64).toString()
    }
}

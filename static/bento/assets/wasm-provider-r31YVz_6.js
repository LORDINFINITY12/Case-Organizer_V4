var e=`bentopdf:wasm-providers`,t={pymupdf:`https://cdn.jsdelivr.net/npm/@bentopdf/pymupdf-wasm@0.11.16/`,ghostscript:`https://cdn.jsdelivr.net/npm/@bentopdf/gs-wasm@0.1.1/assets/`,cpdf:`https://cdn.jsdelivr.net/npm/coherentpdf@2.5.5/dist/`};function n(e,t){return e||t}var r={pymupdf:n(void 0,t.pymupdf),ghostscript:n(void 0,t.ghostscript),cpdf:n(void 0,t.cpdf)};function i(e){try{return new URL(e).hostname}catch{return null}}function a(){let e=new Set;typeof location<`u`&&location.hostname&&e.add(location.hostname);for(let n of Object.values(t)){let t=i(n);t&&e.add(t)}for(let t of Object.values(r)){let n=i(t);n&&e.add(n)}return e}var o=a(),s=new class{config;validationCache=new Map;trustedHosts=new Set(o);constructor(){this.config=this.loadConfig()}isTrustedUrl(e){let t=i(e);return!!t&&this.trustedHosts.has(t)}loadConfig(){try{let t=localStorage.getItem(e);if(!t)return{};let n=JSON.parse(t),r={},i=!1;for(let e of[`pymupdf`,`ghostscript`,`cpdf`]){let t=n[e];typeof t==`string`&&(this.isTrustedUrl(t)?r[e]=t:(i=!0,console.warn(`[WasmProvider] Ignoring untrusted stored URL for ${e}: ${t}. Reconfigure via Advanced Settings to re-enable.`)))}if(i)try{localStorage.setItem(e,JSON.stringify(r))}catch(e){console.error(`[WasmProvider] Failed to scrub untrusted config from localStorage:`,e)}return r}catch(e){console.warn(`[WasmProvider] Failed to load config from localStorage:`,e)}return{}}getEnvDefault(e){return r[e]}saveConfig(){try{localStorage.setItem(e,JSON.stringify(this.config))}catch(e){console.error(`[WasmProvider] Failed to save config to localStorage:`,e)}}getUrl(e){let t=this.config[e];if(t){if(this.isTrustedUrl(t))return t;console.warn(`[WasmProvider] Refusing to use untrusted URL for ${e}; falling back to env default.`)}return this.getEnvDefault(e)}setUrl(e,t){let n=t.endsWith(`/`)?t:`${t}/`,r=i(n);if(!r)throw Error(`Invalid URL`);this.trustedHosts.add(r),this.config[e]=n,this.validationCache.delete(e),this.saveConfig()}removeUrl(e){delete this.config[e],this.validationCache.delete(e),this.saveConfig()}isConfigured(e){return!!(this.config[e]||this.getEnvDefault(e))}isUserConfigured(e){return!!this.config[e]}hasEnvDefault(e){return!!this.getEnvDefault(e)}hasAnyProvider(){return Object.keys(this.config).length>0||Object.values(r).some(Boolean)}async validateUrl(e,t){let n=t||this.config[e];if(!n)return{valid:!1,error:`No URL configured`};try{let e=new URL(n);if(![`http:`,`https:`].includes(e.protocol))return{valid:!1,error:`URL must start with http:// or https://`}}catch{return{valid:!1,error:`Invalid URL format. Please enter a valid URL (e.g., https://example.com/wasm/)`}}let r=n.endsWith(`/`)?n:`${n}/`;try{let n={pymupdf:`dist/index.js`,ghostscript:`gs.js`,cpdf:`coherentpdf.browser.min.js`}[e],i=`${r}${n}`,a=new AbortController,o=setTimeout(()=>a.abort(),1e4),s=await fetch(i,{method:`GET`,mode:`cors`,signal:a.signal});if(clearTimeout(o),!s.ok)return{valid:!1,error:`Could not find ${n} at the specified URL (HTTP ${s.status}). Make sure the file exists.`};let c=s.body?.getReader();if(c)try{await c.read(),c.cancel()}catch{return{valid:!1,error:`File exists but could not be read. Check CORS configuration.`}}let l=s.headers.get(`content-type`);return l&&!l.includes(`javascript`)&&!l.includes(`application/octet-stream`)&&!l.includes(`text/`)?{valid:!1,error:`The URL returned unexpected content type: ${l}. Expected a JavaScript file.`}:((!t||t===this.config[e])&&this.validationCache.set(e,!0),{valid:!0})}catch(e){let t=e instanceof Error?e.message:`Unknown error`;return t.includes(`Failed to fetch`)||t.includes(`NetworkError`)?{valid:!1,error:`Network error: Could not connect to the URL. Check that the URL is correct and the server allows CORS requests.`}:{valid:!1,error:`Network error: ${t}`}}}getAllProviders(){return{pymupdf:this.config.pymupdf||r.pymupdf,ghostscript:this.config.ghostscript||r.ghostscript,cpdf:this.config.cpdf||r.cpdf}}clearAll(){this.config={},this.validationCache.clear(),this.trustedHosts=new Set(o);try{localStorage.removeItem(e)}catch(e){console.error(`[WasmProvider] Failed to clear localStorage:`,e)}}resetToDefaults(){this.clearAll()}getPackageDisplayName(e){return{pymupdf:`PyMuPDF (Document Processing)`,ghostscript:`Ghostscript (PDF/A Conversion)`,cpdf:`CoherentPDF (Bookmarks & Metadata)`}[e]}getPackageFeatures(e){return{pymupdf:[`PDF to Text`,`PDF to Markdown`,`PDF to SVG`,`PDF to Images (High Quality)`,`PDF to DOCX`,`PDF to Excel/CSV`,`Extract Images`,`Extract Tables`,`EPUB/MOBI/FB2/XPS/CBZ to PDF`,`Image Compression`,`Deskew PDF`,`PDF Layers`],ghostscript:[`PDF/A Conversion`,`Font to Outline`],cpdf:[`Merge PDF`,`Alternate Merge`,`Split by Bookmarks`,`Table of Contents`,`PDF to JSON`,`JSON to PDF`,`Add/Edit/Extract Attachments`,`Edit Bookmarks`,`PDF Metadata`]}[e]}};function c(e,t){let n=s.getPackageDisplayName(e),r=s.getPackageFeatures(e),i=document.createElement(`div`);i.className=`fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4`,i.id=`wasm-required-modal`;let a=document.createElement(`div`);a.className=`bg-gray-800 rounded-2xl max-w-md w-full shadow-2xl border border-gray-700`,a.innerHTML=`
    <div class="p-6">
      <div class="flex items-center gap-3 mb-4">
        <div class="w-12 h-12 rounded-full bg-amber-500/20 flex items-center justify-center">
          <svg class="w-6 h-6 text-amber-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"/>
          </svg>
        </div>
        <div>
          <h3 class="text-lg font-semibold text-white">Advanced Feature Required</h3>
          <p class="text-sm text-gray-400">External processing module needed</p>
        </div>
      </div>

      <p class="text-gray-300 mb-4">
        This feature requires <strong class="text-white">${n}</strong> to be configured.
      </p>

      <div class="bg-gray-700/50 rounded-lg p-4 mb-4">
        <p class="text-sm text-gray-400 mb-2">Features enabled by this module:</p>
        <ul class="text-sm text-gray-300 space-y-1">
          ${r.slice(0,4).map(e=>`<li class="flex items-center gap-2"><span class="text-green-400">✓</span> ${e}</li>`).join(``)}
          ${r.length>4?`<li class="text-gray-500">+ ${r.length-4} more...</li>`:``}
        </ul>
      </div>

      <p class="text-xs text-gray-500 mb-4">
        This module is licensed under AGPL-3.0. By configuring it, you agree to its license terms.
      </p>
    </div>

    <div class="border-t border-gray-700 p-4 flex gap-3">
      <button id="wasm-modal-cancel" class="flex-1 px-4 py-2.5 rounded-lg bg-gray-700 text-gray-300 hover:bg-gray-600 transition-colors font-medium">
        Cancel
      </button>
      <button id="wasm-modal-configure" class="flex-1 px-4 py-2.5 rounded-lg bg-gradient-to-r from-blue-600 to-blue-500 text-white hover:from-blue-500 hover:to-blue-400 transition-all font-medium">
        Configure
      </button>
    </div>
  `,i.appendChild(a),document.body.appendChild(i);let o=a.querySelector(`#wasm-modal-cancel`),c=a.querySelector(`#wasm-modal-configure`),l=()=>{i.remove()};o?.addEventListener(`click`,l),i.addEventListener(`click`,e=>{e.target===i&&l()}),c?.addEventListener(`click`,()=>{l(),t?t():window.location.href=`/wasm-settings.html`})}export{c as n,s as t};
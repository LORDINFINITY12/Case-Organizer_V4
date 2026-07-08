const h="bentopdf:wasm-providers",m={pymupdf:"https://cdn.jsdelivr.net/npm/@bentopdf/pymupdf-wasm@0.11.14/",ghostscript:"https://cdn.jsdelivr.net/npm/@bentopdf/gs-wasm/assets/",cpdf:"https://cdn.jsdelivr.net/npm/coherentpdf/dist/"};function p(d,e){return e}const c={pymupdf:p(void 0,m.pymupdf),ghostscript:p(void 0,m.ghostscript),cpdf:p(void 0,m.cpdf)};class y{config;validationCache=new Map;constructor(){this.config=this.loadConfig()}loadConfig(){try{const e=localStorage.getItem(h);if(e)return JSON.parse(e)}catch(e){console.warn("[WasmProvider] Failed to load config from localStorage:",e)}return{}}getEnvDefault(e){return c[e]}saveConfig(){try{localStorage.setItem(h,JSON.stringify(this.config))}catch(e){console.error("[WasmProvider] Failed to save config to localStorage:",e)}}getUrl(e){return this.config[e]||this.getEnvDefault(e)}setUrl(e,t){const r=t.endsWith("/")?t:`${t}/`;this.config[e]=r,this.validationCache.delete(e),this.saveConfig()}removeUrl(e){delete this.config[e],this.validationCache.delete(e),this.saveConfig()}isConfigured(e){return!!(this.config[e]||this.getEnvDefault(e))}isUserConfigured(e){return!!this.config[e]}hasEnvDefault(e){return!!this.getEnvDefault(e)}hasAnyProvider(){return Object.keys(this.config).length>0||Object.values(c).some(Boolean)}async validateUrl(e,t){const r=t||this.config[e];if(!r)return{valid:!1,error:"No URL configured"};try{const s=new URL(r);if(!["http:","https:"].includes(s.protocol))return{valid:!1,error:"URL must start with http:// or https://"}}catch{return{valid:!1,error:"Invalid URL format. Please enter a valid URL (e.g., https://example.com/wasm/)"}}const o=r.endsWith("/")?r:`${r}/`;try{const n={pymupdf:"dist/index.js",ghostscript:"gs.js",cpdf:"coherentpdf.browser.min.js"}[e],f=`${o}${n}`,i=new AbortController,a=setTimeout(()=>i.abort(),1e4),u=await fetch(f,{method:"GET",mode:"cors",signal:i.signal});if(clearTimeout(a),!u.ok)return{valid:!1,error:`Could not find ${n} at the specified URL (HTTP ${u.status}). Make sure the file exists.`};const g=u.body?.getReader();if(g)try{await g.read(),g.cancel()}catch{return{valid:!1,error:"File exists but could not be read. Check CORS configuration."}}const l=u.headers.get("content-type");return l&&!l.includes("javascript")&&!l.includes("application/octet-stream")&&!l.includes("text/")?{valid:!1,error:`The URL returned unexpected content type: ${l}. Expected a JavaScript file.`}:((!t||t===this.config[e])&&this.validationCache.set(e,!0),{valid:!0})}catch(s){const n=s instanceof Error?s.message:"Unknown error";return n.includes("Failed to fetch")||n.includes("NetworkError")?{valid:!1,error:"Network error: Could not connect to the URL. Check that the URL is correct and the server allows CORS requests."}:{valid:!1,error:`Network error: ${n}`}}}getAllProviders(){return{pymupdf:this.config.pymupdf||c.pymupdf,ghostscript:this.config.ghostscript||c.ghostscript,cpdf:this.config.cpdf||c.cpdf}}clearAll(){this.config={},this.validationCache.clear();try{localStorage.removeItem(h)}catch(e){console.error("[WasmProvider] Failed to clear localStorage:",e)}}resetToDefaults(){this.clearAll()}getPackageDisplayName(e){return{pymupdf:"PyMuPDF (Document Processing)",ghostscript:"Ghostscript (PDF/A Conversion)",cpdf:"CoherentPDF (Bookmarks & Metadata)"}[e]}getPackageFeatures(e){return{pymupdf:["PDF to Text","PDF to Markdown","PDF to SVG","PDF to Images (High Quality)","PDF to DOCX","PDF to Excel/CSV","Extract Images","Extract Tables","EPUB/MOBI/FB2/XPS/CBZ to PDF","Image Compression","Deskew PDF","PDF Layers"],ghostscript:["PDF/A Conversion","Font to Outline"],cpdf:["Merge PDF","Alternate Merge","Split by Bookmarks","Table of Contents","PDF to JSON","JSON to PDF","Add/Edit/Extract Attachments","Edit Bookmarks","PDF Metadata"]}[e]}}const v=new y;function b(d,e){const t=v.getPackageDisplayName(d),r=v.getPackageFeatures(d),o=document.createElement("div");o.className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4",o.id="wasm-required-modal";const s=document.createElement("div");s.className="bg-gray-800 rounded-2xl max-w-md w-full shadow-2xl border border-gray-700",s.innerHTML=`
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
        This feature requires <strong class="text-white">${t}</strong> to be configured.
      </p>

      <div class="bg-gray-700/50 rounded-lg p-4 mb-4">
        <p class="text-sm text-gray-400 mb-2">Features enabled by this module:</p>
        <ul class="text-sm text-gray-300 space-y-1">
          ${r.slice(0,4).map(a=>`<li class="flex items-center gap-2"><span class="text-green-400">✓</span> ${a}</li>`).join("")}
          ${r.length>4?`<li class="text-gray-500">+ ${r.length-4} more...</li>`:""}
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
  `,o.appendChild(s),document.body.appendChild(o);const n=s.querySelector("#wasm-modal-cancel"),f=s.querySelector("#wasm-modal-configure"),i=()=>{o.remove()};n?.addEventListener("click",i),o.addEventListener("click",a=>{a.target===o&&i()}),f?.addEventListener("click",()=>{i(),window.location.href="/bento/wasm-settings.html"})}export{v as W,b as s};

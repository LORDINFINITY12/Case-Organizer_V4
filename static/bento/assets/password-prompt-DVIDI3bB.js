import{n as e,t}from"./style-yQMupAn_.js";import{C as n,N as r,O as i}from"./main-9bhvmph8.js";import{t as a}from"./pdf-decrypt-BQHqWSka.js";var o=null,s=null;function c(e){return document.getElementById(e)}function l(e){return e.replace(/&/g,`&amp;`).replace(/</g,`&lt;`).replace(/>/g,`&gt;`).replace(/"/g,`&quot;`)}function u(){let e=c(`password-modal`);return e||(e=document.createElement(`div`),e.id=`password-modal`,e.className=`fixed inset-0 bg-black/70 backdrop-blur-sm z-[100] hidden items-center justify-center p-4`,e.innerHTML=`
    <div class="bg-gray-800 rounded-xl border border-gray-700 shadow-2xl max-w-md w-full overflow-hidden">
      <div class="p-6">
        <div class="flex items-start gap-4 mb-4">
          <div class="w-12 h-12 flex items-center justify-center rounded-full bg-indigo-500/10 flex-shrink-0">
            <i data-lucide="lock" class="w-6 h-6 text-indigo-400"></i>
          </div>
          <div class="flex-1">
            <h3 id="password-modal-title" class="text-xl font-bold text-white mb-1">Password Required</h3>
            <p id="password-modal-subtitle" class="text-gray-400 text-sm truncate"></p>
          </div>
        </div>
        <div class="mt-4">
          <div class="relative">
            <input type="password" id="password-modal-input"
              class="w-full bg-gray-700 border border-gray-600 text-gray-200 rounded-lg px-4 py-2.5 pr-10 text-sm focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
              placeholder="Enter password" autocomplete="off" />
            <button id="password-modal-toggle" type="button"
              class="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-200">
              <i data-lucide="eye" class="w-4 h-4"></i>
            </button>
          </div>
          <p id="password-modal-error" class="text-xs text-red-400 mt-2 hidden"></p>
          <p id="password-modal-progress" class="text-xs text-gray-400 mt-2 hidden"></p>
        </div>
      </div>
      <div class="flex gap-3 p-4 border-t border-gray-700">
        <button id="password-modal-cancel"
          class="flex-1 px-4 py-2.5 bg-gray-700 hover:bg-gray-600 text-white rounded-lg font-medium transition-colors">
          Skip
        </button>
        <button id="password-modal-submit"
          class="flex-1 px-4 py-2.5 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg font-medium transition-colors">
          Unlock
        </button>
      </div>
    </div>`,document.body.appendChild(e),e)}function d(){let e=c(`password-batch-modal`);return e||(e=document.createElement(`div`),e.id=`password-batch-modal`,e.className=`fixed inset-0 bg-black/70 backdrop-blur-sm z-[100] hidden items-center justify-center p-4`,e.innerHTML=`
    <div class="bg-gray-800 rounded-xl border border-gray-700 shadow-2xl max-w-lg w-full max-h-[90vh] flex flex-col overflow-hidden">
      <div class="p-6 overflow-y-auto flex-1 min-h-0">
        <div class="flex items-start gap-4 mb-4">
          <div class="w-12 h-12 flex items-center justify-center rounded-full bg-indigo-500/10 flex-shrink-0">
            <i data-lucide="lock" class="w-6 h-6 text-indigo-400"></i>
          </div>
          <div class="flex-1">
            <h3 id="batch-modal-title" class="text-xl font-bold text-white mb-1"></h3>
            <p class="text-gray-400 text-sm">Enter passwords for each encrypted file</p>
          </div>
        </div>
        <div class="flex items-center gap-2 mt-3 mb-3">
          <input type="checkbox" id="batch-modal-same-pw" checked
            class="w-4 h-4 rounded bg-gray-700 border-gray-600 text-indigo-500 focus:ring-indigo-500 focus:ring-offset-0 cursor-pointer" />
          <label for="batch-modal-same-pw" class="text-sm text-gray-300 cursor-pointer select-none">Use same password for all files</label>
        </div>
        <div id="batch-modal-shared" class="mb-3">
          <div class="relative">
            <input type="password" id="batch-modal-shared-input"
              class="w-full bg-gray-700 border border-gray-600 text-gray-200 rounded-lg px-4 py-2.5 pr-10 text-sm focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
              placeholder="Password for all files" autocomplete="off" />
            <button id="batch-modal-shared-toggle" type="button"
              class="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-200">
              <i data-lucide="eye" class="w-4 h-4"></i>
            </button>
          </div>
        </div>
        <div id="batch-modal-filelist" class="space-y-2 hidden"></div>
        <p id="batch-modal-error" class="text-xs text-red-400 mt-2 hidden"></p>
        <p id="batch-modal-progress" class="text-xs text-gray-400 mt-2 hidden"></p>
      </div>
      <div class="flex gap-3 p-4 border-t border-gray-700 flex-shrink-0">
        <button id="batch-modal-cancel"
          class="flex-1 px-4 py-2.5 bg-gray-700 hover:bg-gray-600 text-white rounded-lg font-medium transition-colors">
          Skip All
        </button>
        <button id="batch-modal-submit"
          class="flex-1 px-4 py-2.5 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg font-medium transition-colors">
          Unlock All
        </button>
      </div>
    </div>`,document.body.appendChild(e),e)}function f(e,t){return new Promise(i=>{let a=!1,o=n({data:e.slice(0),password:t});o.onPassword=(e,t)=>{a||(a=!0,i(t!==r.INCORRECT_PASSWORD),o.destroy().catch(()=>{}))},o.promise.then(e=>{e.destroy(),a||(a=!0,i(!0))}).catch(()=>{a||(a=!0,i(!1))})})}async function p(e){let t=await i(e);return new Promise(e=>{let r=!1,i=n({data:t.slice(0)});i.onPassword=()=>{r||(r=!0,e(!0),i.destroy().catch(()=>{}))},i.promise.then(t=>{t.destroy(),r||(r=!0,e(!1))}).catch(()=>{r||(r=!0,e(!1))})})}async function m(e,t){let n=await i(e),r=await a(new Uint8Array(n),t);return new File([new Uint8Array(r.bytes)],e.name,{type:`application/pdf`})}async function h(n){s&&await s;let r=await i(n);if(o)if(await f(r,o))try{return await m(n,o)}catch{o=null}else o=null;let a=u(),l=c(`password-modal-input`),d=c(`password-modal-title`),p=c(`password-modal-subtitle`),h=c(`password-modal-error`),g=c(`password-modal-progress`),_=c(`password-modal-submit`),v=c(`password-modal-cancel`),y=c(`password-modal-toggle`);if(!l||!_||!v)return null;d&&(d.textContent=`Password Required`),p&&(p.textContent=n.name),h&&(h.textContent=``,h.classList.add(`hidden`)),g&&(g.textContent=``,g.classList.add(`hidden`)),l.value=``,l.type=`password`,_.disabled=!1,_.textContent=`Unlock`,_.dataset.originalText=`Unlock`,v.disabled=!1,v.textContent=`Skip`,a.classList.remove(`hidden`),a.classList.add(`flex`),t({icons:e}),setTimeout(()=>l.focus(),100);let b=new Promise(i=>{let s=!1,c=!1;function u(){a.classList.add(`hidden`),a.classList.remove(`flex`),_.removeEventListener(`click`,p),v.removeEventListener(`click`,b),l.removeEventListener(`keydown`,x),y&&y.removeEventListener(`click`,S)}function d(e){s||(s=!0,u(),i(e))}async function p(){if(c)return;let e=l.value;if(!e){h&&(h.textContent=`Please enter a password`,h.classList.remove(`hidden`));return}if(h&&h.classList.add(`hidden`),c=!0,_.disabled=!0,v.disabled=!0,g&&(g.textContent=`Validating...`,g.classList.remove(`hidden`)),!await f(r,e)){c=!1,_.disabled=!1,v.disabled=!1,g&&g.classList.add(`hidden`),l.value=``,l.focus(),h&&(h.textContent=`Incorrect password. Please try again.`,h.classList.remove(`hidden`));return}g&&(g.textContent=`Decrypting...`);try{let t=await m(n,e);o=e,g&&g.classList.add(`hidden`),d(t)}catch{c=!1,_.disabled=!1,v.disabled=!1,g&&g.classList.add(`hidden`),h&&(h.textContent=`Failed to decrypt. Try the Decrypt tool instead.`,h.classList.remove(`hidden`))}}function b(){c||d(null)}function x(e){e.key===`Enter`?(e.preventDefault(),p()):e.key===`Escape`&&(e.preventDefault(),b())}function S(){let n=l.type===`password`;l.type=n?`text`:`password`;let r=y?.querySelector(`i[data-lucide]`);r&&r.setAttribute(`data-lucide`,n?`eye-off`:`eye`),t({icons:e})}_.addEventListener(`click`,p),v.addEventListener(`click`,b),l.addEventListener(`keydown`,x),y&&y.addEventListener(`click`,S)});return s=b,b.finally(()=>{s===b&&(s=null)}),b}async function g(n,r){s&&await s;let a=new Map;if(r.length===0)return a;if(r.length===1){let e=r[0],t=await h(n[e]);return t&&a.set(e,t),a}if(o){let e=!0;for(let t of r)if(!await f(await i(n[t]),o)){e=!1,o=null;break}if(e&&o){let e=new Map,t=!0;for(let i of r)try{e.set(i,await m(n[i],o))}catch{o=null,t=!1;break}if(t&&e.size===r.length){for(let[t,n]of e)a.set(t,n);return a}}}let u=r.map(e=>n[e].name),p=d(),g=c(`batch-modal-title`),_=c(`batch-modal-same-pw`),v=c(`batch-modal-shared`),y=c(`batch-modal-shared-input`),b=c(`batch-modal-shared-toggle`),x=c(`batch-modal-filelist`),S=c(`batch-modal-error`),C=c(`batch-modal-progress`),w=c(`batch-modal-submit`),T=c(`batch-modal-cancel`);if(!w||!T||!_||!y||!x)return a;g&&(g.textContent=`${u.length} Files Need a Password`),_.checked=!0,y.value=``,y.type=`password`,v&&v.classList.remove(`hidden`),x.classList.add(`hidden`),x.innerHTML=u.map((e,t)=>`<div class="flex items-center gap-2 p-2 bg-gray-700/50 rounded-lg transition-all" data-file-idx="${t}">
          <i data-lucide="file-lock" class="w-4 h-4 text-indigo-400 flex-shrink-0" data-icon-idx="${t}"></i>
          <span class="text-sm text-gray-300 truncate flex-1" title="${l(e)}">${l(e)}</span>
          <div class="flex items-center gap-1.5 flex-shrink-0">
            <input type="password" data-pw-idx="${t}" placeholder="Password"
              class="w-32 bg-gray-600 border border-gray-500 text-gray-200 rounded px-2 py-1 text-xs focus:ring-1 focus:ring-indigo-500 focus:border-transparent" autocomplete="off" />
            <button type="button" data-skip-idx="${t}" title="Skip this file"
              class="p-1 rounded text-gray-400 hover:text-red-400 hover:bg-gray-600 transition-colors">
              <i data-lucide="x" class="w-3.5 h-3.5"></i>
            </button>
          </div>
        </div>`).join(``),S&&(S.textContent=``,S.classList.add(`hidden`)),C&&(C.textContent=``,C.classList.add(`hidden`)),w.disabled=!1,w.textContent=`Unlock All`,w.dataset.originalText=`Unlock All`,T.disabled=!1,p.classList.remove(`hidden`),p.classList.add(`flex`),t({icons:e}),setTimeout(()=>y.focus(),100);let E=new Promise(s=>{let c=!1,l=!1,d=new Set,h=new Set;function g(){let e=0;for(let t=0;t<u.length;t++)!d.has(t)&&!h.has(t)&&e++;return e}function E(e=!1){let t=h.size>0;T.textContent=t?`Skip Remaining`:`Skip All`;let n=g();if(e&&n===0){M(a);return}t&&(w.textContent=`Unlock Remaining (${n})`,w.dataset.originalText=w.textContent)}function D(){let e=_.checked;if(v&&v.classList.toggle(`hidden`,!e),x.classList.toggle(`hidden`,e),e)setTimeout(()=>y.focus(),50);else{let e=x.querySelector(`input[data-pw-idx]:not(:disabled)`);e&&setTimeout(()=>e.focus(),50)}}function O(n){h.add(n);let r=x.querySelector(`[data-file-idx="${n}"]`);if(!r)return;r.classList.remove(`border`,`border-red-500/50`),r.classList.add(`opacity-50`,`border`,`border-green-500/50`);let i=r.querySelector(`input[data-pw-idx]`);i&&(i.disabled=!0);let a=r.querySelector(`[data-skip-idx]`);a&&a.classList.add(`hidden`);let o=r.querySelector(`[data-icon-idx="${n}"]`);o&&(o.setAttribute(`data-lucide`,`check-circle`),o.classList.remove(`text-indigo-400`),o.classList.add(`text-green-400`)),t({icons:e})}function k(e){let t=x.querySelector(`[data-file-idx="${e}"]`);if(!t)return;t.classList.remove(`border-green-500/50`),t.classList.add(`border`,`border-red-500/50`);let n=t.querySelector(`input[data-pw-idx]`);n&&(n.value=``,n.focus(),n.classList.add(`border-red-500`),setTimeout(()=>n.classList.remove(`border-red-500`),2e3))}function A(e){if(l)return;let t=e.target.closest(`[data-skip-idx]`);if(!t||t.dataset.skipIdx===void 0)return;let n=parseInt(t.dataset.skipIdx,10);if(isNaN(n)||h.has(n))return;let r=x.querySelector(`[data-file-idx="${n}"]`);if(r){if(d.has(n)){d.delete(n),r.classList.remove(`opacity-40`);let e=r.querySelector(`input[data-pw-idx]`);e&&(e.disabled=!1),t.title=`Skip this file`}else{d.add(n),r.classList.add(`opacity-40`),r.classList.remove(`border`,`border-red-500/50`);let e=r.querySelector(`input[data-pw-idx]`);e&&(e.disabled=!0),t.title=`Include this file`}E(!0)}}function j(){p.classList.add(`hidden`),p.classList.remove(`flex`),w.removeEventListener(`click`,N),T.removeEventListener(`click`,P),_.removeEventListener(`change`,D),x.removeEventListener(`click`,A),b&&b.removeEventListener(`click`,I),y.removeEventListener(`keydown`,F)}function M(e){c||(c=!0,j(),s(e))}async function N(){if(l)return;let e=_.checked,t=[];for(let n=0;n<u.length;n++){if(d.has(n)||h.has(n))continue;let r;if(r=e?y.value:x.querySelector(`input[data-pw-idx="${n}"]`)?.value||``,!r){S&&(S.textContent=e?`Please enter a password`:`Please enter a password for ${u[n]} or skip it`,S.classList.remove(`hidden`));return}t.push({localIdx:n,password:r})}if(t.length===0){M(a);return}S&&S.classList.add(`hidden`),l=!0,w.disabled=!0,T.disabled=!0;let s=[];for(let e=0;e<t.length;e++){let{localIdx:o,password:c}=t[e],l=r[o];if(C&&(C.textContent=`Validating ${e+1} of ${t.length}: ${n[l].name}`,C.classList.remove(`hidden`)),!await f(await i(n[l]),c)){s.push(n[l].name),k(o);continue}C&&(C.textContent=`Decrypting ${e+1} of ${t.length}: ${n[l].name}`);try{let e=await m(n[l],c);a.set(l,e),O(o)}catch{s.push(n[l].name),k(o)}}if(C&&C.classList.add(`hidden`),l=!1,w.disabled=!1,T.disabled=!1,s.length>0){if(S&&(S.textContent=`Wrong password for: ${s.join(`, `)}`,S.classList.remove(`hidden`)),_.checked)y.value=``,y.focus();else{let e=x.querySelector(`input[data-pw-idx]:not(:disabled)`);e&&e.focus()}E(),w.textContent=`Retry Failed`;return}e&&t.length>0&&(o=t[0].password),E(),c||M(a)}function P(){l||M(a)}function F(e){e.key===`Enter`?(e.preventDefault(),N()):e.key===`Escape`&&(e.preventDefault(),P())}function I(){let n=y.type===`password`;y.type=n?`text`:`password`;let r=b?.querySelector(`i[data-lucide]`);r&&r.setAttribute(`data-lucide`,n?`eye-off`:`eye`),t({icons:e})}_.addEventListener(`change`,D),w.addEventListener(`click`,N),T.addEventListener(`click`,P),x.addEventListener(`click`,A),y.addEventListener(`keydown`,F),b&&b.addEventListener(`click`,I)});return s=E,E.finally(()=>{s===E&&(s=null)}),E}async function _(e,t,r){let a=await i(e),o=e;try{return{pdf:await n(a.slice(0)).promise,bytes:a,file:o}}catch(e){if(e&&typeof e==`object`&&`name`in e&&e.name===`PasswordException`){let e=await h(o);return e?(o=e,t&&r!==void 0&&(t[r]=e),a=await i(e),{pdf:await n(a.slice(0)).promise,bytes:a,file:o}):null}throw e}}async function v(e){let t=[];for(let n=0;n<e.length;n++)await p(e[n])&&t.push(n);if(t.length===0)return[...e];let n=await g(e,t),r=new Set(t.filter(e=>!n.has(e))),i=[];for(let t=0;t<e.length;t++)r.has(t)||i.push(n.get(t)??e[t]);return i}export{_ as n,v as t};
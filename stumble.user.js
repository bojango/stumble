// ==UserScript==
// @name         Stumble — personal internet randomiser
// @namespace    https://github.com/bojango/stumble
// @version      0.1.0
// @description  A one-person StumbleUpon-style discovery tool for Safari.
// @author       Calum
// @match        http://*/*
// @match        https://*/*
// @run-at       document-end
// @inject-into  content
// @grant        GM.getValue
// @grant        GM.setValue
// @grant        GM.xmlHttpRequest
// @connect      bojango.github.io
// @connect      *
// @updateURL    https://bojango.github.io/stumble/stumble.user.js
// @downloadURL  https://bojango.github.io/stumble/stumble.user.js
// ==/UserScript==

(() => {
  'use strict';

  const BASE = 'https://bojango.github.io/stumble/';
  const MANIFEST = `${BASE}data/manifest.json`;
  const K = {
    settings: 'stumble.settings.v1', weights: 'stumble.weights.v1',
    history: 'stumble.history.v1', votes: 'stumble.votes.v1', current: 'stumble.current.v1'
  };
  const defaults = {
    mode: 'for-you', selectedRoot: 'science', selectedTopic: 'space',
    smartFilter: true, informationalOnly: false
  };
  const cache = new Map();

  const get = async (key, fallback) => {
    try { return await GM.getValue(key, fallback); } catch { return fallback; }
  };
  const set = async (key, value) => {
    try { await GM.setValue(key, value); } catch (e) { console.warn('Stumble storage error', e); }
  };
  const clamp = (n, min, max) => Math.max(min, Math.min(max, n));
  const host = url => { try { return new URL(url).hostname.replace(/^www\./, '').toLowerCase(); } catch { return ''; } };
  const keyFor = url => { try { const u = new URL(url); u.hash = ''; return `${u.hostname.toLowerCase()}${u.pathname}${u.search}`; } catch { return url; } };
  const rootFor = path => (path || 'other').split('/')[0].toLowerCase().replace(/_/g, '-');
  const label = s => String(s || '').replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

  async function xhr(url, options = {}) {
    return GM.xmlHttpRequest({
      method: options.method || 'GET', url, timeout: options.timeout || 12000,
      headers: options.headers || {}, responseType: 'text'
    });
  }

  async function getJson(url) {
    if (cache.has(url)) return cache.get(url);
    const r = await xhr(url);
    if (r.status < 200 || r.status >= 300) throw new Error(`Catalogue request failed (${r.status})`);
    const data = JSON.parse(r.responseText);
    cache.set(url, data);
    return data;
  }

  async function state() {
    const [settings, weights, history, votes, current] = await Promise.all([
      get(K.settings, defaults), get(K.weights, {}), get(K.history, []), get(K.votes, []), get(K.current, null)
    ]);
    return {
      settings: { ...defaults, ...(settings || {}) }, weights: weights || {},
      history: Array.isArray(history) ? history : [], votes: Array.isArray(votes) ? votes : [], current
    };
  }

  async function manifest() {
    const stored = await get('stumble.manifest.v1', null);
    const storedAt = await get('stumble.manifestAt.v1', 0);
    if (stored && Date.now() - storedAt < 6 * 3600000) return stored;
    try {
      const m = await getJson(MANIFEST);
      await Promise.all([set('stumble.manifest.v1', m), set('stumble.manifestAt.v1', Date.now())]);
      return m;
    } catch (e) {
      if (stored) return stored;
      throw e;
    }
  }

  function weighted(items, weights) {
    const rows = items.map(item => [item, Math.max(.15, 1 + (weights[item] || 0))]);
    let roll = Math.random() * rows.reduce((n, row) => n + row[1], 0);
    for (const row of rows) { roll -= row[1]; if (roll <= 0) return row[0]; }
    return rows.at(-1)[0];
  }

  function chooseSource(m, s) {
    if (s.settings.mode === 'category') {
      if (s.settings.selectedTopic && m.topics?.[s.settings.selectedTopic]) return ['topics', s.settings.selectedTopic];
      if (m.roots?.[s.settings.selectedRoot]) return ['roots', s.settings.selectedRoot];
    }

    let roots = Object.keys(m.roots || {});
    if (s.settings.informationalOnly) {
      const allowed = new Set(m.informational_roots || []);
      roots = roots.filter(x => allowed.has(x));
    }
    if (!roots.length) throw new Error('No catalogue categories available');
    if (s.settings.mode === 'random') return ['roots', roots[Math.floor(Math.random() * roots.length)]];

    const learnedTopics = Object.keys(m.topics || {}).filter(t => (s.weights[`topic:${t}`] || 0) > .05);
    if (learnedTopics.length && Math.random() < .38) {
      const tw = Object.fromEntries(learnedTopics.map(t => [t, s.weights[`topic:${t}`] || 0]));
      return ['topics', weighted(learnedTopics, tw)];
    }
    return ['roots', weighted(roots, s.weights)];
  }

  async function randomShard(m, namespace, group) {
    const info = m?.[namespace]?.[group];
    if (!info?.shards) throw new Error(`No pages available for ${label(group)}`);
    const n = Math.floor(Math.random() * info.shards);
    return getJson(`${BASE}data/${namespace}/${group}/${String(n).padStart(4, '0')}.json`);
  }

  function shuffled(rows) {
    rows = rows.slice();
    for (let i = rows.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [rows[i], rows[j]] = [rows[j], rows[i]];
    }
    return rows;
  }

  function badContent(text, finalUrl) {
    const html = String(text || '').slice(0, 180000).toLowerCase();
    const u = String(finalUrl || '').toLowerCase();
    const titleMatch = html.match(/<title[^>]*>([\s\S]{0,400}?)<\/title>/i);
    const title = titleMatch ? titleMatch[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() : '';
    if (/\/(login|signin|sign-in|register|signup|checkout|cart|account|auth)(\/|\?|#|$)/i.test(u)) return true;
    if (/(^|\b)(404|page not found|sign in|log in|login|access denied|forbidden)(\b|$)/i.test(title)) return true;
    return [
      'subscribe to continue', 'subscribe to read', 'already a subscriber',
      'sign in to continue', 'register to continue', 'create an account to continue',
      'subscription required', 'isaccessibleforfree" content="false', 'isaccessibleforfree\":false'
    ].some(x => html.includes(x));
  }

  async function preflight(entry) {
    try {
      const r = await xhr(entry[0], { timeout: 9000, headers: { Range: 'bytes=0-180000' } });
      if (!r.status || r.status >= 400) return false;
      const type = (r.responseHeaders.match(/content-type:\s*([^\r\n]+)/i)?.[1] || '').toLowerCase();
      if (type && !type.includes('text/html') && !type.includes('application/xhtml')) return false;
      return !badContent(r.responseText, r.responseURL || entry[0]);
    } catch {
      return true;
    }
  }

  async function pick() {
    const s = await state();
    const m = await manifest();
    const currentHost = host(location.href);
    for (let attempt = 0; attempt < 5; attempt++) {
      const [namespace, group] = chooseSource(m, s);
      const rows = shuffled(await randomShard(m, namespace, group));
      for (const entry of rows.slice(0, 24)) {
        if (s.history.includes(keyFor(entry[0])) || host(entry[0]) === currentHost) continue;
        if (s.settings.smartFilter && !(await preflight(entry))) continue;
        return entry;
      }
    }
    throw new Error('No fresh page found. Try another category or disable Smart Filter.');
  }

  async function stumble(button) {
    const old = button?.textContent;
    if (button) { button.disabled = true; button.textContent = 'FINDING…'; }
    try {
      const entry = await pick();
      const [url, title, category, topics] = entry;
      const s = await state();
      const history = [keyFor(url), ...s.history.filter(x => x !== keyFor(url))].slice(0, 1000);
      await Promise.all([
        set(K.history, history),
        set(K.current, { url, title, category, topics, chosenAt: Date.now() })
      ]);
      location.href = url;
    } catch (e) {
      toast(e.message || 'Stumble failed');
      if (button) { button.disabled = false; button.textContent = old || 'STUMBLE'; }
    }
  }

  async function vote(value) {
    const s = await state();
    const c = s.current;
    if (!c || !c.finalUrl || keyFor(c.finalUrl) !== keyFor(location.href)) return toast('This page was not opened by Stumble.');
    const delta = value > 0 ? .35 : -.45;
    const weights = { ...s.weights };
    const root = rootFor(c.category);
    weights[root] = clamp((weights[root] || 0) + delta, -.85, 4);
    for (const topic of c.topics || []) weights[`topic:${topic}`] = clamp((weights[`topic:${topic}`] || 0) + delta, -.85, 4);
    const votes = [{ url: c.url, category: c.category, topics: c.topics || [], value, at: Date.now() }, ...s.votes].slice(0, 2500);
    await Promise.all([set(K.weights, weights), set(K.votes, votes)]);
    toast(value > 0 ? 'Liked. More like this.' : 'Disliked. Less like this.');
  }

  function toast(message) {
    let el = document.getElementById('stumble-toast');
    if (!el) {
      el = document.createElement('div'); el.id = 'stumble-toast';
      Object.assign(el.style, {
        position:'fixed',left:'50%',bottom:'92px',transform:'translateX(-50%)',zIndex:'2147483647',
        background:'#111',color:'#fff',padding:'10px 13px',borderRadius:'999px',maxWidth:'86vw',textAlign:'center',
        font:'600 13px/1.3 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',boxShadow:'0 8px 30px rgba(0,0,0,.22)'
      });
      document.documentElement.appendChild(el);
    }
    el.textContent = message; el.style.display = 'block';
    clearTimeout(toast.timer); toast.timer = setTimeout(() => { el.style.display = 'none'; }, 2200);
  }

  async function settings() {
    document.getElementById('stumble-settings')?.remove();
    const m = await manifest(); const s = await state();
    const roots = Object.keys(m.roots || {}); const topics = Object.keys(m.topics || {});
    const hostEl = document.createElement('div'); hostEl.id = 'stumble-settings';
    Object.assign(hostEl.style,{position:'fixed',inset:'0',zIndex:'2147483647'});
    const sh = hostEl.attachShadow({mode:'open'});
    sh.innerHTML = `<style>
      *{box-sizing:border-box}.back{position:absolute;inset:0;background:rgba(0,0,0,.42);backdrop-filter:blur(5px)}
      .sheet{position:absolute;left:12px;right:12px;bottom:12px;max-height:78vh;overflow:auto;background:#f7f5ef;color:#111;border:1px solid #111;border-radius:18px;padding:20px;font:14px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;box-shadow:0 20px 70px rgba(0,0,0,.28)}
      h2{font:700 22px/1.1 Georgia,serif;margin:0 0 18px}label{display:block;margin:15px 0 6px;font-weight:700}select{width:100%;font:inherit;padding:11px;background:white;border:1px solid #aaa;border-radius:10px}.switch{display:flex;align-items:center;gap:10px;margin:16px 0}.switch input{width:20px;height:20px}.actions{display:flex;gap:8px;margin-top:20px}.actions button{flex:1;border:1px solid #111;border-radius:999px;padding:12px;background:#111;color:#fff;font-weight:800}.actions .ghost{background:transparent;color:#111}.meta{font-size:12px;color:#666;margin-top:18px}
      </style><div class="back"></div><section class="sheet"><h2>Preferences</h2>
      <label>Mode</label><select id="mode"><option value="for-you">For you</option><option value="random">Pure random</option><option value="category">Category</option></select>
      <label>Broad category</label><select id="root">${roots.map(x=>`<option value="${x}">${label(x)} · ${m.roots[x].count.toLocaleString()}</option>`).join('')}</select>
      <label>Quick topic</label><select id="topic"><option value="">None</option>${topics.map(x=>`<option value="${x}">${label(x)} · ${m.topics[x].count.toLocaleString()}</option>`).join('')}</select>
      <label class="switch"><input id="info" type="checkbox">Informational sites only</label>
      <label class="switch"><input id="smart" type="checkbox">Smart-filter dead/login/paywall candidates</label>
      <div class="actions"><button id="save">Save</button><button id="close" class="ghost">Close</button></div>
      <div class="meta">${m.entries.toLocaleString()} catalogue entries · refreshed ${new Date(m.generated).toLocaleDateString()}<br>Directory data from Curlie.org, CC BY 3.0.</div></section>`;
    sh.getElementById('mode').value=s.settings.mode; sh.getElementById('root').value=s.settings.selectedRoot;
    sh.getElementById('topic').value=s.settings.selectedTopic||''; sh.getElementById('info').checked=s.settings.informationalOnly; sh.getElementById('smart').checked=s.settings.smartFilter;
    sh.querySelector('.back').onclick=()=>hostEl.remove(); sh.getElementById('close').onclick=()=>hostEl.remove();
    sh.getElementById('save').onclick=async()=>{
      await set(K.settings,{...s.settings,mode:sh.getElementById('mode').value,selectedRoot:sh.getElementById('root').value,selectedTopic:sh.getElementById('topic').value,informationalOnly:sh.getElementById('info').checked,smartFilter:sh.getElementById('smart').checked});
      hostEl.remove(); toast('Preferences saved.'); if (isHome()) home();
    };
    document.documentElement.appendChild(hostEl);
  }

  function toolbar() {
    if (document.getElementById('stumble-toolbar')) return;
    const el=document.createElement('div'); el.id='stumble-toolbar';
    Object.assign(el.style,{position:'fixed',left:'50%',bottom:'14px',transform:'translateX(-50%)',zIndex:'2147483646'});
    const sh=el.attachShadow({mode:'open'});
    sh.innerHTML=`<style>*{box-sizing:border-box}.bar{display:flex;align-items:center;gap:4px;padding:5px;background:rgba(247,245,239,.96);border:1px solid #111;border-radius:999px;box-shadow:0 10px 36px rgba(0,0,0,.24);backdrop-filter:blur(10px)}button{border:0;background:transparent;color:#111;height:42px;min-width:42px;padding:0 11px;border-radius:999px;font:800 13px/1 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}.go{background:#111;color:#fff;min-width:112px;letter-spacing:.04em}.vote{font-size:20px}button:active{transform:scale(.96)}button:disabled{opacity:.55}</style><div class="bar"><button class="vote" id="no">−</button><button class="go" id="go">STUMBLE</button><button class="vote" id="yes">+</button><button id="prefs">⌘</button></div>`;
    sh.getElementById('go').onclick=e=>stumble(e.currentTarget); sh.getElementById('yes').onclick=()=>vote(1); sh.getElementById('no').onclick=()=>vote(-1); sh.getElementById('prefs').onclick=settings;
    document.documentElement.appendChild(el);
  }

  function isHome(){ return location.hostname==='bojango.github.io' && location.pathname.replace(/\/+$/,'')==='/stumble'; }

  async function home(){
    const app=document.getElementById('app'); if(!app)return; const m=await manifest(); const s=await state();
    app.innerHTML=`<div class="home-shell"><div class="home-mark">STUMBLE</div><button class="stumble-button" id="home-go">STUMBLE</button><button class="prefs-button" id="home-prefs">Preferences</button><div class="home-meta">${m.entries.toLocaleString()} pages · ${label(s.settings.mode)}</div></div>`;
    document.getElementById('home-go').onclick=e=>stumble(e.currentTarget); document.getElementById('home-prefs').onclick=settings;
  }

  async function reconcile(){
    const c=await get(K.current,null); if(!c)return; const age=Date.now()-(c.chosenAt||0);
    if(age>86400000){await set(K.current,null);return;}
    if(!c.landedAt && age<120000){c.finalUrl=location.href;c.landedAt=Date.now();await set(K.current,c);return;}
    if(c.finalUrl && keyFor(c.finalUrl)!==keyFor(location.href)) await set(K.current,null);
  }

  (async()=>{await reconcile(); if(isHome()) await home(); else toolbar();})().catch(e=>console.error('Stumble init failed',e));
})();

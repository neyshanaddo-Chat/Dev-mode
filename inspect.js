// Dev mode inspector: runs inside the preview of your site (never on your real website).
// Talks to the Dev mode window around it with postMessage.
(function () {
  'use strict';
  if (window.__dmInspect) return;
  window.__dmInspect = true;
  const parentWin = window.parent !== window ? window.parent : null;
  const send = (m) => { if (parentWin) parentWin.postMessage(Object.assign({ dm: 1 }, m), location.origin); };

  let on = false, hover = null, sel = null, editingText = false;
  const ui = document.createElement('div');
  ui.setAttribute('data-dm-ui', '');
  ui.innerHTML = '<div class="h"></div><div class="s"></div><div class="l"></div>';
  const st = document.createElement('style');
  st.setAttribute('data-dm-ui', '');
  st.textContent = `
    [data-dm-ui] .h,[data-dm-ui] .s{position:fixed;pointer-events:none;z-index:2147483646;box-sizing:border-box;display:none;border-radius:3px}
    [data-dm-ui] .h{border:2px solid #22d3ee;background:rgba(34,211,238,.10)}
    [data-dm-ui] .s{border:2px solid #f59e0b;background:rgba(245,158,11,.10)}
    [data-dm-ui] .l{position:fixed;pointer-events:none;z-index:2147483647;display:none;font:12px/1.3 system-ui,sans-serif;
      background:#0f172a;color:#e2e8f0;padding:3px 7px;border-radius:5px;white-space:nowrap;box-shadow:0 2px 8px rgba(0,0,0,.3)}
    .__dm-inspecting, .__dm-inspecting * { cursor: crosshair !important; }
    [contenteditable].__dm-editing{outline:2px dashed #f59e0b !important;outline-offset:2px}`;
  const mount = () => { (document.body || document.documentElement).appendChild(ui); document.head?.appendChild(st); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount); else mount();
  const [hBox, sBox, label] = ui.children;

  const isUi = (el) => el && el.closest && el.closest('[data-dm-ui]');
  function place(box, el) {
    if (!el || !el.isConnected) { box.style.display = 'none'; return; }
    const r = el.getBoundingClientRect();
    Object.assign(box.style, { display: 'block', left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px' });
  }
  function name(el) {
    let n = el.tagName.toLowerCase();
    if (el.id) n += '#' + el.id;
    const c = [...el.classList].filter((x) => !x.startsWith('__dm')).slice(0, 2);
    if (c.length) n += '.' + c.join('.');
    return n;
  }
  function showLabel(el) {
    if (!el) { label.style.display = 'none'; return; }
    const r = el.getBoundingClientRect();
    label.textContent = name(el) + '  ' + Math.round(r.width) + '×' + Math.round(r.height);
    label.style.display = 'block';
    const y = r.top > 24 ? r.top - 22 : r.bottom + 4;
    label.style.left = Math.max(2, Math.min(r.left, innerWidth - label.offsetWidth - 4)) + 'px';
    label.style.top = Math.max(2, Math.min(y, innerHeight - 22)) + 'px';
  }
  const redraw = () => { place(hBox, on ? hover : null); place(sBox, sel); if (on && hover) showLabel(hover); else showLabel(null); };
  addEventListener('scroll', redraw, true);
  addEventListener('resize', redraw);

  function selectorOf(el) {
    if (el.id) return '#' + CSS.escape(el.id);
    const parts = [];
    for (let e = el; e && e.nodeType === 1 && e !== document.documentElement; e = e.parentElement) {
      let p = e.tagName.toLowerCase();
      if (e.id) { parts.unshift('#' + CSS.escape(e.id)); break; }
      const cls = [...e.classList].filter((x) => !x.startsWith('__dm'))[0];
      if (cls) p += '.' + CSS.escape(cls);
      const sib = e.parentElement ? [...e.parentElement.children].filter((x) => x.tagName === e.tagName) : [];
      if (sib.length > 1) p += `:nth-of-type(${sib.indexOf(e) + 1})`;
      parts.unshift(p);
      if (parts.length > 4) break;
    }
    return parts.join(' > ');
  }

  function rulesFor(el) {
    const out = [];
    const walk = (rules, sheet) => {
      for (const r of rules) {
        if (r.cssRules && !r.selectorText) { try { walk(r.cssRules, sheet); } catch (_) {} continue; }
        if (!r.selectorText) continue;
        let ok = false;
        try { ok = el.matches(r.selectorText); } catch (_) {}
        if (!ok) continue;
        const owner = sheet.ownerNode;
        out.push({
          selector: r.selectorText,
          css: r.style.cssText.slice(0, 300),
          href: sheet.href || '',
          inlineAt: owner && owner.getAttribute ? owner.getAttribute('data-dm') : null
        });
      }
    };
    for (const s of document.styleSheets) {
      if (s.ownerNode && s.ownerNode.hasAttribute && s.ownerNode.hasAttribute('data-dm-ui')) continue;
      try { walk(s.cssRules, s); } catch (_) {}
    }
    return out.reverse().slice(0, 30);   // most specific / last first
  }

  const STYLE = ['color', 'backgroundColor', 'fontSize', 'fontWeight', 'fontStyle', 'textAlign', 'padding', 'margin',
    'borderRadius', 'display', 'width', 'height', 'fontFamily', 'lineHeight', 'opacity'];
  function info(el) {
    const anchor = el.closest('[data-dm]');
    const exact = anchor === el;
    const cs = getComputedStyle(el);
    const attrs = [...el.attributes].filter((a) => a.name !== 'data-dm' && a.name !== 'contenteditable' &&
      !(a.name === 'class' && a.value.includes('__dm'))).map((a) => ({ name: a.name, value: a.value }));
    const cls = el.getAttribute('class');
    if (cls && cls.includes('__dm')) attrs.push({ name: 'class', value: cls.split(/\s+/).filter((x) => !x.startsWith('__dm')).join(' ') });
    return {
      name: name(el), tag: el.tagName.toLowerCase(), selector: selectorOf(el),
      at: anchor ? +anchor.getAttribute('data-dm') : null, exact,
      text: (el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 120),
      leaf: el.children.length === 0,
      canText: !/^(img|input|br|hr|video|audio|iframe|svg|canvas|select|html|head|body|script|style|meta|link)$/i.test(el.tagName),
      attrs, styles: Object.fromEntries(STYLE.map((k) => [k, cs[k]])),
      inline: el.getAttribute('style') || '',
      rules: rulesFor(el), page: location.pathname + location.hash
    };
  }

  function choose(el) {
    sel = el;
    redraw();
    send({ type: 'pick', info: info(el) });
  }

  function setOn(v) {
    on = v;
    document.documentElement.classList.toggle('__dm-inspecting', on);
    if (!on) hover = null;
    redraw();
  }

  // Inspect mode: catch the mouse before the page does, so buttons/links don't fire.
  const block = (e) => { if (!on || isUi(e.target) || editingText) return; e.preventDefault(); e.stopPropagation(); };
  addEventListener('mousemove', (e) => {
    if (!on || editingText) return;
    const el = e.target;
    if (isUi(el) || el === hover) return;
    hover = el; redraw();
  }, true);
  addEventListener('click', (e) => {
    if (!on || isUi(e.target) || editingText) return;
    e.preventDefault(); e.stopPropagation();
    choose(e.target);
  }, true);
  ['mousedown', 'mouseup', 'pointerdown', 'pointerup', 'dblclick', 'submit', 'auxclick'].forEach((t) => addEventListener(t, block, true));
  addEventListener('mouseleave', () => { hover = null; redraw(); });

  addEventListener('keydown', (e) => {
    const k = e.key.toLowerCase();
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && k === 'd') { e.preventDefault(); send({ type: 'key', key: 'inspect' }); }
    else if ((e.ctrlKey || e.metaKey) && k === 's') { e.preventDefault(); send({ type: 'key', key: 'save' }); }
    else if ((e.ctrlKey || e.metaKey) && k === 'z' && !editingText && !/^(input|textarea)$/i.test(e.target.tagName) && !e.target.isContentEditable) {
      e.preventDefault(); send({ type: 'key', key: 'undo' });
    }
    else if (e.key === 'Escape' && !editingText && on) { send({ type: 'key', key: 'inspect-off' }); }
  }, true);

  // Edit text right on the page
  function editText() {
    if (!sel) return;
    const el = sel;
    editingText = true;
    const before = el.innerHTML;
    el.setAttribute('contenteditable', 'true');
    el.classList.add('__dm-editing');
    el.focus();
    const r = document.createRange(); r.selectNodeContents(el);
    const s = getSelection(); s.removeAllRanges(); s.addRange(r);
    const finish = (keep) => {
      el.removeEventListener('keydown', onKey, true);
      el.removeEventListener('blur', onBlur, true);
      el.removeAttribute('contenteditable');
      el.classList.remove('__dm-editing');
      if (!el.getAttribute('class')) el.removeAttribute('class');
      editingText = false;
      if (!keep) { el.innerHTML = before; send({ type: 'text-cancel' }); return; }
      const clean = el.innerHTML.replace(/\sdata-dm="\d+"/g, '').replace(/\scontenteditable="[^"]*"/g, '');
      send({ type: 'text-done', html: clean, plain: el.children.length === 0, text: el.textContent });
      redraw();
    };
    const onKey = (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); e.stopPropagation(); finish(true); }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false); }
    };
    const onBlur = () => finish(true);
    el.addEventListener('keydown', onKey, true);
    el.addEventListener('blur', onBlur, true);
    send({ type: 'text-start' });
  }

  addEventListener('message', (e) => {
    if (e.source !== parentWin || !e.data || !e.data.dm) return;
    const m = e.data;
    if (m.type === 'inspect') setOn(!!m.on);
    else if (m.type === 'select-at') {
      const el = document.querySelector(`[data-dm="${m.at}"]`);
      if (el) { choose(el); if (m.scroll) el.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
    }
    else if (m.type === 'parent' && sel && sel.parentElement && sel.parentElement !== document.documentElement) choose(sel.parentElement);
    else if (m.type === 'clear') { sel = null; redraw(); }
    else if (m.type === 'style' && sel) { sel.style[m.prop] = m.value; redraw(); }
    else if (m.type === 'set-style-attr' && sel) { if (m.value) sel.setAttribute('style', m.value); else sel.removeAttribute('style'); redraw(); }
    else if (m.type === 'attr' && sel) { if (m.value === null) sel.removeAttribute(m.name); else sel.setAttribute(m.name, m.value); redraw(); }
    else if (m.type === 'edit-text') editText();
    else if (m.type === 'remove' && sel) { sel.remove(); sel = null; redraw(); }
    else if (m.type === 'shift') {      // the code moved after a save: keep the positions right
      document.querySelectorAll('[data-dm]').forEach((el) => {
        const v = +el.getAttribute('data-dm');
        if (v > m.at) el.setAttribute('data-dm', v + m.delta);
      });
    }
    else if (m.type === 'refresh-info' && sel) send({ type: 'pick', info: info(sel), quiet: true });
    else if (m.type === 'scroll') scrollTo(0, m.y || 0);
  });

  const where = () => send({ type: 'loc', href: location.href, title: document.title });
  addEventListener('hashchange', where);
  addEventListener('popstate', where);
  addEventListener('load', () => { where(); send({ type: 'ready' }); });
  addEventListener('beforeunload', () => send({ type: 'leaving', y: scrollY }));
  where();
})();

// Counts page loads, section clicks, forms started, form submits, and call-button taps.
// A name, phone, or email is sent only when the person hits submit.
(function () {
  var tag = document.currentScript;
  if (!tag) return;
  // data-business is optional: without it, the CRM matches this site by its domain (plug and play).
  var business = tag.getAttribute('data-business') || '';
  var endpoint = tag.getAttribute('data-endpoint') || 'https://forever-gold-crm.forevergoldai.workers.dev/api/collect';
  var key = 'fg_visitor';
  var id = '';
  try { id = localStorage.getItem(key) || ''; } catch (error) { id = ''; }
  if (!/^[A-Za-z0-9-]{8,80}$/.test(id)) {
    id = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : ('v' + Date.now().toString(36) + Math.random().toString(36).slice(2, 12));
    try { localStorage.setItem(key, id); } catch (error) { /* a private browser still counts the hit */ }
  }
  var started = false;
  var submitted = false;
  function pathOf(url) {
    try {
      var parsed = new URL(url, location.href);
      if (parsed.origin !== location.origin) return '';
      var path = parsed.pathname || '/';
      if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
      if (path.endsWith('/index.html')) path = path.slice(0, -11) || '/';
      if (path === '/index.html') path = '/';
      return path || '/';
    } catch (error) {
      return '';
    }
  }
  function send(kind, path, label, contact) {
    var payload = {
      business: business,
      kind: kind,
      path: path || '/',
      label: String(label || '').replace(/\s+/g, ' ').trim().slice(0, 60),
      visitor: id,
    };
    if (contact && (contact.name || contact.phone || contact.email)) payload.contact = contact;
    var body = JSON.stringify(payload);
    try {
      if (navigator.sendBeacon && navigator.sendBeacon(endpoint, new Blob([body], { type: 'text/plain' }))) return;
    } catch (error) { /* fall through to fetch */ }
    fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: body,
      keepalive: true,
      mode: 'cors',
    }).catch(function () {});
  }
  function here() { return pathOf(location.href); }
  function words(node) { return (node && node.textContent ? node.textContent : '').replace(/\s+/g, ' ').trim(); }
  function fieldsOf(form) {
    return Array.prototype.filter.call(form.querySelectorAll('input, textarea, select'), function (input) {
      var type = (input.type || '').toLowerCase();
      if (type === 'hidden' || type === 'password' || type === 'submit' || type === 'button' || type === 'checkbox' || type === 'radio') return false;
      if (input.tabIndex === -1) return false;
      var hint = ((input.name || '') + ' ' + (input.id || '')).toLowerCase();
      if (hint.indexOf('honey') !== -1 || hint.indexOf('bb_check') !== -1 || hint.indexOf('company') !== -1) return false;
      return true;
    });
  }
  function byHint(fields, test) {
    for (var i = 0; i < fields.length; i++) {
      var input = fields[i];
      var hint = ((input.name || '') + ' ' + (input.id || '') + ' ' + (input.getAttribute('autocomplete') || '') + ' ' + (input.type || '')).toLowerCase();
      if (test(hint, input)) return String(input.value || '').replace(/\s+/g, ' ').trim();
    }
    return '';
  }
  function contactOf(form) {
    var fields = fieldsOf(form);
    var first = byHint(fields, function (hint) {
      return hint.indexOf('given-name') !== -1 || hint.indexOf('firstname') !== -1 || hint.indexOf('first_name') !== -1 || hint.indexOf('first-name') !== -1;
    });
    var last = byHint(fields, function (hint) {
      return hint.indexOf('family-name') !== -1 || hint.indexOf('lastname') !== -1 || hint.indexOf('last_name') !== -1 || hint.indexOf('last-name') !== -1;
    });
    var name = (first + ' ' + last).replace(/\s+/g, ' ').trim();
    if (!name) {
      name = byHint(fields, function (hint, input) {
        return (input.type || '').toLowerCase() !== 'email' && hint.indexOf('email') === -1 && hint.indexOf('name') !== -1;
      });
    }
    var phone = byHint(fields, function (hint, input) {
      return (input.type || '').toLowerCase() === 'tel' || hint.indexOf('phone') !== -1;
    });
    var email = byHint(fields, function (hint, input) {
      return (input.type || '').toLowerCase() === 'email' || hint.indexOf('email') !== -1;
    });
    return { name: name.slice(0, 80), phone: phone.slice(0, 20), email: email.slice(0, 80) };
  }
  send('visit', here(), document.title);
  document.addEventListener('click', function (event) {
    var node = event.target && event.target.closest ? event.target : null;
    if (!node || !node.closest) return;
    var link = node.closest('a');
    if (link && link.href && link.href.indexOf('tel:') === 0) {
      send('call', here(), 'Call');
      return;
    }
    var tab = node.closest('.picker-tab, [role="tab"]');
    if (tab) {
      var tabName = words(tab).slice(0, 40) || 'Tab';
      send('click', here() + '#' + tabName, tabName);
      return;
    }
    if (!link) return;
    var href = link.getAttribute('href') || '';
    if (href.charAt(0) === '#' && href.length > 1) {
      var hashName = words(link).slice(0, 40) || href.slice(1, 41);
      send('click', here() + '#' + hashName, hashName);
      return;
    }
    if (link.closest('header, nav, footer')) {
      var dest = pathOf(link.href);
      if (dest) send('click', dest, words(link).slice(0, 40));
    }
  }, true);
  document.addEventListener('input', function (event) {
    var form = event.target && event.target.form;
    if (!form || submitted) return;
    if (fieldsOf(form).some(function (input) { return String(input.value || '').trim(); })) started = true;
  }, true);
  document.addEventListener('submit', function (event) {
    var form = event.target;
    if (!form || !form.tagName || form.tagName !== 'FORM') return;
    submitted = true;
    send('form', here(), 'Form', contactOf(form));
  }, true);
  window.addEventListener('pagehide', function () {
    if (started && !submitted) send('form_start', here(), 'Started');
  });
}());

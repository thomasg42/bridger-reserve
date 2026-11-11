// Forever Gold CRM loader. Each FGA site carries this tiny file as fg-collect.js. The counting code itself lives on
// the CRM Worker (/fg.js), so every upgrade reaches every site without republishing any of them.
// Keep data-business on the site's tag if it has one; the Worker can also tell the business from the domain.
(function () {
  var tag = document.currentScript;
  if (!tag || window.__fgTracker) return;
  var script = document.createElement('script');
  script.src = tag.getAttribute('data-src') || 'https://forever-gold-crm.forevergoldai.workers.dev/fg.js';
  script.async = true;
  var business = tag.getAttribute('data-business');
  var endpoint = tag.getAttribute('data-endpoint');
  if (business) script.setAttribute('data-business', business);
  if (endpoint) script.setAttribute('data-endpoint', endpoint);
  (document.head || document.documentElement).appendChild(script);
}());

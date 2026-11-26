/* Tracking próprio — A Oração Perdida (a-oracao-perdida.pages.dev)
   Fica no topo do <head>, antes de qualquer outro script.
   1) Cria um ID de visitante (vid) e coloca no endereço como sck=...; o player (GG's turb) repassa os parâmetros
      da página para o botão da oferta e a Cakto devolve o sck no webhook da venda (data.sck).
      É assim que a compra encontra os dados de navegação de quem clicou no anúncio.
   2) Guarda fbp, fbc (do fbclid do anúncio) e UTMs.
   3) Manda PageView, ViewContent e InitiateCheckout para /api/evento (servidor -> API de Conversões).
   MODO 'sombra': não dispara o pixel do navegador; o servidor só grava.
   MODO 'live':   também dispara o pixel no navegador com o mesmo event_id (o Meta deduplica).
   Abrir a página com ?mvteste=1 marca os eventos desta aba como teste (vão para Eventos de Teste). */
(function () {
  // ===== CONFIGURAÇÃO DA OFERTA =====
  var MODO = 'live';                         // 'live' desde 26/11/2026 ('sombra' para voltar atrás)
  var PIXEL = '1048248480917006';            // Pixel religião (BM MA)
  var PRODUTO = 'A Oração Perdida';          // content_name
  var VALOR = 97;                            // valor do produto da frente (BRL)
  var PARAM_VID = 'sck';                     // parâmetro que leva o vid até o checkout (a Cakto devolve em data.sck)
  var CHECKOUT = /pay\.cakto\.com\.br/i;  // links de checkout (IC e garantia do vid no link)
  var API = '/api/evento';
  // ==================================

  function ck(n) {
    var m = document.cookie.match(new RegExp('(?:^|; )' + n + '=([^;]*)'));
    return m ? decodeURIComponent(m[1]) : '';
  }
  function setCk(n, v, dias) {
    try { document.cookie = n + '=' + encodeURIComponent(v) + '; Max-Age=' + Math.round(dias * 86400) + '; Path=/; SameSite=Lax; Secure'; } catch (e) {}
  }
  function ls(n, v) {
    try {
      if (v === undefined) return localStorage.getItem(n) || '';
      localStorage.setItem(n, v);
    } catch (e) {}
    return '';
  }
  function rnd(n) {
    var a = 'abcdefghijklmnopqrstuvwxyz0123456789', s = '', c = null;
    try { c = crypto.getRandomValues(new Uint8Array(n)); } catch (e) {}
    for (var i = 0; i < n; i++) s += a[(c ? c[i] : Math.floor(Math.random() * 256)) % 36];
    return s;
  }

  var url;
  try { url = new URL(location.href); } catch (e) { return; }
  var q = url.searchParams;
  var TESTE = false;
  try { if (q.get('mvteste') === '1') sessionStorage.setItem('mv_teste', '1'); TESTE = sessionStorage.getItem('mv_teste') === '1'; } catch (e) {}
  var VID_OK = /^mv[a-z0-9]{16,40}$/;

  // 1) visitante: cookie próprio > localStorage > parâmetro do link > novo
  var vid = ck('_mvid') || ls('mv_vid');
  if (!VID_OK.test(vid)) vid = VID_OK.test(q.get(PARAM_VID) || '') ? q.get(PARAM_VID) : 'mv' + Date.now().toString(36) + rnd(12);
  setCk('_mvid', vid, 400);
  ls('mv_vid', vid);
  if (q.get(PARAM_VID) !== vid) {
    q.set(PARAM_VID, vid);
    try { history.replaceState(history.state, '', url.pathname + '?' + q.toString() + url.hash); } catch (e) {}
  }

  // 2) fbp e fbc
  var fbp = ck('_fbp');
  if (!/^fb\.\d\.\d+\.\d+/.test(fbp)) {
    fbp = 'fb.1.' + Date.now() + '.' + Math.floor(1e9 + Math.random() * 9e9);
    setCk('_fbp', fbp, 90);
  }
  var fbc = ck('_fbc');
  var fbclid = q.get('fbclid');
  if (fbclid && (!fbc || fbc.split('.').slice(3).join('.') !== fbclid)) {
    fbc = 'fb.1.' + Date.now() + '.' + fbclid;
    setCk('_fbc', fbc, 90);
  }

  // UTMs: as da visita atual; se não tiver, as últimas guardadas
  var NOMES = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'];
  var utm = {}, tem = false;
  NOMES.forEach(function (k) { var v = q.get(k); if (v) { utm[k] = v.slice(0, 250); tem = true; } });
  if (tem) ls('mv_utm', JSON.stringify(utm));
  else { try { utm = JSON.parse(ls('mv_utm') || '{}') || {}; } catch (e) { utm = {}; } }

  // pixel do navegador (só no modo live)
  if (MODO === 'live') {
    !function (f, b, e, v, n, t, s) {
      if (f.fbq) return; n = f.fbq = function () { n.callMethod ? n.callMethod.apply(n, arguments) : n.queue.push(arguments); };
      if (!f._fbq) f._fbq = n; n.push = n; n.loaded = !0; n.version = '2.0'; n.queue = [];
      t = b.createElement(e); t.async = !0; t.src = v; s = b.getElementsByTagName(e)[0]; s.parentNode.insertBefore(t, s);
    }(window, document, 'script', 'https://connect.facebook.net/en_US/fbevents.js');
    fbq('init', PIXEL, { external_id: vid });
  }

  // 3) envio de eventos (navegador + servidor com o mesmo event_id)
  function enviar(nome, dados) {
    var id = nome.slice(0, 3).toLowerCase() + '.' + vid.slice(-6) + '.' + Date.now().toString(36) + rnd(4);
    if (MODO === 'live' && window.fbq) { try { fbq('track', nome, dados || {}, { eventID: id }); } catch (e) {} }
    var corpo = JSON.stringify({
      ev: nome, id: id, vid: vid, url: location.href, ref: document.referrer || '',
      fbp: ck('_fbp') || fbp, fbc: ck('_fbc') || fbc, utm: utm, dados: dados || {}, teste: TESTE
    });
    try {
      if (navigator.sendBeacon && navigator.sendBeacon(API, new Blob([corpo], { type: 'application/json' }))) return;
    } catch (e) {}
    try { fetch(API, { method: 'POST', body: corpo, headers: { 'content-type': 'application/json' }, keepalive: true, credentials: 'same-origin' }); } catch (e) {}
  }

  enviar('PageView');
  enviar('ViewContent', { content_name: PRODUTO, content_type: 'product' });

  // InitiateCheckout no clique de qualquer link de checkout (inclusive dentro de shadow DOM),
  // garantindo que o link leve o vid do visitante.
  var ultimoIC = 0;
  function eCheckout(a) {
    try {
      var h = a.getAttribute('href') || '';
      if (!CHECKOUT.test(h)) return false;
      var u = new URL(h, location.href);
      if (u.searchParams.get(PARAM_VID) !== vid) { u.searchParams.set(PARAM_VID, vid); a.setAttribute('href', u.toString()); }
      return true;
    } catch (e) { return false; }
  }
  document.addEventListener('click', function (e) {
    var caminho = e.composedPath ? e.composedPath() : [e.target];
    for (var i = 0; i < caminho.length; i++) {
      var el = caminho[i];
      if (el && el.tagName === 'A' && eCheckout(el)) {
        if (Date.now() - ultimoIC > 5000) {
          ultimoIC = Date.now();
          enviar('InitiateCheckout', { content_name: PRODUTO, content_type: 'product', currency: 'BRL', value: VALOR });
        }
        break;
      }
    }
  }, true);

  window.mvTrack = { vid: vid, modo: MODO, teste: TESTE, enviar: enviar };
})();

/* Tracking próprio: recebe os eventos da página (mvt.js), guarda o visitante no D1
   e repassa o evento para a API de Conversões da Meta.
   Configuração no Cloudflare Pages (Settings > Variables and secrets / Bindings), ambiente Production:
     META_PIXEL_ID     ID do pixel/conjunto de dados (Pixel religião)
     META_CAPI_TOKEN   token da API de Conversões (segredo — quem cola é o usuário)
     TRACK_MODE        'live' = envia para o Meta. Qualquer outro valor = sombra: só grava no banco
     META_TEST_CODE    código dos Eventos de Teste. Fora do live, só eventos marcados como teste
                       (página aberta com ?mvteste=1) vão para o Meta, com esse código.
                       Atenção: o Meta processa como REAL um evento com código de teste se a aba
                       "Eventos de teste" não estiver aberta.
     SITE_HOSTS        opcional: outros domínios aceitos, separados por vírgula
     META_API_VERSION  opcional (padrão v25.0)
     DB                binding do D1 (a-oracao-perdida-tracking)
   Variáveis novas só valem depois de um novo deploy. */

const VERSAO = 'v25.0';
const EVENTOS = ['PageView', 'ViewContent', 'InitiateCheckout'];
const VID_OK = /^mv[a-z0-9]{16,40}$/;

async function sha(v) {
  if (v === undefined || v === null || String(v).trim() === '') return undefined;
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(v).trim().toLowerCase()));
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('');
}

function semAcento(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '');
}

function limpar(obj) {
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    if (v === undefined || v === null || v === '' || (Array.isArray(v) && !v.filter(Boolean).length)) delete obj[k];
    else if (Array.isArray(v)) obj[k] = v.filter(Boolean);
  }
  return obj;
}

function hostAceito(host, request, env) {
  const proprio = new URL(request.url).hostname;
  const lista = [proprio].concat(String(env.SITE_HOSTS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean));
  return lista.some(h => host === h || host.endsWith('.' + h));
}

async function registrar(env, origem, ok, detalhe) {
  if (!env.DB) return;
  try {
    await env.DB.prepare('INSERT INTO log (em, origem, ok, detalhe) VALUES (?1, ?2, ?3, ?4)')
      .bind(Math.floor(Date.now() / 1000), origem, ok ? 1 : 0, String(detalhe || '').slice(0, 600)).run();
    if (Math.random() < 0.05) await env.DB.prepare('DELETE FROM log WHERE id < (SELECT MAX(id) - 2000 FROM log)').run();
  } catch (e) { console.log('log', e.message); }
}

// modo: 'live' (produção), 'teste' (vai com test_event_code) ou 'sombra' (não envia)
function modoDoEnvio(env, marcadoTeste) {
  if (env.TRACK_MODE === 'live') return 'live';
  if (marcadoTeste && env.META_TEST_CODE) return 'teste';
  return 'sombra';
}

async function enviarMeta(env, eventos, modo) {
  if (modo === 'sombra') return { ok: true, enviado: false, resposta: 'sombra: gravado, não enviado' };
  if (!env.META_CAPI_TOKEN || !env.META_PIXEL_ID) return { ok: false, resposta: 'sem META_CAPI_TOKEN ou META_PIXEL_ID' };
  const live = modo === 'live';
  const corpo = { data: eventos };
  if (!live) corpo.test_event_code = env.META_TEST_CODE;
  const endpoint = `https://graph.facebook.com/${env.META_API_VERSION || VERSAO}/${env.META_PIXEL_ID}/events?access_token=${encodeURIComponent(env.META_CAPI_TOKEN)}`;
  try {
    const r = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(corpo) });
    return { ok: r.ok, enviado: true, resposta: (live ? '' : '[teste] ') + r.status + ' ' + (await r.text()).slice(0, 400) };
  } catch (e) {
    return { ok: false, resposta: 'falha de rede: ' + e.message };
  }
}

function cookie(nome, valor, dias) {
  return `${nome}=${encodeURIComponent(valor)}; Max-Age=${dias * 86400}; Path=/; SameSite=Lax; Secure`;
}

export async function onRequestPost({ request, env, waitUntil }) {
  const vazio = new Response(null, { status: 204 });
  let d;
  try { d = JSON.parse(await request.text()); } catch (e) { return vazio; }
  if (!d || !EVENTOS.includes(d.ev) || !VID_OK.test(d.vid || '')) return vazio;
  let pagina;
  try { pagina = new URL(d.url); } catch (e) { return vazio; }
  if (!hostAceito(pagina.hostname, request, env)) return vazio;

  const ip = request.headers.get('CF-Connecting-IP') || '';
  const ua = (request.headers.get('User-Agent') || '').slice(0, 500);
  const cf = request.cf || {};
  const agora = Math.floor(Date.now() / 1000);
  const utm = d.utm && typeof d.utm === 'object' ? d.utm : {};
  const u = k => (typeof utm[k] === 'string' && utm[k] ? utm[k].slice(0, 250) : null);
  const fbp = /^fb\.\d\.\d+\.\d+/.test(d.fbp || '') ? String(d.fbp).slice(0, 120) : null;
  const fbc = /^fb\.\d\.\d+\.\S+/.test(d.fbc || '') ? String(d.fbc).slice(0, 600) : null;
  const pais = (cf.country || '').toLowerCase() || null;
  const estado = (cf.regionCode || '').toLowerCase() || null;
  const cidade = semAcento(cf.city || '').toLowerCase().replace(/[^a-z]/g, '') || null;
  const url = pagina.toString().slice(0, 1000);

  const salvar = env.DB ? env.DB.prepare(
    `INSERT INTO visitantes (vid, fbp, fbc, ip, ua, url, utm_source, utm_medium, utm_campaign, utm_content, utm_term, pais, estado, cidade, cep, criado_em, atualizado_em)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, NULL, ?15, ?15)
     ON CONFLICT(vid) DO UPDATE SET
       fbp = COALESCE(excluded.fbp, fbp), fbc = COALESCE(excluded.fbc, fbc),
       ip = excluded.ip, ua = excluded.ua, url = excluded.url,
       utm_source = COALESCE(excluded.utm_source, utm_source), utm_medium = COALESCE(excluded.utm_medium, utm_medium),
       utm_campaign = COALESCE(excluded.utm_campaign, utm_campaign), utm_content = COALESCE(excluded.utm_content, utm_content),
       utm_term = COALESCE(excluded.utm_term, utm_term),
       pais = COALESCE(excluded.pais, pais), estado = COALESCE(excluded.estado, estado), cidade = COALESCE(excluded.cidade, cidade),
       atualizado_em = excluded.atualizado_em`
  ).bind(d.vid, fbp, fbc, ip, ua, url, u('utm_source'), u('utm_medium'), u('utm_campaign'), u('utm_content'), u('utm_term'), pais, estado, cidade, agora).run()
    .catch(e => registrar(env, 'db', false, e.message)) : Promise.resolve();

  const dados = d.dados && typeof d.dados === 'object' ? d.dados : {};
  const custom = limpar({
    content_name: typeof dados.content_name === 'string' ? dados.content_name.slice(0, 120) : undefined,
    content_type: typeof dados.content_type === 'string' ? dados.content_type.slice(0, 30) : undefined,
    currency: dados.currency === 'BRL' ? 'BRL' : undefined,
    value: typeof dados.value === 'number' && dados.value > 0 && dados.value < 10000 ? dados.value : undefined
  });
  const evento = limpar({
    event_name: d.ev,
    event_time: agora,
    event_id: typeof d.id === 'string' ? d.id.slice(0, 100) : undefined,
    action_source: 'website',
    event_source_url: url,
    referrer_url: typeof d.ref === 'string' && d.ref ? d.ref.slice(0, 1000) : undefined,
    user_data: limpar({
      client_ip_address: ip || undefined,
      client_user_agent: ua || undefined,
      fbp: fbp || undefined,
      fbc: fbc || undefined,
      external_id: [await sha(d.vid)],
      country: [await sha(pais)],
      st: [await sha(estado)],
      ct: [await sha(cidade)]
    }),
    custom_data: Object.keys(custom).length ? custom : undefined
  });

  const modo = modoDoEnvio(env, d.teste === true);
  waitUntil(Promise.all([
    salvar,
    enviarMeta(env, [evento], modo).then(r => {
      // teste: registra tudo; live: falhas e uma amostra de 2%; sombra: nada
      if (modo === 'teste' || !r.ok || (modo === 'live' && Math.random() < 0.02)) return registrar(env, 'evento:' + d.ev, r.ok, modo + ' ' + r.resposta);
    })
  ]));

  const h = new Headers({ 'cache-control': 'no-store' });
  h.append('set-cookie', cookie('_mvid', d.vid, 400));
  if (fbp) h.append('set-cookie', cookie('_fbp', fbp, 90));
  if (fbc) h.append('set-cookie', cookie('_fbc', fbc, 90));
  return new Response(null, { status: 204, headers: h });
}

export async function onRequestGet({ env }) {
  return Response.json({
    tracking: 'eventos',
    modo: env.TRACK_MODE === 'live' ? 'live' : 'sombra',
    pixel: !!env.META_PIXEL_ID,
    token: !!env.META_CAPI_TOKEN,
    codigo_teste: !!env.META_TEST_CODE,
    banco: !!env.DB
  }, { headers: { 'cache-control': 'no-store' } });
}

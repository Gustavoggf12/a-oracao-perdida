/* Tracking próprio: webhook da Cakto (compra aprovada do produto da frente) -> Purchase na API de Conversões.
   Junta os dados do comprador (e-mail, telefone, nome) com os dados de navegação do visitante
   (fbp, fbc, IP, navegador, cidade), encontrado pelo ID que a página coloca no link do checkout (sck).
   A Cakto devolve o sck em data.sck; se o visitante não for achado, usa o fbc/fbp que a própria Cakto manda.
   Configuração no Cloudflare Pages: as mesmas de functions/api/evento.js, mais
     CAKTO_CHAVE       "secret" do webhook da Cakto (segredo — quem cola é o usuário). Vem no corpo do aviso.
     POSTBACK_SEGREDO  alternativa: segredo próprio na URL do webhook (https://DOMINIO/api/compra?k=SEGREDO)
     PRODUTO_NOME      content_name da compra
     PRODUTO_CODIGO    opcional: só conta avisos que tenham esse código em algum campo (ex.: id da oferta da Cakto)
     VALOR_FRENTE      opcional: valor usado se o aviso não trouxer o preço (padrão 97)
     SITE_URL          opcional: URL da página de vendas (padrão: o próprio domínio)
   Só a oferta principal vira Purchase: upsell, downsell e order bump da Cakto (offer_type != main) são ignorados.
   O botão "Testar" da Cakto (dados de exemplo) nunca vai para o Meta.
   Fora do modo live nada vai para o Meta: a compra só é gravada com o resultado do cruzamento
   (um aviso marcado com "mv_teste": true vai como Evento de Teste). */

const VERSAO = 'v25.0';
const APROVADO = /(paid|approved|aprovad|pago|paga|complete|conclu|confirm|autoriz|finaliz)/i;
const STATUS_PAGO = /^(paid|approved|aprovad[oa]|pago)$/i;
const NEGADO = /(refund|reembols|estorn|chargeback|cancel|pend|aguard|waiting|expir|refus|recusad|negad|fail|falh|abandon|gerad|created|criad)/i;
const CLIENTE = /(customer|client|buyer|comprador|cliente|user)/i;

async function sha(v) {
  if (v === undefined || v === null || String(v).trim() === '') return undefined;
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(v).trim().toLowerCase()));
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('');
}

function limpar(obj) {
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    if (v === undefined || v === null || v === '' || (Array.isArray(v) && !v.filter(Boolean).length)) delete obj[k];
    else if (Array.isArray(v)) obj[k] = v.filter(Boolean);
  }
  return obj;
}

function folhas(obj, caminho = '', out = []) {
  if (obj && typeof obj === 'object') {
    for (const [k, v] of Object.entries(obj)) {
      const c = caminho ? caminho + '.' + k : k;
      if (v && typeof v === 'object') folhas(v, c, out); else out.push({ c, k, v });
    }
  }
  return out;
}

function paraNumero(v) {
  if (typeof v === 'number') return v;
  if (typeof v !== 'string') return NaN;
  let s = v.replace(/[^\d,.-]/g, '');
  if (/,\d{1,2}$/.test(s)) s = s.replace(/\./g, '').replace(',', '.'); else s = s.replace(/,/g, '');
  return parseFloat(s);
}

function extrair(dados, bruto, env) {
  const fs = folhas(dados);
  const str = f => typeof f.v === 'string' ? f.v.trim() : (typeof f.v === 'number' ? String(f.v) : '');
  const preferirCliente = lista => lista.find(f => CLIENTE.test(f.c)) || lista[0];

  const emails = fs.filter(f => /mail/i.test(f.k) && !/fake/i.test(f.c) && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(str(f)));
  const email = (emails.find(f => /^e?-?mail$/i.test(f.k) && CLIENTE.test(f.c)) || preferirCliente(emails) || {}).v;

  const fones = fs.filter(f => /(phone|telefone|celular|whats|fone|mobile|cel)/i.test(f.k) && str(f).replace(/\D/g, '').length >= 10);
  let tel = str(preferirCliente(fones) || { v: '' }).replace(/\D/g, '').replace(/^0+/, '');
  if (tel && !(tel.startsWith('55') && tel.length >= 12)) tel = tel.length <= 11 ? '55' + tel : tel;

  const nomes = fs.filter(f => /^(name|nome|full_?name|nome_completo|first_?name|customer_?name)$/i.test(f.k) && str(f));
  const nomeCompleto = str(preferirCliente(nomes) || { v: '' }).toLowerCase().replace(/[^\p{L}\s'-]/gu, ' ').replace(/\s+/g, ' ').trim();
  const partes = nomeCompleto ? nomeCompleto.split(' ') : [];

  const status = fs.filter(f => /(status|situac|event)/i.test(f.k) && typeof f.v === 'string').map(f => f.v).join(' ');

  // Cakto: data.id (pedido) vem antes de offer.id, product.id etc.
  const ids = fs.filter(f => /^(transaction_?(id|code)?|code|codigo|id|order_?(id|code)?|sale_?(id|code)?|pedido|invoice_?id|ref_?id)$/i.test(f.k) && str(f))
    .sort((a, b) => (/(transac|order|sale|venda|pedido|^data\.[a-z_]+$)/i.test(b.c) ? 1 : 0) - (/(transac|order|sale|venda|pedido|^data\.[a-z_]+$)/i.test(a.c) ? 1 : 0) || a.c.split('.').length - b.c.split('.').length);
  const transacao = ids.length ? str(ids[0]).slice(0, 120) : '';

  // Cakto: data.amount (valor pago) antes de data.offer.price; baseAmount e comissões ficam de fora
  const ruido = /(commission|comiss|fee|tax|taxa|frete|shipping|discount|desconto|installment|parcela|liquid|net|base|interest|juro)/i;
  const valores = fs.filter(f => /^(total|amount|price|value|valor|total_price|amount_paid|paid_amount|price_paid|full_price|preco|total_value)$/i.test(f.k) && !ruido.test(f.c))
    .sort((a, b) => (/(transac|payment|pagamento|order|venda|^data\.[a-z_]+$)/i.test(b.c) ? 1 : 0) - (/(transac|payment|pagamento|order|venda|^data\.[a-z_]+$)/i.test(a.c) ? 1 : 0));
  let valor = 0;
  for (const f of valores) {
    let n = paraNumero(f.v);
    if (!isFinite(n) || n <= 0) continue;
    if (Number.isInteger(n) && n >= 1000) n = n / 100; // centavos
    if (n >= 5 && n < 5000) { valor = Math.round(n * 100) / 100; break; }
  }
  if (!valor) valor = Number(env.VALOR_FRENTE) || 97;

  const ips = fs.filter(f => /(^|_)ip($|_)|ip_?address/i.test(f.k) && /^(\d{1,3}(\.\d{1,3}){3}|[0-9a-f]{0,4}(:[0-9a-f]{0,4}){2,7})$/i.test(str(f)));
  const uas = fs.filter(f => /(user_?agent|navegador)/i.test(f.k) && str(f).length > 20);

  const m = bruto.match(/(?:^|[^a-z0-9])(mv[a-z0-9]{16,40})(?![a-z0-9])/);
  const caminhoVid = m ? (fs.find(f => typeof f.v === 'string' && f.v.includes(m[1])) || {}).c : null;

  // a Cakto manda fbc/fbp próprios: servem de reserva se o visitante não for achado
  const fbcAviso = (fs.find(f => f.k === 'fbc' && /^fb\.\d\.\d+\.\S+/.test(str(f))) || {}).v || null;
  const fbpAviso = (fs.find(f => f.k === 'fbp' && /^fb\.\d\.\d+\.\d+/.test(str(f))) || {}).v || null;
  const tipoOferta = (fs.find(f => /^(offer_?type|tipo_?oferta)$/i.test(f.k) && typeof f.v === 'string') || {}).v || null;

  return {
    email, tel, primeiro: partes[0], sobrenome: partes.length > 1 ? partes[partes.length - 1] : undefined,
    status, transacao, valor, vid: m ? m[1] : null, caminhoVid, fbcAviso, fbpAviso, tipoOferta,
    ip: ips.length ? str(ips[0]) : null, ua: uas.length ? str(uas[0]).slice(0, 500) : null,
    caminhos: fs.map(f => f.c)
  };
}

async function registrar(env, origem, ok, detalhe) {
  if (!env.DB) return;
  try {
    await env.DB.prepare('INSERT INTO log (em, origem, ok, detalhe) VALUES (?1, ?2, ?3, ?4)')
      .bind(Math.floor(Date.now() / 1000), origem, ok ? 1 : 0, String(detalhe || '').slice(0, 600)).run();
  } catch (e) { console.log('log', e.message); }
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

export async function onRequestPost({ request, env }) {
  const bruto = await request.text();
  let dados;
  try { dados = JSON.parse(bruto); } catch (e) { dados = Object.fromEntries(new URLSearchParams(bruto)); }
  dados = dados && typeof dados === 'object' ? dados : {};
  const d = dados.data && typeof dados.data === 'object' ? dados.data : {};
  // botão "Testar" da Cakto (exemplo fixo: vem com card, pix e boleto ao mesmo tempo) ou aviso marcado como teste
  const teste = [true, 'true', 1, '1'].includes(dados.test)
    || /purchase_test|webhook_test/i.test(String(dados.event || ''))
    || (['card', 'pix', 'boleto'].filter(k => d[k] && typeof d[k] === 'object').length >= 2)
    || /(^|[.@_-])(test|teste|example|exemplo)([.@_-]|$)/i.test(String((d.customer && d.customer.email) || ''));
  const live = env.TRACK_MODE === 'live';
  const agora = Math.floor(Date.now() / 1000);
  const site = env.SITE_URL || new URL(request.url).origin + '/';

  // autenticação: "secret" da Cakto no corpo/cabeçalhos ou segredo próprio na URL (?k=)
  const segredoUrl = new URL(request.url).searchParams.get('k');
  const cabecalhos = [...request.headers.entries()].map(([, v]) => v).join('\n');
  const chaves = [env.CAKTO_CHAVE, env.CHECKOUT_CHAVE].filter(Boolean);
  const chaveOk = (!!env.POSTBACK_SEGREDO && segredoUrl === env.POSTBACK_SEGREDO) ||
    chaves.some(c => bruto.includes(c) || cabecalhos.includes(c));
  if (!chaveOk && !teste) return Response.json({ ok: false, erro: 'chave invalida' }, { status: 401 });

  const x = extrair(dados, bruto, env);

  // guarda só a estrutura do aviso (nomes dos campos, sem valores) para conferência
  if (env.DB) {
    try {
      await env.DB.prepare('INSERT INTO postbacks (recebido_em, chaves) VALUES (?1, ?2)').bind(agora, JSON.stringify({
        teste, chave: chaveOk, status: x.status.slice(0, 120), tipo: x.tipoOferta, achou_vid: !!x.vid, campo_vid: x.caminhoVid,
        tem_email: !!x.email, tem_tel: !!x.tel, tem_ip: !!x.ip, tem_ua: !!x.ua, tem_fbc: !!x.fbcAviso, transacao: !!x.transacao, valor: x.valor,
        campos: x.caminhos.slice(0, 150)
      }).slice(0, 8000)).run();
      if (Math.random() < 0.1) await env.DB.prepare('DELETE FROM postbacks WHERE id < (SELECT MAX(id) - 100 FROM postbacks)').run();
    } catch (e) { await registrar(env, 'db', false, e.message); }
  }

  // aviso de teste (dados de exemplo): nunca vai para o Meta
  if (teste) return Response.json({ ok: true, teste: true, chave: chaveOk, achou_email: !!x.email, achou_vid: !!x.vid, achou_transacao: !!x.transacao, valor: x.valor, tipo: x.tipoOferta });
  if (env.PRODUTO_CODIGO && !bruto.includes(env.PRODUTO_CODIGO)) return Response.json({ ok: true, ignorado: 'outro produto' });
  if (x.tipoOferta && !/^main$/i.test(x.tipoOferta)) return Response.json({ ok: true, ignorado: 'oferta ' + x.tipoOferta.slice(0, 20) });
  // Cakto: o status do pedido é um campo fixo (paid, waiting_payment, refused, refunded...)
  if (typeof d.status === 'string' && !STATUS_PAGO.test(d.status.trim())) return Response.json({ ok: true, ignorado: 'status ' + d.status.slice(0, 30) });
  if (x.status && NEGADO.test(x.status) && !APROVADO.test(x.status.replace(NEGADO, ''))) {
    return Response.json({ ok: true, ignorado: 'status ' + x.status.slice(0, 60) });
  }
  if (!x.email && !x.tel) return Response.json({ ok: true, ignorado: 'sem e-mail e telefone' });

  const transacao = x.transacao || ('h' + (await sha([x.email, x.tel, x.valor, new Date().toISOString().slice(0, 10)].join('|'))).slice(0, 24));
  const modo = live ? 'live' : (dados.mv_teste === true && env.META_TEST_CODE ? 'teste' : 'sombra');

  if (env.DB) {
    const ja = await env.DB.prepare('SELECT enviado, modo FROM compras WHERE transacao = ?1').bind(transacao).first().catch(() => null);
    if (ja && ja.enviado === 1 && ja.modo === modo) return Response.json({ ok: true, duplicada: true });
  }

  // visitante: pelo vid que veio no link (sck); se não vier, pelo IP do comprador (últimos 3 dias)
  let vis = null;
  if (env.DB && x.vid) vis = await env.DB.prepare('SELECT * FROM visitantes WHERE vid = ?1').bind(x.vid).first().catch(() => null);
  if (env.DB && !vis && x.ip) vis = await env.DB.prepare('SELECT * FROM visitantes WHERE ip = ?1 AND atualizado_em > ?2 ORDER BY atualizado_em DESC LIMIT 1').bind(x.ip, agora - 3 * 86400).first().catch(() => null);

  const ua = (vis && vis.ua) || x.ua;
  const produto = env.PRODUTO_NOME || 'Produto';
  const evento = limpar({
    event_name: 'Purchase',
    event_time: agora,
    event_id: 'compra.' + transacao,
    action_source: ua ? 'website' : 'other',
    event_source_url: ua ? ((vis && vis.url) || site) : undefined,
    user_data: limpar({
      em: [await sha(x.email)],
      ph: [await sha(x.tel)],
      fn: [await sha(x.primeiro)],
      ln: [await sha(x.sobrenome)],
      external_id: [await sha(vis ? vis.vid : x.vid)],
      client_ip_address: (vis && vis.ip) || x.ip || undefined,
      client_user_agent: ua || undefined,
      fbp: (vis && vis.fbp) || x.fbpAviso || undefined,
      fbc: (vis && vis.fbc) || x.fbcAviso || undefined,
      country: [await sha((vis && vis.pais) || 'br')],
      st: [await sha(vis && vis.estado)],
      ct: [await sha(vis && vis.cidade)]
    }),
    custom_data: { currency: 'BRL', value: x.valor, content_name: produto, content_type: 'product', order_id: transacao }
  });

  const r = await enviarMeta(env, [evento], modo);
  await registrar(env, 'compra', r.ok, `${modo} vid:${x.vid ? 'sim' : 'nao'} visitante:${vis ? 'sim' : 'nao'} fbc:${(vis && vis.fbc) || x.fbcAviso ? 'sim' : 'nao'} ${r.resposta}`);

  if (env.DB) {
    await env.DB.prepare(`INSERT INTO compras (transacao, vid, produto, valor, status, achou_visitante, enviado, modo, resposta, criado_em)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
      ON CONFLICT(transacao) DO UPDATE SET vid = excluded.vid, achou_visitante = excluded.achou_visitante, enviado = excluded.enviado,
        modo = excluded.modo, resposta = excluded.resposta, criado_em = excluded.criado_em`)
      .bind(transacao, (vis && vis.vid) || x.vid, produto, x.valor, x.status.slice(0, 80), vis ? 1 : 0, r.enviado && r.ok ? 1 : 0, modo, r.resposta.slice(0, 500), agora)
      .run().catch(e => registrar(env, 'db', false, e.message));
  }

  // 200 mesmo se o Meta falhar, para a Cakto não ficar reenviando; a falha fica no log
  return Response.json({ ok: r.ok, modo, enviado: !!r.enviado, achou_vid: !!x.vid, achou_visitante: !!vis, tem_fbc: !!((vis && vis.fbc) || x.fbcAviso) });
}

export async function onRequestGet({ env }) {
  return Response.json({
    tracking: 'compras',
    modo: env.TRACK_MODE === 'live' ? 'live' : 'sombra',
    pixel: !!env.META_PIXEL_ID,
    token: !!env.META_CAPI_TOKEN,
    codigo_teste: !!env.META_TEST_CODE,
    autenticacao: !!(env.CAKTO_CHAVE || env.CHECKOUT_CHAVE || env.POSTBACK_SEGREDO),
    banco: !!env.DB
  }, { headers: { 'cache-control': 'no-store' } });
}

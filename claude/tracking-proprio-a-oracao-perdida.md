# Tracking próprio — A Oração Perdida

Mesmo modelo da Frequência Restauradora (repo `memoria-viva`): cada visitante ganha um ID próprio (`mv...`)
que vai no `sck` do link até a Cakto e volta no webhook da venda (`data.sck`). A página manda PageView,
ViewContent e InitiateCheckout pelo servidor (API de Conversões) e, no modo live, também pelo navegador com o
mesmo `event_id`. A venda vira um Purchase com e-mail, telefone e nome do comprador, mais os dados do clique
(fbc, fbp, IP, navegador, cidade). A Utmify fica só com UTMs e dashboard. A pasta `claude/` não é servida no
site (`functions/claude/[[path]].js` devolve 404).

## Estado

- **Modo: sombra** desde 26/11/2026 (`TRACK_MODE=sombra` e `MODO = 'sombra'` no `mvt.js`). Nada vai para o Meta,
  a não ser eventos marcados como teste (`?mvteste=1`) com a aba Eventos de teste aberta.
- Pixel **Pixel religião** `1048248480917006` (proprietário BM MA, compartilhado com a Conta MA04).
  Era novo e nunca tinha recebido evento. Não tem lista de permissão nem de bloqueio de domínios.
- Ninguém mais manda eventos para esse pixel: nenhum pixel da Utmify aponta para ele e a página não tinha script de pixel.

## Onde está cada coisa

| O quê | Onde |
|---|---|
| Página | `https://a-oracao-perdida.pages.dev/` — Cloudflare Pages, projeto `a-oracao-perdida`, deploy a cada commit no `main` |
| Banco | D1 `a-oracao-perdida-tracking`, binding `DB` (Production). Tabelas em `claude/tracking-schema.sql` |
| Página → servidor | `mvt.js` (topo do `<head>`), `functions/api/evento.js` |
| Venda → Purchase | `functions/api/compra.js` (webhook da Cakto) |
| UTMs | script de UTMs da Utmify (`latest.js`, com `data-utmify-prevent-xcod-sck` e `data-utmify-prevent-subids`): ela não mexe no `sck` |
| Player | GG's turb, player `sa88ag36q8` ("A Oração Perdida"). Revela a `.offer-section` no pitch (24:10); o botão fica na própria página. Em *Botões e oferta*, "Parâmetro da página com o ID do visitante" = `sck` (26/11): o player usa o mesmo ID do tracking |

## Variáveis no Cloudflare (Production)

Texto: `META_PIXEL_ID`, `TRACK_MODE` (`sombra`/`live`), `META_TEST_CODE`, `PRODUTO_NOME` (A Oração Perdida),
`VALOR_FRENTE` (97), `SITE_URL`.
Segredos (quem cola é o usuário; nunca anotar o valor): `META_CAPI_TOKEN`, `CAKTO_CHAVE` (o "secret" do webhook da Cakto).
Opcional: `PRODUTO_CODIGO` (id da oferta na Cakto, se o mesmo webhook mandar outros produtos).
Variável nova só vale depois de um novo deploy.

## Validação feita (26/11)

- `GET /api/evento` e `/api/compra`: modo sombra, pixel, código de teste e banco ok.
- Visita com UTMs e `fbclid`: visitante gravado no D1 com fbc, fbp, UTMs, cidade e navegador.
- Clique no botão (sem navegar): InitiateCheckout enviado ao servidor; o link leva `sck` = ID do visitante.
- Convivência com a Utmify: com e sem o `mvt.js`, o link do botão leva as mesmas UTMs (a Utmify acrescenta o
  `fbclid` no `utm_content`, como sempre faz); com o `mvt.js` aparece só o `sck` a mais.
- Testes locais (Node + SQLite simulando o D1): 29 conferências, incluindo o formato do webhook da Cakto,
  botão Testar, order bump, Pix gerado, reembolso, repetida, chave errada e venda sem `sck`.
- Token da API de Conversões colado pelo usuário (26/11) e publicado. Visita com `?mvteste=1` e a aba Eventos de
  teste aberta: PageView, ViewContent e InitiateCheckout aceitos pelo Meta (`200 {"events_received":1}` no log do D1).
  A tela nova de Eventos de teste não listou os eventos; a Visão geral seguiu sem atividade real (não viraram eventos reais).

## Pendências

1. **Cakto**: produto criado em 26/11 (ver seção Cakto abaixo). Falta o webhook do tracking (`/api/compra`) com o
   segredo `CAKTO_CHAVE` colado pelo usuário, e a ligação com a Utmify.
2. **Virada para live** (só com ok do usuário): `TRACK_MODE=live` no Cloudflare + `MODO = 'live'` no `mvt.js`
   (o commit publica). Não há nada para desligar antes (nem Utmify nem checkout mandam para esse pixel).
   Opcional: lista de permissão do pixel com `a-oracao-perdida.pages.dev` e `pay.cakto.com.br`.
3. Primeira venda: conferir log `origem='compra'` com `vid:sim visitante:sim`, linha em `compras` com
   `achou_visitante = 1`, Purchase no Gerenciador de Eventos e venda atribuída na Utmify.

## Cakto

- Produto **A Oração Perdida** (id `126bd319-18d5-4608-8d78-e2015d7ed7bc`, short `9S7fehi`), R$ 97,00, pagamento único,
  até 12x (12x de R$ 10,02 no cartão), garantia 7 dias, Pix como padrão, sem confirmação de e-mail nem campo de cupom.
- Oferta `t7cpggx` → checkout `https://pay.cakto.com.br/t7cpggx` (botão da página aponta para ele desde 26/11).
- Entrega: "Link de pagamento" (sem entrega automática, como o Grimório de São Bento); o usuário confirmou
  a declaração da Cakto de que a entrega ao comprador é responsabilidade dele.
- Suporte: gustavoggf12@gmail.com (o e-mail verificado que veio preenchido); produtor exibido: Meu Milagre.
- **Nenhum pixel na Cakto** (de propósito: IC sai da página, Purchase sai do `/api/compra`).
- A Cakto cobra do comprador uma "Taxa de serviço" de R$ 0,99 no checkout.

## Como voltar atrás

`TRACK_MODE=sombra` no Cloudflare e `MODO = 'sombra'` no `mvt.js` param os envios. Para tirar tudo, remover a linha
`<script src="/mvt.js"></script>` do `index.html` (o script de UTMs da Utmify pode ficar).

## Consultas úteis (Console do D1)

```sql
-- tráfego e qualidade (sem as visitas de teste)
SELECT count(*) visitas, sum(fbc IS NOT NULL) com_fbc, sum(utm_source IS NOT NULL) com_utm, sum(cidade IS NOT NULL) com_cidade
FROM visitantes WHERE vid NOT LIKE 'mvteste%';
-- envios e falhas
SELECT id, datetime(em,'unixepoch','-3 hours') quando, origem, ok, substr(detalhe,1,160) d FROM log ORDER BY id DESC LIMIT 20;
-- compras cruzadas
SELECT transacao, achou_visitante, enviado, modo, valor, datetime(criado_em,'unixepoch','-3 hours') quando FROM compras ORDER BY criado_em DESC LIMIT 20;
-- estrutura dos últimos webhooks
SELECT id, datetime(recebido_em,'unixepoch','-3 hours') quando, substr(chaves,1,300) FROM postbacks ORDER BY id DESC LIMIT 5;
```

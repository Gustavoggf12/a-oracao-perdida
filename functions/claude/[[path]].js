// A pasta claude/ guarda anotações internas do tracking: não é servida no site.
export function onRequest() {
  return new Response('Not found', { status: 404, headers: { 'cache-control': 'no-store' } });
}

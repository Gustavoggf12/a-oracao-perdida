CREATE TABLE IF NOT EXISTS visitantes (vid TEXT PRIMARY KEY, fbp TEXT, fbc TEXT, ip TEXT, ua TEXT, url TEXT, utm_source TEXT, utm_medium TEXT, utm_campaign TEXT, utm_content TEXT, utm_term TEXT, pais TEXT, estado TEXT, cidade TEXT, cep TEXT, criado_em INTEGER, atualizado_em INTEGER);
CREATE INDEX IF NOT EXISTS visitantes_ip ON visitantes (ip, atualizado_em);
CREATE TABLE IF NOT EXISTS compras (transacao TEXT PRIMARY KEY, vid TEXT, produto TEXT, valor REAL, status TEXT, achou_visitante INTEGER, enviado INTEGER, modo TEXT, resposta TEXT, criado_em INTEGER);
CREATE TABLE IF NOT EXISTS postbacks (id INTEGER PRIMARY KEY AUTOINCREMENT, recebido_em INTEGER, chaves TEXT);
CREATE TABLE IF NOT EXISTS log (id INTEGER PRIMARY KEY AUTOINCREMENT, em INTEGER, origem TEXT, ok INTEGER, detalhe TEXT);

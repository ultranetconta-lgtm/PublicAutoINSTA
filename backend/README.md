# Backend Rust do Instagram

O backend Axum serve o planner em `http://127.0.0.1:3000`, recebe Stories e Reels de teste em formulários multipart, mantém agendamentos em `backend/data/schedules.json` e verifica publicações vencidas a cada dois segundos.

## Configuração

As credenciais ficam somente em `api/.env` no ambiente local ou nas variáveis do deploy. O servidor lê:

- `INSTAGRAM_ACCESS_TOKEN`
- `INSTAGRAM_USER_ID`
- `INSTAGRAM_USERNAME`
- `GRAPH_API_BASE_URL` e `GRAPH_API_VERSION`
- `PUBLIC_BASE_URL`
- `HOST` e `PORT` para endereço de escuta
- `FFMPEG_BIN` opcional, se o executável não estiver no `PATH`

`PUBLIC_BASE_URL` é obrigatório para publicar e precisa ser HTTPS acessível externamente. A Meta baixa a mídia em `PUBLIC_BASE_URL/media/<arquivo>`; `localhost` não funciona nessa etapa. O backend valida a resposta HEAD e o tamanho do arquivo antes de agendar e novamente no horário de publicação.

## Executar e testar

Na raiz do repositório:

```bash
cargo run --manifest-path backend/Cargo.toml -- --host 127.0.0.1 --port 3000
```

Os testes locais usam um servidor Meta simulado e não fazem publicações reais:

```bash
cargo fmt --manifest-path backend/Cargo.toml -- --check
cargo test --manifest-path backend/Cargo.toml
cargo build --manifest-path backend/Cargo.toml --release
```

Checagens seguras depois de iniciar o backend:

```bash
curl -fsS http://127.0.0.1:3000/api/health
curl -fsS http://127.0.0.1:3000/api/schedules
```

O endpoint de health informa flags de configuração, identidade da conta e versão da API. Ele nunca retorna o token.

## Mídia e memória

O limite por requisição é 200 MiB. Campos de mídia multipart são lidos em blocos e escritos diretamente em arquivos temporários; o backend remove parciais quando o limite ou o parser rejeita o envio. Arquivos em `/media/<arquivo>` também são enviados em blocos do disco para o socket. O hash SHA-256 lê blocos de 1 MiB.

FFmpeg converte PNG para JPEG e remuxa Reels sem recodificar áudio/vídeo, com `-movflags +faststart -use_editlist 0`. Isso organiza o contêiner para a Meta; não converte codecs nem resolução incompatíveis. Falha no processamento remove somente a cópia de trabalho criada pelo backend.

## API da Meta e análises

Para um Story, o backend cria um container `STORIES` com `image_url` ou `video_url`, aguarda `status_code=FINISHED` e chama `media_publish`. Reels de teste usam `REELS` e `trial_params`; containers `ERROR` ou `EXPIRED` mantêm o ID e os detalhes devolvidos pela Meta no registro falho. Tokens não são salvos nos registros.

Antes de enviar um Reel, o backend calcula SHA-256 e recusa mídia repetida com HTTP 409. O worker também verifica duplicatas entre agendamentos vencidos.

As análises mantêm o contrato do painel: períodos `today`, `7d` e `30d`, limites diários de `America/Sao_Paulo`, `views` e `reach` reais da Meta, até cinco consultas simultâneas e cache de 20 segundos para perfil/publicações recentes. Views por Reel vêm de Insights da mídia; o backend não estima visualizações com base em curtidas. A Meta pode levar até 48 horas para consolidar alguns Insights.

## Deploy Fly.io

O Dockerfile compila um binário Rust release em uma etapa de build e executa esse binário com FFmpeg na imagem final. Fly escuta na porta 8080; os dados persistem no volume `/data`, montado em `backend/data` e `backend/uploads` para preservar os caminhos e os agendamentos atuais.

Um teste de `Publicar agora` altera a conta do Instagram. Os testes automáticos nunca enviam conteúdo à Meta.

## Versões e rollback

A release GitHub `v1.0` permanece disponível como versão anterior; `v2.0.0` identifica esta implementação Rust. Para voltar o app Fly ao código 1.0:

```bash
git switch --detach v1.0
fly deploy --remote-only --strategy immediate --app publicautoinsta-api
```

Essa operação reimplanta o código antigo usando a configuração e os secrets atuais do app. O volume `/data` não é revertido, portanto os agendamentos e uploads permanecem no estado atual.

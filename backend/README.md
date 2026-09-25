# Backend Rust do Instagram

O backend Axum serve o planner em `http://127.0.0.1:3000`, publica posts, carrosséis, Stories e Reels comuns ou de teste pela API do Instagram, mantém agendamentos em `backend/data/schedules.json` e usa um scheduler global que acorda no próximo horário, processa em paralelo entre contas e serializa por conta.

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

Tokens de usuário do Instagram de longa duração vencem em até 60 dias; a Meta não oferece uma opção sem vencimento nesse fluxo. O backend tenta renovar tokens sem data de validade conhecida ao iniciar e verifica diariamente os tokens armazenados. Após uma renovação, tenta novamente quando restarem 30 dias. O token atualizado e a nova data de vencimento são gravados em `backend/data/accounts.json` com permissão privada e passam a ser usados pelas próximas chamadas. A Meta só aceita renovar um token válido de longa duração com pelo menos 24 horas; se o token ainda for novo, a rotina tentará no dia seguinte. Tokens expirados ou revogados exigem uma nova conexão da conta. O token inicial de `api/.env` é copiado ao armazenamento privado somente quando a conta ainda não existe nele.

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

As rotas de publicação recebem `multipart/form-data` com `account_id`, `action` (`publish_now` ou `schedule`), `caption`, `scheduled_at` quando agendado e um ou mais campos `media`:

- `POST /api/posts`: uma imagem e uma legenda.
- `POST /api/carousels`: de 2 a 10 imagens e/ou vídeos. Cada campo `media` vira um item do carrossel; o primeiro arquivo é a capa.
- `POST /api/reels`: um vídeo. O padrão é Reel comum publicado no Feed; envie `publication_type=test_reel` explicitamente para o fluxo separado de Reel de teste.
- `POST /api/stories`: uma imagem ou vídeo.

Posts, Reels e Stories criam um container, aguardam `status_code=FINISHED` e chamam `media_publish`. O carrossel cria containers para cada item, espera todos ficarem prontos, cria o container principal e publica o conjunto. Reels de teste usam `trial_params`; containers `ERROR` ou `EXPIRED` mantêm o ID e os detalhes devolvidos pela Meta no registro falho. Tokens não são salvos nos registros.

Antes de enviar um Reel, o backend calcula SHA-256 e recusa mídia repetida com HTTP 409. O worker também verifica duplicatas entre agendamentos vencidos.

As análises mantêm o contrato do painel: períodos `today`, `7d` e `30d`, limites diários de `America/Sao_Paulo`, `views` e `reach` reais da Meta, até cinco consultas simultâneas e cache de 20 segundos para perfil/publicações recentes. Views por Reel vêm de Insights da mídia; o backend não estima visualizações com base em curtidas. A Meta pode levar até 48 horas para consolidar alguns Insights.

O plugin local `Instagram Resumos` pode consultar `GET /api/plugin/health` e `GET /api/plugin/summary?days=7` pela URL HTTPS do deploy. Configure `PLUGIN_API_KEY` como secret independente tanto no app Fly quanto no ambiente privado do plugin; ambas as rotas exigem `Authorization: Bearer <PLUGIN_API_KEY>`, são somente leitura e aceitam `days=1`, `7` ou `30`. O token da Meta não é enviado ao plugin.

O callback do Instagram é `https://publicautoinsta-api.fly.dev/webhooks/instagram`. `GET` sem parâmetros mostra uma mensagem de status; a verificação da Meta devolve `hub.challenge` em texto puro quando `hub.mode=subscribe` e `META_WEBHOOK_VERIFY_TOKEN` correspondem. Para receber notificações do caso de uso Instagram, configure `META_APP_SECRET` com o valor de “Chave secreta do app do Instagram” exibido nas configurações desse caso de uso no Meta. Os `POST` validam `X-Hub-Signature-256`, aceitam payloads `object=instagram` até 256 KiB e registram apenas quantidade de entradas/campos, sem armazenar o conteúdo dos comentários.

Na aba **Comentários**, cada comentário tem um campo de resposta. O envio usa `POST /api/comments/{comment_id}/reply` e a permissão `instagram_business_manage_comments` (Instagram Login) ou `instagram_manage_comments` (Facebook Login). A mensagem só é enviada quando o usuário pressiona **Enviar resposta**.

A política de privacidade pública do app está disponível em `GET /privacy-policy` no domínio HTTPS do deploy.

## Deploy Fly.io

O Dockerfile compila um binário Rust release em uma etapa de build e executa esse binário com FFmpeg na imagem final. Fly escuta na porta 8080; os dados persistem no volume `/data`, montado em `backend/data` e `backend/uploads` para preservar os caminhos e os agendamentos atuais.

Um teste de `Publicar agora` altera a conta do Instagram. Os testes automáticos nunca enviam conteúdo à Meta.

## Versões e rollback

A release GitHub `v1.0` permanece disponível como versão anterior; `v2.0.0` identifica a migração para Rust, `v2.1.0` adiciona publicação independente por conta, `v2.2.0` reúne renovação automática de tokens e melhorias de Reels e perfis, e `v2.3.0` acrescenta comentários paginados com respostas em lote, webhook Instagram assinado e endpoint público para a política de privacidade. Para voltar o app Fly ao código 1.0:

```bash
git switch --detach v1.0
fly deploy --remote-only --strategy immediate --app publicautoinsta-api
```

Essa operação reimplanta o código antigo usando a configuração e os secrets atuais do app. O volume `/data` não é revertido, portanto os agendamentos e uploads permanecem no estado atual.

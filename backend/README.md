# Instagram Story backend

O backend serve o planner em `http://127.0.0.1:3000`, recebe imagens JPG e vídeos MP4 em `POST /api/stories`, persiste agendamentos em `backend/data/schedules.json` e executa Stories vencidos em um worker local.

## Configuração

As credenciais ficam somente em `api/.env`. O servidor lê:

- `INSTAGRAM_ACCESS_TOKEN`
- `INSTAGRAM_USER_ID`
- `INSTAGRAM_USERNAME`
- `GRAPH_API_BASE_URL` e `GRAPH_API_VERSION`
- `PUBLIC_BASE_URL`

`PUBLIC_BASE_URL` é obrigatório para publicar. Deve ser uma origem HTTPS acessível externamente, normalmente uma URL de deploy ou túnel apontando para a porta do backend. O Meta precisa baixar a mídia por `PUBLIC_BASE_URL/media/<arquivo>`; `localhost` não funciona para essa etapa.

## Executar

```bash
python3 backend/server.py --host 127.0.0.1 --port 3000
```

Verificações seguras:

```bash
curl -fsS http://127.0.0.1:3000/api/health
curl -fsS http://127.0.0.1:3000/api/schedules
```

O endpoint de health informa apenas flags de configuração, identidade da conta e versão da API. Ele nunca retorna o token.

## Fluxo Meta

Para um Story, o backend cria um container `STORIES` com `image_url` ou `video_url`, aguarda `status_code=FINISHED` e chama `media_publish`. O agendamento é local; no horário configurado, o worker executa o mesmo fluxo. A conta profissional e o app Meta precisam ter a permissão vigente de publicação de conteúdo.

Um teste real de `Publicar agora` altera a conta do Instagram e deve ser feito somente com a mídia e o horário autorizados pelo usuário naquele momento.

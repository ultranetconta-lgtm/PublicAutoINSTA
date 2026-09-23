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

Um túnel rápido `trycloudflare.com` tem URL temporária e não oferece garantia de disponibilidade. Se o túnel for encerrado, reinicie-o, atualize `PUBLIC_BASE_URL` e reinicie o backend antes de criar outros agendamentos. Para agendamentos contínuos, use uma origem HTTPS estável. A checagem de `/api/health` informa que a URL foi configurada; o teste real do arquivo público é feito ao agendar e novamente no horário da publicação.

O backend exige `ffmpeg` no `PATH` ou em `~/.local/bin/ffmpeg` para Reels. Cada vídeo recebido é remuxado sem recodificar áudio/vídeo para um MP4 de início rápido, com `moov` antes de `mdat` e sem edit list. Isso corrige a estrutura do arquivo observado neste caso; não converte codecs ou resoluções incompatíveis. Uma falha na conversão impede o agendamento e apaga apenas a cópia temporária criada pelo backend.

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

## Intervalo de consultas

As análises consultam `views` e `reach` da conta na Meta a cada abertura, troca de período ou atualização manual. Os cartões também consultam `views` e `reach` na janela móvel das últimas 24 horas; Reels publicados nessa janela são contados pelos horários retornados pela Meta. A curva de visualizações é montada com uma consulta `total_value` por dia e exibe uma média diária opcional; as métricas de cada Reel também vêm do Insights da mídia, sem estimar visualizações por curtidas. O cartão informa o horário da última consulta e deixa visível que a Meta pode levar até 48 horas para consolidar alguns Insights. A API não fornece contagens confiáveis e separadas de seguidores ganhos e perdidos, então o painel informa essa limitação em vez de exibir números estimados. Se uma consulta falhar, o painel mostra indisponibilidade e não substitui os valores por dados fictícios. Perfil e publicações recentes permanecem em memória por até 20 segundos; não existe coleta automática periódica em segundo plano.

Durante uma publicação, o backend verifica o processamento do container da Meta a cada 20 segundos por até 5 minutos. O agendador local continua acordando a cada 2 segundos para detectar publicações vencidas; essa verificação consulta apenas os dados locais e não chama a API da Meta.

## Fluxo Meta

Para um Story, o backend cria um container `STORIES` com `image_url` ou `video_url`, aguarda `status_code=FINISHED` e chama `media_publish`. O agendamento é local; no horário configurado, o worker executa o mesmo fluxo. A conta profissional e o app Meta precisam ter a permissão vigente de publicação de conteúdo.

Para Reels de teste, o backend cria um container `REELS` com `trial_params`, consulta `status_code,status` e só chama `media_publish` após `FINISHED`. Se a Meta retornar `ERROR` ou `EXPIRED`, o agendamento falho guarda o ID do contêiner e o texto de `status` retornado pela Meta. Nenhum token é salvo nesse registro.

Um teste real de `Publicar agora` altera a conta do Instagram e deve ser feito somente com a mídia e o horário autorizados pelo usuário naquele momento.

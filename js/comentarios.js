/* Aba independente de leitura e triagem dos comentários do Instagram. */
(function() {
  'use strict';

  const module = {
    includeAnswered: false,
    posts: [],
    account: null,
    commentsIncomplete: false,
    reportedComments: 0,
    retrievedComments: 0,
    requestId: 0,
    initialized: false,

    open() {
      this.bindEvents();
      this.load();
    },

    bindEvents() {
      if (this.initialized) return;
      this.initialized = true;
      document.getElementById('btnRefreshComments')?.addEventListener('click', () => this.load());
      document.getElementById('btnToggleAnsweredComments')?.addEventListener('click', () => {
        this.includeAnswered = !this.includeAnswered;
        this.updateFilterButton();
        this.render();
      });
      document.addEventListener('instagram-account-changed', () => {
        if (document.getElementById('viewComentarios')?.classList.contains('active')) this.load();
      });
    },

    updateFilterButton() {
      const button = document.getElementById('btnToggleAnsweredComments');
      if (!button) return;
      button.setAttribute('aria-pressed', String(this.includeAnswered));
      button.title = this.includeAnswered ? 'Ocultar comentários respondidos' : 'Mostrar comentários respondidos';
      button.innerHTML = `<i class="fa-regular ${this.includeAnswered ? 'fa-eye-slash' : 'fa-eye'}" aria-hidden="true"></i><span>${this.includeAnswered ? 'Ocultar respondidos' : 'Mostrar respondidos'}</span>`;
    },

    async load() {
      const accountId = window.getActiveInstagramAccountId?.() || '';
      const accountUsername = window.getActiveInstagramAccountUsername?.() || '';
      const requestId = ++this.requestId;
      const status = document.getElementById('commentsStatus');
      const refresh = document.getElementById('btnRefreshComments');
      const accountLabel = document.getElementById('commentsAccountLabel');
      const list = document.getElementById('commentsList');
      this.account = { id: accountId, username: accountUsername.replace(/^@/, '') };
      if (accountLabel) accountLabel.textContent = accountUsername ? `Publicações de @${accountUsername.replace(/^@/, '')}` : 'Comentários nas publicações da conta ativa';
      if (!accountId) {
        if (status) status.textContent = 'Conecte uma conta profissional do Instagram para buscar publicações e comentários.';
        if (list) list.replaceChildren();
        this.updateBadge(0);
        return;
      }

      if (status) status.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin" aria-hidden="true"></i> Buscando publicações e comentários no Instagram…';
      if (refresh) refresh.disabled = true;
      if (list) list.replaceChildren();
      try {
        const response = await fetch(`/api/comments?account_id=${encodeURIComponent(accountId)}`, {
          headers: { Accept: 'application/json' },
          cache: 'no-store'
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) {
          const error = new Error(payload.message || 'Não foi possível consultar os comentários da conta.');
          error.apiMessage = payload.message || '';
          throw error;
        }
        if (requestId !== this.requestId) return;
        this.account = payload.account || this.account;
        this.posts = Array.isArray(payload.posts) ? payload.posts : [];
        this.reportedComments = Number(payload.reported_comments || 0);
        this.retrievedComments = Number(payload.retrieved_comments || 0);
        const failedPublications = Number(payload.failed_publications || 0);
        const emptyCommentEdges = Number(payload.empty_comment_edges || 0);
        this.commentsIncomplete = payload.comments_incomplete === true;
        const comments = this.flattenComments();
        this.updateBadge(comments.filter(comment => !comment.answered).length);
        if (status) {
          const summary = `${this.posts.length} publicações consultadas · ${comments.length} comentários carregados · ordenados do mais recente ao mais antigo.`;
          const incompleteNote = this.commentsIncomplete
            ? ` A Meta informa ${this.reportedComments} comentários, mas devolveu ${this.retrievedComments} textos.`
            : '';
          const errorsNote = failedPublications || emptyCommentEdges
            ? ` ${failedPublications} erros de leitura e ${emptyCommentEdges} publicações retornaram comments_count positivo com /comments vazio.`
            : '';
          const errorSamples = this.posts
            .map(post => post.comments_error?.message || post.comments_warning?.message)
            .filter(Boolean)
            .slice(0, 3);
          const errorDetails = errorSamples.length ? ` Detalhes: ${errorSamples.join(' · ')}` : '';
          status.textContent = `${summary}${incompleteNote}${errorsNote}${errorDetails}`;
        }
        this.render();
      } catch (error) {
        if (requestId !== this.requestId) return;
        const permissionHelp = /permission|permiss|oauth|(#10)|(#200)/i.test(`${error.message} ${error.apiMessage || ''}`)
          ? ' Confira se o token recebeu instagram_manage_comments (Facebook Login) ou instagram_business_manage_comments (Instagram Login).'
          : '';
        if (status) status.textContent = `${error.message}${permissionHelp}`;
        this.posts = [];
        this.commentsIncomplete = false;
        this.updateBadge(0);
        this.render();
      } finally {
        if (requestId === this.requestId && refresh) refresh.disabled = false;
      }
    },

    flattenComments() {
      const rows = [];
      for (const post of this.posts) {
        for (const comment of Array.isArray(post.comments) ? post.comments : []) {
          const replies = Array.isArray(comment.replies?.data) ? comment.replies.data : (Array.isArray(comment.replies) ? comment.replies : []);
          rows.push({ post, comment, replies, answered: replies.some(reply => this.isFromActiveAccount(reply)) });
        }
      }
      return rows.sort((left, right) => this.timestamp(right.comment) - this.timestamp(left.comment));
    },

    isFromActiveAccount(item) {
      const username = String(item.username || item.from?.username || '').replace(/^@/, '').toLowerCase();
      const accountUsername = String(this.account?.username || '').replace(/^@/, '').toLowerCase();
      const authorId = String(item.from?.id || item.from?.id_str || '');
      return Boolean((accountUsername && username && username === accountUsername) || (this.account?.id && authorId && authorId === String(this.account.id)));
    },

    timestamp(item) {
      const value = item?.timestamp ? Date.parse(item.timestamp) : 0;
      return Number.isFinite(value) ? value : 0;
    },

    render() {
      const list = document.getElementById('commentsList');
      if (!list) return;
      const comments = this.flattenComments().filter(item => this.includeAnswered || !item.answered);
      list.replaceChildren();
      if (!comments.length) {
        const empty = document.createElement('div');
        empty.className = 'comentarios-empty';
        empty.innerHTML = this.commentsIncomplete
          ? `<i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i><strong>A Meta não retornou os textos dos comentários</strong><span>O contador da conta mostra ${this.reportedComments}, mas a API retornou ${this.retrievedComments}. Consulte os erros por publicação e atualize a busca.</span>`
          : this.posts.length
          ? '<i class="fa-regular fa-circle-check" aria-hidden="true"></i><strong>Nenhum comentário pendente</strong><span>As respostas da própria conta ficam ocultas neste filtro.</span>'
          : '<i class="fa-regular fa-comments" aria-hidden="true"></i><strong>Nenhum comentário encontrado</strong><span>Quando houver comentários nas publicações da conta, eles aparecerão aqui.</span>';
        list.appendChild(empty);
        return;
      }
      const fragment = document.createDocumentFragment();
      for (const row of comments) fragment.appendChild(this.createCommentCard(row));
      list.appendChild(fragment);
    },

    createCommentCard({ post, comment, replies, answered }) {
      const card = document.createElement('article');
      card.className = `comentario-card${answered ? ' is-answered' : ''}`;
      const author = comment.username || comment.from?.username || 'Usuário do Instagram';
      const date = comment.timestamp ? new Date(comment.timestamp).toLocaleString('pt-BR', { dateStyle: 'medium', timeStyle: 'short' }) : 'Data indisponível';
      const thumbnailCandidate = post.thumbnail_url || post.media_url || '';
      const thumbnail = /^https:\/\//i.test(thumbnailCandidate) ? thumbnailCandidate : '';
      const postCaption = post.caption || (post.media_product_type === 'REELS' || post.media_type === 'VIDEO' ? 'Reel sem legenda' : 'Publicação sem legenda');
      const mediaLink = /^https:\/\//i.test(post.permalink || '') ? post.permalink : '';
      card.innerHTML = `
        <div class="comentario-card-main">
          <div class="comentario-content">
            <div class="comentario-meta"><strong>${this.escape(author.startsWith('@') ? author : `@${author}`)}</strong><time>${this.escape(date)}</time>${answered ? '<span class="comentario-state is-answered"><i class="fa-solid fa-check" aria-hidden="true"></i> Respondido</span>' : '<span class="comentario-state">Pendente</span>'}</div>
            <p class="comentario-text">${this.escape(comment.text || '')}</p>
            ${replies.length ? `<div class="comentario-replies">${replies.map(reply => `<div class="comentario-reply"><strong>${this.escape(reply.username ? `@${reply.username.replace(/^@/, '')}` : 'Resposta')}</strong><span>${this.escape(reply.text || '')}</span><time>${this.escape(reply.timestamp ? new Date(reply.timestamp).toLocaleString('pt-BR', { dateStyle: 'medium', timeStyle: 'short' }) : '')}</time></div>`).join('')}</div>` : ''}
          </div>
          <a class="comentario-post" ${mediaLink ? `href="${this.escape(mediaLink)}" target="_blank" rel="noopener noreferrer"` : 'aria-disabled="true"'} title="Abrir publicação no Instagram">
            ${thumbnail ? `<img src="${this.escape(thumbnail)}" alt="Miniatura da publicação" loading="lazy">` : '<span class="comentario-post-placeholder"><i class="fa-brands fa-instagram" aria-hidden="true"></i></span>'}
            <span><small>Publicação</small><strong>${this.escape(postCaption)}</strong></span>
            ${mediaLink ? '<i class="fa-solid fa-arrow-up-right-from-square" aria-hidden="true"></i>' : ''}
          </a>
        </div>`;
      return card;
    },

    updateBadge(count) {
      const badge = document.getElementById('commentsCountBadge');
      if (!badge) return;
      badge.textContent = count > 99 ? '99+' : String(count);
      badge.hidden = count === 0;
      badge.title = `${count} comentário${count === 1 ? '' : 's'} sem resposta`;
    },

    escape(value) {
      return String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
    }
  };

  module.updateFilterButton();
  window.ComentariosModule = module;
})();

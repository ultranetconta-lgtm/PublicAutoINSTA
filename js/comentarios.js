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
      document.getElementById('commentsList')?.addEventListener('submit', event => {
        const form = event.target.closest('.comentario-reply-form');
        if (!form) return;
        event.preventDefault();
        this.sendReply(form);
      });
      document.getElementById('commentsList')?.addEventListener('click', event => {
        const pickerButton = event.target.closest('.comentario-emoji-toggle');
        if (pickerButton) {
          const picker = pickerButton.closest('.comentario-reply-composer')?.querySelector('.comentario-emoji-picker');
          if (!picker) return;
          picker.hidden = !picker.hidden;
          pickerButton.setAttribute('aria-expanded', String(!picker.hidden));
          return;
        }
        const emojiButton = event.target.closest('.comentario-emoji-option');
        if (emojiButton) this.insertEmoji(emojiButton);
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

    async sendReply(form) {
      const input = form.querySelector('input[name="message"]');
      const button = form.querySelector('button[type="submit"]');
      const feedback = form.querySelector('.comentario-reply-status');
      const message = input?.value.trim() || '';
      const commentId = form.dataset.commentId || '';
      const accountId = this.account?.id || window.getActiveInstagramAccountId?.() || '';
      if (!message) {
        if (feedback) feedback.textContent = 'Escreva uma resposta antes de enviar.';
        input?.focus();
        return;
      }
      if (!accountId || !commentId) {
        if (feedback) feedback.textContent = 'Não foi possível identificar a conta ou o comentário.';
        return;
      }

      if (button) button.disabled = true;
      if (input) input.disabled = true;
      if (feedback) feedback.textContent = 'Enviando resposta para o Instagram…';
      try {
        const response = await fetch(`/api/comments/${encodeURIComponent(commentId)}/reply`, {
          method: 'POST',
          headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
          cache: 'no-store',
          body: JSON.stringify({ account_id: accountId, message })
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok || payload.ok !== true) {
          throw new Error(payload.message || 'Não foi possível enviar a resposta.');
        }
        const row = this.flattenComments().find(item => String(item.comment.id || '') === commentId);
        if (row) {
          const returnedReply = payload.reply && typeof payload.reply === 'object' ? payload.reply : {};
          row.replies.push({
            ...returnedReply,
            text: returnedReply.text || message,
            username: returnedReply.username || this.account?.username || '',
            timestamp: returnedReply.timestamp || new Date().toISOString()
          });
          row.answered = true;
          row.comment.replies = { data: row.replies };
          this.render();
          this.updateBadge(this.flattenComments().filter(item => !item.answered).length);
        }
        if (input) input.value = '';
        const status = document.getElementById('commentsStatus');
        if (status) status.textContent = `${status.textContent} Última resposta enviada no Instagram.`.trim();
      } catch (error) {
        if (feedback) feedback.textContent = error.message || 'Falha ao enviar resposta.';
      } finally {
        if (button?.isConnected) button.disabled = false;
        if (input?.isConnected) input.disabled = false;
      }
    },

    flattenComments() {
      const rows = [];
      const nestedReplyIds = new Set();
      for (const post of this.posts) {
        for (const comment of Array.isArray(post.comments) ? post.comments : []) {
          const replies = Array.isArray(comment.replies?.data) ? comment.replies.data : (Array.isArray(comment.replies) ? comment.replies : []);
          for (const reply of replies) {
            if (reply.id) nestedReplyIds.add(String(reply.id));
          }
        }
      }
      for (const post of this.posts) {
        for (const comment of Array.isArray(post.comments) ? post.comments : []) {
          if (comment.id && nestedReplyIds.has(String(comment.id))) continue;
          const replies = Array.isArray(comment.replies?.data) ? comment.replies.data : (Array.isArray(comment.replies) ? comment.replies : []);
          rows.push({ post, comment, replies, answered: replies.length > 0 });
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

    insertEmoji(button) {
      const form = button.closest('.comentario-reply-form');
      const input = form?.querySelector('input[name="message"]');
      const picker = button.closest('.comentario-emoji-picker');
      if (!input || !picker) return;
      const emoji = button.dataset.emoji || '';
      const start = input.selectionStart ?? input.value.length;
      const end = input.selectionEnd ?? start;
      const value = input.value;
      input.value = `${value.slice(0, start)}${emoji}${value.slice(end)}`.slice(0, Number(input.maxLength) || undefined);
      const caret = Math.min(start + emoji.length, input.value.length);
      input.setSelectionRange(caret, caret);
      input.focus();
      picker.hidden = true;
      form.querySelector('.comentario-emoji-toggle')?.setAttribute('aria-expanded', 'false');
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
      const replyForm = document.createElement('form');
      replyForm.className = 'comentario-reply-form';
      replyForm.dataset.commentId = String(comment.id || '');
      replyForm.innerHTML = `
        <div class="comentario-reply-composer">
          <input type="text" name="message" maxlength="2200" required aria-label="Resposta para este comentário" placeholder="Escreva sua resposta...">
          <button class="comentario-emoji-toggle" type="button" aria-label="Escolher emoji" aria-expanded="false" title="Escolher emoji"><i class="fa-regular fa-face-smile" aria-hidden="true"></i></button>
          <div class="comentario-emoji-picker" hidden aria-label="Emojis">
            ${['😀', '😂', '🥰', '😍', '😘', '😊', '❤️', '👏', '✨', '🙏', '🔥', '💖'].map(emoji => `<button class="comentario-emoji-option" type="button" data-emoji="${emoji}" aria-label="Inserir ${emoji}">${emoji}</button>`).join('')}
          </div>
        </div>
        <div class="comentario-reply-actions">
          <span class="comentario-reply-status" role="status" aria-live="polite"></span>
          <button type="submit"><i class="fa-solid fa-paper-plane" aria-hidden="true"></i><span>Enviar resposta</span></button>
        </div>`;
      card.appendChild(replyForm);
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

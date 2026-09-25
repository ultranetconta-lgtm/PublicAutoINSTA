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
    currentPage: 0,
    pageSize: 10,
    pendingReplies: new Map(),
    replyErrors: new Map(),
    sendingReplies: false,
    maxPendingReplies: 50,

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
        this.currentPage = 0;
        this.updateFilterButton();
        this.render();
      });
      document.getElementById('commentsList')?.addEventListener('submit', event => {
        const form = event.target.closest('.comentario-reply-form');
        if (!form) return;
        event.preventDefault();
        this.stageReply(form, true);
      });
      document.getElementById('commentsList')?.addEventListener('input', event => {
        if (event.target.matches('.comentario-reply-form input[name="message"]')) {
          this.stageReply(event.target.closest('.comentario-reply-form'));
        }
      });
      document.getElementById('commentsList')?.addEventListener('click', event => {
        const pageButton = event.target.closest('[data-comments-page]');
        if (pageButton) {
          const comments = this.visibleComments();
          const pageCount = Math.max(1, Math.ceil(comments.length / this.pageSize));
          this.currentPage = Math.max(0, Math.min(pageCount - 1, Number(pageButton.dataset.commentsPage) || 0));
          this.render();
          document.getElementById('commentsList')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
          return;
        }
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
      document.getElementById('btnSendCommentReplies')?.addEventListener('click', () => this.sendPendingReplies());
      document.addEventListener('instagram-account-changed', () => {
        const accountId = window.getActiveInstagramAccountId?.() || '';
        if (accountId !== this.account?.id) {
          this.pendingReplies.clear();
          this.currentPage = 0;
          this.updateBatchBar();
        }
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
      this.currentPage = 0;
      this.updateBatchBar();
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
          const answered = comments.filter(comment => comment.answered).length;
          const pending = comments.filter(comment => !comment.answered).length;
          const textlessPending = comments.filter(comment => !comment.answered && !String(comment.comment.text || '').trim()).length;
          const summary = `${this.posts.length} publicações consultadas · ${comments.length} comentários · ${answered} respondidos · ${pending} pendentes · ${textlessPending} sem texto.`;
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

    stageReply(form, submitted = false) {
      const input = form.querySelector('input[name="message"]');
      const feedback = form.querySelector('.comentario-reply-status');
      const message = input?.value.trim() || '';
      const commentId = form.dataset.commentId || '';
      const accountId = this.account?.id || window.getActiveInstagramAccountId?.() || '';
      if (!accountId || !commentId) {
        if (feedback) feedback.textContent = 'Não foi possível identificar a conta ou o comentário.';
        return;
      }
      const row = this.flattenComments().find(item => String(item.comment.id || '') === commentId);
      if (row && (row.ownComment || row.answered)) {
        this.pendingReplies.delete(commentId);
        this.replyErrors.delete(commentId);
        if (feedback) feedback.textContent = 'Esse comentário já foi respondido ou é da conta conectada.';
        this.updateBatchBar();
        return;
      }
      if (!message) {
        this.pendingReplies.delete(commentId);
        this.replyErrors.delete(commentId);
        if (submitted) {
          if (feedback) feedback.textContent = 'Escreva uma resposta antes de adicionar ao envio.';
          input?.focus();
        }
      } else {
        if (!this.pendingReplies.has(commentId) && this.pendingReplies.size >= this.maxPendingReplies) {
          if (feedback) feedback.textContent = 'A fila aceita até 50 respostas por chamada. Envie este lote ou remova uma resposta para adicionar outra.';
          return;
        }
        this.pendingReplies.set(commentId, { comment_id: commentId, message });
        this.replyErrors.delete(commentId);
        if (feedback) feedback.textContent = submitted ? 'Resposta adicionada ao envio em lote.' : 'Resposta pronta para envio em lote.';
      }
      this.updateBatchBar();
    },

    async sendPendingReplies() {
      const accountId = this.account?.id || window.getActiveInstagramAccountId?.() || '';
      if (this.sendingReplies || !accountId) return;
      const commentsById = new Map(this.flattenComments().map(item => [String(item.comment.id || ''), item]));
      let removedReplies = 0;
      for (const commentId of this.pendingReplies.keys()) {
        const row = commentsById.get(commentId);
        if (!row || row.ownComment || row.answered) {
          this.pendingReplies.delete(commentId);
          this.replyErrors.delete(commentId);
          removedReplies += 1;
        }
      }
      const replies = [...this.pendingReplies.values()];
      if (!replies.length) {
        this.updateBatchBar();
        if (removedReplies) {
          const status = document.getElementById('commentsStatus');
          if (status) status.textContent = `${removedReplies} resposta${removedReplies === 1 ? '' : 's'} já respondida${removedReplies === 1 ? '' : 's'} ou da conta foram removidas da fila.`;
        }
        return;
      }

      this.sendingReplies = true;
      this.updateBatchBar();
      document.querySelectorAll('.comentario-reply-form input, .comentario-reply-form button').forEach(control => { control.disabled = true; });
      const sendButton = document.getElementById('btnSendCommentReplies');
      if (sendButton) sendButton.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin" aria-hidden="true"></i><span>Enviando…</span>';
      try {
        const response = await fetch('/api/comments/replies', {
          method: 'POST',
          headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
          cache: 'no-store',
          body: JSON.stringify({ account_id: accountId, replies })
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok || payload.ok !== true || !Array.isArray(payload.results)) {
          throw new Error(payload.message || 'Não foi possível enviar as respostas em lote.');
        }

        let succeeded = 0;
        const successfulReplies = [];
        for (const result of payload.results) {
          const commentId = String(result.comment_id || '');
          const queued = this.pendingReplies.get(commentId);
          if (!queued) continue;
          if (result.ok === true) {
            successfulReplies.push({ commentId, message: queued.message, reply: result.reply });
            this.pendingReplies.delete(commentId);
            this.replyErrors.delete(commentId);
            succeeded += 1;
          } else if (result.already_replied === true || result.own_comment === true) {
            this.pendingReplies.delete(commentId);
            this.replyErrors.delete(commentId);
            removedReplies += 1;
          } else {
            this.replyErrors.set(commentId, result.message || 'A Meta não aceitou esta resposta; ela continua na fila.');
          }
        }
        const failed = this.pendingReplies.size;
        const batchStatus = failed
          ? `${succeeded} resposta${succeeded === 1 ? '' : 's'} enviada${succeeded === 1 ? '' : 's'}; ${failed} mantida${failed === 1 ? '' : 's'} na fila para revisão.`
          : `${succeeded} resposta${succeeded === 1 ? '' : 's'} enviada${succeeded === 1 ? '' : 's'} ao Instagram.`;
        await this.load();
        if (this.account?.id === accountId) {
          for (const sent of successfulReplies) {
            this.applyReplySuccess(sent.commentId, sent.message, sent.reply);
          }
        }
        this.render();
        this.updateBadge(this.flattenComments().filter(item => !item.answered).length);
        const status = document.getElementById('commentsStatus');
        if (status) status.textContent = `${status.textContent} Lote atualizado: ${batchStatus}${removedReplies ? ` ${removedReplies} resposta${removedReplies === 1 ? '' : 's'} duplicada${removedReplies === 1 ? '' : 's'} ou da conta foram removidas da fila.` : ''}`.trim();
      } catch (error) {
        const status = document.getElementById('commentsStatus');
        if (status) status.textContent = `${error.message || 'Falha ao enviar respostas.'} As respostas continuam na fila; atualize os comentários antes de repetir para conferir o estado no Instagram.`;
      } finally {
        this.sendingReplies = false;
        document.querySelectorAll('.comentario-reply-form input, .comentario-reply-form button').forEach(control => { control.disabled = false; });
        this.updateBatchBar();
      }
    },

    applyReplySuccess(commentId, message, reply) {
      const row = this.flattenComments().find(item => String(item.comment.id || '') === commentId);
      if (!row || row.answered) return;
      const returnedReply = reply && typeof reply === 'object' ? reply : {};
      row.replies.push({
        ...returnedReply,
        text: returnedReply.text || message,
        username: returnedReply.username || this.account?.username || '',
        timestamp: returnedReply.timestamp || new Date().toISOString()
      });
      row.answered = true;
      row.comment.replies = { data: row.replies };
    },

    updateBatchBar() {
      const count = this.pendingReplies.size;
      const countLabel = document.getElementById('commentsBatchCount');
      const answeredLabel = document.getElementById('commentsAnsweredTotal');
      const pendingLabel = document.getElementById('commentsPendingTotal');
      const textlessLabel = document.getElementById('commentsTextlessTotal');
      const sendButton = document.getElementById('btnSendCommentReplies');
      const comments = this.flattenComments();
      const answeredCount = comments.filter(item => item.answered).length;
      const pendingCount = comments.filter(item => !item.answered).length;
      const textlessCount = comments.filter(item => !item.answered && !String(item.comment.text || '').trim()).length;
      if (countLabel) countLabel.textContent = String(count);
      if (answeredLabel) answeredLabel.textContent = String(answeredCount);
      if (pendingLabel) pendingLabel.textContent = String(pendingCount);
      if (textlessLabel) textlessLabel.textContent = String(textlessCount);
      if (sendButton) {
        sendButton.disabled = count === 0 || this.sendingReplies;
        sendButton.innerHTML = `<i class="fa-solid fa-paper-plane" aria-hidden="true"></i><span>Enviar ${count ? `(${count})` : 'respostas'}</span>`;
      }
    },

    visibleComments() {
      return this.flattenComments().filter(item => this.includeAnswered || !item.answered);
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
          const ownComment = this.isFromActiveAccount(comment);
          rows.push({ post, comment, replies, ownComment, answered: replies.length > 0 || ownComment });
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
      const comments = this.visibleComments();
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
      const pageCount = Math.ceil(comments.length / this.pageSize);
      this.currentPage = Math.max(0, Math.min(this.currentPage, pageCount - 1));
      const pageComments = comments.slice(this.currentPage * this.pageSize, (this.currentPage + 1) * this.pageSize);
      const fragment = document.createDocumentFragment();
      for (const row of pageComments) fragment.appendChild(this.createCommentCard(row));
      list.appendChild(fragment);
      if (pageCount > 1) {
        const pagination = document.createElement('nav');
        pagination.className = 'comentarios-pagination';
        pagination.setAttribute('aria-label', 'Páginas de comentários');
        pagination.innerHTML = `
          <button type="button" data-comments-page="${this.currentPage - 1}" ${this.currentPage === 0 ? 'disabled' : ''} aria-label="Página anterior"><i class="fa-solid fa-chevron-left" aria-hidden="true"></i><span>Anterior</span></button>
          <span>Página <strong>${this.currentPage + 1}</strong> de <strong>${pageCount}</strong></span>
          <button type="button" data-comments-page="${this.currentPage + 1}" ${this.currentPage === pageCount - 1 ? 'disabled' : ''} aria-label="Próxima página"><span>Próxima</span><i class="fa-solid fa-chevron-right" aria-hidden="true"></i></button>`;
        list.appendChild(pagination);
      }
      this.updateBatchBar();
    },

    createCommentCard({ post, comment, replies, answered, ownComment = false }) {
      const card = document.createElement('article');
      card.className = `comentario-card${answered ? ' is-answered' : ''}`;
      const author = comment.username || comment.from?.username || 'Usuário do Instagram';
      const date = comment.timestamp ? new Date(comment.timestamp).toLocaleString('pt-BR', { dateStyle: 'medium', timeStyle: 'short' }) : 'Data indisponível';
      const thumbnailCandidate = post.thumbnail_url || post.media_url || '';
      const thumbnail = /^https:\/\//i.test(thumbnailCandidate) ? thumbnailCandidate : '';
      const postCaption = post.caption || (post.media_product_type === 'REELS' || post.media_type === 'VIDEO' ? 'Reel sem legenda' : 'Publicação sem legenda');
      const mediaLink = /^https:\/\//i.test(post.permalink || '') ? post.permalink : '';
      const commentText = String(comment.text || '').trim();
      const missingTextLabel = comment.media
        ? 'Comentário com mídia (sem texto)'
        : 'Texto do comentário não disponibilizado pela Meta';
      card.innerHTML = `
        <div class="comentario-card-main">
          <div class="comentario-content">
            <div class="comentario-meta"><strong>${this.escape(author.startsWith('@') ? author : `@${author}`)}</strong><time>${this.escape(date)}</time>${ownComment ? '<span class="comentario-state is-answered"><i class="fa-solid fa-check" aria-hidden="true"></i> Comentário da conta</span>' : answered ? '<span class="comentario-state is-answered"><i class="fa-solid fa-check" aria-hidden="true"></i> Respondido</span>' : !commentText ? '<span class="comentario-state is-textless">Sem texto</span>' : '<span class="comentario-state">Pendente</span>'}</div>
            <p class="comentario-text${commentText ? '' : ' is-textless'}">${this.escape(commentText || missingTextLabel)}</p>
            ${replies.length ? `<div class="comentario-replies">${replies.map(reply => { const replyUsername = reply.username || reply.from?.username || ''; return `<div class="comentario-reply"><strong>${this.escape(replyUsername ? `@${replyUsername.replace(/^@/, '')}` : 'Resposta')}</strong><span>${this.escape(reply.text || '')}</span><time>${this.escape(reply.timestamp ? new Date(reply.timestamp).toLocaleString('pt-BR', { dateStyle: 'medium', timeStyle: 'short' }) : '')}</time></div>`; }).join('')}</div>` : ''}
          </div>
          <a class="comentario-post" ${mediaLink ? `href="${this.escape(mediaLink)}" target="_blank" rel="noopener noreferrer"` : 'aria-disabled="true"'} title="Abrir publicação no Instagram">
            ${thumbnail ? `<img src="${this.escape(thumbnail)}" alt="Miniatura da publicação" loading="lazy">` : '<span class="comentario-post-placeholder"><i class="fa-brands fa-instagram" aria-hidden="true"></i></span>'}
            <span><small>Publicação</small><strong>${this.escape(postCaption)}</strong></span>
            ${mediaLink ? '<i class="fa-solid fa-arrow-up-right-from-square" aria-hidden="true"></i>' : ''}
          </a>
        </div>`;
      if (answered || ownComment) return card;
      const replyForm = document.createElement('form');
      replyForm.className = 'comentario-reply-form';
      replyForm.dataset.commentId = String(comment.id || '');
      replyForm.innerHTML = `
        <div class="comentario-reply-composer">
          <input type="text" name="message" maxlength="2200" aria-label="Resposta para este comentário" placeholder="Escreva sua resposta..." ${this.sendingReplies ? 'disabled' : ''}>
          <button class="comentario-emoji-toggle" type="button" aria-label="Escolher emoji" aria-expanded="false" title="Escolher emoji"><i class="fa-regular fa-face-smile" aria-hidden="true"></i></button>
          <div class="comentario-emoji-picker" hidden aria-label="Emojis">
            ${['😀', '😂', '🥰', '😍', '😘', '😊', '❤️', '👏', '✨', '🙏', '🔥', '💖'].map(emoji => `<button class="comentario-emoji-option" type="button" data-emoji="${emoji}" aria-label="Inserir ${emoji}">${emoji}</button>`).join('')}
          </div>
        </div>
        <div class="comentario-reply-actions">
          <span class="comentario-reply-status" role="status" aria-live="polite"></span>
          <button type="submit" ${this.sendingReplies ? 'disabled' : ''}><i class="fa-solid fa-plus" aria-hidden="true"></i><span>Adicionar à fila</span></button>
        </div>`;
      const input = replyForm.querySelector('input[name="message"]');
      const draft = this.pendingReplies.get(String(comment.id || ''));
      if (input && draft) input.value = draft.message;
      const feedback = replyForm.querySelector('.comentario-reply-status');
      if (feedback) feedback.textContent = this.replyErrors.get(String(comment.id || '')) || (draft ? 'Resposta pronta para envio em lote.' : '');
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

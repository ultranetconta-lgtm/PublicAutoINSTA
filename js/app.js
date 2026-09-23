document.addEventListener('DOMContentLoaded', () => {
  // Elements
  const editor = document.getElementById('postEditor');
  const hashtagCounter = document.getElementById('hashtagCounter');
  const charCounter = document.getElementById('charCounter');
  const previewCaption = document.getElementById('previewCaption');
  const fileInput = document.getElementById('mediaFileInput');
  const btnAddMedia = document.getElementById('btnAddMedia');
  const networkAddButton = document.querySelector('.network-add-btn');
  const editorMediaPreviewArea = document.getElementById('editorMediaPreviewArea');
  const thumbVideo = document.getElementById('thumbVideo');
  const thumbImage = document.getElementById('thumbImage');
  const btnThumbOptions = document.getElementById('btnThumbOptions');
  const composerMessageBox = document.getElementById('composerMessageBox');
  const composerMessageBoxPanel = document.getElementById('composerMessageBoxPanel');
  const composerMessageBoxTitle = document.getElementById('composerMessageBoxTitle');
  const composerMessageBoxDescription = document.getElementById('composerMessageBoxDescription');
  const composerMessageBoxActions = document.getElementById('composerMessageBoxActions');

  const previewMediaLayer = document.getElementById('previewMediaLayer');
  const mediaEmptyPlaceholder = document.getElementById('mediaEmptyPlaceholder');
  const previewImage = document.getElementById('previewImage');
  const previewVideo = document.getElementById('previewVideo');
  const videoControlsOverlay = document.getElementById('videoControlsOverlay');
  const btnReelPlayPause = document.getElementById('btnReelPlayPause');
  const reelPlayIcon = document.getElementById('reelPlayIcon');
  const btnReelRewind = document.getElementById('btnReelRewind');
  const btnReelForward = document.getElementById('btnReelForward');

  // Network selector elements
  const networkSelectorTrigger = document.getElementById('networkSelectorTrigger');
  const btnNetworkMode = document.getElementById('btnNetworkMode');
  const networkDropdownMenu = document.getElementById('networkDropdownMenu');
  const currentNetworkModeText = document.getElementById('currentNetworkModeText');
  const networkDropdownItems = document.querySelectorAll('.network-dropdown-item');
  let currentMode = 'test_reel';
  let selectedPublishAction = 'schedule';
  let currentMedia = null;

  // Hashtags autocomplete elements
  const btnHashtag = document.getElementById('btnHashtag');
  const hashtagsAutocompleteCard = document.getElementById('hashtagsAutocompleteCard');
  const hashtagRowItems = document.querySelectorAll('.hashtag-row-item');

  // Warning Accordion
  const warningAccordionCard = document.getElementById('warningAccordionCard');
  const btnToggleWarning = document.getElementById('btnToggleWarning');
  const warningAccordionBody = document.getElementById('warningAccordionBody');
  const warningChevron = document.getElementById('warningChevron');

  // Schedule & Dates
  const displayDate = document.getElementById('displayDate');
  const btnSchedule = document.getElementById('btnSchedule');
  const btnScheduleDropdown = document.getElementById('btnScheduleDropdown');
  const scheduleMenu = document.getElementById('scheduleMenu');
  const btnDateTime = document.getElementById('btnDateTime');
  const datePickerModal = document.getElementById('datePickerModal');
  const uploadProgressOverlay = document.getElementById('uploadProgressOverlay');
  const uploadProgressCard = document.getElementById('uploadProgressCard');
  const uploadProgressRingValue = document.getElementById('uploadProgressRingValue');
  const uploadProgressPercent = document.getElementById('uploadProgressPercent');
  const uploadProgressPhase = document.getElementById('uploadProgressPhase');
  const uploadProgressTitle = document.getElementById('uploadProgressTitle');
  const uploadProgressStatus = document.getElementById('uploadProgressStatus');
  const uploadProgressFileName = document.getElementById('uploadProgressFileName');
  const uploadProgressFileSize = document.getElementById('uploadProgressFileSize');
  const uploadProgressTransferred = document.getElementById('uploadProgressTransferred');

  // Emoji, First Comment, Notes
  const btnEmoji = document.getElementById('btnEmoji');
  const emojiPopover = document.getElementById('emojiPickerPopover');
  const btnFirstComment = document.getElementById('firstComment');
  const firstCommentModal = document.getElementById('firstCommentModal');
  const btnNotes = document.getElementById('btnNotes');
  const notesModal = document.getElementById('notesModal');

  // View toggles
  const btnToggleEye = document.getElementById('toggleViewEye');
  const btnToggleMobile = document.getElementById('toggleViewMobile');
  const btnToggleDesktop = document.getElementById('toggleViewDesktop');
  const btnGridPreview = document.getElementById('btnGridPreview');
  const reelPhoneFrame = document.getElementById('reelPhoneFrame');
  const btnShowPreviewMobile = document.getElementById('btnShowPreviewMobile');
  const plannerRightCol = document.getElementById('plannerRightCol');

  // --- Real-Time Caption & Counters Sync ---
  function updateEditorState() {
    const text = editor.innerText.trim();
    
    // Character counter (Instagram format: 0/2200)
    const charLen = editor.innerText.length;
    charCounter.innerText = `${charLen}/2200`;
    charCounter.style.color = charLen > 2200 ? '#ef4444' : '#64748b';

    // Hashtag counter (Instagram format: 0/30 #)
    const matches = editor.innerText.match(/#[a-zA-Z0-9_\u00C0-\u017F]+/g) || [];
    hashtagCounter.innerText = `${matches.length}/30 #`;
    hashtagCounter.style.color = matches.length > 30 ? '#ef4444' : '#64748b';

    // Sync to Instagram Live Preview
    if (text.length > 0) {
      previewCaption.innerText = editor.innerText;
      previewCaption.style.display = '-webkit-box';
    } else {
      previewCaption.innerText = '';
      previewCaption.style.display = 'none';
    }
  }

  editor.addEventListener('input', updateEditorState);
  editor.addEventListener('keyup', updateEditorState);

  // --- Network Dropdown Menu (Screenshot 1) ---
  function toggleNetworkDropdown(e) {
    e.stopPropagation();
    networkDropdownMenu.classList.toggle('show');
    hashtagsAutocompleteCard.classList.remove('show');
    emojiPopover.classList.remove('show');
    scheduleMenu.classList.remove('show');
  }

  networkSelectorTrigger.addEventListener('click', toggleNetworkDropdown);

  networkDropdownItems.forEach(item => {
    item.addEventListener('click', (e) => {
      e.stopPropagation();
      networkDropdownItems.forEach(i => {
        i.classList.remove('active');
        i.querySelector('.item-check').classList.add('hidden');
      });

      item.classList.add('active');
      item.querySelector('.item-check').classList.remove('hidden');

      const label = item.dataset.label;
      const mode = item.dataset.mode;
      currentMode = mode;
      currentNetworkModeText.innerText = label;
      const previewTitle = document.querySelector('.reels-top-title');
      if (previewTitle) previewTitle.innerText = mode === 'story' ? 'Story' : 'Reels';

      // If "Reels de teste", show warning accordion; otherwise hide it
      if (mode === 'test_reel') {
        warningAccordionCard.style.display = 'block';
      } else {
        warningAccordionCard.style.display = 'none';
      }

      networkDropdownMenu.classList.remove('show');
      showToast(`Modo alterado para ${label}`, 'info');
    });
  });

  // --- Hashtags Autocomplete List (Screenshot 2) ---
  btnHashtag.addEventListener('click', (e) => {
    e.stopPropagation();
    const rect = btnHashtag.getBoundingClientRect();
    hashtagsAutocompleteCard.style.top = `${rect.top + window.scrollY - 270}px`;
    hashtagsAutocompleteCard.style.left = `${rect.left + window.scrollX - 20}px`;
    hashtagsAutocompleteCard.classList.toggle('show');
    networkDropdownMenu.classList.remove('show');
    emojiPopover.classList.remove('show');
    scheduleMenu.classList.remove('show');
  });

  hashtagRowItems.forEach(item => {
    item.addEventListener('click', (e) => {
      e.stopPropagation();
      const tag = item.dataset.tag + ' ';
      insertTextAtEditor(tag);
      hashtagsAutocompleteCard.classList.remove('show');
    });
  });

  // Helper: insert text into contenteditable
  function insertTextAtEditor(textToInsert) {
    editor.focus();
    if (document.queryCommandSupported('insertText')) {
      document.execCommand('insertText', false, textToInsert);
    } else {
      editor.innerText += textToInsert;
    }
    updateEditorState();
  }

  // --- Media Upload & Thumbnail (Screenshot 3) ---
  function handleMediaFile(file) {
    if (!file) return;

    const isVideo = file.type.startsWith('video/');
    const isImage = file.type.startsWith('image/');

    if (!isVideo && !isImage) {
      showToast('Por favor selecione uma imagem ou vídeo válido.', 'warning');
      return;
    }

    if (currentMedia?.url) URL.revokeObjectURL(currentMedia.url);
    const fileUrl = URL.createObjectURL(file);
    currentMedia = {
      file,
      url: fileUrl,
      isVideo,
      kind: isVideo ? 'video' : 'image'
    };

      // Show thumbnail in editor
      editorMediaPreviewArea.style.display = 'flex';
      if (isVideo) {
        thumbImage.classList.add('hidden');
        thumbVideo.src = fileUrl;
        thumbVideo.classList.remove('hidden');
        videoControlsOverlay.classList.remove('hidden');

        // Update phone preview
        mediaEmptyPlaceholder.classList.add('hidden');
        previewImage.classList.add('hidden');
        previewImage.style.display = 'none';
        previewVideo.src = fileUrl;
        previewVideo.style.display = 'block';
      previewVideo.play().catch(() => {});
      videoControlsOverlay.classList.remove('hidden');
      reelPlayIcon.className = 'fa-solid fa-pause';
    } else {
      thumbVideo.classList.add('hidden');
      thumbImage.src = fileUrl;
      thumbImage.classList.remove('hidden');

      // Update phone preview
      mediaEmptyPlaceholder.classList.add('hidden');
        previewVideo.style.display = 'none';
        previewVideo.pause();
        previewImage.src = fileUrl;
        previewImage.classList.remove('hidden');
        previewImage.style.display = 'block';
        videoControlsOverlay.classList.add('hidden');
    }

    showToast(isVideo ? 'Vídeo carregado com sucesso!' : 'Imagem carregada com sucesso!', 'success');
  }

  function clearAttachedMedia() {
    if (currentMedia?.url) URL.revokeObjectURL(currentMedia.url);
    currentMedia = null;
    fileInput.value = '';
    editorMediaPreviewArea.style.display = 'none';

    thumbVideo.pause();
    thumbVideo.removeAttribute('src');
    thumbVideo.load();
    thumbVideo.classList.add('hidden');
    thumbImage.removeAttribute('src');
    thumbImage.classList.add('hidden');

    previewVideo.pause();
    previewVideo.removeAttribute('src');
    previewVideo.load();
    previewVideo.style.display = 'none';
    previewVideo.classList.add('hidden');
    previewImage.removeAttribute('src');
    previewImage.style.display = 'none';
    previewImage.classList.add('hidden');
    mediaEmptyPlaceholder.classList.remove('hidden');
    videoControlsOverlay.classList.add('hidden');
    reelPlayIcon.className = 'fa-solid fa-play ml-1';
  }

  let composerMessageBoxReturnFocus = null;

  function closeComposerMessageBox() {
    composerMessageBox.hidden = true;
    composerMessageBoxActions.replaceChildren();
    if (composerMessageBoxReturnFocus?.isConnected && composerMessageBoxReturnFocus.getClientRects().length > 0) {
      composerMessageBoxReturnFocus.focus({ preventScroll: true });
    } else if (composerMessageBoxReturnFocus?.isConnected && composerMessageBoxReturnFocus !== btnAddMedia) {
      btnAddMedia.focus({ preventScroll: true });
    }
    composerMessageBoxReturnFocus = null;
  }

  function showComposerMessageBox({ title, message, actions }) {
    composerMessageBoxTitle.innerText = title;
    composerMessageBoxDescription.innerText = message;
    composerMessageBoxReturnFocus = document.activeElement;
    composerMessageBoxActions.replaceChildren();

    actions.forEach(action => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `composer-messagebox-button${action.style ? ` is-${action.style}` : ''}`;
      button.innerText = action.label;
      button.addEventListener('click', () => {
        closeComposerMessageBox();
        action.onClick?.();
      });
      composerMessageBoxActions.appendChild(button);
    });

    composerMessageBox.hidden = false;
    const firstAction = composerMessageBoxActions.querySelector('button');
    (firstAction || composerMessageBoxPanel).focus({ preventScroll: true });
  }

  function openMediaPicker() {
    fileInput.value = '';
    fileInput.click();
  }

  function resetComposer() {
    clearAttachedMedia();
    editor.innerText = '';
    updateEditorState();
    document.getElementById('firstCommentInput').value = '';
    btnFirstComment.classList.remove('active-tool');
    document.getElementById('notesInput').value = '';
    firstCommentModal.classList.remove('active');
    notesModal.classList.remove('active');
    datePickerModal.classList.remove('active');
    networkDropdownMenu.classList.remove('show');
    hashtagsAutocompleteCard.classList.remove('show');
    emojiPopover.classList.remove('show');
    selectedPublishAction = 'schedule';
    btnSchedule.innerText = 'Agendamento';
    scheduleMenu.classList.remove('show');
    document.getElementById('scheduledDateInput').value = '';
    document.getElementById('scheduledTimeInput').value = '';
    ensureFutureScheduleDefault();
    showToast('Publicação limpa. Você pode começar uma nova.', 'success');
  }

  function handleNewPublicationClick() {
    const hasDraftContent = Boolean(
      currentMedia
      || editor.innerText.trim()
      || document.getElementById('firstCommentInput').value.trim()
      || document.getElementById('notesInput').value.trim()
      || selectedPublishAction !== 'schedule'
    );

    if (!hasDraftContent) {
      resetComposer();
      return;
    }

    showComposerMessageBox({
      title: 'Começar uma nova publicação?',
      message: 'O texto, o anexo e as opções desta publicação serão limpos para você começar do zero.',
      actions: [
        { label: 'Continuar editando' },
        { label: 'Limpar e começar', style: 'danger', onClick: resetComposer }
      ]
    });
  }

  networkAddButton.addEventListener('click', handleNewPublicationClick);

  btnAddMedia.addEventListener('click', () => {
    openMediaPicker();
  });

  fileInput.addEventListener('change', (e) => {
    if (e.target.files && e.target.files[0]) {
      handleMediaFile(e.target.files[0]);
    }
    e.target.value = '';
  });

  btnThumbOptions.addEventListener('click', (e) => {
    e.stopPropagation();
    showComposerMessageBox({
      title: 'Mídia anexada',
      message: 'O que você deseja fazer com a mídia desta publicação?',
      actions: [
        { label: 'Cancelar' },
        { label: 'Remover anexo', style: 'danger', onClick: () => {
          clearAttachedMedia();
          showToast('Anexo removido da publicação.', 'info');
        } },
        { label: 'Trocar arquivo', style: 'primary', onClick: openMediaPicker }
      ]
    });
  });

  composerMessageBox.addEventListener('click', event => {
    if (event.target === composerMessageBox) closeComposerMessageBox();
  });

  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !composerMessageBox.hidden) {
      closeComposerMessageBox();
    }
  });

  // --- Video Playback Controls in Reel (Screenshot 3) ---
  btnReelPlayPause.addEventListener('click', (e) => {
    e.stopPropagation();
    if (previewVideo.paused) {
      previewVideo.play().then(() => {
        reelPlayIcon.className = 'fa-solid fa-pause';
      }).catch(() => {});
    } else {
      previewVideo.pause();
      reelPlayIcon.className = 'fa-solid fa-play ml-1';
    }
  });

  btnReelRewind.addEventListener('click', (e) => {
    e.stopPropagation();
    previewVideo.currentTime = Math.max(0, previewVideo.currentTime - 5);
  });

  btnReelForward.addEventListener('click', (e) => {
    e.stopPropagation();
    previewVideo.currentTime = Math.min(previewVideo.duration || 60, previewVideo.currentTime + 5);
  });

  previewVideo.addEventListener('click', () => {
    btnReelPlayPause.click();
  });

  // Auto update icon on video play/pause
  previewVideo.addEventListener('play', () => {
    reelPlayIcon.className = 'fa-solid fa-pause';
  });

  previewVideo.addEventListener('pause', () => {
    reelPlayIcon.className = 'fa-solid fa-play ml-1';
  });

  // --- Warning Accordion Toggle ---
  btnToggleWarning.addEventListener('click', () => {
    if (warningAccordionBody.style.display === 'none') {
      warningAccordionBody.style.display = 'flex';
      warningChevron.className = 'fas fa-chevron-up chevron-icon text-xs text-gray-500';
    } else {
      warningAccordionBody.style.display = 'none';
      warningChevron.className = 'fas fa-chevron-down chevron-icon text-xs text-gray-500';
    }
  });

  // --- General Accordions ---
  const accordions = document.querySelectorAll('.accordion-header');
  accordions.forEach(header => {
    header.addEventListener('click', (e) => {
      if (e.target.closest('.custom-switch') || e.target.closest('input')) return;
      const card = header.closest('.accordion-card');
      card.classList.toggle('open');
    });
  });

  // --- Emoji Picker ---
  const emojis = ['🔥', '✨', '🚀', '❤️', '😍', '👏', '🎯', '💯', '📸', '👗', '💄', '🌟', '💼', '💡', '🎉', '👇', '👉', '📍'];
  const emojiGrid = document.querySelector('.emoji-grid');
  emojis.forEach(emoji => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'emoji-btn';
    btn.innerText = emoji;
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      insertTextAtEditor(emoji);
      emojiPopover.classList.remove('show');
    });
    emojiGrid.appendChild(btn);
  });

  btnEmoji.addEventListener('click', (e) => {
    e.stopPropagation();
    const rect = btnEmoji.getBoundingClientRect();
    emojiPopover.style.top = `${rect.top + window.scrollY - 230}px`;
    emojiPopover.style.left = `${rect.left + window.scrollX - 20}px`;
    emojiPopover.classList.toggle('show');
    hashtagsAutocompleteCard.classList.remove('show');
    networkDropdownMenu.classList.remove('show');
    scheduleMenu.classList.remove('show');
  });

  // Close menus on outer click
  document.addEventListener('click', (e) => {
    if (!e.target.closest('#networkDropdownMenu') && !e.target.closest('#networkSelectorTrigger')) {
      networkDropdownMenu.classList.remove('show');
    }
    if (!e.target.closest('#hashtagsAutocompleteCard') && !e.target.closest('#btnHashtag')) {
      hashtagsAutocompleteCard.classList.remove('show');
    }
    if (!e.target.closest('#emojiPickerPopover') && !e.target.closest('#btnEmoji')) {
      emojiPopover.classList.remove('show');
    }
    if (!e.target.closest('#scheduleMenu') && !e.target.closest('#btnScheduleDropdown')) {
      scheduleMenu.classList.remove('show');
    }
  });

  // --- Schedule Dropdown ---
  btnScheduleDropdown.addEventListener('click', (e) => {
    e.stopPropagation();
    const rect = btnScheduleDropdown.getBoundingClientRect();
    scheduleMenu.style.top = `${rect.top + window.scrollY - 120}px`;
    scheduleMenu.style.left = `${rect.right + window.scrollX - 190}px`;
    scheduleMenu.classList.toggle('show');
    networkDropdownMenu.classList.remove('show');
    hashtagsAutocompleteCard.classList.remove('show');
  });

  document.querySelectorAll('.schedule-option-item').forEach(item => {
    item.addEventListener('click', () => {
      const mode = item.dataset.mode;
      selectedPublishAction = mode;
      if (mode === 'schedule') {
        btnSchedule.innerText = 'Agendamento';
      } else if (mode === 'publish_now') {
        btnSchedule.innerText = 'Publicar agora';
      } else if (mode === 'draft') {
        btnSchedule.innerText = 'Salvar rascunho';
      }
      scheduleMenu.classList.remove('show');
    });
  });

  // --- Date Picker Modal ---
  btnDateTime.addEventListener('click', () => {
    datePickerModal.classList.add('active');
  });

  document.getElementById('btnApplyDate').addEventListener('click', () => {
    const dateInput = document.getElementById('scheduledDateInput').value;
    const timeInput = document.getElementById('scheduledTimeInput').value;
    if (dateInput && timeInput) {
      const d = new Date(`${dateInput}T${timeInput}`);
      const options = { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' };
      displayDate.innerText = d.toLocaleDateString('pt-BR', options).replace(',', '');
    }
    datePickerModal.classList.remove('active');
    showToast('Data de agendamento atualizada.', 'info');
  });

  document.getElementById('btnCloseDatePicker').addEventListener('click', () => {
    datePickerModal.classList.remove('active');
  });

  function ensureFutureScheduleDefault() {
    const dateInput = document.getElementById('scheduledDateInput');
    const timeInput = document.getElementById('scheduledTimeInput');
    const configured = new Date(`${dateInput.value}T${timeInput.value}`);
    if (!dateInput.value || !timeInput.value || Number.isNaN(configured.getTime()) || configured <= new Date()) {
      const next = new Date(Date.now() + 15 * 60 * 1000);
      const localDate = [next.getFullYear(), String(next.getMonth() + 1).padStart(2, '0'), String(next.getDate()).padStart(2, '0')].join('-');
      const localTime = [String(next.getHours()).padStart(2, '0'), String(next.getMinutes()).padStart(2, '0')].join(':');
      dateInput.value = localDate;
      timeInput.value = localTime;
      displayDate.innerText = next.toLocaleDateString('pt-BR', {
        day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit'
      }).replace(',', '');
    }
  }

  ensureFutureScheduleDefault();

  // --- First Comment Modal ---
  btnFirstComment.addEventListener('click', () => {
    firstCommentModal.classList.add('active');
  });

  document.getElementById('btnSaveFirstComment').addEventListener('click', () => {
    const commentText = document.getElementById('firstCommentInput').value.trim();
    if (commentText) {
      btnFirstComment.classList.add('active-tool');
      showToast('Primeiro comentário configurado!', 'info');
    } else {
      btnFirstComment.classList.remove('active-tool');
    }
    firstCommentModal.classList.remove('active');
  });

  document.getElementById('btnCloseFirstComment').addEventListener('click', () => {
    firstCommentModal.classList.remove('active');
  });

  // --- Notes Modal ---
  btnNotes.addEventListener('click', () => {
    notesModal.classList.add('active');
  });

  document.getElementById('btnSaveNotes').addEventListener('click', () => {
    notesModal.classList.remove('active');
    showToast('Observações salvas.', 'info');
  });

  document.getElementById('btnCloseNotes').addEventListener('click', () => {
    notesModal.classList.remove('active');
  });

  // --- Mobile / Desktop / Eye / Grid Toggle ---
  btnToggleEye.addEventListener('click', () => {
    btnToggleEye.classList.toggle('active');
    const overlay = document.querySelector('.reels-overlay-content');
    const topBar = document.querySelector('.reels-top-bar');
    if (btnToggleEye.classList.contains('active')) {
      overlay.style.opacity = '0';
      topBar.style.opacity = '0';
    } else {
      overlay.style.opacity = '1';
      topBar.style.opacity = '1';
    }
  });

  btnToggleMobile.addEventListener('click', () => {
    btnToggleMobile.classList.add('active');
    btnToggleDesktop.classList.remove('active');
    reelPhoneFrame.style.maxWidth = '340px';
  });

  btnToggleDesktop.addEventListener('click', () => {
    btnToggleDesktop.classList.add('active');
    btnToggleMobile.classList.remove('active');
    reelPhoneFrame.style.maxWidth = '400px';
  });

  btnGridPreview.addEventListener('click', () => {
    showToast('Alternando visualização da grade do Instagram.', 'info');
  });

  if (btnShowPreviewMobile) {
    btnShowPreviewMobile.addEventListener('click', () => {
      plannerRightCol.classList.toggle('mobile-active');
    });
  }

  // --- Tab Navigation: Criar Publicação vs Agendamentos vs Análises ---
  const tabBtnPlanner = document.getElementById('tabBtnPlanner');
  const tabBtnAgendamentos = document.getElementById('tabBtnAgendamentos');
  const tabBtnAnalises = document.getElementById('tabBtnAnalises');
  const viewPlanner = document.getElementById('viewPlanner');
  const viewAgendamentos = document.getElementById('viewAgendamentos');
  const viewAnalises = document.getElementById('viewAnalises');
  const btnGoToPlanner = document.getElementById('btnGoToPlanner');
  const agendamentosCountBadge = document.getElementById('agendamentosCountBadge');

  function switchTab(tabName) {
    if (tabBtnPlanner) tabBtnPlanner.classList.remove('active');
    if (tabBtnAgendamentos) tabBtnAgendamentos.classList.remove('active');
    if (tabBtnAnalises) tabBtnAnalises.classList.remove('active');
    if (viewPlanner) viewPlanner.classList.remove('active');
    if (viewAgendamentos) viewAgendamentos.classList.remove('active');
    if (viewAnalises) viewAnalises.classList.remove('active');

    if (tabName === 'planner') {
      if (tabBtnPlanner) tabBtnPlanner.classList.add('active');
      if (viewPlanner) viewPlanner.classList.add('active');
    } else if (tabName === 'agendamentos') {
      if (tabBtnAgendamentos) tabBtnAgendamentos.classList.add('active');
      if (viewAgendamentos) viewAgendamentos.classList.add('active');
      renderCalendar();
      renderListView();
    } else if (tabName === 'analises') {
      if (tabBtnAnalises) tabBtnAnalises.classList.add('active');
      if (viewAnalises) viewAnalises.classList.add('active');
      if (window.AnalisesModule) {
        window.AnalisesModule.init();
      }
    }
  }

  if (tabBtnPlanner) tabBtnPlanner.addEventListener('click', () => switchTab('planner'));
  if (tabBtnAgendamentos) tabBtnAgendamentos.addEventListener('click', () => switchTab('agendamentos'));
  if (tabBtnAnalises) tabBtnAnalises.addEventListener('click', () => switchTab('analises'));
  if (btnGoToPlanner) {
    btnGoToPlanner.addEventListener('click', () => switchTab('planner'));
  }

  // --- Scheduled Posts Data Store ---
  let scheduledPosts = [
    {
      id: 'post-3',
      date: '2026-09-26',
      time: '12:30',
      type: 'post',
      typeLabel: 'Post',
      media: 'assets/avatar.jpg',
      isVideo: false,
      caption: 'Look especial do fim de semana ✨ Como está o dia de vocês?',
      status: 'Agendado'
    }
  ];

  function updateScheduleBadge() {
    if (agendamentosCountBadge) {
      agendamentosCountBadge.innerText = scheduledPosts.filter(post => scheduleStatusKey(post) === 'scheduled').length;
    }
  }

  function normalizeBackendSchedule(record) {
    const scheduledAt = new Date(record.scheduled_at);
    const hasValidDate = !Number.isNaN(scheduledAt.getTime());
    const statusLabels = {
      scheduled: 'Agendado',
      processing: 'Publicando',
      published: 'Publicado',
      failed: 'Falhou'
    };
    const isTrialReel = record.type === 'test_reel';
    return {
      id: record.id,
      date: hasValidDate ? scheduledAt.toLocaleDateString('sv-SE') : '—',
      time: hasValidDate ? scheduledAt.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : '—',
      type: isTrialReel ? 'test_reel' : 'story',
      typeLabel: isTrialReel ? 'REELS DE TESTE' : 'STORY',
      media: `/media/${encodeURIComponent(record.media_filename)}`,
      isVideo: record.media_kind === 'video',
      caption: record.caption || '(Story sem legenda)',
      status: statusLabels[record.status] || record.status,
      backendStatus: record.status,
      graduationStrategy: record.graduation_strategy || 'MANUAL',
      scheduledAt: record.scheduled_at
    };
  }

  let backendSchedulesLoaded = false;
  let scheduleSyncInFlight = false;

  async function loadSchedules() {
    if (scheduleSyncInFlight) return;
    scheduleSyncInFlight = true;
    try {
      const response = await fetch('/api/schedules', {
        headers: { Accept: 'application/json' },
        cache: 'no-store'
      });
      if (!response.ok) return;
      const payload = await response.json();
      if (Array.isArray(payload.schedules)) {
        const receivedPosts = payload.schedules.map(normalizeBackendSchedule);
        if (!backendSchedulesLoaded) {
          scheduledPosts = receivedPosts;
          backendSchedulesLoaded = true;
          updateScheduleBadge();
          renderCalendar();
          renderListView();
          return;
        }

        const knownIds = new Set(scheduledPosts.map(post => post.id));
        const newScheduledPosts = receivedPosts.filter(post => (
          post.backendStatus === 'scheduled' && !knownIds.has(post.id)
        ));
        if (newScheduledPosts.length === 0) return;

        scheduledPosts = [...newScheduledPosts, ...scheduledPosts];
        updateScheduleBadge();
        if (viewAgendamentos.classList.contains('active')) {
          if (!calendarGridView.classList.contains('hidden')) {
            newScheduledPosts.forEach(appendScheduleToCalendar);
          }
          if (!calendarListView.classList.contains('hidden')) {
            appendScheduleRows(newScheduledPosts);
          }
        }
        showToast(newScheduledPosts.length === 1
          ? 'Novo agendamento recebido.'
          : `${newScheduledPosts.length} novos agendamentos recebidos.`, 'info');
      }
    } catch (error) {
      // The planner still opens in mock mode when the backend is not running.
    } finally {
      scheduleSyncInFlight = false;
    }
  }

  // --- Calendar Date State (September 2026) ---
  let calCurrentYear = 2026;
  let calCurrentMonth = 8; // 0-indexed: 8 is September
  let currentFilter = 'all';
  const selectedStatusFilters = new Set(['scheduled']);

  const monthNames = [
    'Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho',
    'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'
  ];

  const calendarCurrentMonthLabel = document.getElementById('calendarCurrentMonthLabel');
  const calendarMonthGrid = document.getElementById('calendarMonthGrid');
  const scheduleTableBody = document.getElementById('scheduleTableBody');
  let quickEditPostId = null;
  const calendarStatusFilter = document.getElementById('calendarStatusFilter');
  const btnStatusFilter = document.getElementById('btnStatusFilter');
  const statusFilterMenu = document.getElementById('statusFilterMenu');
  const statusFilterSummary = document.getElementById('statusFilterSummary');

  // Month navigation
  document.getElementById('btnCalPrevMonth').addEventListener('click', () => {
    calCurrentMonth--;
    if (calCurrentMonth < 0) {
      calCurrentMonth = 11;
      calCurrentYear--;
    }
    renderCalendar();
  });

  document.getElementById('btnCalNextMonth').addEventListener('click', () => {
    calCurrentMonth++;
    if (calCurrentMonth > 11) {
      calCurrentMonth = 0;
      calCurrentYear++;
    }
    renderCalendar();
  });

  document.getElementById('btnCalToday').addEventListener('click', () => {
    calCurrentYear = 2026;
    calCurrentMonth = 8; // Setembro 2026
    renderCalendar();
  });

  // Filters
  document.querySelectorAll('.filter-pill').forEach(pill => {
    if (pill.closest('#calendarStatusFilter')) return;
    pill.addEventListener('click', () => {
      document.querySelectorAll('.filter-pill').forEach(p => p.classList.remove('active'));
      pill.classList.add('active');
      currentFilter = pill.dataset.filter;
      renderCalendar();
      renderListView();
    });
  });

  const statusFilterLabels = {
    scheduled: 'Agendado',
    processing: 'Publicando',
    published: 'Publicado',
    failed: 'Falhou'
  };

  function updateStatusFilterSummary() {
    const selected = [...selectedStatusFilters];
    if (selected.length === 0) statusFilterSummary.innerText = 'Nenhum';
    else if (selected.length === 1) statusFilterSummary.innerText = statusFilterLabels[selected[0]];
    else if (selected.length === Object.keys(statusFilterLabels).length) statusFilterSummary.innerText = 'Todos';
    else statusFilterSummary.innerText = `${selected.length} selecionados`;
  }

  function closeStatusFilterMenu() {
    statusFilterMenu.classList.remove('open');
    statusFilterMenu.setAttribute('aria-hidden', 'true');
    btnStatusFilter.setAttribute('aria-expanded', 'false');
  }

  btnStatusFilter.addEventListener('click', (event) => {
    event.stopPropagation();
    const isOpening = !statusFilterMenu.classList.contains('open');
    statusFilterMenu.classList.toggle('open', isOpening);
    statusFilterMenu.setAttribute('aria-hidden', String(!isOpening));
    btnStatusFilter.setAttribute('aria-expanded', String(isOpening));
  });

  statusFilterMenu.querySelectorAll('[data-status-filter]').forEach(checkbox => {
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) selectedStatusFilters.add(checkbox.dataset.statusFilter);
      else selectedStatusFilters.delete(checkbox.dataset.statusFilter);
      updateStatusFilterSummary();
      renderCalendar();
      renderListView();
    });
  });

  document.addEventListener('click', (event) => {
    if (!calendarStatusFilter.contains(event.target)) closeStatusFilterMenu();
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && statusFilterMenu.classList.contains('open')) {
      closeStatusFilterMenu();
      btnStatusFilter.focus();
    }
  });

  updateStatusFilterSummary();

  // Mode toggle (Calendar vs List)
  const btnModeCalendar = document.getElementById('btnModeCalendar');
  const btnModeList = document.getElementById('btnModeList');
  const calendarGridView = document.getElementById('calendarGridView');
  const calendarListView = document.getElementById('calendarListView');

  btnModeCalendar.addEventListener('click', () => {
    btnModeCalendar.classList.add('active');
    btnModeList.classList.remove('active');
    calendarGridView.classList.remove('hidden');
    calendarListView.classList.add('hidden');
  });

  btnModeList.addEventListener('click', () => {
    btnModeList.classList.add('active');
    btnModeCalendar.classList.remove('active');
    calendarListView.classList.remove('hidden');
    calendarGridView.classList.add('hidden');
    renderListView();
  });

  function calendarPostCardMarkup(post, isNew = false) {
    let typeClass = 'type-pill-reel';
    let typeIcon = 'fa-film';
    if (post.type === 'test_reel') {
      typeClass = 'type-pill-test';
      typeIcon = 'fa-clapperboard';
    } else if (post.type === 'post') {
      typeClass = 'type-pill-post';
      typeIcon = 'fa-table-cells';
    } else if (post.type === 'story') {
      typeClass = 'type-pill-story';
      typeIcon = 'fa-circle-dot';
    }

    return `
      <div class="schedule-card${isNew ? ' schedule-card-live-insert' : ''}" data-id="${escapeHtml(post.id)}">
        <div class="schedule-card-thumb">
          ${post.isVideo ? `<video src="${escapeHtml(post.media)}" muted></video>` : `<img src="${escapeHtml(post.media)}" alt="Capa">`}
          <div class="thumb-type-icon">
            <i class="fa-solid ${typeIcon}"></i>
          </div>
        </div>
        <div class="schedule-card-details">
          <div class="schedule-card-top-row">
            <span class="schedule-card-time">${escapeHtml(post.time)}</span>
            <i class="fa-brands fa-instagram schedule-card-network"></i>
          </div>
          <span class="schedule-card-type-pill ${typeClass}">${escapeHtml(post.typeLabel)}</span>
          <div class="schedule-card-caption-preview">${escapeHtml(post.caption)}</div>
        </div>
      </div>
    `;
  }

  // --- Render Calendar Grid ---
  function renderCalendar() {
    calendarCurrentMonthLabel.innerText = `${monthNames[calCurrentMonth]} ${calCurrentYear}`;
    calendarMonthGrid.innerHTML = '';
    const visiblePosts = getFilteredPosts().slice().sort((a, b) => scheduleTimestamp(b) - scheduleTimestamp(a));

    const firstDayIndex = new Date(calCurrentYear, calCurrentMonth, 1).getDay();
    const daysInMonth = new Date(calCurrentYear, calCurrentMonth + 1, 0).getDate();
    const daysInPrevMonth = new Date(calCurrentYear, calCurrentMonth, 0).getDate();

    // 1. Previous month trailing days
    for (let i = firstDayIndex - 1; i >= 0; i--) {
      const dayNum = daysInPrevMonth - i;
      const cell = document.createElement('div');
      cell.className = 'calendar-cell other-month';
      cell.innerHTML = `
        <div class="cell-date-header">
          <span class="cell-day-num text-gray-400">${dayNum}</span>
        </div>
      `;
      calendarMonthGrid.appendChild(cell);
    }

    // 2. Current month days
    for (let day = 1; day <= daysInMonth; day++) {
      const dateStr = `${calCurrentYear}-${String(calCurrentMonth + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      const isToday = (calCurrentYear === 2026 && calCurrentMonth === 8 && day === 22);

      const cell = document.createElement('div');
      cell.className = `calendar-cell ${isToday ? 'today' : ''}`;
      cell.dataset.date = dateStr;
      
      const postsForDay = visiblePosts.filter(p => p.date === dateStr);
      const postsHtml = postsForDay.map(post => calendarPostCardMarkup(post)).join('');

      cell.innerHTML = `
        <div class="cell-date-header">
          <span class="cell-day-num">${day}</span>
          ${postsForDay.length > 0 ? `<span class="calendar-day-count text-[10px] font-bold text-blue-600 bg-blue-50 px-1.5 py-0.5 rounded-full">${postsForDay.length}</span>` : ''}
        </div>
        <div class="cell-posts-list">
          ${postsHtml}
        </div>
      `;

      calendarMonthGrid.appendChild(cell);
    }

    // 3. Next month leading days to complete grid (up to 35 or 42)
    const totalCells = firstDayIndex + daysInMonth;
    const remainingCells = (totalCells > 35 ? 42 : 35) - totalCells;
    for (let day = 1; day <= remainingCells; day++) {
      const cell = document.createElement('div');
      cell.className = 'calendar-cell other-month';
      cell.innerHTML = `
        <div class="cell-date-header">
          <span class="cell-day-num text-gray-400">${day}</span>
        </div>
      `;
      calendarMonthGrid.appendChild(cell);
    }

  }

  function appendScheduleToCalendar(post) {
    if (!postMatchesCurrentFilters(post)) return;
    const cell = [...calendarMonthGrid.querySelectorAll('.calendar-cell[data-date]')]
      .find(calendarCell => calendarCell.dataset.date === post.date);
    if (!cell) return;

    const cards = cell.querySelector('.cell-posts-list');
    const template = document.createElement('template');
    template.innerHTML = calendarPostCardMarkup(post, true).trim();
    const newCard = template.content.firstElementChild;
    const insertBefore = [...cards.querySelectorAll('.schedule-card')].find(card => {
      const existingPost = scheduledPosts.find(item => item.id === card.dataset.id);
      return existingPost && scheduleTimestamp(post) > scheduleTimestamp(existingPost);
    });
    cards.insertBefore(newCard, insertBefore || null);
    const count = cards.querySelectorAll('.schedule-card').length;
    let countBadge = cell.querySelector('.calendar-day-count');
    if (!countBadge) {
      countBadge = document.createElement('span');
      countBadge.className = 'calendar-day-count text-[10px] font-bold text-blue-600 bg-blue-50 px-1.5 py-0.5 rounded-full';
      cell.querySelector('.cell-date-header').appendChild(countBadge);
    }
    countBadge.innerText = count;
  }

  calendarMonthGrid.addEventListener('click', event => {
    const card = event.target.closest('.schedule-card');
    if (!card || !calendarMonthGrid.contains(card)) return;
    event.stopPropagation();
    const post = scheduledPosts.find(item => item.id === card.dataset.id);
    if (post) openPostDetail(post);
  });

  function postMatchesCurrentFilters(post) {
    const statusKey = post.backendStatus || ({
        Agendado: 'scheduled',
        Publicando: 'processing',
        Publicado: 'published',
        Falhou: 'failed'
      })[post.status] || 'scheduled';
    if (!selectedStatusFilters.has(statusKey)) return false;
    if (currentFilter === 'all') return true;
    if (currentFilter === 'reel') return post.type === 'reel' || post.type === 'test_reel';
    return post.type === currentFilter;
  }

  function getFilteredPosts() {
    return scheduledPosts.filter(postMatchesCurrentFilters);
  }

  // --- Render List View ---
  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, character => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[character]);
  }

  function postLocalDateTime(post) {
    const scheduledAt = post.scheduledAt ? new Date(post.scheduledAt) : null;
    if (scheduledAt && !Number.isNaN(scheduledAt.getTime())) {
      const date = [scheduledAt.getFullYear(), String(scheduledAt.getMonth() + 1).padStart(2, '0'), String(scheduledAt.getDate()).padStart(2, '0')].join('-');
      const time = `${String(scheduledAt.getHours()).padStart(2, '0')}:${String(scheduledAt.getMinutes()).padStart(2, '0')}`;
      return { date, time };
    }
    return { date: post.date, time: post.time };
  }

  function scheduleDateKey(post) {
    return postLocalDateTime(post).date || '—';
  }

  function scheduleTimestamp(post) {
    const localDateTime = postLocalDateTime(post);
    const timestamp = new Date(`${localDateTime.date}T${localDateTime.time}`).getTime();
    return Number.isNaN(timestamp) ? 0 : timestamp;
  }

  function formatScheduleGroupDate(dateKey) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) return 'Data não definida';
    return new Date(`${dateKey}T12:00:00`).toLocaleDateString('pt-BR', {
      weekday: 'long', day: '2-digit', month: 'long', year: 'numeric'
    });
  }

  function createScheduleDateDivider(dateKey, count) {
    const divider = document.createElement('tr');
    divider.className = 'schedule-date-divider-row';
    divider.dataset.scheduleDateKey = dateKey;
    divider.dataset.scheduleDateCount = String(count);
    divider.innerHTML = `
      <td colspan="7">
        <div class="schedule-date-divider-content">
          <span>${escapeHtml(formatScheduleGroupDate(dateKey))}</span>
          <span class="schedule-date-divider-count">${count} ${count === 1 ? 'publicação' : 'publicações'}</span>
        </div>
      </td>
    `;
    return divider;
  }

  function updateScheduleDateDividerCount(divider, increment = 1) {
    const count = Number(divider.dataset.scheduleDateCount || 0) + increment;
    divider.dataset.scheduleDateCount = String(count);
    divider.querySelector('.schedule-date-divider-count').innerText = `${count} ${count === 1 ? 'publicação' : 'publicações'}`;
  }

  function canEditPost(post) {
    return (post.backendStatus || post.status) === 'scheduled' || post.status === 'Agendado';
  }

  function scheduleStatusKey(post) {
    return post.backendStatus || ({
      Agendado: 'scheduled',
      Publicando: 'processing',
      Publicado: 'published',
      Falhou: 'failed'
    })[post.status] || 'scheduled';
  }

  function scheduleStatusColor(post) {
    const colors = {
      scheduled: 'bg-blue-50 text-blue-700',
      processing: 'bg-amber-50 text-amber-700',
      published: 'bg-green-50 text-green-700',
      failed: 'bg-red-50 text-red-700'
    };
    return colors[scheduleStatusKey(post)] || colors.scheduled;
  }

  async function saveScheduleEdit(id, date, time, caption) {
    const post = scheduledPosts.find(item => item.id === id);
    if (!post || !date || !time) {
      showToast('Informe a data e o horário.', 'warning');
      return false;
    }
    const scheduledAt = new Date(`${date}T${time}`);
    if (Number.isNaN(scheduledAt.getTime()) || scheduledAt <= new Date()) {
      showToast('Escolha uma data e um horário futuros.', 'warning');
      return false;
    }
    if (caption.length > 2200) {
      showToast('A legenda pode ter no máximo 2.200 caracteres.', 'warning');
      return false;
    }

    try {
      if (post.scheduledAt) {
        const response = await fetch(`/api/schedules/${encodeURIComponent(id)}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({ scheduled_at: scheduledAt.toISOString(), caption })
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(payload.message || payload.error || 'Não foi possível salvar as alterações.');
        const index = scheduledPosts.findIndex(item => item.id === id);
        scheduledPosts[index] = normalizeBackendSchedule(payload.schedule);
      } else {
        post.date = date;
        post.time = time;
        post.caption = caption.trim();
      }
      quickEditPostId = null;
      updateScheduleBadge();
      renderListView();
      renderCalendar();
      showToast('Agendamento atualizado.', 'success');
      return true;
    } catch (error) {
      showToast(error.message || 'Não foi possível salvar as alterações.', 'warning');
      return false;
    }
  }

  function createScheduleTableRow(post, isNew = false) {
    let typeClass = 'type-pill-reel';
    if (post.type === 'test_reel') typeClass = 'type-pill-test';
    else if (post.type === 'post') typeClass = 'type-pill-post';
    else if (post.type === 'story') typeClass = 'type-pill-story';

    const date = new Date(`${post.date}T${post.time}`);
    const formattedDate = date.toLocaleDateString('pt-BR', { day: '2-digit', month: 'short', year: 'numeric' });
    const isQuickEditing = quickEditPostId === post.id;
    const localDateTime = postLocalDateTime(post);
    const tr = document.createElement('tr');
    tr.dataset.scheduleId = post.id;
    if (isNew) tr.classList.add('schedule-row-live-insert');
    tr.innerHTML = `
      <td>
        <div class="table-thumb">
          ${post.isVideo ? `<video src="${escapeHtml(post.media)}" muted></video>` : `<img src="${escapeHtml(post.media)}" alt="Capa">`}
        </div>
      </td>
      <td>
        <span class="schedule-card-type-pill ${typeClass} text-xs px-2 py-1">${escapeHtml(post.typeLabel)}</span>
      </td>
      <td>
        ${isQuickEditing ? `
          <label class="sr-only" for="quickEditDate-${escapeHtml(post.id)}">Data</label>
          <input id="quickEditDate-${escapeHtml(post.id)}" type="date" class="mb-1 w-full rounded border border-gray-300 px-2 py-1 text-xs" value="${escapeHtml(localDateTime.date)}">
          <label class="sr-only" for="quickEditTime-${escapeHtml(post.id)}">Horário</label>
          <input id="quickEditTime-${escapeHtml(post.id)}" type="time" class="w-full rounded border border-gray-300 px-2 py-1 text-xs" value="${escapeHtml(localDateTime.time)}">
        ` : `
          <div class="font-semibold text-gray-900">${escapeHtml(post.time)}</div>
          <div class="text-xs text-gray-500">${escapeHtml(formattedDate)}</div>
        `}
      </td>
      <td>
        <div class="flex items-center gap-1.5">
          <i class="fa-brands fa-instagram text-pink-600 text-sm"></i>
          <span class="text-xs font-semibold text-gray-800">alesantorooficial</span>
        </div>
      </td>
      <td>
        ${isQuickEditing ? `
          <label class="sr-only" for="quickEditCaption-${escapeHtml(post.id)}">Legenda e hashtags</label>
          <textarea id="quickEditCaption-${escapeHtml(post.id)}" rows="3" maxlength="2200" class="w-full min-w-48 rounded border border-gray-300 px-2 py-1 text-xs">${escapeHtml(post.caption)}</textarea>
        ` : `<div class="text-xs text-gray-700 max-w-xs truncate">${escapeHtml(post.caption)}</div>`}
      </td>
      <td>
        <span class="schedule-status-badge text-xs font-semibold px-2 py-1 rounded-full ${scheduleStatusColor(post)}">${escapeHtml(post.status)}</span>
      </td>
      <td class="schedule-actions-cell">
        ${isQuickEditing ? `
          <button type="button" class="btn-save-quick-edit px-2 py-1 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 rounded" data-id="${escapeHtml(post.id)}">Salvar</button>
          <button type="button" class="btn-cancel-quick-edit px-2 py-1 text-xs font-semibold text-gray-600 hover:bg-gray-100 rounded" data-id="${escapeHtml(post.id)}">Cancelar</button>
        ` : `
          <div class="schedule-row-actions" role="group" aria-label="Ações da publicação">
            <button type="button" class="schedule-row-action schedule-row-action-view btn-view-post" data-id="${escapeHtml(post.id)}">Ver</button>
            ${canEditPost(post) ? `<button type="button" class="schedule-row-action schedule-row-action-edit btn-quick-edit" data-id="${escapeHtml(post.id)}" title="Editar rápido" aria-label="Editar publicação"><i class="fa-solid fa-pen" aria-hidden="true"></i></button>` : ''}
            <button type="button" class="schedule-row-action schedule-row-action-delete btn-delete-post" data-id="${escapeHtml(post.id)}" title="Excluir publicação" aria-label="Excluir publicação"><i class="fa-solid fa-trash-can" aria-hidden="true"></i></button>
          </div>
        `}
      </td>
    `;
    return tr;
  }

  function appendScheduleRows(posts) {
    const visiblePosts = posts
      .filter(postMatchesCurrentFilters)
      .sort((a, b) => scheduleTimestamp(b) - scheduleTimestamp(a));
    if (visiblePosts.length === 0) return;
    scheduleTableBody.querySelector('[data-schedule-empty]')?.remove();

    visiblePosts.forEach(post => {
      const dateKey = scheduleDateKey(post);
      const dateDividers = [...scheduleTableBody.querySelectorAll('.schedule-date-divider-row')];
      let divider = dateDividers.find(item => item.dataset.scheduleDateKey === dateKey);
      const row = createScheduleTableRow(post, true);

      if (!divider) {
        divider = createScheduleDateDivider(dateKey, 1);
        const firstOlderDivider = dateDividers.find(item => item.dataset.scheduleDateKey < dateKey);
        if (firstOlderDivider) {
          scheduleTableBody.insertBefore(divider, firstOlderDivider);
          scheduleTableBody.insertBefore(row, firstOlderDivider);
        } else {
          scheduleTableBody.append(divider, row);
        }
        return;
      }

      let sibling = divider.nextElementSibling;
      let insertBefore = null;
      while (sibling && !sibling.classList.contains('schedule-date-divider-row')) {
        const existingPost = scheduledPosts.find(item => item.id === sibling.dataset.scheduleId);
        if (existingPost && scheduleTimestamp(post) > scheduleTimestamp(existingPost)) {
          insertBefore = sibling;
          break;
        }
        sibling = sibling.nextElementSibling;
      }
      scheduleTableBody.insertBefore(row, insertBefore || sibling);
      updateScheduleDateDividerCount(divider);
    });
  }

  function renderListView() {
    scheduleTableBody.replaceChildren();
    const filtered = getFilteredPosts();

    if (filtered.length === 0) {
      scheduleTableBody.innerHTML = `
        <tr data-schedule-empty>
          <td colspan="7" class="text-center py-8 text-gray-400">Nenhuma publicação corresponde aos filtros selecionados.</td>
        </tr>
      `;
      return;
    }

    const orderedPosts = filtered.slice().sort((a, b) => scheduleTimestamp(b) - scheduleTimestamp(a));
    const postsByDate = new Map();
    orderedPosts.forEach(post => {
      const dateKey = scheduleDateKey(post);
      if (!postsByDate.has(dateKey)) postsByDate.set(dateKey, []);
      postsByDate.get(dateKey).push(post);
    });

    postsByDate.forEach((posts, dateKey) => {
      scheduleTableBody.appendChild(createScheduleDateDivider(dateKey, posts.length));
      posts.forEach(post => scheduleTableBody.appendChild(createScheduleTableRow(post)));
    });
  }

  scheduleTableBody.addEventListener('click', async event => {
    const button = event.target.closest('button[data-id]');
    if (!button || !scheduleTableBody.contains(button)) return;
    const id = button.dataset.id;

    if (button.classList.contains('btn-view-post')) {
      const post = scheduledPosts.find(item => item.id === id);
      if (post) openPostDetail(post);
    } else if (button.classList.contains('btn-quick-edit')) {
      quickEditPostId = id;
      renderListView();
    } else if (button.classList.contains('btn-cancel-quick-edit')) {
      quickEditPostId = null;
      renderListView();
    } else if (button.classList.contains('btn-save-quick-edit')) {
      const date = document.getElementById(`quickEditDate-${id}`).value;
      const time = document.getElementById(`quickEditTime-${id}`).value;
      const caption = document.getElementById(`quickEditCaption-${id}`).value;
      await saveScheduleEdit(id, date, time, caption);
    } else if (button.classList.contains('btn-delete-post') && confirm('Deseja excluir este agendamento?')) {
      if (id.startsWith('story-')) {
        try {
          await fetch(`/api/schedules/${encodeURIComponent(id)}`, { method: 'DELETE' });
        } catch (error) {
          showToast('Não foi possível sincronizar a exclusão com o backend.', 'warning');
        }
      }
      scheduledPosts = scheduledPosts.filter(post => post.id !== id);
      updateScheduleBadge();
      renderListView();
      renderCalendar();
      showToast('Agendamento excluído.', 'info');
    }
  });

  // --- Post Detail Modal ---
  const postDetailModal = document.getElementById('postDetailModal');
  const modalDetailType = document.getElementById('modalDetailType');
  const modalDetailStatus = document.getElementById('modalDetailStatus');
  const modalDetailVideo = document.getElementById('modalDetailVideo');
  const modalDetailImage = document.getElementById('modalDetailImage');
  const modalDetailDateTime = document.getElementById('modalDetailDateTime');
  const modalDetailCaption = document.getElementById('modalDetailCaption');
  const btnEditFromModal = document.getElementById('btnEditFromModal');
  const btnSavePostEdit = document.getElementById('btnSavePostEdit');
  const btnCancelPostEdit = document.getElementById('btnCancelPostEdit');
  const btnClosePostDetail = document.getElementById('btnClosePostDetail');
  const modalEditDateTimeFields = document.getElementById('modalEditDateTimeFields');
  const modalEditCaptionField = document.getElementById('modalEditCaptionField');
  const modalEditDate = document.getElementById('modalEditDate');
  const modalEditTime = document.getElementById('modalEditTime');
  const modalEditCaption = document.getElementById('modalEditCaption');
  let selectedPostInModal = null;

  function setPostDetailEditing(isEditing) {
    const editable = isEditing && selectedPostInModal && canEditPost(selectedPostInModal);
    modalDetailDateTime.classList.toggle('hidden', Boolean(editable));
    modalDetailCaption.classList.toggle('hidden', Boolean(editable));
    modalEditDateTimeFields.classList.toggle('hidden', !editable);
    modalEditCaptionField.classList.toggle('hidden', !editable);
    btnEditFromModal.classList.toggle('hidden', Boolean(editable) || !selectedPostInModal || !canEditPost(selectedPostInModal));
    btnSavePostEdit.classList.toggle('hidden', !editable);
    btnCancelPostEdit.classList.toggle('hidden', !editable);
  }

  function openPostDetail(post) {
    selectedPostInModal = post;
    const localDateTime = postLocalDateTime(post);
    modalEditDate.value = localDateTime.date;
    modalEditTime.value = localDateTime.time;
    modalEditCaption.value = post.caption || '';
    modalDetailType.innerText = post.typeLabel;
    modalDetailStatus.innerText = post.status;
    modalDetailStatus.className = `schedule-status-badge text-xs px-2 py-0.5 rounded-full font-semibold ${scheduleStatusColor(post)}`;
    const displayDate = new Date(`${localDateTime.date}T${localDateTime.time}`);
    modalDetailDateTime.innerText = `${displayDate.toLocaleDateString('pt-BR')} às ${localDateTime.time}`;
    modalDetailCaption.innerText = post.caption || '(Sem legenda)';
    setPostDetailEditing(false);

    if (post.isVideo) {
      modalDetailImage.classList.add('hidden');
      modalDetailVideo.src = post.media;
      modalDetailVideo.classList.remove('hidden');
      modalDetailVideo.currentTime = 0;
    } else {
      modalDetailVideo.classList.add('hidden');
      modalDetailVideo.pause();
      modalDetailImage.src = post.media;
      modalDetailImage.classList.remove('hidden');
    }

    postDetailModal.classList.add('active');
  }

  btnEditFromModal.addEventListener('click', () => {
    if (!selectedPostInModal || !canEditPost(selectedPostInModal)) return;
    const localDateTime = postLocalDateTime(selectedPostInModal);
    modalEditDate.value = localDateTime.date;
    modalEditTime.value = localDateTime.time;
    modalEditCaption.value = selectedPostInModal.caption || '';
    setPostDetailEditing(true);
  });

  btnSavePostEdit.addEventListener('click', async () => {
    if (!selectedPostInModal) return;
    const saved = await saveScheduleEdit(
      selectedPostInModal.id,
      modalEditDate.value,
      modalEditTime.value,
      modalEditCaption.value
    );
    if (!saved) return;
    selectedPostInModal = scheduledPosts.find(post => post.id === selectedPostInModal.id) || null;
    if (selectedPostInModal) openPostDetail(selectedPostInModal);
    else postDetailModal.classList.remove('active');
  });

  btnCancelPostEdit.addEventListener('click', () => setPostDetailEditing(false));
  btnClosePostDetail.addEventListener('click', () => postDetailModal.classList.remove('active'));

  // --- Schedule Button Action ---
  function formatUploadBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes < 0) return '0 B';
    if (bytes < 1024) return `${Math.round(bytes)} B`;
    const units = ['KB', 'MB', 'GB', 'TB'];
    let value = bytes / 1024;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
      value /= 1024;
      unit += 1;
    }
    return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unit]}`;
  }

  function setUploadProgress(percent) {
    const determinate = Number.isFinite(percent);
    const boundedPercent = determinate ? Math.max(0, Math.min(100, Math.round(percent))) : null;
    uploadProgressCard.classList.toggle('is-indeterminate', !determinate);
    uploadProgressPercent.innerText = determinate ? `${boundedPercent}%` : '…';
    uploadProgressRingValue.style.strokeDashoffset = determinate
      ? `${376.99 * (1 - boundedPercent / 100)}`
      : '300';
    const progressRing = uploadProgressRingValue.closest('.upload-progress-ring-wrap');
    if (determinate) {
      progressRing.setAttribute('aria-valuenow', String(boundedPercent));
    } else {
      progressRing.removeAttribute('aria-valuenow');
    }
  }

  function openUploadProgress(file, action, contentLabel) {
    const actionLabel = action === 'publish_now' ? 'publicação' : 'agendamento';
    uploadProgressCard.classList.remove('is-processing', 'is-complete', 'is-indeterminate');
    uploadProgressTitle.innerText = `Enviando ${contentLabel}`;
    uploadProgressStatus.innerText = `Enviando o arquivo para ${actionLabel}…`;
    uploadProgressPhase.innerText = 'ENVIO';
    uploadProgressFileName.innerText = file.name;
    uploadProgressFileSize.innerText = formatUploadBytes(file.size);
    uploadProgressTransferred.innerText = 'Aguardando dados';
    setUploadProgress(0);
    uploadProgressOverlay.hidden = false;
    uploadProgressCard.focus({ preventScroll: true });
  }

  function updateUploadProgress(event) {
    uploadProgressTransferred.innerText = event.lengthComputable
      ? `${formatUploadBytes(event.loaded)} de ${formatUploadBytes(event.total)}`
      : `${formatUploadBytes(event.loaded)} enviados`;
    setUploadProgress(event.lengthComputable && event.total > 0
      ? (event.loaded / event.total) * 100
      : null);
  }

  function showUploadServerProcessing(action, contentLabel) {
    uploadProgressCard.classList.remove('is-indeterminate');
    uploadProgressCard.classList.add('is-processing');
    uploadProgressTitle.innerText = action === 'publish_now'
      ? `Publicando ${contentLabel}`
      : `Concluindo ${contentLabel}`;
    uploadProgressStatus.innerText = action === 'publish_now'
      ? 'Arquivo enviado. Aguardando a confirmação da publicação…'
      : 'Arquivo enviado. Finalizando o agendamento…';
    uploadProgressPhase.innerText = 'PROCESSANDO';
    setUploadProgress(100);
  }

  function completeUploadProgress(message) {
    uploadProgressCard.classList.remove('is-processing', 'is-indeterminate');
    uploadProgressCard.classList.add('is-complete');
    uploadProgressTitle.innerText = message;
    uploadProgressStatus.innerText = 'O servidor confirmou a conclusão.';
    uploadProgressPhase.innerText = 'CONCLUÍDO';
    uploadProgressTransferred.innerText = `${uploadProgressFileSize.innerText} enviados`;
    setUploadProgress(100);
  }

  function closeUploadProgress() {
    uploadProgressOverlay.hidden = true;
    uploadProgressCard.classList.remove('is-processing', 'is-complete', 'is-indeterminate');
    if (!btnSchedule.disabled) btnSchedule.focus({ preventScroll: true });
  }

  function uploadFormDataWithProgress(endpoint, formData, file, action, contentLabel) {
    openUploadProgress(file, action, contentLabel);
    return new Promise((resolve, reject) => {
      const request = new XMLHttpRequest();
      request.open('POST', endpoint, true);
      request.upload.addEventListener('progress', updateUploadProgress);
      request.upload.addEventListener('load', (event) => {
        if (event.lengthComputable) updateUploadProgress(event);
        showUploadServerProcessing(action, contentLabel);
      });
      request.addEventListener('load', () => {
        let payload = {};
        try {
          payload = JSON.parse(request.responseText || '{}');
        } catch {
          payload = {};
        }
        if (request.status < 200 || request.status >= 300) {
          reject(new Error(payload.message || payload.error || `Não foi possível enviar ${contentLabel}.`));
          return;
        }
        if (!payload.story) {
          reject(new Error(`O servidor não confirmou o ${action === 'publish_now' ? 'envio' : 'agendamento'}.`));
          return;
        }
        resolve(payload);
      });
      request.addEventListener('error', () => reject(new Error('Não foi possível conectar ao servidor.')));
      request.addEventListener('abort', () => reject(new Error('O envio foi interrompido.')));
      request.send(formData);
    });
  }

  function waitForUploadCompletion() {
    return new Promise(resolve => setTimeout(resolve, 800));
  }

  async function submitStoryToBackend() {
    if (!currentMedia) {
      showToast('Selecione uma imagem JPG ou vídeo MP4 para o Story.', 'warning');
      return;
    }

    const action = selectedPublishAction;
    const formData = new FormData();
    formData.append('action', action);
    formData.append('caption', editor.innerText.trim());
    if (action === 'schedule') {
      const date = document.getElementById('scheduledDateInput').value;
      const time = document.getElementById('scheduledTimeInput').value;
      formData.append('scheduled_at', new Date(`${date}T${time}`).toISOString());
    }
    formData.append('media', currentMedia.file, currentMedia.file.name);

    btnSchedule.disabled = true;
    btnScheduleDropdown.disabled = true;
    try {
      const payload = await uploadFormDataWithProgress('/api/stories', formData, currentMedia.file, action, 'Story');
      const story = payload.story;
      scheduledPosts.unshift(normalizeBackendSchedule(story));
      updateScheduleBadge();
      renderCalendar();
      renderListView();
      const successMessage = action === 'publish_now' ? 'Story publicado com sucesso.' : 'Story agendado com sucesso.';
      completeUploadProgress(successMessage);
      showToast(successMessage, 'success');
      await waitForUploadCompletion();
    } catch (error) {
      showToast(error.message || 'Não foi possível conectar ao backend.', 'warning');
    } finally {
      btnSchedule.disabled = false;
      btnScheduleDropdown.disabled = false;
      closeUploadProgress();
    }
  }

  async function submitTrialReelToBackend() {
    if (!currentMedia || !currentMedia.isVideo) {
      showToast('Selecione o vídeo MP4 do Reel de teste.', 'warning');
      return;
    }

    const action = selectedPublishAction;
    const formData = new FormData();
    formData.append('action', action);
    formData.append('caption', editor.innerText.trim());
    formData.append('graduation_strategy', 'MANUAL');
    if (action === 'schedule') {
      const date = document.getElementById('scheduledDateInput').value;
      const time = document.getElementById('scheduledTimeInput').value;
      formData.append('scheduled_at', new Date(`${date}T${time}`).toISOString());
    }
    formData.append('media', currentMedia.file, currentMedia.file.name);

    btnSchedule.disabled = true;
    btnScheduleDropdown.disabled = true;
    try {
      const payload = await uploadFormDataWithProgress('/api/reels', formData, currentMedia.file, action, 'Reel de teste');
      scheduledPosts.unshift(normalizeBackendSchedule(payload.story));
      updateScheduleBadge();
      renderCalendar();
      renderListView();
      const successMessage = action === 'publish_now'
        ? 'Reel de teste publicado com sucesso.'
        : 'Reel de teste agendado com sucesso.';
      completeUploadProgress(successMessage);
      showToast(successMessage, 'success');
      await waitForUploadCompletion();
    } catch (error) {
      showToast(error.message || 'Não foi possível conectar ao backend.', 'warning');
    } finally {
      btnSchedule.disabled = false;
      btnScheduleDropdown.disabled = false;
      closeUploadProgress();
    }
  }

  btnSchedule.addEventListener('click', async () => {
    if (selectedPublishAction === 'draft') {
      showToast('Rascunho salvo localmente.', 'info');
      return;
    }
    if (currentMode === 'story') {
      await submitStoryToBackend();
      return;
    }
    if (currentMode === 'test_reel') {
      await submitTrialReelToBackend();
      return;
    }

    if (!currentMedia) {
      showToast('Selecione uma imagem ou vídeo antes de agendar.', 'warning');
      return;
    }

    const scheduledDate = document.getElementById('scheduledDateInput').value || '2026-09-22';
    const scheduledTime = document.getElementById('scheduledTimeInput').value || '08:49';
    const modeText = currentNetworkModeText.innerText.trim();
    scheduledPosts.unshift({
      id: `post-${Date.now()}`,
      date: scheduledDate,
      time: scheduledTime,
      type: currentMode === 'test_reel' ? 'test_reel' : currentMode,
      typeLabel: modeText,
      media: currentMedia.url,
      isVideo: currentMedia.isVideo,
      caption: editor.innerText.trim() || 'Novo post agendado',
      status: selectedPublishAction === 'publish_now' ? 'Publicado' : 'Agendado'
    });
    updateScheduleBadge();
    renderCalendar();
    renderListView();
    showToast(`${selectedPublishAction === 'publish_now' ? 'Publicação realizada' : 'Publicação agendada'} com sucesso.`, 'success');
  });

  // Initial render
  updateScheduleBadge();
  renderCalendar();
  renderListView();
  loadSchedules();
  window.setInterval(() => {
    if (document.visibilityState === 'visible') loadSchedules();
  }, 30000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') loadSchedules();
  });

  // --- Toast Notification Helper ---
  function showToast(message, type = 'info') {
    const container = document.getElementById('toastContainer');
    const toast = document.createElement('div');
    toast.className = 'toast-item';
    
    let icon = 'fa-circle-info';
    let color = '#38bdf8';
    if (type === 'success') {
      icon = 'fa-circle-check';
      color = '#22c55e';
    } else if (type === 'warning') {
      icon = 'fa-triangle-exclamation';
      color = '#f59e0b';
    }

    toast.innerHTML = `<i class="fa-solid ${icon}" style="color: ${color}"></i> <span>${message}</span>`;
    container.appendChild(toast);

    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateY(10px)';
      toast.style.transition = 'all 0.3s ease';
      setTimeout(() => toast.remove(), 300);
    }, 3200);
  }

  document.getElementById('btnClosePlanner').addEventListener('click', () => {
    showToast('Planejador fechado.', 'info');
  });
});

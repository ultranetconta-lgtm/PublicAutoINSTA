document.addEventListener('DOMContentLoaded', () => {
  // Elements
  const editor = document.getElementById('postEditor');
  const hashtagCounter = document.getElementById('hashtagCounter');
  const charCounter = document.getElementById('charCounter');
  const previewCaption = document.getElementById('previewCaption');
  const fileInput = document.getElementById('mediaFileInput');
  const btnAddMedia = document.getElementById('btnAddMedia');
  const editorMediaPreviewArea = document.getElementById('editorMediaPreviewArea');
  const thumbVideo = document.getElementById('thumbVideo');
  const thumbImage = document.getElementById('thumbImage');
  const btnThumbOptions = document.getElementById('btnThumbOptions');

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

  btnAddMedia.addEventListener('click', () => {
    fileInput.click();
  });

  fileInput.addEventListener('change', (e) => {
    if (e.target.files && e.target.files[0]) {
      handleMediaFile(e.target.files[0]);
    }
  });

  btnThumbOptions.addEventListener('click', (e) => {
    e.stopPropagation();
    if (confirm('Deseja substituir ou remover a mídia anexada? Clique em OK para trocar de arquivo.')) {
      fileInput.click();
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

  // --- Tab Navigation: Criar Publicação vs Agendamentos ---
  const tabBtnPlanner = document.getElementById('tabBtnPlanner');
  const tabBtnAgendamentos = document.getElementById('tabBtnAgendamentos');
  const viewPlanner = document.getElementById('viewPlanner');
  const viewAgendamentos = document.getElementById('viewAgendamentos');
  const btnGoToPlanner = document.getElementById('btnGoToPlanner');
  const agendamentosCountBadge = document.getElementById('agendamentosCountBadge');

  function switchTab(tabName) {
    if (tabName === 'planner') {
      tabBtnPlanner.classList.add('active');
      tabBtnAgendamentos.classList.remove('active');
      viewPlanner.classList.add('active');
      viewAgendamentos.classList.remove('active');
    } else if (tabName === 'agendamentos') {
      tabBtnAgendamentos.classList.add('active');
      tabBtnPlanner.classList.remove('active');
      viewAgendamentos.classList.add('active');
      viewPlanner.classList.remove('active');
      renderCalendar();
      renderListView();
    }
  }

  tabBtnPlanner.addEventListener('click', () => switchTab('planner'));
  tabBtnAgendamentos.addEventListener('click', () => switchTab('agendamentos'));
  if (btnGoToPlanner) {
    btnGoToPlanner.addEventListener('click', () => switchTab('planner'));
  }

  // --- Scheduled Posts Data Store ---
  let scheduledPosts = [
    {
      id: 'post-1',
      date: '2026-09-22',
      time: '08:49',
      type: 'test_reel',
      typeLabel: 'Reels de teste',
      media: 'assets/CLIP6.mp4',
      isVideo: true,
      caption: 'Novos testes de Reels automáticos no ar! 🔥 Confira o desempenho.',
      status: 'Agendado'
    },
    {
      id: 'post-2',
      date: '2026-09-24',
      time: '18:00',
      type: 'reel',
      typeLabel: 'Reel',
      media: 'assets/CLIP6.mp4',
      isVideo: true,
      caption: 'Bastidores do novo ensaio 🔥 Confira os novos detalhes da coleção! #moda #lifestyle',
      status: 'Agendado'
    },
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
      agendamentosCountBadge.innerText = scheduledPosts.length;
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

  async function loadSchedules() {
    try {
      const response = await fetch('/api/schedules', { headers: { Accept: 'application/json' } });
      if (!response.ok) return;
      const payload = await response.json();
      if (Array.isArray(payload.schedules)) {
        scheduledPosts = payload.schedules.map(normalizeBackendSchedule);
        updateScheduleBadge();
        renderCalendar();
        renderListView();
      }
    } catch (error) {
      // The planner still opens in mock mode when the backend is not running.
    }
  }

  // --- Calendar Date State (September 2026) ---
  let calCurrentYear = 2026;
  let calCurrentMonth = 8; // 0-indexed: 8 is September
  let currentFilter = 'all';

  const monthNames = [
    'Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho',
    'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'
  ];

  const calendarCurrentMonthLabel = document.getElementById('calendarCurrentMonthLabel');
  const calendarMonthGrid = document.getElementById('calendarMonthGrid');
  const scheduleTableBody = document.getElementById('scheduleTableBody');

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
    pill.addEventListener('click', () => {
      document.querySelectorAll('.filter-pill').forEach(p => p.classList.remove('active'));
      pill.classList.add('active');
      currentFilter = pill.dataset.filter;
      renderCalendar();
      renderListView();
    });
  });

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

  // --- Render Calendar Grid ---
  function renderCalendar() {
    calendarCurrentMonthLabel.innerText = `${monthNames[calCurrentMonth]} ${calCurrentYear}`;
    calendarMonthGrid.innerHTML = '';

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
      
      let postsForDay = scheduledPosts.filter(p => p.date === dateStr);
      if (currentFilter !== 'all') {
        postsForDay = postsForDay.filter(p => {
          if (currentFilter === 'reel') return p.type === 'reel' || p.type === 'test_reel';
          return p.type === currentFilter;
        });
      }

      let postsHtml = '';
      postsForDay.forEach(post => {
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

        postsHtml += `
          <div class="schedule-card" data-id="${post.id}">
            <div class="schedule-card-thumb">
              ${post.isVideo ? `<video src="${post.media}" muted></video>` : `<img src="${post.media}" alt="Capa">`}
              <div class="thumb-type-icon">
                <i class="fa-solid ${typeIcon}"></i>
              </div>
            </div>
            <div class="schedule-card-details">
              <div class="schedule-card-top-row">
                <span class="schedule-card-time">${post.time}</span>
                <i class="fa-brands fa-instagram schedule-card-network"></i>
              </div>
              <span class="schedule-card-type-pill ${typeClass}">${post.typeLabel}</span>
              <div class="schedule-card-caption-preview">${post.caption}</div>
            </div>
          </div>
        `;
      });

      cell.innerHTML = `
        <div class="cell-date-header">
          <span class="cell-day-num">${day}</span>
          ${postsForDay.length > 0 ? `<span class="text-[10px] font-bold text-blue-600 bg-blue-50 px-1.5 py-0.5 rounded-full">${postsForDay.length}</span>` : ''}
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

    // Add click listeners to cards
    document.querySelectorAll('.schedule-card').forEach(card => {
      card.addEventListener('click', (e) => {
        e.stopPropagation();
        const id = card.dataset.id;
        const post = scheduledPosts.find(p => p.id === id);
        if (post) openPostDetail(post);
      });
    });
  }

  // --- Render List View ---
  function renderListView() {
    scheduleTableBody.innerHTML = '';
    let filtered = scheduledPosts;
    if (currentFilter !== 'all') {
      filtered = filtered.filter(p => {
        if (currentFilter === 'reel') return p.type === 'reel' || p.type === 'test_reel';
        return p.type === currentFilter;
      });
    }

    if (filtered.length === 0) {
      scheduleTableBody.innerHTML = `
        <tr>
          <td colspan="7" class="text-center py-8 text-gray-400">Nenhuma publicação agendada com esse filtro.</td>
        </tr>
      `;
      return;
    }

    filtered.forEach(post => {
      let typeClass = 'type-pill-reel';
      if (post.type === 'test_reel') typeClass = 'type-pill-test';
      else if (post.type === 'post') typeClass = 'type-pill-post';
      else if (post.type === 'story') typeClass = 'type-pill-story';

      const d = new Date(`${post.date}T${post.time}`);
      const formattedDate = d.toLocaleDateString('pt-BR', { day: '2-digit', month: 'short', year: 'numeric' });

      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>
          <div class="table-thumb">
            ${post.isVideo ? `<video src="${post.media}" muted></video>` : `<img src="${post.media}" alt="Capa">`}
          </div>
        </td>
        <td>
          <span class="schedule-card-type-pill ${typeClass} text-xs px-2 py-1">${post.typeLabel}</span>
        </td>
        <td>
          <div class="font-semibold text-gray-900">${post.time}</div>
          <div class="text-xs text-gray-500">${formattedDate}</div>
        </td>
        <td>
          <div class="flex items-center gap-1.5">
            <i class="fa-brands fa-instagram text-pink-600 text-sm"></i>
            <span class="text-xs font-semibold text-gray-800">alesantorooficial</span>
          </div>
        </td>
        <td>
          <div class="text-xs text-gray-700 max-w-xs truncate">${post.caption}</div>
        </td>
        <td>
          <span class="text-xs font-semibold px-2 py-1 rounded-full bg-blue-50 text-blue-700">${post.status}</span>
        </td>
        <td style="text-align: right;">
          <button type="button" class="btn-view-post px-2.5 py-1 text-xs font-semibold text-blue-600 hover:bg-blue-50 rounded" data-id="${post.id}">
            Ver
          </button>
          <button type="button" class="btn-delete-post px-2.5 py-1 text-xs font-semibold text-red-600 hover:bg-red-50 rounded ml-1" data-id="${post.id}">
            <i class="fa-solid fa-trash-can"></i>
          </button>
        </td>
      `;
      scheduleTableBody.appendChild(tr);
    });

    // Event listeners
    document.querySelectorAll('.btn-view-post').forEach(btn => {
      btn.addEventListener('click', () => {
        const post = scheduledPosts.find(p => p.id === btn.dataset.id);
        if (post) openPostDetail(post);
      });
    });

    document.querySelectorAll('.btn-delete-post').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (confirm('Deseja excluir este agendamento?')) {
          if (btn.dataset.id.startsWith('story-')) {
            try {
              await fetch(`/api/schedules/${encodeURIComponent(btn.dataset.id)}`, { method: 'DELETE' });
            } catch (error) {
              showToast('Não foi possível sincronizar a exclusão com o backend.', 'warning');
            }
          }
          scheduledPosts = scheduledPosts.filter(p => p.id !== btn.dataset.id);
          updateScheduleBadge();
          renderListView();
          renderCalendar();
          showToast('Agendamento excluído.', 'info');
        }
      });
    });
  }

  // --- Post Detail Modal ---
  const postDetailModal = document.getElementById('postDetailModal');
  const modalDetailType = document.getElementById('modalDetailType');
  const modalDetailStatus = document.getElementById('modalDetailStatus');
  const modalDetailVideo = document.getElementById('modalDetailVideo');
  const modalDetailImage = document.getElementById('modalDetailImage');
  const modalDetailDateTime = document.getElementById('modalDetailDateTime');
  const modalDetailCaption = document.getElementById('modalDetailCaption');
  const btnEditFromModal = document.getElementById('btnEditFromModal');
  let selectedPostInModal = null;

  function openPostDetail(post) {
    selectedPostInModal = post;
    modalDetailType.innerText = post.typeLabel;
    modalDetailStatus.innerText = post.status;
    modalDetailDateTime.innerText = `${post.date} às ${post.time}`;
    modalDetailCaption.innerText = post.caption || '(Sem legenda)';

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
    if (selectedPostInModal) {
      editor.innerText = selectedPostInModal.caption;
      updateEditorState();
      postDetailModal.classList.remove('active');
      switchTab('planner');
      showToast('Publicação carregada no editor para edição.', 'info');
    }
  });

  // --- Schedule Button Action ---
  async function submitStoryToBackend() {
    if (!currentMedia) {
      showToast('Selecione uma imagem JPG ou vídeo MP4 para o Story.', 'warning');
      return;
    }

    const formData = new FormData();
    formData.append('action', selectedPublishAction);
    formData.append('caption', editor.innerText.trim());
    if (selectedPublishAction === 'schedule') {
      const date = document.getElementById('scheduledDateInput').value;
      const time = document.getElementById('scheduledTimeInput').value;
      formData.append('scheduled_at', new Date(`${date}T${time}`).toISOString());
    }
    formData.append('media', currentMedia.file, currentMedia.file.name);

    btnSchedule.disabled = true;
    try {
      const response = await fetch('/api/stories', { method: 'POST', body: formData });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(payload.message || payload.error || 'Não foi possível enviar o Story.');
      }
      const story = payload.story;
      scheduledPosts.unshift(normalizeBackendSchedule(story));
      updateScheduleBadge();
      renderCalendar();
      renderListView();
      showToast(
        selectedPublishAction === 'publish_now'
          ? 'Story publicado com sucesso.'
          : 'Story agendado com sucesso.',
        'success'
      );
    } catch (error) {
      showToast(error.message || 'Não foi possível conectar ao backend.', 'warning');
    } finally {
      btnSchedule.disabled = false;
    }
  }

  async function submitTrialReelToBackend() {
    if (!currentMedia || !currentMedia.isVideo) {
      showToast('Selecione o vídeo MP4 do Reel de teste.', 'warning');
      return;
    }

    const formData = new FormData();
    formData.append('action', selectedPublishAction);
    formData.append('caption', editor.innerText.trim());
    formData.append('graduation_strategy', 'MANUAL');
    if (selectedPublishAction === 'schedule') {
      const date = document.getElementById('scheduledDateInput').value;
      const time = document.getElementById('scheduledTimeInput').value;
      formData.append('scheduled_at', new Date(`${date}T${time}`).toISOString());
    }
    formData.append('media', currentMedia.file, currentMedia.file.name);

    btnSchedule.disabled = true;
    try {
      const response = await fetch('/api/reels', { method: 'POST', body: formData });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(payload.message || payload.error || 'Não foi possível enviar o Reel de teste.');
      }
      scheduledPosts.unshift(normalizeBackendSchedule(payload.story));
      updateScheduleBadge();
      renderCalendar();
      renderListView();
      showToast(
        selectedPublishAction === 'publish_now'
          ? 'Reel de teste publicado com sucesso.'
          : 'Reel de teste agendado com sucesso.',
        'success'
      );
    } catch (error) {
      showToast(error.message || 'Não foi possível conectar ao backend.', 'warning');
    } finally {
      btnSchedule.disabled = false;
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

    const scheduledDate = document.getElementById('scheduledDateInput').value || '2026-09-22';
    const scheduledTime = document.getElementById('scheduledTimeInput').value || '08:49';
    const modeText = currentNetworkModeText.innerText.trim();
    scheduledPosts.unshift({
      id: `post-${Date.now()}`,
      date: scheduledDate,
      time: scheduledTime,
      type: currentMode === 'test_reel' ? 'test_reel' : currentMode,
      typeLabel: modeText,
      media: currentMedia ? currentMedia.url : 'assets/CLIP6.mp4',
      isVideo: currentMedia ? currentMedia.isVideo : true,
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

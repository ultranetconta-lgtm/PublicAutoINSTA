document.addEventListener('DOMContentLoaded', () => {
  // Elements
  const editor = document.getElementById('postEditor');
  const hashtagCounter = document.getElementById('hashtagCounter');
  const charCounter = document.getElementById('charCounter');
  const previewCaption = document.getElementById('previewCaption');
  const fileInput = document.getElementById('mediaFileInput');
  const carouselSelectionHint = document.getElementById('carouselSelectionHint');
  const carouselAttachmentsBox = document.getElementById('carouselAttachmentsBox');
  const carouselAttachmentsList = document.getElementById('carouselAttachmentsList');
  const carouselAttachmentCount = document.getElementById('carouselAttachmentCount');
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
  const accountSelectorButton = document.getElementById('accountSelectorButton');
  const accountDropdown = document.getElementById('accountDropdown');
  const accountMenuList = document.getElementById('accountMenuList');
  const activeAccountUsername = document.getElementById('activeAccountUsername');
  const accountConnectModal = document.getElementById('accountConnectModal');
  const accountConnectForm = document.getElementById('accountConnectForm');
  const instagramAccessToken = document.getElementById('instagramAccessToken');
  const accountConnectError = document.getElementById('accountConnectError');
  const btnSubmitAccountConnect = document.getElementById('btnSubmitAccountConnect');
  let connectedAccounts = [];
  let activeInstagramAccount = null;
  let accountsLoaded = false;
  const ACTIVE_ACCOUNT_STORAGE_KEY = 'instaflux.activeInstagramAccountId';

  window.getActiveInstagramAccountId = () => activeInstagramAccount?.id || '';
  window.getActiveInstagramAccountUsername = () => activeInstagramAccount?.username || '';

  function accountScopedUrl(path, accountId = activeInstagramAccount?.id) {
    if (!accountId) return path;
    const separator = path.includes('?') ? '&' : '?';
    return `${path}${separator}account_id=${encodeURIComponent(accountId)}`;
  }

  function renderAccountMenu() {
    if (!accountMenuList) return;
    accountMenuList.replaceChildren();
    if (connectedAccounts.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'account-menu-empty';
      empty.textContent = 'Nenhuma conta conectada. Adicione uma conta para começar a publicar.';
      accountMenuList.appendChild(empty);
      return;
    }

    connectedAccounts.forEach(account => {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = `account-menu-item${activeInstagramAccount?.id === account.id ? ' active' : ''}`;
      item.dataset.accountId = account.id;
      item.setAttribute('role', 'menuitemradio');
      item.setAttribute('aria-checked', String(activeInstagramAccount?.id === account.id));
      const avatar = document.createElement('span');
      avatar.className = 'account-menu-avatar';
      avatar.setAttribute('aria-hidden', 'true');
      avatar.textContent = (account.username || '?').replace(/^@/, '').slice(0, 1).toUpperCase();
      const username = document.createElement('span');
      username.className = 'account-menu-username';
      username.textContent = `@${String(account.username || account.id).replace(/^@/, '')}`;
      item.append(avatar, username);
      if (activeInstagramAccount?.id === account.id) {
        const check = document.createElement('i');
        check.className = 'fa-solid fa-check account-menu-check';
        check.setAttribute('aria-label', 'Conta ativa');
        item.appendChild(check);
      }
      accountMenuList.appendChild(item);
    });
  }

  function setAccountDropdownOpen(open) {
    if (!accountSelectorButton || !accountDropdown) return;
    accountDropdown.hidden = !open;
    accountSelectorButton.setAttribute('aria-expanded', String(open));
  }

  function updateActiveAccountLabels() {
    const username = activeInstagramAccount?.username || '';
    const displayName = username ? `@${username.replace(/^@/, '')}` : 'Conecte uma conta';
    if (activeAccountUsername) activeAccountUsername.textContent = displayName;
    if (accountSelectorButton) accountSelectorButton.title = username ? `Conta ativa: ${displayName}` : 'Conectar conta do Instagram';
    const previewName = document.getElementById('previewAccountUsername');
    if (previewName) previewName.textContent = username || 'Instagram';
    const analyticsName = document.getElementById('activeAnalyticsAccount');
    if (analyticsName) analyticsName.textContent = username ? `@${username.replace(/^@/, '')}` : 'Nenhuma conta conectada';
    const detailName = document.getElementById('modalDetailAccountUsername');
    if (detailName) detailName.textContent = username || 'Instagram';
  }

  function setActiveInstagramAccount(account, options = {}) {
    if (!account?.id) return;
    const changed = activeInstagramAccount?.id !== account.id;
    activeInstagramAccount = account;
    if (options.persist !== false) {
      try { localStorage.setItem(ACTIVE_ACCOUNT_STORAGE_KEY, account.id); } catch (_) {}
    }
    renderAccountMenu();
    updateActiveAccountLabels();
    if (uploadProgressOverlay?.hidden) {
      if (btnSchedule) btnSchedule.disabled = false;
      if (btnScheduleDropdown) btnScheduleDropdown.disabled = false;
    }
    if (!changed || options.reload === false || !accountsLoaded) return;

    scheduledPosts = [];
    backendSchedulesLoaded = false;
    updateScheduleBadge();
    renderCalendar();
    renderListView();
    loadSchedules();
    document.dispatchEvent(new CustomEvent('instagram-account-changed', { detail: { account } }));
  }

  function openAccountConnectModal() {
    setAccountDropdownOpen(false);
    accountConnectError.hidden = true;
    accountConnectError.textContent = '';
    accountConnectModal.hidden = false;
    window.setTimeout(() => instagramAccessToken?.focus(), 0);
  }

  function closeAccountConnectModal() {
    if (btnSubmitAccountConnect?.disabled) return;
    accountConnectModal.hidden = true;
    accountConnectForm?.reset();
    if (accountConnectError) {
      accountConnectError.hidden = true;
      accountConnectError.textContent = '';
    }
  }

  accountSelectorButton?.addEventListener('click', event => {
    event.stopPropagation();
    setAccountDropdownOpen(accountDropdown.hidden);
  });
  accountDropdown?.addEventListener('click', event => event.stopPropagation());
  accountMenuList?.addEventListener('click', event => {
    const item = event.target.closest('button[data-account-id]');
    if (!item) return;
    const account = connectedAccounts.find(candidate => candidate.id === item.dataset.accountId);
    if (!account) return;
    const changed = activeInstagramAccount?.id !== account.id;
    setAccountDropdownOpen(false);
    setActiveInstagramAccount(account);
    if (changed) showToast(`Conta ativa: @${account.username.replace(/^@/, '')}`, 'info');
  });
  document.getElementById('btnAddInstagramAccount')?.addEventListener('click', openAccountConnectModal);
  document.getElementById('btnCloseAccountConnect')?.addEventListener('click', closeAccountConnectModal);
  document.getElementById('btnCancelAccountConnect')?.addEventListener('click', closeAccountConnectModal);
  accountConnectModal?.addEventListener('click', event => {
    if (event.target === accountConnectModal) closeAccountConnectModal();
  });
  document.addEventListener('click', event => {
    if (!event.target.closest('.account-switcher')) setAccountDropdownOpen(false);
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      setAccountDropdownOpen(false);
      closeAccountConnectModal();
    }
  });

  accountConnectForm?.addEventListener('submit', async event => {
    event.preventDefault();
    const accessToken = instagramAccessToken.value.trim();
    if (!accessToken) {
      accountConnectError.textContent = 'Cole o token de acesso para continuar.';
      accountConnectError.hidden = false;
      return;
    }
    btnSubmitAccountConnect.disabled = true;
    btnSubmitAccountConnect.querySelector('span').textContent = 'Validando token…';
    accountConnectError.hidden = true;
    try {
      const response = await fetch('/api/accounts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ access_token: accessToken }),
        cache: 'no-store'
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload.account?.id) {
        throw new Error(payload.message || 'A Meta não validou esse token. Confira o token e as permissões da conta profissional.');
      }
      const account = {
        id: String(payload.account.id),
        username: String(payload.account.username || payload.account.id).replace(/^@/, '')
      };
      connectedAccounts = [...connectedAccounts.filter(existing => existing.id !== account.id), account];
      accountsLoaded = true;
      accountConnectModal.hidden = true;
      accountConnectForm.reset();
      renderAccountMenu();
      setActiveInstagramAccount(account);
      showToast(`Conta @${account.username} conectada e selecionada.`, 'success');
    } catch (error) {
      accountConnectError.textContent = error.message || 'Não foi possível conectar a conta.';
      accountConnectError.hidden = false;
    } finally {
      btnSubmitAccountConnect.disabled = false;
      btnSubmitAccountConnect.querySelector('span').textContent = 'Validar e conectar';
    }
  });

  async function loadConnectedAccounts() {
    try {
      const response = await fetch('/api/accounts', { headers: { Accept: 'application/json' }, cache: 'no-store' });
      if (!response.ok) throw new Error('accounts_unavailable');
      const payload = await response.json();
      connectedAccounts = Array.isArray(payload.accounts)
        ? payload.accounts.filter(account => account?.id && account?.username).map(account => ({
          id: String(account.id),
          username: String(account.username).replace(/^@/, '')
        }))
        : [];
    } catch (_) {
      connectedAccounts = [];
    }
    accountsLoaded = true;
    renderAccountMenu();
    const storedId = (() => {
      try { return localStorage.getItem(ACTIVE_ACCOUNT_STORAGE_KEY); } catch (_) { return null; }
    })();
    const selected = connectedAccounts.find(account => account.id === storedId) || connectedAccounts[0];
    if (selected) {
      setActiveInstagramAccount(selected, { reload: false, persist: Boolean(storedId && selected.id === storedId) });
    } else {
      activeInstagramAccount = null;
      updateActiveAccountLabels();
      if (btnSchedule) btnSchedule.disabled = true;
      if (btnScheduleDropdown) btnScheduleDropdown.disabled = true;
    }
    document.dispatchEvent(new CustomEvent('instagram-account-changed', { detail: { account: selected || null } }));
    if (selected) loadSchedules();
  }

  const previewMediaLayer = document.getElementById('previewMediaLayer');
  const previewMockupStage = document.querySelector('.preview-mockup-stage');
  const postCropControls = document.getElementById('postCropControls');
  const postCropRatioButtons = Array.from(document.querySelectorAll('[data-post-crop-ratio]'));
  const mediaEmptyPlaceholder = document.getElementById('mediaEmptyPlaceholder');
  const previewImage = document.getElementById('previewImage');
  const previewVideo = document.getElementById('previewVideo');
  const carouselPreviewControls = document.getElementById('carouselPreviewControls');
  const carouselPreviewPosition = document.getElementById('carouselPreviewPosition');
  const btnCarouselPrev = document.getElementById('btnCarouselPrev');
  const btnCarouselNext = document.getElementById('btnCarouselNext');
  const videoControlsOverlay = document.getElementById('videoControlsOverlay');
  const btnReelPlayPause = document.getElementById('btnReelPlayPause');
  const reelPlayIcon = document.getElementById('reelPlayIcon');
  const btnReelRewind = document.getElementById('btnReelRewind');
  const btnReelForward = document.getElementById('btnReelForward');

  // Network selector elements
  const networkSelectorTrigger = document.getElementById('networkSelectorTrigger');
  const networkBadgeIcon = document.getElementById('networkBadgeIcon');
  const btnNetworkMode = document.getElementById('btnNetworkMode');
  const networkDropdownMenu = document.getElementById('networkDropdownMenu');
  const currentNetworkModeText = document.getElementById('currentNetworkModeText');
  const networkDropdownItems = document.querySelectorAll('.network-dropdown-item');
  let currentMode = 'reel';
  let selectedPublishAction = 'schedule';
  let currentMedia = null;
  let postCropState = { ratio: 'portrait', positionX: 50, positionY: 50 };
  let postCropDrag = null;
  let selectedCarouselFiles = [];
  let carouselPreviewIndex = 0;
  const carouselAttachmentUrls = new Map();
  networkBadgeIcon.classList.add('hidden');

  const postCropAspectRatios = { portrait: 4 / 5, square: 1 };

  function selectedPostCropAspectRatio() {
    if (postCropState.ratio === 'original') {
      const sourceWidth = previewImage.naturalWidth;
      const sourceHeight = previewImage.naturalHeight;
      return sourceWidth > 0 && sourceHeight > 0 ? sourceWidth / sourceHeight : null;
    }
    return postCropAspectRatios[postCropState.ratio] || postCropAspectRatios.portrait;
  }

  function updatePostCropControls() {
    const visible = currentMode === 'post' && currentMedia?.kind === 'image';
    postCropControls.hidden = !visible;
    previewMockupStage.classList.toggle('has-post-crop-controls', visible);
    postCropRatioButtons.forEach(button => {
      const selected = button.dataset.postCropRatio === postCropState.ratio;
      button.classList.toggle('active', selected);
      button.setAttribute('aria-pressed', String(selected));
    });
  }

  function applyPostCropPreview() {
    updatePostCropControls();
    const active = currentMode === 'post'
      && currentMedia?.kind === 'image'
      && !previewImage.classList.contains('hidden');
    previewImage.classList.toggle('post-crop-active', active);
    if (!active) {
      previewImage.classList.remove('is-dragging');
      previewImage.style.width = '';
      previewImage.style.height = '';
      previewImage.style.left = '';
      previewImage.style.top = '';
      previewImage.style.transform = '';
      previewImage.style.objectPosition = '';
      postCropDrag = null;
      return;
    }

    const aspectRatio = selectedPostCropAspectRatio();
    const layerWidth = previewMediaLayer.clientWidth;
    const layerHeight = previewMediaLayer.clientHeight;
    if (!aspectRatio || layerWidth <= 0 || layerHeight <= 0) return;

    const frameWidth = Math.min(layerWidth, layerHeight * aspectRatio);
    const frameHeight = frameWidth / aspectRatio;
    previewImage.style.width = `${frameWidth}px`;
    previewImage.style.height = `${frameHeight}px`;
    previewImage.style.left = '50%';
    previewImage.style.top = '50%';
    previewImage.style.transform = 'translate(-50%, -50%)';
    previewImage.style.objectPosition = `${postCropState.positionX}% ${postCropState.positionY}%`;
  }

  function resetPostCropState() {
    postCropState = { ratio: 'portrait', positionX: 50, positionY: 50 };
    updatePostCropControls();
  }

  function postCropOverflow() {
    const frameWidth = previewImage.clientWidth;
    const frameHeight = previewImage.clientHeight;
    const sourceWidth = previewImage.naturalWidth;
    const sourceHeight = previewImage.naturalHeight;
    if (!frameWidth || !frameHeight || !sourceWidth || !sourceHeight) {
      return { x: 0, y: 0 };
    }
    const scale = Math.max(frameWidth / sourceWidth, frameHeight / sourceHeight);
    return {
      x: Math.max(0, sourceWidth * scale - frameWidth),
      y: Math.max(0, sourceHeight * scale - frameHeight)
    };
  }

  function clampCropPosition(value) {
    return Math.max(0, Math.min(100, value));
  }

  postCropRatioButtons.forEach(button => {
    button.addEventListener('click', () => {
      postCropState.ratio = button.dataset.postCropRatio;
      postCropState.positionX = 50;
      postCropState.positionY = 50;
      applyPostCropPreview();
    });
  });

  previewImage.addEventListener('load', applyPostCropPreview);
  previewImage.addEventListener('pointerdown', event => {
    if (!previewImage.classList.contains('post-crop-active') || (event.pointerType === 'mouse' && event.button !== 0)) return;
    const overflow = postCropOverflow();
    if (overflow.x <= 0 && overflow.y <= 0) return;
    event.preventDefault();
    postCropDrag = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      positionX: postCropState.positionX,
      positionY: postCropState.positionY,
      overflow
    };
    previewImage.setPointerCapture(event.pointerId);
    previewImage.classList.add('is-dragging');
  });
  previewImage.addEventListener('pointermove', event => {
    if (!postCropDrag || event.pointerId !== postCropDrag.pointerId) return;
    if (postCropDrag.overflow.x > 0) {
      postCropState.positionX = clampCropPosition(
        postCropDrag.positionX - ((event.clientX - postCropDrag.startX) / postCropDrag.overflow.x) * 100
      );
    }
    if (postCropDrag.overflow.y > 0) {
      postCropState.positionY = clampCropPosition(
        postCropDrag.positionY - ((event.clientY - postCropDrag.startY) / postCropDrag.overflow.y) * 100
      );
    }
    previewImage.style.objectPosition = `${postCropState.positionX}% ${postCropState.positionY}%`;
  });
  ['pointerup', 'pointercancel', 'lostpointercapture'].forEach(eventName => {
    previewImage.addEventListener(eventName, event => {
      if (!postCropDrag || event.pointerId !== postCropDrag.pointerId) return;
      postCropDrag = null;
      previewImage.classList.remove('is-dragging');
    });
  });
  window.addEventListener('resize', applyPostCropPreview);

  // Hashtags autocomplete elements
  const btnHashtag = document.getElementById('btnHashtag');
  const hashtagsAutocompleteCard = document.getElementById('hashtagsAutocompleteCard');
  const hashtagRowItems = document.querySelectorAll('.hashtag-row-item');

  // Warning Accordion
  const warningAccordionCard = document.getElementById('warningAccordionCard');
  const btnToggleWarning = document.getElementById('btnToggleWarning');
  const warningAccordionBody = document.getElementById('warningAccordionBody');
  const warningChevron = document.getElementById('warningChevron');
  warningAccordionCard.style.display = 'none';

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
      fileInput.multiple = mode === 'carousel';
      networkBadgeIcon.classList.toggle('hidden', mode !== 'test_reel');
      currentNetworkModeText.innerText = label;
      updateCarouselSelectionHint();
      renderCarouselAttachments();
      updateCarouselPreviewControls();
      const previewTitle = document.querySelector('.reels-top-title');
      if (previewTitle) {
        previewTitle.innerText = mode === 'story'
          ? 'Story'
          : mode === 'carousel'
            ? 'Carrossel'
            : mode === 'post'
              ? 'Feed'
              : 'Reels';
      }
      applyPostCropPreview();

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
  function handleMediaFile(file, { quiet = false } = {}) {
    if (!file) return;

    const isVideo = file.type.startsWith('video/');
    const isImage = file.type.startsWith('image/');

    if (!isVideo && !isImage) {
      showToast('Por favor selecione uma imagem ou vídeo válido.', 'warning');
      return;
    }

    if (currentMedia?.url) URL.revokeObjectURL(currentMedia.url);
    resetPostCropState();
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
        previewVideo.classList.remove('hidden');
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
      previewVideo.classList.add('hidden');
      previewImage.src = fileUrl;
      previewImage.classList.remove('hidden');
      previewImage.style.display = 'block';
      videoControlsOverlay.classList.add('hidden');
    }

    applyPostCropPreview();

    if (!quiet) showToast(isVideo ? 'Vídeo carregado com sucesso!' : 'Imagem carregada com sucesso!', 'success');
  }

  function updateCarouselSelectionHint() {
    const showHint = currentMode === 'carousel' && selectedCarouselFiles.length > 0;
    carouselSelectionHint.hidden = !showHint;
    carouselSelectionHint.textContent = showHint
      ? `${selectedCarouselFiles.length} mídias selecionadas. A primeira será a capa.`
      : '';
  }

  function updateCarouselPreviewControls() {
    const visible = currentMode === 'carousel' && selectedCarouselFiles.length > 1;
    carouselPreviewControls.hidden = !visible;
    carouselPreviewControls.classList.toggle('hidden', !visible);
    carouselPreviewPosition.textContent = visible
      ? `${carouselPreviewIndex + 1} / ${selectedCarouselFiles.length}`
      : '1 / 1';
    btnCarouselPrev.disabled = !visible || carouselPreviewIndex <= 0;
    btnCarouselNext.disabled = !visible || carouselPreviewIndex >= selectedCarouselFiles.length - 1;
  }

  function carouselAttachmentUrl(file) {
    if (!carouselAttachmentUrls.has(file)) {
      carouselAttachmentUrls.set(file, URL.createObjectURL(file));
    }
    return carouselAttachmentUrls.get(file);
  }

  function revokeCarouselAttachmentUrls() {
    for (const url of carouselAttachmentUrls.values()) URL.revokeObjectURL(url);
    carouselAttachmentUrls.clear();
  }

  function renderCarouselAttachments() {
    const visible = currentMode === 'carousel' && selectedCarouselFiles.length > 0;
    carouselAttachmentsBox.hidden = !visible;
    updateCarouselSelectionHint();
    if (!visible) {
      carouselAttachmentsList.replaceChildren();
      carouselAttachmentCount.textContent = '';
      updateCarouselPreviewControls();
      return;
    }

    carouselAttachmentCount.textContent = `${selectedCarouselFiles.length} ${selectedCarouselFiles.length === 1 ? 'item' : 'itens'}`;
    const items = selectedCarouselFiles.map((file, index) => {
      const item = document.createElement('li');
      item.className = 'carousel-attachment-item';
      item.draggable = true;
      item.dataset.index = String(index);
      item.setAttribute('aria-label', `Posição ${index + 1}: ${file.name}${index === 0 ? ', capa do carrossel' : ''}`);

      const url = carouselAttachmentUrl(file);
      const media = file.type.startsWith('video/')
        ? document.createElement('video')
        : document.createElement('img');
      media.className = 'carousel-attachment-preview';
      media.src = url;
      media.setAttribute('aria-label', file.name);
      if (media instanceof HTMLVideoElement) {
        media.muted = true;
        media.playsInline = true;
        media.preload = 'metadata';
      } else {
        media.alt = file.name;
      }

      const order = document.createElement('span');
      order.className = 'carousel-attachment-order';
      order.setAttribute('aria-hidden', 'true');
      order.textContent = String(index + 1);

      const name = document.createElement('span');
      name.className = 'carousel-attachment-name';
      name.textContent = file.name;

      const footer = document.createElement('div');
      footer.className = 'carousel-attachment-footer';
      const itemType = document.createElement('span');
      itemType.className = 'carousel-attachment-cover';
      itemType.textContent = index === 0 ? 'Capa' : `Item ${index + 1}`;

      const actions = document.createElement('div');
      actions.className = 'carousel-attachment-actions';
      actions.setAttribute('aria-label', `Reordenar ${file.name}`);
      for (const direction of ['previous', 'next']) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'carousel-attachment-move';
        button.dataset.carouselAction = direction;
        button.setAttribute('aria-label', direction === 'previous'
          ? `Mover item ${index + 1} para antes`
          : `Mover item ${index + 1} para depois`);
        button.title = direction === 'previous' ? 'Mover para a esquerda' : 'Mover para a direita';
        button.disabled = direction === 'previous' ? index === 0 : index === selectedCarouselFiles.length - 1;
        const icon = document.createElement('i');
        icon.className = direction === 'previous' ? 'fa-solid fa-arrow-left' : 'fa-solid fa-arrow-right';
        icon.setAttribute('aria-hidden', 'true');
        button.appendChild(icon);
        actions.appendChild(button);
      }
      const removeButton = document.createElement('button');
      removeButton.type = 'button';
      removeButton.className = 'carousel-attachment-remove';
      removeButton.dataset.carouselAction = 'remove';
      removeButton.setAttribute('aria-label', `Remover ${file.name} do carrossel`);
      removeButton.title = selectedCarouselFiles.length <= 2
        ? 'O carrossel precisa de pelo menos 2 mídias'
        : 'Remover esta mídia';
      removeButton.disabled = selectedCarouselFiles.length <= 2;
      const removeIcon = document.createElement('i');
      removeIcon.className = 'fa-solid fa-trash';
      removeIcon.setAttribute('aria-hidden', 'true');
      removeButton.appendChild(removeIcon);
      actions.appendChild(removeButton);
      footer.append(itemType, actions);
      item.append(media, order, name, footer);
      return item;
    });
    carouselAttachmentsList.replaceChildren(...items);
    updateCarouselPreviewControls();
  }

  function showCarouselPreviewAt(index) {
    if (!selectedCarouselFiles.length) return;
    carouselPreviewIndex = Math.max(0, Math.min(index, selectedCarouselFiles.length - 1));
    handleMediaFile(selectedCarouselFiles[carouselPreviewIndex], { quiet: true });
    updateCarouselPreviewControls();
  }

  function moveCarouselItem(fromIndex, toIndex) {
    if (fromIndex < 0 || toIndex < 0 || fromIndex >= selectedCarouselFiles.length || toIndex >= selectedCarouselFiles.length || fromIndex === toIndex) return;
    const previewedFile = selectedCarouselFiles[carouselPreviewIndex];
    const [movedFile] = selectedCarouselFiles.splice(fromIndex, 1);
    selectedCarouselFiles.splice(toIndex, 0, movedFile);
    carouselPreviewIndex = Math.max(0, selectedCarouselFiles.indexOf(previewedFile));
    renderCarouselAttachments();
    showCarouselPreviewAt(carouselPreviewIndex);
  }

  function removeCarouselItem(index) {
    if (!Number.isInteger(index) || index < 0 || index >= selectedCarouselFiles.length) return;
    if (selectedCarouselFiles.length <= 2) {
      showToast('O carrossel precisa de pelo menos 2 mídias.', 'warning');
      return;
    }

    const removedFile = selectedCarouselFiles[index];
    const removedWasPreviewed = selectedCarouselFiles[carouselPreviewIndex] === removedFile;
    const previewedFile = selectedCarouselFiles[carouselPreviewIndex];
    const removedUrl = carouselAttachmentUrls.get(removedFile);
    if (removedUrl) URL.revokeObjectURL(removedUrl);
    carouselAttachmentUrls.delete(removedFile);
    selectedCarouselFiles.splice(index, 1);

    if (removedWasPreviewed) {
      carouselPreviewIndex = Math.min(index, selectedCarouselFiles.length - 1);
    } else {
      carouselPreviewIndex = Math.max(0, selectedCarouselFiles.indexOf(previewedFile));
    }

    renderCarouselAttachments();
    if (removedWasPreviewed) showCarouselPreviewAt(carouselPreviewIndex);
    showToast('Mídia removida do carrossel.', 'info');
  }

  function clearAttachedMedia() {
    if (currentMedia?.url) URL.revokeObjectURL(currentMedia.url);
    revokeCarouselAttachmentUrls();
    currentMedia = null;
    resetPostCropState();
    selectedCarouselFiles = [];
    carouselPreviewIndex = 0;
    updateCarouselSelectionHint();
    renderCarouselAttachments();
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
    applyPostCropPreview();
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
    const files = Array.from(e.target.files || []);
    if (currentMode === 'carousel' && files.length > 0) {
      if (files.length < 2 || files.length > 10) {
        showToast('Selecione de 2 a 10 mídias para o carrossel.', 'warning');
      } else if (files.some(file => !file.type.startsWith('image/') && !file.type.startsWith('video/'))) {
        showToast('O carrossel aceita apenas imagens e vídeos.', 'warning');
      } else {
        revokeCarouselAttachmentUrls();
        selectedCarouselFiles = files;
        carouselPreviewIndex = 0;
        handleMediaFile(files[0], { quiet: true });
        renderCarouselAttachments();
        showToast(`${files.length} mídias adicionadas ao carrossel.`, 'success');
      }
    } else if (files[0]) {
      revokeCarouselAttachmentUrls();
      selectedCarouselFiles = [];
      carouselPreviewIndex = 0;
      handleMediaFile(files[0]);
      renderCarouselAttachments();
    }
    e.target.value = '';
  });

  carouselAttachmentsList.addEventListener('click', (event) => {
    const button = event.target.closest('[data-carousel-action]');
    if (!button) return;
    const item = button.closest('.carousel-attachment-item');
    if (!item) return;
    const fromIndex = Number(item.dataset.index);
    if (button.dataset.carouselAction === 'remove') {
      removeCarouselItem(fromIndex);
      return;
    }
    const toIndex = fromIndex + (button.dataset.carouselAction === 'previous' ? -1 : 1);
    moveCarouselItem(fromIndex, toIndex);
  });

  carouselAttachmentsList.addEventListener('dragstart', (event) => {
    const item = event.target.closest('.carousel-attachment-item');
    if (!item || !event.dataTransfer) return;
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', item.dataset.index);
    item.classList.add('is-dragging');
  });

  carouselAttachmentsList.addEventListener('dragover', (event) => {
    const item = event.target.closest('.carousel-attachment-item');
    if (!item || !event.dataTransfer) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    carouselAttachmentsList.querySelectorAll('.is-drop-target').forEach(target => target.classList.remove('is-drop-target'));
    item.classList.add('is-drop-target');
  });

  carouselAttachmentsList.addEventListener('drop', (event) => {
    if (!event.dataTransfer) return;
    event.preventDefault();
    const fromIndex = Number(event.dataTransfer.getData('text/plain'));
    const item = event.target.closest('.carousel-attachment-item');
    const targetIndex = item ? Number(item.dataset.index) : selectedCarouselFiles.length;
    let toIndex = targetIndex;
    if (item) {
      const bounds = item.getBoundingClientRect();
      if (event.clientX >= bounds.left + bounds.width / 2) toIndex += 1;
    }
    if (fromIndex < toIndex) toIndex -= 1;
    toIndex = Math.max(0, Math.min(toIndex, selectedCarouselFiles.length - 1));
    moveCarouselItem(fromIndex, toIndex);
  });

  carouselAttachmentsList.addEventListener('dragend', () => {
    carouselAttachmentsList.querySelectorAll('.is-dragging, .is-drop-target').forEach(item => {
      item.classList.remove('is-dragging', 'is-drop-target');
    });
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
  btnCarouselPrev.addEventListener('click', () => showCarouselPreviewAt(carouselPreviewIndex - 1));
  btnCarouselNext.addEventListener('click', () => showCarouselPreviewAt(carouselPreviewIndex + 1));

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
  let scheduledPosts = [];

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
    const typeLabels = {
      post: 'POST',
      carousel: 'CARROSSEL',
      reel: 'REEL',
      test_reel: 'REELS DE TESTE',
      story: 'STORY'
    };
    const type = typeLabels[record.type] ? record.type : 'story';
    const mediaFilenames = Array.isArray(record.media_filenames) && record.media_filenames.length > 0
      ? record.media_filenames
      : [record.media_filename];
    const mediaKinds = Array.isArray(record.media_kinds) && record.media_kinds.length > 0
      ? record.media_kinds
      : [record.media_kind];
    const mediaItems = mediaFilenames.filter(Boolean).map((filename, index) => ({
      media: `/media/${encodeURIComponent(filename)}`,
      isVideo: mediaKinds[index] === 'video'
    }));
    return {
      id: record.id,
      accountId: record.account_id || activeInstagramAccount?.id || '',
      accountUsername: (record.account_username || activeInstagramAccount?.username || '').replace(/^@/, ''),
      date: hasValidDate ? scheduledAt.toLocaleDateString('sv-SE') : '—',
      time: hasValidDate ? scheduledAt.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : '—',
      type,
      typeLabel: typeLabels[type],
      media: mediaItems[0]?.media || '',
      mediaItems,
      isVideo: mediaItems[0]?.isVideo || false,
      caption: record.caption || '(Sem legenda)',
      status: statusLabels[record.status] || record.status,
      backendStatus: record.status,
      graduationStrategy: record.graduation_strategy || 'MANUAL',
      scheduledAt: record.scheduled_at
    };
  }

  let backendSchedulesLoaded = false;
  let scheduleLoadVersion = 0;

  async function loadSchedules() {
    const accountId = activeInstagramAccount?.id;
    if (!accountId) return;
    const loadVersion = ++scheduleLoadVersion;
    try {
      const response = await fetch(accountScopedUrl('/api/schedules', accountId), {
        headers: { Accept: 'application/json' },
        cache: 'no-store'
      });
      if (!response.ok) return;
      const payload = await response.json();
      if (loadVersion !== scheduleLoadVersion || activeInstagramAccount?.id !== accountId) return;
      if (Array.isArray(payload.schedules)) {
        const receivedPosts = payload.schedules.map(normalizeBackendSchedule);
        const oldIds = new Set(scheduledPosts.map(post => post.id));
        if (!backendSchedulesLoaded) {
          scheduledPosts = receivedPosts;
          backendSchedulesLoaded = true;
          updateScheduleBadge();
          renderCalendar();
          renderListView();
          return;
        }

        const newScheduledPosts = receivedPosts.filter(post => (
          post.backendStatus === 'scheduled' && !oldIds.has(post.id)
        ));
        scheduledPosts = receivedPosts;
        updateScheduleBadge();
        renderCalendar();
        renderListView();
        if (newScheduledPosts.length > 0) {
          showToast(newScheduledPosts.length === 1
            ? 'Novo agendamento recebido.'
            : `${newScheduledPosts.length} novos agendamentos recebidos.`, 'info');
        }
      }
    } catch (_) {}
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
    } else if (post.type === 'carousel') {
      typeClass = 'type-pill-carousel';
      typeIcon = 'fa-images';
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
        const response = await fetch(accountScopedUrl(`/api/schedules/${encodeURIComponent(id)}`, post.accountId), {
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
    else if (post.type === 'carousel') typeClass = 'type-pill-carousel';
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
          <span class="text-xs font-semibold text-gray-800">${escapeHtml(post.accountUsername || activeInstagramAccount?.username || '')}</span>
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
      .sort((a, b) => scheduleTimestamp(a) - scheduleTimestamp(b));
    if (visiblePosts.length === 0) return;
    scheduleTableBody.querySelector('[data-schedule-empty]')?.remove();

    visiblePosts.forEach(post => {
      const dateKey = scheduleDateKey(post);
      const dateDividers = [...scheduleTableBody.querySelectorAll('.schedule-date-divider-row')];
      let divider = dateDividers.find(item => item.dataset.scheduleDateKey === dateKey);
      const row = createScheduleTableRow(post, true);

      if (!divider) {
        divider = createScheduleDateDivider(dateKey, 1);
        const firstLaterDivider = dateDividers.find(item => item.dataset.scheduleDateKey > dateKey);
        if (firstLaterDivider) {
          scheduleTableBody.insertBefore(divider, firstLaterDivider);
          scheduleTableBody.insertBefore(row, firstLaterDivider);
        } else {
          scheduleTableBody.append(divider, row);
        }
        return;
      }

      let sibling = divider.nextElementSibling;
      let insertBefore = null;
      while (sibling && !sibling.classList.contains('schedule-date-divider-row')) {
        const existingPost = scheduledPosts.find(item => item.id === sibling.dataset.scheduleId);
        if (existingPost && scheduleTimestamp(post) < scheduleTimestamp(existingPost)) {
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

    const orderedPosts = filtered.slice().sort((a, b) => scheduleTimestamp(a) - scheduleTimestamp(b));
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
      const post = scheduledPosts.find(item => item.id === id);
      if (post?.scheduledAt) {
        try {
          const response = await fetch(accountScopedUrl(`/api/schedules/${encodeURIComponent(id)}`, post.accountId), { method: 'DELETE' });
          if (!response.ok) throw new Error('delete_failed');
        } catch (error) {
          showToast('Não foi possível sincronizar a exclusão com o backend.', 'warning');
          return;
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
    const modalAccount = document.getElementById('modalDetailAccountUsername');
    if (modalAccount) modalAccount.textContent = post.accountUsername || activeInstagramAccount?.username || 'Instagram';
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
    const files = Array.isArray(file) ? file : [file];
    const totalBytes = files.reduce((total, item) => total + (item?.size || 0), 0);
    const actionLabel = action === 'publish_now' ? 'publicação' : 'agendamento';
    uploadProgressCard.classList.remove('is-processing', 'is-complete', 'is-indeterminate');
    uploadProgressTitle.innerText = `Enviando ${contentLabel}`;
    uploadProgressStatus.innerText = `Enviando o arquivo para ${actionLabel}…`;
    uploadProgressPhase.innerText = 'ENVIO';
    uploadProgressFileName.innerText = files.length > 1 ? `${files.length} mídias` : (files[0]?.name || contentLabel);
    uploadProgressFileSize.innerText = formatUploadBytes(totalBytes);
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
    const accountId = activeInstagramAccount?.id;
    if (!accountId) {
      showToast('Conecte uma conta do Instagram antes de publicar.', 'warning');
      return;
    }
    if (!currentMedia) {
      showToast('Selecione uma imagem JPG ou vídeo MP4 para o Story.', 'warning');
      return;
    }

    const action = selectedPublishAction;
    const formData = new FormData();
    formData.append('account_id', accountId);
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
      if (activeInstagramAccount?.id === accountId) {
        scheduledPosts.unshift(normalizeBackendSchedule(story));
        updateScheduleBadge();
        renderCalendar();
        renderListView();
      }
      const accountName = connectedAccounts.find(account => account.id === accountId)?.username || 'conta selecionada';
      const successMessage = action === 'publish_now' ? `Story publicado em @${accountName}.` : `Story agendado para @${accountName}.`;
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
    const accountId = activeInstagramAccount?.id;
    if (!accountId) {
      showToast('Conecte uma conta do Instagram antes de publicar.', 'warning');
      return;
    }
    if (!currentMedia || !currentMedia.isVideo) {
      showToast('Selecione o vídeo MP4 do Reel de teste.', 'warning');
      return;
    }

    const action = selectedPublishAction;
    const formData = new FormData();
    formData.append('account_id', accountId);
    formData.append('action', action);
    formData.append('caption', editor.innerText.trim());
    formData.append('publication_type', 'test_reel');
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
      if (activeInstagramAccount?.id === accountId) {
        scheduledPosts.unshift(normalizeBackendSchedule(payload.story));
        updateScheduleBadge();
        renderCalendar();
        renderListView();
      }
      const accountName = connectedAccounts.find(account => account.id === accountId)?.username || 'conta selecionada';
      const successMessage = action === 'publish_now'
        ? `Reel de teste publicado em @${accountName}.`
        : `Reel de teste agendado para @${accountName}.`;
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

  async function createPostUploadFile(file, cropState) {
    if (cropState.ratio === 'original') return file;

    let source;
    try {
      source = await createImageBitmap(file);
    } catch (_) {
      throw new Error('Não foi possível preparar o recorte desta imagem no navegador.');
    }

    try {
      const targetRatio = postCropAspectRatios[cropState.ratio];
      if (!targetRatio) return file;

      const sourceRatio = source.width / source.height;
      const cropWidth = sourceRatio > targetRatio ? source.height * targetRatio : source.width;
      const cropHeight = sourceRatio > targetRatio ? source.height : source.width / targetRatio;
      const cropX = (source.width - cropWidth) * (clampCropPosition(cropState.positionX) / 100);
      const cropY = (source.height - cropHeight) * (clampCropPosition(cropState.positionY) / 100);
      const resize = Math.min(1, 8192 / Math.max(cropWidth, cropHeight));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(cropWidth * resize));
      canvas.height = Math.max(1, Math.round(cropHeight * resize));
      const context = canvas.getContext('2d');
      if (!context) throw new Error('Não foi possível preparar o recorte desta imagem no navegador.');

      const outputType = file.type === 'image/png' ? 'image/png' : 'image/jpeg';
      if (outputType === 'image/jpeg') {
        context.fillStyle = '#ffffff';
        context.fillRect(0, 0, canvas.width, canvas.height);
      }
      context.drawImage(
        source,
        cropX, cropY, cropWidth, cropHeight,
        0, 0, canvas.width, canvas.height
      );

      const blob = await new Promise(resolve => canvas.toBlob(resolve, outputType, 0.94));
      if (!blob) throw new Error('Não foi possível exportar o recorte desta imagem.');
      const extension = blob.type === 'image/png' ? 'png' : 'jpg';
      const baseName = file.name.replace(/\.[^.]+$/, '') || 'post';
      const ratioLabel = cropState.ratio === 'square' ? '1x1' : '4x5';
      return new File([blob], `${baseName}-${ratioLabel}.${extension}`, {
        type: blob.type,
        lastModified: file.lastModified
      });
    } finally {
      source.close?.();
    }
  }

  async function submitFeedPostToBackend() {
    const accountId = activeInstagramAccount?.id;
    if (!accountId) {
      showToast('Conecte uma conta do Instagram antes de publicar.', 'warning');
      return;
    }
    if (!currentMedia || currentMedia.isVideo) {
      showToast('No modo Post, selecione uma foto. Para vídeo, escolha Reel ou Reel de teste.', 'warning');
      return;
    }
    const action = selectedPublishAction;
    const cropSnapshot = { ...postCropState };
    const formData = new FormData();
    formData.append('account_id', accountId);
    formData.append('action', action);
    formData.append('caption', editor.innerText.trim());
    if (action === 'schedule') {
      const date = document.getElementById('scheduledDateInput').value;
      const time = document.getElementById('scheduledTimeInput').value;
      formData.append('scheduled_at', new Date(`${date}T${time}`).toISOString());
    }
    btnSchedule.disabled = true;
    btnScheduleDropdown.disabled = true;
    postCropRatioButtons.forEach(button => { button.disabled = true; });
    try {
      if (cropSnapshot.ratio !== 'original') {
        openUploadProgress(currentMedia.file, action, 'Post');
        uploadProgressStatus.innerText = 'Preparando o recorte da imagem…';
        uploadProgressPhase.innerText = 'RECORTE';
        setUploadProgress(null);
      }
      const uploadFile = await createPostUploadFile(currentMedia.file, cropSnapshot);
      formData.append('media', uploadFile, uploadFile.name);
      const payload = await uploadFormDataWithProgress('/api/posts', formData, uploadFile, action, 'Post');
      if (activeInstagramAccount?.id === accountId) {
        scheduledPosts.unshift(normalizeBackendSchedule(payload.story));
        updateScheduleBadge();
        renderCalendar();
        renderListView();
      }
      const username = connectedAccounts.find(account => account.id === accountId)?.username || 'conta selecionada';
      const message = action === 'publish_now' ? `Post publicado em @${username}.` : `Post agendado para @${username}.`;
      completeUploadProgress(message);
      showToast(message, 'success');
      await waitForUploadCompletion();
    } catch (error) {
      showToast(error.message || 'Não foi possível conectar ao backend.', 'warning');
    } finally {
      btnSchedule.disabled = false;
      btnScheduleDropdown.disabled = false;
      postCropRatioButtons.forEach(button => { button.disabled = false; });
      closeUploadProgress();
    }
  }

  async function submitFeedReelToBackend() {
    const accountId = activeInstagramAccount?.id;
    if (!accountId) {
      showToast('Conecte uma conta do Instagram antes de publicar.', 'warning');
      return;
    }
    if (!currentMedia?.isVideo) {
      showToast('Selecione um vídeo MP4 para o Reel.', 'warning');
      return;
    }
    const action = selectedPublishAction;
    const formData = new FormData();
    formData.append('account_id', accountId);
    formData.append('action', action);
    formData.append('publication_type', 'reel');
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
      const payload = await uploadFormDataWithProgress('/api/reels', formData, currentMedia.file, action, 'Reel');
      if (activeInstagramAccount?.id === accountId) {
        scheduledPosts.unshift(normalizeBackendSchedule(payload.story));
        updateScheduleBadge();
        renderCalendar();
        renderListView();
      }
      const username = connectedAccounts.find(account => account.id === accountId)?.username || 'conta selecionada';
      const message = action === 'publish_now' ? `Reel publicado em @${username}.` : `Reel agendado para @${username}.`;
      completeUploadProgress(message);
      showToast(message, 'success');
      await waitForUploadCompletion();
    } catch (error) {
      showToast(error.message || 'Não foi possível conectar ao backend.', 'warning');
    } finally {
      btnSchedule.disabled = false;
      btnScheduleDropdown.disabled = false;
      closeUploadProgress();
    }
  }

  async function submitCarouselToBackend() {
    const accountId = activeInstagramAccount?.id;
    if (!accountId) {
      showToast('Conecte uma conta do Instagram antes de publicar.', 'warning');
      return;
    }
    if (selectedCarouselFiles.length < 2 || selectedCarouselFiles.length > 10) {
      showToast('Selecione de 2 a 10 mídias para o carrossel.', 'warning');
      return;
    }
    if (selectedCarouselFiles.some(file => !file.type.startsWith('image/') && !file.type.startsWith('video/'))) {
      showToast('O carrossel aceita apenas imagens e vídeos.', 'warning');
      return;
    }

    const action = selectedPublishAction;
    const formData = new FormData();
    formData.append('account_id', accountId);
    formData.append('action', action);
    formData.append('caption', editor.innerText.trim());
    if (action === 'schedule') {
      const date = document.getElementById('scheduledDateInput').value;
      const time = document.getElementById('scheduledTimeInput').value;
      formData.append('scheduled_at', new Date(`${date}T${time}`).toISOString());
    }
    selectedCarouselFiles.forEach(file => formData.append('media', file, file.name));

    btnSchedule.disabled = true;
    btnScheduleDropdown.disabled = true;
    try {
      const payload = await uploadFormDataWithProgress('/api/carousels', formData, selectedCarouselFiles, action, 'Carrossel');
      if (activeInstagramAccount?.id === accountId) {
        scheduledPosts.unshift(normalizeBackendSchedule(payload.story));
        updateScheduleBadge();
        renderCalendar();
        renderListView();
      }
      const username = connectedAccounts.find(account => account.id === accountId)?.username || 'conta selecionada';
      const message = action === 'publish_now' ? `Carrossel publicado em @${username}.` : `Carrossel agendado para @${username}.`;
      completeUploadProgress(message);
      showToast(message, 'success');
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
    if (currentMode === 'post') {
      await submitFeedPostToBackend();
      return;
    }
    if (currentMode === 'carousel') {
      await submitCarouselToBackend();
      return;
    }
    if (currentMode === 'reel') {
      await submitFeedReelToBackend();
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
  loadConnectedAccounts();
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

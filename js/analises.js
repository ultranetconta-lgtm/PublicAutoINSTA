/**
 * AnalisesModule - Instagram Analytics with Apple Minimalist Aesthetics
 * Metricool Planner - @alesantorooficial
 */
(function() {
  'use strict';

  const AnalisesModule = {
    currentPeriod: '30d',
    currentData: null,
    isLoading: false,
    averageVisible: true,
    initialized: false,
    chartInteraction: null,
    chartInteractionContainer: null,
    chartMouseEvent: null,
    chartMouseFrame: null,
    chartLastPointIndex: -1,
    chartTooltipHalfWidth: 85,
    loadSequence: 0,

    init() {
      if (this.initialized) {
        if (this.currentData) this.render();
        else this.loadData();
        return;
      }
      this.bindEvents();
      this.initialized = true;
      this.loadData();
    },

    bindEvents() {
      // Period Segmented Control Buttons
      const btnToday = document.getElementById('btnPeriodToday');
      const btn7d = document.getElementById('btnPeriod7d');
      const btn30d = document.getElementById('btnPeriod30d');
      const btnRefresh = document.getElementById('btnRefreshAnalises');
      const btnToggleAverage = document.getElementById('btnToggleChartAverage');

      if (btnToday) {
        btnToday.addEventListener('click', () => this.setPeriod('today'));
      }
      if (btn7d) {
        btn7d.addEventListener('click', () => this.setPeriod('7d'));
      }
      if (btn30d) {
        btn30d.addEventListener('click', () => this.setPeriod('30d'));
      }
      if (btnRefresh) {
        btnRefresh.addEventListener('click', () => {
          btnRefresh.classList.add('animate-spin');
          this.loadData(true).finally(() => {
            setTimeout(() => btnRefresh.classList.remove('animate-spin'), 600);
          });
        });
      }
      if (btnToggleAverage) {
        btnToggleAverage.addEventListener('click', () => {
          this.averageVisible = !this.averageVisible;
          if (this.currentData) this.renderChart(this.currentData.chart);
        });
      }

      // Close Reel popover on document click or when mouse leaves
      const popover = document.getElementById('appleReelPopover');
      if (popover) {
        popover.addEventListener('mouseenter', () => {
          clearTimeout(this.popoverCloseTimer);
        });
        popover.addEventListener('mouseleave', () => {
          this.popoverCloseTimer = setTimeout(() => {
            this.hideReelPopover();
          }, 180);
        });
      }

      document.addEventListener('click', (e) => {
        if (popover && popover.classList.contains('active')) {
          if (!popover.contains(e.target) && !e.target.closest('.apple-reel-item-card')) {
            this.hideReelPopover();
          }
        }
      });

      document.addEventListener('instagram-account-changed', () => {
        this.currentData = null;
        this.renderUnavailable('Consultando os Insights atuais da Meta…');
        if (document.getElementById('viewAnalises')?.classList.contains('active')) this.loadData();
      });

      // Window resize re-renders the responsive chart
      let resizeTimer = null;
      window.addEventListener('resize', () => {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => {
          if (this.currentData) {
            this.renderChart(this.currentData.chart);
          }
        }, 150);
      });
    },

    setPeriod(period) {
      if (this.currentPeriod === period && this.currentData) return;
      this.currentPeriod = period;

      // Update Segmented Control UI
      const buttons = {
        today: document.getElementById('btnPeriodToday'),
        '7d': document.getElementById('btnPeriod7d'),
        '30d': document.getElementById('btnPeriod30d')
      };

      Object.keys(buttons).forEach(key => {
        if (buttons[key]) {
          if (key === period) {
            buttons[key].classList.add('active');
          } else {
            buttons[key].classList.remove('active');
          }
        }
      });

      this.loadData();
    },

    async loadData(forceRefresh = false) {
      const accountId = window.getActiveInstagramAccountId?.() || '';
      const requestId = ++this.loadSequence;
      if (!accountId) {
        this.isLoading = false;
        this.currentData = null;
        this.renderUnavailable('Conecte uma conta do Instagram para consultar os Insights.');
        return;
      }
      this.isLoading = true;
      const viewContainer = document.getElementById('viewAnalises');
      this.currentData = null;
      this.renderUnavailable('Consultando os Insights atuais da Meta…');
      if (viewContainer) {
        viewContainer.style.opacity = '0.7';
        viewContainer.style.pointerEvents = 'none';
      }

      try {
        const params = new URLSearchParams({ account_id: accountId, period: this.currentPeriod });
        if (forceRefresh) params.set('refresh', '1');
        const response = await fetch(`/api/analytics?${params.toString()}`, { cache: 'no-store' });
        if (!response.ok) {
          throw new Error(`HTTP error! status: ${response.status}`);
        }
        const data = await response.json();
        if (requestId !== this.loadSequence || accountId !== window.getActiveInstagramAccountId?.()) return;
        if (!data || data.ok !== true) {
          throw new Error('Meta analytics unavailable');
        }
        this.currentData = data;
        this.render();
      } catch (_) {
        if (requestId !== this.loadSequence || accountId !== window.getActiveInstagramAccountId?.()) return;
        this.currentData = null;
        this.renderUnavailable('Não foi possível consultar os Insights atuais da Meta. Tente atualizar novamente.');
      } finally {
        if (requestId === this.loadSequence) this.isLoading = false;
        if (requestId === this.loadSequence && viewContainer) {
          viewContainer.style.opacity = '1';
          viewContainer.style.pointerEvents = 'auto';
        }
      }
    },

    render() {
      if (!this.currentData) return;
      this.renderKPIs(this.currentData.metrics);
      this.renderFreshness(this.currentData);
      this.renderChart(this.currentData.chart);
      this.renderReelsList(this.currentData.reels);
    },

    renderUnavailable(message) {
      const setText = (id, value) => {
        const element = document.getElementById(id);
        if (element) element.textContent = value;
      };
      setText('analyticsFreshness', message);
      setText('metricAccountViews', '—');
      setText('metricAccountReach', '—');
      setText('metricFollowersCount', '—');
      setText('metricReelsCount', '— Reels');
      setText('metricViews24h', 'Últimas 24 horas: indisponível');
      setText('metricReach24h', 'Últimas 24 horas: indisponível');
      setText('metricFollows24h', 'Últimas 24 horas: indisponível');
      setText('metricReels24h', 'Últimas 24 horas: indisponível');
      setText('appleChartRange', message);

      ['metricViewsTrend', 'metricReachTrend'].forEach(id => {
        const element = document.getElementById(id);
        if (element) element.hidden = true;
      });
      const averageToggle = document.getElementById('btnToggleChartAverage');
      if (averageToggle) averageToggle.disabled = true;
      const averageValue = document.getElementById('appleChartAverageValue');
      if (averageValue) averageValue.textContent = '—';
      ['appleChartYAxis', 'appleChartXAxis', 'appleReelPinGroup'].forEach(id => {
        const element = document.getElementById(id);
        if (element) element.replaceChildren();
      });
      const chart = document.getElementById('appleChartSvgContainer');
      if (chart) {
        chart.replaceChildren();
        chart.style.display = 'grid';
        chart.style.placeItems = 'center';
        chart.style.color = '#86868b';
        chart.style.fontSize = '13px';
        chart.textContent = message;
      }
      this.renderReelsList([], message);
    },

    renderFreshness(data) {
      const status = document.getElementById('analyticsFreshness');
      if (!status) return;
      const formatDate = value => {
        if (!value) return '—';
        const parsed = new Date(`${value}T12:00:00Z`);
        return parsed.toLocaleDateString('pt-BR', { day: '2-digit', month: 'short', timeZone: 'UTC' }).replace('.', '');
      };
      const updated = new Date(data.updated_at);
      const time = Number.isNaN(updated.getTime())
        ? 'horário indisponível'
        : updated.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: data.timezone || 'America/Sao_Paulo' });
      const range = data.range || {};
      const partial = range.today_partial ? ' · hoje parcial' : '';
      status.textContent = `Meta consultada às ${time} (Brasília) · ${formatDate(range.start)} a ${formatDate(range.end)}${partial} · ${data.freshness_notice || ''}`;

      const chartRange = document.getElementById('appleChartRange');
      if (chartRange) {
        chartRange.textContent = `Visualizações diárias da Meta · ${formatDate(range.start)} a ${formatDate(range.end)}${partial}`;
      }
    },

    renderKPIs(metrics) {
      if (!metrics) return;

      // Visualizações da Conta
      const viewsVal = document.getElementById('metricAccountViews');
      if (viewsVal) viewsVal.textContent = metrics.views_formatted || '—';
      this.renderTrend('metricViewsTrend', metrics.views_change);

      // Alcance da Conta
      const reachVal = document.getElementById('metricAccountReach');
      if (reachVal) reachVal.textContent = metrics.reach_formatted || '—';
      this.renderTrend('metricReachTrend', metrics.reach_change);

      // Seguidores
      const followersCount = document.getElementById('metricFollowersCount');
      if (followersCount) {
        const count = metrics.followers_count;
        followersCount.textContent = count !== null && count !== undefined && Number.isFinite(Number(count))
          ? Number(count).toLocaleString('pt-BR')
          : '—';
      }

      // Reels / Engajamento
      const reelsVal = document.getElementById('metricReelsCount');
      if (reelsVal) reelsVal.textContent = `${Number(metrics.reels_count || 0).toLocaleString('pt-BR')} Reels`;

      const formatLast24 = (value, label) => {
        if (value === null || value === undefined || !Number.isFinite(Number(value))) {
          return 'Últimas 24 horas: indisponível pela Meta';
        }
        return `Últimas 24 horas: ${Number(value).toLocaleString('pt-BR')} ${label}`;
      };
      const views24 = document.getElementById('metricViews24h');
      const reach24 = document.getElementById('metricReach24h');
      const follows24 = document.getElementById('metricFollows24h');
      const reels24 = document.getElementById('metricReels24h');
      if (views24) views24.textContent = formatLast24(metrics.views_24h, 'visualizações');
      if (reach24) reach24.textContent = formatLast24(metrics.reach_24h, 'contas alcançadas');
      if (follows24) {
        const gained = metrics.followers_gained_24h;
        const lost = metrics.followers_lost_24h;
        const gainedAvailable = gained !== null && gained !== undefined && Number.isFinite(Number(gained));
        const lostAvailable = lost !== null && lost !== undefined && Number.isFinite(Number(lost));
        follows24.textContent = gainedAvailable || lostAvailable
          ? `Últimas 24 horas: ${gainedAvailable ? `+${Number(gained).toLocaleString('pt-BR')} ganhos` : 'ganhos indisponíveis'} · ${lostAvailable ? `−${Number(lost).toLocaleString('pt-BR')} perdidos` : 'perdas indisponíveis'}`
          : 'Últimas 24 horas: a Meta ainda não retornou ganhos/perdas';
      }
      if (reels24) {
        const count24 = Number(metrics.reels_count_24h);
        reels24.textContent = Number.isFinite(count24)
          ? `Últimas 24 horas: ${count24.toLocaleString('pt-BR')} ${count24 === 1 ? 'Reel publicado' : 'Reels publicados'}`
          : 'Últimas 24 horas: indisponível pela Meta';
      }
    },

    renderTrend(id, value) {
      const element = document.getElementById(id);
      if (!element) return;
      if (typeof value !== 'string' || !/^[+-]\d+(?:\.\d+)?%$/.test(value)) {
        element.hidden = true;
        return;
      }
      element.hidden = false;
      const numericChange = Number(value.slice(0, -1));
      element.classList.toggle('apple-trend-positive', numericChange >= 0);
      element.classList.toggle('apple-trend-negative', numericChange < 0);
      const icon = document.createElement('i');
      icon.className = `fa-solid ${numericChange >= 0 ? 'fa-arrow-trend-up' : 'fa-arrow-trend-down'}`;
      element.replaceChildren(icon, document.createTextNode(` ${value}`));
    },

    renderChart(chartData) {
      if (!chartData || !chartData.points || chartData.points.length === 0) return;

      const container = document.getElementById('appleChartSvgContainer');
      const yAxisContainer = document.getElementById('appleChartYAxis');
      const xAxisContainer = document.getElementById('appleChartXAxis');
      const reelsPinsContainer = document.getElementById('appleReelPinGroup');

      if (!container || !yAxisContainer || !xAxisContainer || !reelsPinsContainer) return;
      container.style.display = '';
      container.style.placeItems = '';
      container.style.color = '';
      container.style.fontSize = '';

      // 1. Render Lateral Y-Axis (Barra Lateral com os Valores)
      const lateral = chartData.lateral_axis || {
        max: 50000,
        min: 0,
        labels: ['50k', '40k', '30k', '20k', '10k', '0']
      };

      yAxisContainer.innerHTML = lateral.labels
        .map(label => `<span class="apple-chart-y-tick">${label}</span>`)
        .join('');

      // Dimensions
      const width = container.clientWidth || 800;
      const height = container.clientHeight || 340;
      const paddingBottom = 28; // space for baseline
      const paddingTop = 45; // extra space for reel cards above curve
      const plotHeight = height - paddingTop - paddingBottom;
      const points = chartData.points;
      const maxVal = lateral.max || 50000;
      const averageViews = points.reduce((sum, point) => sum + Number(point.views || 0), 0) / points.length;
      const averageValue = document.getElementById('appleChartAverageValue');
      if (averageValue) averageValue.textContent = Math.round(averageViews).toLocaleString('pt-BR');
      const averageToggle = document.getElementById('btnToggleChartAverage');
      if (averageToggle) {
        averageToggle.disabled = false;
        averageToggle.setAttribute('aria-pressed', String(this.averageVisible));
        averageToggle.title = this.averageVisible ? 'Ocultar linha de média' : 'Mostrar linha de média';
        const icon = averageToggle.querySelector('i');
        if (icon) icon.className = `fa-solid ${this.averageVisible ? 'fa-eye' : 'fa-eye-slash'}`;
      }

      // 2. Coordinate Calculators
      const getX = (index) => {
        if (points.length <= 1) return width / 2;
        return (index / (points.length - 1)) * (width - 40) + 20;
      };

      const getY = (val) => {
        const ratio = Math.max(0, Math.min(1, val / maxVal));
        return height - paddingBottom - (ratio * plotHeight);
      };

      // 3. Generate Smooth Cubic Spline (Bézier curves)
      const coords = points.map((p, i) => ({
        x: getX(i),
        y: getY(p.views),
        point: p
      }));

      const buildSmoothPath = (pts) => {
        if (pts.length === 0) return '';
        if (pts.length === 1) return `M ${pts[0].x} ${pts[0].y}`;

        let path = `M ${pts[0].x} ${pts[0].y}`;
        for (let i = 0; i < pts.length - 1; i++) {
          const p0 = pts[i === 0 ? 0 : i - 1];
          const p1 = pts[i];
          const p2 = pts[i + 1];
          const p3 = pts[i + 2 < pts.length ? i + 2 : pts.length - 1];

          // Catmull-Rom to Cubic Bézier control points conversion
          const cp1x = p1.x + (p2.x - p0.x) / 6;
          const cp1y = p1.y + (p2.y - p0.y) / 6;
          const cp2x = p2.x - (p3.x - p1.x) / 6;
          const cp2y = p2.y - (p3.y - p1.y) / 6;

          path += ` C ${cp1x.toFixed(1)} ${cp1y.toFixed(1)}, ${cp2x.toFixed(1)} ${cp2y.toFixed(1)}, ${p2.x.toFixed(1)} ${p2.y.toFixed(1)}`;
        }
        return path;
      };

      const linePath = buildSmoothPath(coords);
      const baselineY = height - paddingBottom;
      const firstX = coords[0].x;
      const lastX = coords[coords.length - 1].x;
      const areaPath = `${linePath} L ${lastX} ${baselineY} L ${firstX} ${baselineY} Z`;
      const averageY = getY(averageViews);
      const averageLine = this.averageVisible
        ? `<line class="apple-chart-average-line" x1="${firstX.toFixed(1)}" y1="${averageY.toFixed(1)}" x2="${lastX.toFixed(1)}" y2="${averageY.toFixed(1)}" />`
        : '';

      // 4. Horizontal Gridlines (5 lines)
      let gridLinesSvg = '';
      for (let i = 0; i <= 5; i++) {
        const gridY = paddingTop + (plotHeight * (i / 5));
        const isBaseline = i === 5;
        gridLinesSvg += `<line x1="0" y1="${gridY.toFixed(1)}" x2="${width}" y2="${gridY.toFixed(1)}" class="${isBaseline ? 'apple-grid-baseline' : 'apple-grid-line'}" />`;
      }

      // 5. Render SVG Content
      container.innerHTML = `
        <svg class="apple-chart-svg" viewBox="0 0 ${width} ${height}">
          <defs>
            <linearGradient id="appleViewsGradient" x1="0%" y1="0%" x2="0%" y2="100%">
              <stop offset="0%" stop-color="#0071e3" stop-opacity="0.22" />
              <stop offset="60%" stop-color="#0071e3" stop-opacity="0.06" />
              <stop offset="100%" stop-color="#0071e3" stop-opacity="0.00" />
            </linearGradient>
          </defs>
          ${gridLinesSvg}
          <path class="apple-chart-area" d="${areaPath}" />
          ${averageLine}
          <path class="apple-chart-line" d="${linePath}" />
          <!-- Interactive crosshair line -->
          <line id="appleChartCrosshair" class="apple-crosshair-line" x1="0" y1="${paddingTop}" x2="0" y2="${baselineY}" />
          <!-- Data points -->
          ${coords.map((c, idx) => `
            <circle class="apple-data-point" cx="${c.x.toFixed(1)}" cy="${c.y.toFixed(1)}" data-index="${idx}" />
          `).join('')}
        </svg>
      `;

      // 6. Render Horizontal X-Axis (Datas na base)
      // Pick representative ticks to prevent crowding
      let tickIndices = [];
      if (points.length <= 7) {
        tickIndices = points.map((_, i) => i);
      } else {
        const step = Math.ceil(points.length / 6);
        for (let i = 0; i < points.length; i += step) {
          tickIndices.push(i);
        }
        if (!tickIndices.includes(points.length - 1)) {
          tickIndices.push(points.length - 1);
        }
      }

      xAxisContainer.innerHTML = tickIndices.map(idx => {
        const pt = points[idx];
        const pct = (idx / (points.length - 1)) * 100;
        return `<span class="apple-chart-x-tick" style="left: ${pct}%;">${pt.label}</span>`;
      }).join('');

      // 7. Render Compact Reel Covers on the Chart (Capas compactas no gráfico)
      reelsPinsContainer.innerHTML = '';
      coords.forEach((coord, idx) => {
        const pt = coord.point;
        if (pt.reels && pt.reels.length > 0) {
          const firstReel = pt.reels[0];
          const hasMultiple = pt.reels.length > 1;

          const marker = document.createElement('div');
          marker.className = 'apple-compact-reel-marker';
          // Position marker right above the data point
          marker.style.left = `${coord.x}px`;
          marker.style.top = `${coord.y - 10}px`;

          marker.innerHTML = `
            <div class="apple-compact-reel-card" title="${this.escapeHtml(firstReel.caption || 'Reel')}">
              <img src="${firstReel.thumbnail_url}" alt="Reel cover" onerror="this.src='assets/avatar.jpg'" loading="lazy" />
              <div class="apple-compact-reel-play">
                <i class="fa-solid fa-play"></i>
              </div>
              ${hasMultiple ? `<div class="apple-reel-multi-badge">+${pt.reels.length}</div>` : ''}
            </div>
            <div class="apple-reel-stem-line"></div>
          `;

          reelsPinsContainer.appendChild(marker);
        }
      });

      // 8. Crosshair & Tooltip Interaction on Chart SVG
      this.attachChartInteractions(container, coords);
    },

    attachChartInteractions(container, coords) {
      const tooltip = document.getElementById('appleChartTooltip');
      if (!tooltip || coords.length === 0) return;

      const rect = container.getBoundingClientRect();
      this.chartInteraction = {
        coords,
        left: rect.left,
        width: container.clientWidth || 800
      };
      this.chartLastPointIndex = -1;
      this.chartTooltipHalfWidth = 85;

      const crosshair = container.querySelector('#appleChartCrosshair');
      if (crosshair) crosshair.style.opacity = '0';
      tooltip.classList.remove('active');

      // The chart container persists between renders. Bind once and read the
      // latest coordinates from chartInteraction so period/resize renders do
      // not accumulate handlers that keep stale chart data alive.
      if (this.chartInteractionContainer === container) return;
      this.chartInteractionContainer = container;

      container.addEventListener('mousemove', (event) => {
        this.chartMouseEvent = event;
        if (this.chartMouseFrame !== null) return;

        this.chartMouseFrame = requestAnimationFrame(() => {
          this.chartMouseFrame = null;
          const interaction = this.chartInteraction;
          const pointer = this.chartMouseEvent;
          if (!interaction || !pointer || interaction.coords.length === 0) return;

          const mouseX = pointer.clientX - interaction.left;
          const points = interaction.coords;
          let low = 0;
          let high = points.length;
          while (low < high) {
            const middle = (low + high) >>> 1;
            if (points[middle].x < mouseX) low = middle + 1;
            else high = middle;
          }

          let pointIndex = Math.min(low, points.length - 1);
          if (pointIndex > 0 && Math.abs(points[pointIndex - 1].x - mouseX) <= Math.abs(points[pointIndex].x - mouseX)) {
            pointIndex -= 1;
          }

          const closest = points[pointIndex];
          const currentCrosshair = container.querySelector('#appleChartCrosshair');
          if (!currentCrosshair) return;
          currentCrosshair.setAttribute('x1', closest.x);
          currentCrosshair.setAttribute('x2', closest.x);
          currentCrosshair.style.opacity = '1';

          if (this.chartLastPointIndex !== pointIndex) {
            const viewsFmt = Number(closest.point.views).toLocaleString('pt-BR');
            const reelCount = closest.point.reels ? closest.point.reels.length : 0;
            const timezone = this.currentData?.timezone || 'America/Sao_Paulo';
            const formatTime = (value) => {
              if (!value) return null;
              const normalizedTimestamp = String(value).replace(/([+-]\d{2})(\d{2})$/, '$1:$2');
              const timestamp = new Date(normalizedTimestamp);
              return Number.isNaN(timestamp.getTime())
                ? null
                : timestamp.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: timezone });
            };
            const reelTimes = (closest.point.reels || [])
              .map(reel => ({ timestamp: new Date(String(reel.timestamp || '').replace(/([+-]\d{2})(\d{2})$/, '$1:$2')), label: formatTime(reel.timestamp) }))
              .filter(reel => reel.label && !Number.isNaN(reel.timestamp.getTime()))
              .sort((a, b) => a.timestamp - b.timestamp)
              .map(reel => reel.label);
            const updatedTime = closest.point.partial ? formatTime(this.currentData?.updated_at) : null;
            tooltip.innerHTML = `
              <div class="apple-chart-tooltip-date">${closest.point.label}</div>
              <div class="apple-chart-tooltip-views">
                <i class="fa-solid fa-eye text-xs"></i>
                <span>${viewsFmt} visualizações</span>
              </div>
              ${closest.point.partial ? '<div class="text-[11px] text-gray-500 mt-1">Valor parcial de hoje</div>' : ''}
              ${reelCount ? `<div class="text-[11px] text-purple-600 font-semibold mt-1 flex items-center gap-1"><i class="fa-solid fa-clapperboard text-[10px]"></i> ${reelCount} Reel(s) publicado(s)</div>` : ''}
              ${reelTimes.length ? `<div class="apple-chart-tooltip-time"><i class="fa-regular fa-clock" aria-hidden="true"></i><span>Reels às ${reelTimes.join(' · ')} (Brasília)</span></div>` : ''}
              ${updatedTime ? `<div class="apple-chart-tooltip-time"><i class="fa-regular fa-clock" aria-hidden="true"></i><span>Atualizado às ${updatedTime} (Brasília)</span></div>` : ''}
            `;
            tooltip.classList.add('active');
            this.chartTooltipHalfWidth = Math.max(85, tooltip.offsetWidth / 2);
            this.chartLastPointIndex = pointIndex;
          }

          // Keep geometry reads out of the high-frequency pointer path.
          let tooltipX = closest.x + 54;
          const halfTooltipWidth = this.chartTooltipHalfWidth;
          if (tooltipX - halfTooltipWidth < 10) {
            tooltipX = halfTooltipWidth + 10;
          } else if (tooltipX + halfTooltipWidth > interaction.width + 40) {
            tooltipX = interaction.width + 40 - halfTooltipWidth;
          }

          tooltip.style.transform = closest.y < 50 ? 'translate(-50%, 25%)' : 'translate(-50%, -120%)';
          tooltip.style.left = `${tooltipX}px`;
          tooltip.style.top = `${closest.y}px`;
          tooltip.classList.add('active');
        });
      });

      container.addEventListener('mouseleave', () => {
        this.chartMouseEvent = null;
        if (this.chartMouseFrame !== null) {
          cancelAnimationFrame(this.chartMouseFrame);
          this.chartMouseFrame = null;
        }
        const currentCrosshair = container.querySelector('#appleChartCrosshair');
        if (currentCrosshair) currentCrosshair.style.opacity = '0';
        tooltip.classList.remove('active');
      });
    },

    hideReelPopover() {
      const popover = document.getElementById('appleReelPopover');
      if (popover) {
        popover.classList.remove('active');
      }
    },

    showReelPopover(reel, anchorElement, pointData) {
      const popover = document.getElementById('appleReelPopover');
      if (!popover) return;

      const rect = anchorElement.getBoundingClientRect();
      const popoverWidth = 290;
      const popoverHeight = 220;

      // Position popover intelligently relative to viewport
      let left = rect.left + rect.width / 2 - popoverWidth / 2;
      let top = rect.top - popoverHeight - 12;

      // Ensure it stays within viewport
      if (left < 16) left = 16;
      if (left + popoverWidth > window.innerWidth - 16) {
        left = window.innerWidth - popoverWidth - 16;
      }
      if (top < 70) {
        // Position below anchor instead
        top = rect.bottom + 12;
      }

      popover.style.left = `${left}px`;
      popover.style.top = `${top}px`;

      const statMarkup = [
        ['views', 'Visualizações', 'fa-eye'],
        ['like_count', 'Curtidas', 'fa-heart'],
        ['comments_count', 'Comentários', 'fa-comment'],
      ].filter(([key]) => Number.isFinite(Number(reel[key])))
        .map(([key, label]) => `<div class="apple-popover-stat-item"><div class="stat-num">${Number(reel[key]).toLocaleString('pt-BR')}</div><div class="stat-lbl">${label}</div></div>`)
        .join('');
      const dateLabel = pointData ? pointData.label : 'Publicado';

      popover.innerHTML = `
        <div class="apple-popover-header">
          <span class="apple-popover-badge">
            <i class="fa-solid fa-clapperboard"></i> Detalhes do Reel
          </span>
          <button type="button" class="apple-popover-close" id="btnCloseReelPopover">
            <i class="fa-solid fa-xmark"></i>
          </button>
        </div>
        <div class="apple-popover-body">
          <div class="apple-popover-thumb">
            <img src="${reel.thumbnail_url}" alt="Thumb" onerror="this.src='assets/avatar.jpg'" />
          </div>
          <div class="apple-popover-info">
            <div class="apple-popover-caption" title="${this.escapeHtml(reel.caption || '')}">
              ${this.escapeHtml(reel.caption || 'Reel sem legenda')}
            </div>
            <div class="apple-popover-date">
              <i class="fa-regular fa-calendar-check text-[10px] mr-1"></i>${dateLabel}
            </div>
          </div>
        </div>
        <div class="apple-popover-stats">
          ${statMarkup}
        </div>
        <div class="apple-popover-action">
          <a href="${reel.permalink}" target="_blank" rel="noopener noreferrer" class="apple-popover-btn">
            <i class="fa-brands fa-instagram"></i> Ver no Instagram
          </a>
        </div>
      `;

      popover.classList.add('active');

      const btnClose = popover.querySelector('#btnCloseReelPopover');
      if (btnClose) {
        btnClose.addEventListener('click', (e) => {
          e.stopPropagation();
          this.hideReelPopover();
        });
      }
    },

    renderReelsList(reels, emptyMessage = 'Nenhum Reel publicado no período selecionado.') {
      const grid = document.getElementById('appleReelsGrid');
      const countHeader = document.getElementById('appleReelsCountBadge');
      if (!grid) return;

      if (!reels || reels.length === 0) {
        grid.innerHTML = `<div class="text-sm text-gray-500 col-span-full py-4 text-center">${this.escapeHtml(emptyMessage)}</div>`;
        if (countHeader) countHeader.innerText = emptyMessage.startsWith('Nenhum') ? '0 Reels' : 'Dados indisponíveis';
        return;
      }

      if (countHeader) countHeader.innerText = `${reels.length} Reels publicados`;

      const reelViews = reels
        .map(reel => reel.views !== undefined && reel.views !== null && reel.views !== '' ? Number(reel.views) : NaN)
        .filter(views => Number.isFinite(views) && views >= 0)
        .sort((a, b) => a - b);
      const middle = Math.floor(reelViews.length / 2);
      const medianViews = reelViews.length === 0
        ? null
        : reelViews.length % 2 === 0
          ? (reelViews[middle - 1] + reelViews[middle]) / 2
          : reelViews[middle];

      grid.innerHTML = reels.map(reel => {
        const viewCount = reel.views !== undefined && reel.views !== null && reel.views !== '' && Number.isFinite(Number(reel.views))
          ? Number(reel.views)
          : null;
        const views = viewCount !== null ? viewCount.toLocaleString('pt-BR') : null;
        const likes = reel.like_count !== undefined && reel.like_count !== null && reel.like_count !== '' && Number.isFinite(Number(reel.like_count))
          ? Number(reel.like_count).toLocaleString('pt-BR')
          : null;
        const likeCount = reel.like_count !== undefined && reel.like_count !== null && reel.like_count !== '' && Number.isFinite(Number(reel.like_count))
          ? Number(reel.like_count)
          : null;
        const comments = reel.comments_count !== undefined && reel.comments_count !== null && reel.comments_count !== '' && Number.isFinite(Number(reel.comments_count))
          ? Number(reel.comments_count).toLocaleString('pt-BR')
          : null;
        const likeRate = viewCount > 0 && likeCount !== null
          ? `${(likeCount / viewCount * 100).toLocaleString('pt-BR', { maximumFractionDigits: 1 })}% das visualizações viraram curtidas`
          : null;
        let performance = { label: 'Sem comparação', className: 'is-unavailable', title: 'Não há dados suficientes de visualizações para comparar este Reel.' };
        if (viewCount !== null && medianViews !== null && reelViews.length >= 2) {
          performance = viewCount > medianViews
            ? { label: 'Bom desempenho', className: 'is-good', title: `Acima da mediana de ${medianViews.toLocaleString('pt-BR')} visualizações neste período.` }
            : viewCount < medianViews
              ? { label: 'Abaixo da mediana', className: 'is-low', title: `Abaixo da mediana de ${medianViews.toLocaleString('pt-BR')} visualizações neste período.` }
              : { label: 'Na mediana', className: 'is-average', title: `Na mediana de ${medianViews.toLocaleString('pt-BR')} visualizações neste período.` };
        }
        let formattedDate = 'Recentemente';
        if (reel.timestamp) {
          try {
            const dt = new Date(reel.timestamp);
            formattedDate = dt.toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' });
          } catch (_) {}
        }

        return `
          <div class="apple-reel-item-card" data-reel-id="${reel.id}">
            <div class="apple-reel-item-thumb">
              <img src="${reel.thumbnail_url}" alt="Thumb" onerror="this.src='assets/avatar.jpg'" loading="lazy" />
            </div>
            <div class="apple-reel-item-info">
              <div class="apple-reel-item-caption" title="${this.escapeHtml(reel.caption || '')}">
                ${this.escapeHtml(reel.caption || 'Reel')}
              </div>
              <div class="apple-reel-item-date">${formattedDate}</div>
              <span class="apple-reel-performance ${performance.className}" title="${performance.title}">${performance.label}</span>
              <div class="apple-reel-item-metrics">
                ${views !== null ? `<span><i class="fa-solid fa-eye text-[10px] text-blue-500"></i> ${views}</span>` : ''}
                ${likes !== null ? `<span><i class="fa-solid fa-heart text-[10px] text-red-500"></i> ${likes}</span>` : ''}
                ${comments !== null ? `<span><i class="fa-regular fa-comment text-[10px]"></i> ${comments}</span>` : ''}
              </div>
              ${likeRate ? `<div class="apple-reel-like-rate">${likeRate}</div>` : ''}
            </div>
          </div>
        `;
      }).join('');

      // Add click & hover listeners to card items
      grid.querySelectorAll('.apple-reel-item-card').forEach(card => {
        card.addEventListener('mouseenter', () => {
          clearTimeout(this.popoverCloseTimer);
          const rId = card.getAttribute('data-reel-id');
          const targetReel = reels.find(r => r.id === rId);
          if (targetReel) {
            this.showReelPopover(targetReel, card, null);
          }
        });

        card.addEventListener('mouseleave', () => {
          this.popoverCloseTimer = setTimeout(() => {
            this.hideReelPopover();
          }, 180);
        });

        card.addEventListener('click', (e) => {
          e.stopPropagation();
          clearTimeout(this.popoverCloseTimer);
          const rId = card.getAttribute('data-reel-id');
          const targetReel = reels.find(r => r.id === rId);
          if (targetReel) {
            this.showReelPopover(targetReel, card, null);
          }
        });
      });
    },

    escapeHtml(str) {
      if (!str) return '';
      return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    },


  };

  // Expose to window
  window.AnalisesModule = AnalisesModule;

  // Auto-init when DOM ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => AnalisesModule.init());
  } else {
    AnalisesModule.init();
  }
})();

/**
 * Bulk Analysis Client - Frontend for bulk repository analysis
 * Handles UI for one/some/all analysis with progress tracking
 */

class BulkAnalysisClient {
  constructor(apiBaseUrl = 'http://localhost:3000') {
    this.apiBaseUrl = apiBaseUrl;
    this.currentJobId = null;
    this.statusInterval = null;
    this.selectedRepos = new Set();
    this.lastLoggedRepo = null;
  }

  /**
   * Initialize bulk analysis UI
   */
  init() {
    this.injectBulkControls();
    this.injectRepoCheckboxes();
    this.injectProgressModal();
    this.setupEventListeners();
  }

  /**
   * Inject bulk action buttons in header
   */
  injectBulkControls() {
    const header = document.querySelector('.header');
    const buttonContainer = header.querySelector('div[style*="display: flex"]');

    if (!buttonContainer) {
      return;
    }

    // Create bulk analysis buttons
    const bulkButtonsHTML = `
      <button
        id="bulkAnalyzeSelected"
        class="bulk-btn bulk-btn-primary"
        style="
          padding: 10px 20px;
          background: linear-gradient(135deg, #f778ba 0%, #ff6bcd 100%);
          color: white;
          border: none;
          border-radius: 6px;
          cursor: pointer;
          font-weight: 500;
          box-shadow: 0 2px 4px rgba(247, 120, 186, 0.2);
        "
        disabled
      >
        🔬 Analyze Selected (<span id="selectedCount">0</span>)
      </button>
      <button
        id="bulkAnalyzeUnscanned"
        class="bulk-btn bulk-btn-info"
        style="
          padding: 10px 20px;
          background: linear-gradient(135deg, #1f6feb 0%, #388bfd 100%);
          color: white;
          border: none;
          border-radius: 6px;
          cursor: pointer;
          font-weight: 500;
          box-shadow: 0 2px 4px rgba(31, 111, 235, 0.2);
        "
      >
        ⚡ Analyze Unscanned
      </button>
      <button
        id="bulkAnalyzeAll"
        class="bulk-btn bulk-btn-warning"
        style="
          padding: 10px 20px;
          background: linear-gradient(135deg, #f6821f 0%, #ff9933 100%);
          color: white;
          border: none;
          border-radius: 6px;
          cursor: pointer;
          font-weight: 500;
          box-shadow: 0 2px 4px rgba(246, 130, 31, 0.2);
        "
      >
        🔄 Re-Analyze All
      </button>
      <button
        id="queuePause"
        class="bulk-btn bulk-btn-secondary"
        style="
          padding: 10px 20px;
          background: linear-gradient(135deg, #8b949e 0%, #a0a8b0 100%);
          color: white;
          border: none;
          border-radius: 6px;
          cursor: pointer;
          font-weight: 500;
          box-shadow: 0 2px 4px rgba(139, 148, 158, 0.2);
          display: none;
        "
      >
        ⏸️ Pause Queue
      </button>
    `;

    buttonContainer.insertAdjacentHTML('beforeend', bulkButtonsHTML);
  }

  /**
   * Inject checkboxes into repo cards
   */
  injectRepoCheckboxes() {
    const style = document.createElement('style');
    style.textContent = `
      .repo-checkbox-container {
        position: absolute;
        top: 15px;
        left: 15px;
        z-index: 10;
      }

      .repo-checkbox {
        width: 20px;
        height: 20px;
        cursor: pointer;
        accent-color: #f778ba;
      }

      .repo-card {
        position: relative;
      }

      .bulk-btn:hover {
        transform: translateY(-1px);
        box-shadow: 0 4px 8px rgba(0,0,0,0.2);
      }

      .bulk-btn:disabled {
        opacity: 0.5;
        cursor: not-allowed;
        transform: none !important;
      }
    `;
    document.head.appendChild(style);
  }

  /**
   * Add checkboxes to existing repo cards
   */
  addCheckboxesToCards() {
    const repoCards = document.querySelectorAll('.repo-card');

    repoCards.forEach((card, index) => {
      // Skip if checkbox already exists
      if (card.querySelector('.repo-checkbox')) {
        return;
      }

      const checkbox = document.createElement('div');
      checkbox.className = 'repo-checkbox-container';
      checkbox.innerHTML = `
        <input
          type="checkbox"
          class="repo-checkbox"
          data-repo-index="${index}"
          onclick="event.stopPropagation()"
        />
      `;

      card.insertBefore(checkbox, card.firstChild);

      // Add checkbox event listener
      const checkboxInput = checkbox.querySelector('input');
      checkboxInput.addEventListener('change', (e) => {
        const repoIndex = parseInt(e.target.dataset.repoIndex);
        if (e.target.checked) {
          this.selectedRepos.add(repoIndex);
        } else {
          this.selectedRepos.delete(repoIndex);
        }
        this.updateSelectedCount();
      });
    });
  }

  /**
   * Inject progress banner (inline, not modal)
   */
  injectProgressModal() {
    const bannerHTML = `
      <div id="bulkProgressBanner" style="
        display: none;
        position: sticky;
        top: 0;
        z-index: 999;
        background: linear-gradient(135deg, #161b22 0%, #1f2937 100%);
        border: 2px solid #f778ba;
        border-radius: 8px;
        padding: 20px;
        margin: 20px;
        box-shadow: 0 4px 12px rgba(247, 120, 186, 0.3);
      ">
        <div id="bannerContent">
          <div style="display: flex; justify-content: space-between; align-items: start; margin-bottom: 15px;">
            <h3 style="color: #f778ba; margin: 0;">📊 Bulk Analysis in Progress</h3>
            <div style="display: flex; gap: 10px;">
              <button id="minimizeBanner" style="
                padding: 5px 15px;
                background: #30363d;
                color: white;
                border: none;
                border-radius: 4px;
                cursor: pointer;
                font-size: 12px;
              ">▲ Minimize</button>
              <button id="cancelAnalysisBanner" style="
                padding: 5px 15px;
                background: #f85149;
                color: white;
                border: none;
                border-radius: 4px;
                cursor: pointer;
                font-size: 12px;
              ">❌ Cancel</button>
            </div>
          </div>

          <div id="progressDetails" style="display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 15px; margin-bottom: 20px;">
            <div>
              <div style="color: #8b949e; font-size: 12px; margin-bottom: 5px;">Status</div>
              <div style="color: #f778ba; font-weight: 500;" id="queueStatus">Initializing...</div>
            </div>
            <div>
              <div style="color: #8b949e; font-size: 12px; margin-bottom: 5px;">Progress</div>
              <div style="color: #58a6ff; font-weight: 500;"><span id="progressText">0/0</span> (<span id="progressPercent">0%</span>)</div>
            </div>
            <div>
              <div style="color: #8b949e; font-size: 12px; margin-bottom: 5px;">Current Repository</div>
              <div style="color: #ffffff; font-weight: 500;" id="currentRepo">-</div>
            </div>
            <div>
              <div style="color: #8b949e; font-size: 12px; margin-bottom: 5px;">Estimated Time Remaining</div>
              <div style="color: #f6821f; font-weight: 500;" id="eta">Calculating...</div>
            </div>
          </div>

          <div style="
            background: #0d1117;
            border: 1px solid #30363d;
            border-radius: 6px;
            height: 24px;
            overflow: hidden;
            margin-bottom: 15px;
            position: relative;
          ">
            <div id="progressBar" style="
              height: 100%;
              background: linear-gradient(135deg, #f778ba 0%, #ff6bcd 100%);
              width: 0%;
              transition: width 0.3s ease;
            "></div>
            <div id="progressBarText" style="
              position: absolute;
              top: 50%;
              left: 50%;
              transform: translate(-50%, -50%);
              color: white;
              font-size: 12px;
              font-weight: 600;
              text-shadow: 0 0 3px rgba(0,0,0,0.8);
            ">0%</div>
          </div>

          <div id="analysisLog" style="
            background: #0d1117;
            border: 1px solid #30363d;
            border-radius: 6px;
            padding: 15px;
            max-height: 200px;
            overflow-y: auto;
            font-family: monospace;
            font-size: 12px;
          "></div>
        </div>

        <div id="bannerMinimized" style="display: none;">
          <div style="display: flex; justify-content: space-between; align-items: center;">
            <div style="display: flex; gap: 20px; align-items: center; flex: 1;">
              <span style="color: #f778ba; font-weight: 600;">📊 Analysis Running</span>
              <span style="color: #58a6ff; font-weight: 500;" id="progressTextMin">0/0</span>
              <div style="flex: 1; max-width: 300px; background: #0d1117; border: 1px solid #30363d; border-radius: 4px; height: 8px; overflow: hidden;">
                <div id="progressBarMin" style="height: 100%; background: linear-gradient(135deg, #f778ba 0%, #ff6bcd 100%); width: 0%; transition: width 0.3s ease;"></div>
              </div>
            </div>
            <div style="display: flex; gap: 10px;">
              <button id="expandBanner" style="
                padding: 5px 15px;
                background: #30363d;
                color: white;
                border: none;
                border-radius: 4px;
                cursor: pointer;
                font-size: 12px;
              ">▼ Expand</button>
              <button id="cancelAnalysisMin" style="
                padding: 5px 15px;
                background: #f85149;
                color: white;
                border: none;
                border-radius: 4px;
                cursor: pointer;
                font-size: 12px;
              ">❌ Cancel</button>
            </div>
          </div>
        </div>
      </div>
    `;

    // Insert at the beginning of main container
    const mainContainer = document.querySelector('.container') || document.body;
    mainContainer.insertAdjacentHTML('afterbegin', bannerHTML);
  }

  /**
   * Setup event listeners
   */
  setupEventListeners() {
    // Analyze Selected
    document.getElementById('bulkAnalyzeSelected')?.addEventListener('click', () => {
      this.analyzeSelected();
    });

    // Analyze Unscanned
    document.getElementById('bulkAnalyzeUnscanned')?.addEventListener('click', () => {
      this.analyzeUnscanned();
    });

    // Re-Analyze All
    document.getElementById('bulkAnalyzeAll')?.addEventListener('click', () => {
      this.reAnalyzeAll();
    });

    // Pause/Resume Queue
    document.getElementById('queuePause')?.addEventListener('click', () => {
      this.toggleQueuePause();
    });

    // Cancel Analysis (main)
    document.getElementById('cancelAnalysisBanner')?.addEventListener('click', () => {
      this.cancelAnalysis();
    });

    // Cancel Analysis (minimized)
    document.getElementById('cancelAnalysisMin')?.addEventListener('click', () => {
      this.cancelAnalysis();
    });

    // Minimize Banner
    document.getElementById('minimizeBanner')?.addEventListener('click', () => {
      this.minimizeBanner();
    });

    // Expand Banner
    document.getElementById('expandBanner')?.addEventListener('click', () => {
      this.expandBanner();
    });

    // Watch for repo card updates
    const observer = new MutationObserver(() => {
      this.addCheckboxesToCards();
    });

    observer.observe(document.getElementById('repoContainer'), {
      childList: true,
      subtree: true
    });
  }

  /**
   * Update selected count
   */
  updateSelectedCount() {
    const countEl = document.getElementById('selectedCount');
    const analyzeBtn = document.getElementById('bulkAnalyzeSelected');

    if (countEl) {
      countEl.textContent = this.selectedRepos.size;
    }

    if (analyzeBtn) {
      analyzeBtn.disabled = this.selectedRepos.size === 0;
    }
  }

  /**
   * Analyze selected repositories
   */
  async analyzeSelected() {
    if (this.selectedRepos.size === 0) {
      return;
    }

    // Get repo data from filteredRepos global - send minimal data
    const repos = Array.from(this.selectedRepos).map((index) => {
      const repo = filteredRepos[index];
      return {
        name: repo.name,
        description: repo.description,
        languages: repo.languages,
        size: repo.size,
        stargazers_count: repo.stargazers_count,
        forks_count: repo.forks_count,
        readme_content: (repo.readme_content || '').substring(0, 50000), // Limit README
        updated_at: repo.updated_at,
        pushed_at: repo.pushed_at,
        file_count: repo.file_count,
        owner: repo.owner
      };
    });

    await this.startBulkAnalysis(repos, 'high');
  }

  /**
   * Analyze unscanned repositories
   */
  async analyzeUnscanned() {
    if (!confirm('Analyze all repositories without recent analysis?')) {
      return;
    }

    // Send minimal repo data
    const minimalRepos = this.getMinimalRepoData(repos);
    await this.startBulkAnalysis(minimalRepos, 'normal', false);
  }

  /**
   * Re-analyze all repositories
   */
  async reAnalyzeAll() {
    if (
      !confirm(`Re-analyze all ${repos.length} repositories?\n\nThis will force refresh all analyses.`)
    ) {
      return;
    }

    // Send minimal repo data
    const minimalRepos = this.getMinimalRepoData(repos);
    await this.startBulkAnalysis(minimalRepos, 'normal', true);
  }

  /**
   * Extract minimal repo data for API
   */
  getMinimalRepoData(repoList) {
    return repoList.map((repo) => ({
      name: repo.name,
      description: repo.description,
      languages: repo.languages,
      size: repo.size,
      stargazers_count: repo.stargazers_count,
      forks_count: repo.forks_count,
      readme_content: (repo.readme_content || '').substring(0, 50000),
      updated_at: repo.updated_at,
      pushed_at: repo.pushed_at,
      file_count: repo.file_count,
      owner: repo.owner
    }));
  }

  /**
   * Start bulk analysis
   */
  async startBulkAnalysis(repoList, priority = 'normal', forceRefresh = false) {
    try {
      this.showProgressModal();
      this.logAnalysis('Sending analysis request...');

      const response = await fetch(`${this.apiBaseUrl}/api/analysis/bulk`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          repos: repoList,
          priority,
          forceRefresh
        })
      });

      const data = await response.json();

      if (!data.success) {
        throw new Error(data.error || 'Failed to start analysis');
      }

      if (!data.jobId) {
        this.logAnalysis(`✓ ${data.message}`);
        setTimeout(() => this.closeProgressModal(), 2000);
        return;
      }

      this.currentJobId = data.jobId;
      this.logAnalysis(
        `✓ Job created: ${data.total} to analyze, ${data.cached} cached`
      );

      // Start polling for progress
      this.startProgressPolling();
    } catch (error) {
      this.logAnalysis(`❌ Error: ${error.message}`, 'error');
      setTimeout(() => this.closeProgressModal(), 3000);
    }
  }

  /**
   * Start polling job progress
   */
  startProgressPolling() {
    if (this.statusInterval) {
      clearInterval(this.statusInterval);
    }

    this.statusInterval = setInterval(async () => {
      await this.updateProgress();
    }, 1000); // Poll every second
  }

  /**
   * Update progress from API
   */
  async updateProgress() {
    if (!this.currentJobId) {
      return;
    }

    try {
      const response = await fetch(
        `${this.apiBaseUrl}/api/analysis/status/${this.currentJobId}`
      );
      const data = await response.json();

      if (!data.success) {
        throw new Error('Failed to get status');
      }

      const status = data.status;
      const progress = status.progress || 0;
      const total = status.total || 0;
      const percentage = total > 0 ? Math.round((progress / total) * 100) : 0;
      const currentRepo = status.currentRepo || '-';

      // Update main banner UI
      const queueStatusEl = document.getElementById('queueStatus');
      const progressTextEl = document.getElementById('progressText');
      const progressPercentEl = document.getElementById('progressPercent');
      const progressBarEl = document.getElementById('progressBar');
      const progressBarTextEl = document.getElementById('progressBarText');
      const currentRepoEl = document.getElementById('currentRepo');
      const etaEl = document.getElementById('eta');

      if (queueStatusEl) queueStatusEl.textContent = this.formatStatus(status.status);
      if (progressTextEl) progressTextEl.textContent = `${progress}/${total}`;
      if (progressPercentEl) progressPercentEl.textContent = `${percentage}%`;
      if (progressBarEl) progressBarEl.style.width = `${percentage}%`;
      if (progressBarTextEl) progressBarTextEl.textContent = `${percentage}%`;
      if (currentRepoEl) currentRepoEl.textContent = currentRepo;

      // Update minimized view
      const progressTextMinEl = document.getElementById('progressTextMin');
      const progressBarMinEl = document.getElementById('progressBarMin');
      if (progressTextMinEl) progressTextMinEl.textContent = `${progress}/${total} (${percentage}%)`;
      if (progressBarMinEl) progressBarMinEl.style.width = `${percentage}%`;

      // Calculate and display ETA
      if (progress > 0 && progress < total && status.startedAt) {
        const elapsed = Date.now() - new Date(status.startedAt).getTime();
        const avgTime = elapsed / progress;
        const remaining = (total - progress) * avgTime;

        if (remaining < 60000) {
          const etaSec = Math.ceil(remaining / 1000);
          if (etaEl) etaEl.textContent = `~${etaSec} seconds`;
        } else if (remaining < 3600000) {
          const etaMin = Math.ceil(remaining / 60000);
          if (etaEl) etaEl.textContent = `~${etaMin} minute${etaMin !== 1 ? 's' : ''}`;
        } else {
          const etaHours = Math.ceil(remaining / 3600000);
          if (etaEl) etaEl.textContent = `~${etaHours} hour${etaHours !== 1 ? 's' : ''}`;
        }
      } else {
        if (etaEl) etaEl.textContent = progress === 0 ? 'Calculating...' : 'Finishing...';
      }

      // Log progress updates
      if (currentRepo && currentRepo !== '-' && currentRepo !== this.lastLoggedRepo) {
        this.logAnalysis(`🔍 Analyzing: ${currentRepo}`, 'info');
        this.lastLoggedRepo = currentRepo;
      }

      // Check if complete
      if (
        status.status === 'completed' ||
        status.status === 'failed' ||
        status.status === 'cancelled'
      ) {
        this.stopProgressPolling();

        const successCount = status.results || 0;
        const errorCount = status.errors || 0;

        if (status.status === 'completed') {
          this.logAnalysis(`✓ Analysis Complete: ${successCount} successful, ${errorCount} errors`, 'success');

          // Auto-close banner after 3 seconds if successful
          setTimeout(() => {
            this.closeProgressModal();
          }, 3000);

          // Reload repos to show new analysis
          setTimeout(() => {
            if (typeof filterAndRender === 'function') {
              filterAndRender();
            }
          }, 1000);
        } else if (status.status === 'cancelled') {
          this.logAnalysis(`⚠️ Analysis Cancelled: ${successCount} completed before cancellation`, 'warn');
        } else {
          this.logAnalysis(`❌ Analysis Failed: ${successCount} successful, ${errorCount} errors`, 'error');
        }
      }
    } catch (error) {
      this.logAnalysis(`⚠️ Status check failed: ${error.message}`, 'warn');
    }
  }

  /**
   * Format status text
   */
  formatStatus(status) {
    const statusMap = {
      'pending': '⏳ Pending',
      'running': '▶️ Running',
      'completed': '✅ Completed',
      'failed': '❌ Failed',
      'cancelled': '⚠️ Cancelled',
      'paused': '⏸️ Paused'
    };
    return statusMap[status] || status;
  }

  /**
   * Stop progress polling
   */
  stopProgressPolling() {
    if (this.statusInterval) {
      clearInterval(this.statusInterval);
      this.statusInterval = null;
    }
  }

  /**
   * Cancel current analysis
   */
  async cancelAnalysis() {
    if (!this.currentJobId) {
      return;
    }

    if (!confirm('Cancel current analysis job?')) {
      return;
    }

    try {
      const response = await fetch(
        `${this.apiBaseUrl}/api/analysis/cancel/${this.currentJobId}`,
        {
          method: 'POST'
        }
      );

      const data = await response.json();

      if (data.success) {
        this.logAnalysis('✓ Job cancelled');
        this.stopProgressPolling();
      }
    } catch (error) {
      this.logAnalysis(`❌ Cancel failed: ${error.message}`, 'error');
    }
  }

  /**
   * Toggle queue pause/resume
   */
  async toggleQueuePause() {
    // Implementation for pause/resume
  }

  /**
   * Show progress banner
   */
  showProgressModal() {
    const banner = document.getElementById('bulkProgressBanner');
    if (banner) {
      banner.style.display = 'block';
      this.expandBanner(); // Start expanded
      document.getElementById('analysisLog').innerHTML = '';

      // Reset progress display
      document.getElementById('queueStatus').textContent = 'Initializing...';
      document.getElementById('progressText').textContent = '0/0';
      document.getElementById('progressPercent').textContent = '0%';
      document.getElementById('progressBar').style.width = '0%';
      document.getElementById('progressBarText').textContent = '0%';
      document.getElementById('currentRepo').textContent = '-';
      document.getElementById('eta').textContent = 'Calculating...';
    }
  }

  /**
   * Close progress banner
   */
  closeProgressModal() {
    const banner = document.getElementById('bulkProgressBanner');
    if (banner) {
      banner.style.display = 'none';
      this.stopProgressPolling();
      this.currentJobId = null;
    }
  }

  /**
   * Minimize banner to compact view
   */
  minimizeBanner() {
    document.getElementById('bannerContent').style.display = 'none';
    document.getElementById('bannerMinimized').style.display = 'block';
    document.getElementById('bulkProgressBanner').style.padding = '10px 20px';
  }

  /**
   * Expand banner to full view
   */
  expandBanner() {
    document.getElementById('bannerContent').style.display = 'block';
    document.getElementById('bannerMinimized').style.display = 'none';
    document.getElementById('bulkProgressBanner').style.padding = '20px';
  }

  /**
   * Log analysis message
   */
  logAnalysis(message, type = 'info') {
    const logEl = document.getElementById('analysisLog');
    if (!logEl) {
      return;
    }

    const timestamp = new Date().toLocaleTimeString();
    const colors = {
      info: '#58a6ff',
      success: '#238636',
      warn: '#f6821f',
      error: '#f85149'
    };

    const color = colors[type] || colors.info;

    logEl.innerHTML += `<div style="color: ${color}; margin-bottom: 5px;">[${timestamp}] ${message}</div>`;
    logEl.scrollTop = logEl.scrollHeight;
  }
}

// Export for use in dashboard
if (typeof module !== 'undefined' && module.exports) {
  module.exports = BulkAnalysisClient;
}

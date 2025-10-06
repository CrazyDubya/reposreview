/**
 * Queue Manager - Async queue for bulk repository analysis
 * Non-blocking, sequential processing with pause/resume/cancel
 */

const EventEmitter = require('events');
const { v4: uuidv4 } = require('uuid');

class QueueManager extends EventEmitter {
  constructor(dbManager, maxConcurrency = 1) {
    super();
    this.db = dbManager;
    this.maxConcurrency = maxConcurrency;
    this.activeJobs = new Map(); // jobId -> { repos, progress, status }
    this.running = false;
    this.paused = false;
    this.currentProcessing = null;
  }

  /**
   * Create new analysis job
   */
  createJob(repos, priority = 'normal') {
    const jobId = uuidv4();

    this.db.createJob(jobId, repos);

    this.activeJobs.set(jobId, {
      jobId,
      repos,
      priority,
      progress: 0,
      status: 'pending',
      createdAt: new Date(),
      startedAt: null,
      completedAt: null,
      results: [],
      errors: []
    });

    this.emit('job:created', { jobId, total: repos.length });

    // Auto-start processing if not running
    if (!this.running) {
      this.start();
    }

    return jobId;
  }

  /**
   * Start queue processing
   */
  async start() {
    if (this.running) {
      return;
    }

    this.running = true;
    this.paused = false;
    this.emit('queue:started');

    while (this.running && !this.paused) {
      const job = this.getNextJob();

      if (!job) {
        // No more jobs, stop
        this.running = false;
        this.emit('queue:completed');
        break;
      }

      await this.processJob(job);
    }
  }

  /**
   * Pause queue processing
   */
  pause() {
    this.paused = true;
    this.emit('queue:paused');
  }

  /**
   * Resume queue processing
   */
  resume() {
    if (this.paused) {
      this.paused = false;
      this.emit('queue:resumed');
      this.start();
    }
  }

  /**
   * Stop queue processing
   */
  stop() {
    this.running = false;
    this.paused = false;
    this.emit('queue:stopped');
  }

  /**
   * Get next pending job
   */
  getNextJob() {
    // Find first pending job (FIFO with priority)
    const pending = Array.from(this.activeJobs.values())
      .filter((j) => j.status === 'pending')
      .sort((a, b) => {
        // Priority order: high > normal > low
        const priorityOrder = { high: 0, normal: 1, low: 2 };
        const priorityDiff =
          (priorityOrder[a.priority] || 1) - (priorityOrder[b.priority] || 1);

        if (priorityDiff !== 0) {
          return priorityDiff;
        }

        // Same priority: FIFO by creation time
        return a.createdAt - b.createdAt;
      });

    return pending[0] || null;
  }

  /**
   * Process a single job
   */
  async processJob(job) {
    job.status = 'running';
    job.startedAt = new Date();
    this.currentProcessing = job.jobId;

    this.db.updateJobStatus(job.jobId, 'running');
    this.emit('job:started', { jobId: job.jobId, total: job.repos.length });

    for (let i = 0; i < job.repos.length; i++) {
      if (this.paused || !this.running || job.status === 'cancelled') {
        break;
      }

      const repo = job.repos[i];

      try {
        this.emit('repo:started', {
          jobId: job.jobId,
          repoName: repo.name,
          progress: i + 1,
          total: job.repos.length
        });

        // Emit to external processor (will be handled by analysis route)
        const result = await this.processRepo(repo, job.jobId);

        job.results.push({ repo: repo.name, success: true, result });
        job.progress = i + 1;

        this.db.updateJobStatus(job.jobId, 'running', job.progress);

        this.emit('repo:completed', {
          jobId: job.jobId,
          repoName: repo.name,
          progress: job.progress,
          total: job.repos.length
        });
      } catch (error) {
        job.errors.push({ repo: repo.name, error: error.message });

        this.emit('repo:failed', {
          jobId: job.jobId,
          repoName: repo.name,
          error: error.message
        });
      }
    }

    // Job complete
    if (job.status !== 'cancelled') {
      job.status = 'completed';
      job.completedAt = new Date();
      this.db.updateJobStatus(job.jobId, 'completed', job.progress);
    }

    this.currentProcessing = null;

    this.emit('job:completed', {
      jobId: job.jobId,
      results: job.results.length,
      errors: job.errors.length
    });
  }

  /**
   * Process single repository (placeholder - actual processing in route)
   */
  async processRepo(repo, jobId) {
    // This will be called by the analysis route
    // Return a promise that resolves when repo is analyzed
    return new Promise((resolve) => {
      const handler = (data) => {
        if (data.jobId === jobId && data.repoName === repo.name) {
          this.removeListener('repo:result', handler);
          resolve(data.result);
        }
      };

      this.on('repo:result', handler);

      // Emit request to process
      this.emit('repo:process', { repo, jobId });
    });
  }

  /**
   * Report repository analysis result
   */
  reportRepoResult(jobId, repoName, result) {
    this.emit('repo:result', { jobId, repoName, result });
  }

  /**
   * Cancel job
   */
  cancelJob(jobId) {
    const job = this.activeJobs.get(jobId);

    if (!job) {
      throw new Error(`Job ${jobId} not found`);
    }

    if (job.status === 'completed') {
      throw new Error('Cannot cancel completed job');
    }

    job.status = 'cancelled';
    this.db.updateJobStatus(jobId, 'cancelled');

    this.emit('job:cancelled', { jobId });
  }

  /**
   * Get job status
   */
  getJobStatus(jobId) {
    const job = this.activeJobs.get(jobId);

    if (!job) {
      // Check database for historical job
      return this.db.getJob(jobId);
    }

    // Get current repo being processed
    let currentRepo = null;
    if (job.status === 'running' && job.progress < job.repos.length) {
      currentRepo = job.repos[job.progress]?.name || null;
    }

    return {
      jobId: job.jobId,
      status: job.status,
      progress: job.progress,
      total: job.repos.length,
      currentRepo: currentRepo,
      createdAt: job.createdAt,
      startedAt: job.startedAt,
      completedAt: job.completedAt,
      results: job.results.length,
      errors: job.errors.length
    };
  }

  /**
   * Get queue statistics
   */
  getQueueStats() {
    const jobs = Array.from(this.activeJobs.values());

    return {
      total: jobs.length,
      pending: jobs.filter((j) => j.status === 'pending').length,
      running: jobs.filter((j) => j.status === 'running').length,
      completed: jobs.filter((j) => j.status === 'completed').length,
      failed: jobs.filter((j) => j.status === 'failed').length,
      cancelled: jobs.filter((j) => j.status === 'cancelled').length,
      paused: this.paused,
      currentProcessing: this.currentProcessing
    };
  }

  /**
   * Clean up completed jobs from memory
   */
  cleanupCompletedJobs(maxAge = 3600000) {
    // 1 hour
    const now = Date.now();

    for (const [jobId, job] of this.activeJobs.entries()) {
      if (
        (job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled') &&
        job.completedAt &&
        now - job.completedAt.getTime() > maxAge
      ) {
        this.activeJobs.delete(jobId);
      }
    }
  }
}

module.exports = QueueManager;

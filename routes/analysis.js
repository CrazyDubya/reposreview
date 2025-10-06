/**
 * Analysis Routes - Bulk repository analysis with persistence
 * Handles one/some/all analysis with smart caching
 */

const express = require('express');
const router = express.Router();
const DatabaseManager = require('../utils/db_manager');
const QueueManager = require('../utils/queue_manager');
const FileHasher = require('../utils/file_hasher');

// Initialize managers
const dbManager = new DatabaseManager();
const queueManager = new QueueManager(dbManager, 1); // Sequential processing

// Ollama configuration
const OLLAMA_BASE_URL = 'http://localhost:11434';

/**
 * Analyze repository with Ollama
 */
async function analyzeRepository(repo, model) {
  const startTime = Date.now();

  try {
    // Build analysis prompt
    const prompt = `Analyze this GitHub repository in depth:

Repository: ${repo.name}
Description: ${repo.description || 'No description'}
Languages: ${Object.keys(repo.languages || {}).join(', ')}
Size: ${repo.size || 0} KB
Stars: ${repo.stargazers_count || 0}

README:
${(repo.readme_content || 'No README').substring(0, 30000)}

Provide analysis covering:
1. Architecture & Design
2. Code Quality
3. Technology Stack
4. Use Cases
5. Maintainability
6. Security Considerations
7. Deployment Readiness

Be concise and specific.`;

    // Call Ollama API
    const response = await fetch(`${OLLAMA_BASE_URL}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        prompt,
        stream: false,
        options: {
          num_predict: 4096, // Optimized for bulk
          temperature: 0.5, // Lower for consistency
          top_p: 0.8
        }
      })
    });

    if (!response.ok) {
      throw new Error(`Ollama API error: ${response.status}`);
    }

    const data = await response.json();
    const duration = Date.now() - startTime;

    // Record success in history
    dbManager.recordHistory(repo.name, model, duration, true);

    return {
      success: true,
      analysis: data.response,
      model,
      duration,
      timestamp: new Date().toISOString()
    };
  } catch (error) {
    const duration = Date.now() - startTime;
    dbManager.recordHistory(repo.name, model || 'unknown', duration, false);

    throw error;
  }
}

/**
 * Queue event handlers
 */
queueManager.on('repo:process', async ({ repo, jobId }) => {
  try {
    // Calculate hash
    const fileHash = FileHasher.calculateHash(repo);
    const stats = FileHasher.getFileStats(repo);

    // Check cache
    if (dbManager.needsAnalysis(repo.name, fileHash)) {
      // Select model
      const model = FileHasher.selectOptimalModel(repo);

      // Analyze
      const result = await analyzeRepository(repo, model);

      // Cache result
      dbManager.saveAnalysis(
        repo.name,
        fileHash,
        result.analysis,
        model,
        stats.fileCount,
        stats.totalBytes
      );

      // Report result
      queueManager.reportRepoResult(jobId, repo.name, result);
    } else {
      // Use cached analysis
      const cached = dbManager.getCachedAnalysis(repo.name);

      queueManager.reportRepoResult(jobId, repo.name, {
        success: true,
        analysis: cached.analysis_data,
        model: cached.model_used,
        cached: true,
        timestamp: cached.last_analyzed
      });
    }
  } catch (error) {
    queueManager.reportRepoResult(jobId, repo.name, {
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /api/analysis/bulk
 * Analyze selected repositories
 */
router.post('/bulk', async (req, res) => {
  try {
    const { repos, priority = 'normal', forceRefresh = false } = req.body;

    if (!repos || !Array.isArray(repos) || repos.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'repos array required'
      });
    }

    // Filter repos needing analysis (unless forcing refresh)
    let reposToAnalyze = repos;

    if (!forceRefresh) {
      reposToAnalyze = repos.filter((repo) => {
        const hash = FileHasher.calculateHash(repo);
        return dbManager.needsAnalysis(repo.name, hash);
      });
    }

    if (reposToAnalyze.length === 0) {
      return res.json({
        success: true,
        message: 'All repositories already analyzed',
        cached: repos.length,
        jobId: null
      });
    }

    // Create job
    const jobId = queueManager.createJob(reposToAnalyze, priority);

    res.json({
      success: true,
      jobId,
      total: reposToAnalyze.length,
      cached: repos.length - reposToAnalyze.length,
      message: `Analysis job created for ${reposToAnalyze.length} repositories`
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /api/analysis/all
 * Analyze all repositories (only unscanned)
 */
router.post('/all', async (req, res) => {
  try {
    const { repos, forceRefresh = false } = req.body;

    if (!repos || !Array.isArray(repos)) {
      return res.status(400).json({
        success: false,
        error: 'repos array required'
      });
    }

    // Find repos needing analysis
    const reposToAnalyze = forceRefresh
      ? repos
      : repos.filter((repo) => {
          const hash = FileHasher.calculateHash(repo);
          return dbManager.needsAnalysis(repo.name, hash);
        });

    if (reposToAnalyze.length === 0) {
      return res.json({
        success: true,
        message: 'All repositories already analyzed',
        cached: repos.length,
        jobId: null
      });
    }

    // Create low-priority job
    const jobId = queueManager.createJob(reposToAnalyze, 'normal');

    res.json({
      success: true,
      jobId,
      total: reposToAnalyze.length,
      cached: repos.length - reposToAnalyze.length,
      message: `Analysis job created for ${reposToAnalyze.length} repositories`
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/analysis/status/:jobId
 * Get job status with progress
 */
router.get('/status/:jobId', (req, res) => {
  try {
    const { jobId } = req.params;
    const status = queueManager.getJobStatus(jobId);

    if (!status) {
      return res.status(404).json({
        success: false,
        error: 'Job not found'
      });
    }

    res.json({
      success: true,
      status
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/analysis/queue
 * Get queue statistics
 */
router.get('/queue', (_req, res) => {
  try {
    const stats = queueManager.getQueueStats();

    res.json({
      success: true,
      queue: stats
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /api/analysis/pause
 * Pause queue processing
 */
router.post('/pause', (_req, res) => {
  try {
    queueManager.pause();

    res.json({
      success: true,
      message: 'Queue paused'
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /api/analysis/resume
 * Resume queue processing
 */
router.post('/resume', (_req, res) => {
  try {
    queueManager.resume();

    res.json({
      success: true,
      message: 'Queue resumed'
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /api/analysis/cancel/:jobId
 * Cancel specific job
 */
router.post('/cancel/:jobId', (req, res) => {
  try {
    const { jobId } = req.params;
    queueManager.cancelJob(jobId);

    res.json({
      success: true,
      message: `Job ${jobId} cancelled`
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/analysis/stats
 * Get analysis statistics
 */
router.get('/stats', (_req, res) => {
  try {
    const stats = dbManager.getStats();

    res.json({
      success: true,
      stats
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/analysis/cached/:repoName
 * Get cached analysis for specific repo
 */
router.get('/cached/:repoName', (req, res) => {
  try {
    const { repoName } = req.params;
    const cached = dbManager.getCachedAnalysis(repoName);

    if (!cached) {
      return res.status(404).json({
        success: false,
        error: 'No cached analysis found'
      });
    }

    res.json({
      success: true,
      analysis: {
        repoName: cached.repo_name,
        analysis: cached.analysis_data,
        model: cached.model_used,
        lastAnalyzed: cached.last_analyzed,
        fileCount: cached.file_count,
        totalBytes: cached.total_bytes
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Cleanup completed jobs every hour
setInterval(() => {
  queueManager.cleanupCompletedJobs();
}, 3600000);

// Cleanup old history every day
setInterval(() => {
  dbManager.cleanHistory(90);
}, 86400000);

module.exports = router;

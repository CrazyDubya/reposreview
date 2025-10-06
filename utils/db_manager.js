/**
 * Database Manager - SQLite persistence for repository analyses
 * Handles caching, queue state, and analysis history
 */

const Database = require('better-sqlite3');
const path = require('path');

class DatabaseManager {
  constructor(dbPath = './analysis_cache.db') {
    this.db = new Database(dbPath);
    this.initializeTables();
  }

  /**
   * Initialize database tables
   */
  initializeTables() {
    // Analyses cache table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS repo_analyses (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        repo_name TEXT UNIQUE NOT NULL,
        file_hash TEXT NOT NULL,
        last_analyzed DATETIME NOT NULL,
        analysis_data TEXT NOT NULL,
        model_used TEXT NOT NULL,
        file_count INTEGER,
        total_bytes INTEGER,
        version INTEGER DEFAULT 1
      )
    `);

    // Analysis queue table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS analysis_queue (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id TEXT UNIQUE NOT NULL,
        repos TEXT NOT NULL,
        status TEXT NOT NULL,
        progress INTEGER DEFAULT 0,
        total INTEGER NOT NULL,
        created_at DATETIME NOT NULL,
        started_at DATETIME,
        completed_at DATETIME,
        error TEXT
      )
    `);

    // Analysis history table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS analysis_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        repo_name TEXT NOT NULL,
        analyzed_at DATETIME NOT NULL,
        model TEXT NOT NULL,
        duration_ms INTEGER NOT NULL,
        success BOOLEAN NOT NULL
      )
    `);

    // Create indexes for faster lookups
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_repo_name ON repo_analyses(repo_name);
      CREATE INDEX IF NOT EXISTS idx_last_analyzed ON repo_analyses(last_analyzed);
      CREATE INDEX IF NOT EXISTS idx_job_id ON analysis_queue(job_id);
      CREATE INDEX IF NOT EXISTS idx_history_repo ON analysis_history(repo_name);
    `);
  }

  /**
   * Get cached analysis for a repository
   */
  getCachedAnalysis(repoName, maxAgeDays = 30) {
    const stmt = this.db.prepare(`
      SELECT * FROM repo_analyses
      WHERE repo_name = ?
      AND datetime(last_analyzed, '+${maxAgeDays} days') > datetime('now')
    `);
    return stmt.get(repoName);
  }

  /**
   * Save analysis result
   */
  saveAnalysis(repoName, fileHash, analysisData, modelUsed, fileCount, totalBytes) {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO repo_analyses
      (repo_name, file_hash, last_analyzed, analysis_data, model_used, file_count, total_bytes)
      VALUES (?, ?, datetime('now'), ?, ?, ?, ?)
    `);

    stmt.run(
      repoName,
      fileHash,
      typeof analysisData === 'string' ? analysisData : JSON.stringify(analysisData),
      modelUsed,
      fileCount,
      totalBytes
    );
  }

  /**
   * Check if repo needs re-analysis
   */
  needsAnalysis(repoName, currentHash, maxAgeDays = 30) {
    const cached = this.getCachedAnalysis(repoName, maxAgeDays);

    if (!cached) {
      return true; // No cache
    }

    if (cached.file_hash !== currentHash) {
      return true; // Files changed
    }

    return false; // Cache valid
  }

  /**
   * Create analysis job
   */
  createJob(jobId, repos) {
    const stmt = this.db.prepare(`
      INSERT INTO analysis_queue (job_id, repos, status, total, created_at)
      VALUES (?, ?, 'pending', ?, datetime('now'))
    `);

    stmt.run(jobId, JSON.stringify(repos), repos.length);
    return jobId;
  }

  /**
   * Update job status
   */
  updateJobStatus(jobId, status, progress = null, error = null) {
    let sql = 'UPDATE analysis_queue SET status = ?';
    const params = [status];

    if (progress !== null) {
      sql += ', progress = ?';
      params.push(progress);
    }

    if (status === 'running' && !this.getJob(jobId).started_at) {
      sql += ", started_at = datetime('now')";
    }

    if (status === 'completed' || status === 'failed' || status === 'cancelled') {
      sql += ", completed_at = datetime('now')";
    }

    if (error) {
      sql += ', error = ?';
      params.push(error);
    }

    sql += ' WHERE job_id = ?';
    params.push(jobId);

    const stmt = this.db.prepare(sql);
    stmt.run(...params);
  }

  /**
   * Get job details
   */
  getJob(jobId) {
    const stmt = this.db.prepare('SELECT * FROM analysis_queue WHERE job_id = ?');
    const job = stmt.get(jobId);

    if (job && job.repos) {
      job.repos = JSON.parse(job.repos);
    }

    return job;
  }

  /**
   * Get all active jobs
   */
  getActiveJobs() {
    const stmt = this.db.prepare(`
      SELECT * FROM analysis_queue
      WHERE status IN ('pending', 'running')
      ORDER BY created_at ASC
    `);

    return stmt.all().map((job) => {
      if (job.repos) {
        job.repos = JSON.parse(job.repos);
      }
      return job;
    });
  }

  /**
   * Record analysis in history
   */
  recordHistory(repoName, model, durationMs, success) {
    const stmt = this.db.prepare(`
      INSERT INTO analysis_history (repo_name, analyzed_at, model, duration_ms, success)
      VALUES (?, datetime('now'), ?, ?, ?)
    `);

    stmt.run(repoName, model, durationMs, success ? 1 : 0);
  }

  /**
   * Get analysis statistics
   */
  getStats() {
    const totalAnalyzed = this.db.prepare('SELECT COUNT(*) as count FROM repo_analyses').get()
      .count;

    const recentAnalyses = this.db
      .prepare(
        "SELECT COUNT(*) as count FROM repo_analyses WHERE datetime(last_analyzed, '+7 days') > datetime('now')"
      )
      .get().count;

    const avgDuration = this.db
      .prepare('SELECT AVG(duration_ms) as avg FROM analysis_history WHERE success = 1')
      .get().avg;

    const successRate = this.db
      .prepare(
        'SELECT (SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) * 100.0 / COUNT(*)) as rate FROM analysis_history'
      )
      .get().rate;

    return {
      totalAnalyzed,
      recentAnalyses,
      avgDurationMs: Math.round(avgDuration || 0),
      successRate: Math.round(successRate || 0)
    };
  }

  /**
   * Get repos needing analysis
   */
  getReposNeedingAnalysis(repoList, maxAgeDays = 30) {
    const needAnalysis = [];

    for (const repo of repoList) {
      const cached = this.getCachedAnalysis(repo.name, maxAgeDays);
      if (!cached || (repo.file_hash && cached.file_hash !== repo.file_hash)) {
        needAnalysis.push(repo);
      }
    }

    return needAnalysis;
  }

  /**
   * Clean old history entries
   */
  cleanHistory(daysToKeep = 90) {
    const stmt = this.db.prepare(`
      DELETE FROM analysis_history
      WHERE datetime(analyzed_at, '+${daysToKeep} days') < datetime('now')
    `);

    const result = stmt.run();
    return result.changes;
  }

  /**
   * Close database connection
   */
  close() {
    this.db.close();
  }
}

module.exports = DatabaseManager;

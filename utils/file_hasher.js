/**
 * File Hasher - Calculate repository fingerprints for change detection
 * Creates SHA-256 hash from repo metadata to detect file changes
 */

const crypto = require('crypto');

class FileHasher {
  /**
   * Calculate hash from repository data
   * @param {Object} repo - Repository object with metadata
   * @returns {string} - SHA-256 hash
   */
  static calculateHash(repo) {
    // Combine key fields that indicate repo content changes
    const hashInput = {
      name: repo.name || '',
      description: repo.description || '',
      updated_at: repo.updated_at || repo.pushed_at || '',
      languages: repo.languages || {},
      size: repo.size || 0,
      default_branch: repo.default_branch || 'main',
      // README content (first 1000 chars as fingerprint)
      readme_snippet: (repo.readme_content || '').substring(0, 1000),
      // File counts
      file_count: repo.file_count || 0
    };

    // Create deterministic JSON string
    const hashString = JSON.stringify(hashInput, Object.keys(hashInput).sort());

    // Calculate SHA-256
    return crypto.createHash('sha256').update(hashString).digest('hex');
  }

  /**
   * Calculate hash from minimal repo info (for quick checks)
   * @param {string} repoName - Repository name
   * @param {string} updatedAt - Last update timestamp
   * @param {number} size - Repository size
   * @returns {string} - Quick hash
   */
  static calculateQuickHash(repoName, updatedAt, size) {
    const hashInput = `${repoName}|${updatedAt}|${size}`;
    return crypto.createHash('sha256').update(hashInput).digest('hex');
  }

  /**
   * Compare two hashes
   * @param {string} hash1
   * @param {string} hash2
   * @returns {boolean} - True if hashes match
   */
  static hashesMatch(hash1, hash2) {
    return hash1 === hash2;
  }

  /**
   * Get file statistics from repo object
   * @param {Object} repo
   * @returns {Object} - { fileCount, totalBytes }
   */
  static getFileStats(repo) {
    const languages = repo.languages || {};
    const totalBytes = Object.values(languages).reduce((sum, bytes) => sum + bytes, 0);
    const fileCount = Object.keys(languages).length;

    return {
      fileCount: repo.file_count || fileCount,
      totalBytes: repo.size ? repo.size * 1024 : totalBytes // size is in KB
    };
  }

  /**
   * Determine if repo should use large context model
   * @param {Object} repo
   * @returns {boolean}
   */
  static needsLargeContext(repo) {
    const stats = this.getFileStats(repo);
    const readmeLength = (repo.readme_content || '').length;

    // Use 128K model if:
    // - Total bytes > 500KB
    // - README > 50K chars
    // - More than 100 files
    return stats.totalBytes > 500000 || readmeLength > 50000 || stats.fileCount > 100;
  }

  /**
   * Select optimal model based on repo size
   * @param {Object} repo
   * @returns {string} - Model name
   */
  static selectOptimalModel(repo) {
    const stats = this.getFileStats(repo);
    const readmeLength = (repo.readme_content || '').length;

    // Large repos: 128K context
    if (stats.totalBytes > 500000 || readmeLength > 50000 || stats.fileCount > 100) {
      return 'qwen-128k';
    }

    // Medium repos: 32K context
    if (stats.totalBytes > 100000 || readmeLength > 10000 || stats.fileCount > 50) {
      return 'llama3-32k';
    }

    // Small repos: 32K context (quality analysis)
    return 'gemma2-32k';
  }
}

module.exports = FileHasher;

#!/usr/bin/env node

/**
 * Railway Build Script (No Nixpack)
 * 
 * This script copies source files to dist/ directory.
 * For a pure Node.js project with ES modules, no transpilation is needed.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const distDir = path.join(rootDir, 'dist');
const srcDir = path.join(rootDir, 'src');

// Colors for console output
const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  blue: '\x1b[34m',
};

function log(message, color = 'reset') {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

function copyFileSync(src, dest) {
  const destDir = path.dirname(dest);
  if (!fs.existsSync(destDir)) {
    fs.mkdirSync(destDir, { recursive: true });
  }
  fs.copyFileSync(src, dest);
}

function copyDir(src, dest) {
  if (!fs.existsSync(dest)) {
    fs.mkdirSync(dest, { recursive: true });
  }

  const entries = fs.readdirSync(src, { withFileTypes: true });

  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    if (entry.isDirectory()) {
      copyDir(srcPath, destPath);
    } else {
      copyFileSync(srcPath, destPath);
    }
  }
}

function cleanDist() {
  if (fs.existsSync(distDir)) {
    log('🧹 Cleaning dist directory...', 'yellow');
    fs.rmSync(distDir, { recursive: true, force: true });
  }
}

function build() {
  log('🔨 Starting build...', 'blue');
  
  const startTime = Date.now();

  try {
    // Clean dist
    cleanDist();

    // Create dist directory
    fs.mkdirSync(distDir, { recursive: true });

    // Copy src files
    if (fs.existsSync(srcDir)) {
      log('📁 Copying source files...', 'blue');
      copyDir(srcDir, distDir);
    } else {
      throw new Error('src directory not found');
    }

    // Copy public files
    const publicDir = path.join(rootDir, 'public');
    const distPublicDir = path.join(distDir, '..', 'public');
    if (fs.existsSync(publicDir)) {
      log('📁 Copying public files...', 'blue');
      copyDir(publicDir, distPublicDir);
    }

    // Copy package.json
    log('📦 Copying package.json...', 'blue');
    copyFileSync(
      path.join(rootDir, 'package.json'),
      path.join(distDir, 'package.json')
    );

    // Copy resend-client.js
    const resendClientPath = path.join(rootDir, 'src', 'resend-client.js');
    if (fs.existsSync(resendClientPath)) {
      log('📦 Copying resend-client.js...', 'blue');
      copyFileSync(resendClientPath, path.join(distDir, 'resend-client.js'));
    }

    const duration = Date.now() - startTime;
    log(`✅ Build completed in ${duration}ms`, 'green');
    log(`📂 Output: ${distDir}`, 'green');

  } catch (error) {
    log(`❌ Build failed: ${error.message}`, 'red');
    process.exit(1);
  }
}

// Run build
build();

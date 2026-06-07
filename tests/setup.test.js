import { describe, test, expect } from '@jest/globals';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe('Project Setup Tests', () => {
  test('package.json exists and has correct structure', () => {
    const packagePath = path.join(__dirname, '..', 'package.json');
    expect(fs.existsSync(packagePath)).toBe(true);
    
    const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf-8'));
    expect(packageJson.name).toBe('agentify-by-f1');
    expect(packageJson.type).toBe('module');
    expect(packageJson.dependencies).toHaveProperty('@langchain/langgraph');
    expect(packageJson.dependencies).toHaveProperty('express');
  });

  test('required directories exist', () => {
    const requiredDirs = [
      'src/core',
      'src/workflows',
      'src/api',
      'src/services',
      'src/utils',
      'src/executors',
      'resources/contexts',
      'resources/templates',
      'resources/schemas'
    ];

    requiredDirs.forEach(dir => {
      const dirPath = path.join(__dirname, '..', dir);
      expect(fs.existsSync(dirPath)).toBe(true);
    });
  });

  test('.gitignore exists and contains necessary patterns', () => {
    const gitignorePath = path.join(__dirname, '..', '.gitignore');
    expect(fs.existsSync(gitignorePath)).toBe(true);
    
    const gitignoreContent = fs.readFileSync(gitignorePath, 'utf-8');
    expect(gitignoreContent).toContain('node_modules/');
    expect(gitignoreContent).toContain('.env');
    expect(gitignoreContent).toContain('resources/private/');
  });

  test('.env.example exists with required variables', () => {
    const envExamplePath = path.join(__dirname, '..', '.env.example');
    expect(fs.existsSync(envExamplePath)).toBe(true);
    
    const envContent = fs.readFileSync(envExamplePath, 'utf-8');
    expect(envContent).toContain('OPENAI_API_KEY');
    expect(envContent).toContain('PORT');
    expect(envContent).toContain('WEBHOOK_TIMEOUT');
  });
});
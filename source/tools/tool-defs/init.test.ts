import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { withMock } from 'antipattern';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import initTool from './init.ts';
import { Config } from '../../config.ts';
import { ToolError } from '../common.ts';

describe('init tool security tests', () => {
  let tempDir: string;
  let mockConfig: Config;
  let mockAbortSignal: AbortSignal;

  beforeEach(async () => {
    // Create temporary directory for testing
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'init-test-'));
    
    mockConfig = {
      mcpServers: {
        'test-server': {
          command: 'echo',
          args: ['test']
        }
      }
    } as Config;

    mockAbortSignal = new AbortController().signal;
  });

  afterEach(async () => {
    // Clean up temporary directory
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch (error) {
      console.warn('Failed to clean up temp dir:', error);
    }
  });

  describe('path traversal protection', () => {
    it('should reject path traversal attempts with ../../../../', async () => {
      const attack = '../../../../etc';
      
      await expect(
        initTool.run(mockAbortSignal, {
          tool: { 
            name: 'init',
            arguments: { projectPath: attack }
          }
        }, mockConfig)
      ).rejects.toThrow('Project initialization failed. Please check the project path and permissions.');
    });

    it('should reject path traversal attempts with ../../../home', async () => {
      const attack = '../../../home/user/.ssh';
      
      await expect(
        initTool.run(mockAbortSignal, {
          tool: { 
            name: 'init',
            arguments: { projectPath: attack }
          }
        }, mockConfig)
      ).rejects.toThrow('Project initialization failed. Please check the project path and permissions.');
    });

    it('should reject absolute path attempts outside current directory', async () => {
      const attack = '/etc/passwd';
      
      await expect(
        initTool.run(mockAbortSignal, {
          tool: { 
            name: 'init',
            arguments: { projectPath: attack }
          }
        }, mockConfig)
      ).rejects.toThrow('Project initialization failed. Please check the project path and permissions.');
    });

    it('should allow legitimate relative paths within current directory', async () => {
      // Create a test project structure
      const projectName = 'test-project';
      const projectPath = path.join(tempDir, projectName);
      await fs.mkdir(projectPath, { recursive: true });
      
      // Create package.json
      const packageJson = {
        name: projectName,
        description: 'Test project',
        scripts: {
          test: 'vitest',
          build: 'tsc'
        }
      };
      await fs.writeFile(
        path.join(projectPath, 'package.json'),
        JSON.stringify(packageJson, null, 2)
      );

      // Mock process.cwd() to return tempDir
      const originalCwd = process.cwd;
      process.cwd = () => tempDir;

      try {
        const result = await initTool.run(mockAbortSignal, {
          tool: { 
            name: 'init',
            arguments: { projectPath: projectName }
          }
        }, mockConfig);

        expect(result).toContain('Project initialized successfully');
        expect(result).toContain(projectName);
        
        // Verify OCTO.md was created
        const octoPath = path.join(projectPath, 'OCTO.md');
        const octoContent = await fs.readFile(octoPath, 'utf-8');
        expect(octoContent).toContain(`# ${projectName}`);
      } finally {
        process.cwd = originalCwd;
      }
    });
  });

  describe('input validation', () => {
    it('should reject paths with invalid characters', async () => {
      const invalidInputs = [
        'path; rm -rf /',
        'path && rm -rf /',
        'path | cat /etc/passwd',
        'path `cat /etc/passwd`',
        'path$(whoami)',
        'path\x00null'
      ];

      for (const invalidPath of invalidInputs) {
        await expect(
          initTool.run(mockAbortSignal, {
            tool: { 
              name: 'init',
              arguments: { projectPath: invalidPath }
            }
          }, mockConfig)
        ).rejects.toThrow('Project initialization failed. Please check the project path and permissions.');
      }
    });

    it('should reject excessively long paths', async () => {
      const longPath = 'a'.repeat(300);
      
      await expect(
        initTool.run(mockAbortSignal, {
          tool: { 
            name: 'init',
            arguments: { projectPath: longPath }
          }
        }, mockConfig)
      ).rejects.toThrow('Project initialization failed. Please check the project path and permissions.');
    });

    it('should accept valid path characters', async () => {
      // Create valid test project
      const validPath = 'valid-project_123';
      const projectPath = path.join(tempDir, validPath);
      await fs.mkdir(projectPath, { recursive: true });

      // Mock process.cwd() to return tempDir
      const originalCwd = process.cwd;
      process.cwd = () => tempDir;

      try {
        const result = await initTool.run(mockAbortSignal, {
          tool: { 
            name: 'init',
            arguments: { projectPath: validPath }
          }
        }, mockConfig);

        expect(result).toContain('Project initialized successfully');
      } finally {
        process.cwd = originalCwd;
      }
    });
  });

  describe('error information disclosure prevention', () => {
    it('should not expose sensitive file paths in error messages', async () => {
      // Mock fs operations to throw with sensitive path
      const mockFs = {
        readFile: async (path: string) => {
          throw new Error(`ENOENT: no such file or directory, open '${path}'`);
        },
        writeFile: async () => {},
        stat: async () => ({ isDirectory: () => false }),
        access: async () => { throw new Error('Access denied'); }
      };

      await withMock({ fs }, 'fs', mockFs, async () => {
        try {
          await initTool.run(mockAbortSignal, {
            tool: { 
              name: 'init',
              arguments: { projectPath: 'test-path' }
            }
          }, mockConfig);
        } catch (error) {
          expect(error).toBeInstanceOf(ToolError);
          expect(error.message).toBe('Project initialization failed. Please check the project path and permissions.');
          expect(error.message).not.toContain('/etc');
          expect(error.message).not.toContain('/home');
          expect(error.message).not.toContain('ENOENT');
        }
      });
    });
  });

  describe('directory whitelist security', () => {
    it('should only process whitelisted directory names', async () => {
      // Create temporary project with both allowed and potentially dangerous dirs
      const projectPath = path.join(tempDir, 'test-project');
      await fs.mkdir(projectPath, { recursive: true });
      
      const allowedDirs = ['src', 'source', 'lib', 'test', 'build'];
      const dangerousDirs = ['../../../etc', '$(whoami)', '`cat /etc/passwd`'];
      
      // Create allowed directories
      for (const dir of allowedDirs) {
        await fs.mkdir(path.join(projectPath, dir), { recursive: true });
      }
      
      // Mock process.cwd() to return tempDir
      const originalCwd = process.cwd;
      process.cwd = () => tempDir;

      try {
        const result = await initTool.run(mockAbortSignal, {
          tool: { 
            name: 'init',
            arguments: { projectPath: 'test-project' }
          }
        }, mockConfig);

        expect(result).toContain('Project initialized successfully');
        
        // Verify OCTO.md contains only allowed directories
        const octoPath = path.join(projectPath, 'OCTO.md');
        const octoContent = await fs.readFile(octoPath, 'utf-8');
        
        for (const dir of allowedDirs) {
          expect(octoContent).toContain(dir);
        }
        
        // Ensure no dangerous paths leaked through
        for (const dangerousDir of dangerousDirs) {
          expect(octoContent).not.toContain(dangerousDir);
        }
      } finally {
        process.cwd = originalCwd;
      }
    });
  });

  describe('race condition handling', () => {
    it('should handle concurrent file operations gracefully', async () => {
      // Create test project
      const projectPath = path.join(tempDir, 'race-test');
      await fs.mkdir(projectPath, { recursive: true });
      
      // Create package.json
      await fs.writeFile(
        path.join(projectPath, 'package.json'),
        JSON.stringify({ name: 'race-test' })
      );

      // Mock process.cwd() to return tempDir
      const originalCwd = process.cwd;
      process.cwd = () => tempDir;

      try {
        // Run multiple init operations concurrently
        const promises = Array(5).fill(0).map(() => 
          initTool.run(mockAbortSignal, {
            tool: { 
              name: 'init',
              arguments: { projectPath: 'race-test' }
            }
          }, mockConfig)
        );

        const results = await Promise.allSettled(promises);
        
        // At least one should succeed
        const successful = results.filter(r => r.status === 'fulfilled');
        expect(successful.length).toBeGreaterThan(0);
        
        // Verify OCTO.md exists and is valid
        const octoPath = path.join(projectPath, 'OCTO.md');
        const octoContent = await fs.readFile(octoPath, 'utf-8');
        expect(octoContent).toContain('# race-test');
      } finally {
        process.cwd = originalCwd;
      }
    });
  });
});

describe('init tool functional tests', () => {
  let tempDir: string;
  let mockConfig: Config;
  let mockAbortSignal: AbortSignal;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'init-func-test-'));
    mockConfig = { mcpServers: {} } as Config;
    mockAbortSignal = new AbortController().signal;
  });

  afterEach(async () => {
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch (error) {
      console.warn('Failed to clean up temp dir:', error);
    }
  });

  describe('OCTO.md generation', () => {
    it('should generate comprehensive OCTO.md for TypeScript project', async () => {
      // Create comprehensive test project
      const projectPath = path.join(tempDir, 'typescript-project');
      await fs.mkdir(projectPath, { recursive: true });
      
      // Create project structure
      const dirs = ['src', 'test', 'dist', 'lib'];
      for (const dir of dirs) {
        await fs.mkdir(path.join(projectPath, dir), { recursive: true });
      }
      
      // Create package.json with comprehensive metadata
      const packageJson = {
        name: 'typescript-project',
        description: 'A comprehensive TypeScript project for testing',
        version: '1.0.0',
        scripts: {
          build: 'tsc',
          test: 'vitest',
          dev: 'tsx src/index.ts',
          lint: 'eslint src/'
        },
        dependencies: {
          'react': '^18.0.0',
          'lodash': '^4.17.21'
        },
        devDependencies: {
          'typescript': '^5.0.0',
          'vitest': '^1.0.0',
          '@types/node': '^20.0.0'
        }
      };
      
      await fs.writeFile(
        path.join(projectPath, 'package.json'),
        JSON.stringify(packageJson, null, 2)
      );
      
      // Create tsconfig.json
      const tsconfig = {
        compilerOptions: {
          target: 'ES2022',
          module: 'ESNext',
          outDir: './dist'
        }
      };
      
      await fs.writeFile(
        path.join(projectPath, 'tsconfig.json'),
        JSON.stringify(tsconfig, null, 2)
      );

      // Mock process.cwd() to return tempDir
      const originalCwd = process.cwd;
      process.cwd = () => tempDir;

      try {
        const result = await initTool.run(mockAbortSignal, {
          tool: { 
            name: 'init',
            arguments: { projectPath: 'typescript-project' }
          }
        }, mockConfig);

        expect(result).toContain('Project initialized successfully');
        expect(result).toContain('typescript-project');
        
        // Verify OCTO.md content
        const octoPath = path.join(projectPath, 'OCTO.md');
        const octoContent = await fs.readFile(octoPath, 'utf-8');
        
        // Check header
        expect(octoContent).toContain('# typescript-project');
        expect(octoContent).toContain('A comprehensive TypeScript project for testing');
        
        // Check features
        expect(octoContent).toContain('npm scripts');
        expect(octoContent).toContain('Node.js dependencies');
        expect(octoContent).toContain('Development dependencies');
        expect(octoContent).toContain('TypeScript');
        
        // Check project structure
        expect(octoContent).toContain('## Project Structure');
        for (const dir of dirs) {
          expect(octoContent).toContain(`**${dir}**: directory`);
        }
        
        // Check scripts
        expect(octoContent).toContain('**script:build**: tsc');
        expect(octoContent).toContain('**script:test**: vitest');
        
        // Check dependencies count
        expect(octoContent).toContain('**dependencies**: 2');
        expect(octoContent).toContain('**devDependencies**: 3');
        
        // Check footer
        expect(octoContent).toContain('Generated by octofriend `/init` command');
      } finally {
        process.cwd = originalCwd;
      }
    });

    it('should handle minimal project without package.json', async () => {
      // Create minimal project with just directories
      const projectPath = path.join(tempDir, 'minimal-project');
      await fs.mkdir(projectPath, { recursive: true });
      
      const srcDir = path.join(projectPath, 'src');
      await fs.mkdir(srcDir, { recursive: true });

      // Mock process.cwd() to return tempDir
      const originalCwd = process.cwd;
      process.cwd = () => tempDir;

      try {
        const result = await initTool.run(mockAbortSignal, {
          tool: { 
            name: 'init',
            arguments: { projectPath: 'minimal-project' }
          }
        }, mockConfig);

        expect(result).toContain('Project initialized successfully');
        
        const octoPath = path.join(projectPath, 'OCTO.md');
        const octoContent = await fs.readFile(octoPath, 'utf-8');
        
        expect(octoContent).toContain('# minimal-project');
        expect(octoContent).toContain('**src**: directory');
        expect(octoContent).toContain('Generated by octofriend `/init` command');
      } finally {
        process.cwd = originalCwd;
      }
    });
  });

  describe('default path handling', () => {
    it('should use current directory when no projectPath provided', async () => {
      // Create package.json in temp directory
      await fs.writeFile(
        path.join(tempDir, 'package.json'),
        JSON.stringify({ name: 'current-dir-test' })
      );

      // Mock process.cwd() to return tempDir
      const originalCwd = process.cwd;
      process.cwd = () => tempDir;

      try {
        const result = await initTool.run(mockAbortSignal, {
          tool: { 
            name: 'init',
            arguments: {} // No projectPath provided
          }
        }, mockConfig);

        expect(result).toContain('Project initialized successfully');
        
        const octoPath = path.join(tempDir, 'OCTO.md');
        const octoContent = await fs.readFile(octoPath, 'utf-8');
        
        expect(octoContent).toContain('# current-dir-test');
      } finally {
        process.cwd = originalCwd;
      }
    });
  });
});
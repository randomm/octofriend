import { t } from "structural";
import * as fs from "fs/promises";
import * as path from "path";
import { ToolDef, ToolError } from "../common.ts";
import { Config } from "../../config.ts";
import { getMcpClient } from "./mcp.ts";

const ArgumentsSchema = t.subtype({
  projectPath: t.optional(t.str.comment("Path to the project directory (defaults to current directory)")),
});

const Schema = t.subtype({
  name: t.value("init"),
  arguments: ArgumentsSchema,
}).comment("Initialize project documentation by analyzing structure and discovering MCP tools");

function validateProjectPath(projectPath: string): void {
  // Check for dangerous characters
  const dangerousChars = /[;&|`$(){}[\]\\<>'"]/;
  if (dangerousChars.test(projectPath)) {
    throw new ToolError("Invalid path characters detected");
  }
  
  // Check length
  if (projectPath.length > 255) {
    throw new ToolError("Path too long");
  }
  
  // Check for null bytes
  if (projectPath.includes('\0')) {
    throw new ToolError("Null bytes not allowed in path");
  }
}

function validateAndResolvePath(basePath: string, ...segments: string[]): string {
  const resolved = path.resolve(basePath, ...segments);
  const baseResolved = path.resolve(basePath);
  
  if (!resolved.startsWith(baseResolved + path.sep) && resolved !== baseResolved) {
    throw new ToolError(`Path traversal detected: ${segments.join('/')}`);
  }
  return resolved;
}

async function analyzeProject(projectPath: string): Promise<{
  name: string;
  description: string;
  features: string[];
  structure: Record<string, string>;
}> {
  const safeProjectPath = validateAndResolvePath(process.cwd(), projectPath);
  const packageJsonPath = validateAndResolvePath(safeProjectPath, "package.json");
  const tsconfigPath = validateAndResolvePath(safeProjectPath, "tsconfig.json");
  
  let projectInfo = {
    name: path.basename(projectPath),
    description: "Project documentation",
    features: [] as string[],
    structure: {} as Record<string, string>,
  };

  try {
    // Analyze package.json if it exists
    const packageJson = JSON.parse(await fs.readFile(packageJsonPath, "utf-8"));
    projectInfo.name = packageJson.name || projectInfo.name;
    projectInfo.description = packageJson.description || projectInfo.description;
    
    if (packageJson.scripts) {
      projectInfo.features.push("npm scripts");
      Object.keys(packageJson.scripts).forEach(script => {
        projectInfo.structure[`script:${script}`] = packageJson.scripts[script];
      });
    }
    
    if (packageJson.dependencies) {
      projectInfo.features.push("Node.js dependencies");
      projectInfo.structure["dependencies"] = Object.keys(packageJson.dependencies).length.toString();
    }
    
    if (packageJson.devDependencies) {
      projectInfo.features.push("Development dependencies");
      projectInfo.structure["devDependencies"] = Object.keys(packageJson.devDependencies).length.toString();
    }
  } catch {
    // package.json doesn't exist or is malformed
  }

  try {
    // Check for TypeScript configuration
    await fs.access(tsconfigPath);
    projectInfo.features.push("TypeScript");
    projectInfo.structure["typescript"] = "configured";
  } catch {
    // tsconfig.json doesn't exist
  }

  // Check for common directories
  const ALLOWED_DIRS = new Set(["src", "source", "lib", "dist", "build", "test", "tests", "__tests__"]);
  const commonDirs = ["src", "source", "lib", "dist", "build", "test", "tests", "__tests__"];
  
  for (const dir of commonDirs) {
    if (!ALLOWED_DIRS.has(dir)) continue; // Additional safety check
    
    try {
      const dirPath = validateAndResolvePath(safeProjectPath, dir);
      const stat = await fs.stat(dirPath);
      if (stat.isDirectory()) {
        projectInfo.structure[dir] = "directory";
      }
    } catch (error) {
      // Log but don't expose error details - directory doesn't exist, which is normal
      // Removed console.debug to avoid cluttering production output
    }
  }

  return projectInfo;
}

async function discoverMcpTools(config: Config): Promise<Array<{
  server: string;
  command: string;
  tools: Array<{ name: string; description?: string }>;
}>> {
  const mcpInfo = [];
  
  if (config.mcpServers) {
    for (const [serverName, serverConfig] of Object.entries(config.mcpServers)) {
      try {
        const client = await getMcpClient(serverName, config);
        const tools = await client.listTools();
        mcpInfo.push({
          server: serverName,
          command: serverConfig.command,
          tools: tools.tools.map(t => ({ 
            name: t.name, 
            description: t.description 
          }))
        });
      } catch (error) {
        // Log error but continue with other servers
        mcpInfo.push({
          server: serverName,
          command: serverConfig.command,
          tools: [{ name: "error", description: `Failed to connect: ${error}` }]
        });
      }
    }
  }
  
  return mcpInfo;
}

function generateOctoMd(
  projectInfo: { name: string; description: string; features: string[]; structure: Record<string, string> },
  mcpInfo: Array<{ server: string; command: string; tools: Array<{ name: string; description?: string }> }>
): string {
  const sections = [];
  
  // Header
  sections.push(`# ${projectInfo.name}`);
  sections.push("");
  sections.push(projectInfo.description);
  sections.push("");
  
  // Project Overview
  sections.push("## Project Overview");
  sections.push("");
  if (projectInfo.features.length > 0) {
    sections.push("**Features:**");
    projectInfo.features.forEach(feature => {
      sections.push(`- ${feature}`);
    });
    sections.push("");
  }
  
  // Project Structure
  if (Object.keys(projectInfo.structure).length > 0) {
    sections.push("## Project Structure");
    sections.push("");
    Object.entries(projectInfo.structure).forEach(([key, value]) => {
      sections.push(`- **${key}**: ${value}`);
    });
    sections.push("");
  }
  
  // MCP Tools
  if (mcpInfo.length > 0) {
    sections.push("## Available MCP Tools");
    sections.push("");
    sections.push("This project is configured with the following MCP servers:");
    sections.push("");
    
    mcpInfo.forEach(server => {
      sections.push(`### ${server.server}`);
      sections.push(`**Command**: \`${server.command}\``);
      sections.push("");
      sections.push("**Available Tools:**");
      server.tools.forEach(tool => {
        if (tool.description) {
          sections.push(`- **${tool.name}**: ${tool.description}`);
        } else {
          sections.push(`- **${tool.name}**`);
        }
      });
      sections.push("");
    });
  }
  
  // Footer
  sections.push("---");
  sections.push("");
  sections.push("*Generated by octofriend `/init` command*");
  
  return sections.join("\n");
}

export default {
  Schema,
  ArgumentsSchema,
  validate: async () => null,
  async run(abortSignal, call, config, modelOverride) {
    const { projectPath = "." } = call.tool.arguments;
    
    try {
      // Validate input first
      validateProjectPath(projectPath);
      
      // Get safe project path for file operations
      const safeProjectPath = validateAndResolvePath(process.cwd(), projectPath);
      
      // Analyze the project
      const projectInfo = await analyzeProject(projectPath);
      
      // Discover MCP tools
      const mcpInfo = await discoverMcpTools(config);
      
      // Generate OCTO.md content
      const octoContent = generateOctoMd(projectInfo, mcpInfo);
      
      // Write OCTO.md file
      const octoPath = validateAndResolvePath(safeProjectPath, "OCTO.md");
      try {
        await fs.writeFile(octoPath, octoContent, "utf-8");
      } catch (writeError) {
        console.error('Failed to write OCTO.md:', writeError);
        throw new ToolError('Failed to write project documentation file. Please check permissions.');
      }
      
      return "✅ Project initialized successfully!\n\n" +
        "Generated OCTO.md with:\n" +
        "- Project: " + projectInfo.name + "\n" +
        "- Features: " + (projectInfo.features.join(", ") || "none detected") + "\n" +
        "- MCP Servers: " + mcpInfo.length + " configured\n" +
        "- File: OCTO.md\n\n" +
        "The OCTO.md file contains comprehensive project documentation including available MCP tools.";
    } catch (error) {
      console.error('Project initialization failed:', error);
      throw new ToolError('Project initialization failed. Please check the project path and permissions.');
    }
  },
} satisfies ToolDef<t.GetType<typeof Schema>>;
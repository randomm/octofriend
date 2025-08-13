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

async function analyzeProject(projectPath: string): Promise<{
  name: string;
  description: string;
  features: string[];
  structure: Record<string, string>;
}> {
  const packageJsonPath = path.join(projectPath, "package.json");
  const tsconfigPath = path.join(projectPath, "tsconfig.json");
  
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
  const commonDirs = ["src", "source", "lib", "dist", "build", "test", "tests", "__tests__"];
  for (const dir of commonDirs) {
    try {
      const dirPath = path.join(projectPath, dir);
      const stat = await fs.stat(dirPath);
      if (stat.isDirectory()) {
        projectInfo.structure[dir] = "directory";
      }
    } catch {
      // Directory doesn't exist
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
    const { projectPath = process.cwd() } = call.tool.arguments;
    
    try {
      // Analyze the project
      const projectInfo = await analyzeProject(projectPath);
      
      // Discover MCP tools
      const mcpInfo = await discoverMcpTools(config);
      
      // Generate OCTO.md content
      const octoContent = generateOctoMd(projectInfo, mcpInfo);
      
      // Write OCTO.md file
      const octoPath = path.join(projectPath, "OCTO.md");
      await fs.writeFile(octoPath, octoContent, "utf-8");
      
      return `✅ Project initialized successfully!

Generated OCTO.md with:
- Project: ${projectInfo.name}
- Features: ${projectInfo.features.join(", ") || "none detected"}
- MCP Servers: ${mcpInfo.length} configured
- File: ${octoPath}

The OCTO.md file contains comprehensive project documentation including available MCP tools.`;
    } catch (error) {
      throw new ToolError(`Failed to initialize project: ${error instanceof Error ? error.message : String(error)}`);
    }
  },
} satisfies ToolDef<t.GetType<typeof Schema>>;
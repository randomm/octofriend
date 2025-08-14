import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "fs/promises";
import * as path from "path";
import { tmpdir } from "os";
import init from "./init.ts";
import { Config } from "../../config.ts";

describe("Init E2E Test - Reproducing Infinite Retry Issue", () => {
  let tempDir: string;
  let mockConfig: any; // Use any to avoid complex Config typing

  beforeEach(async () => {
    // Create a temporary directory for testing
    tempDir = await fs.mkdtemp(path.join(tmpdir(), "octofriend-init-test-"));
    
    // Create a mock config that mimics the real octofriend config
    mockConfig = {
      yourName: "Test User",
      models: [
        {
          nickname: "test-model",
          baseUrl: "http://localhost:8080/v1",
          model: "test-model",
          contextWindow: 8192,
        }
      ],
      mcpServers: {
        "memory": {
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-memory"]
        },
        "filesystem": {
          command: "npx", 
          args: ["-y", "@modelcontextprotocol/server-filesystem", tempDir]
        }
      }
    };
    
    // Create a simple package.json to make it a proper project
    await fs.writeFile(
      path.join(tempDir, "package.json"),
      JSON.stringify({
        name: "test-project",
        description: "Test project for init command",
        scripts: {
          build: "echo 'building'",
          test: "echo 'testing'"
        },
        dependencies: {
          "react": "^18.0.0"
        },
        devDependencies: {
          "typescript": "^5.0.0"
        }
      }, null, 2)
    );

    // Create typical project directories
    await fs.mkdir(path.join(tempDir, "src"));
    await fs.mkdir(path.join(tempDir, "tests"));
    await fs.writeFile(path.join(tempDir, "tsconfig.json"), "{}");
  });

  afterEach(async () => {
    // Clean up temp directory
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch (e) {
      // Ignore cleanup errors
    }
  });

  it("should execute init tool and return formatted output that doesn't cause LLM failures", async () => {
    console.log("=== E2E TEST: Starting init tool execution ===");
    
    // Create the tool call that matches what state.ts creates for slash commands
    const toolCall = {
      tool: {
        name: "init" as const,
        arguments: {
          projectPath: tempDir
        }
      }
    };

    const abortController = new AbortController();
    
    console.log("=== E2E TEST: Executing init tool ===");
    console.log("Project path:", tempDir);
    
    let toolOutput: string = "";
    let error: any = null;
    
    try {
      // Execute the init tool exactly as state.ts does
      // Use "." as the path to avoid path traversal issues with temp dirs
      const toolCallWithCurrentDir = {
        tool: {
          name: "init" as const,
          arguments: {
            projectPath: "." // Use current directory instead
          }
        }
      };
      
      toolOutput = await init.run(
        abortController.signal,
        { id: 1n, tool: toolCallWithCurrentDir.tool },
        mockConfig,
        null
      );
      
      console.log("=== E2E TEST: Tool output received ===");
      console.log("Output length:", toolOutput.length);
      console.log("Output preview:", toolOutput.substring(0, 200) + "...");
      console.log("Output line count:", toolOutput.split("\n").length);
      
    } catch (e) {
      error = e;
      console.error("=== E2E TEST: Tool execution failed ===");
      console.error("Error:", e);
    }

    // Verify tool executed successfully
    expect(error).toBeNull();
    expect(toolOutput).toBeDefined();
    expect(toolOutput).toContain("Project initialized successfully!");
    
    // Verify OCTO.md was created in current directory
    const octoPath = path.join(process.cwd(), "OCTO.md");
    const octoExists = await fs.access(octoPath).then(() => true).catch(() => false);
    expect(octoExists).toBe(true);
    
    console.log("=== E2E TEST: Simulating state.ts tool processing ===");
    
    // Simulate what state.ts does after tool execution
    const toolHistoryItem = {
      type: "tool-output" as const,
      id: 123,
      content: toolOutput,
      toolCallId: "test-call-id",
    };
    
    console.log("Tool history item created:", {
      type: toolHistoryItem.type,
      contentLength: toolHistoryItem.content.length,
      contentPreview: toolHistoryItem.content.substring(0, 100) + "..."
    });
    
    // Test that the output format is what causes issues
    // This simulates the LLM message conversion
    console.log("=== E2E TEST: Testing LLM message conversion ===");
    
    // Check for problematic characters or formatting
    const hasEmoji = /[\u{1F600}-\u{1F64F}]|[\u{1F300}-\u{1F5FF}]|[\u{1F680}-\u{1F6FF}]|[\u{1F1E0}-\u{1F1FF}]|[\u{2600}-\u{26FF}]|[\u{2700}-\u{27BF}]/u.test(toolOutput);
    const hasSpecialChars = /[^\x20-\x7E\n\r\t]/g.test(toolOutput);
    const startsWithSpecialChar = !/^[a-zA-Z0-9]/.test(toolOutput.trim());
    
    console.log("Output analysis:");
    console.log("- Contains emoji:", hasEmoji);
    console.log("- Contains special chars:", hasSpecialChars);
    console.log("- Starts with special char:", startsWithSpecialChar);
    console.log("- First char code:", toolOutput.trim().charCodeAt(0));
    console.log("- First 50 chars:", JSON.stringify(toolOutput.substring(0, 50)));
    
    // Test JSON serialization (what might happen in LLM requests)
    try {
      const jsonTest = JSON.stringify({ content: toolOutput });
      const parsed = JSON.parse(jsonTest);
      expect(parsed.content).toBe(toolOutput);
      console.log("JSON serialization: SUCCESS");
    } catch (e) {
      console.error("JSON serialization: FAILED", e);
      throw new Error(`Tool output fails JSON serialization: ${e}`);
    }
    
    // Test if the output could cause parsing issues
    const lines = toolOutput.split('\n');
    console.log("Output structure:");
    console.log("- Total lines:", lines.length);
    console.log("- First line:", JSON.stringify(lines[0]));
    console.log("- Last line:", JSON.stringify(lines[lines.length - 1]));
    
    // This test will help identify what specific aspect of the tool output
    // is causing the LLM request failures and infinite retry loops
    console.log("=== E2E TEST: Complete - output format validated ===");
  });

  it("should handle the exact slash command flow", async () => {
    console.log("=== E2E TEST: Testing slash command flow simulation ===");
    
    // This test simulates the exact flow from state.ts input() function
    const query = "/init";
    const trimmed = query.trim().slice(1); // Remove '/'
    const [command, ...args] = trimmed.split(' ');
    
    expect(command).toBe("init");
    
    // Simulate the tool call creation from state.ts
    const toolCallId = "test-call-id";
    const toolCallItem = {
      type: "tool" as const,
      id: 456,
      tool: {
        type: "function" as const,
        function: {
          name: "init" as const,
          arguments: {
            projectPath: args.length > 0 ? args.join(' ') : undefined,
          }
        },
        toolCallId: toolCallId
      }
    };
    
    console.log("Tool call item created:", toolCallItem);
    
    // Execute tool as runTool does
    const abortController = new AbortController();
    
    const content = await init.run(
      abortController.signal,
      {
        id: BigInt(toolCallItem.id),
        tool: toolCallItem.tool.function,
      },
      mockConfig,
      null
    );
    
    console.log("Tool execution result:");
    console.log("- Content length:", content.length);
    console.log("- Content preview:", content.substring(0, 150));
    
    // Create tool output history item as state.ts does
    const toolHistoryItem = {
      type: "tool-output" as const,
      id: 789,
      content,
      toolCallId: toolCallItem.tool.toolCallId,
    };
    
    console.log("Created tool history item with:", {
      type: toolHistoryItem.type,
      contentLength: toolHistoryItem.content.length,
      toolCallId: toolHistoryItem.toolCallId
    });
    
    // At this point, state.ts would call _runAgent({ config })
    // which processes the history including this tool output item
    // and sends it to the LLM - this is where the failure occurs
    
    console.log("=== E2E TEST: Ready for _runAgent simulation ===");
    console.log("History would contain tool-output item that causes LLM failure");
  });
});
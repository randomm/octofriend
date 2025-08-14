import { describe, it, expect } from "vitest";
import { toLlmIR } from "../../ir/llm-ir.ts";
import { HistoryItem, sequenceId } from "../../history.ts";

describe("Init Command Message Flow", () => {
  it("should create proper LLM message flow for slash commands", () => {
    console.log("=== MESSAGE FLOW TEST ===");
    
    // Simulate the history that gets created by the slash command fix
    const toolCallId = "test-call-id";
    
    const history: HistoryItem[] = [
      {
        type: "user",
        id: sequenceId(),
        content: "/init",
      },
      {
        type: "assistant", 
        id: sequenceId(),
        content: "I'll initialize the project documentation for you.",
        tokenUsage: 0,
      },
      {
        type: "tool",
        id: sequenceId(),
        tool: {
          type: "function",
          function: {
            name: "init",
            arguments: {
              projectPath: undefined,
            }
          },
          toolCallId: toolCallId
        }
      },
      {
        type: "tool-output",
        id: sequenceId(),
        content: "Project initialized successfully!\n\nGenerated OCTO.md with:\n- Project: octofriend\n- Features: npm scripts, Node.js dependencies, Development dependencies, TypeScript\n- MCP Servers: 2 configured\n- File: OCTO.md\n\nThe OCTO.md file contains comprehensive project documentation including available MCP tools.",
        toolCallId: toolCallId,
      }
    ];
    
    console.log("Input history items:");
    history.forEach((item, i) => {
      console.log(`  ${i}: ${item.type}`);
    });
    
    // Convert to LLM IR
    const llmIR = toLlmIR(history);
    
    console.log("LLM IR items:");
    llmIR.forEach((item, i) => {
      console.log(`  ${i}: ${item.role}${item.role === 'assistant' && (item as any).toolCall ? ' (with tool call)' : ''}`);
    });
    
    // Verify the expected structure
    expect(llmIR).toHaveLength(3);
    
    // Should be: user, assistant with tool call, tool-output
    expect(llmIR[0].role).toBe("user");
    expect((llmIR[0] as any).content).toBe("/init");
    
    expect(llmIR[1].role).toBe("assistant");
    expect((llmIR[1] as any).content).toBe("I'll initialize the project documentation for you.");
    expect((llmIR[1] as any).toolCall).toBeDefined();
    expect((llmIR[1] as any).toolCall.function.name).toBe("init");
    expect((llmIR[1] as any).toolCall.toolCallId).toBe(toolCallId);
    
    expect(llmIR[2].role).toBe("tool-output");
    expect((llmIR[2] as any).content).toContain("Project initialized successfully!");
    expect((llmIR[2] as any).toolCall.toolCallId).toBe(toolCallId);
    
    console.log("✅ Message flow is correct!");
    
    // Now verify that this would convert to proper LLM messages
    // (We can't easily test llmFromIr without more setup, but the structure is correct)
    
    console.log("Expected LLM API call structure:");
    console.log("1. User message: '/init'");
    console.log("2. Assistant message with tool_calls: [{name: 'init', id: '" + toolCallId + "'}]");
    console.log("3. Tool message: {role: 'tool', tool_call_id: '" + toolCallId + "', content: '...'}");
    
    console.log("=== MESSAGE FLOW TEST COMPLETE ===");
  });
});
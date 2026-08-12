/**
 * render-tool.ts — the LLM-callable producer entry point (specs/06 D2).
 *
 * `createRenderTool(registry)` builds the `webui_render` ToolDefinition. Its
 * execute() is a thin adapter over RenderService.render(): it maps the tool
 * params to a RenderInput and returns the view URL as the tool result text
 * ({ content:[{type:"text",text:url}], details:{viewId,url} }). This is the
 * only producer path reachable from a skill (skills have no host handle).
 */
import { Type } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { RenderMode, RenderService } from "./render-service.js";

export const RenderParameters = Type.Object({
  content: Type.String({ description: "Markdown or HTML to render in the browser." }),
  mode: Type.Optional(
    Type.Union([Type.Literal("md"), Type.Literal("html")], {
      description: "Render mode. Default 'md'.",
    })
  ),
  view: Type.Optional(Type.String({ description: "Named view id. Default 'main'." })),
  title: Type.Optional(Type.String({ description: "Optional view title shown in the shell." })),
});

export function createRenderTool(
  registry: RenderService
): ToolDefinition<typeof RenderParameters, { viewId: string; url: string }> {
  return {
    name: "webui_render",
    label: "Render",
    description:
      "Render markdown or HTML into a browser view served by the webui extension. " +
      "Markdown is formatted (headings, lists, tables, code blocks); HTML is shown in a sandboxed iframe. " +
      "Returns the browser URL of the view. Open the URL in a browser to see the latest content, which updates live.",
    promptSnippet:
      "Use to render rich content (markdown or HTML) to the webui browser surface; returns the browser URL.",
    parameters: RenderParameters,
    async execute(_callId, params, _signal, _onUpdate, _ctx) {
      const result = registry.render({
        content: params.content,
        ...(params.mode !== undefined ? { mode: params.mode as RenderMode } : {}),
        ...(params.view !== undefined ? { view: params.view } : {}),
        ...(params.title !== undefined ? { title: params.title } : {}),
      });
      return {
        content: [{ type: "text", text: result.url }],
        details: { viewId: result.viewId, url: result.url },
      };
    },
  };
}

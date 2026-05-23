import { z } from 'zod/v4'
import { buildTool, getGlobalAppEventBridge, type ToolDef } from '../../Tool.js'
import type { MossAppEvent, MossAppEventResult, ToolUseContext } from '../../Tool.js'
import { jsonStringify } from '../../utils/slowOperations.js'

const MOSS_TOOL_NAME = 'moss'

const imageAspectRatioSchema = z.enum([
  '1:1',
  '16:9',
  '4:3',
  '3:2',
  '2:3',
  '3:4',
  '9:16',
  '21:9',
])

const subjectReferenceSchema = z.strictObject({
  type: z.literal('character'),
  image_file: z.string().url(),
})

const mossActionSchema = z.strictObject({
  action: z.enum(['app_build', 'app_preview', 'app_publish', 'app_launch', 'app_update', 'app_extract_to_workspace', 'app_get_versions', 'image_generate']),
  name: z.string().optional().describe('App slug/name. Required for app_build, app_publish, app_launch, app_update, app_extract_to_workspace, and app_get_versions.'),
  title: z.string().optional(),
  description: z.string().optional(),
  icon: z.string().optional(),
  width: z.number().optional(),
  height: z.number().optional(),
  resizable: z.boolean().optional(),
  html: z.string().optional().describe('Full HTML content of the app. Required for app_build, optional for app_update.'),
  prd: z.string().optional(),
  versionId: z.string().optional(),
  filePath: z.string().optional().describe('Path to a built app HTML file. Required for app_preview and app_publish, optional for app_update.'),
  version: z.string().optional(),
  reason: z.string().optional(),
  prompt: z.string().optional().describe('Prompt for image generation. Required for image_generate.'),
  aspect_ratio: imageAspectRatioSchema.optional().describe('Aspect ratio for generated images. Optional for image_generate; defaults in the main process if omitted.'),
  subject_reference: z.array(subjectReferenceSchema).optional().describe('Reference images for image generation. Optional for image_generate.'),
  out_path: z.string().optional().describe('Relative output path inside the current session workspace for generated image output. Required for image_generate.'),
})

type MossActionInput = z.infer<typeof mossActionSchema>

const mossOutputSchema = z.object({
  ok: z.boolean(),
  app: z.unknown().optional(),
  apps: z.array(z.unknown()).optional(),
  versions: z.array(z.unknown()).optional(),
  fileKind: z.literal('image').optional(),
  filePath: z.string().optional(),
  filePaths: z.array(z.string()).optional(),
  previewUrl: z.string().optional(),
  previewMarkdown: z.string().optional(),
  mediaType: z.string().optional(),
  metadataPath: z.string().optional(),
  htmlPath: z.string().optional(),
  error: z.string().optional(),
})

type MossOutput = z.infer<typeof mossOutputSchema>

export const MossTool = buildTool({
  name: MOSS_TOOL_NAME,
  searchHint: 'Moss desktop app management (save, launch, update, versions)',
  maxResultSizeChars: 100_000,
  async description() {
    return `Moss tool for managing desktop apps. Supports:
- app_build: Build app metadata and HTML into a merged file in workspace. Requires both name and html.
- app_preview: Preview an HTML file
- app_publish: Publish a built app file to the app store with version. Requires name, filePath, and description.
- app_launch: Open an installed app
- app_update: Update an existing app from filePath or metadata/html fields.
- app_extract_to_workspace: Extract an installed app into the current session workspace as app-meta.json plus index.html.
- app_get_versions: Get version history of an app
- image_generate: Generate one or more images via the main-process image handler and write them into the current session workspace`
  },
  async prompt() {
    return `Use moss tool to manage desktop apps.

Parameter requirements:
- app_build requires \`name\` and \`html\`
- app_preview requires \`filePath\`
- app_publish requires \`name\`, \`filePath\`, and \`description\`
- app_launch requires \`name\`
- app_update requires \`name\` and accepts optional \`filePath\`, \`html\`, metadata fields, and \`reason\`
- app_extract_to_workspace requires \`name\`
- app_get_versions requires \`name\`
- image_generate requires \`prompt\` and \`out_path\`; \`out_path\` must be a relative path inside the current session workspace, for example \`images/hero.png\`; optionally accepts \`aspect_ratio\` and \`subject_reference\`
- image_generate returns image-specific fields including \`fileKind: "image"\`, \`previewUrl\`, and \`previewMarkdown\`
- After image_generate succeeds, if you reference the generated image in markdown, prefer \`previewMarkdown\` or use \`moss-image:///absolute/path/to/file.png\` directly`
  },
  get inputSchema() {
    return mossActionSchema
  },
  get outputSchema() {
    return mossOutputSchema
  },
  userFacingName() {
    return 'Moss'
  },
  isConcurrencySafe() {
    return false
  },
  isReadOnly(input: MossActionInput) {
    return input.action === 'app_launch' || input.action === 'app_get_versions' || input.action === 'app_preview'
  },
  async call(input: MossActionInput, context: ToolUseContext): Promise<{ data: MossOutput }> {
    const emitAppEvent = context.emitAppEvent ?? getGlobalAppEventBridge()

    // Check if emitAppEvent is available
    if (!emitAppEvent) {
      const querySource = context.options.querySource ?? 'unknown'
      const agentId = context.agentId ?? 'main'
      return {
        data: {
          ok: false,
          error: `MossTool is not available in this context. Missing emitAppEvent bridge. querySource=${querySource} agentId=${agentId}`,
        },
      }
    }

    // Build the event based on action
    let event: MossAppEvent

    switch (input.action) {
      case 'app_build':
        if (!input.name) {
          return { data: { ok: false, error: 'name is required for app_build' } }
        }
        if (!input.html) {
          return { data: { ok: false, error: 'html is required for app_build. Pass the full HTML document string in the html field.' } }
        }
        event = {
          type: 'app_build',
          input: {
            name: input.name,
            title: input.title,
            description: input.description,
            icon: input.icon,
            width: input.width,
            height: input.height,
            resizable: input.resizable,
            html: input.html,
            prd: input.prd,
          },
        }
        break

      case 'app_preview':
        if (!input.filePath) {
          return { data: { ok: false, error: 'filePath is required for app_preview' } }
        }
        event = {
          type: 'app_preview',
          input: { filePath: input.filePath },
        }
        break

      case 'app_publish':
        if (!input.name) {
          return { data: { ok: false, error: 'name is required for app_publish. Pass the target app slug/name in the name field.' } }
        }
        if (!input.filePath) {
          return { data: { ok: false, error: 'filePath is required for app_publish' } }
        }
        if (!input.description) {
          return { data: { ok: false, error: 'description is required for app_publish. Pass the published app description in the description field.' } }
        }
        event = {
          type: 'app_publish',
          input: {
            name: input.name,
            filePath: input.filePath,
            description: input.description,
            version: input.version,
            reason: input.reason,
          },
        }
        break

      case 'app_launch':
        if (!input.name) {
          return { data: { ok: false, error: 'name is required for app_launch' } }
        }
        event = {
          type: 'app_launch',
          input: { name: input.name },
        }
        break

      case 'app_update':
        if (!input.name) {
          return { data: { ok: false, error: 'name is required for app_update' } }
        }
        event = {
          type: 'app_update',
          input: {
            name: input.name,
            title: input.title,
            description: input.description,
            icon: input.icon,
            width: input.width,
            height: input.height,
            resizable: input.resizable,
            filePath: input.filePath,
            html: input.html,
            prd: input.prd,
            reason: input.reason,
          },
        }
        break

      case 'app_extract_to_workspace':
        if (!input.name) {
          return { data: { ok: false, error: 'name is required for app_extract_to_workspace' } }
        }
        event = {
          type: 'app_extract_to_workspace',
          input: {
            name: input.name,
            versionId: input.versionId,
          },
        }
        break

      case 'app_get_versions':
        if (!input.name) {
          return { data: { ok: false, error: 'name is required for app_get_versions' } }
        }
        event = {
          type: 'app_get_versions',
          input: { name: input.name },
        }
        break

      case 'image_generate':
        if (!input.prompt) {
          return { data: { ok: false, error: 'prompt is required for image_generate' } }
        }
        if (!input.out_path) {
          return { data: { ok: false, error: 'out_path is required for image_generate' } }
        }
        event = {
          type: 'image_generate',
          input: {
            prompt: input.prompt,
            aspect_ratio: input.aspect_ratio,
            subject_reference: input.subject_reference,
            out_path: input.out_path,
          },
        }
        break

      default:
        return { data: { ok: false, error: `Unknown action: ${input.action}` } }
    }

    // Emit event and wait for result (blocking)
    const result: MossAppEventResult = await emitAppEvent(event)

    if (result.ok) {
      return {
        data: {
          ok: true,
          app: result.app,
          apps: result.apps,
          versions: result.versions,
          filePath: result.filePath,
          filePaths: result.filePaths,
          metadataPath: result.metadataPath,
          htmlPath: result.htmlPath,
        },
      }
    } else {
      return {
        data: {
          ok: false,
          error: result.error,
        },
      }
    }
  },
  mapToolResultToToolResultBlockParam(content: MossOutput, toolUseID: string) {
    return {
      tool_use_id: toolUseID,
      type: 'tool_result' as const,
      content: jsonStringify(content),
    }
  },
} satisfies ToolDef<typeof mossActionSchema, MossOutput>)

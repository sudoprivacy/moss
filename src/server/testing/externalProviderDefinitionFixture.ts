import type { CreateExternalTask } from '../../../contracts/external-provider/v1/contract.js'
import { TASK_API, type SubmitTask } from '../../../contracts/task/v1alpha1/contract.js'

/** Synthetic Chatflow matching the supported Dify export shape; contains no provider secrets. */
export function queryOnlyDefinition() {
  return {
    kind: 'app', version: '0.6.0', app: { name: 'Synthetic query-only fixture', mode: 'advanced-chat' },
    workflow: {
      features: { file_upload: { enabled: false, image: { enabled: false } }, retriever_resource: { enabled: false } },
      environment_variables: [], conversation_variables: [],
      graph: {
        nodes: [
          { id: 'start', type: 'custom', data: { type: 'start', variables: [] } },
          { id: 'llm', type: 'custom', data: { type: 'llm', model: { provider: 'synthetic/model', name: 'synthetic', mode: 'chat', completion_params: { temperature: 0.7 } }, prompt_template: [{ role: 'system', text: 'Answer the synthetic query.' }], context: { enabled: false, variable_selector: [] }, vision: { enabled: false } } },
          { id: 'answer', type: 'custom', data: { type: 'answer', answer: '{{#llm.text#}}', variables: [] } },
        ],
        edges: [{ source: 'start', target: 'llm' }, { source: 'llm', target: 'answer' }],
      },
    },
  }
}

/** Only test fixtures may assert that their predefined inputs are synthetic. */
export function syntheticTaskSubmission(request: CreateExternalTask): SubmitTask {
  return { api_version: TASK_API, kind: 'SubmitTask', agent: { catalog_id: request.agent_id },
    ...(request.session_id ? { session_id: request.session_id } : {}), request_source: 'api',
    input: { instruction: request.query, resource_refs: [] }, workspace_refs: [], requested_mode: 'auto',
    data_classification: 'synthetic', required_capabilities: [], constraints: { idempotency_key: request.idempotency_key } }
}

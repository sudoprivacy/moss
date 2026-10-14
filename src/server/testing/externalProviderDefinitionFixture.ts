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
